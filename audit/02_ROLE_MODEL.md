# 02 — ROLE MODEL

*What roles exist, what each actually experiences today, and what the target model must be.*

---

## 1. The roles that exist

`src/lib/authz/index.ts:6-13` — the complete enum:

```ts
export const ROLES = {
  ADMIN, MANAGEMENT, PRODUCTION_HEAD, SUPERVISOR, QC, CLIENT_VIEWER
} as const;
```

Six roles. Department membership (`UserDepartment`) is a separate, orthogonal
axis and is what actually scopes most operational authority.

---

## 2. Current state — role by role

| Role | In code | Distinct landing | Distinct nav | Distinct KPIs | Distinct data scope |
|---|---|---|---|---|---|
| `ADMIN` | ✅ | `/dashboard` | Partial — Admin group only | ❌ same dashboard | ✅ bypasses `requireDepartmentScope` |
| `MANAGEMENT` | ✅ | `/dashboard` | Partial — `/admin` link only | ❌ same dashboard | ⚠️ `seesAll` in workspace but **no** scope bypass → dead buttons (AUD-070) |
| `PRODUCTION_HEAD` | ✅ | `/dashboard` | Partial — 5 admin items | ❌ same dashboard | ✅ full bypass |
| `SUPERVISOR` | ✅ | `/my-day` | ❌ identical to QC's | ❌ same My Day | ✅ `actor.departmentIds` |
| `QC` | ✅ | `/my-day` | ❌ identical to Supervisor's | ⚠️ tab reorder only | ✅ cross-dept `SUBMITTED` bypass; `assertMakerChecker` |
| `CLIENT_VIEWER` | ✅ | `/portal` | ✅ separate shell entirely | ✅ verified snapshots only | ✅ `assertClientScope` |
| **Operator / employee** | ❌ **absent** | — | — | — | — |
| **Project / planning user** | ❌ **absent** | — | — | — | — |

**Three roles, one experience.** `MANAGEMENT`, `PRODUCTION_HEAD` and `ADMIN` are
indistinguishable outside the Admin nav group and one authz bypass. `SUPERVISOR`
and `QC` differ only in the default tab on My Day.

---

## 3. AUD-013 (P0) — there is no operator role, so every welder is a supervisor

`prisma/seed.ts:1476-1483`:

```ts
for (const d of leadTime.departments) {
  await mkUser(`sup.${d.code.toLowerCase()}@despl.local`, `${d.name} Supervisor`,
               ["SUPERVISOR"], [d.code]);
}
```

This is load-bearing, not cosmetic. `myday.read.ts:368` gates the entire
"Assign to…" people-picker on
`hasRole(actor, SUPERVISOR, PRODUCTION_HEAD, ADMIN)`, and
`assignment.service.ts:102` gates the `assignPlan` mutation on the same set.

**Consequence:** there is no way to give a fitter a login that shows their own
queue without also giving them the power to reassign their colleagues' work. The
choice today is "the floor gets no logins" (which defeats the tracker) or "every
floor worker is a supervisor".

**Root cause:** the role list was drafted from the org chart's *management* tiers
and never extended downward. `UserDepartment` became the de-facto stand-in for
"is a worker here", with `SUPERVISOR` bolted on to make My Day usable at all.

---

## 4. AUD-014 (P0) — role branching exists only as redirects and hidden buttons

Exhaustive inventory of every role check in the app tree:

| Location | What it does |
|---|---|
| `app/page.tsx:14-16` | Landing redirect — 3 branches |
| `dashboard/page.tsx:115` | `redirect("/my-day")` unless MANAGEMENT/PH/ADMIN — **the only exclusive surface** |
| `admin/page.tsx:10` | ADMIN, MANAGEMENT |
| `jobs/page.tsx:52` | `canCreate` boolean |
| `jobs/[id]/page.tsx:39-46` | Four `can*` booleans |
| `reports/page.tsx:31` | `canSend` |
| `welding/page.tsx:14` | `canManageWelders` |
| `my-day/page.tsx:47-48` | `isQc`, `canAssign` |
| `command/[dept]/page.tsx:38-40` | `full \| readonly \| none` — **the one surface that does this well** |
| `qc/page.tsx` | **no role check of any kind** (AUD-037) |
| `workspace`, `departments`, `departments/[id]`, `alerts`, `board`, `profile` | **no role check of any kind** |

Every one is a redirect or a button toggle. **No surface changes its KPIs, its
sections, or its data scope by role.** `/departments` issues
`tx.department.findMany()` and a plan query with no actor predicate at all — a
fitter sees the same department performance page as the MD.

The cause is a category error that is easy to make: authorization correctly lives
in the service layer as *refusals*, and "refusing an action" and "not offering
it" were treated as the same requirement. They are not. Refusal is a security
control; not offering is a design decision.

---

## 5. The six archetypes and what each needs

### 5.1 Individual operator / employee — **role must be created**

| | |
|---|---|
| **Landing** | `/my-day` |
| **Nav** | My Day, Projects (read-only), their department's Operations surface, Alerts |
| **KPIs** | Assigned · needs attention · due today · blocked · upcoming. Personal progress collapsed at the bottom |
| **Assigned work** | Their own only |
| **Team visibility** | None |
| **Project visibility** | Read-only; no `/jobs/new` |
| **Actions** | Start, Submit, File delay reason, **Claim next** (one item, top-ranked) |
| **Approvals** | None |
| **Reporting** | None |
| **Must NOT have** | Assign, Release, browsable pool, Team, Departments, Dashboard |

### 5.2 Supervisor

| | |
|---|---|
| **Landing** | `/my-day` — their *personal* work |
| **Nav** | My Day, **Team**, Projects, Departments (own), Operations, Reports (own dept) |
| **KPIs** | My Day: personal. Team: dept open / overdue / blocked / unassigned / on-time% |
| **Team visibility** | Full for their departments — workload by employee, capacity, pool |
| **Actions** | Everything an operator has, plus Assign, Release, bulk start, bulk delay-reason, escalate |
| **Approvals** | None (QC verification is not theirs) |
| **Critical rule** | Personal work and team workload are **separate surfaces**. A department pool never appears on My Day. |

### 5.3 Project / planning user — **role must be created**

Today approximated by `PRODUCTION_HEAD` + membership of a `PROJECTS`/`PLANNING`
department, routed via the `isOfficeDept` flag.

| | |
|---|---|
| **Landing** | `/my-day` |
| **Nav** | Dashboard, My Day, Team (own dept), Projects **+ `/jobs/new`**, Departments, Reports |
| **KPIs** | Schedule health: forecast vs promised, critical path, feasibility |
| **Actions** | Create job, generate/regenerate schedule, apply duration override, edit job dates |
| **Approvals** | None |

### 5.4 QC user

| | |
|---|---|
| **Landing** | `/my-day` — with the verification queue as the default tab |
| **Nav** | My Day, **QC & Hold Points**, Projects (read-only), Reports (QC) |
| **KPIs** | Awaiting verification · aged blocking holds · open NCRs · first-pass yield |
| **Team visibility** | None |
| **Actions** | Verify, Reject, record QCP execution, record NDT, disposition NCR |
| **Approvals** | Every process/operation/assembly verification |
| **Critical rule** | Maker–checker is absolute. Also: `/qc` must be **gated to QC and above** — today it is open to every staff user (AUD-037). |

### 5.5 Management (MD / CEO)

| | |
|---|---|
| **Landing** | `/dashboard` |
| **Nav** | Dashboard, Projects, Departments, Reports, QC (read-only) |
| **KPIs** | Active · delayed · at risk · on hold · actions due — all clickable |
| **Team visibility** | Read-only across all departments |
| **Actions** | **None.** `DESIGN_SPEC.md:66-67` already states this: *"Management user sees no action buttons at all — same pages, read-only."* Today `/workspace` renders live Start/Submit/Verify buttons for MANAGEMENT that throw `FORBIDDEN` (AUD-070) |
| **Approvals** | Verify/reject client progress snapshots |
| **Reporting** | Full |

### 5.6 Administrator

| | |
|---|---|
| **Landing** | `/dashboard` |
| **Nav** | Everything, plus `/admin/*` |
| **Actions** | Master data, users, templates, routes, QCP libraries |
| **Constraint** | ADMIN is **not** an implicit superuser and must not become one. `requireRole` has no admin fallback and `assertMakerChecker` deliberately excludes ADMIN — both correct, both must survive any refactor. The one hole is AUD-079: an ADMIN can reset a QC user's password, sign in as them, and satisfy maker–checker as a different `userId`. |

---

## 6. Two rules the code does not encode today

1. **Operations surfaces are department-membership-gated, not role-gated.**
   `/welding` should appear only for members of the welding department — an
   `actor.departmentIds` check, not a role check. The shell already receives
   both.
2. **Management sees every surface read-only, with `canAct=false` threaded
   through.** The pattern already exists and works: `resolveCommandCenterAccess`
   (`command-center.read.ts:139-144`) returns `full | readonly | none` and is
   unit-tested. Generalise it; do not invent a second mechanism.

---

## 7. Proposed implementation

Introduce a `RoleArchetype` derived from `Actor` in `src/lib/authz`:

```ts
type RoleArchetype = "operator" | "supervisor" | "planner" | "qc" | "management" | "admin";
export function archetypeOf(actor: Actor): RoleArchetype;
```

Three things then read from it, and only these three:

1. **Landing route** — replaces the three-branch redirect in `app/page.tsx`.
2. **Visible navigation** — one `NAV_ITEMS` registry with `roles?: RoleCode[]`,
   filtered by `visibleNav(actor)`, rendered into all three chrome variants
   (sidebar, icon rail, bottom bar). See `03_INFORMATION_ARCHITECTURE.md` §6.
3. **Per-surface section composition** — each canonical surface takes an
   archetype and renders a role-appropriate section list rather than the union of
   everything.

**This does not touch the authorization layer.** `requireRole`,
`requireDepartmentScope`, `assertClientScope`, `assertNotClientUser` and
`assertMakerChecker` stay exactly as they are — they are correct, small, and
well-tested. The archetype is a *presentation* concept layered above them. The
frontend must never become responsible for hiding unauthorised data; it becomes
responsible for not offering irrelevant work.

### Migration path for the new roles

| Step | Action |
|---|---|
| 1 | Add `OPERATOR` and `PLANNER` to `ROLES` and to `roleDefs` in the seed |
| 2 | Split the UI privileges currently hanging off `SUPERVISOR` — assign/release stay on `SUPERVISOR`; claim, start, submit, file-reason move to `OPERATOR` and are inherited by `SUPERVISOR` |
| 3 | Re-grant existing shop-floor accounts from `SUPERVISOR` to `OPERATOR`, leaving genuine supervisors alone. `admin.service.ts`'s `updateUserRolesDepts` already does this and is audited |
| 4 | Add `archetypeOf` + `visibleNav`; delete `SHELL_NAV`/`NAV` |
| 5 | Add a table-driven test asserting the full role × surface × action matrix — see `16_TESTING.md` §4 |

---

## 8. Two notes on the edges

**`CLIENT_VIEWER` is a role code, but `User.clientId` is the real gate.**
`app/page.tsx:16` has a fallback comment for *"a staff CLIENT_VIEWER with no
clientId"* and routes that shape to `/workspace` — a shop-floor worklist. A
staff-side read-only observer is not modelled and should be, or the role code
should be removed to stop implying it is.

**There is no TPI role.** The brief calls `/portal` the "client/TPI portal", and
hold points carry an `awaitingTpi` flag, but TPI exists only as an internal
status — never as a login. If third-party inspectors are ever to attend hold
points through the system rather than by email, that is a new archetype with a
different data contract, and AUD-004 is the reason it matters: today an internal
QC verification silently satisfies an external party's checkpoint.
