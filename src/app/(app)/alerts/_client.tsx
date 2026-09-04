"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { markNotificationReadAction, markAllNotificationsReadAction } from "@/app/actions/notifications";
import { fmtWhen, notificationHref } from "@/lib/notifications-ui";
import type { NotificationsView, NotificationRow } from "@/lib/services/notifications.read";

// Humanized labels for every type() currently fired (notifications.service.ts,
// delay.service.ts, component.service.ts, assembly.service.ts) — CLAUDE.md
// hard-bans raw enums in the UI. Falls back to a humanized version of
// whatever string shows up next, rather than a raw SCREAMING_CASE token.
const TYPE_LABEL: Record<string, string> = {
  JOB_CREATED: "New job",
  ITEM_SUBMITTED: "Awaiting verification",
  STAGE_OVERDUE: "Overdue",
  NUDGE: "Nudge",
  HOLD_POINT_AGED: "Hold point aging",
  DIGEST_PUBLISHED: "Daily digest",
  CLIENT_UPDATE_PUBLISHED: "Client update published",
  CLIENT_UPDATE_REJECTED: "Client update rejected",
  DELAY_FILED: "Delay filed",
  NCR_OPENED: "NCR opened",
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function AlertRow({ n }: { n: NotificationRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const href = notificationHref(n);

  const open = () => {
    start(async () => {
      if (!n.readAt) await markNotificationReadAction(n.id);
      if (href) router.push(href);
      router.refresh();
    });
  };

  const body = (
    <>
      <span className="chip c-idle" style={{ marginRight: 8 }}><i />{typeLabel(n.type)}</span>
      <b style={{ fontWeight: n.readAt ? 500 : 700 }}>{n.title}</b>
      {n.body && <span style={{ color: "var(--muted)" }}> · {n.body}</span>}
    </>
  );

  return (
    <div
      className="d-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        borderBottom: "1px solid var(--border)",
        opacity: n.readAt ? 0.6 : 1,
        cursor: href ? "pointer" : "default",
      }}
      onClick={href ? open : undefined}
    >
      <div style={{ flex: 1, minWidth: 0 }}>{body}</div>
      <span className="mono" style={{ color: "var(--muted)", fontSize: 11, flexShrink: 0 }}>{fmtWhen(n.createdAt)}</span>
      {!n.readAt && (
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={(e) => {
            e.stopPropagation();
            start(async () => {
              await markNotificationReadAction(n.id);
              router.refresh();
            });
          }}
        >
          Mark read
        </button>
      )}
    </div>
  );
}

export function AlertsClient({ notifications }: { notifications: NotificationsView }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const markAll = () => {
    start(async () => {
      await markAllNotificationsReadAction();
      router.refresh();
    });
  };

  return (
    <>
      <div className="page-h">
        <h1>Alerts</h1>
        <span className="sub">{notifications.unreadCount} unread</span>
        {notifications.unreadCount > 0 && (
          <button type="button" className="btn" style={{ marginLeft: "auto" }} disabled={pending} onClick={markAll}>
            Mark all read
          </button>
        )}
      </div>

      <div className="card">
        {notifications.recent.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>
            No notifications yet. Delay reasons, NCRs, overdue stages and hold points will show up here.
          </p>
        ) : (
          notifications.recent.map((n) => <AlertRow key={n.id} n={n} />)
        )}
      </div>

      {notifications.recent.length >= 200 && (
        <p className="note" style={{ marginTop: 8 }}>Showing the most recent 200.</p>
      )}
    </>
  );
}
