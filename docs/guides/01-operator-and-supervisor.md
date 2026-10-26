# Operator and Supervisor guide

For Fabrication, Fabrication Prep and Machine Shop. Print on one sheet, both sides. Keep it at the workstation.

## Before you start

- Sign in with **your own** login. The first time, the system asks you to change the password. Never use someone else's login: the system must see different people do and check the work.
- A message that says no is on purpose. Read it. It says why and who can fix it.

## Open your unit

1. **Scan the QR** on the unit traveller with your phone camera. The unit page opens.
2. No camera? Tap **Scan**, type the serial (for example `320SR05`) and tap **Open unit**.
3. The page shows the next steps for your department, grouped by part: "Shell", "Top head", "Nozzles". Tap **Show more** for the rest.

**Today** is your personal list: steps assigned to you. If it says "Nothing is assigned to you", ask your supervisor, or tap **Claim next** to take the next job waiting in your department.

## Start and Done

- **Start** when you begin a step. **Done** when it is finished. The system stamps the time itself.
- Forgot to tap earlier? On the sheet, choose **Earlier** and pick the real time. You can go back about 3 working days. For anything older, ask the Production Head or an admin.
- **Same step on many units** (for example "Shell weld edge preparation" on SR01 to SR08)? Tap **Also for SR02 to SR09**, tick the units, then **Mark done for N units**.
- Weld step: the sheet asks **Welder for LS-1**. Pick the welder.
- Lot step (many pieces): enter **how many pieces are done now**.
- A step that needs QC shows "Sent to QC" and then **With QC**. You do not tick it again.
- If QC sends a step back, the row says **Returned by QC** with the reason. Fix it and tap **Done** again.

## Late work

If a step is past its planned finish, the sheet asks **This is late. What held it up?** Pick the closest reason. You cannot mark it done without one.

## What the messages mean

| You see | It means | You do |
|---|---|---|
| **Out of usual order** | An earlier step is still open in the system. | If that work is really done, tell your supervisor to tick it. If you are starting on purpose, ask your supervisor to **Start early**. |
| **Can't start yet** (red card) | A real rule stops you. Examples: material not issued, no heat number, drawing not released, weld before fit-up, hydro before heat treatment, painting before hydro. | Read the line **Not done yet** and **Can clear it**. Tap the button on the card. Nobody can skip these, not even a supervisor. |

**Notify** buttons tell the right person in one tap ("Notify Stores", "Notify Engineering", "Notify Quality Control"). You can send the same notice once every 30 minutes. If it says nobody is set up for that role, ask the Production Head.

**Pick heat number** (cutting a pressure part): choose the heat number of the plate you cut from. You cannot type one. If the list is empty, Stores must record it.

## Supervisor only: Start early

On an **Out of usual order** row, tap **Start early**. Pick a reason (material ready early, crew or machine free, crane or space free, client priority, or Other with a note). Tap **Start and flag for Production Head**. The Production Head sees it. Nothing waits for approval. Use it when you can safely begin. Do not use it to hide unfinished work.

## Supervisor only: Team

- **Unassigned**: tick rows, then tap a person's name. **Reassign** moves someone's open work to another person.
- **Overdue and blocked**: what is late or stuck. **By process**: one reason for a whole group, **Apply reason to N overdue**.
- **Same-day updates**: the share entered the same day. The pilot target is 90 percent.

## Wi-Fi drops, wrong taps

- Every tap is **sent at once**. There is **no Undo**.
- If you see **Not sent** and "No connection. Nothing was sent.", tap **Try again** when Wi-Fi is back. It will not record twice. The row stays grey until the screen shows the result. Do not tap it again.
- Tapped the wrong thing? Tell the Production Head or an admin at once. They fix it with a correction that keeps the record. If the step went to QC, QC can also reject it with a reason and it comes back to you.

## To confirm with DESPL

1. "Send on tap, no Undo, Not sent, Try again" is pull request 163, not yet merged. Today the live code still shows a 10 second Undo bar. Merge it before training, or remove those lines.
2. The time picker lets you go back 3 calendar days. The server counts 72 working hours. Confirm the wording staff should hear.
3. How a wrong tap is corrected. There is no correction screen in the app. Name the person and the method.
4. The floor screens (Today, Team, Scan) must be switched on for production.
5. Who records Machine Shop steps on the pilot job.
6. Hindi and Gujarati labels are unreviewed. This guide is English only.
