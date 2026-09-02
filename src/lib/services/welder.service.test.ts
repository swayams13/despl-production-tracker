import { describe, expect, it, beforeAll } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import { createWelder, updateWelder } from "./welder.service";

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "Admin",
    email: "admin@despl.test",
    roles: [ROLES.ADMIN],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
    ...over,
  };
}

describe("welder.service — pure refusals", () => {
  it("createWelder refuses a SUPERVISOR caller (RBAC deny-by-default)", async () => {
    await expect(
      createWelder(actor({ roles: [ROLES.SUPERVISOR] }), { name: "V. Yadav", employeeCode: "W-999", departmentId: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createWelder refuses a client user", async () => {
    await expect(
      createWelder(actor({ clientId: 7, roles: [ROLES.CLIENT_VIEWER] }), {
        name: "V. Yadav",
        employeeCode: "W-999",
        departmentId: null,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("updateWelder refuses a QC caller", async () => {
    await expect(
      updateWelder(actor({ roles: [ROLES.QC] }), { id: 1, active: false }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("allows PRODUCTION_HEAD past the role gate (mechanism-only — fails later on missing DB row, not FORBIDDEN)", async () => {
    await expect(
      updateWelder(actor({ roles: [ROLES.PRODUCTION_HEAD] }), { id: 999999, active: false }),
    ).rejects.not.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });
});

/**
 * DB-backed coverage, same RUN_DB_TESTS gate and disposable-org pattern as
 * admin.service.test.ts. // ponytail: no cleanup — disposable test DB.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("welder.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let admin: Actor;
  let deptId: number;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-WELDER-${Date.now()}`, name: "Welder svc test" },
    });
    tenantId = org.id;
    await owner.role.create({ data: { tenantId, code: "ADMIN", name: "Admin" } });
    const dept = await owner.department.create({ data: { tenantId, code: "FABRICATION", name: "Fabrication" } });
    deptId = dept.id;

    admin = {
      userId: 1,
      tenantId,
      clientId: null,
      name: "Test Admin",
      email: "admin@test.local",
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  });

  it("creates a welder", async () => {
    const welder = await createWelder(admin, { name: "V. Yadav", employeeCode: "W-201", departmentId: deptId });
    expect(welder.name).toBe("V. Yadav");
    expect(welder.active).toBe(true);
  });

  it("rejects a duplicate employee code on create with a clean AppError, not a DB crash", async () => {
    await expect(
      createWelder(admin, { name: "Duplicate Yadav", employeeCode: "W-201", departmentId: null }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  it("updates a welder's name and department", async () => {
    const welder = await createWelder(admin, { name: "R. Gill", employeeCode: "W-202", departmentId: null });
    const updated = await updateWelder(admin, { id: welder.id, name: "R. Gill Jr.", departmentId: deptId });
    expect(updated.name).toBe("R. Gill Jr.");
    expect(updated.departmentId).toBe(deptId);
  });

  it("rejects renaming a welder's employee code to one that already exists", async () => {
    const welder = await createWelder(admin, { name: "S. Ansari", employeeCode: "W-203", departmentId: null });
    await expect(
      updateWelder(admin, { id: welder.id, employeeCode: "W-201" }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === ERROR_CODES.VALIDATION_FAILED);
  });

  it("deactivate sets active: false and preserves the row (never a hard delete)", async () => {
    const welder = await createWelder(admin, { name: "K. Bhosale", employeeCode: "W-204", departmentId: null });
    const deactivated = await updateWelder(admin, { id: welder.id, active: false });
    expect(deactivated.active).toBe(false);

    const row = await owner.welder.findUniqueOrThrow({ where: { id: welder.id } });
    expect(row.id).toBe(welder.id);
    expect(row.active).toBe(false);
  });
});
