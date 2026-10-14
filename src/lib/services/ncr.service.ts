import { withJob, withTenant, type Tx } from "@/lib/db";
import { type Actor, assertNotClientUser, requireRole, ROLES } from "@/lib/authz";
import { audited, recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { HARD_RULES } from "@/lib/shared/floor-rules";
import { assertStateTransition } from "./state-machine";
import { lockFloorUnits, rollupForAssemblyStep, rollupForComponentOperation } from "./_shared";
import { loadFloorFacts, rowKey } from "./work.facts";
import { notify, userIdsWithRole } from "./notifications.service";
import {
  dispositionNcrSchema,
  raiseRuleNcrSchema,
  type DispositionNcrInput,
  type RaiseRuleNcrInput,
} from "@/lib/shared/schemas";
import type { AssemblyStepRole, Ncr, NcrStatus, NcrDisposition, NcrRuleCode } from "@/generated/prisma/client";

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
  // OPEN is deliberately NOT a source (AUD-026): closing straight from OPEN
  // skipped dispositionNcr entirely, so the manufacturing record showed a
  // non-conformance raised and closed with no recorded engineering decision.
  close: { from: ["DISPOSITIONED", "REWORK_IN_PROGRESS"], to: "CLOSED" },
};

export function assertNcrTransition(action: NcrAction, from: NcrStatus): NcrStatus {
  return assertStateTransition(NCR_TRANSITIONS, action, from, "Ncr");
}

const REWORK_DISPOSITIONS: NcrDisposition[] = ["REWORK", "REPAIR"];

/** L1.2f: the step a rule NCR's repair repeats, and back. */
const RULE_ROLE: Record<NcrRuleCode, AssemblyStepRole> = { H5: "FINAL_PWHT", H6: "HYDRO" };
const ROLE_RULE: Partial<Record<AssemblyStepRole, NcrRuleCode>> = { FINAL_PWHT: "H5", HYDRO: "H6" };

/**
 * Tenant scope for any Ncr. `Ncr` is reached through its source (audit C3
 * precedent — same reason qcp.service.ts anchors through unit.equipment.job):
 * a rejection → operation/step chain, or (L1.2f) a rule NCR's target item.
 */
export function ncrTenantScope(tenantId: number) {
  return {
    OR: [
      { componentOperationRejection: { componentOperation: { component: { equipment: { job: { tenantId } } } } } },
      { assemblyStepRejection: { assemblyStep: { unit: { equipment: { job: { tenantId } } } } } },
      { targetComponentOperation: { component: { equipment: { job: { tenantId } } } } },
      { targetAssemblyStep: { unit: { equipment: { job: { tenantId } } } } },
    ],
  };
}

/** Locks the row and re-reads tenant-scoped; also returns the unit its source item belongs to. */
export async function lockNcrForUpdate(tx: Tx, ncrId: number, tenantId: number): Promise<{ ncr: Ncr; unitId: number | null }> {
  const where = { id: ncrId, ...ncrTenantScope(tenantId) };
  // L1.2e: the unit's floor lock goes BEFORE the row lock, as in recordWork, so a
  // disposition and a concurrent Start/Done batch on the same unit serialise.
  const pre = await tx.ncr.findFirst({
    where,
    select: {
      jobId: true,
      assemblyStepRejection: { select: { assemblyStep: { select: { unitId: true } } } },
      componentOperationRejection: { select: { componentOperation: { select: { component: { select: { unitId: true } } } } } },
      targetAssemblyStep: { select: { unitId: true } },
      targetComponentOperation: { select: { component: { select: { unitId: true } } } },
    },
  });
  const unitId =
    pre?.assemblyStepRejection?.assemblyStep.unitId ??
    pre?.componentOperationRejection?.componentOperation.component.unitId ??
    pre?.targetAssemblyStep?.unitId ??
    pre?.targetComponentOperation?.component.unitId ??
    null;
  if (pre) await lockFloorUnits(tx, pre.jobId, [unitId]);
  await tx.$queryRaw`SELECT id FROM ncrs WHERE id = ${ncrId} FOR UPDATE`;

  const ncr = await tx.ncr.findFirst({ where });
  if (!ncr) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Ncr", ncrId });
  // H1 job-level RLS backstop: scope every subsequent query in THIS
  // transaction to the Ncr's own (denormalized) jobId, same pattern as
  // lockProcessPlanForUpdate/lockAssemblyStepForUpdate.
  await tx.$executeRaw`SELECT set_config('app.job_id', ${String(ncr.jobId)}, true)`;
  return { ncr, unitId };
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
  const { ncrId, disposition, notes, reworkOwnerId, reworkDueDate, codeClause } = dispositionNcrSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const { ncr, unitId } = await lockNcrForUpdate(tx, ncrId, actor.tenantId);
    // L1.2f (D2 H5/H6, decision 1 of 14 Oct): a rule NCR is repaired (QC; the
    // PWHT / hydro step is repeated) or accepted per a code clause (Production
    // Head, clause mandatory, flagged for QC head ratification). Every other
    // NCR is QC's, as before.
    const concession = ncr.ruleCode != null && disposition === "CONCESSION";
    if (ncr.ruleCode != null && disposition !== "REPAIR" && !concession) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { ncrId, disposition },
        "An H5/H6 NCR is resolved by repair (repeat PWHT or hydro) or by acceptance per a code clause.",
      );
    }
    if (concession) {
      requireRole(actor, ROLES.PRODUCTION_HEAD);
      if (!codeClause) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { field: "codeClause" }, "Record the code clause this acceptance relies on.");
      }
      await assertConcessionNotByMaker(tx, actor, ncr);
    } else {
      requireRole(actor, ROLES.QC);
    }
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
          codeClause: codeClause ?? undefined,
          concessionApprovedById: concession ? actor.userId : undefined,
        },
      });
      const reopened = ncr.ruleCode != null && isRework ? await reopenForRepair(tx, actor, ncr, unitId) : [];
      if (concession) await flagConcessionForRatification(tx, actor, updated);
      return {
        result: updated,
        audit: {
          action: "ncr.disposition",
          entityType: "Ncr",
          entityId: ncr.id,
          before: { status: ncr.status, disposition: ncr.disposition },
          after: {
            status: updated.status,
            disposition: updated.disposition,
            reworkOwnerId: updated.reworkOwnerId,
            ...(ncr.ruleCode != null
              ? {
                  ruleCode: ncr.ruleCode,
                  codeClause: updated.codeClause,
                  concessionApprovedById: updated.concessionApprovedById,
                  ratification: concession ? "QC_HEAD_PENDING" : null,
                  reopenedAssemblyStepIds: reopened,
                }
              : {}),
          },
          eventType: "ncr.dispositioned",
          eventPayload: { ncrId: ncr.id, disposition, status: updated.status },
        },
      };
    });
  });
}

/**
 * Invariant 3 on a concession: whoever accepts a rule violation per a code
 * clause did not raise its NCR and did not do the work it names. "Did the work"
 * is anyone with a recorded write on the target item (the audit trail of its
 * start / done / submit) or named on it (submittedBy, performedByUserId). Admins
 * are not exempt; a Production Head who started the weld cannot concede it.
 */
async function assertConcessionNotByMaker(tx: Tx, actor: Actor, ncr: Ncr): Promise<void> {
  const makers = new Set<number>();
  if (ncr.raisedBy != null) makers.add(ncr.raisedBy);
  const target =
    ncr.targetAssemblyStepId != null
      ? { entityType: "AssemblyStep", id: ncr.targetAssemblyStepId }
      : ncr.targetComponentOperationId != null
        ? { entityType: "ComponentOperation", id: ncr.targetComponentOperationId }
        : null;
  if (target) {
    const item =
      target.entityType === "AssemblyStep"
        ? await tx.assemblyStep.findFirst({
            where: { id: target.id, jobId: ncr.jobId },
            select: { submittedBy: true, performedByUserId: true },
          })
        : await tx.componentOperation.findFirst({
            where: { id: target.id, jobId: ncr.jobId },
            select: { submittedBy: true, performedByUserId: true },
          });
    for (const u of [item?.submittedBy, item?.performedByUserId]) if (u != null) makers.add(u);
    const trail = await tx.auditLog.findMany({
      where: { tenantId: actor.tenantId, entityType: target.entityType, entityId: String(target.id) },
      select: { actorId: true },
    });
    for (const a of trail) if (a.actorId != null) makers.add(a.actorId);
  }
  if (makers.has(actor.userId)) {
    throw new AppError(
      ERROR_CODES.MAKER_CHECKER_VIOLATION,
      { ncrId: ncr.id, reason: "raised the NCR or did the work it names" },
      "You raised this NCR or did the work it names, so you cannot accept it per a code clause. Another Production Head must.",
    );
  }
}

/**
 * L1.2f REPAIR of a rule NCR: "repair + repeat PWHT/hydro" reopens the unit's
 * FINAL_PWHT (H5) or HYDRO (H6) steps to NOT_STARTED, so H5/H6 stop refusing
 * the weld, and rolls their plans back. The original times stay in the audit
 * row (invariant 6). The NCR closes when the repeated step is complete again
 * (closeRuleNcrsOnRedo).
 */
async function reopenForRepair(tx: Tx, actor: Actor, ncr: Ncr, unitId: number | null): Promise<number[]> {
  if (unitId == null) return [];
  const steps = await tx.assemblyStep.findMany({
    where: { unitId, jobId: ncr.jobId, role: RULE_ROLE[ncr.ruleCode!], status: { not: "NOT_STARTED" } },
    orderBy: { id: "asc" },
  });
  for (const s of steps) {
    const cleared = {
      status: "NOT_STARTED" as const,
      startedAt: null,
      finishedAt: null,
      reportedStartAt: null,
      reportedFinishAt: null,
      submittedBy: null,
      verifiedBy: null,
    };
    await tx.assemblyStep.update({ where: { id: s.id }, data: cleared });
    await recordAudit(tx, actor, {
      action: "assemblyStep.reopen",
      entityType: "AssemblyStep",
      entityId: s.id,
      before: {
        status: s.status,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        reportedStartAt: s.reportedStartAt,
        reportedFinishAt: s.reportedFinishAt,
        submittedBy: s.submittedBy,
        verifiedBy: s.verifiedBy,
      },
      after: { ...cleared, ncrId: ncr.id, ruleCode: ncr.ruleCode },
      eventType: "AssemblyStepReopened",
      eventPayload: { assemblyStepId: s.id, unitId, ncrId: ncr.id },
    });
    await rollupForAssemblyStep(tx, actor, s.id);
  }
  return steps.map((s) => s.id);
}

/** Decision 1: no QC head role yet, so every QC user is told a concession awaits the QC head's ratification. */
async function flagConcessionForRatification(tx: Tx, actor: Actor, ncr: Ncr): Promise<void> {
  const qcIds = await userIdsWithRole(tx, actor.tenantId, ROLES.QC);
  if (qcIds.length === 0) return;
  await notify(
    tx,
    actor.tenantId,
    qcIds.map((recipientId) => ({
      recipientId,
      type: "NCR_CONCESSION",
      entityType: "Ncr",
      entityId: ncr.id,
      title: `${ncr.ruleCode} NCR accepted per code clause: QC head to ratify`,
      body: `${ncr.codeClause} · accepted by ${actor.name}`,
      payload: { jobId: ncr.jobId, ncrId: ncr.id },
    })),
  );
}

/**
 * L1.2f: QC raises an NCR for an item H5 or H6 refuses right now (welding on a
 * pressure part after the unit's final PWHT / hydro has started). Refused when
 * the rule does not refuse the item, or an NCR under the same rule is already
 * OPEN for it. Takes the unit's floor lock; the Production Head (concession
 * authority) is notified.
 */
export async function raiseRuleNcr(actor: Actor, input: RaiseRuleNcrInput): Promise<Ncr> {
  const { kind, targetId, rule } = raiseRuleNcrSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC);
  const field = kind === "ASSEMBLY_STEP" ? "targetAssemblyStepId" : "targetComponentOperationId";

  const target = await withTenant(actor.tenantId, async (tx) =>
    kind === "ASSEMBLY_STEP"
      ? tx.assemblyStep.findFirst({
          where: { id: targetId, unit: { equipment: { job: { tenantId: actor.tenantId } } } },
          select: { jobId: true, unitId: true },
        })
      : tx.componentOperation
          .findFirst({
            where: { id: targetId, component: { equipment: { job: { tenantId: actor.tenantId } } } },
            select: { jobId: true, component: { select: { unitId: true } } },
          })
          .then((o) => (o ? { jobId: o.jobId, unitId: o.component.unitId } : null)),
  );
  if (!target) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: kind === "ASSEMBLY_STEP" ? "AssemblyStep" : "ComponentOperation", id: targetId });

  return withJob(
    actor.tenantId,
    target.jobId,
    async (tx) => {
      await lockFloorUnits(tx, target.jobId, [target.unitId]);
      const job = await tx.job.findFirstOrThrow({ where: { id: target.jobId, tenantId: actor.tenantId }, select: { id: true, familyId: true, jobNumber: true } });
      const { facts, rows } = await loadFloorFacts(tx, job, target.unitId);
      const row = rows.get(rowKey(kind, targetId));
      // H5/H6 refuse only a Start (NOT_STARTED) or a Done (IN_PROGRESS); a weld submitted or complete is not refused.
      const refusable = row && (row.item.status === "NOT_STARTED" || row.item.status === "IN_PROGRESS");
      const refusal = refusable ? HARD_RULES.find((r) => r.id === rule)!.check(row.item, facts) : null;
      if (refusal?.meta.routeTo !== "NCR") {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          { rule, kind, targetId },
          `${rule} does not refuse this item now, so there is nothing to raise an NCR for.`,
        );
      }
      const open = await tx.ncr.findFirst({ where: { jobId: job.id, [field]: targetId, ruleCode: rule, status: "OPEN" }, select: { id: true } });
      if (open) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { ncrId: open.id }, "An NCR under this rule is already open for this item.");
      }

      return audited(tx, actor, async () => {
        const ncr = await tx.ncr.create({
          data: { jobId: job.id, [field]: targetId, ruleCode: rule, raisedBy: actor.userId, raisedAt: new Date() },
        });
        const heads = await userIdsWithRole(tx, actor.tenantId, ROLES.PRODUCTION_HEAD);
        if (heads.length > 0) {
          await notify(
            tx,
            actor.tenantId,
            heads.map((recipientId) => ({
              recipientId,
              type: "NCR_OPENED",
              entityType: "Ncr",
              entityId: ncr.id,
              title: `${rule} NCR opened: ${rule === "H5" ? "welding after final PWHT" : "welding after hydro"}`,
              body: `raised by ${actor.name} · ${job.jobNumber}`,
              payload: { jobId: job.id, unitId: target.unitId, ncrId: ncr.id },
            })),
          );
        }
        return {
          result: ncr,
          audit: {
            action: "ncr.raiseRule",
            entityType: "Ncr",
            entityId: ncr.id,
            after: { ruleCode: rule, kind, targetId, unitId: target.unitId, status: ncr.status, refusal: refusal.code },
            eventType: "ncr.raised",
            eventPayload: { ncrId: ncr.id, ruleCode: rule, kind, targetId },
          },
        };
      });
    },
    { timeoutMs: 30_000 },
  );
}

/**
 * L1.2f: once every FINAL_PWHT (H5) or HYDRO (H6) step of the unit is COMPLETE
 * again, close the unit's rule NCRs under repair for that rule and roll up
 * their targets' plans (the open NCR held them back). Called in the caller's
 * transaction right after a step is written COMPLETE (verify, inspect,
 * recordWork's QC-free Done). No-op for any other role.
 */
export async function closeRuleNcrsOnRedo(
  tx: Tx,
  actor: Actor,
  step: { unitId: number; jobId: number; role: AssemblyStepRole | null },
): Promise<void> {
  const rule = step.role ? ROLE_RULE[step.role] : undefined;
  if (!rule) return;
  const pending = await tx.assemblyStep.count({
    where: { unitId: step.unitId, jobId: step.jobId, role: step.role!, status: { not: "COMPLETE" } },
  });
  if (pending > 0) return;
  const ncrs = await tx.ncr.findMany({
    where: {
      jobId: step.jobId,
      ruleCode: rule,
      status: "REWORK_IN_PROGRESS",
      OR: [{ targetAssemblyStep: { unitId: step.unitId } }, { targetComponentOperation: { component: { unitId: step.unitId } } }],
    },
    orderBy: { id: "asc" },
  });
  for (const n of ncrs) {
    await closeNcr(tx, actor, { ncrId: n.id, jobId: n.jobId });
    if (n.targetAssemblyStepId != null) await rollupForAssemblyStep(tx, actor, n.targetAssemblyStepId);
    else await rollupForComponentOperation(tx, actor, n.targetComponentOperationId!);
  }
}

/**
 * Closes an NCR. Not user-facing for the REWORK/REPAIR path — called
 * automatically from `verifyComponentOperation`/`verifyAssemblyStep` in the
 * SAME transaction once the reworked operation reaches COMPLETE again, so
 * `closeNcr` here takes an already-tenant-scoped `tx` rather than opening its
 * own (mirrors `recordNdtResultTx`'s bare-tx shape in welding.service.ts).
 * Stamps `reworkFinishedAt` in the same write when rework was in progress —
 * that pairing IS "elapsed rework time" (dashboard aggregation reads both).
 *
 * H1 job-level RLS backstop: takes an explicit `jobId` and filters on it —
 * a real tenant+job filter, not just RLS as a silent backstop for a
 * known-bad query shape. Both callers (verifyComponentOperation,
 * verifyAssemblyStep) already have a job-scoped Ncr row in hand at the call
 * site (from their own `tx.ncr.findMany`) and pass its own `.jobId`.
 */
export async function closeNcr(tx: Tx, actor: Actor, input: { ncrId: number; jobId: number }): Promise<Ncr> {
  const ncr = await tx.ncr.findFirst({ where: { id: input.ncrId, jobId: input.jobId } });
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
