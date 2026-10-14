import type { TemplateStatus } from "@/generated/prisma/client";
import { checkStep, type NormalStep, type ReferenceData, type Scope } from "./master-import.rules";

/**
 * Lean Core M3 — "can this part be approved?" and "what is wrong with it?".
 * Pure. Uses `checkStep`, the same rules the importer applied, so a route is
 * never approved under looser rules than it was loaded under.
 *
 * Only DRAFT variants (the ones approval would publish) can block; a variant
 * that is already PUBLISHED is judged for warnings only.
 */
export interface VariantState {
  variant: string;
  version: number;
  status: TemplateStatus;
  steps: NormalStep[];
}

/** The step cell(s) a finding is about, so a screen can mark them. */
export type StepField = "operation" | "department" | "pvStage" | "heStage" | "stdTime";

export interface Finding {
  variant: string | null;
  seq: number | null;
  code: string;
  message: string;
  /** Empty for part-level findings (route source, no steps). */
  fields: StepField[];
}

/** Which cells a `checkStep` finding points at. Pure; table-tested. */
export function fieldsOf(code: string, meta?: Record<string, unknown>): StepField[] {
  switch (code) {
    case "UNKNOWN_OPERATION":
      return ["operation"];
    case "UNKNOWN_DEPARTMENT":
    case "MISSING_DEPARTMENT":
      return ["department"];
    case "DEPARTMENT_STAGE_MISMATCH":
      return meta?.family === "HE" ? ["department", "heStage"] : ["department", "pvStage"];
    case "MISSING_STAGE": {
      const missing = Array.isArray(meta?.missing) ? (meta!.missing as unknown[]) : [];
      const out: StepField[] = [];
      if (missing.includes("PV")) out.push("pvStage");
      if (missing.includes("HE")) out.push("heStage");
      return out;
    }
    case "UNKNOWN_STAGE_NUMBER":
      return meta?.family === "HE" ? ["heStage"] : ["pvStage"];
    case "STAGE_DIFFERS_FROM_OPERATION_DEFAULT":
      return ["pvStage"];
    case "MISSING_STD_TIME":
      return ["stdTime"];
    default:
      return [];
  }
}

export interface Readiness {
  blockers: Finding[];
  warnings: Finding[];
}

export function evaluateReadiness(
  part: { code: string; scope: Scope; routeSource: string | null; makeBuy?: string | null },
  variants: readonly VariantState[],
  ref: ReferenceData,
  heStages: ReadonlyMap<number, { department: string }>,
): Readiness {
  const blockers: Finding[] = [];
  const warnings: Finding[] = [];

  const draft = variants.filter((v) => v.status === "DRAFT");
  if (draft.length > 0) {
    const source = (part.routeSource ?? "").trim();
    if (source === "" || /^assumed/i.test(source)) {
      blockers.push({
        variant: null,
        seq: null,
        code: "ROUTE_SOURCE",
        message: source === "" ? "The route source is not recorded." : `The route source is "${source}"; confirm the route before approving.`,
        fields: [],
      });
    }
  }

  // A part nobody has routed yet is approvable (bought-out items have none), but
  // for a part DESPL makes or works on it is worth saying so, as the importer does.
  if (variants.length === 0 && part.makeBuy !== "BOUGHT_OUT") {
    warnings.push({ variant: null, seq: null, code: "NO_ROUTE", message: `${part.code} has no route yet.`, fields: [] });
  }

  for (const v of variants) {
    const target = v.status === "DRAFT" ? blockers : warnings;
    if (v.steps.length === 0) {
      target.push({ variant: v.variant, seq: null, code: "NO_STEPS", message: `Variant ${v.variant} has no steps.`, fields: [] });
      continue;
    }
    for (const s of v.steps) {
      const findings = checkStep(
        {
          scope: part.scope,
          partCode: part.code,
          operationLabel: s.operationCode,
          operationCode: s.operationCode,
          department: s.department,
          seqText: String(s.seq),
          pvStage: s.pvStage,
          heStage: s.heStage,
          pvBlank: s.pvStage == null,
          heBlank: s.heStage == null,
        },
        ref,
        heStages,
      );
      for (const f of findings) {
        const item: Finding = { variant: v.variant, seq: s.seq, code: f.code, message: f.message, fields: fieldsOf(f.code, f.meta) };
        if (f.severity === "ERROR") target.push(item);
        else warnings.push(item);
      }
      if (s.stdTime == null) {
        warnings.push({ variant: v.variant, seq: s.seq, code: "MISSING_STD_TIME", message: `Step ${s.seq} of ${part.code} has no standard time.`, fields: ["stdTime"] });
      }
    }
  }
  return { blockers, warnings };
}
