import { defineConfig, devices } from '@playwright/test';

const STORAGE_STATE = 'playwright/.auth/supervisor.json';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    // Unrestricted testMatch, unchanged: e2e/auth.spec.ts (RBAC/client-scoping
    // violation tests) keeps running here, on this one project, exactly as
    // before this task.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },

    // Standard Playwright "setup project" auth pattern (their own "Projects
    // dependencies" idiom): logs in once through the real /login form and
    // saves storageState, which phone/tablet/desktop below each depend on —
    // one real login, reused, never a forged session (CLAUDE.md's Agent
    // Conduct section).
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },

    // Viewport matrix (SPEC-supervisor-ui-v3.md §8, Task 7) — exact values
    // from the spec/brief, verbatim. Scoped via testMatch to the new
    // viewport spec only, so adding these three projects doesn't re-run
    // auth.spec.ts three more times each.
    {
      name: 'phone',
      testMatch: /supervisor-viewport\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, hasTouch: true, storageState: STORAGE_STATE },
    },
    {
      name: 'tablet',
      testMatch: /supervisor-viewport\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Galaxy Tab S4 landscape'],
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        storageState: STORAGE_STATE,
      },
    },
    {
      name: 'desktop',
      testMatch: /supervisor-viewport\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: STORAGE_STATE },
    },
  ],
  webServer: {
    // Production build, not `pnpm dev` — a 3x project matrix under dev-mode
    // Turbopack is flaky at this scale (SPEC §8).
    command: 'pnpm build && pnpm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    // ci.yml already runs `pnpm build` as its own step before `pnpm e2e`, but
    // this command rebuilds again (reuseExistingServer is false in CI) — a
    // real, known redundancy, not addressed here. On a loaded shared runner
    // that second build-then-start occasionally doesn't land inside the
    // 60000ms default (confirmed live: PR #42 hit `Timed out waiting 60000ms
    // from config.webServer` twice across three CI attempts, 8 Sep 2026).
    // 3 minutes comfortably covers a cold rebuild + server start with room
    // to spare, without masking a genuinely hung server.
    timeout: 180_000,
  },
});
