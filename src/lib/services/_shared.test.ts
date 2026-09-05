import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  jobProcessToScheduleProcess,
  jobEdgeToScheduleEdge,
  assertNoUnfiledDelayBlock,
  assertNoOpenHoldPoint,
  assertUnitHasNoOpenNcr,
  assertUnitHasNoOpenHoldPoint,
  loadPredecessorStates,
  loadMappedOps,
  loadJobSpine,
  persistScheduleRun,
  lockProcessPlanForUpdate,
  getCurrentScheduleRun,
} from "./_shared";
import {
  generateScheduleSchema,
  startProcessSchema,
  submitProcessSchema,
  verifyProcessSchema,
  holdProcessSchema,
  fileDelayReasonSchema,
  applyDurationOverrideSchema,
} from "@/lib/shared/schemas";
import type { JobProcess, JobProcessEdge } from "@/generated/prisma/client";

/**
 * Pure tests only — no database. The DB-backed helpers (loadJobSpine,
 * persistScheduleRun, assertNo*, loadPredecessorStates, lock) are exercised
 * under RUN_DB_TESTS in the service suites; here we pin the mappers and the
 * invariant-#1 property of every request schema.
 */

// A JobProcess row with only the fields the mappers read filled in; the rest
// are structurally present so the cast is honest.
function jobProcess(over: Partial<JobProcess>): JobProcess {
  return {
    id: 10,
    jobId: 1,
    templateProcessId: null,
    seq: 10,
    code: "10",
    name: "Rolling",
    departmentId: 3,
    durationMinDays: 4,
    durationMaxDays: 6,
    envelopeFinishByMinDays: 40,
    envelopeFinishByMaxDays: 42,
    envelopeStartByMinDays: 34,
    envelopeStartByMaxDays: 36,
    workOrderStages: [],
    included: true,
    durationOverrideDays: null,
    overrideReason: null,
    provisional: false,
    ...over,
  } as JobProcess;
}

describe("jobProcessToScheduleProcess", () => {
  it("round-trips the plain fields", () => {
    const sp = jobProcessToScheduleProcess(jobProcess({}));
    expect(sp).toMatchObject({
      id: 10,
      code: "10",
      name: "Rolling",
      durationMinDays: 4,
      durationMaxDays: 6,
      envelopeFinishByMinDays: 40,
      envelopeFinishByMaxDays: 42,
      envelopeStartByMinDays: 34,
      envelopeStartByMaxDays: 36,
      provisional: false,
      included: true,
    });
  });

  it("bakes durationOverrideDays over min/max AND clears provisional (matches engine resolveDuration)", () => {
    const sp = jobProcessToScheduleProcess(
      jobProcess({ durationOverrideDays: 9, provisional: true }),
    );
    expect(sp.durationMinDays).toBe(9);
    expect(sp.durationMaxDays).toBe(9);
    expect(sp.provisional).toBe(false);
  });

  it("passes included=false through for the exclude splice", () => {
    expect(jobProcessToScheduleProcess(jobProcess({ included: false })).included).toBe(false);
  });

  it("keeps provisional/null durations when there is no override", () => {
    const sp = jobProcessToScheduleProcess(
      jobProcess({ provisional: true, durationMinDays: null, durationMaxDays: null }),
    );
    expect(sp.provisional).toBe(true);
    expect(sp.durationMaxDays).toBeNull();
  });
});

describe("jobEdgeToScheduleEdge", () => {
  it("maps id/predecessor/type/lag straight across", () => {
    const row = {
      id: 1,
      processId: 20,
      predecessorId: 19,
      type: "START_TO_START_WITH_OVERLAP",
      lagDays: -3,
    } as JobProcessEdge;
    expect(jobEdgeToScheduleEdge(row)).toEqual({
      processId: 20,
      predecessorId: 19,
      type: "START_TO_START_WITH_OVERLAP",
      lagDays: -3,
    });
  });
});

/**
 * Invariant #1 as a property: no request schema accepts an actual_* or *_at
 * key. Every schema is `.strict()`, so a smuggled timestamp key is rejected
 * as unknown rather than silently dropped. We assert against a table of the
 * exact shapes a caller might try.
 */
describe("request schemas reject actual_*/*_at keys (invariant #1)", () => {
  const schemas: Record<string, { schema: z.ZodTypeAny; valid: Record<string, unknown> }> = {
    generateScheduleSchema: { schema: generateScheduleSchema, valid: { jobId: 1, mode: "FORWARD" } },
    startProcessSchema: { schema: startProcessSchema, valid: { processPlanId: 1 } },
    submitProcessSchema: { schema: submitProcessSchema, valid: { processPlanId: 1 } },
    verifyProcessSchema: { schema: verifyProcessSchema, valid: { processPlanId: 1 } },
    holdProcessSchema: { schema: holdProcessSchema, valid: { processPlanId: 1, reason: "furnace down" } },
    fileDelayReasonSchema: { schema: fileDelayReasonSchema, valid: { processPlanId: 1, categoryId: 2 } },
    applyDurationOverrideSchema: {
      schema: applyDurationOverrideSchema,
      valid: { jobId: 1, jobProcessId: 2, durationOverrideDays: 5, reason: "revised" },
    },
  };

  const badKeys = [
    "actual_start",
    "actualStart",
    "actual_finish",
    "actualFinish",
    "started_at",
    "finished_at",
    "created_at",
    "createdAt",
    "recorded_at",
    "updated_at",
  ];

  for (const [name, { schema, valid }] of Object.entries(schemas)) {
    it(`${name} accepts its valid shape`, () => {
      expect(schema.safeParse(valid).success).toBe(true);
    });

    it.each(badKeys)(`${name} rejects a %s key`, (badKey) => {
      const result = schema.safeParse({ ...valid, [badKey]: new Date().toISOString() });
      expect(result.success).toBe(false);
    });
  }
});

/**
 * The transactional helpers need a live tenant-scoped tx and seeded rows to
 * mean anything, so their behavioural tests live in the four service suites
 * (which set up jobs/plans/QCP data). Gated off by default; RUN_DB_TESTS=1
 * turns them on. This block only asserts the exports are wired — the seam
 * where those DB suites hang.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("DB-backed helpers (service suites extend)", () => {
  it("exports the transactional primitives", () => {
    for (const fn of [
      loadJobSpine,
      persistScheduleRun,
      getCurrentScheduleRun,
      lockProcessPlanForUpdate,
      assertNoUnfiledDelayBlock,
      assertNoOpenHoldPoint,
      assertUnitHasNoOpenNcr,
      assertUnitHasNoOpenHoldPoint,
      loadPredecessorStates,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });
});

/**
 * Per-unit predecessor isolation (grain P0.1). Uses the real DESPL-320 seed
 * spine (9 units, 36-process edges) — there is no ScheduleRun seeded for it,
 * so this test creates its own run + two ProcessPlan rows for the same
 * predecessor process against two different real units, inside the
 * withTenant transaction the app role writes through. Asserts
 * loadPredecessorStates resolves each unit's predecessor status from ITS OWN
 * plan row, not a shared job/equipment-grain one.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadPredecessorStates — per-unit isolation (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("unitA sees the predecessor COMPLETE while unitB sees NOT_STARTED", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");

    const edge = await owner.jobProcessEdge.findFirst({ where: { process: { jobId: job.id } } });
    if (!edge) throw new Error("seed missing DESPL-320 process edges — run pnpm db:seed");
    const predProcess = await owner.jobProcess.findUniqueOrThrow({ where: { id: edge.predecessorId } });

    const equipment = await owner.equipment.findFirstOrThrow({ where: { jobId: job.id } });
    const units = await owner.unit.findMany({
      where: { equipmentId: equipment.id },
      orderBy: { serialNo: "asc" },
      take: 2,
    });
    if (units.length < 2) throw new Error("seed missing DESPL-320 units — run pnpm db:seed");
    const [unitA, unitB] = units;

    await withTenant(job.tenantId, async (tx) => {
      const prevMax = await tx.scheduleRun.aggregate({
        _max: { version: true },
        where: { jobId: job.id, equipmentId: equipment.id },
      });
      const run = await tx.scheduleRun.create({
        data: {
          jobId: job.id,
          equipmentId: equipment.id,
          version: (prevMax._max.version ?? 0) + 1,
          mode: "FORWARD",
          projectStartDate: new Date(),
          isCurrent: false,
        },
      });

      await tx.processPlan.create({
        data: {
          jobId: job.id,
          scheduleRunId: run.id,
          jobProcessId: predProcess.id,
          unitId: unitA.id,
          ownerDepartmentId: predProcess.departmentId,
          status: "COMPLETE",
        },
      });
      await tx.processPlan.create({
        data: {
          jobId: job.id,
          scheduleRunId: run.id,
          jobProcessId: predProcess.id,
          unitId: unitB.id,
          ownerDepartmentId: predProcess.departmentId,
          status: "NOT_STARTED",
        },
      });

      const statesA = await loadPredecessorStates(tx, run.id, [edge.predecessorId], unitA.id);
      const statesB = await loadPredecessorStates(tx, run.id, [edge.predecessorId], unitB.id);

      expect(statesA.find((s) => s.predecessorId === edge.predecessorId)?.status).toBe("COMPLETE");
      expect(statesB.find((s) => s.predecessorId === edge.predecessorId)?.status).toBe("NOT_STARTED");
    });
  });
});

/**
 * Gate 3 fix: `OperationRef.leadTimeProcessSeq` used to be one tenant-wide
 * value — a physical operation (e.g. CUTTING) shared by two families could
 * only mean ONE lead-time-process number, silently wrong for whichever
 * family didn't author it. `OperationRefFamilySeq` makes the mapping
 * family-scoped. This test builds the adversarial case directly: one shared
 * `OperationRef`, mapped to a DIFFERENT number for each of two families —
 * proving `loadMappedOps` resolves strictly through the calling job's own
 * family, never the other one's number.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadMappedOps — family-scoped numeric join (Gate 3, DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("a family's mapped ComponentOperation is found only under its own leadTimeProcessSeq, never the other family's", async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-FAMILYSEQ-${Date.now()}`, name: "Family-scoped seq test" },
    });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "F", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "Client" } });

    const familyA = await owner.productFamily.create({ data: { tenantId, code: "FAMILY_A", name: "Family A" } });
    const familyB = await owner.productFamily.create({ data: { tenantId, code: "FAMILY_B", name: "Family B" } });

    // One physical operation, shared by both families — the exact scenario
    // the old bare-column design couldn't represent correctly.
    const cutting = await owner.operationRef.create({ data: { tenantId, code: "CUTTING", name: "Cutting" } });
    await owner.operationRefFamilySeq.createMany({
      data: [
        { tenantId, operationRefId: cutting.id, familyId: familyA.id, leadTimeProcessSeq: 5 },
        { tenantId, operationRefId: cutting.id, familyId: familyB.id, leadTimeProcessSeq: 9 },
      ],
    });

    const template = await owner.processTemplate.create({ data: { tenantId, familyId: familyA.id, name: "A template" } });
    const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-familyseq-${Date.now()}`,
        clientId: client.id,
        familyId: familyA.id,
        templateVersionId: version.id,
        jobNumber: `JOB-FAMILYSEQ-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel" } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "SR01" } });
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "SHELL", name: "Shell" } });
    const component = await owner.component.create({
      data: { jobId: job.id, equipmentId: equipment.id, unitId: unit.id, tag: "SHELL-1", componentTypeId: componentType.id },
    });
    await owner.componentOperation.create({
      data: { jobId: job.id, componentId: component.id, seq: 1, operationId: cutting.id, status: "IN_PROGRESS" },
    });

    // A JobProcess coded "9" — family B's real CUTTING number, NOT family
    // A's (5). Before this fix, the bare-column join would have matched the
    // shared OperationRef here regardless of family; the fix must find
    // nothing, because family A's own mapping for CUTTING is 5, not 9.
    const wrongCodeProcess = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 9, code: "9", name: "Wrong-family code", departmentId: dept.id },
    });
    // family A's real CUTTING number.
    const rightCodeProcess = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 5, code: "5", name: "Cutting", departmentId: dept.id },
    });

    await withTenant(tenantId, async (tx) => {
      const wrongMatch = await loadMappedOps(tx, { jobProcessId: wrongCodeProcess.id, unitId: unit.id });
      expect(wrongMatch).toEqual([]);

      const rightMatch = await loadMappedOps(tx, { jobProcessId: rightCodeProcess.id, unitId: unit.id });
      expect(rightMatch).toHaveLength(1);
      expect(rightMatch[0]).toMatchObject({ source: "fabrication", label: "Cutting", status: "IN_PROGRESS" });
    });
  });
});
