import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * J5c static guard (like the J2 config-isolation guard): a BOM re-release retires floor rows instead of deleting
 * them, so every service read of `components`, `component_operations` or `assembly_steps` must either filter
 * `activeRow` (src/lib/services/active-row.ts) or say why it reads history with a `// j5c: history` (or
 * `// j5c: any row ...`) comment on the call or the line above it. Reads through relations (include/_count) and
 * raw SQL are not seen here; the view test and the reader tests cover those.
 */
const dir = __dirname;
const CALL = /\.(component|componentOperation|assemblyStep)\s*(?:\/\/[^\n]*\n\s*)*\.(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|groupBy|aggregate)\s*\(/g;

function services(): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".setup.ts") && !f.endsWith("test-util.ts"))
    .map((f) => path.join(dir, f));
}

/** The text of the call's argument list (balanced parentheses). */
function args(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

export function unguardedCalls(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(CALL)) {
    const start = m.index!;
    const lineStart = src.lastIndexOf("\n", start) + 1;
    const prevStart = src.lastIndexOf("\n", lineStart - 2) + 1;
    const lead = src.slice(prevStart, start + m[0].length);
    const body = args(src, start + m[0].length - 1);
    if (/j5c:/.test(lead) || /\bactiveRow\b/.test(body)) continue;
    out.push(src.slice(lineStart, start + m[0].length).trim());
  }
  return out;
}

describe("J5c: floor-row readers filter retired rows", () => {
  it("finds the service files and the calls (the guard is not vacuous)", () => {
    const calls = services().flatMap((f) => [...readFileSync(f, "utf8").matchAll(CALL)]);
    expect(services().length).toBeGreaterThan(20);
    expect(calls.length).toBeGreaterThan(60);
  });

  it("flags an unguarded read and accepts the two guarded forms", () => {
    expect(unguardedCalls("await tx.assemblyStep.findMany({ where: { unitId } });")).toHaveLength(1);
    expect(unguardedCalls("await tx.assemblyStep.findMany({ where: { ...activeRow, unitId } });")).toHaveLength(0);
    expect(unguardedCalls("// j5c: history\nawait tx.component.findFirst({ where: { id } });")).toHaveLength(0);
    expect(unguardedCalls("tx.componentOperation\n  // j5c: history\n  .findFirst({ where: { id } })")).toHaveLength(0);
  });

  it.each(services().map((f) => [path.basename(f), f] as const))("%s", (_name, file) => {
    expect(unguardedCalls(readFileSync(file, "utf8"))).toEqual([]);
  });
});
