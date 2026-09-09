"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import {
  createUser,
  resetUserPassword,
  approvePasswordReset,
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

/**
 * AUD-079: resetting a QC/ADMIN target no longer resets anything here — it
 * only records a request a DIFFERENT admin must approve. `pending: true`
 * tells the caller to show "reset requested, awaiting a second admin's
 * approval" instead of assuming the admin-chosen `password` above took
 * effect.
 */
export async function resetPasswordAction(
  userId: number,
  password: string,
): Promise<ActionResult & { pending?: boolean }> {
  try {
    // tempPassword deliberately dropped here: this action wraps the
    // ADMIN-CHOSEN-password path from the existing /admin table UI, which
    // already has the plaintext in `password`. Task 4.2 wires the
    // generate-if-omitted path (and the credential-slip hand-off) through a
    // new action of its own.
    const result = await resetUserPassword(await requireActor(), { userId, password });
    revalidatePath("/admin");
    return { ok: true, pending: "pending" in result ? result.pending : false };
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
 *
 * AUD-079: for a QC/ADMIN target, `resetUserPassword` no longer returns a
 * password at all — it returns `{ pending: true, requestId }`. This action
 * passes that straight through so the UI can show "awaiting a second
 * admin's approval" instead of a credential slip with nothing on it.
 */
export async function generateResetPasswordAction(
  userId: number,
): Promise<ActionResult & { tempPassword?: string; pending?: boolean; requestId?: number }> {
  try {
    const result = await resetUserPassword(await requireActor(), { userId });
    revalidatePath("/admin");
    if ("pending" in result && result.pending) {
      return { ok: true, pending: true, requestId: result.requestId };
    }
    return { ok: true, tempPassword: result.tempPassword };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * AUD-079: completes a pending password reset request. Must be called by a
 * DIFFERENT admin than the one who requested it — enforced in
 * `approvePasswordReset` itself (MAKER_CHECKER_VIOLATION otherwise).
 */
export async function approvePasswordResetAction(
  requestId: number,
): Promise<ActionResult & { tempPassword?: string }> {
  try {
    const { tempPassword } = await approvePasswordReset(await requireActor(), { requestId });
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
