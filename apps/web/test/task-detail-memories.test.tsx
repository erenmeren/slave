// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskDetailPanel } from '../src/components/TaskDetailPanel'
import { TasksClient } from '../src/components/TasksClient'
import type { KnowledgeRow, TaskMemoriesView } from '../src/server/memory'
import { taskItem } from './fixtures/taskItem'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined }),
  usePathname: () => '/w/w1/tasks',
  useSearchParams: () => new URLSearchParams(),
}))

function row(over: Partial<KnowledgeRow> & { readonly memory: KnowledgeRow['memory'] }): KnowledgeRow {
  return {
    typeLabel: 'Fact',
    scopeLabel: 'This project',
    statusLabel: 'Verified',
    confidenceLabel: 'Sourced',
    capabilities: [],
    provenance: 'from a passed verification',
    taskTitle: 'Add the thing',
    supersedesIds: [],
    ...over,
  }
}

function memory(over: Partial<KnowledgeRow['memory']>): KnowledgeRow['memory'] {
  return {
    id: 'm1',
    type: 'fact',
    scope: 'workspace',
    companyId: null,
    workspaceId: 'w1',
    slaveId: null,
    title: 'Every orders route requires a signed session',
    body: 'The gateway rejects an anonymous request.',
    status: 'verified',
    confidence: 'sourced',
    capabilities: [],
    verifiedAt: '2026-09-12T10:00:00.000Z',
    verifiedBy: 'verification',
    supersededById: null,
    removedReason: null,
    sourceIds: [],
    createdAt: '2026-09-12T09:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    provenance: {
      sourceKind: 'verification',
      sourceRef: '412',
      createdBy: 'system',
      createdByUserId: null,
      taskId: 't1',
      runId: 'r1',
      goalVersion: 2,
    },
    ...over,
  }
}

const VIEW: TaskMemoriesView = {
  received: [row({ memory: memory({}) })],
  produced: [
    row({
      memory: memory({ id: 'm2', type: 'observation', status: 'superseded', title: 'The list query scans the table' }),
      typeLabel: 'Observation',
      statusLabel: 'Superseded',
      confidenceLabel: 'Interpretation',
    }),
  ],
}

const group = (): HTMLElement => {
  const found = screen.getAllByTestId('details-group').find((node) => node.getAttribute('data-group') === 'memories')
  if (found === undefined) throw new Error('no memories group')
  return found
}

describe('the task drawer’s knowledge group (M49 R6, plan erratum E7)', () => {
  it('issues no request at all until somebody opens it', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<TaskDetailPanel workspaceId="w1" workspaceGoalVersion={1} onClose={() => undefined} task={taskItem({})} />)
    expect(group().getAttribute('data-group')).toBe('memories')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('reads what this task’s runs were given and what it taught, in words, with the keys in title', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => VIEW })
    vi.stubGlobal('fetch', fetchMock)
    render(<TaskDetailPanel workspaceId="w1" workspaceGoalVersion={1} onClose={() => undefined} task={taskItem({})} />)
    fireEvent.click(within(group()).getByRole('button', { name: /Knowledge/ }))
    fireEvent.click(screen.getByTestId('task-memories-open'))
    await vi.waitFor(() => expect(screen.getByTestId('task-memory-received')).toBeDefined())
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/tasks/t1/memories')

    const received = screen.getByTestId('task-memory-received')
    expect(received.textContent).toContain('Fact')
    expect(received.textContent).toContain('Every orders route requires a signed session')
    expect(received.textContent).not.toContain('run_output')
    expect(within(received).getAllByTestId('task-memory-row')[0]?.querySelector('[title="fact"]')).not.toBeNull()

    const produced = screen.getByTestId('task-memory-produced')
    expect(produced.textContent).toContain('Observation')
    // R2(b)'s whole point: the candidate a verified fact retired is still here, and says so.
    expect(produced.textContent).toContain('Superseded')
    expect(produced.textContent).not.toContain('superseded')
    expect(within(produced).getAllByTestId('task-memory-row')[0]?.querySelector('[title="superseded"]')).not.toBeNull()
    vi.unstubAllGlobals()
  })

  it('says nothing was given and nothing was taught rather than showing two empty lists', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ received: [], produced: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<TaskDetailPanel workspaceId="w1" workspaceGoalVersion={1} onClose={() => undefined} task={taskItem({})} />)
    fireEvent.click(within(group()).getByRole('button', { name: /Knowledge/ }))
    fireEvent.click(screen.getByTestId('task-memories-open'))
    await vi.waitFor(() => expect(screen.getByTestId('task-memory-received')).toBeDefined())
    expect(screen.getByTestId('task-memory-received').textContent).toContain('was given')
    expect(screen.getByTestId('task-memory-produced').textContent).toContain('taught')
    vi.unstubAllGlobals()
  })

  // Final review, Minor 5: two lists, one under the other, with nothing saying which was which --
  // a reader could not tell the knowledge a run was GIVEN from the knowledge this task PRODUCED.
  it('names each of its two lists', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => VIEW })
    vi.stubGlobal('fetch', fetchMock)
    render(<TaskDetailPanel workspaceId="w1" workspaceGoalVersion={1} onClose={() => undefined} task={taskItem({})} />)
    fireEvent.click(within(group()).getByRole('button', { name: /Knowledge/ }))
    fireEvent.click(screen.getByTestId('task-memories-open'))
    await vi.waitFor(() => expect(screen.getByTestId('task-memory-received')).toBeDefined())
    expect(screen.getByTestId('task-memory-received-label').textContent).toBe('Received by its runs')
    expect(screen.getByTestId('task-memory-produced-label').textContent).toBe('Produced by this task')
    // The labels belong to the lists, not to the group: they appear only once the read has landed.
    vi.unstubAllGlobals()
  })

  it('shows the route’s own sentence when the read is refused', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'no such task' }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<TaskDetailPanel workspaceId="w1" workspaceGoalVersion={1} onClose={() => undefined} task={taskItem({})} />)
    fireEvent.click(within(group()).getByRole('button', { name: /Knowledge/ }))
    fireEvent.click(screen.getByTestId('task-memories-open'))
    await vi.waitFor(() => expect(screen.getByTestId('task-memories-error').textContent).toBe('no such task'))
    vi.unstubAllGlobals()
  })
})

// Final review, Minor 5: the panel keeps its on-demand reads (the memories, the artifact, the run
// context) in its OWN state, and nothing about those reads is keyed to the task. Without a `key`
// React re-uses the same instance when the selection changes, and one task's knowledge stayed on
// the screen under another task's title.
describe('the drawer is a new drawer for a new task (M49 R6)', () => {
  class FakeEventSource {
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onopen: (() => void) | null = null
    close(): void {}
  }

  const snapshot = {
    workspace: { id: 'w1', name: 'W', haltedReason: null, goalVersion: 0 },
    shellFacts: {
      workspace: { id: 'w1', name: 'W' },
      counts: { slavesWorking: 0, tasksActive: 0 },
      guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
      status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
    },
    tasks: [taskItem({}), taskItem({ id: 't2', title: 'Add the other thing' })],
  }

  it('drops the knowledge it read for one task when a person opens another', async () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/memories')
        ? { ok: true, status: 200, json: async () => VIEW }
        : { ok: true, status: 200, json: async () => snapshot },
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<TasksClient workspaceId="w1" initial={snapshot} />)

    fireEvent.click(screen.getByText('Add the thing'))
    fireEvent.click(within(group()).getByRole('button', { name: /Knowledge/ }))
    fireEvent.click(screen.getByTestId('task-memories-open'))
    await vi.waitFor(() => expect(screen.getByTestId('task-memory-received')).toBeDefined())
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/tasks/t1/memories')

    fireEvent.click(screen.getByText('Add the other thing'))
    expect(screen.getByTestId('task-panel-ref').textContent).toBe('TASK-t2')
    // A fresh panel: no list, and the read is offered again rather than answered with t1's rows.
    expect(screen.queryByTestId('task-memory-received')).toBeNull()
    expect(screen.queryByTestId('task-memory-produced')).toBeNull()
    vi.unstubAllGlobals()
  })
})
