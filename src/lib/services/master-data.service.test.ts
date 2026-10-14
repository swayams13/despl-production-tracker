import { describe, expect, it } from "vitest";
import { ROLES, type Actor, type RoleCode } from "@/lib/authz";
import { ERROR_CODES } from "@/lib/shared/errors";
import {
  approvePartFamily,
  editPartFamily,
  revisePartFamily,
  saveRouteDraft,
  setMaterialStatus,
  setPartFamilyReviewed,
  upsertMaterialGrade,
} from "./master-data.service";
import { standardWorkbook } from "./master-import.test-util";

const mk = (roles: RoleCode[], over: Partial<Actor> = {}): Actor => ({
  userId: 1, tenantId: 1, clientId: null, name: "x", email: "x@despl.test", roles, departmentIds: [],
  mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false, ...over,
});

describe("master-data service — pure refusals (before any DB read)", () => {
  const step = { seq: 10, operationCode: "RECEIPT" };
  it("roles that may not edit master data are refused", async () => {
    for (const roles of [[ROLES.SUPERVISOR], [ROLES.QC], [ROLES.PLANNER], [ROLES.MANAGEMENT]]) {
      const a = mk(roles);
      await expect(setPartFamilyReviewed(a, { partFamilyId: 1 })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      await expect(editPartFamily(a, { partFamilyId: 1, patch: { isSpare: true } })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      await expect(saveRouteDraft(a, { partFamilyId: 1, variant: "A", steps: [step] })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      await expect(revisePartFamily(a, { partFamilyId: 1, reason: "needs a change" })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      await expect(upsertMaterialGrade(a, { spec: "SA 516", productForm: "Plate" })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    }
  });
  it("only the Production Head approves, not Admin or Engineering", async () => {
    for (const roles of [[ROLES.ADMIN], [ROLES.ENGINEERING], [ROLES.ADMIN, ROLES.ENGINEERING]]) {
      await expect(approvePartFamily(mk(roles), { partFamilyId: 1 })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      await expect(setMaterialStatus(mk(roles), { materialGradeId: 1, to: "APPROVED" })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    }
  });
  it("client users are refused first", async () => {
    await expect(approvePartFamily(mk([ROLES.PRODUCTION_HEAD], { clientId: 3 }), { partFamilyId: 1 })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });
  it("a revision needs a reason, a route needs a step, a time needs a unit", async () => {
    const eng = mk([ROLES.ENGINEERING]);
    await expect(revisePartFamily(eng, { partFamilyId: 1, reason: "" })).rejects.toThrow();
    await expect(saveRouteDraft(eng, { partFamilyId: 1, variant: "A", steps: [] })).rejects.toThrow();
    await expect(saveRouteDraft(eng, { partFamilyId: 1, variant: "a", steps: [step] })).rejects.toThrow();
    await expect(
      saveRouteDraft(eng, { partFamilyId: 1, variant: "A", steps: [{ ...step, stdTime: 1 }] }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
    await expect(
      saveRouteDraft(eng, { partFamilyId: 1, variant: "A", steps: [step, { ...step }] }),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
  });
});

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

/**
 * DB-backed. Parts are created through the real importer (`applyMasterImport`)
 * so the editor and approval are exercised on exactly what an import produces.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org codes.
 */
describe.skipIf(!RUN_DB)("master-data service (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { applyMasterImport } = await import("./master-import.apply");
  const { materializeComponentsFromBomItems } = await import("./component.service");
  const { withTenant } = await import("@/lib/db");
  const { createOrReviseRouteTemplate } = await import("./route.service");
  const { loadRouteTemplateAdmin } = await import("./job-intake.read");
  const { importBomItems } = await import("./bom.service");
  const { loadPartFamilies, loadPartFamily, loadMaterialGrades } = await import("./master-data.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  async function tenant(suffix: string) {
    const stamp = `${Date.now()}-${Math.random()}`;
    const org = await owner.organization.create({ data: { code: `TEST-M3A-${suffix}-${stamp}`, name: `m3a ${suffix}` } });
    const tenantId = org.id;
    const stores = await owner.department.create({ data: { tenantId, code: "STORES", name: "Stores" } });
    const qc = await owner.department.create({ data: { tenantId, code: "QC", name: "Quality Control / QA" } });
    const pv = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    await owner.productFamily.create({ data: { tenantId, code: "HEAT_EXCHANGER", name: "HE" } });
    await owner.operationRef.create({ data: { tenantId, code: "RECEIPT", name: "Receipt" } });
    await owner.operationRef.create({ data: { tenantId, code: "MTC_VERIFICATION", name: "MTC" } });
    await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: pv.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED" } });
    for (const [seq, code, name, dept] of [[10, "10", "Material receipt", stores.id], [11, "11", "Identification", qc.id], [12, "12", "Cutting", stores.id]] as const) {
      await owner.templateProcess.create({ data: { versionId: tv.id, seq, code, name, defaultDepartmentId: dept, workOrderStages: [] } });
    }
    const users: Record<string, Actor> = {};
    for (const [key, role] of [["ph", ROLES.PRODUCTION_HEAD], ["ph2", ROLES.PRODUCTION_HEAD], ["eng", ROLES.ENGINEERING], ["admin", ROLES.ADMIN], ["planner", ROLES.PLANNER], ["sup", ROLES.SUPERVISOR]] as const) {
      const u = await owner.user.create({
        data: { tenantId, email: `m3a-${key}-${suffix}-${stamp}@test.local`, username: `m3a-${key}-${suffix}-${stamp}`, passwordHash: "x", name: key },
      });
      users[key] = mk([role], { userId: u.id, tenantId });
    }
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${suffix}-${stamp}` } });
    const job = await owner.job.create({
      data: { tenantId, publicId: `pub-m3a-${suffix}-${stamp}`, clientId: client.id, familyId: pv.id, templateVersionId: tv.id, jobNumber: `JOB-M3A-${suffix}-${stamp}` },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    return {
      tenantId, stores, qc, pv, tv, job, equipment,
      ph: users.ph, ph2: users.ph2, eng: users.eng, admin: users.admin, planner: users.planner, sup: users.sup,
    };
  }

  type T = Awaited<ReturnType<typeof tenant>>;
  /** A DRAFT part SHL-01 exactly as an import (staging) leaves it. */
  async function draftPart(t: T, over: Parameters<typeof standardWorkbook>[0] = {}) {
    await applyMasterImport(t.admin, standardWorkbook({ status: "Draft", ...over }), { allowDraft: true });
    const type = await owner.componentTypeRef.findFirstOrThrow({ where: { tenantId: t.tenantId, code: over.code ?? "SHL-01" } });
    return owner.partFamily.findUniqueOrThrow({ where: { componentTypeId: type.id } });
  }
  const versions = (t: T, typeId: number) =>
    owner.routeTemplateVersion.findMany({
      where: { route: { tenantId: t.tenantId, componentTypeId: typeId } },
      orderBy: { version: "asc" },
      include: { steps: { orderBy: { seq: "asc" } } },
    });
  const audit = (t: T, action: string) => owner.auditLog.count({ where: { tenantId: t.tenantId, action } });

  describe("approval", () => {
    it("is blocked, with reasons, while the route source is assumed or a step has no department — and nothing changes", async () => {
      const t = await tenant("blocked");
      const part = await draftPart(t, { routeSource: "Assumed – to be confirmed" });
      await expect(approvePartFamily(t.ph, { partFamilyId: part.id })).rejects.toMatchObject({
        code: ERROR_CODES.APPROVAL_BLOCKED,
        detail: { blockers: [expect.objectContaining({ code: "ROUTE_SOURCE" })] },
      });
      expect((await owner.partFamily.findUniqueOrThrow({ where: { id: part.id } })).status).toBe("DRAFT");
      expect((await versions(t, part.componentTypeId))[0].status).toBe("DRAFT");
      expect(await audit(t, "masterData.partFamily.approve")).toBe(0);

      // Fix the source, then leave a step without a department: still blocked.
      await editPartFamily(t.eng, { partFamilyId: part.id, patch: { routeSource: "Current shop practice" } });
      await saveRouteDraft(t.eng, {
        partFamilyId: part.id, variant: "A",
        steps: [{ seq: 10, operationCode: "RECEIPT", department: "", pvStage: 10 }, { seq: 20, operationCode: "MTC_VERIFICATION", department: "Quality Control / QA", pvStage: 11 }],
      });
      await expect(approvePartFamily(t.ph, { partFamilyId: part.id })).rejects.toMatchObject({
        code: ERROR_CODES.APPROVAL_BLOCKED,
        detail: { blockers: [expect.objectContaining({ code: "MISSING_DEPARTMENT", seq: 10 })] },
      });
    });

    it("the single Production Head may approve what he edited himself, and it is flagged as self-approved", async () => {
      const t = await tenant("self-approve");
      const part = await draftPart(t);
      await editPartFamily(t.ph, { partFamilyId: part.id, patch: { assemblyGroup: "Shell" } });

      const detail = await loadPartFamily(t.ph, part.id);
      expect(detail).toMatchObject({ willSelfApprove: true, selfApproved: false });
      expect(detail?.approveRefusal).toBeNull();

      const r = await approvePartFamily(t.ph, { partFamilyId: part.id });
      expect(r.selfApproved).toBe(true);
      const row = await owner.partFamily.findUniqueOrThrow({ where: { id: part.id } });
      expect(row).toMatchObject({ status: "APPROVED", approvedById: t.ph.userId, preparedById: t.ph.userId });

      expect(await loadPartFamily(t.ph, part.id)).toMatchObject({ selfApproved: true, willSelfApprove: false });
      const entry = await owner.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, action: "masterData.partFamily.approve" } });
      expect(entry.after).toMatchObject({ selfApproved: true });
    });

    it("an approval of someone else's edit is not flagged", async () => {
      const t = await tenant("peer-approve");
      const part = await draftPart(t);
      await editPartFamily(t.eng, { partFamilyId: part.id, patch: { typicalMoc: "SA240" } });
      expect(await loadPartFamily(t.ph, part.id)).toMatchObject({ willSelfApprove: false });
      const r = await approvePartFamily(t.ph, { partFamilyId: part.id });
      expect(r.selfApproved).toBe(false);
      expect(await loadPartFamily(t.ph, part.id)).toMatchObject({ selfApproved: false, approvedBy: expect.any(String) });
    });

    it("self-approval does not weaken who may approve, nor what blocks it", async () => {
      const t = await tenant("self-blocked");
      const part = await draftPart(t, { routeSource: "Assumed – to be confirmed" });
      await editPartFamily(t.ph, { partFamilyId: part.id, patch: { isSpare: true } });
      await expect(approvePartFamily(t.ph, { partFamilyId: part.id })).rejects.toMatchObject({ code: ERROR_CODES.APPROVAL_BLOCKED });
      await editPartFamily(t.eng, { partFamilyId: part.id, patch: { routeSource: "Current shop practice" } });
      await expect(approvePartFamily(t.admin, { partFamilyId: part.id })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      await expect(approvePartFamily(t.eng, { partFamilyId: part.id })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      expect((await approvePartFamily(t.ph, { partFamilyId: part.id })).selfApproved).toBe(false);
    });

    it("the person who last edited a part cannot mark it reviewed; someone else can", async () => {
      const t = await tenant("self-review");
      const part = await draftPart(t);
      await editPartFamily(t.eng, { partFamilyId: part.id, patch: { typicalMoc: "SA240" } });
      await expect(setPartFamilyReviewed(t.eng, { partFamilyId: part.id })).rejects.toMatchObject({ code: ERROR_CODES.MAKER_CHECKER_VIOLATION });
      await setPartFamilyReviewed(t.admin, { partFamilyId: part.id });
      expect((await owner.partFamily.findUniqueOrThrow({ where: { id: part.id } })).status).toBe("REVIEWED");
    });

    it("publishes every DRAFT variant, stamps the approver from the DB clock, and audits", async () => {
      const t = await tenant("approve");
      const part = await draftPart(t);
      await setPartFamilyReviewed(t.eng, { partFamilyId: part.id });
      expect((await owner.partFamily.findUniqueOrThrow({ where: { id: part.id } })).status).toBe("REVIEWED");

      const r = await approvePartFamily(t.ph, { partFamilyId: part.id });
      expect(r.published).toEqual([{ variant: "A", version: 1 }]);
      const after = await owner.partFamily.findUniqueOrThrow({ where: { id: part.id } });
      expect(after).toMatchObject({ status: "APPROVED", approvedById: t.ph.userId });
      expect(after.approvedAt).not.toBeNull();
      expect((await versions(t, part.componentTypeId))[0].status).toBe("PUBLISHED");
      expect(await audit(t, "masterData.partFamily.approve")).toBe(1);
      expect(await audit(t, "masterData.route.publish")).toBe(1);
      await expect(approvePartFamily(t.ph, { partFamilyId: part.id })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
    });

    it("another tenant's Production Head cannot see or approve it", async () => {
      const a = await tenant("iso-a");
      const b = await tenant("iso-b");
      const part = await draftPart(a);
      await expect(approvePartFamily(b.ph, { partFamilyId: part.id })).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
    });
  });

  describe("editing and revising", () => {
    it("an approved part is not edited in place; revising (with a reason) reopens it and the PUBLISHED route stays live", async () => {
      const t = await tenant("revise");
      const part = await draftPart(t);
      await approvePartFamily(t.ph, { partFamilyId: part.id });

      await expect(editPartFamily(t.eng, { partFamilyId: part.id, patch: { typicalMoc: "SA240" } })).rejects.toMatchObject({ code: ERROR_CODES.REVISE_REQUIRED });
      await expect(
        saveRouteDraft(t.eng, { partFamilyId: part.id, variant: "A", steps: [{ seq: 10, operationCode: "RECEIPT", department: "Stores", pvStage: 10 }] }),
      ).rejects.toMatchObject({ code: ERROR_CODES.REVISE_REQUIRED });

      await revisePartFamily(t.eng, { partFamilyId: part.id, reason: "Client changed the MOC" });
      const after = await owner.partFamily.findUniqueOrThrow({ where: { id: part.id } });
      expect(after).toMatchObject({ status: "DRAFT", approvedById: null, approvedAt: null });
      expect((await versions(t, part.componentTypeId))[0].status).toBe("PUBLISHED");

      await editPartFamily(t.eng, { partFamilyId: part.id, patch: { typicalMoc: "SA240" } });
      expect((await owner.partFamily.findUniqueOrThrow({ where: { id: part.id } })).typicalMoc).toBe("SA240");
      expect(await audit(t, "masterData.partFamily.revise")).toBe(1);
    });

    it("editing a REVIEWED part sends it back to DRAFT", async () => {
      const t = await tenant("rereview");
      const part = await draftPart(t);
      await setPartFamilyReviewed(t.eng, { partFamilyId: part.id });
      await editPartFamily(t.eng, { partFamilyId: part.id, patch: { assemblyGroup: "Shell" } });
      expect((await owner.partFamily.findUniqueOrThrow({ where: { id: part.id } })).status).toBe("DRAFT");
    });
  });

  describe("saveRouteDraft", () => {
    const base = { seq: 10, operationCode: "RECEIPT", department: "Stores", pvStage: 10 };

    it("refuses an unknown operation, department or stage, with the finding for each", async () => {
      const t = await tenant("structural");
      const part = await draftPart(t);
      const tries: Array<[string, Record<string, unknown>, string]> = [
        ["operation", { operationCode: "LEVITATION" }, "UNKNOWN_OPERATION"],
        ["department", { department: "Mars" }, "UNKNOWN_DEPARTMENT"],
        ["stage", { pvStage: 99 }, "UNKNOWN_STAGE_NUMBER"],
      ];
      for (const [, over, code] of tries) {
        await expect(saveRouteDraft(t.eng, { partFamilyId: part.id, variant: "A", steps: [{ ...base, ...over }] })).rejects.toMatchObject({
          code: ERROR_CODES.VALIDATION_FAILED,
          detail: { findings: [expect.objectContaining({ code })] },
        });
      }
    });

    it("refuses to switch QC off for a step while decision D3 is not recorded", async () => {
      const t = await tenant("d3");
      const part = await draftPart(t);
      await expect(
        saveRouteDraft(t.eng, { partFamilyId: part.id, variant: "A", steps: [{ ...base, requiresQc: false }] }),
      ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
      const vs = await versions(t, part.componentTypeId);
      expect(vs[0].steps.every((s) => s.requiresQc)).toBe(true);
    });

    it("replaces a DRAFT in place, writes stage mappings, and reports readiness; the same save again is a no-op", async () => {
      const t = await tenant("draft-save");
      const part = await draftPart(t);
      const steps = [
        { ...base, stdTime: 0.6, stdTimeUnit: "HOURS" as const, stdTimeBasis: "PER_PIECE" as const },
        { seq: 20, operationCode: "MTC_VERIFICATION", department: "Quality Control / QA", pvStage: 11 },
      ];
      const r = await saveRouteDraft(t.eng, { partFamilyId: part.id, variant: "A", steps });
      expect(r).toMatchObject({ variant: "A", version: 1, status: "DRAFT", action: "replaced" });
      expect(r.readiness.blockers).toEqual([]);
      const vs = await versions(t, part.componentTypeId);
      expect(vs).toHaveLength(1);
      expect(vs[0].steps[0].stdTime?.toString()).toBe("0.6");
      expect(vs[0].steps[1].requiresQc).toBe(true);
      expect(await owner.routeStepFamilySeq.count({ where: { tenantId: t.tenantId } })).toBe(2);

      const again = await saveRouteDraft(t.eng, { partFamilyId: part.id, variant: "A", steps });
      expect(again.action).toBe("unchanged");
    });

    it("a revised part gets a NEW draft version; the published one is untouched", async () => {
      const t = await tenant("new-version");
      const part = await draftPart(t);
      await approvePartFamily(t.ph, { partFamilyId: part.id });
      await revisePartFamily(t.eng, { partFamilyId: part.id, reason: "Time study done" });
      const r = await saveRouteDraft(t.eng, {
        partFamilyId: part.id, variant: "A",
        steps: [{ ...base, stdTime: 0.9, stdTimeUnit: "HOURS", stdTimeBasis: "PER_PIECE" }, { seq: 20, operationCode: "MTC_VERIFICATION", department: "Quality Control / QA", pvStage: 11 }],
      });
      expect(r).toMatchObject({ version: 2, status: "DRAFT", action: "versioned" });
      const vs = await versions(t, part.componentTypeId);
      expect(vs.map((v) => [v.version, v.status])).toEqual([[1, "PUBLISHED"], [2, "DRAFT"]]);
      expect(vs[0].steps[0].stdTime?.toString()).toBe("0.5");
    });
  });

  describe("spec accept: a job created after approval uses the new version; an existing job keeps the old one", () => {
    const base = { seq: 10, operationCode: "RECEIPT", department: "Stores", pvStage: 10 };
    it("pins each component to the version that was PUBLISHED when it was materialised", async () => {
      const t = await tenant("accept");
      const part = await draftPart(t);
      await approvePartFamily(t.ph, { partFamilyId: part.id });
      const bom = (n: number) =>
        owner.bomItem.create({
          data: { jobId: t.job.id, equipmentId: t.equipment.id, itemNo: n, partName: `Shell ${n}`, sourceQty: "1", componentTypeId: part.componentTypeId },
        });
      const materialise = (bomItemId: number) =>
        withTenant(t.tenantId, (tx) => materializeComponentsFromBomItems(tx, t.pv.id, t.equipment.id, [bomItemId], t.job.id));
      const routeOf = async (bomItemId: number) => (await owner.component.findFirstOrThrow({ where: { bomItemId } })).routeVersionId;

      const first = await bom(1);
      await materialise(first.id);
      const v1 = (await versions(t, part.componentTypeId))[0].id;
      expect(await routeOf(first.id)).toBe(v1);

      await revisePartFamily(t.eng, { partFamilyId: part.id, reason: "New acceptance standard" });
      await saveRouteDraft(t.eng, {
        partFamilyId: part.id, variant: "A",
        steps: [{ ...base, acceptanceStandard: "Rev 2" }, { seq: 20, operationCode: "MTC_VERIFICATION", department: "Quality Control / QA", pvStage: 11 }],
      });

      // While v2 is only a DRAFT, new work still gets v1.
      const during = await bom(2);
      await materialise(during.id);
      expect(await routeOf(during.id)).toBe(v1);

      await approvePartFamily(t.ph, { partFamilyId: part.id });
      const v2 = (await versions(t, part.componentTypeId))[1].id;
      const after = await bom(3);
      await materialise(after.id);
      expect(await routeOf(after.id)).toBe(v2);
      expect(await routeOf(first.id)).toBe(v1);
    });
  });

  describe("material grades", () => {
    it("create → review → approve (Production Head) → revise needs a reason → edit approved is refused", async () => {
      const t = await tenant("materials");
      const { id } = await upsertMaterialGrade(t.eng, { spec: "SA 516", grade: "Gr.70", productForm: "Plate", densityGcc: 7.85 });
      await expect(upsertMaterialGrade(t.eng, { spec: "SA 516", grade: "Gr.70", productForm: "Plate", densityGcc: 7.9 })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });

      await setMaterialStatus(t.eng, { materialGradeId: id, to: "REVIEWED" });
      await expect(setMaterialStatus(t.eng, { materialGradeId: id, to: "APPROVED" })).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      await setMaterialStatus(t.ph, { materialGradeId: id, to: "APPROVED" });
      await expect(upsertMaterialGrade(t.eng, { id, spec: "SA 516", grade: "Gr.70", productForm: "Plate", densityGcc: 7.9 })).rejects.toMatchObject({ code: ERROR_CODES.REVISE_REQUIRED });
      await expect(setMaterialStatus(t.ph, { materialGradeId: id, to: "DRAFT" })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
      await setMaterialStatus(t.ph, { materialGradeId: id, to: "DRAFT", reason: "Density from the new MTC" });
      await upsertMaterialGrade(t.eng, { id, spec: "SA 516", grade: "Gr.70", productForm: "Plate", densityGcc: 7.9 });
      expect((await owner.materialGrade.findUniqueOrThrow({ where: { id } })).densityGcc?.toString()).toBe("7.9");
    });

    it("a grade with no density cannot be approved", async () => {
      const t = await tenant("no-density");
      const { id } = await upsertMaterialGrade(t.eng, { spec: "SA 106", grade: "Gr.B", productForm: "Pipe" });
      await expect(setMaterialStatus(t.ph, { materialGradeId: id, to: "APPROVED" })).rejects.toMatchObject({ code: ERROR_CODES.APPROVAL_BLOCKED });
    });
  });

  describe("read models", () => {
    it("list: totals, filters and blockers; PLANNER reads but cannot edit; SUPERVISOR is refused", async () => {
      const t = await tenant("read");
      const ready = await draftPart(t);
      await applyMasterImport(t.admin, standardWorkbook({ status: "Draft", code: "HED-01", routeSource: "Assumed – to be confirmed" }), { allowDraft: true });
      await approvePartFamily(t.ph, { partFamilyId: ready.id });

      const list = await loadPartFamilies(t.planner);
      expect(list.canEdit).toBe(false);
      expect(list.totals).toMatchObject({ all: 2, approved: 1, draft: 1, withBlockers: 1 });
      expect(list.rows.find((r) => r.code === "SHL-01")).toMatchObject({ status: "APPROVED", variants: ["A"], steps: 2, blockers: 0 });
      expect(list.rows.find((r) => r.code === "HED-01")).toMatchObject({ status: "DRAFT", blockers: 1, draftVariants: 1 });
      expect((await loadPartFamilies(t.planner, { hasBlockers: true })).rows.map((r) => r.code)).toEqual(["HED-01"]);
      expect((await loadPartFamilies(t.planner, { status: "APPROVED" })).rows.map((r) => r.code)).toEqual(["SHL-01"]);
      expect((await loadPartFamilies(t.planner, { q: "hed" })).rows.map((r) => r.code)).toEqual(["HED-01"]);
      expect((await loadPartFamilies(t.eng)).canEdit).toBe(true);
      await expect(loadPartFamilies(t.sup)).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    });

    it("detail: what each role may do, and why approve is unavailable", async () => {
      const t = await tenant("detail");
      const blocked = await draftPart(t, { routeSource: "Assumed – to be confirmed" });
      const asHead = await loadPartFamily(t.ph, blocked.id);
      expect(asHead?.can).toEqual({ edit: true, review: true, approve: false, revise: false });
      expect(asHead?.approveRefusal).toMatch(/1 thing to fix/);
      expect((await loadPartFamily(t.eng, blocked.id))?.approveRefusal).toBe("Only the Production Head approves master data.");
      expect((await loadPartFamily(t.planner, blocked.id))?.can).toEqual({ edit: false, review: false, approve: false, revise: false });
      expect(asHead?.reference.pvStages.map((s) => s.no)).toEqual([10, 11, 12]);
      expect(asHead?.variants[0].steps).toHaveLength(2);
      expect(await loadPartFamily(t.ph, 999999999)).toBeNull();
    });

    it("materials list reflects role capabilities", async () => {
      const t = await tenant("mat-read");
      await upsertMaterialGrade(t.eng, { spec: "SA 516", grade: "Gr.70", productForm: "Plate", densityGcc: 7.85 });
      const asHead = await loadMaterialGrades(t.ph);
      expect(asHead.rows).toHaveLength(1);
      expect(asHead).toMatchObject({ canEdit: true, canApprove: true });
      expect(await loadMaterialGrades(t.eng)).toMatchObject({ canEdit: true, canApprove: false });
      expect(await loadMaterialGrades(t.planner)).toMatchObject({ canEdit: false, canApprove: false });
    });
  });

  describe("hardening: legacy screens cannot bypass approval", () => {
    it("the legacy route editor refuses a part-family type, and no longer lists part families", async () => {
      const t = await tenant("legacy");
      const part = await draftPart(t);
      await expect(
        createOrReviseRouteTemplate(t.admin, {
          componentTypeId: part.componentTypeId, familyId: null, name: "x",
          steps: [{ seq: 1, optional: false, operationId: 1 }],
        }),
      ).rejects.toMatchObject({ code: ERROR_CODES.USE_MASTER_DATA });
      const admin = await loadRouteTemplateAdmin(t.admin);
      expect(admin.componentTypes.map((c) => c.componentTypeCode)).not.toContain("SHL-01");
      expect(admin.componentTypes.map((c) => c.componentTypeCode)).toContain("PLATE");
    });

    it("a BOM import resolves a part-family code only once the family is approved", async () => {
      const t = await tenant("bomcode");
      const part = await draftPart(t);
      const rows = [{ itemNo: 1, partName: "Shell", sourceQty: "1 NOS", componentType: "SHL-01" }];
      await expect(importBomItems(t.admin, { equipmentId: t.equipment.id, rows })).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
      await approvePartFamily(t.ph, { partFamilyId: part.id });
      const ok = await importBomItems(t.admin, { equipmentId: t.equipment.id, rows });
      expect(ok.created[0].componentTypeId).toBe(part.componentTypeId);
    });
  });
});
