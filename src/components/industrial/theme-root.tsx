"use client";

import { createContext, useContext, useEffect, useRef, type RefObject, type ReactNode } from "react";
import { themeClassName, type ThemePreference, type ThemeState } from "@/lib/theme";

/**
 * ThemeRoot — the single element that carries the industrial palette classes,
 * plus the no-flash script and the context that portaled surfaces read.
 *
 * WHY A SCRIPT INSIDE THE DIV, not the usual one in <head>: the palette is
 * scoped to a <div> on purpose (legacy warm-paper pages outside the (app)
 * route group must keep their own theme), so there is no <html> class to set.
 * A plain synchronous inline <script> blocks HTML parsing where it appears and
 * runs before the browser paints anything after it — including the rest of
 * this div's own children — so it gives the same zero-flash guarantee, just
 * correctly scoped. It only ever runs for a genuine SYSTEM preference; an
 * explicit LIGHT/DARK/Outdoor was already resolved correctly server-side, and
 * nothing is interpolated into the script (the preference is branched on at
 * render time), so there is no escaping hazard.
 *
 * `document.currentScript.parentElement` is used rather than an id so several
 * ThemeRoots (login, /account/password, the app shell) never collide.
 */
const SYSTEM_THEME_SCRIPT =
  "(function(){var e=document.currentScript.parentElement;" +
  "if(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)" +
  "e.classList.add('theme-light');})();";

const ThemeContext = createContext<ThemeState & { themeClass: string }>({
  themePreference: "SYSTEM",
  outdoorMode: false,
  themeClass: "theme-industrial",
});

/**
 * Radix portals its dialog/sheet content to <body>, OUTSIDE this div, so those
 * elements re-declare the theme classes themselves. They read them from here
 * rather than having `themePreference` prop-drilled through every call site.
 */
export function useThemeClass(): string {
  return useContext(ThemeContext).themeClass;
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}

/**
 * Keeps a SYSTEM preference in sync after first paint: the inline script above
 * only runs once per document load, so it cannot cover (a) cycling back to
 * System via router.refresh(), or (b) the OS flipping light/dark while the app
 * is open. Both are pure client-side concerns, so an effect is the right tool;
 * it is never the thing that prevents the flash.
 */
function useSystemThemeSync(pref: ThemePreference, outdoor: boolean, ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || outdoor || pref !== "SYSTEM") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => el.classList.toggle("theme-light", mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref, outdoor, ref]);
}

export function ThemeRoot({
  themePreference,
  outdoorMode,
  className,
  children,
}: ThemeState & { className?: string; children: ReactNode }) {
  const themeClass = themeClassName(themePreference, outdoorMode);
  const ref = useRef<HTMLDivElement | null>(null);
  useSystemThemeSync(themePreference, outdoorMode, ref);

  return (
    <div ref={ref} className={className ? `${themeClass} ${className}` : themeClass}>
      {themePreference === "SYSTEM" && !outdoorMode ? (
        <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} />
      ) : null}
      <ThemeContext.Provider value={{ themePreference, outdoorMode, themeClass }}>{children}</ThemeContext.Provider>
    </div>
  );
}
