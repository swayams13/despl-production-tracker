# Guided demo: 20 minutes, with deliberate violations

Audience: MD, CEO, Production Head, department heads. Aim: show that the tracker **refuses** the mistakes that cost DESPL money, and records who did what. Wording below is what the screen said in the 21 Oct dry run on a test copy; check it again on the system you demo on.

**Setup (before the meeting):** `LEAN_FLOOR=on` on the system you use (staging first). Seven sign-ins open in separate browser profiles or on phones: Production Head, Supervisor Fabrication Prep, Supervisor Fabrication, Operator Fabrication, QC (two different QC people if you can), Stores, Management. Pick two fresh DESPL-320 units that nobody has touched (below: **unit A** and **unit B**). On the seeded test copy the accounts are `sj`, `sup.fabrication_prep`, `sup.fabrication`, `operator.fabrication`, `qc`, `reviewer` (QC and supervisor), `md`, `ceo`; Stores needs a real user with the Stores role (none is seeded).

| Min | Who | Do this | Show |
|---|---|---|---|
| 0–2 | Production Head | Open the job DESPL-320 and its **Board**. | One job, 9 units, every department's progress in one place. |
| 2–4 | Supervisor Fab Prep | Open **Today**, find the shell **cutting** on unit A, try **Start**. | **Violation 1:** "Material for this pressure part has not been issued. Stores must issue it before cutting." with who can clear it (Stores). |
| 4–6 | Stores | Receive a plate (with heat number), **Issue** it to unit A's shell. | The Receipt step completes by itself. |
| 6–7 | Supervisor Fab Prep | Cutting again: "Pick heat number" if asked, then try Start. | **Violation 2:** "No heat number is picked for this pressure part…" until the heat is picked; then it moves on. |
| 7–9 | Operator, then Supervisor | Operator sees the cutting row with no Start button: "ask your supervisor to start it early". Supervisor taps **Start early**, picks a reason chip, confirms. | **Violation 3:** out-of-order work needs a supervisor and a reason, and is flagged for the Production Head ("Out of sequence" on the Board). |
| 9–11 | Operator | Mark the cutting **Done**. Then, as the same person, try to **Accept** it in QC. | Done goes "With QC". **Violation 4:** the same person cannot do both halves: "The same person cannot complete both steps of this two-person control. A different person must complete the second step." |
| 11–13 | QC (a different person) | Open the QC queue, **Reject** with a reason (the button stays grey until you type one). | An **open rejection report** is raised; the supervisor's card says "Returned by QC: <reason>". |
| 13–15 | QC, Supervisor | Disposition: **Rework**. Supervisor redoes and marks Done. QC **Accepts**. | The report closes. Everything is in History. |
| 15–16 | Supervisor | Try a **back-dated** Done more than 72 working hours ago (type the time). | **Violation 5:** "That time is not allowed… An administrator can correct older entries." Nothing is written. |
| 16–17 | Supervisor / QC | Open a weld row on unit B whose fit-up is not done; open a **hydro** row; open a **painting** row. | **Violations 6–8:** weld waits for fit-up on the same joint; hydro waits for final heat treatment; painting waits for hydro. Each says why. |
| 17–19 | Production Head | Dispatch tab on DESPL-320. | **Violation 9:** "9 of 9 units blocked": hold points open, production not complete. Nothing can be dispatched. |
| 19–20 | MD or CEO | Dashboard and Portfolio. | Read only, same numbers the floor sees. |

## Say clearly

- Not shown because not built: acknowledging out-of-sequence starts, weld-map screen, email digest, drawing release (see `WHAT-IS-READY.md`).
- Not demonstrated: a successful dispatch of a finished unit.
- Hindi/Gujarati exist only for the Floor and Today screens, partly translated, unreviewed: do not demo them as ready.

## If something fails during the demo

Say what you did and what it said, take the screenshot (see `REPORT-A-PROBLEM.md`), carry on with the next row. If a page says "Application error", reload once: on a loaded machine pages can time out.
