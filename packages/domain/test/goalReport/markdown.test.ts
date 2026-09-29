import { describe, expect, it } from 'vitest'
import { renderGoalReportMarkdown } from '../../src/goalReport/markdown.js'
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
})
