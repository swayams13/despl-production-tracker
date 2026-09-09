import { NextResponse } from "next/server";
import { requireActor, assertNotClientUser, type Actor } from "@/lib/authz";
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
  NCR_OPEN: 409,
  NCR_NOT_DISPOSITIONED: 409,
  EVIDENCE_NOT_SATISFIED: 409,
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
  TEMPLATE_VERSION_NOT_PUBLISHED: 409,
  DUPLICATE_JOB_NUMBER: 409,
  TEMPLATE_VERSION_LOCKED: 409,
  TEMPLATE_INCOMPLETE: 409,
  STALE_WRITE: 409,
  OVERRIDE_NOT_SUPPORTED_WITH_UNITS: 409,
  COMPONENT_OPS_INCOMPLETE: 409,
  // Malformed DB data (bad direct write), not a normal client refusal —
  // explodeBomItem's (read-side) defensive throw against a chain that's
  // already broken in the DB. createBomItem/updateBomItem's write-time
  // cycle guard throws BOM_PARENT_WOULD_CYCLE instead, a normal 409 refusal.
  BOM_CYCLE_DETECTED: 500,
  BOM_PARENT_WOULD_CYCLE: 409,
  INSUFFICIENT_STOCK: 409,
  MATERIAL_NOT_AVAILABLE: 409,
  DRAWING_NOT_RELEASED: 409,
  DRAWING_REVISION_NOT_INCREASING: 409,
  BOM_REVISION_NOT_INCREASING: 409,
  DFT_NOT_ACCEPTED: 409,
  UNIT_NOT_PACKED: 409,
  CROSS_JOB_ASSIGNMENT: 409,
  QCP_ITEM_UNRESOLVED: 500,
  JOB_HAS_INCOMPLETE_PLANS: 409,
  ROUTE_STEP_SEQ_UNKNOWN: 409,
  UNIT_NOT_COMPLETE: 409,
  QCP_CODE_NOT_WAIVABLE: 409,
  PROCESS_NOT_OPTIONAL: 409,
  EXCLUSION_REASON_REQUIRED: 409,
  SCHEDULE_ENVELOPE_INVALID: 409,
};

/** Next 15 route-handler context; params is a Promise. */
export type RouteCtx = { params: Promise<Record<string, string>> };

/**
 * Wrap a route handler: resolve the actor, run it, JSON the result. AppError
 * refusals become their mapped status + a UI-safe message + stable code;
 * anything unexpected is a 500 with no internals leaked. The handler receives
 * the actor, the request, and the resolved route params.
 *
 * Client users are blocked here by DEFAULT (audit H3): the schema's own
 * comment says a `User` with a non-null `clientId` may only ever see
 * ProgressSnapshot data, never live tables — but every `/api` route was a
 * bare `route(handler)` with no such check, so a client user could `curl`
 * internal delay-reason history, submitter identities and the raw
 * domain-event stream directly. No route under `src/app/api/` is currently
 * client-facing (the portal reads via server components, not this surface),
 * so there is no opt-in list yet — pass `{ allowClient: true }` the day one
 * is added, rather than defaulting new routes open again.
 */
export function route<T>(
  fn: (actor: Actor, req: Request, params: Record<string, string>) => Promise<T>,
  opts: { allowClient?: boolean } = {},
) {
  return async (req: Request, ctx: RouteCtx): Promise<NextResponse> => {
    // Stamped by middleware.ts on every request; a request that somehow
    // bypasses it (a direct route-handler unit test) still gets an id here
    // rather than logging as untraceable.
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    try {
      const actor = await requireActor();
      if (!opts.allowClient) assertNotClientUser(actor);
      const params = await ctx.params;
      const res = NextResponse.json(await fn(actor, req, params));
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (e) {
      if (isAppError(e)) {
        const status = STATUS[e.code] ?? 500;
        // Refusals are expected product behavior (CLAUDE.md invariant #12) —
        // info, not error — but still worth a request-id-correlated line so a
        // support conversation ("it refused me") is greppable.
        console.info("[api] refused", { requestId, code: e.code, status });
        return NextResponse.json(
          { error: { code: e.code, message: ERROR_MESSAGES[e.code] ?? "Request failed." } },
          { status, headers: { "x-request-id": requestId } },
        );
      }
      console.error("[api] unhandled", { requestId, error: e });
      return NextResponse.json(
        { error: { code: "INTERNAL", message: "Something went wrong." } },
        { status: 500, headers: { "x-request-id": requestId } },
      );
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
