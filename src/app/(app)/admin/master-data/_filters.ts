import { z } from "zod";
import type { PartFamilyFilters } from "@/lib/services/master-data.read";

/**
 * List filters live in the URL (CLAUDE.md: cross-filter navigation, survives
 * refresh and back). A junk value in the URL is ignored per key, never an error.
 */
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parsePartFamilyFilters(raw: Record<string, string | string[] | undefined>): PartFamilyFilters {
  const q = z.string().trim().min(1).max(60).safeParse(one(raw.q));
  const scope = z.enum(["PV", "HE", "BOTH"]).safeParse(one(raw.scope));
  const status = z.enum(["DRAFT", "REVIEWED", "APPROVED"]).safeParse(one(raw.status));
  const group = z.string().trim().min(1).max(60).safeParse(one(raw.group));
  return {
    ...(q.success ? { q: q.data } : {}),
    ...(scope.success ? { scope: scope.data } : {}),
    ...(status.success ? { status: status.data } : {}),
    ...(group.success ? { group: group.data } : {}),
    ...(one(raw.issues) === "1" ? { hasBlockers: true } : {}),
  };
}

export function toQueryString(f: PartFamilyFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.scope) p.set("scope", f.scope);
  if (f.status) p.set("status", f.status);
  if (f.group) p.set("group", f.group);
  if (f.hasBlockers) p.set("issues", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ── Material grades ──────────────────────────────────────────────────────

export interface MaterialFilters {
  status?: "DRAFT" | "REVIEWED" | "APPROVED";
  /** Grades with no density yet (they cannot be approved). */
  noDensity?: boolean;
  q?: string;
}

export function parseMaterialFilters(raw: Record<string, string | string[] | undefined>): MaterialFilters {
  const q = z.string().trim().min(1).max(60).safeParse(one(raw.q));
  const status = z.enum(["DRAFT", "REVIEWED", "APPROVED"]).safeParse(one(raw.status));
  return {
    ...(q.success ? { q: q.data } : {}),
    ...(status.success ? { status: status.data } : {}),
    ...(one(raw.nodensity) === "1" ? { noDensity: true } : {}),
  };
}

export function materialQueryString(f: MaterialFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.status) p.set("status", f.status);
  if (f.noDensity) p.set("nodensity", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function filterMaterials<T extends { spec: string; grade: string; productForm: string; status: string; densityGcc: number | null }>(
  rows: readonly T[],
  f: MaterialFilters,
): T[] {
  const q = f.q?.toLowerCase();
  return rows.filter(
    (r) =>
      (!f.status || r.status === f.status) &&
      (!f.noDensity || r.densityGcc == null) &&
      (!q || [r.spec, r.grade, r.productForm].some((x) => x.toLowerCase().includes(q))),
  );
}
