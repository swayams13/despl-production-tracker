# Job Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Admin or Production Head create a new project end to end from inside the app — equipment type, process route, equipment and serials, design configuration, and the client's committed date — and immediately see whether that date is achievable.

**Architecture:** One audited transaction materialises `Job` + `JobProcess` + `JobProcessEdge` + `Equipment` + `Unit` from a pinned `ProcessTemplateVersion`, mirroring the loop `prisma/seed.ts` already runs. Scheduling runs *after* that transaction commits, deliberately, so a provisional route's `SCHEDULE_DATA_MISSING` refusal cannot roll back a perfectly good job. A five-step wizard holds its state in the URL query string.

**Tech Stack:** TypeScript strict, Next.js 15 App Router, Prisma 6 + PostgreSQL 16 with RLS, zod, vitest, React Server Components + client components for the wizard.

**Spec:** `docs/superpowers/specs/2026-08-22-job-intake-design.md`

**Companion plan:** `docs/superpowers/plans/2026-08-22-route-authoring.md`. Independent — Tasks 1–4 here touch no template code, and the wizard is fully buildable against pressure vessels alone. Until route authoring ships, Task 10's family list has one selectable entry.

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include these.

- **No client timestamps (invariant #1).** Every `actual_*` on a job is set by `process.service.ts` from the DB clock and nowhere else. No request DTO may contain an `actual_*` or `*_at` field. All zod schemas are `.strict()`. `orderDate`, `committedDeliveryDate` and `targetDispatchDate` are *planning* dates a planner legitimately supplies — `schedule.service.ts:104` already draws exactly this distinction in a comment.
- **Append-only audit (invariant #5).** Every mutation goes through `audited()` from `@/lib/audit`, writing its row in the same transaction. Never call `tx.auditLog.create` from a service.
- **RBAC deny-by-default (invariant #8).** Every exported service function calls `requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)` and `assertNotClientUser(actor)` before any DB read.
- **Explainable refusals (invariant #12).** Throw `AppError` with a stable code from `ERROR_CODES`, never a bare `Error`. The context object is named **`detail`** (singular).
- **Tenant RLS.** Any new table carrying `tenant_id` is a tenant-root table and needs a `tenant_isolation` policy in the same migration. Job-child tables (`Equipment`, `Unit`, `BomItem`) correctly have none — they are reachable only through `jobs`.
- **All service work runs inside `withTenant(actor.tenantId, async (tx) => …)`** from `@/lib/db`. Services take `tx`, never the bare prisma client.
- **Tests:** `pnpm test` is pure only. DB tests are gated `describe.skipIf(!process.env.RUN_DB_TESTS)` and run via `pnpm test:db`, which sources `.env.test` and targets `despl_test`. **Never** run `RUN_DB_TESTS` against `despl_demo`.
- **Never forge a session.** To verify a screen, log in through the real `/login` form with browser automation. Never read `AUTH_SECRET`, never hand-build a cookie or JWT. If browser automation is unavailable, say so and report verification as incomplete — see the "Agent conduct" section of `CLAUDE.md`.
- **UI:** dark industrial theme, tokens from `globals.css`. JetBrains Mono with `tabular-nums` for all numeric data. No dead controls, no mock data in components, no `localStorage` for app state, no raw enums in the UI. Every page ships a loading skeleton, an empty state, an error state, visible keyboard focus and reduced-motion support.
- **Branch:** work on `demo`. Never merge to `main` without explicit human approval.

---

### Task 1: Rename `deliveryDate` → `committedDeliveryDate`, add `targetDispatchDate` and `specs`

Its own commit, with the suite green, before any wizard code exists. A rename bug and a wizard bug must never share a diff.

**Files:**
- Modify: `prisma/schema.prisma:634` (the `Job` model)
- Create: `prisma/migrations/<timestamp>_job_dates_and_specs/migration.sql`
- Modify (mechanical, every `deliveryDate` occurrence): `src/lib/services/client-snapshot.read.ts:141,200` · `src/lib/services/portfolio.read.ts:133,135` · `src/lib/services/override.service.ts:163` · `src/lib/services/job-health.ts:33,78,80,82,85` · `src/lib/services/schedule.service.ts:81,86,92,110,113,158` · `src/lib/services/jobs.read.ts:21,59,121,124,152` · `src/lib/services/job-detail.read.ts:21,41,71,72,83` · `src/lib/services/workspace.read.ts:485,490,514,552,626,627,658,660,755` · `src/lib/shared/schemas.ts:33` (comment) · `prisma/seed.ts:843`
- Modify (tests): `src/lib/services/job-health.test.ts:9,20,21,22,27,28,43` · `src/lib/services/workspace.read.test.ts:106`
- Modify (UI): `src/app/(app)/dashboard/_portfolio.tsx:170` · `src/app/(app)/dashboard/page.tsx:196,201` · `src/app/(app)/jobs/page.tsx:81` · `src/app/(app)/jobs/[id]/_client.tsx:88,90`

**Interfaces:**
- Consumes: nothing
- Produces: `Job.committedDeliveryDate: Date | null`, `Job.targetDispatchDate: Date | null`, `Job.specs: JsonValue | null`; the read-model field `committedDeliveryDate` on `JobRow` (`jobs.read.ts`), `JobDetailHeader` (`job-detail.read.ts`), `JobHealthInput` (`job-health.ts`) and the workspace KPI type

- [ ] **Step 1: Change the schema**

In `prisma/schema.prisma`, in the `Job` model, replace the `deliveryDate` line and add two fields:

```prisma
  orderDate               DateTime?   @map("order_date")
  /// The contractual date given to the client. BACKWARD scheduling anchors on
  /// this by default, and every overdue / KPI / forecast-vs-due calculation
  /// measures against it. Renamed from `deliveryDate` (22 Aug 2026): the CSV
  /// import was writing a *dispatch* date into a field the scheduler read as a
  /// *required delivery* date, conflating two different commitments.
  committedDeliveryDate   DateTime?   @map("committed_delivery_date")
  /// DESPL's own internal target, normally earlier than the committed date and
  /// carrying their buffer. Never shown to a client user.
  targetDispatchDate      DateTime?   @map("target_dispatch_date")
  /// Family-shaped design configuration (design pressure, MDMT, MOC, …).
  /// Display and reference data ONLY. Nothing in lib/schedule/ or the gating
  /// path may read it — the moment a schedule depends on a free-shaped blob,
  /// refusals stop being explainable (invariant #12).
  specs                   Json?
```

- [ ] **Step 2: Write the migration by hand**

`prisma migrate dev` renders a rename as DROP + ADD, which loses every date. Create the folder and file yourself:

`prisma/migrations/20260822120000_job_dates_and_specs/migration.sql`

```sql
-- Split Job.deliveryDate into the two commitments it was conflating, and add
-- the design-configuration blob. RENAME, not DROP+ADD: the live CSV import
-- already loaded real dates into delivery_date and they must survive.
ALTER TABLE "jobs" RENAME COLUMN "delivery_date" TO "committed_delivery_date";
ALTER TABLE "jobs" ADD COLUMN "target_dispatch_date" TIMESTAMP(3);
ALTER TABLE "jobs" ADD COLUMN "specs" JSONB;
```

- [ ] **Step 3: Apply it and confirm Prisma sees no drift**

Run: `pnpm exec prisma migrate dev` (it will detect the already-written migration and apply it), then `pnpm exec prisma migrate status`
Expected: "Database schema is up to date!" and **no** new drift migration offered. If Prisma proposes another migration, the hand-written SQL does not match the schema — fix the SQL, never accept a generated DROP of `delivery_date`.

- [ ] **Step 4: Fix every compile error**

Run: `pnpm typecheck`

Work through the errors. This is a pure rename — `deliveryDate` becomes `committedDeliveryDate` at every site listed above, in the Prisma selects, the read-model interfaces, the test fixtures and the JSX. Two sites need thought rather than find-and-replace:

- `src/lib/services/schedule.service.ts:81` — `parsed.requiredDeliveryDate ?? spine.job.deliveryDate` becomes `?? spine.job.committedDeliveryDate`. The default anchor stays the *committed* date; the wizard will pass `requiredDeliveryDate` explicitly when the planner chooses to plan to the target instead. **No engine change.**
- `src/lib/services/client-snapshot.read.ts:141` **and** `:200` — both set `forecastDispatch` from the job date. Both become `committedDeliveryDate`. Do not miss the second one; it is in a different function.

- [ ] **Step 5: Confirm behaviour did not change**

Run: `pnpm test`
Expected: PASS. `job-health.test.ts` is table-driven — its fixture *keys* change, but every expected health value (`"DELAYED"`, `"ON_TRACK"`, `"NOT_PLANNED"`, `"AT_RISK"`) must stay exactly as it was. **If an expected value had to change, the rename broke behaviour — stop and find out why.**

- [ ] **Step 6: Confirm against the real database**

Run: `pnpm test:db && pnpm lint && pnpm build`
Expected: all PASS.

- [ ] **Step 7: Verify no dates were lost**

Run:

```bash
pnpm exec prisma db execute --stdin <<'SQL'
SELECT job_number, committed_delivery_date, target_dispatch_date
FROM jobs ORDER BY job_number;
SQL
```

Expected: DE0463 and DE0467 still carry the dates the CSV import gave them; `target_dispatch_date` is null everywhere. A table of nulls in `committed_delivery_date` means the migration dropped the column instead of renaming it — restore and fix.

- [ ] **Step 8: Commit**

```bash
git add prisma src/lib src/app
git commit -m "refactor(schema): split Job.deliveryDate into committed vs target dispatch dates

RENAME (not DROP+ADD) so the CSV-imported dates survive. Adds
target_dispatch_date for DESPL's internal buffer and specs jsonb for
design configuration. Pure rename at every read site: no expected test
value changed."
```

---

### Task 2: `EquipmentTypeRef` table, with RLS and a policy-coverage test

**Files:**
- Modify: `prisma/schema.prisma` (new model + `Equipment.equipmentTypeId`)
- Create: `prisma/migrations/<timestamp>_equipment_type_refs/migration.sql`
- Create: `src/lib/rls-coverage.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: the `EquipmentTypeRef` Prisma model; `Equipment.equipmentTypeId: number | null`

- [ ] **Step 1: Add the model**

In `prisma/schema.prisma`, beside the other `*Ref` models (after `ComponentTypeRef`, around line 366):

```prisma
/// Equipment catalog. The "type" of thing being built (HP Air Receiver,
/// 2000 L), distinct from ProductFamily (the process route it follows) and
/// from Equipment (one job's actual block). Carries tenant_id, so it is a
/// tenant-root table and has its own RLS policy — see the migration.
model EquipmentTypeRef {
  id                Int      @id @default(autoincrement())
  tenantId          Int      @map("tenant_id")
  familyId          Int      @map("family_id")
  /// Stable short code, e.g. HP-AIR-RCVR-2000
  code              String
  name              String
  defaultDesignCode String?  @map("default_design_code")
  /// Family-shaped design defaults, copied into Job.specs at intake.
  defaultSpecs      Json?    @map("default_specs")
  active            Boolean  @default(true)

  tenant     Organization  @relation(fields: [tenantId], references: [id])
  family     ProductFamily @relation(fields: [familyId], references: [id])
  equipments Equipment[]

  @@unique([tenantId, code])
  @@index([tenantId])
  @@index([familyId])
  @@map("equipment_type_refs")
}
```

Add the back-relation to `ProductFamily`:

```prisma
  equipmentTypes EquipmentTypeRef[]
```

Add the back-relation to `Organization` (matching how the other `*Ref` tables appear there):

```prisma
  equipmentTypes EquipmentTypeRef[]
```

And on `Equipment`:

```prisma
  /// Nullable: the seeded DE0463/DE0467 blocks came from CSV with free-text
  /// labels and no catalog entry. Backfilling them would mean inventing
  /// catalog rows, so they stay unlinked.
  equipmentTypeId Int? @map("equipment_type_id")

  equipmentType EquipmentTypeRef? @relation(fields: [equipmentTypeId], references: [id])
```

with `@@index([equipmentTypeId])`.

- [ ] **Step 2: Generate the migration WITHOUT applying it**

Run: `pnpm exec prisma migrate dev --name equipment_type_refs --create-only`

**`--create-only` is mandatory here.** Plain `prisma migrate dev` both generates AND immediately applies the migration, recording its checksum. If the file is then edited (Step 3) after that, the next `prisma migrate dev` detects the checksum no longer matches what was applied and refuses to proceed — it does not silently re-apply the edited file. `--create-only` writes the SQL file without applying it, so it can still be edited freely.

Expected: a new migration folder containing `CREATE TABLE "equipment_type_refs"`, `ALTER TABLE "equipments" ADD COLUMN "equipment_type_id"`, plus indexes and FKs. No DROP. Not yet applied — `pnpm exec prisma migrate status` will show it as pending.

- [ ] **Step 3: Append the RLS policy to that migration file**

Prisma does not generate RLS. Open the generated (still-unapplied) `migration.sql` and append, following the precedent at `prisma/migrations/20260815130000_welding_module/migration.sql:129`:

```sql
-- Tenant RLS on the new tenant-root table. equipment_type_refs carries
-- tenant_id, so it belongs with clients/departments/component_type_refs in
-- the fail-closed policy set; a tenant-root table with no policy is a silent
-- cross-tenant read. `equipments` gets none — it is a job-child, reachable
-- only via jobs, which does have a policy.
ALTER TABLE "equipment_type_refs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "equipment_type_refs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int);
```

- [ ] **Step 3b: Apply the finished migration**

Run: `pnpm exec prisma migrate dev`

With no pending edits and one unapplied migration on disk, this applies the whole file (table + columns + indexes + RLS) in one shot and records its checksum against the FINAL contents — so there is no later drift. Confirm with `pnpm exec prisma migrate status`: "Database schema is up to date!".

- [ ] **Step 4: Write the policy-coverage test**

This is the check that stops the next tenant-root table shipping unprotected. Create `src/lib/rls-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Every table carrying tenant_id must have RLS enabled AND a tenant_isolation
 * policy. db-guard.ts checks the connected ROLE; nothing checked policy
 * COVERAGE, so a new tenant-root table could ship with no isolation at all and
 * nothing would fail. equipment_type_refs was very nearly that table.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("tenant RLS coverage (DB)", () => {
  it("every table with a tenant_id column has RLS enabled and a tenant_isolation policy", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ table_name: string; rowsecurity: boolean; policy_count: bigint }>
    >`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rowsecurity,
             (SELECT count(*) FROM pg_policy p
               WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'tenant_id'
        )
      ORDER BY c.relname
    `;

    expect(rows.length).toBeGreaterThan(0);
    const unprotected = rows.filter((r) => !r.rowsecurity || Number(r.policy_count) === 0);
    expect(
      unprotected.map((r) => r.table_name),
      "tenant-root tables missing RLS or a tenant_isolation policy",
    ).toEqual([]);
  });

  it("includes equipment_type_refs in the protected set", async () => {
    const rows = await prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'equipment_type_refs'
    `;
    expect(rows[0]?.relrowsecurity).toBe(true);
  });
});
```

- [ ] **Step 5: Run it**

Run: `pnpm test:db`
Expected: PASS. If the first test lists tables, each one named is a genuine pre-existing gap — report them rather than weakening the assertion.

- [ ] **Step 6: Full check**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma src/lib/rls-coverage.test.ts src/generated
git commit -m "feat(schema): add EquipmentTypeRef with tenant RLS + policy coverage test"
```

---

### Task 3: New error codes and the spec field map

**Files:**
- Modify: `src/lib/shared/errors.ts`
- Create: `src/lib/shared/specs.ts`
- Create: `src/lib/shared/specs.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ERROR_CODES.TEMPLATE_VERSION_NOT_PUBLISHED`, `ERROR_CODES.DUPLICATE_JOB_NUMBER`; `SpecField`, `SPEC_FIELDS`, `specFieldsFor(familyCode: string): SpecField[]`, `validateSpecs(familyCode: string, specs: Record<string, unknown>): Record<string, string | number> `

- [ ] **Step 1: Append the error codes**

In `ERROR_CODES`:

```ts
  /** A job tried to pin a process route that is still a draft. */
  TEMPLATE_VERSION_NOT_PUBLISHED: "TEMPLATE_VERSION_NOT_PUBLISHED",
  /** createJob: this job number is already used in this tenant. */
  DUPLICATE_JOB_NUMBER: "DUPLICATE_JOB_NUMBER",
```

In `ERROR_MESSAGES`:

```ts
  TEMPLATE_VERSION_NOT_PUBLISHED:
    "That process route is still a draft and cannot be used for a job. Publish it first.",
  DUPLICATE_JOB_NUMBER: "A job with this number already exists.",
```

Note: if the route-authoring plan has already landed, `TEMPLATE_VERSION_LOCKED`, `TEMPLATE_INCOMPLETE` and `STALE_WRITE` are present too. Adding to this list never conflicts — the file's header says append, never rename.

- [ ] **Step 2: Write the failing spec-field tests**

Create `src/lib/shared/specs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { specFieldsFor, validateSpecs, SPEC_FIELDS } from "./specs";

describe("specFieldsFor", () => {
  it("returns the pressure-vessel field set", () => {
    const fields = specFieldsFor("PRESSURE_VESSEL");
    expect(fields.map((f) => f.key)).toContain("designPressure");
    expect(fields.find((f) => f.key === "designPressure")?.unit).toBe("kg/cm²");
  });

  it("returns an empty set for a family with no entry, rather than throwing", () => {
    // A family whose route exists but whose spec fields have not been defined
    // yet is a valid state — it stores specs: null, not an error.
    expect(specFieldsFor("PIPING_SYSTEM")).toEqual([]);
  });

  it("defines no duplicate keys within a family", () => {
    for (const [family, fields] of Object.entries(SPEC_FIELDS)) {
      const keys = fields.map((f) => f.key);
      expect(new Set(keys).size, `duplicate spec key in ${family}`).toBe(keys.length);
    }
  });

  it("gives every select field a non-empty options list", () => {
    for (const fields of Object.values(SPEC_FIELDS)) {
      for (const f of fields) {
        if (f.type === "select") expect(f.options?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("validateSpecs", () => {
  it("keeps only keys defined for the family", () => {
    const out = validateSpecs("PRESSURE_VESSEL", { designPressure: 10, sneaky: "x" });
    expect(out).toEqual({ designPressure: 10 });
  });

  it("coerces a numeric string for a number field", () => {
    expect(validateSpecs("PRESSURE_VESSEL", { designPressure: "10.5" })).toEqual({ designPressure: 10.5 });
  });

  it("drops a non-numeric value for a number field rather than storing junk", () => {
    expect(validateSpecs("PRESSURE_VESSEL", { designPressure: "abc" })).toEqual({});
  });

  it("drops a select value outside its options", () => {
    expect(validateSpecs("PRESSURE_VESSEL", { orientation: "Diagonal" })).toEqual({});
    expect(validateSpecs("PRESSURE_VESSEL", { orientation: "Vertical" })).toEqual({ orientation: "Vertical" });
  });

  it("returns an empty object for an unknown family", () => {
    expect(validateSpecs("NOT_A_FAMILY", { anything: 1 })).toEqual({});
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/shared/specs.test.ts`
Expected: FAIL — cannot resolve `./specs`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/shared/specs.ts`:

```ts
/**
 * Design configuration captured at job intake, per product family.
 *
 * A constant map, not an EAV table: the field set changes when a product
 * family is added, which is a code change anyway, and one jsonb column serves
 * every family instead of one migration each.
 *
 * These values are DISPLAY AND REFERENCE DATA. Nothing in lib/schedule/ or the
 * gating path may read them — the moment a computed date depends on a
 * free-shaped blob, the product's refusals stop being explainable
 * (invariant #12).
 */

export interface SpecField {
  key: string;
  label: string;
  type: "number" | "text" | "select";
  unit?: string;
  options?: string[];
}

/**
 * PRESSURE_VESSEL is the only entry defined today, because it is the only
 * family with a published route. Each further family's fields land alongside
 * its route — heat exchangers will want TEMA type, shell- and tube-side design
 * pressure and temperature, tube count, tube OD and pass count — not here,
 * ahead of the route that makes them orderable.
 */
export const SPEC_FIELDS: Record<string, SpecField[]> = {
  PRESSURE_VESSEL: [
    { key: "designPressure", label: "Design pressure", type: "number", unit: "kg/cm²" },
    { key: "designTemperature", label: "Design temperature", type: "number", unit: "°C" },
    { key: "mdmt", label: "MDMT", type: "number", unit: "°C" },
    { key: "moc", label: "Material of construction", type: "text" },
    { key: "capacity", label: "Capacity", type: "number", unit: "L" },
    { key: "orientation", label: "Orientation", type: "select", options: ["Vertical", "Horizontal"] },
    { key: "radiography", label: "Radiography", type: "select", options: ["Full", "Spot", "None"] },
  ],
};

/** Fields for a family code. An undefined family is a valid empty set, not an error. */
export function specFieldsFor(familyCode: string): SpecField[] {
  return SPEC_FIELDS[familyCode] ?? [];
}

/**
 * Keep only keys defined for the family, coerced to their declared type.
 * Anything unrecognised or uncoercible is DROPPED rather than stored: a jsonb
 * column will accept literally anything, so this is the only thing standing
 * between a typo in a form post and permanent junk in the record.
 */
export function validateSpecs(
  familyCode: string,
  specs: Record<string, unknown>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const field of specFieldsFor(familyCode)) {
    const raw = specs[field.key];
    if (raw == null || raw === "") continue;

    if (field.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (Number.isFinite(n)) out[field.key] = n;
      continue;
    }
    const s = String(raw).trim();
    if (s === "") continue;
    if (field.type === "select" && !(field.options ?? []).includes(s)) continue;
    out[field.key] = s;
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/lib/shared/specs.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/shared/errors.ts src/lib/shared/specs.ts src/lib/shared/specs.test.ts
git commit -m "feat(shared): add job-intake error codes and per-family spec field map"
```

---

### Task 4: Equipment-type CRUD and `createClient`

**Files:**
- Modify: `src/lib/shared/schemas.ts`
- Modify: `src/lib/services/admin.service.ts`
- Modify: `src/lib/services/admin.service.test.ts`

**Interfaces:**
- Consumes: `validateSpecs` (Task 3)
- Produces:
  - `createEquipmentType(actor, input): Promise<EquipmentTypeRef>`
  - `updateEquipmentType(actor, input): Promise<EquipmentTypeRef>`
  - `createClientRecord(actor, input): Promise<Client>`
  - schemas `createEquipmentTypeSchema`, `updateEquipmentTypeSchema`, `createClientSchema` and their inferred input types

- [ ] **Step 1: Add the schemas**

Append to `src/lib/shared/schemas.ts`:

```ts
// ── Job intake: equipment catalog and clients ───────────────────────────

export const createEquipmentTypeSchema = z
  .object({
    familyId: id,
    code: z.string().trim().toUpperCase().min(1, "A code is required"),
    name: z.string().trim().min(1, "A name is required"),
    defaultDesignCode: z.string().trim().min(1).nullable().default(null),
    /** Shape-checked against the family's SPEC_FIELDS in the service, not here. */
    defaultSpecs: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict();
export type CreateEquipmentTypeInput = z.infer<typeof createEquipmentTypeSchema>;

/** Deactivate rather than delete — Equipment rows reference these (invariant #6). */
export const updateEquipmentTypeSchema = z
  .object({
    id,
    name: z.string().trim().min(1).optional(),
    defaultDesignCode: z.string().trim().min(1).nullable().optional(),
    defaultSpecs: z.record(z.string(), z.unknown()).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type UpdateEquipmentTypeInput = z.infer<typeof updateEquipmentTypeSchema>;

/** Inline client creation from the intake wizard. Name + optional code only. */
export const createClientSchema = z
  .object({
    name: z.string().trim().min(1, "A client name is required"),
    code: z.string().trim().toUpperCase().min(1).nullable().default(null),
  })
  .strict();
export type CreateClientInput = z.infer<typeof createClientSchema>;
```

- [ ] **Step 2: Write the failing tests**

Append to the pure-refusals block of `src/lib/services/admin.service.test.ts`:

```ts
  it("createEquipmentType refuses a SUPERVISOR caller", async () => {
    await expect(
      createEquipmentType(actor({ roles: [ROLES.SUPERVISOR] }), {
        familyId: 1,
        code: "X",
        name: "X",
        defaultDesignCode: null,
        defaultSpecs: null,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createEquipmentType refuses a client user", async () => {
    await expect(
      createEquipmentType(actor({ clientId: 7, roles: [ROLES.CLIENT_VIEWER] }), {
        familyId: 1,
        code: "X",
        name: "X",
        defaultDesignCode: null,
        defaultSpecs: null,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createClientRecord refuses a QC caller", async () => {
    await expect(
      createClientRecord(actor({ roles: [ROLES.QC] }), { name: "Acme", code: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });
```

Add `createEquipmentType`, `createClientRecord` to the file's import from `./admin.service`.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/services/admin.service.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 4: Implement, following the `createDelayCategory` precedent at line 189**

Append to `src/lib/services/admin.service.ts` (add imports for the new schemas, `validateSpecs` from `@/lib/shared/specs`, and the `EquipmentTypeRef`/`Client` types):

```ts
/**
 * Equipment catalog CRUD. Mirrors createDelayCategory/updateDelayCategory
 * exactly — same role gate, same audited shape, same deactivate-never-delete
 * rule (invariant #6): Equipment rows reference these, so a delete would
 * orphan real job data.
 *
 * PRODUCTION_HEAD is allowed here alongside ADMIN, unlike the delay-category
 * pair: the catalog is production's own vocabulary, not a system setting.
 */
export async function createEquipmentType(
  actor: Actor,
  input: CreateEquipmentTypeInput,
): Promise<EquipmentTypeRef> {
  const { familyId, code, name, defaultDesignCode, defaultSpecs } =
    createEquipmentTypeSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const family = await tx.productFamily.findFirst({
      where: { id: familyId, tenantId: actor.tenantId },
    });
    if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId });

    const existing = await tx.equipmentTypeRef.findFirst({
      where: { tenantId: actor.tenantId, code },
    });
    if (existing) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { code },
        "An equipment type with this code already exists.",
      );
    }

    // Defaults are filtered through the family's own field map, so the catalog
    // cannot seed a job with a key no form will ever show.
    const specs = defaultSpecs ? validateSpecs(family.code, defaultSpecs) : null;

    return audited(tx, actor, async () => {
      const row = await tx.equipmentTypeRef.create({
        data: {
          tenantId: actor.tenantId,
          familyId,
          code,
          name,
          defaultDesignCode,
          defaultSpecs: specs === null ? undefined : (specs as never),
        },
      });
      return {
        result: row,
        audit: {
          action: "admin.createEquipmentType",
          entityType: "EquipmentTypeRef",
          entityId: row.id,
          after: { code, name, familyId, defaultDesignCode, defaultSpecs: specs },
          eventType: "EquipmentTypeCreated",
          eventPayload: { equipmentTypeId: row.id, code, familyId },
        },
      };
    });
  });
}

export async function updateEquipmentType(
  actor: Actor,
  input: UpdateEquipmentTypeInput,
): Promise<EquipmentTypeRef> {
  const parsed = updateEquipmentTypeSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const row = await tx.equipmentTypeRef.findFirst({
      where: { id: parsed.id, tenantId: actor.tenantId },
      include: { family: true },
    });
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "EquipmentTypeRef", id: parsed.id });

    const specs =
      parsed.defaultSpecs === undefined
        ? undefined
        : parsed.defaultSpecs === null
          ? null
          : validateSpecs(row.family.code, parsed.defaultSpecs);

    return audited(tx, actor, async () => {
      const updated = await tx.equipmentTypeRef.update({
        where: { id: parsed.id },
        data: {
          name: parsed.name,
          defaultDesignCode: parsed.defaultDesignCode,
          active: parsed.active,
          ...(specs === undefined ? {} : { defaultSpecs: specs as never }),
        },
      });
      return {
        result: updated,
        audit: {
          action: "admin.updateEquipmentType",
          entityType: "EquipmentTypeRef",
          entityId: updated.id,
          before: {
            name: row.name,
            defaultDesignCode: row.defaultDesignCode,
            active: row.active,
            defaultSpecs: row.defaultSpecs,
          },
          after: {
            name: updated.name,
            defaultDesignCode: updated.defaultDesignCode,
            active: updated.active,
            defaultSpecs: updated.defaultSpecs,
          },
          eventType: "EquipmentTypeUpdated",
          eventPayload: { equipmentTypeId: updated.id },
        },
      };
    });
  });
}

/**
 * Inline client creation from the intake wizard.
 *
 * Named createClientRecord, not createClient: this file already exports
 * createUser/createEmployee for *people*, and a bare `createClient` in a
 * codebase full of "client user" language reads as the wrong thing.
 */
export async function createClientRecord(actor: Actor, input: CreateClientInput): Promise<Client> {
  const { name, code } = createClientSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    if (code) {
      const existing = await tx.client.findFirst({ where: { tenantId: actor.tenantId, code } });
      if (existing) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          { code },
          "A client with this code already exists.",
        );
      }
    }
    return audited(tx, actor, async () => {
      const client = await tx.client.create({ data: { tenantId: actor.tenantId, name, code } });
      return {
        result: client,
        audit: {
          action: "admin.createClient",
          entityType: "Client",
          entityId: client.id,
          after: { name, code },
          eventType: "ClientCreated",
          eventPayload: { clientId: client.id, name },
        },
      };
    });
  });
}
```

- [ ] **Step 5: Run**

Run: `pnpm exec vitest run src/lib/services/admin.service.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/shared/schemas.ts src/lib/services/admin.service.ts src/lib/services/admin.service.test.ts
git commit -m "feat(admin): add equipment type CRUD and inline client creation"
```

---

### Task 5: `createJobSchema`

**Files:**
- Modify: `src/lib/shared/schemas.ts`

**Interfaces:**
- Consumes: the local `id` helper
- Produces: `createJobSchema`, `CreateJobInput`

- [ ] **Step 1: Append the schema**

```ts
/**
 * Job intake (docs/superpowers/specs/2026-08-22-job-intake-design.md §4.1).
 *
 * `.strict()` with NO actual_*/_at field (invariant #1). orderDate,
 * committedDeliveryDate and targetDispatchDate are PLANNING dates a planner
 * legitimately supplies — the same distinction schedule.service.ts already
 * draws for its own projectStartDate/requiredDeliveryDate inputs. Every
 * `actual_*` on this job will be written by process.service.ts from the DB
 * clock and nowhere else.
 */
export const createJobSchema = z
  .object({
    clientId: id,
    familyId: id,
    templateVersionId: id,
    calendarId: id.nullable().default(null),
    jobNumber: z.string().trim().min(1, "A job number is required"),
    clientOrderNo: z.string().trim().min(1).nullable().default(null),
    projectName: z.string().trim().min(1).nullable().default(null),
    poRef: z.string().trim().min(1).nullable().default(null),
    designCode: z.string().trim().min(1).nullable().default(null),
    orderDate: z.coerce.date().nullable().default(null),
    committedDeliveryDate: z.coerce.date().nullable().default(null),
    targetDispatchDate: z.coerce.date().nullable().default(null),
    // Matches enum JobPriority at schema.prisma:60 — URGENT, not CRITICAL.
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
    remarks: z.string().trim().min(1).nullable().default(null),
    /** Filtered through the family's SPEC_FIELDS in the service. */
    specs: z.record(z.string(), z.unknown()).nullable().default(null),
    /** TemplateProcess.code values this client skips, e.g. PWHT. */
    excludedProcessCodes: z.array(z.string().trim().min(1)).default([]),
    equipments: z
      .array(
        z
          .object({
            equipmentTypeId: id.nullable().default(null),
            name: z.string().trim().min(1, "Each equipment block needs a name"),
            blockNo: z.number().int().positive().nullable().default(null),
            remarks: z.string().trim().min(1).nullable().default(null),
            serials: z
              .array(z.string().trim().min(1))
              .min(1, "Each equipment block needs at least one serial number"),
          })
          .strict()
          .refine((b) => new Set(b.serials).size === b.serials.length, {
            message: "Serial numbers must be unique within an equipment block",
            path: ["serials"],
          }),
      )
      .min(1, "A job needs at least one equipment block"),
    /** Clone this QCP template's items onto the new job. */
    qcpTemplateSourceId: id.nullable().default(null),
    /** Copy this equipment's BOM lines into the first equipment block. */
    copyBomFromEquipmentId: id.nullable().default(null),
  })
  .strict()
  .refine(
    (v) =>
      v.targetDispatchDate == null ||
      v.committedDeliveryDate == null ||
      v.targetDispatchDate <= v.committedDeliveryDate,
    {
      message: "The target dispatch date cannot be later than the date committed to the client",
      path: ["targetDispatchDate"],
    },
  );
export type CreateJobInput = z.infer<typeof createJobSchema>;
```

`JobPriority` at `schema.prisma:60` is `LOW | NORMAL | HIGH | URGENT` — verified, and the enum above matches it. Humanise it in the UI ("Urgent"), never render the raw value.

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/shared/schemas.ts
git commit -m "feat(schemas): add createJobSchema"
```

---

### Task 6: `createJob` — the core transaction

The load-bearing task.

**Files:**
- Create: `src/lib/services/job-intake.service.ts`
- Create: `src/lib/services/job-intake.service.test.ts`

**Interfaces:**
- Consumes: `createJobSchema` (Task 5), `validateSpecs` (Task 3)
- Produces:
  - `interface CreateJobResult { jobId: number; publicId: string; processCount: number; edgeCount: number; unitCount: number; qcpItemCount: number; bomItemCount: number; unmatchedQcpProcessCodes: string[] }`
  - `createJob(actor: Actor, input: CreateJobInput): Promise<CreateJobResult>`

- [ ] **Step 1: Write the failing pure-refusal tests**

Create `src/lib/services/job-intake.service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES } from "@/lib/shared/errors";
import { createJob } from "./job-intake.service";
import type { CreateJobInput } from "@/lib/shared/schemas";

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "Admin",
    email: "admin@despl.test",
    roles: [ROLES.ADMIN],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
    ...over,
  };
}

function input(over: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    clientId: 1,
    familyId: 1,
    templateVersionId: 1,
    calendarId: null,
    jobNumber: "TEST-001",
    clientOrderNo: null,
    projectName: null,
    poRef: null,
    designCode: null,
    orderDate: null,
    committedDeliveryDate: null,
    targetDispatchDate: null,
    priority: "NORMAL",
    remarks: null,
    specs: null,
    excludedProcessCodes: [],
    equipments: [{ equipmentTypeId: null, name: "Vessel", blockNo: 1, remarks: null, serials: ["SR01"] }],
    qcpTemplateSourceId: null,
    copyBomFromEquipmentId: null,
    ...over,
  } as CreateJobInput;
}

describe("job-intake.service — pure refusals", () => {
  it.each([
    ["SUPERVISOR", ROLES.SUPERVISOR],
    ["QC", ROLES.QC],
    ["MANAGEMENT", ROLES.MANAGEMENT],
  ])("refuses a %s caller (RBAC deny-by-default)", async (_label, role) => {
    await expect(createJob(actor({ roles: [role] }), input())).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  it("refuses a client user before touching the DB", async () => {
    await expect(
      createJob(actor({ clientId: 5, roles: [ROLES.CLIENT_VIEWER] }), input()),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("refuses a target dispatch date later than the committed date", async () => {
    await expect(
      createJob(
        actor(),
        input({
          committedDeliveryDate: new Date("2026-10-01"),
          targetDispatchDate: new Date("2026-11-01"),
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses a job with no equipment block", async () => {
    await expect(createJob(actor(), input({ equipments: [] }))).rejects.toThrow();
  });

  it("refuses an equipment block with duplicate serials", async () => {
    await expect(
      createJob(
        actor(),
        input({
          equipments: [
            { equipmentTypeId: null, name: "V", blockNo: 1, remarks: null, serials: ["A", "A"] },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a smuggled actual_* field via the strict schema (invariant #1)", async () => {
    await expect(
      // @ts-expect-error — .strict() schema; no actual_* field exists on this input
      createJob(actor(), { ...input(), actualStart: new Date() }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/services/job-intake.service.test.ts`
Expected: FAIL — cannot resolve `./job-intake.service`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/services/job-intake.service.ts`:

```ts
import { randomUUID } from "node:crypto";
import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { ROLES, requireRole, assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { createJobSchema, type CreateJobInput } from "@/lib/shared/schemas";
import { validateSpecs } from "@/lib/shared/specs";

/**
 * Job intake (docs/superpowers/specs/2026-08-22-job-intake-design.md).
 *
 * Creating a job is not one insert. A usable job needs, atomically: the Job
 * row, its OWN copy of the pinned template's processes and edges, at least one
 * Equipment, its Unit serials, and an audit record. Get any of that wrong and
 * the job renders in the list, then breaks on every screen that reads the
 * spine.
 *
 * Scheduling is deliberately NOT part of this transaction — see the note on
 * the return type.
 */

export interface CreateJobResult {
  jobId: number;
  publicId: string;
  processCount: number;
  edgeCount: number;
  unitCount: number;
  qcpItemCount: number;
  bomItemCount: number;
  /**
   * QCP source items whose linked process code has no counterpart in the new
   * job's route. Reported, never silently dropped — the wizard lists them.
   */
  unmatchedQcpProcessCodes: string[];
}

export async function createJob(actor: Actor, input: CreateJobInput): Promise<CreateJobResult> {
  const parsed = createJobSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    // ── Validate everything before writing anything ──────────────────────
    const duplicate = await tx.job.findFirst({
      where: { tenantId: actor.tenantId, jobNumber: parsed.jobNumber },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppError(ERROR_CODES.DUPLICATE_JOB_NUMBER, {
        jobNumber: parsed.jobNumber,
        existingJobId: duplicate.id,
      });
    }

    const client = await tx.client.findFirst({
      where: { id: parsed.clientId, tenantId: actor.tenantId },
    });
    if (!client) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Client", clientId: parsed.clientId });

    const family = await tx.productFamily.findFirst({
      where: { id: parsed.familyId, tenantId: actor.tenantId },
    });
    if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId: parsed.familyId });

    const version = await tx.processTemplateVersion.findFirst({
      where: { id: parsed.templateVersionId, template: { tenantId: actor.tenantId } },
      include: { template: true, processes: true, edges: true },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        entity: "ProcessTemplateVersion",
        templateVersionId: parsed.templateVersionId,
      });
    }
    if (version.status !== "PUBLISHED") {
      // Filtering the dropdown is not enforcement.
      throw new AppError(ERROR_CODES.TEMPLATE_VERSION_NOT_PUBLISHED, {
        templateVersionId: version.id,
        status: version.status,
      });
    }
    if (version.template.familyId !== parsed.familyId) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { templateVersionId: version.id, familyId: parsed.familyId },
        "That process route belongs to a different type of equipment.",
      );
    }
    if (version.processes.length === 0) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { templateVersionId: version.id },
        "That process route has no processes.",
      );
    }

    if (parsed.calendarId != null) {
      const cal = await tx.workCalendar.findFirst({
        where: { id: parsed.calendarId, tenantId: actor.tenantId },
      });
      if (!cal) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "WorkCalendar", calendarId: parsed.calendarId });
    }

    const typeIds = parsed.equipments
      .map((e) => e.equipmentTypeId)
      .filter((x): x is number => x != null);
    if (typeIds.length > 0) {
      const types = await tx.equipmentTypeRef.findMany({
        where: { id: { in: typeIds }, tenantId: actor.tenantId },
      });
      if (types.length !== new Set(typeIds).size) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "EquipmentTypeRef", equipmentTypeIds: typeIds });
      }
      const wrongFamily = types.filter((t) => t.familyId !== parsed.familyId);
      if (wrongFamily.length > 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          { equipmentTypeCodes: wrongFamily.map((t) => t.code) },
          "An equipment type does not belong to this job's type of equipment.",
        );
      }
    }

    const templateCodes = new Set(version.processes.map((p) => p.code));
    const unknownExclusions = parsed.excludedProcessCodes.filter((c) => !templateCodes.has(c));
    if (unknownExclusions.length > 0) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        entity: "TemplateProcess",
        processCodes: unknownExclusions,
      });
    }

    const specs = parsed.specs ? validateSpecs(family.code, parsed.specs) : null;

    // ── Write ────────────────────────────────────────────────────────────
    return audited(tx, actor, async () => {
      const job = await tx.job.create({
        data: {
          tenantId: actor.tenantId,
          // Opaque id for client-facing URLs — sequential ids leak order volume.
          publicId: randomUUID(),
          clientId: parsed.clientId,
          familyId: parsed.familyId,
          templateVersionId: version.id,
          calendarId: parsed.calendarId,
          jobNumber: parsed.jobNumber,
          clientOrderNo: parsed.clientOrderNo,
          projectName: parsed.projectName,
          poRef: parsed.poRef,
          designCode: parsed.designCode,
          orderDate: parsed.orderDate,
          committedDeliveryDate: parsed.committedDeliveryDate,
          targetDispatchDate: parsed.targetDispatchDate,
          priority: parsed.priority,
          remarks: parsed.remarks,
          specs: specs === null ? undefined : (specs as never),
        },
      });

      const excluded = new Set(parsed.excludedProcessCodes);
      await tx.jobProcess.createMany({
        data: version.processes.map((tp) => ({
          jobId: job.id,
          templateProcessId: tp.id,
          seq: tp.seq,
          code: tp.code,
          name: tp.name,
          departmentId: tp.defaultDepartmentId,
          durationMinDays: tp.durationMinDays,
          durationMaxDays: tp.durationMaxDays,
          envelopeFinishByMinDays: tp.envelopeFinishByMinDays,
          envelopeFinishByMaxDays: tp.envelopeFinishByMaxDays,
          envelopeStartByMinDays: tp.envelopeStartByMinDays,
          envelopeStartByMaxDays: tp.envelopeStartByMaxDays,
          workOrderStages: tp.workOrderStages,
          provisional: tp.provisional,
          included: !excluded.has(tp.code),
        })),
      });

      const jobProcesses = await tx.jobProcess.findMany({
        where: { jobId: job.id },
        select: { id: true, code: true },
      });
      const jpIdByCode = new Map(jobProcesses.map((p) => [p.code, p.id]));
      const tpCodeById = new Map(version.processes.map((p) => [p.id, p.code]));

      // Edges are copied for ALL processes, including excluded ones.
      // lib/schedule/exclude.ts::bypassExcluded splices an excluded node out by
      // composing lag = lagPX + duration(X) + lagXS across it, so an excluded
      // process must keep both its edges and its durations. Dropping either
      // would treat it as taking zero days and drag every successor early —
      // that function's own comment calls this invariant #10 territory.
      await tx.jobProcessEdge.createMany({
        data: version.edges.map((e) => ({
          processId: jpIdByCode.get(tpCodeById.get(e.processId)!)!,
          predecessorId: jpIdByCode.get(tpCodeById.get(e.predecessorId)!)!,
          type: e.type,
          lagDays: e.lagDays,
        })),
      });

      let unitCount = 0;
      let firstEquipmentId: number | null = null;
      for (const block of parsed.equipments) {
        const equipment = await tx.equipment.create({
          data: {
            jobId: job.id,
            equipmentTypeId: block.equipmentTypeId,
            name: block.name,
            blockNo: block.blockNo,
            remarks: block.remarks,
          },
        });
        firstEquipmentId ??= equipment.id;
        await tx.unit.createMany({
          data: block.serials.map((serialNo) => ({ equipmentId: equipment.id, serialNo })),
        });
        unitCount += block.serials.length;
      }

      const qcp = parsed.qcpTemplateSourceId
        ? await cloneQcpTemplate(tx, parsed.qcpTemplateSourceId, job.id, jpIdByCode, actor.tenantId)
        : { itemCount: 0, unmatchedProcessCodes: [] as string[] };

      const bomItemCount =
        parsed.copyBomFromEquipmentId != null && firstEquipmentId != null
          ? await copyBom(tx, parsed.copyBomFromEquipmentId, firstEquipmentId, actor.tenantId)
          : 0;

      const result: CreateJobResult = {
        jobId: job.id,
        publicId: job.publicId,
        processCount: version.processes.length,
        edgeCount: version.edges.length,
        unitCount,
        qcpItemCount: qcp.itemCount,
        bomItemCount,
        unmatchedQcpProcessCodes: qcp.unmatchedProcessCodes,
      };

      return {
        result,
        audit: {
          action: "job.create",
          entityType: "Job",
          entityId: job.id,
          after: {
            jobNumber: job.jobNumber,
            clientId: job.clientId,
            familyId: job.familyId,
            templateVersionId: job.templateVersionId,
            committedDeliveryDate: job.committedDeliveryDate,
            targetDispatchDate: job.targetDispatchDate,
            processCount: result.processCount,
            equipmentCount: parsed.equipments.length,
            unitCount: result.unitCount,
            excludedProcessCodes: parsed.excludedProcessCodes,
          },
          eventType: "JobCreated",
          eventPayload: { jobId: job.id, jobNumber: job.jobNumber, familyId: job.familyId },
        },
      };
    });
  });
}
```

- [ ] **Step 4: Write the QCP clone and BOM copy helpers**

Append to the same file (add `import type { Tx } from "@/lib/db";`):

```ts
/**
 * Deep-copy a QCP template onto a new job: parties, items, party codes, and
 * the item→process links rebuilt by matching process CODE (not id).
 *
 * Code-matching is what makes this safe across template versions: if the
 * source QCP was built against a route where a process has since been
 * renumbered, the code still resolves. A code with no counterpart is
 * collected and returned, never silently dropped.
 *
 * QcpExecution rows are NOT copied — those are the source job's actual
 * inspection results.
 */
async function cloneQcpTemplate(
  tx: Tx,
  sourceId: number,
  jobId: number,
  jpIdByCode: Map<string, number>,
  tenantId: number,
): Promise<{ itemCount: number; unmatchedProcessCodes: string[] }> {
  const source = await tx.qcpTemplate.findFirst({
    // Anchored through job → tenant: qcp_templates is a job-child with no
    // tenant_id of its own, so a bare findUnique would happily return another
    // tenant's row (the ProcessPlan lesson in _shared.ts).
    where: {
      id: sourceId,
      OR: [{ job: { tenantId } }, { jobId: null }],
    },
    include: {
      parties: true,
      items: {
        include: {
          partyCodes: true,
          processLinks: { include: { jobProcess: { select: { code: true } } } },
        },
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!source) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "QcpTemplate", qcpTemplateId: sourceId });

  const copy = await tx.qcpTemplate.create({
    data: {
      jobId,
      jobLabel: source.jobLabel,
      vessel: source.vessel,
      revision: source.revision,
      designCode: source.designCode,
    },
  });

  const partyIdMap = new Map<number, number>();
  for (const p of source.parties) {
    const created = await tx.inspectionParty.create({
      data: { qcpTemplateId: copy.id, code: p.code, name: p.name },
    });
    partyIdMap.set(p.id, created.id);
  }

  const unmatched = new Set<string>();
  for (const item of source.items) {
    const created = await tx.qcpItem.create({
      data: {
        qcpTemplateId: copy.id,
        sequence: item.sequence,
        srNo: item.srNo,
        kind: item.kind,
        section: item.section,
        activity: item.activity,
        characteristic: item.characteristic,
        extentOfCheck: item.extentOfCheck,
        applicableDocument: item.applicableDocument,
        acceptanceCriteria: item.acceptanceCriteria,
        record: item.record,
        remarks: item.remarks,
      },
    });

    for (const pc of item.partyCodes) {
      const newPartyId = partyIdMap.get(pc.inspectionPartyId);
      if (newPartyId == null) continue;
      await tx.qcpItemPartyCode.create({
        data: {
          qcpItemId: created.id,
          inspectionPartyId: newPartyId,
          qcpCodeId: pc.qcpCodeId,
        },
      });
    }

    for (const link of item.processLinks) {
      const code = link.jobProcess.code;
      const newJobProcessId = jpIdByCode.get(code);
      if (newJobProcessId == null) {
        unmatched.add(code);
        continue;
      }
      await tx.qcpItemProcess.create({
        data: { qcpItemId: created.id, jobProcessId: newJobProcessId },
      });
    }
  }

  return { itemCount: source.items.length, unmatchedProcessCodes: [...unmatched] };
}

/**
 * Copy BOM lines from an existing equipment into a new one.
 *
 * Deliberately copies ONLY the BomItem rows. Procurement, MaterialIdentification,
 * Component and ItemTest are execution records belonging to the source job —
 * heat numbers, MTC references, PO numbers. Copying them would fabricate
 * traceability, which is the opposite of what this system exists for.
 */
async function copyBom(
  tx: Tx,
  sourceEquipmentId: number,
  targetEquipmentId: number,
  tenantId: number,
): Promise<number> {
  const source = await tx.equipment.findFirst({
    where: { id: sourceEquipmentId, job: { tenantId } },
    include: { bomItems: { orderBy: { itemNo: "asc" } } },
  });
  if (!source) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Equipment", equipmentId: sourceEquipmentId });
  }
  if (source.bomItems.length === 0) return 0;

  await tx.bomItem.createMany({
    data: source.bomItems.map((b) => ({
      equipmentId: targetEquipmentId,
      itemNo: b.itemNo,
      blockNo: b.blockNo,
      partName: b.partName,
      description: b.description,
      material: b.material,
      qty: b.qty,
      unit: b.unit,
      componentTypeId: b.componentTypeId,
      remarks: b.remarks,
    })),
  });
  return source.bomItems.length;
}
```

- [ ] **Step 5: Run the pure tests**

Run: `pnpm exec vitest run src/lib/services/job-intake.service.test.ts && pnpm typecheck`
Expected: PASS, 8 tests.

- [ ] **Step 6: Add the DB-backed tests**

Append to `job-intake.service.test.ts`:

```ts
import { prisma } from "@/lib/db";

describe.skipIf(!process.env.RUN_DB_TESTS)("job-intake.service — createJob (DB)", () => {
  const created: number[] = [];

  async function seedRefs() {
    const version = await prisma.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
      include: { template: true },
    });
    const client = await prisma.client.findFirstOrThrow({ where: { tenantId: 1 } });
    return { version, client, familyId: version.template.familyId };
  }

  function base(over: Partial<CreateJobInput>, refs: Awaited<ReturnType<typeof seedRefs>>): CreateJobInput {
    return input({
      clientId: refs.client.id,
      familyId: refs.familyId,
      templateVersionId: refs.version.id,
      ...over,
    });
  }

  afterAll(async () => {
    for (const id of created) {
      await prisma.job.delete({ where: { id } }).catch(() => {});
    }
  });

  it("materialises the full spine: every process and every edge", async () => {
    const refs = await seedRefs();
    const expectedProcesses = await prisma.templateProcess.count({ where: { versionId: refs.version.id } });
    const expectedEdges = await prisma.templateEdge.count({ where: { versionId: refs.version.id } });

    const r = await createJob(actor(), base({ jobNumber: "TEST-SPINE-1" }, refs));
    created.push(r.jobId);

    expect(r.processCount).toBe(expectedProcesses);
    expect(await prisma.jobProcess.count({ where: { jobId: r.jobId } })).toBe(expectedProcesses);
    expect(await prisma.jobProcessEdge.count({ where: { process: { jobId: r.jobId } } })).toBe(expectedEdges);

    // Every edge's endpoints belong to THIS job — the id-mapping bug this catches
    // would otherwise wire a new job's edges to another job's processes.
    const ownIds = new Set(
      (await prisma.jobProcess.findMany({ where: { jobId: r.jobId }, select: { id: true } })).map((p) => p.id),
    );
    const edges = await prisma.jobProcessEdge.findMany({ where: { process: { jobId: r.jobId } } });
    for (const e of edges) {
      expect(ownIds.has(e.processId)).toBe(true);
      expect(ownIds.has(e.predecessorId)).toBe(true);
    }
  });

  it("copies durations, envelope offsets and provisional verbatim rather than defaulting them", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-COPY-1" }, refs));
    created.push(r.jobId);

    const tps = await prisma.templateProcess.findMany({ where: { versionId: refs.version.id } });
    const jps = await prisma.jobProcess.findMany({ where: { jobId: r.jobId } });
    const jpByCode = new Map(jps.map((p) => [p.code, p]));
    for (const tp of tps) {
      const jp = jpByCode.get(tp.code)!;
      expect(jp.durationMinDays).toBe(tp.durationMinDays);
      expect(jp.durationMaxDays).toBe(tp.durationMaxDays);
      expect(jp.envelopeFinishByMaxDays).toBe(tp.envelopeFinishByMaxDays);
      expect(jp.provisional).toBe(tp.provisional);
      expect(jp.workOrderStages).toEqual(tp.workOrderStages);
    }
  });

  it("keeps excluded processes AND their edges, marked included: false", async () => {
    const refs = await seedRefs();
    const someCode = (await prisma.templateProcess.findFirstOrThrow({
      where: { versionId: refs.version.id, seq: 10 },
    })).code;

    const r = await createJob(actor(), base({ jobNumber: "TEST-EXCL-1", excludedProcessCodes: [someCode] }, refs));
    created.push(r.jobId);

    const excluded = await prisma.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: someCode } });
    expect(excluded.included).toBe(false);
    // Durations retained: bypassExcluded needs duration(X) to compose the bridge lag.
    expect(excluded.durationMaxDays).not.toBeNull();
    const stillWired = await prisma.jobProcessEdge.count({
      where: { OR: [{ processId: excluded.id }, { predecessorId: excluded.id }] },
    });
    expect(stillWired).toBeGreaterThan(0);
  });

  it("gives the job a uuid publicId, not something derivable from its id", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-PUB-1" }, refs));
    created.push(r.jobId);
    expect(r.publicId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(r.publicId).not.toContain(String(r.jobId));
  });

  it("refuses a duplicate job number", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-DUP-1" }, refs));
    created.push(r.jobId);
    await expect(createJob(actor(), base({ jobNumber: "TEST-DUP-1" }, refs))).rejects.toMatchObject({
      code: ERROR_CODES.DUPLICATE_JOB_NUMBER,
    });
  });

  it("refuses a DRAFT template version even though the dropdown would have hidden it", async () => {
    const refs = await seedRefs();
    const draft = await prisma.processTemplateVersion.findFirst({ where: { status: "DRAFT" } });
    if (!draft) return; // seed has a DRAFT pipe-spool version; skip if that changes
    await expect(
      createJob(actor(), base({ jobNumber: "TEST-DRAFT-1", templateVersionId: draft.id }, refs)),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_VERSION_NOT_PUBLISHED });
  });

  it("refuses a template version belonging to another product family", async () => {
    const refs = await seedRefs();
    const otherFamily = await prisma.productFamily.findFirstOrThrow({
      where: { tenantId: 1, id: { not: refs.familyId } },
    });
    await expect(
      createJob(actor(), base({ jobNumber: "TEST-FAM-1", familyId: otherFamily.id }, refs)),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
  });

  it("refuses a cross-tenant client with NOT_FOUND, not a leak", async () => {
    const refs = await seedRefs();
    await expect(
      createJob(actor({ tenantId: 999 }), base({ jobNumber: "TEST-TEN-1" }, refs)),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });

  it("writes exactly one audit row, in the same transaction", async () => {
    const refs = await seedRefs();
    const before = await prisma.auditLog.count({ where: { action: "job.create" } });
    const r = await createJob(actor(), base({ jobNumber: "TEST-AUDIT-1" }, refs));
    created.push(r.jobId);
    expect(await prisma.auditLog.count({ where: { action: "job.create" } })).toBe(before + 1);
  });

  it("rolls back everything when the transaction fails part-way", async () => {
    const refs = await seedRefs();
    const auditBefore = await prisma.auditLog.count({ where: { action: "job.create" } });
    // A serial longer than any sane column forces a failure AFTER the job and
    // its processes are written, proving the rollback covers all of it.
    await expect(
      createJob(
        actor(),
        base(
          {
            jobNumber: "TEST-ROLLBACK-1",
            copyBomFromEquipmentId: 2_000_000_000, // no such equipment → NOT_FOUND late in the tx
          },
          refs,
        ),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    expect(await prisma.job.count({ where: { jobNumber: "TEST-ROLLBACK-1" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "job.create" } })).toBe(auditBefore);
  });

  it("clones a QCP template's items and rebuilds process links by code", async () => {
    const refs = await seedRefs();
    const sourceQcp = await prisma.qcpTemplate.findFirstOrThrow({
      where: { items: { some: { processLinks: { some: {} } } } },
      include: { _count: { select: { items: true, parties: true } } },
    });

    const r = await createJob(actor(), base({ jobNumber: "TEST-QCP-1", qcpTemplateSourceId: sourceQcp.id }, refs));
    created.push(r.jobId);

    const copy = await prisma.qcpTemplate.findFirstOrThrow({
      where: { jobId: r.jobId },
      include: { _count: { select: { items: true, parties: true } } },
    });
    expect(copy._count.items).toBe(sourceQcp._count.items);
    expect(copy._count.parties).toBe(sourceQcp._count.parties);

    // Links resolve against the NEW job's processes.
    const links = await prisma.qcpItemProcess.findMany({
      where: { qcpItem: { qcpTemplateId: copy.id } },
      include: { jobProcess: { select: { jobId: true } } },
    });
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.jobProcess.jobId).toBe(r.jobId);

    // No execution results carried over.
    expect(
      await prisma.qcpExecution.count({ where: { qcpItem: { qcpTemplateId: copy.id } } }),
    ).toBe(0);
  });

  it("copies BOM lines but no procurement or traceability records", async () => {
    const refs = await seedRefs();
    const sourceEquipment = await prisma.equipment.findFirstOrThrow({
      where: { bomItems: { some: {} } },
      include: { _count: { select: { bomItems: true } } },
    });

    const r = await createJob(
      actor(),
      base({ jobNumber: "TEST-BOM-1", copyBomFromEquipmentId: sourceEquipment.id }, refs),
    );
    created.push(r.jobId);

    expect(r.bomItemCount).toBe(sourceEquipment._count.bomItems);
    const newEquipment = await prisma.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
    expect(await prisma.bomItem.count({ where: { equipmentId: newEquipment.id } })).toBe(
      sourceEquipment._count.bomItems,
    );
    expect(
      await prisma.procurement.count({ where: { bomItem: { equipmentId: newEquipment.id } } }),
    ).toBe(0);
    expect(
      await prisma.materialIdentification.count({ where: { bomItem: { equipmentId: newEquipment.id } } }),
    ).toBe(0);
  });

  it("stores only spec keys defined for the family", async () => {
    const refs = await seedRefs();
    const r = await createJob(
      actor(),
      base({ jobNumber: "TEST-SPECS-1", specs: { designPressure: "10.5", bogus: "x" } }, refs),
    );
    created.push(r.jobId);
    const job = await prisma.job.findUniqueOrThrow({ where: { id: r.jobId } });
    expect(job.specs).toEqual({ designPressure: 10.5 });
  });
});
```

Add `afterAll` to the vitest import.

- [ ] **Step 7: Run the DB tests**

Run: `pnpm test:db`
Expected: PASS. The rollback test is the important one — it must assert **zero rows**, not merely that an error was thrown.

- [ ] **Step 8: Commit**

```bash
git add src/lib/services/job-intake.service.ts src/lib/services/job-intake.service.test.ts
git commit -m "feat(services): add createJob with spine materialisation, QCP clone and BOM copy"
```

---

### Task 7: Client-portal leak test for `targetDispatchDate`

Separate from Task 1 because it *adds* an assertion rather than renaming one, and because it is the guard that keeps every future `Job` column out of the portal.

**Files:**
- Modify: `src/lib/services/client-snapshot.read.test.ts`

**Interfaces:**
- Consumes: `loadClientPortalView` from `client-snapshot.read.ts`
- Produces: no new exports — a test only

- [ ] **Step 1: Read the existing test file**

Read `src/lib/services/client-snapshot.read.test.ts` in full, in particular how its DB-gated block obtains a client actor and which job it uses. Reuse that setup; do not build a second one.

- [ ] **Step 2: Add the key-set assertion**

Inside the existing `describe.skipIf(!RUN_DB)` block:

```ts
  it("never exposes a Job column outside ClientJobView's documented key set", async () => {
    // The portal's protection is the RETURN TYPE, not the query:
    // client-snapshot.read.ts:103 calls tx.job.findMany with no `select`, so it
    // loads every column of Job — including targetDispatchDate, which is
    // DESPL's internal buffer and must never reach a client. Nothing asserted
    // that until now. A key-set comparison (not a spot check) means any future
    // column accidentally spread into the view fails here instead of shipping.
    const allowed = new Set([
      "jobId",
      "jobNumber",
      "equipmentName",
      "hasUpdate",
      "asOf",
      "overallPct",
      "forecastDispatch",
      "units",
      "unitsUnderInspection",
    ]);

    const views = await loadClientPortalView(clientActor);
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      const unexpected = Object.keys(v).filter((k) => !allowed.has(k));
      expect(unexpected, `unexpected keys on ClientJobView for job ${v.jobNumber}`).toEqual([]);
    }
  });

  it("sources forecastDispatch from the committed date, never the internal target", async () => {
    const job = await prisma.job.findFirstOrThrow({ where: { tenantId: 1, committedDeliveryDate: { not: null } } });
    await prisma.job.update({
      where: { id: job.id },
      data: { targetDispatchDate: new Date("2001-01-01T00:00:00.000Z") },
    });

    const views = await loadClientPortalView(clientActor);
    const view = views.find((v) => v.jobNumber === job.jobNumber);
    if (view && "forecastDispatch" in view && view.forecastDispatch) {
      expect(view.forecastDispatch).not.toContain("2001-01-01");
      expect(view.forecastDispatch).toBe(job.committedDeliveryDate!.toISOString());
    }

    await prisma.job.update({ where: { id: job.id }, data: { targetDispatchDate: null } });
  });
```

Adapt `clientActor` to whatever the existing block already builds.

- [ ] **Step 3: Run**

Run: `pnpm test:db`
Expected: PASS. A failure on the first test names the leaking key — fix `client-snapshot.read.ts`, never the allow-list.

- [ ] **Step 4: Commit**

```bash
git add src/lib/services/client-snapshot.read.test.ts
git commit -m "test(portal): assert ClientJobView key set and committed-date sourcing"
```

---

### Task 8: Read layer — `job-intake.read.ts`

**Files:**
- Create: `src/lib/services/job-intake.read.ts`

**Interfaces:**
- Consumes: `Actor`, `specFieldsFor` (Task 3)
- Produces:
  - `interface IntakeFamily { id: number; code: string; name: string; schedulable: boolean; versions: Array<{ id: number; templateName: string; version: number; processCount: number; provisionalCount: number; notes: string | null }> }`
  - `interface IntakeOptions { clients: Array<{ id: number; name: string; code: string | null }>; families: IntakeFamily[]; calendars: Array<{ id: number; name: string; isDefault: boolean }>; equipmentTypes: Array<{ id: number; familyId: number; code: string; name: string; defaultDesignCode: string | null; defaultSpecs: Record<string, unknown> | null }>; qcpTemplates: Array<{ id: number; label: string; vessel: string; revision: number; itemCount: number }>; bomSources: Array<{ equipmentId: number; label: string; itemCount: number }> }`
  - `loadIntakeOptions(actor: Actor): Promise<IntakeOptions>`
  - `loadTemplateProcesses(actor: Actor, versionId: number): Promise<Array<{ code: string; seq: number; name: string; departmentName: string; optional: boolean; provisional: boolean; durationMaxDays: number | null }>>`

- [ ] **Step 1: Write the module**

Create `src/lib/services/job-intake.read.ts`:

```ts
import { withTenant } from "@/lib/db";
import { assertNotClientUser, ROLES, requireRole, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * Everything the intake wizard's dropdowns need, in one round trip.
 *
 * `schedulable` on a family is the honest signal the wizard renders: a family
 * with no PUBLISHED template version cannot take a job at all, and the UI must
 * say so and offer the fix rather than showing a dead option.
 */

export interface IntakeFamily {
  id: number;
  code: string;
  name: string;
  /** At least one PUBLISHED template version exists. */
  schedulable: boolean;
  versions: Array<{
    id: number;
    templateName: string;
    version: number;
    processCount: number;
    /** Processes with no confirmed duration — this route will not produce dates. */
    provisionalCount: number;
    notes: string | null;
  }>;
}

export interface IntakeOptions {
  clients: Array<{ id: number; name: string; code: string | null }>;
  families: IntakeFamily[];
  calendars: Array<{ id: number; name: string; isDefault: boolean }>;
  equipmentTypes: Array<{
    id: number;
    familyId: number;
    code: string;
    name: string;
    defaultDesignCode: string | null;
    defaultSpecs: Record<string, unknown> | null;
  }>;
  qcpTemplates: Array<{ id: number; label: string; vessel: string; revision: number; itemCount: number }>;
  bomSources: Array<{ equipmentId: number; label: string; itemCount: number }>;
}

export async function loadIntakeOptions(actor: Actor): Promise<IntakeOptions> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const [clients, families, calendars, equipmentTypes, qcpTemplates, equipments] = await Promise.all([
      tx.client.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, code: true },
      }),
      tx.productFamily.findMany({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { name: "asc" },
        include: {
          templates: {
            include: {
              versions: {
                where: { status: "PUBLISHED" },
                orderBy: { version: "desc" },
                include: { processes: { select: { provisional: true, durationMinDays: true, durationMaxDays: true } } },
              },
            },
          },
        },
      }),
      tx.workCalendar.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        select: { id: true, name: true, isDefault: true },
      }),
      tx.equipmentTypeRef.findMany({
        where: { tenantId: actor.tenantId, active: true },
        orderBy: { name: "asc" },
        select: {
          id: true,
          familyId: true,
          code: true,
          name: true,
          defaultDesignCode: true,
          defaultSpecs: true,
        },
      }),
      tx.qcpTemplate.findMany({
        where: { OR: [{ job: { tenantId: actor.tenantId } }, { jobId: null }] },
        orderBy: { jobLabel: "asc" },
        include: { _count: { select: { items: true } } },
      }),
      tx.equipment.findMany({
        where: { job: { tenantId: actor.tenantId }, bomItems: { some: {} } },
        include: { job: { select: { jobNumber: true } }, _count: { select: { bomItems: true } } },
        orderBy: { id: "asc" },
      }),
    ]);

    return {
      clients,
      families: families.map((f) => {
        const versions = f.templates.flatMap((t) =>
          t.versions.map((v) => ({
            id: v.id,
            templateName: t.name,
            version: v.version,
            processCount: v.processes.length,
            provisionalCount: v.processes.filter(
              (p) => p.provisional || p.durationMinDays == null || p.durationMaxDays == null,
            ).length,
            notes: v.notes,
          })),
        );
        return {
          id: f.id,
          code: f.code,
          name: f.name,
          schedulable: versions.length > 0,
          versions,
        };
      }),
      calendars,
      equipmentTypes: equipmentTypes.map((e) => ({
        ...e,
        defaultSpecs: (e.defaultSpecs as Record<string, unknown> | null) ?? null,
      })),
      qcpTemplates: qcpTemplates.map((q) => ({
        id: q.id,
        label: q.jobLabel,
        vessel: q.vessel,
        revision: q.revision,
        itemCount: q._count.items,
      })),
      bomSources: equipments.map((e) => ({
        equipmentId: e.id,
        label: `${e.job.jobNumber} — ${e.name}`,
        itemCount: e._count.bomItems,
      })),
    };
  });
}

/** The process list for step 2's include/exclude checkboxes. */
export async function loadTemplateProcesses(
  actor: Actor,
  versionId: number,
): Promise<
  Array<{
    code: string;
    seq: number;
    name: string;
    departmentName: string;
    optional: boolean;
    provisional: boolean;
    durationMaxDays: number | null;
  }>
> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const version = await tx.processTemplateVersion.findFirst({
      where: { id: versionId, template: { tenantId: actor.tenantId } },
      select: { id: true },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", versionId });
    }
    const processes = await tx.templateProcess.findMany({
      where: { versionId },
      orderBy: { seq: "asc" },
      include: { defaultDepartment: { select: { name: true } } },
    });
    return processes.map((p) => ({
      code: p.code,
      seq: p.seq,
      name: p.name,
      departmentName: p.defaultDepartment.name,
      optional: p.optional,
      provisional: p.provisional,
      durationMaxDays: p.durationMaxDays,
    }));
  });
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/services/job-intake.read.ts
git commit -m "feat(services): add job-intake read layer"
```

---

### Task 9: Server actions

**Files:**
- Create: `src/app/actions/job-intake.ts`

**Interfaces:**
- Consumes: `createJob` (Task 6), `createEquipmentType`/`createClientRecord` (Task 4), `generateSchedule` from `schedule.service.ts`
- Produces: `createJobAction`, `createClientAction`, `createEquipmentTypeAction`, `scheduleNewJobAction`

- [ ] **Step 1: Write the actions**

Create `src/app/actions/job-intake.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { createJob, type CreateJobResult } from "@/lib/services/job-intake.service";
import { createClientRecord, createEquipmentType } from "@/lib/services/admin.service";
import { generateSchedule } from "@/lib/services/schedule.service";
import { isAppError } from "@/lib/shared/errors";
import { toActionError, type ActionResult } from "./_action";
import type {
  CreateJobInput,
  CreateClientInput,
  CreateEquipmentTypeInput,
} from "@/lib/shared/schemas";

export type CreateJobActionResult = ActionResult & {
  job?: CreateJobResult;
  detail?: Record<string, unknown>;
};

export async function createJobAction(input: CreateJobInput): Promise<CreateJobActionResult> {
  try {
    const job = await createJob(await requireActor(), input);
    revalidatePath("/jobs");
    return { ok: true, job };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && isAppError(e)) return { ...result, detail: e.detail };
    return result;
  }
}

export type ScheduleVerdict =
  | { kind: "FEASIBLE" | "INFEASIBLE"; shortfallDays: number | null; planCount: number }
  | { kind: "DATA_MISSING"; message: string }
  | { kind: "FAILED"; message: string };

/**
 * Schedule a freshly created job. A SEPARATE call from createJobAction on
 * purpose: computeEnvelope refuses a provisional or duration-less spine with
 * SCHEDULE_DATA_MISSING, and that refusal must not roll back a perfectly good
 * job. A job on a provisional route is legitimate — it tracks the order, gates
 * its processes and drives the Stage Spine; it simply has no dates yet.
 */
export async function scheduleNewJobAction(
  jobId: number,
  requiredDeliveryDate?: Date,
): Promise<ScheduleVerdict> {
  try {
    const run = await generateSchedule(await requireActor(), {
      jobId,
      mode: "BACKWARD",
      ...(requiredDeliveryDate ? { requiredDeliveryDate } : {}),
    });
    revalidatePath(`/jobs/${jobId}`);
    return {
      kind: run.feasibility === "INFEASIBLE" ? "INFEASIBLE" : "FEASIBLE",
      shortfallDays: run.shortfallDays,
      planCount: run.processPlans.length,
    };
  } catch (e) {
    if (isAppError(e)) {
      if (e.code === "SCHEDULE_DATA_MISSING") {
        return {
          kind: "DATA_MISSING",
          message:
            "The job was created, but dates cannot be computed yet — this process route has " +
            "processes with no confirmed duration.",
        };
      }
      return { kind: "FAILED", message: e.message };
    }
    throw e;
  }
}

export type CreateClientActionResult = ActionResult & { clientId?: number; name?: string };

export async function createClientAction(input: CreateClientInput): Promise<CreateClientActionResult> {
  try {
    const client = await createClientRecord(await requireActor(), input);
    return { ok: true, clientId: client.id, name: client.name };
  } catch (e) {
    return toActionError(e);
  }
}

export type CreateEquipmentTypeActionResult = ActionResult & { equipmentTypeId?: number };

export async function createEquipmentTypeAction(
  input: CreateEquipmentTypeInput,
): Promise<CreateEquipmentTypeActionResult> {
  try {
    const row = await createEquipmentType(await requireActor(), input);
    revalidatePath("/admin/equipment-types");
    return { ok: true, equipmentTypeId: row.id };
  } catch (e) {
    return toActionError(e);
  }
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. Confirm `generateSchedule`'s return type really exposes `feasibility`, `shortfallDays` and `processPlans` (it returns `ScheduleRunWithPlans` from `_shared.ts`); adjust if not.

- [ ] **Step 3: Commit**

```bash
git add src/app/actions/job-intake.ts
git commit -m "feat(actions): add job intake server actions"
```

---

### Task 10: The wizard — `/jobs/new`

**Files:**
- Create: `src/app/(app)/jobs/new/page.tsx`
- Create: `src/app/(app)/jobs/new/_client.tsx`
- Modify: `src/app/(app)/jobs/page.tsx` (the "New job" button)

**Interfaces:**
- Consumes: `loadIntakeOptions` / `loadTemplateProcesses` (Task 8), all four actions (Task 9), `specFieldsFor` (Task 3)
- Produces: the route `/jobs/new`

- [ ] **Step 1: Read the existing screens for conventions**

Read `src/app/(app)/jobs/page.tsx` and `src/app/(app)/jobs/[id]/_client.tsx` in full first. Match their `page-h` header pattern, card/table markup, and `fmtDate` helper. Do not invent a second layout idiom.

- [ ] **Step 2: Write the server component**

```tsx
import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadIntakeOptions } from "@/lib/services/job-intake.read";
import { NewJobWizard } from "./_client";

export default async function NewJobPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/jobs");

  const options = await loadIntakeOptions(actor);
  return <NewJobWizard options={options} />;
}
```

- [ ] **Step 3: Write the wizard client component**

Create `src/app/(app)/jobs/new/_client.tsx`. Five steps with a step indicator. **Wizard state lives in the URL query string** via `useSearchParams` + `router.replace` — never `localStorage` (banned) — so refresh and back-button survive.

**Step 1 — Order.** Client (searchable select + "Add client" inline dialog calling `createClientAction`) · job number · client order no · PO ref · project name · order date · committed delivery date · target dispatch date · priority · work calendar. Native `<input type="date">`. The two date fields sit adjacent with help text: committed = "The date promised to the client. Lateness is measured against this." target = "DESPL's internal aim, usually earlier." Client-side check that target ≤ committed, with the server re-checking.

**Step 2 — Type and route.** Family cards. A family with `schedulable: false` renders **disabled** with "No process route defined yet" plus, for these roles, a link to `/admin/templates`. Then the version select (default: highest version), showing process count and, when `provisionalCount > 0`, an amber note: "N processes have no confirmed duration — this job will not produce dates yet." Then the process list from `loadTemplateProcesses` with include/exclude checkboxes defaulting to each process's `optional` flag; excluded rows strike through. Then an optional QCP template select showing vessel and item count.

**Step 3 — Equipment and serials.** Repeatable equipment blocks. Each: equipment type select (filtered to the chosen family; selecting one prefills block name, design code and step-4 specs) · block name · block number · quantity · serial scheme (prefix · start · pad width). Serials preview live as `320SR01 … 320SR09` and each is individually editable after generation.

**Step 4 — Material and configuration.** Design code plus the fields from `specFieldsFor(family.code)`, prefilled from the chosen equipment type's `defaultSpecs`. A family with no field set shows one line: "No design fields are defined for this equipment type yet." — not an error. Plus an optional "Copy BOM from" select over `options.bomSources`.

**Step 5 — Review and create.** Read-only summary of everything. Explicit statements of what will *not* exist, in plain words:
- when no QCP chosen: "No QCP attached — no hold points will block completion until one is added."
- when `provisionalCount > 0`: "N processes are provisional — dates cannot be computed for this job yet."

**Create** calls `createJobAction`, then `scheduleNewJobAction`, then renders the verdict inline before navigating to `/jobs/[id]`:
- `FEASIBLE` → `--s-complete`, with the plan count
- `INFEASIBLE` → `--s-overdue`, with shortfall days and "The schedule was still saved, so the gap is visible on the job page."
- `DATA_MISSING` → `--s-hold`, with the message from the action

If `createJobAction` fails, stay on step 5 and render `message` plus `detail` (e.g. the duplicate job number). Never lose the user's input on a failed submit.

- [ ] **Step 4: Add the "New job" button**

In `src/app/(app)/jobs/page.tsx`, add a button in the `page-h` header linking to `/jobs/new`, rendered only when `hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)`. Also update the existing empty state ("No jobs yet.") to offer the action.

- [ ] **Step 5: Verify in the running app**

Run: `pnpm dev`. Log in through the real `/login` form as an admin — **never** hand-build a session or read `AUTH_SECRET`. If browser automation is unavailable, say so and report this step incomplete.

Walk the whole flow:
1. Create a job with 3 serials on the pressure-vessel route. Confirm it appears in `/jobs`, its Stage Spine renders, the job detail page loads, and the department workspaces show its plans.
2. Set a committed date two weeks out → confirm `INFEASIBLE` with a shortfall count.
3. Set a committed date a year out → confirm `FEASIBLE`.
4. Try a duplicate job number → clean error, input preserved.
5. Set target dispatch after committed → blocked client-side.
6. Confirm the non-schedulable families are disabled and explain themselves.
7. Refresh mid-wizard → state survives (URL-driven).
8. Clone a QCP template in → confirm hold points appear on the new job's QCP grid.

- [ ] **Step 6: Confirm the hard bans**

State explicitly which you verified: no browser-default serif · no raw enums in the UI · status never plain text · no dead controls · no mock data in components · no `localStorage` · visible keyboard focus · reduced-motion respected · loading skeleton · empty state · error state.

- [ ] **Step 7: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db && pnpm build`
Expected: all PASS. Paste the actual output — do not claim completion without it.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/jobs"
git commit -m "feat(jobs): add new job intake wizard"
```

---

### Task 11: `/admin/equipment-types` and session wrap-up

**Files:**
- Create: `src/app/(app)/admin/equipment-types/page.tsx`
- Create: `src/app/(app)/admin/equipment-types/_client.tsx`
- Modify: `src/app/(app)/admin/page.tsx` (nav link)
- Modify: `progress.md`

**Interfaces:**
- Consumes: `createEquipmentTypeAction` (Task 9), `updateEquipmentType` (Task 4, needs an action wrapper if not already present)
- Produces: the route `/admin/equipment-types`

- [ ] **Step 1: Add the update action**

If Task 9 did not include it, add `updateEquipmentTypeAction` to `src/app/actions/job-intake.ts`, mirroring `createEquipmentTypeAction`.

- [ ] **Step 2: Write the screen**

Server component gated to ADMIN + PRODUCTION_HEAD, redirecting a client user to `/portal`. Client component: a table grouped by product family, columns Code (mono) · Name · Default design code · Default specs (summarised as "3 fields" rather than raw JSON) · Active · Actions. Add and Edit dialogs; the specs editor renders `specFieldsFor(family.code)` so the catalog cannot hold a key no form will ever show. Deactivate rather than delete, with the reason in the confirm copy: "Deactivating keeps existing jobs intact. Equipment already using this type is unaffected."

Empty state: "No equipment types yet. Add one to speed up creating jobs."

- [ ] **Step 3: Add the nav link**

"Equipment types" in the admin nav, ADMIN + PRODUCTION_HEAD only.

- [ ] **Step 4: Verify in the running app**

Through the real `/login` form: add an equipment type, confirm it appears in the wizard's step 3 filtered to its family, confirm selecting it prefills the design code and spec fields, deactivate it, confirm it disappears from the wizard but the job created with it still renders.

- [ ] **Step 5: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db && pnpm build`
Expected: all PASS. Paste the output.

- [ ] **Step 6: Update progress and sync the vault**

Update `progress.md`: what shipped, decisions made, blockers, next steps. Note explicitly that `Job.deliveryDate` was renamed and why, since that is the change most likely to surprise someone reading later.

Then update the vault at `/Users/sonusingh/SWAYAM OS/4_Projects/Client Work/DESPL/DESPL TRACKER/` — `CURRENT_STATUS.md`, `TASKS.md`, `CHANGELOG.md` — and run `python3 "/Users/sonusingh/SWAYAM OS/7_Systems/Automation/link_vault.py"` only if doc files were added or renamed.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/admin" src/app/actions/job-intake.ts progress.md
git commit -m "feat(admin): add equipment types catalog screen"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3.1 `EquipmentTypeRef`, `Equipment.equipmentTypeId` | 2 |
| §3.1 RLS policy + coverage test | 2 |
| §3.2 date rename, `targetDispatchDate`, `specs` | 1 |
| §3.2 client-visibility assertion | 7 |
| §4.1 `createJob` validation table | 6 |
| §4.1 spine materialisation, edges for excluded processes | 6 |
| §4.2 QCP clone by process code, unmatched reported | 6 |
| §4.3 BOM copy without execution records | 6 |
| §4.4 scheduling after the transaction, verdict surfaced | 9, 10 |
| §4.5 equipment type CRUD | 4, 11 |
| §4.6 `createClient` | 4 |
| §4.7 new error codes | 3 |
| §5.1–5.5 wizard steps | 10 |
| §5.4 `SPEC_FIELDS` constant map | 3 |
| §6 file layout | all |
| §7 test list | 6 (bulk), 7 (portal), 2 (RLS), 4 (RBAC) |
| §8 sequencing | task order |

**Placeholder scan:** no "TBD", no "add appropriate error handling", no "similar to Task N". Tasks 10 and 11 specify UI as an explicit requirements checklist rather than full JSX, because the components must match the existing `jobs/page.tsx` and `admin/_client.tsx` markup, which the implementer is told to read first.

**Type consistency checked:**
- `committedDeliveryDate` is the name everywhere after Task 1 — Prisma field, read models (`jobs.read.ts`, `job-detail.read.ts`, `job-health.ts`, `workspace.read.ts`), test fixtures and JSX. No file keeps the old name.
- `validateSpecs(familyCode, specs)` — Task 3's signature matches all three call sites: `createJob` (Task 6), `createEquipmentType` and `updateEquipmentType` (Task 4).
- `CreateJobResult` fields (`jobId`, `publicId`, `processCount`, `edgeCount`, `unitCount`, `qcpItemCount`, `bomItemCount`, `unmatchedQcpProcessCodes`) are exactly what Task 9's action returns and Task 10's step 5 consumes.
- `AppError`'s context field is `detail`, singular, everywhere.
- `ScheduleVerdict`'s three kinds (`FEASIBLE`/`INFEASIBLE`, `DATA_MISSING`, `FAILED`) map one-to-one onto the three inline states Task 10 renders.
- `createClientRecord`, not `createClient` — deliberately distinct from this codebase's `createUser`/`createEmployee` people-creating functions, and the name is used consistently in Tasks 4, 9 and 10.
- `IntakeFamily.schedulable` drives Task 10's disabled-family rendering; `provisionalCount` drives both the step-2 warning and the step-5 statement.

**One deviation from the spec, flagged:** the spec's §6 file list names `src/app/actions/job-intake.ts` for intake actions only, but this plan also puts `createEquipmentTypeAction` / `updateEquipmentTypeAction` there rather than in `actions/admin.ts`. The services live in `admin.service.ts` per the spec; only the action wrappers moved, so the equipment-catalog UI has one import. Move them to `actions/admin.ts` instead if that reads better during implementation — it changes nothing else.
