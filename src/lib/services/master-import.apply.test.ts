import { describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES } from "@/lib/shared/errors";
import { applyMasterImport } from "./master-import.apply";
import { makeWorkbook, PARTS_HEADER, standardWorkbook } from "./master-import.test-util";

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: 1, tenantId: 1, clientId: null, name: "PH", email: "ph@despl.test", roles: [ROLES.PRODUCTION_HEAD],
  departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false, ...over,
});

describe("applyMasterImport — pure refusals (before any DB read)", () => {
  it("refuses roles that may not change master data, and client users", async () => {
    for (const a of [actor({ roles: [ROLES.SUPERVISOR] }), actor({ roles: [ROLES.QC] }), actor({ clientId: 9, roles: [ROLES.ADMIN] })]) {
      await expect(applyMasterImport(a, Buffer.from(""))).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
    }
  });
});

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

/**
 * DB-backed apply coverage. Violation cases first (who may approve, what is
 * refused), then the lifecycle: create, idempotent re-apply, new version vs
 * in-place draft, publish on approval.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org codes.
 */
describe.skipIf(!RUN_DB)("applyMasterImport (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  async function tenant(suffix: string) {
    const stamp = `${Date.now()}-${Math.random()}`;
    const org = await owner.organization.create({ data: { code: `TEST-M2B-${suffix}-${stamp}`, name: `m2b ${suffix}` } });
    const tenantId = org.id;
    const stores = await owner.department.create({ data: { tenantId, code: "STORES", name: "Stores" } });
    const qc = await owner.department.create({ data: { tenantId, code: "QC", name: "Quality Control / QA" } });
    const pv = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const he = await owner.productFamily.create({ data: { tenantId, code: "HEAT_EXCHANGER", name: "HE" } });
    await owner.operationRef.create({ data: { tenantId, code: "RECEIPT", name: "Receipt" } });
    await owner.operationRef.create({ data: { tenantId, code: "MTC_VERIFICATION", name: "MTC" } });
    const plate = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const user = await owner.user.create({
      data: { tenantId, email: `m2b-${suffix}-${stamp}@test.local`, username: `m2b-${suffix}-${stamp}`, passwordHash: "x", name: "PH" },
    });
    const ph: Actor = actor({ userId: user.id, tenantId });
    const admin: Actor = actor({ userId: user.id, tenantId, roles: [ROLES.ADMIN] });
    return { tenantId, stores, qc, pv, he, plate, user, ph, admin };
  }

  const state = async (tenantId: number) => ({
    types: await owner.componentTypeRef.count({ where: { tenantId } }),
    partFamilies: await owner.partFamily.count({ where: { tenantId } }),
    routes: await owner.routeTemplate.count({ where: { tenantId } }),
    versions: await owner.routeTemplateVersion.count({ where: { route: { tenantId } } }),
    steps: await owner.routeStep.count({ where: { routeVersion: { route: { tenantId } } } }),
    seqs: await owner.routeStepFamilySeq.count({ where: { tenantId } }),
    grades: await owner.materialGrade.count({ where: { tenantId } }),
    templates: await owner.processTemplate.count({ where: { tenantId } }),
    audit: await owner.auditLog.count({ where: { tenantId } }),
  });

  describe("refusals", () => {
    it("an Admin who is not the Production Head cannot load an approved part, and nothing is written", async () => {
      const t = await tenant("admin");
      const before = await state(t.tenantId);
      await expect(applyMasterImport(t.admin, standardWorkbook())).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
      expect(await state(t.tenantId)).toEqual(before);
    });

    it("an Admin may load Draft parts for staging (allowDraft); they are DRAFT with no approver", async () => {
      const t = await tenant("admin-draft");
      const r = await applyMasterImport(t.admin, standardWorkbook({ status: "Draft" }), { allowDraft: true });
      expect(r.written.partFamilies.create).toBe(1);
      const pf = await owner.partFamily.findFirstOrThrow({ where: { tenantId: t.tenantId } });
      expect(pf).toMatchObject({ status: "DRAFT", approvedById: null, approvedAt: null, preparedById: null });
    });

    it("production mode (no allowDraft) loads no Draft part", async () => {
      const t = await tenant("prod-draft");
      const r = await applyMasterImport(t.ph, standardWorkbook({ status: "Draft" }));
      expect(r.written.partFamilies).toMatchObject({ create: 0, skipped: 1 });
      expect(r.report.issues.some((i) => i.code === "NOT_APPROVED")).toBe(true);
      expect((await state(t.tenantId)).partFamilies).toBe(0);
    });

    it("a workbook missing a sheet the importer needs is refused outright, with nothing written", async () => {
      const t = await tenant("missing");
      const before = await state(t.tenantId);
      const incomplete = makeWorkbook({ "Parts Master": { header: PARTS_HEADER, rows: [] } });
      await expect(applyMasterImport(t.ph, incomplete)).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
      expect(await state(t.tenantId)).toEqual(before);
    });

    it("an import never demotes an approved part", async () => {
      const t = await tenant("downgrade");
      await applyMasterImport(t.ph, standardWorkbook());
      const r = await applyMasterImport(t.ph, standardWorkbook({ status: "Draft" }), { allowDraft: true });
      expect(r.report.issues.some((i) => i.code === "STATUS_DOWNGRADE")).toBe(true);
      expect(r.written.partFamilies.skipped).toBe(1);
      const pf = await owner.partFamily.findFirstOrThrow({ where: { tenantId: t.tenantId } });
      expect(pf.status).toBe("APPROVED");
    });

    it("a part code already used by a legacy component type is skipped and the legacy type is untouched", async () => {
      const t = await tenant("conflict");
      await owner.componentTypeRef.create({ data: { tenantId: t.tenantId, code: "SHL-01", name: "Legacy shell" } });
      const r = await applyMasterImport(t.ph, standardWorkbook());
      expect(r.report.issues.some((i) => i.code === "PART_CODE_CONFLICT")).toBe(true);
      expect(r.written.partFamilies.skipped).toBe(1);
      const legacy = await owner.componentTypeRef.findFirstOrThrow({ where: { tenantId: t.tenantId, code: "SHL-01" } });
      expect(legacy).toMatchObject({ kind: "RAW_FORM", name: "Legacy shell" });
      expect(await owner.partFamily.count({ where: { tenantId: t.tenantId } })).toBe(0);
    });
  });

  describe("a part that changed under the import (row lock, maker-checker)", () => {
    const partOf = (tenantId: number) => owner.partFamily.findFirstOrThrow({ where: { tenantId } });

    it("an import that was planned while a part was DRAFT does not overwrite it once it is APPROVED; nothing is written", async () => {
      const t = await tenant("race");
      await applyMasterImport(t.admin, standardWorkbook({ status: "Draft" }), { allowDraft: true });
      const draft = await partOf(t.tenantId);
      const stepsBefore = await owner.routeStep.count({ where: { routeVersion: { route: { tenantId: t.tenantId } } } });

      // Another session approves the part and has not committed yet.
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((r) => (locked = r));
      const gate = new Promise<void>((r) => (release = r));
      const approver = owner.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM part_families WHERE id = ${draft.id} FOR UPDATE`;
        await tx.partFamily.update({ where: { id: draft.id }, data: { status: "APPROVED", approvedById: t.user.id, approvedAt: new Date() } });
        locked();
        await gate;
      });
      await held;

      // The importer plans against the committed DRAFT, then queues behind the row lock.
      const importing = applyMasterImport(t.admin, standardWorkbook({ status: "Draft", time2: "0.9" }), { allowDraft: true });
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const w = await owner.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
        waiting = Number(w[0].n) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBe(true);
      release();
      await approver;

      await expect(importing).rejects.toMatchObject({ code: ERROR_CODES.STALE_WRITE, detail: { kind: "PLAN_CHANGED" } });
      const after = await partOf(t.tenantId);
      expect(after).toMatchObject({ status: "APPROVED", approvedById: t.user.id });
      expect(await owner.routeStep.count({ where: { routeVersion: { route: { tenantId: t.tenantId } } } })).toBe(stepsBefore);
    }, 20_000);

    const reviewedAs = async (t: Awaited<ReturnType<typeof tenant>>, preparedById: number | null, status: "DRAFT" | "REVIEWED" = "DRAFT") => {
      await owner.partFamily.updateMany({ where: { tenantId: t.tenantId }, data: { preparedById, status } });
      const { dryRunWithDb } = await import("./master-import.service");
      const preview = await dryRunWithDb(owner, t.tenantId, standardWorkbook({ status: "Reviewed" }), { allowDraft: true, actorId: t.user.id });
      const applied = await applyMasterImport(t.admin, standardWorkbook({ status: "Reviewed" }), { allowDraft: true });
      return { preview, applied, part: await partOf(t.tenantId) };
    };

    it("the last editor cannot mark a part reviewed through an import: it loads as Draft, and the preview says so", async () => {
      const t = await tenant("prep");
      await applyMasterImport(t.admin, standardWorkbook({ status: "Draft" }), { allowDraft: true });
      const { preview, applied, part } = await reviewedAs(t, t.user.id);
      expect(preview.issues.map((i) => i.code)).toContain("REVIEW_BY_PREPARER");
      expect(applied.report.issues.map((i) => i.code)).toContain("REVIEW_BY_PREPARER");
      expect(part.status).toBe("DRAFT");
    });

    it("a part last edited by someone else can be loaded as Reviewed (the importer acts as the second person)", async () => {
      const t = await tenant("other");
      await applyMasterImport(t.admin, standardWorkbook({ status: "Draft" }), { allowDraft: true });
      const editor = await owner.user.create({
        data: { tenantId: t.tenantId, email: `ed-${Date.now()}-${Math.random()}@test.local`, username: `ed-${Date.now()}-${Math.random()}`, passwordHash: "x", name: "Ed" },
      });
      const { applied, part } = await reviewedAs(t, editor.id);
      expect(applied.report.issues.map((i) => i.code)).not.toContain("REVIEW_BY_PREPARER");
      expect(part.status).toBe("REVIEWED");
    });

    it("a part that is already REVIEWED is not pushed back to Draft by re-importing the same row", async () => {
      const t = await tenant("keep");
      await applyMasterImport(t.admin, standardWorkbook({ status: "Draft" }), { allowDraft: true });
      const { applied, part } = await reviewedAs(t, t.user.id, "REVIEWED");
      expect(applied.report.issues.map((i) => i.code)).not.toContain("REVIEW_BY_PREPARER");
      expect(part.status).toBe("REVIEWED");
    });
  });

  describe("what the user was shown (file hash and plan fingerprint)", () => {
    const shown = async (t: Awaited<ReturnType<typeof tenant>>, over: Parameters<typeof standardWorkbook>[0] = {}) => {
      const { dryRunWithDb } = await import("./master-import.service");
      return dryRunWithDb(owner, t.tenantId, standardWorkbook(over), { allowDraft: false });
    };

    it("refuses a different file than the one that was checked, and writes nothing", async () => {
      const t = await tenant("hash");
      const checked = await shown(t);
      const before = await state(t.tenantId);
      await expect(
        applyMasterImport(t.ph, standardWorkbook({ time2: "0.9" }), {
          expected: { fileSha256: checked.fileSha256, planFingerprint: checked.planFingerprint },
        }),
      ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED, detail: { kind: "FILE_CHANGED" } });
      expect(await state(t.tenantId)).toEqual(before);
    });

    it("refuses when master data moved on since the check (the creates are no longer creates)", async () => {
      const t = await tenant("plan");
      const checked = await shown(t);
      const expected = { fileSha256: checked.fileSha256, planFingerprint: checked.planFingerprint };
      await applyMasterImport(t.ph, standardWorkbook()); // someone else imports the same file first
      const before = await state(t.tenantId);
      await expect(applyMasterImport(t.ph, standardWorkbook(), { expected })).rejects.toMatchObject({
        code: ERROR_CODES.STALE_WRITE,
        detail: { kind: "PLAN_CHANGED" },
      });
      expect(await state(t.tenantId)).toEqual(before);
    });

    it("applies the plan that was shown, and records the file hash in the audit row", async () => {
      const t = await tenant("shown");
      const checked = await shown(t);
      const r = await applyMasterImport(t.ph, standardWorkbook(), {
        expected: { fileSha256: checked.fileSha256, planFingerprint: checked.planFingerprint },
        fileName: "Standard_Parts_Master.xlsx",
      });
      expect(r.written.partFamilies.create).toBe(1);
      expect(r.report.fileSha256).toBe(checked.fileSha256);
      const row = await owner.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, action: "masterImport.apply" } });
      expect(row.after).toMatchObject({ fileSha256: checked.fileSha256, fileName: "Standard_Parts_Master.xlsx" });
    });

    it("the fingerprint is stable for the same data and changes when the plan changes", async () => {
      const t = await tenant("fp");
      const a = await shown(t);
      const b = await shown(t);
      expect(b.planFingerprint).toBe(a.planFingerprint);
      expect(await shown(t, { time2: "0.9" }).then((r) => r.planFingerprint)).toBe(a.planFingerprint); // same outcomes (creates)
      expect((await shown(t, { status: "Draft" })).planFingerprint).not.toBe(a.planFingerprint);
      await applyMasterImport(t.ph, standardWorkbook());
      expect((await shown(t)).planFingerprint).not.toBe(a.planFingerprint);
    });
  });

  describe("material grades match ignoring case", () => {
    it("a case-only difference is 'unchanged' in the plan and creates no duplicate when applied", async () => {
      const t = await tenant("case");
      await applyMasterImport(t.ph, standardWorkbook());
      const { dryRunWithDb } = await import("./master-import.service");
      const preview = await dryRunWithDb(owner, t.tenantId, standardWorkbook({ materialSpec: "sa 516" }), { allowDraft: false });
      expect(preview.plan.materialGrades).toMatchObject({ unchanged: 1, create: 0 });
      const r = await applyMasterImport(t.ph, standardWorkbook({ materialSpec: "sa 516" }));
      expect(r.written.materialGrades).toMatchObject({ unchanged: 1, create: 0 });
      expect(await owner.materialGrade.count({ where: { tenantId: t.tenantId } })).toBe(1);
    });
  });

  describe("lifecycle", () => {
    it("creates part family, PUBLISHED route, stage mappings and material; the plan equals what was written", async () => {
      const t = await tenant("create");
      const r = await applyMasterImport(t.ph, standardWorkbook());
      expect(r.written).toMatchObject({
        partFamilies: { create: 1, update: 0, unchanged: 0, skipped: 0 },
        routes: { create: 1, update: 0, unchanged: 0, skipped: 0 },
        stageMappingRows: 2,
        materialGrades: { create: 1 },
        heTemplate: "skipped",
      });
      expect(r.report.plan.partFamilies.create).toBe(r.written.partFamilies.create);
      expect(r.report.plan.routes.create).toBe(r.written.routes.create);
      expect(r.report.plan.stageMappingRows).toBe(r.written.stageMappingRows);

      const type = await owner.componentTypeRef.findFirstOrThrow({ where: { tenantId: t.tenantId, code: "SHL-01" } });
      expect(type.kind).toBe("PART_FAMILY");
      const pf = await owner.partFamily.findUniqueOrThrow({ where: { componentTypeId: type.id } });
      expect(pf).toMatchObject({
        status: "APPROVED", approvedById: t.user.id, preparedById: null, equipmentScope: "PV",
        makeBuy: "MADE_IN_HOUSE", rawFormId: t.plate.id, dimensionKeys: ["ID", "T", "L"],
      });
      expect(pf.approvedAt).not.toBeNull();

      const route = await owner.routeTemplate.findFirstOrThrow({
        where: { tenantId: t.tenantId, componentTypeId: type.id },
        include: { versions: { include: { steps: { orderBy: { seq: "asc" } } } } },
      });
      expect(route).toMatchObject({ familyId: null, variant: "A" });
      expect(route.versions).toHaveLength(1);
      expect(route.versions[0]).toMatchObject({ version: 1, status: "PUBLISHED" });
      expect(route.versions[0].steps.map((s) => [s.seq, s.stdTimeStatus, s.departmentId, s.optional, s.requiresQc])).toEqual([
        [10, "PROPOSED", t.stores.id, false, true],
        [20, "PROPOSED", t.qc.id, false, true],
      ]);
      const maps = await owner.routeStepFamilySeq.findMany({ where: { tenantId: t.tenantId }, orderBy: { leadTimeProcessSeq: "asc" } });
      expect(maps.map((m) => [m.familyId, m.leadTimeProcessSeq])).toEqual([[t.pv.id, 10], [t.pv.id, 11]]);
      expect((await owner.materialGrade.findFirstOrThrow({ where: { tenantId: t.tenantId } })).status).toBe("DRAFT");
      expect(await owner.auditLog.count({ where: { tenantId: t.tenantId, action: { startsWith: "masterImport." } } })).toBeGreaterThan(3);
    });

    it("a second apply of the same workbook writes nothing", async () => {
      const t = await tenant("idem");
      await applyMasterImport(t.ph, standardWorkbook({ heStages: [["1", "Receipt", "Stores"], ["2", "Inspect", "Quality Control / QA", "1"]] }));
      const before = await state(t.tenantId);
      const again = await applyMasterImport(t.ph, standardWorkbook({ heStages: [["1", "Receipt", "Stores"], ["2", "Inspect", "Quality Control / QA", "1"]] }));
      expect(again.written).toMatchObject({
        partFamilies: { create: 0, update: 0, unchanged: 1 },
        routes: { create: 0, update: 0, unchanged: 1 },
        stageMappingRows: 0,
        materialGrades: { create: 0, update: 0, unchanged: 1 },
        heTemplate: "unchanged",
      });
      expect(await state(t.tenantId)).toEqual(before);
    });

    it("changed content on a PUBLISHED route becomes version 2; version 1 is untouched", async () => {
      const t = await tenant("v2");
      await applyMasterImport(t.ph, standardWorkbook());
      const r = await applyMasterImport(t.ph, standardWorkbook({ time2: "0.9" }));
      expect(r.written.routes).toMatchObject({ update: 1, create: 0 });
      expect(r.written.stageMappingRows).toBe(2);
      const type = await owner.componentTypeRef.findFirstOrThrow({ where: { tenantId: t.tenantId, code: "SHL-01" } });
      const versions = await owner.routeTemplateVersion.findMany({
        where: { route: { tenantId: t.tenantId, componentTypeId: type.id } },
        orderBy: { version: "asc" },
        include: { steps: { orderBy: { seq: "asc" } } },
      });
      expect(versions.map((v) => [v.version, v.status])).toEqual([[1, "PUBLISHED"], [2, "PUBLISHED"]]);
      expect(versions[0].steps[1].stdTime?.toString()).toBe("0.75");
      expect(versions[1].steps[1].stdTime?.toString()).toBe("0.9");
    });

    it("a DRAFT route is replaced in place; approving the same content publishes it", async () => {
      const t = await tenant("draft-life");
      await applyMasterImport(t.admin, standardWorkbook({ status: "Draft" }), { allowDraft: true });
      const type = await owner.componentTypeRef.findFirstOrThrow({ where: { tenantId: t.tenantId, code: "SHL-01" } });
      const versions = () =>
        owner.routeTemplateVersion.findMany({ where: { route: { tenantId: t.tenantId, componentTypeId: type.id } }, orderBy: { version: "asc" }, include: { steps: true } });

      let r = await applyMasterImport(t.admin, standardWorkbook({ status: "Draft", time2: "0.9" }), { allowDraft: true });
      expect(r.written.routes.update).toBe(1);
      let vs = await versions();
      expect(vs.map((v) => [v.version, v.status])).toEqual([[1, "DRAFT"]]);
      expect(vs[0].steps).toHaveLength(2);

      r = await applyMasterImport(t.ph, standardWorkbook({ status: "Approved by Production Head", time2: "0.9" }));
      expect(r.written.routes.update).toBe(1);
      expect(r.written.stageMappingRows).toBe(0);
      vs = await versions();
      expect(vs.map((v) => [v.version, v.status])).toEqual([[1, "PUBLISHED"]]);
      const pf = await owner.partFamily.findUniqueOrThrow({ where: { componentTypeId: type.id } });
      expect(pf).toMatchObject({ status: "APPROVED", approvedById: t.user.id });
    });

    it("the HE sheet becomes a DRAFT HEAT_EXCHANGER template with provisional processes and edges", async () => {
      const t = await tenant("he");
      const r = await applyMasterImport(t.ph, standardWorkbook({ heStages: [["1", "Receipt", "Stores"], ["2", "Inspect", "Quality Control / QA", "1"]] }));
      expect(r.written.heTemplate).toBe("create");
      const tpl = await owner.processTemplate.findFirstOrThrow({
        where: { tenantId: t.tenantId, familyId: t.he.id },
        include: { versions: { include: { processes: true, edges: true } } },
      });
      expect(tpl.versions).toHaveLength(1);
      expect(tpl.versions[0].status).toBe("DRAFT");
      expect(tpl.versions[0].processes.map((p) => [p.code, p.provisional])).toEqual(
        expect.arrayContaining([["1", true], ["2", true]]),
      );
      expect(tpl.versions[0].edges).toHaveLength(1);
    });
  });
});
