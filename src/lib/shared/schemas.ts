import { z } from "zod";

/**
 * zod is the single source of validation truth — client and server import the
 * same schema (CLAUDE.md conventions).
 *
 * INVARIANT #1: no request schema in this file may ever contain an `actual_*`
 * or `*_at` field. Actual timestamps are set server-side from the database
 * clock. If you find yourself adding one here, the design is wrong.
 */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Per-mutation request schemas for lib/services.
 *
 * Every one is `.strict()` — not decoration. Invariant #1 forbids any
 * `actual_*` or `*_at` field on a request, and `.strict()` makes that
 * structural: an unknown key (including a smuggled `actualStart` or
 * `started_at`) fails validation instead of being silently dropped. The
 * server sets actual timestamps from the DB clock, never the client.
 *
 * These carry only ids, enums, reason text and category ids. Planning dates
 * that a planner legitimately chooses at tender stage (projectStartDate,
 * requiredDeliveryDate) are NOT actuals and are allowed on the generate
 * schema; they are optional because the service falls back to Job.orderDate /
 * Job.deliveryDate when omitted.
 */

const id = z.number().int().positive();
const reason = z.string().trim().min(1, "A reason is required");

/** FORWARD/BACKWARD schedule generation for a job (equipment-level optional). */
export const generateScheduleSchema = z
  .object({
    jobId: id,
    equipmentId: id.nullish(),
    mode: z.enum(["FORWARD", "BACKWARD"]),
    projectStartDate: z.coerce.date().optional(),
    requiredDeliveryDate: z.coerce.date().optional(),
  })
  .strict();
export type GenerateScheduleInput = z.infer<typeof generateScheduleSchema>;

/** Mark a process plan IN_PROGRESS (gating checked server-side). */
export const startProcessSchema = z.object({ processPlanId: id }).strict();
export type StartProcessInput = z.infer<typeof startProcessSchema>;

/** Submit a process plan for QC verification (maker step). */
export const submitProcessSchema = z.object({ processPlanId: id }).strict();
export type SubmitProcessInput = z.infer<typeof submitProcessSchema>;

/** QC verifies a submitted plan → COMPLETE (checker step, maker≠checker). */
export const verifyProcessSchema = z.object({ processPlanId: id }).strict();
export type VerifyProcessInput = z.infer<typeof verifyProcessSchema>;

/** Put a process plan ON_HOLD with a recorded reason. */
export const holdProcessSchema = z.object({ processPlanId: id, reason }).strict();
export type HoldProcessInput = z.infer<typeof holdProcessSchema>;

/** QC rejects a submitted process back to the maker, with a mandatory reason. */
export const rejectProcessSchema = z.object({ processPlanId: id, reason }).strict();
export type RejectProcessInput = z.infer<typeof rejectProcessSchema>;

/** QC records a checkpoint result for a unit → clears/opens the hold point (#4). */
export const recordQcpExecutionSchema = z
  .object({
    qcpItemId: id,
    unitId: id,
    result: z.enum(["ACCEPTED", "REJECTED", "NA"]),
    remarks: z.string().trim().optional(),
  })
  .strict();
export type RecordQcpExecutionInput = z.infer<typeof recordQcpExecutionSchema>;

/** QC records/updates a heat number + MTC ref + PMI result for a BOM item (§4.3 "MTC status editable by QC"). */
export const recordMtcSchema = z
  .object({
    bomItemId: id,
    heatNumber: z.string().trim().min(1, "Heat number is required"),
    mtcRef: z.string().trim().optional(),
    pmiResult: z.enum(["NA", "PENDING", "ACCEPT", "REJECT"]),
  })
  .strict();
export type RecordMtcInput = z.infer<typeof recordMtcSchema>;

/** File the categorised delay reason invariant #7 requires to unblock a dept. */
export const fileDelayReasonSchema = z
  .object({ processPlanId: id, categoryId: id, detail: z.string().trim().optional() })
  .strict();
export type FileDelayReasonInput = z.infer<typeof fileDelayReasonSchema>;

/** FR-W2: log a butt-weld joint, attributed to one or more welders. */
export const logWeldJointSchema = z
  .object({
    jobId: id,
    unitId: id.nullish(),
    jointNo: z.string().trim().min(1, "Joint number is required"),
    jointType: z.string().trim().min(1, "Joint type is required"),
    weldSize: z.string().trim().optional(),
    wpsRef: z.string().trim().optional(),
    welderIds: z.array(id).min(1, "At least one welder is required"),
  })
  .strict();
export type LogWeldJointInput = z.infer<typeof logWeldJointSchema>;

/** FR-W3: QC records an NDT result for a joint (RT/UT/PT/MT…), attributed to its welder(s). */
export const recordNdtResultSchema = z
  .object({
    weldJointId: id,
    testTypeId: id,
    result: z.enum(["PENDING", "ACCEPT", "REJECT"]),
  })
  .strict();
export type RecordNdtResultInput = z.infer<typeof recordNdtResultSchema>;

/** §4.10 Admin: create a user (create user + role + dept). No self-signup anywhere. */
export const createUserSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    email: z.string().trim().toLowerCase().email("Enter a valid email address"),
    roleCodes: z
      .array(z.enum(["ADMIN", "MANAGEMENT", "PRODUCTION_HEAD", "SUPERVISOR", "QC", "CLIENT_VIEWER"]))
      .min(1, "At least one role is required"),
    departmentIds: z.array(id).default([]),
    password: z.string().min(8, "Password must be at least 8 characters"),
  })
  .strict();
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** §4.10 Admin: reset a user's password. */
export const resetPasswordSchema = z
  .object({ userId: id, password: z.string().min(8, "Password must be at least 8 characters") })
  .strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** §4.10 Admin: master delay-reason list editor. */
export const createDelayCategorySchema = z.object({ name: z.string().trim().min(1, "Name is required") }).strict();
export type CreateDelayCategoryInput = z.infer<typeof createDelayCategorySchema>;

export const updateDelayCategorySchema = z
  .object({ id, name: z.string().trim().min(1).optional(), active: z.boolean().optional() })
  .strict();
export type UpdateDelayCategoryInput = z.infer<typeof updateDelayCategorySchema>;

/**
 * §4.10 Admin: standard-durations table editor. CLAUDE.md invariant #9 —
 * edits a TEMPLATE, so they create a new ProcessTemplateVersion; a job
 * already pinned to the prior version is never retroactively changed.
 */
export const updateStandardDurationsSchema = z
  .object({
    templateVersionId: id,
    edits: z
      .array(z.object({ templateProcessId: id, durationMinDays: z.number().int().positive(), durationMaxDays: z.number().int().positive() }))
      .min(1, "At least one change is required"),
    reason,
  })
  .strict();
export type UpdateStandardDurationsInput = z.infer<typeof updateStandardDurationsSchema>;

/** Override a process duration → new ScheduleRun version, mandatory reason. */
export const applyDurationOverrideSchema = z
  .object({
    jobId: id,
    equipmentId: id.nullish(),
    jobProcessId: id,
    durationOverrideDays: z.number().int().positive(),
    reason,
  })
  .strict();
export type ApplyDurationOverrideInput = z.infer<typeof applyDurationOverrideSchema>;
