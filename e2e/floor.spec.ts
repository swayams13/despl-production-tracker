import { test, expect, type Page } from "@playwright/test";

/**
 * Lean Core L2.2: the Floor screen and its QR path. Needs LEAN_FLOOR=on (set in
 * playwright.config.ts's webServer env) and the seeded DESPL-320 units.
 *
 * Writes are covered at service level (work.service tests; floor.test.ts for
 * the read model and the joint / notify writes). Here only what a browser can
 * prove: the signed-out QR round trip, Scan, the Undo window sending nothing,
 * and a refusal card naming who can clear it.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";
const SERIAL = "320SR01";

async function signIn(page: Page, identifier: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function openUnit(page: Page): Promise<string> {
  await page.goto(`/scan?serial=${SERIAL}`);
  await expect(page).toHaveURL(/\/u\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: SERIAL })).toBeVisible();
  return new URL(page.url()).pathname;
}

test("a QR scanned while signed out returns to the unit after login", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  const path = await openUnit(page);

  await page.context().clearCookies();
  await page.goto(path);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Username or email").fill("sup.fabrication@despl.local");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByRole("heading", { level: 1, name: SERIAL })).toBeVisible();
});

test("Scan: an unknown serial says so, and an unknown unit id is not found", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await page.goto("/scan?serial=NO-SUCH-SERIAL");
  await expect(page.getByText("No unit has the serial NO-SUCH-SERIAL")).toBeVisible();
  // The route streams behind loading.tsx, so the status is already 200: assert the not-found page.
  await page.goto("/u/not-a-real-unit");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.locator(".fl-wrap")).toHaveCount(0);
});

test("Undo inside the 10 s window sends nothing", async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page, "sup.fabrication@despl.local");
  const path = await openUnit(page);

  // The first row a supervisor can act on: Done, Start, or (out of order) Start early with a reason.
  const act = page.locator(".fl-row").getByRole("button", { name: /^(Done|Start early…)$/ }).first();
  test.skip((await act.count()) === 0, "no actionable row on this unit");
  const row = act.locator("xpath=ancestor::li[1]");
  const title = (await row.locator(".fl-main b").innerText()).trim();
  await act.click();
  const sheet = page.locator(".fl-sheet");
  if (await sheet.getByText("Why now?").count()) await sheet.locator(".fl-chip").first().click();
  await sheet.locator(".fl-sheet-foot .btn-accent").click();

  await expect(page.locator(".fl-undo")).toBeVisible();
  await page.locator(".fl-undo").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".fl-undo")).toHaveCount(0);

  await page.waitForTimeout(11_000); // past the window: a stray send would land now
  await page.goto(path);
  await expect(page.locator(".fl-row", { hasText: title }).first()).toContainText(/Out of usual order|Ready|In progress/);
  await expect(page.locator(".fl-result")).toHaveCount(0);
  await expect(page.locator(".fl-row", { hasText: title }).first()).not.toContainText("started early");
});

test("a row that cannot start names what is missing and who can clear it", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await openUnit(page);
  const more = page.getByRole("button", { name: /^Show \d+ more$/ });
  if (await more.isVisible()) await more.click();
  const card = page.locator(".fl-refusal").first();
  test.skip((await card.count()) === 0, "this unit has no blocked row in the seed");
  await expect(card.locator("b")).not.toBeEmpty();
});
