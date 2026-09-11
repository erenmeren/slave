// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KnowledgeClient } from '../src/components/knowledge/KnowledgeClient'
import type { KnowledgeRow, KnowledgeView } from '../src/server/memory'

/**
 * The Knowledge tab, rendered from a hand-built view (M49 R6).
 *
 * `buildKnowledge` itself is exercised against a real database in
 * `test/integration/memory-view.test.ts`; this file is about what a PERSON sees -- the words, the
 * raw values that stay one hover away, which actions each status offers, and the chain.
 */
function memory(over: Partial<KnowledgeRow['memory']> = {}): KnowledgeRow['memory'] {
  return {
    id: 'm1',
    type: 'fact',
    scope: 'workspace',
    companyId: null,
    workspaceId: 'w1',
    slaveId: null,
    title: 'Task: Ship the checkout API',
    body: 'Every orders route requires a signed session.',
    status: 'verified',
    confidence: 'sourced',
    capabilities: ['backend.api-design'],
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
      runId: 'r3f2a00',
      goalVersion: 2,
    },
    ...over,
  }
}

const VERIFIED: KnowledgeRow = {
  memory: memory(),
  typeLabel: 'Fact',
  scopeLabel: 'This project',
  statusLabel: 'Verified',
  confidenceLabel: 'Sourced',
  capabilities: [{ key: 'backend.api-design', label: 'API design' }],
  provenance:
    'from a passed verification of “Ship the checkout API” · run r3f2a0 · goal v2 · verified by verification',
  taskTitle: 'Ship the checkout API',
  supersedesIds: ['m0'],
}

const CANDIDATE: KnowledgeRow = {
  memory: memory({
    id: 'm2',
    type: 'observation',
    status: 'candidate',
    confidence: 'interpretation',
    verifiedAt: null,
    verifiedBy: null,
    title: 'The orders table has no index on customer',
    body: 'A list query for one customer scanned the whole table.',
    capabilities: [],
    provenance: {
      sourceKind: 'run_output',
      sourceRef: null,
      createdBy: 'slave',
      createdByUserId: null,
      taskId: 't1',
      runId: 'r9',
      goalVersion: 2,
    },
  }),
  typeLabel: 'Observation',
  scopeLabel: 'This project',
  statusLabel: 'Candidate',
  confidenceLabel: 'Interpretation',
  capabilities: [],
  provenance: 'from a worker’s own report of “Ship the checkout API” · run r9 · goal v2',
  taskTitle: 'Ship the checkout API',
  supersedesIds: [],
}

const VIEW: KnowledgeView = {
  workspaceId: 'w1',
  counts: { verified: 2, candidates: 1 },
  memoryTitles: { m0: 'An older claim about the orders route' },
  rows: [VERIFIED, CANDIDATE],
}

describe('KnowledgeClient', () => {
  it('prints a row per memory, in words, with the raw values only in title/data attributes', () => {
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    const rows = screen.getAllByTestId('knowledge-row')
    expect(rows).toHaveLength(2)
    const first = rows[0] as HTMLElement
    expect(first.textContent).toContain('Fact')
    expect(first.textContent).toContain('Task: Ship the checkout API')
    expect(first.textContent).toContain('Every orders route requires a signed session.')
    expect(within(first).getByTestId('knowledge-provenance').textContent).toBe(VERIFIED.provenance)
    // docs/ia.md rule 3: no union member is visible text, and the key is one hover away.
    expect(first.textContent).not.toContain('run_output')
    expect(first.textContent).not.toContain('backend.api-design')
    expect(first.getAttribute('data-memory-id')).toBe('m1')
    expect(first.getAttribute('data-memory-type')).toBe('fact')
    expect(first.getAttribute('data-memory-status')).toBe('verified')
    expect(first.getAttribute('data-memory-scope')).toBe('workspace')
    expect(within(first).getByTestId('knowledge-type').getAttribute('title')).toBe('fact')
    expect(within(first).getByTestId('knowledge-scope').getAttribute('title')).toBe('workspace')
  })

  it('offers Verify only on a candidate, and Correct and Remove on everything live', () => {
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    const [verifiedRow, candidateRow] = screen.getAllByTestId('knowledge-row') as HTMLElement[]
    expect(within(verifiedRow as HTMLElement).queryByTestId('knowledge-verify')).toBeNull()
    expect(within(candidateRow as HTMLElement).getByTestId('knowledge-verify')).toBeDefined()
    expect(within(verifiedRow as HTMLElement).getByTestId('knowledge-correct')).toBeDefined()
    expect(within(verifiedRow as HTMLElement).getByTestId('knowledge-remove')).toBeDefined()
  })

  it('offers nothing to act on for a row nothing can change any more', () => {
    const frozen: KnowledgeRow = { ...VERIFIED, memory: memory({ id: 'm3', status: 'removed', removedReason: 'wrong' }), statusLabel: 'Removed', supersedesIds: [] }
    render(<KnowledgeClient workspaceId="w1" initial={{ ...VIEW, rows: [frozen] }} />)
    const row = screen.getByTestId('knowledge-row')
    expect(within(row).queryByTestId('knowledge-verify')).toBeNull()
    expect(within(row).queryByTestId('knowledge-correct')).toBeNull()
    expect(within(row).queryByTestId('knowledge-remove')).toBeNull()
    // Nothing is ever deleted: the reason the row carries is still on the page.
    expect(row.textContent).toContain('wrong')
  })

  it('shows the chain when a row is expanded, with the provenance group name', () => {
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    const row = screen.getAllByTestId('knowledge-row')[0] as HTMLElement
    const group = within(row).getByTestId('details-group')
    expect(group.getAttribute('data-group')).toBe('provenance')
    fireEvent.click(within(group).getByRole('button'))
    const chain = within(row).getByTestId('knowledge-chain')
    expect(chain.textContent).toContain('m0')
    // The title of what it replaced, when this view knows it.
    expect(chain.textContent).toContain('An older claim about the orders route')
    // The raw provenance is INSIDE the group -- folded, never hidden (DetailsGroup's own rule).
    expect(chain.textContent).toContain('verification')
    expect(chain.textContent).toContain('r3f2a00')
  })

  it('lists every memory a correction replaced, not only one of them', () => {
    const many: KnowledgeRow = { ...VERIFIED, supersedesIds: ['m0', 'm00'] }
    render(<KnowledgeClient workspaceId="w1" initial={{ ...VIEW, rows: [many], memoryTitles: { m0: 'first', m00: 'second' } }} />)
    const row = screen.getByTestId('knowledge-row')
    fireEvent.click(within(within(row).getByTestId('details-group')).getByRole('button'))
    const chain = within(row).getByTestId('knowledge-chain')
    expect(chain.textContent).toContain('first')
    expect(chain.textContent).toContain('second')
  })

  it('asks the route again when a filter changes, and keeps the rows on screen while it waits', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...VIEW, rows: [VERIFIED] }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    fireEvent.change(screen.getByTestId('knowledge-filter-type'), { target: { value: 'fact' } })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('type=fact'))
    expect(screen.getAllByTestId('knowledge-row')).toHaveLength(2)
    vi.unstubAllGlobals()
  })

  it('asks for one status when a status is chosen, and for the live ones when none is', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => VIEW })
    vi.stubGlobal('fetch', fetchMock)
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    fireEvent.change(screen.getByTestId('knowledge-filter-status'), { target: { value: 'superseded' } })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('status=superseded'))
    fireEvent.change(screen.getByTestId('knowledge-filter-status'), { target: { value: '' } })
    // The route's own default -- verified plus the candidates waiting on a person.
    expect((fetchMock.mock.calls.at(-1)?.[0] as string).includes('status=')).toBe(false)
    vi.unstubAllGlobals()
  })

  it('searches on the title through the same route', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => VIEW })
    vi.stubGlobal('fetch', fetchMock)
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    fireEvent.change(screen.getByTestId('knowledge-filter-q'), { target: { value: 'checkout' } })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('q=checkout'))
    vi.unstubAllGlobals()
  })

  it('spells every filter option in words, never as the key it sends', () => {
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    const scope = screen.getByTestId('knowledge-filter-scope')
    const options = [...scope.querySelectorAll('option')]
    expect(options.map((one) => one.getAttribute('value'))).toContain('workspace')
    expect(options.map((one) => one.textContent)).toContain('This project')
    expect(options.map((one) => one.textContent)).not.toContain('workspace')
  })

  it('says what an empty project knows, which is nothing yet', () => {
    render(<KnowledgeClient workspaceId="w1" initial={{ ...VIEW, rows: [], counts: { verified: 0, candidates: 0 } }} />)
    expect(screen.getByTestId('knowledge-empty').textContent).toContain('nothing')
    expect(screen.queryByTestId('knowledge-rows')).toBeNull()
  })

  it('opens a drawer to correct a memory, and sends the new words to the supersede route', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, id: 'm9', replaced: 'm1' }) })
      .mockResolvedValue({ ok: true, json: async () => VIEW })
    vi.stubGlobal('fetch', fetchMock)
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    const row = screen.getAllByTestId('knowledge-row')[0] as HTMLElement
    fireEvent.click(within(row).getByTestId('knowledge-correct'))
    const drawer = screen.getByTestId('knowledge-correct-drawer')
    fireEvent.change(within(drawer).getByTestId('knowledge-correct-title'), { target: { value: 'A better title' } })
    fireEvent.change(within(drawer).getByTestId('knowledge-correct-body'), { target: { value: 'A better body' } })
    fireEvent.click(within(drawer).getByTestId('knowledge-correct-save'))
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/memories/m1/supersede',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: 'A better title', body: 'A better body' }) }),
      ),
    )
    vi.unstubAllGlobals()
  })

  it('verifies a candidate through its own route and then re-reads the page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, id: 'm2' }) })
      .mockResolvedValue({ ok: true, json: async () => VIEW })
    vi.stubGlobal('fetch', fetchMock)
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    const row = screen.getAllByTestId('knowledge-row')[1] as HTMLElement
    fireEvent.click(within(row).getByTestId('knowledge-verify'))
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/memories/m2/verify', expect.objectContaining({ method: 'POST' })),
    )
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1))
    vi.unstubAllGlobals()
  })

  it('carries the reason a person typed into the removal, and shows the refusal in place', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'a removal needs a reason' }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    const row = screen.getAllByTestId('knowledge-row')[0] as HTMLElement
    fireEvent.change(within(row).getByTestId('knowledge-remove-reason'), { target: { value: 'no longer true' } })
    fireEvent.click(within(row).getByTestId('knowledge-remove'))
    fireEvent.click(within(row).getByTestId('knowledge-remove-confirm'))
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/memories/m1/remove',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'no longer true' }) }),
      ),
    )
    await vi.waitFor(() => expect(within(row).getByTestId('knowledge-remove-error').textContent).toBe('a removal needs a reason'))
    vi.unstubAllGlobals()
  })

  it('says so rather than emptying itself when a refetch fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    render(<KnowledgeClient workspaceId="w1" initial={VIEW} />)
    fireEvent.change(screen.getByTestId('knowledge-filter-type'), { target: { value: 'fact' } })
    await vi.waitFor(() => expect(screen.getByTestId('knowledge-stale')).toBeDefined())
    expect(screen.getAllByTestId('knowledge-row')).toHaveLength(2)
    vi.unstubAllGlobals()
  })
})
