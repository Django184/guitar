import { defineConfig } from 'vitest/config';

// Tests unitaires uniquement ; les tests de bout en bout (e2e/) passent par Playwright.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
