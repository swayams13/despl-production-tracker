import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * J5c: re-releasing a BOM revision (and checking a weld-map / answer change on the current one) reconciles the
 * line's floor rows with the revision: not-started rows are updated or retired, started ones flagged, nothing is
 * deleted. Refusals first, then each diff class. Every fixture is its own disposable tenant (owner client bypasses
 * RLS). Gated behind RUN_DB_TESTS.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("BOM re-release diff (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const svc = await import("./bom-release.service");
  const review = await import("./bom-review.service");
  const bomSvc = await import("./bom.service");
  const { makeWorldKit } = await import("./bom-release.world.test-util");
  const { assertKitReady } = await import("./_shared");
  const { recordWork } = await import("./work.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const { world } = makeWorldKit(owner);

  afterAll(async () => {
    await owner.$disconnect();
  });
  // Several releases per case on a shared dev database: give the slow ones room.
  vi.setConfig({ testTimeout: 120_000 });

  const SHELL = { itemNo: 1, partName: "Shell", qtyPer: 1 };
  const PLATE = { itemNo: 2, partName: "Plate", qtyPer: 1 };

  /** A world with a released revision 1 holding a shell (family SHL) and a plate (raw form). */
  async function released(label: string, opts: { units?: number; config?: Record<string, unknown> | null } = {}) {
    const w = await world(label);
    const j = await w.job({
      units: opts.units ?? 2,
      config: opts.config ?? null,
      bom: [{ ...SHELL, typeId: w.shl.id }, { ...PLATE, typeId: w.plt.id }],
    });
    const r1 = await svc.releaseBomRevision(w.actors.admin, { ...j.target, acknowledgeWarnings: true });
    return { w, j, r1 };
  }
  type R = Awaited<ReturnType<typeof released>>;

  /** Revision 2: started by Engineering (a copy of revision 1); returns its lines by item number. */
  async function startNext(r: R) {
    const s = await svc.startBomRevision(r.w.actors.eng, { equipmentId: r.j.equipmentId });
    const items = await owner.bomItem.findMany({ where: { bomRevisionId: s.bomRevisionId }, orderBy: { itemNo: "asc" } });
    return { ...s, byNo: new Map(items.map((i) => [i.itemNo, i])) };
  }
  const release = (r: R, bomRevisionId: number, who: "eng" | "admin" | "sj" = "eng") =>
    svc.releaseBomRevision(r.w.actors[who], { equipmentId: r.j.equipmentId, bomRevisionId, acknowledgeWarnings: true });
  const comps = (r: R, retired?: boolean) =>
    owner.component.findMany({ where: { equipmentId: r.j.equipmentId, ...(retired === undefined ? {} : { retiredAt: retired ? { not: null } : null }) }, orderBy: [{ unitId: "asc" }, { id: "asc" }], include: { operations: { orderBy: { seq: "asc" } } } });
  const steps = (r: R, retired = false) =>
    owner.assemblyStep.findMany({ where: { unit: { equipmentId: r.j.equipmentId }, retiredAt: retired ? { not: null } : null }, orderBy: [{ unitId: "asc" }, { seq: "asc" }] });
  const totals = async (r: R) => ({
    components: await owner.component.count({ where: { equipmentId: r.j.equipmentId } }),
    ops: await owner.componentOperation.count({ where: { jobId: r.j.jobId } }),
    steps: await owner.assemblyStep.count({ where: { jobId: r.j.jobId } }),
  });
  const auditOf = (r: R, action: string) => owner.auditLog.findMany({ where: { tenantId: r.w.tenantId, action }, orderBy: { id: "desc" } });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
    return null;
  };

  describe("refusals", () => {
    it("an older revision is refused BOM_REVISION_NOT_INCREASING and nothing changes", async () => {
      const r = await released("OLDER");
      const n = await startNext(r);
      await release(r, n.bomRevisionId);
      const before = await totals(r);
      expect(await code(release(r, r.j.revisionId))).toBe("BOM_REVISION_NOT_INCREASING");
      expect(await totals(r)).toEqual(before);
      expect((await svc.previewBomRelease(r.w.actors.eng, { equipmentId: r.j.equipmentId, bomRevisionId: r.j.revisionId })).state).toBe("SUPERSEDED");
    });

    it("a line made before the BOM release (floor rows, no materialised revision) is still refused BOM_ALREADY_MATERIALIZED, and its BOM is untouched", async () => {
      const w = await world("LEGACY");
      const j = await w.job({ bom: [{ ...SHELL, typeId: w.shl.id }] });
      const type = await owner.componentTypeRef.findFirstOrThrow({ where: { id: w.shl.id } });
      const unit = await owner.unit.findFirstOrThrow({ where: { equipmentId: j.equipmentId } });
      await owner.component.create({ data: { jobId: j.jobId, equipmentId: j.equipmentId, unitId: unit.id, tag: "LEGACY", componentTypeId: type.id } });
      expect(await code(svc.releaseBomRevision(w.actors.admin, { ...j.target, acknowledgeWarnings: true }))).toBe("BOM_ALREADY_MATERIALIZED");
      expect(await code(svc.startBomRevision(w.actors.eng, { equipmentId: j.equipmentId }))).toBe("BOM_ALREADY_MATERIALIZED");
      expect((await svc.previewBomRelease(w.actors.admin, j.target)).state).toBe("LEGACY_MATERIALIZED");
      expect(await owner.component.count({ where: { equipmentId: j.equipmentId } })).toBe(1);
      expect(await owner.component.count({ where: { equipmentId: j.equipmentId, retiredAt: { not: null } } })).toBe(0);
    });

    it("an import or edit goes to the next revision, never into a released one or straight to the floor", async () => {
      const r = await released("IMPORT");
      const before = await totals(r);
      // explicit import into the released revision, and edits of its lines
      expect(await code(bomSvc.importBomItems(r.w.actors.admin, { equipmentId: r.j.equipmentId, bomRevisionId: r.j.revisionId, rows: [{ itemNo: 9, partName: "X", qty: "1 NOS." }] } as never))).toBe("BOM_ALREADY_MATERIALIZED");
      expect(await code(bomSvc.updateBomItem(r.w.actors.admin, r.j.items[0].id, { partName: "Renamed" } as never))).toBe("BOM_ALREADY_MATERIALIZED");
      expect(await code(bomSvc.createBomItem(r.w.actors.admin, { equipmentId: r.j.equipmentId, bomRevisionId: r.j.revisionId, itemNo: 9, partName: "X", sourceQty: "1" } as never))).toBe("BOM_ALREADY_MATERIALIZED");
      // an import with no revision lands in a new draft that waits for release: no component is made
      const res = await bomSvc.importBomItems(r.w.actors.admin, { equipmentId: r.j.equipmentId, rows: [{ itemNo: 9, partName: "New part", qty: "1 NOS." }] } as never);
      expect(res).toMatchObject({ waitsForRelease: true, componentCount: 0, bomRevisionNo: 2 });
      expect(await totals(r)).toEqual(before);
      const lines = await owner.bomItem.findMany({ where: { bomRevision: { equipmentId: r.j.equipmentId, revisionNo: 2 } } });
      expect(lines.map((l) => l.itemNo).sort()).toEqual([1, 2, 9]); // a copy of revision 1 plus the import
      expect(await owner.bomItem.count({ where: { bomRevisionId: r.j.revisionId } })).toBe(2); // revision 1 untouched
    });

    it("roles: Engineering and the Production Head and Admin release a revision; planner, QC, supervisor and client users are refused", async () => {
      const r = await released("ROLES");
      for (const who of ["planner", "qc", "sup", "client"] as const) {
        expect(await code(svc.startBomRevision(r.w.actors[who], { equipmentId: r.j.equipmentId }))).toBe("FORBIDDEN");
      }
      const n = await startNext(r);
      for (const who of ["planner", "qc", "sup", "client"] as const) {
        expect(await code(release(r, n.bomRevisionId, who as never))).toBe("FORBIDDEN");
      }
      await expect(release(r, n.bomRevisionId, "sj")).resolves.toMatchObject({ noop: false });
    });
  });

  describe("diff classes", () => {
    it("a resync with no change is a no-op: nothing written, bom.release.noop audited", async () => {
      const r = await released("NOOP");
      const before = await totals(r);
      const noops = (await auditOf(r, "bom.release.noop")).length;
      const out = await svc.releaseBomRevision(r.w.actors.eng, { ...r.j.target, acknowledgeWarnings: true });
      expect(out.noop).toBe(true);
      expect(await totals(r)).toEqual(before);
      expect((await auditOf(r, "bom.release.noop")).length).toBe(noops + 1);
      expect((await svc.previewBomRelease(r.w.actors.eng, r.j.target)).state).toBe("ALREADY_RELEASED");
    });

    it("a new line adds a part per unit with its operations; revision 2 becomes the released one; the audit row carries the diff", async () => {
      const r = await released("ADD", { units: 2 });
      const n = await startNext(r);
      await owner.bomItem.create({ data: { jobId: r.j.jobId, equipmentId: r.j.equipmentId, bomRevisionId: n.bomRevisionId, itemNo: 3, partName: "Plate 2", sourceQty: "1 NOS.", qtyPer: 1, uom: "NOS.", componentTypeId: r.w.plt.id } });
      const preview = await svc.previewBomRelease(r.w.actors.eng, { equipmentId: r.j.equipmentId, bomRevisionId: n.bomRevisionId });
      expect(preview.state).toBe("DIFF");
      expect(preview.diff!.counts.component.add).toBe(2);
      expect(await owner.component.count({ where: { equipmentId: r.j.equipmentId } })).toBe(4); // the preview rolled back
      const out = await release(r, n.bomRevisionId);
      expect(out.diff!.component.add).toBe(2);
      expect(out.diff!.operation.add).toBe(2);
      expect((await comps(r, false)).map((c) => c.tag).sort()).toEqual(["Plate", "Plate", "Plate 2", "Plate 2", "Shell", "Shell"]);
      const revs = await owner.bomRevision.findMany({ where: { equipmentId: r.j.equipmentId }, orderBy: { revisionNo: "asc" } });
      expect(revs.map((x) => [x.revisionNo, x.status, x.materializedAt != null])).toEqual([[1, "DRAFT", true], [2, "RELEASED", true]]);
      const audit = (await auditOf(r, "bom.release"))[0];
      expect((audit.after as { diff: { counts: unknown; rows: unknown[] } }).diff.rows.length).toBeGreaterThan(0);
    });

    it("a not-started part whose quantity or name changed is updated in place, with before and after in the diff", async () => {
      const r = await released("UPD");
      const n = await startNext(r);
      await owner.bomItem.update({ where: { id: n.byNo.get(1)!.id }, data: { qtyPer: 3, sourceQty: "3 NOS.", partName: "Shell A" } });
      const before = await comps(r, false);
      const out = await release(r, n.bomRevisionId);
      const after = await comps(r, false);
      expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id)); // same rows
      const shell = after.filter((c) => c.tag === "Shell A");
      expect(shell).toHaveLength(2);
      expect(shell.every((c) => c.bomItemId === n.byNo.get(1)!.id)).toBe(true); // follows the new line
      expect(shell[0].operations.every((o) => o.qtyPlanned === 3)).toBe(true);
      expect(out.diff!.component.update).toBe(2);
      const rows = ((await auditOf(r, "bom.release"))[0].after as { diff: { rows: { class: string; fields: { field: string; from: unknown; to: unknown }[] }[] } }).diff.rows;
      expect(rows.find((x) => x.class === "update")!.fields).toEqual(expect.arrayContaining([{ field: "quantity", from: 1, to: 3 }, { field: "partName", from: "Shell", to: "Shell A" }]));
    });

    it("a not-started part whose line is gone is retired with its operations (reason 'removed in BOM rev 2'), never deleted", async () => {
      const r = await released("GONE");
      const before = await totals(r);
      const n = await startNext(r);
      await owner.bomItem.delete({ where: { id: n.byNo.get(2)!.id } });
      const out = await release(r, n.bomRevisionId);
      expect(out.diff!.component.retire).toBe(2);
      expect(await totals(r)).toEqual(before); // every row still exists
      const gone = await comps(r, true);
      expect(gone).toHaveLength(2);
      expect(gone.every((c) => c.retiredReason === "removed in BOM rev 2" && c.operations.every((o) => o.retiredAt != null && o.retiredReason === "removed in BOM rev 2"))).toBe(true);
      expect((await comps(r, false)).map((c) => c.tag)).toEqual(["Shell", "Shell"]);
    });

    it("a started part whose line is gone or changed is never retired: its operations are flagged and it stays on the floor", async () => {
      const r = await released("STARTED");
      const plateOp = (await comps(r, false)).filter((c) => c.tag === "Plate")[0].operations[0];
      await owner.componentOperation.update({ where: { id: plateOp.id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
      const shellOp = (await comps(r, false)).filter((c) => c.tag === "Shell")[1].operations[0];
      await owner.componentOperation.update({ where: { id: shellOp.id }, data: { status: "COMPLETE", startedAt: new Date(), finishedAt: new Date() } });
      const n = await startNext(r);
      await owner.bomItem.delete({ where: { id: n.byNo.get(2)!.id } });
      await owner.bomItem.update({ where: { id: n.byNo.get(1)!.id }, data: { qtyPer: 2, sourceQty: "2 NOS." } });
      const out = await release(r, n.bomRevisionId);
      expect(out.diff!.component.review).toBe(2); // the started plate (gone) and the started shell (changed)
      expect(out.diff!.component.retire).toBe(1); // the other plate was not started
      const live = await comps(r, false);
      const startedPlate = live.find((c) => c.operations.some((o) => o.id === plateOp.id))!;
      expect(startedPlate.retiredAt).toBeNull();
      expect(startedPlate.operations.every((o) => o.needsReview)).toBe(true);
      const startedShell = live.find((c) => c.operations.some((o) => o.id === shellOp.id))!;
      expect(startedShell.operations.every((o) => o.needsReview)).toBe(true);
      // the unstarted shell was updated in place, not flagged
      const idleShell = live.find((c) => c.tag === "Shell" && c.id !== startedShell.id)!;
      expect(idleShell.operations.every((o) => !o.needsReview && o.qtyPlanned === 2)).toBe(true);
    });

    it("a part with an issue or a picked heat counts as started even if no operation has started", async () => {
      const r = await released("ISSUED");
      const shell = (await comps(r, false)).find((c) => c.tag === "Shell")!;
      const bom = await owner.bomItem.findFirstOrThrow({ where: { id: shell.bomItemId! } });
      const lot = await owner.stockLot.create({ data: { jobId: r.j.jobId, bomItemId: bom.id, heatNumber: "H1", location: "Y1", qty: "5" } });
      const user = await owner.user.findFirstOrThrow({ where: { tenantId: r.w.tenantId } });
      await owner.stockTxn.create({ data: { jobId: r.j.jobId, stockLotId: lot.id, type: "ISSUE", qty: "1", by: user.id, componentId: shell.id } });
      const n = await startNext(r);
      await owner.bomItem.delete({ where: { id: n.byNo.get(1)!.id } });
      await release(r, n.bomRevisionId);
      const kept = await owner.component.findUniqueOrThrow({ where: { id: shell.id }, include: { operations: true } });
      expect(kept.retiredAt).toBeNull();
      expect(kept.operations.every((o) => o.needsReview)).toBe(true);
    });

    it("stock received against a revision-1 line still satisfies kit-ready after the part follows the revision-2 line", async () => {
      const r = await released("STOCK");
      const shell = (await comps(r, false)).find((c) => c.tag === "Shell")!;
      await owner.stockLot.create({ data: { jobId: r.j.jobId, bomItemId: shell.bomItemId!, location: "Y1", qty: "5" } });
      const n = await startNext(r);
      await owner.bomItem.update({ where: { id: n.byNo.get(1)!.id }, data: { remarks: "rev 2" } });
      await release(r, n.bomRevisionId);
      const after = await owner.component.findUniqueOrThrow({ where: { id: shell.id } });
      expect(after.bomItemId).toBe(n.byNo.get(1)!.id);
      await expect(withTenant(r.w.tenantId, (tx) => assertKitReady(tx, shell.id, r.w.tenantId))).resolves.toBeUndefined();
    });
  });

  describe("assembly steps and the weld map", () => {
    const addJoints = (r: R, joints: [string, "NOZZLE" | "ATTACHMENT" | "LONG_SEAM"][]) =>
      owner.plannedJoint.createMany({ data: joints.map(([jointNo, jointType], i) => ({ jobId: r.j.jobId, equipmentId: r.j.equipmentId, jointNo, jointType, source: "IMPORTED" as const, confirmed: true, sortOrder: i })) });
    const seqsOf = async (r: R) => {
      const out = new Map<number, number[]>();
      for (const s of await steps(r)) out.set(s.unitId, [...(out.get(s.unitId) ?? []), s.seq]);
      return out;
    };

    it("a joint added to the weld map adds a PER_JOINT step per unit; the seqs are renumbered without a collision and started steps keep their status", async () => {
      const r = await released("JOINTADD", { units: 2 });
      const markOut = (await steps(r)).filter((x) => x.seq === 1);
      await owner.assemblyStep.update({ where: { id: markOut[0].id }, data: { status: "COMPLETE", startedAt: new Date(), finishedAt: new Date() } });
      const before = (await steps(r)).length;
      await addJoints(r, [["N1", "NOZZLE"], ["N2", "NOZZLE"]]);
      const preview = await svc.previewBomRelease(r.w.actors.eng, r.j.target);
      expect(preview.state).toBe("DIFF");
      expect(preview.diff!.counts.step.add).toBe(4);
      expect((await steps(r)).length).toBe(before); // the preview rolled back
      const out = await svc.releaseBomRevision(r.w.actors.eng, { ...r.j.target, acknowledgeWarnings: true });
      expect(out).toMatchObject({ noop: false });
      expect(out.diff!.step.add).toBe(4);
      expect((await steps(r)).length).toBe(before + 4);
      for (const [, seqs] of await seqsOf(r)) {
        expect(new Set(seqs).size).toBe(seqs.length); // unique among active rows
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(Math.min(...seqs)).toBeGreaterThan(0);
      }
      const nozzle = await owner.assemblyStep.findMany({ where: { unit: { equipmentId: r.j.equipmentId }, jointRef: { in: ["N1", "N2"] } }, orderBy: [{ unitId: "asc" }, { seq: "asc" }] });
      expect(nozzle).toHaveLength(4);
      expect(nozzle.every((x) => x.plannedJointId != null && x.status === "NOT_STARTED")).toBe(true);
      const started = await owner.assemblyStep.findUniqueOrThrow({ where: { id: markOut[0].id } });
      expect(started).toMatchObject({ status: "COMPLETE", retiredAt: null, seq: 1 });
      // the same check again changes nothing
      expect((await svc.releaseBomRevision(r.w.actors.eng, { ...r.j.target, acknowledgeWarnings: true })).noop).toBe(true);
    });

    it("a joint whose type changes retires its not-started step and flags a started one", async () => {
      const r = await released("JOINTTYPE", { units: 1 });
      await addJoints(r, [["N1", "NOZZLE"], ["N2", "NOZZLE"]]);
      await svc.releaseBomRevision(r.w.actors.eng, { ...r.j.target, acknowledgeWarnings: true });
      const n2 = await owner.assemblyStep.findFirstOrThrow({ where: { unit: { equipmentId: r.j.equipmentId }, jointRef: "N2", retiredAt: null } });
      await owner.assemblyStep.update({ where: { id: n2.id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
      await owner.plannedJoint.updateMany({ where: { equipmentId: r.j.equipmentId }, data: { jointType: "ATTACHMENT" } });
      const out = await svc.releaseBomRevision(r.w.actors.eng, { ...r.j.target, acknowledgeWarnings: true });
      expect(out.diff!.step.retire).toBe(1);
      expect(out.diff!.step.review).toBe(1);
      const n1 = await owner.assemblyStep.findFirstOrThrow({ where: { unit: { equipmentId: r.j.equipmentId }, jointRef: "N1" } });
      expect(n1.retiredAt).not.toBeNull();
      expect(await owner.assemblyStep.findUniqueOrThrow({ where: { id: n2.id } })).toMatchObject({ retiredAt: null, needsReview: true, status: "IN_PROGRESS" });
    });

    it("an answer change that drops a route step retires its not-started operation and the rule-gated assembly step", async () => {
      const r = await released("ANSWER", { units: 1, config: { pwht: true } });
      const weld = () => owner.componentOperation.findMany({ where: { jobId: r.j.jobId, operationId: r.w.opWeld.id, retiredAt: null } });
      expect(await weld()).toHaveLength(1);
      const stepsBefore = (await steps(r)).length;
      await owner.equipment.update({ where: { id: r.j.equipmentId }, data: { config: { pwht: false } } });
      const out = await svc.releaseBomRevision(r.w.actors.eng, { ...r.j.target, acknowledgeWarnings: true });
      expect(await weld()).toHaveLength(0);
      expect(out.diff!.operation.retire).toBe(1);
      expect(out.diff!.step.retire).toBe(1);
      expect((await steps(r)).length).toBe(stepsBefore - 1);
    });

    it("template and route versions stay as the line was pinned (invariant 9); a changed family picks the new route", async () => {
      const r = await released("PINNED", { units: 1 });
      const eq = await owner.equipment.findUniqueOrThrow({ where: { id: r.j.equipmentId } });
      const shellRoute = await owner.routeTemplate.findFirstOrThrow({ where: { componentTypeId: r.w.shl.id, variant: "A" } });
      const v2 = await owner.routeTemplateVersion.create({ data: { routeId: shellRoute.id, version: 2, status: "PUBLISHED" } });
      await owner.routeStep.create({ data: { routeVersionId: v2.id, seq: 10, operationId: r.w.opCut.id } });
      await owner.routeStep.create({ data: { routeVersionId: v2.id, seq: 30, operationId: r.w.opWeld.id } });
      const av2 = await owner.assemblyTemplateVersion.create({ data: { templateId: (await owner.assemblyTemplateVersion.findUniqueOrThrow({ where: { id: eq.assemblyTemplateVersionId! } })).templateId, version: 2, status: "PUBLISHED", publishedAt: new Date() } });
      await owner.assemblyTemplateStep.create({ data: { versionId: av2.id, seq: 1, groupCode: "A", groupName: "A", srNo: "1", activity: "A brand new step", kind: "WORK", defaultDepartmentId: r.w.dept.id } });
      const n = await startNext(r);
      await owner.bomItem.update({ where: { id: n.byNo.get(1)!.id }, data: { qtyPer: 2, sourceQty: "2 NOS." } });
      const shellBefore = (await comps(r, false)).find((c) => c.tag === "Shell")!;
      await release(r, n.bomRevisionId);
      const shell = await owner.component.findUniqueOrThrow({ where: { id: shellBefore.id }, include: { operations: { where: { retiredAt: null } } } });
      expect(shell.routeVersionId).toBe(shellBefore.routeVersionId);
      expect(shell.operations.map((o) => o.seq).sort((a, b) => a - b)).toEqual(shellBefore.operations.map((o) => o.seq).sort((a, b) => a - b)); // no seq 30
      expect((await owner.equipment.findUniqueOrThrow({ where: { id: r.j.equipmentId } })).assemblyTemplateVersionId).toBe(eq.assemblyTemplateVersionId);
      expect(await owner.assemblyStep.count({ where: { jobId: r.j.jobId, templateStep: { versionId: av2.id } } })).toBe(0);

      // a not-started part whose family and variant change takes the new family's route
      const n3 = await svc.startBomRevision(r.w.actors.eng, { equipmentId: r.j.equipmentId });
      const lines = await owner.bomItem.findMany({ where: { bomRevisionId: n3.bomRevisionId } });
      const plate = lines.find((l) => l.itemNo === 2)!;
      await owner.bomItem.update({ where: { id: plate.id }, data: { componentTypeId: r.w.shl.id, routeVariant: "B" } });
      const out = await release(r, n3.bomRevisionId);
      expect(out.diff!.component.update).toBe(1);
      const changed = await owner.component.findFirstOrThrow({ where: { equipmentId: r.j.equipmentId, tag: "Plate", retiredAt: null }, include: { routeVersion: { include: { route: true } }, operations: { where: { retiredAt: null } } } });
      expect(changed.componentTypeId).toBe(r.w.shl.id);
      expect(changed.routeVersion!.route.variant).toBe("B");
      expect(changed.operations).toHaveLength(1);
    });
  });

  describe("release against floor writes", () => {
    it("a release racing a Start on a row it would retire never leaves a started row retired", async () => {
      const r = await released("RACE", { units: 1 });
      const plate = (await comps(r, false)).find((c) => c.tag === "Plate")!;
      const op = plate.operations[0];
      await owner.stockLot.create({ data: { jobId: r.j.jobId, bomItemId: plate.bomItemId!, location: "Y1", qty: "9" } }); // so a Start is not refused for material
      const n = await startNext(r);
      await owner.bomItem.delete({ where: { id: n.byNo.get(2)!.id } });
      const [started, rel] = await Promise.allSettled([
        recordWork(r.w.actors.admin, { jobId: r.j.jobId, action: "START", items: [{ kind: "COMPONENT_OP", id: op.id }] }),
        release(r, n.bomRevisionId),
      ]);
      expect(rel.status, String((rel as PromiseRejectedResult).reason)).toBe("fulfilled");
      expect(started.status, String((started as PromiseRejectedResult).reason)).toBe("fulfilled");
      const row = await owner.componentOperation.findUniqueOrThrow({ where: { id: op.id } });
      if (row.status !== "NOT_STARTED") {
        // the Start won: the release saw it started and flagged it
        expect(row).toMatchObject({ retiredAt: null, needsReview: true });
      } else {
        // the release won: the row is retired and the Start was refused
        expect(row.retiredAt).not.toBeNull();
        expect((started as PromiseFulfilledResult<Awaited<ReturnType<typeof recordWork>>>).value.refused[0]).toMatchObject({ code: "FLOOR_ROW_RETIRED" });
      }
    });
  });
  describe("review: Keep, Replace, Cancel", () => {
    /** A released line whose started plate (item 2) lost its BOM line in revision 2, so its operation is flagged. */
    async function flaggedPlate(label: string) {
      const r = await released(label, { units: 1 });
      const plate = (await comps(r, false)).find((c) => c.tag === "Plate")!;
      const op = plate.operations[0];
      await owner.componentOperation.update({ where: { id: op.id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
      const n = await startNext(r);
      await owner.bomItem.delete({ where: { id: n.byNo.get(2)!.id } });
      await release(r, n.bomRevisionId);
      return { r, op, plate };
    }
    /** A flagged started plate that still has a line (its quantity changed to 4). */
    async function flaggedPlateQty(label: string) {
      const r = await released(label, { units: 1 });
      const plate = (await comps(r, false)).find((c) => c.tag === "Plate")!;
      const op = plate.operations[0];
      await owner.componentOperation.update({ where: { id: op.id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
      const n = await startNext(r);
      await owner.bomItem.update({ where: { id: n.byNo.get(2)!.id }, data: { qtyPer: 4, sourceQty: "4 NOS." } });
      await release(r, n.bomRevisionId);
      return { r, op, plate };
    }
    const resolve = (r: R, who: keyof R["w"]["actors"], kind: "ASSEMBLY_STEP" | "COMPONENT_OP", id: number, action: "KEEP" | "REPLACE" | "CANCEL", reason = "Checked with the planner") =>
      review.resolveReviewRow(r.w.actors[who], { kind, id, action, reason });
    const opRow = (id: number) => owner.componentOperation.findUniqueOrThrow({ where: { id } });
    const stepRow = (id: number) => owner.assemblyStep.findUniqueOrThrow({ where: { id } });

    it.each([["planner"], ["qc"], ["sup"], ["admin"], ["client"]] as const)("%s is refused FORBIDDEN and nothing changes", async (who) => {
      const { r, op } = await flaggedPlate(`ROLE-${who}`);
      await expect(resolve(r, who, "COMPONENT_OP", op.id, "KEEP")).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await opRow(op.id)).toMatchObject({ needsReview: true, retiredAt: null });
      expect(await auditOf(r, "bom.review.keep")).toHaveLength(0);
    });

    it("another tenant's row is NOT_FOUND", async () => {
      const { r, op } = await flaggedPlate("TENANT-A");
      const other = await world("TENANT-B");
      await expect(review.resolveReviewRow(other.actors.eng, { kind: "COMPONENT_OP", id: op.id, action: "KEEP", reason: "not mine to touch" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await opRow(op.id)).toMatchObject({ needsReview: true });
      void r;
    });

    it.each([[""], ["   "], ["ok"], ["abcd"]])("a reason of %j is refused REASON_REQUIRED", async (reason) => {
      const { r, op } = await flaggedPlate("REASON");
      await expect(resolve(r, "eng", "COMPONENT_OP", op.id, "KEEP", reason)).rejects.toMatchObject({ code: "REASON_REQUIRED" });
      expect(await opRow(op.id)).toMatchObject({ needsReview: true });
    });

    it("a row that is not flagged, and a retired row, are refused", async () => {
      const { r } = await flaggedPlate("NOTFLAGGED");
      const shellOp = (await comps(r, false)).find((c) => c.tag === "Shell")!.operations[0];
      await expect(resolve(r, "eng", "COMPONENT_OP", shellOp.id, "KEEP")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      const retired = (await comps(r, true))[0]?.operations[0];
      const { r: r2, op: op2 } = await flaggedPlate("RETIRED");
      await resolve(r2, "eng", "COMPONENT_OP", op2.id, "CANCEL");
      await expect(resolve(r2, "eng", "COMPONENT_OP", op2.id, "KEEP")).rejects.toMatchObject({ code: "FLOOR_ROW_RETIRED" });
      void retired;
    });

    it("Replace where the current BOM has nothing for the row is VALIDATION_FAILED (keep or cancel it)", async () => {
      const { r, op } = await flaggedPlate("NOREPLACE");
      await expect(resolve(r, "eng", "COMPONENT_OP", op.id, "REPLACE")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(await opRow(op.id)).toMatchObject({ needsReview: true, retiredAt: null });
    });

    it("Replace and Cancel wait while the row is SUBMITTED for QC or has an open NCR; Keep does not", async () => {
      const { r, op } = await flaggedPlateQty("BLOCKED");
      await owner.componentOperation.update({ where: { id: op.id }, data: { status: "SUBMITTED" } });
      for (const action of ["REPLACE", "CANCEL"] as const) {
        await expect(resolve(r, "sj", "COMPONENT_OP", op.id, action)).rejects.toMatchObject({ code: "BOM_REVIEW_BLOCKED", detail: { reason: "QC_PENDING" } });
      }
      await owner.componentOperation.update({ where: { id: op.id }, data: { status: "IN_PROGRESS" } });
      const user = await owner.user.findFirstOrThrow({ where: { tenantId: r.w.tenantId } });
      const ncr = await owner.ncr.create({ data: { jobId: r.j.jobId, targetComponentOperationId: op.id, ruleCode: "H5", raisedBy: user.id, raisedAt: new Date() } });
      for (const action of ["REPLACE", "CANCEL"] as const) {
        await expect(resolve(r, "sj", "COMPONENT_OP", op.id, action)).rejects.toMatchObject({ code: "BOM_REVIEW_BLOCKED", detail: { reason: "NCR_OPEN" } });
      }
      expect(await opRow(op.id)).toMatchObject({ needsReview: true, retiredAt: null });
      await owner.ncr.update({ where: { id: ncr.id }, data: { status: "CLOSED", closedBy: user.id, closedAt: new Date() } });
      await expect(resolve(r, "sj", "COMPONENT_OP", op.id, "KEEP")).resolves.toMatchObject({ action: "KEEP" });
    });

    it("Keep clears the flag and audits the full old row with the reason; the part is not flagged again unless its line changes again", async () => {
      const { r, op, plate } = await flaggedPlateQty("KEEP");
      const out = await resolve(r, "eng", "COMPONENT_OP", op.id, "KEEP", "Qty change is for the next lot");
      expect(out).toMatchObject({ action: "KEEP", id: op.id, replacedBy: null });
      expect(await opRow(op.id)).toMatchObject({ needsReview: false, retiredAt: null, status: "IN_PROGRESS" });
      const a = (await auditOf(r, "bom.review.keep"))[0];
      expect(a.entityType).toBe("ComponentOperation");
      expect(a.before).toMatchObject({ id: op.id, needsReview: true });
      expect(a.after).toMatchObject({ needsReview: false, reason: "Qty change is for the next lot" });
      // a later release with the same line does not flag it again
      const n = await startNext(r);
      await owner.bomItem.update({ where: { id: n.byNo.get(1)!.id }, data: { remarks: "unrelated" } });
      await release(r, n.bomRevisionId);
      expect(await opRow(op.id)).toMatchObject({ needsReview: false });
      void plate;
    });

    it("Cancel retires the row (reason 'cancelled in review: ...') and audits; QC history stays on it", async () => {
      const { r, op } = await flaggedPlate("CANCEL");
      await resolve(r, "sj", "COMPONENT_OP", op.id, "CANCEL", "Part no longer made");
      expect(await opRow(op.id)).toMatchObject({ needsReview: false, retiredReason: "cancelled in review: Part no longer made", status: "IN_PROGRESS" });
      expect((await opRow(op.id)).retiredAt).not.toBeNull();
      expect((await auditOf(r, "bom.review.cancel"))[0].after).toMatchObject({ retired: true, reason: "Part no longer made" });
    });

    it("Replace of an operation whose quantity changed retires it and adds the current one on the same part", async () => {
      const { r, op, plate } = await flaggedPlateQty("REPLACEOP");
      const out = await resolve(r, "eng", "COMPONENT_OP", op.id, "REPLACE", "Re-cut to the new quantity");
      expect(out.replacedBy).not.toBeNull();
      const fresh = await opRow(out.replacedBy!);
      expect(fresh).toMatchObject({ componentId: plate.id, status: "NOT_STARTED", qtyPlanned: 4, needsReview: false, retiredAt: null });
      expect(await opRow(op.id)).toMatchObject({ retiredAt: expect.any(Date), needsReview: false });
      expect((await auditOf(r, "bom.review.replace"))[0].after).toMatchObject({ replacedBy: out.replacedBy });
    });

    it("Replace of a whole part (its tag changed) retires the part and its operations, makes a new one, copies the drawing link and not the heat or the issue, and re-keys its not-started steps", async () => {
      const r = await released("REPLACEPART", { units: 1 });
      const shell = (await comps(r, false)).find((c) => c.tag === "Shell")!;
      const op = shell.operations[0];
      await owner.componentOperation.update({ where: { id: op.id }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
      const user = await owner.user.findFirstOrThrow({ where: { tenantId: r.w.tenantId } });
      const lot = await owner.stockLot.create({ data: { jobId: r.j.jobId, bomItemId: shell.bomItemId!, heatNumber: "H9", location: "Y1", qty: "5" } });
      await owner.stockTxn.create({ data: { jobId: r.j.jobId, stockLotId: lot.id, type: "ISSUE", qty: "1", by: user.id, componentId: shell.id } });
      const dt = await owner.drawingTypeRef.create({ data: { tenantId: r.w.tenantId, code: "GA", name: "GA" } });
      const dwg = await owner.assemblyDrawing.create({ data: { jobId: r.j.jobId, drawingTypeId: dt.id, drawingNo: "GA-1" } });
      await owner.component.update({ where: { id: shell.id }, data: { governingDrawingId: dwg.id } });
      const fit = await owner.assemblyStep.findFirstOrThrow({ where: { jobId: r.j.jobId, componentId: shell.id } });
      const n = await startNext(r);
      await owner.bomItem.update({ where: { id: n.byNo.get(1)!.id }, data: { partName: "Shell X" } });
      await release(r, n.bomRevisionId);
      expect((await opRow(op.id)).needsReview).toBe(true);

      const out = await resolve(r, "eng", "COMPONENT_OP", op.id, "REPLACE", "New shell mark");
      const old = await owner.component.findUniqueOrThrow({ where: { id: shell.id }, include: { operations: true } });
      expect(old.retiredAt).not.toBeNull();
      expect(old.operations.every((o) => o.retiredAt != null)).toBe(true);
      const fresh = await owner.component.findFirstOrThrow({ where: { equipmentId: r.j.equipmentId, tag: "Shell X", retiredAt: null }, include: { operations: true } });
      expect(fresh.governingDrawingId).toBe(dwg.id);
      expect(fresh.operations.every((o) => o.status === "NOT_STARTED")).toBe(true);
      expect(await owner.stockTxn.count({ where: { componentId: fresh.id } })).toBe(0);
      expect(await owner.materialIdentification.count({ where: { componentId: fresh.id } })).toBe(0);
      expect(out.replacedBy).toBe(fresh.operations[0].id);
      // its not-started "Fit shell course" step now belongs to the new part
      expect((await stepRow(fit.id)).componentId).toBe(fresh.id);
    });

    it("Replace of a step adds the current row on the unit with a clean seq order", async () => {
      const r = await released("REPLACESTEP", { units: 1 });
      const markOut = (await steps(r))[0];
      await owner.assemblyStep.update({ where: { id: markOut.id }, data: { status: "IN_PROGRESS", startedAt: new Date(), needsReview: true } });
      const active = (await steps(r)).length;
      const out = await resolve(r, "sj", "ASSEMBLY_STEP", markOut.id, "REPLACE", "Redo on the new drawing");
      expect(out.replacedBy).not.toBeNull();
      expect(await stepRow(markOut.id)).toMatchObject({ retiredAt: expect.any(Date), needsReview: false, status: "IN_PROGRESS" });
      const now = await steps(r);
      expect(now.length).toBe(active);
      expect(new Set(now.map((s) => s.seq)).size).toBe(now.length);
      expect(now.find((s) => s.id === out.replacedBy)).toMatchObject({ status: "NOT_STARTED", templateStepId: markOut.templateStepId });
    });

    it("Replace of a QCP-bound inspection step appends a PENDING execution, so the hold point reopens and the new row has to be inspected", async () => {
      const r = await released("REPLACEHOLD", { units: 1 });
      const insp = await owner.assemblyStep.findFirstOrThrow({ where: { jobId: r.j.jobId, templateStep: { kind: "INSPECTION" }, qcpItemId: { not: null } }, orderBy: { id: "asc" } });
      const hold = await owner.qcpCodeRef.create({ data: { tenantId: r.w.tenantId, code: "H", label: "Hold", blocksCompletion: true } });
      const party = await owner.inspectionParty.create({ data: { qcpTemplateId: (await owner.qcpItem.findUniqueOrThrow({ where: { id: insp.qcpItemId! } })).qcpTemplateId, code: "DESPL", jobId: r.j.jobId } });
      await owner.qcpItemPartyCode.create({ data: { qcpItemId: insp.qcpItemId!, inspectionPartyId: party.id, qcpCodeId: hold.id, jobId: r.j.jobId } });
      const qc = await owner.user.findFirstOrThrow({ where: { tenantId: r.w.tenantId } });
      await owner.qcpExecution.create({ data: { qcpItemId: insp.qcpItemId!, unitId: insp.unitId, attemptNo: 1, result: "ACCEPTED", clearedBy: qc.id, jobId: r.j.jobId } });
      await owner.assemblyStep.update({ where: { id: insp.id }, data: { needsReview: true } });
      const out = await resolve(r, "eng", "ASSEMBLY_STEP", insp.id, "REPLACE", "Inspection redone after rework");
      const execs = await owner.qcpExecution.findMany({ where: { qcpItemId: insp.qcpItemId!, unitId: insp.unitId }, orderBy: { attemptNo: "asc" } });
      expect(execs.map((e) => [e.attemptNo, e.result])).toEqual([[1, "ACCEPTED"], [2, "PENDING"]]);
      expect((await stepRow(out.replacedBy!)).qcpItemId).toBe(insp.qcpItemId);
    });
  });
});
