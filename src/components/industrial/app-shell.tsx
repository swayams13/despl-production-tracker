"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { StageSpine } from "./stage-spine";
import { DEMO_SPINE } from "./_demo";

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
};

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
      { href: "/workspace", label: "My Workspace", icon: icons.workspace, badge: 8 },
      { href: "/departments", label: "Departments", icon: icons.departments },
      { href: "/qc", label: "QC & Hold Points", icon: icons.qc },
      { href: "/welding", label: "Welding", icon: icons.welding },
    ],
  },
  {
    group: "Records",
    items: [
      { href: "/bom", label: "BOM & Components", icon: icons.bom },
      { href: "/reports", label: "Reports", icon: icons.reports },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [bellOpen, setBellOpen] = useState(false);
  const [jobOpen, setJobOpen] = useState(false);

  const active = NAV.flatMap((g) => g.items).find((i) => pathname.startsWith(i.href));

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <b>DESPL</b>
          <span>Production Tracker</span>
        </div>
        {NAV.map((g) => (
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
                {it.badge ? <span className="badge">{it.badge}</span> : null}
              </Link>
            ))}
          </div>
        ))}
        <div className="user">
          <div className="avatar">SJ</div>
          <div>
            <b style={{ fontWeight: 500 }}>S. Jadhav</b>
            <small>Production Head</small>
          </div>
        </div>
      </aside>

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
            <button className="bell" onClick={() => setBellOpen((v) => !v)} aria-label="Notifications">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.7 21a2 2 0 01-3.4 0" />
              </svg>
              <em>3</em>
              {bellOpen && (
                <div className="drop">
                  <div className="d-row">
                    PO Receipt crossed 7d — Units 2, 3<small>Reason required · 08:00</small>
                  </div>
                  <div className="d-row">
                    Marking · Unit 1 awaiting your verification<small>Submitted by R. Kadam · 08:02</small>
                  </div>
                  <div className="d-row">
                    ITP-320-04 open 6 days — TPI visit not booked<small>Hydro test witness · Unit 2</small>
                  </div>
                </div>
              )}
            </button>
          </div>
        </div>

        <div className="content">{children}</div>
      </div>
    </div>
  );
}
