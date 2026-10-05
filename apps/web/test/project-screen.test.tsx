// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectView } from '@slave-of-ai/control'
import { ProjectScreen } from '../src/components/project/ProjectScreen'
import { stubBrowser, stubFetch } from './fixtures/dom'
import { buildFixture, projectFixture } from './fixtures/project'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }), usePathname: () => '/w/ws-1' }))

beforeAll(() => stubBrowser())
afterEach(() => vi.unstubAllGlobals())

function show(project: ProjectView): ReturnType<typeof stubFetch> {
  // The Continue route answers with its own envelope (how many paused runs resume); every other
  // call here is the screen's refresh.
  const fetchMock = stubFetch((url) => (url.endsWith('/continue') ? { body: { ok: true, cleared: true, requested: [], refused: [] } } : { body: { project } }))
  render(<ProjectScreen initial={project} />)
  return fetchMock
}

describe('the Project screen (lead UX design section 6.3)', () => {
  it('shows a building project: its word and sentence, Stop, who is working and the proof', () => {
    show(projectFixture())
    expect(screen.getByTestId('phase-badge').textContent).toBe('Building')
    expect(screen.getByTestId('phase-sentence').textContent).toBe("The lead is building what you asked for. You don't need to do anything.")
    expect(screen.getByTestId('stop')).toBeTruthy()
    expect(screen.queryByTestId('continue')).toBeNull()
    const faces = screen.getAllByTestId('face')
    expect(faces.map((face) => face.getAttribute('data-kind'))).toEqual(['lead', 'helper'])
    expect(faces[1]?.textContent).toContain('Editing src/app.ts')
    expect(screen.getAllByTestId('proof-row')).toHaveLength(2)
    expect(screen.getByTestId('limits-spent').textContent).toBe('$4.20 of $20')
    expect(screen.getByTestId('limits-time').textContent).toBe('38 min of 1 h 30 min')
    expect(screen.queryByTestId('decision-card')).toBeNull()
  })

  it('puts the decision card first when the build stopped, and has no Stop', () => {
    show(projectFixture({ phase: 'needs_decision', build: buildFixture({ leadState: 'awaiting_decision', status: 'needs_human', stopReason: 'no_progress' }) }))
    expect(screen.getByTestId('decision-card')).toBeTruthy()
    expect(screen.queryByTestId('stop')).toBeNull()
    expect(screen.queryByTestId('who-is-working')).toBeNull()
  })

  it('offers Continue on a paused project, and sends it', async () => {
    const fetchMock = show(projectFixture({ phase: 'paused', haltedReason: 'emergency stop by web operator' }))
    expect(screen.getByTestId('who-is-working').textContent).toContain('Paused')
    await act(async () => screen.getByTestId('continue').click())
    expect(fetchMock).toHaveBeenCalledWith('/api/w/ws-1/continue', expect.objectContaining({ method: 'POST' }))
  })

  it('says why Slave stopped a project that failed', () => {
    show(projectFixture({ phase: 'failed', haltedReason: 'verify_not_configured' }))
    expect(screen.getByTestId('failed-alert').textContent).toContain('verify_not_configured')
    expect(screen.getByTestId('continue')).toBeTruthy()
  })

  it('shows the result and the report link for a delivered build', () => {
    show(projectFixture({ phase: 'delivered', build: buildFixture({ leadState: 'delivered', status: 'accepted', mergedAt: '2026-10-05T10:00:00.000Z', mergeCommit: 'abc1234def' }) }))
    expect(screen.getByTestId('result').textContent).toContain('Merged into main at abc1234')
  })

  it('opens an empty project with Start a build', () => {
    show(projectFixture({ phase: 'empty', goal: null, goalVersion: 0, build: null, builds: [] }))
    expect(screen.getByTestId('goal-section').textContent).toContain('Nothing has been asked for yet.')
    expect(screen.getByTestId('goal-composer').textContent).toContain('Start a build')
  })

  it('opens an older project read-only: its tasks in words, no composer, no Stop', () => {
    show(
      projectFixture({
        flow: 'packages',
        phase: 'older',
        build: null,
        builds: [],
        older: { tasks: [{ id: 't', title: 'Add login', state: 'review', status: 'reviewing' }], pendingDecisions: 2 },
      }),
    )
    expect(screen.getByTestId('older-notice').textContent).toContain('supervisor-decisions --workspace ws-1')
    expect(screen.getByTestId('older-task').textContent).toContain('Being reviewed')
    expect(screen.queryByTestId('goal-composer')).toBeNull()
    expect(screen.queryByTestId('stop')).toBeNull()
  })

  it('asks for a change through the change route', async () => {
    const fetchMock = show(projectFixture())
    const input = screen.getByTestId('goal-input') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(input, 'Add a dark mode')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => screen.getByTestId('goal-send').click())
    expect(fetchMock).toHaveBeenCalledWith('/api/w/ws-1/goal/request', expect.objectContaining({ method: 'POST', body: JSON.stringify({ request: 'Add a dark mode' }) }))
  })
})
