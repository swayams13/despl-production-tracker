import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LINKS, NEW_ITEMS, planLinks } from "./link-despl320-bom";

const seed = (f: string) => JSON.parse(readFileSync(path.join(__dirname, "..", "seed", f), "utf-8"));
const bomNos: number[] = seed("despl-320-bom-items.json").items.map((i: { itemNo: number }) => i.itemNo);
const tags: string[] = seed("despl-320-components.json").componentsPerUnit.map((c: { tag: string }) => c.tag);

describe("link-despl320-bom plan", () => {
  it("every linked tag is a real component and every linked item exists (or is added here)", () => {
    const known = new Set([...bomNos, ...NEW_ITEMS.map((i) => i.itemNo)]);
    for (const [tag, no] of Object.entries(LINKS)) {
      expect(tags).toContain(tag);
      expect(known.has(no)).toBe(true);
    }
    expect(NEW_ITEMS.every((i) => !bomNos.includes(i.itemNo))).toBe(true);
  });

  it("the three cutting plates are linked, the non-pressure skirt is not", () => {
    expect(LINKS.SHELL).toBeDefined();
    expect(LINKS["TOP-HEAD"]).toBeDefined();
    expect(LINKS["BOTTOM-HEAD"]).toBeDefined();
    expect(LINKS.SKIRT).toBeUndefined();
  });

  it("is idempotent: nothing new once the items exist and the components are linked; never overwrites a link", () => {
    const comps = [{ id: 1, tag: "SHELL", bomItemId: null }, { id: 2, tag: "TOP-HEAD", bomItemId: 99 }, { id: 3, tag: "SKIRT", bomItemId: null }];
    const first = planLinks(bomNos, comps);
    expect(first.newItems).toHaveLength(3);
    expect(first.links).toEqual([{ componentId: 1, tag: "SHELL", itemNo: 30 }]);
    expect(first.unlinkedTags).toEqual(["SKIRT"]);
    const second = planLinks([...bomNos, 30, 31, 32], [{ id: 1, tag: "SHELL", bomItemId: 7 }, comps[1]]);
    expect(second.newItems).toEqual([]);
    expect(second.links).toEqual([]);
  });
});
