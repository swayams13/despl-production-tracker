import { describe, expect, it } from "vitest";
import { parseQtySource } from "./equipment-type";

describe("parseQtySource", () => {
  it.each(["", "fixed", "FIXED ", "ANSWER:", "ANSWER:Bad", "ANSWER:a b", "ANSWER:1x", "answer:x", "NOZZLE"])(
    "rejects %j",
    (raw) => expect(parseQtySource(raw)).toBeNull(),
  );
  it.each([
    ["FIXED", { kind: "FIXED" }],
    ["NOZZLE_SCHEDULE", { kind: "NOZZLE_SCHEDULE" }],
    ["ANSWER:shell_courses", { kind: "ANSWER", key: "shell_courses" }],
  ])("accepts %s", (raw, want) => expect(parseQtySource(raw)).toEqual(want));
});
