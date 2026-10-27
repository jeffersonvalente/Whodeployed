/**
 * T2.24 — local persistence of session logs (PR-16), with the localStorage of jsdom:
 *   - saved logs survive a new store (a page reload) and are read back canonical;
 *   - clear() removes the key and the in-memory list;
 *   - fallback: getItem throws, setItem throws, removeItem throws, localStorage absent,
 *     accessing localStorage throws: the game keeps working and the log stays exportable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeLog } from '../../src/session/log'
import { STORAGE_KEY, browserStorage, createLogStore, type StorageLike } from '../../src/session/storage'
import type { SessionLogV1 } from '../../src/session/types'

function log(id: string, wallMs = 0): SessionLogV1 {
  return {
    format: 'whodeployed-session-log',
    version: 1,
    scenario: { id, seed: `${id}-seed` },
    engine: { version: '0.1.0' },
    build: { sha: 'unknown' },
    steps: [
      { seq: 1, tickBefore: 14, type: 'wait', tickCost: 1, impactAfter: 0, wallMs },
      { seq: 2, tickBefore: 15, type: 'end', final: { kind: 'unknown' }, reason: 'player', tickCost: 0, impactAfter: 0, wallMs },
    ],
    finalHypothesis: { kind: 'unknown' },
    review: ['One.', 'Two.', 'Three.'],
  }
}

const canonical = (l: SessionLogV1): string => serializeLog(l).trimEnd()

/** A Storage whose chosen methods throw, otherwise backed by a Map. */
function brokenStorage(throwing: Partial<Record<keyof StorageLike, boolean>>): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  const fail = (name: string): never => {
    throw new DOMException(`${name} blocked`, 'SecurityError')
  }
  return {
    data,
    getItem: (key) => (throwing.getItem ? fail('getItem') : (data.get(key) ?? null)),
    setItem: (key, value) => {
      if (throwing.setItem) fail('setItem')
      data.set(key, value)
    },
    removeItem: (key) => {
      if (throwing.removeItem) fail('removeItem')
      data.delete(key)
    },
  }
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('with the real localStorage (jsdom)', () => {
  it('saves logs under one key and reads them back after a reload, oldest first', () => {
    const store = createLogStore()
    expect(store.save(log('a'))).toBe(true)
    expect(store.save(log('b'))).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(`[${canonical(log('a'))},${canonical(log('b'))}]`)
    expect(localStorage.length).toBe(1)

    const reloaded = createLogStore()
    expect(reloaded.list().map(serializeLog)).toEqual([serializeLog(log('a')), serializeLog(log('b'))])
  })

  it('keeps one copy when the same log is saved twice; another wallMs is another session', () => {
    const store = createLogStore()
    store.save(log('a'))
    expect(store.save(log('a'))).toBe(true)
    store.save(log('a', 500))
    expect(store.list()).toHaveLength(2)
  })

  it('clear() removes the key', () => {
    const store = createLogStore()
    store.save(log('a'))
    store.clear()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(store.list()).toEqual([])
    expect(createLogStore().list()).toEqual([])
  })

  it('skips unreadable entries and survives a corrupt value', () => {
    localStorage.setItem(STORAGE_KEY, `[${canonical(log('a'))},{"format":"other"},42]`)
    expect(createLogStore().list().map((l) => l.scenario.id)).toEqual(['a'])
    localStorage.setItem(STORAGE_KEY, '{not json')
    const store = createLogStore()
    expect(store.list()).toEqual([])
    expect(store.save(log('b'))).toBe(true)
    expect(store.list().map((l) => l.scenario.id)).toEqual(['b'])
  })

  it('touches no other key', () => {
    localStorage.setItem('other-app', 'keep')
    const store = createLogStore()
    store.save(log('a'))
    store.clear()
    expect(localStorage.getItem('other-app')).toBe('keep')
  })
})

describe('fallback when localStorage fails (PR-16)', () => {
  it('getItem throws: save keeps the log in memory and list returns it', () => {
    const store = createLogStore(brokenStorage({ getItem: true }))
    expect(store.save(log('a'))).toBe(false)
    expect(store.list().map(serializeLog)).toEqual([serializeLog(log('a'))])
  })

  it('setItem throws (quota, blocked): save returns false, the log stays exportable', () => {
    const storage = brokenStorage({ setItem: true })
    const store = createLogStore(storage)
    expect(store.save(log('a'))).toBe(false)
    expect(store.save(log('a'))).toBe(false)
    expect(storage.data.size).toBe(0)
    expect(store.list().map((l) => l.scenario.id)).toEqual(['a'])
  })

  it('setItem throws on the real localStorage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const store = createLogStore()
    expect(store.save(log('a'))).toBe(false)
    expect(store.list().map((l) => l.scenario.id)).toEqual(['a'])
  })

  it('stored and in-memory logs are listed together, stored first', () => {
    const storage = brokenStorage({})
    storage.data.set(STORAGE_KEY, `[${canonical(log('a'))}]`)
    const store = createLogStore({ ...storage, setItem: () => { throw new Error('full') } })
    store.save(log('b'))
    expect(store.list().map((l) => l.scenario.id)).toEqual(['a', 'b'])
  })

  it('removeItem throws: clear does not throw and empties the in-memory list', () => {
    const store = createLogStore(brokenStorage({ setItem: true, removeItem: true }))
    store.save(log('a'))
    expect(() => store.clear()).not.toThrow()
    expect(store.list()).toEqual([])
  })

  it('localStorage absent (null): works in memory only', () => {
    const store = createLogStore(null)
    expect(store.save(log('a'))).toBe(false)
    expect(store.list().map((l) => l.scenario.id)).toEqual(['a'])
    store.clear()
    expect(store.list()).toEqual([])
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('accessing localStorage throws (blocked site data): browserStorage is undefined and the store still works', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(browserStorage()).toBeUndefined()
    const store = createLogStore()
    expect(store.save(log('a'))).toBe(false)
    expect(store.list()).toHaveLength(1)
  })

  it('localStorage missing from the page: browserStorage is undefined', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(undefined as unknown as Storage)
    expect(browserStorage()).toBeUndefined()
    expect(createLogStore().save(log('a'))).toBe(false)
  })
})
