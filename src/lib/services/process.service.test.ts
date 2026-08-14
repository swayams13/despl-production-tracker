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
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let supA: Actor; // supervisor+QC in deptA (maker)
  let qc: Actor; // QC only, different user (checker)
  let supB: Actor; // supervisor in deptB
  let planA = 0;
  let planB = 0;
  let planC = 0; // overdue, deptB — delay-block subject

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

    const jpA = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 10, code: "10", name: "A", departmentId: deptA.id },
    });
    const jpB = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 20, code: "20", name: "B", departmentId: deptA.id },
    });
    const jpC = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 30, code: "30", name: "C", departmentId: deptB.id },
    });
    await owner.jobProcessEdge.create({
      data: { processId: jpB.id, predecessorId: jpA.id, type: "FINISH_TO_START", lagDays: 0 },
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

    const userSup = await owner.user.create({
      data: { tenantId, email: "sup@x", name: "Sup", passwordHash: "x" },
    });
    const userQc = await owner.user.create({
      data: { tenantId, email: "qc@x", name: "Qc", passwordHash: "x" },
    });
    const userSupB = await owner.user.create({
      data: { tenantId, email: "supb@x", name: "SupB", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null };
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

  it("delay block: an overdue unreasoned plan blocks the department until a reason is filed (#7)", async () => {
    await expectCode(startProcess(supB, { processPlanId: planC }), ERROR_CODES.REASON_REQUIRED);

    const cat = await owner.delayCategoryRef.create({
      data: { tenantId, code: "MAT", name: "Material shortage" },
    });
    await owner.delayReason.create({
      data: { processPlanId: planC, categoryId: cat.id, detail: "late plate", filedBy: supB.userId },
    });

    const started = await startProcess(supB, { processPlanId: planC });
    expect(started.status).toBe("IN_PROGRESS");
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
});
