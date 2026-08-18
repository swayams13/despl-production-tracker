"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { StageSpine } from "./stage-spine";
import { DEMO_SPINE } from "./_demo";
import { useTheme } from "./theme-root";
import { markNotificationReadAction, markAllNotificationsReadAction } from "@/app/actions/notifications";
import { setThemeAction } from "@/app/actions/preferences";
import { logout } from "@/app/actions/auth";
import { nextThemeState, themeLabel } from "@/lib/theme";
import type { NotificationRow } from "@/lib/services/notifications.read";

// Icons inlined from the mockup (lucide-react is pinned at an atypical 1.x here;
// the approved SVGs are the pixel reference anyway).
const icons = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
  jobs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  ),
  workspace: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M9 11l3 3 8-8" />
      <path d="M20 12v6a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9" />
    </svg>
  ),
  departments: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  ),
  qc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z" />
    </svg>
  ),
  welding: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M5 19l7-14 7 14M8 13h8" />
    </svg>
  ),
  bom: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4" />
    </svg>
  ),
  reports: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" />
    </svg>
  ),
  admin: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.14.36.5.6 1 .6H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1.4z" />
    </svg>
  ),
  // Rounder/thicker stroke set for the tablet rail + phone bottom nav (Task 4):
  // pixel-matched to design/DESPL Supervisor Handoff.dc.html's nav symbols, a
  // deliberately different icon style from the desktop sidebar set above.
  navToday: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6.5h16M4 12h16M4 17.5h10" />
    </svg>
  ),
  navBoard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="2.4" />
      <path d="M9 17v-4.2M15 17V8.4" />
    </svg>
  ),
  navAlerts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9.5a6 6 0 0112 0v4.5l2 3H4l2-3z" />
      <path d="M9.8 20.2a2.6 2.6 0 004.4 0" />
    </svg>
  ),
  navProfile: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.8" />
      <path d="M4.5 20.5c1.4-3.8 4.2-5.6 7.5-5.6s6.1 1.8 7.5 5.6" />
    </svg>
  ),
  themeMoon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8.6 8.6 0 019.5 4a8.6 8.6 0 1010.5 10.5z" />
    </svg>
  ),
  themeSun: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
    </svg>
  ),
  /* Outdoor has no glyph of its own in the reference's <symbol> set — the sun
     inside a heavy ring reads as "sun, turned up", which is what it is. */
  themeOutdoor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="6.6" />
      <path d="M12 1.8v2.2M12 20v2.2M1.8 12h2.2M20 12h2.2" />
    </svg>
  ),
};

// The four destinations shared by the tablet icon rail and phone bottom nav
// (Task 4, SPEC-supervisor-ui-v3 §3 SupervisorNav row). Order is exact.
const SHELL_NAV: { href: string; label: string; icon: ReactNode; badge?: "overdue" | "unread" }[] = [
  { href: "/my-day", label: "Today", icon: icons.navToday, badge: "overdue" },
  { href: "/board", label: "Board", icon: icons.navBoard },
  { href: "/alerts", label: "Alerts", icon: icons.navAlerts, badge: "unread" },
  { href: "/profile", label: "Profile", icon: icons.navProfile },
];

/** Resolves a SHELL_NAV item's badge count from the two real counts AppShell receives. */
function shellNavBadgeCount(badge: "overdue" | "unread" | undefined, overdueCount: number, unreadCount: number): number {
  if (badge === "overdue") return overdueCount;
  if (badge === "unread") return unreadCount;
  return 0;
}

const NAV: { group: string; items: { href: string; label: string; icon: ReactNode; badge?: number }[] }[] = [
  {
    group: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: icons.dashboard },
      { href: "/jobs", label: "Jobs", icon: icons.jobs },
    ],
  },
  {
    group: "Execution",
    items: [
      { href: "/workspace", label: "My Workspace", icon: icons.workspace },
      { href: "/departments", label: "Departments", icon: icons.departments },
      { href: "/qc", label: "QC & Hold Points", icon: icons.qc },
      { href: "/welding", label: "Welding", icon: icons.welding },
    ],
  },
  {
    group: "Records",
    items: [{ href: "/reports", label: "Reports", icon: icons.reports }],
  },
];

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  MANAGEMENT: "Management",
  PRODUCTION_HEAD: "Production Head",
  SUPERVISOR: "Supervisor",
  QC: "QC / QA",
  CLIENT_VIEWER: "Client",
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (days <= 0) return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Where a notification's payload sends you when clicked. */
function notificationHref(n: NotificationRow): string | null {
  const p = n.payload as { jobId?: number; unitId?: number; stageNo?: number; date?: string } | null;
  if (n.type === "DIGEST_PUBLISHED") return p?.date ? `/reports?date=${p.date}` : "/reports";
  if (p?.jobId != null && p.stageNo != null) {
    return p.unitId != null
      ? `/jobs/${p.jobId}?openUnit=${p.unitId}&openStage=${p.stageNo}`
      : `/jobs/${p.jobId}`;
  }
  return null;
}

export function AppShell({
  children,
  userName,
  userRole,
  overdueCount,
  notifications,
}: {
  children: ReactNode;
  userName: string;
  userRole: string;
  overdueCount: number;
  notifications: { unreadCount: number; recent: NotificationRow[] };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const initials = userName.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const roleLabel = ROLE_LABEL[userRole] ?? userRole;
  const [bellOpen, setBellOpen] = useState(false);
  const [jobOpen, setJobOpen] = useState(false);

  const nav =
    userRole === "ADMIN" || userRole === "MANAGEMENT"
      ? [...NAV, { group: "Admin", items: [{ href: "/admin", label: "Admin", icon: icons.admin }] }]
      : NAV;
  const active = nav.flatMap((g) => g.items).find((i) => pathname.startsWith(i.href));

  const openNotification = async (n: NotificationRow) => {
    if (!n.readAt) await markNotificationReadAction(n.id);
    setBellOpen(false);
    const href = notificationHref(n);
    if (href) router.push(href);
    router.refresh();
  };

  const markAllRead = async () => {
    await markAllNotificationsReadAction();
    router.refresh();
  };

  // ── Theme control (D27/D28) ───────────────────────────────────────────
  // One control, three positions (desktop topbar, tablet rail, phone topbar),
  // one click = one step: System → Light → Dark → Outdoor → System.
  // "System" has no glyph of its own, so it borrows sun/moon from whatever the
  // OS resolved to — read from ThemeRoot's context, which owns the app's single
  // matchMedia listener, rather than opening a second one for the same fact.
  const { themePreference, outdoorMode, systemLight } = useTheme();
  const themeState = { themePreference, outdoorMode };
  const [themePending, startThemeTransition] = useTransition();

  const themeText = themeLabel(themeState);
  const themeIcon = outdoorMode
    ? icons.themeOutdoor
    : themePreference === "LIGHT" || (themePreference === "SYSTEM" && systemLight)
      ? icons.themeSun
      : icons.themeMoon;

  // Guarded: without the in-flight check a double-click silently advances two
  // steps, since each click reads the state the last server round trip has not
  // written back yet.
  const cycleTheme = () => {
    if (themePending) return;
    startThemeTransition(async () => {
      const r = await setThemeAction(nextThemeState(themeState));
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <b>DESPL</b>
          <span>Production Tracker</span>
        </div>
        {nav.map((g) => (
          <div className="navgrp" key={g.group}>
            <h6>{g.group}</h6>
            {g.items.map((it) => (
              <Link
                key={it.href}
                href={it.href}
                className={`nav-item${pathname.startsWith(it.href) ? " active" : ""}`}
              >
                {it.icon}
                {it.label}
                {it.href === "/workspace" && overdueCount > 0 ? <span className="badge">{overdueCount}</span> : null}
              </Link>
            ))}
          </div>
        ))}
        <div className="user">
          <div className="avatar">{initials}</div>
          <div>
            <b style={{ fontWeight: 500 }}>{userName}</b>
            <small>{roleLabel}</small>
          </div>
          <button
            className="btn"
            style={{ marginLeft: "auto", padding: "4px 8px" }}
            aria-label="Sign out"
            onClick={() => logout()}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Tablet icon rail (640-1023px, SPEC-responsive-app-v2 §3.1) — rendered
          unconditionally alongside the sidebar and bottom nav; a plain CSS
          media query decides which is visible (same pattern as
          <ResponsiveTable />'s .rt-table/.rt-cards, globals.css:509-514), never
          a JS matchMedia toggle. */}
      <nav className="icon-rail" aria-label="Primary">
        <div className="rail-avatar">{initials}</div>
        {SHELL_NAV.map((it) => {
          const isActive = pathname.startsWith(it.href);
          const count = shellNavBadgeCount(it.badge, overdueCount, notifications.unreadCount);
          return (
            <Link key={it.href} href={it.href} className={`rail-item${isActive ? " active" : ""}`}>
              {it.icon}
              <span>{it.label}</span>
              {count > 0 && it.badge === "overdue" && <span className="badge">{count}</span>}
              {count > 0 && it.badge === "unread" && <span className="badge-alert">{count}</span>}
            </Link>
          );
        })}
        <div className="rail-spacer" />
        <button
          type="button"
          className="rail-item rail-theme"
          aria-label={`Theme: ${themeText}. Switch theme`}
          aria-busy={themePending}
          disabled={themePending}
          onClick={cycleTheme}
        >
          {themeIcon}
          <span>{themeText}</span>
        </button>
      </nav>

      {/* Phone bottom nav (<640px) — same unconditional-render + CSS-toggle pattern. */}
      <nav className="bottom-nav" aria-label="Primary">
        {SHELL_NAV.map((it) => {
          const isActive = pathname.startsWith(it.href);
          const count = shellNavBadgeCount(it.badge, overdueCount, notifications.unreadCount);
          return (
            <Link key={it.href} href={it.href} className={`bn-item${isActive ? " active" : ""}`}>
              <span className="bn-icon-wrap">
                {it.icon}
                {count > 0 && it.badge === "unread" && <em className="bn-badge">{count}</em>}
              </span>
              <span>{it.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="main">
        <div className="topbar">
          <span className="crumb">
            {active ? (
              <>
                Overview / <b>{active.label}</b>
              </>
            ) : (
              <b>DESPL</b>
            )}
          </span>

          <div className="jobswitch" onClick={() => setJobOpen((v) => !v)}>
            <span className="mono" style={{ fontSize: 12 }}>
              DESPL-320
            </span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>HP Air Receiver</span>
            <StageSpine variant="mini" segments={DEMO_SPINE} />
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8B919A" strokeWidth={2}>
              <path d="M6 9l6 6 6-6" />
            </svg>
            {jobOpen && (
              <div className="drop" style={{ left: 0, right: "auto", minWidth: 320 }}>
                {[
                  ["DESPL-320", "HP Air Receiver", "9 units · 18.2% · forecast +4d"],
                  ["DE0467", 'Pressure Pipe 8" / Suction 10" / SAV 24"', "3 units · 41.0% · on schedule"],
                  ["DE0463", "SS Tank", "2 units · 63.5% · forecast −2d"],
                ].map(([code, name, sub]) => (
                  <div className="d-row" key={code} onClick={() => toast("Job switching wires up in a later session")}>
                    <span className="mono">{code}</span> · {name}
                    <small>{sub}</small>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="right">
            <button className="kbd" onClick={() => toast("Command palette (⌘K) wires up in a later session")}>
              ⌘K&nbsp;&nbsp;Search
            </button>
            {/* One button, two of the three positions: the phone top bar
                (48×48 touch target, Task 4) and — new here — the desktop
                topbar, sized like .kbd next to it. A literal second element
                would just be two theme buttons in the same bar; CSS decides
                which sizing applies, and the tablet band hides it in favour
                of the rail's copy. */}
            <button
              type="button"
              className="topbar-theme"
              aria-label={`Theme: ${themeText}. Switch theme`}
              aria-busy={themePending}
              disabled={themePending}
              onClick={cycleTheme}
            >
              {themeIcon}
              <span className="tt-label">{themeText}</span>
            </button>
            <button className="bell" onClick={() => setBellOpen((v) => !v)} aria-label="Notifications">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.7 21a2 2 0 01-3.4 0" />
              </svg>
              {notifications.unreadCount > 0 && <em>{notifications.unreadCount}</em>}
              {bellOpen && (
                <div className="drop">
                  {notifications.recent.length === 0 ? (
                    <div className="d-row" style={{ color: "var(--muted)" }}>
                      No notifications yet.
                    </div>
                  ) : (
                    notifications.recent.map((n) => (
                      <div
                        key={n.id}
                        className="d-row"
                        style={{ opacity: n.readAt ? 0.55 : 1, cursor: "pointer" }}
                        onClick={() => openNotification(n)}
                      >
                        {n.title}
                        <small>
                          {n.body ? `${n.body} · ` : ""}
                          {fmtWhen(n.createdAt)}
                        </small>
                      </div>
                    ))
                  )}
                  {notifications.unreadCount > 0 && (
                    <div
                      className="d-row"
                      style={{ color: "var(--accent)", textAlign: "center" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        markAllRead();
                      }}
                    >
                      Mark all as read
                    </div>
                  )}
                </div>
              )}
            </button>
          </div>
        </div>

        <div className="content" key={pathname}>{children}</div>
      </div>
    </div>
  );
}
