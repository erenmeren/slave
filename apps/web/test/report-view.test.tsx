// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import type { GoalReport } from '@slave-of-ai/domain'
import { ReportView } from '../src/components/report/ReportView'
import { stubBrowser } from './fixtures/dom'

beforeAll(() => stubBrowser())

function report(over: Partial<GoalReport> = {}): GoalReport {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Todo app',
    baseBranch: 'main',
    goalVersion: 2,
    versions: [1, 2],
    goal: 'Build a todo app.',
    state: 'merged',
    delivery: {
      integrationBranch: 'slaveofai/goal-v2',
      baseBranch: 'main',
      baseCommit: 'b'.repeat(40),
      verifiedCommit: 'c'.repeat(40),
      round: 1,
      roundBase: 0,
      roundCap: 3,
      acceptedAt: '2026-10-05T10:00:00.000Z',
      mergedAt: '2026-10-05T10:05:00.000Z',
      merge: { by: 'system', commit: 'd'.repeat(40), into: 'main' },
      mergeError: null,
      needsHumanReason: null,
      abandonedAt: null,
    },
    decision: null,
    requirements: [{ key: 'R1', text: 'Add a todo', source: 'x', packageKey: 'main', verdict: { round: 1, runId: 'r', status: 'pass', check: 'curl /todos', output: '201', reason: 'It was added.' }, history: [{ round: 1, status: 'pass' }] }],
    rounds: [{ round: 1, runId: 'r', verifier: 'Verifier x', commit: 'c'.repeat(40), at: '2026-10-05T10:00:00.000Z', pass: 1, fail: 0, unverifiable: 0 }],
    packages: [],
    verifier: 'Verifier x',
    questions: [],
    personDecisions: [],
    notes: [],
    notesOmitted: 0,
    smoke: [],
    handOffs: [],
    handOffsOmitted: 0,
    decisions: [{ title: 'Store todos in SQLite', decision: 'One file is enough.', source: 'lead', at: '2026-10-05T09:00:00.000Z' }],
    deniedToolCalls: [],
    deniedToolCallsOmitted: 0,
    spend: { runsMeasuredUsd: 8, runsUnmeasured: 0, runsLive: 0, conductorMeasuredUsd: 0.3, conductorUnmeasuredCalls: 0, supervisorMeasuredUsd: 0, supervisorUnmeasuredCalls: 0, versionUsd: 8.3, projectSpentUsd: 12, projectBudgetUsd: 20 },
    trail: [],
    trailOmitted: 0,
    asOf: '2026-10-05T10:05:00.000Z',
    ...over,
  } as GoalReport
}

describe('the Report (lead UX design section 6.4)', () => {
  it('says the outcome first, in words, with the download and the other builds', () => {
    render(<ReportView report={report()} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Build 2 of Todo app')
    expect(screen.getByTestId('report-state').textContent).toBe('Merged')
    expect(screen.getByTestId('report-download').getAttribute('href')).toBe('/api/w/ws-1/goals/2/report?format=markdown')
    expect(screen.getByRole('navigation', { name: 'Other builds' }).textContent).toContain('Build 1')
  })

  it('lists the requirements with how each was checked, the decisions by who made them, and the spend', () => {
    render(<ReportView report={report()} />)
    expect(screen.getByTestId('report-requirement').textContent).toContain('curl /todos')
    expect(document.body.textContent).toContain('Store todos in SQLite · The lead')
    expect(document.body.textContent).toContain('This build: $8.30')
    expect(document.body.textContent).toContain('The whole project: $12 of $20')
  })

  it('says a build with no requirements has no report yet', () => {
    render(<ReportView report={report({ requirements: null, state: 'integrating' })} />)
    expect(screen.getByTestId('report-requirements').textContent).toContain('its requirements have not been read')
  })
})
