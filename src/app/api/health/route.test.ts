import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));

import { GET, pendingMigrations } from "./route";

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

// AUD-107: the route is public, so a pending migration shows a count, never names.
describe("GET /api/health", () => {
  it("answers 503 with a count and no migration names while migrations are pending", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    queryRaw.mockReset().mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce(all.slice(0, -2).map((migration_name) => ({ migration_name })));
    const res = await GET();
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ status: "error", migrations: "pending", pendingCount: 2 });
    expect(text).not.toContain(all[all.length - 1]);
    expect(log).toHaveBeenCalledWith("[health] pending migrations", { pending: all.slice(-2) });
    log.mockRestore();
  });

  it("answers 200 ok when everything is applied", async () => {
    queryRaw.mockReset().mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce(all.map((migration_name) => ({ migration_name })));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
