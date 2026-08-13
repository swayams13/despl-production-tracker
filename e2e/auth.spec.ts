import { test, expect } from "@playwright/test";

/**
 * Auth, RBAC and client-scoping boundaries.
 *
 * These are violation tests first (CLAUDE.md: "table-driven tests for the
 * violation cases, not just happy paths"). The happy paths are here only to
 * prove the refusals are not passing for the wrong reason.
 *
 * Assumes `pnpm db:seed` has run with the default dev password.
 */

const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

function formError(page: import("@playwright/test").Page) {
  return page.locator('form [role="alert"]');
}

async function signIn(page: import("@playwright/test").Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("unauthenticated request to a protected route is redirected to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("wrong password is refused, and does not reveal whether the account exists", async ({
  page,
}) => {
  await signIn(page, "sup.fabrication@despl.local", "definitely-not-the-password");
  // scoped to the form: Next.js also renders a route announcer with role="alert"
  await expect(formError(page)).toHaveText("Email or password is incorrect");
  await expect(page).toHaveURL(/\/login/);
});

test("unknown account gives the identical message as a wrong password", async ({ page }) => {
  await signIn(page, "does-not-exist@despl.local");
  await expect(formError(page)).toHaveText("Email or password is incorrect");
});

test("internal user signs in and sees tenant-scoped jobs", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "DESPL Production Tracker" })).toBeVisible();

  // the three seeded jobs, read under row-level security
  await expect(page.getByRole("cell", { name: "DE0463" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "DE0467" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "DESPL-320" })).toBeVisible();
});

test("client user lands in the portal and cannot reach the internal app", async ({ page }) => {
  await signIn(page, "client@example.local");
  await expect(page).toHaveURL("/portal");
  await expect(page.getByRole("heading", { name: "Your orders" })).toBeVisible();

  // the internal home must bounce a client user straight back out
  await page.goto("/");
  await expect(page).toHaveURL("/portal");
});

test("signing out clears the session and re-protects the app", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await expect(page).toHaveURL("/");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});
