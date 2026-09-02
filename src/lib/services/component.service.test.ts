import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertComponentOpTransition,
  COMPONENT_OP_TRANSITIONS,
  type ComponentOperationAction,
} from "./component.service";
import { assertMakerChecker, ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { OperationStatus } from "@/generated/prisma/client";

/**
 * Pure guard tests (run in CI, no DB) pin the transition matrix and the
 * maker–checker guard as component.service.ts composes it, mirroring
 * process.service.test.ts's structure. The full locked-tx path (department
 * scope, sequential-route gate, audit-row-after-every-mutation) needs seeded
 * rows and lives in the RUN_DB_TESTS block below.
 */

const ALL_STATUSES: OperationStatus[] = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "COMPLETE"];

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return isAppError(e) ? e.code : "NON_APP_ERROR";
  }
  return undefined;
}

// ── Transition matrix (invariant: the state machine, not the UI) ────────────

describe("assertComponentOpTransition", () => {
  const legal: Array<[ComponentOperationAction, OperationStatus, OperationStatus]> = [
    ["start", "NOT_STARTED", "IN_PROGRESS"],
    ["submit", "IN_PROGRESS", "SUBMITTED"],
    ["verify", "SUBMITTED", "COMPLETE"],
    ["reject", "SUBMITTED", "IN_PROGRESS"],
  ];

  it.each(legal)("%s from %s → %s", (action, from, to) => {
    expect(assertComponentOpTransition(action, from)).toBe(to);
  });

  // Every (action, from) pair NOT in the legal table must be rejected — e.g.
  // no HOLD state exists for ComponentOperation (#2 scaled down: flat
  // sequence, no HOLD/resume). F5 adds reject: SUBMITTED → IN_PROGRESS only.
  const legalSet = new Set(legal.map(([a, f]) => `${a}:${f}`));
  const actions = Object.keys(COMPONENT_OP_TRANSITIONS) as ComponentOperationAction[];
  const illegal: Array<[ComponentOperationAction, OperationStatus]> = [];
  for (const a of actions)
    for (const f of ALL_STATUSES) if (!legalSet.has(`${a}:${f}`)) illegal.push([a, f]);

  it.each(illegal)("%s from %s → INVALID_STATE_TRANSITION", (action, from) => {
    expect(code(() => assertComponentOpTransition(action, from))).toBe(ERROR_CODES.INVALID_STATE_TRANSITION);
  });
});

// ── Maker–checker as verify composes it (invariant #3) — same guard fn as
// process.service.ts, table-driven the same way ────────────────────────────

describe("verify maker–checker guard", () => {
  const qc = (userId: number): Actor => ({
    userId,
    tenantId: 1,
    clientId: null,
    name: "QC",
    email: "qc@x",
    roles: [ROLES.QC],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
  });
  const supervisorQc = (userId: number): Actor => ({ ...qc(userId), roles: [ROLES.SUPERVISOR, ROLES.QC] });

  const cases: Array<[string, Actor, number | null, string | undefined]> = [
    ["same human submitted and verifies → violation", supervisorQc(7), 7, ERROR_CODES.MAKER_CHECKER_VIOLATION],
    ["different QC user → allowed", qc(8), 7, undefined],
    ["no QC role → forbidden", { ...qc(8), roles: [ROLES.SUPERVISOR] }, 7, ERROR_CODES.FORBIDDEN],
    ["admin is not exempt (no QC role) → forbidden", { ...qc(9), roles: [ROLES.ADMIN] }, 7, ERROR_CODES.FORBIDDEN],
  ];

  it.each(cases)("%s", (_label, actor, submittedBy, expected) => {
    expect(code(() => assertMakerChecker(actor, submittedBy))).toBe(expected);
  });
});

/**
 * Full locked-transaction path against a live DB. Gated off by default; set
 * RUN_DB_TESTS=1 with DIRECT_URL pointing at a migrated database to run it
 * (`pnpm test:db` does this via .env.test → the disposable despl_test DB).
 * Builds its own throwaway job/component/operation fixture rather than
 * DESPL-320's seeded rows, same call as process.service.test.ts's first DB
 * block — table-driven service tests here build their own fixtures.
 *
 * // ponytail: no cleanup — disposable test DB, per-run org code so reruns
 * // don't collide (same pattern as process.service.test.ts).
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("component operation state machine (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const {
    startComponentOperation,
    submitComponentOperation,
    verifyComponentOperation,
    rejectComponentOperation,
    recordPaintRecord,
    recordDftReading,
  } = await import("./component.service");
  const { issueStock } = await import("./stock.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let supA: Actor; // supervisor+QC in deptA (maker)
  let qc: Actor; // QC only, different user (checker)
  let supB: Actor; // supervisor in a DIFFERENT department (wrong-department attempt)
  let clientActor: Actor; // clientId set, roles: [QC] — proves assertNotClientUser does real work
  let opSeq1 = 0; // component A, seq 1 (RECEIPT)
  let opSeq2 = 0; // component A, seq 2 (CUTTING) — gated on opSeq1
  let componentBOpSeq1 = 0; // component B, seq 1 — independent route for cross-component isolation
  // Component C: ComponentOperation.seq assignment order is DELIBERATELY the
  // REVERSE of the canonical RouteStep order (regression fixture for #2 —
  // the gate must key off canonical route position, not raw seq).
  let componentCReceiptOp = 0; // ComponentOperation.seq = 1, canonical RouteStep.seq = 2
  let componentCCuttingOp = 0; // ComponentOperation.seq = 2, canonical RouteStep.seq = 1
  let opDetailTest = 0; // component D, seq 1 — F3/F4 field-persistence test, untouched by anything else
  let rejectCategoryId = 0;
  let welderId = 0;
  // B7 — assertKitReady fixtures (all seq 1, so only the kit-readiness gate is under test).
  let kitShortOp = 0; // bomItem required 10, available 3 → refused
  let kitStockedOp = 0; // bomItem required 2, available 5 → allowed
  let kitUntrackedOp = 0; // Component.bomItemId null (SEAM) → allowed
  let kitNoActivityOp = 0; // bomItem set, zero StockLot rows at all (SEAM) → allowed
  let kitCrossTenantOp = 0; // Component.bomItemId points at another tenant's BomItem → NOT_FOUND
  // Fix wave, Critical #1 regression: a full kit (received === required),
  // issuing part of it to the component the first op starts on must not
  // manufacture a false shortage that then refuses the SAME component's next op.
  let kitIssueRegressionOp1 = 0;
  let kitIssueRegressionOp2 = 0;
  let kitIssueRegressionLotId = 0;
  let kitIssueRegressionComponentId = 0;
  // B9 — assertDrawingReleased fixtures, wired into startComponentOperation's CUTTING-only gate.
  let drawingGatedCuttingOp = 0; // governingDrawingId → a drawing whose current revision is DRAFT → refused
  let drawingReleasedCuttingOp = 0; // governingDrawingId → a drawing whose current revision is RELEASED → allowed, stamps builtToRevisionId
  let drawingReleasedComponentId = 0;
  let drawingReleasedRevisionId = 0;
  let drawingSeamCuttingOp = 0; // governingDrawingId null (SEAM) → allowed, no stamp
  let drawingGatedNonCuttingOp = 0; // RECEIPT (not CUTTING) on a component whose drawing is unreleased → allowed, gate is CUTTING-specific
  // P1 (Phase 5) — Paint/DFT gate fixtures, wired into verifyComponentOperation's PAINTING-only gate.
  let paintOpNoRecord = 0; // SUBMITTED, no PaintRecord/DftReading at all → DFT_NOT_ACCEPTED
  let paintOpTwoCoats = 0; // SUBMITTED, coatsPlanned=2 → walked through none/unaccepted/partial/full accepted coverage
  let paintOpDuplicateCoat = 0; // coatsPlanned=3, all accepted readings on the SAME coatNumber → must still be refused (task review Important #1)

  async function auditCount(entityId: number): Promise<number> {
    return owner.auditLog.count({
      where: { tenantId, entityType: "ComponentOperation", entityId: String(entityId) },
    });
  }

  beforeAll(async () => {
    const org = await owner.organization.create({
      data: { code: `TEST-CO-${Date.now()}`, name: "Component svc test" },
    });
    tenantId = org.id;

    const deptA = await owner.department.create({ data: { tenantId, code: "A", name: "Dept A" } });
    const deptB = await owner.department.create({ data: { tenantId, code: "B", name: "Dept B" } });
    const client = await owner.client.create({ data: { tenantId, name: "Client" } });
    const family = await owner.productFamily.create({
      data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" },
    });
    const template = await owner.processTemplate.create({
      data: { tenantId, familyId: family.id, name: "PV template" },
    });
    const version = await owner.processTemplateVersion.create({
      data: { templateId: template.id, version: 1 },
    });
    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-co-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-CO-${Date.now()}`,
      },
    });
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel" } });
    const componentType = await owner.componentTypeRef.create({
      data: { tenantId, code: "PLATE", name: "Plate" },
    });

    const opReceipt = await owner.operationRef.create({
      data: { tenantId, code: "RECEIPT", name: "Receipt", defaultDepartmentId: deptA.id },
    });
    const opCutting = await owner.operationRef.create({
      data: { tenantId, code: "CUTTING", name: "Cutting", defaultDepartmentId: deptA.id },
    });

    const componentA = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "N1", componentTypeId: componentType.id },
    });
    const componentB = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "N2", componentTypeId: componentType.id },
    });

    opSeq1 = (
      await owner.componentOperation.create({
        data: { componentId: componentA.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    opSeq2 = (
      await owner.componentOperation.create({
        data: { componentId: componentA.id, seq: 2, operationId: opCutting.id },
      })
    ).id;
    componentBOpSeq1 = (
      await owner.componentOperation.create({
        data: { componentId: componentB.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    // Canonical route: CUTTING (RouteStep.seq 1) then RECEIPT (RouteStep.seq 2)
    // — the reverse of componentA/B's natural op order — so component C's
    // ComponentOperation.seq assignment (RECEIPT=1, CUTTING=2, CSV-column
    // order) diverges from canonical route order on purpose.
    const routeTemplate = await owner.routeTemplate.create({
      data: { tenantId, componentTypeId: componentType.id, name: "Reversed route" },
    });
    const routeVersion = await owner.routeTemplateVersion.create({
      data: { routeId: routeTemplate.id, version: 1 },
    });
    await owner.routeStep.create({ data: { routeVersionId: routeVersion.id, seq: 1, operationId: opCutting.id } });
    await owner.routeStep.create({ data: { routeVersionId: routeVersion.id, seq: 2, operationId: opReceipt.id } });
    const componentC = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "N3", componentTypeId: componentType.id, routeVersionId: routeVersion.id },
    });
    componentCReceiptOp = (
      await owner.componentOperation.create({
        data: { componentId: componentC.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    componentCCuttingOp = (
      await owner.componentOperation.create({
        data: { componentId: componentC.id, seq: 2, operationId: opCutting.id },
      })
    ).id;

    const componentD = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "N4", componentTypeId: componentType.id },
    });
    opDetailTest = (
      await owner.componentOperation.create({
        data: { componentId: componentD.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    rejectCategoryId = (
      await owner.delayCategoryRef.create({ data: { tenantId, code: "REWORK", name: "Rework" } })
    ).id;
    welderId = (
      await owner.welder.create({ data: { tenantId, name: "Welder One", employeeCode: `W-${Date.now()}` } })
    ).id;

    // B7 — assertKitReady fixtures. explodeBomItem's `required` is
    // qtyPer * unitCount, so this equipment needs exactly one Unit row (no
    // other test above depends on unitCount, so adding it here is safe).
    await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "KIT-1" } });

    const bomItemShort = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 1, partName: "Gasket, Short", sourceQty: "10 NOS.", qtyPer: 10, uom: "NOS." },
    });
    await owner.stockLot.create({ data: { bomItemId: bomItemShort.id, location: "Yard A", qty: 3 } });

    const bomItemStocked = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 2, partName: "Gasket, Stocked", sourceQty: "2 NOS.", qtyPer: 2, uom: "NOS." },
    });
    await owner.stockLot.create({ data: { bomItemId: bomItemStocked.id, location: "Yard A", qty: 5 } });

    // Zero StockLot rows for this item at all — the SEAM case ("never
    // tracked" vs "tracked but 0 available"), distinct from bomItemShort.
    const bomItemNoActivity = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 3, partName: "Gasket, Untracked", sourceQty: "5 NOS.", qtyPer: 5, uom: "NOS." },
    });

    const componentKitShort = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "KIT-SHORT", componentTypeId: componentType.id, bomItemId: bomItemShort.id },
    });
    kitShortOp = (
      await owner.componentOperation.create({
        data: { componentId: componentKitShort.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    const componentKitStocked = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "KIT-STOCKED", componentTypeId: componentType.id, bomItemId: bomItemStocked.id },
    });
    kitStockedOp = (
      await owner.componentOperation.create({
        data: { componentId: componentKitStocked.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    const componentKitUntracked = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "KIT-UNTRACKED", componentTypeId: componentType.id },
    });
    kitUntrackedOp = (
      await owner.componentOperation.create({
        data: { componentId: componentKitUntracked.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    const componentKitNoActivity = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "KIT-NOACT", componentTypeId: componentType.id, bomItemId: bomItemNoActivity.id },
    });
    kitNoActivityOp = (
      await owner.componentOperation.create({
        data: { componentId: componentKitNoActivity.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    // Cross-tenant BomItem: a Component in THIS tenant with bomItemId pointing
    // at a BomItem that belongs to a different tenant's equipment/job — not
    // reachable through the app's own writes, but assertKitReady's own
    // tenant-scoped lookup must still refuse it (same discipline as Dispatch
    // 4's requiredQty/availableQty/shortage fix).
    const otherOrg = await owner.organization.create({
      data: { code: `TEST-CO-KITXT-${Date.now()}`, name: "Other tenant (kit)" },
    });
    const otherClient = await owner.client.create({ data: { tenantId: otherOrg.id, name: "Other Client" } });
    const otherTemplate = await owner.processTemplate.create({
      data: { tenantId: otherOrg.id, familyId: family.id, name: "Other PV template" },
    });
    const otherVersion = await owner.processTemplateVersion.create({
      data: { templateId: otherTemplate.id, version: 1 },
    });
    const otherJob = await owner.job.create({
      data: {
        tenantId: otherOrg.id,
        publicId: `pub-co-kitxt-${Date.now()}`,
        clientId: otherClient.id,
        familyId: family.id,
        templateVersionId: otherVersion.id,
        jobNumber: `JOB-CO-KITXT-${Date.now()}`,
      },
    });
    const otherEquipment = await owner.equipment.create({ data: { jobId: otherJob.id, name: "Other Vessel" } });
    const otherBomItem = await owner.bomItem.create({
      data: { equipmentId: otherEquipment.id, itemNo: 1, partName: "Other tenant's part", sourceQty: "1 NOS.", qtyPer: 1, uom: "NOS." },
    });
    const componentKitCrossTenant = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "KIT-XT", componentTypeId: componentType.id, bomItemId: otherBomItem.id },
    });
    kitCrossTenantOp = (
      await owner.componentOperation.create({
        data: { componentId: componentKitCrossTenant.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    // Fix wave, Critical #1 regression fixture: a full kit (required 9 ===
    // received 9), two ops on the SAME component, so issuing material after
    // op1 starts can be checked against op2's start on that very component.
    const bomItemIssueRegression = await owner.bomItem.create({
      data: { equipmentId: equipment.id, itemNo: 4, partName: "Gasket, Full Kit", sourceQty: "9 NOS.", qtyPer: 9, uom: "NOS." },
    });
    const issueRegressionLot = await owner.stockLot.create({
      data: { bomItemId: bomItemIssueRegression.id, location: "Yard A", qty: 9 },
    });
    kitIssueRegressionLotId = issueRegressionLot.id;
    const componentIssueRegression = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "KIT-ISSUE-REGRESSION", componentTypeId: componentType.id, bomItemId: bomItemIssueRegression.id },
    });
    kitIssueRegressionComponentId = componentIssueRegression.id;
    kitIssueRegressionOp1 = (
      await owner.componentOperation.create({
        data: { componentId: componentIssueRegression.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    kitIssueRegressionOp2 = (
      await owner.componentOperation.create({
        data: { componentId: componentIssueRegression.id, seq: 2, operationId: opCutting.id },
      })
    ).id;

    // B9 — assertDrawingReleased fixtures.
    const drawingType = await owner.drawingTypeRef.create({
      data: { tenantId, code: "GA", name: "General Arrangement" },
    });
    const drawingDraft = await owner.assemblyDrawing.create({
      data: { jobId: job.id, drawingTypeId: drawingType.id, drawingNo: "GA-1" },
    });
    await owner.drawingRevision.create({
      data: { assemblyDrawingId: drawingDraft.id, revisionNo: 1, status: "DRAFT" },
    });
    const drawingReleased = await owner.assemblyDrawing.create({
      data: { jobId: job.id, drawingTypeId: drawingType.id, drawingNo: "GA-2" },
    });
    drawingReleasedRevisionId = (
      await owner.drawingRevision.create({
        data: { assemblyDrawingId: drawingReleased.id, revisionNo: 1, status: "RELEASED", releasedAt: new Date() },
      })
    ).id;

    const componentDrawingGated = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "DWG-GATED", componentTypeId: componentType.id, governingDrawingId: drawingDraft.id },
    });
    drawingGatedCuttingOp = (
      await owner.componentOperation.create({
        data: { componentId: componentDrawingGated.id, seq: 1, operationId: opCutting.id },
      })
    ).id;

    const componentDrawingReleased = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "DWG-RELEASED", componentTypeId: componentType.id, governingDrawingId: drawingReleased.id },
    });
    drawingReleasedComponentId = componentDrawingReleased.id;
    drawingReleasedCuttingOp = (
      await owner.componentOperation.create({
        data: { componentId: componentDrawingReleased.id, seq: 1, operationId: opCutting.id },
      })
    ).id;

    const componentDrawingSeam = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "DWG-SEAM", componentTypeId: componentType.id }, // governingDrawingId left null
    });
    drawingSeamCuttingOp = (
      await owner.componentOperation.create({
        data: { componentId: componentDrawingSeam.id, seq: 1, operationId: opCutting.id },
      })
    ).id;

    const componentDrawingGatedNonCutting = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "DWG-GATED-RECEIPT", componentTypeId: componentType.id, governingDrawingId: drawingDraft.id },
    });
    drawingGatedNonCuttingOp = (
      await owner.componentOperation.create({
        data: { componentId: componentDrawingGatedNonCutting.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    // P1 (Phase 5) — Paint/DFT gate fixtures.
    const opPainting = await owner.operationRef.create({
      data: { tenantId, code: "PAINTING", name: "Painting", defaultDepartmentId: deptA.id },
    });
    const componentPaintNoRecord = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "PAINT-NO-RECORD", componentTypeId: componentType.id },
    });
    paintOpNoRecord = (
      await owner.componentOperation.create({
        data: { componentId: componentPaintNoRecord.id, seq: 1, operationId: opPainting.id },
      })
    ).id;
    const componentPaintTwoCoats = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "PAINT-TWO-COATS", componentTypeId: componentType.id },
    });
    paintOpTwoCoats = (
      await owner.componentOperation.create({
        data: { componentId: componentPaintTwoCoats.id, seq: 1, operationId: opPainting.id },
      })
    ).id;
    const componentPaintDuplicateCoat = await owner.component.create({
      data: { equipmentId: equipment.id, tag: "PAINT-DUP-COAT", componentTypeId: componentType.id },
    });
    paintOpDuplicateCoat = (
      await owner.componentOperation.create({
        data: { componentId: componentPaintDuplicateCoat.id, seq: 1, operationId: opPainting.id },
      })
    ).id;

    const userSup = await owner.user.create({
      data: { tenantId, email: "co-sup@x", username: "co-sup", name: "Sup", passwordHash: "x" },
    });
    const userQc = await owner.user.create({
      data: { tenantId, email: "co-qc@x", username: "co-qc", name: "Qc", passwordHash: "x" },
    });
    const userSupB = await owner.user.create({
      data: { tenantId, email: "co-supb@x", username: "co-supb", name: "SupB", passwordHash: "x" },
    });
    const base = { tenantId, clientId: null, mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
    supA = { ...base, userId: userSup.id, name: "Sup", email: "co-sup@x", roles: [ROLES.SUPERVISOR, ROLES.QC], departmentIds: [deptA.id] };
    qc = { ...base, userId: userQc.id, name: "Qc", email: "co-qc@x", roles: [ROLES.QC], departmentIds: [] };
    supB = { ...base, userId: userSupB.id, name: "SupB", email: "co-supb@x", roles: [ROLES.SUPERVISOR], departmentIds: [deptB.id] };
    // roles: [QC] so the ONLY thing that can throw FORBIDDEN on verify is
    // assertNotClientUser — mirrors qcp.service.test.ts's client-user case.
    clientActor = { ...base, userId: userQc.id, clientId: 1, name: "Client", email: "co-client@x", roles: [ROLES.QC], departmentIds: [] };
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

  it("out-of-order start: seq 2 cannot start before seq 1 on the same component (#2)", async () => {
    await expectCode(startComponentOperation(supA, { componentOperationId: opSeq2 }), ERROR_CODES.GATING_BLOCKED);
  });

  it("gate uses canonical route position, not raw ComponentOperation.seq (#2 regression): the op that's canonically FIRST starts immediately even though its ComponentOperation.seq is 2", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: componentCCuttingOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("gate uses canonical route position, not raw ComponentOperation.seq (#2 regression): the op that's canonically SECOND is blocked on its canonical predecessor, even though its ComponentOperation.seq is 1 (naive seq-1 gating would wrongly allow it immediately)", async () => {
    await expectCode(
      startComponentOperation(supA, { componentOperationId: componentCReceiptOp }),
      ERROR_CODES.GATING_BLOCKED,
    );
    // Clears once the canonical predecessor (CUTTING, seq 2 in the DB) completes.
    await submitComponentOperation(supA, { componentOperationId: componentCCuttingOp });
    await verifyComponentOperation(qc, { componentOperationId: componentCCuttingOp });
    const started = await startComponentOperation(supA, { componentOperationId: componentCReceiptOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("wrong department: a supervisor outside the operation's department cannot start it", async () => {
    await expectCode(startComponentOperation(supB, { componentOperationId: opSeq1 }), ERROR_CODES.FORBIDDEN);
  });

  it("client user cannot start or submit — read-only, no exceptions (#1 access rule)", async () => {
    await expectCode(startComponentOperation(clientActor, { componentOperationId: opSeq1 }), ERROR_CODES.FORBIDDEN);
  });

  it("happy path start → submit → verify, one audit row per mutation", async () => {
    const before = await auditCount(opSeq1);

    const started = await startComponentOperation(supA, { componentOperationId: opSeq1 });
    expect(started.status).toBe("IN_PROGRESS");
    expect(started.startedAt).toBeInstanceOf(Date);
    expect(await auditCount(opSeq1)).toBe(before + 1);

    const submitted = await submitComponentOperation(supA, { componentOperationId: opSeq1 });
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedBy).toBe(supA.userId);
    expect(await auditCount(opSeq1)).toBe(before + 2);

    const verified = await verifyComponentOperation(qc, { componentOperationId: opSeq1 });
    expect(verified.status).toBe("COMPLETE");
    expect(verified.finishedAt).toBeInstanceOf(Date);
    expect(verified.verifiedBy).toBe(qc.userId);
    expect(await auditCount(opSeq1)).toBe(before + 3);
  });

  it("cross-component isolation: completing component A's seq 1 never unblocks component B's seq 1", async () => {
    // component B's own seq 1 (never touched) must still be NOT_STARTED — a
    // real transition works regardless of what happened on component A.
    const started = await startComponentOperation(supA, { componentOperationId: componentBOpSeq1 });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("sequential gate now clears: seq 2 starts once seq 1 (same component) is COMPLETE", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: opSeq2 });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("maker–checker: the submitter cannot verify their own submission", async () => {
    await submitComponentOperation(supA, { componentOperationId: opSeq2 }); // submittedBy = supA
    await expectCode(
      verifyComponentOperation(supA, { componentOperationId: opSeq2 }),
      ERROR_CODES.MAKER_CHECKER_VIOLATION,
    );
    const verified = await verifyComponentOperation(qc, { componentOperationId: opSeq2 });
    expect(verified.status).toBe("COMPLETE");
  });

  it("illegal transition: verifying a NOT_STARTED operation is refused", async () => {
    await expectCode(
      verifyComponentOperation(qc, { componentOperationId: componentBOpSeq1 }),
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });

  it("client user cannot verify either, even holding the QC role (#1, no admin/role exception)", async () => {
    await submitComponentOperation(supA, { componentOperationId: componentBOpSeq1 });
    await expectCode(
      verifyComponentOperation(clientActor, { componentOperationId: componentBOpSeq1 }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("cross-tenant: another tenant's actor cannot reach this operation by id (NOT_FOUND)", async () => {
    const otherOrg = await owner.organization.create({
      data: { code: `TEST-CO-XT-${Date.now()}`, name: "Other tenant" },
    });
    const intruder: Actor = {
      userId: 999_999,
      tenantId: otherOrg.id,
      clientId: null,
      name: "Intruder",
      email: "intruder@other",
      roles: [ROLES.SUPERVISOR, ROLES.QC],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    const statusBefore = (await owner.componentOperation.findUniqueOrThrow({ where: { id: opSeq2 } })).status;

    await expectCode(startComponentOperation(intruder, { componentOperationId: opSeq2 }), ERROR_CODES.NOT_FOUND);
    await expectCode(submitComponentOperation(intruder, { componentOperationId: opSeq2 }), ERROR_CODES.NOT_FOUND);
    await expectCode(verifyComponentOperation(intruder, { componentOperationId: opSeq2 }), ERROR_CODES.NOT_FOUND);

    const after = await owner.componentOperation.findUniqueOrThrow({ where: { id: opSeq2 } });
    expect(after.status).toBe(statusBefore);
  });

  it("submit persists F3/F4 detail fields (operator, remarks, quantities)", async () => {
    await startComponentOperation(supA, { componentOperationId: opDetailTest });
    const submitted = await submitComponentOperation(supA, {
      componentOperationId: opDetailTest,
      performedByWelderId: welderId,
      performedByUserId: qc.userId,
      remarks: "18 of 24 gussets welded",
      qtyPlanned: 24,
      qtyGood: 18,
      qtyRejected: 0,
    });
    expect(submitted.performedByWelderId).toBe(welderId);
    expect(submitted.performedByUserId).toBe(qc.userId);
    expect(submitted.remarks).toBe("18 of 24 gussets welded");
    expect(submitted.qtyPlanned).toBe(24);
    expect(submitted.qtyGood).toBe(18);
    expect(submitted.qtyRejected).toBe(0);
  });

  it("N1 regression (task review Critical #1): reject → resubmit → reject again leaves TWO open Ncrs, and a single verify closes BOTH", async () => {
    // opDetailTest is SUBMITTED (submittedBy = supA) from the F3/F4 test above.
    await rejectComponentOperation(qc, { componentOperationId: opDetailTest, categoryId: rejectCategoryId, detail: "first reject" });
    await submitComponentOperation(supA, { componentOperationId: opDetailTest });
    await rejectComponentOperation(qc, { componentOperationId: opDetailTest, categoryId: rejectCategoryId, detail: "second reject" });
    await submitComponentOperation(supA, { componentOperationId: opDetailTest });

    const openBefore = await owner.ncr.findMany({
      where: { status: { not: "CLOSED" }, componentOperationRejection: { componentOperationId: opDetailTest } },
    });
    expect(openBefore).toHaveLength(2);

    const verified = await verifyComponentOperation(qc, { componentOperationId: opDetailTest });
    expect(verified.status).toBe("COMPLETE");

    const stillOpen = await owner.ncr.findMany({
      where: { status: { not: "CLOSED" }, componentOperationRejection: { componentOperationId: opDetailTest } },
    });
    expect(stillOpen).toHaveLength(0);
    const nowClosed = await owner.ncr.findMany({
      where: { id: { in: openBefore.map((n) => n.id) } },
    });
    expect(nowClosed.every((n) => n.status === "CLOSED")).toBe(true);
  });

  // F5 — reuses componentBOpSeq1, which the "client user cannot verify"
  // test above left SUBMITTED with submittedBy = supA.userId.
  it("F5 maker–checker: the submitter cannot reject their own submission", async () => {
    await expectCode(
      rejectComponentOperation(supA, { componentOperationId: componentBOpSeq1, categoryId: rejectCategoryId }),
      ERROR_CODES.MAKER_CHECKER_VIOLATION,
    );
  });

  it("F5: QC reject returns a SUBMITTED op to IN_PROGRESS, clears submittedBy, and retains the rejection", async () => {
    const rejected = await rejectComponentOperation(qc, {
      componentOperationId: componentBOpSeq1,
      categoryId: rejectCategoryId,
      detail: "PAUT indication",
    });
    expect(rejected.status).toBe("IN_PROGRESS");
    expect(rejected.submittedBy).toBeNull();

    const rejections = await owner.componentOperationRejection.findMany({
      where: { componentOperationId: componentBOpSeq1 },
    });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ categoryId: rejectCategoryId, detail: "PAUT indication", rejectedBy: qc.userId });

    // N1 (Phase 5): reject opens exactly one Ncr, linked to that rejection.
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { componentOperationRejectionId: rejections[0].id } });
    expect(ncr.status).toBe("OPEN");

    // Rejected work restarts from the SAME step (F-e default, spec §4) — it
    // must be resubmittable, not stuck.
    const resubmitted = await submitComponentOperation(supA, { componentOperationId: componentBOpSeq1 });
    expect(resubmitted.status).toBe("SUBMITTED");

    // N1: re-verifying closes the open Ncr and stamps reworkFinishedAt (the
    // dispositionNcr(REWORK) path already stamped reworkStartedAt — covered
    // in ncr.service.test.ts; here the Ncr is still just OPEN, so verify
    // closes it directly with no rework interval to record).
    const verified = await verifyComponentOperation(qc, { componentOperationId: componentBOpSeq1 });
    expect(verified.status).toBe("COMPLETE");
    const closed = await owner.ncr.findUniqueOrThrow({ where: { id: ncr.id } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedBy).toBe(qc.userId);
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it("F5: rejecting a non-SUBMITTED op is refused (illegal transition)", async () => {
    // opSeq1 is COMPLETE by this point (the "happy path" test above); actor
    // is a different QC user so this exercises the transition guard, not
    // maker–checker.
    await expectCode(
      rejectComponentOperation(qc, { componentOperationId: opSeq1, categoryId: rejectCategoryId }),
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });

  // ── B7: assertKitReady, wired into startComponentOperation's 4th gate ────

  it("kit gate: a component whose BomItem is recorded short is refused, naming the part (violation case 1)", async () => {
    await expectCode(
      startComponentOperation(supA, { componentOperationId: kitShortOp }),
      ERROR_CODES.MATERIAL_NOT_AVAILABLE,
    );
  });

  it("kit gate: a component whose BomItem has adequate stock (available >= required) starts normally (violation case 2)", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: kitStockedOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("kit gate SEAM: Component.bomItemId null starts unaffected — no BOM link, nothing to check (violation case 3)", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: kitUntrackedOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("kit gate SEAM: BomItem set but zero StockLot/StockTxn rows recorded at all starts unaffected — 'never tracked' is not 'zero available' (violation case 4, the highest-risk regression)", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: kitNoActivityOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("kit gate cross-tenant: a Component.bomItemId pointing at another tenant's BomItem is refused as NOT_FOUND, not read across (violation case 5)", async () => {
    await expectCode(startComponentOperation(supA, { componentOperationId: kitCrossTenantOp }), ERROR_CODES.NOT_FOUND);
  });

  it("kit gate regression (fix wave Critical #1): issuing material to a component after starting its first operation does not manufacture a false shortage for its NEXT operation on that same component", async () => {
    // Full kit received (qty 9 === required 9): first op starts clean.
    const started1 = await startComponentOperation(supA, { componentOperationId: kitIssueRegressionOp1 });
    expect(started1.status).toBe("IN_PROGRESS");

    // Issue 1 unit's worth of material to that component — the normal,
    // correct action. Before the fix, ISSUE decremented the shortage-relevant
    // `available`, manufacturing a shortage that then refused EVERY
    // subsequent start on any component linked to this BomItem — including
    // this very component's next operation.
    const ph: Actor = { ...supA, roles: [ROLES.PRODUCTION_HEAD] };
    await issueStock(ph, { stockLotId: kitIssueRegressionLotId, qty: 1, componentId: kitIssueRegressionComponentId });

    // Route gate: op2 needs op1 COMPLETE first.
    await submitComponentOperation(supA, { componentOperationId: kitIssueRegressionOp1 });
    await verifyComponentOperation(qc, { componentOperationId: kitIssueRegressionOp1 });

    const started2 = await startComponentOperation(supA, { componentOperationId: kitIssueRegressionOp2 });
    expect(started2.status).toBe("IN_PROGRESS");
  });

  // ── B9: assertDrawingReleased, wired into startComponentOperation's CUTTING-only gate ────

  it("drawing gate: CUTTING is refused when the governing drawing's current revision isn't RELEASED (violation case 1)", async () => {
    await expectCode(
      startComponentOperation(supA, { componentOperationId: drawingGatedCuttingOp }),
      ERROR_CODES.DRAWING_NOT_RELEASED,
    );
  });

  it("drawing gate: CUTTING succeeds and stamps Component.builtToRevisionId when the current revision is RELEASED (violation case 2)", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: drawingReleasedCuttingOp });
    expect(started.status).toBe("IN_PROGRESS");

    const component = await owner.component.findUniqueOrThrow({ where: { id: drawingReleasedComponentId } });
    expect(component.builtToRevisionId).toBe(drawingReleasedRevisionId);
  });

  it("drawing gate SEAM: Component.governingDrawingId null starts unaffected — no drawing link, nothing to check (violation case 3)", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: drawingSeamCuttingOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("drawing gate is CUTTING-specific: a non-CUTTING operation (RECEIPT) on a component with an unreleased governing drawing is NOT blocked (violation case 4)", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: drawingGatedNonCuttingOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  // ── P1 (Phase 5): recordPaintRecord/recordDftReading + the PAINTING verify gate ────

  it("DFT gate: verifying a PAINTING op with no PaintRecord/DftReading at all is refused (violation case 1)", async () => {
    await startComponentOperation(supA, { componentOperationId: paintOpNoRecord });
    await submitComponentOperation(supA, { componentOperationId: paintOpNoRecord });
    await expectCode(verifyComponentOperation(qc, { componentOperationId: paintOpNoRecord }), ERROR_CODES.DFT_NOT_ACCEPTED);
  });

  it("DFT gate: PaintRecord + readings recorded but none accepted is still refused (violation case 2)", async () => {
    await recordPaintRecord(supA, { componentOperationId: paintOpNoRecord, coatingSystem: "Epoxy zinc-rich" });
    await recordDftReading(supA, { componentOperationId: paintOpNoRecord, readingMicrons: 40, accepted: false });
    await expectCode(verifyComponentOperation(qc, { componentOperationId: paintOpNoRecord }), ERROR_CODES.DFT_NOT_ACCEPTED);
  });

  it("DFT gate: one accepted reading satisfies the default (coatsPlanned unset → 1 required) and verify succeeds", async () => {
    await recordDftReading(supA, { componentOperationId: paintOpNoRecord, readingMicrons: 85, accepted: true });
    const verified = await verifyComponentOperation(qc, { componentOperationId: paintOpNoRecord });
    expect(verified.status).toBe("COMPLETE");
  });

  it("DFT gate: coatsPlanned=2 needs two accepted readings — fewer than planned is refused (violation case 3), satisfied once the second is recorded (success case)", async () => {
    await startComponentOperation(supA, { componentOperationId: paintOpTwoCoats });
    await submitComponentOperation(supA, { componentOperationId: paintOpTwoCoats });
    await recordPaintRecord(supA, { componentOperationId: paintOpTwoCoats, coatingSystem: "Polyurethane topcoat", coatsPlanned: 2 });

    await expectCode(verifyComponentOperation(qc, { componentOperationId: paintOpTwoCoats }), ERROR_CODES.DFT_NOT_ACCEPTED);

    await recordDftReading(supA, { componentOperationId: paintOpTwoCoats, coatNumber: 1, readingMicrons: 75, accepted: true });
    await expectCode(verifyComponentOperation(qc, { componentOperationId: paintOpTwoCoats }), ERROR_CODES.DFT_NOT_ACCEPTED);

    await recordDftReading(supA, { componentOperationId: paintOpTwoCoats, coatNumber: 2, readingMicrons: 80, accepted: true });
    const verified = await verifyComponentOperation(qc, { componentOperationId: paintOpTwoCoats });
    expect(verified.status).toBe("COMPLETE");
  });

  it("DFT gate regression (task review Important #1): coatsPlanned=3 accepted readings all recorded against the SAME coatNumber is still refused — coverage is per DISTINCT coat, not a raw accepted-row count", async () => {
    await startComponentOperation(supA, { componentOperationId: paintOpDuplicateCoat });
    await submitComponentOperation(supA, { componentOperationId: paintOpDuplicateCoat });
    await recordPaintRecord(supA, { componentOperationId: paintOpDuplicateCoat, coatingSystem: "Epoxy", coatsPlanned: 3 });

    // Three accepted readings, all coatNumber: 1 — a naive COUNT(*) would
    // wrongly satisfy coatsPlanned: 3 here.
    await recordDftReading(supA, { componentOperationId: paintOpDuplicateCoat, coatNumber: 1, readingMicrons: 70, accepted: true });
    await recordDftReading(supA, { componentOperationId: paintOpDuplicateCoat, coatNumber: 1, readingMicrons: 72, accepted: true });
    await recordDftReading(supA, { componentOperationId: paintOpDuplicateCoat, coatNumber: 1, readingMicrons: 74, accepted: true });
    await expectCode(verifyComponentOperation(qc, { componentOperationId: paintOpDuplicateCoat }), ERROR_CODES.DFT_NOT_ACCEPTED);

    // Covering coats 2 and 3 too clears the gate.
    await recordDftReading(supA, { componentOperationId: paintOpDuplicateCoat, coatNumber: 2, readingMicrons: 71, accepted: true });
    await recordDftReading(supA, { componentOperationId: paintOpDuplicateCoat, coatNumber: 3, readingMicrons: 73, accepted: true });
    const verified = await verifyComponentOperation(qc, { componentOperationId: paintOpDuplicateCoat });
    expect(verified.status).toBe("COMPLETE");
  });

  it("recordDftReading is tenant-anchored: another tenant's actor cannot attach a reading to this operation by id (NOT_FOUND)", async () => {
    const otherOrg = await owner.organization.create({
      data: { code: `TEST-CO-PAINT-XT-${Date.now()}`, name: "Other tenant (paint)" },
    });
    const intruder: Actor = {
      userId: 999_998,
      tenantId: otherOrg.id,
      clientId: null,
      name: "Intruder",
      email: "intruder-paint@other",
      roles: [ROLES.SUPERVISOR, ROLES.QC],
      departmentIds: [],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };
    await expectCode(
      recordDftReading(intruder, { componentOperationId: paintOpTwoCoats, readingMicrons: 999, accepted: true }),
      ERROR_CODES.NOT_FOUND,
    );
    await expectCode(
      recordPaintRecord(intruder, { componentOperationId: paintOpTwoCoats, coatingSystem: "Should not land" }),
      ERROR_CODES.NOT_FOUND,
    );
    const readingCount = await owner.dftReading.count({ where: { componentOperationId: paintOpTwoCoats } });
    expect(readingCount).toBe(2); // only the two legitimate readings from the previous test
  });
});
