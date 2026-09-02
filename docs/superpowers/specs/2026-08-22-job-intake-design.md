# Job intake — new project creation — design spec

**Date:** 22 Aug 2026
**Status:** shipped — see `progress.md`'s 22 Aug 2026 session-log row (job-intake plan executed end to end, 11 tasks)
**Companion spec:** `2026-08-22-route-authoring-design.md`. Route authoring
removes the constraint that only pressure vessels have a usable process
route. This spec can be built and demoed against pressure vessels before
that lands; the family dropdown simply stays one item long until it does.

---

## 1. Problem

There is no way to add a project to this application.

Every job in the database exists because `prisma/seed.ts` created it —
DE0463 and DE0467 from the live CSV import, DESPL-320 from the QCP document
header. `src/app/api/jobs/route.ts` is `GET` only. There is no
`createJob` anywhere in `src/lib/services/`, no server action, no screen.
The `/jobs` page lists jobs and links to them; nothing creates one.

For a demo where "the whole team clicks through this build", the first
question anyone with authority asks is "so how do I put my next order in?"
and today the answer is "a developer edits a seed file". That is the gap.

Creating a job is also not a single insert. A usable job needs, in one
transaction: the `Job` row, its own materialised copy of the pinned template's
processes (`JobProcess`) and edges (`JobProcessEdge`), at least one
`Equipment`, its `Unit` serials, and an audit record. Getting any of that
wrong produces a job that renders in the list and then breaks on every screen
that reads the spine.

**Goal:** a Production Head or Admin can create a new project end to end from
inside the app — pick the equipment type, pick its process route, define the
equipment and serials, set the design configuration and the client's committed
date — and immediately see whether that date is achievable.

## 2. Goals and non-goals

**Goals**

- A guided create flow at `/jobs/new`, five steps, one transaction.
- An equipment master list, so the same equipment is described the same way
  every time it is ordered and its design defaults are not retyped.
- Separate the client's contractual date from the internal dispatch target.
  They are two different commitments and the app currently conflates them.
- Structured design configuration (pressure, temperature, MOC, capacity…)
  captured at intake instead of buried in `remarks`.
- Run the existing scheduling engine at the end of creation and show the
  feasibility verdict, so an unachievable commitment date is visible at
  intake rather than discovered in week nine.

**Non-goals**

- Editing a job after creation. This spec creates; a job-edit flow (with its
  own correction/versioning discipline per invariant #6) is separate.
- Full BOM entry inside the wizard. The BOM panel already exists
  (`src/components/industrial/bom-panel.tsx`, `bom.read.ts`, `bom-route.ts`)
  and is the right place for it. The wizard offers a copy-from-existing
  shortcut and nothing more.
- Authoring process routes — see the companion spec.
- Client onboarding beyond a name and code. `Client` has two meaningful
  fields; an inline create is enough.
- Deleting or cancelling a job. `JobStatus` exists; a lifecycle flow does not,
  and is out of scope.

## 3. Schema changes

One migration, four changes. All additive except one rename.

### 3.1 Equipment master

```prisma
model EquipmentTypeRef {
  id                Int      @id @default(autoincrement())
  tenantId          Int      @map("tenant_id")
  familyId          Int      @map("family_id")
  /// Stable short code, e.g. HP-AIR-RCVR-2000
  code              String
  /// Display name, e.g. "HP Air Receiver, 2000 L"
  name              String
  defaultDesignCode String?  @map("default_design_code")
  /// Family-shaped design defaults copied into Job.specs at intake.
  defaultSpecs      Json?    @map("default_specs")
  active            Boolean  @default(true)

  tenant     Organization  @relation(fields: [tenantId], references: [id])
  family     ProductFamily @relation(fields: [familyId], references: [id])
  equipments Equipment[]

  @@unique([tenantId, code])
  @@index([tenantId])
  @@index([familyId])
  @@map("equipment_type_refs")
}
```

Modelled on the existing `*Ref` tables (`ComponentTypeRef`, `OperationRef`,
`TestTypeRef`) — same tenant scoping, same `active` flag, same unique shape.

**It carries `tenant_id`, so it is a tenant-root table and MUST get a Row
Level Security policy in the same migration.** Every other `*Ref` table is in
the `tenant_tables` array of `20260813052000_rls_fail_closed`. A tenant-root
table with no policy is a silent cross-tenant read — precisely the gap the
init migration's own comment warns about. Follow the precedent set when the
welding module added `welders`
(`20260815130000_welding_module/migration.sql:129`):

```sql
ALTER TABLE "equipment_type_refs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "equipment_type_refs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);
```

Nothing currently *proves* that every `tenant_id`-bearing table has a policy —
`db-guard.ts` checks the connected role, not policy coverage. This work adds
that test: query `information_schema` for every table with a `tenant_id`
column and assert each has `rowsecurity = true` and a `tenant_isolation`
policy. It costs ~15 lines and closes this class of bug permanently rather
than one table at a time.

`Equipment` gains `equipmentTypeId Int?` — **nullable**, so the seeded DE0463
equipment blocks (created from CSV with free-text labels and no catalog entry)
remain valid without a backfill that would have to invent catalog rows.
`Equipment` itself is a job-child table and correctly has no RLS of its own —
it is reachable only through `jobs`, which does.

### 3.2 Job dates

`Job.deliveryDate` is doing two jobs. The CSV import maps the source's
*dispatch date* into it; `schedule.service.ts` treats it as the *required
delivery date* that BACKWARD scheduling back-counts from; `job-health.ts` and
the portfolio views measure lateness against it. Those are not the same date
in a real order.

- `deliveryDate` → **`committedDeliveryDate`**. The contractual date given to
  the client. This is what BACKWARD scheduling anchors on by default and what
  every overdue / KPI / forecast-vs-due calculation measures against.
- new **`targetDispatchDate DateTime?`** — the internal target, normally
  earlier, carrying DESPL's own buffer. Never shown to a client user.
- new **`specs Json?`** — design configuration, §5.4.

The rename is `ALTER TABLE jobs RENAME COLUMN delivery_date TO
committed_delivery_date` plus two `ADD COLUMN`s. Forward-only, no data loss,
no backfill.

Thirteen hand-written files reference the old name and need the mechanical
update: `workspace.read.ts` (9 refs), `job-health.ts` + its test,
`schedule.service.ts` (6), `jobs.read.ts` (5), `job-detail.read.ts` (5),
`portfolio.read.ts`, `client-snapshot.read.ts`, `override.service.ts`,
`schemas.ts`, `workspace.read.test.ts`, `jobs/[id]/_client.tsx`,
`dashboard/page.tsx`, `dashboard/_portfolio.tsx`, `jobs/page.tsx`, and
`seed.ts`. `src/generated/prisma` regenerates. Do this rename as its own
commit, with the test suite green, before any wizard code.

**Client visibility:** `targetDispatchDate` must not reach the portal.

The protection today is the **return type**, not the query.
`client-snapshot.read.ts:103` calls `tx.job.findMany` with no `select`, so it
loads the whole `Job` row including any column added to it; what keeps the
portal clean is that `ClientJobView` is a closed union with an explicit field
list, and each view object is built field by field. `targetDispatchDate`
therefore cannot leak through the type — but nothing *asserts* that, and no
field-list test exists to extend.

Two consequences for this work:

- The portal's `forecastDispatch` is currently sourced straight from
  `job.deliveryDate` (lines 141 and 200). After the split it must read
  `committedDeliveryDate`. Both call sites, not one.
- A new test must **add** the assertion that a `ClientJobView` contains no
  key outside its documented list. Written as a key-set comparison rather
  than a spot check, so any future column added to `Job` and accidentally
  spread into the view fails the test rather than reaching a client.

### 3.3 What is deliberately *not* added

No `EquipmentTypeRef` → template BOM. The heavier catalog (each type owning a
template BOM copied into new jobs) was considered and deferred: DESPL has not
handed over a per-equipment standard BOM, and the copy-from-existing-equipment
shortcut in §5.4 delivers most of the saving with none of the invented data.
`defaultSpecs` covers the design parameters, which *are* known per equipment
type.

## 4. Service layer

New `src/lib/services/job-intake.service.ts`.

### 4.1 `createJob(actor, input)`

`requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)`, `assertNotClientUser`,
inside `withTenant` and `audited` — one transaction for everything below.

Validation, before any write:

| Check | Error code |
|---|---|
| `jobNumber` unique within tenant | `VALIDATION_FAILED`, details naming the existing job |
| `clientId`, `calendarId`, `equipmentTypeId` resolve in-tenant | `NOT_FOUND` |
| `templateVersionId` resolves in-tenant **and** `status === "PUBLISHED"` | `TEMPLATE_VERSION_NOT_PUBLISHED` |
| Template version's `familyId` matches the submitted `familyId` | `VALIDATION_FAILED` |
| Every equipment type's `familyId` matches the job's family | `VALIDATION_FAILED` |
| `targetDispatchDate` ≤ `committedDeliveryDate` when both given | `VALIDATION_FAILED` |
| At least one equipment block, each with ≥1 unit | `VALIDATION_FAILED` |
| Serial numbers unique within each equipment block | `VALIDATION_FAILED` |
| `excludedProcessCodes` all exist in the template version | `NOT_FOUND` |

Refusing a `DRAFT` template at the service layer, not just by filtering the
dropdown, is the point of `TEMPLATE_VERSION_NOT_PUBLISHED` — the UI hiding an
option is not enforcement.

Then, in order:

1. `Job` — `publicId: randomUUID()` (the schema comment is explicit that
   sequential ids leak order volume), `familyId`, `templateVersionId` pinned,
   `calendarId`, all the order fields, `specs`.
2. `JobProcess` — `createMany` from the version's `TemplateProcess` rows,
   copying `seq`, `code`, `name`, `departmentId` from `defaultDepartmentId`,
   both durations, all four envelope offsets, `workOrderStages`, and
   `provisional`. `included: !excludedProcessCodes.includes(code)`.
   This is the loop `seed.ts` already runs at line 1040; lift it rather than
   rewrite it.
3. `JobProcessEdge` — `createMany` from `TemplateEdge`, mapped through a
   `code → new JobProcess.id` map built from a `findMany` on the rows just
   inserted. Edges are copied for *all* processes including excluded ones.
   `lib/schedule/exclude.ts::bypassExcluded` splices an excluded node out of
   the DAG by composing `lag = lagPX + duration(X) + lagXS` across it, so an
   excluded process must keep **both its edges and its durations** on the
   `JobProcess` row. Dropping either would silently treat it as taking zero
   days and drag every successor early — that function's own comment calls
   this invariant #10 territory.
4. `Equipment` per block, with `equipmentTypeId`, `name`, `blockNo`.
5. `Unit` — `createMany` from the generated serial list per block.
6. Optional QCP clone (§4.2).
7. Optional BOM copy (§4.3).
8. Audit: `action: "job.create"`, `entityType: "Job"`, `after` carrying
   jobNumber, family, template version, equipment and unit counts.
   `eventType: "JobCreated"`.

Returns the job id and public id. Scheduling is **not** part of this
transaction — see §4.4.

### 4.2 Optional QCP clone

If `qcpTemplateSourceId` is given, deep-copy that `QcpTemplate` — its
`InspectionParty` rows, `QcpItem` rows, and `QcpItemPartyCode` rows — onto the
new job, and rebuild `QcpItemProcess` links by matching the source's linked
process **codes** against the new job's `JobProcess` codes.

Code-matching is what makes this safe across template versions: if the source
QCP was built against a route where a process has since been renumbered, the
code still resolves. A source process code with no match in the new job is
skipped and reported in the result as a warning, not silently dropped — the
wizard's confirmation screen lists them.

A job with no QCP is legal. It simply has no hold points, so nothing blocks
process completion on quality grounds until one is attached. The review step
says so in plain words rather than leaving it implicit.

### 4.3 Optional BOM copy

If `copyBomFromEquipmentId` is given, copy that equipment's `BomItem` rows
(item no, block no, part name, description, material, qty, unit,
`componentTypeId`) into the new job's first equipment block.

Explicitly **not** copied: `Procurement`, `MaterialIdentification`, `Component`,
`ItemTest`. Those are execution records belonging to the source job — heat
numbers, MTC references, PO numbers. Copying them would fabricate traceability,
which is the exact opposite of what this system is for.

### 4.4 Scheduling after creation

`generateSchedule` already exists, already requires
`PRODUCTION_HEAD`/`ADMIN`, and already persists a `ScheduleRun` with its
`ProcessPlan` rows. The wizard calls it as a **separate call after** the
create transaction commits, not inside it.

That separation is deliberate. `computeEnvelope` refuses a provisional or
duration-less spine with `SCHEDULE_DATA_MISSING`, and that refusal must not
roll back a perfectly good job. A heat-exchanger job on a provisional route
is a legitimate thing to have — it tracks the order, gates its processes and
drives the Stage Spine; it just has no dates yet. Creating it and *then*
failing to schedule it is the correct outcome, and the wizard reports it as
"Job created. Dates cannot be computed yet because N processes have no
confirmed duration."

Mode: `BACKWARD` from `committedDeliveryDate` by default. The wizard offers a
"plan to the target dispatch date instead" toggle when `targetDispatchDate` is
set, which passes that date as `requiredDeliveryDate`. `generateSchedule`
already takes it as an input parameter — no engine change.

When the run comes back `INFEASIBLE`, the wizard shows the shortfall in days
prominently. This is the feature's real payoff: the moment someone types a
committed date the schedule cannot meet, they find out at intake, before the
commitment is made.

### 4.5 `createEquipmentType` / `updateEquipmentType` / `setEquipmentTypeActive`

Plain CRUD in `admin.service.ts` alongside the existing
`createDelayCategory` / `updateDelayCategory` pair, which they mirror exactly.
`ADMIN` and `PRODUCTION_HEAD`. Audited. Deactivate rather than delete —
`Equipment` rows reference these.

### 4.6 `createClient`

Inline client creation from step 1. Name plus optional code, tenant-scoped,
`@@unique([tenantId, code])` enforced. Audited. `ADMIN` and `PRODUCTION_HEAD`.

Existing clients are not editable from here.

### 4.7 New error codes

Appended to `src/lib/shared/errors.ts`:

- `TEMPLATE_VERSION_NOT_PUBLISHED` — "This process route is still a draft and
  cannot be used for a job. Publish it first."
- `DUPLICATE_JOB_NUMBER` — "A job with this number already exists."

## 5. The wizard — `/jobs/new`

Five steps. State lives in the URL query string, not `localStorage` (banned
by `DESIGN_SPEC.md`), so a refresh or a back-button press keeps the work.
Nothing is written until step 5.

### 5.1 Step 1 — Order

Client (searchable select over `clients`, with an inline "Add client" that
calls §4.6) · job number · client order number · PO reference · project name ·
order date · **committed delivery date** · **target dispatch date** ·
priority · work calendar.

The two date fields sit adjacent with help text distinguishing them: the
committed date is what the client was promised and what lateness is measured
against; the target is DESPL's internal aim. Native `<input type="date">`.

Job number uniqueness is checked live against the tenant, but re-checked
server-side in the transaction — the live check is a courtesy, not the
enforcement.

### 5.2 Step 2 — Equipment type and process route

Product family — **only families with at least one `PUBLISHED` template
version are selectable**. Others render disabled with "No process route
defined yet" and, for ADMIN/PRODUCTION_HEAD, a link to `/admin/templates`.
No dead controls; the disabled state explains itself and offers the fix.

Then the template version (default: highest published version), showing
process count, the computed envelope total in weeks, and a `provisional`
warning where applicable.

Then the process list with include/exclude checkboxes, defaulting to the
template's own `optional` flag — this is how PWHT gets dropped for a client
who does not require it. Excluded processes are struck through, and the
envelope total recomputes to reflect the exclusion.

Then, optionally, a QCP template to clone (§4.2), listing the seven seeded
templates with their vessel and revision.

### 5.3 Step 3 — Equipment and serials

One or more equipment blocks. Each block:

- Equipment type, from the master list filtered to the chosen family.
  Selecting one prefills the block name and the step-4 spec fields.
- Block name (prefilled, editable — the catalog entry is the type, the block
  name may carry order-specific detail).
- Block number.
- Quantity, and a serial scheme: prefix · start number · zero-pad width.
  The generated serials preview live, as `320SR01 … 320SR09`. Serials are
  editable individually after generation for the cases where the scheme does
  not fit.

Multiple blocks exist because that is how the live data looks — DE0463's CSV
carries several equipment blocks under one job.

### 5.4 Step 4 — Material and configuration

Design code (prefilled from `EquipmentTypeRef.defaultDesignCode`) plus a
family-specific field set rendered from a constant map in
`src/lib/shared/specs.ts`:

```ts
export const SPEC_FIELDS: Record<string, SpecField[]> = {
  PRESSURE_VESSEL: [
    { key: "designPressure", label: "Design pressure", unit: "kg/cm²", type: "number" },
    { key: "designTemperature", label: "Design temperature", unit: "°C", type: "number" },
    { key: "mdmt", label: "MDMT", unit: "°C", type: "number" },
    { key: "moc", label: "Material of construction", type: "text" },
    { key: "capacity", label: "Capacity", unit: "L", type: "number" },
    { key: "orientation", label: "Orientation", type: "select", options: ["Vertical", "Horizontal"] },
    { key: "radiography", label: "Radiography", type: "select", options: ["Full", "Spot", "None"] },
  ],
}
```

`PRESSURE_VESSEL` is the only entry defined by this spec, because it is the
only family with a published route. Each further family's field set is added
alongside its route — heat exchangers will want TEMA type, shell- and
tube-side design pressure and temperature, tube count, tube OD and pass
count, but those belong in the commit that makes heat exchangers orderable,
not in this one. A family with no entry renders no spec fields and stores
`specs: null`, which is a valid state, not an error.

Values land in `Job.specs` as a flat object, prefilled from
`EquipmentTypeRef.defaultSpecs` and editable. A constant map rather than an
EAV table: the field set changes when a product family is added, which is a
code change anyway, and a jsonb column costs one migration for all families
rather than one per family.

`specs` is display and reference data. Nothing in `lib/schedule/` or the
gating path reads it, and nothing should start to without its own spec — the
moment a schedule depends on a free-shaped jsonb blob, the refusals stop being
explainable.

Also on this step: an optional "Copy BOM from" selector listing existing
equipment across the tenant's jobs, applying §4.3.

### 5.5 Step 5 — Review and create

Full read-only summary of steps 1–4: job header, pinned route with process
count and exclusions, each equipment block with its serial range, spec values,
and what will be copied (QCP items, BOM lines).

Explicit statements of what will *not* exist: "No QCP attached — no hold
points will block completion until one is added." "N processes are
provisional — dates cannot be computed for this job yet."

**Create** runs §4.1, then §4.4, then lands on `/jobs/[id]` with a toast. The
schedule verdict shows inline before navigation:

- `FEASIBLE` — green, with the computed finish date against the committed date
- `INFEASIBLE` — red, with shortfall days, and a note that the schedule was
  still saved so the gap is visible on the job page
- `SCHEDULE_DATA_MISSING` — amber, naming the provisional processes

## 6. Files

```
prisma/migrations/<ts>_job_intake/          equipment_type_refs, jobs date rename, specs
prisma/schema.prisma
src/lib/shared/schemas.ts                   createJobSchema (.strict), equipment type + client schemas
src/lib/shared/specs.ts                     SPEC_FIELDS per family
src/lib/shared/errors.ts                    2 new codes
src/lib/services/job-intake.service.ts      createJob + QCP clone + BOM copy
src/lib/services/job-intake.read.ts         clients, schedulable families, versions,
                                            equipment types, calendars, QCP templates,
                                            copy-BOM candidates
src/lib/services/admin.service.ts           equipment type CRUD, createClient
src/app/actions/job-intake.ts               thin actions via toActionError
src/app/(app)/jobs/new/page.tsx             + _client.tsx (the wizard)
src/app/(app)/jobs/page.tsx                 "New job" button, role-gated
src/app/(app)/admin/equipment-types/        master list CRUD screen
```

Plus the mechanical `deliveryDate` → `committedDeliveryDate` rename across the
thirteen files listed in §3.2, as a separate preceding commit.

`createJobSchema` is `.strict()` and contains **no** `actual_*` or `*_at`
field. `orderDate`, `committedDeliveryDate` and `targetDispatchDate` are
planning dates a planner legitimately supplies and are not actuals —
`schedule.service.ts` already makes exactly this distinction in a comment, and
the same reasoning applies here. Every `actual_*` on this job will be set by
`process.service.ts` from the DB clock and nowhere else (invariant #1).

## 7. Testing

`job-intake.service.test.ts`, table-driven on the violation cases per
CLAUDE.md:

**RBAC**
- SUPERVISOR, QC, MANAGEMENT → `FORBIDDEN`
- client user → `FORBIDDEN` (via `assertNotClientUser`), never `NOT_FOUND` leakage
- ADMIN, PRODUCTION_HEAD → allowed
- cross-tenant `clientId` / `templateVersionId` / `equipmentTypeId` → `NOT_FOUND`

**Validation** — one case per row of §4.1's table, each asserting the code and
that `details` identifies the offending value.

**Correct materialisation**
- `JobProcess` count equals the template version's process count, including
  excluded ones
- `JobProcessEdge` count equals `TemplateEdge` count, and every edge's two
  endpoints belong to the new job
- excluded processes are present with `included: false`, and their edges still
  exist so `lib/schedule/exclude.ts` can bridge them
- durations, envelope offsets, `workOrderStages` and `provisional` are copied
  verbatim, not defaulted
- `publicId` is a uuid, not derivable from the id

**QCP clone**
- item, party and party-code counts match the source
- `QcpItemProcess` links resolve by code against the new job's processes
- a source link whose process code is absent from the new job is reported as a
  warning and produces no row
- no `QcpExecution` rows are copied

**BOM copy**
- `BomItem` rows copied; `Procurement`, `MaterialIdentification`, `Component`
  and `ItemTest` rows are not

**Atomicity and audit**
- one `audit_log` row per creation, in the same transaction
- a forced failure after equipment insert rolls back the job, its processes,
  its edges and the audit row — assert zero rows, not just an error
- a failing `generateSchedule` afterwards leaves the job intact

**Date semantics**
- `targetDispatchDate` after `committedDeliveryDate` → `VALIDATION_FAILED`
- BACKWARD scheduling anchors on `committedDeliveryDate` by default and on
  `targetDispatchDate` when the toggle is set
- `client-snapshot.read.ts` never returns `targetDispatchDate` — extend the
  existing field-list assertion

**Rename regression**
- the existing `job-health.test.ts` and `workspace.read.test.ts` suites pass
  unchanged in behaviour after the column rename

## 8. Sequencing

1. `deliveryDate` → `committedDeliveryDate` rename + `targetDispatchDate` +
   `specs`, own migration, own commit, full suite green
2. `EquipmentTypeRef` + `Equipment.equipmentTypeId`, migration
3. Equipment-type CRUD service + `/admin/equipment-types`
4. `createClient`
5. `job-intake.service.ts` + tests — the load-bearing piece
6. `job-intake.read.ts`
7. Wizard steps 1–3
8. Wizard steps 4–5, including the schedule verdict
9. "New job" button on `/jobs`
10. Acceptance pass: create a second pressure-vessel job end to end, confirm
    its Stage Spine, department workspaces, job detail and Gantt all render
    from real data; confirm a deliberately unachievable committed date returns
    `INFEASIBLE` with a shortfall rather than a silent plan

Steps 1–2 are independent of the route-authoring spec. Step 5 onward benefits
from it but does not require it — until route authoring ships, step 2's family
list contains pressure vessels alone, which is enough to build and demo the
whole flow.
