# Process Route Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Admin or Production Head clone, edit and publish a process route (`ProcessTemplateVersion`) for a product family from inside the app, so families other than `PRESSURE_VESSEL` can have a usable route without a developer editing a seed file.

**Architecture:** Copy-on-write versioning, reusing the loop that already exists in `admin.service.ts::updateStandardDurations` (extracted to a shared helper in Task 3). A new pure module `lib/schedule/validate.ts` computes graph diagnostics that publish-time validation turns into named, explainable refusals. `PUBLISHED` versions are immutable; edits happen on a `DRAFT` and are saved by full replace under an optimistic lock.

**Tech Stack:** TypeScript strict, Next.js 15 App Router, Prisma 6 + PostgreSQL 16, zod, vitest, React Server Components + client components for the editor.

**Spec:** `docs/superpowers/specs/2026-08-22-route-authoring-design.md`

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include these.

- **No client timestamps.** `publishedAt` is set from `new Date()` server-side. No request DTO may contain an `actual_*` or `*_at` field. All zod schemas are `.strict()`.
- **Templates are versioned (invariant #9).** Editing a `PUBLISHED` version is refused at the service layer, not just hidden in the UI. Edits create a new version. Running jobs keep their pinned version.
- **Append-only audit (invariant #5).** Every mutation goes through `audited()` from `@/lib/audit`, writing its `audit_log` row in the same transaction. Never call `tx.auditLog.create` directly from a service.
- **RBAC deny-by-default (invariant #8).** Every exported service function calls `requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)` and `assertNotClientUser(actor)` before any DB read.
- **Explainable refusals (invariant #12).** Throw `AppError` with a stable code from `ERROR_CODES`, never a bare `Error`. The context object is named **`detail`** (singular) — see `src/lib/shared/errors.ts`.
- **Never guess a duration (invariant #10).** New process rows default to `provisional: true` with null durations. Clearing `provisional` while a duration is null is refused.
- **All service work runs inside `withTenant(actor.tenantId, async (tx) => …)`** from `@/lib/db`, which sets the RLS `app.tenant_id` GUC. Services take `tx`, never the bare prisma client.
- **Tests:** `pnpm test` runs pure tests only (no DB). DB-backed tests are gated with `describe.skipIf(!process.env.RUN_DB_TESTS)` and run via `pnpm test:db`. **Never** run `RUN_DB_TESTS` against `despl_demo` — `pnpm test:db` sources `.env.test` and points at the dedicated `despl_test` database.
- **UI:** dark industrial theme, tokens from `globals.css` (`--bg`, `--surface`, `--border`, `--text`, `--muted`, `--accent`, `--s-complete`, `--s-idle`, …). JetBrains Mono with `tabular-nums` for all numeric columns. No dead controls, no mock data in components, no `localStorage` for app state, no raw enums in the UI.
- **Branch:** work on `demo`. Never merge to `main` without explicit human approval.
- **After the final task,** update `progress.md`, then sync the vault (`CURRENT_STATUS.md`, `TASKS.md`, `CHANGELOG.md`).

---

### Task 1: Add `updatedAt` to `ProcessTemplateVersion`

The optimistic lock for the draft editor (spec §4.3). Additive, nullable, no backfill.

**Files:**
- Modify: `prisma/schema.prisma` (the `ProcessTemplateVersion` model, around line 530)
- Create: `prisma/migrations/<timestamp>_template_version_updated_at/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing
- Produces: `ProcessTemplateVersion.updatedAt: Date | null` on the generated Prisma client

- [ ] **Step 1: Add the column to the schema**

In `prisma/schema.prisma`, find the `ProcessTemplateVersion` model and add the field after `notes`:

```prisma
model ProcessTemplateVersion {
  id          Int            @id @default(autoincrement())
  templateId  Int            @map("template_id")
  version     Int
  status      TemplateStatus @default(DRAFT)
  publishedAt DateTime?      @map("published_at")
  publishedBy Int?           @map("published_by")
  notes       String?
  /// Optimistic-lock token for the draft editor. Nullable because existing
  /// rows predate it; a null reads as "never edited since the column landed"
  /// and the service treats a null-vs-null comparison as a match.
  updatedAt   DateTime?      @updatedAt @map("updated_at")
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm exec prisma migrate dev --name template_version_updated_at`

Expected: a new folder under `prisma/migrations/` whose `migration.sql` contains `ALTER TABLE "process_template_versions" ADD COLUMN "updated_at" TIMESTAMP(3);` and nothing else. If the generated SQL contains a `DROP` of any kind, stop — the schema has drifted and that must be resolved before continuing.

- [ ] **Step 3: Verify the client regenerated and still typechecks**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/generated
git commit -m "feat(schema): add ProcessTemplateVersion.updatedAt for draft optimistic locking"
```

---

### Task 2: Add the three new error codes

**Files:**
- Modify: `src/lib/shared/errors.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ERROR_CODES.TEMPLATE_VERSION_LOCKED`, `ERROR_CODES.TEMPLATE_INCOMPLETE`, `ERROR_CODES.STALE_WRITE` — all of type `ErrorCode`

- [ ] **Step 1: Append the codes**

The file's header comment says "Add to this list; never rename." Append inside `ERROR_CODES`, after `SNAPSHOT_PRIOR_DAY_PENDING`:

```ts
  /** An edit was attempted against a PUBLISHED template version (invariant #9). */
  TEMPLATE_VERSION_LOCKED: "TEMPLATE_VERSION_LOCKED",
  /** A template version is missing information required to publish it. */
  TEMPLATE_INCOMPLETE: "TEMPLATE_INCOMPLETE",
  /** The row changed under the caller since it was loaded; the write was refused. */
  STALE_WRITE: "STALE_WRITE",
```

- [ ] **Step 2: Append the matching messages**

In `ERROR_MESSAGES`, after `SNAPSHOT_PRIOR_DAY_PENDING`:

```ts
  TEMPLATE_VERSION_LOCKED:
    "This process route is published and cannot be changed. Create a new version to make edits.",
  TEMPLATE_INCOMPLETE:
    "This process route is missing information it needs before it can be published.",
  STALE_WRITE:
    "Someone else changed this while you were editing. Reload the page and reapply your changes.",
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck`
Expected: PASS. `ERROR_MESSAGES` is typed `Record<ErrorCode, string>`, so a missing message is a compile error — this step is the test.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shared/errors.ts
git commit -m "feat(errors): add TEMPLATE_VERSION_LOCKED, TEMPLATE_INCOMPLETE, STALE_WRITE"
```

---

### Task 3: Pure graph validator — `lib/schedule/validate.ts`

Spec §3 and §4.4. `cpm.ts::topologicalOrder` is private and throws a bare `Error` naming no nodes; publish needs diagnostics it can turn into "Process 14 'PWHT' cannot be reached". This is a new pure sibling module — no existing module imports it, and `cpm.ts` is not touched.

**Files:**
- Create: `src/lib/schedule/validate.ts`
- Create: `src/lib/schedule/validate.test.ts`
- Modify: `src/lib/schedule/index.ts`

**Interfaces:**
- Consumes: `ScheduleProcess`, `ScheduleEdge` from `./types`
- Produces:
  - `interface GraphDiagnostics { danglingEdges: ScheduleEdge[]; selfEdges: ScheduleEdge[]; cycleNodeIds: number[]; rootIds: number[]; terminalIds: number[]; unreachableIds: number[] }`
  - `function analyzeGraph(processes: ScheduleProcess[], edges: ScheduleEdge[]): GraphDiagnostics`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/schedule/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { analyzeGraph } from "./validate";
import type { ScheduleProcess, ScheduleEdge } from "./types";

/** Minimal schedulable process — validate.ts only reads `id`. */
function p(id: number): ScheduleProcess {
  return {
    id,
    code: id,
    name: `P${id}`,
    durationMinDays: 1,
    durationMaxDays: 1,
    envelopeFinishByMinDays: 1,
    envelopeFinishByMaxDays: 1,
    envelopeStartByMinDays: 0,
    envelopeStartByMaxDays: 0,
    provisional: false,
  };
}

function e(predecessorId: number, processId: number): ScheduleEdge {
  return { predecessorId, processId, type: "FINISH_TO_START", lagDays: 0 };
}

describe("analyzeGraph", () => {
  it("reports a clean linear chain as valid", () => {
    const d = analyzeGraph([p(1), p(2), p(3)], [e(1, 2), e(2, 3)]);
    expect(d.danglingEdges).toEqual([]);
    expect(d.selfEdges).toEqual([]);
    expect(d.cycleNodeIds).toEqual([]);
    expect(d.unreachableIds).toEqual([]);
    expect(d.rootIds).toEqual([1]);
    expect(d.terminalIds).toEqual([3]);
  });

  it("reports multiple terminals without treating them as an error", () => {
    // 1 → 2, 1 → 3: two dead ends, exactly the shape of the real PV route.
    const d = analyzeGraph([p(1), p(2), p(3)], [e(1, 2), e(1, 3)]);
    expect(d.terminalIds).toEqual([2, 3]);
    expect(d.cycleNodeIds).toEqual([]);
    expect(d.unreachableIds).toEqual([]);
  });

  it("names both members of a two-node cycle", () => {
    const d = analyzeGraph([p(1), p(2)], [e(1, 2), e(2, 1)]);
    expect(d.cycleNodeIds.sort()).toEqual([1, 2]);
    expect(d.rootIds).toEqual([]);
  });

  it("names every member of a longer cycle, and nothing outside it", () => {
    // 1 → 2 → 3 → 4 → 2 : the 2-3-4 loop, with 1 a clean root.
    const d = analyzeGraph([p(1), p(2), p(3), p(4)], [e(1, 2), e(2, 3), e(3, 4), e(4, 2)]);
    expect(d.cycleNodeIds.sort()).toEqual([2, 3, 4]);
    expect(d.rootIds).toEqual([1]);
  });

  it("reports an orphan unreachable from any root", () => {
    // 3 exists but nothing points at it and it points at nothing.
    const d = analyzeGraph([p(1), p(2), p(3)], [e(1, 2)]);
    expect(d.unreachableIds).toEqual([]); // 3 is itself a root
    expect(d.rootIds.sort()).toEqual([1, 3]);
  });

  it("reports a node reachable only from inside a cycle as unreachable", () => {
    // 1 is a lone root going nowhere; 2 ↔ 3 loop feeds 4.
    const d = analyzeGraph([p(1), p(2), p(3), p(4)], [e(2, 3), e(3, 2), e(3, 4)]);
    expect(d.rootIds).toEqual([1]);
    expect(d.unreachableIds.sort()).toEqual([2, 3, 4]);
    expect(d.cycleNodeIds.sort()).toEqual([2, 3, 4]);
  });

  it("collects dangling edges instead of throwing", () => {
    const bad = e(1, 99);
    const d = analyzeGraph([p(1), p(2)], [e(1, 2), bad]);
    expect(d.danglingEdges).toEqual([bad]);
    expect(d.cycleNodeIds).toEqual([]);
  });

  it("collects a self-edge and excludes it from the graph", () => {
    const self = e(2, 2);
    const d = analyzeGraph([p(1), p(2)], [e(1, 2), self]);
    expect(d.selfEdges).toEqual([self]);
    // With the self-edge excluded, 2 is still properly reachable from 1.
    expect(d.cycleNodeIds).toEqual([]);
    expect(d.unreachableIds).toEqual([]);
  });

  it("handles an empty graph", () => {
    const d = analyzeGraph([], []);
    expect(d).toEqual({
      danglingEdges: [],
      selfEdges: [],
      cycleNodeIds: [],
      rootIds: [],
      terminalIds: [],
      unreachableIds: [],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/lib/schedule/validate.test.ts`
Expected: FAIL — "Failed to resolve import ./validate" or "analyzeGraph is not a function".

- [ ] **Step 3: Write the implementation**

Create `src/lib/schedule/validate.ts`:

```ts
import type { ScheduleProcess, ScheduleEdge } from "./types";

/**
 * Structural diagnostics for a process graph, for the route-authoring
 * publish check. Deliberately a sibling of cpm.ts's private
 * `topologicalOrder` rather than a refactor of it: that one guards an
 * invariant on the scheduling hot path and throws fast with no node
 * identity, this one must never throw and must name every offending node so
 * the UI can explain the refusal (invariant #12). Same ~20 lines of Kahn's,
 * opposite contract.
 *
 * Nothing here rejects — every field is a fact about the graph. Which facts
 * block a publish and which merely warn is `template.service.ts`'s call, and
 * that split is deliberate: multiple terminals, for instance, is normal (the
 * real PRESSURE_VESSEL route has three) while an unreachable node never is.
 */
export interface GraphDiagnostics {
  /** Edges pointing at a process id outside the given set. */
  danglingEdges: ScheduleEdge[];
  /** Edges where a process is its own predecessor. */
  selfEdges: ScheduleEdge[];
  /** Processes Kahn's algorithm could not emit — the cycle members. */
  cycleNodeIds: number[];
  /** Processes with no incoming edge. */
  rootIds: number[];
  /** Processes with no outgoing edge. */
  terminalIds: number[];
  /** Processes not reachable from any root by following edges forward. */
  unreachableIds: number[];
}

export function analyzeGraph(
  processes: ScheduleProcess[],
  edges: ScheduleEdge[],
): GraphDiagnostics {
  const ids = processes.map((p) => p.id);
  const idSet = new Set(ids);

  const danglingEdges = edges.filter(
    (e) => !idSet.has(e.processId) || !idSet.has(e.predecessorId),
  );
  const selfEdges = edges.filter(
    (e) => idSet.has(e.processId) && e.processId === e.predecessorId,
  );
  // Both classes are reported to the caller and then ignored, so the rest of
  // the analysis describes the graph that would exist once they are fixed —
  // one dangling edge shouldn't mask every other problem behind it.
  const usable = edges.filter(
    (e) =>
      idSet.has(e.processId) &&
      idSet.has(e.predecessorId) &&
      e.processId !== e.predecessorId,
  );

  const inDegree = new Map<number, number>(ids.map((id) => [id, 0]));
  const successors = new Map<number, number[]>(ids.map((id) => [id, []]));
  const hasOutgoing = new Set<number>();
  for (const e of usable) {
    inDegree.set(e.processId, inDegree.get(e.processId)! + 1);
    successors.get(e.predecessorId)!.push(e.processId);
    hasOutgoing.add(e.predecessorId);
  }

  const rootIds = ids.filter((id) => inDegree.get(id) === 0);
  const terminalIds = ids.filter((id) => !hasOutgoing.has(id));

  // Kahn's, collecting what it cannot emit rather than throwing.
  const remaining = new Map(inDegree);
  const queue = [...rootIds];
  const emitted = new Set<number>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    emitted.add(id);
    for (const next of successors.get(id)!) {
      const d = remaining.get(next)! - 1;
      remaining.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  const cycleNodeIds = ids.filter((id) => !emitted.has(id));

  // Forward reachability from the roots. Separate from `emitted` on purpose:
  // Kahn's holds a node back until ALL its predecessors are emitted, so a
  // node fed by both a root and a cycle is un-emitted yet genuinely reachable.
  const reached = new Set<number>(rootIds);
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of successors.get(id)!) {
      if (!reached.has(next)) {
        reached.add(next);
        stack.push(next);
      }
    }
  }
  const unreachableIds = ids.filter((id) => !reached.has(id));

  return { danglingEdges, selfEdges, cycleNodeIds, rootIds, terminalIds, unreachableIds };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/lib/schedule/validate.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Export from the barrel**

In `src/lib/schedule/index.ts`, add after the `bypassExcluded` export:

```ts
export { analyzeGraph, type GraphDiagnostics } from "./validate";
```

- [ ] **Step 6: Verify the whole pure suite is still green**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/schedule/validate.ts src/lib/schedule/validate.test.ts src/lib/schedule/index.ts
git commit -m "feat(schedule): add analyzeGraph pure graph diagnostics for route validation"
```

---

### Task 4: Extract the copy-on-write helper from `admin.service.ts`

`updateStandardDurations` (line 254) already deep-copies a version's processes and edges. Tasks 6 and 8 need the same loop. Extract it, leaving `updateStandardDurations`'s behaviour and its existing tests untouched.

**Files:**
- Create: `src/lib/services/template-copy.ts`
- Modify: `src/lib/services/admin.service.ts:296-330` (the copy loop inside `updateStandardDurations`)

**Interfaces:**
- Consumes: `Tx` from `@/lib/db`
- Produces:
  ```ts
  interface ProcessOverride {
    durationMinDays?: number;
    durationMaxDays?: number;
    provisional?: boolean;
  }
  function copyVersionContents(
    tx: Tx,
    sourceVersionId: number,
    targetVersionId: number,
    overrideByProcessId?: Map<number, ProcessOverride>,
  ): Promise<Map<number, number>>;  // source TemplateProcess.id → new id
  ```

- [ ] **Step 1: Write the helper**

Create `src/lib/services/template-copy.ts`:

```ts
import type { Tx } from "@/lib/db";

/**
 * Per-process edits to apply while copying. Only the fields
 * `updateStandardDurations` has ever changed — this helper deliberately does
 * NOT accept arbitrary field overrides, because a template version copy that
 * can silently rewrite anything is how a "versioned" template stops being an
 * honest record of what changed.
 */
export interface ProcessOverride {
  durationMinDays?: number;
  durationMaxDays?: number;
  provisional?: boolean;
}

/**
 * Deep-copy a template version's processes and edges onto another (already
 * created) version row, returning a source-id → new-id map so the caller can
 * re-point anything else that referenced the originals.
 *
 * Extracted verbatim from admin.service.ts::updateStandardDurations so the
 * clone path in template.service.ts cannot drift from it. Runs in the
 * caller's transaction; creates no version row of its own.
 */
export async function copyVersionContents(
  tx: Tx,
  sourceVersionId: number,
  targetVersionId: number,
  overrideByProcessId: Map<number, ProcessOverride> = new Map(),
): Promise<Map<number, number>> {
  const processes = await tx.templateProcess.findMany({ where: { versionId: sourceVersionId } });
  const edges = await tx.templateEdge.findMany({ where: { versionId: sourceVersionId } });

  const oldToNewProcessId = new Map<number, number>();
  for (const p of processes) {
    const o = overrideByProcessId.get(p.id);
    const copy = await tx.templateProcess.create({
      data: {
        versionId: targetVersionId,
        seq: p.seq,
        code: p.code,
        name: p.name,
        mainActivities: p.mainActivities,
        durationMinDays: o?.durationMinDays ?? p.durationMinDays,
        durationMaxDays: o?.durationMaxDays ?? p.durationMaxDays,
        cumulativePrinted: p.cumulativePrinted,
        defaultDepartmentId: p.defaultDepartmentId,
        workOrderStages: p.workOrderStages,
        envelopeFinishByMinDays: p.envelopeFinishByMinDays,
        envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
        envelopeStartByMinDays: p.envelopeStartByMinDays,
        envelopeStartByMaxDays: p.envelopeStartByMaxDays,
        optional: p.optional,
        provisional: o?.provisional ?? p.provisional,
      },
    });
    oldToNewProcessId.set(p.id, copy.id);
  }

  for (const e of edges) {
    await tx.templateEdge.create({
      data: {
        versionId: targetVersionId,
        processId: oldToNewProcessId.get(e.processId)!,
        predecessorId: oldToNewProcessId.get(e.predecessorId)!,
        type: e.type,
        lagDays: e.lagDays,
      },
    });
  }

  return oldToNewProcessId;
}
```

- [ ] **Step 2: Rewire `updateStandardDurations` to use it**

In `src/lib/services/admin.service.ts`, inside the `audited(...)` callback, replace the whole `const oldToNewProcessId = new Map<number, number>(); for (const p of source.processes) { … }` block **and** the `for (const e of source.edges) { … }` block that follows it with:

```ts
      const overrides = new Map(
        edits.map((e) => [
          e.templateProcessId,
          {
            durationMinDays: e.durationMinDays,
            durationMaxDays: e.durationMaxDays,
            // An explicit duration edit is a confirmation: it clears
            // `provisional`, matching the behaviour this function has always
            // had. Processes with no edit keep whatever they had.
            provisional: false,
          },
        ]),
      );
      await copyVersionContents(tx, source.id, created.id, overrides);
```

Add the import at the top of the file:

```ts
import { copyVersionContents } from "./template-copy";
```

The `source` query's `include: { processes: true, edges: true }` is now only used for the `sourceProcessIds` validity check above; leave it, it is still needed there.

- [ ] **Step 3: Verify the existing tests still pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. `admin.service.test.ts` must be green **without modification** — if a test needed changing, the extraction changed behaviour and is wrong.

- [ ] **Step 4: Verify against the real database**

Run: `pnpm test:db`
Expected: PASS. This exercises `updateStandardDurations` against the seeded 36-process route, which is the only proof the copy loop still produces identical output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/template-copy.ts src/lib/services/admin.service.ts
git commit -m "refactor(services): extract copyVersionContents from updateStandardDurations"
```

---

### Task 5: zod schemas for the four service functions

**Files:**
- Modify: `src/lib/shared/schemas.ts` (append after `updateStandardDurationsSchema`, around line 208)

**Interfaces:**
- Consumes: the local `id` helper (`z.number().int().positive()`, line 36)
- Produces: `createTemplateSchema`/`CreateTemplateInput`, `cloneVersionSchema`/`CloneVersionInput`, `saveDraftVersionSchema`/`SaveDraftVersionInput`, `publishVersionSchema`/`PublishVersionInput`, and the exported `TEMPLATE_WARNING_CODES` tuple

- [ ] **Step 1: Append the schemas**

```ts
// ── Process route authoring ─────────────────────────────────────────────

/** Warning codes publishVersion can return; the caller echoes them back to confirm they were shown. */
export const TEMPLATE_WARNING_CODES = [
  "PROVISIONAL_DURATIONS",
  "MULTIPLE_TERMINALS",
  "EMPTY_WORK_ORDER_STAGES",
  "ENVELOPE_MISMATCH",
] as const;
export type TemplateWarningCode = (typeof TEMPLATE_WARNING_CODES)[number];

/** Start a route for a family that has none. Creates an empty v1 DRAFT. */
export const createTemplateSchema = z
  .object({
    familyId: id,
    name: z.string().trim().min(1, "A name is required"),
  })
  .strict();
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/**
 * Deep-copy a version into a new DRAFT. Omit `targetFamilyId` to revise the
 * same template (next version); supply it to start a new family's route from
 * an existing one, which needs a `name` for the new template.
 */
export const cloneVersionSchema = z
  .object({
    sourceVersionId: id,
    targetFamilyId: id.optional(),
    name: z.string().trim().min(1).optional(),
    notes: z.string().trim().min(1, "Say why this version exists"),
  })
  .strict()
  .refine((v) => v.targetFamilyId == null || v.name != null, {
    message: "A name is required when cloning into another product family",
    path: ["name"],
  });
export type CloneVersionInput = z.infer<typeof cloneVersionSchema>;

/**
 * Full replace of a DRAFT's contents. `key` is a client-side stable handle so
 * edges can reference rows that have no database id yet.
 *
 * `provisional` and the durations are cross-checked: a process may not claim
 * confirmed durations it does not have, nor hide real ones behind the flag.
 * That pairing is invariant #10's guard rail, enforced here and again in the
 * service.
 */
export const saveDraftVersionSchema = z
  .object({
    versionId: id,
    /** The `updatedAt` the editor loaded. Null is legitimate for rows that predate the column. */
    expectedUpdatedAt: z.coerce.date().nullable(),
    processes: z
      .array(
        z
          .object({
            key: z.string().trim().min(1),
            seq: z.number().int().positive(),
            code: z.string().trim().min(1),
            name: z.string().trim().min(1),
            mainActivities: z.string().trim().nullable().default(null),
            defaultDepartmentId: id,
            durationMinDays: z.number().int().positive().nullable().default(null),
            durationMaxDays: z.number().int().positive().nullable().default(null),
            envelopeStartByMinDays: z.number().int().nullable().default(null),
            envelopeStartByMaxDays: z.number().int().nullable().default(null),
            envelopeFinishByMinDays: z.number().int().nullable().default(null),
            envelopeFinishByMaxDays: z.number().int().nullable().default(null),
            workOrderStages: z.array(z.number().int().positive()).default([]),
            optional: z.boolean().default(false),
            provisional: z.boolean().default(true),
          })
          .strict()
          .refine(
            (p) =>
              p.provisional ||
              (p.durationMinDays != null && p.durationMaxDays != null),
            {
              message:
                "A confirmed process needs both a minimum and a maximum duration. Mark it provisional instead.",
              path: ["durationMinDays"],
            },
          )
          .refine(
            (p) =>
              p.durationMinDays == null ||
              p.durationMaxDays == null ||
              p.durationMinDays <= p.durationMaxDays,
            {
              message: "Minimum duration cannot exceed the maximum",
              path: ["durationMaxDays"],
            },
          ),
      )
      .default([]),
    edges: z
      .array(
        z
          .object({
            processKey: z.string().trim().min(1),
            predecessorKey: z.string().trim().min(1),
            type: z.enum(["FINISH_TO_START", "START_TO_START_WITH_OVERLAP"]),
            // Negative lag is legitimate concurrent work (invariant #11), so
            // this is a plain int with no positivity constraint.
            lagDays: z.number().int(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type SaveDraftVersionInput = z.infer<typeof saveDraftVersionSchema>;

/** Publish a DRAFT. `notes` is mandatory — it is what an auditor reads later. */
export const publishVersionSchema = z
  .object({
    versionId: id,
    notes: z.string().trim().min(1, "Say where this route's data came from"),
    acknowledgedWarnings: z.array(z.enum(TEMPLATE_WARNING_CODES)).default([]),
    /** Optional printed lead time in days to check the computed envelope against (invariant #10). */
    expectedEnvelopeDays: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type PublishVersionInput = z.infer<typeof publishVersionSchema>;
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/shared/schemas.ts
git commit -m "feat(schemas): add route-authoring input schemas"
```

---

### Task 6: `createTemplate` and `cloneVersion`

**Files:**
- Create: `src/lib/services/template.service.ts`
- Create: `src/lib/services/template.service.test.ts`

**Interfaces:**
- Consumes: `copyVersionContents` (Task 4), `createTemplateSchema` / `cloneVersionSchema` (Task 5)
- Produces:
  - `createTemplate(actor: Actor, input: CreateTemplateInput): Promise<ProcessTemplateVersion>`
  - `cloneVersion(actor: Actor, input: CloneVersionInput): Promise<ProcessTemplateVersion>`

- [ ] **Step 1: Write the failing pure-refusal tests**

Create `src/lib/services/template.service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES } from "@/lib/shared/errors";
import { createTemplate, cloneVersion } from "./template.service";

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

/**
 * Refusals decidable from the caller's own actor/request shape, with no DB
 * read — same tier split as admin.service.test.ts.
 */
describe("template.service — pure refusals", () => {
  it.each([
    ["SUPERVISOR", ROLES.SUPERVISOR],
    ["QC", ROLES.QC],
    ["MANAGEMENT", ROLES.MANAGEMENT],
  ])("createTemplate refuses a %s caller (RBAC deny-by-default)", async (_label, role) => {
    await expect(
      createTemplate(actor({ roles: [role] }), { familyId: 1, name: "X" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createTemplate refuses a client user before touching the DB", async () => {
    await expect(
      createTemplate(actor({ clientId: 9, roles: [ROLES.CLIENT_VIEWER] }), { familyId: 1, name: "X" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("cloneVersion refuses a SUPERVISOR caller", async () => {
    await expect(
      cloneVersion(actor({ roles: [ROLES.SUPERVISOR] }), { sourceVersionId: 1, notes: "n" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("cloneVersion requires a name when cloning into another family", async () => {
    await expect(
      cloneVersion(actor(), { sourceVersionId: 1, targetFamilyId: 2, notes: "n" }),
    ).rejects.toThrow();
  });

  it("rejects a smuggled *_at key via the strict schema (invariant #1)", async () => {
    await expect(
      // @ts-expect-error — .strict() schema; no timestamp field exists on this input
      createTemplate(actor(), { familyId: 1, name: "X", publishedAt: new Date() }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/services/template.service.test.ts`
Expected: FAIL — "Failed to resolve import ./template.service".

- [ ] **Step 3: Write the implementation**

Create `src/lib/services/template.service.ts`:

```ts
import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { ROLES, requireRole, assertNotClientUser, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  createTemplateSchema,
  cloneVersionSchema,
  type CreateTemplateInput,
  type CloneVersionInput,
} from "@/lib/shared/schemas";
import { copyVersionContents } from "./template-copy";
import type { ProcessTemplateVersion } from "@/generated/prisma/client";

/**
 * Process route authoring (docs/superpowers/specs/2026-08-22-route-authoring-design.md).
 *
 * The discipline this file exists to enforce: a PUBLISHED
 * ProcessTemplateVersion is immutable (invariant #9). Every edit path either
 * targets a DRAFT or creates a new version — never both, never neither. Jobs
 * pin a version at creation and keep it forever, so mutating a published one
 * would silently rewrite the plan of every job already running against it.
 *
 * `updateStandardDurations` in admin.service.ts stays where it is: a narrower,
 * already-tested contract (edit durations → publish in one shot) that this
 * file's saveDraft → publish flow deliberately does not absorb.
 */

/** Start a route for a family that has none. The result is an empty v1 DRAFT. */
export async function createTemplate(
  actor: Actor,
  input: CreateTemplateInput,
): Promise<ProcessTemplateVersion> {
  const { familyId, name } = createTemplateSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const family = await tx.productFamily.findFirst({
      where: { id: familyId, tenantId: actor.tenantId },
    });
    if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId });

    return audited(tx, actor, async () => {
      const template = await tx.processTemplate.create({
        data: { tenantId: actor.tenantId, familyId, name },
      });
      const version = await tx.processTemplateVersion.create({
        data: { templateId: template.id, version: 1, status: "DRAFT" },
      });
      return {
        result: version,
        audit: {
          action: "template.create",
          entityType: "ProcessTemplateVersion",
          entityId: version.id,
          after: { templateId: template.id, familyId, name, version: 1, status: "DRAFT" },
          eventType: "ProcessTemplateCreated",
          eventPayload: { templateId: template.id, versionId: version.id, familyId },
        },
      };
    });
  });
}

/**
 * Deep-copy a version into a new DRAFT — the primary authoring path, because
 * nobody types 36 processes from a blank page.
 *
 * Durations are copied VERBATIM, including into another family. That is
 * deliberate: silently nulling them would hide the author's decision about
 * whether the source's numbers apply here. If they don't, the author must
 * change them or mark the process provisional, and the publish warning will
 * say so either way (invariant #10).
 */
export async function cloneVersion(
  actor: Actor,
  input: CloneVersionInput,
): Promise<ProcessTemplateVersion> {
  const { sourceVersionId, targetFamilyId, name, notes } = cloneVersionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const source = await tx.processTemplateVersion.findFirst({
      where: { id: sourceVersionId, template: { tenantId: actor.tenantId } },
      include: { template: true },
    });
    if (!source) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        entity: "ProcessTemplateVersion",
        sourceVersionId,
      });
    }

    let templateId = source.templateId;
    let version: number;
    if (targetFamilyId != null) {
      const family = await tx.productFamily.findFirst({
        where: { id: targetFamilyId, tenantId: actor.tenantId },
      });
      if (!family) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId: targetFamilyId });
      }
      const created = await tx.processTemplate.create({
        data: { tenantId: actor.tenantId, familyId: targetFamilyId, name: name! },
      });
      templateId = created.id;
      version = 1;
    } else {
      const max = await tx.processTemplateVersion.aggregate({
        _max: { version: true },
        where: { templateId: source.templateId },
      });
      version = (max._max.version ?? 0) + 1;
    }

    return audited(tx, actor, async () => {
      const draft = await tx.processTemplateVersion.create({
        data: { templateId, version, status: "DRAFT", notes },
      });
      const idMap = await copyVersionContents(tx, source.id, draft.id);
      return {
        result: draft,
        audit: {
          action: "template.cloneVersion",
          entityType: "ProcessTemplateVersion",
          entityId: draft.id,
          before: { sourceVersionId: source.id, sourceTemplateId: source.templateId },
          after: { templateId, version, status: "DRAFT", processCount: idMap.size, notes },
          eventType: "ProcessTemplateVersionCloned",
          eventPayload: { sourceVersionId: source.id, newVersionId: draft.id, templateId },
        },
      };
    });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/lib/services/template.service.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the DB-backed clone tests**

Append to `src/lib/services/template.service.test.ts`:

```ts
import { prisma } from "@/lib/db";

/**
 * Behavioural round-trip against a seeded database. Gated: `pnpm test:db`
 * sources .env.test and points at despl_test — never run RUN_DB_TESTS
 * against despl_demo.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("template.service — clone (DB)", () => {
  async function publishedPvVersion() {
    const v = await prisma.processTemplateVersion.findFirst({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
    });
    if (!v) throw new Error("seed missing: no published PRESSURE_VESSEL version");
    return v;
  }

  it("clones every process and edge into a new DRAFT, leaving the source untouched", async () => {
    const source = await publishedPvVersion();
    const before = {
      processes: await prisma.templateProcess.count({ where: { versionId: source.id } }),
      edges: await prisma.templateEdge.count({ where: { versionId: source.id } }),
    };

    const draft = await cloneVersion(actor(), {
      sourceVersionId: source.id,
      notes: "test clone",
    });

    expect(draft.status).toBe("DRAFT");
    expect(draft.version).toBe(source.version + 1);
    expect(draft.templateId).toBe(source.templateId);
    expect(await prisma.templateProcess.count({ where: { versionId: draft.id } })).toBe(before.processes);
    expect(await prisma.templateEdge.count({ where: { versionId: draft.id } })).toBe(before.edges);
    // Source untouched.
    expect(await prisma.templateProcess.count({ where: { versionId: source.id } })).toBe(before.processes);
    expect((await prisma.processTemplateVersion.findUniqueOrThrow({ where: { id: source.id } })).status).toBe("PUBLISHED");

    // Copied edges point only at the copy's own processes.
    const newProcessIds = new Set(
      (await prisma.templateProcess.findMany({ where: { versionId: draft.id }, select: { id: true } })).map((p) => p.id),
    );
    const newEdges = await prisma.templateEdge.findMany({ where: { versionId: draft.id } });
    for (const e of newEdges) {
      expect(newProcessIds.has(e.processId)).toBe(true);
      expect(newProcessIds.has(e.predecessorId)).toBe(true);
    }

    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("clones into another family as version 1 of a new template", async () => {
    const source = await publishedPvVersion();
    const hx = await prisma.productFamily.findFirstOrThrow({ where: { code: "HEAT_EXCHANGER" } });

    const draft = await cloneVersion(actor(), {
      sourceVersionId: source.id,
      targetFamilyId: hx.id,
      name: "Test HX route",
      notes: "test cross-family clone",
    });

    expect(draft.version).toBe(1);
    expect(draft.status).toBe("DRAFT");
    const template = await prisma.processTemplate.findUniqueOrThrow({ where: { id: draft.templateId } });
    expect(template.familyId).toBe(hx.id);

    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
    await prisma.processTemplate.delete({ where: { id: template.id } });
  });

  it("writes exactly one audit row per clone", async () => {
    const source = await publishedPvVersion();
    const before = await prisma.auditLog.count({ where: { action: "template.cloneVersion" } });
    const draft = await cloneVersion(actor(), { sourceVersionId: source.id, notes: "audit test" });
    expect(await prisma.auditLog.count({ where: { action: "template.cloneVersion" } })).toBe(before + 1);
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses a cross-tenant source with NOT_FOUND, not a leak", async () => {
    const source = await publishedPvVersion();
    await expect(
      cloneVersion(actor({ tenantId: 999 }), { sourceVersionId: source.id, notes: "n" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
});
```

- [ ] **Step 6: Run the DB tests**

Run: `pnpm test:db`
Expected: PASS. If `despl_test` is not seeded, run `pnpm db:seed` against it first (with `.env.test` loaded), never against `despl_demo`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/template.service.ts src/lib/services/template.service.test.ts
git commit -m "feat(services): add createTemplate and cloneVersion route authoring"
```

---

### Task 7: `saveDraftVersion`

**Files:**
- Modify: `src/lib/services/template.service.ts`
- Modify: `src/lib/services/template.service.test.ts`

**Interfaces:**
- Consumes: `saveDraftVersionSchema` (Task 5)
- Produces: `saveDraftVersion(actor: Actor, input: SaveDraftVersionInput): Promise<ProcessTemplateVersion>`

- [ ] **Step 1: Write the failing tests**

Append to the pure-refusals describe block in `template.service.test.ts`:

```ts
  it("saveDraftVersion refuses a QC caller", async () => {
    await expect(
      saveDraftVersion(actor({ roles: [ROLES.QC] }), {
        versionId: 1,
        expectedUpdatedAt: null,
        processes: [],
        edges: [],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("rejects a process claiming confirmed durations it does not have", async () => {
    await expect(
      saveDraftVersion(actor(), {
        versionId: 1,
        expectedUpdatedAt: null,
        processes: [
          {
            key: "a",
            seq: 1,
            code: "1",
            name: "Kickoff",
            defaultDepartmentId: 1,
            provisional: false, // says confirmed…
            durationMinDays: null, // …but has no duration (invariant #10)
            durationMaxDays: null,
          },
        ],
        edges: [],
      }),
    ).rejects.toThrow();
  });

  it("rejects a process whose minimum duration exceeds its maximum", async () => {
    await expect(
      saveDraftVersion(actor(), {
        versionId: 1,
        expectedUpdatedAt: null,
        processes: [
          {
            key: "a",
            seq: 1,
            code: "1",
            name: "Kickoff",
            defaultDepartmentId: 1,
            provisional: false,
            durationMinDays: 9,
            durationMaxDays: 3,
          },
        ],
        edges: [],
      }),
    ).rejects.toThrow();
  });
```

Update the import at the top to include `saveDraftVersion`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/lib/services/template.service.test.ts`
Expected: FAIL — `saveDraftVersion` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/services/template.service.ts` (and add `saveDraftVersionSchema`, `type SaveDraftVersionInput` to the schemas import):

```ts
/**
 * Full replace of a DRAFT's processes and edges.
 *
 * Full replace, not a per-row diff: the editor is a spreadsheet-shaped screen
 * where an author reorders, renumbers and rewires in one pass, and a diff
 * protocol for that is more code and more ways to half-apply. The cost is
 * that two concurrent editors would clobber each other, which the
 * `expectedUpdatedAt` check below is what prevents.
 *
 * Validation here is deliberately thin — an author mid-edit is allowed to
 * hold a broken graph. Only structural impossibilities are refused now;
 * everything about whether the route makes SENSE waits for publishVersion.
 */
export async function saveDraftVersion(
  actor: Actor,
  input: SaveDraftVersionInput,
): Promise<ProcessTemplateVersion> {
  const { versionId, expectedUpdatedAt, processes, edges } = saveDraftVersionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  // Cheap, caller-shape-only checks before any DB round trip.
  const keys = new Set<string>();
  for (const p of processes) {
    if (keys.has(p.key)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "duplicate process key", key: p.key });
    }
    keys.add(p.key);
  }
  const codes = new Set<string>();
  const seqs = new Set<number>();
  for (const p of processes) {
    if (codes.has(p.code)) {
      throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, { reason: "duplicate process code", code: p.code });
    }
    codes.add(p.code);
    if (seqs.has(p.seq)) {
      throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, { reason: "duplicate sequence number", seq: p.seq });
    }
    seqs.add(p.seq);
  }
  for (const e of edges) {
    if (!keys.has(e.processKey) || !keys.has(e.predecessorKey)) {
      throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
        reason: "edge references a process that is not in this route",
        processKey: e.processKey,
        predecessorKey: e.predecessorKey,
      });
    }
    if (e.processKey === e.predecessorKey) {
      throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
        reason: "a process cannot be its own predecessor",
        processKey: e.processKey,
      });
    }
  }

  return withTenant(actor.tenantId, async (tx) => {
    const version = await tx.processTemplateVersion.findFirst({
      where: { id: versionId, template: { tenantId: actor.tenantId } },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", versionId });
    }
    if (version.status !== "DRAFT") {
      // Invariant #9 enforced at the service layer — the UI hiding the Save
      // button is not enforcement.
      throw new AppError(ERROR_CODES.TEMPLATE_VERSION_LOCKED, { versionId, status: version.status });
    }
    const currentStamp = version.updatedAt?.getTime() ?? null;
    const expectedStamp = expectedUpdatedAt?.getTime() ?? null;
    if (currentStamp !== expectedStamp) {
      throw new AppError(ERROR_CODES.STALE_WRITE, { versionId });
    }

    const departmentIds = [...new Set(processes.map((p) => p.defaultDepartmentId))];
    if (departmentIds.length > 0) {
      const found = await tx.department.count({
        where: { id: { in: departmentIds }, tenantId: actor.tenantId },
      });
      if (found !== departmentIds.length) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Department", departmentIds });
      }
    }

    const before = {
      processCount: await tx.templateProcess.count({ where: { versionId } }),
      edgeCount: await tx.templateEdge.count({ where: { versionId } }),
    };

    return audited(tx, actor, async () => {
      // TemplateEdge cascades on both its process FKs, so deleting the
      // processes takes the edges with them; the explicit edge delete first
      // is belt-and-braces for a draft that somehow holds orphan edges.
      await tx.templateEdge.deleteMany({ where: { versionId } });
      await tx.templateProcess.deleteMany({ where: { versionId } });

      const idByKey = new Map<string, number>();
      for (const p of processes) {
        const row = await tx.templateProcess.create({
          data: {
            versionId,
            seq: p.seq,
            code: p.code,
            name: p.name,
            mainActivities: p.mainActivities,
            defaultDepartmentId: p.defaultDepartmentId,
            durationMinDays: p.durationMinDays,
            durationMaxDays: p.durationMaxDays,
            envelopeStartByMinDays: p.envelopeStartByMinDays,
            envelopeStartByMaxDays: p.envelopeStartByMaxDays,
            envelopeFinishByMinDays: p.envelopeFinishByMinDays,
            envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
            workOrderStages: p.workOrderStages,
            optional: p.optional,
            provisional: p.provisional,
          },
        });
        idByKey.set(p.key, row.id);
      }
      for (const e of edges) {
        await tx.templateEdge.create({
          data: {
            versionId,
            processId: idByKey.get(e.processKey)!,
            predecessorId: idByKey.get(e.predecessorKey)!,
            type: e.type,
            lagDays: e.lagDays,
          },
        });
      }

      const saved = await tx.processTemplateVersion.update({
        where: { id: versionId },
        data: { updatedAt: new Date() },
      });

      return {
        result: saved,
        audit: {
          action: "template.saveDraft",
          entityType: "ProcessTemplateVersion",
          entityId: versionId,
          before,
          after: { processCount: processes.length, edgeCount: edges.length },
          eventType: "ProcessTemplateDraftSaved",
          eventPayload: { versionId, processCount: processes.length, edgeCount: edges.length },
        },
      };
    });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/lib/services/template.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the DB-backed save tests**

Append a new gated describe block to `template.service.test.ts`:

```ts
describe.skipIf(!process.env.RUN_DB_TESTS)("template.service — saveDraftVersion (DB)", () => {
  async function freshDraft() {
    const source = await prisma.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
    });
    return cloneVersion(actor(), { sourceVersionId: source.id, notes: "save test" });
  }

  it("replaces the draft's contents wholesale", async () => {
    const draft = await freshDraft();
    const loaded = await prisma.processTemplateVersion.findUniqueOrThrow({ where: { id: draft.id } });
    const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: 1 } });

    await saveDraftVersion(actor(), {
      versionId: draft.id,
      expectedUpdatedAt: loaded.updatedAt,
      processes: [
        { key: "a", seq: 1, code: "1", name: "Start", defaultDepartmentId: dept.id, provisional: true, durationMinDays: null, durationMaxDays: null },
        { key: "b", seq: 2, code: "2", name: "End", defaultDepartmentId: dept.id, provisional: true, durationMinDays: null, durationMaxDays: null },
      ],
      edges: [{ processKey: "b", predecessorKey: "a", type: "FINISH_TO_START", lagDays: 0 }],
    });

    expect(await prisma.templateProcess.count({ where: { versionId: draft.id } })).toBe(2);
    expect(await prisma.templateEdge.count({ where: { versionId: draft.id } })).toBe(1);

    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses a save against a PUBLISHED version (invariant #9)", async () => {
    const published = await prisma.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
    });
    await expect(
      saveDraftVersion(actor(), {
        versionId: published.id,
        expectedUpdatedAt: published.updatedAt,
        processes: [],
        edges: [],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_VERSION_LOCKED });
  });

  it("refuses a stale write and leaves the draft unchanged", async () => {
    const draft = await freshDraft();
    const countBefore = await prisma.templateProcess.count({ where: { versionId: draft.id } });

    await expect(
      saveDraftVersion(actor(), {
        versionId: draft.id,
        expectedUpdatedAt: new Date(0), // definitely not the current stamp
        processes: [],
        edges: [],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_WRITE });

    expect(await prisma.templateProcess.count({ where: { versionId: draft.id } })).toBe(countBefore);
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });
});
```

Add `saveDraftVersion` to the imports.

- [ ] **Step 6: Run**

Run: `pnpm test:db && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/template.service.ts src/lib/services/template.service.test.ts
git commit -m "feat(services): add saveDraftVersion with optimistic locking"
```

---

### Task 8: `publishVersion` with blocking checks and warnings

The heart of the feature. Spec §4.4.

**Files:**
- Modify: `src/lib/services/template.service.ts`
- Modify: `src/lib/services/template.service.test.ts`

**Interfaces:**
- Consumes: `analyzeGraph` (Task 3), `computeEnvelope` from `@/lib/schedule`, `publishVersionSchema` + `TemplateWarningCode` (Task 5)
- Produces:
  - `interface TemplateWarning { code: TemplateWarningCode; message: string; processCodes: string[] }`
  - `interface PublishResult { version: ProcessTemplateVersion; warnings: TemplateWarning[]; envelopeDays: number | null }`
  - `validateVersionForPublish(tx: Tx, versionId: number, expectedEnvelopeDays: number | null): Promise<{ warnings: TemplateWarning[]; envelopeDays: number | null }>` — throws on blocking failures
  - `publishVersion(actor: Actor, input: PublishVersionInput): Promise<PublishResult>`

- [ ] **Step 1: Write the failing tests**

Append a gated describe block to `template.service.test.ts`:

```ts
describe.skipIf(!process.env.RUN_DB_TESTS)("template.service — publishVersion (DB)", () => {
  async function draftFromPv() {
    const source = await prisma.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
    });
    return cloneVersion(actor(), { sourceVersionId: source.id, notes: "publish test" });
  }

  async function writeGraph(
    versionId: number,
    processes: Array<{ key: string; seq: number; code: string; name: string }>,
    edges: Array<{ processKey: string; predecessorKey: string }>,
  ) {
    const loaded = await prisma.processTemplateVersion.findUniqueOrThrow({ where: { id: versionId } });
    const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: 1 } });
    await saveDraftVersion(actor(), {
      versionId,
      expectedUpdatedAt: loaded.updatedAt,
      processes: processes.map((p) => ({
        ...p,
        defaultDepartmentId: dept.id,
        provisional: true,
        durationMinDays: null,
        durationMaxDays: null,
      })),
      edges: edges.map((e) => ({ ...e, type: "FINISH_TO_START" as const, lagDays: 0 })),
    });
  }

  it("publishes the real seeded PRESSURE_VESSEL route unchanged, warning about its three terminals", async () => {
    // The regression that motivated the spec's rule change: this route has
    // ONE root and THREE terminals (36 Dispatch, 5 Client Drawing Approval,
    // 6 BOM & MTO Finalization). A validator stricter than DESPL's own
    // process would refuse the only route in the system that works.
    const draft = await draftFromPv();
    const result = await publishVersion(actor(), {
      versionId: draft.id,
      notes: "verbatim clone of the seeded lead-time route",
      acknowledgedWarnings: ["MULTIPLE_TERMINALS"],
      expectedEnvelopeDays: null,
    });
    expect(result.version.status).toBe("PUBLISHED");
    expect(result.version.publishedAt).not.toBeNull();
    const terminals = result.warnings.find((w) => w.code === "MULTIPLE_TERMINALS");
    expect(terminals?.processCodes.sort()).toEqual(["36", "5", "6"]);
    expect(result.envelopeDays).toBeGreaterThan(0);
  });

  it("refuses an empty route", async () => {
    const draft = await draftFromPv();
    await writeGraph(draft.id, [], []);
    await expect(
      publishVersion(actor(), { versionId: draft.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_INCOMPLETE });
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses non-contiguous sequence numbers", async () => {
    const draft = await draftFromPv();
    await writeGraph(
      draft.id,
      [
        { key: "a", seq: 1, code: "1", name: "A" },
        { key: "b", seq: 5, code: "2", name: "B" },
      ],
      [{ processKey: "b", predecessorKey: "a" }],
    );
    await expect(
      publishVersion(actor(), { versionId: draft.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_INCOMPLETE });
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses a cycle and names its members", async () => {
    const draft = await draftFromPv();
    await writeGraph(
      draft.id,
      [
        { key: "a", seq: 1, code: "1", name: "A" },
        { key: "b", seq: 2, code: "2", name: "B" },
      ],
      [
        { processKey: "b", predecessorKey: "a" },
        { processKey: "a", predecessorKey: "b" },
      ],
    );
    await expect(
      publishVersion(actor(), { versionId: draft.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SCHEDULE_GRAPH_INVALID,
      detail: expect.objectContaining({ processCodes: expect.arrayContaining(["1", "2"]) }),
    });
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses a process unreachable from any root", async () => {
    const draft = await draftFromPv();
    // a → b is a clean chain; c and d form a closed loop nothing can enter.
    await writeGraph(
      draft.id,
      [
        { key: "a", seq: 1, code: "1", name: "A" },
        { key: "b", seq: 2, code: "2", name: "B" },
        { key: "c", seq: 3, code: "3", name: "C" },
        { key: "d", seq: 4, code: "4", name: "D" },
      ],
      [
        { processKey: "b", predecessorKey: "a" },
        { processKey: "d", predecessorKey: "c" },
        { processKey: "c", predecessorKey: "d" },
      ],
    );
    await expect(
      publishVersion(actor(), { versionId: draft.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SCHEDULE_GRAPH_INVALID });
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses publishing an already-PUBLISHED version (invariant #9)", async () => {
    const published = await prisma.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
    });
    await expect(
      publishVersion(actor(), { versionId: published.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_VERSION_LOCKED });
  });

  it("warns about provisional processes instead of blocking, and computes no envelope", async () => {
    const draft = await draftFromPv();
    await writeGraph(
      draft.id,
      [
        { key: "a", seq: 1, code: "1", name: "A" },
        { key: "b", seq: 2, code: "2", name: "B" },
      ],
      [{ processKey: "b", predecessorKey: "a" }],
    );
    const result = await publishVersion(actor(), {
      versionId: draft.id,
      notes: "provisional route, no lead-time document",
      acknowledgedWarnings: ["PROVISIONAL_DURATIONS", "EMPTY_WORK_ORDER_STAGES"],
      expectedEnvelopeDays: null,
    });
    expect(result.version.status).toBe("PUBLISHED");
    expect(result.warnings.map((w) => w.code)).toContain("PROVISIONAL_DURATIONS");
    expect(result.envelopeDays).toBeNull();
  });

  it("warns when the computed envelope contradicts the expected printed total (invariant #10)", async () => {
    const draft = await draftFromPv();
    const result = await publishVersion(actor(), {
      versionId: draft.id,
      notes: "envelope mismatch check",
      acknowledgedWarnings: ["MULTIPLE_TERMINALS", "ENVELOPE_MISMATCH"],
      expectedEnvelopeDays: 3, // nowhere near the real ~17-week envelope
    });
    expect(result.warnings.map((w) => w.code)).toContain("ENVELOPE_MISMATCH");
  });

  it("writes exactly one audit row per publish", async () => {
    const draft = await draftFromPv();
    const before = await prisma.auditLog.count({ where: { action: "template.publish" } });
    await publishVersion(actor(), {
      versionId: draft.id,
      notes: "audit test",
      acknowledgedWarnings: ["MULTIPLE_TERMINALS"],
      expectedEnvelopeDays: null,
    });
    expect(await prisma.auditLog.count({ where: { action: "template.publish" } })).toBe(before + 1);
  });
});
```

Add `publishVersion` to the imports.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:db`
Expected: FAIL — `publishVersion` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/services/template.service.ts`. Add to the imports:

```ts
import type { Tx } from "@/lib/db";
import { analyzeGraph, computeEnvelope, DEFAULT_CALENDAR, type ScheduleProcess, type ScheduleEdge } from "@/lib/schedule";
import { publishVersionSchema, type PublishVersionInput, type TemplateWarningCode } from "@/lib/shared/schemas";
import type { TemplateProcess, TemplateEdge } from "@/generated/prisma/client";
```

Then:

```ts
export interface TemplateWarning {
  code: TemplateWarningCode;
  message: string;
  /** TemplateProcess.code values this warning is about; empty when route-wide. */
  processCodes: string[];
}

export interface PublishResult {
  version: ProcessTemplateVersion;
  warnings: TemplateWarning[];
  /** Computed lead time in days, or null when the route is not schedulable. */
  envelopeDays: number | null;
}

/** TemplateProcess → the pure engine's shape. Mirrors _shared.ts's jobProcessToScheduleProcess. */
function templateProcessToScheduleProcess(p: TemplateProcess): ScheduleProcess {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    durationMinDays: p.durationMinDays,
    durationMaxDays: p.durationMaxDays,
    envelopeFinishByMinDays: p.envelopeFinishByMinDays,
    envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
    envelopeStartByMinDays: p.envelopeStartByMinDays,
    envelopeStartByMaxDays: p.envelopeStartByMaxDays,
    provisional: p.provisional,
  };
}

function templateEdgeToScheduleEdge(e: TemplateEdge): ScheduleEdge {
  return { processId: e.processId, predecessorId: e.predecessorId, type: e.type, lagDays: e.lagDays };
}

/**
 * Everything that decides whether a route may be published, split out so the
 * publish dialog can dry-run it without writing.
 *
 * Throws on a blocking failure; returns warnings otherwise. Each throw's
 * `detail.processCodes` names the offending processes so the UI can say
 * "Process 14 'PWHT' cannot be reached from the start of the route" rather
 * than "invalid graph" (invariant #12).
 */
export async function validateVersionForPublish(
  tx: Tx,
  versionId: number,
  expectedEnvelopeDays: number | null,
): Promise<{ warnings: TemplateWarning[]; envelopeDays: number | null }> {
  const processes = await tx.templateProcess.findMany({ where: { versionId }, orderBy: { seq: "asc" } });
  const edges = await tx.templateEdge.findMany({ where: { versionId } });

  if (processes.length === 0) {
    throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, {
      reason: "a route needs at least one process",
      processCodes: [],
    });
  }

  const codeById = new Map(processes.map((p) => [p.id, p.code]));
  const namesFor = (ids: number[]) => ids.map((i) => codeById.get(i)!).filter(Boolean);

  // Contiguous seq from 1. Duplicates are already refused at save time, so a
  // gap is the only way to get here.
  const seqs = processes.map((p) => p.seq).sort((a, b) => a - b);
  const gap = seqs.findIndex((s, i) => s !== i + 1);
  if (gap !== -1) {
    throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, {
      reason: "sequence numbers must run 1, 2, 3 … with no gaps",
      seq: seqs[gap],
      processCodes: [processes.find((p) => p.seq === seqs[gap])!.code],
    });
  }

  const diag = analyzeGraph(processes.map(templateProcessToScheduleProcess), edges.map(templateEdgeToScheduleEdge));

  if (diag.danglingEdges.length > 0 || diag.selfEdges.length > 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      reason: "an edge points at a process that is not part of this route, or at itself",
      processCodes: namesFor([
        ...diag.danglingEdges.map((e) => e.processId),
        ...diag.selfEdges.map((e) => e.processId),
      ]),
    });
  }
  if (diag.cycleNodeIds.length > 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      reason: "these processes form a loop, so none of them could ever start",
      processCodes: namesFor(diag.cycleNodeIds),
    });
  }
  if (diag.rootIds.length === 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      reason: "no process can start first — every process has a predecessor",
      processCodes: [],
    });
  }
  if (diag.unreachableIds.length > 0) {
    throw new AppError(ERROR_CODES.SCHEDULE_GRAPH_INVALID, {
      reason: "these processes cannot be reached from the start of the route and would never begin",
      processCodes: namesFor(diag.unreachableIds),
    });
  }

  const warnings: TemplateWarning[] = [];

  const provisional = processes.filter(
    (p) => p.provisional || p.durationMinDays == null || p.durationMaxDays == null,
  );
  if (provisional.length > 0) {
    warnings.push({
      code: "PROVISIONAL_DURATIONS",
      message:
        `${provisional.length} process${provisional.length === 1 ? "" : "es"} have no confirmed duration. ` +
        "This route can be published and will drive gating and progress, but dates cannot be computed " +
        "for any job that uses it until the durations are confirmed.",
      processCodes: provisional.map((p) => p.code),
    });
  }

  if (diag.terminalIds.length > 1) {
    warnings.push({
      code: "MULTIPLE_TERMINALS",
      message:
        `${diag.terminalIds.length} processes end without feeding another. That is normal for branches ` +
        "that genuinely finish on their own — check none of them is a wiring mistake.",
      processCodes: namesFor(diag.terminalIds),
    });
  }

  const noStages = processes.filter((p) => p.workOrderStages.length === 0);
  if (noStages.length > 0) {
    warnings.push({
      code: "EMPTY_WORK_ORDER_STAGES",
      message:
        `${noStages.length} process${noStages.length === 1 ? "" : "es"} are not mapped to a work-order stage. ` +
        "That is correct for families with no 25-stage reporting view.",
      processCodes: noStages.map((p) => p.code),
    });
  }

  // Envelope check (invariant #10). computeEnvelope refuses a provisional or
  // duration-less spine outright, so this only runs when nothing is
  // provisional — the two warnings never both fire.
  let envelopeDays: number | null = null;
  if (provisional.length === 0) {
    const anchor = new Date("2000-01-03T00:00:00.000Z"); // a Monday; only the span matters
    const dates = computeEnvelope(
      processes.map(templateProcessToScheduleProcess),
      anchor,
      DEFAULT_CALENDAR,
    );
    const latest = Math.max(...dates.map((d) => d.plannedFinishMax.getTime()));
    envelopeDays = Math.round((latest - anchor.getTime()) / 86_400_000);

    if (expectedEnvelopeDays != null) {
      const drift = Math.abs(envelopeDays - expectedEnvelopeDays);
      // 7 days: the printed lead-time table is rounded to whole weeks
      // (BUILD-SPEC-v2 §1), so anything inside a week is rounding, not error.
      if (drift > 7) {
        warnings.push({
          code: "ENVELOPE_MISMATCH",
          message:
            `This route computes to ${envelopeDays} days, but the expected lead time is ` +
            `${expectedEnvelopeDays} days — a gap of ${drift} days. Check the lags between processes: ` +
            "summing durations instead of overlapping concurrent work is the usual cause.",
          processCodes: [],
        });
      }
    }
  }

  return { warnings, envelopeDays };
}

/**
 * Validate a DRAFT and publish it. After this the version is immutable and
 * jobs may pin it (invariant #9).
 *
 * `acknowledgedWarnings` is not security — it is a receipt that the author was
 * shown what publishing this route means, particularly that a provisional
 * route will refuse to produce dates.
 */
export async function publishVersion(
  actor: Actor,
  input: PublishVersionInput,
): Promise<PublishResult> {
  const { versionId, notes, acknowledgedWarnings, expectedEnvelopeDays } =
    publishVersionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const version = await tx.processTemplateVersion.findFirst({
      where: { id: versionId, template: { tenantId: actor.tenantId } },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", versionId });
    }
    if (version.status !== "DRAFT") {
      throw new AppError(ERROR_CODES.TEMPLATE_VERSION_LOCKED, { versionId, status: version.status });
    }

    const { warnings, envelopeDays } = await validateVersionForPublish(tx, versionId, expectedEnvelopeDays);

    const unacknowledged = warnings.filter((w) => !acknowledgedWarnings.includes(w.code));
    if (unacknowledged.length > 0) {
      throw new AppError(ERROR_CODES.TEMPLATE_INCOMPLETE, {
        reason: "confirm the warnings before publishing",
        unacknowledgedWarnings: unacknowledged.map((w) => w.code),
        processCodes: [],
      });
    }

    return audited(tx, actor, async () => {
      const published = await tx.processTemplateVersion.update({
        where: { id: versionId },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(), // server clock, invariant #1
          publishedBy: actor.userId,
          notes,
        },
      });
      return {
        result: { version: published, warnings, envelopeDays },
        audit: {
          action: "template.publish",
          entityType: "ProcessTemplateVersion",
          entityId: versionId,
          before: { status: version.status },
          after: {
            status: "PUBLISHED",
            notes,
            envelopeDays,
            warnings: warnings.map((w) => w.code),
          },
          eventType: "ProcessTemplateVersionPublished",
          eventPayload: { versionId, templateId: version.templateId, envelopeDays },
        },
      };
    });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:db`
Expected: PASS. The first test — the real seeded route publishing cleanly with a three-terminal warning — is the load-bearing one. If it fails, the validator is stricter than DESPL's own process and the validator is wrong, not the route.

- [ ] **Step 5: Full suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/template.service.ts src/lib/services/template.service.test.ts
git commit -m "feat(services): add publishVersion with blocking checks and warnings"
```

---

### Task 9: Read layer — `template.read.ts`

**Files:**
- Create: `src/lib/services/template.read.ts`

**Interfaces:**
- Consumes: `Actor`
- Produces:
  - `interface TemplateVersionRow { id: number; version: number; status: "DRAFT" | "PUBLISHED"; publishedAt: string | null; publishedByName: string | null; notes: string | null; processCount: number; jobCount: number }`
  - `interface TemplateRow { id: number; name: string; versions: TemplateVersionRow[] }`
  - `interface FamilyRow { id: number; code: string; name: string; templates: TemplateRow[] }`
  - `loadTemplateIndex(actor: Actor): Promise<FamilyRow[]>`
  - `interface VersionEditorProcess { id: number; seq: number; code: string; name: string; mainActivities: string | null; defaultDepartmentId: number; departmentName: string; durationMinDays: number | null; durationMaxDays: number | null; envelopeStartByMinDays: number | null; envelopeStartByMaxDays: number | null; envelopeFinishByMinDays: number | null; envelopeFinishByMaxDays: number | null; workOrderStages: number[]; optional: boolean; provisional: boolean }`
  - `interface VersionEditorEdge { processId: number; predecessorId: number; type: "FINISH_TO_START" | "START_TO_START_WITH_OVERLAP"; lagDays: number }`
  - `interface VersionEditorView { versionId: number; templateId: number; templateName: string; familyName: string; version: number; status: "DRAFT" | "PUBLISHED"; notes: string | null; editable: boolean; updatedAt: string | null; supersededByVersion: number | null; processes: VersionEditorProcess[]; edges: VersionEditorEdge[]; departments: Array<{ id: number; name: string }> }`
  - `loadVersionEditor(actor: Actor, versionId: number): Promise<VersionEditorView>`

- [ ] **Step 1: Write the read module**

Create `src/lib/services/template.read.ts`:

```ts
import { withTenant } from "@/lib/db";
import { assertNotClientUser, ROLES, requireRole, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * Read models for the route-authoring screens. Dates are serialised to ISO
 * strings at the boundary so these can cross the RSC → client component line
 * without a Date instance in the payload, matching admin.read.ts.
 */

export interface TemplateVersionRow {
  id: number;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  publishedAt: string | null;
  publishedByName: string | null;
  notes: string | null;
  processCount: number;
  /** Jobs pinned to this version — what tells an admin whether it is load-bearing. */
  jobCount: number;
}

export interface TemplateRow {
  id: number;
  name: string;
  versions: TemplateVersionRow[];
}

export interface FamilyRow {
  id: number;
  code: string;
  name: string;
  templates: TemplateRow[];
}

export async function loadTemplateIndex(actor: Actor): Promise<FamilyRow[]> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const families = await tx.productFamily.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { name: "asc" },
      include: {
        templates: {
          orderBy: { name: "asc" },
          include: {
            versions: {
              orderBy: { version: "desc" },
              include: {
                _count: { select: { processes: true, jobs: true } },
              },
            },
          },
        },
      },
    });

    const publisherIds = [
      ...new Set(
        families.flatMap((f) =>
          f.templates.flatMap((t) => t.versions.map((v) => v.publishedBy).filter((x): x is number => x != null)),
        ),
      ),
    ];
    const publishers = publisherIds.length
      ? await tx.user.findMany({ where: { id: { in: publisherIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(publishers.map((u) => [u.id, u.name]));

    return families.map((f) => ({
      id: f.id,
      code: f.code,
      name: f.name,
      templates: f.templates.map((t) => ({
        id: t.id,
        name: t.name,
        versions: t.versions.map((v) => ({
          id: v.id,
          version: v.version,
          status: v.status as "DRAFT" | "PUBLISHED",
          publishedAt: v.publishedAt?.toISOString() ?? null,
          publishedByName: v.publishedBy != null ? (nameById.get(v.publishedBy) ?? null) : null,
          notes: v.notes,
          processCount: v._count.processes,
          jobCount: v._count.jobs,
        })),
      })),
    }));
  });
}

export interface VersionEditorProcess {
  id: number;
  seq: number;
  code: string;
  name: string;
  mainActivities: string | null;
  defaultDepartmentId: number;
  departmentName: string;
  durationMinDays: number | null;
  durationMaxDays: number | null;
  envelopeStartByMinDays: number | null;
  envelopeStartByMaxDays: number | null;
  envelopeFinishByMinDays: number | null;
  envelopeFinishByMaxDays: number | null;
  workOrderStages: number[];
  optional: boolean;
  provisional: boolean;
}

export interface VersionEditorEdge {
  processId: number;
  predecessorId: number;
  type: "FINISH_TO_START" | "START_TO_START_WITH_OVERLAP";
  lagDays: number;
}

export interface VersionEditorView {
  versionId: number;
  templateId: number;
  templateName: string;
  familyName: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  notes: string | null;
  /** DRAFT only — invariant #9. The service refuses regardless of this flag. */
  editable: boolean;
  /** Optimistic-lock token the editor must send back on save. */
  updatedAt: string | null;
  /** Set when a later version of the same template exists, for the read-only banner. */
  supersededByVersion: number | null;
  processes: VersionEditorProcess[];
  edges: VersionEditorEdge[];
  departments: Array<{ id: number; name: string }>;
}

export async function loadVersionEditor(actor: Actor, versionId: number): Promise<VersionEditorView> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const version = await tx.processTemplateVersion.findFirst({
      where: { id: versionId, template: { tenantId: actor.tenantId } },
      include: {
        template: { include: { family: true } },
        processes: { orderBy: { seq: "asc" }, include: { defaultDepartment: true } },
        edges: true,
      },
    });
    if (!version) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", versionId });
    }

    const later = await tx.processTemplateVersion.findFirst({
      where: { templateId: version.templateId, version: { gt: version.version } },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    const departments = await tx.department.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });

    return {
      versionId: version.id,
      templateId: version.templateId,
      templateName: version.template.name,
      familyName: version.template.family.name,
      version: version.version,
      status: version.status as "DRAFT" | "PUBLISHED",
      notes: version.notes,
      editable: version.status === "DRAFT",
      updatedAt: version.updatedAt?.toISOString() ?? null,
      supersededByVersion: later?.version ?? null,
      processes: version.processes.map((p) => ({
        id: p.id,
        seq: p.seq,
        code: p.code,
        name: p.name,
        mainActivities: p.mainActivities,
        defaultDepartmentId: p.defaultDepartmentId,
        departmentName: p.defaultDepartment.name,
        durationMinDays: p.durationMinDays,
        durationMaxDays: p.durationMaxDays,
        envelopeStartByMinDays: p.envelopeStartByMinDays,
        envelopeStartByMaxDays: p.envelopeStartByMaxDays,
        envelopeFinishByMinDays: p.envelopeFinishByMinDays,
        envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
        workOrderStages: p.workOrderStages,
        optional: p.optional,
        provisional: p.provisional,
      })),
      edges: version.edges.map((e) => ({
        processId: e.processId,
        predecessorId: e.predecessorId,
        type: e.type as VersionEditorEdge["type"],
        lagDays: e.lagDays,
      })),
      departments,
    };
  });
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. If `_count: { select: { jobs: true } }` errors, confirm the relation name on `ProcessTemplateVersion` in `schema.prisma` — it is `jobs`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/services/template.read.ts
git commit -m "feat(services): add template.read for route authoring screens"
```

---

### Task 10: Server actions

**Files:**
- Create: `src/app/actions/template.ts`

**Interfaces:**
- Consumes: the four service functions, `toActionError`/`ActionResult` from `./_action`
- Produces: `createTemplateAction`, `cloneVersionAction`, `saveDraftVersionAction`, `publishVersionAction`

- [ ] **Step 1: Write the actions**

Create `src/app/actions/template.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import {
  createTemplate,
  cloneVersion,
  saveDraftVersion,
  publishVersion,
  type TemplateWarning,
} from "@/lib/services/template.service";
import { toActionError, type ActionResult } from "./_action";
import type {
  CreateTemplateInput,
  CloneVersionInput,
  SaveDraftVersionInput,
  PublishVersionInput,
} from "@/lib/shared/schemas";

export type CreateVersionResult = ActionResult & { versionId?: number };

export async function createTemplateAction(input: CreateTemplateInput): Promise<CreateVersionResult> {
  try {
    const v = await createTemplate(await requireActor(), input);
    revalidatePath("/admin/templates");
    return { ok: true, versionId: v.id };
  } catch (e) {
    return toActionError(e);
  }
}

export async function cloneVersionAction(input: CloneVersionInput): Promise<CreateVersionResult> {
  try {
    const v = await cloneVersion(await requireActor(), input);
    revalidatePath("/admin/templates");
    return { ok: true, versionId: v.id };
  } catch (e) {
    return toActionError(e);
  }
}

/** The refusal detail matters here — the editor prints which process is at fault. */
export type SaveDraftResult = ActionResult & { updatedAt?: string; detail?: Record<string, unknown> };

export async function saveDraftVersionAction(input: SaveDraftVersionInput): Promise<SaveDraftResult> {
  try {
    const v = await saveDraftVersion(await requireActor(), input);
    revalidatePath(`/admin/templates/${input.versionId}`);
    return { ok: true, updatedAt: v.updatedAt?.toISOString() };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && e && typeof e === "object" && "detail" in e) {
      return { ...result, detail: (e as { detail?: Record<string, unknown> }).detail };
    }
    return result;
  }
}

export type PublishResultAction = ActionResult & {
  warnings?: TemplateWarning[];
  envelopeDays?: number | null;
  detail?: Record<string, unknown>;
};

export async function publishVersionAction(input: PublishVersionInput): Promise<PublishResultAction> {
  try {
    const r = await publishVersion(await requireActor(), input);
    revalidatePath("/admin/templates");
    revalidatePath(`/admin/templates/${input.versionId}`);
    return { ok: true, warnings: r.warnings, envelopeDays: r.envelopeDays };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && e && typeof e === "object" && "detail" in e) {
      return { ...result, detail: (e as { detail?: Record<string, unknown> }).detail };
    }
    return result;
  }
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/actions/template.ts
git commit -m "feat(actions): add route authoring server actions"
```

---

### Task 11: `/admin/templates` index screen

**Files:**
- Create: `src/app/(app)/admin/templates/page.tsx`
- Create: `src/app/(app)/admin/templates/_client.tsx`
- Modify: `src/app/(app)/admin/page.tsx` (add the nav link)

**Interfaces:**
- Consumes: `loadTemplateIndex` (Task 9), `cloneVersionAction` / `createTemplateAction` (Task 10)
- Produces: the route `/admin/templates`

- [ ] **Step 1: Read the existing admin screen for conventions**

Read `src/app/(app)/admin/page.tsx` and `src/app/(app)/admin/_client.tsx` in full before writing. Match their card/table markup, their `page-h` header pattern, and how they wire a server component to a client component. Do not invent a new layout idiom.

- [ ] **Step 2: Write the server component**

Create `src/app/(app)/admin/templates/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadTemplateIndex } from "@/lib/services/template.read";
import { TemplateIndexClient } from "./_client";

export default async function TemplatesPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/dashboard");

  const families = await loadTemplateIndex(actor);
  return <TemplateIndexClient families={families} />;
}
```

- [ ] **Step 3: Write the client component**

Create `src/app/(app)/admin/templates/_client.tsx`. Requirements, all mandatory per `DESIGN_SPEC.md`:

- One group per product family, family name as a section header (11px, 600, uppercase, tracked, `--muted`).
- Columns: Template · Version (mono) · Status · Processes (mono, right-aligned) · Jobs using (mono, right-aligned) · Published · By · Actions.
- Status renders as `<StatusChip />` — reuse the existing component from `src/components/industrial/`. `PUBLISHED` → `--s-complete`, `DRAFT` → `--s-idle`. Never plain grey text.
- Row actions: **Open** (link to `/admin/templates/[versionId]`), **Clone to new draft** (calls `cloneVersionAction` with `sourceVersionId` and a `notes` prompt, then routes to the new draft), **Clone to another family** (dialog: target family select + name + notes).
- A family with no template renders an empty state row: "No process route defined for {family}." plus a **Clone one from another family** action. One sentence, one action — never a bare "coming soon".
- A version with `jobCount > 0` shows the count in `--accent`; it is the signal that the version is load-bearing and must not be casually superseded.
- Every action shows a sonner toast on success and prints `message` from the `ActionResult` on failure.
- Loading skeleton matching the final table layout; no full-page spinner.

- [ ] **Step 4: Add the nav link**

In `src/app/(app)/admin/page.tsx`, add a link to `/admin/templates` labelled "Process routes", visible only when `hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)`.

- [ ] **Step 5: Verify in the running app**

Run: `pnpm dev`, then log in through the real `/login` form as an admin and open `/admin/templates`.

**Never** construct a session token by hand, and never read `AUTH_SECRET` — see the "Agent conduct" section of `CLAUDE.md`. If browser automation is unavailable, say so and report verification as incomplete rather than reaching for a credential shortcut.

Confirm: four families listed; `PRESSURE_VESSEL` shows its published v1 with 36 processes and a non-zero job count; `HEAT_EXCHANGER` and `PIPING_SYSTEM` show the empty state; `PIPE_SPOOL` shows its DRAFT. Click **Clone to new draft** on the PV version and confirm a v2 DRAFT appears.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/admin/templates" "src/app/(app)/admin/page.tsx"
git commit -m "feat(admin): add process routes index screen"
```

---

### Task 12: `/admin/templates/[versionId]` editor and publish dialog

**Files:**
- Create: `src/app/(app)/admin/templates/[versionId]/page.tsx`
- Create: `src/app/(app)/admin/templates/[versionId]/_client.tsx`

**Interfaces:**
- Consumes: `loadVersionEditor` (Task 9), `saveDraftVersionAction` / `publishVersionAction` (Task 10)
- Produces: the route `/admin/templates/[versionId]`

- [ ] **Step 1: Write the server component**

```tsx
import { redirect, notFound } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { loadVersionEditor } from "@/lib/services/template.read";
import { isAppError } from "@/lib/shared/errors";
import { VersionEditorClient } from "./_client";

export default async function VersionEditorPage({ params }: { params: Promise<{ versionId: string }> }) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) redirect("/dashboard");

  const versionId = Number((await params).versionId);
  if (!Number.isInteger(versionId) || versionId <= 0) notFound();

  try {
    const view = await loadVersionEditor(actor, versionId);
    return <VersionEditorClient view={view} />;
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
}
```

- [ ] **Step 2: Write the editor client component**

Create `src/app/(app)/admin/templates/[versionId]/_client.tsx`. Requirements:

**Header:** family · template name · `v{version}` (mono) · `<StatusChip />` · Save draft · Publish. When `editable === false`, no Save and no Publish, plus a note: "Version {n} is published and cannot be changed." and, when `supersededByVersion` is set, "Superseded by version {supersededByVersion}."

**Processes table** — 36 rows, so density matters. Columns: seq (with up/down reorder, renumbering contiguously) · code · name · main activities · department (`<select>` from `view.departments`) · duration min · duration max · envelope start-by min/max · envelope finish-by min/max · work-order stages · optional · provisional · delete. All numeric cells JetBrains Mono with `tabular-nums`. An **Add process** row at the bottom.

**New rows default to `provisional: true` with null durations** (spec §8). Un-ticking `provisional` while either duration is empty is blocked client-side with the message "Enter both durations before marking this process confirmed." The server refuses it too — this is a courtesy, not the enforcement.

**Edges table** — process (`<select>`) · predecessor (`<select>`) · type (`<select>`, humanised: "Finish to start" / "Start to start, overlapping") · lag days. Help text under the lag column: "Negative lag means this process may start before its predecessor finishes. It changes the schedule only — it never lets a process complete out of order." Add/remove rows.

**Save** is explicit, never autosave. It sends `expectedUpdatedAt` from `view.updatedAt` and, on success, replaces the held token with the returned one. On `STALE_WRITE`, show the error message and a **Reload** button — do not silently retry.

**Publish dialog:** a mandatory `notes` textarea, placeholder "Where did this route's data come from? e.g. DESPL Lead Time.pdf, 11 Aug 2026". An optional "Expected lead time (days)" number input feeding `expectedEnvelopeDays`. On submit, call `publishVersionAction` with `acknowledgedWarnings: []` first: a `TEMPLATE_INCOMPLETE` refusal listing `unacknowledgedWarnings` is the expected path, and the dialog then renders each warning with a checkbox and re-submits with the ticked codes. A blocking `SCHEDULE_GRAPH_INVALID` / `TEMPLATE_INCOMPLETE` failure renders `message` plus the `detail.processCodes` list, disabling the publish button until the draft is fixed.

Humanise everything: never render `FINISH_TO_START`, `PRODUCTION_HEAD` or a table name in the UI.

- [ ] **Step 3: Verify in the running app**

Run: `pnpm dev`, log in through `/login` as an admin (real form, never a hand-built session), open the v2 DRAFT cloned in Task 11.

Walk each case and confirm the message names the offending process:
1. Save an edit; reload; the edit persisted.
2. Open the same draft in a second tab, save in tab A, then save in tab B → the stale-write message and a Reload button.
3. Add an edge making a loop → Publish is refused naming both processes.
4. Delete an edge so a process is unreachable → refused naming that process.
5. Un-tick `provisional` on a row with no duration → blocked before submit.
6. Publish the unmodified clone → succeeds after ticking the multiple-terminals warning; the index shows v2 as `PUBLISHED`.

- [ ] **Step 4: Confirm the hard bans**

Check and state explicitly which you verified: no browser-default serif · no raw enums in the UI · status never rendered as plain text · no dead controls · no mock data in components · no `localStorage` · visible keyboard focus · reduced-motion respected · loading skeleton present · empty state present · error state present.

- [ ] **Step 5: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:db && pnpm build`
Expected: all PASS. Paste the actual output — do not claim completion without it.

- [ ] **Step 6: Acceptance pass (spec §9 step 8)**

The end-to-end proof the whole feature exists for:

1. Clone the published `PRESSURE_VESSEL` route into `HEAT_EXCHANGER` ("Clone to another family").
2. Edit it down to a plausible heat-exchanger sequence, leaving every process `provisional: true`.
3. Publish, acknowledging the provisional warning.
4. Confirm the version appears as `PUBLISHED` under Heat Exchangers on the index.
5. Confirm the honest failure mode: a job pinned to this route must refuse to schedule with `SCHEDULE_DATA_MISSING` and a clear message, never a guessed date. Until the job-intake wizard exists there is no UI to create that job, so verify at the service level instead — in a `tsx` scratch script against the **test** database (never `despl_demo`), create a minimal job pinned to the new version and call `generateSchedule`, asserting the thrown code. Delete the scratch script afterwards; it is not part of the deliverable.

- [ ] **Step 7: Update progress and commit**

Update `progress.md` with what shipped, decisions made, and next steps. Then sync the vault at `/Users/sonusingh/SWAYAM OS/4_Projects/Client Work/DESPL/DESPL TRACKER/` — `CURRENT_STATUS.md`, `TASKS.md`, `CHANGELOG.md` — and run `python3 "/Users/sonusingh/SWAYAM OS/7_Systems/Automation/link_vault.py"` only if doc files were added or renamed.

```bash
git add "src/app/(app)/admin/templates" progress.md
git commit -m "feat(admin): add process route version editor and publish dialog"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 `updatedAt` column | 1 |
| §3 `lib/schedule/validate.ts` | 3 |
| §3 reuse of `copyVersionContents` | 4 |
| §4.1 `createTemplate` | 6 |
| §4.2 `cloneVersion` (same-template and cross-family) | 6 |
| §4.3 `saveDraftVersion`, full replace, key mapping, thin validation, optimistic lock | 5 (schema), 7 |
| §4.4 `publishVersion`, blocking checks, warnings, acknowledgement | 5 (schema), 8 |
| §4.5 new error codes | 2 |
| §5 read layer | 9 |
| §6.1 index screen | 11 |
| §6.2 editor + publish dialog | 12 |
| §6.3 admin nav entry | 11 |
| §7 tests — RBAC, versioning, publish validation, warnings, audit, concurrency | 6, 7, 8 |
| §8 provisional-by-default risk mitigations | 5 (zod cross-check), 12 (UI defaults + block) |
| §9 acceptance pass | 12 |

`loadDepartments` from §5 was folded into `loadVersionEditor` rather than made a separate export — the editor is its only consumer and `departments.read.ts` already serves every other caller.

**Placeholder scan:** no "TBD", no "add appropriate error handling", no "similar to Task N". Tasks 11 and 12 specify UI requirements as an explicit checklist rather than full JSX, because the components must match `admin/_client.tsx`'s existing markup, which the implementer is instructed to read first — the alternative is inventing a second layout idiom in a codebase that already has one.

**Type consistency checked:**
- `analyzeGraph` returns `GraphDiagnostics` with exactly the six fields Task 8 consumes (`danglingEdges`, `selfEdges`, `cycleNodeIds`, `rootIds`, `terminalIds`, `unreachableIds`).
- `copyVersionContents(tx, sourceVersionId, targetVersionId, overrideByProcessId?)` — the signature in Task 4 matches both call sites (Task 4's `updateStandardDurations` rewrite, Task 6's `cloneVersion`).
- `AppError`'s context field is `detail`, singular, everywhere — matching `src/lib/shared/errors.ts`. The spec's earlier `details` phrasing was corrected.
- `TemplateWarning.code` is `TemplateWarningCode`, the union from `TEMPLATE_WARNING_CODES` in Task 5, and the same four literals are used in Task 8's warnings and Task 12's dialog.
- `saveDraftVersion` returns `ProcessTemplateVersion`, whose `updatedAt` is `Date | null`; the action serialises it to `string | undefined` and the editor holds it as `string | null` — the boundary conversion is explicit in Task 10.
- `publishVersion` returns `PublishResult`, not a bare version — Task 10's action and Task 12's dialog both consume `warnings` and `envelopeDays`.
