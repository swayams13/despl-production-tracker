import { afterAll, describe, expect, it } from "vitest";

/**
 * Lean Core J2 — questions and rules as data.
 * Proves migration 20261020100000_j2_questions_rules (CHECKs, uniques, RLS,
 * append-only ledger) and the configure-time behaviour of createJob and
 * materializeComponentsFromBomItems: answers stored per line, includeWhen
 * decisions on JobProcess / assembly steps / QCP items / route steps, the
 * ledger, and the "missing answer includes and flags" default.
 * Violation cases first, per CLAUDE.md. Gated behind RUN_DB_TESTS; every
 * fixture is its own disposable tenant (owner client bypasses RLS).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

const pwht = { all: [{ key: "pwht", op: "truthy" }] };
const extra = { all: [{ key: "extra", op: "truthy" }] };

describe.skipIf(!RUN_DB)("Lean Core J2 questions and rules (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { ROLES } = await import("@/lib/authz");
  const { createJob } = await import("./job-intake.service");
  const { createEquipmentType } = await import("./admin.service");
  const { materializeComponentsFromBomItems } = await import("./component.service");
  const { flushRuleDecisions, LineRules } = await import("./config-rules");
  const { ensurePvConfigQuestions } = await import("./config-questions.setup");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;

  type Q = { key: string; type: "NUMBER" | "TEXT" | "SELECT" | "BOOLEAN"; options?: string[]; typeId?: number; def?: unknown };

  /** A disposable tenant with a family, a 3-process route, an assembly template (5 steps), a library QCP, and questions. */
  async function world(label: string, opts: { questions?: Q[]; rules?: boolean } = {}) {
    const rules = opts.rules ?? true;
    const org = await owner.organization.create({ data: { code: `TEST-J2-${label}-${stamp}-${++n}`, name: `j2 ${label}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const user = await owner.user.create({
      data: { tenantId, email: `${uniq("u")}@test.local`, username: uniq("u"), passwordHash: "x", name: "Admin", mustChangePassword: false },
    });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const eqType = await owner.equipmentTypeRef.create({ data: { tenantId, familyId: family.id, code: "T-SKIRT", name: "Skirt" } });

    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    const proc = async (seq: number, code: string, optional: boolean, includeWhen?: unknown) =>
      owner.templateProcess.create({
        data: { versionId: tv.id, seq, code, name: `Process ${code}`, defaultDepartmentId: dept.id, optional, includeWhen: includeWhen as never },
      });
    const p10 = await proc(1, "10", false);
    const p20 = await proc(2, "20", true, rules ? pwht : undefined);
    const p30 = await proc(3, "30", false, rules ? pwht : undefined);

    const asm = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: "A-Q" } });
    const av = await owner.assemblyTemplateVersion.create({ data: { templateId: asm.id, version: 1, status: "PUBLISHED", publishedAt: new Date() } });
    const step = (seq: number, srNo: string, kind: "WORK" | "INSPECTION", includeWhen?: unknown) => ({
      versionId: av.id,
      seq,
      groupCode: "A",
      groupName: "A",
      srNo,
      activity: `step ${seq}`,
      kind,
      defaultDepartmentId: dept.id,
      qcpSrNo: srNo,
      includeWhen: includeWhen as never,
    });
    await owner.assemblyTemplateStep.createMany({
      data: [
        step(1, "1", "WORK"),
        step(2, "2", "WORK", rules ? pwht : undefined),
        step(3, "3", "INSPECTION", rules ? pwht : undefined),
        step(4, "3", "INSPECTION"),
        step(5, "5", "INSPECTION"),
      ],
    });
    const asmSteps = await owner.assemblyTemplateStep.findMany({ where: { versionId: av.id }, orderBy: { seq: "asc" } });

    const qcp = await owner.qcpTemplate.create({ data: { tenantId, jobLabel: "LIB", vessel: "V" } });
    const item = (sequence: number, srNo: string, includeWhen?: unknown) =>
      owner.qcpItem.create({
        data: { tenantId, qcpTemplateId: qcp.id, sequence, srNo, kind: "CHECKPOINT", activity: `qcp ${sequence}`, includeWhen: includeWhen as never },
      });
    const qA = await item(1, "3", rules ? pwht : undefined); // the first srNo-3 checkpoint: step 3 binds to it
    const qB = await item(2, "3"); // the second: step 4 binds to it
    const qC = await item(3, "5", rules ? extra : undefined);

    const questions: Q[] = opts.questions ?? [
      { key: "pwht", type: "BOOLEAN" },
      { key: "extra", type: "BOOLEAN" },
      { key: "design_pressure", type: "NUMBER" },
      { key: "orientation", type: "SELECT", options: ["Vertical", "Horizontal"], def: "Vertical" },
      { key: "skirt_height", type: "NUMBER", typeId: eqType.id },
    ];
    for (const [i, q] of questions.entries()) {
      await owner.configQuestion.create({
        data: {
          tenantId,
          familyId: family.id,
          equipmentTypeId: q.typeId ?? null,
          key: q.key,
          label: q.key,
          type: q.type,
          options: q.options as never,
          defaultValue: q.def as never,
          sortOrder: i,
        },
      });
    }

    const actor = {
      userId: user.id,
      tenantId,
      clientId: null,
      name: "Admin",
      email: user.email,
      roles: [ROLES.ADMIN],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM" as const,
      outdoorMode: false,
    };
    const jobs: number[] = [];
    const make = async (
      lines: { config?: Record<string, unknown> | null; typeId?: number | null; serials?: string[] }[],
      extraInput: Record<string, unknown> = {},
    ) => {
      const res = await createJob(actor, {
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        calendarId: null,
        jobNumber: uniq("J2"),
        clientOrderNo: null,
        projectName: null,
        poRef: null,
        designCode: null,
        orderDate: null,
        committedDeliveryDate: null,
        targetDispatchDate: null,
        priority: "NORMAL",
        remarks: null,
        excludedProcessCodes: [],
        exclusionReason: null,
        equipments: lines.map((l, i) => ({
          equipmentTypeId: l.typeId ?? null,
          name: `Line ${i + 1}`,
          blockNo: i + 1,
          remarks: null,
          config: l.config ?? null,
          serials: l.serials ?? [`${label}-L${i + 1}-U1`],
        })),
        qcpTemplateSourceId: qcp.id,
        copyBomFromEquipmentId: null,
        ...extraInput,
      } as never);
      jobs.push(res.jobId);
      return res;
    };
    return { tenantId, org, dept, family, eqType, tv, p10, p20, p30, asmSteps, qcp, qA, qB, qC, actor, make, jobs };
  }

  type World = Awaited<ReturnType<typeof world>>;

  const ledger = (jobId: number) =>
    owner.configRuleDecision.findMany({ where: { jobId }, orderBy: [{ entityType: "asc" }, { entityId: "asc" }, { equipmentId: "asc" }] });
  const stepSeqs = async (jobId: number) =>
    (await owner.assemblyStep.findMany({ where: { jobId }, orderBy: { seq: "asc" }, select: { seq: true } })).map((s) => s.seq);

  afterAll(async () => {
    await owner.$disconnect();
  });

  // ── violation cases first ─────────────────────────────────────────────────
  describe("config_questions constraints", () => {
    it.each([
      ["camelCase", "designPressure"],
      ["upper case", "PWHT"],
      ["leading digit", "1abc"],
      ["a space", "a b"],
      ["a dash", "a-b"],
      ["empty", ""],
    ])("rejects a key with %s", async (_l, key) => {
      const w = await world("KEYCHK", { questions: [] });
      await expect(
        owner.configQuestion.create({ data: { tenantId: w.tenantId, familyId: w.family.id, key, label: "x", type: "TEXT" } }),
      ).rejects.toThrow(/config_questions_key_chk|check constraint/i);
    });

    it.each([
      ["SELECT without options", "SELECT", undefined],
      ["SELECT with an empty list", "SELECT", []],
      ["SELECT with options that are not a list", "SELECT", { a: 1 }],
      ["TEXT with options", "TEXT", ["a"]],
      ["BOOLEAN with options", "BOOLEAN", ["a"]],
    ])("rejects %s", async (_l, type, options) => {
      const w = await world("OPTCHK", { questions: [] });
      await expect(
        owner.configQuestion.create({
          data: { tenantId: w.tenantId, familyId: w.family.id, key: "q", label: "x", type: type as "SELECT", options: options as never },
        }),
      ).rejects.toThrow(/config_questions_options_chk|check constraint/i);
    });

    it("rejects the same key twice in a family, including a type-scoped question shadowing a family one", async () => {
      const w = await world("DUPKEY", { questions: [{ key: "pwht", type: "BOOLEAN" }] });
      await expect(
        owner.configQuestion.create({ data: { tenantId: w.tenantId, familyId: w.family.id, key: "pwht", label: "x", type: "TEXT" } }),
      ).rejects.toThrow(/Unique constraint/i);
      await expect(
        owner.configQuestion.create({
          data: { tenantId: w.tenantId, familyId: w.family.id, equipmentTypeId: w.eqType.id, key: "pwht", label: "x", type: "TEXT" },
        }),
      ).rejects.toThrow(/Unique constraint/i);
    });
  });

  describe("tenant isolation and the append-only ledger (app role)", () => {
    it("tenant B cannot read or write tenant A's questions", async () => {
      const a = await world("RLSA", { questions: [{ key: "pwht", type: "BOOLEAN" }] });
      const b = await world("RLSB", { questions: [] });
      const seenByB = await withTenant(b.tenantId, (tx) => tx.configQuestion.findMany({ where: { familyId: a.family.id } }));
      expect(seenByB).toEqual([]);
      expect(await withTenant(a.tenantId, (tx) => tx.configQuestion.count({ where: { familyId: a.family.id } }))).toBe(1);
      await expect(
        withTenant(b.tenantId, (tx) =>
          tx.configQuestion.create({ data: { tenantId: a.tenantId, familyId: a.family.id, key: "x", label: "x", type: "TEXT" } }),
        ),
      ).rejects.toThrow();
    });

    it("tenant B cannot read tenant A's decisions; nobody can update or delete one", async () => {
      const a = await world("LEDA");
      const b = await world("LEDB", { questions: [] });
      const r = await a.make([{ config: { pwht: false } }]);
      const rows = await ledger(r.jobId);
      expect(rows.length).toBeGreaterThan(0);
      expect(await withTenant(b.tenantId, (tx) => tx.configRuleDecision.findMany({ where: { jobId: r.jobId } }))).toEqual([]);
      await expect(
        withTenant(a.tenantId, (tx) => tx.configRuleDecision.update({ where: { id: rows[0].id }, data: { included: !rows[0].included } })),
      ).rejects.toThrow(/permission denied/i);
      await expect(withTenant(a.tenantId, (tx) => tx.configRuleDecision.delete({ where: { id: rows[0].id } }))).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  describe("createJob: a rule needs a readable answer, or it includes and flags", () => {
    it("a step kept by its rule whose QCP checkpoint a rule dropped fails loudly and leaves no job behind", async () => {
      const w = await world("DROPPED");
      const before = await owner.job.count({ where: { tenantId: w.tenantId } });
      // extra=false drops checkpoint C (srNo 5) but step 5 has no rule: an authoring inconsistency, not something to guess around
      await expect(w.make([{ config: { pwht: true, extra: false } }])).rejects.toMatchObject({
        code: "QCP_ITEM_UNRESOLVED",
        detail: { srNo: "5", droppedByRule: true },
      });
      expect(await owner.job.count({ where: { tenantId: w.tenantId } })).toBe(before);
      expect(await owner.configRuleDecision.count({ where: { tenantId: w.tenantId } })).toBe(0);
    });

    it("a rule on a MANDATORY process is ignored and flagged, never applied", async () => {
      const w = await world("MANDATORY");
      const r = await w.make([{ config: { pwht: false } }]);
      const jp = await owner.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: "30" } });
      expect(jp.included).toBe(true);
      const row = (await ledger(r.jobId)).find((x) => x.entityType === "TEMPLATE_PROCESS" && x.entityId === w.p30.id)!;
      expect(row).toMatchObject({ included: true, flagged: true });
      expect(JSON.stringify(row.reason)).toMatch(/mandatory/);
    });

    it("an unreadable rule never excludes: the step is materialised and the row says why", async () => {
      const w = await world("BADRULE");
      await owner.assemblyTemplateStep.update({ where: { id: w.asmSteps[1].id }, data: { includeWhen: { all: [{ key: "pwht", op: "gt", value: 1 }] } } });
      const r = await w.make([{ config: { pwht: false } }]);
      expect(await stepSeqs(r.jobId)).toContain(2);
      const row = (await ledger(r.jobId)).find((x) => x.entityType === "ASSEMBLY_STEP" && x.entityId === w.asmSteps[1].id)!;
      expect(row).toMatchObject({ included: true, flagged: true });
      expect((row.reason as { invalid?: string }).invalid).toBeTruthy();
    });
  });

  describe("createJob: decisions", () => {
    it("no rules anywhere: every step, process and checkpoint as before, and no ledger rows", async () => {
      const w = await world("NORULES", { rules: false });
      const r = await w.make([{ config: { pwht: false } }]);
      expect(r.assemblyStepCount).toBe(5);
      expect(r.qcpItemCount).toBe(3);
      expect(r.ruleDecisionCount).toBe(0);
      expect(r.flaggedRuleCount).toBe(0);
      expect(await owner.jobProcess.count({ where: { jobId: r.jobId, included: true } })).toBe(3);
      expect((await owner.jobProcess.findMany({ where: { jobId: r.jobId } })).every((p) => p.inclusionReason === null)).toBe(true);
    });

    it("answer false: the optional process, step 2, step 3 and checkpoint A are dropped; step 4 still binds to checkpoint B", async () => {
      const w = await world("FALSE");
      const r = await w.make([{ config: { pwht: false } }]);
      expect(await stepSeqs(r.jobId)).toEqual([1, 4, 5]);
      expect(r.qcpItemCount).toBe(2); // B and C (C included, extra unanswered)
      const jp = await owner.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: "20" } });
      expect(jp.included).toBe(false);
      expect(jp.inclusionReason).toMatchObject({ byRule: true, lines: [{ line: 1, included: false, flagged: false }] });

      const steps = await owner.assemblyStep.findMany({ where: { jobId: r.jobId }, orderBy: { seq: "asc" }, include: { qcpItem: true } });
      const cloned = await owner.qcpItem.findMany({ where: { jobId: r.jobId }, orderBy: { sequence: "asc" } });
      expect(cloned.map((c) => c.sequence)).toEqual([2, 3]);
      expect(steps.find((s) => s.seq === 4)!.qcpItem!.sequence).toBe(2); // B, not the dropped A
      expect(steps.find((s) => s.seq === 5)!.qcpItem!.sequence).toBe(3);

      expect(r.ruleDecisionCount).toBe(6);
      expect(r.flaggedRuleCount).toBe(2); // the ignored mandatory rule, and checkpoint C resting on the unanswered "extra"
      const rows = await ledger(r.jobId);
      const byEntity = (t: string, id: number) => rows.find((x) => x.entityType === t && x.entityId === id)!;
      expect(byEntity("TEMPLATE_PROCESS", w.p20.id)).toMatchObject({ included: false, flagged: false });
      expect(byEntity("ASSEMBLY_STEP", w.asmSteps[1].id)).toMatchObject({ included: false, flagged: false });
      expect(byEntity("ASSEMBLY_STEP", w.asmSteps[2].id)).toMatchObject({ included: false, flagged: false });
      expect(byEntity("QCP_ITEM", w.qA.id)).toMatchObject({ included: false, flagged: false });
      expect(byEntity("QCP_ITEM", w.qC.id)).toMatchObject({ included: true, flagged: true });
      expect((byEntity("QCP_ITEM", w.qA.id).reason as { clauses: { answer: unknown }[] }).clauses[0].answer).toBe(false);
    });

    it("answer true: everything is materialised and steps 3 and 4 bind to checkpoints A and B", async () => {
      const w = await world("TRUE");
      const r = await w.make([{ config: { pwht: true } }]);
      expect(await stepSeqs(r.jobId)).toEqual([1, 2, 3, 4, 5]);
      expect(r.qcpItemCount).toBe(3);
      const steps = await owner.assemblyStep.findMany({ where: { jobId: r.jobId }, orderBy: { seq: "asc" }, include: { qcpItem: true } });
      expect(steps.filter((s) => s.qcpItem).map((s) => [s.seq, s.qcpItem!.sequence])).toEqual([[3, 1], [4, 2], [5, 3]]);
      expect((await owner.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: "20" } })).included).toBe(true);
    });

    it("no answer: included, and every rule that rested on it is flagged", async () => {
      const w = await world("MISSING");
      const r = await w.make([{ config: null }]);
      expect(await stepSeqs(r.jobId)).toEqual([1, 2, 3, 4, 5]);
      expect(r.ruleDecisionCount).toBe(6);
      expect(r.flaggedRuleCount).toBe(6);
      expect((await ledger(r.jobId)).every((x) => x.included && x.flagged)).toBe(true);
    });

    it("a question default counts as an answer, and says it was defaulted", async () => {
      const w = await world("DEFAULT", {
        questions: [{ key: "pwht", type: "BOOLEAN", def: false }, { key: "extra", type: "BOOLEAN" }],
      });
      const r = await w.make([{ config: null }]);
      expect(await stepSeqs(r.jobId)).toEqual([1, 4, 5]);
      const row = (await ledger(r.jobId)).find((x) => x.entityType === "ASSEMBLY_STEP" && x.entityId === w.asmSteps[1].id)!;
      expect(row).toMatchObject({ included: false, flagged: false });
      expect((row.reason as { defaultedKeys?: string[] }).defaultedKeys).toEqual(["pwht"]);
      // the stored line config holds only what was answered
      expect((await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } })).config).toBeNull();
    });

    it("a manual exclusion wins over the rule and keeps its own reason path", async () => {
      const w = await world("MANUAL");
      const r = await w.make([{ config: { pwht: true } }], { excludedProcessCodes: ["20"], exclusionReason: "client waived" });
      const jp = await owner.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: "20" } });
      expect(jp.included).toBe(false);
      expect(jp.inclusionReason).toBeNull();
    });

    it("two lines: the shared process stays when any line needs it; each line gets its own steps and its own ledger rows", async () => {
      const w = await world("TWOLINES");
      const r = await w.make([{ config: { pwht: false }, serials: ["L1-A"] }, { config: { pwht: true }, serials: ["L2-A"] }]);
      expect((await owner.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: "20" } })).included).toBe(true);
      const perUnit = await owner.assemblyStep.groupBy({ by: ["unitId"], where: { jobId: r.jobId }, _count: true });
      expect(perUnit.map((g) => g._count).sort()).toEqual([3, 5]);
      expect(r.qcpItemCount).toBe(3); // checkpoint A kept for the line that needs it
      const rows = await ledger(r.jobId);
      expect(rows.length).toBe(12);
      const lines = await owner.equipment.findMany({ where: { jobId: r.jobId }, orderBy: { id: "asc" } });
      const stepRow = (eqId: number) => rows.find((x) => x.equipmentId === eqId && x.entityType === "ASSEMBLY_STEP" && x.entityId === w.asmSteps[1].id)!;
      expect(stepRow(lines[0].id).included).toBe(false);
      expect(stepRow(lines[1].id).included).toBe(true);
      expect((await owner.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: "20" } })).inclusionReason).toMatchObject({
        byRule: true,
        lines: [{ line: 1, included: false }, { line: 2, included: true }],
      });
    });
  });

  describe("answers", () => {
    it("stores per line only the keys that have a question, coerced; a type-scoped question reaches only its type", async () => {
      const w = await world("ANSWERS");
      const r = await w.make([
        { typeId: w.eqType.id, config: { pwht: "yes", design_pressure: " 12.5 ", skirt_height: "2.5", bogus: "x", orientation: "Sideways" } },
        { typeId: null, config: { pwht: "no", skirt_height: "9" } },
      ]);
      const lines = await owner.equipment.findMany({ where: { jobId: r.jobId }, orderBy: { id: "asc" } });
      expect(lines[0].config).toEqual({ pwht: true, design_pressure: 12.5, skirt_height: 2.5 });
      expect(lines[1].config).toEqual({ pwht: false });
    });

    it("rejects the retired job-level specs field (strict schema)", async () => {
      const w = await world("NOSPECS", { rules: false });
      await expect(w.make([{ config: null }], { specs: { designPressure: 10 } })).rejects.toThrow();
    });

    it("admin: an equipment type's default specs are filtered through the family's questions", async () => {
      const w = await world("ADMINSPECS");
      const row = await createEquipmentType(w.actor, {
        familyId: w.family.id,
        code: uniq("EQ"),
        name: "Test type",
        defaultDesignCode: null,
        defaultSpecs: { design_pressure: "10", skirt_height: "3", bogus: 1 },
      } as never);
      // skirt_height belongs to a specific type, which a new type does not have yet
      expect(row.defaultSpecs).toEqual({ design_pressure: 10 });
    });
  });

  describe("component operations (route step rules)", () => {
    async function routeWorld(w: World) {
      const ct = await owner.componentTypeRef.create({ data: { tenantId: w.tenantId, code: uniq("CT"), name: "Plate" } });
      const op1 = await owner.operationRef.create({ data: { tenantId: w.tenantId, code: uniq("OP"), name: "Cut", defaultDepartmentId: w.dept.id } });
      const op2 = await owner.operationRef.create({ data: { tenantId: w.tenantId, code: uniq("OP"), name: "Anneal", defaultDepartmentId: w.dept.id } });
      const route = await owner.routeTemplate.create({ data: { tenantId: w.tenantId, componentTypeId: ct.id, familyId: w.family.id, name: "Plate route" } });
      const rv = await owner.routeTemplateVersion.create({ data: { routeId: route.id, version: 1, status: "PUBLISHED" } });
      const s1 = await owner.routeStep.create({ data: { routeVersionId: rv.id, seq: 10, operationId: op1.id } });
      const s2 = await owner.routeStep.create({ data: { routeVersionId: rv.id, seq: 20, operationId: op2.id, includeWhen: pwht as never } });
      return { ct, s1, s2 };
    }

    it("a dropped route step makes no operation on any unit and is recorded once per line, however often it is decided", async () => {
      const w = await world("ROUTE");
      const rw = await routeWorld(w);
      const r = await w.make([{ config: { pwht: false }, serials: ["R1", "R2"] }]);
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
      const bom = await owner.bomItem.create({
        data: { jobId: r.jobId, equipmentId: eq.id, itemNo: 1, partName: "Plate", sourceQty: "1 NOS.", qtyPer: 1, uom: "NOS.", componentTypeId: rw.ct.id },
      });
      const call = () =>
        withTenant(w.tenantId, (tx) => materializeComponentsFromBomItems(tx, w.family.id, eq.id, [bom.id], r.jobId));
      const first = await call();
      expect(first.componentCount).toBe(2);
      const ops = await owner.componentOperation.findMany({ where: { jobId: r.jobId } });
      expect(ops.map((o) => o.seq)).toEqual([10, 10]);
      const rows = (await ledger(r.jobId)).filter((x) => x.entityType === "ROUTE_STEP");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entityId: rw.s2.id, included: false, flagged: false });

      // deciding the same step again (a later BOM import for the same line) must not duplicate the row
      await withTenant(w.tenantId, async (tx) => {
        const again = await LineRules.load(tx, eq.id);
        again.decide("ROUTE_STEP", rw.s2.id, pwht);
        await flushRuleDecisions(tx, [again]);
      });
      expect((await ledger(r.jobId)).filter((x) => x.entityType === "ROUTE_STEP")).toHaveLength(1);
    });

    it("with the answer true the step becomes an operation", async () => {
      const w = await world("ROUTETRUE");
      const rw = await routeWorld(w);
      const r = await w.make([{ config: { pwht: true } }]);
      const eq = await owner.equipment.findFirstOrThrow({ where: { jobId: r.jobId } });
      const bom = await owner.bomItem.create({
        data: { jobId: r.jobId, equipmentId: eq.id, itemNo: 1, partName: "Plate", sourceQty: "1 NOS.", qtyPer: 1, uom: "NOS.", componentTypeId: rw.ct.id },
      });
      await withTenant(w.tenantId, (tx) => materializeComponentsFromBomItems(tx, w.family.id, eq.id, [bom.id], r.jobId));
      expect((await owner.componentOperation.findMany({ where: { jobId: r.jobId } })).map((o) => o.seq)).toEqual([10, 20]);
    });
  });
  describe("ensurePvConfigQuestions (the old SPEC_FIELDS as rows)", () => {
    it("dry run writes nothing; apply creates the PV questions (the seven spec fields and shell_courses) and renames legacy default-spec keys; a second apply changes nothing", async () => {
      const w = await world("SETUP", { questions: [] });
      await owner.equipmentTypeRef.update({
        where: { id: w.eqType.id },
        data: { defaultSpecs: { designPressure: 10.5, orientation: "Vertical", weird: 1 } },
      });
      const dry = await ensurePvConfigQuestions(owner, w.tenantId, { apply: false });
      expect(dry.created).toHaveLength(8);
      expect(dry.renamed).toHaveLength(1);
      expect(await owner.configQuestion.count({ where: { tenantId: w.tenantId } })).toBe(0);
      expect((await owner.equipmentTypeRef.findUniqueOrThrow({ where: { id: w.eqType.id } })).defaultSpecs).toHaveProperty("designPressure");

      await ensurePvConfigQuestions(owner, w.tenantId, { apply: true, audit: true, auditSource: "j2 test" });
      const keys = (await owner.configQuestion.findMany({ where: { tenantId: w.tenantId }, orderBy: { sortOrder: "asc" } })).map((q) => q.key);
      expect(keys).toEqual(["design_pressure", "design_temperature", "mdmt", "moc", "capacity", "orientation", "radiography", "shell_courses"]);
      expect((await owner.equipmentTypeRef.findUniqueOrThrow({ where: { id: w.eqType.id } })).defaultSpecs).toEqual({
        design_pressure: 10.5,
        orientation: "Vertical",
        weird: 1,
      });
      expect(await owner.auditLog.count({ where: { tenantId: w.tenantId, userAgent: "j2 test" } })).toBe(9); // 8 questions + 1 rename

      const again = await ensurePvConfigQuestions(owner, w.tenantId, { apply: true, audit: true, auditSource: "j2 test" });
      expect(again).toMatchObject({ created: [], renamed: [] });
    });
  });
});
