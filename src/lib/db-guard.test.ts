import { describe, expect, it } from "vitest";
import { assertDbRole, assertDbRoleSafe, type DbRoleInfo } from "@/lib/db-guard";

const safe: DbRoleInfo = {
  currentUser: "despl_web",
  isSuperuser: false,
  canUpdateAuditLog: false,
  canDeleteAuditLog: false,
  canUpdateDomainEvents: false,
  canDeleteDomainEvents: false,
};

describe("assertDbRoleSafe", () => {
  it("passes for a non-superuser role with no audit_log/domain_events write access", () => {
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

  it("throws when the role can UPDATE or DELETE domain_events", () => {
    expect(() => assertDbRoleSafe({ ...safe, canUpdateDomainEvents: true })).toThrow(
      /UPDATE domain_events/,
    );
    expect(() => assertDbRoleSafe({ ...safe, canDeleteDomainEvents: true })).toThrow(
      /DELETE domain_events/,
    );
  });

  it("names the connected role in the error message", () => {
    expect(() => assertDbRoleSafe({ ...safe, currentUser: "postgres", isSuperuser: true })).toThrow(
      /"postgres"/,
    );
  });
});

/** Minimal fake of the Prisma client surface assertDbRole touches. */
function fakeClient(row: Record<string, unknown>) {
  return { $queryRaw: async () => [row] } as unknown as Parameters<typeof assertDbRole>[0];
}

describe("assertDbRole (raw-row parsing)", () => {
  it("does not throw when is_superuser is the string 'off' and all privileges are false", async () => {
    await expect(
      assertDbRole(
        fakeClient({
          current_user: "despl_web",
          is_superuser: "off",
          can_update_audit_log: false,
          can_delete_audit_log: false,
          can_update_domain_events: false,
          can_delete_domain_events: false,
        }),
      ),
    ).resolves.not.toThrow();
  });

  it("throws when is_superuser is the string 'on' — guards against Boolean(row.is_superuser) or an inverted comparison", async () => {
    await expect(
      assertDbRole(
        fakeClient({
          current_user: "postgres",
          is_superuser: "on",
          can_update_audit_log: false,
          can_delete_audit_log: false,
          can_update_domain_events: false,
          can_delete_domain_events: false,
        }),
      ),
    ).rejects.toThrow(/superuser/);
  });

  it("throws when a has_table_privilege flag comes back true", async () => {
    await expect(
      assertDbRole(
        fakeClient({
          current_user: "despl_web",
          is_superuser: "off",
          can_update_audit_log: true,
          can_delete_audit_log: false,
          can_update_domain_events: false,
          can_delete_domain_events: false,
        }),
      ),
    ).rejects.toThrow(/UPDATE audit_log/);
  });
});
