import { withTenant } from "@/lib/db";
import { audited, recordAudit } from "@/lib/audit";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import type { Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { changePasswordSchema, type ChangePasswordInput } from "@/lib/shared/schemas";

/** Failed-attempt window for the cheap same-session rate limit below. */
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

/**
 * First-login password change (personal dashboards v1, Task 1.3).
 *
 * Verify `current` → hash `next` → in one transaction: update
 * `passwordHash`, clear `mustChangePassword`, and BUMP `sessionVersion`.
 * Bumping invalidates every session token issued before this call
 * (`getActor()` compares `SessionPayload.sessionVersion` against the live DB
 * value on every request — see src/lib/authz/index.ts). Immediately after
 * commit we re-issue the CURRENT browser's cookie with the new version, so
 * the caller is not logged out by their own change while every other
 * previously-issued token goes stale.
 *
 * Rate limiting (SPEC §5.3, kept deliberately cheap — no new table, no
 * Redis): count `auth.changePasswordFailed` audit rows for this actor in the
 * last 15 minutes; refuse with RATE_LIMITED at >=5. The failed-attempt audit
 * write is deliberately its OWN transaction, committed before the
 * INVALID_CURRENT_PASSWORD throw — nesting it inside a transaction that then
 * throws would roll the write back along with everything else, silently
 * defeating the counter.
 */
export async function changeOwnPassword(actor: Actor, input: ChangePasswordInput): Promise<void> {
  const { current, next } = changePasswordSchema.parse(input);

  const { user, recentFailures } = await withTenant(actor.tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { id: actor.userId } });
    const recentFailures = await tx.auditLog.count({
      where: {
        actorId: actor.userId,
        action: "auth.changePasswordFailed",
        at: { gte: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) },
      },
    });
    return { user, recentFailures };
  });
  if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "User", userId: actor.userId });

  if (recentFailures >= RATE_LIMIT_MAX_ATTEMPTS) {
    throw new AppError(ERROR_CODES.RATE_LIMITED);
  }

  if (!(await verifyPassword(user.passwordHash, current))) {
    await withTenant(actor.tenantId, (tx) =>
      recordAudit(tx, actor, {
        action: "auth.changePasswordFailed",
        entityType: "User",
        entityId: actor.userId,
      }),
    );
    throw new AppError(ERROR_CODES.INVALID_CURRENT_PASSWORD);
  }

  const passwordHash = await hashPassword(next);

  const newSessionVersion = await withTenant(actor.tenantId, (tx) =>
    audited(tx, actor, async () => {
      const updated = await tx.user.update({
        where: { id: actor.userId },
        data: { passwordHash, mustChangePassword: false, sessionVersion: { increment: 1 } },
      });
      return {
        result: updated.sessionVersion,
        audit: {
          action: "auth.changePassword",
          entityType: "User",
          entityId: actor.userId,
          eventType: "PasswordChanged",
          eventPayload: { userId: actor.userId },
        },
      };
    }),
  );

  await createSession({
    userId: actor.userId,
    tenantId: actor.tenantId,
    clientId: actor.clientId,
    sessionVersion: newSessionVersion,
  });
}
