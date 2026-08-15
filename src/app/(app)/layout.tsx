import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { AppShell } from "@/components/industrial/app-shell";
import { getActor } from "@/lib/authz";
import { loadMyOverdueCount } from "@/lib/services/workspace.read";
import { loadNotifications } from "@/lib/services/notifications.read";
import { syncNotifications } from "@/lib/services/notifications.service";

/**
 * Route-group layout for the industrial UI. Everything under (app) renders in
 * the dark theme (scoped via `.theme-industrial`) inside the app shell. Legacy
 * warm-paper pages live OUTSIDE this group and keep their own theme until they
 * are reskinned and migrated in (DESIGN_SPEC §9). `/login` also stays outside.
 *
 * Individual pages own their own unauthenticated redirect (each does
 * `if (!actor) redirect("/login")`) — this layout doesn't duplicate that, it
 * only needs the actor's identity + the two cross-cutting shell reads: the
 * sidebar's overdue badge and the bell's notifications. `syncNotifications`
 * (§9.8) is the lazy reconciliation for the two notification triggers with no
 * natural mutation moment (stage crossed due date, hold point aged) — run
 * best-effort on every authenticated page load rather than a cron.
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const actor = await getActor();

  let overdueCount = 0;
  let notifications = { unreadCount: 0, recent: [] as Awaited<ReturnType<typeof loadNotifications>>["recent"] };
  if (actor) {
    await syncNotifications(actor).catch((e) => console.error("[notifications] sync failed", e));
    [overdueCount, notifications] = await Promise.all([loadMyOverdueCount(actor), loadNotifications(actor)]);
  }

  return (
    <div className="theme-industrial">
      <AppShell
        userName={actor?.name ?? "—"}
        userRole={actor?.roles[0] ?? ""}
        overdueCount={overdueCount}
        notifications={notifications}
      >
        {children}
      </AppShell>
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}
