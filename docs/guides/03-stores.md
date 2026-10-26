# Stores guide

For Stores. Print on one sheet, both sides.

## Your list

Open **Materials** in the menu. Four filters show what you have to do across all active jobs.

| Filter | Meaning |
|---|---|
| **To receive** | A PO is placed and not all of it is in. |
| **To identify** | Something is in, but no heat number or MTC is recorded. |
| **To issue** | Something is in and not all of it is issued. |
| **No heat number** | A lot came in without a heat number. The floor cannot pick a heat for a pressure part without one. |

Tap **Open** on a line. It opens the job's **Parts and stock** for that item, where you act.

## Receive

1. On the item, tap **Receive stock...**
2. Enter **Location**, **Quantity** and the **Heat number**. The heat number is needed for pressure parts.
3. Tap **Save**.

If a lot arrived with no heat number, tap **Add heat number** on that lot. You can add it once.

## Identify (heat number and MTC)

Tap **Record MTC...** Enter the **Heat number** and the **MTC ref**. Leave the PMI box on **PMI pending**. Only QC accepts or rejects PMI.

## Issue to a part

On the lot, tap **Issue**, enter the quantity, add a note if needed, and save. **Issuing completes that part's Receipt step.** There is nothing else to tick. **Return** puts stock back. Scrap is for the Production Head and Admin.

## Heat pick

Cutting a pressure part needs two things from you: the material **issued** and a **heat number**. The floor picks the heat itself, but only from heat numbers you recorded when you received it. If the cutting crew taps **Notify Stores**, you get a notice. Check:

- Is the material issued to that part?
- Does the lot have a heat number?

If not, fix it here. The crew then taps **Pick heat number** and chooses it from your list. They cannot type one.

## What you cannot do

- You cannot accept or reject QC items. The buttons are hidden and the server refuses.
- You cannot log an indent or PO. The Production Head does that. Until it is logged, your **To receive** list is empty for that job.
- You cannot edit BOM lines.

## To confirm with DESPL

1. Whether DESPL-320's indent and PO are entered. Until they are, Stores sees nothing to receive.
2. Whether "Receive stock..." alone moves a line out of **To receive**, or whether a separate receipt entry is also expected. The code counts either.
3. Whether the Stores login exists and has the Stores role.
4. Location names. The screen takes free text, so DESPL should agree one list of store locations.
5. Who records returns to supplier. Not seen in the screens.
