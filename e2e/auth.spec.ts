import { test, expect } from "@playwright/test";

/**
 * Auth, RBAC and client-scoping boundaries.
 *
 * These are violation tests first (CLAUDE.md: "table-driven tests for the
 * violation cases, not just happy paths"). The happy paths are here only to
 * prove the refusals are not passing for the wrong reason.
 *
 * Assumes `pnpm db:seed` has run with the default dev password.
 */

const PASSWORD = process.env.SEED_PASSWORD ?? "despl-dev-only";

function formError(page: import("@playwright/test").Page) {
  return page.locator('form [role="alert"]');
}

async function signIn(page: import("@playwright/test").Page, identifier: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("unauthenticated request to a protected route is redirected to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("wrong password is refused, and does not reveal whether the account exists", async ({
  page,
}) => {
  await signIn(page, "sup.fabrication@despl.local", "definitely-not-the-password");
  // scoped to the form: Next.js also renders a route announcer with role="alert"
  await expect(formError(page)).toHaveText("Incorrect username, email, or password");
  await expect(page).toHaveURL(/\/login/);
});

test("unknown account gives the identical message as a wrong password", async ({ page }) => {
  await signIn(page, "does-not-exist@despl.local");
  await expect(formError(page)).toHaveText("Incorrect username, email, or password");
});

test("internal user signs in and sees tenant-scoped jobs", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  // SPEC §7.1: `/` renders nothing — src/app/page.tsx is a pure role-based
  // redirect, and a SUPERVISOR lands on /my-day. The previous assertions here
  // (`toHaveURL("/")` plus a "DESPL Production Tracker" heading) only ever
  // passed on a race: toHaveURL retries and could match `/` in the instant
  // before the redirect resolved, and that heading exists solely in
  // login/page.tsx, admin/_client.tsx and account/password/_client.tsx —
  // never inside the authenticated shell. Pinning the real landing page is
  // strictly stronger than accepting a URL that was never the final one.
  await expect(page).toHaveURL(/\/my-day$/);
  await expect(page.getByRole("heading", { name: "My Day" })).toBeVisible();

  // The three seeded jobs, read under row-level security. `.first()` because
  // /my-day lists one row per stage-unit, so a job legitimately appears in
  // several rows and a bare locator trips Playwright's strict mode. This
  // assertion had never actually executed against the app before — the stale
  // heading check above it failed first, every time — which is how it reached
  // CI still written for a single-row page.
  await expect(page.getByRole("cell", { name: "DE0463" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "DE0467" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "DESPL-320" }).first()).toBeVisible();
});

test("D13: username alone (no email match) signs in, same as email", async ({ page }) => {
  // "sup.fabrication" is the seeded username (email local-part) for
  // sup.fabrication@despl.local — proves the login lookup's OR actually
  // matches on username, not just falling through to the email branch.
  // Asserts against the app shell (present on every authenticated role-landing
  // page), not a specific post-redirect route: "/" itself immediately
  // role-redirects (see src/app/page.tsx), which is what the
  // pre-existing "internal user signs in" test above no longer accounts for.
  await signIn(page, "sup.fabrication");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("client user lands in the portal and cannot reach the internal app", async ({ page }) => {
  await signIn(page, "client@example.local");
  await expect(page).toHaveURL("/portal");
  await expect(page.getByRole("heading", { name: "Your orders" })).toBeVisible();

  // the internal home must bounce a client user straight back out
  await page.goto("/");
  await expect(page).toHaveURL("/portal");
});

// Audit H3: `assertClientScope` checks WHICH client, not WHICH surface — a
// client user could `curl` internal read APIs directly and get planned-vs-
// actual variance, internal delay-reason history and submitter identities.
// api/_lib.ts's route() wrapper now defaults every route to
// assertNotClientUser(); this proves it with a real logged-in client session
// hitting the real endpoint, not a unit test of the wrapper in isolation.
test("client user gets 403 from internal read APIs, not internal data (audit H3)", async ({ page }) => {
  await signIn(page, "client@example.local");
  await expect(page).toHaveURL("/portal");

  const res = await page.request.get("/api/jobs");
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe("FORBIDDEN");
});

// AUD-025: `/board` and `/profile` were missing the `clientId !== null`
// redirect every other (app) page has, and the (app) layout itself loaded
// internal job telemetry (percentComplete, forecastVarianceDays,
// overduePlans, openHoldPoints) for any actor before any page guard ran.
// Fix: the redirect now also lives in `src/app/(app)/layout.tsx`, ahead of
// that load, plus the per-page copies on board/profile for defence in depth.
// This loops every route in the (app) group, per the audit's own note that
// the previous suite "only exercises `/` and `/api/jobs`".
const APP_GROUP_ROUTES = [
  "/board",
  "/profile",
  "/workspace",
  "/admin",
  "/departments",
  "/alerts",
  "/dashboard",
  "/welding",
  "/my-day",
  "/jobs",
  "/qc",
  "/reports",
];

test("client user is redirected to /portal from every route in the (app) group", async ({
  page,
}) => {
  await signIn(page, "client@example.local");
  await expect(page).toHaveURL("/portal");

  for (const route of APP_GROUP_ROUTES) {
    await page.goto(route);
    await expect(page).toHaveURL("/portal");
  }
});

test("client user navigating to /portal itself renders normally (no redirect loop)", async ({
  page,
}) => {
  await signIn(page, "client@example.local");
  // signIn's click triggers the login redirect asynchronously — wait for it
  // to land before navigating again, or the immediate goto below races the
  // still-in-flight redirect and can hit /portal before the session cookie
  // is actually set, bouncing to /login instead.
  await expect(page).toHaveURL("/portal");
  await page.goto("/portal");
  await expect(page).toHaveURL("/portal");
  await expect(page.getByRole("heading", { name: "Your orders" })).toBeVisible();
});

test("internal staff user is unaffected: /board and /profile render normally", async ({
  page,
}) => {
  await signIn(page, "sup.fabrication@despl.local");
  // same race as above — wait for the post-login redirect to land first.
  await expect(page).toHaveURL(/\/my-day$/);

  await page.goto("/board");
  await expect(page).toHaveURL("/board");
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();

  await page.goto("/profile");
  await expect(page).toHaveURL("/profile");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
});

test("unauthenticated request to /board or /profile still redirects to /login", async ({
  page,
}) => {
  await page.goto("/board");
  await expect(page).toHaveURL(/\/login/);

  await page.goto("/profile");
  await expect(page).toHaveURL(/\/login/);
});

test("signing out clears the session and re-protects the app", async ({ page }) => {
  await signIn(page, "sup.fabrication@despl.local");
  await expect(page).toHaveURL("/");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});
