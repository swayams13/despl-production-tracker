import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertNcrTransition, NCR_TRANSITIONS, type NcrAction } from "./ncr.service";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { NcrStatus } from "@/generated/prisma/client";

/**
 * Pure transition-matrix tests (no DB), same structure as
 * component.service.test.ts's `assertComponentOpTransition` coverage — every
 * (action, from) pair not explicitly legal must be refused.
 */

const ALL_STATUSES: NcrStatus[] = ["OPEN", "DISPOSITIONED", "REWORK_IN_PROGRESS", "CLOSED"];

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return isAppError(e) ? e.code : "NON_APP_ERROR";
  }
  return undefined;
}

describe("assertNcrTransition", () => {
  const legal: Array<[NcrAction, NcrStatus, NcrStatus]> = [
    ["dispositionRework", "OPEN", "REWORK_IN_PROGRESS"],
    ["dispositionFinal", "OPEN", "DISPOSITIONED"],
    ["close", "OPEN", "CLOSED"],
    ["close", "DISPOSITIONED", "CLOSED"],
    ["close", "REWORK_IN_PROGRESS", "CLOSED"],
  ];

  it.each(legal)("%s from %s → %s", (action, from, to) => {
    expect(assertNcrTransition(action, from)).toBe(to);
  });

  const legalSet = new Set(legal.map(([a, f]) => `${a}:${f}`));
  const actions = Object.keys(NCR_TRANSITIONS) as NcrAction[];
  const illegal: Array<[NcrAction, NcrStatus]> = [];
  for (const a of actions) for (const f of ALL_STATUSES) if (!legalSet.has(`${a}:${f}`)) illegal.push([a, f]);

  it.each(illegal)("%s from %s → INVALID_STATE_TRANSITION", (action, from) => {
    expect(code(() => assertNcrTransition(action, from))).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
  });
});

/**
 * Full locked-transaction path against a live DB, same RUN_DB_TESTS gate and
 * disposable-org-per-run pattern as component.service.test.ts /
 * assembly.service.test.ts. Exercises dispositionNcr's role guard and the
 * cross-tenant refusal through the full rejection → operation → component →
 * equipment → job → tenant chain; the reject-creates-exactly-one-Ncr and
 * verify-closes-Ncr assertions live alongside their existing reject/verify
 * tests in component.service.test.ts / assembly.service.test.ts.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("dispositionNcr (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { dispositionNcr } = await import("./ncr.service");
  const { rejectComponentOperation, startComponentOperation, submitComponentOperation, verifyComponentOperation } =
    await import("./component.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let supA: Actor;
  let qc: Actor;
  let ncrId = 0;
  let opId = 0;

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `TEST-NCR-${Date.now()}`, name: "Ncr svc test" } });
    tenantId = org.id;

    const deptA = await owner.department.create({ data: { tenantId, code: "A", name: "Dept A" } });
    const client = await owner.client.create({ data: { tenantId, name: "Client" } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV template" } });
    const version = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-ncr-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-NCR-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel" } });
    const componentType = await owner.componentTypeRef.create({ data: { tenantId, code: "PLATE", name: "Plate" } });
    const opReceipt = await owner.operationRef.create({
      data: { tenantId, code: "RECEIPT", name: "Receipt", defaultDepartmentId: deptA.id },
    });
    const component = await owner.component.create({
      data: { jobId: job.id, equipmentId: equipment.id, tag: "N1", componentTypeId: componentType.id },
    });
    const op = await owner.componentOperation.create({
      data: { jobId: job.id, componentId: component.id, seq: 1, operationId: opReceipt.id },
    });
    opId = op.id;
    const rejectCategoryId = (await owner.delayCategoryRef.create({ data: { tenantId, code: "REWORK", name: "Rework" } })).id;

    const userSup = await owner.user.create({
      data: { tenantId, email: "ncr-sup@x", username: "ncr-sup", name: "Sup", passwordHash: "x" },
    });
    const userQc = await owner.user.create({
      data: { tenantId, email: "ncr-qc@x", username: "ncr-qc", name: "Qc", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null, mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
    supA = { ...base, userId: userSup.id, name: "Sup", email: "ncr-sup@x", roles: [ROLES.SUPERVISOR, ROLES.QC], departmentIds: [deptA.id] };
    qc = { ...base, userId: userQc.id, name: "Qc", email: "ncr-qc@x", roles: [ROLES.QC], departmentIds: [] };

    await startComponentOperation(supA, { componentOperationId: op.id });
    await submitComponentOperation(supA, { componentOperationId: op.id });
    await rejectComponentOperation(qc, { componentOperationId: op.id, categoryId: rejectCategoryId, detail: "short weld leg" });

    const rejection = await owner.componentOperationRejection.findFirstOrThrow({ where: { componentOperationId: op.id } });
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { componentOperationRejectionId: rejection.id } });
    ncrId = ncr.id;
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  it("non-QC actor is refused", async () => {
    await expectCode(
      dispositionNcr({ ...supA, roles: [ROLES.SUPERVISOR] }, { ncrId, disposition: "REWORK" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("cross-tenant: another tenant's actor cannot reach this Ncr by id (NOT_FOUND)", async () => {
    const otherOrg = await owner.organization.create({ data: { code: `TEST-NCR-XT-${Date.now()}`, name: "Other tenant" } });
    const intruder: Actor = {
      userId: 999_999,
      tenantId: otherOrg.id,
      clientId: null,
      name: "Intruder",
      email: "intruder@other",
      roles: [ROLES.QC],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    await expectCode(dispositionNcr(intruder, { ncrId, disposition: "REWORK" }), ERROR_CODES.NOT_FOUND);
  });

  it("QC assigns REWORK: status → REWORK_IN_PROGRESS, dispositionedBy/At and reworkStartedAt stamped", async () => {
    const disp = await dispositionNcr(qc, { ncrId, disposition: "REWORK", reworkOwnerId: supA.userId });
    expect(disp.status).toBe("REWORK_IN_PROGRESS");
    expect(disp.dispositionedBy).toBe(qc.userId);
    expect(disp.dispositionedAt).toBeInstanceOf(Date);
    expect(disp.reworkStartedAt).toBeInstanceOf(Date);
    expect(disp.reworkOwnerId).toBe(supA.userId);
  });

  it("dispositioning an already-dispositioned Ncr is refused (illegal transition)", async () => {
    await expectCode(dispositionNcr(qc, { ncrId, disposition: "SCRAP" }), ERROR_CODES.INVALID_STATE_TRANSITION);
  });

  it("resubmitting and re-verifying the reworked operation closes the Ncr and records elapsed rework time", async () => {
    // Op is still IN_PROGRESS (reject left it there; dispositionNcr doesn't
    // touch the operation itself, only the Ncr) — resubmit then verify.
    await submitComponentOperation(supA, { componentOperationId: opId });
    const verified = await verifyComponentOperation(qc, { componentOperationId: opId });
    expect(verified.status).toBe("COMPLETE");

    const closed = await owner.ncr.findUniqueOrThrow({ where: { id: ncrId } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedBy).toBe(qc.userId);
    expect(closed.reworkStartedAt).toBeInstanceOf(Date);
    expect(closed.reworkFinishedAt).toBeInstanceOf(Date);
    expect(closed.reworkFinishedAt!.getTime()).toBeGreaterThanOrEqual(closed.reworkStartedAt!.getTime());
  });
});
