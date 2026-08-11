# MASTER PROMPT — DESPL Track: Department-wise Manufacturing Tracking Dashboard (Demo Prototype v2)

> Paste everything below this line into Claude. If output gets cut off, say "continue exactly where you stopped."

---

Build a **single-file, self-contained HTML interactive prototype** (all CSS and JS inline, no external dependencies, no localStorage/sessionStorage — in-memory JS state only) of "DESPL Track", an end-to-end production tracking platform for **Dhruv EPC Solutions Pvt. Ltd. (DESPL)**, a Vedanta Group company that fabricates ASME Sec VIII Div 1 pressure vessels in Savli, Gujarat. This is a demo for the company's MD, CEO, and Production Head to review the workflow and suggest changes — it must look like serious industrial MES software, not a startup landing page.

## 1. Domain context (use this exactly — do not invent a different process)

Manufacturing follows a 25-stage work order per vessel: 1 Kick-Off, 2 Engineering Review, 3 Detail Engineering, 4 BOM Preparation, 5 Material Procurement, 6 Incoming Material Inspection, 7 Cutting, 8 Forming/Rolling, 9 Edge Preparation, 10 Shell Fabrication, 11 Head Assembly, 12 Nozzle Fabrication, 13 Nozzle Fit-up, 14 Saddle/Skirt Fabrication, 15 Accessories, 16 Dimensional Inspection, 17 NDT, 18 PWHT (conditional), 19 Hydro Test, 20 Surface Preparation, 21 Painting, 22 Final Inspection, 23 Documentation (MDR), 24 Packing, 25 Dispatch.

Quality follows a QCP/ITP: each stage has inspection checkpoints coded **P (perform), W (witness), R (review), H (hold point)** for Seller (DESPL) and Buyer/TPI. **A hold point blocks stage completion until cleared**, with "inspection call given" and "call attended" dates recorded. Example hold points: plate MTC/heat-number verification, PAUT/TOFD of long seam (LS-1) and circ seams (CS-1/CS-2), hydro test witness, final inspection.

Production is tracked at **component level** under each vessel: shell courses (Shell-1, Shell-2), dished ends (top/bottom head), nozzles (N1–N6, M1 manway), saddle/skirt, accessories — each with its own operation route (e.g., shell course: marking → cutting → edge prep → rolling → L-seam fit-up → L-seam weld → NDT → circ fit-up). Vessel-stage % is a roll-up of component operations.

Integrity rules (must be demonstrable in the demo): sequential stage gating (can't start stage N+1 until N is complete and QC-verified — refuse with error `GATING_BLOCKED`); maker–checker (the supervisor who submits can never verify; verification needs a QC login — refuse with `MAKER_CHECKER_VIOLATION`); hold points block (`HOLD_POINT_OPEN`); overdue stages block further entries by that department on that unit until a categorized delay reason is filed (`REASON_REQUIRED`); all actual timestamps are "server-set" (say so in the UI); every action mentions an audit log entry.

## 2. Sample data (realistic, consistent everywhere)

- Job **DESPL-320** · HP Air Receiver ×9 units (serials 320SR01…320SR09) · client AHPL · delivery 15 Nov 2026 · units spread across stages: SR01 in Nozzle Fab (52%), SR02 Head Assembly (48%), SR03 Shell Fab with open TPI hold (44%), SR04 Shell Fab (41%), SR05 Edge Prep (38%), SR06 Forming **overdue 3 days, reason pending** (30%), SR07 Cutting at-risk (22%), SR08 Cutting (18%), SR09 Incoming Inspection (12%).
- Job DESPL-318 · Storage Vessel ×6 · Nuberg · 74% · on track. Job DESPL-322 · LPG Bullet ×2 · 18%. Job DESPL-315 · Air Receiver ×14 · ELGI · 91% · 1 unit delayed in Painting.
- Today is Monday 03 Aug 2026. Currency ₹, dates DD MMM YY, timezone IST.
- BOM sample for SR03 (from the real drawing): skirt shell SA 516 GR 485 16T (977 kg), skirt base ring IS 2062 32T, gusset plates ×24, N1/N2 flanges SA 105 CL.600, nozzle pipes SA 333 GR 6 SCH XXS, SRN SA 266 GR 2, blind flange DN 450 CL 600 (286 kg), studs SA 193 B7 ×20, lifting lugs, earthing plates SS 304, name plate. Total ~2890 kg.
- Welders: R. Kumar 6.2, S. Patel 5.4, V. Singh 4.8, M. Yadav 3.9, A. Sharma 2.9 inch-dia/day (team avg 4.6); repair rates 2.1%, 2.4%, 3.6%, 5.1%, 11.4% (Sharma flagged for WPS review).

## 3. App structure — LEFT SIDEBAR navigation, two axes

**Axis 1 — role switcher** (top of sidebar, persistent): MD/CEO · Production Head (SJ) · Department Supervisor (choose department) · QC Inspector. Role controls which home screen loads and which buttons are permitted (wrong-role actions show the refusal toasts with error codes — never hide the buttons, refusing is the demo).

**Axis 2 — sidebar sections:**
1. **Overview** (management home)
2. **Daily Brief**
3. **Departments** — expandable list, one workspace per department (the core of this build, see §4): Engineering · Procurement · Stores & Incoming QC · Cutting & Forming · Fabrication · Welding · QC / NDT · Painting · Dispatch & Docs
4. **Jobs** → job list → DESPL-320 detail (unit × 25-stage matrix heatmap, hoverable) → unit 320SR03 detail (stage board + component tree: Shell-1, Shell-2, Top Head, Bottom Head, N1–N6, M1, Skirt — each expandable to its operation checklist)
5. **KPI Analytics** (management deep-dive)
6. **Audit Log** (read-only table of recent actions: who/what/when/entity, including refused attempts marked "REFUSED")

Include a floating **Feedback** button: reviewers add notes tagged to the current screen; a drawer lists all notes with a "copy all" action.

## 4. Department workspaces — each has (a) KPI tile row, (b) work queue, (c) one or two charts, (d) detail table. Use these exact KPIs:

**Engineering:** drawings released vs planned (this month), pending client approvals, avg BOM release lead time (days), drawing revision count this quarter, engineering-hold delays caused (days). Queue: drawings/BOMs due per unit. Chart: released-vs-plan weekly trend.

**Procurement:** open MRs / PRs / POs (funnel counts), overdue deliveries, avg lead time by material category (plate / pipe / flange / forging / fasteners), **stages currently blocked by material** (list unit + stage + missing item). Chart: lead time by category bars.

**Stores & Incoming QC:** lots pending inspection, MTC/heat-number verifications pending, acceptance rate %, PMI required vs done, material issued-to-floor today. Detail table: BOM item → PO → heat no. → MTC ref → status (traceability chain).

**Cutting & Forming:** stages due today/overdue across units, cycle time vs standard per stage (actual/std ratio), plates cut (MT this week), forming queue (dished ends received/formed), fit-up checks pending. Chart: cycle-time variance by stage.

**Fabrication:** WIP units in shell fab / head assembly / nozzle / saddle work, component-operation completion counts today, overdue component operations, rework items open. Component-level progress bars per active unit (Shell-1 80%, N3 40% …).

**Welding:** joints completed vs planned (week), inch-dia per welder vs team avg (bar chart with average line), per-welder repair rate table with flags, joints awaiting NDT, work distribution suggestion ("Sharma under-loaded on butt welds — review"). This data is entered by the supervisor: per-joint for butt welds, day-totals otherwise.

**QC / NDT:** pending stage verifications (maker–checker queue), first-pass yield %, NDT backlog by method (RT/UT/PT/MT), hold points upcoming with TPI call dates, punch points open, rejections this month by welder/stage. This workspace contains the interactive verify flow (see §5).

**Painting:** surface prep queue, DFT first-pass rate, units in primer/intermediate/final coat, holiday tests pending.

**Dispatch & Docs:** units in packing, MDR readiness % per dispatch-ready unit (checklist of WPS/PQR, RT reports, hydro report, dimensional report, paint report, MTCs…), dispatch clearances pending, OTD % trend, next dispatches with dates.

**Overview (MD/CEO):** active jobs, units in WIP, on-track/at-risk/overdue counts, reason-pending count, OTD %, first-pass yield; department schedule-adherence **league table** (rank departments by % stages finished on time — this is the KPI that "affects their KPI" when deadlines are missed); delay Pareto by reason; WIP-by-department bottleneck bars; per-job progress with planned-vs-actual S-curve for DESPL-320.

**KPI Analytics:** stage cycle time vs standard (all stages), schedule variance per unit (baseline vs current plan), delay days by department and reason (stacked), welder league, NDT repair trend, procurement lead-time trend. Filters: job, department, date range (visual only is fine).

## 5. Interactive demo flow (must actually work, state updates everywhere)

On 320SR03 Shell Fabrication: supervisor opens component operations (CS-2 circ weld, back chip & LPT, dimension check unchecked) → ticks them → Submit enabled → submits (toast: server timestamp + audit entry) → as supervisor, clicking Verify refuses with MAKER_CHECKER_VIOLATION → switch role to QC → QC queue shows the submission with an **open TPI hold point: "H — PAUT/TOFD of CS-2, TPI witness per QCP 4.7"** → verify refuses with HOLD_POINT_OPEN → record TPI clearance (call given / call attended dates, cleared by "AHPL — Mr. D. Joshi", noted as "recorded on TPI's behalf — v1") → Verify → stage completes, Head Assembly unlocks, unit 44%→48%, Overview tiles and matrix update, audit log gains rows. Separately: SR06 overdue card blocks Production until a delay-reason modal (category + details) is filed → reason-pending KPI drops, brief updates, league table shifts. Clicking Start on any locked stage → GATING_BLOCKED toast explaining predecessors.

## 6. Design language

Professional industrial SaaS (think Linear/Datadog density, not consumer app): light theme default + dark toggle; system-ui font stack; 13–14px base; sidebar 230px dark-neutral; content on subtle gray page with white cards, 1px hairline borders, 10–12px radius; KPI tiles with small trend deltas (↑↓ with green/red only for good/bad, plus icon — never color alone); status colors reserved: green #0ca30c good, amber #fab219 warning, orange-red #ec835a serious, red #d03b3b critical; primary/series blue #2a78d6. Charts: pure CSS/SVG (no libraries), thin bars with direct value labels, average reference lines, no dual axes, no rainbow palettes. Tables: tabular numerals, right-aligned numbers, sticky headers. Every screen gets a small "Demo:" hint strip telling the reviewer what to try. Toasts bottom-center: red for refusals (with the error code bold), green success, blue info. Empty/locked states explain *why*. Header shows "DEMO PROTOTYPE · sample data".

## 7. Constraints

Single .html file; works offline from a double-click; no external fonts/CDNs/images (inline SVG icons or unicode); no localStorage; responsive enough for a projector at 1280–1920px wide (mobile not required for this demo); all interactive state in plain JS objects; keep every number consistent across screens (if SR03 hits 48%, the matrix, job list, overview and brief all agree).

Build the complete file now. Prioritize: department workspaces depth > interactive integrity flow > overview/analytics > visual polish.
