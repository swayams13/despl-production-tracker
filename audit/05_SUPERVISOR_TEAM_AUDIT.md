# 05 — SUPERVISOR / TEAM AUDIT

*A supervisor has two concerns — their own work, and their team's workload.
The product conflates the first and does not serve the second at all.*

---

## 1. AUD-010 (P0) — the Team surface does not exist

Verified absent three ways:

```
ls "src/app/(app)" | grep -i team          → no match
grep -rn "/team" src/ --include=*.ts*      → no match
ls src/lib/services | grep -i team         → no match
```

No route, no read model, no nav item. Supervisor team-management is instead
scattered across three places, none of which does the job:

| Where | What it gives | What is missing |
|---|---|---|
| **My Day** | `pool`, `teamHeld`, `deptMembers`, per-row assign/release | No workload context. The assign control is a bare `<select>` of names |
| **Command Center** | A genuine department cockpit — but `command/[dept]/page.tsx:32` redirects **floor** departments to `/workspace`, so welding, fabrication and machining supervisors have no equivalent at all | No assignee field on the row type |
| **Departments/[id]** | An open-items table | `DeptOpenItem` has **no `assigneeUserId`** — you cannot tell who owns anything |

Per-person workload exists in exactly one place in the entire codebase:

```ts
// admin.read.ts:76-88
tx.processPlan.groupBy({
  by: ["assigneeUserId"],
  where: { assigneeUserId: { not: null }, status: { not: "COMPLETE" },
           scheduleRun: { isCurrent: true }, jobProcess: { job: { tenantId } } },
  _count: { _all: true },
})
```

…on `/admin`, which `admin/page.tsx:10` gates to ADMIN and MANAGEMENT. **Supervisors
cannot reach it.**

**Net:** a fabrication supervisor with twelve people cannot answer "who is
overloaded, who is idle, is anyone sitting on a blocked item, what is unclaimed
and about to go overdue" — the four questions that constitute their job. They do
it on paper, and the tracker's assignment data goes stale, which then poisons My
Day for everyone downstream.

**Root cause:** the "personal dashboards v1" roadmap delivered the personal view
and the office-desk view and skipped the floor-supervisor view; its requirements
were absorbed into My Day because that page already had the pool data loaded.

---

## 2. AUD-046 (P1) — "My Workspace" filters by nobody

```ts
// workspace.read.ts:441-442
const seesAll = hasRole(actor, ADMIN, PRODUCTION_HEAD, MANAGEMENT);
const scopedDeptIds = seesAll ? new Set(departments.map(d => d.id)) : new Set(actor.departmentIds);
```

`assigneeUserId` appears **nowhere** in `loadWorkspaceView` — grep-confirmed
across the whole 1,002-line file. The header renders `<h1>My Workspace</h1>` and
the sidebar label is "My Workspace".

It is also pinned to one job by the hardcoded string `"DESPL-320"` (AUD-007), and
when that job is absent the page renders *"No current schedule for this job.
Generate one, or run the demo bootstrap, to see the worklist."* — leaking
developer vocabulary into production UI, against the project's own copy rules.

**Two surfaces both claim to be "mine" and neither filters by the logged-in user.**
The only place in the product that reliably answers "my work" is the `mine` array
inside My Day.

---

## 3. AUD-070 (P1) — Management sees action buttons they are forbidden to press

```ts
// workspace.read.ts:441 — MANAGEMENT is in the see-everything set
const seesAll = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.MANAGEMENT);

// authz/index.ts:109-111 — but the scope bypass is ADMIN and PH only
export function requireDepartmentScope(actor: Actor, departmentId: number): void {
  if (hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) return;
  if (!actor.departmentIds.includes(departmentId)) throw new AppError(ERROR_CODES.FORBIDDEN, …);
}
```

`workspace/_client.tsx` renders Start / Start all / Verify with **no role prop at
all**. So an MD sees every department's rows with live buttons that throw
`FORBIDDEN`.

`DESIGN_SPEC.md:66-67` states the opposite requirement explicitly: *"Management
user sees no action buttons at all — same pages, read-only."* `/command/[dept]`
gets this right (`const canAct = access === "full"`, passed to the client);
Workspace does not.

**Impact:** the MD clicks "Start all" on an overdue card to unblock a shipment,
gets a red error, concludes the tracker is broken, and phones the supervisor.

---

## 4. The claim / assignment model — direct answers

The model itself is **well built**. `assignment.service.ts:24-32` states the
governing invariant: *"D16 (non-negotiable): assignment never influences gating.
This file never imports process.service.ts or touches a gate check."*

**Why can a user claim work?**
Because no plan is ever created with an owner. `schedule.service.ts:140-150`
builds `PlanInput` with no `assigneeUserId`; `schema.prisma:1084` defaults it to
NULL. The pool is 100% of the schedule at generation time, draining only as
people claim.

**Is work intentionally unassigned?**
Yes — it is the *only* initial state, and `assignment.service.ts` is the sole
writer of that column.

**Who may claim?**
Any active non-client user who belongs to the plan's owning department —
deliberately **not** an admin bypass (`:50-55`), with the reasoning written down:
*"an ADMIN with no department membership must NOT be able to claim into a pool
they don't belong to."* Refuses if `COMPLETE` or already assigned.

**Who may assign?**
`requireRole(SUPERVISOR, PRODUCTION_HEAD, ADMIN)` then `requireDepartmentScope`
(PH/ADMIN bypass). The target must hold the owning department
(`ASSIGNEE_NOT_IN_DEPARTMENT`) and be active (`ASSIGNEE_INACTIVE`).

**What happens after a claim?**
`assigneeUserId` set; audit row + `PlanClaimed` domain event in the same
transaction; **no notification**, deliberately (*"the affected user IS the actor…
notifying yourself about your own action is noise"*). `assignPlan` **does** notify
the assignee.

**Is there a race allowing two people to claim the same activity?**
**No — this is correctly handled.**

```ts
// _shared.ts:463-481
await tx.$queryRaw`SELECT id FROM process_plans WHERE id = ${processPlanId} FOR UPDATE`;
const row = await tx.processPlan.findFirst({ where: { id, ownerDepartment: { tenantId } } });
if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, …);
await tx.$executeRaw`SELECT set_config('app.job_id', ${String(row.jobId)}, true)`;
const run = await tx.scheduleRun.findUnique({ where: { id: row.scheduleRunId }, select: { isCurrent: true } });
if (!run?.isCurrent) throw new AppError(ERROR_CODES.STALE_WRITE, …);
```

The `assigneeUserId != null` check reads the row **after** the lock, so the second
claimant blocks on `FOR UPDATE`, then reads the committed value and is refused
with `ALREADY_ASSIGNED`. The refusal even renders inline with its code. A stale
tab cannot claim into a superseded run.

**Is supervisor reassignment audited?**
Yes, fully. All three paths write `audited(tx, actor, …)` with explicit
`before`/`after` plus a domain event: `PlanClaimed`, `PlanAssigned`,
`PlanReleased`. `releasePlan` allows four principals (assignee, dept supervisor,
PH, ADMIN) and deliberately skips a no-op audit row *after* the permission check,
so a forbidden no-op is still refused. That distinction is subtle and correct.

---

## 5. AUD-038 (P1) — the defect is placement, not implementation

The pool is browsable, filterable and always visible on the **individual's**
dashboard, and the supervisor's assign control is a `<select>` of names with **no
workload context**:

```jsx
// _client.tsx:338-351
<select className="btn" aria-label={`Assign ${row.processName} to…`} …>
  <option value="">Assign to…</option>
  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
</select>
```

`deptMembers` is `{ id, name }` only — no open-item count, no capacity, no
overdue count. The supervisor picks a name from an alphabetical list with no idea
who already has forty items.

**Consequence — cherry-picking.** Ten operators each see the same pool and each
claim the easy, low-float items. The critical-path item nobody wants sits
unclaimed while every individual's screen looks busy. The supervisor, who should
be arbitrating exactly that, has no screen showing the pool as a management
problem.

**Resolution.** Pool browsing, `assignPlanAction`, `releasePlanAction` and bulk
assign move to `/team`. My Day keeps exactly one pool affordance: **"Claim
next"** — one tap, top-ranked by `compareRankedPlans`. Pull-based, but the
priority order is the system's.

---

## 6. AUD-081 (P2) — Command Center: 13 containers, 9 tables, on one screen

DOM order (`command/[dept]/_client.tsx:139-277`): a `grid-h` with 2 cards →
`dept-grid` with **6 pipeline cards, each containing its own table** → a `grid-h`
with 2 more cards → 3 KPI tiles. Total: **13 bordered containers, 9 `<table>`s,
1 week strip, 3 KPI tiles.**

The six pipeline cards are the project's own hard ban: *"N identical repeated
cards (always aggregate into grouped tables / matrices with bulk actions)"*. Each
caps at 6 rows with a `+N more` row that is **not a link** — `EmptyRow` renders a
`<p className="note">`, so it is a dead end.

The information is also duplicated within the screen: `decideToday` is the top-5
of `actionable`, and every one of those same rows renders again in whichever
pipeline column matches its state — the top item appears twice, ~200px apart,
with different chip treatment.

There is **no primary action anywhere on the page**. Every row's only interaction
is opening the StageSheet, gated `canAct && unitId != null` — and office
departments routinely have job-grain plans where `unitId` is null, so for those
rows the entire page is inert while still advertising `cursor: pointer`.

---

## 7. Column classification

### Command Center `CommandRow` — 4 columns, reused 9×

| Column | Class | Note |
|---|---|---|
| Job (90px) | SECONDARY | Keep |
| Process (+ subtitle) | ESSENTIAL | Keep |
| Due (70px) | ESSENTIAL | Keep |
| Status chip (140px) | ESSENTIAL | Keep |
| **Owner** | **ESSENTIAL — MISSING** | `CommandCenterRow` has no assignee field. A department cockpit with no owner column |

The four-column set is genuinely well judged and consistently reused. **The
problem is nine of them on one screen, not the column set.**

### Workspace per-process unit table — 6 columns

| Column | Class | Recommendation |
|---|---|---|
| Unit (`serialNo`, 90px) | **ESSENTIAL** | Make it the sticky identifier column |
| Due (80px) | ESSENTIAL | Keep |
| Overdue (`{n}d`) | SECONDARY | Fold into Due |
| Delay reason / status — a `<select>` on overdue rows, otherwise `colSpan={2}` of reason text | DETAIL | **Move to drawer.** A `<td>` whose colSpan changes per row is why this table cannot be scanned |
| *(unnamed)* detail `<input>` | DETAIL | Move to drawer |
| *(unnamed, 200px)* File + state action | ESSENTIAL | Keep one action |
| **Fetched, never rendered** | | `openNcrCount` (a dedicated query with a two-branch nested OR) and per-row `criticalPath` — see AUD-082 |
| **Reduced set** | | **Unit (sticky) · Due · Status · Action** = 4 columns, plus a rework chip from `openNcrCount` |

---

## 8. Proposed Team specification

Route `/team` (and `/team/[deptId]` for PH/ADMIN across departments). Gate:
`hasRole(SUPERVISOR, PRODUCTION_HEAD, ADMIN)` — reuse
`resolveCommandCenterAccess`'s shape, which already returns `full | readonly |
none` and is unit-tested.

| # | Section | Content | Data already exists at |
|---|---|---|---|
| 1 | **Header + department KPIs** | Dept · open · on-time% · overdue · blocked · open rework | `departments.read.ts:20-30` `DeptCard` via `loadDepartmentCards` — already reused verbatim by `command-center.read.ts:382` |
| 2 | **Workload by employee** *(the missing centrepiece)* | Person · Assigned · Overdue · Due today · Blocked · Oldest item · Reassign. Sorted by overdue desc | Counts: lift `admin.read.ts:76-88`'s `groupBy(["assigneeUserId"])` into a shared `loadAssigneeOpenCounts(tx, tenantId, deptIds)`. Per-person rows: group `myday.read.ts:262`'s `teamHeld` by `assigneeUserId`. Names: `myday.read.ts:297-304` already backfills them in one query |
| 3 | **Unassigned pool** | Paginated 25/page. Filter by process / due window / job. Multi-select → "Assign to…" with each person's open count in the option label, and "Claim all" | Rows: `myday.read.ts:261`. Members: `myday.read.ts:367-376` — **extend to `{id, name, openCount, overdueCount}`** |
| 4 | **Overdue & blocked** | Dept-wide overdue with delay-reason status; blocked with "Waiting on: X" | Overdue: `prioritize()`'s `overdue` flag. Blocked + reason: `prioritizer.ts:99-102`. Filed-vs-unfiled: `workspace.read.ts:931` already queries this for `loadJobKpis` |
| 5 | **Dependencies** | "You're blocking" — other departments' BLOCKED plans waiting on this dept; "Waiting on others" | `command-center.read.ts:280-296` and `:343` — **lift verbatim**; office-only today, works for any department |
| 6 | **By process** *(absorbed from `/workspace`)* | Per-process grouping with the bulk toolbar: "Apply reason to all overdue", "Start all" | `workspace.read.ts:503-541` + `workspace/_client.tsx:191-236` — move as-is |
| 7 | **Team completion** | Dept on-time %, cleared today (any assignee), 7-day throughput | `command-center.read.ts:299-325` + `DeptCard.onTimePct` |
| — | **Nav badge** | Department overdue count | `loadMyOverdueCount` renamed `loadDeptOverdueCount` — it is already exactly this query |

**Every one of the seven sections is supplied by code that exists today.**
Section 2 is the only one requiring new composition, and its aggregate query is
already written. This is a move, not a build.

### The two counts, after the split

| Function | Predicate | Badges |
|---|---|---|
| `loadMyOverdueCount` | `assigneeUserId: actor.userId` + overdue + isCurrent | **My Day** |
| `loadDeptOverdueCount` | `ownerDepartmentId IN actor.departmentIds` + overdue + isCurrent | **Team** |

Then rewrite `myday-workspace-parity.read.test.ts` so "mine" and "department"
**diverge** in the fixture. That is the case the test needs to catch, and today
it is engineered not to.

---

## 9. Also to fix on this surface

- **AUD-083 (P2)** — `/workspace` and `/alerts` regress from My Day's inline
  refusal feedback to toast-only. A `REASON_REQUIRED` refusal on a bulk action
  shows a red toast at bottom-right while the offending rows stay unmarked.
  Extract `useRun` + `RefusalNote` and adopt them.
- **AUD-090 (P2)** — `command-center.read.ts:243` calls `computeCpm`, not
  `computeCpmSafe`. One malformed job spine 500s the whole page for six office
  departments simultaneously. `myday.read.ts:201-202` — the same loop, written for
  the same reason — gets this right and explains why in a comment.
- **AUD-044 (P1)** — no `loading.tsx` on `/team`'s predecessor routes. Add one
  that renders the real section chrome with shimmer rows; `globals.css:1005`
  already ships a `.skel` shimmer with `prefers-reduced-motion` support that
  nothing on these routes uses.
