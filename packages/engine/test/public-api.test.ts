/**
 * Public runtime API of @whodeployed/engine (ADR-002 Emenda 2 §2.1, I24-1).
 *
 * The runtime names exported by src/index.ts are a SemVer contract from engine-v0.1.0: adding a
 * name is minor, removing or renaming one is major. This test compares Object.keys of the module
 * with the table of the ADR, in the ADR order (code unit, the order of a native ESM namespace).
 * Vitest's module runner returns the keys in source order instead, so they are sorted by code
 * unit (Array.prototype.sort default) before comparing.
 * Whoever adds an export updates the ADR table and this list in the same PR.
 */
import { describe, expect, it } from 'vitest'

/** ADR-002 Emenda 2 §2.1 (0.1.0 plus phase 2, T2.6), in Object.keys order. */
const publicRuntime = [
  'EngineError',
  'accumulatedImpact',
  'createSimulation',
  'defaultShop',
  'faultCatalog',
  'faultKinds',
  'impactOfTick',
  'isEngineError',
  'resolveFaults',
  'serializeRecord',
  'simulate',
  'toNdjson',
]

describe('public API (ADR-002 Emenda 2 §2.1)', () => {
  it('src/index.ts exports exactly the runtime names of the ADR table', async () => {
    const api = await import('../src/index.js')
    expect(Object.keys(api).sort()).toEqual(publicRuntime)
  })

  it('exports accumulatedImpact and impactOfTick as functions (T2.6, ADR-013)', async () => {
    const api: Record<string, unknown> = await import('../src/index.js')
    expect(typeof api['accumulatedImpact']).toBe('function')
    expect(typeof api['impactOfTick']).toBe('function')
  })
})
