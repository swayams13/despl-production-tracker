import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * Lean Core L2.2, DB-gated: the Floor screen's read model (floor.read.ts) and
 * its two writes (floor.service.ts). Scoping and refusals first, then the
 * states a row can be in, then the sibling / weld / late-reason helpers.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L2.2 floor read model + writes (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadFloorUnit } = await import("./floor.read");
  const { notifyBlocker, ensureJointForStep, jointTypeOf } = await import("./floor.service");
  const { recordWork, inspect } = await import("./work.service");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  type Org = Awaited<ReturnType<typeof makeWorkOrg>>;
  let o: Org;
  let b: Org;
  let sup: Actor;
  let msSup: Actor;
  let operator: Actor;
  let head: Actor;
  let qcUser: Actor;
  let bSup: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "FLR");
    b = await makeWorkOrg(owner, "FLB");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    msSup = await o.user("mssup", ["SUPERVISOR"], [o.other.id]);
    operator = await o.user("op", ["OPERATOR"], [o.fab.id]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    qcUser = await o.user("qc", ["QC"]);
    await o.user("stores", ["STORES"]);
    bSup = await b.user("bsup", ["SUPERVISOR"], [b.fab.id]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const S = "ASSEMBLY_STEP" as const;
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? e.code : `NON_APP_ERROR: ${String(e)}`;
    }
    return null;
  };
  const view = async (actor: Actor, publicId: string) => (await loadFloorUnit(actor, publicId))!;
  const byTitle = (v: Awaited<ReturnType<typeof view>>, title: string) => v.rows.find((r) => r.title === title)!;

  // ── scoping and refusals ──────────────────────────────────────────────
  describe("scoping", () => {
    it("shows a department's rows to that department, all of them to a Production Head, none to another department", async () => {
      const j = await o.job({ steps: [{ seq: 1 }, { seq: 2 }] });
      const pub = j.units[0].publicId;
      expect((await view(sup, pub)).rows.map((r) => r.title)).toEqual(["step 1", "step 2"]);
      expect((await view(head, pub)).rows).toHaveLength(2);
      const ms = await view(msSup, pub);
      expect(ms.rows).toEqual([]);
      expect(ms.departments).toEqual(["Machine shop"]);
    });

    it("another tenant's unit is not found, and an unknown id is not found", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      expect(await loadFloorUnit(bSup, j.units[0].publicId)).toBeNull();
      expect(await loadFloorUnit(sup, "no-such-public-id")).toBeNull();
    });

    it("a client user is refused", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      expect(await code(loadFloorUnit({ ...sup, clientId: 1 }, j.units[0].publicId))).toBe(ERROR_CODES.FORBIDDEN);
    });

    it("QC and Management read, they do not record", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      expect((await view(sup, j.units[0].publicId)).canRecord).toBe(true);
      expect((await view(operator, j.units[0].publicId)).canRecord).toBe(true);
      expect((await view(qcUser, j.units[0].publicId)).canRecord).toBe(false);
    });
  });

  // ── row states ────────────────────────────────────────────────────────
  describe("row states", () => {
    it("ready, joint-blocked (H1) and out-of-order (SOFT), with who can clear and what is missing", async () => {
      const j = await o.job({
        steps: [
          { seq: 1, role: "FIT_UP", jointRef: "J1", pressurePart: false },
          { seq: 2, role: "WELD", jointRef: "J1", pressurePart: false },
          { seq: 3, role: "WELD", jointRef: "J9", pressurePart: false },
        ],
      });
      const v = await view(sup, j.units[0].publicId);
      expect(byTitle(v, "step 1").state).toBe("READY");

      const weld = byTitle(v, "step 2");
      expect(weld.state).toBe("BLOCKED");
      expect(weld.refusal).toMatchObject({ code: "JOINT_SEQUENCE_BLOCKED", missing: ["step 1"] });
      expect(weld.refusal!.message.length).toBeGreaterThan(10);

      const early = byTitle(v, "step 3");
      expect(early.state).toBe("NEEDS_OVERRIDE");
      expect(early.canOverride).toBe(true);
      expect(byTitle(await view(operator, j.units[0].publicId), "step 3").canOverride).toBe(false);
      expect(byTitle(await view(operator, j.units[0].publicId), "step 3").refusal!.message).toMatch(/supervisor/i);
    });

    it("ordering: in progress first, then ready, then blocked; WITH_QC after a Done on a QC step; done rows are only counted", async () => {
      const j = await o.job({
        steps: [
          { seq: 1, requiresQc: true },
          { seq: 2, requiresQc: false },
          { seq: 3, role: "FIT_UP", jointRef: "J1" },
          { seq: 4, role: "WELD", jointRef: "J1" },
        ],
      });
      const pub = j.units[0].publicId;
      // step 1 -> SUBMITTED (QC required), step 2 -> COMPLETE (QC-free), step 3 started.
      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: S, id: j.step(1) }] });
      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: S, id: j.step(2) }] });
      await recordWork(sup, { jobId: j.job.id, action: "START", items: [{ kind: S, id: j.step(3) }] });
      const v = await view(sup, pub);
      expect(v.rows.map((r) => [r.title, r.state])).toEqual([
        ["step 3", "IN_PROGRESS"],
        ["step 4", "BLOCKED"],
        ["step 1", "WITH_QC"],
      ]);
      expect(v.doneCount).toBe(1);
      expect(byTitle(v, "step 3").startedAt).not.toBeNull();
    });

    it("an inspection step shows as waiting for QC, never as something to do", async () => {
      const j = await o.job({ steps: [{ seq: 1, kind: "INSPECTION" }] });
      const v = await view(sup, j.units[0].publicId);
      expect(v.rows).toMatchObject([{ title: "step 1", state: "QC_STEP" }]);
    });

    it("H2: pressure cutting with no material issue is blocked and names Stores", async () => {
      const j = await o.job({ components: [{ tag: "SHELL", pressure: true, ops: [{ code: "CUTTING" }] }] });
      const v = await view(sup, j.units[0].publicId);
      expect(v.rows[0]).toMatchObject({
        kind: "COMPONENT_OP",
        title: "CUTTING",
        group: "SHELL",
        state: "BLOCKED",
        refusal: { code: "MATERIAL_NOT_ISSUED", clearedBy: { role: "STORES", label: "Stores" } },
      });
    });
  });

  // ── a step QC sent back ───────────────────────────────────────────────
  describe("a step QC sent back", () => {
    const job = () => o.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }, { seq: 2, processSeq: 20 }] });
    const rowOf = async (j: Awaited<ReturnType<typeof job>>, id: number) => (await view(sup, j.units[0].publicId)).rows.find((r) => r.id === id)!;

    it("says it came back and why; the latest rejection's reason wins; a step never rejected, and one resubmitted, show nothing", async () => {
      const j = await job();
      await recordWork(sup, { jobId: j.job.id, action: "START", items: [{ kind: S, id: j.step(1) }] });
      expect((await rowOf(j, j.step(1))).returnedNote).toBeNull(); // in progress, never rejected

      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: S, id: j.step(1) }] });
      await inspect(qcUser, { kind: S, targetId: j.step(1), result: "REJECT", reason: "Weld toe undercut", categoryId: o.category.id });
      expect(await rowOf(j, j.step(1))).toMatchObject({ state: "IN_PROGRESS", returnedNote: "Weld toe undercut" });
      expect((await rowOf(j, j.step(2))).returnedNote).toBeNull(); // a sibling step is unaffected

      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: S, id: j.step(1) }] });
      await inspect(qcUser, { kind: S, targetId: j.step(1), result: "REJECT", reason: "Still undercut at the toe", categoryId: o.category.id });
      expect((await rowOf(j, j.step(1))).returnedNote).toBe("Still undercut at the toe");

      // Done again: it is waiting for QC, no longer a step to act on, so no stale note on it.
      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: S, id: j.step(1) }] });
      const resubmitted = (await view(sup, j.units[0].publicId)).rows.find((r) => r.id === j.step(1));
      expect(resubmitted?.returnedNote ?? null).toBeNull();
    });
  });

  // ── siblings, joints, late reasons ────────────────────────────────────
  describe("batch siblings", () => {
    it("lists the same step on the other units that are not done, and nothing for a weld step", async () => {
      const j = await o.job({
        units: 3,
        steps: [{ seq: 1 }, { seq: 2, templateJointRef: "CS-1", role: "WELD", jointRef: "CS-1" }],
      });
      await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: S, id: j.step(1, 2) }] }); // unit 3 submitted
      const v = await view(sup, j.units[0].publicId);
      const first = byTitle(v, "step 1");
      expect(first.siblings.map((s) => s.unitId)).toEqual([j.units[1].id]);
      expect(first.siblings[0].id).toBe(j.step(1, 1));
      expect(byTitle(v, "step 2").siblings).toEqual([]);
    });

    it("component operations match on the component tag and operation", async () => {
      const j = await o.job({ units: 2, components: [{ tag: "NOZZLE", ops: [{ code: "FIT_UP" }] }] });
      const v = await view(sup, j.units[0].publicId);
      expect(v.rows[0].siblings).toMatchObject([{ unitId: j.units[1].id, id: j.op("NOZZLE", "FIT_UP", 1) }]);
    });
  });

  describe("late reason", () => {
    it("is needed when the plan is past due and no reason is on file, and not once one is", async () => {
      const past = new Date(Date.now() - 5 * 86_400_000);
      const j = await o.job({
        processes: [{ code: "20", plannedFinish: past }],
        steps: [{ seq: 1, processSeq: 20 }],
      });
      expect(byTitle(await view(sup, j.units[0].publicId), "step 1").lateReasonNeeded).toBe(true);
      await owner.delayReason.create({
        data: { jobId: j.job.id, processPlanId: j.plan("20", 0), categoryId: o.category.id, filedBy: sup.userId },
      });
      expect(byTitle(await view(sup, j.units[0].publicId), "step 1").lateReasonNeeded).toBe(false);
    });
  });

  // ── ensureJointForStep ────────────────────────────────────────────────
  describe("ensureJointForStep", () => {
    const welder = (org: Org, n: string) =>
      owner.welder.create({ data: { tenantId: org.tenantId, name: `W ${n}`, employeeCode: org.uniq("EMP") } });

    it("names the joint for a weld step, which then unblocks recordWork's JOINT_REQUIRED", async () => {
      const j = await o.job({ steps: [{ seq: 1, role: "WELD", jointRef: "CS-2", templateJointRef: "CS-2" }] });
      const v = await view(sup, j.units[0].publicId);
      expect(byTitle(v, "step 1").weld).toEqual({ jointRef: "CS-2", existingJointId: null });

      const refused = await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: S, id: j.step(1) }] });
      expect(refused.refused).toMatchObject([{ code: ERROR_CODES.VALIDATION_FAILED }]);

      const w = await welder(o, "a");
      const r = await ensureJointForStep(sup, { assemblyStepId: j.step(1), welderIds: [w.id] });
      expect(r.created).toBe(true);
      const joint = await owner.weldJoint.findUniqueOrThrow({ where: { id: r.weldJointId } });
      expect(joint).toMatchObject({ jointNo: "CS-2", jointType: "Circumferential seam", unitId: j.units[0].id, loggedBy: sup.userId });
      expect(await owner.weldJointWelder.count({ where: { weldJointId: joint.id } })).toBe(1);

      const done = await recordWork(sup, {
        jobId: j.job.id,
        action: "DONE",
        items: [{ kind: S, id: j.step(1), detail: { weldJointId: r.weldJointId, performedByWelderId: w.id } }],
      });
      expect(done.refused).toEqual([]);
      expect(done.applied).toHaveLength(1);
      expect(byTitle(await view(sup, j.units[0].publicId), "step 1").state).toBe("WITH_QC");
    });

    it("a joint already logged on the unit is reused and needs no welder; the read model reports it", async () => {
      const j = await o.job({
        steps: [
          { seq: 1, role: "FIT_UP", jointRef: "LS-1", templateJointRef: "LS-1" },
          { seq: 2, role: "WELD", jointRef: "LS-1", templateJointRef: "LS-1" },
        ],
      });
      const w = await welder(o, "b");
      const first = await ensureJointForStep(sup, { assemblyStepId: j.step(1), welderIds: [w.id] });
      const second = await ensureJointForStep(sup, { assemblyStepId: j.step(2) });
      expect(second).toEqual({ weldJointId: first.weldJointId, created: false });
      expect(await owner.weldJoint.count({ where: { jobId: j.job.id } })).toBe(1);
      expect(byTitle(await view(sup, j.units[0].publicId), "step 2").weld).toEqual({ jointRef: "LS-1", existingJointId: first.weldJointId });
    });

    it.each<[string, (j: Awaited<ReturnType<Org["job"]>>) => Promise<unknown>, string]>([
      ["no welder for a new joint", (j) => ensureJointForStep(sup, { assemblyStepId: j.step(1) }), ERROR_CODES.VALIDATION_FAILED],
      ["a supervisor of another department", (j) => ensureJointForStep(msSup, { assemblyStepId: j.step(1), welderIds: [1] }), ERROR_CODES.FORBIDDEN],
      ["a client user", (j) => ensureJointForStep({ ...sup, clientId: 1 }, { assemblyStepId: j.step(1), welderIds: [1] }), ERROR_CODES.FORBIDDEN],
      ["another tenant (the step is invisible)", (j) => ensureJointForStep(bSup, { assemblyStepId: j.step(1), welderIds: [1] }), ERROR_CODES.NOT_FOUND],
      ["a step that names no joint", async () => {
        const plain = await o.job({ steps: [{ seq: 1 }] });
        return ensureJointForStep(sup, { assemblyStepId: plain.step(1), welderIds: [1] });
      }, ERROR_CODES.VALIDATION_FAILED],
    ])("refuses %s", async (_l, call, expected) => {
      const j = await o.job({ steps: [{ seq: 1, role: "WELD", jointRef: "CS-3", templateJointRef: "CS-3" }] });
      expect(await code(call(j))).toBe(expected);
      expect(await owner.weldJoint.count({ where: { jobId: j.job.id } })).toBe(0);
    });

    it("a welder from another tenant is not found", async () => {
      const j = await o.job({ steps: [{ seq: 1, role: "WELD", jointRef: "CS-4", templateJointRef: "CS-4" }] });
      const foreign = await welder(b, "x");
      expect(await code(ensureJointForStep(sup, { assemblyStepId: j.step(1), welderIds: [foreign.id] }))).toBe(ERROR_CODES.NOT_FOUND);
    });

    it("jointTypeOf reads the printed weld-map reference", () => {
      expect([jointTypeOf("LS-1"), jointTypeOf("cs-2"), jointTypeOf("N3"), jointTypeOf("X9")]).toEqual([
        "Long seam",
        "Circumferential seam",
        "Nozzle weld",
        "Weld joint",
      ]);
    });
  });

  // ── notifyBlocker ─────────────────────────────────────────────────────
  describe("notifyBlocker", () => {
    it("notifies the role's users, audits it, and refuses a repeat inside the cooldown", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      const input = { unitPublicId: j.units[0].publicId, kind: S, id: j.step(1), role: "QC" } as const;
      const r = await notifyBlocker(sup, input);
      expect(r.recipients).toBeGreaterThanOrEqual(1);
      const n = await owner.notification.findMany({ where: { type: "FLOOR_NUDGE", entityId: j.step(1) } });
      expect(n.map((x) => x.recipientId)).toContain(qcUser.userId);
      expect(n[0].title).toContain(j.units[0].serialNo);
      expect(await owner.auditLog.count({ where: { action: "floor.notifyBlocker", entityId: String(j.step(1)) } })).toBe(1);
      expect(await code(notifyBlocker(sup, input))).toBe(ERROR_CODES.NUDGE_COOLDOWN);
      expect(await owner.notification.count({ where: { type: "FLOOR_NUDGE", entityId: j.step(1) } })).toBe(n.length);
    });

    it.each<[string, (j: Awaited<ReturnType<Org["job"]>>) => Promise<unknown>, string]>([
      ["a role that cannot clear anything here", (j) => notifyBlocker(sup, { unitPublicId: j.units[0].publicId, kind: S, id: j.step(1), role: "SUPERVISOR" as never }), ERROR_CODES.VALIDATION_FAILED],
      ["an item that is not on that unit", async (j) => {
        const other = await o.job({ steps: [{ seq: 1 }] });
        return notifyBlocker(sup, { unitPublicId: j.units[0].publicId, kind: S, id: other.step(1), role: "QC" });
      }, ERROR_CODES.NOT_FOUND],
      ["another tenant's unit", (j) => notifyBlocker(bSup, { unitPublicId: j.units[0].publicId, kind: S, id: j.step(1), role: "QC" }), ERROR_CODES.NOT_FOUND],
      ["a client user", (j) => notifyBlocker({ ...sup, clientId: 1 }, { unitPublicId: j.units[0].publicId, kind: S, id: j.step(1), role: "QC" }), ERROR_CODES.FORBIDDEN],
    ])("refuses %s and writes nothing", async (_l, call, expected) => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      const before = await owner.notification.count({ where: { type: "FLOOR_NUDGE" } });
      expect(await code(call(j))).toBe(expected);
      expect(await owner.notification.count({ where: { type: "FLOOR_NUDGE" } })).toBe(before);
    });
  });
});
