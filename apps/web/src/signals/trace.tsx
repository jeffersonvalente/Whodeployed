/**
 * `trace` answer as an indented tree (PR-7): nested lists follow parentId, children in generation
 * order. Each span shows component, instance, operation, span kind, the called peer (client spans),
 * start offset, duration, status and span id; the focus span (TraceSignal.focusSpanId) is marked.
 * A span whose parent is not in the signal is shown at the root, so no span is ever hidden.
 */
import type { SpanRecord, TraceSignal } from '@whodeployed/engine'
import { text } from './text'

export function spanLine(span: SpanRecord): string {
  const parts = [span.component, span.instance, span.operation, span.kind]
  if (span.peer !== undefined) parts.push(text.trace.calls(span.peer))
  parts.push(text.trace.start(span.startMs), text.trace.duration(span.durationMs), span.status, text.trace.span(span.spanId))
  return parts.join(' | ')
}

interface SpanListProps {
  spans: readonly SpanRecord[]
  childrenOf: ReadonlyMap<string, readonly SpanRecord[]>
  focusSpanId: string
}

function SpanList({ spans, childrenOf, focusSpanId }: SpanListProps) {
  return (
    <ul>
      {spans.map((span) => {
        const children = childrenOf.get(span.spanId) ?? []
        return (
          <li key={span.spanId}>
            {span.spanId === focusSpanId ? (
              <strong>
                {spanLine(span)} ({text.trace.focus})
              </strong>
            ) : (
              spanLine(span)
            )}
            {children.length === 0 ? null : <SpanList spans={children} childrenOf={childrenOf} focusSpanId={focusSpanId} />}
          </li>
        )
      })}
    </ul>
  )
}

export function TraceView({ signal }: { signal: TraceSignal }) {
  if (signal.focusSpanId === null || signal.spans.length === 0) {
    return <p>{text.trace.empty(signal.service, signal.tick)}</p>
  }
  const ids = new Set(signal.spans.map((span) => span.spanId))
  const roots: SpanRecord[] = []
  const childrenOf = new Map<string, SpanRecord[]>()
  for (const span of signal.spans) {
    if (span.parentId === undefined || !ids.has(span.parentId)) {
      roots.push(span)
      continue
    }
    const siblings = childrenOf.get(span.parentId)
    if (siblings === undefined) childrenOf.set(span.parentId, [span])
    else siblings.push(span)
  }
  const traceIds = [...new Set(signal.spans.map((span) => span.traceId))]
  return (
    <>
      <p>
        {text.trace.caption(signal.service, signal.percentile, signal.tick)}, {traceIds.map(text.trace.traceId).join(', ')}
      </p>
      <SpanList spans={roots} childrenOf={childrenOf} focusSpanId={signal.focusSpanId} />
    </>
  )
}
