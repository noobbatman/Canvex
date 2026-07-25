import { Canvas, Circle } from 'fabric'
import { Pause, Play, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { listSessions, streamReplay } from '../lib/api'
import { makeReadOnlyObject, type ReadOnlyCanvasObject } from '../lib/fabricElements'
import type { Element, PageSummary, ReplayEvent, SessionSummary } from '../types'

type ReplayModalProps = {
  page: PageSummary
  onClose: () => void
}

type ReplaySpeed = 1 | 2 | 4
type PlayState = 'idle' | 'loading' | 'playing' | 'paused' | 'finished'

const formatDuration = (session: SessionSummary): string => {
  const start = new Date(session.started_at)
  if (!session.ended_at) return 'live'
  const seconds = Math.max(0, Math.round((new Date(session.ended_at).getTime() - start.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const ReplayModal = ({ page, onClose }: ReplayModalProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fabricRef = useRef<Canvas | null>(null)
  const objectsById = useRef<Map<string, ReadOnlyCanvasObject>>(new Map())
  const cursorsById = useRef<Map<string, Circle>>(new Map())
  const abortRef = useRef<AbortController | null>(null)
  // Full event buffer (fetched instantly with speed=0); playback is paced
  // entirely client-side so pause/resume/scrub are exact.
  const bufferedEvents = useRef<ReplayEvent[]>([])
  const positionRef = useRef(0)
  const speedRef = useRef<ReplaySpeed>(2)
  const stepTimerRef = useRef<number | null>(null)

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSession, setSelectedSession] = useState<string>('')
  const [speed, setSpeed] = useState<ReplaySpeed>(2)
  const [playState, setPlayState] = useState<PlayState>('idle')
  const [eventCount, setEventCount] = useState(0)
  const [bufferedCount, setBufferedCount] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return
    const canvas = new Canvas(canvasRef.current, {
      backgroundColor: 'rgba(245, 244, 236, 1)',
      selection: false,
    })
    fabricRef.current = canvas
    // clientWidth/Height, not getBoundingClientRect: the modal pop-in
    // animation scales the container and would undersize the canvas.
    const { clientWidth, clientHeight } = containerRef.current
    canvas.setDimensions({ width: clientWidth, height: clientHeight })
    const objects = objectsById.current
    const cursors = cursorsById.current
    return () => {
      abortRef.current?.abort()
      if (stepTimerRef.current) {
        window.clearTimeout(stepTimerRef.current)
        stepTimerRef.current = null
      }
      objects.clear()
      cursors.clear()
      canvas.dispose()
      fabricRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    listSessions(page.id)
      .then((result) => {
        if (cancelled) return
        setSessions(result)
        if (result.length) setSelectedSession(result[0].id)
      })
      .catch(() => {
        if (!cancelled) setStatus("Couldn't load sessions for this page.")
      })
    return () => {
      cancelled = true
    }
  }, [page.id])

  const applyEvent = useCallback((event: ReplayEvent) => {
    const canvas = fabricRef.current
    if (!canvas) return

    if (event.event_type === 'element:op') {
      const operation = String(event.payload.operation ?? '')
      const element = event.payload.payload as Element | undefined
      if (!element?.id) return
      const existing = objectsById.current.get(element.id)
      if (existing) {
        canvas.remove(existing)
        objectsById.current.delete(element.id)
      }
      if (operation !== 'delete' && !element.is_deleted) {
        const obj = makeReadOnlyObject(element)
        if (obj) {
          obj.elementId = element.id
          canvas.add(obj)
          objectsById.current.set(element.id, obj)
        }
      }
      canvas.requestRenderAll()
    } else if (event.event_type === 'cursor:move') {
      const userId = String(event.payload.user_id ?? '')
      const x = Number(event.payload.x)
      const y = Number(event.payload.y)
      if (!userId || Number.isNaN(x) || Number.isNaN(y)) return
      let dot = cursorsById.current.get(userId)
      if (!dot) {
        dot = new Circle({
          radius: 5,
          fill: String(event.payload.color ?? '#4648d4'),
          stroke: '#ffffff',
          strokeWidth: 1.5,
          selectable: false,
          evented: false,
          opacity: 0.9,
        })
        cursorsById.current.set(userId, dot)
        canvas.add(dot)
      }
      // Center origin (Fabric v7): left/top place the dot's midpoint.
      dot.set({ left: x, top: y })
      canvas.requestRenderAll()
    }
  }, [])

  const resetCanvas = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    canvas.clear()
    canvas.backgroundColor = 'rgba(245, 244, 236, 1)'
    objectsById.current.clear()
    cursorsById.current.clear()
    canvas.requestRenderAll()
  }, [])

  const stopStepping = useCallback(() => {
    if (stepTimerRef.current) {
      window.clearTimeout(stepTimerRef.current)
      stepTimerRef.current = null
    }
  }, [])

  const stepFrom = useCallback(
    (index: number) => {
      const events = bufferedEvents.current
      if (index >= events.length) {
        setPlayState('finished')
        setStatus('Replay finished — drag the timeline to scrub.')
        return
      }
      applyEvent(events[index])
      positionRef.current = index + 1
      setEventCount(index + 1)
      const next = events[index + 1]
      if (!next) {
        setPlayState('finished')
        setStatus('Replay finished — drag the timeline to scrub.')
        return
      }
      const gapMs =
        (new Date(next.occurred_at).getTime() - new Date(events[index].occurred_at).getTime()) /
        speedRef.current
      stepTimerRef.current = window.setTimeout(
        () => stepFrom(index + 1),
        Math.min(Math.max(gapMs, 30), 2000),
      )
    },
    [applyEvent],
  )

  const handlePlay = useCallback(async () => {
    if (!selectedSession) return
    if (playState === 'paused' && bufferedEvents.current.length > 0) {
      setStatus(null)
      setPlayState('playing')
      stepFrom(positionRef.current)
      return
    }
    stopStepping()
    abortRef.current?.abort()
    resetCanvas()
    bufferedEvents.current = []
    positionRef.current = 0
    setBufferedCount(0)
    setEventCount(0)
    setStatus(null)
    setPlayState('loading')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      // speed=0: the server dumps every event immediately.
      await streamReplay(
        selectedSession,
        0,
        (event) => {
          bufferedEvents.current.push(event)
        },
        controller.signal,
      )
      setBufferedCount(bufferedEvents.current.length)
      if (bufferedEvents.current.length === 0) {
        setPlayState('finished')
        setStatus('This session recorded no events.')
        return
      }
      setPlayState('playing')
      stepFrom(0)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setPlayState('idle')
        setStatus('Replay stream failed — try again.')
      }
    }
  }, [playState, resetCanvas, selectedSession, stepFrom, stopStepping])

  const handlePause = useCallback(() => {
    stopStepping()
    setPlayState('paused')
  }, [stopStepping])

  // Scrubbing re-derives canvas state by replaying buffered events from the
  // start — events are full-state ops, so this is cheap at session scale.
  const handleScrub = useCallback(
    (position: number) => {
      stopStepping()
      resetCanvas()
      for (let index = 0; index < position; index += 1) {
        applyEvent(bufferedEvents.current[index])
      }
      positionRef.current = position
      setEventCount(position)
      setStatus(null)
      setPlayState(position >= bufferedEvents.current.length ? 'finished' : 'paused')
    },
    [applyEvent, resetCanvas, stopStepping],
  )

  const playLabel = playState === 'paused' ? 'Resume' : playState === 'finished' ? 'Replay' : 'Play'

  return (
    <div className="workspace-modal-backdrop" onClick={onClose}>
      <div className="workspace-modal max-w-4xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-200/80 px-6 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Session replay</p>
            <h3 className="font-reading-serif text-xl text-slate-950">{page.title}</h3>
          </div>
          <button
            type="button"
            onClick={() => {
              stopStepping()
              onClose()
            }}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200/80 px-6 py-3">
          <select
            className="workspace-input w-auto min-w-52 flex-1 py-1.5 text-xs"
            value={selectedSession}
            disabled={playState === 'playing' || playState === 'loading'}
            onChange={(event) => setSelectedSession(event.target.value)}
          >
            {sessions.length === 0 && <option value="">No recorded sessions yet</option>}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {new Date(session.started_at).toLocaleString()} · {formatDuration(session)}
              </option>
            ))}
          </select>
          <select
            className="workspace-input w-auto py-1.5 text-xs"
            value={speed}
            onChange={(event) => {
              const next = Number(event.target.value) as ReplaySpeed
              setSpeed(next)
              speedRef.current = next
            }}
          >
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
          {playState === 'playing' ? (
            <button type="button" onClick={handlePause} className="workspace-action-button">
              <Pause size={14} />
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={handlePlay}
              disabled={!selectedSession || playState === 'loading'}
              className="workspace-action-button disabled:opacity-50"
            >
              <Play size={14} />
              {playState === 'loading' ? 'Loading…' : playLabel}
            </button>
          )}
          <span className="ml-auto text-xs text-slate-400">
            {playState === 'playing' && <span className="mr-2 font-medium text-indigo-600">replaying…</span>}
            {playState === 'paused' && <span className="mr-2 font-medium text-amber-600">paused</span>}
            {eventCount} events
          </span>
        </div>

        {bufferedCount > 0 && (
          <div className="flex items-center gap-3 border-b border-slate-200/80 px-6 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Timeline</span>
            <input
              type="range"
              min={0}
              max={bufferedCount}
              value={eventCount}
              disabled={playState === 'playing' || playState === 'loading'}
              onChange={(event) => handleScrub(Number(event.target.value))}
              className="h-1.5 flex-1 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed"
            />
            <span className="w-16 text-right font-mono text-[10px] text-slate-400">
              {eventCount}/{bufferedCount}
            </span>
          </div>
        )}

        <div ref={containerRef} className="relative h-[52vh]">
          {status && (
            <p className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs text-slate-500 backdrop-blur-sm">
              {status}
            </p>
          )}
          {/* Fabric replaces the <canvas> with its own wrapper — keep it in a
              dedicated div so React never re-orders around the mutated node. */}
          <div className="absolute inset-0">
            <canvas ref={canvasRef} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default ReplayModal
