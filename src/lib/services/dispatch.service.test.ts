import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import {
  deriveDispatchBatchStatus,
  assertDispatchBatchTransition,
  type DispatchBatchStatus,
} from "./dispatch.service";

/**
 * D2/D3 (Phase 5) — dispatch batch state machine + DB-backed workflow.
 *
 * `deriveDispatchBatchStatus`/`assertDispatchBatchTransition` are pure — no
 * DB needed (controller ruling: status is derived from
 * releaseApprovedAt/actualDispatchDate rather than a persisted column, so
 * these two functions ARE the state machine and are worth testing in
 * isolation, same as state-machine.test.ts does for the generic helper).
 */
describe("deriveDispatchBatchStatus (pure)", () => {
  const cases: Array<{
    name: string;
    batch: { releaseApprovedAt: Date | null; actualDispatchDate: Date | null };
    expected: DispatchBatchStatus;
  }> = [
    { name: "neither set", batch: { releaseApprovedAt: null, actualDispatchDate: null }, expected: "PLANNED" },
    {
      name: "releaseApprovedAt set, actualDispatchDate not",
      batch: { releaseApprovedAt: new Date(), actualDispatchDate: null },
      expected: "RELEASED",
    },
    {
      name: "both set",
      batch: { releaseApprovedAt: new Date(), actualDispatchDate: new Date() },
      expected: "DISPATCHED",
    },
    {
      // Shouldn't happen via this service's own writes, but the derivation
      // must still resolve deterministically rather than throw.
      name: "actualDispatchDate set, releaseApprovedAt not (defensive)",
      batch: { releaseApprovedAt: null, actualDispatchDate: new Date() },
      expected: "DISPATCHED",
    },
  ];

  for (const { name, batch, expected } of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(deriveDispatchBatchStatus(batch)).toBe(expected);
    });
  }
});

describe("assertDispatchBatchTransition (pure)", () => {
  it("approveRelease: PLANNED -> RELEASED is legal", () => {
    expect(assertDispatchBatchTransition("approveRelease", "PLANNED")).toBe("RELEASED");
  });

  it("approveRelease: refuses from RELEASED (already approved)", () => {
    const err = ((): unknown => {
      try {
        assertDispatchBatchTransition("approveRelease", "RELEASED");
      } catch (e) {
        return e;
      }
    })();
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
  });

  it("approveRelease: refuses from DISPATCHED", () => {
    const err = ((): unknown => {
      try {
        assertDispatchBatchTransition("approveRelease", "DISPATCHED");
      } catch (e) {
        return e;
      }
    })();
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
  });

  it("recordDispatch: RELEASED -> DISPATCHED is legal", () => {
    expect(assertDispatchBatchTransition("recordDispatch", "RELEASED")).toBe("DISPATCHED");
  });

  it("recordDispatch: refuses from PLANNED (before approveDispatchRelease)", () => {
    const err = ((): unknown => {
      try {
        assertDispatchBatchTransition("recordDispatch", "PLANNED");
      } catch (e) {
        return e;
      }
    })();
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
  });

  it("recordDispatch: refuses from DISPATCHED (already dispatched)", () => {
    const err = ((): unknown => {
      try {
        assertDispatchBatchTransition("recordDispatch", "DISPATCHED");
      } catch (e) {
        return e;
      }
    })();
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
  });
});

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("dispatch.service + packing.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createDispatchBatch, addUnitToBatch, approveDispatchRelease, recordDispatch } = await import(
    "./dispatch.service"
  );
  const { createPackage, assignUnitToPackage } = await import("./packing.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.dispatchBatchUnit.deleteMany({ where: { dispatchBatch: { job: { tenantId } } } });
    await owner.dispatchBatch.deleteMany({ where: { job: { tenantId } } });
    await owner.ncr.deleteMany({ where: { componentOperationRejection: { componentOperation: { component: { equipment: { job: { tenantId } } } } } } });
    await owner.componentOperationRejection.deleteMany({ where: { componentOperation: { component: { equipment: { job: { tenantId } } } } } });
    await owner.componentOperation.deleteMany({ where: { component: { equipment: { job: { tenantId } } } } });
    await owner.component.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.componentTypeRef.deleteMany({ where: { tenantId } });
    await owner.operationRef.deleteMany({ where: { tenantId } });
    await owner.delayCategoryRef.deleteMany({ where: { tenantId } });
    await owner.qcpItemPartyCode.deleteMany({ where: { qcpItem: { qcpTemplate: { job: { tenantId } } } } });
    await owner.qcpItem.deleteMany({ where: { qcpTemplate: { job: { tenantId } } } });
    await owner.inspectionParty.deleteMany({ where: { qcpTemplate: { job: { tenantId } } } });
    await owner.qcpCodeRef.deleteMany({ where: { tenantId } });
    await owner.qcpTemplate.deleteMany({ where: { job: { tenantId } } });
    await owner.unit.updateMany({ where: { equipment: { job: { tenantId } } }, data: { packageId: null } });
    await owner.package.deleteMany({ where: { job: { tenantId } } });
    await owner.unit.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.equipment.deleteMany({ where: { job: { tenantId } } });
    await owner.job.deleteMany({ where: { tenantId } });
    await owner.processTemplateVersion.deleteMany({ where: { template: { tenantId } } });
    await owner.processTemplate.deleteMany({ where: { tenantId } });
    await owner.productFamily.deleteMany({ where: { tenantId } });
    await owner.client.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.organization.delete({ where: { id: tenantId } });
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await deleteOrgAndChildren(id).catch(() => {});
    }
    await owner.$disconnect();
  });

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  async function fixture() {
    const org = await owner.organization.create({
      data: { code: `TEST-DISPATCH-${Date.now()}-${Math.random()}`, name: "dispatch test" },
    });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}-${Math.random()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-dispatch-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-DISPATCH-${Date.now()}-${Math.random()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "01" } });
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `ph-${Date.now()}-${Math.random()}@test.local`,
        username: `ph-${Date.now()}-${Math.random()}`,
        passwordHash: "x",
        name: "Test PH",
        themePreference: "SYSTEM",
      },
    });
    return { tenantId, job, equipment, unit, user, client, family };
  }

  /** S10 — opens an Ncr against the given unit via a real
   * ComponentOperationRejection chain, the same chain assertUnitHasNoOpenNcr reads. */
  async function openNcr(tenantId: number, job: { id: number }, unit: { id: number }, user: { id: number }) {
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const operation = await owner.operationRef.create({ data: { tenantId, code: "CUTTING", name: "Cutting" } });
    const equipment = await owner.equipment.findFirstOrThrow({ where: { jobId: job.id } });
    const component = await owner.component.create({
      data: { jobId: job.id, equipmentId: equipment.id, unitId: unit.id, tag: "SHELL-1", componentTypeId: componentType.id },
    });
    const componentOperation = await owner.componentOperation.create({
      data: { jobId: job.id, componentId: component.id, seq: 1, operationId: operation.id },
    });
    const category = await owner.delayCategoryRef.create({ data: { tenantId, code: "REWORK", name: "Rework" } });
    const rejection = await owner.componentOperationRejection.create({
      data: { jobId: job.id, componentOperationId: componentOperation.id, categoryId: category.id, rejectedBy: user.id },
    });
    await owner.ncr.create({ data: { jobId: job.id, componentOperationRejectionId: rejection.id, status: "OPEN" } });
  }

  /** S10 — a blocking QCP checkpoint on the given job with no cleared
   * execution for the unit, the same chain assertUnitHasNoOpenHoldPoint reads. */
  async function openHoldPoint(tenantId: number, job: { id: number }) {
    const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId: job.id, jobLabel: "V", vessel: "V" } });
    const party = await owner.inspectionParty.create({ data: { qcpTemplateId: qcpTemplate.id, code: "QC" } });
    const qcpCode = await owner.qcpCodeRef.create({
      data: { tenantId, code: "H", label: "Hold", blocksCompletion: true },
    });
    const qcpItem = await owner.qcpItem.create({
      data: { qcpTemplateId: qcpTemplate.id, sequence: 1, srNo: "1", kind: "CHECKPOINT", activity: "Weld visual" },
    });
    await owner.qcpItemPartyCode.create({
      data: { qcpItemId: qcpItem.id, inspectionPartyId: party.id, qcpCodeId: qcpCode.id },
    });
  }

  function actorBase(tenantId: number, userId: number, roles: string[] = []): Actor {
    return {
      userId,
      tenantId,
      clientId: null,
      name: "Test",
      email: "t@x",
      roles: roles as never,
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM" as const,
      outdoorMode: false,
    };
  }

  it("packs a unit, batches it, releases (Production Head), and dispatches — full happy path", async () => {
    const { tenantId, job, unit, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);

    const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-1" });
    await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });

    const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await addUnitToBatch(ph, { dispatchBatchId: batch.id, unitId: unit.id });

    // H1: addUnitToBatch populates jobId on the created DispatchBatchUnit.
    const dbu = await owner.dispatchBatchUnit.findFirst({ where: { dispatchBatchId: batch.id, unitId: unit.id } });
    expect(dbu?.jobId).toBe(batch.jobId);

    const released = await approveDispatchRelease(ph, { dispatchBatchId: batch.id, vehicleNo: "MH-01-AB-1234" });
    expect(released.releaseApprovedAt).not.toBeNull();
    expect(released.releaseApprovedBy).toBe(ph.userId);

    const dispatched = await recordDispatch(ph, { dispatchBatchId: batch.id });
    expect(dispatched.actualDispatchDate).not.toBeNull();
  });

  it("createDispatchBatch refuses a non-Production-Head, non-Admin caller (FORBIDDEN)", async () => {
    const { tenantId, job, user } = await fixture();
    const supervisor = actorBase(tenantId, user.id, [ROLES.SUPERVISOR]);
    await expectCode(
      createDispatchBatch(supervisor, { jobId: job.id, seq: 1, plannedDate: new Date() }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("addUnitToBatch refuses a non-Production-Head, non-Admin caller (FORBIDDEN)", async () => {
    const { tenantId, job, unit, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const supervisor = actorBase(tenantId, user.id, [ROLES.SUPERVISOR]);
    const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-GATE" });
    await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });
    const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await expectCode(
      addUnitToBatch(supervisor, { dispatchBatchId: batch.id, unitId: unit.id }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("recordDispatch refuses a non-Production-Head, non-Admin caller (FORBIDDEN)", async () => {
    const { tenantId, job, unit, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const supervisor = actorBase(tenantId, user.id, [ROLES.SUPERVISOR]);
    const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-GATE-2" });
    await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });
    const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await addUnitToBatch(ph, { dispatchBatchId: batch.id, unitId: unit.id });
    await approveDispatchRelease(ph, { dispatchBatchId: batch.id });
    await expectCode(recordDispatch(supervisor, { dispatchBatchId: batch.id }), ERROR_CODES.FORBIDDEN);
  });

  it("addUnitToBatch refuses an unpacked unit (UNIT_NOT_PACKED)", async () => {
    const { tenantId, job, unit, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await expectCode(addUnitToBatch(ph, { dispatchBatchId: batch.id, unitId: unit.id }), ERROR_CODES.UNIT_NOT_PACKED);
  });

  it("recordDispatch before approveDispatchRelease is refused (INVALID_STATE_TRANSITION)", async () => {
    const { tenantId, job, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await expectCode(recordDispatch(ph, { dispatchBatchId: batch.id }), ERROR_CODES.INVALID_STATE_TRANSITION);
  });

  it("approveDispatchRelease twice is refused (INVALID_STATE_TRANSITION)", async () => {
    const { tenantId, job, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await approveDispatchRelease(ph, { dispatchBatchId: batch.id });
    await expectCode(
      approveDispatchRelease(ph, { dispatchBatchId: batch.id }),
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });

  it("approveDispatchRelease refuses a non-Production-Head, non-Admin caller (FORBIDDEN)", async () => {
    const { tenantId, job, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const supervisor = actorBase(tenantId, user.id, [ROLES.SUPERVISOR]);
    const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await expectCode(approveDispatchRelease(supervisor, { dispatchBatchId: batch.id }), ERROR_CODES.FORBIDDEN);
  });

  it("assignUnitToPackage refuses a cross-job pairing (CROSS_JOB_ASSIGNMENT)", async () => {
    const { tenantId, job, unit, user, client, family } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    // A SECOND job in the SAME tenant — isolates the same-tenant, different-job
    // case (cross-tenant is covered separately below, which resolves to NOT_FOUND
    // instead since the package/unit isn't even visible to the wrong tenant).
    const otherJob = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-dispatch-xjob-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: job.templateVersionId,
        jobNumber: `DE-DISPATCH-XJOB-${Date.now()}-${Math.random()}`,
      },
    });
    const otherJobPkg = await owner.package.create({
      data: { jobId: otherJob.id, packageNo: "PKG-X", createdBy: user.id },
    });
    await expectCode(
      assignUnitToPackage(ph, { packageId: otherJobPkg.id, unitId: unit.id }),
      ERROR_CODES.CROSS_JOB_ASSIGNMENT,
    );
  });

  it("cross-tenant: assignUnitToPackage refuses another tenant's package/unit", async () => {
    const { tenantId, unit, user } = await fixture();
    const victim = await fixture();
    const attacker = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const victimPh = actorBase(victim.tenantId, victim.user.id, [ROLES.PRODUCTION_HEAD]);
    const victimPkg = await createPackage(victimPh, { jobId: victim.job.id, packageNo: "PKG-V" });

    await expectCode(
      assignUnitToPackage(attacker, { packageId: victimPkg.id, unitId: unit.id }),
      ERROR_CODES.NOT_FOUND,
    );
    await expectCode(
      assignUnitToPackage(attacker, { packageId: victimPkg.id, unitId: victim.unit.id }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("addUnitToBatch refuses a cross-job pairing (CROSS_JOB_ASSIGNMENT)", async () => {
    const { tenantId, job, user, client, family } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    // A SECOND job/equipment/unit in the SAME tenant, packed into its own
    // package — isolates the same-tenant, different-job case (mirrors
    // assignUnitToPackage's cross-job test above).
    const otherJob = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-dispatch-b-xjob-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: job.templateVersionId,
        jobNumber: `DE-DISPATCH-B-XJOB-${Date.now()}-${Math.random()}`,
      },
    });
    const otherEquipment = await owner.equipment.create({ data: { jobId: otherJob.id, name: "Air Receiver" } });
    const otherUnit = await owner.unit.create({ data: { jobId: otherJob.id, equipmentId: otherEquipment.id, serialNo: "01" } });
    const otherPkg = await owner.package.create({
      data: { jobId: otherJob.id, packageNo: "PKG-B-X", createdBy: user.id },
    });
    await owner.unit.update({ where: { id: otherUnit.id }, data: { packageId: otherPkg.id } });

    const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await expectCode(
      addUnitToBatch(ph, { dispatchBatchId: batch.id, unitId: otherUnit.id }),
      ERROR_CODES.CROSS_JOB_ASSIGNMENT,
    );
  });

  it("addUnitToBatch refuses once the batch is no longer PLANNED (RELEASED)", async () => {
    const { tenantId, job, unit, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);

    const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-REL" });
    await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });

    const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
    await addUnitToBatch(ph, { dispatchBatchId: batch.id, unitId: unit.id });
    await approveDispatchRelease(ph, { dispatchBatchId: batch.id });

    // A second unit, packed and ready, but the batch has already moved past
    // PLANNED — must not be retroactively addable into the approved set.
    const equipment2 = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver 2" } });
    const unit2 = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment2.id, serialNo: "02" } });
    await owner.unit.update({ where: { id: unit2.id }, data: { packageId: pkg.id } });

    await expectCode(
      addUnitToBatch(ph, { dispatchBatchId: batch.id, unitId: unit2.id }),
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });

  it("cross-tenant: addUnitToBatch refuses another tenant's dispatch batch/unit", async () => {
    const { tenantId, user } = await fixture();
    const victim = await fixture();
    const attacker = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const victimPh = actorBase(victim.tenantId, victim.user.id, [ROLES.PRODUCTION_HEAD]);
    const victimBatch = await createDispatchBatch(victimPh, {
      jobId: victim.job.id,
      seq: 1,
      plannedDate: new Date(),
    });

    await expectCode(
      addUnitToBatch(attacker, { dispatchBatchId: victimBatch.id, unitId: victim.unit.id }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("recordDispatchSchema/approveDispatchReleaseSchema never accept actualDispatchDate/releaseApprovedAt from input (schema-level)", async () => {
    const { recordDispatchSchema, approveDispatchReleaseSchema } = await import("@/lib/shared/schemas");
    expect(() =>
      recordDispatchSchema.parse({ dispatchBatchId: 1, actualDispatchDate: new Date().toISOString() }),
    ).toThrow();
    expect(() =>
      approveDispatchReleaseSchema.parse({ dispatchBatchId: 1, releaseApprovedAt: new Date().toISOString() }),
    ).toThrow();
  });

  describe("S10 — reverse quality gate on addUnitToBatch", () => {
    it("refuses a packed unit with an open Ncr (NCR_OPEN)", async () => {
      const { tenantId, job, unit, user } = await fixture();
      const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
      const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-NCR" });
      await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });
      await openNcr(tenantId, job, unit, user);
      const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
      await expectCode(
        addUnitToBatch(ph, { dispatchBatchId: batch.id, unitId: unit.id }),
        ERROR_CODES.NCR_OPEN,
      );
    });

    it("refuses a packed unit with an uncleared blocking hold point (HOLD_POINT_OPEN)", async () => {
      const { tenantId, job, unit, user } = await fixture();
      const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
      const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-HOLD" });
      await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });
      await openHoldPoint(tenantId, job);
      const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
      await expectCode(
        addUnitToBatch(ph, { dispatchBatchId: batch.id, unitId: unit.id }),
        ERROR_CODES.HOLD_POINT_OPEN,
      );
    });

    it("a clean packed unit (no open Ncr, no blocking hold point) still adds to the batch", async () => {
      const { tenantId, job, unit, user } = await fixture();
      const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
      const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-CLEAN" });
      await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });
      const batch = await createDispatchBatch(ph, { jobId: job.id, seq: 1, plannedDate: new Date() });
      const link = await addUnitToBatch(ph, { dispatchBatchId: batch.id, unitId: unit.id });
      expect(link.unitId).toBe(unit.id);
    });
  });
});
