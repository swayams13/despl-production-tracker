import { describe, expect, test } from "vitest";
import { HEALTH_ORDER } from "@/lib/services/job-health";
import { SLUG, healthFromSlug } from "./_portfolio";

// The one untyped seam in the portfolio band: a typo'd slug would make tile
// filtering a silent no-op, with no type error and no other test failing.
describe("health slug round-trip", () => {
  test.each(HEALTH_ORDER)("%s survives SLUG -> healthFromSlug", (h) => {
    expect(healthFromSlug(SLUG[h])).toBe(h);
  });

  test("an unknown or absent slug means no filter", () => {
    expect(healthFromSlug("nonsense")).toBeNull();
    expect(healthFromSlug(undefined)).toBeNull();
  });
});
