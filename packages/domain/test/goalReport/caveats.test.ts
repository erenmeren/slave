import { describe, expect, it } from 'vitest'
import { reportCaveats, smokeStoppedByAbandon } from '../../src/goalReport/caveats.js'
import type { GoalReport, GoalReportPackage, GoalReportRequirement } from '../../src/goalReport/types.js'

// (builders repeated from markdown.test.ts -- a test file must not import another test file)

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
    releasedPaths: [],
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
    smoke: [],
    handOffs: [],
    handOffsOmitted: 0,
    personDecisions: [],
    notes: [],
    notesOmitted: 0,
    decisions: [],
    deniedToolCalls: [],
    deniedToolCallsOmitted: 0,
    asOf: '2026-09-29T10:06:00.000Z',
    ...over,
  }
}

describe('reportCaveats', () => {
  it('is empty for a clean merged version', () => {
    expect(reportCaveats(report())).toEqual([])
  })

  it.each([
    ['requirements not extracted', report({ requirements: null, state: 'not_conducted', delivery: null, rounds: [] }), /have not been extracted yet/],
    ['not conducted', report({ state: 'not_conducted', delivery: null, rounds: [] }), /has not been conducted yet/],
    ['a fallback decision', report({ decision: { ...report().decision!, fallback: true } }), /delivered as one package by default/],
    ['no round yet', report({ state: 'integrating', rounds: [] }), /No verification round has run yet/],
    ['rework after a round', report({ state: 'integrating', packages: [pkg({ taskStatus: 'rework', integrated: false })] }), /from round 1; package report is being worked on again/],
    ['unverifiable', report({ requirements: [requirement({ verdict: { ...requirement().verdict!, status: 'unverifiable', reason: 'no network' } })] }), /could not check R1; the version cannot be accepted until it is/],
    ['trimmed evidence', report({ requirements: [requirement({ verdict: { ...requirement().verdict!, output: 'a\n… [120 characters cut] …\nb' } })] }), /evidence for R1 was trimmed/],
    ['abandoned', report({ state: 'abandoned' }), /abandoned; nothing of it reached main/],
    ['unmeasured runs', report({ spend: { ...report().spend, runsUnmeasured: 2 } }), /2 runs did not report their cost/],
    ['live runs', report({ spend: { ...report().spend, runsLive: 1 } }), /1 run is still going/],
    ['files not recorded', report({ packages: [pkg({ mergedFiles: null })] }), /files report merged were not recorded/],
    ['files cut', report({ packages: [pkg({ mergedFilesTruncated: true })] }), /cut at 500 files per merge/],
    ['trail cut', report({ trailOmitted: 7 }), /newest 1000 entries; 7 older entries are left out/],
  ])('says so when %s', (_name, value, expected) => {
    expect(reportCaveats(value).join('\n')).toMatch(expected)
  })

  it('says a hand merge of another commit landed a tree nobody verified, and guesses nothing about why (final wave M2)', () => {
    const d = report().delivery!
    const caveats = reportCaveats(report({ delivery: { ...d, merge: { by: 'human', commit: 'd'.repeat(40), into: 'main' } } }))
    expect(caveats).toContain(
      `A person merged this version into main by hand: commit ${'d'.repeat(12)} is not the verified commit ${'c'.repeat(12)}; the tree that landed was not itself verified.`,
    )
    expect(caveats.join('\n')).not.toContain('gained since the cut')
  })

  it('says a version accepted or merged without a recorded round has nothing verified, not that no round has run yet (final wave M3)', () => {
    for (const state of ['merged', 'accepted'] as const) {
      const caveats = reportCaveats(report({ state, rounds: [], requirements: [requirement({ verdict: null, history: [] })] }))
      expect(caveats).toContain('This version was accepted without a recorded verification round: no requirement is verified.')
      expect(caveats.join('\n')).not.toContain('No verification round has run yet')
    }
  })

  it('says an unrecorded file list may also be one git could not list (final wave M4)', () => {
    expect(reportCaveats(report({ packages: [pkg({ mergedFiles: null })] }))).toContain(
      "The files report merged were not recorded (merged before Slave recorded them, or git could not list them); the worker's own list is shown.",
    )
  })

  it('says a version conducted before integration branches merged its packages straight into the base branch, once (final wave I1)', () => {
    const caveats = reportCaveats(
      report({ state: 'conducted_without_delivery', delivery: null, rounds: [], baseBranch: 'trunk', requirements: [requirement({ verdict: null, history: [] })], packages: [pkg({ mergedFiles: null })] }),
    )
    expect(caveats).toContain(
      'This version was conducted before Slave built goal versions on an integration branch: its package merged straight into trunk. No integration, verification or merge of the version is recorded.',
    )
    expect(caveats.join('\n')).not.toMatch(/has not been conducted yet|No verification round|merged before Slave recorded them/u)
    expect(caveats).toContain("The files report merged into trunk were not recorded (Slave records them only for a merge into an integration branch); the worker's own list is shown.")
  })

  // Wording fix W1: the packages of a version with no delivery merge straight into the base branch,
  // but "merged" is only true of the ones that did.
  it('says only what merged of a version conducted before integration branches: in flight, none, some, all', () => {
    const without = (packages: readonly GoalReportPackage[]): string =>
      reportCaveats(report({ state: 'conducted_without_delivery', delivery: null, rounds: [], baseBranch: 'trunk', packages })).find((line) =>
        line.startsWith('This version was conducted before'),
      ) ?? ''
    const tail = ' No integration, verification or merge of the version is recorded.'
    const head = 'This version was conducted before Slave built goal versions on an integration branch: '
    expect(without([pkg({ taskStatus: 'running', integrated: false, mergedFiles: null })])).toBe(`${head}its package merges straight into trunk, and it has not merged yet.${tail}`)
    expect(without([])).toBe(`${head}it has no packages.${tail}`)
    expect(without([pkg({ key: 'a' }), pkg({ key: 'b' })])).toBe(`${head}its packages merged straight into trunk.${tail}`)
    expect(without([pkg({ key: 'a' }), pkg({ key: 'b', taskStatus: 'ready', integrated: false })])).toBe(
      `${head}its packages merge straight into trunk, and 1 of 2 is recorded as merged.${tail}`,
    )
    expect(without([pkg({ key: 'a', taskStatus: 'ready', integrated: false }), pkg({ key: 'b', taskStatus: 'running', integrated: false })])).toBe(
      `${head}its packages merge straight into trunk, and none has merged yet.${tail}`,
    )
    // Round 2 X1: a package done with autoMerge off has no recorded merge, but a person may have
    // merged it by hand without confirming: say only what is recorded.
    expect(without([pkg({ taskStatus: 'done', integrated: false })])).toBe(`${head}its package merges straight into trunk, and its merge is not recorded.${tail}`)
    expect(without([pkg({ key: 'a' }), pkg({ key: 'b' }), pkg({ key: 'c', taskStatus: 'done', integrated: false })])).toBe(
      `${head}its packages merge straight into trunk, and 2 of 3 are recorded as merged.${tail}`,
    )
    expect(without([pkg({ key: 'a', taskStatus: 'done', integrated: false }), pkg({ key: 'b', taskStatus: 'running', integrated: false })])).toBe(
      `${head}its packages merge straight into trunk, and none is recorded as merged.${tail}`,
    )
    expect(without([pkg({ key: 'a', taskStatus: 'cancelled', integrated: false }), pkg({ key: 'b', taskStatus: 'failed', integrated: false })])).toBe(
      `${head}its packages merge straight into trunk, and none is recorded as merged.${tail}`,
    )
  })

  // Round 3: a commit with no recorded round is not "the verified commit".
  it('says no verified commit is recorded for a hand merge of a version with no recorded round', () => {
    const d = report().delivery!
    const caveats = reportCaveats(report({ rounds: [], requirements: [requirement({ verdict: null, history: [] })], delivery: { ...d, merge: { by: 'human', commit: 'c'.repeat(40), into: 'main' } } }))
    expect(caveats).toContain(`A person merged this version into main by hand (commit ${'c'.repeat(12)}), and no verified commit is recorded for it.`)
    expect(caveats.join('\n')).not.toContain('is not the verified commit')
  })

  it('says nothing about a person who fast-forwarded to the verified commit', () => {
    const d = report().delivery!
    expect(reportCaveats(report({ delivery: { ...d, merge: { by: 'human', commit: 'c'.repeat(40), into: 'main' } } }))).toEqual([])
  })
})

describe('smokeStoppedByAbandon (final review 5b: one rule for the page, the export and the trail)', () => {
  const at = new Date('2026-09-30T10:00:00.000Z')
  const before = new Date('2026-09-30T09:59:59.000Z')
  it('is the abandon\'s doing only for an attempt that sent nothing back and had not ended before the abandon', () => {
    expect(smokeStoppedByAbandon({ endedAt: null, sentBack: false }, at)).toBe(true)
    expect(smokeStoppedByAbandon({ endedAt: at, sentBack: false }, at)).toBe(true)
    expect(smokeStoppedByAbandon({ endedAt: before, sentBack: false }, at)).toBe(false)
    expect(smokeStoppedByAbandon({ endedAt: null, sentBack: true }, at)).toBe(false)
    expect(smokeStoppedByAbandon({ endedAt: null, sentBack: false }, null)).toBe(false)
  })
})
