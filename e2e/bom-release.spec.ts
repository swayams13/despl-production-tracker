import { test, expect as baseExpect, type Page } from "@playwright/test";

// Release and the board render heavy pages; on a loaded machine the default 5 s is too tight.
const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * Lean Core J5b: BOM release through the REAL /login form (never a forged session, CLAUDE.md
 * "Agent conduct"). On a fresh job made in the wizard with DESPL-320's BOM copied:
 *   the wizard's result step links to the release screen -> map the lines -> the acknowledgement
 *   gates Release -> release -> counts -> the floor (board) has its stages -> the screen reads
 *   "released" afterwards. A planner reaches the screen and is given no controls.
 *
 * Needs the seeded DB (prisma/seed.ts + the despl320 seeds, as CI does): sj@ and planner@ accounts,
 * the "Vertical vessel on skirt" equipment type and DESPL-320's 29-line BOM.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  await expect(page.locator(".person-btn:visible")).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test("a new job's BOM is released from the screen, not created by an import or by the job itself", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, "sj@despl.local");

  // ── the wizard: a PV job, one block of two units, DESPL-320's BOM copied ──
  const jobNumber = `J5B-E2E-${Date.now()}`;
  await page.goto("/jobs/new");
  await page.getByRole("link", { name: "Start from a template" }).click();
  await page.getByPlaceholder("Search client…").click();
  await page.locator(".drop .d-row").first().click();
  await page.getByPlaceholder("e.g. DESPL-321").fill(jobNumber);
  await page.locator('input[type="date"]').nth(1).fill("2027-03-31");
  await page.getByRole("button", { name: "Next →" }).click(); // J7b: the wizard holds its state in the page, so no waits between steps
  await page.getByText(/route version available/).first().click();
  const picker = page.getByRole("combobox", { name: "Equipment type or master BOM for line 1" });
  await picker.click();
  await picker.fill("DESPL-320");
  await page.getByRole("option", { name: /DESPL-320 · .* · 29 lines/ }).first().click(); // type-ahead: the master BOM of an earlier job
  await page.getByPlaceholder("e.g. 320SR").fill("J5BE");
  await page.locator("xpath=//label[normalize-space()='Quantity']/following::input[1]").fill("2");
  await page.getByRole("button", { name: "Next →" }).click();
  await page.locator("xpath=//label[normalize-space()='Shell courses']/following::input[1]").fill("2");
  await page.getByRole("button", { name: "Next →" }).click(); // QC plan
  await page.getByRole("button", { name: "Next →" }).click(); // schedule and release
  await page.getByRole("button", { name: "Create job" }).click();
  await expect(page.getByText("Job created")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Floor steps are created when the BOM is released/)).toBeVisible();

  // ── the result step leads to the release screen; nothing is on the floor yet ──
  await page.getByRole("link", { name: /Next: release the BOM/ }).click();
  await expect(page.getByRole("heading", { name: "BOM release" })).toBeVisible();
  await expect(page.getByText("29 lines", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Release revision 1/ })).toBeDisabled(); // unmapped lines and unchecked warnings
  await expect(page.getByText(/BOM lines have no part family/)).toBeVisible();

  // ── map: take every suggestion, save; Release stays off until the warnings are acknowledged ──
  const use = page.getByRole("button", { name: /^Use / });
  const suggestions = await use.count();
  expect(suggestions).toBeGreaterThan(0);
  for (let i = suggestions - 1; i >= 0; i--) await use.nth(i).click();
  await expect(page.getByRole("button", { name: /Save mapping/ })).toBeVisible();
  await expect(page.getByText(/Save the mapping first/)).toBeVisible();
  await page.getByRole("button", { name: /Save mapping/ }).click();
  await expect(page.getByRole("button", { name: /Save mapping/ })).toHaveCount(0);
  await expect(page.getByText("Components", { exact: true })).toBeVisible();

  const release = page.getByRole("button", { name: /Release revision 1/ });
  await expect(release).toBeDisabled();
  await expect(page.getByText(/Tick the box to confirm/)).toBeVisible();
  await page.getByRole("checkbox", { name: /I have checked these/ }).check();
  await expect(release).toBeEnabled();

  // ── release ──
  await release.click();
  await page.getByRole("dialog").getByRole("button", { name: "Release" }).click();
  await expect(page.getByText("BOM released. The floor steps are made.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/\d+ components, \d+ operations, \d+ assembly steps/)).toBeVisible();
  await expect(page.getByText(/Revision 1 is released/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Release revision 1/ })).toHaveCount(0);

  // ── a reload says "released"; the floor has its stages ──
  await page.reload();
  await expect(page.getByText(/This revision is released/)).toBeVisible();
  await page.goto(page.url().replace(/\/release.*$/, "/board"));
  await expect(page.getByRole("heading", { name: new RegExp(`${jobNumber}.*Board`) })).toBeVisible();
  await expect(page.getByText("J5BE01")).toBeVisible();
  await expect(page.getByText(/SHELL F/i).first()).toBeVisible();

  // ── a planner sees the screen and no controls ──
  const releaseUrl = page.url().replace("/board", "/release");
  await page.context().close();
  const planner = await (await browser.newContext()).newPage();
  await signIn(planner, "planner@despl.local");
  await planner.goto(releaseUrl);
  await expect(planner.getByText(/Engineering, the Production Head and Admins map and release the BOM/)).toBeVisible();
  await expect(planner.getByRole("button", { name: /Release revision|Start revision|Save mapping/ })).toHaveCount(0);
  await planner.context().close();
});
