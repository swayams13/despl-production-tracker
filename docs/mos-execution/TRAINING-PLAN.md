# Training Plan — Per Role

Covers M5 from `docs/mos-blueprint/execution/24_DESPL_MOS_PLAN_GAPS.md` Phase M. Run once per
department during that department's cutover week (`CUTOVER-PLAN.md` §2, "T-minus 1 week").

Each session is ~30 minutes, hands-on, in the real system (a training tenant or the real one
with a disposable test job — not slides). The goal is not "cover every feature" — it's "make sure
the first refusal someone hits on cutover day doesn't feel like the system is broken."

Roles are the system's real roles (`src/lib/authz/index.ts`): `SUPERVISOR`, `QC`,
`PRODUCTION_HEAD`, `MANAGEMENT`, `ADMIN`, `CLIENT_VIEWER`. There is no separate "operator" role —
shop-floor operators work through a `SUPERVISOR` login for their department, so the Supervisor
session below covers them too.

---

## Session 1 — Supervisor (shop-floor departments: Fab Prep, Machine Shop, Fabrication, Heat
Treatment, Surface Treatment, Dispatch)

**Audience:** the person actually clicking Start/Submit on the shop floor for their department.

1. **Log in, find your department's work** (5 min) — `/my-day`, the department pool, claiming a
   task.
2. **Do a real Start → Submit cycle** (10 min) — walk through one real (or disposable test)
   operation start to finish. Show exactly what "Submit" does and does not do (it does not mean
   verified).
3. **Trigger a real refusal on purpose** (10 min) — the single most valuable 10 minutes in this
   whole plan. Deliberately try to start a gated step before its predecessor is done and show the
   `GATING_BLOCKED` message. Deliberately try to submit and then verify the same item as the same
   user (won't be possible for Supervisor, but show what QC sees). Point at
   `docs/USER-GUIDE-WHY-WAS-I-REFUSED.md`'s "Everyone on the shop floor" section — this is their
   copy to keep.
4. **File a delay reason** (5 min) — show the `REASON_REQUIRED` flow and why the categories
   matter (management reads these, they're not busywork).

---

## Session 2 — QC Inspector

**Audience:** whoever verifies work, clears hold points, dispositions NCRs.

1. **The maker-checker rule, shown not told** (5 min) — have the trainee try to verify something
   the same login submitted, and see `MAKER_CHECKER_VIOLATION` fire live. This is worth doing
   before explaining it in words.
2. **Hold points and NCRs** (10 min) — clear a real hold point; open, disposition, and close an
   NCR through `/qc`. Show what downstream stages see while the NCR is open (`NCR_OPEN`).
3. **DFT readings** (5 min, Surface Treatment cutover only) — recording a DFT reading, what
   "accepted" means, `DFT_NOT_ACCEPTED`.
4. **The refusal guide, QC section** (5 min) — hand over
   `docs/USER-GUIDE-WHY-WAS-I-REFUSED.md`'s QC + shop-floor sections.
5. **Q&A on real judgment calls** (5 min) — reject vs. rework vs. accept; this is the one area
   where the system enforces process but not the actual quality judgment, and that's deliberate.

---

## Session 3 — Production Head / Department Head (office departments: Projects, Engineering,
Planning, Procurement, Stores, Documentation, plus shop-floor department heads)

**Audience:** whoever owns a department's queue, assigns work, and handles overrides.

1. **The department view** (5 min) — `/departments/[id]`, the department's KPIs, cycle time.
2. **Assigning work** (5 min) — `ASSIGNEE_NOT_IN_DEPARTMENT` / `ASSIGNEE_INACTIVE`, what they
   mean.
3. **Overrides need a reason** (5 min) — `OVERRIDE_REASON_REQUIRED`, why it's recorded, not
   optional.
4. **Department-specific gate, live** (10 min, pick the one relevant to this department):
   - Engineering: drawing release gating Fabrication's `DRAWING_NOT_RELEASED`.
   - Stores/Procurement: the material-shortage gate, `MATERIAL_NOT_AVAILABLE` — the exact
     scenario already demonstrated live in Gate 2's exit test (`LEDGER.md` S16-S20 row).
   - Planning: BOM/schedule ownership, `SCHEDULE_DATA_MISSING` for unconfirmed durations.
5. **The sign-off checklist** (5 min) — walk them through `CUTOVER-PLAN.md` §6 so they know
   exactly what they're being asked to confirm at the end of the week, not surprised by it.

---

## Session 4 — Management (Projects/PMO leadership, anyone reviewing client-portal snapshots)

**Audience:** whoever verifies/rejects the daily client-portal snapshot, watches portfolio KPIs.

1. **Dashboard and portfolio view** (10 min) — `/dashboard`, worst-first project sorting, the
   sunburst chart.
2. **Client portal review cycle** (10 min) — a real publish → verify cycle,
   `SNAPSHOT_PRIOR_DAY_PENDING` (why a stuck review blocks the next day, on purpose).
3. **Alerts and digest** (10 min) — `/alerts`, what the daily digest email/notification actually
   summarizes, what triggers an hourly alert (Gate 4's scheduler work, `LEDGER.md`).

---

## Session 5 — Admin

**Audience:** whoever provisions accounts, resets passwords, authors templates/routes.

1. **User management** (10 min) — creating accounts, roles, department scope, password reset
   (`mustChangePassword`), `CANNOT_SELF_DEACTIVATE` / `CANNOT_SELF_DEMOTE` safety rails.
2. **Template/route authoring basics** (15 min) — enough to understand
   `TEMPLATE_VERSION_LOCKED` (publish = locked, new version to edit) and
   `ROUTE_STEP_SEQ_UNKNOWN`, even if this admin never authors a template themselves — they'll be
   the first call when someone else hits it.
3. **Where to look when something looks broken** (5 min) — `/api/health`, how to tell a real bug
   from a working-as-designed refusal, when to escalate to this project's maintainers.

---

## Client Viewer (external, not part of the 13-department cutover)

Not scheduled as a formal session — client-portal onboarding is a separate, lighter-touch
conversation with each client's own point of contact, covering just: what the portal shows, that
snapshots are Management-verified before they appear, and `CLIENT_SCOPE_VIOLATION` (they'll only
ever see their own jobs, so this should never actually come up).

---

## Materials to hand out at every session

- `docs/USER-GUIDE-WHY-WAS-I-REFUSED.md` — the relevant section for their role, printed or
  bookmarked.
- Their real login credentials (handed over in person per `CUTOVER-PLAN.md` §3, not printed on a
  shared sheet).

## Tracking

Reuse `CUTOVER-PLAN.md`'s per-department table — "Trained" there means this session ran for
every real person in that department who needs one, not just the department head.
