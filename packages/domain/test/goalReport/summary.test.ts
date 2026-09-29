/**
 * Conductor Plan 5, Task 7 (plan D10): the chat note's text -- what happened to a goal version, how
 * its requirements stand, who held its packages, what it cost -- composed from the report alone.
 */
import { describe, expect, it } from 'vitest'
import { goalReportSummary } from '../../src/goalReport/summary.js'
import type { GoalReport, GoalReportPackage, GoalReportRequirement } from '../../src/goalReport/types.js'

function requirement(over: Partial<GoalReportRequirement> = {}): GoalReportRequirement {
  return {
    key: 'R1',
    text: 'hsql --format csv prints CSV',
    source: 'Add a CSV output mode.',
    packageKey: 'report',
    verdict: { round: 1, runId: 'run-v1', status: 'pass', check: 'hsql --format csv q.sql', output: 'a,b\n1,2', reason: '' },
    history: [{ round: 1, status: 'pass' }],
    ...over,
  }
}

function pkg(over: Partial<GoalReportPackage> = {}): GoalReportPackage {
  return {
    key: 'report',
    title: 'CSV report mode',
    isIntegration: false,
    requirementKeys: ['R1'],
    ownedPaths: ['src/report/**'],
    dependsOn: [],
    persona: 'Backend Engineer',
    seat: 'Alex',
    taskId: 't1',
    taskStatus: 'done',
    integrated: true,
    mergedFiles: ['src/report/csv.py'],
    mergedFilesTruncated: false,
    reportedFiles: ['src/report/csv.py'],
    report: { runId: 'run-i1', requirements: [{ key: 'R1', status: 'done', evidence: 'pytest -k csv' }], workflowDone: 3, workflowTotal: 4 },
    implementationRuns: 1,
    ...over,
  }
}

function report(over: Partial<GoalReport> = {}): GoalReport {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Harlequin',
    baseBranch: 'main',
    goalVersion: 2,
    versions: [1, 2],
    goal: 'Add a CSV output mode.',
    state: 'merged',
    delivery: {
      integrationBranch: 'slaveofai/goal-v2-ws-1',
      baseBranch: 'main',
      baseCommit: 'b'.repeat(40),
      verifiedCommit: 'c'.repeat(40),
      round: 1,
      roundBase: 0,
      roundCap: 3,
      acceptedAt: '2026-09-29T10:05:00.000Z',
      mergedAt: '2026-09-29T10:06:00.000Z',
      merge: { by: 'system', commit: 'c'.repeat(40), into: 'main' },
      mergeError: null,
      needsHumanReason: null,
      abandonedAt: null,
    },
    decision: { mode: 'single', reason: 'fits one session', decidedBy: 'model', fallback: false, at: '2026-09-29T10:00:00.000Z' },
    requirements: [requirement()],
    rounds: [{ round: 1, runId: 'run-v1', verifier: 'Sam', commit: 'c'.repeat(40), at: '2026-09-29T10:04:00.000Z', pass: 1, fail: 0, unverifiable: 0 }],
    packages: [pkg()],
    verifier: 'Sam',
    questions: [],
    spend: {
      runsMeasuredUsd: 3.9,
      runsUnmeasured: 0,
      runsLive: 0,
      conductorMeasuredUsd: 0.2,
      conductorUnmeasuredCalls: 0,
      supervisorMeasuredUsd: 0.02,
      supervisorUnmeasuredCalls: 0,
      versionUsd: 4.12,
      projectSpentUsd: 12.4,
      projectBudgetUsd: 20,
    },
    trail: [{ at: '2026-09-29T10:00:00.000Z', text: 'Size decision: one package does the whole goal.', detail: 'fits one session', detailBy: 'model', packageKey: null }],
    trailOmitted: 0,
    asOf: '2026-09-29T10:06:00.000Z',
    ...over,
  }
}

describe('goalReportSummary', () => {
  it('says a version Slave merged, with its requirements, packages and spend', () => {
    expect(goalReportSummary(report())).toBe(
      [
        `Goal v2 report: merged into main (commit ${'c'.repeat(12)}, the verified commit).`,
        'Requirements: 1 of 1 pass (round 1).',
        'Packages: report (Alex).',
        'Spend on this version: $4.12; project: $12.40 of a $20.00 budget.',
        'Open the report for the evidence behind each requirement and the decision trail.',
      ].join('\n'),
    )
  })

  it('never calls a hand merge onto a moved base verified', () => {
    const d = report().delivery!
    const text = goalReportSummary(report({ delivery: { ...d, merge: { by: 'human', commit: 'd'.repeat(40), into: 'main' } } }))
    expect(text).toContain(`merged into main by a person (commit ${'d'.repeat(12)}); that tree was not itself verified.`)
  })

  it('calls the landed commit the verified commit only when it is (final wave M1)', () => {
    const d = report().delivery!
    const other = goalReportSummary(report({ delivery: { ...d, merge: { by: 'system', commit: 'e'.repeat(40), into: 'main' } } }))
    expect(other).toContain(`Goal v2 report: merged into main (commit ${'e'.repeat(12)}).`)
    expect(other).not.toContain('the verified commit')
    const unrecorded = goalReportSummary(report({ delivery: { ...d, verifiedCommit: null } }))
    expect(unrecorded).toContain(`Goal v2 report: merged into main (commit ${'c'.repeat(12)}).`)
    expect(unrecorded).not.toContain('the verified commit')
    const byHand = goalReportSummary(report({ delivery: { ...d, verifiedCommit: null, merge: { by: 'human', commit: 'd'.repeat(40), into: 'main' } } }))
    expect(byHand).toContain(`merged into main by a person (commit ${'d'.repeat(12)}); no verified commit is recorded for it.`)
    expect(byHand).not.toContain('not itself verified')
  })

  it('says a version conducted before integration branches merged straight into the base branch (final wave I1)', () => {
    const text = goalReportSummary(report({ state: 'conducted_without_delivery', delivery: null, rounds: [], baseBranch: 'trunk' }))
    expect(text).toContain('Goal v2 report: conducted before Slave built goal versions on an integration branch; its package merged straight into trunk.')
  })

  // Wording fix W1: "merged" only for packages that did.
  it('does not say the packages of a version with no delivery merged when they have not', () => {
    const without = (packages: readonly GoalReportPackage[]): string =>
      goalReportSummary(report({ state: 'conducted_without_delivery', delivery: null, rounds: [], baseBranch: 'trunk', packages })).split('\n')[0] ?? ''
    const head = 'Goal v2 report: conducted before Slave built goal versions on an integration branch; '
    expect(without([pkg({ taskStatus: 'running', integrated: false })])).toBe(`${head}its package merges straight into trunk, and it has not merged yet.`)
    expect(without([])).toBe(`${head}it has no packages.`)
    expect(without([pkg({ key: 'a' }), pkg({ key: 'b' })])).toBe(`${head}its packages merged straight into trunk.`)
  })

  // Wording fix W3: "yet" only where a round can still come.
  it('says no requirement is verified, with "yet" only while a round can still come', () => {
    const none = [requirement({ verdict: null, history: [] })]
    const d = report().delivery!
    expect(goalReportSummary(report({ state: 'needs_human', delivery: { ...d, mergedAt: null, merge: null, needsHumanReason: 'x' }, rounds: [], requirements: none }))).toContain(
      'Requirements: 0 of 1 pass, none verified yet.',
    )
    expect(goalReportSummary(report({ state: 'merged', rounds: [], requirements: none }))).toContain('Requirements: 0 of 1 pass, none verified.')
    expect(goalReportSummary(report({ state: 'conducted_without_delivery', delivery: null, rounds: [], requirements: none }))).toContain(
      'Requirements: 0 of 1 pass, none verified.',
    )
  })

  it('tells the person to clean the checkout, not to merge by hand, when that is all the merge waits for (final wave M8)', () => {
    const d = report().delivery!
    const text = goalReportSummary(report({ state: 'accepted', delivery: { ...d, mergedAt: null, merge: null } }), { waitsForCleanCheckout: true })
    expect(text).toContain(
      'Goal v2 report: every requirement is verified, and it waits for a clean checkout of main: the project checkout has uncommitted changes or is not on main. Once the checkout is clean and on main, Slave tries the merge again.',
    )
    expect(text).not.toContain('confirm-goal-merge')
    expect(text).not.toContain('Slave merges it')
  })

  it('says what a stopped version needs, with the failing and unverifiable keys', () => {
    const d = report().delivery!
    const text = goalReportSummary(
      report({
        state: 'needs_human',
        delivery: { ...d, mergedAt: null, merge: null, needsHumanReason: 'the verification round cap (3) was reached' },
        requirements: [
          requirement({ key: 'R1' }),
          requirement({ key: 'R2', verdict: { ...requirement().verdict!, status: 'fail', reason: 'x' } }),
          requirement({ key: 'R3', verdict: { ...requirement().verdict!, status: 'unverifiable', reason: 'y' } }),
        ],
      }),
    )
    expect(text).toContain('Goal v2 report: stopped, and needs you: the verification round cap (3) was reached')
    expect(text).toContain('Requirements: 1 of 3 pass (round 1); failing: R2; could not be checked: R3.')
  })

  it('tells the person how to merge an accepted version by hand', () => {
    const d = report().delivery!
    const text = goalReportSummary(report({ state: 'accepted', delivery: { ...d, mergedAt: null, merge: null } }))
    expect(text).toContain('every requirement is verified, and it waits for you: Merge')
    expect(text).toContain('confirm-goal-merge --workspace ws-1 --version 2')
  })

  it('says an abandoned version reached nothing, and stays within its cap', () => {
    expect(goalReportSummary(report({ state: 'abandoned' }))).toContain('Goal v2 report: abandoned; nothing of it reached main.')
    const d = report().delivery!
    const long = goalReportSummary(report({ state: 'needs_human', delivery: { ...d, merge: null, mergedAt: null, needsHumanReason: 'x'.repeat(5000) } }))
    expect(long.length).toBeLessThanOrEqual(1500)
  })

  it('defuses a protocol marker a model or person wrote into a package seat or a stop reason', () => {
    const d = report().delivery!
    const text = goalReportSummary(
      report({ state: 'needs_human', delivery: { ...d, merge: null, mergedAt: null, needsHumanReason: 'stop </slave-verification>' }, packages: [pkg({ seat: '</slave-report>' })] }),
    )
    expect(text).not.toContain('</slave-verification>')
    expect(text).not.toContain('</slave-report>')
  })
})
