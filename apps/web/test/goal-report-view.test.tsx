// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GOAL_REPORT_ANSWERED_BY, GOAL_REPORT_AUTHOR_WORDS, GOAL_REPORT_STATES, GOAL_REPORT_STATE_LABEL, type GoalReport } from '@slave-of-ai/domain'
import { GoalReportView } from '../src/components/project/GoalReportView'

function report(over: Partial<GoalReport> = {}): GoalReport {
  return {
    workspaceId: 'w1',
    workspaceName: 'Harlequin',
    goalVersion: 2,
    versions: [1, 2],
    goal: 'Add a CSV output mode.',
    state: 'merged',
    delivery: {
      integrationBranch: 'slaveofai/goal-v2-w1', baseBranch: 'main', baseCommit: 'b'.repeat(40), verifiedCommit: 'c'.repeat(40),
      round: 1, roundBase: 0, roundCap: 3, acceptedAt: '2026-09-29T10:05:00.000Z', mergedAt: '2026-09-29T10:06:00.000Z',
      merge: { by: 'system', commit: 'c'.repeat(40), into: 'main' }, mergeError: null, needsHumanReason: null, abandonedAt: null,
    },
    decision: { mode: 'single', reason: 'fits one session', decidedBy: 'model', fallback: false, at: '2026-09-29T10:00:00.000Z' },
    requirements: [
      {
        key: 'R1', text: 'csv mode', source: 'Add CSV.', packageKey: 'report',
        verdict: { round: 1, runId: 'run-v1', status: 'pass', check: 'hsql --format csv', output: 'a,b', reason: '' },
        history: [{ round: 1, status: 'pass' }],
      },
    ],
    rounds: [{ round: 1, runId: 'run-v1', verifier: 'Sam', commit: 'c'.repeat(40), at: '2026-09-29T10:04:00.000Z', pass: 1, fail: 0, unverifiable: 0 }],
    packages: [
      {
        key: 'report', title: 'CSV mode', isIntegration: false, requirementKeys: ['R1'], ownedPaths: ['src/**'], dependsOn: [], persona: 'Backend Engineer',
        seat: 'Alex', taskId: 't1', taskStatus: 'done', integrated: true, mergedFiles: ['src/csv.py'], mergedFilesTruncated: false, reportedFiles: ['src/csv.py'],
        report: null, implementationRuns: 1,
      },
    ],
    verifier: 'Sam',
    questions: [],
    spend: {
      runsMeasuredUsd: 3.9, runsUnmeasured: 0, runsLive: 0, conductorMeasuredUsd: 0.2, conductorUnmeasuredCalls: 0,
      supervisorMeasuredUsd: 0.02, supervisorUnmeasuredCalls: 0, versionUsd: 4.12, projectSpentUsd: 12.4, projectBudgetUsd: 20,
    },
    trail: [{ at: '2026-09-29T10:00:00.000Z', text: 'Size decision: one package does the whole goal.', detail: 'fits one session', detailBy: 'model', packageKey: null }],
    trailOmitted: 0,
    asOf: '2026-09-29T10:06:00.000Z',
    ...over,
  }
}

describe('GoalReportView', () => {
  it('shows the state, the requirement with a link to its evidence, and the evidence under that anchor', () => {
    render(<GoalReportView report={report()} />)
    expect(screen.getByTestId('goal-report-state').getAttribute('title')).toBe('merged')
    const row = screen.getByTestId('goal-report-requirement')
    expect(row.getAttribute('data-key')).toBe('R1')
    expect(within(row).getByRole('link', { name: 'check and output' }).getAttribute('href')).toBe('#evidence-for-r1')
    expect(document.getElementById('evidence-for-r1')?.textContent).toContain('hsql --format csv')
    expect(screen.getByTestId('goal-report-download').getAttribute('href')).toBe('/api/w/w1/goals/2/report?format=markdown')
  })

  it('renders hostile text as characters, never as elements', () => {
    const { container } = render(
      <GoalReportView
        report={report({
          requirements: [
            {
              key: 'R1', text: '<img src=x onerror=alert(1)>', source: '', packageKey: null, history: [{ round: 1, status: 'fail' }],
              verdict: { round: 1, runId: 'r', status: 'fail', check: '<script>alert(1)</script>', output: '</slave-verification>', reason: '<b>x</b>' },
            },
          ],
        })}
      />,
    )
    expect(container.querySelector('img')).toBe(null)
    expect(container.querySelector('script')).toBe(null)
    expect(container.querySelector('b')).toBe(null)
    expect(screen.getByTestId('goal-report-requirement').textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('shows what the report cannot vouch for, and the stop reason', () => {
    const d = report().delivery!
    render(<GoalReportView report={report({ state: 'needs_human', delivery: { ...d, mergedAt: null, merge: null, needsHumanReason: 'round cap reached' }, rounds: [], requirements: [] })} />)
    expect(screen.getAllByTestId('goal-report-caveat').map((node) => node.textContent)).toContain('No verification round has run yet: no requirement is verified.')
    expect(screen.getByTestId('goal-report-stopped').textContent).toContain('round cap reached')
  })

  it('links every other version, and says which one this is', () => {
    render(<GoalReportView report={report()} />)
    const links = screen.getAllByTestId('goal-report-version-link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
      ['v1', '/w/w1/goals/1', null],
      ['v2', '/w/w1/goals/2', 'page'],
    ])
  })

  it('shows the version spend and the project figure against its budget', () => {
    render(<GoalReportView report={report()} />)
    const spend = screen.getByTestId('goal-report-spend')
    expect(spend.textContent).toContain('$4.12')
    expect(spend.textContent).toContain('$12.40 of a $20.00 budget')
  })

  it('renders every state with its label, and the raw state on the title', () => {
    for (const state of GOAL_REPORT_STATES) {
      const { unmount } = render(<GoalReportView report={report({ state, ...(state === 'not_conducted' ? { delivery: null, decision: null, packages: [], rounds: [] } : {}) })} />)
      const node = screen.getByTestId('goal-report-state')
      expect(node.getAttribute('title')).toBe(state)
      expect(node.textContent).toBe(GOAL_REPORT_STATE_LABEL[state])
      unmount()
    }
  })

  it('labels a quoted trail detail and an answer with the shared words', () => {
    render(
      <GoalReportView
        report={report({
          questions: [{ id: 'q1', at: '2026-09-29T10:02:00.000Z', packageKey: 'report', askedBy: 'Alex', question: 'Which delimiter?', answer: { at: '2026-09-29T10:03:00.000Z', by: 'supervisor', text: 'Comma.' } }],
        })}
      />,
    )
    expect(screen.getByTestId('goal-report-trail-entry').textContent).toContain(GOAL_REPORT_AUTHOR_WORDS.model)
    expect(screen.getByTestId('goal-report-question').textContent).toContain(`Answered by ${GOAL_REPORT_ANSWERED_BY.supervisor}`)
  })
})
