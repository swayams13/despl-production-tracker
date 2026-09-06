import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * bom.service (B4, Phase 4) — DB-gated. Covers the two write-time invariants
 * Dispatch 1/2 explicitly deferred to this task: cycle prevention on
 * `parentBomItemId` (create/update), and `BomRevision`'s create path
 * (supersession under the real DRAFT/RELEASED-only enum — no SUPERSEDED
 * status exists here, unlike DrawingRevision).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("bom.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createBomItem, updateBomItem, importBomItems, createBomRevision } = await import("./bom.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.componentOperation.deleteMany({ where: { component: { equipment: { job: { tenantId } } } } });
    await owner.component.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.bomItem.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.bomRevision.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.equipment.deleteMany({ where: { job: { tenantId } } });
    await owner.job.deleteMany({ where: { tenantId } });
    await owner.routeStep.deleteMany({ where: { routeVersion: { route: { tenantId } } } });
    await owner.routeTemplateVersion.deleteMany({ where: { route: { tenantId } } });
    await owner.routeTemplate.deleteMany({ where: { tenantId } });
    await owner.componentTypeRef.deleteMany({ where: { tenantId } });
    await owner.operationRef.deleteMany({ where: { tenantId } });
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
    const org = await owner.organization.create({ data: { code: `TEST-BOM-${Date.now()}`, name: "bom test" } });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-bom-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-BOM-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel A" } });
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `pm-${Date.now()}@test.local`,
        username: `pm-bom-${Date.now()}`,
        passwordHash: "x",
        name: "Test PM",
        themePreference: "SYSTEM",
      },
    });
    return { tenantId, job, equipment, user };
  }

  function actorBase(tenantId: number, userId: number): Actor {
    return { userId, tenantId, clientId: null, name: "Test", email: "t@x", roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  // ── create / update happy path ──────────────────────────────────────────

  it("creates a BOM item by hand, then edits it (ADMIN)", async () => {
    const { tenantId, job, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const item = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 1, partName: "Shell", sourceQty: "1 NOS" });
    expect(item.partName).toBe("Shell");
    expect(item.sourceQty).toBe("1 NOS");
    // H1: createBomItem populates jobId.
    expect(item.jobId).toBe(job.id);

    const updated = await updateBomItem(actor, item.id, { partName: "Shell — updated", material: "SA 516 Gr 70" });
    expect(updated.partName).toBe("Shell — updated");
    expect(updated.material).toBe("SA 516 Gr 70");
    expect(updated.sourceQty).toBe("1 NOS"); // untouched field survives a partial update
  });

  it("PRODUCTION_HEAD can also create/edit; SUPERVISOR/QC cannot (role gate)", async () => {
    const { tenantId, equipment, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const item = await createBomItem(ph, { equipmentId: equipment.id, itemNo: 1, partName: "Head", sourceQty: "2 NOS" });
    expect(item.id).toBeGreaterThan(0);

    const supervisor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.SUPERVISOR] };
    await expectCode(
      createBomItem(supervisor, { equipmentId: equipment.id, itemNo: 2, partName: "Nozzle", sourceQty: "4 NOS" }),
      ERROR_CODES.FORBIDDEN,
    );
    const qc: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.QC] };
    await expectCode(updateBomItem(qc, item.id, { partName: "x" }), ERROR_CODES.FORBIDDEN);
  });

  // ── S21: @@unique([bomRevisionId, itemNo]) ────────────────────────────────

  it("S21: a duplicate itemNo within the SAME bomRevisionId is refused at the DB (P2002)", async () => {
    const { tenantId, job, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };
    const revision = await createBomRevision(actor, { equipmentId: equipment.id, revisionNo: 1, status: "DRAFT" });
    // H1: createBomRevision populates jobId.
    expect(revision.jobId).toBe(job.id);

    await createBomItem(actor, {
      equipmentId: equipment.id,
      itemNo: 1,
      partName: "Gasket",
      sourceQty: "1 NOS",
      bomRevisionId: revision.id,
    });

    await expect(
      createBomItem(actor, {
        equipmentId: equipment.id,
        itemNo: 1,
        partName: "Gasket (duplicate item_no)",
        sourceQty: "1 NOS",
        bomRevisionId: revision.id,
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("S21: the same itemNo across TWO DIFFERENT bomRevisionIds is fine — the constraint is scoped per revision", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };
    const revA = await createBomRevision(actor, { equipmentId: equipment.id, revisionNo: 1, status: "DRAFT" });
    const revB = await createBomRevision(actor, { equipmentId: equipment.id, revisionNo: 2, status: "DRAFT" });

    const a = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 1, partName: "A", sourceQty: "1 NOS", bomRevisionId: revA.id });
    const b = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 1, partName: "A rev 2", sourceQty: "1 NOS", bomRevisionId: revB.id });
    expect(a.id).not.toBe(b.id);
  });

  it("S21: the same itemNo across two rows with NO bomRevisionId (null) is unaffected — Postgres treats NULL as distinct per row", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const a = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 1, partName: "A", sourceQty: "1 NOS" });
    const b = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 1, partName: "A (no revision)", sourceQty: "1 NOS" });
    expect(a.id).not.toBe(b.id);
    expect(a.bomRevisionId).toBeNull();
    expect(b.bomRevisionId).toBeNull();
  });

  // ── cycle detection ──────────────────────────────────────────────────────

  it("2-level cycle: setting an item's parent to its own child is refused", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const a = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 1, partName: "A", sourceQty: "1 NOS" });
    const b = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 2, partName: "B", sourceQty: "1 NOS", parentBomItemId: a.id });

    // A -> B already; making B the parent of A would close the loop.
    await expectCode(updateBomItem(actor, a.id, { parentBomItemId: b.id }), ERROR_CODES.BOM_PARENT_WOULD_CYCLE);

    // Immediate self-parent is refused too.
    await expectCode(updateBomItem(actor, a.id, { parentBomItemId: a.id }), ERROR_CODES.BOM_PARENT_WOULD_CYCLE);

    // Neither attempt mutated the real chain.
    const reloaded = await owner.bomItem.findUnique({ where: { id: a.id } });
    expect(reloaded?.parentBomItemId).toBeNull();
  });

  it("3-level cycle: A -> B -> C, setting A's parent to C is refused", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const a = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 1, partName: "A", sourceQty: "1 NOS" });
    const b = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 2, partName: "B", sourceQty: "1 NOS", parentBomItemId: a.id });
    const c = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 3, partName: "C", sourceQty: "1 NOS", parentBomItemId: b.id });

    await expectCode(updateBomItem(actor, a.id, { parentBomItemId: c.id }), ERROR_CODES.BOM_PARENT_WOULD_CYCLE);

    const reloaded = await owner.bomItem.findUnique({ where: { id: a.id } });
    expect(reloaded?.parentBomItemId).toBeNull();

    // A valid re-parent (C -> A instead of C -> B) still works — the guard
    // isn't refusing every parent change, only the ones that close a loop.
    const moved = await updateBomItem(actor, c.id, { parentBomItemId: a.id });
    expect(moved.parentBomItemId).toBe(a.id);
  });

  // ── clearing a nullable field (task review Important #2) ────────────────

  it("clearing parentBomItemId (and other nullable fields) with an explicit null actually clears them, not just no-ops", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const a = await createBomItem(actor, { equipmentId: equipment.id, itemNo: 1, partName: "A", sourceQty: "1 NOS" });
    const b = await createBomItem(actor, {
      equipmentId: equipment.id,
      itemNo: 2,
      partName: "B",
      sourceQty: "1 NOS",
      material: "SA 105",
      parentBomItemId: a.id,
    });
    expect(b.parentBomItemId).toBe(a.id);
    expect(b.material).toBe("SA 105");

    // omitting a field entirely still leaves it alone (undefined semantics unchanged)
    const untouched = await updateBomItem(actor, b.id, { partName: "B renamed" });
    expect(untouched.parentBomItemId).toBe(a.id);
    expect(untouched.material).toBe("SA 105");

    // explicit null clears it
    const cleared = await updateBomItem(actor, b.id, { parentBomItemId: null, material: null });
    expect(cleared.parentBomItemId).toBeNull();
    expect(cleared.material).toBeNull();

    const reloaded = await owner.bomItem.findUnique({ where: { id: b.id } });
    expect(reloaded?.parentBomItemId).toBeNull();
    expect(reloaded?.material).toBeNull();
  });

  it("a parentBomItemId from a different equipment is refused (not found in this equipment's chain)", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };
    const job2 = await owner.job.findFirstOrThrow({ where: { tenantId } });
    const otherEquipment = await owner.equipment.create({ data: { jobId: job2.id, name: "Vessel B" } });
    const foreignParent = await createBomItem(actor, { equipmentId: otherEquipment.id, itemNo: 1, partName: "Foreign", sourceQty: "1 NOS" });

    await expectCode(
      createBomItem(actor, { equipmentId: equipment.id, itemNo: 1, partName: "A", sourceQty: "1 NOS", parentBomItemId: foreignParent.id }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  // ── cross-tenant refusal ─────────────────────────────────────────────────

  it("cross-tenant: another tenant's actor cannot create against this equipment (NOT_FOUND)", async () => {
    const { equipment } = await fixture();
    const otherOrg = await owner.organization.create({ data: { code: `TEST-BOM-XT-${Date.now()}`, name: "Other tenant" } });
    createdOrgIds.push(otherOrg.id);
    const otherUser = await owner.user.create({
      data: {
        tenantId: otherOrg.id,
        email: `intruder-${Date.now()}@test.local`,
        username: `intruder-bom-${Date.now()}`,
        passwordHash: "x",
        name: "Intruder",
        themePreference: "SYSTEM",
      },
    });
    const intruder: Actor = { ...actorBase(otherOrg.id, otherUser.id), roles: [ROLES.ADMIN] };
    await expectCode(
      createBomItem(intruder, { equipmentId: equipment.id, itemNo: 1, partName: "A", sourceQty: "1 NOS" }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("cross-tenant: another tenant's actor cannot update this item by id (NOT_FOUND)", async () => {
    const { tenantId, equipment, user } = await fixture();
    const owner_: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };
    const item = await createBomItem(owner_, { equipmentId: equipment.id, itemNo: 1, partName: "A", sourceQty: "1 NOS" });

    const otherOrg = await owner.organization.create({ data: { code: `TEST-BOM-XT2-${Date.now()}`, name: "Other tenant 2" } });
    createdOrgIds.push(otherOrg.id);
    const otherUser = await owner.user.create({
      data: {
        tenantId: otherOrg.id,
        email: `intruder2-${Date.now()}@test.local`,
        username: `intruder2-bom-${Date.now()}`,
        passwordHash: "x",
        name: "Intruder2",
        themePreference: "SYSTEM",
      },
    });
    const intruder: Actor = { ...actorBase(otherOrg.id, otherUser.id), roles: [ROLES.ADMIN] };
    await expectCode(updateBomItem(intruder, item.id, { partName: "hijacked" }), ERROR_CODES.NOT_FOUND);
  });

  // ── bulk import ──────────────────────────────────────────────────────────

  it("import: a malformed row reports which row failed and why, without dropping or blocking the good rows", async () => {
    const { tenantId, job, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const { created, failures } = await importBomItems(actor, {
      equipmentId: equipment.id,
      rows: [
        { itemNo: 1, partName: "Shell", sourceQty: "1 NOS" },
        { itemNo: "not-a-number", partName: "", sourceQty: "" }, // malformed: bad itemNo + missing partName/sourceQty
        { itemNo: 3, partName: "Nozzle", sourceQty: "4 NOS" },
      ],
    });

    expect(created).toHaveLength(2);
    expect(created.map((c) => c.partName).sort()).toEqual(["Nozzle", "Shell"]);
    // H1: importBomItems populates jobId on every created row.
    expect(created.every((c) => c.jobId === job.id)).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0].row).toBe(2);
    expect(failures[0].error).toBeTruthy();

    const persisted = await owner.bomItem.findMany({ where: { equipmentId: equipment.id } });
    expect(persisted).toHaveLength(2);
  });

  it("import: accepts rows shaped like the repo's own real BOM data (qty, not sourceQty)", async () => {
    // Task review Important #1 — seed/despl-320-bom-items.json's real shape:
    // {itemNo, partName, description, material, qty, unit, remarks}. Before
    // the fix, every real row failed twice over: missing `sourceQty` AND
    // `qty` rejected as an unrecognized key under `.strict()`.
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const { created, failures } = await importBomItems(actor, {
      equipmentId: equipment.id,
      rows: [
        { itemNo: 1, partName: "Flange", description: "N1", material: "SA 105", qty: "1", unit: "NOS", remarks: "per detail" },
        { itemNo: 2, partName: "Flange", description: "N2", material: "SA 105", qty: "1", unit: "NOS", remarks: "DN25 class" },
      ],
    });

    expect(failures).toHaveLength(0);
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.sourceQty)).toEqual(["1", "1"]);
    expect(created.map((c) => c.unit)).toEqual(["NOS", "NOS"]);
  });

  it("import: header aliasing is case/space-insensitive, and an unrecognized extra column doesn't fail the row", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const { created, failures } = await importBomItems(actor, {
      equipmentId: equipment.id,
      rows: [
        // "Item No"/"Part Name"/"Quantity" — real-workbook-style headers, plus
        // a stray "Drawing Ref" column this schema doesn't model at all.
        { "Item No": 1, "Part Name": "Shell", Quantity: "1 NOS", "Drawing Ref": "GA-1" },
      ],
    });

    expect(failures).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(created[0].partName).toBe("Shell");
    expect(created[0].sourceQty).toBe("1 NOS");
  });

  it("import: a file over the row cap is refused upfront, before any row is written", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const rows = Array.from({ length: 1001 }, (_, i) => ({ itemNo: i + 1, partName: `Part ${i + 1}`, sourceQty: "1 NOS" }));
    await expectCode(importBomItems(actor, { equipmentId: equipment.id, rows }), ERROR_CODES.VALIDATION_FAILED);

    const persisted = await owner.bomItem.findMany({ where: { equipmentId: equipment.id } });
    expect(persisted).toHaveLength(0);
  });

  it("import: role gate — SUPERVISOR cannot import", async () => {
    const { tenantId, equipment, user } = await fixture();
    const supervisor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.SUPERVISOR] };
    await expectCode(
      importBomItems(supervisor, { equipmentId: equipment.id, rows: [{ itemNo: 1, partName: "A", sourceQty: "1 NOS" }] }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  // ── template import: componentType column + auto-materialization ────────

  async function seedRoute(tenantId: number, familyId: number, code: string) {
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code, name: code } });
    const operation = await owner.operationRef.create({ data: { tenantId, code: `${code}-OP`, name: `${code} op` } });
    const route = await owner.routeTemplate.create({ data: { tenantId, componentTypeId: componentType.id, familyId: null, name: `${code} route` } });
    const version = await owner.routeTemplateVersion.create({ data: { routeId: route.id, version: 1, status: "PUBLISHED" } });
    await owner.routeStep.create({ data: { routeVersionId: version.id, seq: 1, operationId: operation.id } });
    return componentType;
  }

  it("import: a row with a recognized Component Type code auto-materialises a Component + its route", async () => {
    const { tenantId, job, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };
    const componentType = await seedRoute(tenantId, job.familyId, "NOZZLE");

    const { created, failures, componentCount } = await importBomItems(actor, {
      equipmentId: equipment.id,
      rows: [{ itemNo: 1, partName: "Nozzle N1", sourceQty: "1 NOS", componentType: "NOZZLE" }],
    });

    expect(failures).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(created[0].componentTypeId).toBe(componentType.id);
    expect(componentCount).toBe(1);

    const components = await owner.component.findMany({ where: { bomItemId: created[0].id }, include: { operations: true } });
    expect(components).toHaveLength(1);
    expect(components[0].jobId).toBe(job.id);
    expect(components[0].operations).toHaveLength(1);
  });

  it("import: an unrecognized Component Type code aborts the WHOLE batch, creating nothing", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    await expectCode(
      importBomItems(actor, {
        equipmentId: equipment.id,
        rows: [
          { itemNo: 1, partName: "Shell", sourceQty: "1 NOS" },
          { itemNo: 2, partName: "Nozzle N1", sourceQty: "1 NOS", componentType: "NOT-A-REAL-CODE" },
        ],
      }),
      ERROR_CODES.VALIDATION_FAILED,
    );

    const persisted = await owner.bomItem.findMany({ where: { equipmentId: equipment.id } });
    expect(persisted).toHaveLength(0);
  });

  it("import: rows with no Component Type column behave exactly as before (no materialization attempted)", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const { created, failures, componentCount } = await importBomItems(actor, {
      equipmentId: equipment.id,
      rows: [{ itemNo: 1, partName: "Shell", sourceQty: "1 NOS" }],
    });

    expect(failures).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(created[0].componentTypeId).toBeNull();
    expect(componentCount).toBe(0);
  });

  it("import: cross-tenant equipmentId is refused before any row is processed", async () => {
    const { equipment } = await fixture();
    const otherOrg = await owner.organization.create({ data: { code: `TEST-BOM-IMP-XT-${Date.now()}`, name: "Other tenant" } });
    createdOrgIds.push(otherOrg.id);
    const otherUser = await owner.user.create({
      data: {
        tenantId: otherOrg.id,
        email: `intruder3-${Date.now()}@test.local`,
        username: `intruder3-bom-${Date.now()}`,
        passwordHash: "x",
        name: "Intruder3",
        themePreference: "SYSTEM",
      },
    });
    const intruder: Actor = { ...actorBase(otherOrg.id, otherUser.id), roles: [ROLES.ADMIN] };
    await expectCode(
      importBomItems(intruder, { equipmentId: equipment.id, rows: [{ itemNo: 1, partName: "A", sourceQty: "1 NOS" }] }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  // ── BomRevision create-path / supersession ───────────────────────────────

  it("BomRevisionStatus has no SUPERSEDED: issuing a new RELEASED revision steps the prior RELEASED one down to DRAFT, never deleting it", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    const revA = await createBomRevision(actor, { equipmentId: equipment.id, revisionNo: 1, status: "RELEASED" });
    expect(revA.status).toBe("RELEASED");
    expect(revA.releasedAt).toBeInstanceOf(Date);

    const revB = await createBomRevision(actor, { equipmentId: equipment.id, revisionNo: 2, status: "RELEASED" });
    expect(revB.status).toBe("RELEASED");

    const all = await owner.bomRevision.findMany({ where: { equipmentId: equipment.id }, orderBy: { revisionNo: "asc" } });
    expect(all).toHaveLength(2);
    expect(all.map((r) => ({ revisionNo: r.revisionNo, status: r.status }))).toEqual([
      { revisionNo: 1, status: "DRAFT" },
      { revisionNo: 2, status: "RELEASED" },
    ]);
  });

  it("issuing a new DRAFT revision does not touch a prior RELEASED one (only a new RELEASED steps it down)", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    await createBomRevision(actor, { equipmentId: equipment.id, revisionNo: 1, status: "RELEASED" });
    await createBomRevision(actor, { equipmentId: equipment.id, revisionNo: 2, status: "DRAFT" });

    const all = await owner.bomRevision.findMany({ where: { equipmentId: equipment.id }, orderBy: { revisionNo: "asc" } });
    expect(all.map((r) => ({ revisionNo: r.revisionNo, status: r.status }))).toEqual([
      { revisionNo: 1, status: "RELEASED" },
      { revisionNo: 2, status: "DRAFT" },
    ]);
  });

  it("monotonicity: revisionNo not strictly greater than the current highest is refused, naming the current highest", async () => {
    const { tenantId, equipment, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    await createBomRevision(actor, { equipmentId: equipment.id, revisionNo: 5, status: "RELEASED" });

    let thrown: unknown;
    try {
      await createBomRevision(actor, { equipmentId: equipment.id, revisionNo: 3, status: "RELEASED" });
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(ERROR_CODES.BOM_REVISION_NOT_INCREASING);
    expect(isAppError(thrown) && thrown.detail?.currentHighestRevisionNo).toBe(5);

    const current = await owner.bomRevision.findFirst({ where: { equipmentId: equipment.id, revisionNo: 5 } });
    expect(current?.status).toBe("RELEASED"); // failed attempt never touched it
  });

  it("BomRevision role gate: SUPERVISOR cannot issue a revision", async () => {
    const { tenantId, equipment, user } = await fixture();
    const supervisor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.SUPERVISOR] };
    await expectCode(
      createBomRevision(supervisor, { equipmentId: equipment.id, revisionNo: 1, status: "RELEASED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });
});
