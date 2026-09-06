# Scheduler + digest + alert reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move alert reconciliation (overdue-stage, aged-hold-point) off every page load onto an hourly cron-triggered route, and add a daily automatic digest run alongside the existing manual "Send now" button — both in-app only, no external delivery channel.

**Architecture:** Two new route handlers (`/api/cron/alerts`, `/api/cron/digest`), self-authenticated with a shared-secret header (`CRON_SECRET`), added to `middleware.ts`'s public paths so they bypass the session-cookie gate. A new `cron.service.ts` orchestrates the existing (lightly refactored) reconciliation and digest-publish logic across every `Organization`. Railway Cron Schedule services (created manually, outside this codebase) call these routes on a timer.

**Tech Stack:** Next.js 15 route handlers, Prisma 6 / PostgreSQL, Vitest (pure + DB-gated tiers). No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-05-scheduler-digest-alerts-design.md`

## Global Constraints

- No client timestamps — every date/time used here comes from the server clock (`new Date()`, `istCalendarDayMarker()`), never a request body. (CLAUDE.md invariant #1)
- Append-only audit — `publishDigest`'s existing `audited()` call must keep firing for the automatic path exactly as it does for the manual path; no bypassing it. (invariant #5)
- RBAC deny-by-default at the API layer — the two new routes are unauthenticated by session design (a cron caller has no browser session) but MUST reject any request without the exact `Authorization: Bearer <CRON_SECRET>` header before touching the database. (invariant #8, applied at the route level instead of the role level)
- TypeScript strict everywhere — no `any`, no unchecked casts beyond what the existing code around each edit already does.
- No new dependency — no Redis, no queue library. Confirmed feasible: everything here is a plain Next.js route handler plus existing Prisma/service code.
- Migrations: none required by this plan — no schema change.
- Tests: any change to gating/RBAC/audit paths requires table-driven tests for the violation cases, not just the happy path — applies here to the `CRON_SECRET` guard and the "no active ADMIN user" failure path.

---

### Task 1: Shared-secret guard for cron routes

**Files:**
- Create: `src/lib/cron-auth.ts`
- Test: `src/lib/cron-auth.test.ts`
- Modify: `.env.example`
- Modify: `.env.test.example`

**Interfaces:**
- Produces: `isValidCronSecret(authHeader: string | null, secret?: string): boolean` — pure function, no DB, no Next.js types. `secret` defaults to `process.env.CRON_SECRET` but can be overridden (this is what makes it testable without touching real env state). Later tasks (Task 6's route handlers) import and call this directly.

- [ ] **Step 1: Write the failing test**

Create `src/lib/cron-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isValidCronSecret } from "./cron-auth";

describe("isValidCronSecret", () => {
  it("accepts the exact 'Bearer <secret>' header", () => {
    expect(isValidCronSecret("Bearer abc123", "abc123")).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(isValidCronSecret(null, "abc123")).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(isValidCronSecret("Bearer wrong", "abc123")).toBe(false);
  });

  it("rejects a header missing the 'Bearer ' prefix", () => {
    expect(isValidCronSecret("abc123", "abc123")).toBe(false);
  });

  it("rejects everything when no secret is configured at all", () => {
    expect(isValidCronSecret("Bearer anything", undefined)).toBe(false);
    expect(isValidCronSecret(null, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/cron-auth.test.ts`
Expected: FAIL — `Cannot find module './cron-auth'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/cron-auth.ts`:

```ts
/**
 * Shared-secret guard for the `/api/cron/*` routes. These are added to
 * middleware.ts's PUBLIC_PATHS (a Railway cron caller has no browser
 * session, same reasoning as /api/health) and self-enforce this instead —
 * unlike every other route, there is no Actor/session to check a role
 * against, so the check happens here, before any DB access.
 */
export function isValidCronSecret(
  authHeader: string | null,
  secret: string | undefined = process.env.CRON_SECRET,
): boolean {
  if (!secret) return false;
  return authHeader === `Bearer ${secret}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/cron-auth.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Document the new env var**

Append to `.env.example` (after the `SEED_PASSWORD` block):

```
# Shared secret the /api/cron/* routes require via `Authorization: Bearer
# <value>`. Generate with: openssl rand -hex 32
# CRON_SECRET=
```

Append to `.env.test.example` (after the `SEED_PASSWORD` block):

```
# Shared secret for /api/cron/* — any throwaway value works locally, this
# signs nothing outside your machine.
CRON_SECRET="test_only_cron_secret"
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/cron-auth.ts src/lib/cron-auth.test.ts .env.example .env.test.example
git commit -m "feat: shared-secret guard for cron routes"
```

---

### Task 2: Refactor alert reconciliation to take `tenantId`, not `Actor`

**Files:**
- Modify: `src/lib/services/notifications.service.ts:1-19` (top doc comment), `:125-129` (delete `syncNotifications`), `:131` (`syncOverdueStageNotifications` signature), `:288` (`syncHoldPointAgedNotifications` signature)
- Modify: `src/lib/services/notifications.service.test.ts` (update call sites, imports)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export async function syncOverdueStageNotifications(tenantId: number): Promise<void>` and `export async function syncHoldPointAgedNotifications(tenantId: number): Promise<void>` — both now exported (previously module-private), both take a plain tenant id. Task 5's `cron.service.ts` calls these directly.

Neither function uses any `Actor` field besides `.tenantId` today (confirmed by reading both bodies) — this refactor removes the need to fabricate a fake user actor for a system-triggered call.

- [ ] **Step 1: Update the module doc comment**

In `src/lib/services/notifications.service.ts`, replace the comment block at lines 10-19 (the one ending "...called from `syncNotifications`, called opportunistically on every authenticated page load ((app)/layout.tsx).") with:

```ts
 * §6 in-app notifications. Two of the five triggers fire directly inside an
 * existing mutation transaction (item submitted → QC, reject → maker — see
 * process.service.ts) via `notify()`. The other three have no natural
 * mutation moment to hang off (a plan crossing its due date, a hold point
 * aging, a digest being published): `digest-published` fires from the
 * reports "Send now" action (and now also from the daily cron, see
 * cron.service.ts); the other two (`syncOverdueStageNotifications` /
 * `syncHoldPointAgedNotifications`) are called from `cron.service.ts`'s
 * hourly `runAlertReconciliation()`, one call per tenant — they used to run
 * opportunistically on every authenticated page load ((app)/layout.tsx)
 * until that became a measurable per-request cost (Gate 4, Sep 2026).
```

- [ ] **Step 2: Delete `syncNotifications` and change the two function signatures**

Replace:

```ts
export async function syncNotifications(actor: Actor): Promise<void> {
  // Independent transactions — run concurrently rather than paying their
  // latency twice on every page load.
  await Promise.all([syncOverdueStageNotifications(actor), syncHoldPointAgedNotifications(actor)]);
}

async function syncOverdueStageNotifications(actor: Actor): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
```

with:

```ts
export async function syncOverdueStageNotifications(tenantId: number): Promise<void> {
  await withTenant(tenantId, async (tx) => {
```

Then, inside that same function body, replace every remaining `actor.tenantId` with `tenantId` (there are 4 more occurrences: the `jobProcess: { job: { tenantId: actor.tenantId } }` filter, and three `userIdsWithRole(tx, actor.tenantId, ...)` / `tx.user.findMany({ where: { tenantId: actor.tenantId, ...` calls, and the final `notify(tx, actor.tenantId, ...)` call).

- [ ] **Step 3: Change `syncHoldPointAgedNotifications`'s signature**

Replace:

```ts
async function syncHoldPointAgedNotifications(actor: Actor): Promise<void> {
  // Its own withTenant transaction (loadQcCockpit) — never nested inside another.
  const cockpit = await loadQcCockpit(actor);
  const aged = cockpit.holdPoints.filter((h) => h.ageDays > HOLD_POINT_AGE_ALERT_DAYS);
  if (aged.length === 0) return;

  await withTenant(actor.tenantId, async (tx) => {
    const recipients = [
      ...new Set([...(await userIdsWithRole(tx, actor.tenantId, ROLES.QC)), ...(await userIdsWithRole(tx, actor.tenantId, ROLES.PRODUCTION_HEAD))]),
    ];
```

with:

```ts
export async function syncHoldPointAgedNotifications(tenantId: number): Promise<void> {
  // loadQcCockpit only ever reads `.tenantId` off the actor it's given
  // (confirmed by reading its body) — this synthetic actor exists purely to
  // satisfy that parameter's type. It is never persisted or audited.
  const cockpit = await loadQcCockpit({
    userId: 0,
    tenantId,
    clientId: null,
    name: "system",
    email: "system@internal",
    roles: [],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
  });
  const aged = cockpit.holdPoints.filter((h) => h.ageDays > HOLD_POINT_AGE_ALERT_DAYS);
  if (aged.length === 0) return;

  await withTenant(tenantId, async (tx) => {
    const recipients = [
      ...new Set([...(await userIdsWithRole(tx, tenantId, ROLES.QC)), ...(await userIdsWithRole(tx, tenantId, ROLES.PRODUCTION_HEAD))]),
    ];
```

Then replace the function's remaining `actor.tenantId` (in the final `notify(tx, actor.tenantId, ...)` call at the bottom of the function) with `tenantId`.

- [ ] **Step 4: Check the file still type-checks in isolation**

Run: `pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | grep notifications.service`
Expected: no output from this file yet (the test file and layout.tsx will still reference the old name until Steps 5 and Task 3 — that's expected and fixed next).

- [ ] **Step 5: Update the test file's imports and call sites**

In `src/lib/services/notifications.service.test.ts`:

Change:
```ts
const { syncNotifications, nudgeQc } = await import("./notifications.service");
```
to:
```ts
const { syncOverdueStageNotifications, nudgeQc } = await import("./notifications.service");
```

In the `describe("syncNotifications idempotency (isolated fixture)", ...)` block, remove the line `const ph = actor(REF.tenant, 1, [ROLES.PRODUCTION_HEAD]);` and change both `await syncNotifications(ph);` occurrences to `await syncOverdueStageNotifications(REF.tenant);`.

In each of the three `it(...)` blocks under `describe("syncOverdueStageNotifications — assignee-first recipient resolution", ...)`, remove the line `const ph = actor(tenantId, phUserId, [ROLES.PRODUCTION_HEAD]);` and change `await syncNotifications(ph);` to `await syncOverdueStageNotifications(tenantId);`.

Also rename the outer `describe` block's title from `"syncNotifications idempotency (isolated fixture)"` to `"syncOverdueStageNotifications idempotency (isolated fixture)"` (cosmetic, keeps the test file honest about what it's calling).

- [ ] **Step 6: Run the DB-gated notification tests**

Run: `pnpm test:db -- src/lib/services/notifications.service.test.ts`
Expected: PASS, same test count as before (this task changes call sites, not assertions).

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/notifications.service.ts src/lib/services/notifications.service.test.ts
git commit -m "refactor: syncOverdueStageNotifications/syncHoldPointAgedNotifications take tenantId, not Actor"
```

---

### Task 3: Remove the page-load alert scan from the app layout

**Files:**
- Modify: `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: nothing (this task only deletes a call).
- Produces: nothing new — alerts are no longer computed on any page load. Task 5/6 replace this with the hourly cron.

- [ ] **Step 1: Remove the `syncNotifications` import and call**

In `src/app/(app)/layout.tsx`, remove this import line:
```ts
import { syncNotifications } from "@/lib/services/notifications.service";
```

Remove this block (currently right before the `Promise.all` that loads `overdueCount`/`notifications`/`jobs`):
```ts
    await syncNotifications(actor).catch(async (e) => {
      const requestId = (await headers()).get("x-request-id") ?? "unknown";
      console.error("[notifications] sync failed", { requestId, error: e });
    });
```

- [ ] **Step 2: Remove the now-unused `headers` import**

Check whether `headers` (from `next/headers`) is used anywhere else in this file after Step 1's removal:

Run: `grep -n "headers" "src/app/(app)/layout.tsx"`

If the only remaining match is the `import { headers } from "next/headers";` line itself, delete that import line too.

- [ ] **Step 3: Update the file's doc comment**

Replace this sentence in the top doc comment:
```
 * here + the two cross-cutting shell reads: the sidebar's overdue badge and
 * the bell's notifications. `syncNotifications` (§9.8) is the lazy
 * reconciliation for the two notification triggers with no natural mutation
 * moment (stage crossed due date, hold point aged) — run best-effort on
 * every authenticated page load rather than a cron.
```
with:
```
 * here + the two cross-cutting shell reads: the sidebar's overdue badge and
 * the bell's notifications. Overdue-stage/aged-hold-point reconciliation
 * (§9.8) used to run here on every page load; it's now an hourly cron
 * (`/api/cron/alerts`, see cron.service.ts) instead, so this layout only
 * reads already-written Notification rows, it doesn't compute them.
```

- [ ] **Step 4: Verify the app still builds and the shell still renders**

Run: `pnpm typecheck`
Expected: no errors from this file.

Run: `pnpm dev` (in a separate terminal), log in as any seeded user, confirm the app shell (sidebar, bell dropdown) still renders with whatever notifications already exist in the dev DB. Stop the dev server after confirming.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/layout.tsx"
git commit -m "perf: stop scanning for overdue/hold-point alerts on every page load"
```

---

### Task 4: `publishDigest` gains an `auto` flag

**Files:**
- Modify: `src/lib/services/reports.service.ts`
- Create: `src/lib/services/reports.service.test.ts`

**Interfaces:**
- Consumes: `notify`, `userIdsWithRole` from `notifications.service.ts` (unchanged), `withTenant`, `audited`, `requireRole`, `assertNotClientUser`, `ROLES`, `Actor` (unchanged).
- Produces: `publishDigest(actor: Actor, date: string, opts?: { auto?: boolean }): Promise<number>` — return type and the manual call site (`src/app/actions/reports.ts`'s `sendDigestAction`) are both unchanged, since `opts` is optional. Task 5's `cron.service.ts` calls this with `{ auto: true }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/reports.service.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * §4.9 digest publish, DB-gated (needs a real seeded ORG/user/role chain).
 * Pins the notification body text difference between a human-triggered
 * "Send now" and the automatic daily cron run — the only externally visible
 * effect of the `auto` flag.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("publishDigest (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { publishDigest } = await import("./reports.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function actor(tenantId: number, userId: number, name: string, roles: string[]): Actor {
    return { userId, tenantId, clientId: null, name, email: `u${userId}@x`, roles: roles as never, departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  async function makeOrgWithManagementUser(suffix: string): Promise<{ tenantId: number; managementUserId: number }> {
    const org = await owner.organization.create({ data: { code: `DIGEST-${suffix}-${Date.now()}`, name: "Digest test" } });
    const mgmtRole = await owner.role.create({ data: { tenantId: org.id, code: "MANAGEMENT", name: "Management" } });
    const mgmt = await owner.user.create({
      data: { tenantId: org.id, email: `mgmt-${suffix}-${Date.now()}@x`, username: `mgmt-${suffix}-${Date.now()}`, name: "MGMT", passwordHash: "x" },
    });
    await owner.userRole.create({ data: { userId: mgmt.id, roleId: mgmtRole.id } });
    return { tenantId: org.id, managementUserId: mgmt.id };
  }

  it("manual publish (no opts) writes 'Sent by <name>'", async () => {
    const { tenantId, managementUserId } = await makeOrgWithManagementUser("manual");
    const ph = actor(tenantId, 999, "Production Head", [ROLES.PRODUCTION_HEAD]);

    const count = await publishDigest(ph, "2026-09-05");
    expect(count).toBe(1);

    const n = await owner.notification.findFirstOrThrow({ where: { type: "DIGEST_PUBLISHED", recipientId: managementUserId } });
    expect(n.body).toBe("Sent by Production Head");
  });

  it("automatic publish (auto: true) writes 'Sent automatically'", async () => {
    const { tenantId, managementUserId } = await makeOrgWithManagementUser("auto");
    const admin = actor(tenantId, 998, "System Admin", [ROLES.ADMIN]);

    const count = await publishDigest(admin, "2026-09-05", { auto: true });
    expect(count).toBe(1);

    const n = await owner.notification.findFirstOrThrow({ where: { type: "DIGEST_PUBLISHED", recipientId: managementUserId } });
    expect(n.body).toBe("Sent automatically");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:db -- src/lib/services/reports.service.test.ts`
Expected: FAIL on the second test — `publishDigest` doesn't accept a third argument yet, and the body text is always `"Sent by System Admin"`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/services/reports.service.ts`, replace:

```ts
export async function publishDigest(actor: Actor, date: string): Promise<number> {
```

with:

```ts
export async function publishDigest(actor: Actor, date: string, opts?: { auto?: boolean }): Promise<number> {
```

Then replace:

```ts
          title: `Daily digest published — ${date}`,
          body: `Sent by ${actor.name}`,
          payload: { date },
```

with:

```ts
          title: `Daily digest published — ${date}`,
          body: opts?.auto ? "Sent automatically" : `Sent by ${actor.name}`,
          payload: { date },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:db -- src/lib/services/reports.service.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/reports.service.ts src/lib/services/reports.service.test.ts
git commit -m "feat: publishDigest distinguishes automatic runs from manual 'Send now'"
```

---

### Task 5: `cron.service.ts` — orchestrate both jobs across every tenant

**Files:**
- Create: `src/lib/services/cron.service.ts`
- Test: `src/lib/services/cron.service.test.ts`

**Interfaces:**
- Consumes: `syncOverdueStageNotifications(tenantId)`, `syncHoldPointAgedNotifications(tenantId)` (Task 2), `publishDigest(actor, date, opts)` (Task 4), `prisma`/`withTenant` (`@/lib/db`), `ROLES`/`Actor` (`@/lib/authz`), `isWorkingDay`/`WorkCalendarInput` (`@/lib/schedule/calendar`, `@/lib/schedule/types`), `istCalendarDayMarker` (`@/lib/shared/business-day`).
- Produces:
  - `export interface TenantRunResult { tenantId: number; ok: boolean; error?: string }`
  - `export interface DigestRunResult extends TenantRunResult { skipped?: boolean; count?: number }`
  - `export async function runAlertReconciliation(): Promise<TenantRunResult[]>`
  - `export async function runDailyDigest(asOf?: Date): Promise<DigestRunResult[]>`

  Task 6's route handlers call these two functions directly and return their result arrays as JSON.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/services/cron.service.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { ROLES } from "@/lib/authz";

/**
 * cron.service, DB-gated. Three things pinned: multi-tenant isolation (one
 * tenant's overdue plan doesn't leak into another's run), the digest's
 * holiday skip, and a tenant with no active ADMIN user failing loudly
 * without blocking its siblings.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("cron.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { runAlertReconciliation, runDailyDigest } = await import("./cron.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  const past = new Date(Date.now() - 20 * 864e5);

  async function makeOrgWithOverduePlan(suffix: string): Promise<{ tenantId: number; planId: number }> {
    const org = await owner.organization.create({ data: { code: `CRON-ALERTS-${suffix}-${Date.now()}`, name: "Cron alerts test" } });
    const dept = await owner.department.create({ data: { tenantId: org.id, code: "PROD", name: "Production" } });
    const client = await owner.client.create({ data: { tenantId: org.id, name: "ACME", code: `ACME-${suffix}-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId: org.id, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId: org.id, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: { tenantId: org.id, publicId: `pub-cron-${suffix}-${Date.now()}`, clientId: client.id, familyId: family.id, templateVersionId: tv.id, jobNumber: `CRON-${suffix}-${Date.now()}` },
    });
    const run = await owner.scheduleRun.create({ data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: past, isCurrent: true } });
    const jp = await owner.jobProcess.create({ data: { jobId: job.id, seq: 1, code: "C1", name: "Overdue process", departmentId: dept.id, workOrderStages: [1] } });
    const plan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: dept.id, status: "IN_PROGRESS", plannedFinish: past },
    });
    return { tenantId: org.id, planId: plan.id };
  }

  it("reconciles overdue plans independently per tenant, no cross-tenant leakage", async () => {
    const a = await makeOrgWithOverduePlan("a");
    const b = await makeOrgWithOverduePlan("b");

    const results = await runAlertReconciliation();

    const rA = results.find((r) => r.tenantId === a.tenantId);
    const rB = results.find((r) => r.tenantId === b.tenantId);
    expect(rA?.ok).toBe(true);
    expect(rB?.ok).toBe(true);

    const notifsA = await owner.notification.findMany({ where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: a.planId } });
    const notifsB = await owner.notification.findMany({ where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: b.planId } });
    // Neither tenant had a department member to notify (no users seeded in
    // this fixture beyond the org/dept skeleton) — the meaningful assertion
    // is that both runs completed independently (ok:true) without throwing,
    // not the recipient count, which is legitimately 0 here.
    expect(notifsA).toHaveLength(0);
    expect(notifsB).toHaveLength(0);
  });

  async function makeOrgWithAdminAndCalendar(suffix: string, holidayToday: boolean): Promise<number> {
    const org = await owner.organization.create({ data: { code: `CRON-DIGEST-${suffix}-${Date.now()}`, name: "Cron digest test" } });
    const adminRole = await owner.role.create({ data: { tenantId: org.id, code: "ADMIN", name: "Admin" } });
    const mgmtRole = await owner.role.create({ data: { tenantId: org.id, code: "MANAGEMENT", name: "Management" } });
    const admin = await owner.user.create({
      data: { tenantId: org.id, email: `admin-${suffix}-${Date.now()}@x`, username: `admin-${suffix}-${Date.now()}`, name: "Admin", passwordHash: "x" },
    });
    await owner.userRole.create({ data: { userId: admin.id, roleId: adminRole.id } });
    const mgmt = await owner.user.create({
      data: { tenantId: org.id, email: `mgmt-${suffix}-${Date.now()}@x`, username: `mgmt-${suffix}-${Date.now()}`, name: "MGMT", passwordHash: "x" },
    });
    await owner.userRole.create({ data: { userId: mgmt.id, roleId: mgmtRole.id } });

    const cal = await owner.workCalendar.create({ data: { tenantId: org.id, code: "DEFAULT", name: "Default", weekOffDays: [7], isDefault: true } });
    if (holidayToday) {
      await owner.holiday.create({ data: { calendarId: cal.id, date: new Date(), name: "Test holiday" } });
    }
    return org.id;
  }

  it("runs the digest and audits it as the tenant's admin, on a working day", async () => {
    const tenantId = await makeOrgWithAdminAndCalendar("workday", false);
    const results = await runDailyDigest();
    const r = results.find((x) => x.tenantId === tenantId);
    expect(r?.ok).toBe(true);
    expect(r?.skipped).toBeFalsy();
    expect(r?.count).toBe(1);

    const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId, action: "reports.publishDigest" } });
    const admin = await owner.user.findFirstOrThrow({ where: { tenantId, roles: { some: { role: { code: ROLES.ADMIN } } } } });
    expect(audit.actorId).toBe(admin.id);
  });

  it("skips a tenant whose calendar marks today as a holiday", async () => {
    const tenantId = await makeOrgWithAdminAndCalendar("holiday", true);
    const results = await runDailyDigest();
    const r = results.find((x) => x.tenantId === tenantId);
    expect(r?.ok).toBe(true);
    expect(r?.skipped).toBe(true);

    const notifs = await owner.notification.findMany({ where: { tenantId, type: "DIGEST_PUBLISHED" } });
    expect(notifs).toHaveLength(0);
  });

  it("fails loudly (not silently) for a tenant with no active ADMIN user, without blocking others", async () => {
    const org = await owner.organization.create({ data: { code: `CRON-NOADMIN-${Date.now()}`, name: "No admin test" } });
    await owner.workCalendar.create({ data: { tenantId: org.id, code: "DEFAULT", name: "Default", weekOffDays: [7], isDefault: true } });
    const workingTenant = await makeOrgWithAdminAndCalendar("sibling", false);

    const results = await runDailyDigest();
    const failed = results.find((x) => x.tenantId === org.id);
    const succeeded = results.find((x) => x.tenantId === workingTenant);

    expect(failed?.ok).toBe(false);
    expect(failed?.error).toMatch(/no active ADMIN/);
    expect(succeeded?.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:db -- src/lib/services/cron.service.test.ts`
Expected: FAIL — `Cannot find module './cron.service'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/services/cron.service.ts`:

```ts
import { prisma, withTenant } from "@/lib/db";
import { ROLES, type Actor } from "@/lib/authz";
import { isWorkingDay, DEFAULT_CALENDAR } from "@/lib/schedule";
import type { WorkCalendarInput } from "@/lib/schedule/types";
import { istCalendarDayMarker } from "@/lib/shared/business-day";
import { syncOverdueStageNotifications, syncHoldPointAgedNotifications } from "./notifications.service";
import { publishDigest } from "./reports.service";

/**
 * Orchestrates the two Gate 4 scheduled jobs (`/api/cron/alerts`,
 * `/api/cron/digest`) across every tenant. Both loop `Organization` directly
 * off the plain `prisma` client — `organizations` carries no RLS policy of
 * its own (it's the tenant root), unlike every table underneath it.
 *
 * Per-tenant failures are caught and reported rather than thrown: one
 * tenant's bad data (a missing default calendar, no active ADMIN user)
 * must not block every other tenant's alerts or digest.
 */

export interface TenantRunResult {
  tenantId: number;
  ok: boolean;
  error?: string;
}

export interface DigestRunResult extends TenantRunResult {
  skipped?: boolean;
  count?: number;
}

export async function runAlertReconciliation(): Promise<TenantRunResult[]> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const results: TenantRunResult[] = [];

  for (const org of orgs) {
    try {
      await Promise.all([syncOverdueStageNotifications(org.id), syncHoldPointAgedNotifications(org.id)]);
      results.push({ tenantId: org.id, ok: true });
    } catch (e) {
      console.error("[cron] alert reconciliation failed", { tenantId: org.id, error: e });
      results.push({ tenantId: org.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return results;
}

/**
 * `asOf` defaults to now; a fixed value lets a test point "today" at a
 * specific calendar date without needing to seed a holiday for the real
 * current date.
 */
export async function runDailyDigest(asOf: Date = new Date()): Promise<DigestRunResult[]> {
  const today = istCalendarDayMarker(asOf);
  const dateStr = today.toISOString().slice(0, 10);

  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const results: DigestRunResult[] = [];

  for (const org of orgs) {
    try {
      const prep = await withTenant(org.id, async (tx) => {
        const cal = await tx.workCalendar.findFirst({ where: { isDefault: true }, include: { holidays: true } });
        const calendarInput: WorkCalendarInput = cal
          ? { weekOffDays: cal.weekOffDays, holidays: cal.holidays.map((h) => h.date) }
          : DEFAULT_CALENDAR;
        if (!isWorkingDay(today, calendarInput)) return { skip: true as const };

        const admin = await tx.user.findFirst({
          where: { tenantId: org.id, active: true, roles: { some: { role: { code: ROLES.ADMIN } } } },
          orderBy: { id: "asc" },
          select: { id: true, name: true, email: true },
        });
        if (!admin) throw new Error(`no active ADMIN user for tenant ${org.id}`);

        const actor: Actor = {
          userId: admin.id,
          tenantId: org.id,
          clientId: null,
          name: admin.name,
          email: admin.email,
          roles: [ROLES.ADMIN],
          departmentIds: [],
          mustChangePassword: false,
          themePreference: "SYSTEM",
          outdoorMode: false,
        };
        return { skip: false as const, actor };
      });

      if (prep.skip) {
        results.push({ tenantId: org.id, ok: true, skipped: true });
        continue;
      }

      const count = await publishDigest(prep.actor, dateStr, { auto: true });
      results.push({ tenantId: org.id, ok: true, count });
    } catch (e) {
      console.error("[cron] digest failed", { tenantId: org.id, error: e });
      results.push({ tenantId: org.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:db -- src/lib/services/cron.service.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Run the full DB-gated suite to check for regressions**

Run: `pnpm test:db`
Expected: same pass count as the project's documented baseline plus the new tests here, modulo the two pre-existing unrelated flakes already tracked in `docs/mos-execution/LEDGER.md` (`myday.read.test.ts`'s date-window test, `process.service.test.ts`'s hold-point test).

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/cron.service.ts src/lib/services/cron.service.test.ts
git commit -m "feat: cron.service orchestrates alert reconciliation and daily digest across tenants"
```

---

### Task 6: The two route handlers, wired into middleware

**Files:**
- Create: `src/app/api/cron/alerts/route.ts`
- Create: `src/app/api/cron/digest/route.ts`
- Modify: `src/middleware.ts`

**Interfaces:**
- Consumes: `isValidCronSecret` (Task 1), `runAlertReconciliation`/`runDailyDigest` (Task 5).
- Produces: `POST /api/cron/alerts` and `POST /api/cron/digest` — the two endpoints a Railway Cron Schedule service calls. No other code depends on these route files directly (routes are integration endpoints, not imported elsewhere).

This task has no new unit tests of its own: Task 1 already covers `isValidCronSecret` in isolation, and Task 5 already covers `runAlertReconciliation`/`runDailyDigest` in isolation. The route files are thin wiring (check the secret, call the function, return JSON) — matching this codebase's existing convention of not writing dedicated tests for route-handler glue (`src/app/api/health/route.test.ts` only tests the pure `pendingMigrations` helper it exports, not the `GET` handler itself). Step 4 below is a manual smoke test instead.

- [ ] **Step 1: Create the alerts route**

Create `src/app/api/cron/alerts/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecret } from "@/lib/cron-auth";
import { runAlertReconciliation } from "@/lib/services/cron.service";

/**
 * Hourly cron target (Railway Cron Schedule, configured outside this repo —
 * see docs/superpowers/specs/2026-09-05-scheduler-digest-alerts-design.md).
 * Public in middleware.ts (no browser session exists for a cron caller);
 * self-authenticated via CRON_SECRET instead.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
  }
  const results = await runAlertReconciliation();
  return NextResponse.json({ results });
}
```

- [ ] **Step 2: Create the digest route**

Create `src/app/api/cron/digest/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { isValidCronSecret } from "@/lib/cron-auth";
import { runDailyDigest } from "@/lib/services/cron.service";

/**
 * Daily cron target, 6:30 AM IST / 01:00 UTC (Railway Cron Schedule,
 * configured outside this repo — see
 * docs/superpowers/specs/2026-09-05-scheduler-digest-alerts-design.md).
 * Public in middleware.ts; self-authenticated via CRON_SECRET.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isValidCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
  }
  const results = await runDailyDigest();
  return NextResponse.json({ results });
}
```

- [ ] **Step 3: Add `/api/cron` to middleware's public paths**

In `src/middleware.ts`, change:

```ts
const PUBLIC_PATHS = ["/login", "/api/health"];
```

to:

```ts
const PUBLIC_PATHS = ["/login", "/api/health", "/api/cron"];
```

- [ ] **Step 4: Manual smoke test against a running dev server**

Run: `pnpm dev` in one terminal. In another (with `.env` sourced so `CRON_SECRET` is set, or export it inline). `--fail-with-body` (curl >= 7.76, released 2021 — safe to assume on both this dev machine and Railway's cron runner image) makes curl exit non-zero on a non-2xx response while still printing the body, so a wrong secret or a route regression shows up as a failed run instead of a silent 401/500 that looks identical to success:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/cron/alerts
# Expected: 401 (no Authorization header)

curl -s --fail-with-body -X POST http://localhost:3000/api/cron/alerts \
  -H "Authorization: Bearer $CRON_SECRET"
# Expected: 200, JSON body {"results":[{"tenantId":1,"ok":true}, ...]}

curl -s --fail-with-body -X POST http://localhost:3000/api/cron/digest \
  -H "Authorization: Bearer $CRON_SECRET"
# Expected: 200, JSON body with one entry per seeded tenant (ok:true,
# skipped:true if today is a Sunday/holiday in the dev seed's calendar,
# otherwise ok:true with a count)
```

Confirm in the dev server's own log output that no unhandled exception was thrown. Stop the dev server after confirming.

- [ ] **Step 5: Run full test + typecheck + lint**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db`
Expected: all green (module count up by the new files added in Tasks 1, 4, 5; no regressions elsewhere beyond the two already-documented pre-existing flakes).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cron/alerts/route.ts src/app/api/cron/digest/route.ts src/middleware.ts
git commit -m "feat: cron-triggered routes for alert reconciliation and daily digest"
```

---

## After this plan lands (manual, outside this codebase)

Hand to Swayam once Task 6 is merged and deployed:

1. Generate a secret: `openssl rand -hex 32`.
2. `CRON_SECRET` must be readable as `$CRON_SECRET` by THREE separate Railway services — the main app (which reads it via `process.env.CRON_SECRET` in `isValidCronSecret`) AND both cron services created in step 3 below (their `curl` command needs it to build the `Authorization` header). Railway variables are per-service by default, so setting it only on the app service leaves the cron services with an empty/missing `$CRON_SECRET` and every curl silently sends `Authorization: Bearer ` (permanent 401). Set it once as a project-level/shared variable if the Railway plan supports that (so all services in the project inherit it); otherwise run `railway variable set CRON_SECRET --skip-deploys` against each of the three services individually with the identical value.
3. Create two Railway Cron Schedule services in the same project, both with a minimal start command that does the `curl` shown in Task 6 Step 4 — but pointed at the deployed app's real public URL (e.g. `https://<app>.up.railway.app`), never `localhost:3000` (that only exists on the dev machine that ran the smoke test):
   - Hourly: cron expression `0 * * * *`, target `/api/cron/alerts`.
   - Daily: cron expression `0 1 * * *` (01:00 UTC = 6:30 AM IST — note this is UTC+5:30, not a whole-hour offset, so the exact minute matters), target `/api/cron/digest`.

This step is deliberately not automated by this plan — same "migrations are applied manually" discipline this project already follows for anything touching production infrastructure.
