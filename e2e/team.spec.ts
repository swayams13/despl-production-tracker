import { test, expect, type Page } from "@playwright/test";

/**
 * Lean Core L2.5: Team. Needs LEAN_FLOOR=on (the `lean` project / :3001). The
 * counts, workload and bulk assign are service-tested (team.test.ts); here
 * what a browser can prove: routing, access, the department switcher, that the
 * header numbers add up, and the old URLs landing on Team.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signIn(page: Page, identifier: string) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("a supervisor's Team is their own department, and the numbers add up", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await page.goto("/team");
  await expect(page).toHaveURL(/\/team\/fabrication$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Fabrication");
  await expect(page.getByRole("group", { name: "Department numbers" })).toBeVisible();

  const line = await page.getByText(/^Open \d+ is \d+ assigned plus \d+ unassigned/).innerText();
  const [open, assigned, unassigned] = line.match(/\d+/g)!.map(Number);
  expect(assigned + unassigned).toBe(open);
  // A supervisor has no department switcher.
  await expect(page.getByRole("combobox", { name: "Department" })).toHaveCount(0);
});

test("another department's supervisor gets not-found, not a forbidden page", async ({ page }) => {
  await signIn(page, "sup.stores@despl.local");
  await page.goto("/team/fabrication");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("the Production Head switches department", async ({ page }) => {
  await signIn(page, "sj@despl.local");
  await page.goto("/team");
  const sw = page.getByRole("combobox", { name: "Department" });
  await expect(sw).toBeVisible();
  await sw.selectOption({ label: "Stores" });
  await expect(page).toHaveURL(/\/team\/stores$/);
});

test("old URLs land on Team: /workspace keeps its job and status, /command/[dept] keeps its department", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await page.goto("/workspace?job=1&status=overdue");
  await expect(page).toHaveURL(/\/team(\/[a-z_]+)?\?job=1&status=overdue$/);
  await page.goto("/command/procurement");
  await expect(page).toHaveURL(/\/team\/procurement$/);
});

test("management can read a department but is given no controls", async ({ page }) => {
  await signIn(page, "md@despl.local");
  await page.goto("/team/fabrication");
  await expect(page.getByText("read only")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reassign" })).toHaveCount(0);
});
