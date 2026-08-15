# BUILD-SPEC v2 — DESPL Production Tracker

> Supersedes the scheduling and granularity sections of PRD v1.0 / TRD v1.0.
> Written 11 Aug 2026 after the DESPL document handover. **Read this before writing any code.**
> Source of truth for seed data: `seed/*.json` (generated from the DESPL documents, not hand-typed).

---

## 0. Decisions locked in this session

| # | Decision | Consequence |
|---|---|---|
| 1 | **36-process Lead Time list is the master spine** | Scheduling, notifications and department ownership all hang off process codes 1–36. The 25-stage work order becomes a *reporting view* (`workOrderStages[]` crosswalk is already in the seed). |
| 2 | **Granularity = per BOM item, with serial roll-up at assembly** | Procurement and component fabrication track BOM lines (matching the live CSVs). From Final Assembly (P24) onward, records attach to vessel serials. |
| 3 | **Scheduling = forward + backward + infeasibility flag, with human override** | Every planned date is editable by an authorised planner with a mandatory reason, written to audit. Overrides never silently overwrite the baseline. |
| 4 | **Durations = fixed baseline, editable per project** | `lead-time-model.json` seeds every project; per-project overrides live in `project_process_plan`. |
| 5 | **Stack = single Next.js full-stack app + Postgres** | Replaces the split Next.js/NestJS monorepo in TRD §2. Prisma + Postgres retained. Server Actions / Route Handlers replace the NestJS controllers. All integrity rules move into a `services/` layer that both Server Actions and API routes call. |
| 6 | **Department mapping drafted by us, corrected by DESPL** | 13 departments in the seed. Ship it, let them edit in the admin screen. |
| 7 | **Tender intake = manual key fields + attached file** | No PDF parsing in v1. Fields: equipment type, quantity, enquiry/PO date, required delivery date, client, TPI parties. |
| 8 | **QAP engine = fully dynamic parties + full code set** | Parties are per-project rows, not columns. Codes: P, W, H, R, RW, R&A. |
| 9 | **Model usage** | **Opus for architecture, spec and decisions. Sonnet for coding sessions.** |

---

## 1. The scheduling engine — the core of this release

### 1.1 Critical finding: the lead-time table is not a simple chain

A strict finish-to-start chain over the 36 processes yields **11.6–24 weeks**. DESPL's own table says **~17 weeks**. Reconciliation:

- The `Cumulative Lead Time` column encodes **heavy concurrent fabrication** — 21 of 36 processes must start before their predecessor finishes.
- It is **rounded to whole weeks**, so overlaps of 1–5 days are largely rounding artifacts; larger ones are real concurrency.
- Per the document, **17 weeks is both the minimum and the maximum total** (rows 35–36 print a single value, not a range). There is no faster case on paper.

**Therefore: do not compute the plan by summing durations.** Use two layers.

### 1.2 Layer 1 — Envelope (authoritative, drives the tender quote)

```
planned_finish[i] = project_start + envelope.finishByMaxDays[i]
planned_start[i]  = planned_finish[i] - duration.maxDays[i]
```

Reproduces the 17-week figure exactly. This is what the team sees when they upload a tender/RFQ. Both the optimistic (`finishByMinDays`) and standard (`finishByMaxDays`) curves are shown.

### 1.3 Layer 2 — CPM DAG with fitted lags (drives live replanning)

Each edge in `processes[].edges[]` carries a `lagDays` **fitted from the printed table**, not assumed:

- `lagDays >= 0` → `FINISH_TO_START`
- `lagDays < 0` → `START_TO_START_WITH_OVERLAP` — legitimate concurrent work, **not** a data error

Used for: recomputing the plan when an actual slips, critical-path and float, and *gating* (a process cannot be **started** before its predecessors satisfy their edge condition).

> **Gating vs scheduling are different concerns.** Layer 2 lags relax the *schedule*. They do **not** relax CLAUDE.md invariant #2 — a process still cannot be marked COMPLETE out of order, and hold points still block absolutely.

### 1.4 The three scheduling modes

| Mode | Input | Output |
|---|---|---|
| **Forward** | PO / enquiry date | Earliest realistic dispatch date. Answers "when can we deliver?" |
| **Backward** | Client required delivery date | Per-process *finish-by* date for every department. **This is what drives notifications.** |
| **Override** | Planner edit | Any planned date replaced, with mandatory reason + audit row. Baseline preserved. |

### 1.5 Feasibility check (run at tender stage, before commitment)

```
available = working_days(po_date -> required_delivery)
if available >= envelope.finishByMaxDays[36]  -> FEASIBLE
elif available >= envelope.finishByMinDays[36] -> TIGHT (needs compression; list which processes must compress)
else -> INFEASIBLE (short by N days; must be escalated before the order is accepted)
```

**Validated against live data:** DE0467, PO 24 Jun 2026, committed dispatch 15 Oct 2026. That's 113 calendar days, less 16 Sundays under the default 6-day-week calendar, = 97 working days available vs 119 minimum. The engine flags this as **INFEASIBLE by 22 working days** (~6 days if the table's "days" turn out to be calendar days — see open question C1). Either way the order was accepted on a timeline shorter than DESPL's own standard. *This is the single best demo of the tracker's value: it would have caught this at order acceptance.*

> **Corrected 13 Aug 2026 (was "~26").** 24 Jun → 15 Oct 2026 is 113 calendar days containing 16 Sundays = 97 working days; 119 − 97 = **22**. The old figure was never reproducible and is now asserted as 22 in `src/lib/schedule/cpm.test.ts`. Two further conventions this number depends on:
>
> 1. **Day 0 is the PO date itself** — working days are counted over `(PO, delivery]`. The inclusive reading gives 98 available / 21 short.
> 2. **The delivery date is the EARLIEST of a committed window.** DE0467's source field is a range, `15.10.2026 - 25.10.2026`. Against the late end the shortfall is only **14** days. We measure against the earliest because the check exists to raise risk before the order is signed — see open question **C21**.

### 1.6 Calendar

Default: **calendar days, 6-day week, Sunday off, no holiday list.** Isolated in one module (`lib/schedule/calendar.ts`) because C1 will change it.

---

## 2. Data model (Prisma, additions and changes vs TRD v1.0)

```
Client, Job, Equipment, Unit(serial)
  Job 1—n Equipment 1—n Unit          // DE0467 = 1 job, 3 equipments; DE0463 = 40 units of 1 equipment

LeadTimeProcess          // seeded 1..36, immutable reference
ProcessEdge              // predecessor, type, lagDays  (seeded, per-template)
Department               // 13 seeded, editable
  ProcessDepartment      // process -> owning department (editable by admin)

ProjectSchedule          // one per Job (or per Equipment) + version
ProjectProcessPlan       // job/equipment x process: baselineStart/Finish, plannedStart/Finish,
                         // actualStart/Finish (SERVER CLOCK ONLY), durationOverrideDays,
                         // overrideReason, status, ownerDepartmentId
BomItem                  // itemNo, blockNo, partName, description, material, qty, unit, componentType
  Procurement            // indentNo/date, approvedDate, status, poNo/date, receivedStatus/date
  MaterialIdentification // heatNumber, mtcRef, pmiResult   <-- REPLACES the misused CSV column
  ItemOperation          // canonical operation, sourcing(IN_HOUSE|OUTSOURCE|NA), start, end, status
  ItemTest               // RT/UT/HT/Pneumatic/DP/Vacuum, type, start, end, result

InspectionParty          // per-job rows: DESPL, CLIENT_TPI, BUYER_TPI, AI, BUSCI_TPI, EIL_TPIA...
QcpTemplate / QcpItem
  QcpItemPartyCode       // (qcpItem, party) -> code P|W|H|R|RW|R&A   <-- dynamic, the key change
  QcpExecution           // result, callGivenOn, callAttendedOn, clearedBy, waiverApprovedBy
AssemblyDrawing          // GA / Fabrication / Weld Map / P&ID / Isometric + approval/release/revision/rev no
DelayReason, Notification, AuditLog   // per PRD/TRD v1.0, unchanged
```

**Unchanged invariants from CLAUDE.md — all still apply.** Note especially #1 (no client timestamps), #3 (maker–checker), #5 (append-only audit) and #6 (no destructive edits — the override flow in §1.4 must create a version, never mutate the baseline).

---

## 3. Department workspaces

13 seeded departments (`seed/lead-time-model.json` → `departments[]`). Each supervisor sees only processes where `ProcessDepartment.departmentId = theirs`, scoped by `DepartmentScopeGuard` equivalent.

Each workspace shows: **my processes due this week** (from the backward schedule), overdue items requiring a delay reason before further writes, entry forms for that department's operations, and the QCP checkpoints they own.

Entry surfaces by department:

| Department | Enters |
|---|---|
| PROJECTS | PO review, kick-off completion |
| ENGINEERING | Design calc, drawings, client approval dates, drawing revisions |
| PLANNING | BOM & MTO, cutting plan, schedule overrides |
| PROCUREMENT | Indent, PO, vendor, expected delivery |
| STORES | Material receipt, GRN, partial receipts |
| QC | Material identification (heat no + MTC), NDE results, QCP checkpoints, hold clearance, inspection calls |
| FABRICATION_PREP | Cutting, forming/rolling |
| MACHINE_SHOP | Machining |
| FABRICATION | Fit-up, welding, assembly, attachments |
| HEAT_TREATMENT | PWHT cycle + chart |
| SURFACE_PAINT | Blasting, painting, DFT |
| DOCUMENTATION | MDR checklist |
| DISPATCH | Packing, clearance, dispatch |

---

## 4. Notifications

Driven by the **backward schedule**. For each `ProjectProcessPlan` with `plannedFinish`:

- **T-3 days** → "due soon" to owning department supervisor + representative
- **T-0** → "due today"
- **T+1** → overdue; department is **blocked from further progress writes on that unit** until a categorised delay reason is filed (CLAUDE.md invariant #7)
- **T+3** → escalate to Production Head; **T+7** → MD/CEO

v1 is in-app only (PRD decision, 03 Aug 2026 — unchanged). Payload is stored email-ready.

---

## 5. Seed files (generated, do not hand-edit)

| File | Contents |
|---|---|
| `seed/lead-time-model.json` | 36 processes, durations, envelope, fitted DAG edges, 13 departments, crosswalk to 25 stages |
| `seed/component-routes.json` | 25 component routes + canonical operation vocabulary mapped to the live CSV columns |
| `seed/qcp-templates.json` | QCP DESPL-320 (54 checkpoints, 4 hold / 11 witness), dynamic-party model, code semantics |
| `seed/live-jobs.json` | DE0463 (2 blocks, 20 items) and DE0467 (3 blocks, 34 items), normalised, ISO dates |
| `seed/data-issues.json` | 12 data problems found during import — hand this to DESPL |

---

## 6. Build order

1. Scaffold Next.js + Prisma + Postgres; auth + RBAC; audit interceptor
2. Seed reference data from `seed/*.json`; department admin screen
3. **Scheduling engine** (`lib/schedule/`) — envelope, CPM, forward/backward, feasibility, override. Table-driven tests including the DE0467 infeasibility case
4. Tender intake screen → generates the schedule
5. Job/equipment/BOM import from `live-jobs.json`; component-type classification
6. Department workspaces + entry forms + maker–checker
7. QCP engine with dynamic parties and hold-point blocking
8. Notifications + escalation + "Today" lists
9. Dashboards (MD/CEO/Production Head)

---

## 7. Open questions — MUST be answered by DESPL

| # | Question | Blocks | Default in use |
|---|---|---|---|
| C1 | Are the table's "Days" **working days or calendar days**? Holiday list? | Every computed date; changes the DE0467 finding from 22 days to ~6 | Calendar days, 6-day week, Sun off |
| C2 | Confirm the concurrency the table implies (e.g. nozzle fab running while shell NDE is open) | Layer-2 lags | Fitted from the printed table |
| C3 | Confirm procurement start points: plates after design calc (P3); pipes + bought-out after drawings (P4) | P7/P8/P9 planned dates | As derived |
| C4 | Does the 17-week envelope hold for **40 units** (DE0463) and for **3 equipments in one order** (DE0467)? | Per-project scaling | Fixed baseline, editable |
| C5 | **DE0455 vs DE0463/DE0467** — both CSVs carry Work Order "DE0455-01"; the QAPs are DE0455-01/02/03 | Job identity model | DE0455 = client order, DE0463/67 = internal job no |
| C6 | Sub-assembly **block labels** lost in CSV export (2 blocks in DE0463, 3 in DE0467) | Equipment grouping | Numbered placeholders |
| C7 | What do **RW** and **R&A** mean, and which of them block production? | QCP blocking logic | RW≈Witness, R&A≈blocking approval |
| C8 | "Material Identification" column holds In-house/Outsource — a sourcing type, not traceability. Intent? | Traceability model | Split into sourcing + heatNo/MTC |
| C9 | Department names, supervisors and **representatives** | Notification routing | 13 drafted departments |
| C10 | Component-type classification for BOM lines — auto by keyword or manual? | Route assignment | Manual with keyword suggestion |
| C11 | Edge Preparation, Grinding, generic Inspection have no column in the live tracker — track them? | Operation vocabulary | Modelled, hidden by default |
| C12 | Ambiguous dates like `7/8/2026` in the trackers | Data accuracy | Assumed m/d/yyyy |
| **C21** | A **dispatch date given as a window** (DE0467: `15.10.2026 - 25.10.2026`) — is the commitment the earliest or the latest date? | Feasibility verdicts; worth 8 working days on DE0467 alone (22 short vs 14) | **Earliest** — a tender-stage warning must fire against the date first promised |
| C22 | A **revised order date** (DE0467: original 24.06.2026, revised 13.07.2026 "for Suction & Pressure Pipe") — does the clock restart, and per equipment or per job? | Schedule anchor; against the revised date DE0467 is 38 working days short, not 22 | Original PO date; revision noted in `Job.remarks` |
| C23 | Which processes are **optional per client**? PWHT is skippable (the DESPL-320 drawing says it is not required), yet nothing is flagged `optional` in the lead-time table. | Template vs per-job deviation; the engine bypasses excluded processes and composes their lags | None flagged; all 36 included by default |
| C26 ✅ | When a work-order stage is **both overdue and on an open hold point**, which status should its spine segment / matrix cell show? (Display only; hold-point and overdue counts are computed independently at process grain and are unaffected — DESIGN_SPEC §11.2/§11.4.) | Which colour SJ/management see on the stage spine and Units×Stage matrix; nothing about gating or counts | **RESOLVED (SJ):** show **both** — **hold is the fill colour** (primary/lead, it's the actionable blocker and blocks completion per invariant #4) **+ an overdue secondary pip** (red marker). Both visible, neither lost. Full per-process reasons in the StageSheet (DESIGN_SPEC §4.5). |
| C27 | **Which set of 25 work-order-stage names is canonical?** Two schemes disagree: the seed's `workOrderStageNames` (from *work order process.pdf* — Kick-Off, Detail Engg, Shell Fabrication, NDT, PWHT…) and the approved mockup's own list (PO receipt, Fit-up long seam, Welding circ seam, Full NDT…), which is more fabrication-detailed and closer to the 36-process weld steps. The **36-process spine and its crosswalk are unaffected either way** — this is only the display label per stage number. | Every stage label the UI shows (StageSpine, Units×Stage matrix, StageSheet title, reports). Not gating, not the crosswalk. | Seed `workOrderStageNames` is pinned as canonical in DESIGN_SPEC §11.1; mockup keeps its own labels until SJ picks. **SJ to confirm the authoritative 25 names** (likely the shop-floor list). |
