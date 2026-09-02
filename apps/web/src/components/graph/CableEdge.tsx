'use client'

import { getBezierPath, type EdgeProps, type EdgeTypes } from 'reactflow'
import type { StatusTone } from '../ui/StatusPill'

/** The tone whose colour the cable is drawn in, plus whether it animates. Set by
 *  `buildOrgGraph`/`buildDepsGraph`/`buildExecutionGraph` on each edge's `data`. */
export interface CableEdgeData {
  readonly tone: StatusTone
  /** `false` renders the inactive cable: 3px, `rgba(255,255,255,.13)`, no dash, no halo. */
  readonly active: boolean
  /** The raw succession count behind this cable (M19 C3) — absent keeps today's flat literals.
   *  Only the aggregate skill graph builder stamps this (`SkillNodes.tsx`'s `buildSkillAggregateGraph`);
   *  the chain/focus builder and every other edge kind stay weightless by construction. See `widthFor`. */
  readonly weight?: number
}

/**
 * The tone's solid colour, as a CSS variable reference — the same `@theme inline` names every
 * other consumer uses, so a token change reaches the cable for free. Literal per tone, never
 * interpolated: an SVG `stroke` is not a Tailwind class, but the same "one table, no runtime
 * string assembly" rule keeps this readable beside `TONE_DOT`.
 */
const TONE_STROKE: Record<StatusTone, string> = {
  working: 'var(--color-tone-working)',
  planning: 'var(--color-tone-planning)',
  review: 'var(--color-tone-review)',
  waiting: 'var(--color-tone-waiting)',
  blocked: 'var(--color-tone-blocked)',
  done: 'var(--color-tone-done)',
  paused: 'var(--color-tone-paused)',
  idle: 'var(--color-tone-idle)',
}

/** The inactive cable's flat hairline (design README "1b — Cables"). A literal rgba rather than a
 *  token: it is a structural line, not a status, and no `--color-*` variable carries this value. */
const INACTIVE_STROKE = 'rgba(255,255,255,.13)'

/** The `<filter>` id the halo references. One id shared by every cable on the page: the filter is
 *  identical for all of them, and duplicate ids for an identical definition resolve to the first,
 *  which is the same filter. See the component doc for why it is not hoisted to a shared defs
 *  layer instead. */
const GLOW_FILTER_ID = 'cable-glow'

/**
 * React Flow's own invisible hit target, reproduced verbatim from its `BaseEdge`
 * (`@reactflow/core/dist/esm/index.js`: `strokeWidth={20} strokeOpacity={0}`).
 *
 * Every deps edge used to get one for free, because an edge with no `type` renders as React Flow's
 * default bezier -- which is a `BaseEdge`. A custom edge component replaces that markup wholesale,
 * so this has to be drawn here or it is gone: `.react-flow__edge`'s `pointer-events: visibleStroke`
 * would leave "select an edge, press Delete" (spec §4.5, `DepsMode`'s shipped behaviour) aiming at
 * the 1.4px core -- 3px for the inactive edge a dependency IS until its prerequisite is done.
 *
 * It deliberately does NOT carry `react-flow__edge-path`: `Particles.tsx:104` does a single
 * `querySelector` for that class and must keep resolving to exactly one node, the core.
 */
const HIT_PATH_WIDTH = '20'

/**
 * The core's width as traffic, not just state (M19 C3): a `weight` (an edge's raw succession
 * count) scales the line 1.4px/3px..3.8px/4.5px, clamped so one very hot edge cannot swamp the
 * canvas. `weight` is `undefined` for every edge kind except the aggregate skill graph's own
 * (`buildSkillAggregateGraph`) — those keep today's flat literals, unclamped and unscaled.
 */
function widthFor(weight: number | undefined, active: boolean): string {
  // A non-finite weight (a corrupt count) gets the default, never the string "NaN" as a stroke-width (M21 C4).
  if (weight === undefined || !Number.isFinite(weight)) return active ? '1.4' : '3'
  const raw = active ? 1.4 + 0.6 * (weight - 1) : 3 + 0.5 * (weight - 1)
  const clamped = active ? Math.min(Math.max(raw, 1.4), 3.8) : Math.min(Math.max(raw, 3), 4.5)
  // Rounded to 2dp so e.g. weight 4/active doesn't hand SVG a `3.1999999999999997` float-noise
  // string -- the clamp's own math is unaffected, this only tidies the printed attribute/style.
  return String(Math.round(clamped * 100) / 100)
}

/**
 * The design README's signature cable ("1b — Cables"), as a React Flow custom edge: three stacked
 * paths in ONE `<g>` — a 5px blurred halo (`feGaussianBlur stdDeviation=4`, opacity .18) in the
 * TARGET's status colour, a 1.4px solid core, and a 1.6px white dashed overlay
 * (`stroke-dasharray: 5 11`) animated to `stroke-dashoffset: -32` over 1.15s linear infinite
 * (`globals.css`'s `dash` keyframe, reached through `motion-safe:` so reduced motion kills the
 * travel and leaves a static dashed line). Inactive edges are a single flat 3px
 * `rgba(255,255,255,.13)` line with no halo and no animation.
 *
 * **Coexistence with `Particles.tsx`** (which is NOT modified by this task): that component
 * portals a `<circle>` into the `<g data-testid="rf__edge-<id>">` React Flow wraps this in, and
 * reads its `offset-path` off `path.react-flow__edge-path`'s `d` attribute
 * (`Particles.tsx:103-107`). Exactly ONE path here carries that class — the core — so the
 * `querySelector` still resolves to a single node and the particle rides the same bezier the cable
 * draws. The halo and the flow overlay carry `data-cable` instead, and the hit path below carries
 * React Flow's own `react-flow__edge-interaction`.
 *
 * The filter `<defs>` is emitted per active edge rather than hoisted to a shared defs layer:
 * React Flow gives an edge component no place to render outside its own `<g>`, and duplicate ids
 * for an identical filter resolve to the first — the same filter. Cheap, and it keeps this file
 * self-contained.
 */
export function CableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<CableEdgeData>): React.JSX.Element {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  // An edge that reaches here with no `data` at all (a caller that forgot to stamp it) is drawn as
  // structure, not traffic — never as an `undefined` stroke, which paints black.
  const active = data?.active ?? false
  const tint = active ? TONE_STROKE[data?.tone ?? 'idle'] : INACTIVE_STROKE

  // Selection is React Flow's own affordance and `DepsMode`'s "select an edge, press Delete"
  // depends on seeing it. Its stylesheet paints a selected edge `#555` via
  // `.react-flow__edge.selected .react-flow__edge-path` — a rule the inline style below
  // deliberately outranks, so the cue is re-drawn here instead: white, and thicker.
  const coreStroke = selected === true ? '#ffffff' : tint
  const coreWidth = selected === true ? '2.5' : widthFor(data?.weight, active)

  /**
   * The core's paint, as an INLINE STYLE as well as attributes. React Flow's own stylesheet carries
   * `.react-flow__edge-path { stroke: #b1b1b7; stroke-width: 1 }`, and a CSS rule outranks a
   * presentation attribute — so the attributes alone would render every cable as React Flow's grey
   * hairline. Both are written from the same two variables, so they cannot drift: the attributes
   * are the readable, assertable statement of what this path is; the inline style is what actually
   * wins the cascade. (Keyframes still outrank inline styles, which is why `globals.css`'s
   * `edge-flash` completion wave keeps working on this same path.)
   */
  const coreStyle = { stroke: coreStroke, strokeWidth: coreWidth }

  if (!active) {
    return (
      <g data-testid="cable-edge" data-edge-id={id} data-active="false">
        <path
          className="react-flow__edge-path"
          d={path}
          fill="none"
          stroke={coreStroke}
          strokeWidth={coreWidth}
          style={coreStyle}
        />
        <path className="react-flow__edge-interaction" d={path} fill="none" strokeOpacity="0" strokeWidth={HIT_PATH_WIDTH} />
      </g>
    )
  }

  return (
    <g data-testid="cable-edge" data-edge-id={id} data-active="true">
      <defs>
        {/* `x/y/width/height` widen the filter region past the stroke's own box so a 4px blur is
          * not clipped at the path's bounding edges. */}
        <filter id={GLOW_FILTER_ID} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <path
        data-cable="halo"
        d={path}
        fill="none"
        stroke={tint}
        strokeWidth="5"
        strokeLinecap="round"
        opacity="0.18"
        filter={`url(#${GLOW_FILTER_ID})`}
      />
      {/* The ONE path carrying `react-flow__edge-path` — `Particles.tsx` reads its `d`. */}
      <path
        className="react-flow__edge-path"
        d={path}
        fill="none"
        stroke={coreStroke}
        strokeWidth={coreWidth}
        opacity="0.95"
        style={coreStyle}
      />
      <path className="react-flow__edge-interaction" d={path} fill="none" strokeOpacity="0" strokeWidth={HIT_PATH_WIDTH} />
      <path
        data-cable="flow"
        className="motion-safe:animate-[dash_1.15s_linear_infinite]"
        d={path}
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="5 11"
        opacity="0.75"
      />
    </g>
  )
}

/** The one registration every `GraphCanvas` gets by default — `cable` is the only custom edge
 *  type this app has, and every builder stamps `type: 'cable'`. */
export const CABLE_EDGE_TYPES: EdgeTypes = { cable: CableEdge } as EdgeTypes
