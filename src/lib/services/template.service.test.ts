import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES } from "@/lib/shared/errors";
import { createTemplate, cloneVersion, saveDraftVersion, publishVersion } from "./template.service";
import type { SaveDraftVersionInput } from "@/lib/shared/schemas";

type DraftProcessInput = SaveDraftVersionInput["processes"][number];

/** Fills the schema's defaulted fields so literals below only spell out what a test cares about. */
function proc(over: Partial<DraftProcessInput> & Pick<DraftProcessInput, "key" | "seq" | "code" | "name" | "defaultDepartmentId">): DraftProcessInput {
  return {
    mainActivities: null,
    envelopeStartByMinDays: null,
    envelopeStartByMaxDays: null,
    envelopeFinishByMinDays: null,
    envelopeFinishByMaxDays: null,
    workOrderStages: [],
    optional: false,
    provisional: true,
    durationMinDays: null,
    durationMaxDays: null,
    ...over,
  };
}

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

  it("saveDraftVersion refuses a QC caller", async () => {
    await expect(
      saveDraftVersion(actor({ roles: [ROLES.QC] }), {
        versionId: 1,
        expectedUpdatedAt: null,
        processes: [],
        edges: [],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORBIDDEN });
  });

  it("rejects a process claiming confirmed durations it does not have", async () => {
    await expect(
      saveDraftVersion(actor(), {
        versionId: 1,
        expectedUpdatedAt: null,
        processes: [
          proc({
            key: "a",
            seq: 1,
            code: "1",
            name: "Kickoff",
            defaultDepartmentId: 1,
            provisional: false, // says confirmed…
            durationMinDays: null, // …but has no duration (invariant #10)
            durationMaxDays: null,
          }),
        ],
        edges: [],
      }),
    ).rejects.toThrow();
  });

  it("rejects a process whose minimum duration exceeds its maximum", async () => {
    await expect(
      saveDraftVersion(actor(), {
        versionId: 1,
        expectedUpdatedAt: null,
        processes: [
          proc({
            key: "a",
            seq: 1,
            code: "1",
            name: "Kickoff",
            defaultDepartmentId: 1,
            provisional: false,
            durationMinDays: 9,
            durationMaxDays: 3,
          }),
        ],
        edges: [],
      }),
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

/**
 * Same `owner`-client rationale as the clone suite above: process_template_
 * versions / template_processes / template_edges carry no RLS of their own,
 * so `owner` (DIRECT_URL) is fine here purely for setup/teardown reads —
 * `saveDraftVersion` itself always goes through its own `withTenant`, which
 * is the real request path being verified.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("template.service — saveDraftVersion (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function freshDraft() {
    const source = await owner.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
    });
    return cloneVersion(actor(), { sourceVersionId: source.id, notes: "save test" });
  }

  it("replaces the draft's contents wholesale", async () => {
    const draft = await freshDraft();
    const loaded = await owner.processTemplateVersion.findUniqueOrThrow({ where: { id: draft.id } });
    const dept = await owner.department.findFirstOrThrow({ where: { tenantId: 1 } });

    await saveDraftVersion(actor(), {
      versionId: draft.id,
      expectedUpdatedAt: loaded.updatedAt,
      processes: [
        proc({ key: "a", seq: 1, code: "1", name: "Start", defaultDepartmentId: dept.id }),
        proc({ key: "b", seq: 2, code: "2", name: "End", defaultDepartmentId: dept.id }),
      ],
      edges: [{ processKey: "b", predecessorKey: "a", type: "FINISH_TO_START", lagDays: 0 }],
    });

    expect(await owner.templateProcess.count({ where: { versionId: draft.id } })).toBe(2);
    expect(await owner.templateEdge.count({ where: { versionId: draft.id } })).toBe(1);

    await owner.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses a save against a PUBLISHED version (invariant #9)", async () => {
    const published = await owner.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
    });
    await expect(
      saveDraftVersion(actor(), {
        versionId: published.id,
        expectedUpdatedAt: published.updatedAt,
        processes: [],
        edges: [],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_VERSION_LOCKED });
  });

  it("refuses a stale write and leaves the draft unchanged", async () => {
    const draft = await freshDraft();
    const countBefore = await owner.templateProcess.count({ where: { versionId: draft.id } });

    await expect(
      saveDraftVersion(actor(), {
        versionId: draft.id,
        expectedUpdatedAt: new Date(0), // definitely not the current stamp
        processes: [],
        edges: [],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.STALE_WRITE });

    expect(await owner.templateProcess.count({ where: { versionId: draft.id } })).toBe(countBefore);
    await owner.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  /**
   * Genuine two-transaction race, not a simulated one: both calls fire via
   * Promise.all against the same draft with the same expectedUpdatedAt. The
   * `FOR UPDATE` lock this task added makes the second call's transaction
   * block on Postgres until the first one commits (including its updatedAt
   * bump), so the second's own findFirst read happens strictly after that
   * commit and sees the new stamp — no artificial delay needed, the lock
   * itself is what forces the interleaving. Before the fix this test would
   * have failed: both calls would pass staleness and the loser would
   * silently clobber the winner's processes instead of throwing.
   */
  it("serializes concurrent saves — the loser sees the winner's new stamp and gets STALE_WRITE", async () => {
    const draft = await freshDraft();
    const loaded = await owner.processTemplateVersion.findUniqueOrThrow({ where: { id: draft.id } });
    const dept = await owner.department.findFirstOrThrow({ where: { tenantId: 1 } });

    const racer = (key: string) =>
      saveDraftVersion(actor(), {
        versionId: draft.id,
        expectedUpdatedAt: loaded.updatedAt,
        processes: [proc({ key, seq: 1, code: key, name: key, defaultDepartmentId: dept.id })],
        edges: [],
      });

    const results = await Promise.allSettled([racer("a"), racer("b")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: ERROR_CODES.STALE_WRITE });
    // The loser's payload never landed — exactly one process survives, from the winner only.
    expect(await owner.templateProcess.count({ where: { versionId: draft.id } })).toBe(1);

    await owner.processTemplateVersion.delete({ where: { id: draft.id } });
  });
});

/**
 * Same `owner`-client rationale as the blocks above — process_templates and
 * departments carry tenant RLS, so setup/teardown reads here go through a
 * DIRECT_URL-backed client (named `prisma` to match this suite's own reads,
 * not the app-role singleton in `@/lib/db`). `publishVersion` itself always
 * goes through its own `withTenant`, the real request path being verified.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("template.service — publishVersion (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function draftFromPv() {
    const source = await prisma.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
    });
    return cloneVersion(actor(), { sourceVersionId: source.id, notes: "publish test" });
  }

  async function writeGraph(
    versionId: number,
    processes: Array<{ key: string; seq: number; code: string; name: string }>,
    edges: Array<{ processKey: string; predecessorKey: string }>,
  ) {
    const loaded = await prisma.processTemplateVersion.findUniqueOrThrow({ where: { id: versionId } });
    const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: 1 } });
    await saveDraftVersion(actor(), {
      versionId,
      expectedUpdatedAt: loaded.updatedAt,
      // proc() fills the schema's defaulted fields (mainActivities,
      // workOrderStages, ...) — SaveDraftVersionInput is z.infer's OUTPUT
      // type (defaults applied), so a bare spread here is missing keys at
      // the type level even though the runtime schema would default them.
      processes: processes.map((p) =>
        proc({ ...p, defaultDepartmentId: dept.id, provisional: true, durationMinDays: null, durationMaxDays: null }),
      ),
      edges: edges.map((e) => ({ ...e, type: "FINISH_TO_START" as const, lagDays: 0 })),
    });
  }

  it("publishes the real seeded PRESSURE_VESSEL route unchanged, warning about its three terminals", async () => {
    // The regression that motivated the spec's rule change: this route has
    // ONE root and THREE terminals (36 Dispatch, 5 Client Drawing Approval,
    // 6 BOM & MTO Finalization). A validator stricter than DESPL's own
    // process would refuse the only route in the system that works.
    const draft = await draftFromPv();
    const result = await publishVersion(actor(), {
      versionId: draft.id,
      notes: "verbatim clone of the seeded lead-time route",
      acknowledgedWarnings: ["MULTIPLE_TERMINALS"],
      expectedEnvelopeDays: null,
    });
    expect(result.version.status).toBe("PUBLISHED");
    expect(result.version.publishedAt).not.toBeNull();
    const terminals = result.warnings.find((w) => w.code === "MULTIPLE_TERMINALS");
    expect(terminals?.processCodes.sort()).toEqual(["36", "5", "6"]);
    expect(result.envelopeDays).toBeGreaterThan(0);
    // owner bypasses the service's own TEMPLATE_VERSION_LOCKED refusal (direct
    // table-owner access, not a request through publishVersion) — test hygiene
    // cleanup only, not proof a PUBLISHED version can be deleted normally.
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses an empty route", async () => {
    const draft = await draftFromPv();
    await writeGraph(draft.id, [], []);
    await expect(
      publishVersion(actor(), { versionId: draft.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_INCOMPLETE });
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses non-contiguous sequence numbers", async () => {
    const draft = await draftFromPv();
    await writeGraph(
      draft.id,
      [
        { key: "a", seq: 1, code: "1", name: "A" },
        { key: "b", seq: 5, code: "2", name: "B" },
      ],
      [{ processKey: "b", predecessorKey: "a" }],
    );
    await expect(
      publishVersion(actor(), { versionId: draft.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_INCOMPLETE });
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses a cycle and names its members", async () => {
    const draft = await draftFromPv();
    await writeGraph(
      draft.id,
      [
        { key: "a", seq: 1, code: "1", name: "A" },
        { key: "b", seq: 2, code: "2", name: "B" },
      ],
      [
        { processKey: "b", predecessorKey: "a" },
        { processKey: "a", predecessorKey: "b" },
      ],
    );
    await expect(
      publishVersion(actor(), { versionId: draft.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.SCHEDULE_GRAPH_INVALID,
      detail: expect.objectContaining({ processCodes: expect.arrayContaining(["1", "2"]) }),
    });
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses a process unreachable from any root", async () => {
    const draft = await draftFromPv();
    // a → b is a clean chain; c and d form a closed loop nothing can enter.
    await writeGraph(
      draft.id,
      [
        { key: "a", seq: 1, code: "1", name: "A" },
        { key: "b", seq: 2, code: "2", name: "B" },
        { key: "c", seq: 3, code: "3", name: "C" },
        { key: "d", seq: 4, code: "4", name: "D" },
      ],
      [
        { processKey: "b", predecessorKey: "a" },
        { processKey: "d", predecessorKey: "c" },
        { processKey: "c", predecessorKey: "d" },
      ],
    );
    await expect(
      publishVersion(actor(), { versionId: draft.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.SCHEDULE_GRAPH_INVALID });
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("refuses publishing an already-PUBLISHED version (invariant #9)", async () => {
    const published = await prisma.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
    });
    await expect(
      publishVersion(actor(), { versionId: published.id, notes: "n", acknowledgedWarnings: [], expectedEnvelopeDays: null }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TEMPLATE_VERSION_LOCKED });
  });

  it("warns about provisional processes instead of blocking, and computes no envelope", async () => {
    const draft = await draftFromPv();
    await writeGraph(
      draft.id,
      [
        { key: "a", seq: 1, code: "1", name: "A" },
        { key: "b", seq: 2, code: "2", name: "B" },
      ],
      [{ processKey: "b", predecessorKey: "a" }],
    );
    const result = await publishVersion(actor(), {
      versionId: draft.id,
      notes: "provisional route, no lead-time document",
      acknowledgedWarnings: ["PROVISIONAL_DURATIONS", "EMPTY_WORK_ORDER_STAGES"],
      expectedEnvelopeDays: null,
    });
    expect(result.version.status).toBe("PUBLISHED");
    expect(result.warnings.map((w) => w.code)).toContain("PROVISIONAL_DURATIONS");
    expect(result.envelopeDays).toBeNull();
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("warns when the computed envelope contradicts the expected printed total (invariant #10)", async () => {
    const draft = await draftFromPv();
    const result = await publishVersion(actor(), {
      versionId: draft.id,
      notes: "envelope mismatch check",
      acknowledgedWarnings: ["MULTIPLE_TERMINALS", "ENVELOPE_MISMATCH"],
      expectedEnvelopeDays: 3, // nowhere near the real ~17-week envelope
    });
    expect(result.warnings.map((w) => w.code)).toContain("ENVELOPE_MISMATCH");
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });

  it("writes exactly one audit row per publish", async () => {
    const draft = await draftFromPv();
    const before = await prisma.auditLog.count({ where: { action: "template.publish" } });
    await publishVersion(actor(), {
      versionId: draft.id,
      notes: "audit test",
      acknowledgedWarnings: ["MULTIPLE_TERMINALS"],
      expectedEnvelopeDays: null,
    });
    expect(await prisma.auditLog.count({ where: { action: "template.publish" } })).toBe(before + 1);
    await prisma.processTemplateVersion.delete({ where: { id: draft.id } });
  });
});
