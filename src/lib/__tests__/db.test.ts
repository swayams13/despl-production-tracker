import { describe, it, expect, vi } from "vitest";
import { withJob, withSerializationRetry } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

describe("withJob", () => {
  it("rejects a non-integer or non-positive jobId, matching withTenant's guard", async () => {
    await expect(withJob(1, 0, async () => null)).rejects.toThrow(/invalid jobId/);
    await expect(withJob(1, -3, async () => null)).rejects.toThrow(/invalid jobId/);
  });
});

// AUD-072 — the two error shapes below are copied verbatim from a live
// reproduction (two concurrent RepeatableRead transactions racing an update
// on the same row via a real Postgres 16 / Prisma 6.19.3 connection, not
// guessed): a normal Prisma Client write conflict throws P2034 with
// `meta: { modelName }`; a raw-query write conflict throws P2010 with
// `meta.code === "40001"`.
function p2034(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
    { code: "P2034", clientVersion: "6.19.3", meta: { modelName: "ProcessPlan" } },
  );
}

function p2010SerializationFailure(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`.", {
    code: "P2010",
    clientVersion: "6.19.3",
    meta: { code: "40001", message: "could not serialize access due to concurrent update" },
  });
}

describe("withSerializationRetry", () => {
  it("retries a P2034 write-conflict failure and returns the eventual success", async () => {
    const fn = vi.fn<() => Promise<string>>();
    fn.mockRejectedValueOnce(p2034());
    fn.mockRejectedValueOnce(p2034());
    fn.mockResolvedValueOnce("ok");

    await expect(withSerializationRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries a raw-query P2010/40001 failure the same way", async () => {
    const fn = vi.fn<() => Promise<string>>();
    fn.mockRejectedValueOnce(p2010SerializationFailure());
    fn.mockResolvedValueOnce("ok");

    await expect(withSerializationRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and throws the last serialization failure, never looping forever", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(p2034());
    await expect(withSerializationRetry(fn, 3)).rejects.toMatchObject({ code: "P2034" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a genuine AppError refusal — thrown immediately, first attempt", async () => {
    const refusal = new AppError(ERROR_CODES.GATING_BLOCKED, {});
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(refusal);

    await expect(withSerializationRetry(fn)).rejects.toBe(refusal);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
