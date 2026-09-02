# DESPL MOS — TRANSFORMATION PLAN

**From:** a multi-family MOS *engine* running one hand-seeded pilot job
**To:** a company-wide Management Operating System
**Constraints this plan is built around:** one developer working with Claude Code, and **DESPL-320 must physically dispatch through the system**.
**Companion:** `docs/DESPL_CODEBASE_ALIGNMENT_AND_DEVELOPMENT_ROADMAP.md` (the evidence). This document is the execution plan. Where they disagree, this one is newer.
**Written:** 2026-09-01, against HEAD `8f81c58`.

---

## 0. The reframe

"Company-wide MOS" is two different things and conflating them is what has made the plan hard to sequence:

- **Breadth** — any product family, any department, authored as data. This is the platform claim.
- **Depth** — the company actually *operates* on it: work is created in the system, gates actually bite, alerts reach a named person, 13 departments have stopped using spreadsheets.

You have most of the *engine* for both and almost none of the *depth*. A second product family on top of today's depth would just be a second family of jobs nobody can execute.

So the sequence is **depth first, then breadth**. That is also, conveniently, the order your ship date demands.

---

## 1. The five gates

Each gate is a claim you can defend to management. Do not start the next one until the current one's exit test has been *demonstrated*, not asserted.

```
GATE 0 ── DEPLOYABLE & SAFE
          The code that exists is the code that runs, and losing it is recoverable.
              ▼
GATE 1 ── DESPL-320 SHIPS ON IT            ◄── you are working toward this
          One real vessel goes pack → release → dispatch through the product,
          with QC gates that actually refuse.
              ▼
GATE 2 ── A JOB CREATED IN THE PRODUCT WORKS
          Job #2 is executable without a developer running a seed script.
          This is the line between "a system of record" and "a system of control".
              ▼
GATE 3 ── ANY FAMILY, AUTHORED AS DATA
          Pipe Spool onboarded with zero code changes. The platform claim, proved.
              ▼
GATE 4 ── THE COMPANY OPERATES ON IT
          Scheduled rhythm, alerts that reach people, 13 departments switched over.
          This is the one that makes it an operating system rather than a database.
```

**Where you are:** Gate 0 is not passed — `main` is 79 commits and **21 migrations** behind, and there are no backups. Gate 1 is achievable in a handful of sessions because the dispatch logic is already written and tested; it just has no UI.

---

## 2. What the ship constraint changed

Three things move, and one thing gets *easier*.

**Easier — and this is the good news.** DESPL-320 already has its `Component`, `ComponentOperation` and `AssemblyStep` rows, because `scripts/seed-despl320-components.ts` created them. **So the P0 materialisation gap does not block your ship date.** It blocks job #2. That lets Gate 2 sit *after* the ship instead of before it, which is what makes the date reachable.

**Moved onto the critical path:**

1. **Packing and dispatch UI.** The services are written, tested, and have zero UI. Nothing else on the ship path takes longer.
2. **Document attachment for MTC certificates and drawing revisions.** If the vessel physically leaves the works, a client gets an MDR. Today the system holds a typed string where a certificate should be. See the decision in §3.
3. **Credential rotation — now a records-integrity issue, not a security one.** `scripts/create-department-accounts.ts:21` puts `despl123@` on `fabrication@` and `qc@` with `mustChangePassword: false`. Maker-checker compares `userId`, so those are two different userIds — meaning one person holding both credentials can submit and verify the same inspection. If this job's QC record is the basis of an MDR a TPI may audit, that is the defect that voids it. **Rotate before the first real sign-off, not before go-live.**

**Verified so you don't have to worry about it:** `PAINTING` is *not* on any of DESPL-320's component routes (its component types are COUPLING / DISHED_END / FORGING / PLATE / SKIRT / FLANGE / PIPE — `seed/despl-320-components.json`). So the unsatisfiable paint/DFT verify gate **cannot fire on this job**. Paint UI is not ship-blocking. It becomes blocking the first time a route with a PAINTING operation is used.

---

## 3. Four decisions to close this week — before any code

These are yours, not a developer's, and three of them run on someone else's calendar.

| # | Decision | Why it can't wait | Recommendation |
|---|---|---|---|
| **D-A** | **Does the MDR for DESPL-320 come out of the system, or is it assembled the old way with the system as the record of *what happened*?** | Determines whether the full document model + MDR compiler is on the ship path (weeks) or off it (days). | **Off it.** Build minimum attachment — a file against an MTC record, a drawing revision, and a QC execution — so the evidence *exists and is traceable*. Assemble this one MDR the way you do today. Full compiler after the ship. |
| **D-B** | **Ask your TPI / client: does a maker-checker click in a software system satisfy their signature and record-integrity expectation for an MDR?** | If the answer imposes e-signature or retention requirements, they must shape the document model *before* it is designed. Retrofitting compliance into storage is expensive; designing for it is nearly free. | Send the question this week. It has a lead time you don't control. |
| **D-C** | **Do you re-pin DESPL-320 to template v2 (the evidence-tagged version) before it ships?** | v2 makes Packing and Dispatch stages refuse to verify without real `Package` / `DispatchBatch` evidence. Powerful — and if the UI isn't finished it permanently bricks two terminal stages on your live job. | **No. Ship on v1.** Build the dispatch UI, use it, let the evidence gate prove itself on job #2. `scripts/add-packing-dispatch-evidence-v2.ts` was deliberately written not to re-pin — respect that. |
| **D-D** | **C1 from `BUILD-SPEC-v2.md` §7: are the lead-time table's "Days" working days or calendar days, and what is the holiday list?** | It changes *every computed date in the system*. Every forecast you show management is provisional until this is answered. | Get it from SJ this week. It is one question and it invalidates or validates every date on the demo. |

---

## 4. Day 1 — four things only you can do

Not development. About ninety minutes total, and two of them have long tails, so do them before you open an editor.

1. **Open Railway. Which branch does the production service deploy from?** Write the answer down in the repo. Everything downstream assumes an answer.
2. **Enable PITR / backups today.** Railway's retention window takes roughly four weeks to fill. If DESPL-320 ships on this system and you want a recoverable record, the clock starts now, independent of every other decision. This is the single most time-sensitive item in the entire plan.
3. **Rotate the four shared department accounts** (§2, point 3). Replace with per-person logins. Confirm `SEED_PASSWORD` is set in the Railway environment — if it isn't, every seeded account has the public default `despl-dev-only`.
4. **Send the two questions:** D-B to your TPI contact, D-D to SJ.

---

## 5. GATE 0 — Deployable & safe

**Exit test:** a production deploy has happened from a known branch, rehearsed first against a restored copy, and you can state when the last backup was taken.

### The merge, precisely

`main` is behind by **190 files, 23,525 insertions, and 21 migrations** — everything from `20260820050300` through the Phase-5 schema. That includes `20260827120001`, which **drops the `procurements` table** after backfilling it, and two migrations whose files were edited after being applied elsewhere.

One detail that will bite the rehearsal: `20260827040000_v_process_plan_percent` is among the pending 21, and it ends with `GRANT SELECT ... TO despl_web`. Production has that role. **A copy restored from a `pg_dump` will not** — `pg_dump` does not carry roles. So before rehearsing, run `scripts/provision-db-role.sql` against the restore target, or the rehearsal fails at that migration for a reason that has nothing to do with your code.

**Rehearsal recipe:**

```
1. pg_dump production  →  restore into a fresh Postgres 16 instance
2. psql < scripts/provision-db-role.sql        # creates despl_web
3. pnpm exec prisma migrate deploy             # all 21, in order
4. run the DE0467 regression scenario against it; confirm the numbers match
5. only then: merge demo → main
```

Write down the result. That written pass/fail *is* the backup drill your own `docs/ARCHITECTURE.md:95` asks for.

### Sessions

| # | Item | Why here | Size |
|---|---|---|---|
| **S1** | **Splice `bypassExcluded` into the gating path** | P0. Excluding an optional process at intake permanently deadlocks its successors. If anyone creates a job during the demo and unticks a process, it bricks. Two lines. **This is your starting line — §8.** | XS |
| S2 | Security headers block in `next.config.ts` | One afternoon, closes a whole risk category. The app is currently framable. | XS |
| S3 | Structured logging in `src/app/actions/_action.ts` + map `P2002` to a domain error | That one file is the error funnel for all 20 action modules — i.e. every mutation — and logs nothing. You are about to run a real job on this. | S |
| S4 | Commit `.env.test.example`; add `pnpm e2e` to CI; branch protection so a red CI blocks deploy; commit `docs/mos-blueprint/` (still untracked) | Cheap hygiene that stops the merge being the last unguarded deploy. | S |

---

## 6. GATE 1 — DESPL-320 ships on it

**Exit test:** one unit of DESPL-320 goes Package → DispatchBatch → release → dispatch through the UI, and a unit with an open NCR is *refused* at packing.

Order matters here: **role gates before actions, actions before UI.** Wiring a UI to an ungated service is how a permissions bug ships.

| # | Item | Notes | Size |
|---|---|---|---|
| **S5** | Add `requireRole(ADMIN, PRODUCTION_HEAD)` to `createPackage`, `assignUnitToPackage`, `createDispatchBatch`, `addUnitToBatch`, `recordDispatch` | All five currently stop at `assertNotClientUser`. `approveDispatchRelease` is already gated — match it. Do this *first*; it is latent only because nothing calls them. | XS |
| S6 | `src/app/actions/packing.ts`, `actions/dispatch.ts`, `actions/ncr.ts` — thin wrappers in the `actions/stock.ts` shape | `requireActor()` + `toActionError`. No logic. | S |
| S7 | Packing UI — create `Package`, assign units | Dispatch refuses an unpacked unit (`UNIT_NOT_PACKED`), so packing must exist first. | S |
| S8 | Dispatch UI — create batch, add units, approve release, record dispatch | The state machine `PLANNED → RELEASED → DISPATCHED` is written and has a 373-line test file. This is UI over proven logic. | M |
| **S9** | **The missing QC → dispatch gate** | Today gating runs one way only. Nothing in `dispatch.service.ts` checks NCR or hold-point status — grep for `Ncr` in that file returns zero. Refuse packing *and* dispatch for a unit with an open NCR or an uncleared hold point. **This is the gate that makes shipping on the system meaningful rather than decorative.** | S |
| S10 | NCR UI — open / disposition / rework / close | `dispositionNcr` has no caller, so `REWORK_IN_PROGRESS` and `DISPOSITIONED` are unreachable states. The data you need to render is *already computed and thrown away*: `cockpit.rework` in `qc-cockpit.read.ts:249-262`, `openReworkItems` in `departments.read.ts`. | M |
| S11 | Minimum document attachment — `Document` model with `tenantId` + RLS from day one, wired to `MaterialIdentification` (MTC), `DrawingRevision`, `QcpExecution` | Scope per **D-A**. Not the MDR compiler. Design after **D-B** is answered. | M |
| S12 | Shop-floor nav: extend `SHELL_NAV` past its four items so `/workspace`, `/qc` and `/jobs` are reachable below 1024px; wrap the wide tables operators will actually use | Today a supervisor on a tablet reaches My Day and three "coming in R2" placeholders. If floor staff touch this during the ship, fix it. | S |
| S13 | Wire `fileDelayReason` → notification and NCR-open → notification; make `/alerts` render `notifications.read.ts` | Both are silent today. On a live job with a delivery date, a silent NCR is the failure mode you will regret. The `/alerts` data layer is already built; the page is a stub. | S |
| **S14** | **Full dry run on a restored copy** — one unit, pack → release → dispatch, plus one deliberate refusal | Do this before the real one. Watch it refuse. | S |

**Deliberately excluded from Gate 1:** paint/DFT UI (cannot fire on this job), the MDR compiler (D-A), family bootstrap, the scheduler, pagination, template v2 re-pin (D-C).

---

## 7. GATE 2 — a job created in the product actually works

**This is the gate that converts you from a very good tracker into an MOS.** It is the honest answer to "is DESPL-320 special?" — right now it is, because a script built its execution layer.

**Exit test:** a job created through `/jobs/new`, with one optional process excluded, runs Cutting → Final Inspection, and a material shortage genuinely refuses a start.

| # | Item |
|---|---|
| S15–S17 | Materialise `Component` + `ComponentOperation` from BOM items × published `RouteTemplateVersion` inside `createJob`'s transaction, **setting `bomItemId`**; then `AssemblyStep` per `Unit` from `AssemblyTemplateVersion`. Lift the loops from `scripts/seed-despl320-components.ts:103-121` and `seed-despl320-assembly-steps.ts:138` — don't invent a new mechanism. Batch with `createMany`; a 40-unit job creates thousands of rows against a 20-second transaction budget. |
| S18 | Bind assembly steps to QCP items by `(qcpTemplateId, sequence)` — already unique — instead of the script's 0.5-threshold fuzzy match on the deliberately non-unique `srNo`, and fail loudly instead of leaving `qcpItemId` null |
| S19 | `linkGoverningDrawing` service + UI select; fix `assertKitReady`'s silent no-op to distinguish "no BOM link" from "never stocked" |
| S20 | `setJobStatus` — `Job.status` currently has no writer anywhere, so no job can ever be completed |
| S21 | **One DB-gated integration test** driving `createJob → generateSchedule → importBomItems → procurement → start/submit/verify → NCR` through the *real service entry points*. No test in the repo crosses more than two of the seven workflow services — which is exactly why this gap survived five phases. |
| S22 | `@@unique([bomRevisionId, itemNo])` on `BomItem`; index both `lead_time_process_seq` columns; `SELECT … FOR UPDATE` in `loadLotForMutation` |

---

## 8. GATE 3 — any family, authored as data

**Exit test:** Pipe Spool onboarded end to end with **zero code changes**. That is the test; nothing less counts.

Sequence: `createProductFamily` → template authoring from scratch (and wire `createTemplateAction`, which exists at `actions/template.ts:22` and is imported by nothing) → `TemplateProcess` / `TemplateEdge` editors with pre-publish cycle validation → route template authoring → QCP authoring from nothing → family readiness dashboard → JSON config bundle import/export so seed-authored and UI-authored families share one shape.

**One hard prerequisite:** the `ComponentOperation`/`AssemblyStep` ↔ `JobProcess` join is numeric-string equality with no foreign key, and `OperationRef` is tenant-scoped while `JobProcess.code` is job-scoped. **A second family will silently pull pressure-vessel operation mappings.** Land the real FK, family-scoped, before family #2 goes live — not a CHECK constraint. The join is fail-open today; a CHECK fixes neither problem.

Then close the remaining literals: the `DESPL-320` fallback in `workspace/page.tsx:10`, the `PRESSURE_VESSEL` literal in `admin.read.ts:63`, the 25-stage name table, and the `FABRICATION` literal in `welding.service.ts:24` — plus a CI guard so the rule enforces itself rather than relying on memory.

---

## 9. GATE 4 — the company operates on it

Scheduler and a real delivery channel — **and that channel decision matters more than the scheduler**. There is no email, WhatsApp, SMS or SMTP integration anywhere in the codebase today, so a scheduled digest currently delivers to a database table. For an Indian shop floor where supervisors live in WhatsApp and may never open a web app at 7am, WhatsApp deserves serious consideration over email.

Then: alert rules as data rather than scattered string literals; KPI consolidation (start with cycle-time, where two different calendar-resolution paths make the number genuinely wrong); job-level RLS and `tenant_id` on the child tables; pagination and the three N+1 loops that fire on every page load.

And the part that is not code and that no engineering plan has covered: **cutover per department, training per role, a plain-language "why did it refuse me" guide for the 49 error codes, and user-acceptance sign-off.** Every engineering item could land perfectly and the project still fails if 13 departments don't switch off their spreadsheets. Start this before the pilot, not after.

---

## 10. THE STARTING LINE — Session 1

Small, P0, self-contained, uses a helper that already exists and is already tested, and produces a failing test you can watch go green. Same shape as your B1/B2 session, but on real code.

### Terminal

```bash
cd ~/"AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER"
git status                                   # commit or stash the 6 dirty files first
git checkout -b fix/W3-gating-splice-excluded-processes
claude
```

Then `/model opus` — this touches the gating engine.

### The prompt — paste as one message

````
RULES

1. Read before you write. Quote, verbatim, CLAUDE.md invariants #2 and #11, and
   the doc comment above `bypassExcluded` in src/lib/schedule/exclude.ts, before
   proposing anything. That is my proof you opened the files.
2. Show me diffs before applying them. Do not edit files until I say apply.
3. Cite file:line for every claim about how the code behaves. If you cannot
   verify something, say UNVERIFIED rather than asserting it.
4. Stay in scope. This item changes the gating read path and adds tests.
   Nothing else. If you spot an adjacent bug, name it and leave it.
5. Do not refactor for style, rename things, or "improve" surrounding code.
6. If you think the instruction is wrong, say so and explain — do not silently
   do something different.

TASK — W3: excluded processes permanently deadlock their successors

THE BUG

The job intake wizard lets a user exclude optional processes
(jobs/new/_client.tsx:696 → job-intake.service.ts:185 writes `included: false`,
and :202 copies edges for ALL processes including excluded ones).

generateSchedule builds ProcessPlan rows from computeEnvelope, which filters out
`included === false` (src/lib/schedule/envelope.ts:64) — so an excluded
JobProcess gets NO ProcessPlan row.

But the gating read path uses the RAW edges:
  - loadGate (src/lib/services/process.service.ts:88-95) reads
    tx.jobProcessEdge.findMany with no bypassExcluded splice
  - loadPredecessorStates (src/lib/services/_shared.ts:822-846) defaults a
    missing plan to "NOT_STARTED"
  - assertCanStart / assertCanComplete (src/lib/schedule/gating.ts:49,83) then
    refuse forever

Net: every direct successor of an excluded process returns GATING_BLOCKED on
start and on verify, permanently, with no way to complete the excluded process
because it has no plan. The job cannot progress past that node.

Note that computeCpm (cpm.ts:91) and selectTerminal (terminal.ts:30) BOTH already
call bypassExcluded correctly. Only the gating read path was missed.

WHAT I WANT

1. First, write a failing test. In src/lib/services/process.service.test.ts, add
   a DB-gated case: a job whose spine excludes one mid-chain process, where the
   direct successor of that excluded process must be startable. Show me it fails
   against current code, with the actual error output.

2. Then propose the fix in loadGate: load the job's spine and run
   bypassExcluded(processes, edges) — the same function cpm.ts:91 uses, already
   exported from src/lib/schedule/index.ts:7 — and take the spliced incoming
   edge set for plan.jobProcessId.

   Before you write it, tell me: does loadGate have access to the full spine, or
   does it need a new read? If it needs one, show me the smallest version and
   say what it costs per gate check — this runs on every start/submit/verify.

3. Check whether loadPredecessorStates (_shared.ts:822) needs the same splice,
   or whether fixing loadGate alone is sufficient. Explain which and why.

4. Confirm whether verifyProcess's assertCanComplete path goes through the same
   loadGate, or has its own edge read that also needs fixing.

STOP CONDITIONS

- Do not change bypassExcluded, cpm.ts, envelope.ts, or terminal.ts. They are
  correct.
- Do not change how exclusions are written at intake.
- If the fix turns out to need more than the gating read path, stop and tell me
  before writing it.
````

### What good looks like in the first response

Verbatim invariant quotes. A statement like *"`loadGate` at `process.service.ts:92` reads `jobProcessEdge` directly and has no access to the spine; the smallest fix needs `loadJobSpine(tx, jobId)`, which is one query per gate check"* — a claim it *checked*, with the cost named. And a failing test with real output, before any fix.

### Push back if

It jumps to the fix without writing the failing test first. It "improves" `gating.ts` while it's in there. It claims the fix works without showing the test going from red to green. Or it quietly widens scope into the materialisation problem — that is Gate 2, not this session.

### Done when

```bash
pnpm lint && pnpm typecheck && pnpm test
RUN_DB_TESTS=1 pnpm test:db          # the new case, red → green
```

```bash
git commit -m "fix(gating): splice excluded processes out of the gating read path

loadGate read raw jobProcessEdge rows while generateSchedule creates no
ProcessPlan for an excluded JobProcess, so every successor of an excluded
process was permanently GATING_BLOCKED. cpm.ts and terminal.ts already
call bypassExcluded; the gating read path did not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XuDCud6di9eFAeE289AbsM"
```

Then paste your `progress.md` end-of-session prompt, log it, and `/clear`.

---

## 11. How to run a session

Four habits, from watching how this codebase went wrong:

1. **Failing test first, on anything behavioural.** Every defect in the audit that survived five phases survived because the test asserted what the code *did*, not what the feature *needed*.
2. **Never mark an item done without seeing its acceptance criterion demonstrated.** Not "tests pass" — the specific thing, on screen. This is the difference between a plan that reports 70% and delivers 70%, and one that reports 70% and delivers 40%.
3. **One item per session, then `/clear`.** Scope creep is the failure you will see most, and it always looks helpful.
4. **When the agent disagrees, listen.** It reads the code more closely than any plan does. If it tells you S9's gate belongs in `packing.service.ts` rather than `dispatch.service.ts`, it may well be right.

---

## 12. What NOT to build before DESPL-320 ships

| Don't | Why |
|---|---|
| Re-pin DESPL-320 to template v2 | Bricks two terminal stages on a live job if the UI isn't finished (D-C) |
| Any route containing a `PAINTING` operation | Those operations can be submitted and never verified — no UI writes the DFT record |
| The family bootstrap UI | An on-ramp to a road that isn't finished. Gate 3. |
| A second product family | Would produce equally un-executable jobs, and the unscoped numeric join will silently match pressure-vessel mappings |
| The MDR compiler | D-A puts it after the ship |
| The scheduler, Redis, BullMQ | Pick the delivery channel first; a Railway cron hitting a protected route may be all you need |
| Pagination, caching, KPI consolidation | Genuinely fine at 3–40 jobs by the code's own measured ceiling. Pair the deferral with S3 so you can see the ceiling coming. |
| A rewrite of anything | Nothing in this codebase classifies as REBUILD, and the audit checked |

---

## 13. Progress ledger

Fill this in as you go. It is the answer to "where are we" that survives a `/clear`.

| Gate | Item | Status | Demonstrated on | Notes |
|---|---|---|---|---|
| Day 1 | Railway branch answered | ☐ | | |
| Day 1 | PITR enabled (4-week clock started) | ☐ | | |
| Day 1 | 4 shared accounts rotated | ☐ | | |
| Day 1 | D-B sent to TPI · D-D sent to SJ | ☐ | | |
| 0 | S1 gating splice | ☐ | | **start here** |
| 0 | S2 security headers | ☐ | | |
| 0 | S3 action logging | ☐ | | |
| 0 | S4 CI + env example | ☐ | | |
| 0 | Merge rehearsed on a restored copy | ☐ | | 21 migrations; provision `despl_web` first |
| 0 | **Merged and deployed** | ☐ | | **Gate 0 exit** |
| 1 | S5 role gates | ☐ | | before any UI |
| 1 | S6 actions | ☐ | | |
| 1 | S7 packing UI | ☐ | | |
| 1 | S8 dispatch UI | ☐ | | |
| 1 | S9 QC→dispatch gate | ☐ | | |
| 1 | S10 NCR UI | ☐ | | |
| 1 | S11 document attachment | ☐ | | scope from D-A |
| 1 | S12 shop-floor nav | ☐ | | |
| 1 | S13 notifications + /alerts | ☐ | | |
| 1 | S14 dry run on restored copy | ☐ | | |
| 1 | **DESPL-320 dispatched through the system** | ☐ | | **Gate 1 exit** |
| 2 | S15–S22 | ☐ | | |
| 2 | **A UI-created job runs end to end** | ☐ | | **Gate 2 exit — the MOS line** |
| 3 | Family bootstrap + numeric-join FK | ☐ | | |
| 3 | **Pipe Spool, zero code changes** | ☐ | | **Gate 3 exit** |
| 4 | Scheduler + delivery + adoption | ☐ | | |
| 4 | **13 departments off spreadsheets** | ☐ | | **Gate 4 exit** |

---

*Sequenced for one developer working with Claude Code, with DESPL-320 shipping on the system. If either constraint changes — a second developer, or the ship date moving — Gate 2 moves ahead of Gate 1 and the plan gets meaningfully shorter.*
