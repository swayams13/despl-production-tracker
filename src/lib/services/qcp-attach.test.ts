import { afterAll, describe, expect, it } from "vitest";

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

/**
 * JG2: attachQcpTemplate. Each case builds its own tenant (like
 * assembly-qcp-match.test.ts) and runs against the real DB. Violations first.
 */
describe.skipIf(!RUN_DB)("attachQcpTemplate (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { ROLES } = await import("@/lib/authz");
  const { createJob, attachQcpTemplate } = await import("./job-intake.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;

  async function world(srNos: string[]) {
    const tag = `${stamp}-${++n}`;
    const org = await owner.organization.create({ data: { code: `TEST-ATT-${tag}`, name: "att" } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fab" } });
    const user = await owner.user.create({
      data: { tenantId, email: `u-${tag}@test.local`, username: `u-${tag}`, passwordHash: "x", name: "Admin", mustChangePassword: false },
    });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${tag}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    await owner.templateProcess.create({ data: { versionId: tv.id, seq: 1, code: "10", name: "P10", defaultDepartmentId: dept.id, optional: false } });
    const at = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "A" } });
    const av = await owner.assemblyTemplateVersion.create({ data: { templateId: at.id, version: 1, status: "PUBLISHED", publishedAt: new Date() } });
    await owner.assemblyTemplateStep.createMany({
      data: srNos.map((srNo, i) => ({
        versionId: av.id, seq: i + 1, groupCode: "A", groupName: "A", srNo, activity: `step ${i}`,
        kind: "INSPECTION" as const, defaultDepartmentId: dept.id, qcpSrNo: srNo,
      })),
    });
    // The library QCP: srNos in order, the first linked to process 10.
    const qcp = await owner.qcpTemplate.create({ data: { tenantId, jobLabel: "LIB", vessel: "V", revision: 0 } });
    const party = await owner.inspectionParty.create({ data: { tenantId, qcpTemplateId: qcp.id, code: "DESPL" } });
    for (const [i, srNo] of srNos.entries()) {
      const it = await owner.qcpItem.create({
        data: { tenantId, qcpTemplateId: qcp.id, sequence: i + 1, srNo, kind: "CHECKPOINT", activity: `qcp ${srNo}`, libraryProcessCodes: ["10", "99"] },
      });
      const code = await owner.qcpCodeRef.upsert({
        where: { tenantId_code: { tenantId, code: "H" } },
        update: {},
        create: { tenantId, code: "H", label: "Hold", blocksCompletion: true, waivable: false },
      });
      await owner.qcpItemPartyCode.create({ data: { tenantId, qcpItemId: it.id, inspectionPartyId: party.id, qcpCodeId: code.id } });
    }
    const actor = (roles: string[] = [ROLES.ADMIN], over: Record<string, unknown> = {}) => ({
      userId: user.id, tenantId, clientId: null, name: "Admin", email: user.email, roles, departmentIds: [],
      mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false, ...over,
    }) as never;
    const create = async (qcpTemplateSourceId: number | null) =>
      createJob(actor(), {
        clientId: client.id, familyId: family.id, templateVersionId: tv.id, calendarId: null, jobNumber: `ATT-${stamp}-${++n}`,
        clientOrderNo: null, projectName: null, poRef: null, designCode: null, orderDate: null, committedDeliveryDate: null,
        targetDispatchDate: null, priority: "NORMAL", remarks: null, excludedProcessCodes: [], exclusionReason: null,
        equipments: [{ equipmentTypeId: null, name: "Line", blockNo: 1, remarks: null, config: null, serials: [`S-${n}`] }],
        qcpTemplateSourceId, copyBomFromEquipmentId: null,
      } as never);
    return { tenantId, qcp: qcp.id, actor, create };
  }

  /** What a job's QCP looks like, independent of ids. */
  async function shape(jobId: number) {
    const items = await owner.qcpItem.findMany({
      where: { qcpTemplate: { jobId } },
      orderBy: { sequence: "asc" },
      include: { processLinks: true, partyCodes: true },
    });
    const steps = await owner.assemblyStep.findMany({ where: { jobId }, orderBy: { seq: "asc" }, include: { templateStep: true } });
    return {
      items: items.map((i) => [i.srNo, i.processLinks.length, i.partyCodes.length]),
      links: steps.map((s) => [s.templateStep.srNo, s.qcpItemId == null ? null : items.find((i) => i.id === s.qcpItemId)?.srNo]),
    };
  }

  afterAll(async () => {
    await owner.$disconnect();
  });

  it.each([
    ["SUPERVISOR", [ROLES.SUPERVISOR], null],
    ["QC", [ROLES.QC], null],
    ["MANAGEMENT", [ROLES.MANAGEMENT], null],
    ["a client user", [ROLES.CLIENT_VIEWER], 5],
  ])("refuses %s", async (_l, roles, clientId) => {
    const w = await world(["1", "2"]);
    const job = { id: (await w.create(null)).jobId };
    await expect(attachQcpTemplate(w.actor(roles as string[], { clientId }), { jobId: job.id, qcpTemplateSourceId: w.qcp })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows the Production Head", async () => {
    const w = await world(["1"]);
    const job = { id: (await w.create(null)).jobId };
    await expect(attachQcpTemplate(w.actor([ROLES.PRODUCTION_HEAD]), { jobId: job.id, qcpTemplateSourceId: w.qcp })).resolves.toMatchObject({ itemCount: 1 });
  });

  it("does not see another tenant's job", async () => {
    const a = await world(["1"]);
    const b = await world(["1"]);
    const job = { id: (await a.create(null)).jobId };
    await expect(attachQcpTemplate(b.actor(), { jobId: job.id, qcpTemplateSourceId: b.qcp })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a QC plan from another tenant", async () => {
    const a = await world(["1"]);
    const b = await world(["1"]);
    const job = { id: (await a.create(null)).jobId };
    await expect(attachQcpTemplate(a.actor(), { jobId: job.id, qcpTemplateSourceId: b.qcp })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a second attach (QCP_ALREADY_ATTACHED) and a job created with a plan", async () => {
    const w = await world(["1", "2"]);
    const job = { id: (await w.create(null)).jobId };
    await attachQcpTemplate(w.actor(), { jobId: job.id, qcpTemplateSourceId: w.qcp });
    await expect(attachQcpTemplate(w.actor(), { jobId: job.id, qcpTemplateSourceId: w.qcp })).rejects.toMatchObject({ code: "QCP_ALREADY_ATTACHED" });
    const withPlan = { id: (await w.create(w.qcp)).jobId };
    await expect(attachQcpTemplate(w.actor(), { jobId: withPlan.id, qcpTemplateSourceId: w.qcp })).rejects.toMatchObject({ code: "QCP_ALREADY_ATTACHED" });
    expect(await owner.qcpTemplate.count({ where: { jobId: job.id } })).toBe(1);
  });

  it("a plan that does not number the assembly checklist refuses and changes nothing", async () => {
    const w = await world(["1.1", "1.2"]);
    const job = { id: (await w.create(null)).jobId };
    const bad = await owner.qcpTemplate.create({ data: { tenantId: w.tenantId, jobLabel: "BAD", vessel: "V", revision: 0 } });
    await owner.qcpItem.create({ data: { tenantId: w.tenantId, qcpTemplateId: bad.id, sequence: 1, srNo: "9", kind: "CHECKPOINT", activity: "x" } });
    await expect(attachQcpTemplate(w.actor(), { jobId: job.id, qcpTemplateSourceId: bad.id })).rejects.toMatchObject({ code: "QCP_ITEM_UNRESOLVED" });
    expect(await owner.qcpTemplate.count({ where: { jobId: job.id } })).toBe(0);
  });

  it("attach after create yields the same items, links and step bindings as choosing the plan at create", async () => {
    const w = await world(["1", "2", "2", "3"]);
    const at = { id: (await w.create(w.qcp)).jobId };
    const later = { id: (await w.create(null)).jobId };
    const r = await attachQcpTemplate(w.actor(), { jobId: later.id, qcpTemplateSourceId: w.qcp });
    expect(r).toMatchObject({ itemCount: 4, bound: 4, leftUnbound: [], unmatchedProcessCodes: ["99"] });
    const a = await shape(at.id);
    const b = await shape(later.id);
    expect(b).toEqual(a);
    expect(b.links.every(([, q]) => q != null)).toBe(true);
    expect(b.items.every(([, links, parties]) => links === 1 && parties === 1)).toBe(true);
  });

  it("binds only NOT_STARTED steps; started ones stay unbound and are listed", async () => {
    const w = await world(["1", "2", "3"]);
    const job = { id: (await w.create(null)).jobId };
    const steps = await owner.assemblyStep.findMany({ where: { jobId: job.id }, orderBy: { seq: "asc" } });
    await owner.assemblyStep.update({ where: { id: steps[1].id }, data: { status: "IN_PROGRESS" } });
    await owner.assemblyStep.update({ where: { id: steps[2].id }, data: { status: "COMPLETE" } });
    const r = await attachQcpTemplate(w.actor(), { jobId: job.id, qcpTemplateSourceId: w.qcp });
    expect(r.bound).toBe(1);
    expect(r.leftUnbound).toEqual([
      { assemblyStepId: steps[1].id, srNo: "2", status: "IN_PROGRESS" },
      { assemblyStepId: steps[2].id, srNo: "3", status: "COMPLETE" },
    ]);
    const after = await owner.assemblyStep.findMany({ where: { jobId: job.id }, orderBy: { seq: "asc" } });
    expect(after.map((s) => s.qcpItemId != null)).toEqual([true, false, false]);
    expect(after.map((s) => s.requiresQc)).toEqual(steps.map((s) => s.requiresQc)); // not re-derived
  });

  it("writes one qcp.attach audit row", async () => {
    const w = await world(["1"]);
    const job = { id: (await w.create(null)).jobId };
    await attachQcpTemplate(w.actor(), { jobId: job.id, qcpTemplateSourceId: w.qcp });
    const rows = await owner.auditLog.findMany({ where: { tenantId: w.tenantId, action: "qcp.attach", entityId: String(job.id) } });
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toMatchObject({ itemCount: 1, boundSteps: 1 });
  });
});
