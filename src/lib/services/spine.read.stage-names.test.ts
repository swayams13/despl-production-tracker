import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";

/**
 * B7/B8: `loadJobSpines`'s `stageName` now comes from the tenant+family
 * `WorkOrderStage` table instead of the old hardcoded, family-agnostic
 * `STAGE_NAMES` constant. B9: "a family may opt out of the 25-stage
 * reporting view entirely" (`TemplateProcess.workOrderStages`'s own doc
 * comment) — already true by construction once B7/B8 made the name lookup
 * family-scoped, verified here rather than rebuilt. Three things to prove:
 *  1. The PRESSURE_VESSEL path renders exactly as before (real seeded name).
 *  2. A second family with a crosswalk but no `WorkOrderStage` names yet
 *     falls back to a plain "Stage N" label instead of reusing
 *     PRESSURE_VESSEL's names or crashing.
 *  3. A third family with NO crosswalk at all (`workOrderStages` always
 *     `[]`) gets a real, empty spine — not null, not a crash (B9).
 *
 * No PIPE_SPOOL job exists in the seed (draft template, never pinned — see
 * prisma/seed.ts's own comment), so families 2 and 3 here are synthetic
 * fixtures built from scratch, not a live job. Live second-family
 * verification is deferred to item J1, per the blueprint's own instruction
 * not to seed a fake job just to make this check live.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("spine.read stageName + family opt-out (B7/B8/B9, DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadJobSpines } = await import("./spine.read");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  function actorBase(tenantId: number): Actor {
    return { userId: 1, tenantId, clientId: null, name: "Test", email: "t@x", roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("PRESSURE_VESSEL: a real family-scoped WorkOrderStage name is used (stage 7 = Cutting)", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    const jp = await owner.jobProcess.findFirst({ where: { jobId: job.id, workOrderStages: { has: 7 } } });
    if (!jp) throw new Error("seed's DESPL-320 job has no process backing stage 7 — check seed/lead-time-model.json");

    const spines = await loadJobSpines(actorBase(job.tenantId), job.id);
    const segment = spines?.flatMap((s) => s.segments).find((s) => s.stageNo === 7);
    expect(segment?.stageName).toBe("Cutting");
  });

  describe("second family, no WorkOrderStage crosswalk yet", () => {
    let tenantId = 0;
    let jobId = 0;

    beforeAll(async () => {
      const org = await owner.organization.create({ data: { code: `TEST-SPINE-FAM2-${Date.now()}`, name: "Second family test" } });
      tenantId = org.id;
      const family = await owner.productFamily.create({ data: { tenantId, code: "PIPE_SPOOL", name: "Pipe Spools" } });
      const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "Synthetic pipe-spool template" } });
      const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
      const client = await owner.client.create({ data: { tenantId, name: "Second family client" } });
      const job = await owner.job.create({
        data: {
          tenantId,
          publicId: `pub-spine-fam2-${Date.now()}`,
          clientId: client.id,
          familyId: family.id,
          templateVersionId: version.id,
          jobNumber: `JOB-SPINE-FAM2-${Date.now()}`,
        },
      });
      jobId = job.id;
      const dept = await owner.department.create({ data: { tenantId, code: "FAM2_DEPT", name: "Fam2 dept" } });
      // A different process count/name shape than PRESSURE_VESSEL's 36 — one
      // process, rolling up into stage 1, with no WorkOrderStage row for this
      // family at all (matching TemplateProcess.workOrderStages' own doc
      // comment: "empty for families with no equivalent reporting view").
      await owner.jobProcess.create({
        data: { jobId, seq: 1, code: "1", name: "Fam2 only process", departmentId: dept.id, workOrderStages: [1] },
      });
      const eq = await owner.equipment.create({ data: { jobId, name: "Fam2 equipment" } });
      await owner.unit.create({ data: { jobId, equipmentId: eq.id, serialNo: "FAM2-U1" } });
    });

    it("falls back to a plain \"Stage N\" label instead of reusing PRESSURE_VESSEL's names", async () => {
      const spines = await loadJobSpines(actorBase(tenantId), jobId);
      const segment = spines?.flatMap((s) => s.segments).find((s) => s.stageNo === 1);
      expect(segment?.stageName).toBe("Stage 1");
    });
  });

  /**
   * B9: "a family may opt out of the 25-stage reporting view entirely" —
   * `TemplateProcess.workOrderStages`'s own doc comment says it stays `[]`
   * for such a family. Proves `loadJobSpines` returns an empty array (not
   * null, not crashing) for that job — the mechanism `jobs/[id]`'s
   * client already relies on (`jobRollup.length > 0 ? <StageSpine .../> :
   * "No current schedule for this job."`).
   */
  describe("third family, no stage crosswalk at all (workOrderStages always [])", () => {
    let tenantId = 0;
    let jobId = 0;

    beforeAll(async () => {
      const org = await owner.organization.create({ data: { code: `TEST-SPINE-FAM3-${Date.now()}`, name: "No-crosswalk family test" } });
      tenantId = org.id;
      const family = await owner.productFamily.create({ data: { tenantId, code: "PIPING_SYSTEM", name: "Piping Systems" } });
      const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "Synthetic piping-system template" } });
      const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
      const client = await owner.client.create({ data: { tenantId, name: "No-crosswalk family client" } });
      const job = await owner.job.create({
        data: {
          tenantId,
          publicId: `pub-spine-fam3-${Date.now()}`,
          clientId: client.id,
          familyId: family.id,
          templateVersionId: version.id,
          jobNumber: `JOB-SPINE-FAM3-${Date.now()}`,
        },
      });
      jobId = job.id;
      const dept = await owner.department.create({ data: { tenantId, code: "FAM3_DEPT", name: "Fam3 dept" } });
      // workOrderStages deliberately omitted (defaults to []) — this family
      // has no 25-stage reporting view at all, not just no names for it.
      await owner.jobProcess.create({ data: { jobId, seq: 1, code: "1", name: "Fam3 only process", departmentId: dept.id } });
      const eq = await owner.equipment.create({ data: { jobId, name: "Fam3 equipment" } });
      await owner.unit.create({ data: { jobId, equipmentId: eq.id, serialNo: "FAM3-U1" } });
    });

    it("loadJobSpines returns an empty spine (real job, no crash) — the view's unnest() has nothing to join for a family with no crosswalk", async () => {
      const spines = await loadJobSpines(actorBase(tenantId), jobId);
      expect(spines).toEqual([]); // not null (job-not-found) and no thrown error
    });
  });
});
