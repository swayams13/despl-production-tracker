# PLAN — Personal Dashboards, Employee Accounts & Admin (v1)

**Companion to:** SPEC-personal-dashboards-v1.md (the contract — read it first, every session).
**Branch:** `demo` only. Never push/merge to `main` without explicit user approval.
**Session discipline:** one phase per Claude Code session · end every session with tests green (`RUN_DB_TESTS=1 pnpm test` twice, rerun-safe), `pnpm typecheck && pnpm lint && pnpm build` clean, a browser click-test of what was built, and a progress.md update. Do not advance with a failing check.

---

## Global constraints (apply to every task)

1. Rules live in `lib/services/` — server actions stay thin (`requireActor → service → catch AppError → {ok,code,message} + revalidatePath`). Actions never re-implement a gate.
2. Invariants #1–#12 (CLAUDE.md) all apply. Named here because this build touches them directly: #1 server clock only, #5 same-tx audit on every mutation, #6 no destructive edits (users deactivate, never delete), #3 maker–checker untouched.
3. **D16:** assignment never influences gating. `process.service` must not read `assigneeUserId` for any gate decision.
4. Every new zod schema `.strict()`. No raw enums / table names / dev commentary in rendered UI (hard bans — grep before commit).
5. UI uses the existing industrial tokens/primitives (`.theme-industrial`, StatusChip, KpiTile, DataGrid, StageSheet). Pixel references: artifacts `despl-hybrid-workspace`, `despl-office-command-center`, `despl-personal-dashboards`.
6. Table-driven violation-case tests for every new rule path — not just happy paths.

## File structure (target)

```
prisma/migrations/<n>_person_grain/        # P1
lib/services/assignment.service.ts          # P1 (NEW)
lib/services/admin.service.ts               # P4 (extend)
lib/reads/myday.read.ts                     # P2 (NEW)
src/app/actions/assignment.ts               # P1 (NEW, thin)
src/app/actions/admin.ts                    # P4 (extend)
src/app/(app)/my-day/page.tsx + _client.tsx # P2 (NEW)
src/app/account/password/page.tsx           # P4-lite, built in P1 (interstitial)
src/app/(app)/command/[dept]/page.tsx       # P3 (NEW)
src/app/(app)/admin/…                       # P4 (extend Employees tab)
src/app/page.tsx                            # P2 (router extension)
```

---

## Phase 1 — Person grain + assignment service (backend; hard dependency for everything)

### Task 1.1 — Schema
- Read `schema.prisma` first; adapt to existing `User` fields (map, don't duplicate `name`/`email`).
- Add `User.username @unique` (backfill from email in the migration), `employeeCode? @unique`, `active @default(true)`, `mustChangePassword @default(true)` (backfill existing users to `false` — they have working passwords).
- Add `ProcessPlan.assigneeUserId?` + relation + `@@index([assigneeUserId, status])`.
- Migration is additive only; run against dev DB; verify seeded logins still work.

### Task 1.2 — `assignment.service.ts`
- `claimPlan / assignPlan / releasePlan` per SPEC §5.1, with the exact error codes. Register codes in `ERROR_CODES` + human sentences in `ERROR_MESSAGES`.
- Domain events `PLAN_CLAIMED / PLAN_ASSIGNED / PLAN_RELEASED`; audit rows with before→after in the same transaction.

### Task 1.3 — First-login password change
- `changeOwnPassword` in the auth module (verify current → set next → clear flag → invalidate other sessions).
- `/account/password` interstitial page + middleware/layout guard: `mustChangePassword` users can reach nothing else.

### Task 1.4 — Tests (gate to Phase 2)
- Table-driven: all §10 assignment cases; D16 gate-independence cases; password-change flow; migration backfill assertions.
- **Gate:** DB suite green twice · existing 340 tests untouched-green · typecheck/lint/build clean.

## Phase 2 — Landing router + /my-day (the personal dashboard)

### Task 2.1 — `myday.read.ts`
- Exact output shape from SPEC §6.1. Reuse the prioritizer for ranking (import, don't reimplement). Partition mine/pool/teamHeld must be provably exhaustive and disjoint (test with a fixture set).
- Scoreboard formulas = the same shared queries the dept KPIs use, filtered to assignee (SQL-view rule).

### Task 2.2 — Router
- Extend `page.tsx`: SUPERVISOR/QC → `/my-day`; keep management tier → `/dashboard`; interstitial precedence first; inactive → refused at login with uniform message.

### Task 2.3 — `/my-day` page
- Sections and behaviors per SPEC §7.2, pixel reference `despl-hybrid-workspace` artifact (inbox variant) + personal scoreboard strip.
- KPI tabs are client-side filters over one payload (no per-tab refetch). Inline actions call existing process/delay/qcp actions + new assignment actions; every refusal renders inline (code + sentence). Claim button optimistic-updates then revalidates.
- QC flavor: for QC-role actors the "With QC" tab is first and shows the verify queue (reuse existing QC read).
- Mobile-responsive; light+dark verified.

### Task 2.4 — Verify (gate)
- Browser: log in as a supervisor → land /my-day → claim from pool → Start → Submit → log in as QC → verify (maker–checker refusal if same user) → both dashboards reflect. Counts on /my-day == workspace counts (assert in a test via shared read).

## Phase 3 — Office Command Center pages

### Task 3.1 — `/command/[dept]`
- Valid dept slugs: the six office departments; floor slugs redirect to `/workspace`. Access: members of the dept + PH/ADMIN/MANAGEMENT (read-only for MANAGEMENT).
- Five sections per SPEC §7.4, pixel reference `despl-office-command-center` artifact. **v1 binds to ProcessPlan-grain reads only** — pipeline columns map plan states into the dept vocabulary via a per-dept config object (label maps live in one file, easy for DESPL to correct — same pattern as decision #6 "drafted by us, corrected by DESPL").
- "Decide today" = top-5 dept items (prioritizer order), viewer's own items first. "You're blocking / Waiting on" from DAG edges (same queries as workspace gating messages).
- Add "Command Center" link to /my-day header for office-dept actors.

### Task 3.2 — Verify (gate)
- All six dept pages render non-empty on seed data; KPI numbers match /departments/[id] and /dashboard exactly (shared views); management sees zero action buttons; light+dark.

## Phase 4 — Admin employee management + notifications

### Task 4.1 — `admin.service` extensions
- `createEmployee` (temp-password generator: 3 random words + 2 digits, crypto-random; returned once), `setUserActive`, `updateUserRolesDepts`, `bulkImportEmployees` per SPEC §5.2. Extend `resetPassword` to set `mustChangePassword` + return generated password.
- Guard rails: no self-deactivate, no self-demote from ADMIN; deactivation invalidates sessions.

### Task 4.2 — /admin Employees tab
- Table, Add-employee dialog, credential slip (A6 print CSS), bulk CSV import with per-row report + one-time result download — per SPEC §7.3. MANAGEMENT read-only (buttons absent, not disabled).

### Task 4.3 — Assignee-first notifications
- Recipient resolution: `assignee ?? dept supervisors` for T-3/T-0/T+1; "You were assigned…" notification on assign/claim-by-supervisor. Escalation tiers unchanged. Extend §9.8 tests.

### Task 4.4 — Full verification pass (release gate)
- The §10 browser scenario end-to-end, including: create employee → print slip → second browser first login → forced change → /my-day → work loop → reflection on Command Center + /dashboard.
- Grep pass for hard bans on all new files. Full suite twice. progress.md updated with the session log.

---

## Session prompts (copy-paste to Claude Code, one per session)

> **Session A (P1):** Read CLAUDE.md, docs/SPEC-personal-dashboards-v1.md and docs/PLAN-personal-dashboards-v1.md. Implement Phase 1 exactly (Tasks 1.1–1.4): person-grain schema migration, assignment.service with the specified error codes and audited mutations, first-login password-change flow. Do not touch gating logic in process.service (decision D16). Table-driven violation tests for every rule path. Gate: RUN_DB_TESTS=1 pnpm test green twice, typecheck/lint/build clean, existing tests untouched-green. Commit to demo. Update progress.md.

> **Session B (P2):** Read the same three docs plus the artifact reference notes in SPEC §7.2. Implement Phase 2 (Tasks 2.1–2.4): myday.read.ts (reuse the prioritizer — do not reimplement ranking), landing router extension, /my-day page with mine/pool/teamHeld sections, KPI filter tabs, inline actions and claim/assign. Pixel reference: the approved hybrid-workspace design (inbox + personal scoreboard). Browser-verify the full claim→start→submit→QC-verify loop as two different users. Commit to demo. Update progress.md.

> **Session C (P3):** Same docs. Implement Phase 3: /command/[dept] for the six office departments per SPEC §7.4 — five sections, dept vocabulary via one config file, ProcessPlan-grain reads only (do not invent new tables). Numbers must come from the same shared views as /departments and /dashboard. Verify all six pages on seed data in light and dark. Commit to demo. Update progress.md.

> **Session D (P4):** Same docs. Implement Phase 4: admin.service extensions, /admin Employees tab with credential slip printing and CSV bulk import, assignee-first notification targeting. Run the full release-gate scenario from PLAN Task 4.4 in a real browser and record it in progress.md. Commit to demo. Do not merge to main.

---

## Acceptance summary (what "done" means for the whole build)

1. Admin creates an employee and hands them a printed slip; that employee logs in within a minute, is forced to set a password, and lands on a dashboard that shows **their** work first.
2. They claim, start, complete and submit from that one page; a QC user verifies from theirs; every step appears in the activity feed, the department Command Center, and /dashboard without any refresh-order dependency.
3. Nothing about gating, maker–checker, hold points or delay-blocking changed behavior — proven by the untouched existing test suite staying green.
4. Every new mutation has an audit row; no raw enums or dev text anywhere in the UI; light and dark both clean.
