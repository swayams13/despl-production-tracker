import { isAppError, ERROR_MESSAGES, type ErrorCode } from "@/lib/shared/errors";

export type ActionResult = { ok: true } | { ok: false; code: ErrorCode; message: string };

/** Map an AppError to a UI-safe result; rethrow anything unexpected (→ 500). */
export function toActionError(e: unknown): ActionResult {
  if (isAppError(e)) {
    const code = e.code;
    return { ok: false, code, message: ERROR_MESSAGES[code] ?? "This action could not be completed." };
  }
  throw e;
}
