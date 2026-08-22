'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { prefersReducedMotion, type Particle } from './flow'

/**
 * One SVG circle per live particle, animated along its edge's own rendered path (spec §6: "hand-
 * rolled SVG circle on an `offset-path` animation -- no library"). `GraphClient.tsx` owns the
 * particle list (spawn-on-frame, sweep-on-tick); this component is purely presentational -- it
 * never spawns, expires, or caps anything itself.
 *
 * **Path-animation approach**: rather than maintaining a second, independently-transformed SVG
 * overlay that would have to track React Flow's own pan/zoom viewport transform in lockstep (a
 * second source of truth for a value React Flow already owns), each particle's `<circle>` is
 * portaled (`createPortal`) directly into the wrapping `<g data-testid="rf__edge-<id>">` React Flow
 * itself renders for that edge, right alongside its `<path class="react-flow__edge-path">`. A
 * portaled node lives in that `<g>`'s DOM subtree, so it inherits the exact same pan/zoom transform
 * as the edge it's traveling along, for free, with no coordinate math of our own. The circle's own
 * `offset-path` is set (an effect keyed on the resolved target) to the *same* `d` string read
 * straight off that sibling `<path>` -- no separate path data, no drift between what the edge draws
 * and what the particle rides.
 *
 * `ParticleDot` always renders via `createPortal` -- even before a real edge target is found, it
 * portals into `Particles`' own `<svg>` layer (the `fallback` prop) rather than switching between
 * "portal" and "plain inline child" across renders. Portaling into a *different* container on a
 * later render is a container-only change for React's reconciler (the same portal fiber, same
 * `<circle>` child type/key -- it moves the existing DOM node); switching between a portal and a
 * plain child is a fiber-type change, which unmounts and remounts the DOM node instead -- discarding
 * the very `ref` an earlier attempt (see git history) mutated directly, so the offset-path it set
 * never survived onto the node that actually ends up inside the edge.
 *
 * Known Risk 1 (task-8 brief): the portal target (`[data-testid="rf__edge-<id>"] path...`) does not
 * exist in jsdom for a component test that renders `<Particles>` in isolation (no real React Flow
 * tree mounted) -- every particle in that case just portals into the `fallback` layer forever
 * (retried a few times, then gives up), which is exactly the mechanism -- element count,
 * `motion-safe:` class -- Known Risk 1 says to assert when the real portal target can't be proven in
 * jsdom. The *portal into a real edge* / *offset-path visually follows the curve* half of this is
 * proven concretely by `graph-flow.test.tsx`'s `GraphClient` integration block (a real React Flow
 * tree, real edge DOM) and left to the milestone gate's by-eyes pass for final visual confirmation.
 */
export function Particles({ particles }: { readonly particles: readonly Particle[] }): React.JSX.Element | null {
  // A callback ref (not `useRef` read in an effect): fires synchronously during commit, so the very
  // first render that has ANY particle to place also already has a valid fallback portal target --
  // no "first paint has nowhere to portal into yet" gap for `ParticleDot` to special-case.
  const [layer, setLayer] = useState<SVGSVGElement | null>(null)

  // Spec §6: "under prefers-reduced-motion: no particles at all" -- checked here too (not only at
  // the spawn site in `GraphClient.tsx`) so the layer renders nothing even if a particle is somehow
  // already in state when the preference is read (e.g. it changed mid-session).
  if (prefersReducedMotion()) return null

  return (
    // `pointer-events-none`: this layer must never intercept a click/drag meant for the canvas
    // underneath. Positioned `absolute inset-0` over `GraphCanvas`'s own wrapper (its sibling in
    // `GraphClient.tsx`) purely so a particle whose portal target hasn't resolved yet (see
    // `ParticleDot`) has a valid `<svg>` parent to portal into, rather than sitting in plain HTML --
    // every particle that *does* find its edge moves away from here entirely, into that edge's own
    // `<g>`, so this element is otherwise empty in the steady state.
    <svg ref={setLayer} data-testid="particle-layer" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {layer !== null && particles.map((particle) => <ParticleDot key={particle.id} particle={particle} fallback={layer} />)}
    </svg>
  )
}

/** How many times, and how far apart, `ParticleDot` retries finding its portal target before
 *  giving up and staying on the fallback layer for its whole lifetime. Needed because React Flow
 *  measures each edge's handle bounds asynchronously (a `ResizeObserver` callback, at least one
 *  tick after the node/edge first mounts or re-renders -- the exact same "not measured yet" window
 *  the Task 5 report documents for *nodes*) -- a particle spawned in the same tick as its edge
 *  (re-)appearing can lose a one-shot lookup to that window. 5 × 20ms = 100ms of budget, comfortably
 *  inside the particle's own ~600ms lifetime and well under a real browser's single-frame
 *  measurement delay. */
const PORTAL_LOOKUP_ATTEMPTS = 5
const PORTAL_LOOKUP_RETRY_MS = 20

function ParticleDot({ particle, fallback }: { readonly particle: Particle; readonly fallback: Element }): React.JSX.Element {
  const circleRef = useRef<SVGCircleElement>(null)
  const [target, setTarget] = useState<Element | null>(null)

  // Retry-find the edge's own DOM group (see `PORTAL_LOOKUP_ATTEMPTS`'s doc comment). Only sets
  // `target`; the actual `offset-path` write happens in the effect below, keyed on `target`, so it
  // always runs against whichever DOM node the `ref` is *currently* attached to.
  useEffect(() => {
    let cancelled = false
    let attempt = 0

    const tryFind = (): void => {
      if (cancelled) return
      const edgeGroup = document.querySelector(`[data-testid="rf__edge-${particle.edgeId}"]`)
      if (edgeGroup !== null) {
        setTarget(edgeGroup)
        return
      }
      attempt += 1
      if (attempt < PORTAL_LOOKUP_ATTEMPTS) setTimeout(tryFind, PORTAL_LOOKUP_RETRY_MS)
    }

    tryFind()
    return () => {
      cancelled = true
    }
  }, [particle.edgeId])

  // Applies `offset-path` once the real edge target resolves, reading its `d` fresh off the
  // sibling `<path>` at that moment -- runs *after* the portal has already moved the circle into
  // `target` (this effect's own dependency, `target`, changing is what schedules that render), so
  // `circleRef.current` is guaranteed to be the node that's actually inside the edge by the time
  // this runs.
  useEffect(() => {
    if (target === null || circleRef.current === null) return
    const path = target.querySelector('path.react-flow__edge-path')
    const d = path?.getAttribute('d')
    if (typeof d === 'string') circleRef.current.style.setProperty('offset-path', `path('${d}')`)
  }, [target])

  const circle = (
    <circle ref={circleRef} data-testid="particle" r={3} className="fill-status-working motion-safe:animate-[particle-travel_600ms_linear]" />
  )
  return createPortal(circle, target ?? fallback)
}
