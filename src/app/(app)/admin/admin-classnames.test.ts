import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression test for Task 4.4's release-gate browser pass: the Add/Edit
// Employee dialogs used CSS classes "ad-grid" / "ad-hint" / "ad-check-grid"
// for the Name/Username/Email/Employee-code field grid and hint text. Those
// exact class names collide with generic ad-blocker cosmetic-hiding filter
// lists (confirmed live against a stock Chrome ad blocker: `.ad-grid` and
// `.ad-hint` were present verbatim in the extension's injected stylesheet,
// forcing `display:none; visibility:hidden` on the whole Name/Username row
// and every hint line). Renamed to "emp-grid" / "emp-hint" /
// "emp-check-grid". This test guards every className token in the admin
// client and its stylesheet rules against reintroducing an "ad-" prefixed
// token — not just the three that broke, so a future addition can't repeat
// the same mistake.
//
// A word boundary immediately followed by "ad-" is the check (not "ad"
// generally): it must not false-positive on legitimate tokens like
// "admin-dialog" or "add-employee" (those start "adm"/"add", not "ad-").
const AD_PREFIXED_TOKEN = /(^|[\s"'.])ad-[a-z]/i;

describe("admin UI class names avoid ad-blocker collisions", () => {
  it("_client.tsx has no ad-prefixed className token", () => {
    const src = readFileSync(join(__dirname, "_client.tsx"), "utf8");
    const hit = AD_PREFIXED_TOKEN.exec(src);
    expect(hit, `found ad-blocker-colliding class token: ${hit?.[0]}`).toBeNull();
  });

  it("globals.css has no .ad-prefixed selector (outside this file's own explanatory comment)", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    // Strip comments first so the explanatory /* ... ".ad-grid" ... */ note
    // above the fixed rules doesn't trip the check.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const hit = /\.ad-[a-z]/i.exec(withoutComments);
    expect(hit, `found ad-blocker-colliding CSS selector: ${hit?.[0]}`).toBeNull();
  });
});
