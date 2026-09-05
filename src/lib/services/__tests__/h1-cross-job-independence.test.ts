// src/lib/services/__tests__/h1-cross-job-independence.test.ts
//
// H1 acceptance test: "Project A vs Project B" — a deliberately-mismatched
// id from one job, passed into an operation scoped to another job in the
// SAME tenant, is refused. This is the concrete demonstration named in
// docs/mos-blueprint/execution/22_DESPL_MOS_BUILD_PLAN.md's H1 acceptance
// criterion, consolidating every Task 6-10 call site into one proof so it
// reads as a single coherent story instead of six scattered assertions.
//
// Adaptation note (documented per the plan's own instruction to adapt
// mechanically when the plan's wording doesn't match a function's real
// signature): `startComponentOperation` and `verifyAssemblyStep` each take
// only ONE foreign id (componentOperationId / assemblyStepId) — there is no
// second "actor's declared job context" parameter to mismatch against. Their
// real H1 backstop (already proven per-file in component.service.test.ts's
// "kitCrossJobOp" case and assembly.service.test.ts's mistagged-Ncr case) is
// that a query reached FROM that single id — a cross-linked BomItem, or an
// openNcrs lookup — can no longer wander into a different job's rows. Both
// are reproduced below against this file's own fixture rather than the
// literal "two independently-supplied ids" shape the plan sketched for every
// case.
import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("H1 — cross-job independence (Project A vs Project B)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { loadMappedOps } = await import("../_shared");
  const { startComponentOperation, submitComponentOperation, rejectComponentOperation } = await import(
    "../component.service"
  );
  const { startAssemblyStep, submitAssemblyStep, rejectAssemblyStep, verifyAssemblyStep } = await import(
    "../assembly.service"
  );
  const { closeNcr } = await import("../ncr.service");
  const { receiveStock, issueStock } = await import("../stock.service");
  const { createDrawingRevision } = await import("../drawing.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  afterAll(async () => {
    for (const tenantId of createdOrgIds) {
      await owner.stockTxn.deleteMany({ where: { stockLot: { bomItem: { job: { tenantId } } } } }).catch(() => {});
      await owner.stockLot.deleteMany({ where: { bomItem: { job: { tenantId } } } }).catch(() => {});
      await owner.componentOperationRejection.deleteMany({ where: { componentOperation: { job: { tenantId } } } }).catch(() => {});
      await owner.assemblyStepRejection.deleteMany({ where: { assemblyStep: { job: { tenantId } } } }).catch(() => {});
      await owner.ncr.deleteMany({ where: { job: { tenantId } } }).catch(() => {});
      await owner.componentOperation.deleteMany({ where: { job: { tenantId } } }).catch(() => {});
      await owner.assemblyStep.deleteMany({ where: { job: { tenantId } } }).catch(() => {});
      await owner.component.deleteMany({ where: { job: { tenantId } } }).catch(() => {});
      await owner.bomItem.deleteMany({ where: { job: { tenantId } } }).catch(() => {});
      await owner.drawingRevision.deleteMany({ where: { assemblyDrawing: { job: { tenantId } } } }).catch(() => {});
      await owner.assemblyDrawing.deleteMany({ where: { job: { tenantId } } }).catch(() => {});
      await owner.jobProcess.deleteMany({ where: { job: { tenantId } } }).catch(() => {});
      await owner.unit.deleteMany({ where: { job: { tenantId } } }).catch(() => {});
      await owner.equipment.deleteMany({ where: { job: { tenantId } } }).catch(() => {});
      await owner.job.deleteMany({ where: { tenantId } }).catch(() => {});
      await owner.processTemplateVersion.deleteMany({ where: { template: { tenantId } } }).catch(() => {});
      await owner.processTemplate.deleteMany({ where: { tenantId } }).catch(() => {});
      await owner.productFamily.deleteMany({ where: { tenantId } }).catch(() => {});
      await owner.assemblyTemplate.deleteMany({ where: { tenantId } }).catch(() => {});
      await owner.client.deleteMany({ where: { tenantId } }).catch(() => {});
      await owner.user.deleteMany({ where: { tenantId } }).catch(() => {});
      await owner.department.deleteMany({ where: { tenantId } }).catch(() => {});
      await owner.organization.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await owner.$disconnect();
  });

  /**
   * One tenant, two jobs (A, B), each with its own full mini-chain:
   * Equipment -> Unit -> Component -> ComponentOperation, an AssemblyStep,
   * a StockLot (via a BomItem), and an AssemblyDrawing — so every Task 6-10
   * call site has a real cross-job pair to test against.
   */
  async function fixture() {
    const org = await owner.organization.create({
      data: { code: `TEST-H1-XJ-${Date.now()}-${Math.random()}`, name: "h1 cross-job test" },
    });
    createdOrgIds.push(org.id);
    const tenantId = org.id;

    const dept = await owner.department.create({ data: { tenantId, code: "F", name: "Fabrication" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}-${Math.random()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "SHELL", name: "Shell" } });
    const operationRef = await owner.operationRef.create({
      data: { tenantId, code: "CUT-XJ", name: "Cutting", defaultDepartmentId: dept.id },
    });
    await owner.operationRefFamilySeq.create({
      data: { tenantId, operationRefId: operationRef.id, familyId: family.id, leadTimeProcessSeq: 5 },
    });
    const drawingType = await owner.drawingTypeRef.create({ data: { tenantId, code: "GA", name: "General Arrangement" } });
    const delayCategory = await owner.delayCategoryRef.create({ data: { tenantId, code: "REWORK", name: "Rework" } });
    const asmTemplate = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "A-XJ" } });
    const asmVersion = await owner.assemblyTemplateVersion.create({
      data: { templateId: asmTemplate.id, version: 1, status: "PUBLISHED" },
    });
    const ts1 = await owner.assemblyTemplateStep.create({
      data: {
        versionId: asmVersion.id,
        seq: 1,
        groupCode: "C",
        groupName: "Shell Prep",
        srNo: "1.1",
        activity: "Cross-job test step",
        kind: "WORK",
        defaultDepartmentId: dept.id,
      },
    });

    const userSup = await owner.user.create({
      data: { tenantId, email: `xj-sup-${Date.now()}@x`, username: `xj-sup-${Date.now()}`, name: "Sup", passwordHash: "x" },
    });
    const userQc = await owner.user.create({
      data: { tenantId, email: `xj-qc-${Date.now()}@x`, username: `xj-qc-${Date.now()}`, name: "Qc", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null, mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
    const sup: Actor = { ...base, userId: userSup.id, name: "Sup", email: userSup.email, roles: [ROLES.SUPERVISOR, ROLES.QC], departmentIds: [dept.id] };
    const qc: Actor = { ...base, userId: userQc.id, name: "Qc", email: userQc.email, roles: [ROLES.QC], departmentIds: [] };
    const ph: Actor = { ...sup, roles: [ROLES.PRODUCTION_HEAD, ROLES.SUPERVISOR] };

    async function makeJob(label: string) {
      const job = await owner.job.create({
        data: {
          tenantId,
          publicId: `pub-h1xj-${label}-${Date.now()}-${Math.random()}`,
          clientId: client.id,
          familyId: family.id,
          templateVersionId: tv.id,
          jobNumber: `DE-H1XJ-${label}-${Date.now()}-${Math.random()}`,
        },
      });
      const equipment = await owner.equipment.create({ data: { jobId: job.id, name: `Vessel ${label}` } });
      const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "01" } });
      const jobProcess = await owner.jobProcess.create({
        data: { jobId: job.id, seq: 5, code: "5", name: "Cutting", departmentId: dept.id },
      });
      const component = await owner.component.create({
        data: { jobId: job.id, equipmentId: equipment.id, unitId: unit.id, tag: `SHELL-${label}`, componentTypeId: componentType.id },
      });
      const componentOp = await owner.componentOperation.create({
        data: { jobId: job.id, componentId: component.id, seq: 1, operationId: operationRef.id },
      });
      const assemblyStep = await owner.assemblyStep.create({
        data: { unitId: unit.id, templateStepId: ts1.id, seq: 1, jobId: job.id },
      });
      const bomItem = await owner.bomItem.create({
        data: { jobId: job.id, equipmentId: equipment.id, itemNo: 1, partName: "Shell Course", sourceQty: "2 NOS.", qtyPer: 2, uom: "NOS." },
      });
      const drawing = await owner.assemblyDrawing.create({
        data: { jobId: job.id, drawingTypeId: drawingType.id, drawingNo: `GA-${label}` },
      });
      return { job, equipment, unit, jobProcess, component, componentOp, assemblyStep, bomItem, drawing };
    }

    const A = await makeJob("A");
    const B = await makeJob("B");
    return { tenantId, sup, qc, ph, delayCategory, A, B };
  }

  it("loadMappedOps: Job B's unit is invisible when scoped to Job A", async () => {
    const { tenantId, A, B } = await fixture();
    await withTenant(tenantId, async (tx) => {
      const wrongJob = await loadMappedOps(tx, { jobProcessId: A.jobProcess.id, unitId: B.unit.id, jobId: A.job.id });
      expect(wrongJob).toEqual([]);
    });
  });

  it("startComponentOperation: a Component.bomItemId cross-linked to Job B's BomItem is refused as NOT_FOUND, not read across", async () => {
    const { sup, A, B } = await fixture();
    // Simulate the exact "wrong job's row snuck onto a link" class of bug
    // this plan defends against — not reachable via any real app write.
    await owner.component.update({ where: { id: A.component.id }, data: { bomItemId: B.bomItem.id } });
    await expectCode(startComponentOperation(sup, { componentOperationId: A.componentOp.id }), ERROR_CODES.NOT_FOUND);
  });

  it("verifyAssemblyStep: a Job A step's own Ncr, mistagged with Job B's jobId, is invisible to the openNcrs lookup and survives unclosed", async () => {
    const { tenantId, sup, qc, delayCategory, A } = await fixture();
    await startAssemblyStep(sup, { assemblyStepId: A.assemblyStep.id });
    await submitAssemblyStep(sup, { assemblyStepId: A.assemblyStep.id });
    await rejectAssemblyStep(qc, { assemblyStepId: A.assemblyStep.id, categoryId: delayCategory.id, detail: "xj" });
    // Back to SUBMITTED so verify is legal again.
    await submitAssemblyStep(sup, { assemblyStepId: A.assemblyStep.id });
    const rejection = await owner.assemblyStepRejection.findFirstOrThrow({ where: { assemblyStepId: A.assemblyStep.id } });
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { assemblyStepRejectionId: rejection.id } });
    expect(ncr.jobId).toBe(A.job.id);
    // Simulate the mistagged row: same tenant, real OTHER job's id.
    const other = await owner.job.findFirstOrThrow({ where: { tenantId, NOT: { id: A.job.id } } });
    await owner.ncr.update({ where: { id: ncr.id }, data: { jobId: other.id } });

    const verified = await verifyAssemblyStep(qc, { assemblyStepId: A.assemblyStep.id });
    expect(verified.status).toBe("COMPLETE");
    const survived = await owner.ncr.findUniqueOrThrow({ where: { id: ncr.id } });
    expect(survived.status).toBe("OPEN"); // never reached/closed by the wrong-job scoped lookup
  });

  it("closeNcr: refuses a Job B ncrId under Job A context", async () => {
    const { tenantId, sup, qc, delayCategory, A, B } = await fixture();
    await startAssemblyStep(sup, { assemblyStepId: B.assemblyStep.id });
    await submitAssemblyStep(sup, { assemblyStepId: B.assemblyStep.id });
    await rejectAssemblyStep(qc, { assemblyStepId: B.assemblyStep.id, categoryId: delayCategory.id, detail: "b" });
    const rejection = await owner.assemblyStepRejection.findFirstOrThrow({ where: { assemblyStepId: B.assemblyStep.id } });
    const ncrB = await owner.ncr.findUniqueOrThrow({ where: { assemblyStepRejectionId: rejection.id } });
    expect(ncrB.jobId).toBe(B.job.id);

    await expectCode(
      withTenant(tenantId, (tx) => closeNcr(tx, qc, { ncrId: ncrB.id, jobId: A.job.id })),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("createStockTxn: refuses a Job B componentId against a Job A stockLotId", async () => {
    const { ph, A, B } = await fixture();
    const lotA = await receiveStock(ph, { bomItemId: A.bomItem.id, location: "Yard A", qty: 10 });
    await expectCode(
      issueStock(ph, { stockLotId: lotA.id, qty: 1, componentId: B.component.id }),
      ERROR_CODES.VALIDATION_FAILED,
    );
  });

  it("createDrawingRevision: refuses a Job B assemblyDrawingId under Job A context", async () => {
    const { sup, A, B } = await fixture();
    const admin: Actor = { ...sup, roles: [ROLES.ADMIN] };
    await expectCode(
      createDrawingRevision(admin, { jobId: A.job.id, assemblyDrawingId: B.drawing.id, revisionNo: 1, status: "RELEASED" }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("control: every one of the above SUCCEEDS when ids and context genuinely agree", async () => {
    const { tenantId, sup, qc, ph, delayCategory, A } = await fixture();

    // loadMappedOps: A's own unit against A's own jobProcess/jobId.
    await withTenant(tenantId, async (tx) => {
      const ok = await loadMappedOps(tx, { jobProcessId: A.jobProcess.id, unitId: A.unit.id, jobId: A.job.id });
      expect(ok).toHaveLength(1);
      expect(ok[0]).toMatchObject({ source: "fabrication", status: "NOT_STARTED" });
    });

    // startComponentOperation: no cross-job link — genuinely un-linked BomItem
    // is a SEAM no-op, so the start itself succeeds.
    const started = await startComponentOperation(sup, { componentOperationId: A.componentOp.id });
    expect(started.status).toBe("IN_PROGRESS");

    // verifyAssemblyStep: reject then verify within the SAME job — the real
    // Ncr it opens is genuinely closed (never mistagged).
    await startAssemblyStep(sup, { assemblyStepId: A.assemblyStep.id });
    await submitAssemblyStep(sup, { assemblyStepId: A.assemblyStep.id });
    await rejectAssemblyStep(qc, { assemblyStepId: A.assemblyStep.id, categoryId: delayCategory.id, detail: "ctl" });
    await submitAssemblyStep(sup, { assemblyStepId: A.assemblyStep.id });
    const rejection = await owner.assemblyStepRejection.findFirstOrThrow({ where: { assemblyStepId: A.assemblyStep.id } });
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { assemblyStepRejectionId: rejection.id } });
    const verified = await verifyAssemblyStep(qc, { assemblyStepId: A.assemblyStep.id });
    expect(verified.status).toBe("COMPLETE");
    const closed = await owner.ncr.findUniqueOrThrow({ where: { id: ncr.id } });
    expect(closed.status).toBe("CLOSED");

    // closeNcr: a fresh Ncr closed under its OWN job's id succeeds. (Uses the
    // rejectComponentOperation path for variety, exercising the sibling
    // component.service call site alongside the assembly.service one above.
    // The op is already IN_PROGRESS from `started` above.)
    await submitComponentOperation(sup, { componentOperationId: A.componentOp.id });
    await rejectComponentOperation(qc, { componentOperationId: A.componentOp.id, categoryId: delayCategory.id, detail: "ctl2" });
    const opRejection = await owner.componentOperationRejection.findFirstOrThrow({ where: { componentOperationId: A.componentOp.id } });
    const opNcr = await owner.ncr.findUniqueOrThrow({ where: { componentOperationRejectionId: opRejection.id } });
    const directClose = await withTenant(tenantId, (tx) => closeNcr(tx, qc, { ncrId: opNcr.id, jobId: A.job.id }));
    expect(directClose.status).toBe("CLOSED");

    // createStockTxn: componentId genuinely in the lot's own job succeeds.
    const lot = await receiveStock(ph, { bomItemId: A.bomItem.id, location: "Yard A", qty: 10 });
    const txn = await issueStock(ph, { stockLotId: lot.id, qty: 1, componentId: A.component.id });
    expect(txn.componentId).toBe(A.component.id);

    // createDrawingRevision: assemblyDrawingId genuinely in the declared job succeeds.
    const admin: Actor = { ...sup, roles: [ROLES.ADMIN] };
    const rev = await createDrawingRevision(admin, { jobId: A.job.id, assemblyDrawingId: A.drawing.id, revisionNo: 1, status: "RELEASED" });
    expect(rev.status).toBe("RELEASED");
  });
});
