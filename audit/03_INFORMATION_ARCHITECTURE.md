# 03 — INFORMATION ARCHITECTURE

*The central document of this audit. Everything in `04`–`09` is a consequence of what is here.*

---

## 1. The problem in one sentence

Ten surfaces were each built well, in sequence, against a spec that grew — and
none of the earlier ones was retired when a better answer to the same question
arrived.

---

## 2. Responsibility overlap matrix

For each existing surface: what question does it actually answer today, what data
does it show, which other surface already answers that, and what should happen to
it.

| Surface | Question it answers today | Primary data | Duplicates | Verdict |
|---|---|---|---|---|
| `/dashboard` | **Two:** "how is the portfolio?" *and* "how is one project doing?" | `loadPortfolio` + `loadJobKpis` (a *workspace* read model) | Project half duplicates `/jobs/[id]`, `/departments`, `/qc` | **NARROW** — portfolio only |
| `/my-day` | "What is due in my department, mine or not, and who holds it?" | `loadMyDay` → `mine` + `pool` + `teamHeld` + `deptMembers` | `pool`/`teamHeld` duplicate the missing Team; "With QC" tab duplicates `/qc` | **NARROW** — `mine` only |
| `/workspace` | "One job's worklist for my departments" — pinned to DESPL-320 | `loadWorkspaceView` (single-job) | `/command/[dept]`, `/departments/[id]`, `/my-day` | **KILL** — absorb card grouping + bulk actions into Team |
| `/command/[dept]` | "What must this **office** department decide today?" | `loadCommandCenter` — cross-job, prioritised, with `blocking`/`waitingOnOthers` | `/workspace`, `/departments/[id]` | **KEEP & PROMOTE** → becomes `/team` for all departments |
| `/departments` | "How is each department performing?" | `loadDepartmentCards` | none | **KEEP** ✅ |
| `/departments/[id]` | "This department's task list, + cycle time, + delay reasons" | `loadDepartmentDetail` | `openItems` duplicates Workspace/Command | **NARROW** — drop `openItems` |
| `/qc` | "What must QC verify / clear / disposition?" | `loadQcCockpit` (tenant-wide) | `/workspace` QC blocks, `/my-day` QC tab, `/dashboard` holds card | **KEEP** as canonical; **gate it** |
| `/welding` | "Welder productivity + repair rate + weld logging" | `loadWeldingView` | none | **KEEP** ✅ |
| `/jobs` | "Every project, one row each" | `loadJobs`, paginated at 50 | Overlaps the dashboard's portfolio band | **KEEP**; fold the band in as a list view |
| `/jobs/[id]` | "Everything about this project" — 9 tabs | 10 read models, lazily loaded per tab | The dashboard's project half duplicates *it* | **KEEP** ✅ — this is the canonical Projects surface |
| `/jobs/new` | "Create a job" | `job-intake.read` | none | **KEEP** ✅ |
| `/reports` | "Yesterday's digest + history" | `loadDailyDigest`, `loadDigestHistory` | none | **KEEP + BROADEN** to analytics |
| `/alerts` | "My notification history" | `loadNotifications(actor, 200)` | Bell dropdown, by design | **KEEP** as a utility, not top-level nav |
| `/board` | **nothing** — stub | none | — | **KILL** |
| `/profile` | **nothing** — stub | none | — | **KILL** |
| `/admin/*` | "Master data + users" | `admin.read`, template/route/QCP readers | none | **KEEP** ✅ |
| `/portal` | "As a client, what is the verified status of my orders?" | `loadClientPortalView` — VERIFIED snapshots only | none | **KEEP AS-IS** ✅ |
| **Team** | — | — | — | **DOES NOT EXIST** — must be built |

---

## 3. AUD-019 (P0) — three surfaces answer "what is my department working on?"

All three render a department-scoped list of open `ProcessPlan` rows from the same
`isCurrent` schedule run:

| | Scope | Extra value |
|---|---|---|
| **Workspace** | **Single job** (`workspace.read.ts:441-442`) | Per-`jobProcess` card grouping; `CardBulkActions` ("Start all", bulk delay reason) |
| **Command Center** | **Cross-job**, *office departments only* (`command/[dept]/page.tsx:32` redirects floor depts to `/workspace`) | `decideToday`, `pipeline`, **`blocking`**, **`waitingOnOthers`**, `week`, reuses `DeptCard` |
| **Departments/[id]** | **Cross-job**, all departments | Cycle time, delay-reason breakdown, open rework |

The routing rule deciding which one you get is a `Department.isOfficeDept`
boolean — not anything a user would predict. Both `my-day/page.tsx:66-73` and
`departments/[id]/page.tsx:26-28` have to render a *conditional* "Command Center →"
link with a comment explaining it would otherwise be a dead control.

**Two supervisors comparing screens see different numbers for the same
department**, because Workspace is one job and the other two are all active jobs.

**Resolution.** Command Center's read model is the strongest of the three:
cross-job, prioritised, carries genuine dependency intelligence, and reuses
`loadDepartmentCards` rather than recomputing it (its own comment cites the
"no second definition" rule). Promote it.

- `/command/[dept]` → **`/team/[dept]`**, serving floor *and* office departments.
  Delete the `isOfficeDept` redirect; `PIPELINE_LABELS` already falls back to
  `DEFAULT_PIPELINE_LABELS` for departments with no custom labels.
- **Retire `/workspace`** → redirect to `/team`. Migrate its two unique assets:
  the per-process card grouping and the bulk toolbar.
- **Narrow `/departments/[id]`** to performance only: drop `openItems`, keep
  cycle time, delay-reason breakdown, open rework, `DeptCard`.

---

## 4. AUD-041 (P1) — the QC queue exists on four surfaces with four scopes

"Awaiting verification" and "Open hold points" are each rendered four times:

| Surface | Scope | Bound | Sort |
|---|---|---|---|
| `/qc` | tenant-wide | **unbounded** | age desc, **client-side** |
| `/workspace` | one job | job-scoped | server |
| `/my-day` "With QC" tab | actor's active jobs, re-derived client-side from three arrays | — | client |
| `/dashboard` | one job | top 5 | server |

Four scopes, four code paths, one question. Three separate implementations of the
hold-point "latest attempt wins" status ladder (`workspace.read.ts`,
`qc-cockpit.read.ts`, `qcp-grid.read.ts`), plus three more in the read layer.

**A QC inspector's queue count differs on every screen they open.**

**Resolution.** `/qc` is canonical and owns hold points. Extract one
`resolveHoldPointStatus(attempt, requiresCall, plannedStart, now)` used by all
call sites. Elsewhere show a **count** that deep-links to `/qc?job=…`. My Day's
"With QC" tab shows only rows where `assigneeUserId === actor.userId` — the
inspector's own submissions awaiting someone else, not the global verify queue.

---

## 5. Target information architecture

Eight canonical surfaces, each with exactly one responsibility.

| # | Surface | Route | Action | Notes |
|---|---|---|---|---|
| 1 | **Dashboard** | `/dashboard` | **KEEP + NARROW** | Portfolio only. Delete the `loadJobKpis` call, `JobSelector`, and every project-scoped card. Add at-risk, promise-variance, bottleneck departments, intervention queue. |
| 2 | **My Day** | `/my-day` | **KEEP + NARROW** | `mine` + `blocked` + `completed` + `scoreboard` + approvals assigned to me. Remove `pool`, `teamHeld`, `deptMembers`. **Add to desktop nav.** |
| 3 | **Team** | `/team`, `/team/[deptId]` | **BUILD — by promoting `/command/[dept]`** | Rename; drop the `isOfficeDept` redirect. Add workload-by-employee, capacity, pool, reassignment, escalation. Absorb Workspace's bulk toolbar. |
| 4 | **Projects** | `/jobs`, `/jobs/[id]`, `/jobs/new` | **KEEP** | Already the control centre. Fold the dashboard's portfolio band into `/jobs` as a list view. Renaming to `/projects` is optional and low-value. |
| 5 | **Departments** | `/departments`, `/departments/[id]` | **KEEP + NARROW** | Performance only. Drop `openItems`; render `openReworkCount`, already computed and discarded. |
| 6 | **QC & Hold Points** | `/qc` | **KEEP + GATE** | Sole owner of the verify queue and hold points. Add a role gate, filters, pagination, project→unit hierarchy. |
| 7 | **Welding** | `/welding` | **KEEP** | Single-purpose already. Make its job selector read the global `?job=`. |
| 8 | **Reports** | `/reports` | **KEEP + BROADEN** | Today only the daily digest. Historical and analytical reporting belongs here, not on the dashboard. |
| — | Workspace | `/workspace` | **RETIRE** → redirect to `/team` |
| — | Board | `/board` | **RETIRE** — stub. Rebuild as a Team view mode; its stated content (state columns) is `prioritizer.ts`'s `PlanState` grouping, already computed |
| — | Profile | `/profile` | **RETIRE** — stub. Fold into account/theme controls |
| — | Alerts | `/alerts` | **KEEP as a utility** — reached from the bell, not top-level nav |
| — | Admin | `/admin/*` | **KEEP** — correctly gated |
| — | Portal | `/portal` | **KEEP AS-IS** — see §8 |

---

## 6. AUD-011 / AUD-012 (P0) — navigation

Two hard-coded, non-overlapping arrays in `app-shell.tsx`, selected by **viewport,
not role**:

```ts
// :127-135 — icon rail (<1024px) and phone bottom bar
const SHELL_NAV = [ /my-day, /workspace, /qc, /jobs, /board, /alerts, /profile ];

// :144-165 — desktop sidebar (≥1024px)
const NAV = [
  { group: "Overview",  items: [ /dashboard, /jobs ] },
  { group: "Execution", items: [ /workspace, /departments, /qc, /welding ] },
  { group: "Records",   items: [ /reports ] },
];
```

Consequences, each independently a defect:

- **`/my-day` has no desktop nav item** — yet every SUPERVISOR and QC user is
  landed there. One click away and it is unreachable except by URL.
- **`/dashboard`, `/departments`, `/welding`, `/reports`, `/admin` have no
  tablet or phone item** — the shop floor and a walking MD cannot reach them.
- **`/command/[dept]` is in neither** — reachable only via a conditional text
  link on My Day.
- The sidebar's first entry, `/dashboard`, is a **dead control** for supervisors:
  it immediately redirects them back to `/my-day`.
- `/board` and `/profile` are in the shop-floor bar and are stubs.

The only role branching in the entire nav is the Admin group (`:202-216`).
`userRoles` is passed into `AppShell` and used for nothing else.

### Proposed role × navigation matrix

| Surface | Operator *(new)* | Supervisor | Planner *(new)* | QC | Management | Admin |
|---|---|---|---|---|---|---|
| **Dashboard** | — | — | ✅ | — | ✅ **(landing)** | ✅ **(landing)** |
| **My Day** | ✅ **(landing)** | ✅ **(landing)** | ✅ **(landing)** | ✅ **(landing)** | — | — |
| **Team** | — | ✅ | ✅ own dept | — | ✅ read-only | ✅ all depts |
| **Projects** | ✅ read-only | ✅ | ✅ + `/jobs/new` | ✅ read-only | ✅ | ✅ |
| **Departments** | — | ✅ own dept | ✅ | — | ✅ | ✅ |
| **QC & Hold Points** | — | — | — | ✅ | ✅ read-only | ✅ |
| **Welding** | ✅ *if in welding dept* | ✅ *same* | — | ✅ NDT | ✅ read-only | ✅ |
| **Reports** | — | ✅ own dept | ✅ | ✅ QC | ✅ | ✅ |
| **Admin** | — | — | — | — | ✅ `/admin` only | ✅ all |
| Alerts (bell) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Implementation:** one `NAV_ITEMS` registry — `{href, label, icon, roles,
departmentGated?}` — and one `visibleNav(actor)` selector, rendered into all
three chrome variants. **Viewport changes presentation density only, never which
destinations exist.**

---

## 7. AUD-039 (P1) — project context is not real

`DESIGN_SPEC.md:71` requires: *"job switcher actually switches job context (all
dashboards/pages re-scope)."* What it does (`app-shell.tsx:400-408`) is
`router.push('/jobs/:id')` — it navigates. It sets no context.

Worse, the badge lies. `app-shell.tsx:223-224` falls back to `jobs[0]` whenever
the path is not `/jobs/:id`, so on `/dashboard`, `/my-day`, `/qc` and `/workspace`
the topbar confidently displays a *different* project's number and mini-spine
than the one the page is scoped to. And it is hidden below 1024px, so the shop
floor has no project context control at all.

Meanwhile there are **five** separate project-filter mechanisms:

| Surface | Mechanism | URL-driven? |
|---|---|---|
| Topbar | `router.push('/jobs/:id')` | no — navigates |
| Dashboard | `JobSelector` chips → `?job=&health=` | yes |
| Workspace | `?job=&dept=&status=&sort=` | yes |
| My Day (pool only) | `useState<string \| null>` on `jobNumber` | **no** |
| Welding | per-form `useState<number \| "">` | **no** |
| QC | none at all | — |

Four of six are not URL-driven, so nothing is linkable, bookmarkable or shareable.

**Resolution.** One `?job=` search param as the app-wide project context, read by
a `useProjectContext()` hook and written by the topbar switcher via
`router.replace` preserving the pathname. Every surface either honours it or
explicitly declares itself portfolio-wide. Show the switcher at all breakpoints.
Delete `JobSelector`, My Day's `ProjectFilter` and Welding's form-local state.

### On the security question — can project context widen visibility?

**No, and this was checked specifically.** Every widening path is closed:
`loadJobs` filters `clientId` for external users; `loadWorkspaceView` calls
`assertClientScope` on the requested job; department scoping inside a job is
independent of the job id; all reads run under `withTenant` RLS. A hand-typed
`?job=` reaches only jobs the actor could already reach, and shows only their own
departments' rows. **This part is sound and must stay sound** — the global
context model must never be allowed to become an authorization input.

---

## 8. On the client portal — judged on its own terms

`/portal` is the cleanest surface in the codebase and should not be touched. It
sits in a separate route group outside `(app)`, has its own shell and theme, is
hard-scoped in both directions (`clientId === null → redirect("/")` and the
inverse on every internal page), is read-only by a global `assertNotClientUser`,
and reads *only* `ProgressSnapshot` rows with `status = VERIFIED`, sanitised
through `sanitizeDetail` which deliberately maps `submitted` to `hold` so QC
state is not disclosed. There is a real internal publish → verify workflow behind
it with its own two-person rule.

Its one content defect is AUD-031: the field labelled "Forecast dispatch" is
populated with `job.committedDeliveryDate` — the *promise*. That is a commercial
decision to make, not a bug to fix silently.

Its one structural gap is that there is no TPI role, despite the brief calling it
the "client/TPI portal".

---

## 9. Sequencing

The IA changes have a dependency order and getting it wrong wastes work:

```
AUD-013  Add OPERATOR + PLANNER roles
   └── AUD-012  Role-filter the nav
          └── AUD-011  Unify the two nav arrays  ─────┐
                                                       │
AUD-010  Build /team (promote /command)  ──────────────┤
   ├── AUD-008  Strip pool + teamHeld from My Day      │
   ├── AUD-038  Move assign/release to /team           │
   ├── AUD-036  Split the overdue badge in two         │
   └── AUD-019  Retire /workspace → /team              │
                                                       │
AUD-039  Global ?job= context  ────────────────────────┤
   └── AUD-007  Delete the DESPL-320 literal           │  (do AUD-007 first
                                                       │   as a standalone fix —
AUD-015  Narrow the dashboard  ────────────────────────┤   it is hours, not days)
   ├── AUD-016  Build the exception queue              │
   └── AUD-041  /qc owns the verify queue              │
                                                       │
AUD-040  Delete /board and /profile  ──────────────────┘
```

**Build `/team` before stripping My Day.** If the pool disappears from My Day
before Team exists, claiming has nowhere to live and the floor loses its only way
to pick up work.
