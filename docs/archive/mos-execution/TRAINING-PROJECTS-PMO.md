# Training Session — Projects / PMO

Department #1 in `CUTOVER-PLAN.md`'s order. Supersedes `TRAINING-PLAN.md` Session 3's generic
department-head content for this specific department — Projects/PMO's actual daily job is job
creation, and everything downstream in the system depends on it being done right.

**Audience:** whoever creates jobs today from a client PO/order — Projects/PMO lead + anyone else
who touches `/jobs/new` in practice.

**Format:** hands-on, ~30 min, in the running system with a real login (`admin@despl.local` or the
department's own provisioned account, once §3's login-model decision is made — see note at the
bottom). Not slides.

---

## 1. Why this department goes first (2 min)

Every other department's cutover depends on jobs existing correctly in the system. A job created
wrong here (wrong family, wrong template version, missing units) produces confusing gate refusals
for Engineering, Stores, and Fabrication weeks later, at a point where it's much harder to trace
back to "the job was set up wrong on day one." Getting this right matters more than speed.

## 2. Walk through `/jobs/new`, end to end (15 min)

Use a real or disposable test job — not the live tenant's real next job number, to avoid
colliding with `DUPLICATE_JOB_NUMBER` on a real job number DESPL actually wants to use next.

1. **Job number and client.** Show `DUPLICATE_JOB_NUMBER` — deliberately re-enter an existing
   number and let it refuse, so the trainee has seen it once before it happens for real.
2. **Family and template version selection.** Explain: only a *published* template can be used
   (`TEMPLATE_VERSION_NOT_PUBLISHED` if they try a draft) — and once a job is created against a
   published version, that version is locked for the life of the job (`TEMPLATE_VERSION_LOCKED`
   is Engineering's problem if they try to edit it later, not Projects' — but Projects should
   know why the version they pick matters and can't be casually swapped).
3. **Excluding an optional process.** Show how to exclude a process this job doesn't need (the
   real Gate 2 exit test excluded "Painting/Coating" — same mechanism). Point out this is a
   one-time decision at creation, not something to leave for later.
4. **BOM copy / units.** If the job copies a BOM with typed components, mention (don't dwell on)
   that this is what lets Stores/Fabrication see live material-shortage gating later
   (`MATERIAL_NOT_AVAILABLE`) — Projects doesn't need to manage this, just understand why getting
   the BOM link right at creation matters downstream.
5. **Confirm and create.** After creation, the success screen shows unit/process/QCP-item/
   BOM-line/component/assembly-step counts for the new job — a sanity check that it materialised
   correctly. If any count looks obviously wrong for the equipment type, flag it immediately
   rather than assuming it'll sort itself out downstream.

## 3. Job status and health (5 min)

- `/jobs` and `/dashboard` — where Projects/PMO tracks portfolio health day to day.
- `setJobStatus` — ACTIVE/ON_HOLD/CANCELLED are theirs to set; `COMPLETE` will correctly refuse
  (`JOB_HAS_INCOMPLETE_PLANS`) while real work is still open — that's expected, not a bug to
  report.

## 4. The refusal guide, handed over (3 min)

`docs/USER-GUIDE-WHY-WAS-I-REFUSED.md` — specifically the "Department Heads / Production Head"
and "Administrators and Engineering" sections cover most of what Projects/PMO will see
(`DUPLICATE_JOB_NUMBER`, `TEMPLATE_VERSION_NOT_PUBLISHED`, `SCHEDULE_DATA_MISSING` if a process
has no confirmed duration yet).

## 5. What happens to jobs already running (2 min)

Remind them of the decided cutover rule (`CUTOVER-PLAN.md` §4): any job already running in the
Projects/PMO spreadsheet at cutover finishes there — it is never re-entered into the system. Only
jobs created *after* cutover go through `/jobs/new`. Make sure whoever's in the room knows which
of their current jobs that applies to, so there's no ambiguity on cutover day.

---

## Before this session can run for real

**Login model is still an open decision** (`CUTOVER-PLAN.md` §3 / open decision #2) — whether
Projects/PMO gets one shared login or individual named logins. This session can be delivered
either way (the walkthrough doesn't depend on it), but provisioning the *real* account(s) the
trainee will use afterward does. If that decision isn't made yet, run this session against
`admin@despl.local` or a disposable test account, and provision the department's real account(s)
as soon as the decision lands — don't block training on it.

## After this session

- Check the box in `CUTOVER-PLAN.md`'s tracking table for Projects/PMO's "Trained" column —
  only once this has actually been delivered to the real person(s), not when this document was
  written.
- Move to cutover day for Projects/PMO per `CUTOVER-PLAN.md` §2.

---

## Live-verified, 6 Sep 2026

Every step above was walked through for real — real `/login` as `admin@despl.local` against local
dev (`unset DATABASE_URL` first; the known stray shell-level override to `vedanta_test` was
present again this session, same gotcha `progress.md`'s "Phase C begins" and "B7+B8" sessions
already logged twice), not simulated:

1. **`DUPLICATE_JOB_NUMBER`, live**: re-entered `DE0463` (an existing job) as the job number and
   pushed all the way to Review → Create job. Got the exact refusal, **plus a UX detail worth
   telling the trainee about that isn't in the refusal guide's plain-text version**: the review
   screen shows "A job with this number already exists" alongside a **"View existing job →"**
   link — better than a bare error message.
2. **Excluding an optional process, live**: unchecked "Painting / Coating" (row 30 of the
   36-process Pressure Vessel route) — the row struck through immediately, and the Review
   screen correctly summarized "Processes: 1 excluded."
3. **Equipment type is genuinely optional**: `equipment_type_id` on `Component`s created here
   is nullable in the app's contract with existing tests confirming `equipmentTypeId: null` and
   in production data (`DE0463-B1`, `DE0467-B1`, etc. all have it null) — leaving "Select
   equipment type…" unset does not block job creation.
4. **Created a real job**: `TRAINING-PMO-01` — 1 unit, 36 processes, 0 QCP items, 0 BOM lines,
   0 components, 54 assembly steps. Confirms the success-screen wording in step 2's script.
5. **`SCHEDULE_DATA_MISSING`'s user-facing cousin, live and unscripted**: the created job showed
   a **"NO SCHEDULE YET"** badge — "The job was created, but dates cannot be computed yet — this
   process route has processes with no confirmed duration." This is worth adding to the live
   walkthrough script (§2 step 5) since a trainee will very likely see it on their first real job
   too if any process on the route lacks a confirmed duration.

**Real finding, not part of this training item but worth a separate look:** `equipment_type_refs`
is completely empty in this local dev database (0 rows, confirmed with a superuser connection
bypassing RLS — not an RLS artifact). `product_families` and route templates are populated
(Phase C's C1/C6/C7 work), but no one ever authored actual Equipment Types through `/admin` on
this local copy. Not a blocker (the field is optional, confirmed above) but means this local DB
cannot currently demo the equipment-type-driven default-spec-prefill behavior mentioned in
`equipment_type_refs.default_specs`/`default_design_code`. Someone doing a fuller live rehearsal
of Configuration-step defaults will need to author at least one Equipment Type first, or use a
DB copy that already has one.

Test job `TRAINING-PMO-01` was left in place afterward (harmless local-dev clutter, matching
`S20-EXIT-TEST`/`PIPE-SPOOL-TEST-2` already sitting in the same dashboard) — not cleaned up.
