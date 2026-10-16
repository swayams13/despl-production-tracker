/**
 * Lean Core L2.1: the one navigation registry. Sidebar, tablet rail and phone
 * bottom bar all render `navFor(roles)`; landing is `landingFor(roles)`.
 * Pure (no React, no DB) so it is table-testable. Icons are keys, resolved by
 * the shell.
 *
 * Every `href` must resolve to a real page today (no dead controls, guarded by
 * nav.test.ts). Items whose screen has not shipped point at the interim route
 * and carry a `// L2.x` marker; Scan, Flags and Digest are absent until their
 * routes exist (build prompt §8.2 item 21).
 */
import type { RoleCode } from "@/lib/authz";

export type NavIcon =
  | "dashboard" | "jobs" | "workspace" | "departments" | "qc" | "welding"
  | "reports" | "admin" | "navToday" | "navAlerts" | "newJob" | "scan";

export interface NavItem {
  id: string;
  href: string;
  label: string;
  icon: NavIcon;
  roles: readonly RoleCode[];
  /** `primary` renders everywhere (rail, phone bar); `more` in the sidebar only. */
  group: "primary" | "more";
  badge?: "overdue" | "unread" | "team" | "qc";
  /** Hidden until the named switch is on (a route that 404s while it is off is a dead control). */
  needs?: "leanFloor";
  /** The href while a switch is on (Today: /my-day until leanFloor, then /today). */
  hrefWhen?: { leanFloor: string };
}

export interface NavSwitches {
  leanFloor?: boolean;
}

const FLOOR_AND_OFFICE: readonly RoleCode[] = [
  "ADMIN", "MANAGEMENT", "PRODUCTION_HEAD", "SUPERVISOR", "QC", "PLANNER",
];

// Order is the display order; the first entry for an href wins on de-dup, so
// a role's primary label beats the "more" one (e.g. QC "Queue" over "QC & hold points").
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "today", href: "/my-day", hrefWhen: { leanFloor: "/today" }, label: "Today", icon: "navToday", roles: ["OPERATOR", "SUPERVISOR"], group: "primary", badge: "overdue" },
  { id: "team", href: "/workspace", hrefWhen: { leanFloor: "/team" }, label: "Team", icon: "workspace", roles: ["SUPERVISOR", "PRODUCTION_HEAD"], group: "primary", badge: "team" },
  { id: "qc-queue", href: "/qc", label: "Queue", icon: "qc", roles: ["QC"], group: "primary", badge: "qc" },
  { id: "scan", href: "/scan", label: "Scan", icon: "scan", roles: ["OPERATOR", "SUPERVISOR", "QC"], group: "primary", needs: "leanFloor" },
  { id: "portfolio", href: "/dashboard", label: "Portfolio", icon: "dashboard", roles: ["PRODUCTION_HEAD", "MANAGEMENT", "ADMIN"], group: "primary" },
  { id: "jobs", href: "/jobs", label: "Jobs", icon: "jobs", roles: ["SUPERVISOR", "QC", "PLANNER", "PRODUCTION_HEAD", "MANAGEMENT", "ADMIN", "ENGINEERING", "STORES"], group: "primary" },
  { id: "new-job", href: "/jobs/new", label: "New job", icon: "newJob", roles: ["PLANNER"], group: "primary" },
  { id: "alerts", href: "/alerts", label: "Alerts", icon: "navAlerts", roles: ["OPERATOR"], group: "primary", badge: "unread" },
  { id: "admin-users", href: "/admin", label: "Users & departments", icon: "admin", roles: ["ADMIN", "MANAGEMENT"], group: "primary" },
  { id: "admin-templates", href: "/admin/templates", label: "Templates", icon: "admin", roles: ["ADMIN", "PRODUCTION_HEAD"], group: "primary" },

  // More: pages that exist but are not in a role's spec list. Sidebar only.
  { id: "qc-holds", href: "/qc", label: "QC & hold points", icon: "qc", roles: ["SUPERVISOR", "PRODUCTION_HEAD", "MANAGEMENT", "ADMIN", "PLANNER"], group: "more" },
  { id: "departments", href: "/departments", label: "Departments", icon: "departments", roles: FLOOR_AND_OFFICE, group: "more" },
  { id: "welding", href: "/welding", label: "Welding", icon: "welding", roles: FLOOR_AND_OFFICE, group: "more" },
  { id: "reports", href: "/reports", label: "Reports", icon: "reports", roles: FLOOR_AND_OFFICE, group: "more" },
  { id: "families", href: "/admin/families", label: "Product families", icon: "admin", roles: ["ADMIN", "PRODUCTION_HEAD"], group: "more" },
  { id: "equipment-types", href: "/admin/equipment-types", label: "Equipment types", icon: "admin", roles: ["ADMIN", "PRODUCTION_HEAD"], group: "more" },
  { id: "component-routes", href: "/admin/routes", label: "Component routes", icon: "admin", roles: ["ADMIN", "PRODUCTION_HEAD"], group: "more" },
  { id: "qcp-templates", href: "/admin/qcp-templates", label: "QCP templates", icon: "admin", roles: ["ADMIN", "PRODUCTION_HEAD"], group: "more" },
  { id: "master-data", href: "/admin/master-data", label: "Master data", icon: "admin", roles: ["ADMIN", "PRODUCTION_HEAD", "ENGINEERING", "PLANNER"], group: "more" },
];

/**
 * First match wins, so the order is the precedence (management tier, then
 * supervisor over QC: today's order). The third column is the landing while
 * leanFloor is on.
 */
const LANDING: readonly (readonly [RoleCode, string, string?])[] = [
  ["MANAGEMENT", "/dashboard"],
  ["PRODUCTION_HEAD", "/dashboard", "/team"],
  ["ADMIN", "/dashboard"],
  ["PLANNER", "/jobs"],
  ["SUPERVISOR", "/my-day", "/today"],
  ["QC", "/qc"],
  ["OPERATOR", "/my-day", "/today"],
  ["ENGINEERING", "/jobs"],
  ["STORES", "/jobs"],
];

/** A shape none of the roles cover still gets a real page, as before. */
const LANDING_FALLBACK = "/workspace";

export function landingFor(roles: readonly string[], on: NavSwitches = {}): string {
  const hit = LANDING.find(([r]) => roles.includes(r));
  if (!hit) return LANDING_FALLBACK;
  return (on.leanFloor && hit[2]) || hit[1];
}

export interface NavSet {
  primary: NavItem[];
  more: NavItem[];
}

/** Union across the user's roles, registry order, one entry per href. */
export function navFor(roles: readonly string[], on: NavSwitches = {}): NavSet {
  const seen = new Set<string>();
  const out: NavSet = { primary: [], more: [] };
  for (const raw of NAV_ITEMS) {
    if (!raw.roles.some((r) => roles.includes(r))) continue;
    if (raw.needs && !on[raw.needs]) continue;
    const item = on.leanFloor && raw.hrefWhen ? { ...raw, href: raw.hrefWhen.leanFloor } : raw;
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    out[item.group].push(item);
  }
  return out;
}

/** The item whose href is the longest segment-boundary prefix of `pathname`. */
export function activeItem(items: readonly NavItem[], pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const it of items) {
    const hit = pathname === it.href || pathname.startsWith(`${it.href}/`);
    if (hit && (!best || it.href.length > best.href.length)) best = it;
  }
  return best;
}

export interface SidebarJobInput {
  id: number;
  jobNumber: string;
  status: string;
  forecastVarianceDays: number | null;
  overduePlans: number;
}

/** Active jobs, worst first (latest forecast, then most overdue), capped. */
export function sidebarJobs<T extends SidebarJobInput>(jobs: readonly T[], cap = 5): T[] {
  return jobs
    .filter((j) => j.status === "ACTIVE")
    .sort(
      (a, b) =>
        (b.forecastVarianceDays ?? -Infinity) - (a.forecastVarianceDays ?? -Infinity) ||
        b.overduePlans - a.overduePlans,
    )
    .slice(0, cap);
}
