import { test, expect, type Page } from "@playwright/test";

/**
 * Lean Core L2.6: the QC queue. Needs LEAN_FLOOR=on (the `lean` project / :3001).
 * The lists, ordering, paging and evidence rules are service-tested
 * (qc-queue.test.ts); here what a browser can prove: who lands where, the
 * tabs and their counts, the URL as state, and that Management reads without
 * controls.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signIn(page: Page, identifier: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("QC lands on the queue: three tabs, each with its count, URL-driven", async ({ page }) => {
  await signIn(page, "qc@despl.local");
  await expect(page).toHaveURL(/\/qc$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("QC queue");

  const tabs = page.getByRole("navigation", { name: "QC queue sections" });
  for (const name of ["Ready to inspect", "Open holds", "NCRs"]) {
    await expect(tabs.getByRole("link", { name: new RegExp(`^${name} \\d+$`) })).toBeVisible();
  }
  await expect(tabs.getByRole("link", { name: /^Ready to inspect/ })).toHaveAttribute("aria-current", "page");

  await tabs.getByRole("link", { name: /^Open holds/ }).click();
  await expect(page).toHaveURL(/\/qc\?tab=holds$/);
  await expect(tabs.getByRole("link", { name: /^Open holds/ })).toHaveAttribute("aria-current", "page");

  await page.goto("/qc?tab=ncrs&job=999999");
  await expect(page.getByText("No open NCRs.")).toBeVisible();
});

test("the old QC lists are gone: /my-day and /workspace send QC to the queue", async ({ page }) => {
  await signIn(page, "qc@despl.local");
  await page.goto("/my-day");
  await expect(page).toHaveURL(/\/qc$/);
  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/qc$/);
});

test("a supervisor has no QC queue: they land on their own screen", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await expect(page).toHaveURL(/\/today$/); // let the post-login redirect finish before navigating away
  await page.goto("/qc");
  await expect(page).toHaveURL(/\/today$/);
});

test("management reads the queue and is given no controls", async ({ page }) => {
  await signIn(page, "md@despl.local");
  await page.goto("/qc");
  await expect(page.getByText(/Read only/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Record/ })).toHaveCount(0);
});
