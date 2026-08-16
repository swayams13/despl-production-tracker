// Seed script — loads seed/*.json (never hand-typed) into the redesigned schema.
//
// What this seeds, and where each piece comes from:
//   Organization/Department/Role      derived from lead-time-model.json + PRD §4
//   Reference vocabularies            derived from component-routes.json,
//                                     qcp-templates.json, live-jobs.json
//   ProductFamily x4                  the four families DESPL manufactures
//   PRESSURE_VESSEL template v1       the 36 processes + 39 fitted edges
//   Route library (25 routes)         component-routes.json — this reached NO
//                                     table at all in the previous schema
//   Live jobs DE0463 / DE0467         live-jobs.json
//   Pilot job DESPL-320 (9 units)     derived from the real QCP document
//   QCP template + dynamic parties    qcp-templates.json, including the code
//                                     semantics that were previously trapped
//                                     in JSON (blocksCompletion/requiresCall/
//                                     waivable) and would have had to be
//                                     hard-coded into the gating engine
//
// Runs as the table owner, so RLS does not apply here (tables are ENABLE, not
// FORCE ROW LEVEL SECURITY). The application connects as a non-owner role.
//
// Helpers fail loud: an unknown source value throws rather than defaulting.
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import {
  ProcessEdgeType,
  ProcurementStatus,
  MaterialReceivedStatus,
  Sourcing,
  OperationStatus,
  QcpItemKind,
  TemplateStatus,
  SnapshotCadence,
} from "../src/generated/prisma/enums";

// Seeding connects as the table OWNER (DIRECT_URL), not the application role.
// The owner is not subject to RLS, so the seed can create the tenant and its
// rows before any app.tenant_id exists.
const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, "..", "seed", file), "utf-8")) as T;
}

// ── source file shapes (only what we read) ────────────────────────────────

interface LeadTimeModel {
  calendarBasis: { value: string; weekOff: string[] };
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
    projectName: string;
    dispatchDate: string;
    qty: string;
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
    assemblyProcesses: { process: string }[];
    /// Staged/partial dispatch dates, raw dd.mm.yyyy strings — only DE0463 has
    /// these; see seed/live-jobs.json's top-level `note` for how they were found.
    dispatchBatches?: string[];
  }[];
}

interface ComponentRoutesFile {
  canonicalOperations: Record<
    string,
    { label: string; dept: string; csvColumn: string | null; leadTimeProcess: number }
  >;
  routes: {
    componentType: string;
    printedRoute: string;
    operations: { seq: number; printed: string; operation: string }[];
  }[];
}

interface QcpCodeMeta {
  label: string;
  blocksCompletion: boolean;
  requiresCall: boolean;
  waivable?: boolean;
  desc?: string;
  TODO?: string;
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
/// Extracted from a docx via structural XML table parsing (w:tbl/w:tr/w:tc,
/// gridSpan/vMerge-aware) — see seed/qcp-templates-batch2.json's `note` for
/// how, and `issues[]` for any row the extractor couldn't confidently align
/// rather than silently guess.
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
  key: string;
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

/// A process ROUTE derived from a QAP's activity sequence, not a lead-time
/// document — see seed/pipe-spool-template.json's own `note` for why every
/// process it lists is provisional.
interface ProvisionalTemplateFile {
  family: string;
  processes: { seq: number; code: string; name: string; department: string; derivedFrom: string }[];
}

interface QcpTemplatesFile {
  model: { codes: Record<string, QcpCodeMeta> };
  template: {
    job: string;
    vessel: string;
    revision: number;
    designCode: string;
    parties: string[];
    items: QcpTemplateItem[];
  };
}

// ── helpers (fail loud) ───────────────────────────────────────────────────

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

/// dd.mm.yyyy tokens in order of appearance — handles both clean single dates
/// and DE0467's compound/ranged strings without per-job special-casing.
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

function buildJobRemarks(
  issues: DataIssue[],
  jobNumber: string,
  rawOrder: string,
  rawDispatch: string,
): string {
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
  const m = PROCUREMENT_STATUS_MAP[raw];
  if (!m) throw new Error(`unknown Procurement.status "${raw}"`);
  return m;
}

const RECEIVED_STATUS_MAP: Record<string, MaterialReceivedStatus> = {
  Received: MaterialReceivedStatus.RECEIVED,
  "Not Received": MaterialReceivedStatus.NOT_RECEIVED,
  "Partially Received": MaterialReceivedStatus.PARTIALLY_RECEIVED,
};
function mapReceivedStatus(raw: string | null): MaterialReceivedStatus | null {
  if (!raw) return null;
  const m = RECEIVED_STATUS_MAP[raw];
  if (!m) throw new Error(`unknown Procurement.receivedStatus "${raw}"`);
  return m;
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

/// C10 default: "manual with keyword suggestion". The keywords ARE the
/// component-type codes from component-routes.json, so nothing is hand-authored
/// here — a part name that matches no known type is left unclassified rather
/// than guessed.
function suggestComponentType(item: LiveBomItem, codes: string[]): string | null {
  const haystack = `${item.partName} ${item.description ?? ""}`.toUpperCase();
  const hits = codes
    .filter((code) => haystack.includes(code.replace(/_/g, " ")))
    // longest match wins: "TUBE SHEET" must beat "TUBE"
    .sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
}

// A transaction handle — the reference and demo phases share one atomic tx.
type Tx = Prisma.TransactionClient;

// The reference-data ids the demo phase needs to hang live jobs off. Returned
// by seedReference whether it just created them or found them already seeded,
// so the demo phase never re-queries.
interface RefIds {
  tenantId: number;
  deptIdByCode: Map<string, number>;
  roleIdByCode: Map<string, number>;
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

interface Sources {
  leadTime: LeadTimeModel;
  liveJobs: LiveJobsFile;
  routesFile: ComponentRoutesFile;
  qcpFile: QcpTemplatesFile;
  qcpBatch2: QcpBatchFile;
  pipeSpoolTemplate: ProvisionalTemplateFile;
  issues: DataIssue[];
}

/// Loads the reference ids the demo phase needs from an already-seeded tenant.
/// Used by BOTH seedReference paths (fresh create and idempotent skip) so the
/// RefIds shape is built in exactly one place.
async function loadRefIds(tx: Tx, tenantId: number): Promise<RefIds> {
  const [departments, roles, families, componentTypes, operations, drawingTypeRows, qcpCodes] =
    await Promise.all([
      tx.department.findMany({ where: { tenantId } }),
      tx.role.findMany({ where: { tenantId } }),
      tx.productFamily.findMany({ where: { tenantId } }),
      tx.componentTypeRef.findMany({ where: { tenantId } }),
      tx.operationRef.findMany({ where: { tenantId } }),
      tx.drawingTypeRef.findMany({ where: { tenantId } }),
      tx.qcpCodeRef.findMany({ where: { tenantId } }),
    ]);
  const familyIdByCode = new Map(families.map((f) => [f.code, f.id]));

  const calendar = await tx.workCalendar.findFirstOrThrow({
    where: { tenantId, isDefault: true },
  });

  // the PUBLISHED v1 of the PRESSURE_VESSEL template is the spine live jobs pin to
  const pvTemplate = await tx.processTemplate.findFirstOrThrow({
    where: { tenantId, familyId: familyIdByCode.get("PRESSURE_VESSEL")! },
  });
  const pvVersion = await tx.processTemplateVersion.findFirstOrThrow({
    where: { templateId: pvTemplate.id, version: 1 },
  });
  const templateProcesses = await tx.templateProcess.findMany({
    where: { versionId: pvVersion.id },
  });

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
    deptIdByCode: new Map(departments.map((d) => [d.code, d.id])),
    roleIdByCode: new Map(roles.map((r) => [r.code, r.id])),
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

/// Production-safe reference seed: organizations, departments, roles, the
/// reference vocabularies, work calendar, product families, the PRESSURE_VESSEL
/// + PIPE_SPOOL process templates, and the 25-route library. NO live-job or
/// user data (users carry the dev password — those belong to seedDemo).
///
/// Idempotent: `Organization.code` is @unique and every reference row is scoped
/// to that tenant, so an org-existence guard makes re-running a no-op — matching
/// the production flow `prisma migrate deploy && prisma db seed` run any number
/// of times. Reference/template *changes* propagate via a migration or a
/// dedicated update path, never by piling on another copy here.
async function seedReference(tx: Tx, src: Sources, stats: Record<string, number>): Promise<RefIds> {
  const { leadTime, liveJobs, routesFile, qcpFile, pipeSpoolTemplate } = src;

  // ── 1. Tenant (idempotency sentinel) ─────────────────────────────
  const existing = await tx.organization.findUnique({ where: { code: "DESPL" } });
  if (existing) {
    console.log("Reference data already present (org DESPL exists) — skipping reference seed.");
    return loadRefIds(tx, existing.id);
  }
  const org = await tx.organization.create({
    data: { code: "DESPL", name: "Dhruv EPC Solutions Pvt. Ltd." },
  });
  const tenantId = org.id;

  {
      // ── 2. Departments ───────────────────────────────────────────────
      await tx.department.createMany({
        data: leadTime.departments.map((d) => ({
          tenantId,
          code: d.code,
          name: d.name,
          scope: d.scope,
        })),
      });
      const departments = await tx.department.findMany({ where: { tenantId } });
      const deptIdByCode = new Map(departments.map((d) => [d.code, d.id]));
      stats.departments = departments.length;

      // ── 3. Roles (PRD §4) ────────────────────────────────────────────
      const roleDefs = [
        ["ADMIN", "Administrator"],
        ["MANAGEMENT", "MD / CEO"],
        ["PRODUCTION_HEAD", "Production Head"],
        ["SUPERVISOR", "Department Supervisor"],
        ["QC", "QC Inspector"],
        ["CLIENT_VIEWER", "Client (read-only)"],
      ];
      await tx.role.createMany({
        data: roleDefs.map(([code, name]) => ({ tenantId, code, name })),
      });
      stats.roles = await tx.role.count({ where: { tenantId } });

      // ── 4. Reference vocabularies ────────────────────────────────────
      // component types: the 25 routed types from component-routes.json, plus
      // OTHER for unclassifiable BOM lines
      const componentTypeCodes = [...routesFile.routes.map((r) => r.componentType), "OTHER"];
      await tx.componentTypeRef.createMany({
        data: componentTypeCodes.map((code) => ({
          tenantId,
          code,
          name: code
            .split("_")
            .map((w) => w[0] + w.slice(1).toLowerCase())
            .join(" "),
        })),
      });
      const componentTypes = await tx.componentTypeRef.findMany({ where: { tenantId } });
      const componentTypeIdByCode = new Map(componentTypes.map((c) => [c.code, c.id]));
      stats.componentTypes = componentTypes.length;

      // operations: the 16 canonical operations, each with its owning department
      await tx.operationRef.createMany({
        data: Object.entries(routesFile.canonicalOperations).map(([code, meta]) => ({
          tenantId,
          code,
          name: meta.label,
          defaultDepartmentId: deptIdByCode.get(meta.dept)!,
          sourceColumn: meta.csvColumn,
        })),
      });
      const operations = await tx.operationRef.findMany({ where: { tenantId } });
      const operationIdByCode = new Map(operations.map((o) => [o.code, o.id]));
      stats.operations = operations.length;

      // NDT / test methods. The first six are the assemblyProcesses actually
      // present in live-jobs.json. PAUT/TOFD/MPT/LPT are named throughout the
      // real QCP activity text and had no home in the old 6-value enum.
      const testTypesFromLive = liveJobs.jobs[0].assemblyProcesses.map((p) => {
        const abbrev = p.process.match(/\(([^)]+)\)/)?.[1];
        return { code: abbrev ?? p.process.toUpperCase().replace(/\s+/g, "_"), name: p.process };
      });
      const testTypesFromQcp = [
        { code: "PAUT", name: "Phased Array Ultrasonic Testing" },
        { code: "TOFD", name: "Time of Flight Diffraction" },
        { code: "MPT", name: "Magnetic Particle Testing" },
        { code: "LPT", name: "Liquid Penetrant Testing" },
      ];
      await tx.testTypeRef.createMany({
        data: [...testTypesFromLive, ...testTypesFromQcp].map((t) => ({ tenantId, ...t })),
      });
      stats.testTypes = testTypesFromLive.length + testTypesFromQcp.length;

      // drawing types: derived from the assemblyDrawings present in live-jobs
      const drawingTypes = liveJobs.jobs[0].assemblyDrawings.map((d) => ({
        code: d.name
          .replace(/\([^)]*\)/g, "")
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_")
          .replace(/^_|_$/g, ""),
        name: d.name,
      }));
      await tx.drawingTypeRef.createMany({
        data: drawingTypes.map((d) => ({ tenantId, ...d })),
      });
      stats.drawingTypes = await tx.drawingTypeRef.count({ where: { tenantId } });

      // delay categories (PRD FR-D2)
      const delayCategories = [
        ["MATERIAL_DELAY", "Material delay"],
        ["MANPOWER", "Manpower"],
        ["MACHINE_BREAKDOWN", "Machine breakdown"],
        ["REWORK_QUALITY", "Rework / quality"],
        ["CLIENT_HOLD", "Client hold"],
        ["DRAWING_ENGINEERING_HOLD", "Drawing / engineering hold"],
        ["OTHER", "Other"],
      ];
      await tx.delayCategoryRef.createMany({
        data: delayCategories.map(([code, name]) => ({ tenantId, code, name })),
      });
      stats.delayCategories = delayCategories.length;

      // QCP codes WITH their gating semantics, straight from the source file.
      // These flags previously existed only in JSON, which would have forced
      // the hold-point engine to hard-code them — and C7 (what RW and R&A
      // mean) is still open with DESPL, so they must stay editable.
      await tx.qcpCodeRef.createMany({
        data: Object.entries(qcpFile.model.codes).map(([code, meta]) => ({
          tenantId,
          code,
          label: meta.label,
          blocksCompletion: meta.blocksCompletion,
          requiresCall: meta.requiresCall,
          waivable: meta.waivable ?? false,
        })),
      });
      stats.qcpCodes = await tx.qcpCodeRef.count({ where: { tenantId } });

      // ── 5. Work calendar (C1 — still the highest-impact open question) ──
      const weekOffMap: Record<string, number> = {
        MON: 1,
        TUE: 2,
        WED: 3,
        THU: 4,
        FRI: 5,
        SAT: 6,
        SUN: 7,
      };
      await tx.workCalendar.create({
        data: {
          tenantId,
          code: leadTime.calendarBasis.value,
          name: "Default — 6-day week, Sunday off (C1 pending DESPL confirmation)",
          weekOffDays: leadTime.calendarBasis.weekOff.map((d) => weekOffMap[d]),
          isDefault: true,
        },
      });

      // ── 6. Product families ──────────────────────────────────────────
      const familyDefs = [
        ["PRESSURE_VESSEL", "Pressure Vessels"],
        ["HEAT_EXCHANGER", "Heat Exchangers"],
        ["PIPE_SPOOL", "Pipe Spools"],
        ["PIPING_SYSTEM", "Piping Systems"],
      ];
      await tx.productFamily.createMany({
        data: familyDefs.map(([code, name]) => ({ tenantId, code, name })),
      });
      const families = await tx.productFamily.findMany({ where: { tenantId } });
      const familyIdByCode = new Map(families.map((f) => [f.code, f.id]));
      stats.productFamilies = families.length;

      // ── 7. PRESSURE_VESSEL process template v1 (the 36-process spine) ──
      const pvTemplate = await tx.processTemplate.create({
        data: {
          tenantId,
          familyId: familyIdByCode.get("PRESSURE_VESSEL")!,
          name: "DESPL standard pressure vessel — Lead Time table",
        },
      });
      const pvV1 = await tx.processTemplateVersion.create({
        data: {
          templateId: pvTemplate.id,
          version: 1,
          status: TemplateStatus.PUBLISHED,
          publishedAt: new Date(),
          notes:
            "Seeded from seed/lead-time-model.json (DESPL Lead Time.pdf, 11 Aug 2026). " +
            "Printed total ~17 weeks; envelope is authoritative, DAG lags are fitted to it.",
        },
      });

      await tx.templateProcess.createMany({
        data: leadTime.processes.map((p) => ({
          versionId: pvV1.id,
          seq: p.code,
          code: String(p.code),
          name: p.name,
          mainActivities: p.mainActivities,
          durationMinDays: p.durationDays.minDays,
          durationMaxDays: p.durationDays.maxDays,
          cumulativePrinted: p.cumulativePrinted,
          defaultDepartmentId: deptIdByCode.get(p.defaultDepartment)!,
          workOrderStages: p.workOrderStages,
          envelopeFinishByMinDays: p.envelope.finishByMinDays,
          envelopeFinishByMaxDays: p.envelope.finishByMaxDays,
          envelopeStartByMinDays: p.envelope.startByMinDays,
          envelopeStartByMaxDays: p.envelope.startByMaxDays,
        })),
      });
      const templateProcesses = await tx.templateProcess.findMany({ where: { versionId: pvV1.id } });
      const tpIdByCode = new Map(templateProcesses.map((p) => [p.code, p.id]));
      stats.templateProcesses = templateProcesses.length;

      // lagDays kept as-is including negatives (invariant #11: a negative lag
      // permits concurrent START only, never out-of-order completion)
      await tx.templateEdge.createMany({
        data: leadTime.processes.flatMap((p) =>
          p.edges.map((e) => ({
            versionId: pvV1.id,
            processId: tpIdByCode.get(String(p.code))!,
            predecessorId: tpIdByCode.get(String(e.predecessor))!,
            type: e.type as ProcessEdgeType,
            lagDays: e.lagDays,
          })),
        ),
      });
      stats.templateEdges = await tx.templateEdge.count({ where: { versionId: pvV1.id } });

      // ── 7b. PIPE_SPOOL process template — provisional, no lead-time doc ──
      // Route derived from the (identical) Suction/Pressure Piping QAPs, not
      // a lead-time document — see seed/pipe-spool-template.json's `note`.
      // status: DRAFT (not PUBLISHED) — deliberately not ready for a real job
      // to pin against yet, on top of the process-level `provisional` flag.
      // PIPING_SYSTEM gets no template at all this pass: nothing in the QAPs
      // distinguishes shop-fabricated spools from site-erected piping.
      const psTemplate = await tx.processTemplate.create({
        data: {
          tenantId,
          familyId: familyIdByCode.get(pipeSpoolTemplate.family)!,
          name: "DESPL pipe spool — provisional route (derived from QAP, no lead-time data)",
        },
      });
      const psV1 = await tx.processTemplateVersion.create({
        data: {
          templateId: psTemplate.id,
          version: 1,
          status: TemplateStatus.DRAFT,
          notes:
            "Derived from seed/qcp-templates-batch2.json's Suction/Pressure Piping QAPs " +
            "(13 Aug 2026 handover), NOT a lead-time document. Every process is " +
            "provisional: true with null durations — see pipe-spool-template.json.",
        },
      });
      await tx.templateProcess.createMany({
        data: pipeSpoolTemplate.processes.map((p) => ({
          versionId: psV1.id,
          seq: p.seq,
          code: p.code,
          name: p.name,
          mainActivities: p.derivedFrom,
          defaultDepartmentId: deptIdByCode.get(p.department)!,
          workOrderStages: [],
          provisional: true,
        })),
      });
      const psProcesses = await tx.templateProcess.findMany({ where: { versionId: psV1.id } });
      const psIdBySeq = new Map(psProcesses.map((p) => [p.seq, p.id]));
      // strict finish-to-start chain, lagDays 0 — the honest "no known
      // concurrency" default; see pipe-spool-template.json's `edgeNote`.
      await tx.templateEdge.createMany({
        data: pipeSpoolTemplate.processes
          .filter((p) => p.seq > 1)
          .map((p) => ({
            versionId: psV1.id,
            processId: psIdBySeq.get(p.seq)!,
            predecessorId: psIdBySeq.get(p.seq - 1)!,
            type: ProcessEdgeType.FINISH_TO_START,
            lagDays: 0,
          })),
      });
      stats.pipeSpoolTemplateProcesses = psProcesses.length;
      stats.pipeSpoolTemplateEdges = await tx.templateEdge.count({ where: { versionId: psV1.id } });

      // ── 8. Component route library (25 routes) ───────────────────────
      // Previously present in seed/component-routes.json but modelled nowhere.
      let routeStepCount = 0;
      const routeVersionIdByType = new Map<string, number>();
      for (const route of routesFile.routes) {
        const rt = await tx.routeTemplate.create({
          data: {
            tenantId,
            componentTypeId: componentTypeIdByCode.get(route.componentType)!,
            familyId: null, // applies to every family until DESPL says otherwise
            name: `${route.componentType} standard route`,
          },
        });
        const rv = await tx.routeTemplateVersion.create({
          data: {
            routeId: rt.id,
            version: 1,
            status: TemplateStatus.PUBLISHED,
            printedRoute: route.printedRoute,
          },
        });
        routeVersionIdByType.set(route.componentType, rv.id);
        await tx.routeStep.createMany({
          data: route.operations.map((op) => ({
            routeVersionId: rv.id,
            seq: op.seq,
            operationId: operationIdByCode.get(op.operation)!,
            printed: op.printed,
          })),
        });
        routeStepCount += route.operations.length;
      }
      stats.routeTemplates = routesFile.routes.length;
      stats.routeSteps = routeStepCount;
  }

  return loadRefIds(tx, tenantId);
}

/// Dev-only demo data: the "Unknown client" placeholder, live jobs DE0463/DE0467
/// (BOM, procurement, components, operations, drawings, dispatch batches), the
/// DESPL-320 pilot job + units + its QCP, the batch2 QAP templates, and the
/// per-role / per-department demo users (well-known dev password). NEVER run
/// against production — production users are provisioned through a real
/// credential flow, and real jobs are created through the app, not seeded.
///
/// Guarded on DE0463 so re-running in dev can't pile on duplicate jobs.
async function seedDemo(
  tx: Tx,
  refs: RefIds,
  src: Sources,
  passwordHash: string,
  stats: Record<string, number>,
) {
  const { leadTime, liveJobs, routesFile, qcpFile, qcpBatch2, issues } = src;
  const {
    tenantId,
    deptIdByCode,
    roleIdByCode,
    familyIdByCode,
    componentTypeIdByCode,
    operationIdByCode,
    drawingTypeIdByName,
    qcpCodeIdByCode,
    routeVersionIdByType,
    templateProcesses,
  } = refs;
  const calendar = { id: refs.calendarId };
  const pvV1 = { id: refs.pvVersionId };

  if (await tx.job.findFirst({ where: { tenantId, jobNumber: "DE0463" } })) {
    console.log("Demo data already present (job DE0463 exists) — skipping demo seed.");
    return;
  }

  {
      // ── 9. Client ────────────────────────────────────────────────────
      // No client/customer name exists anywhere in live-jobs.json. Do not
      // fabricate one (CLAUDE.md: flag, don't fabricate).
      const client = await tx.client.create({
        data: {
          tenantId,
          name: "Unknown client — pending DESPL confirmation (entangled with workOrderNoInFile 'DE0455-01', see Job.remarks)",
          code: null,
        },
      });
      await tx.clientVisibilityPolicy.create({
        data: { clientId: client.id, cadence: SnapshotCadence.WEEKLY, requiresApproval: true },
      });

      const csvColumnToOperation = new Map<string, string>();
      for (const [opCode, meta] of Object.entries(routesFile.canonicalOperations)) {
        if (meta.csvColumn && !meta.csvColumn.includes("|")) {
          csvColumnToOperation.set(meta.csvColumn, opCode);
        }
      }
      const mtcOp = csvColumnToOperation.get("Material Identification");
      if (!mtcOp) throw new Error("component-routes.json has no csvColumn mapping to MTC_VERIFICATION");

      const routedTypeCodes = routesFile.routes.map((r) => r.componentType);
      let bomCount = 0;
      let componentCount = 0;
      let classifiedCount = 0;
      let componentOpCount = 0;
      let drawingsWithDatesCount = 0;
      let dispatchBatchCount = 0;
      // populated as each live job is created, so the batch2 QAP loader (§13)
      // can attach a template to an existing job without a second DB round trip
      const jobIdByNumber = new Map<string, number>();

      // ── 10. Live jobs ────────────────────────────────────────────────
      for (const job of liveJobs.jobs) {
        const jobRow = await tx.job.create({
          data: {
            tenantId,
            publicId: randomUUID(),
            clientId: client.id,
            familyId: familyIdByCode.get("PRESSURE_VESSEL")!,
            templateVersionId: pvV1.id,
            calendarId: calendar.id,
            jobNumber: job.job,
            clientOrderNo: job.workOrderNoInFile,
            projectName: job.projectName,
            orderDate: firstDate(job.orderGenerateDate),
            // EARLIEST of a committed window, not the latest. DE0467's source
            // dispatch field is a range ("15.10.2026 - 25.10.2026"); read as the
            // late end it is 14 working days short of DESPL's own lead time,
            // read as the early end, 22. The feasibility check exists to raise
            // that risk before an order is signed, so it must measure against
            // the date first promised. The full raw range is preserved verbatim
            // in `remarks` by buildJobRemarks below, so nothing is lost.
            deliveryDate: firstDate(job.dispatchDate),
            remarks: buildJobRemarks(issues, job.job, job.orderGenerateDate, job.dispatchDate),
          },
        });
        jobIdByNumber.set(jobRow.jobNumber, jobRow.id);

        // materialise the job's own editable copy of the process spine
        await tx.jobProcess.createMany({
          data: templateProcesses.map((tp) => ({
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

        for (const d of job.assemblyDrawings) {
          await tx.assemblyDrawing.create({
            data: {
              jobId: jobRow.id,
              drawingTypeId: drawingTypeIdByName.get(d.name)!,
              drawingNo: d.drawingNo,
              revisionNo: d.revNo ?? null,
              approvedDate: isoDate(d.approvalDate ?? null),
              releasedDate: isoDate(d.releasedDate ?? null),
              revisedDate: isoDate(d.revisedDate ?? null),
              remarks: d.remarks ?? null,
            },
          });
        }
        drawingsWithDatesCount += job.assemblyDrawings.filter((d) => d.approvalDate).length;

        // staged/partial dispatch dates — DE0463 only, see interface comment
        if (job.dispatchBatches?.length) {
          await tx.dispatchBatch.createMany({
            data: job.dispatchBatches.map((raw, i) => ({
              jobId: jobRow.id,
              seq: i + 1,
              plannedDate: firstDate(raw),
            })),
          });
          dispatchBatchCount += job.dispatchBatches.length;
        }

        for (const block of job.equipmentBlocks) {
          const blockIssue = findIssue(issues, "UNLABELLED_BLOCK", `${job.job} block ${block.blockNo}`);
          const equipment = await tx.equipment.create({
            data: {
              jobId: jobRow.id,
              name: block.label ?? `${job.job}-B${block.blockNo}`,
              blockNo: block.blockNo,
              remarks: blockIssue.note,
            },
          });

          for (const item of block.items) {
            const ambiguous = findIssueOptional(issues, "AMBIGUOUS_DATE", `${job.job} item${item.itemNo} `);
            const suggestedType = suggestComponentType(item, routedTypeCodes);
            if (suggestedType) classifiedCount++;

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
                componentTypeId: suggestedType
                  ? componentTypeIdByCode.get(suggestedType)!
                  : componentTypeIdByCode.get("OTHER")!,
                remarks: ambiguous ? ambiguous.note : item.remarks,
              },
            });
            bomCount++;

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

            // One component instance per BOM line for the live data. Where a
            // client orders N of something (5 vs 8 nozzles), the UI creates N
            // tagged components against the same BOM line — which is exactly
            // what the old ItemOperation shape could not express.
            const typeCode = suggestedType ?? "OTHER";
            const component = await tx.component.create({
              data: {
                equipmentId: equipment.id,
                bomItemId: bomItem.id,
                tag: `B${block.blockNo}-I${item.itemNo}`,
                componentTypeId: componentTypeIdByCode.get(typeCode)!,
                routeVersionId: routeVersionIdByType.get(typeCode) ?? null,
              },
            });
            componentCount++;

            let seq = 0;
            for (const op of item.operations) {
              const opCode = csvColumnToOperation.get(op.operation);
              if (!opCode) throw new Error(`unmapped operations[].operation "${op.operation}"`);
              await tx.componentOperation.create({
                data: {
                  componentId: component.id,
                  seq: ++seq,
                  operationId: operationIdByCode.get(opCode)!,
                  sourcing: mapSourcing(op.type),
                  startedAt: isoDate(op.startDate),
                  finishedAt: isoDate(op.endDate),
                  status: inferOperationStatus(op.startDate, op.endDate),
                },
              });
              componentOpCount++;
            }

            // FIELD_MISUSE (C8): qc.materialIdentification holds In-house /
            // Outsource / N/A — a SOURCING value, not traceability data. Route
            // it onto an MTC_VERIFICATION operation; real traceability lives in
            // MaterialIdentification (heat number + MTC), which has no source
            // data in these CSVs.
            if (item.qc.materialIdentification) {
              await tx.componentOperation.create({
                data: {
                  componentId: component.id,
                  seq: ++seq,
                  operationId: operationIdByCode.get(mtcOp)!,
                  sourcing: mapSourcing(item.qc.materialIdentification),
                  status: OperationStatus.NOT_STARTED,
                },
              });
              componentOpCount++;
            }
          }
        }
      }
      stats.bomItems = bomCount;
      stats.components = componentCount;
      stats.componentsClassified = classifiedCount;
      stats.componentOperations = componentOpCount;
      stats.drawingsWithDates = drawingsWithDatesCount;
      stats.dispatchBatches = dispatchBatchCount;

      // ── 11. Pilot job DESPL-320 + its QCP ────────────────────────────
      // Derived from the real QCP document header ("DESPL-320-01 to 09",
      // HP AIR RECEIVER). Client and delivery date are genuinely unknown and
      // are left null rather than invented.
      const pilotLabel = qcpFile.template.job;
      const serialRange = pilotLabel.match(/(\d+)\s*to\s*(\d+)/);
      const pilotJob = await tx.job.create({
        data: {
          tenantId,
          publicId: randomUUID(),
          clientId: client.id,
          familyId: familyIdByCode.get("PRESSURE_VESSEL")!,
          templateVersionId: pvV1.id,
          calendarId: calendar.id,
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
        data: templateProcesses.map((tp) => ({
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
      stats.pilotUnits = to - from + 1;

      // Shared by the pilot DESPL-320 template and the 6 templates loaded
      // from qcp-templates-batch2.json (§13) — same shape, same fail-loud
      // validation either way. `jobProcessIdByCode` is only ever supplied for
      // DESPL-320: the batch2 items have no leadTimeProcesses mapping (that
      // crosswalk was manually curated for the original document and doing
      // the same for ~300 new checkpoints was out of scope for this pass —
      // see the batch file's own `note`).
      async function seedQcpTemplate(spec: {
        jobId: number | null;
        jobLabel: string;
        vessel: string;
        revision?: number;
        designCode?: string | null;
        parties: string[];
        items: QcpBatchItem[];
        jobProcessIdByCode?: Map<string, number>;
      }) {
        const qcpTemplate = await tx.qcpTemplate.create({
          data: {
            jobId: spec.jobId,
            jobLabel: spec.jobLabel,
            vessel: spec.vessel,
            revision: spec.revision ?? 0,
            designCode: spec.designCode ?? null,
          },
        });

        const partyIdByCode = new Map<string, number>();
        for (const code of spec.parties) {
          const party = await tx.inspectionParty.create({
            data: { qcpTemplateId: qcpTemplate.id, code },
          });
          partyIdByCode.set(code, party.id);
        }

        // srNo is stored raw. `sequence` carries the ordering, so the old
        // "4.8b / 4.8c / 4.8d" mangling never recurs even when a document's
        // sr numbers repeat (DESPL-320: 62 items share 43 sr numbers).
        let sequence = 0;
        let partyCodeCount = 0;
        let processLinkCount = 0;
        for (const item of spec.items) {
          const qcpItem = await tx.qcpItem.create({
            data: {
              qcpTemplateId: qcpTemplate.id,
              sequence: ++sequence,
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
            },
          });

          if (item.kind === "CHECKPOINT" && item.codes) {
            for (const [partyCode, code] of Object.entries(item.codes)) {
              const inspectionPartyId = partyIdByCode.get(partyCode);
              if (!inspectionPartyId) {
                throw new Error(`QcpItem ${item.srNo} (${spec.jobLabel}): unknown party "${partyCode}"`);
              }
              const qcpCodeId = qcpCodeIdByCode.get(code);
              if (!qcpCodeId) {
                throw new Error(`QcpItem ${item.srNo} (${spec.jobLabel}): unknown QCP code "${code}"`);
              }
              await tx.qcpItemPartyCode.create({
                data: { qcpItemId: qcpItem.id, inspectionPartyId, qcpCodeId },
              });
              partyCodeCount++;
            }
          }

          // real FK join, replacing the unenforced Int[] crosswalk
          if (spec.jobProcessIdByCode) {
            for (const processCode of item.leadTimeProcesses ?? []) {
              const jobProcessId = spec.jobProcessIdByCode.get(String(processCode));
              if (!jobProcessId) {
                throw new Error(`QcpItem ${item.srNo} (${spec.jobLabel}): unknown process ${processCode}`);
              }
              await tx.qcpItemProcess.create({ data: { qcpItemId: qcpItem.id, jobProcessId } });
              processLinkCount++;
            }
          }
        }
        return { parties: partyIdByCode.size, items: sequence, partyCodes: partyCodeCount, processLinks: processLinkCount };
      }

      const pilotResult = await seedQcpTemplate({
        jobId: pilotJob.id,
        jobLabel: pilotLabel,
        vessel: qcpFile.template.vessel,
        revision: qcpFile.template.revision,
        designCode: qcpFile.template.designCode,
        parties: qcpFile.template.parties,
        items: qcpFile.template.items,
        jobProcessIdByCode: pilotJpIdByCode,
      });
      stats.inspectionParties = pilotResult.parties;
      stats.qcpItems = pilotResult.items;
      stats.qcpPartyCodes = pilotResult.partyCodes;
      stats.qcpProcessLinks = pilotResult.processLinks;

      // ── 13. Additional QAP templates — docx handover (13 Aug 2026) ─────
      // 6 more QCP templates: 3 attach to the existing DE0467 job (its
      // projectName 'PRESSURE PIPE 8" / SUCTION PIPE 10" / SAV 24"' matches
      // these 3 equipment names exactly), 1 attaches to DE0463 (user-confirmed
      // — the source docx table itself carries no equipment name), and 2 have
      // no matching Job at all (Ammonia Vaporizer/DE0398001, and an unlabelled
      // "Vessel" QAP) so jobId stays null, same pattern as the pilot template
      // originally used before DESPL-320 existed as a Job.
      let batch2Templates = 0;
      let batch2Items = 0;
      let batch2PartyCodes = 0;
      for (const t of qcpBatch2.templates) {
        const jobId = t.jobNumberHint ? (jobIdByNumber.get(t.jobNumberHint) ?? null) : null;
        const result = await seedQcpTemplate({
          jobId,
          jobLabel: t.jobLabel,
          vessel: t.vessel,
          designCode: t.designCode,
          parties: t.parties,
          items: t.items,
        });
        batch2Templates++;
        batch2Items += result.items;
        batch2PartyCodes += result.partyCodes;
      }
      stats.batch2QcpTemplates = batch2Templates;
      stats.batch2QcpItems = batch2Items;
      stats.batch2QcpPartyCodes = batch2PartyCodes;
      if (qcpBatch2.issues?.length) {
        console.warn(
          `! qcp-templates-batch2.json flags ${qcpBatch2.issues.length} row(s) the extractor ` +
            `could not confidently align — codes left empty for those, not guessed:`,
        );
        for (const issue of qcpBatch2.issues as { row: string; problem: string }[]) {
          console.warn(`    ${issue.row}: ${issue.problem}`);
        }
      }

      // ── 12. Users ────────────────────────────────────────────────────
      // One per role, plus a supervisor per department, plus one client user.
      const mkUser = async (
        email: string,
        name: string,
        roleCodes: string[],
        deptCodes: string[] = [],
        clientId: number | null = null,
      ) => {
        const user = await tx.user.create({
          data: { tenantId, clientId, email, username: email.split("@")[0], name, passwordHash },
        });
        await tx.userRole.createMany({
          data: roleCodes.map((c) => ({ userId: user.id, roleId: roleIdByCode.get(c)! })),
        });
        if (deptCodes.length) {
          await tx.userDepartment.createMany({
            data: deptCodes.map((c) => ({ userId: user.id, departmentId: deptIdByCode.get(c)! })),
          });
        }
        return user;
      };

      await mkUser("admin@despl.local", "Administrator", ["ADMIN"]);
      await mkUser("md@despl.local", "MD", ["MANAGEMENT"]);
      await mkUser("ceo@despl.local", "CEO", ["MANAGEMENT"]);
      await mkUser("sj@despl.local", "SJ — Production Head", ["PRODUCTION_HEAD"]);
      await mkUser("qc@despl.local", "QC Inspector", ["QC"], ["QC"]);
      // namespaced so a department code can never collide with a role account
      // (QC is both a department and a role)
      for (const d of leadTime.departments) {
        await mkUser(
          `sup.${d.code.toLowerCase()}@despl.local`,
          `${d.name} Supervisor`,
          ["SUPERVISOR"],
          [d.code],
        );
      }
      await mkUser("client@example.local", "Client Viewer", ["CLIENT_VIEWER"], [], client.id);
      stats.users = await tx.user.count({ where: { tenantId } });

      // ── 13. Welders (FR-W1) ─────────────────────────────────────────
      // No welder list has been provided by DESPL yet (CLAUDE.md "Pending
      // inputs" — still outstanding). A small registry is seeded as a
      // functional stand-in, same honestly-noted substitution as the
      // department "representative" field (§9.7 progress.md) — so the
      // /welding log-joint dialog has real welders to pick instead of an
      // empty control. Replace with DESPL's actual list once it arrives.
      const fabricationDeptId = deptIdByCode.get("FABRICATION")!;
      await tx.welder.createMany({
        data: [
          { tenantId, name: "M. Sharma", employeeCode: "W-101", departmentId: fabricationDeptId },
          { tenantId, name: "V. Yadav", employeeCode: "W-102", departmentId: fabricationDeptId },
          { tenantId, name: "R. Gill", employeeCode: "W-103", departmentId: fabricationDeptId },
          { tenantId, name: "S. Ansari", employeeCode: "W-104", departmentId: fabricationDeptId },
          { tenantId, name: "K. Bhosale", employeeCode: "W-105", departmentId: fabricationDeptId },
        ],
      });
      stats.welders = await tx.welder.count({ where: { tenantId } });
  }
}

async function main() {
  const src: Sources = (() => {
    const leadTime = readJson<LeadTimeModel>("lead-time-model.json");
    const routesFile = readJson<ComponentRoutesFile>("component-routes.json");
    // static sanity check before touching the DB
    const departmentCodes = new Set(leadTime.departments.map((d) => d.code));
    for (const [opCode, meta] of Object.entries(routesFile.canonicalOperations)) {
      if (!departmentCodes.has(meta.dept)) {
        throw new Error(`canonicalOperations.${opCode}.dept "${meta.dept}" is not a known department`);
      }
    }
    return {
      leadTime,
      routesFile,
      liveJobs: readJson<LiveJobsFile>("live-jobs.json"),
      qcpFile: readJson<QcpTemplatesFile>("qcp-templates.json"),
      qcpBatch2: readJson<QcpBatchFile>("qcp-templates-batch2.json"),
      pipeSpoolTemplate: readJson<ProvisionalTemplateFile>("pipe-spool-template.json"),
      issues: readJson<DataIssuesFile>("data-issues.json").issues,
    };
  })();

  // SEED_REFERENCE_ONLY=1 is the production path: reference data only, no demo
  // jobs and no dev-password users. Default (unset) seeds both for dev.
  const referenceOnly = process.env.SEED_REFERENCE_ONLY === "1";

  let passwordHash = "";
  if (!referenceOnly) {
    const devPassword = process.env.SEED_PASSWORD ?? "despl-dev-only";
    if (!process.env.SEED_PASSWORD) {
      console.warn(
        "! SEED_PASSWORD not set — seeding demo users with the well-known dev password " +
          `"${devPassword}". Never run the demo seed against a deployed environment.`,
      );
    }
    passwordHash = await hash(devPassword);
  }

  const stats: Record<string, number> = {};

  await prisma.$transaction(
    async (tx) => {
      const refs = await seedReference(tx, src, stats);
      if (!referenceOnly) await seedDemo(tx, refs, src, passwordHash, stats);
    },
    { timeout: 180_000, maxWait: 15_000 },
  );

  console.log(referenceOnly ? "Reference seed complete:" : "Seed complete:");
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(24)} ${v}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
