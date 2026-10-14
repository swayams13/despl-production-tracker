import type { Tx } from "@/lib/db";
import type { Prisma, StdTimeBasis, StdTimeUnit, TemplateStatus } from "@/generated/prisma/client";
import { stepSignature, type NormalStep } from "./master-import.rules";

/**
 * Lean Core M2/M3 — the one place a part family's route version is written.
 * Used by the importer (`master-import.apply.ts`) and the Master data editor
 * (`master-data.service.ts`), so both obey the same version rules:
 *
 *   - same content            → nothing (or DRAFT → PUBLISHED when now approved);
 *   - latest version is DRAFT → its steps are replaced in place;
 *   - latest is PUBLISHED     → a NEW version (invariant 9: never edited).
 *
 * Callers validate first (`checkStep`); this only persists. A blank department
 * is stored as null: an incomplete DRAFT may be saved, it just cannot be
 * approved.
 */
export interface RouteCtx {
  tenantId: number;
  operationId: ReadonlyMap<string, number>;
  departmentId: ReadonlyMap<string, number>;
  pvFamilyId?: number;
  heFamilyId?: number;
}

export interface RouteWrite {
  outcome: "create" | "update" | "unchanged";
  /** What happened to the version row. */
  action: "created" | "replaced" | "versioned" | "published" | "unchanged";
  routeId: number;
  versionId: number | null;
  version: number | null;
  status: TemplateStatus;
  previousStatus: TemplateStatus | null;
  mappingRows: number;
}

export async function writeRouteVariant(
  tx: Tx,
  ctx: RouteCtx,
  a: { typeId: number; variant: string; name: string; steps: readonly NormalStep[]; wantStatus: TemplateStatus },
): Promise<RouteWrite> {
  const { tenantId } = ctx;
  const wantSig = JSON.stringify(a.steps.map((s) => stepSignature(s)));

  const route = await tx.routeTemplate.findFirst({
    where: { tenantId, componentTypeId: a.typeId, familyId: null, variant: a.variant },
    select: {
      id: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: {
          id: true,
          version: true,
          status: true,
          steps: {
            orderBy: { seq: "asc" },
            select: {
              id: true, seq: true, printed: true, optional: true, requiresQc: true, stdTime: true, stdTimeUnit: true,
              stdTimeBasis: true, stdTimeStatus: true, includeWhen: true, conditionText: true, acceptanceStandard: true,
              recordDocument: true,
              operation: { select: { code: true } },
              department: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  const latest = route?.versions[0];
  // A re-save must not silently demote a VALIDATED time or drop a machine-readable
  // include rule that nothing in the editor can express yet (D17 / J2). Keyed by
  // step number; a time that was changed is a new, PROPOSED value.
  const carried = new Map((latest?.steps ?? []).map((s) => [s.seq, s]));

  let haveSig: string | null = null;
  if (latest) {
    const maps = await tx.routeStepFamilySeq.findMany({
      where: { tenantId, routeStepId: { in: latest.steps.map((s) => s.id) } },
      select: { routeStepId: true, leadTimeProcessSeq: true, familyId: true },
    });
    haveSig = JSON.stringify(
      latest.steps.map((s) =>
        stepSignature({
          seq: s.seq,
          operationCode: s.operation.code,
          whatIsDone: s.printed ?? "",
          department: s.department?.name ?? "",
          stdTime: s.stdTime == null ? null : Number(s.stdTime.toString()),
          stdTimeUnit: s.stdTimeUnit,
          stdTimeBasis: s.stdTimeBasis,
          conditional: s.optional,
          conditionText: s.conditionText ?? "",
          acceptanceStandard: s.acceptanceStandard ?? "",
          recordDocument: s.recordDocument ?? "",
          requiresQc: s.requiresQc,
          pvStage: maps.find((m) => m.routeStepId === s.id && m.familyId === ctx.pvFamilyId)?.leadTimeProcessSeq ?? null,
          heStage: maps.find((m) => m.routeStepId === s.id && m.familyId === ctx.heFamilyId)?.leadTimeProcessSeq ?? null,
        }),
      ),
    );
  }

  if (route && latest && haveSig === wantSig) {
    if (a.wantStatus === "PUBLISHED" && latest.status !== "PUBLISHED") {
      await tx.routeTemplateVersion.update({ where: { id: latest.id }, data: { status: "PUBLISHED" } });
      return { outcome: "update", action: "published", routeId: route.id, versionId: latest.id, version: latest.version, status: "PUBLISHED", previousStatus: latest.status, mappingRows: 0 };
    }
    return { outcome: "unchanged", action: "unchanged", routeId: route.id, versionId: latest.id, version: latest.version, status: latest.status, previousStatus: latest.status, mappingRows: 0 };
  }

  const routeId =
    route?.id ??
    (
      await tx.routeTemplate.create({
        data: { tenantId, componentTypeId: a.typeId, familyId: null, name: a.name, variant: a.variant },
        select: { id: true },
      })
    ).id;

  let versionId: number;
  let version: number;
  let action: RouteWrite["action"];
  if (latest && latest.status === "DRAFT") {
    // A draft is mutable: replace its steps (stage mappings cascade).
    await tx.routeStep.deleteMany({ where: { routeVersionId: latest.id } });
    await tx.routeTemplateVersion.update({ where: { id: latest.id }, data: { status: a.wantStatus } });
    versionId = latest.id;
    version = latest.version;
    action = "replaced";
  } else {
    version = (latest?.version ?? 0) + 1;
    versionId = (
      await tx.routeTemplateVersion.create({ data: { routeId, version, status: a.wantStatus }, select: { id: true } })
    ).id;
    action = latest ? "versioned" : "created";
  }

  const dept = (name: string) => (name ? (ctx.departmentId.get(name) ?? null) : null);
  const created = await tx.routeStep.createManyAndReturn({
    data: a.steps.map((s) => ({
      routeVersionId: versionId,
      seq: s.seq,
      operationId: ctx.operationId.get(s.operationCode)!,
      printed: s.whatIsDone || null,
      optional: s.conditional,
      departmentId: dept(s.department),
      stdTime: s.stdTime,
      stdTimeUnit: s.stdTimeUnit as StdTimeUnit | null,
      stdTimeBasis: s.stdTimeBasis as StdTimeBasis | null,
      stdTimeStatus: keepStatus(carried.get(s.seq), s),
      ...includeRule(carried.get(s.seq)),
      conditionText: s.conditionText || null,
      acceptanceStandard: s.acceptanceStandard || null,
      recordDocument: s.recordDocument || null,
      requiresQc: s.requiresQc,
    })),
    select: { id: true, seq: true },
  });
  const idBySeq = new Map(created.map((c) => [c.seq, c.id]));
  const mappings = a.steps.flatMap((s) => [
    ...(s.pvStage != null && ctx.pvFamilyId != null
      ? [{ tenantId, routeStepId: idBySeq.get(s.seq)!, familyId: ctx.pvFamilyId, leadTimeProcessSeq: s.pvStage }]
      : []),
    ...(s.heStage != null && ctx.heFamilyId != null
      ? [{ tenantId, routeStepId: idBySeq.get(s.seq)!, familyId: ctx.heFamilyId, leadTimeProcessSeq: s.heStage }]
      : []),
  ]);
  if (mappings.length > 0) await tx.routeStepFamilySeq.createMany({ data: mappings });

  return {
    outcome: action === "created" ? "create" : "update",
    action,
    routeId,
    versionId,
    version,
    status: a.wantStatus,
    previousStatus: latest?.status ?? null,
    mappingRows: mappings.length,
  };
}

type CarriedStep = {
  stdTime: { toString(): string } | null;
  stdTimeUnit: StdTimeUnit | null;
  stdTimeBasis: StdTimeBasis | null;
  stdTimeStatus: "PROPOSED" | "VALIDATED";
  includeWhen: unknown;
};

/** D17: a time keeps its status only while the time itself is unchanged; nothing here validates one. */
function keepStatus(prev: CarriedStep | undefined, next: NormalStep): "PROPOSED" | "VALIDATED" {
  if (!prev) return "PROPOSED";
  const same =
    (prev.stdTime == null ? null : Number(prev.stdTime.toString())) === next.stdTime &&
    prev.stdTimeUnit === next.stdTimeUnit &&
    prev.stdTimeBasis === next.stdTimeBasis;
  return same ? prev.stdTimeStatus : "PROPOSED";
}

function includeRule(prev: CarriedStep | undefined): { includeWhen?: Prisma.InputJsonValue } {
  return prev?.includeWhen != null ? { includeWhen: prev.includeWhen as Prisma.InputJsonValue } : {};
}

/** One comparison key for a whole variant: the stale-write guard compares what the editor loaded with what is there now. */
export function routeSignature(steps: readonly NormalStep[]): string {
  return JSON.stringify(steps.map((s) => stepSignature(s)));
}

export interface VariantRow {
  variant: string;
  routeId: number;
  versionId: number;
  version: number;
  status: TemplateStatus;
  steps: NormalStep[];
  /** Every version of this variant, newest first. `components` = components built on that version. */
  history: Array<{ id: number; version: number; status: TemplateStatus; components: number }>;
  /** `routeSignature` of `steps`; sent back on save so a concurrent edit is refused (STALE_WRITE). */
  signature: string;
  /** The version new work uses: the highest PUBLISHED one, if any. */
  liveVersion: number | null;
  /** The live version's steps when the latest is a DRAFT (what the approver compares against). */
  publishedSteps: NormalStep[] | null;
}

type StepRowDb = {
  id: number;
  seq: number;
  printed: string | null;
  optional: boolean;
  requiresQc: boolean;
  stdTime: { toString(): string } | null;
  stdTimeUnit: StdTimeUnit | null;
  stdTimeBasis: StdTimeBasis | null;
  conditionText: string | null;
  acceptanceStandard: string | null;
  recordDocument: string | null;
  operation: { code: string };
  department: { name: string } | null;
};

/** Latest version of each variant of each part family's generic route, with stage mappings, as NormalSteps. */
export async function loadVariantsFor(
  tx: Tx,
  tenantId: number,
  typeIds: readonly number[],
  families: { pvFamilyId?: number; heFamilyId?: number },
): Promise<Map<number, VariantRow[]>> {
  const out = new Map<number, VariantRow[]>();
  if (typeIds.length === 0) return out;
  const stepSelect = {
    id: true, seq: true, printed: true, optional: true, requiresQc: true, stdTime: true, stdTimeUnit: true,
    stdTimeBasis: true, conditionText: true, acceptanceStandard: true, recordDocument: true,
    operation: { select: { code: true } },
    department: { select: { name: true } },
  } as const;
  const routes = await tx.routeTemplate.findMany({
    where: { tenantId, componentTypeId: { in: [...typeIds] }, familyId: null },
    orderBy: [{ componentTypeId: "asc" }, { variant: "asc" }],
    select: {
      id: true,
      variant: true,
      componentTypeId: true,
      versions: {
        orderBy: { version: "desc" },
        select: {
          id: true,
          version: true,
          status: true,
          _count: { select: { components: true } },
          steps: { orderBy: { seq: "asc" }, select: stepSelect },
        },
      },
    },
  });

  // The steps worth showing: each variant's latest, plus (when the latest is a
  // DRAFT) the live published version it will replace.
  const wanted = new Map<number, { latest: boolean }>();
  for (const r of routes) {
    const latest = r.versions[0];
    if (!latest) continue;
    wanted.set(latest.id, { latest: true });
    if (latest.status === "DRAFT") {
      const live = r.versions.find((v) => v.status === "PUBLISHED");
      if (live) wanted.set(live.id, { latest: false });
    }
  }
  const stepIds = routes.flatMap((r) => r.versions.filter((v) => wanted.has(v.id)).flatMap((v) => v.steps.map((s) => s.id)));
  const maps = stepIds.length
    ? await tx.routeStepFamilySeq.findMany({
        where: { tenantId, routeStepId: { in: stepIds } },
        select: { routeStepId: true, leadTimeProcessSeq: true, familyId: true },
      })
    : [];
  const stage = new Map<string, number>();
  for (const m of maps) stage.set(`${m.routeStepId}:${m.familyId}`, m.leadTimeProcessSeq);

  const toNormal = (s: StepRowDb): NormalStep => ({
    row: 0,
    seq: s.seq,
    operationCode: s.operation.code,
    whatIsDone: s.printed ?? "",
    department: s.department?.name ?? "",
    pvStage: families.pvFamilyId != null ? (stage.get(`${s.id}:${families.pvFamilyId}`) ?? null) : null,
    heStage: families.heFamilyId != null ? (stage.get(`${s.id}:${families.heFamilyId}`) ?? null) : null,
    stdTime: s.stdTime == null ? null : Number(s.stdTime.toString()),
    stdTimeUnit: s.stdTimeUnit,
    stdTimeBasis: s.stdTimeBasis,
    conditional: s.optional,
    conditionText: s.conditionText ?? "",
    acceptanceStandard: s.acceptanceStandard ?? "",
    recordDocument: s.recordDocument ?? "",
    requiresQc: s.requiresQc,
  });

  for (const r of routes) {
    const v = r.versions[0];
    if (!v) continue;
    const steps = v.steps.map(toNormal);
    const live = r.versions.find((x) => x.status === "PUBLISHED");
    const row: VariantRow = {
      variant: r.variant,
      routeId: r.id,
      versionId: v.id,
      version: v.version,
      status: v.status,
      history: r.versions.map((x) => ({ id: x.id, version: x.version, status: x.status, components: x._count.components })),
      steps,
      signature: routeSignature(steps),
      liveVersion: live?.version ?? null,
      publishedSteps: v.status === "DRAFT" && live ? live.steps.map(toNormal) : null,
    };
    const list = out.get(r.componentTypeId) ?? [];
    list.push(row);
    out.set(r.componentTypeId, list);
  }
  return out;
}

export async function loadVariants(
  tx: Tx,
  tenantId: number,
  typeId: number,
  families: { pvFamilyId?: number; heFamilyId?: number },
): Promise<VariantRow[]> {
  return (await loadVariantsFor(tx, tenantId, [typeId], families)).get(typeId) ?? [];
}
