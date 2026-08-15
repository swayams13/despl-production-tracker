import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";

export interface NotificationRow {
  id: number;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: number | null;
  payload: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsView {
  unreadCount: number;
  recent: NotificationRow[];
}

/** Bell dropdown + sidebar unread badge — the actor's own notifications only. */
export async function loadNotifications(actor: Actor, limit = 20): Promise<NotificationsView> {
  return withTenant(actor.tenantId, async (tx) => {
    const [unreadCount, rows] = await Promise.all([
      tx.notification.count({ where: { recipientId: actor.userId, readAt: null } }),
      tx.notification.findMany({
        where: { recipientId: actor.userId },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
    ]);
    return {
      unreadCount,
      recent: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        entityType: n.entityType,
        entityId: n.entityId,
        payload: (n.payload as Record<string, unknown> | null) ?? null,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  });
}
