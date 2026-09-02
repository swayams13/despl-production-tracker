import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * Shared (from → to) transition-matrix check for every entity in this app
 * with a status state machine (`ProcessPlan` via `process.service.ts`'s
 * `assertTransition`, `ComponentOperation` via `component.service.ts`'s
 * `assertComponentOpTransition`, and `AssemblyStep` in Phase 2 — see
 * PHASE-PROMPTS.md §2 F8). Both existing call sites kept their own wrapper
 * name/signature; only the duplicated matrix-lookup-and-throw body moved
 * here, so no caller elsewhere in the codebase needed to change.
 */
export function assertStateTransition<Status extends string, Action extends string>(
  transitions: Record<Action, { from: Status[]; to: Status }>,
  action: Action,
  from: Status,
  entityName: string,
): Status {
  const t = transitions[action];
  if (!t.from.includes(from)) {
    throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, {
      entity: entityName,
      action,
      from,
      allowedFrom: t.from,
      to: t.to,
    });
  }
  return t.to;
}
