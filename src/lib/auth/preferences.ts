import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import type { ThemeState } from "@/lib/theme";
import type { Locale } from "@/lib/i18n";

/**
 * Save the caller's own appearance preference (D27/D28).
 *
 * Deliberately NOT an audited business mutation and deliberately NOT in
 * lib/services/: this is account/UI bookkeeping, the same category as
 * `User.lastLoginAt` and `sessionVersion` (both plain `tx.user.update`s with
 * no audit_log row — see login() in src/app/actions/auth.ts). CLAUDE.md
 * invariant #5 governs production-tracking domain mutations; recording that
 * someone prefers a light background is not one, and an audit row per theme
 * click would be pure noise in the trail that matters.
 *
 * Scoped by `actor.userId` inside withTenant, so a user can only ever write
 * their own row — there is no id parameter to abuse.
 */
export async function setOwnThemePreference(actor: Actor, state: ThemeState): Promise<void> {
  await withTenant(actor.tenantId, (tx) =>
    tx.user.update({
      where: { id: actor.userId },
      data: { themePreference: state.themePreference, outdoorMode: state.outdoorMode },
    }),
  );
}

/** Save the caller's own Floor/Today language (L2.12). Same category and scoping as the theme above. */
export async function setOwnLocale(actor: Actor, locale: Locale): Promise<void> {
  await withTenant(actor.tenantId, (tx) => tx.user.update({ where: { id: actor.userId }, data: { locale } }));
}
