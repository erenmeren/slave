import type { AnalyticsView, HappeningLine } from '@slave-of-ai/control'

/** Analytics with nothing in it: no project, no day, no figure. */
export function emptyAnalytics(over: Partial<AnalyticsView> = {}): AnalyticsView {
  return {
    days: 30,
    since: '2026-09-06T00:00:00.000Z',
    projectId: null,
    projects: [],
    money: { buildingUsd: 0, checkingUsd: 0, steeringUsd: 0, totalUsd: 0, unmeasuredSessions: 0, liveSessions: 0, byDay: [], byProject: [], byBuild: [] },
    work: { steps: 0, byDay: [], leadTurns: 0, helperSessions: 0, checks: 0, verdicts: { works: 0, fails: 0, unverifiable: 0 }, builds: { delivered: 0, stopped: 0, waiting: 0, running: 0 }, averageDeliveredWorkedMs: null },
    helpers: [],
    evidence: { profiles: [], models: [], records: 0, leadFlowRecords: 0 },
    truncated: false,
    ...over,
  }
}

/** A week of two projects: one delivered a build, the other is building with a turn still open. */
export function analyticsFixture(over: Partial<AnalyticsView> = {}): AnalyticsView {
  const days = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']
  return emptyAnalytics({
    days: 7,
    since: '2026-09-29T00:00:00.000Z',
    projects: [{ id: 'a', name: 'Invoice service', archived: false }, { id: 'b', name: 'Todo app', archived: false }, { id: 'c', name: 'Old bot', archived: true }],
    money: {
      buildingUsd: 12,
      checkingUsd: 2.5,
      steeringUsd: 0.25,
      totalUsd: 14.75,
      unmeasuredSessions: 1,
      liveSessions: 1,
      byDay: days.map((day, index) => (index === 5 ? { day, totalUsd: 10.25, byProject: [{ projectId: 'a', usd: 8 }, { projectId: 'b', usd: 2.25 }] } : index === 6 ? { day, totalUsd: 4.5, byProject: [{ projectId: 'a', usd: 4.5 }] } : { day, totalUsd: 0, byProject: [] })),
      byProject: [
        { projectId: 'a', name: 'Invoice service', archived: false, flow: 'lead', builds: 1, buildingUsd: 10, checkingUsd: 2.5, steeringUsd: 0, totalUsd: 12.5, budgetUsd: 50, budgetSpentUsd: 12.5, unmeasuredSessions: 0, liveSessions: 0 },
        { projectId: 'b', name: 'Todo app', archived: false, flow: 'lead', builds: 1, buildingUsd: 2, checkingUsd: 0, steeringUsd: 0.25, totalUsd: 2.25, budgetUsd: null, budgetSpentUsd: 0, unmeasuredSessions: 1, liveSessions: 1 },
      ],
      byBuild: [
        { projectId: 'b', projectName: 'Todo app', version: 2, state: 'Building', group: 'running', turns: 2, helperSessions: 3, steps: 120, workedMs: 20 * 60_000, spentUsd: 2.25, unmeasuredSessions: 1, liveSessions: 1, startedAt: '2026-10-04T09:00:00.000Z' },
        { projectId: 'a', projectName: 'Invoice service', version: 1, state: 'Delivered', group: 'delivered', turns: 3, helperSessions: 8, steps: 500, workedMs: 75 * 60_000, spentUsd: 12.5, unmeasuredSessions: 0, liveSessions: 0, startedAt: '2026-10-03T09:00:00.000Z' },
      ],
    },
    work: {
      steps: 620,
      byDay: days.map((day, index) => ({ day, steps: index === 5 ? 400 : index === 6 ? 220 : 0 })),
      leadTurns: 5,
      helperSessions: 11,
      checks: 2,
      verdicts: { works: 9, fails: 2, unverifiable: 1 },
      builds: { delivered: 1, stopped: 0, waiting: 0, running: 1 },
      averageDeliveredWorkedMs: 75 * 60_000,
    },
    helpers: [
      { key: 'person-bea', name: 'Bea Backend', personId: 'person-bea', sessions: 8, steps: 300, failedSteps: 4, projects: 2, lastAt: '2026-10-05T10:00:00.000Z' },
      { key: 'definition:general-purpose', name: 'General helper', personId: null, sessions: 3, steps: 40, failedSteps: 0, projects: 1, lastAt: '2026-10-04T10:00:00.000Z' },
    ],
    evidence: {
      records: 9,
      leadFlowRecords: 2,
      profiles: [
        { key: 'template:backend:/repo/a', name: 'Backend developer', repository: '/repo/a', attempted: 7, firstPass: { pct: 80, judged: 5 }, reviewRejected: { pct: null, judged: 2 }, integrated: { pct: null, judged: 0 }, medianDurationMs: 12 * 60_000, reportedUsd: 6.5, estimatedUsd: 1.25, unmeasuredRuns: 1, thin: false },
        { key: 'bespoke:lead:/repo/b', name: 'Lead of Todo', repository: '/repo/b', attempted: 2, firstPass: { pct: null, judged: 0 }, reviewRejected: { pct: null, judged: 0 }, integrated: { pct: null, judged: 0 }, medianDurationMs: null, reportedUsd: null, estimatedUsd: null, unmeasuredRuns: 0, thin: true },
      ],
      models: [{ key: 'opus', name: 'claude-opus-5', repository: null, attempted: 9, firstPass: { pct: 80, judged: 5 }, reviewRejected: { pct: null, judged: 2 }, integrated: { pct: null, judged: 0 }, medianDurationMs: 12 * 60_000, reportedUsd: 6.5, estimatedUsd: null, unmeasuredRuns: 1, thin: false }],
    },
    ...over,
  })
}

/** One line of Home's feed: a step of the lead that worked. */
export function happeningFixture(over: Partial<HappeningLine> = {}): HappeningLine {
  return { id: '100', at: new Date().toISOString(), projectId: 'a', projectName: 'Invoice service', kind: 'lead', who: 'Lead', text: 'Running npm test', step: true, outcome: 'ok', ...over }
}
