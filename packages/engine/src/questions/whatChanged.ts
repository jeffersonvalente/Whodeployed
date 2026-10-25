/**
 * Question handler `whatChanged` (semantics: ADR-006).
 *
 * Returns every and only the deploy/config EventRecords with tick in the closed window
 * [max(0, now - window), now], `window` in ticks (Q-7), in record order. Fault-generated and
 * noise events come out alike: the signal does not say which is which; telling them apart is
 * the player's job (SPEC §3.4).
 */
import type { QuestionHandler } from '../types.js'

export const whatChanged: QuestionHandler<'whatChanged'> = (question, ctx) => {
  const { view } = ctx
  const to = view.now
  const from = Math.max(0, to - question.window)
  return { kind: 'whatChanged', from, to, events: view.eventsIn(from, to) }
}
