# Admin runbook

For the system administrator (Swayam). Short, in order of how often you need it. Related files are in `docs/pilot-review/`.

## 1. Add an employee

1. Sign in as Admin. Open **Admin**, **Employees**, **Add employee...**
2. Fill **Name**, **Username** (email or employee code, for example `SUP-FAB-03`), optional email and employee code.
3. Tick the **Roles**: Operator, Supervisor, QC / QA, Stores, Planner, Engineering, Production Head, Management, Admin.
4. Tick **Departments**. They are required, except for Management, Admin and Planner.
5. **Password**: leave empty to auto-generate, or type your own temporary one. Tap **Create employee**.
6. The **Employee credentials** box shows the username and temporary password **once**. Tap **Print credential slip**. Hand it over in person.
7. The person **must change the password at first sign-in**. One login per person. Never share a login.

Many people at once: **Bulk import...**

Pilot minimum: one **Stores**, a **second QC** (for concessions and for sharing the queue), a **Planner** in the department that owns processes 1 to 11, **supervisors** for Fabrication Prep, Fabrication/Welding and QC, and **MD, CEO and SJ** with their real emails.

## 2. Change, reset, deactivate

- **Edit**: change roles and departments. You cannot remove your own Admin role.
- **Reset password**: gives a new temporary password and forces a change. For a QC or Admin user, a **different admin must approve** the reset first.
- **Deactivate, never delete.** The person is signed out at once and cannot sign in. Their history stays. Work still assigned to them is not released: ask their supervisor to tap **Reassign** by their name on **Team**. **Reactivate** brings them back.
- Check **Admin** for the old shared accounts (`qc`, `fabrication`, `production`, `procurement`, `ba`). **Deactivate** any still active.

## 3. Departments

There is no screen to add a department. Use the ones set up already and assign people with **Edit**.

## 4. Welders

**Welding**, **Manage welders...** (Production Head or Admin). Add name, employee code, department, **Add welder**. To stop using one, deactivate. Never delete: old weld records point to the welder.

## 5. Delay reasons

**Admin**, **Master delay-reason list**. Type a name, **Add**. Use **Deactivate** and **Reactivate**, never delete. These are the "what held it up" choices on the floor. Keep the list short and plain.

## 6. Master data approval

**Master data** has **Parts**, **Materials** and **Import**.

1. Admin, Production Head or Engineering edits a part and its route steps.
2. A second person taps **Mark reviewed** (not the last editor).
3. The **Production Head** taps **Approve**. A single Production Head may approve his own edits; it is marked self-approved.
4. An approved part is **not edited in place**. Tap **Revise part** with a reason. The approved version stays in use until the revision is approved.
5. **Import** (workbook): everyone with access can check it. Only Production Head and Admin can load it.

## 7. Equipment types and assembly sequence

**Equipment types**: add, edit, **Deactivate**. Each type has a standard kit and its own assembly sequence.

1. Under **Assembly sequence**, choose the type and the workbook name. Tap **Check the workbook** (writes nothing).
2. Fix every row marked **Fix**. Tap **Import as draft**.
3. A **different Production Head** taps **Publish**. The importer cannot publish. Admins are not exempt.
4. Running jobs keep their version. New jobs get the newest published one. A published version cannot be edited: import a new one.
5. Open the step list first and check the inferred roles (fit-up, weld, NDT, heat treatment, hydro) and pressure flags.

## 8. The floor switch (LEAN_FLOOR)

Controls **Today, Team, Scan**, Start, Done, QC accept and reject, heat pick, switch-over.

- **Turn on**: Railway, web service, **Variables**, `LEAN_FLOOR` = `on`, then redeploy. **Staging first.** Check `/today`, `/team`, `/scan` open. Walk `docs/pilot-review/QUICK-START.md` as Operator, Stores, QC and Production Head. Production only on Swayam's go.
- **While off**: those three pages are not found, and floor actions say "This feature is switched off while the pilot runs".
- **Roll back**: set `LEAN_FLOOR` to `off` (or delete it) and redeploy. Nothing is lost. Data stays. The floor actions just refuse again.

## 9. Backfill commands

Run by Swayam only, **from the phone hotspot** (the office network blocks the database), with the owner database role.

- Commands and expected numbers: `docs/pilot-review/PRODUCTION-BACKFILL-COMMANDS.md`.
- Record of the 25 Oct roles run: `docs/pilot-review/PRODUCTION-ROLES-SCRIPT-25-OCT.md`.
- Hand-over order: `docs/pilot-review/CUTOVER-RUNBOOK.md`.
- Office processes one-plan-per-job: `docs/lean-core/L1.3-JOB-GRAIN-RUNBOOK.md`.

Rules: **dump first**. **Dry run first, read it, then add `--apply`.** If a number differs from the file, or the target says `localhost`, **stop**. Pass `--environment production`: the command line tool is linked to staging. Run each in the order written.

## 10. What NOT to do

- **Never run** `scripts/create-department-accounts.ts`. It has fixed accounts and no forced password change.
- Never delete a user, welder, delay reason or record. Deactivate.
- Never use someone else's login, or type a signing key into a script to get in.
- Never run a backfill without a dump and a dry run.
- Never edit a migration that has been applied.
- Never run the database tests against the demo database. Use the test one.
- Never merge to `main` without approval. A merge applies every pending migration by itself.
- Never stage files with `git add -A`. A password file sits untracked in the folder.
- Never paste passwords or keys in chat or tickets.

## 11. Watch

`/api/health` must say 200. Railway's spend limit is for the whole workspace: it stopped production on 21 Oct. Check usage before long jobs.

## To confirm with DESPL

1. Whether the backfills (config questions, planned joints, assembly roles, equipment types, milestones) are all applied. The 25 Oct record says yes. The job-grain backfill is not in that record.
2. Whether the placeholder client names ("Unknown client...") have been renamed. No screen does it.
3. Whether `LEAN_FLOOR` is on for production today. As of 25 Oct it was off.
4. The method to correct a wrong floor entry. No screen was found.
5. Who is the named backup administrator.
6. Whether the email digest mail server is set up. As of 25 Oct it was not.
