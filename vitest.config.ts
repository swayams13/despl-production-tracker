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
  },
});
