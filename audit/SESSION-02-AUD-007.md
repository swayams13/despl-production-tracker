# SESSION 02 — AUD-007 · Dashboard drill-downs drop the project; `/workspace` guesses one

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/06_DASHBOARD_AUDIT.md` §4, `audit/20_REMEDIATION_ROADMAP.md` Phase 1a item 4.*
*Prerequisite: none. Independent of Session 01 (AUD-005) and Session 03 (AUD-002) — can run before, after, or in parallel with either.*

---

## PASTE FROM HERE

You are a Staff Full-Stack Engineer working on **DESPL Production Tracker**, a
Next.js 15 + Prisma 6 + PostgreSQL 16 manufacturing execution system for a
pressure-vessel fabricator. This is a single, tightly-scoped session closing one
P0 defect from a recent enterprise audit.

### Read before writing anything

1. `CLAUDE.md` — the project guide.
2. `audit/06_DASHBOARD_AUDIT.md` §4 — the finding you are fixing.
3. `src/app/(app)/dashboard/page.tsx` — read the whole file once, but pay close
   attention to lines ~108–129 (the `Dashboard` function's job-resolution logic)
   and the `JobSelector` component (~line 58). **This file already contains the
   correct pattern** — you are propagating it, not inventing it.
4. `src/app/(app)/dashboard/_portfolio.tsx` — the `Row` component.
5. `src/app/(app)/workspace/page.tsx` — the file with the actual defect.
6. `src/lib/services/jobs.read.ts` — read `loadJobs`'s doc comment and signature.
   You will call it, not modify it.

### The defect, in two parts

**Part A — `/workspace` cannot be trusted from a link.** `pilotJobId` at the top
of `workspace/page.tsx` falls back to a hardcoded job number:

```ts
async function pilotJobId(tenantId: number): Promise<number | null> {
  return withTenant(tenantId, async (tx) => {
    const j = await tx.job.findFirst({ where: { jobNumber: "DESPL-320" }, select: { id: true } });
    return j?.id ?? null;
  });
}
```

`/workspace` already reads an explicit `?job=` param correctly (`jobParam` a few
lines below) — the bug is only what happens when that param is **absent**: it
silently substitutes one specific customer's job for whichever project the
viewer actually meant, with no indication anything was substituted.

**Part B — every dashboard drill-down omits `job=`, so Part A's fallback always
fires.** Seven links across two files carry `dept=`/`status=` but never `job=`:

```tsx
// dashboard/page.tsx
<MetricCard label="On track" value={onTrack} href="/workspace" ... />                                    // :203
href="/workspace?status=overdue"                                                                          // :208
<Link key={r.planId} href={`/workspace?dept=${r.departmentId}`} className="cp-row">                       // :271
<Link href="/workspace" className="btn btn-ghost">Open in workspace →</Link>                              // :281
href={`/workspace?dept=${row.departmentId}&status=${STATUS_FILTER[s]}`}                                   // :309
<Link href={`/workspace?dept=${d.departmentId}&status=overdue`} className="age-row" ...>                  // :399

// _portfolio.tsx
<Link href="/workspace?status=overdue" className="mono" ...>                                              // :238
```

**Re-grep before you edit** — these line numbers are from the audit pass and
this file has had other commits since; confirm current line numbers with
`grep -n 'href=.*workspace' src/app/\(app\)/dashboard/page.tsx src/app/\(app\)/dashboard/_portfolio.tsx`
before touching anything.

The MD looks at DE0467's "7 overdue" tile, clicks it, and lands on a different
project's overdue list — with no visual sign the project changed. This is the
single most likely way a wrong operational decision gets made from this
product.

### Your task

**1 — Delete the hardcoded fallback. Do not replace it with a different guess.**

The whole point of this finding is that *silently picking a project* is the
bug, not which project gets picked. Do not swap `"DESPL-320"` for
`portfolio.rows[0]` or "most recently active" or any other implicit default —
that reproduces the same failure mode with different symptoms.

Instead, when `/workspace` has no valid `?job=`, show an explicit picker and
stop there — same shape as the empty-state pattern already used lower in this
same file (`if (!view) { ... }`):

```tsx
if (!jobId) {
  const jobs = await loadJobs(actor); // already tenant/client scoped — see jobs.read.ts
  return (
    <>
      <div className="page-h"><h1>My Workspace</h1></div>
      {jobs.length === 0 ? (
        <p className="note">No projects exist yet.</p>
      ) : (
        <>
          <p className="note">Select a project to see its worklist.</p>
          <nav className="sub" style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Select project">
            {jobs.map((j) => (
              <Link key={j.id} href={`/workspace?job=${j.id}`} className="chip c-idle">
                <i />{j.jobNumber}
              </Link>
            ))}
          </nav>
        </>
      )}
    </>
  );
}
```

(The `chip`/`nav` markup mirrors `dashboard/page.tsx`'s own `JobSelector` —
reuse that visual language, don't invent a new one.) Delete `pilotJobId`
entirely and the `await pilotJobId(actor.tenantId)` call site; `jobId` becomes
simply `Number.isInteger(jobParam) && jobParam > 0 ? jobParam : null`.

Leave the *other* empty-state below (`if (!view) { ... }`, the "No current
schedule for this job" message) exactly as it is — that is a different
condition (a real, resolved job with no generated schedule yet) and is not
part of this finding. Its "run the demo bootstrap" copy is a separate, already
tracked issue (`18_DESIGN_SYSTEM.md` §6) — do not touch it in this session.

**2 — Propagate `job=` through all seven links.**

In `dashboard/page.tsx`, a `jobId` variable is already in scope at the point
these links render (`const jobId = selected?.id ?? null;`, ~line 129) — the
exact same variable `JobSelector` already uses. Add `job={jobId}` /
`` `job=${jobId}` `` to each of the six links in that file. `MetricCard`'s
`href` prop is a plain string, so build it the same way the `status=overdue`
ones already do:

```tsx
<MetricCard label="On track" value={onTrack} href={`/workspace?job=${jobId}`} sub="not currently overdue" />
<MetricCard ... href={`/workspace?job=${jobId}&status=overdue`} ... />
<Link key={r.planId} href={`/workspace?job=${jobId}&dept=${r.departmentId}`} className="cp-row">
<Link href={`/workspace?job=${jobId}`} className="btn btn-ghost">Open in workspace →</Link>
href={`/workspace?job=${jobId}&dept=${row.departmentId}&status=${STATUS_FILTER[s]}`}
<Link href={`/workspace?job=${jobId}&dept=${d.departmentId}&status=overdue`} className="age-row" ...>
```

In `_portfolio.tsx`'s `Row` component, the job id is `r.id` (same field the
adjacent `<Link href={`/jobs/${r.id}`}>` on the same row already uses):

```tsx
<Link href={`/workspace?job=${r.id}&status=overdue`} className="mono" ...>
```

`jobId` in `dashboard/page.tsx` can legitimately be `null` (empty portfolio) —
guard it: only render these as working links when `jobId != null`, otherwise
fall through to whatever each site already does for the zero-data case (most
already conditionally render on a nonzero count, so check each site rather
than assuming).

### Details that matter

- **`/workspace`'s own internal links must also carry `job=`.** Once inside a
  resolved workspace view, any dept/status filter chips or sort controls that
  link back to `/workspace` with different query params must preserve the
  current `job=` — check `FilterChip`/`SortSelect` in `./_client.tsx` and the
  page's own filter UI. If they already build on `sp` (the parsed
  `searchParams`) rather than hardcoding a path, they may already be fine;
  verify rather than assume, since this is exactly the class of bug you are
  fixing.
- **Do not build the "one global, URL-consistent project-context selector
  reused across every surface"** described in `03_INFORMATION_ARCHITECTURE.md`
  — that is a real, larger piece of work (a shared component, likely a layout
  concern) tracked separately. This session only stops the silent
  wrong-project substitution and makes the seven known links honest. Do not
  scope-creep into building that shared selector here.
- **`loadJobs(actor)` is already permission-correct** — it filters to the
  actor's own client when `actor.clientId != null`, and `/workspace` already
  redirects client users to `/portal` earlier in the same function, so by the
  time you call it you know you're calling it for a staff actor. Do not add
  your own filtering on top.

### Constraints — these are binding

- **No schema change, no migration.** This is pure routing/UI plumbing.
- **Do not touch** `loadWorkspaceView`, `loadJobs`, `loadPortfolio`, or any
  read-service file — the defect is entirely in how these two pages *link*,
  not in what they load.
- **Do not modify** the `if (!view)` empty-state branch in `workspace/page.tsx`
  (see above) or anything in `dashboard/_sunburst-data.ts` /
  `_sunburst-data.test.ts`.
- Keep the existing `first()` helper and searchParams-parsing style in both
  files — do not introduce a different param-parsing convention.

### Tests

Neither `workspace/page.tsx` nor `dashboard/page.tsx` has a `page.test.ts` in
this codebase (they're Server Components — this project doesn't unit-test
these two directly; `dashboard/_portfolio.test.ts` only covers the pure
`SLUG`/`healthFromSlug` helpers, which this change doesn't touch). Do not
invent a new test-rendering setup just for this session.

Instead, verify live, the same way this project's own session log
(`docs/mos-execution/LEDGER.md`) verifies UI-only changes — a real `/login`,
not a forged session:

1. Log in as a MANAGEMENT or PRODUCTION_HEAD user.
2. On `/dashboard`, note the selected project's job number in the header.
3. Click each of the seven links (or as many as have live data — some only
   render when their count is nonzero) and confirm the URL now carries
   `job=<id>` matching that same project, and that `/workspace` shows that
   project's job number in its own header, not a different one.
4. Switch projects via `JobSelector`, repeat step 3, confirm the links now
   carry the new project's id.
5. Visit `/workspace` directly with no query string at all — confirm you see
   the picker from Part A's fix, not a silent default, and that clicking a
   project chip lands you on that project's worklist.
6. Visit `/workspace?job=999999` (a job id that doesn't exist) — confirm this
   does not crash; `loadWorkspaceView` should already handle a job that
   resolves to no schedule via the existing `if (!view)` branch. If it throws
   instead, that's a related but separate finding — note it in the LEDGER
   entry, do not fix it in this session.

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test
```

Then confirm:

- `git diff --stat` touches only `workspace/page.tsx`, `dashboard/page.tsx`,
  `dashboard/_portfolio.tsx`, and nothing in `prisma/`.
- `grep -n 'DESPL-320'` in `src/` returns nothing.
- `grep -n 'href=.*workspace' src/app/(app)/dashboard/page.tsx src/app/(app)/dashboard/_portfolio.tsx`
  shows `job=` on every result.

### When you are done

1. Open a PR. **Do not merge to `main` directly** — `main` auto-deploys to
   Railway. Describe the live click-through you did (step-by-step from
   "Tests" above) in the PR description, since there's no automated test to
   point to instead.
2. Append an entry to `docs/mos-execution/LEDGER.md` in that file's existing
   format.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-007** closed with the PR
   reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-011 / AUD-012 | The two disjoint nav arrays; nav not role-filtered |
| AUD-015 / AUD-016 | Dashboard is ~15% portfolio-grain; no "Needs Attention" exception queue |
| Global project-context selector (`03_INFORMATION_ARCHITECTURE.md`) | A shared, cross-surface selector component — this session is a local fix to two files, not that component |
| The "demo bootstrap" copy in `workspace/page.tsx`'s other empty state | `18_DESIGN_SYSTEM.md` §6 |

If you find something genuinely new that is not on that list, write it down in
the LEDGER entry rather than fixing it here.

## PASTE TO HERE
