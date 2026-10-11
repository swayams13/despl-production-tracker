# SESSION 06 — AUD-090 · One bad spine 500s the entire Command Center

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/15_FAILURE_MODES.md` §6, `audit/20_REMEDIATION_ROADMAP.md` Phase 1a item 6.*
*Independent of every other session. One-line production fix.*

---

## PASTE FROM HERE

You are a Staff Engineer working on **DESPL Production Tracker** (Next.js 15 +
Prisma 6 + PostgreSQL 16). Single-purpose session: stop one job's bad data
from taking down a shared cross-department screen.

### Read before writing anything

1. `audit/15_FAILURE_MODES.md` §6 — the finding.
2. `src/lib/services/command-center.read.ts` — find the current line via
   `grep -n "computeCpm(" src/lib/services/command-center.read.ts` (it was
   line 261 at last check; re-confirm, don't trust that number blindly).
3. `src/lib/services/myday.read.ts` around its own `computeCpmSafe` call
   (`grep -n "computeCpmSafe" src/lib/services/myday.read.ts`) — this is the
   reference implementation, written for exactly this reason.
4. `src/lib/schedule`'s `computeCpm` vs `computeCpmSafe` exports — confirm
   `computeCpmSafe`'s actual signature/return type (it returns `null` on
   failure rather than throwing — confirm this before assuming the shape).

### The defect

```ts
// command-center.read.ts — inside `for (const job of jobs)`
const cpm = computeCpm(spine.processes, spine.edges);
```

`computeCpm` throws on a cycle or a missing duration. This call sits inside a
loop over **every job the Command Center aggregates across every department**
— procurement, design, planning, QA/QC, stores, dispatch all read this one
screen. One malformed spine (a bad template edit, a partial exclusion, any of
the several ways this audit found a job's graph can end up cyclic or
duration-less) throws out of the loop and 500s the whole page for every
department simultaneously, with no indication which job was at fault.

`myday.read.ts`'s identical loop already uses the safe variant:

```ts
const cpm = computeCpmSafe(spine.processes, spine.edges);
if (!cpm) continue;
```

with the comment: *"A batch omission … or a malformed spine … on ANY one job
must not 500 My Day for the whole tenant."* The exact same reasoning applies
to the Command Center — more so, since it's shared across six departments
instead of one person's worklist.

### Your task

Swap `computeCpm` for `computeCpmSafe` at the Command Center call site, and add
the same `if (!cpm) continue;` guard, matching `myday.read.ts`'s pattern
exactly. Do not add a warning banner, a logged error, or anything beyond what
`myday.read.ts` already does for this exact situation — match the existing
pattern, don't invent a richer one only for this call site.

### Details that matter

- **Confirm what "skip" means for a job with no CPM.** In `myday.read.ts`,
  `continue` presumably means that job's items simply don't contribute
  critical-path/float data to the worklist, while everything else about it
  (overdue counts, hold points, etc., which don't depend on CPM) still
  renders normally. Check `command-center.read.ts`'s surrounding loop body to
  confirm the same is true there before assuming `continue` is safe — if CPM
  output feeds something later in the *same* loop iteration that other code
  depends on unconditionally, skipping it might need to zero out or
  short-circuit more than the audit's one-line fix implies. Read the whole
  loop body, not just this one line.
- **Do not fix the underlying cause of a cyclic/duration-less spine.** That's
  a data-quality/template-authoring problem tracked elsewhere in this audit.
  This session only stops it from taking the whole screen down — it does not
  make the affected job's Command Center data complete or correct.

### Constraints — these are binding

- One file, one call site. Do not touch `myday.read.ts`,
  `workspace.read.ts`, `loadJobKpis`, or anything else that already uses
  `computeCpmSafe`/`computeOrRefuse` correctly.
- No schema change, no migration.

### Tests

Check whether `command-center.read.ts` has a test file
(`command-center.read.test.ts` or similar). If it does, follow its existing
fixture style and add: a tenant with one normal job and one job whose
`JobProcessEdge`s form a cycle (or whose `JobProcess.durationMax` is null on a
node CPM needs) — confirm `loadCommandCenter`-or-whatever-the-exported-function-
is-called returns the normal job's data intact and simply omits the bad job's
CPM-derived fields, rather than throwing. If no test file exists for this
service yet, add a minimal one covering just this case — don't build broader
coverage than this fix needs.

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test
pnpm test:db   # if your new test is DB-gated
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.**
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-090** closed with the PR
   reference.

### Explicitly out of scope for this session

Any other raw `computeCpm` call site you find outside `command-center.read.ts`
— note it in the LEDGER entry; `loadPrioritizedJob`, `loadWorkspaceView`, and
`loadJobKpis` are already confirmed correct (`computeOrRefuse`) per the audit,
so don't re-check those, but a new, previously-unaudited call site is worth
flagging rather than silently fixing here.

## PASTE TO HERE
