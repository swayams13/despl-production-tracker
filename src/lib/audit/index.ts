import type { Tx } from "@/lib/db";
import type { Actor } from "@/lib/authz";

/**
 * Append-only audit trail (CLAUDE.md invariant #5).
 *
 * Two layers of enforcement, deliberately:
 *   1. Structural — mutations go through `audited()`, which writes the audit
 *      row in the SAME transaction as the change. If the audit insert fails,
 *      the whole transaction rolls back and the change never happened.
 *   2. Database — the application role has no UPDATE or DELETE grant on
 *      audit_log or domain_events, so a row cannot be altered afterwards even
 *      by application code with a bug in it.
 *
 * The previous implementation had neither: nothing wrote to audit_log at all,
 * and the REVOKE targeted PUBLIC while the app connected as a superuser.
 */

export interface AuditSpec {
  action: string;
  entityType: string;
  entityId: string | number;
  before?: unknown;
  after?: unknown;
  /** Emitted to domain_events too when set — the stream agents will read. */
  eventType?: string;
  eventPayload?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export async function recordAudit(tx: Tx, actor: Actor, spec: AuditSpec): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: spec.action,
      entityType: spec.entityType,
      entityId: String(spec.entityId),
      before: (spec.before ?? undefined) as never,
      after: (spec.after ?? undefined) as never,
      ip: spec.ip,
      userAgent: spec.userAgent,
    },
  });

  if (spec.eventType) {
    await tx.domainEvent.create({
      data: {
        tenantId: actor.tenantId,
        aggregateType: spec.entityType,
        aggregateId: String(spec.entityId),
        type: spec.eventType,
        payload: (spec.eventPayload ?? {}) as never,
        actorId: actor.userId,
      },
    });
  }
}

/**
 * Run a mutation and its audit row atomically.
 *
 * Services should call this rather than writing to the audit table by hand —
 * it is what makes "every mutation is audited" true by construction instead of
 * by convention. `fn` returns the value plus whatever the audit row needs.
 */
export async function audited<T>(
  tx: Tx,
  actor: Actor,
  fn: () => Promise<{ result: T; audit: AuditSpec }>,
): Promise<T> {
  const { result, audit } = await fn();
  await recordAudit(tx, actor, audit);
  return result;
}
