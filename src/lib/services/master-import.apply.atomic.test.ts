import { describe, expect, it, vi } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * Atomicity: material grades are written AFTER part families and routes. If a
 * later audit insert fails, everything written before it must roll back —
 * invariant 5 ("if the audit insert fails, roll back") for the whole import.
 */
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    recordAudit: async (...args: Parameters<typeof actual.recordAudit>) => {
      if (args[2].action === "masterImport.materialGrade.create") throw new Error("audit insert failed (test)");
      return actual.recordAudit(...args);
    },
  };
});

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("applyMasterImport is atomic (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { applyMasterImport } = await import("./master-import.apply");
  const { standardWorkbook } = await import("./master-import.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("a failing audit insert rolls back every part family, route and mapping written before it", async () => {
    const stamp = `${Date.now()}-${Math.random()}`;
    const org = await owner.organization.create({ data: { code: `TEST-M2B-ATOM-${stamp}`, name: "atomic" } });
    const tenantId = org.id;
    await owner.department.create({ data: { tenantId, code: "STORES", name: "Stores" } });
    await owner.department.create({ data: { tenantId, code: "QC", name: "Quality Control / QA" } });
    await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    await owner.operationRef.create({ data: { tenantId, code: "RECEIPT", name: "Receipt" } });
    await owner.operationRef.create({ data: { tenantId, code: "MTC_VERIFICATION", name: "MTC" } });
    await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const user = await owner.user.create({
      data: { tenantId, email: `atom-${stamp}@test.local`, username: `atom-${stamp}`, passwordHash: "x", name: "PH" },
    });
    const ph: Actor = {
      userId: user.id, tenantId, clientId: null, name: "PH", email: "ph@despl.test", roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false,
    };

    await expect(applyMasterImport(ph, standardWorkbook())).rejects.toThrow("audit insert failed (test)");

    expect(await owner.componentTypeRef.count({ where: { tenantId } })).toBe(1); // only PLATE
    expect(await owner.partFamily.count({ where: { tenantId } })).toBe(0);
    expect(await owner.routeTemplate.count({ where: { tenantId } })).toBe(0);
    expect(await owner.routeStepFamilySeq.count({ where: { tenantId } })).toBe(0);
    expect(await owner.materialGrade.count({ where: { tenantId } })).toBe(0);
    expect(await owner.auditLog.count({ where: { tenantId } })).toBe(0);
    await owner.$disconnect();
  });
});
