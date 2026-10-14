# Loop queue — ordered work for `docs/lean-core/LOOP.md`

**Written 14 Oct 2026** from `PHASE-PLAN-v1.md` §2–§4 and §9, the build prompt §5 and §8, and the 14 Oct hand-off in `progress.md`. Top to bottom = priority. Status is **not** kept here: an iteration derives it (a branch `lean/<ID>-*` exists → built or in progress; its PR merged → done). Swayam reorders this file to steer; the agent edits it only to add an item it found necessary (with a one-line reason) or to split one.

Columns: **after** = items that must be merged or open in the train first · **blocked by** = inputs or human-only steps that stop the item (a decision with a default does not block — build the switch, say so in the PR) · **spec** = where the session is specified.

State at writing: production 74/74; L1.2 built as the open stack #82 → #88 (not merged); CI red on `main` (jsdom 30 on Node 20, fix in open PR #89); `LEAN_FLOOR` off.

## A. Repair and enablers (do these before new features)

| ID | Item | after | blocked by | spec |
|---|---|---|---|---|
| R1 | CI runs on stacked PRs: `ci.yml` `pull_request` without the `branches: [main]` filter, so every train PR gets lint/typecheck/test/test:db/build/e2e. Branch from `main`. | #89 | — | hand-off 14 Oct (#79/#80 merged with no CI) |
| R2 | Rule-NCR follow-ups from the L1.2f review: rule NCRs in `workspace.read` and `departments.read` counts; REPAIR closes only when the target weld is redone; concession stops exempting after a later reject. | — | — | progress.md "L1.2f adversarial review" |
| R3 | `docs/USER-GUIDE-WHY-WAS-I-REFUSED.md` covers every code in `errors.ts` (L1.2 added 13+). Test that fails when a code has no entry. | — | — | progress.md L0.4 "Not done" |

## B. Phase 1 rules (P2)

| ID | Item | after | blocked by | spec |
|---|---|---|---|---|
| L1.3 | JOB-grain scheduling (one plan, `unitId = NULL`, for processes 1–11 and 33 per D5 default) + projection in spine/stage reads and `v_unit_stage_status` + `scripts/lean-backfill-job-grain.ts` (dry run default, idempotent, audited). Does **not** run the backfill anywhere shared. | — | — | build prompt §5 L1.3 |
| L1.4 | Delay reasons never block: `assertNoUnfiledDelayBlock` off the write paths; 10:00 IST reminder and 24 h escalation in the alerts cron; D10's 8 categories as default seed. | L1.3 | — | §5 L1.4, D10 |

## C. Screens (P4) — build to `design/lean-core/` with the §8.2 errata

| ID | Item | after | blocked by | spec |
|---|---|---|---|---|
| L2.0 | Tokens and type floor; light "Floor" theme on coarse pointers, dark on desktop, user preference wins. | — | — | §5 L2.0, frame 00, 11 |
| L2.1 | One `NAV_ITEMS` registry by role (errata 21 incl. STORES, ENGINEERING, PLANNER menus §9.4), landing per role, person-block menu, sidebar job list capped. Redirects `/workspace`→`/team`, `/my-day`→`/today`. | L2.0 | — | §5 L2.1, frames 12A–12D, errata 21 |
| L2.2 | Floor screen `/u/[publicId]` on `recordWork` (batch across units, inline late-reason chips ≤ 3 taps, undo 10 s, refusal with plain reason, welder capture on weld steps, heat-number pick at cutting). Behind `leanFloor`. | L2.1, L1.4 | — | §5 L2.2, frames 01A–01F, errata 4, 11, 12, 14; §8.3 |
| L2.3 | Today + end-of-shift batch (`requestId` idempotent, only changed rows); "Claim next" OPERATOR only; no supervisor Acknowledge. | L2.2 | — | §5 L2.3, frames 02A–02C, errata 9, 10, 13, 15 |
| L2.6 | QC queue `/qc` on `inspect`: Ready · Holds · NCRs; one column per inspection party; TPI acceptance needs inspector name + report/IRN; hydro record (pressure, hold time, gauge IDs + calibration due); reject categories (§9.3 D6q). | L2.2 | — | §5 L2.6, frames 05A–05B, errata 2, 3, 17, 18 |
| L2.4 | Job board (units × stages via the process→stage crosswalk), `StageSheet`, filter chips, Excel export in the DESPL-320 tracker layout. | L2.1 | — | §5 L2.4, frames 03A–03C, errata 5, 7, 19 |
| L2.5 | Team `/team/[dept]` with Production Head department switcher, workload by person, assign, Flags (out-of-sequence acknowledge = Production Head only), same-day rate. | L2.3 | — | §5 L2.5, frames 04A–04B, errata 10 |
| L2.9 | QR travellers print view, `/u/[publicId]` on the deployment host. | L2.2 | — | §5 L2.9, frames 08A–08B, errata 16 |
| L2.8 | Job tabs Overview · Board · Schedule · Materials · QC · Dispatch · History; Stores actions received / identified / issued (H2 needs ISSUE to exist); client filter. | L2.4 | — | §5 L2.8, frames 07A–07B, §8.3, §9.4 |
| L2.7 | Portfolio `/dashboard`, client filter, "N of M jobs forecast past committed date". | L2.4 | — | §5 L2.7, frames 06A–06B |
| L2.10 | Excel import of in-flight jobs and BOMs (upload → dry run → issues → confirm; reuse the M3-C import component); bulk "already done at switch-over" ticks. | L2.8 | I16 sheets beyond DE0463/DE0467 (build against the two in `seed/`) | §5 L2.10, §9.4 |
| L2.11 | Morning digest page + SMTP delivery at 08:30 IST behind env `SMTP_*` (off when unset). | L2.7 | — | §5 L2.11, frames 09A–09B, D23 default |
| L2.12 | Floor language dictionaries (en/hi/gu) for Floor and Today, drafts marked `// REVIEW: DESPL`. | L2.3 | — | §5 L2.12, frame 01G |
| L2.X | Admin: users, roles, departments + representatives, welder list, delay-reason list; alerts panel; jobs list. | L2.1 | — | §8.3 "needed but not drawn" |

## D. Any job, any equipment (P3)

| ID | Item | after | blocked by | spec |
|---|---|---|---|---|
| J1 | Equipment type as template anchor + `EquipmentTypeComponent`; standard designs table (§9.4); seed D18 default types; DESPL-320 regenerates identically on "vertical on skirt". | L1.3 | — | §5 J1, PHASE-PLAN P3 |
| J2 | `ConfigQuestion` + `includeWhen` evaluated once at configure time, inclusion reason stored. | J1 | — | §5 J2 |
| J3 | Route per equipment line (`equipmentId` on JobProcess / ProcessPlan / ScheduleRun). | J2 | — | §5 J3 |
| J4 | Assembly step scope + `PlannedJoint`, weld-map importer and generator; DE0423 as second fixture. | J3 | I7 joint numbering (use placeholders, flag) | §5 J4 |
| J5 | `releaseBomRevision`: BOM line → part family (approved routes only), variant pick, idempotent diff with `needsReview`. | J4 | — | §5 J5, PHASE-PLAN P3 J5 |
| J6 | Lots and quantity bands (D21 default serial). | J5 | — | §5 J6 |
| J7 | New-job flow incl. "Build from master" and "copy a previous job"; `DRAFT` jobs. | J6 | — | §5 J7, frames 13A–13G, 14A–14C |

## E. Production readiness (P7 prep, any time the train is at its cap or the above is blocked)

| ID | Item | after | blocked by | spec |
|---|---|---|---|---|
| P1 | Performance P0s AUD-020, 021, 022, 023 with before/after timings on the seeded DB. | — | — | PHASE-PLAN §9.5 |
| P2 | Security: AUD-037, 062, 107, 109, 095. | — | — | PHASE-PLAN §9.5 |
| P3 | AUD-079 approve-reset button in `/admin`. | — | — | PHASE-PLAN §9.5 |
| P4 | Load-test script (~50 users, 40-unit job), p95 report. | L2.4 | — | PHASE-PLAN §9.5 |
| L3.1 | Adoption metrics (same-day rate, taps per update) on Team, Portfolio, digest. | L2.5, L2.7 | — | §5 L3.1 |

## Human-only (the loop lists these under "Needs Swayam", never does them)

Merging the train in order and retargeting each next PR · production-dump rehearsals on the hotspot (`#84`, `#88` and every later migration PR) · Railway dashboard (healthcheck path, staging password and `SEED_PASSWORD` rotation, cron logs) · branch protection on `main` · decisions D1, D5, D13, D28 and the QC head's ratifications · sign-off of `seed/assembly-step-roles-pv-v1.json` and `seed/standard-parts-aliases.json` · component types for Bar / Rod and Pipe fitting · `xlsx` 0.20.x upgrade decision · S12 storage choice · WAL restore test · DESPL team inputs I1–I20.

Later, behind flags (do not queue): L4.x on-prem, photos, offline outbox, WhatsApp, J8 heat exchangers (needs I10), planner agent.
