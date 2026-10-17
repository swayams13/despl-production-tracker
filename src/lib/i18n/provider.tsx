"use client";

import { createContext, useContext, type ReactNode } from "react";
import { dictFor, type Dict, type Locale } from ".";

const Ctx = createContext<Dict>(dictFor("en"));

/** Wraps only the Floor screen and Today (L2.12); everywhere else reads the English default. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <Ctx.Provider value={dictFor(locale)}>
      <div lang={locale}>{children}</div>
    </Ctx.Provider>
  );
}

export const useDict = () => useContext(Ctx);
