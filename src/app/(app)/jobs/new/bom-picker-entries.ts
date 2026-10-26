import type { IntakeOptions } from "@/lib/services/job-intake.read";
import { plural } from "@/lib/shared/plural";
import type { EquipBlockState } from "./wizard-state";

/**
 * The master-BOM picker's one list: the family's equipment types (with their standard kit, or
 * without one) and the earlier jobs' equipment lines that have BOM lines. Pure, so the filter and
 * the choice can be tested without a DOM.
 */

export type PickerEntry =
  | { kind: "KIT"; key: string; typeId: number; title: string; sub: string; haystack: string }
  | { kind: "TYPE"; key: string; typeId: number; title: string; sub: string; haystack: string }
  | { kind: "SOURCE"; key: string; equipmentId: number; title: string; sub: string; haystack: string };

const norm = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" ").toLowerCase();

export function buildPickerEntries(options: IntakeOptions, familyId: number | null): PickerEntry[] {
  if (familyId == null) return [];
  const types: PickerEntry[] = options.equipmentTypes
    .filter((t) => t.familyId === familyId)
    .map((t) =>
      t.kit.length > 0
        ? { kind: "KIT" as const, key: `kit:${t.id}`, typeId: t.id, title: t.name, sub: `Standard kit · ${plural(t.kit.length, "line")}`, haystack: norm(t.name, t.code, "standard kit", ...t.kit.flatMap((k) => [k.name, k.code])) }
        : { kind: "TYPE" as const, key: `type:${t.id}`, typeId: t.id, title: t.name, sub: "Equipment type · no standard kit yet", haystack: norm(t.name, t.code, "equipment type") },
    );
  const sources: PickerEntry[] = options.bomSources
    .filter((s) => s.familyId === familyId)
    .map((s) => ({
      kind: "SOURCE" as const,
      key: `src:${s.equipmentId}`,
      equipmentId: s.equipmentId,
      title: s.equipmentName,
      sub: `${s.jobNumber} · ${s.clientName} · ${plural(s.itemCount, "line")}`,
      haystack: norm(s.equipmentName, s.jobNumber, s.clientName, s.equipmentTypeName, ...s.partCodes),
    }));
  return [...types, ...sources];
}

/** Every word typed must appear somewhere in the entry (name, job number, client, type, part code). */
export function filterPickerEntries(entries: PickerEntry[], query: string): PickerEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length === 0 ? entries : entries.filter((e) => words.every((w) => e.haystack.includes(w)));
}

/** What the closed picker shows for a line. */
export function pickerSummary(b: EquipBlockState, options: IntakeOptions): string {
  const type = options.equipmentTypes.find((t) => t.id === b.equipmentTypeId) ?? null;
  const src = b.bomMode === "COPY" ? options.bomSources.find((s) => s.equipmentId === b.copyBomFromEquipmentId) : null;
  if (b.bomMode === "COPY" && b.copyBomFromEquipmentId != null) {
    return src ? `${src.equipmentName} · ${src.jobNumber} · ${src.clientName}` : "An earlier job's line (not in this list)";
  }
  if (!type) return "";
  if (b.bomMode === "KIT") return `${type.name} · standard kit`;
  if (b.bomMode === "UPLOAD") return `${type.name} · uploaded BOM`;
  return type.name;
}
