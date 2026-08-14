# progress.md — DESPL Production Tracker

> Living build log. Update at the end of every working session (see CLAUDE.md → Session discipline).

**Status:** 🟢 **Scheduling engine + visual component set built and verified green (14 Aug 2026).** Foundation (tenancy/RLS/auth/RBAC), all seed data, 5 migrations, `lib/schedule/` (calendar, envelope, CPM, gating, feasibility, override), and a 5-component visual set (KPI tile, progress ring, matrix heatmap, S-curve, milestone timeline) previewable at `/component-gallery`. **Still nothing on screen beyond that preview** — no `lib/services/`, no UI beyond login + a read-only job list, no department workspaces. **Next: `lib/services/` (so schedules actually persist).**

**Merge note (14 Aug 2026):** two sessions independently built `lib/schedule/` the same day, on different branches, each unaware of the other — one (`demo`, code-based process identity, added `bypassExcluded()` for splicing skipped processes like PWHT out of the DAG) and one (`origin/demo` "Day 2", id-based identity, split into `gating.ts`/`feasibility.ts`/`override.ts` matching BUILD-SPEC-v2 §1's exact module list). Reconciled by taking the `origin/demo` version wholesale — it matches the spec's module list precisely — at the cost of dropping the exclusion-splicing logic for now (tracked below as a gap, not silently lost). Actually ran `pnpm typecheck`/`test`/`lint` against the merged result for the first time (neither session's sandbox had registry access to do this itself): typecheck caught one real bug in `cpm.test.ts` (a `string | number` process `code` passed where the `Map<number, CpmNode>` lookup needed a plain `id`), fixed; **114/114 tests pass, lint clean, typecheck clean.**

**Pilot target:** DESPL-320 (9 × HP air receiver, 320SR01–09) fully tracked by Week 8
**Near-term commitment:** working prototype tracking 3–5 equipments in 2–3 days; "full project" within a month. Solo developer.

**Git workflow, changed 13 Aug 2026:** new `demo` branch created from `main`. **Push to `demo` first; merge to `main` only after the user verifies and explicitly approves the promotion** — same discipline as the EJ Production Tracker sibling project. Do not push to or merge into `main` on your own initiative. (One session on 13 Aug ran on a harness-assigned branch, `claude/progress-status-check-8ttvkj`, and merged its PR straight to `main` on the user's direct in-conversation instruction, skipping `demo` — that history is now reconciled into `demo` by this merge.)

**Working on the `demo` branch. `lib/schedule/` is done and verified; `lib/services/` is the next slice.**

---

## ▶ Resume point (read this first in a new session)

**`lib/schedule/` (IMPLEMENTATION-GUIDE Step 7) is built and verified: calendar, envelope (layer 1), CPM (layer 2, forward+backward+float), gating, feasibility, override — all in `src/lib/schedule/`, all pure functions over plain data, no Prisma import.** The visual component set is also built (`src/components/viz/`) and previewable at `/component-gallery` against labeled sample data. Read "What's done" / "What's remaining" below before touching code. `lib/services/` is still the next real gap: nothing persists a `ScheduleRun`/`ProcessPlan` row yet, and no UI calls the engine or the components against real data.

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
2. **🟠 Add the two `envelopeStartBy*` columns to `JobProcess` (schema↔engine mismatch).** The engine's `ScheduleProcess` requires all four envelope offsets and `envelope.ts` refuses (`SCHEDULE_DATA_MISSING`) if `startBy*` is null — but `JobProcess` carries only the two `finishBy` columns. The instant anything computes a per-job Layer-1 envelope it throws for every non-provisional process. Latent only because no caller exists yet. Fix: `envelopeStartByMinDays/MaxDays Int?` + migration, copy them in `seed.ts`'s two `jobProcess.createMany` blocks (source JSON already has them). Do alongside #1.
3. **🟠 Add a boot-time DB-role guard (`db.ts`).** The whole security model (fail-closed RLS + append-only audit) silently collapses if `DATABASE_URL` connects as `postgres`/table-owner — RLS is `ENABLE` not `FORCE`, so the owner bypasses it, and the audit `REVOKE` is moot. `.env.example` ships `postgres` one copy-paste away, and `CREATE USER despl_web` lives only in a migration comment, never applied. Same regression class already hit once (the no-op REVOKE). Fix: assert `current_user` is non-superuser at startup + self-test that `UPDATE audit_log` is rejected; move role creation into a checked provisioning script.
4. **`lib/services/`** — still an empty README, and now the critical path. No business-rule functions exist (start process, submit, verify, file delay reason), and no caller turns a computed plan into `ScheduleRun`/`ProcessPlan` rows. Department workspaces and the process-update flow depend on this. **Build the medium/low review findings into this as it lands** (see Blockers → Code-review findings): duration-override must restamp Layer-1 envelope offsets; each mutation needs a same-transaction audit row + an existence test; per-mutation zod schemas that reject `actual_*`/`*_at`; row-level locking per ARCHITECTURE.md §6.
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

**🟠 High (fix before/with the service layer):**
- **`JobProcess` missing `envelopeStartBy*` columns** — see "What's remaining" #2.
- **No runtime DB-role guard** — see "What's remaining" #3.

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
