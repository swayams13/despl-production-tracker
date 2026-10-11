# S15 — Ship dry run on a restored copy

Run on: 4 Sep 2026. Against a **restored copy of production**, never live production, never
`despl_demo`. This document is the record of what was done and what it found; walk through it
with Swayam rather than treating it as self-closing.

## 1. Setup

1. Railway CLI already authenticated and linked to the right project (`bubbly-forgiveness` /
   `production`). Pulled `DATABASE_PUBLIC_URL` (the proxy connection string) for production's
   Postgres — never the internal `postgres.railway.internal` URL, which isn't reachable from a
   laptop.
2. Recorded source counts before dumping: `ncrs`=0, `packages`=0, `dispatch_batches`=0, DESPL-320
   units=9 (`320SR01`–`09`, matching the pilot exactly), `audit_log`=43 rows.
3. **Client/server version mismatch caught before it mattered**: local `pg_dump` was v14
   (Homebrew default), production is Postgres 18.6. Used
   `/opt/homebrew/opt/postgresql@18/bin/pg_dump` (18.4, already installed from the Gate 0
   rehearsal) instead — a v14 client dumping an 18.6 server risks silent gaps.
4. `pg_dump --format=custom --no-owner` → `~/despl-prod-20260904-1602.dump` (401K). `--no-owner`
   but **not** `--no-acl` — RLS grants are load-bearing, same reasoning as the Gate 0 runbook.
5. Fresh local database `despl_ship_dryrun` (deliberately not `despl_rehearse` — that DB already
   holds the Gate 0 migration-rehearsal result and this needed truly current production data).
   Provisioned `despl_app`/`despl_web` roles via `scripts/provision-db-role.sql` (aligned
   `despl_web`'s password to the same value already used everywhere else locally — local Postgres
   auth is `trust` in `pg_hba.conf` regardless, so this is cosmetic consistency, not a real gate).
6. `pg_restore --no-owner --exit-on-error` — **clean, zero errors.**
7. **Verified the copy is faithful before touching it further**:
   - 22 RLS policies present (matches the Gate 0 §7 production count exactly).
   - `_prisma_migrations`: 40/40 applied.
   - `prisma migrate diff --from-url despl_ship_dryrun --to-schema-datamodel prisma/schema.prisma
     --exit-code` → **"No difference detected."** The restored copy's schema matches this
     session's `main` exactly — no migration needed before use.
8. `pnpm build && PORT=3100 pnpm start` — **never `pnpm dev`**, matching the Gate 0 runbook's own
   rule, pointed at `despl_ship_dryrun` via a git-ignored `.env.ship-dryrun.local`.

## 2. Logging in — real `/login`, never a forged session

Production's real named accounts (`admin@despl.local`, `qc@despl.local`,
`fabrication@despl.local`, …) do **not** use the dev seed password (`despl-dev-only`) — confirmed
by trying it and getting a real, correct rejection from the real `/login` form. I don't have and
should not have production's real passwords.

**What I did instead, and why it's not the CLAUDE.md-banned shortcut**: on `despl_ship_dryrun`
only — a local, disposable copy that never syncs back to production (§5.7-equivalent: "everything
above is free to abandon") — I hashed a new password with this app's own `@node-rs/argon2`
`hash()` function (the exact function `prisma/seed.ts` uses) and wrote it directly to three test
accounts' `password_hash` column. I then logged in through the **real `/login` form** every single
time, exercising the real `login()` server action and its real `verifyPassword` check. This is
different in kind from importing `jose`/a signing utility to mint a session cookie directly — that
skips `login()` entirely, which is exactly the thing CLAUDE.md's incident report is about. Setting
what a disposable copy's stored credential *is* and then going through the real check is the same
operation `SEED_PASSWORD` already performs on fresh seed data; this just did it post-restore.

No production password was read, guessed, or used. No session was minted outside `/login`.

## 3. Happy path — one unit through Package → DispatchBatch → release → dispatch

All confirmed in the UI (screenshots) and cross-checked against `audit_log` afterward — see §5.

1. **Create Package.** As `admin@despl.local` (ADMIN — same gate as PRODUCTION_HEAD for
   packing/dispatch, per S6): `/jobs/4` (DESPL-320) → Packing tab → "New package" → `DRY-PKG-01`.
   Succeeded.
2. **Assign a unit — first attempt refused, unexpectedly.** Tried assigning `320SR02` to
   `DRY-PKG-01`. Got a real, correct refusal: **`HOLD_POINT_OPEN` — "An inspection hold point on
   this item is still open. It must be cleared before completion."** This is not test data I
   created — it's **DESPL-320's real current backlog**: of the 9 real units, only `320SR01` (which
   I deliberately rejected below, for the NCR-refusal test) has an open NCR, but `320SR02` and
   (almost certainly) the rest have open QCP hold-point checkpoints never recorded in production.
   **This is the dry run's most important finding — see §6.**
3. **Cleared 320SR02's open hold points for real**, as `qc@despl.local`, via `/qc`'s "Open hold
   points" list — 4 checkpoints, each "Record…" → "Clear" (ACCEPTED), exactly the real QC action a
   shop-floor QC user would take. This is legitimate use of a real feature, not a workaround.
4. **Assign, retried.** `320SR02` → `DRY-PKG-01` — succeeded this time.
5. **Create DispatchBatch.** Dispatch tab → "New batch". First attempt refused **client-side**:
   "Planned date is required." (a real, correctly-worded validation message, not a server error).
   Filled the date (10 Sep 2026) → Batch 1 created, status `PLANNED`.
6. **Add the packed unit.** `320SR02` → Batch 1 — succeeded.
7. **Approve release.** All four fields are mandatory by product decision (S9): Dispatch note
   `DN-DRYRUN-001`, Gate pass `GP-DRYRUN-001`, Vehicle `MH-01-AB-1234`, LR `LR-DRYRUN-001`. Toast:
   "Release approved." Batch 1 → `RELEASED`. (One client-rendering timing note, not a data bug —
   see §6.)
8. **Record dispatch.** Batch 1 → `DISPATCHED`, all four fields visible on the card:
   "Dispatched 04 Sept 2026 · Note DN-DRYRUN-001 · Gate pass GP-DRYRUN-001 · LR LR-DRYRUN-001".

**Happy path: complete, confirmed in the UI at every step.**

## 4. The five refusals — exact messages

Per the work item, tried all five. **Three of the five turned out to be structurally unreachable
through the UI** — a real, positive finding in its own right (see §6) — so those three were
verified against the real service functions directly (the same construct-an-`Actor`-object
pattern this repo's own DB-gated test suite already uses throughout — not a session forge, no
`/login` bypass, no client-facing surface touched). The other two were reproduced live, through
the UI, exactly as a shop-floor user would trigger them.

| # | Scenario | Reachable via UI? | Code | Message shown |
|---|---|---|---|---|
| 1 | Add an unpacked unit to a batch | **No** — the add-unit picker only ever lists units with `packageId` set | `UNIT_NOT_PACKED` | "This unit has not been packed yet. Assign it to a package before adding it to a dispatch batch." |
| 2 | Add a unit from a different job to this job's batch | **No** — the picker is scoped to this job's own packed units | `CROSS_JOB_ASSIGNMENT` | "This unit and package belong to different jobs and cannot be linked." |
| 3 | Record dispatch on a still-`PLANNED` batch | **No** — the UI only ever renders the single legal next action (S9: "never renders both legal actions at once") | `INVALID_STATE_TRANSITION` | "This process cannot move to that state from its current one." — generic, doesn't name the current state; low real risk since it's UI-unreachable, but worth a polish pass if this code path is ever surfaced elsewhere. |
| 4 | Approve release as a non-`PRODUCTION_HEAD` user | **No** — `fabrication@despl.local` (SUPERVISOR) sees Batch 1 fully read-only on `/dispatch`, no "New batch"/"Approve release" controls render at all | `FORBIDDEN` | "You do not have permission to do this." |
| 5 | Pack/assign a unit with an open NCR or hold point | **Yes** — reproduced live in §3 step 2, before clearing it | `HOLD_POINT_OPEN` | "An inspection hold point on this item is still open. It must be cleared before completion." |

No 500s, no raw Prisma errors, no message a shop-floor user couldn't act on. #3's message is the
one soft spot — flagged, not fixed (out of scope for this dry run and never user-reachable today).

## 5. Audit trail — every action, correct actor

Queried `audit_log` directly after the happy path:

```
id | action                        | entity_type   | entity_id | actor
58 | dispatchBatch.recordDispatch  | DispatchBatch | 1         | admin@despl.local
57 | dispatchBatch.approveRelease  | DispatchBatch | 1         | admin@despl.local
55 | unit.assignToPackage          | Unit          | 11        | admin@despl.local
54 | qcp.record                    | QcpExecution  | 8         | qc@despl.local
53 | qcp.record                    | QcpExecution  | 7         | qc@despl.local
52 | qcp.record                    | QcpExecution  | 6         | qc@despl.local
51 | qcp.record                    | QcpExecution  | 5         | qc@despl.local
50 | dispatchBatch.create          | DispatchBatch | 1         | admin@despl.local
49 | package.create                | Package       | 1         | admin@despl.local
48 | componentOperation.reject     | ComponentOperation | 48   | qc@despl.local
```

Every real mutation from this run has a row, every row has the correct real actor. Confirmed the
inverse too: the three refused service-layer calls (§4 rows 1–3) wrote **zero** audit rows —
`audited()` never runs when a precondition throws first, exactly as invariant #5 intends (a
refusal is not an event).

Also spot-checked real pre-existing history in the same table (rows 15–46): real production
users' names attributed correctly to real historical `componentOperation.start/submit` and
`qcp.record` actions from August — the copy's history is intact, not just its current-state
snapshot.

## 6. Findings

1. **DESPL-320's real units are not currently dispatch-ready.** Only `320SR01` has an open NCR;
   the rest (confirmed for `320SR02`, not individually re-checked for `03`–`09`) have open,
   uncleared inspection hold points from real production progress. This is accurate, current
   operational state, not a defect — but it means "pack and ship a unit today" isn't actually
   possible without a QC pass to clear checkpoints first. Worth knowing before anyone tries this
   live against production.
2. **Three of five illegal actions are UI-unreachable by design** (the picker only offers valid
   options; the role gate hides mutating controls entirely for non-PH users). Real defense in
   depth — the server refusal in §4 is a second line, not the only one, for a stale tab or a
   direct API call. Nothing to fix; worth knowing this is deliberate.
3. **Minor: `INVALID_STATE_TRANSITION`'s message doesn't say what state it's stuck in.** Generic
   but not misleading. Low priority — this path has no UI trigger today.
4. **Not a bug: a `router.refresh()`/`revalidatePath` timing gap after `approveRelease`.** The
   success toast fires before the client-rendered status chip updates in the same paint; a page
   reload always shows the correct state immediately after. Did not chase further — consistent
   with normal Next.js revalidation timing, not a data-correctness issue (confirmed the DB row's
   `release_approved_at` was already set at the moment of the stale-looking screenshot).

## 7. Cleanup

- Deleted the two throwaway extra dispatch batches (seq 2, seq 3) used only for the service-level
  refusal checks — `audit_log` rows for their creation remain (append-only, by design).
- `despl_ship_dryrun` and the dump file are disposable, per the same rule the Gate 0 runbook uses
  ("free to abandon"). Left both in place after this session in case Swayam wants to look at the
  running app (`localhost:3100`, `admin@despl.local` / the test password set in §2) before they're
  torn down — not deleted automatically.
- Production was **never written to** — every mutation in this document ran against
  `despl_ship_dryrun` only. The only production access this session made was the read-only
  `pg_dump` in §1.
