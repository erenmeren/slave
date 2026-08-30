'use client'

import { createContext, useContext } from 'react'
import type { ShellFacts } from '../server/shell'

/**
 * The facts the global shell needs, handed DOWN from a page that already has them.
 *
 * Controller ruling carried from M14 Task 3: the root layout mounts one `<Sidebar>` on every
 * page, and as of Task 3 that sidebar opens its OWN `EventSource` per workspace route to fetch
 * its counts and guardrails. On a workspace page that is a second stream carrying a subset of
 * what the first one already delivers -- two SSE connections, two refetch storms, and two clocks
 * that can disagree on screen at the same instant.
 *
 * So a page that has the facts provides them here, and `Sidebar`/`ProjectNav` read the context
 * when a provider exists and fall back to their own stream only when none does. Tasks 10/11/12
 * do the same for Tasks/Graph/Activity; Task 12 removes the fallback once every workspace page
 * provides. Until then BOTH paths have to work, which is why the default is `null` (meaning "no
 * provider", not "no facts yet") rather than an empty facts object.
 */
export interface ShellFactsValue {
  /** `null` while the providing page's own first snapshot has not landed. */
  readonly facts: ShellFacts | null
  /** `useWorkspaceStream.latencyMs` from the providing page's stream (M14 §3). */
  readonly latencyMs: number | null
}

const ShellFactsContext = createContext<ShellFactsValue | null>(null)

export function ShellFactsProvider({
  value,
  children,
}: {
  readonly value: ShellFactsValue
  readonly children: React.ReactNode
}): React.JSX.Element {
  return <ShellFactsContext.Provider value={value}>{children}</ShellFactsContext.Provider>
}

/** `null` when no provider is mounted above -- the caller then does its own fetching. */
export function useShellFacts(): ShellFactsValue | null {
  return useContext(ShellFactsContext)
}
