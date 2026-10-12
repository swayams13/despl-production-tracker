import type { Tx } from "@/lib/db";
import type { Evaluation, HeStageDecision } from "./master-import.rules";

/**
 * Lean Core M2 (PR B) — the HE Stages sheet as a HEAT_EXCHANGER process
 * template. Always a DRAFT version: publishing is an explicit act (D19: HE
 * types in v1 are fixed tubesheet / MED only; durations here are planning
 * estimates, so every process is marked provisional).
 */

export interface HeContent {
  processes: Array<{
    code: string;
    seq: number;
    name: string;
    mainActivities: string | null;
    durationMinDays: number | null;
    durationMaxDays: number | null;
    department: string;
    optional: boolean;
  }>;
  edges: Array<{ process: string; predecessor: string; type: string; lagDays: number }>;
}

export const HE_FAMILY = "HEAT_EXCHANGER";
export const HE_TEMPLATE_NAME = "Heat Exchanger — Fixed tubesheet / MED evaporator";

export function heContent(stages: readonly HeStageDecision[]): HeContent {
  const sorted = [...stages].sort((a, b) => a.stageNo - b.stageNo);
  return {
    processes: sorted.map((s) => ({
      code: String(s.stageNo),
      seq: s.stageNo,
      name: s.name,
      // The template has no "when optional" column, so the rule rides with the text.
      mainActivities: [s.activities, s.optionalWhen ? `Optional: ${s.optionalWhen}` : ""].filter(Boolean).join(" — ") || null,
      durationMinDays: s.minDays,
      durationMaxDays: s.maxDays,
      department: s.department,
      optional: s.optional,
    })),
    edges: sorted.flatMap((s) =>
      s.predecessors.map((p) => ({
        process: String(s.stageNo),
        predecessor: String(p),
        type: s.linkType ?? "FINISH_TO_START",
        lagDays: s.lagDays,
      })),
    ),
  };
}

export function heSignature(c: HeContent): string {
  return JSON.stringify([
    c.processes.map((p) => [p.code, p.seq, p.name, p.mainActivities ?? "", p.durationMinDays, p.durationMaxDays, p.department, p.optional]),
    c.edges.map((e) => [e.process, e.predecessor, e.type, e.lagDays]).sort(),
  ]);
}

export interface ExistingHe {
  templateId: number;
  versionId: number;
  version: number;
  status: string;
  signature: string;
}

/** Latest version of the tenant's HEAT_EXCHANGER template, if any. */
export async function existingHe(db: Tx, tenantId: number): Promise<ExistingHe | null> {
  const template = await db.processTemplate.findFirst({
    where: { tenantId, family: { code: HE_FAMILY } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: {
          id: true,
          version: true,
          status: true,
          processes: {
            select: {
              id: true, code: true, seq: true, name: true, mainActivities: true,
              durationMinDays: true, durationMaxDays: true, optional: true,
              defaultDepartment: { select: { name: true } },
            },
          },
          edges: { select: { processId: true, predecessorId: true, type: true, lagDays: true } },
        },
      },
    },
  });
  const v = template?.versions[0];
  if (!template || !v) return null;
  const codeById = new Map(v.processes.map((p) => [p.id, p.code]));
  const content: HeContent = {
    processes: [...v.processes]
      .sort((a, b) => a.seq - b.seq)
      .map((p) => ({
        code: p.code,
        seq: p.seq,
        name: p.name,
        mainActivities: p.mainActivities,
        durationMinDays: p.durationMinDays,
        durationMaxDays: p.durationMaxDays,
        department: p.defaultDepartment.name,
        optional: p.optional,
      })),
    edges: v.edges.map((e) => ({
      process: codeById.get(e.processId) ?? "",
      predecessor: codeById.get(e.predecessorId) ?? "",
      type: e.type,
      lagDays: e.lagDays,
    })),
  };
  return { templateId: template.id, versionId: v.id, version: v.version, status: v.status, signature: heSignature(content) };
}

export type HeOutcome = "create" | "update" | "unchanged" | "skipped";

export async function planHe(db: Tx, tenantId: number, ev: Evaluation): Promise<HeOutcome> {
  if (!ev.heLoadable) return "skipped";
  const have = await existingHe(db, tenantId);
  if (!have) return "create";
  return have.signature === heSignature(heContent(ev.heStages)) ? "unchanged" : "update";
}
