import { test, expect, type Page } from "@playwright/test";

/**
 * Lean Core L2.4: the Job board. Read-only whatever LEAN_FLOOR says (its
 * actions appear only with the switch on), so it runs on the legacy server.
 * Needs the seeded DESPL-320 (9 units).
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signIn(page: Page, identifier: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function openBoard(page: Page) {
  await page.goto("/jobs");
  await page.getByRole("link", { name: "DESPL-320" }).first().click();
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+\/board$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Board");
}

test("the board shows a row per unit, prints every cell, and a cell opens the stage sheet", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await openBoard(page);

  await expect(page.locator(".bd-grid tbody tr")).toHaveCount(9);
  const cells = page.locator(".bd-cell");
  expect(await cells.count()).toBeGreaterThan(9);
  // No cell is empty: the value is always printed.
  const empty = await cells.evaluateAll((els) => els.filter((e) => !(e.textContent ?? "").trim()).length);
  expect(empty).toBe(0);
  await expect(page.getByRole("list", { name: "Legend" })).toBeVisible();

  await cells.nth(1).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Steps in this stage")).toBeVisible();
});

test("arrow keys move between cells", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await openBoard(page);
  const first = page.locator('.bd-cell[data-row="0"][data-col="0"]');
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('.bd-cell[data-row="0"][data-col="1"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('.bd-cell[data-row="1"][data-col="1"]')).toBeFocused();
});

test("filters live in the URL and survive a reload", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await openBoard(page);
  await page.getByRole("link", { name: /^Hide finished stages/ }).click();
  await expect(page).toHaveURL(/hide=1/);
  await page.reload();
  await expect(page.getByRole("link", { name: /^Hide finished stages/ })).toHaveClass(/on/);
});

test("Export to Excel returns the Units x Process Tracker workbook", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await openBoard(page);
  const href = await page.getByRole("link", { name: "Export to Excel" }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("spreadsheetml");
  expect((await res.body()).byteLength).toBeGreaterThan(2000);
});

test("a client user cannot read a board", async ({ page }) => {
  await signIn(page, "client@example.local");
  const res = await page.request.get("/api/jobs/1/board/export");
  expect(res.status()).toBe(403);
});
