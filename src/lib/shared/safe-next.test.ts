import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it.each([
    ["/u/3f2a9c1e-0000-4000-8000-000000000001", "/u/3f2a9c1e-0000-4000-8000-000000000001"],
    ["/jobs/12?tab=qc", "/jobs/12?tab=qc"],
    ["/", "/"],
  ])("keeps %s", (raw, out) => expect(safeNext(raw)).toBe(out));

  it.each([
    [null], [undefined], [""], [42],
    ["https://evil.example/x"],
    ["//evil.example/x"],
    ["/\\evil.example"],
    ["javascript:alert(1)"],
    ["u/relative"],
    ["/ok\r\nSet-Cookie: a=b"],
    ["/login"],
    ["/login?next=/x"],
    ["/" + "a".repeat(600)],
  ])("rejects %j", (raw) => expect(safeNext(raw)).toBeNull());
});
