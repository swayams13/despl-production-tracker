# UX Final Review — DESPL Tracker Phase 4
Brief §3, §8–§11, §13–§20. Follows the brief's structure section by section.

## §3 Information density — audit outcome
No screen in Rounds 1–3 was found to need further cutting; DESIGN_DECISIONS.md's "Intentionally removed" section already applied this test (cycle-time/throughput/S-curve analytics deferred to Round 3's own screens, Control Centre has no activity table, welder scoreboard trimmed to repair-rate only). This pass re-confirms those calls stand and adds the §4 table-tier rule (COMPONENT_INVENTORY.md) as the mechanism going forward, so density is solved by hierarchy, not by future font-shrinking.

## §8 Empty states
| Screen | Condition | Copy |
|---|---|---|
| My Day | No activities assigned today | "No activities are assigned to you today." |
| My Day — overdue queue | Nothing overdue | "You're all caught up." |
| QC queue | Nothing awaiting inspection | "No inspections currently require your attention." |
| Supervisor Team | No overdue/blocked work on the team | "Your team has no overdue or blocked work." |
| Reports | No reports match the current filter | "No reports match these filters. Try widening the date range." |
| Bottleneck Analysis | No department currently overdue | "No department is currently creating delay." |
| Assignment candidate list | No eligible candidate in the department | "No one in [Department] is available to take this. Reassign to another department instead." |

Shape: icon-free (this system doesn't use illustration), centered text in `text-muted`, 13px, inside the same panel the table/list would have occupied — never a blank panel with no explanation, never a shrunken panel that jumps the layout.

## §9 Loading states
Rule: never a full-screen spinner. Per screen:
- **Dashboard / Portfolio / Department Analytics:** MetricCard and table skeletons (gray blocks matching the exact card/row geometry) render immediately; each panel resolves independently as its data arrives — a slow chart doesn't block the KPI strip above it.
- **My Day / Team:** the queue list skeleton shows 3 placeholder rows (matches `hint-placeholder-count` used throughout the mockups); the page chrome (header, nav) never re-renders.
- **Activity Detail:** primary panel skeleton + right rail skeleton independently, since detail and history come from different reads.
- **QC:** each queue card skeletons independently — one slow queue (e.g. Overdue) shouldn't delay Awaiting Verification from appearing.
- **Reports:** the report list appears immediately (it's static config); only the row counts/last-run timestamps skeleton.
Local, per-panel loading only — this is a direct extension of Round 1–3's `sc-for`/`hint-placeholder-count` pattern already in the templates, not a new mechanism.

## §10 Error states
| Context | Message | Action |
|---|---|---|
| Dashboard/analytics fails to load | "Unable to load dashboard." | `[Retry]` — retries just that panel, not the whole page |
| Activity update fails | "Your changes were not saved." | `[Retry]`; the form keeps the user's input, never clears it |
| Network loss mid-session | "Connection lost. We'll retry automatically." then, if it persists: "Still offline — retry when you're back online." | Auto-retry with backoff; manual `[Retry]` after ~30s |
| Assignment/QC action fails | Inline error at the point of action (not a redirect to a generic error page) | `[Retry]`, form state preserved |

No silent failures (§10) — every failed mutation surfaces via inline error state or Toast (below), paired with the failed state visually held on-screen so the user can retry without re-entering data.

## §11 Mutation feedback
New Toast component (see DESIGN_SYSTEM.md) fires on every state-changing action:
- "Activity completed." / "Assignment updated." / "QC inspection approved." / "Activity placed on hold." — confirmations, `status-healthy` accent bar, auto-dismiss 4s.
- Failures use the inline error pattern above, not a toast (an error the user must act on shouldn't auto-dismiss).
- Destructive/irreversible actions (Reject, Reassign, Put on hold) get the confirmation dialog from §16 *before* the action, then a toast confirming the outcome after.

## §13 Navigation consistency
Verified against the shipped nav pattern (Round 1–3, all 4 roles): PageHeader + breadcrumb + project context + FilterBar/actions is present on every screen already built. The four orienting questions (Where am I / what am I viewing / whose work / what can I do) are answered respectively by: nav active-state + breadcrumb; PageHeader subtitle; owner column / "My Day" vs "Team" framing; the single primary action per row/state (DESIGN_DECISIONS.md's activity interaction model). No screen was found violating this; the rule is now written down so future screens are held to it.

## §14 Project context
The global project selector (`[ DESPL-320 · Pressure Vessel ▼ ]`, already built in Round 1's scope dropdown) is canonical. Rule: it persists across Project Control Centre, Schedule, Department-on-project, and Activity Detail (all Level 2/job-scoped screens); it does NOT apply to My Day, Team, or any Level 1 portfolio screen, which are correctly scope-free. Never re-prompt for a project already selected within that scoped flow.

## §15 Search & filtering
One FilterBar shape (DESIGN_SYSTEM.md), used where filtering is genuinely useful: Report Detail, Portfolio Analysis' trend-range chips, Supervisor Team, QC queues. Not present on Control Centre or Bottleneck Analysis, where the drill-down chain already scopes the data more precisely than a dropdown would (per Round 3's own filter-model note) — this pass confirms that call rather than adding filters everywhere for consistency's sake.

## §16 Confirmation & destructive actions
| Action | Confirmation? | Consequence shown | Reason required? | Audited? |
|---|---|---|---|---|
| Complete activity | No (reversible via Reopen request) | — | No | Yes (activity history) |
| Submit for QC | No | — | No | Yes |
| Put on hold | Yes, inline (not a full modal — hold reason entry IS the confirmation) | "This activity stops progressing until resumed." | Yes, from reason list | Yes |
| Reassign | Yes, the existing 2-step modal | Shows previous owner → new owner | Yes, from reason list | Yes (shown in step 2) |
| Reject (QC) | Yes, modal, `status-critical` confirm button | "This raises an NCR against [unit/stage]." | Yes | Yes |
| Verify (QC) | No | — | No | Yes |
| Override (any gating override, if introduced later) | Yes, modal, requires typed confirmation of the record ID | States exactly what gate is being bypassed | Yes | Yes, flagged in audit trail as an override specifically |

Rule: confirmation scales with consequence, not with destructiveness alone — Reject needs a modal because it raises an NCR (a new record with downstream effects); Complete doesn't, because Reopen request already provides a way back.

## §17 Microcopy
Terminology audit against DESIGN_DECISIONS.md's canon — no drift found, this pass just makes the "why" explicit:
- "Waiting for QC" not "QC_STATUS_PENDING" — the six display statuses (Not started, In progress, Awaiting QC, On hold, Overdue, Complete) already read this way.
- "Due today" not date-comparison logic — already how due dates render throughout.
- Actions use the six real transitions verbatim (start/submit/verify/reject/hold/resume) rendered as their capitalized labels — never a paraphrase that could imply a seventh action.
- Department/status names in charts use the real six-department and seven-delay-category taxonomy, not shortened or renamed for chart-label space (Round 3's own choice — confirmed here, not changed).

## §18 Visual QA — findings
Comparing all ~29 screens across Rounds 1–3:
- Button height (32px), radius (4px), and font (500 12px) are consistent everywhere checked.
- Status colors consistent — no screen was found using a different red/amber/green for the same meaning.
- Table density (52px comfortable rows) consistent on operational tables; Reports' list is intentionally denser (44px) per COMPONENT_INVENTORY.md — documented as the one sanctioned exception, not an inconsistency.
- PageHeader shape consistent on all screens audited.
- One gap closed by this pass: Toast, empty, loading and error states did not exist as designed patterns before Phase 4 — they're specified above and in DESIGN_SYSTEM.md so they don't get invented ad hoc, per-screen, during implementation.

## §19 Demo scenarios — walkthrough status
All four journeys trace cleanly through the already-built screens; Phase 4 adds no new screens to any path, only the state layer (loading/error/confirmation/toast) that makes each step feel finished rather than a static frame:
- **Employee:** My Day → Needs Attention → Activity → Update → Complete. Update now shows a Toast ("Assignment updated" style confirmation) on save; Complete shows the confirmation-scale rule (§16) — no modal needed.
- **Supervisor:** My Day → Team → Employee → Activity → Reassign. Reassign's existing 2-step modal is the confirmation; a Toast confirms afterward.
- **Management:** Dashboard → Delayed Project → Project → Bottleneck → Activity. Now specifies loading skeletons at each hop rather than a blank panel between clicks.
- **QC:** QC → Awaiting Verification → Inspection → Verify. Verify triggers a Toast; Reject (the alternate branch) triggers the new confirmation modal first.

## §20 Final screen-by-screen review
Full purpose/audience/action table for the five priority screens (remaining screens are governed by the same system; their entries are unchanged from DESIGN_DECISIONS.md's existing per-screen "answers" column and are not restated here to avoid duplicating that document):

| Screen | Purpose | Primary user | Primary question | Primary action | Secondary actions | Removed / disclosed |
|---|---|---|---|---|---|---|
| My Day (Employee) | Today's personal work queue | Production employee | What do I need to do right now? | Open next activity → Start/Update/Complete | View completed today, view assigned-not-today | Full history behind Activity Detail's right rail, not on the list |
| Activity Detail | Execute or progress one unit×stage | Employee, supervisor (view) | What do I do next on this activity? | The one state-driven primary action (table in DESIGN_DECISIONS.md) | Reassign, hold-reason edit, view QC record | Created/Updated/full history in right rail, not the main panel |
| Supervisor Team | Whose work needs a decision | Supervisor | Whose work needs a decision from me? | Open flagged employee/activity → Reassign or unblock | Filter by department/status | Per-employee full activity list behind a click into that employee |
| Management Dashboard | Where to intervene today | Management | Where should management intervene, today? | Open a needs-attention project → drill in | Change scope (project/date range) | Department-level detail lives on Department Analytics, not repeated here |
| Project Control Centre | Single project health | PM / engineering | What is happening to this project? | Open the schedule or an exception → act | Switch project tabs (Timeline, BOM, QCP, etc.) | Activity-level table deliberately absent — exceptions list links out instead (DESIGN_DECISIONS.md) |

## Deliverable status
This document, DESIGN_SYSTEM.md, COMPONENT_INVENTORY.md, RESPONSIVE_GUIDELINES.md and ACCESSIBILITY_AUDIT.md are the Phase 4 hardening pass. DESIGN_DECISIONS.md is updated with a short pointer section rather than duplicated. No production implementation has begun — per the brief's stop condition, this is presented for approval before Phase 5.
