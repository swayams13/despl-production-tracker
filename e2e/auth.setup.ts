import { test as setup, expect } from "@playwright/test";

/**
 * Playwright's standard "setup project" auth pattern (their own
 * "Projects dependencies" idiom — https://playwright.dev/docs/auth). Runs
 * once, logs in through the REAL `/login` form (never a forged
 * session/JWT — CLAUDE.md's Agent Conduct section, the 16 Aug 2026
 * portfolio-dashboard incident), and saves the resulting cookies so the
 * `phone`/`tablet`/`desktop` projects can each declare
 * `dependencies: ['setup']` + `use: { storageState: ... }` and reuse this
 * one login instead of three separate logins racing each other.
 *
 * Same account and password convention as e2e/auth.spec.ts's signIn()
 * helper: the seeded supervisor `sup.fabrication@despl.local`.
 */

const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";
const STORAGE_STATE_PATH = "playwright/.auth/supervisor.json";
/** See THEME_STORAGE_STATE in supervisor-viewport.spec.ts for why this exists. */
const THEME_STORAGE_STATE_PATH = "playwright/.auth/theme-supervisor.json";

async function signIn(page: import("@playwright/test").Page, email: string, statePath: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Real success signal, not a timeout: signed-in users always land on an
  // authenticated page carrying the "Sign out" control (src/app/page.tsx's
  // role redirect always lands somewhere inside the shell).
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.context().storageState({ path: statePath });
}

setup("authenticate as the seeded supervisor", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local", STORAGE_STATE_PATH);
});

/**
 * A SECOND real login, as a DIFFERENT seeded supervisor, used only by the
 * theme-cycling tests.
 *
 * Those tests are the one place in the suite that writes persistent per-user
 * state (`users.theme_preference` / `users.outdoor_mode`). The phone/tablet/
 * desktop projects run in PARALLEL and shared one identity, so the desktop
 * project's theme cycling could repaint the palette out from under the other
 * two projects mid-measurement — `test.describe.serial()` only serialises
 * within a single project, never across them. A separate identity removes the
 * shared row entirely, which no amount of in-project serialisation can.
 *
 * Same department-agnostic SUPERVISOR role as the primary fixture, so every
 * page the theme tests visit (/kit, /my-day) renders identically.
 */
setup("authenticate as the theme-test supervisor", async ({ page }) => {
  await signIn(page, "sup.machine_shop@despl.local", THEME_STORAGE_STATE_PATH);
});
