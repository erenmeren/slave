// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ActivityDigest } from '../src/components/project/ActivityDigest.js'
import type { DigestDay } from '../src/server/activityDigest.js'

function day(overrides: Partial<DigestDay> = {}): DigestDay {
  return {
    id: '2026-09-19',
    when: 'today',
    items: [
      {
        id: '3',
        at: '2026-09-19T14:05:00.000Z',
        type: 'task.done',
        sentence: 'Alex finished "Retry the charge"',
        actorName: 'Alex',
        workspaceId: 'w1',
      },
      {
        id: '2',
        at: '2026-09-19T13:00:00.000Z',
        type: 'task.started',
        sentence: 'Alex picked up "Retry the charge"',
        actorName: 'Alex',
        workspaceId: 'w1',
      },
    ],
    ...overrides,
  }
}

describe('ActivityDigest', () => {
  it('renders one digest-day header per day, with the when label, and one digest-item per happening', () => {
    render(<ActivityDigest workspaceId="w1" days={[day()]} />)

    const days = screen.getAllByTestId('digest-day')
    expect(days).toHaveLength(1)
    expect(within(days[0]!).getByText('today')).toBeTruthy()

    const items = screen.getAllByTestId('digest-item')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('Alex finished "Retry the charge"')
  })

  // `docs/ia.md` rule 3: the raw type rides on an attribute, never as the visible label -- `title`
  // carries it here, the same contract every other projected row keeps.
  it('carries the raw event type in title, never as visible text', () => {
    render(<ActivityDigest workspaceId="w1" days={[day()]} />)

    const items = screen.getAllByTestId('digest-item')
    expect(items[0]?.getAttribute('title')).toBe('task.done')
    expect(items[1]?.getAttribute('title')).toBe('task.started')
    expect(items[0]?.textContent).not.toContain('task.done')
  })

  it('renders multiple days newest first, each keeping its own item order', () => {
    const today = day()
    const yesterday = day({
      id: '2026-09-18',
      when: 'yesterday',
      items: [
        {
          id: '1',
          at: '2026-09-18T09:00:00.000Z',
          type: 'task.created',
          sentence: '"Retry the charge" was added to the board',
          actorName: null,
          workspaceId: 'w1',
        },
      ],
    })
    render(<ActivityDigest workspaceId="w1" days={[today, yesterday]} />)

    const days = screen.getAllByTestId('digest-day')
    expect(days.map((el) => el.textContent?.includes('today'))).toEqual([true, false])
    expect(days.map((el) => el.textContent?.includes('yesterday'))).toEqual([false, true])
  })

  it('falls back to "S" for an unattributed happening rather than an empty avatar', () => {
    render(
      <ActivityDigest
        workspaceId="w1"
        days={[
          day({
            items: [
              {
                id: '1',
                at: '2026-09-19T09:00:00.000Z',
                type: 'workspace.goal_set',
                sentence: 'The Supervisor decided: something',
                actorName: null,
                workspaceId: 'w1',
              },
            ],
          }),
        ]}
      />,
    )
    expect(screen.getByTestId('avatar-tile').textContent).toBe('S')
  })

  it('says so when the workspace has no happenings at all', () => {
    render(<ActivityDigest workspaceId="w1" days={[]} />)
    expect(screen.getByTestId('digest-empty')).toBeTruthy()
    expect(screen.queryByTestId('digest-day')).toBeNull()
  })

  it('says so when the workspace could not be found', () => {
    render(<ActivityDigest workspaceId="w1" days={null} />)
    expect(screen.getByTestId('digest-unavailable').textContent).toContain('w1')
  })
})
