import { withTenant, type Tx } from "@/lib/db";
import { assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { parseMasterWorkbook, type ParsedWorkbook } from "./master-import.parse";
import { planHe, type HeOutcome } from "./master-import.he";
import {
  evaluateMaster,
  stepSignature,
  type Evaluation,
  type ImportIssue,
  type NormalStep,
  type PartDecision,
  type ReferenceData,
} from "./master-import.rules";

/**
 * Lean Core M2 (PR A) — Standard Parts Master dry-run. READ-ONLY: this reads
 * the workbook and the tenant's current master data and reports what an
 * apply would create, change or refuse. It writes nothing.
 *
 * Every query filters by tenantId explicitly: the CLI script runs as the DB
 * owner (RLS bypassed), and child tables such as route_steps have no tenant
 * column of their own.
 */

export interface Tally {
  create: number;
  update: number;
  unchanged: number;
  skipped: number;
}

export type Outcome = "create" | "update" | "unchanged" | "skipped";

export interface DryRunReport {
  allowDraft: boolean;
  sheets: string[];
  counts: {
    parts: number;
    routeSteps: number;
    materialGrades: number;
    heStages: number;
    assemblyRows: number;
    newOperations: number;
    reviewActions: number;
    exampleRowsSkipped: number;
  };
  plan: {
    partFamilies: Tally;
    routes: Tally;
    /** route_step_family_seqs rows an apply would write (PV and HE together). */
    stageMappingRows: number;
    materialGrades: Tally;
    heStages: { loadable: boolean; stages: number; existingTemplates: number; outcome: HeOutcome };
  };
  parts: Array<{
    code: string;
    status: string | null;
    outcome: Outcome;
    routes: Array<{ variant: string; steps: number; outcome: Outcome }>;
  }>;
  issues: ImportIssue[];
  issueSummary: Array<{ code: string; severity: string; count: number }>;
}

const FAMILY_PV = "PRESSURE_VESSEL";
const FAMILY_HE = "HEAT_EXCHANGER";

/** Tracker-side reference data for the rules. PV stages fall back to the workbook's reference sheet. */
export async function loadReferenceData(db: Tx, tenantId: number, wb: ParsedWorkbook): Promise<ReferenceData> {
  const [operations, departments, types, pv] = await Promise.all([
    db.operationRef.findMany({ where: { tenantId }, select: { code: true } }),
    db.department.findMany({ where: { tenantId }, select: { name: true } }),
    db.componentTypeRef.findMany({ where: { tenantId }, select: { code: true } }),
    db.productFamily.findFirst({ where: { tenantId, code: FAMILY_PV }, select: { id: true } }),
  ]);

  const operationDefaultStage = new Map<string, number>();
  const pvStages = new Map<number, { name: string; department: string | null }>();

  if (pv) {
    const defaults = await db.operationRefFamilySeq.findMany({
      where: { tenantId, familyId: pv.id },
      select: { leadTimeProcessSeq: true, operationRef: { select: { code: true } } },
    });
    for (const d of defaults) operationDefaultStage.set(d.operationRef.code, d.leadTimeProcessSeq);

    const version = await db.processTemplateVersion.findFirst({
      where: { status: "PUBLISHED", template: { tenantId, familyId: pv.id } },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    if (version) {
      const processes = await db.templateProcess.findMany({
        where: { versionId: version.id },
        select: { code: true, name: true, defaultDepartment: { select: { name: true } } },
      });
      for (const p of processes) {
        if (/^\d+$/.test(p.code)) pvStages.set(Number(p.code), { name: p.name, department: p.defaultDepartment.name });
      }
    }
  }
  if (pvStages.size === 0) {
    for (const s of wb.pvStagesRef) {
      if (/^\d+$/.test(s.stageNo)) pvStages.set(Number(s.stageNo), { name: s.name, department: s.department || null });
    }
  }

  return {
    operationCodes: new Set(operations.map((o) => o.code)),
    operationDefaultStage,
    departmentNames: new Set(departments.map((d) => d.name)),
    componentTypeCodes: new Set(types.map((t) => t.code)),
    pvStages,
  };
}

const blank = (v: string | null | undefined): string => v ?? "";

export function dbPartFamilySignature(
  name: string,
  f: {
    equipmentScope: string;
    assemblyGroup: string | null;
    makeBuy: string | null;
    typicalMoc: string | null;
    weightBasis: string | null;
    isSpare: boolean;
    routeSource: string | null;
    status: string;
    rawForm: { code: string } | null;
  },
): string {
  return JSON.stringify([
    name,
    f.equipmentScope,
    blank(f.assemblyGroup),
    f.makeBuy ?? "",
    f.rawForm?.code ?? "",
    blank(f.typicalMoc),
    blank(f.weightBasis),
    f.isSpare,
    blank(f.routeSource),
    f.status,
  ]);
}

export function partFamilySignature(p: PartDecision): string {
  return JSON.stringify([
    p.name,
    p.scope,
    blank(p.assemblyGroup),
    p.makeBuy ?? "",
    p.rawFormCode ?? "",
    blank(p.typicalMoc),
    blank(p.weightBasis),
    p.isSpare,
    blank(p.routeSource),
    p.status,
  ]);
}

async function tally(db: Tx, tenantId: number, ev: Evaluation) {
  const codes = ev.parts.map((p) => p.code);
  const types = await db.componentTypeRef.findMany({
    where: { tenantId, code: { in: codes }, kind: "PART_FAMILY" },
    select: {
      id: true,
      code: true,
      name: true,
      partFamily: {
        select: {
          equipmentScope: true,
          assemblyGroup: true,
          makeBuy: true,
          typicalMoc: true,
          weightBasis: true,
          isSpare: true,
          routeSource: true,
          status: true,
          rawForm: { select: { code: true } },
        },
      },
    },
  });
  const typeByCode = new Map(types.map((t) => [t.code, t]));

  const routes = types.length
    ? await db.routeTemplate.findMany({
        where: { tenantId, familyId: null, componentTypeId: { in: types.map((t) => t.id) } },
        select: {
          componentTypeId: true,
          variant: true,
          versions: {
            orderBy: { version: "desc" },
            take: 1,
            select: {
              status: true,
              steps: {
                orderBy: { seq: "asc" },
                select: {
                  id: true,
                  seq: true,
                  printed: true,
                  optional: true,
                  stdTime: true,
                  stdTimeUnit: true,
                  stdTimeBasis: true,
                  conditionText: true,
                  acceptanceStandard: true,
                  recordDocument: true,
                  operation: { select: { code: true } },
                  department: { select: { name: true } },
                },
              },
            },
          },
        },
      })
    : [];
  const stepIds = routes.flatMap((r) => r.versions[0]?.steps.map((s) => s.id) ?? []);
  const mappings = stepIds.length
    ? await db.routeStepFamilySeq.findMany({
        where: { tenantId, routeStepId: { in: stepIds } },
        select: { routeStepId: true, leadTimeProcessSeq: true, family: { select: { code: true } } },
      })
    : [];
  const stageByStep = new Map<number, { pv: number | null; he: number | null }>();
  for (const m of mappings) {
    const cur = stageByStep.get(m.routeStepId) ?? { pv: null, he: null };
    if (m.family.code === FAMILY_PV) cur.pv = m.leadTimeProcessSeq;
    if (m.family.code === FAMILY_HE) cur.he = m.leadTimeProcessSeq;
    stageByStep.set(m.routeStepId, cur);
  }
  const existingRoute = new Map<string, { sig: string; status: string }>();
  for (const r of routes) {
    const v = r.versions[0];
    if (!v) continue;
    const sig = v.steps.map((s) => {
      const stage = stageByStep.get(s.id) ?? { pv: null, he: null };
      return stepSignature({
        seq: s.seq,
        operationCode: s.operation.code,
        whatIsDone: blank(s.printed),
        department: s.department?.name ?? "",
        stdTime: s.stdTime == null ? null : Number(s.stdTime.toString()),
        stdTimeUnit: s.stdTimeUnit,
        stdTimeBasis: s.stdTimeBasis,
        conditional: s.optional,
        conditionText: blank(s.conditionText),
        acceptanceStandard: blank(s.acceptanceStandard),
        recordDocument: blank(s.recordDocument),
        pvStage: stage.pv,
        heStage: stage.he,
      });
    });
    existingRoute.set(`${r.componentTypeId}|${r.variant}`, { sig: JSON.stringify(sig), status: v.status });
  }

  const partFamilies: Tally = { create: 0, update: 0, unchanged: 0, skipped: 0 };
  const routeTally: Tally = { create: 0, update: 0, unchanged: 0, skipped: 0 };
  let stageMappingRows = 0;
  const partsOut: DryRunReport["parts"] = [];

  for (const p of ev.parts) {
    let outcome: Outcome = "skipped";
    const existing = typeByCode.get(p.code);
    if (p.load) {
      if (!existing?.partFamily) outcome = "create";
      else {
        outcome = dbPartFamilySignature(existing.name, existing.partFamily) === partFamilySignature(p) ? "unchanged" : "update";
      }
    }
    partFamilies[outcome]++;

    const routesOut: DryRunReport["parts"][number]["routes"] = [];
    for (const v of p.variants) {
      let rOutcome: Outcome = "skipped";
      if (v.load) {
        const have = existing ? existingRoute.get(`${existing.id}|${v.variant}`) : undefined;
        const want = JSON.stringify(v.steps.map((s: NormalStep) => stepSignature(s)));
        // An approved part wants a PUBLISHED route; same content in a DRAFT version is an update (publish).
        const wantPublished = p.status === "APPROVED";
        rOutcome =
          have == null
            ? "create"
            : have.sig !== want
              ? "update"
              : wantPublished && have.status !== "PUBLISHED"
                ? "update"
                : "unchanged";
        // Mapping rows are rewritten only when the content changes; a publish-only update leaves them alone.
        if (have == null || have.sig !== want) {
          stageMappingRows += v.steps.reduce((n, s) => n + (s.pvStage != null ? 1 : 0) + (s.heStage != null ? 1 : 0), 0);
        }
      }
      routeTally[rOutcome]++;
      routesOut.push({ variant: v.variant, steps: v.steps.length, outcome: rOutcome });
    }
    partsOut.push({ code: p.code, status: p.status, outcome, routes: routesOut });
  }

  const grades = await db.materialGrade.findMany({
    where: { tenantId },
    select: { spec: true, grade: true, productForm: true, densityGcc: true },
  });
  const gradeKey = (spec: string, grade: string, form: string) => [spec, grade, form].map((x) => x.toLowerCase()).join("|");
  const gradeByKey = new Map(grades.map((g) => [gradeKey(g.spec, g.grade, g.productForm), g]));
  const materialTally: Tally = { create: 0, update: 0, unchanged: 0, skipped: 0 };
  for (const m of ev.materials) {
    if (!m.load) {
      materialTally.skipped++;
      continue;
    }
    const have = gradeByKey.get(gradeKey(m.spec, m.grade, m.productForm));
    if (!have) materialTally.create++;
    else if ((have.densityGcc == null ? null : Number(have.densityGcc.toString())) === m.densityGcc) materialTally.unchanged++;
    else materialTally.update++;
  }

  const existingTemplates = await db.processTemplate.count({ where: { tenantId, family: { code: FAMILY_HE } } });

  return { partFamilies, routeTally, stageMappingRows, materialTally, partsOut, existingTemplates };
}

/**
 * Rules that depend on what the tenant already holds. A part whose code is
 * taken by a legacy component type, or that is already APPROVED and would be
 * downgraded by a Draft row, is not loaded: an import never silently demotes
 * approved master data (invariant 6). A grade that is no longer DRAFT is not
 * rewritten either.
 */
async function applyStateConflicts(db: Tx, tenantId: number, ev: Evaluation): Promise<void> {
  const block = (p: PartDecision, code: ImportIssue["code"], message: string) => {
    p.load = false;
    for (const v of p.variants) v.load = false;
    ev.issues.push({ code, severity: "ERROR", sheet: "Parts Master", row: p.row, partCode: p.code, message });
  };
  const byCode = new Map(ev.parts.map((p) => [p.code, p]));
  const codes = ev.parts.filter((p) => p.load).map((p) => p.code);
  if (codes.length > 0) {
    const types = await db.componentTypeRef.findMany({
      where: { tenantId, code: { in: codes } },
      select: { code: true, kind: true, partFamily: { select: { status: true } } },
    });
    for (const t of types) {
      const p = byCode.get(t.code)!;
      if (t.kind !== "PART_FAMILY") {
        block(p, "PART_CODE_CONFLICT", `Code ${t.code} is already used by a ${t.kind.toLowerCase().replace("_", " ")} component type; a part family cannot share it.`);
      } else if (t.partFamily?.status === "APPROVED" && p.status !== "APPROVED") {
        block(p, "STATUS_DOWNGRADE", `${t.code} is already approved in the tracker; the workbook says "${p.status}". Approved master data is not demoted by an import.`);
      }
    }
  }
  const locked = await db.materialGrade.findMany({
    where: { tenantId, status: { not: "DRAFT" } },
    select: { spec: true, grade: true, productForm: true, densityGcc: true },
  });
  const key = (spec: string, grade: string, form: string) => [spec, grade, form].map((x) => x.toLowerCase()).join("|");
  const lockedByKey = new Map(locked.map((g) => [key(g.spec, g.grade, g.productForm), g]));
  for (const m of ev.materials) {
    const have = m.load ? lockedByKey.get(key(m.spec, m.grade, m.productForm)) : undefined;
    if (have && (have.densityGcc == null ? null : Number(have.densityGcc.toString())) !== m.densityGcc) {
      m.load = false;
      ev.issues.push({
        code: "MATERIAL_LOCKED",
        severity: "WARNING",
        sheet: "Material Master",
        row: m.row,
        message: `${m.spec} ${m.grade} (${m.productForm}) is already reviewed or approved; the workbook's density is not applied.`,
      });
    }
  }
}

/** Parse, evaluate against the tenant, then apply the tenant-state rules. Read-only. */
export async function prepareImport(db: Tx, tenantId: number, bytes: Buffer | Uint8Array, opts: { allowDraft: boolean }) {
  const wb = parseMasterWorkbook(bytes);
  const ref = await loadReferenceData(db, tenantId, wb);
  const ev = evaluateMaster(wb, ref, { allowDraft: opts.allowDraft });
  await applyStateConflicts(db, tenantId, ev);
  return { wb, ref, ev };
}

export async function dryRunWithDb(
  db: Tx,
  tenantId: number,
  bytes: Buffer | Uint8Array,
  opts: { allowDraft: boolean },
): Promise<DryRunReport> {
  const { wb, ev } = await prepareImport(db, tenantId, bytes, opts);
  return buildReport(db, tenantId, wb, ev, opts.allowDraft);
}

export async function buildReport(
  db: Tx,
  tenantId: number,
  wb: ParsedWorkbook,
  ev: Evaluation,
  allowDraft: boolean,
): Promise<DryRunReport> {
  const t = await tally(db, tenantId, ev);

  const summary = new Map<string, { code: string; severity: string; count: number }>();
  for (const i of ev.issues) {
    const cur = summary.get(i.code) ?? { code: i.code, severity: i.severity, count: 0 };
    cur.count++;
    summary.set(i.code, cur);
  }
  const order: Record<string, number> = { ERROR: 0, WARNING: 1, INFO: 2 };

  return {
    allowDraft,
    sheets: wb.sheets,
    counts: {
      parts: wb.parts.length,
      routeSteps: wb.steps.length,
      materialGrades: wb.materials.length,
      heStages: wb.heStages.length,
      assemblyRows: wb.assembly.length,
      newOperations: wb.newOperations.length,
      reviewActions: wb.reviewActions.length,
      exampleRowsSkipped: Object.values(wb.skippedExamples).reduce((a, b) => a + b, 0),
    },
    plan: {
      partFamilies: t.partFamilies,
      routes: t.routeTally,
      stageMappingRows: t.stageMappingRows,
      materialGrades: t.materialTally,
      heStages: {
        loadable: ev.heLoadable,
        stages: ev.heStages.length,
        existingTemplates: t.existingTemplates,
        outcome: await planHe(db, tenantId, ev),
      },
    },
    parts: t.partsOut,
    issues: ev.issues,
    issueSummary: [...summary.values()].sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code)),
  };
}

/** App entry point: Production Head or Admin only, tenant-scoped. Writes nothing. */
export async function dryRunMasterImport(
  actor: Actor,
  bytes: Buffer | Uint8Array,
  opts: { allowDraft?: boolean } = {},
): Promise<DryRunReport> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);
  return withTenant(actor.tenantId, (tx) => dryRunWithDb(tx, actor.tenantId, bytes, { allowDraft: opts.allowDraft ?? false }));
}
