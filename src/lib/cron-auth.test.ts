import { describe, expect, it } from "vitest";
import { isValidCronSecret } from "./cron-auth";

describe("isValidCronSecret", () => {
  it("accepts the exact 'Bearer <secret>' header", () => {
    expect(isValidCronSecret("Bearer abc123", "abc123")).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(isValidCronSecret(null, "abc123")).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(isValidCronSecret("Bearer wrong", "abc123")).toBe(false);
  });

  it("rejects a header missing the 'Bearer ' prefix", () => {
    expect(isValidCronSecret("abc123", "abc123")).toBe(false);
  });

  it("rejects everything when no secret is configured at all", () => {
    expect(isValidCronSecret("Bearer anything", undefined)).toBe(false);
    expect(isValidCronSecret(null, undefined)).toBe(false);
  });
});
