import { describe, expect, it } from "vitest";
import { plural } from "./plural";

describe("plural", () => {
  it.each([
    [0, "0 items"],
    [1, "1 item"],
    [2, "2 items"],
    [12, "12 items"],
  ])("%i -> %s", (n, out) => expect(plural(n, "item")).toBe(out));

  it("takes an explicit plural form", () => {
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(3, "entry", "entries")).toBe("3 entries");
  });
});
