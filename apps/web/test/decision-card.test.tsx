// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DecisionCard } from '../src/components/project/DecisionCard'
import { stubBrowser, stubFetch } from './fixtures/dom'
import { buildFixture, projectFixture } from './fixtures/project'

beforeAll(() => stubBrowser())
afterEach(() => vi.unstubAllGlobals())

const stopped = projectFixture({ phase: 'needs_decision', build: buildFixture({ leadState: 'awaiting_decision', status: 'needs_human', stopReason: 'budget_spent' }) })

describe('the decision card (lead UX design section 6.3, U-3)', () => {
  it('is not there while the build needs nobody', () => {
    render(<DecisionCard project={projectFixture({ phase: 'building' })} onDone={async () => {}} />)
    expect(screen.queryByTestId('decision-card')).toBeNull()
  })

  it('says why a stopped build stopped and what is not proven, with its three answers', () => {
    render(<DecisionCard project={stopped} onDone={async () => {}} />)
    const card = screen.getByTestId('decision-card')
    expect(card.getAttribute('role')).toBe('alert')
    expect(card.textContent).toContain('Build 2 needs your decision')
    expect(card.textContent).toContain('The budget ran out.')
    expect(screen.getByTestId('unproven').textContent).toContain("Requirement 2: Doesn't work — Deleting answered 500.")
    expect(card.textContent).toContain('Spent $4.20 of $20 · worked 38 min')
    for (const decision of ['accept', 'retry', 'leave']) expect(screen.getByTestId(`decide-${decision}`)).toBeTruthy()
  })

  it('sends Check again at once, to the build\'s retry route', async () => {
    const fetchMock = stubFetch(() => ({ body: { ok: true } }))
    const onDone = vi.fn(async () => {})
    render(<DecisionCard project={stopped} onDone={onDone} />)
    await act(async () => screen.getByTestId('decide-retry').click())
    expect(fetchMock).toHaveBeenCalledWith('/api/w/ws-1/goals/2/retry', expect.objectContaining({ method: 'POST' }))
    expect(onDone).toHaveBeenCalled()
  })

  it('asks once more before Accept as it is, and sends it only on yes', async () => {
    const fetchMock = stubFetch(() => ({ body: { ok: true } }))
    render(<DecisionCard project={stopped} onDone={async () => {}} />)
    await act(async () => screen.getByTestId('decide-accept').click())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('decision-confirm').textContent).toContain('Accept this build as it is?')
    await act(async () => screen.getByTestId('decision-confirm-yes').click())
    expect(fetchMock).toHaveBeenCalledWith('/api/w/ws-1/goals/2/accept', expect.objectContaining({ method: 'POST' }))
  })

  it('offers I merged it and automatic merge for a build waiting for a hand merge, naming the branch', async () => {
    const fetchMock = stubFetch(() => ({ body: { ok: true } }))
    render(<DecisionCard project={projectFixture({ phase: 'ready_to_merge', autoMerge: false, build: buildFixture({ status: 'accepted', leadState: 'awaiting_decision' }) })} onDone={async () => {}} />)
    expect(screen.getByTestId('decision-card').textContent).toContain('Build 2 is ready to merge')
    expect(screen.getByTestId('merge-branch').textContent).toBe('slaveofai/goal-v2')
    await act(async () => screen.getByTestId('decide-auto-merge').click())
    expect(fetchMock).toHaveBeenCalledWith('/api/w/ws-1/integration', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ autoMerge: true }) }))
    await act(async () => screen.getByTestId('decide-merged').click())
    expect(fetchMock).toHaveBeenCalledWith('/api/w/ws-1/goals/2/merged', expect.objectContaining({ method: 'POST' }))
  })

  it('says why Slave could not merge, when git refused', () => {
    render(<DecisionCard project={projectFixture({ phase: 'ready_to_merge', build: buildFixture({ status: 'accepted', mergeError: 'CONFLICT in app.ts' }) })} onDone={async () => {}} />)
    expect(screen.getByTestId('decision-card').textContent).toContain('Slave could not merge it: CONFLICT in app.ts')
  })
})
