'use client'

import { useSyncExternalStore } from 'react'
import type { ShellFacts } from '../server/shell'

/**
 * The counts, guardrails and header figures a workspace page publishes, read by the project
 * header and tab strip that the project layout mounts (M24 §2.2: `ProjectHeader`/`ProjectTabs`)
 * -- the only consumers left after M24 Task 2's sidebar cleanup: `Sidebar` reads none of this.
 *
 * Deliberately NOT React context: `ProjectHeader`/`ProjectTabs` are mounted by the PROJECT LAYOUT
 * as siblings of the page (`{children}`), so nothing a page mounts is ever an ancestor of them --
 * exactly the relationship `Sidebar` already has with `app/layout.tsx`. A provider inside a page
 * component reaches it in a hand-built test tree and in no tree that actually exists. A
 * module-level store needs no shared ancestor and leaves the layout's own unconditional mount
 * untouched.
 *
 * Why it exists at all (M14 Task 3 controller ruling, still the reason in M24): a component that
 * lives outside a workspace page's own tree but needs that workspace's live figures would
 * otherwise have to open its own `EventSource` per workspace route to fetch them. On a workspace
 * page that is a SECOND stream carrying a subset of what the page's own stream already delivers
 * -- two SSE connections against one workspace, two refetch storms, and two clocks that can
 * disagree on screen at the same instant. A page that has the facts publishes them; anything else
 * that wants them reads this store instead of opening its own stream.
 *
 * ONE workspace at a time: only one workspace route is ever mounted, and a map keyed by id would
 * outlive the pages that filled it.
 */
interface Publication {
  readonly workspaceId: string
  readonly facts: ShellFacts
}

let current: Publication | null = null
const listeners = new Set<() => void>()

/** Value equality over the twelve figures the header and the Tasks tab's badge read off this
 *  store. The Settings tab never reads it -- it renders its own snapshot from
 *  `server/projectSettings.ts`'s `buildProjectSettings` -- but PUBLISHES to it, the same as the
 *  four page clients (M24 final review, Important 1), so the header stays live on that tab too.
 *  The publisher rebuilds the object on every snapshot, so identity would notify on every refetch
 *  that changed nothing. */
function sameFacts(a: ShellFacts, b: ShellFacts): boolean {
  return (
    a.workspace.id === b.workspace.id &&
    a.workspace.name === b.workspace.name &&
    a.counts.agentsWorking === b.counts.agentsWorking &&
    a.counts.tasksActive === b.counts.tasksActive &&
    a.guardrails.budgetUsd === b.guardrails.budgetUsd &&
    a.guardrails.maxConcurrentRuns === b.guardrails.maxConcurrentRuns &&
    a.guardrails.runTimeoutMs === b.guardrails.runTimeoutMs &&
    a.guardrails.maxAttempts === b.guardrails.maxAttempts &&
    a.status.goal === b.status.goal &&
    a.status.spentUsd === b.status.spentUsd &&
    a.status.unmeasuredRuns === b.status.unmeasuredRuns &&
    a.status.haltedReason === b.status.haltedReason
  )
}

/**
 * Called by a workspace route's client component from an effect: on mount, on every snapshot,
 * and with `null` on unmount to retract.
 *
 * A `null` retraction only ever clears THIS workspace's publication -- a page unmounting after a
 * different workspace's page has already published must not blank what the new one's header and
 * tab strip show.
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
