# Client portal — daily progress updates — design spec

**Date:** 19 Aug 2026
**Status:** approved design, not yet implemented
**Supersedes:** nothing. Completes `/portal`, which has stood as a real,
wired placeholder since the personal-dashboards work ("The order progress
view is in preparation and will appear here" — `src/app/portal/page.tsx`)
explicitly deferring to `ProgressSnapshot`, a table that has existed in the
schema unused since the same session. This spec builds the thing it was
left waiting for.

Pilot scope: **DESPL-320 only** (9 units, 320SR01–09), the same job every
other pilot feature in this codebase has been proven against first.

---

## 1. Problem

DESPL wants their client to see daily progress on their order — but not the
internal detail. Today:

- `/portal` shows a client user their job count and a cadence string, then
  stops. No per-unit detail, no history, nothing else.
- `ClientVisibilityPolicy.cadence` for the one real client (id 1, owning
  DE0463/DE0467/DESPL-320) is seeded `WEEKLY`; the business wants `DAILY`.
- Every internal view (Workspace, Job detail, Departments) shows exactly
  who did what and when — supervisor names, department names, delay-reason
  categories, hold-point checkpoint text. None of that belongs in front of
  a client. Nothing in the app today produces a sanitized view at all.
- There is no publish/release workflow of any kind. Internal users already
  see live data continuously; a client needs a **frozen, reviewed** cut of
  it instead, on a cadence, not a live feed.

**Goal:** DESPL's team ends each working day by publishing that day's real
progress to the client portal; a second person reviews and releases it the
next morning before the day's work starts. The client sees clean,
honest, per-unit progress — never who worked on it or why something slipped
internally.

## 2. Goals and non-goals

**Goals**

- A daily publish → verify → release workflow, mirroring this app's
  existing maker–checker discipline (invariant #3) rather than inventing a
  new one.
- One row of real per-unit progress for every one of DESPL-320's 9 units,
  every published cycle — the user's explicit ask: "if there are x qtys,
  the information should be displayed for each qty."
- A sanitized read model: current stage (client-facing 25-stage names,
  already built for exactly this in `stage-names.ts`), plain-English
  status, dates, done responsibly per `ClientVisibilityPolicy`'s existing
  four toggles. Zero actor names, department names, or internal delay
  categories, ever.
- An internal preview surface ("Client View" tab on the job page) so
  Production Head and Management can see and act on exactly what the
  client will see, before it goes out — this doubles as the "proper
  dashboard to show the team management" the request asks for.
- Real data only, from DESPL-320's actual `ProcessPlan`/stage state — no
  mock rows.

**Non-goals**

- No cron/scheduled publishing. Both the 8–9pm publish and the 7–8am
  verify are manual button clicks by an authorized role, confirmed with
  the user — this app has no scheduled-job infrastructure today, and a
  human-reviewed gate is safer for a client-facing surface than an
  unattended job that could publish a broken number at 9pm with nobody to
  catch it.
- No email/WhatsApp delivery. Still Phase 2 per `CLAUDE.md`; the client
  logs into `/portal` to see it, same as an internal user logs in to see
  theirs.
- No softened delay-reason text. Confirmed with the user: the client sees
  *that* a unit is behind, never the internal *why*.
- No change to any other client (DE0463/DE0467's client, or the leaked
  test-fixture client rows already flagged elsewhere in `progress.md`).
  Only DESPL-320's real client (id 1) is put on `DAILY` cadence.
- No rework of `ClientVisibilityPolicy` itself — its four toggles already
  exist and already do exactly the job this spec needs.

## 3. What already exists

This is the load-bearing fact that keeps this spec small:

- `ProgressSnapshot` (`prisma/schema.prisma`) — `jobId`, `unitId`, `asOf`,
  `overallPct`, `detail Json?`, `publishedBy`/`publishedAt`. Its own doc
  comment: *"The only thing client users read. Frozen, published,
  auditable... DAILY / WEEKLY cadences share one code path."* This spec is
  the first thing to actually write to it.
- `ClientVisibilityPolicy` — `showProgress`/`showStageStatus`/`showDates`/
  `showQcp`/`cadence`/`requiresApproval`, one row per client, all already
  seeded for client id 1 (`requiresApproval: true` — already assumes the
  publish→approve shape this spec builds).
- `loadJobSpines()` (`src/lib/services/spine.read.ts`) reads the canonical
  `v_unit_stage_status` view and returns, per unit, per stage: `stageNo`,
  `stageName` (already the 25 client-facing names via `stageName()` in
  `src/lib/shared/stage-names.ts`), and a `StageDisplayStatus` — one of
  `complete | progress | submitted | hold | overdue | idle`
  (`src/components/industrial/stage-status.ts`). This is the exact input
  the sanitized client view needs; nothing new has to be computed from raw
  `ProcessPlan` rows.
- `/portal/page.tsx` already resolves the acting client, checks
  `mustChangePassword`, and reads `visibilityPolicy` — it just renders a
  placeholder after that. This spec replaces the placeholder body only.
- `assertClientScope`, `assertNotClientUser`, `requireRole`, `ROLES`
  (`src/lib/authz/index.ts`) — the exact primitives every other mutation in
  this app uses; no new authz primitive is needed.
- `reports.service.ts`'s `publishDigest` and `process.service.ts`'s
  `verifyProcess`/`rejectProcess` are the concrete templates this spec's
  three new actions are built from — same `audited()` wrapper, same zod
  input schema, same notify-the-other-party pattern.

**What does not exist:** any concept of a snapshot's own review state.
`publishedBy`/`publishedAt` today would conflate "prepared" and
"released" — the one real gap this spec fills.

## 4. State machine

Three reachable states, not four. An earlier draft of this spec (in
chat) loosely said "draft → published → verified → rejected" — on
inspection, nothing is ever persisted before Production Head clicks
Publish, so there is no separate DRAFT row to represent. The actual
machine:

```
                 publish                  verify
   (no row)  ──────────────►  PUBLISHED  ──────────►  VERIFIED  (terminal, frozen)
                                  │  ▲
                                  │  │ publish (re-publish, overwrites)
                            reject│  │
                                  ▼  │
                              REJECTED
```

- **`PUBLISHED`** — Production Head's evening action. Creates or
  **overwrites** that unit's row for that calendar day (`asOf`). Not yet
  client-visible. Mutable — PH can re-publish the same day as many times
  as needed (e.g. caught their own mistake at 9:05pm) — nothing is frozen
  yet, so overwriting here does not violate invariant #6.
- **`VERIFIED`** — Management's morning action. The *only* state the
  client's read query ever selects. **Locked**: the service refuses any
  further publish/verify/reject against a row already `VERIFIED` — this is
  where "frozen, published, auditable" (the schema's own words) actually
  starts applying, matching invariant #6's no-destructive-edits rule.
- **`REJECTED`** — Management's morning veto, with a mandatory reason.
  Not client-visible. Not terminal in the sense of blocking further work:
  Production Head can publish again for the *same* `asOf`, which flips the
  row back through `PUBLISHED`. The rejection itself is preserved forever
  in `audit_log`/`domain_events` (append-only, invariant #5) even though
  the row's own `status` moves on — the historical "this was rejected
  once, here's why" fact is never lost, just no longer the row's live
  state.

One row per `(jobId, unitId, asOf)`, enforced with a DB unique constraint
— `asOf` is the civil day being reported on, stamped server-side at
noon UTC (matching the "store civil-noon-UTC at the service boundary"
convention flagged elsewhere in `progress.md`, so this spec doesn't
reintroduce the UTC-midnight day-boundary bug already known and parked).

Verify and reject act on **the whole day's batch** — every one of
DESPL-320's 9 unit-rows for that `asOf` — in one transaction, one click.
Nobody should have to click verify 9 times. No new `SnapshotBatch` table:
the 9 rows already share `(jobId, asOf)`, which is enough to select and
update them together; a separate parent entity would exist only to be
queried by that same pair, so it's dead weight (Rung 2 of the laddder —
reuse what's already the join key).

## 5. Roles

Mirrors `publishDigest`'s existing role set, extended with the maker–checker
self-check every other verify/reject action in this app already has:

| Action | Roles | Self-check |
|---|---|---|
| Publish | `PRODUCTION_HEAD`, `ADMIN` | — |
| Verify | `MANAGEMENT`, `ADMIN` | actor ≠ that batch's `publishedBy` |
| Reject | `MANAGEMENT`, `ADMIN` | actor ≠ that batch's `publishedBy` |

`ADMIN` is included on both sides (matching `publishDigest`'s existing
convention) as an operational fallback if PH or MD/CEO is unavailable —
never as a way around the self-check, which blocks the *same person*
publishing and later verifying their own batch regardless of role overlap.
`assertNotClientUser` guards all three, same as every mutation in the app.

**Open question**, flagged rather than silently decided: should `ADMIN` be
excluded from verify entirely, so the morning review is *always* a real
Management sign-off and never an operational fallback? Default in use:
`ADMIN` included, for the same reason `publishDigest` includes it — see
§13.

## 6. Data model

```prisma
enum ProgressSnapshotStatus {
  PUBLISHED
  VERIFIED
  REJECTED
}

model ProgressSnapshot {
  // ...existing fields unchanged...
  status           ProgressSnapshotStatus @default(PUBLISHED)
  verifiedBy       Int?      @map("verified_by")
  verifiedAt       DateTime? @map("verified_at")
  rejectionReason  String?   @map("rejection_reason")

  @@unique([jobId, unitId, asOf])
}
```

`rejectionReason` lives on the row itself, not audit-only — a deliberate
departure from `holdProcess`'s precedent (whose reason is audit-only,
"nothing reads a live hold reason today"). Here something *does* read it
live: the internal Client View tab must show PH *why* last night's publish
was rejected, so they know what to fix before publishing again. Storing it
lets that render with a plain read, not an audit-log join.

One data migration alongside the schema migration: backfill client id 1's
`ClientVisibilityPolicy.cadence` from `WEEKLY` to `DAILY` (matches the
pattern of the 18 Aug `theme_preference_dark_backfill` migration — schema
change + one data-fix migration together). `prisma/seed.ts:798` also
changes its seeded default from `WEEKLY` to `DAILY`, so a fresh `db:seed`
matches going forward (same reasoning as that session's `mustChangePassword`
seed fix).

## 7. Services

**`src/lib/services/client-snapshot.service.ts`** (new) — three mutations,
each `audited()`, each inside `withTenant`:

- `publishSnapshot(actor, jobId)` — `asOf` is stamped server-side from
  today's date (civil-noon-UTC), never accepted as a caller parameter,
  matching invariant #1 exactly (no client timestamps for anything the
  server can derive itself). Loads the job's units via
  `loadJobSpines`, computes each unit's current stage (first non-`complete`
  segment in stage order; if every segment is `complete`, the unit's
  current stage is stage 25) and `overallPct` (completed segments ÷ 25),
  upserts one `ProgressSnapshot` row per unit at `(jobId, unitId, asOf)`
  with `status: PUBLISHED`. Refuses (coded error) if any of that day's
  rows are already `VERIFIED` — a verified day is frozen, full stop, no
  silent re-publish. Notifies `MANAGEMENT` users (`CLIENT_UPDATE_PUBLISHED`,
  mirrors `publishDigest`'s notify shape) so the morning review has a real
  prompt rather than relying on habit.
- `verifySnapshot(actor, jobId)` — locks and updates every row currently
  `PUBLISHED` for that job (there is at most one such `asOf` in play at
  once — publish always targets today, and verify always resolves
  whichever day is still pending) to `VERIFIED`, stamping
  `verifiedBy`/`verifiedAt` from the server clock. Refuses if no row is
  currently `PUBLISHED`.
- `rejectSnapshot(actor, jobId, reason)` — same batch update,
  `PUBLISHED → REJECTED`, `reason` mandatory (reuses the existing
  `REASON_REQUIRED` error code). Notifies the batch's `publishedBy`
  (`CLIENT_UPDATE_REJECTED`), mirroring `rejectProcess`'s "reject → maker"
  notify pattern exactly.

**`src/lib/services/client-snapshot.read.ts`** (new) — two reads sharing
one internal helper, so the internal preview can never drift from what the
client actually sees:

- `loadClientPortalView(actor)` — **client-facing, client-scoped, not
  job-scoped.** `/portal` already enumerates every job the acting client
  owns ("3 order(s) on record" — `src/app/portal/page.tsx`'s existing
  placeholder), so this reads all of the client's jobs (`assertClientScope`
  is implicit — the query is `WHERE client_id = actor.clientId`, RLS-backed
  same as every other client read) and, per job, selects the latest
  `VERIFIED` row per unit. Returns one entry per job: either the per-unit
  breakdown (`{ serialNo, stageName, status, percentComplete }[]` plus
  job-level `{ overallPct, forecastDispatch, asOf }`, gated by
  `showProgress`/`showDates`) or an explicit "no update yet" shape for a
  job with no `VERIFIED` row (e.g. DE0463/DE0467, still `WEEKLY` cadence,
  untouched by this feature) — the honest empty state, not a crash.
- `loadClientPreview(actor, jobId, asOf?)` — **internal**, for the Client
  View tab. `asOf` here is an optional read filter (defaults to the most
  recent day with any row), not a mutation input, so it doesn't touch
  invariant #1 — this lets PH/Management glance at a past day's release
  later, a read, never a write. Same shape, same sanitization, but reads
  whatever that day's real `status` is (`PUBLISHED`/`VERIFIED`/`REJECTED`)
  instead of only `VERIFIED`, and includes `rejectionReason` when present.
  Requires `PRODUCTION_HEAD | MANAGEMENT | ADMIN`.

**Status sanitization** (both reads call this; lives in `client-snapshot.read.ts`):

| Internal `StageDisplayStatus` | Client-facing label |
|---|---|
| `complete` | Complete |
| `progress` | On track |
| `submitted`, `hold` | Under inspection |
| `overdue` | Delayed |
| `idle` | Not started |

`submitted` and `hold` collapse to one label deliberately — the
distinction (awaiting QC vs. a formal hold point) is internal process
detail; the client only needs to know the unit isn't idle and isn't moving
forward for a quality reason, never which one. `showQcp: true` in the
policy adds one extra line — a plain count, e.g. "2 units under
inspection" — never a checkpoint code or H/W classification.

## 8. UI

**Client portal (`/portal/page.tsx`, rewritten)** — replaces the
placeholder body. Per DESPL-320 (and any future daily-cadence client job):
overall % and forecast dispatch at the top (if `showDates`), then one row
per unit — serial number, stage name, status chip, % complete. No new chip
component: `<StatusChip>` already takes an optional `label` override
(`src/components/industrial/status-chip.tsx:44`), so the client view calls
it with the *existing* internal status (for its icon) and the sanitized
label from §7's table — `submitted` is always passed as `hold` (so the
pause-glyph icon is consistent whichever internal state produced "Under
inspection", rather than showing two different icons for one label), the
other three map straight through. Status is still never plain text, per
the existing hard ban — it's the same battle-tested component everywhere
else in the app uses, just relabelled. "As of
`asOf`" always visible, so a missed evening or morning is honest, never
silently stale. First-ever visit before anything is verified: "Your order
progress will appear here once your update is confirmed" — same tone as
the existing placeholder, not a crash.

**Internal Client View tab** — sixth tab on `/jobs/[id]`
(`?tab=client`), alongside Overview/Gantt/BOM/QCP/Activity, visible only
to `PRODUCTION_HEAD | MANAGEMENT | ADMIN` (the tab link itself doesn't
render for other roles — no dead control for someone who can't use it).
Renders the **same component** the real portal uses
(`<ClientPortalView />`, new, `src/components/industrial/`), fed by
`loadClientPreview` instead of `loadClientPortalView` — so there is
structurally no way for the preview to show something different from
what a client will actually see. A banner above it names the real state:
"Draft, not yet published" (no row today) / "Published, awaiting
Management review" / "Rejected: `<reason>`" / "Verified — visible to
client since `<time>`". The Publish / Verify / Reject actions live in
this banner, role-gated per §5 — Production Head sees Publish (and
Re-publish after a rejection), Management sees Verify/Reject on a
`PUBLISHED` day, nobody sees a button once `VERIFIED`.

Required states per `CLAUDE.md` §"Every page ships with": loading
skeleton matching the final per-unit list, the "no update yet" empty
state above, an error state naming what failed with retry, visible
keyboard focus on the status chips and action buttons.

## 9. Testing

Per `CLAUDE.md`, the new state machine gets table-driven tests for the
violation cases, not just the happy path — same discipline as the
portfolio dashboard's health rule.

**State transitions (pure logic where possible, DB-gated where a real
row/lock is unavoidable):**

| Case | Expect |
|---|---|
| Publish with no existing row for that day | Creates 9 `PUBLISHED` rows |
| Publish again same day, still `PUBLISHED` | Overwrites in place, same row ids |
| Publish when that day is already `VERIFIED` | Refused, coded error |
| Verify a `PUBLISHED` day | All 9 rows → `VERIFIED`, `verifiedBy`/`verifiedAt` stamped |
| Verify by the same user who published | Refused — self-check, mirrors `MAKER_CHECKER_VIOLATION` |
| Verify a day with no `PUBLISHED` rows | Refused |
| Reject without a reason | Refused — `REASON_REQUIRED` |
| Reject a `PUBLISHED` day | All 9 rows → `REJECTED`, `rejectionReason` stored, publisher notified |
| Publish again after `REJECTED` | Flips back to `PUBLISHED`, new `publishedBy`/`publishedAt` |
| Client read while day is `PUBLISHED` (not yet verified) | Client sees the *previous* `VERIFIED` day, or "no update yet" if none exists — never the unverified draft |
| Client read after `VERIFIED` | Sees exactly that day's 9 rows, sanitized |

**Sanitization (pure, always-on tier):** a test asserting the rendered
client view contains no actor name, no department name, no raw
`StageDisplayStatus` enum value, no delay-reason category string, for a
fixture built from real `submitted`/`hold`/`overdue` unit states — the
"submitted and hold collapse to Under inspection" rule is exactly the kind
of thing a future edit could silently break without a test naming it.

**Scoping:** a DB-gated test that a client user for a *different* client
cannot read DESPL-320's snapshots (`assertClientScope`), and that
`loadClientPortalView` never returns a `PUBLISHED`-but-unverified row.

DB-gated tests run via `pnpm test:db` against `despl_test` only, per this
project's standing rule.

## 10. Files

| File | Change |
|---|---|
| `prisma/schema.prisma` | `ProgressSnapshotStatus` enum; `status`/`verifiedBy`/`verifiedAt`/`rejectionReason` on `ProgressSnapshot`; `@@unique([jobId, unitId, asOf])` |
| `prisma/migrations/…_progress_snapshot_review_state/` | new — schema migration |
| `prisma/migrations/…_client_daily_cadence_backfill/` | new — data migration, client id 1 → `DAILY` |
| `prisma/seed.ts:798` | seeded default `WEEKLY` → `DAILY` |
| `src/lib/services/client-snapshot.service.ts` | new — `publishSnapshot`, `verifySnapshot`, `rejectSnapshot` |
| `src/lib/services/client-snapshot.service.test.ts` | new — DB-gated, table above |
| `src/lib/services/client-snapshot.read.ts` | new — `loadClientPortalView`, `loadClientPreview`, sanitization map |
| `src/lib/services/client-snapshot.read.test.ts` | new — pure sanitization tests + DB-gated scoping test |
| `src/components/industrial/client-portal-view.tsx` | new — `<ClientPortalView />`, shared by both consumers |
| `src/app/portal/page.tsx` | replace placeholder body with `<ClientPortalView />` |
| `src/app/(app)/jobs/[id]/page.tsx` | add `client` to the tab union, load `loadClientPreview` when active |
| `src/app/(app)/jobs/[id]/_client.tsx` | add the Client View tab link (role-gated) + review-action banner |
| `src/app/actions/client-snapshot.ts` | new — server actions wrapping the three service functions |
| `src/lib/shared/errors.ts` | one new error code if `SCHEDULE_DATA_MISSING`-style refusal text is needed for "day already verified" — reuse `MAKER_CHECKER_VIOLATION`/`REASON_REQUIRED` otherwise |
| `progress.md` | session log |

No new dependency. No cron.

## 11. Acceptance criteria

1. Production Head can publish a real day's progress for DESPL-320 from
   the Client View tab; all 9 units appear, computed from real
   `ProcessPlan` state, not mock data.
2. Management sees the published batch, can Verify (client-visible from
   that moment) or Reject (with a mandatory reason, publisher notified).
3. The real client user (`client@example.local`) logs into `/portal` via
   the actual `/login` form and sees exactly the verified batch — per-unit
   rows, sanitized status, no actor/department names anywhere in the
   rendered HTML.
4. A `PUBLISHED`-but-unverified day is never visible to the client, even
   if they refresh mid-review.
5. The self-check refuses the same user both publishing and verifying the
   same batch, with a clear error, not a crash.
6. Re-publishing after a rejection works and is visibly reflected in the
   Client View tab's banner and reason.
7. `pnpm test`, `pnpm test:db`, `pnpm lint`, `pnpm typecheck`, `next build`
   all clean.
8. No raw enum, DB role, table name, or developer commentary renders on
   `/portal`.

## 12. Note on the current environment

Unrelated to this design, surfaced during scouting and already logged
separately in `progress.md`: this session's local `despl` database is
running behind the codebase in two ways — two unapplied migrations
(`theme_preference`, now fixed by running `migrate deploy`) and zero
seeded welders despite `seed.ts` seeding five. Worth a `pnpm prisma
migrate status` check before implementation starts, so this feature isn't
built and tested against a stale schema.

## 13. Open questions for DESPL

**C30 — should `ADMIN` be allowed to verify a client update, or should
that be Management-only, always?** Default in use (§5): `ADMIN` included,
matching `publishDigest`'s existing precedent, with the self-check as the
actual safety net rather than a role restriction. Affects only who can act
as the morning checker when MD/CEO is unavailable.

**C31 — is "Under inspection" (collapsing `submitted` + `hold`) the right
client-facing phrase, or does DESPL want distinct wording for an awaiting-QC
unit vs. one sitting on a formal hold point?** Default in use (§7): one
collapsed label, since the underlying distinction is internal process
detail either way. Affects only display copy, not data.

Both follow the C1–C29 convention already established in this project: a
working default is in place, and the question is logged rather than
silently decided.
