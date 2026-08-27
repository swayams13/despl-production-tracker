// One-off production seed: DESPL-320 (pilot, 9 real units + its QCP) and
// DE0467 (real BOM/procurement/QCP from live-jobs.json, job-grain — no
// serialized units exist for it in DESPL's real records, so no per-unit
// ProcessPlan rows; run scripts/bootstrap-schedule.ts afterward for each job
// number to generate the actual department-workflow ProcessPlan rows).
//
// Deliberately does NOT seed DE0463 or any demo/dev-password user — this is
// prisma/seed.ts's `seedDemo` §10/§11/§13 logic, copied (not imported, since
// seed.ts runs its own main() on import) and filtered to exactly these two
// jobs, per this project's own rule: "real jobs are created through the app,
// not seeded" — the exception here is that no "create job" UI exists yet, so
// this mirrors the exact same real-data ingestion the dev seed already does,
// scoped down and run once against production. Never run twice without
// checking the guard below first (see main()).
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import {
  ProcessEdgeType,
  Sourcing,
  OperationStatus,
  QcpItemKind,
  SnapshotCadence,
} from "../src/generated/prisma/enums";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, "..", "seed", file), "utf-8")) as T;
}

// ── source file shapes (subset of prisma/seed.ts's — only what we read) ────

interface LeadTimeModel {
  departments: { code: string; name: string; scope: string | null }[];
  processes: {
    code: number;
    edges: { predecessor: number; type: string; lagDays: number }[];
  }[];
}
interface DataIssue {
  type: string;
  where: string;
  note: string;
}
interface LiveBomItem {
  itemNo: number;
  partName: string;
  description: string;
  material: string;
  qty: string;
  unit: string;
  procurement: {
    indentNo: string | null;
    indentGenerateDate: string | null;
    indentApprovedDate: string | null;
    status: string | null;
    poNo: string | null;
    poDate: string | null;
    materialReceivedStatus: string | null;
    materialReceivedDate: string | null;
  };
  qc: { materialIdentification: string | null };
  operations: { operation: string; type: string; startDate: string | null; endDate: string | null }[];
  remarks: string | null;
}
interface LiveJobsFile {
  jobs: {
    job: string;
    workOrderNoInFile: string;
    orderGenerateDate: string;
    projectName: string;
    dispatchDate: string;
    equipmentBlocks: { blockNo: number; label: string | null; items: LiveBomItem[] }[];
    assemblyDrawings: {
      name: string;
      drawingNo: string | null;
      approvalDate?: string | null;
      releasedDate?: string | null;
      revisedDate?: string | null;
      revNo?: string | null;
      remarks?: string | null;
    }[];
    dispatchBatches?: string[];
  }[];
}
interface ComponentRoutesFile {
  canonicalOperations: Record<
    string,
    { label: string; dept: string; csvColumn: string | null; leadTimeProcess: number }
  >;
  routes: { componentType: string }[];
}
interface QcpTemplateItem {
  srNo: string;
  kind: "SECTION" | "CHECKPOINT";
  section?: string;
  activity: string;
  characteristic?: string;
  extentOfCheck?: string;
  applicableDocument?: string;
  acceptanceCriteria?: string;
  record?: string;
  codes?: Record<string, string>;
  remarks?: string;
  leadTimeProcesses?: number[];
}
interface QcpBatchItem {
  kind: "SECTION" | "CHECKPOINT";
  srNo: string;
  activity: string;
  section?: string | null;
  characteristic?: string | null;
  extentOfCheck?: string | null;
  applicableDocument?: string | null;
  acceptanceCriteria?: string | null;
  record?: string | null;
  codes?: Record<string, string>;
  remarks?: string | null;
  leadTimeProcesses?: number[];
}
interface QcpBatchTemplate {
  jobLabel: string;
  vessel: string;
  designCode: string | null;
  jobNumberHint: string | null;
  parties: string[];
  items: QcpBatchItem[];
}
interface QcpBatchFile {
  templates: QcpBatchTemplate[];
  issues: { row: string; problem: string }[];
}
interface QcpTemplatesFile {
  template: {
    job: string;
    vessel: string;
    revision: number;
    designCode: string;
    parties: string[];
    items: QcpTemplateItem[];
  };
}

// ── helpers (verbatim from prisma/seed.ts — fail loud) ──────────────────────

function findIssue(issues: DataIssue[], type: string, whereContains: string): DataIssue {
  const matches = issues.filter((i) => i.type === type && i.where.includes(whereContains));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${type} issue matching "${whereContains}", found ${matches.length}`,
    );
  }
  return matches[0];
}
function findIssueOptional(issues: DataIssue[], type: string, whereContains: string) {
  const matches = issues.filter((i) => i.type === type && i.where.includes(whereContains));
  if (matches.length > 1) {
    throw new Error(
      `expected at most one ${type} issue matching "${whereContains}", found ${matches.length}`,
    );
  }
  return matches[0];
}
function extractDMYDates(raw: string): Date[] {
  return [...raw.matchAll(/(\d{2})\.(\d{2})\.(\d{4})/g)].map(
    ([, dd, mm, yyyy]) => new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))),
  );
}
function firstDate(raw: string): Date {
  const d = extractDMYDates(raw);
  if (!d.length) throw new Error(`no dd.mm.yyyy date found in "${raw}"`);
  return d[0];
}
function isoDate(raw: string | null): Date | null {
  return raw ? new Date(`${raw}T00:00:00.000Z`) : null;
}
const CLEAN_DMY = /^\d{2}\.\d{2}\.\d{4}$/;
function buildJobRemarks(issues: DataIssue[], jobNumber: string, rawOrder: string, rawDispatch: string): string {
  const mismatch = findIssue(issues, "JOB_NUMBER_MISMATCH", jobNumber);
  const noPlanned = findIssue(issues, "NO_PLANNED_DATES", "both files");
  const noOwner = findIssue(issues, "NO_OWNER", "both files");
  const lines = [mismatch.note];
  if (!CLEAN_DMY.test(rawOrder.trim())) lines.push(`orderGenerateDate raw: ${rawOrder}`);
  if (!CLEAN_DMY.test(rawDispatch.trim())) lines.push(`dispatchDate raw: ${rawDispatch}`);
  lines.push(`NO_PLANNED_DATES: ${noPlanned.note}`);
  lines.push(`NO_OWNER: ${noOwner.note}`);
  return lines.join("\n");
}
type ReceivedStatus = "NOT_RECEIVED" | "PARTIALLY_RECEIVED" | "RECEIVED";
const RECEIVED_STATUS_MAP: Record<string, ReceivedStatus> = {
  Received: "RECEIVED",
  "Not Received": "NOT_RECEIVED",
  "Partially Received": "PARTIALLY_RECEIVED",
};
function mapReceivedStatus(raw: string | null): ReceivedStatus | null {
  if (!raw) return null;
  const m = RECEIVED_STATUS_MAP[raw];
  if (!m) throw new Error(`unknown procurement.materialReceivedStatus "${raw}"`);
  return m;
}

// ponytail: duplicated (not imported) from scripts/backfill-bom-item-qty-per.ts
// / prisma/seed.ts — same reasoning as prisma/seed.ts's copy: that script's
// `main()` runs unconditionally at module scope.
const QTY_RE = /^(\d+(?:\.\d+)?)\s*(.*)$/;
function parseSourceQty(sourceQty: string): { qtyPer: number; uom: string | null } | null {
  const m = QTY_RE.exec(sourceQty.trim());
  if (!m) return null;
  return { qtyPer: Number(m[1]), uom: m[2].trim() || null };
}

/** B5, Phase 4 — see prisma/seed.ts's buildProcurementEventRows for the full
 * rationale; identical logic, kept in sync by hand since this script is
 * itself a hand-copied (not imported) subset of seed.ts's §10/§11. */
function buildProcurementEventRows(
  p: LiveBomItem["procurement"],
  sourceQty: string,
): { type: "INDENT_RAISED" | "INDENT_APPROVED" | "PO_PLACED" | "RECEIPT"; qty: number | null; refNo: string | null; at: Date }[] {
  const rows: ReturnType<typeof buildProcurementEventRows> = [];
  const indentDate = isoDate(p.indentGenerateDate);
  if (indentDate) rows.push({ type: "INDENT_RAISED", qty: null, refNo: p.indentNo || null, at: indentDate });
  const approvedDate = isoDate(p.indentApprovedDate);
  if (approvedDate) rows.push({ type: "INDENT_APPROVED", qty: null, refNo: null, at: approvedDate });
  const poDate = isoDate(p.poDate);
  if (poDate) rows.push({ type: "PO_PLACED", qty: null, refNo: p.poNo || null, at: poDate });
  const receivedDate = isoDate(p.materialReceivedDate);
  if (receivedDate) {
    const receivedStatus = mapReceivedStatus(p.materialReceivedStatus);
    const qty = receivedStatus === "RECEIVED" ? (parseSourceQty(sourceQty)?.qtyPer ?? null) : null;
    rows.push({ type: "RECEIPT", qty, refNo: null, at: receivedDate });
  }
  return rows;
}
const SOURCING_MAP: Record<string, Sourcing> = {
  "In-house": Sourcing.IN_HOUSE,
  Outsource: Sourcing.OUTSOURCE,
  "N/A": Sourcing.NA,
};
function mapSourcing(raw: string): Sourcing {
  const m = SOURCING_MAP[raw];
  if (!m) throw new Error(`unknown Sourcing value "${raw}"`);
  return m;
}
function inferOperationStatus(start: string | null, end: string | null): OperationStatus {
  if (end) return OperationStatus.COMPLETE;
  if (start) return OperationStatus.IN_PROGRESS;
  return OperationStatus.NOT_STARTED;
}
function suggestComponentType(item: LiveBomItem, codes: string[]): string | null {
  const haystack = `${item.partName} ${item.description ?? ""}`.toUpperCase();
  const hits = codes
    .filter((code) => haystack.includes(code.replace(/_/g, " ")))
    .sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
}

type Tx = Prisma.TransactionClient;

interface RefIds {
  tenantId: number;
  familyIdByCode: Map<string, number>;
  componentTypeIdByCode: Map<string, number>;
  operationIdByCode: Map<string, number>;
  drawingTypeIdByName: Map<string, number>;
  qcpCodeIdByCode: Map<string, number>;
  calendarId: number;
  pvVersionId: number;
  templateProcesses: Awaited<ReturnType<Tx["templateProcess"]["findMany"]>>;
  routeVersionIdByType: Map<string, number>;
}

// Verbatim copy of prisma/seed.ts's loadRefIds — read-only lookups against
// reference data that already exists in production (seeded by `pnpm
// db:seed:reference` at deploy time).
async function loadRefIds(tx: Tx, tenantId: number): Promise<RefIds> {
  const [families, componentTypes, operations, drawingTypeRows, qcpCodes] = await Promise.all([
    tx.productFamily.findMany({ where: { tenantId } }),
    tx.componentTypeRef.findMany({ where: { tenantId } }),
    tx.operationRef.findMany({ where: { tenantId } }),
    tx.drawingTypeRef.findMany({ where: { tenantId } }),
    tx.qcpCodeRef.findMany({ where: { tenantId } }),
  ]);
  const familyIdByCode = new Map(families.map((f) => [f.code, f.id]));
  const calendar = await tx.workCalendar.findFirstOrThrow({ where: { tenantId, isDefault: true } });
  const pvTemplate = await tx.processTemplate.findFirstOrThrow({
    where: { tenantId, familyId: familyIdByCode.get("PRESSURE_VESSEL")! },
  });
  const pvVersion = await tx.processTemplateVersion.findFirstOrThrow({
    where: { templateId: pvTemplate.id, version: 1 },
  });
  const templateProcesses = await tx.templateProcess.findMany({ where: { versionId: pvVersion.id } });
  const componentTypeIdByCode = new Map(componentTypes.map((c) => [c.code, c.id]));
  const idToComponentTypeCode = new Map(componentTypes.map((c) => [c.id, c.code]));
  const routeTemplates = await tx.routeTemplate.findMany({
    where: { tenantId },
    include: { versions: { where: { version: 1 } } },
  });
  const routeVersionIdByType = new Map<string, number>();
  for (const rt of routeTemplates) {
    const typeCode = idToComponentTypeCode.get(rt.componentTypeId);
    const rv = rt.versions[0];
    if (typeCode && rv) routeVersionIdByType.set(typeCode, rv.id);
  }
  return {
    tenantId,
    familyIdByCode,
    componentTypeIdByCode,
    operationIdByCode: new Map(operations.map((o) => [o.code, o.id])),
    drawingTypeIdByName: new Map(drawingTypeRows.map((d) => [d.name, d.id])),
    qcpCodeIdByCode: new Map(qcpCodes.map((c) => [c.code, c.id])),
    calendarId: calendar.id,
    pvVersionId: pvVersion.id,
    templateProcesses,
    routeVersionIdByType,
  };
}

async function seedQcpTemplate(
  tx: Tx,
  refs: RefIds,
  spec: {
    jobId: number | null;
    jobLabel: string;
    vessel: string;
    revision?: number;
    designCode?: string | null;
    parties: string[];
    items: QcpBatchItem[] | QcpTemplateItem[];
    jobProcessIdByCode?: Map<string, number>;
  },
) {
  const qcpTemplate = await tx.qcpTemplate.create({
    data: {
      jobId: spec.jobId,
      jobLabel: spec.jobLabel,
      vessel: spec.vessel,
      revision: spec.revision ?? 0,
      designCode: spec.designCode ?? null,
    },
  });
  // Batched instead of one-row-at-a-time: over Railway's public Postgres
  // proxy, a sequential per-item await loop (create + N party-codes + M
  // process-links per item, ~250+ round trips for DESPL-320's 62-item
  // template) ran long enough to get the connection dropped mid-transaction
  // before COMMIT ("Transaction not found") — verified safe (Postgres rolled
  // back atomically) but wasteful to retry. `id: item.id` is set explicitly
  // (reserved via nextval below) purely so this one createMany can replace
  // ~250 individual awaits with ~4; ids are otherwise still DB-generated
  // autoincrement values, same as every other seeded row in this file.
  const partyIdByCode = new Map<string, number>();
  for (const code of spec.parties) {
    const party = await tx.inspectionParty.create({ data: { qcpTemplateId: qcpTemplate.id, code } });
    partyIdByCode.set(code, party.id);
  }

  const [{ nextval: startId }] = await tx.$queryRaw<
    { nextval: bigint }[]
  >(Prisma.sql`SELECT nextval(pg_get_serial_sequence('qcp_items', 'id')) AS nextval`);
  for (let i = 1; i < spec.items.length; i++) {
    await tx.$queryRaw(Prisma.sql`SELECT nextval(pg_get_serial_sequence('qcp_items', 'id'))`);
  }
  const itemIds = Array.from({ length: spec.items.length }, (_, i) => Number(startId) + i);

  await tx.qcpItem.createMany({
    data: spec.items.map((item, i) => ({
      id: itemIds[i],
      qcpTemplateId: qcpTemplate.id,
      sequence: i + 1,
      srNo: item.srNo,
      kind: item.kind as QcpItemKind,
      section: item.section ?? null,
      activity: item.activity,
      characteristic: item.characteristic ?? null,
      extentOfCheck: item.extentOfCheck ?? null,
      applicableDocument: item.applicableDocument ?? null,
      acceptanceCriteria: item.acceptanceCriteria ?? null,
      record: item.record ?? null,
      remarks: item.remarks || null,
    })),
  });

  const partyCodeRows: { qcpItemId: number; inspectionPartyId: number; qcpCodeId: number }[] = [];
  const processLinkRows: { qcpItemId: number; jobProcessId: number }[] = [];
  spec.items.forEach((item, i) => {
    const qcpItemId = itemIds[i];
    if (item.kind === "CHECKPOINT" && item.codes) {
      for (const [partyCode, code] of Object.entries(item.codes)) {
        const inspectionPartyId = partyIdByCode.get(partyCode);
        if (!inspectionPartyId) throw new Error(`QcpItem ${item.srNo}: unknown party "${partyCode}"`);
        const qcpCodeId = refs.qcpCodeIdByCode.get(code);
        if (!qcpCodeId) throw new Error(`QcpItem ${item.srNo}: unknown QCP code "${code}"`);
        partyCodeRows.push({ qcpItemId, inspectionPartyId, qcpCodeId });
      }
    }
    if (spec.jobProcessIdByCode) {
      for (const processCode of item.leadTimeProcesses ?? []) {
        const jobProcessId = spec.jobProcessIdByCode.get(String(processCode));
        if (!jobProcessId) throw new Error(`QcpItem ${item.srNo}: unknown process ${processCode}`);
        processLinkRows.push({ qcpItemId, jobProcessId });
      }
    }
  });
  if (partyCodeRows.length) await tx.qcpItemPartyCode.createMany({ data: partyCodeRows });
  if (processLinkRows.length) await tx.qcpItemProcess.createMany({ data: processLinkRows });

  return spec.items.length;
}

async function main() {
  const leadTime = readJson<LeadTimeModel>("lead-time-model.json");
  const liveJobs = readJson<LiveJobsFile>("live-jobs.json");
  const routesFile = readJson<ComponentRoutesFile>("component-routes.json");
  const qcpFile = readJson<QcpTemplatesFile>("qcp-templates.json");
  const qcpBatch2 = readJson<QcpBatchFile>("qcp-templates-batch2.json");
  const issues = readJson<{ issues: DataIssue[] }>("data-issues.json").issues;

  const de0467Source = liveJobs.jobs.find((j) => j.job === "DE0467");
  if (!de0467Source) throw new Error("DE0467 not found in seed/live-jobs.json");

  // Split into two independent transactions (rather than one covering both
  // jobs) because a single interactive transaction spanning DE0467's full
  // BOM/procurement/component/operation ingestion PLUS DESPL-320's QCP
  // template turned out to run long enough over Railway's public Postgres
  // proxy (~1-5s per round trip observed) that the connection got dropped
  // mid-transaction ("Transaction not found") before COMMIT — verified safe
  // (Postgres rolled back atomically, zero partial rows) but wasteful to
  // repeat. Each job's own idempotency guard still applies independently.
  await prisma.$transaction(
    async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
      const refs = await loadRefIds(tx, org.id);
      const existingDe0467 = await tx.job.findFirst({ where: { tenantId: org.id, jobNumber: "DE0467" } });

      // B5, Phase 4: ProcurementEvent.by needs a real actor. This script
      // (unlike prisma/seed.ts) deliberately creates no users of its own —
      // it runs against an already-bootstrapped production DB (`pnpm
      // db:seed:reference` + `pnpm db:bootstrap-admin`), so the first ADMIN
      // account already exists under whatever email the operator chose.
      // Looked up by role, not a hardcoded dev-seed email.
      const procurementActor = await tx.user.findFirst({
        where: { tenantId: org.id, roles: { some: { role: { code: "ADMIN" } } } },
        orderBy: { id: "asc" },
      });
      if (!procurementActor) {
        throw new Error(
          "No ADMIN user found for this tenant — run `pnpm db:bootstrap-admin` before this script (ProcurementEvent.by needs a real actor).",
        );
      }

      const csvColumnToOperation = new Map<string, string>();
      for (const [opCode, meta] of Object.entries(routesFile.canonicalOperations)) {
        if (meta.csvColumn && !meta.csvColumn.includes("|")) csvColumnToOperation.set(meta.csvColumn, opCode);
      }
      const mtcOp = csvColumnToOperation.get("Material Identification");
      if (!mtcOp) throw new Error("component-routes.json has no csvColumn mapping to MTC_VERIFICATION");
      const routedTypeCodes = routesFile.routes.map((r) => r.componentType);

      const jobIdByNumber = new Map<string, number>();
      let client = await tx.client.findFirst({
        where: { tenantId: org.id, name: { startsWith: "Unknown client — pending DESPL confirmation" } },
      });

      if (!existingDe0467) {
        if (!client) {
          client = await tx.client.create({
            data: {
              tenantId: org.id,
              name: "Unknown client — pending DESPL confirmation (no client/customer name present in live-jobs.json)",
              code: null,
            },
          });
          await tx.clientVisibilityPolicy.create({
            data: { clientId: client.id, cadence: SnapshotCadence.DAILY, requiresApproval: true },
          });
        }

        const jobRow = await tx.job.create({
          data: {
            tenantId: org.id,
            publicId: randomUUID(),
            clientId: client.id,
            familyId: refs.familyIdByCode.get("PRESSURE_VESSEL")!,
            templateVersionId: refs.pvVersionId,
            calendarId: refs.calendarId,
            jobNumber: de0467Source.job,
            clientOrderNo: de0467Source.workOrderNoInFile,
            projectName: de0467Source.projectName,
            orderDate: firstDate(de0467Source.orderGenerateDate),
            committedDeliveryDate: firstDate(de0467Source.dispatchDate),
            remarks: buildJobRemarks(
              issues,
              de0467Source.job,
              de0467Source.orderGenerateDate,
              de0467Source.dispatchDate,
            ),
          },
        });
        jobIdByNumber.set(jobRow.jobNumber, jobRow.id);

        await tx.jobProcess.createMany({
          data: refs.templateProcesses.map((tp) => ({
            jobId: jobRow.id,
            templateProcessId: tp.id,
            seq: tp.seq,
            code: tp.code,
            name: tp.name,
            departmentId: tp.defaultDepartmentId,
            durationMinDays: tp.durationMinDays,
            durationMaxDays: tp.durationMaxDays,
            envelopeFinishByMinDays: tp.envelopeFinishByMinDays,
            envelopeFinishByMaxDays: tp.envelopeFinishByMaxDays,
            envelopeStartByMinDays: tp.envelopeStartByMinDays,
            envelopeStartByMaxDays: tp.envelopeStartByMaxDays,
            workOrderStages: tp.workOrderStages,
          })),
        });
        const jobProcesses = await tx.jobProcess.findMany({ where: { jobId: jobRow.id } });
        const jpIdByCode = new Map(jobProcesses.map((p) => [p.code, p.id]));
        await tx.jobProcessEdge.createMany({
          data: leadTime.processes.flatMap((p) =>
            p.edges.map((e) => ({
              processId: jpIdByCode.get(String(p.code))!,
              predecessorId: jpIdByCode.get(String(e.predecessor))!,
              type: e.type as ProcessEdgeType,
              lagDays: e.lagDays,
            })),
          ),
        });

        for (const d of de0467Source.assemblyDrawings) {
          await tx.assemblyDrawing.create({
            data: {
              jobId: jobRow.id,
              drawingTypeId: refs.drawingTypeIdByName.get(d.name)!,
              drawingNo: d.drawingNo,
              revisionNo: d.revNo ?? null,
              approvedDate: isoDate(d.approvalDate ?? null),
              releasedDate: isoDate(d.releasedDate ?? null),
              revisedDate: isoDate(d.revisedDate ?? null),
              remarks: d.remarks ?? null,
            },
          });
        }

        for (const block of de0467Source.equipmentBlocks) {
          const blockIssue = findIssue(issues, "UNLABELLED_BLOCK", `${de0467Source.job} block ${block.blockNo}`);
          const equipment = await tx.equipment.create({
            data: {
              jobId: jobRow.id,
              name: block.label ?? `${de0467Source.job}-B${block.blockNo}`,
              blockNo: block.blockNo,
              remarks: blockIssue.note,
            },
          });
          for (const item of block.items) {
            const ambiguous = findIssueOptional(issues, "AMBIGUOUS_DATE", `${de0467Source.job} item${item.itemNo} `);
            const suggestedType = suggestComponentType(item, routedTypeCodes);
            const bomItem = await tx.bomItem.create({
              data: {
                equipmentId: equipment.id,
                itemNo: item.itemNo,
                blockNo: block.blockNo,
                partName: item.partName,
                description: item.description || null,
                material: item.material || null,
                sourceQty: item.qty,
                unit: item.unit,
                componentTypeId: suggestedType
                  ? refs.componentTypeIdByCode.get(suggestedType)!
                  : refs.componentTypeIdByCode.get("OTHER")!,
                remarks: ambiguous ? ambiguous.note : item.remarks,
              },
            });
            const procurementEventRows = buildProcurementEventRows(item.procurement, item.qty);
            if (procurementEventRows.length) {
              await tx.procurementEvent.createMany({
                data: procurementEventRows.map((r) => ({ ...r, bomItemId: bomItem.id, by: procurementActor.id })),
              });
            }
            const typeCode = suggestedType ?? "OTHER";
            const component = await tx.component.create({
              data: {
                equipmentId: equipment.id,
                bomItemId: bomItem.id,
                tag: `B${block.blockNo}-I${item.itemNo}`,
                componentTypeId: refs.componentTypeIdByCode.get(typeCode)!,
                routeVersionId: refs.routeVersionIdByType.get(typeCode) ?? null,
              },
            });
            let seq = 0;
            for (const op of item.operations) {
              const opCode = csvColumnToOperation.get(op.operation);
              if (!opCode) throw new Error(`unmapped operations[].operation "${op.operation}"`);
              await tx.componentOperation.create({
                data: {
                  componentId: component.id,
                  seq: ++seq,
                  operationId: refs.operationIdByCode.get(opCode)!,
                  sourcing: mapSourcing(op.type),
                  startedAt: isoDate(op.startDate),
                  finishedAt: isoDate(op.endDate),
                  status: inferOperationStatus(op.startDate, op.endDate),
                },
              });
            }
            if (item.qc.materialIdentification) {
              await tx.componentOperation.create({
                data: {
                  componentId: component.id,
                  seq: ++seq,
                  operationId: refs.operationIdByCode.get(mtcOp)!,
                  sourcing: mapSourcing(item.qc.materialIdentification),
                  status: OperationStatus.NOT_STARTED,
                },
              });
            }
          }
        }

        // 3 of qcp-templates-batch2.json's 6 templates are hinted to DE0467
        // (see prisma/seed.ts's own comment on this file for the source).
        for (const t of qcpBatch2.templates.filter((t) => t.jobNumberHint === "DE0467")) {
          await seedQcpTemplate(tx, refs, {
            jobId: jobIdByNumber.get("DE0467") ?? null,
            jobLabel: t.jobLabel,
            vessel: t.vessel,
            designCode: t.designCode,
            parties: t.parties,
            items: t.items,
          });
        }
        console.log(`Seeded DE0467: job ${jobRow.id}, client ${client.id}.`);
      } else {
        console.log("DE0467 already exists — skipped.");
      }
    },
    { timeout: 300_000, maxWait: 15_000 },
  );

  await prisma.$transaction(
    async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
      const refs = await loadRefIds(tx, org.id);
      const existingDespl320 = await tx.job.findFirst({ where: { tenantId: org.id, jobNumber: "DESPL-320" } });
      const client = await tx.client.findFirst({
        where: { tenantId: org.id, name: { startsWith: "Unknown client — pending DESPL confirmation" } },
      });

      if (!existingDespl320) {
        const pilotLabel = qcpFile.template.job;
        const serialRange = pilotLabel.match(/(\d+)\s*to\s*(\d+)/);
        const pilotJob = await tx.job.create({
          data: {
            tenantId: org.id,
            publicId: randomUUID(),
            clientId: client!.id,
            familyId: refs.familyIdByCode.get("PRESSURE_VESSEL")!,
            templateVersionId: refs.pvVersionId,
            calendarId: refs.calendarId,
            jobNumber: "DESPL-320",
            projectName: qcpFile.template.vessel,
            designCode: qcpFile.template.designCode,
            remarks:
              `Pilot job derived from the QCP document header "${pilotLabel}". ` +
              "Client, PO reference and contractual delivery date are not present in any " +
              "source document — pending DESPL.",
          },
        });
        await tx.jobProcess.createMany({
          data: refs.templateProcesses.map((tp) => ({
            jobId: pilotJob.id,
            templateProcessId: tp.id,
            seq: tp.seq,
            code: tp.code,
            name: tp.name,
            departmentId: tp.defaultDepartmentId,
            durationMinDays: tp.durationMinDays,
            durationMaxDays: tp.durationMaxDays,
            envelopeFinishByMinDays: tp.envelopeFinishByMinDays,
            envelopeFinishByMaxDays: tp.envelopeFinishByMaxDays,
            envelopeStartByMinDays: tp.envelopeStartByMinDays,
            envelopeStartByMaxDays: tp.envelopeStartByMaxDays,
            workOrderStages: tp.workOrderStages,
          })),
        });
        const pilotProcesses = await tx.jobProcess.findMany({ where: { jobId: pilotJob.id } });
        const pilotJpIdByCode = new Map(pilotProcesses.map((p) => [p.code, p.id]));
        await tx.jobProcessEdge.createMany({
          data: leadTime.processes.flatMap((p) =>
            p.edges.map((e) => ({
              processId: pilotJpIdByCode.get(String(p.code))!,
              predecessorId: pilotJpIdByCode.get(String(e.predecessor))!,
              type: e.type as ProcessEdgeType,
              lagDays: e.lagDays,
            })),
          ),
        });
        const pilotEquipment = await tx.equipment.create({
          data: { jobId: pilotJob.id, name: qcpFile.template.vessel, blockNo: 1 },
        });
        const from = serialRange ? Number(serialRange[1]) : 1;
        const to = serialRange ? Number(serialRange[2]) : 1;
        await tx.unit.createMany({
          data: Array.from({ length: to - from + 1 }, (_, i) => ({
            equipmentId: pilotEquipment.id,
            serialNo: `320SR${String(from + i).padStart(2, "0")}`,
          })),
        });
        await seedQcpTemplate(tx, refs, {
          jobId: pilotJob.id,
          jobLabel: pilotLabel,
          vessel: qcpFile.template.vessel,
          revision: qcpFile.template.revision,
          designCode: qcpFile.template.designCode,
          parties: qcpFile.template.parties,
          items: qcpFile.template.items,
          jobProcessIdByCode: pilotJpIdByCode,
        });
        console.log(`Seeded DESPL-320: job ${pilotJob.id}, ${to - from + 1} units.`);
      } else {
        console.log("DESPL-320 already exists — skipped.");
      }
    },
    { timeout: 300_000, maxWait: 15_000 },
  );

  console.log("Done. Next: run `pnpm db:bootstrap DESPL-320` and `pnpm db:bootstrap DE0467` to generate schedules.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
