import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/abilities/*/test/**/*.test.ts'],
    globals: true,
  },
});
