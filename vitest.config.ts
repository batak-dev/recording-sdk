import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure-logic tests run in Node; the few that need DOM globals (FileReader/Blob)
    // opt in per-file via a `// @vitest-environment happy-dom` pragma.
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
