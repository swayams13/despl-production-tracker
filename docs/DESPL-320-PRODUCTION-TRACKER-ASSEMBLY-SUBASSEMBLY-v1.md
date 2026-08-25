# DESPL-320 — Production Tracker: Assembly & Sub-Assembly (dev-ready v1)

**Date:** 25 Aug 2026 · **Companion to:** `docs/DESPL-320-DEV-READY-BOM-SCHEDULE-v1.md` (the schedule/BOM doc you had me check first).
**New in this document:** (1) a check of that doc against what's actually live in the codebase and in production right now, (2) the assembly (weld/QCP) sequence and sub-assembly (component fabrication) register as one dev-ready package, built from the real seed files and Prisma schema already in the repo — not re-derived from scratch.

---

## 0. Where I looked before writing this

I read your uploaded `DESPL-320-DEV-READY-BOM-SCHEDULE-v1.md`, confirmed it's byte-identical to the copy already sitting in `docs/` in your connected "DESPL TRACKER" project folder, and then went into the actual repo — `prisma/schema.prisma`, `prisma/seed.ts`, `scripts/seed-despl320-and-de0467.ts`, `scripts/bootstrap-schedule.ts`, `seed/qcp-templates.json`, `seed/component-routes.json`, and `progress.md` — to see what of the doc's "next steps" is already built versus still open. That changes what "start development" should actually mean here, so I'm leading with it.

---

## 1. Checking the document — what I found

**The schedule math and department table (§2–3 of your doc) check out.** They match `lib/schedule/`'s own max-duration-envelope rule and the 36-process spine, and the 8-Apr-2027 dispatch date is consistent with the engine's own logic as your doc describes it.

**Two things need correcting before this goes to the team as a commitment:**

1. **The live app is currently showing the wrong dates for DESPL-320 — this is more urgent than the doc implies.** Your doc frames the order-date question as "unblock scheduling" (i.e. as if nothing is scheduled yet). That's not quite what's happening. Per `progress.md`: DESPL-320 was seeded to production on 22 Aug 2026 with a full department-workflow schedule (36 processes × 9 units = 324 `ProcessPlan` rows) already generated and live. But `scripts/bootstrap-schedule.ts` generated it off a **synthetic placeholder anchor date** — "~10 weeks back from whenever the script ran" — specifically so the demo would show a realistic mix of overdue/current/future work, because the real order date was null at the time. That synthetic schedule is what's live on the production site right now. It is not close to 20-Nov-2026 / 8-Apr-2027. **Anyone looking at the live tracker today for DESPL-320 is looking at fabricated demo dates, not real ones.** Setting the real order date isn't unblocking a refusal — it's replacing wrong numbers with right ones. See §3 below for the exact fix.

2. **Component count arithmetic error in §4.4.** Your doc says "10 trackable components per unit" and then lists them: Shell, Top Dished End, Bottom Dished End, Skirt, **and each of the 7 nozzle connections (M1, N1–N6)**. That's 4 + 7 = **11**, not 10. So it should be 11 × 9 units = **99 component rows**, not 90. I built the register in §4 below using 99.

**Everything else — the BOM extraction, the weld-joint cross-references, the P/W/H legend — reads correctly and matches the real QCP data in the repo** (see §5; the actual seeded QCP has 54 checkpoints across 8 sections, of which your doc's §5 gave a reasonable 24-step *summary*, not a replacement — I've used the full real list below since it's already the authoritative source in the system).

---

## 2. What's actually live for DESPL-320 right now, vs. what's still missing

| Piece | Status | Source |
|---|---|---|
| `Job` record (DESPL-320, family PRESSURE_VESSEL) | **Live**, but `orderDate`/`committedDeliveryDate` still `NULL` in the row's own intent — production is currently running on a synthetic date instead | `scripts/seed-despl320-and-de0467.ts` |
| 36-process spine × 9 units (`JobProcess`, `ProcessPlan`) | **Live**, 324 `ProcessPlan` rows, seeded 22 Aug — **but dated off the synthetic anchor, not 20-Nov-2026** | `progress.md`, 22 Aug entry |
| 9 `Unit` rows (320SR01…320SR09) | **Live** | `scripts/seed-despl320-and-de0467.ts` |
| QCP template — 54 checkpoints across 8 sections, P/W/H per party (DESPL, BUYER_TPI) | **Live**, cross-linked to the 36 processes via `QcpItemProcess` | `seed/qcp-templates.json` (`template.job = "DESPL-320-01 to 09"`) |
| **BOM (`BomItem`) register** | **Missing.** DESPL-320 has no BOM rows at all — unlike DE0463/DE0467, which were seeded from a real CSV export, DESPL-320 was only ever seeded from the QCP document header (job number, vessel name, unit count). Nobody ever fed it a BOM. | confirmed by reading `scripts/seed-despl320-and-de0467.ts` end to end |
| **Component / ComponentOperation register (sub-assembly fabrication route)** | **Missing**, same reason as above | same |
| `WeldJoint` rows (LS-1, CS-1, CS-2, per-nozzle joints) | **Not seeded, and shouldn't be** — this is real shop-floor data (welder, date, joint size) entered live through the app as welding actually happens, the same way it works for every other job. Nothing to build here. | `prisma/schema.prisma` model comments |

So the genuinely new work is exactly the two "Missing" rows — the BOM/component (sub-assembly) register — plus the one urgent fix (real order date). The assembly sequence (weld/QCP checkpoints) is **not** new work; it's already correctly seeded at higher fidelity than the doc's own 24-step summary, and just needed presenting properly, which §5 does.

---

## 3. Immediate action — replace the synthetic schedule with the real one

Two DB writes, then one regenerate:

```
Job.orderDate = 2026-11-20
Job.committedDeliveryDate = 2027-04-08
```

Then re-run the bootstrap for DESPL-320 only:

```bash
pnpm db:bootstrap DESPL-320
```

`generateSchedule` creates a **new** `ScheduleRun` (version-numbered, marked `isCurrent`) rather than overwriting the synthetic one in place — so the demo/synthetic run stays in the DB as history, and the workspace/dashboard screens switch over to the real dates as soon as this runs. This is exactly the pattern `bootstrap-schedule.ts` already implements (`orderDate ?? synthetic anchor`); it just hasn't been re-run since a real date became available.

**Open item carried over from your doc, unchanged:** whether the 119-day envelope should also exclude company holidays beyond Sundays (**C1** in `docs/BUILD-SPEC-v2.md` §7) is still unconfirmed by SJ. Doesn't block doing the above — it would just mean re-running the same command again once that answer comes in.

---

## 4. Sub-Assembly Tracker — component fabrication register

This is the part your doc flagged as Phase 1 and left as a plan ("10 trackable components... your call"). I've turned it into an actual seed input, corrected to 11 components, with each one mapped to a **real route already defined in `seed/component-routes.json`** (so no new routing logic is needed — just new rows that point at routes that already exist).

**11 trackable components per unit × 9 units = 99 `Component` rows.** Everything not in this list (studs, nuts, gaskets, rivets, handles, SV1–SV4, lifting/tailing lugs, nameplate) stays at the BOM/procurement layer or folds into process #23 "Internal & External Attachments," exactly as your doc originally proposed — I kept that call, just fixed the count.

| Tag | Component | Route (`seed/component-routes.json`) | Weld joint(s) | Material |
|---|---|---|---|---|
| `SHELL` | Shell (single course) | **PLATE**: Receipt → MTC Verification → Cutting → Edge Prep → Rolling/Forming → Fit-up → Welding → RT/UT → Grinding → Inspection | LS-1 | SA 516 Gr 485 |
| `TOP-HEAD` | Top Dished End | **DISHED_END**: Plate Cutting → Pressing/Spinning → Trimming → NDT → Inspection | CS-1 | SA 516 Gr 485 |
| `BOTTOM-HEAD` | Bottom Dished End | **DISHED_END**: same as above | CS-2 | SA 516 Gr 485 |
| `SKIRT` | Skirt (shell + base ring + 24 gussets, tracked as one unit) | **SKIRT**: Plate Rolling → Welding → Machining → Inspection | — (QCP 4.13/4.14, no numbered joint) | SA 516 Gr 485 / IS 2062 E 250 B |
| `N1` | Nozzle N1 (flange only) | **FLANGE**: Receipt → Machining → Facing → Drilling → Inspection | — | SA 105 |
| `N2` | Nozzle N2 (flange + pipe ×2 + elbow + stiffener + support pipe) | **PIPE**: Receipt → Cutting → Beveling → Fit-up → Welding → RT/PT → Inspection | — | SA 333 Gr 6 / SA 234 WPB / SA 105 |
| `N3` | Nozzle N3 (SRN forging + flange + 3× stiffener) | **FORGING**: Receipt → Machining → NDT → Inspection | — | SA 266 Gr 2 / SA 105 |
| `N4` | Nozzle N4 (coupling) | **COUPLING**: Receipt → Thread Inspection → Dimension Check | — | SA 105 |
| `N5` | Nozzle N5 (coupling) | **COUPLING**: same as above | — | SA 105 |
| `N6` | Nozzle N6 (coupling) | **COUPLING**: same as above | — | SA 105 |
| `M1` | Manway M1 (SRN forging; blind flange/gasket/bolting/davit are BOM hardware only) | **FORGING**: Receipt → Machining → NDT → Inspection | — | SA 266 Gr 2 |

Full detail (sizes, qty, per-BOM-row sourcing notes) is in the machine-readable version: **`seed/despl-320-components.json`** — delivered alongside this document, written in the same style as your existing `seed/component-routes.json` / `seed/live-jobs.json` so a developer (or agent) can wire it in directly. It documents, per component: which BOM rows feed it, its route, its weld-joint cross-reference, and — for `M1` and `N2` — which sub-parts are hardware-only vs. part of the tracked fabrication route.

**How this plugs into the existing seed script:** `scripts/seed-despl320-and-de0467.ts` already has the exact ingestion pattern needed — it's the block that builds DE0467's `BomItem`/`Component`/`ComponentOperation` rows from `live-jobs.json` (around line 525–561: resolve `componentTypeId` from the routes file, `tx.component.create` with `tag`, `componentTypeId`, `routeVersionId`, then seed `ComponentOperation` rows NOT_STARTED from the route's steps). DESPL-320 needs the same block, reading `seed/despl-320-components.json` instead, run once per unit (9×) since DESPL-320 is serialized (`unitId` set) rather than job-grain like DE0467. That's the concrete "start development" task for this half of the tracker.

---

## 5. Assembly Tracker — the real weld & QCP sequence, grouped by sub-assembly

This is already seeded and live (`seed/qcp-templates.json`, job `"DESPL-320-01 to 09"`) — 54 checkpoints across 8 sections, each carrying a P (Perform) / W (Witness) / H (Hold) / R (Review) code per party (**DESPL**, **BUYER_TPI**) and a cross-link to the relevant process numbers from §2 of the schedule doc. I've grouped it below by sub-assembly rather than raw QCP section numbering, since that's the shape useful for a build/assembly hand-off — the underlying `srNo`s are untouched so this maps back to the live QCP one-for-one.

**H = Hold (blocks completion until cleared) · W = Witness (client/TPI may attend, waivable with Production Head approval) · P = Perform · R = Review only.**

#### A. Document & Procedure Gate (pre-fabrication)

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 1.1 | Drawing Approval | P | R | #1,#2 |
| 1.2 | Review And Approval Of Quality Contol Plan | P | R | #1,#2 |
| 1.3 | Hot Forming Proceude, Ht Procedure, Rt Procedure, Pt Procedure, Paut & Tofd Procedure | H | R | #1,#2 |
| 2.1 | Welding Procedure & Performance Qualification | P | R | #2 |

#### B. Material Inspection & Traceability

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 3.1 | Pressure Part - Plates,Pipes/Forgings/Flange/ Fittings | H | W | #10,#11 |
| 3.2 | Non Pressure Parts & Attachment To Pressure Parts | H | R | #10,#11 |
| 3.3 | Welding Consumable | R | R | #10,#11 |
| 3.4 | Weld Plan/Weld Map | P | R | #10,#11 |

#### C. Shell & Head Prep — marking, cutting, forming, heat-treat test coupon

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.1 | Transfer Of Marking And Cutting (Shell And Dished End) | H | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### D. Head Sub-Assembly — dished-end inspection & weld-edge prep

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.2 | Inspection Of Top & Bottom Dished | R | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.2 | Simulation Heat Treatment Of Test Coupon After Forming & Testing | R | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.4 | Weld Edge Preparation Of Top & Bottom Dished End | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### E. Shell Sub-Assembly — long seam (LS-1)

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.5 | Shell Weld Edge Preparation | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.5 | L' Seam Set Up Of Shell (Ls-1 ) Along With Ptc | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.5 | Weld Long Seam Of Shell (Ls-1 ) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.5 | Weld Visual Of Ls-1 | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.5 | Paut/Tofd Of Ls-1 | P | W | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### F. Nozzle Sub-Assembly — flange/elbow join (M1/N2/N3)

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.6 | Nozzle To Flange/Elbow Set Up (M1/N2/N3) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.6 | Weld Of Nozzle To Flange/Elbow (M1/N2/N3) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.6 | Weld Visual Of Cs Joint Nozzle M1/N2/N3 | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.6 | Rt Circ Seam Of Nozzle Pipe To Flange (M1/N2/N3) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### G. Shell + Bottom Head Sub-Assembly — circ seam CS-2

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.7 | Bottom Dished End To Shell Set Up (Cs-2) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.7 | Weld Circ Seam Of Bottom Dishend To Shell (Cs-2) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.7 | Weld Visual Of Cs -2 | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.7 | Paut/Tofd Of Cs-2 | P | W | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### H. Nozzle & Manway Sub-Assembly — join to shell/heads (M1, N1-N6)

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.8 | Marking For Nozzle On Shell And Dished End (M1, N1 To N6) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.8 | Nozzle To Shell & Dished End Set Up (M1/N1/N2/N3/N4/N5/N6) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.8 | Weld Of Nozzle To Shell & Dished End (M1/N1/N2/N3/N4/N5/N6) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.8 | Weld Visual Of Nozzle To Shell & Dished End (M1/N1/N2/N3/N4/N5/N6) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.8 | Ultrasonic Test Of Nozzle To Shell & Dished End (M1/N1/N2/N3) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### I. Final Closure Gate

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.9 | Clearance Of Shell Before Closing Dished End Set Up | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### J. Shell + Top Head Sub-Assembly — circ seam CS-1 (final closure weld)

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.10 | Top Dished End To Shell Set Up (Cs- 1) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.10 | Weld Circ Seam Of Top Dishend To Shell (Cs-1) | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.10 | Weld Visual Of Cs -1 | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.10 | Paut/Tofd Of Cs-1 | P | W | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### K. Attachments Sub-Assembly — lifting lug & name plate bracket

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.11 | Lifting Lug & Name Plate Bracket Set Up | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.12 | Weld Of Lifting Lug | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.12 | Weld Of Name Plate Bracket | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### L. Skirt Sub-Assembly

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.13 | Skirt Support Set Up | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |
| 4.14 | Weld Skirt Support | P | R | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### M. Pre-PWHT Gate

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 4.15 | Clearance Befor Pwht | P | W | #12,#13,#14,#15,#16,#17,#18,#19,#20 |

#### N. Heat Treatment (PWHT) & Post-PWHT NDT

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 5.1 | Inspection Of Vessel Heat Treatment | R | R | #21,#22 |
| 5.2 | Weld Visual Of All Weld Joints | P | W | #21,#22 |
| 5.3 | Mpt Of All Weld Joint | P | W | #21,#22 |
| 5.4 | Rt Testing On All Butt Weld Joints(M1/N2/N3) Paut/Tofd For L'seam & C'seam Joints. (After Pwht). | P | W | #21,#22 |

#### O. Hydrostatic Test

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 6.1 | Clearance For Hydrostatic Test | P | R | #27,#28 |
| 6.2 | Before Hydrostatic Test Clearance | P | R | #27,#28 |
| 6.3 | Hydrostatic Test | P | W | #27,#28 |
| 6.4 | Mpt / Lpt All Weld Joints After Hydro Test | P | W | #27,#28 |

#### P. Surface Treatment & Painting

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 7.1 | Cleaning & Surface Preparation | P | R | #29,#30 |
| 7.2 | Painting | P | W | #29,#30 |

#### Q. Final Inspection, Nameplate & MDR

| Sr No | Activity | DESPL | BUYER TPI | Process link |
|---|---|---|---|---|
| 8.1 | Verification Of Name Plate | P | R | #31,#32 |
| 8.2 | Attachment Of Name Plate To Name Plate Bracket | P | R | #31,#32 |
| 9.1 | Documentation | R | R | #31,#32 |

**Reading this as a build sequence:** C (shell & head prep) → D (head inspection/edge-prep) and E (shell long seam, LS-1) run in parallel → F (nozzle-to-flange sub-assemblies) can proceed alongside → G (bottom head closes onto the shell, CS-2) → H (all nozzles and the manway go onto the shell/heads) → I (clearance gate) → J (top head closes the vessel, CS-1 — this is the last hull weld) → K/L (external attachments: lifting lug, nameplate bracket, skirt) → M (pre-PWHT gate) → N (heat treatment + post-PWHT NDT) → O (hydrotest) → P (paint) → Q (nameplate + MDR close-out). Ten of the 54 checkpoints are Witness or Hold points (roughly a fifth), concentrated in Material Inspection (B), the LS-1/CS-1/CS-2 welds (E/G/J), pre-PWHT clearance (M), post-PWHT NDT (N), and hydrotest (O) — those are the points that need the client/TPI actually invited, not just informed.

---

## 6. Handoff checklist for the team

1. **Set `Job.orderDate = 2026-11-20`, `Job.committedDeliveryDate = 2027-04-08` for DESPL-320, then run `pnpm db:bootstrap DESPL-320`** — replaces the synthetic demo schedule with the real one. Highest priority; the live app is showing wrong dates until this runs. (§3)
2. **Extend `scripts/seed-despl320-and-de0467.ts`** with a DESPL-320 BOM/Component ingestion block reading the new `seed/despl-320-components.json`, mirroring the existing DE0467 block. Produces 99 `Component` rows + their `ComponentOperation` steps. (§4)
3. **No action needed on the assembly/QCP side** — it's correctly seeded already; §5 is for team visibility and matching against the physical weld map, not new database work.
4. **Still pending from DESPL, unchanged:** the C1 working-vs-calendar-days holiday question (`docs/BUILD-SPEC-v2.md` §7) — doesn't block 1–3 above.
5. Once 1–2 are done, `Component`/`ComponentOperation` status will show up on the same job page as the schedule and QCP tabs (per `progress.md`, §9.6 "Job detail (Gantt + BOM + QCP tabs)" already ships this UI — it just has nothing to render for DESPL-320 yet).

---

**Files delivered alongside this document:**
- `seed/despl-320-components.json` — the 11-component-per-unit register in a machine-readable, ready-to-wire-in shape (§4)
- `DESPL-320 Production Tracker.xlsx` — the same schedule/BOM/assembly data as a working spreadsheet, for the floor/production side of the team who won't be opening the repo
