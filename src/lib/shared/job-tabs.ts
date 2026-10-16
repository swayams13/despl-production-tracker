/**
 * Lean Core L2.8: the job page's tab names and where the old ones went. Pure.
 * Lean names apply while `leanFloor` is on; flag off keeps today's names, and
 * a name from the other set is mapped (not dropped) so a shared link lands
 * somewhere correct either way.
 */

export const LEAN_TABS = ["overview", "schedule", "materials", "qc", "dispatch", "history"] as const;
export const LEGACY_TABS = ["overview", "gantt", "bom", "assembly", "qcp", "packing", "dispatch", "activity", "client"] as const;
export type LeanTab = (typeof LEAN_TABS)[number];

/** Old name -> lean name (+ extra query params the lean tab needs). */
const LEGACY_TO_LEAN: Record<string, { tab: string; extra?: Record<string, string> }> = {
  gantt: { tab: "schedule" },
  bom: { tab: "materials", extra: { view: "parts" } },
  qcp: { tab: "qc" },
  packing: { tab: "dispatch" },
  activity: { tab: "history" },
};
const LEAN_TO_LEGACY: Record<string, string> = { schedule: "gantt", materials: "bom", qc: "qcp", history: "activity" };

export interface JobTabResolution {
  tab: string;
  /** The requested name belongs to the other set: send the browser to `tab` (+ `extra`). */
  redirect: boolean;
  extra?: Record<string, string>;
}

/**
 * `assembly` is not on the lean strip (Board reaches it) but stays a valid
 * lean tab; `client` exists only while the client portal is unfrozen.
 */
export function resolveJobTab(param: string | undefined, opts: { lean: boolean; clientPortal: boolean }): JobTabResolution {
  const p = param ?? "";
  const hidden = opts.clientPortal ? ["assembly", "client"] : ["assembly"];
  if (opts.lean) {
    if ((LEAN_TABS as readonly string[]).includes(p) || hidden.includes(p)) return { tab: p, redirect: false };
    const m = LEGACY_TO_LEAN[p];
    if (m && m.tab !== p) return { tab: m.tab, redirect: true, extra: m.extra };
    return { tab: "overview", redirect: false };
  }
  const legacy: readonly string[] = opts.clientPortal ? LEGACY_TABS : LEGACY_TABS.filter((t) => t !== "client");
  if (legacy.includes(p)) return { tab: p, redirect: false };
  const old = LEAN_TO_LEGACY[p];
  if (old) return { tab: old, redirect: true };
  return { tab: "overview", redirect: false };
}

/** The Materials tab has two views: the pipeline (read-only) and Parts and stock (Stores actions). */
export function parseMaterialsView(v: string | undefined): "pipeline" | "parts" {
  return v === "parts" ? "parts" : "pipeline";
}

/**
 * Job switcher "keep the tab" (12C): switching job from /jobs/12?tab=qc lands on
 * /jobs/34?tab=qc, from /jobs/12/board on /jobs/34/board. Unit, equipment and
 * page filters belong to the old job and are dropped; any other sub-route
 * (a stage's activity page) has no equivalent on another job, so it lands on
 * the job page.
 */
export function jobSwitchHref(pathname: string, search: string, newJobId: number): string {
  const m = pathname.match(/^\/jobs\/\d+(\/[^?]*)?$/);
  const rest = m?.[1] ?? "";
  if (rest === "/board") return `/jobs/${newJobId}/board`;
  if (rest !== "") return `/jobs/${newJobId}`;
  const tab = new URLSearchParams(search).get("tab");
  return tab && /^[a-z]+$/.test(tab) ? `/jobs/${newJobId}?tab=${tab}` : `/jobs/${newJobId}`;
}

/** `/jobs/:id?tab=` + the request's other params (unit, equipment, short...) + any the new tab needs. */
export function jobTabUrl(jobId: number, tab: string, sp: Record<string, string | string[] | undefined>, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries({ ...sp, ...extra })) {
    const one = Array.isArray(v) ? v[0] : v;
    if (k !== "tab" && one != null) q.set(k, one);
  }
  return `/jobs/${jobId}?${q.toString()}`;
}
