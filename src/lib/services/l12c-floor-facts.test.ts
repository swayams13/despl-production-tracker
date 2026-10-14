import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * Lean Core L1.2c, DB-gated: releaseDrawingAtRisk (PRODUCTION_HEAD only, reason
 * required, recorded, audited, voided by a newer revision), H3's gate
 * (assertDrawingReleased) accepting an at-risk release, and D3's
 * deriveRequiresQc applied at materialisation. Violation cases first.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org codes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L1.2c floor facts (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withJob, withTenant } = await import("@/lib/db");
  const { releaseDrawingAtRisk, createDrawingRevision } = await import("./drawing.service");
  const { assertDrawingReleased } = await import("./_shared");
  const { materializeAssemblyStepsFromTemplate } = await import("./assembly.service");
  const { materializeComponentsFromBomItems } = await import("./component.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let seq = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++seq}`;

  async function org(suffix: string) {
    const o = await owner.organization.create({ data: { code: `TEST-L12C-${suffix}-${stamp}`, name: `l12c ${suffix}` } });
    const tenantId = o.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const mkUser = (tag: string) =>
      owner.user.create({ data: { tenantId, email: `${uniq(tag)}@test.local`, username: uniq(tag), passwordHash: "x", name: tag } });
    const head = await mkUser("head");
    const drawingType = await owner.drawingTypeRef.create({ data: { tenantId, code: "GA", name: "GA" } });
    return { tenantId, dept, client, family, tv, head, drawingType };
  }

  async function job(o: Awaited<ReturnType<typeof org>>) {
    const j = await owner.job.create({
      data: { tenantId: o.tenantId, publicId: uniq("pub"), clientId: o.client.id, familyId: o.family.id, templateVersionId: o.tv.id, jobNumber: uniq("JOB") },
    });
    const equipment = await owner.equipment.create({ data: { jobId: j.id, name: "Air Receiver" } });
    const unit = await owner.unit.create({ data: { jobId: j.id, equipmentId: equipment.id, serialNo: uniq("SR") } });
    const drawing = await owner.assemblyDrawing.create({ data: { jobId: j.id, drawingTypeId: o.drawingType.id, drawingNo: uniq("GA") } });
    const revision = (revisionNo: number, status: "DRAFT" | "RELEASED" | "SUBMITTED" | "APPROVED" = "DRAFT") =>
      owner.drawingRevision.create({ data: { jobId: j.id, assemblyDrawingId: drawing.id, revisionNo, status } });
    const type = await owner.componentTypeRef.create({ data: { tenantId: o.tenantId, code: uniq("PLATE"), name: "Plate" } });
    const component = await owner.component.create({
      data: { jobId: j.id, equipmentId: equipment.id, tag: uniq("SHELL"), componentTypeId: type.id, governingDrawingId: drawing.id },
    });
    return { job: j, equipment, unit, drawing, revision, component };
  }

  const actor = (o: { tenantId: number; head: { id: number } }, roles: Actor["roles"], clientId: number | null = null): Actor => ({
    userId: o.head.id, tenantId: o.tenantId, clientId, name: "T", email: "t@x", roles, departmentIds: [],
    mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false,
  });

  async function expectCode(p: Promise<unknown>, code: string) {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code, String(thrown)).toBe(code);
  }
  const gate = (o: { tenantId: number }, j: { job: { id: number }; component: { id: number } }) =>
    withJob(o.tenantId, j.job.id, (tx) => assertDrawingReleased(tx, j.component.id, o.tenantId));

  let a: Awaited<ReturnType<typeof org>>;
  let b: Awaited<ReturnType<typeof org>>;
  beforeAll(async () => {
    a = await org("A");
    b = await org("B");
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  describe("releaseDrawingAtRisk: refusals", () => {
    it.each<[string, Actor["roles"], number | null]>([
      ["ADMIN (not PRODUCTION_HEAD)", [ROLES.ADMIN], null],
      ["SUPERVISOR", [ROLES.SUPERVISOR], null],
      ["QC", [ROLES.QC], null],
      ["PLANNER", [ROLES.PLANNER], null],
      ["no role", [], null],
      ["a PRODUCTION_HEAD who is a client user", [ROLES.PRODUCTION_HEAD], 1],
    ])("%s is refused FORBIDDEN and nothing is recorded", async (_l, roles, clientId) => {
      const j = await job(a);
      const rev = await j.revision(0);
      await expectCode(
        releaseDrawingAtRisk(actor(a, roles, clientId), { jobId: j.job.id, drawingRevisionId: rev.id, reason: "client deadline" }),
        ERROR_CODES.FORBIDDEN,
      );
      const after = await owner.drawingRevision.findUniqueOrThrow({ where: { id: rev.id } });
      expect([after.atRiskReleasedById, after.atRiskReleasedAt, after.atRiskReason]).toEqual([null, null, null]);
    });

    it.each<[string, string | undefined]>([
      ["no reason", undefined],
      ["an empty reason", ""],
      ["a whitespace reason", "   "],
    ])("%s is refused and nothing is recorded", async (_l, reason) => {
      const j = await job(a);
      const rev = await j.revision(0);
      await expect(
        releaseDrawingAtRisk(actor(a, [ROLES.PRODUCTION_HEAD]), { jobId: j.job.id, drawingRevisionId: rev.id, reason: reason as string }),
      ).rejects.toThrow();
      expect((await owner.drawingRevision.findUniqueOrThrow({ where: { id: rev.id } })).atRiskReleasedAt).toBeNull();
    });

    it("an already RELEASED revision is refused INVALID_STATE_TRANSITION", async () => {
      const j = await job(a);
      const rev = await j.revision(1, "RELEASED");
      await expectCode(
        releaseDrawingAtRisk(actor(a, [ROLES.PRODUCTION_HEAD]), { jobId: j.job.id, drawingRevisionId: rev.id, reason: "x" }),
        ERROR_CODES.INVALID_STATE_TRANSITION,
      );
    });

    it("an older revision (a newer one exists) is refused INVALID_STATE_TRANSITION", async () => {
      const j = await job(a);
      const old = await j.revision(1);
      await j.revision(2);
      await expectCode(
        releaseDrawingAtRisk(actor(a, [ROLES.PRODUCTION_HEAD]), { jobId: j.job.id, drawingRevisionId: old.id, reason: "x" }),
        ERROR_CODES.INVALID_STATE_TRANSITION,
      );
    });

    it("a second at-risk release of the same revision is refused and the first one is kept", async () => {
      const j = await job(a);
      const rev = await j.revision(0);
      const head = actor(a, [ROLES.PRODUCTION_HEAD]);
      await releaseDrawingAtRisk(head, { jobId: j.job.id, drawingRevisionId: rev.id, reason: "first" });
      await expectCode(
        releaseDrawingAtRisk(head, { jobId: j.job.id, drawingRevisionId: rev.id, reason: "second" }),
        ERROR_CODES.INVALID_STATE_TRANSITION,
      );
      expect((await owner.drawingRevision.findUniqueOrThrow({ where: { id: rev.id } })).atRiskReason).toBe("first");
    });

    it("another tenant's revision id is NOT_FOUND; a revision of another job is NOT_FOUND", async () => {
      const j = await job(a);
      const rev = await j.revision(0);
      const other = await job(a);
      const intruder = actor(b, [ROLES.PRODUCTION_HEAD]);
      await expectCode(releaseDrawingAtRisk(intruder, { jobId: j.job.id, drawingRevisionId: rev.id, reason: "x" }), ERROR_CODES.NOT_FOUND);
      await expectCode(
        releaseDrawingAtRisk(actor(a, [ROLES.PRODUCTION_HEAD]), { jobId: other.job.id, drawingRevisionId: rev.id, reason: "x" }),
        ERROR_CODES.NOT_FOUND,
      );
    });
  });

  describe("releaseDrawingAtRisk: recorded, audited, and H3 accepts it", () => {
    it("the cutting gate refuses before, passes after (and stamps the revision), with the release recorded and audited", async () => {
      const j = await job(a);
      const rev = await j.revision(0);
      await expectCode(gate(a, j), ERROR_CODES.DRAWING_NOT_RELEASED);

      const updated = await releaseDrawingAtRisk(actor(a, [ROLES.PRODUCTION_HEAD]), {
        jobId: j.job.id,
        drawingRevisionId: rev.id,
        reason: "  client asked to start; GA only changes nozzle orientation  ",
        clientConsentRef: "MAIL-2026-10-14",
      });
      expect(updated.status).toBe("DRAFT"); // still not formally released
      expect(updated.atRiskReleasedById).toBe(a.head.id);
      expect(updated.atRiskReleasedAt).toBeInstanceOf(Date);
      expect(updated.atRiskReason).toBe("client asked to start; GA only changes nozzle orientation");
      expect(updated.clientConsentRef).toBe("MAIL-2026-10-14");

      expect(await gate(a, j)).toBe(rev.id);

      const audit = await owner.auditLog.findFirstOrThrow({
        where: { tenantId: a.tenantId, action: "drawing.releaseAtRisk", entityType: "DrawingRevision", entityId: String(rev.id) },
      });
      expect(audit.actorId).toBe(a.head.id);
      expect(audit.after).toMatchObject({ revisionNo: 0, reason: "client asked to start; GA only changes nozzle orientation", clientConsentRef: "MAIL-2026-10-14" });
      expect(
        await owner.domainEvent.count({ where: { tenantId: a.tenantId, type: "DrawingReleasedAtRisk", aggregateId: String(rev.id) } }),
      ).toBe(1);
    });

    it("client consent is optional", async () => {
      const j = await job(a);
      const rev = await j.revision(0);
      const updated = await releaseDrawingAtRisk(actor(a, [ROLES.PRODUCTION_HEAD]), { jobId: j.job.id, drawingRevisionId: rev.id, reason: "urgent" });
      expect(updated.clientConsentRef).toBeNull();
      expect(await gate(a, j)).toBe(rev.id);
    });

    it("a newer revision voids the at-risk release: the gate refuses again and the void is audited", async () => {
      const j = await job(a);
      const rev0 = await j.revision(0);
      const head = actor(a, [ROLES.PRODUCTION_HEAD]);
      await releaseDrawingAtRisk(head, { jobId: j.job.id, drawingRevisionId: rev0.id, reason: "urgent" });
      expect(await gate(a, j)).toBe(rev0.id);

      const rev1 = await createDrawingRevision(head, { jobId: j.job.id, assemblyDrawingId: j.drawing.id, revisionNo: 1, status: "DRAFT" });
      await expectCode(gate(a, j), ERROR_CODES.DRAWING_NOT_RELEASED);
      // The old row keeps its history.
      expect((await owner.drawingRevision.findUniqueOrThrow({ where: { id: rev0.id } })).atRiskReason).toBe("urgent");
      const audit = await owner.auditLog.findFirstOrThrow({
        where: { tenantId: a.tenantId, action: "drawing.createRevision", entityId: String(rev1.id) },
      });
      expect(audit.before).toMatchObject({ voidedAtRiskReleaseOfRevisionId: rev0.id });

      // The new revision can itself be released at risk, or formally released.
      await releaseDrawingAtRisk(head, { jobId: j.job.id, drawingRevisionId: rev1.id, reason: "still urgent" });
      expect(await gate(a, j)).toBe(rev1.id);
    });

    it("a revision issued as RELEASED after an at-risk one passes without any at-risk fields", async () => {
      const j = await job(a);
      const rev0 = await j.revision(0);
      const head = actor(a, [ROLES.PRODUCTION_HEAD]);
      await releaseDrawingAtRisk(head, { jobId: j.job.id, drawingRevisionId: rev0.id, reason: "urgent" });
      const rev1 = await createDrawingRevision(head, { jobId: j.job.id, assemblyDrawingId: j.drawing.id, revisionNo: 1, status: "RELEASED" });
      expect(await gate(a, j)).toBe(rev1.id);
      expect(rev1.atRiskReleasedAt).toBeNull();
    });
  });

  describe("deriveRequiresQc at materialisation (D3)", () => {
    describe("assembly steps: derived only where the template step carries a role", () => {
      it("applies the rule per step; role-less steps keep the template value; either level can waive", async () => {
        const o = await org("ASM");
        const j = await job(o);
        const fam = await owner.productFamily.create({ data: { tenantId: o.tenantId, code: uniq("PV-ASM"), name: "asm" } });
        const tpl = await owner.assemblyTemplate.create({ data: { tenantId: o.tenantId, familyId: fam.id, name: "A-Q" } });
        const v = await owner.assemblyTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
        const base = { versionId: v.id, groupCode: "E", groupName: "g", srNo: "4.5", defaultDepartmentId: o.dept.id };
        const rows = [
          { seq: 1, kind: "WORK", role: "FIT_UP", pressurePart: true, requiresQc: true, expect: true, why: "fit-up on a pressure joint" },
          { seq: 2, kind: "WORK", role: "WELD", pressurePart: false, requiresQc: true, expect: false, why: "non-pressure attachment weld" },
          { seq: 3, kind: "WORK", role: null, pressurePart: false, requiresQc: true, expect: true, why: "no role: template value stays" },
          { seq: 4, kind: "WORK", role: "WELD", pressurePart: true, requiresQc: false, expect: false, why: "template waives, rule says true: waived (AND)" },
          { seq: 5, kind: "INSPECTION", role: "NDT", pressurePart: true, requiresQc: true, expect: false, why: "QC's own inspection step" },
          { seq: 6, kind: "WORK", role: "HYDRO", pressurePart: false, requiresQc: true, expect: true, why: "hydro test record" },
          { seq: 7, kind: "INSPECTION", role: null, pressurePart: false, requiresQc: true, expect: true, why: "no role: template value stays" },
        ] as const;
        await owner.assemblyTemplateStep.createMany({
          data: rows.map((r) => ({ ...base, seq: r.seq, activity: `s${r.seq}`, kind: r.kind, role: r.role, pressurePart: r.pressurePart, requiresQc: r.requiresQc })),
        });
        await withTenant(o.tenantId, (tx) => materializeAssemblyStepsFromTemplate(tx, o.tenantId, j.job.id, fam.id, [j.unit.id], null));
        const got = await owner.assemblyStep.findMany({ where: { unitId: j.unit.id }, orderBy: { seq: "asc" } });
        expect(got.map((s) => [s.seq, s.requiresQc])).toEqual(rows.map((r) => [r.seq, r.expect]));
      });
    });

    describe("component operations: derived only for part types whose pressure flag is APPROVED", () => {
      const ops = ["CUTTING", "WELDING", "PAINTING", "NDT"] as const;
      type Fam = null | { status: "DRAFT" | "APPROVED"; pressureRetaining: boolean };
      it.each<[string, Fam, boolean, Record<(typeof ops)[number], boolean>]>([
        ["no part family: today's value for every op", null, true, { CUTTING: true, WELDING: true, PAINTING: true, NDT: true }],
        ["DRAFT family flagged pressure: unreviewed, today's value", { status: "DRAFT", pressureRetaining: true }, true, { CUTTING: true, WELDING: true, PAINTING: true, NDT: true }],
        ["APPROVED pressure part: cutting, welding, painting true; NDT is QC's own work", { status: "APPROVED", pressureRetaining: true }, true, { CUTTING: true, WELDING: true, PAINTING: true, NDT: false }],
        ["APPROVED non-pressure part: only the painting DFT record needs QC", { status: "APPROVED", pressureRetaining: false }, true, { CUTTING: false, WELDING: false, PAINTING: true, NDT: false }],
        ["APPROVED pressure part, route step waives QC on welding: waived", { status: "APPROVED", pressureRetaining: true }, false, { CUTTING: true, WELDING: false, PAINTING: true, NDT: false }],
      ])("%s", async (_label, family, weldingStepRequiresQc, expected) => {
        const n = uniq("T");
        const type = await owner.componentTypeRef.create({ data: { tenantId: a.tenantId, code: n, name: n } });
        if (family) {
          await owner.partFamily.create({
            data: {
              tenantId: a.tenantId,
              componentTypeId: type.id,
              ...family,
              ...(family.status === "APPROVED" ? { approvedById: a.head.id, approvedAt: new Date() } : {}),
            },
          });
        }
        const j = await job(a);
        const route = await owner.routeTemplate.create({ data: { tenantId: a.tenantId, componentTypeId: type.id, familyId: a.family.id, name: "R" } });
        const rv = await owner.routeTemplateVersion.create({ data: { routeId: route.id, version: 1, status: "PUBLISHED" } });
        for (const [i, code] of ops.entries()) {
          const opRef = await owner.operationRef.upsert({
            where: { tenantId_code: { tenantId: a.tenantId, code } },
            update: {},
            create: { tenantId: a.tenantId, code, name: code },
          });
          await owner.routeStep.create({
            data: { routeVersionId: rv.id, seq: (i + 1) * 10, operationId: opRef.id, ...(code === "WELDING" ? { requiresQc: weldingStepRequiresQc } : {}) },
          });
        }
        const bom = await owner.bomItem.create({
          data: { jobId: j.job.id, equipmentId: j.equipment.id, itemNo: 1, partName: n, sourceQty: "1", componentTypeId: type.id },
        });
        await withTenant(a.tenantId, (tx) => materializeComponentsFromBomItems(tx, a.family.id, j.equipment.id, [bom.id], j.job.id));

        const comp = await owner.component.findFirstOrThrow({ where: { bomItemId: bom.id } });
        const got = await owner.componentOperation.findMany({ where: { componentId: comp.id }, include: { operation: true } });
        expect(Object.fromEntries(got.map((g) => [g.operation.code, g.requiresQc]))).toEqual(expected);
      });
    });
  });
});
