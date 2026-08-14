import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { recordQcpExecutionSchema, type RecordQcpExecutionInput } from "@/lib/shared/schemas";
import type { QcpExecution } from "@/generated/prisma/client";

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
    // Next attempt number for this (item, unit) — re-inspection after rejection.
    const prior = await tx.qcpExecution.aggregate({
      _max: { attemptNo: true },
      where: { qcpItemId, unitId },
    });
    const attemptNo = (prior._max.attemptNo ?? 0) + 1;

    return audited(tx, actor, async () => {
      const exec = await tx.qcpExecution.create({
        data: {
          qcpItemId,
          unitId,
          attemptNo,
          result,
          clearedBy: actor.userId,
          remarks: remarks ?? null,
          // recordedAt: DB default now() (invariant #1).
        },
      });
      return {
        result: exec,
        audit: {
          action: "qcp.record",
          entityType: "QcpExecution",
          entityId: exec.id,
          after: { qcpItemId, unitId, attemptNo, result },
          eventType: "QcpExecutionRecorded",
          eventPayload: { qcpItemId, unitId, attemptNo, result },
        },
      };
    });
  });
}
