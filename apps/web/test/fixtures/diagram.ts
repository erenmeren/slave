import type { BuildDiagram, DiagramCall, DiagramNode, DiagramSession, ProjectDiagram } from '@slave-of-ai/control'

const T0 = Date.parse('2026-10-05T09:00:00.000Z')
/** A moment of the fixture build, `seconds` after its start. */
export const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()

const node = (over: Partial<DiagramNode> & Pick<DiagramNode, 'id' | 'kind' | 'name'>): DiagramNode => ({ personId: null, state: 'done', doing: null, sessions: 0, running: 0, toolCalls: 0, failedCalls: 0, costUsd: null, lastAt: null, ...over })
const session = (over: Partial<DiagramSession> & Pick<DiagramSession, 'id' | 'nodeId' | 'label' | 'startedAt'>): DiagramSession => ({ state: 'done', doing: null, endedAt: null, toolCalls: 0, failedCalls: 0, costUsd: null, ...over })
export const call = (id: string, nodeId: string, sessionId: string, from: number, to: number | null, text: string, outcome: DiagramCall['outcome'] = to === null ? null : 'ok'): DiagramCall => ({ id, nodeId, sessionId, at: at(from), endedAt: to === null ? null : at(to), text, outcome })

/**
 * A build as `buildDiagram` reads it, twenty minutes in: a first turn that ended, a check, and a
 * live second turn in which the lead called Bea (a roster person) twice at once.
 */
export function diagramFixture(over: Partial<BuildDiagram> = {}): BuildDiagram {
  return {
    version: 2,
    goal: 'Build a todo app.',
    result: 'not_yet',
    at: at(1200),
    from: at(0),
    to: null,
    nodes: [
      node({ id: 'request', kind: 'request', name: 'You' }),
      node({ id: 'lead', kind: 'lead', name: 'Lead', state: 'working', doing: 'Running npm test', sessions: 2, running: 1, toolCalls: 4, failedCalls: 1, costUsd: 3.9, lastAt: at(1190) }),
      node({ id: 'helper:bea', kind: 'helper', name: 'Bea', personId: 'person-bea', state: 'working', doing: 'Editing src/app.ts', sessions: 2, running: 1, toolCalls: 3, lastAt: at(1195) }),
      node({ id: 'checker', kind: 'checker', name: 'Checker', sessions: 1, toolCalls: 1, costUsd: 0.25, lastAt: at(700) }),
      node({ id: 'result', kind: 'result', name: 'Result', state: 'working' }),
    ],
    edges: [
      { id: 'request->lead', source: 'request', target: 'lead', kind: 'request', label: 'build 2', state: 'working' },
      { id: 'lead->helper:bea', source: 'lead', target: 'helper:bea', kind: 'helper', label: 'called 2 times', state: 'working' },
      { id: 'lead->checker', source: 'lead', target: 'checker', kind: 'check', label: 'check 1', state: 'done' },
      { id: 'checker->result', source: 'checker', target: 'result', kind: 'result', label: null, state: 'done' },
    ],
    sessions: [
      session({ id: 'run-0', nodeId: 'lead', label: 'build', startedAt: at(0), endedAt: at(600), toolCalls: 2, costUsd: 3.9 }),
      session({ id: 'run-check', nodeId: 'checker', label: 'check', startedAt: at(620), endedAt: at(720), toolCalls: 1, costUsd: 0.25 }),
      session({ id: 'run-1', nodeId: 'lead', label: 'rework', state: 'working', doing: 'Running npm test', startedAt: at(740), toolCalls: 2, failedCalls: 1 }),
      session({ id: 'call-a', nodeId: 'helper:bea', label: 'fix the delete route', startedAt: at(800), endedAt: at(1000), toolCalls: 2 }),
      session({ id: 'call-b', nodeId: 'helper:bea', label: 'write the tests', state: 'working', doing: 'Editing src/app.ts', startedAt: at(900), toolCalls: 1 }),
    ],
    calls: [
      call('1', 'lead', 'run-0', 10, 40, 'Reading package.json'),
      call('2', 'lead', 'run-0', 100, 400, 'Writing src/app.ts'),
      call('3', 'checker', 'run-check', 640, 700, 'Running npm start'),
      call('4', 'lead', 'run-1', 760, 790, 'Running npm test', 'error'),
      call('5', 'helper:bea', 'call-a', 820, 900, 'Reading src/routes.ts'),
      call('6', 'helper:bea', 'call-a', 910, 990, 'Editing src/routes.ts'),
      call('7', 'helper:bea', 'call-b', 950, null, 'Editing src/app.ts'),
      call('8', 'lead', 'run-1', 1100, null, 'Running npm test'),
    ],
    totalCalls: 8,
    pauses: [{ from: at(450), to: at(500) }],
    ...over,
  }
}

export function projectDiagramFixture(build: BuildDiagram | null = diagramFixture(), flow: ProjectDiagram['flow'] = 'lead'): ProjectDiagram {
  return { workspaceId: 'ws-1', flow, build }
}

/** The fixture with Bea called `count` times, one after another: enough to draw her as one card. */
export function manyCallsOf(count: number): BuildDiagram {
  const base = diagramFixture()
  const sessions = Array.from({ length: count }, (_, index) => session({ id: `call-${String(index)}`, nodeId: 'helper:bea', label: `piece ${String(index + 1)}`, startedAt: at(800 + index * 10), endedAt: at(805 + index * 10), toolCalls: 1 }))
  return {
    ...base,
    nodes: base.nodes.map((one) => (one.id === 'helper:bea' ? { ...one, sessions: count, running: 0, state: 'done' as const, doing: null } : one)),
    edges: base.edges.map((edge) => (edge.target === 'helper:bea' ? { ...edge, label: `called ${String(count)} times`, state: 'done' as const } : edge)),
    sessions: [...base.sessions.filter((one) => one.nodeId !== 'helper:bea'), ...sessions],
    calls: base.calls.filter((one) => one.nodeId !== 'helper:bea'),
  }
}
