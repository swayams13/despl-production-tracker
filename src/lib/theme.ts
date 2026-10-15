/**
 * Theme resolution (D27/D28, session R1 task 6; reworked L2.0, frame 00).
 *
 * Two palettes: **Floor** (light, high-contrast, bay tablets and phones) and
 * **Control room** (dark, desktops and management). Two class names combine on
 * the SAME element: `theme-industrial` is always present (the base palette,
 * i.e. Control room) and `theme-light` is the modifier that redefines the
 * tokens for Floor (globals.css § INDUSTRIAL THEME). No modifier = Control room.
 *
 * "Automatic" (SYSTEM) is decided by the pointer type, not the OS colour
 * scheme: a coarse primary pointer (phone, shop tablet) gets Floor, anything
 * else gets Control room. An explicit choice always wins. Users who predate the
 * theme system were back-filled to an explicit DARK (migration
 * 20260818120000_theme_preference_dark_backfill) and stay on Control room until
 * they pick another; accounts created since keep the SYSTEM default.
 *
 * The retired black "Outdoor" palette is gone. The stored `outdoorMode` column
 * is left alone and READ as Floor, so nobody's saved choice breaks and the
 * change reverts in one commit.
 *
 * The class deliberately lives on a <div>, not <html>: legacy warm-paper
 * pages outside the (app) route group keep a different theme entirely, so the
 * industrial palette has to stay scoped. See <ThemeRoot /> for how the
 * no-flash guarantee is kept without a <head> script.
 */

export type ThemePreference = "SYSTEM" | "LIGHT" | "DARK";

export interface ThemeState {
  themePreference: ThemePreference;
  outdoorMode: boolean;
}

/**
 * Server-side class resolution. `SYSTEM` always guesses Control room here: the
 * server cannot know the pointer type synchronously. That bounds the possible
 * flash to exactly one case (SYSTEM on a coarse pointer), which <ThemeRoot />'s
 * inline script fixes before the browser paints anything below it.
 *
 * A stored `outdoorMode` resolves to Floor, whatever the preference says.
 */
export function themeClassName(pref: ThemePreference, outdoor: boolean): string {
  return outdoor || pref === "LIGHT" ? "theme-industrial theme-light" : "theme-industrial";
}

/**
 * One control, one click = one step: Automatic → Floor → Control room →
 * Automatic. The two DB columns stay independent; the control only ever writes
 * `outdoorMode=false`, so a legacy Outdoor user steps to Automatic.
 */
export function nextThemeState({ themePreference, outdoorMode }: ThemeState): ThemeState {
  if (outdoorMode || themePreference === "DARK") return { themePreference: "SYSTEM", outdoorMode: false };
  if (themePreference === "SYSTEM") return { themePreference: "LIGHT", outdoorMode: false };
  return { themePreference: "DARK", outdoorMode: false };
}

/**
 * sonner's <Toaster> paints itself outside our token scope, so it needs the
 * choice restated in its own vocabulary. Automatic follows sonner's own
 * "system" (frame 00 draws toasts as an inverse surface either way).
 */
export function toasterTheme({ themePreference, outdoorMode }: ThemeState): "light" | "dark" | "system" {
  if (outdoorMode || themePreference === "LIGHT") return "light";
  return themePreference === "DARK" ? "dark" : "system";
}

/** Label for the theme control — names the state you are IN, not the next one. */
export function themeLabel({ themePreference, outdoorMode }: ThemeState): string {
  if (outdoorMode) return "Floor";
  return themePreference === "SYSTEM" ? "Automatic" : themePreference === "LIGHT" ? "Floor" : "Control room";
}
