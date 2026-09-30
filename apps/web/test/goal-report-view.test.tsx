// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GOAL_REPORT_ANSWERED_BY, GOAL_REPORT_AUTHOR_WORDS, GOAL_REPORT_STATES, GOAL_REPORT_STATE_LABEL, type GoalReport, type GoalReportSmoke } from '@slave-of-ai/domain'
import { GoalReportView } from '../src/components/project/GoalReportView'

function report(over: Partial<GoalReport> = {}): GoalReport {
  return {
    workspaceId: 'w1',
    workspaceName: 'Harlequin',
    baseBranch: 'main',
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
    smoke: [],
    deniedToolCalls: [],
    deniedToolCallsOmitted: 0,
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
      const { unmount } = render(
        <GoalReportView
          report={report({
            state,
            ...(state === 'not_conducted' ? { delivery: null, decision: null, packages: [], rounds: [] } : {}),
            ...(state === 'conducted_without_delivery' ? { delivery: null, rounds: [] } : {}),
          })}
        />,
      )
      const node = screen.getByTestId('goal-report-state')
      expect(node.getAttribute('title')).toBe(state)
      expect(node.textContent).toBe(GOAL_REPORT_STATE_LABEL[state])
      unmount()
    }
  })

  it('says who merged only for a merged version, as the Markdown does (final wave M6)', () => {
    const d = report().delivery!
    render(<GoalReportView report={report({ state: 'needs_human', delivery: { ...d, mergedAt: null, needsHumanReason: 'stopped' } })} />)
    expect(screen.getByTestId('goal-report-facts').textContent).not.toContain('merged into')
  })

  it('says the packages of a version conducted before integration branches merged into the base branch (final wave I1)', () => {
    render(<GoalReportView report={report({ state: 'conducted_without_delivery', delivery: null, rounds: [], baseBranch: 'trunk' })} />)
    const pkg = screen.getByTestId('goal-report-package')
    expect(pkg.textContent).toContain('Task: done, merged into trunk')
    expect(pkg.textContent).not.toContain('integration branch')
    expect(screen.getAllByTestId('goal-report-caveat').map((node) => node.textContent)).toContain(
      'This version was conducted before Slave built goal versions on an integration branch: its package merged straight into trunk. No integration, verification or merge of the version is recorded.',
    )
  })

  // Wording fix W3: the same phrase as the Markdown, "yet" only where a round can still come.
  it('says "not verified", without "yet", where no round will come, and "not verified yet" where one can', () => {
    const none = [{ ...report().requirements![0]!, verdict: null, history: [] }]
    const d = report().delivery!
    const cell = (over: Partial<GoalReport>): string => {
      const { unmount } = render(<GoalReportView report={report({ rounds: [], requirements: none, ...over })} />)
      const text = within(screen.getByTestId('goal-report-requirement')).getAllByRole('cell')[2]?.textContent ?? ''
      unmount()
      return text
    }
    expect(cell({ state: 'merged' })).toBe('not verified')
    expect(cell({ state: 'abandoned', delivery: { ...d, mergedAt: null, merge: null } })).toBe('not verified')
    expect(cell({ state: 'conducted_without_delivery', delivery: null })).toBe('not verified')
    expect(cell({ state: 'verifying', delivery: { ...d, mergedAt: null, merge: null } })).toBe('not verified yet')
    expect(cell({ state: 'needs_human', delivery: { ...d, mergedAt: null, merge: null, needsHumanReason: 'x' } })).toBe('not verified yet')
  })

  it('says "No packages yet." only for a version not conducted yet, as the Markdown does', () => {
    const { unmount } = render(<GoalReportView report={report({ state: 'conducted_without_delivery', delivery: null, rounds: [], packages: [] })} />)
    expect(screen.getByText('No packages.')).toBeTruthy()
    unmount()
    render(<GoalReportView report={report({ state: 'not_conducted', delivery: null, rounds: [], packages: [] })} />)
    expect(screen.getByText('No packages yet.')).toBeTruthy()
  })

  // Round 3: the same phrase as the Markdown -- "verified commit" only with a recorded round.
  it('calls the commit of an accepted version verified only when a round is recorded', () => {
    const d = { ...report().delivery!, mergedAt: null, merge: null }
    const { unmount } = render(<GoalReportView report={report({ state: 'accepted', delivery: d })} />)
    expect(screen.getByTestId('goal-report-facts').textContent).toContain(`· verified commit ${'c'.repeat(12)} on slaveofai/goal-v2-w1`)
    unmount()
    render(<GoalReportView report={report({ state: 'accepted', delivery: d, rounds: [] })} />)
    const facts = screen.getByTestId('goal-report-facts').textContent ?? ''
    expect(facts).toContain(`· commit ${'c'.repeat(12)} on slaveofai/goal-v2-w1; no verification round is recorded`)
    expect(facts).not.toContain('verified commit')
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

  describe('smoke checks and denied tool calls (skeleton spec S7/S9, plan B Task 7)', () => {
    const failed: GoalReportSmoke = {
      attemptId: 'a1', round: 1, outcome: 'failed', exitCode: 1, durationMs: 61_000, tip: 'd'.repeat(40), output: 'npm error Missing script: "start"',
      at: '2026-09-30T10:00:00.000Z', reworkedPackage: 'integration', handOff: { toPackage: 'skeleton', path: 'backend/package.json', change: 'add a "start" script' },
      stoppedByAbandon: false,
    }
    const passed: GoalReportSmoke = { ...failed, attemptId: 'a2', round: 2, outcome: 'passed', exitCode: 0, durationMs: 4_000, output: 'flow ok', at: '2026-09-30T11:00:00.000Z', reworkedPackage: null, handOff: null }

    it('lists every attempt with its hand-off and the latest output, and every denial', () => {
      render(
        <GoalReportView
          report={report({
            smoke: [failed, passed],
            deniedToolCalls: [{ at: '2026-09-30T09:50:00.000Z', runId: 'r9', packageKey: 'integration', kind: 'permission_mode', detail: 'Bash was denied by the permission mode (tu_1)' }],
            deniedToolCallsOmitted: 2,
          })}
        />,
      )
      const rows = screen.getAllByTestId('goal-report-smoke')
      expect(rows).toHaveLength(2)
      expect(rows[0]?.textContent).toContain(`Round 1: failed, exit 1, took 61 s, on commit ${'d'.repeat(12)}, integration sent back, finished 2026-09-30T10:00:00.000Z`)
      expect(rows[1]?.textContent).toContain('Round 2: passed, exit 0, took 4 s')
      const handOffs = screen.getAllByTestId('goal-report-smoke-handoff')
      expect(handOffs).toHaveLength(1)
      expect(handOffs[0]?.textContent).toBe('integration handed the fix to skeleton (backend/package.json): add a "start" script')
      expect(screen.getByTestId('goal-report-smoke-output').textContent).toBe('flow ok')
      const denial = screen.getByTestId('goal-report-denial')
      expect(denial.textContent).toContain('Bash was denied by the permission mode (tu_1)')
      expect(denial.textContent).toContain('integration')
      expect(denial.textContent).toContain('r9')
      expect(screen.getByTestId('goal-report-denials-omitted').textContent).toBe('… and 2 more, not listed.')
    })

    it('says so when no smoke check has run and no denied tool call is recorded', () => {
      render(<GoalReportView report={report()} />)
      expect(screen.getByText('No smoke check has run.')).toBeTruthy()
      expect(screen.getByText('No denied tool call is recorded.')).toBeTruthy()
    })

    it('renders a hostile hand-off change and output as characters, never as elements', () => {
      const change = '<img src=x onerror=alert(1)>\n# Heading <script>alert(1)</script>'
      const { container } = render(
        <GoalReportView report={report({ smoke: [{ ...failed, output: '<b>bold</b>', handOff: { toPackage: 'skeleton', path: 'backend/package.json', change } }] })} />,
      )
      expect(container.querySelector('img')).toBe(null)
      expect(container.querySelector('script')).toBe(null)
      expect(container.querySelector('b')).toBe(null)
      expect(screen.getByTestId('goal-report-smoke-handoff').textContent).toContain('<img src=x onerror=alert(1)>')
      expect(screen.getByTestId('goal-report-smoke-output').textContent).toBe('<b>bold</b>')
    })

    it('never calls an attempt the abandon stopped a smoke failure (Task 4 carry)', () => {
      const d = report().delivery!
      render(
        <GoalReportView
          report={report({
            state: 'abandoned',
            delivery: { ...d, mergedAt: null, merge: null },
            smoke: [{ ...failed, exitCode: 143, reworkedPackage: null, handOff: null, stoppedByAbandon: true }],
          })}
        />,
      )
      const row = screen.getByTestId('goal-report-smoke').textContent ?? ''
      expect(row).toContain('Round 1: stopped when the version was abandoned, exit 143')
      expect(row).not.toContain('failed')
    })

    it('says what an attempt the abandon stopped recorded when that was not a failure, as the trail does (final review 5a)', () => {
      const d = report().delivery!
      render(
        <GoalReportView
          report={report({
            state: 'abandoned',
            delivery: { ...d, mergedAt: null, merge: null },
            smoke: [{ ...passed, round: 1, reworkedPackage: null, handOff: null, stoppedByAbandon: true }],
          })}
        />,
      )
      const row = screen.getByTestId('goal-report-smoke').textContent ?? ''
      expect(row).toContain('Round 1: stopped when the version was abandoned (recorded as passed, exit 0), took 4 s')
    })

    it('names the verifier for a verification run\'s denial', () => {
      render(<GoalReportView report={report({ deniedToolCalls: [{ at: '2026-09-30T09:51:00.000Z', runId: 'rv', packageKey: null, kind: 'permission_matrix', detail: 'Edit (write_repo) was refused by the permission matrix' }] })} />)
      expect(screen.getByTestId('goal-report-denial').textContent).toContain('the verifier')
    })
  })
})
