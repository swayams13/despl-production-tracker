# Planning/PPC and Engineering guide

For Planning/PPC and Engineering. Print on one sheet, both sides.

## What each role can do

| | Planning/PPC | Engineering |
|---|---|---|
| Tick office processes 1 to 11 (Today) | Yes | No |
| Build and save a new-job draft | Yes | No |
| Create the job from a draft | No (Production Head or Admin) | No |
| Release the BOM | No | Yes |
| Edit the weld map, drawings | No | Yes |
| Edit master data (parts, routes) | View only | Yes |
| Approve master data, release a drawing at risk | No | No (Production Head only) |

## Planning/PPC: Today

Open **Today** in the menu. It lists the office processes (1 to 11, project kick-off to procurement). Tick each one as it happens: **Start**, then **Done**. You cannot record floor steps. Late? The sheet asks **what held it up**. There is no Undo: a wrong tap goes to the Production Head or an admin.

## A new job

1. Open **New job**. Choose how to start.
   - **Copy a previous job**: search by job number, client or product, then **Copy as draft**. It copies the answers, BOM, weld map and QC plan. Serials, dates and progress start fresh.
   - **Start from an equipment template**, or **Build from master** (equipment type with a standard kit).
2. Five steps: **Order**, **Equipment lines**, **Configure**, **QC plan**, **Schedule and release**.
3. The **committed delivery date is required**. Without it the job cannot be scheduled.
4. Choose the **QC plan** that matches the standard assembly checklist. The screen warns about the others. The system refuses a plan that does not cover the checklist.
5. **Save and exit** saves a draft. **Resume** continues it. The Production Head or Admin taps **Create job**.
6. After create, the floor still shows **nothing** for the new units. Steps appear when Engineering releases the BOM.

## BOM release (Engineering)

Open the job, **Materials**, **Release BOM**.

1. Pick the equipment line and the BOM revision.
2. Match each BOM line to a **part family**. Tap **Save mapping**. A line mapped to a part family that is not approved shows **Cannot release**. Ask the Production Head to approve it in master data.
3. Read the preview: parts, operations and assembly steps it will create.
4. Read the warnings, tick the box to confirm, tap **Release revision N**.
5. A line that already has steps cannot be released again from scratch. A later revision shows **Changes found**. Rows already started are only flagged and wait in **Waiting for review** for the Production Head: Keep, Replace or Cancel row.

## Weld map

Job, **Materials**, **Weld map**. It lists joints per line. Steps for welding, fit-up and NDT are made from these joints **when the BOM is released**. Joints added later do not change units that already have steps.

- **Add joints from a list**: for example `N1-N6, M1`.
- **Load an Excel weld map**: .xlsx, up to 4 MB. Columns: Joint no, Type, Joins, WPS, NDT extent, Remarks. Check it first, then load. Loading again changes nothing. A joint missing from the file is never removed.
- Joints show **Not confirmed** until QC or Engineering taps **Confirm N joints**.

## Drawings register

Job, **Materials**, **Drawings**. **Cutting a pressure part waits for its drawing to be released.**

1. **Add a drawing**: number, type, remarks.
2. **Issue revision...**: number, **Draft** or **Released**. Numbers must go up.
3. **Link selected parts**: under **Pressure parts with no drawing**. A part with no drawing is not held for one.
4. **Release at risk...** (Production Head only): cutting may start before release. A reason is required. A client consent reference is optional. A newer revision cancels it.

## Other

- **Load tracker sheet** (Materials tab; Planning, Production Head, Admin): loads a job already running in Excel.
- Production Head and Admin tick finished work at the switch-over date: the **Switch over from Excel** page.

## To confirm with DESPL

1. Planning has no **New job** button in the menu or on the Jobs page. The page opens for Planning by address only. Confirm whether Planning should get one.
2. Whether Engineering or Planning ticks processes 1 to 11 that Engineering owns (for example Engineering review).
3. The weld-map and drawing screens: whether the Planning role should edit them. The code allows Admin, Production Head and Engineering only.
4. Whether the one-plan-per-job change for processes 1 to 11 and 33 has been applied to DESPL-320 on production.
5. Whether DESPL-320's joints have been confirmed on the weld map.
6. Which QC plan templates are approved for new jobs. Only DESPL-320's own plan fits the standard checklist today.
