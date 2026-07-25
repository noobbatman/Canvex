import { Canvas } from 'fabric'
import { useCallback, useEffect, useRef, useState } from 'react'

import { getSharedPage } from '../lib/api'
import { makeReadOnlyObject, type ReadOnlyCanvasObject } from '../lib/fabricElements'
import type { Element } from '../types'

type SharedCanvasObject = ReadOnlyCanvasObject

type SharedPageViewerProps = {
  token: string
}

const SharedPageViewer = ({ token }: SharedPageViewerProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fabricRef = useRef<Canvas | null>(null)
  const objectsById = useRef<Map<string, SharedCanvasObject>>(new Map())
  const [title, setTitle] = useState<string>('')
  const [pageId, setPageId] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const addElement = useCallback((element: Element) => {
    const canvas = fabricRef.current
    if (!canvas || element.is_deleted) return
    const existing = objectsById.current.get(element.id)
    if (existing) {
      canvas.remove(existing)
      objectsById.current.delete(element.id)
    }
    const obj = makeReadOnlyObject(element)
    if (!obj) return
    obj.elementId = element.id
    canvas.add(obj)
    objectsById.current.set(element.id, obj)
    canvas.requestRenderAll()
  }, [])

  const removeElement = useCallback((elementId: string) => {
    const canvas = fabricRef.current
    const obj = objectsById.current.get(elementId)
    if (!canvas || !obj) return
    canvas.remove(obj)
    objectsById.current.delete(elementId)
    canvas.requestRenderAll()
  }, [])

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return
    const canvas = new Canvas(canvasRef.current, {
      backgroundColor: 'rgba(245, 244, 236, 1)',
      selection: false,
    })
    fabricRef.current = canvas
    const objectsMap = objectsById.current

    const resize = () => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      canvas.setDimensions({ width: rect.width, height: rect.height })
      canvas.requestRenderAll()
    }
    resize()
    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
      objectsMap.clear()
      canvas.dispose()
      fabricRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setStatus('loading')
      try {
        const shared = await getSharedPage(token)
        if (cancelled) return
        setTitle(shared.page.title)
        setPageId(shared.page.id)
        shared.elements.forEach(addElement)
        setStatus('ready')
      } catch {
        if (!cancelled) {
          setStatus('error')
          setErrorMessage('This share link is invalid or has expired.')
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [token, addElement])

  useEffect(() => {
    if (status !== 'ready' || !pageId) return

    const pageUrl = new URL(`/ws/${pageId}`, import.meta.env.VITE_API_URL ?? 'http://localhost:8000')
    pageUrl.protocol = pageUrl.protocol.replace('http', 'ws')
    pageUrl.searchParams.set('share_token', token)
    const socket = new WebSocket(pageUrl.toString())
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'element:op' || message.type === 'ai:response') {
          const payload = message.type === 'ai:response' ? message.payload.element : message.payload
          const operation = message.type === 'ai:response' ? 'create' : message.operation
          if (operation === 'delete') {
            removeElement(payload.id)
          } else {
            addElement(payload as Element)
          }
        }
      } catch {
        // ignore malformed messages
      }
    }

    return () => {
      socket.close()
    }
  }, [status, pageId, token, addElement, removeElement])

  return (
    <div className="flex h-screen flex-col bg-[#faf9f4]">
      <header className="flex items-center justify-between border-b border-slate-200 px-6 py-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Read-only view</p>
          <h1 className="font-reading-serif text-xl text-slate-950">{title || 'Shared Canvex page'}</h1>
        </div>
        <span className="workspace-chip">VIEW ONLY</span>
      </header>
      <div ref={containerRef} className="relative flex-1">
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-rose-600">
            {errorMessage}
          </div>
        )}
        {status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
            Loading shared page…
          </div>
        )}
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}

export default SharedPageViewer
