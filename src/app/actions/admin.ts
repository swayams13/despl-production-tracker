"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import {
  createUser,
  resetUserPassword,
  createDelayCategory,
  updateDelayCategory,
  updateStandardDurations,
  createEmployee,
  setUserActive,
  updateUserRolesDepts,
  bulkImportEmployees,
  type BulkImportEmployeeResult,
} from "@/lib/services/admin.service";
import { toActionError, type ActionResult } from "./_action";
import type { CreateUserInput, CreateEmployeeInput, UpdateUserRolesDeptsInput } from "@/lib/shared/schemas";

export async function createUserAction(input: CreateUserInput): Promise<ActionResult> {
  try {
    await createUser(await requireActor(), input);
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function resetPasswordAction(userId: number, password: string): Promise<ActionResult> {
  try {
    // tempPassword deliberately dropped here: this action wraps the
    // ADMIN-CHOSEN-password path from the existing /admin table UI, which
    // already has the plaintext in `password`. Task 4.2 wires the
    // generate-if-omitted path (and the credential-slip hand-off) through a
    // new action of its own.
    await resetUserPassword(await requireActor(), { userId, password });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export type CreateEmployeeResult = ActionResult & {
  userId?: number;
  username?: string;
  tempPassword?: string;
  effectiveEmail?: string;
};

/** Task 4.2: the Add-employee dialog's submit — SPEC §7.3. */
export async function createEmployeeAction(input: CreateEmployeeInput): Promise<CreateEmployeeResult> {
  try {
    const created = await createEmployee(await requireActor(), input);
    revalidatePath("/admin");
    return { ok: true, ...created };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Task 4.2: the Employees table's "Reset password" row action — always
 * generates a temp password (the admin never types one here), returned once
 * for the same credential-hand-off screen `createEmployeeAction` uses.
 * Distinct from `resetPasswordAction` above, which still serves the
 * admin-chooses-the-password path.
 */
export async function generateResetPasswordAction(userId: number): Promise<ActionResult & { tempPassword?: string }> {
  try {
    const { tempPassword } = await resetUserPassword(await requireActor(), { userId });
    revalidatePath("/admin");
    return { ok: true, tempPassword };
  } catch (e) {
    return toActionError(e);
  }
}

export async function setUserActiveAction(userId: number, active: boolean): Promise<ActionResult> {
  try {
    await setUserActive(await requireActor(), { userId, active });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateUserRolesDeptsAction(input: UpdateUserRolesDeptsInput): Promise<ActionResult> {
  try {
    await updateUserRolesDepts(await requireActor(), input);
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/** Task 4.2: bulk CSV import — SPEC §7.3. Rows are already-parsed objects; CSV parsing is a UI concern (`_client.tsx`). */
export async function bulkImportEmployeesAction(
  rows: unknown[],
): Promise<ActionResult & { results?: BulkImportEmployeeResult[] }> {
  try {
    const results = await bulkImportEmployees(await requireActor(), rows);
    revalidatePath("/admin");
    return { ok: true, results };
  } catch (e) {
    return toActionError(e);
  }
}

export async function createDelayCategoryAction(name: string): Promise<ActionResult> {
  try {
    await createDelayCategory(await requireActor(), { name });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function toggleDelayCategoryAction(id: number, active: boolean): Promise<ActionResult> {
  try {
    await updateDelayCategory(await requireActor(), { id, active });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function updateStandardDurationsAction(
  templateVersionId: number,
  edits: { templateProcessId: number; durationMinDays: number; durationMaxDays: number }[],
  reason: string,
): Promise<ActionResult> {
  try {
    await updateStandardDurations(await requireActor(), { templateVersionId, edits, reason });
    revalidatePath("/admin");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
