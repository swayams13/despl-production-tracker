# LEDGER

One line per item. **"Demonstrated on" is the point of this file** — not "tests passed", but the specific thing you watched happen. An item with a blank demonstration column is not done.

Update at the end of every session, before `/clear`.

---

## Day 1 — only you can do these

| # | Item | Status | Date | Notes |
|---|---|---|---|---|
| D1 | Railway production deploy branch identified | ☐ | | write the answer in this file |
| D2 | PITR / backups enabled — 4-week clock started | ☐ | | most time-sensitive item in the plan |
| D3 | Four shared department accounts rotated | ☐ | | `despl123@` removed from source |
| D4 | `SEED_PASSWORD` confirmed set in Railway env | ☐ | | default is `despl-dev-only` |
| D5 | D-B sent — TPI/ASME record-integrity question | ☐ | | blocks S12 |
| D6 | D-D sent — C1 working days vs calendar days | ☐ | | every date is provisional until answered |
| D7 | D-A decided — does the MDR come out of the system? | ☐ | | recommendation: no, not for this job |
| D8 | D-C decided — re-pin DESPL-320 to v2? | ☐ | | recommendation: no, ship on v1 |

---

## GATE 0 — Deployable & safe

*Exit: a production deploy has happened from a known branch, rehearsed first, and you can say when the last backup was taken.*

| # | Item | Branch | Status | Demonstrated on | Notes |
|---|---|---|---|---|---|
| S1 | Gating splice for excluded processes | `fix/W3-gating-splice-excluded-processes` | ☐ | | **start here** · test red → green |
| S2 | Security headers | `chore/S2-security-headers` | ☐ | | response headers from a prod build |
| S3 | Server Action logging + P2002 mapping | `fix/S3-action-boundary-logging` (planned: `feat/S3-action-observability`) | ☑ | 2 Sep: prod build on :3100 vs `despl_test`, real `/login` as SJ, stale-tab `Start` → `[action] refused {requestId, actionId, path:'/workspace', userId:4, tenantId:1, code:'INVALID_STATE_TRANSITION'}` on stdout. Also: 6 real P2002s from real duplicate inserts, each mapped correctly by the real `toActionError`. | Uncommitted. P2002 keyed on **`modelName` alone** — RLS makes Postgres withhold the constraint detail from `despl_web`, so `jobs`/`users`/`clients`/`welders` all arrive `target: null`; a field-keyed table (the original proposal) silently degraded on exactly those four. Zero new error codes; unmapped → `STALE_WRITE`. Unobserved rows: `Client`, `BomRevision` (no provokable seeded rows). |
| S4 | CI gates deploy; `.env.test.example`; commit untracked docs | `chore/S4-ci-and-env-hygiene` | ☐ | PR #12 — parts 1+3 done; part 2 wired and red (see below); part 4 closed by decision | branch protection **not** set — see the decision row below |
| S5 | Merge runbook written | `docs/S5-merge-runbook` | ☐ | | document, not executed |
| — | Merge rehearsed against a restored copy | — | ☐ | | 21 migrations · provision `despl_web` first |
| — | **Merged and deployed** | — | ☐ | | **GATE 0 EXIT** |

---

## GATE 1 — DESPL-320 ships on it

*Exit: one unit goes Package → DispatchBatch → release → dispatch through the UI, and a unit with an open NCR is refused at packing.*

| # | Item | Branch | Status | Demonstrated on | Notes |
|---|---|---|---|---|---|
| S6 | Role gates on packing/dispatch | `fix/S6-packing-dispatch-role-gates` | ☐ | | **before any UI** |
| S7 | Action wrappers | `feat/S7-packing-dispatch-ncr-actions` | ☐ | | |
| S8 | Packing UI | `feat/S8-packing-ui` | ☐ | | |
| S9 | Dispatch UI | `feat/S9-dispatch-ui` | ☐ | | |
| S10 | QC → dispatch gate | `feat/S10-qc-dispatch-gate` | ☐ | | the refusal, watched |
| S11 | NCR disposition UI | `feat/S11-ncr-ui` | ☐ | | renders data already computed |
| S12 | Minimum document attachment | `feat/S12-document-attachment` | ☐ | | **blocked on D5** |
| S13 | Shop-floor nav reachability | `fix/S13-shell-nav-reachability` | ☐ | | on a real tablet, not a viewport |
| S14 | Delay + NCR notifications, real `/alerts` | `feat/S14-delay-ncr-notifications` | ☐ | | |
| S15 | Ship dry run on a restored copy | — | ☐ | | every refusal message recorded |
| — | **DESPL-320 dispatched through the system** | — | ☐ | | **GATE 1 EXIT** |

---

## GATE 2 — a job created in the product works

*Exit: a job created through `/jobs/new`, with one optional process excluded, runs Cutting → Final Inspection, and a material shortage genuinely refuses a start.*
*This is the line between a system of record and a system of control.*

| # | Item | Status | Demonstrated on | Notes |
|---|---|---|---|---|
| S16 | Materialise Component + ComponentOperation in `createJob` | ☐ | | set `bomItemId` |
| S17 | Materialise AssemblyStep per Unit | ☐ | | bind QCP by `(templateId, sequence)` |
| S18 | `linkGoverningDrawing` + fix `assertKitReady` no-op | ☐ | | |
| S19 | `setJobStatus` | ☐ | | |
| S20 | End-to-end integration test | ☐ | | through real service entry points |
| S21 | BomItem unique · seq indexes · stock row lock | ☐ | | |
| — | **A UI-created job runs end to end** | ☐ | | **GATE 2 EXIT — the MOS line** |

---

## GATE 3 — any family, authored as data

*Exit: Pipe Spool onboarded with zero code changes.*

| # | Item | Status | Notes |
|---|---|---|---|
| — | Numeric-join FK, family-scoped | ☐ | **prerequisite** — before family #2, not after |
| — | B3 · B4 · B10 (remaining literals + CI guard) | ☐ | v3 §6 |
| — | Family / template / route / QCP authoring | ☐ | v3 §7 |
| — | **Pipe Spool, zero code changes** | ☐ | **GATE 3 EXIT** |

---

## GATE 4 — the company operates on it

| # | Item | Status | Notes |
|---|---|---|---|
| — | Delivery channel decided (WhatsApp vs email) | ☐ | decide before building the scheduler |
| — | Scheduler + digest + alert reconciliation | ☐ | v3 §9 |
| — | Job-level RLS · `tenant_id` on child tables | ☐ | hard-blocking before tenant #2 |
| — | Pagination + the three page-load N+1s | ☐ | |
| — | KPI consolidation | ☐ | start with cycle-time — two calendars, wrong number |
| — | Cutover · training · refusal guide · sign-off | ☐ | the highest-risk unplanned work in the project |
| — | **13 departments off spreadsheets** | ☐ | **GATE 4 EXIT** |

---

## Findings parked mid-session

When a session turns up something real that was out of scope, put it here rather than losing it.

| Date | Item | Found during | Where it belongs |
|---|---|---|---|
| 2 Sep 2026 | S1 and S2 are still ☐ in Gate 0 above, but `progress.md` records both as merged to `main` via PR #8/#10 with CI green. Either the demonstrations were never recorded, or the ledger was not updated at merge. Not touched here — someone who watched those merges should tick them. | [S3] session, reading the ledger | Gate 0 rows S1/S2 |
| 2 Sep 2026 | Ledger branch names drift from the branches actually cut (S2 planned `chore/…`, actual `fix/…`; same for S3). Harmless, but the ledger stops being greppable against `git branch`. | [S3] session | this file's conventions |
| 2 Sep 2026 | **S4 part 4 closed by decision, not by implementation — do not re-open it.** Branch protection is unavailable: the repo is private on a free GitHub plan, where protected branches do not exist. Both `POST /repos/.../rulesets` and `/branches/main/protection` return `403 Upgrade to GitHub Pro or make this repository public`, and the Settings screens the v4 prompt describes are not present either. Making the repo public is not an option while `scripts/create-department-accounts.ts:21` carries a live shared credential (D3). **Decision (Swayam, 2 Sep): accept it — merge to `main` only after CI passes on the PR, and let Railway deploy from `main`.** Residual risk, accepted: a direct `git push origin main` still bypasses CI, and CI green on a branch is not green on the merge result if `main` moved since (re-run CI on the branch when it has). Revisit only if a second developer joins or GitHub Pro is purchased. | [S4] session | Gate 0 · S4 part 4 |
| 2 Sep 2026 | **Running the e2e suite more than twice in 15 minutes locally locks you out.** `auth.spec.ts` submits two deliberately-wrong passwords per run and `src/app/actions/auth.ts:17-18` rate-limits at 5 failed attempts / 15 min, so the third run fails in `auth.setup.ts` and cascades into every dependent project — looking like a broken suite when it is the rate limiter working correctly. CI never sees it (one run, fresh database). Either wait 15 minutes, clear the recent failed-attempt rows, or trust CI. Not a bug; a documented gotcha. | [S4a] session | a note for whoever runs e2e locally next |
| 2 Sep 2026 | **CONFIRMED and fixed: `/my-day`'s pool-row action pair was 6px apart on tablet** (SPEC §8 assertion 3 requires ≥8px). Initially logged as *unverified* — the phone-project probe could not reach it. CI then failed it on the **tablet** project with the exact measurement (`{w:239,h:48}` / `{w:59,h:48}` only 6px apart), proving the `test.fail()` had been masking a live defect rather than a stale one. Root cause: the flex row at `src/app/(app)/my-day/_client.tsx:329` used `gap: 6` and wraps at tablet width. Fixed to `gap: 8`. **Lesson: a `test.fail()` marker is a defect in hiding, not a note.** | [S4a] session | closed |
| 2 Sep 2026 | **Systemic: ~20 flex containers across `src/app` and `src/components` use `gap: 6`**, below the 8px design grid (CLAUDE.md § Layout) and below SPEC §8 assertion 3's touch minimum. Only `my-day/_client.tsx:329` violates today, because only it wraps two 48px targets onto separate lines at a tested viewport — the rest are latent and will fail the same e2e assertion the moment their content wraps. `/workspace` (5 sites) and `/my-day` (6 more) are both inside the pages that test sweeps. Deliberately NOT swept in S4a: changing 20 gaps is a visual change across the whole app and needs its own review. `grep -rn "gap: 6" src/app src/components` | [S4a] session | a UI item of its own |
| 2 Sep 2026 | Running e2e in CI for the first time (S4 part 2) immediately found two pre-existing failures, neither caused by the wiring: `auth.spec.ts:49` expects a heading "DESPL Production Tracker" after sign-in, but `src/app/page.tsx` is a pure redirect and that heading now lives only in `login/page.tsx`, `admin/_client.tsx` and `account/password/_client.tsx` — the test drifted, the SPEC §7.1 landing behaviour is correct; and `supervisor-viewport.spec.ts:68` reports `Expected to fail, but passed` — a stale `test.fail()` marker whose own comment says the finding was "out of scope to fix", since fixed and never cleared. Both fixes are test edits, which S4 forbids, so they are left for a separate item. Also: the plan says "21 Playwright tests"; the real figure is **134 executions, 79 skipped, 53 passed**. | [S4] session | its own item, before S5 |
