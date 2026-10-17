import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import type { WorkOrg } from "./work.test-util";

/**
 * Lean Core L2.10 part B, DB-gated: the bulk-tick at the switch-over date goes
 * through recordWork, so every rule still applies. Violation cases first.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe.skipIf(!RUN_DB)("L2.10 switch-over (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { makeWorkOrg } = await import("./work.test-util");
  const { loadSwitchOver } = await import("./switch-over.read");
  const { applySwitchOver, SWITCH_OVER_CHUNK } = await import("./switch-over.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  let head: Actor;
  let admin: Actor;
  let planner: Actor;
  let operator: Actor;
  let sup: Actor;
  let bHead: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "SWA");
    b = await makeWorkOrg(owner, "SWB");
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    admin = await o.user("admin", ["ADMIN"]);
    planner = await o.user("planner", ["PLANNER"]);
    operator = await o.user("operator", ["OPERATOR"], [o.fab.id]);
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    bHead = await b.user("bhead", ["PRODUCTION_HEAD"]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const when = (hoursAgo = 1) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
  const status = async (kind: "step" | "op" | "plan", id: number) =>
    kind === "step"
      ? owner.assemblyStep.findUniqueOrThrow({ where: { id }, select: { status: true, reportedFinishAt: true, submittedBy: true } })
      : kind === "op"
        ? owner.componentOperation.findUniqueOrThrow({ where: { id }, select: { status: true, reportedFinishAt: true, submittedBy: true } })
        : owner.processPlan.findUniqueOrThrow({ where: { id }, select: { status: true, reportedFinishAt: true, submittedBy: true } });

  const base = () =>
    o.job({
      units: 2,
      processes: [{ code: "1", grain: "JOB", requiresQc: false }],
      steps: [{ seq: 1, requiresQc: false }, { seq: 2, requiresQc: true }, { seq: 3, kind: "INSPECTION" }, { seq: 4, requiresQc: false }],
      components: [{ tag: "SH-1", ops: [{ code: "CUTTING", requiresQc: false }, { code: "ROLLING", requiresQc: false }] }],
    });

  it("lists every open item per unit in the order recordWork needs, without inspection steps", async () => {
    const j = await base();
    const v = await loadSwitchOver(head, j.job.id);
    expect(v.units.map((u) => u.label)).toEqual(["Job level", expect.any(String), expect.any(String)]);
    expect(v.units[0].rows.map((r) => r.kind)).toEqual(["PROCESS_PLAN"]);
    const unit = v.units[1];
    expect(unit.rows.map((r) => r.title)).toEqual(["SH-1 · CUTTING", "SH-1 · ROLLING", "step 1", "step 2", "step 4"]);
    expect(unit.rows.map((r) => r.order)).toEqual([0, 1, 2, 3, 4]);
    expect(v.open).toBe(1 + 5 * 2);
    // the second unit's same step has the same match key (for "tick on every unit")
    expect(v.units[2].rows.map((r) => r.matchKey)).toEqual(unit.rows.map((r) => r.matchKey));
  });

  it("ticks done at the switch-over date through recordWork: QC-free items COMPLETE, QC items go to QC", async () => {
    const j = await base();
    const doneAt = when(2);
    const r = await applySwitchOver(head, {
      jobId: j.job.id,
      doneAt,
      items: [
        { kind: "PROCESS_PLAN", id: j.plan("1") },
        { kind: "COMPONENT_OP", id: j.op("SH-1", "CUTTING", 0) },
        { kind: "COMPONENT_OP", id: j.op("SH-1", "ROLLING", 0) },
        { kind: "ASSEMBLY_STEP", id: j.step(1, 0) },
        { kind: "ASSEMBLY_STEP", id: j.step(2, 0) },
      ],
    });
    expect(r).toMatchObject({ completed: 4, toQc: 1, skipped: 0, refused: [] });
    const s1 = await status("step", j.step(1, 0));
    expect(s1.status).toBe("COMPLETE");
    expect(s1.reportedFinishAt?.toISOString()).toBe(doneAt);
    expect((await status("step", j.step(2, 0))).status).toBe("SUBMITTED"); // maker-checker: QC verifies
    expect((await status("step", j.step(2, 0))).submittedBy).toBe(head.userId);
    expect((await status("plan", j.plan("1"))).status).toBe("COMPLETE");
    // not ticked, not touched; the other unit is untouched
    expect((await status("step", j.step(4, 0))).status).toBe("NOT_STARTED");
    expect((await status("step", j.step(1, 1))).status).toBe("NOT_STARTED");
    expect(await owner.auditLog.count({ where: { tenantId: o.tenantId, action: "switchOver.apply", entityId: String(j.job.id) } })).toBe(1);
  });

  it("every rule still applies: a step out of order is refused with its reason, nothing is forced", async () => {
    const j = await base();
    const r = await applySwitchOver(head, {
      jobId: j.job.id,
      doneAt: when(),
      items: [{ kind: "ASSEMBLY_STEP", id: j.step(2, 0) }], // step 1 is still open
    });
    expect(r.completed + r.toQc).toBe(0);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]).toMatchObject({ code: "SEQUENCE_OVERRIDE_REQUIRED", title: "step 2" });
    expect((await status("step", j.step(2, 0))).status).toBe("NOT_STARTED");
  });

  it("a switch-over date outside the 72 working hours is refused item by item", async () => {
    const j = await base();
    const r = await applySwitchOver(head, {
      jobId: j.job.id,
      doneAt: when(30 * 24),
      items: [{ kind: "ASSEMBLY_STEP", id: j.step(1, 0) }, { kind: "COMPONENT_OP", id: j.op("SH-1", "CUTTING", 0) }],
    });
    expect(r.refused.map((x) => x.code)).toEqual(["REPORTED_AT_OUT_OF_WINDOW", "REPORTED_AT_OUT_OF_WINDOW"]);
    expect((await status("step", j.step(1, 0))).status).toBe("NOT_STARTED");
  });

  it("a late item needs a reason: refused without one, filed once with one", async () => {
    const j = await o.job({
      processes: [{ code: "2", grain: "JOB", requiresQc: false, plannedFinish: new Date(Date.now() - 10 * DAY) }],
      steps: [{ seq: 1, requiresQc: false, processSeq: 2 }],
    });
    const items = [{ kind: "ASSEMBLY_STEP" as const, id: j.step(1, 0) }];
    const no = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items });
    expect(no.refused[0].code).toBe("LATE_REASON_REQUIRED");
    const yes = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items, lateCategoryId: o.category.id });
    expect(yes.completed).toBe(1);
    expect(await owner.delayReason.count({ where: { jobId: j.job.id, categoryId: o.category.id } })).toBe(1);
  });

  it("skips what is already done, and ticking twice does nothing new", async () => {
    const j = await base();
    const items = [{ kind: "ASSEMBLY_STEP" as const, id: j.step(1, 0) }];
    const first = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items });
    const again = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items });
    expect(first.completed).toBe(1);
    expect(again).toMatchObject({ completed: 0, toQc: 0, skipped: 1, refused: [] });
  });

  it("splits a unit's items into chunks of at most the limit, in order", async () => {
    const n = SWITCH_OVER_CHUNK + 5;
    const j = await o.job({ steps: Array.from({ length: n }, (_, i) => ({ seq: i + 1, requiresQc: false })) });
    const v = await loadSwitchOver(head, j.job.id);
    const rows = v.units.find((u) => u.unitId !== null)!.rows;
    expect(rows).toHaveLength(n);
    const r = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items: rows.map((x) => ({ kind: x.kind, id: x.id })) });
    expect(r.chunks).toBe(2);
    expect(r.completed).toBe(n);
    expect(r.refused).toEqual([]);
  });

  const weldJob = () =>
    o.job({ units: 2, steps: [{ seq: 1, role: "WELD", jointRef: "LS-1", templateJointRef: "LS-1", requiresQc: false }] });

  it("a weld step needs its welder: refused without one, otherwise the joint is logged for that welder and the step recorded", async () => {
    const j = await weldJob();
    const welder = await owner.welder.create({ data: { tenantId: o.tenantId, name: "V. Yadav", employeeCode: o.uniq("W") } });
    const v = await loadSwitchOver(head, j.job.id);
    expect(v.welders.map((w) => w.id)).toContain(welder.id);
    expect(v.units[0].rows[0].weld).toEqual({ jointRef: "LS-1", existingJointId: null });
    const key = `ASSEMBLY_STEP:${j.step(1, 0)}`;
    const items = [{ kind: "ASSEMBLY_STEP" as const, id: j.step(1, 0) }];

    const no = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items });
    expect(no.refused[0]).toMatchObject({ code: "VALIDATION_FAILED", message: "Pick the welder who did joint LS-1." });
    expect((await status("step", j.step(1, 0))).status).toBe("NOT_STARTED");
    expect(await owner.weldJoint.count({ where: { jobId: j.job.id } })).toBe(0);

    const yes = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items, welders: { [key]: welder.id } });
    expect(yes).toMatchObject({ completed: 1, refused: [] });
    const step = await owner.assemblyStep.findUniqueOrThrow({ where: { id: j.step(1, 0) }, select: { status: true, weldJointId: true, performedByWelderId: true } });
    expect(step).toMatchObject({ status: "COMPLETE", performedByWelderId: welder.id });
    const joint = await owner.weldJoint.findUniqueOrThrow({ where: { id: step.weldJointId! }, include: { welders: true } });
    expect([joint.jointNo, joint.unitId, joint.welders.map((w) => w.welderId)]).toEqual(["LS-1", j.units[0].id, [welder.id]]);
    // the other unit's joint is its own
    expect((await status("step", j.step(1, 1))).status).toBe("NOT_STARTED");
  });

  it("a joint already logged on the unit needs no welder, and a welder from another tenant is refused", async () => {
    const j = await weldJob();
    const welder = await owner.welder.create({ data: { tenantId: o.tenantId, name: "A. Khan", employeeCode: o.uniq("W") } });
    const foreign = await owner.welder.create({ data: { tenantId: b.tenantId, name: "Z. Other", employeeCode: b.uniq("W") } });
    const key = `ASSEMBLY_STEP:${j.step(1, 0)}`;
    const items = [{ kind: "ASSEMBLY_STEP" as const, id: j.step(1, 0) }];
    const bad = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items, welders: { [key]: foreign.id } });
    expect(bad.completed).toBe(0);
    expect(bad.refused).toHaveLength(1);
    expect(await owner.weldJoint.count({ where: { jobId: j.job.id } })).toBe(0);

    const { ensureJointForStep } = await import("./floor.service");
    const made = await ensureJointForStep(head, { assemblyStepId: j.step(1, 0), welderIds: [welder.id] });
    const v = await loadSwitchOver(head, j.job.id);
    expect(v.units[0].rows[0].weld?.existingJointId).toBe(made.weldJointId);
    expect(v.units[1].rows[0].weld?.existingJointId).toBeNull(); // the other unit has its own joint
    const ok = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items });
    expect(ok).toMatchObject({ completed: 1, refused: [] });
  });

  it("pressure cutting refused for material, fixed with issue-and-pick, then recorded", async () => {
    const { issueAndPickHeat } = await import("./heat.service");
    const j = await o.job({ components: [{ tag: "SH-1", pressure: true, drawing: "RELEASED", ops: [{ code: "CUTTING", requiresQc: false }] }] });
    const item = await owner.bomItem.create({ data: { jobId: j.job.id, equipmentId: j.equipment.id, itemNo: 1, partName: "SHELL PLATE", sourceQty: "1", qtyPer: 2 } });
    await owner.component.update({ where: { id: j.components.get("SH-1:0")! }, data: { bomItemId: item.id } });
    const lot = await owner.stockLot.create({ data: { jobId: j.job.id, bomItemId: item.id, heatNumber: "H-2001", location: "Y1", qty: "10" } });
    const cut = [{ kind: "COMPONENT_OP" as const, id: j.op("SH-1", "CUTTING", 0) }];

    const first = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items: cut });
    expect(first.refused[0]).toMatchObject({ code: "MATERIAL_NOT_ISSUED", componentId: j.components.get("SH-1:0") });

    await issueAndPickHeat(head, { componentId: first.refused[0].componentId!, stockLotId: lot.id, qty: 2 });
    const second = await applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items: cut });
    expect(second).toMatchObject({ completed: 1, refused: [] });
    expect((await status("op", j.op("SH-1", "CUTTING", 0))).status).toBe("COMPLETE");
  });

  it("only the Production Head and Admin; never a client user; never another tenant's job", async () => {
    const j = await base();
    const items = [{ kind: "ASSEMBLY_STEP" as const, id: j.step(1, 0) }];
    for (const who of [planner, operator, sup]) {
      await expect(applySwitchOver(who, { jobId: j.job.id, doneAt: when(), items })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(loadSwitchOver(who, j.job.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(applySwitchOver({ ...head, clientId: o.tenantId }, { jobId: j.job.id, doneAt: when(), items })).rejects.toBeTruthy();
    await expect(applySwitchOver(bHead, { jobId: j.job.id, doneAt: when(), items })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(applySwitchOver(admin, { jobId: j.job.id, doneAt: when(), items })).resolves.toMatchObject({ completed: 1 });
  });

  it("refuses an item that is not in the job, a missing date and an empty selection", async () => {
    const j = await base();
    const other = await base();
    await expect(
      applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items: [{ kind: "ASSEMBLY_STEP", id: other.step(1, 0) }] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(applySwitchOver(head, { jobId: j.job.id, doneAt: "not a date", items: [{ kind: "ASSEMBLY_STEP", id: j.step(1, 0) }] })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(applySwitchOver(head, { jobId: j.job.id, doneAt: when(), items: [] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
