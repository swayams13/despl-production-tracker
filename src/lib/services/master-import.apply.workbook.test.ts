import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * The 11 Oct workbook (explicit M2 fixture) applied end to end into a
 * disposable tenant that mirrors DESPL's reference data (departments,
 * operations, component types, families). Never touches the DESPL tenant, so
 * the seeded DESPL-320 tests are unaffected.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const FILE = path.resolve(__dirname, "../../../docs/lean-core/inputs/2026-10-11-master-list/Standard_Parts_Master_PV_HE_SAMPLE.xlsx");

describe.skipIf(!RUN_DB || !existsSync(FILE))("apply the 11 Oct workbook (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { applyMasterImport } = await import("./master-import.apply");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  async function mirrorOfDespl() {
    const source = await owner.organization.findUnique({ where: { code: "DESPL" }, select: { id: true } });
    if (!source) return null;
    const stamp = `${Date.now()}-${Math.random()}`;
    const org = await owner.organization.create({ data: { code: `TEST-M2B-WB-${stamp}`, name: "m2b workbook" } });
    const tenantId = org.id;
    const [departments, operations, types] = await Promise.all([
      owner.department.findMany({ where: { tenantId: source.id }, select: { code: true, name: true } }),
      owner.operationRef.findMany({ where: { tenantId: source.id }, select: { code: true, name: true } }),
      // Not PART_FAMILY: those are what the import creates (db:seed adds a demo SHL-01 one), and a
      // copy without its `kind` would read as a non-part-family type and block the part's own code.
      owner.componentTypeRef.findMany({
        where: { tenantId: source.id, NOT: { kind: "PART_FAMILY" } },
        select: { code: true, name: true },
      }),
    ]);
    await owner.department.createMany({ data: departments.map((d) => ({ ...d, tenantId })) });
    await owner.operationRef.createMany({ data: operations.map((o) => ({ ...o, tenantId })) });
    await owner.componentTypeRef.createMany({ data: types.map((c) => ({ ...c, tenantId })) });
    await owner.productFamily.createMany({
      data: [
        { tenantId, code: "PRESSURE_VESSEL", name: "PV" },
        { tenantId, code: "HEAT_EXCHANGER", name: "HE" },
      ],
    });
    const user = await owner.user.create({
      data: { tenantId, email: `wb-${stamp}@test.local`, username: `wb-${stamp}`, passwordHash: "x", name: "PH" },
    });
    const ph: Actor = {
      userId: user.id, tenantId, clientId: null, name: "PH", email: "ph@despl.test", roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false,
    };
    return { tenantId, ph };
  }

  it("loads everything the dry-run calls loadable, as drafts, and a re-apply changes nothing", async () => {
    const m = await mirrorOfDespl();
    if (!m) return; // DESPL not seeded in this DB
    const bytes = readFileSync(FILE);

    const first = await applyMasterImport(m.ph, bytes, { allowDraft: true });
    expect(first.written).toMatchObject({
      partFamilies: { create: 60, update: 0, unchanged: 0, skipped: 0 },
      routes: { create: 41, update: 0, unchanged: 0, skipped: 1 },
      stageMappingRows: 283,
      materialGrades: { create: 40 },
      heTemplate: "create",
    });
    // What the dry-run promised is what was written.
    expect(first.report.plan.partFamilies.create).toBe(60);
    expect(first.report.plan.routes).toMatchObject({ create: 41, skipped: 1 });
    expect(first.report.plan.stageMappingRows).toBe(283);

    const t = m.tenantId;
    expect(await owner.partFamily.count({ where: { tenantId: t } })).toBe(60);
    expect(await owner.partFamily.count({ where: { tenantId: t, status: "APPROVED" } })).toBe(0);
    expect(await owner.routeTemplateVersion.count({ where: { route: { tenantId: t }, status: "PUBLISHED" } })).toBe(0);
    expect(await owner.routeTemplateVersion.count({ where: { route: { tenantId: t }, status: "DRAFT" } })).toBeGreaterThanOrEqual(41);
    expect(await owner.routeStepFamilySeq.count({ where: { tenantId: t } })).toBe(283);
    expect(await owner.materialGrade.count({ where: { tenantId: t } })).toBe(40);

    // TSH-02 (7 steps without department/stage): the part exists, its route does not.
    const tsh02 = await owner.componentTypeRef.findFirstOrThrow({ where: { tenantId: t, code: "TSH-02" } });
    expect(await owner.partFamily.count({ where: { componentTypeId: tsh02.id } })).toBe(1);
    expect(await owner.routeTemplate.count({ where: { tenantId: t, componentTypeId: tsh02.id } })).toBe(0);

    // ELB-01's "Pipe fitting" has no tracker type: loads without a raw form.
    const elb = await owner.componentTypeRef.findFirstOrThrow({ where: { tenantId: t, code: "ELB-01" } });
    expect((await owner.partFamily.findUniqueOrThrow({ where: { componentTypeId: elb.id } })).rawFormId).toBeNull();

    const he = await owner.processTemplate.findFirstOrThrow({
      where: { tenantId: t, family: { code: "HEAT_EXCHANGER" } },
      include: { versions: { include: { processes: true, edges: true } } },
    });
    expect(he.versions).toHaveLength(1);
    expect(he.versions[0]).toMatchObject({ status: "DRAFT" });
    expect(he.versions[0].processes).toHaveLength(42);
    expect(he.versions[0].edges.length).toBeGreaterThan(30);

    const second = await applyMasterImport(m.ph, bytes, { allowDraft: true });
    expect(second.written).toMatchObject({
      partFamilies: { create: 0, update: 0, unchanged: 60 },
      routes: { create: 0, update: 0, unchanged: 41, skipped: 1 },
      stageMappingRows: 0,
      materialGrades: { create: 0, update: 0, unchanged: 40 },
      heTemplate: "unchanged",
    });
    expect(await owner.routeStepFamilySeq.count({ where: { tenantId: t } })).toBe(283);
  });
});
