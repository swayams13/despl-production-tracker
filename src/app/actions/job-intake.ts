"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import {
  createJob,
  updateJobDates,
  updateJobDetails,
  setJobStatus,
  attachQcpTemplate,
  type AttachQcpResult,
  type CreateJobResult,
} from "@/lib/services/job-intake.service";
import {
  createClientRecord,
  createEquipmentType,
  updateEquipmentType,
  createProductFamily,
} from "@/lib/services/admin.service";
import { loadTemplateProcesses, qtyBandWarning, type QtyBandWarning } from "@/lib/services/job-intake.read";
import { generateSchedule, getSchedule } from "@/lib/services/schedule.service";
import { withTenant } from "@/lib/db";
import { AppError, ERROR_CODES, isAppError } from "@/lib/shared/errors";
import { FEATURES } from "@/lib/shared/flags";
import { toActionError, type ActionResult } from "./_action";
import type {
  CreateJobInput,
  UpdateJobDatesInput,
  UpdateJobDetailsInput,
  SetJobStatusInput,
  CreateClientInput,
  CreateEquipmentTypeInput,
  UpdateEquipmentTypeInput,
  CreateProductFamilyInput,
} from "@/lib/shared/schemas";

export type CreateJobActionResult = ActionResult & {
  job?: CreateJobResult;
  detail?: Record<string, unknown>;
};

export async function createJobAction(input: CreateJobInput): Promise<CreateJobActionResult> {
  try {
    const actor = await requireActor();
    if (!FEATURES.multiFamilyIntake) {
      // Lean Core freeze: only PRESSURE_VESSEL jobs may be created. An unknown
      // or malformed familyId falls through so createJob reports it as before.
      const family = Number.isInteger(input.familyId)
        ? await withTenant(actor.tenantId, (tx) =>
            tx.productFamily.findFirst({ where: { id: input.familyId, tenantId: actor.tenantId }, select: { code: true } }),
          )
        : null;
      if (family && family.code !== "PRESSURE_VESSEL") {
        throw new AppError(ERROR_CODES.FEATURE_FROZEN, { feature: "multiFamilyIntake", familyCode: family.code });
      }
    }
    // Wizard path only: createJob itself stays date-optional for seeds, scripts and tests.
    if (!input.committedDeliveryDate) throw new AppError(ERROR_CODES.DELIVERY_DATE_REQUIRED);
    const job = await createJob(actor, input);
    revalidatePath("/jobs");
    return { ok: true, job };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && isAppError(e)) return { ...result, detail: e.detail };
    return result;
  }
}

export type ScheduleVerdict =
  | { kind: "FEASIBLE" | "INFEASIBLE"; shortfallDays: number | null; planCount: number; qtyBandWarning?: QtyBandWarning | null }
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
    // No revalidatePath: the wizard's result step calls this, and a revalidation would re-render /jobs/new
    // (now "draft already released") over it. /jobs/[id] is dynamic, so it is fresh on open.
    return {
      kind: run.feasibility === "INFEASIBLE" ? "INFEASIBLE" : "FEASIBLE",
      shortfallDays: run.shortfallDays,
      planCount: run.processPlans.length,
      qtyBandWarning: await qtyBandWarning(await requireActor(), jobId),
    };
  } catch (e) {
    if (isAppError(e)) {
      if (e.code === "SCHEDULE_DATA_MISSING") {
        const noDate = e.detail?.missing === "committedDeliveryDate";
        return {
          kind: "DATA_MISSING",
          message: noDate
            ? "The job was created, but dates cannot be computed yet — it has no committed delivery date. Set one on the job page."
            : "The job was created, but dates cannot be computed yet — this process route has " +
              "processes with no confirmed duration.",
        };
      }
      return { kind: "FAILED", message: e.message };
    }
    throw e;
  }
}

export type UpdateJobDatesActionResult = ActionResult & {
  /** UNCHANGED: replan is frozen and a schedule exists, so the date was saved but planned dates were not recomputed. */
  schedule?: ScheduleVerdict | { kind: "UNCHANGED" };
  detail?: Record<string, unknown>;
};

/**
 * Set/change an existing job's dates (typically the dispatch/delivery date
 * that scheduleNewJobAction never got at creation time), then immediately
 * re-run the scheduler on it — same BACKWARD-from-delivery pattern the "New
 * job" wizard uses right after createJobAction, just re-triggerable later
 * instead of only once at intake.
 */
export async function updateJobDatesAction(input: UpdateJobDatesInput): Promise<UpdateJobDatesActionResult> {
  try {
    if (!input.committedDeliveryDate) throw new AppError(ERROR_CODES.DELIVERY_DATE_REQUIRED);
    const actor = await requireActor();
    const job = await updateJobDates(actor, input);
    revalidatePath(`/jobs/${input.jobId}`);
    revalidatePath("/jobs");

    // Lean Core freeze: saving the date is always allowed, but re-running the
    // scheduler over an existing schedule is a replan. Frozen, it runs only for
    // a job that has no schedule yet (the first one, as at intake).
    const replan = FEATURES.cpmReplanUi || !(await getSchedule(actor, input.jobId));
    const schedule: UpdateJobDatesActionResult["schedule"] = !replan
      ? { kind: "UNCHANGED" }
      : job.committedDeliveryDate
        ? await scheduleNewJobAction(input.jobId, job.committedDeliveryDate)
        : undefined;

    return { ok: true, schedule };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && isAppError(e)) return { ...result, detail: e.detail };
    return result;
  }
}

export type UpdateJobDetailsActionResult = ActionResult & { detail?: Record<string, unknown> };

export async function updateJobDetailsAction(input: UpdateJobDetailsInput): Promise<UpdateJobDetailsActionResult> {
  try {
    await updateJobDetails(await requireActor(), input);
    revalidatePath(`/jobs/${input.jobId}`);
    revalidatePath("/jobs");
    return { ok: true };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && isAppError(e)) return { ...result, detail: e.detail };
    return result;
  }
}

export type SetJobStatusActionResult = ActionResult & { detail?: Record<string, unknown> };

export async function setJobStatusAction(input: SetJobStatusInput): Promise<SetJobStatusActionResult> {
  try {
    await setJobStatus(await requireActor(), input);
    revalidatePath(`/jobs/${input.jobId}`);
    revalidatePath("/jobs");
    return { ok: true };
  } catch (e) {
    const result = toActionError(e);
    if (!result.ok && isAppError(e)) return { ...result, detail: e.detail };
    return result;
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

export type CreateProductFamilyActionResult = ActionResult & { familyId?: number };

export async function createProductFamilyAction(
  input: CreateProductFamilyInput,
): Promise<CreateProductFamilyActionResult> {
  try {
    const row = await createProductFamily(await requireActor(), input);
    revalidatePath("/admin/families");
    return { ok: true, familyId: row.id };
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

export type UpdateEquipmentTypeActionResult = ActionResult & { equipmentTypeId?: number };

export async function updateEquipmentTypeAction(
  input: UpdateEquipmentTypeInput,
): Promise<UpdateEquipmentTypeActionResult> {
  try {
    const row = await updateEquipmentType(await requireActor(), input);
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

export type AttachQcpActionResult = ActionResult & { attached?: AttachQcpResult };

/** JG2: attach a QC plan to a job that has none. */
export async function attachQcpTemplateAction(jobId: number, qcpTemplateSourceId: number): Promise<AttachQcpActionResult> {
  try {
    const actor = await requireActor();
    const attached = await attachQcpTemplate(actor, { jobId, qcpTemplateSourceId });
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, attached };
  } catch (e) {
    return toActionError(e);
  }
}
