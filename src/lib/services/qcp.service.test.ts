import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * `recordQcpExecution` (Task 7) has no pure logic worth unit-testing in
 * isolation — it's a role gate + an attemptNo aggregate + a create, all of
 * which only mean something against real gating (assertNoOpenHoldPoint in
 * _shared.ts) and a real seeded QcpItem/QcpExecution chain. So this file is
 * DB-gated only, following process.service.test.ts's DESPL-320 block.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("recordQcpExecution (DB-backed, clears a real hold point)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { generateSchedule } = await import("./schedule.service");
  const { startProcess, submitProcess, verifyProcess } = await import("./process.service");
  const { recordQcpExecution } = await import("./qcp.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function planner(tenantId: number): Actor {
    return {
      userId: 1,
      tenantId,
      clientId: null,
      name: "PH",
      email: "ph@x",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  }

  async function despl320(): Promise<{ jobId: number; tenantId: number }> {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    return { jobId: job.id, tenantId: job.tenantId };
  }

  /** Look up a DESPL-320 job process by its stable template seq (1..36), not
   * its DB primary key — the seed's insertion order can shift across reseeds. */
  async function procId(jobId: number, seq: number): Promise<number> {
    const jp = await owner.jobProcess.findFirstOrThrow({ where: { jobId, seq } });
    return jp.id;
  }

  /** Every currently-linked blocking (blocksCompletion=true) QCP checkpoint on
   * a job process — looked up live, never hardcoded (matches
   * process.service.test.ts's per-unit hold-point block). */
  async function blockingQcpItemIds(jobProcessId: number): Promise<number[]> {
    const items = await owner.qcpItem.findMany({
      where: {
        processLinks: { some: { jobProcessId } },
        partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
      },
      select: { id: true },
    });
    return items.map((i) => i.id);
  }

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  const future = new Date(Date.now() + 30 * 864e5);

  it("recording ACCEPTED clears a genuinely open hold point so verify succeeds (#4)", async () => {
    const { jobId, tenantId } = await despl320();
    const a = planner(tenantId);

    // seq 1 (PO Receipt & Order Review) is a root process — no predecessors of
    // its own — and carries a real blocking checkpoint (seeded QcpItem 4), so
    // start→submit succeeds cleanly and the only thing standing between
    // SUBMITTED and COMPLETE is the uncleared hold point.
    const seq1Id = await procId(jobId, 1);
    const blocking = await blockingQcpItemIds(seq1Id);
    expect(blocking.length).toBeGreaterThan(0); // sanity: a real blocking checkpoint IS linked here

    // Use a unit process.service.test.ts's DB block never touches (it clears
    // QcpItem 4 for the FIRST unit only) — pick the third instead, so this
    // test's own hold point is genuinely open, not already cleared by a
    // sibling suite sharing this no-cleanup seed DB.
    const unit = (
      await owner.unit.findMany({ where: { equipment: { jobId } }, orderBy: { id: "asc" } })
    )[2];

    // Reset: QcpExecution is unit-scoped state with no end-of-suite cleanup
    // (matches this file's "no cleanup, disposable test DB" convention) — but
    // THIS test asserts a genuine before/after (HOLD_POINT_OPEN → cleared), so
    // it resets its own precondition at the start to stay rerun-safe.
    await owner.qcpExecution.deleteMany({ where: { unitId: unit.id, qcpItemId: { in: blocking } } });

    // Same reasoning for the ProcessPlan itself: persistScheduleRun now
    // carries real work forward across a reschedule (audit C1 fix) instead of
    // resetting it, so a rerun against this no-cleanup seed DB would otherwise
    // find seq1/unit[2] already SUBMITTED or COMPLETE from the run before.
    await owner.processPlan.updateMany({
      where: { scheduleRun: { jobId, isCurrent: true }, jobProcessId: seq1Id, unitId: unit.id },
      data: { status: "NOT_STARTED", actualStart: null, actualFinish: null, submittedBy: null, verifiedBy: null },
    });

    const run = await generateSchedule(a, { jobId, mode: "FORWARD", projectStartDate: future });
    const planId = run.processPlans.find((p) => p.jobProcessId === seq1Id && p.unitId === unit.id)!.id;

    const maker: Actor = a;
    const checker: Actor = { ...a, userId: 2, roles: [ROLES.QC] };

    await startProcess(maker, { processPlanId: planId });
    await submitProcess(maker, { processPlanId: planId });

    // RED: no QcpExecution recorded yet for this unit → verify refuses.
    await expectCode(verifyProcess(checker, { processPlanId: planId }), ERROR_CODES.HOLD_POINT_OPEN);

    const qcActor: Actor = { ...a, userId: 3, roles: [ROLES.QC] };
    for (const qcpItemId of blocking) {
      const exec = await recordQcpExecution(qcActor, {
        qcpItemId,
        unitId: unit.id,
        result: "ACCEPTED",
      });
      expect(exec.result).toBe("ACCEPTED");
      expect(exec.attemptNo).toBe(1);
      expect(exec.clearedBy).toBe(qcActor.userId);
      // H1: recordQcpExecution populates jobId from the unit's own jobId.
      expect(exec.jobId).toBe(jobId);
    }

    // GREEN: every blocking checkpoint is now ACCEPTED for this unit → verify succeeds.
    const verified = await verifyProcess(checker, { processPlanId: planId });
    expect(verified.status).toBe("COMPLETE");
  });

  it("client user is rejected — read-only, no exceptions (#1 access rule)", async () => {
    const { tenantId } = await despl320();
    // roles: [QC] so the ONLY thing that can throw FORBIDDEN here is
    // assertNotClientUser — if it were ever deleted, requireRole would still
    // pass and this test would catch the regression instead of masking it.
    const clientActor: Actor = { ...planner(tenantId), clientId: 1, roles: [ROLES.QC] };
    await expectCode(
      recordQcpExecution(clientActor, { qcpItemId: 1, unitId: 1, result: "ACCEPTED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("non-QC actor (e.g. SUPERVISOR) is rejected — recording an inspection result is a QC act", async () => {
    const { tenantId } = await despl320();
    const supervisor: Actor = { ...planner(tenantId), roles: [ROLES.SUPERVISOR] };
    await expectCode(
      recordQcpExecution(supervisor, { qcpItemId: 1, unitId: 1, result: "ACCEPTED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });
});

/**
 * AUD-003 — NA is a pending waiver, not a clearance. `recordQcpExecution`
 * refuses NA outright when the item's blocking code is not `waivable`; when
 * it IS waivable, NA is recorded but leaves `waiverApprovedBy` null, and the
 * hold-point gate (`assertUnitHasNoOpenHoldPoint`) must keep reporting it
 * open until a Production Head/Admin calls `approveQcpWaiver`. Uses its own
 * throwaway Organization (not the shared DESPL-320 seed) because it needs
 * two `QcpCodeRef` rows with a specific blocksCompletion/waivable
 * combination the seed data doesn't happen to carry together, and
 * `clearedBy`/`waiverApprovedBy` are real FKs to `users`.
 */
describe.skipIf(!RUN_DB)("recordQcpExecution + approveQcpWaiver — NA/waiver gating (AUD-003, DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { assertUnitHasNoOpenHoldPoint } = await import("./_shared");
  const { recordQcpExecution, approveQcpWaiver } = await import("./qcp.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.qcpExecution.deleteMany({ where: { job: { tenantId } } });
    await owner.qcpItemPartyCode.deleteMany({ where: { qcpItem: { qcpTemplate: { job: { tenantId } } } } });
    await owner.qcpItem.deleteMany({ where: { qcpTemplate: { job: { tenantId } } } });
    await owner.inspectionParty.deleteMany({ where: { qcpTemplate: { job: { tenantId } } } });
    await owner.qcpCodeRef.deleteMany({ where: { tenantId } });
    await owner.qcpTemplate.deleteMany({ where: { job: { tenantId } } });
    await owner.unit.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.equipment.deleteMany({ where: { job: { tenantId } } });
    await owner.job.deleteMany({ where: { tenantId } });
    await owner.processTemplateVersion.deleteMany({ where: { template: { tenantId } } });
    await owner.processTemplate.deleteMany({ where: { tenantId } });
    await owner.productFamily.deleteMany({ where: { tenantId } });
    await owner.client.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.organization.delete({ where: { id: tenantId } });
  }

  let tenantId = 0;
  let jobId = 0;
  let unitId = 0;
  let qcActor: Actor;
  let phActor: Actor;
  let holdItemId = 0; // blocking, NOT waivable — real "H" semantics
  let witnessItemId = 0; // blocking AND waivable — real "RW"/"W" semantics
  let untouchedItemId = 0; // never executed, non-blocking — see note below

  // All DB writes live here, not at the describe body's top level: vitest
  // still CALLS a skipIf'd describe's callback during collection (to
  // discover its `it()`s) even when the suite itself won't run — only `it`
  // bodies (and beforeAll/afterAll) are actually skipped. Top-level awaited
  // DB calls would fire against whatever DATABASE_URL `pnpm test` (no
  // RUN_DB_TESTS) happens to be pointed at, same convention every other
  // DB-backed suite in this codebase already follows (see assembly.service.test.ts).
  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-AUD003-${Date.now()}-${Math.random()}`, name: "AUD-003 waiver test" },
    });
    tenantId = org.id;
    const client = await owner.client.create({
      data: { tenantId, name: "ACME", code: `ACME-${Date.now()}-${Math.random()}` },
    });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-aud003-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-AUD003-${Date.now()}-${Math.random()}`,
      },
    });
    jobId = job.id;
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Air Receiver" } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "01" } });
    unitId = unit.id;

    const qcUser = await owner.user.create({
      data: {
        tenantId,
        email: `qc-${Date.now()}-${Math.random()}@test.local`,
        username: `qc-${Date.now()}-${Math.random()}`,
        passwordHash: "x",
        name: "Test QC",
        themePreference: "SYSTEM",
      },
    });
    const phUser = await owner.user.create({
      data: {
        tenantId,
        email: `ph-${Date.now()}-${Math.random()}@test.local`,
        username: `ph-${Date.now()}-${Math.random()}`,
        passwordHash: "x",
        name: "Test PH",
        themePreference: "SYSTEM",
      },
    });

    qcActor = {
      userId: qcUser.id,
      tenantId,
      clientId: null,
      name: qcUser.name,
      email: qcUser.email,
      roles: [ROLES.QC],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    phActor = { ...qcActor, userId: phUser.id, name: phUser.name, email: phUser.email, roles: [ROLES.PRODUCTION_HEAD] };

    const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId: job.id, jobLabel: "V", vessel: "V" } });
    const party = await owner.inspectionParty.create({ data: { qcpTemplateId: qcpTemplate.id, code: "QC" } });

    // Blocking, NOT waivable — a hard hold (real "H" semantics): NA must
    // never clear this one, no matter who approves it.
    const holdCode = await owner.qcpCodeRef.create({
      data: { tenantId, code: "H", label: "Hold", blocksCompletion: true, waivable: false },
    });
    // Blocking AND waivable — a witness point sampled at reduced frequency
    // (real "RW"/"W" semantics): NA is legal here, but only clears once a
    // Production Head approves it.
    const witnessCode = await owner.qcpCodeRef.create({
      data: { tenantId, code: "RW", label: "10% Witness", blocksCompletion: true, waivable: true, requiresCall: true },
    });
    // Never executed at all, and NOT a blocking code — used only to prove
    // approveQcpWaiver refuses a checkpoint that was never recorded as NA
    // (test 7). blocksCompletion: false is deliberate: if this item DID
    // block, it would confound test 3/5's hold-point assertions (they'd stay
    // "open" because of THIS item, not because of witnessItem's pending NA —
    // masking the actual regression the two tests exist to catch).
    const untouchedCode = await owner.qcpCodeRef.create({
      data: { tenantId, code: "R2", label: "Review 2", blocksCompletion: false, waivable: false },
    });

    const holdItem = await owner.qcpItem.create({
      data: { qcpTemplateId: qcpTemplate.id, jobId, sequence: 1, srNo: "1", kind: "CHECKPOINT", activity: "Hydrotest witness" },
    });
    await owner.qcpItemPartyCode.create({ data: { qcpItemId: holdItem.id, inspectionPartyId: party.id, qcpCodeId: holdCode.id } });
    holdItemId = holdItem.id;

    const witnessItem = await owner.qcpItem.create({
      data: { qcpTemplateId: qcpTemplate.id, jobId, sequence: 2, srNo: "2", kind: "CHECKPOINT", activity: "10% witness point" },
    });
    await owner.qcpItemPartyCode.create({ data: { qcpItemId: witnessItem.id, inspectionPartyId: party.id, qcpCodeId: witnessCode.id } });
    witnessItemId = witnessItem.id;

    const untouchedItem = await owner.qcpItem.create({
      data: { qcpTemplateId: qcpTemplate.id, jobId, sequence: 3, srNo: "3", kind: "CHECKPOINT", activity: "Never inspected" },
    });
    await owner.qcpItemPartyCode.create({ data: { qcpItemId: untouchedItem.id, inspectionPartyId: party.id, qcpCodeId: untouchedCode.id } });
    untouchedItemId = untouchedItem.id;
  });

  afterAll(async () => {
    if (tenantId) await deleteOrgAndChildren(tenantId).catch(() => {});
    await owner.$disconnect();
  });

  it("1: NA on a checkpoint whose only blocking code is not waivable is refused before any write", async () => {
    await expectCode(
      recordQcpExecution(qcActor, { qcpItemId: holdItemId, unitId, result: "NA" }),
      ERROR_CODES.QCP_CODE_NOT_WAIVABLE,
    );
    expect(await owner.qcpExecution.count({ where: { qcpItemId: holdItemId, unitId } })).toBe(0);
  });

  it("9: ACCEPTED is unaffected by the AUD-003 change — clears the same hard-hold item immediately", async () => {
    const exec = await recordQcpExecution(qcActor, { qcpItemId: holdItemId, unitId, result: "ACCEPTED" });
    expect(exec.result).toBe("ACCEPTED");
    expect(exec.waiverApprovedBy).toBeNull();
  });

  it("2: NA on a checkpoint whose blocking code IS waivable succeeds, but leaves waiverApprovedBy null (pending, not cleared)", async () => {
    const exec = await recordQcpExecution(qcActor, { qcpItemId: witnessItemId, unitId, result: "NA" });
    expect(exec.result).toBe("NA");
    expect(exec.waiverApprovedBy).toBeNull();
    expect(exec.clearedBy).toBe(qcActor.userId);
  });

  it("3: after (2), the hold-point gate still reports open — the core AUD-003 regression guard", async () => {
    // holdItem was ACCEPTED in test 9 above, so witnessItem's unapproved NA is
    // the only thing that can still be open here — isolates exactly what this
    // session changed rather than any other unrelated open checkpoint.
    await withTenant(tenantId, async (tx) => {
      await expectCode(
        assertUnitHasNoOpenHoldPoint(tx, unitId, jobId),
        ERROR_CODES.HOLD_POINT_OPEN,
      );
    });
  });

  it("6: a QC-role actor (not PRODUCTION_HEAD/ADMIN) cannot approve a waiver", async () => {
    await expectCode(
      approveQcpWaiver(qcActor, { qcpItemId: witnessItemId, unitId }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("7: approveQcpWaiver refuses an item with no NA execution at all", async () => {
    await expectCode(
      approveQcpWaiver(phActor, { qcpItemId: untouchedItemId, unitId }),
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });

  it("4: a Production Head approves the pending waiver — waiverApprovedBy is stamped, audit row written", async () => {
    const before = await owner.auditLog.count({ where: { entityType: "QcpExecution", action: "qcp.waiver_approve" } });
    const updated = await approveQcpWaiver(phActor, { qcpItemId: witnessItemId, unitId });
    expect(updated.waiverApprovedBy).toBe(phActor.userId);
    const after = await owner.auditLog.count({ where: { entityType: "QcpExecution", action: "qcp.waiver_approve" } });
    expect(after).toBe(before + 1);
  });

  it("5: after (4), the hold-point gate now reports clear", async () => {
    await withTenant(tenantId, async (tx) => {
      await assertUnitHasNoOpenHoldPoint(tx, unitId, jobId); // does not throw
    });
  });

  it("8: approving the same execution a second time is refused", async () => {
    await expectCode(
      approveQcpWaiver(phActor, { qcpItemId: witnessItemId, unitId }),
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });
});

/**
 * AUD-077 (12_SECURITY_RBAC.md §6 — the finding's own numbering; this
 * session's brief inverted 077/078 relative to that doc and
 * `19_MASTER_ISSUE_REGISTER.md`, which are treated as canonical): before
 * this fix, `recordQcpExecution` took `qcpItemId` as given and never
 * checked it belonged to `unitId`'s own job. Two jobs under the SAME tenant
 * — the case AUD-078's future tenantId/RLS work does not cover on its own —
 * each with their own QcpTemplate/QcpItem chain, deliberately constructed so
 * job2's item can be tried against job1's unit.
 */
describe.skipIf(!RUN_DB)("recordQcpExecution — cross-job qcpItemId is refused (AUD-077)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { recordQcpExecution } = await import("./qcp.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  let tenantId = 0;
  let qcActor: Actor;
  let unit1Id = 0;
  let item1Id = 0; // belongs to job1, same job as unit1
  let item2Id = 0; // belongs to job2 — a different job, same tenant
  let libraryItemId = 0; // belongs to no job at all (jobId null)
  let libraryTemplateId = 0;

  async function makeJobWithItem(tenantId: number, tag: string) {
    const client = await owner.client.create({
      data: { tenantId, name: `ACME-${tag}`, code: `ACME-${tag}-${Date.now()}-${Math.random()}` },
    });
    const family = await owner.productFamily.create({ data: { tenantId, code: `PV-${tag}`, name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: `T-${tag}` } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-aud077-${tag}-${Date.now()}-${Math.random()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DE-AUD077-${tag}-${Date.now()}-${Math.random()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: `Vessel-${tag}` } });
    const unit = await owner.unit.create({ data: { jobId: job.id, equipmentId: equipment.id, serialNo: "01" } });
    const qcpTemplate = await owner.qcpTemplate.create({ data: { jobId: job.id, jobLabel: tag, vessel: tag } });
    const item = await owner.qcpItem.create({
      data: { qcpTemplateId: qcpTemplate.id, jobId: job.id, sequence: 1, srNo: "1", kind: "CHECKPOINT", activity: "Check" },
    });
    return { jobId: job.id, unitId: unit.id, itemId: item.id, qcpTemplateId: qcpTemplate.id };
  }

  async function deleteOrgAndChildren(tenantId: number) {
    await owner.qcpExecution.deleteMany({ where: { job: { tenantId } } });
    await owner.qcpItem.deleteMany({ where: { qcpTemplate: { job: { tenantId } } } });
    await owner.qcpTemplate.deleteMany({ where: { job: { tenantId } } });
    await owner.unit.deleteMany({ where: { equipment: { job: { tenantId } } } });
    await owner.equipment.deleteMany({ where: { job: { tenantId } } });
    await owner.job.deleteMany({ where: { tenantId } });
    await owner.processTemplateVersion.deleteMany({ where: { template: { tenantId } } });
    await owner.processTemplate.deleteMany({ where: { tenantId } });
    await owner.productFamily.deleteMany({ where: { tenantId } });
    await owner.client.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.organization.delete({ where: { id: tenantId } });
  }

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-AUD077-${Date.now()}-${Math.random()}`, name: "AUD-077 cross-job test" },
    });
    tenantId = org.id;

    const job1 = await makeJobWithItem(tenantId, "J1");
    const job2 = await makeJobWithItem(tenantId, "J2");
    unit1Id = job1.unitId;
    item1Id = job1.itemId;
    item2Id = job2.itemId;

    // A genuine library item — no owning job at all — must also be refused
    // against a real unit; it is never linked into any job's processes and
    // recordQcpExecution against it would be meaningless.
    const libraryTemplate = await owner.qcpTemplate.create({ data: { jobId: null, jobLabel: "LIB", vessel: "LIB" } });
    const libraryItem = await owner.qcpItem.create({
      data: { qcpTemplateId: libraryTemplate.id, sequence: 1, srNo: "1", kind: "CHECKPOINT", activity: "Library check" },
    });
    libraryItemId = libraryItem.id;
    libraryTemplateId = libraryTemplate.id;

    const qcUser = await owner.user.create({
      data: {
        tenantId,
        email: `qc-aud077-${Date.now()}-${Math.random()}@test.local`,
        username: `qc-aud077-${Date.now()}-${Math.random()}`,
        passwordHash: "x",
        name: "Test QC",
        themePreference: "SYSTEM",
      },
    });
    qcActor = {
      userId: qcUser.id,
      tenantId,
      clientId: null,
      name: qcUser.name,
      email: qcUser.email,
      roles: [ROLES.QC],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
  });

  afterAll(async () => {
    if (libraryItemId) await owner.qcpItem.delete({ where: { id: libraryItemId } }).catch(() => {});
    if (libraryTemplateId) await owner.qcpTemplate.delete({ where: { id: libraryTemplateId } }).catch(() => {});
    if (tenantId) await deleteOrgAndChildren(tenantId).catch(() => {});
    await owner.$disconnect();
  });

  it("3: qcpItemId whose owning job matches unitId's job succeeds, unchanged from today", async () => {
    const exec = await recordQcpExecution(qcActor, { qcpItemId: item1Id, unitId: unit1Id, result: "ACCEPTED" });
    expect(exec.result).toBe("ACCEPTED");
  });

  it("4: qcpItemId whose owning job does NOT match unitId's job is refused — CROSS_JOB_ASSIGNMENT, no row created", async () => {
    const before = await owner.qcpExecution.count({ where: { qcpItemId: item2Id, unitId: unit1Id } });
    await expectCode(
      recordQcpExecution(qcActor, { qcpItemId: item2Id, unitId: unit1Id, result: "ACCEPTED" }),
      ERROR_CODES.CROSS_JOB_ASSIGNMENT,
    );
    const after = await owner.qcpExecution.count({ where: { qcpItemId: item2Id, unitId: unit1Id } });
    expect(after).toBe(before);
  });

  it("a genuine library item (jobId null) is also refused against a real unit", async () => {
    await expectCode(
      recordQcpExecution(qcActor, { qcpItemId: libraryItemId, unitId: unit1Id, result: "ACCEPTED" }),
      ERROR_CODES.CROSS_JOB_ASSIGNMENT,
    );
  });
});

// ── QCP template authoring (C7) ────────────────────────────────────────────

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

describe("qcp.service — library authoring, pure refusals", () => {
  it.each([
    ["SUPERVISOR", ROLES.SUPERVISOR],
    ["QC", ROLES.QC],
    ["MANAGEMENT", ROLES.MANAGEMENT],
  ])("createQcpTemplateLibrary refuses a %s caller", async (_label, role) => {
    const { createQcpTemplateLibrary } = await import("./qcp.service");
    await expectRejects(
      createQcpTemplateLibrary(actor({ roles: [role] }), {
        jobLabel: "X",
        vessel: "Y",
        parties: [{ code: "DESPL" }],
      }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("createQcpTemplateLibrary refuses a client user before touching the DB", async () => {
    const { createQcpTemplateLibrary } = await import("./qcp.service");
    await expectRejects(
      createQcpTemplateLibrary(actor({ clientId: 5, roles: [ROLES.CLIENT_VIEWER] }), {
        jobLabel: "X",
        vessel: "Y",
        parties: [{ code: "DESPL" }],
      }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it.each([
    ["SUPERVISOR", ROLES.SUPERVISOR],
    ["QC", ROLES.QC],
  ])("addQcpItemToLibraryTemplate refuses a %s caller", async (_label, role) => {
    const { addQcpItemToLibraryTemplate } = await import("./qcp.service");
    await expectRejects(
      addQcpItemToLibraryTemplate(actor({ roles: [role] }), {
        qcpTemplateId: 1,
        sequence: 1,
        srNo: "1",
        kind: "CHECKPOINT",
        activity: "Inspect",
        libraryProcessCodes: [],
        partyCodes: [],
      }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("addQcpItemToLibraryTemplate refuses a client user before touching the DB", async () => {
    const { addQcpItemToLibraryTemplate } = await import("./qcp.service");
    await expectRejects(
      addQcpItemToLibraryTemplate(actor({ clientId: 5, roles: [ROLES.CLIENT_VIEWER] }), {
        qcpTemplateId: 1,
        sequence: 1,
        srNo: "1",
        kind: "CHECKPOINT",
        activity: "Inspect",
        libraryProcessCodes: [],
        partyCodes: [],
      }),
      ERROR_CODES.FORBIDDEN,
    );
  });
});

async function expectRejects(p: Promise<unknown>, expected: string): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  const { isAppError } = await import("@/lib/shared/errors");
  expect(isAppError(thrown) && thrown.code).toBe(expected);
}

describe.skipIf(!RUN_DB)("qcp.service — library authoring (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { createQcpTemplateLibrary, addQcpItemToLibraryTemplate } = await import("./qcp.service");
  const { createJob } = await import("./job-intake.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const createdJobIds: number[] = [];
  const createdTemplateIds: number[] = [];

  afterAll(async () => {
    for (const id of createdJobIds) {
      await owner.qcpTemplate.deleteMany({ where: { jobId: id } });
      await owner.equipment.deleteMany({ where: { jobId: id } }).catch(() => {});
      await owner.job.delete({ where: { id } }).catch(() => {});
    }
    for (const id of createdTemplateIds) {
      await owner.qcpTemplate.delete({ where: { id } }).catch(() => {});
    }
    await owner.$disconnect();
  });

  it("authors a from-scratch library template + item, then clones it into a real job, producing a real QcpItemProcess linked to the new job's process coded 12", async () => {
    const template = await createQcpTemplateLibrary(actor(), {
      jobLabel: "C7 library QCP",
      vessel: "Test Vessel",
      parties: [{ code: "DESPL", name: "DESPL QC" }],
    });
    createdTemplateIds.push(template.id);
    expect(template.jobId).toBeNull();

    const item = await addQcpItemToLibraryTemplate(actor(), {
      qcpTemplateId: template.id,
      sequence: 1,
      srNo: "1",
      kind: "CHECKPOINT",
      activity: "Dimensional check",
      libraryProcessCodes: ["12"],
      partyCodes: [{ partyCode: "DESPL", qcpCode: "H" }],
    });
    expect(item.libraryProcessCodes).toEqual(["12"]);

    const stored = await owner.qcpItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.libraryProcessCodes).toEqual(["12"]);
    expect(await owner.qcpItemProcess.count({ where: { qcpItemId: item.id } })).toBe(0);

    const version = await owner.processTemplateVersion.findFirstOrThrow({
      where: { status: "PUBLISHED", template: { family: { code: "PRESSURE_VESSEL" } } },
      orderBy: { version: "desc" },
      include: { template: true },
    });
    const client = await owner.client.findFirstOrThrow({ where: { tenantId: 1 } });

    // PRESSURE_VESSEL also has a PUBLISHED AssemblyTemplateVersion (S17), and
    // createJob unconditionally tries to bind every INSPECTION step to a
    // QcpItem sharing its srNo once ANY qcpTemplateId is cloned in — an
    // orthogonal feature this test must satisfy to reach the QcpItemProcess
    // assertion below, not something libraryProcessCodes changes.
    //
    // materializeAssemblyStepsFromTemplate's occurrence index is counted
    // across EVERY step sharing an srNo (WORK steps included, not just
    // INSPECTION ones) — so the stub QcpItems must be created one-per-step
    // in that same srNo-bearing step order for the indices to line up, even
    // though only the INSPECTION steps ever get resolved against them.
    const asmVersion = await owner.assemblyTemplateVersion.findFirstOrThrow({
      where: { template: { tenantId: 1, familyId: version.template.familyId }, status: "PUBLISHED" },
      orderBy: { version: "desc" },
      include: { steps: { orderBy: { seq: "asc" } } },
    });
    const srNoBearingSteps = asmVersion.steps.filter((s) => s.srNo);
    await owner.qcpItem.createMany({
      data: srNoBearingSteps.map((s, i) => ({
        qcpTemplateId: template.id,
        sequence: 1000 + i,
        srNo: s.srNo!,
        kind: "CHECKPOINT" as const,
        activity: "Assembly inspection stub",
      })),
    });

    const r = await createJob(actor(), {
      clientId: client.id,
      familyId: version.template.familyId,
      templateVersionId: version.id,
      calendarId: null,
      jobNumber: `TEST-C7-QCP-${Date.now()}`,
      clientOrderNo: null,
      projectName: null,
      poRef: null,
      designCode: null,
      orderDate: null,
      committedDeliveryDate: null,
      targetDispatchDate: null,
      priority: "NORMAL",
      remarks: null,
      specs: null,
      excludedProcessCodes: [],
      exclusionReason: null,
      equipments: [{ equipmentTypeId: null, name: "Vessel", blockNo: 1, remarks: null, serials: ["SR01"] }],
      qcpTemplateSourceId: template.id,
      copyBomFromEquipmentId: null,
    });
    createdJobIds.push(r.jobId);
    expect(r.unmatchedQcpProcessCodes).toEqual([]);

    const jobProcess12 = await owner.jobProcess.findFirstOrThrow({ where: { jobId: r.jobId, code: "12" } });
    const clonedTemplate = await owner.qcpTemplate.findFirstOrThrow({ where: { jobId: r.jobId } });
    const clonedItem = await owner.qcpItem.findFirstOrThrow({
      where: { qcpTemplateId: clonedTemplate.id, activity: "Dimensional check" },
    });

    const link = await owner.qcpItemProcess.findUniqueOrThrow({
      where: { qcpItemId_jobProcessId: { qcpItemId: clonedItem.id, jobProcessId: jobProcess12.id } },
    });
    expect(link.jobProcessId).toBe(jobProcess12.id);
  });

  it("refuses to add an item to a job-owned template — authoring is library-only", async () => {
    const jobOwnedTemplate = await owner.qcpTemplate.findFirstOrThrow({ where: { jobId: { not: null } } });
    await expectRejects(
      addQcpItemToLibraryTemplate(actor(), {
        qcpTemplateId: jobOwnedTemplate.id,
        sequence: 999,
        srNo: "999",
        kind: "CHECKPOINT",
        activity: "Should be refused",
        libraryProcessCodes: [],
        partyCodes: [],
      }),
      ERROR_CODES.VALIDATION_FAILED,
    );
  });
});
