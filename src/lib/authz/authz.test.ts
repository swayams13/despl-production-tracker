import { describe, expect, it } from "vitest";
import {
  ROLES,
  hasRole,
  requireRole,
  requireDepartmentScope,
  assertClientScope,
  assertNotClientUser,
  assertMakerChecker,
  type Actor,
  type RoleCode,
} from "./index";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * Violation tests for the authorization primitives (CLAUDE.md: "any change to
 * the state machine, gating, RBAC, or audit paths requires table-driven tests
 * for the violation cases, not just happy paths").
 *
 * These functions are the last line before a mutation, so each one is tested
 * for what it REFUSES, not only what it allows.
 */

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "Test User",
    email: "t@despl.local",
    roles: [ROLES.SUPERVISOR],
    departmentIds: [10],
    mustChangePassword: false,
    ...over,
  };
}

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : "NOT_AN_APP_ERROR";
  }
}

describe("requireRole — deny by default", () => {
  const cases: { name: string; held: RoleCode[]; allowed: RoleCode[]; expected: string | null }[] = [
    { name: "exact role held", held: [ROLES.QC], allowed: [ROLES.QC], expected: null },
    { name: "one of several held", held: [ROLES.SUPERVISOR], allowed: [ROLES.QC, ROLES.SUPERVISOR], expected: null },
    { name: "role not held", held: [ROLES.SUPERVISOR], allowed: [ROLES.QC], expected: ERROR_CODES.FORBIDDEN },
    { name: "no roles at all", held: [], allowed: [ROLES.QC], expected: ERROR_CODES.FORBIDDEN },
    {
      name: "admin is NOT an implicit superuser",
      held: [ROLES.ADMIN],
      allowed: [ROLES.QC],
      expected: ERROR_CODES.FORBIDDEN,
    },
  ];

  it.each(cases)("$name", ({ held, allowed, expected }) => {
    expect(codeOf(() => requireRole(actor({ roles: held }), ...allowed))).toBe(expected);
  });
});

describe("requireDepartmentScope — supervisors are confined to their departments", () => {
  it("allows a supervisor inside their own department", () => {
    expect(codeOf(() => requireDepartmentScope(actor({ departmentIds: [10] }), 10))).toBeNull();
  });

  it("refuses a supervisor reaching into another department", () => {
    expect(codeOf(() => requireDepartmentScope(actor({ departmentIds: [10] }), 11))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("refuses a supervisor with no department assigned", () => {
    expect(codeOf(() => requireDepartmentScope(actor({ departmentIds: [] }), 10))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it.each([ROLES.PRODUCTION_HEAD, ROLES.ADMIN])("%s is not department-scoped", (role) => {
    expect(
      codeOf(() => requireDepartmentScope(actor({ roles: [role], departmentIds: [] }), 99)),
    ).toBeNull();
  });
});

describe("assertMakerChecker — the same human never submits and verifies", () => {
  it("allows a different QC user to verify", () => {
    expect(codeOf(() => assertMakerChecker(actor({ userId: 2, roles: [ROLES.QC] }), 1))).toBeNull();
  });

  it("refuses the submitter verifying their own entry", () => {
    expect(codeOf(() => assertMakerChecker(actor({ userId: 1, roles: [ROLES.QC] }), 1))).toBe(
      ERROR_CODES.MAKER_CHECKER_VIOLATION,
    );
  });

  it("refuses a non-QC user, even a Production Head", () => {
    expect(codeOf(() => assertMakerChecker(actor({ userId: 2, roles: [ROLES.PRODUCTION_HEAD] }), 1))).toBe(
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("refuses an admin verifying their own submission — no exceptions", () => {
    expect(
      codeOf(() => assertMakerChecker(actor({ userId: 1, roles: [ROLES.ADMIN, ROLES.QC] }), 1)),
    ).toBe(ERROR_CODES.MAKER_CHECKER_VIOLATION);
  });

  it("allows verification when nothing has been submitted yet", () => {
    expect(codeOf(() => assertMakerChecker(actor({ userId: 1, roles: [ROLES.QC] }), null))).toBeNull();
  });
});

describe("client scoping — the external boundary", () => {
  it("lets an internal user reach any client", () => {
    expect(codeOf(() => assertClientScope(actor({ clientId: null }), 42))).toBeNull();
  });

  it("lets a client user reach their own client", () => {
    expect(codeOf(() => assertClientScope(actor({ clientId: 7 }), 7))).toBeNull();
  });

  it("refuses a client user reaching another client", () => {
    expect(codeOf(() => assertClientScope(actor({ clientId: 7 }), 8))).toBe(
      ERROR_CODES.CLIENT_SCOPE_VIOLATION,
    );
  });

  it("refuses any write by a client user", () => {
    expect(codeOf(() => assertNotClientUser(actor({ clientId: 7 })))).toBe(ERROR_CODES.FORBIDDEN);
  });

  it("allows writes by internal users", () => {
    expect(codeOf(() => assertNotClientUser(actor({ clientId: null })))).toBeNull();
  });
});

describe("hasRole", () => {
  it("is false when the actor holds none of the listed roles", () => {
    expect(hasRole(actor({ roles: [ROLES.SUPERVISOR] }), ROLES.QC, ROLES.ADMIN)).toBe(false);
  });

  it("is true when the actor holds any listed role", () => {
    expect(hasRole(actor({ roles: [ROLES.SUPERVISOR, ROLES.QC] }), ROLES.QC)).toBe(true);
  });
});
