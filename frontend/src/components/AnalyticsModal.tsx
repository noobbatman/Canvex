import { BarChart3, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { getPageAnalytics } from '../lib/api'
import type { PageAnalytics, PageSummary } from '../types'

type AnalyticsModalProps = {
  page: PageSummary
  onClose: () => void
}

// Sequential single-hue ramp (indigo, light→dark) for the edit-count
// magnitude scale; lightness is monotonic and text labels on every cell
// provide the value directly, so color is never the only carrier.
const HEAT_STEPS = ['#e0e7ff', '#a5b4fc', '#6366f1', '#4f46e5', '#3730a3']
const HEAT_TEXT = ['#334155', '#334155', '#ffffff', '#ffffff', '#ffffff']

const heatStep = (value: number, max: number): number => {
  if (max <= 0) return 0
  return Math.min(HEAT_STEPS.length - 1, Math.floor((value / max) * HEAT_STEPS.length))
}

const formatSeconds = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{children}</p>
)

const AnalyticsModal = ({ page, onClose }: AnalyticsModalProps) => {
  const [data, setData] = useState<PageAnalytics | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getPageAnalytics(page.id)
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load analytics for this page.")
      })
    return () => {
      cancelled = true
    }
  }, [page.id])

  const heat = useMemo(() => {
    const cells = data?.heatmap ?? []
    if (!cells.length) return null
    const xs = cells.map((cell) => cell.region_x_bucket)
    const ys = cells.map((cell) => cell.region_y_bucket)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const maxEdits = Math.max(...cells.map((cell) => cell.total_edits))
    const byKey = new Map(cells.map((cell) => [`${cell.region_x_bucket}:${cell.region_y_bucket}`, cell]))
    const cols = maxX - minX + 1
    const rows = maxY - minY + 1
    // One far-flung element (huge bucket coordinate) would explode the grid
    // into thousands of empty DOM cells — fall back to a top-regions list.
    const oversized = cols * rows > 1200
    const topCells = oversized
      ? [...cells].sort((a, b) => b.total_edits - a.total_edits).slice(0, 10)
      : []
    return { minX, maxX, minY, maxY, maxEdits, byKey, cols, rows, oversized, topCells }
  }, [data])

  const maxElements = useMemo(
    () => Math.max(1, ...(data?.participation ?? []).map((entry) => entry.total_elements)),
    [data],
  )

  return (
    <div className="workspace-modal-backdrop" onClick={onClose}>
      <div className="workspace-modal max-w-3xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-200/80 px-6 py-4">
          <div className="flex items-center gap-2">
            <BarChart3 size={16} className="text-indigo-600" />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Canvas analytics</p>
              <h3 className="font-reading-serif text-xl text-slate-950">{page.title}</h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </header>

        <div className="max-h-[65vh] space-y-6 overflow-y-auto px-6 py-5">
          {error && <p className="text-sm text-rose-600">{error}</p>}
          {!data && !error && <p className="py-6 text-center text-sm text-slate-400">Loading analytics…</p>}

          {data && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-slate-200/80 bg-white/60 px-4 py-3">
                  <SectionLabel>AI interactions</SectionLabel>
                  <p className="mt-1 font-reading-serif text-2xl text-slate-950">
                    {data.ai_usage.total_interactions}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200/80 bg-white/60 px-4 py-3">
                  <SectionLabel>Flagged incorrect</SectionLabel>
                  <p className="mt-1 font-reading-serif text-2xl text-slate-950">
                    {data.ai_usage.incorrect_feedback_percentage != null
                      ? `${data.ai_usage.incorrect_feedback_percentage.toFixed(0)}%`
                      : '—'}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200/80 bg-white/60 px-4 py-3">
                  <SectionLabel>Most active day</SectionLabel>
                  <p className="mt-1 font-reading-serif text-2xl text-slate-950">
                    {data.most_active_day ? new Date(data.most_active_day).toLocaleDateString() : '—'}
                  </p>
                </div>
              </div>

              <section>
                <SectionLabel>Edit heatmap — 200px canvas regions, this month</SectionLabel>
                {!heat && <p className="mt-2 text-xs text-slate-400">No edits recorded this month yet.</p>}
                {heat?.oversized && (
                  <div className="mt-2 space-y-1.5">
                    <p className="text-xs text-slate-400">
                      Regions are too spread out for a grid — showing the {heat.topCells.length} most edited.
                    </p>
                    {heat.topCells.map((cell) => {
                      const step = heatStep(cell.total_edits, heat.maxEdits)
                      return (
                        <div
                          key={`${cell.region_x_bucket}:${cell.region_y_bucket}`}
                          className="flex items-center gap-2 text-xs text-slate-600"
                        >
                          <span
                            className="inline-flex h-5 w-9 items-center justify-center rounded text-[10px] font-semibold"
                            style={{ backgroundColor: HEAT_STEPS[step], color: HEAT_TEXT[step] }}
                          >
                            {cell.total_edits}
                          </span>
                          <span>
                            region ({cell.region_x_bucket}, {cell.region_y_bucket}) · {cell.unique_users} user
                            {cell.unique_users === 1 ? '' : 's'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
                {heat && !heat.oversized && (
                  <div className="mt-2 overflow-x-auto">
                    <div
                      className="grid w-max gap-[2px]"
                      style={{ gridTemplateColumns: `repeat(${heat.cols}, 2.1rem)` }}
                    >
                      {Array.from({ length: heat.rows }, (_, rowIndex) =>
                        Array.from({ length: heat.cols }, (_, colIndex) => {
                          const x = heat.minX + colIndex
                          const y = heat.minY + rowIndex
                          const cell = heat.byKey.get(`${x}:${y}`)
                          if (!cell) {
                            return (
                              <div
                                key={`${x}:${y}`}
                                className="h-8 rounded border border-slate-200/60 bg-white/40"
                              />
                            )
                          }
                          const step = heatStep(cell.total_edits, heat.maxEdits)
                          return (
                            <div
                              key={`${x}:${y}`}
                              title={`Region (${x}, ${y}) — ${cell.total_edits} edits by ${cell.unique_users} user${cell.unique_users === 1 ? '' : 's'}`}
                              className="flex h-8 items-center justify-center rounded text-[10px] font-semibold"
                              style={{ backgroundColor: HEAT_STEPS[step], color: HEAT_TEXT[step] }}
                            >
                              {cell.total_edits}
                            </div>
                          )
                        }),
                      )}
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-400">
                      Cell number = edits in that region · darker = more edits
                    </p>
                  </div>
                )}
              </section>

              <section>
                <SectionLabel>Participation</SectionLabel>
                {data.participation.length === 0 && (
                  <p className="mt-2 text-xs text-slate-400">No contributions yet.</p>
                )}
                <div className="mt-2 space-y-2">
                  {data.participation.map((entry) => (
                    <div key={entry.user_id} className="flex items-center gap-3">
                      <span className="w-32 truncate text-xs font-medium text-slate-700">
                        {entry.display_name}
                      </span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200/70">
                        <div
                          className="h-full rounded-full bg-indigo-600"
                          style={{ width: `${(entry.total_elements / maxElements) * 100}%` }}
                        />
                      </div>
                      <span className="w-20 text-right text-xs text-slate-500">
                        {entry.total_elements} el.
                      </span>
                      <span className="w-16 text-right text-xs text-slate-400">
                        {formatSeconds(entry.active_seconds)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <SectionLabel>AI usage by trigger</SectionLabel>
                {data.ai_usage.by_trigger_type.length === 0 && (
                  <p className="mt-2 text-xs text-slate-400">No AI interactions on this page yet.</p>
                )}
                {data.ai_usage.by_trigger_type.length > 0 && (
                  <table className="mt-2 w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                        <th className="py-1 font-semibold">Trigger</th>
                        <th className="py-1 text-right font-semibold">Count</th>
                        <th className="py-1 text-right font-semibold">Avg latency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ai_usage.by_trigger_type.map((usage) => (
                        <tr key={usage.trigger_type} className="border-t border-slate-200/70 text-slate-600">
                          <td className="py-1.5 font-medium text-slate-700">{usage.trigger_type}</td>
                          <td className="py-1.5 text-right">{usage.count}</td>
                          <td className="py-1.5 text-right">
                            {usage.avg_latency_ms != null ? `${Math.round(usage.avg_latency_ms)} ms` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default AnalyticsModal
