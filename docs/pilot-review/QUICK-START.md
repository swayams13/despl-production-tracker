# DESPL Production Tracker: quick start by role (pilot, DESPL-320)

One page per role. Bring your phone or the shop tablet. About 30 minutes with your supervisor.
Problems: see `REPORT-A-PROBLEM.md`. What is and is not built: see `WHAT-IS-READY.md`.

**For everyone:** sign in with your own login (you change the password the first time). Never share a login: the system must see a different person submit and verify. A red or yellow message that refuses an action is on purpose; read it, it says why. Do not work around it.

## Operator and Supervisor (Fabrication, Fabrication Prep, Machine Shop)

- You land on **Today**: the steps your department can do next, for DESPL-320's units.
- **Start** when you begin a step. **Done** when it is finished. Both take the time from the server.
- Forgot to tap yesterday? Done and Start accept the time it really happened, up to 72 working hours back. Beyond that, ask Swayam.
- Finished late? The screen asks for a reason when you tap Done. Pick the closest one.
- **Start early** (supervisor only): use when the step before it is still open but you can safely begin. It asks for a reason and tells the Production Head. Operators see "Ask your supervisor".
- Cutting a pressure part needs material issued and the heat number picked by Stores. If it says "Material not issued", tap **Notify Stores**; do not start.
- If QC sends a step back, the card says "Returned by QC" with the reason. Fix it and tap Done again.
- **MTC Verification** (check of the mill test certificate) is ticked by the Fabrication Prep supervisor.
- Your **Team** page (supervisor) shows who has what, who owes a late reason, and the same-day update rate.

## Stores

- You land on your own queue. Receive stock (quantity, heat number, where it is stored).
- **Issue** material to a part, pick the heat number. Issuing completes the part's Receipt step; nothing else to tick.
- You cannot verify or reject QC items: the screen hides the buttons and the server refuses.

## QC

- Your queue lists steps waiting for your **Accept** or **Reject**, and hold points.
- Reject needs a reason and opens a rejection report (NCR). The supervisor sees "Returned by QC" and redoes the step.
- Rework: open the rejection report, **Disposition** (rework and the other choices), then Accept the redone step; the report closes.
- Hold points: **Clear** or **Reject**. A rejected hold point stays on record; the next attempt is a new line.
- You cannot accept work you submitted yourself. With one QC user, a second QC login is needed for concessions.

## Production Head (SJ) and Planning/PPC

- **Planning/PPC** lands on Today with the office processes (1 to 11): tick them as they happen.
- **Production Head:** Portfolio (all jobs, worst first), Team per department, and **Same-day updates**: the share of updates entered the same day. The pilot target is 90% for five working days in a row.
- Start-early flags appear on the department's Team page. (Acknowledging them is not built yet.)
- Log DESPL-320's indent and PO under Materials so Stores sees what to receive.
- Dispatch tab: shows why a unit cannot ship (open hold point, open rejection report, production not complete).

## Management (MD, CEO)

- Dashboard, Portfolio and job pages. Read only. Open a job to see its units and where each one is.

## 30-minute training for a department

1. 5 min: sign in, change password, find Today.
2. 10 min: one supervisor and one operator do a real Start and Done on a DESPL-320 step; one back-dated Done; one late reason.
3. 5 min: what a refusal looks like and what to do (read it, tell your supervisor, do not retry).
4. 5 min: Scan a traveller QR by serial number; how to report a problem.
5. 5 min: questions.
