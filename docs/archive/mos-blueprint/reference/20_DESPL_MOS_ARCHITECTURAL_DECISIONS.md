# 20 — DESPL MOS Architectural Decisions

## 1. Canonical architectural principles (10–15, as required)

1. **Project/job data is never product-hardcoded.** A `Job.familyId`/`templateVersionId` pin determines behavior; no service function branches on a family name. (Verified: zero family branches found in gating/scheduling/authz.)
2. **DESPL-320 is data, not architecture.** It is the calibration pilot (per the accepted ADR), not the specification. Any remaining literal reference to it in `src/` is a bug, not a feature.
3. **Product workflows are configuration-driven** — a `ProcessTemplate`/`RouteTemplate`/`QcpTemplate`, not a code path, is what changes when a new family is onboarded.
4. **Templates are versioned; publishing is immutable.** Editing a published template creates a new version; running jobs keep their pinned version forever (invariant #9, verified real).
5. **Running jobs use immutable configuration snapshots**, not live references to a mutable template — a job's `templateVersionId` and cloned `QcpTemplate` are frozen at intake.
6. **Production execution is event/audit-driven.** Every mutation writes `AuditLog`/`DomainEvent` in the same transaction as the mutation (invariant #5, DB-grant-enforced, verified).
7. **Cross-department dependencies are explicit and process-to-process**, never department-to-department — this is what lets `gating.ts` stay department-agnostic (verified: zero department-awareness in the gating module).
8. **Management views derive from operational truth**, not from a separately-maintained status field — `blocking`/`waitingOnOthers` are computed from the same CPM/gating data every department's own gate check uses.
9. **Security is enforced server-side, never client-trusted.** No client timestamps (invariant #1); RBAC checked in service functions, not just UI conditionals.
10. **AI does not replace deterministic business rules.** State transitions, gating, RBAC, audit, and scheduling arithmetic stay deterministic; AI is additive on data these mechanisms already make truthful (`16` §6).
11. **Gating and scheduling are separate concerns.** CPM lags relax the schedule; they never relax gating (invariant #11, verified as genuinely implemented, not just documented).
12. **Refusals must be explainable.** Every failure mode has a stable, named error code (48 verified in `errors.ts`), never a generic 500 or silent no-op.
13. **Reference vocabularies are data, not enums.** Anything open-ended (departments, operation types, delay categories) is a tenant-scoped table; anything a genuine closed state machine is an enum. No exception found across 71 models.
14. **Corrections create new versions; nothing is silently overwritten.** No `deletedAt`/destructive edit found anywhere — lifecycle is expressed via status, and audit preserves history (invariant #6).
15. **The mechanism should be built ahead of the tooling to configure it, never the reverse — but tooling debt must be named, not hidden.** This blueprint's single most repeated finding (`06`, `07`, `08`, `12`) is a codebase where the underlying mechanism is already generic and correct, and the *self-serve tooling* to configure it for a new case (family, route, QCP, document category) is what's missing. Future work should preserve this ordering — build the general mechanism first — while not letting "the mechanism exists" stand in for "the capability is usable."

## 2. Anti-patterns to prevent (explicit, for future developers)

- Hardcoding DESPL-320 or any specific job number/serial in `src/` (only `seed/`, `scripts/`, and test fixtures may reference the pilot by name).
- Hardcoding a product-family code (e.g., `"PRESSURE_VESSEL"`) in a query or business-rule branch instead of taking `familyId` as a parameter.
- Embedding product-specific assumptions into MOS Core (Layer 1, `16` §3) — a Layer-1 model or service must never reference a family, route, or QCP concept directly.
- Using an enum where a reference table is the correct tool (an open, growable vocabulary should never become a hardcoded enum — verified this codebase gets this right today; don't regress it).
- Creating a duplicate department-specific implementation of a capability every other department already has generically (the FABRICATION-literal weld lookup and the PAINTING-string-comparison gate are the two existing instances to fix, not a pattern to extend).
- Dashboard-specific KPI calculations — a new KPI should extend the shared calculation framework (`14`, once consolidated), not add a fifth independent implementation.
- Bypassing the service layer — a Server Action or route handler must never call Prisma directly (verified: zero violations today; keep it that way).
- Client-only authorization — every `require*` check must run server-side inside the mutating transaction, never only as a UI conditional.
- Silently modifying active template behavior — any template edit must create a new version; a running job's pinned version must never change underneath it.
- Coupling UI to one product family — a UI component (like the Stage Spine) must derive its content from the job's actual route/family, never assume a universal sequence.

## 3. Open decisions requiring explicit sign-off

| Decision | Why Needed | Options | Recommended Option | Confidence |
|---|---|---|---|---|
| **D1 — Fabrication/assembly/spine join: FK vs. invariant-only** | The numeric-code join (`03` §1) is the single highest silent-break risk in the domain model | (a) Add a real FK from `ComponentOperation`/`AssemblyStep` to `JobProcess`; (b) Add a DB CHECK/trigger that fails loudly on mismatch without changing the join shape | (b) as a fast first step, (a) as the durable fix once a migration window is available | Medium — (a) is architecturally cleaner but touches more surface; (b) is lower-risk and buys time |
| **D2 — Should `Project` be a distinct entity above `Job`?** | The brief's proposed hierarchy assumes one; the current schema doesn't have one | (a) Keep `Job` as the top-level unit; (b) introduce `Project` to group multiple jobs under one client engagement | (a) — no evidence DESPL groups jobs this way today | High — revisit only if a real multi-job engagement surfaces |
| **D3 — Should capacity constraints in scheduling be hard gates or advisory?** | `09` names this as the scheduling model's one real open question | (a) Advisory-only (flag overallocation, human decides); (b) Hard gate (cannot schedule if it overallocates) | (a) — consistent with the codebase's existing "refuse and explain, don't silently reallocate" philosophy, but advisory flags rather than refusing | Medium-high |
| **D4 — Should delay propagation ever become fully automatic (no human confirmation)?** | `09`/`18` Phase F scopes this as auto-*suggest* | (a) Auto-suggest only, human applies; (b) Fully automatic for delays below a threshold | (a) — preserves the named-human-approves-schedule-changes accountability model | High |
| **D5 — Should a formal `Team` model and manager hierarchy replace derived-at-read-time supervision?** | `13` names this as deferred, not decided | (a) Keep department + role + optional assignee; (b) Add `Team`/hierarchy models | (a) — defer until DESPL's org structure outgrows the current model | Medium — revisit if org growth is planned |
| **D6 — Should Sales/pre-Job activity ever enter the MOS boundary?** | `01`/`02` note no `Sales` department exists today | (a) MOS starts at `Job`, sales stays out of scope permanently; (b) Add a lead/opportunity/quote layer above `Job` | (a) — no evidence in schema, docs, or seed data that this is intended scope | Medium-high |
| **D7 — Formal cancellation workflow for a job mid-execution?** | `07` notes no first-class cancellation state exists at the `ProcessPlan`/`ComponentOperation` grain | (a) Leave out until a real scenario forces the question; (b) Add a `CANCELLED` state now | (a) | Medium |

## 4. Decisions this blueprint makes on its own authority (not escalated)

These were resolvable from verified evidence without needing a stakeholder decision:

- **The three-track domain model (fabrication/assembly/scheduling spine) is correct and should not be collapsed into one table** — the three concerns genuinely have different grains and different actors; only the *join* between them needs hardening (D1), not the model shape.
- **The modular monolith should not be split into microservices** — four non-negotiable invariants depend on single-transaction atomicity; a split would have to painstakingly re-create that across a network boundary for no evidenced benefit.
- **The reference-table-not-enum pattern is correct and should be extended, never abandoned**, including for any future document-category or KPI-definition vocabulary.

---
*Sources: consolidated from `01`–`19`, `CLAUDE.md`'s twelve invariants, `docs/ADR-product-family-agnostic-platform-v1.md`, `docs/DESPL_MOS_FORENSIC_AUDIT.md` §44, §48, §55, §56.*
