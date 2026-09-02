# 02 — DESPL MOS Operating Model

## 1. The verified operating lifecycle (not the brief's default)

The brief's illustrative chain (`Sales → Project → Engineering → Procurement → Material → Production → QC → Painting → Dispatch`) was checked against the actual seeded departments (`seed/lead-time-model.json`) and the 36-process spine's department assignments (forensic audit §17, independently re-verified via `gating.ts`/`cpm.ts`). The real model:

```mermaid
flowchart LR
    PROJ[PROJECTS] --> ENG[ENGINEERING]
    ENG --> PLAN[PLANNING]
    PLAN --> PROC[PROCUREMENT]
    PROC --> STOR[STORES]
    STOR --> PREP[FABRICATION_PREP]
    PREP --> MS[MACHINE_SHOP]
    MS --> FAB[FABRICATION]
    FAB --> HT[HEAT_TREATMENT]
    HT --> QC1[QC — in-process]
    QC1 --> PAINT[SURFACE_PAINT]
    PAINT --> QC2[QC — final]
    QC2 --> DOC[DOCUMENTATION]
    DOC --> DISP[DISPATCH]
```

**`CURRENT`, verified:** this is a simplification for readability — the real graph is a 36-process DAG (`TemplateProcess`/`TemplateEdge`, `schema.prisma:544-623`) with `FINISH_TO_START` and `START_TO_START_WITH_OVERLAP` edges, meaning real concurrent work exists (e.g., some fabrication sub-steps legitimately overlap), not the strictly linear chain drawn above. QC appears at more than one point in the process spine (in-process and final), consistent with `Department QC`'s richest-in-the-system model (`QcpTemplate`/`QcpExecution`/`Ncr`).

**No `Sales` department exists in the system.** A `Job` is created directly by an ADMIN or PRODUCTION_HEAD through job intake (`job-intake.service.ts`); there is no lead/opportunity/quote concept. **`DECISION REQUIRED` (see `20`):** should MOS Core ever model pre-Job sales activity, or does that stay outside the system's boundary permanently? This blueprint's position (see `01` §4): stays out — DESPL MOS starts at the `Job`, sales/quoting is a different problem with different actors and is not evidenced anywhere in the current schema or docs as intended scope.

## 2. Departments: responsibilities, inputs, outputs, dependencies

| Department | Responsibility | Primary Input | Primary Output | Depends On | Blocks |
|---|---|---|---|---|---|
| PROJECTS | Job intake, project-level coordination | Client PO / requirement | `Job` row, initial schedule | — | Everything downstream |
| ENGINEERING | Design calc, drawing issuance/revision | Job specs, client inputs | Released `DrawingRevision` | PROJECTS | Fabrication (via `assertDrawingReleased` gate — `CURRENT`, real) |
| PLANNING | Schedule materialization, sequencing oversight | `ProcessTemplateVersion` | `JobProcess`/`ProcessPlan` rows | ENGINEERING | Everything scheduled |
| PROCUREMENT | Raise/track indent → PO → receipt | BOM shortage | `ProcurementEvent` ledger entries | Approved BOM | STORES, and (partially — see `08`) FABRICATION via `assertKitReady` |
| STORES | Receive, stock, issue material | Receipts | `StockLot`/`StockTxn` | PROCUREMENT | FABRICATION_PREP/MACHINE_SHOP/FABRICATION |
| QC | Inspect, hold, disposition, NCR/rework | Component/assembly reaching a QCP checkpoint | `QcpExecution`, `Ncr` | Fabrication/Assembly/Paint | Every gated downstream stage (hold points are hard blocks — `CURRENT`, verified `assertNoOpenHoldPoint`) |
| FABRICATION_PREP | Pre-fabrication prep operations | Kitted material | Prepped components | STORES | MACHINE_SHOP |
| MACHINE_SHOP | Machining operations | Prepped components | Machined components | FABRICATION_PREP | FABRICATION |
| FABRICATION | Cutting, forming, welding, assembly build-up | Machined components + released drawing | Fabricated components/sub-assemblies | MACHINE_SHOP, ENGINEERING (drawing gate) | HEAT_TREATMENT, QC |
| HEAT_TREATMENT | PWHT and related heat treatment | Fabricated components | Heat-treated components | FABRICATION | QC |
| SURFACE_PAINT | Surface prep + coating, DFT recording | QC-cleared components | `PaintRecord`/`DftReading` | QC | Final QC/Documentation |
| DOCUMENTATION | MDR compilation | All upstream records | Compiled document set (no dedicated model today — `GAP`) | Every upstream department | DISPATCH |
| DISPATCH | Packing, release approval, dispatch record | Packed, QC-cleared units | `DispatchBatch`/`DispatchBatchUnit` | DOCUMENTATION, QC | Job completion |

**`CURRENT`, mechanism:** `Department` is a real tenant-scoped data row (`@@unique([tenantId, code])`), not an enum — adding a 14th department is one INSERT (verified, `admin.service.ts` takes an arbitrary `familyId`/department shape). **`GAP`:** which departments get a rich `/command/[dept]` dashboard versus a generic `/workspace` floor redirect is a hardcoded TypeScript array (`OFFICE_DEPT_CODES`/`ALL_DEPT_CODES`, `command-center.read.ts:32-47`) enumerating exactly today's 13 codes — a 14th department is free as data but not free as a management-tier UI. See `17`.

## 3. Cross-department dependency model

This is the system's strongest verified capability (forensic audit §17, independently re-confirmed by reading `gating.ts` and `command-center.read.ts` directly).

- Dependencies are **process-to-process**, not department-to-department (`TemplateEdge`/`JobProcessEdge`), so two processes in the *same* department can gate each other and a process can depend on another department's process — the graph doesn't care which department owns which node.
- `gating.ts` is verified to contain **zero department-awareness** — a Painting stage is blocked by an unfinished Fabrication stage through exactly the same `assertCanStart`/`assertCanComplete` mechanism a QC stage is blocked by Painting.
- This is surfaced to department heads directly: `command-center.read.ts`'s `CommandCenterView` computes `blocking` ("other departments' BLOCKED plans whose blocking predecessor belongs to *my* department") and `waitingOnOthers` ("my department's BLOCKED plans, blocked on someone else") from the *same* CPM/gating computation (verified at `command-center.read.ts:190-367`). A Painting supervisor's dashboard can genuinely render "you are blocking QC."
- **`TARGET` (already true, preserve):** this pattern — dependencies expressed at the work-unit grain, never at the department grain — is the correct foundation for a company-wide MOS and should not be refactored, only extended (automatic delay propagation, `09`/`19`).

## 4. Approvals, handoffs, and gates already enforced

| Gate | Enforced by | Bypassable? |
|---|---|---|
| Sequential predecessor gating (`IN_PROGRESS`/`COMPLETE`) | `gating.ts` `assertCanStart`/`assertCanComplete`, called server-side inside the mutating transaction | No — verified no client-settable status path |
| Maker-checker (submitter ≠ verifier) | `assertMakerChecker`, invariant #3 | No admin bypass — verified directly |
| Hold points (H-coded QCP checkpoints) | `assertNoOpenHoldPoint`, called from `verifyProcess` | No |
| Drawing-release gate on fabrication start | `assertDrawingReleased` | No — real, blocks CUTTING without a RELEASED revision |
| Material-kit gate | `assertKitReady` (`_shared.ts:684`) | **Partial `GAP`**: silently no-ops for a BOM item with zero stock transaction history (never kitted, so nothing to check against) |
| Witness (W) waiver approval | Documented invariant #4, but `QcpExecution.waiverApprovedBy` is never written by any service function | **Yes — real gap**, not enforced today (`11`) |

## 5. Daily operating rhythm — current vs. target

**`CURRENT`:** the daily digest's data pipeline is real (`loadDailyDigest`, computed from live `DomainEvent`/`AuditLog` data) but delivery is a manual "Send now" button (`publishDigest`), not scheduled. Overdue-stage and aged-hold-point alerts are computed lazily on every authenticated page load — a working mechanism whose own code comment flags it as "fine at demo scale," a full-table scan per page view. No cron/queue infrastructure exists anywhere (`package.json` has none; `CLAUDE.md`'s own text says "Background jobs via Next.js route + cron (BullMQ/Redis only if load demands it)" — load already demands it, per `14`/`17`).

**`TARGET` operating rhythm** (derived from the system's own actors and data, not assumed):

- **Morning:** scheduled daily digest delivered (not button-pressed) to Management/Production Head — today's overdue, today's holds, today's critical-path risk, yesterday's completions.
- **During the day:** production writes happen continuously through the existing state machine; alerts fire on real events (delay filed, NCR opened, hold aged past a threshold) rather than only being discoverable by loading a page.
- **End of day:** unresolved blockers and today's delay reasons roll into tomorrow's digest and into the portfolio risk view.

This rhythm requires no new domain concepts — only a scheduler (P2, see `17`/`18`) to move the two already-real read pipelines (`loadDailyDigest`, the lazy alert scan) from manual/lazy to event- and time-driven.

## 6. What replaces "linear stage chain" thinking

Management should read this operating model as **a DAG with department ownership annotations**, not a pipeline. The 25-stage "Stage Spine" UI (`stage-names.ts`) is a *reporting projection* of the DAG for one family (pressure vessels), not the underlying model — see `07` for how the target architecture must derive stage reporting from the job's actual route rather than a hardcoded 25-stage table.

---
*Sources: `seed/lead-time-model.json`, `src/lib/schedule/{gating,cpm}.ts`, `src/lib/services/command-center.read.ts`, `src/lib/services/_shared.ts`, `CLAUDE.md`, `docs/DESPL_MOS_FORENSIC_AUDIT.md` §9, §17, §21, §23.*
