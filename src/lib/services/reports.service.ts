import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { notify, userIdsWithRole } from "./notifications.service";

/** entity_id has no room for a date string — reuse the Int column as YYYYMMDD. */
function dateEntityId(date: string): number {
  return Number(date.replaceAll("-", ""));
}

/**
 * §4.9 "Send now" — queues in-app notifications to management users (email is
 * Phase 2, per CLAUDE.md's deferred list). Production Head / Admin gated:
 * this is SJ deciding the digest is ready to publish, not a self-serve
 * management action.
 */
export async function publishDigest(actor: Actor, date: string): Promise<number> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const managementIds = await userIdsWithRole(tx, actor.tenantId, "MANAGEMENT");

    return audited(tx, actor, async () => {
      await notify(
        tx,
        actor.tenantId,
        managementIds.map((recipientId) => ({
          recipientId,
          type: "DIGEST_PUBLISHED",
          entityType: "Digest",
          entityId: dateEntityId(date),
          title: `Daily digest published — ${date}`,
          body: `Sent by ${actor.name}`,
          payload: { date },
        })),
      );
      return {
        result: managementIds.length,
        audit: {
          action: "reports.publishDigest",
          entityType: "Digest",
          entityId: dateEntityId(date),
          after: { date, recipientCount: managementIds.length },
          eventType: "DigestPublished",
          eventPayload: { date, recipientCount: managementIds.length },
        },
      };
    });
  });
}
