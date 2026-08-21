// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
  queuedMessage: null,
  recentEvents: [],
  costUsd: 0,
  toolCalls: 0,
  pausedAtStep: null,
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
        onOpen={() => {}}
      />,
    )
    // The live line wins over the snapshot's (spec §6) — the stream is fresher by construction.
    expect(screen.getByTestId('action-line').textContent).toBe('Write note3.txt')
    expect(screen.getByText('Add the thing')).toBeTruthy()
    expect(screen.getByTestId('status-label').textContent).toBe('working')
  })

  it('falls back to the snapshot action line when no live one has arrived', () => {
    render(<AgentCard agent={agent({ status: 'working', actionLine: 'Read a.ts' })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.getByTestId('action-line').textContent).toBe('Read a.ts')
  })

  it('pulses only while working', () => {
    const { rerender } = render(<AgentCard agent={agent({ status: 'working' })} liveActionLine={null} onOpen={() => {}} />)
    expect(screen.getByTestId('status-dot').className).toContain('animate-pulse')
    rerender(<AgentCard agent={agent({ status: 'paused' })} liveActionLine={null} onOpen={() => {}} />)
    // Motion carries information (spec §7): a pulsing paused agent is a lie on screen.
    expect(screen.getByTestId('status-dot').className).not.toContain('animate-pulse')
  })

  it('opens the detail panel via onOpen when the header is clicked — no more disabled M4 buttons', () => {
    const onOpen = vi.fn()
    render(<AgentCard agent={agent({ id: 'a9', status: 'working' })} liveActionLine={null} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /open alex's detail panel/i }))
    expect(onOpen).toHaveBeenCalledWith('a9')
    // The M5 controls live in the panel now (spec §6) — the card carries no pause/stop of its own.
    expect(screen.queryByTitle('arrives in M5')).toBeNull()
    expect(screen.queryByTitle('stop arrives in M5')).toBeNull()
  })
})

describe('HaltBanner', () => {
  it('shows the reason verbatim and names clear-halt', () => {
    render(<HaltBanner reason="the pause gate failed open (PreToolUse:Write exited 127)" />)
    expect(screen.getByRole('alert').textContent).toContain('PreToolUse:Write')
    expect(screen.getByRole('alert').textContent).toContain('clear-halt')
  })
})
