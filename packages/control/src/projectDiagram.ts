import { prisma } from '@slave-of-ai/db/client'
import { SUBORDINATE_TOOLS, buildRosterDefinitions, doingSentence, err, ok, type Result, type WorkspaceFlow } from '@slave-of-ai/domain'
import { loadLeadRoster } from './lead/roster.js'
import type { ControlRefusal } from './refusal.js'

/** How a node, a session or an edge of the diagram stands. */
export type DiagramState = 'working' | 'paused' | 'done' | 'failed'

/** What came of a build: the Result node's word. */
export type DiagramResult = 'merged' | 'waiting_for_you' | 'left_unmerged' | 'not_yet'

/**
 * One box of the team diagram. `request` is the person who asked, `result` what came of it; the
 * others are who worked: the lead, one node per helper the lead called (however often), and the
 * checkers. The figures of `request` and `result` are zero.
 */
export interface DiagramNode {
  /** Stable within a build: `request`, `lead`, `helper:<definition>`, `checker`, `second-checker`, `result`. */
  readonly id: string
  readonly kind: 'request' | 'lead' | 'helper' | 'checker' | 'result'
  readonly name: string
  /** The catalogue person behind a helper; null for everybody else and for a general helper. */
  readonly personId: string | null
  readonly state: DiagramState
  /** What it is doing now, in words; null when it is not working or has said nothing yet. */
  readonly doing: string | null
  readonly sessions: number
  /** Sessions still open. */
  readonly running: number
  readonly toolCalls: number
  readonly failedCalls: number
  /** A helper's cost is inside the lead's turn, so a helper's is always null. */
  readonly costUsd: number | null
  readonly lastAt: string | null
}

export interface DiagramEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly kind: 'request' | 'helper' | 'check' | 'result'
  /** "called 3 times", "check 2"; null when the line needs no words. */
  readonly label: string | null
  /** The target's state: the line moves while it is `working`. */
  readonly state: DiagramState
}

/** One sitting of somebody: a turn of the lead, one call of a helper, one run of a checker. */
export interface DiagramSession {
  /** The run's id, or for a helper the id of the call that started it. */
  readonly id: string
  readonly nodeId: string
  /** The lead's turn (`build`, `rework`, ...), what a helper was asked to do, or `check`. */
  readonly label: string
  readonly state: DiagramState
  readonly startedAt: string
  /** Null while it is open. */
  readonly endedAt: string | null
  readonly toolCalls: number
  readonly failedCalls: number
  /** A lead turn's or a check's own figure once it ended; always null for a helper. */
  readonly costUsd: number | null
}

/** One step somebody took, with when it began and when its result came. */
export interface DiagramCall {
  readonly id: string
  readonly nodeId: string
  readonly sessionId: string
  readonly at: string
  /** When its result came; for a call left without one, when its session ended; null while open. */
  readonly endedAt: string | null
  readonly text: string
  /** Null while it is open, and for a call whose session ended without a result. */
  readonly outcome: 'ok' | 'error' | null
}

/** A build of a lead-flow project as a diagram: who worked, who called whom, and every step in time. */
export interface BuildDiagram {
  readonly version: number
  /** The request, cut to its first lines. */
  readonly goal: string
  readonly result: DiagramResult
  /** When this was read: the diagram's "now". */
  readonly at: string
  /** The build's first instant. */
  readonly from: string
  /** Its last instant; null while somebody is working (it runs to now). */
  readonly to: string | null
  readonly nodes: readonly DiagramNode[]
  readonly edges: readonly DiagramEdge[]
  /** Oldest first. */
  readonly sessions: readonly DiagramSession[]
  /** The newest `DIAGRAM_CALL_CAP` steps, oldest first. */
  readonly calls: readonly DiagramCall[]
  /** Every step of the build, the ones not in `calls` included. */
  readonly totalCalls: number
  /** When the build stood paused: from a pause to the next resume, null while it still is. */
  readonly pauses: readonly { readonly from: string; readonly to: string | null }[]
}

export interface ProjectDiagram {
  readonly workspaceId: string
  readonly flow: WorkspaceFlow
  /** Null for an older (packages-flow) project and for a project with no build yet. */
  readonly build: BuildDiagram | null
}

/** The most steps a diagram carries: the newest ones. The tallies still count every step. */
export const DIAGRAM_CALL_CAP = 2000
/**
 * A helper started in the background answers its starting call at once and works on. With no
 * word of its end on the stream, it counts as still open while its newest step is this recent.
 */
export const HELPER_QUIET_MS = 120_000

const GENERAL_HELPER = 'general-purpose'
const GOAL_CHARS = 280

interface CallPayload {
  readonly name?: string
  readonly summary?: string
  readonly toolUseId?: string
  readonly subagent?: string
  readonly parentToolUseId?: string
  readonly outcome?: 'ok' | 'error'
}

interface Tally {
  toolCalls: number
  failedCalls: number
  lastAt: Date | null
  doing: string | null
}

interface HelperSession extends Tally {
  readonly id: string
  readonly definition: string
  readonly runId: string
  readonly label: string
  readonly startedAt: Date
  /** The starting call has no result yet. */
  startOpen: boolean
  startFailed: boolean
  /** Its own calls with no result yet. */
  open: number
  /** The newest thing on its stream: a call of its own or a result. */
  newest: Date
}

const tally = (): Tally => ({ toolCalls: 0, failedCalls: 0, lastAt: null, doing: null })
const iso = (date: Date | null | undefined): string | null => date?.toISOString() ?? null
const sumCost = (rows: readonly { readonly costUsd: number | null }[]): number | null => (rows.some((row) => row.costUsd !== null) ? rows.reduce((total, row) => total + (row.costUsd ?? 0), 0) : null)
const times = (count: number): string => (count === 1 ? 'called once' : `called ${String(count)} times`)
/** A run's state, from its row: open and paused, open, ended badly, or ended. */
const runState = (run: { readonly status: string; readonly endedAt: Date | null }): DiagramState => (run.endedAt === null ? (run.status === 'paused' ? 'paused' : 'working') : run.status === 'failed' ? 'failed' : 'done')
/** What a helper was asked to do: its starting call's own line without the tool's name. */
function askedFor(summary: string | undefined): string {
  const space = summary?.indexOf(' ') ?? -1
  const text = space === -1 ? '' : (summary ?? '').slice(space + 1).trim()
  return text === '' ? 'A piece of the work' : text
}

/**
 * A build as a diagram (the Project screen's Diagram and Timeline views): the request, the lead,
 * each helper it called, the checkers and the result, the lines between them, everybody's
 * sessions, and the build's steps in time. It reads the same events `buildPeople` reads, the same
 * way: a top-level subordinate call starts a helper, and a helper's own calls carry that call's id
 * as their parent. One difference: a helper started in the background is told from its own steps,
 * not from its starting call's immediate answer (`HELPER_QUIET_MS`). A read: nothing here writes.
 * `goalVersion` picks a build; without it, the newest one with a delivery.
 */
export async function buildDiagram(workspaceId: string, goalVersion?: number, now: Date = new Date()): Promise<Result<ProjectDiagram, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, flow: true, leadRoster: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.flow !== 'lead') return ok({ workspaceId, flow: workspace.flow, build: null })
  const delivery = await prisma.goalDelivery.findFirst({
    where: { workspaceId, ...(goalVersion === undefined ? {} : { goalVersion }) },
    orderBy: { goalVersion: 'desc' },
    select: { id: true, goalVersion: true, leadState: true, status: true, mergedAt: true, createdAt: true },
  })
  if (delivery === null) return goalVersion === undefined ? ok({ workspaceId, flow: workspace.flow, build: null }) : err({ kind: 'goal_version_not_found', workspaceId, goalVersion })
  const version = delivery.goalVersion

  const [goal, turnRuns, checkRuns] = await Promise.all([
    prisma.goalVersion.findFirst({ where: { workspaceId, version }, select: { text: true } }),
    prisma.slaveRun.findMany({
      where: { leadTurn: { not: null }, task: { workspaceId, workPackage: { goalVersion: version } } },
      orderBy: { startedAt: 'asc' },
      select: { id: true, leadTurn: true, status: true, costUsd: true, startedAt: true, endedAt: true },
    }),
    prisma.slaveRun.findMany({
      where: { goalDeliveryId: delivery.id, kind: 'verification' },
      orderBy: { startedAt: 'asc' },
      select: { id: true, status: true, costUsd: true, toolCalls: true, confirmsRunId: true, startedAt: true, endedAt: true },
    }),
  ])
  const turnOf = new Map(turnRuns.map((run) => [run.id, run]))
  const checkOf = new Map(checkRuns.map((run) => [run.id, run]))
  const events = await prisma.executionEvent.findMany({
    where: { runId: { in: [...turnOf.keys(), ...checkOf.keys()] }, type: { in: ['run_tool_call', 'run_tool_result', 'run_paused', 'run_resumed'] } },
    orderBy: { seq: 'asc' },
    select: { seq: true, type: true, runId: true, ts: true, payload: true },
  })

  // Who a helper is: the roster person its session definition was made from, as `projectView` names it.
  const slugs = buildRosterDefinitions(await loadLeadRoster(workspace.leadRoster)).slugs
  const persons = await prisma.person.findMany({ where: { id: { in: [...slugs.values()] } }, select: { id: true, name: true } })
  const helperOf = (definition: string): { readonly name: string; readonly personId: string | null } => {
    if (definition === GENERAL_HELPER) return { name: 'General helper', personId: null }
    const personId = slugs.get(definition) ?? null
    return { name: persons.find((person) => person.id === personId)?.name ?? definition, personId }
  }

  // Each call's result, and when the build stood paused.
  const results = new Map<string, { readonly at: Date; readonly outcome: 'ok' | 'error' }>()
  const pauses: { from: Date; to: Date | null; runId: string }[] = []
  for (const event of events) {
    if (event.runId === null) continue
    if (event.type === 'run_tool_result') {
      const payload = event.payload as CallPayload
      if (payload.toolUseId !== undefined) results.set(payload.toolUseId, { at: event.ts, outcome: payload.outcome ?? 'ok' })
    } else if (event.type === 'run_paused') {
      pauses.push({ from: event.ts, to: null, runId: event.runId })
    } else if (event.type === 'run_resumed') {
      const open = pauses.findLast((pause) => pause.runId === event.runId && pause.to === null)
      if (open !== undefined) open.to = event.ts
    }
  }

  const liveTurn = turnRuns.find((run) => run.endedAt === null) ?? null
  const paused = liveTurn?.status === 'paused'
  // What "recently" is measured from: now, or for a paused turn the moment it paused.
  const reference = paused ? (pauses.findLast((pause) => pause.runId === liveTurn.id)?.from ?? now) : now

  const lead = tally()
  const turnTally = new Map(turnRuns.map((run) => [run.id, tally()]))
  const checkTally = new Map(checkRuns.map((run) => [run.id, tally()]))
  const helperSessions = new Map<string, HelperSession>()
  const sessionOfCall = new Map<string, HelperSession>()
  const calls: DiagramCall[] = []
  let totalCalls = 0

  for (const event of events) {
    if (event.type !== 'run_tool_call' || event.runId === null) continue
    const payload = event.payload as CallPayload
    if (payload.name === undefined) continue
    const result = payload.toolUseId === undefined ? undefined : results.get(payload.toolUseId)
    const failed = result?.outcome === 'error'
    const text = doingSentence(payload.name, payload.summary ?? payload.name)
    const turn = turnOf.get(event.runId)
    let nodeId: string
    let sessionId = event.runId
    let sessionEnd: Date | null
    if (turn !== undefined) {
      sessionEnd = turn.endedAt
      const parent = payload.parentToolUseId === undefined ? undefined : sessionOfCall.get(payload.parentToolUseId)
      if (payload.parentToolUseId === undefined) {
        nodeId = 'lead'
        for (const entry of [lead, turnTally.get(turn.id)]) {
          if (entry === undefined) continue
          entry.toolCalls += 1
          if (failed) entry.failedCalls += 1
          entry.lastAt = event.ts
          entry.doing = text
        }
        if (SUBORDINATE_TOOLS.includes(payload.name) && payload.toolUseId !== undefined) {
          const session: HelperSession = {
            ...tally(),
            id: payload.toolUseId,
            definition: payload.subagent ?? GENERAL_HELPER,
            runId: turn.id,
            label: askedFor(payload.summary),
            startedAt: event.ts,
            startOpen: result === undefined,
            startFailed: failed,
            open: 0,
            newest: result?.at ?? event.ts,
          }
          helperSessions.set(session.id, session)
          sessionOfCall.set(session.id, session)
        }
      } else if (parent !== undefined) {
        // A helper's own call. A helper of a helper counts for the helper the lead started.
        if (payload.toolUseId !== undefined) sessionOfCall.set(payload.toolUseId, parent)
        parent.toolCalls += 1
        if (failed) parent.failedCalls += 1
        parent.lastAt = event.ts
        parent.doing = text
        if (result === undefined) parent.open += 1
        const newest = result?.at ?? event.ts
        if (newest > parent.newest) parent.newest = newest
        nodeId = `helper:${parent.definition}`
        sessionId = parent.id
      } else {
        // A nested call whose starting call was never seen: it still counts, for a general helper.
        nodeId = `helper:${GENERAL_HELPER}`
      }
    } else {
      const run = checkOf.get(event.runId)
      sessionEnd = run?.endedAt ?? null
      nodeId = run?.confirmsRunId == null ? 'checker' : 'second-checker'
      const entry = checkTally.get(event.runId)
      if (entry !== undefined) {
        entry.toolCalls += 1
        if (failed) entry.failedCalls += 1
        entry.lastAt = event.ts
        entry.doing = text
      }
    }
    totalCalls += 1
    calls.push({ id: event.seq.toString(), nodeId, sessionId, at: event.ts.toISOString(), endedAt: iso(result?.at ?? sessionEnd), text, outcome: result?.outcome ?? null })
  }

  // The helpers' sessions, then the helpers themselves: one node per session definition.
  const sessions: DiagramSession[] = []
  const stateOfHelper = new Map<string, DiagramState>()
  for (const session of helperSessions.values()) {
    const live = session.runId === liveTurn?.id
    const background = !session.startOpen && session.toolCalls > 0
    const open = live && (session.startOpen || session.open > 0 || (background && reference.getTime() - session.newest.getTime() < HELPER_QUIET_MS))
    const state: DiagramState = open ? (paused ? 'paused' : 'working') : session.startFailed ? 'failed' : 'done'
    stateOfHelper.set(session.id, state)
    const turnEnd = turnOf.get(session.runId)?.endedAt ?? null
    sessions.push({
      id: session.id,
      nodeId: `helper:${session.definition}`,
      label: session.label,
      state,
      startedAt: session.startedAt.toISOString(),
      endedAt: open ? null : iso(turnEnd !== null && turnEnd < session.newest ? turnEnd : session.newest),
      toolCalls: session.toolCalls,
      failedCalls: session.failedCalls,
      costUsd: null,
    })
  }
  const waitingOnHelpers = [...helperSessions.values()].some((session) => session.startOpen && session.runId === liveTurn?.id)

  const nodes: DiagramNode[] = [{ id: 'request', kind: 'request', name: 'You', personId: null, state: 'done', doing: null, sessions: 0, running: 0, toolCalls: 0, failedCalls: 0, costUsd: null, lastAt: iso(delivery.createdAt) }]
  const edges: DiagramEdge[] = []
  const lastTurn = turnRuns.at(-1)
  if (lastTurn !== undefined) {
    const state = liveTurn === null ? runState(lastTurn) : runState(liveTurn)
    nodes.push({
      id: 'lead',
      kind: 'lead',
      name: 'Lead',
      personId: null,
      state,
      doing: state !== 'working' ? null : waitingOnHelpers ? 'Waiting for its helpers' : (turnTally.get(liveTurn?.id ?? '')?.doing ?? null),
      sessions: turnRuns.length,
      running: liveTurn === null ? 0 : 1,
      toolCalls: lead.toolCalls,
      failedCalls: lead.failedCalls,
      costUsd: sumCost(turnRuns),
      lastAt: iso(lead.lastAt ?? lastTurn.startedAt),
    })
    edges.push({ id: 'request->lead', source: 'request', target: 'lead', kind: 'request', label: `build ${String(version)}`, state })
    for (const run of turnRuns) {
      const entry = turnTally.get(run.id)
      sessions.push({ id: run.id, nodeId: 'lead', label: run.leadTurn ?? '', state: runState(run), startedAt: run.startedAt.toISOString(), endedAt: iso(run.endedAt), toolCalls: entry?.toolCalls ?? 0, failedCalls: entry?.failedCalls ?? 0, costUsd: run.costUsd })
    }
  }

  const byDefinition = new Map<string, HelperSession[]>()
  for (const session of helperSessions.values()) byDefinition.set(session.definition, [...(byDefinition.get(session.definition) ?? []), session])
  const newestOf = (list: readonly HelperSession[]): number => Math.max(...list.map((session) => session.newest.getTime()))
  for (const [definition, list] of [...byDefinition].sort((a, b) => newestOf(b[1]) - newestOf(a[1]))) {
    const named = helperOf(definition)
    const states = list.map((session) => stateOfHelper.get(session.id) ?? 'done')
    const running = states.filter((state) => state === 'working' || state === 'paused').length
    const state: DiagramState = states.includes('working') ? 'working' : states.includes('paused') ? 'paused' : states.at(-1) === 'failed' ? 'failed' : 'done'
    const doing = state !== 'working' ? null : (list.findLast((session) => stateOfHelper.get(session.id) === 'working')?.doing ?? 'Starting')
    const id = `helper:${definition}`
    nodes.push({
      id,
      kind: 'helper',
      name: named.name,
      personId: named.personId,
      state,
      doing,
      sessions: list.length,
      running,
      toolCalls: list.reduce((total, session) => total + session.toolCalls, 0),
      failedCalls: list.reduce((total, session) => total + session.failedCalls, 0),
      costUsd: null,
      lastAt: new Date(newestOf(list)).toISOString(),
    })
    edges.push({ id: `lead->${id}`, source: 'lead', target: id, kind: 'helper', label: times(list.length), state })
  }

  let last = lastTurn === undefined ? 'request' : 'lead'
  for (const [id, name, runs] of [
    ['checker', 'Checker', checkRuns.filter((run) => run.confirmsRunId === null)],
    ['second-checker', 'Second checker', checkRuns.filter((run) => run.confirmsRunId !== null)],
  ] as const) {
    const newest = runs.at(-1)
    if (newest === undefined) continue
    const open = runs.filter((run) => run.endedAt === null)
    const state: DiagramState = open.length === 0 ? runState(newest) : open.every((run) => run.status === 'paused') ? 'paused' : 'working'
    const entries = runs.map((run) => checkTally.get(run.id) ?? tally())
    const lastAt = entries.reduce<Date | null>((found, entry) => (entry.lastAt !== null && (found === null || entry.lastAt > found) ? entry.lastAt : found), null)
    nodes.push({
      id,
      kind: 'checker',
      name,
      personId: null,
      state,
      doing: state !== 'working' ? null : (checkTally.get(open.at(-1)?.id ?? '')?.doing ?? null),
      sessions: runs.length,
      running: open.length,
      toolCalls: Math.max(entries.reduce((total, entry) => total + entry.toolCalls, 0), runs.reduce((total, run) => total + run.toolCalls, 0)),
      failedCalls: entries.reduce((total, entry) => total + entry.failedCalls, 0),
      costUsd: sumCost(runs),
      lastAt: iso(lastAt ?? newest.startedAt),
    })
    edges.push({ id: `${last}->${id}`, source: last, target: id, kind: 'check', label: id === 'checker' ? `check ${String(runs.length)}` : `confirms check ${String(runs.length)}`, state })
    for (const run of runs) {
      const entry = checkTally.get(run.id)
      sessions.push({ id: run.id, nodeId: id, label: 'check', state: runState(run), startedAt: run.startedAt.toISOString(), endedAt: iso(run.endedAt), toolCalls: Math.max(entry?.toolCalls ?? 0, run.toolCalls), failedCalls: entry?.failedCalls ?? 0, costUsd: run.costUsd })
    }
    last = id
  }

  const result: DiagramResult = delivery.mergedAt !== null || delivery.leadState === 'delivered' ? 'merged' : delivery.leadState === 'stopped' ? 'left_unmerged' : delivery.leadState === 'awaiting_decision' ? 'waiting_for_you' : 'not_yet'
  const resultState: DiagramState = result === 'merged' ? 'done' : result === 'waiting_for_you' ? 'paused' : result === 'left_unmerged' ? 'failed' : 'working'
  nodes.push({ id: 'result', kind: 'result', name: 'Result', personId: null, state: resultState, doing: null, sessions: 0, running: 0, toolCalls: 0, failedCalls: 0, costUsd: null, lastAt: iso(delivery.mergedAt) })
  // The line to the result never moves: nobody works "on" it.
  edges.push({ id: `${last}->result`, source: last, target: 'result', kind: 'result', label: null, state: result === 'not_yet' ? 'done' : resultState })

  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const working = nodes.some((node) => node.kind !== 'result' && node.state === 'working')
  const instants = [
    delivery.createdAt,
    ...turnRuns.flatMap((run) => [run.startedAt, run.endedAt]),
    ...checkRuns.flatMap((run) => [run.startedAt, run.endedAt]),
    ...events.map((event) => event.ts),
  ].filter((date): date is Date => date !== null)
  const firstRun = [...turnRuns, ...checkRuns].reduce<Date | null>((found, run) => (found === null || run.startedAt < found ? run.startedAt : found), null)
  const from = firstRun ?? delivery.createdAt
  const to = working ? null : instants.reduce((found, date) => (date > found ? date : found), from)

  return ok({
    workspaceId,
    flow: workspace.flow,
    build: {
      version,
      goal: (goal?.text ?? '').trim().slice(0, GOAL_CHARS),
      result,
      at: now.toISOString(),
      from: from.toISOString(),
      to: iso(to),
      nodes,
      edges,
      sessions,
      calls: calls.slice(-DIAGRAM_CALL_CAP),
      totalCalls,
      pauses: pauses.map((pause) => ({ from: pause.from.toISOString(), to: iso(pause.to) })),
    },
  })
}
