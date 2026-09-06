# Cutover Plan — 13 Departments Off Spreadsheets

Covers M1 (per-department cutover), M2 (in-flight jobs), M3 (user provisioning), M4 (account
recovery), and M7 (user-acceptance sign-off) from `docs/mos-blueprint/execution/24_DESPL_MOS_PLAN_GAPS.md`
Phase M. Gate 4 exit ("13 departments off spreadsheets," `LEDGER.md`) depends on this plan being
executed, not just written.

**This is a plan draft, not a completed rollout.** The items marked **NEEDS SWAYAM** below are
real decisions only Swayam/DESPL can make — the shape of cutover changes depending on the answers.

---

## 1. The 13 departments, in cutover order

Source: `seed/lead-time-model.json` → `departments`. Grouped by whether the department's daily
work is mostly *office* (planning, records, approvals — lower shop-floor disruption risk if the
system has a bad day) or *shop floor* (physical work gated by the system in real time — a bad day
here can stop production).

| Order | Code | Name | Type | Why this order |
|---|---|---|---|---|
| 1 | `PROJECTS` | Projects / PMO | Office | Job creation happens here. Everything downstream depends on jobs existing correctly in the system first. |
| 2 | `ENGINEERING` | Design & Detail Engineering | Office | Drawing release gates Fabrication (S18) — must be live before Fabrication cuts over. |
| 3 | `PLANNING` | Planning / PPC | Office | BOM/MTO and schedule ownership — needed before Procurement or Stores can act on real data. |
| 4 | `PROCUREMENT` | Procurement | Office | Feeds Stores' GRN and the material-shortage gate (S20/S21). |
| 5 | `STORES` | Stores | Office/shop boundary | Stock lots must exist before Fabrication can start (`MATERIAL_NOT_AVAILABLE` gate). |
| 6 | `FABRICATION_PREP` | Fabrication Prep | Shop floor | First physical stage in the pipeline (cutting/blanking/forming). |
| 7 | `MACHINE_SHOP` | Machine Shop | Shop floor | Parallel to Fab Prep in most routes; low interdependency risk to cut over alongside it. |
| 8 | `FABRICATION` | Fabrication / Welding | Shop floor | The highest-volume gated stage (fit-up/weld/assembly) — cut over only once upstream gates (drawing, material) are proven live. |
| 9 | `QC` | Quality Control / QA | Shop floor | Gates almost everything downstream (hold points, NCRs, maker-checker). Must be confident and trained before Fabrication is fully live, or refusals will look like the system failing rather than working. |
| 10 | `HEAT_TREATMENT` | Heat Treatment | Shop floor | Sequential after welding on PWHT-requiring jobs. |
| 11 | `SURFACE_PAINT` | Surface Treatment & Painting | Shop floor | Depends on the DFT gate (S-Phase 5) being understood by QC first. |
| 12 | `DISPATCH` | Dispatch & Logistics | Shop floor | Last physical stage — the Gate 1 exit flow (Package → DispatchBatch → release → dispatch) is already proven end to end. |
| 13 | `DOCUMENTATION` | Documentation / MDR | Office | MDR compilation happens after the physical work is done; least time pressure to go first. |

**DECIDED (Swayam, 6 Sep 2026): keep this order as-is.** QC stays 9th, after the departments it
depends on (Stores, Fab Prep, Machine Shop, Fabrication) are already live — dependency order wins
over giving QC a longer solo runway.

---

## 2. Per-department cutover procedure (repeat 13 times)

For each department, in the order above:

**T-minus 1 week**
1. Confirm every real person in the department has a provisioned account (§3) with correct
   role + department scope.
2. Run that department's 30-minute training session (see `TRAINING-PLAN.md`).
3. Give the department head the relevant section of `docs/USER-GUIDE-WHY-WAS-I-REFUSED.md`
   (printed or a bookmark) — the single biggest source of "the system is broken" complaints in
   week one is an unexplained refusal.
4. Confirm the department's current in-flight jobs' status per §4 (data migration decision).

**Cutover day**
1. Pick a low-stakes moment — start of shift, not mid-batch on a hot job.
2. Department stops updating the spreadsheet for **new** entries as of a stated cutoff time.
   Anything already in progress on paper/spreadsheet at cutover finishes on paper (§4, option B)
   or gets a one-time manual entry into the system (§4, option A) — the decision must be made
   before this step, not during it.
3. Department head or supervisor logs in for real and performs the department's first real
   action in the system, live, with someone from this project watching (not a forged session,
   not a demo tenant — the real login, matching this project's own verification standard).
4. Watch for refusals in the first hour. Anything that looks like a bug (500, raw error, a
   message nobody can act on) gets escalated immediately — do not let a department conclude
   "the system doesn't work" over something fixable.

**T-plus 3 days**
1. Check in with the department head: anything that felt wrong, anything they worked around by
   going back to the spreadsheet.
2. Log every piece of feedback per §5 (feedback loop), even if it seems small.

**T-plus 1 week — sign-off (§6)**
1. Department head (or the QC inspector, for QC) confirms the sign-off checklist.
2. Mark the department's row in the tracking table below.

---

## 3. User provisioning (M3) — DECIDED

**Decided (Swayam, 6 Sep 2026): individual logins, one per real named person.** Not the shared
department-account model `scripts/create-department-accounts.ts` set up for D3/D4
(`fabrication@`, `qc@`, `production@`, `procurement@`) — those 4 accounts stay as they are (they
predate this decision and nothing requires unwinding them), but every account provisioned for
cutover from here on is a real named person, not a role mailbox.

**Why:** the maker-checker rule (invariant #3, "the same person cannot submit and verify their
own work") only means something if a login maps to one actual human. Under a shared account,
"a different QC user must verify" degrades to "someone else was logged into the QC terminal" —
unprovable from the audit trail alone.

**No new tooling needed.** `/admin`'s Employees table already has a working "Add employee"
dialog wired to the real `createUser` service (`admin.service.ts`) — the same one
`scripts/create-department-accounts.ts` calls, just through the UI instead of a script. Per
department, per real person:
1. Admin opens `/admin`, clicks "Add employee," sets name, email, role (`SUPERVISOR`/`QC`/
   `PRODUCTION_HEAD`/etc.), and department scope.
2. A `SEED_PASSWORD`-derived or admin-set temp credential is generated, `mustChangePassword`
   forced (same mechanism as D3/D4's rotation).
3. Credentials handed to that person in person — not over chat, not printed on a shared sheet.

This means provisioning workload is genuinely "13 departments × however many real people work in
each," not 13 flat accounts — heavier than the shared-account model, but it's what makes the
gating rules actually mean something once cutover starts.

---

## 4. Data migration for in-flight jobs (M2) — DECIDED

**Decided (Swayam, 6 Sep 2026): Option B — in-flight jobs finish on the old system; only new
jobs start on the MOS.** No manual re-entry of a running job's physical state, no risk of a bad
manual entry producing a false gate refusal on real work. Matches how Gate 1 already treated
DESPL-320 (dry-run only, no live unit forced through early).

**What this means in practice, per department:**
- Any job that has already started in a department's spreadsheet at that department's cutover
  time stays on the spreadsheet through to completion. It is never entered into the system.
- Every job that *starts* after a department's cutover time goes through the system from
  `/jobs/new` onward.
- There will be a transition window — potentially several weeks, until every in-flight job at
  cutover finishes — where a department is running both the spreadsheet (for old jobs) and the
  system (for new ones). This needs to be visible: keep a one-line note per department in the
  tracking table (§ Tracking table) of which job numbers are still finishing on the old system,
  so nobody has to guess which system to check for which job.
- No migration script, no backfill job, nothing to build for this — it is a process decision,
  not a technical one.

---

## 5. Feedback loop (M8)

There is currently no structured place to capture "this screen doesn't match how we actually
work." Given `docs/mos-execution/LEDGER.md`'s own convention (a running markdown ledger, one row
per item, git-tracked), reuse the same pattern rather than standing up a new tool:

**DECIDED (Swayam, 6 Sep 2026): the markdown log is enough — no in-app feedback button.**
`docs/mos-execution/CUTOVER-FEEDBACK.md` created, one row per item: date, department, who raised
it, what they said, and a status (open / addressed / declined-with-reason). Department heads
report feedback verbally or via a shared channel to whoever runs this project day to day; that
person logs it. Reviewed weekly during the cutover window.

---

## 6. User-acceptance sign-off per department (M7)

Engineering "done" (tests pass, code reviewed) is not the same bar as a department actually
accepting the system for their real work. Sign-off checklist, per department:

- [ ] Every real person who needs an account has one, and has changed their temp password.
- [ ] The department head (or QC inspector for QC) has completed their training session.
- [ ] The department has performed at least one full real cycle of their actual daily work in
      the system (not a demo) — e.g. Fabrication has submitted and had a real QC verify a real
      operation; Stores has recorded a real GRN.
- [ ] No open T-plus-3-days feedback item is rated "blocking" by the department head.
- [ ] The department head explicitly states, in writing (an email or a line in
      `CUTOVER-FEEDBACK.md` is enough — doesn't need to be formal), that they accept the system
      for their department's daily work.

A department is **cut over** only when every box above is checked. "The code works" is not
sign-off; the department head's own statement is.

## Tracking table

| # | Department | Trained | Cutover day | 3-day check-in | Signed off |
|---|---|---|---|---|---|
| 1 | Projects / PMO | ☐ | | ☐ | ☐ |
| 2 | Design & Detail Engineering | ☐ | | ☐ | ☐ |
| 3 | Planning / PPC | ☐ | | ☐ | ☐ |
| 4 | Procurement | ☐ | | ☐ | ☐ |
| 5 | Stores | ☐ | | ☐ | ☐ |
| 6 | Fabrication Prep | ☐ | | ☐ | ☐ |
| 7 | Machine Shop | ☐ | | ☐ | ☐ |
| 8 | Fabrication / Welding | ☐ | | ☐ | ☐ |
| 9 | Quality Control / QA | ☐ | | ☐ | ☐ |
| 10 | Heat Treatment | ☐ | | ☐ | ☐ |
| 11 | Surface Treatment & Painting | ☐ | | ☐ | ☐ |
| 12 | Dispatch & Logistics | ☐ | | ☐ | ☐ |
| 13 | Documentation / MDR | ☐ | | ☐ | ☐ |

Gate 4 exits when all 13 rows are fully checked.

---

## Open decisions blocking execution (summary)

1. ~~Cutover order — confirmed as-is, or move QC earlier? (§1)~~ — **DECIDED 6 Sep 2026: keep as drafted.**
2. ~~Shared vs. individual logins per department? (§3)~~ — **DECIDED 6 Sep 2026: individual logins.**
3. ~~In-flight jobs: migrate (A) or finish-on-old-system (B)? (§4)~~ — **DECIDED 6 Sep 2026: Option B.**
4. ~~Is the lightweight markdown feedback log enough, or is an in-app feedback mechanism wanted? (§5)~~ — **DECIDED 6 Sep 2026: markdown log.**

All four planning decisions are closed. Nothing left to plan — the remainder of Gate 4 is
execution: provisioning real people (§3), running training sessions (`TRAINING-PLAN.md`), and
walking all 13 departments through cutover day, 3-day check-in, and sign-off (§2, §6). That work
requires real people at DESPL and cannot be done by an agent — see `LEDGER.md`'s row for what's
left.
