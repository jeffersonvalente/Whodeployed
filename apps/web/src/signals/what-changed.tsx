/**
 * `whatChanged` answer as a list of events in engine order (PR-7): tick, change kind, target,
 * instance, restart and note when present. The view never says whether an event comes from the
 * fault or from noise: the signal does not carry it and telling them apart is the player's job
 * (ADR-006, SPEC §3.4).
 */
import type { EventRecord, WhatChangedSignal } from '@whodeployed/engine'
import { text } from './text'

export function eventLine(event: EventRecord): string {
  const parts = [`${text.tick} ${event.tick}`, event.kind, event.target]
  if (event.instance !== undefined) parts.push(text.whatChanged.instance(event.instance))
  if (event.restart === true) parts.push(text.whatChanged.restart)
  if (event.note !== undefined) parts.push(text.whatChanged.note(event.note))
  return parts.join(' | ')
}

export function WhatChangedView({ signal }: { signal: WhatChangedSignal }) {
  if (signal.events.length === 0) {
    return (
      <p>
        {text.whatChanged.empty} ({text.range(signal.from, signal.to)})
      </p>
    )
  }
  return (
    <>
      <p>{text.whatChanged.caption(signal.from, signal.to, signal.events.length)}</p>
      <ul>
        {signal.events.map((event, index) => (
          <li key={index}>{eventLine(event)}</li>
        ))}
      </ul>
    </>
  )
}
