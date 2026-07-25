import { RefreshCw, ScrollText, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { listAudit } from '../lib/api'
import type { ChannelDetail, ElementEvent, EventOperation } from '../types'

type AuditPanelProps = {
  pageId: string
  channel?: ChannelDetail | null
  onClose: () => void
  onHighlight?: (elementId: string) => void
}

const PAGE_SIZE = 30

const OPERATIONS: EventOperation[] = ['create', 'update', 'delete', 'lock', 'unlock', 'restore']

const OPERATION_STYLES: Record<EventOperation, string> = {
  create: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  update: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  delete: 'bg-rose-50 text-rose-700 border-rose-200',
  lock: 'bg-amber-50 text-amber-700 border-amber-200',
  unlock: 'bg-amber-50 text-amber-700 border-amber-200',
  restore: 'bg-purple-50 text-purple-700 border-purple-200',
}

const eventElementType = (event: ElementEvent): string => {
  const state = event.after_state ?? event.before_state
  return typeof state?.type === 'string' ? state.type : 'element'
}

const AuditPanel = ({ pageId, channel, onClose, onHighlight }: AuditPanelProps) => {
  const [events, setEvents] = useState<ElementEvent[]>([])
  const [total, setTotal] = useState(0)
  const [operation, setOperation] = useState<EventOperation | ''>('')
  const [actorId, setActorId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [elementFilter, setElementFilter] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (offset: number, replace: boolean) => {
      setIsLoading(true)
      setError(null)
      try {
        const result = await listAudit(pageId, {
          operation: operation || undefined,
          actor_id: actorId || undefined,
          element_id: elementFilter || undefined,
          // Local-midnight boundaries, sent as ISO instants.
          from: fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : undefined,
          to: toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined,
          limit: PAGE_SIZE,
          offset,
        })
        setTotal(result.total)
        setEvents((prev) => (replace ? result.items : [...prev, ...result.items]))
      } catch {
        setError("Couldn't load the audit log — check your connection.")
      } finally {
        setIsLoading(false)
      }
    },
    [pageId, operation, actorId, elementFilter, fromDate, toDate],
  )

  useEffect(() => {
    load(0, true)
  }, [load])

  return (
    <div className="workspace-panel">
      <header className="flex items-center justify-between border-b border-slate-200/80 px-5 py-4">
        <div className="flex items-center gap-2">
          <ScrollText size={16} className="text-indigo-600" />
          <h3 className="font-reading-serif text-lg text-slate-950">Audit log</h3>
          <span className="text-xs text-slate-400">{total} events</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Refresh"
            onClick={() => load(0, true)}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
          >
            <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            title="Close"
            onClick={onClose}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="flex gap-2 border-b border-slate-200/80 px-5 py-3">
        <select
          className="workspace-input flex-1 py-1.5 text-xs"
          value={operation}
          onChange={(event) => setOperation(event.target.value as EventOperation | '')}
        >
          <option value="">All operations</option>
          {OPERATIONS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        <select
          className="workspace-input flex-1 py-1.5 text-xs"
          value={actorId}
          onChange={(event) => setActorId(event.target.value)}
        >
          <option value="">All members</option>
          {(channel?.members ?? []).map((member) => (
            <option key={member.user_id} value={member.user_id}>
              {member.display_name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2 border-b border-slate-200/80 px-5 py-2">
        <input
          type="date"
          title="From date"
          className="workspace-input flex-1 py-1 text-xs"
          value={fromDate}
          onChange={(event) => setFromDate(event.target.value)}
        />
        <span className="text-xs text-slate-400">→</span>
        <input
          type="date"
          title="To date"
          className="workspace-input flex-1 py-1 text-xs"
          value={toDate}
          onChange={(event) => setToDate(event.target.value)}
        />
      </div>

      {elementFilter && (
        <div className="flex items-center gap-2 border-b border-slate-200/80 px-5 py-2">
          <span className="workspace-chip">element {elementFilter.slice(0, 8)}</span>
          <button
            type="button"
            onClick={() => setElementFilter(null)}
            className="text-xs text-slate-400 underline hover:text-indigo-600"
          >
            clear filter
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-3">
        {error && <p className="py-4 text-center text-xs text-rose-600">{error}</p>}
        {!error && events.length === 0 && !isLoading && (
          <p className="py-8 text-center text-xs text-slate-400">No events match these filters yet.</p>
        )}
        <ol className="space-y-2">
          {events.map((event) => (
            <li
              key={event.id}
              onClick={() => onHighlight?.(event.element_id)}
              title="Click to highlight this element on the canvas"
              className="cursor-pointer rounded-lg border border-slate-200/80 bg-white/60 px-3 py-2 hover:border-indigo-300 hover:bg-white"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${OPERATION_STYLES[event.operation]}`}
                >
                  {event.operation}
                </span>
                <span className="text-xs font-medium text-slate-700">{eventElementType(event)}</span>
                <span className="ml-auto text-[10px] text-slate-400">
                  {new Date(event.occurred_at).toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                by <span className="font-medium text-slate-700">{event.actor_display_name ?? 'AI / system'}</span>
                <button
                  type="button"
                  title="Show only this element's events"
                  onClick={(clickEvent) => {
                    clickEvent.stopPropagation()
                    setElementFilter(event.element_id)
                  }}
                  className="ml-2 font-mono text-[10px] text-slate-300 hover:text-indigo-600 hover:underline"
                >
                  {event.element_id.slice(0, 8)}
                </button>
              </p>
            </li>
          ))}
        </ol>
        {events.length < total && (
          <button
            type="button"
            disabled={isLoading}
            onClick={() => load(events.length, false)}
            className="workspace-action-button mt-3 w-full justify-center text-xs disabled:opacity-50"
          >
            {isLoading ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - events.length)} more`}
          </button>
        )}
      </div>
    </div>
  )
}

export default AuditPanel
