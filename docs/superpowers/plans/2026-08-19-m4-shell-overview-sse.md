# M4: App Shell, Overview, and SSE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser Overview that shows a real agent's real work live — app shell, snapshot read
model, SSE stream, and a one-command demo.

**Architecture:** `apps/web` (Next.js App Router, read-only) renders from a server-side snapshot
built with domain derivations; an SSE route wraps M2's `createEventStream`; the client treats
events as wake-ups that trigger a debounced snapshot refetch, except the live action line, which
updates straight from `run.tool_call` payloads as display-only ephemera.

**Tech Stack:** Next.js 15 (App Router, Node runtime), React 19, Tailwind CSS v4, Prisma via
`@ai-team-os/db`, `@ai-team-os/events`, Vitest + Testing Library (jsdom) for components,
integration tests against the real test database.

**Spec:** `docs/superpowers/specs/2026-08-19-m4-shell-overview-sse-design.md`

## Global Constraints

- Node `>=26`, npm workspaces, `"type": "module"` everywhere.
- `apps/web` may import `@ai-team-os/db`, `@ai-team-os/domain`, `@ai-team-os/events` — and must
  never import `apps/orchestrator` or `@ai-team-os/providers` (spec §2).
- The web app performs **zero database writes** — no INSERT, no UPDATE, anywhere (spec §2).
- Dark theme only; status colours are the only saturation on screen; motion only where it carries
  information (spec §7).
- Integration tests live under `test/integration/` (they hit the real test database and are picked
  up by the root vitest `integration` project, single-threaded, `require-database` setup). Unit and
  component tests live under `test/` outside `integration/`.
- Every task ends with `npm test && npm run typecheck` green before its commit.
- The test database must be up: `docker compose up -d`.

---

## Task 1: `apps/web` scaffold, tokens, and shell chrome

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`,
  `apps/web/tsconfig.json`, `apps/web/next-env.d.ts` (generated),
  `apps/web/src/app/layout.tsx`, `apps/web/src/app/globals.css`, `apps/web/src/app/page.tsx`
  (placeholder this task, real in Task 3), `apps/web/src/components/Sidebar.tsx`,
  `apps/web/src/components/TopBar.tssx` → **`TopBar.tsx`**
- Modify: root `package.json` (scripts + devDeps), root `vitest.config.ts` (react plugin),
  root `tsconfig.json` is NOT modified (Next owns web's build; web is not a composite project)
- Test: `apps/web/test/shell.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the shell — `Sidebar` (nav: Overview active; Tasks, Activity, Graph disabled) and
  `TopBar({ workspaceName, connection, budget }: { workspaceName: string; connection: 'connected' | 'reconnecting'; budget: { spentUsd: number; budgetUsd: number } | null })`;
  the token palette in `globals.css` (CSS variables listed below) that every later component uses;
  `npm run web` (dev) and `npm run web:build`.

- [ ] **Step 1: Create the package manifest and config files**

`apps/web/package.json`:

```json
{
  "name": "@ai-team-os/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "@ai-team-os/db": "*",
    "@ai-team-os/domain": "*",
    "@ai-team-os/events": "*",
    "next": "^15.4.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tailwindcss": "^4.0.0"
  }
}
```

`apps/web/next.config.ts`:

```ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  // Workspace packages ship compiled ESM with .js specifiers; transpile keeps Next's bundler
  // from tripping on them and keeps one build graph.
  transpilePackages: ['@ai-team-os/db', '@ai-team-os/domain', '@ai-team-os/events'],
}

export default config
```

`apps/web/postcss.config.mjs`:

```js
export default { plugins: { '@tailwindcss/postcss': {} } }
```

`apps/web/tsconfig.json` (Next's own; not part of the root `tsc --build` graph):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "test"]
}
```

- [ ] **Step 2: Write the tokens and the shell**

`apps/web/src/app/globals.css` — Tailwind v4 plus the binding token set from spec §7:

```css
@import 'tailwindcss';

:root {
  /* Layered neutral backgrounds — dark only (spec §7). */
  --bg-0: #0a0c10;
  --bg-1: #10141b;
  --bg-2: #171c26;
  --line: #232a37;
  --text-1: #e6e9ef;
  --text-2: #8b93a3;
  --text-3: #5c6474;

  /* Status colours: the ONLY saturation on screen. */
  --status-working: #34d399;
  --status-starting: #22d3ee; /* also resuming */
  --status-paused: #60a5fa;   /* also pausing */
  --status-stopping: #fb923c;
  --status-idle: #5c6474;
  --status-danger: #f87171;   /* halt, failed, over budget */
  --status-warn: #fbbf24;     /* budget past 80% */

  --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}

@theme inline {
  --color-bg-0: var(--bg-0);
  --color-bg-1: var(--bg-1);
  --color-bg-2: var(--bg-2);
  --color-line: var(--line);
  --color-text-1: var(--text-1);
  --color-text-2: var(--text-2);
  --color-text-3: var(--text-3);
  --color-status-working: var(--status-working);
  --color-status-starting: var(--status-starting);
  --color-status-paused: var(--status-paused);
  --color-status-stopping: var(--status-stopping);
  --color-status-idle: var(--status-idle);
  --color-status-danger: var(--status-danger);
  --color-status-warn: var(--status-warn);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
}

body {
  background: var(--bg-0);
  color: var(--text-1);
  font-family: var(--font-sans);
}
```

`apps/web/src/components/Sidebar.tsx`:

```tsx
const NAV = [
  { label: 'Overview', enabled: true },
  { label: 'Tasks', enabled: false },
  { label: 'Activity', enabled: false },
  { label: 'Graph', enabled: false },
] as const

/** The roadmap rendered as chrome: future pages are visible but inert (spec §7). */
export function Sidebar(): React.JSX.Element {
  return (
    <nav aria-label="Primary" className="flex w-44 shrink-0 flex-col gap-1 border-r border-line bg-bg-1 p-3">
      {NAV.map((item) =>
        item.enabled ? (
          <span key={item.label} aria-current="page" className="rounded px-2 py-1.5 text-sm bg-bg-2 text-text-1">
            {item.label}
          </span>
        ) : (
          <span key={item.label} aria-disabled="true" title="arrives in a later milestone" className="rounded px-2 py-1.5 text-sm text-text-3">
            {item.label}
          </span>
        ),
      )}
    </nav>
  )
}
```

`apps/web/src/components/TopBar.tsx`:

```tsx
export interface TopBarProps {
  readonly workspaceName: string
  readonly connection: 'connected' | 'reconnecting'
  readonly budget: { readonly spentUsd: number; readonly budgetUsd: number } | null
}

export function TopBar({ workspaceName, connection, budget }: TopBarProps): React.JSX.Element {
  const ratio = budget === null || budget.budgetUsd <= 0 ? 0 : budget.spentUsd / budget.budgetUsd
  const barColor = ratio >= 1 ? 'bg-status-danger' : ratio >= 0.8 ? 'bg-status-warn' : 'bg-status-working'
  return (
    <header className="flex h-12 items-center gap-4 border-b border-line bg-bg-1 px-4">
      <span className="text-sm font-medium">{workspaceName}</span>
      <span data-testid="connection" className="flex items-center gap-1.5 text-xs text-text-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${connection === 'connected' ? 'bg-status-working' : 'bg-status-warn'}`}
        />
        {connection}
      </span>
      {budget !== null && (
        <span data-testid="budget" className="ml-auto flex items-center gap-2 text-xs text-text-2">
          <span className="font-mono">
            ${budget.spentUsd.toFixed(2)} / ${budget.budgetUsd.toFixed(2)}
          </span>
          <span className="h-1.5 w-24 overflow-hidden rounded bg-bg-2">
            <span className={`block h-full ${barColor}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
          </span>
        </span>
      )}
    </header>
  )
}
```

`apps/web/src/app/layout.tsx`:

```tsx
import './globals.css'

export const metadata = { title: 'AI Team OS' }

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body className="flex min-h-screen">{children}</body>
    </html>
  )
}
```

`apps/web/src/app/page.tsx` (placeholder until Task 3):

```tsx
export default function Home(): React.JSX.Element {
  return <main className="p-6 text-text-2">AI Team OS</main>
}
```

- [ ] **Step 3: Wire the root scripts and test infrastructure**

Root `package.json` — add scripts and devDeps:

```json
"web": "next dev apps/web",
"web:build": "next build apps/web",
"demo": "tsc --build && node --env-file=.env scripts/demo-live.mjs"
```

(the `demo` script lands here now but its file arrives in Task 7 — running it before then fails
loudly with "module not found", which is acceptable for an unreleased tree)

devDependencies to add at root: `"@vitejs/plugin-react": "^4.3.0"`, `"jsdom": "^26.0.0"`,
`"@testing-library/react": "^16.0.0"`.

Root `vitest.config.ts` — add the react plugin at top level and nothing else:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    // ...existing content unchanged
  },
})
```

Component tests opt into jsdom per file with a docblock (no new vitest project):

```ts
// @vitest-environment jsdom
```

Root `package.json` `typecheck` script — append `&& npm run web:build -- --no-lint` is NOT used
(build is slow); instead append a plain tsc pass over the web sources:
`&& tsc -p apps/web/tsconfig.json`. Note `next-env.d.ts` must exist for this to pass — `next dev`
or `next build` generates it once; commit it.

Run: `npm install`

- [ ] **Step 4: Write the failing shell test**

`apps/web/test/shell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sidebar } from '../src/components/Sidebar.js'
import { TopBar } from '../src/components/TopBar.js'

describe('the shell', () => {
  it('shows Overview as the one enabled destination', () => {
    render(<Sidebar />)
    expect(screen.getByText('Overview')).toHaveProperty('ariaCurrent', 'page')
    // The disabled entries are the roadmap rendered as chrome — present, inert, and honest
    // about why (spec §7). Rendering them enabled would invite clicks into nothing.
    for (const label of ['Tasks', 'Activity', 'Graph']) {
      expect(screen.getByText(label).getAttribute('aria-disabled')).toBe('true')
    }
  })

  it('turns the budget bar amber past 80% and red past 100%', () => {
    const { rerender } = render(
      <TopBar workspaceName="W" connection="connected" budget={{ spentUsd: 85, budgetUsd: 100 }} />,
    )
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-status-warn')
    rerender(<TopBar workspaceName="W" connection="connected" budget={{ spentUsd: 101, budgetUsd: 100 }} />)
    expect(screen.getByTestId('budget').innerHTML).toContain('bg-status-danger')
  })

  it('reports the connection state it was given', () => {
    render(<TopBar workspaceName="W" connection="reconnecting" budget={null} />)
    expect(screen.getByTestId('connection').textContent).toContain('reconnecting')
  })
})
```

- [ ] **Step 5: Run the test, watch it fail, make it pass**

Run: `npx vitest run apps/web/test/shell.test.tsx`
Expected first: FAIL (components missing or assertions unmet), then PASS after Step 2's files are
in place. (`toHaveProperty('ariaCurrent', 'page')` works without jest-dom matchers.)

- [ ] **Step 6: Verify the app builds and the suite is green**

Run: `npm run web:build && npm test && npm run typecheck`
Expected: Next build succeeds; all tests pass; typecheck green.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): scaffold the app shell with mission-control tokens"
```

---

## Task 2: The snapshot read model

**Files:**
- Create: `apps/web/src/server/overview.ts`
- Modify: `packages/domain/src/run/state.ts` (export `NON_TERMINAL_RUN_STATUSES`),
  `apps/orchestrator/src/world.ts` (re-export from domain instead of its own literal)
- Test: `apps/web/test/integration/overview.test.ts`

**Interfaces:**
- Consumes: `deriveAgentStatus(activeRun: RunState | null): AgentStatus` and
  `toRunState(row)` from `@ai-team-os/db`; Prisma via `prisma` from `@ai-team-os/db/client`.
- Produces:

```ts
export interface AgentCardData {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly provider: 'claude-code'
  readonly status: AgentStatus // from @ai-team-os/domain
  readonly taskTitle: string | null
  readonly actionLine: string | null
  readonly runId: string | null
}

export interface OverviewSnapshot {
  readonly workspace: {
    readonly id: string
    readonly name: string
    readonly haltedReason: string | null
    readonly haltedAt: string | null
    readonly budgetUsd: number
    readonly spentUsd: number
  }
  readonly agents: readonly AgentCardData[]
  readonly tasks: { readonly active: number; readonly blocked: number; readonly done: number; readonly failed: number }
}

export async function buildOverviewSnapshot(workspaceId: string): Promise<OverviewSnapshot | null>
```

`null` means "no such workspace" — the route turns it into a 404. Later tasks (3, 5, 6) rely on
these exact names.

- [ ] **Step 1: Lift the non-terminal status list into the domain**

`packages/domain/src/run/state.ts` — add (the list `apps/orchestrator/src/world.ts` currently
holds as its own literal):

```ts
/** Every status that means "this run is not finished". The web and the orchestrator must agree. */
export const NON_TERMINAL_RUN_STATUSES = [
  'starting',
  'working',
  'pause_requested',
  'paused',
  'resuming',
  'stopping',
] as const
```

`apps/orchestrator/src/world.ts` — replace its own literal with a re-export:

```ts
export { NON_TERMINAL_RUN_STATUSES } from '@ai-team-os/domain'
```

(keep the same exported name so `cli.ts`'s import keeps working; adjust the import in `world.ts`
itself where the constant is used). Run `npm test` — the orchestrator suite proves the swap changed
nothing.

- [ ] **Step 2: Write the failing integration tests**

`apps/web/test/integration/overview.test.ts` — same fixture style as the orchestrator's tests
(truncate, seed with Prisma, assert):

```ts
import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildOverviewSnapshot } from '../../src/server/overview.js'

interface Fixture {
  readonly workspaceId: string
  readonly agentId: string
  readonly taskId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/overview-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 100,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Add the thing',
      description: 'x',
      status: 'running',
      requiredRole: 'backend',
      maxAttempts: 3,
    },
  })
  return { workspaceId: workspace.id, agentId: agent.id, taskId: task.id }
}

describe('buildOverviewSnapshot', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('returns null for a workspace that does not exist', async (): Promise<void> => {
    expect(await buildOverviewSnapshot('nope')).toBeNull()
  })

  it('derives the agent status from its active run with the domain function', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'pause_requested' },
    })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // 'pausing', not 'pause_requested': ADR 0002's derivation is the only translator, and the UI
    // rendering raw run statuses would drift the moment the domain adds a status.
    expect(snapshot?.agents[0]?.status).toBe('pausing')
    expect(snapshot?.agents[0]?.taskTitle).toBe('Add the thing')
    expect(snapshot?.agents[0]?.runId).toBe(run.id)
  })

  it('reports an agent with no live run as idle with no task', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'succeeded',
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // A finished run must not keep its agent looking busy — the derivation maps terminal to idle,
    // and the card must not resurrect the dead run's task title either.
    expect(snapshot?.agents[0]?.status).toBe('idle')
    expect(snapshot?.agents[0]?.taskTitle).toBeNull()
    expect(snapshot?.agents[0]?.actionLine).toBeNull()
  })

  it('sums budget spend across every run regardless of status', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working', costUsd: 1.5 },
    })
    await prisma.agentRun.create({
      data: {
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        status: 'failed',
        costUsd: 2.5,
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // loadWorld's rule (M3): money is spent whether or not the run is still going. A gauge that
    // forgot failed runs would show a workspace under budget while the bank account disagrees.
    expect(snapshot?.workspace.spentUsd).toBeCloseTo(4.0)
    expect(snapshot?.workspace.budgetUsd).toBe(100)
  })

  it('seeds the action line from the latest run.tool_call event', async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { taskId: fixture.taskId, agentId: fixture.agentId, status: 'working' },
    })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { activeRunId: run.id } })
    for (const summary of ['Read README.md', 'Write note1.txt']) {
      await appendEvent({
        type: 'run.tool_call',
        workspaceId: fixture.workspaceId,
        taskId: fixture.taskId,
        agentId: fixture.agentId,
        runId: run.id,
        actor: 'agent',
        payload: { name: summary.split(' ')[0] ?? '', summary },
      })
    }

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // The latest one, not the first: a card that opens on a stale line contradicts the live line
    // the stream is about to draw over it.
    expect(snapshot?.agents[0]?.actionLine).toBe('Write note1.txt')
  })

  it('counts tasks into the strip buckets', async (): Promise<void> => {
    for (const status of ['ready', 'blocked', 'done', 'failed', 'rework'] as const) {
      await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          title: status,
          description: 'x',
          status,
          requiredRole: 'backend',
          maxAttempts: 3,
        },
      })
    }

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    // Active = ready/running/verifying/rework (spec §5). The seeded fixture task is `running`.
    expect(snapshot?.tasks).toEqual({ active: 3, blocked: 1, done: 1, failed: 1 })
  })

  it('carries the halt verbatim', async (): Promise<void> => {
    await prisma.workspace.update({
      where: { id: fixture.workspaceId },
      data: { haltedReason: 'the pause gate failed open (PreToolUse:Write exited 127)', haltedAt: new Date() },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.workspace.haltedReason).toContain('PreToolUse:Write')
    expect(snapshot?.workspace.haltedAt).not.toBeNull()
  })

  it('does not leak another workspace\'s agents or tasks', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other', verifyCommands: ['true'], setupCommands: [] },
    })
    const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'T' } })
    await prisma.agent.create({ data: { teamId: otherTeam.id, name: 'Zoe', role: 'backend' } })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)

    expect(snapshot?.agents.map((a) => a.name)).toEqual(['Alex'])
  })
})
```

- [ ] **Step 3: Run them, watch them fail**

Run: `npx vitest run apps/web/test/integration/overview.test.ts`
Expected: FAIL — `overview.js` does not exist.

- [ ] **Step 4: Implement `buildOverviewSnapshot`**

`apps/web/src/server/overview.ts`:

```ts
import { prisma } from '@ai-team-os/db/client'
import { toRunState } from '@ai-team-os/db'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES, type AgentStatus } from '@ai-team-os/domain'

// interfaces exactly as in this task's Produces block

const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'rework'] as const

export async function buildOverviewSnapshot(workspaceId: string): Promise<OverviewSnapshot | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const agents = await prisma.agent.findMany({
    where: { team: { workspaceId } },
    orderBy: { name: 'asc' },
  })

  // One live run per agent at most (the scheduler enforces it); latest by startedAt breaks any
  // fixture-made tie deterministically.
  const liveRuns = await prisma.agentRun.findMany({
    where: {
      agentId: { in: agents.map((a) => a.id) },
      status: { in: [...NON_TERMINAL_RUN_STATUSES] },
    },
    orderBy: { startedAt: 'desc' },
    include: { task: true },
  })
  const liveRunByAgent = new Map<string, (typeof liveRuns)[number]>()
  for (const run of liveRuns) {
    if (!liveRunByAgent.has(run.agentId)) liveRunByAgent.set(run.agentId, run)
  }

  // Initial action lines: the latest run.tool_call per live run, so a freshly opened page is not
  // blank until the next event. DB enum value is `run_tool_call`.
  const lines = new Map<string, string>()
  for (const run of liveRunByAgent.values()) {
    const event = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_tool_call' },
      orderBy: { seq: 'desc' },
    })
    if (event !== null) {
      const summary = (event.payload as { summary?: string }).summary
      if (typeof summary === 'string') lines.set(run.agentId, summary)
    }
  }

  const [spent, taskGroups] = await Promise.all([
    prisma.agentRun.aggregate({ where: { task: { workspaceId } }, _sum: { costUsd: true } }),
    prisma.task.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
  ])
  const countOf = (statuses: readonly string[]): number =>
    taskGroups.filter((g) => statuses.includes(g.status)).reduce((n, g) => n + g._count._all, 0)

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      haltedReason: workspace.haltedReason,
      haltedAt: workspace.haltedAt?.toISOString() ?? null,
      budgetUsd: workspace.budgetUsd,
      spentUsd: spent._sum.costUsd ?? 0,
    },
    agents: agents.map((agent) => {
      const run = liveRunByAgent.get(agent.id) ?? null
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        // The single registered adapter (M3 §17.5). A column arrives with a second provider.
        provider: 'claude-code' as const,
        status: deriveAgentStatus(run === null ? null : toRunState(run)),
        taskTitle: run?.task.title ?? null,
        actionLine: lines.get(agent.id) ?? null,
        runId: run?.id ?? null,
      }
    }),
    tasks: {
      active: countOf([...ACTIVE_TASK_STATUSES]),
      blocked: countOf(['blocked']),
      done: countOf(['done']),
      failed: countOf(['failed']),
    },
  }
}
```

Check `toRunState`'s exact input shape in `packages/db/src/mappers.ts` before wiring — if it wants
a narrower row type than Prisma's `AgentRun`, pass the fields it names. Check `Workspace.budgetUsd`
is the schema's spelling (it is — the tick tests update it).

- [ ] **Step 5: Run the tests until green**

Run: `npx vitest run apps/web/test/integration/overview.test.ts`
Expected: PASS (all 7).

- [ ] **Step 6: Mutation pass**

Measure, one at a time, reverting after each: (1) replace `deriveAgentStatus(...)` with the raw
run status string — the `pausing` test must fail; (2) filter the spend sum to non-terminal runs —
the budget test must fail; (3) take the *first* tool_call instead of the latest (`orderBy: seq
asc`) — the action-line test must fail; (4) drop the workspace filter on agents — the leak test
must fail. Any survivor means the test is not pinning the behaviour: fix the test, not the note.

- [ ] **Step 7: Full suite and commit**

Run: `npm test && npm run typecheck`

```bash
git add -A && git commit -m "feat(web): add the Overview snapshot read model"
```

---

## Task 3: Routes and workspace resolution

**Files:**
- Create: `apps/web/src/app/api/w/[workspaceId]/overview/route.ts`,
  `apps/web/src/server/workspaces.ts`, `apps/web/src/app/w/[workspaceId]/page.tsx` (server shell
  that renders a placeholder `<pre>` of the snapshot this task; Task 6 replaces the body)
- Modify: `apps/web/src/app/page.tsx` (real workspace resolution)
- Test: `apps/web/test/integration/routes.test.ts`

**Interfaces:**
- Consumes: `buildOverviewSnapshot` (Task 2).
- Produces: `GET /api/w/[workspaceId]/overview` → 200 `OverviewSnapshot` JSON | 404;
  `listWorkspaces(): Promise<readonly { id: string; name: string }[]>` for the root page.
  Task 5's hook fetches this route by URL.

- [ ] **Step 1: Write the failing route tests**

`apps/web/test/integration/routes.test.ts` — route handlers are plain functions; call them with a
`Request`, no server boot (Next 15 passes `params` as a Promise):

```ts
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getOverview } from '../../src/app/api/w/[workspaceId]/overview/route.js'
import { listWorkspaces } from '../../src/server/workspaces.js'

describe('the overview route', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('serves the snapshot for a real workspace', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/x', verifyCommands: ['true'], setupCommands: [] },
    })

    const response = await getOverview(new Request('http://test/api'), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { workspace: { name: string } }
    expect(body.workspace.name).toBe('W')
  })

  it('404s a workspace that does not exist, naming it', async (): Promise<void> => {
    const response = await getOverview(new Request('http://test/api'), {
      params: Promise.resolve({ workspaceId: 'nope' }),
    })

    expect(response.status).toBe(404)
    expect(await response.text()).toContain('nope')
  })

  it('lists workspaces for the picker', async (): Promise<void> => {
    await prisma.workspace.create({
      data: { name: 'A', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [] },
    })
    await prisma.workspace.create({
      data: { name: 'B', repoPath: '/tmp/b', verifyCommands: ['true'], setupCommands: [] },
    })

    const all = await listWorkspaces()

    expect(all.map((w) => w.name).sort()).toEqual(['A', 'B'])
  })
})
```

- [ ] **Step 2: Run, watch them fail**

Run: `npx vitest run apps/web/test/integration/routes.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/web/src/server/workspaces.ts`:

```ts
import { prisma } from '@ai-team-os/db/client'

export async function listWorkspaces(): Promise<readonly { id: string; name: string }[]> {
  return prisma.workspace.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
}
```

`apps/web/src/app/api/w/[workspaceId]/overview/route.ts`:

```ts
import { buildOverviewSnapshot } from '../../../../../server/overview.js'

// Reads the live database on every hit; a cached snapshot is a lie about a live system.
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const snapshot = await buildOverviewSnapshot(workspaceId)
  if (snapshot === null) return new Response(`no workspace with id ${workspaceId}`, { status: 404 })
  return Response.json(snapshot)
}
```

`apps/web/src/app/page.tsx` — the CLI's `resolveWorkspace` principle in URL form (spec §3):

```tsx
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { listWorkspaces } from '../server/workspaces.js'

export const dynamic = 'force-dynamic'

export default async function Home(): Promise<React.JSX.Element> {
  const workspaces = await listWorkspaces()
  if (workspaces.length === 1 && workspaces[0] !== undefined) redirect(`/w/${workspaces[0].id}`)
  if (workspaces.length === 0) {
    return <main className="p-6 text-text-2">There are no workspaces. Seed one first.</main>
  }
  return (
    <main className="p-6">
      <h1 className="mb-4 text-sm text-text-2">Pick a workspace</h1>
      <ul className="flex flex-col gap-2">
        {workspaces.map((w) => (
          <li key={w.id}>
            <Link className="text-text-1 underline" href={`/w/${w.id}`}>
              {w.name} <span className="font-mono text-xs text-text-3">{w.id}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

`apps/web/src/app/w/[workspaceId]/page.tsx` — this task's placeholder body (Task 6 replaces it):

```tsx
import { buildOverviewSnapshot } from '../../../server/overview.js'

export const dynamic = 'force-dynamic'

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const snapshot = await buildOverviewSnapshot(workspaceId)
  if (snapshot === null) return <main className="p-6 text-status-danger">no workspace with id {workspaceId}</main>
  return (
    <main className="p-6">
      <pre className="font-mono text-xs text-text-2">{JSON.stringify(snapshot, null, 2)}</pre>
    </main>
  )
}
```

- [ ] **Step 4: Run until green, then the full suite**

Run: `npx vitest run apps/web/test/integration/routes.test.ts` — Expected: PASS.
Run: `npm run web:build && npm test && npm run typecheck` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): serve the snapshot route and resolve workspaces by URL"
```

---

## Task 4: The SSE route

**Files:**
- Create: `apps/web/src/server/sse.ts`, `apps/web/src/app/api/w/[workspaceId]/events/route.ts`
- Test: `apps/web/test/integration/sse.test.ts`

**Interfaces:**
- Consumes: `createEventStream({ connectionString, fromSeq, onEvent, onError })` from
  `@ai-team-os/events` (M2); `prisma` for the max-seq read; `appendEvent` in tests.
- Produces:

```ts
export interface EventSseOptions {
  readonly workspaceId: string
  /** Resume point (exclusive). null = "from now" (current max seq). */
  readonly fromSeq: number | null
  readonly connectionString: string
  /** For tests; default 15_000. */
  readonly heartbeatMs?: number
}

/** SSE response whose body streams this workspace's events. Closing the body releases the LISTEN. */
export async function createEventSse(options: EventSseOptions): Promise<Response>
```

Task 5's hook consumes `GET /api/w/[workspaceId]/events` via `EventSource`.

- [ ] **Step 1: Write the failing integration tests**

`apps/web/test/integration/sse.test.ts`. Helper: read SSE frames from a `Response` with a timeout.

```ts
import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createEventSse } from '../../src/server/sse.js'

const CONNECTION = process.env['TEST_DATABASE_URL'] ?? ''

interface Frame {
  readonly id: string | null
  readonly data: string | null
}

/** Reads frames (blocks separated by a blank line) until `count` or `timeoutMs`. */
async function readFrames(response: Response, count: number, timeoutMs = 5_000): Promise<Frame[]> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('response has no body')
  const decoder = new TextDecoder()
  const frames: Frame[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (frames.length < count && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('frame timeout')), deadline - Date.now())),
      ])
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const id = /^id: (.*)$/m.exec(block)?.[1] ?? null
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? null
        frames.push({ id, data })
      }
    }
  } finally {
    await reader.cancel()
  }
  return frames
}

interface Fixture {
  readonly workspaceId: string
  readonly otherWorkspaceId: string
}

async function seed(): Promise<Fixture> {
  const make = async (name: string): Promise<string> =>
    (
      await prisma.workspace.create({
        data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [] },
      })
    ).id
  return { workspaceId: await make('mine'), otherWorkspaceId: await make('other') }
}

const emit = async (workspaceId: string, title: string): Promise<void> => {
  await appendEvent({ type: 'task.created', workspaceId, actor: 'system', payload: { title } })
}

describe('the events SSE stream', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('delivers an appended event with its seq as the SSE id', async (): Promise<void> => {
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
    })

    await emit(fixture.workspaceId, 'hello')
    const [frame] = await readFrames(response, 1)

    expect(frame?.data).toContain('hello')
    const event = JSON.parse(frame?.data ?? '{}') as { seq: number; type: string }
    expect(frame?.id).toBe(String(event.seq))
    expect(event.type).toBe('task.created')
  }, 15_000)

  it('replays from a given seq without loss', async (): Promise<void> => {
    await emit(fixture.workspaceId, 'before-1')
    await emit(fixture.workspaceId, 'before-2')

    // fromSeq: 0 = everything. EventSource reconnection passes Last-Event-ID the same way.
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: 0,
      connectionString: CONNECTION,
    })
    const frames = await readFrames(response, 2)

    expect(frames.map((f) => f.data ?? '')).toEqual([
      expect.stringContaining('before-1'),
      expect.stringContaining('before-2'),
    ])
  }, 15_000)

  it("filters another workspace's events but advances the watermark past them", async (): Promise<void> => {
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
      heartbeatMs: 300,
    })

    await emit(fixture.otherWorkspaceId, 'not-mine')

    // The next frame must be a heartbeat: no data, but an id that has moved past the filtered
    // event's seq. A watermark that lags on filtered spans re-delivers them on every reconnect
    // forever (spec §4).
    const [frame] = await readFrames(response, 1)
    expect(frame?.data).toBeNull()
    expect(Number(frame?.id)).toBeGreaterThan(0)
  }, 15_000)

  it('starts "from now": history is not replayed without a resume point', async (): Promise<void> => {
    await emit(fixture.workspaceId, 'history')

    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
    })
    await emit(fixture.workspaceId, 'fresh')
    const [frame] = await readFrames(response, 1)

    expect(frame?.data).toContain('fresh')
    expect(frame?.data).not.toContain('history')
  }, 15_000)

  it('sends id-only heartbeats while quiet', async (): Promise<void> => {
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
      heartbeatMs: 200,
    })

    const frames = await readFrames(response, 2, 3_000)

    // Two heartbeats with no events between them: both id-only. This is what keeps proxies from
    // reaping the connection and tells the client "quiet", not "dead" (spec §4).
    expect(frames).toHaveLength(2)
    for (const frame of frames) expect(frame.data).toBeNull()
  }, 15_000)

  it('releases its LISTEN connection when the consumer goes away', async (): Promise<void> => {
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
    })

    await response.body?.cancel()

    // An abandoned tab must not leak a Postgres LISTEN forever. After cancel, appending events
    // must not throw anywhere (the stream's onEvent writing to a closed controller), and the
    // process must be able to exit — asserted indirectly: this test finishing without vitest
    // hanging is the observable.
    await emit(fixture.workspaceId, 'after-close')
    expect(true).toBe(true)
  }, 15_000)
})
```

- [ ] **Step 2: Run, watch them fail**

Run: `npx vitest run apps/web/test/integration/sse.test.ts` — Expected: FAIL (`sse.js` missing).

- [ ] **Step 3: Implement `createEventSse` and the route**

`apps/web/src/server/sse.ts`:

```ts
import { prisma } from '@ai-team-os/db/client'
import { createEventStream, type EventStreamHandle } from '@ai-team-os/events'

export const DEFAULT_HEARTBEAT_MS = 15_000

// EventSseOptions exactly as in this task's Produces block

export async function createEventSse(options: EventSseOptions): Promise<Response> {
  // "From now": the current max seq, so a fresh page sees only what happens after it opened.
  // The snapshot it just fetched already carries the past.
  const fromSeq =
    options.fromSeq ??
    Number((await prisma.executionEvent.aggregate({ _max: { seq: true } }))._max.seq ?? 0n)

  let lastSeen = fromSeq
  let handle: EventStreamHandle | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        if (heartbeat !== null) clearInterval(heartbeat)
        // Fire-and-forget: close() awaits in-flight delivery internally; the response stream is
        // already done with this connection either way.
        void handle?.close()
        try {
          controller.close()
        } catch {
          // already closed by the consumer
        }
      }

      // createEventStream's contract: onEvent must never throw, or the event is skipped forever.
      // A failed enqueue means the consumer is gone — close and let EventSource reconnect with
      // Last-Event-ID; the replay covers the gap (spec §4).
      handle = await createEventStream({
        connectionString: options.connectionString,
        fromSeq,
        onEvent: (event): void => {
          lastSeen = Math.max(lastSeen, event.seq)
          if (event.workspaceId !== options.workspaceId) return
          try {
            controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`))
          } catch {
            close()
          }
        },
        onError: (error): void => {
          console.error('[sse] event stream error:', error)
        },
      })

      // Id-only frame: updates the client's Last-Event-ID without dispatching an event, which is
      // what advances the watermark across filtered spans AND keeps proxies from reaping the
      // idle connection (spec §4).
      heartbeat = setInterval((): void => {
        try {
          controller.enqueue(encoder.encode(`id: ${lastSeen}\n\n`))
        } catch {
          close()
        }
      }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
      heartbeat.unref?.()
    },
    cancel(): void {
      if (heartbeat !== null) clearInterval(heartbeat)
      void handle?.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
```

`apps/web/src/app/api/w/[workspaceId]/events/route.ts`:

```ts
import { createEventSse } from '../../../../../server/sse.js'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const url = new URL(request.url)
  // EventSource sends Last-Event-ID on reconnect; ?from covers manual resumption.
  const raw = request.headers.get('last-event-id') ?? url.searchParams.get('from')
  const parsed = raw === null ? null : Number(raw)
  const fromSeq = parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null

  const connectionString = process.env['DATABASE_URL'] ?? ''
  if (connectionString === '') return new Response('DATABASE_URL is not set', { status: 500 })

  return createEventSse({ workspaceId, fromSeq, connectionString })
}
```

Note the route does not abort-listen on `request.signal`: the `ReadableStream`'s `cancel()` fires
when the client disconnects under Next's Node runtime, and the leak test pins the behaviour that
matters. If `cancel()` proves not to fire under `next dev` during the demo, add
`request.signal.addEventListener('abort', ...)` calling the same close — the test stays the
authority either way.

- [ ] **Step 4: Run until green**

Run: `npx vitest run apps/web/test/integration/sse.test.ts` — Expected: PASS (6).
These tests use real LISTEN/NOTIFY; latency assertions stay generous (readFrames' 5s default).

- [ ] **Step 5: Mutation pass**

One at a time, revert after each: (1) drop the workspace filter (`if (...) return`) — the filter
test must fail; (2) send the heartbeat as a comment line (`: ping\n\n`) instead of id-only — the
filter-watermark test must fail (no id to advance); (3) freeze `lastSeen` (never `Math.max`) — the
filter-watermark test must fail; (4) make `fromSeq: null` resolve to `0` — the "from now" test must
fail; (5) swallow enqueue errors without `close()` — the release test must hang or fail. Fix any
test a mutation survives.

- [ ] **Step 6: Full suite and commit**

Run: `npm test && npm run typecheck`

```bash
git add -A && git commit -m "feat(web): stream workspace events over SSE with watermark heartbeats"
```

---

## Task 5: The `useOverview` hook

**Files:**
- Create: `apps/web/src/hooks/useOverview.ts`
- Test: `apps/web/test/useOverview.test.tsx`

**Interfaces:**
- Consumes: `GET /api/w/[id]/overview` (Task 3), `GET /api/w/[id]/events` (Task 4),
  `OverviewSnapshot` / `AgentCardData` types (Task 2).
- Produces:

```ts
export interface OverviewState {
  readonly snapshot: OverviewSnapshot | null
  /** Live action line per agent id — overlays snapshot.agents[].actionLine (spec §6). */
  readonly actionLines: Readonly<Record<string, string>>
  readonly connection: 'connected' | 'reconnecting'
  /** Set when the latest refetch failed; the UI dims and shows it (spec §9). */
  readonly error: string | null
}

export function useOverview(workspaceId: string, initial: OverviewSnapshot): OverviewState
```

Task 6 renders exclusively from this state.

- [ ] **Step 1: Write the failing hook tests**

`apps/web/test/useOverview.test.tsx` — jsdom, fake `EventSource` and fake `fetch`, fake timers for
the debounce:

```tsx
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOverview } from '../src/hooks/useOverview.js'
import type { OverviewSnapshot } from '../src/server/overview.js'

const SNAPSHOT: OverviewSnapshot = {
  workspace: { id: 'w1', name: 'W', haltedReason: null, haltedAt: null, budgetUsd: 100, spentUsd: 0 },
  agents: [
    {
      id: 'a1',
      name: 'Alex',
      role: 'backend',
      provider: 'claude-code',
      status: 'working',
      taskTitle: 'Add the thing',
      actionLine: null,
      runId: 'r1',
    },
  ],
  tasks: { active: 1, blocked: 0, done: 0, failed: 0 },
}

/** Minimal EventSource stand-in: capture instances, let tests push messages and errors. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
}

describe('useOverview', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach((): void => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    fetchMock = vi.fn(async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach((): void => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const push = (data: unknown): void => {
    act((): void => {
      FakeEventSource.instances[0]?.onmessage?.({ data: JSON.stringify(data) })
    })
  }

  it('refetches the snapshot once per event burst, not once per event', async (): Promise<void> => {
    renderHook(() => useOverview('w1', SNAPSHOT))

    for (let i = 0; i < 5; i += 1) {
      push({ seq: i + 1, ts: new Date(0).toISOString(), workspaceId: 'w1', actor: 'system', type: 'task.started', payload: { title: 'x' } })
    }
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // The wake-up rule (spec §6): a chatty run costs one query per debounce window. Five fetches
    // here means the debounce is decorative and a real run hammers the snapshot endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('updates the action line immediately from run.tool_call, before any refetch', (): void => {
    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    push({
      seq: 1,
      ts: new Date(0).toISOString(),
      workspaceId: 'w1',
      agentId: 'a1',
      runId: 'r1',
      actor: 'agent',
      type: 'run.tool_call',
      payload: { name: 'Write', summary: 'Write note3.txt' },
    })

    // No timer advance: the line is the one thing that must not wait for the debounce (spec §6).
    expect(result.current.actionLines['a1']).toBe('Write note3.txt')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores an event payload it does not recognize', (): void => {
    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    push({ garbage: true })

    // Malformed data must not take the page down (spec §9): no throw, no state change.
    expect(result.current.actionLines).toEqual({})
    expect(result.current.snapshot).toEqual(SNAPSHOT)
  })

  it('reports reconnecting on stream error and connected on open', (): void => {
    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    act((): void => {
      FakeEventSource.instances[0]?.onerror?.()
    })
    expect(result.current.connection).toBe('reconnecting')

    act((): void => {
      FakeEventSource.instances[0]?.onopen?.()
    })
    expect(result.current.connection).toBe('connected')
  })

  it('keeps the last snapshot and surfaces the error when a refetch fails', async (): Promise<void> => {
    fetchMock.mockImplementation(async () => new Response('db unreachable', { status: 500 }))
    const { result } = renderHook(() => useOverview('w1', SNAPSHOT))

    push({ seq: 1, ts: new Date(0).toISOString(), workspaceId: 'w1', actor: 'system', type: 'task.started', payload: { title: 'x' } })
    await act(async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(300)
    })

    // Never a blank screen (spec §9): the stale snapshot stays, the failure is named.
    expect(result.current.snapshot).toEqual(SNAPSHOT)
    await waitFor(() => expect(result.current.error).not.toBeNull())
  })

  it('closes the EventSource on unmount', (): void => {
    const { unmount } = renderHook(() => useOverview('w1', SNAPSHOT))

    unmount()

    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })
})
```

- [ ] **Step 2: Run, watch them fail**

Run: `npx vitest run apps/web/test/useOverview.test.tsx` — Expected: FAIL (hook missing).

- [ ] **Step 3: Implement the hook**

`apps/web/src/hooks/useOverview.ts`:

```ts
'use client'

import { useEffect, useRef, useState } from 'react'
import type { OverviewSnapshot } from '../server/overview.js'

export const REFETCH_DEBOUNCE_MS = 250

// OverviewState exactly as in this task's Produces block

export function useOverview(workspaceId: string, initial: OverviewSnapshot): OverviewState {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(initial)
  const [actionLines, setActionLines] = useState<Record<string, string>>({})
  const [connection, setConnection] = useState<'connected' | 'reconnecting'>('connected')
  const [error, setError] = useState<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect((): (() => void) => {
    const refetch = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/w/${workspaceId}/overview`)
        if (!response.ok) throw new Error(`snapshot failed: ${response.status} ${await response.text()}`)
        setSnapshot((await response.json()) as OverviewSnapshot)
        setError(null)
      } catch (cause) {
        // Keep the stale snapshot; name the failure (spec §9). The next event tries again.
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    const scheduleRefetch = (): void => {
      if (debounce.current !== null) clearTimeout(debounce.current)
      debounce.current = setTimeout((): void => {
        void refetch()
      }, REFETCH_DEBOUNCE_MS)
    }

    const source = new EventSource(`/api/w/${workspaceId}/events`)
    source.onopen = (): void => setConnection('connected')
    source.onerror = (): void => setConnection('reconnecting') // EventSource auto-reconnects
    source.onmessage = (message: { data: string }): void => {
      let event: { type?: string; agentId?: string; payload?: { summary?: string } }
      try {
        event = JSON.parse(message.data) as typeof event
      } catch {
        return // not ours to crash over (spec §9)
      }

      // The one exception to the wake-up rule: the action line is display-only ephemera and paints
      // immediately. Wrong is fine — the next refetch overwrites it; it is not state (spec §6).
      if (event.type === 'run.tool_call' && typeof event.agentId === 'string') {
        const summary = event.payload?.summary
        if (typeof summary === 'string') {
          setActionLines((lines) => ({ ...lines, [event.agentId as string]: summary }))
        }
      }

      // Every event — recognized or not — is a wake-up (spec §6).
      if (typeof event.type === 'string') scheduleRefetch()
    }

    return (): void => {
      source.close()
      if (debounce.current !== null) clearTimeout(debounce.current)
    }
  }, [workspaceId])

  return { snapshot, actionLines, connection, error }
}
```

- [ ] **Step 4: Run until green, full suite**

Run: `npx vitest run apps/web/test/useOverview.test.tsx` — Expected: PASS (6).
Run: `npm test && npm run typecheck` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): add the useOverview hook — wake-up refetch plus live action lines"
```

---

## Task 6: The Overview page

**Files:**
- Create: `apps/web/src/components/TopStrip.tsx`, `apps/web/src/components/AgentCard.tsx`,
  `apps/web/src/components/HaltBanner.tsx`, `apps/web/src/components/OverviewClient.tsx`
- Modify: `apps/web/src/app/w/[workspaceId]/page.tsx` (replace Task 3's `<pre>` body)
- Test: `apps/web/test/overview-components.test.tsx`

**Interfaces:**
- Consumes: `useOverview` (Task 5), `OverviewSnapshot`/`AgentCardData` (Task 2), `TopBar`/`Sidebar`
  (Task 1), tokens (Task 1).
- Produces: the shipped Overview. `OverviewClient({ workspaceId, initial }: { workspaceId: string; initial: OverviewSnapshot })`
  is the client boundary; the page stays a server component.

- [ ] **Step 1: Write the failing component tests**

`apps/web/test/overview-components.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AgentCard } from '../src/components/AgentCard.js'
import { HaltBanner } from '../src/components/HaltBanner.js'
import { TopStrip } from '../src/components/TopStrip.js'
import type { AgentCardData, OverviewSnapshot } from '../src/server/overview.js'

const agent = (over: Partial<AgentCardData>): AgentCardData => ({
  id: 'a1',
  name: 'Alex',
  role: 'backend',
  provider: 'claude-code',
  status: 'idle',
  taskTitle: null,
  actionLine: null,
  runId: null,
  ...over,
})

const snapshot = (agents: readonly AgentCardData[]): OverviewSnapshot => ({
  workspace: { id: 'w1', name: 'W', haltedReason: null, haltedAt: null, budgetUsd: 100, spentUsd: 3 },
  agents,
  tasks: { active: 2, blocked: 1, done: 4, failed: 0 },
})

describe('TopStrip', () => {
  it('groups agent counts by derived status', () => {
    render(
      <TopStrip
        snapshot={snapshot([
          agent({ id: 'a1', status: 'working' }),
          agent({ id: 'a2', status: 'working' }),
          agent({ id: 'a3', status: 'paused' }),
          agent({ id: 'a4', status: 'idle' }),
        ])}
      />,
    )
    expect(screen.getByTestId('count-working').textContent).toContain('2')
    expect(screen.getByTestId('count-paused').textContent).toContain('1')
    expect(screen.getByTestId('count-idle').textContent).toContain('1')
    expect(screen.getByTestId('count-tasks-active').textContent).toContain('2')
    expect(screen.getByTestId('count-tasks-blocked').textContent).toContain('1')
  })
})

describe('AgentCard', () => {
  it('shows a working agent with its task and live action line', () => {
    render(
      <AgentCard
        agent={agent({ status: 'working', taskTitle: 'Add the thing', actionLine: 'Read a.ts' })}
        liveActionLine="Write note3.txt"
      />,
    )
    // The live line wins over the snapshot's (spec §6) — the stream is fresher by construction.
    expect(screen.getByTestId('action-line').textContent).toBe('Write note3.txt')
    expect(screen.getByText('Add the thing')).toBeTruthy()
    expect(screen.getByTestId('status-label').textContent).toBe('working')
  })

  it('falls back to the snapshot action line when no live one has arrived', () => {
    render(<AgentCard agent={agent({ status: 'working', actionLine: 'Read a.ts' })} liveActionLine={null} />)
    expect(screen.getByTestId('action-line').textContent).toBe('Read a.ts')
  })

  it('pulses only while working', () => {
    const { rerender } = render(<AgentCard agent={agent({ status: 'working' })} liveActionLine={null} />)
    expect(screen.getByTestId('status-dot').className).toContain('animate-pulse')
    rerender(<AgentCard agent={agent({ status: 'paused' })} liveActionLine={null} />)
    // Motion carries information (spec §7): a pulsing paused agent is a lie on screen.
    expect(screen.getByTestId('status-dot').className).not.toContain('animate-pulse')
  })

  it('renders the actions disabled, labeled for M5', () => {
    render(<AgentCard agent={agent({ status: 'working' })} liveActionLine={null} />)
    const pause = screen.getByTitle('arrives in M5')
    expect(pause.getAttribute('disabled')).not.toBeNull()
  })
})

describe('HaltBanner', () => {
  it('shows the reason verbatim and names clear-halt', () => {
    render(<HaltBanner reason="the pause gate failed open (PreToolUse:Write exited 127)" />)
    expect(screen.getByRole('alert').textContent).toContain('PreToolUse:Write')
    expect(screen.getByRole('alert').textContent).toContain('clear-halt')
  })
})
```

- [ ] **Step 2: Run, watch them fail**

Run: `npx vitest run apps/web/test/overview-components.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implement the components**

Before writing markup, load the `frontend-design` skill (parent spec §12.5 assigns it to M4) and
keep it within the spec §7 constraints: layered neutrals, hairlines, mono for identifiers and the
action line, status colours as the only saturation, the status dot as the only pulse.

`apps/web/src/components/TopStrip.tsx`:

```tsx
import type { OverviewSnapshot } from '../server/overview.js'

const AGENT_BUCKETS = [
  { key: 'working', statuses: ['working', 'starting', 'resuming'] },
  { key: 'paused', statuses: ['paused', 'pausing', 'stopping'] },
  { key: 'idle', statuses: ['idle'] },
] as const

export function TopStrip({ snapshot }: { readonly snapshot: OverviewSnapshot }): React.JSX.Element {
  return (
    <section className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-5">
      {AGENT_BUCKETS.map((bucket) => (
        <div key={bucket.key} data-testid={`count-${bucket.key}`} className="bg-bg-1 px-4 py-3">
          <div className="font-mono text-xl">{snapshot.agents.filter((a) => (bucket.statuses as readonly string[]).includes(a.status)).length}</div>
          <div className="text-xs text-text-2">agents {bucket.key}</div>
        </div>
      ))}
      <div data-testid="count-tasks-active" className="bg-bg-1 px-4 py-3">
        <div className="font-mono text-xl">{snapshot.tasks.active}</div>
        <div className="text-xs text-text-2">tasks active</div>
      </div>
      <div data-testid="count-tasks-blocked" className="bg-bg-1 px-4 py-3">
        <div className="font-mono text-xl">{snapshot.tasks.blocked}</div>
        <div className="text-xs text-text-2">tasks blocked</div>
      </div>
    </section>
  )
}
```

`apps/web/src/components/AgentCard.tsx`:

```tsx
import type { AgentCardData } from '../server/overview.js'

const DOT: Record<AgentCardData['status'], string> = {
  working: 'bg-status-working',
  starting: 'bg-status-starting',
  resuming: 'bg-status-starting',
  pausing: 'bg-status-paused',
  paused: 'bg-status-paused',
  stopping: 'bg-status-stopping',
  idle: 'bg-status-idle',
}

export function AgentCard({
  agent,
  liveActionLine,
}: {
  readonly agent: AgentCardData
  readonly liveActionLine: string | null
}): React.JSX.Element {
  const line = liveActionLine ?? agent.actionLine
  return (
    <article className="flex flex-col gap-2 rounded border border-line bg-bg-1 p-4">
      <header className="flex items-center gap-2">
        <span
          data-testid="status-dot"
          className={`inline-block h-2 w-2 rounded-full ${DOT[agent.status]} ${agent.status === 'working' ? 'animate-pulse' : ''}`}
        />
        <span className="text-sm font-medium">{agent.name}</span>
        <span className="text-xs text-text-3">{agent.role}</span>
        <span data-testid="status-label" className="ml-auto text-xs text-text-2">
          {agent.status}
        </span>
      </header>
      <div className="text-sm text-text-1">{agent.taskTitle ?? <span className="text-text-3">idle</span>}</div>
      <div data-testid="action-line" className="h-5 truncate font-mono text-xs text-text-2">
        {line}
      </div>
      <footer className="flex items-center gap-2">
        <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-text-3">
          {agent.provider}
        </span>
        <span className="ml-auto flex gap-1">
          <button disabled title="arrives in M5" className="rounded border border-line px-2 py-0.5 text-xs text-text-3">
            pause
          </button>
          <button disabled title="arrives in M5" className="rounded border border-line px-2 py-0.5 text-xs text-text-3">
            stop
          </button>
        </span>
      </footer>
    </article>
  )
}
```

`apps/web/src/components/HaltBanner.tsx`:

```tsx
export function HaltBanner({ reason }: { readonly reason: string }): React.JSX.Element {
  return (
    <div role="alert" className="border-b border-status-danger/40 bg-status-danger/10 px-4 py-2 text-sm text-status-danger">
      workspace halted: {reason} — retract with <code className="font-mono">clear-halt</code> (CLI)
    </div>
  )
}
```

`apps/web/src/components/OverviewClient.tsx`:

```tsx
'use client'

import { useOverview } from '../hooks/useOverview.js'
import type { OverviewSnapshot } from '../server/overview.js'
import { AgentCard } from './AgentCard.js'
import { HaltBanner } from './HaltBanner.js'
import { Sidebar } from './Sidebar.js'
import { TopBar } from './TopBar.js'
import { TopStrip } from './TopStrip.js'

export function OverviewClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: OverviewSnapshot
}): React.JSX.Element {
  const { snapshot, actionLines, connection, error } = useOverview(workspaceId, initial)
  const view = snapshot ?? initial
  return (
    <div className="flex min-h-screen w-full">
      <Sidebar />
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        <TopBar
          workspaceName={view.workspace.name}
          connection={connection}
          budget={{ spentUsd: view.workspace.spentUsd, budgetUsd: view.workspace.budgetUsd }}
        />
        {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
        {error !== null && (
          <div role="alert" className="border-b border-status-warn/40 bg-status-warn/10 px-4 py-1.5 text-xs text-status-warn">
            showing stale data: {error}
          </div>
        )}
        <TopStrip snapshot={view} />
        <main className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
          {view.agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} liveActionLine={actionLines[agent.id] ?? null} />
          ))}
        </main>
      </div>
    </div>
  )
}
```

`apps/web/src/app/w/[workspaceId]/page.tsx` — replace the `<pre>` body:

```tsx
import { buildOverviewSnapshot } from '../../../server/overview.js'
import { OverviewClient } from '../../../components/OverviewClient.js'

export const dynamic = 'force-dynamic'

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const snapshot = await buildOverviewSnapshot(workspaceId)
  if (snapshot === null) {
    return <main className="p-6 text-status-danger">no workspace with id {workspaceId}</main>
  }
  return <OverviewClient workspaceId={workspaceId} initial={snapshot} />
}
```

- [ ] **Step 4: Run until green, then look at it**

Run: `npx vitest run apps/web/test/overview-components.test.tsx` then `npm test && npm run typecheck`.
Then look at the real page: `docker compose up -d`, `npm run db:seed` (the stock UI-filler seed),
`npm run web`, open `http://localhost:3000`. The seeded workspace renders; statuses are idle
(no orchestrator running) — that is correct. Fix visual regressions now, within spec §7's rules.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): render the Overview — strip, cards, halt banner, live lines"
```

---

## Task 7: The demo script, docs, and the milestone gate

**Files:**
- Create: `scripts/demo-live.mjs`, `docs/superpowers/spikes/2026-08-XX-m4-live-gate.md` (dated on
  the day it runs)
- Modify: `README.md` (web + demo section), `docs/architecture.md` (apps/web topology and the
  read-only rule)
- Test: the milestone gate itself (spec §11), run by hand; no new automated tests

**Interfaces:**
- Consumes: everything from Tasks 1–6; the orchestrator CLI (`apps/orchestrator/dist/cli.js`);
  `@ai-team-os/db` client for seeding.
- Produces: `npm run demo`.

- [ ] **Step 1: Write the demo script**

`scripts/demo-live.mjs` (root `package.json` already has `"demo": "tsc --build && node --env-file=.env scripts/demo-live.mjs"`
from Task 1):

```js
// Packages what M3's live gate did by hand (spec §8): a real repo, a real seed, a running daemon.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '../packages/db/dist/client.js'

const repoPath = join(homedir(), '.aiteamos', 'demo-repo')

// 1. A real git repository. Reset on every run: the demo must be repeatable, and stale worktrees
// from the last demo would make the tick escalate instead of starting (M3 §7.4).
rmSync(repoPath, { recursive: true, force: true })
mkdirSync(repoPath, { recursive: true })
const git = (args) => execFileSync('git', args, { cwd: repoPath })
git(['init', '-q', '-b', 'main'])
git(['config', 'user.name', 'Demo'])
git(['config', 'user.email', 'demo@aiteamos.local'])
writeFileSync(join(repoPath, 'README.md'), '# demo\n')
git(['add', '-A'])
git(['commit', '-q', '-m', 'initial'])

// 2. Seed. A fresh workspace every run, named with a timestamp passed in by the operator's clock.
const workspace = await prisma.workspace.create({
  data: {
    name: `Demo ${new Date().toISOString().slice(0, 16)}`,
    repoPath,
    baseBranch: 'main',
    verifyCommands: ['test -f notes/note3.txt'],
    setupCommands: ['mkdir -p notes'],
  },
})
const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Demo Team' } })
await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
await prisma.task.create({
  data: {
    workspaceId: workspace.id,
    title: 'Write three numbered notes',
    description:
      'Create notes/note1.txt, notes/note2.txt and notes/note3.txt, each containing its own ' +
      'number as a word. Create them one at a time, one file per step, and commit each one.',
    status: 'ready',
    requiredRole: 'backend',
    maxAttempts: workspace.maxAttempts,
  },
})
await prisma.$disconnect()

// 3. The daemon, inheriting AITEAMOS_CLAUDE_BIN/ARGS so the same script smoke-tests against the
// fake for free (spec §8).
console.log(`workspace: ${workspace.id}`)
console.log(`overview:  http://localhost:3000/w/${workspace.id}`)
console.log('starting the daemon (Ctrl-C stops it); run `npm run web` in another terminal')
const daemon = spawn('node', ['apps/orchestrator/dist/cli.js', 'daemon', '--workspace', workspace.id], {
  stdio: 'inherit',
})
process.on('SIGINT', () => daemon.kill('SIGTERM'))
process.on('SIGTERM', () => daemon.kill('SIGTERM'))
daemon.on('exit', (code) => process.exit(code ?? 0))
```

- [ ] **Step 2: Smoke-test the demo against the fake**

```bash
AITEAMOS_CLAUDE_BIN=node AITEAMOS_CLAUDE_ARGS="packages/providers/test/fake-claude.mjs --fixture complete" npm run demo
```

In another terminal: `npm run web`, open the printed URL. Expected: the card flips through
`working` to `idle`, the task counts move, budget stays 0 (the fake is free). Ctrl-C the demo.
This is gate step 5's dress rehearsal and costs nothing.

- [ ] **Step 3: Run the milestone gate against the real CLI (spec §11)**

```bash
npm run demo          # real claude
npm run web           # second terminal
```

Watch: card flips to `working` live, the action line streams real tool calls, strip counts and
budget move (gate steps 1–2). Then kill and restart the web dev server mid-run — the page recovers
without a refresh (gate step 3). Then halt the workspace from a third terminal
(`node --env-file=.env -e` setting `haltedReason`) or run a task with a failing gate — the banner
shows the reason (gate step 4). Record what ran, the ids, costs, and any real-CLI-only findings in
`docs/superpowers/spikes/<date>-m4-live-gate.md`, stating plainly which steps ran against the real
CLI — the same discipline as M3's gate spike.

- [ ] **Step 4: Document**

`README.md`: a "Web UI" section — `npm run web`, what the Overview shows, `npm run demo` for the
one-command live demo, and the read-only note (commands land in M5).
`docs/architecture.md`: add `apps/web` to the topology diagram (reads Postgres, listens via its
own SSE routes, writes nothing), the dependency rule (web never imports orchestrator or
providers), and the hybrid liveness rule (event = wake-up; the action line is the display-only
exception).

- [ ] **Step 5: Final suite and commit**

```bash
npm test && npm run typecheck
git add -A && git commit -m "feat(web): close the M4 milestone gate — demo script, docs, live captures"
```

---

## Self-Review Notes

**Spec coverage:** §1 scope → Tasks 1–7; §2 layout/dependency rule → Task 1 (structure), enforced
throughout; §3 routing → Task 3; §4 SSE (resume, filter+watermark, id-only heartbeat, onEvent
contract, close-on-abandon) → Task 4; §5 snapshot fields and server-side derivation → Task 2;
§6 hybrid rule → Task 5 (tests pin both halves); §7 shell/tokens/strip/cards/banner/motion →
Tasks 1, 6; §8 demo → Task 7; §9 error taxonomy → Task 5 (stale + error band), Task 4
(reconnect/watermark), Task 6 (error band render); §10 testing → integration in Tasks 2–4,
components in Tasks 1, 5, 6, no Playwright; §11 gate → Task 7; §12 simplifications — honoured by
omission (no read-only role, no dead-daemon detection, dark only, no pagination, latest-line only).

**Ordering:** 1 → (2 → 3 → 4) → 5 → 6 → 7. Task 4 is independent of Task 3 and may run before it,
but both need Task 2's fixture conventions; keep the numbered order unless parallelizing.

**Known plan risks:** (1) Next 15 + vitest interop for route-handler imports — route files import
server modules only, so tests bypass Next's runtime entirely; if `next build` complains about the
`.js` specifiers in TSX imports, drop the extension inside `apps/web` only (Next's bundler
resolves extensionless; the pattern differs from the packages, which is acceptable inside one
app). (2) `ReadableStream.cancel()` under `next dev` — the leak behaviour is pinned by test at the
`createEventSse` level; the route-level fallback is written into Task 4 Step 3's note. (3) Prisma
in Next dev's hot reload can multiply clients — `@ai-team-os/db/client` exports a shared instance,
which is exactly the guard.

---

## Final Branch Review (2026-08-20)

Independent full-branch review (7846533..d714dff) before merge. Verdict: ready with fixes; the
fix wave landed on top of the reviewed range.

**Fixed on review:**
- Refetch on SSE open — events landing between the server-rendered snapshot and the stream's
  "from now" watermark were in neither; the hook now schedules a refetch on every open
  (first connect and reconnects). Spec §6 gap, not an implementation deviation.
- Live action lines now expire: a refetched snapshot evicts lines whose run it no longer shows
  (run ended, or a new run took over). Lines remember their `runId` for this.
- `Number('') === 0` — an empty `?from=` or `Last-Event-ID` replayed the whole event log;
  parsing extracted to `parseFromSeq` (non-negative integers only) with unit tests.
- `NON_TERMINAL_RUN_STATUSES` is now the single source for the domain's internal `ACTIVE` list,
  with `satisfies readonly RunStatus[]` membership checking.
- `<OverviewClient>` keyed by `workspaceId` so client-side workspace navigation remounts.
- Demo script prints the overview URL with `PORT` honoured.

**Deferred (recorded, not fixed):**
- Trailing debounce can starve a refetch under a sustained <250ms event cadence; a max-wait
  cap would bound it. Theoretical at real-CLI tool-call cadence (the live gate saw refetches land).
- Spec §7 motion: action-line cross-fade and status-coloured card border were dropped silently
  between spec and plan; only the status-dot pulse shipped. Revisit in M5's UI pass.
- `buildOverviewSnapshot` issues one `findFirst` per live run for initial action lines — fine at
  seed scale (spec §12.4), first place to look when agent count grows.
- The SSE replay integration test proves no-loss but only weakly proves no-duplication; the live
  gate covered duplication by hand.
