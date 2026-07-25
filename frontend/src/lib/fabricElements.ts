import { Ellipse, FabricImage, FabricObject, Line, Polyline, Rect, Textbox } from 'fabric'

import type { Element } from '../types'

export type ReadOnlyCanvasObject = FabricObject & { elementId?: string }

const DEFAULT_RECT = { width: 140, height: 90 }
const DEFAULT_ELLIPSE = { rx: 60, ry: 40 }

// Builds a non-interactive Fabric object from a stored element. Used by the
// read-only surfaces (share-link viewer, session replay player) — the live
// CanvasBoard has its own interactive object factory.
export const makeReadOnlyObject = (element: Element): ReadOnlyCanvasObject | null => {
  const base = {
    left: element.transform.x,
    top: element.transform.y,
    scaleX: element.transform.scaleX,
    scaleY: element.transform.scaleY,
    angle: element.transform.rotation,
    stroke: element.style.stroke ?? '#111827',
    strokeWidth: element.style.strokeWidth ?? 2,
    fill: element.style.fill ?? 'transparent',
    selectable: false,
    evented: false,
  }

  switch (element.type) {
    case 'rect': {
      const width = Number(element.content.width ?? DEFAULT_RECT.width)
      const height = Number(element.content.height ?? DEFAULT_RECT.height)
      return new Rect({ ...base, width, height }) as ReadOnlyCanvasObject
    }
    case 'ellipse': {
      const rx = Number(element.content.rx ?? DEFAULT_ELLIPSE.rx)
      const ry = Number(element.content.ry ?? DEFAULT_ELLIPSE.ry)
      return new Ellipse({ ...base, rx, ry }) as ReadOnlyCanvasObject
    }
    case 'text':
    case 'math':
    case 'sticky': {
      const text = String(element.content.text ?? '')
      const backgroundColor = String(
        element.content.backgroundColor ?? (element.type === 'sticky' ? '#fef3c7' : ''),
      )
      return new Textbox(text, {
        ...base,
        width: Number(element.content.width ?? 240),
        fontSize: Number(element.content.fontSize ?? 20),
        fill: element.style.fill ?? '#0f172a',
        backgroundColor,
        padding: element.type === 'sticky' ? 12 : 0,
      }) as ReadOnlyCanvasObject
    }
    case 'stroke': {
      const rawPoints = (element.content.points as Array<{ x: number; y: number } | number[]>) ?? []
      const points = rawPoints.map((point) =>
        Array.isArray(point) ? { x: point[0] ?? 0, y: point[1] ?? 0 } : point,
      )
      return new Polyline(points, { ...base, fill: 'transparent' }) as ReadOnlyCanvasObject
    }
    case 'arrow': {
      const points = (element.content.points as number[]) ?? [0, 0, 120, 0]
      return new Line(
        [points[0] ?? 0, points[1] ?? 0, points[2] ?? 120, points[3] ?? 0],
        { ...base, fill: 'transparent' },
      ) as ReadOnlyCanvasObject
    }
    case 'image': {
      const url = String(element.content.url ?? '')
      if (!url) return null
      const width = Number(element.content.width ?? 240)
      const height = Number(element.content.height ?? 180)
      const imgEl = document.createElement('img')
      imgEl.crossOrigin = 'anonymous'
      const image = new FabricImage(imgEl, { ...base, width, height }) as ReadOnlyCanvasObject
      // The bitmap arrives async — repaint whatever canvas holds it by then.
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
}
