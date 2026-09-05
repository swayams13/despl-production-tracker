import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * ProcurementEvent (B5, Phase 4) — recordProcurementEvent has no pure logic
 * worth isolating on its own (a role gate + a tenant-anchored create), so
 * this is DB-gated only, same shape as mtc.service's sibling `recordMtc`
 * would use if it had its own test file. The derived-summary assertions
 * (accumulation, status-by-most-recent-event) go through `loadBomTree`
 * rather than reaching into `bom.read.ts`'s private `summarizeProcurement`,
 * since that's the actual contract the UI reads.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("procurement.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { recordProcurementEvent } = await import("./procurement.service");
  const { loadBomTree } = await import("./bom.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  // Task review I3: each fixture()/cross-tenant call creates a whole
  // disposable Organization, and nothing deleted it — matches
  // job-intake.service.test.ts's "track ids, delete bottom-up in afterAll"
  // pattern rather than leaving every run's fixtures in despl_test forever.
  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.procurementEvent.deleteMany({ where: { bomItem: { equipment: { job: { tenantId } } } } });
    await owner.bomItem.deleteMany({ where: { equipment: { job: { tenantId } } } });
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
    const org = await owner.organization.create({ data: { code: `TEST-PROC-${Date.now()}`, name: "procurement test" } });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-proc-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-PROC-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver", blockNo: 1 } });
    const bomItem = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 1, partName: "Shell Course 1", sourceQty: "1" },
    });
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `ph-${Date.now()}@test.local`,
        username: `ph-${Date.now()}`,
        passwordHash: "x",
        name: "Test PH",
        themePreference: "SYSTEM",
      },
    });
    return { tenantId, job, equipment, bomItem, user };
  }

  function actorBase(tenantId: number, userId: number): Actor {
    return { userId, tenantId, clientId: null, name: "Test", email: "t@x", roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  it("refuses a SUPERVISOR caller (RBAC deny-by-default) — not a production-vocabulary role", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const supervisor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.SUPERVISOR] };
    await expectCode(
      recordProcurementEvent(supervisor, { bomItemId: bomItem.id, type: "INDENT_RAISED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("refuses a client user (invariant #8, read-only, no exceptions)", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const clientActor: Actor = { ...actorBase(tenantId, user.id), clientId: 1, roles: [ROLES.PRODUCTION_HEAD] };
    await expectCode(
      recordProcurementEvent(clientActor, { bomItemId: bomItem.id, type: "INDENT_RAISED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("succeeds for PRODUCTION_HEAD and is attributed to the actor", async () => {
    const { tenantId, job, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const event = await recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "INDENT_RAISED", refNo: "IND-1" });
    expect(event.by).toBe(user.id);
    expect(event.refNo).toBe("IND-1");
    // H1: recordProcurementEvent populates jobId.
    expect(event.jobId).toBe(job.id);
  });

  it("qty is required on RECEIPT and forbidden on the other three types", async () => {
    const { tenantId, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    // Pinned to the schema's own .refine() message (task review I2) — a bare
    // .rejects.toBeTruthy() would also pass for an unrelated FORBIDDEN,
    // NOT_FOUND, or a TypeError, so it can't tell "the refine fired" from
    // "something else went wrong". zod's own .strict()/.refine() failures
    // are raw ZodErrors here, not AppErrors — same documented convention as
    // client-snapshot.service.test.ts's "rejectSnapshot requires a reason".
    const REFINE_MESSAGE = /qty is required on a RECEIPT event, and not allowed on any other event type/;
    // RECEIPT with no qty — refused.
    await expect(recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "RECEIPT" })).rejects.toThrow(REFINE_MESSAGE);
    // INDENT_RAISED / INDENT_APPROVED / PO_PLACED with a qty — refused.
    for (const type of ["INDENT_RAISED", "INDENT_APPROVED", "PO_PLACED"] as const) {
      await expect(recordProcurementEvent(ph, { bomItemId: bomItem.id, type, qty: 5 })).rejects.toThrow(REFINE_MESSAGE);
    }
    // RECEIPT with a qty — accepted.
    const event = await recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "RECEIPT", qty: 5 });
    expect(event.qty?.toString()).toBe("5");
  });

  it("accumulates receivedQty across two partial RECEIPT events (derived summary, not an asserted status)", async () => {
    const { tenantId, job, equipment, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    await recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "RECEIPT", qty: 12 });
    await recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "RECEIPT", qty: 8 });

    const tree = await loadBomTree(ph, job.id, equipment.id);
    const row = tree!.groups.flatMap((g) => g.items).find((i) => i.id === bomItem.id)!;
    expect(row.procurement.receivedQty).toBe(20);
    expect(row.procurement.hasUnknownReceipt).toBe(false);
    expect(row.procurement.status).toBe("RECEIPT");
  });

  it("status derivation is table-driven off the most recent event, not a separate status field", async () => {
    const { tenantId, job, equipment, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };

    const readStatus = async () => {
      const tree = await loadBomTree(ph, job.id, equipment.id);
      return tree!.groups.flatMap((g) => g.items).find((i) => i.id === bomItem.id)!.procurement.status;
    };

    expect(await readStatus()).toBe("NOT_STARTED"); // no events yet — chosen default, documented in bom.read.ts
    await recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "INDENT_RAISED" });
    expect(await readStatus()).toBe("INDENT_RAISED");
    await recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "INDENT_APPROVED" });
    expect(await readStatus()).toBe("INDENT_APPROVED");
    await recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "PO_PLACED" });
    expect(await readStatus()).toBe("PO_PLACED");
    await recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "RECEIPT", qty: 3 });
    expect(await readStatus()).toBe("RECEIPT");
  });

  it("a RECEIPT with unknown qty (PARTIALLY_RECEIVED-shaped) stays distinguishable from a receipt with a known quantity", async () => {
    const { tenantId, job, equipment, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    // qty is mandatory on this service's own RECEIPT path, but the backfilled
    // (pre-existing) data shape it stands in for allows a null qty directly
    // via a raw insert — assert the read side never collapses that into 0.
    await owner.procurementEvent.create({ data: { bomItemId: bomItem.id, type: "RECEIPT", qty: null, by: user.id } });

    const tree = await loadBomTree(ph, job.id, equipment.id);
    const row = tree!.groups.flatMap((g) => g.items).find((i) => i.id === bomItem.id)!;
    expect(row.procurement.receivedQty).toBeNull(); // not 0
    expect(row.procurement.hasUnknownReceipt).toBe(true);
    expect(row.procurement.events[0]).toMatchObject({ type: "RECEIPT", qty: null });
  });

  it("a mixed known+unknown RECEIPT never renders a confident total (task review I1)", async () => {
    const { tenantId, job, equipment, bomItem, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    // One backfilled-shaped unknown receipt (raw insert, mirrors
    // PARTIALLY_RECEIVED-with-no-recorded-qty data) plus one real, known
    // receipt of 8 logged through the actual writer.
    await owner.procurementEvent.create({ data: { bomItemId: bomItem.id, type: "RECEIPT", qty: null, by: user.id } });
    await recordProcurementEvent(ph, { bomItemId: bomItem.id, type: "RECEIPT", qty: 8 });

    const tree = await loadBomTree(ph, job.id, equipment.id);
    const row = tree!.groups.flatMap((g) => g.items).find((i) => i.id === bomItem.id)!;
    // The known portion (8) must still surface — but so must the fact that
    // it's incomplete, not a confident total.
    expect(row.procurement.receivedQty).toBe(8);
    expect(row.procurement.hasUnknownReceipt).toBe(true);
  });

  it("cross-tenant: another tenant's actor cannot reach this bom item by id (NOT_FOUND)", async () => {
    const { bomItem } = await fixture();
    const otherOrg = await owner.organization.create({ data: { code: `TEST-PROC-XT-${Date.now()}`, name: "Other tenant" } });
    createdOrgIds.push(otherOrg.id);
    const otherUser = await owner.user.create({
      data: {
        tenantId: otherOrg.id,
        email: `intruder-${Date.now()}@test.local`,
        username: `intruder-${Date.now()}`,
        passwordHash: "x",
        name: "Intruder",
        themePreference: "SYSTEM",
      },
    });
    const intruder: Actor = { ...actorBase(otherOrg.id, otherUser.id), roles: [ROLES.PRODUCTION_HEAD] };
    await expectCode(
      recordProcurementEvent(intruder, { bomItemId: bomItem.id, type: "INDENT_RAISED" }),
      ERROR_CODES.NOT_FOUND,
    );
  });
});
