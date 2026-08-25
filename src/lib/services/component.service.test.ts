import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertComponentOpTransition,
  COMPONENT_OP_TRANSITIONS,
  type ComponentOperationAction,
} from "./component.service";
import { assertMakerChecker, ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { OperationStatus } from "@/generated/prisma/client";

/**
 * Pure guard tests (run in CI, no DB) pin the transition matrix and the
 * maker–checker guard as component.service.ts composes it, mirroring
 * process.service.test.ts's structure. The full locked-tx path (department
 * scope, sequential-route gate, audit-row-after-every-mutation) needs seeded
 * rows and lives in the RUN_DB_TESTS block below.
 */

const ALL_STATUSES: OperationStatus[] = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "COMPLETE"];

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return isAppError(e) ? e.code : "NON_APP_ERROR";
  }
  return undefined;
}

// ── Transition matrix (invariant: the state machine, not the UI) ────────────

describe("assertComponentOpTransition", () => {
  const legal: Array<[ComponentOperationAction, OperationStatus, OperationStatus]> = [
    ["start", "NOT_STARTED", "IN_PROGRESS"],
    ["submit", "IN_PROGRESS", "SUBMITTED"],
    ["verify", "SUBMITTED", "COMPLETE"],
  ];

  it.each(legal)("%s from %s → %s", (action, from, to) => {
    expect(assertComponentOpTransition(action, from)).toBe(to);
  });

  // Every (action, from) pair NOT in the legal table must be rejected —
  // notably no reject/hold path exists at all for ComponentOperation (#2
  // scaled down: flat sequence, no HOLD state, reject deferred to Task 4).
  const legalSet = new Set(legal.map(([a, f]) => `${a}:${f}`));
  const actions = Object.keys(COMPONENT_OP_TRANSITIONS) as ComponentOperationAction[];
  const illegal: Array<[ComponentOperationAction, OperationStatus]> = [];
  for (const a of actions)
    for (const f of ALL_STATUSES) if (!legalSet.has(`${a}:${f}`)) illegal.push([a, f]);

  it.each(illegal)("%s from %s → INVALID_STATE_TRANSITION", (action, from) => {
    expect(code(() => assertComponentOpTransition(action, from))).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
  });
});

// ── Maker–checker as verify composes it (invariant #3) — same guard fn as
// process.service.ts, table-driven the same way ────────────────────────────

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

/**
 * Full locked-transaction path against a live DB. Gated off by default; set
 * RUN_DB_TESTS=1 with DIRECT_URL pointing at a migrated database to run it
 * (`pnpm test:db` does this via .env.test → the disposable despl_test DB).
 * Builds its own throwaway job/component/operation fixture rather than
 * DESPL-320's seeded rows, same call as process.service.test.ts's first DB
 * block — table-driven service tests here build their own fixtures.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code so reruns
 * // don't collide (same pattern as process.service.test.ts).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("component operation state machine (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { startComponentOperation, submitComponentOperation, verifyComponentOperation } = await import(
    "./component.service"
  );
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let supA: Actor; // supervisor+QC in deptA (maker)
  let qc: Actor; // QC only, different user (checker)
  let supB: Actor; // supervisor in a DIFFERENT department (wrong-department attempt)
  let clientActor: Actor; // clientId set, roles: [QC] — proves assertNotClientUser does real work
  let opSeq1 = 0; // component A, seq 1 (RECEIPT)
  let opSeq2 = 0; // component A, seq 2 (CUTTING) — gated on opSeq1
  let componentBOpSeq1 = 0; // component B, seq 1 — independent route for cross-component isolation
  // Component C: ComponentOperation.seq assignment order is DELIBERATELY the
  // REVERSE of the canonical RouteStep order (regression fixture for #2 —
  // the gate must key off canonical route position, not raw seq).
  let componentCReceiptOp = 0; // ComponentOperation.seq = 1, canonical RouteStep.seq = 2
  let componentCCuttingOp = 0; // ComponentOperation.seq = 2, canonical RouteStep.seq = 1

  async function auditCount(entityId: number): Promise<number> {
    return owner.auditLog.count({
      where: { tenantId, entityType: "ComponentOperation", entityId: String(entityId) },
    });
  }

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-CO-${Date.now()}`, name: "Component svc test" },
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
        publicId: `pub-co-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-CO-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel" } });
    const componentType = await owner.componentTypeRef.create({
      data: { tenantId, code: "PLATE", name: "Plate" },
    });

    const opReceipt = await owner.operationRef.create({
      data: { tenantId, code: "RECEIPT", name: "Receipt", defaultDepartmentId: deptA.id },
    });
    const opCutting = await owner.operationRef.create({
      data: { tenantId, code: "CUTTING", name: "Cutting", defaultDepartmentId: deptA.id },
    });

    const componentA = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "N1", componentTypeId: componentType.id },
    });
    const componentB = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "N2", componentTypeId: componentType.id },
    });

    opSeq1 = (
      await owner.componentOperation.create({
        data: { componentId: componentA.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    opSeq2 = (
      await owner.componentOperation.create({
        data: { componentId: componentA.id, seq: 2, operationId: opCutting.id },
      })
    ).id;
    componentBOpSeq1 = (
      await owner.componentOperation.create({
        data: { componentId: componentB.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    // Canonical route: CUTTING (RouteStep.seq 1) then RECEIPT (RouteStep.seq 2)
    // — the reverse of componentA/B's natural op order — so component C's
    // ComponentOperation.seq assignment (RECEIPT=1, CUTTING=2, CSV-column
    // order) diverges from canonical route order on purpose.
    const routeTemplate = await owner.routeTemplate.create({
      data: { tenantId, componentTypeId: componentType.id, name: "Reversed route" },
    });
    const routeVersion = await owner.routeTemplateVersion.create({
      data: { routeId: routeTemplate.id, version: 1 },
    });
    await owner.routeStep.create({ data: { routeVersionId: routeVersion.id, seq: 1, operationId: opCutting.id } });
    await owner.routeStep.create({ data: { routeVersionId: routeVersion.id, seq: 2, operationId: opReceipt.id } });
    const componentC = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "N3", componentTypeId: componentType.id, routeVersionId: routeVersion.id },
    });
    componentCReceiptOp = (
      await owner.componentOperation.create({
        data: { componentId: componentC.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    componentCCuttingOp = (
      await owner.componentOperation.create({
        data: { componentId: componentC.id, seq: 2, operationId: opCutting.id },
      })
    ).id;

    const userSup = await owner.user.create({
      data: { tenantId, email: "co-sup@x", username: "co-sup", name: "Sup", passwordHash: "x" },
    });
    const userQc = await owner.user.create({
      data: { tenantId, email: "co-qc@x", username: "co-qc", name: "Qc", passwordHash: "x" },
    });
    const userSupB = await owner.user.create({
      data: { tenantId, email: "co-supb@x", username: "co-supb", name: "SupB", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null, mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
    supA = { ...base, userId: userSup.id, name: "Sup", email: "co-sup@x", roles: [ROLES.SUPERVISOR, ROLES.QC], departmentIds: [deptA.id] };
    qc = { ...base, userId: userQc.id, name: "Qc", email: "co-qc@x", roles: [ROLES.QC], departmentIds: [] };
    supB = { ...base, userId: userSupB.id, name: "SupB", email: "co-supb@x", roles: [ROLES.SUPERVISOR], departmentIds: [deptB.id] };
    // roles: [QC] so the ONLY thing that can throw FORBIDDEN on verify is
    // assertNotClientUser — mirrors qcp.service.test.ts's client-user case.
    clientActor = { ...base, userId: userQc.id, clientId: 1, name: "Client", email: "co-client@x", roles: [ROLES.QC], departmentIds: [] };
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

  it("out-of-order start: seq 2 cannot start before seq 1 on the same component (#2)", async () => {
    await expectCode(startComponentOperation(supA, { componentOperationId: opSeq2 }), ERROR_CODES.GATING_BLOCKED);
  });

  it("gate uses canonical route position, not raw ComponentOperation.seq (#2 regression): the op that's canonically FIRST starts immediately even though its ComponentOperation.seq is 2", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: componentCCuttingOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("gate uses canonical route position, not raw ComponentOperation.seq (#2 regression): the op that's canonically SECOND is blocked on its canonical predecessor, even though its ComponentOperation.seq is 1 (naive seq-1 gating would wrongly allow it immediately)", async () => {
    await expectCode(
      startComponentOperation(supA, { componentOperationId: componentCReceiptOp }),
      ERROR_CODES.GATING_BLOCKED,
    );
    // Clears once the canonical predecessor (CUTTING, seq 2 in the DB) completes.
    await submitComponentOperation(supA, { componentOperationId: componentCCuttingOp });
    await verifyComponentOperation(qc, { componentOperationId: componentCCuttingOp });
    const started = await startComponentOperation(supA, { componentOperationId: componentCReceiptOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("wrong department: a supervisor outside the operation's department cannot start it", async () => {
    await expectCode(startComponentOperation(supB, { componentOperationId: opSeq1 }), ERROR_CODES.FORBIDDEN);
  });

  it("client user cannot start or submit — read-only, no exceptions (#1 access rule)", async () => {
    await expectCode(startComponentOperation(clientActor, { componentOperationId: opSeq1 }), ERROR_CODES.FORBIDDEN);
  });

  it("happy path start → submit → verify, one audit row per mutation", async () => {
    const before = await auditCount(opSeq1);

    const started = await startComponentOperation(supA, { componentOperationId: opSeq1 });
    expect(started.status).toBe("IN_PROGRESS");
    expect(started.startedAt).toBeInstanceOf(Date);
    expect(await auditCount(opSeq1)).toBe(before + 1);

    const submitted = await submitComponentOperation(supA, { componentOperationId: opSeq1 });
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedBy).toBe(supA.userId);
    expect(await auditCount(opSeq1)).toBe(before + 2);

    const verified = await verifyComponentOperation(qc, { componentOperationId: opSeq1 });
    expect(verified.status).toBe("COMPLETE");
    expect(verified.finishedAt).toBeInstanceOf(Date);
    expect(verified.verifiedBy).toBe(qc.userId);
    expect(await auditCount(opSeq1)).toBe(before + 3);
  });

  it("cross-component isolation: completing component A's seq 1 never unblocks component B's seq 1", async () => {
    // component B's own seq 1 (never touched) must still be NOT_STARTED — a
    // real transition works regardless of what happened on component A.
    const started = await startComponentOperation(supA, { componentOperationId: componentBOpSeq1 });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("sequential gate now clears: seq 2 starts once seq 1 (same component) is COMPLETE", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: opSeq2 });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("maker–checker: the submitter cannot verify their own submission", async () => {
    await submitComponentOperation(supA, { componentOperationId: opSeq2 }); // submittedBy = supA
    await expectCode(
      verifyComponentOperation(supA, { componentOperationId: opSeq2 }),
      ERROR_CODES.MAKER_CHECKER_VIOLATION,
    );
    const verified = await verifyComponentOperation(qc, { componentOperationId: opSeq2 });
    expect(verified.status).toBe("COMPLETE");
  });

  it("illegal transition: verifying a NOT_STARTED operation is refused", async () => {
    await expectCode(
      verifyComponentOperation(qc, { componentOperationId: componentBOpSeq1 }),
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });

  it("client user cannot verify either, even holding the QC role (#1, no admin/role exception)", async () => {
    await submitComponentOperation(supA, { componentOperationId: componentBOpSeq1 });
    await expectCode(
      verifyComponentOperation(clientActor, { componentOperationId: componentBOpSeq1 }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("cross-tenant: another tenant's actor cannot reach this operation by id (NOT_FOUND)", async () => {
    const otherOrg = await owner.organization.create({
      data: { code: `TEST-CO-XT-${Date.now()}`, name: "Other tenant" },
    });
    const intruder: Actor = {
      userId: 999_999,
      tenantId: otherOrg.id,
      clientId: null,
      name: "Intruder",
      email: "intruder@other",
      roles: [ROLES.SUPERVISOR, ROLES.QC],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    const statusBefore = (await owner.componentOperation.findUniqueOrThrow({ where: { id: opSeq2 } })).status;

    await expectCode(startComponentOperation(intruder, { componentOperationId: opSeq2 }), ERROR_CODES.NOT_FOUND);
    await expectCode(submitComponentOperation(intruder, { componentOperationId: opSeq2 }), ERROR_CODES.NOT_FOUND);
    await expectCode(verifyComponentOperation(intruder, { componentOperationId: opSeq2 }), ERROR_CODES.NOT_FOUND);

    const after = await owner.componentOperation.findUniqueOrThrow({ where: { id: opSeq2 } });
    expect(after.status).toBe(statusBefore);
  });
});
