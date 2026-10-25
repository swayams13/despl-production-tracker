# DESPL Production Tracker: go / no-go report, 25 Oct 2026

Checked 24–25 Oct 2026 on production (read-only) and on staging (with test writes), through the real login screens in Chrome. Code reference: `main` = `44e9fd7`.

## Verdict

| Question | Answer |
|---|---|
| Is the code and platform healthy? | **GO** |
| Can the team start using it on production today? | **NO-GO** |
| Is the write path (floor rules, QC, dispatch with real data) proven? | **Partly.** See the test table. |

The platform is healthy and the new screens work. The team cannot use it yet because the floor screens are off on production, there are no real team logins, and master data is empty. The one probable blocker found, QC unable to accept the document and material gate steps, was fixed and verified on staging the same day (PR #158).

## Status update, 25 Oct 2026 evening
Since this report was first written:
- **QC gate-steps issue fixed and verified on staging** (PR #158, merged, deployed to production and staging).
- **New jobs get the weld, PWHT and hydro rules** (PR #159, merged). The roles script was applied on **staging** (v2) and on **production** (v2: 31 roles, 25 pressure flags; v1 untouched; DESPL-320's own rows were already complete). Verified on a new staging job: H1 (weld before fit-up) and H4 (hydro before final PWHT) now refuse with plain-English reasons.
- **Production backfills applied** (by Swayam): 8 config questions, 14 planned joints and 126 linked steps for DESPL-320, 3 equipment types (PV-VERT-SKIRT active) with the skirt template and kit, 10 milestones and 36 map rows. All read back clean. Details: `PRODUCTION-ROLES-SCRIPT-25-OCT.md`.
- **Still NO-GO for the team.** Open: `LEAN_FLOOR` off on production, no real team logins, master data and part families empty, placeholder client names (no rename path in code), DESPL-320 indent/PO and joint confirmation, H5/H6/dispatch not yet exercised, QC cannot raise an H5/H6 NCR from any screen, credentials rotation.

## What was verified

**Railway and deploys**
- The 21 Oct incident is over: status page shows dashboard, API, builds and deployments unaffected (25 Oct).
- Production deploy `1c575d85` (23 Oct 20:21 IST) is SUCCESS. Its log reads "91 migrations found" and "All migrations have been successfully applied", listing all 9 queued migrations (`j4a_planned_joints` through `j5c_release_diff`). The container then started and was Ready.
- Production and staging both serve `44e9fd7`. `/api/health` is 200 on both. Pages load in about 1 to 1.5 s with no console errors on the pages walked (one React #418 hydration warning, minor).
- Security headers present (HSTS, X-Frame-Options DENY, nosniff). The CSP is report-only. Unauthenticated requests redirect to `/login`; `/api/export` returns 401.

**Production (read-only, as Admin)**
- Portfolio, jobs list, DESPL-320 job tabs (overview, board, assembly with 54 steps, QC, dispatch), `/qc`, `/materials`, `/admin`, `/jobs/new` start screen, BOM release and weld-map pages all render.

**Staging (test writes, as SJ, QC One, Supervisor Fab, Stores)**

| Test | Result |
|---|---|
| Copy DESPL-320 as draft; five-step wizard with live preview | Pass |
| Create job `DRY-RUN-001` | Pass |
| BOM release (revision 1): 54 steps | Pass |
| Legacy Start out of order | Refused in plain English |
| Verify by a user without the QC role | Refused ("You do not have permission to do this") |
| Dispatch batch create | Pass |
| `LEAN_FLOOR=on` on staging; `/today`, `/scan`, `/team`, `/jobs/<id>/switch-over` | Pass (all render) |
| Floor unit page: "Out of usual order" flag | Pass |
| Start early as supervisor: reason required, flagged for Production Head | Pass |
| Done on a step: goes to the QC queue; QC accepts it (maker is a different user) | Pass |
| Backdate 15 days | Refused ("That time is before the job was released to the floor. Choose a later time.") |
| Stores: queue, record heat number and MTC reference | Pass; MTC stays PENDING for QC |
| Stores: route actions limited to MTC Verification | Pass |
| QC reject and accept on a gate step | Refused on 25 Oct morning (wrong message, defect 1). **Fixed by PR #158 and re-verified on staging:** gate steps now show under "Ready to inspect"; accept completes one (queue 8 to 7); reject opens an NCR (NCRs 1, Open holds 1); a regular step with a real maker is accepted. |

## Not tested (unknown, not failed)
- Hard rules H1 to H6, late reason on Done, concession and ratify, the same-person maker-checker. The test job has no weld map, no components and no completed work, so most hard rules could not be exercised.
- QC accept and reject on a work step, a successful dispatch, hydro and PWHT records.
- Stores receive and issue clicks, the heat pick on a cutting step.
- Phone and tablet width (window resize did not work in this Chrome session), traveller printing, QR scan with a camera, load on floor Wi-Fi.

## Defects and gaps found

**Fixed**
1. **QC could not accept inspection steps that have no preceding work step in their group** (gates 1.1 to 1.3, 2.1, 3.1 to 3.3 and group-head clearances such as 4.2, 4.9, 4.15, 5.1, 6.1, 8.1). `inspect` refused them with `MAKER_CHECKER_VIOLATION`, and the QC queue never listed them. **Fixed in PR #158** (merged `a0b9653`, production deploy `30c1758d`, staging `6d8b5e98`; no migration): QC accepts alone when nothing was built before the step; a group-head clearance waits for the unit's earlier work. Decision: Swayam, 25 Oct; default to ratify with SJ and the QC head: the unit-wide fallback. Verified on staging as `demo.qc1`. Not re-verified on production data.
2. **The misleading "same person" text for that case** no longer occurs, because the case is gone. Real same-person refusals still show it.

**Found in Session A, fix in review (PR #159)**
1b. **New jobs get no weld, heat-treatment or hydro rules.** On staging a weld was started and Done before its fit-up on the same joint (accepted, sent to QC), and hydro showed no final-PWHT refusal. Cause: every new job step copies its role, joint and pressure flag from its template step, and the published Pressure Vessel template v1 has no role on any of its 54 steps in every environment (a freshly seeded DB too). H1 and H4 to H6 were silently off for new jobs; paint-after-hydro still worked because it keys on the process number. DESPL-320 on production is not affected (its 279 rows were given roles on 18 Oct). Fix: `scripts/lean-publish-assembly-roles.ts` publishes a new template version with the roles (rehearsed: 31 roles, 25 pressure flags, v1 untouched), plus a release warning when a sequence has no roles. Needs applying on staging and production (backfill doc step 3, before the equipment-type step), then Session A to be re-run on a new job.

**UX risks**
3. **Start and Done have a 6-second Undo window and commit only after it ends.** Navigating or closing the tab inside that window drops the action without a warning. Confirmed once during testing. On a shop-floor phone this loses updates.
4. **Verify and Reject buttons are shown to users who cannot use them** (legacy assembly tab). The refusal is correct; the buttons should not be there.
5. **Silent no-ops.** An empty reject reason, and Start early with no reason, do nothing and show no hint.
6. After **Create job**, the wizard shows "This draft was already turned into a job" instead of a result step with a link to release the BOM.
7. The wizard preview says 54 assembly steps, but the job's Assembly tab says "No assembly template pinned" until the BOM is released.
8. The released-BOM panel shows "Linked to QC plan points 0" while its summary says 25.
9. The wizard review says "BOM: Copied from a previous job" when no source line was chosen and there were 0 BOM lines.
10. `/materials`: "To issue" repeats the same four lines as "To identify", and the IN column is inconsistent with the "Received" status on the line.
11. Dashboard S-curve legend reads "Actual · -100%".

**Data and configuration**
12. **`LEAN_FLOOR` is off on production.** `/today`, `/scan` and the switch-over page return 404. On staging it is now on (set 25 Oct, redeployed, verified).
13. **No real team logins on production.** Only the old Sept accounts (`fabrication`, `procurement`, `production`, `qc`, `stores`) and two admins. No second QC, no Planning/PPC, no MD, CEO or SJ. `ba@despl.local` held Client, Management, Production Head, QC and Supervisor across all 13 departments: it was deactivated on 25 Oct and is now INACTIVE.
14. **Equipment types and master data are empty on production** (and equipment types on staging). Part families, equipment types, standard kits, design questions: none loaded. The DESPL-320 pilot is unaffected (existing job); the DE0423 fallback is blocked.
15. **Placeholder client text** appears on production and staging: "Unknown client — pending DESPL confirmation (no client/customer name present in live-jobs.json)" and "(entangled with workOrderNoInFile 'DE0455-01', see Job.remarks)". It shows on the dashboard, jobs list, new-job screen and the printed traveller.
16. **DESPL-320 on production is not ready for Stores.** No indent or PO, so it is missing from `/materials`; weld map has 0 joints; stale Sept demo data (a BA submission and a "Kick-Off" rejection on 320SR01); a test job (12548, "bharat") is also present.
17. 33 open hold points on DESPL-320 are all "Awaiting TPI". The QCP source text has a typo ("PROCEUDE").

## What has to happen before handover (in order)

1. ~~Decide on defect 1 (QC gate steps)~~ Done: fixed and verified on staging (PR #158).
1b. **Merge PR #159 and apply the roles script** on staging, then on production (dump first, hotspot), before any new job is created.
2. **Create the real team logins on production** in `/admin` → Add employee…: Stores, a second QC, Planning/PPC, supervisors for Fabrication Prep, Fabrication/Welding and QC, and MD, CEO and SJ with real emails. Then deactivate the old `qc`, `fabrication`, `production`, `procurement` and `stores` accounts once the real ones work. Never delete.
3. **Run the production backfills** from the hotspot per `PRODUCTION-BACKFILL-COMMANDS.md`: dump, pre-flight, dry run against expected counts, then `--apply`. Covers equipment types, config questions, milestones and master data.
4. **Complete the staging dry run**: weld map with joints, issued material and picked heats on DESPL-320 (job 6), then H1 to H6, late reason, a QC accept on a work step, concession and ratify, a successful dispatch, phone width, traveller print, QR scan.
5. **Switch `LEAN_FLOOR` on in production** only on Swayam's go, after step 4 passes. Rollback: set it off and redeploy; floor actions then refuse with `FEATURE_FROZEN`.
6. **Clean the production data:** rename the client text on DE0467 and DESPL-320; enter DESPL-320's indent/PO (or I16) and weld map; clear or explain the stale Sept items; decide what to do with job 12548.
7. **Rotate Railway variables and Postgres credentials** after the deploy is confirmed (done: deploy confirmed 25 Oct). `AUTH_SECRET` rotation signs everyone out, so schedule it.
8. **Refresh the docs and vault:** `WHAT-IS-READY.md` and `CUTOVER-RUNBOOK.md` §9 still describe the builds-paused fallback; vault `CURRENT_STATUS.md`, `TASKS.md`, `CHANGELOG.md` are not synced since 22 Oct.

## Decisions still owed
- D5: on 16 Nov, does DESPL-320 have 4 or more weeks of fabrication left? It shows Start 20 Nov, Due 8 Apr 2027. If not, the DE0423 path applies.
- D3: which steps skip QC, reviewed by the QC head. Until then every step except Receipt and MTC Verification goes to QC, so the second QC login matters.
- Who ticks MTC Verification (the pilot decision names the Fabrication Prep supervisor).
- SMTP for the email digest (off today); Hindi and Gujarati review (do not present as ready).
- Railway spend limit: workspace-wide, and it stopped production on 21 Oct.

## Test data left behind
- **Staging:** job `DRY-RUN-001` (job 8, unit DRYSR01, BOM revision 1 released, dispatch batch 1, step 1.1 submitted, edge preparation done); draft 1; MTC recorded on the DE0463 elbow line (heat `HT-DRY-001`); ten `demo.*` accounts (Stores, two QC, Planner, three Supervisors, Operator, MD, CEO). Their passwords are in a private scratch file, not in the repo.
- **Production:** nothing was written, except deactivating `ba@despl.local`.
