import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pendingMigrations } from "./route";

const all = readdirSync(path.join(process.cwd(), "prisma", "migrations"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("pendingMigrations", () => {
  it("reports nothing when every migration on disk is applied", () => {
    expect(pendingMigrations(all)).toEqual([]);
  });

  it("reports the ones the database has never applied", () => {
    // The shape of the 2 Sep 2026 incident: the database stops at some
    // migration and everything after it is missing.
    const cutoff = all.indexOf("20260822130000_template_version_updated_at");
    expect(cutoff).toBeGreaterThan(-1);
    expect(pendingMigrations(all.slice(0, cutoff + 1))).toEqual(all.slice(cutoff + 1));
  });

  it("ignores rows for migrations that are no longer on disk", () => {
    expect(pendingMigrations([...all, "19990101000000_deleted_long_ago"])).toEqual([]);
  });
});
