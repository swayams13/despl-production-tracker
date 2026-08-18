/**
 * WCAG 2.x contrast-ratio helper (Task 7, SPEC-supervisor-ui-v3.md §8 /
 * PLAN-responsive-supervisor-v1.md Session R1 Task 7).
 *
 * No contrast utility existed anywhere in this codebase before this task
 * (checked `e2e/` and `src/`). Implements the standard formula: relative
 * luminance per channel (linearised sRGB via the 0.04045 piecewise rule) ->
 * weighted sum (0.2126R + 0.7152G + 0.0722B) -> (L1 + 0.05) / (L2 + 0.05)
 * with L1 the lighter of the pair.
 *
 * Hand-verified while writing this (not asserted anywhere in the running
 * suite) against Task 6's own independently-computed number: the light
 * palette's `.c-hold` chip text (`--s-hold: #9a6c05`) composited over pure
 * white (`--surface: #ffffff`, its real ancestor on desktop) returns 4.44,
 * matching task-6-report.md's fix-round table (`--surface` column: 4.45,
 * rounding) almost exactly.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parses a CSS `rgb(...)` / `rgba(...)` computed-style string — what
 * `getComputedStyle` always returns on read, regardless of how the colour
 * was authored (hex, `var()`, `color-mix()` all resolve to this form). */
export function parseColor(css: string): RGBA {
  const m = css.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (!m) throw new Error(`wcag-contrast: unparseable computed color "${css}"`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== undefined ? Number(m[4]) : 1 };
}

function linearize(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }: RGBA): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Flattens a (possibly translucent) colour over an opaque one. */
export function compositeOver(fg: RGBA, bg: RGBA): RGBA {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** WCAG contrast ratio between two OPAQUE colours (ranges 1:1 .. 21:1). */
export function contrastRatio(c1: RGBA, c2: RGBA): number {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast ratio between two computed-style colour strings. `bgCss` is
 * assumed opaque (resolve it first, e.g. via {@link readComputedColors}
 * below); `fgCss` is flattened onto it first if translucent. */
export function contrastRatioFromCss(fgCss: string, bgCss: string): number {
  const bg = parseColor(bgCss);
  const fgRaw = parseColor(fgCss);
  const fg = fgRaw.a < 1 ? compositeOver(fgRaw, bg) : fgRaw;
  return contrastRatio(fg, bg);
}

/**
 * Browser-context helper: reads an element's text colour and its EFFECTIVE
 * background, walking up the ancestor chain and compositing every
 * translucent layer crossed (chip pills sit on translucent `rgba(...)`
 * backgrounds; spine segments and KPI values sit on opaque ones one or two
 * ancestors up) until a fully opaque layer is found.
 *
 * Passed directly to Playwright's `locator.evaluate()` — MUST stay
 * self-contained (no references to outer module scope), since Playwright
 * serialises the function body to run it in the browser.
 */
export function readComputedColors(el: Element): { color: string; background: string } {
  function parse(css: string): [number, number, number, number] {
    const m = css.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
    if (!m) return [0, 0, 0, 0];
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
  }

  const color = getComputedStyle(el).color;

  const layers: [number, number, number, number][] = [];
  let node: Element | null = el;
  while (node) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg[3] > 0) layers.push(bg);
    if (bg[3] >= 1) break;
    node = node.parentElement;
  }
  if (layers.length === 0) layers.push([255, 255, 255, 1]); // no opaque ancestor found — page default

  let [r, g, b] = layers[layers.length - 1].slice(0, 3) as [number, number, number];
  for (let i = layers.length - 2; i >= 0; i--) {
    const [lr, lg, lb, la] = layers[i];
    r = lr * la + r * (1 - la);
    g = lg * la + g * (1 - la);
    b = lb * la + b * (1 - la);
  }
  return { color, background: `rgb(${r}, ${g}, ${b})` };
}

/**
 * Browser-context helper for GRAPHICAL (non-text) elements — a stage spine
 * segment, a chart bar — that carry no visible text of their own. Unlike
 * {@link readComputedColors} (which reads the element's inherited `color`
 * against its own background — correct for a label sitting inside a tinted
 * pill), a bare colour swatch's `color` property is inherited-but-invisible
 * junk. What WCAG 1.4.11 (non-text contrast) actually asks for is the
 * element's own fill against what surrounds it: its OWN opaque
 * `background-color` as the foreground, composited against the EFFECTIVE
 * background starting one level up (`el.parentElement`), not `el` itself.
 *
 * Also passed directly to `locator.evaluate()` — self-contained for the same
 * serialisation reason as {@link readComputedColors}.
 */
export function readGraphicalColors(el: Element): { foreground: string; background: string } {
  function parse(css: string): [number, number, number, number] {
    const m = css.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
    if (!m) return [0, 0, 0, 0];
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
  }

  const foreground = getComputedStyle(el).backgroundColor;

  const layers: [number, number, number, number][] = [];
  let node: Element | null = el.parentElement;
  while (node) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg[3] > 0) layers.push(bg);
    if (bg[3] >= 1) break;
    node = node.parentElement;
  }
  if (layers.length === 0) layers.push([255, 255, 255, 1]);

  let [r, g, b] = layers[layers.length - 1].slice(0, 3) as [number, number, number];
  for (let i = layers.length - 2; i >= 0; i--) {
    const [lr, lg, lb, la] = layers[i];
    r = lr * la + r * (1 - la);
    g = lg * la + g * (1 - la);
    b = lb * la + b * (1 - la);
  }
  return { foreground, background: `rgb(${r}, ${g}, ${b})` };
}
