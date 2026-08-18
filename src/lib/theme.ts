/**
 * Theme resolution (D27/D28, session R1 task 6).
 *
 * Two class names combine on the SAME element: `theme-industrial` is always
 * present (it is the base palette, i.e. dark), and `theme-light` /
 * `theme-outdoor` are modifiers that redefine the tokens (globals.css §
 * INDUSTRIAL THEME). No modifier = dark, which is what every existing user
 * resolves to post-migration.
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
 * Server-side class resolution. `SYSTEM` always guesses DARK here — the
 * server cannot know the browser's OS preference synchronously, and dark is
 * this app's only theme today, so the guess is right for every existing user.
 * That bounds the possible flash to exactly one case (SYSTEM + an OS that
 * actually prefers light), which <ThemeRoot />'s inline script fixes before
 * the browser paints anything below it.
 *
 * Outdoor wins over light/dark when on: it is a palette in its own right,
 * not a modifier of one (D25).
 */
export function themeClassName(pref: ThemePreference, outdoor: boolean): string {
  if (outdoor) return "theme-industrial theme-outdoor";
  return pref === "LIGHT" ? "theme-industrial theme-light" : "theme-industrial";
}

/**
 * One control, one click = one step: System → Light → Dark → Outdoor → System.
 *
 * The two DB columns stay independent (a later session can split this back
 * into two controls with no data migration); this function is only the
 * single control's presentation of them. Leaving Outdoor returns to System
 * rather than restoring the prior explicit choice — a disclosed
 * simplification, not an accident.
 */
export function nextThemeState({ themePreference, outdoorMode }: ThemeState): ThemeState {
  if (outdoorMode) return { themePreference: "SYSTEM", outdoorMode: false };
  if (themePreference === "SYSTEM") return { themePreference: "LIGHT", outdoorMode: false };
  if (themePreference === "LIGHT") return { themePreference: "DARK", outdoorMode: false };
  return { themePreference: "SYSTEM", outdoorMode: true };
}

/**
 * sonner's <Toaster> paints itself outside our token scope, so it needs the
 * choice restated in its own vocabulary. Outdoor is a dark-ground palette, so
 * it maps to "dark".
 */
export function toasterTheme({ themePreference, outdoorMode }: ThemeState): "light" | "dark" | "system" {
  if (outdoorMode || themePreference === "DARK") return "dark";
  return themePreference === "LIGHT" ? "light" : "system";
}

/** Label for the theme control — names the state you are IN, not the next one. */
export function themeLabel({ themePreference, outdoorMode }: ThemeState): string {
  if (outdoorMode) return "Outdoor";
  return themePreference === "SYSTEM" ? "System" : themePreference === "LIGHT" ? "Light" : "Dark";
}
