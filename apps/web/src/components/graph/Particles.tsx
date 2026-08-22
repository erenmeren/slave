'use client'

import { useEffect, useState } from 'react'
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
 * `offset-path` is read straight off that sibling `<path>`'s `d` string at the moment the portal
 * target resolves -- no separate path data, no drift between what the edge draws and what the
 * particle rides.
 *
 * **Unresolved particles render nothing** (fix-round-1, Important 3): an earlier version portaled
 * into a fallback layer while the real edge target was still being looked up, which meant a
 * particle whose retry budget exhausted (edge never found) rendered as a static, unpositioned dot
 * sitting at the canvas origin -- a stray blob conveying nothing, the opposite of spec §6's "density
 * under load is the information" point. `ParticleDot` now returns `null` until (and unless) it finds
 * its edge, and renders the circle -- with its `offset-path` already known, so no imperative DOM
 * mutation or second render is needed -- only once a real target exists.
 *
 * Known Risk 1 (task-8 brief): the portal target (`[data-testid="rf__edge-<id>"] path...`) does not
 * exist in jsdom for a component test that renders `<Particles>` in isolation (no real React Flow
 * tree mounted) -- every particle in that case renders nothing at all once its retries exhaust
 * (`graph-flow.test.tsx`'s `Particles` describe block pins exactly this). Proving "one motion-safe:
 * particle element per spawned particle" therefore now requires a real edge to portal into --
 * `graph-flow.test.tsx`'s `GraphClient` integration block mounts a real React Flow tree and proves
 * both the element mechanism and the real `offset-path` value together. The *portal into a real
 * edge visually follows the curve* half of that (as opposed to merely having the right `d` string)
 * is left to the milestone gate's by-eyes pass for final visual confirmation.
 */
export function Particles({ particles }: { readonly particles: readonly Particle[] }): React.JSX.Element | null {
  // fix-round-1, Important 2: `prefersReducedMotion()` reads `window.matchMedia`, which is `false`
  // during SSR (no `window`) regardless of the real client's preference -- calling it directly in
  // the render body meant the server always emitted the `<svg>` shell, and a reduced-motion client's
  // very first (hydration) render would call the real `matchMedia` and return `null` instead: a
  // hydration mismatch on exactly the a11y path. `mounted` starts `false` identically on the server
  // and the client's first render (neither ever calls `prefersReducedMotion()` before it flips), so
  // that first render can never diverge; only the *second*, effect-driven render -- client-only,
  // strictly after hydration has already reconciled -- is allowed to consult the real preference.
  //
  // This reads the preference once, on mount, not via a `matchMedia` change-event listener -- a
  // user who toggles their OS-level reduced-motion setting while this page stays open on screen
  // will not see this layer react until something else re-renders it (a new particle spawning) or
  // the page is revisited. A live listener would close that gap; not added here to keep this fix
  // scoped to the hydration bug it was asked to fix, noted for a future pass if that gap matters.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null
  // Spec §6: "under prefers-reduced-motion: no particles at all."
  if (prefersReducedMotion()) return null

  return (
    // `pointer-events-none`: this layer must never intercept a click/drag meant for the canvas
    // underneath. Positioned `absolute inset-0` over `GraphCanvas`'s own wrapper (its sibling in
    // `GraphClient.tsx`) -- every particle that resolves its edge portals away from here entirely,
    // so this element is otherwise empty in the steady state.
    <svg data-testid="particle-layer" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {particles.map((particle) => (
        <ParticleDot key={particle.id} particle={particle} />
      ))}
    </svg>
  )
}

/** How many times, and how far apart, `ParticleDot` retries finding its portal target before
 *  giving up (rendering nothing for that particle's whole remaining lifetime). Needed because React
 *  Flow measures each edge's handle bounds asynchronously (a `ResizeObserver` callback, at least one
 *  tick after the node/edge first mounts or re-renders -- the exact same "not measured yet" window
 *  the Task 5 report documents for *nodes*) -- a particle spawned in the same tick as its edge
 *  (re-)appearing can lose a one-shot lookup to that window. 5 × 20ms = 100ms of budget, comfortably
 *  inside the particle's own ~600ms lifetime and well under a real browser's single-frame
 *  measurement delay. */
const PORTAL_LOOKUP_ATTEMPTS = 5
const PORTAL_LOOKUP_RETRY_MS = 20

function ParticleDot({ particle }: { readonly particle: Particle }): React.JSX.Element | null {
  // Both the DOM node AND its `d` string are captured together, at the moment the lookup succeeds
  // -- the circle's `offset-path` is then known before it's ever rendered, so there's no separate
  // "mount unpositioned, then mutate" step (and nothing for a portal/reconciliation timing quirk to
  // discard -- see the file's own doc comment on the fiber-type-change bug an earlier version hit).
  const [target, setTarget] = useState<{ readonly element: Element; readonly d: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    let attempt = 0

    const tryFind = (): void => {
      if (cancelled) return
      const edgeGroup = document.querySelector(`[data-testid="rf__edge-${particle.edgeId}"]`)
      const path = edgeGroup?.querySelector('path.react-flow__edge-path')
      const d = path?.getAttribute('d')
      if (edgeGroup !== null && edgeGroup !== undefined && typeof d === 'string') {
        setTarget({ element: edgeGroup, d })
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

  // Unresolved (still retrying, or retries exhausted): render nothing rather than a meaningless,
  // unpositioned dot at the canvas origin (fix-round-1, Important 3) -- a stray static blob would
  // read as ambient motion happening nowhere in particular, which is worse than the particle simply
  // not appearing for its (rare, ~100ms-budget) unresolved window.
  if (target === null) return null

  return createPortal(
    <circle
      data-testid="particle"
      r={3}
      className="fill-status-working motion-safe:animate-[particle-travel_600ms_linear]"
      style={{ offsetPath: `path('${target.d}')` }}
    />,
    target.element,
  )
}
