/**
 * `askNpc` answer (Senior repertoire, not offered in phase 2): the structured hints of NpcSignal
 * as a list, without prose (ADR-006 Q-9; the NPC's words are phase 3 content). Present only so
 * that every Signal kind the engine produces has a text view.
 */
import type { NpcHint, NpcSignal } from '@whodeployed/engine'
import { text } from './text'

export function hintLine(hint: NpcHint): string {
  const parts: string[] = [hint.component]
  if (hint.instance !== undefined) parts.push(hint.instance)
  parts.push(hint.metric, text.askNpc.current(hint.current), text.askNpc.usual(hint.usual))
  return parts.join(' | ')
}

export function AskNpcView({ signal }: { signal: NpcSignal }) {
  return (
    <>
      <p>{text.askNpc.caption(signal.role, signal.tick, signal.hints.length)}</p>
      {signal.hints.length === 0 ? (
        <p>{text.askNpc.empty}</p>
      ) : (
        <ul>
          {signal.hints.map((hint, index) => (
            <li key={index}>{hintLine(hint)}</li>
          ))}
        </ul>
      )}
    </>
  )
}
