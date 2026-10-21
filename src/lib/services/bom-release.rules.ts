/**
 * J5a: pure rules of the BOM release. No database, no actor: the service feeds these and
 * the tests table-drive them.
 */

export interface PartFamilyOption {
  componentTypeId: number;
  code: string;
  name: string;
}
export interface PartFamilySuggestion extends PartFamilyOption {
  reason: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string) => norm(s).split(" ").filter((w) => w.length >= 3);

/**
 * A guess for an unmapped BOM line, shown beside it. Never applied by itself: the user maps
 * the line (mapBomLines). `aliasWords` is a word -> part family code map (the standard-parts
 * aliases file: "plate" -> PLATE). A tie, or no match at all, suggests nothing.
 */
export function suggestPartFamily(
  partName: string,
  options: readonly PartFamilyOption[],
  aliasWords: Readonly<Record<string, string>> = {},
): PartFamilySuggestion | null {
  const name = norm(partName);
  if (!name) return null;
  const nameWords = new Set(words(partName));
  const scored = options
    .map((o) => {
      const code = norm(o.code);
      const label = norm(o.name);
      let score = 0;
      let reason = "";
      if (name === label || name === code) {
        score = 10;
        reason = "Same name";
      } else if ((label && (name.includes(label) || label.includes(name))) || (code.length >= 3 && name.split(" ").includes(code))) {
        score = 6;
        reason = "Name contains the part family";
      } else {
        const shared = words(o.name).filter((w) => nameWords.has(w)).length;
        if (shared > 0) {
          score = shared;
          reason = "Shares words with the part family name";
        }
      }
      for (const w of nameWords) {
        if (aliasWords[w] && norm(aliasWords[w]) === code) {
          score += 1;
          reason ||= `"${w}" is a known alias`;
        }
      }
      return { o, score, reason };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0 || (scored[1] && scored[1].score === scored[0].score)) return null;
  return { ...scored[0].o, reason: scored[0].reason };
}

export type ReleaseWarningCode =
  | "LINES_UNMAPPED"
  | "LINES_NO_ROUTE"
  | "KIT_COMPONENT_UNMAPPED"
  | "NO_QCP"
  | "WELD_MAP_UNCONFIRMED"
  | "NO_JOINTS_FOR_STEPS"
  | "H3_DATA_GAPS";
export interface ReleaseWarning {
  code: ReleaseWarningCode;
  message: string;
  /** What it is about: item numbers, part family codes, joint types. */
  items: string[];
}

export interface ReleaseWarningInput {
  unmappedItemNos: number[];
  noRouteItemNos: number[];
  /** Equipment-type kit components (code) that no BOM line is mapped to. */
  unmappedKitCodes: string[];
  hasQcp: boolean;
  unconfirmedJoints: number;
  /** Joint types a PER_JOINT step needs and the line has none of (human labels). */
  emptyJointTypes: string[];
  /** Pressure-retaining components being created: none of them has a governing drawing yet. */
  pressureParts: number;
}

/** The acknowledgeable warnings, in the order the screen lists them. Refusals are not here. */
export function buildReleaseWarnings(i: ReleaseWarningInput): ReleaseWarning[] {
  const w: ReleaseWarning[] = [];
  const nos = (a: number[]) => a.map((n) => `Item ${n}`);
  if (i.unmappedItemNos.length)
    w.push({
      code: "LINES_UNMAPPED",
      message: `${i.unmappedItemNos.length} BOM line${i.unmappedItemNos.length === 1 ? " has" : "s have"} no part family. They get no component and no operations.`,
      items: nos(i.unmappedItemNos),
    });
  if (i.noRouteItemNos.length)
    w.push({
      code: "LINES_NO_ROUTE",
      message: `${i.noRouteItemNos.length} BOM line${i.noRouteItemNos.length === 1 ? "'s part family has" : "s' part families have"} no published route. They get no component and no operations.`,
      items: nos(i.noRouteItemNos),
    });
  if (i.unmappedKitCodes.length)
    w.push({
      code: "KIT_COMPONENT_UNMAPPED",
      message: "The equipment type expects these parts and no BOM line is mapped to them. Nothing is created for them, so they cannot be issued material or cut.",
      items: i.unmappedKitCodes,
    });
  if (!i.hasQcp)
    w.push({ code: "NO_QCP", message: "This job has no QC plan. Inspection steps are created without a checkpoint; attach a QC plan on the QC tab to link them.", items: [] });
  if (i.unconfirmedJoints > 0)
    w.push({
      code: "WELD_MAP_UNCONFIRMED",
      message: `${i.unconfirmedJoints} joint${i.unconfirmedJoints === 1 ? " on the weld map is" : "s on the weld map are"} not confirmed by QC or Engineering yet.`,
      items: [],
    });
  if (i.emptyJointTypes.length)
    w.push({
      code: "NO_JOINTS_FOR_STEPS",
      message: `No ${i.emptyJointTypes.join(", ")} joints on the weld map: those weld steps will not be created.`,
      items: i.emptyJointTypes,
    });
  if (i.pressureParts > 0)
    w.push({
      code: "H3_DATA_GAPS",
      message: `${i.pressureParts} pressure-retaining part${i.pressureParts === 1 ? "" : "s"} will start with no drawing linked, so the drawing rule cannot hold their cutting until a drawing is linked.`,
      items: [],
    });
  return w;
}
