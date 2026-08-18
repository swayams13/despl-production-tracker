import { describe, expect, it } from "vitest";
import { nextThemeState, themeClassName, themeLabel, type ThemeState } from "./theme";

const SYSTEM: ThemeState = { themePreference: "SYSTEM", outdoorMode: false };

describe("theme cycle (D27 ruling 4: one control, one click = one step)", () => {
  it("cycles System → Light → Dark → Outdoor → System and closes the loop", () => {
    const seen: string[] = [];
    let s = SYSTEM;
    for (let i = 0; i < 4; i++) {
      seen.push(themeLabel(s));
      s = nextThemeState(s);
    }
    expect(seen).toEqual(["System", "Light", "Dark", "Outdoor"]);
    expect(s).toEqual(SYSTEM); // back to the start after four steps
  });

  it("resolves classes: no modifier = dark, and outdoor beats light/dark", () => {
    expect(themeClassName("SYSTEM", false)).toBe("theme-industrial"); // server guesses dark
    expect(themeClassName("DARK", false)).toBe("theme-industrial");
    expect(themeClassName("LIGHT", false)).toBe("theme-industrial theme-light");
    expect(themeClassName("LIGHT", true)).toBe("theme-industrial theme-outdoor");
  });
});
