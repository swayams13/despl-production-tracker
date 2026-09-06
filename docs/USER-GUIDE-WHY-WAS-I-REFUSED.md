# Why Was I Refused? — A Plain-Language Guide

The system refuses actions on purpose. Every refusal you see exists to stop a real mistake — a
part getting welded before it's inspected, one person signing off their own work, a unit shipped
with an open defect. When the system says no, it is doing its job.

This guide explains every refusal message you can actually run into, grouped by the kind of work
you do. Find your role below, or use Ctrl+F to search for the exact words you saw on screen.

**Not covered here:** a handful of internal safety checks that a normal user cannot trigger by
doing their job normally (malformed data from a direct database edit, a route-numbering mismatch
only an administrator authoring a new product family could hit). Those are listed at the bottom,
for administrators only.

---

## Everyone on the shop floor (Supervisors, QC, anyone claiming work)

### "This process cannot start yet — one or more predecessors are not complete."
**What it means:** The step before this one in the sequence hasn't been finished yet. You can't
weld a seam before it's cut, or paint a vessel before the hydro test passes.
**What to do:** Check the job's stage spine (the row of boxes on the job page) to see which earlier
step is still open, and who owns it. If it looks stuck, follow up with that department.
**Why:** The sequence exists because skipping a step is how real defects get built in and only
found later, when they're expensive to fix.

### "The person who submitted an entry cannot also verify it. A different QC user must verify."
**What it means:** You (or your login) already marked this work as done. The system needs a
*different* person to check it before it counts as verified.
**What to do:** Ask a colleague — a different QC inspector — to open the item and verify it.
**Why:** The same person cannot mark their own work correct. This is the maker-checker rule, and
it's non-negotiable — it's how the audit trail proves the work was actually checked.

### "An inspection hold point on this item is still open. It must be cleared before completion."
**What it means:** Somewhere earlier in this item's history, an inspection checkpoint was raised
and never closed out.
**What to do:** Go to the QC screen and find the open hold point for this item. It needs to be
recorded and cleared before this stage can finish.
**Why:** A hold point is a mandatory inspection stop — usually required by the client or the
inspection plan. Letting work continue past it silently would defeat the point of having it.

### "An operation feeding this stage has an open non-conformance report. It must be closed before this stage can verify."
**What it means:** A component or sub-assembly that goes into what you're verifying has an open
NCR (a recorded defect) somewhere upstream.
**What to do:** Find the open NCR (QC screen, or the component's own history) and get it
dispositioned — reworked, repaired, or accepted — before trying again.
**Why:** You cannot sign off a stage that's built on a known, unresolved defect.

### "This stage requires evidence that hasn't been recorded yet. Complete the required action first, then verify."
**What it means:** This particular stage needs proof of something — a packed unit, a dispatch
record, a compiled document set — and that proof isn't in the system yet.
**What to do:** Do the real-world action the system is asking for (pack the unit, record the
dispatch, compile the document) — then come back and verify.
**Why:** Some stages exist specifically to record a fact happened. Verifying without the fact
existing would make the record lie.

### "This department has an overdue process on this unit. File a categorised delay reason to continue."
**What it means:** Your department is running behind schedule on this unit, and the system wants
a reason on record before you can move on.
**What to do:** File a delay reason from the dropdown provided — pick the category that actually
matches (material, resourcing, rework, client hold, etc.).
**Why:** Delays happen. What matters is that they're categorised and visible, not swept under the
rug — this is what lets management see real bottlenecks instead of guessing.

### "One or more fabrication or assembly operations backing this process are not yet complete on this unit."
**What it means:** This process is a rollup of smaller component or assembly operations, and at
least one of them isn't finished yet.
**What to do:** Open the component or assembly tab for this unit and find what's still open.
**Why:** The rollup can't say "done" if a piece of the real work underneath it isn't.

### "You can only claim work belonging to your own department."
**What it means:** You tried to pick up a task that belongs to a different department's queue.
**What to do:** Only claim work from your own department's pool. If you think this task should be
yours, check with your supervisor — it may be mis-routed.
**Why:** Keeps accountability clear — a task claimed by the wrong department is invisible to the
right one.

### "This work is already claimed by someone." / "This work is already complete and cannot be claimed."
**What it means:** Somebody beat you to it, or it's already finished.
**What to do:** Refresh the page. Pick a different item from the pool.
**Why:** Two people working the same task at once causes duplicate effort and confusing records.

---

## Supervisors and Department Heads assigning work

### "That person does not belong to this department."
**What it means:** You tried to assign a task to someone who isn't part of the department that
owns it.
**What to do:** Pick someone from the correct department's roster.

### "That person's account is not active."
**What it means:** The person you're trying to assign work to has a deactivated login.
**What to do:** Contact an admin to reactivate the account, or assign to someone else.

---

## QC Inspectors

### "This painting operation needs an accepted DFT reading for every planned coat before it can verify."
**What it means:** Dry Film Thickness readings (paint coverage checks) haven't all been recorded
and accepted yet for this item.
**What to do:** Record the missing DFT readings and get them accepted before verifying.
**Why:** Paint thickness is a real inspection requirement, not a formality — under-coating fails
in the field.

### "You already nudged QC for this within the last 30 minutes."
**What it means:** You (or a supervisor) already sent a reminder to QC about this item recently.
**What to do:** Wait for the cooldown to pass, or follow up directly instead of nudging again.
**Why:** Stops the notification feed from being spammed by repeated nudges for the same item.

---

## Stores and Fabrication (materials and drawings)

### "This part is recorded short. Resolve the shortage before starting this operation."
**What it means:** The system has no stock recorded against this part — you can't start work that
needs material that isn't there.
**What to do:** Check with Procurement/Stores on the actual shortage, and don't start the
operation until material is confirmed available (or the shortage record is corrected if it's
wrong).
**Why:** Starting cutting or fabrication on a part you don't actually have wastes time and hides a
real supply problem.

### "This component's governing drawing is not released yet. Cutting cannot start until it is."
**What it means:** The drawing this part is built from hasn't been officially released — it might
still change.
**What to do:** Check with Engineering on the drawing's release status.
**Why:** Cutting metal to an unreleased drawing risks scrapping it the moment the drawing changes.

### "This would take the lot's available quantity below zero."
**What it means:** You're trying to issue, return, or scrap more material than the lot actually
has available.
**What to do:** Check the real physical quantity and re-enter the correct amount, or check whether
another transaction already used up the stock.

### "This unit has not been packed yet. Assign it to a package before adding it to a dispatch batch."
**What it means:** You tried to add a unit to a dispatch batch before it was packed.
**What to do:** Pack the unit first (create or assign it to a Package), then add it to the batch.

### "This unit and package belong to different jobs and cannot be linked."
**What it means:** You're trying to pack a unit into a package that belongs to a different job.
**What to do:** Use a package that belongs to the same job as the unit.
**Why:** Mixing units from different jobs into one package would corrupt both jobs' dispatch
records.

---

## Everyone (general account and permission messages)

### "You do not have permission to do this."
**What it means:** Your role doesn't allow this action. This isn't a bug — it's a deliberate gate.
**What to do:** If you believe you should be able to do this, talk to your department head or
admin about your role assignment.

### "Please sign in."
**What it means:** Your session expired, or you were never logged in.
**What to do:** Log in again with your credentials.

### "That record does not exist, or you cannot see it."
**What it means:** Either the link/ID you used is wrong, or the record belongs to a tenant/client
you don't have access to.
**What to do:** Double check the link. If you believe you should see this record, contact an admin.

### "Some of the values submitted are not valid."
**What it means:** Something in the form doesn't pass a basic check (wrong format, missing
required field). The specific field is usually highlighted.
**What to do:** Fix the highlighted field and resubmit.

### "Someone else changed this while you were editing. Reload the page and reapply your changes."
**What it means:** Another user (or another tab) saved a change to this exact record after you
loaded it, and your version is now out of date.
**What to do:** Reload the page, check what changed, and reapply your edit if it's still needed.
**Why:** Without this check, your save could silently overwrite someone else's — this is caught,
not something you did wrong.

### "Your current password is incorrect."
**What it means:** The "current password" field didn't match.
**What to do:** Retype it carefully, or use password reset if you've forgotten it.

### "Too many attempts. Wait a few minutes and try again."
**What it means:** You (or someone) tried and failed too many times in a row — this is a security
lockout, not a broken system.
**What to do:** Wait 15 minutes, then try again.

### "Your new password must be different from your current password."
**What it means:** You tried to "change" your password to the same one it already is.
**What to do:** Pick a genuinely different password.

### "Change your password before doing anything else."
**What it means:** An admin (or the system, on first login) required you to set a new password,
and you haven't yet.
**What to do:** Follow the password-change prompt — nothing else in the system will work until
you do.

### "This record belongs to a different client." *(client-portal users only)*
**What it means:** You're a client-portal user and tried to view something that belongs to a
different client's job.
**What to do:** This is expected — you can only ever see your own company's jobs.

---

## Management / Client Portal (daily update publishing)

### "Today's client update is already verified and locked. It cannot be republished."
**What it means:** Today's snapshot for this job was already reviewed and approved — it's locked
for the day.
**What to do:** Nothing to do — tomorrow's update will be a fresh one.

### "There is no published update waiting for review right now."
**What it means:** You tried to approve or reject an update, but nothing has actually been
published yet today.
**What to do:** Wait for the day's update to be published before reviewing it.

### "An earlier day's update is still awaiting Management review. It must be verified or rejected before a new one can be published."
**What it means:** A previous day's snapshot was never reviewed, and the system won't let a new
one queue up behind it.
**What to do:** Go review (verify or reject) the stuck earlier update first.
**Why:** This stops the client from ever seeing a gap or a silently-skipped day.

---

## Department Heads / Production Head (planning, overrides, job status)

### "Changing a planned date requires a reason, which is recorded."
**What it means:** You're overriding a scheduled date, and the system requires a note explaining
why.
**What to do:** Enter a real reason — it becomes part of the permanent record for this job.

### "Waiving a witness point requires Production Head approval."
**What it means:** You tried to skip a client/inspection witness point without the right
authorization.
**What to do:** Route the waiver through a Production Head.

### "This process has no confirmed duration yet — it cannot be scheduled until DESPL provides one."
**What it means:** This process's expected duration hasn't been confirmed in the system yet, so
it can't be scheduled.
**What to do:** This needs a decision from planning/engineering on the real expected duration —
not something you can fix by re-entering data.

### "This process cannot move to that state from its current one."
**What it means:** You tried to skip a status (e.g. marking something dispatched before it was
even started).
**What to do:** Move it through the correct sequence of states.

### "The process graph for this job is invalid and cannot be scheduled."
**What it means:** Something in this job's process sequence is broken (a loop, a missing link) —
scheduling can't run against it.
**What to do:** This is a real data problem — contact an admin rather than trying to fix it by
re-entering the schedule.

### "This job already has per-unit schedules. A duration override at job level would replace them and cannot be applied here."
**What it means:** You tried to override a duration at the whole-job level, but this job already
has individual unit-level schedules that would be silently wiped out.
**What to do:** Apply the override at the unit level instead.

### "This job cannot be marked complete — it still has incomplete process plans on its current schedule run."
**What it means:** You tried to close out a job while real work is still open on it.
**What to do:** Finish (or explicitly cancel) the remaining open process plans first.

### "You cannot deactivate your own account." / "You cannot remove your own admin role."
**What it means:** Safety rails to stop an admin from accidentally locking themselves out.
**What to do:** Have a second admin make the change if it's genuinely needed.

---

## Administrators and Engineering (route/template authoring — internal, but worth knowing)

### "That process route is still a draft and cannot be used for a job. Publish it first."
**What it means:** You tried to start a job on a process template that hasn't been published yet.
**What to do:** Publish the template, or use an already-published one.

### "This process route is published and cannot be changed. Create a new version to make edits."
**What it means:** Published templates are locked — this is deliberate, so jobs already running on
a version never see their route change under them.
**What to do:** Create a new version to make your edit.

### "This process route is missing information it needs before it can be published."
**What it means:** The route template you're authoring is incomplete.
**What to do:** Fill in whatever the screen flags as missing.

### "A job with this number already exists."
**What it means:** Job numbers must be unique — this one's taken.
**What to do:** Pick a different job number.

### "Revision numbers must increase. Enter a number higher than the drawing's/equipment's current revision."
**What it means:** You tried to create a new drawing or BOM revision with a number that isn't
higher than the last one.
**What to do:** Use the next number up.

### "Can't set this parent: it would create a circular reference. Pick a different parent item."
**What it means:** You tried to nest a BOM item under something that's actually one of its own
children — that would create a loop.
**What to do:** Pick a different parent for the item.

### "This number does not match any process in the family's published route — check the template's process list."
**What it means:** You're authoring a lead-time mapping and entered a process number the family's
published template doesn't actually have.
**What to do:** Check the template's real process list and use a number from it.

---

## Skipped — internal-only, not reachable by normal use

- **`BOM_CYCLE_DETECTED`** — a defensive check against malformed data from a direct database
  write. A normal user, using the app normally, cannot trigger this. If you ever see "This BOM
  item's parent chain is malformed," contact an administrator immediately — it means the
  underlying data was edited outside the app.
- **`QCP_ITEM_UNRESOLVED`** — "An assembly checkpoint could not be matched to a QCP item." This can
  only happen if a new product family's assembly template and QCP template were authored
  inconsistently. It's a signal to the administrator who set up that family's templates, not
  something a shop-floor user causes.
