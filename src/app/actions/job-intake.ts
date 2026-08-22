"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { createJob, type CreateJobResult } from "@/lib/services/job-intake.service";
import { createClientRecord, createEquipmentType } from "@/lib/services/admin.service";
import { loadTemplateProcesses } from "@/lib/services/job-intake.read";
import { generateSchedule } from "@/lib/services/schedule.service";
import { isAppError } from "@/lib/shared/errors";
import { toActionError, type ActionResult } from "./_action";
import type {
  CreateJobInput,
  CreateClientInput,
  CreateEquipmentTypeInput,
} from "@/lib/shared/schemas";

export type CreateJobActionResult = ActionResult & {
  job?: CreateJobResult;
  detail?: Record<string, unknown>;
};

export async function createJobAction(input: CreateJobInput): Promise<CreateJobActionResult> {
  try {
    const job = await createJob(await requireActor(), input);
    revalidatePath("/jobs");
    return { ok: true, job };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && isAppError(e)) return { ...result, detail: e.detail };
    return result;
  }
}

export type ScheduleVerdict =
  | { kind: "FEASIBLE" | "INFEASIBLE"; shortfallDays: number | null; planCount: number }
  | { kind: "DATA_MISSING"; message: string }
  | { kind: "FAILED"; message: string };

/**
 * Schedule a freshly created job. A SEPARATE call from createJobAction on
 * purpose: computeEnvelope refuses a provisional or duration-less spine with
 * SCHEDULE_DATA_MISSING, and that refusal must not roll back a perfectly good
 * job. A job on a provisional route is legitimate — it tracks the order, gates
 * its processes and drives the Stage Spine; it simply has no dates yet.
 */
export async function scheduleNewJobAction(
  jobId: number,
  requiredDeliveryDate?: Date,
): Promise<ScheduleVerdict> {
  try {
    const run = await generateSchedule(await requireActor(), {
      jobId,
      mode: "BACKWARD",
      ...(requiredDeliveryDate ? { requiredDeliveryDate } : {}),
    });
    revalidatePath(`/jobs/${jobId}`);
    return {
      kind: run.feasibility === "INFEASIBLE" ? "INFEASIBLE" : "FEASIBLE",
      shortfallDays: run.shortfallDays,
      planCount: run.processPlans.length,
    };
  } catch (e) {
    if (isAppError(e)) {
      if (e.code === "SCHEDULE_DATA_MISSING") {
        return {
          kind: "DATA_MISSING",
          message:
            "The job was created, but dates cannot be computed yet — this process route has " +
            "processes with no confirmed duration.",
        };
      }
      return { kind: "FAILED", message: e.message };
    }
    throw e;
  }
}

export type CreateClientActionResult = ActionResult & { clientId?: number; name?: string };

export async function createClientAction(input: CreateClientInput): Promise<CreateClientActionResult> {
  try {
    const client = await createClientRecord(await requireActor(), input);
    return { ok: true, clientId: client.id, name: client.name };
  } catch (e) {
    return toActionError(e);
  }
}

export type CreateEquipmentTypeActionResult = ActionResult & { equipmentTypeId?: number };

export async function createEquipmentTypeAction(
  input: CreateEquipmentTypeInput,
): Promise<CreateEquipmentTypeActionResult> {
  try {
    const row = await createEquipmentType(await requireActor(), input);
    revalidatePath("/admin/equipment-types");
    return { ok: true, equipmentTypeId: row.id };
  } catch (e) {
    return toActionError(e);
  }
}

export type LoadTemplateProcessesResult = ActionResult & {
  processes?: Array<{
    code: string;
    seq: number;
    name: string;
    departmentName: string;
    optional: boolean;
    provisional: boolean;
    durationMaxDays: number | null;
  }>;
};

/**
 * Task 10's wizard step 2 needs a template version's process list (for
 * include/exclude checkboxes) the moment the user picks a version from a
 * dropdown — a client component, so this wraps the Task 8 read-service
 * function the same way every other lookup in this file does.
 */
export async function loadTemplateProcessesAction(versionId: number): Promise<LoadTemplateProcessesResult> {
  try {
    const processes = await loadTemplateProcesses(await requireActor(), versionId);
    return { ok: true, processes };
  } catch (e) {
    return toActionError(e);
  }
}
