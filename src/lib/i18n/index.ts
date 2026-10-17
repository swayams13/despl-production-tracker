import { en, type Dict } from "./en";
import { hi } from "./hi";
import { gu } from "./gu";

export type Locale = "en" | "hi" | "gu";
export type { Dict };

/** Menu order: one tap on the person-menu row moves to the next. */
export const LOCALES: readonly Locale[] = ["en", "hi", "gu"];

const DICTS: Record<Locale, Dict> = { en, hi, gu };

export const dictFor = (locale: Locale | null | undefined): Dict => DICTS[locale ?? "en"] ?? en;

export const nextLocale = (l: Locale): Locale => LOCALES[(LOCALES.indexOf(l) + 1) % LOCALES.length];
