import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES } from "@/lib/shared/errors";
import { createJob, updateJobDetails, setJobStatus } from "./job-intake.service";
import type { CreateJobInput } from "@/lib/shared/schemas";

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

function input(over: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    clientId: 1,
    familyId: 1,
    templateVersionId: 1,
    calendarId: null,
    jobNumber: "TEST-001",
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
    qcpTemplateSourceId: null,
    copyBomFromEquipmentId: null,
    ...over,
  } as CreateJobInput;
}

describe("job-intake.service — pure refusals", () => {
  it.each([
    ["SUPERVISOR", ROLES.SUPERVISOR],
    ["QC", ROLES.QC],
    ["MANAGEMENT", ROLES.MANAGEMENT],
  ])("refuses a %s caller (RBAC deny-by-default)", async (_label, role) => {
    await expect(createJob(actor({ roles: [role] }), input())).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  it("refuses a client user before touching the DB", async () => {
    await expect(
      createJob(actor({ clientId: 5, roles: [ROLES.CLIENT_VIEWER] }), input()),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("refuses a target dispatch date later than the committed date", async () => {
    await expect(
      createJob(
        actor(),
        input({
          committedDeliveryDate: new Date("2026-10-01"),
          targetDispatchDate: new Date("2026-11-01"),
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses a job with no equipment block", async () => {
    await expect(createJob(actor(), input({ equipments: [] }))).rejects.toThrow();
  });

  it("refuses an equipment block with duplicate serials", async () => {
    await expect(
      createJob(
        actor(),
        input({
          equipments: [
            { equipmentTypeId: null, name: "V", blockNo: 1, remarks: null, serials: ["A", "A"] },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a smuggled actual_* field via the strict schema (invariant #1)", async () => {
    await expect(
      // @ts-expect-error — .strict() schema; no actual_* field exists on this input
      createJob(actor(), { ...input(), actualStart: new Date() }),
    ).rejects.toThrow();
  });
});

describe("job-intake.service — updateJobDetails pure refusals", () => {
  it.each([
    ["SUPERVISOR", ROLES.SUPERVISOR],
    ["QC", ROLES.QC],
    ["MANAGEMENT", ROLES.MANAGEMENT],
  ])("refuses a %s caller (RBAC deny-by-default)", async (_label, role) => {
    await expect(
      updateJobDetails(actor({ roles: [role] }), { jobId: 1, clientOrderNo: null, projectName: null, poRef: null, designCode: null, priority: "NORMAL", remarks: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("refuses a client user before touching the DB", async () => {
    await expect(
      updateJobDetails(actor({ clientId: 5, roles: [ROLES.CLIENT_VIEWER] }), {
        jobId: 1,
        clientOrderNo: null,
        projectName: null,
        poRef: null,
        designCode: null,
        priority: "NORMAL",
        remarks: null,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("rejects a smuggled actual_* field via the strict schema (invariant #1)", async () => {
    await expect(
      updateJobDetails(actor(), {
        jobId: 1,
        clientOrderNo: null,
        projectName: null,
        poRef: null,
        designCode: null,
        priority: "NORMAL",
        remarks: null,
        // @ts-expect-error — .strict() schema; no actual_* field exists on this input
        actualStart: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!process.env.RUN_DB_TESTS)("job-intake.service — createJob (DB)", async () => {
  // Fixture setup/verification reads and writes go through a table-owner
  // client (DIRECT_URL), not the RLS-scoped `@/lib/db` singleton — several
  // tables this suite reads (clients, product_families, process_templates,
  // jobs, audit_log) are tenant-root RLS tables that fail CLOSED outside a
  // withTenant() transaction, so a bare app-role query here would silently
  // see zero rows instead of the fixtures. Same pattern as
  // portfolio.read.test.ts / process.service.test.ts.
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const created: number[] = [];

  async function seedRefs() {
    const version = await owner.processTemplateVersion.findFirstOrThrow({
      // Scoped to tenant 1 — every actor() in this file defaults to
      // tenantId: 1, and this query has no other tenant boundary of its
      // own. Unscoped, it can pick a different tenant's PRESSURE_VESSEL
      // template (a real failure mode once other DB-gated test files
      // accumulate their own throwaway PRESSURE_VESSEL fixtures).
      where: { status: "PUBLISHED", template: { tenantId: 1, family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
      include: { template: true },
    });
    const client = await owner.client.findFirstOrThrow({ where: { tenantId: 1 } });
    return { version, client, familyId: version.template.familyId };
  }

  function base(over: Partial<CreateJobInput>, refs: Awaited<ReturnType<typeof seedRefs>>): CreateJobInput {
    return input({
      clientId: refs.client.id,
      familyId: refs.familyId,
      templateVersionId: refs.version.id,
      ...over,
    });
  }

  // Job's FK children are NOT uniformly onDelete: Cascade (Equipment, Unit,
  // BomItem and QcpTemplate are not — only JobProcess/JobProcessEdge/
  // ScheduleRun/AssemblyDrawing/DispatchBatch are), so a bare `job.delete`
  // fails on the FK and the swallowed `.catch` used to leave every test job
  // behind in despl_test. Delete createJob's own writes bottom-up first.
  async function deleteJobAndChildren(id: number) {
    // Component's and AssemblyStep's equipmentId/unitId FKs are not
    // onDelete: Cascade (only their own children cascade off them) — must
    // go before bomItem/unit.
    await owner.component.deleteMany({ where: { equipment: { jobId: id } } });
    await owner.assemblyStep.deleteMany({ where: { unit: { equipment: { jobId: id } } } });
    // ProcessPlan.jobProcessId is onDelete: RESTRICT — Postgres's cascade
    // ordering races Job→JobProcess(cascade) against
    // Job→ScheduleRun(cascade)→ProcessPlan(cascade), and the RESTRICT check
    // on job_processes can fire before process_plans is gone, blocking the
    // whole delete (S19's setJobStatus tests are the first in this file to
    // create ProcessPlan rows directly). Delete explicitly, before job.delete.
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

  it("materialises the full spine: every process and every edge", async () => {
    const refs = await seedRefs();
    const expectedProcesses = await owner.templateProcess.count({ where: { versionId: refs.version.id } });
    const expectedEdges = await owner.templateEdge.count({ where: { versionId: refs.version.id } });

    const r = await createJob(actor(), base({ jobNumber: "TEST-SPINE-1" }, refs));
    created.push(r.jobId);

    expect(r.processCount).toBe(expectedProcesses);
    expect(await owner.jobProcess.count({ where: { jobId: r.jobId } })).toBe(expectedProcesses);
    expect(await owner.jobProcessEdge.count({ where: { process: { jobId: r.jobId } } })).toBe(expectedEdges);

    // Every edge's endpoints belong to THIS job — the id-mapping bug this catches
    // would otherwise wire a new job's edges to another job's processes.
    const ownIds = new Set(
      (await owner.jobProcess.findMany({ where: { jobId: r.jobId }, select: { id: true } })).map((p) => p.id),
    );
    const edges = await owner.jobProcessEdge.findMany({ where: { process: { jobId: r.jobId } } });
    for (const e of edges) {
      expect(ownIds.has(e.processId)).toBe(true);
      expect(ownIds.has(e.predecessorId)).toBe(true);
    }
  });

  // H1 (Task 2A, Cluster 2): createJob populates jobId on every materialised Unit.
  it("createJob populates jobId on every materialised Unit", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-H1-UNIT-JOBID" }, refs));
    created.push(r.jobId);

    const units = await owner.unit.findMany({ where: { equipment: { jobId: r.jobId } } });
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((u) => u.jobId === r.jobId)).toBe(true);
  });

  it("copies durations, envelope offsets and provisional verbatim rather than defaulting them", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-COPY-1" }, refs));
    created.push(r.jobId);

    const tps = await owner.templateProcess.findMany({ where: { versionId: refs.version.id } });
    const jps = await owner.jobProcess.findMany({ where: { jobId: r.jobId } });
    const jpByCode = new Map(jps.map((p) => [p.code, p]));
    for (const tp of tps) {
      const jp = jpByCode.get(tp.code)!;
      expect(jp.durationMinDays).toBe(tp.durationMinDays);
      expect(jp.durationMaxDays).toBe(tp.durationMaxDays);
      expect(jp.envelopeFinishByMaxDays).toBe(tp.envelopeFinishByMaxDays);
      expect(jp.provisional).toBe(tp.provisional);
      expect(jp.workOrderStages).toEqual(tp.workOrderStages);
    }
  });

  it("keeps excluded processes AND their edges, marked included: false", async () => {
    const refs = await seedRefs();
    const someCode = (await owner.templateProcess.findFirstOrThrow({
      where: { versionId: refs.version.id, seq: 10 },
    })).code;

    const r = await createJob(actor(), base({ jobNumber: "TEST-EXCL-1", excludedProcessCodes: [someCode] }, refs));
    created.push(r.jobId);

    const excluded = await owner.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: someCode } });
    expect(excluded.included).toBe(false);
    // Durations retained: bypassExcluded needs duration(X) to compose the bridge lag.
    expect(excluded.durationMaxDays).not.toBeNull();
    const stillWired = await owner.jobProcessEdge.count({
      where: { OR: [{ processId: excluded.id }, { predecessorId: excluded.id }] },
    });
    expect(stillWired).toBeGreaterThan(0);
  });

  it("gives the job a uuid publicId, not something derivable from its id", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-PUB-1" }, refs));
    created.push(r.jobId);
    // The regex above already proves publicId is UUID-shaped, not a
    // sequential/derivable encoding of jobId — that's what "not derivable"
    // means here. A `not.toContain(String(r.jobId))` substring check was
    // removed: for any single-digit id (0-9, the common case for the first
    // few jobs in a fresh DB), a 32-hex-char UUID contains that digit with
    // very high probability, making the assertion flaky by construction
    // rather than a real signal.
    expect(r.publicId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("refuses a duplicate job number", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-DUP-1" }, refs));
    created.push(r.jobId);
    await expect(createJob(actor(), base({ jobNumber: "TEST-DUP-1" }, refs))).rejects.toMatchObject({
      code: ERROR_CODES.DUPLICATE_JOB_NUMBER,
    });
  });

  it("refuses a DRAFT template version even though the dropdown would have hidden it", async () => {
    const refs = await seedRefs();
    const draft = await owner.processTemplateVersion.findFirst({
      where: { status: "DRAFT", template: { tenantId: 1 } },
    });
    if (!draft) return; // seed has a DRAFT pipe-spool version; skip if that changes
    await expect(
      createJob(actor(), base({ jobNumber: "TEST-DRAFT-1", templateVersionId: draft.id }, refs)),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_VERSION_NOT_PUBLISHED });
  });

  it("refuses a template version belonging to another product family", async () => {
    const refs = await seedRefs();
    const otherFamily = await owner.productFamily.findFirstOrThrow({
      where: { tenantId: 1, id: { not: refs.familyId } },
    });
    await expect(
      createJob(actor(), base({ jobNumber: "TEST-FAM-1", familyId: otherFamily.id }, refs)),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
  });

  it("refuses a cross-tenant client with NOT_FOUND, not a leak", async () => {
    const refs = await seedRefs();
    await expect(
      createJob(actor({ tenantId: 999 }), base({ jobNumber: "TEST-TEN-1" }, refs)),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });

  it("writes exactly one audit row, in the same transaction", async () => {
    const refs = await seedRefs();
    const before = await owner.auditLog.count({ where: { action: "job.create" } });
    const r = await createJob(actor(), base({ jobNumber: "TEST-AUDIT-1" }, refs));
    created.push(r.jobId);
    expect(await owner.auditLog.count({ where: { action: "job.create" } })).toBe(before + 1);
  });

  it("notifies every responsible department's supervisors + other Production Heads, but not the creator", async () => {
    const refs = await seedRefs();
    const ph = await owner.user.findFirstOrThrow({
      where: { tenantId: 1, active: true, roles: { some: { role: { code: "PRODUCTION_HEAD" } } } },
    });

    const r = await createJob(
      actor({ userId: ph.id, name: ph.name, email: ph.email, roles: [ROLES.PRODUCTION_HEAD] }),
      base({ jobNumber: "TEST-NOTIFY-1" }, refs),
    );
    created.push(r.jobId);

    const deptIds = [
      ...new Set(
        (await owner.templateProcess.findMany({ where: { versionId: refs.version.id }, select: { defaultDepartmentId: true } })).map(
          (p) => p.defaultDepartmentId,
        ),
      ),
    ];
    const supervisorIds = (
      await owner.user.findMany({
        where: { tenantId: 1, active: true, departments: { some: { departmentId: { in: deptIds } } } },
        select: { id: true },
      })
    ).map((u) => u.id);
    const otherPhIds = (
      await owner.user.findMany({
        where: { tenantId: 1, active: true, roles: { some: { role: { code: "PRODUCTION_HEAD" } } }, id: { not: ph.id } },
        select: { id: true },
      })
    ).map((u) => u.id);
    const expectedRecipients = new Set([...supervisorIds, ...otherPhIds].filter((id) => id !== ph.id));

    const notifs = await owner.notification.findMany({ where: { type: "JOB_CREATED", entityType: "Job", entityId: r.jobId } });
    expect(new Set(notifs.map((n) => n.recipientId))).toEqual(expectedRecipients);
    expect(notifs.every((n) => n.recipientId !== ph.id)).toBe(true);
  });

  it("rolls back everything when the transaction fails part-way", async () => {
    const refs = await seedRefs();
    const auditBefore = await owner.auditLog.count({ where: { action: "job.create" } });
    // A serial longer than any sane column forces a failure AFTER the job and
    // its processes are written, proving the rollback covers all of it.
    await expect(
      createJob(
        actor(),
        base(
          {
            jobNumber: "TEST-ROLLBACK-1",
            copyBomFromEquipmentId: 2_000_000_000, // no such equipment → NOT_FOUND late in the tx
          },
          refs,
        ),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });

    expect(await owner.job.count({ where: { jobNumber: "TEST-ROLLBACK-1" } })).toBe(0);
    expect(await owner.auditLog.count({ where: { action: "job.create" } })).toBe(auditBefore);
  });

  it("clones a QCP template's items and rebuilds process links by code", async () => {
    const refs = await seedRefs();
    const sourceQcp = await owner.qcpTemplate.findFirstOrThrow({
      where: { items: { some: { processLinks: { some: {} } } } },
      include: { _count: { select: { items: true, parties: true } } },
    });

    const r = await createJob(actor(), base({ jobNumber: "TEST-QCP-1", qcpTemplateSourceId: sourceQcp.id }, refs));
    created.push(r.jobId);

    const copy = await owner.qcpTemplate.findFirstOrThrow({
      where: { jobId: r.jobId },
      include: { _count: { select: { items: true, parties: true } } },
    });
    expect(copy._count.items).toBe(sourceQcp._count.items);
    expect(copy._count.parties).toBe(sourceQcp._count.parties);

    // H1: cloneQcpTemplate populates jobId on InspectionParty/QcpItem for a real-job clone.
    const newParties = await owner.inspectionParty.findMany({ where: { qcpTemplateId: copy.id } });
    expect(newParties.length).toBeGreaterThan(0);
    expect(newParties.every((p) => p.jobId === r.jobId)).toBe(true);
    const newItems = await owner.qcpItem.findMany({ where: { qcpTemplateId: copy.id } });
    expect(newItems.length).toBeGreaterThan(0);
    expect(newItems.every((i) => i.jobId === r.jobId)).toBe(true);

    // Links resolve against the NEW job's processes.
    const links = await owner.qcpItemProcess.findMany({
      where: { qcpItem: { qcpTemplateId: copy.id } },
      include: { jobProcess: { select: { jobId: true } } },
    });
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.jobProcess.jobId).toBe(r.jobId);
    // H1: cloneQcpTemplate populates jobId on QcpItemProcess too.
    expect(links.every((l) => l.jobId === r.jobId)).toBe(true);

    // No execution results carried over.
    expect(
      await owner.qcpExecution.count({ where: { qcpItem: { qcpTemplateId: copy.id } } }),
    ).toBe(0);
  });

  it("copies BOM lines but no procurement or traceability records", async () => {
    const refs = await seedRefs();
    const sourceEquipment = await owner.equipment.findFirstOrThrow({
      // Scoped to tenant 1 (via job) — unscoped, this can pick another
      // tenant's fixture equipment out of the shared DB-gated test database.
      where: { job: { tenantId: 1 }, bomItems: { some: {} } },
      include: { _count: { select: { bomItems: true } } },
    });

    const r = await createJob(
      actor(),
      base({ jobNumber: "TEST-BOM-1", copyBomFromEquipmentId: sourceEquipment.id }, refs),
    );
    created.push(r.jobId);

    expect(r.bomItemCount).toBe(sourceEquipment._count.bomItems);
    const newEquipment = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
    // H1: copyBom populates jobId on every copied BomItem.
    const newBomItems = await owner.bomItem.findMany({ where: { equipmentId: newEquipment.id } });
    expect(newBomItems.length).toBeGreaterThan(0);
    expect(newBomItems.every((b) => b.jobId === r.jobId)).toBe(true);
    expect(await owner.bomItem.count({ where: { equipmentId: newEquipment.id } })).toBe(
      sourceEquipment._count.bomItems,
    );
    expect(
      await owner.procurementEvent.count({ where: { bomItem: { equipmentId: newEquipment.id } } }),
    ).toBe(0);
    expect(
      await owner.materialIdentification.count({ where: { bomItem: { equipmentId: newEquipment.id } } }),
    ).toBe(0);
  });

  it("S16: materialises Component + ComponentOperation for typed BOM lines copied at intake", async () => {
    const refs = await seedRefs();
    // Any BomItem with a componentTypeId that has a PUBLISHED RouteTemplateVersion —
    // the seeded route library (prisma/seed.ts §8) applies to every family (familyId: null).
    const typedBomItem = await owner.bomItem.findFirstOrThrow({
      // Scoped to tenant 1 (via job) — unscoped, this can pick a BomItem
      // belonging to some other DB-gated test file's fixture tenant, which
      // `createJob(actor() /* tenantId: 1 */, ...)` then can't see, causing
      // a NOT_FOUND on Equipment inside copyBom (the exact failure this
      // scoping fixes — real, observed, not hypothetical).
      where: { job: { tenantId: 1 }, componentTypeId: { not: null } },
      include: { equipment: { include: { _count: { select: { bomItems: true } } } } },
    });
    const sourceEquipment = typedBomItem.equipment;

    const r = await createJob(
      actor(),
      base({ jobNumber: "TEST-COMP-1", copyBomFromEquipmentId: sourceEquipment.id }, refs),
    );
    created.push(r.jobId);

    const newEquipment = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
    const newComponents = await owner.component.findMany({
      where: { equipmentId: newEquipment.id },
      include: { operations: true, bomItem: true },
    });

    expect(newComponents.length).toBe(r.componentCount);
    expect(newComponents.length).toBeGreaterThan(0);
    for (const c of newComponents) {
      expect(c.bomItemId).not.toBeNull();
      expect(c.bomItem!.equipmentId).toBe(newEquipment.id); // not the source equipment's BomItem row
      expect(c.operations.length).toBeGreaterThan(0);
      // H1: materializeComponentsFromBomItems populates jobId on Component + ComponentOperation.
      expect(c.jobId).toBe(r.jobId);
      for (const op of c.operations) {
        expect(op.status).toBe("NOT_STARTED");
        expect(op.jobId).toBe(r.jobId);
      }
    }
  });

  it("S17: materialises AssemblyStep per unit and pins the job's AssemblyTemplateVersion", async () => {
    const refs = await seedRefs();
    const qcpSource = await owner.qcpTemplate.findFirstOrThrow({ where: { job: { jobNumber: "DESPL-320" } } });
    const asmVersion = await owner.assemblyTemplateVersion.findFirstOrThrow({
      where: { template: { tenantId: 1, familyId: refs.familyId }, status: "PUBLISHED" },
      orderBy: { version: "desc" },
      include: { steps: true },
    });

    const r = await createJob(
      actor(),
      base(
        {
          jobNumber: "TEST-ASM-1",
          qcpTemplateSourceId: qcpSource.id,
          equipments: [{ equipmentTypeId: null, name: "Vessel", blockNo: 1, remarks: null, serials: ["U1", "U2"] }],
        },
        refs,
      ),
    );
    created.push(r.jobId);

    const inspectionStepCount = asmVersion.steps.filter((s) => s.kind === "INSPECTION").length;
    expect(r.assemblyStepCount).toBe(asmVersion.steps.length * 2);

    const job = await owner.job.findUniqueOrThrow({ where: { id: r.jobId } });
    expect(job.assemblyTemplateVersionId).toBe(asmVersion.id);

    const newSteps = await owner.assemblyStep.findMany({
      where: { unit: { equipment: { jobId: r.jobId } } },
      include: { templateStep: true, qcpItem: true },
    });
    expect(newSteps.length).toBe(asmVersion.steps.length * 2);
    // H1: materializeAssemblyStepsFromTemplate populates jobId on every created AssemblyStep.
    expect(newSteps.every((s) => s.jobId === r.jobId)).toBe(true);

    const boundInspectionSteps = newSteps.filter((s) => s.templateStep.kind === "INSPECTION" && s.qcpItemId != null);
    expect(boundInspectionSteps.length).toBe(inspectionStepCount * 2); // every INSPECTION step resolves — 0 mismatches verified against real seed data
    for (const s of boundInspectionSteps) expect(s.qcpItem!.qcpTemplateId).not.toBe(qcpSource.id); // bound to the NEW job's cloned QcpItem, not the source's

    for (const s of newSteps) {
      if (s.templateStep.kind === "WORK") expect(s.qcpItemId).toBeNull();
    }
  });

  it("copyBom preserves a parent/child BOM hierarchy (fix wave, Important #4)", async () => {
    const refs = await seedRefs();

    // Own source equipment (not the generic seed data, which has no
    // hierarchy) — a real job/equipment via the service itself, then a
    // parent + child BomItem written directly, itemNo as the stable key.
    const sourceJob = await createJob(actor(), base({ jobNumber: "TEST-BOM-HIER-SRC" }, refs));
    created.push(sourceJob.jobId);
    const sourceEquipment = await owner.equipment.findFirstOrThrow({ where: { jobId: sourceJob.jobId } });

    const parent = await owner.bomItem.create({
      data: { jobId: sourceJob.jobId, equipmentId: sourceEquipment.id, itemNo: 101, partName: "Sub-assembly", sourceQty: "2 NOS.", qtyPer: 2, uom: "NOS." },
    });
    const child = await owner.bomItem.create({
      data: {
        jobId: sourceJob.jobId,
        equipmentId: sourceEquipment.id,
        itemNo: 102,
        partName: "Bolt",
        sourceQty: "4 NOS.",
        qtyPer: 4,
        uom: "NOS.",
        parentBomItemId: parent.id,
      },
    });

    const r = await createJob(
      actor(),
      base({ jobNumber: "TEST-BOM-HIER-DST", copyBomFromEquipmentId: sourceEquipment.id }, refs),
    );
    created.push(r.jobId);

    const targetEquipment = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
    const copiedParent = await owner.bomItem.findFirstOrThrow({ where: { equipmentId: targetEquipment.id, itemNo: parent.itemNo } });
    const copiedChild = await owner.bomItem.findFirstOrThrow({ where: { equipmentId: targetEquipment.id, itemNo: child.itemNo } });

    expect(copiedParent.id).not.toBe(parent.id); // a real copy, not the source row
    expect(copiedChild.parentBomItemId).toBe(copiedParent.id); // points at the COPIED parent...
    expect(copiedChild.parentBomItemId).not.toBe(parent.id); // ...never the source's
    expect(copiedChild.parentBomItemId).not.toBeNull();
  });

  it("stores only spec keys defined for the family", async () => {
    const refs = await seedRefs();
    const r = await createJob(
      actor(),
      base({ jobNumber: "TEST-SPECS-1", specs: { designPressure: "10.5", bogus: "x" } }, refs),
    );
    created.push(r.jobId);
    const job = await owner.job.findUniqueOrThrow({ where: { id: r.jobId } });
    expect(job.specs).toEqual({ designPressure: 10.5 });
  });

  // ── S19: setJobStatus ────────────────────────────────────────────────

  async function makeScheduleRun(jobId: number, planStatuses: ("NOT_STARTED" | "COMPLETE")[]) {
    const jobProcesses = await owner.jobProcess.findMany({ where: { jobId }, orderBy: { seq: "asc" } });
    const run = await owner.scheduleRun.create({
      data: { jobId, version: 1, mode: "FORWARD", projectStartDate: new Date("2026-01-01"), isCurrent: true },
    });
    for (let i = 0; i < planStatuses.length; i++) {
      const jp = jobProcesses[i];
      await owner.processPlan.create({
        data: {
          jobId,
          scheduleRunId: run.id,
          jobProcessId: jp.id,
          ownerDepartmentId: jp.departmentId,
          status: planStatuses[i],
        },
      });
    }
    return run.id;
  }

  it("setJobStatus: refuses ADMIN/PRODUCTION_HEAD-only actions from a SUPERVISOR", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-STATUS-RBAC" }, refs));
    created.push(r.jobId);
    await expect(
      setJobStatus(actor({ roles: [ROLES.SUPERVISOR] }), { jobId: r.jobId, status: "ON_HOLD" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("setJobStatus: ON_HOLD and CANCELLED are unguarded even with incomplete plans", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-STATUS-UNGUARDED" }, refs));
    created.push(r.jobId);
    await makeScheduleRun(r.jobId, ["NOT_STARTED", "NOT_STARTED"]);

    const held = await setJobStatus(actor(), { jobId: r.jobId, status: "ON_HOLD" });
    expect(held.status).toBe("ON_HOLD");
    const cancelled = await setJobStatus(actor(), { jobId: r.jobId, status: "CANCELLED" });
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("setJobStatus: COMPLETE is refused while a ProcessPlan on the current ScheduleRun is not COMPLETE", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-STATUS-INCOMPLETE" }, refs));
    created.push(r.jobId);
    await makeScheduleRun(r.jobId, ["COMPLETE", "NOT_STARTED"]);

    await expect(setJobStatus(actor(), { jobId: r.jobId, status: "COMPLETE" })).rejects.toMatchObject({
      code: ERROR_CODES.JOB_HAS_INCOMPLETE_PLANS,
    });
  });

  it("setJobStatus: COMPLETE succeeds once every ProcessPlan on the current run is COMPLETE, and is audited", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-STATUS-COMPLETE" }, refs));
    created.push(r.jobId);
    await makeScheduleRun(r.jobId, ["COMPLETE", "COMPLETE"]);

    const auditBefore = await owner.auditLog.count({ where: { entityType: "Job", entityId: String(r.jobId), action: "job.setStatus" } });
    const updated = await setJobStatus(actor(), { jobId: r.jobId, status: "COMPLETE" });
    expect(updated.status).toBe("COMPLETE");
    const job = await owner.job.findUniqueOrThrow({ where: { id: r.jobId } });
    expect(job.status).toBe("COMPLETE");
    expect(
      await owner.auditLog.count({ where: { entityType: "Job", entityId: String(r.jobId), action: "job.setStatus" } }),
    ).toBe(auditBefore + 1);
  });

  it("setJobStatus: a PROCESS PLAN on a NON-current (superseded) run never blocks COMPLETE", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-STATUS-OLDRUN" }, refs));
    created.push(r.jobId);
    const staleRunId = await makeScheduleRun(r.jobId, ["NOT_STARTED"]); // will be flipped non-current below
    await owner.scheduleRun.update({ where: { id: staleRunId }, data: { isCurrent: false } });
    await makeScheduleRun(r.jobId, ["COMPLETE", "COMPLETE"]); // the real current run, fully complete

    const updated = await setJobStatus(actor(), { jobId: r.jobId, status: "COMPLETE" });
    expect(updated.status).toBe("COMPLETE");
  });

  it("setJobStatus: setting the same status again is a no-op (no audit row)", async () => {
    const refs = await seedRefs();
    const r = await createJob(actor(), base({ jobNumber: "TEST-STATUS-NOOP" }, refs));
    created.push(r.jobId);
    const auditBefore = await owner.auditLog.count({ where: { entityType: "Job", entityId: String(r.jobId), action: "job.setStatus" } });
    const result = await setJobStatus(actor(), { jobId: r.jobId, status: "ACTIVE" }); // already ACTIVE by default
    expect(result.status).toBe("ACTIVE");
    expect(
      await owner.auditLog.count({ where: { entityType: "Job", entityId: String(r.jobId), action: "job.setStatus" } }),
    ).toBe(auditBefore);
  });
});
