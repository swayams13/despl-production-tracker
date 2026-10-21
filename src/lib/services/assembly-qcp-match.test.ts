import { afterAll, describe, expect, it } from "vitest";
import { groupQcpBySrNo, matchInspectionStep, srNoOccurrences, unresolvedInspectionSrNos } from "./assembly-qcp-match";

/**
 * The one rule that binds an INSPECTION assembly step to a QCP item (shared by
 * createJob and the wizard's compatibility check). Violations first.
 */
const insp = (id: number, srNo: string | null) => ({ id, kind: "INSPECTION", srNo });
const work = (id: number, srNo: string | null) => ({ id, kind: "WORK", srNo });
const q = (id: number | null, srNo: string, sequence: number) => ({ id, srNo, sequence });

describe("unresolvedInspectionSrNos", () => {
  it("reports a step whose srNo the QCP does not number at all", () => {
    // the DE0463 case: assembly binds 1.1, the QCP numbers 1, 2, 3
    expect(unresolvedInspectionSrNos([insp(1, "1.1"), insp(2, "1.2")], [q(1, "1", 1), q(2, "2", 2)])).toEqual(["1.1", "1.2"]);
  });

  it("reports a repeated srNo the QCP lists fewer times", () => {
    expect(unresolvedInspectionSrNos([insp(1, "5"), insp(2, "5")], [q(1, "5", 1)])).toEqual(["5"]);
  });

  it("reports an item a rule dropped (id null) but keeps its place", () => {
    expect(unresolvedInspectionSrNos([insp(1, "5")], [q(null, "5", 1)])).toEqual(["5"]);
  });

  it("ignores an inspection step that carries a rule (a job's answers may drop it), but it still counts for numbering", () => {
    const ruled = { ...insp(1, "5"), includeWhen: { all: [] } };
    expect(unresolvedInspectionSrNos([ruled], [])).toEqual([]);
    // the second srNo-5 step binds to the SECOND item, whether or not the first is ruled out
    expect(unresolvedInspectionSrNos([ruled, insp(2, "5")], [q(1, "5", 1)])).toEqual(["5"]);
  });

  it("is empty when every inspection step has its item; work steps and srNo-less steps need none", () => {
    const steps = [insp(1, "1.1"), work(2, "9"), insp(3, null), insp(4, "1.2")];
    expect(unresolvedInspectionSrNos(steps, [q(10, "1.1", 1), q(11, "1.2", 2)])).toEqual([]);
  });
});

describe("matchInspectionStep", () => {
  it("binds the nth step of an srNo to the nth item of that srNo in sequence order", () => {
    const steps = [insp(1, "5"), insp(2, "5")];
    const grouped = groupQcpBySrNo([q(21, "5", 9), q(20, "5", 3)]);
    const occ = srNoOccurrences(steps);
    expect(matchInspectionStep(steps[0], occ, grouped)).toMatchObject({ id: 20 });
    expect(matchInspectionStep(steps[1], occ, grouped)).toMatchObject({ id: 21 });
  });

  it("returns null for a step that needs no binding", () => {
    expect(matchInspectionStep(work(1, "5"), new Map(), new Map())).toBeNull();
  });
});

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const pwht = { all: [{ key: "pwht", op: "truthy" }] };

/**
 * The wizard's warning and createJob use one rule. Each case builds a real
 * tenant and runs BOTH on the same fixture.
 */
describe.skipIf(!RUN_DB)("qcpAssemblyGaps vs the BOM release (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { ROLES } = await import("@/lib/authz");
  const { createJob } = await import("./job-intake.service");
  const { releaseJobBoms } = await import("./bom-release.test-util");
  const { qcpAssemblyGaps, loadQcpItemsByTemplate } = await import("./assembly-qcp-match");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;

  type StepSpec = { srNo: string; includeWhen?: unknown };
  /** A tenant with a 1-process route, a pwht question, and the given assembly templates (null type = family level). */
  async function world(templates: { type: string | null; steps: StepSpec[] }[]) {
    const tag = `${stamp}-${++n}`;
    const org = await owner.organization.create({ data: { code: `TEST-GAP-${tag}`, name: "gap" } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fab" } });
    const user = await owner.user.create({
      data: { tenantId, email: `u-${tag}@test.local`, username: `u-${tag}`, passwordHash: "x", name: "Admin", mustChangePassword: false },
    });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${tag}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    await owner.configQuestion.create({
      data: { tenantId, familyId: family.id, key: "pwht", label: "pwht", type: "BOOLEAN", sortOrder: 0 },
    });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    await owner.templateProcess.create({
      data: { versionId: tv.id, seq: 1, code: "10", name: "P10", defaultDepartmentId: dept.id, optional: false },
    });
    const types = new Map<string, number>();
    for (const t of templates) {
      let typeId: number | null = null;
      if (t.type) {
        typeId = (await owner.equipmentTypeRef.create({ data: { tenantId, familyId: family.id, code: t.type, name: t.type } })).id;
        types.set(t.type, typeId);
      }
      const at = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: `A-${t.type}`, equipmentTypeId: typeId } });
      const av = await owner.assemblyTemplateVersion.create({
        data: { templateId: at.id, version: 1, status: "PUBLISHED", publishedAt: new Date() },
      });
      await owner.assemblyTemplateStep.createMany({
        data: t.steps.map((s, i) => ({
          versionId: av.id, seq: i + 1, groupCode: "A", groupName: "A", srNo: s.srNo, activity: `step ${i}`,
          kind: "INSPECTION" as const, defaultDepartmentId: dept.id, qcpSrNo: s.srNo, includeWhen: s.includeWhen as never,
        })),
      });
    }
    const qcp = async (srNos: string[]) => {
      const t = await owner.qcpTemplate.create({ data: { tenantId, jobLabel: "LIB", vessel: "V", revision: 0 } });
      for (const [i, srNo] of srNos.entries()) {
        await owner.qcpItem.create({ data: { tenantId, qcpTemplateId: t.id, sequence: i + 1, srNo, kind: "CHECKPOINT", activity: `qcp ${srNo}` } });
      }
      return t.id;
    };
    const actor = {
      userId: user.id, tenantId, clientId: null, name: "Admin", email: user.email, roles: [ROLES.ADMIN], departmentIds: [],
      mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false,
    };
    /** What the wizard would show for this QCP template and these equipment types. */
    const gaps = (qcpId: number, typeCodes: string[]) =>
      withTenant(tenantId, async (tx) => {
        const items = await loadQcpItemsByTemplate(tx, tenantId, [qcpId]);
        const g = await qcpAssemblyGaps(tx, tenantId, family.id, typeCodes.map((c) => types.get(c)!), items);
        return g[qcpId];
      });
    /** What createJob and the BOM release (J5a: the step is made there) do with one line of the given type and answers. */
    const create = async (qcpId: number, typeCode: string | null, config: Record<string, unknown> | null = null) => {
      const r = await createJob(actor, {
        clientId: client.id, familyId: family.id, templateVersionId: tv.id, calendarId: null, jobNumber: `GAP-${stamp}-${++n}`,
        clientOrderNo: null, projectName: null, poRef: null, designCode: null, orderDate: null, committedDeliveryDate: null,
        targetDispatchDate: null, priority: "NORMAL", remarks: null, excludedProcessCodes: [], exclusionReason: null,
        equipments: [{ equipmentTypeId: typeCode ? types.get(typeCode)! : null, name: "Line", blockNo: 1, remarks: null, config, serials: [`S-${n}`] }],
        qcpTemplateSourceId: qcpId, copyBomFromEquipmentId: null,
      } as never);
      const released = await releaseJobBoms(owner, actor, r.jobId);
      return { ...r, assemblyStepCount: released.steps };
    };
    return { qcp, gaps, create };
  }

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("incompatible QCP: the wizard flags it and the release refuses it", async () => {
    const w = await world([{ type: null, steps: [{ srNo: "1.1" }, { srNo: "1.2" }] }]);
    const bad = await w.qcp(["1", "2", "3"]);
    expect(await w.gaps(bad, [])).toEqual(["1.1", "1.2"]);
    await expect(w.create(bad, null)).rejects.toMatchObject({ code: "QCP_ITEM_UNRESOLVED" });
  });

  it("srNo repeated more often than the QCP lists it: flagged and the release refuses it", async () => {
    const w = await world([{ type: null, steps: [{ srNo: "5" }, { srNo: "5" }] }]);
    const short = await w.qcp(["5"]);
    expect(await w.gaps(short, [])).toEqual(["5"]);
    await expect(w.create(short, null)).rejects.toMatchObject({ code: "QCP_ITEM_UNRESOLVED" });
  });

  it("compatible QCP: no gap and the release binds every checkpoint", async () => {
    const w = await world([{ type: null, steps: [{ srNo: "1.1" }, { srNo: "1.2" }] }]);
    const good = await w.qcp(["1.1", "1.2", "9"]);
    expect(await w.gaps(good, [])).toEqual([]);
    expect(await w.create(good, null)).toMatchObject({ assemblyStepCount: 2 });
  });

  it("a step with a rule: no warning, the release succeeds when its answer drops the step and refuses when it keeps it", async () => {
    const w = await world([{ type: null, steps: [{ srNo: "1" }, { srNo: "2", includeWhen: pwht }] }]);
    const noTwo = await w.qcp(["1"]);
    expect(await w.gaps(noTwo, [])).toEqual([]);
    expect(await w.create(noTwo, null, { pwht: false })).toMatchObject({ assemblyStepCount: 1 });
    // the warning is deliberately silent here; the release (authoritative) still refuses
    await expect(w.create(noTwo, null, { pwht: true })).rejects.toMatchObject({ code: "QCP_ITEM_UNRESOLVED" });
  });

  describe("a family with several equipment types", () => {
    const fixture = () =>
      world([
        { type: null, steps: [{ srNo: "F.1" }] }, // family fallback, reachable by no typed line
        { type: "A", steps: [{ srNo: "A.1" }] },
        { type: "B", steps: [{ srNo: "B.1" }] },
      ]);

    it("flags a QCP that covers one type only, naming the other type's checkpoint", async () => {
      const w = await fixture();
      const onlyA = await w.qcp(["A.1"]);
      expect(await w.gaps(onlyA, ["A", "B"])).toEqual(["B.1"]);
      await expect(w.create(onlyA, "B")).rejects.toMatchObject({ code: "QCP_ITEM_UNRESOLVED" });
      expect(await w.create(onlyA, "A")).toMatchObject({ assemblyStepCount: 1 });
    });

    it("does not count the family fallback when every type has its own template", async () => {
      const w = await fixture();
      const both = await w.qcp(["A.1", "B.1"]); // no F.1
      expect(await w.gaps(both, ["A", "B"])).toEqual([]);
      expect(await w.create(both, "A")).toBeDefined();
      expect(await w.create(both, "B")).toBeDefined();
    });

    it("a type with no template of its own falls back to the family's", async () => {
      const w = await world([{ type: null, steps: [{ srNo: "F.1" }] }, { type: "A", steps: [{ srNo: "A.1" }] }, { type: "C", steps: [] }]);
      const onlyA = await w.qcp(["A.1"]);
      // C has no steps in its template, so it resolves to the family's F.1
      expect(await w.gaps(onlyA, ["A", "C"])).toEqual(["F.1"]);
    });
  });
});
