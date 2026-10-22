import { afterAll, describe, expect, it } from "vitest";

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
  const bomSvc = await import("./bom.service");
  const { makeWorldKit } = await import("./bom-release.world.test-util");
  const { assertKitReady } = await import("./_shared");
  const { recordWork } = await import("./work.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const { world } = makeWorldKit(owner);

  afterAll(async () => {
    await owner.$disconnect();
  });

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

  void recordWork;
});
