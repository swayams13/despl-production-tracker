# DESPL-320 — BOM, Assembly Sequence & Department Schedule (dev-ready)

**Date:** 25 Aug 2026 · **Source documents:** `QCP DESPL 320SR01 to 09.pdf` (Rev 0, DESPL-320-01 to 09, HP Air Receiver, drg PN-EM3-HIN-301-MEC-040-DG-4503 Rev A) and `DESP 320 BOM.pdf` (General Arrangement Drawing, "Common for Large & Small Unit," bill of material for one qty). **Order date fixed per your instruction: 20 Nov 2026.** This document is built to be handed straight to development — it has the real BOM, the real assembly/weld sequence, and a computed date for every process and department.

**Companion file:** `DESPL-320-schedule.csv` — the 36-process table below as CSV, ready to paste into a seed script.

---

## 1. Schedule basis — read this before trusting any date below

Dates are computed using the tracker's own existing scheduling engine logic (`lib/schedule/`, BUILD-SPEC-v2): the 36-process envelope, **max-duration column only** (the codebase's own rule — CPM on min durations gives 37 days instead of 119 and must never be used), applied against **order date = 20 Nov 2026 (Friday)**, counting only working days with **Sunday as the week-off day** (the tracker's current default assumption — `calendarBasis.value = CALENDAR_DAYS_6DAY_WEEK`).

This produces a **committed dispatch date of 8 Apr 2027** (day 119) — matching the ~17-week envelope DESPL itself printed. **One open item (already flagged in the repo as "C1," still unconfirmed by SJ):** whether the 119 days should also exclude company holidays beyond Sundays. If DESPL confirms a holiday list, every date below shifts later by however many holidays fall in the window — worth getting that answer before these dates go in front of the team as commitments, but it should not block starting development against them today.

---

## 2. Full 36-process schedule (department, start-by, finish-by)

| # | Process | Department | Start by | Finish by |
|---|---|---|---|---|
| 1 | PO Receipt & Order Review | Projects / PMO | 20-Nov-2026 | 23-Nov-2026 |
| 2 | Kick-Off / Pre-Inspection Meeting | Projects / PMO | 23-Nov-2026 | 26-Nov-2026 |
| 3 | Engineering – Design Calculation | Design & Detail Engineering | 25-Nov-2026 | 07-Dec-2026 |
| 4 | Engineering – Manufacturing Drawings | Design & Detail Engineering | 03-Dec-2026 | 15-Dec-2026 |
| 5 | Client Drawing Approval | Design & Detail Engineering | 14-Dec-2026 | 31-Dec-2026 |
| 6 | BOM & MTO Finalization | Planning / PPC | 26-Dec-2026 | 31-Dec-2026 |
| 7 | Material Procurement – Plates | Procurement | 07-Dec-2026 | 10-Feb-2027 |
| 8 | Material Procurement – Pipes/Forgings/Fittings | Procurement | 15-Dec-2026 | 02-Feb-2027 |
| 9 | Bought-Out Items Procurement | Procurement | 15-Dec-2026 | 25-Jan-2027 |
| 10 | Material Receipt & Incoming Inspection | Stores | 06-Feb-2027 | 10-Feb-2027 |
| 11 | Material Identification & Traceability | QC | 08-Feb-2027 | 10-Feb-2027 |
| 12 | Cutting / Blanking / Petals | Fabrication Prep | 05-Feb-2027 | 10-Feb-2027 |
| 13 | Forming / Rolling / Dishing | Fabrication Prep | 10-Feb-2027 | 18-Feb-2027 |
| 14 | Machining | Machine Shop | 10-Feb-2027 | 18-Feb-2027 |
| 15 | Shell Fit-Up | Fabrication / Welding | 13-Feb-2027 | 18-Feb-2027 |
| 16 | Shell Welding | Fabrication / Welding | 18-Feb-2027 | 26-Feb-2027 |
| 17 | Weld NDE | QC | 20-Feb-2027 | 26-Feb-2027 |
| 18 | Head/Dish-End Assembly | Fabrication / Welding | 22-Feb-2027 | 26-Feb-2027 |
| 19 | Nozzle Fabrication & Fit-Up | Fabrication / Welding | 20-Feb-2027 | 26-Feb-2027 |
| 20 | Nozzle Welding | Fabrication / Welding | 01-Mar-2027 | 06-Mar-2027 |
| 21 | PWHT / Heat Treatment | Heat Treatment | 01-Mar-2027 | 06-Mar-2027 |
| 22 | NDE After Welding/PWHT | QC | 01-Mar-2027 | 06-Mar-2027 |
| 23 | Internal & External Attachments | Fabrication / Welding | 06-Mar-2027 | 15-Mar-2027 |
| 24 | Final Assembly | Fabrication / Welding | 09-Mar-2027 | 15-Mar-2027 |
| 25 | Final Dimensional Inspection | QC | 12-Mar-2027 | 15-Mar-2027 |
| 26 | Final Visual Inspection | QC | 13-Mar-2027 | 15-Mar-2027 |
| 27 | Hydrostatic / Pressure Test | QC | 12-Mar-2027 | 15-Mar-2027 |
| 28 | Draining & Drying | Fabrication / Welding | 12-Mar-2027 | 15-Mar-2027 |
| 29 | Surface Preparation | Surface Treatment & Painting | 19-Mar-2027 | 23-Mar-2027 |
| 30 | Painting / Coating | Surface Treatment & Painting | 17-Mar-2027 | 23-Mar-2027 |
| 31 | Final Inspection | QC | 27-Mar-2027 | 31-Mar-2027 |
| 32 | Name Plate & Final Stamping | QC | 30-Mar-2027 | 31-Mar-2027 |
| 33 | MDR / Final Documentation | Documentation | 31-Mar-2027 | 08-Apr-2027 |
| 34 | Packing & Preservation | Dispatch & Logistics | 05-Apr-2027 | 08-Apr-2027 |
| 35 | Dispatch Clearance | Dispatch & Logistics | 06-Apr-2027 | 08-Apr-2027 |
| 36 | Dispatch | Dispatch & Logistics | 07-Apr-2027 | **08-Apr-2027 (committed delivery)** |

## 3. Department deadlines — one line per department to hand out today

Each department's own "you're done when" date is the latest finish-by among its own processes:

| Department | First activity starts by | Department's own work done by |
|---|---|---|
| Projects / PMO | 20-Nov-2026 | 26-Nov-2026 |
| Design & Detail Engineering | 25-Nov-2026 | 31-Dec-2026 |
| Planning / PPC | 26-Dec-2026 | 31-Dec-2026 |
| Procurement | 07-Dec-2026 | 10-Feb-2027 |
| Stores | 06-Feb-2027 | 10-Feb-2027 |
| Fabrication Prep (cutting/forming) | 05-Feb-2027 | 18-Feb-2027 |
| Machine Shop | 10-Feb-2027 | 18-Feb-2027 |
| Fabrication / Welding | 13-Feb-2027 | 15-Mar-2027 (last of its 8 processes: Draining & Drying) |
| Heat Treatment | 01-Mar-2027 | 06-Mar-2027 |
| QC | 08-Feb-2027 | 31-Mar-2027 (last: Name Plate & Final Stamping) — QC touches 8 separate processes across the whole job, more than any other department |
| Surface Treatment & Painting | 17-Mar-2027 | 23-Mar-2027 |
| Documentation | 31-Mar-2027 | 08-Apr-2027 |
| Dispatch & Logistics | 05-Apr-2027 | 08-Apr-2027 (dispatch) |

Note the two long-duration departments carrying the schedule's real risk: **Procurement (07-Dec → 10-Feb, 65 calendar days)** and **Fabrication/Welding (13-Feb → 15-Mar, spanning 8 of the 36 processes)** — these are where a delay actually threatens the 8-Apr commitment; everything downstream is comparatively short.

---

## 4. The BOM — extracted component register (per unit; ×9 for 320SR01–09)

The drawing's own bill of material is titled **"Bill of Material for One Qty"** — every figure below is per vessel; multiply by 9 for the full DESPL-320 order. The main pressure-boundary components (shell, two dished ends) don't appear as small-parts BOM rows — they're derived directly from the design/nameplate data and the QCP's own weld-joint references (LS-1, CS-1, CS-2), not itemized the way brackets and nozzle hardware are.

**Read this as a spot-checked extraction, not a certified transcription** — sizes/materials were read off a high-resolution render of a dense engineering table under a real time constraint. Component identity, tag, and quantity are solid (cross-verified against the QCP's own weld-joint list in §5); treat exact dimensions as "verify against the original drawing before it becomes a procurement document."

### 4.1 Main pressure parts (not in the small-parts table — confirmed via QCP + GA drawing)

| Component | Qty/unit | Material (per QCP §3.1) | Weld joint(s) |
|---|---|---|---|
| Shell (single course) | 1 | SA 516 Gr 485, normalized fine-grain fully killed | LS-1 (long seam) |
| Top Dished End (head) | 1 | SA 516 Gr 485 | CS-1 (circ seam to shell) |
| Bottom Dished End (head) | 1 | SA 516 Gr 485 | CS-2 (circ seam to shell) |

### 4.2 Nozzles, manway and their hardware (item numbers from the BOM table, 201–243 range)

| Tag | Component | Qty/unit | Material | Size | Notes |
|---|---|---|---|---|---|
| N1 | Flange | 1 | SA 105 | per detail | |
| N2 | Flange | 1 | SA 105 | DN25 class | |
| N2 | Nozzle Pipe (×2 lengths) | 1+1 | SA 333 Gr 6 | DN25 SCH.XXS, 1270 LG / 170 LG | two pipe segments |
| N2 | Nozzle Elbow | 1 | SA 234 Gr WPB | DN25 SCH.XXS 90° LR | |
| N2 | Stiffener | 1 | SA 516 Gr 485 | 6T×50W×250 LG | |
| N2 | Support Pipe | 1 | SA 106 Gr B | DN200 SCH80×115 LG | |
| N3 | Stiffener | 3 | SA 516 Gr 485 | 6T×82W×80 LG | |
| N3 | Flange | 1 | SA 105 | DN125 SCH.XXS CL.600 WNRF | |
| N3 | SRN | 1 | SA 266 Gr 2 | per detail | |
| N4, N5, N6 | Coupling (shared item) | 3 | SA 105 | DN15 SCH.XXS × 6000# BSP | one item covers all three tags |
| **M1 (Manway)** | SRN | 1 | SA 266 Gr 2 | DN450×22THK ASME 600CL WNRF | |
| M1 | Blind Flange (cover) | 1 | SA 105 | DN450 ASME 600CL BL RF | 535 kg — the single heaviest loose item |
| M1 | Gasket | 1 | per Note 1 (Grafoil-filled spiral-wound, SS316L, 3.2T CS outer ring) | DN450 ASME 600CL B16.20 | |
| M1 | Stud w/ 2 Hvy. Hex. Nut | 20 | SA193 Gr B7 / SA194 Gr 2H | 1-5/8" UNC × 280L full thread | manway bolting set |
| M1 | Davit/hinge assembly | 1 set | mixed (SA516/IS2062/SS304) | — | sq. bar hook, eye bolt, washer, hex nut, hex lock nut, support pipe, davit pipe, end plates ×2, rivet, rib plate, davit boss, handle ×3, jack screw ×4 — the mechanism that swings the cover open |
| SV1–SV4 | Nozzle Pipe | 4 | — | DN100 SCH80 | 4 small nozzles, access-opening related |

### 4.3 Attachments and support structure

| Component | Qty/unit | Material | Size | Weight (kg) |
|---|---|---|---|---|
| Skirt Shell | 1 | SA 516 Gr 485 | 16T×1062W×7323 DEV.LG | 977 |
| Skirt Base Ring | 1 | IS 2062 E 250 B | 32T×2187 ID×2600 OD | 390 |
| Gusset Plate | 24 | IS 2062 E 250 B | 12T×127W×150 LG | 43 total |
| Earthing Plate | 2 | SS 304 | 10T×75W×75 LG | 0.9 |
| Access Opening (AO) + Access Screw | 2 | SS 304 | — | small |
| Pad Plate | 2 | SA 516 Gr 485 | — | 16 |
| Lifting Lug | 2 | SA 516 Gr 485 | 36T×230W×697 LG | 91 |
| Support Plate | 1 | SA 516 Gr 485 | 28T×485W×230L | 49 |
| Tailing Lug | 1 | SA 516 Gr 485 | 36T×250W×250 LG | 17.8 |
| Name Plate Bracket | 1 | SA 516 Gr 485 | 6T×160×350 LG | 2.63 |
| Name Plate | 4 | SS 304 | 3T×150×200 L | 0.75 |
| Rivet | 4 | SS 304 | ø6×25 LG | 0.05 |

**Per-unit total weight (loose items only, from the BOM's own total row): 2,890 kg**, before the main shell/head plate weight (not in this table).

### 4.4 What this means for the component register (Phase 1 of the earlier plan)

For DESPL-320's `Component`/`ComponentOperation` seeding, the components that actually need an operation route (cutting → forming → fit-up → welding → NDT → inspection) are: **Shell, Top Dished End, Bottom Dished End, Skirt, and each of the 7 nozzle connections (M1, N1–N6)** — 10 trackable components per unit, ×9 units = 90 component rows for DESPL-320. Small hardware (studs, nuts, washers, rivets, gaskets, handles) stays at the BOM/procurement layer only — it gets received and issued, never its own fabrication route. SV1–SV4 and the lifting/tailing lugs are simple enough that they can either get their own lightweight route or be folded into "Internal & External Attachments" (process 23) as a single tracked step — your call, doesn't block starting.

---

## 5. The real assembly & weld sequence — extracted from the QCP (this is your Phase-3 checklist)

This is the actual, DESPL-approved build order for one HP Air Receiver, read directly from QCP §4 ("Inspection During Fabrication") and cross-referenced against the weld-joint codes on the drawing. Each step below is a candidate row for the `AssemblyStep`-style checklist recommended in the earlier plan (§8c of the previous document) — ordered, one line each, with the QCP's own P/W/H code so the hold/witness points come along for free.

| # | Step | QCP ref | Code |
|---|---|---|---|
| 1 | Marking & cutting transfer (shell + dished ends) | 4.1 | **H** (hold) |
| 2 | Top & Bottom Dished End hot forming + inspection | 4.2 | R |
| 3 | Simulated heat treatment of test coupon + Dished End heat treatment inspection | 4.3 | R |
| 4 | Weld edge preparation — Dished Ends + Shell | 4.4 | P |
| 5 | Shell long seam set-up (**LS-1**) | 4.5 | P |
| 6 | Shell long seam weld (LS-1) — back-chip, LPT, visual, **PAUT/TOFD** | 4.5 | P / **W** |
| 7 | Nozzle N2/N3 to flange/elbow sub-assembly, weld, RT | 4.6 | P |
| 8 | Bottom Dished End to Shell set-up (**CS-2**) | 4.7 | P |
| 9 | Bottom Dished End to Shell weld (CS-2) — visual, **PAUT/TOFD** | 4.7 | P / **W** |
| 10 | Marking for nozzles on shell & dished ends (M1, N1–N6) | 4.8 | P |
| 11 | Nozzle-to-shell/dished-end set-up, weld, visual, UT (M1, N1–N6) | 4.8 | P |
| 12 | Clearance of shell before closing (pre-CS-1 check) | 4.9 | P |
| 13 | Top Dished End to Shell set-up (**CS-1**) | 4.10 | P |
| 14 | Top Dished End to Shell weld (CS-1) — visual, **PAUT/TOFD** | 4.10 | P / **W** |
| 15 | Lifting lug & name plate bracket set-up + weld (MPT) | 4.11–4.12 | P |
| 16 | Skirt support set-up + weld (MPT) | 4.13–4.14 | P |
| 17 | Clearance before PWHT | 4.15 | **W** |
| 18 | PWHT (post-weld heat treatment) | §5.1 | R |
| 19 | Post-PWHT NDT — weld visual, MPT, final RT/PAUT | §5.2–5.4 | **W** |
| 20 | Hydrostatic test (clearance, calibration, leak detection) | §6 | P / **W** |
| 21 | Post-hydro MPT/LPT of all welds | §6.4 | **W** |
| 22 | Surface prep & painting | §7 | P / **W** |
| 23 | Final inspection — name plate verification & attachment | §8 | P |
| 24 | MDR compilation | §9 | R |

**H = Hold point (cannot proceed without clearance), W = Witness point (client/TPI may attend), P = Perform, R = Review.** Steps 6, 9, 14, 17, 19, 20, 21, 22 are all witness points — worth knowing that roughly a third of this sequence is inspection-gated, not just fabrication.

---

## 6. Start development now — the concrete next steps

Everything below plugs directly into Phase 0/1/3 of the earlier audit-and-plan document, now with real numbers instead of placeholders:

1. **Unblock scheduling today:** set `Job.orderDate = 2026-11-20` for DESPL-320 (and `committedDeliveryDate = 2027-04-08` per §2 above, or run `generateSchedule` once the order date is set and let the engine compute it — same result). This alone removes the `SCHEDULE_DATA_MISSING` refusal blocking every dashboard for this job.
2. **Seed the component register** per §4.4: 10 trackable components × 9 units = 90 `Component` rows, each pinned to the right `RouteTemplateVersion`/`ComponentTypeRef` (Shell, Dished End, Nozzle ×7 tags, Skirt).
3. **Seed the assembly checklist** per §5: 24 ordered `AssemblyStep`-style rows per unit, carrying the QCP's own P/W/H code so a hold/witness point is visible the moment the checklist is seeded — no separate modeling work needed for that part.
4. **The 36-process schedule in §2 / the CSV** becomes each unit's `ProcessPlan` — department and date columns are already in the right shape to import directly.
5. Everything else — the component-operation Start/Submit/Verify actions, the material-hold pattern, the mobile fixes — proceeds exactly as sequenced in the earlier plan; this document just gives Phase 0 and the seed data a real, finished answer instead of an open question.
