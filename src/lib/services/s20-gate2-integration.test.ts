import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * S20 (Gate 2): `createJob → generateSchedule → importBomItems → procurement
 * → start/submit/verify → NCR`, through the REAL service entry points — the
 * gap this item exists to close (CLAUDE.md: "No test in this repo crosses
 * more than two of the seven workflow services").
 *
 * Runs against the real seeded PRESSURE_VESSEL tenant (tenantId 1) rather
 * than a from-scratch fixture org, on purpose: the point is to exercise the
 * REAL AssemblyTemplate/RouteTemplate/DelayCategoryRef library data S16/S17
 * depend on, not a hand-rolled substitute that could silently diverge from
 * what `pnpm db:seed` actually produces.
 *
 * Deliberately does NOT select a QCP template at createJob time (kept out of
 * scope here — S16/S17's own test files already cover that path in
 * isolation) — so no hold points apply to this job's processes, and the
 * process-plan leg of the chain isn't entangled with QCP-clearance mechanics.
 * The NCR leg instead comes from AssemblyStep (S17 materialises 54 real
 * steps regardless of whether a QCP template was chosen), independent of the
 * BOM/procurement leg — both real chains, exercised side by side in one job,
 * not causally dependent on each other.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("S20 — Gate 2 end-to-end integration (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const { createJob } = await import("./job-intake.service");
  const { generateSchedule } = await import("./schedule.service");
  const { importBomItems } = await import("./bom.service");
  const { recordProcurementEvent } = await import("./procurement.service");
  const { startProcess, submitProcess, verifyProcess } = await import("./process.service");
  const { startAssemblyStep, submitAssemblyStep, rejectAssemblyStep } = await import("./assembly.service");
  const { dispositionNcr } = await import("./ncr.service");

  const created: number[] = [];

  function actor(over: Partial<Actor> = {}): Actor {
    return {
      userId: 1, // admin@despl.local, real seeded user — FK'd by submittedBy/verifiedBy/rejectedBy
      tenantId: 1,
      clientId: null,
      name: "Admin",
      email: "admin@despl.test",
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
      ...over,
    };
  }
  const admin = actor();
  // qc@despl.local, real seeded user, distinct from admin — maker-checker needs a real different row.
  const qc = actor({ userId: 5, roles: [ROLES.QC] });

  async function deleteJobAndChildren(id: number) {
    await owner.assemblyStepRejection.deleteMany({ where: { assemblyStep: { unit: { equipment: { jobId: id } } } } });
    await owner.ncr.deleteMany({ where: { assemblyStepRejection: { assemblyStep: { unit: { equipment: { jobId: id } } } } } });
    await owner.assemblyStep.deleteMany({ where: { unit: { equipment: { jobId: id } } } });
    await owner.component.deleteMany({ where: { equipment: { jobId: id } } });
    await owner.processPlan.deleteMany({ where: { scheduleRun: { jobId: id } } });
    await owner.scheduleRun.deleteMany({ where: { jobId: id } });
    await owner.bomItem.deleteMany({ where: { equipment: { jobId: id } } });
    await owner.unit.deleteMany({ where: { equipment: { jobId: id } } });
    await owner.equipment.deleteMany({ where: { jobId: id } });
    await owner.qcpTemplate.deleteMany({ where: { jobId: id } });
    await owner.job.delete({ where: { id } });
  }

  afterAll(async () => {
    for (const id of created) {
      await deleteJobAndChildren(id).catch(() => {});
    }
    await owner.$disconnect();
  });

  it("createJob → generateSchedule → importBomItems → procurement → start/submit/verify → NCR, through real service entry points", async () => {
    const version = await owner.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
      include: { template: true },
    });
    const client = await owner.client.findFirstOrThrow({ where: { tenantId: 1 } });
    const rejectCategoryId = (
      await owner.delayCategoryRef.findFirstOrThrow({ where: { code: "REWORK_QUALITY" } })
    ).id;

    // ── 1. createJob (job-intake.service) ──────────────────────────────
    const r = await createJob(admin, {
      clientId: client.id,
      familyId: version.template.familyId,
      templateVersionId: version.id,
      calendarId: null,
      jobNumber: `TEST-S20-${Date.now()}`,
      clientOrderNo: null,
      projectName: "S20 integration",
      poRef: null,
      designCode: null,
      orderDate: null,
      committedDeliveryDate: null,
      targetDispatchDate: null,
      priority: "NORMAL",
      remarks: null,
      specs: null,
      excludedProcessCodes: [],
      exclusionReason: null,
      equipments: [{ equipmentTypeId: null, name: "S20 Vessel", blockNo: 1, remarks: null, serials: ["S20-U1"] }],
      qcpTemplateSourceId: null,
      copyBomFromEquipmentId: null,
    });
    created.push(r.jobId);
    expect(r.processCount).toBeGreaterThan(0);
    expect(r.assemblyStepCount).toBeGreaterThan(0); // S17: the real AssemblyTemplate materialised

    // ── 2. generateSchedule (schedule.service) ─────────────────────────
    // Start the plan "today" — a past projectStartDate would make the first
    // plan genuinely overdue and correctly trip assertNoUnfiledDelayBlock,
    // which is a different gate than the one this test exercises.
    const run = await generateSchedule(admin, {
      jobId: r.jobId,
      mode: "FORWARD",
      projectStartDate: new Date(),
    });
    expect(run.processPlans.length).toBeGreaterThan(0);

    // ── 3. importBomItems (bom.service) — the real BOM-entry path, ─────
    //      distinct from createJob's copyBom (S16's own test file already
    //      covers that path).
    const equipment = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
    const imported = await importBomItems(admin, {
      equipmentId: equipment.id,
      rows: [{ itemNo: 1, partName: "Gasket, S20 Integration Test", sourceQty: "10 NOS.", uom: "NOS." }],
    });
    expect(imported.failures).toHaveLength(0);
    expect(imported.created).toHaveLength(1);
    const bomItemId = imported.created[0].id;

    // ── 4. procurement (procurement.service) ────────────────────────────
    const event = await recordProcurementEvent(admin, { bomItemId, type: "INDENT_RAISED" });
    expect(event.type).toBe("INDENT_RAISED");
    expect(event.bomItemId).toBe(bomItemId);

    // ── 5. process start/submit/verify (process.service) ────────────────
    // The job's first process, seq 1 — no predecessors, no QCP template
    // chosen so no hold points, and gating.ts's assertCanStart lets a
    // seq-1 plan through immediately.
    const firstPlan = await owner.processPlan.findFirstOrThrow({
      where: { scheduleRun: { jobId: r.jobId, isCurrent: true } },
      orderBy: { jobProcess: { seq: "asc" } },
    });

    const started = await startProcess(admin, { processPlanId: firstPlan.id });
    expect(started.status).toBe("IN_PROGRESS");
    const submitted = await submitProcess(admin, { processPlanId: firstPlan.id });
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedBy).toBe(admin.userId);

    const verified = await verifyProcess(qc, { processPlanId: firstPlan.id });
    expect(verified.status).toBe("COMPLETE");
    expect(verified.verifiedBy).toBe(qc.userId);

    // ── 6. NCR (assembly.service + ncr.service) ──────────────────────────
    // First AssemblyStep (seq 1), independent chain from the process leg
    // above — S17 materialised it regardless of BOM/QCP choices.
    const firstStep = await owner.assemblyStep.findFirstOrThrow({
      where: { unit: { equipment: { jobId: r.jobId } } },
      orderBy: { seq: "asc" },
    });

    await startAssemblyStep(admin, { assemblyStepId: firstStep.id });
    await submitAssemblyStep(admin, { assemblyStepId: firstStep.id });

    const rejected = await rejectAssemblyStep(qc, {
      assemblyStepId: firstStep.id,
      categoryId: rejectCategoryId,
      detail: "S20 integration: deliberate reject to open a real NCR",
    });
    expect(rejected.status).toBe("IN_PROGRESS");
    expect(rejected.submittedBy).toBeNull();

    const rejection = await owner.assemblyStepRejection.findFirstOrThrow({
      where: { assemblyStepId: firstStep.id },
    });
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { assemblyStepRejectionId: rejection.id } });
    expect(ncr.status).toBe("OPEN");

    const disposed = await dispositionNcr(qc, { ncrId: ncr.id, disposition: "USE_AS_IS", notes: "S20 integration" });
    expect(disposed.status).toBe("DISPOSITIONED");
    expect(disposed.disposition).toBe("USE_AS_IS");

    // The whole chain left a real, queryable audit trail — invariant #5.
    const auditActions = await owner.auditLog.findMany({
      where: { tenantId: 1, entityType: { in: ["Job", "ProcessPlan", "AssemblyStep", "Ncr"] }, entityId: { in: [String(r.jobId), String(firstPlan.id), String(firstStep.id), String(ncr.id)] } },
      select: { action: true },
    });
    const actions = new Set(auditActions.map((a) => a.action));
    for (const expected of ["job.create", "process.start", "process.submit", "process.verify", "assemblyStep.start", "assemblyStep.submit", "assemblyStep.reject", "ncr.disposition"]) {
      expect(actions.has(expected), `expected audit action "${expected}" to have fired`).toBe(true);
    }
  });
});
