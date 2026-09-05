import { randomInt } from "node:crypto";
import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { requireRole, assertNotClientUser, hasRole, ROLES, type Actor, type RoleCode } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { hashPassword } from "@/lib/auth/password";
import { validateSpecs } from "@/lib/shared/specs";
import {
  createUserSchema,
  resetPasswordSchema,
  createDelayCategorySchema,
  updateDelayCategorySchema,
  updateStandardDurationsSchema,
  createEmployeeSchema,
  setUserActiveSchema,
  updateUserRolesDeptsSchema,
  createEquipmentTypeSchema,
  updateEquipmentTypeSchema,
  createClientSchema,
  createProductFamilySchema,
  type CreateUserInput,
  type ResetPasswordInput,
  type CreateDelayCategoryInput,
  type UpdateDelayCategoryInput,
  type UpdateStandardDurationsInput,
  type CreateEmployeeInput,
  type SetUserActiveInput,
  type UpdateUserRolesDeptsInput,
  type CreateEquipmentTypeInput,
  type UpdateEquipmentTypeInput,
  type CreateClientInput,
  type CreateProductFamilyInput,
} from "@/lib/shared/schemas";
import type { User, DelayCategoryRef, ProcessTemplateVersion, EquipmentTypeRef, Client, ProductFamily } from "@/generated/prisma/client";
import { copyVersionContents } from "./template-copy";

/**
 * §4.10 Admin — "minimal but real": users, master delay-reason list,
 * standard-durations table editor. Every mutation here is ADMIN-only
 * (management may view the page but performs no actions, per the Demo
 * Readiness checklist's "management sees zero action buttons anywhere") and
 * none of it is exempt from invariant #5 (append-only audit).
 */

/**
 * Word list for generated temp passwords — small and boring on purpose
 * (personal dashboards v1, Task 4.1 / SPEC §5.2 "3 random words + 2 digits").
 * `node:crypto`'s `randomInt` is a CSPRNG; `Math.random()` is explicitly
 * banned for anything credential-shaped.
 */
const TEMP_PASSWORD_WORDS = [
  "anchor", "bridge", "cactus", "copper", "desert", "ember", "engine", "falcon",
  "forest", "granite", "harbor", "island", "jungle", "kettle", "lantern", "meadow",
  "nectar", "oyster", "pepper", "quartz", "ribbon", "summit", "tanker", "timber",
  "umbrella", "valley", "willow", "yonder", "zephyr", "boiler", "rocket", "signal",
] as const;

/** e.g. "granite-falcon-summit-07". Crypto-random, never `Math.random()`. */
function generateTempPassword(): string {
  const words = Array.from({ length: 3 }, () => TEMP_PASSWORD_WORDS[randomInt(TEMP_PASSWORD_WORDS.length)]);
  const digits = String(randomInt(100)).padStart(2, "0");
  return `${words.join("-")}-${digits}`;
}

export async function createUser(actor: Actor, input: CreateUserInput): Promise<User> {
  const { name, email, roleCodes, departmentIds, password, mustChangePassword } = createUserSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const existing = await tx.user.findFirst({ where: { tenantId: actor.tenantId, email } });
    if (existing) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { email }, "A user with this email already exists.");
    }
    // D13 collision guard (fix round 3, 17 Aug 2026): login() resolves an
    // identifier via OR: [{email}, {username}] — createEmployee's `username`
    // has no format constraint, so an admin can give someone an email-shaped
    // username (e.g. "alice@vendor.com"). Without this check, a LATER
    // createUser({email: "alice@vendor.com"}) would pass its own two checks
    // above/below (no other row has that email; "alice" doesn't collide) and
    // create a second row that identifier resolves to ambiguously at login.
    const emailCollidesWithUsername = await tx.user.findFirst({
      where: { tenantId: actor.tenantId, username: email },
    });
    if (emailCollidesWithUsername) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { email },
        "This email matches another account's username.",
      );
    }
    // username is derived from the email local-part (see comment below) and
    // is @@unique([tenantId, username]) at the DB level; two different email
    // domains can share a local-part (bob@gmail.com, bob@yahoo.com), so this
    // needs its own pre-check rather than relying on the email check above.
    const username = email.split("@")[0];
    const existingUsername = await tx.user.findFirst({ where: { tenantId: actor.tenantId, username } });
    if (existingUsername) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { username },
        "A user with this username already exists.",
      );
    }
    const roles = await tx.role.findMany({ where: { tenantId: actor.tenantId, code: { in: roleCodes } } });
    if (roles.length !== roleCodes.length) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { roleCodes }, "One or more roles are invalid.");
    }
    if (departmentIds.length) {
      const depts = await tx.department.count({ where: { tenantId: actor.tenantId, id: { in: departmentIds } } });
      if (depts !== departmentIds.length) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { departmentIds }, "One or more departments are invalid.");
      }
    }

    const passwordHash = await hashPassword(password);

    return audited(tx, actor, async () => {
      const user = await tx.user.create({
        data: {
          tenantId: actor.tenantId,
          name,
          email,
          // ponytail: derived from email local-part, matching the migration's
          // backfill rule. Task 1.3 (password-change flow) is the one that
          // needs a real username-entry UX; this just keeps rows valid.
          username,
          passwordHash,
          mustChangePassword,
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
          departments: { create: departmentIds.map((departmentId) => ({ departmentId })) },
        },
      });
      return {
        result: user,
        audit: {
          action: "admin.createUser",
          entityType: "User",
          entityId: user.id,
          after: { name, email, roleCodes, departmentIds },
          eventType: "UserCreated",
          eventPayload: { userId: user.id, email, roleCodes },
        },
      };
    });
  });
}

/**
 * Reset a user's password. `password` lets an admin set a specific one;
 * omitted, a readable temp password is generated the same way `createEmployee`
 * does. Either way the plaintext is returned ONCE — SPEC §9: never persisted,
 * never logged, never in the audit payload — and the caller is responsible
 * for handing it to the employee (print slip / CSV) and discarding it.
 */
export async function resetUserPassword(
  actor: Actor,
  input: ResetPasswordInput,
): Promise<{ tempPassword: string }> {
  const { userId, password } = resetPasswordSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);
  const tempPassword = password ?? generateTempPassword();

  return withTenant(actor.tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, tenantId: actor.tenantId } });
    if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "User", userId });

    const passwordHash = await hashPassword(tempPassword);
    await audited(tx, actor, async () => {
      // An admin-chosen (or generated) password is a temp credential the
      // admin knows: bump sessionVersion so every session issued before the
      // reset stops resolving (getActor compares it), and set
      // mustChangePassword so the user has to replace it on next login.
      // Without both, an admin reset — the path most likely to be undoing a
      // COMPROMISED credential — leaves the old sessions live and the
      // admin-known password permanent.
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, sessionVersion: { increment: 1 }, mustChangePassword: true },
      });
      return {
        result: undefined,
        audit: {
          action: "admin.resetPassword",
          entityType: "User",
          entityId: userId,
          // No before/after, no tempPassword: the only fields that changed
          // are password material and its two locks — nothing safe or useful
          // to diff, and the plaintext must never reach the audit trail.
          eventType: "UserPasswordReset",
          eventPayload: { userId },
        },
      };
    });
    return { tempPassword };
  });
}

export async function createDelayCategory(actor: Actor, input: CreateDelayCategoryInput): Promise<DelayCategoryRef> {
  const { name } = createDelayCategorySchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  const code = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  return withTenant(actor.tenantId, async (tx) => {
    const existing = await tx.delayCategoryRef.findFirst({ where: { tenantId: actor.tenantId, code } });
    if (existing) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { code }, "A delay reason with this name already exists.");
    }
    return audited(tx, actor, async () => {
      const cat = await tx.delayCategoryRef.create({ data: { tenantId: actor.tenantId, code, name } });
      return {
        result: cat,
        audit: {
          action: "admin.createDelayCategory",
          entityType: "DelayCategoryRef",
          entityId: cat.id,
          after: { code, name },
          eventType: "DelayCategoryCreated",
          eventPayload: { delayCategoryId: cat.id, name },
        },
      };
    });
  });
}

export async function updateDelayCategory(actor: Actor, input: UpdateDelayCategoryInput): Promise<DelayCategoryRef> {
  const { id, name, active } = updateDelayCategorySchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const cat = await tx.delayCategoryRef.findFirst({ where: { id, tenantId: actor.tenantId } });
    if (!cat) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "DelayCategoryRef", id });

    return audited(tx, actor, async () => {
      const updated = await tx.delayCategoryRef.update({
        where: { id },
        data: { name: name ?? cat.name, active: active ?? cat.active },
      });
      return {
        result: updated,
        audit: {
          action: "admin.updateDelayCategory",
          entityType: "DelayCategoryRef",
          entityId: id,
          before: { name: cat.name, active: cat.active },
          after: { name: updated.name, active: updated.active },
          eventType: "DelayCategoryUpdated",
          eventPayload: { delayCategoryId: id },
        },
      };
    });
  });
}

/**
 * Invariant #9: a template edit creates a NEW ProcessTemplateVersion — copy
 * every process + edge from the source version, apply the batch of duration
 * edits to the copies, publish the new version. The source version (and
 * every Job already pinned to it via Job.templateVersionId) is untouched.
 */
export async function updateStandardDurations(
  actor: Actor,
  input: UpdateStandardDurationsInput,
): Promise<ProcessTemplateVersion> {
  const { templateVersionId, edits, reason } = updateStandardDurationsSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const source = await tx.processTemplateVersion.findFirst({
      where: { id: templateVersionId, template: { tenantId: actor.tenantId } },
      include: { processes: true, edges: true },
    });
    if (!source) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessTemplateVersion", templateVersionId });

    const sourceProcessIds = new Set(source.processes.map((p) => p.id));
    for (const e of edits) {
      if (!sourceProcessIds.has(e.templateProcessId)) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "TemplateProcess", id: e.templateProcessId });
      }
    }

    const maxVersion = await tx.processTemplateVersion.aggregate({
      _max: { version: true },
      where: { templateId: source.templateId },
    });
    const nextVersion = (maxVersion._max.version ?? 0) + 1;

    return audited(tx, actor, async () => {
      const created = await tx.processTemplateVersion.create({
        data: {
          templateId: source.templateId,
          version: nextVersion,
          status: "PUBLISHED",
          publishedAt: new Date(),
          publishedBy: actor.userId,
          notes: reason,
        },
      });

      const overrides = new Map(
        edits.map((e) => [
          e.templateProcessId,
          {
            durationMinDays: e.durationMinDays,
            durationMaxDays: e.durationMaxDays,
            // An explicit duration edit is a confirmation: it clears
            // `provisional`, matching the behaviour this function has always
            // had. Processes with no edit keep whatever they had.
            provisional: false,
          },
        ]),
      );
      await copyVersionContents(tx, source.id, created.id, overrides);

      return {
        result: created,
        audit: {
          action: "admin.updateStandardDurations",
          entityType: "ProcessTemplateVersion",
          entityId: created.id,
          before: { sourceVersionId: source.id },
          after: { version: nextVersion, editCount: edits.length, reason },
          eventType: "StandardDurationsUpdated",
          eventPayload: { templateId: source.templateId, newVersionId: created.id, editCount: edits.length },
        },
      };
    });
  });
}

/**
 * SPEC §5.2: create an employee account — a NEW creation path, deliberately
 * NOT routed through `createUser` (Task 4.1 ruling: materially different
 * contract — optional generated password, explicit username/employeeCode —
 * kept as two distinct exported functions).
 *
 * `User.email` stayed NOT NULL at the DB level (Task 1.1's deliberate call).
 * When the caller omits it, a placeholder derived from the already-unique
 * `username` is stored so the row satisfies the column — it is never treated
 * as a deliverable address anywhere downstream.
 */
export async function createEmployee(
  actor: Actor,
  input: CreateEmployeeInput,
): Promise<{ userId: number; username: string; tempPassword: string; effectiveEmail: string }> {
  const {
    displayName,
    username,
    email,
    employeeCode,
    roles: roleCodes,
    departmentIds,
    password,
  } = createEmployeeSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  // Generated outside the transaction: it is never written anywhere except
  // the hash below and the one-time return value — never logged, never in
  // the audit payload (SPEC §9).
  const tempPassword = password ?? generateTempPassword();
  const effectiveEmail = email ?? `${username}@no-email.despl.local`;

  return withTenant(actor.tenantId, async (tx) => {
    const existingUsername = await tx.user.findFirst({ where: { tenantId: actor.tenantId, username } });
    if (existingUsername) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { username }, "A user with this username already exists.");
    }
    // D13 collision guard (fix round 2, 17 Aug 2026): login() resolves an
    // identifier via `OR: [{email}, {username}]` with no ordering — username
    // and email each carry their OWN per-tenant unique constraint, not a
    // joint one, so nothing else stops a new username from equaling a
    // DIFFERENT existing user's email (or vice versa below), which would make
    // that identifier resolve to an unspecified one of two accounts at login.
    const usernameCollidesWithEmail = await tx.user.findFirst({
      where: { tenantId: actor.tenantId, email: username },
    });
    if (usernameCollidesWithEmail) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { username },
        "This username matches another account's email address.",
      );
    }
    // Only pre-check a caller-supplied email — a synthesized placeholder is
    // already unique because `username` was just checked above.
    if (email) {
      const existingEmail = await tx.user.findFirst({ where: { tenantId: actor.tenantId, email } });
      if (existingEmail) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { email }, "A user with this email already exists.");
      }
    }
    // Symmetric collision guard — checked against effectiveEmail (not just a
    // caller-supplied one) so the synthesized placeholder is covered too,
    // even though a `@no-email.despl.local` placeholder colliding with a real
    // username is very unlikely; the check is cheap either way.
    const emailCollidesWithUsername = await tx.user.findFirst({
      where: { tenantId: actor.tenantId, username: effectiveEmail },
    });
    if (emailCollidesWithUsername) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { email: effectiveEmail },
        "This email matches another account's username.",
      );
    }
    if (employeeCode) {
      const existingCode = await tx.user.findFirst({ where: { tenantId: actor.tenantId, employeeCode } });
      if (existingCode) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          { employeeCode },
          "A user with this employee code already exists.",
        );
      }
    }
    const roles = await tx.role.findMany({ where: { tenantId: actor.tenantId, code: { in: roleCodes } } });
    if (roles.length !== roleCodes.length) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { roleCodes }, "One or more roles are invalid.");
    }
    if (departmentIds.length) {
      const depts = await tx.department.count({ where: { tenantId: actor.tenantId, id: { in: departmentIds } } });
      if (depts !== departmentIds.length) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { departmentIds }, "One or more departments are invalid.");
      }
    }

    const passwordHash = await hashPassword(tempPassword);

    return audited(tx, actor, async () => {
      const user = await tx.user.create({
        data: {
          tenantId: actor.tenantId,
          name: displayName,
          email: effectiveEmail,
          username,
          employeeCode,
          passwordHash,
          // Explicit, not just relying on the schema default — this exact
          // field was skipped once before in this codebase's history and had
          // to be backfilled by a migration (Phase 1).
          mustChangePassword: true,
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
          departments: { create: departmentIds.map((departmentId) => ({ departmentId })) },
        },
      });
      return {
        result: { userId: user.id, username: user.username, tempPassword, effectiveEmail },
        audit: {
          action: "admin.createEmployee",
          entityType: "User",
          entityId: user.id,
          // No password material in the audit payload (SPEC §9).
          after: {
            displayName,
            username,
            email: email ?? null,
            employeeCode: employeeCode ?? null,
            roleCodes,
            departmentIds,
          },
          // Distinct from createUser's "UserCreated": this is a genuinely
          // different creation path (generated credentials, explicit
          // username/employeeCode), worth telling apart in the event stream.
          eventType: "EmployeeCreated",
          eventPayload: { userId: user.id, username, roleCodes },
        },
      };
    });
  });
}

/**
 * Activate/deactivate an account (invariant #6: never delete). Deactivating
 * invalidates every live session (same sessionVersion-bump pattern as
 * `resetUserPassword`) but deliberately does NOT touch the person's assigned
 * plans — SPEC §5.2 / C29 default: no auto-release, the UI surfaces an
 * "assigned to inactive user" warning chip instead (Task 4.2's job).
 */
export async function setUserActive(actor: Actor, input: SetUserActiveInput): Promise<User> {
  const { userId, active } = setUserActiveSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  // Pure guard, no DB needed: an admin can never lock themselves out.
  if (actor.userId === userId && !active) {
    throw new AppError(ERROR_CODES.CANNOT_SELF_DEACTIVATE);
  }

  return withTenant(actor.tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, tenantId: actor.tenantId } });
    if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "User", userId });

    return audited(tx, actor, async () => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: active ? { active } : { active, sessionVersion: { increment: 1 } },
      });
      return {
        result: updated,
        audit: {
          action: "admin.setUserActive",
          entityType: "User",
          entityId: userId,
          before: { active: user.active },
          after: { active: updated.active },
          eventType: active ? "UserActivated" : "UserDeactivated",
          eventPayload: { userId, active },
        },
      };
    });
  });
}

/**
 * Replace a user's roles/departments wholesale, audited with a full
 * before→after diff (role codes / department ids, not opaque row counts).
 */
export async function updateUserRolesDepts(actor: Actor, input: UpdateUserRolesDeptsInput): Promise<User> {
  const { userId, roles: roleCodes, departmentIds } = updateUserRolesDeptsSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  // Pure guard, no DB needed: an admin can never strip their OWN admin role.
  // Checked against the actor's own (freshly per-request-resolved, see
  // requireActor()) roles — the actor object cannot be stale within one call.
  if (actor.userId === userId && hasRole(actor, ROLES.ADMIN) && !roleCodes.includes(ROLES.ADMIN)) {
    throw new AppError(ERROR_CODES.CANNOT_SELF_DEMOTE);
  }

  return withTenant(actor.tenantId, async (tx) => {
    const user = await tx.user.findFirst({
      where: { id: userId, tenantId: actor.tenantId },
      include: { roles: { include: { role: true } }, departments: true },
    });
    if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "User", userId });

    const roles = await tx.role.findMany({ where: { tenantId: actor.tenantId, code: { in: roleCodes } } });
    if (roles.length !== roleCodes.length) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { roleCodes }, "One or more roles are invalid.");
    }
    if (departmentIds.length) {
      const depts = await tx.department.count({ where: { tenantId: actor.tenantId, id: { in: departmentIds } } });
      if (depts !== departmentIds.length) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { departmentIds }, "One or more departments are invalid.");
      }
    }

    const beforeRoleCodes = user.roles.map((r) => r.role.code as RoleCode).sort();
    const beforeDepartmentIds = user.departments.map((d) => d.departmentId).sort((a, b) => a - b);
    const afterRoleCodes = [...roleCodes].sort();
    const afterDepartmentIds = [...departmentIds].sort((a, b) => a - b);

    return audited(tx, actor, async () => {
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userDepartment.deleteMany({ where: { userId } });
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
          departments: { create: departmentIds.map((departmentId) => ({ departmentId })) },
        },
      });
      return {
        result: updated,
        audit: {
          action: "admin.updateUserRolesDepts",
          entityType: "User",
          entityId: userId,
          before: { roleCodes: beforeRoleCodes, departmentIds: beforeDepartmentIds },
          after: { roleCodes: afterRoleCodes, departmentIds: afterDepartmentIds },
          eventType: "UserRolesDeptsUpdated",
          eventPayload: { userId, roleCodes: afterRoleCodes, departmentIds: afterDepartmentIds },
        },
      };
    });
  });
}

export type BulkImportEmployeeResult =
  | { ok: true; userId: number; username: string; tempPassword: string; effectiveEmail: string }
  | { ok: false; row: unknown; error: string };

/**
 * Strip password-shaped keys before a row is echoed back in a failure
 * report. The documented CSV columns never include these, so this is
 * defensive (a stray `password` field on a malformed row must never ride
 * along in a report a UI might display or log), not a fix for an active path.
 */
function omitPasswordFields(row: unknown): unknown {
  if (typeof row !== "object" || row === null) return row;
  const { password: _password, tempPassword: _tempPassword, ...rest } = row as Record<string, unknown>;
  return rest;
}

/**
 * SPEC §5.2: load employees from already-parsed CSV rows (CSV parsing itself
 * is Task 4.2's UI concern — this takes structured objects). Each row is its
 * own `createEmployee` call in its own transaction, never one batch
 * transaction, so a bad row can never roll back the good rows ahead of it.
 */
export async function bulkImportEmployees(actor: Actor, rows: unknown[]): Promise<BulkImportEmployeeResult[]> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  const results: BulkImportEmployeeResult[] = [];
  for (const row of rows) {
    const parsed = createEmployeeSchema.safeParse(row);
    if (!parsed.success) {
      results.push({
        ok: false,
        row: omitPasswordFields(row),
        error: parsed.error.issues.map((i) => i.message).join("; "),
      });
      continue;
    }
    try {
      const created = await createEmployee(actor, parsed.data);
      results.push({ ok: true, ...created });
    } catch (e) {
      results.push({
        ok: false,
        row: omitPasswordFields(row),
        error: e instanceof AppError ? e.message : "Could not create this employee.",
      });
    }
  }
  return results;
}

/**
 * Equipment catalog CRUD. Mirrors createDelayCategory/updateDelayCategory
 * exactly — same role gate, same audited shape, same deactivate-never-delete
 * rule (invariant #6): Equipment rows reference these, so a delete would
 * orphan real job data.
 *
 * PRODUCTION_HEAD is allowed here alongside ADMIN, unlike the delay-category
 * pair: the catalog is production's own vocabulary, not a system setting.
 */
/**
 * C1 (route-authoring bootstrap): the one write path missing before this —
 * ProductFamily rows could only come from prisma/seed.ts. Code is immutable
 * once created (no updateProductFamily exists) — templates, routes and
 * QcpTemplates all reference it by value, not id alone, so renaming the code
 * out from under them would be a silent data-integrity break.
 */
export async function createProductFamily(
  actor: Actor,
  input: CreateProductFamilyInput,
): Promise<ProductFamily> {
  const { code, name } = createProductFamilySchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const existing = await tx.productFamily.findFirst({
      where: { tenantId: actor.tenantId, code },
    });
    if (existing) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { code },
        "A product family with this code already exists.",
      );
    }

    return audited(tx, actor, async () => {
      const row = await tx.productFamily.create({
        data: { tenantId: actor.tenantId, code, name },
      });
      return {
        result: row,
        audit: {
          action: "admin.createProductFamily",
          entityType: "ProductFamily",
          entityId: row.id,
          after: { code, name },
          eventType: "ProductFamilyCreated",
          eventPayload: { familyId: row.id, code },
        },
      };
    });
  });
}

export async function createEquipmentType(
  actor: Actor,
  input: CreateEquipmentTypeInput,
): Promise<EquipmentTypeRef> {
  const { familyId, code, name, defaultDesignCode, defaultSpecs } =
    createEquipmentTypeSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const family = await tx.productFamily.findFirst({
      where: { id: familyId, tenantId: actor.tenantId },
    });
    if (!family) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProductFamily", familyId });

    const existing = await tx.equipmentTypeRef.findFirst({
      where: { tenantId: actor.tenantId, code },
    });
    if (existing) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        { code },
        "An equipment type with this code already exists.",
      );
    }

    // Defaults are filtered through the family's own field map, so the catalog
    // cannot seed a job with a key no form will ever show.
    const specs = defaultSpecs ? validateSpecs(family.code, defaultSpecs) : null;

    return audited(tx, actor, async () => {
      const row = await tx.equipmentTypeRef.create({
        data: {
          tenantId: actor.tenantId,
          familyId,
          code,
          name,
          defaultDesignCode,
          defaultSpecs: specs === null ? undefined : (specs as never),
        },
      });
      return {
        result: row,
        audit: {
          action: "admin.createEquipmentType",
          entityType: "EquipmentTypeRef",
          entityId: row.id,
          after: { code, name, familyId, defaultDesignCode, defaultSpecs: specs },
          eventType: "EquipmentTypeCreated",
          eventPayload: { equipmentTypeId: row.id, code, familyId },
        },
      };
    });
  });
}

export async function updateEquipmentType(
  actor: Actor,
  input: UpdateEquipmentTypeInput,
): Promise<EquipmentTypeRef> {
  const parsed = updateEquipmentTypeSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    const row = await tx.equipmentTypeRef.findFirst({
      where: { id: parsed.id, tenantId: actor.tenantId },
      include: { family: true },
    });
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "EquipmentTypeRef", id: parsed.id });

    const specs =
      parsed.defaultSpecs === undefined
        ? undefined
        : parsed.defaultSpecs === null
          ? null
          : validateSpecs(row.family.code, parsed.defaultSpecs);

    return audited(tx, actor, async () => {
      const updated = await tx.equipmentTypeRef.update({
        where: { id: parsed.id },
        data: {
          name: parsed.name,
          defaultDesignCode: parsed.defaultDesignCode,
          active: parsed.active,
          ...(specs === undefined ? {} : { defaultSpecs: specs as never }),
        },
      });
      return {
        result: updated,
        audit: {
          action: "admin.updateEquipmentType",
          entityType: "EquipmentTypeRef",
          entityId: updated.id,
          before: {
            name: row.name,
            defaultDesignCode: row.defaultDesignCode,
            active: row.active,
            defaultSpecs: row.defaultSpecs,
          },
          after: {
            name: updated.name,
            defaultDesignCode: updated.defaultDesignCode,
            active: updated.active,
            defaultSpecs: updated.defaultSpecs,
          },
          eventType: "EquipmentTypeUpdated",
          eventPayload: { equipmentTypeId: updated.id },
        },
      };
    });
  });
}

/**
 * Inline client creation from the intake wizard.
 *
 * Named createClientRecord, not createClient: this file already exports
 * createUser/createEmployee for *people*, and a bare `createClient` in a
 * codebase full of "client user" language reads as the wrong thing.
 */
export async function createClientRecord(actor: Actor, input: CreateClientInput): Promise<Client> {
  const { name, code } = createClientSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);

  return withTenant(actor.tenantId, async (tx) => {
    if (code) {
      const existing = await tx.client.findFirst({ where: { tenantId: actor.tenantId, code } });
      if (existing) {
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          { code },
          "A client with this code already exists.",
        );
      }
    }
    return audited(tx, actor, async () => {
      const client = await tx.client.create({ data: { tenantId: actor.tenantId, name, code } });
      return {
        result: client,
        audit: {
          action: "admin.createClient",
          entityType: "Client",
          entityId: client.id,
          after: { name, code },
          eventType: "ClientCreated",
          eventPayload: { clientId: client.id, name },
        },
      };
    });
  });
}
