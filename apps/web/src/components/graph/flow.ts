import type { Edge } from 'reactflow'

/**
 * Flow visualization's pure state (spec §6): particle spawn/cap/expire, plus the small pure
 * helpers `GraphClient.tsx`/`DepsMode.tsx` drive from live data (tool-call frames, a status-change
 * script). Kept dependency-free of React on purpose -- every function here takes its inputs
 * explicitly (a particle list, an edge list, `now`) and returns a new value, so the mechanism is
 * testable without rendering anything (the brief's Step 1 requirement, and Known Risk 1's fallback
 * position if the *visual* path-following turns out to be jsdom-untestable -- see `Particles.tsx`).
 */

// ---- particles --------------------------------------------------------------------------------

export interface Particle {
  readonly id: string
  readonly edgeId: string
  /** `now + PARTICLE_LIFETIME_MS` at spawn time -- expiry is a plain timestamp comparison, not a
   *  countdown, so a sweep never needs to know how long ago a particle spawned. */
  readonly expiresAt: number
}

/** ~600ms lifetime (spec §6). */
export const PARTICLE_LIFETIME_MS = 600

/** Per-edge concurrent cap (spec §6's flood guard): a 6th `run.tool_call` frame for an edge that
 *  already has 5 live particles is dropped, not queued -- density is the information, not a
 *  backlog. */
export const PARTICLE_CAP_PER_EDGE = 5

// A monotonic counter is enough for particle-id uniqueness within one client session (no
// cross-session/cross-tab identity is ever needed) -- simpler and more deterministic in tests than
// `crypto.randomUUID()`, which not every test environment stubs.
let particleSeq = 0
function nextParticleId(): string {
  particleSeq += 1
  return `particle-${particleSeq}`
}

/** Drops every particle whose `expiresAt` is at or before `now`. Pure: same inputs, same output. */
export function sweepExpired(particles: readonly Particle[], now: number): readonly Particle[] {
  return particles.filter((particle) => particle.expiresAt > now)
}

/**
 * Spawns one particle on `edgeId`, sweeping expired particles first (so the cap check below only
 * ever counts particles that are still actually alive). Returns the swept-but-unchanged list, with
 * no new particle appended, once `edgeId` already holds `PARTICLE_CAP_PER_EDGE` live particles --
 * the burst-of-6-frames-yields-5-particles contract the brief's Step 1 names.
 */
export function spawnParticle(particles: readonly Particle[], edgeId: string, now: number): readonly Particle[] {
  const swept = sweepExpired(particles, now)
  const liveOnEdge = swept.filter((particle) => particle.edgeId === edgeId).length
  if (liveOnEdge >= PARTICLE_CAP_PER_EDGE) return swept
  return [...swept, { id: nextParticleId(), edgeId, expiresAt: now + PARTICLE_LIFETIME_MS }]
}

/** Reads `prefers-reduced-motion` via `window.matchMedia` (mocked in tests) -- the guard spec §6
 *  names explicitly ("no particles at all" under reduced motion). Defensive `typeof` checks: SSR/
 *  non-browser callers (there are none today, but nothing here should throw if one appears) get
 *  `false` rather than a crash. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The full spawn guard (spec §6): no particles under reduced motion, and production pauses while
 *  the tab isn't visible (`document.visibilityState !== 'visible'`) -- both are checked here, once,
 *  so every spawn site shares the same rule rather than re-deriving it. */
export function canSpawnParticles(): boolean {
  if (prefersReducedMotion()) return false
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  return true
}

/** The agent → active-task satellite edge for `agentId` (org mode's particle track, spec §6) --
 *  `OrgNodes.buildOrgGraph`'s own id convention (`agent:<id>` source, `activeTask:<id>` target).
 *  `null` when the agent has no live run right now (no satellite, no edge to travel on). */
export function edgeIdForAgent(edges: readonly Edge[], agentId: string): string | null {
  const source = `agent:${agentId}`
  const match = edges.find((edge) => edge.source === source && edge.target.startsWith('activeTask:'))
  return match?.id ?? null
}

/** A raw SSE frame → the new particle list. `StreamEvent`'s fields are all optional (the M6 rule)
 *  -- guarded with `typeof` checks, not narrowed by a discriminated-union assumption. Not itself
 *  "pure" in the strictest sense (`canSpawnParticles` reads `window`/`document`), but every input
 *  that varies test-to-test (the event, the edge list, the particle list, `now`) is still a plain
 *  argument -- no React, no module-level mutable state beyond the id counter above.
 */
export function handleToolCallFrame(
  event: { readonly type?: string; readonly agentId?: string },
  edges: readonly Edge[],
  particles: readonly Particle[],
  now: number,
): readonly Particle[] {
  if (event.type !== 'run.tool_call') return particles
  if (typeof event.agentId !== 'string') return particles
  if (!canSpawnParticles()) return particles
  const edgeId = edgeIdForAgent(edges, event.agentId)
  if (edgeId === null) return particles
  return spawnParticle(particles, edgeId, now)
}

// ---- completion wave (deps mode) ---------------------------------------------------------------

/** ~800ms decay window for the completion-wave edge flash -- same duration as the M5 border-flash
 *  idiom (`BORDER_FLASH_MS` in `AgentCard.tsx`), reused here as a literal so `flow.ts` stays
 *  dependency-free of that component. */
export const EDGE_FLASH_MS = 800

/**
 * Task ids that transitioned TO `done` between two snapshots (spec §6's completion wave), keyed by
 * `previous` (a taskId → status map from the last snapshot `DepsMode` saw) and `current` (the new
 * snapshot's tasks). A task with no entry in `previous` at all (freshly appeared already-done, or
 * the very first snapshot) never counts -- same "no flash on initial mount/appearance" rule the M5
 * border-flash idiom applies to a first render.
 */
export function tasksTurnedDone(
  previous: ReadonlyMap<string, string>,
  current: readonly { readonly id: string; readonly status: string }[],
): readonly string[] {
  return current.filter((task) => task.status === 'done' && previous.get(task.id) !== 'done' && previous.has(task.id)).map((task) => task.id)
}

/** `taskId`'s outgoing edges (spec §6: "its outgoing edges flash once") -- the edges where `taskId`
 *  is the *prerequisite* (`TaskNodes.buildDepsGraph`'s `dependsOn -> task` direction: source is the
 *  dependency, target is the dependent), i.e. "the way is clear for whatever was waiting on me." */
export function outgoingEdgeIds(edges: readonly Edge[], taskId: string): readonly string[] {
  const source = `task:${taskId}`
  return edges.filter((edge) => edge.source === source).map((edge) => edge.id)
}
