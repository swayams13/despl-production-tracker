# IMPLEMENTATION-GUIDE.md — Step-by-Step Build in Antigravity

> Companion to `docs/BUILD-SPEC-v2.md` (the *what/why*) and `CLAUDE.md` (the *invariants*). This is the *how, in order, with exact commands*. Follow it top to bottom. Each step ends with a verification check and a git commit — don't move on until the check passes.
>
> **Model discipline:** run coding steps on **Sonnet**. If Antigravity/Claude CLI proposes a real architecture change (different from BUILD-SPEC-v2), stop and bring it back to this Cowork chat (Opus) for a decision before coding it.

---

## STEP 0 — Environment prerequisites (you, before opening Antigravity)

Install / prepare, once:

1. **Node.js 20 LTS** and **pnpm** (`npm install -g pnpm`)
2. **Docker Desktop** (for local Postgres) — or a **Railway** account if you'd rather develop against a cloud DB from day one
3. **Git**, and a **GitHub repo** created for this project (empty, no README/license — you'll push the scaffold into it)
4. **Antigravity IDE** installed, with Claude CLI configured inside it

Verify:
```bash
node -v      # v20.x
pnpm -v
docker -v
git --version
```

---

## STEP 1 — Turn the project folder into a git repo

Open a terminal in `DESPL TRACKER/` (the folder you already have — CLAUDE.md, docs/, seed/, prototype/ are already in it) and run:

```bash
cd "DESPL TRACKER"
git init
git add CLAUDE.md docs/ seed/ progress.md prototype/
git commit -m "docs: specs, seed data and build spec (pre-code)"
git branch -M main
git remote add origin <your-empty-github-repo-url>
git push -u origin main
```

**Check:** GitHub shows CLAUDE.md, docs/, seed/, progress.md, prototype/ and nothing else. This is your starting commit — everything below builds on top of it.

---

## STEP 2 — Open in Antigravity and start the first Claude CLI session

Open the `DESPL TRACKER` folder in Antigravity. In the Claude CLI panel, your **first message** should be almost exactly this:

> Read CLAUDE.md, then docs/BUILD-SPEC-v2.md in full. Do not write any code yet — summarize back to me in your own words: the stack decision, the two-layer scheduling model, and the build order in BUILD-SPEC-v2 §6. Confirm you understand before we start Sprint 1.

**Why this matters:** CLAUDE.md's first line already tells any Claude Code session to read BUILD-SPEC-v2 first, but making it say the plan back to you catches misreadings before any code exists — cheap to fix now, expensive after 500 lines of Prisma schema are wrong.

**Check:** its summary matches BUILD-SPEC-v2 §0 (the decisions table) and §6 (build order). If it drifts, correct it in chat before proceeding — don't let it start coding on a wrong premise.

---

## STEP 3 — Scaffold the Next.js app

Prompt:

> Scaffold the Next.js 15 App Router project per BUILD-SPEC-v2 §2: TypeScript strict, Tailwind v4 + shadcn/ui, TanStack Query v5, Prisma 6. Single full-stack app — no separate NestJS service. Set up `lib/services/`, `lib/schedule/`, `lib/shared/` as empty directories with a README stub in each explaining their role per CLAUDE.md conventions. Add ESLint, Prettier, Vitest, Playwright. Do not connect to a database yet.

Run:
```bash
pnpm install
pnpm lint && pnpm typecheck
```

**Check:** app boots (`pnpm dev`), lint/typecheck pass, `lib/services/`, `lib/schedule/`, `lib/shared/` exist. Commit: `feat: Next.js scaffold`.

---

## STEP 4 — Database: local Postgres + Prisma connection

Local option (recommended for dev speed):
```bash
docker run --name despl-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=despl -p 5432:5432 -d postgres:16
```
Create `.env`:
```
DATABASE_URL="postgresql://postgres:devpass@localhost:5432/despl"
```
(Add `.env` to `.gitignore` if it isn't already — never commit credentials.)

Prompt:

> Initialize Prisma against DATABASE_URL. Do not write the schema yet.

Run: `pnpm prisma db pull` should connect cleanly (empty schema is fine — just confirms connectivity).

**Check:** `pnpm prisma studio` opens and shows an empty database. Commit: `chore: db connection`.

---

## STEP 5 — Prisma schema

Prompt:

> Write the full Prisma schema from BUILD-SPEC-v2 §2's data model: Client, Job, Equipment, Unit, LeadTimeProcess, ProcessEdge, Department, ProcessDepartment, ProjectSchedule, ProjectProcessPlan, BomItem, Procurement, MaterialIdentification, ItemOperation, ItemTest, InspectionParty, QcpTemplate, QcpItem, QcpItemPartyCode, QcpExecution, AssemblyDrawing, DelayReason, Notification, AuditLog. snake_case tables, enums for every status field. Enforce CLAUDE.md invariant #1: no model may have a client-writable `actual_*` or `*_at` field — those are set server-side only, never accepted in a request DTO. Enforce invariant #5: the audit_log table's Postgres role must not have UPDATE/DELETE grants — write that as a migration-time SQL grant statement, not just a comment.

Run:
```bash
pnpm prisma migrate dev --name init
```

**Check:** migration applies cleanly; open `prisma/schema.prisma` yourself and confirm every table from BUILD-SPEC-v2 §2 is present. Commit: `feat: initial schema`.

---

## STEP 6 — Seed the database from seed/*.json

Prompt:

> Write a seed script (`prisma/seed.ts`) that loads seed/lead-time-model.json, seed/component-routes.json, seed/qcp-templates.json and seed/live-jobs.json into the database — LeadTimeProcess, ProcessEdge, Department, ProcessDepartment, the QCP template with its dynamic party/code model, and the two live jobs (DE0463, DE0467) with their BOM items. Do not hand-type any of this data — parse the JSON files directly. Flag anything in seed/data-issues.json as a `remarks` field on the relevant row rather than silently dropping it.

Run:
```bash
pnpm db:seed
pnpm prisma studio   # spot-check: 36 processes, 13 departments, 54 QCP items, 2 jobs with their BOM items
```

**Check:** counts match — 36 LeadTimeProcess rows, 13 Department rows, 54 QcpItem rows, DE0463 with 20 BOM items, DE0467 with 34. Commit: `feat: seed data import`.

---

## STEP 7 — Scheduling engine (`lib/schedule/`) — build this before any UI

This is the core of the release per BUILD-SPEC-v2 §1. Prompt:

> Build lib/schedule/ implementing BUILD-SPEC-v2 §1.2–§1.5: the envelope layer, the CPM layer with fitted lags, forward scheduling, backward scheduling, the feasibility check, and the override mechanism (mandatory reason, audit row, baseline preserved — never mutated). Write table-driven Vitest tests, including this exact regression case: DE0467, PO date 2026-06-24, committed dispatch 2026-10-15, 6-day calendar week — the engine must report INFEASIBLE, short by exactly 22 working days against the 119-day standard envelope. Also test: a negative lag never allows a process to be marked COMPLETE before its predecessor, even though it can be marked IN_PROGRESS earlier — gating and scheduling are separate checks.

Run:
```bash
pnpm test lib/schedule
```

**Check:** the DE0467 regression test passes with the 22-day shortfall (113 calendar days between the two dates, less 16 Sundays, is 97 working days available; 119 − 97 = 22 — hand-verify this arithmetic yourself before trusting either the doc or the engine, since an earlier draft of this doc had it wrong at "~26 days"). If the engine reports something very different from 22, stop and debug before building anything on top of it. Commit: `feat: scheduling engine + tests`.

---

## STEP 8 — Auth, RBAC, audit interceptor

Prompt:

> Implement auth (JWT in httpOnly cookies, argon2id password hashing), roles from CLAUDE.md/PRD, deny-by-default RBAC at every Server Action and Route Handler, and DepartmentScopeGuard equivalent limiting supervisors to their department's processes. Implement the audit interceptor per invariant #5 — every mutation writes an audit_log row with before/after jsonb in the same transaction; if that insert fails, the whole transaction rolls back. Write violation-case tests: a supervisor writing outside their department, a non-QC user attempting to verify, the same user attempting submit-then-verify on the same record (maker–checker, invariant #3).

**Check:** violation tests fail closed (403/blocked), not open. Commit: `feat: auth, RBAC, audit log`.

---

## STEP 9 — Tender intake → schedule generation

Prompt:

> Build the tender intake screen per BUILD-SPEC-v2 §1.6 / decision #7: manual fields (equipment type, quantity, enquiry/PO date, required delivery date, client, inspection parties) plus a file attachment for the tender/RFQ/PO document (stored, not parsed). On submit, call lib/schedule to generate and display both the forward projection and the backward per-department finish-by dates, and show the feasibility verdict prominently if TIGHT or INFEASIBLE.

**Check:** create a test tender with DE0467's real numbers and confirm the UI shows the same INFEASIBLE verdict as your Step 7 test. Commit: `feat: tender intake + schedule display`.

---

## STEP 10 — Job/BOM import + department workspaces

Prompt:

> Build job/equipment/BOM screens showing DE0463 and DE0467 as imported. Build the 13 department workspaces per BUILD-SPEC-v2 §3 — each supervisor sees only their department's due-this-week and overdue processes (from the backward schedule), with entry forms for their operations, and is blocked from further writes on an overdue unit until a categorized delay reason is filed (invariant #7).

**Check:** log in as a Fabrication supervisor — see only Fabrication-owned processes; try to file an entry on an overdue unit without a reason — it's refused with a stable error code (`REASON_REQUIRED`). Commit: `feat: department workspaces`.

---

## STEP 11 — QCP engine

Prompt:

> Build the QCP execution engine per BUILD-SPEC-v2 decision #8 and seed/qcp-templates.json's dynamic model: per-project inspection parties, per-checkpoint code per party (P/W/H/R/RW/R&A), hold points (H) blocking stage completion absolutely, witness points (W) requiring a logged call-given/call-attended pair with a Production-Head-approved waiver path. Test: attempting to complete a stage with an open H-coded checkpoint is refused with HOLD_POINT_OPEN.

**Check:** the 4 real hold points from QCP DESPL-320 (sections 1.3, 3.1, 3.2, 4.1) actually block in a test run. Commit: `feat: QCP engine`.

---

## STEP 12 — Notifications + escalation

Prompt:

> Build in-app notifications per BUILD-SPEC-v2 §4: T-3 due-soon, T-0 due-today, T+1 overdue-and-blocked, T+3 escalate to Production Head, T+7 escalate to MD/CEO. Store the payload as email-ready jsonb (Phase 2 delivery, not built now) per PRD decision.

**Check:** manually backdate a test process's finish-by date and confirm the escalation chain fires in order. Commit: `feat: notifications + escalation`.

---

## STEP 13 — Dashboards

Prompt:

> Build the MD/CEO company dashboard, Production Head department-rollup dashboard, and QC dashboard per PRD §6, with CSV export.

**Check:** DE0463 and DE0467 both render with real numbers. Commit: `feat: dashboards`.

---

## STEP 14 — Deploy to Railway staging

```bash
railway login
railway init
railway add --plugin postgresql
railway up
```
Set `DATABASE_URL` and other secrets in Railway's environment settings (never commit them). Confirm the GitHub Actions pipeline (lint → typecheck → test → build → migrate → deploy) referenced in CLAUDE.md is wired to auto-deploy `main` to staging.

**Check:** staging URL loads, seeded data visible, the DE0467 infeasibility case reproduces there too.

---

## After every step

Update `progress.md` per CLAUDE.md's session-discipline rule: what shipped, decisions made, blockers, next steps — even mid-sprint. Don't wait for end of day if you're pausing mid-step.

## If something doesn't match BUILD-SPEC-v2

Stop. Don't let a coding session improvise around an unclear spec — bring it back here (Opus) as a question, get a decision, update BUILD-SPEC-v2, then resume coding. This is the same discipline CLAUDE.md already asks for on the invariants; apply it to architecture too.
