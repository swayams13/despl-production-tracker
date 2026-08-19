import { NextResponse } from "next/server";
import { requireActor, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES, isAppError, ERROR_MESSAGES, type ErrorCode } from "@/lib/shared/errors";

/** Error code → HTTP status. Refusals stay explainable (CLAUDE.md invariant #12). */
const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CLIENT_SCOPE_VIOLATION: 403,
  // Authenticated, but not permitted to act until the forced change is done.
  MUST_CHANGE_PASSWORD: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  GATING_BLOCKED: 409,
  MAKER_CHECKER_VIOLATION: 409,
  HOLD_POINT_OPEN: 409,
  REASON_REQUIRED: 409,
  INVALID_STATE_TRANSITION: 409,
  OVERRIDE_REASON_REQUIRED: 409,
  WAIVER_NOT_APPROVED: 409,
  SCHEDULE_DATA_MISSING: 409,
  SCHEDULE_GRAPH_INVALID: 409,
  NOT_IN_DEPARTMENT: 409,
  ALREADY_ASSIGNED: 409,
  PLAN_COMPLETE: 409,
  ASSIGNEE_NOT_IN_DEPARTMENT: 409,
  ASSIGNEE_INACTIVE: 409,
  INVALID_CURRENT_PASSWORD: 409,
  RATE_LIMITED: 429,
  PASSWORD_UNCHANGED: 409,
  CANNOT_SELF_DEACTIVATE: 409,
  CANNOT_SELF_DEMOTE: 409,
  NUDGE_COOLDOWN: 429,
  SNAPSHOT_ALREADY_VERIFIED: 409,
  SNAPSHOT_NOT_PUBLISHED: 409,
  SNAPSHOT_PRIOR_DAY_PENDING: 409,
};

/** Next 15 route-handler context; params is a Promise. */
export type RouteCtx = { params: Promise<Record<string, string>> };

/**
 * Wrap a route handler: resolve the actor, run it, JSON the result. AppError
 * refusals become their mapped status + a UI-safe message + stable code;
 * anything unexpected is a 500 with no internals leaked. The handler receives
 * the actor, the request, and the resolved route params.
 */
export function route<T>(
  fn: (actor: Actor, req: Request, params: Record<string, string>) => Promise<T>,
) {
  return async (req: Request, ctx: RouteCtx): Promise<NextResponse> => {
    try {
      const actor = await requireActor();
      const params = await ctx.params;
      return NextResponse.json(await fn(actor, req, params));
    } catch (e) {
      if (isAppError(e)) {
        const status = STATUS[e.code] ?? 500;
        return NextResponse.json(
          { error: { code: e.code, message: ERROR_MESSAGES[e.code] ?? "Request failed." } },
          { status },
        );
      }
      console.error("[api] unhandled", e);
      return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong." } }, { status: 500 });
    }
  };
}

/** Parse a positive-int route/query param, or throw NOT_FOUND for garbage. */
export function intParam(v: string | undefined | null): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    // A non-numeric id can never match a row — 404 is the honest answer.
    throw new AppError(ERROR_CODES.NOT_FOUND);
  }
  return n;
}
