# progress.md — DESPL Production Tracker

> Living build log. Update at the end of every working session (see CLAUDE.md → Session discipline).

**Status:** 🟢 IMPLEMENTATION-GUIDE.md Steps 0–6 done (env, git/GitHub repo, summarize-back check, Next.js scaffold, DB connection, Prisma schema, seed import). **Next: Step 7 (scheduling engine, `lib/schedule/`).**
**Pilot target:** DESPL-320 (9 × HP air receiver, 320SR01–09) fully tracked by Week 8

---

## ▶ Resume point (read this first in a new session)

**Step 6 (seed script) is done. Start Step 7 (scheduling engine, `lib/schedule/`) next.**

`prisma/seed.ts` parses all 5 `seed/*.json` files directly (no hand-typed data) and loads the reference spine (Department/LeadTimeProcess/ProcessEdge/ProcessDepartment), the two live jobs (Client/Job/Equipment/BomItem/Procurement/ItemOperation), and the DESPL-320 QCP template (QcpTemplate/InspectionParty/QcpItem/QcpItemPartyCode) inside one `prisma.$transaction`. `pnpm db:seed` runs it via `tsx` (added as a devDependency — neither `tsx` nor `ts-node` existed before). Verified independently against Postgres, not just trusted the build report: 13 departments, 36 processes, 39 edges, DE0463 with 20 BOM items, DE0467 with 34 — all match. All 12 `seed/data-issues.json` entries are surfaced via `findIssue`/`findIssueOptional` lookups (not copy-pasted text) onto `Job.remarks`/`Equipment.remarks`/`BomItem.remarks`; `FIELD_MISUSE` (qc.materialIdentification is a Sourcing value, not traceability data — routed onto a synthesized `MTC_VERIFICATION` ItemOperation) and `NO_PLANNED_DATES`/`NO_OWNER` (file-wide, no single row to hang them on) are surfaced as code comments instead since no schema field fits. `Client.name` is an explicit `"Unknown client — pending DESPL confirmation"` placeholder, not a fabricated company name — no client/customer name exists anywhere in `live-jobs.json`.

Two things to know, not bugs: (1) the guide's Step 6 check says "54 QcpItem rows" — the table actually has 62 (54 `kind=CHECKPOINT` + 8 `kind=SECTION` header rows, both stored in one table per schema; `qcp-templates.json` itself has 62 `items`). The 54 figure matches the CHECKPOINT subset exactly, so the data's right, the guide's checklist line is just imprecise. (2) `db:seed` is `createMany`-only, not idempotent — reseeding a non-empty DB means `pnpm prisma migrate reset` (which wipes and reruns seed automatically), not rerunning `pnpm db:seed` directly. Confirmed with the user this is fine as-is; no upsert/delete-first logic added.

`Out of scope this pass (no source data): Unit, ProjectSchedule, ProjectProcessPlan, QcpExecution, AssemblyDrawing, DelayReason, MaterialIdentification, ItemTest — flagged in a comment at the top of seed.ts, not silently absent.

Built via a 4-phase dynamic workflow (map each seed file → merge into one plan → implement → verify) rather than a single linear session — 4 parallel read-only agents each mapped one `seed/*.json` file to its target Prisma models before a single implementer wrote `prisma/seed.ts`, then a separate verify pass ran the seed and checked row counts.

---

**Step 5 (Prisma schema) context, still relevant:** `prisma/schema.prisma` has all 24 models from BUILD-SPEC-v2 §2 (Client, Job, Equipment, Unit, LeadTimeProcess, ProcessEdge, Department, ProcessDepartment, ProjectSchedule, ProjectProcessPlan, BomItem, Procurement, MaterialIdentification, ItemOperation, ItemTest, InspectionParty, QcpTemplate, QcpItem, QcpItemPartyCode, QcpExecution, AssemblyDrawing, DelayReason, Notification, AuditLog), migration `20260811173408_init` applied, `pnpm typecheck`/`pnpm lint` both clean. Field/enum shapes were reverse-engineered from `seed/*.json` (not guessed): e.g. `ProcurementStatus`/`MaterialReceivedStatus` enums come from the actual distinct values in `live-jobs.json`, `CanonicalOperation`/`ComponentType` enums come from `component-routes.json`, `QcpCode` from `qcp-templates.json`. `Job.workOrderNoInFile` and `remarks` fields on `Job`/`Equipment`/`BomItem` exist specifically to hold the `JOB_NUMBER_MISMATCH`/`UNLABELLED_BLOCK` issues flagged in `seed/data-issues.json`.

Two invariants only partially close at the schema layer (both flagged in schema comments, not silently assumed done):
- **Invariant #1** (no client-writable `actual_*`/`*_at` fields): `ProjectProcessPlan.actualStart/actualFinish` and `QcpExecution.callAttendedOn/recordedAt` are commented `server-set only` — real enforcement happens once Server Actions/zod DTOs exist (Step 7+), there's no DTO layer yet to enforce it in.
- **Invariant #5** (audit_log append-only, no UPDATE/DELETE for the app DB role): migration includes `REVOKE UPDATE, DELETE ON "audit_log" FROM PUBLIC;`, but local dev connects as the Postgres **superuser** (`postgres`), which bypasses GRANT/REVOKE entirely — this is a no-op until a non-superuser app role exists (Railway deploy, Step 14). Re-run the REVOKE against that role then.

Design choices worth knowing if you're extending this: `LeadTimeProcess.code` and `Department.code` are natural keys (no redundant surrogate id) since the seed data already keys them that way. `Procurement` is a single current-state row per `BomItem` (not an append-only event chain like TRD v1.0's `procurement_events`) — BUILD-SPEC-v2 §2 explicitly changed this shape to match the live CSVs. No `User`/`Role`/RBAC tables yet (Step 8) — actor-ish fields (`filedBy`, `clearedBy`, `waiverApprovedBy`, `AuditLog.actorRef`, `Notification.recipientRef`) are plain strings for now, not FKs, until Users exists to hang a real relation off.

**Unrelated environment fix made along the way:** a `pnpm install` run wiped `node_modules` and then failed to reinstall on pnpm 11's `minimumReleaseAge` supply-chain policy (`electron-to-chromium@1.5.404` published same-day). This isn't a one-off — pnpm re-runs the same check before every `pnpm run <script>`, so it would have blocked `dev`/`lint`/`typecheck` all session. Confirmed with the user, then set `minimumReleaseAge: 0` in `pnpm-workspace.yaml` (this file is pnpm 11's actual settings location — a project `.npmrc` with the equivalent `minimum-release-age=0` key was tried first and silently ignored, so don't reach for `.npmrc` for this). Also resolved the pre-existing `allowBuilds` placeholders in that same file (`true` for `@prisma/client`, `@prisma/engines`, `prisma`, `sharp`, `unrs-resolver`) so postinstall scripts run instead of being silently skipped.

State to know before resuming: `despl-pg` container should still be running (`docker ps`); restart with `docker start despl-pg` if the machine rebooted. If `P1010`-style symptoms ever reappear, check `brew services list` for a re-started `postgresql@14`/`@18` before re-diagnosing Docker/Prisma (see 12 Aug session log entry for the full story). `.env` has the correct `DATABASE_URL`. `dotenv` remains an unused devDependency (harmless, fine to leave or remove later).

**Read `docs/BUILD-SPEC-v2.md` before anything else** if starting fresh context. It supersedes the scheduling, granularity and stack sections of PRD/TRD. Follow `docs/IMPLEMENTATION-GUIDE.md` step by step — currently at Step 7.

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
- [x] Repo scaffold (Next.js app, DB connection), ERD in Prisma schema

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
| 11 Aug 2026 | ~~Step 0 env: local dev DB is Railway Postgres, not Docker~~ — **superseded same day at Step 4**: user decided to install Docker after all for local dev; Railway stays the Step 14 deploy target only, per the guide's original plan. `railway` CLI (v5.35.2) is installed and ready for Step 14 regardless |
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
| 11 Aug 2026 | Step 1 run: `git init` inside `DESPL TRACKER/` (its own nested repo, separate from the home-directory repo). Added `.gitignore` excluding `QCP - DE0463.pdf` (client document, not part of the guide's commit list) plus `.env`/`.DS_Store`. Committed `CLAUDE.md`, `docs/`, `seed/`, `progress.md`, `prototype/` as `docs: specs, seed data and build spec (pre-code)`. Created private GitHub repo `swayams13/despl-production-tracker` via `gh repo create --push`, branch `main`. Verified repo root matches exactly: `.gitignore`, `CLAUDE.md`, `docs`, `progress.md`, `prototype`, `seed`. |
| 11 Aug 2026 | Step 2 run: re-confirmed the summarize-back check against BUILD-SPEC-v2 §0 (9 decisions) and §6 (9-step build order) specifically, per the guide's check criteria — no drift from the docs. No code written. |
| 11 Aug 2026 | Step 3 run: scaffolded Next.js 15.5.23 App Router (TS strict, `src/` dir, `@/*` alias, Turbopack) — `create-next-app@latest` defaults to Next 16 now, so pinned to `create-next-app@15`. Scaffolded into a scratch dir (target dir name "DESPL TRACKER" fails npm's package-name rules) and merged in, keeping the existing `.git`/docs/seed. Added Tailwind v4 (bundled), shadcn/ui (`components.json`, `button` primitive), TanStack Query v5.101, Prisma 6.19 (`@prisma/client` + CLI, schema deferred to Step 4), Prettier, Vitest 4 + Testing Library, Playwright 1.62 (chromium installed). Added `typecheck`/`test`/`e2e`/`format` scripts. Created `src/lib/{services,schedule,shared}/README.md` stating each layer's role per CLAUDE.md conventions. Verified: `pnpm lint` and `pnpm typecheck` clean, `pnpm dev` boots and serves 200 on `localhost:3000`. |
| 11 Aug 2026 | Follow-up check on the Next 16→15 pin flagged after Step 3: confirmed no actual drift — `package.json` pins exact `15.5.23` for `next`/`eslint-config-next` and `19.1.0` for `react`/`react-dom`, `pnpm ls` and `pnpm-lock.yaml` show zero `16.x` references, installed binary reports `v15.5.23`, and a clean `pnpm install` produced no peer/deprecation warnings. The Next 16 scratch scaffold was discarded before the 15 version was generated, so it never reached the repo. No fix needed — was informational only. |
| 11 Aug 2026 | Step 4 started, reversed the earlier Railway-for-local-dev call: user decided to install Docker after all and do local dev against it, keeping Railway for the Step 14 deploy target as originally written in the guide (see Decisions log). Installed Docker Desktop (the Homebrew cask needed an interactive `sudo` password the sandboxed shell couldn't supply, so the user ran `brew install --cask docker` themselves). Started `despl-pg` (postgres:16, port 5432, db `despl`) via `docker run`. Wrote `.env` with `DATABASE_URL` (gitignored). Ran `prisma init --datasource-provider postgresql`; it also silently installed ~30 files of Prisma's own AI-agent skill docs into `.claude/skills/`, `.windsurf/skills/`, `.agents/skills/` + `skills-lock.json` — deleted, unrelated vendor bloat. Hit `Error: P1010 User was denied access on the database (not available)` on `prisma db pull` — investigated at length (see Resume point above for full detail and next diagnostic step); not yet resolved. Paused mid-investigation at user's request to save progress for next session. |
| 12 Aug 2026 | Step 4 resumed and resolved. Ran the queued diagnostic: `nc`/`pg_isready` against `localhost` and `127.0.0.1:5432` both succeeded, ruling out Docker networking. A real host `psql -U postgres -d despl` then surfaced the actual cause — `role "postgres" does not exist` — which didn't match the Docker container's role at all. `lsof -iTCP:5432` showed a native Homebrew `postgresql@14` service bound to `127.0.0.1:5432`/`[::1]:5432`, shadowing Docker's wildcard-bound proxy for all loopback traffic; `brew services list` confirmed it running. Stopped it (`brew services stop postgresql@14`); re-verified `lsof` shows only Docker's proxy on 5432, `psql` now reaches the container and returns `1`, `pnpm prisma db pull` connects cleanly (`P4001` empty-DB error, expected), and `pnpm prisma studio` served HTTP 200 on port 5555 against the empty DB. No repo files changed — root cause was host-level, not code. Step 4's guide check is satisfied; next session starts Step 5 (Prisma schema, per BUILD-SPEC-v2 §2). |
| 12 Aug 2026 | Step 5 run: wrote the full Prisma schema (24 models, BUILD-SPEC-v2 §2's Client..AuditLog list) directly against `seed/*.json`'s actual field/enum shapes rather than the diagram's loose prose, so Step 6's importer has real targets — see Resume point above for the specifics and the two invariants (#1, #5) that are schema-flagged but not yet enforceable without a DTO layer / non-superuser DB role. Generated the init migration with `--create-only`, hand-appended a `REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC` statement (documented as currently inert under the local superuser role), then applied it — `\dt` in psql confirms all 24 tables + `_prisma_migrations`. Along the way, a `pnpm install` (run to unblock `pnpm typecheck`, which was failing on a stale dep-status check) wiped `node_modules` and then hit pnpm 11's `minimumReleaseAge` supply-chain policy on a same-day-published transitive dep, blocking every subsequent `pnpm run` too. Asked the user before touching policy; fixed by setting `minimumReleaseAge: 0` in `pnpm-workspace.yaml` (pnpm 11 moved this out of `.npmrc` — a `.npmrc` attempt was silently ignored) and resolving the file's pre-existing `allowBuilds` placeholders to `true`. `pnpm typecheck` and `pnpm lint` both clean afterward. |
| 12 Aug 2026 | Step 6 run as a 4-phase dynamic workflow rather than a single linear implementation: 4 parallel read-only agents each mapped one `seed/*.json` file to its target Prisma models (field-by-field, including which `seed/data-issues.json` entries apply to records in that file); a merge pass cross-checked the 4 maps against each other and `schema.prisma` for shared-entity consistency and produced one ordered implementation plan; a single agent wrote `prisma/seed.ts` from that plan; a verify pass ran `pnpm db:seed` and checked row counts. Independently re-verified the claimed counts myself via `docker exec despl-pg psql` rather than trusting the report — all matched (13 departments, 36 processes, 39 edges, DE0463×20 BOM items, DE0467×34, `Job`/`Equipment`/`BomItem.remarks` carrying the real `data-issues.json` note text). Read the full `seed/seed.ts` diff too — confirmed no fabricated data (`Client.name` is an explicit "pending DESPL confirmation" placeholder, not an invented company name) and that all 12 data-issues entries are surfaced somewhere (row remarks or code comments), none silently dropped. Found and kept two non-bugs: the guide's "54 QcpItem rows" check undercounts against the table's 62 (54 CHECKPOINT + 8 SECTION headers, both stored in one table — data is correct, guide checklist line is imprecise); and `db:seed` is `createMany`-only so reseeding a non-empty DB needs `pnpm prisma migrate reset`, not a bare rerun — confirmed with the user this is fine as-is (no upsert logic added). Added `tsx` as a devDependency (neither `tsx` nor `ts-node` existed) and wired `package.json`'s `db:seed` script + `prisma.seed` config. Committed as `feat: seed data import`. |
| 12 Aug 2026 | Housekeeping: local `main` was 3 commits ahead of `origin/main` (db connection fix, Prisma schema, seed data import), unpushed since Step 4. `git push origin main` failed with `Repository not found` / auth failure even though `gh auth status` and `gh repo view` both worked as `swayams13` — root cause was `credential.helper=osxkeychain` holding a stale/mismatched macOS keychain entry (two `gh`-authenticated accounts exist locally, `swayams13` and `swayamsinghbtech2024-cpu`). Fixed with `gh auth setup-git`, which repoints git's GitHub auth at the correct `gh` token; push then succeeded (`fa8255b..cf3f83f`). No code changes. |

## Blockers

_None blocking the build._ Twelve open questions (C1–C12 in BUILD-SPEC-v2 §7) each have a working default in place. **C1 — whether the lead-time table's "Days" are working or calendar days — is the highest-impact one**: it changes every computed date, and changes the DE0467 shortfall from ~26 days to ~6 days.

## Findings to raise with DESPL

1. **DE0467 was committed on a timeline shorter than DESPL's own standard lead time** (PO 24 Jun → dispatch 15 Oct = 97 working days vs 119 minimum). Best single demonstration of the tracker's value.
2. **Per DESPL's own table, 17 weeks is both the minimum and the maximum** — rows 35–36 print a single value. There is no documented "fast" case.
3. **12 data issues** in the live trackers — see `seed/data-issues.json` (job number mismatch, lost sub-assembly labels, misused Material Identification column, ambiguous dates, no planned dates, no owners).
