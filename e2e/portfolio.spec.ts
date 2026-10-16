import { test, expect, type Page } from "@playwright/test";

/**
 * Lean Core L2.7: the Portfolio at /dashboard. Needs LEAN_FLOOR=on (the `lean`
 * project / :3001). The tile arithmetic, bars, ranking and top-blocker rules are
 * unit-tested (src/lib/shared/portfolio.test.ts) and DB-tested
 * (portfolio.ops.test.ts); here what a browser can prove: who gets in, that the
 * old panels are gone, and that every tile, bar segment and row lands somewhere
 * real. Written against the seeded DESPL-320 data; tests that depend on there
 * being a delayed job or a bar skip, with the reason, when the seed has none.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signIn(page: Page, identifier: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const tile = (page: Page, name: string) => page.getByRole("navigation", { name: "Portfolio numbers" }).locator("a", { hasText: new RegExp(`^${name}`) });
const tileValue = async (page: Page, name: string) => Number((await tile(page, name).locator(".v").innerText()).trim());

test("Management sees the Portfolio: five linked tiles, the forecast line, three sections", async ({ page }) => {
  await signIn(page, "md@despl.local");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Portfolio");
  await expect(page.getByText(/^\d+ of \d+ jobs forecast past committed date/)).toBeVisible();

  const tiles = page.getByRole("navigation", { name: "Portfolio numbers" }).locator("a");
  await expect(tiles).toHaveCount(5);
  for (const name of ["Active", "Delayed", "At risk", "On hold", "Actions due"]) await expect(tile(page, name)).toBeVisible();
  for (const t of await tiles.all()) await expect(t).toHaveAttribute("href", /^\/dashboard/);

  for (const name of ["Project health", "Where work is stuck", "Needs attention"]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
});

test("the old panels are gone", async ({ page }) => {
  await signIn(page, "md@despl.local");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Portfolio");
  for (const gone of ["Portfolio health", "Department × status", "Schedule S-curve", "Critical path", "First-pass yield", "Project detail"]) {
    await expect(page.getByText(gone, { exact: false })).toHaveCount(0);
  }
});

test("the project table has six columns and the queue shows at most 15 rows", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  await page.goto("/dashboard");
  const table = page.locator(".rt-table table.pf-table");
  await expect(table.locator("thead th")).toHaveText(["Job", "Client", "Progress", "Committed → forecast", "Health", "Top blocker"]);
  await expect(table.locator("tbody tr").first()).toBeVisible();
  expect(await page.locator("ul.pf-queue > li").count()).toBeLessThanOrEqual(15);
});

test("a health tile filters the table to exactly that many rows, and clearing restores it", async ({ page }) => {
  test.setTimeout(180_000); // each /dashboard render runs CPM per job: seconds on a loaded machine
  await signIn(page, "md@despl.local");
  await page.goto("/dashboard");
  const delayed = await tileValue(page, "Delayed");
  const atRisk = await tileValue(page, "At risk");
  test.skip(delayed === 0 && atRisk === 0, "the seed has no delayed or at-risk job");
  const [name, n] = delayed > 0 ? (["Delayed", delayed] as const) : (["At risk", atRisk] as const);

  await tile(page, name).click();
  await expect(page).toHaveURL(new RegExp(`health=${name === "Delayed" ? "delayed" : "at-risk"}`), { timeout: 60_000 });
  const rows = page.locator(".rt-table table.pf-table tbody tr");
  await expect(rows).toHaveCount(n);
  await expect(rows.locator(".chip", { hasText: name })).toHaveCount(n);

  await page.getByRole("link", { name: new RegExp(`${name} · clear`) }).click();
  await expect(page).not.toHaveURL(/health=/, { timeout: 60_000 });
});

test("a bar segment opens the Team page or the QC NCR tab it counts, and Focus carries job= into every link", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, "sj@despl.local");
  await page.goto("/dashboard");
  const segs = page.locator("ul.pf-bn a.pf-seg");
  test.skip((await segs.count()) === 0, "nothing is blocked, overdue or rejected on this seed");

  const focus = page.locator(".rt-table").getByRole("link", { name: /^Show only / }).first();
  await focus.click();
  await expect(page).toHaveURL(/[?&]job=\d+/, { timeout: 60_000 });
  await expect(page.getByText(/^Showing .* only\./)).toBeVisible();
  const job = new URL(page.url()).searchParams.get("job")!;
  for (const href of await page.locator("ul.pf-bn a.pf-seg").evaluateAll((els) => els.map((e) => e.getAttribute("href")!))) {
    expect(href).toMatch(/^\/(team\/[a-z0-9_-]+\?status=(blocked|overdue)|qc\?tab=ncrs)/);
    expect(href).toContain(`job=${job}`);
  }
  await page.getByRole("link", { name: "Show all jobs" }).click();
  await expect(page).not.toHaveURL(/job=/, { timeout: 60_000 });

  const first = page.locator("ul.pf-bn a.pf-seg").first();
  const href = (await first.getAttribute("href"))!;
  await first.click();
  await expect(page).toHaveURL(new RegExp(href.split("?")[0]), { timeout: 30_000 });
});

test("a queue row links to where the work is done", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  await page.goto("/dashboard");
  const rows = page.locator("ul.pf-queue > li");
  test.skip((await rows.count()) === 0, "nothing needs attention on this seed");
  const link = rows.first().getByRole("link");
  expect(await link.getAttribute("href")).toMatch(/^\/(team\/|qc\?)/);
  await link.click();
  await expect(page).toHaveURL(/\/(team\/|qc)/, { timeout: 30_000 });
});

test("who gets in: a supervisor is sent to their own landing, not the Portfolio", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await page.goto("/dashboard");
  await expect(page).not.toHaveURL(/\/dashboard/);
});
