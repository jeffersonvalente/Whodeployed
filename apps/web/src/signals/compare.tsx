/**
 * `compare` answer as a tick x series table (PR-7): one column per CompareSeries (an instance id
 * for `by: 'instance'`, `current`/`lastWeek` for `by: 'lastWeek'`), one row per tick present in
 * any series. A tick missing from a series shows "no value"; nothing is interpolated.
 */
import type { CompareSignal } from '@whodeployed/engine'
import { text } from './text'

export function CompareView({ signal }: { signal: CompareSignal }) {
  if (signal.series.length === 0) {
    return (
      <p>
        {text.compare.empty} ({text.range(signal.from, signal.to)})
      </p>
    )
  }
  const ticks = [...new Set(signal.series.flatMap((series) => series.points.map((point) => point.tick)))].sort((a, b) => a - b)
  const columns = signal.series.map((series) => ({
    label: series.label,
    values: new Map(series.points.map((point) => [point.tick, point.value])),
  }))
  return (
    <table>
      <caption>{text.compare.caption(signal.service, signal.metric, signal.by, signal.from, signal.to)}</caption>
      <thead>
        <tr>
          <th scope="col">{text.tick}</th>
          {columns.map((column) => (
            <th scope="col" key={column.label}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ticks.map((tick) => (
          <tr key={tick}>
            <th scope="row">{tick}</th>
            {columns.map((column) => {
              const value = column.values.get(tick)
              return <td key={column.label}>{value === undefined ? text.noValue : String(value)}</td>
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
