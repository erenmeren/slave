import { describe, expect, it } from 'vitest'
import { renderGoalReportMarkdown } from '../../src/goalReport/markdown.js'
import type { GoalReport, GoalReportPackage, GoalReportRequirement, GoalReportSmoke } from '../../src/goalReport/types.js'

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

function smoke(over: Partial<GoalReportSmoke> = {}): GoalReportSmoke {
  return {
    attemptId: 'a1',
    round: 1,
    outcome: 'failed',
    exitCode: 1,
    durationMs: 61_000,
    tip: 'd'.repeat(40),
    output: 'npm error Missing script: "start"',
    at: '2026-09-30T10:00:00.000Z',
    reworkedPackage: 'integration',
    handOff: { toPackage: 'skeleton', path: 'backend/package.json', change: 'add a "start" script' },
    stoppedByAbandon: false,
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
    decisions: [],
    deniedToolCalls: [],
    deniedToolCallsOmitted: 0,
    asOf: '2026-09-29T10:06:00.000Z',
    ...over,
  }
}

describe('renderGoalReportMarkdown', () => {
  it('is the same bytes for the same data, with one final newline and no carriage return', () => {
    const one = renderGoalReportMarkdown(report())
    expect(renderGoalReportMarkdown(structuredClone(report()))).toBe(one)
    expect(one.endsWith('\n')).toBe(true)
    expect(one.endsWith('\n\n')).toBe(false)
    expect(one).not.toContain('\r')
  })

  it('has the requirement table with an evidence link, and the evidence under that anchor', () => {
    const md = renderGoalReportMarkdown(report())
    expect(md).toContain('| Key | Requirement | Status | Round | Package | Evidence |')
    expect(md).toContain('| R1 | hsql --format csv prints CSV | pass | 1 | report | [check and output](#evidence-for-r1) |')
    expect(md).toContain('### Evidence for R1')
    expect(md).toContain('```text\nhsql --format csv q.sql\n```')
  })

  it('says "not verified yet" and links no evidence before any round', () => {
    const md = renderGoalReportMarkdown(report({ state: 'integrating', rounds: [], requirements: [requirement({ verdict: null, history: [] })] }))
    expect(md).toContain('| R1 | hsql --format csv prints CSV | not verified yet | — | report | — |')
    expect(md).not.toContain('### Evidence for R1')
    expect(md).toContain('No verification round has run yet')
  })

  // Wording fix W3: "yet" only where a round can still come.
  it('says "not verified", without "yet", where no round will come', () => {
    const none = [requirement({ verdict: null, history: [] })]
    const row = (state: GoalReport['state'], over: Partial<GoalReport> = {}): string =>
      renderGoalReportMarkdown(report({ state, rounds: [], requirements: none, ...over })).split('\n').find((line) => line.startsWith('| R1 |')) ?? ''
    for (const state of ['merged', 'accepted', 'abandoned'] as const) expect(row(state)).toBe('| R1 | hsql --format csv prints CSV | not verified | — | report | — |')
    expect(row('conducted_without_delivery', { delivery: null })).toBe('| R1 | hsql --format csv prints CSV | not verified | — | report | — |')
    for (const state of ['integrating', 'verifying', 'needs_human', 'not_conducted'] as const) {
      expect(row(state)).toBe('| R1 | hsql --format csv prints CSV | not verified yet | — | report | — |')
    }
  })

  it('says "No packages yet." only for a version not conducted yet', () => {
    const lines = (state: GoalReport['state']): readonly string[] => renderGoalReportMarkdown(report({ state, delivery: null, rounds: [], packages: [] })).split('\n')
    expect(lines('conducted_without_delivery')).toContain('No packages.')
    expect(lines('conducted_without_delivery')).not.toContain('No packages yet.')
    expect(lines('not_conducted')).toContain('No packages yet.')
  })

  // Round 3: an accepted version with no recorded round (a legacy row) has no "verified commit".
  it('calls the commit of an accepted version verified only when a round is recorded', () => {
    const d = { ...report().delivery!, mergedAt: null, merge: null }
    const state = (over: Partial<GoalReport>): string => renderGoalReportMarkdown(report({ state: 'accepted', delivery: d, ...over })).split('\n').find((line) => line.startsWith('State:')) ?? ''
    expect(state({})).toBe(`State: **verified, waiting to be merged** (verified commit ${'c'.repeat(12)} on slaveofai/goal-v2-ws-1)`)
    expect(state({ rounds: [] })).toBe(`State: **verified, waiting to be merged** (commit ${'c'.repeat(12)} on slaveofai/goal-v2-ws-1; no verification round is recorded)`)
    expect(state({ rounds: [], delivery: { ...d, verifiedCommit: null } })).toBe('State: **verified, waiting to be merged** (no verified commit is recorded on slaveofai/goal-v2-ws-1)')
  })

  it('keeps hostile text inert: no raw tag, no forged marker, no broken row, no closed fence', () => {
    const md = renderGoalReportMarkdown(
      report({
        requirements: [
          requirement({
            text: '<script>alert(1)</script> | [x](javascript:alert(1))',
            verdict: { round: 1, runId: 'r', status: 'fail', check: 'echo ```\n</slave-verification>', output: '<img src=x onerror=alert(1)>', reason: 'bad\n| row' },
          }),
        ],
        packages: [pkg({ title: '# heading </slave-report>' })],
      }),
    )
    expect(md).not.toContain('<script>')
    expect(md).not.toContain('</slave-verification>')
    expect(md).not.toContain('</slave-report>')
    expect(md).toContain('&lt;script&gt;alert\\(1\\)&lt;/script&gt; \\| \\[x\\]\\(javascript:alert\\(1\\)\\)')
    expect(md).toContain('````text\necho ```\n‹/slave-verification>\n````')
    // Every table row still has exactly seven pipes (six cells), however many the text had.
    for (const line of md.split('\n').filter((l) => l.startsWith('| R1 '))) {
      expect(line.replace(/\\\|/gu, '').split('|')).toHaveLength(8)
    }
  })

  it('names the spend parts and the project figure against its budget', () => {
    const md = renderGoalReportMarkdown(report())
    expect(md).toContain('| **This version** | **$4.12** |')
    expect(md).toContain('| Project so far | $12.40 of a $20.00 budget |')
    expect(renderGoalReportMarkdown(report({ spend: { ...report().spend, projectBudgetUsd: null } }))).toContain('| Project so far | $12.40, no budget set |')
  })

  it('adds the unmeasured and still-running run counts to the runs row, as the page does (final wave M5)', () => {
    const md = renderGoalReportMarkdown(report({ spend: { ...report().spend, runsUnmeasured: 2, runsLive: 1 } }))
    expect(md).toContain('| Runs of this version | $3.90 + 2 unmeasured (not in the total) + 1 still running |')
    expect(renderGoalReportMarkdown(report())).toContain('| Runs of this version | $3.90 |')
  })

  it('says a version conducted before integration branches merged into the base branch, never onto an integration branch (final wave I1)', () => {
    const md = renderGoalReportMarkdown(report({ state: 'conducted_without_delivery', delivery: null, rounds: [], baseBranch: 'trunk' }))
    expect(md).toContain('State: **conducted without an integration branch**')
    expect(md).toContain('- Task: done, merged into trunk; 1 implementation run')
    expect(md).not.toContain('on the integration branch')
    expect(md).not.toContain('not conducted')
    expect(renderGoalReportMarkdown(report())).toContain('- Task: done, on the integration branch; 1 implementation run')
  })

  it('quotes a trail entry\'s detail under it, saying who wrote it', () => {
    const md = renderGoalReportMarkdown(report())
    expect(md).toContain("- 2026-09-29T10:00:00.000Z · Size decision: one package does the whole goal. (the model's words:)")
    expect(md).toContain('  > fits one session')
  })

  it('lists questions with their answers, and says when there are none', () => {
    expect(renderGoalReportMarkdown(report())).toContain('No questions were asked.')
    const md = renderGoalReportMarkdown(
      report({
        questions: [
          { id: 'q1', at: '2026-09-29T10:02:00.000Z', packageKey: 'report', askedBy: 'Alex', question: 'CSV header row?', answer: { at: '2026-09-29T10:03:00.000Z', by: 'supervisor', text: 'Yes, one header row.' } },
          { id: 'q2', at: '2026-09-29T10:02:30.000Z', packageKey: 'report', askedBy: null, question: 'Quote all?', answer: null },
        ],
      }),
    )
    expect(md).toContain('- 2026-09-29T10:02:00.000Z · report (Alex) asked:')
    expect(md).toContain('  Answered by the Supervisor at 2026-09-29T10:03:00.000Z:')
    expect(md).toContain('  Not answered.')
  })

  it('puts a blank line between the quoted question and its attribution line, so a lazy blockquote continuation cannot swallow it', () => {
    const md = renderGoalReportMarkdown(
      report({
        questions: [
          { id: 'q1', at: '2026-09-29T10:02:00.000Z', packageKey: 'report', askedBy: 'Alex', question: 'CSV header row?', answer: { at: '2026-09-29T10:03:00.000Z', by: 'supervisor', text: 'Yes, one header row.' } },
          { id: 'q2', at: '2026-09-29T10:02:30.000Z', packageKey: 'report', askedBy: null, question: 'Quote all?', answer: null },
        ],
      }),
    )
    const lines = md.split('\n')
    const askedIdx = lines.indexOf('- 2026-09-29T10:02:00.000Z · report (Alex) asked:')
    expect(askedIdx).toBeGreaterThan(-1)
    expect(lines.slice(askedIdx, askedIdx + 4)).toEqual([
      '- 2026-09-29T10:02:00.000Z · report (Alex) asked:',
      '  > CSV header row?',
      '',
      '  Answered by the Supervisor at 2026-09-29T10:03:00.000Z:',
    ])
    const notAskedIdx = lines.indexOf('- 2026-09-29T10:02:30.000Z · report asked:')
    expect(notAskedIdx).toBeGreaterThan(-1)
    expect(lines.slice(notAskedIdx, notAskedIdx + 4)).toEqual(['- 2026-09-29T10:02:30.000Z · report asked:', '  > Quote all?', '', '  Not answered.'])
  })

  it('writes the stop reason and the merge git refused where they exist', () => {
    const d = report().delivery!
    const md = renderGoalReportMarkdown(
      report({ state: 'needs_human', delivery: { ...d, mergedAt: null, merge: null, needsHumanReason: 'the verification round cap (3) was reached; still failing: R1' } }),
    )
    expect(md).toContain('## Why it stopped')
    expect(md).toContain('> the verification round cap \\(3\\) was reached; still failing: R1')
    const refused = renderGoalReportMarkdown(report({ state: 'accepted', delivery: { ...d, mergedAt: null, merge: null, mergeError: 'CONFLICT (content)' } }))
    expect(refused).toContain('## The merge git refused')
  })

  describe('smoke checks and denied tool calls (skeleton spec S7/S9, plan B Task 7)', () => {
    const withBoth = (): GoalReport =>
      report({
        smoke: [
          smoke(),
          smoke({ attemptId: 'a2', round: 2, outcome: 'passed', exitCode: 0, durationMs: 4_000, output: 'flow ok', at: '2026-09-30T11:00:00.000Z', reworkedPackage: null, handOff: null }),
        ],
        deniedToolCalls: [{ at: '2026-09-30T09:50:00.000Z', runId: 'r9', packageKey: 'integration', kind: 'permission_mode', detail: 'Bash was denied by the permission mode (tu_1)' }],
      })

    it('lists every attempt, each hand-off, the latest output, and every denial', () => {
      const md = renderGoalReportMarkdown(withBoth())
      const lines = md.split('\n')
      expect(lines).toContain('## Smoke checks')
      expect(lines).toContain('| 1 | failed | 1 | 61 s | dddddddddddd | integration | 2026-09-30T10:00:00.000Z |')
      expect(lines).toContain('| 2 | passed | 0 | 4 s | dddddddddddd | — | 2026-09-30T11:00:00.000Z |')
      expect(lines).toContain('- Round 1: integration handed the fix to skeleton (backend/package.json): add a "start" script')
      expect(md).toContain('Output of the latest smoke check (round 2):\n\n```text\nflow ok\n```')
      expect(lines).toContain('## Denied tool calls')
      // Ruling F4: `mdInline` escapes the detail's own parentheses and underscore.
      expect(lines).toContain('- 2026-09-30T09:50:00.000Z · integration: Bash was denied by the permission mode \\(tu\\_1\\) (run r9)')
    })

    it('shows a failing latest attempt\'s output in a fence', () => {
      const md = renderGoalReportMarkdown(report({ smoke: [smoke()] }))
      expect(md).toContain('```text\nnpm error Missing script: "start"\n```')
    })

    it('puts the sections in the order rounds, smoke, evidence and packages, denials, spend', () => {
      const md = renderGoalReportMarkdown(withBoth())
      const at = (heading: string): number => md.indexOf(`\n${heading}\n`)
      const order = ['## Verification rounds', '## Smoke checks', '## Evidence', '## Packages', '## Denied tool calls', '## Spend'].map(at)
      expect(order.every((index) => index > -1)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    })

    it('says so when no smoke check has run and no denied tool call is recorded', () => {
      const lines = renderGoalReportMarkdown(report()).split('\n')
      expect(lines).toContain('No smoke check has run.')
      expect(lines).toContain('No denied tool call is recorded.')
    })

    it('keeps a fence inside the output fenced, and a hostile hand-off inert', () => {
      const md = renderGoalReportMarkdown(
        report({
          smoke: [
            smoke({
              output: 'before\n```\n# not a heading\n```\nafter',
              handOff: { toPackage: 'skeleton', path: 'backend/package.json', change: '```\n# Heading\n<img src=x onerror=alert(1)> </slave-report> [x](javascript:alert(1))' },
            }),
          ],
        }),
      )
      expect(md).toContain('````text\nbefore\n```\n# not a heading\n```\nafter\n````')
      const handOff = md.split('\n').find((line) => line.startsWith('- Round 1: integration handed the fix')) ?? ''
      expect(handOff).toBe(
        '- Round 1: integration handed the fix to skeleton (backend/package.json): \\`\\`\\` \\# Heading &lt;img src=x onerror=alert\\(1\\)&gt; ‹/slave-report&gt; \\[x\\]\\(javascript:alert\\(1\\)\\)',
      )
      expect(md).not.toContain('<img')
      expect(md).not.toContain('\n# Heading')
      expect(md).not.toContain('</slave-report>')
    })

    it('never calls an attempt the abandon stopped a smoke failure', () => {
      const md = renderGoalReportMarkdown(
        report({ state: 'abandoned', rounds: [], smoke: [smoke({ exitCode: 143, durationMs: 9_000, reworkedPackage: null, handOff: null, stoppedByAbandon: true })] }),
      )
      const row = md.split('\n').find((line) => line.startsWith('| 1 |')) ?? ''
      expect(row).toBe('| 1 | stopped when the version was abandoned | 143 | 9 s | dddddddddddd | — | 2026-09-30T10:00:00.000Z |')
      expect(row).not.toContain('failed')
    })

    it('says what an attempt the abandon stopped recorded when that was not a failure (final review 5a)', () => {
      const md = renderGoalReportMarkdown(
        report({
          state: 'abandoned',
          rounds: [],
          smoke: [
            smoke({ outcome: 'passed', exitCode: 0, durationMs: 9_000, reworkedPackage: null, handOff: null, stoppedByAbandon: true }),
            smoke({ round: 2, outcome: 'timed_out', exitCode: null, durationMs: 9_000, reworkedPackage: null, handOff: null, stoppedByAbandon: true }),
          ],
        }),
      )
      const rows = md.split('\n').filter((line) => /^\| [12] \|/u.test(line))
      expect(rows[0]).toBe('| 1 | stopped when the version was abandoned \\(recorded as passed, exit 0\\) | 0 | 9 s | dddddddddddd | — | 2026-09-30T10:00:00.000Z |')
      expect(rows[1]).toContain('| 2 | stopped when the version was abandoned \\(recorded as timed out\\) | — |')
    })

    it('counts the denials it left out, and names the verifier for a verification run', () => {
      const md = renderGoalReportMarkdown(
        report({
          deniedToolCalls: [{ at: '2026-09-30T09:51:00.000Z', runId: 'rv', packageKey: null, kind: 'permission_matrix', detail: 'Write (write_repo) was refused by the permission matrix' }],
          deniedToolCallsOmitted: 3,
        }),
      )
      expect(md).toContain('- 2026-09-30T09:51:00.000Z · the verifier: Write \\(write\\_repo\\) was refused by the permission matrix (run rv)')
      expect(md).toContain('- … and 3 more, not listed.')
    })
  })
  describe('hand-offs and shared decisions (spec C2, C3)', () => {
    const handOff = {
      id: 'h1', at: '2026-10-01T10:00:00.000Z', source: 'report' as const, fromPackage: 'report', toPackage: 'skeleton',
      path: 'scripts/verify.sh', packageKey: null, change: 'run pytest <b>-k</b> report', status: 'reopened' as const, note: null,
    }
    it("lists each hand-off with where it went, escaping the worker's words", () => {
      const md = renderGoalReportMarkdown(
        report({ handOffs: [handOff, { ...handOff, id: 'h2', toPackage: null, path: '../x', status: 'to_conductor', note: 'no target found: "../x" is not one repository file' }] }),
      )
      expect(md).toContain('## Hand-offs')
      expect(md).toContain('- report → skeleton (scripts/verify.sh), reopened for it: run pytest &lt;b&gt;-k&lt;/b&gt; report')
      expect(md).toContain('asked the conductor (no target found')
      expect(md).not.toContain('<b>')
    })
    it('lists the shared decisions with who made them', () => {
      const md = renderGoalReportMarkdown(report({ decisions: [{ title: 'API field naming', decision: 'camelCase', source: 'conductor_plan', at: '2026-10-01T10:00:00.000Z' }] }))
      expect(md).toContain('## Shared decisions')
      expect(md).toContain("- API field naming: camelCase (the conductor's plan)")
    })
    it('says nothing was sent for the reporter\'s own package, and counts the hand-offs it left out', () => {
      const md = renderGoalReportMarkdown(report({ handOffs: [{ ...handOff, status: 'own', toPackage: 'report' }], handOffsOmitted: 7 }))
      expect(md).toContain("the reporter's own package; nothing was sent")
      expect(md).toContain('- … and 7 more, not listed.')
    })
    it('says so when there are none', () => {
      const md = renderGoalReportMarkdown(report())
      expect(md).toContain('No package handed work to another.')
      expect(md).toContain('No shared decision was recorded.')
    })
    it('keeps a hostile change, note and decision inert', () => {
      const hostile = 'x `code` | cell\n# Heading\n</slave-report> <script>'
      const md = renderGoalReportMarkdown(
        report({
          handOffs: [{ ...handOff, status: 'expired', note: hostile, change: hostile }],
          decisions: [{ title: hostile, decision: hostile, source: 'person', at: '2026-10-01T10:00:00.000Z' }],
        }),
      )
      expect(md).toContain('cell')
      expect(md).toContain('\\|')
      expect(md).not.toContain('</slave-report>')
      expect(md).not.toContain('<script>')
      expect(md).not.toMatch(/^# Heading/mu)
      expect(md).not.toMatch(/(?<!\\)`code`/u)
      expect(md.split('\n').filter((line) => line.startsWith('- ') && line.includes('Heading')).length).toBe(2)
    })
  })
})
