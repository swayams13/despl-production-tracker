import { describe, expect, it } from "vitest";
import { assertDbRoleSafe, type DbRoleInfo } from "@/lib/db-guard";

const safe: DbRoleInfo = {
  currentUser: "despl_web",
  isSuperuser: false,
  canUpdateAuditLog: false,
  canDeleteAuditLog: false,
};

describe("assertDbRoleSafe", () => {
  it("passes for a non-superuser role with no audit_log write access", () => {
    expect(() => assertDbRoleSafe(safe)).not.toThrow();
  });

  it("throws when the role is a superuser", () => {
    expect(() => assertDbRoleSafe({ ...safe, currentUser: "postgres", isSuperuser: true })).toThrow(
      /superuser/,
    );
  });

  it("throws when the role can UPDATE audit_log", () => {
    expect(() => assertDbRoleSafe({ ...safe, canUpdateAuditLog: true })).toThrow(
      /UPDATE audit_log/,
    );
  });

  it("throws when the role can DELETE audit_log", () => {
    expect(() => assertDbRoleSafe({ ...safe, canDeleteAuditLog: true })).toThrow(
      /DELETE audit_log/,
    );
  });

  it("names the connected role in the error message", () => {
    expect(() => assertDbRoleSafe({ ...safe, currentUser: "postgres", isSuperuser: true })).toThrow(
      /"postgres"/,
    );
  });
});
