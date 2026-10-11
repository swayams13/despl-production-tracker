# Claude Design prompt pack — DESPL Production Tracker redesign (v2)

**How to use:** open a new design in Claude Design and paste **Prompt 1**. When it is done, paste **Prompt 2**, **Prompt 2B**, **Prompt 3** and **Prompt 4** into the same design chat, one at a time. Each later prompt assumes the brief from Prompt 1. Review after each prompt and correct course before moving on; the floor screens in Prompt 1 matter most.

All company, client and people names below are sample data for the design, except DESPL itself. Dates are illustrative: the scenario date is **Thursday 11 Feb 2027**.

---

## PROMPT 1 — Brief + the floor experience

### 1. What you are designing

Redesign the UI of an internal **production tracker** for DESPL, a pressure-vessel fabrication company in Gujarat, India. The tracker follows each customer order from PO to dispatch across 13 departments. About 50 people use it:

| Who | Device | Where | What they need |
| --- | --- | --- | --- |
| Operators (welders, fitters) | Cheap Android phone, 360 px wide | Bright, noisy fabrication bay, often gloved | Mark the step they just finished, in seconds |
| Supervisors (one per department) | Phone + shared rugged tablet | Floor and office | Know what the team does today; record work for several units at once |
| QC inspectors | Tablet 1024 px | Floor | See what is ready to inspect; accept or reject |
| Planners, Stores, Procurement | Office desktop 1440 px | Office | Create jobs, BOMs, material status |
| Production Head | Laptop + phone | Everywhere | What is stuck, who is overloaded, what is out of sequence |
| MD and CEO | Mostly phone | Anywhere | Which jobs are late or at risk, and why — without reading tables |

**It must work for every job DESPL builds**: pressure vessels and heat exchangers first. Each order brings different equipment, quantities and client requirements, but the overall process stays the same. DESPL-320 below is only the main sample job, not the product.

The product is being simplified because **nobody updates it daily today**: recording one real event takes many clicks across several screens. Every screen you design must pass one test: **a supervisor records a real event in three taps or fewer, without scrolling, on a 360 px Android phone in a bright bay.**

### 2. The domain (use these words exactly)

- **Job**: a customer order. Example: **DESPL-320 — HP Air Receiver × 9**, design code ASME VIII Div 1, committed dispatch **08 Apr 2027**.
- **Equipment line**: one kind of equipment within a job, with a tag, an **equipment type** (e.g. "Vertical vessel on skirt", "Horizontal vessel on saddles", "Heat exchanger, U-tube (BEU)"), a quantity and a tracking mode: **Serial** (each unit tracked) or **Lot** (counted, e.g. "Cut 120 of 160"). One job can hold several lines, e.g. 4 horizontal vessels plus 1 heat exchanger.
- **Unit**: one vessel in a job, serial **320SR01 … 320SR09** (short form SR01 … SR09 inside a job).
- **Heat-exchanger parts** (for exchanger jobs): shell, channel or bonnet, tubesheets, tubes, baffles, tie rods, floating head, expansion joint; exchanger-only steps include tubesheet drilling, tube bundle assembly, tube expansion or tube-to-tubesheet welding, leak test, bundle insertion, and separate shell-side and tube-side hydro tests.
- **Milestones**: about 10 checkpoints shared by every job of every family (Engineering approved · Material ready · Cutting and forming · Fabrication · NDT · PWHT · Pressure test · Painting · Documentation · Dispatched), used wherever jobs of different types are compared.
- **Component** (per unit): Shell · Top head · Bottom head · Skirt · Nozzles N1–N6 · Manway M1.
- **Step**: one piece of work. Two kinds: **Work** steps (the floor marks them done) and **Inspection** steps (QC accepts or rejects). Example — the 7 work steps of Shell fabrication: Shell weld edge preparation · Long seam LS-1 set-up · Weld long seam LS-1 · Bottom head to shell set-up (CS-2) · Weld circ seam CS-2 · Top head to shell set-up (CS-1) · Weld circ seam CS-1.
- **Stage**: the 25-step view management reads. Stages complete **automatically** when their steps are done; nobody "completes a stage" by hand.
  1 Project kick-off · 2 Engineering review · 3 Detail engineering · 4 BOM preparation · 5 Material procurement · 6 Incoming material inspection · 7 Cutting · 8 Forming · 9 Edge preparation · 10 Shell fabrication · 11 Head assembly · 12 Nozzle fabrication · 13 Nozzle fit-up · 14 Saddle fabrication · 15 Accessories · 16 Dimensional inspection · 17 NDT · 18 PWHT · 19 Hydro test · 20 Surface preparation · 21 Painting · 22 Final inspection · 23 Documentation (MDR) · 24 Packing · 25 Dispatch.
- **QCP point**: a quality checkpoint coded **P** (perform), **W** (witness) or **H** (hold), for two parties: **DESPL QC** and **Buyer TPI** (the customer's third-party inspector). An open **H** point stops its stage until cleared.
- **NCR**: a nonconformance report, raised when QC rejects work.
- **Departments**: Projects/PMO · Design & Detail Engineering · Planning/PPC · Procurement · Stores · Quality Control · Fabrication Prep · Machine Shop · Fabrication/Welding · Heat Treatment · Surface Treatment & Painting · Documentation/MDR · Dispatch & Logistics.

### 3. Rules the UI must express (the server enforces them; the UI makes them obvious)

1. **Hard stops** — shown as a clear refusal card, never a silent disabled button: an open H hold point; surface preparation or painting before the hydro test is done; dispatch with an open NCR or an open hold point.
2. **Soft stops** — starting something out of the usual order is allowed after a one-tap reason. The item then carries an **Out of sequence** flag that the Production Head sees.
3. **Late work** — marking an overdue step done asks *why* in the same sheet (category chip + optional note). It never blocks other work.
4. **Time** — "Done at" defaults to **Now** and can be set back up to 72 hours (Earlier today / Yesterday + time). Detail views show both the reported time and when it was recorded, only if they differ.
5. **Batch** — most work happens on several units at once ("Long seam welded on SR01–SR05"). Batch is a first-class, one-gesture action, and its result reports per unit ("4 done · 1 blocked: SR04 has an open hold point").
6. **QC scope** — QC acts only on Inspection steps and W/H points, and never on work they recorded themselves.

### 4. What is wrong with the current UI (avoid all of it)

- Text as small as 9–10.5 px in 129 places. On touch devices nothing goes below 12 px.
- Borders at 1.15:1 contrast; status chips under 4.5:1 on their own tints.
- Stage-bar segments are 13×14 px tap targets on a tablet.
- "My Day" shows the whole department's queue (300+ rows on a 40-unit job) under the user's own three tasks, and leads with a 30-day on-time % before saying what to do.
- Tables up to 12 columns; walls of identical cards; three screens answer "what is my department doing"; the QC queue appears on four screens with four different counts.
- The dashboard mixes a portfolio band with one project's deep-dive and a sunburst chart nobody can act on.
- Navigation changes with screen width instead of role, so some screens are unreachable on some devices.
- Designed dark-first; the shop floor needs a bright, high-contrast theme.

**Keep these ideas** (people have seen and liked them):
- The **Stage Spine**: a horizontal bar of the 25 stages coloured by status. Mini (4 px tall) on every job and unit row; full size (14 px) and interactive on job and unit pages. Each segment gets a **44 px tap area** even though the bar stays slim; the current stage carries a small marker above it.
- The phone **"Do this first"** card at the top of the personal list, with one primary action.
- The **Stage Sheet**: a 460 px right-hand drawer (a bottom sheet on phones) that opens from any stage, cell or row and shows everything about it plus the one correct action.
- A ⌘K command palette on desktop.
- Numbers in **JetBrains Mono** with tabular figures; UI text in **Inter**.
- Status is never colour alone: **dot + label + small glyph**.

### 5. Visual system (no design system is attached — define it on a "00 Tokens" artboard)

Direction: industrial and precise, like Linear or a control-room instrument panel, not a marketing site. Density where it helps, big touch targets where people wear gloves. **No** gradients, glassmorphism, glow, shadows heavier than a 1 px hairline, emoji, illustrations or stock imagery. One accent colour, used sparingly (more than three accent elements on a screen is too many).

**Two themes, one layout.**

*Control room (dark)* — default on desktops and for management. Corrected tokens:

| Token | Value |
| --- | --- |
| bg | #0B0C0E |
| surface | #141619 |
| surface-2 | #1C1F24 |
| border | #3A4048 |
| text | #E7E9EC |
| muted | #8B919A |
| accent | #FF7A1A (high-vis orange) |
| status · Done | #3FB950 |
| status · In progress | #4C8DFF |
| status · Waiting for QC | #A371F7 |
| status · On hold | #D9A62E |
| status · Overdue | #F0524D |
| status · Not started | #5C6068 |

*Floor (light, high contrast)* — default on phones and tablets, readable in direct sunlight. Starting point (verify every pair against WCAG AA and adjust):

| Token | Value |
| --- | --- |
| bg | #F6F7F9 |
| surface | #FFFFFF |
| surface-2 | #EEF0F3 |
| border | #8A9099 |
| text | #0E1116 |
| muted | #4A5260 |
| accent | #C25400 (darker orange so white text on it passes) |
| status · Done | #1A7F37 |
| status · In progress | #0B5CD5 |
| status · Waiting for QC | #7A3FD1 |
| status · On hold | #9A6700 |
| status · Overdue | #CF222E |
| status · Not started | #6E7781 |

Two extra states with their own marks in both themes: **Rejected / NCR** (overdue red, but a square or crossed glyph so it never reads as "late"), and **Out of sequence** (accent-coloured notch or outline, meaning "flagged", not "failed").

Status chip: pill, sentence-case label, solid dot, glyph; tint at 6% (not 12%) so the label stays above 4.5:1.

**Type:** Inter for UI, JetBrains Mono for every number and date. Page title 20/600 · section label 12/600 uppercase, tracked · body 14 on touch, 13 on desktop · secondary 13/12 · minimum 12 px on touch, 11 px on desktop · KPI values 28/600 mono. Nothing larger than 28 px except the unit serial on the Floor screen (24/600 mono).

**Layout:** 8 px grid; radius 8 cards, 6 inputs/buttons, pills full. Phone: top bar 56 px, bottom navigation by role with a raised central **Scan** button for floor roles, primary buttons 48 px tall (56 px for the main Done). Desktop: 236 px sidebar (collapsible to a 72 px icon rail), 48 px top bar with breadcrumb, a job switcher that shows a mini Stage Spine, a ⌘K field, and a notification bell. Tables: at most 6 columns, sticky first column, rows 36 px desktop / 48 px touch; anything else goes in an expandable row or the Stage Sheet.

**Copy:** sentence case, plain verbs, buttons say the outcome ("Mark done", "Start", "Accept", "Reject with reason", "Notify QC"). No internal codes, enum names or database words. Refusals say what is missing, who can clear it, and offer a button to notify them.

**Interaction rules:** one primary action per row or card · undo toast (10 s) instead of "Are you sure?" dialogs · personal lists show about 7 items, then "Show all (23)" · filters are chips that survive refresh · floor language ("Shell SR03 · Rolling done", never "Process 13 × Unit 3") · keyboard-reachable with a visible 2 px accent focus ring on desktop.

### 6. Sample data for every screen

**Jobs (portfolio of 5):**

| Job | Product | Client (fictional) | Progress vs plan | Committed | Forecast | Health | Top blocker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DESPL-320 | HP Air Receiver × 9 | Northline Industrial Gases | 41% vs 48% | 08 Apr 2027 | 15 Apr 2027 (+7 d) | At risk | SR04 RT of LS-1 waiting for Buyer TPI (H) |
| DESPL-324 | SS Storage Tank × 40 | Kavya Pharma | 72% vs 70% | 26 Feb 2027 | 24 Feb 2027 | On track | Baffle plates short at Stores |
| DESPL-327 | Knock-out Drum × 2 | Sahyadri Refinery Services | 63% vs 81% | 19 Feb 2027 | 03 Mar 2027 (+12 d) | Delayed | Hydro test failed on KOD-01, NCR-0012 open |
| DESPL-329 | Heat Exchanger × 1 | Coastal Chem | 9% vs 15% | 30 May 2027 | 30 May 2027 | On hold | Client drawing approval pending |
| DESPL-333 | Air Receiver × 4 | Arvind Air Systems | 12% vs 11% | 28 May 2027 | 26 May 2027 | On track | — |

Summary line: "2 of 5 jobs forecast past committed date · total slip 19 days".

**DESPL-320 on 11 Feb 2027:**
- Stages 1–9 done for every unit.
- Stage 10 Shell fabrication: SR01–SR03 done · SR04 **on hold** (3 of 7 steps done; RT of long seam LS-1 waiting for Buyer TPI, H point, since Wed 10 Feb 17:30; the remaining 4 steps wait for it) · SR05 in progress (4 of 7 steps done, the 5th under way) · SR06 **overdue 2 days** (edge preparation was due Tue 9 Feb) · SR07–SR09 not started.
- Stage 11 Head assembly: SR01 done · SR02 in progress · SR03 waiting for QC.
- Stage 12 Nozzle fabrication: SR01 in progress · SR05 **out of sequence** (N1 fit-up started before shell fabrication finished; reason "Welder free").
- Stages 13–25 not started.

**People (fictional):** Vikram Solanki — Supervisor, Fabrication/Welding · Imran Shaikh — Welder W-07 · Ramesh Patel — Fitter · Suresh Rathod — Operator, Fabrication Prep · Neha Desai — QC Inspector · Arjun Mehta — Planner (PPC) · Kiran Joshi — Stores. Show the Production Head, MD and CEO by role only.

**Late reasons:** Material not available · Manpower shortage · Machine breakdown · Waiting for drawing or approval · Waiting for QC / TPI · Rework · Power cut · Other.
**Out-of-sequence reasons:** Material ready early · Welder or machine free · Client priority · Other.

### 7. Build these artboards now (name each exactly)

**01A · Floor · Scanned unit · Direction "Checklist"** — phone 360×800, Floor theme. Opened by scanning the QR on unit **320SR05**'s printed traveller; the user is Vikram Solanki.
- Top bar: back, "Scan" icon, overflow.
- Unit header: **320SR05** (24/600 mono) · "DESPL-320 · HP Air Receiver · unit 5 of 9" · full Stage Spine with the marker on stage 10 · "Shell fabrication · due Fri 12 Feb".
- Section "Next for Fabrication/Welding" (a department chip lets multi-department users switch).
- Group **Shell**: "Weld circ seam CS-2" — In progress, "Started 10:40 · Imran Shaikh (W-07)" — primary **Mark done** · "Top head to shell set-up (CS-1)" — Not started — secondary Start, primary Mark done · "Weld circ seam CS-1" — Not started — hint "After CS-1 set-up".
- Group **Nozzle N1**: "Fit-up" — In progress with the **Out of sequence** flag ("Welder free") — Mark done.
- Group **Inspection**: "RT of long seam LS-1" — Accepted (Neha Desai, Tue 9 Feb), shown collapsed as done · "RT of circ seam CS-2" — Not started, hint "After the weld is done", no action.
- Sticky footer: "Also mark for other units" (opens the batch picker) and **Scan next unit**.
- Rows 64 px, Done buttons 48 px, everything reachable by thumb.

**01B · Floor · Scanned unit · Direction "One next step"** — same data, different idea: one hero card with the single most important next step and a full-width 56 px **Mark done**; under it a row of unit chips SR01–SR09 showing which units also need this step (tap to include them); below, "Later on this unit" collapsed. Show both directions side by side so they can be compared.

**01C · Floor · Batch picker** — the 01A layout after scanning **320SR06** (the overdue unit), with a bottom sheet open: "Mark 'Shell weld edge preparation' done for". Nine rows with a checkbox and that unit's state for this step: SR01–SR05 Done (disabled, ticked, with the date) · SR06 "This unit · overdue 2 days" (checked) · SR07 Not started (checked) · SR08 Not started (checked) · SR09 Not started (unchecked). "Done at: Now ▾" control. Primary **Mark done for 3 units**. Because SR06 is late, pressing it leads to the late-reason sheet in 01D.

**01D · Floor · Done-at picker + late reason** — two sheets side by side. (a) Done at: Now · Earlier today (time wheel) · Yesterday (time wheel), with the note "You can record up to 3 days back". (b) Late: "This was due Tue 9 Feb — 2 days ago. What held it up?" reason chips (§6), optional note, primary **Mark done**.

**01E · Floor · Stops** — two cards. (a) Hard stop, after trying to Start "Surface preparation" on 320SR01: "Can't start yet. The hydro test on 320SR01 isn't done. Surface preparation and painting can start once QC records the hydro test." Buttons: **Notify QC**, OK. (b) Soft stop, after trying to Start "Nozzle N2 fit-up" on SR05: "Nozzle fit-up usually starts after shell fabrication is done. Start anyway?" reason chips, note, primary **Start and flag for Production Head**.

**01F · Floor · Results and connectivity** — three states on one artboard: undo toast "Edge preparation marked done on SR06–SR08 · Undo"; a partial batch result from a different batch, "2 done · 1 blocked — SR04 has an open hold point (RT of LS-1, Buyer TPI)" with "See details"; offline banner "Offline — 2 updates waiting to send. They'll go when Wi-Fi is back."

**01G · Floor · Language check** — 01A with Hindi labels and again with Gujarati labels (draft text is fine; mark it "for review"), to prove the layout holds longer strings.

**02A · Today · Supervisor · phone** — 360×800, Floor theme, Vikram Solanki.
- Header "Today" · "Thu 11 Feb" · one summary line: "8 assigned · 1 needs attention · 4 due today · 1 blocked".
- **Do this first** card with a red ribbon "Overdue 2 days · reason needed": "320SR06 · Shell fabrication · Edge preparation · due Tue 9 Feb" · primary **Mark done** (opens the late-reason sheet).
- **Today (4)**: SR05 Weld circ seam CS-2 · SR05 Top head set-up CS-1 · SR02 Head assembly fit-up · SR01 Nozzle N2 fit-up.
- **Blocked (1)**: "320SR04 · Shell fabrication — Waiting on: RT of LS-1 (Buyer TPI hold point)" · Notify QC.
- **Upcoming (2)** collapsed (so the sections add up to the 8 assigned) · **My progress** collapsed at the bottom ("On time, last 30 days 84% · Done this week 19").
- Bottom nav: Today · Team · [Scan] · Board. Bell in the top bar with a count.

**02B · Today · End-of-shift check-in** — bottom sheet shown after 4 pm: "Before you leave — today's plan". Five items, each with Done / Not done; Not done expands reason chips. Primary **Send 5 updates**.

**02C · Today · Supervisor · desktop** — 1440×900, Control room theme. Same sections in a 880 px main column; a 360 px right rail with "Waiting on you" (approvals) and a 6-day load strip ("My week"). Sidebar shows the role-based nav.

**03A · Job board · desktop** — 1440×900, Control room theme, DESPL-320.
- Breadcrumb Jobs / DESPL-320; job header: "DESPL-320 · HP Air Receiver × 9 · Northline Industrial Gases" · health chip **At risk** · inline numbers: Progress 41% vs plan 48% · Committed 08 Apr 2027 · Forecast 15 Apr (+7 d) · Open holds 1 · Overdue 4 · Out of sequence 1.
- Tabs: Overview · **Board** · Schedule · Materials · QC · Dispatch · History.
- Filter chips: Department ▾ · Status ▾ · Out of sequence (1) · "Hide finished stages" toggle (on) · right-aligned **Export to Excel**.
- Matrix: 9 unit rows. First column (sticky): serial, mini Stage Spine, current stage, health dot. Stages 1–9 collapsed into one column "1–9 Done" (expandable); stages 10–25 as columns headed by number + short name. Cells at least 44×36 with a glyph and a value: done → date ("4 Feb"); in progress → steps done ("4/7"); hold → "H"; overdue → "−2d"; waiting for QC → "QC"; not started → muted planned date. A totals row: "3/9 done" per stage. Legend under the matrix.

**03B · Job board · Stage Sheet open** — 03A with the Stage Sheet for **320SR04 · Shell fabrication**: status chip "On hold — H point open"; Planned 05 Feb → 12 Feb · Started Fri 05 Feb 09:10 · day 6 of 7 planned. Step checklist: 3 done rows with who and done-at (Weld long seam LS-1 shows "done Wed 10 Feb 16:40 · recorded 17:05"), then 4 rows marked "Waits for the RT hold point"; linked QCP points table (Sr · Activity · DESPL · Buyer TPI · Result): 4.1 Visual of LS-1 · P · R · Accepted, Neha Desai 10 Feb; 4.2 RT of LS-1 · W · **H** · Waiting since 10 Feb 17:30. History (last 3 events). Action area shown for two roles: Supervisor sees **Notify QC / TPI**; QC sees **Record RT result**.

**03C · Job board · tablet** — 1024×768 landscape, Floor theme. Same board with 48 px cells, department bands above the stage headers, a sticky unit column and a clear horizontal-scroll affordance.

Lay the artboards out in rows by number. Under each artboard add a 2–3 line note for any interaction a still frame can't show.

---

## PROMPT 2 — The people who manage the work

Using the same brief, tokens and sample data, add these artboards:

**04A · Team · Fabrication/Welding · desktop** — 1440×900, Control room. For the supervisor and the Production Head.
- Header: department name + switcher (Production Head can switch departments) · KPIs: Open 34 · On time 82% · Overdue 4 · Blocked 2 · **Same-day updates 76%**.
- **Workload by person** (the centrepiece, a 6-column table): Person · Assigned · Overdue · Due today · Blocked · Oldest item — plus a row action "Reassign". Rows: Imran Shaikh 6/1/2/0/"3 d"; Ramesh Patel 5/0/2/1/"1 d"; Suresh Rathod 2/0/1/0/"today"; two more fictional names, one with 0 assigned (idle) highlighted quietly.
- **Unassigned (12)**: paginated, filter by process / due window / job, multi-select → "Assign to…" menu where each person shows their open count ("Imran Shaikh · 6 open").
- **Overdue and blocked**: each row with its reason status ("Reason given: Machine breakdown" or "No reason yet").
- **You're blocking** (other departments waiting on Fabrication) and **Waiting on others**, side by side.
- **Out of sequence today (1)**: SR05 Nozzle N1 fit-up · "Welder free" · Vikram Solanki · Acknowledge.

**04B · Team · phone** — 360×800 Floor theme version for the supervisor: KPIs as one line, workload as compact rows, Assign via bottom sheet.

**05A · QC queue · tablet** — 1024×768, Floor theme, Neha Desai.
- Tabs with counts: Ready to inspect (7) · Open holds (2) · NCRs (1).
- Ready to inspect, grouped job → unit, oldest first: DESPL-320 › SR03 · Head assembly fit-up check · **W** DESPL · waiting 5 h; DESPL-327 › KOD-02 · Hydro test · **W** DESPL / **H** Buyer TPI · waiting 1 h; DESPL-324 › T-17 · Visual of nozzle welds · **P** · waiting 20 min.
- Each item: Accept · Reject with reason (rejection raises an NCR; show the reject sheet with defect category, note, and a disabled "Add photo — coming in phase 2" slot).
- An item the inspector recorded themselves shows "You recorded this work — another inspector must check it", with no Accept button.

**05B · QC queue · Open holds and NCRs · desktop** — 1440×900, Control room: Open holds (SR04 RT of LS-1 · Buyer TPI · 1 day; DESPL-327 KOD-01 hydro re-test · DESPL · 4 days) and NCR-0012 (DESPL-327 · KOD-01 · Leak at N3 weld during hydro · Rework in progress · owner Fabrication · opened 7 Feb).

**06A · Portfolio · desktop** — 1440×900, Control room, for MD, CEO and Production Head. Everything portfolio-wide; full comprehension above the fold.
- Five KPI tiles, each clickable: Active 5 · Delayed 1 · At risk 1 · On hold 1 · Actions due 9.
- **Project health** table (6 columns, worst first): Job · Client · Progress vs plan (a thin bar with a plan tick) · Committed vs forecast · Health · Top blocker — data from §6.
- Filter chips above the table: All · Pressure vessels · Heat exchangers. Under each job name, a 10-dot **milestone strip** (the same for every family) instead of the 25-stage spine, so a single exchanger and a 40-tank order read alike.
- **Where work is stuck**: horizontal bars per department, segments for blocked / overdue / rejected, worst first, each segment a link.
- **Needs attention** (top 15): job · what · department · owner · age · action — e.g. "DESPL-327 · KOD-01 hydro re-test · QC · Neha Desai · 4 d · Open"; "DESPL-320 · SR04 RT LS-1 waiting for TPI · QC · Buyer TPI · 1 d · Notify"; "DESPL-324 · Baffle plates short · Stores · Kiran Joshi · 2 d · Open".
- One line: "2 of 5 jobs forecast past committed date · total slip 19 days".
- **No** sunburst, S-curve, department × status matrix or single-job detail on this page.

**06B · Portfolio · phone (MD)** — 360×800, Floor theme: the five KPIs as two compact rows, the job list as cards (job, product, health chip, progress vs plan bar, forecast vs committed, top blocker), and "Needs attention (top 5)".

**07A · Job overview · desktop** — DESPL-320, Overview tab: header as in 03A; full Stage Spine; four numbers (Progress vs plan · Forecast vs committed · Open holds · Out of sequence); "Top exceptions" list (5); "Department deadlines" compact list (department · own work done by · status).

**07B · Materials tab · desktop** — DESPL-320 BOM lines (6-column table + expandable rows): Part · Material · Qty · Pipeline · Needed by · Status. The pipeline is a row of five small steps — Indent → PO → Received → Identified (heat no.) → Issued — with the current step highlighted. Sample rows: Shell plate · SA 516 Gr 485, 16 mm · 9 nos · Issued · Issued; Dished end · SA 516 Gr 485 · 18 nos · Identified (heat H-23871) · 13 Feb; Nozzle pipe · SA 106 Gr B · 54 m · PO placed, expected 15 Feb · needed 13 Feb · **Short for work starting this week** (overdue red); Flanges · SA 105 · 54 nos · Indent raised · 16 Feb; Gusset plates · IS 2062 E250 · 216 nos · Issued. Filter chip "Short this week (1)".

---

## PROMPT 2B — Setting up any job (not just DESPL-320)

The tracker must handle every order: different equipment types, quantities and client requirements on the same overall process. A job gets its process plan and dates on the day the PO arrives; its detailed floor steps are generated weeks later, when Engineering releases the BOM and weld map. Design that set-up experience for the Planner (Arjun Mehta) and Engineering. Desktop 1440×900, Control room theme, unless stated.

Sample job being created: **DESPL-335** for Konkan Fertilisers (fictional), committed dispatch 30 Jul 2027, ASME VIII Div 1, Buyer TPI. Two equipment lines: **V-201 A–D** — Horizontal vessel on saddles × 4 (Serial); **E-101** — Heat exchanger, U-tube (BEU) × 1 (Serial).

**13A · New job · Start** — two clear choices: "Start from an equipment template" or "Copy a previous job" (a searchable list of past jobs with product, quantity and date; picking one copies its answers, BOM, weld map and QCP as an editable draft). A progress rail for the flow: Order → Equipment lines → Configure → QCP → Schedule → Release. Drafts can be saved and resumed.

**13B · New job · Equipment lines** — the two lines above as rows (tag, equipment type, quantity, tracking mode Serial / Lot / Lot then serial, serial pattern "V-201A–D" with a live preview of generated serials). "Add line" button. A note that one job may mix vessels and exchangers.

**13C · Configure · V-201 (horizontal vessel)** — left: about ten questions answered with large controls (support type: saddles · shell courses: 3 · nozzles: 8 · PWHT: No · radiography: Spot · pressure test: Hydro · painting system: 3-coat epoxy · insulation: No · stamping: U-stamp · inspection party: Buyer TPI). Right: a live **"What this job will include"** preview that updates with each answer: "35 of 36 processes included · 1 excluded" with the reason ("PWHT — excluded because PWHT = No"); "Weld steps will come from the weld map: about 3 long seams, 4 circ seams, 8 nozzle welds"; "QCP: Standard ITP — Horizontal vessel, v2 (58 points)". Every inclusion is explained in one line.

**13D · Configure · E-101 (heat exchanger)** — the exchanger's questions (TEMA type BEU · shell- and tube-side design pressure and temperature · tube count 312 · tube OD 19.05 mm · length 6 m · 2 passes · tube material SA 179 · tube-to-tubesheet joint: expanded and seal-welded · removable bundle: Yes). Preview lists exchanger-only processes (tubesheet drilling, bundle assembly, tube expansion, leak test, bundle insertion, shell-side and tube-side hydro). An amber banner: "Provisional route — dates will show 'not scheduled' until DESPL confirms exchanger durations."

**13E · QCP for this client** — the standard plan cloned per line; a table (Sr · Activity · DESPL code · Buyer TPI code · Linked process) where the planner changes P/W/H/R codes per row, adds a client-specific item, or removes one with a reason. Rows that differ from the standard are marked, with a "Compare with standard" toggle.

**13F · Schedule preview and release** — a compact timeline per line, backward from the committed date, with quantity shown honestly ("4 units — fabrication processes ×1.6 by the quantity band"); a feasibility check ("Fits with 9 days of float" or "Short by 12 days — here is what drives it"); and the primary **Release to production**, with a note: "Floor steps are created when Engineering releases the BOM."

**14A · BOM release** — Engineering uploads the BOM Excel for V-201: a column-mapping preview (their headings → fields, a component type picked per line), a data-issues list (e.g. "Line 14: quantity 'As required' — enter a number or mark as consumable"), then **Release revision 1** with a summary of what will be generated ("4 units × 15 components · about 250 operations · 120 weld and assembly steps · linked to 58 QCP points").

**14B · BOM revision 2** — a diff view: lines added, removed and changed; below it the effect on floor steps: "18 not started — updated automatically · 3 already started — flagged for the planner", each flagged step with Keep / Replace / Cancel.

**14C · Weld map** — per line, the joint list (joint ID, type: long seam / circ seam / nozzle / attachment, components joined, WPS, NDT extent). A "Generate from shell courses and nozzles" button fills a starting list the engineer then edits; generated rows are marked until confirmed.

**15 · Template studio · Equipment type** — for whoever maintains templates: the equipment type "Horizontal vessel on saddles" with tabs **Kit** (component types with default quantities, e.g. Shell course ×3, Dished end ×2, Saddle ×2, Nozzle × from nozzle schedule), **Questions** (each with options and the rule it drives, written as plain sentences: "If PWHT is No, leave out Process 21 PWHT"), **Step patterns** ("For each long seam: set-up → weld → RT (H, Buyer TPI)"), **Durations** (base days and quantity bands). A right panel **Preview a job**: answer the questions and see the generated steps before publishing. Version badge "v2 · draft" and **Publish as v3** (running jobs keep their version).

**16 · Floor · lot tracking** (phone 360×800, Floor theme) — a lot line, "Leg support pipes · DESPL-324 · Cutting": progress "120 of 160 done", a large number entry to add today's count (+25), quick chips (+5, +10, +25), and **Record 25 done**. A second state for "Lot then serial": shells counted 40 of 40, then individual tanks T-01 to T-40 appear for fit-up.

Also update earlier artboards where it helps: the job switcher and Portfolio must show DESPL-329 (heat exchanger) and DESPL-324 (40-unit lot job) correctly, and the Job board for an exchanger uses the exchanger's stage list.

---

## PROMPT 3 — Outputs, states and the system

Add:

**08 · Unit traveller (print)** — A5 portrait, black-and-white safe: DESPL logo placeholder, job, client, unit serial (large), a large QR code placeholder with the short URL under it, and the 25 stages as a two-column checklist with tick boxes and "date / sign" lines for paper backup. Also a sheet of 4 smaller component tags (Shell, Top head, Bottom head, Skirt) each with its own QR.

**09 · Morning digest email** — 600 px wide, readable in Gmail on a phone, sent 08:30 IST to MD, CEO and the Production Head: subject "DESPL daily — 2 jobs need attention · same-day updates 81%"; jobs at risk (from §6); overdue by department with the top reason each; yesterday's out-of-sequence starts; same-day update rate per department as a small table; one button "Open dashboard".

**10 · States board** — for the Floor screen, Today, Job board and QC queue: loading skeletons that match each layout (no spinners); empty states (one sentence + one action, e.g. "Nothing due today. Claim the next job from the pool."); error with Retry; permission-limited view ("Only QC can record this result"); offline.

**11 · Components** — both themes side by side: status chip (all 8 states) · Stage Spine (mini and full, tap areas drawn as dashed boxes, current-stage marker, tooltip) · step row (work and inspection variants, all states) · batch bar and batch picker row · Done-at control · reason sheet · refusal card (hard) and flag card (soft) · KPI tile (plain and linked) · matrix cell (all states) · table with expandable row · Stage Sheet (drawer and bottom-sheet variants) · undo toast · filter chip · buttons (primary, secondary, quiet, destructive; 48 and 56 px touch sizes).

**12 · Navigation shells** — phone bottom bars per role: Operator (Today · Scan · Alerts) · Supervisor (Today · Team · Scan · Board) · QC (Queue · Board · Scan) · Management (Portfolio · Jobs · Digest). Desktop sidebar per role with the same items, plus the top bar (breadcrumb, job switcher with mini Spine, ⌘K, bell). Show the ⌘K palette open with results: jobs, units ("320SR05"), stages, people, and actions ("Mark done…", "Give reason for 1 overdue item").

**00 · Tokens** — finalise both themes as swatch tables with contrast ratios printed next to each text/background pair and each status-on-surface pair. Flag anything under AA.

---

## PROMPT 4 — Review and fix

Review every artboard against these checks, list what fails, then fix it:

1. A real event can be recorded in ≤ 3 taps from the Floor screen or Today, with no scrolling on a 360×800 phone.
2. No text under 12 px on touch artboards or 11 px on desktop; every tap target ≥ 44 px (48 px for primary actions on touch).
3. Every text and status pair passes WCAG AA in both themes; borders and focus rings reach 3:1.
4. Status always shows dot + label + glyph; Rejected and Out of sequence are distinguishable from Overdue at a glance.
5. No table has more than 6 columns; no screen shows a wall of identical cards; no personal list shows more than about 7 items before "Show all".
6. Every refusal says what is missing, who can clear it, and offers a button.
7. The same number (e.g. the QC queue count) is identical on every artboard where it appears.
8. Floor language everywhere ("Shell SR03 · Rolling"), sentence case, no internal codes.
9. Nothing decorative: no gradients, glow, emoji, illustrations; accent orange used at most three times per screen.
10. The Hindi and Gujarati variants of the Floor screen still fit without truncating actions.
11. Every screen works for a heat-exchanger job and a 40-unit lot job, not only for DESPL-320: no label, column or layout assumes 9 serial units of one pressure vessel.
12. Every automatic inclusion or exclusion on the set-up screens shows its reason in one line.

Finish with a one-paragraph summary of the design decisions and any rule you chose to break, with the reason.
