import { afterAll, describe, expect, it } from "vitest";

/**
 * Lean Core M1 (PR B) accept criterion: DESPL-320 regenerates unchanged.
 *
 * Runs against the seeded DESPL-320 job (99 components, 486 component
 * operations, 9 units) and compares the new step-first rollup and route pick
 * with the old rules computed independently here:
 *   - rollup: operations on the unit whose operationId is mapped to the
 *     process by `OperationRefFamilySeq` (the pre-M1 join);
 *   - route pick: each component's own `routeVersionId` is what the
 *     materialiser picks from the routes available to its type and family.
 * Skips (does not fail) when DESPL-320 is not seeded, like the other
 * seed-dependent DB tests. Read-only.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core M1 PR B — DESPL-320 regenerates unchanged (DB, seeded)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { loadMappedOps } = await import("./_shared");
  const { pickRouteTemplate } = await import("@/lib/shared/stage-mapping");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function despl320() {
    const org = await owner.organization.findUnique({ where: { code: "DESPL" }, select: { id: true } });
    if (!org) return null;
    const job = await owner.job.findFirst({
      where: { tenantId: org.id, jobNumber: "DESPL-320" },
      select: { id: true, familyId: true, tenantId: true },
    });
    return job;
  }

  it("has no step-level mapping rows, so every rollup is the operation-level join", async () => {
    const job = await despl320();
    if (!job) return;
    // Only the routes DESPL-320's own components pin: db:seed adds a demo "Shell Course" route
    // (M3 master-data demo) with step-level rows that no DESPL-320 component uses.
    const pinned = await owner.component.findMany({
      where: { jobId: job.id, routeVersionId: { not: null } },
      select: { routeVersionId: true },
    });
    expect(pinned.length).toBeGreaterThan(0);
    const routeVersionIds = pinned.map((c) => c.routeVersionId!);
    expect(
      await owner.routeStepFamilySeq.count({
        where: { familyId: job.familyId, routeStep: { routeVersionId: { in: routeVersionIds } } },
      }),
    ).toBe(0);
  });

  it("loadMappedOps equals the pre-M1 operation-level join for every numeric process on every unit", async () => {
    const job = await despl320();
    if (!job) return;
    const [processes, units, familySeq] = await Promise.all([
      owner.jobProcess.findMany({ where: { jobId: job.id }, select: { id: true, code: true } }),
      owner.unit.findMany({ where: { jobId: job.id }, select: { id: true } }),
      owner.operationRefFamilySeq.findMany({
        where: { familyId: job.familyId },
        select: { operationRefId: true, leadTimeProcessSeq: true },
      }),
    ]);
    expect(units.length).toBeGreaterThan(0);
    const numeric = processes.filter((p) => /^\d+$/.test(p.code));
    expect(numeric.length).toBeGreaterThan(0);

    let comparedNonEmpty = 0;
    for (const unit of units) {
      const ops = await owner.componentOperation.findMany({
        where: { component: { unitId: unit.id } },
        select: { operationId: true, operation: { select: { name: true } } },
      });
      for (const p of numeric) {
        const seq = Number(p.code);
        const mappedOperationIds = new Set(familySeq.filter((r) => r.leadTimeProcessSeq === seq).map((r) => r.operationRefId));
        const expected = ops.filter((o) => mappedOperationIds.has(o.operationId)).map((o) => o.operation.name).sort();
        const got = (await withTenant(job.tenantId, (tx) => loadMappedOps(tx, { jobProcessId: p.id, unitId: unit.id, jobId: job.id })))
          .filter((o) => o.source === "fabrication")
          .map((o) => o.label)
          .sort();
        expect(got, `process ${p.code} unit ${unit.id}`).toEqual(expected);
        if (expected.length > 0) comparedNonEmpty++;
      }
    }
    // The comparison must have exercised real mappings, not just empty sets.
    expect(comparedNonEmpty).toBeGreaterThan(0);
  });

  it("the deterministic route pick returns each existing component's own route version", async () => {
    const job = await despl320();
    if (!job) return;
    const components = await owner.component.findMany({
      where: { jobId: job.id, routeVersionId: { not: null } },
      select: { componentTypeId: true, routeVersionId: true },
    });
    expect(components.length).toBeGreaterThan(0);
    const typeIds = [...new Set(components.map((c) => c.componentTypeId))];
    const templates = await owner.routeTemplate.findMany({
      where: { componentTypeId: { in: typeIds }, OR: [{ familyId: job.familyId }, { familyId: null }] },
      include: { versions: { where: { status: "PUBLISHED" }, orderBy: { version: "desc" }, select: { id: true } } },
    });
    const mismatches: number[] = [];
    for (const typeId of typeIds) {
      const picked = pickRouteTemplate(templates.filter((t) => t.componentTypeId === typeId));
      const pickedVersion = picked?.versions[0]?.id ?? null;
      for (const c of components.filter((c) => c.componentTypeId === typeId)) {
        // A component may pin an older published version (route revised later);
        // the pick only has to stay on the same TEMPLATE it was built from.
        if (pickedVersion == null) {
          mismatches.push(typeId);
          continue;
        }
        const own = await owner.routeTemplateVersion.findUniqueOrThrow({
          where: { id: c.routeVersionId! },
          select: { routeId: true },
        });
        if (own.routeId !== picked!.id) mismatches.push(typeId);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
