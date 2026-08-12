// Step 6 seed script — loads seed/*.json (never hand-typed) into the reference
// spine (Department/LeadTimeProcess/ProcessEdge/ProcessDepartment), the two
// live jobs (Client/Job/Equipment/BomItem/Procurement/ItemOperation), and the
// DESPL-320 QCP template (QcpTemplate/InspectionParty/QcpItem/QcpItemPartyCode).
//
// Out of scope per the Step 6 plan: Unit, ProjectSchedule, ProjectProcessPlan,
// QcpExecution, AssemblyDrawing, DelayReason, MaterialIdentification, ItemTest
// (no source data for any of these in this pass).
import "dotenv/config"; // `pnpm db:seed` runs tsx directly, not via `prisma db seed` (which loads .env itself)
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  ProcessEdgeType,
  ProcurementStatus,
  MaterialReceivedStatus,
  Sourcing,
  CanonicalOperation,
  ItemOperationStatus,
  QcpItemKind,
  QcpCode,
} from "../src/generated/prisma/enums";

const prisma = new PrismaClient();

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, "..", "seed", file), "utf-8")) as T;
}

// ── minimal shapes for what we actually read from each seed file ──────────

interface LeadTimeModel {
  departments: { code: string; name: string; scope: string | null }[];
  processes: {
    code: number;
    name: string;
    mainActivities: string | null;
    durationDays: { minDays: number; maxDays: number };
    cumulativePrinted: string | null;
    defaultDepartment: string;
    workOrderStages: number[];
    envelope: {
      finishByMinDays: number;
      finishByMaxDays: number;
      startByMinDays: number;
      startByMaxDays: number;
    };
    edges: { predecessor: number; type: string; lagDays: number }[];
  }[];
}

interface DataIssue {
  type: string;
  where: string;
  note: string;
}
interface DataIssuesFile {
  issues: DataIssue[];
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
    dispatchDate: string;
    equipmentBlocks: { blockNo: number; items: LiveBomItem[] }[];
  }[];
}

interface ComponentRoutesFile {
  canonicalOperations: Record<
    string,
    { dept: string; csvColumn: string | null; leadTimeProcess: number }
  >;
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

// ── small translation/parsing helpers ──────────────────────────────────────

function findIssue(issues: DataIssue[], type: string, whereContains: string): DataIssue {
  const matches = issues.filter((i) => i.type === type && i.where.includes(whereContains));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${type} issue matching "${whereContains}", found ${matches.length}`);
  }
  return matches[0];
}

function findIssueOptional(issues: DataIssue[], type: string, whereContains: string): DataIssue | undefined {
  const matches = issues.filter((i) => i.type === type && i.where.includes(whereContains));
  if (matches.length > 1) {
    throw new Error(`expected at most one ${type} issue matching "${whereContains}", found ${matches.length}`);
  }
  return matches[0];
}

// dd.mm.yyyy tokens, in order of appearance — handles both clean single dates
// and the DE0467 compound/ranged strings uniformly (no per-job special-casing)
function extractDMYDates(raw: string): Date[] {
  return [...raw.matchAll(/(\d{2})\.(\d{2})\.(\d{4})/g)].map(
    ([, dd, mm, yyyy]) => new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))),
  );
}
function firstDate(raw: string): Date {
  const dates = extractDMYDates(raw);
  if (dates.length === 0) throw new Error(`no dd.mm.yyyy date found in "${raw}"`);
  return dates[0];
}
function lastDate(raw: string): Date {
  const dates = extractDMYDates(raw);
  if (dates.length === 0) throw new Error(`no dd.mm.yyyy date found in "${raw}"`);
  return dates[dates.length - 1];
}
function isoDate(raw: string | null): Date | null {
  return raw ? new Date(`${raw}T00:00:00.000Z`) : null;
}

const CLEAN_DMY = /^\d{2}\.\d{2}\.\d{4}$/;

// job-number-mismatch note is common to both jobs; NO_PLANNED_DATES/NO_OWNER
// are file-wide (Contradiction A resolution: short append to Job.remarks,
// full weight carried as the code comment on ItemOperation/ProjectProcessPlan
// below since those target models aren't seeded this pass)
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

const PROCUREMENT_STATUS_MAP: Record<string, ProcurementStatus> = {
  "Indent Approved": ProcurementStatus.INDENT_APPROVED,
  "PO Placed": ProcurementStatus.PO_PLACED,
  "In Stock": ProcurementStatus.IN_STOCK,
};
function mapProcurementStatus(raw: string | null): ProcurementStatus {
  if (!raw) return ProcurementStatus.NOT_STARTED;
  const mapped = PROCUREMENT_STATUS_MAP[raw];
  if (!mapped) throw new Error(`unknown Procurement.status "${raw}"`);
  return mapped;
}

const RECEIVED_STATUS_MAP: Record<string, MaterialReceivedStatus> = {
  Received: MaterialReceivedStatus.RECEIVED,
  "Not Received": MaterialReceivedStatus.NOT_RECEIVED,
  "Partially Received": MaterialReceivedStatus.PARTIALLY_RECEIVED,
};
function mapReceivedStatus(raw: string | null): MaterialReceivedStatus | null {
  if (!raw) return null;
  const mapped = RECEIVED_STATUS_MAP[raw];
  if (!mapped) throw new Error(`unknown Procurement.receivedStatus "${raw}"`);
  return mapped;
}

const SOURCING_MAP: Record<string, Sourcing> = {
  "In-house": Sourcing.IN_HOUSE,
  Outsource: Sourcing.OUTSOURCE,
  "N/A": Sourcing.NA,
};
function mapSourcing(raw: string): Sourcing {
  const mapped = SOURCING_MAP[raw];
  if (!mapped) throw new Error(`unknown Sourcing value "${raw}"`);
  return mapped;
}

function inferOperationStatus(startDate: string | null, endDate: string | null): ItemOperationStatus {
  if (endDate) return ItemOperationStatus.COMPLETE;
  if (startDate) return ItemOperationStatus.IN_PROGRESS;
  return ItemOperationStatus.NOT_STARTED;
}

const QCP_CODE_MAP: Record<string, QcpCode> = {
  P: QcpCode.P,
  W: QcpCode.W,
  H: QcpCode.H,
  R: QcpCode.R,
  RW: QcpCode.RW,
  "R&A": QcpCode.R_AND_A,
};
function mapQcpCode(raw: string): QcpCode {
  const mapped = QCP_CODE_MAP[raw];
  if (!mapped) throw new Error(`unknown QcpCode "${raw}"`);
  return mapped;
}

// srNo dedup (mandatory — 62 QcpItem rows, only 43 unique srNo; @@unique([qcpTemplateId, srNo])
// would throw without this): 1st occurrence keeps the raw value, 2nd -> "b", 3rd -> "c", ...
function makeSrNoDeduper() {
  const counts = new Map<string, number>();
  return (raw: string): string => {
    const n = (counts.get(raw) ?? 0) + 1;
    counts.set(raw, n);
    return n === 1 ? raw : raw + String.fromCharCode(96 + n);
  };
}

async function main() {
  const leadTime = readJson<LeadTimeModel>("lead-time-model.json");
  const dataIssues = readJson<DataIssuesFile>("data-issues.json");
  const liveJobs = readJson<LiveJobsFile>("live-jobs.json");
  const componentRoutes = readJson<ComponentRoutesFile>("component-routes.json");
  const qcpTemplateFile = readJson<QcpTemplatesFile>("qcp-templates.json");
  const issues = dataIssues.issues;

  // sanity check (static, no db needed): every dept referenced by
  // component-routes.json resolves to a lead-time-model.json department
  const departmentCodes = new Set(leadTime.departments.map((d) => d.code));
  for (const [opCode, meta] of Object.entries(componentRoutes.canonicalOperations)) {
    if (!departmentCodes.has(meta.dept)) {
      throw new Error(`component-routes.json canonicalOperations.${opCode}.dept "${meta.dept}" is not a known department`);
    }
  }

  // csvColumn -> CanonicalOperation crosswalk, derived from component-routes.json
  // (not hand-typed) — "Material Identification" resolves to MTC_VERIFICATION,
  // which is how the FIELD_MISUSE fix below routes qc.materialIdentification.
  const csvColumnToOperation = new Map<string, CanonicalOperation>();
  for (const [opCode, meta] of Object.entries(componentRoutes.canonicalOperations)) {
    if (meta.csvColumn && !meta.csvColumn.includes("|")) {
      csvColumnToOperation.set(meta.csvColumn, opCode as CanonicalOperation);
    }
  }
  const mtcVerificationOp = csvColumnToOperation.get("Material Identification");
  if (!mtcVerificationOp) throw new Error("component-routes.json missing a csvColumn mapping to MTC_VERIFICATION");

  await prisma.$transaction(
    async (tx) => {
      // 1. Department
      await tx.department.createMany({
        data: leadTime.departments.map((d) => ({ code: d.code, name: d.name, scope: d.scope })),
      });

      // 2. LeadTimeProcess
      await tx.leadTimeProcess.createMany({
        data: leadTime.processes.map((p) => ({
          code: p.code,
          name: p.name,
          mainActivities: p.mainActivities,
          durationMinDays: p.durationDays.minDays,
          durationMaxDays: p.durationDays.maxDays,
          cumulativePrinted: p.cumulativePrinted,
          defaultDepartmentCode: p.defaultDepartment,
          workOrderStages: p.workOrderStages,
          envelopeFinishByMinDays: p.envelope.finishByMinDays,
          envelopeFinishByMaxDays: p.envelope.finishByMaxDays,
          envelopeStartByMinDays: p.envelope.startByMinDays,
          envelopeStartByMaxDays: p.envelope.startByMaxDays,
        })),
      });

      // 3. ProcessEdge (lagDays kept as-is, including negative — invariant #11:
      // a negative lag only permits concurrent *start*, enforced later in
      // StageService, never relaxed here)
      await tx.processEdge.createMany({
        data: leadTime.processes.flatMap((p) =>
          p.edges.map((e) => ({
            processCode: p.code,
            predecessorCode: e.predecessor,
            type: e.type as ProcessEdgeType,
            lagDays: e.lagDays,
          })),
        ),
      });

      // 4. ProcessDepartment (derived: seeded owner == default owner)
      await tx.processDepartment.createMany({
        data: leadTime.processes.map((p) => ({ processCode: p.code, departmentCode: p.defaultDepartment })),
      });

      // 5. Client (GAP: no client/customer name anywhere in live-jobs.json;
      // do not fabricate a real company name — see CLAUDE.md "fabricate vs flag")
      const client = await tx.client.create({
        data: {
          name: "Unknown client — pending DESPL confirmation (entangled with workOrderNoInFile 'DE0455-01', see Job.remarks)",
          code: null,
        },
      });

      // 6-11. Job -> Equipment -> BomItem -> Procurement -> ItemOperation
      for (const job of liveJobs.jobs) {
        const jobRow = await tx.job.create({
          data: {
            jobNumber: job.job,
            clientId: client.id,
            orderDate: firstDate(job.orderGenerateDate),
            deliveryDate: lastDate(job.dispatchDate),
            workOrderNoInFile: job.workOrderNoInFile,
            remarks: buildJobRemarks(issues, job.job, job.orderGenerateDate, job.dispatchDate),
          },
        });

        for (const block of job.equipmentBlocks) {
          const blockIssue = findIssue(issues, "UNLABELLED_BLOCK", `${job.job} block ${block.blockNo}`);
          const equipment = await tx.equipment.create({
            data: {
              jobId: jobRow.id,
              name: `${job.job}-B${block.blockNo}`,
              blockNo: block.blockNo,
              remarks: blockIssue.note,
            },
          });

          for (const item of block.items) {
            const ambiguousDate = findIssueOptional(issues, "AMBIGUOUS_DATE", `${job.job} item${item.itemNo} `);
            const bomItem = await tx.bomItem.create({
              data: {
                equipmentId: equipment.id,
                itemNo: item.itemNo,
                blockNo: block.blockNo,
                partName: item.partName,
                description: item.description || null,
                material: item.material || null,
                qty: item.qty,
                unit: item.unit,
                remarks: ambiguousDate ? ambiguousDate.note : item.remarks,
              },
            });

            await tx.procurement.create({
              data: {
                bomItemId: bomItem.id,
                indentNo: item.procurement.indentNo,
                indentDate: isoDate(item.procurement.indentGenerateDate),
                approvedDate: isoDate(item.procurement.indentApprovedDate),
                status: mapProcurementStatus(item.procurement.status),
                poNo: item.procurement.poNo,
                poDate: isoDate(item.procurement.poDate),
                receivedStatus: mapReceivedStatus(item.procurement.materialReceivedStatus),
                receivedDate: isoDate(item.procurement.materialReceivedDate),
              },
            });

            // operations[] as recorded in the live CSV (Cutting/Bending/Machining
            // only occur in this dataset; the full route-skeleton join against
            // component-routes.json is deferred — needs BomItem.componentType
            // classification, which has no source field this pass)
            for (const op of item.operations) {
              const operation = csvColumnToOperation.get(op.operation);
              if (!operation) throw new Error(`unmapped operations[].operation "${op.operation}"`);
              await tx.itemOperation.create({
                data: {
                  bomItemId: bomItem.id,
                  operation,
                  sourcing: mapSourcing(op.type),
                  startDate: isoDate(op.startDate),
                  endDate: isoDate(op.endDate),
                  status: inferOperationStatus(op.startDate, op.endDate),
                },
              });
            }

            // FIELD_MISUSE fix: qc.materialIdentification (In-house/Outsource/N/A)
            // is a Sourcing value, not traceability data (MaterialIdentification.heatNumber
            // is unrelated and gets zero rows this pass) — route it onto a synthesized
            // MTC_VERIFICATION ItemOperation instead, per seed/data-issues.json.
            if (item.qc.materialIdentification) {
              await tx.itemOperation.create({
                data: {
                  bomItemId: bomItem.id,
                  operation: mtcVerificationOp,
                  sourcing: mapSourcing(item.qc.materialIdentification),
                  status: ItemOperationStatus.NOT_STARTED,
                },
              });
            }
          }
        }
      }

      // 12. QcpTemplate (jobId left null — "DESPL-320-01 to 09" is CLAUDE.md's
      // separate 9-unit pilot job, does not resolve to DE0463/DE0467; the
      // schema comment claiming a data-issues.json entry documents this is a
      // doc/data gap — no such entry exists, not fabricated here)
      const qcpTemplate = await tx.qcpTemplate.create({
        data: {
          jobId: null,
          jobLabel: qcpTemplateFile.template.job,
          vessel: qcpTemplateFile.template.vessel,
          revision: qcpTemplateFile.template.revision,
          designCode: qcpTemplateFile.template.designCode,
        },
      });

      // 13. InspectionParty
      const partyIdByCode = new Map<string, number>();
      for (const code of qcpTemplateFile.template.parties) {
        const party = await tx.inspectionParty.create({
          data: { qcpTemplateId: qcpTemplate.id, code, name: null },
        });
        partyIdByCode.set(code, party.id);
      }

      // 14. QcpItem (SECTION + CHECKPOINT, srNo deduped) + 15. QcpItemPartyCode
      const dedupeSrNo = makeSrNoDeduper();
      const partyCodeRows: { qcpItemId: number; inspectionPartyId: number; code: QcpCode }[] = [];
      for (const item of qcpTemplateFile.template.items) {
        const qcpItem = await tx.qcpItem.create({
          data: {
            qcpTemplateId: qcpTemplate.id,
            srNo: dedupeSrNo(item.srNo),
            kind: item.kind as QcpItemKind,
            section: item.section ?? null,
            activity: item.activity,
            characteristic: item.characteristic ?? null,
            extentOfCheck: item.extentOfCheck ?? null,
            applicableDocument: item.applicableDocument ?? null,
            acceptanceCriteria: item.acceptanceCriteria ?? null,
            record: item.record ?? null,
            remarks: item.remarks || null,
            leadTimeProcessCodes: item.leadTimeProcesses ?? [],
          },
        });

        if (item.kind === "CHECKPOINT" && item.codes) {
          for (const [partyCode, code] of Object.entries(item.codes)) {
            const inspectionPartyId = partyIdByCode.get(partyCode);
            if (!inspectionPartyId) throw new Error(`QcpItem ${item.srNo}: unknown party code "${partyCode}"`);
            partyCodeRows.push({ qcpItemId: qcpItem.id, inspectionPartyId, code: mapQcpCode(code) });
          }
        }
      }
      if (partyCodeRows.length > 0) {
        await tx.qcpItemPartyCode.createMany({ data: partyCodeRows });
      }
    },
    { timeout: 60_000, maxWait: 10_000 },
  );

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
