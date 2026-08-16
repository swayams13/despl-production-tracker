import { withTenant } from "@/lib/db";
import { readSession } from "@/lib/auth/session";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

export const ROLES = {
  ADMIN: "ADMIN",
  MANAGEMENT: "MANAGEMENT",
  PRODUCTION_HEAD: "PRODUCTION_HEAD",
  SUPERVISOR: "SUPERVISOR",
  QC: "QC",
  CLIENT_VIEWER: "CLIENT_VIEWER",
} as const;

export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

export interface Actor {
  userId: number;
  tenantId: number;
  /** Non-null => external client user, scoped to this client. */
  clientId: number | null;
  name: string;
  email: string;
  roles: RoleCode[];
  /** Department ids a supervisor may act on. Empty for non-supervisors. */
  departmentIds: number[];
  /** True until the user completes the first-login password change. */
  mustChangePassword: boolean;
}

/**
 * Resolve the current actor from the session cookie.
 *
 * Roles and department scopes are read from the database on every call rather
 * than trusted from the token, so a revoked role or a department reassignment
 * takes effect on the next request.
 */
export async function getActor(): Promise<Actor | null> {
  const session = await readSession();
  if (!session) return null;

  return withTenant(session.tenantId, async (tx) => {
    const user = await tx.user.findFirst({
      where: { id: session.userId, active: true },
      include: { roles: { include: { role: true } }, departments: true },
    });
    if (!user) return null;
    // A stale token: `changeOwnPassword` bumped `User.sessionVersion` since
    // this token was issued, either by this device's own password change
    // (whose cookie was immediately re-issued with the new version) or by
    // invalidating every OTHER previously-issued session. Same effect as
    // "user not found" — no separate error code needed.
    if (session.sessionVersion !== user.sessionVersion) return null;

    return {
      userId: user.id,
      tenantId: user.tenantId,
      clientId: user.clientId,
      name: user.name,
      email: user.email,
      roles: user.roles.map((r) => r.role.code as RoleCode),
      departmentIds: user.departments.map((d) => d.departmentId),
      mustChangePassword: user.mustChangePassword,
    };
  });
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
  return actor;
}

export function hasRole(actor: Actor, ...roles: RoleCode[]): boolean {
  return actor.roles.some((r) => roles.includes(r));
}

/**
 * Deny by default: callers must name the roles allowed. There is no implicit
 * "admin can do anything" fallback — ADMIN must be listed where it applies,
 * and notably it is NOT accepted for verification (see assertMakerChecker).
 */
export function requireRole(actor: Actor, ...roles: RoleCode[]): void {
  if (!hasRole(actor, ...roles)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, { required: roles, held: actor.roles });
  }
}

/**
 * Supervisors may only act on their own department's work (BUILD-SPEC §3,
 * PRD FR-S3). Production Head and Admin are not department-scoped.
 */
export function requireDepartmentScope(actor: Actor, departmentId: number): void {
  if (hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD)) return;
  if (!actor.departmentIds.includes(departmentId)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, {
      reason: "outside department scope",
      departmentId,
      scopedTo: actor.departmentIds,
    });
  }
}

/** An external client user may only ever reach their own client's records. */
export function assertClientScope(actor: Actor, clientId: number): void {
  if (actor.clientId !== null && actor.clientId !== clientId) {
    throw new AppError(ERROR_CODES.CLIENT_SCOPE_VIOLATION);
  }
}

/** Client users are read-only, everywhere, with no exceptions. */
export function assertNotClientUser(actor: Actor): void {
  if (actor.clientId !== null) {
    throw new AppError(ERROR_CODES.FORBIDDEN, { reason: "client users are read-only" });
  }
}

/**
 * Maker–checker (CLAUDE.md invariant #3, PRD FR-S6).
 *
 * The same human can never submit and verify. Verification needs the QC role.
 * This holds for admins too — that is the point of the rule, so ADMIN is
 * deliberately absent from the role check below.
 */
export function assertMakerChecker(actor: Actor, submittedBy: number | null): void {
  requireRole(actor, ROLES.QC);
  if (submittedBy !== null && submittedBy === actor.userId) {
    throw new AppError(ERROR_CODES.MAKER_CHECKER_VIOLATION, { submittedBy });
  }
}
