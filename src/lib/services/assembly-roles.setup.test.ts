import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Lean Core L1.2h, DB-gated: ensureAssemblyRoles publishes a NEW assembly template version carrying the
 * reviewed roles, and never edits the published one (invariant 9). Violation cases first. Each case gets its own
 * throwaway org, so counts are exact.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L1.2h ensureAssemblyRoles (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { ensureAssemblyRoles } = await import("./assembly-roles.setup");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const MAPPING = [
    { seq: 1, role: "FIT_UP", jointRef: "LS-1", pressurePart: true },
    { seq: 2, role: "WELD", jointRef: "LS-1", pressurePart: true },
    { seq: 3, role: null, jointRef: null, pressurePart: false },
  ];
  const opts = (apply: boolean, over: Partial<Parameters<typeof ensureAssemblyRoles>[2]> = {}) => ({
    apply,
    mapping: MAPPING,
    mappingStatus: "REVIEWED_PROVISIONAL",
    audit: true,
    auditSource: "test",
    ...over,
  });

  /** A throwaway org whose family template has one PUBLISHED role-less version of three steps. */
  async function world(stepOver: Array<Record<string, unknown>> = [{}, {}, {}], status: "PUBLISHED" | "DRAFT" = "PUBLISHED") {
    const o = await makeWorkOrg(owner, "RL");
    const template = await owner.assemblyTemplate.findFirstOrThrow({ where: { tenantId: o.tenantId, equipmentTypeId: null } });
    const dept = await owner.department.findFirstOrThrow({ where: { tenantId: o.tenantId } });
    const v = await owner.assemblyTemplateVersion.create({ data: { templateId: template.id, version: 500, status, publishedAt: new Date() } });
    for (const [i, over] of stepOver.entries()) {
      await owner.assemblyTemplateStep.create({
        data: { versionId: v.id, seq: i + 1, groupCode: "E", groupName: "g", srNo: String(i + 1), activity: `step ${i + 1}`, kind: "WORK", defaultDepartmentId: dept.id, ...over },
      });
    }
    return { tenantId: o.tenantId, templateId: template.id, sourceId: v.id };
  }
  const run = (tx: typeof owner, tenantId: number, apply: boolean, over = {}) => tx.$transaction((db) => ensureAssemblyRoles(db, tenantId, opts(apply, over)));
  const versions = (templateId: number) => owner.assemblyTemplateVersion.findMany({ where: { templateId }, orderBy: { version: "asc" }, include: { steps: { orderBy: { seq: "asc" } } } });

  it("a mapping that does not match the template is refused: nothing written", async () => {
    const w = await world([{}, {}, {}, {}]); // four template steps, three mapped
    const r = await run(owner, w.tenantId, true);
    expect(r.skipped.join(" ")).toMatch(/does not match/);
    expect(r.newVersion).toBeNull();
    expect((await versions(w.templateId)).length).toBe(1);
    expect(await owner.auditLog.count({ where: { tenantId: w.tenantId, action: "setup.assemblyTemplate.roles" } })).toBe(0);
  });

  it("a tenant with no PRESSURE_VESSEL family is skipped, not an error", async () => {
    const org = await owner.organization.create({ data: { code: `TEST-RL-NOFAM-${Date.now()}`, name: "no family" } });
    const r = await run(owner, org.id, true);
    expect(r.skipped.join(" ")).toMatch(/PRESSURE_VESSEL/);
    expect(r.newVersion).toBeNull();
  });

  it("a DRAFT version is never the source: only a PUBLISHED one with steps is copied", async () => {
    const w = await world([{}, {}, {}], "DRAFT");
    const r = await run(owner, w.tenantId, true);
    expect(r.skipped.join(" ")).toMatch(/no published/);
    expect((await versions(w.templateId)).length).toBe(1);
  });

  it("dry run reports what it would do and writes nothing", async () => {
    const w = await world();
    const r = await run(owner, w.tenantId, false);
    expect(r).toMatchObject({ sourceVersion: 500, newVersion: 501, filled: 2, already: 1 });
    expect((await versions(w.templateId)).length).toBe(1);
    expect(await owner.auditLog.count({ where: { tenantId: w.tenantId, action: "setup.assemblyTemplate.roles" } })).toBe(0);
  });

  it("apply publishes the next version with the roles; the source version is untouched", async () => {
    const w = await world();
    const before = JSON.stringify((await versions(w.templateId))[0]!.steps);
    const r = await run(owner, w.tenantId, true);
    expect(r).toMatchObject({ sourceVersion: 500, newVersion: 501, filled: 2 });
    const [src, next] = await versions(w.templateId);
    expect(JSON.stringify(src!.steps)).toBe(before); // invariant 9
    expect(next).toMatchObject({ version: 501, status: "PUBLISHED" });
    expect(next!.publishedAt).not.toBeNull();
    expect(next!.steps.map((s) => [s.seq, s.role, s.jointRef, s.pressurePart])).toEqual([
      [1, "FIT_UP", "LS-1", true],
      [2, "WELD", "LS-1", true],
      [3, null, null, false],
    ]);
    // Every other column is carried over unchanged.
    const strip = ({ id: _i, versionId: _v, role: _r, jointRef: _j, pressurePart: _p, ...rest }: (typeof src.steps)[number]) => rest;
    expect(next!.steps.map(strip)).toEqual(src!.steps.map(strip));
    const audit = await owner.auditLog.findMany({ where: { tenantId: w.tenantId, action: "setup.assemblyTemplate.roles" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: "AssemblyTemplateVersion", entityId: String(next!.id), actorId: null, userAgent: "test" });
  });

  it("is idempotent: a second apply finds the roles in place and writes nothing", async () => {
    const w = await world();
    await run(owner, w.tenantId, true);
    const r = await run(owner, w.tenantId, true);
    expect(r).toMatchObject({ filled: 0, newVersion: null });
    expect((await versions(w.templateId)).length).toBe(2);
  });

  it("never overwrites a fact that is already set on the source version", async () => {
    const w = await world([{ role: "NDT", jointRef: "CS-2" }, {}, {}]);
    await run(owner, w.tenantId, true);
    const next = (await versions(w.templateId))[1]!;
    expect(next.steps[0]).toMatchObject({ role: "NDT", jointRef: "CS-2", pressurePart: true }); // pressure was false, so it is filled
    expect(next.steps[1]).toMatchObject({ role: "WELD", jointRef: "LS-1" });
  });

  it("another tenant's template is not touched", async () => {
    const a = await world();
    const b = await world();
    await run(owner, a.tenantId, true);
    expect((await versions(b.templateId)).length).toBe(1);
  });
});
