# Process route authoring — design spec

**Date:** 22 Aug 2026
**Status:** approved design, not yet implemented
**Companion spec:** `2026-08-22-job-intake-design.md`. That spec builds the
"new project" wizard; this one removes the reason the wizard can only offer
one product family. They are independent builds — route authoring has no
schema change and can land first — but job intake's family dropdown stays
one item long until this ships.

---

## 1. Problem

A job pins a `ProcessTemplateVersion` at creation and materialises its own
copy of that route into `JobProcess` / `JobProcessEdge`. Everything
downstream — scheduling, gating, the Stage Spine, department workspaces,
QCP process links — reads from that copy. No route, no job.

Today the tenant has four product families and effectively one usable route:

| Family | Template | Version status | Usable? |
|---|---|---|---|
| `PRESSURE_VESSEL` | "DESPL standard pressure vessel — Lead Time table" | `PUBLISHED` v1, 36 processes with real durations | Yes |
| `PIPE_SPOOL` | "provisional route (derived from QAP…)" | `DRAFT`, every process `provisional: true`, all durations null | No — deliberately |
| `HEAT_EXCHANGER` | none | — | No |
| `PIPING_SYSTEM` | none | — | No |

The only way a route has ever entered this database is `prisma/seed.ts`
reading a JSON file. The one authoring path that exists in the app —
`admin.service.ts::updateStandardDurations` — edits durations on an existing
version and nothing else: it cannot add a process, remove one, change a
department, or touch an edge.

So DESPL cannot take a heat-exchanger order in this system without a
developer writing a seed file and running a migration. That is the blocker.

**Goal:** a Production Head or Admin can define, review and publish a
process route for a product family from inside the app, with the same
versioning discipline the schema already enforces, and with validation that
refuses a route the scheduling engine would choke on later.

## 2. Goals and non-goals

**Goals**

- Author a new route for a family that has none, by cloning an existing
  published route and editing it — the realistic path, since nobody types 36
  processes from a blank page.
- Edit processes (seq, code, name, owning department, durations, envelope
  offsets, `optional`, `provisional`) and edges (predecessor, type, lag) of a
  `DRAFT` version.
- Publish a draft, at which point it becomes immutable and available for jobs
  to pin.
- Refuse, at publish time, any route the schedule engine cannot process —
  with a stable error code and a sentence naming the offending process.
- Warn, at publish time, about a route that will publish successfully but
  produce `SCHEDULE_DATA_MISSING` for every job that pins it, or whose
  computed envelope contradicts a printed one.

**Non-goals**

- Editing a `PUBLISHED` version in place. Invariant #9 — edits create a new
  version. Running jobs keep their pinned version forever.
- Retro-fitting an existing job onto a newer template version. A job's
  `JobProcess` rows are its own copy by design; changing a template never
  reaches back into a live job. A "re-pin job to newer route" flow is a
  separate feature with its own gating questions and is out of scope.
- Authoring QCP templates, route templates (`RouteTemplate` / `RouteStep`,
  the component-level library), or work calendars. Different objects,
  different screens.
- Importing a route from a spreadsheet or PDF. Clone-and-edit covers the
  real case; an importer can come later if DESPL hands over documents in a
  consistent shape.
- Any change to `lib/schedule/`'s existing modules. This spec consumes them
  as validators and modifies none of them. It does add one new pure sibling
  module, `lib/schedule/validate.ts` (§3), which nothing existing imports.

## 3. What already exists and gets reused

The schema needs **one additive column** (`ProcessTemplateVersion.updatedAt`,
for the optimistic lock in §4.3) and nothing else. Every table this feature
writes already exists and is already the right shape:

- `ProcessTemplate` — one per (family, name)
- `ProcessTemplateVersion` — `version`, `status` (`DRAFT` | `PUBLISHED`),
  `publishedAt`, `publishedBy`, `notes`
- `TemplateProcess` — the 20-odd columns a route row needs, including the
  deliberately-nullable `durationMinDays` / `durationMaxDays` paired with
  `provisional`, and the `workOrderStages Int[]` crosswalk
- `TemplateEdge` — `processId`, `predecessorId`, `type`, `lagDays`, with
  `@@unique([processId, predecessorId])`

Two existing pieces of code do most of the work:

**`admin.service.ts::updateStandardDurations` (line 254)** is already a
complete copy-on-write versioner: it loads a source version with its
processes and edges, computes `nextVersion`, creates the new version,
re-creates every process while carrying an `oldToNewProcessId` map, then
re-creates every edge through that map — all inside `audited()`. The clone
operation in this spec is that function with the duration-edit logic removed
and `status: "DRAFT"` instead of `PUBLISHED`. Extract the copy loop into a
shared helper rather than writing it twice.

**`lib/schedule/envelope.ts::computeEnvelope`** is reused directly as the
duration/envelope validator — publish runs the draft through it and reports
what it says, so "schedulable" means "the actual engine accepts it" rather
than a second, drifting reimplementation of the same rules.

Graph validation needs one new pure module, `lib/schedule/validate.ts`.
`cpm.ts` already contains Kahn's algorithm, but its `topologicalOrder` is
private and throws a bare `Error` with no node identity — it exists to guard
an invariant on a hot path, not to explain a problem to a person. Publish
needs the opposite: never throw, and name every offending process. Rather
than loosen `cpm.ts`'s guard, add a sibling that computes the same in-degree
pass once and *returns* diagnostics (dangling edges, self-edges, cycle
members, roots, terminals, unreachable nodes). Both are ~20 lines of Kahn's;
they have genuinely different contracts, and merging them would make the
scheduling hot path do reporting work it never needs.

## 4. Service layer

New file `src/lib/services/template.service.ts`. Four exported functions,
all `requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)`,
`assertNotClientUser`, wrapped in `withTenant` and `audited`.

`updateStandardDurations` stays where it is. It is a narrower, already-tested
contract (edit durations → publish immediately) and the Task 4.1 precedent in
this codebase is to keep materially different creation paths as separate
exported functions rather than merging them behind flags.

### 4.1 `createTemplate(actor, { familyId, name })`

Creates a `ProcessTemplate` plus an empty `version: 1`, `status: DRAFT`.
Returns the version. Used only when a family has no template at all; the
editor then starts from an empty process list, and the UI steers toward
`cloneVersion` instead wherever a published route exists.

Refuses if `familyId` is not in the actor's tenant (`NOT_FOUND`).

### 4.2 `cloneVersion(actor, { sourceVersionId, targetFamilyId?, name?, notes })`

The primary authoring path. Deep-copies a version's processes and edges into
a new `DRAFT`.

- **Same template** (no `targetFamilyId`): new version = `max(version) + 1`
  on that template. This is "revise the pressure-vessel route".
- **Different family** (`targetFamilyId` given): creates a *new*
  `ProcessTemplate` under that family with the supplied `name`, and the clone
  becomes its `version: 1`. This is "start the heat-exchanger route from the
  pressure-vessel one".

Copies every `TemplateProcess` column verbatim, including `provisional` and
`workOrderStages`. Deliberately verbatim: a cloned route's durations are the
*source's* durations, and if they do not apply to the new family the author
must change them or mark the process `provisional`. Silently nulling them on
clone would hide that decision.

Edges are re-created through an `oldToNewProcessId` map, same as
`updateStandardDurations` does.

Refuses: source not in tenant (`NOT_FOUND`); target family not in tenant
(`NOT_FOUND`).

### 4.3 `saveDraftVersion(actor, { versionId, processes[], edges[] })`

Full replace of a draft's contents — delete all `TemplateProcess` and
`TemplateEdge` rows for the version, re-insert from the payload. `TemplateEdge`
has `onDelete: Cascade` on `processId`/`predecessorId`, so deleting processes
takes the edges with them.

Full replace rather than a per-row diff API is the deliberate call: the editor
is a spreadsheet-shaped screen where an author reorders, renumbers and
rewires in one pass, and a diff protocol for that is more code and more ways
to end up half-applied. The cost is that concurrent editors clobber each
other, which is addressed below.

Payload processes carry a client-supplied stable `key` (string) so edges can
reference processes that do not have database ids yet. The service maps
`key` → new id after insert, then inserts edges. A `key` appearing in an edge
but not in `processes` is `SCHEDULE_GRAPH_INVALID`.

**Refuses if the version's `status` is not `DRAFT`** — `TEMPLATE_VERSION_LOCKED`.
This is invariant #9 at the service layer, not the UI.

Save-time validation is intentionally thin — an author mid-edit is allowed to
have a broken graph. Only structural impossibilities are rejected here:
duplicate `code` within the version (violates `@@unique([versionId, code])`),
duplicate `seq`, an edge whose two endpoints are the same process, a
`defaultDepartmentId` not in the tenant. Everything else waits for publish.

**Concurrency:** the version row gets an optimistic-lock check. The editor
sends the `updatedAt` it loaded; if the row has moved on, refuse with
`STALE_WRITE` rather than overwriting. `ProcessTemplateVersion` has no
`updatedAt` column today — this is the one schema addition this spec needs,
a nullable `updatedAt DateTime? @updatedAt`, which is additive and needs no
backfill. (Two Production Heads editing the same draft simultaneously is
unlikely but the failure mode — one author's whole pass silently vanishing —
is bad enough to be worth one column.)

### 4.4 `publishVersion(actor, { versionId, notes, acknowledgedWarnings[] })`

Validates, then sets `status: PUBLISHED`, `publishedAt: new Date()` (server
clock — invariant #1), `publishedBy: actor.userId`, `notes`.

**Blocking checks** — any failure refuses the publish:

| Check | Error code |
|---|---|
| Version is `DRAFT` | `TEMPLATE_VERSION_LOCKED` |
| At least one process | `TEMPLATE_INCOMPLETE` |
| Every `code` unique, every `seq` unique and contiguous from 1 | `TEMPLATE_INCOMPLETE` |
| Every process has a `defaultDepartmentId` resolving in-tenant | `TEMPLATE_INCOMPLETE` |
| Every edge's endpoints belong to this version, and no edge points at itself | `SCHEDULE_GRAPH_INVALID` |
| Graph is acyclic | `SCHEDULE_GRAPH_INVALID` |
| At least one root (process with no predecessors) | `SCHEDULE_GRAPH_INVALID` |
| Every process is reachable from some root | `SCHEDULE_GRAPH_INVALID` |

**Dead-end processes are NOT a blocking check, and this was verified against
the real data before it was written down.** The shipped `PRESSURE_VESSEL` v1
route — the authoritative one, seeded from DESPL's own Lead Time table — has
**one root and three terminals**: process 36 "Dispatch" plus processes 5
"Client Drawing Approval" and 6 "BOM & MTO Finalization", both of which
legitimately end their own branch without feeding a successor. A rule
requiring a single terminal would refuse to publish the only route in the
system that works. Multiple terminals is a **warning** (below), never a
refusal.

The check that does the real work is reachability: a process no root can
reach will never be gated into starting and will sit `NOT_STARTED` forever.
That is always a wiring mistake, and unlike a dead end it has no legitimate
form.

Every blocking error carries the offending process `code` and `name` in the
`AppError`'s `detail` object (the field is `detail`, singular — see
`errors.ts`), so the UI can say "Process 14 'PWHT' cannot be reached from the
start of the route" rather than "invalid graph".

**Non-blocking warnings** — publish proceeds, but the UI must show them and
the caller must echo them back in `acknowledgedWarnings` to confirm they were
seen:

| Warning | Why it is not blocking |
|---|---|
| ≥1 process is `provisional`, or has a null `durationMinDays`/`MaxDays` | A route with a real sequence but unconfirmed durations is legitimately publishable — it drives gating, the Stage Spine and department workspaces perfectly well. It just cannot be scheduled. `computeEnvelope` will refuse with `SCHEDULE_DATA_MISSING` for any job that pins it, and the author needs to know that now, not when a planner hits it. |
| Computed envelope total differs from a printed/expected total the author entered | Invariant #10's tripwire. Naive duration summing gives 11.6–24 weeks against DESPL's stated ~17. If the author enters an expected total and the engine computes something far off, the lags are wrong. Surfacing this *before* a job pins the route is the entire point. |
| More than one terminal process (no successor) | Legitimate — the real PV route has three. But an accidental dead end looks identical to a deliberate one, so the author is shown the list and confirms it. |
| ≥1 process has empty `workOrderStages` | Only meaningful for pressure vessels; empty is correct for families with no 25-stage reporting view. Informational. |

The envelope warning runs `computeEnvelope` against the draft's processes and
edges and reports the terminal process's finish offset in days. When any
duration is null the engine refuses, so this warning is skipped in favour of
the provisional one — they never both fire.

### 4.5 New error codes

Added to `src/lib/shared/errors.ts` (append only, never rename — the file
says so at the top):

- `TEMPLATE_VERSION_LOCKED` — "This template version is published and cannot
  be changed. Create a new version to make edits."
- `TEMPLATE_INCOMPLETE` — "This route is missing required information and
  cannot be published yet."
- `STALE_WRITE` — "Someone else changed this while you were editing. Reload
  and reapply your changes."

`SCHEDULE_GRAPH_INVALID` and `NOT_FOUND` already exist and are reused as-is.

## 5. Read layer

New `src/lib/services/template.read.ts`:

- `loadTemplateIndex(actor)` — families with their templates, each template's
  versions (version, status, publishedAt, process count, and a count of jobs
  pinned to it). The job count is what tells an admin whether a version is
  load-bearing.
- `loadTemplateVersion(actor, versionId)` — the version with its processes
  (joined to department name) and edges, plus `updatedAt` for the optimistic
  lock, plus `editable: status === "DRAFT"`.
- `loadDepartments(actor)` — for the department dropdown. May already be
  satisfied by `departments.read.ts`; check before adding.

## 6. UI

Two screens under the existing `/admin` shell, following the dense-table
conventions in `DESIGN_SPEC.md`.

### 6.1 `/admin/templates` — index

Grouped table, one group per product family. Columns: template name, version,
status chip (`PUBLISHED` → `--s-complete`, `DRAFT` → `--s-idle`), process
count, jobs pinned, published date, published by.

Row actions: **Open** (draft → editor; published → read-only view),
**Clone to new draft**, **Clone to another family**.

Empty state for a family with no template: one sentence plus one action —
"No process route defined for Heat Exchangers. Clone one from an existing
family to get started."

### 6.2 `/admin/templates/[versionId]` — editor

Header: family · template name · version · status chip · Save draft ·
Publish. Published versions render the same table read-only with no Save
or Publish, and a note saying which version supersedes this one if any.

**Processes table** — 36 rows on the pressure-vessel route, so density and
tabular numerals matter. Columns: drag handle (seq) · code · name · main
activities · department (select) · duration min/max days · envelope
start-by min/max · envelope finish-by min/max · optional (checkbox) ·
provisional (checkbox) · work-order stages · row delete. Add-row at the
bottom. Reordering renumbers `seq` contiguously.

**Edges table** — process · predecessor (select, restricted to processes in
this version) · type (`ProcessEdgeType`) · lag days. Negative lag is
legitimate and the column help text says so: it means concurrent start, and
it relaxes the schedule only, never gating (invariant #11).

Save is explicit, not autosave — the payload is a full replace, and autosaving
a half-rewired graph on every keystroke is how you lose an afternoon's work
to a stale-write refusal.

**Publish dialog** — runs validation server-side and shows two lists:
blocking errors (publish button disabled, each naming its process) and
warnings (each with a checkbox the author ticks to acknowledge). A mandatory
`notes` field, stored on the version, records why this version exists. That
field is what an auditor reads in six months.

### 6.3 Entry point

"Process routes" link in the admin nav, visible to ADMIN and PRODUCTION_HEAD
only.

## 7. Testing

Per CLAUDE.md, changes touching gating, RBAC and audit paths need
table-driven tests for the violation cases. `template.service.test.ts`:

**RBAC**
- SUPERVISOR / QC / MANAGEMENT / client user → `FORBIDDEN` on all four functions
- ADMIN and PRODUCTION_HEAD → allowed
- Cross-tenant `sourceVersionId` → `NOT_FOUND`, not a leak

**Versioning (invariant #9)**
- `saveDraftVersion` against a `PUBLISHED` version → `TEMPLATE_VERSION_LOCKED`
- `publishVersion` against an already-`PUBLISHED` version → `TEMPLATE_VERSION_LOCKED`
- `cloneVersion` on the same template → `version = max + 1`, source untouched
- `cloneVersion` to another family → new template, `version = 1`, process and
  edge counts equal the source's
- Jobs pinned to the source version still resolve the source version after a
  clone and a publish

**Publish validation** — one case per blocking row in §4.4, each asserting the
error code *and* that `details` names the offending process code:
- empty version, duplicate code, duplicate seq, non-contiguous seq
- edge referencing a process from a different version
- a two-process cycle, and a longer cycle that only Kahn's algorithm catches
- a graph of nothing but a cycle, so there is no root at all
- an orphan process unreachable from any root
- a self-edge (process is its own predecessor)

Plus the regression that motivated the rule change: **the real seeded
`PRESSURE_VESSEL` v1 route publishes cleanly**, with its one root and its
three terminals (36 Dispatch, 5 Client Drawing Approval, 6 BOM & MTO
Finalization) producing the multiple-terminals *warning* and no blocking
error. If a future validation change breaks this test, the validator has
become stricter than DESPL's own process.

**Publish warnings**
- a version with one `provisional` process publishes, and returns the
  provisional warning
- a version with all durations present returns an envelope total, and the
  total matches what `computeEnvelope` returns for the same input

**Audit**
- each of the four functions writes exactly one `audit_log` row in the same
  transaction, with `before`/`after` populated
- a forced failure inside the transaction rolls back both the template rows
  and the audit row

**Concurrency**
- `saveDraftVersion` with a stale `updatedAt` → `STALE_WRITE`, draft unchanged

`cpm.test.ts` and `envelope.test.ts` already cover the engine itself; these
tests assert the service reports what the engine says, not that the engine is
right.

## 8. Risk: this screen makes it easy to invent lead times

DESPL has no heat-exchanger lead-time document. This feature hands someone a
text box where a duration goes. Typing a plausible number into it produces
exactly the failure invariant #10 exists to prevent — a schedule that looks
authoritative and is fiction — only now with a nicer interface and no seed
file to review.

The schema anticipated this: `provisional` exists precisely to say "the
sequence is real, the durations are not confirmed", and `lib/schedule/` already
refuses to plan around a provisional process rather than guessing. This spec's
job is to make the UI respect that rather than route around it:

- New rows default to `provisional: true` with null durations. The author
  clears the flag deliberately, per process.
- Clearing `provisional` on a row with null durations is rejected client-side
  and server-side — the flag and the data must agree.
- The publish dialog states plainly which processes are provisional and that
  jobs pinned to this route will not schedule.
- The version `notes` field is mandatory on publish, and the placeholder text
  asks for the source document.

None of that stops a determined person from typing numbers. It does mean the
route carries an honest record of where its numbers came from, which is what
makes the refusal explainable later.

## 9. Sequencing

1. `updatedAt` column on `ProcessTemplateVersion` (additive migration)
2. New error codes
3. Extract the copy-on-write loop from `updateStandardDurations` into a shared
   helper; re-run its existing tests unchanged
4. `template.service.ts` — clone, save, publish, with tests
5. `template.read.ts`
6. `/admin/templates` index
7. `/admin/templates/[versionId]` editor + publish dialog
8. Acceptance pass: clone the PV route to `HEAT_EXCHANGER`, edit it down to a
   heat-exchanger sequence, publish it with every process `provisional`,
   confirm a job can pin it and that scheduling that job returns
   `SCHEDULE_DATA_MISSING` with a clear message rather than a guessed date

Steps 1–4 are the load-bearing half. Job intake can begin as soon as step 4
lands, since it only needs published versions to exist.
