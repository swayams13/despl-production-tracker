import { describe, expect, it } from "vitest";
import { AppError, ERROR_CODES, ERROR_MESSAGES, errorLabel, messageFor } from "./errors";

describe("errorLabel", () => {
  it.each([
    ["HOLD_POINT_OPEN", "Hold point not cleared"],
    ["UNIT_NOT_COMPLETE", "Production not complete"],
    ["NCR_OPEN", "Open NCR"],
  ] as const)("%s reads as plain English", (code, label) => {
    expect(errorLabel(code)).toBe(label);
  });

  it("never shows a raw code, even for a code with no hand-written label", () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(errorLabel(code)).not.toMatch(/[A-Z]_[A-Z]/);
    }
    expect(errorLabel("PAINT_BEFORE_HYDRO")).toBe("Paint before hydro");
  });
});

describe("QCP_ITEM_UNRESOLVED message", () => {
  const msg = ERROR_MESSAGES.QCP_ITEM_UNRESOLVED;
  it("names the problem and the fix, and does not send the user to an administrator", () => {
    expect(msg).toBe("This QCP template does not cover the assembly checklist. Pick another QCP template.");
    expect(msg).not.toMatch(/administrator/i);
  });
});

describe("REPORTED_AT_OUT_OF_WINDOW message", () => {
  const code = ERROR_CODES.REPORTED_AT_OUT_OF_WINDOW;

  it.each([
    ["FUTURE", /in the future/],
    ["TOO_OLD", /72 working hours/],
    ["BEFORE_RELEASE", /before the job was released/],
    ["DONE_BEFORE_START", /earlier than when the work started/],
  ])("%s says only its own sentence", (reason, re) => {
    const m = new AppError(code, { reason }).message;
    expect(m).toMatch(re);
    // None of the other reasons' sentences leak in.
    expect(Object.values([/in the future/, /72 working hours/, /before the job was released/, /earlier than when the work started/]).filter((r) => r.test(m))).toHaveLength(1);
    expect(new AppError(code, { reason }).code).toBe("REPORTED_AT_OUT_OF_WINDOW");
  });

  it("falls back to the generic sentence for an unknown or missing reason", () => {
    expect(messageFor(code, { reason: "NOPE" })).toBe(ERROR_MESSAGES[code]);
    expect(messageFor(code)).toBe(ERROR_MESSAGES[code]);
  });

  it("an explicit message still wins, and other codes are untouched", () => {
    expect(new AppError(code, { reason: "FUTURE" }, "custom").message).toBe("custom");
    expect(new AppError(ERROR_CODES.REASON_REQUIRED, { reason: "FUTURE" }).message).toBe(ERROR_MESSAGES.REASON_REQUIRED);
  });
});
