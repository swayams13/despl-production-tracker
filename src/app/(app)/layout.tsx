import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { AppShell } from "@/components/industrial/app-shell";

/**
 * Route-group layout for the industrial UI. Everything under (app) renders in
 * the dark theme (scoped via `.theme-industrial`) inside the app shell. Legacy
 * warm-paper pages live OUTSIDE this group and keep their own theme until they
 * are reskinned and migrated in (DESIGN_SPEC §9). `/login` also stays outside.
 */
export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return (
    <div className="theme-industrial">
      <AppShell>{children}</AppShell>
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}
