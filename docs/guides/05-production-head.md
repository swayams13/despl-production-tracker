# Production Head guide

For SJ and any other Production Head. Print on one sheet, both sides.

## Your screens

- **Portfolio**: all active jobs, worst first. Open a job for its units, Board, Schedule, Materials, QC, Dispatch and History tabs.
- **Same-day updates** (on Portfolio): the share of updates entered the same day, and "N of 5 working days at 90% or more". The pilot target is 90 percent for 5 working days in a row.
- **Team**: one department at a time. Switch department from the title. You see workload per person, **Unassigned**, **Overdue and blocked**, **Out of sequence**, and welder numbers.
- **Reports**: the daily digest. **Send now** sends the digest for the date shown to Management as an in-app notice.

## Early starts and flags

When a supervisor taps **Start early**, the step is flagged. You see it on **Team**, in **Out of sequence, last 7 days**: step, reason, who, when. Nothing waits for you and nothing is blocked. The **Acknowledge** button is not built yet. Read the list each morning. If one pair of steps keeps being started early, tell Engineering: the standard order may be wrong.

You can start early yourself too.

## Rules that cannot be skipped

Not even you can skip these. The card on the floor says what is missing: weld before fit-up on the same joint, cutting a pressure part before material is issued and heat picked, hydro before final heat treatment, painting before hydro, an open hold point, an open NCR at dispatch.

## Drawing "Release at risk"

Job, **Materials**, **Drawings**. Open the drawing, tap **Release at risk...** Give a **reason**. Add the client consent reference if the client's plan needs it. Cutting of pressure parts may then start. It is recorded against that revision. A newer revision cancels it. Only you can do this.

## Concessions (H5 and H6)

QC raises an NCR when someone welds a pressure part after final heat treatment (H5) or after hydro (H6).

1. Open **Queue**, **NCRs**. Find the NCR for that unit. It is the one QC raised from the refused weld.
2. Tap **Disposition...** Your only choice is **Concession**. Enter the **code clause** (required). Add notes. Tap **Save disposition**.
3. QC then taps **Ratify**. The NCR closes. Until then it counts as open.
4. If QC chooses **Repair** instead, the heat treatment or hydro is repeated.

**Maker-checker rule.** You cannot accept a concession on an NCR you raised, or on an item where you have a recorded write. Admins are not exempt. Another Production Head must accept it. With one Production Head, plan for this before it happens.

**Waivers.** A witness-point waiver shows **Waiver pending** on **Open holds**. Tap **Approve waiver**.

## BOM changes on the floor

When Engineering releases a later BOM revision, rows already started wait in **Waiting for review** on the Release screen. For each: **Keep**, **Replace** or **Cancel row**. A reason is required. A row waiting for QC, or with an open NCR, cannot be replaced or cancelled yet.

## Master data and templates

- **Approve** a part family: Master data, open the part, **Approve**. If you prepared it yourself it is marked self-approved. Check the list under **Before approval**.
- **Publish** an assembly sequence: **Equipment types**, **Assembly sequence**, **Publish**. You cannot publish a version you imported yourself. Another Production Head must.
- Create a job from a Planning draft: last step, **Create job**.
- Switch from Excel: job page, **Switch over from Excel**. Tick what is already done, up to a row or "Same on every unit".

## Dispatch

Job, **Dispatch** tab.

1. **Ready to ship** lists units that are blocked and why: **Hold point not cleared**, **Open NCR**, **Production not complete**.
2. **Packing**: **+ New package**, then assign units.
3. **Dispatch**: **+ New batch**, **Add unit**, then **Approve release**. It asks for the **dispatch note, gate pass, vehicle and LR numbers**. Then **Record dispatch**.

A unit with an open NCR, an open hold point or unfinished production is refused.

## Digest

You and Management get the morning digest by email at 08:30 only when mail is set up. Until then, read it in **Reports**.

## To confirm with DESPL

1. The email digest is not set up on production (no mail server). Confirm who should get it.
2. Whether DESPL has a second Production Head for concessions and assembly-sequence publishing.
3. The Acknowledge button for early starts is not built. Confirm how often you review the list.
4. Whether you may approve waivers and concessions from one login, and who is the named QC head for ratification.
5. How a dispatch is corrected once recorded.
