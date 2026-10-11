# PROMPTS — Copy-Paste Development Prompts (v3)

**v3:** rewritten after an independent review found two dangerous gaps (no database safety rules; the backup-restore prompt handed a production account to an agent), a CI deadlock in B10, an unverifiable acceptance criterion in B7, and several missing guardrails. Changes are marked **[v3]**.

**How to use:** paste §2 (the rules block) and your item prompt **together, as one message**. Don't do a two-step handshake — it wastes context before the agent knows what it's building.

---

## 0. Running these — Claude CLI and Antigravity

### Claude CLI

```bash
cd ~/"AI DEVELOPMENT DESPL/DESPL/DESPL TRACKER"
claude
```

*(The tilde must sit outside the quotes or it won't expand.)* **[v3]**

| Command | Use |
|---|---|
| `/model opus` | Specs, design decisions, reviewing a large diff |
| `/model sonnet` | The coding itself (your `CLAUDE.md` convention) |
| `/clear` | **Between items.** A fresh context per item is the biggest quality lever you have |
| `Esc` | Interrupt the moment it strays outside the item |

**One item per session.** When an item merges, `/clear` and start clean.

### Antigravity

Same prompts, same discipline. Open the repo as the workspace so the agent sees `CLAUDE.md` and `docs/mos-blueprint/`. If it runs agents in parallel, keep them on **different phases from different tracks** (platform vs product per `22`) — never two items in the same files. Its plan artifacts don't replace `progress.md`; log there too.

### One-time setup

```
Add this to CLAUDE.md, right after the "What this project is" section. Nothing else changes.

> **Active development plan:** `docs/mos-blueprint/START-HERE.md`. Work items come from
> `docs/mos-blueprint/execution/22_DESPL_MOS_BUILD_PLAN.md`; how the work runs is
> `execution/23_DESPL_MOS_EXECUTION_PLAYBOOK.md`; what the plan does not cover is
> `execution/24_DESPL_MOS_PLAN_GAPS.md`. Domain reference is `reference/01`–`20` — read on
> demand, never front to back.

Show me the diff before writing it.
```

---

## 1. Before your first session — three human tasks

1. **Open Railway.** Which branch does production deploy from? (Item A1.)
2. **Decide the fork** (0.8): management demo soon, or proving the MOS thesis? §3.
3. **Send SJ the Phase L questions** (§4). These run on DESPL's calendar — start now.

---

## 2. RULES BLOCK — paste this above every item prompt

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
- Reuse an existing error code from src/lib/shared/errors.ts (48 exist). If none fits, say so
  before inventing one.
- No literal "DESPL-320", family code, or department code anywhere in src/. seed/, scripts/,
  prisma/ and test fixtures may use them.
- No client-supplied timestamps. Server clock only (invariant #1).
- Changes to state machine, gating, RBAC or audit paths require table-driven tests for the
  VIOLATION cases, not just happy paths.

=== THIS REPO RUNS AHEAD OF ITS DOCS ===
Three capabilities were documented as missing when they were already built (material gating,
the DESPL-320 literal removal, the entire client portal). Before concluding something doesn't
exist: grep src/, and grep progress.md.
progress.md is 476KB — NEVER read it whole. Use grep with a specific term piped to head -50.
If a grep returns more than 50 lines, narrow it.

=== IF YOU DISAGREE ===
If you think an instruction is wrong, say so and STOP. Do not implement what you think I
meant. If a file I told you to read doesn't exist, STOP and tell me — do not proceed without it.

Now, before touching anything: quote invariants #1, #4 and #9 back to me verbatim from
CLAUDE.md, and paste the first line of src/lib/shared/errors.ts. Then do the item below.
```

**[v3]** The closing line replaces "confirm you've read the invariants" — a model will confirm that unconditionally. Quoting actual file content fails loudly if the files weren't read.

---

## 3. Order of phases

| Situation | Order |
|---|---|
| **Management demo within ~6 weeks** | L ∥ (0 → A → B → **G** → C → D → E → rest) |
| **Proving the MOS thesis** (recommended) | L ∥ (0 → A → B → **C** → D → E → F → G → H → I → J → K) |

`L ∥` = Phase L runs in parallel from day one. L1 (working vs calendar days) changes every computed date; L3 (department supervisors) blocks Phase E's routing; L5 (welder list, joint numbering) blocks real production use.

Phases M and N run alongside from ~Phase D. They're calendar work, and starting them late is the standard way a project like this fails *after* the code is finished.

---

## 4. PHASE L — Business inputs *(start this week)*

```
Task: produce a decision document to send to DESPL (SJ). Writing only — modify no source file.

Read: docs/BUILD-SPEC-v2.md §7 (the C1-C27 open questions, each with its current default),
docs/mos-blueprint/execution/24_DESPL_MOS_PLAN_GAPS.md §2, and CLAUDE.md's "Pending inputs
from DESPL".

Produce docs/DESPL-OPEN-QUESTIONS-FOR-SJ.md. For each still-open question:
1. The question in plain business language — no schema names, no code references.
2. What the system currently assumes.
3. What changes if the answer differs — concretely, using the real numbers already in
   BUILD-SPEC §7 ("DE0467 reads as 22 days short instead of 14").
4. Urgency, and what it blocks.

Order by impact, not C-number: C1, C9, C21, C22, C23, C7, C27 first.
Add a short section on outstanding master data: welder list, weld-map joint numbering,
department supervisors and representatives.

Under three pages. A document SJ won't finish gets no answers, and answers are the point.
```

---

## 5. PHASE A — Deploy truth

**A1, A2, A3, A5 are yours** — dashboard checks and a decision.

```
Work item: [A4] Establish the test and lint baseline on the canonical branch.

The canonical trunk is now: <<<"main" OR "demo">>>

1. Confirm we're on that branch and the tree is clean.
2. Run, and paste the FULL literal output of each:
   pnpm install
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm test:db
3. Report the exact numbers you observed. Do not tell me what you expected to see — I have
   the expected figures and will compare them myself.
4. Do NOT fix anything. Do not modify any file. Report only.

If something fails, describe the failure precisely without diagnosing it yet.
```

**[v3]** The old version pre-supplied the expected numbers and a likely diagnosis, which anchors an agent into reporting the expected result. Give it those in your *second* message, after you have raw output. `pnpm test:db` added — the phase-exit checklist requires it.

---

## 6. PHASE B — Truth in docs, and kill the literals

### B10 — the literal guard, warn-only first **[v3 — rewritten]**

```
Work item: [B10] CI guard against DESPL-320 / family / department literals in src/.

Read: docs/mos-blueprint/execution/22_DESPL_MOS_BUILD_PLAN.md Phase B, and
docs/ADR-product-family-agnostic-platform-v1.md (the rule this enforces).

Build a check that detects these as string literals under src/:
- "DESPL-320" or any job-number literal of that shape
- Family codes: PRESSURE_VESSEL, HEAT_EXCHANGER, PIPE_SPOOL, PIPING_SYSTEM
- Department codes used as lookup literals: FABRICATION, PAINTING, QC, STORES, etc.

Must NOT match: seed/, scripts/, prisma/, *.test.ts fixtures, and comments citing DESPL-320
as a worked example — there are legitimate ones in bom.read.ts and workspace.read.ts. Read
those two, then recommend: allow comments generally, or allowlist those files?

CRITICAL — how this lands in CI:
Known violations still exist in src/ right now and will be removed one at a time by separate
PRs (items B3-B7). So:
1. Create docs/known-literal-violations.txt listing each current violation as file:line:token.
2. The check FAILS only on a violation NOT in that file. Existing ones print as warnings.
3. Each of B3-B7 must DELETE its own line from that file as part of its PR.
4. Add a final check that fails if the file is non-empty at the end of Phase B — so the
   allowlist cannot quietly become permanent.
This keeps CI green per-PR while making the rule real. Wire it into the existing GitHub
Actions pipeline (lint → typecheck → test → build).

Do NOT tune the matcher toward an expected count. Report EVERY match you find, with
file:line, and I will compare against my own list. More or fewer than I expect both mean the
matcher is wrong — I need your honest output, not a number that matches mine.

Then document a suppression mechanism for legitimate future cases, so nobody disables the
whole rule to get past one line.
```

### B1 + B2 — documentation drift (three corrections)

```
Work items: [B1] and [B2]. Documentation only. No code changes.

Three claims in this repo's own docs are false. VERIFY EACH against the code before writing
anything, and show me all three diffs before applying them.

(1) CLAUDE.md invariant #2 says material-dependency gating "is not implemented — do not
assume it exists". Read src/lib/services/_shared.ts's assertKitReady (~line 684) and its call
site in startComponentOperation. Rewrite the invariant to state what actually exists, at what
grain (component-operation, not stage), and what its silent no-op case is (BOM items with no
stock transaction history).

(2) docs/PHASE-PROMPTS.md §0 credits Phase 0 with removing the DESPL-320 literal from
src/app/(app)/workspace/page.tsx. Read lines 8-13. Mark the violation OPEN, reference B3.

(3) CLAUDE.md's "Deferred to Phase 2 — do NOT build yet" list includes "TPI/client portal
(Viewer role reserved)". It was built on 19 Aug. Verify: src/app/portal/page.tsx,
src/lib/services/client-snapshot.service.ts and client-snapshot.read.ts (both with tests),
the ProgressSnapshot publish/verify/reject workflow, and
docs/superpowers/specs/2026-08-19-client-portal-daily-updates-design.md. Move it out of the
deferred list; describe what exists, including that the portal reads only VERIFIED snapshots.

Change nothing else in either file.
```

### B3 — remove the DESPL-320 fallback

```
Work item: [B3] Remove the hardcoded DESPL-320 fallback from the workspace landing page.

Read src/app/(app)/workspace/page.tsx (pilotJobId, lines 8-13) and
docs/mos-blueprint/reference/01_DESPL_MOS_PRODUCT_DEFINITION.md §3.

Current: no ?job= param → falls back to findFirst({ jobNumber: "DESPL-320" }).
Required: no job-number literal anywhere; land the user somewhere sensible for THEIR tenant.

Propose your option BEFORE building — (a) job picker / empty state, (b) actor's most recently
active job, (c) tenant's most recently created active job. Consider a supervisor with three
active jobs, and a brand-new tenant with zero jobs.

Constraints: the ?job=<id> path keeps working exactly as today; the empty state is real (one
sentence + one action) per CLAUDE.md's no-dead-controls rule; delete this file's line from
docs/known-literal-violations.txt.
```

### B4 — un-hardcode the family in the admin durations screen

```
Work item: [B4] Remove the PRESSURE_VESSEL literal from the admin durations query.

src/lib/services/admin.read.ts ~line 63 hardcodes
  family: { code: "PRESSURE_VESSEL" }
so an admin whose tenant runs PIPE_SPOOL cannot reach their own duration editor at all.

Build: loadAdminView takes a familyId; a family selector listing families with at least one
template version; an empty state (not a blank panel) for a family with none. Decide and
justify the default selection.

Don't redesign the screen — this is parameterisation. Delete this file's line from
docs/known-literal-violations.txt.
```

### B5 + B6 — the two remaining code literals

```
Work items: [B5] then [B6]. In that order. Two separate commits.

B5 — src/lib/services/welding.service.ts:24 looks up the department by code:"FABRICATION"
and throws NOT_FOUND if a tenant's taxonomy differs. Weigh and recommend before building:
(a) resolve the department from the operation/component being welded, (b) a flag column on
Department, (c) a capability→department reference row. Prefer (a) — deriving beats
configuring. Tell me which and why first.

B6 — src/lib/services/component.service.ts has `if (operationCode === "PAINTING")` gating the
DFT rule. Replace with a declarative flag on OperationRef (already a tenant-scoped reference
table). Migration + backfill for the existing PAINTING row — hand-write the SQL, show me first.

Both: table-driven tests for the refusal cases. Delete both lines from
docs/known-literal-violations.txt.
```

### B7 + B8 — kill the 25-stage table **[v3 — acceptance fixed]**

```
Work items: [B7] and [B8] — make the Stage Spine derive from the job's actual route.

Read: docs/mos-blueprint/reference/07_DESPL_MOS_WORKFLOW_AND_ROUTING_MODEL.md §1,
src/lib/shared/stage-names.ts (hardcoded 25-name PV table), src/lib/services/workspace.read.ts
(STAGE_COUNT = 25), the <StageSpine /> component, and prisma/schema.prisma's TemplateProcess
(it already carries name + seq per family version).

Build:
1. Delete STAGE_NAMES and STAGE_COUNT.
2. Project the job's stages from TemplateProcess (name, seq) for its pinned templateVersionId.
3. <StageSpine /> takes the stage array as props — zero knowledge of any family or count.
4. Both sizes keep working: the 4px mini spine on job rows and in the job switcher, and the
   full interactive spine on the job page.

Out of scope: TemplateProcess.workOrderStages[] — that's B9.

VERIFICATION — read carefully:
No PIPE_SPOOL job exists yet. PIPE_SPOOL has no published template until Phase C, and no
confirmed durations, so cpm.ts would throw SCHEDULE_DATA_MISSING anyway. Therefore:
- Verify the PRESSURE_VESSEL path by loading a real job — it must render exactly as today.
- Verify the multi-family path with a synthetic test fixture using a second template version
  with a different process count and different names. A unit/integration test is the correct
  verification here.
- Do NOT seed a fake PIPE_SPOOL job to make a live check possible — that's outside this item.
- State plainly in your summary that live second-family verification is deferred to item J1.

NO schema change is needed. If you think one is, stop and tell me why.
```

---

## 7. PHASE C — Family / route / QCP bootstrap

### C — phase opener (paste once, on its own)

```
Starting Phase C — self-serve product-family bootstrap. This is what makes "a new product
family is data, not code" true.

Read, in order:
1. docs/mos-blueprint/reference/06_DESPL_MOS_PRODUCT_FAMILY_MODEL.md
2. docs/mos-blueprint/reference/07_DESPL_MOS_WORKFLOW_AND_ROUTING_MODEL.md §2, §5
3. docs/ADR-product-family-agnostic-platform-v1.md
4. docs/mos-blueprint/execution/22_DESPL_MOS_BUILD_PLAN.md — Phase C
5. Code: src/lib/services/template.service.ts, template.read.ts,
   src/app/(app)/admin/templates/, prisma/seed.ts, seed/component-routes.json

Answer before we build anything:
- Exactly what does prisma/seed.ts do to create a ProductFamily, a RouteTemplate, and a
  QcpTemplate? List the steps.
- Which of those already have a service function, and which have none?
- What does /admin/templates already do generically that we should extend, not duplicate?
- grep progress.md for partial work on this already.

No code this session. I want your reading of the current state.
```

### C1 — create a product family

```
Work item: [C1] createProductFamily service + admin UI.

Today a ProductFamily row can only be created by prisma/seed.ts.

Build: createProductFamily service function (say whether it belongs in admin.service.ts or a
new family.service.ts, and why); zod schema in src/lib/shared/schemas.ts; ADMIN-only role
gate; audit entry in the same transaction (invariant #5); admin UI to create and list
families.

Constraints:
- Family code follows the existing convention (UPPER_SNAKE), enforced in the schema, and is
  immutable after creation — existing seed data and template rows reference it by value.
  (This is data referencing it, not src/ — it does not conflict with the no-literals rule.)
- Refuse deletion of a family that has jobs, with an explainable error code.

Out of scope: the family readiness view — that's C8. Just list families here.
```

### C2 — template authoring **[v3 — split from C3]**

```
Work item: [C2] Author a ProcessTemplate + its first version from scratch.

/admin/templates already offers "clone from another family" — keep it. What's missing is
author-from-nothing, needed by the first family with no sibling to clone.

Build only the template + version shell: create a ProcessTemplate for a family, create its
first DRAFT version, list versions with status.

Constraints:
- Authoring happens only against a DRAFT version. A PUBLISHED version is immutable
  (invariant #9). If the UI lets anyone edit a published version, that is a P0 defect.
- Reuse TemplateStatus and template.service.ts's existing patterns — do not invent a parallel
  versioning mechanism.
- Reuse error codes: TEMPLATE_VERSION_LOCKED, TEMPLATE_INCOMPLETE, STALE_WRITE.

Out of scope: the process editor (C3) and edges (C4). Do not start them.
```

### C3 — process editor

```
Work item: [C3] TemplateProcess editor — add / edit / reorder processes in a draft version.

Depends on C2 being merged.

Each process needs: code, name, owning department, durationMinDays, durationMaxDays, and the
`provisional` flag.

CRITICAL — provisional durations are a feature, not an omission:
PIPE_SPOOL has real routes with NO confirmed durations, and cpm.ts's resolveDuration
deliberately THROWS (SCHEDULE_DATA_MISSING) rather than guess. Read it before building. The
editor MUST allow saving a process without durations, flagged provisional. Do not force a
number. Do not default to zero. Refusing to compute is correct behaviour, chosen on purpose.

Out of scope: edges (C4), publish validation (C5).
```

### C4 — the edge editor (hardest item in the plan)

```
Work item: [C4] TemplateEdge editor — the DAG. Depends on C3 being merged.

Read: src/lib/schedule/cpm.ts (topologicalOrder, and the forward-pass header comment),
src/lib/schedule/gating.ts (its header explains why edge TYPE matters and lag SIGN doesn't),
prisma/schema.prisma TemplateEdge + ProcessEdgeType.

Build an editor for predecessor edges: predecessor, type (FINISH_TO_START |
START_TO_START_WITH_OVERLAP), lagDays.

The hard part is validation TIMING, not UI. cpm.ts throws on a cycle (Kahn's algorithm), but
at SCHEDULE time. This item needs the cycle surfaced at AUTHOR time, pre-publish, naming the
offending path.

Call or extract the EXISTING cycle detection as a pure validation function over the draft
edge set. Do NOT write a second cycle-detection implementation — two will drift and one will
be wrong.

Also surface at author time: an edge referencing a process not in the version, and any process
unreachable from a start node.

Teach the distinction in the UI: an overlap edge with lagDays === 0 is still concurrent work.
Keying on lag sign instead of edge type is a real bug someone already reasoned about carefully
(see gating.ts's comment). Authors will get this wrong without help.

Acceptance: an author hits a deliberate cycle, sees a pre-publish error naming it, fixes it,
publishes.
```

### C5 — publish flow

```
Work item: [C5] Publish flow — validate completeness, then lock.

Read template.service.ts's publishVersion and the codes TEMPLATE_INCOMPLETE /
TEMPLATE_VERSION_LOCKED / TEMPLATE_VERSION_NOT_PUBLISHED.

A version cannot publish unless: every process has a department; every process has durations
OR is flagged provisional; the graph is acyclic (C4); there's at least one start and one
terminal process. Propose anything else you think belongs, with reasoning.

Publish is one-way. Show a pre-publish summary: process count, computed envelope length if
durations are complete, critical path, and any provisional processes that will make
scheduling refuse for jobs pinned to this version.

Acceptance: an incomplete template refuses with a message naming exactly what's missing — not
a generic validation error.
```

### C6 — route template authoring

```
Work item: [C6] RouteTemplate / RouteTemplateVersion / RouteStep authoring.

Created today ONLY by prisma/seed.ts from seed/component-routes.json. Zero service, zero UI.

Read: prisma/schema.prisma (RouteTemplate — @@unique([tenantId, componentTypeId, familyId])
with familyId NULLABLE, so a route can be family-specific or shared), seed/component-routes.json,
OperationRef.

Answer before building:
- What does nullable familyId mean in the UI? How does an author choose family-specific vs
  shared, and what warns them they're about to affect every family?
- How does an author add an OperationRef that doesn't exist yet? It's a tenant-scoped
  reference table, so inline creation should be possible.
- What is OperationRef.leadTimeProcessSeq and what breaks if it's set wrong?
  READ src/lib/services/_shared.ts:462-496 FIRST. That value is the numeric join reconciling
  execution to schedule, with NO foreign key enforcing it. Set it wrong and stage rollups
  break silently, with no error anywhere. The UI must make this hard to get wrong, or must
  validate it against the family's published template process codes.

That last point is the most dangerous thing in this phase. Give me your plan for it before
building anything.
```

### C7 — QCP authoring from scratch

```
Work item: [C7] Author a QcpTemplate from nothing.

cloneQcpTemplate can only COPY an existing QCP; a brand-new family has nothing to copy. The
ADR calls this "the honest gap".

Read: prisma/schema.prisma (QcpTemplate — jobId nullable makes a library row; QcpItem,
QcpItemProcess, QcpItemPartyCode, InspectionParty, QcpCodeRef), src/lib/services/qcp.service.ts,
the P/W/H legend in seed/.

Build service + UI to author a library QcpTemplate (jobId = null) with QcpItems carrying
inspection party codes (P/W/H) and mapping to template process codes.

Critical:
- QcpItemProcess maps by process CODE, not id — deliberately, so a job's cloned QCP survives
  template renumbering. Preserve that.
- H-coded items are hard blocks (assertNoOpenHoldPoint). W-coded waiver approval is NOT wired
  today (item G8). Don't build G8 here; don't make it harder either.
- Open question C7 in BUILD-SPEC-v2 §7 asks what RW and R&A mean and which block production.
  If unanswered, support both interpretations rather than hardcoding one, and flag it.
```

---

## 8. PHASE D — Document and file storage **[v3 — split, hard gate]**

**D1 is yours, not an agent's:** choose the S3-compatible provider, create the bucket, put the keys in `.env` and placeholders in `.env.example`. Then paste the bucket name into the prompt below.

### D-gate — run this BEFORE any schema work

```
Task: produce questions only. Do NOT propose a schema in this session. Do NOT write code.

Context: we are about to design document/file storage for a manufacturing QC system whose
records (MDRs, MTCs, QC certificates, inspection reports) are audited by third-party
inspectors and clients under ASME pressure-vessel practice. Item N6 in
docs/mos-blueprint/execution/24_DESPL_MOS_PLAN_GAPS.md flags that nobody has asked what
record-integrity, retention, or e-signature requirements those audits impose.

Read: docs/mos-blueprint/reference/12_DESPL_MOS_DOCUMENT_MODEL.md, and prisma/schema.prisma's
AssemblyDrawing / DrawingRevision and MaterialIdentification.

Output ONLY a numbered list of the questions I need answered by DESPL's quality lead or TPI
contact before the document model can be safely designed. For each: why it changes the design,
and what it would cost to retrofit later.

Stop after the list. Do not propose a schema, a model, or a migration.
```

### D2 + D3 — schema only, after the gate is answered

```
Work items: [D2] and [D3] — Document model and entity links. Schema only, no storage client.

TPI/ASME answers from DESPL: <<<PASTE THEM. If blank, STOP and tell me.>>>

Read: docs/mos-blueprint/reference/12_DESPL_MOS_DOCUMENT_MODEL.md, prisma/schema.prisma
(AssemblyDrawing / DrawingRevision — the revisioning pattern to copy), src/lib/db.ts
(withTenant, so you understand scoping).

Design the Document model + entity links (job, equipment, unit, componentOperation,
qcpExecution, drawingRevision, bomItem, ncr, dispatchBatch).

Constraints:
- Permissions inherit from the owning entity's scoping. Do NOT invent a new authorization
  concept — every document is reached through an already-scoped parent, the same convention
  _shared.ts uses for tables without their own tenantId.
- Document categories are a REFERENCE TABLE (DocumentCategoryRef), not an enum.
- Revisioning copies DrawingRevision's pattern: strictly increasing, prior flips to
  SUPERSEDED, nothing overwritten (invariant #6).
- Upload and download both write AuditLog entries in the same transaction.

Hand-write the migration SQL and show it to me. Do not apply it. Do not run any prisma
command except `prisma migrate diff`. STOP after showing me the schema.
```

---

## 9. PHASE E — Scheduler and delivery channel

```
Starting Phase E. Read reference/14_DESPL_MOS_MANAGEMENT_KPI_ALERT_MODEL.md §4-5, Phase E in
the build plan, and execution/24_DESPL_MOS_PLAN_GAPS.md §3 (items E9-E12).

Two facts: (1) the daily digest is a button someone presses; overdue/aged-hold alerts are
computed lazily on every authenticated page load — a full-table scan per page view the code's
own comment calls "fine at demo scale". (2) There is NO delivery channel of any kind — no
email, WhatsApp, SMS or SMTP anywhere. The digest payload is "email-ready jsonb" but nothing
sends it.

BLOCKED ON A BUSINESS ANSWER: item L3 / question C9 — department supervisors and
representatives. Notification routing has no target without it. If I haven't given it to you,
build against a configurable recipient list and say so; do not invent recipients.

Order within the phase:
1. E4 and E5 first — smallest, highest value. Filing a delay reason and opening an NCR notify
   NOBODY today; the notification layer exists and these two services simply never call it.
   Verify that's still true before building. These are in-app notifications and do not depend
   on E9.
2. E1 — scheduler infrastructure. Propose before building: Railway cron hitting a protected
   route, or BullMQ + Redis. No queue dependency exists today; one Railway environment; no
   staging. Simplest thing that reliably runs probably wins. Name the dependency before adding.
3. E9 — delivery channel. Propose email vs WhatsApp and ask me before committing. DESPL's
   supervisors live in WhatsApp and may never open a web app for a morning digest.
4. E2, E3 — move digest and alert reconciliation onto the scheduler.
5. E7 — make /alerts real (a "coming in R2" stub today; no dead controls).
```

---

## 10. PHASES F–K — phase openers

### F — delay propagation
```
Starting Phase F. Read reference/09_DESPL_MOS_SCHEDULING_MODEL.md §3 and Phase F in the plan.

Verify first: fileDelayReason has ZERO imports from the scheduling engine. Cascading
reschedule works, but only via manual applyDurationOverride. Nothing connects them.

We build auto-SUGGEST, not auto-apply (decision 0.4). The accountability model depends on a
named human owning a date change. Reduce friction, keep the approval.
```

### G — ship what's already built
```
Starting Phase G — UI for logic that already exists and is tested. Read Phase G in the plan,
reference/10 §6, reference/11 §3.

Dispatch, packing, NCR and paint/DFT have real, tested service layers and ZERO UI.

Do NOT rewrite the service layer. Read it, build UI that calls it. If you think a service
function is wrong, stop and tell me — don't change it inside a UI item.

One genuinely new piece of logic: G5. Dispatch gating runs one direction only —
addUnitToBatch refuses an unpacked unit, but NOTHING checks QC/NCR status before a unit is
packed or dispatched.
```

### H — isolation and integrity
```
Starting Phase H. Read reference/15 §4-5 and Phase H in the plan.

Verify two facts first:
1. Tenant isolation is DB-enforced (withTenant + RLS, fail-closed). Job-level isolation within
   a tenant is NOT — it rests on every service function remembering to filter by jobId. 44 of
   71 models carry no tenantId.
2. ComponentOperation/AssemblyStep reconcile to JobProcess by NUMERIC STRING EQUALITY
   (leadTimeProcessSeq == Number(jobProcess.code)) — no foreign key. See _shared.ts:462-496.

H2's sequence is strict and non-negotiable: backfill → verify zero violations → add
constraint. Three separate PRs in that order. Never add the constraint first. Hand-write every
migration and show me before applying.
```

### I — observability and scale
```
Starting Phase I. Read Phase I in the plan and reference/15 §5.

Every item here is already named in the team's own code comments — myday.read.ts and
command-center.read.ts admit their per-active-job loop; jobs.read.ts has a real N+1.

For I3/I4: a performance fix with no test regresses silently. Assert query count or page size,
not just correctness.
```

### J — second family (the real proof)
```
Starting Phase J — onboarding PIPE_SPOOL as the second product family.

THE RULE: zero code changes. If you need to change anything in src/ to onboard this family,
STOP and tell me immediately. That is a Phase C defect, not a Phase J task, and patching
around it destroys the only real proof this is a platform.

Author PIPE_SPOOL through the Phase C UI: durations (from the L1/L5 answers), QCP, publish.
Then create a job and run the full lifecycle. This is also where B7's deferred live
second-family verification finally happens.
```

### K — procurement depth
```
Starting Phase K. Read reference/08 §5 and Phase K in the plan.

Key fact: there is NO vendor field anywhere in the 71-model schema, and no expected-delivery
date. "Delayed" is therefore UNCOMPUTABLE — no due date exists to compare against. K2 unlocks it.

Preserve the append-only event ledger (ProcurementEventType IS the status model, deliberately
— "no separate status enum to keep in sync"). Add fields and a grouping PurchaseOrder model;
do NOT add a mutable status column that can drift from the events.
```

---

## 11. PHASES M and N — adoption and operations

**N1 (backup restore drill) is a HUMAN task. Do not give it to an agent.** **[v3]** An agent cannot provision a scratch database, and a production Railway account plus "perform a restore" is how you get either an incident or — more likely — a convincing fabricated transcript that leaves you believing restore works when it's never been tested. An agent may write the runbook; you execute it, against a scratch project you created, and you paste the real `psql` output for the grants check.

### M6 — the plain-language refusal guide *(good agent task)*

```
Task: write a user-facing guide to every refusal the system produces. Documentation only.

Read src/lib/shared/errors.ts — all 48 codes and their user-facing messages.

Produce docs/USER-GUIDE-WHY-WAS-I-REFUSED.md. For each refusal a normal user can hit (skip
internal ones — list which you excluded and why):
1. What the user sees
2. What it means in plain language for a shop-floor supervisor or QC inspector — no schema
   names, no code references
3. What they should do
4. Why the system works this way, in one sentence. "The same person cannot submit and verify
   their own work" lands very differently from "MAKER_CHECKER_VIOLATION"

Group by who hits it: operator, supervisor, QC inspector, department head, admin.

This is the biggest source of early frustration in gated systems — people conclude the
software is broken when it's working exactly as designed. Write for someone who has never
seen the system and is annoyed.
```

### N1 — runbook only

```
Task: write a backup and restore RUNBOOK. Do not execute any part of it. Do not connect to
any database. Do not run railway link, railway connect, railway variables, or any command
that reads production configuration.

Produce docs/RUNBOOK-backup-restore.md covering:
1. What to check to establish current backup configuration (what I should look for in
   Railway, not what you found).
2. Step-by-step restore into a SEPARATE scratch project — exact commands, with placeholders
   for URLs I will fill in.
3. A verification checklist for the restored copy: does the audit trail survive intact? Do the
   RLS policies come back? Do the despl_web role grants (the REVOKE on audit_log and
   domain_events) come back? That last one matters most — if grants restore differently, the
   append-only guarantee is silently gone.
4. Where to record the measured recovery time.

I will execute this myself and paste the real output back to you.
```

---

## 12. Generic item prompt template

```
Work item: [<<<ID>>>] <<<TITLE FROM THE BUILD PLAN>>>

Read first:
1. docs/mos-blueprint/execution/22_DESPL_MOS_BUILD_PLAN.md — this item and its phase
2. docs/mos-blueprint/reference/<<<RELEVANT DOC>>>
3. The code it touches: <<<FILES>>>
If any of those paths doesn't exist, STOP and tell me.

Build ONLY this item. Do not refactor adjacent code or improve things you notice in passing —
list those at the end and I'll add them as new backlog items.

Acceptance criterion — the definition of done:
<<<COPY VERBATIM FROM THE BUILD PLAN>>>

Stop condition:
If building this as described would make the answer to "if we won an identical heat exchanger
tomorrow, what code changes?" anything other than "none", STOP and tell me before writing code.

At the end give me:
- The diff summary, file by file
- Which acceptance criterion you demonstrated, and the literal output proving it
- Anything you noticed but deliberately left alone
- A draft progress.md entry starting with the item ID
```

---

## 13. Review prompt — before every merge

```
/model opus

Run `git diff <<<main|demo>>>...HEAD` yourself and review it. Be blunt — I would rather hear
it now than find it in an audit in three weeks.

1. Does it actually satisfy this acceptance criterion? <<<PASTE IT>>>
2. Scope — is anything here NOT part of the item? Name it.
3. Invariants — any of CLAUDE.md's twelve violated? Check especially client timestamps,
   gating bypass, maker-checker, audit-in-same-transaction, template immutability.
4. Literals — any DESPL-320 / family / department code literal in src/?
5. Layering — direct Prisma call from a Server Action? Business rule outside src/lib/services/?
6. Error codes — new ones invented where an existing one fits?
7. Tests — were any existing tests deleted, skipped, or weakened? If this touched state
   machine / gating / RBAC / audit, are there table-driven tests for the REFUSAL cases?
8. Generality — does this make the heat-exchanger answer anything other than "none"?
9. What would a hostile reviewer say about this diff?
```

---

## 14. Phase-exit prompt

```
/model opus

Closing Phase <<<X>>>.

1. List every item in this phase and its actual status. Anything not closed — deferred with a
   reason, or forgotten?
2. Re-run the generality test against the phase AS A WHOLE. Individual items can each pass
   while their combination bakes in an assumption.
3. Run and paste literal output: pnpm lint && pnpm typecheck && pnpm test && pnpm test:db
4. Propose updated scores for affected rows in
   docs/mos-blueprint/execution/21_DESPL_MOS_MATURITY_SCORECARD.md, with justification. Be
   honest — a score that moved because we shipped something incomplete is worse than no score.
5. Draft the progress.md phase summary: what this phase changed about what the system can DO.
6. Next phase's first item, and anything now blocking it.
```

---

## 15. End-of-session prompt

```
Wrap up.
1. Write the progress.md entry — item ID, what shipped, decisions, blockers, next step.
   Match the existing format.
2. Anything left undone or deliberately skipped?
3. Anything that should become a new backlog item? Propose an ID in the right phase.
4. Any blueprint document now out of date? Say which and what changed — don't edit it.
```

---

## The rule behind every prompt here

> *"If we won an identical heat exchanger tomorrow, what code changes?"* — **none.**

Cheap to answer before implementation, expensive to discover after. It's the difference
between a platform and a pressure-vessel app, and it erodes the moment nobody asks.
