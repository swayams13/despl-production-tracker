import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_MESSAGES, errorLabel } from "./errors";

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
