import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_GATE_PRODUCERS } from "./_shared";

/**
 * AUD-029 regression guard. `seed/component-routes.json`'s
 * `canonicalOperations` is the source `prisma/seed.ts` upserts every
 * tenant's `OperationRef` rows from (`requiresDftGate: meta.requiresDftGate
 * ?? false`) — so it's also the thing that silently re-enables a gate on the
 * next `pnpm db:seed`, independent of any migration. A migration alone
 * (`UPDATE operation_refs SET requires_dft_gate = false ...`) is not durable
 * against that: this test reads the same JSON `prisma/seed.ts` reads, not
 * the database, so it catches the regression before a reseed ever happens.
 *
 * PAINTING shipped with the flag on in this file and no reachable
 * PaintRecord/DftReading producer anywhere under src/app or src/components —
 * recordPaintRecord/recordDftReading existed only as service-layer
 * functions nobody called. Every real PAINTING op could start and submit
 * but never verify, deadlocking every successor process, with no action any
 * role could take to clear it (AUD-029). This test fails the build if that
 * ever happens again for PAINTING or any other operation: a `true` flag in
 * the seed file with no matching `true` entry in `KNOWN_GATE_PRODUCERS`
 * (`_shared.ts`) is exactly that failure mode.
 */

interface ComponentRoutesFile {
  canonicalOperations: Record<string, { requiresDftGate?: boolean }>;
}

function loadSeedGatedCodes(): string[] {
  const file = readFileSync(join(process.cwd(), "seed/component-routes.json"), "utf-8");
  const parsed = JSON.parse(file) as ComponentRoutesFile;
  return Object.entries(parsed.canonicalOperations)
    .filter(([, meta]) => meta.requiresDftGate === true)
    .map(([code]) => code);
}

describe("AUD-029: every requiresDftGate-enabled operation has a reachable producer", () => {
  it("every seed.ts-sourced requiresDftGate: true code has a `true` entry in KNOWN_GATE_PRODUCERS", () => {
    const gatedCodes = loadSeedGatedCodes();
    for (const code of gatedCodes) {
      expect(
        KNOWN_GATE_PRODUCERS[code],
        `OperationRef "${code}" is seeded with requiresDftGate: true but KNOWN_GATE_PRODUCERS["${code}"] ` +
          `is not true — this gate has no confirmed reachable PaintRecord/DftReading producer (a Server ` +
          `Action or route, not just a service function) and will refuse every real op forever (AUD-029). ` +
          `Only flip this in the same PR that ships the write path.`,
      ).toBe(true);
    }
  });

  // Today's interim state (AUD-029 mitigation): the gate is fully disabled.
  it("PAINTING is disabled today — the interim mitigation, not the permanent state", () => {
    expect(loadSeedGatedCodes()).not.toContain("PAINTING");
    expect(KNOWN_GATE_PRODUCERS.PAINTING).toBe(false);
  });
});
