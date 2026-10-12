import { describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES } from "@/lib/shared/errors";
import { dryRunMasterImport } from "./master-import.service";
import { makeWorkbook, PARTS_HEADER, ROUTES_HEADER } from "./master-import.test-util";

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: 1, tenantId: 1, clientId: null, name: "PH", email: "ph@despl.test", roles: [ROLES.PRODUCTION_HEAD],
  departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false, ...over,
});

describe("dryRunMasterImport — pure refusals (before any DB read)", () => {
  it("refuses a role that may not see master-data planning", async () => {
    for (const roles of [[ROLES.SUPERVISOR], [ROLES.QC]]) {
      await expect(dryRunMasterImport(actor({ roles }), Buffer.from(""))).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    }
  });
  it("refuses a client user before the role check", async () => {
    await expect(dryRunMasterImport(actor({ clientId: 7, roles: [ROLES.ADMIN] }), Buffer.from(""))).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });
});

/**
 * DB-backed coverage: RUN_DB_TESTS=1 + DIRECT_URL, disposable orgs.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org codes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("dryRunWithDb (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { dryRunWithDb, dryRunMasterImport: dryRun } = await import("./master-import.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  async function tenant(suffix: string) {
    const stamp = `${Date.now()}-${Math.random()}`;
    const org = await owner.organization.create({ data: { code: `TEST-M2-${suffix}-${stamp}`, name: `m2 ${suffix}` } });
    const tenantId = org.id;
    const stores = await owner.department.create({ data: { tenantId, code: "STORES", name: "Stores" } });
    const qc = await owner.department.create({ data: { tenantId, code: "QC", name: "Quality Control / QA" } });
    const pv = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const receipt = await owner.operationRef.create({ data: { tenantId, code: "RECEIPT", name: "Receipt" } });
    const mtc = await owner.operationRef.create({ data: { tenantId, code: "MTC_VERIFICATION", name: "MTC" } });
    const plate = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const user = await owner.user.create({
      data: { tenantId, email: `m2-${suffix}-${stamp}@test.local`, username: `m2-${suffix}-${stamp}`, passwordHash: "x", name: "PH" },
    });
    return { tenantId, stores, qc, pv, receipt, mtc, plate, user };
  }

  const empty = { header: ["Example?", "x"], rows: [] as string[][] };
  function workbook(over: { status?: string; routeSource?: string; time2?: string } = {}) {
    return makeWorkbook({
      "Parts Master": {
        header: PARTS_HEADER,
        rows: [["PILOT", "SHL-01", "Shell Course", "PV", "Shell", "Made in-house", "Plate", "SA516", "ID, T, L", "Rolled shell (ID, T, L)", "A", "No", over.routeSource ?? "Current shop practice", "", "", over.status ?? "Approved by Production Head", ""]],
      },
      "Part Routes": {
        header: ROUTES_HEADER,
        rows: [
          ["PILOT", "SHL-01", "Shell Course", "A", "10", "Receipt", "Plate received", "Stores", "10", "", "0.5", "Hours", "Per piece", "No", "", "GRN accepted", "GRN", ""],
          ["PILOT", "SHL-01", "Shell Course", "A", "20", "MTC Verification / Material Identification", "MTC reviewed", "Quality Control / QA", "11", "", over.time2 ?? "0.75", "Hours", "Per material lot", "No", "", "", "", ""],
        ],
      },
      "Material Master": {
        header: ["Example?", "Material Specification", "Grade / UNS", "Product Form", "Density (g/cm³)", "Remarks"],
        rows: [["REFERENCE", "SA 516", "Gr.70", "Plate", "7.85", ""]],
      },
      "HE Stages": { ...empty, header: ["Example?", "HE Type", "Stage No.", "Stage Name"] },
      "PV Stages (ref)": {
        header: ["Stage No.", "Stage Name", "Main Activities", "Department"],
        rows: [["10", "Receipt", "", "Stores"], ["11", "Identification", "", "Quality Control / QA"]],
      },
      "Assembly Sequence": { header: ["Example?", "Equipment Type", "Activity"], rows: [] },
      "New Operations": { header: ["Example?", "Proposed Operation"], rows: [] },
      "Review Actions": { header: ["ID", "Issue or Decision Required"], rows: [] },
    });
  }

  const counts = async (tenantId: number) => ({
    types: await owner.componentTypeRef.count({ where: { tenantId } }),
    partFamilies: await owner.partFamily.count({ where: { tenantId } }),
    routes: await owner.routeTemplate.count({ where: { tenantId } }),
    steps: await owner.routeStep.count({ where: { routeVersion: { route: { tenantId } } } }),
    seqs: await owner.routeStepFamilySeq.count({ where: { tenantId } }),
    grades: await owner.materialGrade.count({ where: { tenantId } }),
  });

  it("fresh tenant: plans creates only, reads reference data from the tenant, and writes nothing", async () => {
    const t = await tenant("fresh");
    const before = await counts(t.tenantId);
    const report = await dryRunWithDb(owner, t.tenantId, workbook(), { allowDraft: false });
    expect(report.issues.filter((i) => i.severity === "ERROR")).toEqual([]);
    expect(report.plan.partFamilies).toEqual({ create: 1, update: 0, unchanged: 0, skipped: 0 });
    expect(report.plan.routes).toEqual({ create: 1, update: 0, unchanged: 0, skipped: 0 });
    expect(report.plan.stageMappingRows).toBe(2);
    expect(report.plan.materialGrades).toEqual({ create: 1, update: 0, unchanged: 0, skipped: 0 });
    expect(await counts(t.tenantId)).toEqual(before);
  });

  it("production mode refuses a Draft part; allowDraft plans it", async () => {
    const t = await tenant("draft");
    const prod = await dryRunWithDb(owner, t.tenantId, workbook({ status: "Draft" }), { allowDraft: false });
    expect(prod.issues.some((i) => i.code === "NOT_APPROVED")).toBe(true);
    expect(prod.plan.partFamilies.skipped).toBe(1);
    expect(prod.plan.routes.create + prod.plan.routes.update + prod.plan.routes.unchanged).toBe(0);
    const staging = await dryRunWithDb(owner, t.tenantId, workbook({ status: "Draft" }), { allowDraft: true });
    expect(staging.plan.partFamilies.create).toBe(1);
    expect(staging.plan.routes.create).toBe(1);
  });

  it("an unknown operation or department in the tenant blocks the route, not the part", async () => {
    const t = await tenant("refs");
    await owner.operationRef.delete({ where: { id: t.mtc.id } });
    const r = await dryRunWithDb(owner, t.tenantId, workbook(), { allowDraft: false });
    expect(r.issues.some((i) => i.code === "UNKNOWN_OPERATION" && i.severity === "ERROR")).toBe(true);
    expect(r.plan.partFamilies.create).toBe(1);
    expect(r.plan.routes.skipped).toBe(1);
  });

  it("reports unchanged when the tenant already holds the same master data, update when a step differs", async () => {
    const t = await tenant("same");
    const type = await owner.componentTypeRef.create({
      data: { tenantId: t.tenantId, code: "SHL-01", name: "Shell Course", kind: "PART_FAMILY" },
    });
    await owner.partFamily.create({
      data: {
        tenantId: t.tenantId, componentTypeId: type.id, equipmentScope: "PV", assemblyGroup: "Shell", makeBuy: "MADE_IN_HOUSE",
        rawFormId: t.plate.id, typicalMoc: "SA516", weightBasis: "Rolled shell (ID, T, L)", isSpare: false,
        routeSource: "Current shop practice", status: "APPROVED", approvedById: t.user.id, approvedAt: new Date(),
      },
    });
    const route = await owner.routeTemplate.create({
      data: { tenantId: t.tenantId, componentTypeId: type.id, familyId: null, name: "Shell Course", variant: "A" },
    });
    const version = await owner.routeTemplateVersion.create({ data: { routeId: route.id, version: 1, status: "PUBLISHED" } });
    const mk = async (seq: number, operationId: number, departmentId: number, time: string, basis: "PER_PIECE" | "PER_MATERIAL_LOT", acceptance: string, pv: number) => {
      const s = await owner.routeStep.create({
        data: {
          routeVersionId: version.id, seq, operationId, departmentId, stdTime: time, stdTimeUnit: "HOURS", stdTimeBasis: basis,
          acceptanceStandard: acceptance || null, recordDocument: seq === 10 ? "GRN" : null,
        },
      });
      await owner.routeStepFamilySeq.create({
        data: { tenantId: t.tenantId, routeStepId: s.id, familyId: t.pv.id, leadTimeProcessSeq: pv },
      });
    };
    await mk(10, t.receipt.id, t.stores.id, "0.5", "PER_PIECE", "GRN accepted", 10);
    await mk(20, t.mtc.id, t.qc.id, "0.75", "PER_MATERIAL_LOT", "", 11);
    await owner.materialGrade.create({
      data: { tenantId: t.tenantId, spec: "SA 516", grade: "Gr.70", productForm: "Plate", densityGcc: "7.85" },
    });

    const same = await dryRunWithDb(owner, t.tenantId, workbook(), { allowDraft: false });
    expect(same.plan.partFamilies.unchanged).toBe(1);
    expect(same.plan.routes.unchanged).toBe(1);
    expect(same.plan.materialGrades.unchanged).toBe(1);
    expect(same.plan.stageMappingRows).toBe(0);

    const changed = await dryRunWithDb(owner, t.tenantId, workbook({ time2: "0.9" }), { allowDraft: false });
    expect(changed.plan.routes).toEqual({ create: 0, update: 1, unchanged: 0, skipped: 0 });
    expect(changed.plan.partFamilies.unchanged).toBe(1);
    expect(changed.plan.stageMappingRows).toBe(2);

    const retyped = await dryRunWithDb(owner, t.tenantId, workbook({ routeSource: "Code / standard" }), { allowDraft: false });
    expect(retyped.plan.partFamilies.update).toBe(1);
  });

  it("never counts another tenant's master data as existing", async () => {
    const a = await tenant("iso-a");
    const b = await tenant("iso-b");
    const type = await owner.componentTypeRef.create({
      data: { tenantId: b.tenantId, code: "SHL-01", name: "Shell Course", kind: "PART_FAMILY" },
    });
    await owner.partFamily.create({ data: { tenantId: b.tenantId, componentTypeId: type.id } });
    const report = await dryRunWithDb(owner, a.tenantId, workbook(), { allowDraft: false });
    expect(report.plan.partFamilies).toEqual({ create: 1, update: 0, unchanged: 0, skipped: 0 });
  });

  it("the actor entry point runs under RLS for a Production Head and returns the same plan", async () => {
    const t = await tenant("actor");
    const report = await dryRun(
      actor({ userId: t.user.id, tenantId: t.tenantId }),
      workbook(),
      { allowDraft: false },
    );
    expect(report.plan.partFamilies.create).toBe(1);
    expect(report.plan.stageMappingRows).toBe(2);
  });
});
