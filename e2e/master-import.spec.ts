import path from "node:path";
import * as XLSX from "xlsx";
import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * Import screen and material master (Lean Core M3-C), through the REAL /login
 * form for every role — never a forged session.
 *
 * Needs the seeded DB (demo accounts planner@, eng@, admin@, sj@despl.local).
 * Re-runnable: the load is idempotent, and the material flow revises first when
 * a previous run left the grade approved.
 *
 * The workbook it loads is the 11 Oct fixture with SHL-01 taken out, built in
 * memory, so it does not collide with the part e2e/master-data.spec.ts edits.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";
const FIXTURE = path.resolve(__dirname, "../docs/lean-core/inputs/2026-10-11-master-list/Standard_Parts_Master_PV_HE_SAMPLE.xlsx");

function withoutShl01(): Buffer {
  const wb = XLSX.readFile(FIXTURE);
  for (const name of ["Parts Master", "Part Routes"]) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: "" });
    const kept = rows.filter((r) => !r.some((c) => String(c).trim() === "SHL-01"));
    wb.Sheets[name] = XLSX.utils.aoa_to_sheet(kept);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator(".person-btn:visible")).toBeVisible();
  return page;
}

const original = { name: "Standard_Parts_Master.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

test.describe.configure({ mode: "serial" });

test("a planner is refused the import screen; Engineering can check a file but not load it", async ({ browser }) => {
  const planner = await signedIn(browser, "planner@despl.local");
  await planner.goto("/admin/master-data/import");
  await expect(planner.getByText(/is for Engineering, the Production Head and Admins/)).toBeVisible();
  await expect(planner.getByLabel("Standard Parts Master workbook")).toHaveCount(0);
  await planner.context().close();

  const eng = await signedIn(browser, "eng@despl.local");
  await eng.goto("/admin/master-data/import");
  await eng.getByLabel("Standard Parts Master workbook").setInputFiles(FIXTURE);
  await eng.getByRole("button", { name: "Check file" }).click();
  await expect(eng.getByText(/Read 60 parts · 235 route steps · 40 materials/)).toBeVisible();
  await expect(eng.getByText(/Only the Production Head and Admins can load a workbook/)).toBeVisible();
  await expect(eng.getByRole("button", { name: "Load into tracker" })).toBeDisabled();
  await eng.context().close();
});

test("an Admin checks, loads and re-checks a workbook; the second check says it already matches", async ({ browser }) => {
  const admin = await signedIn(browser, "admin@despl.local");
  await admin.goto("/admin/master-data/import");
  const upload = () =>
    admin.getByLabel("Standard Parts Master workbook").setInputFiles({ ...original, buffer: withoutShl01() });

  await upload();
  await admin.getByRole("button", { name: "Check file" }).click();
  await expect(admin.getByText(/Read 59 parts/)).toBeVisible();
  await expect(admin.getByRole("button", { name: /Step has no department/ })).toBeVisible(); // TSH-02, known

  const load = admin.getByRole("button", { name: /^Load/ });
  if (await load.isEnabled()) {
    await load.click();
    await expect(admin.getByRole("dialog")).toContainText("This loads");
    await admin.getByRole("dialog").getByRole("button", { name: "Load" }).click();
    await expect(admin.getByText("Loaded", { exact: true })).toBeVisible();
    await expect(admin.getByRole("link", { name: "Review the draft parts" })).toBeVisible();

    // Same file again: nothing left to do.
    await admin.getByRole("button", { name: "Import another file" }).click();
    await upload();
    await admin.getByRole("button", { name: "Check file" }).click();
  }
  await expect(admin.getByText(/already matches the tracker/)).toBeVisible();
  await expect(admin.getByRole("button", { name: /^Load/ })).toBeDisabled();
  await admin.context().close();
});

test("the Production Head, with drafts switched off, is told no part will load", async ({ browser }) => {
  const sj = await signedIn(browser, "sj@despl.local");
  await sj.goto("/admin/master-data/import");
  await sj.getByLabel(/Load parts that are not approved yet as drafts/).uncheck();
  await sj.getByLabel("Standard Parts Master workbook").setInputFiles(FIXTURE);
  await sj.getByRole("button", { name: "Check file" }).click();
  await expect(sj.getByText(/No part will load: none is marked/)).toBeVisible();
  await sj.context().close();
});

test("material master: Engineering edits and reviews a grade; SJ approves it", async ({ browser }) => {
  // Re-runs: bring the first grade back to a draft if it was left approved.
  const head = await signedIn(browser, "sj@despl.local");
  await head.goto("/admin/master-data/materials");
  const first = () => head.locator("tbody tr.row").first();
  await expect(first()).toBeVisible();
  const label = (await first().locator("td").nth(1).innerText()).trim();
  if ((await first().getByRole("button", { name: "Revise" }).count()) > 0) {
    await first().getByRole("button", { name: "Revise" }).click();
    await head.getByRole("dialog").getByRole("textbox").fill("Re-running the materials check");
    await head.getByRole("dialog").getByRole("button", { name: "Revise grade" }).click();
    await expect(first().locator(".chip", { hasText: "Draft" })).toBeVisible();
  }
  await head.context().close();

  const eng = await signedIn(browser, "eng@despl.local");
  await eng.goto("/admin/master-data/materials");
  const row = eng.locator("tbody tr.row").first();
  await expect(row).toContainText(label);
  await expect(row.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await row.getByRole("button", { name: "Edit" }).click();
  const remark = `Checked ${Date.now() % 100000}`;
  await eng.getByLabel("Remarks").fill(remark);
  await eng.getByLabel("Remarks").press("Enter");
  await expect(eng.getByText("Saved.")).toBeVisible();
  const saved = eng.locator("tbody tr.row").first();
  await expect(saved).toContainText(remark);
  await saved.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(eng.locator("tbody tr.row").first().locator(".chip", { hasText: "Reviewed" })).toBeVisible();
  await eng.context().close();

  const sj = await signedIn(browser, "sj@despl.local");
  await sj.goto("/admin/master-data/materials");
  await sj.locator("tbody tr.row").first().getByRole("button", { name: "Approve" }).click();
  await expect(sj.locator("tbody tr.row").first().locator(".chip", { hasText: "Approved" })).toBeVisible();
  await expect(sj.locator("tbody tr.row").first().getByRole("button", { name: "Edit" })).toHaveCount(0);
  await sj.context().close();
});
