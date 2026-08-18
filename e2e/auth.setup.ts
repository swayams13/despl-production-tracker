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

setup("authenticate as the seeded supervisor", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill("sup.fabrication@despl.local");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Real success signal, not a timeout: signed-in users always land on an
  // authenticated page carrying the "Sign out" control (src/app/page.tsx's
  // role redirect always lands somewhere inside the shell).
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE_PATH });
});
