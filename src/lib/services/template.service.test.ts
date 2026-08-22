import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES } from "@/lib/shared/errors";
import { createTemplate, cloneVersion } from "./template.service";

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

/**
 * Refusals decidable from the caller's own actor/request shape, with no DB
 * read — same tier split as admin.service.test.ts.
 */
describe("template.service — pure refusals", () => {
  it.each([
    ["SUPERVISOR", ROLES.SUPERVISOR],
    ["QC", ROLES.QC],
    ["MANAGEMENT", ROLES.MANAGEMENT],
  ])("createTemplate refuses a %s caller (RBAC deny-by-default)", async (_label, role) => {
    await expect(
      createTemplate(actor({ roles: [role] }), { familyId: 1, name: "X" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("createTemplate refuses a client user before touching the DB", async () => {
    await expect(
      createTemplate(actor({ clientId: 9, roles: [ROLES.CLIENT_VIEWER] }), { familyId: 1, name: "X" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("cloneVersion refuses a SUPERVISOR caller", async () => {
    await expect(
      cloneVersion(actor({ roles: [ROLES.SUPERVISOR] }), { sourceVersionId: 1, notes: "n" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("cloneVersion requires a name when cloning into another family", async () => {
    await expect(
      cloneVersion(actor(), { sourceVersionId: 1, targetFamilyId: 2, notes: "n" }),
    ).rejects.toThrow();
  });

  it("rejects a smuggled *_at key via the strict schema (invariant #1)", async () => {
    await expect(
      // @ts-expect-error — .strict() schema; no timestamp field exists on this input
      createTemplate(actor(), { familyId: 1, name: "X", publishedAt: new Date() }),
    ).rejects.toThrow();
  });
});

/**
 * Behavioural round-trip against a seeded database. Gated: `pnpm test:db`
 * sources .env.test and points at despl_test — never run RUN_DB_TESTS
 * against despl_demo.
 *
 * Reads/writes on `product_families` / `process_templates` / `audit_log` go
 * through an OWNER-role client (DIRECT_URL), matching every other DB-gated
 * suite in this repo (_shared.test.ts, admin.service.test.ts, ...): those
 * three tables carry tenant RLS that is fail-closed by design (invariant #8
 * — see migration 20260813052000_rls_fail_closed), so the app-role `prisma`
 * singleton with no `app.tenant_id` set on the connection would silently see
 * zero rows on any read that joins through them, not a "seed missing" error.
 * `process_template_versions` / `template_processes` / `template_edges`
 * carry no RLS of their own (reachable only through their tenant-scoped
 * parent, ponytail-documented in the RLS migration), so those stay fine on
 * either client — kept on `owner` too here for one consistent client per
 * block. The `cloneVersion` calls under test are unaffected: the service's
 * own `withTenant` sets `app.tenant_id` on its transaction, which is exactly
 * the real request path being verified.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("template.service — clone (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function publishedPvVersion() {
    const v = await owner.processTemplateVersion.findFirst({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
    });
    if (!v) throw new Error("seed missing: no published PRESSURE_VESSEL version");
    return v;
  }

  it("clones every process and edge into a new DRAFT, leaving the source untouched", async () => {
    const source = await publishedPvVersion();
    const before = {
      processes: await owner.templateProcess.count({ where: { versionId: source.id } }),
      edges: await owner.templateEdge.count({ where: { versionId: source.id } }),
    };

    const draft = await cloneVersion(actor(), {
      sourceVersionId: source.id,
      notes: "test clone",
    });

    expect(draft.status).toBe("DRAFT");
    expect(draft.version).toBe(source.version + 1);
    expect(draft.templateId).toBe(source.templateId);
    expect(await owner.templateProcess.count({ where: { versionId: draft.id } })).toBe(before.processes);
    expect(await owner.templateEdge.count({ where: { versionId: draft.id } })).toBe(before.edges);
    // Source untouched.
    expect(await owner.templateProcess.count({ where: { versionId: source.id } })).toBe(before.processes);
    expect((await owner.processTemplateVersion.findUniqueOrThrow({ where: { id: source.id } })).status).toBe("PUBLISHED");

    // Copied edges point only at the copy's own processes.
    const newProcessIds = new Set(
      (await owner.templateProcess.findMany({ where: { versionId: draft.id }, select: { id: true } })).map((p) => p.id),
    );
    const newEdges = await owner.templateEdge.findMany({ where: { versionId: draft.id } });
    for (const e of newEdges) {
      expect(newProcessIds.has(e.processId)).toBe(true);
      expect(newProcessIds.has(e.predecessorId)).toBe(true);
    }

    await owner.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("clones into another family as version 1 of a new template", async () => {
    const source = await publishedPvVersion();
    const hx = await owner.productFamily.findFirstOrThrow({ where: { code: "HEAT_EXCHANGER" } });

    const draft = await cloneVersion(actor(), {
      sourceVersionId: source.id,
      targetFamilyId: hx.id,
      name: "Test HX route",
      notes: "test cross-family clone",
    });

    expect(draft.version).toBe(1);
    expect(draft.status).toBe("DRAFT");
    const template = await owner.processTemplate.findUniqueOrThrow({ where: { id: draft.templateId } });
    expect(template.familyId).toBe(hx.id);

    await owner.processTemplateVersion.delete({ where: { id: draft.id } });
    await owner.processTemplate.delete({ where: { id: template.id } });
  });

  it("writes exactly one audit row per clone", async () => {
    const source = await publishedPvVersion();
    const before = await owner.auditLog.count({ where: { action: "template.cloneVersion" } });
    const draft = await cloneVersion(actor(), { sourceVersionId: source.id, notes: "audit test" });
    expect(await owner.auditLog.count({ where: { action: "template.cloneVersion" } })).toBe(before + 1);
    await owner.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses a cross-tenant source with NOT_FOUND, not a leak", async () => {
    const source = await publishedPvVersion();
    await expect(
      cloneVersion(actor({ tenantId: 999 }), { sourceVersionId: source.id, notes: "n" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });
});
