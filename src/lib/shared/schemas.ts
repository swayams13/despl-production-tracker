import { z } from "zod";

/**
 * zod is the single source of validation truth — client and server import the
 * same schema (CLAUDE.md conventions).
 *
 * INVARIANT #1: no request schema in this file may ever contain an `actual_*`
 * or `*_at` field. Actual timestamps are set server-side from the database
 * clock. If you find yourself adding one here, the design is wrong.
 *
 * Carve-out: a comparison-only optimistic-lock token (e.g.
 * `expectedUpdatedAt` on `saveDraftVersionSchema`) is not covered by this
 * ban — it is never persisted or trusted as event provenance, only echoed
 * back by the client and compared server-side to detect a concurrent edit,
 * the same pattern as an HTTP `If-Match` header.
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

/** Start a component operation (sub-assembly fabrication step). */
export const startComponentOperationSchema = z.object({ componentOperationId: id }).strict();
export type StartComponentOperationInput = z.infer<typeof startComponentOperationSchema>;

/**
 * Submit a component operation for QC verification (maker step). Optionally
 * records who performed the work (F3) and quantities (F4) — both are open
 * questions with the floor (F-d/F-c, spec §4), so every field here stays
 * optional; submit still succeeds with none of them set.
 */
export const submitComponentOperationSchema = z
  .object({
    componentOperationId: id,
    performedByWelderId: id.nullish(),
    performedByUserId: id.nullish(),
    remarks: z.string().trim().max(2000).optional(),
    qtyPlanned: z.number().int().nonnegative().nullish(),
    qtyGood: z.number().int().nonnegative().nullish(),
    qtyRejected: z.number().int().nonnegative().nullish(),
  })
  .strict();
export type SubmitComponentOperationInput = z.infer<typeof submitComponentOperationSchema>;

/** Verify a submitted component operation (checker step, maker-checker enforced in the service). */
export const verifyComponentOperationSchema = z.object({ componentOperationId: id }).strict();
export type VerifyComponentOperationInput = z.infer<typeof verifyComponentOperationSchema>;

/**
 * F5 — QC rejects a submitted component operation back to the maker. Same
 * shape as `fileDelayReasonSchema`'s categorised reason: `ComponentOperationRejection`
 * reuses `DelayCategoryRef` rather than a parallel taxonomy.
 */
export const rejectComponentOperationSchema = z
  .object({ componentOperationId: id, categoryId: id, detail: z.string().trim().optional() })
  .strict();
export type RejectComponentOperationInput = z.infer<typeof rejectComponentOperationSchema>;

// ── Paint / DFT (Phase 5, P1) ────────────────────────────────────────────

/** Records the coating system for a PAINTING ComponentOperation (1:1, upsertable). */
export const recordPaintRecordSchema = z
  .object({ componentOperationId: id, coatingSystem: z.string().trim().min(1), coatsPlanned: id.optional() })
  .strict();
export type RecordPaintRecordInput = z.infer<typeof recordPaintRecordSchema>;

/**
 * Records a single DFT reading. `accepted` is self-attested by whoever
 * records it — no spec'd min/max micron range exists to check against
 * automatically (open question, plan cover note; see PaintRecord/DftReading
 * schema comment).
 */
export const recordDftReadingSchema = z
  .object({
    componentOperationId: id,
    coatNumber: id.optional(),
    location: z.string().trim().optional(),
    readingMicrons: id,
    accepted: z.boolean(),
  })
  .strict();
export type RecordDftReadingInput = z.infer<typeof recordDftReadingSchema>;

// ── AssemblyStep (Phase 2 — A6) ──────────────────────────────────────────

/** Start an assembly step. */
export const startAssemblyStepSchema = z.object({ assemblyStepId: id }).strict();
export type StartAssemblyStepInput = z.infer<typeof startAssemblyStepSchema>;

/**
 * Submit an assembly step for QC verification (maker step). For a WORK step
 * whose template step carries a `jointRef` (the three single-joint weld
 * groups — LS-1/CS-2/CS-1), submission must bind a WeldJoint: either an
 * already-logged one (`weldJointId`) or inline fields to create one now
 * (`newJoint`) — never both, and the service refuses a jointRef step
 * submitted with neither. Steps with no `jointRef` ignore both fields.
 */
export const submitAssemblyStepSchema = z
  .object({
    assemblyStepId: id,
    performedByWelderId: id.nullish(),
    performedByUserId: id.nullish(),
    remarks: z.string().trim().max(2000).optional(),
    weldJointId: id.optional(),
    newJoint: z
      .object({
        jointNo: z.string().trim().min(1, "Joint number is required"),
        jointType: z.string().trim().min(1, "Joint type is required"),
        weldSize: z.string().trim().optional(),
        wpsRef: z.string().trim().optional(),
        welderIds: z.array(id).min(1, "At least one welder is required"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => !(v.weldJointId != null && v.newJoint != null), {
    message: "Provide either an existing weldJointId or newJoint fields, not both.",
  });
export type SubmitAssemblyStepInput = z.infer<typeof submitAssemblyStepSchema>;

/** Verify a submitted assembly step (checker step, maker-checker enforced in the service). */
export const verifyAssemblyStepSchema = z.object({ assemblyStepId: id }).strict();
export type VerifyAssemblyStepInput = z.infer<typeof verifyAssemblyStepSchema>;

/**
 * QC rejects a submitted assembly step back to the maker. Mirrors
 * rejectComponentOperationSchema's categorised-reason shape. `testTypeId` is
 * optional and only meaningful when the step has a bound `weldJointId` — the
 * service then also records an NdtResult(result: REJECT) against that
 * joint's welder(s), so the reject shows in welding.read.ts's repair-rate
 * calc in the same action, not a second one.
 */
export const rejectAssemblyStepSchema = z
  .object({
    assemblyStepId: id,
    categoryId: id,
    detail: z.string().trim().optional(),
    testTypeId: id.optional(),
  })
  .strict();
export type RejectAssemblyStepInput = z.infer<typeof rejectAssemblyStepSchema>;

/**
 * QC dispositions an open NCR (Phase 5, N1/N2). `reworkOwnerId`/`reworkDueDate`
 * only make sense for REWORK/REPAIR; the service does not require them even
 * then (F-c precedent — floor-assignment details stay optional here the same
 * way F3/F4 fields do on submit).
 */
export const dispositionNcrSchema = z
  .object({
    ncrId: id,
    disposition: z.enum(["USE_AS_IS", "REPAIR", "REWORK", "SCRAP", "CONCESSION"]),
    notes: z.string().trim().max(2000).optional(),
    reworkOwnerId: id.optional(),
    reworkDueDate: z.coerce.date().optional(),
  })
  .strict();
export type DispositionNcrInput = z.infer<typeof dispositionNcrSchema>;

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
    /** B8, Phase 4: which serial this heat entered — optional, since
     * equipment with no per-unit `Component` fan-out has none to attach to. */
    componentId: id.optional(),
    heatNumber: z.string().trim().min(1, "Heat number is required"),
    mtcRef: z.string().trim().optional(),
    pmiResult: z.enum(["NA", "PENDING", "ACCEPT", "REJECT"]),
    /** B8, Phase 4: how much of this heat went into this component. */
    qtyIssued: z.number().positive().optional(),
  })
  .strict();
export type RecordMtcInput = z.infer<typeof recordMtcSchema>;

/**
 * Log a procurement event (indent/PO/receipt) against a BOM item (B5, Phase
 * 4). `qty` is required on RECEIPT (how much arrived) and forbidden on the
 * other three types (they don't carry a quantity) — `.refine()` for the
 * cross-field rule, same style as `submitAssemblyStepSchema`'s
 * weldJointId/newJoint mutual-exclusion check above.
 */
export const recordProcurementEventSchema = z
  .object({
    bomItemId: id,
    type: z.enum(["INDENT_RAISED", "INDENT_APPROVED", "PO_PLACED", "RECEIPT"]),
    qty: z.number().positive().optional(),
    refNo: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((v) => (v.type === "RECEIPT" ? v.qty != null : v.qty == null), {
    message: "qty is required on a RECEIPT event, and not allowed on any other event type.",
  });
export type RecordProcurementEventInput = z.infer<typeof recordProcurementEventSchema>;

/**
 * Issue a new `DrawingRevision` for an `AssemblyDrawing` (B9, Phase 4).
 * `revisionNo` is a plain increasing integer (Rev 1, Rev 2, ...), same shape
 * as `BomRevision.revisionNo`. `status` is caller-supplied rather than
 * always RELEASED — a revision can be issued as DRAFT (still being checked)
 * without gating anything yet; only a RELEASED current revision clears the
 * CUTTING gate. SUPERSEDED is not accepted here — that transition happens
 * only as a side effect of a later revision's own creation
 * (drawing.service.ts's `createDrawingRevision`), never chosen directly.
 */
export const createDrawingRevisionSchema = z
  .object({
    assemblyDrawingId: id,
    revisionNo: z.number().int().positive(),
    status: z.enum(["DRAFT", "RELEASED"]),
  })
  .strict();
export type CreateDrawingRevisionInput = z.infer<typeof createDrawingRevisionSchema>;

/** S18: manually set (or clear) a Component's governing drawing — nothing auto-derives this link. */
export const linkGoverningDrawingSchema = z
  .object({
    componentId: id,
    assemblyDrawingId: id.nullable(),
  })
  .strict();
export type LinkGoverningDrawingInput = z.infer<typeof linkGoverningDrawingSchema>;

/** Receive a lot of stock against a BOM item (B6, Phase 4) — creates a `StockLot`. */
export const receiveStockSchema = z
  .object({
    bomItemId: id,
    heatNumber: z.string().trim().min(1).optional(),
    location: z.string().trim().min(1, "Location is required"),
    qty: z.number().positive(),
    sourceProcurementEventId: id.optional(),
  })
  .strict();
export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;

/** Move stock against an existing `StockLot` — issue to a component, return, or scrap.
 * One shared shape for all three (same near-identical-mutation-family convention as
 * `recordProcurementEventSchema`); `type` is supplied by the thin service function, not the caller. */
export const issueStockSchema = z
  .object({
    stockLotId: id,
    qty: z.number().positive(),
    componentId: id.optional(),
    note: z.string().trim().optional(),
  })
  .strict();
export type IssueStockInput = z.infer<typeof issueStockSchema>;

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
    /** A3 (Phase 2): set by whoever logs the joint, not auto-derived. */
    componentId: id.nullish(),
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
    // Defaults true (force a change on first login). Only an admin creating
    // a deliberately shared/interim credential should ever pass false.
    mustChangePassword: z.boolean().default(true),
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

// ── Welder registry (Phase 2 — A5) ──────────────────────────────────────

export const createWelderSchema = z
  .object({
    name: z.string().trim().min(1, "A name is required"),
    employeeCode: z.string().trim().min(1, "An employee code is required"),
    departmentId: id.nullable().default(null),
  })
  .strict();
export type CreateWelderInput = z.infer<typeof createWelderSchema>;

/** Deactivate rather than delete — set active: false (Component/Assembly rows reference welders, invariant #6). */
export const updateWelderSchema = z
  .object({
    id,
    name: z.string().trim().min(1).optional(),
    employeeCode: z.string().trim().min(1).optional(),
    departmentId: id.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type UpdateWelderInput = z.infer<typeof updateWelderSchema>;

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

/**
 * Set/change a job's planning dates after creation. Same PLANNING-date
 * distinction as createJobSchema — no actual_* field, invariant #1.
 */
export const updateJobDatesSchema = z
  .object({
    jobId: id,
    orderDate: z.coerce.date().nullable().default(null),
    committedDeliveryDate: z.coerce.date().nullable().default(null),
    targetDispatchDate: z.coerce.date().nullable().default(null),
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
export type UpdateJobDatesInput = z.infer<typeof updateJobDatesSchema>;

/**
 * Revise a job's own descriptive/reference fields after creation (client PO
 * changed, project renamed, priority bumped, …). Deliberately excludes
 * clientId/familyId/templateVersionId/equipments — those are structural and
 * ripple through the route, BOM and unit graph createJob() builds; changing
 * them isn't a "revision," it's a different job. Same `.strict()` +
 * no-actual_* rule as every other request schema here.
 */
export const updateJobDetailsSchema = z
  .object({
    jobId: id,
    clientOrderNo: z.string().trim().min(1).nullable().default(null),
    projectName: z.string().trim().min(1).nullable().default(null),
    poRef: z.string().trim().min(1).nullable().default(null),
    designCode: z.string().trim().min(1).nullable().default(null),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
    remarks: z.string().trim().min(1).nullable().default(null),
  })
  .strict();
export type UpdateJobDetailsInput = z.infer<typeof updateJobDetailsSchema>;

/** S19: Job.status had no writer anywhere. COMPLETE is guarded server-side (see job-intake.service.ts's setJobStatus). */
export const setJobStatusSchema = z
  .object({
    jobId: id,
    status: z.enum(["ACTIVE", "ON_HOLD", "COMPLETE", "CANCELLED"]),
  })
  .strict();
export type SetJobStatusInput = z.infer<typeof setJobStatusSchema>;

/**
 * Manual BOM authoring (B4, Phase 4) — first direct writer of `BomItem`
 * besides `copyBom`. `parentBomItemId`'s cycle check needs a DB read (walking
 * the equipment's existing parent chain) and so lives in `bom.service.ts`,
 * not here — this schema only validates shape.
 */
export const createBomItemSchema = z
  .object({
    equipmentId: id,
    itemNo: z.number().int().positive(),
    blockNo: z.number().int().positive().optional(),
    partName: z.string().trim().min(1, "Part name is required"),
    description: z.string().trim().min(1).optional(),
    material: z.string().trim().min(1).optional(),
    /** Raw source value, e.g. "40 NOS." — kept verbatim, same as the CSV import path (`BomItem.sourceQty`). */
    sourceQty: z.string().trim().min(1, "Quantity is required"),
    qtyPer: z.number().positive().optional(),
    uom: z.string().trim().min(1).optional(),
    unit: z.string().trim().min(1).optional(),
    componentTypeId: id.optional(),
    remarks: z.string().trim().min(1).optional(),
    parentBomItemId: id.optional(),
    bomRevisionId: id.optional(),
  })
  .strict();
export type CreateBomItemInput = z.infer<typeof createBomItemSchema>;

/**
 * Edit an existing `BomItem` — every field optional; `equipmentId` is not
 * editable here (moving a row to a different equipment isn't "editing," see
 * `updateJobDetailsSchema`'s equivalent exclusion of structural fields).
 *
 * Task review Important #2: every nullable-in-the-DB field is `.nullable()`
 * here too, not just `.optional()` — `undefined` (key omitted) means "leave
 * this field alone," `null` (key present, value null) means "clear it."
 * Collapsing those to one `optional()` made clearing `parentBomItemId` (or
 * any other nullable field) silently no-op: the UI's "no parent" choice sent
 * `undefined`, Prisma's `update` omits an undefined key entirely, and the
 * row came back unchanged while the caller still saw success. `itemNo`/
 * `partName`/`sourceQty` stay non-nullable — they're `NOT NULL` columns, so
 * "clear" isn't a valid state for them; only "leave alone" (omit) or "set to
 * a new value" apply.
 */
export const updateBomItemSchema = z
  .object({
    itemNo: z.number().int().positive().optional(),
    blockNo: z.number().int().positive().nullable().optional(),
    partName: z.string().trim().min(1, "Part name is required").optional(),
    description: z.string().trim().min(1).nullable().optional(),
    material: z.string().trim().min(1).nullable().optional(),
    sourceQty: z.string().trim().min(1, "Quantity is required").optional(),
    qtyPer: z.number().positive().nullable().optional(),
    uom: z.string().trim().min(1).nullable().optional(),
    unit: z.string().trim().min(1).nullable().optional(),
    componentTypeId: id.nullable().optional(),
    remarks: z.string().trim().min(1).nullable().optional(),
    parentBomItemId: id.nullable().optional(),
    bomRevisionId: id.nullable().optional(),
  })
  .strict();
export type UpdateBomItemInput = z.infer<typeof updateBomItemSchema>;

/**
 * One row of a bulk BOM import (CSV/XLSX). Validated per-row in
 * `bom.service.ts`'s `importBomItems` so one malformed row is reported by
 * name rather than aborting or silently dropping the whole batch.
 * `z.coerce` on the numeric fields — spreadsheet cells commonly arrive as
 * strings even when they read as numbers.
 *
 * Task review Important #1: NOT `.strict()`. The real BOM data this app
 * seeds from (`seed/despl-320-bom-items.json`, read by
 * `scripts/seed-despl320-bom.ts`) is shaped `{itemNo, partName, description,
 * material, qty, unit, remarks}` — note `qty`, not `sourceQty` — and a real
 * workbook export routinely carries extra columns (a serial/notes column, a
 * drawing ref) this schema doesn't model at all. `bom.service.ts`'s
 * `importBomItems` normalizes each row's keys (case/space-insensitive,
 * aliasing `qty`/`quantity` → `sourceQty` etc.) before this schema ever sees
 * it; staying non-strict here means a column that survives normalization
 * unrecognized is quietly dropped rather than failing the whole row.
 */
export const bomImportRowSchema = z.object({
  itemNo: z.coerce.number().int().positive(),
  blockNo: z.coerce.number().int().positive().optional(),
  partName: z.string().trim().min(1, "Part name is required"),
  description: z.string().trim().min(1).optional(),
  material: z.string().trim().min(1).optional(),
  sourceQty: z.coerce.string().trim().min(1, "Quantity is required"),
  qtyPer: z.coerce.number().positive().optional(),
  uom: z.string().trim().min(1).optional(),
  unit: z.string().trim().min(1).optional(),
  remarks: z.string().trim().min(1).optional(),
  parentBomItemId: z.coerce.number().int().positive().optional(),
});
export type BomImportRow = z.infer<typeof bomImportRowSchema>;

export const importBomItemsSchema = z
  .object({
    equipmentId: id,
    bomRevisionId: id.optional(),
    /** Raw, per-row validation happens in the service (`bomImportRowSchema.safeParse`
     * per row) — kept as `z.unknown()` here so one malformed row doesn't fail this
     * top-level parse and silently discard every other (valid) row in the batch. */
    rows: z.array(z.unknown()).min(1, "At least one row is required"),
  })
  .strict();
export type ImportBomItemsInput = z.infer<typeof importBomItemsSchema>;

/** Issue a new `BomRevision` for an equipment (B4, Phase 4 — the create-path
 * B3 deferred). `BomRevisionStatus` is DRAFT/RELEASED only — no SUPERSEDED
 * concept — see `bom.service.ts`'s `createBomRevision` for how supersession
 * is handled with that narrower enum. */
export const createBomRevisionSchema = z
  .object({
    equipmentId: id,
    revisionNo: z.number().int().positive(),
    status: z.enum(["DRAFT", "RELEASED"]),
  })
  .strict();
export type CreateBomRevisionInput = z.infer<typeof createBomRevisionSchema>;

// ── Packing / dispatch (Phase 5, D1/D2/D3) ──────────────────────────────

/** D1 — creates a Package a Unit can later be assigned into. */
export const createPackageSchema = z
  .object({
    jobId: id,
    packageNo: z.string().trim().min(1, "Package number is required"),
    weightKg: z.number().positive().optional(),
    lengthMm: z.number().int().positive().optional(),
    widthMm: z.number().int().positive().optional(),
    heightMm: z.number().int().positive().optional(),
    preservationNotes: z.string().trim().min(1).optional(),
  })
  .strict();
export type CreatePackageInput = z.infer<typeof createPackageSchema>;

/** D1 — assigns a Unit into a Package; both must share the same job. */
export const assignUnitToPackageSchema = z.object({ packageId: id, unitId: id }).strict();
export type AssignUnitToPackageInput = z.infer<typeof assignUnitToPackageSchema>;

/** D2 — creates a DispatchBatch (starts life PLANNED — no releaseApprovedAt yet). */
export const createDispatchBatchSchema = z
  .object({
    jobId: id,
    seq: z.number().int().positive(),
    plannedDate: z.coerce.date(),
    remarks: z.string().trim().min(1).optional(),
  })
  .strict();
export type CreateDispatchBatchInput = z.infer<typeof createDispatchBatchSchema>;

/** D2 — adds a Unit to a batch; the unit must already be packed (packageId set). */
export const addUnitToBatchSchema = z.object({ dispatchBatchId: id, unitId: id }).strict();
export type AddUnitToBatchInput = z.infer<typeof addUnitToBatchSchema>;

/** D3 — Production-Head-only release approval. No `releaseApprovedAt` field:
 * that timestamp is server-clock only (invariant #1). */
export const approveDispatchReleaseSchema = z
  .object({
    dispatchBatchId: id,
    dispatchNoteNo: z.string().trim().min(1).optional(),
    gatePassNo: z.string().trim().min(1).optional(),
    vehicleNo: z.string().trim().min(1).optional(),
    lrNo: z.string().trim().min(1).optional(),
  })
  .strict();
export type ApproveDispatchReleaseInput = z.infer<typeof approveDispatchReleaseSchema>;

/** D3 — records dispatch. No `actualDispatchDate` field: server-clock only
 * (invariant #1) — the schema structurally cannot accept a client-supplied one. */
export const recordDispatchSchema = z.object({ dispatchBatchId: id }).strict();
export type RecordDispatchInput = z.infer<typeof recordDispatchSchema>;

// ── Component route authoring (C6) ──────────────────────────────────────

/**
 * One step of a `RouteTemplate` being authored. Exactly one of `operationId`
 * (reuse an existing `OperationRef`) or `newOperation` (look-up-or-create by
 * code) may be given — same mutual-exclusion shape as
 * `submitAssemblyStepSchema`'s weldJointId/newJoint refine above.
 */
const routeStepInputSchema = z
  .object({
    seq: z.number().int().positive(),
    printed: z.string().trim().min(1).optional(),
    optional: z.boolean().default(false),
    operationId: id.optional(),
    newOperation: z
      .object({
        code: z.string().trim().toUpperCase().min(1, "A code is required"),
        name: z.string().trim().min(1, "A name is required"),
        defaultDepartmentId: id.optional(),
        sourceColumn: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => (v.operationId != null) !== (v.newOperation != null), {
    message: "Provide either an existing operationId or newOperation fields, not both.",
  });

/**
 * Create a new `RouteTemplate` for a (componentTypeId, familyId) pair, or
 * revise an existing one into a new PUBLISHED version. `familyId: null`
 * means the route applies to every family until overridden by a
 * family-specific one (see `component.service.ts`'s
 * `materializeComponentsFromBomItems`).
 */
export const createOrReviseRouteTemplateSchema = z
  .object({
    componentTypeId: id,
    familyId: id.nullable(),
    name: z.string().trim().min(1, "A name is required"),
    printedRoute: z.string().trim().min(1).optional(),
    steps: z.array(routeStepInputSchema).min(1, "A route needs at least one step"),
  })
  .strict();
export type CreateOrReviseRouteTemplateInput = z.infer<typeof createOrReviseRouteTemplateSchema>;

/**
 * Sets which of a family's own published `TemplateProcess.seq` values an
 * `OperationRef` rolls up into (Gate 3's `OperationRefFamilySeq`). Checked
 * against that family's own published route in the service — never trust
 * the number as-given.
 */
export const setOperationRefFamilySeqSchema = z
  .object({
    operationRefId: id,
    familyId: id,
    leadTimeProcessSeq: z.number().int().positive(),
  })
  .strict();
export type SetOperationRefFamilySeqInput = z.infer<typeof setOperationRefFamilySeqSchema>;

// ── QCP template authoring (C7) ──────────────────────────────────────────

/**
 * Author a brand-new library `QcpTemplate` (jobId: null) with no existing
 * QCP to clone from. Items are added afterward, one at a time, via
 * `addQcpItemToLibraryTemplateSchema`.
 */
export const createQcpTemplateLibrarySchema = z
  .object({
    jobLabel: z.string().trim().min(1, "A label is required"),
    vessel: z.string().trim().min(1, "A vessel description is required"),
    designCode: z.string().trim().min(1).optional(),
    parties: z
      .array(
        z
          .object({
            code: z.string().trim().toUpperCase().min(1, "A code is required"),
            name: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .min(1, "At least one inspecting party is required"),
  })
  .strict();
export type CreateQcpTemplateLibraryInput = z.infer<typeof createQcpTemplateLibrarySchema>;

/**
 * Add one `QcpItem` to a library template. `libraryProcessCodes` stands in
 * for `QcpItemProcess` (which needs a real `JobProcess` to point at, and a
 * library template has none) — resolved against the cloning job's own
 * processes by `cloneQcpTemplate`. `partyCodes[].partyCode` is looked up
 * (or authored inline) against the template's own `InspectionParty` rows;
 * `qcpCode` must already exist in the tenant's `QcpCodeRef` catalog.
 */
export const addQcpItemToLibraryTemplateSchema = z
  .object({
    qcpTemplateId: id,
    sequence: z.number().int().positive(),
    srNo: z.string().trim().min(1, "A sr. no. is required"),
    kind: z.enum(["SECTION", "CHECKPOINT"]),
    section: z.string().trim().min(1).optional(),
    activity: z.string().trim().min(1, "An activity is required"),
    characteristic: z.string().trim().min(1).optional(),
    extentOfCheck: z.string().trim().min(1).optional(),
    applicableDocument: z.string().trim().min(1).optional(),
    acceptanceCriteria: z.string().trim().min(1).optional(),
    record: z.string().trim().min(1).optional(),
    remarks: z.string().trim().min(1).optional(),
    libraryProcessCodes: z.array(z.string().trim().min(1)).default([]),
    partyCodes: z
      .array(
        z
          .object({
            partyCode: z.string().trim().toUpperCase().min(1, "A party code is required"),
            qcpCode: z.string().trim().min(1, "A QCP code is required"),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type AddQcpItemToLibraryTemplateInput = z.infer<typeof addQcpItemToLibraryTemplateSchema>;
