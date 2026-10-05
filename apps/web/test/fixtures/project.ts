import type { BuildView, ProjectListItem, ProjectView } from '@slave-of-ai/control'

/** A lead-flow build as `projectView` reads it, building, with two requirements checked once. */
export function buildFixture(over: Partial<BuildView> = {}): BuildView {
  return {
    version: 2,
    leadState: 'building',
    status: 'integrating',
    stopReason: null,
    branch: 'slaveofai/goal-v2',
    mergeError: null,
    mergedAt: null,
    mergeCommit: null,
    rounds: 1,
    proof: [
      { key: 'R1', text: 'A person can add a todo', result: 'pass', reason: 'It was added.', check: 'curl -X POST /todos', output: '201', checks: 1 },
      { key: 'R2', text: 'A person can delete a todo', result: 'fail', reason: 'Deleting answered 500.', check: 'curl -X DELETE /todos/1', output: '500', checks: 1 },
    ],
    failing: ['R2'],
    disputed: [],
    unverifiable: [],
    faces: [
      { id: 'run-1', kind: 'lead', name: 'Lead', working: true, doing: 'Running npm test' },
      { id: 'call-1', kind: 'helper', name: 'Bea', working: true, doing: 'Editing src/app.ts' },
    ],
    commits: [{ sha: 'abcdef1234567', subject: 'Add the todo routes' }],
    notes: [{ at: '2026-10-05T10:00:00.000Z', kind: 'limit_wait', detail: 'waiting for the reset' }],
    spentUsd: 4.2,
    spendUnmeasured: false,
    workedMs: 38 * 60_000,
    people: [
      { id: 'lead', kind: 'lead', name: 'Lead', personId: null, state: 'working', doing: 'Running npm test', sessions: 2, running: 1, toolCalls: 40, failedCalls: 1, costUsd: 3.9, lastAt: '2026-10-05T10:01:00.000Z' },
      { id: 'helper:bea', kind: 'helper', name: 'Bea', personId: 'person-bea', state: 'working', doing: 'Editing src/app.ts', sessions: 1, running: 1, toolCalls: 12, failedCalls: 0, costUsd: null, lastAt: '2026-10-05T10:02:00.000Z' },
      { id: 'checker', kind: 'checker', name: 'Checker', personId: null, state: 'done', doing: null, sessions: 1, running: 0, toolCalls: 9, failedCalls: 0, costUsd: 0.25, lastAt: '2026-10-05T09:40:00.000Z' },
    ],
    turns: [
      { runId: 'run-0', turn: 'build', status: 'succeeded', resumed: false, costUsd: 3.9, toolCalls: 31, tokensIn: 1200, tokensOut: 9000, workedMs: 30 * 60_000, startedAt: '2026-10-05T09:00:00.000Z', endedAt: '2026-10-05T09:30:00.000Z' },
      { runId: 'run-1', turn: 'rework', status: 'working', resumed: true, costUsd: null, toolCalls: 9, tokensIn: null, tokensOut: null, workedMs: 8 * 60_000, startedAt: '2026-10-05T09:54:00.000Z', endedAt: null },
    ],
    activity: [
      { id: 'ev-3', at: '2026-10-05T10:02:00.000Z', who: 'Bea', kind: 'helper', text: 'Editing src/app.ts', outcome: null },
      { id: 'ev-2', at: '2026-10-05T10:01:00.000Z', who: 'Lead', kind: 'lead', text: 'Running npm test', outcome: 'error' },
      { id: 'ev-1', at: '2026-10-05T10:00:00.000Z', who: 'Lead', kind: 'lead', text: 'Reading package.json', outcome: 'ok' },
    ],
    workingNow: 2,
    toolCalls: 61,
    spend: { leadUsd: 3.9, proofUsd: 0.25, conductorUsd: 0.05, totalUsd: 4.2, unmeasuredRuns: 0 },
    ...over,
  }
}

/** A lead-flow project as `projectView` reads it. */
export function projectFixture(over: Partial<ProjectView> = {}): ProjectView {
  return {
    id: 'ws-1',
    name: 'Todo app',
    repoPath: '/home/x/todo',
    baseBranch: 'main',
    flow: 'lead',
    archived: false,
    haltedReason: null,
    phase: 'building',
    autoMerge: true,
    budgetUsd: 20,
    timeLimitMs: 90 * 60_000,
    leadModel: null,
    roster: [],
    goal: 'Build a todo app.',
    goalVersion: 2,
    build: buildFixture(),
    builds: [
      { version: 2, leadState: 'building', stopReason: null, at: '2026-10-05T09:00:00.000Z' },
      { version: 1, leadState: 'stopped', stopReason: 'left', at: '2026-10-04T09:00:00.000Z' },
    ],
    projectSpentUsd: 4.2,
    older: null,
    ...over,
  }
}

/** One row of `listProjects`. */
export function listItemFixture(over: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id: 'ws-1',
    name: 'Todo app',
    flow: 'lead',
    phase: 'building',
    archived: false,
    repoPath: '/home/x/todo',
    baseBranch: 'main',
    haltedReason: null,
    goalVersion: 1,
    waiting: 0,
    stopReason: null,
    waitingSince: null,
    spentUsd: 4.2,
    spendUnmeasured: false,
    budgetUsd: 20,
    updatedAt: '2026-10-05T10:00:00.000Z',
    workingNow: 2,
    doing: 'Running npm test',
    totalSpentUsd: 6.2,
    ...over,
  }
}
