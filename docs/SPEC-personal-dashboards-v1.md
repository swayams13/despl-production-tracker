# SPEC — Personal Dashboards, Employee Accounts & Admin User Management (v1)

**Date:** 2026-08-16 · **Status:** approved for build (team-reviewed via artifacts) · **Read with:** CLAUDE.md invariants #1–#12, BUILD-SPEC-v2.md (§3 department entry surfaces), DESIGN_SPEC.md (tokens, §11 rollup, SQL-view rule), SPEC-department-workspaces-v1.md (prioritizer, workspace reads).

**Design references (approved by team, in artifact gallery):** `despl-hybrid-workspace` (floor surface), `despl-office-command-center` (office surfaces), `despl-personal-dashboards` (identity/assignment model + demo). This spec turns those into a build contract.

---

## 1. Goal

Every employee logs in with **their own credentials** and lands on a dashboard scoped to **who they are** (person → role → department). They see their work ranked ("assigned to me" first, then their department's unassigned pool), act on it from that surface (start / complete / submit / verify / file reasons / claim), and every action is visible on the department Command Center, the floor views, and the management dashboard — because all surfaces read the same rows. Admin creates and manages all accounts from `/admin` with credentials usable **immediately**.

## 2. What already exists (reuse, do not rebuild)

Verified in progress.md sessions §9.1–§9.10:

- Auth: argon2 password hashing, sessions, login page (industrial theme), logout, reset password.
- Actor model: multi-role, multi-department users; `getActor()`/`requireActor()`.
- Department scoping enforced twice: `workspace.read.ts` filters reads to `actor.departmentIds`; `requireDepartmentScope()` guards every mutating service. Verified for all 13 departments.
- `/admin` (§9.9): users table (create user + role(s) + department(s) + password, reset password), delay-reason master list, standard-durations editor. All admin mutations audited in-tx.
- Role-based landing: SUPERVISOR/QC → `/workspace`, MANAGEMENT/PH/ADMIN → `/dashboard`.
- Full rule layer: gating, maker–checker, hold points, delay-block #7, notifications (§9.8, already user-targeted), audit + domain events, prioritizer (ranked states with reasons).

**This spec adds exactly four things:** (P1) the person grain on work records, (P2) the landing router + personalized "My Day", (P3) office Command Center pages, (P4) admin employee-management upgrades + assignee-first notifications.

## 3. Decisions locked (2026-08-16, team + artifacts review)

| # | Decision | Consequence |
|---|---|---|
| D11 | **Assignment = pull + push.** Anyone in the owning department can *claim* from the dept pool; the dept supervisor (or PH) can *assign/reassign*. No auto-assignment (blocked on capacity data, invariant #10). | `assignment.service` with claim/assign/reassign/release, all audited. |
| D12 | **Accounts down to supervisor level now.** Floor operators get accounts with the mobile app phase. | Bulk-create list = office staff + all dept supervisors (needs C9 staff list). |
| D13 | **Login identifier = username, email optional.** `username` is the unique login key (an email address or an employee code like `SUP-FAB-03` both work). Email, when present, is used for future notification delivery. | `User.username` unique; login form says "Username or email". |
| D14 | **Intra-department visibility: read-only yes.** Everyone sees their whole department's board including who holds what; *acting* on someone else's item requires supervisor reassignment. Cross-department stays aggregate-only. Personal scoreboards visible to: the person, their dept supervisor, PH/ADMIN/MANAGEMENT. | Read scoping rules in §6.2; scoreboard RBAC in §8. |
| D15 | **First-login password change is mandatory.** Admin sets/generates a temporary password; the user must change it before reaching any page. | `mustChangePassword` flag + interstitial. |
| D16 | **Assignment never affects gates.** `assigneeUserId` decides whose list an item appears on — never whether it may start/complete. Gating, maker–checker, hold points unchanged. | Assignment checks live in `assignment.service` only; `process.service` does not read assignee for gate decisions. |

## 4. Schema changes (Prisma — additive only, invariant #6)

```
User (existing — extend)
  username        String  @unique          // login key: email or employee code (D13)
  email           String? // optional real email (nullable; keep if column exists)
  employeeCode    String? @unique          // e.g. "EMP-0042"; optional
  displayName     String                   // "Meera S" — already exists as name? reuse if so
  active          Boolean @default(true)   // deactivated users cannot log in; rows never deleted
  mustChangePassword Boolean @default(true)
  createdById     Int?                     // audit convenience; authoritative record is audit_log

ProcessPlan (existing — extend)
  assigneeUserId  Int?                     // nullable = department pool
  assignee        User? @relation(...)
  @@index([assigneeUserId, status])
```

Notes:
- **No user rows are ever deleted** (audit history references them). Deactivation only.
- If the existing `User` already has `name`/`email`, map rather than duplicate — session 1 must read `schema.prisma` first and adapt.
- Migration must backfill `username` for existing seeded users from their email.

## 5. Services (rule-holders — all rules here, never in actions/UI)

### 5.1 `lib/services/assignment.service.ts` (NEW)

All functions: `requireActor` → scope checks → mutate + audit **in one transaction**. Zod `.strict()` schemas; no client timestamps (invariant #1).

- `claimPlan(actor, {planId})` — allowed if plan's `ownerDepartmentId ∈ actor.departmentIds`, plan not COMPLETE, `assigneeUserId == null`. Sets assignee = actor. Error codes: `NOT_IN_DEPARTMENT`, `ALREADY_ASSIGNED`, `PLAN_COMPLETE`.
- `assignPlan(actor, {planId, userId})` — allowed for the dept's SUPERVISOR, PH, ADMIN. Target user must be `active` and hold the owning department. Overwrites existing assignee (reassignment) — audit row records `before → after`. Error codes: `ASSIGNEE_NOT_IN_DEPARTMENT`, `ASSIGNEE_INACTIVE`, `FORBIDDEN`.
- `releasePlan(actor, {planId})` — assignee themselves, dept supervisor, PH, ADMIN. Sets assignee back to null (returns to pool).
- Every mutation writes a domain event (`PLAN_CLAIMED`, `PLAN_ASSIGNED`, `PLAN_RELEASED`) so feeds/Command Center pick it up with zero new sync.

### 5.2 `lib/services/admin.service.ts` (extend existing)

- `createEmployee(actor, {displayName, username, email?, employeeCode?, roles[], departmentIds[], password?})` — ADMIN only. If `password` omitted, **generate** a readable temporary password (3 words + 2 digits pattern, crypto-random). Sets `mustChangePassword = true`. Returns `{userId, username, tempPassword}` **once** (never retrievable later — only resettable). Audited.
- `setUserActive(actor, {userId, active})` — ADMIN only. Deactivating: sessions invalidated; their assigned plans are **not** auto-released (supervisor reassigns deliberately — surfaced in UI as "assigned to inactive user" warning chip).
- `resetPassword` (exists) — extend to set `mustChangePassword = true` and return a generated temp password the same way.
- `updateUserRolesDepts(actor, {userId, roles[], departmentIds[]})` — ADMIN only, audited with before→after.
- `bulkImportEmployees(actor, rows[])` — CSV rows validated per-row with zod; returns per-row ok/error report; each success = one `createEmployee` in its own transaction (a bad row never rolls back good ones). Used to load the C9 staff list.

### 5.3 `changeOwnPassword(actor, {current, next})` (auth module)

Verifies current, sets next, clears `mustChangePassword`. Rate-limit attempts. Audited (event type only — never log password material).

## 6. Reads (personalization recipe)

### 6.1 `lib/reads/myday.read.ts` (NEW)

Input: actor. Output shape:

```
{ mine:      RankedPlan[]   // assigneeUserId == actor.id, not COMPLETE — prioritizer order
  pool:      RankedPlan[]   // ownerDepartmentId ∈ actor.depts, assignee null — prioritizer order
  teamHeld:  RankedPlan[]   // dept items assigned to others (read-only rows, avatar shown) (D14)
  clearedToday: count       // my items COMPLETE/SUBMITTED today (server date)
  scoreboard: {onTimePct30d, doneThisWeek, avgCycleVsStdDays, firstPassRejects30d}  // over MY items
  week: [{date, mineCount, poolCount, hotCount}] // T+0..T+5 from plannedFinish
}
```

Ranking reuses the existing prioritizer verbatim — no second ranking implementation.

### 6.2 Visibility rules (enforced in reads)

- A user sees: own items (full), dept pool (full), dept teammates' items (read-only), cross-dept only as the existing "waiting on / blocking" aggregates.
- Scoreboard endpoint checks: requester is the subject, subject's dept supervisor, or PH/ADMIN/MANAGEMENT — else `FORBIDDEN`.

### 6.3 SQL-view rule (DESIGN_SPEC §5/§11.5) still binding

Department/Command-Center numbers and personal scoreboards must come from shared views/queries so `/my-day`, `/departments/[id]`, `/dashboard` can never disagree. Personal scoreboard = same formulas as dept KPIs, filtered to assignee.

## 7. Routing & pages

### 7.1 Landing router (extend `page.tsx` redirect logic)

```
ADMIN            → /dashboard (unchanged; /admin reachable in nav)
MANAGEMENT / PH  → /dashboard
QC               → /my-day   (QC flavor: verify queue first)
SUPERVISOR       → /my-day
mustChangePassword=true → /account/password (interstitial, no other page reachable)
inactive         → login refused with clean message
```

`/workspace` remains (department-wide view, linked from My Day header); `/my-day` is the new personal default.

### 7.2 `/my-day` (NEW — the personal dashboard)

Layout per `despl-hybrid-workspace` + `despl-personal-dashboards` artifacts:

1. Header: greeting, role · departments, date, `cleared today: N`, link "Department view →" (workspace/board), link "Command Center →" (office depts, P3).
2. Personal scoreboard strip (4 numbers, §6.1).
3. KPI filter tabs (counts double as filters): Needs attention (my overdue) / Due today / With QC / Up next / Pool.
4. **Mine** — ranked rows, one inline action per row (the state-correct action: Start / Submit / File reason & start / Verify for QC users). Row click → existing StageSheet (upgraded execution sheet is a separate later spec).
5. **Department pool** — ranked rows with `Claim` buttons (and `Assign to…` select for supervisors).
6. **Held by teammates** — collapsed, read-only, avatar + status (D14).
7. Empty states per Fiori pattern: "Nothing due. Next item: {name} · {unit} · due {date}."

All actions call existing P3-style server actions (`process.ts`, `delay.ts`, `qcp.ts`) plus new `assignment.ts` actions; refusals render inline with code + sentence (refusal rendering is the product).

Mobile-first responsive (this page is the mobile app's web twin until the app ships).

### 7.3 `/admin` — Employee management upgrade

Extend the existing users table into an **Employees** tab:

- **Table columns:** Name · Username · Employee code · Role chips · Department chips · Status (Active/Inactive) · Last login · Assigned open items count · row actions (Edit, Reset password, Deactivate/Reactivate).
- **Add employee dialog:** displayName*, username* (validated unique, format hint "email or employee code"), email?, employeeCode?, roles* (multi-select), departments* (multi-select; required unless role is MANAGEMENT/ADMIN), password (leave empty → auto-generate).
- **On create: credential hand-off screen** — shows username + temp password once, with a **"Print credential slip"** button (A6 print CSS: DESPL header, username, temp password, "you must change this at first login", the app URL). This is the "use instantly" requirement: admin creates → hands the slip → employee logs in that minute.
- **Bulk import:** upload CSV (`displayName,username,email,employeeCode,roles,departments`), preview parsed rows with per-row validation errors, import, then downloadable result CSV including generated temp passwords (one-time download, not stored).
- **Guard rails:** cannot deactivate yourself; cannot remove your own ADMIN role; deactivation shows count of open items still assigned ("Reassign from the department view"). MANAGEMENT sees this tab read-only with zero action buttons (existing rule).

### 7.4 Office Command Center pages (P3 — per `despl-office-command-center` artifact)

`/command/[dept]` for the office departments (Engineering, Procurement, Planning, PMO, QC, Stores), all five sections bound to live reads: Decide today (top-5 of dept items, mine-first for the viewer) · This week strip · dept pipeline (each dept's records in its own vocabulary, per BUILD-SPEC §3 entry-surface table) · You're blocking / Waiting on (from DAG edges) · dept KPI row (shared views). Floor departments route to `/workspace` (hybrid). Supervisors of office depts land here from `/my-day` header link; PH can open any.

*Scope note:* v1 renders these from **ProcessPlan-grain data only** (what exists). Department-native records (RFQ/PO objects, drawing-revision objects) are future specs; the pipeline columns map plan states until then. Do not invent tables for v1.

## 8. Notifications (extend §9.8 engine — no new infrastructure)

Recipient resolution becomes **assignee-first**: T-3/T-0/T+1 target `plan.assigneeUserId ?? department supervisors` (current behavior as fallback). Escalations T+3 → PH, T+7 → MD unchanged. Claim/assign notify the affected user ("You were assigned…"). Reject continues to notify the maker (already per-user).

## 9. Security requirements

- All new schemas `.strict()`; no `*_at` client timestamps (invariant #1).
- Temp passwords: crypto-random, shown once, never persisted in plaintext, never logged, never in audit payloads.
- Login: uniform "invalid credentials" for unknown user / wrong password / inactive user (no user enumeration); rate-limit by username+IP.
- Session invalidation on deactivation and on password change (other sessions).
- `assignment.service` is the only writer of `assigneeUserId`; UI/actions never write it directly.
- Every new mutation: same-transaction audit row (invariant #5); grep-clean of raw enums/table names in rendered UI (hard bans).

## 10. Testing & verification (table-driven, per CLAUDE.md convention)

- **Assignment rules:** claim by non-dept member → `NOT_IN_DEPARTMENT`; claim already-assigned → `ALREADY_ASSIGNED`; assign to user outside dept → `ASSIGNEE_NOT_IN_DEPARTMENT`; assign by non-supervisor peer → `FORBIDDEN`; reassign writes before→after audit; release returns to pool.
- **Gates unaffected (D16):** an assigned-but-gated plan still refuses start; an unassigned plan with open gates refuses claim-then-start the same as before (claim succeeds, start refuses).
- **Admin:** createEmployee generates temp password + `mustChangePassword`; duplicate username rejected; bulk import partial-failure report correct; deactivated user's login refused + sessions dead; self-deactivation refused.
- **First-login flow:** `mustChangePassword` user is interstitial-locked from every route; after change, lands per router.
- **Reads:** mine/pool/teamHeld partition is exact (no row in two buckets, none lost); scoreboard RBAC (peer requesting peer's scoreboard → `FORBIDDEN`); `/my-day` counts equal workspace counts for the same actor.
- **DB tier** `RUN_DB_TESTS=1 pnpm test`, run twice, rerun-safe. Browser pass: create employee in /admin → print slip → log in as them in a second browser → forced password change → land on /my-day → claim → start → submit → verify as QC → watch dept Command Center + /dashboard reflect. `pnpm typecheck && pnpm lint && pnpm build` clean. Light + dark.

## 11. Open questions / DESPL inputs

- **C9 (blocking P4 bulk import):** the actual staff list — name, dept, role, email-or-code — for all 13 departments.
- **C28 (new):** password policy minimums (length/complexity) — default in use: ≥10 chars, no complexity theatre.
- **C29 (new):** should deactivation auto-release the person's pool items after N days? Default: no auto-release, warning chip only.
- C24/C25/C27 remain open from prior specs and do not block this build.

## 12. Non-goals (v1)

Auto-assignment / load-levelling (invariant #10) · SSO/2FA · operator-level accounts (mobile phase, D12) · department-native record objects (RFQ/PO/drawing tables) · editing personal scoreboard formulas · email delivery of credentials (slip/CSV hand-off only until SMTP exists).

## 13. Rollout

Sequential P1 → P2 → (P3 ∥ P4); each phase lands with its tests green before the next starts (P0-style discipline). Commit to `demo` only; merge to `main` only on explicit approval. Update progress.md at every session end. See PLAN-personal-dashboards-v1.md for tasks and session prompts.
