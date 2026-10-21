import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe.skipIf(!RUN_DB)("qcpAssemblyGaps (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { qcpAssemblyGaps } = await import("./assembly-qcp-match");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  let tenantId: number;
  let familyId: number;
  let typeId: number;
  let good: number;
  let bad: number;
  let empty: number;

  async function qcp(label: string, srNos: string[]) {
    const t = await owner.qcpTemplate.create({ data: { tenantId, jobLabel: label, vessel: "PV", revision: 0 } });
    await owner.qcpItem.createMany({
      data: srNos.map((srNo, i) => ({ tenantId, qcpTemplateId: t.id, sequence: i + 1, srNo, kind: "CHECKPOINT" as const, activity: `act ${srNo}` })),
    });
    return t.id;
  }

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `TEST-GAP-${stamp}`, name: "gap" } });
    tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "QC", name: "QC" } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    familyId = family.id;
    typeId = (await owner.equipmentTypeRef.create({ data: { tenantId, familyId, code: "VSK", name: "VSK" } })).id;
    const addTemplate = async (equipmentTypeId: number | null, srNos: string[]) => {
      const t = await owner.assemblyTemplate.create({ data: { tenantId, familyId, name: `t${equipmentTypeId}`, equipmentTypeId } });
      const v = await owner.assemblyTemplateVersion.create({
        data: { templateId: t.id, version: 1, status: "PUBLISHED", publishedAt: new Date() },
      });
      await owner.assemblyTemplateStep.createMany({
        data: srNos.map((srNo, i) => ({
          versionId: v.id, seq: i + 1, groupCode: "A", groupName: "A", srNo, activity: `step ${srNo}`,
          kind: "INSPECTION" as const, defaultDepartmentId: dept.id,
        })),
      });
    };
    await addTemplate(null, ["1.1", "1.2"]);
    await addTemplate(typeId, ["2.1"]);
    good = await qcp("good", ["1.1", "1.2", "2.1", "9"]);
    bad = await qcp("bad", ["1", "2", "3"]);
    empty = await qcp("empty", []);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  it("flags a QCP template that does not number the template's inspection srNos, even with no equipment type chosen", async () => {
    const gaps = await withTenant(tenantId, (tx) => qcpAssemblyGaps(tx, tenantId, familyId, [typeId], [good, bad, empty]));
    expect(gaps[bad].sort()).toEqual(["1.1", "1.2", "2.1"]);
    expect(gaps[empty].sort()).toEqual(["1.1", "1.2", "2.1"]);
  });

  it("passes a compatible QCP template (extra QCP items are fine)", async () => {
    const gaps = await withTenant(tenantId, (tx) => qcpAssemblyGaps(tx, tenantId, familyId, [typeId], [good]));
    expect(gaps[good]).toEqual([]);
  });

  it("a family with no published assembly template has no gaps (nothing to bind)", async () => {
    const other = await owner.productFamily.create({ data: { tenantId, code: `HX-${stamp}`, name: "HX" } });
    const gaps = await withTenant(tenantId, (tx) => qcpAssemblyGaps(tx, tenantId, other.id, [], [bad]));
    expect(gaps[bad]).toEqual([]);
  });
});
