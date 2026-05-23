import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/apps/*/test/**/*.test.ts'],
    globals: true,
  },
});
