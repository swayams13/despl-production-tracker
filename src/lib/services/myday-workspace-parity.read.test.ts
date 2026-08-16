import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMyDay } from "./myday.read";
import { loadMyOverdueCount } from "./workspace.read";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * SPEC §6.3's binding SQL-view rule, cross-checked directly: `/my-day` and
 * `/workspace`'s sidebar badge both ultimately count "my overdue plans" from
 * the same `ProcessPlan` rows, but via two completely different code paths —
 * `loadMyDay` derives it from `prioritize()`'s per-plan `overdue` flag
 * (job-by-job spine/CPM pipeline, filtered to jobs.status === "ACTIVE"),
 * while `loadMyOverdueCount` is one raw tenant-wide `count()` with its own
 * inline `status !== "COMPLETE" AND plannedFinish < now` predicate scoped to
 * `isCurrent` schedule runs. Nothing shares an implementation, so if the two
 * definitions of "overdue" ever drift, `/my-day` and the workspace badge
 * would show different numbers for the same person — the thing SPEC §6.3
 * forbids.
 *
 * The fixture deliberately makes "assigned to me" and "in my department"
 * coincide (actor is the ONLY member of, and ONLY assignee in, one
 * department) so `loadMyOverdueCount`'s department-scoped count and
 * `loadMyDay`'s assignee-scoped `mine` count are counting the exact same
 * plan set — a fair, apples-to-apples comparison rather than two unrelated
 * numbers that happen to match by coincidence. Spans two ACTIVE jobs (same
 * cross-job-merge shape myday.read.test.ts already exercises) so the parity
 * holds after `loadMyDay`'s per-job loop + merge, not just within one job.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("myday/workspace overdue-count parity (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  let actor: Actor;

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `PARITY-${Date.now()}`, name: "Parity test" } });
    const tenantId = org.id;

    const deptSolo = await owner.department.create({ data: { tenantId, code: "SOLO", name: "Solo Dept" } });

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PV", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const meUser = await owner.user.create({
      data: { tenantId, email: `parity-me-${Date.now()}@x`, username: `parity-me-${Date.now()}`, name: "Me", passwordHash: "x" },
    });
    await owner.userDepartment.create({ data: { userId: meUser.id, departmentId: deptSolo.id } });

    actor = {
      userId: meUser.id,
      tenantId,
      clientId: null,
      name: "Me",
      email: "me@despl.test",
      roles: [ROLES.SUPERVISOR],
      departmentIds: [deptSolo.id],
      mustChangePassword: false,
    };

    let seq = 1;
    const mkJobWithPlan = async (
      jobIndex: number,
      opts: { status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE"; plannedFinish: Date | null; actualFinish?: Date },
    ) => {
      const job = await owner.job.create({
        data: {
          tenantId,
          publicId: `pub-parity${jobIndex}-${Date.now()}-${seq}`,
          clientId: client.id,
          familyId: family.id,
          templateVersionId: tv.id,
          jobNumber: `DESPL-PARITY${jobIndex}-${Date.now()}-${seq}`,
          // status defaults to ACTIVE — loadMyDay only aggregates active jobs.
        },
      });
      const run = await owner.scheduleRun.create({
        data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
      });
      const jp = await owner.jobProcess.create({
        data: {
          jobId: job.id, seq: seq++, code: `P${seq}`, name: `Process ${seq}`,
          departmentId: deptSolo.id, durationMinDays: 1, durationMaxDays: 2,
        },
      });
      return owner.processPlan.create({
        data: {
          scheduleRunId: run.id, jobProcessId: jp.id, ownerDepartmentId: deptSolo.id, assigneeUserId: meUser.id,
          status: opts.status, plannedFinish: opts.plannedFinish, actualFinish: opts.actualFinish ?? null,
        },
      });
    };

    const now = Date.now();
    // Two independently-created overdue plans, spread across TWO active jobs
    // — exercises loadMyDay's per-job loop + merge, not a single-job coincidence.
    await mkJobWithPlan(1, { status: "NOT_STARTED", plannedFinish: new Date(now - 3 * 24 * 3600 * 1000) });
    await mkJobWithPlan(2, { status: "IN_PROGRESS", plannedFinish: new Date(now - 1 * 24 * 3600 * 1000) });
    // Distractors: each must be excluded by BOTH functions, or the parity
    // assertion below would be vacuously true from two functions that both
    // (wrongly) count everything.
    await mkJobWithPlan(1, { status: "NOT_STARTED", plannedFinish: new Date(now + 5 * 24 * 3600 * 1000) }); // future — not overdue
    await mkJobWithPlan(1, { status: "COMPLETE", plannedFinish: new Date(now - 2 * 24 * 3600 * 1000), actualFinish: new Date(now) }); // COMPLETE — never overdue regardless of date
    await mkJobWithPlan(2, { status: "NOT_STARTED", plannedFinish: null }); // no plannedFinish — can't be overdue
  });

  it("loadMyDay(actor)'s mine-overdue count equals loadMyOverdueCount(actor) for the same actor", async () => {
    const [view, workspaceOverdue] = await Promise.all([loadMyDay(actor), loadMyOverdueCount(actor)]);
    const mineOverdueCount = view.mine.filter((r) => r.ranked.overdue).length;

    // Pinned to the fixture's known answer too — so a shared bug that makes
    // both functions agreeably wrong (e.g. both counting 0) can't pass by
    // the two sides merely matching each other.
    expect(mineOverdueCount).toBe(2);
    expect(workspaceOverdue).toBe(mineOverdueCount);
  });
});
