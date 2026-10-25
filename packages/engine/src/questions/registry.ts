/**
 * Question registry: maps each Question kind to its handler (ADR-002 §2, ADR-006).
 * Complete from T1.1 on; question tasks replace handler bodies, never this file.
 */
import type { QuestionRegistry } from '../types.js'
import { askNpc } from './askNpc.js'
import { compare } from './compare.js'
import { dashboard } from './dashboard.js'
import { logs } from './logs.js'
import { trace } from './trace.js'
import { whatChanged } from './whatChanged.js'

export const questionRegistry: QuestionRegistry = {
  dashboard,
  logs,
  trace,
  whatChanged,
  compare,
  askNpc,
}
