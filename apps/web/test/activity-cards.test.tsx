// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DomainEventType } from '@ai-team-os/db'
import { ACTIVITY_CARDS } from '../src/components/activity/cards.js'
import type { ActivityEventRow } from '../src/server/activity.js'

function baseEvent(type: DomainEventType, payload: Record<string, unknown>): ActivityEventRow {
  return {
    seq: 1,
    ts: '2026-08-22T10:00:00.000Z',
    type,
    actor: 'agent',
    agentId: 'a1',
    taskId: 't1',
    runId: 'r1',
    payload,
    summary: 'a summary',
  }
}

// One minimal-but-valid payload per type, field names copied from
// `packages/domain/src/events/schema.ts`'s `executionEventSchema` — the same source `cards.tsx`
// itself was built from.
const PAYLOAD_BY_TYPE: Record<DomainEventType, Record<string, unknown>> = {
  'task.created': { title: 'Add the thing' },
  'task.started': { title: 'Add the thing' },
  'task.done': { branch: 'feature/add-the-thing' },
  'task.rework': { reason: 'tests failed on attempt 1', attempt: 2 },
  'run.started': { sessionId: 's1' },
  'run.tool_call': { name: 'Read', summary: 'apps/web/src/index.ts' },
  'run.paused': { atStep: 4 },
  'run.resumed': { sessionId: 's1' },
  'agent.message_sent': { category: 'instruction', body: 'Please retry with the other approach.' },
  'guardrail.tripped': { guardrail: 'budget_exhausted', detail: 'Spent $20 of $20.' },
  'task.verifying': { commandCount: 3 },
  'task.verify_passed': { branch: 'feature/add-the-thing' },
  'task.verify_failed': { command: 'npm test', exitCode: 1 },
  'task.failed': { reason: 'guardrail tripped: budget_exhausted' },
  'run.output': { text: 'hello world' },
  'run.pause_requested': { requestedBy: 'human:eren' },
  'run.resume_requested': { requestedBy: 'human:eren', message: 'go ahead' },
  'run.stopped': { reason: 'operator requested stop' },
  'run.succeeded': { numTurns: 5, costUsd: 1.23 },
  'run.failed': { reason: 'the run crashed' },
  'task.dependency_added': {
    dependsOnTaskId: 't2',
    dependsOnTitle: 'Build the API',
    requestedBy: 'human:eren',
  },
  'task.dependency_removed': {
    dependsOnTaskId: 't2',
    dependsOnTitle: 'Build the API',
    requestedBy: 'human:eren',
  },
  'task.review_started': { title: 'Add the thing' },
  'task.review_approved': { reason: 'diff matches the task' },
  'task.review_rejected': { reason: 'edge case unhandled', attempt: 2 },
  'task.merge_failed': { reason: 'conflict in package.json' },
}

function fixtureFor(type: DomainEventType): ActivityEventRow {
  return baseEvent(type, PAYLOAD_BY_TYPE[type])
}

const CARD_PROPS = { workspaceId: 'w1', agentName: 'Alex', taskTitle: 'Add the thing' } as const

describe('ACTIVITY_CARDS registry', () => {
  for (const type of Object.keys(ACTIVITY_CARDS) as DomainEventType[]) {
    it(`renders a ${type} card with a payload section`, () => {
      const Card = ACTIVITY_CARDS[type]
      render(<Card event={fixtureFor(type)} {...CARD_PROPS} />)
      expect(screen.getByTestId('payload-toggle')).toBeTruthy()
    })
  }
})

describe('targeted card bodies', () => {
  it('run.tool_call shows the tool name', () => {
    const Card = ACTIVITY_CARDS['run.tool_call']
    render(<Card event={fixtureFor('run.tool_call')} {...CARD_PROPS} />)
    expect(screen.getByTestId('tool-name').textContent).toBe('Read')
  })

  it('run.failed shows the reason', () => {
    const Card = ACTIVITY_CARDS['run.failed']
    render(<Card event={fixtureFor('run.failed')} {...CARD_PROPS} />)
    expect(screen.getByTestId('run-failed-reason').textContent).toBe('the run crashed')
  })

  it('guardrail.tripped shows the limit name and the observed value', () => {
    const Card = ACTIVITY_CARDS['guardrail.tripped']
    render(<Card event={fixtureFor('guardrail.tripped')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('budget_exhausted')
    expect(screen.getByTestId('guardrail-detail').textContent).toBe('Spent $20 of $20.')
  })

  it('an intervention (run.pause_requested) shows who requested it', () => {
    const Card = ACTIVITY_CARDS['run.pause_requested']
    render(<Card event={fixtureFor('run.pause_requested')} {...CARD_PROPS} />)
    expect(screen.getByTestId('requested-by').textContent).toBe('human:eren')
  })

  it('run.resume_requested shows the queued message text when present', () => {
    const Card = ACTIVITY_CARDS['run.resume_requested']
    render(<Card event={fixtureFor('run.resume_requested')} {...CARD_PROPS} />)
    expect(screen.getByTestId('resume-message').textContent).toBe('go ahead')
  })

  it('agent.message_sent shows the actor and the message body', () => {
    const Card = ACTIVITY_CARDS['agent.message_sent']
    render(<Card event={fixtureFor('agent.message_sent')} {...CARD_PROPS} />)
    expect(screen.getByTestId('actor-badge').textContent).toBe('agent')
    expect(screen.getByTestId('message-body').textContent).toBe('Please retry with the other approach.')
  })

  it('task.dependency_added shows the dependency title and requester', () => {
    const Card = ACTIVITY_CARDS['task.dependency_added']
    render(<Card event={fixtureFor('task.dependency_added')} {...CARD_PROPS} />)
    expect(screen.getByTestId('depends-on-title').textContent).toBe('Build the API')
    expect(screen.getByTestId('requested-by').textContent).toBe('human:eren')
  })

  it('task.rework shows the reason', () => {
    const Card = ACTIVITY_CARDS['task.rework']
    render(<Card event={fixtureFor('task.rework')} {...CARD_PROPS} />)
    expect(screen.getByTestId('rework-reason').textContent).toBe('tests failed on attempt 1')
  })

  it('task.review_rejected shows the reason and the attempt number', () => {
    const Card = ACTIVITY_CARDS['task.review_rejected']
    render(<Card event={fixtureFor('task.review_rejected')} {...CARD_PROPS} />)
    expect(screen.getByTestId('review-rejected-reason').textContent).toBe('edge case unhandled')
    expect(screen.getByTestId('review-rejected-reason').parentElement?.textContent).toContain('(attempt 2)')
  })

  it('task.merge_failed shows the reason', () => {
    const Card = ACTIVITY_CARDS['task.merge_failed']
    render(<Card event={fixtureFor('task.merge_failed')} {...CARD_PROPS} />)
    expect(screen.getByTestId('merge-failed-reason').textContent).toBe('conflict in package.json')
  })

  it('falls back to the bare id when agentName/taskTitle are null', () => {
    const Card = ACTIVITY_CARDS['task.started']
    render(
      <Card event={fixtureFor('task.started')} workspaceId="w1" agentName={null} taskTitle={null} />,
    )
    expect(screen.getByTestId('agent-link').textContent).toBe('a1')
    expect(screen.getByTestId('task-link').textContent).toBe('t1')
  })

  it('links to the overview panel and the tasks board with the right ids', () => {
    const Card = ACTIVITY_CARDS['task.started']
    render(<Card event={fixtureFor('task.started')} {...CARD_PROPS} />)
    expect(screen.getByTestId('agent-link').getAttribute('href')).toBe('/w/w1?agent=a1')
    expect(screen.getByTestId('task-link').getAttribute('href')).toBe('/w/w1/tasks?task=t1')
  })
})

describe('payload expansion', () => {
  it('expands to pretty-printed JSON on toggle', () => {
    const Card = ACTIVITY_CARDS['run.tool_call']
    const { container } = render(<Card event={fixtureFor('run.tool_call')} {...CARD_PROPS} />)
    const details = container.querySelector('details')
    expect(details?.open).toBeFalsy() // collapsed by default

    fireEvent.click(screen.getByTestId('payload-toggle'))
    expect(details?.open).toBe(true)
    const payloadJson = screen.getByTestId('payload-json')
    expect(payloadJson.textContent).toBe(JSON.stringify(PAYLOAD_BY_TYPE['run.tool_call'], null, 2))
  })
})
