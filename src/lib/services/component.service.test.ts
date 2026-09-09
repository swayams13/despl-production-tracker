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
    linkGoverningDrawing,
  } = await import("./component.service");
  const { issueStock } = await import("./stock.service");
  const { dispositionNcr, closeNcr } = await import("./ncr.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let jobId = 0;
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
  let kitNoActivityOp = 0; // bomItem set, zero StockLot rows at all → refused (S18: no longer a SEAM)
  let kitCrossTenantOp = 0; // Component.bomItemId points at another tenant's BomItem → NOT_FOUND
  // H1 — job-level RLS backstop: Component.bomItemId pointing at a BomItem in
  // a DIFFERENT job of the SAME tenant (not reachable via app writes, same
  // discipline as kitCrossTenantOp but one door down: assertKitReady's
  // BomItem lookup is only ever tenant-scoped, never job-scoped in code —
  // job_isolation RLS is the only thing that can catch this).
  let kitCrossJobOp = 0;
  // Fix wave, Critical #1 regression, superseded by AUD-032 (see the test
  // itself): a full kit (received === required for ONE unit) — issuing part
  // of it against the SAME component's next op now IS reflected as reduced
  // availability, on purpose (AUD-032's whole point is that ISSUE must move
  // this number or the gate is toothless forever after the first pass).
  let kitIssueRegressionOp1 = 0;
  let kitIssueRegressionOp2 = 0;
  let kitIssueRegressionLotId = 0;
  let kitIssueRegressionComponentId = 0;
  // AUD-032 regression fixtures.
  let kitMultiUnitOp = 0; // 4-Unit equipment, BomItem stocked for ONE unit's worth but not all four → succeeds (no longer demands the whole equipment's kit)
  let kitConsumedOp = 0; // BomItem received enough once, but since fully ISSUEd → refused (the gate must not stay toothless forever)
  // B9 — assertDrawingReleased fixtures, wired into startComponentOperation's CUTTING-only gate.
  let drawingGatedCuttingOp = 0; // governingDrawingId → a drawing whose current revision is DRAFT → refused
  let drawingReleasedCuttingOp = 0; // governingDrawingId → a drawing whose current revision is RELEASED → allowed, stamps builtToRevisionId
  let drawingReleasedComponentId = 0;
  let drawingReleasedRevisionId = 0;
  let drawingSeamCuttingOp = 0; // governingDrawingId null (SEAM) → allowed, no stamp
  let drawingGatedNonCuttingOp = 0; // RECEIPT (not CUTTING) on a component whose drawing is unreleased → allowed, gate is CUTTING-specific
  // H1 — governingDrawingId pointed (directly, bypassing linkGoverningDrawing)
  // at a DIFFERENT job's RELEASED drawing → assertDrawingReleased must still refuse.
  let drawingCrossJobCuttingOp = 0;
  // S18 — linkGoverningDrawing fixtures.
  let linkComponentId = 0; // fresh Component, governingDrawingId starts null
  let linkDrawingId = 0; // AssemblyDrawing belonging to the same job
  let linkOtherJobDrawingId = 0; // AssemblyDrawing belonging to a DIFFERENT job — cross-job refusal
  // P1 (Phase 5) — Paint/DFT gate fixtures, wired into verifyComponentOperation's PAINTING-only gate.
  let paintOpNoRecord = 0; // SUBMITTED, no PaintRecord/DftReading at all → DFT_NOT_ACCEPTED
  let paintOpTwoCoats = 0; // SUBMITTED, coatsPlanned=2 → walked through none/unaccepted/partial/full accepted coverage
  let paintOpDuplicateCoat = 0; // coatsPlanned=3, all accepted readings on the SAME coatNumber → must still be refused (task review Important #1)
  // B6 — the gate is OperationRef.requiresDftGate now, not the "PAINTING" code string.
  let unflaggedPaintingCodeOp = 0; // code "PAINTING", requiresDftGate: false → must verify with no PaintRecord (proves the code string itself no longer gates)
  let flaggedNonPaintingCodeOp = 0; // code "GALVANIZING", requiresDftGate: true, no PaintRecord → must be refused (proves the flag, not the code, gates)
  let opPaintingId = 0; // the real "PAINTING" OperationRef's id — AUD-029 regression test flips its flag off/on around one test, mirroring the migration
  // AUD-026 — dispositionNcr gate fixtures (each its own component; RECEIPT op, no other gates).
  let ncrGateNeverDispositionedOp = 0;
  let ncrGateDispositionedOp = 0;
  let ncrGateTwoNcrsOp = 0;
  let ncrGateDirectCloseOp = 0;
  let ncrGateNoNcrOp = 0;

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
    jobId = job.id;
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
      data: { jobId, equipmentId: equipment.id, tag: "N1", componentTypeId: componentType.id },
    });
    const componentB = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "N2", componentTypeId: componentType.id },
    });

    opSeq1 = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentA.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    opSeq2 = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentA.id, seq: 2, operationId: opCutting.id },
      })
    ).id;
    componentBOpSeq1 = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentB.id, seq: 1, operationId: opReceipt.id },
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
      data: { jobId, equipmentId: equipment.id, tag: "N3", componentTypeId: componentType.id, routeVersionId: routeVersion.id },
    });
    componentCReceiptOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentC.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    componentCCuttingOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentC.id, seq: 2, operationId: opCutting.id },
      })
    ).id;

    const componentD = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "N4", componentTypeId: componentType.id },
    });
    opDetailTest = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentD.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    rejectCategoryId = (
      await owner.delayCategoryRef.create({ data: { tenantId, code: "REWORK", name: "Rework" } })
    ).id;
    welderId = (
      await owner.welder.create({ data: { tenantId, name: "Welder One", employeeCode: `W-${Date.now()}` } })
    ).id;

    // B7 — assertKitReady fixtures. AUD-032: the gate now always explodes
    // against unitCount=1 (one component's own need), never the equipment's
    // real Unit count, so adding more Unit rows below (for the multi-unit
    // regression fixture) cannot affect any other kit-gate test's numbers.
    await owner.unit.create({ data: { jobId, equipmentId: equipment.id, serialNo: "KIT-1" } });

    const bomItemShort = await owner.bomItem.create({
      data: { jobId, equipmentId: equipment.id, itemNo: 1, partName: "Gasket, Short", sourceQty: "10 NOS.", qtyPer: 10, uom: "NOS." },
    });
    await owner.stockLot.create({ data: { jobId, bomItemId: bomItemShort.id, location: "Yard A", qty: 3 } });

    const bomItemStocked = await owner.bomItem.create({
      data: { jobId, equipmentId: equipment.id, itemNo: 2, partName: "Gasket, Stocked", sourceQty: "2 NOS.", qtyPer: 2, uom: "NOS." },
    });
    await owner.stockLot.create({ data: { jobId, bomItemId: bomItemStocked.id, location: "Yard A", qty: 5 } });

    // Zero StockLot rows for this item at all — the SEAM case ("never
    // tracked" vs "tracked but 0 available"), distinct from bomItemShort.
    const bomItemNoActivity = await owner.bomItem.create({
      data: { jobId, equipmentId: equipment.id, itemNo: 3, partName: "Gasket, Untracked", sourceQty: "5 NOS.", qtyPer: 5, uom: "NOS." },
    });

    const componentKitShort = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "KIT-SHORT", componentTypeId: componentType.id, bomItemId: bomItemShort.id },
    });
    kitShortOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentKitShort.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    const componentKitStocked = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "KIT-STOCKED", componentTypeId: componentType.id, bomItemId: bomItemStocked.id },
    });
    kitStockedOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentKitStocked.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    const componentKitUntracked = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "KIT-UNTRACKED", componentTypeId: componentType.id },
    });
    kitUntrackedOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentKitUntracked.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    const componentKitNoActivity = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "KIT-NOACT", componentTypeId: componentType.id, bomItemId: bomItemNoActivity.id },
    });
    kitNoActivityOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentKitNoActivity.id, seq: 1, operationId: opReceipt.id },
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
      data: { jobId: otherJob.id, equipmentId: otherEquipment.id, itemNo: 1, partName: "Other tenant's part", sourceQty: "1 NOS.", qtyPer: 1, uom: "NOS." },
    });
    const componentKitCrossTenant = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "KIT-XT", componentTypeId: componentType.id, bomItemId: otherBomItem.id },
    });
    kitCrossTenantOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentKitCrossTenant.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    // H1 — same-tenant, DIFFERENT job BomItem cross-link.
    const jobB = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-co-jobrls-b-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-CO-RLS-B-${Date.now()}`,
      },
    });
    const jobBEquipment = await owner.equipment.create({ data: { jobId: jobB.id, name: "Job B Vessel" } });
    const jobBBomItem = await owner.bomItem.create({
      data: { jobId: jobB.id, equipmentId: jobBEquipment.id, itemNo: 1, partName: "Job B's part", sourceQty: "1 NOS.", qtyPer: 1, uom: "NOS." },
    });
    const componentKitCrossJob = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "KIT-XJ", componentTypeId: componentType.id, bomItemId: jobBBomItem.id },
    });
    kitCrossJobOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentKitCrossJob.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    // Fix wave, Critical #1 regression fixture: a full kit (required 9 ===
    // received 9), two ops on the SAME component, so issuing material after
    // op1 starts can be checked against op2's start on that very component.
    const bomItemIssueRegression = await owner.bomItem.create({
      data: { jobId, equipmentId: equipment.id, itemNo: 4, partName: "Gasket, Full Kit", sourceQty: "9 NOS.", qtyPer: 9, uom: "NOS." },
    });
    const issueRegressionLot = await owner.stockLot.create({
      data: { jobId, bomItemId: bomItemIssueRegression.id, location: "Yard A", qty: 9 },
    });
    kitIssueRegressionLotId = issueRegressionLot.id;
    const componentIssueRegression = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "KIT-ISSUE-REGRESSION", componentTypeId: componentType.id, bomItemId: bomItemIssueRegression.id },
    });
    kitIssueRegressionComponentId = componentIssueRegression.id;
    kitIssueRegressionOp1 = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentIssueRegression.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;
    kitIssueRegressionOp2 = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentIssueRegression.id, seq: 2, operationId: opCutting.id },
      })
    ).id;

    // AUD-032 fixture 1: equipment now has 4 Unit rows total (KIT-1..4), but
    // a BomItem stocked for only ONE unit's worth (qtyPer=10, on hand 15)
    // must still let a component start — the gate no longer demands the
    // whole equipment's kit (10 * 4 = 40) be on hand.
    await owner.unit.create({ data: { jobId, equipmentId: equipment.id, serialNo: "KIT-2" } });
    await owner.unit.create({ data: { jobId, equipmentId: equipment.id, serialNo: "KIT-3" } });
    await owner.unit.create({ data: { jobId, equipmentId: equipment.id, serialNo: "KIT-4" } });
    const bomItemMultiUnit = await owner.bomItem.create({
      data: { jobId, equipmentId: equipment.id, itemNo: 5, partName: "Gasket, Multi-Unit", sourceQty: "10 NOS.", qtyPer: 10, uom: "NOS." },
    });
    await owner.stockLot.create({ data: { jobId, bomItemId: bomItemMultiUnit.id, location: "Yard A", qty: 15 } });
    const componentMultiUnit = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "KIT-MULTI-UNIT", componentTypeId: componentType.id, bomItemId: bomItemMultiUnit.id },
    });
    kitMultiUnitOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentMultiUnit.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    // AUD-032 fixture 2: a BomItem that received exactly enough once (5
    // on hand for a qtyPer=5 requirement — would have passed the gate) but
    // has since been fully ISSUEd out (consumed elsewhere) — must now be
    // refused, not pass forever on the strength of the original receipt.
    const bomItemConsumed = await owner.bomItem.create({
      data: { jobId, equipmentId: equipment.id, itemNo: 6, partName: "Gasket, Fully Consumed", sourceQty: "5 NOS.", qtyPer: 5, uom: "NOS." },
    });
    const consumedLot = await owner.stockLot.create({
      data: { jobId, bomItemId: bomItemConsumed.id, location: "Yard A", qty: 5 },
    });
    const consumedTxnUser = await owner.user.create({
      data: { tenantId, email: `co-consumed-${Date.now()}@x`, username: `co-consumed-${Date.now()}`, name: "Consumed Fixture User", passwordHash: "x" },
    });
    await owner.stockTxn.create({
      data: { jobId, stockLotId: consumedLot.id, type: "ISSUE", qty: 5, by: consumedTxnUser.id },
    });
    const componentConsumed = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "KIT-CONSUMED", componentTypeId: componentType.id, bomItemId: bomItemConsumed.id },
    });
    kitConsumedOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentConsumed.id, seq: 1, operationId: opReceipt.id },
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
      data: { jobId: job.id, assemblyDrawingId: drawingDraft.id, revisionNo: 1, status: "DRAFT" },
    });
    const drawingReleased = await owner.assemblyDrawing.create({
      data: { jobId: job.id, drawingTypeId: drawingType.id, drawingNo: "GA-2" },
    });
    drawingReleasedRevisionId = (
      await owner.drawingRevision.create({
        data: { jobId: job.id, assemblyDrawingId: drawingReleased.id, revisionNo: 1, status: "RELEASED", releasedAt: new Date() },
      })
    ).id;

    const componentDrawingGated = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "DWG-GATED", componentTypeId: componentType.id, governingDrawingId: drawingDraft.id },
    });
    drawingGatedCuttingOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentDrawingGated.id, seq: 1, operationId: opCutting.id },
      })
    ).id;

    const componentDrawingReleased = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "DWG-RELEASED", componentTypeId: componentType.id, governingDrawingId: drawingReleased.id },
    });
    drawingReleasedComponentId = componentDrawingReleased.id;
    drawingReleasedCuttingOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentDrawingReleased.id, seq: 1, operationId: opCutting.id },
      })
    ).id;

    const componentDrawingSeam = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "DWG-SEAM", componentTypeId: componentType.id }, // governingDrawingId left null
    });
    drawingSeamCuttingOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentDrawingSeam.id, seq: 1, operationId: opCutting.id },
      })
    ).id;

    const componentDrawingGatedNonCutting = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "DWG-GATED-RECEIPT", componentTypeId: componentType.id, governingDrawingId: drawingDraft.id },
    });
    drawingGatedNonCuttingOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentDrawingGatedNonCutting.id, seq: 1, operationId: opReceipt.id },
      })
    ).id;

    // S18 — linkGoverningDrawing fixtures.
    const linkComponent = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "LINK-1", componentTypeId: componentType.id },
    });
    linkComponentId = linkComponent.id;
    linkDrawingId = drawingReleased.id;
    const otherJobForLink = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-co-link-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: version.id,
        jobNumber: `JOB-CO-LINK-${Date.now()}`,
      },
    });
    linkOtherJobDrawingId = (
      await owner.assemblyDrawing.create({
        data: { jobId: otherJobForLink.id, drawingTypeId: drawingType.id, drawingNo: "GA-OTHER-JOB" },
      })
    ).id;

    // H1 — a RELEASED revision on the OTHER job's drawing, so the cross-job
    // test below proves the job-equality check itself, not just the SEAM/
    // DRAFT path assertDrawingReleased already covers.
    await owner.drawingRevision.create({
      data: { jobId: otherJobForLink.id, assemblyDrawingId: linkOtherJobDrawingId, revisionNo: 1, status: "RELEASED", releasedAt: new Date() },
    });
    const componentCrossJobDrawing = await owner.component.create({
      // governingDrawingId set directly here (bypassing linkGoverningDrawing's
      // own job-equality guard) to simulate the stale/cross-job link H1 exists
      // to backstop against.
      data: { jobId, equipmentId: equipment.id, tag: "DWG-CROSS-JOB", componentTypeId: componentType.id, governingDrawingId: linkOtherJobDrawingId },
    });
    drawingCrossJobCuttingOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentCrossJobDrawing.id, seq: 1, operationId: opCutting.id },
      })
    ).id;

    // P1 (Phase 5) — Paint/DFT gate fixtures.
    const opPainting = await owner.operationRef.create({
      data: { tenantId, code: "PAINTING", name: "Painting", defaultDepartmentId: deptA.id, requiresDftGate: true },
    });
    opPaintingId = opPainting.id;
    const componentPaintNoRecord = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "PAINT-NO-RECORD", componentTypeId: componentType.id },
    });
    paintOpNoRecord = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentPaintNoRecord.id, seq: 1, operationId: opPainting.id },
      })
    ).id;
    const componentPaintTwoCoats = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "PAINT-TWO-COATS", componentTypeId: componentType.id },
    });
    paintOpTwoCoats = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentPaintTwoCoats.id, seq: 1, operationId: opPainting.id },
      })
    ).id;
    const componentPaintDuplicateCoat = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "PAINT-DUP-COAT", componentTypeId: componentType.id },
    });
    paintOpDuplicateCoat = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentPaintDuplicateCoat.id, seq: 1, operationId: opPainting.id },
      })
    ).id;

    // B6 — flag-driven, not code-string-driven.
    const opPaintingUnflagged = await owner.operationRef.create({
      data: { tenantId, code: "PAINTING_LEGACY", name: "Painting (legacy, unflagged)", defaultDepartmentId: deptA.id, requiresDftGate: false },
    });
    const componentUnflaggedPainting = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "PAINT-UNFLAGGED", componentTypeId: componentType.id },
    });
    unflaggedPaintingCodeOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentUnflaggedPainting.id, seq: 1, operationId: opPaintingUnflagged.id },
      })
    ).id;
    const opGalvanizingFlagged = await owner.operationRef.create({
      data: { tenantId, code: "GALVANIZING", name: "Galvanizing", defaultDepartmentId: deptA.id, requiresDftGate: true },
    });
    const componentFlaggedGalvanizing = await owner.component.create({
      data: { jobId, equipmentId: equipment.id, tag: "GALV-FLAGGED", componentTypeId: componentType.id },
    });
    flaggedNonPaintingCodeOp = (
      await owner.componentOperation.create({
        data: { jobId, componentId: componentFlaggedGalvanizing.id, seq: 1, operationId: opGalvanizingFlagged.id },
      })
    ).id;

    // AUD-026 — dispositionNcr gate fixtures. One component per scenario so
    // reject/verify cycles on one can't interfere with another's gating.
    async function freshNcrGateOp(tag: string): Promise<number> {
      const c = await owner.component.create({
        data: { jobId, equipmentId: equipment.id, tag, componentTypeId: componentType.id },
      });
      return (
        await owner.componentOperation.create({
          data: { jobId, componentId: c.id, seq: 1, operationId: opReceipt.id },
        })
      ).id;
    }
    ncrGateNeverDispositionedOp = await freshNcrGateOp("NCR-GATE-NEVER-DISP");
    ncrGateDispositionedOp = await freshNcrGateOp("NCR-GATE-DISP");
    ncrGateTwoNcrsOp = await freshNcrGateOp("NCR-GATE-TWO");
    ncrGateDirectCloseOp = await freshNcrGateOp("NCR-GATE-DIRECT-CLOSE");
    ncrGateNoNcrOp = await freshNcrGateOp("NCR-GATE-NO-NCR");

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

    // AUD-026: verify no longer auto-closes an OPEN Ncr — both must be
    // dispositioned first.
    for (const ncr of openBefore) {
      await dispositionNcr(qc, { ncrId: ncr.id, disposition: "USE_AS_IS" });
    }

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
    // H1: rejectComponentOperation populates jobId on the rejection and the Ncr it opens.
    expect(rejections[0].jobId).toBe(jobId);
    const ncrForRejection = await owner.ncr.findUniqueOrThrow({ where: { componentOperationRejectionId: rejections[0].id } });
    expect(ncrForRejection.jobId).toBe(jobId);

    // N1 (Phase 5): reject opens exactly one Ncr, linked to that rejection.
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { componentOperationRejectionId: rejections[0].id } });
    expect(ncr.status).toBe("OPEN");

    // Rejected work restarts from the SAME step (F-e default, spec §4) — it
    // must be resubmittable, not stuck.
    const resubmitted = await submitComponentOperation(supA, { componentOperationId: componentBOpSeq1 });
    expect(resubmitted.status).toBe("SUBMITTED");

    // AUD-026: verify no longer auto-closes an OPEN Ncr — QC must disposition
    // it first. USE_AS_IS is a dispositionFinal transition (no rework
    // interval to record), matching this test's original "no rework" intent.
    await dispositionNcr(qc, { ncrId: ncr.id, disposition: "USE_AS_IS" });

    // N1: re-verifying closes the (now DISPOSITIONED) Ncr.
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

  it("kit gate S18: BomItem set but zero StockLot/StockTxn rows recorded at all is now refused — a real Component link with 'never stocked' is a genuine shortage, not a SEAM (violation case 4)", async () => {
    await expectCode(
      startComponentOperation(supA, { componentOperationId: kitNoActivityOp }),
      ERROR_CODES.MATERIAL_NOT_AVAILABLE,
    );
  });

  it("kit gate cross-tenant: a Component.bomItemId pointing at another tenant's BomItem is refused as NOT_FOUND, not read across (violation case 5)", async () => {
    await expectCode(startComponentOperation(supA, { componentOperationId: kitCrossTenantOp }), ERROR_CODES.NOT_FOUND);
  });

  it("H1 job-level RLS backstop: a Component.bomItemId pointing at a SAME-tenant, DIFFERENT job's BomItem is refused as NOT_FOUND — assertKitReady's tenant-only lookup would otherwise read it across", async () => {
    await expectCode(startComponentOperation(supA, { componentOperationId: kitCrossJobOp }), ERROR_CODES.NOT_FOUND);
  });

  it("kit gate, AUD-032 supersedes the fix-wave Critical #1 regression test: issuing material against a component now DOES reduce its availability for that component's NEXT op — the old test asserted the exact toothless-gate behavior AUD-032 fixes", async () => {
    // Full kit received (qty 9 === required 9 for one unit): first op starts clean.
    const started1 = await startComponentOperation(supA, { componentOperationId: kitIssueRegressionOp1 });
    expect(started1.status).toBe("IN_PROGRESS");

    // Issue 1 unit's worth of material to that component — real consumption.
    // Fix-wave Critical #1 made ISSUE never move the shortage-relevant
    // `available` number, so this stayed at 9 forever regardless of
    // consumption — permanently toothless (AUD-032). Now available drops to
    // 8, below the 9 still required, so op2 is correctly refused.
    const ph: Actor = { ...supA, roles: [ROLES.PRODUCTION_HEAD] };
    await issueStock(ph, { stockLotId: kitIssueRegressionLotId, qty: 1, componentId: kitIssueRegressionComponentId });

    // Route gate: op2 needs op1 COMPLETE first.
    await submitComponentOperation(supA, { componentOperationId: kitIssueRegressionOp1 });
    await verifyComponentOperation(qc, { componentOperationId: kitIssueRegressionOp1 });

    await expectCode(
      startComponentOperation(supA, { componentOperationId: kitIssueRegressionOp2 }),
      ERROR_CODES.MATERIAL_NOT_AVAILABLE,
    );
  });

  it("AUD-032: a 4-Unit equipment's BomItem stocked for only ONE unit's worth still lets that unit's component start — the gate no longer demands the whole equipment's kit up front", async () => {
    const started = await startComponentOperation(supA, { componentOperationId: kitMultiUnitOp });
    expect(started.status).toBe("IN_PROGRESS");
  });

  it("AUD-032: a BomItem that received enough once (would have passed historically) but has since been fully issued/consumed is refused — the gate must not stay toothless forever after the first pass", async () => {
    await expectCode(
      startComponentOperation(supA, { componentOperationId: kitConsumedOp }),
      ERROR_CODES.MATERIAL_NOT_AVAILABLE,
    );
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

  // ── H1: assertDrawingReleased refuses a cross-job governingDrawingId,
  // even when that other job's drawing IS RELEASED ────────────────────────

  it("drawing gate: assertDrawingReleased refuses when the component's job and the governing drawing's job disagree, even though the other job's drawing is RELEASED", async () => {
    await expectCode(
      startComponentOperation(supA, { componentOperationId: drawingCrossJobCuttingOp }),
      ERROR_CODES.DRAWING_NOT_RELEASED,
    );
  });

  // ── S18: linkGoverningDrawing — the write assertDrawingReleased's gate depends on ────

  async function componentAuditCount(entityId: number): Promise<number> {
    return owner.auditLog.count({ where: { tenantId, entityType: "Component", entityId: String(entityId) } });
  }

  it("linkGoverningDrawing: PRODUCTION_HEAD can set a Component's governingDrawingId, audited", async () => {
    const ph: Actor = { ...supA, roles: [ROLES.PRODUCTION_HEAD] };
    const before = await componentAuditCount(linkComponentId);
    const updated = await linkGoverningDrawing(ph, { componentId: linkComponentId, assemblyDrawingId: linkDrawingId });
    expect(updated.governingDrawingId).toBe(linkDrawingId);
    expect(await componentAuditCount(linkComponentId)).toBe(before + 1);

    // Clearing it back to null is also a legal, audited write.
    const cleared = await linkGoverningDrawing(ph, { componentId: linkComponentId, assemblyDrawingId: null });
    expect(cleared.governingDrawingId).toBeNull();
  });

  it("linkGoverningDrawing: a SUPERVISOR (no PRODUCTION_HEAD/ADMIN role) is refused", async () => {
    await expectCode(
      linkGoverningDrawing(supA, { componentId: linkComponentId, assemblyDrawingId: linkDrawingId }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("linkGoverningDrawing: an AssemblyDrawing belonging to a DIFFERENT job is refused as NOT_FOUND, not linked across jobs", async () => {
    const ph: Actor = { ...supA, roles: [ROLES.PRODUCTION_HEAD] };
    await expectCode(
      linkGoverningDrawing(ph, { componentId: linkComponentId, assemblyDrawingId: linkOtherJobDrawingId }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  it("linkGoverningDrawing: a Component outside the actor's tenant is refused as NOT_FOUND, not read across", async () => {
    const ph: Actor = { ...supA, roles: [ROLES.PRODUCTION_HEAD] };
    await expectCode(
      linkGoverningDrawing(ph, { componentId: 999_999_999, assemblyDrawingId: linkDrawingId }),
      ERROR_CODES.NOT_FOUND,
    );
  });

  // ── P1 (Phase 5): recordPaintRecord/recordDftReading + the PAINTING verify gate ────

  it("DFT gate: verifying a PAINTING op with no PaintRecord/DftReading at all is refused (violation case 1)", async () => {
    await startComponentOperation(supA, { componentOperationId: paintOpNoRecord });
    await submitComponentOperation(supA, { componentOperationId: paintOpNoRecord });
    await expectCode(verifyComponentOperation(qc, { componentOperationId: paintOpNoRecord }), ERROR_CODES.DFT_NOT_ACCEPTED);
  });

  it("DFT gate: PaintRecord + readings recorded but none accepted is still refused (violation case 2)", async () => {
    const record = await recordPaintRecord(supA, { componentOperationId: paintOpNoRecord, coatingSystem: "Epoxy zinc-rich" });
    const reading = await recordDftReading(supA, { componentOperationId: paintOpNoRecord, readingMicrons: 40, accepted: false });
    // H1: recordPaintRecord/recordDftReading populate jobId from the op's own jobId.
    expect(record.jobId).toBe(jobId);
    expect(reading.jobId).toBe(jobId);
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

  it("B6: an op with code \"PAINTING_LEGACY\" but requiresDftGate: false verifies with no PaintRecord — the code string no longer gates", async () => {
    await startComponentOperation(supA, { componentOperationId: unflaggedPaintingCodeOp });
    await submitComponentOperation(supA, { componentOperationId: unflaggedPaintingCodeOp });
    const verified = await verifyComponentOperation(qc, { componentOperationId: unflaggedPaintingCodeOp });
    expect(verified.status).toBe("COMPLETE");
  });

  it("B6: a non-PAINTING op (code \"GALVANIZING\") flagged requiresDftGate: true is refused with no PaintRecord — the flag gates, not the code", async () => {
    await startComponentOperation(supA, { componentOperationId: flaggedNonPaintingCodeOp });
    await submitComponentOperation(supA, { componentOperationId: flaggedNonPaintingCodeOp });
    await expectCode(verifyComponentOperation(qc, { componentOperationId: flaggedNonPaintingCodeOp }), ERROR_CODES.DFT_NOT_ACCEPTED);
  });

  it("AUD-029: a real PAINTING op with requiresDftGate flipped off (as this session's migration does DB-wide) verifies with zero PaintRecord/DftReading", async () => {
    // Flips the SAME "PAINTING" OperationRef the tests above use (not a
    // decoy code) to `false`, exactly what
    // 20260908140000_operation_ref_disable_painting_dft_gate does in every
    // tenant. Reverted at the end so the gate-mechanism coverage above
    // (which needs the flag ON to prove DFT_NOT_ACCEPTED still fires) is
    // untouched for any test that runs after this one.
    await owner.operationRef.update({ where: { id: opPaintingId }, data: { requiresDftGate: false } });
    try {
      const equipment = await owner.equipment.create({ data: { jobId, name: "Paint post-fix vessel" } });
      const componentType = await owner.componentTypeRef.create({
        data: { tenantId, code: "PAINT_POSTFIX", name: "Paint post-fix" },
      });
      const component = await owner.component.create({
        data: { jobId, equipmentId: equipment.id, tag: "PAINT-POST-FIX", componentTypeId: componentType.id },
      });
      const op = await owner.componentOperation.create({
        data: { jobId, componentId: component.id, seq: 1, operationId: opPaintingId },
      });

      await startComponentOperation(supA, { componentOperationId: op.id });
      await submitComponentOperation(supA, { componentOperationId: op.id });
      const verified = await verifyComponentOperation(qc, { componentOperationId: op.id });
      expect(verified.status).toBe("COMPLETE");
      expect(await owner.paintRecord.count({ where: { componentOperationId: op.id } })).toBe(0);
      expect(await owner.dftReading.count({ where: { componentOperationId: op.id } })).toBe(0);
    } finally {
      await owner.operationRef.update({ where: { id: opPaintingId }, data: { requiresDftGate: true } });
    }
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

  // ── AUD-026: dispositionNcr is a hard gate on the verify path ──────────

  it("AUD-026 (1): reject → resubmit → reverify with the Ncr still OPEN is refused, NCR_NOT_DISPOSITIONED", async () => {
    await startComponentOperation(supA, { componentOperationId: ncrGateNeverDispositionedOp });
    await submitComponentOperation(supA, { componentOperationId: ncrGateNeverDispositionedOp });
    await rejectComponentOperation(qc, { componentOperationId: ncrGateNeverDispositionedOp, categoryId: rejectCategoryId });
    await submitComponentOperation(supA, { componentOperationId: ncrGateNeverDispositionedOp });

    await expectCode(
      verifyComponentOperation(qc, { componentOperationId: ncrGateNeverDispositionedOp }),
      ERROR_CODES.NCR_NOT_DISPOSITIONED,
    );
    const op = await owner.componentOperation.findUniqueOrThrow({ where: { id: ncrGateNeverDispositionedOp } });
    expect(op.status).toBe("SUBMITTED"); // refusal did not advance state
  });

  it("AUD-026 (2): dispositionNcr called before reverify lets verify proceed and closes the Ncr with the disposition recorded", async () => {
    await startComponentOperation(supA, { componentOperationId: ncrGateDispositionedOp });
    await submitComponentOperation(supA, { componentOperationId: ncrGateDispositionedOp });
    await rejectComponentOperation(qc, { componentOperationId: ncrGateDispositionedOp, categoryId: rejectCategoryId });
    await submitComponentOperation(supA, { componentOperationId: ncrGateDispositionedOp });

    const rejection = await owner.componentOperationRejection.findFirstOrThrow({
      where: { componentOperationId: ncrGateDispositionedOp },
    });
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { componentOperationRejectionId: rejection.id } });
    await dispositionNcr(qc, { ncrId: ncr.id, disposition: "USE_AS_IS", notes: "no rework needed" });

    const verified = await verifyComponentOperation(qc, { componentOperationId: ncrGateDispositionedOp });
    expect(verified.status).toBe("COMPLETE");

    const closed = await owner.ncr.findUniqueOrThrow({ where: { id: ncr.id } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.disposition).toBe("USE_AS_IS");
    expect(closed.dispositionedBy).toBe(qc.userId);
    expect(closed.dispositionNotes).toBe("no rework needed");
  });

  it("AUD-026 (3): two Ncrs open on the same op, only one dispositioned — reverify is still refused, and the undispositioned one stays OPEN", async () => {
    await startComponentOperation(supA, { componentOperationId: ncrGateTwoNcrsOp });
    await submitComponentOperation(supA, { componentOperationId: ncrGateTwoNcrsOp });
    await rejectComponentOperation(qc, { componentOperationId: ncrGateTwoNcrsOp, categoryId: rejectCategoryId, detail: "first" });
    await submitComponentOperation(supA, { componentOperationId: ncrGateTwoNcrsOp });
    await rejectComponentOperation(qc, { componentOperationId: ncrGateTwoNcrsOp, categoryId: rejectCategoryId, detail: "second" });
    await submitComponentOperation(supA, { componentOperationId: ncrGateTwoNcrsOp });

    const ncrs = await owner.ncr.findMany({
      where: { componentOperationRejection: { componentOperationId: ncrGateTwoNcrsOp } },
      orderBy: { id: "asc" },
    });
    expect(ncrs).toHaveLength(2);
    await dispositionNcr(qc, { ncrId: ncrs[0].id, disposition: "USE_AS_IS" });

    await expectCode(
      verifyComponentOperation(qc, { componentOperationId: ncrGateTwoNcrsOp }),
      ERROR_CODES.NCR_NOT_DISPOSITIONED,
    );
    const stillOpen = await owner.ncr.findUniqueOrThrow({ where: { id: ncrs[1].id } });
    expect(stillOpen.status).toBe("OPEN");
  });

  it("AUD-026 (4): closeNcr called directly on an OPEN-source Ncr is refused at the transition-table layer, independent of the verify-path pre-check", async () => {
    await startComponentOperation(supA, { componentOperationId: ncrGateDirectCloseOp });
    await submitComponentOperation(supA, { componentOperationId: ncrGateDirectCloseOp });
    await rejectComponentOperation(qc, { componentOperationId: ncrGateDirectCloseOp, categoryId: rejectCategoryId });

    const rejection = await owner.componentOperationRejection.findFirstOrThrow({
      where: { componentOperationId: ncrGateDirectCloseOp },
    });
    const ncr = await owner.ncr.findUniqueOrThrow({ where: { componentOperationRejectionId: rejection.id } });
    expect(ncr.status).toBe("OPEN");

    await expectCode(closeNcr(owner, qc, { ncrId: ncr.id, jobId }), ERROR_CODES.INVALID_STATE_TRANSITION);
  });

  it("AUD-026 (5): an op with no Ncr ever raised verifies exactly as before — no regression for the common case", async () => {
    await startComponentOperation(supA, { componentOperationId: ncrGateNoNcrOp });
    await submitComponentOperation(supA, { componentOperationId: ncrGateNoNcrOp });
    const verified = await verifyComponentOperation(qc, { componentOperationId: ncrGateNoNcrOp });
    expect(verified.status).toBe("COMPLETE");
  });
});
