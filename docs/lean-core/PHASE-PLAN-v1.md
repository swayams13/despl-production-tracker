# Phase Plan v1 — from today to on-prem go-live

**Project:** DESPL Production Tracker (this repo) · **Written:** 11 Oct 2026 · **Owner:** Swayam
**Status:** active. This file sets the **phase order, gates, decisions and team inputs**. Session specs stay in `docs/lean-core/BUILD-PROMPT-lean-core-v1.md` (L0–L4, J1–J8, §8 design errata); this file adds **Phase M (master data)**, which that file does not have.
**Also read §9** — decisions, sign-offs, team questions and production-readiness work carried over from the 6–7 Oct sessions (Review & Rebuild Strategy, Questions for the DESPL team, UI review). §9 corrects some defaults in §5–§6.
**Precedence:** `CLAUDE.md` binds → this file decides order → the build prompt specifies each L/J session. If this file and the build prompt disagree on order, this file wins; on what a session builds, the build prompt wins.

---

## How to use this file

Start Claude Code at the repo root with:

> Read `CLAUDE.md`, `docs/lean-core/PHASE-PLAN-v1.md` and `docs/lean-core/BUILD-PROMPT-lean-core-v1.md` in full. We are executing the Phase Plan. Tell me which phase we are in from `progress.md` and the gates below, name the next session from §4, and plan it (files, migration, tests). Wait for my go before writing code.

Every session: one branch (`lean/L<x.y>-<slug>`, `lean/J<n>-<slug>` or `lean/M<n>-<slug>`), one PR, `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db` green, ≤ 15 lines in `progress.md`. A gate is passed only when demonstrated live with real logins, never by a forged session.

---

## 1. Where things stand (11 Oct 2026)

- Engine built (≈ 576 commits): jobs, 36-process schedules, components, assembly steps, maker–checker QC, QCP hold points, NCRs, welders/weld logs/NDT results, material identification, drawing revisions, RLS.
- **Nobody updates it daily.** Lean Core v1 (6 Oct) fixes that; **none of its sessions have started**: no `src/lib/shared/flags.ts`, no OPERATOR/PLANNER roles, no `enforcement`/`requiresQc`/`grain` columns. L0.4 is half done (`CLAUDE.md` amended, uncommitted).
- **Production is blocked:** 66 of 71 migrations applied, `/api/health` 503. Railway deploys `main` with no migration step, so **no PR with a migration may merge until L0.1 and L0.2 are done.**
- Design frames 00–16 are in `design/lean-core/`; 21 errata in build prompt §8.2.
- **New team input (11 Oct):** `docs/lean-core/inputs/2026-10-11-master-list/` — the Standard Parts Master workbook (60 part families, 235 route steps, 66 assembly steps, 42 proposed HE stages, 14 proposed new operations, material densities, 34 open review actions) plus the DE0423 GA and the SP40 MED drawing package. **Every row is Draft; nothing is Production-Head approved.** See §7.

---

## 2. Phases at a glance

Week 1 = Mon 12 Oct 2026.

| Phase | Weeks | Dates | Sessions | Gate to leave the phase |
|---|---|---|---|---|
| P0 Unblock and decide | 1 | 12–17 Oct | L0.1–L0.4 | `/api/health` 200 with 71/71; staging live; D2, D3, D4, D5, D13 recorded in `CLAUDE.md` |
| P1 Master data | 2–3 | 19–31 Oct | M1–M3 | Pilot parts + pilot job's part families approved in the tracker; the workbook re-imports on staging with zero unexplained issues |
| P2 Lean rules (parallel with P1) | 2–3 | 19–31 Oct | L1.1–L1.4 | Build prompt §6 demo steps 3–7 pass on staging |
| P3 Any job, any equipment | 4–6 | 2–21 Nov | J1–J7 | DE0423 created, configured and BOM-released from master data with no code change |
| P4 Screens (parallel with P3) | 3–6 | 26 Oct–21 Nov | L2.0–L2.12 + §8.3 extras | Full §6 acceptance demo (9 steps) live on staging |
| P5 Pilot | 3 weeks | 16 Nov–5 Dec (DESPL-320) or 30 Nov–19 Dec (DE0423) | L3.1–L3.2 | ≥ 90 % same-day updates for 5 working days; SJ stops his own sheet |
| P6 HE + all departments | 9–12 | 7 Dec–2 Jan (+2 weeks on DE0423 path) | J8, rollout waves, welding KPIs | Every department updates daily for a week; one HE job runs end to end |
| P7 Harden and on-prem | 11–14 | 21 Dec–16 Jan (+2 weeks on DE0423 path) | L4.1–L4.4, security, handover | Running on DESPL's LAN server; restore tested; Railway retired |

**Pilot switch (D5):** if the pilot job is DESPL-320, the pilot needs P2 + P4 only. If it is DE0423 (or any non-DESPL-320 job), it also needs P1 + P3 (J1–J5 at least), and the pilot, P6 and go-live move two weeks later (go-live ≈ 30 Jan). Diwali is 8 Nov; a shop shutdown that week delays team inputs, not code.

---

## 3. Phase details

### P0 — Unblock and decide (week 1)

- **L0.1** apply the 5 queued migrations (Swayam runs it on a hotspot; `MERGE-RUNBOOK.md`; re-dump and re-rehearse first, the 5 Oct rehearsal is stale).
- **L0.2** Railway pre-deploy `pnpm prisma migrate deploy` + healthcheck `/api/health` (Swayam clicks; agent updates `CLAUDE.md` stack section).
- **L0.3** staging environment and `staging` branch.
- **L0.4** finish: commit the `CLAUDE.md` amendments, add `flags.ts` and the freeze, archive superseded docs, split `progress.md`, ask before deleting `.claude/worktrees/agent-*`.
- Decision meeting with SJ: D1–D5, D13, D14–D16 (§5). Request I1, I3, I11, I14, I20 (§6).

### P1 — Master data (weeks 2–3) — new, specified here

Goal: the team's parts master lives in the tracker and is approved there; Excel is only a bulk-import format.

**M1 — Master-data schema (one additive migration; Opus).** Plan the exact shape first; requirements:
- **Part family as the route anchor.** Today routes hang off `ComponentTypeRef` rows that are raw-material forms (PLATE, PIPE…). Add part families (SHL-01 Shell Course, HED-01 Dished End…) either as a new `PartFamily` table linked to `ComponentTypeRef`, or as `ComponentTypeRef` rows with a `kind` (`RAW_FORM` | `PART_FAMILY`). Attributes: part code, name, equipment scope (PV | HE | BOTH), assembly group, make/buy, raw-material form, typical MOC, dimensions-to-enter (JSON list of keys), weight basis, is-spare, route source, status (`DRAFT` | `REVIEWED` | `APPROVED`), preparedBy, approvedBy, approvedAt. Legacy raw-form routes keep working: **DESPL-320 must regenerate unchanged.**
- **Route variants:** variant letter (A, B…) per route; the BOM-release step picks one.
- **Per-step stage mapping:** new `RouteStepFamilySeq (routeStepId, familyId, leadTimeProcessSeq)` mirroring `OperationRefFamilySeq`. Rollup resolves step-level first, then the operation-level default. (The workbook maps an Inspection step to process 11, 12, 18 or 25 depending on the part; one process per operation cannot express that.)
- **RouteStep fields:** `departmentId` override, `stdTime` Decimal, `stdTimeUnit` (HOURS | DAYS), `stdTimeBasis` (PER_PIECE, PER_JOB, PER_MATERIAL_LOT, PER_METRE_CUT, PER_METRE_EDGE, PER_METRE_WELD, PER_JOINT, PER_HOLE, PER_TUBE, PER_KG), `stdTimeStatus` (PROPOSED | VALIDATED), `conditionText` + `includeWhen` JSON (same rule shape as J2), `acceptanceStandard`, `recordDocument`, `requiresQc` (default true, as L1.1).
- **Material master:** `MaterialGrade (tenantId, spec, grade, productForm, densityGcc, remarks, status)`, unique on (tenant, spec, grade, form).
- Already present, reuse: `TemplateEdge.type` + `lagDays` (HE stage links), `TemplateProcess.optional`, `AssemblyTemplateStep.jointRef` + `leadTimeProcessSeq`, `RouteTemplateVersion.status`.
- RLS on every new table, same pattern as siblings; extend the RLS coverage test.
- Accept: migration replays from scratch; `migrate diff` clean; all existing tests green; DESPL-320 regeneration identical.

**M2 — Standard Parts Master importer (service + script; no UI).**
- `src/lib/services/master-import.service.ts` using the existing `xlsx` dependency. Sheets: Parts Master, Part Routes, Assembly Sequence, HE Stages, Material Master; New Operations and Review Actions are read into the report only.
- `dryRun(file) → { creates, updates, issues[] }`; `apply(file, { allowDraft })` in one transaction, idempotent on (part code, variant, seq). Production refuses rows not marked "Approved by Production Head"; staging may load Drafts with `allowDraft`.
- Issue rules (each a stable code, table-driven tests): unknown operation, department or raw-material form (ELB-01 "Pipe fitting"); step with no department or stage (7 TSH-02 steps); **operation↔stage plausibility** (flags every pilot Fit-up → 19, Welding → 20, Inspection → 21); missing or PROPOSED standard time; duplicate part code; variant gaps. BOM rules from Review Actions C-01–C-07 go into the BOM import dry-run: solid-vs-hollow cylinder weight, parent/child double count, duplicate item numbers, description-vs-field thickness, length order of magnitude, nozzle tag pairing.
- `scripts/import-standard-parts-master.ts`, `--dry-run` default.
- Accept: the 11 Oct workbook dry-runs without crashing and reports the issues above; a second apply changes nothing.

**M3 — Master-data screens (template studio subset, frames 15A–15D).**
- Part families: list, search, filter by PV/HE/group/status; detail with routes per variant; edit step fields.
- Approve: Production Head role only; approver ≠ preparer; approval publishes a new `RouteTemplateVersion`. Jobs copy master data at release, so running jobs never change.
- Import screen: upload → dry-run → issues → confirm (same component as L2.10).
- Material master and equipment catalogue (`EquipmentTypeRef` + typical sizes): list, edit, Excel import.
- Accept: SJ approves SHL-01 in the UI; a job created afterwards uses the new version; an existing job keeps the old one.

**Needs:** D14–D17, D20, D25 · I2, I5, I11, I12.

### P2 — Lean rules (weeks 2–3, parallel with P1)

L1.1 → L1.2 → L1.3 → L1.4 exactly as the build prompt. Merge order with P1: **L1.1 before M1** (both are migrations; rebase M1 on L1.1). **Do not start L1.2 until D2, D3, D4 are recorded.** Needs D2–D5, D10–D12.

### P3 — Any job, any equipment (weeks 4–6)

J1–J7 as the build prompt, with these deltas from the master data:
- **J1:** seed the PV equipment types from D18; DE0423 = "vertical on skirt" (2345 ID × 5496 OAL, 20 m³, 44 bar(g), 3 units DE0423-01..03).
- **J4:** DE0423 is the second generator fixture: LS-1, CS-1, CS-2, nozzles N1–N6 + M1, SK-1, skirt gussets GW-1..32 (workbook Assembly Sequence; refs are placeholders until I7).
- **J5:** BOM release maps each BOM line to a part family (suggest by part-name keyword, user confirms), picks the route variant, filters steps by `includeWhen`, and materialises component operations from **approved** routes only. Uses DE0423's 48 BOM lines (workbook "PV Drawing Basis").
- **J7:** third start route "Build from master" (build prompt §8.3).
- **D2 input:** DE0423's proposed order welds both heads (steps 40–60) before nozzles (130–140); DESPL-320 does nozzles before top-head closure. Gate floor items on each job's own assembly order, not on process edges 15→20.
Needs D9, D18, D21 · I6, I7, I8, I9.

### P4 — Screens (weeks 3–6, parallel with P3)

L2.0–L2.12 per build prompt §5 and §8 (frame map + errata), plus §8.3 "needed but not drawn": welder capture on weld steps, heat-number transfer at cutting, Stores actions, admin (users, departments, representatives, welders, delay reasons), alerts panel, jobs list, digest page. Needs D6, D23 · I3, I15, I17, I19.

### P5 — Pilot (3 weeks)

Load the pilot job; print travellers; 30-minute floor training per pilot department; L3.1 adoption metrics; L3.2 fix every complaint within 24 h, nothing new starts while a pilot blocker is open. Needs D22, D26 · I4, I16.

### P6 — Heat exchangers and all departments (weeks 9–12)

- Rollout waves, about a week each (order = D26): Stores + Procurement → Machine Shop + Fabrication Prep → NDT, Heat Treatment, Painting, Documentation/MDR, Dispatch → Engineering + Projects.
- **J8** from the workbook: HE Stages (42, "fixed tubesheet / MED evaporator") once approved; HE operations from the New Operations sheet that D16 accepts (tube insertion, grommet or expansion joint, tube leak test, shell- and tube-side hydro); **grommet tube joint** as a route variant distinct from Tube Expansion (D19, review action D-02); equipment types per HE type; 10 company milestones (D9) mapped from PV 36 and HE 42.
- Welding KPIs: per-welder output, per-joint NDT result, repair rate.
- Needs D8, D19, D24 · I10, I13, I18.

### P7 — Harden and move on-prem (weeks 11–14)

L4.1 Docker Compose (app, Postgres 16, Caddy LAN TLS, MinIO), nightly `pg_dump` 14 days, restore tested and timed · L4.2 photos with EXIF time/GPS at QC and hold points · L4.3 offline outbox · L4.4 WhatsApp only if D8 allows egress · security pass (password-reset approval, two admins, append-only audit, no WAN access unless D27 says so) · user guide per role, admin runbook · cutover: final data copy, LAN hostname, Railway read-only 2 weeks then retired. Needs D8, D24, D27 · I18.

### Later (behind flags)

Planner agent on self-hosted open models (`FEATURES.agents`), TPI logins, client portal, weight-based progress and tonnage, capacity planning from VALIDATED standard times, WhatsApp digest.

---

## 4. Next sessions, in order

1. **L0.1** production migrations (Swayam) → **L0.2** pre-deploy step (Swayam) → **L0.3** staging.
2. **L0.4** finish (commit `CLAUDE.md`, flags, archive, progress split).
3. **L1.1** additive migration.
4. **M1** master-data migration (rebased on L1.1).
5. **M2** importer, using the workbook in `docs/lean-core/inputs/2026-10-11-master-list/` as the fixture.
6. **L1.2** only once D2–D4 are recorded; otherwise **M3** or **L2.0/L2.1** next.
7. Then P3/P4 per §2, choosing the J-before-pilot path if D5 ≠ DESPL-320.

While a decision is open, build the switch with today's default and keep going; while an input is missing, build against the workbook or DESPL-320 fixtures and mark the gap in the PR.

---

## 5. Decisions

D1–D13 are already in `CLAUDE.md` → "Lean Core decisions". D14–D27 are new from the 11 Oct master list and are added there too. Record each with date and who decided.

| ID | Decision | Phase | Owner | Needed by | Default until decided |
|---|---|---|---|---|---|
| D1 | Working days or calendar days | P0 | SJ | 17 Oct | 6-day week, Sunday off (provisional) |
| D2 | Which handoffs become SOFT; is assembly order job-specific | P0 | SJ | 17 Oct | All HARD |
| D3 | QC scope (`requiresQc`) | P0 | SJ + QC head | 17 Oct | QC verifies every step |
| D4 | Backdating window | P0 | SJ | 17 Oct | 72 h |
| D5 | Pilot job, departments, JOB-grain processes | P0 | SJ + MD | 17 Oct | Planning/PPC, Fabrication Prep, Fabrication/Welding, QC; processes 1–11, 33 (§9.1) |
| D13 | Report in 36 processes or 25 work-order stages | P0 | SJ + MD/CEO | 17 Oct | Board shows 25 stages |
| D7 | Department representatives, welder list | P0 | SJ | 24 Oct | Placeholder accounts |
| D14 | Controlling document for routes (review action Q-01) | P1 | SJ | 24 Oct | Team workbook once approved |
| D15 | Who approves master data; Excel only for bulk import | P1 | SJ + MD | 24 Oct | Production Head approves in the tracker |
| D16 | Part code scheme; 17 operations frozen; which of the 14 proposed operations to add | P1 | SJ + QC head | 24 Oct | No new operations |
| D10 | Late-reason categories | P2 | SJ | 24 Oct | The 8 in frame 01D |
| D11 | QC inspector who also recorded the work | P2 | QC head | 24 Oct | Production Head may accept, logged |
| D12 | DESPL-own H points block floor work or only QC sign-off | P2 | QC head + SJ | 24 Oct | Block floor work |
| D17 | Standard times stored only or used for scheduling; validation method | P1 | SJ + PPC | 31 Oct | Stored only; process min/max days schedule |
| D20 | Heat treatment, PFHT, hydro: floor operations or QCP points (Q-05, PV-03) | P1 | SJ + QC head | 31 Oct | QCP points on processes 21 and 27 |
| D25 | Weight calculation in v1 | P1 | SJ + MD | 31 Oct | After go-live |
| D18 | PV equipment types in the v1 catalogue | P3 | Engineering + SJ | 2 Nov | Vertical on skirt, vertical on legs, horizontal on saddles |
| D9 | Ten company milestone names | P3 | SJ + MD | 7 Nov | Build prompt §8.4 |
| D21 | Serial or lot tracking for multi-quantity jobs | P3 | SJ + PPC | 7 Nov | Serial |
| D6 | Floor devices and Wi-Fi | P4 | SJ + IT | 7 Nov | Design for tablets and phones |
| D23 | Notifications: in-app + 08:30 email digest, recipients | P4 | MD/CEO | 7 Nov | In-app; email to MD, CEO, SJ |
| D22 | In-flight jobs to import; date Excel stops | P5 | SJ + PPC | 28 Nov | Pilot job only |
| D19 | HE types in v1; grommet joint as standard variant (Q-02, D-02) | P6 | Engineering + SJ | 30 Nov | Fixed tubesheet / MED only |
| D26 | Department rollout order after the pilot | P5 | SJ | 5 Dec | Order in P6 |
| D8 | On-prem server spec, administrator, cutover month | P7 | MD + IT | 5 Dec | Stay on Railway |
| D24 | Photo evidence points; GPS required | P7 | QC head | 12 Dec | Hold points and hydro test only |
| D27 | Backup retention, remote access, system administrator | P7 | IT + MD | 12 Dec | Nightly, 14 days, LAN only |
| D28 | Git integration model (§9.6): PRs into `main` behind flags, or a long-lived `redesign` branch | P0 | Swayam | 17 Oct | PRs into `main` behind flags; tag `pre-redesign` first |

---

## 6. Information required from the team

| ID | Information | Blocks | Owner | Needed by | Status (11 Oct) |
|---|---|---|---|---|---|
| I14 | Calendar: week-off, shifts, 2026–27 holidays incl. Diwali shutdown | D1, scheduling | SJ + HR | 17 Oct | Missing |
| I1 | Pilot job pack: PO, GA, BOM, QAP/ITP, weld map, delivery date | D5, J1–J5, P5 | Projects + Engineering | 21 Oct | Partial — DE0423 GA + 48 BOM lines |
| I3 | People: preparer, PH reviewer, one rep per department, users with role, mobile, email | M3 approvals, L2, P5 | SJ | 21 Oct | Missing |
| I20 | Drawing control: DE0423 number DM-C vs DM-D; SP40 Rev.0 released? (D-01) | M2 data, J8 | Document control | 21 Oct | Missing |
| I11 | Cited but not attached: Master BOM _PV.xlsx, _PV_HE.xlsx (HE 803-E-5, OC-48-0223), 24-point checklist | M2, J8 | Document control | 21 Oct | Missing |
| I2 | 10 pilot parts corrected (stage fill-down) and signed by PH | P1 gate | SJ + preparer | 28 Oct | Partial — Draft |
| I8 | WPS list; welder list with ID, stamp no., qualifications | L2.2 welder capture, KPIs | QC / Welding | 28 Oct | Missing |
| I9 | QAP/ITP for pilot job and one HE job | D12, QCP library | QC head | 28 Oct | Missing |
| I15 | KPI definitions, digest contents, delay reasons, recipients | L2.7, L2.11 | SJ + MD/CEO | 31 Oct | Missing |
| I12 | BOM corrections C-01–C-08 and PV-01 closed | M2 fixtures | Engineering | 4 Nov | Missing |
| I6 | Equipment catalogue: all types sold, typical sizes, standard designs | J1, J7, M3 | Engineering + Sales | 4 Nov | Missing |
| I7 | Weld-map convention + controlled joint register (PV-05) | J4 | QC / Welding | 4 Nov | Partial — placeholders |
| I17 | Devices per department, shop Wi-Fi coverage, QR printer | D6, L2.2, L2.9 | IT / Admin | 4 Nov | Missing |
| I13 | Procedures: PFHT/PWHT, hydro parameters, bolting (PV-03, PV-06) | L2.6 QC records, J8 | QC head | 11 Nov | Missing |
| I4 | Validated standard times per department | D17, capacity later | Supervisors + PPC | 14 Nov | Partial — 222 proposed |
| I5 | Full parts list for every PV and HE type | M2, J8 | Engineering | 21 Nov | Partial — 60 families |
| I19 | Hindi/Gujarati reviewer | L2.12 | SJ | 21 Nov | Missing |
| I10 | HE types and frequency, approved 42-stage plan, past HE BOM + GA, grommet details | J8 | Engineering + PPC | 25 Nov | Partial |
| I16 | Excel trackers of every live job (E1 — needed week 1 to design the import) | D22, L2.10 | PPC | 17 Oct | Partial — DE0463/DE0467 in seed |
| I18 | On-prem server spec, OS, IT contact, LAN host/IP, backup target, remote access | L4.1, cutover | IT | 5 Dec | Missing |

---

## 7. The 11 Oct inputs — what to trust

Files in `docs/lean-core/inputs/2026-10-11-master-list/` (PDFs are git-ignored; keep them local):
- `Standard_Parts_Master_PV_HE_SAMPLE.xlsx` — 14 sheets. Fixture for M2. Status line: "proposed baselines complete for review, not approved for tracker load".
- `Approved_51G2-E-ELM-HCA-DM-C-V-4006-C_AR GA - Copy.pdf` — DE0423 approved GA (23 May 2025), 2 sheets.
- `SP40-02-03-04-001-R0 (SHEET 01 & 02).pdf` — MED Train 1 package, 25 A0 sheets, Rev.0 "Submission".

Known facts (use them):
- 17 operations = `seed/component-routes.json` `canonicalOperations`; departments = the 13 in `seed/lead-time-model.json` + "Vendor (outside DESPL)"; "PV stages" = the 36 lead-time processes.
- DE0423: PO 4504443598, 3 nos, vertical on skirt, ASME VIII-1 2023, 44 bar(g), −20 to +50 °C, PFHT + PWHT, 100 % RT, hydro 66–66.5 kg/cm²(g) 30 min, nozzles N1–N6 + M1 (sheet "PV Drawing Basis").
- Closes `component-routes.json` TODO_FOR_DESPL 1–3 (classify by part code; Edge Prep, Grinding, Inspection are own steps; Name Plate has a route).

Known defects (do not load as truth; M2 must flag them):
- Pilot parts: every Fit-up → process 19, Welding → 20, Inspection → 21 regardless of part (fill-down). DE0423 rows are sensible.
- Standard times are PROPOSED for 222 steps; blank for 13 SP40 steps.
- Review actions A-01 and A-02 are stale (HE stages and times are now filled).
- "Filled by" holds a company name; no approvals.
- ELB-01 raw form "Pipe fitting" not in the list; 7 TSH-02 steps lack department and stage.
- Drawing number DM-D-V-4006 in the workbook vs DM-C-V-4006 in the file name.
- HE scope includes an MED evaporator with EPDM grommet tube joints (no expansion, no seal weld) — the TEMA-based J8 list does not cover it.
- QC owns 93 of 235 route steps (input to D3).

Never copy sample names, dates or quantities from the workbook into seeds or tests except as the explicit M2 fixture.

---

## 8. Definition of done for go-live

Functional:
- [ ] Any catalogued PV or HE job is created from master data with no code change
- [ ] Floor steps generated at BOM release from approved routes and the job's weld map
- [ ] All 13 departments record work; ≥ 90 % same-day
- [ ] QC acts only on real inspection points; hold points, hydro-before-paint, dispatch-with-open-NCR enforced
- [ ] Late items ask for a reason and never block unrelated work
- [ ] Per-welder output, NDT results and repair rate
- [ ] 08:30 digest to MD, CEO, SJ; Portfolio shows jobs at risk against committed dates
- [ ] Master data approved and versioned in the tracker; running jobs unaffected by template changes
- [ ] In-flight jobs imported; their Excel trackers retired

Deployable:
- [ ] On DESPL's LAN server with TLS; Railway retired
- [ ] Migrations run before every deploy; health check green
- [ ] Nightly backups, 14 days; one restore tested and timed
- [ ] Two admins; password-reset approval works; audit log append-only
- [ ] Floor screens tested on the real devices and Wi-Fi in every bay
- [ ] Role user guides, admin runbook, 30-minute training per department
- [ ] A named DESPL admin manages users, departments, welders and master data without a developer
