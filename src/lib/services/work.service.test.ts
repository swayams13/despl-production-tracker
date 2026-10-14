import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError, SEQUENCE_OVERRIDE_OPERATOR_MESSAGE } from "@/lib/shared/errors";
import { istCalendarDayMarker } from "@/lib/shared/business-day";
import type { RecordWorkInput } from "@/lib/shared/schemas";
import type { JobSpec, WorkJob, WorkOrg } from "./work.test-util";

/**
 * Lean Core L1.2d, DB-gated: recordWork end to end. Violation cases first,
 * then each D2 HARD rule, SOFT with and without override, late Done,
 * requiresQc, partial batches, rollupProcessPlan, concurrency on two real
 * connections and requestId replay. The forced audit failure lives in
 * work.audit-rollback.test.ts (it mocks the audit module for the whole file).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe.skipIf(!RUN_DB)("L1.2d recordWork (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withJob } = await import("@/lib/db");
  const { recordWork } = await import("./work.service");
  const { rollupProcessPlan } = await import("./_shared");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  let sup: Actor;
  let sup2: Actor;
  let head: Actor;
  let operator: Actor;
  let planner: Actor;
  let bSup: Actor;
  let qc: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "A");
    b = await makeWorkOrg(owner, "B");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    sup2 = await o.user("sup2", ["SUPERVISOR"], [o.fab.id]);
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    operator = await o.user("operator", ["OPERATOR"], [o.fab.id]);
    planner = await o.user("planner", ["PLANNER"], [o.fab.id]);
    qc = await o.user("qc", ["QC"]);
    bSup = await b.user("bsup", ["SUPERVISOR"], [b.fab.id]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  type Kind = RecordWorkInput["items"][number]["kind"];
  const S = "ASSEMBLY_STEP" as const;
  const OP = "COMPONENT_OP" as const;
  const P = "PROCESS_PLAN" as const;
  const rec = (
    actor: Actor,
    j: WorkJob,
    action: "START" | "DONE",
    items: Array<[Kind, number]>,
    extra: Partial<RecordWorkInput> = {},
  ) => recordWork(actor, { jobId: j.job.id, action, items: items.map(([kind, id]) => ({ kind, id })), ...extra });
  type Result = Awaited<ReturnType<typeof recordWork>>;
  const refusal = (r: Result, id: number) => r.refused.find((x) => x.id === id);
  async function expectThrownCode(p: Promise<unknown>, code: string) {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code, String(thrown)).toBe(code);
  }
  const stepRow = (id: number) => owner.assemblyStep.findUniqueOrThrow({ where: { id } });
  const planRow = (id: number) => owner.processPlan.findUniqueOrThrow({ where: { id } });
  const audits = (entityType: string, id: number, action?: string) =>
    owner.auditLog.count({ where: { tenantId: o.tenantId, entityType, entityId: String(id), ...(action ? { action } : {}) } });
  const yesterday = () => new Date(istCalendarDayMarker().getTime() - DAY);

  // ── Refusals ────────────────────────────────────────────────────────────
  describe("refusals", () => {
    it("another tenant's job: the whole call is NOT_FOUND and nothing is written", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      await expectThrownCode(rec(bSup, j, "START", [[S, j.step(1)]]), ERROR_CODES.NOT_FOUND);
      expect((await stepRow(j.step(1))).status).toBe("NOT_STARTED");
    });

    it("another tenant's item id inside your own job's batch is refused NOT_FOUND; your item applies", async () => {
      const mine = await b.job({ steps: [{ seq: 1 }] });
      const theirs = await o.job({ steps: [{ seq: 1 }] });
      const r = await rec(bSup, mine, "START", [[S, mine.step(1)], [S, theirs.step(1)]]);
      expect(r.applied.map((a) => a.id)).toEqual([mine.step(1)]);
      expect(refusal(r, theirs.step(1))?.code).toBe(ERROR_CODES.NOT_FOUND);
      expect((await stepRow(theirs.step(1))).status).toBe("NOT_STARTED");
    });

    // Review fix (14 Oct): tenant/job RLS on process_plans already hid the row; lockItemRows now scopes by job too.
    it("another tenant's process plan id is refused NOT_FOUND and its row is never locked", async () => {
      const mine = await b.job({ steps: [{ seq: 1 }] });
      const theirs = await o.job({ processes: [{ code: "22" }] });
      const foreign = theirs.plan("22", 0);
      const requestId = crypto.randomUUID();
      let pending!: Promise<Result>;
      let lockError: string | null = "not checked";
      // An uncommitted work request with the same id: recordWork's final insert waits on it
      // while holding every row lock it took, so a second connection can probe them.
      await owner
        .$transaction(
          async (t) => {
            await t.workRequest.create({ data: { jobId: mine.job.id, requestId, actorId: bSup.userId, response: {} } });
            pending = rec(bSup, mine, "START", [[S, mine.step(1)], [P, foreign]], { requestId });
            pending.catch(() => {});
            for (let i = 0; i < 100; i++) {
              const [w] = await owner.$queryRaw<{ n: bigint }[]>`
                SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%work_requests%'`;
              if (w.n > 0n) break;
              await new Promise((r) => setTimeout(r, 100));
            }
            lockError = await owner.$queryRaw`SELECT id FROM process_plans WHERE id = ${foreign} FOR UPDATE NOWAIT`.then(
              () => null,
              (e: unknown) => String(e),
            );
            throw new Error("rollback");
          },
          { timeout: 20_000 },
        )
        .catch((e: Error) => {
          if (e.message !== "rollback") throw e;
        });
      expect(lockError).toBeNull();
      const r = await pending;
      expect(refusal(r, foreign)?.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(r.applied.map((a) => a.id)).toEqual([mine.step(1)]);
    });

    it("a client user is refused FORBIDDEN before anything runs", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      await expectThrownCode(rec({ ...head, clientId: 1 }, j, "START", [[S, j.step(1)]]), ERROR_CODES.FORBIDDEN);
    });

    // Review fix (14 Oct): floor writes are an allowlist, not "anyone not a client".
    it.each(["MANAGEMENT", "STORES", "ENGINEERING", "QC", "CLIENT_VIEWER"])(
      "a %s user (in the item's department) is refused FORBIDDEN; nothing is written",
      async (role) => {
        const j = await o.job({ steps: [{ seq: 1, requiresQc: false }] });
        const who = await o.user(role.toLowerCase(), [role], [o.fab.id]);
        for (const action of ["START", "DONE"] as const) {
          await expectThrownCode(rec(who, j, action, [[S, j.step(1)]]), ERROR_CODES.FORBIDDEN);
        }
        expect((await stepRow(j.step(1))).status).toBe("NOT_STARTED");
        expect(await audits("AssemblyStep", j.step(1))).toBe(0);
      },
    );

    it("a planner is refused FORBIDDEN on anything but processes 1–11; the office plan applies", async () => {
      const j = await o.job({
        processes: [{ code: "3", grain: "JOB", requiresQc: false }, { code: "22" }],
        steps: [{ seq: 1 }],
        components: [{ tag: "BRKT", ops: [{ code: "ROLLING" }] }],
      });
      const r = await rec(planner, j, "START", [[P, j.plan("3")], [P, j.plan("22", 0)], [S, j.step(1)], [OP, j.op("BRKT", "ROLLING")]]);
      expect(r.applied.map((a) => a.id)).toEqual([j.plan("3")]);
      expect(r.refused.map((x) => x.code)).toEqual([ERROR_CODES.FORBIDDEN, ERROR_CODES.FORBIDDEN, ERROR_CODES.FORBIDDEN]);
      expect((await stepRow(j.step(1))).status).toBe("NOT_STARTED");
    });

    it("a supervisor outside the item's department is refused FORBIDDEN per item", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      const outsider = await o.user("outsider", ["SUPERVISOR"], [o.other.id]);
      const r = await rec(outsider, j, "START", [[S, j.step(1)]]);
      expect(refusal(r, j.step(1))?.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it("an item of another job of the same tenant is refused NOT_FOUND; the rest of the batch applies", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      const k = await o.job({ steps: [{ seq: 1 }] });
      const r = await rec(sup, j, "START", [[S, j.step(1)], [S, k.step(1)]]);
      expect(r.applied.map((a) => a.id)).toEqual([j.step(1)]);
      expect(refusal(r, k.step(1))?.code).toBe(ERROR_CODES.NOT_FOUND);
      expect((await stepRow(k.step(1))).status).toBe("NOT_STARTED");
    });

    it.each<[string, (j: WorkJob) => Partial<RecordWorkInput>]>([
      ["101 items", () => ({ items: Array.from({ length: 101 }, (_, i) => ({ kind: S, id: i + 1 })) })],
      ["no items", () => ({ items: [] })],
      ["the same item twice", (j) => ({ items: [{ kind: S, id: j.step(1) }, { kind: S, id: j.step(1) }] })],
      ["an OTHER override without a note", () => ({ override: { category: "OTHER" } })],
      ["a client-sent actual time", () => ({ actualStart: new Date().toISOString() } as never)],
    ])("%s is refused by the schema and nothing is written", async (_l, patch) => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      await expect(
        recordWork(sup, { jobId: j.job.id, action: "START", items: [{ kind: S, id: j.step(1) }], ...patch(j) }),
      ).rejects.toThrow();
      expect((await stepRow(j.step(1))).status).toBe("NOT_STARTED");
    });

    it("an INSPECTION step is refused INSPECT_REQUIRED (QC records it through inspect)", async () => {
      const j = await o.job({ steps: [{ seq: 1, kind: "INSPECTION" }] });
      const r = await rec(head, j, "DONE", [[S, j.step(1)]]);
      expect(refusal(r, j.step(1))?.code).toBe(ERROR_CODES.INSPECT_REQUIRED);
    });

    it("a derived process plan is refused DERIVED_STATUS; an unmapped plan is not", async () => {
      const j = await o.job({ processes: [{ code: "20" }, { code: "22" }], steps: [{ seq: 1, processSeq: 20 }] });
      const r = await rec(sup, j, "START", [[P, j.plan("20", 0)], [P, j.plan("22", 0)]]);
      expect(refusal(r, j.plan("20", 0))?.code).toBe(ERROR_CODES.DERIVED_STATUS);
      expect(r.applied.map((a) => a.id)).toEqual([j.plan("22", 0)]);
    });

    it("a superseded schedule run's plan is refused STALE_WRITE", async () => {
      const j = await o.job({ processes: [{ code: "22" }] });
      await owner.scheduleRun.update({ where: { id: j.run.id }, data: { isCurrent: false } });
      const r = await rec(sup, j, "START", [[P, j.plan("22", 0)]]);
      expect(refusal(r, j.plan("22", 0))?.code).toBe(ERROR_CODES.STALE_WRITE);
    });

    it("a second START is refused INVALID_STATE_TRANSITION naming the current status and who started it", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      await rec(sup, j, "START", [[S, j.step(1)]]);
      const r = await rec(sup2, j, "START", [[S, j.step(1)]]);
      expect(refusal(r, j.step(1))).toMatchObject({
        code: ERROR_CODES.INVALID_STATE_TRANSITION,
        meta: { currentStatus: "IN_PROGRESS", startedBy: sup.userId },
      });
    });

    it("DONE on a SUBMITTED item is refused INVALID_STATE_TRANSITION", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      await rec(sup, j, "DONE", [[S, j.step(1)]]);
      const r = await rec(sup, j, "DONE", [[S, j.step(1)]]);
      expect(refusal(r, j.step(1))?.meta).toMatchObject({ currentStatus: "SUBMITTED" });
    });

    describe("reportedAt window (D4)", () => {
      it.each<[string, JobSpec, number, "FUTURE" | "BEFORE_RELEASE" | "TOO_OLD"]>([
        ["one minute in the future", {}, +60_000, "FUTURE"],
        ["a day before the BOM release date", { releasedAt: new Date() }, -26 * HOUR, "BEFORE_RELEASE"],
        ["a day before the order date when nothing is released", { orderDate: istCalendarDayMarker() }, -26 * HOUR, "BEFORE_RELEASE"],
        ["ten days back (beyond 72 working hours)", {}, -10 * DAY, "TOO_OLD"],
      ])("%s is refused with reason %s", async (_l, spec, offset, reason) => {
        const j = await o.job({ ...spec, steps: [{ seq: 1 }] });
        const r = await rec(sup, j, "START", [[S, j.step(1)]], { reportedAt: new Date(Date.now() + offset).toISOString() });
        expect(refusal(r, j.step(1))).toMatchObject({ code: ERROR_CODES.REPORTED_AT_OUT_OF_WINDOW, meta: { reason } });
        expect((await stepRow(j.step(1))).status).toBe("NOT_STARTED");
      });

      it("DONE reported before the reported start is refused DONE_BEFORE_START", async () => {
        const j = await o.job({ steps: [{ seq: 1 }] });
        await rec(sup, j, "START", [[S, j.step(1)]], { reportedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
        const r = await rec(sup, j, "DONE", [[S, j.step(1)]], { reportedAt: new Date(Date.now() - 3 * HOUR).toISOString() });
        expect(refusal(r, j.step(1))?.meta).toMatchObject({ reason: "DONE_BEFORE_START" });
      });

      it("an in-window reportedAt is stored beside the server times", async () => {
        const j = await o.job({ steps: [{ seq: 1, requiresQc: false }] });
        const at = new Date(Date.now() - 2 * HOUR);
        await rec(sup, j, "DONE", [[S, j.step(1)]], { reportedAt: at.toISOString() });
        const s = await stepRow(j.step(1));
        expect([s.reportedStartAt?.getTime(), s.reportedFinishAt?.getTime()]).toEqual([at.getTime(), at.getTime()]);
        expect(s.startedAt!.getTime()).toBeGreaterThan(at.getTime());
      });
    });
  });

  // ── D2 HARD rules, end to end ─────────────────────────────────────────────
  describe("HARD rules (no override, even for the Production Head)", () => {
    interface Case {
      spec: JobSpec;
      setup?: (j: WorkJob) => Promise<unknown>;
      item: (j: WorkJob) => [Kind, number];
      code: string | null;
    }
    const setStep = (j: WorkJob, seq: number, status: "IN_PROGRESS" | "SUBMITTED" | "COMPLETE") =>
      owner.assemblyStep.update({ where: { id: j.step(seq) }, data: { status } });
    const fitWeld = [
      { seq: 1, role: "FIT_UP" as const, jointRef: "J1", pressurePart: true },
      { seq: 2, role: "WELD" as const, jointRef: "J1", pressurePart: true },
    ];
    const pressureCut = (extra: object) => ({ components: [{ tag: "SHELL", pressure: true, ops: [{ code: "CUTTING" }], ...extra }] });

    it.each<[string, Case]>([
      ["H1: weld before its joint's fit-up is done", { spec: { steps: fitWeld }, item: (j) => [S, j.step(2)], code: ERROR_CODES.JOINT_SEQUENCE_BLOCKED }],
      ["H1 passes once fit-up is submitted", { spec: { steps: fitWeld }, setup: (j) => setStep(j, 1, "SUBMITTED"), item: (j) => [S, j.step(2)], code: null }],
      [
        "HOLD_LINK: an open blocking H point on the fit-up blocks the weld",
        { spec: { steps: [{ ...fitWeld[0], hold: true }, fitWeld[1]] }, setup: (j) => setStep(j, 1, "SUBMITTED"), item: (j) => [S, j.step(2)], code: ERROR_CODES.HOLD_POINT_OPEN },
      ],
      [
        "HOLD_LINK passes once QC accepts the H point",
        {
          spec: { steps: [{ ...fitWeld[0], hold: true }, fitWeld[1]] },
          setup: async (j) => {
            await setStep(j, 1, "SUBMITTED");
            await owner.qcpExecution.create({ data: { qcpItemId: j.stepQcp.get(j.step(1))!, unitId: j.units[0].id, result: "ACCEPTED", jobId: j.job.id } });
          },
          item: (j) => [S, j.step(2)],
          code: null,
        },
      ],
      ["H2: pressure-part cutting before material issue", { spec: pressureCut({}), item: (j) => [OP, j.op("SHELL", "CUTTING")], code: ERROR_CODES.MATERIAL_NOT_ISSUED }],
      ["H2: issued without a heat number", { spec: pressureCut({ issued: true }), item: (j) => [OP, j.op("SHELL", "CUTTING")], code: ERROR_CODES.HEAT_NUMBER_NOT_PICKED }],
      [
        "H2/H3 do not apply to a non-pressure part",
        { spec: { components: [{ tag: "SKIRT", ops: [{ code: "CUTTING" }], drawing: "DRAFT" }] }, item: (j) => [OP, j.op("SKIRT", "CUTTING")], code: null },
      ],
      [
        "H3: pressure-part cutting on an unreleased drawing",
        { spec: pressureCut({ issued: true, heatNumber: "H1", drawing: "DRAFT" }), item: (j) => [OP, j.op("SHELL", "CUTTING")], code: ERROR_CODES.DRAWING_NOT_RELEASED },
      ],
      [
        "H3 passes on a released drawing",
        { spec: pressureCut({ issued: true, heatNumber: "H1", drawing: "RELEASED" }), item: (j) => [OP, j.op("SHELL", "CUTTING")], code: null },
      ],
      [
        "H3 is a no-op without a drawing link (a data gap, not a refusal)",
        { spec: pressureCut({ issued: true, heatNumber: "H1" }), item: (j) => [OP, j.op("SHELL", "CUTTING")], code: null },
      ],
      [
        "H4: hydro before final PWHT is complete",
        { spec: { steps: [{ seq: 1, kind: "INSPECTION", role: "FINAL_PWHT" }, { seq: 2, role: "HYDRO" }] }, item: (j) => [S, j.step(2)], code: ERROR_CODES.PWHT_NOT_COMPLETE },
      ],
      [
        "H4 does not apply when the PWHT process is excluded",
        {
          spec: { processes: [{ code: "21", included: false }], steps: [{ seq: 1, kind: "INSPECTION", role: "FINAL_PWHT" }, { seq: 2, role: "HYDRO" }] },
          item: (j) => [S, j.step(2)],
          code: null,
        },
      ],
      [
        "H5: pressure welding after final PWHT has started",
        {
          spec: { steps: [{ seq: 1, kind: "INSPECTION", role: "FINAL_PWHT" }, { seq: 2, role: "WELD", jointRef: "J9", pressurePart: true }] },
          setup: (j) => setStep(j, 1, "IN_PROGRESS"),
          item: (j) => [S, j.step(2)],
          code: ERROR_CODES.WELD_AFTER_PWHT,
        },
      ],
      [
        "H5 allows non-pressure welding after PWHT",
        {
          spec: { steps: [{ seq: 1, kind: "INSPECTION", role: "FINAL_PWHT" }, { seq: 2, role: "WELD" }] },
          setup: (j) => setStep(j, 1, "IN_PROGRESS"),
          item: (j) => [S, j.step(2)],
          code: null,
        },
      ],
      [
        "H6: hydro before every pressure weld is complete",
        { spec: { steps: [{ seq: 1, role: "WELD", pressurePart: true }, { seq: 2, role: "HYDRO" }] }, setup: (j) => setStep(j, 1, "SUBMITTED"), item: (j) => [S, j.step(2)], code: ERROR_CODES.HYDRO_PREREQUISITES_INCOMPLETE },
      ],
      [
        "H6: pressure welding after hydro has started",
        { spec: { steps: [{ seq: 1, role: "HYDRO" }, { seq: 2, role: "WELD", pressurePart: true }] }, setup: (j) => setStep(j, 1, "IN_PROGRESS"), item: (j) => [S, j.step(2)], code: ERROR_CODES.WELD_AFTER_HYDRO },
      ],
      ["painting (30) before hydro (27) is complete", { spec: { processes: [{ code: "27" }, { code: "30" }] }, item: (j) => [P, j.plan("30", 0)], code: ERROR_CODES.PAINT_BEFORE_HYDRO }],
      [
        "painting passes once hydro is complete",
        {
          spec: { processes: [{ code: "27" }, { code: "30" }] },
          setup: (j) => owner.processPlan.update({ where: { id: j.plan("27", 0) }, data: { status: "COMPLETE", actualFinish: new Date() } }),
          item: (j) => [P, j.plan("30", 0)],
          code: null,
        },
      ],
    ])("%s", async (_l, c) => {
      const j = await o.job(c.spec);
      await c.setup?.(j);
      const [kind, id] = c.item(j);
      const r = await rec(head, j, "START", [[kind, id]], { override: { category: "CLIENT_PRIORITY" } });
      if (c.code) {
        expect(refusal(r, id)?.code, JSON.stringify(r)).toBe(c.code);
        expect(r.applied).toEqual([]);
      } else {
        expect(r.applied, JSON.stringify(r.refused)).toMatchObject([{ id, to: "IN_PROGRESS" }]);
      }
    });

    it("H5/H6 refusals say they route to an NCR", async () => {
      const j = await o.job({ steps: [{ seq: 1, role: "HYDRO" }, { seq: 2, role: "WELD", pressurePart: true }] });
      await owner.assemblyStep.update({ where: { id: j.step(1) }, data: { status: "IN_PROGRESS" } });
      const r = await rec(head, j, "START", [[S, j.step(2)]]);
      expect(refusal(r, j.step(2))?.meta).toMatchObject({ rule: "H6", routeTo: "NCR" });
    });

    it("H3 stamps the revision the part was cut to", async () => {
      const j = await o.job(pressureCut({ issued: true, heatNumber: "H1", drawing: "RELEASED" }));
      await rec(sup, j, "START", [[OP, j.op("SHELL", "CUTTING")]]);
      const c = await owner.component.findUniqueOrThrow({ where: { id: j.components.get("SHELL:0")! } });
      expect(c.builtToRevisionId).toBe(j.revisions.get("SHELL:0"));
      // Invariant 5: the component stamp is in the audit row, as the legacy start records it.
      const audit = await owner.auditLog.findFirstOrThrow({
        where: { tenantId: o.tenantId, action: "work.start", entityId: String(j.op("SHELL", "CUTTING")) },
      });
      expect(audit.after).toMatchObject({ builtToRevisionId: j.revisions.get("SHELL:0") });
    });
  });

  // ── D2 SOFT ──────────────────────────────────────────────────────────────
  describe("SOFT order (override reason from a Supervisor or above)", () => {
    const two = { steps: [{ seq: 1 }, { seq: 2 }] };

    it("an earlier open WORK step needs an override; the supervisor is told they can give one", async () => {
      const j = await o.job(two);
      const r = await rec(sup, j, "START", [[S, j.step(2)]]);
      expect(refusal(r, j.step(2))).toMatchObject({ code: ERROR_CODES.SEQUENCE_OVERRIDE_REQUIRED, meta: { canOverride: true } });
      expect(await owner.sequenceOverride.count({ where: { targetId: j.step(2), targetKind: S } })).toBe(0);
    });

    it("an operator is refused even with an override, and told to ask their supervisor", async () => {
      const j = await o.job(two);
      const r = await rec(operator, j, "START", [[S, j.step(2)]], { override: { category: "CREW_OR_MACHINE_FREE" } });
      expect(refusal(r, j.step(2))).toMatchObject({
        code: ERROR_CODES.SEQUENCE_OVERRIDE_REQUIRED,
        meta: { canOverride: false },
        message: SEQUENCE_OVERRIDE_OPERATOR_MESSAGE,
      });
    });

    it("with an override: applied, one SequenceOverride row naming the skipped step, in the audit row too", async () => {
      const j = await o.job(two);
      const r = await rec(sup, j, "START", [[S, j.step(2)]], { override: { category: "OTHER", note: "crane free now" } });
      expect(r.applied).toMatchObject([{ id: j.step(2), overridden: true }]);
      const rows = await owner.sequenceOverride.findMany({ where: { targetKind: S, targetId: j.step(2) } });
      expect(rows).toMatchObject([
        { category: "OTHER", note: "crane free now", predecessorTargetId: j.step(1), unitId: j.units[0].id, createdBy: sup.userId, edgeId: null },
      ]);
      const audit = await owner.auditLog.findFirstOrThrow({ where: { tenantId: o.tenantId, action: "work.start", entityId: String(j.step(2)) } });
      expect(audit.after).toMatchObject({ sequenceOverride: { category: "OTHER", predecessorTargetId: j.step(1) } });
    });

    it("one batch across units takes one reason and writes one row per item", async () => {
      const j = await o.job({ ...two, units: 3 });
      const r = await rec(sup, j, "START", [0, 1, 2].map((u) => [S, j.step(2, u)] as [Kind, number]), {
        override: { category: "MATERIAL_READY_EARLY" },
      });
      expect(r.applied).toHaveLength(3);
      const rows = await owner.sequenceOverride.findMany({ where: { jobId: j.job.id }, orderBy: { targetId: "asc" } });
      expect(rows.map((x) => [x.targetId, x.predecessorTargetId, x.category])).toEqual(
        [0, 1, 2].map((u) => [j.step(2, u), j.step(1, u), "MATERIAL_READY_EARLY"]),
      );
    });

    it("an earlier INSPECTION step does not count", async () => {
      const j = await o.job({ steps: [{ seq: 1, kind: "INSPECTION" }, { seq: 2 }] });
      const r = await rec(sup, j, "START", [[S, j.step(2)]]);
      expect(r.applied).toMatchObject([{ id: j.step(2), overridden: false }]);
    });

    it("an earlier step linked by a HARD rule is not also counted as SOFT", async () => {
      const j = await o.job({ steps: [{ seq: 1, role: "FIT_UP", jointRef: "J1" }, { seq: 2, role: "WELD", jointRef: "J1" }] });
      await owner.assemblyStep.update({ where: { id: j.step(1) }, data: { status: "SUBMITTED" } });
      const r = await rec(sup, j, "START", [[S, j.step(2)]]);
      expect(r.applied).toMatchObject([{ overridden: false }]);
    });

    it("component route order is SOFT on a unit with an assembly sequence", async () => {
      const j = await o.job({ steps: [{ seq: 1 }], components: [{ tag: "BRKT", ops: [{ code: "CUTTING" }, { code: "ROLLING" }] }] });
      const r = await rec(sup, j, "START", [[OP, j.op("BRKT", "ROLLING")]]);
      expect(refusal(r, j.op("BRKT", "ROLLING"))?.code).toBe(ERROR_CODES.SEQUENCE_OVERRIDE_REQUIRED);
    });

    it("a job with no assembly sequence gets HARD rules only: route order is free, H2 still refuses", async () => {
      const j = await o.job({
        components: [
          { tag: "BRKT", ops: [{ code: "CUTTING" }, { code: "ROLLING" }] },
          { tag: "SHELL", pressure: true, ops: [{ code: "CUTTING" }] },
        ],
      });
      const r = await rec(sup, j, "START", [[OP, j.op("BRKT", "ROLLING")], [OP, j.op("SHELL", "CUTTING")]]);
      expect(r.applied).toMatchObject([{ id: j.op("BRKT", "ROLLING"), overridden: false }]);
      expect(refusal(r, j.op("SHELL", "CUTTING"))?.code).toBe(ERROR_CODES.MATERIAL_NOT_ISSUED);
    });

    it("processes 1–11 (job grain): a planner may override office order", async () => {
      const j = await o.job({ steps: [{ seq: 1 }], processes: [{ code: "3", grain: "JOB" }, { code: "5", grain: "JOB" }] });
      const refused = await rec(planner, j, "START", [[P, j.plan("5")]]);
      expect(refusal(refused, j.plan("5"))?.meta).toMatchObject({ canOverride: true });
      const r = await rec(planner, j, "START", [[P, j.plan("5")]], { override: { category: "CLIENT_PRIORITY" } });
      expect(r.applied).toMatchObject([{ id: j.plan("5"), overridden: true }]);
      expect(await owner.sequenceOverride.findFirst({ where: { targetKind: P, targetId: j.plan("5") } })).toMatchObject({
        predecessorTargetId: j.plan("3"),
        unitId: null,
      });
    });

    it("a predecessor process still NOT_STARTED does not refuse: process edges are schedule-only", async () => {
      const j = await o.job({ processes: [{ code: "19" }, { code: "20" }] });
      await owner.jobProcessEdge.create({
        data: { jobId: j.job.id, processId: j.processes.get("20")!, predecessorId: j.processes.get("19")!, type: "FINISH_TO_START", lagDays: 0 },
      });
      const r = await rec(sup, j, "START", [[P, j.plan("20", 0)]]);
      expect(r.applied).toMatchObject([{ id: j.plan("20", 0), to: "IN_PROGRESS" }]);
    });
  });

  // ── Late Done (invariant 7 as revised) ───────────────────────────────────
  describe("late Done", () => {
    const lateJob = () =>
      o.job({
        processes: [{ code: "15", plannedFinish: yesterday() }],
        steps: [
          { seq: 1, processSeq: 15, requiresQc: false },
          { seq: 2, processSeq: 15, requiresQc: false },
        ],
      });

    it("without a reason: refused LATE_REASON_REQUIRED with the categories to choose from; nothing written", async () => {
      const j = await lateJob();
      const r = await rec(sup, j, "DONE", [[S, j.step(1)], [S, j.step(2)]]);
      expect(r.applied).toEqual([]);
      expect(refusal(r, j.step(1))).toMatchObject({ code: ERROR_CODES.LATE_REASON_REQUIRED, meta: { processPlanId: j.plan("15", 0) } });
      expect((refusal(r, j.step(1))?.meta.categories as Array<{ id: number }>).map((c) => c.id)).toContain(o.category.id);
      expect(await owner.delayReason.count({ where: { processPlanId: j.plan("15", 0) } })).toBe(0);
    });

    it("with a reason: applied as late, one DelayReason for the plan however many items map to it", async () => {
      const j = await lateJob();
      const r = await rec(sup, j, "DONE", [[S, j.step(1)], [S, j.step(2)]], { lateReason: { categoryId: o.category.id, note: "plates late" } });
      expect(r.applied).toMatchObject([{ late: true }, { late: true }]);
      expect(await owner.delayReason.findMany({ where: { processPlanId: j.plan("15", 0) } })).toMatchObject([
        { categoryId: o.category.id, detail: "plates late", filedBy: sup.userId },
      ]);
    });

    it("a plan that already has a reason needs no second one", async () => {
      const j = await lateJob();
      await owner.delayReason.create({ data: { jobId: j.job.id, processPlanId: j.plan("15", 0), categoryId: o.category.id, filedBy: sup.userId } });
      const r = await rec(sup, j, "DONE", [[S, j.step(1)]]);
      expect(r.applied).toMatchObject([{ late: true }]);
      expect(await owner.delayReason.count({ where: { processPlanId: j.plan("15", 0) } })).toBe(1);
    });

    it("a category of another tenant is NOT_FOUND for the whole call", async () => {
      const j = await lateJob();
      await expectThrownCode(rec(sup, j, "DONE", [[S, j.step(1)]], { lateReason: { categoryId: b.category.id } }), ERROR_CODES.NOT_FOUND);
    });

    it("not late when the planned finish is today, or START (only Done carries the reason)", async () => {
      const j = await o.job({ processes: [{ code: "15", plannedFinish: istCalendarDayMarker() }], steps: [{ seq: 1, processSeq: 15, requiresQc: false }] });
      const r = await rec(sup, j, "DONE", [[S, j.step(1)]]);
      expect(r.applied).toMatchObject([{ late: false }]);
      const k = await lateJob();
      expect((await rec(sup, k, "START", [[S, k.step(1)]])).applied).toMatchObject([{ late: false }]);
    });
  });

  // ── requiresQc (D3) ─────────────────────────────────────────────────────
  describe("requiresQc", () => {
    it("true: Done goes to SUBMITTED for QC, with one notification per unit per batch", async () => {
      const j = await o.job({ units: 2, steps: [{ seq: 1 }, { seq: 2 }] });
      const r = await rec(sup, j, "DONE", [[S, j.step(1, 0)], [S, j.step(2, 0)], [S, j.step(1, 1)], [S, j.step(2, 1)]]);
      expect(r.applied.map((a) => a.to)).toEqual(["SUBMITTED", "SUBMITTED", "SUBMITTED", "SUBMITTED"]);
      const s = await stepRow(j.step(1));
      expect([s.status, s.submittedBy, s.finishedAt]).toEqual(["SUBMITTED", sup.userId, null]);
      const notes = await owner.notification.findMany({
        where: { recipientId: qc.userId, type: "ITEM_SUBMITTED", entityType: "Unit", entityId: { in: j.units.map((u) => u.id) } },
      });
      expect(notes.map((n) => n.entityId).sort()).toEqual(j.units.map((u) => u.id).sort());
      expect(notes[0].title).toMatch(/^2 items awaiting your verification/);
    });

    it("false on an unmapped unit plan: an open blocking H point on it refuses HOLD_POINT_OPEN (invariant 4); nothing written", async () => {
      const j = await o.job({ processes: [{ code: "22", requiresQc: false }] });
      const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId: j.job.id, jobLabel: "x", vessel: "x" } });
      const party = await owner.inspectionParty.create({ data: { qcpTemplateId: qcpTemplate.id, code: "DESPL", jobId: j.job.id } });
      const item = await owner.qcpItem.create({ data: { qcpTemplateId: qcpTemplate.id, sequence: 1, srNo: "9", kind: "CHECKPOINT", activity: "H", jobId: j.job.id } });
      await owner.qcpItemPartyCode.create({ data: { qcpItemId: item.id, inspectionPartyId: party.id, qcpCodeId: o.holdCode.id, jobId: j.job.id } });
      await owner.qcpItemProcess.create({ data: { qcpItemId: item.id, jobProcessId: j.processes.get("22")!, jobId: j.job.id } });

      const r = await rec(sup, j, "DONE", [[P, j.plan("22", 0)]]);
      expect(refusal(r, j.plan("22", 0))?.code).toBe(ERROR_CODES.HOLD_POINT_OPEN);
      expect((await planRow(j.plan("22", 0))).status).toBe("NOT_STARTED");

      await owner.qcpExecution.create({ data: { qcpItemId: item.id, unitId: j.units[0].id, result: "ACCEPTED", jobId: j.job.id } });
      expect((await rec(sup, j, "DONE", [[P, j.plan("22", 0)]])).applied).toMatchObject([{ to: "COMPLETE" }]);
    });

    it("false: Done goes straight to COMPLETE, audited, no QC notification", async () => {
      const j = await o.job({ steps: [{ seq: 1, requiresQc: false }] });
      const r = await rec(sup, j, "DONE", [[S, j.step(1)]]);
      expect(r.applied).toMatchObject([{ from: "NOT_STARTED", to: "COMPLETE" }]);
      const s = await stepRow(j.step(1));
      expect(s.finishedAt).toBeInstanceOf(Date);
      expect(await audits("AssemblyStep", j.step(1), "work.done")).toBe(1);
      expect(await owner.notification.count({ where: { entityType: "Unit", entityId: j.units[0].id } })).toBe(0);
    });

    it("a weld step whose template names a joint needs one bound before Done", async () => {
      const j = await o.job({ steps: [{ seq: 1, templateJointRef: "LS-1" }] });
      const r = await rec(sup, j, "DONE", [[S, j.step(1)]]);
      expect(refusal(r, j.step(1))?.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      const joint = await owner.weldJoint.create({ data: { jobId: j.job.id, unitId: j.units[0].id, jointNo: "LS-1", jointType: "BUTT", loggedBy: sup.userId } });
      const ok = await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: S, id: j.step(1), detail: { weldJointId: joint.id } }] });
      expect(ok.applied).toHaveLength(1);
      expect((await stepRow(j.step(1))).weldJointId).toBe(joint.id);
    });
  });

  // ── Batches ──────────────────────────────────────────────────────────────
  describe("partial-success batches", () => {
    it("refused items stay unchanged and unaudited; applied ones are audited", async () => {
      const j = await o.job({ steps: [{ seq: 1 }, { seq: 2, kind: "INSPECTION" }] });
      const r = await rec(sup, j, "START", [[S, j.step(1)], [S, j.step(2)]]);
      expect(r.applied.map((a) => a.id)).toEqual([j.step(1)]);
      expect((await stepRow(j.step(2))).status).toBe("NOT_STARTED");
      expect(await audits("AssemblyStep", j.step(1), "work.start")).toBe(1);
      expect(await audits("AssemblyStep", j.step(2))).toBe(0);
    });

    it("items apply in caller order: fit-up Done then weld passes H1; reversed, the weld is refused", async () => {
      const steps = [
        { seq: 1, role: "FIT_UP" as const, jointRef: "J1", pressurePart: true },
        { seq: 2, role: "WELD" as const, jointRef: "J1", pressurePart: true },
      ];
      const j = await o.job({ steps });
      const r = await rec(sup, j, "DONE", [[S, j.step(1)], [S, j.step(2)]]);
      expect(r.applied.map((a) => a.id)).toEqual([j.step(1), j.step(2)]);
      const k = await o.job({ steps });
      const rev = await rec(sup, k, "DONE", [[S, k.step(2)], [S, k.step(1)]]);
      expect(refusal(rev, k.step(2))?.code).toBe(ERROR_CODES.JOINT_SEQUENCE_BLOCKED);
      expect(rev.applied.map((a) => a.id)).toEqual([k.step(1)]);
    });
  });

  // ── rollupProcessPlan ───────────────────────────────────────────────────
  describe("rollupProcessPlan", () => {
    const mapped = (extra: JobSpec = {}) =>
      o.job({
        processes: [{ code: "20" }],
        steps: [
          { seq: 1, processSeq: 20, requiresQc: false },
          { seq: 2, processSeq: 20, requiresQc: false },
        ],
        ...extra,
      });
    const rollup = (j: WorkJob) =>
      withJob(o.tenantId, j.job.id, (tx) => rollupProcessPlan(tx, head, j.processes.get("20")!, j.units[0].id));
    const override = { override: { category: "CREW_OR_MACHINE_FREE" as const } };

    it("NOT_STARTED while nothing has started: no change, no audit", async () => {
      const j = await mapped();
      expect(await rollup(j)).toBeNull();
      expect(await audits("ProcessPlan", j.plan("20", 0))).toBe(0);
    });

    it("IN_PROGRESS once any item starts, COMPLETE when all are; times are the min/max, one audit row per change", async () => {
      const j = await mapped();
      const at = new Date(Date.now() - 3 * HOUR);
      const r1 = await rec(sup, j, "START", [[S, j.step(1)]], { reportedAt: at.toISOString() });
      expect(r1.rolledUp).toEqual([{ processPlanId: j.plan("20", 0), from: "NOT_STARTED", to: "IN_PROGRESS" }]);
      let p = await planRow(j.plan("20", 0));
      expect(p.actualStart).toEqual((await stepRow(j.step(1))).startedAt);
      expect(p.reportedStartAt).toEqual(at);

      const r2 = await rec(sup, j, "DONE", [[S, j.step(1)], [S, j.step(2)]]);
      expect(r2.rolledUp).toEqual([{ processPlanId: j.plan("20", 0), from: "IN_PROGRESS", to: "COMPLETE" }]);
      p = await planRow(j.plan("20", 0));
      expect(p.actualFinish).toEqual((await stepRow(j.step(2))).finishedAt);
      expect(p.reportedStartAt).toEqual(at);
      expect(await audits("ProcessPlan", p.id, "process.rollup")).toBe(2);
    });

    it("all items COMPLETE but a blocking H point on the process is open: stays IN_PROGRESS until QC clears it", async () => {
      const j = await mapped();
      const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId: j.job.id, jobLabel: "x", vessel: "x" } });
      const party = await owner.inspectionParty.create({ data: { qcpTemplateId: qcpTemplate.id, code: "DESPL", jobId: j.job.id } });
      const item = await owner.qcpItem.create({ data: { qcpTemplateId: qcpTemplate.id, sequence: 1, srNo: "9", kind: "CHECKPOINT", activity: "H", jobId: j.job.id } });
      await owner.qcpItemPartyCode.create({ data: { qcpItemId: item.id, inspectionPartyId: party.id, qcpCodeId: o.holdCode.id, jobId: j.job.id } });
      await owner.qcpItemProcess.create({ data: { qcpItemId: item.id, jobProcessId: j.processes.get("20")!, jobId: j.job.id } });

      const r = await rec(sup, j, "DONE", [[S, j.step(1)], [S, j.step(2)]]);
      expect(r.rolledUp).toMatchObject([{ to: "IN_PROGRESS" }]);
      await owner.qcpExecution.create({ data: { qcpItemId: item.id, unitId: j.units[0].id, result: "ACCEPTED", jobId: j.job.id } });
      expect(await rollup(j)).toMatchObject({ from: "IN_PROGRESS", to: "COMPLETE" });
    });

    it("all items COMPLETE but a mapped item has an open NCR: stays IN_PROGRESS", async () => {
      const j = await mapped();
      const rej = await owner.assemblyStepRejection.create({ data: { assemblyStepId: j.step(1), categoryId: o.category.id, rejectedBy: head.userId, jobId: j.job.id } });
      await owner.ncr.create({ data: { assemblyStepRejectionId: rej.id, jobId: j.job.id } });
      const r = await rec(sup, j, "DONE", [[S, j.step(1)], [S, j.step(2)]]);
      expect(r.rolledUp).toMatchObject([{ to: "IN_PROGRESS" }]);
      expect((await planRow(j.plan("20", 0))).status).toBe("IN_PROGRESS");
    });

    it("moves back from COMPLETE when a mapped item is reopened", async () => {
      const j = await mapped();
      await rec(sup, j, "DONE", [[S, j.step(1)], [S, j.step(2)]]);
      expect((await planRow(j.plan("20", 0))).status).toBe("COMPLETE");
      await owner.assemblyStep.update({ where: { id: j.step(2) }, data: { status: "IN_PROGRESS" } });
      expect(await rollup(j)).toMatchObject({ from: "COMPLETE", to: "IN_PROGRESS" });
      expect((await planRow(j.plan("20", 0))).actualFinish).toBeNull();
    });

    it("an item mapped to an excluded process (no plan) rolls up nothing", async () => {
      const j = await o.job({ processes: [{ code: "21", included: false }], steps: [{ seq: 1, processSeq: 21 }] });
      const r = await rec(sup, j, "START", [[S, j.step(1)]]);
      expect([r.applied.length, r.rolledUp]).toEqual([1, []]);
    });

    it("an ON_HOLD plan is skipped", async () => {
      const j = await mapped();
      await owner.processPlan.update({ where: { id: j.plan("20", 0) }, data: { status: "ON_HOLD" } });
      const r = await rec(sup, j, "START", [[S, j.step(1)]]);
      expect(r.rolledUp).toEqual([]);
      expect((await planRow(j.plan("20", 0))).status).toBe("ON_HOLD");
    });

    it("a JOB-grain plan (unitId null) is written directly: requiresQc false → COMPLETE, true → SUBMITTED", async () => {
      const j = await o.job({ processes: [{ code: "3", grain: "JOB", requiresQc: false }, { code: "33", grain: "JOB" }] });
      const r = await rec(head, j, "DONE", [[P, j.plan("3")], [P, j.plan("33")]], override);
      expect(r.applied.map((a) => [a.id, a.to])).toEqual([
        [j.plan("3"), "COMPLETE"],
        [j.plan("33"), "SUBMITTED"],
      ]);
      const p = await planRow(j.plan("3"));
      expect([p.actualStart, p.actualFinish].every((d) => d instanceof Date)).toBe(true);
      expect(r.rolledUp).toEqual([]);
    });
  });

  // ── Concurrency and replay ──────────────────────────────────────────────
  describe("concurrency (two real connections) and replay", () => {
    it("two supervisors starting the same item: one applied, one refused naming the winner, one audit row", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      const [r1, r2] = await Promise.all([rec(sup, j, "START", [[S, j.step(1)]]), rec(sup2, j, "START", [[S, j.step(1)]])]);
      const winner = r1.applied.length ? sup : sup2;
      const loser = r1.applied.length ? r2 : r1;
      expect(r1.applied.length + r2.applied.length).toBe(1);
      expect(loser.refused[0]).toMatchObject({ code: ERROR_CODES.INVALID_STATE_TRANSITION, meta: { startedBy: winner.userId } });
      expect(await audits("AssemblyStep", j.step(1), "work.start")).toBe(1);
    });

    it("waits on the unit's floor lock and reads the unit only after it: a write committed meanwhile is seen", async () => {
      const { FLOOR_LOCK_UNIT } = await import("./_shared");
      const j = await o.job({ steps: [{ seq: 1 }] });
      let pending: Promise<Result> | null = null;
      let settled = false;
      // Another connection holds the unit's lock, changes the step, then commits (releasing the lock).
      await owner.$transaction(async (t) => {
        await t.$executeRaw`SELECT pg_advisory_xact_lock(${FLOOR_LOCK_UNIT}::int, ${j.units[0].id}::int)`;
        pending = rec(sup, j, "START", [[S, j.step(1)]]);
        void pending.finally(() => (settled = true));
        await new Promise((r) => setTimeout(r, 400));
        expect(settled).toBe(false);
        await t.assemblyStep.update({ where: { id: j.step(1) }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
      });
      const r = await pending!;
      expect(refusal(r, j.step(1))).toMatchObject({ code: ERROR_CODES.INVALID_STATE_TRANSITION, meta: { currentStatus: "IN_PROGRESS" } });
    });

    it("overlapping batches naming units in opposite orders do not deadlock", async () => {
      for (let round = 0; round < 3; round++) {
        const j = await o.job({ units: 2, components: [{ tag: "A", ops: [{ code: "CUTTING" }] }, { tag: "B", ops: [{ code: "CUTTING" }] }] });
        const [r1, r2] = await Promise.all([
          rec(sup, j, "START", [[OP, j.op("A", "CUTTING", 0)], [OP, j.op("A", "CUTTING", 1)]]),
          rec(sup2, j, "START", [[OP, j.op("B", "CUTTING", 1)], [OP, j.op("B", "CUTTING", 0)]]),
        ]);
        expect([r1.applied.length, r2.applied.length]).toEqual([2, 2]);
      }
    });

    it("a replayed requestId returns the stored answer and writes nothing", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      const requestId = crypto.randomUUID();
      const first = await rec(sup, j, "START", [[S, j.step(1)]], { requestId });
      const second = await rec(sup, j, "START", [[S, j.step(1)]], { requestId });
      expect(second).toEqual({ ...first, replayed: true });
      expect(await audits("AssemblyStep", j.step(1))).toBe(1);
      expect(await owner.workRequest.count({ where: { requestId } })).toBe(1);
    });

    it("a requestId reused by someone else is refused", async () => {
      const j = await o.job({ steps: [{ seq: 1 }, { seq: 2 }] });
      const requestId = crypto.randomUUID();
      await rec(sup, j, "START", [[S, j.step(1)]], { requestId });
      await expectThrownCode(rec(sup2, j, "START", [[S, j.step(1)]], { requestId }), ERROR_CODES.VALIDATION_FAILED);
    });

    it("a requestId reused on another job (hidden by job RLS) is refused VALIDATION_FAILED, and that batch is rolled back", async () => {
      const j = await o.job({ steps: [{ seq: 1 }] });
      const k = await o.job({ steps: [{ seq: 1 }] });
      const requestId = crypto.randomUUID();
      await rec(sup, j, "START", [[S, j.step(1)]], { requestId });
      await expectThrownCode(rec(sup, k, "START", [[S, k.step(1)]], { requestId }), ERROR_CODES.VALIDATION_FAILED);
      expect((await stepRow(k.step(1))).status).toBe("NOT_STARTED");
    });
  });
});
