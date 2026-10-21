# J-Phase Plan v1: the remaining J sessions, with paste-ready prompts

**Written:** 21 Oct 2026 (architect session, read-only on code) · **Owner:** Swayam · **Reads with:** `CLAUDE.md` (binds), `docs/lean-core/PHASE-PLAN-v1.md` (phase order, gates, D/I ids), `docs/lean-core/BUILD-PROMPT-lean-core-v1.md` §5 Phase J and §8 (what each J session builds).
**State of play (origin/main `7e721e8`):** J1, J2, J3a, J4a merged (newest migration `20261022100000_j4a_planned_joints`, 83 in total). L1.3 (JOB grain) is built on the local branch `lean/L1.3-job-grain` (commits `8671c68`, `a970e1e`, base `13168ac`) and not merged.
**Precedence:** where this file and the build prompt disagree on how a J session is cut or sequenced, this file wins (it is the later, code-checked plan); on rules, `CLAUDE.md` wins.

Every file and function named below was checked on `origin/main` on 21 Oct. Line numbers are approximate.

---

## §0 Session preamble (every prompt in §C says "follow §0 first")

1. **Read, in order:** `CLAUDE.md`; build prompt §5 "Phase J" and the §8 frames/errata named in your session; `PHASE-PLAN-v1.md` §3 P3 and §6; the `progress.md` entries "J1", "J2", "J3a", "J4a" and "pilot review hand-over, 21 Oct"; this file's §A, your session's §B entry and §E. Read everything from `origin/main`: `git fetch -q origin && git show origin/main:<path>` (until this plan merges: `git show origin/docs/j-phase-plan:docs/lean-core/J-PHASE-PLAN-v1.md`). Never trust the main checkout's working tree; another session may have switched its branch.
2. **Worktree, Node, deps** (Homebrew node is broken on this machine):
   ```bash
   cd "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER" && git fetch -q origin
   git worktree add ../despl-<slug> -b lean/<id>-<slug> origin/main
   cd ../despl-<slug>
   export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
   corepack pnpm install --frozen-lockfile && corepack pnpm prisma generate
   cp "../DESPL TRACKER/.env" "../DESPL TRACKER/.env.test" .
   ```
3. **Your own test database** (never `despl_demo`, never the shared `despl_test` while another session runs):
   ```bash
   createdb despl_test_<slug>
   perl -pi -e 's{/despl_test(?=[?"\s]|$)}{/despl_test_<slug>}g' .env.test
   grep -c "despl_test_<slug>" .env.test            # must print 2 (DATABASE_URL and DIRECT_URL)
   set -a && . ./.env.test && set +a
   psql "${DIRECT_URL%%\?*}" -Atc "select current_database()"   # must print despl_test_<slug>
   corepack pnpm prisma migrate deploy
   corepack pnpm db:seed && corepack pnpm db:bootstrap
   corepack pnpm db:seed:despl320-components && corepack pnpm db:seed:despl320-bom && corepack pnpm db:seed:despl320-assembly-steps
   ```
   Same order as `.github/workflows/ci.yml`. If `migrate deploy` fails because the role `despl_web` is missing, stop and tell Swayam. Do **not** run `scripts/provision-db-role.sql` (it resets `despl_web`'s password for the whole cluster).
4. **Plan, then build.** Post a plan of at most 15 lines (files, migration name, tests). Then implement without waiting: Swayam has authorised building. Stop only on a "Blocking" item listed in your §B entry; for every other open point take the stated default and name it in the PR.
5. **Gates:** while iterating, run your own test files (`corepack pnpm exec vitest run <file>`, DB files with `RUN_DB_TESTS=1` after sourcing `.env.test`). Before the PR: `corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test && corepack pnpm test:db`. A migration also needs `corepack pnpm prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` = no difference.
6. **Chrome check** (UI sessions): `LEAN_FLOOR=on corepack pnpm dev -p <port>` with `.env.test` sourced, sign in through the real `/login` form as the seeded users (dev password from `prisma/seed.ts`), click every control you built. **Never** read `AUTH_SECRET` or mint a session/JWT/cookie (CLAUDE.md "Agent conduct"). No browser automation available → say so and report verification as incomplete.
7. **PR:** stage by explicit path only (never `git add -A`; `scripts/reset-prod-admin.ts` must never be committed). Commit messages and the PR body end with the attribution lines your harness gives you; the PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. `gh pr create --base main` (add `--label migration` if you carry one). Watch CI; the `e2e/job-overview.spec.ts` flake is known, name it if it is the only red. **Never merge** (Swayam merges on "merge"), never push to `main`, `demo` or `staging`, never connect to production or Railway. Put the production steps (dump, restore, rehearsal, backfill dry run) as exact commands in the PR body for Swayam.
8. **progress.md:** add at most 15 lines: what shipped, defaults taken, what Swayam must run, next.
9. **Rules that bite J sessions:** migrations additive and forward-only, never edit an applied one; new job-owned tables copy the `planned_joints` pattern (`job_id` + `tenant_id` via the `aud001_tenant_id_autofill` trigger, `job_isolation` + RESTRICTIVE `tenant_isolation` policies, see `prisma/migrations/20261022100000_j4a_planned_joints/migration.sql`) and extend the RLS coverage tests; any query on `process_plans`, `qcp_executions`, `schedule_runs` or other child tables filters through the job explicitly (they have no RLS of their own; `withTenant()` alone does not scope them); scheduling and gating read materialised rows, never `Equipment.config` (J2 static guard); refusals use stable codes with a plain message in `src/lib/shared/errors.ts`; tests for gating/RBAC/audit changes are table-driven violation cases first.

| Session | Slug (worktree `../despl-<slug>`, DB `despl_test_<slug>`) | Branch | Dev port |
|---|---|---|---|
| L1.3-ship | l13ship | `lean/L1.3-job-grain-ship` | 3101 |
| JG1 drawings | jg1-drawings | `lean/JG1-drawing-release` | 3102 |
| JG2 QCP attach | jg2-qcp | `lean/JG2-qcp-attach` | 3103 |
| J3b | j3b | `lean/J3b-line-reads` | 3104 |
| J4b | j4b | `lean/J4b-weld-map` | 3105 |
| J4c | j4c | `lean/J4c-assembly-sequence` | 3106 |
| J5a | j5a | `lean/J5a-bom-release` | 3107 |
| J5b | j5b | `lean/J5b-release-screen` | 3108 |
| J5c | j5c | `lean/J5c-release-diff` | 3109 |
| J6 | j6 | `lean/J6-lots` | 3110 |
| J7a | j7a | `lean/J7a-job-drafts` | 3111 |
| J7b | j7b | `lean/J7b-new-job-flow` | 3112 |
| J8-code | j8 | `lean/J8-milestones-he` | 3113 |
| Gate run | gate | `docs/j-gate-de0423` | 3114 |

---

## §A Phases, parallelism, migrations, effort, critical path

### A.1 Phase table

| Phase | Sessions | Run in parallel? | Starts when | Leaves when |
|---|---|---|---|---|
| **P-J0** prerequisites | L1.3-ship · JG1 · JG2 | all three in parallel (disjoint files) | now | L1.3 merged and its backfill run on production; JG1, JG2 merged |
| **P-J1** joints, sequences, line reads | J4b · J4c · J8-code · J3b | J4b, J4c, J8-code in parallel **from day one** (no dependency on P-J0); J3b only after L1.3 merges (same view, same readers) | J4b/J4c/J8: now · J3b: after L1.3 merge | all four merged |
| **P-J2** BOM release (gate path) | J5a → J5b | serial (J5b builds the screen on J5a's service) | J4b, J4c, JG2 merged | J5b merged |
| **Gate** | DE0423 gate run on staging | alone | J5b merged and staging deployed | PHASE-PLAN P3 gate demonstrated |
| **P-J3** after the gate | J5c · J6 · J7a | J6 and J7a in parallel (J6 merges first; J7a rebases over `createJobSchema`); J5c alone (touches every floor reader) | gate passed (or Swayam's go) | merged |
| **P-J4** | J7b · J8-content | J7b after J7a; J8-content blocked on DESPL inputs (§B.J8) | J7a merged / inputs arrive | merged |

### A.2 Dependency graph

```
L1.3-ship ──────────────► J3b
JG2 ──────────┐
J4b ──────────┼─────────► J5a ──► J5b ──► GATE (DE0423 on staging) ──► J5c
J4c ──────────┘                                   │                  ├─► J6 ──┐
JG1 (pilot H3, not gate)                           │                  └─► J7a ─┴─► J7b
J8-code ───────────────────────────────────────────┴────────────── J8-content (waits I10/I11/D19)
```

**Cannot run together:** L1.3-ship and J3b (both replace `v_unit_stage_status`, both edit `stage-detail.read.ts`, `gantt.read.ts`, `workspace.read.ts`); J5a and J5c/J6 (all edit `component.service.ts` `materializeComponentsFromBomItems`, `assembly.service.ts` `materializeAssemblyStepsFromTemplate`, `work.service.ts`); J7a and J7b (wizard). **Small known conflicts, resolve on rebase:** JG1, J4b and J5b each add one link in `src/app/(app)/jobs/[id]/_tabs/materials-tab.tsx`; JG2 and J5a both touch `job-intake.service.ts` (JG2 exports the QCP clone, J5a removes floor materialisation from `createJob`); every session appends to `progress.md`'s tail (keep both entries).

### A.3 Migration timestamp rule

Next free timestamp is after `20261022100000_j4a_planned_joints`. Each migration-carrying session owns one slot; a session that might need a migration it did not expect uses its spare slot:

| Session | Migration (reserved) | Spare slot |
|---|---|---|
| L1.3-ship | `20261023100000_l13_job_grain_stage_view` (rename of `20261019120000_…`) | — |
| J3b | `20261024100000_j3b_line_stage_view` | — |
| J8-code | `20261025100000_j8_milestones` | — |
| J4b | none expected | `20261025500000` |
| J4c | `20261025600000_j4c_assembly_version_approval` | — |
| JG1 / JG2 | none expected | `20261025700000` / `20261025800000` |
| J5a | `20261026100000_j5a_bom_release` | — |
| J5c | `20261027100000_j5c_release_diff` | — |
| J6 | `20261028100000_j6_lots` | — |
| J7a | `20261029100000_j7a_job_drafts` | — |
| J7b | none expected | `20261030100000` |

**Rule:** migrations must reach `main` in name order. Before asking for "merge", check `git ls-tree origin/main prisma/migrations/`: if `main` already holds a migration named later than yours, `git mv` yours to the next free 10-minute slot above main's newest (in your PR, never after merge) and re-run `migrate deploy` on your own DB plus `migrate diff`. A merge applies the migration on deploy (Railway pre-deploy), so each one needs the dump → restore → `migrate deploy` rehearsal (MERGE-RUNBOOK §5, Postgres 18 client tools) before "merge"; the PR body carries the commands.

### A.4 Effort and critical path

| Session | Hours (Sonnet) | Model | On the DE0423 gate path? |
|---|---|---|---|
| L1.3-ship | 5 | Sonnet | no (prerequisite: DE0423 gets 12 office plans, not 36) |
| JG1 drawings | 4 | Sonnet | no (needed for a DE0423 pilot: H3) |
| JG2 QCP attach | 4 | Sonnet | **yes** (release binds steps to the job's QCP) |
| J3b | 6 | Sonnet | no (DE0423 is single-line) |
| J4b | 6 | Sonnet | **yes** (nozzle/skirt/gusset joints) |
| J4c | 7 | Sonnet (rules below are the spec) | **yes** (DE0423's assembly sequence as data) |
| J5a | 10 | Sonnet; Opus 30 min only if a §B rule proves wrong | **yes** |
| J5b | 6 | Sonnet | **yes** (release through the UI) |
| Gate run | 3 + Swayam/SJ time | Sonnet | **yes** |
| J5c | 8 | Opus plan, Sonnet build | no |
| J6 | 8 | Sonnet | no (D21 default Serial) |
| J7a | 8 | Sonnet | no |
| J7b | 8 | Sonnet | no |
| J8-code | 6 | Sonnet | no |
| **Total** | **≈ 89 h ≈ 14 sessions** | | gate path ≈ 36 h |

**Critical path:** (J4c ∥ J4b ∥ JG2, one day) → J5a (1.5 days) → J5b (1 day) → gate run on staging (half a day + SJ approvals) ≈ **4–5 working days**, finishing well before the 16 Nov D5 check. SJ's approval of DE0423's part families and the assembly sequence in the tracker is the real long pole (data, not code).

---

## §B Sessions

### B.L1.3 — L1.3-ship: JOB grain onto main (Phase-0 prerequisite)

**Goal.** Put the built L1.3 (one plan per job for processes 1–11 and 33) on `main`, rehearsed, then collapse DESPL-320's per-unit office plans. **Why now:** every new job (DE0423 included) otherwise gets 36 office plans for 3 units; J3b must replace the same view after it.

**Files.** Fresh branch off `origin/main`; `git cherry-pick 8671c68 a970e1e` (refs are shared with the main checkout). Expected conflicts: `src/lib/services/schedule.service.ts` (J3a rewrote `generateSchedule` to schedule each route's subgraph), `_shared.ts` (`loadJobSpine`), `work.facts.ts`, `process.service.ts`, `prisma/seed.ts`, `job-intake.service.test.ts`. Resolution rule: a JOB-grain process is a job-level row (`equipment_id` NULL, already enforced by J3a's CHECK) and gets **one** unit-less plan per job, no matter how many routes; per-route loops in `generateSchedule` must skip JOB-grain rows after the first route (or emit them once outside the loop). `git mv prisma/migrations/20261019120000_l13_job_grain_stage_view prisma/migrations/20261023100000_l13_job_grain_stage_view`; update `docs/lean-core/L1.3-JOB-GRAIN-RUNBOOK.md` counts (84 migrations after it).

**Also in scope (default, Q5):** new jobs get JOB grain only from a template version that says so. Add `scripts/lean-publish-job-grain-template.ts` (dry run default, `--apply`, `--actor-user <id>`): clone the published PV process template version with `template.service.ts` `cloneVersion`, set `grain = JOB` on codes 1–11 and 33 through `saveDraftVersion` (it already carries `grain`), `publishVersion`. Invariant 9: never edit the published version. Running jobs keep their pin.

**Data model.** View only (`CREATE OR REPLACE VIEW v_unit_stage_status`, column list unchanged, GRANT kept).

**Invariants at risk.** 11 (a derived JOB plan completes only via `rollupProcessPlan`); maker-checker on a collapsed plan (the a970e1e fix: units submitted by different makers never collapse to SUBMITTED, keep its test); audit (one `backfill.jobGrain` + one `schedule.collapseJobGrain` row per process).

**Tests.** Keep `src/lib/services/job-grain.test.ts`, `src/lib/shared/job-grain.test.ts`; add a case to `j3a-line-routes.test.ts`: a two-route job with a JOB-grain process has exactly one unit-less plan for it and both routes' units show it on the spine. Full `test:db`.

**Acceptance (Chrome, port 3101).** On your DB after `lean-backfill-job-grain.ts --job DESPL-320 --apply`: DESPL-320 job board shows office stages filled on all 9 units from one plan; the Planning/PPC user's Today lists one item per office process, not nine; `/qc` counts unchanged.

**Production (Swayam, hotspot).** Runbook §A rehearsal on a fresh dump (expect 1 migration, then backfill dry run = apply, second dry run "0 job(s)"; DESPL-320 current run 12 + 216 = 228 plans) → merge → read the deploy log → §C production backfill (`--job DESPL-320` first) → template publish script dry run then `--apply`. Rollback: the dump; the migration is view-only.

**Risks.** Rebase errors in the per-route scheduler (two unit-less plans for one process; caught by the new j3a case). Mixed SUBMITTED/ON_HOLD units are skipped by the backfill unless `--force-mixed`: decide with SJ from the dry run.

### B.JG1 — Drawings: register, link, release at risk (adjacent gap, in scope)

**Goal.** Make H3 (pressure-part cutting needs a released or at-risk-released drawing) work for new parts. Today `createDrawingRevisionAction` is used only from the BOM panel for a component that already has a drawing; `releaseDrawingAtRiskAction` and `linkGoverningDrawingAction` have no UI caller; `AssemblyDrawing` rows are created only by seeds. Not on the gate path; needed before a DE0423 pilot.

**Files.** `src/lib/services/drawing.service.ts` (new `createAssemblyDrawing`; `createDrawingRevision` stays), `component.service.ts` (new bulk `linkDrawingToComponents` reusing `linkGoverningDrawing`'s checks, one audit row per component), `src/app/actions/drawing.ts`, new page `src/app/(app)/jobs/[id]/drawings/page.tsx` (+ `_client.tsx`), one link in `_tabs/materials-tab.tsx`. Read H3 state with `drawingStateOf` and gaps with `h3DataGaps` (`src/lib/shared/floor-rules.ts`).

**Behaviour and defaults.** Create drawing / issue revision / link: ADMIN, PRODUCTION_HEAD and (new) ENGINEERING (ratify SJ). Release at risk: PRODUCTION_HEAD only, reason required, client consent ref optional (D2 H3, unchanged service). "Link to parts": pick a line, list its pressure-retaining components with no governing drawing (the H3 data gaps), link all or some. No migration.

**Tests.** Extend `drawing.service.test.ts` (role table, other job/tenant refused, drawing number unique per job if the schema has no constraint: refuse duplicates in the service); new `jg1-drawing-h3.test.ts` (DB): link → `recordWork` START on pressure cutting refused `DRAWING_NOT_RELEASED` → at-risk release → allowed; audit rows per component.

**Acceptance (3102).** As SJ: create GA drawing for DESPL-320 line, issue Rev 0 DRAFT, link SR01's pressure parts, try cutting the shell as the Fabrication Prep supervisor (refused with the plain H3 text), release at risk with a reason, cutting starts.

**Production.** None (no migration, no data). Size 4 h.

### B.JG2 — Attach a QC plan after job creation (adjacent gap, in scope)

**Goal.** A job created without a QCP (or before the right one existed) can take one, so J5's release binds inspection steps to checkpoints. **Blocks J5a.**

**Files.** `src/lib/services/job-intake.service.ts`: turn the private `cloneQcpTemplate` (≈ line 719) into a tx helper used by both `createJob` and new `attachQcpTemplate(actor, { jobId, qcpTemplateSourceId })`; `src/app/actions/job-intake.ts`; `src/app/(app)/jobs/[id]/_tabs/qc-tab.tsx` (empty state "This job has no QC plan" + picker, with the same "does not match the assembly checklist" warning PR #130 added to the wizard).

**Behaviour and defaults.** Roles ADMIN, PRODUCTION_HEAD (ratify QC head whether QC may attach). Refuse `QCP_ALREADY_ATTACHED` (new code) if the job has a QcpTemplate; replacing one is not built. After cloning, bind existing **NOT_STARTED** INSPECTION assembly steps with `qcpItemId` NULL using the same matcher `materializeAssemblyStepsFromTemplate` uses (`matchInspectionStep` in `assembly-qcp-match.ts`, srNo occurrence over the full template); started or finished steps stay unbound and are listed in the result. `requiresQc` on existing rows is not re-derived. Unmatched process codes are returned, never dropped (as at create).

**Tests.** `qcp-attach.test.ts` (DB): role/client/tenant table; already attached; attach-after-create on a fresh job yields the same items and links as choosing the QCP at create; binds only NOT_STARTED steps; one audit row `qcp.attach`.

**Acceptance (3103).** Create a job without a QCP in the wizard, open its QC tab, attach DESPL-320's QCP, see the checkpoints. Size 4 h. No migration.

### B.J3b — Line-aware reads: spine, board, stage detail, Gantt, workspace

**Goal.** Every read shows a line on its own route with its own processes (J3a deferred this). No effect on today's jobs (production has 0 line-scoped processes), so it is correctness work for the two-route acceptance case. **After L1.3 merges.**

**Bug to fix first (verified):** `v_unit_stage_status` joins `job_processes jp ON jp.job_id = e.job_id`, so a unit on a line with its own route also gets the job-level UNIT-grain rows, which have no plan for it: its stages can never read complete. Same class: `_shared.ts` `rollupForSeq` (≈ line 1476) picks `jobProcess.findFirst({ where: { jobId, code } })`, which can roll up the job-level row for a line-route unit.

**Files.** Migration `20261024100000_j3b_line_stage_view`: L1.3's view body plus a route filter on `jp`: `jp.equipment_id = e.id OR (jp.equipment_id IS NULL AND (jp.grain = 'JOB' OR e.template_version_id IS NULL OR e.template_version_id = j.template_version_id))` (the SQL twin of `inRoute` in `src/lib/services/line-route.ts`). Then route-scope with `routeKey`/`inRoute`/`routeWhere`: `_shared.ts` `rollupForSeq`; `board.read.ts` `loadJobBoard` (group rows by line when a job has more than one route; one header row per line with its own stage names from `WorkOrderStage` of the line's family); `board.cell.read.ts` `loadBoardCell`; `board.export.read.ts`; `stage-detail.read.ts` `loadStageDetail` (`backingProcesses` by the unit's route); `gantt.read.ts` `loadJobGantt` (one group per route, labelled by line name; JOB-grain rows in a "Whole order" group); `workspace.read.ts` `loadPrioritizedJob`; `job-materials.read.ts` (its code map, ≈ line 94).

**Defaults.** A single-route job renders exactly as today (no line headers). Line label = `Equipment.name`. No new UI component.

**Tests.** New `j3b-line-reads.test.ts` (DB, isolated throwaway fixture modelled on `j3a-line-routes.test.ts`): view rows per unit come only from its route; a line-route unit's stage reads complete when its own plans complete; `rollupForSeq` updates the line row; board/stage detail/gantt group by line; DESPL-320's view output identical before/after (snapshot the rows); extend `tenant-scoped-views.test.ts` for the new view body.

**Acceptance (3104).** On your DB, create a two-route job through `createJob` in a test script (the wizard cannot yet), open its board and Gantt in Chrome: two line groups; DESPL-320 board unchanged.

**Production.** View-only migration: rehearse on a dump, compare `select fill_status, count(*) from v_unit_stage_status group by 1` (tenant set) before and after: identical. Size 6 h.

### B.J4b — Weld-map importer and joint register

**Goal.** Nozzle, skirt and attachment joints come from the line's weld map (J4a generates only LS/CS from `shell_courses`). **Gate path.**

**I7 is not supplied, so this default convention applies until QC/Welding sends one** (ratify QC head): `LS-n`, `CS-n` (generated), `NS-<tag>` nozzle-to-shell/head, `NF-<tag>` nozzle-to-flange, `SK-n` skirt-to-head, `BR-SK` base ring, `GW-n` gussets, `AT-n` other attachments. It matches DESPL-320's 14 backfilled joints and the workbook rows. `planned-joint.setup.ts` `jointTypeFromNo` already maps LS/CS/NS/NF/N<digit> and defaults to ATTACHMENT; keep it as the type inference.

**Files.** New `src/lib/services/weld-map.service.ts` (`dryRunWeldMap`, `applyWeldMap`, `addJointsFromTags`, `confirmWeldMap`), pure parser `src/lib/shared/weld-map.ts` (columns: Joint no · Type (optional, inferred) · Joins · WPS · NDT extent · Remarks; header aliases like `master-import.parse.ts`), reuse the upload hardening in `src/lib/shared/upload.ts` and `src/lib/services/xlsx-canonical.ts`; actions in new `src/app/actions/weld-map.ts`; page `src/app/(app)/jobs/[id]/weld-map/page.tsx` (+ client), link from the Materials tab. Frame 14C (errata 20: its counts are placeholders).

**Behaviour.** Per line. Idempotent on `(equipmentId, jointNo)`; source `IMPORTED`, `confirmed = false`. Re-import updates joins/WPS/NDT (audited, before/after); refuses a type change on a joint that has weld records or linked steps (`VALIDATION_FAILED` with the joint); never deletes: joints missing from a new file are reported "not in this file". "Add joints from tags" (`N1-N6, M1` → `NS-N1…NS-M1` and `NF-` pairs) is the no-Excel path for DE0423. Confirm: QC or ENGINEERING, audited; unconfirmed joints still feed release but are flagged. Roles to edit: ENGINEERING, PRODUCTION_HEAD, ADMIN. Placeholder behaviour: a line whose template has PER_JOINT NOZZLE/ATTACHMENT steps and no joints of that type expands those steps to nothing (J4a behaviour); the register and J5's release preview say "No nozzle joints on the weld map: nozzle weld steps will not be created". Until J5 merges, joints added after job creation do not create steps; the register says "Steps follow at BOM release".

**Tests.** `weld-map.test.ts` (pure: headers, aliases, blank and duplicate joint numbers, bad type, tag expansion); `weld-map.service.test.ts` (DB: apply twice = no change, no delete, type change refused with weld records, other job/tenant refused, roles, audit rows, confirm). No migration expected.

**Acceptance (3105).** Upload a 6-row sheet to a test job's line, see the dry run, apply, add `N1-N3` from tags, confirm as QC. Size 6 h.

### B.J4c — Assembly sequence as master data (new; closes "no code change")

**Goal.** An equipment type's scoped assembly template is authored from the workbook's "Assembly Sequence" sheet and published in the tracker, not by a script. Today no service or screen writes `AssemblyTemplateVersion` (only `scripts/backfill-assembly-template-v1.ts`, J1's `equipment-type.setup.ts` and seeds), and `master-import.parse.ts` parses the sheet (`AssemblyRow`) and checks it but never applies it. **Gate path.**

**Files.** `master-import.parse.ts` (extend `ASSEMBLY` with `groupName`, `seq`, `kind`, `result`), new pure `src/lib/shared/assembly-sequence.ts` (row → step mapping, below), new `src/lib/services/assembly-template.service.ts` (`dryRunAssemblySequence`, `importAssemblySequence`, `publishAssemblyTemplateVersion`), actions, and an "Assembly sequence" section on `src/app/(app)/admin/equipment-types` (versions, upload → dry run → confirm using the M3-C import component, read-only step table, Publish).

**Mapping rules (the spec; table-test each).** Kind Work/Inspection → `WORK`/`INSPECTION`. Department by seeded name (unknown → issue, row refused). "Counts toward stage no" → `leadTimeProcessSeq` (unknown process → issue). Joint ref → scope: none → `PER_UNIT`; `LS-n`/`CS-n` → `PER_JOINT` LONG/CIRC_SEAM; `NS-*`/`NF-*`/`N<digit>`/`M<digit>` → `PER_JOINT` NOZZLE; `SK-*`, `BR-*`, `GW-*` (incl. `GW-1…32`) → `PER_JOINT` ATTACHMENT; consecutive rows with the same activity, kind and department that differ only by joint number collapse into one PER_JOINT row (the dry run shows each collapse). `role` inferred by keyword (fit → FIT_UP, weld → WELD, RT/UT/PAUT/TOFD/NDT → NDT, PWHT final → FINAL_PWHT, heat treat/PFHT → HEAT_TREATMENT, hydro → HYDRO), shown for confirmation; `pressurePart` true when any "parts used" code is an APPROVED pressure-retaining part family; `requiresQc` true (D3 derives at materialisation where `role` is set); `qcpSrNo` blank (inspection steps bind only if the sheet gains a QCP column; flagged). Role inference and pressure flags are provisional (ratify SJ + QC head, like the 54-step mapping).

**Approval (migration `20261025600000_j4c_assembly_version_approval`).** Add `prepared_by_id`, `approved_by_id` (FK users) to `assembly_template_versions`. Import writes a new DRAFT version (next number) on the type's own `AssemblyTemplate` (creating it if absent; identical content → no new version). Publish: PRODUCTION_HEAD, approver ≠ preparer (`MAKER_CHECKER_VIOLATION`, admins not exempt), refuses a version with seam-driven steps when the type has no `shell_courses` question, stamps `publishedAt` server-side. Invariant 9: published versions are never edited; jobs keep the version on `Equipment.assemblyTemplateVersionId`; `resolveAssemblyTemplateVersion` picks the newest PUBLISHED for new jobs.

**Tests.** `assembly-sequence.test.ts` (pure, the table above); `assembly-template.service.test.ts` (DB: DRAFT created, re-import no-op, publish maker-checker, publish validation, a job created afterwards gets the new version and expands per joint, DESPL-320's pinned v1 untouched, tenant isolation). Fixture: the workbook's "HP Air Receiver Blow Down Vessel" rows (the explicit M2 fixture; never copy them into seeds).

**Acceptance (3106).** As admin import the DE0423 rows for "vertical on skirt" → DRAFT; as SJ publish; creating a job of that type shows PER_JOINT steps per seam. Production: migration rehearsal; no data step. Size 7 h.

### B.J5a — Floor steps generated at BOM release (service)

**Goal.** `createJob` makes the job, lines, units, processes and schedule only; `releaseBomRevision` materialises components, component operations (approved routes only, variant picked, `includeWhen` applied), assembly steps (scoped steps × planned joints × units, PER_COMPONENT over the released components) and QCP links, in one transaction. **Also closes the known gap** "new job copies the BOM but creates 0 components": `materializeComponentsFromBomItems` (`component.service.ts` ≈ line 682) silently skips BOM lines with no `componentTypeId` or no published route, and `copyBom` (`job-intake.service.ts` ≈ line 863) copies lines untyped as they are. After J5a, unmapped lines are listed and must be acknowledged.

**Needs merged:** JG2, J4b, J4c.

**Data model (migration `20261026100000_j5a_bom_release`).** `bom_items.route_variant TEXT NULL` (CHECK `~ '^[A-Z]$'`); `bom_revisions.materialized_at TIMESTAMPTZ NULL` (server clock). Nothing else: idempotency is by revision, provenance by `Component.bomItemId`, who/when by the audit row.

**Files.** New `src/lib/services/bom-release.service.ts`: `previewBomRelease(actor, { equipmentId, bomRevisionId })` (read only), `mapBomLines(actor, { bomRevisionId, lines: [{ bomItemId, componentTypeId | null, routeVariant | null }] })` (DRAFT revisions only), `releaseBomRevision(actor, { equipmentId, bomRevisionId, acknowledgeWarnings })`. Changes: `job-intake.service.ts` `createJob` stops calling `materializeComponentsFromBomItems` and `materializeAssemblyStepsFromTemplate`; `copyBom` writes the copied lines into a new DRAFT `BomRevision` 1 on **each** line that names a source (today only the first line gets a BOM); the J4a `shell_courses` check stays at create (extract it from the materialiser into a pure check both call). `component.service.ts` `materializeComponentsFromBomItems` takes the chosen variant (else `pickRouteTemplate`'s lowest letter) and an approved-only filter (component type kind `RAW_FORM`, or its `PartFamily.status = APPROVED`, version PUBLISHED: the same filter `importBomItems` uses ≈ `bom.service.ts:286`); sets `qtyPlanned` from an integer `qtyPer`. `assembly.service.ts` `materializeAssemblyStepsFromTemplate` unchanged in logic, now called from release with the job's QcpTemplate id and `LineRules.load(tx, equipmentId)`.

**Behaviour and defaults.**
- Roles: ENGINEERING, PRODUCTION_HEAD, ADMIN (Q3; PLANNER no). Client users refused. `withJob` + `SELECT … FOR UPDATE` on the equipment row so two releases serialise.
- Release flips the revision to RELEASED (stepping a prior RELEASED down, as `createBomRevision` does), stamps `released_at`/`materialized_at` from the DB clock (invariant 1), writes one `bom.release` audit row with counts (components, operations, steps by scope, unmapped lines, warnings) and the rule ledger rows.
- Same revision again → no-op returning the counts, audit `bom.release.noop`. Another revision when one is already materialised → refuse `BOM_RELEASE_DIFF_NOT_BUILT` (J5c builds it). A line that already has components or assembly steps from the legacy createJob path (DESPL-320, DE0467, 12548, and any job created before J5a) → refuse `BOM_ALREADY_MATERIALIZED`; existing jobs are never touched.
- Refuse (never acknowledgeable): a line mapped to a type whose route is not approved (`ROUTE_NOT_APPROVED`), a variant with no published version. Acknowledgeable warnings (`BOM_RELEASE_WARNINGS_UNACKNOWLEDGED` with the list): lines with no part family; equipment-type kit components (`EquipmentTypeComponent`) with no mapped line (kit is a check only, it creates nothing: a component without a BOM line could never satisfy H2); no QCP attached; weld map unconfirmed; PER_JOINT steps whose joint type has no joints; pressure parts with no governing drawing (H3 data gaps).
- Suggestion for unmapped lines (preview only, user confirms via `mapBomLines`): keyword match of `partName` against part family code/name and `seed/standard-parts-aliases.json`; never auto-applied.
- An empty revision is releasable (PER_UNIT steps only), so a job without a BOM still gets its assembly steps.

**Invariants at risk.** 3/D3: `requiresQc` derivation must equal the pre-J5 materialisation (regression test compares rows). 9: released revisions and routes are versions, never edited; `mapBomLines` refuses a materialised revision. 2/D2: H1–H6 read the new rows the same way (`loadFloorFacts`). 5: audit in the same tx. Tenant: every child-table read filters by `jobId`.

**Tests.** `bom-release.test.ts` (DB, table-driven refusals first: role, client, other tenant, other job's revision, unapproved route, unacknowledged warnings, legacy-materialised line, second revision; then: release twice idempotent; PER_COMPONENT uses released components; PER_JOINT NOZZLE from J4b joints; route-step `includeWhen` dropped + ledger rows; QCP binding; `requiresQc` parity with the old createJob path on the same fixture; concurrent releases, one wins); `bom-release.rules.test.ts` (pure: suggestions, warning list). Update J1/J2/J4a DB tests that asserted `assemblyStepCount`/`componentCount` from `createJob`: they now call `releaseBomRevision` (assert the same numbers after release).

**Acceptance.** Service only; demo in J5b. **Production:** migration rehearsal on a dump; no backfill (existing jobs are refused by design). Size 10 h. If the session runs long, split: PR 1 service + migration, PR 2 the createJob change and test updates (stacked branch).

### B.J5b — BOM release screen (frames 14A–14B)

**Goal.** Engineering releases a line's BOM from the UI. **Gate path.**

**Files.** New `src/app/(app)/jobs/[id]/release/page.tsx` (+ client): line picker; revision picker with "Start revision N" (calls `createBomRevision` as DRAFT and moves that line's revision-less BOM items into it, audited); mapping table (BOM line · suggested part family · route variant · approved? · operations after rules); warnings with one "I have checked these" acknowledgement; Release button (shown only to roles that can release: no dead controls); result counts. Links: Materials tab ("Release BOM"), the wizard's result step in `src/app/(app)/jobs/new/_client.tsx` ("Next: release the BOM").

**Tests.** Component tests for the warning/acknowledge state (jsdom, like `useFloorWrites`); one Playwright spec `e2e/bom-release.spec.ts` through the real login (Engineering or SJ seeded user) on a fresh job: map → acknowledge → release → floor shows steps. Size 6 h. No migration.

**Acceptance (3108).** As SJ: create a PV job with DESPL-320's BOM copied, open Release, map the shell to SHL-01 (approved on your DB), release, open the Floor screen of unit 1: steps per seam and component operations present; release again → "already released".

### B.Gate — DE0423 created, configured and BOM-released from master data (staging)

**Who.** Swayam drives, SJ approves; one agent session prepares files and records evidence. Staging only (`main` deployed to `staging` by Swayam). **Steps:** (1) M2 import of the 11 Oct workbook on staging (`allowDraft`); (2) SJ approves DE0423's part families in `/admin/master-data` (approver ≠ preparer); (3) J4c import of the "HP Air Receiver Blow Down Vessel" sequence onto "vertical on skirt", a second user publishes; (4) `/jobs/new`: vertical on skirt, 3 units DE0423-01..03, answers (shell courses from the GA, 44 bar(g), PWHT yes), delivery date, QCP (or JG2 later); (5) weld map: `N1-N6, M1` from tags, `SK-1`, `GW-1…32`; (6) BOM: the agent converts the workbook's "PV Drawing Basis" 48 lines into the BOM import format (scratch file, never committed as seed), import into revision 1; (7) release with acknowledgement; (8) evidence: 12 office plans (L1.3), nozzle and gusset steps per joint per unit, operations only from approved routes, H3 gaps listed (JG1 to clear). **Pass** = no code change between merge and step 8. Record in `progress.md`.

### B.J5c — Re-release: revision diff (after the gate)

**Goal.** A later BOM revision or weld-map change updates not-started rows and flags started ones; nothing is deleted. **Opus plans this session (30 min), Sonnet builds.**

**Data model (`20261027100000_j5c_release_diff`).** `components.retired_at`, `component_operations.retired_at`, `assembly_steps.retired_at` (TIMESTAMPTZ NULL) + `retired_reason TEXT`; `component_operations.needs_review`, `assembly_steps.needs_review` (BOOLEAN default false). No deletes (invariant 6, Q8).

**Behaviour.** Diff by `(unit, itemNo)` for components, `(component, route seq)` for operations, `(unit, template step, joint/component)` for steps. NOT_STARTED and gone → retired (reason "removed in BOM rev N"); NOT_STARTED and changed → updated in place (audited before/after); new → added; started/submitted/complete and gone or changed → `needs_review`, kept. Planner resolution (ENGINEERING/PRODUCTION_HEAD, reason required, audited): Keep (clear flag) · Replace (retire old, add new) · Cancel (retire). One helper `activeRow()` (`{ retiredAt: null }`) used by every reader: `work.facts.ts` `loadFloorFacts`, `_shared.ts` `loadMappedOps`/`rollupProcessPlan`, `today.read.ts`, `team.read.ts`, `board.cell.read.ts`, `qc-queue.read.ts`, `floor.read.ts`, `traveller.read.ts`, `bom.read.ts`, dispatch checks; grep for every `componentOperation.`/`assemblyStep.` read and list them in the PR. Rollup ignores retired rows; a plan whose mapped rows are all retired falls back to direct update like an office process (table-test it).

**Tests.** `bom-release-diff.test.ts` (DB): each diff class, started row never retired by release, Keep/Replace/Cancel with roles and reasons, rollup over retired rows, floor never lists retired rows, H1 on a retired weld step. Size 8 h.

### B.J6 — Lots and quantity-aware steps (after the gate; D21 default Serial)

**Goal.** A multi-quantity line can be tracked as one lot with quantities. Not needed for DE0423 (3 serial units).

**Data model (`20261028100000_j6_lots`).** Enum `TrackingMode` (SERIAL, LOT, LOT_THEN_SERIAL); `equipments.tracking_mode` default SERIAL; `units.qty_planned INT NOT NULL DEFAULT 1` (CHECK ≥ 1); `process_plans.qty_planned INT NULL`, `qty_done INT NOT NULL DEFAULT 0`; `assembly_steps.qty_planned INT NULL`, `qty_done INT NOT NULL DEFAULT 0` (`component_operations` already has `qtyPlanned/qtyGood/qtyRejected`); `template_processes.qty_bands JSONB NULL` copied to `job_processes.qty_bands` (CHECK array).

**Behaviour and defaults.** LOT line: `createJob` makes one unit per line (serial `<jobNumber>-LOT<n>`, `qty_planned` = line quantity) and every row carries `qtyPlanned`; this keeps the unit-centric spine, view, floor and dispatch working (a lot is a unit with a quantity). `recordWork` DONE takes `detail.qty` (schemas.ts `recordWorkSchema` item `detail`): `qtyDone += qty`; IN_PROGRESS until `qtyDone = qtyPlanned`, then COMPLETE or SUBMITTED per `requiresQc`; over-completion refused `QTY_EXCEEDS_PLANNED` (new code); `qty` on a row without `qtyPlanned` refused. QC inspects the lot once at full quantity (ratify QC head). Rollup: plan `qtyDone` = min over mapped items. LOT_THEN_SERIAL refused at create ("not available yet") until D21 picks it. `qtyBands` stored and shown as a schedule-preview warning only, **not applied to dates** (D17 default; invariant 10: the envelope stays authoritative; applying bands needs an Opus spec).

**Tests.** `j6-lots.test.ts` (DB): violation table (over-qty, qty on serial, negative, LOT_THEN_SERIAL), partial DONE audit per write with server `recordedAt`, maker-checker at full qty, rollup, SERIAL jobs unchanged (DESPL-320 rows `qty_planned` NULL). **Production:** rehearsal; no backfill (defaults preserve behaviour). Size 8 h.

### B.J7a — Job drafts, copy a previous job, live preview (service)

**Goal.** Planners can save a half-made job, copy a previous one as a draft, and see exactly what `createJob` would make before making it.

**Data model (`20261029100000_j7a_job_drafts`, default Q1).** Drafts are **not** Job rows (a `DRAFT` value in `JobStatus` would leak into every reader that filters `status not in (COMPLETE, CANCELLED)`): new tenant-root table `job_drafts` (id, tenant_id, created_by, created_at, updated_at, source_job_id NULL, payload JSONB = the `createJobSchema` input plus per-line weld-map and BOM source, status DRAFT | RELEASED | DISCARDED, released_job_id NULL), tenant RLS like `jobs`, no DELETE grant (discard = status).

**Files.** `job-intake.service.ts`: split `createJob` into `createJobTx(tx, actor, input)` + the existing wrapper; new `previewJob(actor, input)` = `createJobTx` inside a transaction that is rolled back with a sentinel error, returning `CreateJobResult` plus included/excluded processes with `inclusionReason`, rule decisions, expected steps by scope and a feasibility check from the template envelope (`checkFeasibility`, `src/lib/schedule/feasibility.ts`). `ponytail:` comment: rollback preview consumes sequence ids, harmless. New `job-draft.service.ts`: `saveDraft`, `copyJobToDraft(actor, { jobId })` (lines with type, name, answers, route version; serials blank; QCP source = the job's QcpTemplate; per-line BOM and weld-map source = the old line), `releaseDraft` (calls `createJobTx`, marks RELEASED, same tx; second call refused `DRAFT_ALREADY_RELEASED`), `discardDraft`. `createJobSchema` (`src/lib/shared/schemas.ts`): per-line `copyBomFromEquipmentId` and `copyWeldMapFromEquipmentId` (copies IMPORTED joints, `confirmed` reset to false).

**Tests.** `job-draft.test.ts` (DB): preview writes nothing (row counts of jobs, units, job_processes, audit_log, config_rule_decisions equal before/after), preview counts = create counts, copy carries answers/QCP/BOM/weld map, release once, tenant isolation, roles (ADMIN, PRODUCTION_HEAD create as today; PLANNER may save drafts, ratify SJ). Size 8 h.

### B.J7b — New-job flow screens and "Build from master" (frames 13A–13G)

**Goal.** The wizard becomes: start route (Copy a previous job · Standard template · Build from master) → Order → Equipment lines → Configure (live preview panel from `previewJob`) → QC plan → Schedule preview → Create, autosaving a draft. **Build from master (lazy version):** pick an equipment type from the catalogue → BOM lines pre-filled from its kit (`EquipmentTypeComponent`: component type × `defaultQty`) into the draft → created as DRAFT revision 1 → released in J5b. Not built: processes proposed from component routes, "Save as standard design" (PHASE-PLAN §9.4; later).

**Files.** `src/app/(app)/jobs/new/_client.tsx` (1,176 lines: split per step into files under `jobs/new/`), `page.tsx`, `src/app/actions/job-intake.ts`. **PV-only stays:** `FEATURES.multiFamilyIntake` remains false (`jobs/new/page.tsx` filter and `createJobAction` refusal); J8-content lifts it with a recorded decision. **Tests:** keep `step1.test.ts`; add per-step validation tests; e2e `e2e/new-job-flow.spec.ts` (copy DESPL-320 → change serials → preview → create). **Acceptance (3112):** copy DESPL-320 as SJ, preview shows 12 office processes (after L1.3) and the excluded ones with reasons, create, release. Size 8 h.

### B.J8 — Heat exchanger and milestones: code now, content later

**Code now (J8-code, migration `20261025100000_j8_milestones`).** `milestones` (tenant_id, code, name, sort_order; unique per tenant) and `milestone_process_maps` (tenant_id, family_id, process_code, milestone_id, weight NUMERIC NULL; unique (family_id, process_code)); tenant RLS, RLS coverage test extended. Map by process **code** so it survives template versions (as QCP matching does). `scripts/lean-seed-milestones.ts` (dry run default): D9's ten names; a PV mapping proposed by the session from `seed/lead-time-model.json` process names, marked provisional in the audit rows (ratify SJ + MD, D9). Read `loadJobMilestones(actor, jobId)` in a new `milestone.read.ts`: per milestone, % complete weighted by planned effort (weight default = process `durationMaxDays` × units; a weighting, not a schedule, so invariant 10 holds), planned finish = latest mapped `plannedFinish`; explicit job filter on `process_plans`. Show it in `portfolio.read.ts` (current milestone column) and `digest-email.read.ts` (one line per at-risk job). Families with no `WorkOrderStage` rows (HE today) get an empty state on board/spine ("No stage list for this type of equipment yet; milestones shown instead"), not a crash. HE wiring proved by a **synthetic fixture** `j8-he-fixture.test.ts` (test-only family with shell-side and tube-side hydro, two equipment types, a tube route with variant A "expansion" and variant B "grommet", milestone map; `createJob` with `multiFamilyIntake` on in the test; milestones roll up). If J5a has merged, the fixture also releases a BOM. Size 6 h.

**Content later (J8-content, blocked).** Publish the HEAT_EXCHANGER process template the M2 importer already loads as DRAFT (`master-import.he.ts`, 42 stages), HE equipment types per HE type, part families and routes (tubesheet, tube, baffle, tie rod, channel, bonnet, floating head, expansion joint), grommet joint as route variant, the HE stage list/crosswalk, standard HE QCP, HE milestone map, then flip `multiFamilyIntake`. **Inputs needed:** I10 (HE types and frequency, approved 42-stage plan, past HE BOM + GA, grommet details) · I11 (Master BOM `_PV_HE.xlsx`, HE 803-E-5, OC-48-0223) · I5 (full HE parts list) · I9 (QAP/ITP of one HE job) · I13 (hydro both sides, PFHT/PWHT, bolting) · I20 (SP40 Rev.0 released?) · decisions D19 (HE types, grommet as standard variant), D16 (which new operations: tube insertion, grommet, expansion, tube leak test, shell/tube hydro), D9, D13 (stage list), D20.

---

## §C Paste-ready prompts

Each prompt is complete for a fresh session; §0 holds the shared steps.

**L1.3-ship**
```text
Lean Core session L1.3-ship. You are a Sonnet build session on the DESPL Production Tracker. Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md first (read list, worktree, Node 20, own test DB, gates, PR rules, credential rule), slug l13ship, branch lean/L1.3-job-grain-ship, port 3101. Then read §B.L1.3 of that file, docs/lean-core/BUILD-PROMPT-lean-core-v1.md §5 L1.3, and `git show lean/L1.3-job-grain:docs/lean-core/L1.3-JOB-GRAIN-RUNBOOK.md`.
Task: cherry-pick 8671c68 and a970e1e onto your branch off origin/main, resolve conflicts against J3a (one unit-less plan per JOB-grain process per job, whatever the number of routes), rename the migration to 20261023100000_l13_job_grain_stage_view, add the two-route JOB-grain case to j3a-line-routes.test.ts, add scripts/lean-publish-job-grain-template.ts (dry run default) per §B.L1.3, update the runbook counts.
Post a plan of at most 15 lines, then build without waiting. Blocking: none. Run the gates, open the PR (label migration) with the rehearsal and production commands from the runbook in the body, never merge, at most 15 lines in progress.md. Never read AUTH_SECRET or mint a session; verify through the real /login.
```

**JG1 drawings**
```text
Lean Core session JG1 (drawing release for H3). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md first, slug jg1-drawings, branch lean/JG1-drawing-release, port 3102. Read §B.JG1 and CLAUDE.md's D2 section (H3).
Task: createAssemblyDrawing and bulk linkDrawingToComponents services, actions, the page /jobs/[id]/drawings (drawings, revision state, issue revision, release at risk for the Production Head with a reason, link pressure parts that have no drawing), a link from the Materials tab. No migration expected (spare slot 20261025700000 in §A.3).
Plan of at most 15 lines, then build without waiting. Blocking: none (ENGINEERING may create/link by default; say so in the PR). Tests per §B.JG1, Chrome check through the real /login, PR, never merge, at most 15 lines in progress.md, never mint a session.
```

**JG2 QCP attach**
```text
Lean Core session JG2 (attach a QC plan after job creation). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md first, slug jg2-qcp, branch lean/JG2-qcp-attach, port 3103. Read §B.JG2, the J2 and J4a progress entries (QCP binding by srNo occurrence, shared checkpoints).
Task: extract cloneQcpTemplate in job-intake.service.ts into a tx helper, add attachQcpTemplate (refuse QCP_ALREADY_ATTACHED; bind only NOT_STARTED unbound inspection steps with the existing matcher), the action, and the QC tab empty state with the picker and the PR #130 warning. No migration.
Plan of at most 15 lines, then build without waiting. Blocking: none. Tests per §B.JG2 (qcp-attach.test.ts), Chrome check via the real /login, PR, never merge, at most 15 lines in progress.md, never mint a session.
```

**J3b**
```text
Lean Core session J3b (line-aware reads). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Start only if L1.3-ship is merged on origin/main (check `git ls-tree origin/main prisma/migrations | grep l13`); if not, stop and say so. Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j3b, branch lean/J3b-line-reads, port 3104. Read §B.J3b, the J3a progress entry and src/lib/services/line-route.ts.
Task: migration 20261024100000_j3b_line_stage_view (L1.3's view body plus the route filter on jp), fix _shared.ts rollupForSeq to resolve the unit's route, and route-scope board.read, board.cell.read, board.export.read, stage-detail.read, gantt.read, workspace.read loadPrioritizedJob and job-materials.read. Single-route jobs must render exactly as today.
Plan of at most 15 lines, then build without waiting. Blocking: none. Tests per §B.J3b (j3b-line-reads.test.ts, DESPL-320 view snapshot, tenant-scoped-views), migrate diff clean, PR (label migration) with the before/after view-count rehearsal in the body, never merge, at most 15 lines in progress.md, never mint a session.
```

**J4b**
```text
Lean Core session J4b (weld-map importer and joint register). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j4b, branch lean/J4b-weld-map, port 3105. Read §B.J4b, the J4a progress entry, src/lib/services/planned-joint.setup.ts, src/lib/shared/upload.ts, design/lean-core/"DESPL Job Setup.dc.html" frame 14C and build prompt §8.2 erratum 20.
Task: pure parser src/lib/shared/weld-map.ts, weld-map.service.ts (dry run, apply idempotent on equipment+joint no, never delete, add joints from tags, confirm), actions, page /jobs/[id]/weld-map, link from the Materials tab. Use the default joint numbering convention in §B.J4b (I7 is not supplied); unconfirmed joints are flagged, not blocked. No migration expected (spare slot 20261025500000).
Plan of at most 15 lines, then build without waiting. Blocking: none. Tests per §B.J4b, Chrome check via the real /login, PR, never merge, at most 15 lines in progress.md, never mint a session.
```

**J4c**
```text
Lean Core session J4c (assembly sequence as master data). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j4c, branch lean/J4c-assembly-sequence, port 3106. Read §B.J4c (its mapping rules are the spec), the J1 and J4a progress entries, master-import.parse.ts (ASSEMBLY sheet), assembly-template.resolve.ts, assembly.service.ts materializeAssemblyStepsFromTemplate, and the M3 approve flow in master-data.service.ts (approver ≠ preparer).
Task: extend the ASSEMBLY sheet columns, pure src/lib/shared/assembly-sequence.ts, assembly-template.service.ts (dry run, import as DRAFT version, publish by the Production Head with maker-checker), migration 20261025600000_j4c_assembly_version_approval (prepared_by_id, approved_by_id), an Assembly sequence section on /admin/equipment-types. Fixture: the workbook's "HP Air Receiver Blow Down Vessel" rows (test fixture only, never seed).
Plan of at most 15 lines, then build without waiting. Blocking: none (role and pressure inference are provisional; say so). Tests per §B.J4c, migrate diff clean, PR (label migration), never merge, at most 15 lines in progress.md, never mint a session.
```

**J5a**
```text
Lean Core session J5a (floor steps generated at BOM release: service). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Start only if JG2, J4b and J4c are merged on origin/main; if not, stop and say which is missing. Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j5a, branch lean/J5a-bom-release, port 3107. Read §B.J5a in full (rules, refusal codes, defaults), build prompt §5 J5, PHASE-PLAN §3 P3 J5 bullet, the J1–J4a progress entries, and job-intake.service.ts createJob/copyBom, component.service.ts materializeComponentsFromBomItems, assembly.service.ts materializeAssemblyStepsFromTemplate, bom.service.ts importBomItems/createBomRevision, shared/stage-mapping.ts pickRouteTemplate.
Task: migration 20261026100000_j5a_bom_release (bom_items.route_variant, bom_revisions.materialized_at), bom-release.service.ts (previewBomRelease, mapBomLines, releaseBomRevision), createJob stops materialising components and assembly steps (copyBom writes DRAFT revision 1 per line), approved-routes-only and variant pick in the materialiser, update the J1/J2/J4a tests that counted steps at create. Existing jobs are refused (BOM_ALREADY_MATERIALIZED), never touched.
Plan of at most 15 lines, then build without waiting. Blocking: only if requiresQc parity with the old createJob path cannot be kept; stop and report the diff. Tests per §B.J5a, migrate diff clean, PR (label migration) with the rehearsal commands, never merge, at most 15 lines in progress.md, never mint a session. If it runs long, split into two stacked PRs as §B.J5a says.
```

**J5b**
```text
Lean Core session J5b (BOM release screen). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Start only if J5a is merged. Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j5b, branch lean/J5b-release-screen, port 3108. Read §B.J5b, §B.J5a, frames 14A–14B in design/lean-core/"DESPL Job Setup.dc.html" with build prompt §8.2 errata, and src/lib/services/bom-release.service.ts.
Task: page /jobs/[id]/release (line and revision pickers, Start revision N, mapping table with suggestion and variant, warnings with one acknowledgement, Release shown only to roles that can release, result counts), links from the Materials tab and the wizard result step, e2e/bom-release.spec.ts through the real login. No migration.
Plan of at most 15 lines, then build without waiting. Blocking: none. Every page ships loading, empty, error and refusal states (CLAUDE.md functional-first rules). Chrome demo per §B.J5b, PR, never merge, at most 15 lines in progress.md, never mint a session.
```

**Gate run**
```text
Lean Core P3 gate run: DE0423 from master data on staging. Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Follow §0 steps 1–2 of docs/lean-core/J-PHASE-PLAN-v1.md (slug gate, branch docs/j-gate-de0423), read §B.Gate and PHASE-PLAN §7 (what to trust in the 11 Oct workbook). You do not touch production and do not push to staging; Swayam deploys main to staging and signs in as the people who approve.
Task: (1) convert the workbook's "PV Drawing Basis" 48 BOM lines into the BOM import format as a scratch file (not committed); (2) give Swayam the step list of §B.Gate as a checklist; (3) when he says each step is done, verify it in Chrome on the staging URL through the real /login with the account he gives you, and record the evidence (counts, screenshots described in words). Pass = no code change between the merge and step 8. Write at most 15 lines in progress.md and open a docs-only PR. Never mint a session; if a step needs code, stop and report it as a gate failure.
```

**J5c**
```text
Lean Core session J5c (BOM re-release diff). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Start after the DE0423 gate (or on Swayam's go). Use Opus for the plan step, Sonnet to build. Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j5c, branch lean/J5c-release-diff, port 3109. Read §B.J5c and §B.J5a, CLAUDE.md invariants 6 and 11.
Task: migration 20261027100000_j5c_release_diff (retired_at, retired_reason, needs_review), the diff in releaseBomRevision, Keep/Replace/Cancel actions with reasons, one activeRow() helper applied to every reader of components, component operations and assembly steps (list each in the PR), rollup over retired rows.
Plan of at most 15 lines (include the reader list), then build without waiting. Blocking: none; rows are never deleted. Tests per §B.J5c, PR (label migration), never merge, at most 15 lines in progress.md, never mint a session.
```

**J6**
```text
Lean Core session J6 (lots and quantity-aware steps). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Start only if J5a is merged. Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j6, branch lean/J6-lots, port 3110. Read §B.J6, build prompt §5 J6, frames 16A–16B and 03E with §8.2 erratum 20, CLAUDE.md invariant 10, work.service.ts recordWork and _shared.ts rollupProcessPlan.
Task: migration 20261028100000_j6_lots, LOT lines as one unit with a quantity, recordWork detail.qty with QTY_EXCEEDS_PLANNED, quantity rollup, qtyBands stored and shown as a warning only (not applied to dates), LOT_THEN_SERIAL refused at create.
Plan of at most 15 lines, then build without waiting. Blocking: none (D21 default stays Serial; nothing changes for SERIAL lines). Tests per §B.J6, PR (label migration), never merge, at most 15 lines in progress.md, never mint a session.
```

**J7a**
```text
Lean Core session J7a (job drafts, copy a previous job, live preview). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Start only if J5a is merged; if J6 is open, coordinate on createJobSchema by rebasing after it merges. Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j7a, branch lean/J7a-job-drafts, port 3111. Read §B.J7a, build prompt §5 J7 and §8.3 "Master data for J7".
Task: migration 20261029100000_j7a_job_drafts (tenant-root job_drafts, RLS like jobs, no DELETE grant), createJobTx split, previewJob by rolled-back transaction, job-draft.service.ts (save, copy, release once, discard), per-line BOM and weld-map copy in createJobSchema.
Plan of at most 15 lines, then build without waiting. Blocking: none (drafts are a table, not a JobStatus value, per Q1 default). Tests per §B.J7a, PR (label migration), never merge, at most 15 lines in progress.md, never mint a session.
```

**J7b**
```text
Lean Core session J7b (new-job flow screens and Build from master). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Start only if J7a is merged. Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j7b, branch lean/J7b-new-job-flow, port 3112. Read §B.J7b, frames 13A–13G in design/lean-core/"DESPL Job Setup.dc.html" with build prompt §8.2 errata, src/app/(app)/jobs/new/_client.tsx and job-draft.service.ts.
Task: the three start routes, step files under jobs/new/, the Configure live preview from previewJob, schedule preview, autosaved drafts, Build from master (equipment type kit to draft BOM lines). FEATURES.multiFamilyIntake stays false. e2e/new-job-flow.spec.ts through the real login.
Plan of at most 15 lines, then build without waiting. Blocking: none. Loading, empty, error and refusal states on every step. Chrome demo per §B.J7b, PR, never merge, at most 15 lines in progress.md, never mint a session.
```

**J8-code**
```text
Lean Core session J8-code (milestones, heat-exchanger wiring with a synthetic fixture). Repo: "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER". Follow §0 of docs/lean-core/J-PHASE-PLAN-v1.md, slug j8, branch lean/J8-milestones-he, port 3113. Read §B.J8, build prompt §5 J8 and §8.4 D9, master-import.he.ts, portfolio.read.ts, digest-email.read.ts, seed/lead-time-model.json.
Task: migration 20261025100000_j8_milestones (milestones, milestone_process_maps by process code, tenant RLS), scripts/lean-seed-milestones.ts (dry run default, D9 names, provisional PV mapping you derive and list in the PR), milestone.read.ts with effort-weighted progress and an explicit job filter on process_plans, one Portfolio column and one digest line, the empty state for families with no stage list, j8-he-fixture.test.ts with a synthetic HE family (never real HE data; that waits for I10/I11/D19).
Plan of at most 15 lines, then build without waiting. Blocking: none. Tests per §B.J8, PR (label migration), never merge, at most 15 lines in progress.md, never mint a session.
```

---

## §D Open questions for Swayam (answer in one line each; the default applies if you don't)

1. **Drafts (J7a):** a separate `job_drafts` table, not a `DRAFT` job status? **Default: table** (no reader changes).
2. **J5a:** new jobs get components and assembly steps only at BOM release (existing jobs untouched)? **Default: yes**, as the build prompt says.
3. **Who releases a BOM:** **Default: Engineering, Production Head, Admin**; Planner no.
4. **Weld map before I7:** joint numbering per §B.J4b; unconfirmed joints feed release with a warning rather than blocking it? **Default: yes, warn.**
5. **L1.3-ship:** also publish a PV process template version with JOB grain so new jobs (DE0423) get 12 office plans? **Default: yes** (script, dry run first, you run `--apply`).
6. **J6:** quantity bands stored and shown, not applied to dates; LOT_THEN_SERIAL deferred? **Default: yes** (D17, D21).
7. **Priority:** gate path first (JG2, J4b, J4c → J5a → J5b → gate), J3b/J6/J7/J8 after? **Default: yes**; it keeps the DE0423 pilot path (D5 check 16 Nov) open.
8. **J5c:** removed-but-not-started rows are retired (`retired_at`), never deleted? **Default: yes.**

---

## §E Risks and scope cuts

| # | Risk | Mitigation |
|---|---|---|
| 1 | Two parallel migrations merge out of name order | §A.3 slots + rename-before-merge rule; one migration per PR; rehearsal on a fresh dump each time |
| 2 | L1.3 cherry-pick over J3a's per-route scheduler makes two unit-less plans for one JOB process | the added two-route case in `j3a-line-routes.test.ts`; rehearsal counts (228 plans on DESPL-320) |
| 3 | `v_unit_stage_status` replaced twice (L1.3, J3b): wrong fill or slower spine (AUD-021) | J3b runs only after L1.3; DESPL-320 view snapshot test; compare `EXPLAIN ANALYZE` on the dump before/after |
| 4 | J5a moves materialisation out of `createJob`: many DB tests and the wizard flow change at once | parity test on `requiresQc`; tests updated in the same PR; release link on the wizard result; existing jobs refused, not migrated |
| 5 | Master data stays Draft, so "approved routes only" yields no operations for DE0423 | the gate is data-bound: SJ approves DE0423's families in M3 on staging (I2); release preview lists every unapproved line |
| 6 | Weld-map convention (I7) arrives different | `confirmed` flag; re-import updates details; joints are renumbered only before any weld record (refusal otherwise) |
| 7 | Railway workspace hard limit or a failed pre-deploy on a migration merge | check usage before rehearsals; read the deploy log after each migration merge (`/api/health` alone is not proof) |
| 8 | Parallel sessions collide (shared `despl_test`, the main checkout's branch, `progress.md` tail) | §0 worktree + own DB + own port; keep both progress entries on conflict; flaky `job-overview` e2e named, not ignored |

**Cut order if time is short** (first to go first): J7b → J6 → J7a → J5c → J3b → J8-code → JG1. **Minimum that satisfies the DE0423 gate:** JG2 + J4b + J4c + J5a + J5b, plus the data steps of §B.Gate (L1.3-ship strongly advised so DE0423 gets 12 office plans; JG1 is then the first thing to add for a DE0423 pilot, because H3 does nothing for its parts without it).
