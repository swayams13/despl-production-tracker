import { withTenant, type Tx } from "@/lib/db";
import { type Actor, assertNotClientUser, requireRole, ROLES } from "@/lib/authz";
import { audited } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { assertStateTransition } from "./state-machine";
import { dispositionNcrSchema, type DispositionNcrInput } from "@/lib/shared/schemas";
import type { Ncr, NcrStatus, NcrDisposition } from "@/generated/prisma/client";

/**
 * N1/N2/N4 (Phase 5) — the disposition/rework workflow layered on top of
 * ComponentOperationRejection/AssemblyStepRejection (F5). Those rejection
 * rows are the immutable "why reopened" record; Ncr tracks what QC decided
 * to do about it and, for REWORK/REPAIR, how long the rework took.
 */

export type NcrAction = "dispositionRework" | "dispositionFinal" | "close";

export const NCR_TRANSITIONS: Record<NcrAction, { from: NcrStatus[]; to: NcrStatus }> = {
  // REWORK/REPAIR send it back to the floor.
  dispositionRework: { from: ["OPEN"], to: "REWORK_IN_PROGRESS" },
  // USE_AS_IS/SCRAP/CONCESSION need no further floor action.
  dispositionFinal: { from: ["OPEN"], to: "DISPOSITIONED" },
  // Auto-closed from the operation's verify flow once rework is re-verified,
  // or manually for a DISPOSITIONED (no-rework) Ncr via a later UI action.
  close: { from: ["OPEN", "DISPOSITIONED", "REWORK_IN_PROGRESS"], to: "CLOSED" },
};

export function assertNcrTransition(action: NcrAction, from: NcrStatus): NcrStatus {
  return assertStateTransition(NCR_TRANSITIONS, action, from, "Ncr");
}

const REWORK_DISPOSITIONS: NcrDisposition[] = ["REWORK", "REPAIR"];

/**
 * Locks the row and re-reads tenant-scoped. `Ncr` carries no tenantId of its
 * own (audit C3 precedent — same reason qcp.service.ts anchors through
 * unit.equipment.job): reachable only via its rejection → operation/step →
 * component/unit → equipment → job → tenantId chain.
 */
async function lockNcrForUpdate(tx: Tx, ncrId: number, tenantId: number): Promise<Ncr> {
  await tx.$queryRaw`SELECT id FROM ncrs WHERE id = ${ncrId} FOR UPDATE`;

  const ncr = await tx.ncr.findFirst({
    where: {
      id: ncrId,
      OR: [
        {
          componentOperationRejection: {
            componentOperation: { component: { equipment: { job: { tenantId } } } },
          },
        },
        {
          assemblyStepRejection: {
            assemblyStep: { unit: { equipment: { job: { tenantId } } } },
          },
        },
      ],
    },
  });
  if (!ncr) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Ncr", ncrId });
  return ncr;
}

/**
 * QC dispositions an open NCR (QC-role-gated — same pattern as
 * `recordQcpExecution`, invariant #4's checkpoint-clearing act). REWORK/REPAIR
 * move it to REWORK_IN_PROGRESS and stamp `reworkStartedAt` now (the
 * operation is already back at the maker per F5's reject — there is no
 * separate "start" click in this flow, so disposition time IS rework-start
 * time). The defensive stamp in `startComponentOperation`/`startAssemblyStep`
 * covers the rarer case where the operation legitimately returns to
 * NOT_STARTED first (e.g. an admin correction) without double-stamping,
 * since both check `reworkStartedAt == null` before writing.
 */
export async function dispositionNcr(actor: Actor, input: DispositionNcrInput): Promise<Ncr> {
  const { ncrId, disposition, notes, reworkOwnerId, reworkDueDate } = dispositionNcrSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC);

  return withTenant(actor.tenantId, async (tx) => {
    const ncr = await lockNcrForUpdate(tx, ncrId, actor.tenantId);
    const isRework = REWORK_DISPOSITIONS.includes(disposition);
    const to = assertNcrTransition(isRework ? "dispositionRework" : "dispositionFinal", ncr.status);

    return audited(tx, actor, async () => {
      const now = new Date();
      const updated = await tx.ncr.update({
        where: { id: ncr.id },
        data: {
          status: to,
          disposition,
          dispositionedBy: actor.userId,
          dispositionedAt: now,
          dispositionNotes: notes ?? undefined,
          reworkOwnerId: reworkOwnerId ?? undefined,
          reworkDueDate: reworkDueDate ?? undefined,
          reworkStartedAt: isRework && ncr.reworkStartedAt == null ? now : undefined,
        },
      });
      return {
        result: updated,
        audit: {
          action: "ncr.disposition",
          entityType: "Ncr",
          entityId: ncr.id,
          before: { status: ncr.status, disposition: ncr.disposition },
          after: { status: updated.status, disposition: updated.disposition, reworkOwnerId: updated.reworkOwnerId },
          eventType: "ncr.dispositioned",
          eventPayload: { ncrId: ncr.id, disposition, status: updated.status },
        },
      };
    });
  });
}

/**
 * Closes an NCR. Not user-facing for the REWORK/REPAIR path — called
 * automatically from `verifyComponentOperation`/`verifyAssemblyStep` in the
 * SAME transaction once the reworked operation reaches COMPLETE again, so
 * `closeNcr` here takes an already-tenant-scoped `tx` rather than opening its
 * own (mirrors `recordNdtResultTx`'s bare-tx shape in welding.service.ts).
 * Stamps `reworkFinishedAt` in the same write when rework was in progress —
 * that pairing IS "elapsed rework time" (dashboard aggregation reads both).
 */
export async function closeNcr(tx: Tx, actor: Actor, input: { ncrId: number }): Promise<Ncr> {
  const ncr = await tx.ncr.findFirst({ where: { id: input.ncrId } });
  if (!ncr) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Ncr", ncrId: input.ncrId });
  const to = assertNcrTransition("close", ncr.status);

  return audited(tx, actor, async () => {
    const now = new Date();
    const updated = await tx.ncr.update({
      where: { id: ncr.id },
      data: {
        status: to,
        closedBy: actor.userId,
        closedAt: now,
        reworkFinishedAt: ncr.reworkStartedAt != null && ncr.reworkFinishedAt == null ? now : undefined,
      },
    });
    return {
      result: updated,
      audit: {
        action: "ncr.close",
        entityType: "Ncr",
        entityId: ncr.id,
        before: { status: ncr.status },
        after: { status: updated.status, reworkFinishedAt: updated.reworkFinishedAt },
        eventType: "ncr.closed",
        eventPayload: { ncrId: ncr.id },
      },
    };
  });
}
