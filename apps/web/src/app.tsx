/**
 * Root component. Phase 2 is unstyled HTML (PR-2): default browser rendering only.
 * T2.27 adds the scenario list and test mode, T2.28 the notebook and review (ADR-015 §3).
 */
import type { ScenarioBundle } from '@whodeployed/scenarios'
import { bundle as defaultBundle } from './data'

export interface AppProps {
  bundle?: ScenarioBundle
}

export function App({ bundle = defaultBundle }: AppProps) {
  return (
    <main>
      <h1>Whodeployed</h1>
      {bundle.campaign.length === 0 ? <p>No scenarios.</p> : null}
    </main>
  )
}
