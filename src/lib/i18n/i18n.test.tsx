import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/work", () => ({ ensureJointAction: vi.fn(), notifyBlockerAction: vi.fn(), recordWorkAction: vi.fn() }));

import { en } from "./en";
import { hi } from "./hi";
import { gu } from "./gu";
import { dictFor, LOCALES, nextLocale } from ".";
import { LocaleProvider } from "./provider";
import { FloorOutcomes, FloorUndoStack, stateLabel } from "@/components/industrial/floor-actions";

type Leaf = string | ((...a: string[]) => string);
/** Every string / function leaf with its dotted path. */
function leaves(o: object, path = ""): Array<[string, Leaf]> {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "object" ? leaves(v, `${path}${k}.`) : [[`${path}${k}`, v as Leaf] as [string, Leaf]],
  );
}
const call = (v: Leaf) => (typeof v === "function" ? v("7", "7", "7", "7") : v);
const INDIC_DIGITS = /[०-९૦-૯]/;

describe("L2.12 dictionaries", () => {
  const base = leaves(en).map(([k]) => k);

  it.each([["hi", hi], ["gu", gu]])("%s has exactly English's keys and no empty text", (_n, d) => {
    expect(leaves(d).map(([k]) => k)).toEqual(base);
    for (const [k, v] of leaves(d)) expect(call(v).trim(), k).not.toBe("");
  });

  it.each([["hi", hi], ["gu", gu]])("%s keeps Western digits and passes arguments through", (_n, d) => {
    for (const [k, v] of leaves(d)) {
      if (k === "langName" || k === "intl" || typeof v !== "function") continue;
      const out = call(v);
      expect(out, k).toContain("7");
      expect(out, k).not.toMatch(INDIC_DIGITS);
    }
    expect(d.sheet.welderFor("LS-1")).toContain("LS-1");
    expect(d.sheet.alsoFor("SR02–SR09", 0)).toContain("SR02–SR09");
  });

  it.each(["hi", "gu"])("%s.ts marks every translated line REVIEW: DESPL", (f) => {
    const lines = readFileSync(new URL(`./${f}.ts`, import.meta.url), "utf8").split("\n");
    expect(lines[0]).toContain("REVIEW: DESPL");
    const script = /[ऀ-ॿ઀-૿]/;
    for (const [i, line] of lines.entries()) {
      if (script.test(line) && !line.includes("langName") && !line.startsWith("//")) {
        expect(line, `${f}.ts line ${i + 1}`).toContain("REVIEW: DESPL");
      }
    }
  });

  it("dates use Western digits in every locale", () => {
    for (const d of [en, hi, gu]) {
      const out = new Date("2026-10-17T00:00:00Z").toLocaleDateString(d.intl, { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
      expect(out).toContain("17");
      expect(out).not.toMatch(INDIC_DIGITS);
    }
  });

  it("falls back to English and cycles through the three locales", () => {
    expect(dictFor(undefined)).toBe(en);
    expect(dictFor(null)).toBe(en);
    expect(LOCALES.map((l) => dictFor(l).langName)).toEqual(["English", "हिन्दी", "ગુજરાતી"]);
    expect(nextLocale("en")).toBe("hi");
    expect(nextLocale("hi")).toBe("gu");
    expect(nextLocale("gu")).toBe("en");
  });

  it("refusal states stay English in every locale", () => {
    for (const d of [en, hi, gu]) {
      expect(stateLabel(d, "BLOCKED")).toBe("Can't start yet");
      expect(stateLabel(d, "NEEDS_OVERRIDE")).toBe("Out of usual order");
    }
    expect(stateLabel(hi, "READY")).toBe(hi.state.READY);
  });
});

describe("L2.12 shared floor components follow the provider", () => {
  const outcome = { id: "a", label: "Weld LS-1 marked done", applied: 1, refused: [] };
  const render = (locale: "en" | "hi" | "gu") =>
    renderToStaticMarkup(
      <LocaleProvider locale={locale}>
        <FloorOutcomes outcomes={[outcome]} dismiss={() => {}} />
        <FloorUndoStack pending={[{ id: "p", label: "x", keys: [] }]} undo={() => {}} />
      </LocaleProvider>,
    );

  it("renders English without a provider-set locale and translates under hi/gu", () => {
    const e = render("en");
    expect(e).toContain("Dismiss");
    expect(e).toContain("Undo");
    expect(e).toContain('lang="en"');
    const h = render("hi");
    expect(h).toContain(hi.common.dismiss);
    expect(h).toContain(hi.common.undo);
    expect(h).toContain('lang="hi"');
    expect(render("gu")).toContain(gu.common.undo);
  });
});
