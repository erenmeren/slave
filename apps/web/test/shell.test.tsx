// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityClient } from '../src/components/activity/ActivityClient.js'
import { TasksClient } from '../src/components/TasksClient.js'
import type { ActivityPage } from '../src/server/activity.js'
import type { TasksSnapshot } from '../src/server/tasks.js'

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const streamState = {
  events: [] as unknown[],
  connection: 'connected' as const,
  loadOlder: vi.fn(),
  loadingOlder: false,
  exhausted: false,
  sparkline: new Array(10).fill(0) as number[],
  error: null as string | null,
  latencyMs: null as number | null,
}

// `ActivityClient` is exercised below only for the halt-banner presence, so its live stream is
// stubbed out entirely (same shape as `activity-page.test.tsx`'s `streamState` mock) rather than
// wired to a real `EventSource` — `TasksClient` below takes the other precedent instead
// (`tasks-components.test.tsx`'s `FakeEventSource` + `fetch` stub), since `useTasks` has no
// dedicated mock to reach for.
vi.mock('../src/hooks/useActivityStream.js', () => ({
  useActivityStream: () => streamState,
}))

vi.mock('../src/hooks/useStreamState', () => ({ publishStreamState: vi.fn() }))

/** Minimal `EventSource` stand-in (`tasks-components.test.tsx`'s precedent) — still needed by the
 *  `TasksClient` halt-banner case below, which streams for real. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  close(): void {}
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('the halt banner shows on every page', () => {
  const HALT_REASON = 'the pause gate failed open (PreToolUse:Write exited 127)'

  // `Timeline` (inside `ActivityClient`) measures its scroll viewport via `@tanstack/react-virtual`,
  // which falls back to `offsetWidth`/`offsetHeight` when no `ResizeObserver` is present — jsdom has
  // neither by default. Same local mock as `activity-page.test.tsx`'s `mockElementSizes`.
  function mockElementSizes(): void {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
    HTMLElement.prototype.scrollTo = vi.fn()
  }

  beforeEach(() => {
    mockElementSizes()
  })

  it('TasksClient renders the reason as a role="alert" banner', () => {
    // `useTasks` (via `useWorkspaceStream`) opens a real `EventSource` and fetches on open — the
    // file-level `FakeEventSource` + `fetch` stubs cover both; this only pins the body.
    const snapshot: TasksSnapshot = {
      workspace: { id: 'w1', name: 'W', haltedReason: HALT_REASON, goalVersion: 0 },
      shellFacts: {
        workspace: { id: 'w1', name: 'W' },
        counts: { slavesWorking: 0, tasksActive: 0, slavesPaused: 0 },
        guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
        status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: HALT_REASON },
      },
      tasks: [],
    }
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(snapshot), { status: 200 }))

    render(<TasksClient workspaceId="w1" initial={snapshot} />)

    expect(screen.getByRole('alert').textContent).toContain(HALT_REASON)
  })

  it('ActivityClient renders the reason as a role="alert" banner', () => {
    const initial: ActivityPage = {
      workspace: { id: 'w1', name: 'W', haltedReason: HALT_REASON },
      events: [],
      nextBefore: null,
      sparkline: new Array(10).fill(0),
      slaves: [],
      tasks: [],
      users: [],
      // M14 Task 12 widenings: the right rail's 24h volumes, and the shell facts this page
      // publishes to `hooks/useShellFacts.ts` for the project header and the Tasks tab's badge.
      typeVolumes: [],
      shellFacts: {
        workspace: { id: 'w1', name: 'W' },
        counts: { slavesWorking: 0, tasksActive: 0, slavesPaused: 0 },
        guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
        status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: HALT_REASON },
      },
    }

    render(<ActivityClient workspaceId="w1" initial={initial} />)

    expect(screen.getByRole('alert').textContent).toContain(HALT_REASON)
  })
})
