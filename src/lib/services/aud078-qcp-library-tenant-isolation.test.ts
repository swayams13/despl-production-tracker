import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * AUD-078 — library QCP templates (QcpTemplate rows with jobId null) used to
 * have no tenant anchor at all: readable, clonable, and authorable-onto by
 * every tenant. The product decision (9 Sep 2026, Swayam): library content
 * is private per tenant, not a shared cross-tenant catalog. This proves the
 * close: a library row created by tenant A is invisible to tenant B in every
 * read path that used to fall open on `jobId: null`, and every write path
 * that creates library content now anchors it to the real actor.tenantId.
 *
 * Distinct from aud080-069-remaining-rls-tables.test.ts (RLS policy
 * existence/shape on the 4 tables in this family) and
 * aud001/aud080's own tests (job-owned rows, never a genuine library row) —
 * this file is the first to exercise a real jobId-null row across two
 * tenants.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("AUD-078: QCP library templates are tenant-private", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createQcpTemplateLibrary, addQcpItemToLibraryTemplate } = await import("./qcp.service");
  const { loadIntakeOptions, loadQcpTemplateLibraryAdmin } = await import("./job-intake.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  function adminActor(tenantId: number, userId: number): Actor {
    return {
      userId,
      tenantId,
      clientId: null,
      name: "Admin",
      email: `admin-${tenantId}@x`,
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  }

  async function makeTenant(tag: string) {
    const org = await owner.organization.create({
      data: { code: `TEST-AUD078-${tag}-${Date.now()}-${Math.random()}`, name: `AUD-078 ${tag}` },
    });
    createdOrgIds.push(org.id);
    const user = await owner.user.create({
      data: {
        tenantId: org.id,
        email: `admin-aud078-${tag}-${Date.now()}-${Math.random()}@test.local`,
        username: `admin-aud078-${tag}-${Date.now()}-${Math.random()}`,
        passwordHash: "x",
        name: "Admin",
        themePreference: "SYSTEM",
      },
    });
    return { tenantId: org.id, actor: adminActor(org.id, user.id) };
  }

  afterAll(async () => {
    for (const tenantId of createdOrgIds) {
      await owner.qcpItemPartyCode.deleteMany({ where: { qcpItem: { qcpTemplate: { tenantId } } } });
      await owner.qcpItem.deleteMany({ where: { qcpTemplate: { tenantId } } });
      await owner.inspectionParty.deleteMany({ where: { qcpTemplate: { tenantId } } });
      await owner.qcpTemplate.deleteMany({ where: { tenantId } });
      await owner.user.deleteMany({ where: { tenantId } });
      await owner.organization.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await owner.$disconnect();
  });

  it("createQcpTemplateLibrary anchors the new row (and its InspectionParty rows) to the actor's real tenant", async () => {
    const { tenantId, actor } = await makeTenant("A1");
    const created = await createQcpTemplateLibrary(actor, {
      jobLabel: "Ammonia Vaporizer",
      vessel: "Vaporizer",
      parties: [{ code: "DESPL" }, { code: "TPI" }],
    });
    const row = await owner.qcpTemplate.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.tenantId).toBe(tenantId);
    expect(row.jobId).toBeNull();
    const parties = await owner.inspectionParty.findMany({ where: { qcpTemplateId: created.id } });
    expect(parties).toHaveLength(2);
    for (const p of parties) expect(p.tenantId).toBe(tenantId);
  });

  it("addQcpItemToLibraryTemplate anchors the new QcpItem/QcpItemPartyCode to the actor's tenant", async () => {
    const { tenantId, actor } = await makeTenant("A2");
    await owner.qcpCodeRef.upsert({
      where: { tenantId_code: { tenantId, code: "H" } },
      create: { tenantId, code: "H", label: "Hold", blocksCompletion: true, waivable: false },
      update: {},
    });
    const template = await createQcpTemplateLibrary(actor, {
      jobLabel: "PIPE-SPOOL-STD",
      vessel: "Spool",
      parties: [{ code: "DESPL" }],
    });
    const item = await addQcpItemToLibraryTemplate(actor, {
      qcpTemplateId: template.id,
      sequence: 1,
      srNo: "1",
      kind: "CHECKPOINT",
      activity: "Visual check",
      libraryProcessCodes: [],
      partyCodes: [{ partyCode: "DESPL", qcpCode: "H" }],
    });
    const row = await owner.qcpItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.tenantId).toBe(tenantId);
    const partyCodes = await owner.qcpItemPartyCode.findMany({ where: { qcpItemId: item.id } });
    expect(partyCodes).toHaveLength(1);
    expect(partyCodes[0].tenantId).toBe(tenantId);
  });

  it("addQcpItemToLibraryTemplate refuses a library template that belongs to a different tenant (NOT_FOUND, not a silent cross-tenant author)", async () => {
    const { actor: ownerActor } = await makeTenant("B1-owner");
    const { actor: attackerActor } = await makeTenant("B1-attacker");
    const template = await createQcpTemplateLibrary(ownerActor, {
      jobLabel: "Vessel QAP",
      vessel: "Vessel",
      parties: [{ code: "DESPL" }],
    });
    let thrown: unknown;
    try {
      await addQcpItemToLibraryTemplate(attackerActor, {
        qcpTemplateId: template.id,
        sequence: 1,
        srNo: "1",
        kind: "CHECKPOINT",
        activity: "Should be refused",
        libraryProcessCodes: [],
        partyCodes: [],
      });
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(ERROR_CODES.NOT_FOUND);
    const items = await owner.qcpItem.findMany({ where: { qcpTemplateId: template.id } });
    expect(items).toHaveLength(0);
  });

  it("loadIntakeOptions only lists the actor's own tenant's library templates, not another tenant's", async () => {
    const { actor: aActor } = await makeTenant("C1-a");
    const { actor: bActor } = await makeTenant("C1-b");
    const aTemplate = await createQcpTemplateLibrary(aActor, {
      jobLabel: "Only A should see this",
      vessel: "V",
      parties: [{ code: "DESPL" }],
    });
    await createQcpTemplateLibrary(bActor, {
      jobLabel: "Only B should see this",
      vessel: "V",
      parties: [{ code: "DESPL" }],
    });

    const aOptions = await loadIntakeOptions(aActor);
    const aLabels = aOptions.qcpTemplates.map((t) => t.label);
    expect(aLabels).toContain("Only A should see this");
    expect(aLabels).not.toContain("Only B should see this");

    const bOptions = await loadIntakeOptions(bActor);
    const bLabels = bOptions.qcpTemplates.map((t) => t.label);
    expect(bLabels).toContain("Only B should see this");
    expect(bLabels).not.toContain("Only A should see this");

    // Sanity: the template really exists (id resolvable at all), just not
    // visible cross-tenant — proves this is the read filter working, not a
    // fixture mistake.
    const raw = await owner.qcpTemplate.findUniqueOrThrow({ where: { id: aTemplate.id } });
    expect(raw.jobLabel).toBe("Only A should see this");
  });

  it("loadQcpTemplateLibraryAdmin only lists the actor's own tenant's library templates", async () => {
    const { actor: aActor } = await makeTenant("D1-a");
    const { actor: bActor } = await makeTenant("D1-b");
    await createQcpTemplateLibrary(aActor, { jobLabel: "A's admin-only template", vessel: "V", parties: [{ code: "DESPL" }] });
    await createQcpTemplateLibrary(bActor, { jobLabel: "B's admin-only template", vessel: "V", parties: [{ code: "DESPL" }] });

    const aRows = await loadQcpTemplateLibraryAdmin(aActor);
    expect(aRows.map((r) => r.jobLabel)).toContain("A's admin-only template");
    expect(aRows.map((r) => r.jobLabel)).not.toContain("B's admin-only template");
  });
});
