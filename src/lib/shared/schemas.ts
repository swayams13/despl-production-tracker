import { z } from "zod";

/**
 * zod is the single source of validation truth — client and server import the
 * same schema (CLAUDE.md conventions).
 *
 * INVARIANT #1: no request schema in this file may ever contain an `actual_*`
 * or `*_at` field. Actual timestamps are set server-side from the database
 * clock. If you find yourself adding one here, the design is wrong.
 */

/** D13: login identifier is username OR email — not email-only, and not `.email()`-shaped. */
export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Enter your username or email"),
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
 * Job.committedDeliveryDate when omitted.
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

/**
 * §4.10 Admin: reset a user's password. `password` is optional (personal
 * dashboards v1, Task 4.1) — omit it and the service generates a readable
 * temp password the same way `createEmployee` does, returned once.
 */
export const resetPasswordSchema = z
  .object({ userId: id, password: z.string().min(8, "Password must be at least 8 characters").optional() })
  .strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

const roleCodeEnum = z.enum(["ADMIN", "MANAGEMENT", "PRODUCTION_HEAD", "SUPERVISOR", "QC", "CLIENT_VIEWER"]);

/**
 * SPEC §5.2: create an employee account. Deliberately a SEPARATE contract
 * from `createUserSchema` (optional generated password, explicit
 * username/employeeCode) — see Task 4.1 ruling; do not merge the two.
 */
export const createEmployeeSchema = z
  .object({
    displayName: z.string().trim().min(1, "Name is required"),
    // Lowercased to match `email` below — case ALONE must never let two
    // rows both match one login identifier (see login()'s OR lookup and
    // the case-sensitive-collision finding this closed).
    username: z.string().trim().toLowerCase().min(1, "Username is required"),
    email: z.string().trim().toLowerCase().email("Enter a valid email address").optional(),
    employeeCode: z.string().trim().min(1).optional(),
    roles: roleCodeEnum.array().min(1, "At least one role is required"),
    departmentIds: z.array(id).default([]),
    // C28 default: ≥10 chars, no complexity theatre. Omit to auto-generate.
    password: z.string().min(10, "Password must be at least 10 characters").optional(),
  })
  .strict();
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/** §5.2: activate/deactivate an account. Deactivation never deletes (invariant #6). */
export const setUserActiveSchema = z.object({ userId: id, active: z.boolean() }).strict();
export type SetUserActiveInput = z.infer<typeof setUserActiveSchema>;

/** §5.2: replace a user's roles/departments wholesale, audited before→after. */
export const updateUserRolesDeptsSchema = z
  .object({
    userId: id,
    roles: roleCodeEnum.array().min(1, "At least one role is required"),
    departmentIds: z.array(id).default([]),
  })
  .strict();
export type UpdateUserRolesDeptsInput = z.infer<typeof updateUserRolesDeptsSchema>;

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

// ── Process route authoring ─────────────────────────────────────────────

/** Warning codes publishVersion can return; the caller echoes them back to confirm they were shown. */
export const TEMPLATE_WARNING_CODES = [
  "PROVISIONAL_DURATIONS",
  "MULTIPLE_TERMINALS",
  "EMPTY_WORK_ORDER_STAGES",
  "ENVELOPE_MISMATCH",
] as const;
export type TemplateWarningCode = (typeof TEMPLATE_WARNING_CODES)[number];

/** Start a route for a family that has none. Creates an empty v1 DRAFT. */
export const createTemplateSchema = z
  .object({
    familyId: id,
    name: z.string().trim().min(1, "A name is required"),
  })
  .strict();
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/**
 * Deep-copy a version into a new DRAFT. Omit `targetFamilyId` to revise the
 * same template (next version); supply it to start a new family's route from
 * an existing one, which needs a `name` for the new template.
 */
export const cloneVersionSchema = z
  .object({
    sourceVersionId: id,
    targetFamilyId: id.optional(),
    name: z.string().trim().min(1).optional(),
    notes: z.string().trim().min(1, "Say why this version exists"),
  })
  .strict()
  .refine((v) => v.targetFamilyId == null || v.name != null, {
    message: "A name is required when cloning into another product family",
    path: ["name"],
  });
export type CloneVersionInput = z.infer<typeof cloneVersionSchema>;

/**
 * Full replace of a DRAFT's contents. `key` is a client-side stable handle so
 * edges can reference rows that have no database id yet.
 *
 * `provisional` and the durations are cross-checked: a process may not claim
 * confirmed durations it does not have, nor hide real ones behind the flag.
 * That pairing is invariant #10's guard rail, enforced here and again in the
 * service.
 */
export const saveDraftVersionSchema = z
  .object({
    versionId: id,
    /** The `updatedAt` the editor loaded. Null is legitimate for rows that predate the column. */
    expectedUpdatedAt: z.coerce.date().nullable(),
    processes: z
      .array(
        z
          .object({
            key: z.string().trim().min(1),
            seq: z.number().int().positive(),
            code: z.string().trim().min(1),
            name: z.string().trim().min(1),
            mainActivities: z.string().trim().nullable().default(null),
            defaultDepartmentId: id,
            durationMinDays: z.number().int().positive().nullable().default(null),
            durationMaxDays: z.number().int().positive().nullable().default(null),
            envelopeStartByMinDays: z.number().int().nullable().default(null),
            envelopeStartByMaxDays: z.number().int().nullable().default(null),
            envelopeFinishByMinDays: z.number().int().nullable().default(null),
            envelopeFinishByMaxDays: z.number().int().nullable().default(null),
            workOrderStages: z.array(z.number().int().positive()).default([]),
            optional: z.boolean().default(false),
            provisional: z.boolean().default(true),
          })
          .strict()
          .refine(
            (p) =>
              p.provisional ||
              (p.durationMinDays != null && p.durationMaxDays != null),
            {
              message:
                "A confirmed process needs both a minimum and a maximum duration. Mark it provisional instead.",
              path: ["durationMinDays"],
            },
          )
          .refine(
            (p) =>
              p.durationMinDays == null ||
              p.durationMaxDays == null ||
              p.durationMinDays <= p.durationMaxDays,
            {
              message: "Minimum duration cannot exceed the maximum",
              path: ["durationMaxDays"],
            },
          ),
      )
      .default([]),
    edges: z
      .array(
        z
          .object({
            processKey: z.string().trim().min(1),
            predecessorKey: z.string().trim().min(1),
            type: z.enum(["FINISH_TO_START", "START_TO_START_WITH_OVERLAP"]),
            // Negative lag is legitimate concurrent work (invariant #11), so
            // this is a plain int with no positivity constraint.
            lagDays: z.number().int(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type SaveDraftVersionInput = z.infer<typeof saveDraftVersionSchema>;

/** Publish a DRAFT. `notes` is mandatory — it is what an auditor reads later. */
export const publishVersionSchema = z
  .object({
    versionId: id,
    notes: z.string().trim().min(1, "Say where this route's data came from"),
    acknowledgedWarnings: z.array(z.enum(TEMPLATE_WARNING_CODES)).default([]),
    /** Optional printed lead time in days to check the computed envelope against (invariant #10). */
    expectedEnvelopeDays: z.number().int().positive().nullable().default(null),
  })
  .strict();
export type PublishVersionInput = z.infer<typeof publishVersionSchema>;

/** Claim an unassigned plan into the caller's own name (personal dashboards v1, SPEC §5.1). */
export const claimPlanSchema = z.object({ processPlanId: id }).strict();
export type ClaimPlanInput = z.infer<typeof claimPlanSchema>;

/** Assign (or reassign) a plan to a specific user. */
export const assignPlanSchema = z.object({ processPlanId: id, userId: id }).strict();
export type AssignPlanInput = z.infer<typeof assignPlanSchema>;

/** Return a plan to its department pool (assigneeUserId → null). */
export const releasePlanSchema = z.object({ processPlanId: id }).strict();
export type ReleasePlanInput = z.infer<typeof releasePlanSchema>;

/**
 * First-login password change (personal dashboards v1, Task 1.3). Minimum
 * length only — SPEC's own C28 default ("≥10 chars, no complexity theatre").
 */
export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password"),
    next: z.string().min(10, "New password must be at least 10 characters"),
  })
  .strict();
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

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

/** Production Head publishes today's per-unit progress for a job (client-portal-daily-updates, 2026-08-19). */
export const publishSnapshotSchema = z.object({ jobId: id }).strict();
export type PublishSnapshotInput = z.infer<typeof publishSnapshotSchema>;

/** Management verifies today's published batch — the only thing that makes it client-visible. */
export const verifySnapshotSchema = z.object({ jobId: id }).strict();
export type VerifySnapshotInput = z.infer<typeof verifySnapshotSchema>;

/** Management rejects today's published batch with a mandatory reason. */
export const rejectSnapshotSchema = z.object({ jobId: id, reason }).strict();
export type RejectSnapshotInput = z.infer<typeof rejectSnapshotSchema>;

// ── Job intake: equipment catalog and clients ───────────────────────────

export const createEquipmentTypeSchema = z
  .object({
    familyId: id,
    code: z.string().trim().toUpperCase().min(1, "A code is required"),
    name: z.string().trim().min(1, "A name is required"),
    defaultDesignCode: z.string().trim().min(1).nullable().default(null),
    /** Shape-checked against the family's SPEC_FIELDS in the service, not here. */
    defaultSpecs: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict();
export type CreateEquipmentTypeInput = z.infer<typeof createEquipmentTypeSchema>;

/** Deactivate rather than delete — Equipment rows reference these (invariant #6). */
export const updateEquipmentTypeSchema = z
  .object({
    id,
    name: z.string().trim().min(1).optional(),
    defaultDesignCode: z.string().trim().min(1).nullable().optional(),
    defaultSpecs: z.record(z.string(), z.unknown()).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type UpdateEquipmentTypeInput = z.infer<typeof updateEquipmentTypeSchema>;

/** Inline client creation from the intake wizard. Name + optional code only. */
export const createClientSchema = z
  .object({
    name: z.string().trim().min(1, "A client name is required"),
    code: z.string().trim().toUpperCase().min(1).nullable().default(null),
  })
  .strict();
export type CreateClientInput = z.infer<typeof createClientSchema>;

/**
 * Job intake (docs/superpowers/specs/2026-08-22-job-intake-design.md §4.1).
 *
 * `.strict()` with NO actual_* or *_at field (invariant #1). orderDate,
 * committedDeliveryDate and targetDispatchDate are PLANNING dates a planner
 * legitimately supplies — the same distinction schedule.service.ts already
 * draws for its own projectStartDate/requiredDeliveryDate inputs. Every
 * `actual_*` on this job will be written by process.service.ts from the DB
 * clock and nowhere else.
 */
export const createJobSchema = z
  .object({
    clientId: id,
    familyId: id,
    templateVersionId: id,
    calendarId: id.nullable().default(null),
    jobNumber: z.string().trim().min(1, "A job number is required"),
    clientOrderNo: z.string().trim().min(1).nullable().default(null),
    projectName: z.string().trim().min(1).nullable().default(null),
    poRef: z.string().trim().min(1).nullable().default(null),
    designCode: z.string().trim().min(1).nullable().default(null),
    orderDate: z.coerce.date().nullable().default(null),
    committedDeliveryDate: z.coerce.date().nullable().default(null),
    targetDispatchDate: z.coerce.date().nullable().default(null),
    // Matches enum JobPriority at schema.prisma:60 — URGENT, not CRITICAL.
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
    remarks: z.string().trim().min(1).nullable().default(null),
    /** Filtered through the family's SPEC_FIELDS in the service. */
    specs: z.record(z.string(), z.unknown()).nullable().default(null),
    /** TemplateProcess.code values this client skips, e.g. PWHT. */
    excludedProcessCodes: z.array(z.string().trim().min(1)).default([]),
    equipments: z
      .array(
        z
          .object({
            equipmentTypeId: id.nullable().default(null),
            name: z.string().trim().min(1, "Each equipment block needs a name"),
            blockNo: z.number().int().positive().nullable().default(null),
            remarks: z.string().trim().min(1).nullable().default(null),
            serials: z
              .array(z.string().trim().min(1))
              .min(1, "Each equipment block needs at least one serial number"),
          })
          .strict()
          .refine((b) => new Set(b.serials).size === b.serials.length, {
            message: "Serial numbers must be unique within an equipment block",
            path: ["serials"],
          }),
      )
      .min(1, "A job needs at least one equipment block"),
    /** Clone this QCP template's items onto the new job. */
    qcpTemplateSourceId: id.nullable().default(null),
    /** Copy this equipment's BOM lines into the first equipment block. */
    copyBomFromEquipmentId: id.nullable().default(null),
  })
  .strict()
  .refine(
    (v) =>
      v.targetDispatchDate == null ||
      v.committedDeliveryDate == null ||
      v.targetDispatchDate <= v.committedDeliveryDate,
    {
      message: "The target dispatch date cannot be later than the date committed to the client",
      path: ["targetDispatchDate"],
    },
  );
export type CreateJobInput = z.infer<typeof createJobSchema>;
