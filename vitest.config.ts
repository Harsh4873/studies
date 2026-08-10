import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    // Unit tests must be hermetic. Parse against
    // fixtures/arv-snapshot.json (86 real records) instead of the network.
    passWithNoTests: true,
  },
});
