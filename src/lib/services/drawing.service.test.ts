import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * DrawingRevision / createDrawingRevision (B9, Phase 4) — DB-gated only,
 * same shape as mtc.service.test.ts's sibling (a tenant-anchored create +
 * a supersession side effect, no pure logic worth isolating). Proves
 * invariant #9's versioning: issuing Rev B never deletes/overwrites Rev A —
 * both stay queryable via AssemblyDrawing.revisions, with the prior
 * RELEASED row flipped to SUPERSEDED.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("drawing.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createDrawingRevision } = await import("./drawing.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdOrgIds: number[] = [];

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.drawingRevision.deleteMany({ where: { assemblyDrawing: { job: { tenantId } } } });
    await owner.assemblyDrawing.deleteMany({ where: { job: { tenantId } } });
    await owner.drawingTypeRef.deleteMany({ where: { tenantId } });
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
    const org = await owner.organization.create({ data: { code: `TEST-DWG-${Date.now()}`, name: "drawing test" } });
    createdOrgIds.push(org.id);
    const tenantId = org.id;
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-dwg-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-DWG-${Date.now()}`,
      },
    });
    const drawingType = await owner.drawingTypeRef.create({ data: { tenantId, code: "GA", name: "General Arrangement" } });
    const drawing = await owner.assemblyDrawing.create({
      data: { jobId: job.id, drawingTypeId: drawingType.id, drawingNo: "GA-1" },
    });
    const user = await owner.user.create({
      data: {
        tenantId,
        email: `pm-${Date.now()}@test.local`,
        username: `pm-${Date.now()}`,
        passwordHash: "x",
        name: "Test PM",
        themePreference: "SYSTEM",
      },
    });
    return { tenantId, job, drawing, user };
  }

  function actorBase(tenantId: number, userId: number): Actor {
    return { userId, tenantId, clientId: null, name: "Test", email: "t@x", roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  it("creates Rev A as RELEASED, then Rev B supersedes it — both remain queryable (PRODUCTION_HEAD)", async () => {
    const { tenantId, drawing, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };

    const revA = await createDrawingRevision(actor, { assemblyDrawingId: drawing.id, revisionNo: 1, status: "RELEASED" });
    expect(revA.status).toBe("RELEASED");
    expect(revA.releasedAt).toBeInstanceOf(Date);

    const revB = await createDrawingRevision(actor, { assemblyDrawingId: drawing.id, revisionNo: 2, status: "RELEASED" });
    expect(revB.status).toBe("RELEASED");

    const all = await owner.drawingRevision.findMany({
      where: { assemblyDrawingId: drawing.id },
      orderBy: { revisionNo: "asc" },
    });
    expect(all).toHaveLength(2);
    expect(all.map((r) => ({ revisionNo: r.revisionNo, status: r.status }))).toEqual([
      { revisionNo: 1, status: "SUPERSEDED" },
      { revisionNo: 2, status: "RELEASED" },
    ]);
  });

  it("issuing a new DRAFT revision still supersedes a prior RELEASED one (unconditional per the brief: any new revision flips a prior RELEASED row), leaving the CUTTING gate correctly refusing until the new one releases (ADMIN)", async () => {
    const { tenantId, drawing, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    await createDrawingRevision(actor, { assemblyDrawingId: drawing.id, revisionNo: 1, status: "RELEASED" });
    await createDrawingRevision(actor, { assemblyDrawingId: drawing.id, revisionNo: 2, status: "DRAFT" });

    const all = await owner.drawingRevision.findMany({
      where: { assemblyDrawingId: drawing.id },
      orderBy: { revisionNo: "asc" },
    });
    expect(all.map((r) => ({ revisionNo: r.revisionNo, status: r.status }))).toEqual([
      { revisionNo: 1, status: "SUPERSEDED" },
      { revisionNo: 2, status: "DRAFT" },
    ]);
  });

  it("cross-tenant: another tenant's actor cannot issue a revision against this drawing by id (NOT_FOUND)", async () => {
    const { drawing } = await fixture();
    const otherOrg = await owner.organization.create({ data: { code: `TEST-DWG-XT-${Date.now()}`, name: "Other tenant" } });
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
    // ADMIN (not SUPERVISOR) — the role gate must not be what refuses this;
    // the NOT_FOUND path (cross-tenant lookup) is what's under test here.
    const intruder: Actor = { ...actorBase(otherOrg.id, otherUser.id), roles: [ROLES.ADMIN] };
    await expectCode(
      createDrawingRevision(intruder, { assemblyDrawingId: drawing.id, revisionNo: 1, status: "RELEASED" }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("client user cannot issue a revision — read-only, no exceptions (#1 access rule)", async () => {
    const { tenantId, drawing, user } = await fixture();
    // roles: [ADMIN] so the ONLY thing that can throw FORBIDDEN is
    // assertNotClientUser, not the role gate (same isolation as
    // mtc.service.test.ts's clientActor convention).
    const clientActor: Actor = { ...actorBase(tenantId, user.id), clientId: 1, roles: [ROLES.ADMIN] };
    await expectCode(
      createDrawingRevision(clientActor, { assemblyDrawingId: drawing.id, revisionNo: 1, status: "RELEASED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  // ── Task review Critical: role gate ─────────────────────────────────────

  it("role gate: a supervisor (no ADMIN/PRODUCTION_HEAD role) cannot issue a revision — the gate must not be self-clearing by the party it constrains (FORBIDDEN)", async () => {
    const { tenantId, drawing, user } = await fixture();
    const supervisor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.SUPERVISOR] };
    await expectCode(
      createDrawingRevision(supervisor, { assemblyDrawingId: drawing.id, revisionNo: 1, status: "RELEASED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("role gate: QC alone (no ADMIN/PRODUCTION_HEAD) cannot issue a revision either — not a QC action", async () => {
    const { tenantId, drawing, user } = await fixture();
    const qc: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.QC] };
    await expectCode(
      createDrawingRevision(qc, { assemblyDrawingId: drawing.id, revisionNo: 1, status: "RELEASED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("role gate: ADMIN succeeds", async () => {
    const { tenantId, drawing, user } = await fixture();
    const admin: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };
    const rev = await createDrawingRevision(admin, { assemblyDrawingId: drawing.id, revisionNo: 1, status: "RELEASED" });
    expect(rev.status).toBe("RELEASED");
  });

  it("role gate: PRODUCTION_HEAD succeeds", async () => {
    const { tenantId, drawing, user } = await fixture();
    const ph: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.PRODUCTION_HEAD] };
    const rev = await createDrawingRevision(ph, { assemblyDrawingId: drawing.id, revisionNo: 1, status: "RELEASED" });
    expect(rev.status).toBe("RELEASED");
  });

  // ── Task review Important: revisionNo monotonicity ──────────────────────

  it("monotonicity: a revisionNo not strictly greater than the drawing's current highest is refused, with a recoverable error naming the current highest", async () => {
    const { tenantId, drawing, user } = await fixture();
    const actor: Actor = { ...actorBase(tenantId, user.id), roles: [ROLES.ADMIN] };

    await createDrawingRevision(actor, { assemblyDrawingId: drawing.id, revisionNo: 5, status: "RELEASED" });

    // A typo'd lower number (e.g. 3) must not silently create a row that
    // would make Rev 5 stop being "current" (max(revisionNo)) — no
    // supersession happens, no bogus row is created, and the refusal names
    // what to do instead.
    let thrown: unknown;
    try {
      await createDrawingRevision(actor, { assemblyDrawingId: drawing.id, revisionNo: 3, status: "RELEASED" });
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(ERROR_CODES.DRAWING_REVISION_NOT_INCREASING);
    expect(isAppError(thrown) && thrown.detail?.currentHighestRevisionNo).toBe(5);

    // Duplicate of the current highest is refused too, not silently accepted.
    await expectCode(
      createDrawingRevision(actor, { assemblyDrawingId: drawing.id, revisionNo: 5, status: "RELEASED" }),
      ERROR_CODES.DRAWING_REVISION_NOT_INCREASING,
    );

    // Rev 5 is still RELEASED — the failed attempts never touched it.
    const current = await owner.drawingRevision.findFirst({ where: { assemblyDrawingId: drawing.id, revisionNo: 5 } });
    expect(current?.status).toBe("RELEASED");

    // A genuinely higher number still works.
    const revSix = await createDrawingRevision(actor, { assemblyDrawingId: drawing.id, revisionNo: 6, status: "RELEASED" });
    expect(revSix.status).toBe("RELEASED");
  });
});
