import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { classifyDeptCode, resolveCommandCenterAccess, loadCommandCenter } from "./command-center.read";

/**
 * `/command/[dept]` (personal dashboards v1, SPEC §7.4, task 3.1).
 *
 * `classifyDeptCode`/`resolveCommandCenterAccess` are pulled out of
 * page.tsx as pure functions specifically so the routing + access-control
 * rules (task 3.1 rulings 1 and 3) are table-driven-testable without a
 * page-render harness, which this codebase doesn't have (CLAUDE.md: "any
 * change to ... RBAC ... requires table-driven tests for the violation
 * cases, not just happy paths").
 */

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "Test User",
    email: "t@despl.local",
    roles: [ROLES.SUPERVISOR],
    departmentIds: [10],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
    ...over,
  };
}

describe("classifyDeptCode — routing (ruling 1)", () => {
  const cases: { slug: string; expected: "office" | "floor" | "invalid" }[] = [
    { slug: "PROJECTS", expected: "office" },
    { slug: "engineering", expected: "office" }, // case-insensitive
    { slug: "planning", expected: "office" },
    { slug: "procurement", expected: "office" },
    { slug: "qc", expected: "office" },
    { slug: "stores", expected: "office" },
    { slug: "fabrication_prep", expected: "floor" },
    { slug: "machine_shop", expected: "floor" },
    { slug: "fabrication", expected: "floor" },
    { slug: "heat_treatment", expected: "floor" },
    { slug: "surface_paint", expected: "floor" },
    { slug: "documentation", expected: "floor" },
    { slug: "dispatch", expected: "floor" },
    { slug: "not-a-department", expected: "invalid" },
    { slug: "", expected: "invalid" },
  ];

  it.each(cases)("$slug → $expected", ({ slug, expected }) => {
    expect(classifyDeptCode(slug)).toBe(expected);
  });
});

describe("resolveCommandCenterAccess — full / read-only / none (ruling 3)", () => {
  it("dept member gets full access", () => {
    expect(resolveCommandCenterAccess(actor({ departmentIds: [10] }), 10)).toBe("full");
  });

  it("non-member without PH/ADMIN/MANAGEMENT gets no access", () => {
    expect(resolveCommandCenterAccess(actor({ departmentIds: [11] }), 10)).toBe("none");
  });

  it.each([ROLES.PRODUCTION_HEAD, ROLES.ADMIN])("%s gets full access to any department, not just their own", (role) => {
    expect(resolveCommandCenterAccess(actor({ roles: [role], departmentIds: [] }), 10)).toBe("full");
  });

  it("MANAGEMENT gets read-only access, even outside their own department", () => {
    expect(resolveCommandCenterAccess(actor({ roles: [ROLES.MANAGEMENT], departmentIds: [] }), 10)).toBe("readonly");
  });

  it("a QC actor with no relevant role and no membership gets no access", () => {
    expect(resolveCommandCenterAccess(actor({ roles: [ROLES.QC], departmentIds: [99] }), 10)).toBe("none");
  });

  it("membership wins even without any special role", () => {
    expect(resolveCommandCenterAccess(actor({ roles: [], departmentIds: [10] }), 10)).toBe("full");
  });
});

/**
 * Cross-department "You're blocking" / "Waiting on others" (ruling 2f) —
 * fresh org/tenant fixture (same shape as myday.read.test.ts's own
 * beforeAll), minimal on purpose: one job, two office departments, one
 * FINISH_TO_START edge between them.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadCommandCenter — cross-department blocking (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("dept A's incomplete plan blocking dept B shows on A's 'You're blocking' and B's 'Waiting on others'", async () => {
    const org = await owner.organization.create({ data: { code: `CC-${Date.now()}`, name: "Command Center test" } });
    const tenantId = org.id;

    // STORES's process must complete before PROCUREMENT's can start —
    // real office-dept codes so PIPELINE_LABELS has an entry for each.
    const deptStores = await owner.department.create({ data: { tenantId, code: "STORES", name: "Stores" } });
    const deptProcurement = await owner.department.create({ data: { tenantId, code: "PROCUREMENT", name: "Procurement" } });

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-CC-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PV", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-cc-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-CC-${Date.now()}`,
        // status defaults to ACTIVE — loadCommandCenter only aggregates active jobs.
      },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });

    const jpStores = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 1, code: "P1", name: "Material receipt", departmentId: deptStores.id, durationMinDays: 1, durationMaxDays: 2 },
    });
    const jpProcurement = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 2, code: "P2", name: "PO placement", departmentId: deptProcurement.id, durationMinDays: 1, durationMaxDays: 2 },
    });
    await owner.jobProcessEdge.create({
      data: { processId: jpProcurement.id, predecessorId: jpStores.id, type: "FINISH_TO_START", lagDays: 0 },
    });

    // Stores' own process is not complete -> Procurement's plan is BLOCKED.
    await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jpStores.id, ownerDepartmentId: deptStores.id, status: "NOT_STARTED" },
    });
    const blockedPlan = await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jpProcurement.id, ownerDepartmentId: deptProcurement.id, status: "NOT_STARTED" },
    });

    const viewer: Actor = {
      userId: 1,
      tenantId,
      clientId: null,
      name: "PH",
      email: "ph@despl.test",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    const storesView = await loadCommandCenter(viewer, deptStores.id, "STORES", "Stores");
    expect(storesView.blocking.map((r) => r.ranked.plan.id)).toContain(blockedPlan.id);
    expect(storesView.waitingOnOthers.map((r) => r.ranked.plan.id)).not.toContain(blockedPlan.id);

    const procurementView = await loadCommandCenter(viewer, deptProcurement.id, "PROCUREMENT", "Procurement");
    expect(procurementView.waitingOnOthers.map((r) => r.ranked.plan.id)).toContain(blockedPlan.id);
    expect(procurementView.blocking.map((r) => r.ranked.plan.id)).not.toContain(blockedPlan.id);
    const row = procurementView.waitingOnOthers.find((r) => r.ranked.plan.id === blockedPlan.id)!;
    expect(row.ranked.reasonText).toContain("Material receipt");
  });
});
