# SESSION 12 — AUD-033 · Excluding a non-optional template process is never refused

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/07_PROJECT_AUDIT.md` §9, `audit/20_REMEDIATION_ROADMAP.md` Phase 1b item 12.*
*Independent of every other session in this batch.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes a P1 finding: job
intake lets a user permanently drop HYDROTEST, RADIOGRAPHY, or FINAL
INSPECTION from a job's scope with no refusal and no record of why.

### Read before writing anything

1. `audit/07_PROJECT_AUDIT.md` §9 (AUD-033).
2. `src/lib/services/job-intake.service.ts` — the whole `createJob` function
   (or whatever it's actually named — confirm with
   `grep -n "export async function" src/lib/services/job-intake.service.ts`),
   paying attention to the `templateCodes`/`unknownExclusions` block
   (`grep -n "unknownExclusions\|excludedProcessCodes" src/lib/services/job-intake.service.ts`)
   and the `JobProcess.createMany` call that sets `included: !excluded.has(tp.code)`.
3. `prisma/schema.prisma` — `model TemplateProcess`, specifically the
   `optional` field (`@default(false)`) and its own doc comment: *"Conditional
   processes (e.g. PWHT) can be excluded per job."* — the schema already
   states the intended rule; the service just never enforces it.
4. `src/lib/shared/schemas.ts` — `createJobSchema`
   (`grep -n "createJobSchema" src/lib/shared/schemas.ts`), specifically
   `excludedProcessCodes: z.array(z.string()...)`.
5. `audit/13_API_AUDIT.md` line ~168 — this error code was already anticipated:
   `PROCESS_NOT_OPTIONAL | AUD-033 — excluding a non-optional template process`.
   Use that exact name.

### The defect

```ts
// job-intake.service.ts — the only validation on excludedProcessCodes today
const templateCodes = new Set(version.processes.map((p) => p.code));
const unknownExclusions = parsed.excludedProcessCodes.filter((c) => !templateCodes.has(c));
if (unknownExclusions.length > 0) {
  throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "TemplateProcess", processCodes: unknownExclusions });
}
...
const excluded = new Set(parsed.excludedProcessCodes);
await tx.jobProcess.createMany({
  data: version.processes.map((tp) => ({
    ...
    included: !excluded.has(tp.code),
  })),
});
```

This only checks that an excluded code *exists* in the template — never
whether `TemplateProcess.optional` is `true` for it. `grep optional src/`
shows only `RouteStep.optional` is ever read anywhere in the codebase;
`TemplateProcess.optional` is written at template-authoring time and then
never consulted again. An intake user can exclude **any** process, including
ones the template author marked mandatory.

A process excluded this way gets no `ProcessPlan` — nothing to gate, nothing
to verify, no hold point can ever attach to it. Combined with AUD-030 (a
separate, already-tracked view defect — do not fix it here), the only visible
symptom today is a spine stage that sits grey forever, indistinguishable from
"not started yet."

### Your task

**1 — Refuse the exclusion.** Before the existing `jobProcess.createMany`
call (right after the `unknownExclusions` check, which stays exactly as it
is), add:

```ts
const nonOptionalExclusions = version.processes
  .filter((tp) => parsed.excludedProcessCodes.includes(tp.code) && !tp.optional)
  .map((tp) => tp.code);
if (nonOptionalExclusions.length > 0) {
  throw new AppError(ERROR_CODES.PROCESS_NOT_OPTIONAL, { processCodes: nonOptionalExclusions });
}
```

Add `PROCESS_NOT_OPTIONAL` to `errors.ts` (`ERROR_CODES`, `ERROR_MESSAGES`,
and the HTTP mapping in `src/app/api/_lib.ts` — 409), following the existing
doc-comment style.

**2 — Record why, for the exclusions that are legitimately allowed.** A
permanent scope change deserves a reason on record, per the audit's own fix
recommendation. Since there is no existing schema field for this and adding
one is arguably a separate decision, use the mechanism this codebase already
has for exactly this purpose — the transaction's own audit event:

Add an optional field to `createJobSchema`:

```ts
/** Free-text reason for each optional process excluded — required when excludedProcessCodes is non-empty. */
exclusionReason: z.string().trim().min(1).nullable().default(null),
```

In the service, when `parsed.excludedProcessCodes.length > 0`, require
`parsed.exclusionReason` to be present (reuse the existing
`OVERRIDE_REASON_REQUIRED` code if its semantics genuinely fit — "a mandatory
reason wasn't given for a scope-changing action" — or confirm it's specific to
duration overrides and a new code is more honest; check its existing usages
before deciding). Include the reason and the excluded codes in this action's
own `audited(...)` call as part of `after`/`eventPayload` — this job's
creation event already carries structured context; add the exclusion reason
to it rather than inventing a second write.

If you decide a fully queryable, reportable "why was this excluded" needs its
own persisted column (not just an audit-event payload) for real operational
use, say so explicitly in your PR as a follow-up recommendation — don't
silently add a migration for it in what the roadmap scoped as an "S"
complexity session.

### Details that matter

- **Test with a real optional process, not just a hypothetical one.** Find
  which of DESPL-320's real template processes are actually marked
  `optional: true` in the seed data
  (`grep -n "optional" seed/*.json prisma/seed.ts`) — your tests should
  exercise a real optional exclusion (should succeed) and a real non-optional
  one like PWHT/HYDROTEST/RADIOGRAPHY (should refuse), not synthetic template
  rows that might not reflect how `optional` is actually seeded today.
- **`unknownExclusions` and `nonOptionalExclusions` are independent checks** —
  an excluded code that doesn't exist in the template at all should still hit
  `NOT_FOUND` first (unchanged), and only a code that *does* exist but isn't
  optional should hit the new `PROCESS_NOT_OPTIONAL` refusal. Keep them as two
  separate checks in that order, not merged into one.
- **Do not touch `RouteStep.optional`** — it's a different field on a
  different model, already correctly read elsewhere; this session is
  entirely about `TemplateProcess.optional`.

### Constraints — these are binding

- **No schema migration** unless you conclude in your PR that one is genuinely
  needed for reason-tracking (see above) — the default expectation for this
  session is audit-event-only reason capture, no new column.
- **Do not modify** `TemplateProcess.optional`'s existing values, any seed
  file's exclusion data, or `lib/schedule/exclude.ts`'s `bypassExcluded` logic
  (referenced in the file's own comment about splicing excluded nodes out of
  the graph) — that logic is unaffected by this fix and stays exactly as is.

### Tests

Add to `job-intake.service.test.ts` (check it exists; DB-gated, following its
existing fixture pattern):

| # | Scenario | Expect |
|---|---|---|
| 1 | Create a job excluding a real `optional: true` template process, with a reason supplied | succeeds; that `JobProcess.included` is `false`; the audit event's payload carries the exclusion reason |
| 2 | Same, but no `exclusionReason` supplied | refused (whichever code you settled on) |
| 3 | Create a job excluding a real `optional: false` process (PWHT/HYDROTEST/whichever exists in seed data) | refused, `PROCESS_NOT_OPTIONAL`, naming that code; **no** `Job` or `JobProcess` rows created — confirm the whole transaction rolled back, not a partial job |
| 4 | Create a job excluding a code that doesn't exist in the chosen template version at all | unchanged — refused `NOT_FOUND`, same as today |
| 5 | Create a job with no exclusions at all | unaffected — no reason required, succeeds exactly as before |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Note your reasoning on
   whether reason-tracking needs a real column eventually.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-033** closed with the PR
   reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-030 | The view's separate `included` handling defect — a different session |
| AUD-065 | Job intake's placeholder-only form labels — an accessibility finding, different file family |

## PASTE TO HERE
