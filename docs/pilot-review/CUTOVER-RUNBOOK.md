# Cutover runbook: pilot handover (DESPL-320)

Run top to bottom. Each step: **do**, **expect**, **if it fails**. Never skip a step's "expect". No passwords or keys in this file or in chat.
Production: `https://despl-production-tracker-production.up.railway.app` · Staging: `https://despl-staging-staging.up.railway.app`

Rules that bite: this repo's Railway CLI is linked to **staging**, so every production command carries `--environment production --service Postgres`. The office LAN blocks the Railway DB proxy: use the **phone hotspot** for step 2. Stage git changes by explicit path.

## 0. Go / no-go
```
curl -s -o /dev/null -w "prod %{http_code}\n"    https://despl-production-tracker-production.up.railway.app/api/health
curl -s -o /dev/null -w "staging %{http_code}\n" https://despl-staging-staging.up.railway.app/api/health
```
Open `https://status.railway.com`: the incident must be **Resolved** and "Builds" not paused.
- **Expect:** both 200, builds running. **If builds are paused: go to section 9 (fallback). Do not start 1.**

## 1. Deploy `main` to production
**Do:** Railway dashboard, production service, check the latest deployment is `main`'s newest commit; if auto-deploy did not fire, press Redeploy / Deploy latest.
**Expect in the deploy log:** pre-deploy `pnpm prisma migrate deploy` printing "83 migrations found, 1 applied" (J4a `20261022100000_j4a_planned_joints`), build SUCCESS, then `curl .../api/health` = 200.
**If it fails:** a failed pre-deploy leaves the old container serving: nothing is lost. An empty "Build image" log is a Railway builder fault: retry once. **Rollback:** redeploy the previous deployment `56e3c3b1` (J3a). J4a's migration only adds nullable/defaulted columns, enum types and one empty table, so the old build still runs on the migrated database.

## 2. Production backfills (phone hotspot, owner role)
Full commands and the "what the dry run must say" table are in `docs/pilot-review/PRODUCTION-BACKFILL-COMMANDS.md`. Order: dump, pre-flight, then steps 1, 2, 3, each **dry run first, read it, then add `--apply`**.
```
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
railway run --environment production --service Postgres -- sh -c 'pg_dump "$DATABASE_PUBLIC_URL" -Fc -f "$HOME/despl-prod-pre-backfill-$(date +%Y%m%d-%H%M).dump"'
```
**Expect:** pre-flight says "Database schema is up to date" (83 migrations) and a `*.proxy.rlwy.net` target. Dry runs: (1) 8 questions to create, default specs to rename: none; (2) 14 planned joints, 126 steps to link, 0 weld records, 72 multi-joint steps left alone, always `--job DESPL-320`; (3) 3 equipment types, 1 skirt template of 54 steps, 7 kit rows, 1 equipment to link. A second `--apply` changes nothing.
**If a number differs or the target says `localhost`:** stop. `DATABASE_PUBLIC_URL` was empty or the data changed since the dump. Do not `--apply`.

## 3. Staging: push `main`, smoke
```
git fetch origin && git push origin origin/main:staging
```
**Expect:** staging deploy log "83 migrations found" or "No pending migrations", `/api/health` 200. Staging has demo data only, never production data.
**Smoke (5 min):** sign in as a seeded staging account, open Portfolio, a job page, Today.
**If it fails:** read the staging deploy log first; do not touch production.

## 4. Turn the lean floor on: staging first, then production
**Do (staging):** dashboard, `despl-staging` service, Variables, `LEAN_FLOOR=on`, redeploy.
**Expect:** `/today`, `/team`, `/scan` open (they are 404 with it off). Walk `QUICK-START.md` for Operator, Stores, QC, Production Head: Start, Done, issue material, QC accept.
**Then production, only on Swayam's go:** same variable on the production web service, redeploy.
**If it fails:** set `LEAN_FLOOR` back to off (or delete it) and redeploy; floor actions then refuse with `FEATURE_FROZEN`, nothing else changes.

## 5. Team logins
**Do:** sign in as Admin, `/admin`, **Add employee…**, one person at a time, your own temporary password each; each is forced to change it on first sign-in. Do **not** run `scripts/create-department-accounts.ts` (hard-coded passwords).
Create at least: **Stores** (1), a **second QC** (concessions and maker-checker; the QC queue also stops being one person's bottleneck), **Planning/PPC** in the department that owns processes 1 to 11, **supervisors** per pilot department (Fabrication Prep, Fabrication/Welding, QC), operators as needed, and **MD, CEO, SJ** with their real emails.
Then check `/admin` for the old `qc`, `fabrication`, `production`, `procurement`, `ba` accounts: **Deactivate** (never delete) any still active.
**Expect:** each new user lands on their role's page after changing the password.

## 6. Client names with developer text
Three jobs show "Unknown client — pending DESPL confirmation…" on the dashboard and the printed traveller. Rename the client in master data (Admin). **Expect:** dashboard and traveller show the real name.

## 7. DESPL-320 indent and PO
Production Head enters the indent/PO under Materials (or loads I16). **Expect:** DESPL-320 now appears in Stores `/materials`. Without it Stores has nothing to receive.

## 8. Day one and after
- **Adoption:** Portfolio, card **Same-day updates**: share of updates entered the same day per working day, and "N of 5 working days at 90% or more". Pilot gate: 90% for 5 working days in a row (Sundays skipped).
- **Problems:** team members follow `docs/pilot-review/REPORT-A-PROBLEM.md` (full-screen screenshot with address bar, name, role, time, steps, exact message). Refusals are on purpose: the screenshot shows whether the rule or the data is wrong.
- Training: `QUICK-START.md`, 30 minutes per department.
- Watch `/api/health`, and the Railway spend limit (workspace-wide; it stopped production on 21 Oct).

## 9. Fallback: Railway builds still paused
Production keeps serving the **J3a build** (`56e3c3b1`, `4075eea`); it is usable but old. **Missing from it** (everything merged 21 Oct after J3a, plus the J4a migration `20261022100000`): #128 delivery date required · #129 Planning/PPC Today · #130 QCP warning and wizard polish · #131 floor messages (Notify Stores, no raw codes, back-dated reason) · #132 empty dispatch batch refused · #133 pilot-review docs · #134 dead controls hidden · #136 Same-day updates card · #137 dispatch guard for units with no plan (if merged) · #138 quick start · #139 rehearsal nits and printed step names.
`LEAN_FLOOR` is **off** there, so `/today`, `/team`, `/scan` are 404 and floor Start/Done refuse. Turning it on needs an env change **and a restart from the Railway dashboard**, which needs the dashboard to be up; the status page said the dashboard and CLI were down on 21 Oct. If the dashboard is back but builds are not, set `LEAN_FLOOR=on` and restart: the old build already contains the floor.
Tell the team plainly which build they have and what is missing; re-run sections 1 to 4 when builds resume.

## 10. Decisions taken for the pilot
- **MTC Verification** is ticked by the **Fabrication Prep supervisor** (its Receipt and MTC steps skip QC on DESPL-320).
- **L1.3 JOB grain is not shipped**: a new job gets one copy of each office process per unit.
- **Email digest off**: no SMTP; alerts are in-app only.
- **Every step except Receipt and MTC Verification still goes to QC.** The D3 "which steps skip QC" list needs the QC head's review first; create the second QC login (section 5) so one person is not the bottleneck.
- Hindi/Gujarati: do not show as ready. Other open decisions: `DECISIONS-21-OCT.md`.
