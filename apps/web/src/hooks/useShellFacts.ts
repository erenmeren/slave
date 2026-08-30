'use client'

import { useSyncExternalStore } from 'react'
import type { ShellFacts } from '../server/shell'

/**
 * The counts and guardrails the global shell's `<Sidebar>` shows, published by whichever route
 * already streams that workspace.
 *
 * Deliberately NOT React context, for the reason `hooks/useProjectName.ts` states for the project
 * name: `app/layout.tsx` renders `<Sidebar />` as a SIBLING of `{children}`, so nothing a page
 * mounts is ever an ancestor of the sidebar. A provider inside a page component reaches it in a
 * hand-built test tree and in no tree that actually exists. A module-level store needs no shared
 * ancestor and leaves the layout's single, unconditional `<Sidebar>` mount untouched.
 *
 * Why it exists at all (M14 Task 3 controller ruling): as of Task 3 the sidebar opens its own
 * `EventSource` per workspace route to fetch these figures. On a workspace page that is a SECOND
 * stream carrying a subset of what the page's own stream already delivers -- two SSE connections
 * against one workspace, two refetch storms, and two clocks that can disagree on screen at the
 * same instant. A page that has the facts publishes them; the sidebar falls back to its own
 * stream only where nothing does. Task 12 removes the fallback once every workspace page
 * publishes.
 *
 * ONE workspace at a time, like `useProjectName`: only one workspace route is ever mounted, and
 * a map keyed by id would outlive the pages that filled it.
 */
interface Publication {
  readonly workspaceId: string
  readonly facts: ShellFacts
}

let current: Publication | null = null
const listeners = new Set<() => void>()

/** Value equality over the eight figures the sidebar renders. The publisher rebuilds the object
 *  on every snapshot, so identity would notify on every refetch that changed nothing. */
function sameFacts(a: ShellFacts, b: ShellFacts): boolean {
  return (
    a.workspace.id === b.workspace.id &&
    a.workspace.name === b.workspace.name &&
    a.counts.agentsWorking === b.counts.agentsWorking &&
    a.counts.tasksActive === b.counts.tasksActive &&
    a.guardrails.budgetUsd === b.guardrails.budgetUsd &&
    a.guardrails.maxConcurrentRuns === b.guardrails.maxConcurrentRuns &&
    a.guardrails.runTimeoutMs === b.guardrails.runTimeoutMs &&
    a.guardrails.maxAttempts === b.guardrails.maxAttempts
  )
}

/**
 * Called by a workspace route's client component from an effect: on mount, on every snapshot,
 * and with `null` on unmount to retract.
 *
 * A `null` retraction only ever clears THIS workspace's publication -- a page unmounting after a
 * different workspace's page has already published must not blank the new one's sidebar.
 */
export function publishShellFacts(workspaceId: string, facts: ShellFacts | null): void {
  if (facts === null) {
    if (current === null || current.workspaceId !== workspaceId) return
    current = null
  } else {
    if (current?.workspaceId === workspaceId && sameFacts(current.facts, facts)) return
    current = { workspaceId, facts }
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): Publication | null {
  return current
}

/** Nothing is published on the server, or before the owning route's effect runs. */
function getServerSnapshot(): Publication | null {
  return null
}

/** The facts last published for `workspaceId`, or `null` when nobody has published any -- the
 *  caller then does its own fetching, exactly as it did before this existed. */
export function useShellFacts(workspaceId: string | null): ShellFacts | null {
  const published = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (workspaceId === null || published === null || published.workspaceId !== workspaceId) return null
  return published.facts
}
