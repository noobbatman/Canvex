import { Canvas, Ellipse, FabricObject, Line, Polyline, Rect, Textbox } from 'fabric'
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
  PenLine,
  RectangleHorizontal,
  Redo2,
  Sparkles,
  StickyNote,
  Text,
  ThumbsDown,
  ThumbsUp,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createShareLink, getPresenceCount, listElements, listPageAiLog, submitAIFeedback } from '../lib/api'
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
import type { AITriggerType, Element, ElementType, PageSummary, User } from '../types'

type Tool = 'select' | 'rect' | 'ellipse' | 'text' | 'sticky'

type CanvasObject = FabricObject & {
  elementId?: string
  canvexType?: ElementType
  isRemote?: boolean
  localCreateId?: string
  syncLocalId?: string
  pendingSync?: boolean
}

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
}

const TOOL_LABELS: Record<Tool, string> = {
  select: 'Select',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  sticky: 'Sticky Note',
}

type AIMessage = {
  interactionId: string
  triggerType: AITriggerType
  content: string
  elementId?: string
}

const DEFAULT_RECT = { width: 140, height: 90 }
const DEFAULT_ELLIPSE = { rx: 60, ry: 40 }

const AI_TEXT_PATTERN = /(^\/ai|^\*|[?]$|[-+]?\d*\.?\d*\s*x\s*(?:[+-]\s*\d+(?:\.\d+)?)?\s*=\s*[-+]?\d+(?:\.\d+)?)/i

const shouldAttachAISnapshot = (element: { type: ElementType; content: Record<string, unknown> }) => {
  if (element.type === 'image') return true
  const text = String(element.content.text ?? element.content.label ?? element.content.latex ?? '')
  return AI_TEXT_PATTERN.test(text)
}

const CanvasBoard = ({ page, user, accessToken }: CanvasBoardProps) => {
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
  const pageRef = useRef<PageSummary | null>(null)
  const seqRef = useRef(0)
  const clientIdRef = useRef(getClientId())
  const cursorThrottleRef = useRef<number | null>(null)
  const wsRetryCountRef = useRef(0)
  const lockTimersRef = useRef<Map<string, number>>(new Map())
  const [wsRetryNonce, setWsRetryNonce] = useState(0)
  const [tool, setTool] = useState<Tool>('select')
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected'>(
    'disconnected',
  )
  const [cursors, setCursors] = useState<Record<string, CursorState>>({})
  const [presenceCount, setPresenceCount] = useState(0)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [strokeColor, setStrokeColor] = useState('#0f172a')
  const [isAiOpen, setIsAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiMessages, setAiMessages] = useState<AIMessage[]>([])
  const [isLoadingPage, setIsLoadingPage] = useState(false)
  const [isOffline, setIsOffline] = useState(!navigator.onLine)
  const [queuedOpsCount, setQueuedOpsCount] = useState(0)
  const strokeColorRef = useRef(strokeColor)
  const isOfflineRef = useRef(isOffline)

  const cursorColor = useMemo(() => colorFromId(user.id), [user.id])

  useEffect(() => {
    pageRef.current = page
  }, [page])

  useEffect(() => {
    strokeColorRef.current = strokeColor
  }, [strokeColor])

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

  const askCanvex = useCallback(() => {
    const canvas = fabricRef.current
    const prompt = aiPrompt.trim()
    if (!page?.id || !canvas) {
      showToolMessage('Create or select a page before asking Canvex.')
      return
    }
    if (!prompt) {
      showToolMessage('Write a question for Canvex first.')
      return
    }
    const obj = new Textbox(`/ai ${prompt}`, {
      left: 180,
      top: 140,
      width: 360,
      fontSize: 24,
      fontFamily: 'Caveat, cursive',
      fill: '#4f46e5',
      stroke: '#4f46e5',
      strokeWidth: 0,
    }) as CanvasObject
    obj.canvexType = 'text'
    canvas.add(obj)
    canvas.setActiveObject(obj)
    canvas.requestRenderAll()
    setAiPrompt('')
    setStatusMessage('Canvex AI is reading the canvas...')
  }, [aiPrompt, page?.id, showToolMessage])

  const sendAIFeedback = useCallback(
    async (interactionId: string, isCorrect: boolean) => {
      const correctionText = isCorrect
        ? null
        : window.prompt('What should Canvex remember for next time?')
      if (!isCorrect && !correctionText?.trim()) {
        showToolMessage('Feedback cancelled. Add a correction so Canvex can learn from it.')
        return
      }
      try {
        await submitAIFeedback(interactionId, {
          is_correct: isCorrect,
          correction_text: correctionText?.trim() || null,
        })
        showToolMessage(isCorrect ? 'Marked as helpful.' : 'Correction saved for future prompts.')
      } catch {
        showToolMessage('Could not save AI feedback.')
      }
    },
    [showToolMessage],
  )

  const applyStrokeColor = useCallback(
    (color: string) => {
      setStrokeColor(color)
      const canvas = fabricRef.current
      if (!canvas) return
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
    canvas.isDrawingMode = false
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

    canvas.on('mouse:down', (event) => {
      const pointer = canvas.getViewportPoint(event.e)
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

    canvas.on('mouse:move', (event) => {
      if (!pageRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
      if (cursorThrottleRef.current) return
      cursorThrottleRef.current = window.setTimeout(() => {
        cursorThrottleRef.current = null
      }, 30)
      const pointer = canvas.getViewportPoint(event.e)
      sendMessage({ type: 'cursor:move', payload: { x: pointer.x, y: pointer.y, color: cursorColor } })
    })

    canvas.on('selection:created', (event) => {
      const obj = event.selected?.[0] as CanvasObject | undefined
      if (obj?.elementId) {
        sendLock(obj.elementId)
      }
    })

    canvas.on('selection:updated', (event) => {
      const obj = event.selected?.[0] as CanvasObject | undefined
      if (obj?.elementId) {
        sendLock(obj.elementId)
      }
    })

    canvas.on('object:added', (event) => {
      const obj = event.target as CanvasObject | undefined
      if (!obj || applyingRemote.current || obj.isRemote) return
      if (!obj.elementId) {
        sendElementCreate(obj)
      }
    })

    canvas.on('object:modified', (event) => {
      const obj = event.target as CanvasObject | undefined
      if (!obj || applyingRemote.current || obj.isRemote) return
      sendElementUpdate(obj)
    })

    canvas.on('object:removed', (event) => {
      const obj = event.target as CanvasObject | undefined
      if (!obj || applyingRemote.current || obj.isRemote) return
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
    sendElementCreate,
    sendElementDelete,
    sendElementUpdate,
    sendLock,
    sendMessage,
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
            const payload = message.payload as {
              element: Element
              interaction_id: string
              trigger_type: AITriggerType
            }
            addElementToCanvas(payload.element)
            setAiMessages((prev) => [
              {
                interactionId: payload.interaction_id,
                triggerType: payload.trigger_type,
                elementId: payload.element.id,
                content: String(payload.element.content.text ?? 'AI response added to canvas.'),
              },
              ...prev.slice(0, 4),
            ])
            setIsAiOpen(true)
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
    if (!pageId) {
      setAiMessages([])
      return
    }
    let cancelled = false
    const loadAiLog = async () => {
      try {
        const interactions = await listPageAiLog(pageId)
        if (cancelled) return
        setAiMessages(
          interactions
            .filter((interaction) => interaction.status === 'succeeded' && interaction.response_json?.content)
            .slice(0, 5)
            .map((interaction) => ({
              interactionId: interaction.id,
              triggerType: interaction.trigger_type,
              elementId: interaction.response_element_id ?? undefined,
              content: String(interaction.response_json?.content ?? ''),
            })),
        )
      } catch {
        if (!cancelled) {
          setAiMessages([])
        }
      }
    }
    loadAiLog()
    return () => {
      cancelled = true
    }
  }, [page?.id])

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
          <button type="button" className="workspace-ai-button" onClick={() => setIsAiOpen((prev) => !prev)}>
            <Sparkles size={15} />
            <span className="workspace-ai-label">Ask Canvex</span>
          </button>
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
        {isAiOpen && (
          <aside className="workspace-ai-panel">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-reading-serif text-lg text-indigo-700">Ask Canvex</h3>
                <p className="text-xs uppercase tracking-[0.18em] text-slate-400">AI notebook assistant</p>
              </div>
              <button type="button" className="workspace-ghost-button" onClick={() => setIsAiOpen(false)}>
                Close
              </button>
            </div>
            <p className="mt-5 rounded-lg border border-indigo-100 bg-indigo-50/60 p-3 text-sm leading-6 text-slate-600">
              Create a page first, then I can help summarize, explain, and organize your canvas.
            </p>
          </aside>
        )}
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
        <button type="button" className="workspace-ai-button" onClick={() => setIsAiOpen((prev) => !prev)}>
          <Sparkles size={15} />
          <span className="workspace-ai-label">Ask Canvex</span>
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
          className="workspace-tool-button ghost"
          title="Pen"
          onClick={() => showToolMessage('Freehand pen is planned for the drawing phase. Use shapes and text for now.')}
        >
          <PenLine size={16} />
        </button>
        <button
          type="button"
          className="workspace-tool-button ghost"
          title="Pencil"
          onClick={() => showToolMessage('Pencil mode is coming soon.')}
        >
          <Brush size={16} />
        </button>
        <button
          type="button"
          className="workspace-tool-button ghost"
          title="Highlighter"
          onClick={() => showToolMessage('Highlighter mode is coming soon.')}
        >
          <Highlighter size={16} />
        </button>
        <button type="button" className="workspace-tool-button ghost" title="Eraser" onClick={deleteActiveObjects}>
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
          className="workspace-tool-button ghost"
          title="Image"
          onClick={() => showToolMessage('Image uploads are coming soon.')}
        >
          <Image size={16} />
        </button>
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
          className="workspace-tool-button ghost hidden sm:flex"
          title="Undo"
          onClick={() => showToolMessage('Undo is coming soon.')}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className="workspace-tool-button ghost hidden sm:flex"
          title="Redo"
          onClick={() => showToolMessage('Redo is coming soon.')}
        >
          <Redo2 size={16} />
        </button>
      </div>

      {statusMessage && (
        <div className="workspace-status-message">{statusMessage}</div>
      )}
      {isLoadingPage && (
        <div className="workspace-status-message">Loading page...</div>
      )}

      <div ref={containerRef} className="relative h-full overflow-hidden">
        <div className="canvas-surface absolute inset-0"></div>
        <canvas ref={canvasRef} className="relative z-10 h-full w-full"></canvas>
        {Object.values(cursors).map((cursor) => (
          <div key={cursor.userId} className="pointer-events-none absolute left-0 top-0">
            <div
              className="cursor-dot"
              style={{ left: cursor.x, top: cursor.y, backgroundColor: cursor.color }}
            />
            <div className="cursor-label" style={{ left: cursor.x, top: cursor.y }}>
              {cursor.displayName}
            </div>
          </div>
        ))}
      </div>
      {isAiOpen && (
        <aside className="workspace-ai-panel">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-reading-serif text-lg text-indigo-700">Ask Canvex</h3>
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">AI notebook assistant</p>
            </div>
            <button type="button" className="workspace-ghost-button" onClick={() => setIsAiOpen(false)}>
              Close
            </button>
          </div>
          <div className="mt-5 space-y-3 text-sm leading-6 text-slate-600">
            <p className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3">
              Write a question, or draw an equation like 2x + 5 = 13. Canvex will add the answer back onto the page.
            </p>
            <input
              className="workspace-input"
              placeholder="Ask about this canvas..."
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  askCanvex()
                }
              }}
            />
            <button
              type="button"
              className="workspace-action-button w-full justify-center"
              onClick={askCanvex}
            >
              <Sparkles size={15} />
              Ask
            </button>
            <div className="space-y-2">
              {aiMessages.length === 0 ? (
                <p className="rounded-lg border border-dashed border-indigo-200 p-3 font-handwriting text-lg text-slate-500">
                  AI responses will appear here after Canvex reads your canvas.
                </p>
              ) : (
                aiMessages.map((message) => (
                  <article key={message.interactionId} className="rounded-lg border border-indigo-100 bg-white/70 p-3">
                    <p className="font-handwriting text-lg leading-6 text-slate-700">{message.content}</p>
                    <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                      <span>{message.triggerType}</span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="workspace-icon-button"
                          title="Helpful"
                          onClick={() => sendAIFeedback(message.interactionId, true)}
                        >
                          <ThumbsUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="workspace-icon-button"
                          title="Incorrect"
                          onClick={() => sendAIFeedback(message.interactionId, false)}
                        >
                          <ThumbsDown size={14} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}

export default CanvasBoard
