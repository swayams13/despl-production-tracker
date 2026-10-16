"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { StageSpine } from "./stage-spine";
import { useTheme } from "./theme-root";
import { markNotificationReadAction, markAllNotificationsReadAction } from "@/app/actions/notifications";
import { setThemeAction } from "@/app/actions/preferences";
import { logout } from "@/app/actions/auth";
import { nextThemeState, themeLabel } from "@/lib/theme";
import type { NotificationRow } from "@/lib/services/notifications.read";
import { fmtWhen, notificationHref } from "@/lib/notifications-ui";
import type { JobListItem } from "@/lib/services/jobs.read";
import { activeItem, navFor, sidebarJobs, type NavIcon, type NavItem } from "@/lib/shared/nav";

// Icons inlined from the mockup (lucide-react is pinned at an atypical 1.x here;
// the approved SVGs are the pixel reference anyway).
const icons: Record<NavIcon | "themeMoon" | "themeSun", ReactNode> = {
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
  reports: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M8 3v3M16 3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" />
    </svg>
  ),
  scan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16" />
    </svg>
  ),
  newJob: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M12 5v14M5 12h14" />
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
  navAlerts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9.5a6 6 0 0112 0v4.5l2 3H4l2-3z" />
      <path d="M9.8 20.2a2.6 2.6 0 004.4 0" />
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
};

/** Count shown on a nav item, from the two real counts AppShell receives. */
function badgeCount(badge: NavItem["badge"], overdueCount: number, unreadCount: number, teamOverdue: number): number {
  if (badge === "overdue") return overdueCount;
  if (badge === "team") return teamOverdue;
  if (badge === "unread") return unreadCount;
  return 0;
}

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  MANAGEMENT: "Management",
  PRODUCTION_HEAD: "Production Head",
  SUPERVISOR: "Supervisor",
  QC: "QC / QA",
  CLIENT_VIEWER: "Client",
  OPERATOR: "Operator",
  PLANNER: "Planner",
  STORES: "Stores",
  ENGINEERING: "Engineering",
};

export function AppShell({
  children,
  userName,
  userRoles,
  overdueCount,
  teamOverdueCount,
  notifications,
  jobs,
  leanFloor,
}: {
  children: ReactNode;
  userName: string;
  userRoles: string[];
  overdueCount: number;
  /** Department overdue count: Team's badge. */
  teamOverdueCount: number;
  notifications: { unreadCount: number; recent: NotificationRow[] };
  jobs: JobListItem[];
  /** FEATURES.leanFloor, read on the server: Scan and its target exist only while it is on. */
  leanFloor: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const initials = userName.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const roleLabel = userRoles.map((r) => ROLE_LABEL[r] ?? r).join(" / ") || "—";
  const [bellOpen, setBellOpen] = useState(false);
  const [jobOpen, setJobOpen] = useState(false);
  const [personOpen, setPersonOpen] = useState<"foot" | "top" | null>(null);

  const { primary, more } = navFor(userRoles, { leanFloor });
  const active = activeItem([...primary, ...more], pathname);
  const sidebarJobList = primary.some((i) => i.href === "/jobs") ? sidebarJobs(jobs) : [];

  // Job switcher (12C): shown only inside a job (/jobs/:id). Switching goes to
  // the job's page: there are no job tabs before L2.8 (sub-routes are
  // job-specific), so "keep the current tab" has nothing to keep yet.
  const jobIdMatch = pathname.match(/^\/jobs\/(\d+)(?:\/.*)?$/);
  const currentJob = jobIdMatch ? jobs.find((j) => j.id === Number(jobIdMatch[1])) : undefined;

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
  // one click = one step: Automatic → Floor → Control room → Automatic.
  // "Automatic" has no glyph of its own, so it borrows sun/moon from whatever
  // the pointer type resolved to — read from ThemeRoot's context, which owns
  // the app's single matchMedia listener, rather than opening a second one.
  const { themePreference, outdoorMode, autoFloor } = useTheme();
  const themeState = { themePreference, outdoorMode };
  const [themePending, startThemeTransition] = useTransition();

  const themeText = themeLabel(themeState);
  const themeIcon =
    outdoorMode || themePreference === "LIGHT" || (themePreference === "SYSTEM" && autoFloor)
      ? icons.themeSun
      : icons.themeMoon;

  // Guarded: without the in-flight check a double-click silently advances two
  // steps, since each click reads the state the last server round trip has not
  // written back yet. This guard — not `disabled` on the buttons — is the real
  // re-entrancy protection; the buttons only advertise the state with
  // aria-disabled, because a real `disabled` drops them out of the keyboard
  // tab order mid-click and moves focus off the control the user is using.
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

  // Person-block menu (12B): role, theme and sign out. One element, rendered
  // in the sidebar foot (desktop) and the topbar (tablet, phone) — CSS shows
  // whichever the breakpoint wants. The menu stays open while the theme cycles.
  const personMenu = (placement: "foot" | "top") => (
    <div className={`person person-${placement}`}>
      <button
        type="button"
        className="person-btn"
        aria-haspopup="menu"
        aria-expanded={personOpen === placement}
        aria-label={`Account menu, ${userName}`}
        onClick={() => setPersonOpen((v) => (v === placement ? null : placement))}
      >
        <span className="avatar">{initials}</span>
        <span className="person-id">
          <b>{userName}</b>
          <small>{roleLabel}</small>
        </span>
      </button>
      {personOpen === placement && (
        <div className="drop person-drop" role="menu">
          <div className="d-row person-who">
            {userName}
            <small>{roleLabel}</small>
          </div>
          <button
            type="button"
            role="menuitem"
            className="d-row person-item person-theme"
            aria-label={`Theme: ${themeText}. Switch theme`}
            aria-busy={themePending}
            aria-disabled={themePending}
            onClick={cycleTheme}
          >
            {themeIcon}
            <span>Theme: {themeText}</span>
          </button>
          <button type="button" role="menuitem" className="d-row person-item" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <b>DESPL</b>
          <span>Production Tracker</span>
        </div>
        <div className="navgrp">
          {primary.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              className={`nav-item${active?.href === it.href ? " active" : ""}`}
            >
              {icons[it.icon]}
              {it.label}
              {badgeCount(it.badge, overdueCount, notifications.unreadCount, teamOverdueCount) > 0 ? (
                <span className="badge">{badgeCount(it.badge, overdueCount, notifications.unreadCount, teamOverdueCount)}</span>
              ) : null}
            </Link>
          ))}
        </div>
        {sidebarJobList.length > 0 && (
          <div className="navgrp">
            <h6>Active jobs</h6>
            {sidebarJobList.map((j) => (
              <Link
                key={j.id}
                href={`/jobs/${j.id}`}
                className={`nav-item nav-job${currentJob?.id === j.id ? " active" : ""}`}
              >
                <span className="mono">{j.jobNumber}</span>
                {j.forecastVarianceDays != null && j.forecastVarianceDays > 0 ? (
                  <span className="badge">+{j.forecastVarianceDays}d</span>
                ) : null}
              </Link>
            ))}
            <Link href="/jobs" className="nav-item nav-all-jobs">
              All jobs
            </Link>
          </div>
        )}
        {more.length > 0 && (
          <div className="navgrp">
            <h6>More</h6>
            {more.map((it) => (
              <Link
                key={it.href}
                href={it.href}
                className={`nav-item${active?.href === it.href ? " active" : ""}`}
              >
                {icons[it.icon]}
                {it.label}
              </Link>
            ))}
          </div>
        )}
        <div className="user">{personMenu("foot")}</div>
      </aside>

      {/* Tablet icon rail (640-1023px, SPEC-responsive-app-v2 §3.1) — rendered
          unconditionally alongside the sidebar and bottom nav; a plain CSS
          media query decides which is visible (same pattern as
          <ResponsiveTable />'s .rt-table/.rt-cards, globals.css:509-514), never
          a JS matchMedia toggle. */}
      <nav className="icon-rail" aria-label="Primary">
        <div className="rail-avatar">{initials}</div>
        {primary.map((it) => {
          const count = badgeCount(it.badge, overdueCount, notifications.unreadCount, teamOverdueCount);
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`rail-item${active?.href === it.href ? " active" : ""}`}
            >
              {icons[it.icon]}
              <span>{it.label}</span>
              {count > 0 && (it.badge === "overdue" || it.badge === "team") && <span className="badge">{count}</span>}
              {count > 0 && it.badge === "unread" && <span className="badge-alert">{count}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Phone bottom nav (<640px) — same unconditional-render + CSS-toggle pattern. */}
      {/* A multi-role union can exceed what a phone bar holds: first five in registry order. */}
      <nav className="bottom-nav" aria-label="Primary">
        {primary.slice(0, 5).map((it) => {
          const count = badgeCount(it.badge, overdueCount, notifications.unreadCount, teamOverdueCount);
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`bn-item${active?.href === it.href ? " active" : ""}`}
            >
              <span className="bn-icon-wrap">
                {icons[it.icon]}
                {count > 0 && <em className="bn-badge">{count}</em>}
              </span>
              <span>{it.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="main">
        <div className="topbar">
          <span className="crumb">
            {currentJob ? (
              <>
                <Link href="/jobs">Jobs</Link> / <b>{currentJob.jobNumber}</b>
              </>
            ) : (
              <b>{active?.label ?? "DESPL"}</b>
            )}
          </span>

          {currentJob && (
          <div className="jobswitch" onClick={() => setJobOpen((v) => !v)}>
            <span className="mono" style={{ fontSize: "var(--fs-sm, 12px)" }}>
              {currentJob.jobNumber}
            </span>
            <span style={{ color: "var(--muted)", fontSize: "var(--fs-sm, 12px)" }}>
              {currentJob.projectName ?? currentJob.familyName}
            </span>
            <StageSpine variant="mini" segments={currentJob.unitRollup} />
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8B919A" strokeWidth={2}>
              <path d="M6 9l6 6 6-6" />
            </svg>
            {jobOpen && (
              <div className="drop" style={{ left: 0, right: "auto", minWidth: 320 }}>
                {jobs.map((j) => (
                    <div
                      className="d-row"
                      key={j.id}
                      onClick={() => {
                        setJobOpen(false);
                        router.push(`/jobs/${j.id}`);
                      }}
                    >
                      <span className="mono">{j.jobNumber}</span> · {j.projectName ?? j.familyName}
                      <small>
                        {j.unitCount} units · {j.percentComplete.toFixed(1)}% ·{" "}
                        {j.forecastVarianceDays == null
                          ? "no schedule"
                          : j.forecastVarianceDays === 0
                            ? "on schedule"
                            : `forecast ${j.forecastVarianceDays > 0 ? "+" : "−"}${Math.abs(j.forecastVarianceDays)}d`}
                      </small>
                    </div>
                ))}
              </div>
            )}
          </div>
          )}

          <div className="right">
            {/* ⌘K (12D) lands after L2.2 (it needs /u/[publicId] and a unit/person
                search read); until then no control renders here rather than one
                that does nothing (CLAUDE.md "no dead controls"). */}
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
            {personMenu("top")}
          </div>
        </div>

        <div className="content" key={pathname}>{children}</div>
      </div>
    </div>
  );
}
