import { Canvas, Circle as FabricCircle, Ellipse, FabricImage, FabricObject, Line, Path, PencilBrush, Point, Polyline, Rect, Textbox, util } from 'fabric'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import {
  Brush,
  Circle,
  Eraser,
  Highlighter,
  Image,
  Link2,
  Move,
  MoveUpRight,
  PenLine,
  RectangleHorizontal,
  Redo2,
  Sigma,
  Sparkles,
  StickyNote,
  Text,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createShareLink, getPresenceCount, listElements, solvePage as solvePageApi, uploadImage } from '../lib/api'
import { colorFromId } from '../lib/colors'
import {
  getClientId,
  loadOfflineQueue,
  saveOfflineQueue,
  type OfflineElementState,
  type OfflineOperationType,
  type OfflineQueueItem,
  type VectorClock,
} from '../lib/offlineSync'
import { loadSession } from '../lib/storage'
import type { Element, ElementType, PageSummary, User } from '../types'

type Tool = 'select' | 'pen' | 'pencil' | 'highlighter' | 'eraser' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'sticky'

const DRAW_TOOLS: readonly Tool[] = ['pen', 'pencil', 'highlighter']
const HIGHLIGHTER_ALPHA = 0.35

type EraserMode = 'whole' | 'partial'

// Highlighter has its own colour set and thickness, independent of the pen.
const HIGHLIGHTER_COLORS = ['#fde047', '#fca5a5', '#86efac', '#93c5fd', '#f0abfc', '#fdba74']
const DEFAULT_HIGHLIGHTER_COLOR = '#fde047'
const DEFAULT_HIGHLIGHTER_WIDTH = 18
const HIGHLIGHTER_WIDTH_RANGE = { min: 8, max: 40 }
const DEFAULT_ERASER_SIZE = 24
const ERASER_SIZE_RANGE = { min: 8, max: 80 }

// Bake alpha into the brush colour so the highlighter's translucency survives
// the round-trip through the element's `style.stroke` string (no schema change).
const toRgba = (hex: string, alpha: number): string => {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const int = Number.parseInt(full, 16)
  if (Number.isNaN(int) || full.length !== 6) return hex
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

type CanvasObject = FabricObject & {
  elementId?: string
  canvexType?: ElementType
  isRemote?: boolean
  localCreateId?: string
  syncLocalId?: string
  pendingSync?: boolean
  canvexImageUrl?: string
}

type ElementSnapshot = {
  type: ElementType
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number }
  style: Record<string, unknown>
  content: Record<string, unknown>
}

type TransformSnapshot = Pick<FabricObject, 'left' | 'top' | 'scaleX' | 'scaleY' | 'angle'>

// Invertible history ops: applying one performs the change AND yields its own
// inverse, so undo/redo are the same machinery walking two stacks.
type HistoryAction =
  | { op: 'remove'; obj: CanvasObject }
  | { op: 'insert'; snapshot: ElementSnapshot }
  | { op: 'setTransform'; obj: CanvasObject; props: TransformSnapshot; prev: TransformSnapshot }

const HISTORY_LIMIT = 50

type CursorState = {
  userId: string
  displayName: string
  color: string
  x: number
  y: number
  updatedAt: number
}

// Remote cursors older than this are pruned; mirrors the server's 5s Redis
// TTL with a little slack for message latency.
const CURSOR_STALE_MS = 6000

type CanvasBoardProps = {
  page: PageSummary | null
  user: User
  accessToken: string
  // Bumping nonce re-triggers the flash even for the same element id.
  highlightElement?: { id: string; nonce: number } | null
}

const TOOL_LABELS: Record<Tool, string> = {
  select: 'Select',
  pen: 'Pen',
  pencil: 'Pencil',
  highlighter: 'Highlighter',
  eraser: 'Eraser',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  arrow: 'Arrow',
  text: 'Text',
  sticky: 'Sticky Note',
}

const DEFAULT_RECT = { width: 140, height: 90 }
const DEFAULT_ELLIPSE = { rx: 60, ry: 40 }

const AI_TEXT_PATTERN = /(^\/ai|^\*|[?]$|[-+]?\d*\.?\d*\s*x\s*(?:[+-]\s*\d+(?:\.\d+)?)?\s*=\s*[-+]?\d+(?:\.\d+)?)/i

const shouldAttachAISnapshot = (element: { type: ElementType; content: Record<string, unknown> }) => {
  if (element.type === 'image') return true
  const text = String(element.content.text ?? element.content.label ?? element.content.latex ?? '')
  return AI_TEXT_PATTERN.test(text)
}

const CanvasBoard = ({ page, user, accessToken, highlightElement }: CanvasBoardProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fabricRef = useRef<Canvas | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const objectsById = useRef<Map<string, CanvasObject>>(new Map())
  const pendingCreates = useRef<Map<string, CanvasObject>>(new Map())
  const textUpdateTimers = useRef<Map<string, number>>(new Map())
  const yDocRef = useRef<Y.Doc | null>(null)
  const yElementsRef = useRef<Y.Map<OfflineElementState> | null>(null)
  const yPersistenceRef = useRef<IndexeddbPersistence | null>(null)
  const offlineQueueRef = useRef<OfflineQueueItem[]>([])
  const inFlightOfflineIds = useRef<Set<string>>(new Set())
  const restLoadSucceededRef = useRef(false)
  const renderCachedElementsRef = useRef<() => number>(() => 0)
  const applyingRemote = useRef(false)
  const activeToolRef = useRef<Tool>('select')
  const erasingRef = useRef(false)
  const pageRef = useRef<PageSummary | null>(null)
  const seqRef = useRef(0)
  const clientIdRef = useRef(getClientId())
  const cursorThrottleRef = useRef<number | null>(null)
  const wsRetryCountRef = useRef(0)
  const lockTimersRef = useRef<Map<string, number>>(new Map())
  const undoStackRef = useRef<HistoryAction[]>([])
  const redoStackRef = useRef<HistoryAction[]>([])
  const suppressHistoryRef = useRef(false)
  const performUndoRef = useRef<() => void>(() => {})
  const performRedoRef = useRef<() => void>(() => {})
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [viewport, setViewport] = useState({ zoom: 1, tx: 0, ty: 0 })
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [wsRetryNonce, setWsRetryNonce] = useState(0)
  const [tool, setTool] = useState<Tool>('select')
  // Eraser/highlighter options popover — opens when the tool is selected,
  // auto-minimises when the cursor leaves it or you start using the canvas.
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected'>(
    'disconnected',
  )
  const [cursors, setCursors] = useState<Record<string, CursorState>>({})
  const [presenceCount, setPresenceCount] = useState(0)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [strokeColor, setStrokeColor] = useState('#0f172a')
  const [isMathOpen, setIsMathOpen] = useState(false)
  const [mathInput, setMathInput] = useState('')
  const [aiSolving, setAiSolving] = useState(false)
  const [isLoadingPage, setIsLoadingPage] = useState(false)
  const [isOffline, setIsOffline] = useState(!navigator.onLine)
  const [queuedOpsCount, setQueuedOpsCount] = useState(0)
  const strokeColorRef = useRef(strokeColor)
  const isOfflineRef = useRef(isOffline)

  // Highlighter (independent of the pen colour) + eraser options.
  const [highlighterColor, setHighlighterColor] = useState(DEFAULT_HIGHLIGHTER_COLOR)
  const [highlighterWidth, setHighlighterWidth] = useState(DEFAULT_HIGHLIGHTER_WIDTH)
  const [eraserMode, setEraserMode] = useState<EraserMode>('whole')
  const [eraserSize, setEraserSize] = useState(DEFAULT_ERASER_SIZE)
  const [autoSwitchBack, setAutoSwitchBack] = useState(true)
  const highlighterColorRef = useRef(highlighterColor)
  const highlighterWidthRef = useRef(highlighterWidth)
  const eraserModeRef = useRef(eraserMode)
  const eraserSizeRef = useRef(eraserSize)
  const autoSwitchBackRef = useRef(autoSwitchBack)
  const lastDrawToolRef = useRef<Tool>('pen')
  const erasedSomethingRef = useRef(false)
  const eraserCursorRef = useRef<FabricCircle | null>(null)

  const cursorColor = useMemo(() => colorFromId(user.id), [user.id])

  useEffect(() => {
    pageRef.current = page
  }, [page])

  useEffect(() => {
    strokeColorRef.current = strokeColor
  }, [strokeColor])

  useEffect(() => {
    highlighterColorRef.current = highlighterColor
    highlighterWidthRef.current = highlighterWidth
    autoSwitchBackRef.current = autoSwitchBack
    eraserModeRef.current = eraserMode
    // Keep the live highlighter brush in sync when its colour/width changes.
    const canvas = fabricRef.current
    if (canvas?.freeDrawingBrush && activeToolRef.current === 'highlighter') {
      canvas.freeDrawingBrush.color = toRgba(highlighterColor, HIGHLIGHTER_ALPHA)
      canvas.freeDrawingBrush.width = highlighterWidth
    }
  }, [highlighterColor, highlighterWidth, autoSwitchBack, eraserMode])

  useEffect(() => {
    eraserSizeRef.current = eraserSize
    // Resize the live eraser cursor preview to match.
    const cursor = eraserCursorRef.current
    if (cursor) {
      cursor.set({ radius: eraserSize / 2 })
      cursor.setCoords()
      fabricRef.current?.requestRenderAll()
    }
  }, [eraserSize])

  useEffect(() => {
    isOfflineRef.current = isOffline
  }, [isOffline])

  useEffect(() => {
    const updateOnlineState = () => setIsOffline(!navigator.onLine)
    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)
    updateOnlineState()
    return () => {
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
    }
  }, [])

  useEffect(() => {
    const pageId = page?.id
    yPersistenceRef.current?.destroy()
    yDocRef.current?.destroy()
    yDocRef.current = null
    yElementsRef.current = null
    yPersistenceRef.current = null
    offlineQueueRef.current = []
    restLoadSucceededRef.current = false
    setQueuedOpsCount(0)

    if (!pageId) return

    const doc = new Y.Doc()
    const elements = doc.getMap<OfflineElementState>('elements')
    const persistence = new IndexeddbPersistence(`canvex.page.${pageId}`, doc)
    const queue = loadOfflineQueue(pageId)

    yDocRef.current = doc
    yElementsRef.current = elements
    yPersistenceRef.current = persistence
    offlineQueueRef.current = queue
    setQueuedOpsCount(queue.length)

    persistence.on('synced', () => {
      if (!restLoadSucceededRef.current) {
        renderCachedElementsRef.current()
      }
    })

    return () => {
      persistence.destroy()
      doc.destroy()
      if (yDocRef.current === doc) {
        yDocRef.current = null
        yElementsRef.current = null
        yPersistenceRef.current = null
      }
    }
  }, [page?.id])

  const sendMessage = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ protocol: 'canvas', ...payload }))
    }
  }, [])

  const captureCanvasSnapshot = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return undefined
    try {
      return canvas.toDataURL({ format: 'png', multiplier: 0.5, quality: 0.72 })
    } catch {
      return undefined
    }
  }, [])

  const nextVectorClock = useCallback(() => {
    seqRef.current += 1
    return { [clientIdRef.current]: seqRef.current }
  }, [])

  const toTransform = useCallback((obj: CanvasObject) => ({
    x: obj.left ?? 0,
    y: obj.top ?? 0,
    scaleX: obj.scaleX ?? 1,
    scaleY: obj.scaleY ?? 1,
    rotation: obj.angle ?? 0,
  }), [])

  const toStyle = useCallback((obj: CanvasObject) => ({
    stroke: obj.stroke as string | undefined,
    fill: obj.fill as string | undefined,
    strokeWidth: obj.strokeWidth ?? 2,
  }), [])

  const toContent = useCallback((obj: CanvasObject): Record<string, unknown> => {
    if (obj.type === 'textbox') {
      const textbox = obj as Textbox
      const content: Record<string, unknown> = {
        text: textbox.text ?? '',
        width: textbox.width ?? 240,
        fontSize: textbox.fontSize ?? 20,
      }
      if (textbox.backgroundColor) {
        content.backgroundColor = textbox.backgroundColor
      }
      return content
    }
    if (obj.type === 'polyline') {
      return { points: (obj as Polyline).points ?? [] }
    }
    if (obj.type === 'line') {
      const line = obj as Line
      return { points: [line.x1 ?? 0, line.y1 ?? 0, line.x2 ?? 0, line.y2 ?? 0] }
    }
    if (obj.type === 'image') {
      const image = obj as FabricImage & CanvasObject
      return {
        url: image.canvexImageUrl ?? image.getSrc(),
        width: obj.width ?? 240,
        height: obj.height ?? 180,
      }
    }
    if (obj.type === 'rect') {
      return { width: obj.width ?? DEFAULT_RECT.width, height: obj.height ?? DEFAULT_RECT.height }
    }
    if (obj.type === 'ellipse') {
      const ellipse = obj as Ellipse
      return { rx: ellipse.rx ?? DEFAULT_ELLIPSE.rx, ry: ellipse.ry ?? DEFAULT_ELLIPSE.ry }
    }
    return {}
  }, [])

  const resolveElementType = useCallback((obj: CanvasObject): ElementType => {
    if (obj.canvexType) return obj.canvexType
    switch (obj.type) {
      case 'image':
        return 'image'
      case 'rect':
        return 'rect'
      case 'ellipse':
        return 'ellipse'
      case 'textbox':
        return 'text'
      case 'polyline':
        return 'stroke'
      case 'line':
        return 'arrow'
      default:
        return 'rect'
    }
  }, [])

  const canSendRealtime = useCallback(
    () => !isOfflineRef.current && wsRef.current?.readyState === WebSocket.OPEN,
    [],
  )

  const ensureLocalId = useCallback((obj: CanvasObject) => {
    if (obj.syncLocalId) return obj.syncLocalId
    const localId = obj.elementId ?? obj.localCreateId ?? crypto.randomUUID()
    obj.syncLocalId = localId
    return localId
  }, [])

  const saveQueue = useCallback((queue: OfflineQueueItem[]) => {
    const pageId = pageRef.current?.id
    offlineQueueRef.current = queue
    setQueuedOpsCount(queue.length)
    if (pageId) {
      saveOfflineQueue(pageId, queue)
    }
  }, [])

  const writeElementToYjs = useCallback(
    (obj: CanvasObject, isDeleted = false) => {
      const pageId = pageRef.current?.id
      const elements = yElementsRef.current
      if (!pageId || !elements) return null
      const localId = ensureLocalId(obj)
      const state: OfflineElementState = {
        local_id: localId,
        server_id: obj.elementId,
        page_id: pageId,
        type: resolveElementType(obj),
        transform: toTransform(obj),
        style: toStyle(obj),
        content: toContent(obj),
        is_deleted: isDeleted,
        updated_at: new Date().toISOString(),
      }
      elements.set(localId, state)
      return state
    },
    [ensureLocalId, resolveElementType, toContent, toStyle, toTransform],
  )

  const writeServerElementToYjs = useCallback((element: Element, localId = element.id) => {
    yElementsRef.current?.set(localId, {
      local_id: localId,
      server_id: element.id,
      page_id: element.page_id,
      type: element.type,
      transform: element.transform,
      style: element.style,
      content: element.content,
      is_deleted: element.is_deleted,
      updated_at: element.updated_at,
    })
  }, [])

  const queueOfflineOperation = useCallback(
    (
      operation: OfflineOperationType,
      obj: CanvasObject,
      vectorClock: VectorClock,
      clientOperationId: string = crypto.randomUUID(),
    ) => {
      const localId = ensureLocalId(obj)
      const existingQueue = offlineQueueRef.current
      let nextQueue = existingQueue.filter((item) => {
        if (item.local_id !== localId) return true
        if (operation === 'update') return item.operation !== 'update'
        if (operation === 'delete') return false
        return true
      })

      const hasCreate = nextQueue.some((item) => item.local_id === localId && item.operation === 'create')

      if (operation === 'delete' && hasCreate && !obj.elementId) {
        nextQueue = nextQueue.filter((item) => item.local_id !== localId)
        saveQueue(nextQueue)
        return
      }

      if (operation === 'update' && hasCreate) {
        saveQueue(nextQueue)
        return
      }

      nextQueue.push({
        id: crypto.randomUUID(),
        client_operation_id: clientOperationId,
        operation,
        local_id: localId,
        element_id: obj.elementId,
        vector_clock: vectorClock,
        queued_at: new Date().toISOString(),
      })
      saveQueue(nextQueue)
    },
    [ensureLocalId, saveQueue],
  )

  const makeObject = useCallback((element: Element): CanvasObject | null => {
    const base = {
      left: element.transform.x,
      top: element.transform.y,
      scaleX: element.transform.scaleX,
      scaleY: element.transform.scaleY,
      angle: element.transform.rotation,
      stroke: element.style.stroke ?? '#111827',
      strokeWidth: element.style.strokeWidth ?? 2,
      fill: element.style.fill ?? 'transparent',
      selectable: true,
      hasControls: true,
      hasBorders: true,
    }

    switch (element.type) {
      case 'rect': {
        const width = Number(element.content.width ?? DEFAULT_RECT.width)
        const height = Number(element.content.height ?? DEFAULT_RECT.height)
        return new Rect({ ...base, width, height }) as CanvasObject
      }
      case 'ellipse': {
        const rx = Number(element.content.rx ?? DEFAULT_ELLIPSE.rx)
        const ry = Number(element.content.ry ?? DEFAULT_ELLIPSE.ry)
        return new Ellipse({ ...base, rx, ry }) as CanvasObject
      }
      case 'text':
      case 'math':
      case 'sticky': {
        const text = String(element.content.text ?? 'Text')
        const backgroundColor = String(
          element.content.backgroundColor ?? (element.type === 'sticky' ? '#fef3c7' : ''),
        )
        const textbox = new Textbox(text, {
          ...base,
          width: Number(element.content.width ?? 240),
          fontSize: Number(element.content.fontSize ?? 20),
          fill: element.style.fill ?? '#e2e8f0',
          stroke: element.style.stroke ?? '#0f172a',
          backgroundColor,
          padding: element.type === 'sticky' ? 12 : 0,
        })
        return textbox as CanvasObject
      }
      case 'stroke': {
        const rawPoints = (element.content.points as Array<{ x: number; y: number } | number[]>) ?? []
        const points = rawPoints.map((point) =>
          Array.isArray(point) ? { x: point[0] ?? 0, y: point[1] ?? 0 } : point,
        )
        return new Polyline(points, { ...base, fill: 'transparent' }) as CanvasObject
      }
      case 'arrow': {
        const points = (element.content.points as number[]) ?? [0, 0, 120, 0]
        const linePoints: [number, number, number, number] = [
          points[0] ?? 0,
          points[1] ?? 0,
          points[2] ?? 120,
          points[3] ?? 0,
        ]
        return new Line(linePoints, { ...base, fill: 'transparent' }) as CanvasObject
      }
      case 'image': {
        const url = String(element.content.url ?? '')
        if (!url) return null
        const width = Number(element.content.width ?? 240)
        const height = Number(element.content.height ?? 180)
        const imgEl = document.createElement('img')
        imgEl.crossOrigin = 'anonymous'
        const image = new FabricImage(imgEl, { ...base, width, height }) as CanvasObject
        image.canvexImageUrl = url
        // The bitmap loads async; repaint once it arrives.
        imgEl.onload = () => {
          image.set({ width: imgEl.naturalWidth || width, height: imgEl.naturalHeight || height })
          image.setCoords()
          image.canvas?.requestRenderAll()
        }
        imgEl.src = url
        return image
      }
      default:
        return null
    }
  }, [])

  const addElementToCanvas = useCallback((element: Element) => {
    if (!fabricRef.current) return
    const obj = makeObject(element)
    if (!obj) return
    obj.elementId = element.id
    obj.syncLocalId = element.id
    obj.canvexType = element.type
    obj.isRemote = true
    applyingRemote.current = true
    fabricRef.current.add(obj)
    applyingRemote.current = false
    obj.isRemote = false
    objectsById.current.set(element.id, obj)
    writeServerElementToYjs(element)
  }, [makeObject, writeServerElementToYjs])

  const addCachedElementToCanvas = useCallback((state: OfflineElementState) => {
    if (!fabricRef.current || state.is_deleted) return
    const element: Element = {
      id: state.server_id ?? state.local_id,
      page_id: state.page_id,
      type: state.type,
      transform: state.transform,
      style: state.style,
      content: state.content,
      is_deleted: state.is_deleted,
      created_at: state.updated_at,
      updated_at: state.updated_at,
    }
    const obj = makeObject(element)
    if (!obj) return
    obj.syncLocalId = state.local_id
    obj.elementId = state.server_id
    obj.canvexType = state.type
    obj.localCreateId = state.server_id ? undefined : state.local_id
    obj.isRemote = true
    applyingRemote.current = true
    fabricRef.current.add(obj)
    applyingRemote.current = false
    obj.isRemote = false
    if (state.server_id) {
      objectsById.current.set(state.server_id, obj)
    }
  }, [makeObject])

  const renderCachedElements = useCallback(() => {
    const cachedElements = Array.from(yElementsRef.current?.values() ?? []).filter((element) => !element.is_deleted)
    if (!fabricRef.current) return cachedElements.length
    applyingRemote.current = true
    fabricRef.current.clear()
    fabricRef.current.backgroundColor = 'rgba(245, 244, 236, 0)'
    objectsById.current.clear()
    pendingCreates.current.clear()
    cachedElements.forEach(addCachedElementToCanvas)
    applyingRemote.current = false
    return cachedElements.length
  }, [addCachedElementToCanvas])

  useEffect(() => {
    renderCachedElementsRef.current = renderCachedElements
  }, [renderCachedElements])

  const updateElementOnCanvas = useCallback((element: Element) => {
    const obj = objectsById.current.get(element.id)
    if (!obj) {
      addElementToCanvas(element)
      return
    }
    obj.set({
      left: element.transform.x,
      top: element.transform.y,
      scaleX: element.transform.scaleX,
      scaleY: element.transform.scaleY,
      angle: element.transform.rotation,
      stroke: element.style.stroke ?? obj.stroke,
      strokeWidth: element.style.strokeWidth ?? obj.strokeWidth,
      fill: element.style.fill ?? obj.fill,
    })
    if (obj.type === 'textbox') {
      ;(obj as Textbox).text = String(element.content.text ?? '')
    }
    obj.setCoords()
    fabricRef.current?.renderAll()
    writeServerElementToYjs(element, obj.syncLocalId ?? element.id)
  }, [addElementToCanvas, writeServerElementToYjs])

  const removeElementFromCanvas = useCallback((elementId: string) => {
    const obj = objectsById.current.get(elementId)
    if (!obj || !fabricRef.current) return
    applyingRemote.current = true
    fabricRef.current.remove(obj)
    applyingRemote.current = false
    objectsById.current.delete(elementId)
    const localId = obj.syncLocalId ?? elementId
    const existing = yElementsRef.current?.get(localId)
    if (existing) {
      yElementsRef.current?.set(localId, { ...existing, is_deleted: true, updated_at: new Date().toISOString() })
    }
  }, [])

  const sendElementCreate = useCallback(
    (obj: CanvasObject) => {
      const clientOperationId = obj.localCreateId ?? crypto.randomUUID()
      const elementPayload = {
        type: resolveElementType(obj),
        transform: toTransform(obj),
        style: toStyle(obj),
        content: toContent(obj),
      }
      ensureLocalId(obj)
      obj.localCreateId = clientOperationId
      writeElementToYjs(obj)
      pendingCreates.current.set(clientOperationId, obj)
      const vectorClock = nextVectorClock()
      const snapshotB64 = shouldAttachAISnapshot(elementPayload) ? captureCanvasSnapshot() : undefined
      const message = {
        type: 'element:op',
        payload: {
          operation: 'create',
          client_operation_id: clientOperationId,
          vector_clock: vectorClock,
          snapshot_b64: snapshotB64,
          element: elementPayload,
        },
      }
      if (canSendRealtime()) {
        sendMessage(message)
      } else {
        queueOfflineOperation('create', obj, vectorClock, clientOperationId)
      }
    },
    [
      canSendRealtime,
      ensureLocalId,
      nextVectorClock,
      queueOfflineOperation,
      resolveElementType,
      captureCanvasSnapshot,
      sendMessage,
      toContent,
      toStyle,
      toTransform,
      writeElementToYjs,
    ],
  )

  const sendElementUpdate = useCallback(
    (obj: CanvasObject) => {
      writeElementToYjs(obj)
      const vectorClock = nextVectorClock()
      if (!obj.elementId) {
        obj.pendingSync = true
        if (!canSendRealtime()) {
          queueOfflineOperation('update', obj, vectorClock)
        }
        return
      }
      const elementPayload = {
        type: resolveElementType(obj),
        content: toContent(obj),
      }
      const snapshotB64 = shouldAttachAISnapshot(elementPayload) ? captureCanvasSnapshot() : undefined
      const message = {
        type: 'element:op',
        payload: {
          operation: 'update',
          element_id: obj.elementId,
          transform: toTransform(obj),
          style: toStyle(obj),
          content: elementPayload.content,
          vector_clock: vectorClock,
          snapshot_b64: snapshotB64,
        },
      }
      if (canSendRealtime()) {
        sendMessage(message)
      } else {
        queueOfflineOperation('update', obj, vectorClock)
      }
    },
    [
      canSendRealtime,
      captureCanvasSnapshot,
      nextVectorClock,
      queueOfflineOperation,
      resolveElementType,
      sendMessage,
      toContent,
      toStyle,
      toTransform,
      writeElementToYjs,
    ],
  )

  const sendElementDelete = useCallback(
    (obj: CanvasObject) => {
      const vectorClock = nextVectorClock()
      writeElementToYjs(obj, true)
      if (!obj.elementId) {
        queueOfflineOperation('delete', obj, vectorClock)
        return
      }
      const message = {
        type: 'element:op',
        payload: { operation: 'delete', element_id: obj.elementId, vector_clock: vectorClock },
      }
      if (canSendRealtime()) {
        sendMessage(message)
      } else {
        queueOfflineOperation('delete', obj, vectorClock)
      }
    },
    [canSendRealtime, nextVectorClock, queueOfflineOperation, sendMessage, writeElementToYjs],
  )

  const sendLock = useCallback(
    (elementId: string) => {
      sendMessage({ type: 'element:lock', payload: { element_id: elementId } })
    },
    [sendMessage],
  )

  // Resolves (removes) a queued offline item once the server has confirmed the
  // outcome — success or rejection — for its client_operation_id. Items are
  // deliberately NOT removed from the queue at send time: if the connection
  // drops before a response arrives, or the server rejects the change (e.g.
  // the element was deleted/locked while offline), the item stays queued and
  // is retried on the next reconnect instead of being silently lost.
  const resolveOfflineQueueItem = useCallback(
    (clientOperationId: string | null | undefined, outcome: 'synced' | 'rejected', detail?: string) => {
      if (!clientOperationId) return
      inFlightOfflineIds.current.delete(clientOperationId)
      const existing = offlineQueueRef.current
      if (!existing.some((item) => item.client_operation_id === clientOperationId)) return
      saveQueue(existing.filter((item) => item.client_operation_id !== clientOperationId))
      if (outcome === 'rejected') {
        setStatusMessage(`An offline change could not be saved${detail ? `: ${detail}` : '.'}`)
      }
    },
    [saveQueue],
  )

  const flushOfflineQueue = useCallback(() => {
    const pageId = pageRef.current?.id
    const elements = yElementsRef.current
    if (!pageId || !elements || !canSendRealtime() || offlineQueueRef.current.length === 0) return

    const queue = offlineQueueRef.current
    let sentCount = 0
    queue.forEach((item) => {
      if (inFlightOfflineIds.current.has(item.client_operation_id)) return
      const state = elements.get(item.local_id)
      if (item.operation === 'create') {
        if (!state || state.is_deleted) return
        const obj = fabricRef.current
          ?.getObjects()
          .find((candidate) => (candidate as CanvasObject).syncLocalId === item.local_id) as CanvasObject | undefined
        if (obj) {
          obj.localCreateId = item.client_operation_id
          pendingCreates.current.set(item.client_operation_id, obj)
        }
        inFlightOfflineIds.current.add(item.client_operation_id)
        sendMessage({
          type: 'element:op',
          payload: {
            operation: 'create',
            client_operation_id: item.client_operation_id,
            vector_clock: item.vector_clock,
            element: {
              type: state.type,
              transform: state.transform,
              style: state.style,
              content: state.content,
            },
          },
        })
        sentCount += 1
        return
      }

      const elementId = item.element_id ?? state?.server_id
      if (!elementId) return

      if (item.operation === 'update') {
        if (!state || state.is_deleted) return
        inFlightOfflineIds.current.add(item.client_operation_id)
        sendMessage({
          type: 'element:op',
          payload: {
            operation: 'update',
            element_id: elementId,
            client_operation_id: item.client_operation_id,
            transform: state.transform,
            style: state.style,
            content: state.content,
            vector_clock: item.vector_clock,
          },
        })
        sentCount += 1
        return
      }

      inFlightOfflineIds.current.add(item.client_operation_id)
      sendMessage({
        type: 'element:op',
        payload: {
          operation: 'delete',
          element_id: elementId,
          client_operation_id: item.client_operation_id,
          vector_clock: item.vector_clock,
        },
      })
      sentCount += 1
    })

    if (sentCount > 0) {
      setStatusMessage(`Syncing ${sentCount} offline change${sentCount === 1 ? '' : 's'}...`)
    }
  }, [canSendRealtime, sendMessage])

  const showToolMessage = useCallback((message: string) => {
    setStatusMessage(message)
  }, [])

  // ── Undo / redo ────────────────────────────────────────────────

  const snapshotOf = useCallback(
    (obj: CanvasObject): ElementSnapshot => ({
      type: resolveElementType(obj),
      transform: toTransform(obj),
      style: toStyle(obj) as Record<string, unknown>,
      content: toContent(obj),
    }),
    [resolveElementType, toContent, toStyle, toTransform],
  )

  const pushHistory = useCallback((action: HistoryAction) => {
    if (suppressHistoryRef.current) return
    undoStackRef.current.push(action)
    if (undoStackRef.current.length > HISTORY_LIMIT) {
      undoStackRef.current.shift()
    }
    redoStackRef.current = []
    setHistoryVersion((version) => version + 1)
  }, [])

  // Applies a history op through the normal canvas mutation paths (so the
  // server sync fires) and returns the op that would revert it.
  const applyHistoryOp = useCallback(
    (action: HistoryAction): HistoryAction | null => {
      const canvas = fabricRef.current
      if (!canvas) return null
      if (action.op === 'remove') {
        if (!canvas.getObjects().includes(action.obj)) return null
        const inverse: HistoryAction = { op: 'insert', snapshot: snapshotOf(action.obj) }
        canvas.remove(action.obj)
        canvas.discardActiveObject()
        canvas.requestRenderAll()
        return inverse
      }
      if (action.op === 'insert') {
        const { snapshot } = action
        const element: Element = {
          id: '',
          page_id: pageRef.current?.id ?? '',
          type: snapshot.type,
          transform: snapshot.transform,
          style: snapshot.style as Element['style'],
          content: snapshot.content,
          is_deleted: false,
          created_at: '',
          updated_at: '',
        }
        const obj = makeObject(element)
        if (!obj) return null
        obj.canvexType = snapshot.type
        canvas.add(obj)
        canvas.requestRenderAll()
        return { op: 'remove', obj }
      }
      const { obj, props, prev } = action
      if (!canvas.getObjects().includes(obj)) return null
      obj.set(props)
      obj.setCoords()
      canvas.requestRenderAll()
      sendElementUpdate(obj)
      return { op: 'setTransform', obj, props: prev, prev: props }
    },
    [makeObject, sendElementUpdate, snapshotOf],
  )

  useEffect(() => {
    const step = (from: HistoryAction[], to: HistoryAction[]) => {
      const action = from.pop()
      if (!action) return
      suppressHistoryRef.current = true
      let inverse: HistoryAction | null = null
      try {
        inverse = applyHistoryOp(action)
      } finally {
        suppressHistoryRef.current = false
      }
      if (inverse) {
        to.push(inverse)
      }
      setHistoryVersion((version) => version + 1)
    }
    performUndoRef.current = () => step(undoStackRef.current, redoStackRef.current)
    performRedoRef.current = () => step(redoStackRef.current, undoStackRef.current)
  }, [applyHistoryOp])

  // ── Zoom ───────────────────────────────────────────────────────

  const zoomBy = useCallback((factor: number) => {
    const canvas = fabricRef.current
    if (!canvas) return
    const next = Math.min(4, Math.max(0.25, canvas.getZoom() * factor))
    canvas.zoomToPoint(new Point(canvas.getWidth() / 2, canvas.getHeight() / 2), next)
    const vpt = canvas.viewportTransform
    setViewport({ zoom: next, tx: vpt?.[4] ?? 0, ty: vpt?.[5] ?? 0 })
    canvas.requestRenderAll()
  }, [])

  const resetZoom = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0])
    setViewport({ zoom: 1, tx: 0, ty: 0 })
    canvas.requestRenderAll()
  }, [])

  // Scene-space point at the center of the current view (zoom/pan aware).
  const sceneCenter = useCallback((): { x: number; y: number } => {
    const canvas = fabricRef.current
    if (!canvas) return { x: 200, y: 200 }
    const zoom = canvas.getZoom()
    const vpt = canvas.viewportTransform
    return {
      x: (canvas.getWidth() / 2 - (vpt?.[4] ?? 0)) / zoom,
      y: (canvas.getHeight() / 2 - (vpt?.[5] ?? 0)) / zoom,
    }
  }, [])

  // ── Image upload ───────────────────────────────────────────────

  const handleImageSelected = useCallback(
    async (file: File | null) => {
      const canvas = fabricRef.current
      if (!file || !canvas || !pageRef.current) return
      setIsUploadingImage(true)
      try {
        const { url } = await uploadImage(file)
        const imgEl = document.createElement('img')
        imgEl.crossOrigin = 'anonymous'
        await new Promise<void>((resolve, reject) => {
          imgEl.onload = () => resolve()
          imgEl.onerror = () => reject(new Error('image failed to load'))
          imgEl.src = url
        })
        const naturalWidth = imgEl.naturalWidth || 240
        const scale = Math.min(1, 320 / naturalWidth)
        const center = sceneCenter()
        // Center origin (Fabric v7): left/top place the image's midpoint.
        const image = new FabricImage(imgEl, {
          left: center.x,
          top: center.y,
          scaleX: scale,
          scaleY: scale,
        }) as CanvasObject
        image.canvexType = 'image'
        image.canvexImageUrl = url
        canvas.add(image)
        canvas.setActiveObject(image)
        canvas.requestRenderAll()
        showToolMessage('Image added to the canvas.')
      } catch {
        showToolMessage('Image upload failed — PNG/JPEG/WebP/GIF up to 5 MB.')
      } finally {
        setIsUploadingImage(false)
      }
    },
    [sceneCenter, showToolMessage],
  )

  // Flash a halo around an element (e.g. clicked in the audit log panel).
  useEffect(() => {
    if (!highlightElement) return
    const canvas = fabricRef.current
    if (!canvas) return
    const obj = objectsById.current.get(highlightElement.id)
    if (!obj) {
      showToolMessage('That element is no longer on this page.')
      return
    }
    // Bounds from aCoords (scene-plane corners), NOT getBoundingRect —
    // the latter is viewport-dependent, which misplaces the halo when zoomed.
    obj.setCoords()
    const corners = obj.aCoords ? Object.values(obj.aCoords) : []
    if (corners.length === 0) return
    const xs = corners.map((corner) => corner.x)
    const ys = corners.map((corner) => corner.y)
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    const halo = new Rect({
      // Fabric v7 defaults to center origin; the halo is positioned by its
      // top-left corner, so pin the origin explicitly.
      originX: 'left',
      originY: 'top',
      left: left - 8,
      top: top - 8,
      width: Math.max(...xs) - left + 16,
      height: Math.max(...ys) - top + 16,
      fill: 'rgba(70, 72, 212, 0.10)',
      stroke: '#4648d4',
      strokeWidth: 2,
      strokeDashArray: [6, 4],
      rx: 10,
      ry: 10,
      selectable: false,
      evented: false,
    }) as CanvasObject
    // isRemote + applyingRemote keep the decorative halo out of the
    // object:added/removed sync handlers — it must never become an element.
    halo.isRemote = true
    applyingRemote.current = true
    canvas.add(halo)
    applyingRemote.current = false
    canvas.requestRenderAll()
    const removeHalo = () => {
      // On page switch the canvas is disposed before App clears the
      // highlight state — never touch a canvas that is no longer live.
      if (fabricRef.current !== canvas) return
      applyingRemote.current = true
      canvas.remove(halo)
      applyingRemote.current = false
      canvas.requestRenderAll()
    }
    const timer = window.setTimeout(removeHalo, 1800)
    return () => {
      window.clearTimeout(timer)
      removeHalo()
    }
  }, [highlightElement, showToolMessage])

  const handleMathSubmit = useCallback(() => {
    const equation = mathInput.trim()
    const canvas = fabricRef.current
    if (!equation || !canvas) return
    const center = sceneCenter()
    // Center origin (Fabric v7): left/top place the textbox's midpoint.
    const textbox = new Textbox(equation, {
      left: center.x,
      top: center.y,
      width: 280,
      fontSize: 24,
      fill: strokeColorRef.current,
      backgroundColor: '#eef2ff',
      padding: 10,
    }) as CanvasObject
    textbox.canvexType = 'math'
    // Plain canvas.add: the object:added handler sends the create op, and the
    // backend's math trigger enqueues the AI analysis for this element.
    canvas.add(textbox)
    canvas.setActiveObject(textbox)
    canvas.requestRenderAll()
    setMathInput('')
    setIsMathOpen(false)
    showToolMessage('Equation placed — Canvex AI is analyzing it…')
  }, [mathInput, sceneCenter, showToolMessage])

  const handleShare = useCallback(async () => {
    if (!page) {
      showToolMessage('Select a page before creating a share link.')
      return
    }
    try {
      const { share_url } = await createShareLink(page.id)
      const fullUrl = `${window.location.origin}${share_url}`
      try {
        await navigator.clipboard.writeText(fullUrl)
        showToolMessage('Read-only share link copied to clipboard.')
      } catch {
        showToolMessage(`Share link: ${fullUrl}`)
      }
    } catch {
      showToolMessage('Could not create a share link.')
    }
  }, [page, showToolMessage])

  // The one AI action: scan the whole page and drop an answer next to every
  // problem that needs one. No dialog — a floating button triggers this.
  const solvePage = useCallback(async () => {
    const canvas = fabricRef.current
    if (!page?.id || !canvas) {
      showToolMessage('Open a page first.')
      return
    }
    let snapshot: string | undefined
    try {
      const maxDim = Math.max(canvas.getWidth(), canvas.getHeight()) || 1536
      const multiplier = Math.min(1, 1536 / maxDim)
      snapshot = canvas.toDataURL({ format: 'png', multiplier, enableRetinaScaling: false })
    } catch {
      snapshot = undefined
    }
    if (!snapshot) {
      showToolMessage('Could not read the canvas to scan.')
      return
    }

    setAiSolving(true)
    setStatusMessage('Canvex AI is scanning the page…')
    try {
      const result = await solvePageApi(page.id, snapshot)
      if (result.answers.length === 0) {
        showToolMessage(
          result.source === 'gemini'
            ? 'Nothing on the page needs an answer yet.'
            : 'Scanning the page needs a Gemini vision model — set GEMINI_API_KEY.',
        )
        return
      }
      const zoom = canvas.getZoom() || 1
      const vpt = canvas.viewportTransform
      const width = canvas.getWidth()
      const height = canvas.getHeight()
      let stackIndex = 0
      result.answers.forEach((item) => {
        let left: number
        let top: number
        if (vpt && item.x != null && item.y != null) {
          // Normalised image position → scene coords, nudged just past the problem.
          left = (item.x * width - vpt[4]) / zoom + 14
          top = (item.y * height - vpt[5]) / zoom + 14
        } else {
          // No position → stack the answers down the left of the view.
          left = vpt ? (24 - vpt[4]) / zoom : 40
          top = (vpt ? (90 - vpt[5]) / zoom : 90) + stackIndex * 96
          stackIndex += 1
        }
        const textbox = new Textbox(item.answer, {
          left,
          top,
          width: 300,
          fontSize: 20,
          fontFamily: 'Caveat, cursive',
          fill: '#3730a3',
          lineHeight: 1.25,
          padding: 6,
        }) as CanvasObject
        textbox.canvexType = 'text'
        canvas.add(textbox) // object:added persists + syncs each answer
      })
      setTool('select')
      canvas.requestRenderAll()
      setStatusMessage(
        `Canvex AI answered ${result.answers.length} ${result.answers.length === 1 ? 'item' : 'items'} on the page — drag, resize, or delete any.`,
      )
    } catch {
      showToolMessage('Canvex AI could not scan the page. Please try again.')
      setStatusMessage('')
    } finally {
      setAiSolving(false)
    }
  }, [page?.id, setTool, showToolMessage])

  const applyStrokeColor = useCallback(
    (color: string) => {
      setStrokeColor(color)
      const canvas = fabricRef.current
      if (!canvas) return
      // The main swatches drive pen/pencil; the highlighter keeps its own
      // colour set, so leave its brush untouched here.
      if (canvas.freeDrawingBrush && activeToolRef.current !== 'highlighter') {
        canvas.freeDrawingBrush.color = color
      }
      const activeObjects = canvas.getActiveObjects() as CanvasObject[]
      if (activeObjects.length === 0) return
      activeObjects.forEach((obj) => {
        obj.set({ stroke: color })
        if (obj.type === 'textbox') {
          obj.set({ fill: color })
        }
        if (obj.elementId) {
          sendElementUpdate(obj)
        } else {
          obj.pendingSync = true
        }
      })
      canvas.requestRenderAll()
    },
    [sendElementUpdate],
  )

  const deleteActiveObjects = useCallback(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    const activeObjects = canvas.getActiveObjects() as CanvasObject[]
    if (activeObjects.length === 0) {
      showToolMessage('Select an element first, then use the eraser.')
      return
    }
    activeObjects.forEach((obj) => canvas.remove(obj))
    canvas.discardActiveObject()
    canvas.requestRenderAll()
  }, [showToolMessage])

  useEffect(() => {
    activeToolRef.current = tool
    const canvas = fabricRef.current
    if (!canvas) return
    const isDraw = DRAW_TOOLS.includes(tool)
    canvas.isDrawingMode = isDraw
    if (isDraw) {
      lastDrawToolRef.current = tool
    }
    // Rubber-band selection only in the Select tool; every other tool either
    // draws, places, or erases and must not start a selection box.
    canvas.selection = tool === 'select'
    if (isDraw) {
      const brush =
        canvas.freeDrawingBrush instanceof PencilBrush
          ? canvas.freeDrawingBrush
          : new PencilBrush(canvas)
      if (tool === 'pencil') {
        brush.width = 1.5
        brush.color = strokeColorRef.current
      } else if (tool === 'highlighter') {
        brush.width = highlighterWidthRef.current
        brush.color = toRgba(highlighterColorRef.current, HIGHLIGHTER_ALPHA)
      } else {
        brush.width = 3
        brush.color = strokeColorRef.current
      }
      canvas.freeDrawingBrush = brush
    }
    // Remove any stale eraser cursor from the previous tool.
    if (eraserCursorRef.current) {
      applyingRemote.current = true
      canvas.remove(eraserCursorRef.current)
      applyingRemote.current = false
      eraserCursorRef.current = null
    }
    if (tool === 'eraser') {
      // Hide the native cursor and show a dashed circle sized to the eraser.
      canvas.defaultCursor = 'none'
      canvas.hoverCursor = 'none'
      const cursor = new FabricCircle({
        radius: eraserSizeRef.current / 2,
        left: -100,
        top: -100,
        originX: 'center',
        originY: 'center',
        fill: 'rgba(148, 163, 184, 0.18)',
        stroke: '#64748b',
        strokeWidth: 1,
        strokeDashArray: [4, 3],
        selectable: false,
        evented: false,
      }) as unknown as FabricCircle & { isRemote?: boolean }
      cursor.isRemote = true
      applyingRemote.current = true
      canvas.add(cursor)
      applyingRemote.current = false
      eraserCursorRef.current = cursor
      canvas.discardActiveObject()
      canvas.requestRenderAll()
    } else {
      canvas.defaultCursor = 'default'
      canvas.hoverCursor = 'move'
    }
    erasingRef.current = false
  }, [tool])

  useEffect(() => {
    if (!page?.id || !canvasRef.current || !containerRef.current) return
    const timers = textUpdateTimers.current
    const objectMap = objectsById.current
    const pendingCreateMap = pendingCreates.current

    const canvas = new Canvas(canvasRef.current, {
      preserveObjectStacking: true,
      selection: true,
    })
    canvas.backgroundColor = 'rgba(245, 244, 236, 0)'
    fabricRef.current = canvas
    // Debug/test hook: lets integration tests inspect canvas geometry.
    ;(window as unknown as Record<string, unknown>).__canvexCanvas = canvas

    const resize = () => {
      if (!containerRef.current) return
      const width = containerRef.current.clientWidth
      const height = containerRef.current.clientHeight
      canvas.setDimensions({ width, height })
      canvas.renderAll()
    }

    resize()
    window.addEventListener('resize', resize)

    const handleKeyDown = (event: KeyboardEvent) => {
      const typing =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement ||
        document.activeElement?.getAttribute('contenteditable') === 'true'
      if ((event.ctrlKey || event.metaKey) && !typing) {
        const key = event.key.toLowerCase()
        if (key === 'z') {
          event.preventDefault()
          if (event.shiftKey) {
            performRedoRef.current()
          } else {
            performUndoRef.current()
          }
          return
        }
        if (key === 'y') {
          event.preventDefault()
          performRedoRef.current()
          return
        }
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active?.getAttribute('contenteditable') === 'true'
      ) {
        return
      }
      if (canvas.getActiveObjects().length === 0) return
      event.preventDefault()
      deleteActiveObjects()
    }

    window.addEventListener('keydown', handleKeyDown)

    // Reset the viewport for the freshly created canvas of this page.
    setViewport({ zoom: 1, tx: 0, ty: 0 })

    canvas.on('mouse:wheel', (event) => {
      const wheel = event.e as WheelEvent
      if (!wheel.ctrlKey) return
      wheel.preventDefault()
      wheel.stopPropagation()
      const factor = wheel.deltaY > 0 ? 0.9 : 1.1
      const next = Math.min(4, Math.max(0.25, canvas.getZoom() * factor))
      canvas.zoomToPoint(new Point(wheel.offsetX, wheel.offsetY), next)
      const vpt = canvas.viewportTransform
      setViewport({ zoom: next, tx: vpt?.[4] ?? 0, ty: vpt?.[5] ?? 0 })
      canvas.requestRenderAll()
    })

    // PencilBrush finishes by adding a Path; convert it into our polyline
    // 'stroke' element (the Path itself is skipped by every sync handler).
    canvas.on('path:created', (event) => {
      const path = (event as { path?: Path }).path
      if (!path) return
      const commands = (path.path ?? []) as unknown as Array<Array<string | number>>
      const points: Array<{ x: number; y: number }> = []
      commands.forEach((command) => {
        const numbers = command.filter((value): value is number => typeof value === 'number')
        if (numbers.length >= 2) {
          points.push({ x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] })
        }
      })
      applyingRemote.current = true
      canvas.remove(path)
      applyingRemote.current = false
      if (points.length < 2) {
        canvas.requestRenderAll()
        return
      }
      const polyline = new Polyline(points, {
        stroke: (path.stroke as string) ?? strokeColorRef.current,
        strokeWidth: path.strokeWidth ?? 3,
        fill: 'transparent',
      }) as CanvasObject
      polyline.canvexType = 'stroke'
      canvas.add(polyline)
      canvas.requestRenderAll()
    })

    // Scene-space (zoom/pan-independent) bounding box of an object.
    const sceneBounds = (obj: CanvasObject) => {
      obj.setCoords()
      const corners = obj.aCoords ? Object.values(obj.aCoords) : []
      const xs = corners.map((c) => c.x)
      const ys = corners.map((c) => c.y)
      return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
    }

    // Scene-space coordinates of a polyline's vertices (accounts for the
    // pathOffset centering and the object's transform, so it stays correct at
    // any zoom or after the stroke has been moved).
    const sceneVertices = (poly: Polyline): Point[] => {
      const matrix = poly.calcTransformMatrix()
      const offset = poly.pathOffset ?? { x: 0, y: 0 }
      return (poly.points ?? []).map((p) =>
        util.transformPoint(new Point(p.x - offset.x, p.y - offset.y), matrix),
      )
    }

    const circleHitsBounds = (cx: number, cy: number, r: number, b: ReturnType<typeof sceneBounds>) => {
      const nx = Math.max(b.minX, Math.min(cx, b.maxX))
      const ny = Math.max(b.minY, Math.min(cy, b.maxY))
      return (cx - nx) ** 2 + (cy - ny) ** 2 <= r * r
    }

    // One erase "dab" at a scene point. Whole mode removes any element the
    // eraser circle touches; Partial mode removes only the covered span of a
    // stroke, splitting it into the surviving fragments. Both go through the
    // normal add/remove events, so every change syncs and is undoable.
    const eraseStep = (cx: number, cy: number) => {
      const radius = eraserSizeRef.current / 2
      const partial = eraserModeRef.current === 'partial'
      // Snapshot the object list: we mutate it while iterating.
      for (const object of [...canvas.getObjects()]) {
        const obj = object as CanvasObject
        if (obj.isRemote || obj.type === 'path') continue
        if (!partial) {
          if (circleHitsBounds(cx, cy, radius, sceneBounds(obj))) {
            canvas.remove(obj)
            erasedSomethingRef.current = true
          }
          continue
        }
        // Partial: only strokes can be partially erased.
        if (obj.type !== 'polyline') continue
        const verts = sceneVertices(obj as Polyline)
        if (!circleHitsBounds(cx, cy, radius, sceneBounds(obj))) continue
        const runs: Point[][] = []
        let run: Point[] = []
        for (const v of verts) {
          const covered = (v.x - cx) ** 2 + (v.y - cy) ** 2 <= radius * radius
          if (covered) {
            if (run.length) runs.push(run)
            run = []
          } else {
            run.push(v)
          }
        }
        if (run.length) runs.push(run)
        // Nothing actually covered → leave the stroke alone.
        if (runs.length === 1 && runs[0].length === verts.length) continue
        canvas.remove(obj)
        erasedSomethingRef.current = true
        for (const fragment of runs) {
          if (fragment.length < 2) continue
          const frag = new Polyline(fragment, {
            stroke: obj.stroke,
            strokeWidth: obj.strokeWidth,
            fill: 'transparent',
          }) as CanvasObject
          frag.canvexType = 'stroke'
          canvas.add(frag)
        }
      }
      canvas.requestRenderAll()
    }

    canvas.on('mouse:down', (event) => {
      // Any canvas interaction minimises the tool-options popover.
      setOptionsOpen(false)
      if (activeToolRef.current === 'eraser') {
        erasingRef.current = true
        erasedSomethingRef.current = false
        const p = canvas.getScenePoint(event.e)
        eraseStep(p.x, p.y)
        return
      }
      const pointer = canvas.getScenePoint(event.e)
      if (activeToolRef.current === 'rect') {
        const rect = new Rect({
          left: pointer.x,
          top: pointer.y,
          width: DEFAULT_RECT.width,
          height: DEFAULT_RECT.height,
          fill: '#f8fafc',
          stroke: strokeColorRef.current,
          strokeWidth: 2,
        }) as CanvasObject
        rect.canvexType = 'rect'
        canvas.add(rect)
        canvas.setActiveObject(rect)
        setTool('select')
      }
      if (activeToolRef.current === 'ellipse') {
        const ellipse = new Ellipse({
          left: pointer.x,
          top: pointer.y,
          rx: DEFAULT_ELLIPSE.rx,
          ry: DEFAULT_ELLIPSE.ry,
          fill: '#fef9c3',
          stroke: strokeColorRef.current,
          strokeWidth: 2,
        }) as CanvasObject
        ellipse.canvexType = 'ellipse'
        canvas.add(ellipse)
        canvas.setActiveObject(ellipse)
        setTool('select')
      }
      if (activeToolRef.current === 'arrow') {
        const line = new Line([pointer.x, pointer.y, pointer.x + 120, pointer.y - 40], {
          stroke: strokeColorRef.current,
          strokeWidth: 2,
          fill: 'transparent',
        }) as CanvasObject
        line.canvexType = 'arrow'
        canvas.add(line)
        canvas.setActiveObject(line)
        setTool('select')
      }
      if (activeToolRef.current === 'text' || activeToolRef.current === 'sticky') {
        const isSticky = activeToolRef.current === 'sticky'
        const textbox = new Textbox(isSticky ? 'Sticky note' : 'Text', {
          left: pointer.x,
          top: pointer.y,
          width: isSticky ? 180 : 220,
          fontSize: isSticky ? 18 : 20,
          fill: strokeColorRef.current,
          backgroundColor: isSticky ? '#fef3c7' : '',
          padding: isSticky ? 12 : 0,
        })
        const canvexTextbox = textbox as CanvasObject
        canvexTextbox.canvexType = isSticky ? 'sticky' : 'text'
        canvas.add(canvexTextbox)
        canvas.setActiveObject(canvexTextbox)
        textbox.enterEditing()
        setTool('select')
      }
    })

    canvas.on('mouse:up', () => {
      if (activeToolRef.current === 'eraser') {
        erasingRef.current = false
        // "Auto switch back to last tool": after an erase gesture that
        // removed something, return to the last drawing tool.
        if (autoSwitchBackRef.current && erasedSomethingRef.current) {
          setTool(lastDrawToolRef.current)
        }
        erasedSomethingRef.current = false
      }
    })

    canvas.on('mouse:move', (event) => {
      if (activeToolRef.current === 'eraser') {
        const p = canvas.getScenePoint(event.e)
        // Follow the pointer with the dashed eraser circle every move.
        const cursor = eraserCursorRef.current
        // Guard against a cursor left over from a previous page's canvas.
        if (cursor && cursor.canvas === canvas) {
          cursor.set({ left: p.x, top: p.y })
          cursor.setCoords()
          canvas.bringObjectToFront(cursor)
          canvas.requestRenderAll()
        }
        if (erasingRef.current) {
          eraseStep(p.x, p.y)
        }
      }
      if (!pageRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
      if (cursorThrottleRef.current) return
      cursorThrottleRef.current = window.setTimeout(() => {
        cursorThrottleRef.current = null
      }, 30)
      const pointer = canvas.getScenePoint(event.e)
      sendMessage({ type: 'cursor:move', payload: { x: pointer.x, y: pointer.y, color: cursorColor } })
    })

    canvas.on('selection:created', (event) => {
      if (activeToolRef.current === 'eraser') return
      const obj = event.selected?.[0] as CanvasObject | undefined
      if (obj?.elementId) {
        sendLock(obj.elementId)
      }
    })

    canvas.on('selection:updated', (event) => {
      if (activeToolRef.current === 'eraser') return
      const obj = event.selected?.[0] as CanvasObject | undefined
      if (obj?.elementId) {
        sendLock(obj.elementId)
      }
    })

    canvas.on('object:added', (event) => {
      const obj = event.target as CanvasObject | undefined
      if (!obj || applyingRemote.current || obj.isRemote) return
      if (obj.type === 'path') return
      if (!obj.elementId) {
        sendElementCreate(obj)
      }
      pushHistory({ op: 'remove', obj })
    })

    canvas.on('object:modified', (event) => {
      const obj = event.target as CanvasObject | undefined
      if (!obj || applyingRemote.current || obj.isRemote) return
      if (obj.type === 'path') return
      sendElementUpdate(obj)
      const original = event.transform?.original as Partial<TransformSnapshot> | undefined
      if (original) {
        pushHistory({
          op: 'setTransform',
          obj,
          props: {
            left: original.left ?? obj.left,
            top: original.top ?? obj.top,
            scaleX: original.scaleX ?? obj.scaleX,
            scaleY: original.scaleY ?? obj.scaleY,
            angle: original.angle ?? obj.angle,
          },
          prev: { left: obj.left, top: obj.top, scaleX: obj.scaleX, scaleY: obj.scaleY, angle: obj.angle },
        })
      }
    })

    canvas.on('object:removed', (event) => {
      const obj = event.target as CanvasObject | undefined
      if (!obj || applyingRemote.current || obj.isRemote) return
      if (obj.type === 'path') return
      pushHistory({ op: 'insert', snapshot: snapshotOf(obj) })
      sendElementDelete(obj)
    })

    canvas.on('text:changed', (event) => {
      const obj = event.target as CanvasObject | undefined
      if (!obj || applyingRemote.current || obj.isRemote) return
      const timerKey = obj.syncLocalId ?? obj.localCreateId ?? obj.elementId ?? ensureLocalId(obj)
      const existing = textUpdateTimers.current.get(timerKey)
      if (existing) {
        window.clearTimeout(existing)
      }
      const timer = window.setTimeout(() => {
        sendElementUpdate(obj)
        textUpdateTimers.current.delete(timerKey)
      }, 300)
      textUpdateTimers.current.set(timerKey, timer)
    })

    canvas.on('text:editing:exited', (event) => {
      const obj = event.target as CanvasObject | undefined
      if (!obj || applyingRemote.current || obj.isRemote) return
      const timerKey = obj.syncLocalId ?? obj.localCreateId ?? obj.elementId ?? ensureLocalId(obj)
      const existing = textUpdateTimers.current.get(timerKey)
      if (existing) {
        window.clearTimeout(existing)
        textUpdateTimers.current.delete(timerKey)
      }
      sendElementUpdate(obj)
    })

    return () => {
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', handleKeyDown)
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
      if (cursorThrottleRef.current) {
        window.clearTimeout(cursorThrottleRef.current)
        cursorThrottleRef.current = null
      }
      objectMap.clear()
      pendingCreateMap.clear()
      fabricRef.current = null
      canvas.dispose()
    }
  }, [
    cursorColor,
    deleteActiveObjects,
    ensureLocalId,
    page?.id,
    pushHistory,
    sendElementCreate,
    sendElementDelete,
    sendElementUpdate,
    sendLock,
    sendMessage,
    snapshotOf,
  ])

  useEffect(() => {
    const pageId = page?.id
    if (!pageId || !fabricRef.current) return
    let cancelled = false

    const load = async () => {
      restLoadSucceededRef.current = false
      setIsLoadingPage(true)
      try {
        const elements = await listElements(pageId)
        if (cancelled || pageRef.current?.id !== pageId || !fabricRef.current) return
        restLoadSucceededRef.current = true
        applyingRemote.current = true
        fabricRef.current.clear()
        fabricRef.current.backgroundColor = 'rgba(245, 244, 236, 0)'
        objectsById.current.clear()
        pendingCreates.current.clear()
        if (offlineQueueRef.current.length === 0) {
          yElementsRef.current?.clear()
        }
        setCursors({})
        elements.filter((element) => !element.is_deleted).forEach((element) => {
          writeServerElementToYjs(element)
          addElementToCanvas(element)
        })
        if (offlineQueueRef.current.length > 0) {
          Array.from(yElementsRef.current?.values() ?? [])
            .filter((element) => !element.is_deleted && !element.server_id)
            .forEach(addCachedElementToCanvas)
        }
      } catch {
        if (!cancelled) {
          const cachedCount = renderCachedElements()
          setStatusMessage(
            cachedCount > 0
              ? 'Loaded your offline notebook copy.'
              : 'Failed to load elements for this page.',
          )
        }
      } finally {
        if (!cancelled) {
          applyingRemote.current = false
          setIsLoadingPage(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [addCachedElementToCanvas, addElementToCanvas, page?.id, renderCachedElements, writeServerElementToYjs])

  useEffect(() => {
    const pageId = page?.id
    if (!pageId) return
    let closedByCleanup = false
    let retryTimer: number | null = null
    const lockTimers = lockTimersRef.current
    const wsUrl = new URL(`/ws/${pageId}`, import.meta.env.VITE_API_URL ?? 'http://localhost:8000')
    wsUrl.protocol = wsUrl.protocol.replace('http', 'ws')
    // Prefer the freshest stored token: the axios interceptor rotates the
    // session in localStorage, while the accessToken prop only changes on a
    // full re-login.
    wsUrl.searchParams.set('token', loadSession()?.accessToken ?? accessToken)
    const socket = new WebSocket(wsUrl.toString())
    wsRef.current = socket
    setConnectionState('connecting')

    socket.onopen = () => {
      wsRetryCountRef.current = 0
      setConnectionState('connected')
      window.setTimeout(() => flushOfflineQueue(), 0)
    }
    socket.onclose = () => {
      setConnectionState('disconnected')
      if (closedByCleanup) return
      // Auto-reconnect with capped exponential backoff (1s → 16s). Without
      // this, a dropped socket left the page dead until it was re-opened, and
      // queued offline work was never replayed.
      const attempt = (wsRetryCountRef.current += 1)
      const delayMs = Math.min(16000, 1000 * 2 ** Math.min(attempt - 1, 4))
      retryTimer = window.setTimeout(() => setWsRetryNonce((nonce) => nonce + 1), delayMs)
    }
    socket.onerror = () => {
      setConnectionState('disconnected')
    }
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        switch (message.type) {
          case 'element:ack': {
            if (message.operation === 'create') {
              const created = message.payload as Element
              const clientOperationId =
                typeof message.client_operation_id === 'string' ? message.client_operation_id : null
              const obj = clientOperationId ? pendingCreates.current.get(clientOperationId) : undefined
              if (obj) {
                pendingCreates.current.delete(clientOperationId)
                delete obj.localCreateId
                obj.elementId = created.id
                obj.canvexType = created.type
                objectsById.current.set(created.id, obj)
                writeServerElementToYjs(created, obj.syncLocalId ?? created.id)
                if (obj.pendingSync) {
                  delete obj.pendingSync
                  sendElementUpdate(obj)
                }
              } else {
                writeServerElementToYjs(created)
              }
            }
            if (message.operation === 'update') {
              updateElementOnCanvas(message.payload as Element)
            }
            if (message.operation === 'delete') {
              removeElementFromCanvas(message.payload.id)
            }
            resolveOfflineQueueItem(
              typeof message.client_operation_id === 'string' ? message.client_operation_id : null,
              'synced',
            )
            return
          }
          case 'element:op': {
            const payload = message.payload as Element
            if (message.operation === 'create') {
              addElementToCanvas(payload)
            } else if (message.operation === 'update') {
              updateElementOnCanvas(payload)
            } else if (message.operation === 'delete') {
              removeElementFromCanvas(payload.id)
            }
            return
          }
          case 'element:lock': {
            const lockPayload = message.payload as { element_id: string; locked_by: string; ttl_s?: number }
            const obj = objectsById.current.get(lockPayload.element_id)
            if (obj && lockPayload.locked_by !== user.id) {
              obj.selectable = false
              obj.opacity = 0.6
              fabricRef.current?.renderAll()
              // The server lock is a Redis key with a TTL; an explicit unlock
              // is only broadcast when the locker disconnects. Mirror the TTL
              // locally so the element doesn't stay frozen forever once the
              // lock silently expires.
              const existingTimer = lockTimersRef.current.get(lockPayload.element_id)
              if (existingTimer) {
                window.clearTimeout(existingTimer)
              }
              const ttlMs = (lockPayload.ttl_s ?? 10) * 1000
              lockTimersRef.current.set(
                lockPayload.element_id,
                window.setTimeout(() => {
                  lockTimersRef.current.delete(lockPayload.element_id)
                  const lockedObj = objectsById.current.get(lockPayload.element_id)
                  if (lockedObj) {
                    lockedObj.selectable = true
                    lockedObj.opacity = 1
                    fabricRef.current?.renderAll()
                  }
                }, ttlMs),
              )
            }
            return
          }
          case 'element:unlock': {
            const lockPayload = message.payload as { element_id: string }
            const lockTimer = lockTimersRef.current.get(lockPayload.element_id)
            if (lockTimer) {
              window.clearTimeout(lockTimer)
              lockTimersRef.current.delete(lockPayload.element_id)
            }
            const obj = objectsById.current.get(lockPayload.element_id)
            if (obj) {
              obj.selectable = true
              obj.opacity = 1
              fabricRef.current?.renderAll()
            }
            return
          }
          case 'cursor:move': {
            const cursorPayload = message.payload as {
              user_id: string
              display_name: string
              x: number
              y: number
              color?: string
            }
            if (cursorPayload.user_id === user.id) return
            setCursors((prev) => ({
              ...prev,
              [cursorPayload.user_id]: {
                userId: cursorPayload.user_id,
                displayName: cursorPayload.display_name,
                x: cursorPayload.x,
                y: cursorPayload.y,
                color: cursorPayload.color ?? colorFromId(cursorPayload.user_id),
                updatedAt: Date.now(),
              },
            }))
            return
          }
          case 'ai:response': {
            const payload = message.payload as { element: Element }
            addElementToCanvas(payload.element)
            setStatusMessage('Canvex AI added a response.')
            return
          }
          case 'presence:leave': {
            const payload = message.payload as { user_id: string }
            setCursors((prev) => {
              const next = { ...prev }
              delete next[payload.user_id]
              return next
            })
            return
          }
          case 'element:error': {
            const clientOperationId =
              typeof message.client_operation_id === 'string' ? message.client_operation_id : null
            if (clientOperationId) {
              resolveOfflineQueueItem(clientOperationId, 'rejected', message.detail)
            } else {
              setStatusMessage(message.detail ?? 'Canvas update failed')
            }
            return
          }
          default:
            return
        }
      } catch {
        setStatusMessage('WebSocket message failed to parse')
      }
    }

    return () => {
      closedByCleanup = true
      if (retryTimer) {
        window.clearTimeout(retryTimer)
      }
      lockTimers.forEach((timer) => window.clearTimeout(timer))
      lockTimers.clear()
      socket.close()
      wsRef.current = null
    }
  }, [
    accessToken,
    addElementToCanvas,
    flushOfflineQueue,
    page?.id,
    removeElementFromCanvas,
    resolveOfflineQueueItem,
    sendElementUpdate,
    updateElementOnCanvas,
    user.id,
    writeServerElementToYjs,
    wsRetryNonce,
  ])


  useEffect(() => {
    const pageId = page?.id
    if (!pageId) return
    const refreshPresence = async () => {
      try {
        const count = await getPresenceCount(pageId)
        setPresenceCount(count)
      } catch {
        setPresenceCount(0)
      }
    }
    refreshPresence()
    const interval = window.setInterval(refreshPresence, 10000)
    return () => window.clearInterval(interval)
  }, [page?.id])

  useEffect(() => {
    if (!statusMessage) return
    const timer = window.setTimeout(() => setStatusMessage(null), 4000)
    return () => window.clearTimeout(timer)
  }, [statusMessage])

  useEffect(() => {
    if (!page?.id) return
    // A user who simply stops moving never triggers presence:leave, so sweep
    // out cursors that haven't been refreshed within the server-side TTL.
    const interval = window.setInterval(() => {
      setCursors((prev) => {
        const now = Date.now()
        const fresh = Object.entries(prev).filter(([, cursor]) => now - cursor.updatedAt <= CURSOR_STALE_MS)
        return fresh.length === Object.keys(prev).length ? prev : Object.fromEntries(fresh)
      })
    }, 2000)
    return () => window.clearInterval(interval)
  }, [page?.id])

  useEffect(() => {
    if (isOffline) return
    const socket = wsRef.current
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      flushOfflineQueue()
      return
    }
    // Back online but the socket already died: reconnect right away instead
    // of waiting out the backoff timer (or sitting dead if none is pending).
    setWsRetryNonce((nonce) => nonce + 1)
  }, [flushOfflineQueue, isOffline])

  if (!page) {
    return (
      <div className="relative h-full overflow-hidden">
        <div className="workspace-page-label">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Active page</p>
          <h2 className="font-handwriting text-3xl font-semibold text-slate-950">No page selected</h2>
        </div>
        <div className="workspace-presence">
          <div className="workspace-avatar">{user.display_name.slice(0, 2).toUpperCase()}</div>
        </div>
        <div className="workspace-tool-capsule opacity-60">
          <span className="hidden font-reading-serif text-lg text-slate-700/80 md:inline">Canvex</span>
          <div className="workspace-tool-divider hidden md:block" />
          <Move size={16} />
          <PenLine size={16} />
          <Brush size={16} />
          <Highlighter size={16} />
          <Eraser size={16} />
          <div className="workspace-tool-divider" />
          <RectangleHorizontal size={16} />
          <Circle size={16} />
          <Text size={16} />
          <StickyNote size={16} />
        </div>
        <div className="canvas-surface absolute inset-0"></div>
        <div className="relative z-20 flex h-full items-center justify-center text-sm text-slate-500">
          <div className="max-w-sm rounded-lg border border-dashed border-slate-300 bg-white/65 px-6 py-5 text-center shadow-sm backdrop-blur-sm">
            <p className="font-reading-serif text-xl text-slate-900">Your notebook is ready.</p>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Create a channel, then add a page from the notebook index on the left to start drawing.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const isConnected = connectionState === 'connected'

  return (
    <div className="relative h-full overflow-hidden">
      <div className="workspace-page-label">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Active page</p>
        <h2 className="font-handwriting text-3xl font-semibold text-slate-950">{page.title}</h2>
      </div>

      <div className="workspace-presence">
        <div className="flex -space-x-2">
          <div className="workspace-avatar">{user.display_name.slice(0, 2).toUpperCase()}</div>
          {presenceCount > 1 && <div className="workspace-avatar muted">+{presenceCount - 1}</div>}
        </div>
        <span className={`workspace-live-chip ${isConnected ? 'online' : ''}`}>
          {isConnected ? 'Live' : connectionState === 'connecting' ? 'Connecting' : 'Offline'}
        </span>
        {(isOffline || queuedOpsCount > 0) && (
          <span className="workspace-offline-chip">
            {isOffline ? 'Working offline' : `${queuedOpsCount} queued`}
          </span>
        )}
        <button type="button" className="workspace-ai-button" onClick={handleShare} title="Copy a read-only share link">
          <Link2 size={15} />
          <span className="workspace-ai-label">Share</span>
        </button>
      </div>

      <div className="workspace-tool-capsule">
        <span className="hidden font-reading-serif text-lg text-slate-700/80 md:inline">Canvex</span>
        <div className="workspace-tool-divider hidden md:block" />
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'select' ? 'active' : ''}`}
          onClick={() => setTool('select')}
          title={TOOL_LABELS.select}
        >
          <Move size={16} />
        </button>
        <div className="workspace-tool-divider" />
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'pen' ? 'active' : ''}`}
          title="Pen"
          onClick={() => {
            setTool('pen')
            showToolMessage('Draw freely — switch back to Select when done.')
          }}
        >
          <PenLine size={16} />
        </button>
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'pencil' ? 'active' : ''}`}
          title="Pencil"
          onClick={() => {
            setTool('pencil')
            showToolMessage('Pencil — fine freehand lines. Switch to Select when done.')
          }}
        >
          <Brush size={16} />
        </button>
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'highlighter' ? 'active' : ''}`}
          title="Highlighter"
          onClick={() => {
            setTool('highlighter')
            setOptionsOpen(true)
            showToolMessage('Highlighter — pick a colour, then drag across the canvas.')
          }}
        >
          <Highlighter size={16} />
        </button>
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'eraser' ? 'active' : ''}`}
          title="Eraser"
          onClick={() => {
            setTool('eraser')
            setOptionsOpen(true)
            showToolMessage('Eraser — click or drag over elements to remove them.')
          }}
        >
          <Eraser size={16} />
        </button>
        <div className="workspace-tool-divider" />
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'rect' ? 'active' : ''}`}
          onClick={() => setTool('rect')}
          title={TOOL_LABELS.rect}
        >
          <RectangleHorizontal size={16} />
        </button>
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'ellipse' ? 'active' : ''}`}
          onClick={() => setTool('ellipse')}
          title={TOOL_LABELS.ellipse}
        >
          <Circle size={16} />
        </button>
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'arrow' ? 'active' : ''}`}
          onClick={() => setTool('arrow')}
          title={TOOL_LABELS.arrow}
        >
          <MoveUpRight size={16} />
        </button>
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'text' ? 'active' : ''}`}
          onClick={() => setTool('text')}
          title={TOOL_LABELS.text}
        >
          <Text size={16} />
        </button>
        <button
          type="button"
          className={`workspace-tool-button ${tool === 'sticky' ? 'active' : 'ghost'}`}
          title="Sticky Note"
          onClick={() => {
            setTool('sticky')
            showToolMessage('Click the canvas to place a note.')
          }}
        >
          <StickyNote size={16} />
        </button>
        <button
          type="button"
          className={`workspace-tool-button ${isMathOpen ? 'active' : ''}`}
          title="Math input"
          onClick={() => setIsMathOpen(true)}
        >
          <Sigma size={16} />
        </button>
        <button
          type="button"
          className={`workspace-tool-button ghost ${isUploadingImage ? 'active' : ''}`}
          title="Image"
          disabled={isUploadingImage}
          onClick={() => fileInputRef.current?.click()}
        >
          <Image size={16} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null
            event.target.value = ''
            handleImageSelected(file)
          }}
        />
        <div className="workspace-tool-divider" />
        <div className="workspace-swatches">
          {['#0f172a', '#2563eb', '#ef4444', '#22c55e', '#facc15', '#818cf8'].map((color) => (
            <button
              key={color}
              type="button"
              className={`workspace-swatch ${strokeColor === color ? 'active' : ''}`}
              style={{ backgroundColor: color }}
              onClick={() => applyStrokeColor(color)}
              title={`Use ${color}`}
            />
          ))}
        </div>
        <div className="workspace-tool-divider hidden sm:block" />
        <button
          type="button"
          className="workspace-tool-button ghost hidden sm:flex disabled:opacity-40"
          title="Undo (Ctrl+Z)"
          disabled={historyVersion >= 0 && undoStackRef.current.length === 0}
          onClick={() => performUndoRef.current()}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className="workspace-tool-button ghost hidden sm:flex disabled:opacity-40"
          title="Redo (Ctrl+Shift+Z)"
          disabled={historyVersion >= 0 && redoStackRef.current.length === 0}
          onClick={() => performRedoRef.current()}
        >
          <Redo2 size={16} />
        </button>
        <div className="workspace-tool-divider hidden sm:block" />
        <button
          type="button"
          className="workspace-tool-button ghost hidden sm:flex"
          title="Zoom out (Ctrl+scroll)"
          onClick={() => zoomBy(1 / 1.2)}
        >
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          className="hidden w-12 shrink-0 text-center font-mono text-[11px] text-slate-500 hover:text-indigo-600 sm:block"
          title="Reset zoom"
          onClick={resetZoom}
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
        <button
          type="button"
          className="workspace-tool-button ghost hidden sm:flex"
          title="Zoom in (Ctrl+scroll)"
          onClick={() => zoomBy(1.2)}
        >
          <ZoomIn size={16} />
        </button>
      </div>

      {tool === 'highlighter' && optionsOpen && (
        <div className="workspace-tool-popover" onMouseLeave={() => setOptionsOpen(false)}>
          <p className="workspace-popover-label">Highlighter colour</p>
          <div className="mt-2 flex items-center gap-2">
            {HIGHLIGHTER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                title={color}
                onClick={() => setHighlighterColor(color)}
                className={`h-6 w-6 rounded-full ring-1 ring-slate-300 transition-transform ${
                  highlighterColor === color ? 'scale-110 ring-2 ring-indigo-500 ring-offset-2' : ''
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="workspace-popover-label shrink-0">Thickness</span>
            <input
              type="range"
              min={HIGHLIGHTER_WIDTH_RANGE.min}
              max={HIGHLIGHTER_WIDTH_RANGE.max}
              value={highlighterWidth}
              onChange={(event) => setHighlighterWidth(Number(event.target.value))}
              className="h-1.5 flex-1 cursor-pointer accent-indigo-600"
            />
            <span className="w-8 text-right font-mono text-[11px] text-slate-500">{highlighterWidth}px</span>
          </div>
        </div>
      )}

      {tool === 'eraser' && optionsOpen && (
        <div className="workspace-tool-popover" onMouseLeave={() => setOptionsOpen(false)}>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setEraserMode('whole')}
              className={`workspace-eraser-mode ${eraserMode === 'whole' ? 'active' : ''}`}
            >
              <span className="text-sm font-medium">Whole</span>
              <span className="text-[10px] text-slate-400">removes an element</span>
            </button>
            <button
              type="button"
              onClick={() => setEraserMode('partial')}
              className={`workspace-eraser-mode ${eraserMode === 'partial' ? 'active' : ''}`}
            >
              <span className="text-sm font-medium">Partial</span>
              <span className="text-[10px] text-slate-400">rubs out pen strokes</span>
            </button>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="workspace-popover-label shrink-0">Size</span>
            <input
              type="range"
              min={ERASER_SIZE_RANGE.min}
              max={ERASER_SIZE_RANGE.max}
              value={eraserSize}
              onChange={(event) => setEraserSize(Number(event.target.value))}
              className="h-1.5 flex-1 cursor-pointer accent-indigo-600"
            />
            <span className="w-8 text-right font-mono text-[11px] text-slate-500">{eraserSize}px</span>
          </div>
          <label className="mt-3 flex cursor-pointer items-center justify-between">
            <span className="text-xs text-slate-600">Auto switch back to last tool</span>
            <input
              type="checkbox"
              checked={autoSwitchBack}
              onChange={(event) => setAutoSwitchBack(event.target.checked)}
              className="h-4 w-4 cursor-pointer accent-indigo-600"
            />
          </label>
        </div>
      )}

      {isMathOpen && (
        <div className="workspace-modal-backdrop" onClick={() => setIsMathOpen(false)}>
          <div className="workspace-modal max-w-md" onClick={(event) => event.stopPropagation()}>
            <header className="border-b border-slate-200/80 px-6 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Math input</p>
              <h3 className="font-reading-serif text-xl text-slate-950">Write an equation</h3>
            </header>
            <div className="space-y-3 px-6 py-5">
              <input
                autoFocus
                className="workspace-input font-mono text-lg"
                placeholder="2x + 5 = 13"
                value={mathInput}
                onChange={(event) => setMathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleMathSubmit()
                }}
              />
              <p className="text-xs text-slate-400">
                The equation lands on the canvas as a math element and Canvex AI solves it in place.
              </p>
              <button
                type="button"
                onClick={handleMathSubmit}
                disabled={!mathInput.trim()}
                className="workspace-action-button w-full justify-center disabled:opacity-50"
              >
                <Sigma size={15} />
                Place on canvas
              </button>
            </div>
          </div>
        </div>
      )}
      {statusMessage && (
        <div className="workspace-status-message">{statusMessage}</div>
      )}
      {isLoadingPage && (
        <div className="workspace-status-message">Loading page...</div>
      )}

      <div ref={containerRef} className="relative h-full overflow-hidden">
        <div className="canvas-surface absolute inset-0"></div>
        <canvas ref={canvasRef} className="relative z-10 h-full w-full"></canvas>
        {Object.values(cursors).map((cursor) => {
          // Cursors travel in scene coordinates; project into this client's
          // viewport so they stay accurate at any zoom level.
          const screenX = cursor.x * viewport.zoom + viewport.tx
          const screenY = cursor.y * viewport.zoom + viewport.ty
          return (
            <div key={cursor.userId} className="pointer-events-none absolute left-0 top-0">
              <div
                className="cursor-dot"
                style={{ left: screenX, top: screenY, backgroundColor: cursor.color }}
              />
              <div className="cursor-label" style={{ left: screenX, top: screenY }}>
                {cursor.displayName}
              </div>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="workspace-ai-fab"
        onClick={solvePage}
        disabled={aiSolving}
        title="Scan the page and answer every problem that needs an answer"
      >
        <Sparkles size={18} className={aiSolving ? 'animate-pulse' : undefined} />
        {aiSolving ? 'Scanning…' : 'Solve page'}
      </button>
    </div>
  )
}

export default CanvasBoard
