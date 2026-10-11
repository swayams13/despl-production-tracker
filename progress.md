# progress.md — DESPL Production Tracker

> Living build log. Update at the end of every working session (see CLAUDE.md → Session discipline).

## Session — PRs #66/#67 merged, stale PRs #7/#15 closed, 5 Oct 2026

**#67 (AUD-072/073)** merged (`7735d75`) — no migration. AUD-072 still closed *partial*; the cross-table race needs pessimistic locking as a follow-up.
**#66 (AUD-079)** went `CONFLICTING` after #67 landed — the usual `LEDGER.md` tail-row collision; merged `origin/main` into the branch in a scratch worktree, kept both rows in landing order (#67's first), typecheck clean, pure tests 637/637, CI green. The harness classifier blocked the agent's own `gh pr merge` (flagged as a production deploy because of the migration); Swayam merged it himself (`58a5def`).
**#7** closed as superseded (`docs/ARCHITECTURE.md` already on `main` via `21eb103`; its other doc edits fork from a pre-schema snapshot). **#15** closed as superseded by #28 (`74c8446`); its one un-carried piece — `mustChangePassword: true` in `scripts/create-department-accounts.ts` — left as optional. No open PRs remain.

**Next**: (1) ~~provision a second ADMIN~~ not needed — see correction below; an approve button in `/admin` for pending resets is still a fast-follow; (2) production migration window, now **5** migrations (AUD-006, 3× AUD-078, AUD-079) per `MERGE-RUNBOOK.md` — re-run AUD-078's backfill preflight against the production restore first; (3) AUD-024 so merges stop shipping code ahead of schema.

## Session — correction: production already has two admins; prod user list ≠ local, 5 Oct 2026

Went to create a placeholder second ADMIN in production via the real `/admin` UI (Swayam logged in himself in Chrome; the agent typed no password). Stopped before creating it: the live employee list already shows **two** ACTIVE ADMIN accounts — `aide` (Swayam Singh, bootstrap admin, never logged in) and `admin` (System Admin). The "DESPL has exactly one ADMIN" claim in PR #66's session came from `prisma/seed.ts`, not production. Swayam ruled the existing pair sufficient; **nothing was created**. AUD-079 rows in `LEDGER.md` and `audit/19_MASTER_ISSUE_REGISTER.md` carry a correction note. Approve button for pending resets in `/admin` is still missing.

**Two other findings from the same production employee list** (8 users total):
- **None of the 12 `<dept>@despl.local` demo accounts from the 6 Sep session exist in production** — that provisioning ran against the local dev DB. Production has only `ba`, `fabrication`, `procurement`, `production`, `qc`, `aide`, `admin`, plus an inactive `qa.test.employee`. Matters for the team demo and Gate 4 cutover.
- **`ba@despl.local` holds Client + QC/QA + Supervisor + Production Head + Management across all 13 departments** — unusually broad; the Client role alongside staff roles may collide with AUD-025's `clientId !== null` guard. Raised with Swayam, not changed.

## Session — migration window (5 queued) started, blocked on DB connectivity, 5 Oct 2026

Swayam asked to apply the 5 queued migrations (`20260909200000`–`220000` AUD-078, `20260910100000` AUD-006, `20260910110000` AUD-079) and re-run AUD-078's backfill preflight against production. **Nothing was applied; production is unchanged.**

- **Pending set confirmed from production itself**: `/api/health` returns 503 `{"status":"error","migrations":"pending",...}` naming exactly those 5 — the intended pending-migrations signal, not an outage (`/login` 200, app serving normally).
- **Read all 3 AUD-078 migrations.** Backfill claims NULL-tenant library rows via `audit_log` (`qcp.template.createLibrary`) first, then falls back to `organizations.code='DESPL'`; children inherit from parent template; a `DO $$` preflight `RAISE`s if any NULL remains before `SET NOT NULL`.
- **Wrote a read-only preflight** (scratchpad `aud078_preflight.sql`, not committed): lists organizations, NULL-tenant counts per table (library vs job-owned), each NULL-tenant library template with which pass will claim it (`audit_log` / `DESPL fallback` / `UNCLAIMED`), and `job_owned_nulls` (must be 0). Syntax-checked against local `despl_test`.
- **Agent could not reach production**: the harness classifier blocked both reading `DATABASE_PUBLIC_URL` via `railway variables` and running the preflight via `railway run`. Not worked around. Handed Swayam the command to run himself with `!`.
- **Swayam's run timed out**: `shinkansen.proxy.rlwy.net:51870` → `Operation timed out`. `nc` confirms port 443 on the same host connects, 51870 does not — the same host:port worked on 9 Sep. Either the Postgres service's TCP proxy was disabled/re-ported, or the current network blocks non-standard outbound ports.

**Next**: (1) check Railway → Postgres → Settings → Networking → TCP Proxy, or retry from another network (`nc -vz -G 5 shinkansen.proxy.rlwy.net 51870` must say `succeeded`); (2) run the AUD-078 preflight (Swayam runs it via `!`), confirm no `UNCLAIMED` rows and `job_owned_nulls = 0`; (3) dump → restore to `despl_rehearse` → `migrate deploy` → verify, per `MERGE-RUNBOOK.md` §5; (4) stop at the §5.7 abort point for Swayam's go before applying to production; (5) post-apply: `_prisma_migrations` 71 applied / 0 failed (71 dirs on disk), `migrate diff --exit-code` 0, `/api/health` 200.

## Session — 5-migration window rehearsed clean; production apply deferred, 5 Oct 2026 (later)

Continuation of the blocked window above. **Root cause of the timeout**: the office network blocks outbound TCP 51870 to *any* host (`portquiz.net:51870` also timed out; `:8080` and the Railway proxy's `:443` connected) — not Railway. Switched to a phone hotspot; port connected.

**AUD-078 preflight on production (Swayam ran it, read-only)**: 1 organization (`DESPL`, id 1); **zero** `tenant_id IS NULL` rows in all 4 tables (library or job-owned); `job_owned_nulls = 0`. The backfill is a no-op on production — every library row already carries tenant 1. (The preflight's per-template query errored on a non-existent `t.name` column — moot with 0 rows; fixed in the scratch file.)

**Fresh dump** `~/despl-prod-20261005-2325.dump` (536K, Swayam ran it). Dropped the stale 9 Sep `despl_rehearse` (66 applied) and restored the new dump: 66 applied / 0 failed, 98 policies, 1 org, 3 jobs, 10 units, 1116 process_plans, 8 users — faithful.

**Rehearsal** (`prisma migrate deploy` against local `despl_rehearse`): all 5 applied, **71/71, 0 failed**. Verified: AUD-078 `tenant_id` NOT NULL + RESTRICTIVE strict `tenant_isolation` on all 4 tables; AUD-006 16 CHECK constraints all `convalidated` against real production rows; AUD-079 `pending_password_resets` with RLS + policy, `despl_web` has SELECT/INSERT/UPDATE + sequence USAGE; `audit_log` UPDATE still denied to `despl_web`; `migrate diff --to-schema-datamodel` → "No difference detected". As `despl_web` in a rolled-back txn: tenant 1 sees 4 QCP templates, tenant 999 sees 0; a `pending_password_resets` insert succeeds and is invisible to tenant 999. §5.6 browser pass and §5.8 restart proposed as skippable (code already live; client already built with #66's schema) — not yet confirmed by Swayam.

**Stopped at `MERGE-RUNBOOK.md` §5.7 abort point. Production NOT migrated** — Swayam chose to start development next session instead. Production still runs on 66 migrations; `/api/health` stays 503 (pending-migrations signal; Railway doesn't use it as a healthcheck). Live impact meanwhile: QC/ADMIN password resets fail; AUD-006 constraints and AUD-078 strict RLS not enforced in production.

**Rules until the 5 are applied**: develop freely on branches/locally (local DBs have all 71), but **do not merge to `main` anything that adds a migration or depends on these 5** (e.g. the AUD-079 approve-reset button) — Railway auto-deploys `main` with no migration step.

**To finish the window** (must be on a network that allows outbound 51870 — hotspot works; if more than a few days pass, re-dump and re-rehearse first): Swayam runs
```
cd "<repo>" && railway run --service Postgres -- sh -c 'echo "TARGET: $(echo "$DATABASE_PUBLIC_URL" | sed -E "s#.*@##")"; DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s exec prisma migrate deploy 2>&1 | tee "$HOME/prod-deploy-$(date +%Y%m%d-%H%M).log"'
```
confirm TARGET is `shinkansen.proxy.rlwy.net:51870`, then verify `/api/health` → 200. Rollback = the 5 Oct dump.

**Next session — development.** Candidates (Swayam's pick): AUD-024 (stop merges shipping code ahead of schema — highest leverage), AUD-079 approve-reset button in `/admin` (do not merge before the window), provisioning the 12 `<dept>@despl.local` accounts in production, AUD-072 pessimistic-lock follow-up, remaining audit P0s AUD-008…023. Housekeeping still open: stray `.claude/worktrees/agent-*` dirs break unscoped `pnpm test`/`lint`; local `despl_rehearse` (now at 71) can be dropped once production is applied.

## Session — Phase Plan v1 added, 11 Oct 2026 (docs only, no code)

DESPL team returned the Standard Parts Master (PV + HE) with the DE0423 GA and SP40 MED drawings. Added `docs/lean-core/PHASE-PLAN-v1.md`: phases P0–P7 with gates (go-live on DESPL's server 16 Jan 2027, ≈30 Jan if the pilot is DE0423), new **Phase M** (M1 master-data schema, M2 workbook importer, M3 master-data screens), decisions D14–D27, 20 team inputs (I1–I20), definition of done. Inputs copied to `docs/lean-core/inputs/2026-10-11-master-list/` (PDFs git-ignored). `CLAUDE.md` decisions table extended with D14–D27 and points at the plan; build prompt header and §7 doc rule updated. Workbook is all Draft; known defects in plan §7 (pilot-part stage fill-down 19/20/21, proposed times, stale A-01/A-02).

**Next:** L0.1 (Swayam, hotspot) → L0.2 → L0.3 → L0.4 (commit `CLAUDE.md`, `docs/lean-core/`, `design/lean-core/`, flags) → L1.1 → M1 → M2. Decision meeting with SJ for D1–D5, D13–D16.

## Session — L0.4 repo and docs reset, 11 Oct 2026 (PR #68 and test fix PR #69, both merged to `main` 11 Oct)

**Shipped:** Lean Core drafts landed (`CLAUDE.md`, `docs/lean-core/` with the workbook xlsx, PDFs git-ignored; `design/lean-core/`). `src/lib/shared/flags.ts` (all five off) + `FEATURE_FROZEN`: snapshot publish/verify/reject and `updateJobDatesAction` (date change + reschedule) refuse; job page hides Client View and the date editor; `/jobs/new` offers only Pressure Vessel and `createJobAction` refuses other families server-side; initial schedule at job creation untouched. Tests: `src/app/frozen-features.test.ts`.
**Client logins land on a 404** at `/portal` while the portal is frozen (`e2e/auth.spec.ts` expects it). CI's e2e job caught a strict-mode locator in that assertion (heading and route announcer both matched); fixed in `c333e39`, e2e green in CI.
**Docs:** `audit/` now tracked as-is. 59 superseded docs moved by `git mv` to `docs/archive/` (mos-blueprint, PROMPTS-v4, LEDGER, PHASE-PROMPTS, AUDIT-*, PLAN-/SPEC-, PRD/TRD, …); kept DESIGN_SPEC and the two DESPL-320 seed-source docs. Pointers rewritten in kept docs, `CLAUDE.md` and one script message; code comments still name the old paths. This file now holds only October entries; everything older (incl. the undated reference sections) is in `docs/archive/progress-aug-sep-2026.md`.
**Tooling:** vitest/eslint ignore `.claude/**`, so unscoped `pnpm test`/`pnpm lint` skip agent worktrees (none deleted).
**despl_test rebuilt** (local only: drop, create, 71/71 migrations, `db:seed`, DESPL-320 components/BOM/assembly seeds, schedules for DESPL-320/DE0463/DE0467). `pnpm test:db` went from 29 failures (same on `main`; cause: failed `aud006_check_constraints` migration on stale data) to 1181/1181 passing.
**Test fix (PR #69):** the DESPL-320 hold-point test in `process.service.test.ts` flipped seeded process-10 operations to COMPLETE and never restored them, so `test:db` failed on every second run; it now restores them in a `finally`. Three isolated and two full `test:db` runs on one DB, 1181/1181. No other un-restored mutation found.
**Not done:** `.claude/worktrees/agent-*` and merged branches untouched (needs Swayam's OK). `docs/USER-GUIDE-WHY-WAS-I-REFUSED.md` lacks the newest codes (`FEATURE_FROZEN`).
**Also landed:** `PHASE-PLAN-v1.md` §9 (carried-over decisions, team questions A1–H6, production-readiness work), D28 row, D5/I16 updates. Merge commits `835e0e5` (#69), `2b0a0bb` (#68). Railway deploys `main` with no migration; production still 66/71, `/api/health` 503; portal 404 and non-PV intake refusal are live.
**State at hand-off:** P0 gate not met (health 71/71, staging, D2/D3/D4/D5/D13 recorded all open). `despl_test` is clean and seeded. Remote branches `lean/L0.4-repo-reset` and `fix/process-service-test-rerunnable-main` not yet deleted; `pre-redesign` tag (D28) not created.
**Next session starts at L0.1** (Swayam, phone hotspot): re-dump production, re-rehearse the 5 migrations on a restored copy (MERGE-RUNBOOK §5; the 5 Oct rehearsal is stale), apply by hand, verify `/api/health` 200 and 71/71 → L0.2 (Railway pre-deploy + healthcheck clicks, then agent updates the CLAUDE.md stack section) → L0.3 staging. L1.1 after L0.2 (add STORES and ENGINEERING to OPERATOR/PLANNER, §9.4); D2–D4 gate L1.2; §9.3 week-1 questions D1 (RW/R&A), A7–A9 feed L1.2.

## Session — L0.1 production migration window, 11 Oct 2026 (5 migrations applied; production now 71/71)

**Applied** the 5 queued migrations (AUD-078 ×3, AUD-006, AUD-079) to production by hand from the phone hotspot, after a fresh dump (`~/despl-prod-20261011-1540.dump`, 536K) was restored to a clean `despl_rehearse` and rehearsed first. Log: `~/prod-deploy-*.log`; rehearsal log `~/rehearse-deploy-20261011.log`. Swayam ran every production-touching command; the agent only ran local ones.
**Rehearsal on the copy:** restore 66/0 (98 policies; 1 org, 3 jobs, 10 units, 1116 plans, 8 users, same as 5 Oct) → `migrate deploy` 71/0 → `migrate diff` "No difference detected" → 0 NULL-tenant rows in the 4 QCP tables, `tenant_id` NOT NULL, 15/15 AUD-006 CHECKs validated, `pending_password_resets` has RLS and `despl_web` INSERT, `audit_log` UPDATE/DELETE denied. No `DROP`/`TRUNCATE`/`DELETE` in the 5 migrations.
**Production after apply (accept criteria met):** `/api/health` **200** `{"status":"ok"}` (was 503), `/login` 200, `_prisma_migrations` **71 applied / 0 failed**, `migrate diff` vs datamodel "No difference detected".
**Gotchas for next window:** (1) `pg_dump` on PATH is Homebrew 14 but production is Postgres **18.6** — prefix `PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"` or the dump aborts on version mismatch. (2) `despl_app`/`despl_web` are cluster-wide locally; do NOT run `scripts/provision-db-role.sql` for a rehearsal — it resets `despl_web`'s password and breaks `despl_test`. (3) AUD-006 adds **15** constraints, not 16 (the 5 Oct note miscounted). (4) `$$` inside `sh -c '…'` expands to a PID — put SQL in a file and use `psql -f`.
**Not done:** the follow-up row-count/grant query against production (`prod-verify.sql`: counts 3/10/1116/8, 99 policies, `audit_log` UPDATE/DELETE denied) not yet pasted back; §5.6 browser pass and §5.8 restart skipped (code already live); `despl_rehearse` not yet dropped.
**State:** production 71/71. Rule "no migration merges to `main`" **still stands until L0.2** (pre-deploy step not yet in Railway). AUD-079 approve-reset button in `/admin` can now merge once L0.2 lands.
**Next:** L0.2 — Swayam sets Railway Pre-Deploy Command `pnpm prisma migrate deploy` + Healthcheck Path `/api/health`; agent then updates the `CLAUDE.md` stack section → L0.3 staging → L1.1. D2–D5, D13, D28 still open (due 17 Oct).

## Session — L0.2 pre-deploy migrations enabled, 11 Oct 2026 (docs on `lean/L0.2-predeploy-docs`)

**Done (Swayam, Railway dashboard):** Pre-Deploy Command `pnpm prisma migrate deploy` set on service `despl-production-tracker` (project `bubbly-forgiveness`, env `production`). Deploy log shows it running: "71 migrations found … No pending migrations to apply"; `/api/health` 200 afterwards. Accept criterion met.
**Agent:** `CLAUDE.md` stack section rewritten (migrations now apply on deploy; dashboard, not `railway.json`, is authoritative); `MERGE-RUNBOOK.md` §2 got an update note. No code changed.
**Rule change:** "no migration merges to `main`" is lifted. Every migration PR still gets a rehearsal on a restored copy first; a failed pre-deploy leaves the old container serving silently, so read the deploy log.
**Open:** Healthcheck Path `/api/health` not yet confirmed in the dashboard; `main` has no branch protection; `cron-alerts` (last run failed ~44 min before check) and `cron-digest` (failed ~16 h) show failed runs — cause unknown, logs not read; second staged Railway change ("2 changes") not identified.
**Agent could not drive the Railway UI:** the auto-mode classifier blocked production reads/writes and edits to its own permission settings; Swayam did the clicks. A local `.claude/settings.local.json` allow-rule was added by Swayam (gitignored).
**Next:** L0.3 staging → L1.1. D2–D5, D13, D28 still open (due 17 Oct).

## Session — L0.2 wrap, branch protection and cron triage attempted, L0.3 planned, 11 Oct 2026

**Merged:** PR #71 (`5e84f0b`) — pre-deploy migrations documented; CI green first. Production `/api/health` 200. Second no-op pre-deploy run not yet read from the merge deploy's log.
**Branch protection on `main`: NOT enabled.** The classifier blocked the `gh api` call (shared resource). Swayam runs it himself: required PR + `ci` + `migration-pr`, 0 approvals, `enforce_admins:false`, no force-push/deletion (`gh api -X PUT repos/swayams13/despl-production-tracker/branches/main/protection --input -` with `{"required_status_checks":{"strict":false,"contexts":["ci","migration-pr"]},"enforce_admins":false,"required_pull_request_reviews":{"required_approving_review_count":0},"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}`). Until then, nothing but discipline stops an unrehearsed migration PR now that pre-deploy runs DDL on every push to `main`.
**Cron failures: cause still unknown.** `cron-alerts` / `cron-digest` routes are live (POST without secret → 401). Railway CLI refuses `logs` without `railway setup agent` (not run). Hypotheses, most likely first: `CRON_SECRET` mismatch on the cron service; AUD-078 strict tenant RLS hitting a session-less `runAlertReconciliation`/`publishDigest` (cron tests predate it); call landed mid-deploy; no active ADMIN in the org. Needs the last ~20 log lines of each cron service from Swayam.
**Agent limits seen:** classifier denied Railway UI writes/reads, edits to `.claude/settings.local.json` (Swayam created it by hand; gitignored allow-rule, did not take effect in-session), and the branch-protection API call.
**L0.3 plan (agreed, not started):** empty `staging` env in `bubbly-forgiveness` → Postgres → web service from branch `staging` → vars `DIRECT_URL`, fresh `AUTH_SECRET`, strong `SEED_PASSWORD`, no `DATABASE_URL` yet → pre-deploy + healthcheck → first deploy migrates, app crash-loops on the role guard (expected) → run `scripts/provision-db-role.sql` via proxy (hotspot, port 51870) → set `DATABASE_URL` as `despl_web` → `pnpm db:seed` → redeploy. No staging cron. Accept: staging `/login` serves, health 200. Agent writes `docs/lean-core/L0.3-STAGING-RUNBOOK.md`, creates `staging` branch, then updates `CLAUDE.md` stack text.
**Next session starts at L0.3**, then branch protection and cron logs when Swayam has them. L1.1 after L0.3. D2–D5, D13, D28 due 17 Oct.

## Session — L0.3 staging environment built and verified, 12 Oct 2026 (docs on `lean/L0.3-staging-docs`)

**Done (agent, via Railway CLI/API, Swayam's permission):** empty `staging` env in `bubbly-forgiveness` → Postgres 18 (`Postgres-XSEs`) → service `despl-staging` from branch `staging` (cut from `main` `5e84f0b`). Pre-deploy `pnpm prisma migrate deploy`, healthcheck `/api/health`, domain `despl-staging-staging.up.railway.app`, no cron, `CRON_SECRET` unset. Demo seed run: 1 org, 20 users, 3 jobs, 9 units.
**Accept met:** staging `/api/health` 200, `/login` renders, `_prisma_migrations` 71 applied / 0 failed (+1 rolled-back history row), boot guard passes as `despl_web` (cannot UPDATE/DELETE `audit_log`). Production `/api/health` 200, no production deploy during the work.
**Found:** (1) a fresh DB cannot finish the 71 migrations until `despl_web` exists — 6 migrations GRANT to it; first deploy fails at `20260815120000_v_unit_stage_status` by design (recover: provision, `migrate resolve --rolled-back`, redeploy). (2) the seed is one 180 s transaction and times out over a public proxy; run it as a one-off pre-deploy on Railway, then revert the setting. (3) CLI `environment edit -s` did nothing; GraphQL `serviceInstanceUpdate` with an explicit `environmentId` worked.
**Not done / yours:** a human sign-in at staging `/login` (agents may not enter passwords on a deployed host) — seed password is in the session scratchpad, not the repo; rotate or keep as you prefer. Temporary TCP proxy deleted. `main` branch protection and cron logs still open.
**Next:** open the docs PR, then L1.1. D2–D5, D13, D28 due 17 Oct.

