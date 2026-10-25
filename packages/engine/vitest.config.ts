import { defineConfig } from 'vitest/config'

// QC-1 (ADR-008): >= 80% lines/branches/functions/statements in src/sim/** and src/faults/**.
// `vitest run --coverage` (the package `test` script) fails below these thresholds.
const QC1 = { lines: 80, branches: 80, functions: 80, statements: 80 }

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/types.ts', 'src/cli/**'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        'src/sim/**': QC1,
        'src/faults/**': QC1,
      },
    },
  },
})
