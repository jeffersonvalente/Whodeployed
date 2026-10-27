/**
 * `logs` answer, one list item per LogRecord in engine order (PR-7):
 * tick, component, instance, level, message, traceId (when present) and every attrs pair.
 */
import type { LogRecord, LogsSignal } from '@whodeployed/engine'
import { text } from './text'

export function logLine(entry: LogRecord): string {
  const parts = [`${text.tick} ${entry.tick}`, entry.component, entry.instance, entry.level, entry.message]
  if (entry.traceId !== undefined) parts.push(text.logs.trace(entry.traceId))
  for (const [key, value] of Object.entries(entry.attrs ?? {})) parts.push(`${key}=${String(value)}`)
  return parts.join(' | ')
}

export function LogsView({ signal }: { signal: LogsSignal }) {
  return (
    <>
      <p>{text.logs.caption(signal.service, signal.from, signal.to, signal.entries.length)}</p>
      {signal.entries.length === 0 ? null : (
        <ol>
          {signal.entries.map((entry, index) => (
            <li key={index}>{logLine(entry)}</li>
          ))}
        </ol>
      )}
    </>
  )
}
