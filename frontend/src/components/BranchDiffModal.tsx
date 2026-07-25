import { GitMerge, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { getBranchDiff, mergeBranch } from '../lib/api'
import type { BranchDiff, Element, MergeStrategy, PageSummary } from '../types'

type BranchDiffModalProps = {
  branch: PageSummary
  parentTitle: string
  onClose: () => void
  onMerged: () => void
}

const describeElement = (element: Element): string => {
  const text = element.content?.text
  if (typeof text === 'string' && text.trim()) {
    return text.length > 60 ? `${text.slice(0, 60)}…` : text
  }
  return `${Math.round(element.transform.x)}, ${Math.round(element.transform.y)}`
}

const DiffList = ({ title, tone, elements }: { title: string; tone: string; elements: Element[] }) => (
  <div className="min-w-0 flex-1">
    <p className={`text-[11px] font-semibold uppercase tracking-wide ${tone}`}>
      {title} <span className="font-normal text-slate-400">({elements.length})</span>
    </p>
    <ul className="mt-2 space-y-1.5">
      {elements.length === 0 && <li className="text-xs text-slate-400">None</li>}
      {elements.map((element) => (
        <li key={element.id} className="rounded-md border border-slate-200/80 bg-white/70 px-2.5 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600">{element.type}</span>
          <p className="truncate text-xs text-slate-600">{describeElement(element)}</p>
        </li>
      ))}
    </ul>
  </div>
)

const BranchDiffModal = ({ branch, parentTitle, onClose, onMerged }: BranchDiffModalProps) => {
  const [diff, setDiff] = useState<BranchDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [strategy, setStrategy] = useState<MergeStrategy>('theirs')
  const [isMerging, setIsMerging] = useState(false)
  const [mergedMessage, setMergedMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getBranchDiff(branch.id)
      .then((result) => {
        if (!cancelled) setDiff(result)
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't compute the diff for this branch.")
      })
    return () => {
      cancelled = true
    }
  }, [branch.id])

  const handleMerge = async () => {
    setIsMerging(true)
    setError(null)
    try {
      const summary = await mergeBranch(branch.id, strategy)
      setMergedMessage(
        `Merged into "${parentTitle}": ${summary.added_count} added, ${summary.modified_count} modified, ${summary.deleted_count} deleted.`,
      )
      onMerged()
    } catch {
      setError('Merge failed — you need editor access on both pages.')
    } finally {
      setIsMerging(false)
    }
  }

  return (
    <div className="workspace-modal-backdrop" onClick={onClose}>
      <div className="workspace-modal max-w-3xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-200/80 px-6 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Branch diff</p>
            <h3 className="font-reading-serif text-xl text-slate-950">
              {branch.title} <span className="text-slate-400">→</span> {parentTitle}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </header>

        <div className="max-h-[50vh] overflow-y-auto px-6 py-4">
          {error && <p className="text-sm text-rose-600">{error}</p>}
          {mergedMessage && <p className="mb-3 text-sm font-medium text-emerald-700">{mergedMessage}</p>}
          {!diff && !error && <p className="py-6 text-center text-sm text-slate-400">Computing diff…</p>}
          {diff && (
            <div className="flex gap-4">
              <DiffList title="Added" tone="text-emerald-700" elements={diff.added} />
              <DiffList title="Modified" tone="text-indigo-700" elements={diff.modified.map((entry) => entry.branch)} />
              <DiffList title="Deleted" tone="text-rose-700" elements={diff.deleted} />
            </div>
          )}
        </div>

        {!mergedMessage && (
          <footer className="flex items-center justify-end gap-3 border-t border-slate-200/80 px-6 py-4">
            <label className="flex items-center gap-2 text-xs text-slate-500">
              Conflicts:
              <select
                className="workspace-input w-auto py-1.5 text-xs"
                value={strategy}
                onChange={(event) => setStrategy(event.target.value as MergeStrategy)}
              >
                <option value="theirs">keep branch version</option>
                <option value="ours">keep parent version</option>
              </select>
            </label>
            <button
              type="button"
              disabled={isMerging || !diff}
              onClick={handleMerge}
              className="workspace-action-button disabled:opacity-50"
            >
              <GitMerge size={15} />
              {isMerging ? 'Merging…' : 'Merge into parent'}
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}

export default BranchDiffModal
