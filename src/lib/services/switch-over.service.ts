import { randomUUID } from "node:crypto";
import { withTenant } from "@/lib/db";
import { assertNotClientUser, requireRole, type Actor } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { AppError, ERROR_CODES, isAppError, type ErrorCode } from "@/lib/shared/errors";
import type { WorkKind } from "@/lib/shared/floor-rules";
import { recordWork } from "./work.service";
import { ensureJointForStep } from "./floor.service";
import { loadSwitchOver, SWITCH_OVER_ROLES, type SwitchRow } from "./switch-over.read";

/**
 * Lean Core L2.10 part B (D22): the planner / Production Head ticks what Excel
 * already shows as done, at the switch-over date. Nothing here writes a status:
 * every item goes through `recordWork` DONE with `reportedAt` = the switch-over
 * date, so every rule still applies (the 72-working-hour window, D2 HARD rules,
 * maker-checker: an item that needs QC lands in SUBMITTED and QC verifies it).
 * What recordWork refuses comes back with its reason; nothing is forced.
 *
 * Not atomic across the batch: each chunk (one unit, at most 100 items, in the
 * order the rules need) is one recordWork transaction. A refused item changes
 * nothing; a chunk-level failure is reported against every item in the chunk.
 */

export const SWITCH_OVER_CHUNK = 100;

export interface SwitchOverInput {
  jobId: number;
  /** ISO instant with offset: when the work was done (the switch-over date). */
  doneAt: string;
  /** Filed once per late plan, as recordWork's lateReason. Optional; LATE_REASON_REQUIRED comes back per item without it. */
  lateCategoryId?: number;
  items: Array<{ kind: WorkKind; id: number }>;
  /** A weld step's welder, by `${kind}:${id}`. Needed for a weld step whose joint is not logged yet; the joint is logged for it. */
  welders?: Record<string, number>;
}

export interface SwitchOverRefusal {
  kind: WorkKind;
  id: number;
  title: string;
  unit: string;
  code: ErrorCode;
  message: string;
  /** The part, for a pressure-part cutting item refused for material or heat number (the screen offers the fix). */
  componentId: number | null;
}

export interface SwitchOverResult {
  /** Items now COMPLETE. */
  completed: number;
  /** Items now SUBMITTED: they need QC (maker-checker). */
  toQc: number;
  /** Ticked but already done or with QC: nothing to do. */
  skipped: number;
  refused: SwitchOverRefusal[];
  chunks: number;
}

export async function applySwitchOver(actor: Actor, input: SwitchOverInput): Promise<SwitchOverResult> {
  assertNotClientUser(actor);
  requireRole(actor, ...SWITCH_OVER_ROLES);
  if (!input.items.length) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Tick at least one item." });
  if (Number.isNaN(Date.parse(input.doneAt))) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Pick the switch-over date and time." });

  const view = await loadSwitchOver(actor, input.jobId);
  const known = new Map<string, { row: SwitchRow; unit: string; unitOrder: number }>();
  view.units.forEach((u, unitOrder) => u.rows.forEach((row) => known.set(row.key, { row, unit: u.label, unitOrder })));

  const picked = new Map<string, { row: SwitchRow; unit: string; unitOrder: number }>();
  for (const it of input.items) {
    const hit = known.get(`${it.kind}:${it.id}`);
    if (!hit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: it.kind, id: it.id, reason: "One of the ticked items is not part of this job." });
    picked.set(hit.row.key, hit);
  }

  const open = [...picked.values()].filter((p) => p.row.status === "NOT_STARTED" || p.row.status === "IN_PROGRESS");
  const result: SwitchOverResult = { completed: 0, toQc: 0, skipped: picked.size - open.length, refused: [], chunks: 0 };

  // Unit by unit, each unit in the order recordWork needs; at most SWITCH_OVER_CHUNK per call.
  open.sort((a, b) => a.unitOrder - b.unitOrder || a.row.order - b.row.order);
  const chunks: Array<typeof open> = [];
  for (const p of open) {
    const last = chunks[chunks.length - 1];
    if (last && last[0].unitOrder === p.unitOrder && last.length < SWITCH_OVER_CHUNK) last.push(p);
    else chunks.push([p]);
  }

  const refuse = (p: (typeof open)[number], code: ErrorCode, message: string) =>
    result.refused.push({ kind: p.row.kind, id: p.row.id, title: p.row.title, unit: p.unit, code, message, componentId: p.row.componentId });

  for (const chunk of chunks) {
    result.chunks++;
    try {
      // A weld step carries its joint and welder; the joint is logged first, the same way the Floor does it.
      const sendable: Array<{ p: (typeof open)[number]; detail?: { weldJointId: number; performedByWelderId?: number } }> = [];
      for (const p of chunk) {
        const weld = p.row.weld;
        if (!weld) {
          sendable.push({ p });
          continue;
        }
        const welderId = input.welders?.[p.row.key];
        if (weld.existingJointId == null && welderId == null) {
          refuse(p, ERROR_CODES.VALIDATION_FAILED, `Pick the welder who did joint ${weld.jointRef}.`);
          continue;
        }
        try {
          const joint =
            weld.existingJointId != null
              ? { weldJointId: weld.existingJointId }
              : await ensureJointForStep(actor, { assemblyStepId: p.row.id, welderIds: [welderId!] });
          sendable.push({ p, detail: { weldJointId: joint.weldJointId, ...(welderId != null ? { performedByWelderId: welderId } : {}) } });
        } catch (e) {
          if (!isAppError(e)) throw e;
          refuse(p, e.code, typeof e.detail?.reason === "string" ? e.detail.reason : e.message);
        }
      }
      if (!sendable.length) continue;
      const r = await recordWork(actor, {
        requestId: randomUUID(),
        jobId: input.jobId,
        action: "DONE",
        reportedAt: input.doneAt,
        items: sendable.map(({ p, detail }) => ({ kind: p.row.kind, id: p.row.id, ...(detail ? { detail } : {}) })),
        ...(input.lateCategoryId != null ? { lateReason: { categoryId: input.lateCategoryId, note: "Switch-over from Excel" } } : {}),
      });
      const byKey = new Map(chunk.map((p) => [p.row.key, p]));
      for (const a of r.applied) {
        if (a.to === "SUBMITTED") result.toQc++;
        else result.completed++;
      }
      for (const x of r.refused) {
        const p = byKey.get(`${x.kind}:${x.id}`);
        if (p) refuse(p, x.code, x.message);
      }
    } catch (e) {
      if (!isAppError(e)) throw e;
      for (const p of chunk) refuse(p, e.code, e.message);
    }
  }

  await withTenant(actor.tenantId, (tx) =>
    recordAudit(tx, actor, {
      action: "switchOver.apply",
      entityType: "Job",
      entityId: input.jobId,
      after: { doneAt: input.doneAt, ticked: picked.size, completed: result.completed, toQc: result.toQc, skipped: result.skipped, refused: result.refused.length, chunks: result.chunks },
      eventType: "SwitchOverApplied",
      eventPayload: { jobId: input.jobId, completed: result.completed, toQc: result.toQc, refused: result.refused.length },
    }),
  );
  return result;
}
