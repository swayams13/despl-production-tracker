import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { recordQcpExecutionSchema, type RecordQcpExecutionInput } from "@/lib/shared/schemas";
import type { QcpExecution, QcpExecutionResult } from "@/generated/prisma/client";

/**
 * Bare tx-level create, no audit of its own — same discipline as
 * `welding.service.ts`'s `recordNdtResultTx`. Callers already inside a
 * transaction (the public `recordQcpExecution` below, and A4's sync from
 * `assembly.service.ts`'s verify/reject) record their own audit row so the
 * write is never silently un-audited (invariant #5).
 */
export async function recordQcpExecutionTx(
  tx: Tx,
  actor: Actor,
  args: { qcpItemId: number; unitId: number; result: QcpExecutionResult; remarks?: string | null },
): Promise<QcpExecution> {
  // Next attempt number for this (item, unit) — re-inspection after rejection.
  const prior = await tx.qcpExecution.aggregate({
    _max: { attemptNo: true },
    where: { qcpItemId: args.qcpItemId, unitId: args.unitId },
  });
  const attemptNo = (prior._max.attemptNo ?? 0) + 1;

  return tx.qcpExecution.create({
    data: {
      qcpItemId: args.qcpItemId,
      unitId: args.unitId,
      attemptNo,
      result: args.result,
      clearedBy: actor.userId,
      remarks: args.remarks ?? null,
      // recordedAt: DB default now() (invariant #1).
    },
  });
}

/**
 * Minimal QCP checkpoint execution (CLAUDE.md invariant #4). Recording an
 * ACCEPTED/NA result for a unit clears a blocking hold point so the owning
 * process may complete; REJECTED leaves it open (the rework signal). This is
 * the smallest surface that lets per-unit hold points be cleared — TPI
 * call-given/attended and witness-waiver approval stay Phase 2.
 *
 * QC-role-gated: recording an inspection result is inherently a QC act. The
 * maker-checker rule (#3) sits on process verify, not on the execution itself.
 */
export async function recordQcpExecution(
  actor: Actor,
  input: RecordQcpExecutionInput,
): Promise<QcpExecution> {
  const { qcpItemId, unitId, result, remarks } = recordQcpExecutionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC);

  return withTenant(actor.tenantId, async (tx) => {
    // Neither `units` nor `qcp_items` carry tenant_id (audit C3), so a bare
    // id would happily accept another tenant's unit and let this actor clear
    // its blocking hold point. Anchor through `unit.equipment.job`, which IS
    // tenant-scoped — same pattern as `lockProcessPlanForUpdate` (_shared.ts).
    const unit = await tx.unit.findFirst({
      where: { id: unitId, equipment: { job: { tenantId: actor.tenantId } } },
    });
    if (!unit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Unit", unitId });

    return audited(tx, actor, async () => {
      const exec = await recordQcpExecutionTx(tx, actor, { qcpItemId, unitId, result, remarks });
      return {
        result: exec,
        audit: {
          action: "qcp.record",
          entityType: "QcpExecution",
          entityId: exec.id,
          after: { qcpItemId, unitId, attemptNo: exec.attemptNo, result },
          eventType: "QcpExecutionRecorded",
          eventPayload: { qcpItemId, unitId, attemptNo: exec.attemptNo, result },
        },
      };
    });
  });
}
