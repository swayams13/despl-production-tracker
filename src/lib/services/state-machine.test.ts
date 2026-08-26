import { describe, expect, it } from "vitest";
import { assertStateTransition } from "./state-machine";
import { ERROR_CODES } from "@/lib/shared/errors";

type Status = "A" | "B" | "C";
type Action = "advance" | "skip";

const TRANSITIONS: Record<Action, { from: Status[]; to: Status }> = {
  advance: { from: ["A"], to: "B" },
  skip: { from: ["A"], to: "C" },
};

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe("assertStateTransition", () => {
  it("returns the target status for a legal transition", () => {
    expect(assertStateTransition(TRANSITIONS, "advance", "A", "Widget")).toBe("B");
  });

  it("throws INVALID_STATE_TRANSITION for an illegal source state", () => {
    expect(code(() => assertStateTransition(TRANSITIONS, "advance", "B", "Widget"))).toBe(
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  });

  it("carries the entity name in the error payload", () => {
    try {
      assertStateTransition(TRANSITIONS, "skip", "B", "Widget");
      throw new Error("expected assertStateTransition to throw");
    } catch (e) {
      expect((e as { detail?: { entity?: string } }).detail?.entity).toBe("Widget");
    }
  });
});
