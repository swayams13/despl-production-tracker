import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileDelayReason } from "./delay.service";
import { assertNoUnfiledDelayBlock } from "./_shared";
import { withTenant } from "@/lib/db";
import { isAppError, ERROR_CODES } from "@/lib/shared/errors";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * fileDelayReason is the unblock half of invariant #7. Two guarantees to pin:
 *   · a read-only client user can never file (pure — refused before any DB), and
 *   · filing clears the assertNoUnfiledDelayBlock block for that department
 *     (behavioural — gated on RUN_DB_TESTS, needs a seeded overdue plan).
 * The wrong-department refusal is behavioural too: the service locks the plan
 * FIRST (concurrency contract) before it can read ownerDepartmentId to scope
 * the actor, so it needs a real plan row and lives in the gated block.
 */

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "Sup",
    email: "sup@despl.test",
    roles: [ROLES.SUPERVISOR],
    departmentIds: [3],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
    ...over,
  };
}

describe("fileDelayReason — pure refusals", () => {
  it("refuses a client (read-only) user before touching the DB (invariant #8)", async () => {
    const clientUser = actor({ clientId: 99, roles: [ROLES.CLIENT_VIEWER], departmentIds: [] });
    await expect(
      fileDelayReason(clientUser, { processPlanId: 1, categoryId: 2 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("rejects a smuggled *_at key via the strict schema (invariant #1)", async () => {
    await expect(
      // @ts-expect-error — filedAt is server-clock only; schema is .strict()
      fileDelayReason(actor(), { processPlanId: 1, categoryId: 2, filedAt: new Date() }),
    ).rejects.toBeTruthy();
  });
});

/**
 * Behavioural round-trip. Seeds a minimal job graph with ONE overdue plan
 * (plannedFinish in the past, not COMPLETE, no reason), proves the block
 * fires, files a reason, proves the block clears — and that a supervisor
 * outside the plan's department is refused. Gated off unless RUN_DB_TESTS=1.
 *
 * Seeds ONCE in beforeAll via the owner (DIRECT_URL, RLS-bypassing) client with
 * an autoincrement org id and Date.now()-unique codes/jobNumber/publicId, so
 * reruns never collide. The real tenant id is the created org's id — used for
 * both the actor and the withTenant scope. The service calls run RLS-scoped
 * inside withTenant themselves. The three assertions are independent of each
 * other's state (dept-scope and category-existence checks don't depend on the
 * filed reason), so a shared seed is safe.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("fileDelayReason — file → unblock (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let deptId = 0;
  let otherDeptId = 0;
  let runId = 0;
  let planId = 0;
  let categoryId = 0;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `DELAY-${Date.now()}`, name: "Delay svc test" },
    });
    tenantId = org.id;

    const dept = await owner.department.create({ data: { tenantId, code: "PROD", name: "Production" } });
    const otherDept = await owner.department.create({ data: { tenantId, code: "QA", name: "Quality" } });
    deptId = dept.id;
    otherDeptId = otherDept.id;

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const cat = await owner.delayCategoryRef.create({ data: { tenantId, code: "MATERIAL", name: "Material shortage" } });
    categoryId = cat.id;

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-delay-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-DELAY-${Date.now()}`,
      },
    });
    const jp = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 10, code: "10", name: "Rolling", departmentId: dept.id },
    });
    const run = await owner.scheduleRun.create({
      data: {
        jobId: job.id,
        version: 1,
        mode: "FORWARD",
        projectStartDate: new Date("2026-01-01"),
        isCurrent: true,
      },
    });
    runId = run.id;
    const plan = await owner.processPlan.create({
      data: {
        jobId: job.id,
        scheduleRunId: run.id,
        jobProcessId: jp.id,
        unitId: null,
        plannedFinish: new Date("2026-01-05"), // in the past → overdue
        ownerDepartmentId: dept.id,
        status: "IN_PROGRESS",
      },
    });
    planId = plan.id;
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("blocks before filing, unblocks after (invariant #7)", async () => {
    const dept = actor({ tenantId, departmentIds: [deptId] });

    // Block fires.
    await expect(
      withTenant(tenantId, (tx) =>
        assertNoUnfiledDelayBlock(tx, { ownerDepartmentId: deptId, scheduleRunId: runId, unitId: null }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.REASON_REQUIRED });

    // File the reason.
    const reason = await fileDelayReason(dept, { processPlanId: planId, categoryId });
    expect(reason.filedBy).toBe(dept.userId);

    // Block cleared.
    await withTenant(tenantId, (tx) =>
      assertNoUnfiledDelayBlock(tx, { ownerDepartmentId: deptId, scheduleRunId: runId, unitId: null }),
    );
  });

  it("refuses a supervisor outside the plan's department (invariant #8)", async () => {
    const wrong = actor({ tenantId, departmentIds: [otherDeptId] });
    try {
      await fileDelayReason(wrong, { processPlanId: planId, categoryId });
      throw new Error("expected refusal");
    } catch (e) {
      expect(isAppError(e) && e.code).toBe(ERROR_CODES.FORBIDDEN);
    }
  });

  it("NOT_FOUND when the category does not exist", async () => {
    const dept = actor({ tenantId, departmentIds: [deptId] });
    await expect(
      fileDelayReason(dept, { processPlanId: planId, categoryId: 424242 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
});
