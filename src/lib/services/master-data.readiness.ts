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

export interface Finding {
  variant: string | null;
  seq: number | null;
  code: string;
  message: string;
}

export interface Readiness {
  blockers: Finding[];
  warnings: Finding[];
}

export function evaluateReadiness(
  part: { code: string; scope: Scope; routeSource: string | null },
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
      });
    }
  }

  for (const v of variants) {
    const target = v.status === "DRAFT" ? blockers : warnings;
    if (v.steps.length === 0) {
      target.push({ variant: v.variant, seq: null, code: "NO_STEPS", message: `Variant ${v.variant} has no steps.` });
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
        const item: Finding = { variant: v.variant, seq: s.seq, code: f.code, message: f.message };
        if (f.severity === "ERROR") target.push(item);
        else warnings.push(item);
      }
      if (s.stdTime == null) {
        warnings.push({ variant: v.variant, seq: s.seq, code: "MISSING_STD_TIME", message: `Step ${s.seq} of ${part.code} has no standard time.` });
      }
    }
  }
  return { blockers, warnings };
}
