// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DomainEventType } from '@ai-team-os/db'
import { ActivityCard } from '../src/components/activity/ActivityCard.js'
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
    userId: null,
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
  'run.tool_denied': { tool: 'Bash', capability: 'run tests' },
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
  'task.worktree_collected': {
    path: '/repo/.aiteamos/worktrees/T-abc',
    reason: 'operator',
    branch: 'aiteamos/T-abc-x',
  },
  'workspace.goal_set': { goal: 'Ship the checkout flow' },
  'workspace.plan_created': {
    goal: 'Ship the checkout flow',
    tasks: [
      { id: 'TASK-1', title: 'Build the API', role: 'backend' },
      { id: 'TASK-2', title: 'Wire up the form', role: 'frontend' },
    ],
  },
  'workspace.company_assigned': {
    company: 'Acme Corp',
    workers: [
      { companyAgentId: 'ca-1', name: 'Alex', role: 'backend' },
      { companyAgentId: 'ca-2', name: 'Sam', role: 'frontend' },
    ],
  },
  'workspace.settings_changed': { field: 'provider', from: null, to: 'cursor' },
  'workspace.created': {
    name: 'Billing',
    repoPath: '/home/eren/repos/billing',
    baseBranch: 'main',
    verifyCommands: ['npm test', 'npm run lint'],
    provider: 'claude_code',
  },
  'org.changed': { entity: 'agent', id: 'ag-1', field: 'name', from: 'Alex', to: 'Alexis' },
}

function fixtureFor(type: DomainEventType): ActivityEventRow {
  return baseEvent(type, PAYLOAD_BY_TYPE[type])
}

// `dimmed` widening (M14 Task 12): the roster filter dims a row rather than hiding it, so every
// card in the registry forwards the flag through `ActivityCardProps`. Undimmed is the default
// every existing assertion in this file was written against.
const CARD_PROPS = {
  workspaceId: 'w1',
  agentName: 'Alex',
  taskTitle: 'Add the thing',
  userName: null,
  dimmed: false,
} as const

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

  it('run.tool_denied shows the tool and the denied capability', () => {
    const Card = ACTIVITY_CARDS['run.tool_denied']
    render(<Card event={fixtureFor('run.tool_denied')} {...CARD_PROPS} />)
    expect(screen.getByTestId('tool-denied-text').textContent).toBe('Bash denied — run tests')
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

  it('task.worktree_collected shows the path and the reason', () => {
    const Card = ACTIVITY_CARDS['task.worktree_collected']
    render(<Card event={fixtureFor('task.worktree_collected')} {...CARD_PROPS} />)
    expect(screen.getByTestId('worktree-collected-path').textContent).toBe('/repo/.aiteamos/worktrees/T-abc')
    expect(screen.getByTestId('transition-label').textContent).toBe('worktree collected')
  })

  it('org.changed shows the label for its field and the from/to values', () => {
    const Card = ACTIVITY_CARDS['org.changed']
    render(<Card event={fixtureFor('org.changed')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('renamed')
    expect(screen.getByTestId('org-from').textContent).toBe('Alex')
    expect(screen.getByTestId('org-to').textContent).toBe('Alexis')
  })

  it('org.changed renders — for a null to (a delete)', () => {
    const Card = ACTIVITY_CARDS['org.changed']
    const event = baseEvent('org.changed', { entity: 'team', id: 't-1', field: 'deleted', from: 'Design', to: null })
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('deleted')
    expect(screen.getByTestId('org-to').textContent).toBe('—')
  })

  it('org.changed renders — for a null from (a department created, M25)', () => {
    const Card = ACTIVITY_CARDS['org.changed']
    const event = baseEvent('org.changed', { entity: 'team', id: 't-1', field: 'created', from: null, to: 'Design' })
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('created')
    expect(screen.getByTestId('org-from').textContent).toBe('—')
    expect(screen.getByTestId('org-to').textContent).toBe('Design')
  })

  it('org.changed shows "moved to department" for a moved agent (M25)', () => {
    const Card = ACTIVITY_CARDS['org.changed']
    const event = baseEvent('org.changed', { entity: 'agent', id: 'ag-1', field: 'team', from: 'Engineering', to: 'QA' })
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('moved to department')
    expect(screen.getByTestId('org-from').textContent).toBe('Engineering')
    expect(screen.getByTestId('org-to').textContent).toBe('QA')
  })

  it('workspace.created shows the name, repo path and verify command count', () => {
    const Card = ACTIVITY_CARDS['workspace.created']
    render(<Card event={fixtureFor('workspace.created')} {...CARD_PROPS} />)
    expect(screen.getByTestId('workspace-created-name').textContent).toBe('Billing')
    expect(screen.getByTestId('transition-label').textContent).toBe('workspace created')
    expect(screen.getByTestId('activity-card').textContent).toContain('2 verify commands')
  })

  it('workspace.goal_set shows the goal text', () => {
    const Card = ACTIVITY_CARDS['workspace.goal_set']
    render(<Card event={fixtureFor('workspace.goal_set')} {...CARD_PROPS} />)
    expect(screen.getByTestId('goal-text').textContent).toBe('Ship the checkout flow')
  })

  it('workspace.plan_created shows the task count and the title+role list', () => {
    const Card = ACTIVITY_CARDS['workspace.plan_created']
    render(<Card event={fixtureFor('workspace.plan_created')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('planned 2 tasks')
    const items = screen.getAllByTestId('plan-task-item')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('Build the API')
    expect(items[0]?.textContent).toContain('backend')
    expect(items[1]?.textContent).toContain('Wire up the form')
    expect(items[1]?.textContent).toContain('frontend')
  })

  it('workspace.company_assigned shows the company and the new workers name+role list', () => {
    const Card = ACTIVITY_CARDS['workspace.company_assigned']
    render(<Card event={fixtureFor('workspace.company_assigned')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('company assigned')
    expect(screen.getByTestId('company-name').textContent).toBe('Acme Corp')
    const items = screen.getAllByTestId('company-worker-item')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('Alex')
    expect(items[0]?.textContent).toContain('backend')
    expect(items[1]?.textContent).toContain('Sam')
    expect(items[1]?.textContent).toContain('frontend')
  })

  it('workspace.company_assigned renders legacy workers missing companyAgentId without duplicate-key warnings', () => {
    const Card = ACTIVITY_CARDS['workspace.company_assigned']
    render(
      <Card
        event={{
          ...fixtureFor('workspace.company_assigned'),
          payload: {
            company: 'Acme Corp',
            workers: [
              { name: 'Alex', role: 'backend' },
              { name: 'Sam', role: 'frontend' },
            ],
          },
        }}
        {...CARD_PROPS}
      />,
    )
    const items = screen.getAllByTestId('company-worker-item')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('Alex')
    expect(items[0]?.textContent).toContain('backend')
    expect(items[1]?.textContent).toContain('Sam')
    expect(items[1]?.textContent).toContain('frontend')
  })

  it('workspace.company_assigned shows a no-new-workers line when workers is empty', () => {
    const Card = ACTIVITY_CARDS['workspace.company_assigned']
    render(
      <Card
        event={{
          ...fixtureFor('workspace.company_assigned'),
          payload: { company: 'Acme Corp', workers: [] },
        }}
        {...CARD_PROPS}
      />,
    )
    expect(screen.getByTestId('company-name').textContent).toBe('Acme Corp')
    expect(screen.queryAllByTestId('company-worker-item')).toHaveLength(0)
    expect(screen.getByTestId('company-no-workers').textContent).toBe('no new workers')
  })

  it('falls back to the bare id when agentName/taskTitle are null', () => {
    const Card = ACTIVITY_CARDS['task.started']
    render(
      <Card
        event={fixtureFor('task.started')}
        workspaceId="w1"
        agentName={null}
        taskTitle={null}
        userName={null}
        dimmed={false}
      />,
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

describe('RunSucceededCard', () => {
  it('shows the unknown mark, not $0.00, when the run reported no cost', () => {
    // M12 Task 9 / ruling R3. The payload's `costUsd` is nullable because a runtime that reports
    // no spend emits null -- rendering `$0.00` here would put a figure on the timeline that no
    // runtime ever produced.
    const Card = ACTIVITY_CARDS['run.succeeded']
    render(<Card event={baseEvent('run.succeeded', { numTurns: 5, costUsd: null })} {...CARD_PROPS} />)

    const stats = screen.getByTestId('run-succeeded-stats').textContent
    expect(stats).toContain('5 turns')
    expect(stats).toContain('—')
    expect(stats).not.toContain('$0.00')
  })

  it('still shows a real figure when the run did report one', () => {
    const Card = ACTIVITY_CARDS['run.succeeded']
    render(<Card event={baseEvent('run.succeeded', { numTurns: 5, costUsd: 1.23 })} {...CARD_PROPS} />)

    expect(screen.getByTestId('run-succeeded-stats').textContent).toContain('$1.23')
  })
})

// ---- M14 Task 12: the river row (design README "1c", spec §5.5) -----------------------------

describe('the river row', () => {
  const base = {
    event: {
      seq: 1,
      ts: '2026-08-29T10:00:00.000Z',
      type: 'run.tool_call' as const,
      actor: 'agent',
      agentId: 'a1',
      taskId: null,
      runId: 'r1',
      userId: null,
      payload: {},
      summary: 'Write a.txt',
    },
    workspaceId: 'w1',
    agentName: 'Alex',
    taskTitle: null,
    userName: null,
    dimmed: false,
  }

  it('renders "by ada" after the actor badge when the event carries a userName', () => {
    render(
      <ActivityCard {...base} userName="ada">
        body
      </ActivityCard>,
    )
    expect(screen.getByTestId('event-user').textContent).toBe('by ada')
  })

  it('renders no event-user chip when the event carries no userName', () => {
    render(<ActivityCard {...base}>body</ActivityCard>)
    expect(screen.queryByTestId('event-user')).toBeNull()
  })

  it('lays out 74px timestamp, 28px dot gutter, then who + kind + text', () => {
    render(<ActivityCard {...base}>body</ActivityCard>)
    expect(screen.getByTestId('event-time').className).toContain('w-[74px]')
    expect(screen.getByTestId('event-time').className).toContain('text-right')
    expect(screen.getByTestId('event-gutter').className).toContain('w-[28px]')
    expect(screen.getByTestId('event-dot').className).toContain('h-[7px]')
  })

  it("gives the dot the mockup's 7px box and its 0 0 9px glow in the event's own tone", () => {
    render(<ActivityCard {...base}>body</ActivityCard>)
    const dot = screen.getByTestId('event-dot')
    // `run.*` is the working tone (a run doing work) — see `toneForEventType`.
    expect(dot.className).toContain('w-[7px]')
    expect(dot.className).toContain('bg-tone-working')
    expect(dot.className).toContain('shadow-[0_0_9px_var(--color-tone-working)]')
  })

  it('tones the dot by kind prefix, not by one hardcoded colour', () => {
    const { rerender } = render(<ActivityCard {...base}>body</ActivityCard>)
    rerender(
      <ActivityCard {...base} event={{ ...base.event, type: 'guardrail.tripped' }}>
        body
      </ActivityCard>,
    )
    expect(screen.getByTestId('event-dot').className).toContain('bg-tone-blocked')
  })

  it('dims a non-matching row to opacity .35 rather than hiding it', () => {
    const { rerender } = render(<ActivityCard {...base}>body</ActivityCard>)
    expect(screen.getByTestId('activity-card').className).not.toContain('opacity-[.35]')

    rerender(
      <ActivityCard {...base} dimmed>
        body
      </ActivityCard>,
    )
    expect(screen.getByTestId('activity-card').className).toContain('opacity-[.35]')
  })

  it('keeps the payload disclosure', () => {
    render(<ActivityCard {...base}>body</ActivityCard>)
    expect(screen.getByTestId('payload-toggle')).toBeTruthy()
  })

  it("renders the row's trailing ref, and the unknown mark when the event carries no task", () => {
    render(<ActivityCard {...base}>body</ActivityCard>)
    expect(screen.getByTestId('event-ref').textContent).toBe('—')
  })
})
