import { test, expect, type Page } from "@playwright/test";

/**
 * Lean Core L2.8: the job page's tabs. Needs LEAN_FLOOR=on (the `lean` project /
 * :3001). The pipeline and status rules are table-tested (job-materials.test.ts)
 * and the reads DB-tested (job-materials.read.test.ts); here what a browser can
 * prove: the strip, URL-driven tabs, the old tab names landing on their new
 * home, each tab's anchor content, and the job switcher keeping the tab.
 * Needs the seeded DESPL-320 (9 units) and at least one other job.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signIn(page: Page, identifier: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Opens DESPL-320 from the jobs list and returns its id. */
async function openJob(page: Page): Promise<number> {
  await page.goto("/jobs");
  await page.getByRole("link", { name: "DESPL-320" }).first().click();
  await expect(page).toHaveURL(/\/jobs\/\d+/);
  return Number(page.url().match(/\/jobs\/(\d+)/)![1]);
}

test("the strip has the seven tabs in order, and each tab is URL-driven", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  const id = await openJob(page);
  const tabs = page.getByRole("tablist").first();
  await expect(tabs.getByRole("tab")).toHaveText(["Overview", "Board", "Schedule", "Materials", "QC", "Dispatch", "History"]);
  await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

  for (const [label, key] of [["Schedule", "schedule"], ["Materials", "materials"], ["QC", "qc"], ["Dispatch", "dispatch"], ["History", "history"]] as const) {
    await tabs.getByRole("tab", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${id}\\?tab=${key}$`), { timeout: 20_000 });
    await expect(tabs.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
  }

  await tabs.getByRole("tab", { name: "Board" }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${id}/board$`));
});

test("old tab names land on their new tab, keeping other parameters", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  const id = await openJob(page);
  for (const [old, want] of [
    ["gantt", "tab=schedule"],
    ["bom", "tab=materials&view=parts"],
    ["qcp", "tab=qc"],
    ["packing", "tab=dispatch"],
    ["activity", "tab=history"],
  ]) {
    await page.goto(`/jobs/${id}?tab=${old}`);
    await expect(page).toHaveURL(new RegExp(`/jobs/${id}\\?${want.replace("?", "\\?")}$`));
  }
  await page.goto(`/jobs/${id}?tab=bom&unit=99`);
  await expect(page).toHaveURL(/tab=materials&unit=99&view=parts|tab=materials&view=parts&unit=99/);
});

test("Overview keeps the stage spine, matrix and exceptions, and adds linked health tiles", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  await openJob(page);
  await expect(page.getByText("Units × stage matrix")).toBeVisible();
  await expect(page.getByText("Exceptions", { exact: true })).toBeVisible();
  const tiles = page.getByRole("group", { name: "Job health" });
  await expect(tiles).toBeVisible();
  // Every tile is a link: no dead controls.
  const tileCount = await tiles.locator(".jt-tile").count();
  expect(tileCount).toBeGreaterThanOrEqual(3);
  expect(await tiles.locator("a.jt-tile").count()).toBe(tileCount);
});

test("Materials: a read-only pipeline of five steps, and Parts and stock keeps the Stores view", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  const id = await openJob(page);
  await page.goto(`/jobs/${id}?tab=materials`);
  const group = page.getByRole("group", { name: "Materials view" });
  await expect(group.getByRole("link", { name: "Pipeline" })).toHaveAttribute("aria-current", "page");

  const lines = page.locator(".jt-lines > li");
  if ((await lines.count()) > 0) {
    const first = lines.first();
    await expect(first.locator(".jt-step")).toHaveCount(5);
    await expect(first.locator(".jt-step .jt-lab").allInnerTexts()).resolves.toEqual(expect.arrayContaining([expect.stringContaining("Indent"), expect.stringContaining("Issued")]));
    await first.locator("summary").click();
    await expect(first.getByText("Needed for")).toBeVisible();
    // Read-only: the pipeline offers no stock buttons.
    await expect(page.getByRole("button", { name: /^(Receive|Issue|Identify)/ })).toHaveCount(0);
  } else {
    await expect(page.getByText("No BOM lines on this job yet.")).toBeVisible();
  }

  await page.getByRole("link", { name: "Short this week" }).click();
  await expect(page).toHaveURL(/short=1/);

  await group.getByRole("link", { name: "Parts and stock" }).click();
  await expect(page).toHaveURL(/tab=materials&view=parts/);
  await expect(group.getByRole("link", { name: "Parts and stock" })).toHaveAttribute("aria-current", "page");
});

test("QC: this job's counts link into the queue with job= kept; a supervisor sees the QCP grid only", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  const id = await openJob(page);
  await page.goto(`/jobs/${id}?tab=qc`);
  const tiles = page.getByRole("group", { name: "QC for this job" });
  await expect(tiles.getByRole("link", { name: /^Open hold points/ })).toHaveAttribute("href", new RegExp(`/qc\\?tab=holds&job=${id}$`));
  await expect(tiles.getByRole("link", { name: /^Open NCRs/ })).toHaveAttribute("href", new RegExp(`/qc\\?tab=ncrs&job=${id}$`));
  await expect(page.getByRole("heading", { name: "Open NCRs" })).toBeVisible();
  await expect(page.getByText(/QCP \/ ITP/)).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, "sup.fabrication@despl.local");
  await page.goto(`/jobs/${id}?tab=qc`);
  await expect(page.getByRole("group", { name: "QC for this job" })).toHaveCount(0);
  await expect(page.getByText(/QCP \/ ITP/)).toBeVisible();
});

test("Dispatch: packing and dispatch on one tab, with the reasons units cannot ship yet", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  const id = await openJob(page);
  await page.goto(`/jobs/${id}?tab=dispatch`);
  await expect(page.getByRole("heading", { name: "Ready to ship" })).toBeVisible();
  // On a seeded job production is not finished, so units are blocked with the service's own codes.
  await expect(page.getByText(/\d+ of \d+ units blocked|No unit is blocked/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Packing" })).toBeVisible();
});

test("History shows the full activity log", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  const id = await openJob(page);
  await page.goto(`/jobs/${id}?tab=history`);
  await expect(page.getByText("Full activity log")).toBeVisible();
});

test("Assembly is off the strip but reachable from the Board", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  const id = await openJob(page);
  await expect(page.getByRole("tab", { name: "Assembly" })).toHaveCount(0);
  await page.goto(`/jobs/${id}/board`);
  await page.getByRole("link", { name: "Assembly", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${id}\\?tab=assembly$`));
  await expect(page.getByRole("link", { name: /Back to the Board/ })).toBeVisible();
});

test("the job switcher keeps the tab", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  const id = await openJob(page);
  await page.goto(`/jobs/${id}?tab=qc`);
  await page.locator(".jobswitch").click();
  const other = page.locator(".jobswitch .d-row").filter({ hasNotText: "DESPL-320" }).first();
  await other.click();
  // The old job's URL also matches ?tab=qc, so wait for the id to change first.
  await expect(page).not.toHaveURL(new RegExp(`/jobs/${id}\\?`), { timeout: 20_000 });
  await expect(page).toHaveURL(/\/jobs\/\d+\?tab=qc$/);
});
