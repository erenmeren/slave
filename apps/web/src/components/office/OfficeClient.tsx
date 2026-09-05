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
  // Read inside the rebuild effect below without adding `overview` to its deps (R10) — the
  // rebuild fires on a roster change, not on every stream tick, and always wants the *current*
  // snapshot, not the one from whenever the roster last changed. Kept current every render, not
  // in its own effect, so it is already fresh by the time the rebuild effect below runs.
  const overviewRef = useRef(overview)
  overviewRef.current = overview
  // A camera carried across a rebuild (R9): `renderIsoE` sizes a *new* `view` from the new
  // world's own floor dimensions the first time it sees one missing, so copying the old `view`
  // object wholesale would carry stale `w`/`h` (and `autofit`'s fit) onto a floor of a different
  // size. This ref holds just `{ li, ox, oy }` until the loop below has let the engine build the
  // new view, then applies them onto it and clears the ref.
  const pendingCameraRef = useRef<{ li: number; ox: number; oy: number } | null>(null)
  const [, setFrame] = useState(0)
  const rosterKey = useMemo(() => JSON.stringify(initial.departments), [initial.departments])

  // Build (and rebuild on a roster change), carrying the camera and the focus over.
  useEffect(() => {
    const previous = worldRef.current
    const world = new LiveOffice(initial.departments)
    if (previous !== null) {
      if (previous.view !== undefined) pendingCameraRef.current = { li: previous.view.li, ox: previous.view.ox, oy: previous.view.oy }
      world.hourLock = previous.hourLock
      if (previous.focusId !== null && world.slaves.some((s) => s.id === previous.focusId)) world.focusId = previous.focusId
    }
    // R10: a rebuilt world otherwise runs idle (every slave's live status blank) until the next
    // stream tick — the effect below keys on `overview`, whose identity does not change just
    // because the roster did. Seed it here with the snapshot already in hand.
    // R16: seed the clock too. The loop below only starts once the pixel font has loaded, and the
    // engine's own `hour` starts at 09:00 — without this the HUD reads 09:00 (and the wrong
    // time-of-day label) for the whole font-load window. `tick` keeps it current every frame after.
    world.setWallClock(wallHour())
    world.apply(liveSlavesOf(overviewRef.current), boardFromOverview(overviewRef.current))
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
    // R16: a tick or a render that throws throws every frame (60 times a second) — log the first
    // one and stay quiet after it, so one broken frame does not bury the console it landed in.
    let reported = false
    const report = (error: unknown): void => {
      if (reported) return
      reported = true
      console.error(error)
    }
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
          report(error)
        }
        const ctx = canvas.getContext('2d')
        if (ctx !== null) {
          try {
            renderIsoE(ctx, world, { viewKey: 'view', tod: true, fun: true, autofit: true, deptSigns: 'banner' })
          } catch (error) {
            report(error)
          }
        }
        // R9: apply a carried camera once the (possibly just-rebuilt) world actually has a view
        // to apply it onto — `renderIsoE` is what creates one (with fresh `w`/`h`/`levels` for
        // this world's own floor), so this has to wait for that, not run inside the rebuild effect.
        const pending = pendingCameraRef.current
        const v = world.view
        if (pending !== null && v?.levels !== undefined) {
          v.li = Math.min(pending.li, v.levels.length - 1)
          v.S = v.levels[v.li] as number
          v.ox = pending.ox
          v.oy = pending.oy
          pendingCameraRef.current = null
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
    // Canvas text asks for the pixel font by family; wait for it so the first frame is not
    // monospace. R16: `document.fonts` is optional (older browsers, and a jsdom without the
    // FontFace shim) — without a font set to wait on, start the loop right away rather than
    // throwing on `undefined.load` and never drawing at all.
    const fonts: FontFaceSet | undefined = document.fonts
    if (fonts === undefined) start()
    else fonts.load(`9px ${pixelFontFamily}`).then(start, start)
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
    // R16: before the build effect has run there is no world, and the roster the server already
    // sent is the honest answer for both counts — a first paint of "0 slaves" contradicts the
    // floor the very next frame draws.
    slaves: world?.slaves.length ?? initial.departments.reduce((n, d) => n + d.slaves.length, 0),
    // R12: `working` is the stream's status, not the sprite's state. `world.status(s)` reads the
    // floor — a live-working slave still walking back from the arcade, or a `starting` one walking
    // to the board, is not in state `work` — so counting sprites left the HUD disagreeing with the
    // Overview tab for the length of every walk.
    working: world === null ? 0 : world.slaves.filter((s) => world.liveOf(s.id)?.status === 'working').length,
    todLabel: world === null ? '' : tod(world.hour).label.toUpperCase(),
    clock: world?.clock() ?? '--:--',
    // R11: the slider's own lock, when set, wins over the world's clock straight away — reading
    // `world.hour` unconditionally left the controlled range fighting the pointer, snapping back
    // to the old value until the next 250 ms repaint caught up with the lock it had just set.
    hour: world === null ? 9 : (world.hourLock ?? Math.round(world.hour * 4) / 4),
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
    <div ref={wrapRef} className="relative h-[calc(100vh-52px-41px)] min-h-[360px] w-full overflow-hidden bg-[#07080b]">
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
