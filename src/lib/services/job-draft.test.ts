import { afterAll, describe, expect, it } from "vitest";

/**
 * Lean Core J7a: job drafts, copy a previous job, the rolled-back preview, per-line BOM and
 * weld-map copy. Violation cases first (CLAUDE.md). Gated behind RUN_DB_TESTS; every fixture
 * is its own disposable tenant (the owner client bypasses RLS to build it).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("Lean Core J7a job drafts (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { ROLES } = await import("@/lib/authz");
  const { createJob } = await import("./job-intake.service");
  const { previewJob } = await import("./job-preview.service");
  const { saveDraft, copyJobToDraft, releaseDraft, discardDraft, listDrafts, loadDraft } = await import("./job-draft.service");
  const { releaseJobBoms } = await import("./bom-release.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let n = 0;
  const uniq = (p: string) => `${p}-${stamp}-${++n}`;

  /** A tenant with a PV route (process 20 optional, 30 only with the pwht answer), a seam-driven assembly template, a library QCP and the config questions. */
  async function world(label: string) {
    const org = await owner.organization.create({ data: { code: `TEST-J7A-${label}-${stamp}-${++n}`, name: `j7a ${label}` } });
    const tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "FAB", name: "Fabrication" } });
    const mkUser = (name: string) =>
      owner.user.create({ data: { tenantId, email: `${uniq("u")}@test.local`, username: uniq("u"), passwordHash: "x", name, mustChangePassword: false } });
    const [admin, planner, planner2, head] = await Promise.all([mkUser("Admin"), mkUser("Planner"), mkUser("Planner2"), mkUser("Head")]);
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: uniq("ACME") } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const tpl = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: tpl.id, version: 1, status: "PUBLISHED" } });
    const proc = (seq: number, optional: boolean, includeWhen?: unknown) =>
      owner.templateProcess.create({
        data: {
          versionId: tv.id, seq, code: String(seq * 10), name: `Process ${seq * 10}`, defaultDepartmentId: dept.id, optional,
          includeWhen: includeWhen as never, durationMinDays: 5, durationMaxDays: 5,
          envelopeFinishByMinDays: seq * 5, envelopeFinishByMaxDays: seq * 5, envelopeStartByMinDays: seq * 5 - 5, envelopeStartByMaxDays: seq * 5 - 5,
        },
      });
    const [p1, p2, p3] = [await proc(1, false), await proc(2, true), await proc(3, true, { all: [{ key: "pwht", op: "eq", value: true }] })];
    await owner.templateEdge.createMany({
      data: [{ versionId: tv.id, processId: p2.id, predecessorId: p1.id, type: "FINISH_TO_START", lagDays: 0 }, { versionId: tv.id, processId: p3.id, predecessorId: p2.id, type: "FINISH_TO_START", lagDays: 0 }],
    });
    for (const [i, key, type] of [[0, "shell_courses", "NUMBER"], [1, "pwht", "BOOLEAN"]] as const) {
      await owner.configQuestion.create({ data: { tenantId, familyId: family.id, key, label: key, type, sortOrder: i } });
    }
    const asm = await owner.assemblyTemplate.create({ data: { tenantId, familyId: family.id, name: uniq("A") } });
    const av = await owner.assemblyTemplateVersion.create({ data: { templateId: asm.id, version: 1, status: "PUBLISHED", publishedAt: new Date() } });
    const steps = [
      { scope: "PER_UNIT", kind: "WORK", activity: "Prep", srNo: "1" },
      { scope: "PER_JOINT", jointType: "LONG_SEAM", kind: "WORK", activity: "Weld long seam", srNo: "2" },
      { scope: "PER_UNIT", kind: "INSPECTION", activity: "Final", srNo: "5" },
    ] as const;
    for (const [i, st] of steps.entries()) {
      await owner.assemblyTemplateStep.create({
        data: {
          versionId: av.id, seq: i + 1, groupCode: "A", groupName: "A", srNo: st.srNo, activity: st.activity, kind: st.kind,
          defaultDepartmentId: dept.id, qcpSrNo: st.kind === "INSPECTION" ? st.srNo : null, scope: st.scope,
          jointType: "jointType" in st ? st.jointType : null,
        },
      });
    }
    const qcp = await owner.qcpTemplate.create({ data: { tenantId, jobLabel: "LIB", vessel: "V" } });
    await owner.qcpItem.create({ data: { tenantId, qcpTemplateId: qcp.id, sequence: 1, srNo: "5", kind: "CHECKPOINT", activity: "qcp 5" } });

    const mk = (u: { id: number; email: string }, roles: string[], clientId: number | null = null) => ({
      userId: u.id, tenantId, clientId, name: "x", email: u.email, roles: roles as never, departmentIds: [],
      mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false,
    });
    const actors = {
      admin: mk(admin, [ROLES.ADMIN]),
      head: mk(head, [ROLES.PRODUCTION_HEAD]),
      planner: mk(planner, [ROLES.PLANNER]),
      planner2: mk(planner2, [ROLES.PLANNER]),
      supervisor: mk(planner, [ROLES.SUPERVISOR]),
      qc: mk(planner, [ROLES.QC]),
      client: mk(planner, [ROLES.CLIENT_VIEWER], client.id),
    };
    const line = (name: string, serials: string[], over: Record<string, unknown> = {}) => ({
      equipmentTypeId: null, name, blockNo: null, remarks: null, config: { shell_courses: 2, pwht: true }, serials, ...over,
    });
    const input = (over: Record<string, unknown> = {}) =>
      ({
        clientId: client.id, familyId: family.id, templateVersionId: tv.id, calendarId: null, jobNumber: uniq("J7A"),
        clientOrderNo: null, projectName: null, poRef: null, designCode: null,
        orderDate: new Date("2026-10-01"), committedDeliveryDate: new Date("2027-03-01"), targetDispatchDate: null,
        priority: "NORMAL", remarks: null, excludedProcessCodes: [], exclusionReason: null,
        equipments: [line("Vessel", ["S1", "S2"])], qcpTemplateSourceId: qcp.id, copyBomFromEquipmentId: null, ...over,
      }) as never;
    /** A two-line source job with its own BOM lines and an imported weld map per line. */
    const sourceJob = async () => {
      const r = await createJob(actors.admin, input({ equipments: [line("Shell", ["A1"]), line("Skirt", ["B1"], { config: { shell_courses: 1, pwht: false } })], excludedProcessCodes: ["20"], exclusionReason: "No client request" }));
      const eqs = await owner.equipment.findMany({ where: { jobId: r.jobId }, orderBy: { id: "asc" } });
      for (const [i, eq] of eqs.entries()) {
        const rev = await owner.bomRevision.create({ data: { equipmentId: eq.id, revisionNo: 1, status: "DRAFT", jobId: r.jobId } });
        for (let k = 1; k <= i + 2; k++) {
          await owner.bomItem.create({ data: { jobId: r.jobId, equipmentId: eq.id, bomRevisionId: rev.id, itemNo: k, partName: `L${i}-part-${k}`, sourceQty: "1 NOS.", qtyPer: 1, uom: "NOS." } });
        }
        await owner.plannedJoint.createMany({
          data: [
            { jobId: r.jobId, equipmentId: eq.id, jointNo: `NS-N${i + 1}`, jointType: "NOZZLE", source: "IMPORTED", confirmed: true, wpsRef: "WPS-1", sortOrder: 1 },
            { jobId: r.jobId, equipmentId: eq.id, jointNo: `SK-${i + 1}`, jointType: "ATTACHMENT", source: "IMPORTED", confirmed: true, sortOrder: 2 },
          ],
        });
      }
      return { ...r, eqs };
    };
    return { tenantId, family, client, tv, qcp, actors, input, line, sourceJob };
  }

  const tally = async (tenantId: number) => ({
    jobs: await owner.job.count({ where: { tenantId } }),
    units: await owner.unit.count({ where: { job: { tenantId } } }),
    equipments: await owner.equipment.count({ where: { job: { tenantId } } }),
    processes: await owner.jobProcess.count({ where: { job: { tenantId } } }),
    edges: await owner.jobProcessEdge.count({ where: { process: { job: { tenantId } } } }),
    qcp: await owner.qcpTemplate.count({ where: { tenantId } }),
    audit: await owner.auditLog.count({ where: { tenantId } }),
    events: await owner.domainEvent.count({ where: { tenantId } }),
    decisions: await owner.configRuleDecision.count({ where: { tenantId } }),
    revisions: await owner.bomRevision.count({ where: { tenantId } }),
    bom: await owner.bomItem.count({ where: { tenantId } }),
    joints: await owner.plannedJoint.count({ where: { tenantId } }),
    steps: await owner.assemblyStep.count({ where: { tenantId } }),
    components: await owner.component.count({ where: { tenantId } }),
    notifications: await owner.notification.count({ where: { tenantId } }),
    drafts: await owner.jobDraft.count({ where: { tenantId } }),
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  // ── violation cases first ─────────────────────────────────────────────────
  describe("roles", () => {
    it.each([
      ["SUPERVISOR", "supervisor"],
      ["QC", "qc"],
      ["a client user", "client"],
    ] as const)("refuses %s on every draft entry point and on the preview", async (_l, who) => {
      const w = await world("ROLE");
      const a = w.actors[who];
      await expect(saveDraft(a, { payload: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(copyJobToDraft(a, { jobId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(previewJob(a, w.input())).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listDrafts(a)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a planner saves drafts but cannot release one (release is createJob: Admin or Production Head)", async () => {
      const w = await world("PLANRELEASE");
      const d = await saveDraft(w.actors.planner, { payload: w.input() });
      await expect(releaseDraft(w.actors.planner, { draftId: d.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await loadDraft(w.actors.planner, d.id)).status).toBe("DRAFT");
    });
  });

  describe("payload", () => {
    it.each([
      ["an actual_* field", { actual_start: "2026-10-01" }],
      ["a created_at field", { createdAt: "2026-10-01" }],
      ["an array", [1]],
      ["a string", "x"],
    ])("refuses %s", async (_l, payload) => {
      const w = await world("PAYLOAD");
      await expect(saveDraft(w.actors.planner, { payload })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("refuses an unknown key on an equipment line and a non-list equipments", async () => {
      const w = await world("PAYLINE");
      await expect(saveDraft(w.actors.planner, { payload: { equipments: [{ name: "x", actualFinish: "2026-10-01" }] } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(saveDraft(w.actors.planner, { payload: { equipments: "x" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("accepts a half-made payload", async () => {
      const w = await world("HALF");
      const d = await saveDraft(w.actors.planner, { payload: { jobNumber: "HALF-1", equipments: [{ name: "Vessel" }] } });
      expect(d).toMatchObject({ status: "DRAFT", label: "HALF-1", releasedJobId: null });
    });
  });

  describe("ownership and tenants", () => {
    it("a planner cannot open, save over, discard or release another planner's draft; Admin and Production Head can see it", async () => {
      const w = await world("OWN");
      const d = await saveDraft(w.actors.planner, { payload: w.input() });
      for (const call of [
        () => loadDraft(w.actors.planner2, d.id),
        () => saveDraft(w.actors.planner2, { draftId: d.id, payload: {} }),
        () => discardDraft(w.actors.planner2, { draftId: d.id }),
        () => releaseDraft(w.actors.planner2, { draftId: d.id }),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/) });
      }
      expect(await listDrafts(w.actors.planner2)).toEqual([]);
      expect((await listDrafts(w.actors.head)).map((x) => x.id)).toEqual([d.id]);
      expect((await loadDraft(w.actors.admin, d.id)).id).toBe(d.id);
    });

    it("another tenant sees nothing: no load, no release, no copy of its job, no rows through RLS", async () => {
      const a = await world("TENA");
      const b = await world("TENB");
      const d = await saveDraft(a.actors.admin, { payload: a.input() });
      const src = await a.sourceJob();
      await expect(loadDraft(b.actors.admin, d.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(releaseDraft(b.actors.admin, { draftId: d.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(discardDraft(b.actors.admin, { draftId: d.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(copyJobToDraft(b.actors.admin, { jobId: src.jobId })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await withTenant(b.tenantId, (tx) => tx.jobDraft.count())).toBe(0);
      expect(await withTenant(a.tenantId, (tx) => tx.jobDraft.count())).toBe(1);
    });

    it("a release naming another tenant's BOM or weld-map source is refused and creates nothing", async () => {
      const a = await world("XSRC");
      const b = await world("XDST");
      const src = await a.sourceJob();
      const before = await tally(b.tenantId);
      await expect(createJob(b.actors.admin, b.input({ equipments: [b.line("V", ["S1"], { copyBomFromEquipmentId: src.eqs[0].id })] }))).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(createJob(b.actors.admin, b.input({ equipments: [b.line("V", ["S1"], { copyWeldMapFromEquipmentId: src.eqs[0].id })] }))).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await tally(b.tenantId)).toEqual(before);
    });
  });

  describe("no deletes", () => {
    it("the application role cannot DELETE or TRUNCATE a draft (discard is a status)", async () => {
      const w = await world("NODEL");
      const d = await saveDraft(w.actors.planner, { payload: {} });
      await expect(withTenant(w.tenantId, (tx) => tx.jobDraft.delete({ where: { id: d.id } }))).rejects.toThrow(/permission denied/i);
      expect(await owner.jobDraft.count({ where: { id: d.id } })).toBe(1);
    });
  });

  describe("release once", () => {
    it("releases to a job, then refuses a second release, a save and a discard; the draft names its job", async () => {
      const w = await world("ONCE");
      const d = await saveDraft(w.actors.planner, { payload: w.input() });
      const { job } = await releaseDraft(w.actors.head, { draftId: d.id });
      expect(job.unitCount).toBe(2);
      const after = await loadDraft(w.actors.head, d.id);
      expect(after).toMatchObject({ status: "RELEASED", releasedJobId: job.jobId });
      await expect(releaseDraft(w.actors.head, { draftId: d.id })).rejects.toMatchObject({ code: "DRAFT_ALREADY_RELEASED" });
      await expect(saveDraft(w.actors.planner, { draftId: d.id, payload: {} })).rejects.toMatchObject({ code: "DRAFT_ALREADY_RELEASED" });
      await expect(discardDraft(w.actors.planner, { draftId: d.id })).rejects.toMatchObject({ code: "DRAFT_ALREADY_RELEASED" });
      expect(await owner.job.count({ where: { tenantId: w.tenantId } })).toBe(1);
      expect(await listDrafts(w.actors.head)).toEqual([]);
    });

    it("two concurrent releases make exactly one job", async () => {
      const w = await world("RACE");
      const d = await saveDraft(w.actors.admin, { payload: w.input() });
      const results = await Promise.allSettled([releaseDraft(w.actors.admin, { draftId: d.id }), releaseDraft(w.actors.head, { draftId: d.id })]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: "DRAFT_ALREADY_RELEASED" });
      expect(await owner.job.count({ where: { tenantId: w.tenantId } })).toBe(1);
    });

    it("a discarded draft cannot be released or saved; discarding twice is harmless", async () => {
      const w = await world("DISC");
      const d = await saveDraft(w.actors.planner, { payload: w.input() });
      expect((await discardDraft(w.actors.planner, { draftId: d.id })).status).toBe("DISCARDED");
      await discardDraft(w.actors.planner, { draftId: d.id });
      await expect(releaseDraft(w.actors.admin, { draftId: d.id })).rejects.toMatchObject({ code: "DRAFT_DISCARDED" });
      await expect(saveDraft(w.actors.planner, { draftId: d.id, payload: {} })).rejects.toMatchObject({ code: "DRAFT_DISCARDED" });
      expect(await listDrafts(w.actors.admin)).toEqual([]);
      expect(await owner.jobDraft.count({ where: { id: d.id } })).toBe(1);
    });

    it("an incomplete draft fails the full parse at release and stays a draft; no delivery date is refused like the wizard", async () => {
      const w = await world("INCOMPLETE");
      const half = await saveDraft(w.actors.planner, { payload: { jobNumber: "X-1" } });
      await expect(releaseDraft(w.actors.admin, { draftId: half.id })).rejects.toThrow();
      expect((await loadDraft(w.actors.admin, half.id)).status).toBe("DRAFT");
      const noDate = await saveDraft(w.actors.planner, { payload: w.input({ committedDeliveryDate: null }) });
      await expect(releaseDraft(w.actors.admin, { draftId: noDate.id })).rejects.toMatchObject({ code: "DELIVERY_DATE_REQUIRED" });
      expect(await owner.job.count({ where: { tenantId: w.tenantId } })).toBe(0);
    });

    it("a duplicate job number at release rolls the whole thing back and leaves the draft open", async () => {
      const w = await world("DUPNO");
      await createJob(w.actors.admin, w.input({ jobNumber: "TAKEN-1" }));
      const d = await saveDraft(w.actors.planner, { payload: w.input({ jobNumber: "TAKEN-1" }) });
      await expect(releaseDraft(w.actors.admin, { draftId: d.id })).rejects.toMatchObject({ code: "DUPLICATE_JOB_NUMBER" });
      expect((await loadDraft(w.actors.admin, d.id)).status).toBe("DRAFT");
    });
  });

  // ── preview ───────────────────────────────────────────────────────────────
  describe("previewJob", () => {
    it("writes nothing, and its counts equal what createJob then makes", async () => {
      const w = await world("PREVIEW");
      const src = await w.sourceJob();
      const input = w.input({
        excludedProcessCodes: ["20"],
        exclusionReason: "client skips it",
        equipments: [w.line("Shell", ["N1", "N2"], { copyBomFromEquipmentId: src.eqs[0].id, copyWeldMapFromEquipmentId: src.eqs[0].id })],
      });
      const before = await tally(w.tenantId);
      const preview = await previewJob(w.actors.planner, input);
      expect(await tally(w.tenantId)).toEqual(before);

      const real = await createJob(w.actors.admin, input);
      expect(preview.result).toEqual({ ...real, jobId: expect.any(Number), publicId: expect.any(String) });
      expect(real.bomItemCount).toBe(2);
      expect(real.weldMapJointCount).toBe(2);
      // the floor rows a release would make, line by line, equal what releasing really makes
      const released = await releaseJobBoms(owner, w.actors.admin, real.jobId);
      const asked = preview.lines.map((l) => ("counts" in l.release ? l.release.counts : null));
      expect(asked.reduce((s, c) => s + (c?.steps ?? 0), 0)).toBe(released.steps);
      expect(asked[0]?.steps).toBeGreaterThan(0);
    });

    it("lists excluded processes with who excluded them, and the rule's decision with the answers behind it", async () => {
      const w = await world("EXCL");
      const p = await previewJob(w.actors.admin, w.input({ excludedProcessCodes: ["20"], exclusionReason: "x", equipments: [w.line("V", ["S1"], { config: { shell_courses: 2, pwht: false } })] }));
      const by = Object.fromEntries(p.processes.map((x) => [x.code, x]));
      expect(by["10"]).toMatchObject({ included: true, excludedBy: null });
      expect(by["20"]).toMatchObject({ included: false, excludedBy: "PLANNER" });
      expect(by["30"]).toMatchObject({ included: false, excludedBy: "RULE" });
      expect(by["30"].ruleLines[0]).toMatchObject({ line: 1, included: false });
      expect(p.ruleDecisions.length).toBeGreaterThan(0);
    });

    it("refuses what createJob refuses (duplicate number, unknown exclusion, mandatory process) and writes nothing", async () => {
      const w = await world("REFUSE");
      await createJob(w.actors.admin, w.input({ jobNumber: "TAKEN-2" }));
      const before = await tally(w.tenantId);
      await expect(previewJob(w.actors.admin, w.input({ jobNumber: "TAKEN-2" }))).rejects.toMatchObject({ code: "DUPLICATE_JOB_NUMBER" });
      await expect(previewJob(w.actors.admin, w.input({ excludedProcessCodes: ["10"], exclusionReason: "x" }))).rejects.toMatchObject({ code: "PROCESS_NOT_OPTIONAL" });
      await expect(previewJob(w.actors.admin, w.input({ excludedProcessCodes: ["99"], exclusionReason: "x" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await tally(w.tenantId)).toEqual(before);
    });

    it("reports the delivery window against the route's envelope, and a line whose release would be refused without throwing", async () => {
      const w = await world("FEAS");
      const ok = await previewJob(w.actors.admin, w.input());
      expect(ok.feasibility).toMatchObject({ feasibility: "FEASIBLE", terminalCode: "30" });
      const tight = await previewJob(w.actors.admin, w.input({ orderDate: new Date("2026-10-01"), committedDeliveryDate: new Date("2026-10-08") }));
      expect(tight.feasibility).toMatchObject({ feasibility: "INFEASIBLE" });
      const noDates = await previewJob(w.actors.admin, w.input({ orderDate: null, committedDeliveryDate: null }));
      expect(noDates.feasibility).toBeNull();
      // a shell_courses answer is missing: the job itself is refused, as createJob would
      await expect(previewJob(w.actors.admin, w.input({ equipments: [w.line("V", ["S1"], { config: {} })] }))).rejects.toBeTruthy();
    });
  });

  // ── copy a previous job ───────────────────────────────────────────────────
  describe("copyJobToDraft", () => {
    it("carries answers, QC plan, route, exclusions and per-line BOM and weld-map sources; serials and numbers stay blank", async () => {
      const w = await world("COPY");
      const src = await w.sourceJob();
      const d = await copyJobToDraft(w.actors.planner, { jobId: src.jobId });
      expect(d.sourceJobId).toBe(src.jobId);
      const p = d.payload as Record<string, any>;
      expect(p).toMatchObject({ clientId: w.client.id, familyId: w.family.id, templateVersionId: w.tv.id, excludedProcessCodes: ["20"], exclusionReason: "No client request" });
      expect(p.qcpTemplateSourceId).toBeTypeOf("number");
      expect(p).not.toHaveProperty("jobNumber");
      expect(p).not.toHaveProperty("committedDeliveryDate");
      expect(p.equipments).toHaveLength(2);
      expect(p.equipments[0]).toMatchObject({ name: "Shell", serials: [], config: { shell_courses: 2, pwht: true }, copyBomFromEquipmentId: src.eqs[0].id, copyWeldMapFromEquipmentId: src.eqs[0].id });
      expect(p.equipments[1]).toMatchObject({ name: "Skirt", config: { shell_courses: 1, pwht: false }, copyBomFromEquipmentId: src.eqs[1].id });
      // not yet a job: serials are blank, so it cannot be released as it is
      await expect(releaseDraft(w.actors.head, { draftId: d.id })).rejects.toThrow();
    });

    it("fill the blanks and release: each new line gets its OWN source line's BOM and weld map (unconfirmed), the QC plan and the answers", async () => {
      const w = await world("COPYREL");
      const src = await w.sourceJob();
      const d = await copyJobToDraft(w.actors.planner, { jobId: src.jobId });
      const p = d.payload as Record<string, any>;
      const filled = {
        ...p,
        jobNumber: uniq("NEW"),
        orderDate: "2026-10-01",
        committedDeliveryDate: "2027-03-01",
        equipments: [{ ...p.equipments[0], serials: ["C1", "C2"] }, { ...p.equipments[1], serials: ["D1"] }],
      };
      await saveDraft(w.actors.planner, { draftId: d.id, payload: filled });
      const { job } = await releaseDraft(w.actors.head, { draftId: d.id });
      expect(job).toMatchObject({ unitCount: 3, bomItemCount: 5, weldMapJointCount: 4 });
      const eqs = await owner.equipment.findMany({ where: { jobId: job.jobId }, orderBy: { id: "asc" } });
      for (const [i, eq] of eqs.entries()) {
        const items = await owner.bomItem.findMany({ where: { equipmentId: eq.id }, orderBy: { itemNo: "asc" } });
        expect(items.map((x) => x.partName)).toEqual(Array.from({ length: i + 2 }, (_, k) => `L${i}-part-${k + 1}`));
        const revs = await owner.bomRevision.findMany({ where: { equipmentId: eq.id } });
        expect(revs).toMatchObject([{ revisionNo: 1, status: "DRAFT", materializedAt: null }]);
        const joints = await owner.plannedJoint.findMany({ where: { equipmentId: eq.id }, orderBy: { sortOrder: "asc" } });
        expect(joints.map((j) => [j.jointNo, j.source, j.confirmed, j.wpsRef])).toEqual([[`NS-N${i + 1}`, "IMPORTED", false, "WPS-1"], [`SK-${i + 1}`, "IMPORTED", false, null]]);
        expect(eq.config).toEqual(i === 0 ? { shell_courses: 2, pwht: true } : { shell_courses: 1, pwht: false });
      }
      expect(await owner.qcpItem.count({ where: { qcpTemplate: { jobId: job.jobId } } })).toBeGreaterThan(0);
      // the source job is untouched
      expect(await owner.plannedJoint.count({ where: { jobId: src.jobId, confirmed: true } })).toBe(4);
      expect(await owner.bomItem.count({ where: { jobId: src.jobId } })).toBe(5);
      // excluded at the source, excluded again
      expect(await owner.jobProcess.count({ where: { jobId: job.jobId, code: "20", included: false } })).toBe(1);
    });

    it("a line with its own source copies it; the job-level source still feeds only the first line when that line names none", async () => {
      const w = await world("LEGACY");
      const src = await w.sourceJob();
      const r = await createJob(w.actors.admin, w.input({ copyBomFromEquipmentId: src.eqs[1].id, equipments: [w.line("A", ["A1"]), w.line("B", ["B1"], { copyBomFromEquipmentId: src.eqs[0].id })] }));
      const eqs = await owner.equipment.findMany({ where: { jobId: r.jobId }, orderBy: { id: "asc" } });
      expect(await owner.bomItem.count({ where: { equipmentId: eqs[0].id } })).toBe(3);
      expect(await owner.bomItem.count({ where: { equipmentId: eqs[1].id } })).toBe(2);
    });
  });

  describe("audit", () => {
    it("save, copy, release and discard each write an audit row in the same transaction", async () => {
      const w = await world("AUDIT");
      const src = await w.sourceJob();
      const a = await saveDraft(w.actors.planner, { payload: w.input() });
      await saveDraft(w.actors.planner, { draftId: a.id, payload: w.input() });
      const c = await copyJobToDraft(w.actors.planner, { jobId: src.jobId });
      await discardDraft(w.actors.planner, { draftId: c.id });
      await releaseDraft(w.actors.head, { draftId: a.id });
      const rows = await owner.auditLog.findMany({ where: { tenantId: w.tenantId, entityType: "JobDraft" }, orderBy: { id: "asc" } });
      expect(rows.map((r) => [r.action, r.entityId])).toEqual([
        ["jobDraft.save", String(a.id)], ["jobDraft.save", String(a.id)], ["jobDraft.copy", String(c.id)], ["jobDraft.discard", String(c.id)], ["jobDraft.release", String(a.id)],
      ]);
      expect(rows.every((r) => r.actorId != null)).toBe(true);
    });
  });
});
