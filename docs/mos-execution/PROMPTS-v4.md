# PROMPTS v4 — Ship-First Execution Set

**Supersedes `docs/mos-blueprint/PROMPTS.md` (v3) for phase ORDER and for Gates 0–2.**
v3's rules block, and its Phase C / D / E / H / I / J / K item prompts, are still good and are referenced rather than repeated. **Where v3 and v4 disagree on sequence, v4 wins** — v3 was written before the execution-layer gap (N1) and the excluded-process deadlock (N2) were found, and before the constraint that DESPL-320 must physically dispatch through the system.

**Plan this implements:** `docs/DESPL_MOS_TRANSFORMATION_PLAN.md`
**Evidence behind it:** `docs/DESPL_CODEBASE_ALIGNMENT_AND_DEVELOPMENT_ROADMAP.md`
**Progress:** `docs/mos-execution/LEDGER.md` — update it at the end of every session.

---

## 0. How to run a session

```bash
cd ~/"AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER"
git status                          # tree must be clean — commit or stash first
git checkout -b <type>/<ID>-<slug>
claude
```

Then, as **one** message: **§1 RULES BLOCK**, immediately followed by the item prompt. Do not send the rules block alone and wait — that burns a turn with nothing to anchor against.

Model: `/model opus` for anything touching gating, scheduling, state machines, RBAC, audit or migrations. `/model sonnet` for UI, docs and wiring.

One item per session. Then log to `progress.md` (§6), update `LEDGER.md`, and `/clear`.

---

## 1. RULES BLOCK — paste above every item prompt

```
You are working on the DESPL Production Tracker → DESPL MOS. Read CLAUDE.md first —
especially the twelve non-negotiable invariants.

=== DATABASE SAFETY — READ TWICE ===
Before ANY prisma command, print the loaded DATABASE_URL and show it to me.
NEVER run: prisma migrate reset · prisma db push · prisma migrate dev.
(migrate dev DROPS AND RECREATES the database on drift. despl_demo is the live demo
database shown to company management. Destroying it is unrecoverable.)
The ONLY migration commands you may run: `prisma migrate diff`, and `prisma migrate deploy`
against despl_test ONLY. To create a migration, hand-write the SQL file and show me first.
Never run any command against a DATABASE_URL I did not explicitly give you.
Never run `pnpm dev` — it does not exit and will hang this session.

=== EVIDENCE, NOT CLAIMS ===
Paste literal terminal output for every command you run. If you did not run something,
write "NOT RUN". Never report a step as verified unless its output is in your reply.
Never read AUTH_SECRET or mint a session token to verify something. Drive the real /login
form through browser automation, or report verification as incomplete.

=== TESTS ===
NEVER delete, skip, weaken, or rewrite an existing test to make the suite pass.
If a test fails: fix the code, or stop and report. Do not modify the test.
If two attempts at the same fix fail, STOP and report. Do not keep trying.
For any behavioural change: write the FAILING test first, show me it failing, then fix.

=== GIT ===
Create branch <type>/<ID>-<slug> before editing anything. Never commit to main or demo.
Never run: git reset --hard · git checkout . · git clean · git push --force.
Do not push or open a PR unless I ask.

=== SECRETS AND DEPENDENCIES ===
Never print, echo, or copy any value from .env. Never write a credential into a source file.
New config goes in .env.example with a placeholder.
Do not add any dependency without naming it and its alternatives to me first.

=== CODE RULES ===
- Business rules live in src/lib/services/. Server Actions are thin callers — never call
  Prisma directly from src/app/actions/*.
- Validation schemas live in src/lib/shared/schemas.ts. One source of truth.
- Reuse an existing error code from src/lib/shared/errors.ts (49 exist). If none fits, say so
  before inventing one.
- No literal "DESPL-320", family code, or department code anywhere in src/. seed/, scripts/,
  prisma/ and test fixtures may use them.
- No client-supplied timestamps. Server clock only (invariant #1).
- Changes to state machine, gating, RBAC or audit paths require table-driven tests for the
  VIOLATION cases, not just happy paths.

=== KNOWN STATE OF THIS CODEBASE — do not "discover" these and go fix them ===
These are real, known, and each has its own scheduled work item. If you trip over one,
NAME IT and move on. Do not fix it as a side effect of the item you were given.
- No code in src/ creates Component, ComponentOperation or AssemblyStep rows. Only
  prisma/seed.ts and scripts/seed-despl320-*.ts do. DESPL-320's execution layer was
  seeded. This is scheduled as Gate 2 (S15-S17). Assume component rows exist ONLY for
  seeded jobs.
- dispatch.service.ts, packing.service.ts, override.service.ts, ncr.service.ts's
  dispositionNcr, and component.service.ts's recordPaintRecord/recordDftReading have
  ZERO callers. That is a known gap being closed in Gate 1 (S5-S10), not a bug to
  opportunistically wire.
- assertKitReady and assertDrawingReleased no-op on null bomItemId / governingDrawingId,
  which nothing in the app sets. Scheduled as S18-S19.
- Job.status has no writer anywhere. Scheduled as S20.

=== HARD BANS FOR THIS PHASE ===
- Do NOT re-pin DESPL-320 to ProcessTemplateVersion v2. v2 tags Packing and Dispatch with
  evidenceKind; if the UI is not finished, re-pinning permanently bricks two terminal
  stages on the live pilot job.
- Do NOT publish any template version that tags an evidenceKind with no reachable producer
  (MDR_COMPILED has none — _shared.ts hardcodes satisfied=false).
- Do NOT add a PAINTING operation to any route. PAINTING operations can be submitted and
  never verified: the DFT gate at component.service.ts:345 has no UI writer.

=== THIS REPO RUNS AHEAD OF ITS DOCS ===
Capabilities have repeatedly been documented as missing when they were already built
(material gating, the client portal). Before concluding something doesn't exist:
grep src/, and grep progress.md.
progress.md is ~485KB — NEVER read it whole. Use grep with a specific term piped to head -50.
If a grep returns more than 50 lines, narrow it.

=== IF YOU DISAGREE ===
If you think an instruction is wrong, say so and STOP. Do not implement what you think I
meant. If a file I told you to read doesn't exist, STOP and tell me — do not proceed without it.

Now, before touching anything: quote invariants #1, #4 and #9 back to me verbatim from
CLAUDE.md, and paste the first line of src/lib/shared/errors.ts. Then do the item below.
```

---

## 2. GATE 0 — Deployable & safe

**Exit test:** a production deploy has happened from a known branch, rehearsed first against a restored copy, and you can state when the last backup was taken.

Before S1: the working tree currently has 6 modified files (`assembly.service.ts`, `assembly.service.test.ts`, `bom-route.ts`, `bom-route.test.ts`, `bom.read.ts`, `qcp.service.ts`). Commit or stash them — every session below assumes a clean tree.

---

### S1 — Splice excluded processes out of the gating read path ★ START HERE

Branch: `fix/W3-gating-splice-excluded-processes` · Model: **opus** · Size: XS

```
Work item: [S1] Excluded processes permanently deadlock their successors.

THE BUG

The intake wizard lets a user exclude optional processes:
  src/app/(app)/jobs/new/_client.tsx:696 collects excludedProcessCodes
  src/lib/services/job-intake.service.ts:185 writes `included: false`
  src/lib/services/job-intake.service.ts:202 copies edges for ALL processes, including
    excluded ones (deliberately — see the comment at :197)

generateSchedule builds ProcessPlan rows from computeEnvelope, which filters out
`included === false` (src/lib/schedule/envelope.ts:64). So an excluded JobProcess gets
NO ProcessPlan row at all.

But the gating read path uses the RAW edges:
  - loadGate (src/lib/services/process.service.ts:88-95) calls
    tx.jobProcessEdge.findMany with no bypassExcluded splice
  - loadPredecessorStates (src/lib/services/_shared.ts:822-846) defaults a missing plan
    to "NOT_STARTED"
  - assertCanStart / assertCanComplete (src/lib/schedule/gating.ts:49,83) then refuse,
    permanently

Net: every direct successor of an excluded process returns GATING_BLOCKED on start AND on
verify, forever, with no way to complete the excluded process because it has no plan.

computeCpm (src/lib/schedule/cpm.ts:91) and selectTerminal (src/lib/schedule/terminal.ts:30)
BOTH already call bypassExcluded correctly. Only the gating read path was missed.

WHAT I WANT, IN THIS ORDER

1. A FAILING TEST FIRST. In src/lib/services/process.service.test.ts, add a DB-gated case:
   a job whose spine excludes one mid-chain process, where the direct successor of that
   excluded process must be startable. Run it. Paste the literal failure output.

2. THEN propose the fix in loadGate: load the job's spine and run
   bypassExcluded(processes, edges) — the same function cpm.ts:91 uses, already exported
   from src/lib/schedule/index.ts:7 and already tested in src/lib/schedule/exclude.test.ts —
   then take the spliced incoming edge set for plan.jobProcessId.

   Before writing it, answer: does loadGate already have access to the full spine, or does
   it need a new read? If it needs one, show me the smallest version and tell me what it
   costs per gate check. This runs on every start / submit / verify.

3. Tell me whether loadPredecessorStates (_shared.ts:822) needs the same splice, or whether
   fixing loadGate alone is sufficient. Explain which and why.

4. Confirm whether verifyProcess's assertCanComplete path goes through the same loadGate or
   has its own edge read that also needs fixing.

STOP CONDITIONS
- Do not change bypassExcluded, cpm.ts, envelope.ts or terminal.ts. They are correct.
- Do not change how exclusions are written at intake.
- If the fix needs more than the gating read path, STOP and tell me before writing it.

DONE WHEN
  pnpm lint && pnpm typecheck && pnpm test
  RUN_DB_TESTS=1 pnpm test:db     # the new case goes red → green
```

**Good looks like:** verbatim invariant quotes; a claim it *checked* with the cost named ("`loadGate` has no spine access; the smallest fix adds one `loadJobSpine` query per gate check"); a failing test with real output before any fix.
**Push back if:** it fixes before testing · it "improves" `gating.ts` while it's in there · it widens into the materialisation problem (that's Gate 2).

---

### S2 — Security headers

Branch: `chore/S2-security-headers` · Model: sonnet · Size: XS

```
Work item: [S2] Add HTTP security headers. There are currently none.

src/app/../next.config.ts is the default scaffold with no headers() block. src/middleware.ts
sets only x-request-id. Result: the app is framable (a supervisor can be clickjacked into
Verify or Reject), there is no CSP, and no HSTS.

Add a headers() block in next.config.ts:
  Strict-Transport-Security, X-Frame-Options: DENY, X-Content-Type-Options: nosniff,
  Referrer-Policy: strict-origin-when-cross-origin, a starting Content-Security-Policy.
Also set poweredByHeader: false.

The CSP is the part that can break the app. Next 15 with Turbopack, React 19 and Tailwind v4
inline styles: propose a policy, tell me exactly which directive each of those needs and why,
and start report-only if you think the risk warrants it. Say which you chose.

Verify by showing me the response headers from a production-mode build, not by asserting.
Do not touch middleware.ts's request-id logic.
```

---

### S3 — Log the Server Action path, and stop leaking raw Prisma errors

Branch: `feat/S3-action-observability` · Model: opus · Size: S

```
Work item: [S3] The primary write path of this application is entirely unlogged.

src/app/actions/_action.ts is the error funnel that all 20 Server Action modules use — i.e.
every mutation in the product — and it logs nothing. There are 4 console.* calls in all of
non-test src/, all on the 7 /api routes. During an incident the operator has raw Railway
stdout and a binary /api/health.

Two changes, one file (plus whatever it needs to read):

1. Structured logging in toActionError: one line per refusal and per unexpected error,
   carrying request id, actor id, tenant id, action name, and error code. src/middleware.ts:18
   already stamps x-request-id — use it as the correlation key. Match the shape
   src/app/api/_lib.ts:98,105 already uses so /api and actions correlate.

2. toActionError currently RETHROWS anything that is not an AppError (_action.ts:11). Every
   duplicate guard in this codebase is check-then-insert against a real unique index, so each
   has a losing-race path that surfaces a bare Prisma P2002 as an unexplained 500. Grep
   confirms zero P2002 handling anywhere in src/. Map P2002 to the matching domain error code.

   Show me the mapping table you propose BEFORE writing it — which constraint maps to which
   of the 49 existing codes, and which (if any) genuinely need a new code.

Do not add a logging dependency without asking. console with a structured object is
acceptable for this step; Sentry is a later item.
Do not change any service's behaviour — this is the action boundary only.
```

---

### S4 — Make CI gate the deploy, and make the test tier runnable

Branch: `chore/S4-ci-and-env-hygiene` · Model: sonnet · Size: S

```
Work item: [S4] Four pieces of hygiene that all block a safe first deploy.

1. .env.test does not exist in the tree and there is no .env.test.example, yet
   `pnpm test:db` hard-requires it and 8 test files reference its contents by name
   (e.g. connection_limit=10). A new engineer cannot run ~60% of the suite.
   Reconstruct .env.test.example from .github/workflows/ci.yml:35-36. Placeholders only —
   never a real credential.

2. .github/workflows/ci.yml runs lint → typecheck → test → DB tests → build, but never runs
   `pnpm e2e`. All 21 Playwright tests are local-only, including the RBAC and client-scoping
   regression pins in e2e/auth.spec.ts:86. Add e2e to CI. If it needs a running server or a
   seeded database, show me the job definition and the cost before adding it.

3. docs/mos-blueprint/ and docs/DESPL_MOS_FORENSIC_AUDIT.md are UNTRACKED in git — 25
   documents that a `git clean` would erase. Add and commit them.

4. Tell me exactly what GitHub branch-protection settings I need to set by hand so a red CI
   blocks a deploy to main. Railway watches the branch, not the CI status, so today a red
   build deploys. You cannot set this from the repo — give me the click path.

Do not change any test. Do not change what CI already runs, only add.
```

---

### S5 — The merge runbook (write it, don't run it)

Branch: `docs/S5-merge-runbook` · Model: opus · Size: S

```
Work item: [S5] Write the runbook for merging demo → main. Do not execute any of it.

Facts to build on — verify each yourself and correct me if I'm wrong:
- main is 79 commits behind HEAD: 190 files, 23,525 insertions, and 21 pending migrations
  (20260820050300 through 20260831064422).
- 20260827120001 DROPS the procurements table after backfilling it inside the migration.
- 20260827120001 and the Phase-5 migration were both edited AFTER being applied elsewhere
  (see the migration's own header, and progress.md around the Phase-5 session). Checksum
  mismatch risk on migrate deploy.
- 20260827040000_v_process_plan_percent is among the 21 pending, and ends with
  GRANT SELECT ... TO despl_web. pg_dump does not carry roles, so a restore target will NOT
  have that role and will fail there. scripts/provision-db-role.sql creates it.
- railway.json runs `prisma migrate deploy` as preDeployCommand.
- There is no staging environment.

Produce docs/mos-execution/MERGE-RUNBOOK.md with:
- exact ordered steps to rehearse the merge against a restored copy of production
- what to check after each step, and the literal command to check it
- the specific failure modes above, what each looks like, and the recovery for each
- an explicit abort point: the last step at which stopping is still free
- a post-merge verification list, including how to confirm from the production
  _prisma_migrations table that all 21 applied

This is a document, not code. Do not run prisma against anything.
```

---

## 3. GATE 1 — DESPL-320 ships on it

**Exit test:** one unit of DESPL-320 goes Package → DispatchBatch → release → dispatch through the UI, and a unit with an open NCR is *refused* at packing.

Order is deliberate: **role gates → actions → UI → the gate that makes it mean something.**

---

### S6 — Role-gate the packing and dispatch mutations (before any UI)

Branch: `fix/S6-packing-dispatch-role-gates` · Model: opus · Size: XS

```
Work item: [S6] Five mutations that record physical, commercial facts have no role gate.

These carry only assertNotClientUser — no requireRole, no requireDepartmentScope:
  packing.service.ts:27  createPackage
  packing.service.ts:69  assignUnitToPackage
  dispatch.service.ts:68  createDispatchBatch
  dispatch.service.ts:108 addUnitToBatch
  dispatch.service.ts:220 recordDispatch

dispatch.service.ts:165 approveDispatchRelease IS gated (PRODUCTION_HEAD, ADMIN) — match it.

Why now: recordDispatch asserts a vessel physically left the works, and Unit.packageId /
DispatchBatchUnit are the two evidence sources assertEvidenceSatisfied (_shared.ts:632,637)
trusts. This is latent only because nothing calls these functions yet. I am about to wire
UI to them in the next session, which is exactly when it stops being latent.

Add the gates. Then add the refusal tests — dispatch.service.test.ts already has the shape
for cross-tenant and CROSS_JOB_ASSIGNMENT refusals; follow it. packing.service.ts has NO
test file at all; create one.

Question I want answered before you write: should assignUnitToPackage be PRODUCTION_HEAD/ADMIN
like the rest, or should a STORES or DISPATCH supervisor be able to pack? Argue it from how
requireDepartmentScope is used elsewhere, and tell me what you'd choose.
```

---

### S7 — Action wrappers for packing, dispatch and NCR

Branch: `feat/S7-packing-dispatch-ncr-actions` · Model: sonnet · Size: S

```
Work item: [S7] Add the Server Action layer for packing, dispatch and NCR disposition.

Create src/app/actions/packing.ts, dispatch.ts and ncr.ts. Thin wrappers only —
requireActor() + toActionError, no business logic, exactly the shape of
src/app/actions/stock.ts.

Cover:
  packing:  createPackage, assignUnitToPackage
  dispatch: createDispatchBatch, addUnitToBatch, approveDispatchRelease, recordDispatch
  ncr:      dispositionNcr, and closeNcr ONLY IF it is safe to expose

On closeNcr: ncr.service.ts:125-131 explicitly warns not to call it from an action — it is a
tx-level helper whose callers (verifyComponentOperation, verifyAssemblyStep) hold the gate.
Read that comment, decide, and tell me your reasoning. If you expose it, say what gate you
added. If you don't, say so and leave it out.

Add the revalidatePath calls the existing actions use. Note that actions/process.ts:61 and
others revalidate "/board", which is a stub page — do not copy that; revalidate the paths
that actually render this data.

No UI in this session.
```

---

### S8 — Packing UI

Branch: `feat/S8-packing-ui` · Model: sonnet · Size: S

```
Work item: [S8] A user can create a Package and assign units to it.

Dispatch refuses an unpacked unit (dispatch.service.ts:139-141, UNIT_NOT_PACKED), so packing
must exist before dispatch UI is useful.

Read the Package model in prisma/schema.prisma (~line 840) and packing.service.ts first, and
tell me what a package actually represents here before you design anything — is it a crate,
a truckload, a shipment? Your answer changes the screen.

Where it goes: propose a location. My default assumption is a tab on /jobs/[id], next to the
existing tabs in src/app/(app)/jobs/[id]/_client.tsx. Argue for or against.

Requirements from CLAUDE.md's functional-first rules: real loading state (the three
loading.tsx files in this repo are the pattern), an empty state that is one sentence plus one
action, and an error state that surfaces the refusal — /my-day's inline RefusalNote
(my-day/_client.tsx:112-128) is the best example in the codebase; toast-only is the weaker
pattern used elsewhere.

Permissions are computed server-side and passed as booleans; the UI is cosmetic only. Follow
how jobs/[id] already does this.
```

---

### S9 — Dispatch UI

Branch: `feat/S9-dispatch-ui` · Model: sonnet · Size: M

```
Work item: [S9] A user can create a dispatch batch, add packed units, approve release, and
record dispatch.

The state machine is written and tested: dispatch.service.ts:36-42
(PLANNED → RELEASED → DISPATCHED), derived from nullable columns via
deriveDispatchBatchStatus (:44), with 373 lines of tests in dispatch.service.test.ts. This
session is UI over proven logic — do not change the service.

Four actions, three of them state transitions. The screen must make the current state
obvious and only offer the legal next transition. Read assertDispatchBatchTransition (:53)
and mirror it — do not reimplement the rules in the component.

approveDispatchRelease is PRODUCTION_HEAD/ADMIN only. That control is hidden for others,
but the server is authoritative — verify you have not put the only check in the UI.

recordDispatch takes dispatchNoteNo, gatePassNo, vehicleNo, lrNo (all String? on
DispatchBatch, schema.prisma:1952-1955). Ask me which of those are mandatory in practice
before you decide which are required in the form.

Same state-handling requirements as S8.
```

---

### S10 — The missing QC → dispatch gate ★ the one that makes shipping mean something

Branch: `feat/S10-qc-dispatch-gate` · Model: opus · Size: S

```
Work item: [S10] Nothing stops a unit with an open NCR or an uncleared hold point from being
packed and dispatched.

Verify this first and tell me if I'm wrong: grep for "Ncr" in src/lib/services/dispatch.service.ts
returns zero. The QC↔dispatch relationship currently runs one direction only — a JobProcess-level
Dispatch stage cannot be verified without dispatch evidence (assertEvidenceSatisfied) — but
nothing checks quality status before a unit is packed or shipped.

Add the reverse gate. A unit must be refused at packing AND at dispatch if it has:
  - an open Ncr (see assertNoOpenNcr in _shared.ts:542 for the existing query shape), or
  - an uncleared blocking hold point (see assertNoOpenHoldPoint in _shared.ts:413)

Design questions I want answered before you write:
1. Which of the two is the right refusal point — packing, dispatch, or both? Argue it.
2. assertNoOpenNcr resolves NCRs through the leadTimeProcessSeq numeric join, which returns
   [] when unitId is null or the code is non-numeric — i.e. it FAILS OPEN. For a unit-grain
   check here, is that join the right mechanism, or should this query Ncr through the
   rejection → operation → component → unit chain directly? Show me both and recommend one.
3. Which error code? EVIDENCE_NOT_SATISFIED and NCR_OPEN already exist. Reuse if one fits.

Table-driven refusal tests, per the rules block. This is a gating change.

Do NOT reach into the numeric-join problem itself — that is a Gate 3 item (the real FK).
```

---

### S11 — NCR disposition UI

Branch: `feat/S11-ncr-ui` · Model: sonnet · Size: M

```
Work item: [S11] NCRs can be opened by the system but never dispositioned by a human.

Current behaviour: every QC rejection auto-creates an Ncr (component.service.ts:434,
assembly.service.ts:320) and re-verification auto-closes it (component.service.ts:385).
dispositionNcr (ncr.service.ts:75) has no caller, which makes REWORK_IN_PROGRESS and
DISPOSITIONED unreachable states — so USE_AS_IS, SCRAP and CONCESSION dispositions can
never be recorded.

The data you need is ALREADY COMPUTED AND DISCARDED — find it before designing:
  qc-cockpit.read.ts:249-262 computes rework { openCount, totalReworkHours } and
    /qc's _client.tsx never renders it (2 extra queries per page load, thrown away)
  departments.read.ts computes DeptCard.openReworkCount and DeptDetail.openReworkItems,
    neither rendered

So this is largely a rendering job on existing reads, plus the disposition control wired to
S7's action.

Read the Ncr model and assertNcrTransition (ncr.service.ts:18-26) and make the UI offer only
legal transitions. Ncr.reworkDueDate exists and is never read by any query — decide whether
to surface it, and say why.

Where: /qc is the QC cockpit and is the obvious home; departments/[id] already has the rework
list shape. Propose one, don't build both.
```

---

### S12 — Minimum document attachment  ⚠ gated on decision D-B

Branch: `feat/S12-document-attachment` · Model: opus · Size: M

```
DO NOT START THIS SESSION until I have told you the answer to the TPI / ASME
record-integrity question (does a maker-checker click satisfy their signature and
record-retention expectation for an MDR?). If I have not, stop and say so.

Work item: [S12] There is no file storage anywhere in this application. Add the minimum
needed for DESPL-320's records to be real.

Verify the gap first: grep src/ and package.json for multipart, S3Client, @aws-sdk,
presigned, cloudinary, uploadthing, multer, busboy. Report what you find.

Scope for THIS session — minimum, not the full document model:
  - A Document model with tenantId AND an RLS policy from day one. Do not add it to the 49
    tables that currently rely on FK-chain reachability. Follow the tenant_isolation policy
    shape in prisma/migrations/20260813052000_rls_fail_closed/migration.sql.
  - Links to exactly three parents: MaterialIdentification (MTC certificates),
    DrawingRevision (the drawing behind a "RELEASED" status word), QcpExecution (inspection
    evidence).
  - Upload with a size and mime allowlist, audit-logged in the same transaction (audited()).
  - Download with permission inherited from the owning entity's existing scoping.

NOT in scope: the MDR compiler, DocumentCategoryRef, links to the other six entity types,
revision/supersede semantics. Those are post-ship.

Before any schema work, propose:
1. The object store and why (this repo has no storage dependency yet — name alternatives).
2. Whether the file goes through the Next server or via a presigned URL, and the security
   tradeoff of each given that there is currently NO server-side file handling anywhere.
3. Whether existing free-text refs (MaterialIdentification.mtcRef, etc.) stay alongside a
   nullable documentId, or are replaced. I believe they should stay. Argue it.

Hand-write the migration and show me before applying anything.
```

---

### S13 — Shop-floor navigation

Branch: `fix/S13-shell-nav-reachability` · Model: sonnet · Size: S

```
Work item: [S13] Below 1024px, the app navigates almost nowhere real.

src/components/industrial/app-shell.tsx:120-125 — the tablet icon rail and the phone bottom
nav share one SHELL_NAV array with four destinations: /my-day, /board, /alerts, /profile.
Three of those four are "coming in R2" stubs.
src/app/globals.css:753 hides .sidebar below 640px... :805 restores it only at min-width:1024px.

Net: a supervisor on a shop-floor tablet can reach My Day and three placeholders. /workspace,
/qc, /jobs, /dashboard, /departments, /welding, /reports are reachable only by typing a URL.

1. Extend SHELL_NAV so /workspace, /qc and /jobs are reachable below 1024px. If the rail runs
   out of room, make it scrollable rather than dropping items. Respect the role gating that
   already exists — but note (app)/layout.tsx:62 passes userRole={actor?.roles[0]}, a single
   string, so a user with two roles loses the second one. Fix that too; it is one line and it
   is in scope because it changes what the nav shows.

2. e2e/supervisor-viewport.spec.ts:46 SHELL_PAGES lists the three stub pages. Point it at the
   real routes instead. Expect the horizontal-overflow assertion to start failing on wide
   tables — that is the point. Report which pages fail; do NOT fix the tables in this session.

Do not touch the CSS breakpoint architecture. It is deliberate (see the comments at
app-shell.tsx:324-328 and globals.css:738-745) and it is correct.
```

---

### S14 — Notifications for the two silent events, and a real /alerts page

Branch: `feat/S14-delay-ncr-notifications` · Model: sonnet · Size: S

```
Work item: [S14] The two highest-signal exception events in the system are silent.

  - Filing a delay reason notifies nobody. delay.service.ts does not import notify.
  - Opening an NCR notifies nobody. component.service.ts:434 and assembly.service.ts create
    the Ncr silently. ncr.service.ts does not import notify.

Both should fire in-transaction, exactly like the existing ones. The pattern to copy is
process.service.ts:185-199 (submit → notify QC) — note it deliberately puts the notify
INSIDE the same transaction so a failed notify rolls back the submit.

Who gets notified: notification routing currently uses hardcoded role strings
(userIdsWithRole(tx, tenantId, "QC") at process.service.ts:185; "PRODUCTION_HEAD" at
notifications.service.ts:262,297) while a ROLES const exists at authz/index.ts:11. Use ROLES.
Tell me who you think should receive each, and why, before wiring it.

Then: /alerts is a stub page rendering "Delay and hold notifications coming in R2"
(src/app/(app)/alerts/page.tsx:11) while notifications.read.ts, a Notification model with
readAt acknowledgement, and a working bell dropdown all already exist. Render the real list.
Note that alerts/page.tsx also omits the client-user redirect every sibling page has — add it.

Do not build the scheduler. Do not move syncNotifications out of the page-load path. Both are
Gate 4.
```

---

### S15 — Dry run on a restored copy

Branch: none — this is an operations session · Size: S

```
Work item: [S15] Rehearse the DESPL-320 dispatch end to end before doing it for real.

This is a procedure, not code. Produce docs/mos-execution/SHIP-DRY-RUN.md and then walk me
through it.

The run, against a RESTORED COPY of production (never the live database):
1. One unit of DESPL-320: create a Package, assign the unit, create a DispatchBatch, add the
   unit, approve release, record dispatch. Confirm each step in the UI, not the database.
2. Then the refusals. Deliberately try: adding an unpacked unit to a batch (expect
   UNIT_NOT_PACKED), adding a unit from another job (expect CROSS_JOB_ASSIGNMENT), recording
   dispatch on a PLANNED batch, approving release as a non-PRODUCTION_HEAD user, and — from
   S10 — packing a unit with an open NCR.
3. For each refusal, record the exact message the user sees. If any of them is a 500, a raw
   Prisma error, or a message a shop-floor user could not act on, that is a finding — log it.

Confirm from the audit_log that every one of those actions wrote a row with the right actor.
That is the evidence trail an MDR would rest on.

Do not run anything against despl_demo.
```

---

## 4. GATE 2 — a job created in the product actually works

Full prompts for these will be written when Gate 1 exits — they depend on what Gate 1 teaches. Briefs, so you can see the shape:

| # | Item | Brief |
|---|---|---|
| S16 | Materialise `Component` + `ComponentOperation` in `createJob` | For each `BomItem` whose `componentTypeId` resolves to a published `RouteTemplateVersion`, create the Component **with `bomItemId` set** and its operations. Lift the loop from `scripts/seed-despl320-components.ts:103-121` — do not invent a new mechanism. Batch with `createMany`; a 40-unit job is thousands of rows against a 20s transaction budget. |
| S17 | Materialise `AssemblyStep` per `Unit` | Pattern at `scripts/seed-despl320-assembly-steps.ts:138`. **Bind `qcpItemId` by `(qcpTemplateId, sequence)`** — already unique — not the script's 0.5-threshold fuzzy match on the deliberately non-unique `srNo`. Fail loudly instead of leaving it null. |
| S18 | `linkGoverningDrawing` + fix `assertKitReady`'s no-op | Makes the drawing gate and the material gate actually bite. Distinguish "no BOM link" (legitimate seam) from "never stocked" (should refuse). |
| S19 | `setJobStatus` | `Job.status` has no writer anywhere. Guard COMPLETE while any current-run plan is incomplete. `job-health.ts:63-67` already branches on states that can never occur. |
| S20 | The integration test | `createJob → generateSchedule → importBomItems → procurement → start/submit/verify → NCR`, through the **real service entry points**. No test in this repo crosses more than two of the seven workflow services — which is exactly why the gap survived five phases. |
| S21 | Database integrity | `@@unique([bomRevisionId, itemNo])` on `BomItem`; index both `lead_time_process_seq` columns; `SELECT … FOR UPDATE` in `loadLotForMutation`. |

---

## 5. GATES 3 and 4 — use v3's prompts, with these corrections

`docs/mos-blueprint/PROMPTS.md` §7 (Phase C), §8 (D), §9 (E), §10 (F–K) and §11 (M, N) are still good. Three corrections before you use them:

1. **v3 §6 Phase B is partly done and partly superseded.** B1/B2 landed in `776c0f3`. B3 (the `workspace/page.tsx` DESPL-320 fallback) and B4 (the `admin.read.ts` PRESSURE_VESSEL literal) are **still open** — run them, but after Gate 1, not before. B10's literal guard is worth doing early because it makes the rule self-enforcing.
2. **Add the numeric-join FK to Phase C as a prerequisite, not a later item.** `OperationRef` is tenant-scoped while `JobProcess.code` is job-scoped, so a second family will silently pull pressure-vessel operation mappings through the unscoped join. v3 and the blueprint recommend "(b) DB CHECK now, (a) FK later" — **go straight to the FK.** The join is fail-open today (`_shared.ts:479` returns without gating on a non-numeric code); a CHECK fixes neither the fail-open nor the cross-family match.
3. **v3 §9 Phase E assumes a delivery channel exists. It does not.** There is no email, WhatsApp, SMS or SMTP integration anywhere in the codebase — a scheduled digest currently delivers to a database table. Decide the channel before building the scheduler. For an Indian shop floor where supervisors live in WhatsApp and may never open a web app at 7am, WhatsApp deserves serious consideration over email.

---

## 6. End-of-session prompt

Paste this at the end of every session, before `/clear`:

```
Write the progress.md entry for this session. Follow the format of the last three entries —
read them first (tail progress.md, do not read the whole file).

Include: the item ID and branch, what changed and in which files, the acceptance criterion
and the literal output that demonstrated it, anything you found that was NOT in scope and
did not fix (name it so it doesn't get lost), and anything a future session would get wrong
if it didn't know it.

Be honest about what you did not verify. If something is unverified, write UNVERIFIED.

Then give me the one-line LEDGER.md update for this item.
```

---

## 7. When to push back

| What you see | What it means | What to say |
|---|---|---|
| Skips the invariant quotes | It didn't read `CLAUDE.md` | "Quote invariants #1, #4, #9 verbatim first." |
| Claims something works with no output | Asserting, not checking | "Paste the literal terminal output." |
| Fixes before writing the failing test | The exact habit that let four P0s survive five phases | "Failing test first. Show me it red." |
| Edits a file outside the item's scope | Scope creep — always looks helpful | "Out of scope. Name it and move on." |
| Starts wiring an unreachable service you didn't ask about | Known-state list in the rules block | "That's scheduled. Not this session." |
| Proposes re-pinning DESPL-320 to v2 | Would brick two terminal stages on the live job | "Hard ban. Read the rules block again." |
| Two failed attempts at the same fix | Thrashing | "Stop. Report what you tried and what you learned." |

---

*v4 · 2026-09-01 · Built for one developer with Claude Code, with DESPL-320 shipping on the system. If either constraint changes, Gate 2 moves ahead of Gate 1 and this file needs re-sequencing.*
