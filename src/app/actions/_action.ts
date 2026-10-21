import { ZodError } from "zod";
import { headers } from "next/headers";
import { readSession } from "@/lib/auth/session";
import { isAppError, ERROR_CODES, messageFor, type ErrorCode } from "@/lib/shared/errors";

/**
 * `detail` is the refusal's UI-safe context (which blockers, which step). For
 * FORBIDDEN / UNAUTHENTICATED, whose detail names roles, only a plain-English
 * `reason` is forwarded.
 */
export type ActionResult =
  | { ok: true }
  | { ok: false; code: ErrorCode; message: string; detail?: Record<string, unknown> };

/**
 * Every duplicate guard in this codebase is check-then-insert (`findFirst`,
 * then `create`) against a real unique index, so every one of them has a
 * losing-race path. Without this table that race surfaces as a bare P2002 —
 * an unexplained 500 with no error code for the UI to explain (invariant #12).
 *
 * Keyed by Prisma `meta.modelName` alone, NOT by the fields that collided.
 * That is forced by the database, not a shortcut: on an RLS-protected table
 * Postgres withholds the constraint detail from `despl_web` (a non-owner role
 * that cannot see the conflicting row), so Prisma reports
 * `{"modelName":"Job","target":null}` and the message "Unique constraint
 * failed on the (not available)". Verified against despl_test — `jobs`,
 * `users`, `clients` and `welders` (all in the RLS table list in migration
 * 20260813051500) every one report `target: null`, while `drawing_revisions`,
 * `template_processes` and `qcp_executions` (no RLS) report snake_case column
 * names. A field-keyed table silently degrades to the fallback on exactly the
 * four models that matter most.
 *
 * Anything not listed falls back to STALE_WRITE: for a losing race "someone
 * else changed this, reload and reapply" is exactly right, and for a duplicate
 * nobody guarded it is imprecise but never misleading — far better than a 500.
 * The model and (when the DB discloses it) the target are always in the log
 * line either way.
 *
 * Cost of model-grain: a model with two unique constraints gets one code for
 * both. Only `Job` is affected — a `publicId` collision would say "a job with
 * this number already exists". Generated-id collisions are vanishingly rare
 * and the user's response (retry) is the right one either way. Every other
 * mapped model has exactly one constraint, or three that all map to
 * VALIDATION_FAILED anyway (User).
 *
 * Deliberately absent: every constraint on Component / ComponentOperation /
 * AssemblyStep / Package / DispatchBatch, which have no producer in src/ at
 * all (Gate 1/2).
 */
const UNIQUE_VIOLATION: Record<string, ErrorCode> = {
  // job-intake.service.ts — findFirst on (tenantId, jobNumber) then create
  job: ERROR_CODES.DUPLICATE_JOB_NUMBER,
  // admin.service.ts createUser — three pre-checks, all VALIDATION_FAILED
  user: ERROR_CODES.VALIDATION_FAILED,
  // welder.service.ts createWelder
  welder: ERROR_CODES.VALIDATION_FAILED,
  // admin.service.ts createClient
  client: ERROR_CODES.VALIDATION_FAILED,
  // drawing.service.ts — "revision must increase" check then create
  drawingrevision: ERROR_CODES.DRAWING_REVISION_NOT_INCREASING,
  // bom.service.ts — same shape
  bomrevision: ERROR_CODES.BOM_REVISION_NOT_INCREASING,
  // template.service.ts — duplicate process code inside one draft version
  templateprocess: ERROR_CODES.TEMPLATE_INCOMPLETE,
};

type UniqueViolation = { model: string; target: string[] | null; code: ErrorCode };

function asUniqueViolation(e: unknown): UniqueViolation | null {
  if (typeof e !== "object" || e === null) return null;
  const { code, meta } = e as { code?: unknown; meta?: { modelName?: unknown; target?: unknown } };
  if (code !== "P2002") return null;

  const model = typeof meta?.modelName === "string" ? meta.modelName : "";
  // Logged, never keyed on — null whenever RLS hides it (see above).
  const target = Array.isArray(meta?.target)
    ? (meta.target as unknown[]).map(String)
    : typeof meta?.target === "string"
      ? [meta.target]
      : null;

  return { model, target, code: UNIQUE_VIOLATION[model.toLowerCase()] ?? ERROR_CODES.STALE_WRITE };
}

/**
 * One structured line per refusal and per unexpected error, correlated by the
 * `x-request-id` middleware.ts stamps on every request. Same shape as
 * api/_lib.ts so an incident can be traced across /api and Server Actions with
 * a single grep.
 *
 * ponytail: fire-and-forget, because `toActionError` must stay synchronous —
 * `headers()` and `readSession()` are async in Next 15, and process.ts's
 * startBulkAction consumes the result synchronously. The async closure is
 * invoked synchronously, so it captures the request's AsyncLocalStorage scope.
 *
 * ponytail: `actionId` is Next's `next-action` header — a stable hash per
 * action, not a readable name. A readable name would mean threading a literal
 * through all 20 action modules; hash + path ("which action, which screen") is
 * enough to trace and costs no diff outside this file.
 */
function log(level: "info" | "error", tag: string, payload: Record<string, unknown>): void {
  void (async () => {
    try {
      const h = await headers();
      const session = await readSession();
      const referer = h.get("referer");
      console[level](tag, {
        requestId: h.get("x-request-id") ?? null,
        actionId: h.get("next-action") ?? null,
        path: referer ? new URL(referer).pathname : null,
        userId: session?.userId ?? null,
        tenantId: session?.tenantId ?? null,
        ...payload,
      });
    } catch {
      // Logging never changes what the user sees. A dropped line is a smaller
      // failure than an action that fails because its log line failed.
    }
  })();
}

function result(code: ErrorCode, detail?: Record<string, unknown>): ActionResult {
  const base = { ok: false as const, code, message: messageFor(code, detail) ?? "This action could not be completed." };
  return detail ? { ...base, detail } : base;
}

const NO_DETAIL: ReadonlySet<ErrorCode> = new Set([ERROR_CODES.FORBIDDEN, ERROR_CODES.UNAUTHENTICATED]);

/** Map an AppError to a UI-safe result; rethrow anything unexpected (→ 500). */
export function toActionError(e: unknown): ActionResult {
  if (isAppError(e)) {
    // Refusals are expected product behavior (invariant #12) — info, not error.
    log("info", "[action] refused", { code: e.code, detail: e.detail });
    if (NO_DETAIL.has(e.code)) {
      // Their detail names roles. A plain-English `reason` is safe and is what tells
      // the person why ("only the Production Head approves master data").
      const reason = typeof e.detail?.reason === "string" ? e.detail.reason : undefined;
      return result(e.code, reason ? { reason } : undefined);
    }
    return result(e.code, e.detail);
  }

  // Prisma's interactive-transaction timeout: everything in it was rolled back.
  if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2028") {
    log("error", "[action] transaction timeout", { error: e instanceof Error ? e.message : String(e) });
    return result(ERROR_CODES.TRANSACTION_TIMEOUT);
  }

  // A schema.parse() that failed inside a service: the caller sent something
  // malformed. That is a refusal with reasons, not a 500.
  if (e instanceof ZodError) {
    const issues = e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    log("info", "[action] refused", { code: ERROR_CODES.VALIDATION_FAILED, issues });
    return result(ERROR_CODES.VALIDATION_FAILED, { issues });
  }

  const dup = asUniqueViolation(e);
  if (dup) {
    // Not a refusal: a guard lost a race, or a constraint has no guard at all.
    // Worth an error-level line naming the constraint even though the user
    // gets a clean, explainable message.
    log("error", "[action] unique-violation", { code: dup.code, model: dup.model, target: dup.target });
    return result(dup.code);
  }

  log("error", "[action] unhandled", { error: e instanceof Error ? e.stack : String(e) });
  throw e;
}
