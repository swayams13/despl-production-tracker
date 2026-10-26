import { BACKDATE_WINDOW_HOURS } from "./floor-rules";
/**
 * Stable error codes (CLAUDE.md invariant #12).
 *
 * Every refusal the product makes must be explainable. The UI renders these
 * codes as a human sentence saying WHY an action was refused and WHAT would
 * unblock it — refusing well is the product's credibility story, not an
 * error state to hide.
 *
 * Codes are part of the API contract. Add to this list; never rename.
 */
export const ERROR_CODES = {
  /** Predecessor processes are not complete, or material deps are unmet. */
  GATING_BLOCKED: "GATING_BLOCKED",
  /** The same human tried to both submit and verify. */
  MAKER_CHECKER_VIOLATION: "MAKER_CHECKER_VIOLATION",
  /** An uncleared hold-point checkpoint blocks completion. */
  HOLD_POINT_OPEN: "HOLD_POINT_OPEN",
  /** verifyProcess: a mapped ComponentOperation/AssemblyStep has a non-CLOSED Ncr (Phase 5, N3). */
  NCR_OPEN: "NCR_OPEN",
  /** verifyComponentOperation / verifyAssemblyStep (AUD-026): an NCR opened against this work is still OPEN — it must be dispositioned before the rework that resolved it can be verified closed. */
  NCR_NOT_DISPOSITIONED: "NCR_NOT_DISPOSITIONED",
  /** verifyProcess: the stage's TemplateProcess.evidenceKind requires proof (packaged/dispatched/MDR compiled) that isn't recorded yet (Phase 5, D4). */
  EVIDENCE_NOT_SATISFIED: "EVIDENCE_NOT_SATISFIED",
  /** Department has an overdue process and owes a categorised delay reason. */
  REASON_REQUIRED: "REASON_REQUIRED",
  /** Caller lacks the role, or is outside their department scope. */
  FORBIDDEN: "FORBIDDEN",
  /** Not signed in, or the session expired. */
  UNAUTHENTICATED: "UNAUTHENTICATED",
  /** Client user reached for something outside their own client. */
  CLIENT_SCOPE_VIOLATION: "CLIENT_SCOPE_VIOLATION",
  /** Request failed zod validation. */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** Referenced entity does not exist (or is not visible to this caller). */
  NOT_FOUND: "NOT_FOUND",
  /** A schedule override or correction was attempted without a reason. */
  OVERRIDE_REASON_REQUIRED: "OVERRIDE_REASON_REQUIRED",
  /** Waiving a witness point needs Production Head approval. */
  WAIVER_NOT_APPROVED: "WAIVER_NOT_APPROVED",
  /** Scheduling was attempted against a process with no confirmed duration/envelope (provisional template). */
  SCHEDULE_DATA_MISSING: "SCHEDULE_DATA_MISSING",
  /** A process was asked to move to a state it cannot reach from its current one. */
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  /** The job's process graph is malformed (cycle, dangling edge) and cannot be scheduled. */
  SCHEDULE_GRAPH_INVALID: "SCHEDULE_GRAPH_INVALID",
  /** Actor tried to claim a plan outside their own department's pool. */
  NOT_IN_DEPARTMENT: "NOT_IN_DEPARTMENT",
  /** Plan is already claimed/assigned to someone. */
  ALREADY_ASSIGNED: "ALREADY_ASSIGNED",
  /** A COMPLETE plan cannot be claimed. */
  PLAN_COMPLETE: "PLAN_COMPLETE",
  /** The proposed assignee does not hold the plan's owning department. */
  ASSIGNEE_NOT_IN_DEPARTMENT: "ASSIGNEE_NOT_IN_DEPARTMENT",
  /** The proposed assignee's account is not active. */
  ASSIGNEE_INACTIVE: "ASSIGNEE_INACTIVE",
  /** changeOwnPassword: the supplied "current" password did not verify. */
  INVALID_CURRENT_PASSWORD: "INVALID_CURRENT_PASSWORD",
  /** Too many failed password-change attempts in the last 15 minutes. */
  RATE_LIMITED: "RATE_LIMITED",
  /** changeOwnPassword: "next" is identical to "current" — refuses to defeat the forced-change flow. */
  PASSWORD_UNCHANGED: "PASSWORD_UNCHANGED",
  /** The user still owes a forced password change and may not act until it is done. */
  MUST_CHANGE_PASSWORD: "MUST_CHANGE_PASSWORD",
  /** setUserActive: an admin tried to deactivate their own account. */
  CANNOT_SELF_DEACTIVATE: "CANNOT_SELF_DEACTIVATE",
  /** updateUserRolesDepts: an admin tried to remove their own ADMIN role. */
  CANNOT_SELF_DEMOTE: "CANNOT_SELF_DEMOTE",
  /** nudgeQc: this actor already nudged for this plan within the cooldown window. */
  NUDGE_COOLDOWN: "NUDGE_COOLDOWN",
  /** publishSnapshot: today's batch for this job is already VERIFIED and locked. */
  SNAPSHOT_ALREADY_VERIFIED: "SNAPSHOT_ALREADY_VERIFIED",
  /** verifySnapshot/rejectSnapshot: there is no PUBLISHED batch waiting for review. */
  SNAPSHOT_NOT_PUBLISHED: "SNAPSHOT_NOT_PUBLISHED",
  /** publishSnapshot: an earlier day's batch is still PUBLISHED (never verified/rejected). */
  SNAPSHOT_PRIOR_DAY_PENDING: "SNAPSHOT_PRIOR_DAY_PENDING",
  /** A job tried to pin a process route that is still a draft. */
  TEMPLATE_VERSION_NOT_PUBLISHED: "TEMPLATE_VERSION_NOT_PUBLISHED",
  /** createJob: this job number is already used in this tenant. */
  DUPLICATE_JOB_NUMBER: "DUPLICATE_JOB_NUMBER",
  /** An edit was attempted against a PUBLISHED template version (invariant #9). */
  TEMPLATE_VERSION_LOCKED: "TEMPLATE_VERSION_LOCKED",
  /** A template version is missing information required to publish it. */
  TEMPLATE_INCOMPLETE: "TEMPLATE_INCOMPLETE",
  /** The row changed under the caller since it was loaded; the write was refused. */
  STALE_WRITE: "STALE_WRITE",
  /** applyDurationOverride: job/equipment-grain override refused because the job already has units — it would write unitId:null plans that supersede the per-unit run and brick gating (audit H7). */
  OVERRIDE_NOT_SUPPORTED_WITH_UNITS: "OVERRIDE_NOT_SUPPORTED_WITH_UNITS",
  /** submitProcess: a mapped ComponentOperation or AssemblyStep on this (process, unit) is not yet COMPLETE (Phase 3, R2). */
  COMPONENT_OPS_INCOMPLETE: "COMPONENT_OPS_INCOMPLETE",
  /** explodeBomItem: a malformed parentBomItemId chain cycles back on itself — a defensive guard against a bad direct DB write, not a normal user-facing refusal. */
  BOM_CYCLE_DETECTED: "BOM_CYCLE_DETECTED",
  /** issueStock/scrapStock: this would drive the lot's available quantity below zero. */
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  /** startComponentOperation: the component's linked BomItem is recorded short (B7, Phase 4). */
  MATERIAL_NOT_AVAILABLE: "MATERIAL_NOT_AVAILABLE",
  /** startComponentOperation: a CUTTING op's governing drawing's current revision isn't RELEASED (B9, Phase 4). */
  DRAWING_NOT_RELEASED: "DRAWING_NOT_RELEASED",
  /** createDrawingRevision: revisionNo must be strictly greater than the drawing's current highest (B9, Phase 4). */
  DRAWING_REVISION_NOT_INCREASING: "DRAWING_REVISION_NOT_INCREASING",
  /** createAssemblyDrawing: the job already has a drawing with this number (JG1). */
  DRAWING_NUMBER_TAKEN: "DRAWING_NUMBER_TAKEN",
  /** createBomRevision: revisionNo must be strictly greater than the equipment's current highest (B4, Phase 4). */
  BOM_REVISION_NOT_INCREASING: "BOM_REVISION_NOT_INCREASING",
  /** createBomItem/updateBomItem: the chosen parentBomItemId is a descendant of the item being written — a normal user refusal, not malformed data (B4, Phase 4). */
  BOM_PARENT_WOULD_CYCLE: "BOM_PARENT_WOULD_CYCLE",
  /** verifyComponentOperation: a PAINTING op has no PaintRecord, or fewer accepted DftReadings than required (P1, Phase 5). */
  DFT_NOT_ACCEPTED: "DFT_NOT_ACCEPTED",
  /** addUnitToBatch: the unit has no packageId set — it must be packed before it can be added to a dispatch batch (D2, Phase 5). */
  UNIT_NOT_PACKED: "UNIT_NOT_PACKED",
  /** assignUnitToPackage: the unit and package belong to different jobs (D1, Phase 5). */
  CROSS_JOB_ASSIGNMENT: "CROSS_JOB_ASSIGNMENT",
  /** materialiseAssemblySteps (S17): an AssemblyTemplateStep's qcpSrNo has no corresponding QcpItem in the job's cloned QcpTemplate at the expected occurrence — refuses rather than leaving qcpItemId silently null. */
  QCP_ITEM_UNRESOLVED: "QCP_ITEM_UNRESOLVED",
  /** attachQcpTemplate (JG2): the job already has a QC plan; replacing one is not built. */
  QCP_ALREADY_ATTACHED: "QCP_ALREADY_ATTACHED",
  /** releaseBomRevision (J5a): a BOM line is mapped to a part family that is not approved, or to a route variant with no published version. */
  ROUTE_NOT_APPROVED: "ROUTE_NOT_APPROVED",
  /** releaseBomRevision (J5a): the preview has warnings and the caller did not acknowledge them. */
  BOM_RELEASE_WARNINGS_UNACKNOWLEDGED: "BOM_RELEASE_WARNINGS_UNACKNOWLEDGED",
  /** releaseBomRevision (J5a): a different revision of this line is already materialised; re-release by diff is J5c. */
  BOM_RELEASE_DIFF_NOT_BUILT: "BOM_RELEASE_DIFF_NOT_BUILT",
  /** releaseBomRevision / mapBomLines (J5a): the line already has components or assembly steps (made at job creation, or by this release). */
  BOM_ALREADY_MATERIALIZED: "BOM_ALREADY_MATERIALIZED",
  /** Floor writes (J5c): the step, operation or part was retired by a BOM re-release or a review; the write targets the active row instead. */
  FLOOR_ROW_RETIRED: "FLOOR_ROW_RETIRED",
  /** resolveReviewRow (J5c): Replace or Cancel is blocked while the row waits for QC (reason QC_PENDING) or has an open NCR (reason NCR_OPEN). */
  BOM_REVIEW_BLOCKED: "BOM_REVIEW_BLOCKED",
  /** acknowledgeOverride (D2): the Production Head has already acknowledged this early start. */
  OVERRIDE_ALREADY_ACKNOWLEDGED: "OVERRIDE_ALREADY_ACKNOWLEDGED",
  /** releaseDraft (J7a): the draft was already turned into a job (once only). */
  DRAFT_ALREADY_RELEASED: "DRAFT_ALREADY_RELEASED",
  /** saveDraft / releaseDraft (J7a): the draft was discarded. */
  DRAFT_DISCARDED: "DRAFT_DISCARDED",
  /** setJobStatus (S19): status COMPLETE was requested while a ProcessPlan on the job's current ScheduleRun is not yet COMPLETE. */
  JOB_HAS_INCOMPLETE_PLANS: "JOB_HAS_INCOMPLETE_PLANS",
  /** setOperationRefFamilySeq (C6): the given number is not among the family's own published TemplateProcess.seq values. */
  ROUTE_STEP_SEQ_UNKNOWN: "ROUTE_STEP_SEQ_UNKNOWN",
  /** approveDispatchRelease/recordDispatch (AUD-005): a unit was released or dispatched with production stages still incomplete. */
  UNIT_NOT_COMPLETE: "UNIT_NOT_COMPLETE",
  /** recordQcpExecution (AUD-003): NA was submitted for a checkpoint whose blocking code is not waivable — it can never be cleared this way. */
  QCP_CODE_NOT_WAIVABLE: "QCP_CODE_NOT_WAIVABLE",
  /** createJob (AUD-033): excludedProcessCodes named a TemplateProcess whose `optional` flag is false — only processes the template author marked optional can be dropped from a job's scope. */
  PROCESS_NOT_OPTIONAL: "PROCESS_NOT_OPTIONAL",
  /** createJob (AUD-033): excludedProcessCodes is non-empty but exclusionReason was not supplied — a permanent scope change needs a reason on record. */
  EXCLUSION_REASON_REQUIRED: "EXCLUSION_REASON_REQUIRED",
  /** checkFeasibility (AUD-035): requiredMinDays exceeds requiredMaxDays — the envelope data fed in is internally inconsistent (distinct from SCHEDULE_DATA_MISSING's "no envelope at all"). */
  SCHEDULE_ENVELOPE_INVALID: "SCHEDULE_ENVELOPE_INVALID",
  /** New-job wizard / date editor: a job needs the committed delivery date; without it no schedule can be built and the job has no planned dates. */
  DELIVERY_DATE_REQUIRED: "DELIVERY_DATE_REQUIRED",
  /** A Server Action belonging to a feature switched off in src/lib/shared/flags.ts (Lean Core §4 freeze list). */
  FEATURE_FROZEN: "FEATURE_FROZEN",
  /** Master data (M3): an APPROVED part family or grade was edited directly; it must be revised (with a reason) first. */
  REVISE_REQUIRED: "REVISE_REQUIRED",
  /** Master data (M3): approval refused; `detail.blockers` lists what is missing. */
  APPROVAL_BLOCKED: "APPROVAL_BLOCKED",
  /** Master data (M3): a master-data part family was changed through a legacy editor that bypasses approval. */
  USE_MASTER_DATA: "USE_MASTER_DATA",
  /** A database transaction ran out of time; nothing it did was saved. */
  TRANSACTION_TIMEOUT: "TRANSACTION_TIMEOUT",
  /** Lean Core L1.2: a process plan with mapped steps/operations takes its status from them (rollupProcessPlan); direct start/submit/verify is refused. */
  DERIVED_STATUS: "DERIVED_STATUS",
  /** L1.2 (D2 SOFT): an earlier step in the sequence is still open; starting early needs an override reason. `detail.canOverride` says whether this actor may give one. */
  SEQUENCE_OVERRIDE_REQUIRED: "SEQUENCE_OVERRIDE_REQUIRED",
  /** L1.2 (D4): the reported time is outside the allowed window. `detail.reason` is FUTURE | TOO_OLD | BEFORE_RELEASE | DONE_BEFORE_START. */
  REPORTED_AT_OUT_OF_WINDOW: "REPORTED_AT_OUT_OF_WINDOW",
  /** L1.2/L1.4: marking a late item Done needs a categorised late reason in the same action. */
  LATE_REASON_REQUIRED: "LATE_REASON_REQUIRED",
  /** J6: a lot Done would take the quantity past what was planned. `detail` has qtyPlanned, qtyDone, qty. */
  QTY_EXCEEDS_PLANNED: "QTY_EXCEEDS_PLANNED",
  /** L1.2: an INSPECTION step is recorded by QC through inspect, not by recordWork. */
  INSPECT_REQUIRED: "INSPECT_REQUIRED",
  /** L1.2 review: QC accepted an inspection whose preceding work steps (same group, same joint) are not done. */
  INSPECT_PRECONDITION: "INSPECT_PRECONDITION",
  /** D2 H1: fit-up → weld → NDT on the same joint, out of order. */
  JOINT_SEQUENCE_BLOCKED: "JOINT_SEQUENCE_BLOCKED",
  /** D2 H2: pressure-part cutting before the material is issued. */
  MATERIAL_NOT_ISSUED: "MATERIAL_NOT_ISSUED",
  /** D2 H2: pressure-part cutting before the heat number is picked. */
  HEAT_NUMBER_NOT_PICKED: "HEAT_NUMBER_NOT_PICKED",
  /** D2 H4: hydro before the unit's final PWHT is complete. */
  PWHT_NOT_COMPLETE: "PWHT_NOT_COMPLETE",
  /** D2 H6: hydro before every weld and NDT step on the unit's pressure joints is complete. */
  HYDRO_PREREQUISITES_INCOMPLETE: "HYDRO_PREREQUISITES_INCOMPLETE",
  /** D2 H5: welding on a pressure part after the unit's final PWHT; routed to an NCR. */
  WELD_AFTER_PWHT: "WELD_AFTER_PWHT",
  /** D2 H6: welding on a pressure part after hydro; routed to an NCR. */
  WELD_AFTER_HYDRO: "WELD_AFTER_HYDRO",
  /** Invariant 2 (always HARD): surface preparation (29) and painting (30) need hydro (27) complete. */
  PAINT_BEFORE_HYDRO: "PAINT_BEFORE_HYDRO",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Human-readable default for each code. Screens may override with specifics. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  GATING_BLOCKED:
    "This process cannot start yet — one or more predecessors are not complete.",
  MAKER_CHECKER_VIOLATION:
    "The same person cannot complete both steps of this two-person control. A different person must complete the second step.",
  HOLD_POINT_OPEN:
    "An inspection hold point on this item is still open. It must be cleared before completion.",
  NCR_OPEN:
    "An operation feeding this stage has an open non-conformance report. It must be closed before this stage can verify.",
  NCR_NOT_DISPOSITIONED:
    "A non-conformance report on this work is still open. QC must record a disposition (repair, rework, use-as-is, scrap, or concession) before this can be verified.",
  EVIDENCE_NOT_SATISFIED:
    "This stage requires evidence that hasn't been recorded yet. Complete the required action first, then verify.",
  REASON_REQUIRED:
    "This department has an overdue process on this unit. File a categorised delay reason to continue.",
  FORBIDDEN: "You do not have permission to do this.",
  UNAUTHENTICATED: "Please sign in.",
  CLIENT_SCOPE_VIOLATION: "This record belongs to a different client.",
  VALIDATION_FAILED: "Some of the values submitted are not valid.",
  NOT_FOUND: "That record does not exist, or you cannot see it.",
  OVERRIDE_REASON_REQUIRED: "Changing a planned date requires a reason, which is recorded.",
  WAIVER_NOT_APPROVED: "Waiving a witness point requires Production Head approval.",
  SCHEDULE_DATA_MISSING:
    "This process has no confirmed duration yet — it cannot be scheduled until DESPL provides one.",
  INVALID_STATE_TRANSITION: "This process cannot move to that state from its current one.",
  SCHEDULE_GRAPH_INVALID: "The process graph for this job is invalid and cannot be scheduled.",
  NOT_IN_DEPARTMENT: "You can only claim work belonging to your own department.",
  ALREADY_ASSIGNED: "This work is already claimed by someone.",
  PLAN_COMPLETE: "This work is already complete and cannot be claimed.",
  ASSIGNEE_NOT_IN_DEPARTMENT: "That person does not belong to this department.",
  ASSIGNEE_INACTIVE: "That person's account is not active.",
  INVALID_CURRENT_PASSWORD: "Your current password is incorrect.",
  RATE_LIMITED: "Too many attempts. Wait a few minutes and try again.",
  PASSWORD_UNCHANGED: "Your new password must be different from your current password.",
  MUST_CHANGE_PASSWORD: "Change your password before doing anything else.",
  CANNOT_SELF_DEACTIVATE: "You cannot deactivate your own account.",
  CANNOT_SELF_DEMOTE: "You cannot remove your own admin role.",
  NUDGE_COOLDOWN: "You already nudged QC for this within the last 30 minutes.",
  SNAPSHOT_ALREADY_VERIFIED:
    "Today's client update is already verified and locked. It cannot be republished.",
  SNAPSHOT_NOT_PUBLISHED:
    "There is no published update waiting for review right now.",
  SNAPSHOT_PRIOR_DAY_PENDING:
    "An earlier day's update is still awaiting Management review. It must be verified or rejected before a new one can be published.",
  TEMPLATE_VERSION_NOT_PUBLISHED:
    "That process route is still a draft and cannot be used for a job. Publish it first.",
  DUPLICATE_JOB_NUMBER: "A job with this number already exists.",
  TEMPLATE_VERSION_LOCKED:
    "This process route is published and cannot be changed. Create a new version to make edits.",
  TEMPLATE_INCOMPLETE:
    "This process route is missing information it needs before it can be published.",
  STALE_WRITE:
    "Someone else changed this while you were editing. Reload the page and reapply your changes.",
  OVERRIDE_NOT_SUPPORTED_WITH_UNITS:
    "This job already has per-unit schedules. A duration override at job level would replace them and cannot be applied here.",
  COMPONENT_OPS_INCOMPLETE:
    "One or more fabrication or assembly operations backing this process are not yet complete on this unit.",
  BOM_CYCLE_DETECTED: "This BOM item's parent chain is malformed (a cycle). Contact an administrator.",
  INSUFFICIENT_STOCK: "This would take the lot's available quantity below zero.",
  MATERIAL_NOT_AVAILABLE: "This part is recorded short. Resolve the shortage before starting this operation.",
  DRAWING_NOT_RELEASED: "This component's governing drawing is not released yet. Cutting cannot start until it is.",
  DRAWING_NUMBER_TAKEN: "This job already has a drawing with that number. Open it and issue a revision instead.",
  DRAWING_REVISION_NOT_INCREASING: "Revision numbers must increase. Enter a number higher than the drawing's current revision.",
  BOM_REVISION_NOT_INCREASING: "Revision numbers must increase. Enter a number higher than the equipment's current BOM revision.",
  BOM_PARENT_WOULD_CYCLE: "Can't set this parent: it would create a circular reference. Pick a different parent item.",
  DFT_NOT_ACCEPTED:
    "This painting operation needs an accepted DFT reading for every planned coat before it can verify.",
  UNIT_NOT_PACKED: "This unit has not been packed yet. Assign it to a package before adding it to a dispatch batch.",
  CROSS_JOB_ASSIGNMENT: "This unit and package belong to different jobs and cannot be linked.",
  QCP_ITEM_UNRESOLVED: "This QCP template does not cover the assembly checklist. Pick another QCP template.",
  QCP_ALREADY_ATTACHED: "This job already has a QC plan. Replacing it is not supported.",
  ROUTE_NOT_APPROVED:
    "A BOM line is mapped to a part family or route that is not approved yet. Ask the Production Head to approve it in master data, or map the line to another part family.",
  BOM_RELEASE_WARNINGS_UNACKNOWLEDGED: "This release has warnings. Read them, then confirm that you have checked them to release.",
  BOM_RELEASE_DIFF_NOT_BUILT:
    "This line's floor steps were already generated from another BOM revision. Releasing a later revision on top of them is not available yet.",
  BOM_ALREADY_MATERIALIZED:
    "This line already has components or assembly steps, so its BOM cannot be released again. Existing jobs are never changed by a release.",
  FLOOR_ROW_RETIRED:
    "This step was replaced or removed when the BOM changed, so it can no longer be worked. Refresh the screen to see the current steps.",
  BOM_REVIEW_BLOCKED:
    "This step cannot be replaced or cancelled yet: it is waiting for QC, or it has an open NCR. Finish that first, or keep the step as it is.",
  DRAFT_ALREADY_RELEASED: "This draft was already turned into a job. Open that job instead.",
  DRAFT_DISCARDED: "This draft was discarded. Copy a job or start a new one.",
  JOB_HAS_INCOMPLETE_PLANS: "This job cannot be marked complete — it still has incomplete process plans on its current schedule run.",
  ROUTE_STEP_SEQ_UNKNOWN:
    "This number does not match any process in the family's published route — check the template's process list.",
  UNIT_NOT_COMPLETE:
    "This unit still has incomplete process stages on its current schedule run. It cannot be released or dispatched until production is complete.",
  QCP_CODE_NOT_WAIVABLE:
    "This checkpoint's hold code cannot be waived — it must be inspected and marked accepted or rejected, not recorded as not applicable.",
  PROCESS_NOT_OPTIONAL:
    "This process is mandatory on this route and cannot be excluded from the job's scope.",
  EXCLUSION_REASON_REQUIRED:
    "Excluding a process from the job's scope requires a reason, which is recorded.",
  SCHEDULE_ENVELOPE_INVALID:
    "This job's envelope data is inconsistent (minimum duration exceeds maximum) and cannot be scheduled. Contact an administrator.",
  DELIVERY_DATE_REQUIRED:
    "Enter the committed delivery date, the date promised to the client. Without it the job cannot be scheduled.",
  OVERRIDE_ALREADY_ACKNOWLEDGED:
    "This early start has already been acknowledged.",
  FEATURE_FROZEN:
    "This feature is switched off while the pilot runs. Ask the Production Head if you need it; only the system administrator can switch it back on.",
  REVISE_REQUIRED:
    "This is approved. Revise it first, with a reason, to change it; the approved version stays in use until the revision is approved.",
  APPROVAL_BLOCKED:
    "This cannot be approved yet. Fix what is listed and try again.",
  USE_MASTER_DATA:
    "This is a master-data part family. Change it under Master data, where edits go through review and approval.",
  TRANSACTION_TIMEOUT: "That took too long, so nothing was saved. Try again; if it keeps happening, split the file.",
  DERIVED_STATUS:
    "This stage's status comes from its steps and operations. Record work on those instead; the stage updates itself.",
  SEQUENCE_OVERRIDE_REQUIRED:
    "An earlier step in the sequence is still open. A supervisor can start this early by choosing a reason.",
  REPORTED_AT_OUT_OF_WINDOW:
    "That time is not allowed: it is in the future, before the job was released, before the work started, or more than 72 working hours ago. An administrator can correct older entries.",
  QTY_EXCEEDS_PLANNED:
    "That quantity is more than what is left on this lot. Enter at most the quantity still to do.",
  LATE_REASON_REQUIRED:
    "This work is past its planned finish. Choose a late reason to mark it done.",
  INSPECT_REQUIRED:
    "This is an inspection step. QC records it by accepting or rejecting the inspection.",
  INSPECT_PRECONDITION:
    "The work this inspection checks is not done yet. Record the earlier work steps first, then inspect.",
  JOINT_SEQUENCE_BLOCKED:
    "An earlier step on this joint is not done yet. Fit-up comes before welding, and welding before NDT. Record the earlier step first.",
  MATERIAL_NOT_ISSUED:
    "Material for this pressure part has not been issued. Stores must issue it before cutting.",
  HEAT_NUMBER_NOT_PICKED:
    "No heat number is picked for this pressure part. Pick the heat it is cut from before cutting.",
  PWHT_NOT_COMPLETE:
    "Final PWHT on this unit is not complete. Hydro can start only after QC accepts the PWHT.",
  HYDRO_PREREQUISITES_INCOMPLETE:
    "Some welds or NDT on this unit's pressure joints are not complete. Finish and get them accepted by QC before hydro.",
  WELD_AFTER_PWHT:
    "Final PWHT on this unit has started, so welding on a pressure part is not allowed. QC must raise an NCR; repair needs PWHT repeated, or the Production Head can accept it per a code clause.",
  WELD_AFTER_HYDRO:
    "Hydro on this unit has started, so welding on a pressure part is not allowed. QC must raise an NCR; repair needs hydro repeated, or the Production Head can accept it per a code clause.",
  PAINT_BEFORE_HYDRO:
    "Hydro on this unit is not complete. Surface preparation and painting can start only after hydro is accepted.",
};

/** Short headings for refusals shown as a list (e.g. what blocks a dispatch); the full sentence is ERROR_MESSAGES. */
const ERROR_LABELS: Partial<Record<ErrorCode, string>> = {
  HOLD_POINT_OPEN: "Hold point not cleared",
  UNIT_NOT_COMPLETE: "Production not complete",
  NCR_OPEN: "Open NCR",
};

/** A plain-English heading for an error code; never the raw code. */
export function errorLabel(code: ErrorCode): string {
  const label = ERROR_LABELS[code] ?? code.replace(/_/g, " ").toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** D2: what an operator sees instead of SEQUENCE_OVERRIDE_REQUIRED's default, since they cannot override. */
export const SEQUENCE_OVERRIDE_OPERATOR_MESSAGE = "Ask your supervisor to start this early.";

/** REPORTED_AT_OUT_OF_WINDOW names its reason in `detail.reason`; say only the one that applies. */
const REPORTED_AT_REASON_MESSAGES: Record<string, string> = {
  FUTURE: "That time is in the future. Choose now or an earlier time.",
  TOO_OLD: `That time is more than ${BACKDATE_WINDOW_HOURS} working hours ago. An administrator can correct older entries.`,
  BEFORE_RELEASE: "That time is before the job was released to the floor. Choose a later time.",
  DONE_BEFORE_START: "Done cannot be earlier than when the work started. Choose a later time.",
};

/** The default message for a refusal: the code's sentence, or the specific one its detail selects. */
export function messageFor(code: ErrorCode, detail?: Record<string, unknown>): string {
  if (code === ERROR_CODES.REPORTED_AT_OUT_OF_WINDOW && typeof detail?.reason === "string") {
    return REPORTED_AT_REASON_MESSAGES[detail.reason] ?? ERROR_MESSAGES[code];
  }
  return ERROR_MESSAGES[code];
}

/**
 * A refusal the UI can explain. Throw this from the service layer — never a
 * bare Error — so the reason survives all the way to the screen.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  /** Extra context for the UI, e.g. which predecessors are incomplete. */
  readonly detail?: Record<string, unknown>;

  constructor(code: ErrorCode, detail?: Record<string, unknown>, message?: string) {
    super(message ?? messageFor(code, detail));
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
