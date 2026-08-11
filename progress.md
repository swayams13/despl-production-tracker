# progress.md — DESPL Production Tracker

> Living build log. Update at the end of every working session (see CLAUDE.md → Session discipline).

**Status:** 🟢 Week 0 complete — DESPL document handover analysed, all 8 architecture decisions locked, seed data generated from source documents, BUILD-SPEC-v2 written. **Ready to start coding (Sprint 1) in Antigravity.**
**Pilot target:** DESPL-320 (9 × HP air receiver, 320SR01–09) fully tracked by Week 8

---

## ▶ Resume point (read this first in a new session)

**Read `docs/BUILD-SPEC-v2.md` before anything else.** It supersedes the scheduling, granularity and stack sections of PRD/TRD.

Coding can begin. Build order is BUILD-SPEC-v2 §6. Seed data in `seed/` is generated from the DESPL documents — regenerate, don't hand-edit.

**Model discipline: Opus for architecture/spec/decisions, Sonnet for coding sessions.**

Hand `seed/data-issues.json` and BUILD-SPEC-v2 §7 (C1–C12) to DESPL — C1 (working vs calendar days) is the highest-impact open question.

## Milestones

### Week 0 — Specs & setup
- [x] Approach plan (03 Aug 2026)
- [x] PRD v1.0 (03 Aug 2026)
- [x] TRD + system architecture v1.0 (03 Aug 2026)
- [x] CLAUDE.md + progress.md
- [x] Interactive demo prototype (`prototype/despl-demo-prototype.html`) — role-based walkthrough of dashboard, daily brief, job matrix, unit board, Today list, QC queue, welding; live integrity refusals (gating, maker–checker, hold point); built-in feedback capture for the DESPL review session
- [x] Master prompt for v2 department-wise interactive dashboard written and delivered (`docs/design-master-prompt.md`) — user to try in Claude design mode; iterate or hand back for direct build
- [x] Demo/review session with SJ + team held; 7 documents received (lead time, work order process, component routing, 5 QAPs, QCP DESPL-320, 2 live project trackers)
- [x] All 7 documents analysed; 8 architecture decisions locked (11 Aug 2026)
- [x] Seed data generated from source docs: `seed/lead-time-model.json`, `component-routes.json`, `qcp-templates.json`, `live-jobs.json`, `data-issues.json`
- [x] `docs/BUILD-SPEC-v2.md` written — supersedes PRD/TRD scheduling + granularity + stack
- [x] Scheduling engine verified against DE0467 live dates
- [ ] Demo/review session with SJ + team → collect feedback notes → fold into PRD
- [ ] Wireframes: refine the 6 key screens from prototype feedback (prototype doubles as wireframes)
- [ ] PRD/TRD review with SJ — durations + predecessor DAG confirmation
- [ ] Repo scaffold (monorepo, CI, Railway staging), ERD in Prisma schema

### Sprint 1 (wk 1–2) — Foundation
- [ ] Auth (JWT cookies, argon2id), RBAC guards, user admin
- [ ] Master data: departments (+representatives), clients, welders, delay categories
- [ ] Template engine: equipment types, template versions, stages, predecessors, sub-activities, QCP templates
- [ ] Jobs & units CRUD; schedule auto-generation from standard durations (baseline + current plan)
- [ ] Seed: 25-stage Pressure Vessel template (placeholder durations until SJ's numbers arrive)

### Sprint 2 (wk 3–4) — Tracking core
- [ ] Stage state machine + gating DAG + material deps (transactional)
- [ ] Maker–checker submit/verify; department scoping
- [ ] Sub-activity checklists; ON_HOLD flow
- [ ] Component register + route engine (unit_components, component_operations, stage roll-up)
- [ ] Delay engine: overdue computation, filing block, reason categories, PH review
- [ ] Append-only audit log + interceptor + audit viewer
- [ ] Unit stage board + job matrix UI

### Sprint 3 (wk 5) — QCP + BOM
- [ ] Checkpoint execution (accept/reject/NA), rework items
- [ ] Hold/witness clearances incl. TPI-on-behalf (call given/attended dates), W-waiver flow
- [ ] Master BOM catalog (import + curation); per-unit BOM by selection with overrides
- [ ] BOM spreadsheet import; procurement chain; material inspections (MTC ref, heat numbers, PMI)
- [ ] Material-readiness view + stage↔material blocking

### Sprint 4 (wk 6) — KPIs + welding
- [ ] Welder registry + assignments; per-joint butt-weld logs; day-total logs
- [ ] NDT results per joint → per-welder repair rate
- [ ] Welding distribution view (person avg vs team avg; totals across assigned projects)
- [ ] Dashboards: company, department, quality, welding; CSV export

### Sprint 5 (wk 7) — Notifications & daily brief
- [ ] In-app notification center; escalation chain (supervisor+rep → PH → MD/CEO)
- [ ] "Today" priority lists (supervisor + QC variants)
- [ ] Daily brief job (07:45 IST) + brief screen
- [ ] At-risk detection

### Week 8 — Pilot & hardening
- [ ] Seed DESPL-320: 9 units, real BOM, weld joints, real durations
- [ ] UAT: SJ + 1 supervisor + 1 QC inspector
- [ ] E2E violation demo script (`docs/demo.md`)
- [ ] Backup/restore drill; Sentry; production promote
- [ ] Training + launch

### Phase 2 backlog (post-launch)
Email digests (SES/Resend, ≈₹0–1,700/mo) → WhatsApp · geo-tagged in-app photo proof for floor + QC entries · file uploads & MDR compilation · TPI/client read-only portal · more equipment templates · Hindi/Gujarati labels · welder qualification (WPS/PQR) registry · offline write queue (if pilot demands)

---

## Pending inputs from DESPL

| Input | Owner | Needed by | Status |
|---|---|---|---|
| Standard duration (days) per 25 stages | SJ / team | Sprint 1 seed (placeholders OK till then) | ⏳ requested |
| Department supervisors + **representatives** names | DESPL | Sprint 1 | ⏳ names to be shared |
| Welder list + employee codes | DESPL | Sprint 4 | ⏳ |
| Weld-map joint numbering convention | DESPL / QC | Sprint 4 | ⏳ |
| Parallel-stage predecessor confirmation | SJ | Week 0 review | ⏳ draft DAG ready in TRD |
| Delay-reason category review | SJ | Sprint 2 | ⏳ draft list in PRD FR-D2 |
| Per-component fabrication routes (shell course, head, cone, nozzle, manway, saddle/skirt, accessories) | SJ / production | Sprint 2 | ⏳ we draft from work-order doc, they correct |
| Master BOM item list (or 3–5 past project BOM Excels to derive it) | Engineering | Sprint 3 | ⏳ |
| Current report/register formats (fit-up, dimensional, NDT, hydro, daily production register) | QC / production | Sprint 3–4 UX | ⏳ nice-to-have |

## Decisions log

| Date | Decision |
|---|---|
| 11 Aug 2026 | **36-process Lead Time list is the master spine**; 25-stage work order becomes a reporting view (crosswalk seeded) |
| 11 Aug 2026 | **Granularity: per BOM item + serial roll-up from Final Assembly onward** — matches the live trackers, keeps MDR traceability |
| 11 Aug 2026 | **Scheduling: forward + backward + infeasibility flag, with planner override** (mandatory reason, audited, baseline preserved) |
| 11 Aug 2026 | **Durations: fixed baseline, editable per project** |
| 11 Aug 2026 | **Stack revised to a single Next.js full-stack app + Prisma/Postgres** — replaces the split Next.js/NestJS monorepo in TRD §2 |
| 11 Aug 2026 | **Tender intake: manual key fields + attached file**; no PDF parsing in v1 |
| 11 Aug 2026 | **QAP engine: fully dynamic inspection parties, code set P/W/H/R/RW/R&A** — driven by the 3-party heat exchanger QAP |
| 11 Aug 2026 | Department mapping (13) drafted by us for DESPL to correct, rather than blocking on their list |
| 11 Aug 2026 | **Model usage: Opus for architecture/decisions, Sonnet for coding** |
| 11 Aug 2026 | **Two-layer scheduling model adopted** after discovering a finish-to-start chain gives 11.6–24 wks vs DESPL's stated ~17 wks; printed cumulative envelope is authoritative, DAG lags fitted to it |
| 11 Aug 2026 | **Step 0 env: local dev DB is Railway Postgres, not Docker** — skips a local install since Railway is already the Step 14 deploy target; local and staging stay on the same DB engine day one. **Docker install deferred** to after the app is deployed and in full-fledged use (revisit if local-container parity/offline dev is ever needed) |
| 03 Aug 2026 | Maker–checker entry: supervisors submit, separate QC users verify every gate |
| 03 Aug 2026 | Single-company platform (DESPL), jobs organized client-wise |
| 03 Aug 2026 | v1 = full depth: 25 stages + QCP hold points + BOM + KPIs + daily brief |
| 03 Aug 2026 | v1 notifications in-app only; email Phase 2 (SES ≈ <₹100/mo at est. volume) |
| 03 Aug 2026 | QC records TPI clearances on TPI's behalf in v1; TPI login Phase 2 |
| 03 Aug 2026 | Schedules from SJ-supplied standard durations; baseline vs current-plan versioning |
| 03 Aug 2026 | Welding: per-joint for butt welds + NDT per welder + per-welder totals; day-total otherwise |
| 03 Aug 2026 | MDR = status checklist only in v1; uploads Phase 2 |
| 03 Aug 2026 | English-only UI, strings externalized for later Hindi/Gujarati |
| 03 Aug 2026 | ~50 concurrent users target; Railway hosting (Dockerized, portable) |
| 03 Aug 2026 | Stack: Next.js 15 + NestJS 11 + Prisma/Postgres + Redis/BullMQ, pnpm monorepo |
| 03 Aug 2026 | Each department gets a designated representative (default notification recipient) |
| 03 Aug 2026 | Master BOM catalog: per-project BOMs built by selecting from a company master list (BOMs differ every project); custom items allowed |
| 03 Aug 2026 | Component-level tracking: floor tracks per-part operation routes (shell, heads, nozzles, saddle…); vessel stages become computed roll-ups |

## Session log

| Date | What happened |
|---|---|
| 03 Aug 2026 | Researched source docs (25-stage work order, QCP DESPL-320-01→09, PV BOM); approach plan, PRD, TRD, CLAUDE.md, progress.md written and saved to project folder |
| 03 Aug 2026 | Design revision: master BOM catalog + component-level production tracking added to PRD (FR-B0, FR-C1–C4) and TRD schema; final DESPL document request list issued |
| 03 Aug 2026 | Built interactive single-file demo prototype (sample data, job DESPL-320) for the company review session; tested end-to-end in headless Chromium — no errors |
| 03 Aug 2026 | v1 prototype reviewed by user as "good but not detailed/department-wise enough"; wrote a master prompt spec (9 department workspaces with named KPIs, full domain context, interactive integrity flow) for generating a v2 in Claude design mode; delivered and saved to docs/ |
| 03 Aug 2026 | Model switched mid-session to claude-sonnet-5; user flagged new updates incoming — progress/context checkpoint saved before pausing for those updates |
| 11 Aug 2026 | DESPL handover: 7 documents received and fully analysed. 8 architecture decisions taken. Discovered the lead-time table encodes concurrent fabrication (21/36 processes overlap) and cannot be scheduled by summation — adopted two-layer envelope+CPM model. Generated all seed data from source documents. Wrote BUILD-SPEC-v2. Verified the engine against DE0467: its committed dispatch date is ~26 working days shorter than DESPL's own standard lead time — the tracker would have flagged this at order acceptance. |
| 11 Aug 2026 | Step 0 (IMPLEMENTATION-GUIDE.md) run: read + confirmed CLAUDE.md/BUILD-SPEC-v2/IMPLEMENTATION-GUIDE.md back to user. Env check found Node v25.9.0 (guide wants v20 LTS) and no Docker. Installed nvm via Homebrew, set Node 20.20.2 as default (`nvm alias default 20`, `nvm use default` added to `.zshrc`), switched pnpm to a Node-20-compatible build via `corepack prepare pnpm@latest-9 --activate` (Homebrew's global pnpm 11 required Node ≥22). Confirmed working in a fresh interactive shell. User opted to skip Docker and use Railway Postgres for local dev instead (see Decisions log); Docker install deferred to post-deployment. Antigravity IDE and Claude CLI already present. Home directory (`/Users/sonusingh`) turned out to be one giant git repo tracking unrelated projects (remote `Pdftoproposal.git`) — `DESPL TRACKER/` is untracked inside it; flagged to user, left untouched, `git init` in Step 1 will create its own nested repo as intended. |

## Blockers

_None blocking the build._ Twelve open questions (C1–C12 in BUILD-SPEC-v2 §7) each have a working default in place. **C1 — whether the lead-time table's "Days" are working or calendar days — is the highest-impact one**: it changes every computed date, and changes the DE0467 shortfall from ~26 days to ~6 days.

## Findings to raise with DESPL

1. **DE0467 was committed on a timeline shorter than DESPL's own standard lead time** (PO 24 Jun → dispatch 15 Oct = 97 working days vs 119 minimum). Best single demonstration of the tracker's value.
2. **Per DESPL's own table, 17 weeks is both the minimum and the maximum** — rows 35–36 print a single value. There is no documented "fast" case.
3. **12 data issues** in the live trackers — see `seed/data-issues.json` (job number mismatch, lost sub-assembly labels, misused Material Identification column, ambiguous dates, no planned dates, no owners).
