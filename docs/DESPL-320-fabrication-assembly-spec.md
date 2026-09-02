# DESPL-320 — Fabrication & Assembly spec (machine-readable)

> Generated from `docs/DESPL-320 Fabrication Operations Tracker.xlsx` (v2, 25 Aug 2026) so it can be
> read directly by tooling. **The workbook remains the source of truth** — if they diverge, the
> workbook wins and this file should be regenerated.
>
> The workbook holds 9 identical unit blocks (320SR01–320SR09). Only 320SR01 is reproduced below;
> multiply by 9. Companion: `docs/AUDIT-addendum-fabrication-and-assembly.md`.

## Column contract — what the floor records

**Fabrication Operations Tracker:** `Unit · Component Tag · Component · Seq · Operation · Started · Ended · Status · Operator/Welder · Remarks`

**Assembly & Weld Checklist:** `Unit · Sub-assembly · Sr No · Activity · DESPL · BUYER TPI · Started · Completed · Cleared by · Status · Remarks`

`Started` / `Ended` / `Completed` are server-clock only (invariant #1) — never accepted from a request.
`DESPL` and `BUYER TPI` carry the QCP codes: P = Perform, W = Witness, H = Hold, R = Review/Record.

## Totals

| | Per unit | × 9 units |
|---|---:|---:|
| Fabrication operations | 54 | 486 |
| Assembly / weld checkpoints | 54 | 486 |
| Trackable components | 11 | 99 |

---

## 1. Fabrication operations — 54 per unit


### `SHELL-01` — Shell (single course)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Receipt |  |
| 2 | MTC Verification |  |
| 3 | Cutting |  |
| 4 | Edge Preparation |  |
| 5 | Rolling | Team asked to track Rolling and Forming as two separate timed steps. The app's PLATE route today has one combined 'Forming' operation — see Dev Not... |
| 6 | Forming (Sizing / Calibration) | Team asked to track Rolling and Forming as two separate timed steps. The app's PLATE route today has one combined 'Forming' operation — see Dev Not... |
| 7 | Fit-up |  |
| 8 | Welding (Long Seam) |  |
| 9 | RT/UT |  |
| 10 | Grinding |  |
| 11 | Inspection |  |

### `TOP-HEAD-01` — Top Dished End (head)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Plate Cutting |  |
| 2 | Pressing / Spinning (Hot Forming) |  |
| 3 | Trimming |  |
| 4 | NDT |  |
| 5 | Inspection |  |

### `BOTTOM-HEAD-01` — Bottom Dished End (head)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Plate Cutting |  |
| 2 | Pressing / Spinning (Hot Forming) |  |
| 3 | Trimming |  |
| 4 | NDT |  |
| 5 | Inspection |  |

### `SKIRT-01` — Skirt assembly (skirt shell + base ring + 24 gusset plates, tracked as one fabrication unit)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Plate Rolling |  |
| 2 | Welding |  |
| 3 | Machining |  |
| 4 | Inspection |  |

### `N1-01` — Nozzle N1 (flange, per detail)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Receipt |  |
| 2 | Machining |  |
| 3 | Facing |  |
| 4 | Drilling |  |
| 5 | Inspection |  |

### `N2-01` — Nozzle N2 sub-assembly (flange + 2x pipe segments + 90 deg elbow + stiffener + support pipe)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Receipt |  |
| 2 | Cutting |  |
| 3 | Beveling |  |
| 4 | Fit-up |  |
| 5 | Welding |  |
| 6 | RT/PT |  |
| 7 | Inspection |  |

### `N3-01` — Nozzle N3 (SRN forging + flange + 3x stiffener)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Receipt |  |
| 2 | Machining |  |
| 3 | NDT |  |
| 4 | Inspection |  |

### `N4-01` — Nozzle N4 (coupling)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Receipt |  |
| 2 | Thread Inspection |  |
| 3 | Dimension Check |  |

### `N5-01` — Nozzle N5 (coupling)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Receipt |  |
| 2 | Thread Inspection |  |
| 3 | Dimension Check |  |

### `N6-01` — Nozzle N6 (coupling)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Receipt |  |
| 2 | Thread Inspection |  |
| 3 | Dimension Check |  |

### `M1-01` — Manway M1 (SRN forging; blind flange, gasket, bolting set and davit/hinge tracked as BOM hardware only, not a separate fabrication route)

| Seq | Operation | Note |
|---:|---|---|
| 1 | Receipt |  |
| 2 | Machining |  |
| 3 | NDT |  |
| 4 | Inspection |  |

---

## 2. Assembly & weld sequence — 54 checkpoints per unit

Groups A–Q. `kind` is this document's annotation, not a workbook column: **WORK** = a
fabrication activity with a duration and a person; **INSP** = an inspection/verification
checkpoint. The QAP conflates them; the system needs both, distinguished.


### A. Document & Procedure Gate

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 1.1 | Drawing Approval | P | R | INSP |
| 1.2 | Review And Approval Of Quality Contol Plan | P | R | INSP |
| 1.3 | Hot Forming Proceude, Ht Procedure, Rt Procedure, Pt Procedure, Paut & Tofd Procedure | H | R | INSP |
| 2.1 | Welding Procedure & Performance Qualification | P | R | INSP |

### B. Material Inspection & Traceability

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 3.1 | Pressure Part - Plates,Pipes/Forgings/Flange/ Fittings | H | W | INSP |
| 3.2 | Non Pressure Parts & Attachment To Pressure Parts | H | R | INSP |
| 3.3 | Welding Consumable | R | R | INSP |
| 3.4 | Weld Plan/Weld Map | P | R | WORK |

### C. Shell & Head Prep

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.1 | Transfer Of Marking And Cutting (Shell And Dished End) | H | R | WORK |

### D. Head Sub-Assembly

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.2 | Inspection Of Top & Bottom Dished | R | R | INSP |
| 4.2 | Simulation Heat Treatment Of Test Coupon After Forming & Testing | R | R | INSP |
| 4.4 | Weld Edge Preparation Of Top & Bottom Dished End | P | R | WORK |

### E. Shell Sub-Assembly (LS-1)

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.5 | Shell Weld Edge Preparation | P | R | WORK |
| 4.5 | L' Seam Set Up Of Shell (Ls-1 ) Along With Ptc | P | R | WORK |
| 4.5 | Weld Long Seam Of Shell (Ls-1 ) | P | R | WORK |
| 4.5 | Weld Visual Of Ls-1 | P | R | INSP |
| 4.5 | Paut/Tofd Of Ls-1 | P | W | INSP |

### F. Nozzle Sub-Assembly (flange/elbow)

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.6 | Nozzle To Flange/Elbow Set Up (M1/N2/N3) | P | R | WORK |
| 4.6 | Weld Of Nozzle To Flange/Elbow (M1/N2/N3) | P | R | WORK |
| 4.6 | Weld Visual Of Cs Joint Nozzle M1/N2/N3 | P | R | INSP |
| 4.6 | Rt Circ Seam Of Nozzle Pipe To Flange (M1/N2/N3) | P | R | INSP |

### G. Shell + Bottom Head (CS-2)

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.7 | Bottom Dished End To Shell Set Up (Cs-2) | P | R | WORK |
| 4.7 | Weld Circ Seam Of Bottom Dishend To Shell (Cs-2) | P | R | WORK |
| 4.7 | Weld Visual Of Cs -2 | P | R | INSP |
| 4.7 | Paut/Tofd Of Cs-2 | P | W | INSP |

### H. Nozzle & Manway Sub-Assembly

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.8 | Marking For Nozzle On Shell And Dished End (M1, N1 To N6) | P | R | WORK |
| 4.8 | Nozzle To Shell & Dished End Set Up (M1/N1/N2/N3/N4/N5/N6) | P | R | WORK |
| 4.8 | Weld Of Nozzle To Shell & Dished End (M1/N1/N2/N3/N4/N5/N6) | P | R | WORK |
| 4.8 | Weld Visual Of Nozzle To Shell & Dished End (M1/N1/N2/N3/N4/N5/N6) | P | R | INSP |
| 4.8 | Ultrasonic Test Of Nozzle To Shell & Dished End (M1/N1/N2/N3) | P | R | INSP |

### I. Final Closure Gate

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.9 | Clearance Of Shell Before Closing Dished End Set Up | P | R | INSP |

### J. Shell + Top Head (CS-1)

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.10 | Top Dished End To Shell Set Up (Cs- 1) | P | R | WORK |
| 4.10 | Weld Circ Seam Of Top Dishend To Shell (Cs-1) | P | R | WORK |
| 4.10 | Weld Visual Of Cs -1 | P | R | INSP |
| 4.10 | Paut/Tofd Of Cs-1 | P | W | INSP |

### K. Attachments Sub-Assembly

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.11 | Lifting Lug & Name Plate Bracket Set Up | P | R | WORK |
| 4.12 | Weld Of Lifting Lug | P | R | WORK |
| 4.12 | Weld Of Name Plate Bracket | P | R | WORK |

### L. Skirt Sub-Assembly

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.13 | Skirt Support Set Up | P | R | WORK |
| 4.14 | Weld Skirt Support | P | R | WORK |

### M. Pre-PWHT Gate

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 4.15 | Clearance Befor Pwht | P | W | INSP |

### N. Heat Treatment & Post-PWHT NDT

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 5.1 | Inspection Of Vessel Heat Treatment | R | R | INSP |
| 5.2 | Weld Visual Of All Weld Joints | P | W | INSP |
| 5.3 | Mpt Of All Weld Joint | P | W | WORK |
| 5.4 | Rt Testing On All Butt Weld Joints(M1/N2/N3) Paut/Tofd For L'Seam & C'Seam Joints. (After Pwht). | P | W | WORK |

### O. Hydrostatic Test

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 6.1 | Clearance For Hydrostatic Test | P | R | INSP |
| 6.2 | Before Hydrostatic Test Clearance | P | R | WORK |
| 6.3 | Hydrostatic Test | P | W | WORK |
| 6.4 | Mpt / Lpt All Weld Joints After Hydro Test | P | W | WORK |

### P. Surface Treatment & Painting

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 7.1 | Cleaning & Surface Preparation | P | R | WORK |
| 7.2 | Painting | P | W | WORK |

### Q. Final Inspection, Nameplate & MDR

| Sr No | Activity | DESPL | TPI | kind |
|---|---|:-:|:-:|:-:|
| 8.1 | Verification Of Name Plate | P | R | INSP |
| 8.2 | Attachment Of Name Plate To Name Plate Bracket | P | R | WORK |
| 9.1 | Documentation | R | R | WORK |

---

## 3. Weld joints referenced

| Joint | Where | Inspection called for |
|---|---|---|
| `LS-1` | Shell long seam | Weld visual, PAUT/TOFD |
| `CS-1` | Top dished end to shell | Weld visual, PAUT/TOFD |
| `CS-2` | Bottom dished end to shell | Weld visual, PAUT/TOFD |
| Nozzle CS joints | M1 / N2 / N3 pipe-to-flange | Weld visual, RT circ seam |
| Nozzle-to-shell | M1, N1–N6 | Weld visual, UT (M1/N1/N2/N3) |

`WeldJoint` rows are **not** pre-seeded for any job — they are live shop-floor data entered as
welding happens. The joint numbers above are the printed weld-map references to match against.

## 4. Known open questions

Carried from the workbook's Dev Notes and `seed/component-routes.json`; see the addendum §5.

| # | Question | Affects |
|---|---|---|
| F-a | ~~Rolling and Forming — two separately timed steps, or one?~~ **Resolved 26 Aug 2026**: two — per this document's own SHELL-01 note ("Team asked to track Rolling and Forming as two separate timed steps"). `PLATE` route now has both (`ROLLING` then `FORMING`), via a new `RouteTemplateVersion` — see `docs/PHASE-PROMPTS.md` §2 F6. | `PLATE` route, op count |
| F-b | ~~Are Edge Prep, Grinding and generic Inspection real timed steps?~~ **Resolved for `PLATE` 26 Aug 2026**: yes — they were already separate `RouteStep`s despite the stale `GAP` annotation in `component-routes.json`; the annotation has been left as historical context, not a live gap. Whether every *future* component type needs them as their own steps is still open (`TODO_FOR_DESPL`). | Route definitions, op count |
| F-c | Multi-piece components (24 gussets, 6 nozzles) — count required, or is done/not-done enough for v1? | Whether quantity columns are P0 |
| F-d | Is "Operator / Welder" the person who did the work or who reported it? | Field shape, maker-checker boundary |
| F-e | On a fabrication rejection, does work restart at that step or an earlier one? | Reject state machine |
| F-f | Welder list and employee codes — still outstanding. | Blocks assembly phase entirely |

