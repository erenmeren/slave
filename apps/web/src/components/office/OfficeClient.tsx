'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOverview } from '../../hooks/useOverview'
import { STATUS, renderIsoE, setPixelFont, tod } from '../../lib/office/engine.js'
import { LiveOffice, boardFromOverview, liveSlavesOf } from '../../lib/office/liveOffice'
import { sendControl } from '../../lib/postControl'
import type { OfficeSnapshot } from '../../server/office'
import { FocusCard, type FocusView } from './FocusCard'
import { OfficeHud, type HudView } from './OfficeHud'

/** The overlays repaint this often (the design's cadence); the canvas repaints every frame. */
const OVERLAY_MS = 250

function wallHour(now = new Date()): number {
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600
}

/**
 * The Office tab (M28 §5): the vendored pixel office on a canvas, a `LiveOffice` fed by the overview
 * stream, the design's zoom / pan / click-to-focus, and the two overlays. The world is rebuilt when
 * the roster changes (a new server snapshot with different departments or slaves), keeping the
 * camera and the focused slave; the loop stops while the tab is hidden and on unmount.
 */
export function OfficeClient({
  workspaceId,
  initial,
  pixelFontFamily,
}: {
  readonly workspaceId: string
  readonly initial: OfficeSnapshot
  readonly pixelFontFamily: string
}): React.JSX.Element {
  const { snapshot, connection } = useOverview(workspaceId, initial.overview)
  const overview = snapshot ?? initial.overview
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const worldRef = useRef<LiveOffice | null>(null)
  const [frame, setFrame] = useState(0)
  const rosterKey = useMemo(() => JSON.stringify(initial.departments), [initial.departments])

  // Build (and rebuild on a roster change), carrying the camera and the focus over.
  useEffect(() => {
    const previous = worldRef.current
    const world = new LiveOffice(initial.departments)
    if (previous !== null) {
      if (previous.view !== undefined) world.view = { ...previous.view }
      world.hourLock = previous.hourLock
      if (previous.focusId !== null && world.slaves.some((s) => s.id === previous.focusId)) world.focusId = previous.focusId
    }
    worldRef.current = world
    setFrame((f) => f + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the roster's identity
  }, [rosterKey])

  // Every stream snapshot lands on the floor.
  useEffect(() => {
    worldRef.current?.apply(liveSlavesOf(overview), boardFromOverview(overview))
  }, [overview])

  // The loop: size, tick, render; the overlays every OVERLAY_MS.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (canvas === null || wrap === null) return
    setPixelFont(pixelFontFamily)
    let raf = 0
    let last = performance.now()
    let acc = 0
    let stopped = false
    const size = (): void => {
      const r = wrap.getBoundingClientRect()
      const w = Math.max(200, Math.round(r.width))
      const h = Math.max(160, Math.round(r.height))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    }
    size()
    const observer = new ResizeObserver(size)
    observer.observe(wrap)
    const loop = (now: number): void => {
      if (stopped) return
      const world = worldRef.current
      if (world !== null && !document.hidden) {
        const dt = Math.min(0.05, (now - last) / 1000)
        world.setWallClock(wallHour())
        try {
          world.tick(dt)
        } catch (error) {
          console.error(error)
        }
        const ctx = canvas.getContext('2d')
        if (ctx !== null) {
          try {
            renderIsoE(ctx, world, { viewKey: 'view', tod: true, fun: true, autofit: true, deptSigns: 'banner' })
          } catch (error) {
            console.error(error)
          }
        }
        acc += now - last
        if (acc > OVERLAY_MS) {
          acc = 0
          setFrame((f) => f + 1)
        }
      }
      last = now
      raf = requestAnimationFrame(loop)
    }
    const start = (): void => {
      raf = requestAnimationFrame(loop)
    }
    // Canvas text asks for the pixel font by family; wait for it so the first frame is not monospace.
    document.fonts.load(`9px ${pixelFontFamily}`).then(start, start)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [pixelFontFamily])

  // Zoom / pan / click-to-focus, as the design wires them.
  const zoom = useCallback((dir: 1 | -1, mx?: number, my?: number): void => {
    const world = worldRef.current
    const canvas = canvasRef.current
    const v = world?.view
    if (world === null || canvas === null || v === undefined) return
    const ni = Math.max(0, Math.min(v.levels.length - 1, v.li + dir))
    if (ni === v.li) return
    const cx = mx ?? canvas.width / 2
    const cy = my ?? canvas.height / 2
    const nS = v.levels[ni] as number
    v.ox = Math.round(cx - ((cx - v.ox) * nS) / v.S)
    v.oy = Math.round(cy - ((cy - v.oy) * nS) / v.S)
    v.S = nS
    v.li = ni
    setFrame((f) => f + 1)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const point = (event: MouseEvent): [number, number] => {
      const r = canvas.getBoundingClientRect()
      return [((event.clientX - r.left) * canvas.width) / r.width, ((event.clientY - r.top) * canvas.height) / r.height]
    }
    let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const [mx, my] = point(event)
      zoom(event.deltaY < 0 ? 1 : -1, mx, my)
    }
    const onDown = (event: MouseEvent): void => {
      const v = worldRef.current?.view
      if (v === undefined) return
      event.preventDefault()
      drag = { x: event.clientX, y: event.clientY, ox: v.ox, oy: v.oy, moved: false }
      canvas.style.cursor = 'grabbing'
    }
    const onMove = (event: MouseEvent): void => {
      const v = worldRef.current?.view
      if (drag === null || v === undefined) return
      const r = canvas.getBoundingClientRect()
      const k = canvas.width / r.width
      const dx = (event.clientX - drag.x) * k
      const dy = (event.clientY - drag.y) * k
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      v.ox = Math.round(drag.ox + dx)
      v.oy = Math.round(drag.oy + dy)
    }
    const onUp = (event: MouseEvent): void => {
      if (drag === null) return
      canvas.style.cursor = 'grab'
      const world = worldRef.current
      if (!drag.moved && world !== null) {
        const [x, y] = point(event)
        const hit = (world.viewHits ?? []).find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h)
        if (hit !== undefined) {
          world.focusId = hit.id
          setFrame((f) => f + 1)
        }
      }
      drag = null
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [zoom])

  const world = worldRef.current
  const hud: HudView = {
    connection,
    departments: world?.departments.length ?? initial.departments.length,
    slaves: world?.slaves.length ?? 0,
    working: world?.slaves.filter((s) => world.status(s) === 'working').length ?? 0,
    todLabel: world === null ? '' : tod(world.hour).label.toUpperCase(),
    clock: world?.clock() ?? '--:--',
    hour: world === null ? 9 : Math.round(world.hour * 4) / 4,
    live: world === null || world.hourLock === null,
    zoom: `${(world?.view?.li ?? 0) + 1}x`,
  }
  const focused = world === null ? null : (world.slaves.find((s) => s.id === world.focusId) ?? world.slaves[0] ?? null)
  const focus: FocusView | null =
    world === null || focused === null || focused === undefined
      ? null
      : (() => {
          const live = world.liveOf(focused.id)
          const status = live?.status ?? 'idle'
          const statusColor = STATUS[world.status(focused)]
          return {
            id: focused.id,
            name: focused.name,
            role: focused.role,
            department: world.departments[focused.dept]?.name ?? '',
            color: focused.color,
            status,
            statusColor,
            taskKey: focused.task?.key ?? '',
            taskTitle: focused.task?.title ?? '—',
            pct: Math.round(focused.progress),
            runId: live?.runId ?? null,
          }
        })()

  return (
    <div ref={wrapRef} data-frame={frame} className="relative h-[calc(100vh-52px-41px)] min-h-[360px] w-full overflow-hidden bg-[#07080b]">
      <canvas ref={canvasRef} data-testid="office-canvas" className="block h-full w-full cursor-grab" />
      <OfficeHud
        view={hud}
        onHour={(hour) => {
          if (worldRef.current !== null) worldRef.current.hourLock = hour
          setFrame((f) => f + 1)
        }}
        onLive={() => {
          if (worldRef.current !== null) worldRef.current.hourLock = null
          setFrame((f) => f + 1)
        }}
        onZoom={(dir) => zoom(dir)}
      />
      {focus !== null && (
        <FocusCard
          key={focus.id}
          view={focus}
          archived={initial.workspace.archived}
          onRun={(runId, action) => sendControl(`/api/w/${workspaceId}/runs/${runId}/${action}`, { method: 'POST' })}
          onNext={() => {
            const w = worldRef.current
            if (w === null || w.slaves.length === 0) return
            // `world.focusId` is null until something explicitly sets it (the render below falls
            // back to the first slave) — `findIndex` then returns -1, and a bare `i + 1` would
            // land back on index 0, the very slave already on screen. Treat "not found" as "before
            // the first" so the first click always advances.
            const found = w.slaves.findIndex((s) => s.id === w.focusId)
            const i = found === -1 ? 0 : found
            w.focusId = (w.slaves[(i + 1) % w.slaves.length] as { id: string }).id
            setFrame((f) => f + 1)
          }}
        />
      )}
    </div>
  )
}
