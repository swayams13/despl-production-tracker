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
  /** setJobStatus (S19): status COMPLETE was requested while a ProcessPlan on the job's current ScheduleRun is not yet COMPLETE. */
  JOB_HAS_INCOMPLETE_PLANS: "JOB_HAS_INCOMPLETE_PLANS",
  /** setOperationRefFamilySeq (C6): the given number is not among the family's own published TemplateProcess.seq values. */
  ROUTE_STEP_SEQ_UNKNOWN: "ROUTE_STEP_SEQ_UNKNOWN",
  /** approveDispatchRelease/recordDispatch (AUD-005): a unit was released or dispatched with production stages still incomplete. */
  UNIT_NOT_COMPLETE: "UNIT_NOT_COMPLETE",
  /** recordQcpExecution (AUD-003): NA was submitted for a checkpoint whose blocking code is not waivable — it can never be cleared this way. */
  QCP_CODE_NOT_WAIVABLE: "QCP_CODE_NOT_WAIVABLE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Human-readable default for each code. Screens may override with specifics. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  GATING_BLOCKED:
    "This process cannot start yet — one or more predecessors are not complete.",
  MAKER_CHECKER_VIOLATION:
    "The person who submitted an entry cannot also verify it. A different QC user must verify.",
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
  DRAWING_REVISION_NOT_INCREASING: "Revision numbers must increase. Enter a number higher than the drawing's current revision.",
  BOM_REVISION_NOT_INCREASING: "Revision numbers must increase. Enter a number higher than the equipment's current BOM revision.",
  BOM_PARENT_WOULD_CYCLE: "Can't set this parent: it would create a circular reference. Pick a different parent item.",
  DFT_NOT_ACCEPTED:
    "This painting operation needs an accepted DFT reading for every planned coat before it can verify.",
  UNIT_NOT_PACKED: "This unit has not been packed yet. Assign it to a package before adding it to a dispatch batch.",
  CROSS_JOB_ASSIGNMENT: "This unit and package belong to different jobs and cannot be linked.",
  QCP_ITEM_UNRESOLVED: "An assembly checkpoint could not be matched to a QCP item. Contact an administrator.",
  JOB_HAS_INCOMPLETE_PLANS: "This job cannot be marked complete — it still has incomplete process plans on its current schedule run.",
  ROUTE_STEP_SEQ_UNKNOWN:
    "This number does not match any process in the family's published route — check the template's process list.",
  UNIT_NOT_COMPLETE:
    "This unit still has incomplete process stages on its current schedule run. It cannot be released or dispatched until production is complete.",
  QCP_CODE_NOT_WAIVABLE:
    "This checkpoint's hold code cannot be waived — it must be inspected and marked accepted or rejected, not recorded as not applicable.",
};

/**
 * A refusal the UI can explain. Throw this from the service layer — never a
 * bare Error — so the reason survives all the way to the screen.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  /** Extra context for the UI, e.g. which predecessors are incomplete. */
  readonly detail?: Record<string, unknown>;

  constructor(code: ErrorCode, detail?: Record<string, unknown>, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
