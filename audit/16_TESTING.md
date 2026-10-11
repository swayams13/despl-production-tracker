# 16 — TESTING AUDIT

*The suite is real and unusually good at the service layer. It has one
structural hole and five places that give false confidence.*

---

## 1. The suite as it stands

| | |
|---|---|
| Test files | **90** (~750 `it`/`test` cases) |
| DB-gated files | **54**, behind `RUN_DB_TESTS=1` against a real seeded PostgreSQL 16 |
| Playwright | **21 tests** across 4 projects |
| CI pipeline | lint → typecheck → `migrate deploy` → **`migrate diff --exit-code`** → seed → pure tests → **DB tests** → build → e2e, on every PR |

**The DB-gated tests genuinely run in CI.** This was checked specifically,
because ~60% of the suite is behind a skip flag. CI sets `RUN_DB_TESTS: "1"`
against a two-role Postgres built from `provision-db-role.sql`, so
`cross-tenant.test.ts`, `h1-job-isolation-rls.test.ts` and
`rls-coverage.test.ts` execute on every PR, against real RLS policies. That is
the opposite of mocked confidence and is the strongest part of the suite.

---

## 2. Coverage map

| Critical path | Unit | DB | E2E | Verdict |
|---|---|---|---|---|
| Authentication (password, unknown user, username vs email) | ✅ | ✅ | ✅ | **Covered** |
| Session expiry / `sessionVersion` invalidation | ✅ | ✅ | partial | Covered at service level; **the UI consequence (AUD-062) untested** |
| Forced password change | ✅ | ✅ | ✗ | Covered |
| RBAC — helper predicates | ✅ | ✗ | — | **Covered as functions only** |
| **RBAC — helpers actually applied per service** | — | partial | ✗ | **GAP** — see §4 |
| RBAC — per role, per action matrix | scattered | partial | ✗ | Partial — no single matrix |
| Cross-tenant isolation | — | ✅ | ✗ | **Covered — real RLS, real DB** |
| Cross-job isolation (H1) | — | ✅ ×3 | ✗ | **Covered — strongest area** |
| Client-user confinement | — | ✅ | ✅ | Covered |
| Project lifecycle (intake → schedule → dispatch) | ✅ | ✅ | ✗ | Covered at service level; **absent E2E** |
| Assignment / claim / release | ✅ | ✅ | ✗ | Covered; absent E2E |
| Start / Submit / Verify state machine | ✅ (52 KB) | ✅ | ✗ | Covered; absent E2E |
| Maker–checker | ✅ | ✅ | ✗ | Covered; absent E2E |
| Gating / predecessor rules | ✅ | ✅ | ✗ | Covered; absent E2E |
| Hold points | ✅ | ✅ | ✗ | Covered; absent E2E |
| Delay reason required | ✅ | ✅ | ✗ | Covered; absent E2E |
| NCR / rework | ✅ | ✅ | ✗ | Covered; absent E2E |
| Material availability, stock | ✅ | ✅ | ✗ | Covered; absent E2E |
| Drawing release | ✅ | ✅ | ✗ | Covered; absent E2E |
| Override / waiver | ✅ | ✅ | ✗ | Covered |
| Forecast / CPM computation | ✅ pure | ✗ | ✗ | **Covered — good pure coverage** |
| Progress / percent-complete | ✅ | ✅ | ✗ | Covered |
| Dashboard KPI calculations | ✅ | ✅ | ✗ | Covered |
| My Day filtering / partitioning | ✅ (32 KB) | ✅ | ✗ | Covered — **but see §3.2** |
| Command Center | ✅ | ✅ | ✗ | Covered |
| QC cockpit | ✅ | ✅ | ✗ | Covered |
| Notifications / alerts | ✅ | ✅ | ✗ | Covered (concurrency case not) |
| Cron orchestration | ✅ | ✅ | ✗ | Covered |
| Health / pending-migration probe | ✅ | ✅ | ✗ | Covered as a function; **the deployed contract is not** |
| **Any write performed through the browser** | — | — | **✗** | **ABSENT** |
| **`revalidatePath` correctness after a mutation** | — | — | ✗ | **ABSENT** |
| Responsive layout / overflow | — | — | ✅ | Covered |
| Touch-target size + spacing | — | — | ✅ | **Partial — one live `test.fail`** |
| Contrast | — | — | ✅ | **Partial — two `test.fixme`** |
| Keyboard navigation / focus order | — | — | ✗ | **ABSENT** |
| Screen-reader semantics | — | — | ✗ | **ABSENT** |
| Query count / performance regression | — | ✗ | ✗ | **ABSENT** |

---

## 3. Tests that give false confidence — named

**3.1 `src/lib/authz/authz.test.ts`.** It exercises `hasRole`, `requireRole`,
`requireDepartmentScope`, `assertClientScope`, `assertNotClientUser` and
`assertMakerChecker` as pure functions against hand-built `Actor` objects. That
is correct and valuable — but it proves only that the *predicates* are right,
**not that every service calls them**. The actual risk is a service function that
forgets `assertNotClientUser` or `requireDepartmentScope` entirely, and a
pure-function test can never detect that.

**This is not theoretical in this codebase.** `api/_lib.ts:68-83` documents that
*"every `/api` route was a bare `route(handler)` with no such check, so a client
user could `curl` internal delay-reason history, submitter identities and the raw
domain-event stream directly"* — a real omission of exactly this class, found by
audit rather than by test, and fixed by making the check the **default** in the
wrapper. Coverage reads as "RBAC: tested". See §4.

**3.2 `myday-workspace-parity.read.test.ts`.** Asserts two independently-written
counts agree — exactly the right test for this architecture, and building it at
all is the right instinct. But its own comment explains why it cannot catch the
divergence it exists to catch: *"The fixture deliberately makes 'assigned to me'
and 'in my department' coincide (actor is the ONLY member of, and ONLY assignee
in, one department)."* It pins the **number**, not the **predicate**, so AUD-036
passes it. **Rewrite the fixture so mine and department deliberately diverge.**

**3.3 `e2e/supervisor-viewport.spec.ts:73`** —
`test.fail(path === "/my-day" && project === "tablet", …)` — a **live,
reproduced, currently-shipping** 1px adjacent-target defect that reports as a
green run. The file's own comment says it best: *"a `test.fail()` is a defect in
hiding, not a note."*

**3.4 The two `test.fixme` contrast markers** (`--s-idle` at 2.20:1, light
`.c-hold` at 4.45:1). Honestly disclosed, but they render "contrast: tested"
green while two known AA failures ship.

**3.5 The `R2/R3 assertions — deferred` describe block.** Correct practice, but
it means three of the design spec's acceptance assertions are structurally
present and asserting nothing.

**3.6 Thin-to-absent coverage on modules with real defects.**
`welding.read.test.ts` is 1.1 KB against a 9.8 KB module carrying AUD-093;
`notifications.read.ts` has **no test file at all** and is on the layout's
critical path.

---

## 4. AUD-095 (P2) — convert "the helpers are correct" into "the helpers are applied"

Two additions, both cheap:

**A structural guard, in the pure tier.** Enumerate every exported function in
`src/lib/services/*.service.ts` and assert each one's source contains a call to
at least one of `assertNotClientUser` / `requireRole` / `requireDepartmentScope`.
A lint-style test that **fails when a new mutation is added without a gate**.

**A DB-gated table test.** Loop the exported mutations with a `clientId`-bearing
actor and assert `FORBIDDEN` for each. Then the same shape for each role
archetype once `02_ROLE_MODEL.md`'s `archetypeOf` lands — that becomes the single
role × action matrix the coverage map notes is missing.

---

## 5. AUD-068 (P1) — critical-path E2E test plan

**Zero E2E tests perform a mutation.** The suite is `auth.spec.ts` (9 tests) and
`supervisor-viewport.spec.ts` (layout, touch targets, theme flash, contrast) plus
`auth.setup.ts`.

There is **no browser-level test that a maker cannot verify their own
submission**, that a gated process refuses to start, or that a hold point blocks
completion. Those rules are well covered at the service layer — but the service
layer is not what a user touches. Between the tested service function and the
tested login page sit the Server Action wrappers, `revalidatePath` correctness,
the optimistic UI and the `disabled={pending}` guards. **None of which any test
exercises.**

**The highest-value refusals in the product — the ones that make it an auditable
MOS rather than a spreadsheet — are proven at the function level and unproven at
the product level.**

### Prerequisites

The infrastructure is already there: `auth.setup.ts` logs in through the real
form (never a forged session — see CLAUDE.md's agent-conduct rule), and CI seeds
a real database and runs `pnpm e2e` on every PR. Adding a **QC identity** and a
**second fabrication supervisor** to `auth.setup.ts` unblocks the entire negative
set. Add `e2e/fixtures/reset.ts` to reset DESPL-320's plan states between specs
so the suite is order-independent.

**Each scenario asserts the stable error code surfaced in the UI, not prose.**

### Happy path

1. **Claim → Start → Submit → Verify, end to end.**
   *Given* `sup.fabrication` is signed in and `/my-day` shows an unassigned
   NOT_STARTED plan whose predecessors are all COMPLETE,
   *when* they Claim, Start, Submit for QC, then `qc.inspector` signs in, opens
   `/qc`, finds it at the top of the queue and clicks Verify,
   *then* the plan reads COMPLETE, the `/jobs` row's % and mini-spine advance,
   and the stage segment on the job page renders `complete`.
2. **Assign from a supervisor to a team member.** The row moves to the team view
   showing that member's name, and appears under "Mine" on that member's My Day.
3. **File a delay reason and start.** Start succeeds, the reason appears in the
   StageSheet's delay history, and "reasons pending" decreases by one.
4. **StageSheet reflects reality.** For a stage with more than one backing
   process, the drawer lists every backing process with its plan status, names
   the governing plan, and shows the contributing component operations.

### Negative — each must be refused with the exact code

5. **`GATING_BLOCKED`** — Start on a plan whose predecessor is NOT_STARTED; the
   plan is still NOT_STARTED after reload.
6. **`MAKER_CHECKER_VIOLATION`** — a plan submitted **by** `qc.inspector` (who
   also holds QC); that same user clicks Verify. **This is the single most
   important negative test in the suite — it is the rule that makes the tracker
   auditable.**
7. **`REASON_REQUIRED`** — the department has an overdue plan on this unit with
   no reason filed; Start on a *different* plan for the same unit.
8. **`HOLD_POINT_OPEN`** — a process linked to a `blocksCompletion` checkpoint
   whose latest execution is not ACCEPTED; verification is refused. **And when QC
   first records it ACCEPTED, verification succeeds.**
9. **`MATERIAL_NOT_AVAILABLE`** — a component operation whose BOM item is short.
10. **`NCR_OPEN`** — submit the covering process for a unit with a non-CLOSED NCR.
11. **`DRAWING_NOT_RELEASED`** — start work against a component whose governing
    drawing's latest revision is not RELEASED.
12. **`FORBIDDEN` — department scope** — `sup.machine_shop` deep-links to a
    fabrication plan and attempts Start. *(`requireDepartmentScope` is
    unit-tested; that a deep link cannot bypass it is not.)*
13. **`NOT_IN_DEPARTMENT` — claim** — an ADMIN with no department memberships
    attempts to claim a fabrication pool plan. The deliberate non-bypass, proven
    only at the service layer today.
14. **`ALREADY_ASSIGNED` — concurrent claim** — two browser contexts, two members
    of the same department, both click Claim; exactly one succeeds and the plan
    has exactly one assignee.
15. **Double-submit idempotency** — Submit clicked twice within the pending
    window; exactly one `ProcessSubmitted` event exists (assert via
    `/api/events?job=`) and the button was disabled for the second click.
16. **`CLIENT_SCOPE_VIOLATION`** — a client user requests another client's job via
    the API. *(The blanket internal-API block is covered; the cross-client case is
    not.)*
17. **Cross-tenant** — a tenant-A user navigates to a tenant-B job id and gets
    not-found, never tenant B data.

### New negative tests for this audit's findings

18. **`WAIVER_NOT_APPROVED`** (AUD-003) — a QC user records `NA` on a blocking
    hold point without PH approval; refused. A PH records the same and it is
    accepted, with `waiverApprovedBy` set.
19. **`EXTERNAL_PARTY_HOLD`** (AUD-004) — verifying an assembly step linked to a
    checkpoint with a `BUYER_TPI` blocking code does **not** stamp it ACCEPTED.
20. **`UNIT_NOT_COMPLETE`** (AUD-005) — a unit with all stages NOT_STARTED cannot
    be released or dispatched. And: a unit batched clean, then given an NCR, is
    refused at release.
21. **`NCR_NOT_DISPOSITIONED`** (AUD-026) — re-verifying a reworked operation with
    an OPEN NCR is refused; after disposition it succeeds and the NCR closes with
    `disposition` set.
22. **`PROCESS_NOT_OPTIONAL`** (AUD-033) — intake refuses to exclude HYDROTEST.
23. **Client boundary** (AUD-025) — loop **every** route in the `(app)` group with
    a client session and assert a redirect to `/portal`.

### Reliability

24. **Stale-write detection** — two supervisors with the job-details editor open;
    the second save is refused with `STALE_WRITE`. **This should fail today** and
    is the acceptance criterion for adding optimistic concurrency.
25. **Expired session** — a signed-in supervisor whose cookie is cleared clicks
    Start; they land on `/login?next=/team` and return there after signing in.
    **Fails today — AUD-062.**
26. **Pending migration blocks the deploy** — a container whose
    `prisma/migrations/` contains a directory absent from `_prisma_migrations`
    returns 503 from `/api/health` listing the pending names. Asserts the
    *deployed contract*, not just the function.
27. **`revalidatePath` freshness** — starting a plan from `/my-day` updates the
    row without a manual reload. **Fails today — `13_API_AUDIT.md` §3.**

### Accessibility — add as a fourth Playwright project

28. **Keyboard-only StageSheet** — tab to a work row, press Enter, the sheet
    opens, focus moves inside, Escape closes, focus returns. **Fails today —
    AUD-064.**
29. **Axe sweep** — `@axe-core/playwright` across `/my-day`, `/team`, `/qc`,
    `/jobs`, `/dashboard` at three viewports, zero serious or critical
    violations. Add with an allowlist of the currently-known failures so it gates
    regressions from day one.
30. **Full contrast sweep** — replace the two `test.fixme` markers with real
    assertions once AUD-066 lands. Add the deterministic all-statuses fixture the
    design spec asks for — a non-demo seeded job with one unit at each of the six
    states — so chips and spine fills can be asserted across all three palettes.

---

## 6. Regression tests this audit's fixes require

Beyond the E2E plan, these belong in the DB-gated tier:

| Finding | Test |
|---|---|
| AUD-001 | Extend `rls-coverage.test.ts` with a second query keyed on `col.column_name = 'job_id'` and `p.polname = 'tenant_isolation'`, asserting an empty unprotected set. **This makes the next omission fail CI** — and the current version is structurally blind to it |
| AUD-027 | A plan due today is overdue in **neither** the view nor `isOverdue()` at 04:00 IST |
| AUD-030 | A job with one excluded mid-spine process can reach `complete` on that stage |
| AUD-034 | Attempting a second `is_current` run for a job violates the new unique index |
| AUD-036 | Rewritten parity fixture where mine and department **diverge** |
| AUD-110 | `gating.test.ts` case covering a spliced FTS→overlap chain |
| AUD-029 | A CI assertion that for every `OperationRef.requiresDftGate = true`, a writer for `PaintRecord` is reachable from `src/app/` |
| AUD-055 | A query-plan test asserting `v_unit_stage_status`'s `job_id` appears as an index condition, not a filter above a CTE Scan |
| Prior roadmap's exit gate | *"No service function in `src/lib/services/` has zero callers outside its own test file"* — make it a test, not a checklist item |

---

## 7. What is solid

- **Real database, real policies.** 54 files run against a seeded PostgreSQL 16
  with the actual RLS in place. `cross-tenant.test.ts` exercises real service
  functions against two real tenants on a real `despl_web` connection.
- **`prisma migrate diff --exit-code` in CI** proves the migrations produce the
  schema `schema.prisma` describes. Most teams do not have this control.
- **Playwright authenticates through the real login form and never forges a
  session** — a rule the project wrote down after a real incident, and enforces.
- **Real viewport testing.** `supervisor-viewport.spec.ts` runs a
  phone/tablet/desktop matrix asserting no horizontal overflow, 48px minimum
  touch targets, 8px minimum spacing, a 56px primary-action floor, no
  wrong-theme flash, and that the queue/standard swap actually flips at 640px.
  **Very few products test this.**
- **`e2e/wcag-contrast.ts` is a correct, hand-verified implementation of the WCAG
  formula.** This audit's independent computation of `--s-idle` at 2.20:1 against
  `--surface` **matches the team's own recorded figure exactly.**
- **The pure scheduling tier is well covered** — `cpm`, `calendar`, `envelope`,
  `gating`, `exclude`, `feasibility`, `terminal`, `validate`, `override` all have
  focused table-driven tests, which is what an engine of that shape needs.
- **`myday-workspace-parity.read.test.ts` exists at all.** Asserting that two
  independently-written read models agree is exactly the right instinct for this
  architecture. The fixture is too weak; the idea is right, and it generalises —
  every duplicated definition this audit found (`overdue`, percent complete,
  hold-point status) deserves the same treatment once consolidated.
- **CI comments explain *why* each step exists**, usually by naming the incident
  that motivated it.

**The gap is not rigour. It is that the rigour stops at the service boundary, and
the product's most important guarantees live on the other side of it.**
