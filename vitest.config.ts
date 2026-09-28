import { defineConfig } from 'vitest/config';

// Live tests sit in test/live and skip themselves unless LIVE=1 (`pnpm test:live`), so the default
// run never touches the network or spends a cent.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
