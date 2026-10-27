import { defineConfig } from 'vitest/config'

// packages/scenarios tests (ADR-014): loader, repertoire, one file per scenario, replay.
// Tests build the EngineRuntime from the engine's public entry (devDependency, ADR-014 §1.1).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
