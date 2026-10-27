/**
 * Text rendering of one Answer (PR-7, ADR-015 §3): the question, the tick it was asked at, its
 * tickCost and every value of Answer.data, in plain HTML (PR-2). Pure presentation: it receives
 * the Answer the engine returned and the tick of the step; it computes nothing about the system.
 */
import type { Answer } from '@whodeployed/engine'
import { AskNpcView } from './ask-npc'
import { CompareView } from './compare'
import { DashboardView } from './dashboard'
import { LogsView } from './logs'
import { AnswerHeader, describeQuestion } from './text'
import { TraceView } from './trace'
import { WhatChangedView } from './what-changed'

export interface AnswerViewProps {
  answer: Answer
  /** World tick before the question (SessionStep.tickBefore of the ask step). */
  askedAt: number
}

function AnswerBody({ answer }: { answer: Answer }) {
  const signal = answer.data
  switch (signal.kind) {
    case 'dashboard':
      return <DashboardView signal={signal} />
    case 'logs':
      return <LogsView signal={signal} />
    case 'trace':
      return <TraceView signal={signal} />
    case 'whatChanged':
      return <WhatChangedView signal={signal} />
    case 'compare':
      return <CompareView signal={signal} />
    case 'askNpc':
      return <AskNpcView signal={signal} />
  }
}

export function AnswerView({ answer, askedAt }: AnswerViewProps) {
  return (
    <article aria-label={describeQuestion(answer.question)}>
      <AnswerHeader answer={answer} askedAt={askedAt} />
      <AnswerBody answer={answer} />
    </article>
  )
}
