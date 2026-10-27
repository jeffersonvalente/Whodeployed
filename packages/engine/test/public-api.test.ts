/**
 * I24-1 (PRD FASE-2; ADR-002 Emenda 2 §2.1) — public runtime API of src/index.ts.
 *
 * T2.6 adds `accumulatedImpact` and `impactOfTick` (ADR-013). This minimal version checks only
 * those 2 names; T2.1 owns the full list of ADR-002 Emenda 2 §2.1, and the 2 names join that
 * list when both are in main.
 */
import { describe, expect, it } from 'vitest'

describe('public API — impact (T2.6, ADR-013)', () => {
  it('exports accumulatedImpact and impactOfTick as functions', async () => {
    const api: Record<string, unknown> = await import('../src/index.js')
    expect(Object.keys(api)).toEqual(expect.arrayContaining(['accumulatedImpact', 'impactOfTick']))
    expect(typeof api['accumulatedImpact']).toBe('function')
    expect(typeof api['impactOfTick']).toBe('function')
  })
})
