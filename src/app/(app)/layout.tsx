import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Toaster } from "sonner";
import { AppShell } from "@/components/industrial/app-shell";
import { ThemeRoot } from "@/components/industrial/theme-root";
import { getActor } from "@/lib/authz";
import { loadMyOverdueCount } from "@/lib/services/workspace.read";
import { loadJobs } from "@/lib/services/jobs.read";
import { loadNotifications } from "@/lib/services/notifications.read";
import { toasterTheme } from "@/lib/theme";

/**
 * Route-group layout for the industrial UI. Everything under (app) renders in
 * the dark theme (scoped via `.theme-industrial`) inside the app shell. Legacy
 * warm-paper pages live OUTSIDE this group and keep their own theme until they
 * are reskinned and migrated in (DESIGN_SPEC §9). `/login` also stays outside.
 *
 * Individual pages own their own unauthenticated redirect (each does
 * `if (!actor) redirect("/login")`) — this layout doesn't duplicate that, it
 * only needs the actor's identity + the two cross-cutting shell reads: the
 * sidebar's overdue badge and the bell's notifications. Overdue-stage/aged-hold-point reconciliation
 * (§9.8) used to run here on every page load; it's now an hourly cron
 * (`/api/cron/alerts`, see cron.service.ts) instead, so this layout only
 * reads already-written Notification rows, it doesn't compute them.
 *
 * `mustChangePassword` interstitial (Task 1.3): a user who has not yet set
 * their own password can reach NOTHING under this route group — every page
 * here funnels through this one layout, so the redirect belongs here, not
 * duplicated per-page. `/account/password` lives OUTSIDE this route group
 * (like `/login`), so there is no self-redirect loop.
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const actor = await getActor();
  if (actor?.mustChangePassword) redirect("/account/password");

  let overdueCount = 0;
  let notifications = { unreadCount: 0, recent: [] as Awaited<ReturnType<typeof loadNotifications>>["recent"] };
  let jobs: Awaited<ReturnType<typeof loadJobs>> = [];
  if (actor) {
    [overdueCount, notifications, jobs] = await Promise.all([
      loadMyOverdueCount(actor),
      loadNotifications(actor),
      loadJobs(actor),
    ]);
  }

  const theme = {
    themePreference: actor?.themePreference ?? ("SYSTEM" as const),
    outdoorMode: actor?.outdoorMode ?? false,
  };

  return (
    <ThemeRoot {...theme}>
      <AppShell
        userName={actor?.name ?? "—"}
        userRoles={actor?.roles ?? []}
        overdueCount={overdueCount}
        notifications={notifications}
        jobs={jobs}
      >
        {children}
      </AppShell>
      <Toaster theme={toasterTheme(theme)} position="bottom-right" />
    </ThemeRoot>
  );
}
