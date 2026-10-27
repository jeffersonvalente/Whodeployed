/**
 * Repertoire per level: the single place of the table (FASE-2 PR-6, CN-5; ADR-014 §3).
 *
 * Transcribed from the FASE-2 PRD conventions ("Repertório do nível") and ADR-014 §3. SPEC §5:
 * levels unlock questions, never tools; senior items (askNpc, compare by lastWeek, flagOff,
 * declareMitigated, escalate) and scale belong to no repertoire in phase 2.
 *
 * Used by the content CI (CN-5: every referencePath step is in the repertoire of its level) and
 * by the prototype session (PR-6: the controls offered are exactly these). The engine never
 * imports it (Q-1). No engine runtime value is needed here (SPEC §6, ADR-014 §1.1).
 */
import type { InRepertoire, PlayableLevel, Repertoire, RepertoireTable } from './types.js'

/** Fixed window in ticks for `logs` and `whatChanged`: 30 ticks = the "last 5 min" of SPEC §5 (ADR-006, ADR-014 §3). */
const WINDOW = 30

function freezeRepertoire(r: Repertoire): Repertoire {
  return Object.freeze({
    dashboard: r.dashboard,
    logs: Object.freeze({ ...r.logs }),
    tracePercentiles: Object.freeze([...r.tracePercentiles]),
    whatChanged: r.whatChanged === null ? null : Object.freeze({ ...r.whatChanged }),
    compareBy: Object.freeze([...r.compareBy]),
    actions: Object.freeze([...r.actions]),
  })
}

/** The repertoire table (deeply frozen). Phase 2 has only 'junior' and 'pleno'. */
export const repertoire: RepertoireTable = Object.freeze({
  junior: freezeRepertoire({
    dashboard: true,
    logs: { window: WINDOW, filter: false },
    tracePercentiles: [],
    whatChanged: null,
    compareBy: [],
    actions: ['restart'],
  }),
  pleno: freezeRepertoire({
    dashboard: true,
    logs: { window: WINDOW, filter: true },
    tracePercentiles: [50, 95, 99],
    whatChanged: { window: WINDOW },
    compareBy: ['instance'],
    actions: ['restart', 'rollback'],
  }),
})

function isPlayableLevel(level: unknown): level is PlayableLevel {
  return typeof level === 'string' && Object.hasOwn(repertoire, level)
}

/**
 * Pure: is this question or action inside the repertoire of `level`? (CN-5, PR-6).
 *
 * Checks only what the table decides (kind, window, filter, percentile, `by`, action kind and the
 * presence of a target). Whether a component name exists is the engine's validation, not the
 * repertoire's. Any other level (e.g. 'senior' at runtime) or unknown kind => false.
 */
export const inRepertoire: InRepertoire = (level, step) => {
  if (!isPlayableLevel(level)) return false
  const r = repertoire[level]
  if (step.type === 'act') {
    const { kind, target } = step.action
    return (
      (r.actions as readonly string[]).includes(kind) && typeof target === 'string' && target.length > 0
    )
  }
  if (step.type !== 'ask') return false
  const q = step.question
  switch (q.kind) {
    case 'dashboard':
      return r.dashboard
    case 'logs':
      return q.window === r.logs.window && (q.filter === undefined || r.logs.filter)
    case 'trace':
      return (r.tracePercentiles as readonly number[]).includes(q.percentile)
    case 'whatChanged':
      return r.whatChanged !== null && q.window === r.whatChanged.window
    case 'compare':
      return (r.compareBy as readonly string[]).includes(q.by)
    case 'askNpc':
      return false
    default:
      return false
  }
}
