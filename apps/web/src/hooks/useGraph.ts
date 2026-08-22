'use client'

// Runtime import, not `../server/graph.js`: that module pulls in `@ai-team-os/db`'s prisma
// client, which must never reach the client bundle (controller ruling R3).
import type { GraphSnapshot } from '../server/graph'
import { useWorkspaceStream, type StreamEvent, type WorkspaceStreamState } from './useWorkspaceStream'

/**
 * Thin composition over `useWorkspaceStream`, same shape as `useTasks`. The graph view also
 * needs the *raw* stream frames (spec: dependency-added/removed and run events drive one-shot
 * flow-line animations independent of the debounced snapshot refetch) -- the brief offered two
 * ways to expose that: an `onFrame` subscription registered on the returned object, or passing an
 * `onEvent` callback straight through to `useWorkspaceStream`'s own `onEvent`.
 *
 * This picks the pass-through. `useWorkspaceStream` already keeps `onEvent` in a ref and never
 * resubscribes the `EventSource` when its identity churns across renders (the M6 rule) -- that is
 * exactly the guarantee an `onFrame` registration would have to reimplement from scratch, and
 * `useOverview` already established the same composition for its own live-line overlay. Building
 * a second, bespoke subscription layer inside `useGraph` would duplicate ref semantics the tested
 * primitive already provides for free, for no behavioural difference the caller could observe.
 *
 * Surface for later tasks: `useGraph(workspaceId, initial, onEvent?)` -- the third, optional
 * parameter is the raw-frame callback, forwarded verbatim to `useWorkspaceStream`'s `onEvent`.
 */
export function useGraph(
  workspaceId: string,
  initial: GraphSnapshot,
  onEvent?: (event: StreamEvent) => void,
): WorkspaceStreamState<GraphSnapshot> {
  return useWorkspaceStream<GraphSnapshot>({
    workspaceId,
    endpoint: `/api/w/${workspaceId}/graph`,
    initial,
    ...(onEvent === undefined ? {} : { onEvent }),
  })
}
