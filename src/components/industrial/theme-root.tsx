"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { themeClassName, type ThemeState } from "@/lib/theme";

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

interface ThemeContextValue extends ThemeState {
  /** The class string for THIS render, with SYSTEM already resolved. */
  themeClass: string;
  /** SYSTEM resolved to light by the OS. False under an explicit preference. */
  systemLight: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  themePreference: "SYSTEM",
  outdoorMode: false,
  themeClass: "theme-industrial",
  systemLight: false,
});

/**
 * Radix portals its dialog/sheet content to <body>, OUTSIDE this div, so those
 * elements re-declare the theme classes themselves. They read them from here
 * rather than having `themePreference` prop-drilled through every call site.
 */
export function useThemeClass(): string {
  return useContext(ThemeContext).themeClass;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function ThemeRoot({
  themePreference,
  outdoorMode,
  className,
  children,
}: ThemeState & { className?: string; children: ReactNode }) {
  const isSystem = themePreference === "SYSTEM" && !outdoorMode;

  /**
   * Whether SYSTEM currently resolves to light. Starts false so the first
   * client render matches the server's dark guess (same reasoning as the
   * script above), then the effect corrects it.
   *
   * This is REACT STATE and not an imperative classList.toggle on the div,
   * because the div is not the only consumer: portaled surfaces (StageSheet,
   * the admin dialogs) re-declare the palette class from the context below.
   * A DOM-only correction left them reading the unresolved "theme-industrial"
   * and rendering a dark sheet over a light page — the default state of every
   * migrated user on a light-preferring OS.
   *
   * It is also the ONLY matchMedia listener in the app: AppShell's theme
   * button reads `systemLight` from the context for its sun/moon icon rather
   * than running a second one for the same fact.
   */
  const [systemLight, setSystemLight] = useState(false);
  useEffect(() => {
    if (!isSystem) {
      setSystemLight(false);
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => setSystemLight(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [isSystem]);

  const themeClass = themeClassName(isSystem && systemLight ? "LIGHT" : themePreference, outdoorMode);

  return (
    // suppressHydrationWarning: the inline script below mutates this element's
    // class between SSR and hydration, on purpose. Nothing else about the
    // element is dynamic, so this suppresses exactly the mismatch we caused.
    <div suppressHydrationWarning className={className ? `${themeClass} ${className}` : themeClass}>
      {isSystem ? <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} /> : null}
      <ThemeContext.Provider value={{ themePreference, outdoorMode, themeClass, systemLight }}>
        {children}
      </ThemeContext.Provider>
    </div>
  );
}
