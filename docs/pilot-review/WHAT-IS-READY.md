# DESPL Production Tracker: pilot review, 21 Oct 2026

What you can try, what is not built, and what we have not checked. Plain language, one page.

## What is ready to try (checked on a test copy through the real login screens)

- **Create a new pressure-vessel job** with a delivery date, design answers (pressure, temperature, shell courses…), serials, and a QC plan. A job cannot be created without a delivery date. Choose the QC plan that matches the standard assembly checklist; the screen warns about the others.
- **Stores:** receive stock, issue it to a part, pick the heat number. Issuing completes the part's Receipt step.
- **Floor:** each department sees its own next steps. Start, Done, "start early" with a reason (supervisor), a late reason when Done is late, and a back-dated time within 72 working hours.
- **Refusals that protect quality**, each with a plain-English reason: cutting a pressure part before material is issued and the heat picked; welding before fit-up on the same joint; hydro before final heat treatment; painting before hydro; one person verifying their own work.
- **QC:** accept, reject (reason required, opens a rejection report), disposition (rework and the others), hold points (clear or reject).
- **Dispatch checks:** the Dispatch tab shows why each unit cannot ship (open hold points, open rejection report, production not complete).
- **Management** (MD, CEO): dashboard, portfolio, job pages. Read only.
- **Travellers** with QR, and **Scan** by serial number. Works on a phone.

## Not built yet (please do not look for these)

- Production Head's "Acknowledge" of an out-of-sequence start (the list shows; the button does not exist).
- One plan per job for office processes 1–11 and 33. Today a new job gets a copy per unit.
- Shell courses and nozzle count changing the weld steps for a new job. The standard checklist carries DESPL-320's own joints.
- Weld-map screen, drawing release and "release at risk" screens (the drawing-released rule has no effect for new parts).
- Attaching a QC plan after the job is created.
- A Production Head override on the Excel switch-over.
- Email digest (no mail server set up), WhatsApp, offline use.
- Hindi and Gujarati are only partly translated and unreviewed: do not judge the wording.
- Client portal, analytics screens, planner agent: switched off on purpose.

## Not checked

- A successful dispatch of a finished unit through the screens (every unit still has open QC steps).
- Performance with many users at once on the shop-floor network (the test machine was overloaded; floor pages timed out there).
- Heat-treatment and hydro hold rules H5/H6, the drawing rule H3, concessions.
- Real shop tablets, printing the traveller on paper, scanning the QR with a camera.
- Whether the Stores, QC and Planning logins you will be given have the right department set up.

## Things to know while you try it

- Sign in with the login Swayam gives you. You will be asked to change the password first.
- Three people cannot share one login: the system must see a different person submit and verify.
- If a button says "Start early", it needs a supervisor and a reason: that is intended.
- Report anything odd using `REPORT-A-PROBLEM.md`.
