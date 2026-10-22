import { afterAll, describe, expect, it } from "vitest";

/**
 * J5a: floor steps are generated at BOM release (previewBomRelease, mapBomLines,
 * releaseBomRevision). Refusals first, per CLAUDE.md, then what a release makes.
 * Every fixture is its own disposable tenant (owner client bypasses RLS). Gated behind RUN_DB_TESTS.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const pwht = { all: [{ key: "pwht", op: "truthy" }] };

describe.skipIf(!RUN_DB)("BOM release (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { ROLES } = await import("@/lib/authz");
  const { createJob } = await import("./job-intake.service");
  const svc = await import("./bom-release.service");
  const bomSvc = await import("./bom.service");
  const read = await import("./bom-release.read");
  const { releaseJobBoms } = await import("./bom-release.test-util");
  const { materializeComponentsFromBomItems } = await import("./component.service");
  const { materializeAssemblyStepsFromTemplate } = await import("./assembly.service");
  const { LineRules } = await import("./config-rules");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;

  type Bom = { itemNo: number; partName: string; typeId?: number | null; variant?: string | null; qtyPer?: number };

  /** A disposable tenant: family, route, assembly sequence, QC plan, approved/draft/raw part types with routes. */
  async function world(label: string) {
    const org = await owner.organization.create({ data: { code: `TEST-J5A-${label}-${stamp}-${++n}`, name: `j5a ${label}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const mkUser = (name: string) =>
      owner.user.create({ data: { tenantId, email: `${uniq("u")}@test.local`, username: uniq("u"), passwordHash: "x", name, mustChangePassword: false } });
    const [admin, eng, sj, planner, qc, sup, clientU] = await Promise.all(["Admin", "Eng", "SJ", "Planner", "QC", "Sup", "ClientU"].map(mkUser));
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    await owner.templateProcess.create({ data: { versionId: tv.id, seq: 1, code: "10", name: "P10", defaultDepartmentId: dept.id } });
    await owner.configQuestion.create({ data: { tenantId, familyId: family.id, key: "pwht", label: "PWHT", type: "BOOLEAN" } });

    // part types: an approved pressure part, an unapproved one, a raw form
    const mkType = (code: string, kind: "PART_FAMILY" | "RAW_FORM", status?: "APPROVED" | "DRAFT") =>
      owner.componentTypeRef.create({ data: { tenantId, code, name: code === "SHL" ? "Shell course" : code, kind } }).then(async (t) => {
        if (status) await owner.partFamily.create({ data: { tenantId, componentTypeId: t.id, status, pressureRetaining: code === "SHL", approvedById: status === "APPROVED" ? sj.id : null, approvedAt: status === "APPROVED" ? new Date() : null } });
        return t;
      });
    const shl = await mkType("SHL", "PART_FAMILY", "APPROVED");
    const drf = await mkType("DRF", "PART_FAMILY", "DRAFT");
    const plt = await mkType("PLT", "RAW_FORM");
    const opCut = await owner.operationRef.create({ data: { tenantId, code: "CUTTING", name: "Cutting", defaultDepartmentId: dept.id } });
    const opWeld = await owner.operationRef.create({ data: { tenantId, code: "WELDING", name: "Welding", defaultDepartmentId: dept.id } });
    const route = async (typeId: number, variant: string, steps: { seq: number; op: number; includeWhen?: unknown }[], publish = true) => {
      const r = await owner.routeTemplate.create({ data: { tenantId, componentTypeId: typeId, familyId: family.id, name: `${variant}`, variant } });
      if (!publish) return r;
      const v = await owner.routeTemplateVersion.create({ data: { routeId: r.id, version: 1, status: "PUBLISHED" } });
      for (const s of steps) await owner.routeStep.create({ data: { routeVersionId: v.id, seq: s.seq, operationId: s.op, includeWhen: s.includeWhen as never } });
      return r;
    };
    await route(shl.id, "A", [{ seq: 10, op: opCut.id }, { seq: 20, op: opWeld.id, includeWhen: pwht }]);
    await route(shl.id, "B", [{ seq: 10, op: opCut.id }]);
    await route(shl.id, "C", [], false); // a variant with no published version
    await route(plt.id, "A", [{ seq: 10, op: opCut.id }]);
    await route(drf.id, "A", [{ seq: 10, op: opCut.id }]);

    // assembly sequence: per unit, per nozzle joint, per shell component, one inspection, one rule-gated step
    const at = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "Seq" } });
    const av = await owner.assemblyTemplateVersion.create({ data: { templateId: at.id, version: 1, status: "PUBLISHED", publishedAt: new Date() } });
    const step = (seq: number, srNo: string, activity: string, extra: Record<string, unknown> = {}) => ({
      versionId: av.id, seq, groupCode: "A", groupName: "A", srNo, activity, kind: "WORK" as const, defaultDepartmentId: dept.id, ...extra,
    });
    await owner.assemblyTemplateStep.createMany({
      data: [
        step(1, "1", "Mark out"),
        step(2, "2", "Weld nozzle", { scope: "PER_JOINT", jointType: "NOZZLE", role: "WELD", pressurePart: true }),
        step(3, "3", "Fit shell course", { scope: "PER_COMPONENT", componentTypeId: shl.id }),
        step(4, "5", "Final inspection", { kind: "INSPECTION", qcpSrNo: "5" }),
        step(5, "6", "Post heat treatment check", { includeWhen: pwht as never }),
      ],
    });
    const qcp = await owner.qcpTemplate.create({ data: { tenantId, jobLabel: "LIB", vessel: "V" } });
    await owner.qcpItem.create({ data: { tenantId, qcpTemplateId: qcp.id, sequence: 1, srNo: "5", kind: "CHECKPOINT", activity: "qcp 5" } });

    const mk = (u: { id: number; email: string }, roles: string[], clientId: number | null = null) =>
      ({ userId: u.id, tenantId, clientId, name: "x", email: u.email, roles: roles as never, departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false }) as never;
    const actors = {
      admin: mk(admin, [ROLES.ADMIN]),
      eng: mk(eng, [ROLES.ENGINEERING]),
      sj: mk(sj, [ROLES.PRODUCTION_HEAD]),
      planner: mk(planner, [ROLES.PLANNER]),
      qc: mk(qc, [ROLES.QC]),
      sup: mk(sup, [ROLES.SUPERVISOR]),
      client: mk(clientU, [ROLES.CLIENT_VIEWER], client.id),
    };

    /** A job with one line and a DRAFT revision 1 carrying the given BOM lines. */
    async function job(opts: { units?: number; config?: Record<string, unknown> | null; withQcp?: boolean; bom?: Bom[]; equipmentTypeId?: number | null } = {}) {
      const units = opts.units ?? 2;
      const r = await createJob(actors.admin, {
        clientId: client.id, familyId: family.id, templateVersionId: tv.id, calendarId: null, jobNumber: uniq("J5A"),
        clientOrderNo: null, projectName: null, poRef: null, designCode: null, orderDate: null, committedDeliveryDate: null,
        targetDispatchDate: null, priority: "NORMAL", remarks: null, excludedProcessCodes: [], exclusionReason: null,
        equipments: [{ equipmentTypeId: opts.equipmentTypeId ?? null, name: "Vessel", blockNo: 1, remarks: null, config: opts.config ?? null, serials: Array.from({ length: units }, (_, i) => `S${i + 1}-${n}`) }],
        qcpTemplateSourceId: opts.withQcp === false ? null : qcp.id,
        copyBomFromEquipmentId: null,
      } as never);
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
      const rev = await owner.bomRevision.create({ data: { equipmentId: eq.id, revisionNo: 1, status: "DRAFT", jobId: r.jobId } });
      const items = [];
      for (const b of opts.bom ?? []) {
        items.push(await owner.bomItem.create({
          data: { jobId: r.jobId, equipmentId: eq.id, bomRevisionId: rev.id, itemNo: b.itemNo, partName: b.partName, sourceQty: `${b.qtyPer ?? 1} NOS.`, qtyPer: b.qtyPer ?? 1, uom: "NOS.", componentTypeId: b.typeId ?? null, routeVariant: b.variant ?? null },
        }));
      }
      return { jobId: r.jobId, equipmentId: eq.id, revisionId: rev.id, items, target: { equipmentId: eq.id, bomRevisionId: rev.id } };
    }
    return { tenantId, org, family, shl, drf, plt, opCut, opWeld, qcp, actors, job, tv, dept, av };
  }
  type World = Awaited<ReturnType<typeof world>>;
  type J = Awaited<ReturnType<World["job"]>>;

  const counts = async (j: J) => ({
    components: await owner.component.count({ where: { equipmentId: j.equipmentId } }),
    operations: await owner.componentOperation.count({ where: { jobId: j.jobId } }),
    steps: await owner.assemblyStep.count({ where: { jobId: j.jobId } }),
    ledger: await owner.configRuleDecision.count({ where: { jobId: j.jobId } }),
    joints: await owner.plannedJoint.count({ where: { equipmentId: j.equipmentId } }),
    audit: await owner.auditLog.count({ where: { tenantId: (await owner.job.findUniqueOrThrow({ where: { id: j.jobId } })).tenantId } }),
  });
  const rev = (j: J) => owner.bomRevision.findUniqueOrThrow({ where: { id: j.revisionId } });
  const ack = (j: J) => ({ ...j.target, acknowledgeWarnings: true });

  afterAll(async () => {
    await owner.$disconnect();
  });

  // ── who and what ─────────────────────────────────────────────────────────
  describe("refusals", () => {
    it.each([
      ["SUPERVISOR", "sup"],
      ["QC", "qc"],
      ["PLANNER", "planner"],
      ["a client user", "client"],
    ] as const)("refuses %s on preview, map and release, and writes nothing", async (_l, who) => {
      const w = await world("ROLE");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      const before = await counts(j);
      const a = w.actors[who];
      await expect(svc.previewBomRelease(a, j.target)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(svc.mapBomLines(a, { bomRevisionId: j.revisionId, lines: [{ bomItemId: j.items[0].id, componentTypeId: null }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(svc.releaseBomRevision(a, ack(j))).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await counts(j)).toEqual(before);
      expect((await rev(j)).materializedAt).toBeNull();
    });

    it.each(["admin", "eng", "sj"] as const)("allows %s", async (who) => {
      const w = await world("ROLEOK");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      await expect(svc.releaseBomRevision(w.actors[who], ack(j))).resolves.toMatchObject({ noop: false });
    });

    it("does not see another tenant's line or revision", async () => {
      const a = await world("TA");
      const b = await world("TB");
      const j = await a.job();
      await expect(svc.releaseBomRevision(b.actors.admin, ack(j))).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(svc.previewBomRelease(b.actors.admin, j.target)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(svc.mapBomLines(b.actors.admin, { bomRevisionId: j.revisionId, lines: [{ bomItemId: 1, componentTypeId: null }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses another job's revision for this line", async () => {
      const w = await world("OTHERJOB");
      const j1 = await w.job();
      const j2 = await w.job();
      await expect(svc.releaseBomRevision(w.actors.admin, { equipmentId: j1.equipmentId, bomRevisionId: j2.revisionId, acknowledgeWarnings: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await rev(j2)).materializedAt).toBeNull();
    });

    it("refuses a line mapped to an unapproved part family (ROUTE_NOT_APPROVED), whatever the acknowledgement, and creates nothing", async () => {
      const w = await world("UNAPPROVED");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }, { itemNo: 2, partName: "Draft part", typeId: w.drf.id }] });
      const before = await counts(j);
      await expect(svc.releaseBomRevision(w.actors.admin, ack(j))).rejects.toMatchObject({ code: "ROUTE_NOT_APPROVED" });
      expect(await counts(j)).toEqual(before);
      expect((await rev(j)).status).toBe("DRAFT");
      const p = await svc.previewBomRelease(w.actors.admin, j.target);
      expect(p.state).toBe("REFUSED");
      expect(p.refusals.map((r) => r.itemNo)).toEqual([2]);
      expect(p.lines.find((l) => l.itemNo === 2)!.issue).toMatchObject({ reason: "PART_FAMILY_NOT_APPROVED" });
    });

    it("refuses a route variant with no published version", async () => {
      const w = await world("NOVARIANT");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id, variant: "C" }] });
      await expect(svc.releaseBomRevision(w.actors.admin, ack(j))).rejects.toMatchObject({ code: "ROUTE_NOT_APPROVED" });
      expect((await svc.previewBomRelease(w.actors.admin, j.target)).lines[0].issue).toMatchObject({ reason: "VARIANT_NOT_PUBLISHED" });
    });

    it("lists the warnings and refuses until they are acknowledged; the refused release writes nothing", async () => {
      const w = await world("WARN");
      const j = await w.job({ withQcp: false, bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }, { itemNo: 2, partName: "Mystery bracket" }] });
      const before = await counts(j);
      const err = await svc.releaseBomRevision(w.actors.admin, j.target).catch((e) => e);
      expect(err).toMatchObject({ code: "BOM_RELEASE_WARNINGS_UNACKNOWLEDGED" });
      const codes = (err.detail.warnings as { code: string }[]).map((x) => x.code);
      expect(codes).toEqual(expect.arrayContaining(["LINES_UNMAPPED", "NO_QCP", "NO_JOINTS_FOR_STEPS", "H3_DATA_GAPS"]));
      expect(await counts(j)).toEqual(before);
      expect((await rev(j)).materializedAt).toBeNull();
      await expect(svc.releaseBomRevision(w.actors.admin, ack(j))).resolves.toMatchObject({ noop: false });
    });

    it("refuses a line that already has components or steps from the old createJob path, and touches nothing", async () => {
      const w = await world("LEGACY");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      const unit = await owner.unit.findFirstOrThrow({ where: { equipmentId: j.equipmentId } });
      const comp = await owner.component.create({ data: { equipmentId: j.equipmentId, unitId: unit.id, tag: "OLD", componentTypeId: w.shl.id, jobId: j.jobId } });
      const before = await counts(j);
      await expect(svc.releaseBomRevision(w.actors.admin, ack(j))).rejects.toMatchObject({ code: "BOM_ALREADY_MATERIALIZED" });
      expect((await svc.previewBomRelease(w.actors.admin, j.target)).state).toBe("LEGACY_MATERIALIZED");
      expect(await counts(j)).toEqual(before);
      expect((await rev(j)).materializedAt).toBeNull();
      await owner.component.delete({ where: { id: comp.id } });
      // steps alone count too
      await owner.assemblyStep.create({ data: { unitId: unit.id, templateStepId: (await owner.assemblyTemplateStep.findFirstOrThrow({ where: { versionId: w.av.id } })).id, seq: 1, jobId: j.jobId } });
      await expect(svc.releaseBomRevision(w.actors.admin, ack(j))).rejects.toMatchObject({ code: "BOM_ALREADY_MATERIALIZED" });
    });

    it("releases a second revision as a diff once one is materialised (J5c; the diff classes are in bom-release-diff.test.ts)", async () => {
      const w = await world("DIFF");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      await svc.releaseBomRevision(w.actors.admin, ack(j));
      const rev2 = await owner.bomRevision.create({ data: { equipmentId: j.equipmentId, revisionNo: 2, status: "DRAFT", jobId: j.jobId } });
      const res = await svc.releaseBomRevision(w.actors.admin, { equipmentId: j.equipmentId, bomRevisionId: rev2.id, acknowledgeWarnings: true });
      expect(res.noop).toBe(false);
      expect((await owner.bomRevision.findUniqueOrThrow({ where: { id: rev2.id } })).materializedAt).not.toBeNull();
    });

    it("mapBomLines: draft only, this revision's lines only, a variant needs a family", async () => {
      const w = await world("MAP");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell" }] });
      const other = await w.job({ bom: [{ itemNo: 1, partName: "Other" }] });
      const line = j.items[0].id;
      await expect(svc.mapBomLines(w.actors.eng, { bomRevisionId: j.revisionId, lines: [{ bomItemId: other.items[0].id, componentTypeId: w.shl.id }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(svc.mapBomLines(w.actors.eng, { bomRevisionId: j.revisionId, lines: [{ bomItemId: line, componentTypeId: null, routeVariant: "B" }] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(svc.mapBomLines(w.actors.eng, { bomRevisionId: j.revisionId, lines: [{ bomItemId: line, componentTypeId: 2_000_000_000 }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(svc.mapBomLines(w.actors.eng, { bomRevisionId: j.revisionId, lines: [{ bomItemId: line, componentTypeId: w.shl.id, routeVariant: "b" }] } as never)).rejects.toThrow();
      await svc.releaseBomRevision(w.actors.eng, ack(j));
      await expect(svc.mapBomLines(w.actors.eng, { bomRevisionId: j.revisionId, lines: [{ bomItemId: line, componentTypeId: w.shl.id }] })).rejects.toMatchObject({ code: "BOM_ALREADY_MATERIALIZED" });
      const released = await w.job({ bom: [{ itemNo: 1, partName: "Shell" }] });
      await owner.bomRevision.update({ where: { id: released.revisionId }, data: { status: "RELEASED", releasedAt: new Date() } });
      await expect(svc.mapBomLines(w.actors.eng, { bomRevisionId: released.revisionId, lines: [{ bomItemId: released.items[0].id, componentTypeId: w.shl.id }] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  // ── mapping ───────────────────────────────────────────────────────────────
  describe("mapBomLines", () => {
    it("maps a line, audits the change, and is a no-op the second time", async () => {
      const w = await world("MAPOK");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell course" }] });
      const input = { bomRevisionId: j.revisionId, lines: [{ bomItemId: j.items[0].id, componentTypeId: w.shl.id, routeVariant: "B" }] };
      expect(await svc.mapBomLines(w.actors.eng, input)).toEqual({ updated: 1, unchanged: 0 });
      expect(await owner.bomItem.findUniqueOrThrow({ where: { id: j.items[0].id } })).toMatchObject({ componentTypeId: w.shl.id, routeVariant: "B" });
      expect(await svc.mapBomLines(w.actors.eng, input)).toEqual({ updated: 0, unchanged: 1 });
      const rows = await owner.auditLog.findMany({ where: { tenantId: w.tenantId, action: "bom.mapLines" } });
      expect(rows).toHaveLength(1);
      expect(rows[0].before).toEqual([{ bomItemId: j.items[0].id, componentTypeId: null, routeVariant: null }]);
    });

    it("suggests a part family for an unmapped line in the preview, and applies nothing", async () => {
      const w = await world("SUGGEST");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell course 1" }, { itemNo: 2, partName: "Totally unknown thing" }] });
      const p = await svc.previewBomRelease(w.actors.eng, j.target);
      expect(p.lines[0].suggestion).toMatchObject({ code: "SHL" });
      expect(p.lines[1].suggestion).toBeNull();
      expect((await owner.bomItem.findUniqueOrThrow({ where: { id: j.items[0].id } })).componentTypeId).toBeNull();
    });
  });

  // ── what a release makes ─────────────────────────────────────────────────
  describe("release", () => {
    it("makes components, operations (variant picked, rule applied), steps per scope and the QCP link, in one go", async () => {
      const w = await world("FULL");
      const j = await w.job({ units: 2, config: { pwht: false }, bom: [
        { itemNo: 1, partName: "Shell A", typeId: w.shl.id },               // no variant: lowest published letter A (cut + rule-gated weld)
        { itemNo: 2, partName: "Shell B", typeId: w.shl.id, variant: "B" }, // variant B (cut only)
        { itemNo: 3, partName: "Plate", typeId: w.plt.id, qtyPer: 4 },
      ] });
      await owner.plannedJoint.createMany({ data: ["NS-N1", "NS-N2", "NS-N3"].map((jointNo, i) => ({ jobId: j.jobId, equipmentId: j.equipmentId, jointNo, jointType: "NOZZLE" as const, source: "IMPORTED" as const, confirmed: true, sortOrder: i })) });

      const r = await svc.releaseBomRevision(w.actors.eng, ack(j));
      expect(r.noop).toBe(false);
      // 3 lines x 2 units
      expect(r.counts).toMatchObject({ components: 6, operations: 2 * (1 + 1 + 1), steps: 2 * (1 + 3 + 2 + 1), unmappedLines: 0 }); // A drops its weld (pwht false)
      expect(r.counts.stepsByScope).toEqual({ PER_UNIT: 2 * 2, PER_JOINT: 2 * 3, PER_COMPONENT: 2 * 2 }); // mark out + inspection, 3 nozzles, 2 shell courses, per unit

      const comps = await owner.component.findMany({ where: { equipmentId: j.equipmentId }, include: { operations: true, bomItem: true } });
      const byItem = (no: number) => comps.filter((c) => c.bomItem!.itemNo === no);
      expect(byItem(1).every((c) => c.pressureRetaining && c.operations.length === 1)).toBe(true);
      expect(byItem(2).every((c) => c.routeVersionId != null && c.operations.length === 1)).toBe(true);
      const routeB = await owner.routeTemplate.findFirstOrThrow({ where: { tenantId: w.tenantId, componentTypeId: w.shl.id, variant: "B" }, include: { versions: true } });
      expect(byItem(2).every((c) => c.routeVersionId === routeB.versions[0].id)).toBe(true);
      expect(byItem(1).every((c) => c.routeVersionId !== routeB.versions[0].id)).toBe(true);
      expect(byItem(3).flatMap((c) => c.operations.map((o) => o.qtyPlanned))).toEqual([4, 4]); // integer qtyPer -> planned quantity
      expect(byItem(1).flatMap((c) => c.operations.map((o) => o.qtyPlanned))).toEqual([1, 1]);

      // the rule dropped the weld of route A: one ledger row for that route step, plus the assembly step with a rule
      const ledger = await owner.configRuleDecision.findMany({ where: { jobId: j.jobId, entityType: { in: ["ROUTE_STEP", "ASSEMBLY_STEP"] } } });
      expect(ledger.filter((l) => l.entityType === "ROUTE_STEP")).toHaveLength(1);
      expect(ledger.filter((l) => l.entityType === "ASSEMBLY_STEP")).toHaveLength(1);
      expect(ledger.every((l) => l.included === false)).toBe(true);

      const steps = await owner.assemblyStep.findMany({ where: { jobId: j.jobId }, include: { templateStep: true } });
      const perUnit = steps.filter((s) => s.unitId === steps[0].unitId);
      expect(perUnit.map((s) => s.templateStep.activity).sort()).toEqual(["Final inspection", "Fit shell course", "Fit shell course", "Mark out", "Weld nozzle", "Weld nozzle", "Weld nozzle"].sort());
      // PER_COMPONENT steps point at this unit's own released components
      const fit = steps.filter((s) => s.templateStep.activity === "Fit shell course");
      expect(fit.every((s) => s.componentId != null)).toBe(true);
      for (const s of fit) expect(comps.find((c) => c.id === s.componentId)!.unitId).toBe(s.unitId);
      // PER_JOINT NOZZLE steps come from the weld map
      expect(steps.filter((s) => s.templateStep.activity === "Weld nozzle").map((s) => s.jointRef).sort()).toEqual(["NS-N1", "NS-N1", "NS-N2", "NS-N2", "NS-N3", "NS-N3"]);
      // QCP link
      const insp = steps.filter((s) => s.templateStep.kind === "INSPECTION");
      expect(insp.every((s) => s.qcpItemId != null)).toBe(true);
      expect(r.counts.boundToQcp).toBe(2);

      const after = await rev(j);
      expect(after).toMatchObject({ status: "RELEASED" });
      expect(after.releasedAt).not.toBeNull();
      expect(after.materializedAt).not.toBeNull();
      const row = await owner.auditLog.findFirstOrThrow({ where: { tenantId: w.tenantId, action: "bom.release", entityId: String(j.revisionId) } });
      expect(row.after).toMatchObject({ components: 6, steps: r.counts.steps, boundToQcp: 2 });
    });

    it("releasing the same revision again is a no-op that reports the same counts", async () => {
      const w = await world("TWICE");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      const first = await svc.releaseBomRevision(w.actors.admin, ack(j));
      const mid = await counts(j);
      const again = await svc.releaseBomRevision(w.actors.admin, ack(j));
      expect(again).toMatchObject({ noop: true });
      expect(again.counts).toMatchObject({ components: first.counts.components, operations: first.counts.operations, steps: first.counts.steps });
      expect({ ...(await counts(j)), audit: 0 }).toEqual({ ...mid, audit: 0 });
      expect(await owner.auditLog.count({ where: { tenantId: w.tenantId, action: "bom.release.noop" } })).toBe(1);
      expect(await owner.auditLog.count({ where: { tenantId: w.tenantId, action: "bom.release" } })).toBe(1);
    });

    it("two releases at once: one wins, the other sees it and does nothing", async () => {
      const w = await world("RACE");
      const j = await w.job({ units: 3, bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      const [a, b] = await Promise.all([svc.releaseBomRevision(w.actors.admin, ack(j)), svc.releaseBomRevision(w.actors.eng, ack(j))]);
      expect([a.noop, b.noop].sort()).toEqual([false, true]);
      expect((await counts(j)).components).toBe(3);
      expect(await owner.auditLog.count({ where: { tenantId: w.tenantId, action: "bom.release" } })).toBe(1);
    });

    it("an empty revision releases: the per-unit steps are made, with a warning for the missing QC plan", async () => {
      const w = await world("EMPTY");
      const j = await w.job({ withQcp: false, units: 2, config: { pwht: true } });
      const p = await svc.previewBomRelease(w.actors.admin, j.target);
      expect(p.state).toBe("READY");
      expect(p.warnings.map((x) => x.code)).toContain("NO_QCP");
      const r = await svc.releaseBomRevision(w.actors.admin, ack(j));
      expect(r.counts).toMatchObject({ components: 0, operations: 0, steps: 2 * 3, boundToQcp: 0 }); // mark out, final inspection, rule-gated step (pwht true)
      expect(r.counts.stepsByScope).toEqual({ PER_UNIT: 6 });
    });

    it("the preview is a release that rolls back: same counts, nothing written", async () => {
      const w = await world("PREVIEW");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }, { itemNo: 2, partName: "Plate", typeId: w.plt.id }] });
      const before = await counts(j);
      const p = await svc.previewBomRelease(w.actors.admin, j.target);
      expect(await counts(j)).toEqual(before);
      expect((await rev(j)).materializedAt).toBeNull();
      expect(p.state).toBe("READY");
      expect(p.lines.map((l) => [l.itemNo, l.approved, l.effectiveVariant, l.operations])).toEqual([[1, true, "A", 2], [2, true, "A", 1]]);
      const r = await svc.releaseBomRevision(w.actors.admin, ack(j));
      expect(r.counts).toEqual(p.counts);
      // and after the release the preview reports the stored result
      expect(await svc.previewBomRelease(w.actors.admin, j.target)).toMatchObject({ state: "ALREADY_RELEASED", counts: { components: r.counts.components, steps: r.counts.steps } });
    });

    it("warns about nozzle steps with no joints, an unconfirmed weld map, a kit part nobody mapped, and pressure parts without a drawing", async () => {
      const w = await world("WARNINGS");
      const type = await owner.equipmentTypeRef.create({ data: { tenantId: w.tenantId, familyId: w.family.id, code: "T-VERT", name: "Vertical" } });
      await owner.equipmentTypeComponent.create({ data: { tenantId: w.tenantId, equipmentTypeId: type.id, componentTypeId: w.shl.id, defaultQty: 1 } });
      await owner.equipmentTypeComponent.create({ data: { tenantId: w.tenantId, equipmentTypeId: type.id, componentTypeId: w.plt.id, defaultQty: 1 } });
      const j = await w.job({ equipmentTypeId: type.id, bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      const p = await svc.previewBomRelease(w.actors.admin, j.target);
      const by = Object.fromEntries(p.warnings.map((x) => [x.code, x]));
      expect(by.NO_JOINTS_FOR_STEPS.message).toMatch(/No nozzle joints on the weld map: those weld steps will not be created/);
      expect(by.KIT_COMPONENT_UNMAPPED.items).toEqual(["PLT"]);
      expect(by.H3_DATA_GAPS.message).toMatch(/2 pressure-retaining parts/);
      expect(by.WELD_MAP_UNCONFIRMED).toBeUndefined();
      expect(by.NO_QCP).toBeUndefined();
      await owner.plannedJoint.create({ data: { jobId: j.jobId, equipmentId: j.equipmentId, jointNo: "NS-N1", jointType: "NOZZLE", source: "IMPORTED", confirmed: false } });
      const q = await svc.previewBomRelease(w.actors.admin, j.target);
      expect(q.warnings.map((x) => x.code)).not.toContain("NO_JOINTS_FOR_STEPS");
      expect(q.warnings.find((x) => x.code === "WELD_MAP_UNCONFIRMED")!.message).toMatch(/^1 joint on the weld map is not confirmed/);
    });

    it("an inspection step keeps its place when a rule dropped an earlier checkpoint of the same number", async () => {
      const w = await world("QCPSKIP");
      // two srNo 5 checkpoints; the first (and the first srNo-5 step) only when PWHT
      await owner.assemblyTemplateStep.deleteMany({ where: { versionId: w.av.id } });
      await owner.assemblyTemplateStep.createMany({
        data: [
          { versionId: w.av.id, seq: 1, groupCode: "A", groupName: "A", srNo: "5", activity: "Check A", kind: "INSPECTION", defaultDepartmentId: w.dept.id, qcpSrNo: "5", includeWhen: pwht as never },
          { versionId: w.av.id, seq: 2, groupCode: "A", groupName: "A", srNo: "5", activity: "Check B", kind: "INSPECTION", defaultDepartmentId: w.dept.id, qcpSrNo: "5" },
        ],
      });
      await owner.qcpItem.update({ where: { id: (await owner.qcpItem.findFirstOrThrow({ where: { qcpTemplateId: w.qcp.id } })).id }, data: { includeWhen: pwht as never } });
      await owner.qcpItem.create({ data: { tenantId: w.tenantId, qcpTemplateId: w.qcp.id, sequence: 2, srNo: "5", kind: "CHECKPOINT", activity: "qcp 5 second" } });
      const j = await w.job({ config: { pwht: false }, units: 1 });
      const r = await svc.releaseBomRevision(w.actors.admin, ack(j));
      expect(r.counts.steps).toBe(1);
      const step = await owner.assemblyStep.findFirstOrThrow({ where: { jobId: j.jobId }, include: { qcpItem: true } });
      expect(step.qcpItem).toMatchObject({ srNo: "5", sequence: 2 }); // the second checkpoint, not a failure to resolve
    });

    it("requiresQc matches what the old createJob path produced for the same line (components, operations, steps)", async () => {
      const w = await world("PARITY");
      const bom: Bom[] = [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }, { itemNo: 2, partName: "Plate", typeId: w.plt.id }];
      const j = await w.job({ units: 2, config: { pwht: true }, bom });
      await owner.plannedJoint.createMany({ data: ["NS-N1", "NS-N2"].map((jointNo, i) => ({ jobId: j.jobId, equipmentId: j.equipmentId, jointNo, jointType: "NOZZLE" as const, source: "IMPORTED" as const, sortOrder: i })) });
      await svc.releaseBomRevision(w.actors.admin, ack(j));

      // the old createJob sequence on a second, identical line: components first, then the assembly steps
      const old = await w.job({ units: 2, config: { pwht: true }, bom });
      await owner.plannedJoint.createMany({ data: ["NS-N1", "NS-N2"].map((jointNo, i) => ({ jobId: old.jobId, equipmentId: old.equipmentId, jointNo, jointType: "NOZZLE" as const, source: "IMPORTED" as const, sortOrder: i })) });
      const oldUnits = await owner.unit.findMany({ where: { equipmentId: old.equipmentId }, orderBy: { id: "asc" } });
      const qcpOld = await owner.qcpTemplate.findFirstOrThrow({ where: { jobId: old.jobId } });
      await withTenant(w.tenantId, async (tx) => {
        await materializeComponentsFromBomItems(tx, w.family.id, old.equipmentId, old.items.map((i) => i.id), old.jobId);
        const rules = await LineRules.load(tx, old.equipmentId);
        await materializeAssemblyStepsFromTemplate(tx, w.tenantId, old.jobId, w.family.id, oldUnits.map((u) => u.id), qcpOld.id, null, rules, [], old.equipmentId, { pwht: true });
      });

      const shape = async (x: J) => ({
        ops: (await owner.componentOperation.findMany({ where: { jobId: x.jobId }, include: { component: { include: { bomItem: true } } } }))
          .map((o) => `${o.component.bomItem!.itemNo}:${o.seq}:${o.requiresQc}`).sort(),
        steps: (await owner.assemblyStep.findMany({ where: { jobId: x.jobId }, include: { templateStep: true } }))
          .map((s) => `${s.templateStep.seq}:${s.seq}:${s.requiresQc}:${s.role ?? ""}:${s.pressurePart}:${s.jointRef ?? ""}`).sort(),
      });
      const a = await shape(j);
      expect(a.ops.length).toBeGreaterThan(0);
      expect(a.steps.length).toBeGreaterThan(0);
      expect(a).toEqual(await shape(old));
    });
  });
  // ── J5b: the release screen's start, import and view ─────────────────────
  describe("J5b: start revision, import waits for release, release view", () => {
    /** A job whose line has no BOM revision at all: the shape right after createJob without a copied BOM. */
    async function bare(w: World) {
      const j = await w.job();
      await owner.bomRevision.delete({ where: { id: j.revisionId } });
      return j;
    }
    const loose = (j: J, itemNo: number, partName: string, typeId: number | null = null) =>
      owner.bomItem.create({ data: { jobId: j.jobId, equipmentId: j.equipmentId, bomRevisionId: null, itemNo, partName, sourceQty: "1 NOS.", qtyPer: 1, uom: "NOS.", componentTypeId: typeId } });

    it.each([
      ["SUPERVISOR", "sup"],
      ["QC", "qc"],
      ["PLANNER", "planner"],
      ["a client user", "client"],
    ] as const)("refuses %s starting a revision and writes nothing", async (_l, who) => {
      const w = await world("STARTROLE");
      const j = await bare(w);
      await expect(svc.startBomRevision(w.actors[who], { equipmentId: j.equipmentId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await owner.bomRevision.count({ where: { equipmentId: j.equipmentId } })).toBe(0);
    });

    it("does not start a revision on another tenant's line", async () => {
      const a = await world("STARTTA");
      const b = await world("STARTTB");
      const j = await bare(a);
      await expect(svc.startBomRevision(b.actors.admin, { equipmentId: j.equipmentId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("starts revision 1 and moves the line's revision-less BOM lines into it; again it only moves any new loose line", async () => {
      const w = await world("START");
      const j = await bare(w);
      await loose(j, 1, "Shell");
      await loose(j, 2, "Plate");
      const r = await svc.startBomRevision(w.actors.eng, { equipmentId: j.equipmentId });
      expect(r).toMatchObject({ revisionNo: 1, created: true, moved: 2 });
      expect(await owner.bomItem.count({ where: { equipmentId: j.equipmentId, bomRevisionId: r.bomRevisionId } })).toBe(2);
      expect(await owner.auditLog.count({ where: { tenantId: w.tenantId, action: "bom.moveToRevision" } })).toBe(1);

      await loose(j, 3, "Late addition");
      const again = await svc.startBomRevision(w.actors.eng, { equipmentId: j.equipmentId });
      expect(again).toMatchObject({ bomRevisionId: r.bomRevisionId, created: false, moved: 1 });
      expect(await owner.bomRevision.count({ where: { equipmentId: j.equipmentId } })).toBe(1);
      expect(await svc.startBomRevision(w.actors.eng, { equipmentId: j.equipmentId })).toMatchObject({ created: false, moved: 0 });
    });

    it("refuses to start a revision on a legacy line (BOM_ALREADY_MATERIALIZED); on a released line it starts revision 2 as a copy (J5c)", async () => {
      const w = await world("STARTREF");
      const legacy = await bare(w);
      await releaseJobBoms(owner, w.actors.admin, legacy.jobId); // floor rows exist now, the revision it made is materialised
      await owner.bomRevision.updateMany({ where: { equipmentId: legacy.equipmentId }, data: { materializedAt: null } }); // the pre-J5a shape: floor rows, no revision released
      await expect(svc.startBomRevision(w.actors.admin, { equipmentId: legacy.equipmentId })).rejects.toMatchObject({ code: "BOM_ALREADY_MATERIALIZED" });

      const released = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      await svc.releaseBomRevision(w.actors.admin, ack(released));
      const next = await svc.startBomRevision(w.actors.admin, { equipmentId: released.equipmentId });
      expect(next).toMatchObject({ revisionNo: 2, created: true });
      expect(next.copied).toBeGreaterThan(0);
    });

    it("the preview of a released revision still lists its lines, with the stored counts", async () => {
      const w = await world("RELLINES");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }, { itemNo: 2, partName: "Plate", typeId: w.plt.id }] });
      const r = await svc.releaseBomRevision(w.actors.eng, ack(j));
      const p = await svc.previewBomRelease(w.actors.eng, j.target);
      expect(p.state).toBe("ALREADY_RELEASED");
      expect(p.lines.map((l) => l.itemNo)).toEqual([1, 2]);
      expect(p.counts).toMatchObject({ components: r.counts.components, steps: r.counts.steps });
    });

    it("an import with no revision on a line with no floor rows waits in a draft revision and makes no components; the release then makes them", async () => {
      const w = await world("IMPORTWAIT");
      const j = await bare(w);
      const r = await bomSvc.importBomItems(w.actors.admin, { equipmentId: j.equipmentId, rows: [{ itemNo: 1, partName: "Shell", sourceQty: "2 NOS.", componentType: "SHL" }, { itemNo: 2, partName: "Plate", sourceQty: "1 NOS." }] } as never);
      expect(r).toMatchObject({ waitsForRelease: true, bomRevisionNo: 1, componentCount: 0 });
      expect(r.created).toHaveLength(2);
      const revision = await owner.bomRevision.findFirstOrThrow({ where: { equipmentId: j.equipmentId } });
      expect(revision).toMatchObject({ revisionNo: 1, status: "DRAFT", materializedAt: null });
      expect(r.created.every((i) => i.bomRevisionId === revision.id)).toBe(true);
      expect(await owner.component.count({ where: { equipmentId: j.equipmentId } })).toBe(0);
      expect(await owner.assemblyStep.count({ where: { jobId: j.jobId } })).toBe(0);

      const res = await svc.releaseBomRevision(w.actors.admin, { equipmentId: j.equipmentId, bomRevisionId: revision.id, acknowledgeWarnings: true });
      expect(res.counts.components).toBeGreaterThan(0);
      // J5c: the line is released now, so a later import goes into a new draft revision 2 and waits for its release (a diff)
      const later = await bomSvc.importBomItems(w.actors.admin, { equipmentId: j.equipmentId, rows: [{ itemNo: 9, partName: "Extra", sourceQty: "1 NOS." }] } as never);
      expect(later).toMatchObject({ waitsForRelease: true, bomRevisionNo: 2 });
    });

    it("an import into a released line waits in a new draft revision and makes no components until it is released (J5c)", async () => {
      const w = await world("IMPORTRELEASED");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      await svc.releaseBomRevision(w.actors.admin, ack(j));
      const componentsBefore = await owner.component.count({ where: { equipmentId: j.equipmentId } });
      const r = await bomSvc.importBomItems(w.actors.admin, { equipmentId: j.equipmentId, rows: [{ itemNo: 5, partName: "Shell 2", sourceQty: "1 NOS.", componentType: "SHL" }] } as never);
      expect(r).toMatchObject({ waitsForRelease: true, bomRevisionNo: 2, componentCount: 0 });
      expect(await owner.component.count({ where: { equipmentId: j.equipmentId } })).toBe(componentsBefore);
    });

    it("an import into a legacy line (floor rows, no released revision) keeps today's behaviour: no revision, components made at once", async () => {
      const w = await world("IMPORTLEGACY");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      await svc.releaseBomRevision(w.actors.admin, ack(j));
      // make it legacy: the floor rows stay, the line has no materialised revision (as DESPL-320 and every job before J5a)
      await owner.bomRevision.updateMany({ where: { equipmentId: j.equipmentId }, data: { materializedAt: null } });
      await owner.bomItem.updateMany({ where: { equipmentId: j.equipmentId }, data: { bomRevisionId: null } });
      await owner.bomRevision.deleteMany({ where: { equipmentId: j.equipmentId } });
      const revisionsBefore = await owner.bomRevision.count({ where: { equipmentId: j.equipmentId } });
      const r = await bomSvc.importBomItems(w.actors.admin, { equipmentId: j.equipmentId, rows: [{ itemNo: 5, partName: "Shell 2", sourceQty: "1 NOS.", componentType: "SHL" }] } as never);
      expect(r).toMatchObject({ waitsForRelease: false });
      expect(r.created[0].bomRevisionId).toBeNull();
      expect(r.componentCount).toBeGreaterThan(0);
      expect(await owner.bomRevision.count({ where: { equipmentId: j.equipmentId } })).toBe(revisionsBefore);
    });

    it("the seeded jobs (DESPL-320, DE0467, 12548) are untouched: their lines read as already on the floor and starting a revision is refused", async () => {
      // The seeded demo tenant only: other tests make their own disposable tenants and may reuse these job numbers.
      const admin = await owner.user.findFirstOrThrow({ where: { email: "admin@despl.local" } });
      const seeded = await owner.job.findMany({ where: { tenantId: admin.tenantId, jobNumber: { in: ["DESPL-320", "DE0467", "12548"] } }, select: { id: true, jobNumber: true, tenantId: true } });
      expect(seeded.map((j) => j.jobNumber)).toContain("DESPL-320");
      for (const job of seeded) {
        const actor = { userId: admin.id, tenantId: job.tenantId, clientId: null, name: "x", email: admin.email, roles: ["ADMIN"], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false } as never;
        const view = await read.loadBomReleaseView(actor, job.id);
        const withFloor = view.lines.filter((l) => l.legacy);
        expect(withFloor.length, job.jobNumber).toBeGreaterThan(0);
        const before = await owner.bomItem.count({ where: { jobId: job.id } });
        for (const l of withFloor) {
          await expect(svc.startBomRevision(actor, { equipmentId: l.id })).rejects.toMatchObject({ code: "BOM_ALREADY_MATERIALIZED" });
        }
        expect(await owner.bomItem.count({ where: { jobId: job.id } })).toBe(before);
      }
    });

    it("loadBomReleaseView: lines, revisions, loose lines and part families; only release roles can release; clients are refused", async () => {
      const w = await world("VIEW");
      const j = await w.job({ bom: [{ itemNo: 1, partName: "Shell", typeId: w.shl.id }] });
      await loose(j, 7, "Loose");
      const v = await read.loadBomReleaseView(w.actors.planner, j.jobId);
      expect(v.canRelease).toBe(false);
      expect((await read.loadBomReleaseView(w.actors.eng, j.jobId)).canRelease).toBe(true);
      expect(v.lines).toHaveLength(1);
      expect(v.lines[0]).toMatchObject({ id: j.equipmentId, legacy: false, looseItems: 1, revisions: [{ id: j.revisionId, revisionNo: 1, status: "DRAFT", items: 1 }] });
      const byCode = Object.fromEntries(v.families.map((f) => [f.code, f.approved]));
      expect(byCode).toMatchObject({ SHL: true, DRF: false, PLT: true });
      await expect(read.loadBomReleaseView(w.actors.client, j.jobId)).rejects.toMatchObject({ code: "FORBIDDEN" });
      const other = await world("VIEWB");
      await expect(read.loadBomReleaseView(other.actors.admin, j.jobId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
