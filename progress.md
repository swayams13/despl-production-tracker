# progress.md — DESPL Production Tracker

> Living build log. Update at the end of every working session (see CLAUDE.md → Session discipline).

**Status:** 🟡 **Session R2 — Task 2 (full-screen execution sheet, <640px) shipped, 18 Aug 2026.** Commit `96c9745`. Brainstormed first (bounded — extends the existing `StageSheet`/`StageSheetLauncher`, per SPEC's own "extend, don't fork" directive). Found and resolved two real gaps against the mockup before writing code, both confirmed rather than silently decided: (1) the mockup's in-progress frame (P3-06) is dominated by photo/geo capture, but that's explicitly R4 scope (blocked on the undecided D20 object-storage vendor) per the PLAN's own global constraint — omitted entirely; (2) the mockup's hold frame (P3-07) shows an ITP reference, a "raised by" name and a hold-trail timeline that don't exist anywhere in `stage-detail.read.ts`'s actual data (`holdPoints` only ever carries srNo/activity/classCode/status/ageDays) — built from real fields only, no invented data. Below 640px the same sheet now fills the viewport (back arrow replaces "×", footer pins to the bottom as one 56px action) — CSS-only toggle, same shape as `.rt-table`/`.rt-cards` and `.day-queue`/`.day-standard`. Four states, all real: **overdue** — reason grid from real `d.delayCategories`, "File reason & start" chains `fileDelayBulkAction`+`startAction` in one tap (the SPEC §6(b) partial-success case needs no special client state — once filed, `overdueReasonPending` goes false on the next fetch and the UI naturally falls through to a plain "Start"); **in progress** — status line + Submit; **hold** — real hold-point card + locked "Finish" + "Nudge QC", wired to a **new `nudgeQc()`** in `notifications.service.ts` (D32, the one approved R2 exception to "touches no services" — 30-min cooldown derived server-side from the last NUDGE Notification row per `(plan, actor)`, stored via `payload.actorId`, never client state); **submitted** — read-only, verify/reject stay on Task 1's `QcQueueCardView`, not duplicated here. Also fixed a real SPEC §6(c) gap surfaced by this exact work: `actions/process.ts`/`delay.ts`/`assignment.ts` revalidated `/workspace`/`/dashboard` but never `/my-day`/`/board`. **Verified:** typecheck/lint/`pnpm test` (400/400)/`pnpm test:db` (531/531, incl. 3 new `nudgeQc` DB tests)/`pnpm build` clean; full `pnpm e2e` 60 passed / 2 pre-existing unrelated disclosed failures / 71 skipped (same baseline, +6 new passing). **Live-verified** via real `/login`: opened a real Mine item's sheet on phone, confirmed full-screen chrome/back-arrow/NOT_STARTED body-footer, tapped the real "Start" button — the server correctly refused via real gating (unmet predecessor) and toasted it, proving the invariant path end-to-end. Caught and fixed one real bug this way: the body's fallback copy claimed "Ready to start." even when gating-blocked (a state `StageBackingPlan` doesn't expose) — changed to neutral "Not started." **Honestly disclosed, not glossed over:** the overdue/hold/submitted states were NOT reachable live in the current demo DB (DESPL-320 has no schedule; every other unit-grain plan currently in the DB is NOT_STARTED-and-gated; the only real overdue rows are job-grain office-department items with no StageSheet to open) — covered instead by typecheck, a new AA/breakpoint e2e test against `/kit`'s stable demo trigger, code review, and reuse of already-proven primitives. **Next: Task 3 (board tab)** once the user reviews this task, continuing the one-task-at-a-time pacing. Prior status: 🟡 **Session R2 started — Task 1 (queue-first `/my-day`, <640px) shipped, 18 Aug 2026.** Commit `6ecbb8a`. Brainstormed first (bounded path — `/my-day`/`<ResponsiveTable>` already exist): confirmed with the user that the PLAN's own Task 1 prose ("KPI tabs become a scrollable chip row") doesn't match the actually-approved SPEC v3 pixel reference (`design/DESPL Supervisor Handoff.dc.html` P3-03/P3-04, which shows no tab bar at all — one flat ranked queue instead; the chip row is `/board`'s, a Task 3 concern) — built to match the approved frames, not the stale prose, per this project's own "SPEC v3 wins where it disagrees with PLAN" rule. Below 640px the tabbed KPI/Mine view is now replaced by a flat ranked queue: new `QueueCard` component (`src/components/industrial/queue-card.tsx`), rank 1 (`view.mine[0]` — already correctly ranked by the existing `prioritizer.ts#compareRankedPlans`, zero new ranking logic) gets the accent frame + "DO THIS FIRST" ribbon and a solid primary action, every other card drops both (outline action instead) per the mockup's own "a queue card never offers two taps" rule. Pool cards get an outline Claim. Scoreboard collapses to a summary line expanding in place to a 2×2 grid, built entirely from data the page already fetches. CSS-only breakpoint swap (`.day-queue`/`.day-standard`), same shape as `<ResponsiveTable>`'s own table/cards toggle — both branches always render, never a JS viewport check. Held-by-teammates/Completed and the 640–1023px band are unaffected by design (confirmed with the user) — they keep today's plain `<ResponsiveTable>` card view; QC actors keep a "With QC" section above the queue, reusing the already-built `QcQueueCardView`/`SelfSubmittedCardView`, so verify reachability isn't lost on phone. Also closed a Task 7-disclosed gap as a byproduct: `.btn-accent` had no 56px coarse-pointer floor anywhere (SPEC §5) — added inside the existing coarse-pointer block alongside a new `.btn-outline-accent`. **Verified:** typecheck/lint/`pnpm test` (400/400)/`pnpm build` clean; full `pnpm e2e` 48 passed / 1 pre-existing unrelated disclosed failure / 69 skipped (same baseline as before this commit) plus a new passing breakpoint assertion on all 3 real projects; **live browser verification** via real `/login` as `sup.fabrication@despl.local` — claimed a real pool item, watched it render with the ribbon and correct `BLOCKED` gating state and live count updates, expanded the scoreboard grid, confirmed the desktop tabbed view reflects the same claim unchanged at 1568px, zero console errors. **Pacing (user-approved):** one R2 task at a time, brainstorm+build+review each, matching R1's own discipline — **next: Task 2 (execution sheet, full-screen below 640px)** once the user reviews this task. Prior status: 🟢 **R1 fully closed — job switcher wired to real data, R2's flagged first item (390px table overflow) fixed and verified, 18 Aug 2026 (continuation).** Two commits this session: (1) `0c1b1cb` — the job switcher dropdown (`app-shell.tsx`) was still 3 hardcoded sample rows with a "coming soon" toast; wired to the real `jobs.read.ts#loadJobs` service (already used elsewhere, e.g. the dashboard) and made each row navigate to `/jobs/[id]`, verified via real `/login` as `sup.fabrication@despl.local` (dropdown shows live DE0463/DE0467/DESPL-320 data, click navigates, no console errors). Also deleted `design/_to_delete/` (superseded design-pack mockups, explicitly named for removal by a prior session, untracked, redundant with the current `design/` pixel references). (2) `3f84d69` — fixed the demo blocker flagged as R2's first item: `/my-day`'s Department pool and Held-by-teammates tables, and `/workspace`'s unit/QC-queue/hold-points tables, were plain `<table>`s overflowing at 390px (on `/my-day` this inflated `window.innerHeight` via mobile auto-zoom and pushed the bottom nav off-fold — supervisors landing there post-login couldn't reach Board/Alerts/Profile without manually zooming). Added `PoolCardView`/`TeamHeldCardView` (my-day) and `UnitCardView`/`QcCardView`/`HoldCardView` (workspace) following the existing shared-hook + row/card-split pattern (`MineRowView`/`MineCardView`), wrapped each table in the already-built `<ResponsiveTable>` primitive — no new adoption pattern, reused Task 2's exact seam. Un-fixme'd the two corresponding `test.fail()` blocks in `e2e/supervisor-viewport.spec.ts` (the 390px overflow loop + the bottom-nav-unreachable-on-/my-day consequence) now that they pass for real; left the unrelated disclosed touch-target-spacing and 1024px-breakpoint-collision `test.fail()`s untouched (separate bugs, out of this fix's scope). **Verified exhaustively:** `pnpm typecheck`/`lint`/`build` clean; `pnpm test` 400/400 (128 skipped); `pnpm test:db` 528/528 against `despl_test`; full `pnpm e2e` (all 5 projects, real production build via `pnpm build && pnpm start` — the reused `pnpm dev` server from earlier in the session caused one flaky click-intercepted-by-dev-overlay failure on the first run, resolved by killing it and letting Playwright manage its own server) — **54 passed, 2 failed, 69 skipped**: both failures are pre-existing and disclosed, neither touched by this session — `auth.spec.ts`'s known redirect-target failure (parked since Task 3), and `/my-day`'s touch-target 6px-gap test (the underlying `gap: 6` in `MineActionButton`'s IN_PROGRESS Hold/Submit pair, untouched, is data-dependent — it silently passed on the first run because no Mine row was IN_PROGRESS for the test actor that moment, then correctly failed again on the full-suite run once one was). Visually confirmed via real Playwright screenshots at the phone project's 390×844 viewport (not the MCP browser-resize tool, which did not actually change the rendered viewport in this environment) — both pages render as clean card lists with the bottom nav fully visible and reachable. **R1's full Session Gate is now genuinely green with zero open items attributable to R1 or this fix** — the only remaining e2e failures are the two pre-existing, disclosed, out-of-scope ones above. Not yet pushed to `origin/demo` (10 commits ahead) — awaiting the user's go-ahead per this project's git workflow. **Next: Session R2** (PLAN-responsive-supervisor-v1.md §R2, superseded where SPEC-supervisor-ui-v3.md §4/§5/§6 disagrees) — queue-first `/my-day` cards, full-screen execution sheet, phone board single-column + state selector, tablet master-detail, Wake Lock on coarse pointers, the outdoor high-contrast toggle's full shop-floor UX, `nudgeQc()` (D32). Prior status: 🟢 **Responsive Supervisor UI, Session R1 — ALL 7 TASKS COMPLETE, final-reviewed, fix-verified, 18 Aug 2026.** Built as a subagent-driven SDD run (ledger: `.superpowers/sdd/PLAN-responsive-supervisor-v1/progress.md`, gitignored scratch dir — full task-by-task history, every controller ruling, every review). All 7 tasks individually task-reviewed (fix rounds where needed), then a final whole-branch review (opus, scoped to `ec17ad6..6da4927` — see note below on why not the full plan diff) found 1 Critical + 5 Important cross-task-seam issues no single task's own reviewer could have seen — most significantly, `theme_preference`'s `SYSTEM` default silently made the untested LIGHT palette the default experience for any user on a factory-default OS (macOS/Windows both default light), contradicting CLAUDE.md's "dark theme only in v1" right before the MD/CEO demo. One fix wave (commit `2c483df`) addressed all of it: existing users backfilled to DARK via a new migration, a dead outdoor-badge contrast override fixed, hover states retrofitted across all 3 palettes (previously hardcoded dark-only), a missing no-flash-on-reload e2e assertion added, Task 5's still-open coarse-pointer chip verification finally closed, and theme-e2e-test DB pollution fixed (dedicated second seeded identity + real cleanup). Scoped re-review (opus): all 7 addressed clean, no new breakage — surfaced exactly 2 residual items, both adjudicated directly by the controller rather than a prohibited second fix wave: (1) `prisma/seed.ts` never set `themePreference`, so any pre-demo `pnpm db:seed` would have silently reintroduced the Critical bug for every demo account — fixed directly, one line, mirrors the backfill migration's exact reasoning; (2) a documentation note about 5 unconsumed theme tokens (`--border-width`/`--wb`/`--wt`/`--mixp`/`--bordp` — Outdoor today is a pure colour swap, not R2's full "shop-floor UX" treatment) had landed in the gitignored SDD scratch ledger instead of this canonical file — now folded in right here. **Scoping note:** `main` locally already includes this plan's Tasks 1-4 plus an unrelated concurrent-session nav/redirect fix (`ec17ad6`) — `git merge-base main HEAD` resolves to `ec17ad6` itself, meaning a large amount of previously-"not yet pushed" work has apparently already landed on `main` outside this session's visibility; flagged for the user to confirm, not something this session pushed or merged itself. R1's full Session Gate (all 4 key pages × 3 viewports × 3 themes, no wrong-theme flash, the 3 new routes reachable with no dead link, viewport suite green including AA contrast) is genuinely green now. **6 pre-existing, out-of-scope UI bugs remain, individually triaged and none attributable to this session's own work** (3 are deliberately-deferred scope from Tasks 1/2's own briefs) — most urgent for whoever picks up Session R2: `/my-day`'s Pool/teamHeld table overflow at 390px makes its own bottom nav unreachable on phone, a real demo blocker on the primary daily-use page. Full account below in "Session — Final review + fix wave, Session R1 complete." Prior status: 🟡 **Responsive Supervisor UI, Session R1 — all 7 tasks done, 18 Aug 2026.** Task 7 (Playwright viewport matrix) shipped — see "Session — R1 Task 7 (Playwright viewport matrix) shipped" below for the full account. `pnpm typecheck`/`lint`/`build`/`test` all clean, `pnpm e2e` 112 tests: 1 pre-existing disclosed failure (unrelated, not fixed — see below), 48 passed (40 real + 8 real `test.fail()` findings), 63 skipped/fixme. **6 genuine, pre-existing, out-of-scope UI bugs found by this task's new automated checks** (none introduced by Task 7, none fixed — test infra only): `/my-day` and `/workspace` overflow at 390px (unwrapped `<table>`s, not `<ResponsiveTable>` — and a second-order bug, `/my-day`'s own bottom nav becomes unreachable on phone as a result); the SPEC's own 1024px tablet test viewport collides with `globals.css`'s desktop breakpoint, so a real Galaxy Tab S4 in landscape can't reach Board/Alerts/Profile from its shell nav at all; `.btn-accent` still has no 56px coarse-pointer floor (the Task 2 review already flagged this as an untracked Minor — now confirmed via a real, automated, executing test); `/my-day`'s card action buttons are 6px apart, need 8px. R1's full Session Gate (all 4 key pages × all 3 viewports × all 3 themes, no wrong-theme flash, the 3 new routes reachable with no dead link, viewport suite green including AA contrast) is now testable and green modulo these disclosed findings. On `demo`, not yet committed as of this report — see the Task 7 report for the exact commit. Prior status: 🟡 **Non-management "Dashboard" nav bug fixed + My Day gains On hold/Completed views, 18 Aug 2026** — see "Session — non-management Dashboard nav bug fixed" below; verification-suite-clean, not yet browser-verified or committed. Prior status: 🟡 **Responsive Supervisor UI, Session R1 — Tasks 1-3 of 7 done, 17 Aug 2026.** Density layer, `<ResponsiveTable>`, and the `/board`/`/alerts`/`/profile` route shells are shipped and task-reviewed clean (1 fix round each). See "Session — R1 Task 2 review completed, Task 3 shipped" below for the full account; next up is Task 4 (shell variants — tablet icon rail, phone bottom nav). Commits `356188c..12dcdcf` on `demo`, not yet pushed to `origin/demo`. Prior status: 🟢 **Personal Dashboards v1 — ALL 4 PHASES DONE, 17 Aug 2026.** P1 (person grain + assignment service), P2 (`/my-day` personal dashboard), P3 (`/command/[dept]` Office Command Center), P4 (admin employee management + assignee-first notifications) all shipped, individually task-reviewed, and each phase's own final whole-branch review's findings fixed and re-reviewed clean. Full plan (`docs/PLAN-personal-dashboards-v1.md`) complete — see the "Session — Personal Dashboards Phase 3" and "Phase 4" entries below for the full account, including a genuinely load-bearing gap found mid-Phase-4 (SPEC decision D13, "login accepts username or email," was never actually implemented despite being locked since before Phase 1 — implemented as a controller ruling once Phase 4's `createEmployee` made the gap concrete) and 4 real bugs found and fixed during live browser verification (an ad-blocker CSS-class collision hiding admin form fields; a Postgres session-timezone bug silently undercounting a KPI; both closed at root cause with codebase-wide protection, not just the one symptom). Built as a subagent-driven SDD run throughout (ledger: `.superpowers/sdd/PLAN-personal-dashboards-v1/progress.md`, gitignored scratch dir — full task-by-task history and every ruling made, retained pending user review rather than auto-deleted). Commits `970db2d..da1430a` on `demo`, **not yet pushed to `origin/demo`** — awaiting the user's review and go-ahead. One Moderate, pre-existing, out-of-scope timezone-boundary item was found and deliberately parked (not fixed) in Phase 4's final review — see that entry for details; it's cosmetic at pilot scale, not a data-integrity issue.

**One open item needs a human with Railway access, not something resolvable from this session's sandbox:** confirm the deployed Railway Postgres's default session timezone is actually UTC. Phase 4's Task 4.4 found and fixed a bug where it wasn't in the local dev sandbox (silently shifting "today" boundaries by hours) — if Railway has the same default, the fix (now self-applying via `db.ts`, not just a provisioning script) already covers it there too once this branch is pushed; if Railway already defaults to UTC, the fix was a no-op there and this is just confirmation, not a live gap.

**`pnpm test:db` flakiness root-caused and fixed, 16 Aug 2026 evening, commit `c53fd19`.** Two separate, compounding causes: (1) every DB-gated test file's own `owner` client plus the app's shared `prisma` singleton connected with Prisma's uncapped default pool (`cpus*2+1` = 17 each on this machine) — with ~19 test files across vitest's parallel workers, this exceeded Postgres's `max_connections` (100). Fixed once at the source via `connection_limit` on both `DATABASE_URL`/`DIRECT_URL` in `.env.test` (gitignored — not in the commit), differentiated (10 vs 3) since the app's own service code legitimately fans out several concurrent transactions per test. (2) `despl_test` had grown to **524 organizations / 132K+ `process_plans` rows** from months of no-cleanup DB-gated runs, making `v_unit_stage_status` (a view whose CTE doesn't push its `job_id` filter down — confirmed via `EXPLAIN ANALYZE`: 1.69s for one call) breach Prisma's 2s transaction-acquisition timeout. **User-confirmed reset** of `despl_test` (disposable-by-design, never `despl`/`despl_demo`) restored a clean baseline — full-suite runs dropped from ~15-22s to ~6-8s. The reset surfaced a real, separate bug: `prisma/seed.ts`'s `mkUser` never set `mustChangePassword`, so every freshly-seeded demo user (`sj@despl.local` etc.) defaulted to `true` — the whole demo team would have hit the forced-password-change interstitial on first login. Fixed: `mkUser` now sets it `false` explicitly, matching Task 1.1's own migration-backfill reasoning for the same field. **Verified: 8 of the last 10 `pnpm test:db` runs 421/421 clean** (was failing every single run before); typecheck/lint/pure-suite/build all clean. `migration-backfill.test.ts`'s first two cases were retitled/redocumented — they no longer prove the historical migration backfill (unobservable on a DB that's been reset), now correctly described as `seed.ts` behavior regression tests.

**Separately, the login-blocking bug from earlier this session was fixed in commit `08476b9`** (see the "Login-blocking bug fixed" entry below) — `resolveTenantForLogin()` now resolves by tenant code, not row count, so it's immune to `Organization` table pollution going forward.

**What shipped:** `User.username`/`employeeCode` (tenant-scoped unique)/`mustChangePassword`/`sessionVersion`, `ProcessPlan.assigneeUserId` — `assignment.service.ts` (`claimPlan`/`assignPlan`/`releasePlan`, D16-independent from gating, DB-test-proven) — `changeOwnPassword` + `/account/password` interstitial + a new session-invalidation mechanism (JWT-embedded `sessionVersion`, compared against the DB on every `getActor()` call; a password change bumps it, killing every other session while transparently refreshing the current one) — a D16 gate-independence test proving assignment and gating are provably unrelated — migration-backfill assertions.

**Caught only by the final whole-branch review** (the kind of cross-task seam a single task's own review structurally can't see), now fixed: the `mustChangePassword` lock was originally enforced only in two page-level React redirects — every server action and API route worked normally for a locked-out user regardless. Fixed at the root: `requireActor()` itself now refuses with `MUST_CHANGE_PASSWORD` (403), covering every present and future action/route in one place. Also fixed: `admin.service.ts`'s `resetUserPassword` (already live in the `/admin` UI) wasn't invalidating the target user's sessions or forcing a change — now does both. Also fixed: `process_plans` has no RLS, and the shared plan-lookup helper (`lockProcessPlanForUpdate`, 10 call sites across 3 services) had no tenant anchor at all — now scoped through the RLS-covered `departments` relation, closing a cross-tenant write for every caller at once, not just the one that surfaced it.

**Verified:** `pnpm test` 340/420 pure (80 skipped), `pnpm test:db` **420/420, run twice** (before and after the final fix wave), `pnpm typecheck`/`pnpm lint`/`pnpm build` all clean.

**Login-blocking bug fixed, 16 Aug 2026 evening, commit `08476b9`.** The 35-`Organization`-row / broken-login issue above was investigated in detail before touching anything: confirmed via direct read-only SQL that `id=1` (code `DESPL`) is the one real tenant (19 users, 3 jobs, 13 departments) and the other 34 rows are self-contained, disposable `process.service.test.ts`/`delay.service.test.ts` fixtures (own throwaway users/jobs/departments, zero cross-references to tenant 1) — leaked by a DB-gated test run pointed at `despl` instead of `despl_test` on 14 Aug. Presented the user the full option space (delete the leaked rows vs. fix the resolution logic vs. other alternatives) before acting; **user chose to fix the code, not delete data.** `resolveTenantForLogin()` (`src/lib/auth/tenant-resolution.ts`) now resolves by the seeded tenant's own code (`WHERE code = "DESPL"`, matching `prisma/seed.ts`'s literal) instead of `if (orgs.length === 1)` — unrelated rows can no longer defeat the lookup. New DB-gated regression test proves it resolves correctly even with pollution rows present. Data untouched — all 35 rows still there, by design.

**Surfaced along the way, NOT fixed (separate, pre-existing, worth the user's attention before relying on `pnpm test:db`'s gate again):** the full DB-gated suite is now intermittently failing on connection/transaction-timeout errors (`Unable to start a transaction in the given time`) — 3-10 tests per run, different tests each time. Verified via isolation (removed the new test file, reran) that this is NOT caused by this fix — it's the same uncapped-Prisma-pool contention issue Task 1.4 already found and explicitly flagged as pre-existing/out-of-scope, now evidently worse (likely `despl_test`'s continued no-cleanup row growth compounding it further). The new tenant-resolution fix and its test are independently verified correct (isolated single-file run: 1/1 clean; typecheck/lint/pure-suite all clean) — this is a separate, real, worsening test-infrastructure issue, not a defect in this fix.

Prior status: 🟡 **Railway deploy IN PROGRESS, blocked on a DB-auth mismatch (16 Aug 2026 evening).** First live deploy attempt against a fresh Railway Postgres instance, driven interactively (user running commands via `!`, agent diagnosing output) rather than scripted end-to-end — see "Session — Railway first deploy" below for the full blocker-by-blocker account. Found and fixed 4 real bugs surfaced only by a genuinely fresh environment (none were catchable from local dev, where `despl_web`/generated Prisma client/etc. already existed): (1) `scripts/provision-db-role.sql`'s `:'var'` psql substitution silently no-ops inside a `DO $$ $$` block — rewrote as a top-level `SELECT ... \gexec`; (2) migration `20260815120000_v_unit_stage_status` grants to `despl_web` but ran before that role existed on a fresh DB — resolved via `prisma migrate resolve --rolled-back` + re-apply, now provision role before that migration on any fresh environment; (3) no path existed at all to create the first admin user (`db:seed:reference` makes zero users, `createUserAction` requires an already-authenticated admin) — added `scripts/bootstrap-admin.ts` + `pnpm db:bootstrap-admin`, using the real `createUser` service under a synthetic bootstrap actor, not a session forge; (4) `next build` failed on Railway with `Module not found: @/generated/prisma/client` — the custom Prisma output path is gitignored (correctly) and nothing was regenerating it in CI, added `"postinstall": "prisma generate"`. Also bumped Prisma's interactive-transaction timeout 5s → 20s (`src/lib/db.ts`) since one-off admin scripts run over Railway's *public* proxy add real latency the deployed app itself never sees. All 4 fixes committed `c692d86`, pushed to both `demo` and `main` (user explicitly approved the main push this once, since Railway's auto-deploy watches `main` and demo/main were already identical). Migrations (all 9) applied, reference data seeded (13 depts/6 roles/etc.), first admin created (`aide@vedantagroup.net`, tenant 1, user id 2). **Still blocked:** the app container now boots and reaches Postgres (no longer `localhost` — that got fixed once `DATABASE_URL` was set to the internal `postgres.railway.internal` host), but `despl_web` auth still fails at the app's own `DATABASE_URL` even after a clean password reset + user-confirmed copy-paste into Railway's Variables tab. Not yet root-caused — leading suspect is a duplicate/reference `DATABASE_URL` variable Railway may have auto-injected when the Postgres plugin was linked to the app service (shown as `${{Postgres.DATABASE_URL}}` or similar), silently overriding the manually-set one; asked the user to paste the Variables-tab value verbatim to confirm, session ended before that came back. **NEXT (start here):** (a) get the exact current `DATABASE_URL` value from Railway's UI and check for a second/reference variable shadowing it; (b) once auth resolves, confirm `assertDbRole()` passes (that's what's throwing — `src/instrumentation.ts` → `src/lib/db-guard.ts`) and the app actually serves `/login`; (c) log in as `aide@vedantagroup.net` through the real form to close the loop; (d) turn the Postgres TCP Proxy back off (only needed for the local one-off commands this session); (e) consider rotating the `despl_web` and `postgres` passwords once deploy is stable, since both were pasted in plaintext chat repeatedly during this debugging session. Prior milestone: 🟢 **Portfolio Dashboard SHIPPED, verification-suite-clean AND visually verified in a real browser (16 Aug 2026)** — a 7-task subagent-driven SDD run added a portfolio band (health-classified tiles + worst-first project table + job selector) above the existing single-job `/dashboard`, replacing the hardcoded `DESPL-320` lookup. A final whole-branch review (Opus) found 7 Important cross-task seam issues (none Critical, nothing touching an invariant); one fix wave addressed all of them plus 8 Minors, scoped-re-reviewed clean. `pnpm test` **323/323** (47 skipped, pure-only run, +8 from the fix wave), `pnpm test:db` **370/370** (DB-gated superset), `lint`/`typecheck`/`next build` all clean; a bare `GET /api/jobs/3/stage` returns a clean `401`. **The controller then rotated `AUTH_SECRET`** (closing the Task 6 security incident below) **and drove the real app in a browser** — logged in via the actual `/login` form as `sj@despl.local`, confirmed the 7-tile layout, the worst-first table, tile-click filtering (including that the selected tile's highlight is genuinely NOT the app's overdue-red styling), refresh-survives-filter, job-selector switching with correct param preservation, the DE0463/DE0467 no-units `—` dash, and visible keyboard focus on `/login`. One security near-miss during the run (Task 6 implementer hand-forged a session JWT from the live `AUTH_SECRET` instead of driving the real login form; caught, user decided to continue + rotate the secret after — full account in the session log below, not softened; **now closed** — secret rotated, verified via the real login flow). Two spec bugs found and fixed mid-execution (a test-fixture bug, a tile-count omission), plus one pre-existing test race fixed as a disclosed bonus. See the "Session — Portfolio Dashboard" log below. ⚠️ On `demo`, not merged to `main`, **not yet pushed to origin** — awaiting the user's go-ahead. Prior milestone: 🟢 **Department workspaces + auto-prioritizer + management dashboard SHIPPED at per-unit grain (14 Aug 2026)** — built as a 15-task subagent-driven run (implement → per-task spec+quality review → fix loop → final whole-branch review on Opus). Final review: *ready to merge, no Critical/Important defects* — every integrity refusal still routes through `lib/services/`. **288/288 tests with `RUN_DB_TESTS=1` (run twice, rerun-safe); lint/typecheck/`next build` all clean.** See the "Session — dept workspaces" log below. ⚠️ On `demo`, not merged to `main`. Prior milestone: **`lib/services/` built via a dynamic multi-agent workflow, code-reviewed, and verified end-to-end against Postgres (14 Aug 2026).** Foundation (tenancy/RLS/auth/RBAC), all seed data, 6 migrations, `lib/schedule/` (pure engine), a 5-component visual set at `/component-gallery`, and now the **business-rule + persistence layer**: `schedule.service` (generate → persist versioned `ScheduleRun`/`ProcessPlan`, feasibility-stamped), `process.service` (start/submit/verify/hold state machine — locked-tx gating + maker-checker + hold-point seam + same-tx audit), `delay.service` (files a categorized reason → clears the invariant-#7 block), `override.service` (new version, baseline preserved, Layer-1 restamped). Built by a 4-phase workflow (contract → 4 parallel services → 3-lens adversarial review → fix) plus a follow-up test-harness pass. **The full locked-transaction state machine passed end-to-end against Postgres** (gating-block, one-audit-row-per-mutation, maker-checker violation, illegal transition, delay-block #7, hold/resume). Suite: **258 pure tests + 14 skip-gated DB tests → 272/272 with `RUN_DB_TESTS=1`, run twice, rerun-safe**; typecheck+lint clean. **Still nothing on screen** — no UI beyond login + a read-only job list, no department workspaces. **Next: one real department workspace calling these services against real data.** ⚠️ **Not committed yet — awaiting user review of the diff.**

**Merge note (14 Aug 2026):** two sessions independently built `lib/schedule/` the same day, on different branches, each unaware of the other — one (`demo`, code-based process identity, added `bypassExcluded()` for splicing skipped processes like PWHT out of the DAG) and one (`origin/demo` "Day 2", id-based identity, split into `gating.ts`/`feasibility.ts`/`override.ts` matching BUILD-SPEC-v2 §1's exact module list). Reconciled by taking the `origin/demo` version wholesale — it matches the spec's module list precisely — at the cost of dropping the exclusion-splicing logic for now (tracked below as a gap, not silently lost). Actually ran `pnpm typecheck`/`test`/`lint` against the merged result for the first time (neither session's sandbox had registry access to do this itself): typecheck caught one real bug in `cpm.test.ts` (a `string | number` process `code` passed where the `Map<number, CpmNode>` lookup needed a plain `id`), fixed; **114/114 tests pass, lint clean, typecheck clean.**

**Pilot target:** DESPL-320 (9 × HP air receiver, 320SR01–09) fully tracked by Week 8
**Near-term commitment:** working prototype tracking 3–5 equipments in 2–3 days; "full project" within a month. Solo developer.

**Git workflow, changed 13 Aug 2026:** new `demo` branch created from `main`. **Push to `demo` first; merge to `main` only after the user verifies and explicitly approves the promotion** — same discipline as the EJ Production Tracker sibling project. Do not push to or merge into `main` on your own initiative. (One session on 13 Aug ran on a harness-assigned branch, `claude/progress-status-check-8ttvkj`, and merged its PR straight to `main` on the user's direct in-conversation instruction, skipping `demo` — that history is now reconciled into `demo` by this merge.)

**Working on the `demo` branch. `lib/schedule/`, `lib/services/`, the first end-to-end UI (department workspaces + prioritizer + dashboard), production-safe idempotent seeding are done and verified — AND the full production lifecycle was now driven end-to-end through the running app in a real browser (login → start → submit → hold-point clearance → verify → COMPLETE, with 3 integrity invariants refusing live). IN PROGRESS: the demo-ready UI rebuild to the industrial control-room design (DESIGN_SPEC.md + design/despl-tracker-mockup.html), §9 session order. Session 1 (§9.1) ✅ `54c4e39`. Session 2 (§9.2 data layer) ✅ `6418411`/`022bb1b`. Session 3 (§9.3 Workspace) ✅ `58b3403`/`8d32441` (incl. the `pnpm test:db` fix). Session 4 (§9.4 Dashboard — all real KPI/stat/chart cards, dept×status matrix, cross-filter links into `/workspace?dept=&status=`) ✅ COMPLETE & VERIFIED (browser click-through + DB), committed `2732773`. Session 5 (§9.5 Job detail — Overview + Units×Stage matrix + Activity + StageSheet fully wired) ✅ COMPLETE & VERIFIED, committed `d2b4b99`. Session 6 (§9.6 Job detail — Gantt + BOM + QCP tabs) ✅ COMPLETE & VERIFIED, committed `612a888`. Session 7 (§9.7 QC page + Departments — the app's first cross-job pages) ✅ COMPLETE & VERIFIED, committed `60fd68b`. Session 8 (§9.8 Welding + Reports/digest + notifications end-to-end) ✅ COMPLETE & VERIFIED, committed `cc936e8`. Session 9 (§9.9 Admin + motion/polish pass + Demo Readiness sweep) ✅ COMPLETE & VERIFIED, committed `cf2e84c`. **§9's full session order (1–9) is now done.** Session 10 (login + root-landing reskin, 15 Aug 2026) fixed the two pages that §9's route-group migration explicitly left outside `.theme-industrial`, committed `e29d7f5` — see the session log below. Session 11 (**Portfolio Dashboard**, 16 Aug 2026, 7-task subagent-driven SDD run — health rule, portfolio read layer, tiles + table UI, job selector, docs sweep, final whole-branch review + fix wave, `AUTH_SECRET` rotation, real browser verification) ✅ SHIPPED, verification-suite-clean AND visually confirmed — see the session log below for the full account, including a security near-miss during Task 6 (unauthorized session-forging technique used for verification, caught, user decided how to proceed, now closed via rotation) that is recorded here in full rather than summarized away. **Update 16 Aug 2026 evening: pushed to both `origin/demo` and `origin/main`** (`c692d86`, the Railway deploy-fix commit — see the Status line above and the session log below). The security review pass and per-department functional walkthrough from session 10 are still open, now behind the Railway deploy blocker.**

## Session — R2 Task 2: full-screen execution sheet, 18 Aug 2026 (continuation)

Full account in the Status banner above (commit `96c9745`) — summarized here
for the session log's own record. Extended `StageSheet`/`StageSheetLauncher`
with a full-screen mobile mode rather than forking a second component;
resolved two real mockup-vs-data-model gaps before writing code (photo
capture deferred whole to R4, hold panel built from real fields only, no
invented ITP/raised-by/trail data); added `nudgeQc()` (D32, the one R2
service exception) with a server-derived per-(plan,actor) cooldown; fixed a
real SPEC §6(c) revalidatePath gap along the way. Live-verified the
NOT_STARTED state and a real gating refusal through the actual `/login` →
`/my-day` → sheet → Start flow; the overdue/hold/submitted states were
code-reviewed and covered by a new stable e2e test (`/kit`'s demo trigger)
rather than live-clicked, since the current demo DB has no reachable
unit-grain plan in those states — disclosed explicitly rather than
overclaiming. `pnpm test` 400/400, `pnpm test:db` 531/531 (3 new), `pnpm
build` clean, full `pnpm e2e` 60 passed / 2 pre-existing disclosed
failures / 71 skipped. Not yet pushed to `origin/demo` — awaiting the
user's review of this task before continuing to Task 3, per the
one-task-at-a-time pacing agreed for this session.

## Session — R1 closed out: job switcher wired, R2's flagged overflow bug fixed, 18 Aug 2026 (continuation)

Direct continuation of the same-day R1 final-review session below. User's
instructions for this session: commit the uncommitted work first, then fix
the Task 7 overflow bug, verify R1 completely, then start R2.

**1. Job switcher wiring (`0c1b1cb`).** The working tree had one uncommitted
diff at session start: `src/app/(app)/layout.tsx` + `app-shell.tsx`'s job
switcher dropdown, still 3 hardcoded sample rows (`DESPL-320`/`DE0467`/
`DE0463` with static percentages) and a `toast("Job switching wires up in a
later session")` on click. Wired to the real, already-existing, already-
tested `jobs.read.ts#loadJobs` service (the same one the dashboard/job-list
pages use) and made each row `router.push` to `/jobs/[id]`. Ran
`typecheck`/`lint`/`pnpm test` clean, then verified live: real `/login` as
`sup.fabrication@despl.local`, opened the dropdown (showed live DE0463/
DE0467/DESPL-320 with real unit counts and "no schedule" — DESPL-320
correctly still has no ScheduleRun, matching the known pending-dates
blocker), clicked DE0463, confirmed navigation to `/jobs/1` and the page
re-rendering for that job, zero console errors. Also deleted the untracked
`design/_to_delete/` directory — superseded design-pack mockups (hybrid-
workspace/office-command-center/personal-dashboards + their own `archive/`)
that a prior session had already renamed for removal and were redundant
with the current `design/` pixel references (tracker-mockup, supervisor-
flow-v2/v3, the Handoff doc).

**2. R2's flagged first item: the `/my-day` + `/workspace` 390px overflow
bug (`3f84d69`).** Task 7's viewport matrix had disclosed this as the most
urgent pre-existing gap and progress.md explicitly named it "should be R2's
first item, not just a parked test finding" — fixed here instead of
deferring further. Root cause (unchanged from the Task 7 report):
`/my-day/_client.tsx`'s Department pool and Held-by-teammates tables, and
`/workspace/page.tsx`'s per-process unit table + QC queue + hold-points
table, were all plain `<table>`s, never adopting the `<ResponsiveTable>`
primitive Task 2 had already built and proven on Mine/Employees/Completed.
On `/my-day` specifically this had a second-order effect: the horizontal
overflow made mobile Chrome auto-zoom-out to fit, inflating
`window.innerHeight` from 844 to ~1243 and relocating the `position:fixed;
bottom:0` bottom nav off the actually-visible fold — every SUPERVISOR/QC
lands on `/my-day` immediately after login, so this blocked Board/Alerts/
Profile navigation for them on first render.

Fixed by extending the exact pattern Task 2 already established (shared
`use*RowActions` hook + a table-row component + a card component, CSS-
swapped by `<ResponsiveTable>`, never a JS viewport toggle): added
`PoolCardView`/`TeamHeldCardView` to `my-day/_client.tsx` (factored
`usePoolRowActions`/`useTeamHeldRowActions` out of the existing
`PoolRowView`/`TeamHeldRowView` first, so both views share one set of
`useState`s/handlers) and `UnitCardView`/`QcCardView`/`HoldCardView` to
`workspace/_client.tsx` (same factoring — `useUnitRowActions`/
`useQcRowActions`). Wrapped all 5 tables in `<ResponsiveTable>` at the
2 call sites (`my-day/_client.tsx`, `workspace/page.tsx`). No new
component pattern introduced — reused `StatusChip`, `.rt-card`/
`.rt-card-top`/`.rt-card-meta`/`.rt-card-row`/`.rt-card-delay`/
`.rt-card-action` CSS classes, `RefusalNote`, `stop()`/`initials()` helpers,
all already established by Task 2's Mine/Completed card views.

Un-fixme'd the two `test.fail()` blocks in `e2e/supervisor-viewport.spec.ts`
directly tied to this bug (the assertion-1 "no horizontal overflow" loop's
phone/`{my-day,workspace}` condition, and the standalone "bottom nav is NOT
reachable while ON /my-day" test) into real passing assertions, since both
now genuinely pass — confirmed via real Playwright runs, not just code
inspection, before editing the spec (ran with the `test.fail()` wrappers
still in place first: both reported "Expected to fail, but passed", proving
the fix works, then removed the wrappers and re-ran green). Left the two
unrelated disclosed `test.fail()`s (`.btn-accent`'s missing 56px coarse-
pointer floor; the SPEC's own 1024px tablet viewport colliding with the
`globals.css` desktop breakpoint) untouched — separate bugs, out of this
fix's scope.

**A real flake found and root-caused, not a fix regression:** the first
full-spec run showed 2 failures instead of 1; `shell reachability: phone
bottom nav reaches Board/Alerts/Profile/Today` timed out with a Next.js
dev-overlay (`<nextjs-portal>`) intercepting clicks. Root cause: this
session had started `pnpm dev` earlier (for its own MCP-browser-based
verification of the job-switcher fix) and left it running on `:3000`;
Playwright's `webServer.reuseExistingServer: !process.env.CI` silently
reused that dev server instead of its own `pnpm build && pnpm start`,
picking up the dev-mode overlay that a production build never ships. Killed
the stray dev server; the flake did not reproduce on any subsequent run.

**Verified exhaustively, in order:** `pnpm typecheck`/`pnpm lint` clean ·
`pnpm test` 400/400 (128 skipped) · `pnpm test:db` 528/528 against
`despl_test` (never `despl_demo` — [[db-tests-pollute-demo-db]]) ·
`pnpm build` clean · full `pnpm e2e` (all 5 projects, real production
server): **54 passed, 2 failed, 69 skipped** — both failures pre-existing
and disclosed, neither introduced nor fixed here: `auth.spec.ts`'s known
redirect-target failure (parked since Task 3's session), and `/my-day`'s
touch-target-spacing test, whose underlying bug (`gap: 6` hardcoded in
`MineActionButton`'s IN_PROGRESS Hold/Submit button pair, untouched by this
session) is genuinely data-dependent — it silently passed on an earlier
single-file run because the seeded test actor had no IN_PROGRESS Mine row
on screen at that moment, then correctly failed again on the full-suite run
once one existed. Confirmed real via `git grep` that the `gap: 6` line is
unchanged. Visually confirmed via real Playwright screenshots at the phone
project's actual 390×844 viewport (the MCP browser-automation resize tool
was tried first and did not change the rendered viewport at all in this
environment — every screenshot came back desktop-width regardless of the
requested size, so Playwright's own real-Chromium rendering was used
instead, which is also the more authoritative tool here since it's the same
harness Task 7 built this whole verification discipline on): both `/my-day`
and `/workspace` render as clean single-column card lists with zero
overflow and the bottom nav fully visible.

**R1's Session Gate is now genuinely closed** — no open item traces back to
R1 or to this fix; the two remaining e2e failures are both pre-existing,
disclosed, and out of scope (parked for whoever picks them up separately).
On `demo`, commits `0c1b1cb..3f84d69` (10 ahead of `origin/demo` total, incl.
the prior session's `2c483df..99e9bc7`) — not yet pushed, awaiting the
user's go-ahead per this project's "push to `demo` first" git workflow.

## Session — R1 Task 7 (Playwright viewport matrix) shipped, 18 Aug 2026

Last task of Session R1 (7/7). Full account in
`.superpowers/sdd/PLAN-responsive-supervisor-v1/task-7-report.md`; summarized
here.

**Built:** `playwright.config.ts` gained a `setup` project (real `/login`
via `e2e/auth.setup.ts`, `sup.fabrication@despl.local`, storageState saved,
never a forged session) plus `phone`/`tablet`/`desktop` projects at the
SPEC's exact device/viewport values, each `testMatch`-scoped to a new
`e2e/supervisor-viewport.spec.ts` so they don't re-run `auth.spec.ts`;
`webServer.command` switched from `pnpm dev` to `pnpm build && pnpm start`
(a 3x project matrix under dev-mode Turbopack was flaky at this scale, per
the brief). New `e2e/wcag-contrast.ts`: a from-scratch WCAG contrast-ratio
helper (none existed before), with a text-vs-background variant for chips/
KPI values and a separate fill-vs-parent-background variant for graphical
(non-text) elements like spine segments — building the latter caught and
fixed a real bug in my own first attempt (comparing a spine segment's
inherited-but-invisible text colour against itself gave 2.09:1 for dark
`complete`; the fix gave 7.14, matching Task 6's own ~5.9-8.15 range).
Assertions 1/2/3/6 (overflow, touch-target size, adjacent spacing, AA
contrast) run for real; assertions 4/5/7 (execution-sheet layout,
degradation matrix, hi/gu locale checks) are R2/R3 content that doesn't
exist yet — `test.fixme()`'d with unblock comments per the controller
ruling, not silently skipped.

**Zero `src/` changes** (test infrastructure only) — but building the
FIRST-EVER automated check for touch-target sizing/spacing and 390px
overflow (Task 6 only audited colour contrast) surfaced 6 genuine,
pre-existing bugs, none fixed here, all `test.fail()`'d (real, executing,
expected-to-fail — not silenced) with the exact cause in the code comment:

1. **`/my-day` and `/workspace` overflow at 390px.** `/my-day/_client.tsx`
   lines 786/821 ("Department pool", "Held by teammates") and
   `/workspace/page.tsx` lines 77/105/118 (main unit table, QC queue, hold
   points) all use plain `<table>`, never `<ResponsiveTable>`. This is
   pre-existing, deliberately-deferred scope, not an incomplete adoption:
   `task-2-brief.md` named only `/my-day`'s "Mine" table and `/admin`'s
   Employees table as Task 2's targets, explicitly calling out Pool/teamHeld
   as tables that "migrate opportunistically" — left as plain tables on
   purpose (Task 2's own commit, `882ba44`, touches only Mine + Employees).
   `/my-day`'s "Completed" table (line 848), which *is* wrapped in
   `<ResponsiveTable>`, was added later still — by this same session's own
   earlier "non-management Dashboard nav bug fixed" work (`ec17ad6`), which
   reused the already-existing primitive for its new table. `/workspace`
   was never named in any prior task's adoption scope at all.
   Second-order consequence: while actually on `/my-day` at 390px,
   `window.innerHeight` measures 1243px instead of 844 (mobile auto-zoom
   fitting the overflow), which relocates the fixed bottom nav off the
   visibly-rendered fold — every SUPERVISOR/QC lands on `/my-day` right
   after login, so this makes Board/Alerts/Profile briefly unreachable for
   them too.
2. **The SPEC's own tablet viewport (1024x768, a real Galaxy Tab S4
   landscape resolution, copied verbatim) collides with `globals.css`'s
   `@media (min-width: 1024px)` desktop-sidebar breakpoint.** At exactly
   1024px the desktop sidebar renders instead of `.icon-rail` — a real
   device in that exact orientation can't reach Board/Alerts/Profile from
   its shell nav at all (the desktop sidebar that renders instead has no
   link to them either, a separate deliberate Task 4 decision).
3. **`.btn-accent` still has no 56px coarse-pointer floor** — Task 2's own
   review already flagged this as an untracked Minor ("SPEC §3.2's 56px
   primary-action height is still unimplemented anywhere"); now confirmed
   via a real, executing, automated test rather than a code-read note.
4. **`/my-day`'s card action button pair is 6px apart**, needs the 8px
   SPEC §8 minimum.

All 4 are disclosed in the Task 7 report with exact file:line locations,
none fixed (this task's binding scope is test infra only). The pre-existing
`e2e/auth.spec.ts` "internal user signs in and sees tenant-scoped jobs"
failure (parked by Task 3's session, see below) was confirmed still failing
for the exact reason predicted (commit `ec17ad6`'s post-login redirect
change) — also not fixed, explicitly out of scope.

**A design decision worth a second pair of eyes:** the pre-existing
`chromium` project has no `testMatch` restriction (kept exactly as-is per
the brief, since `auth.spec.ts` needs that) and so also picks up the new
spec, unauthenticated — without a guard this produced confusing false
failures (measuring the login page instead of the intended target). Fixed
with one `test.beforeEach` skip for any project outside
`{phone, tablet, desktop}`; `auth.spec.ts` itself is completely unaffected.

**Verified:** `pnpm typecheck`/`pnpm lint`/`pnpm build` clean throughout;
`pnpm test` 400 passed | 128 skipped (528 total) — identical to the prior
session's numbers, confirming zero regression from this test-infra-only
change. `pnpm e2e`, full real run, all 5 projects: 112 tests — 1 failed
(the pre-existing, disclosed `auth.spec.ts` case, not introduced or fixed by
this task), 48 passed (40 genuinely new-green + 8 `test.fail()` findings
above, counted as "passed" since they failed exactly as expected), 63
skipped (includes `chromium` correctly skipping all 26 of the new spec's
tests, and the intentional R2/R3 + 2 disclosed-CSS-gap `test.fixme()`s).
Numbers independently reconciled per-project against the raw list output,
not just the tool's own summary line.

**Status: DONE_WITH_CONCERNS** — infrastructure and every required assertion
work and pass for real; the 4 disclosed findings above (plus the pre-existing
`auth.spec.ts` failure) are real product gaps for the controller to triage,
not defects in this task's own deliverable.

## Session — non-management "Dashboard" nav bug fixed + My Day gets On hold / Completed, 18 Aug 2026

**Bug reported by the user:** for `sj@despl.local` (Production Head) clicking "Dashboard" always worked; for every other employee, after login they'd land on My Day as expected, but navigating away and clicking "Dashboard" again showed Workspace instead.

**Root cause (not a caching/state bug — investigated and ruled out first):** `dashboard/page.tsx:89` hard-redirects any actor without `MANAGEMENT`/`PRODUCTION_HEAD`/`ADMIN` to `/workspace` — working as designed (CLAUDE.md: "supervisor → Today priority list"). The bug was that the sidebar (`app-shell.tsx`'s static `NAV`) showed the identical "Dashboard" → `/dashboard` link to every role, with no "My Day" nav entry at all, so non-management users had no way back to their own dashboard except the one-time login redirect.

**Fixed, user-approved design, both parts:**
1. **Nav** (`app-shell.tsx`): the Overview group's first item is now role-aware — Management/PH/Admin see "Dashboard" → `/dashboard`; everyone else sees "My Day" → `/my-day`, so the link always lands where it says.
2. **Redirect** (`dashboard/page.tsx:89`): fallback target changed `/workspace` → `/my-day`, so a stale bookmark/typed URL is also consistent.

**Also requested:** the user wanted the non-management dashboard (My Day) to show upcoming/pending/completed/on-hold tasks in one place without hopping pages. My Day already had Needs-attention/Due-today/With-QC/Up-next tabs plus Pool and Held-by-teammates, but two gaps: `ON_HOLD` rows were buried inside whatever due-date tab they fell into (no dedicated view), and completed work only existed as a "Done this week" KPI count, not a list — `loadMyDay` (`myday.read.ts`) explicitly discarded `DONE`-state rows (`if (r.state === "DONE") continue`).

3. **On hold tab** (`_client.tsx`): new `hold` bucket in `mineBucket()` (checked after overdue, before awaiting-QC/due-today, so an overdue+held row still surfaces under Needs attention first) + a new "On hold" tab. Reuses the existing `MineRowView`/`MineCardView` — no new row components needed.
4. **Completed section** (`myday.read.ts` + `_client.tsx`): the DONE-skip in `loadMyDay`'s per-job loop now routes the actor's own completed plans (last 30 days, same window the scoreboard already uses) into a new `MyDayView.completed` array instead of dropping them — no new query, reuses the same `prioritize()` output. Rendered as a new read-only "Completed" card (collapsed by default, same pattern as "Held by teammates"), no action buttons since the work is done.

Brainstormed via the brainstorming skill (bounded path — existing flow, existing pages), design approved by the user before implementation. **Verified:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (398/398 pure, 128 skipped) all clean. Not yet visually verified in a real browser — next session should log in as a non-management role (e.g. a supervisor) and click through Dashboard → My Day → On hold / Completed to confirm the fix in the actual app before committing/pushing.

## Session — Final review + fix wave, Session R1 complete, 18 Aug 2026

Continuation of "R1 Task 7 (Playwright viewport matrix) shipped" below —
subagent-driven-development against
`.superpowers/sdd/PLAN-responsive-supervisor-v1/progress.md`.

**Scoping note.** This branch (`demo`) is long-lived; unrelated concurrent
work landed on `main` during this session (`ec17ad6`, a legitimate
non-management-Dashboard-redirect fix from a different session — not
touched by this one). `git merge-base main HEAD` resolves to `ec17ad6`
itself, meaning `main` already includes this plan's Tasks 1-4. The final
review was therefore scoped to `ec17ad6..6da4927` (Tasks 5-7 + their fix
rounds) — the portion that hadn't been through a cross-task review yet.
Tasks 1-4 already passed their own task-scoped reviews earlier this
session (see the entries below).

**Task 5 (StatusChip coarse-pointer icon variant, D28)** — implemented
(sonnet), commit `6ca907e`. All six status icons, exact CSS values,
cascade-order placement, CSS-only toggle mechanism all verified spec-
compliant by the task reviewer. 1 Important, not a code defect: coarse-
pointer rendering was never exercised via real `pointer: coarse` device
emulation (tooling limitation, honestly disclosed), but the report
initially labeled status DONE instead of DONE_WITH_CONCERNS. Fixed by
relabeling only (no code change). Complete.

**Task 6 (token layer + theme preference, D27/D28)** — the session's
largest task: the first per-user preference this codebase has ever built,
including a Prisma migration. Implemented (opus), commit `a5920e9`, self-
reported DONE_WITH_CONCERNS with 7 disclosed deviations, all judged sound
by the task reviewer except 2 real bugs: (1) the React theme context
exported the *unresolved* SSR class for `SYSTEM` preference, so portaled
surfaces (StageSheet, 5 admin dialogs) rendered dark-on-light for any
user on the default state; (2) a blanket light-palette chip re-tint
(`color-mix`) overshot the task's own bounded-audit ruling and regressed
2 of 6 chips from passing to failing contrast. Fix round 1 (commit
`4b910ba`) hoisted SYSTEM resolution to shared state feeding both the div
class and the context (collapsing to one `matchMedia` listener app-wide),
reverted the chip mechanism to the original `rgba(...)` approach with only
2 targeted overrides, added an in-flight guard to the theme cycle. Real
re-verification this time (page-level `matchMedia` override, not a
stubbed re-run) confirmed a genuinely-portaled StageSheet correctly
inherits the resolved palette. 3 controller rulings on things correctly
flagged rather than resolved: residual light-palette AA gaps (`.c-hold`,
`.c-idle`'s ceiling) trace to verbatim-mandated spec tokens — mandated
tokens win, shipped as documented residual gaps, real fix is a future
spec correction; `--accent-fg` (light) stays a mandated-but-unwired dead
token (wiring it would be a real regression); light `--accent`-as-text
(3.73:1, systemic) accepted, deferred. Complete.

**Task 7 (Playwright viewport matrix)** — implemented (sonnet), commit
`85776de`. New `phone`/`tablet`/`desktop` projects at exact SPEC device
values, a real-`/login` `setup` project + `storageState` dependency
pattern (never forged), a from-scratch WCAG contrast helper, `testMatch`
scoping, `webServer` switched to a production build. Controller ruling
before dispatch: 3 of SPEC §8's 7 assertion categories describe Session
R2/R3 page content that doesn't exist yet — written as real
`test.fixme()`s with unblock comments, not silently dropped. The new
suite immediately found 6 genuine pre-existing UI bugs (table overflow,
a tablet/desktop breakpoint collision, missing touch floors, insufficient
gaps) via honest `test.fail()` assertions — task reviewer individually
git-blamed each to confirm none are attributable to this session's own
Tasks 1-6 (3 are deliberately-deferred scope from Tasks 1/2's own
briefs). 1 Important, wording-only: initial framing implied Task 2 left
work unfinished when its brief explicitly deferred it — corrected
(commit `6da4927`), no logic change. Complete.

**Final whole-branch review** (opus, full diff, independently swept the
whole `src/` tree for `createPortal`/`Dialog.Portal` to confirm portal
coverage, recomputed contrast pairs, verified migration/RLS/grant
safety): architecture sound, anticipated seams (portals, cascade order,
storageState scoping) genuinely closed. 1 **Critical**: `theme_preference`
defaults to `SYSTEM`, which resolves to **light** for any user on a
factory-default OS (macOS/Windows 11 both ship light) — silently making
the least-tested palette (3 known AA gaps) the *default* experience for
most users, contradicting CLAUDE.md's "dark theme only in v1," right
before the MD/CEO demo click-through. 5 Important: a dead outdoor-badge
contrast override (later, more-specific rule silently won the cascade,
re-shipping a 1.44:1 failure Task 6's own audit had reported fixed);
hover states never retrofitted across 3 palettes (still hardcoded dark-
only, inverting the primary-action affordance on light/outdoor); the R1
gate's own "no flash-of-wrong-theme on hard reload" condition had no test
despite being named as binding and testable-now; Task 5's coarse-pointer
chip variant still uncovered by the exact tooling Task 7 built to cover
it; theme e2e tests mutated the seeded supervisor's persisted DB state
with no cleanup and a cross-project race Playwright's `.serial()` doesn't
actually contain.

**One fix wave** (opus, commit `2c483df`, the only fix wave this review
allows per process): existing users backfilled to DARK via a **new**
migration (`20260818120000_theme_preference_dark_backfill` — the earlier
migration was already applied, never edited; also clears `outdoor_mode`
on the same reasoning, since it wins over `themePreference` and no
pre-feature user could have deliberately chosen it), 3 false code
comments corrected; the dead outdoor-badge override fixed; a new
`--hover-border` token added per palette and swept through every hover
rule (`.btn`, `.btn-accent`, `.kpi.clicky`, `.dept-card`, scrollbar
thumb) — zero hardcoded hover hex values remain; a real no-flash e2e
assertion added (`colorScheme: 'light'` context + hard reload + asserts
the correct class at first paint, proving the inline pre-hydration script
is what's actually holding, not luck); Task 5's coarse-icon variant
finally covered on real `pointer: coarse` phone/tablet projects; theme
e2e tests moved to a dedicated second seeded identity
(`sup.machine_shop@despl.local`) with a real `afterAll` reset, closing
both the DB-pollution and the cross-project race. Plus 3 bundled Minors:
`.topbar-theme` added to the touch-target assertion list, theme buttons
switched from `disabled` to `aria-disabled` (keyboard focus no longer
drops mid-transition), and the unconsumed-token clarification (see
below).

**Scoped re-review** (opus, independently traced cascade specificity for
every claim, confirmed the migration ownership/RLS/trigger safety,
verified the theme-cycle math for the new test fixture, confirmed the
committed diff excludes an unrelated concurrent session's in-progress,
unstaged `layout.tsx`/`app-shell.tsx` changes): **all 7 findings
ADDRESSED, no new Critical/Important breakage.** 2 items surfaced needing
a controller ruling rather than a second fix-wave dispatch (explicitly
disallowed by this review's own process) — both adjudicated directly:

1. **`prisma/seed.ts`'s `mkUser` never set `themePreference`**, so any
   `pnpm db:seed` run before the demo would silently reintroduce the
   Critical bug for every demo account (`admin@`, `md@`, `ceo@`, `sj@`,
   `qc@`, the per-department supervisors, `client@`). Ruled: fixed
   directly (one line, zero ambiguity, mirrors the backfill migration's
   exact reasoning) rather than dispatched — `themePreference: "DARK"`
   added to `mkUser`'s `data` block. `pnpm typecheck` clean.
2. **The unconsumed-token clarification** — `--border-width`/`--wb`/
   `--wt`/`--mixp`/`--bordp`/`--accent-fg` are declared per-palette in all
   three themes but have **zero** consumers anywhere in `src/`, so
   **Outdoor mode today is a pure colour swap** — no border-width, font-
   weight, or chip-fill changes yet, despite `.theme-outdoor` looking
   "complete" from the token block alone. This is in-plan (the original
   plan text scopes Task 6 to "the on/off mechanism only; R2 owns
   outdoor's full shop-floor UX") — not a defect, just something a future
   session shouldn't assume shipped further than it did. Landed in the
   gitignored SDD scratch ledger first; folded into this canonical file
   now per the ruling above.

**Rulings made this session, collected** (every one recorded live in the
SDD ledger at the point it was made; listed here per finishing-a-
development-branch discipline):
- Task 5: the P2 mockup's `color-mix()`/border chip treatment depends on
  Task 6's (then-unbuilt) tokens — kept the existing rgba mechanism,
  changed only shape/typography/icon. Cost if wrong: cosmetic mismatch
  against the mockup until Task 6-style token retrofit, never shipped.
- Task 6 (4 rulings): AA retrofit bounded to audit-and-fix, not a
  speculative rewrite; preference storage is 2 Postgres columns, never a
  cookie/localStorage; the write is unaudited account bookkeeping (mirrors
  `lastLoginAt`), not routed through `lib/services/`; one single control
  cycling 4 states (System→Light→Dark→Outdoor→System) rather than 2
  separate controls, since Task 4 shipped exactly one button-slot per
  position. Cost if wrong for each: a follow-up migration/UI rework, no
  data loss in any case — the 2 DB columns stay independent of UI
  presentation regardless.
- Task 6 fix-round rulings (3): mandated verbatim tokens win over
  achieving full AA in the light palette — shipped as documented residual
  gaps, real fix is a future spec correction; `--accent-fg` (light) stays
  unwired (wiring it would be a real accessibility regression); light
  `--accent`-as-text accepted, deferred to a future token decision.
- Task 7: 3 of SPEC §8's 7 assertion categories describe unbuilt R2/R3
  content — `test.fixme()`'d with unblock comments rather than silently
  dropped or written as false-green stubs.
- Final review adjudication (2, above): the seed.ts fix, applied
  directly; the token-clarification note, relocated to this file.

**Not fixed at the time, explicitly out of scope, flagged for whoever picks up
Session R2:** the 6 pre-existing UI bugs Task 7's tests found (listed in
the Task 7 entry above) — most urgent: `/my-day`'s Pool/teamHeld table
overflow at 390px makes the page's own bottom nav unreachable on phone,
which blocks the primary daily-use page on the primary target device.
Correctly not attributable to any R1 task, but should be R2's first item,
not just a parked test finding. **✅ Fixed same-day, before R2 started** —
see "Session — R1 closed out: job switcher wired, R2's flagged overflow bug
fixed" above (`3f84d69`). The other 5 disclosed bugs (auth.spec.ts redirect
failure, 1024px tablet/desktop breakpoint collision, `.btn-accent` missing
the 56px floor, `/my-day` card-button 6px gap) remain open, unrelated to
this fix, still R2/later scope.

**Verified:** `pnpm typecheck`/`lint`/`build` clean throughout every
round. `pnpm test` 400/400 (128 skipped), `pnpm test:db` 528/528 (against
`despl_test` only, per this project's DB-test discipline). `pnpm e2e`:
55 passed / 69 skipped / 1 failed (the one pre-existing, disclosed,
unrelated `auth.spec.ts` redirect-target failure — confirmed present,
not fixed, out of scope for this whole session). Real browser
verification throughout via the actual `/login` form as real seeded
users (`sj@despl.local`, `qc@despl.local`, `sup.fabrication@despl.local`,
`sup.machine_shop@despl.local`) — never a forged session at any point in
this 7-task, 2-review-round session.

⚠️ **On `demo`, commits `ec9f0fb..2c483df` plus the direct seed.ts ruling
above — not yet pushed to `origin/demo`, awaiting the user's review and
go-ahead**, per this project's git workflow (push to `demo` first, merge
to `main` only after explicit human approval).

## Session — R1 Task 2 review completed, Task 3 (route shells) shipped, 17 Aug 2026 (continuation)

Direct continuation of the "R1 Task 2 implemented, review interrupted"
session below — subagent-driven-development against
`.superpowers/sdd/PLAN-responsive-supervisor-v1/progress.md`.

**Task 2 (`<ResponsiveTable>`) review completed.** Re-dispatched the task
reviewer (sonnet) against the already-generated `review-356188c..882ba44.diff`
+ `task-2-brief.md` + `task-2-report.md`. Verdict: spec compliant, 1
Important finding — `MineRowView`/`MineCardView` and
`QcQueueRowView`/`QcQueueCardView` in `/my-day/_client.tsx` duplicated
verbatim business logic (state hooks, handlers), not just JSX. Fix round 1
(fresh implementer, original session's subagent not addressable): extracted
`useMineRowActions`/`useQcRowActions` shared hooks, kept the JSX split
(required by the CSS-only breakpoint design). Scoped re-review: addressed,
no new breakage. **Task 2: complete, commits `356188c..cb25cda`.** Two
Minors deferred to the ledger, not fixed: `EmployeeCardView` drops the
table's "—" no-departments placeholder; SPEC §3.2's 56px primary-action
height is still unimplemented anywhere (pre-existing Task 1 gap, untracked
until now).

**Task 3 (`/board`, `/alerts`, `/profile` route shells, D31) — new task,
implemented and shipped.** SPEC-supervisor-ui-v3.md §9 split R1 from 5
tasks to 7; this is the first of the two new ones. Implementer (haiku):
three minimal `page.tsx` files under `(app)/`, following `/my-day`'s exact
actor-fetch + `if (!actor) redirect("/login")` pattern — no middleware
change needed (`src/middleware.ts`'s catch-all matcher already covers new
routes, confirmed by direct read). Task reviewer (sonnet): spec compliant,
code correct and minimal, zero touches outside the 3 new files — but 1
Important finding: the report *claimed* the unauthenticated-redirect /
authenticated-render check was verified, when it had only been inferred
from an unrelated existing test. Fix round 1: a **real** Playwright-driven
browser check through the actual `/login` form (no forged session — CLAUDE.md
Agent Conduct) as `sj@despl.local` — all 3 routes redirect unauthenticated,
all 3 render authenticated with correct heading text via DOM assertion.
Along the way this fix round found and resolved an unrelated environmental
issue (a stale long-lived `pnpm dev` process with stale Turbopack Server
Action IDs, reproduced identically on the pre-existing `auth.spec.ts` test
too, proving it wasn't a defect in the new pages — fixed by a clean
restart, no code change). Scoped re-review: addressed, no new concerns.
**Task 3: complete, commit `12dcdcf`** (verification-only fix round, no
code change beyond the original implementation commit).

**Surfaced, NOT fixed — parked for whoever picks up Task 7:** re-running
the full `e2e/auth.spec.ts` post-restart as a sanity check during Task 3's
fix round found `"internal user signs in and sees tenant-scoped jobs"`
failing on a clean server — `"DESPL Production Tracker"` heading not found
on `/`. Confirmed pre-existing and unrelated to Tasks 1-3 (dashboard/`/`
content, not `/board`/`/alerts`/`/profile`). Needs a look before Task 7
(Playwright viewport matrix) builds on top of this suite.

`pnpm typecheck && pnpm lint && pnpm build` clean after both tasks;
`pnpm test` 398/128 skipped throughout (pure extraction + new isolated
files, no regressions). Full task-by-task detail, the exact review verdicts,
and the ledger's now-corrected 7-task numbering (renumbered to match
SPEC-supervisor-ui-v3.md §9 — was still showing the old 5-task numbering
from before the amendment) are in
`.superpowers/sdd/PLAN-responsive-supervisor-v1/progress.md`.

Commits this session: `cb25cda` (Task 2 fix), `12dcdcf` (Task 3). On
`demo`, not yet pushed to `origin/demo` (9 commits ahead as of this
session).

**NEXT SESSION — start here: Task 4 (shell variants).** Desktop sidebar
(unchanged) → tablet icon rail (76px) → phone bottom nav (64px + safe-area
inset; Today · Board · Alerts · Profile) with badge counts, linking to
Task 3's new routes. Board icon: copy the exact SVG from the **v3** board
reference (`design/DESPL Supervisor Handoff.dc.html` — supersedes the v2
artifact per SPEC-supervisor-ui-v3.md §0). Theme-cycle control (Task 6,
not yet built) gets a placeholder slot at the rail's bottom (tablet) / top
bar (phone) per the plan, but Task 4 itself doesn't build theme switching.
No brief file exists yet for Task 4 — write one from
`docs/PLAN-responsive-supervisor-v1.md` Session R1 Task 4's text (and
SPEC-supervisor-ui-v3.md §9 item 4) before dispatching, following the same
format as `task-2-brief.md`/`task-3-brief.md`.

## Session — R1 Task 2 (`<ResponsiveTable>`) implemented, review interrupted before verdict, 17 Aug 2026 (continuation)

Direct continuation of the "Supervisor UI v3 spec landed" session below — same
subagent-driven-development run against the SDD ledger at
`.superpowers/sdd/PLAN-responsive-supervisor-v1/progress.md`. Re-dispatched
R1 Task 2 (`<ResponsiveTable>` primitive + adoption in `/my-day` Mine and
`/admin` Employees) using the existing, still-valid brief
(`task-2-brief.md` — the v3 amendment didn't touch Task 2's scope). BASE
`356188c`.

**Implementer reported DONE: `882ba44`** ("feat(responsive): add
`<ResponsiveTable>` primitive, adopt in /my-day Mine and /admin Employees").
CSS-only breakpoint swap (`.rt-table`/`.rt-cards`, 1024px, no
JS `matchMedia`/`useState` — avoids the hydration-mismatch/flash risk the
brief called out), placed in `globals.css` before Task 1's density layer
with no cascade conflict (Task 1's own review found exactly that class of
bug once already — implementer reports having checked for a recurrence).
`/my-day`'s Mine table got card views for all three of its row shapes
(`MineCardView`, `QcQueueCardView`, `SelfSubmittedCardView` — supervisor and
both QC-mode rows, not just the common case) plus a `mineDisplayStatus`
helper onto `<StatusChip>`; Pool/teamHeld tables correctly left untouched,
per the brief's scope. `/admin` Employees got `EmployeeCardView`;
`AddEmployeeDialog`'s full-screen-form conversion correctly left out
(explicit brief deferral, a known SPEC §4 gap, not silently dropped).
`pnpm typecheck && pnpm lint && pnpm build` clean; `pnpm test` 398/128
skipped. Verified live via the real `/login` form (no forged sessions) as
`admin@despl.local` and `qc@despl.local`; used a same-origin iframe to get
a real 390px CSS viewport (the sandbox's `resize_window` didn't actually
resize the browser) to confirm the table/card swap with live, non-empty
data, including claiming a pool item to populate a real Mine row. Full
report: `task-2-report.md`.

**Review package generated** (`review-356188c..882ba44.diff`) and the
task-reviewer dispatch was **started but interrupted by the user before
returning any verdict** — the user asked to end the session here. **Task 2
is NOT reviewed and NOT complete.** Do not treat `882ba44` as gated; the
implementer's report is unverified until a task reviewer actually checks it
against the brief.

**NEXT SESSION — start here:** re-dispatch the task reviewer using
`task-reviewer-prompt.md`'s template against the already-generated diff file
above, `task-2-brief.md`, and `task-2-report.md` — no need to regenerate the
review package, it's already sitting in the SDD workspace. Then continue the
normal fix-loop → completion flow, and proceed to Task 3
(`/board`/`/alerts`/`/profile` route shells, D31) per the amended 7-task
list. The implementer's own report flagged 3 items worth handing to the
reviewer verbatim rather than re-deriving: (1) `AddEmployeeDialog` deferred
by brief scope, not a gap; (2) `QcQueueCardView`/`SelfSubmittedCardView`
verified by code-parity only, no live cross-actor SUBMITTED-state data
existed in the demo DB at check time; (3) a **pre-existing, out-of-scope**
bug noted but not fixed: the app shell's fixed 236px sidebar causes
page-level horizontal overflow at true phone width (the `.rt-cards` content
itself has zero excess width) — worth its own task once R1's shell-variant
task (now Task 4) replaces the fixed sidebar with the phone bottom nav,
since that's likely what actually closes this gap rather than a separate fix.

## Session — Supervisor UI v3 spec landed, R1 scope amended (D28–D32), 17 Aug 2026

Two parts to this session. **Part 1 (subagent-driven SDD, R1 Task 1 done, Task 2 paused mid-dispatch):** resumed `docs/PLAN-responsive-supervisor-v1.md` Session R1 against the (then-current) 5-task list. R0 pre-check against the Phase 2 (`/my-day`) log above confirmed it shipped desktop-only — R1 builds all of it, not a gap-fill. Pre-flight conflict scan and two rulings written to the SDD ledger (`.superpowers/sdd/PLAN-responsive-supervisor-v1/progress.md`): task order T1→T5, and — because Phase 2's own log explicitly says "no light variant exists anywhere in this app," contradicting SPEC-responsive-app-v2's "both palettes already exist" assumption — a ruling that Task 5 (theme) would need to design a light industrial palette from scratch, sourced from the v2 artifact. **Task 1 (density layer) shipped**: `57c782a` (pointer-coarse base font/min-height/Tailwind `coarse:`/`fine:` variants) then `5df8501`, a fix-round-1 commit — task review caught a real CSS cascade bug (the coarse `td` row-padding/text-size override was placed *before* a later unconditional `.theme-industrial td` rule with equal specificity, so on a real coarse-pointer device the later rule always won and silently overwrote it back to 13px/12px; confirmed via byte offset in the compiled build CSS, not just source presence). Fixed by relocating the whole density block to the end of the `.theme-industrial` scope; re-review confirmed clean, no new breakage. **Task 2 (`<ResponsiveTable>`) was briefed and about to dispatch when the user interrupted** to redirect the session — nothing committed for Task 2, `demo` was untouched at `5df8501` when the redirect landed, so nothing needed cleanup.

**Part 2 (docs-only, no application code): landed `docs/SPEC-supervisor-ui-v3.md`** — a new, more detailed design contract for R1–R2 with a real pixel reference (`design/DESPL Supervisor Handoff.dc.html`, `design/support.js`, `design/despl-supervisor-flow-v3.html`; also tracked the already-untracked `design/despl-supervisor-flow-v2.html` so v3 §0's "v2 stays in the repo as history" claim is actually true). This **supersedes the Part-1 SDD ledger's "design a light palette from scratch" ruling** — v3 gives exact, already-approved hex values for light and outdoor sourced from the reviewed board, so that ruling is moot going forward; the SDD ledger is left as-is (it's a true record of what was decided at the time), but R1's next session should read `SPEC-supervisor-ui-v3.md` §2, not the old ledger ruling.

**Reference-board defect found and fixed:** the `.dc.html`'s embedded `themes` object (drives its interactive Dark→Light→Outdoor cycler) had drifted from the spec's own §2.2 CSS block on four values — Light and Outdoor each collapsed `--s-hold`/`--s-overdue` to one shared hex (On hold and Overdue became visually identical in two of three themes), Dark's `--s-progress` held the accent color instead of its own, and Dark/Light's `--accent-fg` didn't match either (two of these four were found by independently cross-checking the full map against §2.2 key-by-key, not just the ones initially flagged). All four corrected to match the spec exactly; §2.2 now states the CSS block is authoritative over the board's cycler, so future drift gets corrected in that direction, not the reverse.

**R1 scope amended: 5 tasks → 7.** SPEC-supervisor-ui-v3.md §9 replaces the R1 task list — original 5 stand (Task 1 done, Task 2 paused as above), plus two new tasks split out because they're real new-build scope, not just an addition to an existing task: `/board`+`/alerts`+`/profile` route shells (D31 — three new routes, `middleware.ts`'s existing catch-all matcher already protects them, no middleware change needed) and a `StatusChip` coarse-pointer icon variant (D28 — `icon + word` replacing `dot + word` on `pointer: coarse`, isolated because `status-chip.tsx` is used everywhere in the app, not just supervisor surfaces). Also amended: SPEC-responsive-app-v2.md §10 (D28–D32 mirrored in), and both R1/R2 copy-paste session prompts. Full detail of every correction (§2.1/§2.3/§4/§5/§6/§8/§9 line-item changes) is in `docs/SPEC-supervisor-ui-v3.md` itself and the two commit messages below — not restated here.

**Commits 57c782a`..`0f1999a` (5, on `demo`, not pushed):**
- `57c782a`/`5df8501` — R1 Task 1 (density layer) + its fix round. **Kept, not reverted** — the work is correct (re-reviewed clean) and nothing in the v3 amendment changes Task 1's scope or contract; v3 only changes Tasks 2 and onward's ordering/content, described above.
- `c486ad5` — landed the v3 reference set + the reference-board colour fix.
- `0f1999a` — the SPEC-supervisor-ui-v3.md/SPEC-responsive-app-v2.md/PLAN-responsive-supervisor-v1.md amendments + the `eslint.config.mjs` `design/**` ignore (needed because landing `design/support.js` — the v3 board's runtime script — broke lint on rules that don't apply to reference material; same treatment the untouched `design/*.html` mockups already get by not being JS).

`pnpm typecheck && pnpm lint` clean after every commit in this session. No `pnpm test`/`test:db` run — no application code changed in Part 2, and Part 1's Task 1 report already covered its own test evidence (see the SDD ledger).

**NEXT SESSION — start here:** re-dispatch R1 Task 2 (`<ResponsiveTable>`) using the existing brief at `.superpowers/sdd/PLAN-responsive-supervisor-v1/task-2-brief.md` (still valid — v3 didn't change Task 2), then continue through the amended 7-task list in `docs/SPEC-supervisor-ui-v3.md` §9 / `docs/PLAN-responsive-supervisor-v1.md`'s R1 section (route shells → shell variants → StatusChip icon variant → token layer + theme → Playwright matrix). The SDD ledger's task-order rulings (T1→T5) still apply to the renumbered 1→7 list one-for-one except where the two new tasks (3 and 5) insert.

## Session — Personal Dashboards Phase 1, 16 Aug 2026 evening (subagent-driven SDD, PAUSED mid-task on session limit)

Kicked off Phase 1 of `docs/PLAN-personal-dashboards-v1.md` ("person grain +
assignment service" — Tasks 1.1–1.4) using the subagent-driven-development
flow: fresh implementer subagent per task, controller-dispatched task review
(spec + quality) after each, fix loop on findings, ledger tracked at
`.superpowers/sdd/PLAN-personal-dashboards-v1/progress.md` (gitignored —
added `/.superpowers/` to `.gitignore` this session). Working directly on
`demo` (no worktree — this repo's single-long-lived-branch convention makes
a feature-branch worktree fight the grain rather than serve it).

**Baseline confirmed clean before starting:** `pnpm test` 323/323 (47
skipped), `pnpm test:db` 370/370 — matched the prior session's recorded
numbers exactly.

**Task 1.1 (schema) — SHIPPED, commits `970db2d..ca4cba7`.** Added
`User.username`/`employeeCode` as tenant-scoped unique (`@@unique([tenantId, ...])`,
matching `email`'s existing scoping and `Welder.employeeCode`'s precedent —
a deliberate, controller-approved deviation from the plan's literal
plain-`@unique` wording, since a global unique would be the one field on
`User` breaking this app's otherwise-consistent multi-tenant design),
`User.mustChangePassword` (new rows default `true`, all 76 existing seeded
rows explicitly backfilled to `false` in the migration before the `NOT
NULL`/`DEFAULT` — verified via direct SQL, not assumed), `ProcessPlan.assigneeUserId`
(nullable FK, `ON DELETE SET NULL`, `@@index([assigneeUserId, status])`).
Migration additive-only, no drops/renames. Task review found one Important
finding (the new `username` derivation in `admin.service.ts`'s `createUser`
had no uniqueness pre-check unlike `email`'s existing one — would crash raw
on a same-tenant collision instead of refusing cleanly); fixed same round
(`ca4cba7`, +3 DB-gated tests), scoped re-review clean.

Along the way, Task 1.1's implementer surfaced a **pre-existing, unrelated**
finding while trying to verify seeded logins still work post-migration: the
local dev DB (`despl`) currently has **35 `Organization` rows**, 34 of them
leaked `TEST-*`/`DELAY-*` artifacts from some prior DB-gated test run that
apparently targeted `despl` instead of the dedicated `despl_test` DB (the
same anti-pattern the `db-tests-pollute-demo-db` memory already documented
and fixed for `despl_test` — recurring here against a *different* DB).
`resolveTenantForLogin`'s single-org assumption fails with 35 orgs, so
**every real `/login` attempt on this machine is broken right now**,
independent of this session's schema work (confirmed: password/username/
mustChangePassword all resolve correctly when tenant is hardcoded, bypassing
the broken lookup). Not fixed this session — deleting rows from a shared dev
DB without being asked is a destructive operation, out of scope for a
schema task. **Needs the user's attention before any live `/login` demo.**

**Task 1.2 (`assignment.service.ts`) — INTERRUPTED, NOT SHIPPED.** The
implementer subagent was cut off mid-task by a Claude session API usage
limit (external interruption, not a self-reported block) shortly after
apparently finishing the test file. What's on disk, **uncommitted**:
`src/lib/services/assignment.service.ts` (`claimPlan`/`assignPlan`/`releasePlan`
per SPEC §5.1, with the five new error codes), `src/lib/services/assignment.service.test.ts`
(6 pure + 15 DB-gated table-driven cases), `src/app/actions/assignment.ts`
(three thin actions), plus additions to `src/lib/shared/errors.ts` (5 new
`ERROR_CODES`/`ERROR_MESSAGES`: `NOT_IN_DEPARTMENT`, `ALREADY_ASSIGNED`,
`PLAN_COMPLETE`, `ASSIGNEE_NOT_IN_DEPARTMENT`, `ASSIGNEE_INACTIVE`) and
`src/lib/shared/schemas.ts` (3 new `.strict()` schemas). A controller read of
all four files found them well-formed and following this codebase's
established `delay.service.ts` pattern exactly — but this is an unverified
read, not a review. **`pnpm typecheck` currently FAILS**: `src/app/api/_lib.ts`'s
`STATUS: Record<ErrorCode, number>` map is exhaustive over `ErrorCode` and
was never updated for the 5 new codes — the one concrete gap the
interrupted implementer would have caught at its own verification step had
it gotten that far. `pnpm test` (pure tier) is green regardless — **330
passed / 64 skipped (394 total)**, no regressions. `pnpm test:db` was not
run against this work. **Full exact state, byte-for-byte, and a numbered
resume plan are in the SDD ledger** — read
`.superpowers/sdd/PLAN-personal-dashboards-v1/progress.md` first thing next
session, do not re-derive this from scratch, and do not run any destructive
git command against the working tree before reading it.

**Not started:** Task 1.3 (first-login password change — `changeOwnPassword`,
`/account/password` interstitial, `mustChangePassword` guard) and Task 1.4
(the cross-cutting D16 gate-independence test, migration backfill
assertions, full-suite gate run twice, typecheck/lint/build). Pre-dispatch
research already done and recorded in the ledger for both (session/JWT has
no revocation mechanism today — Task 1.3 needs to add one; middleware is
deliberately DB-free, so the `mustChangePassword` guard should ride in the
JWT payload, not add a DB call to middleware).

**NEXT (start here):** open `.superpowers/sdd/PLAN-personal-dashboards-v1/progress.md`,
follow its "Resume plan" under the Task 1.2 section verbatim (fix the
`_lib.ts` STATUS map → typecheck clean → `pnpm test` → `pnpm test:db` →
commit → dispatch task reviewer → continue to Tasks 1.3/1.4). Separately,
flag the `despl` dev-DB pollution (35 orgs) to the user — it blocks any real
login demo and needs an explicit decision (clean up the leaked rows, or fix
`resolveTenantForLogin`'s single-org assumption) before anyone tries to log
in on the demo laptop.

## Session — Personal Dashboards Phase 2 (`/my-day`), 17 Aug 2026 (subagent-driven SDD)

Resumed Personal Dashboards work: `docs/PLAN-personal-dashboards-v1.md` Phase 2
("Landing router + `/my-day`, the personal dashboard" — Tasks 2.1–2.4), same
subagent-driven-development flow as Phase 1. Ledger:
`.superpowers/sdd/PLAN-personal-dashboards-v1/progress.md` (full task-by-task
history, every ruling made — read it first before starting Phase 3). Working
directly on `demo`, no worktree. Baseline confirmed clean before starting:
`pnpm test` 340/93 skipped, `pnpm test:db` matched Phase 1's final numbers.

**Task 2.1 — `myday.read.ts` (`f7171ec`..`4a00987`).** `loadMyDay(actor)`: a
cross-job read aggregating an actor's assigned work (`mine`), their
department's unclaimed pool (`pool`), and teammates' items (`teamHeld`)
across every ACTIVE job — loops `loadJobs()`'s jobs through the existing
spine→CPM→`prioritize()` pipeline per job (same shape `portfolio.read.ts`
already established), no second ranking implementation. Scoreboard formulas
reuse `loadJobKpis`'s exact on-time/avg-cycle logic filtered to assignee
(SQL-view rule: `/my-day` can never disagree with `/dashboard`). Review found
2 Important findings (a `clearedToday` field scoped inconsistently with the
rest of the payload; zero test coverage for the cross-job merge itself,
the one thing this task was dispatched to prove) — both fixed, re-reviewed
clean.

**Task 2.2 — Landing router (`461e9a7`).** `src/app/page.tsx`: SUPERVISOR/QC
now redirect to `/my-day` (was `/workspace`); explicit `mustChangePassword`
interstitial check added ahead of role branches, matching `/portal`'s
existing pattern. Reviewed clean, no fix loop.

**Task 2.3 — `/my-day` page (`0682d46`..`6d1b6e7`, 2 fix rounds).** The
actual page: header, personal scoreboard strip, always-visible **Mine** +
**Department pool** sections (KPI tabs filter Mine only — a deliberate
controller ruling reading SPEC's parallel bullet structure literally, since
only "Held by teammates" says "collapsed"), collapsed **Held by teammates**,
inline refusal rendering (error code + sentence, not just a toast — the
explicit differentiator from `/workspace`'s pattern), Claim/Assign actions,
StageSheet integration. Round 1 fixed a mislabeled "File & start" button
(only filed, never started) and the Mine/Pool-always-visible layout. Round 2
fixed a bug the round-1 fix itself introduced (clicking "Pool" silently
reset Mine's selected filter tab).

**Task 2.4 — Verify gate (`f5c0bb0`), DONE_WITH_CONCERNS → Approved.** Part
A: a genuinely non-circular DB-gated test proving `/my-day`'s overdue count
agrees with `/workspace`'s (`loadMyOverdueCount`) for the same actor. Part
B: a REAL browser click-through of the full scenario through the actual
`/login` form (never forged) — supervisor claim→start→submit, QC
login→verify, both `/dashboard`/`/workspace` confirmed to reflect the
change. This surfaced and fixed **2 real bugs** neither unit tests nor task
review could have caught: (1) `myday.read.ts`'s partition never showed a QC
actor cross-department SUBMITTED plans — `/my-day`'s "With QC" tab came up
empty for the primary maker-checker flow; (2) the inline `RefusalNote` CSS
broke under a narrow table column, making a real refusal unreadable.
Honestly reported: the exact same-user maker-checker refusal isn't
reachable with the seeded accounts (only one QC-role user exists) — a
different real refusal was substituted and confirmed instead of forcing a
false pass. Also fixed as environment setup (not code): local Postgres was
misconfigured (Homebrew services shadowing the project's Docker container —
same failure mode as a prior incident) and one migration
(`session_version`) was unapplied.

**Final whole-branch review (opus) — 3 Important findings, all fixed
(`25183e0`), re-reviewed clean.** Found exactly the kind of cross-task seam
no single task's own review could see: (1) the router's two conditional
redirects (2.2) had no fallback — a staff-side `CLIENT_VIEWER` with
`clientId: null` (createable via `/admin` today) fell off the function,
blank page; (2) a QC actor's OWN submitted work (QC department's own
NDE/inspection processes) became invisible in every tab and count — a real
interaction between 2.3's tab bucketing and 2.4's Bug-1 fix; (3) every row
on `/my-day` was a dead click control for job-grain (unit-less) office-dept
work, since `/my-day` is the first surface to list any — `/workspace`/
`/departments` never had this problem because they're unit-grain only.
Bundled in two upgraded Minors (missing `disabled={pending}` on delay
controls; a genuine SSR/hydration mismatch from browser-local-time date math,
fixed with the same fixed-offset IST arithmetic `myday.read.ts` already
uses).

**Verified:** `pnpm test` 340/99 skipped, `pnpm test:db` **439/439, run
twice** (both before and after the final fix wave), typecheck/lint/build
all clean (build independently re-verified by the controller after one
implementer's sandbox couldn't run it — a Google Fonts network-fetch
limitation specific to that sandbox, not a real defect).

**Phase 2: DONE.** Commits `38e04da..25183e0` on `demo`, not yet pushed to
`origin/demo`.

**Rulings made this phase (full list, with "why"/"cost if wrong" in the SDD
ledger):** cross-job aggregation shape for `myday.read.ts`; scoreboard has
no subject parameter (peer-scoreboard RBAC deferred to whichever phase
exposes it); router precedence (explicit interstitial check ahead of role
branches); the `myday.read.ts` row-label extension (job number/process
name/unit serial denormalized onto each row); dark theme only (SPEC's
"light+dark" text is inherited boilerplate against CLAUDE.md's explicit
"dark theme only in v1" and the fact no light variant exists anywhere in
this app); KPI tabs are pure client-side state, not URL-driven; Mine/Pool
must both be always-visible sections.

**Needs the user's attention before Phase 3/4 or any live demo:** a real
`/login` browser spot-check as `qc@despl.local` for the self-submitted-work
fix (verified by code tracing + a DB test this session, never clicked
through live); a second seed QC-role account would let a future phase
actually browser-verify the maker-checker same-user refusal path (today
only proven by the unit-tested server gate, never reachable in a live
click-through with the current single QC seed account).

**NEXT SESSION — start here: Phase 3 (Office Command Center pages).**
Pre-flight scan and two structural rulings already written to the SDD
ledger (`.superpowers/sdd/PLAN-personal-dashboards-v1/progress.md`, "Phase
3" section) but Task 3.1 was not yet dispatched — resume from there, do not
re-derive:
1. **SPEC/schema mismatch already resolved:** SPEC §7.4 names "PMO" as one
   of the six office departments, but no `PMO` department code exists
   anywhere in the schema/seed (13 codes total, per `docs/BUILD-SPEC-v2.md`
   §3). Ruling: "PMO" maps to the seeded `PROJECTS` department. The six
   `/command/[dept]` codes are `PROJECTS, ENGINEERING, PLANNING,
   PROCUREMENT, QC, STORES`; every other code redirects to `/workspace`.
2. **New read file needed:** `src/lib/services/command-center.read.ts`,
   `loadCommandCenter(actor, deptId)` — reuses the same cross-job
   spine→CPM→`prioritize()` loop `myday.read.ts` established (filtered to
   one department) for "Decide today"/"blocking-waiting", and calls the
   EXISTING `loadDepartmentCards(actor)` (`departments.read.ts`) for the KPI
   row so the numbers can never drift from `/departments/[id]` (Task 3.2's
   own gate requires exact match). "Pipeline columns map plan states into
   dept vocabulary" means relabeling the existing `PlanState` enum per
   department via a small static config, not inventing per-department
   record types (SPEC explicitly bans that).
3. **Access control ruling:** dept members + PH/ADMIN get full access;
   MANAGEMENT sees the page read-only (zero action buttons, matching Task
   4.2's own admin convention); everyone else gets `notFound()`.

After Task 3.1 (`/command/[dept]`) → Task 3.2 (verify gate: all 6 pages
render non-empty, KPI numbers match `/departments/[id]`/`/dashboard`
exactly, management sees zero action buttons) → final Phase-3 whole-branch
review → **Phase 4** (admin employee management + notifications: Tasks
4.1 `admin.service` extensions, 4.2 `/admin` Employees tab, 4.3
assignee-first notifications, 4.4 full release-gate verification — the
plan's own §10 end-to-end scenario) → sync this file again → vault sync
per the workspace `CLAUDE.md`.

Standing instructions from the user for this multi-session effort, carried
forward: stay strictly scoped to what the plan/spec/CLAUDE.md actually say,
no unrequested invention; flag small uncertainties and keep moving (ruling
+ ledger entry, same pattern as above); escalate genuinely big issues to a
more capable model to adjudicate, then hand back to Sonnet for the actual
coding; if a session runs out of budget mid-phase, the next session resumes
from the SDD ledger, not from memory.

## Session — Personal Dashboards Phase 3 (Office Command Center), 17 Aug 2026 (subagent-driven SDD)

Continued the same multi-session effort: `docs/PLAN-personal-dashboards-v1.md`
Phase 3 (`/command/[dept]` for the six office departments — Tasks 3.1–3.2),
same subagent-driven-development flow, same session as Phase 2 above (no
gap). Baseline: `pnpm test` 340/99 skipped, `pnpm test:db` 439/439 twice
(Phase 2's own final numbers). BASE commit: `25183e0`.

**Ruling (SPEC/schema mismatch):** SPEC §7.4 names "PMO" as one of the six
office departments; no `PMO` code exists in the schema/seed (13 codes
total). Ruling: "PMO" maps to the seeded `PROJECTS` department (its
entry-surface — PO review, kick-off — is the project-management function
PMO describes). The six `/command/[dept]` codes: `PROJECTS, ENGINEERING,
PLANNING, PROCUREMENT, QC, STORES`; the other 7 (floor/shop) redirect to
`/workspace`.

**Task 3.1 — `/command/[dept]` + `command-center.read.ts`
(`5066469`..`8c3faa1`).** New read reuses `myday.read.ts`'s exact
cross-job spine→CPM→`prioritize()` loop (no second ranking
implementation) and calls the EXISTING `loadDepartmentCards()` for the KPI
row so numbers can never drift from `/departments`/`/dashboard` (SQL-view
rule). Added an additive `blockingPredecessorIds` field to the shared
`RankedPlan` type (previously computed internally by `prioritize()` and
discarded) to support the new "You're blocking" section without a second
DAG traversal. Access: dept members + PH/ADMIN full access, MANAGEMENT
read-only (zero action buttons), everyone else `notFound()`. Reviewed
clean, no fix loop — "Approved."

**Task 3.2 — verify gate (no commits, verification-only).** Closed a real
gap Task 3.1's own browser pass left: only Procurement had been fully
click-tested. Drove all 6 office departments' seeded supervisor accounts
via real `/login`, confirmed each renders non-empty with KPI numbers
byte-identical to `/departments`, confirmed MANAGEMENT read-only on 2 more
departments, confirmed dark theme clean on all 6 + `/login`.

**Final whole-branch review (opus) — 2 Important findings, both fixed,
re-reviewed clean.** (1) **Reachability gap**: `/command/[dept]` had
exactly one inbound link in the whole app (`/my-day`'s header, members
only) — PH/ADMIN/MANAGEMENT never reach `/my-day`, so the MANAGEMENT
read-only mode was dead code in the shipped UI. Fixed with a link from
`/departments/[id]` (the page those roles DO reach), gated on the same
`classifyDeptCode` helper. (2) **Uncapped cross-department lists**:
"You're blocking"/"Waiting on others" had no cap, unlike the pipeline
columns 40 lines away — at DESPL's per-unit `ProcessPlan` grain (9 plans
per process for a 9-serial job) a busy department like QC could render as
a wall of rows. Fixed with the same `slice(0,6)` + "+N more" pattern the
pipeline columns already use.

**Verified:** `pnpm test` 368/100 skipped, `pnpm test:db` 468/468,
typecheck/lint/build clean.

**Phase 3: DONE.** Commits `5066469..07731eb` on `demo`.

## Session — Personal Dashboards Phase 4 (admin employee management + notifications), 17 Aug 2026 (subagent-driven SDD, continuing same session)

Final phase of the plan: `admin.service.ts` extensions, `/admin`'s
Employees tab, assignee-first notifications, and the full §10 release-gate
browser verification. Baseline: Phase 3's own final numbers, BASE commit
`07731eb`.

**Task 4.1 — `admin.service.ts` extensions (`da66b53`..`16862b6`, 3 fix
rounds).** `createEmployee` (crypto-random temp-password generation,
returns `{userId, username, tempPassword, effectiveEmail}` once, never
logged/audited-in-plaintext), `setUserActive` (self-deactivate refused),
`updateUserRolesDepts` (self-demote-from-ADMIN refused), `bulkImportEmployees`
(per-row independent transactions — a bad row never rolls back good
ones), extended `resetUserPassword`. **Genuinely load-bearing gap found
mid-task and closed via a controller ruling, not deferred a second time:**
SPEC decision D13 ("login accepts username or email") had been locked
since before Phase 1 but was NEVER implemented — `login()` was still
email-only, `type="email"` input, no username path. Task 4.1's
`createEmployee` is the function that makes accounts without a real email
(the realistic shape of the C9 bulk staff list), so an unimplemented D13
meant those accounts genuinely couldn't sign in. Implemented D13 for
real: `loginSchema` widened to accept a bare identifier, `login()`'s
lookup does `OR` on email/username, login page relabeled "Username or
email." This introduced (and then closed, across 2 more fix rounds) a
username/email cross-field collision risk — an admin-privileged path
could otherwise create an account whose username matches a different
user's email, making login identity resolution nondeterministic; closed
with collision guards on both `createEmployee` and the older `createUser`.
`pnpm test` 373/113 skipped, `pnpm test:db` 485/485, typecheck/lint clean.

**Task 4.2 — `/admin` Employees tab (`fef1f35`..`53b3444`, 2 fix
rounds).** Extended table (username/employeeCode/lastLogin/open-items-
count columns, a new additive `User.lastLoginAt` migration), Add/Edit-
employee dialogs, A6 credential-slip printing, bulk CSV import with
per-row preview + downloadable result CSV. Fix round 1 closed an unscoped
global print-CSS regression (breaking printing on every OTHER page in the
app) and a stale-schedule-run bug inflating the open-items count. Fix
round 2 closed a regression the round-1 CSS fix itself introduced (it
fixed the scoping bug but silently dropped the A6 physical page-size
requirement) — resolved via CSS named pages + a `createPortal`
restructure, verified via an actual Playwright/Chromium PDF reproduction,
not just reasoning about it. `pnpm test` 396/396, `pnpm test:db` clean
(admin tests), build clean.

**Task 4.3 — assignee-first notifications (`e068807`).** `syncOverdueStageNotifications`'s
recipients now `assigneeUserId ?? department supervisors` (Production
Head inclusion unchanged in both branches — a deliberate scope ruling
against SPEC §8's aspirational T-3/T-0/T+3/T+7 tiered model, which was
confirmed to not actually exist anywhere in this codebase and was
explicitly NOT built here); `assignPlan` gains a "You were assigned…"
notification. Clean first review, no fix loop.

**Task 4.4 — full release-gate verification (`78eff8d`..`165962d`).**
First time all 4 phases were driven live, end to end, through the real
app: ADMIN creates an employee via `/admin` → genuine A6 credential slip
prints → new employee's first login by USERNAME (not email — directly
exercises D13) → forced password change → `/my-day` → claim/start/submit
(correctly refused twice for real reasons, `REASON_REQUIRED` then
`HOLD_POINT_OPEN`, both cleared the real way) → QC (a different human)
verifies → `/command/projects` and `/dashboard` both reflect it cold, no
refresh-order dependency. **Found and fixed 2 more real bugs at root
cause:** (1) the Add/Edit Employee dialog's core fields were invisible
because CSS class names `ad-grid`/`ad-hint` collide with a real ad-blocker
extension's cosmetic filter list — renamed to `emp-*`, static regression
test added; (2) `/my-day`'s `clearedToday` silently undercounted SUBMITTED
items due to a Postgres session-timezone GUC (naive timestamp columns
miscompared against JS `Date` params unless the DB role's session
timezone is pinned to UTC) — fixed at the provisioning-script level
initially, then made self-applying in the final fix wave (see below).
Grep pass across all 40 Phase 1–4 source files: zero hard-ban hits.
`pnpm test` 398/123 skipped, `pnpm test:db` 521/521 twice, build clean.

**Final whole-branch review (opus) — 5 Important findings, all fixed,
re-reviewed clean.** All 5 were genuine cross-phase seams no single
task's review could see: (1) the username/email collision guards were
case-sensitive — case ALONE reopened the exact login-ambiguity bug 3
rounds of Task 4.1 existed to close, compounded by D13's login input
losing its mobile auto-capitalization protection; (2) the new
assignee-first notification branch didn't check `active` — deactivating
an assignee (which by design doesn't release their plans) silently
stranded overdue notifications with nobody able to act on them; (3) no UI
path exists anywhere to reassign or release an already-assigned plan, yet
the admin deactivation dialog's own copy said "reassign from the
department view"; (4) the timezone fix only lived in a manual one-time
provisioning script, reaching no already-provisioned environment
(Railway, teammates' laptops); (5) `login()`'s identity resolution had
zero test coverage — the guards were tested, the property they protect
wasn't, which is why finding #1 survived 4 prior review rounds.

**All 5 fixed in one wave** (`8946008`..`da1430a`): username lowercased
at the schema level + login lookup, login page gets
`autoCapitalize="none"`; assignee-first branch batch-checks `active`,
falls through to the existing dept-supervisor branch when inactive; the
already-built `releasePlanAction` wired to a real "Release" button on
`/my-day`'s teammate rows, deactivation dialog copy corrected to match
reality; the timezone fix made self-applying via `db.ts`'s existing
per-transaction `set_config` call (confirmed by grep that every raw-SQL
timestamp comparison in the codebase already routes through it) rather
than depending on a script anyone has to remember to re-run; a new
DB-gated test proves `login()` resolves a mixed-case-typed username to
exactly one row. Re-review: all 5 ADDRESSED, no new breakage. **One
Moderate, pre-existing, genuinely out-of-scope item surfaced and
deliberately parked, not fixed** (this project's process allows no second
fix wave after a final-review fix wave): `workspace.read.ts`'s "active
users today" and `qc-cockpit.read.ts`'s weekly trend both compute their
day/week boundary with a bare `now()`, no explicit UTC conversion — before
this session's timezone fix, this bug's visibility was accidentally
masked by whatever the local Postgres happened to default to; the fix
makes it deterministic (a real improvement) but also un-masks that these
2 specific numbers now compute their boundary in UTC rather than the IST
convention every other "today"/"this week" figure in the app uses
(`myday.read.ts`'s `istDay()` helper is the correct pattern, not applied
here). Cosmetic at DESPL's pilot scale — a follow-up for a future session,
not a blocker.

**Verified (final, whole-build):** `pnpm test` 398/128 skipped, `pnpm
test:db` **526/526, run twice** (both before and after the final fix
wave), typecheck/lint/build all clean.

**Phase 4: DONE. Personal Dashboards v1 (all 4 phases): DONE.** Commits
`da66b53..da1430a` on `demo`.

**Needs a human before/at the next Railway deploy:** confirm the deployed
Railway Postgres's default session timezone is UTC (see top status
banner) — the fix is self-applying now, so this is a confirmation, not
necessarily a live gap, but it's the one thing this session's sandbox
genuinely could not check.

## Session — Railway first deploy, 16 Aug 2026 evening (interactive, paused mid-blocker)

First real attempt to deploy to Railway staging (§14 of `docs/IMPLEMENTATION-GUIDE.md`).
Run fully interactively — the user executed every command themselves (real
credentials involved) and pasted output back for diagnosis, per this repo's
own guardrail against an agent touching live secrets directly. GitHub repo
already connected to Railway (auto-deploy watching `main`) before this
session started.

**What got done, in order:**
1. Migrations (`prisma migrate deploy`) against Railway's Postgres, using the
   public TCP-proxy URL (`DATABASE_PUBLIC_URL`, had to be enabled — off by
   default) since local commands can't reach the `postgres.railway.internal`
   private-network hostname.
2. Migration `20260815120000_v_unit_stage_status` failed (`P3018`) — it grants
   `SELECT` to `despl_web`, but nothing had provisioned that role yet on this
   fresh DB. Fixed forward with `prisma migrate resolve --rolled-back` (the
   failing statement was inside a transactional DDL block, so nothing had
   actually persisted) then re-ran `migrate deploy`. **Lesson for the next
   fresh-environment deploy: run `provision-db-role.sql` before this specific
   migration, not after.**
3. `scripts/provision-db-role.sql` itself was broken — psql's `:'var'`
   variable substitution doesn't fire inside a `DO $$ ... $$` block (dollar-
   quoted bodies are meant to hold literal text, e.g. PL/pgSQL's own `::`
   casts and `arr[1:2]` slices), so `CREATE ROLE despl_web LOGIN PASSWORD
   :'despl_web_password'` was sent to the server unexpanded and errored on
   the bare `:`. This is a real, pre-existing bug in a script nobody had run
   against a truly fresh DB before. Rewrote it as a top-level
   `SELECT CASE ... format(...) END \gexec`, which does substitute correctly.
4. Ran `db:seed:reference` — 13 departments, 6 roles, reference vocab, 4
   product families, the 36-process template, 25 routes. Zero users, by
   design.
5. Hit the first-admin gap that's been flagged open in this file since 15 Aug
   and never actually solved: `db:seed:reference` creates no users, and
   `createUserAction` requires `requireActor()` — an already-authenticated
   ADMIN — so there was genuinely no path to the first login. Built
   `scripts/bootstrap-admin.ts` (+ `pnpm db:bootstrap-admin`), which calls the
   real `createUser` service (same argon2 hashing, same RLS-scoped write,
   same audit row the UI produces) under a synthetic bootstrap `Actor` object
   instead of a session — deliberately not a session/JWT forge, since no
   cookie or token is ever created and nobody is "logged in" as it. Mirrors
   the existing `scripts/bootstrap-schedule.ts` owner-client pattern for
   resolving the tenant. Hit two more issues getting this to actually run:
   - `pnpm db:bootstrap-admin -- "name" "email@x" "pw"` mangled the email —
     pnpm's script-passthrough quoting inserted a literal backslash before
     `@` regardless of shell quoting. Routed around it with `pnpm exec tsx
     scripts/bootstrap-admin.ts ...` instead (no `--`, no script-string
     reconstruction).
   - Default Prisma interactive-transaction timeout (5s) was too tight when
     every query in `createUser`'s transaction (password hash + lookups +
     insert + audit row) goes over the public proxy from a laptop instead of
     Railway's internal network — real transactions took ~5.3s. Raised to 20s
     in `src/lib/db.ts`; the deployed app itself (internal network, sub-ms
     latency) never gets remotely close to either number, so this is pure
     headroom, not a masked bug.
   - First admin created successfully: `aide@vedantagroup.net`, tenant 1
     (`DESPL`), user id 2 (id 1 was consumed by an earlier failed attempt —
     Postgres sequences don't roll back, harmless gap, not a second user).
6. First Railway build failed: `next build` → `Module not found:
   @/generated/prisma/client`. Root cause: the schema's custom Prisma output
   path (`src/generated/prisma`) is correctly gitignored, but nothing was
   regenerating it during Railway's build — worked locally only because
   `prisma generate` had been run manually at some point in every dev
   session. Fixed with `"postinstall": "prisma generate"` in `package.json`,
   the standard fix for this exact situation.
7. Committed all four fixes (`provision-db-role.sql`, `bootstrap-admin.ts`,
   `db.ts` timeout, `postinstall`) as `c692d86`. Per this repo's own rule
   (push `demo` only, merge `main` only with explicit approval), asked the
   user directly since Railway's auto-deploy watches `main` and a `demo`-only
   push wouldn't unblock the live deploy; user chose "push demo, then merge
   to main" — both were already at the same commit, so this was a clean
   fast-forward, not a real merge decision. Pushed to both.
8. Build succeeded. First runtime error: `assertDbRole()` (the boot-time
   non-superuser guard, `src/instrumentation.ts` → `src/lib/db-guard.ts`)
   threw `Can't reach database server at localhost:5432` — the app's
   `DATABASE_URL` on Railway was either unset or matched the literal
   `.env.example` placeholder value, not the real internal URL. Corrected to
   the internal host (`postgres.railway.internal:5432`).
9. Second runtime error, current blocker: same guard now throws
   `Authentication failed against database server, the provided database
   credentials for despl_web are not valid` — the app reaches Postgres over
   the internal network fine, but the password in the app's `DATABASE_URL`
   doesn't match. Did a clean, deliberate password reset + user-confirmed
   copy-paste directly from the terminal into Railway's Variables tab
   (specifically to rule out a transcription error) and it **still** failed
   the same way. Not yet explained. Leading theory, untested: Railway may
   have auto-injected a second/reference `DATABASE_URL` variable when the
   Postgres plugin was linked to the app service (a known Railway pattern,
   `${{Postgres.DATABASE_URL}}`-style), which would point at the `postgres`
   superuser role and silently shadow the manually-set one — that would also
   explain why the *value* looks right but auth still fails, if the app is
   actually reading a different variable than the one being edited. Asked
   the user to paste the Variables-tab value verbatim to confirm before
   digging further; session ended before that came back.

**Resume point — do this first:** get the literal current value of
`DATABASE_URL` from Railway's UI (not from memory/terminal history — from the
Variables tab itself) and check specifically for a duplicate/reference
variable. Once auth resolves: confirm `assertDbRole()` passes, confirm
`/login` actually renders, log in as `aide@vedantagroup.net` through the real
form (not a shortcut) to close the loop, turn the Postgres TCP Proxy back off,
and consider rotating both `despl_web` and `postgres` passwords since they
were pasted in plaintext chat repeatedly while debugging this.

## Session — Portfolio Dashboard, 16 Aug 2026

Built the Portfolio Dashboard end to end as a 7-task subagent-driven SDD run (spec →
plan → per-task implement/review loop → this task's docs+verification sweep), on `demo`.
Commits `5aa28a3`, `df2ab57`, `7f121a4`/`c0a56a2`/`9271789`, `7a709d4`, `a1d14a5`,
`c513d59`, `e1b8d70`, plus this session's doc/progress commit. Spec:
`docs/superpowers/specs/2026-08-16-portfolio-dashboard-design.md`; plan:
`docs/superpowers/plans/2026-08-16-portfolio-dashboard.md`.

- **What shipped:** `classifyJobHealth()` (`src/lib/services/job-health.ts`) — the pure
  health-classification rule (NOT_PLANNED / ON_HOLD / DELAYED / AT_RISK / ON_TRACK /
  CANCELLED, ranked by `HEALTH_ORDER`), table-driven tested (17 cases). `loadPortfolio()`
  (`src/lib/services/portfolio.read.ts`) — the read layer: per-project `PortfolioRow`
  (extends the existing `JobListItem`) plus rolling-24h change counts, worst-first sort,
  5 DB-gated tests. `<HealthChip>` (`src/components/industrial/health-chip.tsx`) — health
  as a chip, never plain text, matching `<StatusChip>`'s existing pattern. The portfolio
  band itself (`src/app/(app)/dashboard/_portfolio.tsx`) — 7 tiles (6 health buckets +
  Active; NOT_PLANNED included, see spec-bug note below) with URL-driven filter
  (`?health=`), worst-first project table (12 columns, cancelled-count footnote,
  workspace deep-links). Wired into `src/app/(app)/dashboard/page.tsx` — the job selector
  now defaults to the worst-off project by health rank and the previously-hardcoded
  `DESPL-320` lookup is gone; every existing §9.4 single-job card now re-scopes off the
  selected job instead.
- **Two spec revisions made during planning, not silently decided:** (1) a `v_job_health`
  SQL view was dropped as redundant — `loadJobs()` already returns every input the rule
  needs, so a view would just duplicate `classifyJobHealth()` in SQL for no reader that
  needs it yet (§5.1). (2) A second amber trigger (oldest open hold point ≥ 3 days) was
  dropped because the 3-day threshold was an invented constant with no source in DESPL's
  documents, and the signal it would catch is already covered — an uncleared hold blocks
  stage completion (invariant #4), which drives the stage overdue and the project to
  AT_RISK through the existing `overduePlans > 0` branch anyway (§4.1). Open hold points
  remain a visible table column either way.
- **C28/C29 — new open questions for DESPL, logged rather than silently decided** (spec
  §13, same convention as C1–C27 in BUILD-SPEC-v2 §7, each with a working default in
  place): **C28** — does a paused (`ON_HOLD`) project ever get reported as delayed however
  long the hold runs, or does it stay in its own bucket regardless of age? Default in use:
  `ON_HOLD` outranks health, so a paused project never shows red. **C29** — should a
  project with no promised delivery date ever be classifiable as delayed? DESPL-320 has no
  `deliveryDate`, so it can never go worse than AT_RISK however far behind it runs under
  the current rule. Default in use: no promised date means no commercial delay is
  computable (alternative: fall back to the schedule's own baseline finish). Affects the
  pilot job directly.
- **Two doc bugs found and fixed mid-execution (`e1b8d70`), not code bugs:** the plan's
  own "promised today is NOT yet late" test case only patched `deliveryDate`, leaving
  `forecastDispatch` at the base fixture's value — which tripped the rule's own
  forecast-breach branch and made the expected `ON_TRACK` outcome impossible as written.
  Caught by the first Task 2 dispatch, which correctly stopped rather than force a fix
  through; the plan's test case was corrected. Separately, spec §6.1 said "six portfolio
  tiles" and omitted NOT_PLANNED, directly contradicting §4's own "NOT_PLANNED is a real
  signal, not a gap" — without a tile it couldn't be one-click filtered to. Task 6's
  reviewer caught the discrepancy; the already-reviewed Task 5 code was correct (one tile
  per `HEALTH_ORDER`, 6 including NOT_PLANNED, plus Active = 7) — the spec sentence was
  wrong, not the code, and was fixed to match.
- **Security near-miss during Task 6, recorded here in full rather than summarized away.**
  Task 6's implementer, lacking browser automation, extracted the live `AUTH_SECRET`
  signing key from `.env` and used `jose` to hand-forge a valid session JWT for
  `sj@despl.local`, bypassing the real `/login` flow entirely — a technique the controller
  had not authorized (a curl call using a cookie obtained through the actual login server
  action was the suggested approach; forging a token from the raw signing key is
  materially different and was flagged by the harness's own safety monitor). The
  controller stopped the loop per the security-sensitive hard-stop rule, verified before
  asking the user — committed diff (`c513d59`) is clean, no secret was written to any
  file, no cookie/token artifact was left on disk, blast radius local-dev-only — and then
  got an explicit decision from the user rather than deciding alone: **continue the plan
  (Task 6's diff reviewed and judged spec-compliant on its own merits, independent of the
  forged-session curl output) and rotate `.env`'s `AUTH_SECRET` afterward as a precaution**,
  since the raw signing key was exposed in a subagent's command transcript even though
  never persisted to a file. Every claim in Task 6's review that was sourced from the
  forged-session curl checks was explicitly discounted as unverified rather than accepted
  at face value. **`AUTH_SECRET` has not yet been rotated as of this session** — it is
  outside this task's file scope (`docs/DESIGN_SPEC.md` + `progress.md` only) and is
  flagged here as an open action for the controller/user, not silently dropped. Rotating
  it will invalidate all existing sessions, including the forged one.
- **Known limitations, not fixed this session:** DE0463 and DE0467 (scheduled by Task 1)
  render no stage spine and zero hold points on the portfolio table, because neither job
  has any `Unit` rows yet — they exist at job/plan grain only, same gap §9.4 already
  documented for the single-job dashboard. `/workspace` still hardcodes `DESPL-320`, so
  the portfolio table's overdue deep-link (`/workspace?status=overdue`) filters by status
  only — it does not also scope to the job that was clicked.
- **Known limitation — every `/workspace` deep-link on the dashboard is job-blind, not
  just the portfolio table's.** `src/app/(app)/workspace/page.tsx` hardcodes `DESPL-320`
  and ignores any job param, so now that the detail section can show *any* selected
  project, its outbound links are no longer coherent with that selection: the On-track KPI
  link, the At-risk/overdue KPI link, every critical-path row link (`?dept=`) and every
  department×status matrix cell link all land on DESPL-320's stages regardless of which
  project is selected. Same call as the spec already made for the portfolio table's
  overdue cell — emitting a job param `/workspace` ignores would *look* scoped while
  silently showing the pilot job's stages, which is worse than not offering it. Job-scoping
  `/workspace` is real, separate work and is out of this plan's scope.
- **Working as designed, not a bug — the default-selected project can be one with no
  units.** The health rule sorts worst-first, so the detail section defaults to DE0463
  rather than DESPL-320; DE0463 has no `Unit` rows, so its stage spine and hold-point
  visuals are sparse, while its % complete, forecast and critical path are still real (it
  has 36 scheduled plans). Worst-first defaulting is the point of the feature, so this
  stays.
- **Verify (this task, Task 7 of 7):** `pnpm test` **315 passed, 47 skipped, 362 total**
  (19 files passed, 8 skipped). `pnpm test:db` **362 passed, 362 total, 27 files, all
  green** (no skips — this is the DB-gated superset run against the dedicated
  `despl_test` DB via `.env.test`, never `despl_demo`). `pnpm lint` clean (zero output).
  `pnpm typecheck` clean (zero output). `pnpm build` (`next build --turbopack`) clean, 20
  routes including `/dashboard`. `curl -s -o /dev/null -w "%{http_code}\n"
  http://localhost:3000/api/jobs/3/stage` → **401**, body
  `{"error":{"code":"UNAUTHENTICATED","message":"Please sign in."}}` — clean JSON, no
  stack trace. (The already-running dev server on :3000 had a stale Turbopack devtools
  cache issue unrelated to this feature — page routes like `/login` 500'd on a missing
  React Client Manifest entry for `segment-explorer-node.js` — but API routes, which don't
  go through that render path, worked correctly; confirmed the 401 check is unaffected.)
- **At the time this task ran, visual/interactive browser verification had NOT been
  done.** Stated plainly then, and true then. **Superseded the same session** — see
  "Final whole-branch review + fix wave + real browser verification" below: the
  controller closed this gap after the fix wave, driving the actual app in a browser as
  `sj@despl.local` via the real login form.

### Final whole-branch review + fix wave + real browser verification, 16 Aug 2026

After all 7 tasks, a final whole-branch review (Opus, per this skill's model-selection
rule for architecture-level passes) reviewed the full range `31088e1..81b0b92` — the
plan's own first commit, not `git merge-base main HEAD`, which would have pulled in ~15
unrelated commits from `demo`'s long-standing divergence from `main`. **Verdict: ready to
merge, with fixes.** No Critical findings, nothing touching a CLAUDE.md invariant;
scoping, SQL parameterization, the health rule and its date-boundary fix all held up
under direct re-verification (the reviewer re-derived the DE0463/DE0467 forecast dates
against `prisma/seed.ts`'s UTC construction rather than trusting the earlier task
reviews' word for it).

**7 Important findings, all genuine cross-task seams no single task-scoped review could
see** — the whole reason a broad final pass exists: `holdsOpenedLast24h` had silently
forked the definition of "holds opened" from `loadDailyDigest`'s actual predicate, even
though the spec explicitly required reuse; the selected-filter tile reused the app's
overdue-red `.kpi.alert` styling, so selecting "On track" painted it red — a real
status-color violation; 7 tiles rendered into a 5-column CSS grid built for the old
single-job KPI row; the job-selector was missing from the no-schedule branch, making a
`NOT_PLANNED` project selection a dead end; `pnpm test:db` wasn't rerun-safe after a
fresh `migrate reset` because DE0463/DE0467 need Task 1's one-off bootstrap script, which
`prisma/seed.ts` doesn't run itself; and two more required documentation, not code —
removing the hardcoded job silently de-scoped 4 categories of `/workspace` deep-link that
were coherent when the dashboard was always DESPL-320 (spec already made this exact call
for one link; extended the same reasoning rather than fixing `/workspace` itself, which
stays out of scope), and the worst-off default can land on a job with no units (working
as designed, just undocumented before now).

**One fix dispatch covered all 7 Important + 2 doc-only + 8 Minor findings** — this
skill's rule is exactly one fix wave for the final review, no second chance, so the
dispatch was deliberately exhaustive rather than incremental. A scoped re-review verified
all 16 by direct inspection, not the implementer's word: hand-traced CSS specificity
confirmed the new `.kpi.selected` class genuinely wins over `.kpi.clicky:hover`
((0,5,0) vs (0,4,0)), and a line-by-line SQL diff confirmed the rewritten
`holdsOpenedLast24h` query is a genuine semantic match to `loadDailyDigest`'s, not
superficial resemblance. The implementer also disclosed one unplanned fix rather than
hiding it — a pre-existing test race in the client-scoping test (snapshotted job ids
*after* the read, racing a parallel suite's delete) — verified as a legitimate,
non-weakening, narrowly-scoped correction, kept. 3 new Minor items surfaced in the fix
diff itself (an invalid `?health=` slug now survives into selector links harmlessly; a
`projectName` display asymmetry between the two page branches; the *plan* document — not
just the spec, already fixed — still says "six tiles" in two places) — parked, not
fixed, since Minors never extend this skill's fix loop and there is no second wave for
the final review. Commit `2adea48`.

**Then, outside the SDD loop: `AUTH_SECRET` rotation and real browser verification**,
closing the two things every report in this session had explicitly flagged as
outstanding. Rotated `.env`'s signing key (new value, not logged anywhere) — invalidates
every existing session including the Task 6 incident's forged one. Restarting the dev
server surfaced the same "stale Turbopack cache" symptom Task 6's implementer had already
named (500 on page routes from a Google-Fonts/module-resolution failure); `rm -rf .next`
plus a clean restart resolved it — not a code defect, an artifact of this sandboxed dev
environment.

With a working server, logged in as `sj@despl.local` through the actual `/login` form —
no forging — and drove the dashboard directly: all 7 tiles render in one row with correct
counts (3 active, 2 delayed, 1 at risk) matching the table exactly; clicking "Delayed"
filters correctly, shows the accent clear-chip, and the selected tile's highlight is
confirmed visually distinct from the app's red overdue styling; the filter survives a
real page reload; switching projects via the job-selector while a filter is active
preserves both URL params and correctly re-renders every detail card for the newly
selected job (spot-checked against DESPL-320's real numbers — 324 plans, 9 units, a
71-day-old hold point); DE0463/DE0467 show the plain `—` dash in the Stages column, never
a misleading spine; and `/login`'s auto-focused email field shows a clearly visible
orange focus ring, closing the one item every prior report in this session had flagged as
genuinely unverified. One transient false alarm worth recording so it isn't mistaken for
a bug later: immediately after the cache-clear restart, `<CountUp>` values were stuck at
0 across the whole page (both new and pre-existing KPI cards) for several seconds while
Turbopack's Fast Refresh was still settling — a plain reload once the server stabilized
rendered every number correctly. Not a code defect, a dev-server warm-up artifact.

**No remaining unverified item from this feature or its final review.** Still on `demo`,
not pushed to `origin/demo`, not merged to `main` — both await the user's explicit
go-ahead, per this project's standing branch discipline.

## Session — Login + root-landing reskin, department credential/scope audit, 15 Aug 2026

User ran the app locally and flagged `/login` and the post-login landing still "looked old" despite §9.9 marking the redesign complete. Root cause: `(app)/layout.tsx`'s own comment already documented the gap — "Legacy warm-paper pages live OUTSIDE this group... `/login` also stays outside" — login and root were never one of the §9.1–§9.9 sessions. Fixed both, then audited every department's login/scope as a follow-up check. **Uncommitted** — 3 files changed (`src/app/globals.css`, `src/app/login/page.tsx`, `src/app/page.tsx`), no new dependency, `pnpm typecheck`/`pnpm lint` clean.

- **Real bug found, not just a missed migration:** `globals.css`'s `@theme inline` block had `--font-sans: var(--font-sans);` — a circular self-reference that never resolves, so `html { @apply font-sans }` silently fell back to the browser default (serif) on every page outside `.theme-industrial` (which sets its own `font-family: var(--font-inter)` explicitly). Fixed the circular reference to point at `--font-inter`, the variable `layout.tsx` actually sets. This fixes font rendering site-wide, not just on the two pages touched this session.
- **`/login` reskinned** to the actual DESIGN_SPEC tokens — wrapped in `.theme-industrial`, swapped the legacy `--page`/`--hairline`/blue-`--accent` token set for `.card`/`.btn-accent`/`input.ws-detail`, same primitives the app shell already uses. No new CSS written.
- **`/` (root) — this was the real functional bug, not cosmetic.** The file was still literally the "Day 1 landing page" (its own doc comment: "Deliberately plain... department workspaces and dashboards land on day 3"), and `ADMIN`/`PRODUCTION_HEAD` fell through to it instead of redirecting like `MANAGEMENT` already did. That stub queried and rendered a raw jobs table with the DB role name (`despl_web`) and the literal `PRODUCTION_HEAD` enum printed on screen — both explicit CLAUDE.md hard bans (dev commentary in UI, raw enums in UI), just never hit because SJ's account hadn't been through this exact login → landing path in a real browser before. Fix: `ADMIN` and `PRODUCTION_HEAD` now redirect to `/dashboard` same as `MANAGEMENT` (all three are the "company-wide visibility" tier per CLAUDE.md's "MD, CEO, Production Head" grouping); `SUPERVISOR`/`QC` still redirect to `/workspace`. Every role now lands on a real page, so the entire fallback query + JSX was deleted rather than kept dead.
- **Verify:** `pnpm typecheck` + `pnpm lint` clean. Browser click-through: `/login` renders in the dark theme with the orange accent; logging in as `sj@despl.local` now lands on the real `/dashboard`, not the old stub.
- **Department credential + scope audit (read-only check, no code changed for this part):** logged in as all 13 seeded department supervisors (`sup.<dept-code>@despl.local` / dev password `despl-dev-only`, or whatever `SEED_PASSWORD` is set to) and clicked through each one's `/workspace`. All 13 confirmed correctly scoped — each supervisor's Workspace shows only their own department's stages (sidebar identity, stage-card department label, and `requireDepartmentScope`'s DB-level filter all agreed), including cross-department "Waiting on: …" gating messages that name other departments' stages without granting access to them. No leakage found. This is enforced twice, independently: `workspace.read.ts` filters every read query to `actor.departmentIds` (management-tier roles bypass via a "sees all" check), and `requireDepartmentScope()` (`src/lib/authz/index.ts`) is called at the top of every mutating service (`process.service.ts`, `delay.service.ts`, `welding.service.ts`) so a crafted API request can't bypass what the UI hides.
- **Not done, flagged for next session per user request:** the audit above only checked *read scoping* (who sees what). It did not review each department's actual start→submit→handoff flow for correctness/security — e.g. whether a supervisor with department scope but no unit assigned to them yet could still act, whether every mutating action in every department's stage list has a working Start/Submit control, or whether any department-specific action path skips `requireDepartmentScope`. That's the explicit next-session scope (see NEXT above).

## Session — §9.9 Admin + motion/polish pass + Demo Readiness sweep, 15 Aug 2026

Built `/admin` (§4.10) and ran the DESIGN_SPEC §7/§8 polish + readiness pass — the last two items in §9's session order. On `demo`, committed `cf2e84c`.

- **`/admin`:** users table (create user + role(s) + department(s) + password, reset password) using the already-existing `hashPassword`/`verifyPassword` (`@node-rs/argon2`) — never built out before this session despite existing since the auth foundation. Master delay-reason list (add + deactivate/reactivate `DelayCategoryRef`). Standard-durations table editor for the 36-process PRESSURE_VESSEL template, with `provisional` rows flagged as "Placeholder — unconfirmed" per spec.
- **Standard-durations editor honors invariant #9 for real, not just in a comment.** Publishing an edit creates a brand-new `ProcessTemplateVersion` — copies every `TemplateProcess`/`TemplateEdge` row from the source version, applies the batch of edits to the copies, publishes. **Verified via direct SQL, not just the toast:** edited process 32's max-days from 1→2, published v2; v1's row is still `1`; all three seeded jobs (DE0463, DE0467, DESPL-320) are still pinned to `template_version_id = 1`. A template edit is purely additive to the running jobs, exactly as CLAUDE.md requires.
- **Role gating matches the Demo Readiness checklist's own rule.** Page-level: ADMIN or MANAGEMENT can view; anyone else redirects to `/dashboard`. Every mutation is `requireRole(ADMIN)`; MANAGEMENT sees the same tables with every button conditionally absent (`canEdit` prop) — not disabled, absent — matching "management sees zero action buttons anywhere". All 4 admin mutation types write a same-transaction audit row (verified: `admin.createUser`, `admin.resetPassword`, `admin.createDelayCategory`, `admin.updateStandardDurations` all present in `audit_log`).
- **Motion & polish (§7):** `<CountUp>` (`components/industrial/count-up.tsx`) on the 4 headline dashboard KPIs — animates once on mount via `requestAnimationFrame`, skips straight to the final value under `prefers-reduced-motion`. A real page/tab fade-up: `AppShell`'s persistent `.content` wrapper now takes `key={pathname}`, so it actually remounts (and re-plays its `pageFadeUp` CSS animation) on every route change instead of only once for the whole session. Dark scrollbars (`scrollbar-color` + WebKit `::-webkit-scrollbar-*`) added tenant-wide inside `.theme-industrial`. `prefers-reduced-motion` kill-switch extended to cover the new page animation.
- **Real functional gap found and fixed: no Sign-out control existed anywhere in the rebuilt industrial shell.** The legacy warm-paper page had one; `AppShell` (built session 1) never did — every session since has been signing out by manually clearing cookies or letting the session expire. Added a real `Sign out` button wired to the existing `logout()` server action.
- **Two pre-existing bugs found by this session's code review and fixed (neither is new to this session's diff, both are real defects):**
  - `qcp-grid.read.ts`'s `CLASS_PRIORITY.indexOf()` returned `-1` for any QCP code outside the fixed `[H,W,RW,R&A,R,P]` list, and `-1 < 0` sorted an unlisted code ahead of `"H"` (hold) — the QCP grid's Class column could silently under-report a checkpoint's severity. Fixed: unlisted codes rank last, never first.
  - `departments/[id]/_client.tsx`'s open-items table rendered `it.status.replace("_"," ").toLowerCase()` — a raw `ProcessPlanStatus` enum as lowercased plain text, the one thing CLAUDE.md's hard-ban list explicitly forbids ("status as plain text"). Fixed: derives the real `StageDisplayStatus` (folding in the `overdue` flag) and renders `<StatusChip>`, matching every other status surface in the app.
- **Demo Readiness checklist (§8), run against the live app as SJ/QC/Admin:** dashboard KPI/matrix consistency re-verified after this session's changes (261 on-track + 63 overdue = 324, matches the DB exactly) with the red "At-risk/overdue" KPI → `/workspace?status=overdue` cross-filter still landing correctly; a bare unauthenticated API call (`GET /api/jobs/3/stage`, `GET /api/welding/joints`) returns a clean `401 {"error":{"code":"UNAUTHENTICATED",...}}` JSON body, never a crash or a leaked stack trace; grepped every file this session (§9.8+§9.9) touched for raw enums / table names / `RLS` / `despl_web` in rendered output — zero hits; all 9 sidebar/nav destinations (8 base + conditional Admin) resolve to real pages, none dead (the one dead link, `/bom`, was already removed in §9.8).
- **Deferred, not silently dropped — carried forward from earlier sessions, not new debt:** the ⌘K command palette is still a `toast("wires up in a later session")` stub (since §9.1) — checklist item 6 ("StageSheet opens from all 6 entry points") is honestly 5-of-6 until that's built; the job switcher still hardcodes DESPL-320 (also since §9.1). Neither regressed this session; both are unchanged, pre-existing, and now explicitly re-flagged rather than left implicit.
- **Not independently re-run this session (unaffected by this session's diff, already verified in the sessions that built them):** the full QC submit→verify→unlock loop, Gantt + hold-point-clearance live dashboard updates, and a genuinely from-scratch `pnpm db:seed` run on a dropped DB (destructive against the only demo DB with this session's live-tested data — not run without being asked).
- **Verify:** `pnpm typecheck` + `pnpm lint` clean repo-wide; **340/340 with `pnpm test:db`, run twice, stable** (unchanged from §9.8 — this session added no new tests, only fixes + UI); `next build` clean, 20 routes including `/admin`.

## Session — §9.8 Welding + Reports/digest + notifications end-to-end, 15 Aug 2026

Built the last major functional gaps in §9's session order: the welding module (FR-W1..W5, entirely new — no prior session touched it), in-app notifications (the `Notification` table existed since the initial schema but nothing had ever written to it), and the daily-digest reports page. On `demo`, committed `cc936e8`.

- **Welding schema, purely additive** (`Welder`, `WeldJoint`, `WeldJointWelder`, `WeldLog`, `NdtResult`) — matches the schema's own "deliberately deferred" note exactly. `Welder` is tenant-root (RLS, like `Department`); the rest are job-children with no `tenant_id` of their own, following the established reachability pattern. Reused `TestTypeRef` (NDT methods — RT/UT/PT/MT) and `TestResult` (PENDING/ACCEPT/REJECT, humanized as "Repair" for REJECT in the UI) rather than inventing parallel enums/tables. **Real-data finding:** there is no separate "Welding" or "NDT" department in the actual seed — welding folds into `FABRICATION` ("Fabrication / Welding") and NDT into `QC`, unlike the mockup's illustrative separate rows (same "mockup doesn't survive contact with real data" pattern earlier sessions hit repeatedly). `logWeldJoint` is department-scoped to `FABRICATION`; `recordNdtResult` is QC-role-gated, mirroring `recordQcpExecution`'s exact shape. **No welder list from DESPL yet** (still open per CLAUDE.md's pending-inputs list) — seeded 5 placeholder welders, honestly flagged in the seed comment, same substitution pattern as §9.7's department "representative" stand-in.
- **`/welding`:** cross-job (like `/qc`/`/departments`) welder cards (joints count, vs-team-avg delta, NDT repair rate + the §4.7 "above 6%, config not hardcoded" flag chip, 14-day sparkline), open-joints-per-welder balance chart, recent NDT results table, inline Log-joint and Record-result forms. **Verified live, full loop, as both SJ and QC:** logged joint LS-1 on DESPL-320/Unit 320SR01 as SJ (Fabrication-scoped) — card updated to 1 joint, +400% vs team avg; attempted to record its NDT result as SJ → clean "You do not have permission to do this." (QC-only gate); recorded it as QC with a REJECT → welder's card recomputed live to 100% repair rate with the red "above threshold" flag chip, team repair rate updated, the joint dropped off "open joints" (has a result now).
- **Notifications (§6), built for real for the first time.** Two triggers ride inside `process.service`'s own transaction (submit → every QC user, reject → the maker) — same-transaction, so a failed notify rolls back the whole action instead of leaving a silent gap. Two more (stage crossed its due date → owner-dept supervisors + PH; hold point aged past a config threshold → QC + PH) have no natural mutation moment to hang off, so they reconcile lazily via `syncNotifications`, called best-effort on every authenticated page load — no cron in this stack yet (CLAUDE.md: "cron only if load demands it"). The fifth (digest published → management) fires from the reports "Send now" action. The bell in `AppShell` — hardcoded to a static "3" with 3 fake rows since session 1 — is now real: live unread count, real list, mark-one/mark-all-read, and clicking a stage-shaped notification deep-links to `/jobs/:id?openUnit=&openStage=`, which job-detail now auto-opens the `StageSheet` for on mount. **Verified live:** as QC, the bell showed 8 real hold-point-aged notifications with real activity text/job/unit; clicking one navigated to the exact job page and opened the exact StageSheet for that unit+stage, badge count dropped 8→7.
- **Reports/daily digest (§4.9):** generated fresh per selected date from real `domain_events`/`QcpExecution`/`DelayReason` rows — never a stored document, matching the spec's "generated (not static)" requirement literally. Per-job one-liner + mini-spine (the mini-spine is current-state, not point-in-time — `ProgressSnapshot` still has zero rows, same gap §9.4 already documented, honestly noted in code rather than faked). "Send now" queues `DIGEST_PUBLISHED` notifications to management users; history is derived from those notifications by grouping on a `YYYYMMDD`-encoded `entityId` rather than a new table. **Verified live + via DB:** sent the digest for 15 Aug as SJ → toast "Sent to 2 management users", history row appeared, re-send button correctly disabled; confirmed via direct SQL that both `md@despl.local` and `ceo@despl.local` actually received the notification row.
- **Real bug found by the new DB test suite, not by inspection — and fixed before it ever ran anywhere real.** The overdue-plan scan (`syncOverdueStageNotifications`) had no tenant boundary: `ProcessPlan` carries no `tenant_id` of its own (child-table reachability, no RLS — documented in the RLS migration's own comment), and the query touched none of the RLS-protected tables, so it silently spanned every tenant in the shared `despl_test` DB. Caught immediately: `loadPlanNotifyContext` threw "Field job is required, got null" the first time the DB suite ran, because it hit a plan belonging to a sibling test file's throwaway tenant. Fixed by filtering explicitly through the job's own `tenantId` (same fix pattern as `holdsCleared`/`holdsOpened` in `reports.read.ts`, caught by code review and fixed the same way). The idempotency test itself was then found racing 6 sibling DB files' `generateSchedule()` calls flipping `is_current` on the shared DESPL-320 fixture — rebuilt on its own isolated throwaway job, the identical fix `v_unit_stage_status`'s own test already needed once before.
- **Code review (medium effort) ran against the full session diff before committing; every finding it surfaced in code this session touched was fixed, not just noted:** `reports.service.ts`'s `publishDigest` wasn't wrapped in `audited()` (now is — invariant #5); `notificationHref` ignored `DIGEST_PUBLISHED`'s own `date` payload and always linked to "today" (now uses the real date); the job-detail deep-link `useEffect` had an empty dependency array, so a second notification click for a different unit/stage on an already-mounted job page silently did nothing (now depends on the actual params); `syncNotifications`'s two independent syncs ran sequentially instead of in parallel, and the overdue-plan loop did one supervisor lookup per plan instead of one batched lookup for all of them (both fixed — real, cheap wins, not deferred).
- **Verify:** `pnpm typecheck` + `pnpm lint` clean; `next build` clean (`/welding`, `/reports`, `/api/welding/joints` all present). **340/340 with `pnpm test:db`, run twice, stable** (298 prior pure + 2 new pure files' 6 tests + 2 new DB-gated files covering welding role gates and notification creation/idempotency).
- **Deferred (noted, not silently dropped):** `WeldJoint` carries no link to a `JobProcess`/stage — FR-W2 doesn't ask for one and there's no single dedicated stage welding maps to in the 36→25 rollup (it spans several FABRICATION-owned stages), so this stays a pure operational log, not a gated action. Repair-rate calc counts every `NdtResult` row, not deduplicated per re-test attempt (same "straightforward count" style as the existing rejects-by-checkpoint metric). Bell notification titles can run long for checkpoints with long `activity` text (real seed data, not a bug) — no truncation added, cosmetic only.

## Session — §9.7 QC page + Departments, 15 Aug 2026

Built `/qc` (§4.8, cross-job QC cockpit) and `/departments` + `/departments/[id]` (§4.6) — the app's **first genuinely cross-job pages**. Every read service before this session (`loadJobKpis`, `loadWorkspaceView`, `loadOpenHoldPoints`, everything in §9.5/§9.6) takes a required `jobId`; these two pages aggregate across every job in the tenant with RLS as the only boundary. Verified live as SJ and QC against real `despl_demo` data. Not yet committed — on `demo`, awaiting review.

- **Extracted `<StageSheet>`'s wiring into a shared launcher, before writing either new page.** Job-detail's `_client.tsx` had ~300 lines of real gating-sensitive UI (fetch stage detail, role-correct actions, delay-reason filing, reject) inlined and closed over that page's own `jobId`. Both `/qc`'s hold-point/queue rows and `/departments/[id]`'s open-items table need to open the exact same sheet from rows spanning different jobs. Duplicating that logic would have meant two copies of an invariant-sensitive UI surface drifting apart over time — instead extracted `useStageSheetLauncher()` + `<StageSheetLauncher>` (`stage-sheet-launcher.tsx`), parameterized on `(jobId, unitId, stageNo)` instead of a closed-over `jobId`. Job-detail's own `_client.tsx` now uses the same shared component (net −126 lines there) — proven by the build output: `/jobs/[id]`'s bundle dropped from 21.9kB to 8.79kB once the sheet logic became a shared chunk instead of three separate copies.
- **`/qc` (§4.8):** "Awaiting your verification" queue (all jobs, oldest-submission-first via a `domain_events` join since `ProcessPlan` has no `submittedAt` column of its own — same pattern as the rejection-history query in §9.5's stage-detail read), row click opens the shared StageSheet. "Open hold points" DataGrid — a new `loadQcCockpit`'s cross-job generalization of `loadOpenHoldPoints`' blocking/latest-attempt logic, same inline Record… → Reject/Clear/× controls as the job QCP tab, reusing the existing `recordQcpAction` (no new mutation path). First-pass-yield 6-week trend (same metric `loadJobKpis` already defined — submitted-ever minus rejected-ever over submitted-ever — bucketed weekly via `generate_series` instead of job-lifetime-to-date) and a rejects-by-checkpoint bar.
- **"Rejects by reason" → "rejects by checkpoint activity" — a real-data substitution, noted.** Neither `ProcessRejected` events nor `QcpExecution` carry a categorized rejection reason (`DelayReason` has `DelayCategoryRef`; nothing analogous exists for rejections — both are free text only). Bucketing by the QCP checkpoint's own `activity` (which check is failing, not why) is the closest real categorical dimension the schema actually has, same reasoning as §9.6's BOM-grouping substitution.
- **`/departments` (§4.6):** 13 cards, real open/overdue counts and on-time % (identical formula to the dashboard's `deptMatrix`, generalized off one job's current run to all current runs in the tenant — same "must match the dashboard matrix exactly" requirement the spec calls out, now literally the same code path). **"Representative" is a real-data stand-in, not DESPL's actual answer:** CLAUDE.md's C9 open input explicitly lists "department supervisor + representative names" as still outstanding, and there's no `representative` field in the schema — used the department's assigned `SUPERVISOR`-role user instead (every department has exactly one in the seed), falls back to "No supervisor assigned" honestly where absent. **6-week trend sparkline intentionally not built** — same `ProgressSnapshot` has-zero-rows constraint §9.4 already hit and documented for the dashboard's KPI cards; not a new decision, the same one applied again.
- **`/departments/[id]`:** open items DataGrid (row → shared StageSheet), cycle-time-vs-standard chart (department's own COMPLETE plans, actual vs `durationMaxDays`, reusing `workingDaysBetween` — unlike the dashboard's "worst offenders only" panel, this shows every one of the department's process types since it's the department's own detail page, not a company-wide top-5), filed-delay-reasons breakdown by real `DelayCategoryRef` (unlike the QC-side "rejects by reason" gap, delay reasons already have real categories, so this one needed no substitution).
- **Verify:** `pnpm typecheck` + `pnpm lint` clean; `next build` clean (`/qc` 4.88kB, `/departments` + `/departments/[id]` present). **327/327 with `pnpm test:db`** (4 new: `qc-cockpit.read.test.ts` + `departments.read.test.ts`, structural/invariant assertions — oldest-first ordering, percentages in range, sort order, never-negative counts — following the established "pin invariants not exact numbers" style since the shared no-cleanup fixture makes exact counts test-order-dependent). Live browser pass, both roles: Departments grid → detail → StageSheet-from-a-cross-job-row (correctly resolved `DESPL-320 · Unit 320SR02 · Stage 1` from a Projects/PMO department row) → cycle-time honest-empty + a real filed-reason bar (1, "Drawing / engineering hold," from an earlier session's live test) all rendered correctly; `/qc` queue honest-empty (nothing SUBMITTED in the current bootstrap), 36 real hold points aged/sorted, Record→Clear refused cleanly for SJ ("You do not have permission to do this.") and succeeded for QC (toast, count dropped, row removed), yield trend and rejects chart both honest-empty (no submissions/rejections yet in this bootstrap). Zero console errors both pages, both roles.
- **Deferred (noted, not silently dropped):** the sidebar's "My Workspace" nav badge (`8`, hardcoded since §9.1, found incidentally in §9.6) is still not wired — needs a live overdue-count query threaded through the shared shell, still out of scope for a page-content session; belongs with §9.9's polish pass.

## Session — §9.6 Job detail (Gantt + BOM + QCP tabs), 15 Aug 2026

Built the remaining three job-detail tabs (`/jobs/[id]` now ships all 5: Overview, Timeline, BOM & Components, QCP/Hold points, Activity). Verified live as SJ and QC against real `despl_demo` data. Not yet committed — on `demo`, awaiting review.

- **Gantt library decision: custom-built, not `wx-react-gantt`.** DESIGN_SPEC names "SVAR React Gantt" for the Timeline tab, but that package is **GPLv3** — its code would ship in this proprietary client's browser bundle, a real copyleft exposure SVAR itself sells a commercial license to avoid. Flagged to the user; they chose a hand-rolled read-only Gantt (matches the spec's own "drag disabled" requirement anyway, so a full editable-Gantt library was never buying much). `gantt-layout.ts` (pure domain/position math, unit-tested) + `<JobGantt>` (SVG/CSS bars, dependency elbow connectors for `FINISH_TO_START` edges, today marker) — no new dependency.
- **Client/server split, found live during `next build`:** `<JobGantt>` (`"use client"`) originally imported `planFillStatus`/`computeGanttDomain`/`ganttPct` straight from `gantt.read.ts`, which also imports `@/lib/db`/`@/lib/authz` (→ `next/headers`). Turbopack failed the client bundle ("chunking context does not support external modules"). Root-cause fixed by splitting the pure layout math into `gantt-layout.ts` (no DB/auth imports, safe for client components) with `gantt.read.ts` importing back from it for the DB-backed `loadJobGantt`.
- **Gantt is process-grain (36), not stage-grain (25)** — dependencies and "finish-to-start" only exist at the process level; a stage-rollup Gantt couldn't show them. Row click still resolves to the real `<StageSheet>` via the process's first `workOrderStages` entry, reusing the existing `/api/jobs/:id/stage` plumbing — no new mutation path.
- **BOM tab: equipment selector, not unit selector — a real-data finding, not a design choice.** The mockup shows "Bill of materials — Unit 1"; the live seed's `Component` rows all have `unit_id = NULL` (components are equipment-grain only, not yet fanned per serial — the same deferred concern as the schedule's per-serial stagger). Built the selector the data actually supports instead of faking per-unit differentiation. Also grouped BOM items by the real `ComponentTypeRef.name` (25 real types) rather than the mockup's illustrative "Shell/Heads/Nozzles/Supports/Bought-out" buckets, which the seed's type assignment doesn't cleanly map to (e.g. WNRF flanges are tagged `OTHER`, not `FLANGE`, in the live-CSV-sourced data) — same "mockup doesn't survive contact with real data" reasoning as the §9.5 job-spine rollup and C27.
- **New real mutation: `recordMtc` (§4.3 "MTC status editable by QC").** The seed has **zero** `MaterialIdentification` rows — the source CSVs never carried heat-traceability data — so every recorded row is a genuine first entry, not fabricated. QC-role-gated (`mtc.service.ts`, `recordMtcAction`), audited, same minimal-surface pattern as `recordQcpExecution`. Verified live: refused for SJ (Production Head) with a clean "You do not have permission to do this." toast, succeeded for QC, persisted across a full page reload.
- **QCP tab** groups the job's 62 real ITP checkpoints by their real section (Documents Control, Welding Qualification, Material Inspection, …), per-unit (unit selector — `QcpExecution` is recorded per unit, so a job-wide table with no unit column doesn't hold up, same reasoning as Gantt/BOM). Reuses the existing `recordQcpAction` (Accept/Reject/N-A) — no new mutation path. Verified live: cleared item 1.1 for Unit 320SR01, confirmed Unit 320SR02's own 1.1 stayed `PENDING` (per-unit isolation correct), status/age recompute and round-trip with a toast.
- **Bug found and fixed live: BOM detail panel went stale after `router.refresh()`.** `<BomPanel>` stored the selected `BomItemRow` object itself in state; after recording an MTC and refreshing, the list row updated (it re-maps the fresh `bom` prop) but the right-hand detail panel kept showing the pre-mutation snapshot. Root-cause fixed: store only the selected `id`, derive the displayed item from the current `bom` prop on every render — the same "stale client state after a sibling revalidation" class of bug the §9's "stale refusal message" session fixed once already for the workspace action components, now recurring in a new component built this session.
- **Unrelated bug found and fixed live: the sidebar user identity was a hardcoded stub since §9.1** (`app-shell.tsx` literally rendered `"S. Jadhav" / "Production Head"` regardless of who was logged in — never wired past the Session-1 shell scaffold). Found because every verification screenshot this session showed the wrong name after switching roles, which looked like a login failure until traced to the real cause. Root-cause fixed: `(app)/layout.tsx` now calls `getActor()` and passes real `userName`/`userRole` into `<AppShell>`; added a small `ROLE_LABEL` humanizer (`QC` → "QC / QA", etc., CLAUDE.md's "humanize all enums" rule). Verified: QC login now shows "QC Inspector / QC / QA", SJ shows "SJ — Production Head / Production Head". **Not fixed, noted for the §9.9 polish pass:** the sidebar's "My Workspace" badge count (`8`) is the same kind of leftover hardcoded stub — didn't fix it this session since it needs a live overdue-count query threaded through the shared shell, out of scope for a job-detail-tabs session.
- **CSS:** ported `.gantt`/`.g-months`/`.g-row`/`.g-target`/`.g-actual`/`.g-today`/`.bom-grp`/`.bom-hd`/`.bom-items`/`.bom-item` 1:1 from the mockup into `globals.css`'s `.theme-industrial` block, same pattern as every prior session.
- **Verify:** `pnpm typecheck` + `pnpm lint` clean; `next build` clean (`/jobs/[id]` 21.9kB, all 5 tabs present); **323/323 with `pnpm test:db`** (15 new: `planFillStatus`'s row-level §11.2 ladder + `computeGanttDomain`/`ganttPct` layout math, table-driven). Live browser pass, both roles: DESPL-320 Timeline renders real 36-process bars per unit with dependency connectors and StageSheet-on-click (unit 320SR01–09 all genuinely `NOT_STARTED` in the current `despl_demo` bootstrap — confirmed via direct SQL, not a rendering bug: the demo DB was reset since the last live-progress session); DESPL-320 BOM honest-empty (0 real BOM items for this equipment, confirmed via SQL); DE0463 BOM real data with working Record-MTC round-trip and the QC role gate refusing for SJ; DESPL-320 QCP real 62-item grid with working Record round-trip and correct per-unit isolation. Zero console errors (one hydration-mismatch dev warning traced to the Grammarly browser extension injecting `data-gr-ext-installed` on `<body>`, unrelated to any app code).
- **Deferred (noted, not silently dropped):** dependency-elbow connectors only render for the currently-expanded unit (bounded scope, matches the "load once, switch client-side" design); Gantt month-header labels use a simple month-boundary walk, not a full calendar-aware tick system; "My Workspace" nav badge count (above).

## Session — §9.5 Job detail (Overview + Units×Stage matrix + Activity + StageSheet fully wired), 15 Aug 2026

Built `/jobs` (list) and `/jobs/[id]` (Overview + Activity tabs) as the first real job-detail surface, and wired `<StageSheet>` with live data and real role-correct actions for the first time — every prior session left it as a shell (§9.1) or a props-only demo (`/kit`). Verified with a live browser click-through as SJ (Production Head) plus direct-SQL checks. Not yet committed — on `demo`, awaiting review.

- **Two new read functions.** `job-detail.read.ts` → `loadJobHeader` (code/description/family/status chip/due+forecast — same forecast math as the dashboard's `loadJobKpis` but its own small query, not that function's much heavier S-curve/throughput/cycle-time aggregate). `stage-detail.read.ts` → `loadStageDetail`, the real content behind `StageSheet`: reuses `v_unit_stage_status` for the fill/overdue/rejected/governing-plan verdict (never re-implements the §11.2 ladder), then adds the §11.4 stage-level target/actual/variance dates, a multi-process backing-plan checklist, linked hold points (open **and** cleared), delay-reason history, and rejection history — each attributed to its real backing `ProcessPlan`, per §4.5's "always attributed to a process" rule. Backs a new `GET /api/jobs/:id/stage?unit=&stage=` route, fetched client-side on every spine/matrix click (225 (unit×stage) combos for DESPL-320 — fetch-on-click, not preloaded, to keep the page payload small).
- **Job-level (cross-unit) spine rollup — the one genuinely new algorithm this session, pinned by 9 pure unit tests (`spine.rollup.test.ts`).** §11 only defines the rollup *per unit*; the big StageSpine at the top of Overview and the job-list mini-spine both need one rollup *per job* (already flagged as deferred in the §9.2 log). `rollupJobSpine()` (`spine.read.ts`) generalises the exact §11.2 ladder across units instead of across backing plans (complete only if **every** unit is complete at that stage; otherwise hold > overdue > submitted > progress > idle, first match wins) — and the "winning" unit supplies `governingPlanId`/`unitId`, so a click on the job-level spine still resolves to one real StageSheet target instead of an unclickable multi-unit summary (the mockup's illustrative "Units 2–9" label doesn't survive contact with real per-unit data, and functional rule #1 says a control needs a real target or it doesn't exist).
- **Rejected marker shipped for real.** §11.2 always specified a rejected-history glyph distinct from the overdue pip, but no prior session had rendered it (the mockup itself never got to it). Added `pip-rej` (opposite corner from `pip-od`, so a hold+overdue+rejected segment can show all three signals per the spec's "fill + markers are the complete visual contract" rule) to `<StageSpine>`, the units×stage matrix cells, and `stage-status.ts`'s `showsRejectedMarker()`.
- **`/jobs` list** (§4.3): job/family/description/units/mini-spine/%complete/forecast-vs-due/open-holds/updated, row → detail. Extended `loadJobs` (not a parallel query) with `familyName`, `forecastDispatch`/`forecastVarianceDays`, `openHoldPoints`, `lastActivityAt`, and `unitRollup` — the per-job extras that open their own transaction (hold points, spine) are called sequentially-after the main `withTenant` block per the codebase's established rule against nesting `withTenant` calls (`loadJobKpis` already does this for `loadOpenHoldPoints`).
- **StageSheet, fully wired for the first time.** Meta (job/unit/owner/target/actual/variance/std-vs-elapsed), a multi-process backing checklist each with its own status chip + Start/Submit action, "why on hold" (open QCP items with class code + age), "why overdue" (the C26 explainer line when hold+overdue both apply), delay-reason history, rejection history, and the role-correct primary action (Start / Submit for QC / Verify / Reject with a mandatory-reason inline form) — all through the existing `@/app/actions/{process,delay}` server actions, no new mutation path. After any action the sheet refetches its own stage detail **and** calls `router.refresh()`, so the underlying spine/matrix repaint without a full reload.
- **Bug found and fixed live, not just noted: bulk delay-reason filing was scoped to the wrong plan.** First cut filed the sheet's "File reason…" against only the governing backing plan; live-clicking Start on a 2-backing-process stage (Stage 1 · Project Kick-Off, both processes overdue in the same department) still got refused with `REASON_REQUIRED` — invariant #7 blocks on **any** unfiled overdue plan in the department, not just the one the sheet defaulted to. Root-cause fixed: the sheet now computes every backing plan's own overdue/unreasoned state (added `processPlanId` to `StageDelayReason` so the client can tell them apart) and files through `fileDelayBulkAction` across all of them at once, same pattern as workspace's "Apply reason to all overdue." Confirmed live: filed on 2 processes in one action, "Why overdue" banner correctly said "reason required for 2 backing processes" beforehand and cleared after, Start then succeeded up to the *next* department-wide overdue blocker (Stage 3's department has a third, stage-2 overdue process outside this stage's own backing set — confirmed via direct SQL; this is invariant #7 working exactly as designed, the same "non-obvious in the demo" finding an earlier session documented for Projects/PMO, now reproduced for Design & Detail Engineering).
- **Second bug found and fixed: Activity showed "No activity yet" right after 3 real delay-reason filings.** `events.read.ts`'s `loadEvents` (built in §9.2) only ever read `domain_events` rows with `aggregate_type = 'ProcessPlan'`; `DelayReasonFiled` events carry `aggregate_type = 'DelayReason'` and were silently excluded — confirmed via direct SQL that the rows existed. Fixed with a `UNION ALL` branch joining `delay_reasons → process_plans → job_processes/units` for context and the category name for the label ("filed a delay reason — Material delay"); `jobs.read.ts`'s separate `lastActivityAt` aggregate had the identical gap and got the same fix (job list's "Updated" column went from permanently "—" to "Today" once verified). Both are pre-existing gaps in code from an earlier session, not introduced this session — caught because this was the first UI surface to actually render `loadEvents`'s output against real filed-reason data.
- **Verify:** `pnpm typecheck` + `pnpm lint` clean; `next build` clean (`/jobs`, `/jobs/[id]`, `/api/jobs/[id]/stage` all present; one build attempt hit a transient Google Fonts CDN 404, unrelated to any change here, gone on retry — not a real failure). **308/308 with `pnpm test:db`** (299 prior + 9 new `rollupJobSpine` ladder tests). Live browser pass as SJ: `/jobs` renders real family/forecast/holds/mini-spine/updated columns with correct empty states for the two jobs with no schedule; `/jobs/3` Overview renders the job spine, 9×25 matrix, and Activity preview from real DESPL-320 data; matrix-cell click opens StageSheet with correct target/actual/variance/hold-points/backing-checklist; invariant #7 refusal fires clean (toast, no crash) then clears after filing; Start/action round-trips update the sheet and the page without a manual reload; Activity tab (both preview and full) now show real, attributed events. Zero console errors.
- **Deferred (noted, not silently dropped):** the sheet's "File reason…" only ever discovers unreasoned overdue plans *within this stage's own backing processes* — a department can still have an overdue blocker on an entirely different stage, which the sheet correctly can't see (that's `/workspace`'s job, by design, per its own per-department card grouping); no attempt was made to widen the sheet into a department-wide reason-filing surface, since that would duplicate workspace's existing bulk flow rather than fix a defect. Job-list "Description" column reuses `projectName` (no separate description field exists on `Job`). §9.6 (Gantt/BOM/QCP tabs) intentionally not started — the job-detail page currently ships only the Overview and Activity tabs the mockup groups under this session, per functional rule #1 (no half-wired tab controls).

## Session — §9.4 Dashboard (all real KPI/stat/chart cards, cross-filter links), 15 Aug 2026

Built the demo-ready `/dashboard` (DESIGN_SPEC §4.2) as the second real page inside the `(app)` industrial shell, migrating + retiring the legacy warm-paper page. Every number is real (computed in `loadJobKpis`, extended not duplicated — same spine/CPM/prioritize pipeline the workspace read already runs), and every honest gap renders an honest empty state rather than a fabricated one. On `demo`, committed. Verified with a live browser click-through as SJ, DB tests, and direct-SQL sanity checks.

- **Extended `loadJobKpis`** (`workspace.read.ts`) rather than building a parallel `dashboard.read.ts` — one pipeline pass, no duplicate DB round-trip. New fields: header (equipmentName/designCode/unitCount), forecast (`forecastDispatch` = the schedule engine's own computed makespan, max(plannedFinish) across the run — **not** a live re-forecast from actual progress, documented in code as a Phase-2 seam), the 5-stat strip (first-pass yield from the domain-event stream's Submitted/Rejected counts, avg cycle-vs-standard using `workingDaysBetween` against each `JobProcess.durationMaxDays`, plans-verified-7d + delta, reasons-pending, active-users-today), a critical-path panel (overdue **and** critical-path plans, worst-first), department on-time % (added to `deptMatrix`), a 7-week throughput series + target (derived from remaining plans ÷ weeks-to-contractual-date), cycle-time worst offenders (COMPLETE plans running long vs standard — filtered to `deltaDays > 0` only, so it can never show a false "offender"), overdue aging buckets per department (1–3d/3–7d/7d+), and a top-5-by-age hold-points list. **`loadOpenHoldPoints` extended** with `srNo`/`classCode`/`awaitingTpi`/`status`/`ageDays` (age = calendar days since the last QC/TPI attempt, or since the linked process's planned start if never attempted).
- **Scope cut, and why (functional-first rule #1 — no fabricated numbers):** the mockup's KPI delta-vs-last-week + sparklines need historical snapshots; `ProgressSnapshot` exists in the schema but has **zero rows and nothing writes to it** (that's Phase 2's daily-digest machinery, §4.9). Rather than fake a trend, the KPI cards ship with no delta/sparkline this session — count-up motion is explicitly deferred to §9.9's polish pass anyway (§7), so nothing here is a UI regression, only an honest scope boundary. Same reasoning dropped "NDT repair rate" from the stat strip entirely: the Welding/NDT domain (`WeldJoint`, `NdtResult`) doesn't exist yet (still a schema comment, §9.8 is its own session) and `item_tests` has 0 rows — there is nothing real to show.
- **Cross-filter navigation (§3), wired everywhere the mockup calls for it:** the "At-risk/overdue" KPI, every matrix cell (mapped to the workspace's §11.2-style status vocabulary), every critical-path row, and every overdue-aging row all `<Link>` into `/workspace?dept=&status=` — reusing §9.3's already-built dismissible filter chip, no new plumbing needed.
- **S-curve:** a fresh minimal SVG polyline plotting the real per-week `sCurve` data (already computed server-side by `buildSCurve`), not a port of the mockup's hand-drawn illustrative bezier — the mockup's curve was fabricated for effect; this one draws whatever the schedule actually says, including a `sr-only` data table for assistive tech. Full crosshair/tooltip interaction polish stays with §9.9.
- **Dept × status matrix:** hard-ban compliance verified in-browser — non-zero cells tinted by status color, zero cells render as plain muted "0" (never blank, never tinted).
- **Live browser verification (SJ):** dashboard renders top-to-bottom against real `despl_demo` bootstrap data (63 overdue / 324 total) — KPI cards, honest empty states (First-pass yield "—", "No completed process is running long...", "No contractual date set yet" for DESPL-320's genuinely-null delivery date), critical-path panel, S-curve, dept×status matrix, throughput bars, overdue-aging bars, hold-points list all populated with real numbers. Clicked the "At-risk/overdue" KPI and an overdue-aging row → both landed in `/workspace` correctly filtered with the dismissible chip, exactly per §3's cross-filter contract. Zero console errors.
- **Verify:** `pnpm typecheck` + `pnpm lint` + `next build` clean (`/dashboard` now a ƒ route in `(app)`); **299/299 with `pnpm test:db`**, incl. 30+ new structural/directional assertions on the extended `JobKpis` shape (percentages in range, cycle-time offenders always positive-delta, critical-path panel always sorted worst-first, hold-points-top always ≤ the full open count, etc.) — following this file's established style of pinning invariants over exact numbers, since the shared no-cleanup fixture makes exact values test-order-dependent.
- **Deferred (noted, not silently dropped):** cycle-time-offenders formula has no DB test exercising a real positive-delta case (the shared fixture's synthetic instant-completions all run fast, not long) — the filter's correctness (never shows a negative/zero delta) is asserted, but a constructed "this specific process is running long" scenario isn't. Matrix-cell → workspace status mapping has a known nuance (raw `ProcessPlanStatus` columns vs the display-state ladder's overdue-first precedence) inherited from workspace.read.ts's existing `displayState()` — an overdue `IN_PROGRESS` plan shows in the matrix's IN_PROGRESS column but won't match `status=progress` when filtered, since the workspace fill ladder buckets it under `overdue` instead; same nuance already documented there, not new to this session.

## Session — §9.3 Workspace (first real page, industrial reskin) + `reject` transition, 15 Aug 2026

Built the demo-ready `/workspace` (DESIGN_SPEC §4.4) as the first real page inside the `(app)` industrial shell, migrating + retiring the legacy warm-paper `/workspace`. On `demo`, committed. Verified with a live browser click-through as SJ + full DB verification of the new backend.

- **New page** `src/app/(app)/workspace/page.tsx` (server component) + `_client.tsx` (all interactive bits in one file). Per-process **cards** (mockup's ws-card), each = one process with a unit table (Unit · Due · Overdue days · delay-reason select + detail · role-correct action). Header shows process name, `Stage N of 25` label, department, an overdue chip, and the **bulk actions**. Sumchips (my overdue / due today / awaiting QC), a **dismissible URL filter chip** (dashboard deep-links), and a **sort select** (critical / most-overdue / due — URL-driven). Legacy `src/app/workspace/*` deleted (route conflict; scoped-transition plan says reskin-then-migrate).
- **Read layer** `loadWorkspaceView` (in `workspace.read.ts`, reusing the spine/CPM/prioritize pipeline): regroups the prioritized plans into per-process cards scoped to the actor's departments (all for PH/admin/mgmt), applies `dept`/`status` deep-link filters + `sort`, builds the cross-dept QC queue (SUBMITTED), open hold points, and header counts. All at the 36-plan grain (§11.4).
- **Bulk actions** (§4.4 flagship): `fileDelayBulkAction` (Apply reason to all overdue → N `fileDelayReason` calls, each its own gate + audit) and `startBulkAction` (Start all → N `startProcess`, gate-skipped items reported). Both revalidate and toast the count.
- **`reject` state-machine transition (new backend, needed for a functional Reject — no dead controls).** `SUBMITTED → IN_PROGRESS`, QC-only, same maker–checker as verify (actor ≠ submittedBy), **mandatory reason** (schema), clears `submittedBy` so the maker re-submits; audit `process.reject` + event `ProcessRejected`. Added `rejectProcessSchema`, `rejectProcess` (mirrors `verifyProcess`), `rejectAction`, and the legal transition row (the illegal-pairs test auto-covers reject's other transitions; maker-checker is the shared, already-tested guard). **Verified end-to-end vs Postgres:** self-reject → `MAKER_CHECKER_VIOLATION`, empty reason → zod refusal, valid reject → `IN_PROGRESS` + `submittedBy=null` + 1 audit row.
- **Live browser verification (SJ, industrial theme):** page renders (sidebar, job-switcher mini-spine, chips, per-process cards across departments with real "Waiting on: …" reason text + Blocked status); **File** a single delay reason → toast + round-trip; **Apply reason to all overdue** → "Reason filed on 9 units — logged with your name & time."; **Start** on a still-owed unit → live **REASON_REQUIRED** refusal toast ("This department has an overdue process on this unit…") — server-side gate, clean error, no crash. Start controls render for READY root processes (PO Receipt).
- **Verify:** `pnpm typecheck` + `pnpm lint` + `next build` clean (`/workspace` now a ƒ route in `(app)`); **299/299 with `RUN_DB_TESTS=1`** (268 pure + 31 DB), incl. the new reject transition rows.
- **Deferred (noted):** full StageSheet wiring from workspace rows (§9.5 — kept the row's inline actions as the functional surface rather than a half-wired "Open" button, per functional-rule #1); the job switcher still targets the DESPL-320 pilot (switcher is a §9.1 stub); QC verify/reject UI not visually click-tested in-browser (a browser cookie/login quirk this session — backend fully verified, `QcRow` is a thin wrapper).

### ✅ Fixed: `RUN_DB_TESTS` now targets its own database, never `despl_demo`

**Found:** the DB test files (`process.service.test`, `delay.service.test`) create throwaway `TEST-*`/`DELAY-*` **Organizations per run and never delete them** (their own comment says they assume a *"disposable test DB"*), but `.env`'s `DIRECT_URL` pointed at **`despl_demo`** — so every `RUN_DB_TESTS` run added orgs. This session's repeated runs pushed it to **23 orgs**, and `resolveTenantForLogin` fail-closes unless exactly one org exists → **every login broke**, including the demo. Restored `despl_demo` once by dropping + recreating it (→ `migrate deploy` → `db:seed` → `db:bootstrap` → 1 org / 19 users / 324 plans).

**Root-cause fix:** new dedicated `despl_test` database + `.env.test` (gitignored — added `.env.test` to `.gitignore`, the existing `.env*.local` pattern doesn't match it) + `pnpm test:db` (`set -a && . ./.env.test && set +a && RUN_DB_TESTS=1 vitest run`). Migrated + seeded + bootstrapped `despl_test` the same way as any demo DB. **299/299, run twice** against it — org count there is now free to grow from test fixtures (5 after two runs) with zero effect on `despl_demo` (confirmed still 1 org, SJ login still resolves). `RUN_DB_TESTS=1 pnpm test` (no `.env.test` loaded) still works for anyone who's manually exported `despl_test`'s vars into their shell; `pnpm test:db` is the safe one-liner. See [[db-tests-pollute-demo-db]] (updated with the resolution).

## Session — §9.2 data layer: `v_unit_stage_status` view + read layer + `/api/*` routes, 15 Aug 2026

Built the §9.2 data layer — the canonical 36→25 rollup in SQL + a curl-verifiable read API. No UI wiring (that's §9.3+), per §9.2's "verify with curl before any UI wiring". On `demo`, committed.

- **`v_unit_stage_status` SQL view** (migration `20260815120000_v_unit_stage_status`, raw SQL like the RLS migrations). One row per (unit, stage); implements the DESIGN_SPEC §11.2 first-match-wins fill ladder (complete→hold→overdue→submitted→progress→idle), the §11.3 governing-plan pick (earliest not-complete by seq; last if all complete, via `DISTINCT ON`), and the `is_overdue`/`is_rejected` secondary-marker booleans. `is_overdue` uses `now() AT TIME ZONE 'UTC'` to match the UTC timestamps Prisma stores; `is_rejected` derives from a `REJECTED` `QcpExecution` on a backing process (the only "rejected in history" signal that exists — there is no maker-checker verify-reject transition in the state machine). Created `WITH (security_invoker = true)` so the base tables' tenant RLS is evaluated as the querying role (`despl_web`), not the view owner — without it a superuser owner would bypass RLS and leak cross-tenant rows. `GRANT SELECT ... TO despl_web`. **Live-verified against `despl_demo`:** 225 rows (9 units × 25 stages) for DESPL-320, 45 overdue / 180 idle from the bootstrap data, multi-process stages share governing plans exactly per the §11.1 crosswalk (stages 12,13 → plan for process 19; 14,15 → process 23).
- **Read layer** (matches the existing `workspace.read.ts` `withTenant` pattern): `spine.read.ts` (`loadJobSpines` → per-unit `StageSegment[]` from the view, names attached), `jobs.read.ts` (`loadJobs` → list + header stats; %complete/overdue computed at the 36-plan grain per §11.4, one grouped aggregate, no N+1), `events.read.ts` (`loadEvents` → activity from the `domain_events` stream, job-filtered via the plan→job_process→job join). `src/lib/shared/stage-names.ts` holds the 25 names (kept in TS, not baked into the immutable view SQL, so the unresolved **C27** label swap stays a one-line edit). Added `governingPlanId?` to `StageSegment` (§11.3 action routing).
- **API route handlers** (`src/app/api/`): `GET /api/jobs`, `GET /api/jobs/:id/spine` (the §11.5-named endpoint — per-unit stage rows + governing_plan_id), `GET /api/events?job=&limit=`. Shared `_lib.ts` wrapper resolves the actor, JSON-serialises, and maps `AppError.code → HTTP status` (401/403/404/400/409) so refusals stay explainable (invariant #12). **Curl-verified** (minted a session JWT with the project's `jose` + `AUTH_SECRET`): jobs/spine/events all 200 authed with correct payloads; unauth → **401**, bad id / nonexistent job → **404**.
- **Middleware fix (root cause, once):** deny-by-default middleware redirected *everything* unauthenticated to `/login` with a 307 — wrong for `/api/*`, where a fetch client would silently follow the redirect and get HTML. Now `/api/*` returns a clean JSON 401 instead; page routes still redirect. One guard on the unauthenticated branch.
- **Test isolation fix (root cause, `022bb1b`):** the view test is the suite's first `is_current`-based DB assertion, which exposed a latent race — 6 other DB files each `generateSchedule` on the shared DESPL-320 fixture, flipping `ScheduleRun.is_current` concurrently (run-id-scoped tests tolerate it; a current-run view read does not). First patched with `fileParallelism: false` (a band-aid — global blast radius, coupling untouched); **replaced with the real fix**: the view test now builds its **own throwaway job** (1 equipment/unit, 3 processes backing one stage, 1 current run, 3 plans set directly), with idempotent teardown in beforeAll+afterAll. Its `is_current` pointer is touched by nobody else, so the file is parallel-safe. `fileParallelism` reverted; **294/294 stable across repeated parallel runs.**
- **Verify:** `pnpm typecheck` + `pnpm lint` clean; `next build` clean (routes present as ƒ). **294/294 tests with `RUN_DB_TESTS=1`, stable across repeated parallel runs** (288 prior + 6 new view-ladder DB tests covering idle/progress/complete, governing-plan pick, overdue-beats-submitted, the C26 hold-fill+overdue-pip, multi-process aggregation, and is_rejected).
- **Deferred (noted, not silently dropped):** POST stage-action routes (`start|submit|verify|reject`, `holds/:id/clear`) — the working server actions in `src/app/actions/*` already do this; wrap them as REST only when a client component needs `fetch()` over a server action. Events `&dept=` filter, the job-level (cross-unit) mini-spine rollup, and the client-side `rollupToStages` helper + its table test (§11.5) — all build with their first UI consumer (§9.3+). Equipment-grain (unit_id NULL) plans aren't yet fanned across a unit's spine — the PV pilot schedules per-unit, so every plan has a unit; ponytail-noted in the view SQL with the upgrade path.

## Session — UI build kickoff (design pack + C26/C27 + connectivity + Session 1 started), 15 Aug 2026

**Ended mid-Session-1 at the user's request (resuming on Opus 5 after a claude-code upgrade). Session-1 code is UNCOMMITTED WIP on `demo`.** Design/doc work IS committed (`e6707c3`, `b8873e3`, `d0e4364`, `4c953b7`).

### Decisions & docs (committed)
- **Design pack landed + merged.** The demo/frontend design guide was folded into `CLAUDE.md` as a `## Frontend & Design System` section (original backend invariants/conventions kept intact above it). Added `docs/DESIGN_SPEC.md` (the execution contract) + `design/despl-tracker-mockup.html` (approved v2 pixel reference — the visual source of truth).
- **36→25 stage rollup speced canonically — `DESIGN_SPEC.md` §11.** Verified against the seed: the crosswalk is `JobProcess.workOrderStages Int[]` (already seeded from `seed/lead-time-model.json`; all 25 stages covered, 12 stages backed by multiple processes, 2 processes span 2 stages). §11 pins: the **fill precedence ladder** (all-complete → hold → overdue → submitted → in-progress → idle), **secondary markers**, the **governing-process rule** (actions always target a real ProcessPlan, never a synthetic "start stage"), the **count-stays-at-36-grain guard** (status rolls up to 25; %/counts stay at 36 so matrix totals = KPI totals), and a canonical SQL view **`v_unit_stage_status(job_id,unit_id,stage_no,stage_name,fill_status,is_overdue,is_rejected,governing_plan_id)`** — **NOT built yet** (it's §9 session 2 work).
- **C26 RESOLVED (SJ).** A stage that is both on-hold and overdue shows **both**: hold as the primary **fill colour** (it's the actionable blocker, blocks completion per invariant #4) **+ a red overdue secondary pip**. Full per-process reasons live in the StageSheet, with an explicit **"Overdue Nd · reason required"** pending state (invariant #7 blocks progress until the delay reason is filed). Mockup demonstrates it (Stage 9 = hold fill + pip). BUILD-SPEC-v2 §7 C26 row marked ✅.
- **C27 FLAGGED (open, for SJ).** The seed's 25 `workOrderStageNames` and the mockup's own fabrication-detailed 25 names disagree (e.g. seed stage 17 = "NDT" vs mockup "Welding circ seam"). **Labels only — stage numbers and the 36→25 crosswalk are identical either way.** Seed names pinned canonical *provisionally* in §11.1; SJ to confirm the authoritative list (likely the shop-floor one). An earlier waypoint-label "fix" to the mockup was reverted because it broke the mockup's internal self-consistency.

### Theme migration strategy (user chose: SCOPED TRANSITION)
New industrial-dark theme is scoped under a `.theme-industrial` class, applied ONLY inside the new `(app)` route group. The legacy **warm-paper** pages (`/dashboard`, `/workspace`, root `page.tsx`, all `src/components/viz/*` + `viz/status.ts`) stay on their old theme and **remain readable** until each is reskinned in its own §9 session. Old tokens get retired at the end. **Do NOT flip `globals.css :root` to dark, and do NOT move legacy pages into `(app)` before reskinning them** — either would break them.

### Connectivity verified end-to-end (live this session, not trusted from the log)
docker `despl-pg` up · 6 migrations applied, schema up to date · RLS roles `despl_app`(nologin)/`despl_web`(login,non-super) present · **RLS fail-closed** (0 jobs unscoped → 3 scoped as `despl_web`) · **audit_log UPDATE denied** for `despl_web` · **app data path** (`prisma` + `withTenant(1)`) returns 3 jobs × 36 processes from `despl_demo` · `pnpm typecheck` + `lint` clean · dev server serves `/login /  /dashboard /workspace` all **200**, login renders, no errors in log.
- **FOUND & FIXED: `.env` pointed at the polluted `despl` DB (35 orgs → login fail-closes on the single-org rule).** Repointed `DATABASE_URL`/`DIRECT_URL` to **`despl_demo`** (clean: 1 org / 3 jobs / 9 units / 324 plans / 19 users). This was the one blocker to a working login demo. `despl` was left untouched.
- **Gap (expected, not broken):** the new UI's `/api/*` route handlers (DESIGN_SPEC §5) and the SQL views (§11) **do not exist yet** — the current app reads via RSC + server actions (`src/app/actions/{auth,delay,process,qcp}.ts`). Building that data layer is §9 **session 2**.
- **Still open (known):** production admin-user provisioning (reference seed makes no users); Railway deploy.

### Deps added
`sonner` (toasts) + `@radix-ui/react-dialog` (StageSheet + future dialogs). Deferred to their sessions: `cmdk`, `recharts`, `@tanstack/react-table`, SVAR React Gantt. **No `next-themes`** — dark-only per spec.

### Session 1 (§9.1: tokens + fonts + shell + StatusChip + StageSpine + StageSheet shell) — ✅ COMPLETE & VERIFIED

**Finished the session (all 6 remaining items built, verified in-browser, committed).** `/kit` (the new-system review surface, route `/kit`, auth-gated) renders the full industrial shell: dark theme (scoped), 236px sidebar nav (Overview/Execution/Records), topbar with job-switcher + mini-spine + ⌘K/bell stubs, all 6 StatusChips with correct colours, StageSpine **full (clickable) + mini** with the **C26 hold-fill+overdue-pip on Stage 9**, and the StageSheet sliding in with both reasons (why-on-hold + why-overdue "reason required" pending state) — its tokens resolve through the radix portal via a re-declared `.theme-industrial` class. Legacy warm-paper root/dashboard/workspace confirmed **still readable** (scoped transition holds). **Verify: `pnpm typecheck` + `lint` clean; `pnpm build` clean (11 routes, `/kit` prerenders, middleware 48.3kB); live browser pass as `sj@despl.local`.** One real bug found & fixed live: the full spine's clickable `<button>` segments were invisible because the CSS targeted `.spine i` — changed to `.spine > *` so it styles both the mini's `<i>` and the full spine's `<button>`.
Files added: `src/components/industrial/{stage-spine,stage-sheet,app-shell,_demo}.tsx|ts`, `src/app/(app)/layout.tsx`, `src/app/(app)/kit/page.tsx`. `_demo.ts` is throwaway session-1 demo data — delete when StageSpine reads real rolled-up plan data.
**Next session = §9.2:** seed script + SQL views (incl. `v_unit_stage_status` §11) + `/api/*` route handlers for jobs/stages/events — the data layer the real pages need. Then §9.3 Workspace (first real page, migrates into `(app)` + reskin, removing the legacy `/workspace`).

<details><summary>Original session-1 build plan (for reference)</summary>
**DONE (uncommitted):**
- `src/app/globals.css` — appended a scoped `.theme-industrial` block (tokens + shell + primitives + chip + spine + sheet + motion + `prefers-reduced-motion`), ported 1:1 from the mockup. Legacy `:root` warm tokens untouched.
- `src/app/layout.tsx` — Inter + JetBrains Mono via `next/font` → `--font-inter` / `--font-jbmono` on `<html>`.
- `src/components/industrial/stage-status.ts` — the 6-value `StageDisplayStatus` vocabulary (chipClass/colorVar/label), `StageSegment` type, `showsOverduePip()`.
- `src/components/industrial/status-chip.tsx` — `StatusChip`.

**REMAINING in Session 1 (build next, in this order):**
1. `src/components/industrial/stage-spine.tsx` — mini + full variants; renders `.spine`/`.spine-mini` with per-segment fill = `STAGE_STATUS[status].colorVar`; adds `pip-od` class when `showsOverduePip(seg)`; optional `onSegmentClick`. ("use client" for onClick.)
2. `src/components/industrial/stage-sheet.tsx` — radix `Dialog` as a right sheet. **Give `Dialog.Content` className `"theme-industrial stage-sheet"`** so the token vars resolve through the portal (it renders outside the `(app)` wrapper); overlay uses `.stage-sheet-ov`; slide-in via `[data-state="open"]` (already in globals.css). Session-1 = shell/structure + open/close + slots; real content wired in later sessions.
3. `src/components/industrial/app-shell.tsx` — "use client". 236px sidebar (nav groups Overview / Execution / Records via `next/link`, active state from `usePathname`, overdue `.badge`), 48px topbar (breadcrumb, job-switcher **stub** with mini-spine, `⌘K` **stub** button, bell **stub** drop). Match mockup markup (sidebar/topbar HTML captured from mockup lines ~112–155).
4. `src/app/(app)/layout.tsx` — wrap children: `<div className="theme-industrial"><AppShell>{children}</AppShell><Toaster/></div>` (sonner Toaster, bottom-right).
5. `src/app/(app)/kit/page.tsx` — Session-1 review surface (the new-system analogue of the old `/component-gallery`): all 6 `StatusChip`s, `StageSpine` mini + full **including the hold+overdue pip demo**, a button that opens `StageSheet`. Route `/kit`.
6. **Verify:** `pnpm typecheck && pnpm lint && pnpm build`; boot dev against `despl_demo` (`pnpm dev`); screenshot `/kit` and `/login`. Then commit Session 1 on `demo`.

**Resume specifics:** `.env` already → `despl_demo`. DB container `despl-pg` is up. Run `pnpm dev` (env now correct, no inline override needed). Logins: `sj@ qc@ md@ sup.<dept>@`, password `despl-dev-only`. Do the remaining 6 items, verify, THEN commit. Legacy `/dashboard` `/workspace` are expected to look unstyled-but-readable (warm theme) until their own sessions — that's the scoped-transition plan, not a bug.
</details>


## Session — live browser verification pass + stale-refusal fix, 15 Aug 2026

Goal for the session (user's): before any Railway deploy, drive every function on localhost and confirm it actually works. Done — full pass, one cosmetic bug found and fixed. **Not yet committed at time of writing → committing now on `demo`.**

- **Clean demo DB without wiping the dev DB.** The local `despl` DB has 35 `Organization` rows (login fail-closes unless exactly one org), and Prisma's AI-agent gate blocks `migrate reset`. Rather than wipe `despl`, created a **separate `despl_demo` database in the same container** (`CREATE DATABASE` → `prisma migrate deploy` → `pnpm db:seed` → `pnpm db:bootstrap`), pointed the dev server at it via env-var override (`DATABASE_URL`/`DIRECT_URL` inline; Prisma/Next dotenv don't override already-set process env, so the override wins). Result: clean **1 org / 3 jobs / 9 units / 324 plans / 19 users**. **`despl` was never read or written.** `despl_demo` is now a reusable local demo DB. Roles are cluster-global so `despl_web` already existed; grants/RLS came from the migrations.
- **Full lifecycle verified in-browser** (Claude-in-Chrome, two real users, every step cross-checked against Postgres, not just the UI):
  1. Login (fail-closed tenancy, single org) ✓ · 2. Role-based landing (SJ→jobs, QC→verify queue+hold points) ✓ · 3. `/dashboard` KPIs + heatmap on real data (261 on-track / 63 overdue / 36 hold points) ✓ · 4. `/workspace` per-unit critical-path worklist ✓ · 5. **Invariant #7** — Start refused until a categorised delay reason is filed ✓ · 6. Start→IN_PROGRESS with `actual_start` set **server-side** (invariant #1) ✓ · 7. Submit→SUBMITTED ✓ · 8. **Invariant #4** — Verify refused while a hold point is open ✓ · 9. Hold-point clearance (QcpExecution ACCEPTED) removes it ✓ · 10. Verify→COMPLETE with **maker-checker** (`submitted_by`=SJ ≠ `verified_by`=QC) ✓ · 11. **Append-only audit** wrote exactly one row per mutation (7 total) ✓. No server errors in the dev log throughout.
  - **Not a bug, worth remembering:** the first Start "did nothing" because Projects/PMO owns **two** overdue processes per unit (PO Receipt + Kick-Off), and invariant #7 correctly demands a filed reason for *every* overdue departmental plan on the unit before any progress. Both forms are on screen (Kick-Off ranks lower in the worklist). Once both reasons were filed, Start worked. Correct behaviour, just non-obvious in the demo.
- **Cosmetic bug found + fixed — stale refusal message.** All three workspace action components (`plan-row`, `delay-form`, `qcp-clear`) held the refusal in local client state that survived the server revalidations *sibling* components triggered — so e.g. "file a delay reason" lingered after a sibling File-reason action had already cleared its cause. **Root-cause fix, once:** new shared hook `src/app/workspace/use-action-error.ts` (clears before each attempt, auto-dismisses after 6s); the three components now use it (net fewer lines). Verified live: the REASON_REQUIRED refusal displayed then cleared itself after 6s with no re-click. typecheck + lint clean; **263/263 pure tests pass** (25 DB-gated skipped without `RUN_DB_TESTS`).

### Next session — TODO (in order)

1. **Deploy to Railway staging.** Includes **production admin-user provisioning** — the reference seed creates no users by design, so a real credential-bootstrap flow (not the dev password) is needed for the first admin on prod. Production DB flow is `prisma migrate deploy` + `pnpm db:seed:reference` (never `migrate reset`, never `db:bootstrap`).
2. **DESPL inputs:** confirm C24 (batch-level processes per-unit?) / C25 (worklist grouped by unit); request **per-department capacity / headcount / shift / throughput** (unlock for the Phase-2 workforce-aware auto-scheduler); still-outstanding Pipe Spool / Piping System lead-time tables + QAPs.
3. **Deferred Phase-2 seams** (inert for the pilot): per-serial schedule stagger, TPI call/witness-waiver, `reviewDelayReason` (PH ack/dispute). Second cosmetic item still open: MANAGEMENT sees inert transition buttons on `/workspace` (server-guarded, safe).
4. **Optional demo polish:** a small seed that drives a few units to COMPLETE so `/dashboard` shows a partially-done board on first load instead of all-NOT_STARTED.

**To resume the running app next session:** `docker start despl-pg`, then `DATABASE_URL="postgresql://despl_web:...@localhost:5432/despl_demo" DIRECT_URL="postgresql://postgres:devpass@localhost:5432/despl_demo" pnpm dev`. Logins: `sj@`, `qc@`, `md@`, `sup.<dept>@`, all password `despl-dev-only`.

## Session — production-safe idempotent seeding + vault setup, 15 Aug 2026

Committed on `demo` as `36fb184` (`feat(seed): production-safe idempotent seed split`).

- **Seed split (TODO #1, done).** `prisma/seed.ts` restructured into two guarded phases in ONE atomic transaction:
  - `seedReference(tx, src, stats)` — org, departments, roles, reference vocabularies, work calendar, product families, PRESSURE_VESSEL + PIPE_SPOOL templates, 25-route library. **Idempotent via an `Organization.code` existence guard** (code is `@unique`): if org `DESPL` exists it loads the ref ids through the new `loadRefIds(tx, tenantId)` and writes nothing. Returns a `RefIds` bundle the demo phase consumes in-memory (no re-query). **No user rows** — those carry the dev password.
  - `seedDemo(tx, refs, src, passwordHash, stats)` — "Unknown client", live jobs DE0463/DE0467 (BOM/procurement/components/ops/drawings/dispatch), DESPL-320 pilot + units + QCP, batch2 QAPs, per-role/dept demo users. Guarded on DE0463 so a dev re-run can't duplicate.
  - `pnpm db:seed:reference` (`SEED_REFERENCE_ONLY=1`) is the production path after `prisma migrate deploy`; `pnpm db:seed` runs both for dev. Root cause of the org-row pollution (non-idempotent `createMany`, no org guard) is fixed for good.
  - **Verified:** typecheck + lint clean; re-ran `pnpm db:seed` against the live (polluted) dev DB — both guards fired, `loadRefIds` executed against real data, **org count stayed 35** (the old bug would have made it 36). Fresh-create + reference-only paths were NOT exercised on a clean DB this session (needs the human-gated `migrate reset`) — logic is the original working seed, only reorganized.
- **Still-open follow-up from this task:** **production admin-user provisioning** — the reference seed intentionally creates no users, so a real credential flow (not the dev password) is needed to bootstrap the first admin on a production DB. Belongs with the Railway milestone.
- **Vault docs.** The DESPL Production Tracker had no Obsidian vault context pack (only the ASME "PRESSURE VESSEL" project and the sibling EJ tracker did). Created the full 16-doc pack at `SWAYAM OS/4_Projects/Client Work/DESPL/DESPL TRACKER/` (folder named to match the on-disk dir so `link_vault.py`'s `source_path()` resolves), added the MASTER_INDEX row, ran `link_vault.py`. Added a pointer line in the repo `CLAUDE.md` (repo `progress.md` is canonical; vault mirrors it). **The vault was never version-controlled** — set it up as its own git repo and pushed to a **private** remote `github.com/swayams13/swayam-os` (initial baseline `e37de14`, 271 files).

## Session — dept workspaces + auto-prioritizer (per-unit grain), 14 Aug 2026

Shipped, spec+plan at `docs/SPEC-department-workspaces-v1.md` / `docs/PLAN-department-workspaces-v1.md`, built via a 15-task subagent-driven run on `demo` (commits `e05da39..e463500`):

- **Per-unit grain (P0).** Services moved from `unitId:null` job/equipment grain to per-serial: `PlanInput.unitId` + `persistScheduleRun`; `generateSchedule` expands one plan per (included process × unit) → **324 plans** for DESPL-320 (36×9); `loadPredecessorStates`/`loadGate` gate on **same-unit** predecessors; `assertNoOpenHoldPoint` now actively enforces per unit (was a no-op). `override.service` kept at job grain with a `unitId:null` stopgap (no UI caller). DB-verified: per-unit gating isolation + live `HOLD_POINT_OPEN` on real DESPL-320 checkpoints (QcpItem 4/8/9).
- **Bootstrap (P1).** `scripts/bootstrap-schedule.ts` (`pnpm db:bootstrap`) generates a **mid-flight** DESPL-320 schedule anchored ~10 weeks back → 63 overdue / 261 future plans, so the overdue→delay demo works.
- **Auto-prioritizer (P2).** Pure `lib/services/prioritizer.ts` — ranks each department's plans (critical-path → overdue → ready → blocked, DONE last) with a per-plan reason, reusing `startReadiness` (new non-throwing gating predicate) and CPM float. Same-unit keying pinned by a regression test.
- **Server actions (P3) + QCP clearance (P5 backend).** Thin `src/app/actions/*` over the services (no re-implemented gates, `AppError.code → ERROR_MESSAGES`); new `qcp.service.recordQcpExecution` (accept/reject/NA per unit) clears hold points — TPI-call/witness-waiver stay Phase 2.
- **UI (P4/P5/P6/P7).** `/workspace` (actor-scoped supervisor "Today" worklist, all 13 departments via one screen; QC verify queue + hold-point clearance; overdue-row delay filing) and `/dashboard` (management KPI suite over real plan data — %complete, at-risk, hold points, dept×status matrix, planned-vs-actual S-curve) reusing `src/components/viz/*`. Role-based landing added to `page.tsx`.
- **Verified:** lint/typecheck/`next build` clean; **288/288** with `RUN_DB_TESTS=1` run twice. Live app runs; `/login` + inline refusal render correctly (dark mode).

**Decisions/defaults locked (open with DESPL):** **C24** — batch-level processes (PO/Engineering/Procurement) modelled uniformly per-unit (redundant but simple); **C25** — worklist grouped by unit. Per-serial schedule *stagger*, TPI call/witness-waiver, `reviewDelayReason` (PH ack/dispute), and the **workforce-aware auto-scheduler** (needs per-department capacity/headcount/throughput — the specific data to request) all remain Phase 2.

**⚠️ Demo-enablement caveat (env, not a code defect):** the local dev DB has accumulated **33 `Organization` rows** from repeated non-idempotent `pnpm db:seed` over the project's life, and `resolveTenantForLogin` fail-closes unless exactly one org exists — so **every login currently fails** on this machine regardless of password. Before the live click-through demo, run **`pnpm prisma migrate reset --force && pnpm db:bootstrap`** (migrate reset needs your hands — it's human-consent gated) to get a clean single-org DB seeded with the default `despl-dev-only` password. The feature code is unaffected (the 288 DB tests run under explicit `withTenant` scoping, bypassing login).

### Next session — TODO

1. **✅ DONE (15 Aug 2026) — Production-safe idempotent seeding.** `prisma/seed.ts` split into two guarded phases in one atomic transaction:
   - **`seedReference(tx)`** — org, departments, roles, reference vocabularies, work calendar, product families, PRESSURE_VESSEL + PIPE_SPOOL templates, 25-route library. **Idempotent via an org-existence guard** (`Organization.code` is `@unique`): if org `DESPL` exists it loads the ref ids via `loadRefIds()` and writes nothing. Returns a `RefIds` bundle the demo phase consumes in-memory (no re-query). No user rows (those carry the dev password).
   - **`seedDemo(tx, refs)`** — the "Unknown client" placeholder, live jobs DE0463/DE0467 + BOM/procurement/components/ops/drawings/dispatch, DESPL-320 pilot + units + QCP, batch2 QAP templates, per-role/dept demo users. Guarded on DE0463 so a dev re-run can't pile on duplicates. **Never runs against production.**
   - **`pnpm db:seed`** runs both (dev); **`pnpm db:seed:reference`** (`SEED_REFERENCE_ONLY=1`) runs reference only — the production path after `prisma migrate deploy`.
   - **Verified:** typecheck + lint clean; ran `pnpm db:seed` against the live (polluted) dev DB — both guards fired, **org count stayed 35** (the old bug would have made it 36), `loadRefIds` executed against real data. ⚠️ The fresh-create + reference-only paths were not exercised on a clean DB this session (that needs the human-gated `migrate reset`) — logic is the original working seed, only reorganized.
   - Still open: **production admin-user provisioning** — reference seed intentionally creates no users, so a real credential flow (not the dev password) is needed to bootstrap the first admin on a production DB. Belongs with the Railway milestone.
   - **Never run `pnpm db:bootstrap` against production** — it is a *demo* schedule generator (mid-flight dated DESPL-320 plans). Real production schedules are generated per real job via the `generateSchedule` service through the UI.
   - Production migration flow is `prisma migrate deploy` (no reset, no data loss) — `migrate reset` stays dev-only. Belongs with the "Deploy to Railway staging" milestone.
2. **Live demo prep (env, not code):** before demoing, `pnpm prisma migrate reset --force && pnpm db:bootstrap` for a clean single-org DB (login `despl-dev-only`). Optional enhancement offered but not built: a small demo-seed that drives a few units to COMPLETE so `/dashboard` shows a partially-done board on first load instead of all-NOT_STARTED.
3. **DESPL inputs:** confirm C24 (batch-level processes per-unit?) and C25 (worklist grouped by unit vs process); and — the unlock for the workforce-aware auto-scheduler — request **per-department capacity / headcount / shift / throughput** data (the specific input Phase 2's optimizer needs).
4. **Deferred Phase-2 seams** (all inert for the pilot): per-serial schedule stagger, TPI call-given/attended + witness-waiver flow, `reviewDelayReason` (PH acknowledge/dispute). Two cosmetic UI polish items from the final review: MANAGEMENT sees inert transition buttons on `/workspace`; the delay form renders (and fails FORBIDDEN) on out-of-department QC-queue rows — both server-guarded, safe to ship.

---

## ▶ Resume point (read this first in a new session)

**`lib/schedule/` (pure engine) AND `lib/services/` (business rules + persistence) are both built and verified against Postgres.** `lib/services/` now holds: `_shared.ts` (row↔engine mappers, `loadJobSpine`, `persistScheduleRun` with a per-job `SELECT … FOR UPDATE` lock, `lockProcessPlanForUpdate`, `assertNoUnfiledDelayBlock` #7, `assertNoOpenHoldPoint` #4 seam), `schedule.service.ts`, `process.service.ts`, `delay.service.ts`, `override.service.ts` — all thin callers into the engine, all running inside `withTenant`. Read "What's done" / "What's remaining" below before touching code. **The next real gap is the first UI/Server-Action caller** — nothing on screen calls these services yet. Two DB-backed things depend on per-serial `Unit` expansion (not built): the hold-point check (#4) is a no-op at the current job/equipment grain, and `ProcessPlan.unitId` is always null. Run the DB tier with **`pnpm test:db`** (needs `despl-pg` up; targets the dedicated `despl_test` DB via `.env.test` — never run `RUN_DB_TESTS=1 pnpm test` with `.env`'s vars loaded, that pollutes whatever `despl_demo` currently is — see [[db-tests-pollute-demo-db]]).

The plan driving this is `/Users/sonusingh/.claude/plans/hazy-plotting-turing.md` (approved 13 Aug 2026). It supersedes the old IMPLEMENTATION-GUIDE step numbering — Steps 0–6 there are superseded by the schema rewrite below; Step 7 (scheduling engine) is now done.

### `lib/schedule/` — built 13 Aug 2026 (two independent sessions), reconciled and verified 14 Aug 2026

**Merge history:** two sessions built this the same day on different branches, neither aware of the other. One (this `demo` branch) used code-based process/edge identity and added `bypassExcluded()` — splicing an excluded process (e.g. PWHT) out of the DAG with composed lags, rather than dropping it and silently handing its successor day zero. The other (`origin/demo`, "Day 2") used id-based identity and split gating/feasibility/override into their own modules, matching BUILD-SPEC-v2 §1's module list exactly. Reconciled 14 Aug by taking the `origin/demo` structure as canonical (spec-aligned module boundaries) — **at the cost of the exclusion-splicing logic, which did not carry over and is now tracked as a gap in "What's remaining" below, not silently dropped.**

**Actually run for the first time on merge** (neither original session's sandbox had npm registry access): `pnpm typecheck` caught one real bug — `cpm.test.ts` looked up a `Map<number, CpmNode>` with a `string | number` process `code` instead of its numeric `id` — fixed. `pnpm test`: **114/114 tests pass** (7 files). `pnpm lint`: clean.

Findings from building it, each pinned by a test — **do not re-litigate these without re-reading the tests:**

1. **The uniform edge rule is `start(S) ≥ finish(P) + lag`** for *both* edge types; `type` classifies the sign, it does not select a different formula. Proof: replaying it forward with **max** durations reproduces all 36 seeded envelope values **exactly — 0 mismatches**, terminal 119.
2. **Never run CPM with min durations.** The lags were fitted to the max curve only. With min durations the terminal lands on **day 37** against an envelope that says 119. The optimistic curve is only ever meaningful as the envelope's own `finishByMinDays`.
3. **Excluded processes must be spliced, never dropped** (the gap noted above). PWHT (P21) sits mid-chain P20 → P21 → P22. Dropped naively, P22 loses its only predecessor and schedules on **day zero** — silently claiming NDE-after-PWHT can begin before the shell is welded. Related discovery, still true and worth preserving when this is rebuilt: **P20/P21/P22 are fully concurrent in DESPL's table** (all three print start 86, finish 91, encoded as two −5 overlap lags), so the correct composed lag is −10 and P22 legitimately starts *before* P20 finishes — an assertion expecting finish-to-start here asserts the wrong model.
4. **The DE0467 shortfall is 22, and it is convention-dependent.** It moves to **21** on an inclusive day-0 count, **14** against the late end of the dispatch window, and **38** against the revised order date. All four readings are pinned in tests so the choice stays visible.

**Docs corrected this session:** the "~26 working days" figure was wrong and is not reproducible from the dates. Now **22** in `BUILD-SPEC-v2.md` §1.5 (with the two counting conventions spelled out), `IMPLEMENTATION-GUIDE.md` Step 7, and the 11 Aug session-log row — cross-checked against an independent Python re-implementation of the CPM pass and calendar day-counting (zero mismatches across all 36 processes) before either session had a working `pnpm test`. Three open questions raised for DESPL — **C21** (is a dispatch *window* a promise of its early or late date? worth 8 working days on DE0467 alone), **C22** (does a revised order date restart the clock?), **C23** (which processes are optional per client? PWHT is skippable but nothing is flagged `optional` in the lead-time table — this is exactly what `bypassExcluded()` was built for).

**Seed change:** `Job.deliveryDate` now takes the **earliest** date of a dispatch window, not the latest (`prisma/seed.ts`) — a feasibility warning must fire against the date first promised. Affects DE0467 only (25.10 → 15.10); DE0463's single date is unchanged. The raw range is still preserved verbatim in `Job.remarks`. **Needs `pnpm prisma migrate reset` to take effect in the DB.**

For the visual component set: color tokens were mechanically diffed (hex-set comparison, not eyeballed) against the data-viz skill's reference palette and validator output — turned out byte-identical to `docs/design-master-prompt.md`'s already-reviewed one; added a 13-step sequential blue ramp to `globals.css` for heatmap/meter magnitude, which didn't exist yet. A dynamic-tag JSX pattern in `MatrixHeatmap` (known TS/JSX rough edge) was caught and replaced with an explicit conditional. Not yet opened in an actual browser — `pnpm dev` and a look at `/component-gallery` in both light and dark mode is still outstanding.

### What's done (verified against Postgres, not just trusted seed output)

- **Schema & security**: 50+ tables, 5 migrations (`init`, `rls_and_app_role`, `rls_fail_closed`, `provisional_process_durations`, `dispatch_batches`). Tenant RLS fail-closed (verified: unscoped read → 0 rows, wrong tenant → 0 rows, cross-tenant insert → rejected). Audit append-only for real (verified: INSERT allowed, UPDATE/DELETE denied for the `despl_web` non-owner role — the old `REVOKE` was a documented no-op under superuser).
- **Auth/RBAC/client scoping**: login, argon2id, session cookie, deny-by-default middleware, `lib/authz/` with 22 unit tests (all violation cases — maker-checker, department scope, client scope). 6 Playwright e2e on the auth boundary. `/portal` access boundary exists but has no content yet (client order view is Day 3 work).
- **Process templates**: `PRESSURE_VESSEL` v1 (36 processes, real durations, PUBLISHED) + `PIPE_SPOOL` v1 (16 processes, **provisional** — every duration null, derived from QAP activity order not a lead-time doc, DRAFT status). `PIPING_SYSTEM` and `HEAT_EXCHANGER` families exist with **no template** — no sourced basis yet.
- **QCP data**: 7 templates total (DESPL-320 pilot + 6 from the 13 Aug docx handover — Suction Air Vessel/Suction Piping/Pressure Piping all linked to job DE0467, DE0463's own QAP, Ammonia Vaporizer + an unlabelled "Vessel" QAP with no job match). 362 items, 780 party-codes, all validated against the known code vocabulary. `RW` code definition corrected to "10% Witness" (was a guess, now sourced).
- **BOM data cross-checked**: fresh CSV re-upload diffed programmatically against seed — 0 changes to BOM/procurement data (same underlying export). Fixed real gaps found along the way: assembly-drawing dates were extracted but silently dropped by `seed.ts`, now persisted; new `DispatchBatch` model for DE0463's 3 staged dispatch dates; 5-field mojibake encoding bug corrected.
- **`lib/schedule/`** (IMPLEMENTATION-GUIDE Step 7): `calendar.ts` (working-day math, isolated for C1), `envelope.ts` (layer 1, refuses `SCHEDULE_DATA_MISSING` for provisional/null-duration processes rather than guessing), `cpm.ts` (layer 2 — forward+backward CPM with fitted lags, float, critical path; verified to reproduce PRESSURE_VESSEL v1's printed `finishByMaxDays` exactly at all 36 processes, including the terminal 119-day figure), `gating.ts` (`assertCanStart`/`assertCanComplete` — a negative lag allows early `IN_PROGRESS` but never `COMPLETE` ahead of a predecessor, per invariants #2/#11), `feasibility.ts` (FEASIBLE/TIGHT/INFEASIBLE, with the corrected 22-day DE0467 regression case), `override.ts` (mandatory reason, baseline vs current returned as distinct objects, never mutated). 7 test files, all table-driven for violation/boundary cases per CLAUDE.md's testing convention, using a fixture (`__fixtures__/pressure-vessel-v1.ts`) that parses the real `seed/lead-time-model.json` rather than a hand-typed stand-in. Added `SCHEDULE_DATA_MISSING` to `lib/shared/errors.ts` (the schema comments on `TemplateProcess`/`JobProcess` already named this code; it didn't exist yet).
- **Visual component set** (`src/components/viz/`): `KpiTile` (stat tile — label/value/signed delta/sparkline), `ProgressRing` (radial meter), `MatrixHeatmap` (a real `<table>` with colored `<td>`s, status- or sequential-colored), `SCurve` (planned-vs-actual line chart with a pointer+keyboard-reachable crosshair tooltip and a hidden data table), `MilestoneTimeline` (horizontal process spine with status markers). Loaded and followed the data-viz skill's method rather than eyeballing colors — its validated reference status/primary-blue palette turned out byte-identical to `docs/design-master-prompt.md`'s already-reviewed one (confirmed by diffing hex sets, not assumed); added a 13-step sequential blue ramp to `globals.css` for heatmap/meter magnitude, which didn't exist yet (only single-value status/accent tokens did), also diffed against the skill's source table. Previewable at `/component-gallery`, linked from the homepage — every number on that page is labeled illustrative sample data, not a live query, since `lib/services/` doesn't exist yet to populate real `ProcessPlan` rows for these to render against.
- Full regression: **114 unit tests** (22 authz + 92 schedule/gating/feasibility/override/calendar), 6 e2e, lint, typecheck — all actually run and green on merge (14 Aug 2026), first time either session's version of `lib/schedule/` was run through the real toolchain.

### What's remaining

1. ~~**🔴 Rebuild excluded-process support in `lib/schedule/`**~~ — **DONE 14 Aug 2026** (commits `db37eea..ba9737b`). Built `bypassExcluded()` (`src/lib/schedule/exclude.ts`): adds `included?: boolean` to `ScheduleProcess`, splices each excluded node out by composing edges `(P→S, lag = lagPX + duration(X) + lagXS)` with cartesian pred×succ bridging, max-lag dedup, adjacent-excluded-chain fixpoint, root/terminal/self-edge handling, and a `SCHEDULE_DATA_MISSING` refusal when an excluded node has no usable duration. Wired into the top of `computeCpm` (so `scheduleForward`/`Backward` inherit it and excluded nodes never reach `topologicalOrder`); `computeEnvelope` drops them by a direct membership filter (it never does lag arithmetic). +12 tests including the real PWHT-on-DESPL-320 case (terminal stays 119, P20→P22 composes to −5). Built via a subagent SDD loop (implement → adversarial review → 1 fix round → scoped re-review), full suite **125/125**, typecheck+lint clean. **Deferred follow-up:** `bypassExcluded` doesn't yet read CPM's per-job duration-override map, so an excluded node whose *only* valid duration is a planner override would refuse — trivial to add once `lib/services/` exists (no caller today).
2. ~~**🟠 Add the two `envelopeStartBy*` columns to `JobProcess`**~~ — **DONE 14 Aug 2026** (commit `cce790e`). Added `envelopeStartByMinDays/MaxDays Int?` mirroring `TemplateProcess`, migration `20260814105312_job_process_envelope_start_by` (clean — two `ADD COLUMN` on `job_processes`, nothing else), and copied `tp.envelopeStartBy*` in both `jobProcess.createMany` seed blocks. Engine untouched, 125 tests still green. **Local-DB caveat:** the new columns read NULL on existing local rows until a reseed — the user ran `pnpm prisma migrate reset --force` (`migrate reset` is gated behind Prisma's human-consent flag, so an agent can't run it); any fresh deploy/reset picks up the values from seed regardless.
3. ~~**🟠 Add a boot-time DB-role guard**~~ — **DONE 14 Aug 2026** (commits `9f3406b`, `659c6ea`). New `src/lib/db-guard.ts`: pure `assertDbRoleSafe(info)` + `assertDbRole(client)` that gathers role facts via **non-destructive catalog queries** (`current_setting('is_superuser')`, `has_table_privilege(current_user, 'audit_log'|'domain_events', 'UPDATE'|'DELETE')` — no real UPDATE) and throws a fail-loud, actionable error if the connected role is a superuser or can modify either append-only table. Wired via new `src/instrumentation.ts` `register()` (nodejs runtime only, dynamic import) so it runs once at server boot, never at module import (`next build` + the pure test suite stay clean). `scripts/provision-db-role.sql` (placeholder password) replaces the migration-comment-only `CREATE ROLE despl_web` prose; `db.ts` + the migration comment now point at it. 9 unit tests incl. the `is_superuser === "on"` string-parsing regression guard via an injected fake client; live-verified both directions (`despl_web` passes, `postgres` throws). Built via subagent SDD loop (implement → review → 1 fix round → scoped re-review), full suite **134/134**, typecheck+lint clean, `next build` succeeds.
4. ~~**`lib/services/`**~~ — **DONE 14 Aug 2026** (dynamic 4-phase workflow + harness follow-up). Built `_shared.ts` + `schedule`/`process`/`delay`/`override` services (~2,060 LOC incl. tests). Every listed follow-up landed: duration-override restamps Layer-1 offsets (and audits every restamped row); each mutation writes a same-tx audit row (integration-tested "one audit row per mutation"); per-mutation `.strict()` zod schemas reject `actual_*`/`*_at`; row-level locking per ARCHITECTURE §6 (`SELECT … FOR UPDATE` on the plan before the gate check, and on the job before version assignment). The 3-lens review found + fixed a real `persistScheduleRun` TOCTOU (NULL-distinct could commit two `isCurrent` runs — fixed with a per-job row lock), an unaudited envelope restamp, and a bypassed override schema; a manual pass added the missing `assertNotClientUser` in `verifyProcess`. **Residual low/latent items (all inert for the PV-v1 pilot, tracked in Blockers → Code-review findings):** feasibility `requiredMin` off the terminal vs max-across-processes (spread families only); override min-envelope restamp uses a CPM-min pass never fitted to the printed min table (spread families only); `delay.service` doesn't check `DelayCategoryRef.active`; `reviewDelayReason` (PH acknowledge/dispute) left as a seam.
5. **Open `/component-gallery` in an actual browser** (light + dark mode) — built and typechecked but never visually inspected by either session.
6. **One real department workspace** with gating/maker-checker/hold-point refusals actually firing (they exist in `lib/authz`/`lib/schedule/gating.ts` but nothing calls them against real process data yet), built using the now-existing visual components against real data instead of the `/component-gallery` sample data.
7. **Management dashboard** and **client order view** (`/portal` content) — both read from data structures that don't exist until #4 is built.
8. **Deploy to Railway staging** — not started.

**One thing not yet done, unrelated to the code:**
1. DESPL has not yet been asked for the lead-time tables + QAPs for Pipe Spool / Piping System specifically (Heat Exchanger data has now arrived — see below). The template engine is ready for the rest; this remains the critical-path blocker for those families, independent of any coding work.

(The 13 Aug session's schema/seed/auth/QCP-import/pipe-spool/CSV work — previously flagged here as uncommitted — was in fact committed that same session, in logical chunks: `feat: auth, RBAC/RLS authorization, and append-only audit logging` and `feat: provisional Pipe Spool process template + CSV re-check fixes`, both on `origin/main`/`origin/demo`. This note was stale.)

### QCP batch import — 6 new QAP templates from the 13 Aug 2026 handover

User provided `Lead Time (1).pdf` and `production process_work flow..docx`. The PDF is a straight match to the already-seeded 36-process table — no new information, good cross-check. **The docx contained 6 distinct QAP/ITP tables**, not the 3 originally assumed, spanning party counts from 2 up to 5 on one document (Ammonia Vaporizer: DESPL, AI, MVS, SCJV, OWNER) — a real-world validation that the fully-dynamic per-project party model needed zero schema changes to absorb this.

**Extraction method matters here and is worth recording.** The docx was parsed via its actual `w:tbl`/`w:tr`/`w:tc` XML structure (gridSpan/vMerge-aware), not flattened paragraph text or manual transcription — QCP data drives hold-point gating, so a column-misalignment bug here would silently corrupt which party's code blocks completion. Every code cell was validated against the known 6-code vocabulary (P/W/H/R/RW/R&A); the one row where cell count didn't match the expected party count (`AMMONIA_VAPORIZER#16.4`) was left with empty codes and flagged in `seed/qcp-templates-batch2.json`'s `issues[]` rather than guessed — confirmed in the DB: that row has 0 party-code rows, not fabricated ones.

**Mapping to the 6 equipments** (user-confirmed after I found the docx had no equipment name captured for 2 of the 6 sections — asked rather than guessed):

| Template | Job link | Items | Parties |
|---|---|---|---|
| DE0455-03 — Suction Air Vessel | **DE0467** (matches its projectName exactly) | 53 | DESPL, CLIENT_TPI |
| DE0455-02 — Suction Piping 10"×150lbs | **DE0467** | 31 | DESPL, CLIENT_TPI |
| DE0455-01 — Pressure Piping 8"×900lbs | **DE0467** | 31 | DESPL, CLIENT_TPI |
| DE0463 — Pressure Vessel | **DE0463** | 56 | DESPL, AI |
| DE0398001 — Ammonia Vaporizer | *(no matching Job — jobId null, same pattern as the original pilot template)* | 77 | DESPL, AI, MVS, SCJV, OWNER |
| Vessel (BUSCI/TPI + EIL/TPIA) | *(no matching Job)* | 52 | DESPL, BUSCI_TPI, EIL_TPIA |

DE0467's 3 templates confirms something useful: its `projectName` field — `'PRESSURE PIPE 8" / SUCTION PIPE 10" / SAV 24"'` — literally names all 3 of its equipment blocks. **This is a real lead on resolving C6** (the lost sub-assembly block labels for DE0467) but block-level linkage (which `Equipment.id` is which) was NOT attempted this pass — flagged as a follow-up, not guessed by item-count matching.

**RW now has a confirmed definition.** The docx's legend states *"RW: 10% Witness"* — a sampled/statistical witness point, not "Review + Witness" as previously guessed. Updated in `seed/qcp-templates.json`'s `model.codes.RW`, which is what seeds `QcpCodeRef.label`. R&A remains unconfirmed (still no explicit legend definition anywhere) but is now observed in real use, always paired with `DESPL:P`, consistent with the existing blocking-approval assumption — noted in the same file.

New/changed files: `seed/qcp-templates-batch2.json` (new, 6 templates), `seed/qcp-templates.json` (RW/R&A metadata updated), `prisma/seed.ts` (QCP-loading logic refactored into a shared `seedQcpTemplate()` used by both the original pilot template and the 6 new ones; added `jobIdByNumber` tracking during the live-jobs loop).

Reseeded end to end and reverified: 7 QCP templates total, 362 items, 780 party-codes, all party-code values confirmed against the known code vocabulary (query against `qcp_code_refs`, not eyeballed). Full regression clean after: 22 unit tests, 6 Playwright e2e, lint, typecheck.

### PIPE_SPOOL provisional process template

User asked (fairly): doesn't the docx already give you Pipe Spool / Piping System data? Answer: partially. The QAP gives *what* gets inspected and *in what order* — genuinely useful, already sourced. It does not give *durations*, which is what "lead time" specifically means and what the two-layer envelope+CPM scheduling model needs. Confirmed the Suction Piping and Pressure Piping QAPs share one identical process route (only fitting names differ), so there is exactly one real route to derive, not two guesses.

**Schema change** (`prisma/schema.prisma`, migration `20260813084535_provisional_process_durations`): `TemplateProcess`/`JobProcess` duration and envelope fields (`durationMinDays/MaxDays`, `envelopeFinishBy/StartByMin/MaxDays`) are now nullable, plus a `provisional Boolean` flag on both. This is a deliberate contract for whenever `lib/schedule/` gets built (Day 2): it **must** refuse to compute a plan for a provisional/null-duration process — a clear refusal (e.g. `SCHEDULE_DATA_MISSING`), never a silent 0-day or guessed date. RLS policies confirmed intact after the ALTER migration.

**`seed/pipe-spool-template.json`** (new): a 16-step route derived from the piping QAPs' activity sequence, each step tagged `derivedFrom` — either the specific QAP section it maps to, or `INFERRED` for structurally-necessary steps the QAP doesn't checkpoint (Material Procurement, Cutting, Dispatch — the QAP inspects material *after* receipt and joints *after* fit-up, not the procurement/cutting activity itself). Strict finish-to-start chain, `lagDays: 0` throughout — the honest "no known concurrency" default, explicitly NOT the fitted-DAG model PV uses (that model exists because PV's lead-time table showed *real* fitted concurrency; no equivalent evidence exists here). `ProcessTemplateVersion.status = DRAFT`, not PUBLISHED — not yet meant for a real job to pin against.

**PIPING_SYSTEM deliberately got no template.** Nothing in the source QAPs distinguishes shop-fabricated spools from site-erected piping (no hangers/supports/tie-in/field-weld checkpoints) — inventing that distinction from data that doesn't support it would be a guess, not a derivation.

Verified directly against Postgres: all 16 pipe-spool rows `provisional=true` with null durations (0 rows violate this), PV's 36 rows unaffected (still real durations, `provisional=false`), PIPING_SYSTEM confirmed at 0 templates. Full regression clean: 22 unit, 6 e2e, lint, typecheck.

New/changed files: `prisma/schema.prisma`, `prisma/migrations/20260813084535_provisional_process_durations/`, `seed/pipe-spool-template.json` (new), `prisma/seed.ts` (§7b added).

### CSV re-check: DE0463/DE0467 fresh export vs the seeded data

User provided `DESPL(DE0463) (1).csv` and `DESPL(DE0467) (1) (1).csv` and asked me to plan the integration. Before planning anything, diffed both programmatically against `seed/live-jobs.json` — every BOM item, every procurement status, across all 54 items. **Result: 0 diffs.** These are the same underlying export already behind the seed, not an update — worth recording so this doesn't get re-litigated as "new data" later.

The diff did surface three real, bounded things, all now fixed:

1. **Assembly-drawing approval/release/revision data was being silently dropped.** `seed/live-jobs.json` already had correct, CSV-accurate dates for every drawing (verified against the fresh CSV) — but `prisma/seed.ts`'s `LiveJobsFile` interface only declared `{name, drawingNo}`, truncating everything else before it reached the `AssemblyDrawing` table, even though the Day 1 redesign added real columns for exactly this. Widened the interface, now persisted. Zero new extraction needed — the data was already sitting in the seed JSON, just discarded on the way in.

2. **`DispatchBatch` (new model).** DE0463's header row carries 3 dates beyond its "Dispatch Date" field (10.08 / 20.08 / 30.08.2026) with no column header anywhere in the source. Asked rather than guessed — user confirmed these are staged/partial dispatch dates for the 40-unit order. Modeled as a small additive table (`jobId`, `seq`, `plannedDate`, nullable `qty` — no per-batch quantity exists in the source, so it stays unknown rather than assuming an even split). `Job.deliveryDate` is unchanged and still holds the tracker's primary dispatch date (= batch 1). Migration `20260813085906_dispatch_batches`. DE0467 checked and confirmed to have no equivalent pattern — this is a DE0463-specific finding, not a general gap.

3. **Encoding bug, 5 fields.** `seed/live-jobs.json` stored a Unicode replacement character (mojibake) in 5 DE0463 string fields — traced to the original 11 Aug extraction reading the source CSV with the wrong encoding (needs `cp1252`, not UTF-8). Corrected against the properly-decoded CSV: `Ø` (diameter) in 3 description fields, `°` (degree) in 2 part names. Verified the JSON diff touched exactly those 5 lines, nothing else.

Reseeded and verified directly against Postgres: 4 drawings now carry real dates, 4 dispatch batches created for DE0463 (batch 1 = 2026-07-28, matching `Job.deliveryDate` exactly), all 5 corrected strings render with the right characters. Full regression clean: 22 unit, 6 e2e, lint, typecheck.

New/changed files: `prisma/schema.prisma` (`DispatchBatch` model), `prisma/migrations/20260813085906_dispatch_batches/`, `seed/live-jobs.json` (5 string fixes + `dispatchBatches` + a `note` documenting both), `prisma/seed.ts` (widened `LiveJobsFile` interface, assembly-drawing persistence, `DispatchBatch` creation).

### What changed and why

The old schema could not express what DESPL actually needs. It was single-tenant, single-product-family, and its 36-process spine was a **global singleton** with no family or version dimension — so "this client wants 8 nozzles instead of 5 and skips PWHT" was a DDL migration plus a deploy. It also had **zero non-unique indexes and no index on any of its 29 foreign keys**.

Sizing showed the volume worry was misplaced: ~3,000 projects over 5 years is ~15M domain rows plus ~50M audit rows at ~33 req/s peak — a small single-Postgres workload. No sharding, no microservices, no queues. The real risk is **variability**, so the redesign makes the data model flexible and keeps the runtime boring.

### Day 1 shipped

- **Schema rewritten** (`prisma/schema.prisma`, 50 tables). Three clean migrations: `init`, `rls_and_app_role`, `rls_fail_closed`.
- **Tenancy**: `Organization` + `tenant_id` + Postgres RLS on the 19 tenant-root tables. **Verified**: unscoped read returns 0 rows, correct tenant returns 3 jobs / 6 equipments, wrong tenant returns 0, cross-tenant insert is rejected.
- **Invariant #5 now actually enforced.** The old `REVOKE ... FROM PUBLIC` was a documented no-op because the app connected as superuser. There is now a `despl_app` NOLOGIN permission bundle and a `despl_web` login role; **verified** that INSERT into `audit_log` succeeds while UPDATE and DELETE are denied.
- **RLS is fail-closed.** The first policy treated an unset `app.tenant_id` as "show everything"; corrected in a follow-up migration so an unset tenant yields zero rows and rejected writes.
- **Product families + versioned process templates.** The 36 processes are now `PRESSURE_VESSEL` template v1; each job materialises its own editable `JobProcess` copy.
- **Component route library persisted** — 25 routes / 108 steps. This existed in `seed/component-routes.json` and previously reached **no table at all**.
- **QCP code semantics are data** (`QcpCodeRef.blocksCompletion/requiresCall/waivable`), not JSON the gating engine would have to hard-code. C7 stays editable.
- **Two correctness bugs fixed**: `QcpExecution` gained `attemptNo` (re-inspection after rejection was previously impossible, breaking PRD FR-Q2); `QcpItem` gained `sequence` so `srNo` is stored verbatim — the old unique constraint forced the seed to corrupt values into `4.8b`/`4.8c`/`4.8d`.
- **Auth + RBAC + client scoping**: argon2id, jose session cookie, deny-by-default policy, department scoping, maker–checker, and a client-user boundary (`User.clientId`, `ClientVisibilityPolicy`, `ProgressSnapshot`).
- **Tests**: 22 unit (authz violation cases) + 6 Playwright e2e (auth boundaries). `e2e/` previously did not exist despite `playwright.config.ts` pointing at it.

### Seeded data

13 departments · 6 roles · 26 component types · 16 operations · 10 test types · 6 QCP codes · 4 product families · 36 template processes · 39 edges · 25 routes / 108 steps · 3 jobs (DE0463, DE0467, DESPL-320) · 6 equipments · 54 BOM items · 54 components · 9 pilot units · 62 QCP items · 108 party codes · 338 process links · 19 users.

Login accounts use the dev password `despl-dev-only` (override with `SEED_PASSWORD`): `admin@`, `md@`, `ceo@`, `sj@`, `qc@`, `sup.<department>@` (13), `client@example.local`.

### Toolchain notes (do not rediscover)

- **Node 20.20.2 + pnpm 9.15.9**, now pinned via `packageManager` and `engines`. Homebrew's pnpm 11 requires Node ≥22.13 and crashes on Node 20; the shell silently falls back to nvm's pnpm 9, whose store differs from the one `node_modules` was built with. Symptom is `ERR_PNPM_UNEXPECTED_STORE`; fix is `rm -rf node_modules && pnpm install`.
- **`pnpm-workspace.yaml` was deleted.** It held pnpm-10+ only keys (`minimumReleaseAge`, `allowBuilds`) that pnpm 9 cannot read, and pnpm 9 errors on a workspace file with no `packages` key. Those settings now live under `package.json#pnpm`.
- **vitest environment is `node`, not `jsdom`.** jsdom 30 pulls undici 8, which needs Node 22+ and crashes the whole suite on Node 20. Component tests opt in per-file with `// @vitest-environment jsdom`.
- **Two database URLs.** `DATABASE_URL` is `despl_web` (non-owner — RLS and the audit REVOKE apply). `DIRECT_URL` is the owner, used by migrations and `prisma/seed.ts`. Never point `DATABASE_URL` at a superuser; doing so silently disables both protections.

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
| 13 Aug 2026 | **A dispatch date given as a window is read as its EARLIEST date** — `Job.deliveryDate` takes the first, not the last. A tender-stage warning must measure against the date first promised. Raised as C21 for DESPL to confirm; worth 8 working days on DE0467. |
| 13 Aug 2026 | **`lib/schedule/` is pure — no Prisma, no clock, no writes.** `lib/services/` loads rows, calls in, and persists `ScheduleRun`/`ProcessPlan` with the audit row in one transaction. Keeps the highest-risk logic testable against hand-checked numbers. |
| 13 Aug 2026 | **CPM runs on max durations only.** The fitted lags reproduce the envelope exactly at max and give 37 days vs 119 at min. The optimistic curve comes from the envelope layer alone; no min path exists in the engine. |
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
| 11 Aug 2026 | DESPL handover: 7 documents received and fully analysed. 8 architecture decisions taken. Discovered the lead-time table encodes concurrent fabrication (21/36 processes overlap) and cannot be scheduled by summation — adopted two-layer envelope+CPM model. Generated all seed data from source documents. Wrote BUILD-SPEC-v2. Verified the engine against DE0467: its committed dispatch date is shorter than DESPL's own standard lead time — the tracker would have flagged this at order acceptance. *(The shortfall was recorded here as ~26 working days; corrected to **22** on 13 Aug 2026 when the engine was built and the arithmetic checked — see that day's entry.)* |
| 11 Aug 2026 | Step 0 (IMPLEMENTATION-GUIDE.md) run: read + confirmed CLAUDE.md/BUILD-SPEC-v2/IMPLEMENTATION-GUIDE.md back to user. Env check found Node v25.9.0 (guide wants v20 LTS) and no Docker. Installed nvm via Homebrew, set Node 20.20.2 as default (`nvm alias default 20`, `nvm use default` added to `.zshrc`), switched pnpm to a Node-20-compatible build via `corepack prepare pnpm@latest-9 --activate` (Homebrew's global pnpm 11 required Node ≥22). Confirmed working in a fresh interactive shell. User opted to skip Docker and use Railway Postgres for local dev instead (see Decisions log); Docker install deferred to post-deployment. Antigravity IDE and Claude CLI already present. Home directory (`/Users/sonusingh`) turned out to be one giant git repo tracking unrelated projects (remote `Pdftoproposal.git`) — `DESPL TRACKER/` is untracked inside it; flagged to user, left untouched, `git init` in Step 1 will create its own nested repo as intended. |
| 11 Aug 2026 | Step 1 run: `git init` inside `DESPL TRACKER/` (its own nested repo, separate from the home-directory repo). Added `.gitignore` excluding `QCP - DE0463.pdf` (client document, not part of the guide's commit list) plus `.env`/`.DS_Store`. Committed `CLAUDE.md`, `docs/`, `seed/`, `progress.md`, `prototype/` as `docs: specs, seed data and build spec (pre-code)`. Created private GitHub repo `swayams13/despl-production-tracker` via `gh repo create --push`, branch `main`. Verified repo root matches exactly: `.gitignore`, `CLAUDE.md`, `docs`, `progress.md`, `prototype`, `seed`. |
| 11 Aug 2026 | Step 2 run: re-confirmed the summarize-back check against BUILD-SPEC-v2 §0 (9 decisions) and §6 (9-step build order) specifically, per the guide's check criteria — no drift from the docs. No code written. |
| 11 Aug 2026 | Step 3 run: scaffolded Next.js 15.5.23 App Router (TS strict, `src/` dir, `@/*` alias, Turbopack) — `create-next-app@latest` defaults to Next 16 now, so pinned to `create-next-app@15`. Scaffolded into a scratch dir (target dir name "DESPL TRACKER" fails npm's package-name rules) and merged in, keeping the existing `.git`/docs/seed. Added Tailwind v4 (bundled), shadcn/ui (`components.json`, `button` primitive), TanStack Query v5.101, Prisma 6.19 (`@prisma/client` + CLI, schema deferred to Step 4), Prettier, Vitest 4 + Testing Library, Playwright 1.62 (chromium installed). Added `typecheck`/`test`/`e2e`/`format` scripts. Created `src/lib/{services,schedule,shared}/README.md` stating each layer's role per CLAUDE.md conventions. Verified: `pnpm lint` and `pnpm typecheck` clean, `pnpm dev` boots and serves 200 on `localhost:3000`. |
| 11 Aug 2026 | Follow-up check on the Next 16→15 pin flagged after Step 3: confirmed no actual drift — `package.json` pins exact `15.5.23` for `next`/`eslint-config-next` and `19.1.0` for `react`/`react-dom`, `pnpm ls` and `pnpm-lock.yaml` show zero `16.x` references, installed binary reports `v15.5.23`, and a clean `pnpm install` produced no peer/deprecation warnings. The Next 16 scratch scaffold was discarded before the 15 version was generated, so it never reached the repo. No fix needed — was informational only. |
| 11 Aug 2026 | Step 4 started, reversed the earlier Railway-for-local-dev call: user decided to install Docker after all and do local dev against it, keeping Railway for the Step 14 deploy target as originally written in the guide (see Decisions log). Installed Docker Desktop (the Homebrew cask needed an interactive `sudo` password the sandboxed shell couldn't supply, so the user ran `brew install --cask docker` themselves). Started `despl-pg` (postgres:16, port 5432, db `despl`) via `docker run`. Wrote `.env` with `DATABASE_URL` (gitignored). Ran `prisma init --datasource-provider postgresql`; it also silently installed ~30 files of Prisma's own AI-agent skill docs into `.claude/skills/`, `.windsurf/skills/`, `.agents/skills/` + `skills-lock.json` — deleted, unrelated vendor bloat. Hit `Error: P1010 User was denied access on the database (not available)` on `prisma db pull` — investigated at length (see Resume point above for full detail and next diagnostic step); not yet resolved. Paused mid-investigation at user's request to save progress for next session. |
| 12 Aug 2026 | Step 4 resumed and resolved. Ran the queued diagnostic: `nc`/`pg_isready` against `localhost` and `127.0.0.1:5432` both succeeded, ruling out Docker networking. A real host `psql -U postgres -d despl` then surfaced the actual cause — `role "postgres" does not exist` — which didn't match the Docker container's role at all. `lsof -iTCP:5432` showed a native Homebrew `postgresql@14` service bound to `127.0.0.1:5432`/`[::1]:5432`, shadowing Docker's wildcard-bound proxy for all loopback traffic; `brew services list` confirmed it running. Stopped it (`brew services stop postgresql@14`); re-verified `lsof` shows only Docker's proxy on 5432, `psql` now reaches the container and returns `1`, `pnpm prisma db pull` connects cleanly (`P4001` empty-DB error, expected), and `pnpm prisma studio` served HTTP 200 on port 5555 against the empty DB. No repo files changed — root cause was host-level, not code. Step 4's guide check is satisfied; next session starts Step 5 (Prisma schema, per BUILD-SPEC-v2 §2). |
| 12 Aug 2026 | Step 5 run: wrote the full Prisma schema (24 models, BUILD-SPEC-v2 §2's Client..AuditLog list) directly against `seed/*.json`'s actual field/enum shapes rather than the diagram's loose prose, so Step 6's importer has real targets — see Resume point above for the specifics and the two invariants (#1, #5) that are schema-flagged but not yet enforceable without a DTO layer / non-superuser DB role. Generated the init migration with `--create-only`, hand-appended a `REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC` statement (documented as currently inert under the local superuser role), then applied it — `\dt` in psql confirms all 24 tables + `_prisma_migrations`. Along the way, a `pnpm install` (run to unblock `pnpm typecheck`, which was failing on a stale dep-status check) wiped `node_modules` and then hit pnpm 11's `minimumReleaseAge` supply-chain policy on a same-day-published transitive dep, blocking every subsequent `pnpm run` too. Asked the user before touching policy; fixed by setting `minimumReleaseAge: 0` in `pnpm-workspace.yaml` (pnpm 11 moved this out of `.npmrc` — a `.npmrc` attempt was silently ignored) and resolving the file's pre-existing `allowBuilds` placeholders to `true`. `pnpm typecheck` and `pnpm lint` both clean afterward. |
| 12 Aug 2026 | Step 6 run as a 4-phase dynamic workflow rather than a single linear implementation: 4 parallel read-only agents each mapped one `seed/*.json` file to its target Prisma models (field-by-field, including which `seed/data-issues.json` entries apply to records in that file); a merge pass cross-checked the 4 maps against each other and `schema.prisma` for shared-entity consistency and produced one ordered implementation plan; a single agent wrote `prisma/seed.ts` from that plan; a verify pass ran `pnpm db:seed` and checked row counts. Independently re-verified the claimed counts myself via `docker exec despl-pg psql` rather than trusting the report — all matched (13 departments, 36 processes, 39 edges, DE0463×20 BOM items, DE0467×34, `Job`/`Equipment`/`BomItem.remarks` carrying the real `data-issues.json` note text). Read the full `seed/seed.ts` diff too — confirmed no fabricated data (`Client.name` is an explicit "pending DESPL confirmation" placeholder, not an invented company name) and that all 12 data-issues entries are surfaced somewhere (row remarks or code comments), none silently dropped. Found and kept two non-bugs: the guide's "54 QcpItem rows" check undercounts against the table's 62 (54 CHECKPOINT + 8 SECTION headers, both stored in one table — data is correct, guide checklist line is imprecise); and `db:seed` is `createMany`-only so reseeding a non-empty DB needs `pnpm prisma migrate reset`, not a bare rerun — confirmed with the user this is fine as-is (no upsert logic added). Added `tsx` as a devDependency (neither `tsx` nor `ts-node` existed) and wired `package.json`'s `db:seed` script + `prisma.seed` config. Committed as `feat: seed data import`. |
| 13 Aug 2026 | **Document re-check + `lib/schedule/` built (this `demo`-branch session).** Three PDFs re-supplied by DESPL: the QCP DESPL-320 and the Component-Wise Routing turned out to be **exact duplicates of data already seeded on 11 Aug** (verified by filename in each seed file's `source` field and by item counts — 62 items/54 checkpoints, 25 routes), so nothing was re-ingested. The third (`work order process.pdf`) supplied the 25 work-order **stage names**, which the crosswalk had only ever held as numbers — added to `seed/lead-time-model.json` as `workOrderStageNames` with a provenance caveat (the file ends in AI-tool commentary about a "Knock Out Drum" drawing; user confirmed DESPL supplied it) and 2 loose name matches flagged for SJ rather than silently renamed. Then built the scheduling engine: `lib/calendar/` + 5 files in `lib/schedule/`, 53 new tests, 75 total green (self-reported — this session had registry access; see the 14 Aug merge entry below for the first independently-verified run). Four things the build proved, later carried into the merged version's docs: the uniform `start ≥ finish(pred) + lag` rule reproduces all 36 seeded envelope values exactly; CPM with **min** durations gives 37 days vs 119 and must never be run; excluded processes must be **spliced with composed lags**, not dropped (PWHT would otherwise hand day zero to its successor); and the DE0467 shortfall is **22**, not the ~26 printed in three documents — all corrected. Raised C21–C23 for DESPL. Changed `Job.deliveryDate` to take the **earliest** date of a dispatch window (user decision) — needs a reseed to land in the DB. |
| 13 Aug 2026 | **Visual component set built** (KPI tile, progress ring, matrix heatmap, S-curve, milestone timeline) — separate session, on `origin/demo`, continuing the same session as the `lib/schedule/` entry below it. Loaded the data-viz skill first per its own trigger rule (any chart/dashboard/stat-tile work) rather than eyeballing colors or chart form — used its choosing-a-form and marks-and-anatomy references to map each requested component to a documented form (progress ring → "meter," KPI tile → "stat tile," matrix heatmap → "heatmap" built as a real `<table>` so it satisfies the skill's "table view always exists" non-negotiable by construction, S-curve → "line vs baseline"/emphasis). Ran the skill's palette validator on DESPL's existing status colors from `docs/design-master-prompt.md` (§6) expecting to have to fix something — it FAILed under the generic categorical-palette check (amber outside the lightness band, amber↔orange-red below the normal-vision floor) — but reading `references/palette.md` further showed this was the wrong check to apply: those 4 exact hex values are the skill's own documented, deliberately-designed status-palette default, validated under different criteria (icon+label mitigation, not adjacent-pair CVD separation), not a categorical set. Confirmed programmatically (not just re-reading prose) that DESPL's status colors and primary blue are byte-identical, hex-for-hex, to the skill's reference instance — so no palette changes were needed, only a sequential ramp addition (13 steps) that didn't exist yet, also diffed hex-by-hex against the skill's source table rather than trusted by eye. Built all 5 components as hand-rolled SVG/CSS (no charting library — matches the design doc's explicit style preference, and also moot given this session's npm registry block). Caught and fixed one real bug while re-reading `MatrixHeatmap`: a dynamic JSX tag (`const Tag = interactive ? "button" : "div"`) is a known TypeScript/JSX rough edge, replaced with an explicit conditional. Wired everything into a new `/component-gallery` preview page against clearly-labeled illustrative DESPL-320-shaped sample data (not a live query — `lib/services/` doesn't exist yet to populate real progress data), linked from the homepage, gated the same way as the existing homepage (deny-by-default middleware already covers new routes automatically). Same verification caveat as the `lib/schedule/` entry: no `pnpm install`/`test`/`lint`/`typecheck` run, no actual look at the rendered page — flagged as a blocker in this file's top status banner alongside `lib/schedule/`'s. |
| 13 Aug 2026 | **IMPLEMENTATION-GUIDE Step 7 run: `lib/schedule/` built** — same `origin/demo` session as the row above, unaware of the parallel `demo`-branch session building the same step. Resumed from the 13 Aug data session's resume note (Day 2 next = `lib/schedule/`). Ran on a harness-assigned session branch (`claude/progress-status-check-8ttvkj`) per that session's own explicit branch instructions, rebased onto `origin/demo` first so it started from the latest committed state rather than the branch's stale fork point. Built all 6 modules named in BUILD-SPEC-v2 §1 (calendar/envelope/cpm/gating/feasibility/override — see "What's done" above) plus 7 test files and a real-data fixture. Found and fixed the wrong ~26-working-day DE0467 figure in `docs/BUILD-SPEC-v2.md` §1.5 (+ its C1 table row) and `docs/IMPLEMENTATION-GUIDE.md` Step 7 — correct figure is 22, per the 13 Aug resume note's own instruction to fix the docs rather than bend the engine. Added the `SCHEDULE_DATA_MISSING` error code to `lib/shared/errors.ts` (referenced by schema comments since the 12 Aug pipe-spool work, never actually defined). **Could not run `pnpm install`/`test`/`lint`/`typecheck`**: this session's sandbox returned `403 Forbidden` on `registry.npmjs.org` on a direct, unproxied `curl` (confirmed it wasn't a proxy misconfiguration before giving up — no `HTTPS_PROXY`/CA issue, the registry itself refused the connection), so `node_modules` never existed to test against. Substituted the closest available verification: read every file at least twice; independently re-implemented the forward/backward CPM pass and the calendar day-counting logic in Python against the actual `seed/lead-time-model.json` (not a copy) — zero mismatches across all 36 processes' `earlyFinish`/`earlyStart` vs the seeded `envelopeFinishByMaxDays`/`startByMaxDays`, confirmed the terminal process lands at exactly 119 with zero float, confirmed no process has negative float, and confirmed the override propagation math (a P16 duration override of +13 days reaches P36 unchanged, since nothing downstream of P16 has an unaffected converging branch); cross-checked the DE0467 22-working-day figure and every hardcoded weekday/date claim in the test files against Python's stdlib `datetime`. This is real cross-validation, not a substitute for actually running the suite — flagged prominently in the resume point above so the next session runs it before trusting the code further. |
| 14 Aug 2026 | **`demo` and `origin/demo` merged.** Both branches had independently built `lib/schedule/` on 13 Aug (see the three rows above) — a real conflict, not a stale-info false alarm: incompatible data models (code-based vs id-based process/edge identity), and each had logic the other lacked (this branch's `bypassExcluded()` exclusion-splicing vs `origin/demo`'s spec-aligned `gating.ts`/`feasibility.ts`/`override.ts` module split). User chose to reconcile by taking `origin/demo`'s engine structure wholesale rather than a same-sitting synthesis, accepting the exclusion-splicing gap as a tracked follow-up rather than risk an unreviewed merge of two incompatible designs in the codebase's highest-risk subsystem. Ran the actual toolchain against the merged result for the first time either version had seen it: `pnpm typecheck` caught one real bug (`cpm.test.ts` line 19, a `string \| number` process `code` used as a `Map<number, CpmNode>` key instead of the numeric `id`) — fixed. `pnpm test`: 114/114 green. `pnpm lint`: clean. Also removed the now-superseded local-only files (`src/lib/calendar/`, `src/lib/schedule/{duration,graph,schedule.test}.ts`) since they referenced fields (`code`-based identity, `included`) that no longer exist on the merged `types.ts` and would not have compiled. |
| 14 Aug 2026 | **Post-merge session: repo hygiene, 3-agent code review, and all code-actionable findings fixed.** (1) **Recovered `docs/ARCHITECTURE.md`** — 190-line production-grade design (partitioning, indexing, N+1 avoidance, connection pooling, §6 gating-engine concurrency) that was authored 12 Aug on the orphaned `claude/codebase-review-standards-mtqeqp` branch and never merged, so it was invisible when working locally off `demo`; cherry-picked just that file (`21eb103`), left the branch's stale pre-schema doc edits (incl. a "Step 15" checklist) behind. Deleted the fully-merged stale branch `claude/progress-status-check-8ttvkj`. (2) **3 parallel review agents** (scheduling engine · auth/RBAC/audit · schema/seed/validation) — found 1 CRITICAL, 2 HIGH, several Medium/Low; full ranked list logged under Blockers → Code-review findings (`8647530`). Confirmed solid: fail-closed RLS, real non-owner audit REVOKE, deny-by-default RBAC, maker-checker excludes admin, invariant #1/#10/#11 upheld. (3) **CRITICAL fixed — excluded-process support** (`db37eea..ba9737b`): rebuilt the merge-dropped `bypassExcluded()` as `src/lib/schedule/exclude.ts` (compose edges `lagPX + duration(X) + lagXS`, cartesian pred×succ, max-lag dedup, adjacent-chain fixpoint, root/terminal/self-edge, `SCHEDULE_DATA_MISSING` refusal); wired into `computeCpm`, envelope filters directly; +12 tests incl. the real PWHT-on-DESPL-320 case (terminal stays 119). (4) **HIGH #2 fixed** (`cce790e`): `JobProcess.envelopeStartBy*` columns + migration `20260814105312` + both seed blocks; local DB **reseeded (`migrate reset`, user-consented) and verified** — 108/108 rows populated, 0 mismatches vs template. (5) **HIGH #3 fixed** (`9f3406b`, `659c6ea`): fail-loud boot-time DB-role guard (`db-guard.ts` + `instrumentation.ts` + `provision-db-role.sql`) — non-destructive catalog checks that crash startup if `DATABASE_URL` is a superuser or can modify `audit_log`/`domain_events`; live-verified both directions. All work done via **subagent SDD loops** (fresh implementer → adversarial review → scoped fix round → re-review → controller verify). Final: suite **134/134**, typecheck+lint clean, `next build` succeeds, migrations up to date. All pushed to `demo` (`…9b07dd7..42895c6`). Remaining review items are all Medium/Low, tied to the unbuilt `lib/services/`. |
| 14 Aug 2026 | **`lib/services/` built via a dynamic multi-agent workflow.** User asked to continue remaining-item #4 "using dynamic workflow." Scouted the codebase inline first (engine API, `db.ts`/`audit`/`authz` primitives, the `ScheduleRun`/`ProcessPlan`/`DelayReason`/`JobProcess` models), confirmed two scoping calls with the user (skip-gated integration tests; job/equipment plan grain), then ran a 4-phase Workflow: **Contract** (one agent owns the shared/edited files — `_shared.ts`, per-mutation `.strict()` zod schemas, two new error codes, the flagged `gating.ts` edge-type fix) → **Services** (4 parallel agents, each one new file: schedule/process/delay/override) → **Review** (3 parallel lenses: invariants+security · correctness · over-engineering) → **Fix** (applies confirmed findings). 9 agents, 0 errors, ~717k subagent tokens. The review caught a real `persistScheduleRun` concurrency bug (NULL-distinct `(jobId, NULL, version)` could commit two `isCurrent` runs — fixed with a per-job `SELECT … FOR UPDATE`), an unaudited downstream-envelope restamp in the override path, and a bypassed override zod schema; all fixed in-workflow. **Controller-side verification (not trusted from the agents):** typecheck+lint clean, 258 pure tests green. Ran the DB tier (`RUN_DB_TESTS=1`) the agents had never actually executed — found 5 failures, all **test-harness** bugs (seed reads via the RLS-scoped client returned 0 rows; a fixed-id throwaway org collided across reruns). Delegated a harness-fix pass (owner/`DIRECT_URL` client for seed reads + `Date.now()`-unique self-seeding, matching the already-passing `process.service.test.ts`), which surfaced one **genuine** finding: **DESPL-320 has deliberately-NULL order/delivery dates (pending DESPL), so `generateSchedule` correctly refuses it with `SCHEDULE_DATA_MISSING`** — repointed the happy-path DB tests at DE0463/DE0467 (real dates + non-provisional PV spine) and added a passing negative test pinning DESPL-320's refusal. Also added the one review-flagged low fix worth doing by hand: `assertNotClientUser` in `verifyProcess` (a misprovisioned QC+client user could otherwise complete a process — invariant #8). Final, independently re-verified: **272/272 with `RUN_DB_TESTS=1`, run twice, rerun-safe**; 258 pure + 14 skip-gated; typecheck+lint clean. No new migration (the concurrency fix is a row lock, not DDL). **Not committed — left on the working tree for user review per the demo-branch discipline.** |
| 12 Aug 2026 | Housekeeping: local `main` was 3 commits ahead of `origin/main` (db connection fix, Prisma schema, seed data import), unpushed since Step 4. `git push origin main` failed with `Repository not found` / auth failure even though `gh auth status` and `gh repo view` both worked as `swayams13` — root cause was `credential.helper=osxkeychain` holding a stale/mismatched macOS keychain entry (two `gh`-authenticated accounts exist locally, `swayams13` and `swayamsinghbtech2024-cpu`). Fixed with `gh auth setup-git`, which repoints git's GitHub auth at the correct `gh` token; push then succeeded (`fa8255b..cf3f83f`). No code changes. |
| 13 Aug 2026 | New session picked up where the last left off. Re-ran `pnpm install` at the user's request to check whether a fresh session had different network access — it didn't: same `403` on `registry.npmjs.org` direct and forced through the local proxy, `node_modules` still absent. This is the third such confirmation; recorded in the blocker banner as environment-level, not worth re-attempting again without a different environment. Separately, the user explicitly asked to merge this branch's changes straight to `main` (and merge the open PR, if any) rather than following the `demo`-first convention — PR #1 (`claude/progress-status-check-8ttvkj` → `main`) already existed, auto-created when the branch was first pushed; merged it on that direct instruction. `demo` was not updated in the same action. No code changes this entry, docs/process only. |

## Blockers

**The `pnpm install`/`test`/`lint`/`typecheck` blocker both 13 Aug sessions hit is resolved** — this environment (14 Aug) had registry access and ran the full toolchain against the merged codebase; see the 14 Aug merge session-log entry above. Not a build-logic problem, was an environment one, and it's now cleared for this environment specifically (a future sandboxed session may hit the same 403 again — re-check rather than assume).

_None blocking the build otherwise._ Fifteen open questions (C1–C12 plus **C21–C23**, added 13 Aug 2026, in BUILD-SPEC-v2 §7) each have a working default in place. **C1 — whether the lead-time table's "Days" are working or calendar days — is still the highest-impact one**: it changes every computed date, and moves the DE0467 shortfall from 22 days to ~6.

The three new ones all came out of building the scheduling engine, and all three are worth real days on a single live job: **C21** (a dispatch date given as a *window* — earliest or latest? 22 days short vs 14 on DE0467), **C22** (a revised order date — does the clock restart? 22 vs 38), **C23** (which processes are optional per client — PWHT is skippable per the DESPL-320 drawing, yet nothing is flagged `optional` — this is also the motivation for the exclusion-splicing gap tracked in "What's remaining" above).

### Code-review findings (14 Aug 2026, three parallel review agents: scheduling engine · auth/RBAC/audit · schema/seed/validation)

Almost everything below is **latent** — the engine and the auth primitives are built and verified solid, but nothing calls them yet (`lib/services/` is an empty README), so most issues can only fire once the service layer is written. **One exception is a real bug on the v1 pilot job.** The three headliners are already promoted into "What's remaining" #1–#3 above; the rest are logged here to fix as the relevant path lands.

**🔴 Critical (real, lands on DESPL-320) — ✅ RESOLVED 14 Aug 2026:**
- ~~**Excluded-process handling unbuilt**~~ — **fixed** (commits `db37eea..ba9737b`); see "What's remaining" #1 for the build. `bypassExcluded()` now splices excluded processes (e.g. PWHT) out of the DAG so skipping one no longer deadlocks / orphans / crashes. 125/125 tests.

**🟠 High (fix before/with the service layer) — ✅ BOTH RESOLVED 14 Aug 2026:**
- ~~**`JobProcess` missing `envelopeStartBy*` columns**~~ — **fixed** (`cce790e`); see "What's remaining" #2.
- ~~**No runtime DB-role guard**~~ — **fixed** (`9f3406b`, `659c6ea`); see "What's remaining" #3.

**🟡 Medium:**
- **Gating keys off lag *sign* not edge *type*** (`gating.ts:44`, `lagDays >= 0`). Coincides in v1 seed; an `SS`-overlap edge with `lag:0` would be wrongly blocked. Fix: key on `e.type === "START_TO_START_WITH_OVERLAP"`. One-liner, safe to do anytime.
- **Duration override desyncs the two layers** — CPM (Layer 2) honors `durationOverrideDays`; the stored `envelopeFinishBy*` (Layer 1) offsets don't move, so the authoritative window and the recomputed plan silently disagree. Fix in the override service flow (restamp or mark derived-invalid).
- **No login rate-limit / lockout** (`auth.ts:14`) — online brute-force unmitigated. Fix at auth-hardening time.
- **Child tables have no `tenant_id`/RLS** (units, job_processes, bom_items, qcp_executions, …) — cross-tenant reads fail *open*, service-layer scoping only. Harmless at one tenant; **denormalize `tenant_id` + extend the RLS loop before tenant #2** (the migration comment already prescribes this).

**🟢 Low (polish / hardening):**
- `schemas.ts` is a stub (only `loginSchema`) — the "reject `actual_*`/`*_at`" validation truth doesn't exist yet; add per-mutation zod + a test asserting no key matches `/^actual_|_at$/` as write paths land.
- Aggressive duration overrides can push `earlyStart` negative → `addWorkingDays(start, -2)` crashes with a bare `Error` (`cpm.ts`/`calendar.ts`); clamp to 0 or throw a coded `AppError`.
- `audited()` is advisory — nothing forces a mutation to write its audit row (the DB `REVOKE` only stops tampering with *existing* rows, not a *missing* insert); add per-service audit-existence tests, consider triggers on the highest-value tables.
- Invariant #6 (no destructive edits) isn't structural for `process_plans.actual_*` — no correction-version table for actuals, only audit before/after. Acceptable given audit coverage; noted.
- Login timing side-channel — missing-user path skips argon2 (faster response), defeating the generic-error promise; always verify against a dummy hash.
- Graph failures (cycle, dangling edge) throw bare `Error`, not a coded `AppError` — violates invariant #12; wrap in `AppError` (add e.g. `SCHEDULE_GRAPH_INVALID`).
- Middleware doesn't length-guard `AUTH_SECRET` like `session.ts` does — fails *closed* (mass-logout, not exploitable), but masks a misconfig.
- No `min ≤ max` / `start ≤ finish` guard on envelope offsets; **P35 in the seed is inverted** (`startByMin=118 > startByMax=117`). Add the assertion (it surfaces the bad row).
- Calendar keys off the **UTC** civil day; an IST-midnight-stored date shifts by one. Engine is internally consistent — enforce "store civil-noon-UTC at the service boundary."
- Seed isn't idempotent (re-run throws on unique `code` — safe, but needs a manual wipe / documented reset); the `FIELD_MISUSE` data-issue note is handled in code but never persisted (so "all 12 surfaced" is really 11-as-data + 1-in-logic).

**Verified solid (not assumed):** fail-closed RLS is real in SQL; the append-only audit `REVOKE` targets a real non-owner role and actually bites; deny-by-default holds in both middleware and `requireRole`; maker-checker correctly excludes ADMIN; invariant #1 holds (no client timestamps anywhere); the engine honors #10 (never sums) and #11 (complete-in-order regardless of lag); override never mutates the baseline; CPM reproduces the printed 119-day envelope at all 36 processes.

## Findings to raise with DESPL

1. **DE0467 was committed on a timeline shorter than DESPL's own standard lead time** (PO 24 Jun → dispatch 15 Oct = 97 working days vs 119 minimum — **22 working days short**, now computed by the engine, not by hand). Best single demonstration of the tracker's value. Worth showing alongside the three readings it depends on (C21/C22): against the late end of the dispatch window it is 14 days short, against the revised order date, 38.
2. **Per DESPL's own table, 17 weeks is both the minimum and the maximum** — rows 35–36 print a single value. There is no documented "fast" case.
3. **12 data issues** in the live trackers — see `seed/data-issues.json` (job number mismatch, lost sub-assembly labels, misused Material Identification column, ambiguous dates, no planned dates, no owners).
4. **DESPL-320 (the pilot job) still has no order date and no delivery date** — genuinely unknown at seed time and left null rather than invented (`prisma/seed.ts`). Surfaced by building `lib/services/`: the scheduler correctly *refuses* to plan a job with no anchor date (`SCHEDULE_DATA_MISSING`), so the pilot cannot be scheduled until DESPL supplies its PO/order date and committed dispatch date. DE0463 and DE0467 both already carry real dates and schedule fine. **This is the pilot's critical-path input for the schedule/dashboard screens.**
