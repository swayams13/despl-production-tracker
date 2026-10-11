# 12 — SECURITY & RBAC AUDIT

*Every mutation path in `src/app/actions/` and every route in `src/app/api/` was
read. The authorization discipline holds. The gaps are at the database layer and
at two specific edges.*

---

## 1. The headline: AUD-001 (P0)

The most serious security finding in this audit is a database-layer one and is
documented in full, with live proof, in `11_DATABASE_AUDIT.md` §3.

In summary: the 28 job-grain tables that hold every unit, component, process
plan, BOM item, stock lot, NCR and QC execution **have no `tenant_id` column and
no tenant RLS policy**. Their only database policy is `job_isolation`, which
fails open. A further 21 tables — including `equipments`, `job_processes`,
`schedule_runs`, `organizations`, `user_roles` and `user_departments` — have no
RLS of any kind.

Cross-tenant **read and write** were both proven live as the application's own
`despl_web` role with the tenant GUC set correctly.

**What saves the deployment today** is that it is single-tenant and that the
service layer's scoping discipline is genuinely good. The application is not
currently leaking. But there is no database backstop for the operational core,
and `rls-coverage.test.ts` — the one test that claims to check RLS coverage —
filters on `tenant_id`, so it is **structurally blind** to the 28 tables that
lack the column.

**AUD-080 (P2)** compounds it: nine tables carry `job_id` and were eligible for
the H1 backstop but were omitted from its array, because the policy list was
derived from "tables this migration added a column to" rather than "tables that
have the column". No automated check detects the divergence.

---

## 2. Authorization matrix — Server Actions

Every row calls `requireActor()` (authenticate + `mustChangePassword` gate) unless
noted. *Object/tenant scoping* describes what the service does with caller-supplied ids.

| Action | Service enforcement | Role(s) | Object-level check | Tenant/job scoping |
|---|---|---|---|---|
| `auth.ts:20 login` | — (pre-auth) | **public** | n/a | `resolveTenantForLogin`; identifier-keyed throttle |
| `auth.ts:96 logout` | — | any | own cookie | n/a |
| `account.ts:24 changePassword` | `change-password.ts:33` — **`getActor()`, deliberate** (this action clears `mustChangePassword`) | any | self only; current password verified | `withTenant` |
| `admin.ts:19 createUser` | `admin.service.ts:67` | ADMIN | roles/depts validated in-tenant | `withTenant` |
| `admin.ts:29 resetPassword` | `admin.service.ts:161` | ADMIN | target re-read `id + tenantId` — **no QC/ADMIN target restriction (AUD-079)** | `withTenant` |
| `admin.ts:52 createEmployee` | `admin.service.ts:360` | ADMIN | — | `withTenant` |
| `admin.ts:79 setUserActive` | `admin.service.ts:487` | ADMIN | `CANNOT_SELF_DEACTIVATE`; target in-tenant | `withTenant` |
| `admin.ts:89 updateUserRolesDepts` | `admin.service.ts:526` | ADMIN | `CANNOT_SELF_DEMOTE`; roles/depts in-tenant | `withTenant` |
| `admin.ts:100 bulkImportEmployees` | `admin.service.ts:608` | ADMIN | per-row `safeParse` | per-row `withTenant` |
| `admin.ts:112/122` delay categories | `admin.service.ts:202/231` | ADMIN | — | `withTenant` |
| `admin.ts:132 updateStandardDurations` | `admin.service.ts:270` | ADMIN | — | `withTenant` |
| `assembly.ts:18/22 start/submit` | `assembly.service.ts:100/159` | dept scope (ADMIN/PH bypass) | step's `defaultDepartmentId` | `withTenant` + `app.job_id` |
| `assembly.ts:42/46 verify/reject` | `assembly.service.ts:228/302` | **QC only, actor ≠ submitter** | `assertMakerChecker` | same |
| `assignment.ts:7 claimPlan` | `assignment.service.ts:45` | dept membership — **no ADMIN/PH bypass, by design** | inline `departmentIds.includes` | `lockProcessPlanForUpdate` |
| `assignment.ts:19 assignPlan` | `assignment.service.ts:101` | SUPERVISOR / PH / ADMIN + dept scope | assignee in dept and active | same |
| `assignment.ts:31 releasePlan` | `assignment.service.ts:169` | assignee **or** dept supervisor **or** PH/ADMIN | explicit four-way allow-list | same |
| `bom.ts:16 recordMtc` | `mtc.service.ts:20` | QC | `bomItemId` **and** `componentId` independently anchored, same-job compared | `withTenant` |
| `bom.ts:34 recordProcurementEvent` | `procurement.service.ts:24` | ADMIN / PH | bomItem via `equipment.job.tenantId`; `assertClientScope` | `withTenant` |
| `bom.ts:51/62/87/105` BOM CRUD | `bom.service.ts:101/128/254/372` | ADMIN / PH | `loadEquipment` (tenant + client scope); row re-read in-tenant | `withTenant` |
| `client-snapshot.ts:18 publish` | `client-snapshot.service.ts:61` | PH / ADMIN | job via RLS | `withTenant` |
| `client-snapshot.ts:22/26 verify/reject` | `client-snapshot.service.ts:162/210` | MANAGEMENT / ADMIN + **actor ≠ publisher** | `MAKER_CHECKER_VIOLATION`; count-checked write | `withTenant` |
| `component.ts:17/23 start/submit` | `component.service.ts:196/290` | dept scope | `OperationRef.defaultDepartmentId`; null dept fails loud | `withTenant` + `app.job_id` |
| `component.ts:39/45 verify/reject` | `component.service.ts:355/439` | **QC only, actor ≠ submitter** + `assertNotClientUser` | `assertMakerChecker` | same |
| `component.ts:55 linkGoverningDrawing` | `component.service.ts:702` | ADMIN / PH | component via `equipment.job`; `assertClientScope` | `withTenant` |
| `delay.ts:7/29 file (bulk)` | `delay.service.ts:38` | dept scope of owner dept | `lockProcessPlanForUpdate`; category in-tenant | `withTenant` + `app.job_id` |
| `dispatch.ts:22/31/39/54` | `dispatch.service.ts:71/112/183/235` | PH / ADMIN | **cross-job refused**; unit packed; NCR/hold gates **only on `addUnitToBatch`** (AUD-005) | `withTenant` |
| `drawing.ts:7 createRevision` | `drawing.service.ts:27` | ADMIN / PH | anchored via job; `assertClientScope` | `withTenant` |
| `job-intake.ts:37 createJob` | `job-intake.service.ts:55` | ADMIN / PH | client/family/template/calendar/equipment-types **all** re-validated in-tenant; template must be PUBLISHED | `withTenant` |
| `job-intake.ts:61 scheduleNewJob` | `schedule.service.ts:48` | PH / ADMIN | `assertClientScope`; job row locked | `withTenant` |
| `job-intake.ts:105/126/141` job edits | `job-intake.service.ts:324/379/450` | ADMIN / PH | job in-tenant | `withTenant` |
| `job-intake.ts:156/167/181/195` master data | `admin.service.ts:814/657/697/752` | ADMIN (family) / ADMIN+PH | — | `withTenant` |
| `ncr.ts:17 dispositionNcr` | `ncr.service.ts:81` | **QC** — no maker-checker, no dept scope | `lockNcrForUpdate` tenant-anchored; state transition | `withTenant` |
| `notifications.ts:7/17 markRead` | `notifications.service.ts:105/113` | any | **`recipientId: actor.userId`** — own rows only | `withTenant` |
| `notifications.ts:27 nudgeQc` | `notifications.service.ts:242` | **`assertNotClientUser` only — no role check** (deliberate; audited) | plan anchored; per-actor cooldown | `withTenant` |
| `packing.ts:17/31` | `packing.service.ts:31/73` | PH / ADMIN | `assertJobInTenant`; **cross-job refused**; NCR/hold gates | `withTenant` |
| `preferences.ts:23 setTheme` | via `requireActor` | any | own record | `withTenant` |
| `process.ts:18/21 start/submit` | `process.service.ts:123/166` | dept scope | `lockProcessPlanForUpdate` + `STALE_WRITE`; component-ops gate at submit | `withTenant` + `app.job_id` |
| `process.ts:24/27 verify/reject` | `process.service.ts:230/274` | **QC only, actor ≠ submitter** | `assertMakerChecker`; predecessor/hold/NCR/evidence gates | same |
| `process.ts:30/33 hold/resume` | `process.service.ts:328/365` | dept scope | same | same |
| `process.ts:43 startBulk` | per plan | dept scope per plan | per plan | per plan |
| `qcp-template.ts:10/24` | `qcp.service.ts:120/163` | ADMIN / PH | template lookup opens the `jobId: null` branch | **cross-tenant on library rows (AUD-078)** |
| `qcp.ts:7 recordQcp` | `qcp.service.ts:63` | QC | `unitId` anchored; **`qcpItemId` not validated (AUD-077)** | `withTenant` |
| `reports.ts:7 sendDigest` | `reports.service.ts:18` | PH / ADMIN | idempotent on `(type, entityId)` | `withTenant` |
| `route-template.ts:10/22` | `route.service.ts:38/178` | ADMIN / PH | componentType/family/operationRefs in-tenant | `withTenant` |
| `stock.ts:7 receive` | `stock.service.ts:22` | ADMIN / PH | bomItem anchored; `assertClientScope`; source event must match | `withTenant` |
| `stock.ts:24/40/56 issue/return/scrap` | `stock.service.ts:133` | ADMIN / PH | lot anchored; **advisory lock**; `componentId` must be same job; over-issue guard | `withTenant` + `app.job_id` |
| `template.ts:22/32/45/63` | `template.service.ts:40/86/162/494` | ADMIN / PH | version anchored; DRAFT-only; **optimistic lock** on save | `withTenant` |
| `welder.ts:7/21` | `welder.service.ts:29/68` | ADMIN / PH | welder rows carry `tenant_id` (RLS) | `withTenant` |
| `welding.ts:7 logWeldJoint` | `welding.service.ts:133` | dept scope of the WELDING op's dept | unit/component must match job; welders in-tenant | `withTenant` |
| `welding.ts:25 recordNdtResult` | `welding.service.ts:202` | QC | joint anchored via `job.tenantId` | `withTenant` |

---

## 3. Authorization matrix — API routes

| Route | Auth | Role | Object-level | Scoping |
|---|---|---|---|---|
| `GET /api/health` | **public** | none | n/a | **leaks pending migration names (AUD-107)** |
| `GET /api/jobs` | `route()` → `requireActor` + `assertNotClientUser` | any staff | — | `clientId` filter for client actors; `pageSize` clamped 200 |
| `GET /api/events` | same | any staff | `assertClientScope` when `?job=` given | `withTenant`; RLS |
| `GET /api/jobs/[id]/spine` | same | any staff | `assertClientScope`; `intParam` rejects non-ints | `withTenant` |
| `GET /api/jobs/[id]/stage` | same | any staff | `assertClientScope`; **unit must belong to job** | `withTenant` |
| `GET /api/welding/joints` | same | any staff | tenant-scoped joints | `withTenant` |
| `GET /api/jobs/[id]/qcp/export` | **manual** `requireActor` + `assertNotClientUser` — bypasses the wrapper, documented | any staff — **no department scope** | `assertClientScope` | `withTenant` |
| `POST /api/cron/alerts` | `CRON_SECRET` bearer, `timingSafeEqual`, **fails closed when unset** | n/a | n/a | per-org `withTenant` |
| `POST /api/cron/digest` | same | n/a | n/a | **impersonates the lowest-id ADMIN (AUD-106)** |

**Middleware** is a coarse gate by design: it verifies only the JWT signature and
knows nothing of roles, department scope or `sessionVersion` — and says so in its
own comment. Public paths are `/login`, `/api/health`, `/api/cron`. It returns
JSON 401 for `/api/*` and redirects otherwise. **No route depends on it for
authorization**, which is the correct posture.

---

## 4. AUD-025 (P1) — client users reach `/board` and `/profile`

```ts
// board/page.tsx:4-6 and profile/page.tsx:4-6
const actor = await getActor();
if (!actor) redirect("/login");
//  ← no `if (actor.clientId !== null) redirect("/portal");`
```

Every sibling page in the group has that guard. These two do not, and
`/board` is not in `middleware.ts`'s restricted set, so a client user with a valid
session reaches both.

The shared layout then loads internal reads for **any** actor *before* any
page-level guard runs, and hands them to a **client** component whose job switcher
renders internal metrics directly:

```tsx
{j.unitCount} units · {j.percentComplete.toFixed(1)}% ·
{j.forecastVarianceDays == null ? "no schedule" : …}
```

`JobListItem` carries `forecastDispatch`, `forecastVarianceDays`, `overduePlans`,
`openHoldPoints`, `percentComplete`, `lastActivityAt`.

**This bypasses `ClientVisibilityPolicy` entirely** — the mechanism that decides
what a client may see, including the `showProgress` and `showDates` toggles.

**Impact.** A TPI inspector or customer contact navigating (or deep-linking, or
bookmarking) to `/board` sees, for their own orders, live internal % complete,
the real forecast dispatch date, overdue plan counts and open hold points — the
exact figures DESPL withholds until a Management-verified snapshot is released.
**A customer can see slippage before DESPL has decided to communicate it, and
even when `showDates`/`showProgress` are switched off for them.**

The e2e suite believes this is covered but only exercises `/` and `/api/jobs`;
`supervisor-viewport.spec.ts` explicitly asserts `/board` and `/profile` render
for a logged-in session.

**Fix.** Move the guard into `(app)/layout.tsx` **before** the `Promise.all`, so
it is structurally impossible for a new page in the group to be open. Keep the
per-page guards as defence in depth. Add an e2e case looping every route in the
group with a client session and asserting a redirect.

---

## 5. AUD-079 (P2) — admin password reset defeats maker–checker

The invariant is genuinely enforced against actor identity:

```ts
// authz/index.ts:144-148
export function assertMakerChecker(actor: Actor, submittedBy: number | null): void {
  requireRole(actor, ROLES.QC);
  if (submittedBy !== null && submittedBy === actor.userId)
    throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { submittedBy });
}
```

But `resetUserPassword` accepts **any** `userId` in the tenant — including a QC
user or another ADMIN — and returns the plaintext. There is no target-role
exclusion and no second approver.

An ADMIN who is also a maker can submit as themselves, reset a QC account, sign
in as that QC user (a distinct `actor.userId`), and pass `assertMakerChecker`.

**Impact.** Maker–checker is the control that makes a DESPL sign-off defensible
to a TPI. A single administrator can manufacture a complete, apparently-valid
verification chain for work they performed themselves — accepted stages, cleared
hold points, and ultimately a dispatch release on a vessel nobody independently
inspected. The invariant's own documentation reads as stronger than the system
can deliver.

**Fix.** Two cheap mitigations. *Detective:* extend the existing audit spec to
record the target's role codes, and alert on any reset whose target holds `QC`.
*Preventive:* refuse the reset when the target holds `QC` or `ADMIN` unless a
second ADMIN approves — mirroring the two-actor pattern already implemented and
working in `client-snapshot.service.ts`. At minimum, correct the comment in
`authz/index.ts` so the residual risk is documented rather than implicitly
denied.

**Compensating controls that already exist and must be kept:** the reset forces
`mustChangePassword: true` and bumps `sessionVersion`, so the real QC user is
alerted at their next login.

---

## 6. AUD-078 / AUD-077 (P2) — QCP library rows have no tenant anchor

The code documents the hole itself (`qcp.service.ts:101-108`):

> *"QcpTemplate/InspectionParty carry no tenantId of their own (a job-owned row is
> anchored through job.tenantId; a library row with jobId null has NO tenant
> anchor in the schema at all). … every tenant can see and clone every OTHER
> tenant's library rows today."*

Both call sites use `OR: [{ job: { tenantId } }, { jobId: null }]`.
`qcp_templates` has **no RLS policy at all**, and `qcp_items` /
`inspection_parties` are only in the *job* policy, whose predicate explicitly
passes `job_id IS NULL`.

Separately, **`recordQcpExecution` never validates `qcpItemId`** — the unit is
tenant-anchored, the checkpoint is not, and `qcpItemId` goes straight to the
insert.

*Verified: this is **not** a hold-point bypass.* `assertNoOpenHoldPoint` derives
`itemIds` from the job's own `qcpItem` rows and only consults executions whose
`qcpItemId` is in that set, so a foreign id cannot clear a real checkpoint. It
does pollute the inspection record with entries no QCP grid will ever display,
and it breaks "which unit was inspected against which QCP item" as a fact the
database enforces.

Compounded by AUD-069 (`11_DATABASE_AUDIT.md` §5.3): deleting a job *promotes* its
QCP into the library, where the fail-open `job_id IS NULL` branch makes it
readable from every tenant.

**Fix.** Add `tenantId` to `QcpTemplate`, backfilled from `job.tenantId`; enrol
`qcp_templates` in the fail-closed policy set; replace both `OR` clauses with
`{ tenantId: actor.tenantId }`. In `recordQcpExecution`, look the item up as
`{ id: qcpItemId, jobId: unit.jobId }` and throw `CROSS_JOB_ASSIGNMENT` otherwise —
the pattern `addUnitToBatch` already uses.

---

## 7. Lower-severity findings

**AUD-105 (P3) — every audit row is written with `ip` and `user_agent` NULL.**
The spec supports them and `recordAudit` writes them; **no call site anywhere
supplies either.** When a disputed sign-off is investigated — a verified stage
the QC engineer says they did not perform, an after-hours dispatch approval — the
trail names a user id and nothing else. The request context is already reachable:
`_action.ts:96` calls `await headers()` and `middleware.ts` already stamps
`x-request-id`. Fix: read them once per request and carry them on the `Actor` (or
an `AsyncLocalStorage` context), defaulting in `recordAudit` rather than at ~70
call sites.

**AUD-106 (P3) — the cron digest is signed with a real person's identity.**
`cron.service.ts` picks the lowest-id active ADMIN and synthesises an `Actor` from
them. `publishDigest` uses `opts.auto` only for the notification body, never for
the audit row — so `audit_log` records a named human as the actor of a
cron-triggered publish, every working day at 06:30 IST. Fix: distinct action
string `reports.publishDigest.auto` plus `auto: true` in the `after` payload;
longer term a reserved system principal.

**AUD-107 (P3) — `/api/health` leaks pending migration names, unauthenticated.**
The 503 body returns the migration directory names read off disk. An
unauthenticated caller learns the schema roadmap *and*, critically, **learns when
the deployment is running code against an unmigrated schema** — precisely the
window in which the RLS and job-isolation migrations may not yet be applied. Fix:
keep the 503 and `migrations: "pending"`, drop the array from the body,
`console.error` the names.

**AUD-108 (P3) — CSP is Report-Only with no reporting endpoint.** The policy
itself is sound (`default-src 'self'`, `frame-ancestors 'none'`,
`object-src 'none'`), but Report-Only enforces nothing and there is no
`report-uri`/`report-to`, so the reports the mode exists to collect go nowhere.
Any stored-XSS sink reached through free-text fields — delay-reason detail, NCR
disposition notes, remarks, rejection reasons — has no browser-level containment;
React's escaping is the only defence, on a shop-floor tablet that stays signed in
for a 12-hour shift. Fix: add the reporting endpoint now, confirm clean over a
deploy cycle, then rename the header. `'unsafe-inline'` on `script-src` can stay
for the first flip — enforcing everything else is already a large gain over
enforcing nothing.

**AUD-109 (P3) — the login throttle is keyed only on the submitted identifier.**
Five failures locks that identifier for 15 minutes, with no IP component.
Usernames are derived from email local parts and employee codes and are
effectively public inside the plant. Anyone reaching the login page can keep
`sup.fabrication` locked out indefinitely — at 07:00 shift start that blocks the
person who releases the day's work. Conversely it does not slow a spraying
attacker who rotates identifiers. Fix: include the client IP in the failed-login
audit row and count on `(identifier OR ip)` with separate thresholds; exponential
backoff rather than a hard cliff. Composes with AUD-105's request-context work.

---

## 8. What is genuinely solid

Every mutation path was checked for authz bypasses. **The discipline holds.**

- **Deny-by-default primitives.** `requireRole` has no implicit admin superuser,
  and `authz.test.ts` pins that explicitly with a pure unit test — no mocking.
- **Every Server Action authenticates.** All 26 files checked: exported function
  count equals `requireActor()` call count, with exactly two intentional,
  documented exceptions.
- **Every `/api` route authenticates and blocks client users by default.**
  `assertNotClientUser` is the wrapper's default and no route opts out. The one
  route that bypasses the wrapper replicates both checks by hand with a comment
  naming the reason. E2E-proven with a real client session.
- **Maker–checker is real on every verify path.** Five call sites, no ADMIN
  branch, `submittedBy` always stamped server-side. The client-snapshot flow
  implements the same rule independently and correctly.
- **Cross-job object pairing is checked in application code, not left to RLS.**
  `packing`, `dispatch`, `stock`, `mtc` and `welding` each re-read both objects
  tenant-scoped and compare `jobId`, throwing `CROSS_JOB_ASSIGNMENT`.
- **Tenant RLS is complete and fail-closed on every table that has `tenant_id`.**
  Enumerated exhaustively; `withTenant` sets the GUC transaction-locally so it
  cannot leak across a pooled connection.
- **Append-only audit enforced at three layers and boot-checked.** `assertDbRole`
  queries `has_table_privilege` and `is_superuser` at startup and throws fatally,
  so pointing `DATABASE_URL` at a superuser **crashes the deploy** rather than
  silently disabling both protections. Audit coverage was checked across all
  services: the only unaudited writes are `Notification` rows and
  `User.lastLoginAt`, both reasoned about in comments.
- **Zod is genuinely the single source of validation truth.** 84 of 86 schemas
  are `.strict()`; the two that are not are a `FormData` builder and a CSV row
  normaliser. There is exactly one spread into a Prisma `data:` and it is safe —
  strict schema, no privileged fields, server-controlled `jobId` written after.
  **No request schema anywhere accepts an `actual_*` or `*_at` field.**
- **Session handling is correct.** HS256 with a length-validated secret;
  `httpOnly`, `sameSite: lax`, `secure` in production, 12-hour max age. **Roles
  and department scopes are deliberately not in the token** — re-read from the DB
  every request, so revocation is immediate. `sessionVersion` gives real
  revocation without a session table, bumped on self-change, admin reset and
  deactivation. Argon2id passwords; identical failure message for unknown tenant,
  unknown user, inactive user and wrong password.
- **The `mustChangePassword` gate is at the right layer** — inside
  `requireActor`, which every action and route goes through, not only in a page
  guard.
- **The portal cannot leak unverified or cross-client data.** Refuses non-client
  actors outright, filters by `clientId`, hard-filters `status = 'VERIFIED'` in
  both queries, and sanitises detail blobs — deliberately mapping `submitted` to
  `hold` so QC state is not disclosed.
- **Cron endpoints fail closed.** `isValidCronSecret` returns `false` when the
  secret is unset, so a misconfigured deployment gets 401s rather than open
  endpoints. `timingSafeEqual` comparison.
- **No SQL injection.** Every raw query uses tagged templates;
  `$queryRawUnsafe` appears only in generated code.
- **No secrets committed.** `git ls-files | grep env` returns only the two
  `.example` files, both carrying `CHANGE_ME` placeholders. Zero `NEXT_PUBLIC_*`
  variables in `src/`.
- **The DB-gated tests actually run in CI** — this is not false confidence. ~60%
  of the suite is behind `RUN_DB_TESTS`, and CI sets it against a two-role
  Postgres built from `provision-db-role.sql`. `cross-tenant.test.ts` exercises
  real service functions against two real tenants on a real `despl_web`
  connection.

**One caveat worth recording rather than filing:** `assertMakerChecker` permits
verification when `submittedBy` is `null`, pinned as intended behaviour by a
test. Every write path was traced and there is no way to reach `SUBMITTED` with a
null submitter — submit always stamps it, reject clears it *and* moves the status
back. Safe today; would degrade to a bare role check on any hand-patched or
backfilled row. Worth a `SELECT count(*) … WHERE status='SUBMITTED' AND
submitted_by IS NULL` against production.

---

## 9. Claims requiring production access to close

All read-only:

1. **Does production's `DATABASE_URL` actually point at `despl_web`?**
   Self-enforcing via the boot guard, but confirm:
   `SELECT current_user, current_setting('is_superuser')`.
2. **Has every migration in the tree actually been applied?** — in particular the
   job-isolation and fail-closed-RLS pair.
   `GET /api/health`, or `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`.
3. **Was `scripts/provision-db-role.sql` run in production?** The
   `GRANT despl_app TO despl_web` is what makes every policy and REVOKE bite, and
   migrations do not perform it.
   `SELECT * FROM pg_auth_members WHERE member = 'despl_web'::regrole`.
4. **The live RLS policy set**, to catch drift from the migration tree.
5. **Is `CRON_SECRET` set?** If not, both cron endpoints permanently 401 — an
   availability failure (no digest, no overdue alerts), not a security one.
6. **Any `SUBMITTED` row with a null `submitted_by`?** (§8 caveat.)
7. **Table grants on tables created after `20260813051500`** —
   `ALTER DEFAULT PRIVILEGES` applies only to tables created by the role that
   executed it. `SELECT relname, relacl FROM pg_class …`.
