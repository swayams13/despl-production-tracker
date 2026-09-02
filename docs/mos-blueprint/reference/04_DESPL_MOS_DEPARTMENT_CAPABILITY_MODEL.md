# 04 — DESPL MOS Department Capability Model

Departments are modeled as operational capabilities, not navigation pages — this section verifies that claim against the actual service layer rather than assuming it.

## 1. Department capability table

| Department | Purpose | Work Object | Inputs | Outputs | Dependencies | Own Richer Model | KPIs (current) | UI Tier |
|---|---|---|---|---|---|---|---|---|
| PROJECTS | Intake & coordination | `Job` | Client requirement | `Job` row | — | — | Portfolio counts | Office (`/command/PROJECTS`) |
| ENGINEERING | Design release, drawing control | `AssemblyDrawing`/`DrawingRevision` | Job specs | Released revision | PROJECTS | Drawing versioning (real: strictly increasing revisions, prior RELEASED flips to SUPERSEDED) | — | Office, real workflow |
| PLANNING | Schedule materialization | `JobProcess`/`ProcessPlan` | Template version | Scheduled plan rows | ENGINEERING | — | Critical-path counts | Office |
| PROCUREMENT | Material sourcing lifecycle | `ProcurementEvent` | BOM shortage | Event ledger entries | Approved BOM | Event ledger (append-only) | — (no due-date field to compute against) | Office, thin workflow |
| STORES | Stock receipt/issue | `StockLot`/`StockTxn` | Receipts | Stock transactions | PROCUREMENT | Real | — | Office |
| QC | Inspection, hold, NCR/rework | `QcpExecution`/`Ncr` | Component/assembly at checkpoint | Pass/fail, NCR | Fabrication/Paint | Richest subtree — P/W/H hold codes, attempt numbering, disposition state machine | Checkpoint yield %, welder repair rate | Office **+ dedicated `/qc` cockpit** |
| FABRICATION_PREP | Pre-fab prep ops | `ComponentOperation` | Kitted material | Prepped components | STORES | — | — | Floor (redirects to `/workspace`) |
| MACHINE_SHOP | Machining | `ComponentOperation` | Prepped components | Machined components | FABRICATION_PREP | — | — | Floor |
| FABRICATION | Cut/form/weld/build-up | `ComponentOperation` + `WeldJoint`/`WeldLog`/`NdtResult` | Machined components + released drawing | Fabricated components | MACHINE_SHOP, ENGINEERING | Richest floor subtree — full weld traceability | Welder repair rate %, joints-vs-team-average | Floor. **Code literal:** `welding.service.ts:24` looks up department by `code: "FABRICATION"` |
| HEAT_TREATMENT | PWHT | `ComponentOperation` | Fabricated components | Heat-treated components | FABRICATION | No PWHT-specific model (`GAP`) | — | Floor, thin |
| SURFACE_PAINT | Coating, DFT | `ComponentOperation` + `PaintRecord`/`DftReading` | QC-cleared components | Coated components, DFT readings | QC | Real, generic models | — | Floor. Business rule reached via `if (operationCode === "PAINTING")` string comparison in `component.service.ts` — reusable (keyed by code, not id) but not table-driven |
| DOCUMENTATION | MDR compilation | — | All upstream records | Compiled MDR (`GAP`: no dedicated model) | Everything upstream | No model found | — | Floor, thinnest |
| DISPATCH | Pack, release, dispatch | `DispatchBatch`/`DispatchBatchUnit` | Packed, QC-cleared units | Dispatch record | DOCUMENTATION, QC | Real, recent (Phase 5) | — | Floor. **Zero UI** — confirmed by exhaustive filename search under `src/app` |

## 2. Generic access control, hardcoded routing tier

**`CURRENT`, verified:** `requireDepartmentScope` (`src/lib/authz/index.ts`) checks `actor.departmentIds.includes(departmentId)` — fully data-driven, no department names in the authorization code itself. But *which* departments render a rich `/command/[dept]` dashboard versus redirect to the generic `/workspace` floor view is the hardcoded `OFFICE_DEPT_CODES`/`ALL_DEPT_CODES` array in `command-center.read.ts:32-47`, enumerating exactly today's 13 seeded codes.

**`GAP`:** a 14th department costs nothing as a data row (one INSERT); giving it its own command-center-tier dashboard versus the generic floor workspace requires a code change to this array. **`TARGET`:** replace the hardcoded array with a `Department.dashboardTier` (or similar) column so UI routing is data-driven end to end — this is the forensic audit's own recommendation (§43) and this blueprint concurs; it is a small REFACTOR (`17`), not new architecture.

## 3. Department genericity test — answered per department, not assumed

Applying the brief's checklist (§8 of the source prompt) against verified evidence:

| Test | Answer | Evidence |
|---|---|---|
| Can a new project use any department without developer intervention? | **Yes** | `Department` is a generic FK everywhere sampled; `admin.service.ts`'s equipment-type catalog takes an arbitrary `familyId` |
| Can the same department operate differently for different product families? | **Yes** | Each `Job` pins its own `templateVersionId`; two jobs can route the same department's work differently by pinning different template versions |
| Can a department create work based on configured workflows? | **Yes**, once a family is bootstrapped | `TemplateProcess`/`RouteTemplate` materialize into `JobProcess`/`ComponentOperation` with no family branch in the materialization code |
| Can work be assigned to people/teams? | **Yes** | `ProcessPlan.assigneeUserId`, a real claim/assign/release service; no `Team` model exists — assignment is to an individual or left unassigned in the department's pool |
| Can it track planned vs. actual? | **Yes**, at two grains | CPM early/late dates at the `ProcessPlan` grain; `qtyPlanned/qtyGood/qtyRejected` at the `ComponentOperation` grain |
| Can it raise blockers? | **Yes** | `DelayReason`, `Ncr`, hold points — all real, department-agnostic models |
| Can it produce management KPIs? | **Yes, but ad hoc** | Real numbers exist; no shared calculation framework (`14`) |
| Can it trigger alerts? | **Partially** | `Notification` model is real and event-driven for some triggers; delay-filing and NCR-opening generate **no** notification today (`14`) |
| Can its workflow change without rewriting the application? | **Yes, once bootstrapped; No for a brand-new family's first template/route/QCP** | The central gap — see `06` |

## 4. Department maturity tiers (adopted from forensic audit §9, independently re-verified)

- **Most mature:** QC (dedicated cockpit, richest data model, deep testing).
- **Real and generic, office-tier:** PROJECTS, ENGINEERING, PLANNING, STORES.
- **Real but thin:** PROCUREMENT (event log only, no vendor/PO/due-date model — `08`).
- **Real, floor-tier, redirect-only UI:** FABRICATION_PREP, MACHINE_SHOP, HEAT_TREATMENT, DOCUMENTATION.
- **Real and rich, floor-tier:** FABRICATION (weld traceability), SURFACE_PAINT (DFT records).
- **Real service layer, zero UI, inactive on the pilot job:** DISPATCH.

## 5. Target: department as a fully self-serve capability

`TARGET` for a department to be a true MOS-core capability, independent of hand-authored code:

1. Department creation is already self-serve (data row) — **preserve**.
2. Dashboard tier (office vs. floor) becomes a `Department` field, not a hardcoded array — **P2 refactor**.
3. A department's operation-triggered business rules (the Painting DFT gate, the FABRICATION-literal weld lookup) should be reachable through the department/operation-type reference tables already in place, not string literals in service code — **P2 refactor**, narrow in scope (2 call sites), not a redesign.
4. Documentation's missing MDR model and Procurement's missing vendor/PO/due-date model are genuine **capability gaps** (not UI gaps) — see `08`.

---
*Sources: `src/lib/authz/index.ts`, `src/lib/services/command-center.read.ts`, `src/lib/services/welding.service.ts`, `src/lib/services/dispatch.service.ts`, `seed/lead-time-model.json`, `docs/DESPL_MOS_FORENSIC_AUDIT.md` §9.*
