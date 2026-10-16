import { test, expect, type Page } from "@playwright/test";

/**
 * Lean Core L2.3: Today. Needs LEAN_FLOOR=on (playwright.config.ts) and the
 * seeded operator.fabrication@ account. Service-level behaviour (scoping,
 * claim-next ranking and refusals) is in services/today.test.ts, the section
 * and check-in rules in shared/today.test.ts; here only what a browser can prove.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signIn(page: Page, identifier: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("a supervisor lands on Today; /my-day redirects there; the unassigned section is theirs to assign from", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await expect(page.getByText(/\d+ assigned · \d+ needs attention · \d+ due today · \d+ blocked/)).toBeVisible();
  // Mine only: no Claim next for a supervisor.
  await expect(page.getByRole("button", { name: "Claim next" })).toHaveCount(0);
  await expect(page.getByTestId("pool")).toBeVisible();

  await page.goto("/my-day");
  await expect(page).toHaveURL(/\/today$/);
});

test("an operator lands on Today and can claim the next job", async ({ page }) => {
  await signIn(page, "operator.fabrication@despl.local");
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByTestId("pool")).toHaveCount(0); // operators never see the department queue
  const claim = page.getByRole("button", { name: "Claim next" }).first();
  await expect(claim).toBeVisible();
  await claim.click();
  await expect(page.getByText("Claimed. It is on your list.")).toBeVisible();
  await expect(page.getByText(/^[1-9]\d* assigned/)).toBeVisible();
});

test("QC keeps its own landing and has no Today", async ({ page }) => {
  await signIn(page, "qc@despl.local");
  await expect(page).toHaveURL(/\/qc$/);
  await expect(page.getByRole("link", { name: "Today" })).toHaveCount(0);
});
