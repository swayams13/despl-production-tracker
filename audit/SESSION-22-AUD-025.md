# SESSION 22 — AUD-025 · `/board` and `/profile` bypass client visibility entirely

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/12_SECURITY_RBAC.md` §4, `audit/20_REMEDIATION_ROADMAP.md` Phase 1c item 24.*
*Independent of every other session in this batch.*

---

## PASTE FROM HERE

You are a Staff Full-Stack Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes a P1
authorization-bypass finding: two pages under `(app)` have no client-user
guard at all, and the shared layout loads internal job telemetry for
**every** actor — client or not — before any page-level guard runs.

### Read before writing anything

1. `audit/12_SECURITY_RBAC.md` §4 (AUD-025) in full.
2. `src/app/(app)/layout.tsx` in full — the route-group layout every page
   under `(app)` renders through. Note its own doc comment: *"Individual
   pages own their own unauthenticated redirect... this layout doesn't
   duplicate that."* Confirm it currently has **no** client-user check at
   all — only `actor?.mustChangePassword` — before its `Promise.all` that
   loads `loadMyOverdueCount`, `loadNotifications`, `loadJobs` for **any**
   authenticated actor, client users included.
3. `src/app/(app)/board/page.tsx` and `src/app/(app)/profile/page.tsx` — both
   in full. Confirm each currently only does
   `if (!actor) redirect("/login")` — no `if (actor.clientId !== null)
   redirect("/portal")`.
4. Confirm the sibling pattern that every **other** page in this route group
   already follows correctly:
   `grep -rn "clientId !== null" src/app/\(app\)/*/page.tsx` — ten other
   pages (`admin`, `alerts`, `dashboard`, `departments`, `jobs`, `my-day`,
   `qc`, `reports`, `welding`, `workspace`) all do
   `if (actor.clientId !== null) redirect("/portal");` right after their own
   `if (!actor) redirect("/login")`. `board` and `profile` are the two
   pages missing this line.
5. `src/middleware.ts` in full — confirm it is a coarse, deny-by-default
   *authentication* gate only (token signature verification, no DB access,
   no role/client knowledge) — it cannot and should not be where this fix
   goes; the fix belongs in the layout/page layer per invariant #8's own
   framing ("real authorization happens in lib/services/ via lib/authz, and
   must never be skipped on the assumption that middleware already
   checked").
6. `src/lib/services/jobs.read.ts`'s `loadJobs` and whatever backs the job
   switcher rendered by `AppShell` — confirm what fields a `JobListItem`
   actually carries (`percentComplete`, `forecastVarianceDays`,
   `overduePlans`, `openHoldPoints`, etc. per the audit) and that this is
   exactly what gets handed to `AppShell`'s job switcher for **every**
   actor today, client users included, regardless of which page they're on.
7. Whatever mechanism implements `ClientVisibilityPolicy`
   (`grep -rn "ClientVisibilityPolicy\|showProgress\|showDates" src/lib --include=*.ts`)
   — confirm this fix doesn't need to touch that policy itself; the bug is
   that `/board`/`/profile` and the shared layout bypass it entirely, not
   that the policy's own logic is wrong.

### The defect

```tsx
// board/page.tsx:4-6 and profile/page.tsx:4-6 — the ONLY guard present
const actor = await getActor();
if (!actor) redirect("/login");
//  ← missing: if (actor.clientId !== null) redirect("/portal");
```

Every sibling page in this route group has the second line; these two
don't. Worse, `(app)/layout.tsx` loads `loadJobs(actor)` — which returns
`JobListItem[]` carrying `percentComplete`, `forecastVarianceDays`,
`overduePlans`, `openHoldPoints`, `lastActivityAt` — for **any** actor,
before any page-level guard runs, and hands it straight to `AppShell`'s job
switcher, which renders those fields directly in JSX. So a client user who
reaches `/board` (by navigation, deep link, or bookmark) sees live internal
percent-complete, real forecast dispatch dates, overdue plan counts and open
hold points for their own orders — the exact figures `ClientVisibilityPolicy`
exists to withhold until a Management-verified snapshot is released, and
even when `showDates`/`showProgress` are switched off for that specific
client. **A customer can see slippage before DESPL has decided to
communicate it.**

### Your task

**1 — Move the guard into the layout, structurally, so a future new page in
this group can't reintroduce the gap.** In `(app)/layout.tsx`, add the
client check immediately after the existing `mustChangePassword` check and
**before** the `Promise.all` that loads internal reads:

```tsx
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const actor = await getActor();
  if (actor?.mustChangePassword) redirect("/account/password");
  if (actor?.clientId != null) redirect("/portal");

  let overdueCount = 0;
  ...
```

Confirm this doesn't break `/portal` itself — check whether `/portal` lives
inside or outside the `(app)` route group
(`find src/app -iname "*portal*"` or check the routing tree directly). If
`/portal` is itself under `(app)`, this new redirect would loop; if it's
outside (a separate route group, matching how `/login` and
`/account/password` are described as "outside this route group" in the
layout's own comment), you're safe — but verify this explicitly rather than
assuming, since a self-redirect loop here would break the client portal
entirely for every client user, which is a much worse outcome than the bug
this session is fixing.

**2 — Keep the per-page guards as defence in depth**, per the audit's own
recommended fix. Add the missing line to both `board/page.tsx` and
`profile/page.tsx`, matching the exact pattern the other ten pages use:

```tsx
const actor = await getActor();
if (!actor) redirect("/login");
if (actor.clientId !== null) redirect("/portal");
```

This is deliberately redundant with step 1 — the layout guard is what makes
it structurally impossible for a *new* page to be exposed; the per-page
guard is what every other page in this group already does and what a
reviewer scanning `board/page.tsx` in isolation will expect to see.

**3 — Confirm the layout's own internal reads are safe once the redirect is
in place.** Since `redirect()` in a Next.js Server Component throws (it
doesn't return), confirm the `Promise.all` block genuinely never executes
for a client actor after step 1's redirect — this should be automatic given
`redirect()`'s throwing behavior, but verify it directly (add a temporary
log or test, not just an assumption) rather than trusting the control-flow
reasoning alone.

### Details that matter

- **`getActor()` itself is not being changed** — this session only adds
  checks on its already-returned `actor.clientId`, it doesn't touch how
  actors are resolved or authenticated.
- **Do not touch `ClientVisibilityPolicy`'s own logic** (`showProgress`/
  `showDates` toggles) — this session's fix is about pages/layout that
  bypass the policy entirely, not about the policy's own correctness for
  pages that do consult it.
- **Check for any other page under `(app)` missing the same line** while
  you're at it — the grep in step 4 above should show you the complete
  current set; if you find a third page beyond `board`/`profile` missing
  the guard, fix it in this same session and note it explicitly in your PR
  (the audit only names two, but confirm against the live codebase rather
  than assuming the audit's list is exhaustive against today's file set).

### Constraints — these are binding

- **No change to `middleware.ts`** — it's deliberately coarse and DB-free;
  this fix belongs at the layout/page layer, per invariant #8's own
  reasoning quoted above.
- **No change to `getActor`, `ClientVisibilityPolicy`, or `AppShell`'s job
  switcher rendering itself** — the fix is entirely about which actors ever
  reach the code that loads and renders this data, not the rendering logic.
- **Verify the `/portal` redirect target doesn't create a loop** before
  shipping — this is a hard blocking check, not optional due diligence.

### Tests

Add an e2e test looping every route in the `(app)` group with a client
session, per the audit's own explicit recommendation (find the existing e2e
setup — `grep -rn "clientId" e2e/*.ts` or similar — and extend it rather
than writing a new harness):

| # | Scenario | Expect |
|---|---|---|
| 1 | Client-user session navigates directly to `/board` | redirected to `/portal`, never renders the page |
| 2 | Client-user session navigates directly to `/profile` | redirected to `/portal`, never renders the page |
| 3 | Client-user session navigates to every other route under `(app)` in a loop (extend the existing per-route e2e assertion to include `/board` and `/profile` in its list, if it wasn't already, per the audit's note that the current suite "only exercises `/` and `/api/jobs`") | every route redirects to `/portal` |
| 4 | Client-user session navigates to `/portal` itself | renders normally — no redirect loop |
| 5 | Non-client (internal) staff session navigates to `/board` and `/profile` | renders normally, unaffected — this is the regression guard that the fix doesn't over-block legitimate internal users |
| 6 | Unauthenticated request to `/board`/`/profile` | still redirects to `/login`, unaffected by this session's change |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test
pnpm test:e2e    # or whatever this project's actual e2e run command is — confirm in package.json
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Confirm explicitly in
   the description that you verified `/portal` lives outside the `(app)`
   route group (no redirect loop), and whether you found any third page
   missing the guard beyond the two the audit names.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-025** closed with the
   PR reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-040 | `/board` and `/profile` being "coming in R2" stubs in the first place — a separate IA/gap finding (should they exist in shop-floor nav at all), different phase of the roadmap |
| `ClientVisibilityPolicy`'s own `showProgress`/`showDates` logic | Unaffected — this session stops these two pages from bypassing it, it doesn't change what the policy itself withholds |

## PASTE TO HERE
