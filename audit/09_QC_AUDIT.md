# 09 — QC & HOLD POINTS AUDIT

*The hold-point engine is why this product is more than a spreadsheet. This
document covers the QC surface; the four defects that puncture the engine itself
are in `10_BUSINESS_LOGIC.md` §2 and are the most serious findings in this audit.*

---

## 1. AUD-018 (P0) — the cockpit is three unbounded flat lists

Four separate defects in one read model:

**No `LIMIT` on the verification queue** (`qc-cockpit.read.ts:103-117`):
```sql
WHERE pp.status = 'SUBMITTED' AND sr.is_current = true
ORDER BY submitted_at ASC NULLS LAST
```
…where `submitted_at` is itself a **correlated subquery evaluated per row**
(`SELECT max(de.at) FROM domain_events …`).

**No job filter on hold points** (`:133-147`):
`tx.qcpItem.findMany({ where: { partyCodes: { some: { qcpCode: { blocksCompletion: true } } } } })`
— every blocking checkpoint in the tenant.

**Every execution attempt ever** (`:151-156`), loaded into JS to pick the latest
per `(item, unit)`.

**A quadratic loop** (`:172-180`): `plans.filter(...)` **inside** the loop over
blocking items — O(items × plans).

Hold points are **not sorted server-side** — the sort happens in the browser on
every render. `openNcrs` is unbounded and ordered by **primary key**
(`orderBy: { id: "asc" }`) — oldest NCR *id* first, not most urgent. Only
`rejectsByCheckpoint` is capped.

### Volume on real data

DE0463 is 40 units. Its QCP template has 54 checkpoints, of which **4 carry the
DESPL `H` code** (`blocksCompletion: true`).

| List | Rows on DE0463 alone | Cross-job |
|---|---|---|
| Hold points | 4 × 40 = **160** | DE0467 stacks on top |
| Verification queue | 36 processes × 40 units = 1,440 plans; at 10% submitted ≈ **144** | ✓ |
| Open NCRs | unbounded | ✓ |

**A QC engineer opens `/qc` and faces ~300 rows in three flat lists with no way
to say "show me DE0463, Unit SR07" or "show me only Awaiting TPI".** There is no
filter, no search, no pagination, and no grouping control anywhere in the client.

The domain has an obvious hierarchy — **project → unit → process → inspection** —
and it is expressed nowhere. The one thing that must never wait, an aged `H` hold
blocking dispatch, is visually identical to a `Pending` row 200 lines down.

`loadQcCockpit(actor)` takes **no filter arguments at all**. Its header comment
frames it as *"the first genuinely cross-job aggregate"* — and cross-job was
implemented as "no WHERE clause".

---

## 2. AUD-037 (P1) — the cockpit has no role gate

The complete page:

```tsx
export default async function QcCockpit() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  const cockpit = await loadQcCockpit(actor);
  return <QcCockpitClient cockpit={cockpit} />;
}
```

No `hasRole`. `loadQcCockpit` issues raw tenant-wide SQL with no role or
department predicate — `grep "hasRole\|ROLES\." qc-cockpit.read.ts` returns
nothing. And `/qc` is in **both** nav lists, so every authenticated staff user
has a menu entry to it.

The page renders NCR disposition and hold-point clearance controls. The mutations
themselves **are** server-gated (`assertMakerChecker`), so this is disclosure plus
dead controls, not privilege escalation.

**Impact:** every fitter and storekeeper sees every open NCR, the first-pass-yield
trend, and rejects-by-checkpoint across the whole company. **NCRs name the person
who caused the rejection.** That is a labour-relations problem before it is a
security one.

**Fix:** `if (!hasRole(actor, QC, PRODUCTION_HEAD, MANAGEMENT, ADMIN))
redirect("/my-day")`, and drop `/qc` from nav outside that set. A supervisor's
*own department's* hold points belong on `/team`, not here.

---

## 3. AUD-041 (P1) — the same queue on four surfaces, three status ladders

| Surface | Scope | Bound | Sort |
|---|---|---|---|
| `/qc` "Open hold points" | all jobs | **unbounded** | age desc, **client-side** |
| `/dashboard` "Open hold points — QCP/ITP" | one job | top 5 | age desc, server |
| `/dashboard` portfolio "Holds" column | per job | count only | — |
| `/jobs` "Open holds" column | per job | count only | — |

Three separate implementations of the latest-attempt-wins status ladder:
`loadOpenHoldPoints` (`workspace.read.ts`), `loadQcCockpit`'s inline loop, and
`loadQcpGrid`'s. The cockpit's own comment acknowledges it: *"same
blocking/latest-attempt logic as loadOpenHoldPoints in workspace.read.ts,
generalised off one job."* Three more re-derivations exist in the read layer, for
six in total.

**Three near-identical ladders will drift, and the counts on `/dashboard`,
`/jobs` and `/qc` will disagree.** This is precisely the failure `job-health.ts`
was written to prevent for health classification — the same discipline was not
applied to hold points.

**Fix.** `/qc` owns hold points. Extract one
`resolveHoldPointStatus(attempt, requiresCall, plannedStart, now)` used by every
call site. Elsewhere show a count that deep-links to `/qc?job=…`. Delete the
dashboard's top-5 card once the exception queue exists.

---

## 4. Performance — AUD-056, AUD-057

**AUD-056 (P1)** — the weekly yield trend applies a function to the indexed
column *inside a join condition*:

```sql
LEFT JOIN domain_events de
  ON de.aggregate_type = 'ProcessPlan'
  AND date_trunc('week', de.at)::date = w.week_start
  AND de.type IN ('ProcessSubmitted', 'ProcessRejected')
```

Not sargable, no expression index exists, and **there is no lower bound on `at`
anywhere in the query** — so the join evaluates `date_trunc` for every row in the
table to discover that 2024 rows do not match one of six week buckets.

`/qc` — the cockpit a QC engineer keeps open all day — degrades linearly with
total history and never recovers, to display six weeks.

**Fix.** Restructure as a bounded aggregate:
```sql
SELECT date_trunc('week', at) AS wk, count(*) FILTER (…)
FROM domain_events
WHERE aggregate_type = 'ProcessPlan' AND type IN (…) AND at >= now() - interval '6 weeks'
GROUP BY 1
```
then left-join the generated week series. With `@@index([tenantId, type, at])`
already present, this becomes an index range scan.

**AUD-057 (P1)** — the four unbounded reads and the quadratic loop from §1.
Fixes: materialise `submitted_at` via a pre-aggregated derived table instead of a
correlated subquery and add `LIMIT 200` with a "showing oldest 200" affordance;
scope hold points to ACTIVE jobs and paginate; replace the executions load with
`DISTINCT ON (qcp_item_id, unit_id) … ORDER BY qcp_item_id, unit_id, attempt_no DESC`
— the existing `@@unique([qcpItemId, unitId, attemptNo])` index serves this
directly; replace `plans.filter` with a `Map<jobProcessId, plans[]>` built once;
put a rolling window on `closedReworkNcrs`.

---

## 5. Column classification

### "Awaiting your verification" — 6 columns

| Column | Class |
|---|---|
| Job | **ESSENTIAL** |
| Unit | **ESSENTIAL** |
| Process | **ESSENTIAL** |
| Department | SECONDARY → drawer |
| Submitted by | SECONDARY → drawer |
| When | **ESSENTIAL** — express as *waiting-since age*, not a timestamp |

**Reduced set (4):** Job · Unit · Process · Waiting-since age. Plus filters and
pagination.

### "Open hold points" — 5 cells

| Cell | Class |
|---|---|
| srNo | SECONDARY |
| Class (P/W/H) | **ESSENTIAL** |
| Activity + job + unit | **ESSENTIAL** |
| Status | **ESSENTIAL** |
| Record button | **ESSENTIAL** |
| **Age in days** | **ESSENTIAL — MISSING.** `ageDays` is computed and used only for the client-side sort; it is never displayed |
| **Blocking Y/N** | **ESSENTIAL — MISSING** |

---

## 6. Proposed QC specification

Route `/qc`. Gated to QC, PRODUCTION_HEAD, MANAGEMENT (read-only), ADMIN.

**Signature change:** `loadQcCockpit(actor, { jobId?, unitId?, status?, page })`.

DOM order — **hold-point-first**, inverting today's layout which leads with the
unbounded verification table:

| # | Section | Content |
|---|---|---|
| 0 | **Filter bar** | Project · Unit · Party (DESPL / Buyer TPI / EIL TPIA) · Class (H/W/R&A/P) · Status. URL-driven, so it is linkable |
| 1 | **Blocking holds, aged** | Sorted **server-side**: blocking class first (`H` > `R&A` > `W`), then `ageDays` desc. Row shows class, activity, job, unit, **age**, party, and the record action |
| 2 | **Awaiting my verification** | Paginated 200, oldest first, with waiting-since age. Maker shown |
| 3 | **Rejected / rework** | Open NCRs sorted by age, not by id. With disposition state — see AUD-026 |
| 4 | **Upcoming inspections** | Checkpoints on processes starting in the next N working days — the "call given / call attended" workflow that `requiresCall` implies and nothing renders |
| 5 | **Documentation pending** | MTC / NDT records outstanding against completed operations |
| 6 | **Trends** — collapsed | First-pass yield 6wk · rejects by checkpoint. Both keep; fix the 9px week labels |

**Grouping.** Collapse sections 1–3 into `project → unit` accordion groups with
counts, expanding to inspections. That is the domain's own hierarchy and it makes
160 hold-point rows into ~2 projects × 40 units, scannable.

---

## 7. Per-job QC — the missing complement

`/jobs/[id]?tab=qcp` is per-unit only, so auditing 40 units is 40 page loads
(AUD-051, `07_PROJECT_AUDIT.md` §5). Add the **checkpoint × unit matrix** using
the already-built, currently-dead `viz/MatrixHeatmap`.

Also: **there is no per-job NCR view.** NCRs exist only on the tenant-wide
cockpit. `/jobs/[id]?tab=qc` should carry this job's NCRs alongside the QCP grid.

---

## 8. Where the real damage is

The surface problems above are fixable in a phase. The engine problems are not
cosmetic and are documented in `10_BUSINESS_LOGIC.md`:

| | Finding |
|---|---|
| **AUD-003 (P0)** | Any QC user clears a blocking hold point by recording `NA`. The waiver columns exist in the schema and have **zero references in `src/`** |
| **AUD-004 (P0)** | Verifying an internal assembly step auto-stamps `ACCEPTED` on the linked checkpoint **without reading its party codes** — so a third-party inspector's hold point is cleared by a DESPL employee, with `clearedByPartyRef` null |
| **AUD-005 (P0)** | `approveDispatchRelease` and `recordDispatch` re-check nothing. A unit that fails PAUT after batching still ships |
| **AUD-026 (P1)** | Re-verifying a reworked operation auto-closes its NCR straight from `OPEN`, so `disposition`, `dispositionedBy` and `dispositionNotes` are all null on the manufacturing record |
| **AUD-077 (P2)** | `recordQcpExecution` never checks the checkpoint belongs to the unit's job |

**A QC surface that is fast and beautifully organised, sitting on an engine where
a hold point can be cleared with one click by the wrong person, is worse than
useless — it is convincing.** Fix the engine first; the roadmap sequences it that
way.
