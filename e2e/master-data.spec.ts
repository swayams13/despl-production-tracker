import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * Master data (Lean Core M3-B), driven through the REAL /login form for every
 * role — never a forged session (CLAUDE.md "Agent conduct").
 *
 * Needs the seeded DB: SHL-01 is a DRAFT part prepared by eng@despl.local, and
 * eng / planner / sj / reviewer accounts exist (prisma/seed.ts §12, §12b).
 * Written to be re-runnable: it brings SHL-01 back to a draft first.
 *
 * "A job created afterwards uses the new version; an existing job keeps the
 * old one" is proven at service level (master-data.service.test.ts, spec accept
 * test); driving /jobs/new needs a seeded BOM line on SHL-01, which is not part
 * of the demo seed.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator(".person-btn:visible")).toBeVisible();
  return page;
}

async function openShl01(page: Page) {
  await page.goto("/admin/master-data?q=SHL-01");
  await page.getByRole("link", { name: "SHL-01" }).first().click();
  await expect(page.getByRole("heading", { name: /SHL-01/ })).toBeVisible();
}

const chip = (page: Page, text: string) => page.locator(".chip", { hasText: text });

test.describe.configure({ mode: "serial" });

test("a planner can read master data but is given no controls", async ({ browser }) => {
  const page = await signedIn(browser, "planner@despl.local");
  await openShl01(page);
  for (const name of [/Edit part/, /Mark reviewed/, /Approve part/, /Revise/, /Edit steps/]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
  // Not yet approved: the screen says who will approve it (re-runs may find it approved).
  if ((await chip(page, "Approved").count()) === 0) {
    await expect(page.getByText(/Only the Production Head approves master data/).first()).toBeVisible();
  }
  await page.context().close();
});

test("engineering edits the steps; a second person marks it reviewed; SJ approves", async ({ browser }) => {
  // Bring the part back to a draft if an earlier run approved it.
  const sj = await signedIn(browser, "sj@despl.local");
  await openShl01(sj);
  if ((await chip(sj, "Approved").count()) > 0) {
    await sj.getByRole("button", { name: "Revise part" }).click();
    await sj.getByRole("dialog").getByRole("textbox").fill("Re-running the master data check");
    await sj.getByRole("dialog").getByRole("button", { name: "Revise part" }).click();
    await expect(chip(sj, "Draft").first()).toBeVisible();
  }
  await sj.context().close();

  // Engineering changes a time.
  const eng = await signedIn(browser, "eng@despl.local");
  await openShl01(eng);
  await expect(eng.getByRole("button", { name: /Approve part/ })).toHaveCount(0);
  await eng.getByRole("button", { name: "Edit steps" }).click();
  // A different time every run, so a re-run still has a change to publish.
  const newTime = (0.5 + (Date.now() % 40) / 100).toFixed(2).replace(/0$/, "");
  const time = eng.getByLabel("Standard time").first();
  await time.fill(newTime);
  await eng.getByLabel("Time unit").first().selectOption("HOURS");
  await eng.getByLabel("Time basis").first().selectOption("PER_PIECE");
  await eng.getByRole("button", { name: "Save draft" }).click();
  await expect(eng.getByText(/Draft v\d+ saved/)).toBeVisible();
  await expect(eng.locator("table").first()).toContainText(`${newTime} h per piece`);
  // The last editor may not mark their own work reviewed.
  await expect(eng.getByRole("button", { name: "Mark reviewed" })).toHaveCount(0);
  await eng.context().close();

  // A second person (the demo reviewer, an Admin) marks it reviewed from the list.
  const admin = await signedIn(browser, "reviewer@despl.local");
  await admin.goto("/admin/master-data?q=SHL-01");
  await admin.getByLabel("Select SHL-01").check();
  await admin.getByRole("button", { name: /Mark reviewed \(1\)/ }).click();
  await expect(admin.getByText(/1 marked reviewed/)).toBeVisible();
  await admin.context().close();

  // SJ approves; it was not his edit, so it is not self-approved.
  const head = await signedIn(browser, "sj@despl.local");
  await openShl01(head);
  await expect(chip(head, "Reviewed").first()).toBeVisible();
  await head.getByRole("button", { name: "Approve part" }).click();
  const dialog = head.getByRole("dialog");
  await expect(dialog).toContainText("Publishes variant A");
  await expect(dialog).not.toContainText("recorded as self-approved");
  await dialog.getByRole("button", { name: "Approve part" }).click();
  await expect(chip(head, "Approved").first()).toBeVisible();
  await expect(chip(head, "Self-approved")).toHaveCount(0);
  // Scoped to the approval card: the name is also in the sidebar.
  const approval = head.locator(".card", { has: head.getByRole("heading", { name: "Approval", exact: true }) });
  await expect(approval).toContainText("SJ — Production Head");
  await expect(approval).toContainText("Demo Reviewer");
  await head.context().close();
});

test("SJ revises, edits and approves his own change; it is flagged as self-approved", async ({ browser }) => {
  const sj = await signedIn(browser, "sj@despl.local");
  await openShl01(sj);

  await sj.getByRole("button", { name: "Revise part" }).click();
  await sj.getByRole("dialog").getByRole("textbox").fill("SJ changing the material");
  await sj.getByRole("dialog").getByRole("button", { name: "Revise part" }).click();
  await expect(chip(sj, "Draft").first()).toBeVisible();

  await sj.getByRole("button", { name: "Edit part" }).click();
  const edit = sj.getByRole("dialog");
  // A different value every run: saving an unchanged value changes nothing (and so is not "his change").
  const material = `SA240 304L-${Date.now() % 10000}`;
  await edit.getByLabel("Typical material").fill(material);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(sj.getByText(material)).toBeVisible();

  await sj.getByRole("button", { name: "Approve part" }).click();
  await expect(sj.getByRole("dialog")).toContainText("Approving it yourself is allowed and is recorded as self-approved");
  await sj.getByRole("dialog").getByRole("button", { name: "Approve part" }).click();
  await expect(chip(sj, "Self-approved")).toBeVisible();
  await sj.context().close();
});

test("a signed-out visitor is sent to /login", async ({ page }) => {
  await page.goto("/admin/master-data");
  await expect(page).toHaveURL(/\/login/);
});

test("a client user is sent away from master data, never shown it", async ({ browser }) => {
  const page = await signedIn(browser, "client@example.local").catch(() => null);
  // Client logins land outside the shell (the portal is frozen, so /portal is a 404 page).
  if (!page) return;
  await page.goto("/admin/master-data");
  await expect(page).toHaveURL(/\/portal/);
  await expect(page.getByRole("heading", { name: "Master data" })).toHaveCount(0);
  await page.context().close();
});
