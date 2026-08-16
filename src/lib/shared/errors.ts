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
