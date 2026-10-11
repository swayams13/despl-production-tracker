> **Superseded by `DESIGN-PROMPT-claude-design-v2.md` (6 Oct 2026), which is more detailed and split into four prompts. Use v2.**

# Claude Design prompt — DESPL Production Tracker, Lean Core redesign

Paste everything below the line into Claude Design. It is self-contained.

---

## What you are designing

Redesign the UI of an internal **production tracker** for a pressure-vessel fabrication company in Gujarat, India (DESPL). The tracker follows each order from PO to dispatch across 13 departments. About 50 people use it: shop-floor operators and supervisors on cheap Android phones and rugged tablets in bright, noisy fabrication bays; QC inspectors on tablets; planners and stores staff on office desktops; the Production Head on a laptop and phone; the MD and CEO mostly on phones.

The product is being simplified so the shop floor will actually use it. **Today nobody updates it daily**, because recording one real event takes many clicks across several screens. Your design must make every update fast and obvious, and let management understand job health at a glance without reading tables.

**The one test every screen must pass:** a supervisor records a real event in three taps or fewer, without scrolling, on a 360 px-wide Android phone in a bright bay.

## How the work is organised (domain model, so labels are right)

- **Job**: a customer order, e.g. **DESPL-320 — HP Air Receiver × 9** (ASME VIII Div 1), committed dispatch 08 Apr 2027.
- **Unit**: one vessel in the job, serial **320SR01 … 320SR09**.
- **Component** (per unit): Shell, Top head, Bottom head, Skirt, Nozzles N1–N6, Manway M1.
- **Step**: a piece of work on a component or unit, e.g. for Shell Welding: *Shell weld edge preparation · Long seam LS-1 set-up · Weld long seam LS-1 · Bottom head to shell set-up (CS-2) · Weld circ seam CS-2 · Top head to shell set-up (CS-1) · Weld circ seam CS-1*. Steps are either **Work** (the floor marks them done) or **Inspection** (QC accepts or rejects).
- **Stage**: the 25-step reporting view management reads, rolled up automatically from steps: 1 Project Kick-Off · 2 Engineering Review · 3 Detail Engineering · 4 BOM Preparation · 5 Material Procurement · 6 Incoming Material Inspection · 7 Cutting · 8 Forming · 9 Edge Preparation · 10 Shell Fabrication · 11 Head Assembly · 12 Nozzle Fabrication · 13 Nozzle Fit-up · 14 Saddle Fabrication · 15 Accessories · 16 Dimensional Inspection · 17 NDT · 18 PWHT · 19 Hydro Test · 20 Surface Preparation · 21 Painting · 22 Final Inspection · 23 Documentation (MDR) · 24 Packing · 25 Dispatch.
- **QCP points**: quality checkpoints coded **P** (perform), **W** (witness) or **H** (hold), for DESPL QC and the buyer's third-party inspector (TPI). An open **H** point stops the stage until it is cleared.
- **NCR**: a nonconformance raised when QC rejects work.
- **Departments**: Projects/PMO · Design & Detail Engineering · Planning/PPC · Procurement · Stores · Quality Control · Fabrication Prep · Machine Shop · Fabrication/Welding · Heat Treatment · Surface Treatment & Painting · Documentation/MDR · Dispatch & Logistics.

Rules the UI must express (they are enforced by the server):
- **Hard stops** (shown as a clear refusal, never hidden): an open H hold point; painting or surface prep before the hydro test is done; dispatch with an open NCR or an open hold point.
- **Soft stops**: starting something out of the usual order is allowed with a short reason; it is then flagged "Out of sequence" for the Production Head.
- **Late work**: marking an overdue step done asks for a reason in the same sheet (pick a category + optional note). It never blocks other work.
- **Time**: "Done at" defaults to now and can be set back up to 72 hours ("I finished this yesterday at 5 pm"). Show both the reported time and when it was recorded, in detail views only.
- **Batch**: most work happens on several units at once ("Long seam welded on SR01–SR05"). Batch must be a first-class, one-gesture action.
- **QC**: QC acts only on inspection steps and W/H points, and never on work they recorded themselves.

## What is wrong with the current UI (avoid all of it)

- Text as small as 9–10.5 px in 129 places; nothing on a phone should be under 12 px.
- Borders at 1.15:1 contrast against surfaces; status chips below 4.5:1 on their tints.
- The Stage Spine segments are 13×14 px tap targets on a tablet.
- "My Day" shows the whole department's queue (300+ rows on a 40-unit job) under the user's own three tasks, and leads with a 30-day on-time % before telling people what to do.
- Tables up to 12 columns; rows of N identical cards; three different screens answer "what is my department doing", and the QC queue appears on four screens with four different counts.
- The dashboard mixes a portfolio band with one project's deep-dive, plus a sunburst chart nobody can act on.
- Navigation changes with screen width rather than role, so some screens are unreachable on desktop or tablet.
- Designed dark-first; the shop floor needs a bright, high-contrast theme.

**Keep these ideas** — they are good and people have seen them:
- The **Stage Spine**: a horizontal bar of the 25 stages, coloured by status. Mini (4 px tall) on every job/unit row; full-size and interactive on the job page. Visual bar can stay slim, but each segment needs a 44 px tap area.
- The **phone "Do this first" card** at the top of the personal list, with one primary action.
- The **Stage Sheet**: a 460 px right-hand drawer that opens from any stage or cell and shows everything about that stage plus the one correct action.
- A ⌘K command palette on desktop.
- Numbers in JetBrains Mono with tabular figures; UI text in Inter.
- Status is never colour alone: dot + label + small glyph.

## Visual direction

Industrial and precise: closer to Linear or a control-room instrument panel than to a marketing site. Data density where it helps, generous touch targets where people use gloves and phones. No gradients, glass, glow, emoji or stock imagery. One accent colour, used sparingly (more than three accent elements on a screen is too many).

**Two themes, same layout:**
1. **Floor** (light, high contrast): the default on phones and tablets, readable in direct sunlight.
2. **Control room** (dark): the default on desktops and for management. Start from these existing tokens and fix their contrast:
   - bg #0B0C0E · surface #141619 · surface-2 #1C1F24 · border **#3A4048** (was #262A30) · text #E7E9EC · muted #8B919A · accent #FF7A1A (high-vis orange)
   - Status: Done #3FB950 · In progress #4C8DFF · Waiting for QC #A371F7 · On hold #D9A62E · Overdue #F0524D · Not started **#5C6068** (was #4A4F57)
   - Add two states with their own marks: **Rejected / NCR** (red, distinct shape from Overdue) and **Out of sequence** (accent outline or notch, so it reads as "flagged", not "failed").

Derive the Floor theme so every text and status pair passes WCAG AA (4.5:1 text, 3:1 for borders, focus rings and status fills). Produce a token sheet for both themes.

**Type:** Inter for UI, JetBrains Mono for numbers. Page title 20/600 · section label 12/600 uppercase tracked · body 14 on touch, 13 on desktop · minimum 12 px on touch, 11 px on desktop · KPI values 28/600 mono. Nothing larger than 28 px.

**Layout:** 8 px grid. Phone: bottom navigation by role (max four items plus a central **Scan** button for floor roles). Desktop: 236 px sidebar, 48 px top bar with breadcrumb, job switcher (showing a mini Stage Spine) and notification bell. Tables: at most 6 columns, sticky first column, row height 36 px desktop / 48 px touch; anything else goes in an expandable row or the Stage Sheet.

## Interaction rules

- One primary action per row or card, written as the outcome: "Mark done", "Accept", "Reject with reason", "Start". Sentence case, plain words, no internal codes or raw enum names.
- **Undo instead of confirm**: a done tap shows a 10-second undo toast; no "Are you sure?" dialogs.
- **No endless lists**: personal lists show about seven items, then "Show all (23)". Filters are chips that survive refresh.
- **Refusals explain themselves**: what is missing, who can clear it, and a "Notify QC" style button. Example: *"Hydro test on 320SR01 isn't done yet. Painting can start once QC records it. [Notify QC]"*.
- **Speak the floor's language**: "Shell SR03 · Rolling done", never "Process 13 × Unit 3".
- Floor screens must work with one thumb. Show one variant of the Floor screen with Hindi labels and one with Gujarati, to check that the layout holds longer strings (draft text is fine; mark it for review).
- Everything reachable by keyboard on desktop, with a visible focus ring.

## Screens to design

Use realistic data: DESPL-320 (9 units, mid-production: cutting and forming done, shell fabrication in progress on SR01–SR05, SR06–SR09 behind), DE0463 (SS Tank × 40), and three invented jobs so the portfolio has 5 rows with mixed health. Invented people: Vikram Solanki (Fabrication Supervisor), Imran Shaikh (Welder), Ramesh Patel (Fitter), Neha Desai (QC Inspector). Show the Production Head, MD and CEO by role only.

**Pass 1 — the floor experience** (do this first; show two directions for screen 1 before refining):

1. **Floor — scanned unit** (phone 360×800, Floor theme). Opened by scanning the QR on a unit's printed traveller. Header: job, serial, stage on the Stage Spine. "Next for Fabrication": the next 3–5 steps grouped by component, each with a big Done and an optional Start. A "Also for other units" control that opens a unit picker (SR02–SR09, with each unit's state for that step) for batch completion. States: late step → reason sheet; hard-stop refusal; out-of-sequence → short reason sheet; batch result ("5 done · 1 blocked: SR04 hold point open"); offline ("2 updates waiting to send"); undo toast.
2. **Today** (phone 360×800 and desktop 1440×900). A one-line summary ("6 assigned · 1 needs attention · 3 due today · 1 blocked"), then **Do this first**, **Today**, **Blocked** ("Waiting on: Plate rolling (Fabrication Prep)"), **Upcoming** (collapsed), **My progress** (collapsed, at the bottom). After 4 pm: an **end-of-shift check-in** sheet listing today's planned items, each Done / Not done + reason, submitted in one tap.
3. **Job board** (desktop 1440×900 and tablet 1024×768 landscape). A units × 25 stages matrix for DESPL-320, every cell coloured by status and showing its value or date (empty cells read as "Not started", never blank). A mini Stage Spine per unit row, filter chips (department, status, out of sequence), and "Export to Excel". Tapping a cell opens the **Stage Sheet**: the stage's step checklist with who and when, planned vs done-at vs recorded time, linked QCP points with their P/W/H codes and results, any overrides and late reasons, and the role-correct action.

**Pass 2 — the people who manage the work:**

4. **Team** (desktop) for the Fabrication Supervisor and Production Head: department KPIs (open, on-time %, overdue, blocked, same-day update rate); **workload by person** (the centrepiece: assigned, overdue, due today, blocked, oldest item, reassign); the unassigned pool with multi-select "Assign to…" showing each person's open count; overdue and blocked; "You're blocking" and "Waiting on others".
5. **QC queue** (tablet 1024×768 and desktop). Tabs: Ready to inspect · Open holds · NCRs. Grouped job → unit, oldest first, each item with its P/W/H code and party (DESPL or Buyer TPI). Accept, and Reject with reason (rejection raises an NCR). Include a disabled "Add photo" slot labelled "Coming in phase 2" only on this screen, as a placeholder the team can react to.
6. **Portfolio dashboard** (desktop 1440×900 and phone for the MD). Five linked KPI tiles: Active · Delayed · At risk · On hold · Actions due. A project health table (Job · Client · Progress vs plan · Committed vs forecast dispatch · Health · Top blocker), worst first. Department bottleneck bars (blocked / overdue / rejected per department). A "Needs attention" queue of the top 15 exceptions (job · what · department · owner · age · action). One line: "2 of 5 jobs forecast past committed date · total slip 19 days". No sunburst, no S-curve on this page.
7. **Job overview** (desktop). Header: job, client, committed vs forecast dispatch, % done vs % planned, open holds, the full Stage Spine. Tabs: Overview · Board · Schedule · Materials · QC · Dispatch · History. Design Overview and **Materials**: BOM lines (part, material, qty) with a pipeline of chips Indent → PO → Received → Identified (heat no.) → Issued, and "short for work starting this week" highlighted.

**Pass 3 — outputs and the system:**

8. **Unit traveller** (A5 portrait print, black and white safe): job, client, unit serial, large QR, short URL fallback, the stage list with tick boxes for paper backup.
9. **Morning digest email** (600 px wide, works in Gmail on a phone): jobs at risk, overdue by department with top reasons, yesterday's out-of-sequence overrides, same-day update rate by department, one link to the dashboard.
10. **States board**: loading skeletons that match each layout, empty states (one sentence + one action), error with retry, refusal, offline, and permission-limited views.
11. **Component sheet** for both themes: status chip, Stage Spine (mini and full, with tap areas shown), step row, batch bar, reason sheet, refusal card, KPI tile, matrix cell, table with expandable row, Stage Sheet, toast with undo, bottom nav per role (Operator: Today · Scan · Alerts; Supervisor: Today · Team · Board · Scan; QC: Queue · Board · Scan; Management: Portfolio · Jobs · Digest), desktop sidebar.

## Deliverables and notes

- Each screen at the viewports listed, in the theme listed (show at least the Job board and Portfolio in both themes).
- Short annotations on interactions that a still frame can't show (batch picker, undo, reason sheet, drawer).
- Flag any place where you had to break a rule above, and why.
- The output will be rebuilt by hand in an existing Next.js + Tailwind codebase, so favour consistent components and tokens over one-off flourishes.
