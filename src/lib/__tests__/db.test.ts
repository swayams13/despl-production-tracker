import { describe, it, expect } from "vitest";
import { withJob } from "@/lib/db";

describe("withJob", () => {
  it("rejects a non-integer or non-positive jobId, matching withTenant's guard", async () => {
    await expect(withJob(1, 0, async () => null)).rejects.toThrow(/invalid jobId/);
    await expect(withJob(1, -3, async () => null)).rejects.toThrow(/invalid jobId/);
  });
});
