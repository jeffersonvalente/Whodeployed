/**
 * Local persistence of ended session logs (PR-16; CLAUDE.md: state only in localStorage).
 *
 * One localStorage key holds a JSON array of canonical logs (log.ts). Nothing leaves the
 * browser: no network, no telemetry (SPEC §3.6); the player exports by hand (PR-13).
 *
 * Fallback: when localStorage is absent, or reading/writing it throws (private mode, blocked
 * site data, quota), the game keeps working. Logs that could not be written stay in memory
 * for the rest of the page's life, so the export at the end of the session is still available;
 * `list()` returns them after the stored ones. Unreadable or foreign entries are skipped.
 */
import { parseLog, serializeLog } from './log'
import type { SessionLogV1 } from './types'

/** The only localStorage key the game writes. */
export const STORAGE_KEY = 'whodeployed.sessionLogs.v1'

/** The subset of the Web Storage API used here (a fake in tests). */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface LogStore {
  /** Saves a log; true when it reached localStorage, false when it is kept in memory only. Saving the same log twice keeps one copy. */
  save(log: SessionLogV1): boolean
  /** Stored logs (oldest first), then the in-memory ones. */
  list(): SessionLogV1[]
  /** Deletes every saved log: removes the key and empties the in-memory list. */
  clear(): void
}

/** The page's localStorage, or undefined when it is missing or accessing it throws (SecurityError). */
export function browserStorage(): StorageLike | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage
    return storage ?? undefined
  } catch {
    return undefined
  }
}

/** Canonical texts (without the trailing newline) stored under STORAGE_KEY; null when unreadable. */
function readStored(storage: StorageLike | undefined): string[] | null {
  if (storage === undefined) return null
  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const texts: string[] = []
  for (const entry of value) {
    try {
      texts.push(serializeLog(parseLog(JSON.stringify(entry))).trimEnd())
    } catch {
      // Not a log this build can read (LogFormatError) or a malformed step: skipped.
    }
  }
  return texts
}

/**
 * Creates the store. `storage` defaults to the page's localStorage; pass `null` to force the
 * in-memory fallback, or a fake in tests.
 */
export function createLogStore(storage: StorageLike | null | undefined = browserStorage()): LogStore {
  const target = storage ?? undefined
  /** Canonical texts of logs that could not be written. */
  let memory: string[] = []

  return {
    save(log) {
      const text = serializeLog(log).trimEnd()
      const stored = readStored(target)
      if (stored !== null && target !== undefined) {
        if (stored.includes(text)) return true
        try {
          target.setItem(STORAGE_KEY, `[${[...stored, text].join(',')}]`)
          memory = memory.filter((m) => m !== text)
          return true
        } catch {
          // Quota or blocked storage: keep the log in memory.
        }
      }
      if (!memory.includes(text)) memory.push(text)
      return false
    },
    list() {
      const stored = readStored(target) ?? []
      return [...stored, ...memory.filter((m) => !stored.includes(m))].map((text) => parseLog(text))
    },
    clear() {
      memory = []
      if (target === undefined) return
      try {
        target.removeItem(STORAGE_KEY)
      } catch {
        // Nothing else to delete: the game never wrote anywhere else.
      }
    },
  }
}
