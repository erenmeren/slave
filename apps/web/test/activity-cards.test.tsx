// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DomainEventType } from '@slave-of-ai/db'
import { ActivityCard } from '../src/components/activity/ActivityCard.js'
import { ACTIVITY_CARDS } from '../src/components/activity/cards.js'
import type { ActivityEventRow } from '../src/server/activity.js'

function baseEvent(type: DomainEventType, payload: Record<string, unknown>): ActivityEventRow {
  return {
    seq: 1,
    ts: '2026-08-22T10:00:00.000Z',
    type,
    actor: 'slave',
    slaveId: 'a1',
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
  'slave.message_sent': { category: 'instruction', body: 'Please retry with the other approach.' },
  'slave.message_reassigned': {
    messageId: 'm-1',
    decisionId: 'sd-0123456789',
    from: { role: 'reviewer', slaveId: null },
    to: { slaveId: 'ag-2' },
    actor: 'supervisor',
  },
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
    path: '/repo/.slaveofai/worktrees/T-abc',
    reason: 'operator',
    branch: 'slaveofai/T-abc-x',
  },
  // M45 t1: `request` is the optional words a person typed when they asked for a change. Carried
  // here so the registry is exercised against the payload the schema now allows -- the card reads
  // the goal and is unaffected by it, which is the point (spec erratum E24).
  'workspace.goal_set': { goal: 'Ship the checkout flow', request: 'add Apple Pay' },
  'workspace.plan_created': {
    goal: 'Ship the checkout flow',
    goalVersion: 1,
    tasks: [
      { id: 'TASK-1', title: 'Build the API', role: 'backend' },
      { id: 'TASK-2', title: 'Wire up the form', role: 'frontend' },
    ],
  },
  'workspace.replan_started': { version: 2, runId: 'r1' },
  'workspace.replanned': {
    version: 2,
    runId: 'r1',
    added: ['TASK-3'],
    proposedCancellations: ['TASK-1'],
    droppedCancellations: [{ taskId: 'TASK-2', status: 'running' }],
    // M40 t3 fix round 1: cancellable ids that never became a proposal (a throw, a cooldown, a
    // disabled Supervisor). `cancel = proposed ∪ failed ∪ dropped`.
    failedProposals: ['TASK-4'],
  },
  'task.cancelled': { reason: 'the re-plan for goal v2 no longer needs it', goalVersion: 1 },
  'workspace.company_assigned': {
    company: 'Acme Corp',
    workers: [
      { companySlaveId: 'ca-1', name: 'Alex', role: 'backend' },
      { companySlaveId: 'ca-2', name: 'Sam', role: 'frontend' },
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
  'org.changed': { entity: 'slave', id: 'ag-1', field: 'name', from: 'Alex', to: 'Alexis' },
  'workspace.archived': { name: 'Billing', departments: 2, slaves: 5, tasks: 8, runs: 22 },
  'workspace.restored': { name: 'Billing' },
  'task.integrated': {},
  'task.unblocked': { attempt: 2, maxAttempts: 3 },
  'slave.profile_changed': {
    target: 'slave',
    targetId: 'ag-1',
    sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    actor: 'eren',
  },
  'slave.runtime_roles_changed': { slaveId: 'ag-1', roles: ['backend', 'reviewer'], actor: 'eren' },
  'supervisor.decided': {
    decisionId: 'sd-0123456789',
    situationKind: 'review_cap_blocked',
    subjectId: 't1',
    tier: 'applied',
    decidedBy: 'model',
    action: { kind: 'unblock_task' },
  },
  'supervisor.proposed': {
    decisionId: 'sd-0123456789',
    situationKind: 'no_reviewer',
    subjectId: 'reviewer',
    action: { kind: 'set_runtime_roles' },
    expiresAt: '2026-08-23T10:00:00.000Z',
  },
  'supervisor.applied': { decisionId: 'sd-0123456789', action: { kind: 'unblock_task' } },
  'supervisor.resolved': { decisionId: 'sd-0123456789', outcome: 'approved', reason: null },
  'supervisor.failed': {
    decisionId: 'sd-0123456789',
    action: { kind: 'mark_task_failed' },
    reason: 'task_not_failable',
  },
  'workspace.runbook_adopted': { runbookId: 'rb-0123456789', key: 'feature-delivery', name: 'Feature delivery' },
  'memory.recorded': {
    memoryId: 'mem-0123456789',
    type: 'fact',
    scope: 'workspace',
    status: 'verified',
    sourceKind: 'verification',
  },
  'memory.changed': { memoryId: 'mem-0123456789', from: 'candidate', to: 'superseded' },
}

function fixtureFor(type: DomainEventType): ActivityEventRow {
  return baseEvent(type, PAYLOAD_BY_TYPE[type])
}

// `dimmed` widening (M14 Task 12): the roster filter dims a row rather than hiding it, so every
// card in the registry forwards the flag through `ActivityCardProps`. Undimmed is the default
// every existing assertion in this file was written against.
const CARD_PROPS = {
  workspaceId: 'w1',
  slaveName: 'Alex',
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

  it('slave.message_sent shows the actor and the message body', () => {
    const Card = ACTIVITY_CARDS['slave.message_sent']
    render(<Card event={fixtureFor('slave.message_sent')} {...CARD_PROPS} />)
    expect(screen.getByTestId('actor-badge').textContent).toBe('slave')
    expect(screen.getByTestId('message-body').textContent).toBe('Please retry with the other approach.')
  })

  // M39 t4: the real card. Nothing was SENT, so there is no body -- what happened is a move, and
  // the card owes a reader its two ends, who made it, and the decision it came from.
  it('slave.message_reassigned shows who moved the question, from where to whom, and the decision behind it', () => {
    const Card = ACTIVITY_CARDS['slave.message_reassigned']
    render(<Card event={fixtureFor('slave.message_reassigned')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('question re-addressed')
    expect(screen.getByTestId('reassigned-from').textContent).toBe('the reviewer role')
    expect(screen.getByTestId('reassigned-to').textContent).toBe('ag-2')
    expect(screen.getByTestId('reassigned-actor').textContent).toBe('supervisor')
    // The same short id every `supervisor.*` row of this decision's life carries, so the move and
    // the decision that proposed it can be tied together by eye.
    expect(screen.getByTestId('supervisor-decision').textContent).toBe('sd-01234')
  })

  it('slave.message_reassigned names the slave it was taken from when it was addressed by name, and links no decision when a human moved it', () => {
    const Card = ACTIVITY_CARDS['slave.message_reassigned']
    const event = baseEvent('slave.message_reassigned', {
      messageId: 'm-1',
      decisionId: null,
      from: { role: null, slaveId: 'ag-1' },
      to: { slaveId: 'ag-2' },
      actor: 'eren',
    })
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('reassigned-from').textContent).toBe('ag-1')
    expect(screen.getByTestId('reassigned-actor').textContent).toBe('eren')
    expect(screen.queryByTestId('supervisor-decision')).toBeNull()
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
    expect(screen.getByTestId('worktree-collected-path').textContent).toBe('/repo/.slaveofai/worktrees/T-abc')
    expect(screen.getByTestId('transition-label').textContent).toBe('worktree collected')
  })

  // M37 t3: the two profile/role events. The hash is shown by its first 12 characters only, and a
  // cleared profile (`sha256: null`) shows no hash at all -- there is no text to point at.
  it('slave.profile_changed names the level written, the actor and the hash prefix', () => {
    const Card = ACTIVITY_CARDS['slave.profile_changed']
    render(<Card event={fixtureFor('slave.profile_changed')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('profile set')
    expect(screen.getByTestId('profile-target').textContent).toBe('this worker')
    expect(screen.getByTestId('profile-actor').textContent).toBe('eren')
    expect(screen.getByTestId('profile-sha').textContent).toBe(' · abcdef012345')
  })

  it('slave.profile_changed says cleared, and shows no hash, for a null sha256', () => {
    const Card = ACTIVITY_CARDS['slave.profile_changed']
    const event = baseEvent('slave.profile_changed', { target: 'template', targetId: 'st-1', sha256: null, actor: 'eren' })
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('profile cleared')
    expect(screen.getByTestId('profile-target').textContent).toBe('its template')
    expect(screen.queryByTestId('profile-sha')).toBeNull()
  })

  it('slave.runtime_roles_changed lists the new set, and says so when it is empty', () => {
    const Card = ACTIVITY_CARDS['slave.runtime_roles_changed']
    const { unmount } = render(<Card event={fixtureFor('slave.runtime_roles_changed')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('runtime roles changed')
    expect(screen.getByTestId('runtime-roles').textContent).toBe('backend, reviewer')
    unmount()

    const parked = baseEvent('slave.runtime_roles_changed', { slaveId: 'ag-1', roles: [], actor: 'eren' })
    render(<Card event={parked} {...CARD_PROPS} />)
    expect(screen.getByTestId('runtime-roles').textContent).toBe('none (cannot be dispatched)')
  })

  // M38 t2: the settings card grew the Supervisor's two fields. A switch reads as on/off rather
  // than as `true`/`false`, and the profile is carried (and shown) as a sha256 prefix -- the
  // payload never holds the persona's text, so the card has none to leak.
  it('workspace.settings_changed says on and off for the supervisor switch', () => {
    const Card = ACTIVITY_CARDS['workspace.settings_changed']
    const event = baseEvent('workspace.settings_changed', { field: 'supervisorEnabled', from: true, to: false })
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('supervisor switched')
    expect(screen.getByTestId('settings-from').textContent).toBe('on')
    expect(screen.getByTestId('settings-to').textContent).toBe('off')
  })

  it('workspace.settings_changed shows a supervisor profile as a short hash, not the whole one', () => {
    const Card = ACTIVITY_CARDS['workspace.settings_changed']
    const sha256 = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    const event = baseEvent('workspace.settings_changed', { field: 'supervisorProfile', from: null, to: sha256 })
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('supervisor profile changed')
    expect(screen.getByTestId('settings-from').textContent).toBe('none')
    expect(screen.getByTestId('settings-to').textContent).toBe('abcdef01\u2026')
    expect(screen.getByTestId('settings-to').textContent).not.toBe(sha256)
  })

  // M38 t5: the five `supervisor.*` cards, replacing Task 1's honest placeholders. Each says what
  // its own payload carries and nothing it does not -- the panel is where a decision's full
  // rationale lives; the timeline's job is to make a decision findable and its shape readable.
  it('supervisor.decided names the situation, its subject, the action and the tier', () => {
    const Card = ACTIVITY_CARDS['supervisor.decided']
    render(<Card event={fixtureFor('supervisor.decided')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('supervisor decided')
    expect(screen.getByTestId('supervisor-situation').textContent).toBe('review_cap_blocked')
    expect(screen.getByTestId('supervisor-subject').textContent).toBe('t1')
    expect(screen.getByTestId('supervisor-action').textContent).toBe('unblock_task')
    expect(screen.getByTestId('supervisor-tier').textContent).toContain('applied')
    expect(screen.getByTestId('supervisor-tier').textContent).toContain('model')
    expect(screen.getByTestId('supervisor-decision').textContent).toBe('sd-01234')
  })

  it('supervisor.proposed names the action and when the proposal expires unanswered', () => {
    const Card = ACTIVITY_CARDS['supervisor.proposed']
    render(<Card event={fixtureFor('supervisor.proposed')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('supervisor proposed')
    expect(screen.getByTestId('supervisor-action').textContent).toBe('set_runtime_roles')
    expect(screen.getByTestId('supervisor-situation').textContent).toBe('no_reviewer')
    // The stamp, not a duration: this card is read weeks later as often as live, and "in 24h"
    // would then be a lie about a proposal that expired long ago.
    expect(screen.getByTestId('supervisor-expires').textContent).toContain('2026-08-23')
  })

  it('supervisor.applied names the action that reached the world', () => {
    const Card = ACTIVITY_CARDS['supervisor.applied']
    render(<Card event={fixtureFor('supervisor.applied')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('supervisor applied')
    expect(screen.getByTestId('supervisor-action').textContent).toBe('unblock_task')
  })

  it('supervisor.resolved says the outcome, and carries a rejection reason when there is one', () => {
    const Card = ACTIVITY_CARDS['supervisor.resolved']
    const { unmount } = render(<Card event={fixtureFor('supervisor.resolved')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('supervisor approved')
    expect(screen.queryByTestId('supervisor-reason')).toBeNull()
    unmount()

    const rejected = baseEvent('supervisor.resolved', {
      decisionId: 'sd-0123456789',
      outcome: 'rejected',
      reason: 'Alex is on the payments rewrite',
    })
    render(<Card event={rejected} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('supervisor rejected')
    expect(screen.getByTestId('supervisor-reason').textContent).toContain('Alex is on the payments rewrite')
  })

  it('supervisor.failed names the action and why the verb refused it', () => {
    const Card = ACTIVITY_CARDS['supervisor.failed']
    render(<Card event={fixtureFor('supervisor.failed')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('supervisor action failed')
    expect(screen.getByTestId('supervisor-action').textContent).toBe('mark_task_failed')
    expect(screen.getByTestId('supervisor-reason').textContent).toBe('task_not_failable')
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

  // M27 §4.1/§4.2 (ruling R16). Two counts on the department delete, one on the slave delete, and
  // `1 run` rather than `1 runs` — the whole point of the counts is that a person reads them.
  it('org.changed appends the cascade counts on a delete (M27)', () => {
    const Card = ACTIVITY_CARDS['org.changed']
    const team = baseEvent('org.changed', { entity: 'team', id: 't-1', field: 'deleted', from: 'Design', to: null, slaves: 2, runs: 3 })
    const { unmount } = render(<Card event={team} {...CARD_PROPS} />)
    expect(screen.getByTestId('org-counts').textContent).toBe(' · 2 slaves, 3 runs')
    unmount()

    const slave = baseEvent('org.changed', { entity: 'slave', id: 'ag-1', field: 'deleted', from: 'Alex', to: null, runs: 1 })
    render(<Card event={slave} {...CARD_PROPS} />)
    expect(screen.getByTestId('org-counts').textContent).toBe(' · 1 run')
  })

  it('org.changed renders no counts for a rename, or for a pre-M27 delete that carries none', () => {
    const Card = ACTIVITY_CARDS['org.changed']
    const { unmount } = render(<Card event={fixtureFor('org.changed')} {...CARD_PROPS} />)
    expect(screen.queryByTestId('org-counts')).toBeNull()
    unmount()

    const old = baseEvent('org.changed', { entity: 'slave', id: 'ag-1', field: 'deleted', from: 'Alex', to: null })
    render(<Card event={old} {...CARD_PROPS} />)
    expect(screen.queryByTestId('org-counts')).toBeNull()
  })

  it('org.changed renders — for a null from (a department created, M25)', () => {
    const Card = ACTIVITY_CARDS['org.changed']
    const event = baseEvent('org.changed', { entity: 'team', id: 't-1', field: 'created', from: null, to: 'Design' })
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('created')
    expect(screen.getByTestId('org-from').textContent).toBe('—')
    expect(screen.getByTestId('org-to').textContent).toBe('Design')
  })

  // M47 final review, Minor 5c: the WRITER stores labels, because this card renders `from -> to`
  // verbatim at a person and the keys are recoverable from the slave row the event names.
  it('org.changed shows a capability change in the words the writer stored, never a key', () => {
    const Card = ACTIVITY_CARDS['org.changed']
    const event = baseEvent('org.changed', {
      entity: 'slave',
      id: 'ag-1',
      field: 'capabilities',
      from: 'Application security',
      to: 'Application security, Code review',
    })
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('org-from').textContent).toBe('Application security')
    expect(screen.getByTestId('org-to').textContent).toBe('Application security, Code review')
    expect(screen.getByTestId('org-to').textContent).not.toContain('security.application')
  })

  it('org.changed shows "moved to department" for a moved slave (M25)', () => {
    const Card = ACTIVITY_CARDS['org.changed']
    const event = baseEvent('org.changed', { entity: 'slave', id: 'ag-1', field: 'team', from: 'Engineering', to: 'QA' })
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

  it('workspace.archived shows the footprint that stays on record', () => {
    const Card = ACTIVITY_CARDS['workspace.archived']
    render(<Card event={fixtureFor('workspace.archived')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('project archived')
    expect(screen.getByTestId('archived-footprint').textContent).toBe(
      '2 departments, 5 slaves, 8 tasks, 22 runs stay on record',
    )
  })

  it('workspace.restored shows the transition label', () => {
    const Card = ACTIVITY_CARDS['workspace.restored']
    render(<Card event={fixtureFor('workspace.restored')} {...CARD_PROPS} />)
    expect(screen.getByTestId('transition-label').textContent).toBe('project restored')
  })

  it('workspace.goal_set shows the goal text', () => {
    const Card = ACTIVITY_CARDS['workspace.goal_set']
    render(<Card event={fixtureFor('workspace.goal_set')} {...CARD_PROPS} />)
    expect(screen.getByTestId('goal-text').textContent).toBe('Ship the checkout flow')
  })

  // M45 erratum E24. `PAYLOAD_BY_TYPE` is NOT changed for this: it holds minimal valid payloads
  // and `request` is optional, so this case builds its own event.
  it('workspace.goal_set shows the words a person requested, when there were any', () => {
    const Card = ACTIVITY_CARDS['workspace.goal_set']
    render(<Card event={baseEvent('workspace.goal_set', { goal: 'Ship it', version: 2, sha256: 'a', request: 'Add Apple Pay' })} {...CARD_PROPS} />)
    expect(screen.getByTestId('goal-set-request').textContent).toContain('Add Apple Pay')
  })

  it('says nothing about a request on a goal version that had none', () => {
    const Card = ACTIVITY_CARDS['workspace.goal_set']
    render(<Card event={baseEvent('workspace.goal_set', { goal: 'Ship it', version: 1, sha256: 'a' })} {...CARD_PROPS} />)
    expect(screen.queryByTestId('goal-set-request')).toBeNull()
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

  it('workspace.company_assigned renders legacy workers missing companySlaveId without duplicate-key warnings', () => {
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

  it('falls back to the bare id for taskTitle, and renders no slave-link at all when slaveName is null', () => {
    const Card = ACTIVITY_CARDS['task.started']
    render(
      <Card
        event={fixtureFor('task.started')}
        workspaceId="w1"
        slaveName={null}
        taskTitle={null}
        userName={null}
        dimmed={false}
      />,
    )
    expect(screen.queryByTestId('slave-link')).toBeNull()
    expect(screen.getByTestId('task-link').textContent).toBe('t1')
  })

  // R5 (spec §8): every old event of a deleted slave now carries `slaveName: null` alongside a
  // still-set `slaveId` (`ExecutionEvent.slaveId` has no FK and keeps its value) -- the card must
  // render no link for a slave that no longer exists, while the rest of the row (its body text,
  // read straight from the payload) renders exactly as it would for a live slave.
  it('renders no slave-link for a deleted slave (slaveId set, slaveName null), and the card still renders', () => {
    const Card = ACTIVITY_CARDS['task.done']
    render(<Card event={fixtureFor('task.done')} workspaceId="w1" slaveName={null} taskTitle="Add the thing" userName={null} dimmed={false} />)
    expect(screen.queryByTestId('slave-link')).toBeNull()
    expect(screen.getByTestId('task-branch').textContent).toBe('feature/add-the-thing')
  })

  it('links to the overview panel and the tasks board with the right ids', () => {
    const Card = ACTIVITY_CARDS['task.started']
    render(<Card event={fixtureFor('task.started')} {...CARD_PROPS} />)
    expect(screen.getByTestId('slave-link').getAttribute('href')).toBe('/w/w1?slave=a1')
    expect(screen.getByTestId('task-link').getAttribute('href')).toBe('/w/w1/tasks?task=t1')
  })
})

/** M40 §6: the three requirement-versioning events, as an operator reads them in the timeline. */
describe('the requirement-versioning cards', () => {
  it('workspace.replan_started names the goal version being re-planned for', () => {
    const Card = ACTIVITY_CARDS['workspace.replan_started']
    render(<Card event={fixtureFor('workspace.replan_started')} {...CARD_PROPS} />)

    expect(screen.getByTestId('transition-label').textContent).toBe('re-planning for goal v2')
  })

  it('workspace.replanned counts what landed and what was only asked for', () => {
    const Card = ACTIVITY_CARDS['workspace.replanned']
    render(<Card event={fixtureFor('workspace.replanned')} {...CARD_PROPS} />)

    expect(screen.getByTestId('transition-label').textContent).toBe('re-planned for goal v2')
    // Additions APPLY, cancellations are PROPOSED (ruling R1) -- the counts are worded so the two
    // are never read as the same thing, and the two ways a cancellation can come to nothing (the
    // status rule dropped it; the proposal itself failed) are named apart.
    expect(screen.getByTestId('replanned-added').textContent).toBe('1 task added')
    expect(screen.getByTestId('replanned-proposed').textContent).toBe('1 cancellation proposed')
    expect(screen.getByTestId('replanned-dropped').textContent).toBe('1 dropped')
    expect(screen.getByTestId('replanned-failed').textContent).toBe('1 failed')
  })

  it('workspace.replanned says so when a re-plan proposed and dropped nothing', () => {
    const Card = ACTIVITY_CARDS['workspace.replanned']
    render(
      <Card
        event={baseEvent('workspace.replanned', { version: 3, runId: 'r1', added: [], proposedCancellations: [], droppedCancellations: [] })}
        {...CARD_PROPS}
      />,
    )

    expect(screen.getByTestId('replanned-added').textContent).toBe('0 tasks added')
    expect(screen.getByTestId('replanned-proposed').textContent).toBe('0 cancellations proposed')
    // A pre-fix-round row carries no `failedProposals` at all: absent is not the same as a count,
    // and the card must not render `NaN` or invent a zero it did not read.
    expect(screen.queryByTestId('replanned-failed')).toBeNull()
    expect(screen.queryByTestId('replanned-dropped')).toBeNull()
  })

  it('task.cancelled gives the reason and the goal version the task was derived from', () => {
    const Card = ACTIVITY_CARDS['task.cancelled']
    render(<Card event={fixtureFor('task.cancelled')} {...CARD_PROPS} />)

    expect(screen.getByTestId('transition-label').textContent).toBe('cancelled')
    expect(screen.getByTestId('task-cancelled-reason').textContent).toBe('the re-plan for goal v2 no longer needs it')
    expect(screen.getByTestId('task-cancelled-goal-version').textContent).toBe('goal v1')
  })

  it('task.cancelled says "unstamped" for a hand-made task, which no goal version produced', () => {
    const Card = ACTIVITY_CARDS['task.cancelled']
    render(<Card event={baseEvent('task.cancelled', { reason: 'an operator changed their mind', goalVersion: null })} {...CARD_PROPS} />)

    expect(screen.getByTestId('task-cancelled-goal-version').textContent).toBe('unstamped')
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
      actor: 'slave',
      slaveId: 'a1',
      taskId: null,
      runId: 'r1',
      userId: null,
      payload: {},
      summary: 'Write a.txt',
    },
    workspaceId: 'w1',
    slaveName: 'Alex',
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
