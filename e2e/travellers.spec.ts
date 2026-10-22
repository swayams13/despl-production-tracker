import { test, expect, type Page } from "@playwright/test";

/**
 * Lean Core L2.9: unit travellers (A5 print view). Read-only, independent of
 * LEAN_FLOOR. Needs the seeded DESPL-320 (9 units, 320SR01-09). Physical print
 * and scanning the QR on a phone are manual checks.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signIn(page: Page, identifier: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("the job page links to nine travellers with serial, inline QR and a /u/ link", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await page.goto("/jobs");
  await page.getByRole("cell", { name: "DESPL-320", exact: true }).click();
  await page.getByRole("link", { name: "Print travellers" }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+\/travellers$/);

  await expect(page.getByRole("heading", { level: 1, name: "Travellers" })).toBeVisible();
  await expect(page.getByTestId("tv-count")).toHaveText("9 units");
  await expect(page.getByRole("button", { name: "Print" })).toBeVisible();

  const sheets = page.getByTestId("traveller");
  await expect(sheets).toHaveCount(9);
  await expect(sheets.first()).toContainText("320SR01");
  await expect(sheets.nth(8)).toContainText("320SR09");
  await expect(sheets.first().locator(".tv-qr svg")).toHaveCount(1);
  expect(await page.locator(".tv-qr svg").count()).toBe(9);

  // The short URL is /u/<opaque id>, never the serial.
  const link = sheets.first().locator("a.tv-url");
  await expect(link).toContainText("/u/");
  expect(((await link.textContent()) ?? "").includes("320SR01")).toBe(false);

  await expect(sheets.first()).toContainText("Scan not working? Open /scan and type 320SR01");
  expect(await sheets.first().getByTestId("tv-stage").count()).toBeGreaterThan(0);
});

test("print media hides the app shell", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await page.goto("/jobs");
  await page.getByRole("cell", { name: "DESPL-320", exact: true }).click();
  await page.getByRole("link", { name: "Print travellers" }).click();
  await expect(page.getByTestId("traveller")).toHaveCount(9);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".topbar")).toBeHidden();
  await expect(page.getByTestId("traveller").first()).toBeVisible();
});

test("an unknown job is a 404", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await page.goto("/jobs/99999999/travellers");
  // The route streams behind loading.tsx, so the status is already 200: assert the page, as floor/team specs do.
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
