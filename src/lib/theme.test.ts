import { describe, expect, it } from "vitest";
import { nextThemeState, themeClassName, themeLabel, toasterTheme, type ThemeState } from "./theme";

const SYSTEM: ThemeState = { themePreference: "SYSTEM", outdoorMode: false };

describe("theme cycle (L2.0: Automatic → Floor → Control room)", () => {
  it("cycles Automatic → Floor → Control room and closes the loop in three steps", () => {
    const seen: string[] = [];
    let s = SYSTEM;
    for (let i = 0; i < 3; i++) {
      seen.push(themeLabel(s));
      s = nextThemeState(s);
    }
    expect(seen).toEqual(["Automatic", "Floor", "Control room"]);
    expect(s).toEqual(SYSTEM);
  });

  it("never writes outdoorMode=true; a stored legacy Outdoor steps to Automatic", () => {
    for (const pref of ["SYSTEM", "LIGHT", "DARK"] as const) {
      expect(nextThemeState({ themePreference: pref, outdoorMode: false }).outdoorMode).toBe(false);
    }
    expect(nextThemeState({ themePreference: "DARK", outdoorMode: true })).toEqual(SYSTEM);
  });
});

describe("class resolution (the stored outdoorMode column is read as Floor)", () => {
  it.each([
    ["SYSTEM", false, "theme-industrial"], // server guess; ThemeRoot corrects on a coarse pointer
    ["DARK", false, "theme-industrial"],
    ["LIGHT", false, "theme-industrial theme-light"],
    ["DARK", true, "theme-industrial theme-light"],
    ["SYSTEM", true, "theme-industrial theme-light"],
    ["LIGHT", true, "theme-industrial theme-light"],
  ] as const)("(%s, outdoor=%s) → %s", (pref, outdoor, cls) => {
    expect(themeClassName(pref, outdoor)).toBe(cls);
  });

  it("labels legacy outdoor as Floor and never emits the retired class", () => {
    expect(themeLabel({ themePreference: "DARK", outdoorMode: true })).toBe("Floor");
    expect(themeClassName("SYSTEM", true)).not.toContain("outdoor");
  });

  it.each([
    [{ themePreference: "DARK", outdoorMode: false }, "dark"],
    [{ themePreference: "LIGHT", outdoorMode: false }, "light"],
    [{ themePreference: "SYSTEM", outdoorMode: true }, "light"],
    [{ themePreference: "SYSTEM", outdoorMode: false }, "system"],
  ] as const)("toaster for %j is %s", (state, want) => {
    expect(toasterTheme(state)).toBe(want);
  });
});
