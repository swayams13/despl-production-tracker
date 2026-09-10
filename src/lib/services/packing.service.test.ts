import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * S6 — packing.service.ts had no test file at all. Covers the role gate
 * added to createPackage/assignUnitToPackage (dispatch.service.test.ts
 * already covers cross-tenant/cross-job refusals for these two, driven
 * through this service's exports).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("packing.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createPackage, assignUnitToPackage } = await import("./packing.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
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
      data: { code: `TEST-PACKING-${Date.now()}-${Math.random()}`, name: "packing test" },
    });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({
      data: { tenantId, name: "ACME", code: `ACME-${Date.now()}-${Math.random()}` },
    });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-packing-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-PACKING-${Date.now()}-${Math.random()}`,
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
    return { tenantId, job, unit, user };
  }

  /** S10 — opens an Ncr against the fixture's unit via a real
   * ComponentOperationRejection chain (component -> operation -> rejection
   * -> Ncr), the same chain assertUnitHasNoOpenNcr reads. */
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

  /** S10 — a blocking QCP checkpoint on the fixture's job with no cleared
   * execution for the unit, the same chain assertUnitHasNoOpenHoldPoint reads. */
  async function openHoldPoint(tenantId: number, job: { id: number }) {
    const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId: job.id, jobLabel: "V", vessel: "V" } });
    const party = await owner.inspectionParty.create({ data: { qcpTemplateId: qcpTemplate.id, tenantId, code: "QC" } });
    const qcpCode = await owner.qcpCodeRef.create({
      data: { tenantId, code: "H", label: "Hold", blocksCompletion: true },
    });
    const qcpItem = await owner.qcpItem.create({
      data: { qcpTemplateId: qcpTemplate.id, tenantId, sequence: 1, srNo: "1", kind: "CHECKPOINT", activity: "Weld visual" },
    });
    await owner.qcpItemPartyCode.create({
      data: { qcpItemId: qcpItem.id, inspectionPartyId: party.id, qcpCodeId: qcpCode.id, tenantId },
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

  it("createPackage + assignUnitToPackage succeed for a Production Head", async () => {
    const { tenantId, job, unit, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-1" });
    const updated = await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });
    expect(updated.packageId).toBe(pkg.id);
  });

  it("createPackage refuses a non-Production-Head, non-Admin caller (FORBIDDEN)", async () => {
    const { tenantId, job, user } = await fixture();
    const supervisor = actorBase(tenantId, user.id, [ROLES.SUPERVISOR]);
    await expectCode(createPackage(supervisor, { jobId: job.id, packageNo: "PKG-1" }), ERROR_CODES.FORBIDDEN);
  });

  it("assignUnitToPackage refuses a non-Production-Head, non-Admin caller (FORBIDDEN)", async () => {
    const { tenantId, job, unit, user } = await fixture();
    const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
    const supervisor = actorBase(tenantId, user.id, [ROLES.SUPERVISOR]);
    const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-2" });
    await expectCode(
      assignUnitToPackage(supervisor, { packageId: pkg.id, unitId: unit.id }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  describe("S10 — reverse quality gate on assignUnitToPackage", () => {
    it("refuses a unit with an open Ncr (NCR_OPEN)", async () => {
      const { tenantId, job, unit, user } = await fixture();
      await openNcr(tenantId, job, unit, user);
      const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
      const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-NCR" });
      await expectCode(assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id }), ERROR_CODES.NCR_OPEN);
    });

    it("refuses a unit with an uncleared blocking hold point (HOLD_POINT_OPEN)", async () => {
      const { tenantId, job, unit, user } = await fixture();
      await openHoldPoint(tenantId, job);
      const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
      const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-HOLD" });
      await expectCode(
        assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id }),
        ERROR_CODES.HOLD_POINT_OPEN,
      );
    });

    it("a clean unit (no open Ncr, no blocking hold point) still packs", async () => {
      const { tenantId, job, unit, user } = await fixture();
      const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
      const pkg = await createPackage(ph, { jobId: job.id, packageNo: "PKG-CLEAN" });
      const updated = await assignUnitToPackage(ph, { packageId: pkg.id, unitId: unit.id });
      expect(updated.packageId).toBe(pkg.id);
    });

    /**
     * AUD-072 — genuine two-transaction race: the same unit assigned to two
     * different packages concurrently, both writing `Unit.packageId`. Before
     * this session, a concurrent write here at READ COMMITTED would just
     * silently last-writer-wins with no error. At RepeatableRead (this
     * session's change), whichever transaction's write lands second sees a
     * 40001 the moment it tries to update a row already changed since its
     * snapshot began — withSerializationRetry retries it transparently, so
     * the caller still never sees a raw Postgres error, and the final state
     * is deterministic (one package, not a corrupted mix).
     */
    it("AUD-072: assigning the same unit to two packages concurrently never crashes or corrupts state", async () => {
      const { tenantId, job, unit, user } = await fixture();
      const ph = actorBase(tenantId, user.id, [ROLES.PRODUCTION_HEAD]);
      const pkgA = await createPackage(ph, { jobId: job.id, packageNo: "PKG-RACE-A" });
      const pkgB = await createPackage(ph, { jobId: job.id, packageNo: "PKG-RACE-B" });

      const results = await Promise.allSettled([
        assignUnitToPackage(ph, { packageId: pkgA.id, unitId: unit.id }),
        assignUnitToPackage(ph, { packageId: pkgB.id, unitId: unit.id }),
      ]);
      // withSerializationRetry absorbs the 40001 transparently — neither
      // caller should see a raw serialization failure surfaced.
      for (const r of results) {
        if (r.status === "rejected") throw new Error(`unexpected rejection: ${String(r.reason)}`);
      }

      const finalUnit = await owner.unit.findUniqueOrThrow({ where: { id: unit.id } });
      expect([pkgA.id, pkgB.id]).toContain(finalUnit.packageId);
    });
  });
});
