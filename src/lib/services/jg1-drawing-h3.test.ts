import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { WorkOrg } from "./work.test-util";

/**
 * Lean Core JG1, DB-gated: drawing register -> link -> H3 -> release at risk, end to end, plus the
 * role/tenant/duplicate table for the new writes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("JG1 drawing release for H3 (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { recordWork } = await import("./work.service");
  const { createAssemblyDrawing, createDrawingRevision, releaseDrawingAtRisk } = await import("./drawing.service");
  const { linkDrawingToComponents } = await import("./component.service");
  const { loadJobDrawings } = await import("./drawings.read");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  let head: Actor;
  let eng: Actor;
  let sup: Actor;
  let bHead: Actor;
  let typeId: number;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "JG1A");
    b = await makeWorkOrg(owner, "JG1B");
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    eng = await o.user("eng", ["ENGINEERING"]);
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    bHead = await b.user("bhead", ["PRODUCTION_HEAD"]);
    typeId = (await owner.drawingTypeRef.findFirstOrThrow({ where: { tenantId: o.tenantId, code: "GA" } })).id;
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  async function code(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? e.code : String(e);
    }
    return null;
  }
  const pressure = (tag: string) => ({ tag, pressure: true, issued: true, heatNumber: "H1", ops: [{ code: "CUTTING" }] });
  const start = (actor: Actor, jobId: number, opId: number) =>
    recordWork(actor, { jobId, action: "START", items: [{ kind: "COMPONENT_OP", id: opId }] });

  it("link -> cutting refused until released -> at-risk release -> cutting starts; one audit row per part", async () => {
    const j = await o.job({ components: [pressure("SHELL"), pressure("HEAD")], units: 1 });
    const jobId = j.job.id;
    const shell = j.components.get("SHELL:0")!;
    const headC = j.components.get("HEAD:0")!;

    // Before: both parts are listed as the gap, and cutting is not held (H3 no-op).
    expect((await loadJobDrawings(eng, jobId)).unlinked.map((p) => p.tag).sort()).toEqual(["HEAD", "SHELL"]);

    const d = await createAssemblyDrawing(eng, { jobId, drawingTypeId: typeId, drawingNo: "GA-100", remarks: "General arrangement" });
    expect(await linkDrawingToComponents(eng, { jobId, assemblyDrawingId: d.id, componentIds: [shell, headC] })).toEqual({ linked: 2 });
    expect((await loadJobDrawings(eng, jobId)).unlinked).toHaveLength(0);
    expect(await owner.auditLog.count({ where: { tenantId: o.tenantId, action: "component.linkGoverningDrawing", entityId: { in: [String(shell), String(headC)] } } })).toBe(2);
    expect(await owner.auditLog.count({ where: { tenantId: o.tenantId, action: "drawing.create", entityId: String(d.id) } })).toBe(1);

    // No revision issued: refused. A DRAFT: refused.
    let r = await start(sup, jobId, j.op("SHELL", "CUTTING"));
    expect(r.refused[0]?.code).toBe(ERROR_CODES.DRAWING_NOT_RELEASED);
    const rev = await createDrawingRevision(eng, { jobId, assemblyDrawingId: d.id, revisionNo: 0, status: "DRAFT" });
    r = await start(sup, jobId, j.op("SHELL", "CUTTING"));
    expect(r.refused[0]?.code).toBe(ERROR_CODES.DRAWING_NOT_RELEASED);
    expect((await loadJobDrawings(eng, jobId)).drawings[0].state).toBe("NOT_RELEASED");

    // Engineering cannot release at risk; the Production Head can, with a reason.
    expect(await code(releaseDrawingAtRisk(eng, { jobId, drawingRevisionId: rev.id, reason: "x" }))).toBe(ERROR_CODES.FORBIDDEN);
    await releaseDrawingAtRisk(head, { jobId, drawingRevisionId: rev.id, reason: "Client asked to start", clientConsentRef: "MAIL-1" });
    expect((await loadJobDrawings(eng, jobId)).drawings[0].state).toBe("AT_RISK");
    r = await start(sup, jobId, j.op("SHELL", "CUTTING"));
    expect(r.applied).toHaveLength(1);

    // A newer revision voids the at-risk release: the other part is held again.
    await createDrawingRevision(eng, { jobId, assemblyDrawingId: d.id, revisionNo: 1, status: "DRAFT" });
    r = await start(sup, jobId, j.op("HEAD", "CUTTING"));
    expect(r.refused[0]?.code).toBe(ERROR_CODES.DRAWING_NOT_RELEASED);
  });

  describe("write rules", () => {
    it.each<[string, () => Actor, string | null]>([
      ["ENGINEERING", () => eng, null],
      ["PRODUCTION_HEAD", () => head, null],
      ["SUPERVISOR", () => sup, ERROR_CODES.FORBIDDEN],
      ["a client user", () => ({ ...head, clientId: 1 }), ERROR_CODES.FORBIDDEN],
      ["another tenant's Production Head", () => bHead, ERROR_CODES.NOT_FOUND],
    ])("createAssemblyDrawing as %s", async (_n, who, expected) => {
      const j = await o.job({});
      expect(await code(createAssemblyDrawing(who(), { jobId: j.job.id, drawingTypeId: typeId, drawingNo: `GA-${Math.random()}` }))).toBe(expected);
    });

    it("refuses a duplicate drawing number on the same job (any case) but allows it on another job", async () => {
      const j = await o.job({});
      const k = await o.job({});
      await createAssemblyDrawing(eng, { jobId: j.job.id, drawingTypeId: typeId, drawingNo: "GA-7" });
      expect(await code(createAssemblyDrawing(eng, { jobId: j.job.id, drawingTypeId: typeId, drawingNo: "ga-7" }))).toBe(ERROR_CODES.DRAWING_NUMBER_TAKEN);
      expect(await code(createAssemblyDrawing(eng, { jobId: k.job.id, drawingTypeId: typeId, drawingNo: "GA-7" }))).toBeNull();
    });

    it("a drawing type from another tenant is refused", async () => {
      const j = await o.job({});
      const foreign = (await owner.drawingTypeRef.findFirstOrThrow({ where: { tenantId: b.tenantId } })).id;
      expect(await code(createAssemblyDrawing(eng, { jobId: j.job.id, drawingTypeId: foreign, drawingNo: "GA-1" }))).toBe(ERROR_CODES.NOT_FOUND);
    });

    it("bulk link: another job's drawing or part, a client, a supervisor and an already-linked part are refused; nothing is written", async () => {
      const j = await o.job({ components: [pressure("A"), pressure("B")], units: 1 });
      const k = await o.job({ components: [pressure("C")], units: 1 });
      const jd = await createAssemblyDrawing(eng, { jobId: j.job.id, drawingTypeId: typeId, drawingNo: "GA-A" });
      const jd2 = await createAssemblyDrawing(eng, { jobId: j.job.id, drawingTypeId: typeId, drawingNo: "GA-B" });
      const kd = await createAssemblyDrawing(eng, { jobId: k.job.id, drawingTypeId: typeId, drawingNo: "GA-C" });
      const a = j.components.get("A:0")!;
      const bb = j.components.get("B:0")!;
      const c = k.components.get("C:0")!;
      const link = (who: Actor, drawing: number, ids: number[], jobId = j.job.id) =>
        linkDrawingToComponents(who, { jobId, assemblyDrawingId: drawing, componentIds: ids });
      expect(await code(link(sup, jd.id, [a]))).toBe(ERROR_CODES.FORBIDDEN);
      expect(await code(link({ ...eng, clientId: 1 }, jd.id, [a]))).toBe(ERROR_CODES.FORBIDDEN);
      expect(await code(link(bHead, jd.id, [a]))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await code(link(eng, kd.id, [a]))).toBe(ERROR_CODES.NOT_FOUND); // other job's drawing
      expect(await code(link(eng, jd.id, [a, c]))).toBe(ERROR_CODES.NOT_FOUND); // other job's part
      expect((await owner.component.findUniqueOrThrow({ where: { id: a } })).governingDrawingId).toBeNull();

      expect(await link(eng, jd.id, [a])).toEqual({ linked: 1 });
      expect(await link(eng, jd.id, [a, bb])).toEqual({ linked: 1 }); // re-run: only the new part
      expect(await code(link(eng, jd2.id, [a, bb]))).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
      expect((await owner.component.findUniqueOrThrow({ where: { id: a } })).governingDrawingId).toBe(jd.id);
    });
  });
});
