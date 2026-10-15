import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compositeOver, contrastRatio, type RGBA } from "../../e2e/wcag-contrast";

/**
 * L2.0 token guard (frame 00 of design/lean-core). Parses the two palettes out
 * of globals.css, so a hex that regresses below AA fails here, not on a phone.
 */
const css = readFileSync(join(__dirname, "globals.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`globals.css: no ${selector} block`);
  const body = css.slice(start, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const hex = (h: string, a = 1): RGBA => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
  a,
});
const ratio = (fg: string, bg: string) => contrastRatio(hex(fg), hex(bg));
/** A status chip: the colour at 6% over the surface it sits on. */
const tint = (fg: string, surface: string): RGBA => compositeOver(hex(fg, 0.06), hex(surface));

const control = { ...block(".theme-industrial") };
const floor = { ...control, ...block(".theme-industrial.theme-light") };

const STATUS = ["--s-complete", "--s-progress", "--s-submitted", "--s-hold", "--s-overdue"] as const;
const GROUNDS = ["--bg", "--surface", "--surface-2"] as const;

describe.each([
  ["Floor", floor, ["--bg", "--surface", "--surface-2"]],
  ["Control room", control, ["--bg", "--surface", "--surface-2"]],
] as const)("%s palette meets AA", (_name, t, grounds) => {
  it.each(grounds.flatMap((g) => ["--text", "--muted", "--accent", ...STATUS].map((f) => [f, g] as const)))(
    "%s text on %s ≥ 4.5",
    (fg, bg) => {
      expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(STATUS)("%s label on its own 6%% chip tint (over surface) ≥ 4.5", (s) => {
    expect(contrastRatio(hex(t[s]), tint(t[s], t["--surface"]))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(GROUNDS)("control edge and not-started glyph on %s ≥ 3", (bg) => {
    expect(ratio(t["--border"], t[bg])).toBeGreaterThanOrEqual(3);
    expect(ratio(t["--s-idle"], t[bg])).toBeGreaterThanOrEqual(3);
  });
});

describe("decorative divider", () => {
  it("is its own token and is NOT used as a control edge (fails 3:1 by design)", () => {
    expect(control["--divider"]).toBe("#3a4048");
    expect(floor["--divider"]).toBe("#d5d9df");
    expect(ratio(control["--divider"], control["--surface-2"])).toBeLessThan(3);
  });
});

describe("type floor and retired palette", () => {
  it("declares no font-size below 11px outside the printed credential slip", () => {
    const bad = css
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => !l.includes("cred-slip"))
      .flatMap(([n, l]) => [...l.matchAll(/font-size:\s*([\d.]+)px/g)].filter((m) => Number(m[1]) < 11).map((m) => `${n}: ${m[0]}`));
    expect(bad).toEqual([]);
  });

  it("has no theme-outdoor selector left", () => {
    expect(css).not.toMatch(/\.theme-outdoor/);
  });

  it("has no numeric inline fontSize literal left in .tsx (use var(--fs-*))", () => {
    const root = join(__dirname, "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const f = join(dir, name);
        if (statSync(f).isDirectory()) {
          if (name !== "node_modules" && name !== "generated") walk(f);
        } else if (f.endsWith(".tsx")) {
          readFileSync(f, "utf8")
            .split("\n")
            .forEach((l, i) => /fontSize:\s*[\d.]/.test(l) && hits.push(`${f.slice(root.length)}:${i + 1}`));
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
