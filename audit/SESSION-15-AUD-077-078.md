# SESSION 15 — AUD-077 + AUD-078 · QCP templates aren't tenant-anchored; execution never checks job match

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/12_SECURITY_RBAC.md` §6, `audit/11_DATABASE_AUDIT.md` §5.3 (AUD-069, related),
`audit/20_REMEDIATION_ROADMAP.md` Phase 1c items 17-18.*
*Two findings bundled — same subsystem (QCP), same session, because #78's fix
depends on the same code path #77 hardens. Do #77 first.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes two related P1
multi-tenancy/isolation gaps in the QCP (Quality Control Plan) subsystem:
templates aren't reliably tenant-scoped, and recording an execution never
confirms the QCP item actually belongs to the unit's own job.

### Read before writing anything

1. `CLAUDE.md` — the RLS invariants (`tenant_isolation` fail-closed,
   `job_isolation` fail-open by design) and the maker-checker invariant.
2. `audit/12_SECURITY_RBAC.md` §6 ("AUD-078 / AUD-077 — QCP library rows have
   no tenant anchor") — both findings' full writeup is here, in one section.
3. `audit/11_DATABASE_AUDIT.md` §5.3 (AUD-069) — the four `SET NULL` FKs off
   `jobs` that compound this gap (`qcp_templates.job_id`, `qcp_items.job_id`,
   `inspection_parties.job_id`, `qcp_item_party_codes.job_id` all promote to
   "shared library, cross-tenant readable" on job delete). Not this session's
   fix target, but explains why the tenant anchor matters even after this
   session ships — a future job deletion still needs AUD-069's own fix (a
   later, undelivered session) to fully close the loop.
4. `prisma/schema.prisma` — `model QcpTemplate` (confirm it still has **no**
   `tenantId` field — `grep -n "tenantId" prisma/schema.prisma` around the
   `QcpTemplate` block), `model QcpItem`, `model QcpExecution`,
   `model Job` (its `tenantId` field), `model Unit` (its `jobId` field).
5. `src/lib/services/qcp.service.ts` — `recordQcpExecution` in full
   (`grep -n "export async function recordQcpExecution" -A 70 src/lib/services/qcp.service.ts`).
   Confirm `qcpItemId` is taken as given and never checked against
   `unit.jobId` anywhere in this function.
6. Find how `QcpTemplate` is currently scoped in queries today:
   `grep -rn "qcpTemplate\." src/lib/services/*.ts` — look specifically for
   the `OR: [{ job: { tenantId } }, { jobId: null }]` shape the audit
   describes (confirm the exact current shape; it may have shifted since the
   audit was written — quote what you actually find in your PR).
7. `src/lib/services/batch.service.ts`'s `addUnitToBatch` — find its
   cross-entity ownership check (`grep -n "addUnitToBatch" -A 30 src/lib/services/batch.service.ts`)
   and its use of a `CROSS_JOB_ASSIGNMENT`-style error, if that's the actual
   existing code name — confirm the exact error code name before reusing it
   in #78's fix below (it may differ from what this prompt guesses).
8. `docs/mos-execution/MERGE-RUNBOOK.md` for the migration/backfill
   discipline — this session includes a genuine backfill, treat it with the
   same care as any production data migration.

### AUD-077 — QcpTemplate isn't reliably tenant-scoped

**The defect.** `QcpTemplate` has no `tenantId` column. Every query that
needs to scope it does so indirectly — `OR: [{ job: { tenantId } }, { jobId:
null }]` (or whatever the current live shape is, confirmed in step 6 above) —
meaning a global/shared template (`jobId: null`) is visible to **every**
tenant with no filter at all, and a per-job template's tenant-scoping is only
as reliable as every call site remembering to join through `job.tenantId`
correctly. This is exactly the fail-open shape `job_isolation` policies are
allowed to have by design — but tenant isolation is supposed to be
fail-closed, and this pattern makes tenant leakage possible for any global
template row, and for any call site that forgets the `OR` join.

**Your task.**

1. **Migration:** add `tenantId Int` (nullable initially, for the backfill
   step) to `QcpTemplate`, with the same `@relation` shape used by other
   tenant-scoped models in this schema (check `model Job` or a comparable
   model for the existing convention — foreign key name, `onDelete`
   behavior).
2. **Backfill**, in the same migration, as a preflight-checked data
   migration per `MERGE-RUNBOOK.md`:

```sql
UPDATE qcp_templates qt
SET tenant_id = j.tenant_id
FROM jobs j
WHERE qt.job_id = j.id AND qt.tenant_id IS NULL;
```

   For any `QcpTemplate` row with `job_id IS NULL` (a genuinely global
   template with no owning job) — **check whether any such rows exist in
   real data first**:

```sql
SELECT count(*) FROM qcp_templates WHERE job_id IS NULL;
```

   If any exist, this is a real product question this session cannot resolve
   unilaterally: does a "global" QCP template mean shared across all
   tenants (in which case `tenantId` must stay nullable and every scoping
   query must treat `NULL` as "visible to all, read-only, never
   tenant-filtered out" — a deliberate exception, not an oversight) or does
   it mean it belongs to whichever tenant authored it (in which case it needs
   a real `tenantId` backfilled from wherever template *authorship* is
   recorded, not from a job). **Stop and flag this explicitly in your PR
   with the actual row count and a couple of example rows** rather than
   guessing; if the count is zero, this is moot and you can proceed straight
   to step 3.
3. Once backfilled (and once the global-template question above is resolved
   for whatever your findings actually show), make `tenantId` `NOT NULL`
   **only if** step 2 confirmed no genuinely-global rows exist; otherwise
   leave it nullable and encode the "NULL = global, always visible" rule
   explicitly in every query changed in step 4, with a comment.
4. **Enroll `qcp_templates` in a fail-closed `tenant_isolation` RLS policy**,
   matching the shape of this codebase's other `tenant_isolation` policies
   (find one — `grep -rn "tenant_isolation" prisma/migrations/*/migration.sql`
   — and copy its exact structure, likely something like `USING (tenant_id =
   NULLIF(current_setting('app.tenant_id', true), '')::int)`, extended with
   `OR tenant_id IS NULL` only if step 2/3 confirmed real global rows exist).
5. **Replace every application-level `OR: [{ job: { tenantId } }, { jobId:
   null }]`-shaped clause** you found in step 6 above with a direct `{
   tenantId: actor.tenantId }` filter (or, if nullable global rows are real,
   `{ OR: [{ tenantId: actor.tenantId }, { tenantId: null }] }` — but now
   reading the template's own column, not joining through `job`).

### AUD-078 — `recordQcpExecution` never validates the item belongs to the unit's job

**The defect.** `recordQcpExecution(tx, actor, { qcpItemId, unitId, ... })`
takes `qcpItemId` as given and records an execution against it with no check
that the `QcpItem` (via its `QcpTemplate`/whatever chain actually links item
→ job) is even for the same job as `unitId`'s own `Unit.jobId`. Two units on
different jobs could, in principle (confirm this is genuinely reachable —
check what actually constrains `qcpItemId` at the API/action layer today; if
there's already a narrower gate you missed, say so), have their inspection
records cross-contaminated.

**Your task.** In `recordQcpExecution`, before creating the `QcpExecution`
row, add a job-match check following the exact pattern `addUnitToBatch`
already uses (per step 7 above — use its real error code name, not a
guessed one):

```ts
const unit = await tx.unit.findUniqueOrThrow({ where: { id: unitId }, select: { jobId: true } });
const qcpItem = await tx.qcpItem.findUniqueOrThrow({
  where: { id: qcpItemId },
  select: { /* whatever field(s) actually link a QcpItem back to its job — trace this chain exactly, don't assume a direct jobId column exists on QcpItem itself */ },
});
// derive qcpItem's owning jobId via whatever the real chain is (QcpItem -> QcpTemplate -> jobId, or similar)
if (qcpItemJobId !== unit.jobId) {
  throw new AppError(ERROR_CODES.CROSS_JOB_ASSIGNMENT /* or whatever addUnitToBatch's real code is named */, { qcpItemId, unitId });
}
```

Trace the actual `QcpItem` → job relationship in the schema before writing
this — do not assume a shape; `QcpItem` may link to a job directly, or only
via its `QcpTemplate`, or via a `QcpCodeRef`. Read `model QcpItem` fully and
write the query that matches its real foreign keys.

### Details that matter

- **Do #77 before #78** — once `QcpTemplate.tenantId` exists and RLS
  enforces it, a cross-tenant `qcpItemId` is already unreachable for a
  correctly-scoped actor; #78's job-match check is specifically about
  **same-tenant, different-job** contamination, which #77 alone doesn't
  prevent.
- **`QcpTemplate` may be referenced by other services beyond the ones you
  found in step 6** — re-run the grep after your fix to confirm zero
  remaining `OR: [{ job: { tenantId }` patterns anywhere in `src/`.
- **This session's migration includes a real backfill against potentially
  real data** — do not skip the row-count check in AUD-077 step 2; a global
  template row that gets a wrong `tenantId` backfilled would make an
  existing legitimate cross-job template invisible to the tenants that
  currently use it, which is a regression far worse than the isolation gap
  you're fixing.

### Constraints — these are binding

- **Every check stays transactional** where it already is — `recordQcpExecution`
  runs inside a transaction today; your new check joins that same transaction,
  not a separate query outside it.
- **RLS policy must be fail-closed** for `tenant_isolation`, matching this
  codebase's existing convention exactly — do not invent a new policy shape.
- **Do not modify** `recordQcpExecutionTx`'s waiver logic (Session 04/AUD-003's
  fix, if it has landed) or anything in `assembly.service.ts`/`component.service.ts`
  that calls into this function — this session's #78 fix is entirely inside
  `qcp.service.ts`'s `recordQcpExecution`.
- Follow `MERGE-RUNBOOK.md`'s rehearsal procedure for the migration —
  this one has a real backfill, rehearse it against a production-like copy
  first.

### Tests

Add to `qcp.service.test.ts` (check it exists; DB-gated, following its
existing fixture pattern):

| # | Scenario | Expect |
|---|---|---|
| 1 | Query `QcpTemplate` scoped to tenant A while authenticated as tenant B | tenant B sees nothing belonging to tenant A — proves RLS, not just the application filter |
| 2 | A genuinely global template (if step 2's row count was non-zero and you kept `tenantId` nullable) | still visible to every tenant, per whatever rule you encoded |
| 3 | `recordQcpExecution` called with a `qcpItemId` whose owning job matches `unitId`'s job | succeeds, unchanged from today |
| 4 | `recordQcpExecution` called with a `qcpItemId` whose owning job does **not** match `unitId`'s job (construct this fixture deliberately — two jobs, two templates) | refused, `CROSS_JOB_ASSIGNMENT` (or the real matching code name), no `QcpExecution` row created |
| 5 | Backfill migration itself, against a fixture DB with mixed `job_id`-present and (if applicable) `job_id NULL` `QcpTemplate` rows | every non-null-job row gets the correct `tenant_id`; null-job rows handled per your step-2 resolution, not silently dropped or wrongly assigned |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
npx prisma migrate diff --exit-code
```

Then re-run: `grep -rn "OR: \[{ job: { tenantId" src/` — should return zero
matches.

### When you are done

1. Open a PR. **Do not merge to `main` directly.** State explicitly: the
   real row count found for `job_id IS NULL` templates, which resolution you
   took (nullable-and-fail-open-by-design vs. NOT NULL), and the actual
   `QcpItem`→job relationship chain you traced for #78.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-077** and **AUD-078**
   both closed with the PR reference — unless the global-template question
   in AUD-077 step 2 turned up real rows needing a product decision, in
   which case mark AUD-077 "blocked on product decision" with the row count
   and example rows noted, and close only AUD-078.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-003, AUD-004, AUD-026 | Other hold-point-engine findings — different code paths (Sessions 04, 09, 10) |
| `QcpTemplate` authoring/versioning UI | Unaffected by this session — only the query-scoping and cross-job-check layers change |

## PASTE TO HERE
