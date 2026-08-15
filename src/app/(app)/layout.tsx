import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { AppShell } from "@/components/industrial/app-shell";
import { getActor } from "@/lib/authz";

/**
 * Route-group layout for the industrial UI. Everything under (app) renders in
 * the dark theme (scoped via `.theme-industrial`) inside the app shell. Legacy
 * warm-paper pages live OUTSIDE this group and keep their own theme until they
 * are reskinned and migrated in (DESIGN_SPEC §9). `/login` also stays outside.
 *
 * Individual pages own their own unauthenticated redirect (each does
 * `if (!actor) redirect("/login")`) — this layout doesn't duplicate that, it
 * only needs the actor's name/role for the sidebar identity, hard-coded as
 * "S. Jadhav / Production Head" since §9.1 (found live while verifying §9.6:
 * every screenshot showed the wrong name under a QC-role login).
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const actor = await getActor();
  return (
    <div className="theme-industrial">
      <AppShell userName={actor?.name ?? "—"} userRole={actor?.roles[0] ?? ""}>
        {children}
      </AppShell>
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}
