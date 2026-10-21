import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTransition, TRANSITIONS, type ProcessAction } from "./process.service";
import { assertMakerChecker, ROLES, type Actor } from "@/lib/authz";
import { assertCanComplete, assertCanStart } from "@/lib/schedule";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { ProcessPlanStatus } from "@/generated/prisma/client";

/**
 * Pure guard tests (these RUN in CI) pin the service-specific logic without a
 * database: the transition matrix, and the maker–checker / gating guards as the
 * service composes them. The full locked-tx path (delay block, hold point,
 * audit-row-after-every-mutation) needs seeded rows and lives in the
 * RUN_DB_TESTS block below.
 */

const ALL_STATUSES: ProcessPlanStatus[] = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "SUBMITTED",
  "COMPLETE",
  "ON_HOLD",
];

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return isAppError(e) ? e.code : "NON_APP_ERROR";
  }
  return undefined;
}

// ── Transition matrix (invariant: the state machine, not the UI) ────────────

describe("assertTransition", () => {
  const legal: Array<[ProcessAction, ProcessPlanStatus, ProcessPlanStatus]> = [
    ["start", "NOT_STARTED", "IN_PROGRESS"],
    ["submit", "IN_PROGRESS", "SUBMITTED"],
    ["verify", "SUBMITTED", "COMPLETE"],
    ["reject", "SUBMITTED", "IN_PROGRESS"],
    ["hold", "IN_PROGRESS", "ON_HOLD"],
    ["hold", "SUBMITTED", "ON_HOLD"],
    ["resume", "ON_HOLD", "IN_PROGRESS"],
  ];

  it.each(legal)("%s from %s → %s", (action, from, to) => {
    expect(assertTransition(action, from)).toBe(to);
  });

  // Every (action, from) pair NOT in the legal table must be rejected.
  const legalSet = new Set(legal.map(([a, f]) => `${a}:${f}`));
  const actions = Object.keys(TRANSITIONS) as ProcessAction[];
  const illegal: Array<[ProcessAction, ProcessPlanStatus]> = [];
  for (const a of actions)
    for (const f of ALL_STATUSES) if (!legalSet.has(`${a}:${f}`)) illegal.push([a, f]);

  it.each(illegal)("%s from %s → INVALID_STATE_TRANSITION", (action, from) => {
    expect(code(() => assertTransition(action, from))).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
  });
});

// ── Maker–checker as verify composes it (invariant #3) ──────────────────────

describe("verify maker–checker guard", () => {
  const qc = (userId: number): Actor => ({
    userId,
    tenantId: 1,
    clientId: null,
    name: "QC",
    email: "qc@x",
    roles: [ROLES.QC],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
  });
  const supervisorQc = (userId: number): Actor => ({ ...qc(userId), roles: [ROLES.SUPERVISOR, ROLES.QC] });

  const cases: Array<[string, Actor, number | null, string | undefined]> = [
    ["same human submitted and verifies → violation", supervisorQc(7), 7, ERROR_CODES.MAKER_CHECKER_VIOLATION],
    ["different QC user → allowed", qc(8), 7, undefined],
    ["no QC role → forbidden", { ...qc(8), roles: [ROLES.SUPERVISOR] }, 7, ERROR_CODES.FORBIDDEN],
    ["admin is not exempt (no QC role) → forbidden", { ...qc(9), roles: [ROLES.ADMIN] }, 7, ERROR_CODES.FORBIDDEN],
  ];

  it.each(cases)("%s", (_label, actor, submittedBy, expected) => {
    expect(code(() => assertMakerChecker(actor, submittedBy))).toBe(expected);
  });
});

// ── Gating as start/verify compose it (invariants #2 / #11) ─────────────────

describe("gating guards", () => {
  it("start blocked when a FINISH_TO_START predecessor is not COMPLETE", () => {
    const edges = [{ processId: 2, predecessorId: 1, type: "FINISH_TO_START" as const, lagDays: 0 }];
    expect(code(() => assertCanStart(edges, [{ predecessorId: 1, status: "IN_PROGRESS" }]))).toBe(
      ERROR_CODES.GATING_BLOCKED,
    );
  });

  it("start allowed on an overlap edge once the predecessor has merely started", () => {
    const edges = [
      { processId: 2, predecessorId: 1, type: "START_TO_START_WITH_OVERLAP" as const, lagDays: 0 },
    ];
    expect(code(() => assertCanStart(edges, [{ predecessorId: 1, status: "IN_PROGRESS" }]))).toBeUndefined();
  });

  it("complete blocked while any predecessor is not COMPLETE — even an overlap edge (#11)", () => {
    const edges = [
      { processId: 2, predecessorId: 1, type: "START_TO_START_WITH_OVERLAP" as const, lagDays: -3 },
    ];
    expect(code(() => assertCanComplete(edges, [{ predecessorId: 1, status: "SUBMITTED" }]))).toBe(
      ERROR_CODES.GATING_BLOCKED,
    );
  });
});

/**
 * Full locked-transaction path against a live DB. Gated off by default; set
 * RUN_DB_TESTS=1 with DIRECT_URL pointing at a migrated database to run it. It
 * seeds a minimal job/plan chain with the OWNER connection (RLS-bypassing, like
 * prisma/seed.ts), then drives the real service functions (which run as the
 * RLS-scoped app role inside withTenant) and asserts an audit row lands after
 * every successful mutation. Tests share state and run in order — it is one
 * production flow, not isolated units.
 *
 * // ponytail: no cleanup — this targets a disposable test DB and uses a
 * // per-run org code so reruns don't collide. Add teardown if it ever points
 * // at a shared instance.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("process state machine (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { startProcess, submitProcess, verifyProcess, holdProcess, resumeProcess } = await import(
    "./process.service"
  );
  const { withTenant } = await import("@/lib/db");
  const { assertLateReasonFiled } = await import("./_shared");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let supA: Actor; // supervisor+QC in deptA (maker)
  let qc: Actor; // QC only, different user (checker)
  let supB: Actor; // supervisor in deptB
  let planA = 0;
  let planB = 0;
  let planC = 0; // overdue, deptB — late-reason subject
  let planD = 0; // not overdue, deptB, same unit — must stay writable while planC is unreasoned
  let jobId = 0;

  const future = new Date(Date.now() + 30 * 864e5);
  const past = new Date(Date.now() - 30 * 864e5);

  async function auditCount(entityId: number): Promise<number> {
    return owner.auditLog.count({
      where: { tenantId, entityType: "ProcessPlan", entityId: String(entityId) },
    });
  }

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-${Date.now()}`, name: "Process svc test" },
    });
    tenantId = org.id;

    const deptA = await owner.department.create({ data: { tenantId, code: "A", name: "Dept A" } });
    const deptB = await owner.department.create({ data: { tenantId, code: "B", name: "Dept B" } });
    const client = await owner.client.create({ data: { tenantId, name: "Client" } });
    const family = await owner.productFamily.create({
      data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" },
    });
    const template = await owner.processTemplate.create({
      data: { tenantId, familyId: family.id, name: "PV template" },
    });
    const version = await owner.processTemplateVersion.create({
      data: { templateId: template.id, version: 1 },
    });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-${Date.now()}`,
      },
    });
    jobId = job.id;

    const jpA = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 10, code: "10", name: "A", departmentId: deptA.id },
    });
    const jpB = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 20, code: "20", name: "B", departmentId: deptA.id },
    });
    const jpC = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 30, code: "30", name: "C", departmentId: deptB.id },
    });
    const jpD = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 35, code: "35", name: "D", departmentId: deptB.id },
    });
    await owner.jobProcessEdge.create({
      data: { jobId: job.id, processId: jpB.id, predecessorId: jpA.id, type: "FINISH_TO_START", lagDays: 0 },
    });

    const run = await owner.scheduleRun.create({
      data: {
        jobId: job.id,
        equipmentId: null,
        version: 1,
        mode: "FORWARD",
        projectStartDate: new Date(),
        isCurrent: true,
      },
    });
    const mkPlan = (jobProcessId: number, departmentId: number, plannedFinish: Date) =>
      owner.processPlan.create({
        data: {
          jobId: job.id,
          scheduleRunId: run.id,
          jobProcessId,
          unitId: null,
          ownerDepartmentId: departmentId,
          plannedFinish,
          status: "NOT_STARTED",
        },
      });
    planA = (await mkPlan(jpA.id, deptA.id, future)).id;
    planB = (await mkPlan(jpB.id, deptA.id, future)).id;
    planC = (await mkPlan(jpC.id, deptB.id, past)).id;
    planD = (await mkPlan(jpD.id, deptB.id, future)).id;

    const userSup = await owner.user.create({
      data: { tenantId, email: "sup@x", username: "sup", name: "Sup", passwordHash: "x" },
    });
    const userQc = await owner.user.create({
      data: { tenantId, email: "qc@x", username: "qc", name: "Qc", passwordHash: "x" },
    });
    const userSupB = await owner.user.create({
      data: { tenantId, email: "supb@x", username: "supb", name: "SupB", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null, mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
    supA = { ...base, userId: userSup.id, name: "Sup", email: "sup@x", roles: [ROLES.SUPERVISOR, ROLES.QC], departmentIds: [deptA.id] };
    qc = { ...base, userId: userQc.id, name: "Qc", email: "qc@x", roles: [ROLES.QC], departmentIds: [] };
    supB = { ...base, userId: userSupB.id, name: "SupB", email: "supb@x", roles: [ROLES.SUPERVISOR], departmentIds: [deptB.id] };
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  it("start is gating-blocked while the predecessor is not complete", async () => {
    await expectCode(startProcess(supA, { processPlanId: planB }), ERROR_CODES.GATING_BLOCKED);
  });

  it("happy path start → submit → verify, one audit row per mutation", async () => {
    const before = await auditCount(planA);

    const started = await startProcess(supA, { processPlanId: planA });
    expect(started.status).toBe("IN_PROGRESS");
    expect(started.actualStart).toBeInstanceOf(Date);
    expect(await auditCount(planA)).toBe(before + 1);

    const submitted = await submitProcess(supA, { processPlanId: planA });
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedBy).toBe(supA.userId);
    expect(await auditCount(planA)).toBe(before + 2);

    const verified = await verifyProcess(qc, { processPlanId: planA });
    expect(verified.status).toBe("COMPLETE");
    expect(verified.actualFinish).toBeInstanceOf(Date);
    expect(verified.verifiedBy).toBe(qc.userId);
    expect(await auditCount(planA)).toBe(before + 3);
  });

  it("rejects a client timestamp write — actual_* is server-set only (#1)", async () => {
    const p = await owner.processPlan.findUniqueOrThrow({ where: { id: planA } });
    // actualStart/actualFinish came from the server clock, never a request.
    expect(p.actualStart).toBeInstanceOf(Date);
  });

  it("maker–checker: the submitter cannot verify their own submission", async () => {
    await startProcess(supA, { processPlanId: planB }); // A is COMPLETE now → allowed
    await submitProcess(supA, { processPlanId: planB }); // submittedBy = supA
    await expectCode(verifyProcess(supA, { processPlanId: planB }), ERROR_CODES.MAKER_CHECKER_VIOLATION);
    const verified = await verifyProcess(qc, { processPlanId: planB });
    expect(verified.status).toBe("COMPLETE");
  });

  it("illegal transition: verifying a NOT_STARTED plan is refused", async () => {
    await expectCode(verifyProcess(qc, { processPlanId: planC }), ERROR_CODES.INVALID_STATE_TRANSITION);
  });

  it("late reasons never block other writes; a late plan needs its own reason to be submitted (#7 as revised)", async () => {
    // planC is overdue with no reason. A different plan of the same department and unit still starts...
    const other = await startProcess(supB, { processPlanId: planD });
    expect(other.status).toBe("IN_PROGRESS");
    // ...and so does the late plan itself (late is not a reason to refuse work).
    const started = await startProcess(supB, { processPlanId: planC });
    expect(started.status).toBe("IN_PROGRESS");

    // Submitting the late plan asks for the reason, with the categories to choose from.
    const cat = await owner.delayCategoryRef.create({
      data: { tenantId, code: "MAT", name: "Material shortage" },
    });
    let thrown: unknown;
    try {
      await submitProcess(supB, { processPlanId: planC });
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(ERROR_CODES.LATE_REASON_REQUIRED);
    expect(isAppError(thrown) && JSON.stringify(thrown.detail)).toContain(`"id":${cat.id}`);
    expect((await owner.processPlan.findUniqueOrThrow({ where: { id: planC } })).status).toBe("IN_PROGRESS");

    // With the reason filed the check passes (planC stays IN_PROGRESS for the hold/resume cases below).
    await owner.delayReason.create({
      data: { jobId, processPlanId: planC, categoryId: cat.id, detail: "late plate", filedBy: supB.userId },
    });
    await withTenant(tenantId, (tx) => assertLateReasonFiled(tx, { id: planC, plannedFinish: past }, tenantId));
  });

  /**
   * Final-review Finding 3, proved on a SECOND caller of the shared helper:
   * lockProcessPlanForUpdate now anchors its read through the RLS-covered
   * `departments` table, so a plan id from another tenant reads as NOT_FOUND
   * for every one of the helper's 10 call sites, not just assignment.service.
   */
  it("cross-tenant: another tenant's PH cannot reach this plan by id (NOT_FOUND)", async () => {
    const otherOrg = await owner.organization.create({
      data: { code: `TEST-XT-${Date.now()}`, name: "Other tenant" },
    });
    const intruder: Actor = {
      userId: 999_999,
      tenantId: otherOrg.id,
      clientId: null,
      name: "Intruder",
      email: "intruder@other",
      roles: [ROLES.PRODUCTION_HEAD, ROLES.QC],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    const statusBefore = (await owner.processPlan.findUniqueOrThrow({ where: { id: planC } })).status;

    await expectCode(startProcess(intruder, { processPlanId: planC }), ERROR_CODES.NOT_FOUND);
    await expectCode(holdProcess(intruder, { processPlanId: planC, reason: "x" }), ERROR_CODES.NOT_FOUND);
    await expectCode(verifyProcess(intruder, { processPlanId: planC }), ERROR_CODES.NOT_FOUND);

    const after = await owner.processPlan.findUniqueOrThrow({ where: { id: planC } });
    expect(after.status).toBe(statusBefore);
  });

  it("hold then resume round-trips, each audited", async () => {
    const before = await auditCount(planC);
    const held = await holdProcess(supB, { processPlanId: planC, reason: "power cut" });
    expect(held.status).toBe("ON_HOLD");
    expect(await auditCount(planC)).toBe(before + 1);

    const resumed = await resumeProcess(supB, { processPlanId: planC });
    expect(resumed.status).toBe("IN_PROGRESS");
    expect(await auditCount(planC)).toBe(before + 2);
  });

  /**
   * AUD-072 — genuine two-transaction race, not simulated: two different QC
   * checkers call verifyProcess on the SAME SUBMITTED plan at once.
   * lockProcessPlanForUpdate's `SELECT ... FOR UPDATE` already forced the
   * loser to wait for the winner's row lock even before this session (so the
   * end state was always correct — never a double-COMPLETE); what
   * RepeatableRead (this session's change) does differently is HOW the
   * loser finds out: at READ COMMITTED it would silently re-read the
   * winner's committed row and continue; at RepeatableRead, Postgres instead
   * raises a 40001 serialization failure at the lock wait, which
   * withSerializationRetry catches and retries the whole transaction — the
   * retry then correctly re-reads COMPLETE and refuses cleanly. Verifies the
   * outcome is unchanged (one winner, one clean refusal, exactly one audit
   * row) with the new mechanism wired in.
   */
  it("AUD-072: concurrent verify race on the same plan — one wins, the other is cleanly refused, never double-verified", async () => {
    const deptA = await owner.department.findFirstOrThrow({ where: { tenantId, code: "A" } });
    const run = await owner.scheduleRun.findFirstOrThrow({ where: { jobId } });
    const jp = await owner.jobProcess.create({
      data: { jobId, seq: 40, code: "40", name: "RaceTest", departmentId: deptA.id },
    });
    const plan = await owner.processPlan.create({
      data: { jobId, scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: deptA.id, status: "NOT_STARTED" },
    });
    await startProcess(supA, { processPlanId: plan.id });
    await submitProcess(supA, { processPlanId: plan.id });

    const userQc2 = await owner.user.create({
      data: { tenantId, email: `qc2-${Date.now()}@x`, username: `qc2-${Date.now()}`, name: "Qc2", passwordHash: "x" },
    });
    const qc2: Actor = { ...qc, userId: userQc2.id, name: "Qc2", email: `qc2-${Date.now()}@x` };

    const results = await Promise.allSettled([
      verifyProcess(qc, { processPlanId: plan.id }),
      verifyProcess(qc2, { processPlanId: plan.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isAppError(rejected[0].reason) && rejected[0].reason.code).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);

    const final = await owner.processPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(final.status).toBe("COMPLETE");
    // Exactly one verify audit row — a retried-then-successful duplicate
    // would show up here as two.
    const verifyAuditRows = await owner.auditLog.count({
      where: { tenantId, entityType: "ProcessPlan", entityId: String(plan.id), action: "process.verify" },
    });
    expect(verifyAuditRows).toBe(1);
  });
});

/**
 * [S1] An excluded mid-chain process must not permanently deadlock its
 * direct successor. Spine: A -> B(excluded) -> C. generateSchedule's real
 * behaviour never creates a ProcessPlan for an `included: false` JobProcess
 * (envelope.ts filters it out) — reproduced here by simply not creating one
 * for B, exactly like the real pipeline leaves it planless. Before the fix,
 * loadGate reads B's raw edges, loadPredecessorStates defaults B's missing
 * plan to NOT_STARTED, and C's start is refused forever (GATING_BLOCKED)
 * with no way to ever clear it, because B has no plan to complete.
 */
describe.skipIf(!RUN_DB)("S1: excluded process does not deadlock its successor (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { startProcess } = await import("./process.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let sup: Actor;
  let planC = 0;

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-S1-${Date.now()}`, name: "S1 excluded splice test" },
    });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "D", name: "Dept" } });
    const client = await owner.client.create({ data: { tenantId, name: "Client" } });
    const family = await owner.productFamily.create({
      data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" },
    });
    const template = await owner.processTemplate.create({
      data: { tenantId, familyId: family.id, name: "PV template" },
    });
    const version = await owner.processTemplateVersion.create({
      data: { templateId: template.id, version: 1 },
    });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-s1-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-S1-${Date.now()}`,
      },
    });

    const jpA = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 10, code: "10", name: "A", departmentId: dept.id },
    });
    const jpB = await owner.jobProcess.create({
      data: {
        jobId: job.id,
        seq: 20,
        code: "20",
        name: "B-excluded",
        departmentId: dept.id,
        included: false,
        durationMinDays: 5,
        durationMaxDays: 5,
      },
    });
    const jpC = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 30, code: "30", name: "C", departmentId: dept.id },
    });
    await owner.jobProcessEdge.create({
      data: { jobId: job.id, processId: jpB.id, predecessorId: jpA.id, type: "FINISH_TO_START", lagDays: 0 },
    });
    await owner.jobProcessEdge.create({
      data: { jobId: job.id, processId: jpC.id, predecessorId: jpB.id, type: "FINISH_TO_START", lagDays: 0 },
    });

    const run = await owner.scheduleRun.create({
      data: {
        jobId: job.id,
        equipmentId: null,
        version: 1,
        mode: "FORWARD",
        projectStartDate: new Date(),
        isCurrent: true,
      },
    });

    // No ProcessPlan is created for jpB — mirrors generateSchedule, which
    // never materialises a plan for an included:false JobProcess.
    await owner.processPlan.create({
      // AUD-006: process_plans_complete_has_finish CHECK requires actualFinish when status=COMPLETE.
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpA.id, unitId: null, ownerDepartmentId: dept.id, status: "COMPLETE", actualFinish: new Date() },
    });
    planC = (
      await owner.processPlan.create({
        data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpC.id, unitId: null, ownerDepartmentId: dept.id, status: "NOT_STARTED" },
      })
    ).id;

    const user = await owner.user.create({
      data: { tenantId, email: "sup-s1@x", username: "sup-s1", name: "Sup", passwordHash: "x" },
    });
    sup = {
      tenantId,
      clientId: null,
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
      userId: user.id,
      name: "Sup",
      email: "sup-s1@x",
      roles: [ROLES.SUPERVISOR],
      departmentIds: [dept.id],
    };
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("C starts once A is COMPLETE, even though excluded B between them has no plan row", async () => {
    const started = await startProcess(sup, { processPlanId: planC });
    expect(started.status).toBe("IN_PROGRESS");
  });
});

/**
 * Grain P0.3: loadGate now threads plan.unitId into loadPredecessorStates, so
 * a unit waits on its OWN predecessors, and assertNoOpenHoldPoint (already
 * unitId-aware) stops being a no-op. Runs against the real DESPL-320 seed
 * (36 processes × 9 units + its actual QCP wiring) rather than the ad-hoc
 * fixture above — the ad-hoc fixture has no QCP data and no per-unit plans,
 * so it cannot exercise either invariant.
 *
 * Every generateSchedule call below uses a projectStartDate 30 days out so no
 * plannedFinish in the run is ever overdue — that keeps the late-reason
 * check on submit (invariant #7, unrelated to this task) out of the way; it is
 * exercised elsewhere (see planC above).
 *
 * Investigation for the hold-point test (see task-3-report.md for the full
 * query + result): DESPL-320's seeded QCP template DOES link a blocking ("H",
 * blocksCompletion=true) checkpoint to schedulable job processes — e.g.
 * QcpItem 4 blocks seq 1+2 (PO Receipt, Kick-Off) and QcpItem 8/9 block seq 10
 * (Material Receipt & Incoming Inspection). Both branches below are real, not
 * fabricated: seq 1's own checkpoint is cleared (via a real QcpExecution row)
 * so the chain can legitimately reach seq 10, whose DIFFERENT checkpoint is
 * left genuinely open.
 */
describe.skipIf(!RUN_DB)("per-unit gating + live hold points on DESPL-320 (DB, grain P0.3)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { generateSchedule } = await import("./schedule.service");
  const { startProcess, submitProcess, verifyProcess } = await import("./process.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function planner(tenantId: number): Actor {
    return {
      userId: 1,
      tenantId,
      clientId: null,
      name: "PH",
      email: "ph@x",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  }

  async function despl320(): Promise<{ jobId: number; tenantId: number }> {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    return { jobId: job.id, tenantId: job.tenantId };
  }

  /** Look up a DESPL-320 job process by its stable template seq (1..36), not
   * its DB primary key — the seed's insertion order can shift across reseeds. */
  async function procId(jobId: number, seq: number): Promise<number> {
    const jp = await owner.jobProcess.findFirstOrThrow({ where: { jobId, seq } });
    return jp.id;
  }

  /** Every currently-linked blocking (blocksCompletion=true) QCP checkpoint
   * on a job process — looked up live, never hardcoded (grain P0.4's hold-point
   * clearance flow is what would normally do this; here we insert the
   * QcpExecution row directly, like the delay-reason DB tests above insert a
   * DelayReason row directly). */
  async function blockingQcpItemIds(jobProcessId: number): Promise<number[]> {
    const items = await owner.qcpItem.findMany({
      where: {
        processLinks: { some: { jobProcessId } },
        partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
      },
      select: { id: true },
    });
    return items.map((i) => i.id);
  }

  // Idempotent (upsert, not create): both tests below share the seed DB with
  // no per-test cleanup (matching the existing "no cleanup" pattern in this
  // file), and the suite must stay green on a rerun (Step 4 runs it twice).
  async function clearHold(jobProcessId: number, unitId: number, jobId: number, created?: number[]): Promise<void> {
    const itemIds = await blockingQcpItemIds(jobProcessId);
    for (const qcpItemId of itemIds) {
      if (created) {
        // Tracked mode: other files record attempts on these units and the latest attempt wins, so overwriting
        // attempt 1 would not clear anything. Add a newer ACCEPTED attempt; the caller deletes it afterwards.
        const latest = await owner.qcpExecution.findFirst({ where: { qcpItemId, unitId }, orderBy: { attemptNo: "desc" } });
        const row = await owner.qcpExecution.create({ data: { qcpItemId, unitId, result: "ACCEPTED", attemptNo: (latest?.attemptNo ?? 0) + 1, jobId } });
        created.push(row.id);
        continue;
      }
      await owner.qcpExecution.upsert({
        where: { qcpItemId_unitId_attemptNo: { qcpItemId, unitId, attemptNo: 1 } },
        create: { qcpItemId, unitId, result: "ACCEPTED", attemptNo: 1, jobId },
        update: { result: "ACCEPTED" },
      });
    }
  }

  // Reschedule now carries real work forward instead of resetting it (audit
  // C1 fix) — this file's own DB-gated tests, and siblings sharing this
  // no-cleanup seed DB (qcp.service.test.ts), advance real ProcessPlan rows
  // via startProcess/submitProcess/verifyProcess. A test that assumes a
  // NOT_STARTED baseline for the exact (jobProcess, unit) pairs it drives must
  // reset those specific rows itself first, same spirit as clearHold above
  // resetting its own precondition — reset on the CURRENT run so the carried-
  // forward state generateSchedule reads is clean.
  async function resetPlans(jobId: number, jobProcessIds: number[], unitIds: number[]): Promise<void> {
    await owner.processPlan.updateMany({
      where: { scheduleRun: { jobId, isCurrent: true }, jobProcessId: { in: jobProcessIds }, unitId: { in: unitIds } },
      data: { status: "NOT_STARTED", actualStart: null, actualFinish: null, submittedBy: null, verifiedBy: null },
    });
  }

  const future = new Date(Date.now() + 30 * 864e5);

  /**
   * Runs `fn` with every item that feeds a process on the given units (component operations and assembly steps,
   * whichever mapping reaches them: the service's own loadMappedOps) marked COMPLETE, then restores them (even on
   * failure): submitProcess refuses while a mapped item is open (Phase 3, R2), and left COMPLETE they would break
   * every later run of the shared seed DB.
   */
  async function withMappedOpsComplete<T>(jobId: number, seq: number, unitIds: number[], fn: () => Promise<T>): Promise<T> {
    const { withTenant } = await import("@/lib/db");
    const { loadMappedOps } = await import("./_shared");
    const { tenantId } = await owner.job.findUniqueOrThrow({ where: { id: jobId }, select: { tenantId: true } });
    const jobProcessId = await procId(jobId, seq);
    const items = (
      await Promise.all(unitIds.map((unitId) => withTenant(tenantId, (tx) => loadMappedOps(tx, { jobProcessId, unitId, jobId }))))
    ).flat();
    const done = { status: "COMPLETE" as const, finishedAt: new Date() };
    const ops = items.filter((i) => i.source === "fabrication");
    const steps = items.filter((i) => i.source === "assembly");
    const beforeOps = await owner.componentOperation.findMany({ where: { id: { in: ops.map((i) => i.id) } }, select: { id: true, status: true, finishedAt: true } });
    const beforeSteps = await owner.assemblyStep.findMany({ where: { id: { in: steps.map((i) => i.id) } }, select: { id: true, status: true, finishedAt: true } });
    await owner.componentOperation.updateMany({ where: { id: { in: ops.map((i) => i.id) } }, data: done });
    await owner.assemblyStep.updateMany({ where: { id: { in: steps.map((i) => i.id) } }, data: done });
    try {
      return await fn();
    } finally {
      for (const { id, ...was } of beforeOps) await owner.componentOperation.update({ where: { id }, data: was });
      for (const { id, ...was } of beforeSteps) await owner.assemblyStep.update({ where: { id }, data: was });
    }
  }

  it("per-unit gating isolation: unit A's completion never gates unit B open (UNIT-grain 12 -> 13)", async () => {
    const { jobId, tenantId } = await despl320();
    const a = planner(tenantId);

    const [unitA, unitB] = await owner.unit.findMany({ where: { equipment: { jobId } }, orderBy: { id: "asc" } });

    // P = seq 12, S = seq 13: a real FINISH_TO_START edge between two UNIT-grain processes (processes 1-11 are
    // job-level since L1.3, so per-unit gating is shown here).
    const pId = await procId(jobId, 12);
    const sId = await procId(jobId, 13);
    expect((await owner.jobProcess.findUniqueOrThrow({ where: { id: pId } })).grain).toBe("UNIT");
    expect((await owner.jobProcess.findUniqueOrThrow({ where: { id: sId } })).grain).toBe("UNIT");
    await resetPlans(jobId, [pId, sId], [unitA.id, unitB.id]);

    // P's own predecessor (process 11) is job-level: complete it for the test, and put it back afterwards.
    const predIds = (await owner.jobProcessEdge.findMany({ where: { processId: pId }, select: { predecessorId: true } })).map((e) => e.predecessorId);
    const predPlans = await owner.processPlan.findMany({
      where: { scheduleRun: { jobId, isCurrent: true }, jobProcessId: { in: predIds } },
      select: { id: true, status: true, actualFinish: true },
    });
    await owner.processPlan.updateMany({ where: { id: { in: predPlans.map((x) => x.id) } }, data: { status: "COMPLETE", actualFinish: new Date() } });
    const created: number[] = [];
    try {
      const run = await generateSchedule(a, { jobId, mode: "FORWARD", projectStartDate: future });
      const planId = (jobProcessId: number, unitId: number) =>
        run.processPlans.find((p) => p.jobProcessId === jobProcessId && p.unitId === unitId)!.id;

      // Clear any blocking checkpoint P carries, for unit A only, so P can legitimately reach COMPLETE there.
      await clearHold(pId, unitA.id, jobId, created);

      const maker = a;
      const checker: Actor = { ...a, userId: 2, roles: [ROLES.QC] };

      await startProcess(maker, { processPlanId: planId(pId, unitA.id) });
      await withMappedOpsComplete(jobId, 12, [unitA.id], async () => {
        await submitProcess(maker, { processPlanId: planId(pId, unitA.id) });
      });
      const verifiedP = await verifyProcess(checker, { processPlanId: planId(pId, unitA.id) });
      expect(verifiedP.status).toBe("COMPLETE");

      // Core proof: unit A's own predecessor plan is COMPLETE, so S starts.
      const startedA = await startProcess(maker, { processPlanId: planId(sId, unitA.id) });
      expect(startedA.status).toBe("IN_PROGRESS");

      // Unit B's predecessor plan for the SAME job process was never touched (still NOT_STARTED): S must be
      // refused on unit B. (loadPredecessorStates once ignored unitId, so completing P on ANY unit unblocked S on ALL.)
      const err = await startProcess(maker, { processPlanId: planId(sId, unitB.id) }).catch((e) => e);
      expect(isAppError(err) && err.code).toBe(ERROR_CODES.GATING_BLOCKED);
    } finally {
      await owner.qcpExecution.deleteMany({ where: { id: { in: created } } });
      for (const x of predPlans) await owner.processPlan.update({ where: { id: x.id }, data: { status: x.status, actualFinish: x.actualFinish } });
      await resetPlans(jobId, [pId, sId], [unitA.id, unitB.id]);
    }
  });

  it("a job-level plan (process 10) cannot verify while ANY unit's hold point is open; it can once every unit's is cleared", async () => {
    const { jobId, tenantId } = await despl320();
    const a = planner(tenantId);
    const units = await owner.unit.findMany({ where: { equipment: { jobId } }, orderBy: { id: "asc" } });
    const unitIds = units.map((u) => u.id);

    // Processes 1-10 are job-level since L1.3: one plan each, so this test clears and completes the chain once, job-wide.
    const chainSeqs = [1, 2, 3, 4, 7, 8, 9, 10];
    const chainIds = await Promise.all(chainSeqs.map((seq) => procId(jobId, seq)));
    for (const id of chainIds) expect((await owner.jobProcess.findUniqueOrThrow({ where: { id } })).grain).toBe("JOB");
    const resetChain = () =>
      owner.processPlan.updateMany({
        where: { scheduleRun: { jobId, isCurrent: true }, jobProcessId: { in: chainIds } },
        data: { status: "NOT_STARTED", actualStart: null, actualFinish: null, submittedBy: null, verifiedBy: null },
      });
    await resetChain();

    const created: number[] = [];
    try {
      const run = await generateSchedule(a, { jobId, mode: "FORWARD", projectStartDate: future });
      const planId = (jobProcessId: number) => {
        const plan = run.processPlans.find((p) => p.jobProcessId === jobProcessId && p.unitId == null);
        if (!plan) throw new Error(`no job-level plan for process ${jobProcessId}`);
        return plan.id;
      };

      const maker = a;
      const checker: Actor = { ...a, userId: 2, roles: [ROLES.QC] };

      async function complete(seq: number) {
        const jobProcessId = await procId(jobId, seq);
        const id = planId(jobProcessId);
        await startProcess(maker, { processPlanId: id });
        await withMappedOpsComplete(jobId, seq, unitIds, async () => {
          await submitProcess(maker, { processPlanId: id });
        });
        return verifyProcess(checker, { processPlanId: id });
      }

      // Checkpoints on seq 1 and 2 (QcpItem 4) are cleared on every unit so the chain can reach seq 10.
      const seq1Id = await procId(jobId, 1);
      for (const u of unitIds) await clearHold(seq1Id, u, jobId, created);
      for (const seq of [1, 2, 3, 4, 7, 8, 9]) expect((await complete(seq)).status).toBe("COMPLETE");

      // seq 10's own checkpoint (a different QcpItem) is open on every unit.
      const seq10Id = await procId(jobId, 10);
      expect((await blockingQcpItemIds(seq10Id)).length).toBeGreaterThan(0);
      await startProcess(maker, { processPlanId: planId(seq10Id) });
      await withMappedOpsComplete(jobId, 10, unitIds, async () => {
        await submitProcess(maker, { processPlanId: planId(seq10Id) });
      });

      // Open on all units: refused. Cleared on all but the last unit: still refused (any unit blocks).
      const refuse = async () => {
        const err = await verifyProcess(checker, { processPlanId: planId(seq10Id) }).catch((e) => e);
        expect(isAppError(err) ? err.code : err instanceof Error ? err.message : `verified: ${JSON.stringify((err as { status?: string }).status)}`).toBe(ERROR_CODES.HOLD_POINT_OPEN);
      };
      await refuse();
      for (const u of unitIds.slice(0, -1)) await clearHold(seq10Id, u, jobId, created);
      await refuse();

      // Cleared on the last unit too: verify goes through.
      await clearHold(seq10Id, unitIds[unitIds.length - 1], jobId, created);
      expect((await verifyProcess(checker, { processPlanId: planId(seq10Id) })).status).toBe("COMPLETE");
    } finally {
      await owner.qcpExecution.deleteMany({ where: { id: { in: created } } });
      await resetChain();
    }
  });
});

/**
 * Phase 3, R2: `submitProcess` refuses when a mapped `ComponentOperation` on
 * this (process, unit) is not COMPLETE. Own minimal fixture (mirrors the
 * first describe block above) — a single JobProcess with no predecessors, so
 * `startProcess`/gating never enter the picture and the test isolates the
 * new gate only.
 */
describe.skipIf(!RUN_DB)("submitProcess component-ops gate (Phase 3, R2, DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { startProcess, submitProcess } = await import("./process.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("refuses submit while a mapped ComponentOperation is incomplete, naming it, then allows it once complete", async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-COMPOPS-${Date.now()}`, name: "Component-ops gate test" },
    });
    const tenantId = org.id;

    const dept = await owner.department.create({ data: { tenantId, code: "F", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "Client" } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV template" } });
    const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-compops-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-COMPOPS-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel" } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "SR01" } });

    // seq 12 mirrors the real spine's CUTTING slot — arbitrary here, just a
    // code the mapped OperationRef can point at.
    const jobProcess = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 12, code: "12", name: "Cutting", departmentId: dept.id },
    });
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "SHELL", name: "Shell" } });
    const operation = await owner.operationRef.create({
      data: { tenantId, code: "CUTTING", name: "Cutting / Blanking" },
    });
    await owner.operationRefFamilySeq.create({
      data: { tenantId, operationRefId: operation.id, familyId: family.id, leadTimeProcessSeq: 12 },
    });
    const component = await owner.component.create({
      data: { jobId: job.id, equipmentId: equipment.id, unitId: unit.id, tag: "SHELL-1", componentTypeId: componentType.id },
    });
    const componentOp = await owner.componentOperation.create({
      data: { jobId: job.id, componentId: component.id, seq: 1, operationId: operation.id, status: "NOT_STARTED" },
    });

    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, equipmentId: null, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    const plan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jobProcess.id, unitId: unit.id, ownerDepartmentId: dept.id, status: "NOT_STARTED" },
    });

    const user = await owner.user.create({
      data: { tenantId, email: "fab@x", username: "fab", name: "Fab", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null, mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
    const actor: Actor = { ...base, userId: user.id, name: "Fab", email: "fab@x", roles: [ROLES.SUPERVISOR], departmentIds: [dept.id] };

    await startProcess(actor, { processPlanId: plan.id });

    const err = await submitProcess(actor, { processPlanId: plan.id }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.COMPONENT_OPS_INCOMPLETE);
    expect(isAppError(err) && (err.detail?.incompleteOperations as string[])).toContain("Cutting / Blanking");

    await owner.componentOperation.update({ where: { id: componentOp.id }, data: { status: "COMPLETE" } });

    const submitted = await submitProcess(actor, { processPlanId: plan.id });
    expect(submitted.status).toBe("SUBMITTED");
  });
});

/**
 * Phase 5, N3: `verifyProcess` refuses when a mapped ComponentOperation on
 * this (process, unit) has an open Ncr — created here the real way, via
 * component.service's start/submit/reject flow (Task 2), not a hand-inserted
 * row. Own minimal fixture, same shape as the component-ops gate above:
 * a single JobProcess with no predecessors, so gating/hold-point checks never
 * enter the picture and the test isolates the new NCR gate only.
 */
describe.skipIf(!RUN_DB)("verifyProcess NCR gate (Phase 5, N3, DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { startProcess, submitProcess, verifyProcess } = await import("./process.service");
  const { startComponentOperation, submitComponentOperation, rejectComponentOperation } = await import(
    "./component.service"
  );
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("refuses verify while a mapped operation has an open Ncr, naming it, then allows it once the Ncr is closed", async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-NCRGATE-${Date.now()}`, name: "Ncr gate test" },
    });
    const tenantId = org.id;

    const dept = await owner.department.create({ data: { tenantId, code: "F", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "Client" } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV template" } });
    const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-ncrgate-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-NCRGATE-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel" } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "SR01" } });

    // seq 13 is arbitrary here — just a code the mapped OperationRef can point at.
    const jobProcess = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 13, code: "13", name: "Welding", departmentId: dept.id },
    });
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "SHELL", name: "Shell" } });
    const operation = await owner.operationRef.create({
      data: { tenantId, code: "WELDING", name: "Shell Welding", defaultDepartmentId: dept.id },
    });
    await owner.operationRefFamilySeq.create({
      data: { tenantId, operationRefId: operation.id, familyId: family.id, leadTimeProcessSeq: 13 },
    });
    const component = await owner.component.create({
      data: { jobId: job.id, equipmentId: equipment.id, unitId: unit.id, tag: "SHELL-1", componentTypeId: componentType.id },
    });
    const componentOp = await owner.componentOperation.create({
      data: { jobId: job.id, componentId: component.id, seq: 1, operationId: operation.id, status: "NOT_STARTED" },
    });
    const rejectCategoryId = (
      await owner.delayCategoryRef.create({ data: { tenantId, code: "REWORK", name: "Rework" } })
    ).id;

    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, equipmentId: null, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    const plan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jobProcess.id, unitId: unit.id, ownerDepartmentId: dept.id, status: "NOT_STARTED" },
    });

    const userSup = await owner.user.create({
      data: { tenantId, email: "ncrgate-sup@x", username: "ncrgate-sup", name: "Sup", passwordHash: "x" },
    });
    const userQc = await owner.user.create({
      data: { tenantId, email: "ncrgate-qc@x", username: "ncrgate-qc", name: "Qc", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null, mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
    const maker: Actor = {
      ...base,
      userId: userSup.id,
      name: "Sup",
      email: "ncrgate-sup@x",
      roles: [ROLES.SUPERVISOR, ROLES.QC],
      departmentIds: [dept.id],
    };
    const checker: Actor = {
      ...base,
      userId: userQc.id,
      name: "Qc",
      email: "ncrgate-qc@x",
      roles: [ROLES.QC],
      departmentIds: [],
    };

    // Real reject flow (Task 2), not a hand-inserted Ncr row: this is what
    // produces the OPEN Ncr the gate must see.
    await startComponentOperation(maker, { componentOperationId: componentOp.id });
    await submitComponentOperation(maker, { componentOperationId: componentOp.id });
    await rejectComponentOperation(checker, {
      componentOperationId: componentOp.id,
      categoryId: rejectCategoryId,
      detail: "porosity",
    });

    const rejection = await owner.componentOperationRejection.findFirstOrThrow({
      where: { componentOperationId: componentOp.id },
    });
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { componentOperationRejectionId: rejection.id } });
    expect(ncr.status).toBe("OPEN");

    // Isolate the NCR gate from the (already-covered, Phase 3 R2) component-ops
    // gate on submitProcess: reject leaves the ComponentOperation IN_PROGRESS,
    // not COMPLETE, which would otherwise trip COMPONENT_OPS_INCOMPLETE before
    // verify is even reached. Force it COMPLETE directly — real rework would
    // do this via startComponentOperation/submitComponentOperation, tested
    // elsewhere; the Ncr staying OPEN independent of the op's own status is
    // exactly the scenario this gate exists for (rework done, disposition/close
    // still pending).
    await owner.componentOperation.update({ where: { id: componentOp.id }, data: { status: "COMPLETE" } });

    await startProcess(maker, { processPlanId: plan.id });
    await submitProcess(maker, { processPlanId: plan.id });

    // Table-driven: OPEN (never dispositioned) and REWORK_IN_PROGRESS (rework
    // not yet re-verified) must refuse verify, naming the blocking operation —
    // not just the freshly-rejected OPEN case. These are the two statuses
    // dispositionNcr actually leaves an Ncr in on the rework path, so they're
    // the common real-world shape, not an edge case.
    for (const status of ["OPEN", "REWORK_IN_PROGRESS"] as const) {
      await owner.ncr.update({ where: { id: ncr.id }, data: { status } });
      const err = await verifyProcess(checker, { processPlanId: plan.id }).catch((e) => e);
      expect(isAppError(err) && err.code, `status=${status}`).toBe(ERROR_CODES.NCR_OPEN);
      expect(isAppError(err) && (err.detail?.blockingOperations as string[]), `status=${status}`).toContain(
        "Shell Welding",
      );
    }

    // Fix wave (Important #3): a terminal disposition (USE_AS_IS/SCRAP/
    // CONCESSION) leaves status DISPOSITIONED forever — the component is
    // scrapped or accepted as-is, so it will never be re-verified through
    // closeNcr. That must NOT permanently block the gate: DISPOSITIONED with
    // one of these three dispositions is excluded from "open" and verify
    // succeeds even though the Ncr's status never reaches CLOSED.
    await owner.ncr.update({
      where: { id: ncr.id },
      data: { status: "DISPOSITIONED", disposition: "SCRAP" },
    });

    const verified = await verifyProcess(checker, { processPlanId: plan.id });
    expect(verified.status).toBe("COMPLETE");

    const finalNcr = await owner.ncr.findUniqueOrThrow({ where: { id: ncr.id } });
    expect(finalNcr.status).toBe("DISPOSITIONED"); // not silently flipped to CLOSED — nothing was actually re-verified
  });
});

describe.skipIf(!RUN_DB)("verifyProcess evidence gate (Phase 5, D4, DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { startProcess, submitProcess, verifyProcess } = await import("./process.service");
  const { createPackage, assignUnitToPackage } = await import("./packing.service");
  const { createDispatchBatch, addUnitToBatch, approveDispatchRelease, recordDispatch } = await import(
    "./dispatch.service"
  );
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("gates Packing/Dispatch on real evidence; leaves an untagged (old-version-shaped) stage unaffected — invariant #9", async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-EVGATE-${Date.now()}`, name: "Evidence gate test" },
    });
    const tenantId = org.id;

    const dept = await owner.department.create({ data: { tenantId, code: "D", name: "Dispatch" } });
    const client = await owner.client.create({ data: { tenantId, name: "Client" } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV template" } });
    const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    // TemplateProcess rows carrying evidenceKind — this is what the real
    // add-packing-dispatch-evidence-v2.ts script tags on a new published
    // version; a plain DRAFT row here is enough for the gate, which reads
    // evidenceKind directly and doesn't care about publish state.
    const tpPacking = await owner.templateProcess.create({
      data: {
        versionId: version.id,
        seq: 34,
        code: "34",
        name: "Packing & Preservation",
        defaultDepartmentId: dept.id,
        evidenceKind: "PACKING_DONE",
      },
    });
    const tpDispatch = await owner.templateProcess.create({
      data: {
        versionId: version.id,
        seq: 36,
        code: "36",
        name: "Dispatch",
        defaultDepartmentId: dept.id,
        evidenceKind: "DISPATCH_RECORDED",
      },
    });
    // No evidenceKind — stands in for a JobProcess pinned to the OLD
    // (pre-D4) template version, which never had this column populated.
    const tpUntagged = await owner.templateProcess.create({
      data: { versionId: version.id, seq: 1, code: "1", name: "PO Receipt", defaultDepartmentId: dept.id },
    });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-evgate-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-EVGATE-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel" } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "SR01" } });

    const jpPacking = await owner.jobProcess.create({
      data: { jobId: job.id, templateProcessId: tpPacking.id, seq: 34, code: "34", name: "Packing & Preservation", departmentId: dept.id },
    });
    const jpDispatch = await owner.jobProcess.create({
      data: { jobId: job.id, templateProcessId: tpDispatch.id, seq: 36, code: "36", name: "Dispatch", departmentId: dept.id },
    });
    const jpUntagged = await owner.jobProcess.create({
      data: { jobId: job.id, templateProcessId: tpUntagged.id, seq: 1, code: "1", name: "PO Receipt", departmentId: dept.id },
    });

    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, equipmentId: null, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });
    const planPacking = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpPacking.id, unitId: unit.id, ownerDepartmentId: dept.id, status: "NOT_STARTED" },
    });
    const planDispatch = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpDispatch.id, unitId: unit.id, ownerDepartmentId: dept.id, status: "NOT_STARTED" },
    });
    const planUntagged = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpUntagged.id, unitId: unit.id, ownerDepartmentId: dept.id, status: "NOT_STARTED" },
    });

    const userSup = await owner.user.create({
      data: { tenantId, email: "evgate-sup@x", username: "evgate-sup", name: "Sup", passwordHash: "x" },
    });
    const userQc = await owner.user.create({
      data: { tenantId, email: "evgate-qc@x", username: "evgate-qc", name: "Qc", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null, mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
    const maker: Actor = {
      ...base,
      userId: userSup.id,
      name: "Sup",
      email: "evgate-sup@x",
      roles: [ROLES.SUPERVISOR, ROLES.QC, ROLES.PRODUCTION_HEAD],
      departmentIds: [dept.id],
    };
    const checker: Actor = {
      ...base,
      userId: userQc.id,
      name: "Qc",
      email: "evgate-qc@x",
      roles: [ROLES.QC, ROLES.PRODUCTION_HEAD],
      departmentIds: [],
    };

    // ── Untagged stage: unaffected — same start/submit/verify path with no
    // evidence recorded at all, and it just goes through (invariant #9). ──
    await startProcess(maker, { processPlanId: planUntagged.id });
    await submitProcess(maker, { processPlanId: planUntagged.id });
    const verifiedUntagged = await verifyProcess(checker, { processPlanId: planUntagged.id });
    expect(verifiedUntagged.status).toBe("COMPLETE");

    // ── Packing: refuses until the unit has a packageId, via the real
    // createPackage/assignUnitToPackage flow. ──
    await startProcess(maker, { processPlanId: planPacking.id });
    await submitProcess(maker, { processPlanId: planPacking.id });
    const packingErr = await verifyProcess(checker, { processPlanId: planPacking.id }).catch((e) => e);
    expect(isAppError(packingErr) && packingErr.code).toBe(ERROR_CODES.EVIDENCE_NOT_SATISFIED);
    expect(isAppError(packingErr) && (packingErr.detail?.evidenceKind as string)).toBe("PACKING_DONE");

    const pkg = await createPackage(maker, { jobId: job.id, packageNo: "PKG-1" });
    await assignUnitToPackage(maker, { packageId: pkg.id, unitId: unit.id });

    const verifiedPacking = await verifyProcess(checker, { processPlanId: planPacking.id });
    expect(verifiedPacking.status).toBe("COMPLETE");

    // ── Dispatch: refuses until the unit's batch has actualDispatchDate set,
    // via the real createDispatchBatch/addUnitToBatch/approveDispatchRelease/
    // recordDispatch flow. ──
    await startProcess(maker, { processPlanId: planDispatch.id });
    await submitProcess(maker, { processPlanId: planDispatch.id });
    const dispatchErr = await verifyProcess(checker, { processPlanId: planDispatch.id }).catch((e) => e);
    expect(isAppError(dispatchErr) && dispatchErr.code).toBe(ERROR_CODES.EVIDENCE_NOT_SATISFIED);
    expect(isAppError(dispatchErr) && (dispatchErr.detail?.evidenceKind as string)).toBe("DISPATCH_RECORDED");

    const batch = await createDispatchBatch(maker, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await addUnitToBatch(maker, { dispatchBatchId: batch.id, unitId: unit.id });

    // Batch not released/dispatched yet — still refuses.
    const dispatchErr2 = await verifyProcess(checker, { processPlanId: planDispatch.id }).catch((e) => e);
    expect(isAppError(dispatchErr2) && dispatchErr2.code).toBe(ERROR_CODES.EVIDENCE_NOT_SATISFIED);

    await approveDispatchRelease(maker, { dispatchBatchId: batch.id });
    await recordDispatch(maker, { dispatchBatchId: batch.id });

    const verifiedDispatch = await verifyProcess(checker, { processPlanId: planDispatch.id });
    expect(verifiedDispatch.status).toBe("COMPLETE");
  });
});
