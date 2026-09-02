# Product Requirements Document (PRD)
## DESPL Production Tracker — v1

> ⚠️ **Superseded, 26 Aug 2026 (audit §6 / Phase 0 item 0.15):** `docs/BUILD-SPEC-v2.md` supersedes
> this document's scheduling, granularity, and stack sections — notably the split-monorepo stack
> below (§6/§10), which was replaced 11 Aug 2026 by the single Next.js full-stack app described in
> the root `CLAUDE.md`. Read `BUILD-SPEC-v2.md` first; treat everything else here as historical
> requirements/business context, not current architecture.

| | |
|---|---|
| **Product** | DESPL Production Tracker (working name) |
| **Company** | Dhruv EPC Solutions Pvt. Ltd. (Vedanta Group) |
| **Document version** | 1.0 — Draft for review |
| **Author** | Swayam |
| **Date** | 03 Aug 2026 |
| **Reviewers / Approvers** | SJ (Production Head), MD, CEO |
| **Related docs** | Approach Plan (03 Aug 2026), Work Order Process (25 stages), QCP DESPL-320-01 to 09, Pressure Vessel BOM |

---

## 1. Background & Problem Statement

DESPL manufactures ASME-code pressure equipment through a well-defined 25-stage process (PO receipt → dispatch) governed by a Quality Control Plan with Perform / Witness / Hold inspection points and full material traceability requirements. Today, tracking this process across departments relies on verbal updates, registers, and spreadsheets. The consequences:

- Management (MD, CEO, Production Head) has no live, single source of truth across simultaneous jobs.
- Progress claims cannot be independently verified — entries can be made late, out of order, or inaccurately.
- Deadline slippage is discovered late, and delay reasons are not captured or attributed.
- Department and individual performance (e.g., welder productivity, QC first-pass yield) is not measurable, so there is no data-backed accountability or work distribution.
- Compiling traceability for the MDR at the end of a job requires reconstructing history manually.

## 2. Product Vision & Objectives

One platform that is the **single source of truth** for every job from PO to dispatch, where:

1. The real manufacturing process is enforced, not just recorded — a stage cannot begin until the previous one is complete and verified.
2. Data is trustworthy by construction — maker–checker entry, server timestamps, and an immutable audit trail make fake or back-dated entries structurally impossible.
3. Management sees the whole company daily without asking anyone — dashboards, a daily brief, and exception-first views.
4. Deadlines carry accountability — every overdue stage requires a categorized reason, and adherence feeds department KPIs.
5. The platform scales beyond pressure vessels through equipment-type templates, without code changes.

## 3. Success Metrics (v1, measured during the DESPL-320 pilot)

| Metric | Target |
|---|---|
| Active jobs tracked on platform | 100% (starting with DESPL-320, all 9 vessels) |
| Overdue stages with a filed delay reason | 100% (enforced by product) |
| Stage-gate violations (skips, self-verification) | 0 (enforced by product) |
| Management daily-brief usage | MD/CEO/SJ open the daily brief ≥ 5 days/week |
| Supervisor time per progress update | < 2 minutes |
| Data corrections requiring admin override | < 5% of entries (indicator of UX fit + honesty of plan) |

## 4. Users & Roles

All roles are assignable and changeable by Admin; multiple people can hold the same role (e.g., multiple Production Heads).

| Role | Description | Key permissions |
|---|---|---|
| **Admin** | System owner (initially Swayam + one DESPL delegate) | User/role management, templates, master data, audited correction overrides |
| **MD / CEO** | Top management, daily oversight | View-all dashboards, daily brief, drill-down, comments. No data entry. |
| **Production Head** (SJ; can be multiple) | Owns production execution | View-all, set/adjust unit schedules, approve delay reasons, reassign work, welding distribution views |
| **Department Supervisor** | Runs a department (Engineering, Procurement, Stores, Production, Painting, Dispatch…) | Enter progress **only for own department's stages**, log welding output, file delay reasons, view own priority list |
| **QC Inspector** | Quality function | Verify submitted stages (checker), execute QCP checkpoints, record hold-point and TPI clearances, log NDT results |
| **Viewer** *(Phase 2)* | TPI / client read-only | Not in v1 — QC records TPI clearances on their behalf |

## 5. Scope

### 5.1 In scope — v1

1. Client / Job / Equipment-Unit management (each vessel serial tracked individually; progress rolls up unit → job → company).
2. Stage-template engine seeded with the 25-stage Pressure Vessel template (stages, sub-activities, owning departments, conditional stages such as PWHT/PMI).
3. Standard per-stage durations **supplied by SJ and the DESPL team**, stored on the template; schedule auto-generated at job kickoff and adjustable per unit by Production Head (all changes versioned against the baseline).
4. Sequential stage gating with maker–checker completion (supervisor submits → QC verifies).
5. QCP/ITP checkpoint engine: P / W / H / R codes, hold-point blocking, inspection-call-given / call-attended dates; **QC records TPI/client clearances on their behalf in v1**.
6. BOM per unit with procurement chain (MR → PR → RFQ → PO → received → incoming inspection → accepted/issued) and heat-number traceability (data capture; certificate file uploads deferred).
7. Welding productivity module (detail in §6.7): welder registry, per-joint logging for butt welds, day-totals otherwise, NDT results per welder, per-welder totals across assigned projects.
8. Deadline & delay engine with mandatory categorized reasons and escalation.
9. In-app notification center, morning priority lists, and management daily brief. **No email in v1.**
10. KPI dashboards (company / job / department / welder).
11. Append-only audit log on every mutation; admin correction workflow with mandatory reason.
12. MDR (Stage 23) tracked as a **status checklist only** (item complete / pending); file uploads deferred to Phase 2.
13. English-only UI, mobile-first PWA.

### 5.2 Out of scope — v1 (Phase 2 backlog)

Email + WhatsApp notifications; geo-tagged in-app photo proof for floor production and QC; document/file uploads (MTCs, inspection reports, MDR compilation); TPI/client read-only portal; additional equipment-type templates (heat exchangers, tanks, skids); Hindi/Gujarati UI labels; welder qualification (WPS/PQR) registry; client dispatch intimation automation.

## 6. Functional Requirements

Requirement IDs are grouped by module. Priority: **M** = must-have for v1 launch, **S** = should-have (build in v1 if sprint allows, else v1.1).

### 6.1 Authentication, Users & RBAC

- **FR-A1 (M)** Email + password login with secure session handling; passwords hashed (argon2/bcrypt). No self-signup — Admin creates users.
- **FR-A2 (M)** Role-based access control per §4, enforced at the API layer for every endpoint. A user may hold multiple roles, but the maker–checker rule (FR-S6) applies per action regardless of roles held.
- **FR-A3 (M)** Admin can deactivate users (history retained), reset passwords, and reassign role holders (e.g., change/add Production Heads) without data loss.
- **FR-A4 (S)** Session device list and forced logout.

### 6.2 Master Data & Templates

- **FR-M1 (M)** Manage clients, departments, users, welders, delay-reason categories, and equipment types. Each department has a **designated representative** (name to be provided by DESPL) who is the default recipient of that department's notifications, priority lists, and escalations; representatives are changeable by Admin/Production Head.
- **FR-M2 (M)** Stage templates per equipment type: ordered stages, sub-activities, owning department, conditional flags ("if required": PWHT, PMI, holiday test…), and **standard duration in days per stage (values provided by SJ/DESPL team)**.
- **FR-M3 (M)** QCP checkpoint templates attachable to stages: activity/component, characteristics, extent, applicable document, acceptance criteria, record type, and inspection codes for Seller and Buyer/TPI (P/W/H/R).
- **FR-M4 (M)** Template versioning: editing a template affects only future jobs; running units keep the version they started with.

### 6.3 Jobs & Equipment Units

- **FR-J1 (M)** Create job: job number (e.g., DESPL-320), client, PO reference, design code, order date, contractual delivery date, priority.
- **FR-J2 (M)** Add units under a job (e.g., 320SR01…320SR09), each instantiated from an equipment-type template with its own full stage/QCP/BOM structure and its own schedule.
- **FR-J3 (M)** On unit creation, the schedule is auto-generated from standard stage durations (forward from kickoff date); Production Head can adjust planned dates per stage per unit. The original auto-schedule is kept as **baseline**; adjustments create the **current plan**; both are retained for schedule-variance KPIs.
- **FR-J4 (M)** Unit stage board: single-screen view of all stages of a unit with status, planned vs actual dates, blockers, and % complete (weighted by stage durations).
- **FR-J5 (M)** Job overview: all units side by side (matrix: unit × stage), job % complete, at-risk indicators.

### 6.4 Stage Tracking, Gating & Integrity

- **FR-S1 (M)** Stage lifecycle: `Not Started → In Progress → Submitted → Verified/Complete` (plus `On Hold` for client/material holds, with reason).
- **FR-S2 (M)** **Hard sequential gating:** a stage cannot be started until the previous stage is Complete, enforced server-side. Parallel-eligible stages (e.g., Nozzle Fabrication alongside Shell Fabrication) are marked in the template with explicit predecessor rules rather than simple ordering.
- **FR-S3 (M)** Supervisors can act only on stages owned by their department (per template mapping).
- **FR-S4 (M)** Sub-activity checklists within a stage (e.g., Shell Fabrication: fit-up → L-seam → RT → circ fit-up → circ weld → RT → dimension check); all must be checked before the stage can be Submitted.
- **FR-S5 (M)** All **actual** timestamps are server-generated at the moment of the action. No user-editable "actual date" fields anywhere in the product.
- **FR-S6 (M)** **Maker–checker:** the user who Submits a stage can never be the user who Verifies it; verification requires the QC Inspector role. Enforced at API level.
- **FR-S7 (M)** A stage with any uncleared QCP **hold point (H)** cannot be Verified/Completed (see FR-Q3).
- **FR-S8 (M)** Corrections: no destructive edits. An admin-approved correction creates a new version with mandatory reason; original values remain visible in history; corrections are flagged on management views.

**Component-level production tracking** (the detailed floor-level layer under the stages):

- **FR-C1 (M)** Each unit carries a **component register** auto-generated from its BOM (shell courses, dished ends/heads, cone, nozzles N1–Nn, manways, saddle/skirt, davit, accessories), editable by Engineering. Each component gets an **operation route** from a per-component-type route template (e.g., shell course: marking → cutting → edge prep → rolling → L-seam fit-up → L-seam weld → NDT; nozzle: neck fab → flange weld → reinforcement pad → inspection). Route definitions per component type are an input from SJ/DESPL.
- **FR-C2 (M)** Supervisors track progress at **component-operation level**; unit-stage status and % complete are **computed roll-ups** of the mapped component operations. A stage cannot be Submitted until all its mapped component operations are done. The management stage board stays as-is but now reflects part-level truth.
- **FR-C3 (M)** Component operations obey the same integrity rules: in-route sequential gating, server timestamps, QC verification on inspection operations, full audit.
- **FR-C4 (S)** Component traceability view: BOM item → heat number → component → operations → weld joints → NDT results (the thread the MDR ultimately needs).

### 6.5 QCP / Inspection Checkpoints

- **FR-Q1 (M)** Each unit carries its QCP checkpoint instances grouped under stages, showing characteristics, acceptance criteria, and inspection codes exactly as in the QCP document.
- **FR-Q2 (M)** QC Inspector records each checkpoint result: Accepted / Rejected / NA-with-reason, with remarks; rejection creates a rework item that must be closed (re-inspection) before the parent stage can complete.
- **FR-Q3 (M)** Hold points (H): stage completion is blocked until the hold point is recorded as cleared. For Buyer/TPI hold or witness points, QC records **inspection call given date, call attended date, clearing party (TPI name/client), and remarks** — on the TPI's behalf in v1.
- **FR-Q4 (M)** Witness points (W): recorded like hold points but non-blocking if waived — a waiver requires Production Head approval and is audited.
- **FR-Q5 (S)** Checkpoint history view per unit (the digital equivalent of a signed ITP sheet), exportable to CSV/print view.

### 6.6 BOM, Procurement & Traceability

- **FR-B0 (M)** **Master BOM catalog:** a company-wide library of standard items (category, description, material spec, default size/UoM), managed by Admin/Engineering and importable from a master list DESPL provides. Ensures consistent naming across projects so procurement and delay analytics are comparable job-to-job.
- **FR-B1 (M)** BOM per unit is built by **selecting items from the master catalog** (with per-project overrides of qty, size, tag) — since no two projects share identical BOMs — plus spreadsheet import (column-mapped, auto-matched to master items) and free-form custom items where no master entry exists (flagged for later catalog curation): sr no, tag (e.g., N1, M1, SV1–SV4), qty, material spec, size, unit weight.
- **FR-B2 (M)** Per-item procurement chain with statuses: MR raised → PR → RFQ → PO placed → Received → Incoming inspection → Accepted / Rejected → Issued to floor. Dates server-stamped per transition.
- **FR-B3 (M)** Incoming inspection captures MTC reference number, heat number(s), and PMI-required flag with result — linking heat numbers to BOM items for the traceability chain. (Certificate file uploads: Phase 2.)
- **FR-B4 (M)** Material-readiness view per unit: which BOM items block which stages (e.g., Cutting cannot start until shell plates are Accepted — configurable stage↔item-category dependencies).
- **FR-B5 (S)** Procurement dashboard across jobs: open MRs/POs, overdue deliveries, lead-time stats per material category.

### 6.7 Welding Productivity Module

- **FR-W1 (M)** Welder registry: name, employee code, active/inactive, departments/projects assigned.
- **FR-W2 (M)** **Butt welds logged per joint:** joint/seam ID (from weld map, e.g., LS-1, CS-1, CS-2, nozzle joints), welder(s), date, weld size/type. Fillet and miscellaneous work logged as **day-total per welder** (hours or output quantity).
- **FR-W3 (M)** **NDT results linked per welder:** RT/UT/PT/MT result per joint recorded by QC, attributed to the welder(s) of that joint → per-welder repair/reject rate.
- **FR-W4 (M)** Per-welder analytics: total work done across the projects assigned to them, daily/weekly averages, versus **team average** — the work-distribution view SJ uses to balance load.
- **FR-W5 (S)** Welding summary per unit: joints total / welded / NDT-cleared / repairs.

### 6.8 Deadlines, Delay Reasons & Escalation

- **FR-D1 (M)** A stage becomes **Overdue** the day after its planned end date if not Complete. Overdue state is computed, never entered.
- **FR-D2 (M)** **Mandatory reason:** once a department has an overdue stage, further progress entries by that department on that unit are blocked until a categorized delay reason is filed (categories: material delay, manpower, machine breakdown, rework/quality, client hold, drawing/engineering hold, other + free text).
- **FR-D3 (M)** Delay reasons are reviewed by the Production Head (acknowledge / dispute); disputes go to Admin/MD visibility. All reasons and outcomes feed the department schedule-adherence KPI.
- **FR-D4 (M)** Escalation chain: on overdue day 1 → supervisor notified; day 2 → Production Head; day 3+ → MD/CEO flagged in daily brief and dashboards (thresholds configurable).
- **FR-D5 (M)** At-risk detection: a stage whose remaining planned duration is less than typical actuals, or whose predecessor finished late, is flagged **At Risk** before it is overdue.

### 6.9 Notifications & Daily Brief (in-app only for v1)

- **FR-N1 (M)** In-app notification center per user: assignments, submissions awaiting verification, hold-point calls due, overdue/escalations, reason-review requests.
- **FR-N2 (M)** **Morning priority list** per supervisor and QC inspector, auto-ordered: overdue → due today → at-risk → upcoming, weighted by job priority and delivery date. This is the department's "do these first, in this order" screen.
- **FR-N3 (M)** **Management daily brief** (in-app screen, generated at a fixed time daily): company snapshot (on-track / at-risk / delayed), yesterday's movement (stages completed, hold points cleared, material received), exceptions first (overdue with reasons or "reason pending" in red), upcoming inspection calls, per-job % complete trend.
- **FR-N4 (S)** Read/unread state and per-user notification preferences.
- *(Email delivery of the daily brief and escalations: Phase 2 — cost estimate in §9.)*

### 6.10 KPI Dashboards

- **FR-K1 (M)** Company dashboard (MD/CEO/Production Head): OTD %, WIP by department (bottleneck view), overdue count, reason-pending count, delay Pareto by category and department, per-job % complete.
- **FR-K2 (M)** Department dashboard: schedule adherence %, average stage cycle time vs standard, current load, overdue list.
- **FR-K3 (M)** Quality dashboard: first-pass yield (checkpoints accepted first time), NDT repair rate overall and per welder, rework items open/closed.
- **FR-K4 (M)** Welding dashboard per §6.7 (FR-W4).
- **FR-K5 (S)** CSV export of any dashboard table; date-range and job/client filters everywhere.

### 6.11 Audit & Administration

- **FR-X1 (M)** Append-only audit log for every mutation: actor, action, entity, before/after, server timestamp, IP/device. Immutable — no delete/update path exists in the application layer.
- **FR-X2 (M)** Audit viewer for Admin/MD with filters (user, unit, date, action type).
- **FR-X3 (M)** Admin correction workflow per FR-S8, with its own audit trail and a visible "corrected" badge on affected records.

## 7. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Capacity | ≤ **50 concurrent users**; ~50 jobs × 10 units live without degradation (trivial for the chosen stack, stated as the test target) |
| Performance | p95 API < 500 ms; dashboards < 2 s; priority list < 1 s on mid-range Android over factory Wi-Fi/4G |
| Platform | Mobile-first responsive PWA (installable); Chrome/Edge/Android WebView supported |
| Hosting | **Railway** (staging + production environments), Dockerized from day 1 so migration to AWS/other later is a re-deploy, not a rewrite |
| Security | TLS everywhere; RBAC at API layer; hashed passwords; rate-limited auth; no PII beyond name/email/employee code |
| Data safety | Automated daily Postgres backups with restore drill before pilot; audit table excluded from any cleanup jobs |
| Availability | 99.5% target during working hours; graceful degradation (read-only mode) if job queue is down |
| Auditability | Every mutation audited (FR-X1); server-time as single time authority (IST) |
| Localization | English-only v1; all UI strings externalized so Hindi/Gujarati labels are a translation task later, not a rebuild |

## 8. Release Plan (maps to the 8-week plan in the Approach doc)

| Sprint | Deliverable | Requirements covered |
|---|---|---|
| Week 0 | TRD + system architecture + ERD + wireframes, sign-off with SJ | — |
| Sprint 1 (wk 1–2) | Foundation: auth, RBAC, master data, templates, jobs/units | FR-A*, FR-M*, FR-J1–J3 |
| Sprint 2 (wk 3–4) | Tracking core: gating, maker–checker, delay engine, audit | FR-S*, FR-D1–D3, FR-X* |
| Sprint 3 (wk 5) | QCP + BOM/traceability | FR-Q*, FR-B* |
| Sprint 4 (wk 6) | KPIs + welding module | FR-K*, FR-W* |
| Sprint 5 (wk 7) | Notifications, priority lists, daily brief, escalations | FR-N*, FR-D4–D5 |
| Week 8 | Pilot: DESPL-320 (9 vessels) seeded live; UAT with SJ + 1 supervisor + 1 QC; training; hardening | All |

**Inputs needed from DESPL before Sprint 1:** standard duration (days) for each of the 25 stages from SJ/team; department list with supervisor **and representative** names; welder list; delay-reason category review; confirmation of the DESPL-320 schedule baseline.

## 9. Costs (approximate, monthly)

| Item | v1 | Phase 2 |
|---|---|---|
| Railway (frontend + backend + Postgres + Redis) | ~$10–25/mo on usage-based pricing at this scale | similar until traffic grows |
| File storage (Phase 2 uploads/photos) | — | Cloudflare R2 ≈ $0.015/GB-month, ~$1–3/mo initially |
| **Email (deferred to Phase 2)** | — | Estimated volume ≈ 100–200 emails/day (daily briefs + escalations + reminders) ≈ **3–6k emails/month**. AWS SES: $0.10 per 1,000 → **< $1/mo (~₹50–80)**. Resend: free tier 3,000/mo (100/day cap) → likely **free** initially, $20/mo (~₹1,700) on Pro if volume grows. Brevo free tier: 300/day. Practical budget: **₹0–1,700/month**, with SES the cheapest at scale. |
| WhatsApp (optional, later) | — | Meta utility messages in India are per-message priced (order of ₹0.1–0.8); at ~100 msgs/day ≈ ₹300–2,400/mo — quote precisely when that phase is scoped |

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Floor adoption — supervisors bypass the app | Priority-list UX designed for < 2-min updates; training in week 8; management uses only the app for reviews (forcing function) |
| Wrong standard durations poison KPIs early | Durations workshop with SJ before Sprint 1; baseline vs current-plan separation means recalibration doesn't rewrite history |
| Template misses real process nuances | Pilot on DESPL-320 with template-version fixes allowed before company-wide rollout |
| Single developer bus factor | TRD + ERD documented; CI from day 1; seed scripts; Docker |
| Railway limits / migration later | Docker + standard Postgres → portable by design |
| Over-strict blocking frustrates users on genuine edge cases | Production Head waiver (FR-Q4) and admin correction flow (FR-S8) exist — but always audited and visible |

## 11. Approval

| Name | Role | Decision | Date |
|---|---|---|---|
| SJ | Production Head | | |
| | MD | | |
| | CEO | | |
