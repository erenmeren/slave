# M24 One Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a project one tabbed page under one header, give the sidebar one unchanging list, and give every page one subject — moving the goal/runtime/permission/catalog panels to where their subject lives, folding the Agents page into one table, and slimming the task card.

**Architecture:** A new server layout at `app/w/[workspaceId]/layout.tsx` renders the project header and tab strip once; the four workspace pages become tab contents and stop rendering `TopBar`. Live header figures ride the existing publish/subscribe stores (`hooks/useShellFacts.ts`, widened; a new `hooks/useStreamState.ts` for connection/latency) so no second SSE connection is opened. A new `/w/<id>/settings` page hosts goal, runtime, permissions and the danger zone. Panels move between existing pages with their components intact; two tables (Roster, Workers) merge into one fed by a new `listAllAgents()`.

**Tech Stack:** Next.js 15 App Router (server layouts + client components), React 19, Tailwind, Vitest 3 + Testing Library, Prisma 7 (read-only here), the M14 `ui/` primitives (`Panel`, `DataTable`, `Row`, `StatusPill`, `FormControls`).

**Spec:** `docs/superpowers/specs/2026-09-04-m24-shell-tabs-and-simpler-pages-design.md` — read it before any task; §-numbers below refer to it.

## Global Constraints

- Branch: `feature/m24-shell` (already holds the spec commit a177d3d). Every task commits there.
- Web only: no change under `packages/`, `apps/orchestrator/`, `apps/web/src/app/api/`; no migration; no new npm dependency. The only server-side additions are under `apps/web/src/server/` (spec §8).
- URLs are unchanged: `/`, `/agents`, `/skills`, `/analytics`, `/settings`, `/login`, `/w/<id>`, `/w/<id>/tasks`, `/w/<id>/graph`, `/w/<id>/activity`; one new route `/w/<id>/settings`.
- No second SSE connection: header figures come from the publish/subscribe stores the pages already feed (spec §2.2). A component that opens its own `EventSource` for a figure a page already has is a defect.
- Geometry is the handoff's: sidebar 212px, header 52px, radius 5–10, mono 9px uppercase section labels with `.09em` tracking, status alphas `1a`/`3d`. The tab strip reuses the Agents page's existing tab idiom (`role="tablist"`, `rounded-chip border px-3 py-1.5 text-xs font-medium`).
- Standing rules: ONE vitest run at a time; no orchestrator daemon during tests; root `tsc --build` does NOT cover `apps/web` tests — run `npx tsc -p apps/web/tsconfig.test.json --noEmit`; every task gates on `npm run web:build` before commit, NEVER while a `next dev` runs (`pgrep -fa 'next dev'` first), and runs `rm -rf apps/web/.next` after; `git add` explicit paths only; comments change in the same commit as the behaviour they describe (the M11/M14 comments that describe the two-section sidebar, `TopBar`, or "publish to the sidebar" must be rewritten wherever a task touches them).
- Testids named in the spec are exact: `project-switcher`, `project-goal`, `project-tab-<name>`, `new-project`, `runtime-concurrency`, `runtime-timeout`, `runtime-attempts`. Existing testids that survive keep their names (`connection`, `budget`, `budget-unmeasured`, `emergency-stop*`, `goal-input`, `goal-submit`, `goal-error`, `runtime-provider*`, `runtime-budget*`, `runtime-error`, `perm-*`, `security-posture`, `reseed-*`, `create-workspace-*`, `template-*`, `company-*`, `task-card`, `task-title`, `task-assignee`, `agents-tab-teams`, `agent-name-edit` …).
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Cn38UnA4dYCVbVJX8c1o7G`.

## File structure

Create:
- `apps/web/src/hooks/useStreamState.ts` — module store: `{ connection, latencyMs }` per workspace, same idiom as `useShellFacts.ts`.
- `apps/web/src/components/project/ProjectHeader.tsx` — client; name + switcher trigger, goal line, connection chip, budget bar, STOP.
- `apps/web/src/components/project/ProjectSwitcher.tsx` — client; the dropdown of workspaces + "New project".
- `apps/web/src/components/project/ProjectTabs.tsx` — client; five tab links, `aria-current`, Tasks badge.
- `apps/web/src/app/w/[workspaceId]/layout.tsx` — server; loads facts + workspace names, renders header, tabs, children.
- `apps/web/src/components/project/GoalPanel.tsx` — `GoalCard` moved, suggestions removed, `router.refresh()` on success.
- `apps/web/src/components/project/RuntimePanel.tsx` — `RuntimeCard`'s forms + three read-only rows.
- `apps/web/src/components/project/ProjectSettingsClient.tsx` — the four panels.
- `apps/web/src/server/projectSettings.ts` — `buildProjectSettings(workspaceId)`.
- `apps/web/src/app/w/[workspaceId]/settings/page.tsx`.
- `apps/web/src/components/projects/NewProjectDrawer.tsx` — wraps `ProjectsPanel` in a dialog.
- `apps/web/src/components/AllAgentsTable.tsx` — the unified agents table.
- Tests: `apps/web/test/project-header.test.tsx`, `project-tabs.test.tsx`, `project-layout.test.tsx`, `project-settings.test.tsx`, `all-agents-table.test.tsx`, `apps/web/test/integration/all-agents.test.ts`.

Modify: `server/shell.ts` (four more facts), `hooks/useShellFacts.ts` (`sameFacts`), `server/org.ts` (`listWorkspaceNames`, `listAllAgents`), `server/overview.ts` (no suggestions), `server/settings.ts` (`buildPermissionMatrix(workspaceId?)`), `Sidebar.tsx` (one list), `OverviewClient.tsx`, `TasksClient.tsx`, `graph/GraphClient.tsx`, `activity/ActivityClient.tsx` (no `TopBar`; publish stream state), `SettingsClient.tsx`, `DangerZone.tsx`, `app/settings/page.tsx`, `ProjectsClient.tsx`, `app/page.tsx`, `AgentsClient.tsx`, `app/agents/page.tsx`, `TaskCard.tsx`, `TaskDetailPanel.tsx`, `app/layout.tsx`, the tests named per task, four gate scripts.

Delete: `components/TopBar.tsx`, `components/GoalCard.tsx`, `components/RuntimeCard.tsx`, `components/RosterTable.tsx`, `components/WorkersTable.tsx`, `hooks/useProjectName.ts` (the header knows its name from the layout), `test/goal-card.test.tsx`, `test/runtime-card.test.tsx` (their cases move into `project-settings.test.tsx`).

---

### Task 1: The header's data and the three header components

**Files:**
- Modify: `apps/web/src/server/shell.ts`, `apps/web/src/hooks/useShellFacts.ts`, `apps/web/src/server/org.ts`
- Create: `apps/web/src/hooks/useStreamState.ts`, `apps/web/src/components/project/ProjectHeader.tsx`, `apps/web/src/components/project/ProjectSwitcher.tsx`, `apps/web/src/components/project/ProjectTabs.tsx`
- Test: `apps/web/test/project-header.test.tsx` (new), `apps/web/test/project-tabs.test.tsx` (new), `apps/web/test/integration/shell-facts.test.ts` (new, small)

**Interfaces:**
- Produces `ShellFacts` widened with `goal: string | null`, `spentUsd: number`, `unmeasuredRuns: number`, `haltedReason: string | null` (all inside a new `readonly workspace` block? NO — keep the existing shape and add a fourth block `readonly status: { goal; spentUsd; unmeasuredRuns; haltedReason }` so the two existing consumers keep compiling).
- Produces `publishStreamState(workspaceId, state: StreamState | null)` and `useStreamState(workspaceId): StreamState | null` with `StreamState = { readonly connection: 'connected' | 'reconnecting'; readonly latencyMs: number | null }`.
- Produces `listWorkspaceNames(): Promise<readonly { id: string; name: string }[]>` (ordered by name).
- Produces `ProjectHeader({ workspaceId, initial: ShellFacts, workspaces })`, `ProjectSwitcher({ current: { id; name }, workspaces })`, `ProjectTabs({ workspaceId, initialTasksActive: number })`.

- [ ] **Step 1: Widen `ShellFacts`.** In `apps/web/src/server/shell.ts` add to the interface, after `guardrails`:

```ts
  /** The header's own figures (M24 §2.2): the goal line, the budget bar and the halt state.
   *  Published by every workspace page alongside the counts, so the header never opens a stream. */
  readonly status: {
    readonly goal: string | null
    readonly spentUsd: number
    readonly unmeasuredRuns: number
    readonly haltedReason: string | null
  }
```

and in `buildShellFacts` compute them the way `overview.ts` does — copy its spend derivation exactly: find the block in `apps/web/src/server/overview.ts` that computes `spentUsd` and `unmeasuredRuns` for `workspace` (grep `unmeasuredRuns` there; it sums `costUsd` over the workspace's runs with `spendOfGroups`/the grouped query) and reuse the same helper from `server/org.ts` (`spendOfGroups` is exported there — check with `grep -n "export function spendOfGroups" apps/web/src/server/org.ts`; if it is not exported, export it). Return:

```ts
    status: {
      goal: workspace.goal,
      spentUsd: spend,
      unmeasuredRuns,
      haltedReason: workspace.haltedReason,
    },
```

Update the module docstring: it is no longer "the two live counts the sidebar's nav rows carry" but "the figures the project header and the Tasks tab badge show".

- [ ] **Step 2: `sameFacts` compares the four new fields.** In `hooks/useShellFacts.ts` extend `sameFacts` with `a.status.goal === b.status.goal && a.status.spentUsd === b.status.spentUsd && a.status.unmeasuredRuns === b.status.unmeasuredRuns && a.status.haltedReason === b.status.haltedReason`; change the docstring's "eight figures the sidebar renders" to "twelve figures the header, the Tasks badge and the Settings tab render". Rewrite the file's first comment paragraph: the consumer is now `ProjectHeader`/`ProjectTabs` mounted by the project layout — they are ancestors of nothing the page renders either, so the module store stays.

- [ ] **Step 3: `listWorkspaceNames`.** In `apps/web/src/server/org.ts` add:

```ts
/** Every workspace by name, for the project header's switcher (M24 §2.2). Two columns, no joins:
 *  `listProjects` exists for the cards and is far heavier than a dropdown needs. */
export async function listWorkspaceNames(): Promise<readonly { readonly id: string; readonly name: string }[]> {
  return prisma.workspace.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
}
```

- [ ] **Step 4: the stream-state store.** Create `apps/web/src/hooks/useStreamState.ts`:

```ts
'use client'

import { useSyncExternalStore } from 'react'

/** What a workspace page's `useWorkspaceStream` knows about its own connection, published for
 *  the project header's chip (M24 §2.2). A module store for the same reason `useShellFacts.ts`
 *  is one: the header is mounted by the layout, the stream by the page, and neither is the
 *  other's ancestor. One workspace at a time. */
export interface StreamState {
  readonly connection: 'connected' | 'reconnecting'
  readonly latencyMs: number | null
}

interface Publication {
  readonly workspaceId: string
  readonly state: StreamState
}

let current: Publication | null = null
const listeners = new Set<() => void>()

export function publishStreamState(workspaceId: string, state: StreamState | null): void {
  if (state === null) {
    if (current === null || current.workspaceId !== workspaceId) return
    current = null
  } else {
    if (
      current?.workspaceId === workspaceId &&
      current.state.connection === state.connection &&
      current.state.latencyMs === state.latencyMs
    ) {
      return
    }
    current = { workspaceId, state }
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
function getServerSnapshot(): Publication | null {
  return null
}

/** `null` before the page's stream has published — the header shows `sse · —` then. */
export function useStreamState(workspaceId: string): StreamState | null {
  const published = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (published === null || published.workspaceId !== workspaceId) return null
  return published.state
}
```

- [ ] **Step 5: failing tests for the header and tabs.** Create `apps/web/test/project-header.test.tsx`:

```tsx
import { render, screen, fireEvent, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellFacts } from '../src/server/shell'
import { publishShellFacts } from '../src/hooks/useShellFacts'
import { publishStreamState } from '../src/hooks/useStreamState'
import { ProjectHeader } from '../src/components/project/ProjectHeader'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => '/w/w1' }))

function facts(over: Partial<ShellFacts['status']> = {}): ShellFacts {
  return {
    workspace: { id: 'w1', name: 'Checkout Platform' },
    counts: { agentsWorking: 0, tasksActive: 2 },
    guardrails: { budgetUsd: 2, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 5 },
    status: { goal: null, spentUsd: 0.5, unmeasuredRuns: 0, haltedReason: null, ...over },
  }
}
const workspaces = [
  { id: 'w1', name: 'Checkout Platform' },
  { id: 'w2', name: 'Billing' },
]

afterEach(() => {
  publishShellFacts('w1', null)
  publishStreamState('w1', null)
})

describe('ProjectHeader', () => {
  it('is 52px tall and names the project, the goal state and the budget from the initial facts', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    expect(screen.getByTestId('project-header').className).toContain('h-[52px]')
    expect(screen.getByTestId('project-switcher').textContent).toContain('Checkout Platform')
    expect(screen.getByTestId('project-goal').textContent).toBe('no goal · set one')
    expect(screen.getByTestId('project-goal').closest('a')?.getAttribute('href')).toBe('/w/w1/settings')
    expect(screen.getByTestId('budget').textContent).toContain('$0.50 / $2.00')
    expect(screen.getByTestId('connection').textContent).toBe('sse · —')
  })

  it('shows the goal, truncated to one line, and links it to the Settings tab', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts({ goal: 'Ship rate limiting' })} workspaces={workspaces} />)
    const goal = screen.getByTestId('project-goal')
    expect(goal.textContent).toBe('Goal: Ship rate limiting')
    expect(goal.className).toContain('truncate')
    expect(goal.closest('a')?.getAttribute('href')).toBe('/w/w1/settings')
  })

  it('follows a later publication of facts and stream state', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    act(() => {
      publishShellFacts('w1', facts({ spentUsd: 1.75, unmeasuredRuns: 1, goal: 'Do it' }))
      publishStreamState('w1', { connection: 'connected', latencyMs: 42 })
    })
    expect(screen.getByTestId('budget').textContent).toContain('$1.75 / $2.00')
    expect(screen.getByTestId('budget-unmeasured').textContent).toBe('· 1 unmeasured')
    expect(screen.getByTestId('connection').textContent).toBe('sse · 42ms')
    expect(screen.getByTestId('project-goal').textContent).toBe('Goal: Do it')
  })

  it('says reconnecting in the warn tone when the stream drops', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    act(() => publishStreamState('w1', { connection: 'reconnecting', latencyMs: 42 }))
    expect(screen.getByTestId('connection').textContent).toBe('reconnecting')
    expect(screen.getByTestId('connection').className).toContain('text-tone-waiting')
  })

  it('renders the STOP button armed by the halt state', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts({ haltedReason: 'emergency stop by eren' })} workspaces={workspaces} />)
    expect((screen.getByTestId('emergency-stop') as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the switcher with every workspace and a New project row', () => {
    render(<ProjectHeader workspaceId="w1" initial={facts()} workspaces={workspaces} />)
    fireEvent.click(screen.getByTestId('project-switcher'))
    const rows = screen.getAllByTestId('project-switcher-row')
    expect(rows.map((r) => r.textContent)).toEqual(['Checkout Platform', 'Billing'])
    expect(rows[0]?.getAttribute('aria-current')).toBe('true')
    expect(rows[1]?.getAttribute('href')).toBe('/w/w2')
    expect(screen.getByTestId('project-switcher-new').getAttribute('href')).toBe('/?new=1')
  })
})
```

Create `apps/web/test/project-tabs.test.tsx`:

```tsx
import { render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishShellFacts } from '../src/hooks/useShellFacts'
import { ProjectTabs } from '../src/components/project/ProjectTabs'

let pathname = '/w/w1'
vi.mock('next/navigation', () => ({ usePathname: () => pathname }))

afterEach(() => publishShellFacts('w1', null))

const TAB_HREFS = ['/w/w1', '/w/w1/tasks', '/w/w1/graph', '/w/w1/activity', '/w/w1/settings']

describe('ProjectTabs', () => {
  it('renders the five tabs in order with their hrefs', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={2} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, '').trim())).toEqual(['Overview', 'Tasks', 'Graph', 'Activity', 'Settings'])
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual(TAB_HREFS)
  })

  it('marks Overview current only on the exact route', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-tab-overview').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-tasks').getAttribute('aria-current')).toBeNull()
  })

  it('marks Graph current on a graph route with a query string', () => {
    pathname = '/w/w1/graph'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-tab-graph').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-overview').getAttribute('aria-current')).toBeNull()
  })

  it('carries the active-task badge on Tasks only, from the initial value and then from publications', () => {
    pathname = '/w/w1/tasks'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={2} />)
    expect(screen.getByTestId('project-tab-badge-tasks').textContent).toBe('2')
    expect(screen.queryByTestId('project-tab-badge-overview')).toBeNull()
    act(() =>
      publishShellFacts('w1', {
        workspace: { id: 'w1', name: 'x' },
        counts: { agentsWorking: 1, tasksActive: 7 },
        guardrails: { budgetUsd: null, maxConcurrentRuns: 1, runTimeoutMs: 1000, maxAttempts: 1 },
        status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
      }),
    )
    expect(screen.getByTestId('project-tab-badge-tasks').textContent).toBe('7')
  })
})
```

Note `usePathname` in Next returns the path WITHOUT the query string; the "query string" case is covered by prefix matching on `/w/w1/graph`.

- [ ] **Step 6: run them RED.** `npx vitest run apps/web/test/project-header.test.tsx apps/web/test/project-tabs.test.tsx` → FAIL (modules not found).

- [ ] **Step 7: `ProjectSwitcher`.** Create `apps/web/src/components/project/ProjectSwitcher.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

/** The project header's name button and its dropdown (M24 §2.2): every workspace by name, the
 *  current one marked, and a last row that opens the Projects page's New project drawer. A plain
 *  popover (no `<dialog>`): it is a navigation menu, not a modal, and Escape/outside-click close it. */
export function ProjectSwitcher({
  current,
  workspaces,
}: {
  readonly current: { readonly id: string; readonly name: string }
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onClick = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="project-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-[6px] rounded-nav px-[6px] py-[3px] text-[14.5px] font-semibold tracking-[-.2px] text-text-1 hover:bg-white/[0.045]"
      >
        <span className="truncate">{current.name}</span>
        <span aria-hidden className="text-[10px] text-text-3">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          data-testid="project-switcher-menu"
          className="absolute left-0 top-full z-20 mt-1 flex min-w-[220px] flex-col gap-px rounded-panel border border-line bg-bg-1 p-1 shadow-active"
        >
          {workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              role="menuitem"
              data-testid="project-switcher-row"
              href={`/w/${workspace.id}`}
              aria-current={workspace.id === current.id ? 'true' : undefined}
              onClick={() => setOpen(false)}
              className={`truncate rounded-nav px-[9px] py-[6px] text-[12.5px] ${
                workspace.id === current.id ? 'bg-[#151a21] text-text-1' : 'text-text-2 hover:bg-white/[0.045] hover:text-text-1'
              }`}
            >
              {workspace.name}
            </Link>
          ))}
          <Link
            role="menuitem"
            data-testid="project-switcher-new"
            href="/?new=1"
            onClick={() => setOpen(false)}
            className="mt-1 border-t border-line px-[9px] pt-[7px] pb-[4px] font-mono text-[10.5px] text-tone-working hover:text-text-1"
          >
            + New project
          </Link>
        </div>
      )}
    </div>
  )
}
```

Check that the Tailwind classes `rounded-nav`, `rounded-panel`, `shadow-active`, `bg-bg-1`, `text-text-*`, `tone-working` exist in `apps/web/src/app/globals.css`'s `@theme` block (they are the M14 tokens `Sidebar.tsx` and `TopBar.tsx` use); if `shadow-active` is not a token, use `shadow-[0_6px_22px_rgba(0,0,0,.45)]` (the handoff's active shadow).

- [ ] **Step 8: `ProjectHeader`.** Create `apps/web/src/components/project/ProjectHeader.tsx` — `TopBar.tsx`'s chip and bar recipes moved here verbatim (copy the `CONNECTION_CHIP_*`/`CONNECTION_DOT_TONE` constants and the `barColor` derivation with their comments), reading live figures from the two stores:

```tsx
'use client'

import Link from 'next/link'
import type { ShellFacts } from '../../server/shell'
import { useShellFacts } from '../../hooks/useShellFacts'
import { useStreamState } from '../../hooks/useStreamState'
import { EmergencyStopButton } from '../EmergencyStopButton'
import { ProjectSwitcher } from './ProjectSwitcher'

// (the CONNECTION_CHIP_BASE / CONNECTION_CHIP_TONE / CONNECTION_DOT_TONE constants from TopBar.tsx,
//  with their original comment)

export function ProjectHeader({
  workspaceId,
  initial,
  workspaces,
}: {
  readonly workspaceId: string
  /** The layout's server-rendered facts: what the header shows until the page's stream publishes. */
  readonly initial: ShellFacts
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
}): React.JSX.Element {
  const published = useShellFacts(workspaceId)
  const facts = published ?? initial
  const stream = useStreamState(workspaceId)
  const connection = stream?.connection ?? 'connected'
  const latencyMs = stream?.latencyMs ?? null
  const connectionText = connection === 'connected' ? `sse · ${latencyMs === null ? '—' : `${latencyMs}ms`}` : 'reconnecting'

  const budgetUsd = facts.guardrails.budgetUsd
  const ratio = budgetUsd === null || budgetUsd <= 0 ? 0 : facts.status.spentUsd / budgetUsd
  // (barColor derivation from TopBar.tsx, with its comment)

  return (
    <header
      data-testid="project-header"
      className="relative flex h-[52px] flex-none items-center gap-4 border-b border-line bg-bg-1 px-4"
    >
      {/* (the gradient hairline span from TopBar.tsx, testid `top-bar-hairline` renamed `project-header-hairline`, with its comment) */}
      <ProjectSwitcher current={facts.workspace} workspaces={workspaces} />
      <Link
        href={`/w/${workspaceId}/settings`}
        className="min-w-0 max-w-[420px] rounded-nav px-[6px] py-[3px] hover:bg-white/[0.045]"
      >
        <span data-testid="project-goal" className={`block truncate text-[11.5px] ${facts.status.goal === null ? 'text-text-3' : 'text-text-2'}`}>
          {facts.status.goal === null ? 'no goal · set one' : `Goal: ${facts.status.goal}`}
        </span>
      </Link>
      <span data-testid="connection" className={`${CONNECTION_CHIP_BASE} ${CONNECTION_CHIP_TONE[connection]}`}>
        <span className={`inline-block h-[5px] w-[5px] rounded-full ${CONNECTION_DOT_TONE[connection]}`} />
        {connectionText}
      </span>
      <span className="ml-auto flex items-center gap-3">
        <span data-testid="budget" className="flex items-center gap-2 text-xs text-text-2">
          <span className="font-mono">
            ${facts.status.spentUsd.toFixed(2)}
            {budgetUsd !== null && ` / $${budgetUsd.toFixed(2)}`}
          </span>
          {facts.status.unmeasuredRuns > 0 && (
            <span data-testid="budget-unmeasured" className="text-text-3">
              · {facts.status.unmeasuredRuns} unmeasured
            </span>
          )}
          {budgetUsd !== null && (
            <span className="h-[3px] w-[150px] overflow-hidden rounded-[2px] bg-white/[0.08]">
              <span className={`block h-full motion-safe:[transition:width_.5s_ease] ${barColor}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
            </span>
          )}
        </span>
        <EmergencyStopButton key={String(facts.status.haltedReason !== null)} workspaceId={workspaceId} halted={facts.status.haltedReason !== null} />
      </span>
    </header>
  )
}
```

The `key` on `EmergencyStopButton` remounts it when the halt state flips so a half-confirmed stop never survives a halt landing from the stream (same reason `DangerZone` keys it on the selection). `EmergencyStopButton` renders `disabled={halted}` (its line ~99) — that is what the test above asserts.

- [ ] **Step 9: `ProjectTabs`.** Create `apps/web/src/components/project/ProjectTabs.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useShellFacts } from '../../hooks/useShellFacts'

const TABS = [
  { id: 'overview', label: 'Overview', path: (id: string) => `/w/${id}`, exact: true },
  { id: 'tasks', label: 'Tasks', path: (id: string) => `/w/${id}/tasks`, exact: false },
  { id: 'graph', label: 'Graph', path: (id: string) => `/w/${id}/graph`, exact: false },
  { id: 'activity', label: 'Activity', path: (id: string) => `/w/${id}/activity`, exact: false },
  { id: 'settings', label: 'Settings', path: (id: string) => `/w/${id}/settings`, exact: false },
] as const

/** The project's tab strip (M24 §2.2): five route links in the Agents page's tab idiom. Overview
 *  matches its route exactly (it is the prefix of every other tab); the rest match by prefix so a
 *  Graph mode in the query string still lights Graph. Only Tasks carries a badge. */
export function ProjectTabs({
  workspaceId,
  initialTasksActive,
}: {
  readonly workspaceId: string
  readonly initialTasksActive: number
}): React.JSX.Element {
  const pathname = usePathname()
  const facts = useShellFacts(workspaceId)
  const tasksActive = facts?.counts.tasksActive ?? initialTasksActive

  return (
    <div role="tablist" aria-label="Project" className="flex gap-1 border-b border-line bg-bg-1 px-4 py-[6px]">
      {TABS.map((tab) => {
        const href = tab.path(workspaceId)
        const current = tab.exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={tab.id}
            role="tab"
            data-testid={`project-tab-${tab.id}`}
            href={href}
            aria-current={current ? 'page' : undefined}
            aria-selected={current}
            className={`flex items-center gap-[6px] rounded-chip border px-3 py-1.5 text-xs font-medium transition-colors ${
              current ? 'border-line bg-bg-2 text-text-1' : 'border-transparent text-text-3 hover:text-text-2'
            }`}
          >
            {tab.label}
            {tab.id === 'tasks' && (
              <span data-testid="project-tab-badge-tasks" className="font-mono text-[9.5px] font-medium text-text-faint">
                {tasksActive}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 10: a real-DB test for the widened facts.** Create `apps/web/test/integration/shell-facts.test.ts` in the shape of `apps/web/test/integration/tasks-snapshot.test.ts` (same imports, `beforeEach` TRUNCATE of `"ExecutionEvent", "AgentRun", "Task", "Agent", "Team", "Workspace"`, a `mkdtempSync` repoPath with a module-level `afterAll`): seed a workspace with `goal: 'Ship it'`, `budgetUsd: 2`, `haltedReason: null`, one agent, one `succeeded` run with `costUsd: 0.25` and one `succeeded` run with `costUsd: null`; assert `buildShellFacts(id)` returns `status: { goal: 'Ship it', spentUsd: 0.25, unmeasuredRuns: 1, haltedReason: null }`; a second case with `haltedReason: 'emergency stop by t'` and `goal: null`.

- [ ] **Step 11: GREEN + gates.** `npx tsc --build && npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/project-header.test.tsx apps/web/test/project-tabs.test.tsx apps/web/test/integration/shell-facts.test.ts apps/web/test/shell.test.tsx apps/web/test/integration/shell-snapshot.test.ts` — the two existing shell tests must still pass (the shape only grew). `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 12: Commit.**

```bash
git add apps/web/src/server/shell.ts apps/web/src/hooks/useShellFacts.ts apps/web/src/hooks/useStreamState.ts apps/web/src/server/org.ts apps/web/src/components/project/ProjectHeader.tsx apps/web/src/components/project/ProjectSwitcher.tsx apps/web/src/components/project/ProjectTabs.tsx apps/web/test/project-header.test.tsx apps/web/test/project-tabs.test.tsx apps/web/test/integration/shell-facts.test.ts
git commit -m "feat(web): m24 t1 — the project header, its switcher and its tabs, fed by the facts the pages already publish"
```

---

### Task 2: The project layout, the pages under it, and the one-list sidebar

**Files:**
- Create: `apps/web/src/app/w/[workspaceId]/layout.tsx`
- Modify: `apps/web/src/components/OverviewClient.tsx`, `apps/web/src/components/TasksClient.tsx`, `apps/web/src/components/graph/GraphClient.tsx`, `apps/web/src/components/activity/ActivityClient.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/app/layout.tsx`
- Delete: `apps/web/src/components/TopBar.tsx`, `apps/web/src/hooks/useProjectName.ts`
- Test: `apps/web/test/project-layout.test.tsx` (new), `apps/web/test/shell.test.tsx` (rewritten), `apps/web/test/overview-components.test.tsx`, `apps/web/test/tasks-components.test.tsx`, `apps/web/test/graph-page.test.tsx`, `apps/web/test/activity-page.test.tsx` (each: drop TopBar assertions, keep the rest)

**Interfaces:**
- Consumes Task 1's `ProjectHeader`, `ProjectTabs`, `listWorkspaceNames`, `publishStreamState`, widened `ShellFacts`.
- Produces: the layout; `Sidebar` with no props and no project section; every workspace client publishing `{ connection, latencyMs }` and the widened facts.

- [ ] **Step 1: failing layout test.** Create `apps/web/test/project-layout.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ usePathname: () => '/w/w1/tasks', useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('../src/server/shell', () => ({
  buildShellFacts: vi.fn(async (id: string) =>
    id === 'w1'
      ? {
          workspace: { id: 'w1', name: 'Checkout Platform' },
          counts: { agentsWorking: 0, tasksActive: 3 },
          guardrails: { budgetUsd: 2, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 5 },
          status: { goal: 'Ship it', spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
        }
      : null,
  ),
}))
vi.mock('../src/server/org', () => ({ listWorkspaceNames: vi.fn(async () => [{ id: 'w1', name: 'Checkout Platform' }]) }))

import ProjectLayout from '../src/app/w/[workspaceId]/layout'

describe('the project layout', () => {
  it('renders the header, the tab strip and the page below them', async () => {
    const tree = await ProjectLayout({ params: Promise.resolve({ workspaceId: 'w1' }), children: <div data-testid="page">page</div> })
    render(tree)
    expect(screen.getByTestId('project-header')).toBeTruthy()
    expect(screen.getByTestId('project-goal').textContent).toBe('Goal: Ship it')
    expect(screen.getByTestId('project-tab-tasks').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-badge-tasks').textContent).toBe('3')
    expect(screen.getByTestId('page')).toBeTruthy()
  })

  it('renders only the page for an unknown workspace (the page says so itself)', async () => {
    const tree = await ProjectLayout({ params: Promise.resolve({ workspaceId: 'nope' }), children: <div data-testid="page">no workspace</div> })
    render(tree)
    expect(screen.queryByTestId('project-header')).toBeNull()
    expect(screen.getByTestId('page')).toBeTruthy()
  })
})
```

Run: `npx vitest run apps/web/test/project-layout.test.tsx` → FAIL (no layout module).

- [ ] **Step 2: the layout.** Create `apps/web/src/app/w/[workspaceId]/layout.tsx`:

```tsx
import type React from 'react'
import { buildShellFacts } from '../../../server/shell'
import { listWorkspaceNames } from '../../../server/org'
import { ProjectHeader } from '../../../components/project/ProjectHeader'
import { ProjectTabs } from '../../../components/project/ProjectTabs'

export const dynamic = 'force-dynamic'

/**
 * One header and one tab strip for every `/w/:id/...` page (M24 §2.2). The facts rendered here
 * are the server's snapshot at navigation time; the page's own stream publishes newer ones to the
 * same header through `hooks/useShellFacts.ts`, so the header never opens a connection of its own.
 * An unknown workspace renders the children alone — every page already answers that case.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ workspaceId: string }>
  children: React.ReactNode
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const [facts, workspaces] = await Promise.all([buildShellFacts(workspaceId), listWorkspaceNames()])
  if (facts === null) return <>{children}</>
  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <ProjectHeader workspaceId={workspaceId} initial={facts} workspaces={workspaces} />
      <ProjectTabs workspaceId={workspaceId} initialTasksActive={facts.counts.tasksActive} />
      {children}
    </div>
  )
}
```

- [ ] **Step 3: the four clients drop `TopBar` and publish stream state.** In each of `OverviewClient.tsx`, `TasksClient.tsx`, `graph/GraphClient.tsx`, `activity/ActivityClient.tsx`:
  - remove the `import { TopBar } from …` line and the whole `<TopBar … />` element;
  - add `import { publishStreamState } from '../hooks/useStreamState'` (path depth per file) and, next to the existing `publishShellFacts` effects:

```ts
  useEffect((): void => {
    publishStreamState(workspaceId, { connection, latencyMs })
  }, [workspaceId, connection, latencyMs])
  useEffect((): (() => void) => () => publishStreamState(workspaceId, null), [workspaceId])
```

  - `OverviewClient.tsx` builds its `shellFacts` object inline (lines ~185-200): add the `status` block from `view.workspace` (`goal`, `spentUsd`, `unmeasuredRuns`, `haltedReason`). `TasksClient`, `GraphClient`, `ActivityClient` publish `view.shellFacts` / `initial.shellFacts`, which Task 1 already widened server-side — no change there.
  - `OverviewClient.tsx`'s `announceProjectName` call (grep `announceProjectName`) and its import go; the header knows the name from the layout.
  - Rewrite the comments above the publish effects ("publishes them to `hooks/useShellFacts.ts` and the sidebar opens no second `EventSource`") to name the header and the Tasks badge as the consumers.

- [ ] **Step 4: the sidebar becomes one list.** Rewrite `apps/web/src/components/Sidebar.tsx` to:

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/** The five global pages, in the handoff's order with Projects first (M24 §2.1). */
const ROWS = [
  { label: 'Projects', href: '/' },
  { label: 'Agents', href: '/agents' },
  { label: 'Skills', href: '/skills' },
  { label: 'Analytics', href: '/analytics' },
  { label: 'Settings', href: '/settings' },
] as const

/** One nav row (mockup geometry: `7px 9px` padding, radius 6, 12.5px label). */
function NavRow({ label, href, current }: { readonly label: string; readonly href: string; readonly current: boolean }): React.JSX.Element {
  return (
    <Link
      data-testid="nav-row"
      data-nav={label}
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`flex items-center justify-between rounded-nav px-[9px] py-[7px] text-[12.5px] transition-colors ${
        current
          ? 'bg-[#151a21] font-medium text-text-1 shadow-[inset_2px_0_0_var(--color-tone-working)]'
          : 'text-text-2 hover:bg-white/[0.045] hover:text-text-1'
      }`}
    >
      <span>{label}</span>
    </Link>
  )
}

/**
 * The handoff's 212px sidebar (design README §3a), reduced to the five global rows (M24 §2.1).
 * It is the same on every page: a project's own navigation lives in the project layout's tab
 * strip, never here. Projects is current on `/` and on every `/w/:id/...` route — a project page
 * is a Projects page opened. The login page stands alone (M20 spec §3.3).
 */
export function Sidebar(): React.JSX.Element | null {
  const pathname = usePathname()
  if (pathname === '/login') return null
  const isCurrent = (href: string): boolean => (href === '/' ? pathname === '/' || pathname.startsWith('/w/') : pathname === href)
  return (
    <nav aria-label="Primary" className="flex w-[212px] shrink-0 flex-col border-r border-line bg-bg-1 px-[8px] py-[10px]">
      <div className="flex flex-col gap-px">
        {ROWS.map((row) => (
          <NavRow key={row.label} label={row.label} href={row.href} current={isCurrent(row.href)} />
        ))}
      </div>
    </nav>
  )
}
```

The bottom-left roundel is not the sidebar's (grep `ShellOnlyMark` under `apps/web/src` to see where it mounts; leave it). `formatTimeout` moves to `apps/web/src/lib/format.ts` (it is reused by Task 4's Runtime panel) — export it there and delete it from `Sidebar.tsx`. `app/layout.tsx`: `<Sidebar />` stays; rewrite its comment (the sidebar no longer "decides which sections to show").

- [ ] **Step 5: delete `TopBar.tsx` and `useProjectName.ts`;** `grep -rn "TopBar\|useProjectName\|announceProjectName" apps/web/src apps/web/test` must return nothing but this task's rewritten tests.

- [ ] **Step 6: tests.** Rewrite `apps/web/test/shell.test.tsx`: keep the "renders nothing on /login" case; replace the sidebar cases with: five rows in order (`Projects, Agents, Skills, Analytics, Settings`); `Projects` is `aria-current` on `/` and on `/w/w1/tasks`; `Settings` on `/settings`; no `project-section`, no `nav-badge-*`, no `guardrail-*` anywhere; 212px width. Delete every "top bar" and "ProjectNav" describe (their subjects are gone; the header is covered by Task 1's tests). In `overview-components.test.tsx`, `tasks-components.test.tsx`, `graph-page.test.tsx`, `activity-page.test.tsx` remove assertions on `top-bar`, `connection`, `budget` inside the page (grep each file for those testids) and add one assertion per client that `publishStreamState` was called with `{ connection: 'connected', latencyMs: null }` on mount (`vi.mock('../src/hooks/useStreamState', …)` with a `vi.fn()`).

- [ ] **Step 7: verify.** `npx tsc --build && npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/project-layout.test.tsx apps/web/test/shell.test.tsx apps/web/test/overview-components.test.tsx apps/web/test/tasks-components.test.tsx apps/web/test/graph-page.test.tsx apps/web/test/activity-page.test.tsx apps/web/test/project-header.test.tsx`; `npm run web:build && rm -rf apps/web/.next`; then `npm run gate:m15-boundary` → PASS (the middleware is untouched; this proves the layout did not break a page).

- [ ] **Step 8: Commit.**

```bash
git add "apps/web/src/app/w/[workspaceId]/layout.tsx" apps/web/src/components/OverviewClient.tsx apps/web/src/components/TasksClient.tsx apps/web/src/components/graph/GraphClient.tsx apps/web/src/components/activity/ActivityClient.tsx apps/web/src/components/Sidebar.tsx apps/web/src/app/layout.tsx apps/web/src/lib/format.ts apps/web/test/project-layout.test.tsx apps/web/test/shell.test.tsx apps/web/test/overview-components.test.tsx apps/web/test/tasks-components.test.tsx apps/web/test/graph-page.test.tsx apps/web/test/activity-page.test.tsx
git rm -q apps/web/src/components/TopBar.tsx apps/web/src/hooks/useProjectName.ts
git commit -m "feat(web): m24 t2 — one layout for a project, one list for the sidebar; the pages are tabs now"
```

---

### Task 3: Overview shows one thing

**Files:**
- Modify: `apps/web/src/components/OverviewClient.tsx`, `apps/web/src/server/overview.ts`
- Test: `apps/web/test/overview-components.test.tsx`, `apps/web/test/useOverview.test.tsx`, `apps/web/test/integration/overview.test.ts`

**Interfaces:**
- Produces `OverviewSnapshot` without `goalSuggestions`; `OverviewClient` without `GoalCard`/`RuntimeCard`.

- [ ] **Step 1: failing tests.** In `apps/web/test/overview-components.test.tsx` add:

```tsx
it('renders the strip and the agent cards and nothing else above them (M24 §3)', () => {
  render(<OverviewClient workspaceId="w1" initial={snapshot} />)  // the file's existing fixture
  expect(screen.queryByTestId('goal-input')).toBeNull()
  expect(screen.queryByTestId('runtime-provider')).toBeNull()
  expect(screen.queryByTestId('goal-suggestion')).toBeNull()
  expect(screen.getAllByTestId('agent-card').length).toBe(snapshot.agents.length)
})
```

In `apps/web/test/integration/overview.test.ts` find the case that asserts `goalSuggestions` (grep) and replace it with `expect('goalSuggestions' in snapshot).toBe(false)`. Run both → FAIL.

- [ ] **Step 2: slim the client.** In `OverviewClient.tsx` delete the `import { GoalCard }`, `import { RuntimeCard }` lines and the `<div className="grid … md:grid-cols-2">…</div>` block that holds them (the block between `<TopStrip snapshot={view} />` and `<main …>`). Rewrite the docstring paragraph that describes the goal/runtime row.

- [ ] **Step 3: drop the suggestions from the snapshot.** In `server/overview.ts` remove `GOAL_SUGGESTION_LIMIT`, `GOAL_HISTORY_SCAN`, the `goalEvents` query from the `Promise.all` (keep the array destructuring aligned), the `seenGoals`/`goalSuggestions` loop, the `readonly goalSuggestions` field and its docstring, and `goalSuggestions` from the returned object. `grep -rn goalSuggestions apps/web` → only the two tests you just edited.

- [ ] **Step 4: fixtures.** Every test fixture that builds an `OverviewSnapshot` with `goalSuggestions: []` (grep `goalSuggestions` under `apps/web/test`) drops the field.

- [ ] **Step 5: verify.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/overview-components.test.tsx apps/web/test/useOverview.test.tsx apps/web/test/integration/overview.test.ts`; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/OverviewClient.tsx apps/web/src/server/overview.ts apps/web/test/overview-components.test.tsx apps/web/test/useOverview.test.tsx apps/web/test/integration/overview.test.ts
git commit -m "feat(web): m24 t3 — Overview is the strip and the cards; the goal and the runtime moved out"
```

---

### Task 4: The project Settings tab

**Files:**
- Create: `apps/web/src/server/projectSettings.ts`, `apps/web/src/components/project/GoalPanel.tsx`, `apps/web/src/components/project/RuntimePanel.tsx`, `apps/web/src/components/project/ProjectSettingsClient.tsx`, `apps/web/src/app/w/[workspaceId]/settings/page.tsx`
- Modify: `apps/web/src/server/settings.ts` (`buildPermissionMatrix(workspaceId?)`)
- Delete: `apps/web/src/components/GoalCard.tsx`, `apps/web/src/components/RuntimeCard.tsx`, `apps/web/test/goal-card.test.tsx`, `apps/web/test/runtime-card.test.tsx`
- Test: `apps/web/test/project-settings.test.tsx` (new), `apps/web/test/integration/project-settings.test.ts` (new)

**Interfaces:**
- Produces `buildProjectSettings(workspaceId): Promise<ProjectSettings | null>` with
  `ProjectSettings = { workspace: { id; name; goal: string | null; provider: ProviderKind | null; budgetUsd: number | null; costBlindBudgeted: boolean; maxConcurrentRuns: number; runTimeoutMs: number; maxAttempts: number; haltedReason: string | null }; permissions: PermissionSection | null }`.
- `buildPermissionMatrix(workspaceId?: string)` — with an id, returns only that workspace's section (empty array if none).

- [ ] **Step 1: failing tests.** Create `apps/web/test/project-settings.test.tsx` — port the cases from `goal-card.test.tsx` and `runtime-card.test.tsx` (open both, keep every `it` that exercises a post, a refusal band or a disabled state; drop the suggestion-chip cases) against the new components, and add:

```tsx
describe('ProjectSettingsClient', () => {
  it('renders the four panels in order', () => {
    render(<ProjectSettingsClient settings={settings} />)  // fixture: goal null, provider 'claude_code', budgetUsd 2, limits 3/1_800_000/5, permissions one section, haltedReason null
    // `Panel` renders `PanelHeader` → `SectionLabel` as its first child when it has a title.
    const titles = screen.getAllByTestId('panel').map((p) => p.firstElementChild?.textContent?.trim().toLowerCase())
    expect(titles).toEqual(['goal', 'runtime', 'agent permissions', 'danger zone'])
  })
  it('shows the three limits read-only in the sidebar\'s old format', () => {
    render(<ProjectSettingsClient settings={settings} />)
    expect(screen.getByTestId('runtime-concurrency').textContent).toBe('3')
    expect(screen.getByTestId('runtime-timeout').textContent).toBe('30m')
    expect(screen.getByTestId('runtime-attempts').textContent).toBe('5')
    expect(screen.getByText(/not editable here yet/)).toBeTruthy()
  })
  it('scopes the permission matrix to this workspace', () => {
    render(<ProjectSettingsClient settings={settings} />)
    expect(screen.getAllByTestId(/^permission-matrix-/).length).toBe(1)
  })
  it('sets the goal then refreshes the route instead of waiting for a stream', async () => {
    render(<ProjectSettingsClient settings={settings} />)
    fireEvent.change(screen.getByTestId('goal-input'), { target: { value: 'Ship it' } })
    fireEvent.click(screen.getByTestId('goal-submit'))
    await waitFor(() => expect(postControl).toHaveBeenCalledWith('/api/w/w1/goal', { goal: 'Ship it' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })
  it('carries the emergency stop in the danger zone', () => {
    render(<ProjectSettingsClient settings={settings} />)
    expect(screen.getByTestId('emergency-stop')).toBeTruthy()
  })
})
```

Read `PanelHeader.tsx` to learn how the title is rendered and adjust the title selector. Mock `../src/lib/postControl` (`postControl`, `sendControl`) and `next/navigation` (`useRouter` → `{ refresh }`) as `goal-card.test.tsx` / `runtime-card.test.tsx` do today. Create `apps/web/test/integration/project-settings.test.ts`: seed a workspace (temp repoPath, unique name) with `goal`, `provider: 'cursor'`, `budgetUsd: 1`, one agent with one `AgentPermission` row; assert `buildProjectSettings(id)` returns those fields, `costBlindBudgeted === true` (cursor reports no cost, budgeted), and `permissions.workspaceId === id`; a second workspace's permissions do not appear; `null` for an unknown id.

Run both → FAIL.

- [ ] **Step 2: `buildPermissionMatrix(workspaceId?)`.** In `server/settings.ts` give the function an optional parameter and add `where: workspaceId === undefined ? undefined : { id: workspaceId }` to its `prisma.workspace.findMany` (and the same filter to the `agentPermission`/agent query if it is keyed by workspace — read the function). Existing callers pass nothing.

- [ ] **Step 3: `buildProjectSettings`.** Create `apps/web/src/server/projectSettings.ts`:

```ts
import { prisma } from '@ai-team-os/db/client'
import { capabilitiesOf, workspaceDefaultProvider, type ProviderKind } from '@ai-team-os/control'   // overview.ts's own import line
import { buildPermissionMatrix, type PermissionSection } from './settings'

export interface ProjectSettings {
  readonly workspace: {
    readonly id: string
    readonly name: string
    readonly goal: string | null
    readonly provider: ProviderKind | null
    readonly budgetUsd: number | null
    /** `overview.ts`'s rule, verbatim: a budgeted workspace whose provider reports no cost. */
    readonly costBlindBudgeted: boolean
    readonly maxConcurrentRuns: number
    readonly runTimeoutMs: number
    readonly maxAttempts: number
    readonly haltedReason: string | null
  }
  readonly permissions: PermissionSection | null
}

/** The project Settings tab's snapshot (M24 §4). A plain row read plus the one permission
 *  section; nothing streams here — every form calls `router.refresh()` after a write. */
export async function buildProjectSettings(workspaceId: string): Promise<ProjectSettings | null> {
  const [workspace, sections] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId } }),
    buildPermissionMatrix(workspaceId),
  ])
  if (workspace === null) return null
  const provider = workspaceDefaultProvider(workspace)   // the same mapping overview.ts uses for the provider column — read its call site and pass what it passes
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      goal: workspace.goal,
      provider,
      budgetUsd: workspace.budgetUsd,
      costBlindBudgeted: provider !== null && workspace.budgetUsd !== null && !capabilitiesOf(provider).reportsCost,
      maxConcurrentRuns: workspace.maxConcurrentRuns,
      runTimeoutMs: workspace.runTimeoutMs,
      maxAttempts: workspace.maxAttempts,
      haltedReason: workspace.haltedReason,
    },
    permissions: sections[0] ?? null,
  }
}
```

`workspaceDefaultProvider` is what `overview.ts` calls for this (grep it there); pass it exactly the argument `overview.ts` passes.

- [ ] **Step 4: `GoalPanel`.** `git mv apps/web/src/components/GoalCard.tsx apps/web/src/components/project/GoalPanel.tsx`; rename the export to `GoalPanel`; delete the `suggestions` prop, its docstring and the chip block; add `const router = useRouter()` (`next/navigation`) and `router.refresh()` after a successful post (mirroring `RuntimeCard`'s `submit`); keep the read-only branch when `goal !== null` but add a small `edit` button (`data-testid="goal-edit"`) that switches to the form with the current goal as the draft — the Settings tab is where a goal is CHANGED, which the Overview card never allowed. Fix the import paths (`../../lib/postControl`, `../ui/...`). Rewrite the docstring ("Overview's goal card" → "the Settings tab's goal panel").

- [ ] **Step 5: `RuntimePanel`.** `git mv apps/web/src/components/RuntimeCard.tsx apps/web/src/components/project/RuntimePanel.tsx`; export `RuntimePanel`; widen props with `readonly limits: { readonly maxConcurrentRuns: number; readonly runTimeoutMs: number; readonly maxAttempts: number }`; after the two forms (before the warnings) add:

```tsx
        <dl data-testid="runtime-limits" className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-[6px] border-t border-line pt-3 font-mono text-[10.5px]">
          <dt className="text-text-faint">concurrency</dt>
          <dd data-testid="runtime-concurrency" className="text-text-1">{limits.maxConcurrentRuns}</dd>
          <dt className="text-text-faint">run timeout</dt>
          <dd data-testid="runtime-timeout" className="text-text-1">{formatTimeout(limits.runTimeoutMs)}</dd>
          <dt className="text-text-faint">attempts</dt>
          <dd data-testid="runtime-attempts" className="text-text-1">{limits.maxAttempts}</dd>
        </dl>
        <p className="font-mono text-[10px] text-text-3">set in the workspace record; not editable here yet</p>
```

with `import { formatTimeout } from '../../lib/format'` (Task 2 moved it). Fix import paths; rewrite the docstring's first line.

- [ ] **Step 6: the client and the page.** Create `apps/web/src/components/project/ProjectSettingsClient.tsx`:

```tsx
'use client'

import type { ProjectSettings } from '../../server/projectSettings'
import { EmergencyStopButton } from '../EmergencyStopButton'
import { PermissionMatrix } from '../PermissionMatrix'
import { Panel } from '../ui/Panel'
import { GoalPanel } from './GoalPanel'
import { RuntimePanel } from './RuntimePanel'

/** The project Settings tab (M24 §4): goal, runtime, this project's permissions, the stop. */
export function ProjectSettingsClient({ settings }: { readonly settings: ProjectSettings }): React.JSX.Element {
  const { workspace, permissions } = settings
  return (
    <div className="flex flex-col gap-4 p-4">
      <GoalPanel workspaceId={workspace.id} goal={workspace.goal} />
      <RuntimePanel
        key={`${workspace.provider ?? ''}|${workspace.budgetUsd ?? ''}`}
        workspaceId={workspace.id}
        provider={workspace.provider}
        budgetUsd={workspace.budgetUsd}
        costBlindBudgeted={workspace.costBlindBudgeted}
        limits={{ maxConcurrentRuns: workspace.maxConcurrentRuns, runTimeoutMs: workspace.runTimeoutMs, maxAttempts: workspace.maxAttempts }}
      />
      <Panel title="agent permissions">
        <PermissionMatrix sections={permissions === null ? [] : [permissions]} />
      </Panel>
      <Panel title="danger zone">
        <div className="flex items-center gap-3 rounded-card border border-tone-blocked/22 p-3">
          <span className="text-xs text-text-2">stop every run in this project</span>
          <span className="ml-auto">
            <EmergencyStopButton workspaceId={workspace.id} halted={workspace.haltedReason !== null} />
          </span>
        </div>
      </Panel>
    </div>
  )
}
```

`GoalPanel` and `RuntimePanel` render their own `Panel` with titles `Goal`/`Runtime` (they already do). Create `apps/web/src/app/w/[workspaceId]/settings/page.tsx` in the shape of the sibling pages (`force-dynamic`, `params` promise, the `no workspace with id` fallback) calling `buildProjectSettings` and rendering `<ProjectSettingsClient key={workspaceId} settings={settings} />`.

- [ ] **Step 7: verify.** `npx tsc --build && npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/project-settings.test.tsx apps/web/test/integration/project-settings.test.ts apps/web/test/settings-page.test.tsx apps/web/test/project-tabs.test.tsx`; `npm run web:build && rm -rf apps/web/.next`. `grep -rn "GoalCard\|RuntimeCard" apps/web` → nothing.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/server/projectSettings.ts apps/web/src/server/settings.ts apps/web/src/components/project/GoalPanel.tsx apps/web/src/components/project/RuntimePanel.tsx apps/web/src/components/project/ProjectSettingsClient.tsx "apps/web/src/app/w/[workspaceId]/settings/page.tsx" apps/web/test/project-settings.test.tsx apps/web/test/integration/project-settings.test.ts
git rm -q apps/web/test/goal-card.test.tsx apps/web/test/runtime-card.test.tsx
git commit -m "feat(web): m24 t4 — a project's Settings tab: goal, runtime, its own permissions, the stop"
```

---

### Task 5: Global Settings shows three things

**Files:**
- Modify: `apps/web/src/components/SettingsClient.tsx`, `apps/web/src/components/DangerZone.tsx`, `apps/web/src/app/settings/page.tsx`
- Test: `apps/web/test/settings-page.test.tsx`

**Interfaces:**
- Produces `SettingsClient({ adapters, showReseed, mode, posture })`; `DangerZone({ showReseed })`.
- Task 6 consumes the templates/companies/roster props this task removes from Settings (they move to Projects).

- [ ] **Step 1: failing tests.** In `apps/web/test/settings-page.test.tsx` replace the panel-list assertion with `['provider adapters', 'security', 'danger zone']` (lower-cased titles, same selector as Task 4's test), add `expect(screen.queryByTestId('perm-caption')).toBeNull()`, `expect(screen.queryByTestId('create-workspace-form')).toBeNull()`, `expect(screen.queryByTestId('template-form')).toBeNull()`, `expect(screen.queryByTestId('company-form')).toBeNull()`, `expect(screen.queryByTestId('danger-workspace')).toBeNull()`, `expect(screen.queryByTestId('transport-sse')).toBeNull()`; keep the reseed two-step cases and the security/logout cases. Run → FAIL.

- [ ] **Step 2: `DangerZone` keeps only the reseed.** In `DangerZone.tsx` delete the transport panel (the `transport-sse`/`transport-ws` block), the `workspaces` prop, `selected`/`setSelectedId` state and the per-workspace `EmergencyStopButton` row (its home is the project Settings tab, Task 4). Props become `{ readonly showReseed: boolean }`; the panel is `<Panel title="danger zone">` holding the reseed row (or `null` when `!showReseed`). Rewrite the docstring; note the transport chooser's removal (it chose between SSE and a WebSocket "later" that never came — M24 Errata).

- [ ] **Step 3: `SettingsClient` to three panels.** Props `{ adapters, showReseed, mode, posture }`; remove the `Projects`, `Template catalog`, `Companies` and `agent permissions` panels and their imports. `app/settings/page.tsx` loads only `buildProviderAdapters()` and `currentPrincipal()`.

- [ ] **Step 4: verify.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/settings-page.test.tsx apps/web/test/emergency-stop.test.tsx`; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/SettingsClient.tsx apps/web/src/components/DangerZone.tsx apps/web/src/app/settings/page.tsx apps/web/test/settings-page.test.tsx
git commit -m "feat(web): m24 t5 — global Settings is adapters, security and the reset; everything else went home"
```

---

### Task 6: Projects — New project, and the team catalog

**Files:**
- Create: `apps/web/src/components/projects/NewProjectDrawer.tsx`
- Modify: `apps/web/src/components/ProjectsClient.tsx`, `apps/web/src/app/page.tsx`
- Test: `apps/web/test/projects-page.test.tsx`, `apps/web/test/projects-panel.test.tsx` (unchanged unless imports move)

**Interfaces:**
- Produces `ProjectsClient({ projects, companies, templates, roster })` with `templates: TemplateRow[]`, `roster: RosterCompany[]`, `companies: CompanyRow[]` (the same shapes `SettingsClient` took until Task 5); `NewProjectDrawer({ open, onClose })`.

- [ ] **Step 1: failing tests.** In `apps/web/test/projects-page.test.tsx` add (mock `next/navigation` with `useSearchParams: () => new URLSearchParams(search)`, `useRouter`, `usePathname`):

```tsx
it('has a New project button that opens the attach-a-repo drawer', () => {
  render(<ProjectsClient projects={projects} companies={companies} templates={[]} roster={[]} />)
  expect(screen.queryByTestId('create-workspace-form')).toBeNull()
  fireEvent.click(screen.getByTestId('new-project'))
  expect(screen.getByRole('dialog', { name: /new project/i })).toBeTruthy()
  expect(screen.getByTestId('create-workspace-form')).toBeTruthy()
})
it('opens the drawer on load when ?new=1 is in the URL', () => {
  search = 'new=1'
  render(<ProjectsClient projects={projects} companies={companies} templates={[]} roster={[]} />)
  expect(screen.getByTestId('create-workspace-form')).toBeTruthy()
})
it('closes the drawer on Escape and on the close button', () => { /* open, press Escape → gone; open, click new-project-close → gone */ })
it('renders the team catalog below the cards', () => {
  render(<ProjectsClient projects={projects} companies={companies} templates={[]} roster={[]} />)
  expect(screen.getByTestId('team-catalog')).toBeTruthy()
  expect(screen.getByTestId('template-form')).toBeTruthy()
  expect(screen.getByTestId('company-form')).toBeTruthy()
})
```

Run → FAIL.

- [ ] **Step 2: the drawer.** Create `apps/web/src/components/projects/NewProjectDrawer.tsx`:

```tsx
'use client'

import { useEffect } from 'react'
import { ProjectsPanel } from '../ProjectsPanel'

/**
 * "New project" (M24 §5.2): today's attach-a-repo form in a right-hand drawer. A `role="dialog"`
 * panel over a scrim rather than `<dialog>`, matching `AssignCompanyDialog`'s idiom; Escape and the
 * scrim close it. M26 replaces the body with the intake chat — the trigger, the `?new=1` opener
 * and this frame are the seam it lands in.
 */
export function NewProjectDrawer({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button type="button" aria-label="close" data-testid="new-project-scrim" onClick={onClose} className="flex-1 bg-black/50" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="New project"
        data-testid="new-project-drawer"
        className="flex w-[520px] max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New project</h2>
          <button type="button" data-testid="new-project-close" onClick={onClose} className="text-text-3 hover:text-text-1">
            ✕
          </button>
        </div>
        <p className="text-xs text-text-3">attach a local git repository as a project — its verify commands decide when a task is done</p>
        <ProjectsPanel />
      </aside>
    </div>
  )
}
```

- [ ] **Step 3: `ProjectsClient`.** Add the header row above the grid (`<div className="flex items-center justify-between px-[20px] pt-[18px]">` with a `SectionLabel`-styled `Projects` on the left and `<PrimaryButton data-testid="new-project" onClick={() => setNewOpen(true)}>+ New project</PrimaryButton>` on the right — read `ui/FormControls.tsx` for `PrimaryButton`'s props), state `const [newOpen, setNewOpen] = useState(useSearchParams().get('new') === '1')`, `<NewProjectDrawer open={newOpen} onClose={() => setNewOpen(false)} />`, and below the cards grid a `<section data-testid="team-catalog" className="flex flex-col gap-4 px-[20px] pb-[20px]">` with `<Panel title="Template catalog"><TemplateCatalog templates={templates} /></Panel>` and `<Panel title="Companies"><CompanyManager companies={companies} roster={roster} templates={templates} /></Panel>`. `companies` today is `CompanyOption[]` (id, name) — `CompanyRow` is the same two fields; use `CompanyRow` for both consumers. Wrap the whole return in a fragment/`div` since it grows from one grid to three blocks. Update `app/page.tsx` to load `listProjects(), listCompanies(), listTemplates(), listRoster()`.

- [ ] **Step 4: verify.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/projects-page.test.tsx apps/web/test/projects-panel.test.tsx`; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/projects/NewProjectDrawer.tsx apps/web/src/components/ProjectsClient.tsx apps/web/src/app/page.tsx apps/web/test/projects-page.test.tsx
git commit -m "feat(web): m24 t6 — Projects grows a New project drawer and the team catalog"
```

---

### Task 7: Agents — one table

**Files:**
- Create: `apps/web/src/components/AllAgentsTable.tsx`
- Modify: `apps/web/src/server/org.ts` (`listAllAgents`), `apps/web/src/components/AgentsClient.tsx`, `apps/web/src/app/agents/page.tsx`
- Delete: `apps/web/src/components/RosterTable.tsx`, `apps/web/src/components/WorkersTable.tsx`
- Test: `apps/web/test/integration/all-agents.test.ts` (new), `apps/web/test/all-agents-table.test.tsx` (new), `apps/web/test/agents-page.test.tsx` (rewritten)

**Interfaces:**
- Produces:

```ts
export interface AllAgentRow {
  /** `null` for a catalog member no project has materialized yet. */
  readonly agentId: string | null
  readonly companyAgentId: string | null
  readonly name: string
  readonly role: string
  readonly teamName: string
  readonly projectName: string | null
  readonly workspaceId: string | null
  readonly status: string
  readonly currentTask: CurrentTask | null
  readonly provider: ProviderKind | null
  readonly model: string | null
  readonly costUsd: number
  readonly unmeasuredRuns: number
}
export async function listAllAgents(): Promise<readonly AllAgentRow[]>
```

ordered by `projectName` (nulls last) then `name`. `AllAgentsTable({ initial: AllAgentRow[]; onOpen: (row: { agentId: string; workspaceId: string }) => void })` polls `/api/org/workers` every 5 s and merges `status`, `currentTask`, `provider`, `costUsd`, `unmeasuredRuns` into the rows whose `agentId` matches (catalog rows never change).

- [ ] **Step 1: failing tests.** `apps/web/test/integration/all-agents.test.ts` (TRUNCATE incl. `"CompanyAgent", "CompanyTeam", "Company", "AgentTemplate"`, the workspace fixture with a temp repoPath): seed a template, a company with one team and two catalog members, materialize ONE of them into a project agent (`Agent` with `companyAgentId`), plus a hand-made project agent with no `companyAgentId`; assert three rows: the two project agents first (ordered by name), the unmaterialized member last with `agentId: null`, `projectName: null`; the materialized one carries `companyAgentId`. `apps/web/test/all-agents-table.test.tsx`: renders one `data-table-row` per row; a project row shows `AgentRowActions` (`agent-name-edit`) and `ModelOverrideEditor`; a catalog row shows `project —` and no `agent-name-edit`; clicking a project row's name button calls `onOpen` with its ids; after 5 s (fake timers) a `fetch('/api/org/workers')` response updates the status pill of the matching row. Run → FAIL.

- [ ] **Step 2: `listAllAgents`.** In `server/org.ts`, after `listWorkers`:

```ts
/**
 * The Agents page's one table (M24 §5.3): every project agent (`listWorkers`) plus every catalog
 * member no project has materialized yet (`listRoster`'s members with no workers). The two lists
 * are the inputs on purpose — one place derives a worker's live status, one place walks the
 * model/provider chain — and this only lines their rows up.
 */
export async function listAllAgents(): Promise<readonly AllAgentRow[]> {
  const [workers, roster] = await Promise.all([listWorkers(), listRoster()])
  const workerRows: AllAgentRow[] = workers.map((w) => ({
    agentId: w.agentId,
    companyAgentId: null,           // filled below from the roster when the worker is roster-linked
    name: w.name,
    role: w.role,
    teamName: w.department,
    projectName: w.projectName,
    workspaceId: w.workspaceId,
    status: w.status,
    currentTask: w.currentTask,
    provider: w.provider,
    model: null,                    // filled below
    costUsd: w.costUsd,
    unmeasuredRuns: w.unmeasuredRuns,
  }))
  const byAgentId = new Map(workerRows.map((r) => [r.agentId, r] as const))
  const catalogRows: AllAgentRow[] = []
  for (const company of roster) {
    for (const team of company.teams) {
      for (const member of team.members) {
        if (member.workers.length === 0) {
          catalogRows.push({
            agentId: null, companyAgentId: member.companyAgentId, name: member.name, role: member.role,
            teamName: team.teamName, projectName: null, workspaceId: null, status: 'idle', currentTask: null,
            provider: member.effectiveProvider, model: member.effectiveModel, costUsd: 0, unmeasuredRuns: 0,
          })
        } else {
          for (const worker of member.workers) {
            const row = byAgentId.get(worker.agentId)
            if (row !== undefined) byAgentId.set(worker.agentId, { ...row, companyAgentId: member.companyAgentId, model: worker.model })
          }
        }
      }
    }
  }
  const projectRows = [...byAgentId.values()].sort((a, b) => (a.projectName ?? '').localeCompare(b.projectName ?? '') || a.name.localeCompare(b.name))
  catalogRows.sort((a, b) => a.name.localeCompare(b.name))
  return [...projectRows, ...catalogRows]
}
```

`AllAgentRow` is exported next to it; `CurrentTask`/`ProviderKind` are already imported in the file.

- [ ] **Step 3: `AllAgentsTable`.** Create `apps/web/src/components/AllAgentsTable.tsx` from `WorkersTable.tsx`'s skeleton (the `DataTable`/`Row` usage, the 5-second `fetch('/api/org/workers')` poll with its `document.hidden` skip and cleanup): columns `'200px 110px 130px 120px 110px 1fr 90px 90px 160px'` for agent · role · team · project · status · current task · provider · cost · actions; the agent cell is the `worker-row-button` (name button + `AvatarTile`) for project rows and plain text for catalog rows; `project` cell renders `—` for `null`; status via `StatusPill tone={toneForStatus(row.status)}`; current task as `WorkersTable` renders it; cost as `WorkersTable` renders `worker-cost`; the actions cell renders `<ModelOverrideEditor agentId model provider />` and `<AgentRowActions agentId name role />` only when `row.agentId !== null`. The poll merges: `setRows(prev => prev.map(r => { const w = byId.get(r.agentId); return w ? { ...r, status: w.status, currentTask: w.currentTask, provider: w.provider, costUsd: w.costUsd, unmeasuredRuns: w.unmeasuredRuns } : r }))`. Keep `toneForStatus` where it is (`AgentsClient.tsx` exports it).

- [ ] **Step 4: `AgentsClient` to two tabs.** `type Tab = 'agents' | 'teams'`; `TABS = [{ id: 'agents', label: 'Agents' }, { id: 'teams', label: 'Teams' }]`; props `{ agents: readonly AllAgentRow[]; teams: readonly ProjectTeamRow[] }`; default tab `'agents'`; render `<AllAgentsTable initial={agents} onOpen={(row) => setSelected(row)} />` — keep the `selected`/`panelAgent` logic and the `AgentPanel` mount as they are (they key off `agentId` + `workspaceId`). Rewrite the docstrings that describe three tabs. `app/agents/page.tsx` loads `listAllAgents()` and `listProjectTeams()`. Delete `RosterTable.tsx` and `WorkersTable.tsx`; `grep -rn "RosterTable\|WorkersTable\|agents-tab-workers\|agents-tab-roster" apps/web/src apps/web/test` → nothing outside the rewritten tests.

- [ ] **Step 5: `agents-page.test.tsx`.** Rewrite: two tabs (`agents-tab-agents` selected by default, `agents-tab-teams`); the table renders the fixture rows; the Teams tab renders `TeamsTable`; the panel opens on a row click (keep the existing panel case, adapting the fixture from `WorkerRow` to `AllAgentRow`).

- [ ] **Step 6: verify.** `npx tsc --build && npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/integration/all-agents.test.ts apps/web/test/all-agents-table.test.tsx apps/web/test/agents-page.test.tsx apps/web/test/agent-row-actions.test.tsx apps/web/test/teams-table.test.tsx`; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/server/org.ts apps/web/src/components/AllAgentsTable.tsx apps/web/src/components/AgentsClient.tsx apps/web/src/app/agents/page.tsx apps/web/test/integration/all-agents.test.ts apps/web/test/all-agents-table.test.tsx apps/web/test/agents-page.test.tsx
git rm -q apps/web/src/components/RosterTable.tsx apps/web/src/components/WorkersTable.tsx
git commit -m "feat(web): m24 t7 — every agent in one table; Roster and Workers were two names for it"
```

---

### Task 8: The task card says less; the panel says the rest

**Files:**
- Modify: `apps/web/src/components/TaskCard.tsx`, `apps/web/src/components/TaskDetailPanel.tsx`
- Test: `apps/web/test/tasks-components.test.tsx`

- [ ] **Step 1: failing tests.** In `tasks-components.test.tsx`: the two `task-ref`/`task-priority` assertions on the CARD (lines ~94 and ~433) become `expect(screen.queryByTestId('task-ref')).toBeNull()` / `expect(screen.queryByTestId('task-priority')).toBeNull()`; add to the panel's describe: `expect(screen.getByTestId('task-panel-ref').textContent).toBe('TASK-3f9a21c8')` and `expect(screen.getByTestId('task-panel-priority').textContent).toBe('HIGH')` for the fixture task. Run → FAIL.

- [ ] **Step 2: the card.** In `TaskCard.tsx` delete the `task-ref` and `task-priority` spans; the first row becomes `<span className="flex items-baseline justify-end"><StatusPill … /></span>` (pill alone, right-aligned) followed by the title. Drop the now-unused `priorityChip`/`TONE_TEXT` imports if nothing else in the file uses them. Rewrite the docstring ("mono id, priority chip, title…" → "title, status pill, assignee, step counter — the id and priority live in the panel (M24 §5.4)").

- [ ] **Step 3: the panel.** In `TaskDetailPanel.tsx` above the `<h2>` at ~line 93 add:

```tsx
          <p className="flex items-baseline gap-[7px] font-mono text-[9.5px] font-medium">
            <span data-testid="task-panel-ref" className="text-text-3">TASK-{task.id.slice(0, 8)}</span>
            <span data-testid="task-panel-priority" className={TONE_TEXT[priorityChip(task.priority).tone]}>{priorityChip(task.priority).label}</span>
          </p>
```

importing `priorityChip` from `../lib/taskColumns` and `TONE_TEXT` from `./ui/StatusPill` as `TaskCard` did. Check the panel's `task` prop carries `priority` (grep the panel's prop type; `TaskBoardItem` does).

- [ ] **Step 4: verify + commit.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/tasks-components.test.tsx apps/web/test/taskColumns.test.ts`; `npm run web:build && rm -rf apps/web/.next`.

```bash
git add apps/web/src/components/TaskCard.tsx apps/web/src/components/TaskDetailPanel.tsx apps/web/test/tasks-components.test.tsx
git commit -m "feat(web): m24 t8 — the task card keeps its title and its state; the id and priority moved to the panel"
```

---

### Task 9: Gates follow the moved elements; Errata; closing run

**Files:**
- Modify: `scripts/gate-m14-fidelity.mjs`, `scripts/gate-m16-chrome.mjs`, `scripts/gate-m11-shell.mjs`, `scripts/gate-m18-skill-and-teeth.mjs`, `docs/superpowers/fidelity/m14/*.png` (regenerated), `docs/superpowers/specs/2026-09-04-m24-shell-tabs-and-simpler-pages-design.md` (§10 Errata), `README.md` (the Web UI table: Settings tab row; Agents wording)

- [ ] **Step 1: inventory.** `grep -nE "guardrail|top-bar|goal-suggestion|runtime-|perm-|roster|workers|agents-tab-|create-workspace|template-|company-|task-ref|task-priority|project-section|nav-badge|transport-|danger-workspace" scripts/gate-m14-fidelity.mjs scripts/gate-m16-chrome.mjs scripts/gate-m11-shell.mjs scripts/gate-m18-skill-and-teeth.mjs` and write the list into the report before editing.

- [ ] **Step 2: m14.** In `gate-m14-fidelity.mjs`: the `NUMBERS` table — rows on `top-bar` → `project-header` (52px stays), rows on `guardrail-*` → removed (the block is gone) with a replacement row reading `runtime-timeout` on `/w/<id>/settings` (`font-size` 10.5px mono), rows on `roster*`/`agents-tab-workers` → the `agents-tab-agents` tab and a `data-table-row` of `AllAgentsTable`; the nine-page screenshot list gains no page (Settings tab replaces nothing) but the Settings screenshot is the GLOBAL settings page as before; stage that asserts `perm-caption` moves to `/w/<id>/settings`; `emergency-stop-confirm` is now reachable from the header on any project page. Run `AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" CHROMIUM_PATH=<playwright chromium> npm run gate:m14-fidelity` → PASS, regenerating the nine PNGs; `git add docs/superpowers/fidelity/m14/*.png`.

- [ ] **Step 3: m16.** `gate-m16-chrome.mjs` reads `goal-input`/`goal-submit` (now on `/w/<id>/settings`), `perm-cell-*`/`perm-caption` (same page), `roster` (→ `agents-tab-agents` + a row), `project-card` (unchanged). Update the URLs and selectors; run → PASS.

- [ ] **Step 4: m11.** `gate-m11-shell.mjs` drives the roster UI end to end (15 `roster*` selectors, `company-*`, `template-submit`, `budget`): the template/company stages move to `/` (the Team catalog section, same testids); the roster stages become assertions on `AllAgentsTable` rows (`data-table-row` containing the member's name, `project —` for an unmaterialized member, a project name once assigned); `budget` reads the header on a project page. Run → PASS.

- [ ] **Step 5: m18.** `gate-m18-skill-and-teeth.mjs` reads `guardrail*` (9×) and `connection` (7×): guardrail reads move to `/w/<id>/settings` `runtime-*` testids; `connection` is still `connection`, now inside `project-header`. Run `AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" CHROMIUM_PATH=… npm run gate:m18-skill-and-teeth` → PASS.

- [ ] **Step 6: Errata + README.** Spec §10: numbered entries for every controller ruling recorded in the SDD ledger for this plan (the executor's `progress.md`), plus: the transport chooser removed with the danger zone (Task 5); `GoalPanel` gained an edit button (Task 4). README Web UI table: the Graph row unchanged; add a `Settings` tab row (`/w/<id>/settings` — goal, runtime, this project's permissions, emergency stop); the Agents row says "one table + Teams"; the Settings row (global) says "provider adapters, security, reset demo data"; Projects row mentions "New project" and the team catalog.

- [ ] **Step 7: closing run.** `npm run typecheck`; `npm test`; `npm run web:build && rm -rf apps/web/.next`; gates in order, none overlapping: `gate:m15-boundary`, `gate:m20-auth`, `gate:m21-loose-ends`, `gate:m23-onboarding`, `gate:m14-fidelity`, `gate:m16-chrome`, `gate:m11-shell`, `gate:m18-skill-and-teeth`. Record every PASS line.

- [ ] **Step 8: Commit.**

```bash
git add scripts/gate-m14-fidelity.mjs scripts/gate-m16-chrome.mjs scripts/gate-m11-shell.mjs scripts/gate-m18-skill-and-teeth.mjs docs/superpowers/fidelity/m14 docs/superpowers/specs/2026-09-04-m24-shell-tabs-and-simpler-pages-design.md README.md
git commit -m "test(gates),docs: m24 t9 — the gates read the moved elements; the errata and the README say where things are"
```

## Closing verification (after Task 9, before the final review)

- Everything in Task 9 Step 7 green at HEAD.
- Final whole-branch review (most capable model), one fix wave, one scoped re-review; then merge fast-forward, push (the pre-push hook runs the suite — budget 600 s), update the memory backlog line.

## Self-review against the spec

- §2.1 sidebar → T2. §2.2 layout/header/tabs → T1, T2. §2.3 table → T2–T7. §3 Overview → T3. §4 Settings tab → T4. §5.1 → T5. §5.2 → T6. §5.3 → T7. §5.4 → T8. §6 files → per task. §7 tests/gates → per task + T9. §8 constraints → header. §9 order → T1…T9. §10 Errata → T9.
- Types: `ShellFacts.status` (T1) is what `ProjectHeader` (T1), the clients (T2) and `shell-facts.test.ts` (T1) use; `StreamState` (T1) ↔ `publishStreamState` calls (T2); `ProjectSettings` (T4) ↔ `ProjectSettingsClient` (T4); `AllAgentRow` (T7) ↔ `AllAgentsTable`/`AgentsClient` (T7); `formatTimeout` moves in T2 and is consumed in T4.
- Placeholders: none — where a step says "read X and copy its Y", X and Y are named files and symbols that exist at plan time.
