# 04 — MY DAY AUDIT

*The default operational surface for an individual. It must answer one question:
"What do I need to do?"*

---

## 1. AUD-008 (P0) — My Day is a department board wearing a personal title

There is **no Prisma `where` scoping this surface to the user**. The source rows
come from `_shared.ts:429-432`:

```ts
const runs = await tx.scheduleRun.findMany({
  where: { jobId: { in: jobIds }, equipmentId: equipmentId ?? null, isCurrent: true },
  include: { processPlans: true },     // ← ALL plans, no assignee predicate
});
```

The partition happens in memory, `myday.read.ts:246-273`:

```ts
if (assignee === actor.userId) {
  mine.push(toRow(r));
} else if (actor.departmentIds.includes(r.plan.ownerDepartmentId)) {
  if (assignee == null) pool.push(toRow(r));      // ← unassigned dept work
  else teamHeld.push(toRow(r));                   // ← other employees' work
} else if (isQcActor && r.state === "SUBMITTED") {
  teamHeld.push(toRow(r));                        // ← other DEPARTMENTS' work
}
```

Both extra boards render as **permanent, always-visible sections, for every
role** — `_client.tsx:1053` (*"Department pool — always visible"*) and `:1106`
("Held by teammates"). The file's own comment states the intent: *"Mine and
Department pool are both always-visible sections… selecting it doesn't change
what Mine shows."*

The only assignee-scoped `where` on the entire surface is the `clearedToday`
counter — a header number, not the board.

**This is a faithful implementation of SPEC §7.2, which specified pool and
teammate visibility on the personal dashboard.** The specification mixed two
distinct jobs-to-be-done. The fix is to split the spec, not to blame the code.

---

## 2. AUD-009 (P0) — the pool is uncapped, and every plan is born in it

`_client.tsx:1080` — `{filteredPool.map((r) => <PoolRowView … />)}`. No `.slice()`,
no page size, no virtualisation. (Compare `command/[dept]/_client.tsx:198`, which
*does* cap at 6.)

The volume is provable from the schedule generator. `schedule.service.ts:138-150`
creates one plan per (process × unit) with **no `assigneeUserId` in `PlanInput`**,
and `schema.prisma:1083` documents `NULL = unassigned, sits in the department
pool`. **Every plan is born in the pool.**

| Job | Units | FABRICATION processes | Pool rows on one personal dashboard |
|---|---|---|---|
| DESPL-320 (pilot) | 9 | 8 | **72** |
| DE0463 (live) | 40 | 8 | **320** |

Every one of those is a `<tr>` on the individual's dashboard. The one mitigation
shipped — `ProjectFilter` — filters only by job number and only renders when more
than one project is present, so on a single-job tenant it filters 320 rows to 320.

---

## 3. AUD-045 (P1) — every row is rendered three times into the DOM

Two nested CSS-only breakpoint swaps, both of which render *both* branches:

```css
/* globals.css:695-700 */
.day-queue { display: block; }  .day-standard { display: none; }
@media (min-width: 640px) { .day-queue { display: none; } .day-standard { display: block; } }

/* globals.css:674-679 */
.rt-table { display: none; }  .rt-cards { display: flex; }
@media (min-width: 1024px) { .rt-table { display: block; } .rt-cards { display: none; } }
```

`ResponsiveTable` renders `{table}` **and** `{cards}` unconditionally;
`MyDayClient` renders `.day-queue` **and** `.day-standard`. So each `mine` row is
instantiated three times, each a stateful client component running
`useState`×3 + `useTransition`.

At the 320-row pool volume that is **~960 hydrated component instances and ~3,800
hooks** for one section nobody can see two-thirds of — on exactly the low-powered
shop-floor tablets the product targets.

The CSS-swap primitive itself is the *right* call and its reasoning is documented
(a JS/`matchMedia` toggle would hydration-mismatch and flash). The defect is
nesting two of them on the largest list in the app.

---

## 4. Current vs required structure

| # | Required section | Exists? | What is there instead | Evidence |
|---|---|---|---|---|
| 1 | Greeting / context | Partial | `Hi {name} · {role} · {departments} · {date} · cleared today: {n}` — identity, not workload | `page.tsx:59-64` |
| 2 | **Assigned workload summary** | **No** | Four 28px KPI tiles of **30-day historical performance**. The counts exist but only as `(n)` inside tab labels *below* the tiles | `_client.tsx:940-965`, `:841-848`, `:970` |
| 3 | NEEDS ATTENTION | ✅ | "Needs attention" tab = `ranked.overdue`; default for non-QC | `_client.tsx:59, 790, 854` |
| 4 | TODAY | ✅ | "Due today" tab = `isToday(plannedFinish)` in IST | `_client.tsx:62, 39-42` |
| 5 | UPCOMING | Partial | "Up next" tab — **silently absorbs BLOCKED**; no forward-load view | `_client.tsx:63` |
| 6 | Personal progress | ✅ but mis-placed | The four KPI tiles *are* the progress section — rendered **first**, at the top, at 28px | `_client.tsx:940-965` |
| — | **Blocked assigned work** | **No** | Filed into "Up next"; only signal is 11px muted "Blocked" text in the action column | `_client.tsx:58-64, 162` |
| — | Approvals assigned to me | ✅ (QC only) | "With QC" tab, first for QC actors | `_client.tsx:816-824` |
| — | **Relevant dependencies** | **No** | `reasonText` ("Waiting on: X, Y.") is computed for every blocked plan and rendered **only on teammates' rows** | `prioritizer.ts:99-102`, `_client.tsx:550` |
| — | ❌ Department pool | **Present** | Always-visible, uncapped | `_client.tsx:1053-1103` |
| — | ❌ Other employees' work | **Present** | "Held by teammates", collapsible, defaults closed | `_client.tsx:1106-1143` |
| — | ❌ Unassigned work | **Present** | Same pool; on mobile a flat unbounded queue | `_client.tsx:930-937` |
| — | ❌ Other departments' work | Present for QC | QC actors receive cross-department SUBMITTED rows | `myday.read.ts:263-270` |

---

## 5. AUD-042 (P1) — the page answers "how have I been doing?" before "what do I need to do?"

The first large numbers a user sees are **On-time · 30d**, **Done this week**,
**Cycle vs standard**, **First-pass rejects · 30d** — a personal performance
review at 28px. Their actual workload is in 13px tab labels underneath.

The numbers needed for the required summary line are already computed
(`_client.tsx:841-848`) and merely rendered in the wrong place and at the wrong
weight.

---

## 6. AUD-043 (P1) — blocked work has no home, and the answer is already computed

```ts
// _client.tsx:58-64
function mineBucket(row: MyDayRow) {
  if (row.ranked.overdue) return "attention";
  if (row.ranked.state === "ON_HOLD") return "hold";
  if (row.ranked.state === "SUBMITTED") return "qc";
  if (isToday(row.ranked.plan.plannedFinish)) return "due";
  return "upnext";                              // ← BLOCKED and READY, identical
}
```

Meanwhile the prioritiser computes exactly what is needed and it is thrown away:

```ts
// prioritizer.ts:99-102
state = "BLOCKED"; reasonCode = "BLOCKED";
blockingIds = blockingPredecessorIds;
reasonText = `Waiting on: ${names.join(", ")}.`;
```

A user's blocked item sits in "Up next" indistinguishable from a startable one.
They click Start, get a gate refusal, and only then learn what they are waiting
on. Adding a BLOCKED branch and rendering `reasonText` as the row subtitle
satisfies **both** the "blocked assigned work" and "relevant dependencies"
requirements in one change.

---

## 7. AUD-036 (P1) — the badge labelled "my overdue" counts the department

```ts
// workspace.read.ts:989-1001
export async function loadMyOverdueCount(actor: Actor): Promise<number> {
  const scoped = !hasRole(actor, ADMIN, PRODUCTION_HEAD, MANAGEMENT);
  return tx.processPlan.count({ where: {
    status: { not: "COMPLETE" },
    plannedFinish: { lt: istCalendarDayMarker() },
    scheduleRun: { isCurrent: true },
    ...(scoped ? { ownerDepartmentId: { in: actor.departmentIds } } : {}),  // ← DEPARTMENT
  }});
}
```

No `assigneeUserId`. For PH/ADMIN/MANAGEMENT the filter is dropped entirely and
it becomes the **whole tenant's** count. It badges the "Today" nav item.

`myday-workspace-parity.read.test.ts` asserts these two numbers agree — and its
own comment explains why it cannot catch the divergence: *"The fixture
deliberately makes 'assigned to me' and 'in my department' coincide (actor is the
ONLY member of, and ONLY assignee in, one department)."* The test pins the
*number*, not the *predicate*. **Rewrite the fixture so mine and department
deliberately diverge — that is the case the test needs to catch.**

A supervisor sees "47" on Today, opens it, and finds 3 items of their own. The
badge becomes noise within a week.

---

## 8. Table column classification

### "Mine" table — 5 columns (`_client.tsx:997-1006`)

| Column | Class | Recommendation |
|---|---|---|
| Job (mono, 130px) | SECONDARY | Merge into the process line as a small mono prefix |
| Process (+ 11px subtitle `stage · dept · serial`) | **ESSENTIAL** | Primary identifier; promote `serialNo` out of the subtitle into a chip |
| Due (mono, 80px) | **ESSENTIAL** | Keep |
| Overdue (`{n}d` or "—", 80px) | SECONDARY | Fold into Due as a red `+3d` suffix — a whole column that is "—" on most rows |
| *(unnamed, 220px)* delay `<select>` + detail `<input>` + File&start + state action | **ESSENTIAL but overloaded** | Keep **one** primary action. Move the reason select and detail input into the StageSheet drawer, which already renders delay history |
| **Reduced set** | | **Process · Due (overdue inline) · One action** = 3 columns |

### "Department pool" — 4 columns

Drop from My Day entirely (§2). On Team: Process · Due · Claim, with Job as a
filter rather than a column. `deptMembers` must be extended from `{id, name}` to
`{id, name, openCount, overdueCount}` — the aggregate already exists verbatim in
`admin.read.ts:76-88`.

### "Held by teammates" — 5 columns

Move to Team and regroup as **Owner → their rows**: Owner · Process · Due ·
Status · Release. Drop the 24px avatar (the name is in the subtitle two cells
later). This is the only place in the product where a plan's owner is visible.

### "Completed" — 4 columns

Job · Process · Completed · Late/On-time chip. **Already correct.** Read-only,
collapsed by default, cross-job history genuinely needs the Job column. Leave alone.

### QC verify mode — 3 columns

3 columns is right, but **Submitted-by is not shown**. `/workspace`'s `WsQcRow`
carries `submittedBy`; `MyDayRow` does not. A checker cannot see the maker. Add it.

---

## 9. Cognitive load, measured

| Variant | KPI tiles | Card containers | Tables | Cols on largest | Smallest font | Competing regions |
|---|---|---|---|---|---|---|
| Desktop ≥1024 | **4** | **8** | **4** | 5 | 10.5px (chips/`th`), inline 10px avatar | **6** |
| Tablet 640–1023 | 4 | 8 | 0 (cards) | — | 10.5px + **9.5px rail nav** | 6 |
| Phone <640 | 4 in a collapsible 2×2 | 1 + N cards | 0 | — | 10px labels, **9px badge** | **2** |

**The phone variant is the best-designed surface in the product.** `.day-queue`
is exactly the clarity → priority → context → action model: collapsed stats, one
section label, ranked cards, one action per card, a "DO THIS FIRST" ribbon on
rank 1, a 56px touch floor. **The desktop view should be rebuilt to look like the
phone view, not the other way round.**

### Information rendered twice on one screen

1. Every `mine` and `pool` row exists in the DOM three times (§3).
2. `scoreboard.doneThisWeek` renders in the KPI tile and again in
   `QueueScoreboard`; `counts.attention` renders in the tab and again as
   "Overdue now". Hidden by CSS, not by logic.
3. The same `loadMyOverdueCount` number badges both `/my-day` and `/workspace`
   under two different labels.
4. Every row subtitle repeats `deptName` when the page header already states the
   actor's departments.

---

## 10. States

| | Present? |
|---|---|
| Loading skeleton | ❌ **absent** — `loading.tsx` exists on only 4 routes, none of them this one (AUD-044) |
| Empty state | ✅ per section |
| Error state | ✅ inherited from `(app)/error.tsx` |
| Action feedback | ✅ **the best in the product** — `useRun` + `RefusalNote` surfaces the refusal code and sentence inline *and* toasts, with `disabled={pending}` on every button |

The missing skeleton matters most exactly here: `loadMyDay` runs
N-jobs-worth of queries (spine + CPM + prioritise per active job, plus three more
queries and two raw SQL counts), with no Suspense boundary — so the browser shows
the *previous* page until the whole thing resolves. On shop-floor wifi with 20
active jobs, tapping "Today" appears to do nothing. Operators tap again.

---

## 11. Proposed My Day specification

Route `/my-day`. Every section is `assigneeUserId === actor.userId`.

| # | Section | Content | Supplied by |
|---|---|---|---|
| 1 | **Header** | `My Day` · `Hi {firstName} · {today}` | existing |
| 2 | **Workload summary** — one 13px line under the title | `{n} assigned · {a} need attention · {d} due today · {b} blocked · {u} upcoming` | `mineBucket` counts, already computed at `_client.tsx:841-848` — **move the render** |
| 3 | **NEEDS ATTENTION** | Overdue assigned work. Row = Process · Due(+`3d`) · one action. Delay filing opens the StageSheet | `mine.filter(r => r.ranked.overdue)` |
| 4 | **TODAY** | Assigned and due today, plus approvals awaiting me (QC) | `mine` + `isToday()`; **add `submittedBy` to `MyDayRow`** |
| 5 | **BLOCKED** *(new)* | My blocked plans with "Waiting on: X, Y." and a Chase action | `prioritizer.ts:99-102` — already on every `RankedPlan`, currently discarded |
| 6 | **UPCOMING** | READY / IN_PROGRESS not due today, ranked. Optional 6-day load strip | `compareRankedPlans`; the strip is `MyDayView.week` — **computed today and never rendered** (AUD-082) |
| 7 | **Personal progress** — collapsed, at the bottom | On-time 30d · Done this week · Cycle vs standard · First-pass rejects · Completed table | `scoreboard` + `completed`; use the existing `QueueScoreboard` collapse pattern at all widths |
| — | **Removed** | Department pool · Held by teammates · the four top-of-page KPI tiles | |
| — | **Retained pool affordance** | One **"Claim next"** button in the header — claims the top-ranked pool row by `compareRankedPlans`. Pull-based, but the priority order is the system's, not the operator's | `claimPlanAction` + a thin `loadNextClaimable(actor)` |

**`loadMyDay()` signature change.** Returns `mine`, `blocked`, `completed`,
`clearedToday`, `scoreboard`, `week`, `delayCategories`. Delete `pool`,
`teamHeld` and `deptMembers` from this view model — they move wholesale to
`loadTeamBoard`. This is a **partition change, not a rewrite**: both functions
keep the identical per-job spine → CPM → `prioritize()` loop.

---

## 12. What is solid here and must survive

- **Timezone discipline.** `istDay()` and `istEpochDay()` use a fixed +5:30 on
  both server and client, with a comment naming the exact hydration bug they
  prevent (00:00–05:30 IST). Found once, fixed, documented at every call site.
- **One ranking implementation.** `compareRankedPlans` is exported specifically
  so cross-job merges re-sort identically instead of re-deriving a comparator.
  There is no second definition of "urgent" in the product.
- **Failure isolation.** `computeCpmSafe` means one malformed job spine skips
  that job's contribution rather than 500-ing My Day for the whole tenant, with
  the audit item cited in the comment.
- **`ProjectFilter` is the most accessible dropdown in the repo** —
  `aria-haspopup`/`aria-expanded`/`aria-controls`, Escape, outside-click,
  `role="listbox"`/`role="option"` — with a comment warning future authors not to
  regress it to match the two older inaccessible dropdowns.
- **The inline refusal pattern.** `useRun` + `RefusalNote` should be extracted to
  `src/components/industrial/` and adopted by `/workspace` and `/alerts`, which
  regress to toast-only (AUD-083).
