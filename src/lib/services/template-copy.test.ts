import { afterAll, describe, expect, it } from "vitest";

/**
 * Lean Core J4c: a cloned or re-saved process template draft must equal its source column for
 * column, apart from version identity (L1.3-ship found `evidenceKind` and `includeWhen` dropped).
 * The column lists come from Prisma's own scalar-field enums, so a column added later is
 * compared too, and the fixture proves it by having a non-null value in EVERY column.
 * DB-gated; disposable tenant.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("template clone fidelity (DB)", async () => {
  const { Prisma, PrismaClient } = await import("@/generated/prisma/client");
  const { ROLES } = await import("@/lib/authz");
  const { cloneVersion, saveDraftVersion } = await import("./template.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  afterAll(() => owner.$disconnect());
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const IDENTITY_PROCESS = new Set(["id", "versionId"]);
  const IDENTITY_EDGE = new Set(["id", "versionId", "processId", "predecessorId"]);
  const PROCESS_COLUMNS = Object.values(Prisma.TemplateProcessScalarFieldEnum).filter((c) => !IDENTITY_PROCESS.has(c));
  const EDGE_COLUMNS = Object.values(Prisma.TemplateEdgeScalarFieldEnum).filter((c) => !IDENTITY_EDGE.has(c));

  let seqNo = 0;
  async function source() {
    const tag = `${stamp}-${++seqNo}`;
    const org = await owner.organization.create({ data: { code: `TEST-CLONE-${tag}`, name: "clone" } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "D", name: "Dept" } });
    const user = await owner.user.create({ data: { tenantId, email: `u-${tag}@test.local`, username: `u-${tag}`, passwordHash: "x", name: "A", mustChangePassword: false } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
    const v = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED", publishedAt: new Date() } });
    // Every column set to something other than its default, process 2 differently from process 1.
    const mk = (seq: number, evidenceKind: "MDR_COMPILED" | "DISPATCH_RECORDED", includeWhen: object) =>
      owner.templateProcess.create({
        data: {
          versionId: v.id, seq, code: String(seq), name: `P${seq}`, mainActivities: `act ${seq}`,
          durationMinDays: 3 + seq, durationMaxDays: 9 + seq, cumulativePrinted: `${seq} wk`, defaultDepartmentId: dept.id,
          workOrderStages: [seq, seq + 1], envelopeFinishByMinDays: 10 + seq, envelopeFinishByMaxDays: 20 + seq,
          envelopeStartByMinDays: 1 + seq, envelopeStartByMaxDays: 2 + seq, optional: true, provisional: true,
          evidenceKind, grain: "JOB", requiresQc: false, includeWhen, qtyBands: [{ maxQty: 10 + seq, multiplier: 1 }],
        },
      });
    const p1 = await mk(1, "MDR_COMPILED", { all: [{ key: "pwht", op: "eq", value: true }] });
    const p2 = await mk(2, "DISPATCH_RECORDED", { any: [{ key: "n", op: "gte", value: 2 }] });
    await owner.templateEdge.create({ data: { versionId: v.id, processId: p2.id, predecessorId: p1.id, type: "START_TO_START_WITH_OVERLAP", lagDays: -2, enforcement: "SOFT" } });
    const actor = {
      userId: user.id, tenantId, clientId: null, name: "x", email: user.email, roles: [ROLES.ADMIN] as never, departmentIds: [],
      mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false,
    };
    return { v, actor };
  }

  const read = async (versionId: number) => {
    const processes = await owner.templateProcess.findMany({ where: { versionId }, orderBy: { seq: "asc" } });
    const edges = await owner.templateEdge.findMany({ where: { versionId }, include: { process: true, predecessor: true } });
    return { processes, edges };
  };

  it("the fixture has a non-null value in every column (so a dropped column shows as a difference)", async () => {
    const { v } = await source();
    const { processes, edges } = await read(v.id);
    for (const col of PROCESS_COLUMNS) for (const p of processes) expect(p[col as keyof typeof p], `process.${col}`).not.toBeNull();
    for (const col of EDGE_COLUMNS) for (const e of edges) expect(e[col as keyof typeof e], `edge.${col}`).not.toBeNull();
  });

  describe.each([
    ["cloneVersion", async (s: Awaited<ReturnType<typeof source>>) => (await cloneVersion(s.actor, { sourceVersionId: s.v.id, notes: "clone" })).id],
    [
      "cloneVersion then saveDraftVersion, as the editor does (it never sends evidenceKind or includeWhen)",
      async (s: Awaited<ReturnType<typeof source>>) => {
        const draft = await cloneVersion(s.actor, { sourceVersionId: s.v.id, notes: "clone" });
        const procs = await owner.templateProcess.findMany({ where: { versionId: draft.id }, orderBy: { seq: "asc" } });
        const edges = await owner.templateEdge.findMany({ where: { versionId: draft.id } });
        const keyOf = new Map(procs.map((p) => [p.id, `k${p.id}`]));
        await saveDraftVersion(s.actor, {
          versionId: draft.id,
          expectedUpdatedAt: draft.updatedAt ?? null,
          processes: procs.map((p) => ({
            key: keyOf.get(p.id)!, seq: p.seq, code: p.code, name: p.name, mainActivities: p.mainActivities, defaultDepartmentId: p.defaultDepartmentId,
            durationMinDays: p.durationMinDays, durationMaxDays: p.durationMaxDays, envelopeStartByMinDays: p.envelopeStartByMinDays,
            envelopeStartByMaxDays: p.envelopeStartByMaxDays, envelopeFinishByMinDays: p.envelopeFinishByMinDays,
            envelopeFinishByMaxDays: p.envelopeFinishByMaxDays, workOrderStages: p.workOrderStages, optional: p.optional, provisional: p.provisional,
          })),
          edges: edges.map((e) => ({ processKey: keyOf.get(e.processId)!, predecessorKey: keyOf.get(e.predecessorId)!, type: e.type, lagDays: e.lagDays })),
        } as never);
        return draft.id;
      },
    ],
  ])("%s", (_name, run) => {
    it.each(PROCESS_COLUMNS)("process column %s equals the source", async (col) => {
      const s = await source();
      const copyId = await run(s);
      const [a, b] = [await read(s.v.id), await read(copyId)];
      expect(b.processes).toHaveLength(a.processes.length);
      a.processes.forEach((p, i) => expect(b.processes[i][col as keyof typeof p], `${p.code}.${col}`).toEqual(p[col as keyof typeof p]));
    });

    it.each(EDGE_COLUMNS)("edge column %s equals the source", async (col) => {
      const s = await source();
      const copyId = await run(s);
      const [a, b] = [await read(s.v.id), await read(copyId)];
      expect(b.edges).toHaveLength(a.edges.length);
      const byCodes = (list: typeof a.edges) => new Map(list.map((e) => [`${e.process.code}>${e.predecessor.code}`, e]));
      for (const [k, e] of byCodes(a.edges)) expect(byCodes(b.edges).get(k)?.[col as keyof typeof e], `${k}.${col}`).toEqual(e[col as keyof typeof e]);
    });
  });
});
