import { test, expect, type Page } from "@playwright/test";

/**
 * Lean Core J7b: the new-job flow through the REAL /login form (never a forged session, CLAUDE.md
 * "Agent conduct"). No sleeps between steps: the wizard's state lives in the component (the URL
 * carries only ?draft=<id>), so fast clicks cannot race it.
 *   1. Copy DESPL-320 as a draft -> change the serials -> the Configure preview -> reload resumes the
 *      draft -> create -> the BOM waits as a draft.
 *   2. Build from master: the type's kit fills the BOM as a draft revision (no floor steps).
 *   3. A planner builds a draft but is not given Create.
 *
 * Needs the seeded DB (prisma/seed.ts + the despl320 seeds, as CI does): sj@ and planner@ accounts, the
 * "Vertical vessel on skirt" equipment type with its kit, and DESPL-320's 29-line BOM.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator(".person-btn:visible")).toBeVisible();
}

const next = (page: Page) => page.getByRole("button", { name: "Next →" });

/** Step 1 (the client is picked when the draft did not bring one). */
async function fillOrder(page: Page, jobNumber: string) {
  if (!(await page.getByPlaceholder("Search client…").inputValue())) {
    await page.getByPlaceholder("Search client…").click();
    await page.locator(".drop .d-row").first().click();
  }
  await page.getByPlaceholder("e.g. DESPL-321").fill(jobNumber);
  await page.locator('input[type="date"]').nth(0).fill("2026-10-22");
  await page.locator('input[type="date"]').nth(1).fill("2027-06-30");
  await next(page).click();
}
async function fillSerials(page: Page, prefix: string, qty: string) {
  await page.getByPlaceholder("e.g. 320SR").fill(prefix);
  await page.locator("xpath=//label[normalize-space()='Quantity']/following::input[1]").fill(qty);
}

test.describe.configure({ mode: "serial" });

test("copy DESPL-320 as a draft, preview it, resume it after a reload, create it", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, "sj@despl.local");
  const jobNumber = `J7B-COPY-${Date.now()}`;

  await page.goto("/jobs/new");
  await expect(page.getByRole("heading", { name: "New job" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy as draft" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Copy DESPL-320 as draft" }).click();
  await expect(page).toHaveURL(/\/jobs\/new\?draft=\d+/);

  // ── no waits between steps ──
  await fillOrder(page, jobNumber);
  await expect(page.getByRole("heading", { name: "Product family and route" })).toBeVisible();
  await fillSerials(page, "J7BC", "2");
  await expect(page.getByText(/Serial numbers must be unique/)).toHaveCount(0);
  await next(page).click();

  // ── Configure: the live preview is the real createJob, rolled back ──
  await expect(page.getByRole("heading", { name: "What this job will get" })).toBeVisible();
  await expect(page.getByText("29", { exact: true }).first()).toBeVisible({ timeout: 60_000 }); // BOM lines copied
  await expect(page.getByText("Floor steps once the BOM is released")).toBeVisible();
  await next(page).click();
  await expect(page.getByRole("heading", { name: /QC plan/i })).toBeVisible();
  await next(page).click();
  await expect(page.getByText(/Schedule, worked back from/i)).toBeVisible();
  await expect(page.getByText(/Fits the delivery window|Tight|Short by|Cannot check yet/)).toBeVisible({ timeout: 60_000 });

  // ── the draft survives a reload and reopens on the last step ──
  await expect(page.getByText(/Draft saved/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Schedule, worked back from/i)).toBeVisible();
  await expect(page.getByText("J7BC01", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Create job" }).click();
  await expect(page.getByText("Job created")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/2 units/)).toBeVisible();
  await expect(page.getByText(/Floor steps are created when the BOM is released/)).toBeVisible();

  // ── the draft is spent: its link says so, and the start screen no longer lists it ──
  await page.reload();
  await expect(page.getByText(/already turned into a job/)).toBeVisible();
  await page.goto("/jobs/new");
  await expect(page.getByText(jobNumber)).toHaveCount(0);
  await page.context().close();
});

test("Build from master: the equipment type's kit fills the BOM as a draft revision", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, "sj@despl.local");
  const jobNumber = `J7B-MASTER-${Date.now()}`;

  await page.goto("/jobs/new");
  await page.getByRole("link", { name: "Build from master" }).click();
  await expect(page).toHaveURL(/route=master/);
  await fillOrder(page, jobNumber);

  await page.getByText(/route version available/).first().click();
  await page.locator("select").filter({ hasText: "Vertical vessel on skirt" }).selectOption({ label: "Vertical vessel on skirt" });
  // the kit is shown before anything is created
  await expect(page.getByText(/from the Vertical vessel on skirt kit go into the BOM as a draft/)).toBeVisible();
  await expect(page.getByRole("cell", { name: "Skirt", exact: true })).toBeVisible();
  await fillSerials(page, "J7BM", "1");
  await next(page).click();

  await expect(page.getByRole("heading", { name: "What this job will get" })).toBeVisible();
  await expect(page.getByText("BOM lines")).toBeVisible();
  await next(page).click();
  await next(page).click();
  await page.getByRole("button", { name: "Create job" }).click();
  await expect(page.getByText("Job created")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/7 BOM lines/)).toBeVisible();

  await page.getByRole("link", { name: /Next: release the BOM/ }).click();
  await expect(page.getByRole("heading", { name: "BOM release" })).toBeVisible();
  await expect(page.getByText("7 lines", { exact: true })).toBeVisible();
  await page.context().close();
});

test("a planner builds and saves a draft; Create is the Production Head's", async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, "planner@despl.local");

  await page.goto("/jobs/new");
  await expect(page.getByText(/You can build and save drafts/)).toBeVisible();
  await page.getByRole("link", { name: "Start from a template" }).click();
  await fillOrder(page, `J7B-PLAN-${Date.now()}`);
  await page.getByText(/route version available/).first().click();
  await page.locator("select").filter({ hasText: "Vertical vessel on skirt" }).selectOption({ label: "Vertical vessel on skirt" });
  await fillSerials(page, "J7BP", "1");
  await next(page).click();
  await next(page).click();
  await next(page).click();
  await expect(page.getByText(/Schedule, worked back from/i)).toBeVisible();
  await expect(page.getByText(/Draft saved/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create job" })).toHaveCount(0);
  await expect(page.getByText(/creates the job from it/)).toBeVisible();

  // Save and exit lands on the start screen with the draft listed
  await page.getByRole("button", { name: "Save and exit" }).click();
  await expect(page.getByRole("heading", { name: "Saved drafts" })).toBeVisible();
  await page.context().close();
});
