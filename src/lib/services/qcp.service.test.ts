import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * `recordQcpExecution` (Task 7) has no pure logic worth unit-testing in
 * isolation — it's a role gate + an attemptNo aggregate + a create, all of
 * which only mean something against real gating (assertNoOpenHoldPoint in
 * _shared.ts) and a real seeded QcpItem/QcpExecution chain. So this file is
 * DB-gated only, following process.service.test.ts's DESPL-320 block.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("recordQcpExecution (DB-backed, clears a real hold point)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { generateSchedule } = await import("./schedule.service");
  const { startProcess, submitProcess, verifyProcess } = await import("./process.service");
  const { recordQcpExecution } = await import("./qcp.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function planner(tenantId: number): Actor {
    return {
      userId: 1,
      tenantId,
      clientId: null,
      name: "PH",
      email: "ph@x",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  }

  async function despl320(): Promise<{ jobId: number; tenantId: number }> {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    return { jobId: job.id, tenantId: job.tenantId };
  }

  /** Look up a DESPL-320 job process by its stable template seq (1..36), not
   * its DB primary key — the seed's insertion order can shift across reseeds. */
  async function procId(jobId: number, seq: number): Promise<number> {
    const jp = await owner.jobProcess.findFirstOrThrow({ where: { jobId, seq } });
    return jp.id;
  }

  /** Every currently-linked blocking (blocksCompletion=true) QCP checkpoint on
   * a job process — looked up live, never hardcoded (matches
   * process.service.test.ts's per-unit hold-point block). */
  async function blockingQcpItemIds(jobProcessId: number): Promise<number[]> {
    const items = await owner.qcpItem.findMany({
      where: {
        processLinks: { some: { jobProcessId } },
        partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
      },
      select: { id: true },
    });
    return items.map((i) => i.id);
  }

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  const future = new Date(Date.now() + 30 * 864e5);

  it("recording ACCEPTED clears a genuinely open hold point so verify succeeds (#4)", async () => {
    const { jobId, tenantId } = await despl320();
    const a = planner(tenantId);

    // seq 1 (PO Receipt & Order Review) is a root process — no predecessors of
    // its own — and carries a real blocking checkpoint (seeded QcpItem 4), so
    // start→submit succeeds cleanly and the only thing standing between
    // SUBMITTED and COMPLETE is the uncleared hold point.
    const seq1Id = await procId(jobId, 1);
    const blocking = await blockingQcpItemIds(seq1Id);
    expect(blocking.length).toBeGreaterThan(0); // sanity: a real blocking checkpoint IS linked here

    // Use a unit process.service.test.ts's DB block never touches (it clears
    // QcpItem 4 for the FIRST unit only) — pick the third instead, so this
    // test's own hold point is genuinely open, not already cleared by a
    // sibling suite sharing this no-cleanup seed DB.
    const unit = (
      await owner.unit.findMany({ where: { equipment: { jobId } }, orderBy: { id: "asc" } })
    )[2];

    // Reset: QcpExecution is unit-scoped state with no end-of-suite cleanup
    // (matches this file's "no cleanup, disposable test DB" convention) — but
    // THIS test asserts a genuine before/after (HOLD_POINT_OPEN → cleared), so
    // it resets its own precondition at the start to stay rerun-safe.
    await owner.qcpExecution.deleteMany({ where: { unitId: unit.id, qcpItemId: { in: blocking } } });

    // Same reasoning for the ProcessPlan itself: persistScheduleRun now
    // carries real work forward across a reschedule (audit C1 fix) instead of
    // resetting it, so a rerun against this no-cleanup seed DB would otherwise
    // find seq1/unit[2] already SUBMITTED or COMPLETE from the run before.
    await owner.processPlan.updateMany({
      where: { scheduleRun: { jobId, isCurrent: true }, jobProcessId: seq1Id, unitId: unit.id },
      data: { status: "NOT_STARTED", actualStart: null, actualFinish: null, submittedBy: null, verifiedBy: null },
    });

    const run = await generateSchedule(a, { jobId, mode: "FORWARD", projectStartDate: future });
    const planId = run.processPlans.find((p) => p.jobProcessId === seq1Id && p.unitId === unit.id)!.id;

    const maker: Actor = a;
    const checker: Actor = { ...a, userId: 2, roles: [ROLES.QC] };

    await startProcess(maker, { processPlanId: planId });
    await submitProcess(maker, { processPlanId: planId });

    // RED: no QcpExecution recorded yet for this unit → verify refuses.
    await expectCode(verifyProcess(checker, { processPlanId: planId }), ERROR_CODES.HOLD_POINT_OPEN);

    const qcActor: Actor = { ...a, userId: 3, roles: [ROLES.QC] };
    for (const qcpItemId of blocking) {
      const exec = await recordQcpExecution(qcActor, {
        qcpItemId,
        unitId: unit.id,
        result: "ACCEPTED",
      });
      expect(exec.result).toBe("ACCEPTED");
      expect(exec.attemptNo).toBe(1);
      expect(exec.clearedBy).toBe(qcActor.userId);
      // H1: recordQcpExecution populates jobId from the unit's own jobId.
      expect(exec.jobId).toBe(jobId);
    }

    // GREEN: every blocking checkpoint is now ACCEPTED for this unit → verify succeeds.
    const verified = await verifyProcess(checker, { processPlanId: planId });
    expect(verified.status).toBe("COMPLETE");
  });

  it("client user is rejected — read-only, no exceptions (#1 access rule)", async () => {
    const { tenantId } = await despl320();
    // roles: [QC] so the ONLY thing that can throw FORBIDDEN here is
    // assertNotClientUser — if it were ever deleted, requireRole would still
    // pass and this test would catch the regression instead of masking it.
    const clientActor: Actor = { ...planner(tenantId), clientId: 1, roles: [ROLES.QC] };
    await expectCode(
      recordQcpExecution(clientActor, { qcpItemId: 1, unitId: 1, result: "ACCEPTED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("non-QC actor (e.g. SUPERVISOR) is rejected — recording an inspection result is a QC act", async () => {
    const { tenantId } = await despl320();
    const supervisor: Actor = { ...planner(tenantId), roles: [ROLES.SUPERVISOR] };
    await expectCode(
      recordQcpExecution(supervisor, { qcpItemId: 1, unitId: 1, result: "ACCEPTED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });
});

// ── QCP template authoring (C7) ────────────────────────────────────────────

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
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

describe("qcp.service — library authoring, pure refusals", () => {
  it.each([
    ["SUPERVISOR", ROLES.SUPERVISOR],
    ["QC", ROLES.QC],
    ["MANAGEMENT", ROLES.MANAGEMENT],
  ])("createQcpTemplateLibrary refuses a %s caller", async (_label, role) => {
    const { createQcpTemplateLibrary } = await import("./qcp.service");
    await expectRejects(
      createQcpTemplateLibrary(actor({ roles: [role] }), {
        jobLabel: "X",
        vessel: "Y",
        parties: [{ code: "DESPL" }],
      }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("createQcpTemplateLibrary refuses a client user before touching the DB", async () => {
    const { createQcpTemplateLibrary } = await import("./qcp.service");
    await expectRejects(
      createQcpTemplateLibrary(actor({ clientId: 5, roles: [ROLES.CLIENT_VIEWER] }), {
        jobLabel: "X",
        vessel: "Y",
        parties: [{ code: "DESPL" }],
      }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it.each([
    ["SUPERVISOR", ROLES.SUPERVISOR],
    ["QC", ROLES.QC],
  ])("addQcpItemToLibraryTemplate refuses a %s caller", async (_label, role) => {
    const { addQcpItemToLibraryTemplate } = await import("./qcp.service");
    await expectRejects(
      addQcpItemToLibraryTemplate(actor({ roles: [role] }), {
        qcpTemplateId: 1,
        sequence: 1,
        srNo: "1",
        kind: "CHECKPOINT",
        activity: "Inspect",
        libraryProcessCodes: [],
        partyCodes: [],
      }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("addQcpItemToLibraryTemplate refuses a client user before touching the DB", async () => {
    const { addQcpItemToLibraryTemplate } = await import("./qcp.service");
    await expectRejects(
      addQcpItemToLibraryTemplate(actor({ clientId: 5, roles: [ROLES.CLIENT_VIEWER] }), {
        qcpTemplateId: 1,
        sequence: 1,
        srNo: "1",
        kind: "CHECKPOINT",
        activity: "Inspect",
        libraryProcessCodes: [],
        partyCodes: [],
      }),
      ERROR_CODES.FORBIDDEN,
    );
  });
});

async function expectRejects(p: Promise<unknown>, expected: string): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  const { isAppError } = await import("@/lib/shared/errors");
  expect(isAppError(thrown) && thrown.code).toBe(expected);
}

describe.skipIf(!RUN_DB)("qcp.service — library authoring (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createQcpTemplateLibrary, addQcpItemToLibraryTemplate } = await import("./qcp.service");
  const { createJob } = await import("./job-intake.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdJobIds: number[] = [];
  const createdTemplateIds: number[] = [];

  afterAll(async () => {
    for (const id of createdJobIds) {
      await owner.qcpTemplate.deleteMany({ where: { jobId: id } });
      await owner.equipment.deleteMany({ where: { jobId: id } }).catch(() => {});
      await owner.job.delete({ where: { id } }).catch(() => {});
    }
    for (const id of createdTemplateIds) {
      await owner.qcpTemplate.delete({ where: { id } }).catch(() => {});
    }
    await owner.$disconnect();
  });

  it("authors a from-scratch library template + item, then clones it into a real job, producing a real QcpItemProcess linked to the new job's process coded 12", async () => {
    const template = await createQcpTemplateLibrary(actor(), {
      jobLabel: "C7 library QCP",
      vessel: "Test Vessel",
      parties: [{ code: "DESPL", name: "DESPL QC" }],
    });
    createdTemplateIds.push(template.id);
    expect(template.jobId).toBeNull();

    const item = await addQcpItemToLibraryTemplate(actor(), {
      qcpTemplateId: template.id,
      sequence: 1,
      srNo: "1",
      kind: "CHECKPOINT",
      activity: "Dimensional check",
      libraryProcessCodes: ["12"],
      partyCodes: [{ partyCode: "DESPL", qcpCode: "H" }],
    });
    expect(item.libraryProcessCodes).toEqual(["12"]);

    const stored = await owner.qcpItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.libraryProcessCodes).toEqual(["12"]);
    expect(await owner.qcpItemProcess.count({ where: { qcpItemId: item.id } })).toBe(0);

    const version = await owner.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
      include: { template: true },
    });
    const client = await owner.client.findFirstOrThrow({ where: { tenantId: 1 } });

    // PRESSURE_VESSEL also has a PUBLISHED AssemblyTemplateVersion (S17), and
    // createJob unconditionally tries to bind every INSPECTION step to a
    // QcpItem sharing its srNo once ANY qcpTemplateId is cloned in — an
    // orthogonal feature this test must satisfy to reach the QcpItemProcess
    // assertion below, not something libraryProcessCodes changes.
    //
    // materializeAssemblyStepsFromTemplate's occurrence index is counted
    // across EVERY step sharing an srNo (WORK steps included, not just
    // INSPECTION ones) — so the stub QcpItems must be created one-per-step
    // in that same srNo-bearing step order for the indices to line up, even
    // though only the INSPECTION steps ever get resolved against them.
    const asmVersion = await owner.assemblyTemplateVersion.findFirstOrThrow({
      where: { template: { tenantId: 1, familyId: version.template.familyId }, status: "PUBLISHED" },
      orderBy: { version: "desc" },
      include: { steps: { orderBy: { seq: "asc" } } },
    });
    const srNoBearingSteps = asmVersion.steps.filter((s) => s.srNo);
    await owner.qcpItem.createMany({
      data: srNoBearingSteps.map((s, i) => ({
        qcpTemplateId: template.id,
        sequence: 1000 + i,
        srNo: s.srNo!,
        kind: "CHECKPOINT" as const,
        activity: "Assembly inspection stub",
      })),
    });

    const r = await createJob(actor(), {
      clientId: client.id,
      familyId: version.template.familyId,
      templateVersionId: version.id,
      calendarId: null,
      jobNumber: `TEST-C7-QCP-${Date.now()}`,
      clientOrderNo: null,
      projectName: null,
      poRef: null,
      designCode: null,
      orderDate: null,
      committedDeliveryDate: null,
      targetDispatchDate: null,
      priority: "NORMAL",
      remarks: null,
      specs: null,
      excludedProcessCodes: [],
      equipments: [{ equipmentTypeId: null, name: "Vessel", blockNo: 1, remarks: null, serials: ["SR01"] }],
      qcpTemplateSourceId: template.id,
      copyBomFromEquipmentId: null,
    });
    createdJobIds.push(r.jobId);
    expect(r.unmatchedQcpProcessCodes).toEqual([]);

    const jobProcess12 = await owner.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: "12" } });
    const clonedTemplate = await owner.qcpTemplate.findFirstOrThrow({ where: { jobId: r.jobId } });
    const clonedItem = await owner.qcpItem.findFirstOrThrow({
      where: { qcpTemplateId: clonedTemplate.id, activity: "Dimensional check" },
    });

    const link = await owner.qcpItemProcess.findUniqueOrThrow({
      where: { qcpItemId_jobProcessId: { qcpItemId: clonedItem.id, jobProcessId: jobProcess12.id } },
    });
    expect(link.jobProcessId).toBe(jobProcess12.id);
  });

  it("refuses to add an item to a job-owned template — authoring is library-only", async () => {
    const jobOwnedTemplate = await owner.qcpTemplate.findFirstOrThrow({ where: { jobId: { not: null } } });
    await expectRejects(
      addQcpItemToLibraryTemplate(actor(), {
        qcpTemplateId: jobOwnedTemplate.id,
        sequence: 999,
        srNo: "999",
        kind: "CHECKPOINT",
        activity: "Should be refused",
        libraryProcessCodes: [],
        partyCodes: [],
      }),
      ERROR_CODES.VALIDATION_FAILED,
    );
  });
});
