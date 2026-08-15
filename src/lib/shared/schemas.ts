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
