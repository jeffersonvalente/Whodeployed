/**
 * `dashboard` answer as a tick x metric table (PR-7): one row per MetricRecord of
 * DashboardSignal.records (ascending ticks), one column per metric of SPEC §4.
 * Rows are ticks so the table stays 9 columns wide at 390 px.
 */
import type { DashboardSignal } from '@whodeployed/engine'
import { METRIC_NAMES, text } from './text'

export function DashboardView({ signal }: { signal: DashboardSignal }) {
  if (signal.records.length === 0) {
    return (
      <p>
        {text.dashboard.empty} ({text.range(signal.from, signal.to)})
      </p>
    )
  }
  return (
    <table>
      <caption>{text.dashboard.caption(signal.service, signal.from, signal.to)}</caption>
      <thead>
        <tr>
          <th scope="col">{text.tick}</th>
          {METRIC_NAMES.map((metric) => (
            <th scope="col" key={metric}>
              {metric}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {signal.records.map((record) => (
          <tr key={record.tick}>
            <th scope="row">{record.tick}</th>
            {METRIC_NAMES.map((metric) => (
              <td key={metric}>{String(record[metric])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
