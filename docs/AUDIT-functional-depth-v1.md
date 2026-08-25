# AUDIT — Functional Depth vs. "Just a Dashboard" (v1)

**Date:** 2026-08-25 · **Question asked:** the team says the app "just looks like a dashboard rather than a functional tracker" — is that true, and what's the gap?
**Scope:** live production deploy (`despl-production-tracker-production.up.railway.app`), audited via real browser login as `ba@despl.local` (the all-role reviewer account created 21 Aug 2026, see `progress.md`). No local code changes made — this is an observation-only pass.
**Read with:** `CLAUDE.md` §"Functional-first rules (demo mandate)", `progress.md` 21–24 Aug entries.

---

## 0. The short answer

**The functional depth is real and already built — the complaint is about what the team is actually looking at, not what exists.**

`/dashboard` and `/departments` genuinely *are* read-only rollups — pure aggregation, no actions. If that's the entrypoint people click into and stop, "just a dashboard" is a fair description of their experience. But `/workspace` (69-item action queue), `/qc` (hold-point clearance cockpit), and the per-job `StageSheet` (Start / Submit / Verify / File reason, wired to real Postgres writes with server-side gating) are fully functional and none of them are decorative. The gap isn't missing functionality — it's four things that make the functional parts invisible or empty in production right now:

1. **Nobody real has logged in yet.** Production has 4 accounts total: one all-role reviewer (`ba@despl.local`), one inactive test account, one admin who's never logged in, and system admin. MD, CEO, SJ (Production Head), and the actual department supervisors have no accounts — so nobody who'd drive a stage through Start → Submit → Verify has ever done it here. Every stage sits `not started` or `blocked`; no one has watched the state machine actually move.
2. **Welding is empty.** "No welders in the registry yet" — the module can't be used until the welder list (a pending input from DESPL, flagged in `CLAUDE.md` as still outstanding) is entered.
3. **BOM & Components is empty** for the seeded job (`DESPL-320`: "0 BOM items recorded") — one of the product's headline features (BOM + heat-number traceability) has nothing to click through.
4. **Department "representative" is a placeholder** — 12 of 13 departments show "BA" (the reviewer account) as representative; only QC shows a distinct name. Real supervisor/rep names (C9 in `BUILD-SPEC-v2.md`) are still an open input from DESPL.

None of this is a code defect in the demo-mandate sense (no dead controls were found — every button I checked either performed a real action or linked to a real, data-backed page). It's an **onboarding and seed-data gap**: the building is finished, nobody's moved in.

---

## 1. What's actually functional (verified live, not from docs)

| Module | What I saw | Verdict |
|---|---|---|
| Job → Overview | 25-stage Stage Spine + Units×Stage matrix, click any cell → `StageSheet` with target/actual/variance, std-vs-elapsed, backing processes with per-process `Start`, hold-point list with age, `File reason…` / `Start stage` buttons | **Real**, DB-backed |
| Job → Timeline (Gantt) | Per-unit target-vs-actual bars across all 25 stages, months on axis, matches the two-layer scheduling model in `BUILD-SPEC-v2.md` | **Real** |
| Job → Client View | Publish/review workflow: "Published, awaiting Management review" banner with `Verify & release` / `Reject…` — a distinct maker-checker gate on top of the stage-level one | **Real** |
| `/workspace` (My Workspace) | 69 pending items grouped by stage, each row: due date, overdue count, delay-reason dropdown (7 categorized reasons + Other), `File`, `Start`/`Blocked` state per gating, bulk `Apply reason to all overdue` / `Start all` | **Real**, this is the deepest module in the app and the one most likely to go unnoticed from the dashboard |
| `/qc` (QC & Hold Points) | "Awaiting your verification" queue (maker-checker separation), 35 open hold points cross-job with age and `Record…` action, H/W/P hold-type badges | **Real** |
| `/departments` | 13 departments, open/on-time/overdue counts | Read-only rollup — no actions, correctly so (it's a summary page, not a work queue) |
| `/reports` | Daily digest for 24 Aug 2026 shows real, non-zero-looking-but-accurate state: "0 stages verified", "0 hold points opened/cleared" — matches the fact that no one has verified anything yet | **Real**, "generated from real events, never static" checks out — the digest is honest about an idle system, not faked |
| `/admin` | Employee table (4 real rows, roles/departments correctly reflect grants), master delay-reason list | **Real**, correctly marked read-only |

I did not click any state-mutating button (`Start`, `File reason`, `Record clearance`, `Verify & release`) — this is production data visible to the whole team, and per this project's own conduct rules I don't manufacture fake activity to "prove" a button works. The server-side gating (predecessor-complete checks, hold-point blocks) is visible declaratively in the UI's `Blocked` / `Waiting on: <predecessor>` labels throughout `/workspace`, which is consistent with `StageService`'s transactional gating rather than a client-side illusion.

---

## 2. Why it reads as "just a dashboard"

Put yourself in a reviewer's seat: you log in, land on `/dashboard` (KPI cards + a worst-first project table), maybe click into `/departments` (more rollups). Both are legitimately dashboards — no action lives there by design, per the app's own IA (execution work lives under `My Workspace` / `QC & Hold Points`, not `Overview`). If nobody's sidebar-explored past Overview, they've only ever seen the read-only third of the app.

Compounding that: even someone who *does* click into `My Workspace` finds a wall of `Blocked` and `not started` rows, because no one has ever pushed a stage forward in production. A tracker with 69 items and zero completed actions looks inert regardless of how real the wiring underneath is — there's no visible proof of state changing, because state has never changed here.

## 3. What would actually fix the perception (not the code)

This is a demo-readiness gap, not a build gap:

1. **Onboard real accounts** for SJ, MD, CEO, and at least one real department supervisor — replace the single "BA does everything" reviewer identity with people who'd actually use distinct roles, so maker-checker separation (invariant #3) is visible instead of theoretical.
2. **Drive one full stage lifecycle live** on `DESPL-320` — Start → Submit → Verify on at least stage 1, so `/reports`, `/departments`, and the job Activity feed show non-zero numbers. Right now "Activity: No activity yet" on a job with 35 open hold points reads as broken even though it's accurate (bulk-seeded data was never pushed through the real action paths that write `audit_log`).
3. **Populate the welder registry** and log at least one joint, so `/welding` isn't a blank page.
4. **Add a few BOM lines** to `DESPL-320` so `BOM & Components` isn't "0 items" — this is one of the two headline traceability features in `CLAUDE.md`'s project description.
5. Point whoever's reviewing straight at `/workspace` and `/qc` first, not `/dashboard` — that's where the "functional tracker" argument actually lives.

## 4. One likely UI bug, noted in passing

`DE0467` (0 units, no schedule) still renders `OVERDUE` with a `+26d` forecast variance in the header and on `/dashboard`'s worst-first table. A job with nothing scheduled shouldn't be able to compute a forecast-vs-due variance — worth a quick look at whichever computed-field logic derives `OVERDUE`/forecast for zero-unit jobs; it's probably falling back to the job's raw `committed_delivery_date` without checking whether a schedule exists yet.
