// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillsClient } from '../src/components/SkillsClient.js'
import type { SkillsPage } from '../src/server/skills.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }))

function page(over: Partial<SkillsPage> = {}): SkillsPage {
  return {
    providers: [
      {
        id: 'p1',
        name: 'plugin:superpowers',
        skills: [
          { id: 's1', name: 'writing-plans', description: 'plans things', runs: 18, state: 'ready', slaveIds: [] },
          { id: 's2', name: 'brainstorming', description: 'explores intent', runs: 24, state: 'ready', slaveIds: ['a1'] },
          { id: 's3', name: 'gone', description: 'was here once', runs: 2, state: 'missing', slaveIds: [] },
        ],
      },
    ],
    slaves: [{ id: 'a1', name: 'Alex Turner', status: 'working' }],
    scannedRoots: ['/home/x/.claude/skills', '/home/x/.claude/plugins/cache', '/repo/.claude/skills'],
    ...over,
  }
}

describe('SkillsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    routerRefresh.mockClear()
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('groups skills under their provider with run counts and usage bars normalized to the busiest', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getByTestId('provider-name-p1').textContent).toBe('plugin:superpowers')
    expect(screen.getByTestId('skill-runs-s2').textContent).toBe('24')
    // `brainstorming` is the busiest, so its bar is full and `writing-plans` is 18/24.
    expect(screen.getByTestId('skill-bar-s2').style.width).toBe('100%')
    expect(screen.getByTestId('skill-bar-s1').style.width).toBe('75%')
  })

  it('draws every bar empty when nothing has been invoked, rather than dividing by zero', () => {
    render(
      <SkillsClient
        page={page({
          providers: [
            {
              id: 'p1',
              name: 'personal',
              skills: [{ id: 's1', name: 'quiet', description: 'never called', runs: 0, state: 'ready', slaveIds: [] }],
            },
          ],
        })}
      />,
    )
    expect(screen.getByTestId('skill-bar-s1').style.width).toBe('0%')
    expect(screen.getByTestId('skill-runs-s1').textContent).toBe('0')
  })

  it('marks a skill whose file is gone as missing without hiding its history', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getByTestId('skill-state-s3').textContent).toBe('missing')
    expect(screen.getByTestId('skill-runs-s3').textContent).toBe('2')
  })

  it('renders every skill as a domain tile tagged by its provider', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getAllByTestId('domain-tile')).toHaveLength(3)
    expect(screen.getAllByTestId('domain-source')[0]?.textContent).toBe('plugin:superpowers')
  })

  it('shows the three scanned roots on the add-source tile and offers no way to change them', () => {
    render(<SkillsClient page={page()} />)
    fireEvent.click(screen.getByTestId('empty-tile'))
    expect(screen.getByTestId('scanned-roots').textContent).toContain('/repo/.claude/skills')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('assigns a skill to the chosen slave and unassigns it again', async (): Promise<void> => {
    render(<SkillsClient page={page()} />)
    await act(async () => {
      fireEvent.change(screen.getByTestId('skill-slave-s1'), { target: { value: 'a1' } })
      fireEvent.click(screen.getByTestId('skill-assign-s1'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/skills/assign',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ slaveId: 'a1', skillId: 's1' }) }),
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('skill-unassign-s2-a1'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/skills/assign',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ slaveId: 'a1', skillId: 's2' }) }),
    )
    // The refetch loop owns truth: nothing is written into local state from a 200.
    expect(routerRefresh).toHaveBeenCalledTimes(2)
  })

  it('shows a refusal verbatim', async (): Promise<void> => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'no skill with id s1' }), { status: 409 }))
    render(<SkillsClient page={page()} />)
    await act(async () => {
      fireEvent.change(screen.getByTestId('skill-slave-s1'), { target: { value: 'a1' } })
      fireEvent.click(screen.getByTestId('skill-assign-s1'))
    })
    expect(screen.getByTestId('skills-error').textContent).toBe('no skill with id s1')
  })

  it('refuses to assign when there is no slave to assign to, and says why', () => {
    render(<SkillsClient page={page({ slaves: [] })} />)
    // `getAttribute` rather than jest-dom's `toBeDisabled` -- this repo carries no jest-dom
    // matchers (`runtime-card.test.tsx:84`).
    expect(screen.getByTestId('skill-assign-s1').getAttribute('disabled')).not.toBeNull()
    expect(screen.getByTestId('skills-no-slaves').textContent).toBe('no slaves yet')
  })

  it('says the catalog is empty rather than drawing an empty frame', () => {
    render(<SkillsClient page={page({ providers: [] })} />)
    expect(screen.getByTestId('skills-empty').textContent).toContain('no skills found')
    // The add-source tile survives an empty catalog -- it is what tells an operator where to look.
    expect(screen.getByTestId('empty-tile')).toBeTruthy()
  })
})
