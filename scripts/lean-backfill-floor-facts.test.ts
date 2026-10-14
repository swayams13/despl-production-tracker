import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillFloorFacts, diffStep, loadMapping, mappingSchema, type Mapping } from "./lean-backfill-floor-facts";

/**
 * Lean Core L1.2c: the draft DESPL-320 step mapping and the floor-facts backfill.
 * Pure tests first (the mapping file and the fill-only diff), then DB-gated tests
 * of the script itself against the disposable test database: dry run is the
 * default, --apply refuses a DRAFT mapping, a second run changes nothing, one
 * audit row per change, only jobs pinned to PV assembly template v1.
 *
 * // ponytail: no cleanup of fixtures — disposable test DB, per-run org codes.
 */
const mapping = loadMapping();
const template = JSON.parse(
  readFileSync(path.join(__dirname, "..", "seed", "assembly-template-pressure-vessel-v1.json"), "utf-8"),
) as { steps: { seq: number; kind: "WORK" | "INSPECTION"; activity: string; groupCode: string; groupName: string; srNo: string; jointRef?: string }[] };
const bySeq = new Map(mapping.steps.map((s) => [s.seq, s]));

describe("seed/assembly-step-roles-pv-v1.json (draft mapping of the 54 DESPL-320 steps)", () => {
  it("is marked DRAFT_NEEDS_SIGNOFF and unsigned: SJ and the QC head have not reviewed it", () => {
    const raw = JSON.parse(readFileSync(path.join(__dirname, "..", "seed", "assembly-step-roles-pv-v1.json"), "utf-8"));
    expect(raw.reviewStatus).toBe("DRAFT_NEEDS_SIGNOFF");
    expect(raw.signoff.signedOffBy).toBeNull();
    expect(raw.signoff.requiredFrom).toEqual(["SJ (Production Head)", "QC head"]);
  });

  it("rejects a malformed file: unknown role, duplicate seq, bad review status", () => {
    const ok = JSON.parse(JSON.stringify(mapping)) as Mapping;
    expect(mappingSchema.safeParse({ ...ok, steps: [{ ...ok.steps[0], role: "PAINT" }] }).success).toBe(false);
    expect(mappingSchema.safeParse({ ...ok, reviewStatus: "APPROVED" }).success).toBe(false);
    expect(mappingSchema.safeParse({ ...ok, steps: [] }).success).toBe(false);
  });

  it("covers exactly the template's 54 steps, once each", () => {
    expect(mapping.steps.map((s) => s.seq)).toEqual(template.steps.map((s) => s.seq));
    expect(mapping.steps).toHaveLength(54);
  });

  it("agrees with the template's own jointRef wherever the template sets one (LS-1, CS-2, CS-1)", () => {
    for (const t of template.steps.filter((s) => s.jointRef)) {
      expect(bySeq.get(t.seq)!.jointRef, `step ${t.seq}`).toBe(t.jointRef);
    }
  });

  it("has exactly one FINAL_PWHT (step 42) and one HYDRO (step 48)", () => {
    expect(mapping.steps.filter((s) => s.role === "FINAL_PWHT").map((s) => s.seq)).toEqual([42]);
    expect(mapping.steps.filter((s) => s.role === "HYDRO").map((s) => s.seq)).toEqual([48]);
  });

  it("never makes a post-hydro step a hydro prerequisite (WELD/NDT on a pressure part after step 48 would deadlock H6)", () => {
    const after = mapping.steps.filter((s) => s.seq > 48 && s.pressurePart && (s.role === "WELD" || s.role === "NDT"));
    expect(after).toEqual([]);
  });

  it("every joint a WELD step names has a FIT_UP step on the same joint before it, and an NDT step after it (H1 has something to chain)", () => {
    const joints = (s: Mapping["steps"][number]) => (s.jointRef ?? "").split(",").filter(Boolean);
    for (const w of mapping.steps.filter((s) => s.role === "WELD" && s.jointRef)) {
      for (const j of joints(w)) {
        const fit = mapping.steps.find((s) => s.role === "FIT_UP" && s.seq < w.seq && joints(s).includes(j));
        // A joint-specific NDT step, or an all-joints NDT step (no jointRef, pressure part) after it.
        const ndt = mapping.steps.find(
          (s) => s.role === "NDT" && s.seq > w.seq && (joints(s).includes(j) || (!s.jointRef && s.pressurePart)),
        );
        expect(fit, `weld ${w.seq} joint ${j} has no fit-up`).toBeDefined();
        expect(ndt, `weld ${w.seq} joint ${j} has no NDT`).toBeDefined();
      }
    }
  });

  it("joint-bearing roles are pressure parts; pressure joints are never given a non-joint role", () => {
    for (const s of mapping.steps.filter((x) => x.jointRef)) {
      expect(s.pressurePart, `step ${s.seq}`).toBe(true);
      expect(["FIT_UP", "WELD", "NDT"]).toContain(s.role);
    }
  });

  it("notes every step where a joint label or a role was guessed (invented NF-/NS-/SK- labels, attachments, edge prep)", () => {
    const guessed = mapping.steps.filter(
      (s) => /^(NF|NS|SK)-/.test(s.jointRef ?? "") || [9, 11, 12, 13, 26, 36, 37, 38, 49, 51].includes(s.seq),
    );
    expect(guessed.length).toBeGreaterThan(15);
    for (const s of guessed) expect(s.note, `step ${s.seq}`).toMatch(/GUESS/);
  });

  it("DESPL-320 component pressure flags: SKIRT false, PLATE/DISHED_END/FLANGE/PIPE/FORGING/COUPLING true", () => {
    expect(mapping.components.appliesToJobNumbers).toEqual(["DESPL-320"]);
    expect(mapping.components.pressureRetainingByComponentType).toEqual({
      SKIRT: false,
      PLATE: true,
      DISHED_END: true,
      FLANGE: true,
      PIPE: true,
      FORGING: true,
      COUPLING: true,
    });
  });
});

describe("diffStep: fill only, never overwrite", () => {
  const want = { seq: 14, role: "FIT_UP" as const, jointRef: "LS-1", pressurePart: true };
  it.each<[string, { role: string | null; jointRef: string | null; pressurePart: boolean }, object | null]>([
    ["an existing different role is kept", { role: "WELD", jointRef: "LS-1", pressurePart: true }, null],
    ["an existing different jointRef is kept", { role: "FIT_UP", jointRef: "XX", pressurePart: true }, null],
    ["already equal: nothing to do (idempotent)", { role: "FIT_UP", jointRef: "LS-1", pressurePart: true }, null],
    ["everything empty: all three filled", { role: null, jointRef: null, pressurePart: false }, { role: "FIT_UP", jointRef: "LS-1", pressurePart: true }],
    ["only pressurePart missing", { role: "FIT_UP", jointRef: "LS-1", pressurePart: false }, { pressurePart: true }],
    ["role set differently, others empty: only the empties are filled", { role: "WELD", jointRef: null, pressurePart: false }, { jointRef: "LS-1", pressurePart: true }],
  ])("%s", (_l, row, expected) => {
    expect(diffStep(row, want)?.after ?? null).toEqual(expected);
  });

  it("a mapped null role / false pressure never clears a set value", () => {
    expect(diffStep({ role: "WELD", jointRef: "A", pressurePart: true }, { seq: 1, role: null, jointRef: null, pressurePart: false })).toBeNull();
  });
});

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("lean-backfill-floor-facts (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const draft: Mapping = mapping;
  const reviewed: Mapping = { ...mapping, reviewStatus: "REVIEWED" };

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let tenantId: number;
  let main: { jobId: number; stepIds: number[]; comps: Record<string, number> };
  let other: { jobId: number; stepIds: number[]; comps: Record<string, number> };
  let v2Job: { jobId: number; stepIds: number[] };
  let heJob: { jobId: number; stepIds: number[] };
  let templateStepIds: number[];
  let allJobIds: number[];

  async function makeJob(opts: {
    jobNumber: string;
    familyId: number;
    versionId: number;
    templateStepRows: { id: number }[];
    equipmentName?: string;
    components?: boolean;
  }) {
    const client = await owner.client.findFirstOrThrow({ where: { tenantId } });
    const ptv = await owner.processTemplateVersion.findFirstOrThrow({ where: { template: { tenantId, familyId: opts.familyId } } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-${opts.jobNumber}-${stamp}`,
        clientId: client.id,
        familyId: opts.familyId,
        templateVersionId: ptv.id,
        assemblyTemplateVersionId: opts.versionId,
        jobNumber: opts.jobNumber,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: `01-${stamp}` } });
    await owner.assemblyStep.createMany({
      data: opts.templateStepRows.map((t, i) => ({ jobId: job.id, unitId: unit.id, templateStepId: t.id, seq: i + 1 })),
    });
    const steps = await owner.assemblyStep.findMany({ where: { jobId: job.id }, orderBy: { seq: "asc" }, select: { id: true } });
    const comps: Record<string, number> = {};
    if (opts.components) {
      for (const code of ["PLATE", "SKIRT", "COUPLING"]) {
        const type = await owner.componentTypeRef.upsert({
          where: { tenantId_code: { tenantId, code } },
          update: {},
          create: { tenantId, code, name: code },
        });
        const c = await owner.component.create({ data: { jobId: job.id, equipmentId: equipment.id, tag: `${code}-${job.id}`, componentTypeId: type.id } });
        comps[code] = c.id;
      }
      const cutting = await owner.operationRef.upsert({
        where: { tenantId_code: { tenantId, code: "CUTTING" } },
        update: {},
        create: { tenantId, code: "CUTTING", name: "Cutting" },
      });
      await owner.componentOperation.create({ data: { componentId: comps.PLATE, seq: 10, operationId: cutting.id, jobId: job.id } });
    }
    return { jobId: job.id, stepIds: steps.map((s) => s.id), comps };
  }

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `TEST-L12C-${stamp}`, name: "l12c" } });
    tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${stamp}` } });
    const pv = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const he = await owner.productFamily.create({ data: { tenantId, code: "HEAT_EXCHANGER", name: "HE" } });
    for (const f of [pv, he]) {
      const t = await owner.processTemplate.create({ data: { tenantId, familyId: f.id, name: `T-${f.code}` } });
      await owner.processTemplateVersion.create({ data: { templateId: t.id, version: 1 } });
    }
    const mkTemplate = async (familyId: number, version: number) => {
      const tpl =
        (await owner.assemblyTemplate.findFirst({ where: { tenantId, familyId } })) ??
        (await owner.assemblyTemplate.create({ data: { tenantId, familyId, name: `A-${familyId}` } }));
      const v = await owner.assemblyTemplateVersion.create({ data: { templateId: tpl.id, version, status: "PUBLISHED" } });
      await owner.assemblyTemplateStep.createMany({
        data: template.steps.map((s) => ({
          versionId: v.id,
          seq: s.seq,
          groupCode: s.groupCode,
          groupName: s.groupName,
          srNo: s.srNo,
          activity: s.activity,
          kind: s.kind,
          defaultDepartmentId: dept.id,
          jointRef: s.jointRef ?? null,
        })),
      });
      const rows = await owner.assemblyTemplateStep.findMany({ where: { versionId: v.id }, orderBy: { seq: "asc" }, select: { id: true } });
      return { versionId: v.id, rows };
    };
    const pv1 = await mkTemplate(pv.id, 1);
    templateStepIds = pv1.rows.map((r) => r.id);
    const pv2 = await mkTemplate(pv.id, 2);
    const he1 = await mkTemplate(he.id, 1);

    main = await makeJob({ jobNumber: "DESPL-320", familyId: pv.id, versionId: pv1.versionId, templateStepRows: pv1.rows, components: true });
    other = await makeJob({ jobNumber: `OTHER-${stamp}`, familyId: pv.id, versionId: pv1.versionId, templateStepRows: pv1.rows, components: true });
    v2Job = await makeJob({ jobNumber: `V2-${stamp}`, familyId: pv.id, versionId: pv2.versionId, templateStepRows: pv2.rows });
    heJob = await makeJob({ jobNumber: `HE-${stamp}`, familyId: he.id, versionId: he1.versionId, templateStepRows: he1.rows });
    allJobIds = [main.jobId, other.jobId, v2Job.jobId, heJob.jobId];
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  const stepsOf = (ids: number[]) =>
    owner.assemblyStep.findMany({ where: { id: { in: ids } }, orderBy: { seq: "asc" }, select: { seq: true, role: true, jointRef: true, pressurePart: true } });
  const auditCount = () =>
    owner.auditLog.count({ where: { tenantId, action: "backfill.floorFacts" } });
  const run = (m: Mapping, apply: boolean, extra: { allowDraft?: boolean; jobIds?: number[] } = {}) =>
    backfillFloorFacts(owner, { mapping: m, apply, jobIds: allJobIds, ...extra });

  // Order matters below: the dry run and the refusals come before the first apply.
  it("--apply with a DRAFT mapping is refused, and nothing is written", async () => {
    await expect(run(draft, true)).rejects.toThrow(/Refusing --apply: the mapping is DRAFT_NEEDS_SIGNOFF/);
    expect(await auditCount()).toBe(0);
    expect((await stepsOf(main.stepIds)).every((s) => s.role === null && s.jointRef === null && !s.pressurePart)).toBe(true);
  });

  it("dry run (the default) reports the changes and writes nothing", async () => {
    const report = await run(draft, false);
    expect(report.mode).toBe("DRY_RUN");
    // Only the two jobs pinned to PV assembly template v1 are in scope.
    expect(report.jobs.map((j) => j.jobId).sort()).toEqual([main.jobId, other.jobId].sort());
    const roleSteps = mapping.steps.filter((s) => s.role || s.jointRef || s.pressurePart).length;
    expect(report.jobs.find((j) => j.jobId === main.jobId)!.stepChanges).toBe(roleSteps);
    // Components only for DESPL-320: PLATE and COUPLING go true, SKIRT stays false.
    expect(report.jobs.find((j) => j.jobId === main.jobId)!.componentChanges).toBe(2);
    expect(report.jobs.find((j) => j.jobId === other.jobId)!.componentChanges).toBe(0);
    expect(report.totals.auditRows).toBe(0);
    expect(await auditCount()).toBe(0);
    expect((await stepsOf(main.stepIds)).every((s) => s.role === null)).toBe(true);
    const comps = await owner.component.findMany({ where: { jobId: main.jobId } });
    expect(comps.every((c) => !c.pressureRetaining)).toBe(true);
  });

  it("prints the requiresQc the rule derives for every step, flags which apply at intake, and lists component ops", async () => {
    const report = await run(draft, false);
    expect(report.requiresQcSteps).toHaveLength(54);
    const s = new Map(report.requiresQcSteps.map((x) => [x.seq, x]));
    expect(s.get(14)).toMatchObject({ requiresQc: true, appliedAtIntake: true }); // fit-up on a pressure joint
    expect(s.get(15)).toMatchObject({ requiresQc: true, appliedAtIntake: true });
    expect(s.get(16)).toMatchObject({ requiresQc: false, stepKind: "INSPECTION" }); // QC's own inspection
    expect(s.get(37)).toMatchObject({ requiresQc: false, appliedAtIntake: true }); // non-pressure attachment weld
    expect(s.get(42)).toMatchObject({ requiresQc: false }); // INSPECTION-kind PWHT record: QC is the checker
    expect(s.get(48)).toMatchObject({ requiresQc: true }); // hydro
    expect(s.get(9)).toMatchObject({ appliedAtIntake: false }); // no role: template value stays
    expect(report.requiresQcOps).toContainEqual(
      expect.objectContaining({ componentType: "PLATE", opCode: "CUTTING", pressure: true, requiresQc: true }),
    );
  });

  it("--apply (draft allowed, throwaway DB): fills only the pinned PV v1 jobs, one audit row per change", async () => {
    const report = await run(draft, true, { allowDraft: true });
    expect(report.mode).toBe("APPLIED");

    const m = await stepsOf(main.stepIds);
    for (const row of m) {
      const want = bySeq.get(row.seq)!;
      expect(row.role, `seq ${row.seq}`).toBe(want.role);
      expect(row.jointRef, `seq ${row.seq}`).toBe(want.jointRef);
      expect(row.pressurePart, `seq ${row.seq}`).toBe(want.pressurePart);
    }
    // The other PV v1 job gets the steps but not the DESPL-320-only component flags.
    expect((await stepsOf(other.stepIds)).filter((s) => s.role).length).toBe(mapping.steps.filter((s) => s.role).length);
    expect((await owner.component.findMany({ where: { jobId: other.jobId } })).every((c) => !c.pressureRetaining)).toBe(true);
    // PLATE and COUPLING true, SKIRT untouched.
    expect((await owner.component.findUniqueOrThrow({ where: { id: main.comps.PLATE } })).pressureRetaining).toBe(true);
    expect((await owner.component.findUniqueOrThrow({ where: { id: main.comps.COUPLING } })).pressureRetaining).toBe(true);
    expect((await owner.component.findUniqueOrThrow({ where: { id: main.comps.SKIRT } })).pressureRetaining).toBe(false);

    // Jobs not pinned to PV template v1 (v2, another family) are untouched.
    for (const j of [v2Job, heJob]) {
      expect((await stepsOf(j.stepIds)).every((s) => s.role === null && s.jointRef === null && !s.pressurePart)).toBe(true);
    }
    // Published template rows are never touched (invariant 9).
    const tplRows = await owner.assemblyTemplateStep.findMany({ where: { id: { in: templateStepIds } } });
    expect(tplRows.every((t) => t.role === null && !t.pressurePart)).toBe(true);

    // One audit row per changed row, actor null, before/after on the changed fields only.
    const changed = report.totals.stepChanges + report.totals.componentChanges;
    expect(report.totals.auditRows).toBe(changed);
    expect(await auditCount()).toBe(changed);
    const sample = await owner.auditLog.findFirstOrThrow({
      where: { tenantId, action: "backfill.floorFacts", entityType: "AssemblyStep", entityId: String(main.stepIds[13]) },
    });
    expect(sample.actorId).toBeNull();
    expect(sample.before).toEqual({ role: null, jointRef: null, pressurePart: false });
    expect(sample.after).toEqual({ role: "FIT_UP", jointRef: "LS-1", pressurePart: true });
  });

  it("a second apply changes nothing and writes no audit rows (idempotent)", async () => {
    const before = await auditCount();
    const report = await run(reviewed, true);
    expect(report.totals).toMatchObject({ stepChanges: 0, componentChanges: 0, auditRows: 0 });
    expect(await auditCount()).toBe(before);
  });

  it("never overwrites a value that is already set: a step holding a different role is kept and reported", async () => {
    const id = other.stepIds[13]; // seq 14, mapped FIT_UP
    await owner.assemblyStep.update({ where: { id }, data: { role: "WELD" } });
    const report = await run(reviewed, true);
    expect((await owner.assemblyStep.findUniqueOrThrow({ where: { id } })).role).toBe("WELD");
    expect(report.jobs.find((j) => j.jobId === other.jobId)!.stepsKept).toBeGreaterThanOrEqual(1);
    expect(report.totals.stepChanges).toBe(0);
  });

  it("a REVIEWED mapping applies without --allow-draft", async () => {
    // Reset one row, then confirm the REVIEWED path (no allowDraft) writes it back.
    const id = main.stepIds[14]; // seq 15
    await owner.assemblyStep.update({ where: { id }, data: { role: null, jointRef: null, pressurePart: false } });
    const report = await run(reviewed, true);
    expect(report.totals.stepChanges).toBe(1);
    expect((await owner.assemblyStep.findUniqueOrThrow({ where: { id } })).role).toBe("WELD");
  });
});
