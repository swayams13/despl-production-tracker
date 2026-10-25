# DESPL Production Tracker pilot: what each kind of job gets

Written 25 Oct 2026 for department heads. One page. Items marked **(▲)** need a start-up step that is not done yet; they are listed at the bottom.

## Three levels of tracking

| Level | What it means for you |
|---|---|
| **1. Steps** | Every unit has its list of steps (36 processes, 54 assembly steps). You press **Start** and **Done**; the system stamps the time. QC points and hold points are on the list. Late work asks for a reason. |
| **2. Rules** | The system refuses mistakes and says why: welding before fit-up on the same joint, hydro before final heat treatment, painting before hydro, and one person both doing and checking the same work. |
| **3. Parts** | Each part (plate, shell, head, flange) is tracked on its own: material issued, heat number picked, cutting and rolling steps. This needs an approved parts list for the job. |

## What each kind of job gets

| Kind of job | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| **DESPL-320** (already set up) | Yes | Yes | Yes, once Stores has the purchase order (PO) entered |
| **A new vessel like DESPL-320** (vertical, on a skirt) | Yes | Yes **(▲ 1)** | Not yet **(▲ 3)** |
| **A job already running in Excel** (for example DE0463, DE0467) | After Planning sets up its units and schedule, then the Excel sheet is loaded and finished work is ticked | Same as above | Not yet **(▲ 3)** |
| **A different vessel design** (different nozzles or shell courses, on legs, horizontal on saddles) | Not properly: the steps are a copy of DESPL-320's joints | Not reliably | Not yet |
| **Heat exchangers and piping** | Not in this pilot | Not in this pilot | Not in this pilot |

For a different vessel design, ask the Production Head first: Engineering has to publish that design's own step list before the team can track it.

## Starting a new job (Planning or Production Head)

1. **New job**, then **Start from a template** or **Copy a previous job**.
2. Fill the order. **The delivery date is required.** Add the equipment line and serial numbers, and choose the QC plan that matches the standard checklist.
3. Create the job, then **Release BOM** (Engineering or Production Head). The steps appear on the floor only after the release.
4. Per job, add: the **weld map** (joints), the **indent and PO** (so Stores sees the lines), and the **drawings** (so the drawing rule can hold).

## What you will see on screen

- On a new unit, steps read **"Out of usual order"** until the earlier steps are recorded. If the work is really done, tell your supervisor. If you are starting early on purpose, a supervisor uses **Start early** and gives a reason.
- A red or yellow message that refuses an action is on purpose. Read it; it says why. Do not work around it.
- Fewer steps will go to QC on new jobs than on DESPL-320. QC's own list of which steps skip QC is still being reviewed.

## Not available yet

Production Head's Acknowledge button for early starts, steps that change with the number of shell courses or nozzles, the email digest, WhatsApp, offline use, and Hindi or Gujarati screens.

## Start-up steps still owed (▲)

1. **Step roles update on production.** Without it, new jobs do not get the weld, heat-treatment and hydro rules (Level 2). It is in review (PR #159) and then needs a run from the hotspot.
2. **Team logins and the floor screens switched on** for everyone (Today, Team, Scan).
3. **Approved parts list** (Production Head approves, or the pilot accepts Level 1 and 2 only for new jobs). Level 3 depends on it.

Report anything odd with `REPORT-A-PROBLEM.md`. What is and is not built: `WHAT-IS-READY.md`.
