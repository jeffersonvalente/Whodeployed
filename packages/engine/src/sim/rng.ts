/**
 * Seeded PRNG and keyed stream factory (ADR-003). The only source of randomness in src/.
 *
 * - `xmur3` hashes a string key into 32-bit seeds.
 * - `mulberry32` is the generator: 32-bit state, `next()` = uint32 / 2^32.
 * - `createRngFactory(seed)` returns a factory; each call `factory(...key)` builds a fresh,
 *   independent stream seeded by `xmur3(seed + US + key.join(US))`, where US is U+001F.
 *   Same (seed, key) => same sequence, no matter how many other streams were consumed (F-2, S-4, Q-3).
 *
 * Only 32-bit integer arithmetic (`Math.imul`, shifts) and one division are used, so the output
 * does not depend on platform, time zone or locale (D-1, D-2).
 */
import type { CreateRngFactory, Rng, RngFactory } from '../types.js'

/** Separator between seed and key parts (ASCII unit separator, ADR-003 §2). */
export const KEY_SEPARATOR = '\u001f'

const TWO_POW_32 = 4294967296

/** xmur3 string hash: returns a generator of 32-bit unsigned seeds derived from `str`. */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

/** mulberry32 generator over a 32-bit state; each call returns a float in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / TWO_POW_32
  }
}

/** Wraps a [0, 1) generator into the Rng interface of types.ts §8. */
export function createRng(next: () => number): Rng {
  const int = (min: number, maxExclusive: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(maxExclusive) || maxExclusive <= min) {
      throw new RangeError(`rng.int: expected integers with min < maxExclusive, got [${min}, ${maxExclusive})`)
    }
    return min + Math.floor(next() * (maxExclusive - min))
  }
  return {
    next,
    int,
    // Always consumes exactly one value, so p = 0 or p = 1 does not shift the stream.
    chance: (p: number): boolean => next() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError('rng.pick: cannot pick from an empty list')
      return items[int(0, items.length)] as T
    },
  }
}

/** Stream key text: seed and key parts joined by U+001F (ADR-003 §2). */
export function streamKey(seed: string, key: readonly (string | number)[]): string {
  return seed + KEY_SEPARATOR + key.join(KEY_SEPARATOR)
}

/** ADR-003: independent stream per key, all derived from one textual seed. */
export const createRngFactory: CreateRngFactory = (seed: string): RngFactory => {
  return (...key) => createRng(mulberry32(xmur3(streamKey(seed, key))()))
}
