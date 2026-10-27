/**
 * Manual export of a session log (PR-13): download as a JSON file and copy to the clipboard.
 * Both run only on a player's click; nothing is sent anywhere (SPEC §3.6, PR-3). The text is
 * the canonical serialization of log.ts, byte for byte the same in both paths.
 *
 * The browser objects are injected (defaults: the page's document, URL and navigator), so the
 * tests run without a real download or clipboard.
 */
import { serializeLog } from '../session/log'
import type { SessionLogV1 } from '../session/types'

/** File name of an exported log: scenario id only (no date, no player data, PR-13). */
export function exportFileName(log: SessionLogV1): string {
  const id = log.scenario.id.replace(/[^A-Za-z0-9._-]/g, '_')
  return `whodeployed-${id}.json`
}

export interface DownloadDeps {
  document: Pick<Document, 'createElement' | 'body'>
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  /** Runs the cleanup after the click is handled (some browsers cancel a download revoked synchronously). */
  defer: (task: () => void) => void
}

function defaultDownloadDeps(): DownloadDeps {
  return {
    document,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    defer: (task) => {
      setTimeout(task, 0)
    },
  }
}

/** Saves the log as a local file through a temporary object URL and an `<a download>`. */
export function downloadLog(log: SessionLogV1, deps: DownloadDeps = defaultDownloadDeps()): void {
  const blob = new Blob([serializeLog(log)], { type: 'application/json' })
  const url = deps.createObjectURL(blob)
  const anchor = deps.document.createElement('a')
  anchor.href = url
  anchor.download = exportFileName(log)
  deps.document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    deps.defer(() => deps.revokeObjectURL(url))
  }
}

/** `unavailable`: no clipboard API (old browser, insecure context); `failed`: the browser refused. */
export type CopyResult = 'copied' | 'unavailable' | 'failed'

export interface ClipboardLike {
  writeText(text: string): Promise<void>
}

function pageClipboard(): ClipboardLike | undefined {
  try {
    return (globalThis as { navigator?: { clipboard?: ClipboardLike } }).navigator?.clipboard
  } catch {
    return undefined
  }
}

/** Copies the log text to the clipboard. Never throws; the caller shows the result (and can offer the download). */
export async function copyLog(log: SessionLogV1, clipboard: ClipboardLike | undefined = pageClipboard()): Promise<CopyResult> {
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') return 'unavailable'
  try {
    await clipboard.writeText(serializeLog(log))
    return 'copied'
  } catch {
    return 'failed'
  }
}
