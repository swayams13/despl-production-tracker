import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    // Node by default: most of what needs testing here is business rules —
    // gating, RBAC, maker-checker, scheduling — none of which touch a DOM.
    // A component test opts in with `// @vitest-environment jsdom` at the top
    // of the file. (jsdom 30 also pulls undici 8, which needs Node 22+, so
    // loading it globally breaks the suite on the pinned Node 20 LTS.)
    environment: 'node',
    exclude: ['node_modules', 'e2e', '.next'],
    // DB-gated (RUN_DB_TESTS=1) files share one seeded fixture set — DESPL-320
    // and DE0463 in particular — across files. Running files in parallel lets
    // one file's start/verify/hold-point work on that shared job race a
    // concurrent generateSchedule() in another file; persistScheduleRun now
    // carries actuals forward on reschedule (audit C1 fix) instead of always
    // resetting to NOT_STARTED, so that race can leak real state across files
    // where it previously couldn't. Serialize files only for this tier — the
    // pure suite (`pnpm test`) keeps full parallelism.
    fileParallelism: !process.env.RUN_DB_TESTS,
  },
});
