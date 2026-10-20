import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Lean Core J rule: configuration may decide what gets MATERIALISED, but
 * scheduling and gating read only materialised rows, never configuration JSON.
 * Guard: the gating and scheduling code must not import the rule evaluator,
 * the config services or the ledger, nor read Equipment.config.
 */
const root = path.resolve(__dirname, "..");
const GUARDED = ["schedule", "shared/floor-rules.ts", "services/work.facts.ts", "services/work.service.ts", "services/state-machine.ts"];
const FORBIDDEN = [/include-when/, /config-rules/, /config-questions/, /configRuleDecision/, /ruleDecisions/, /equipment\.config/, /\.config\b/];

function files(p: string): string[] {
  const full = path.join(root, p);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(full, f));
}

describe("J rule: scheduling and gating never read configuration", () => {
  const targets = GUARDED.flatMap(files);
  it("finds the guarded files (the guard itself is not vacuous)", () => {
    expect(targets.length).toBeGreaterThan(5);
  });
  it.each(FORBIDDEN.map((re) => [String(re), re] as const))("no guarded file matches %s", (_label, re) => {
    const offenders = targets.filter((f) => re.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
