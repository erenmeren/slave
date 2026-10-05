import { Prisma, prisma } from '@slave-of-ai/db/client'
import { STOP_REASON_WORDS, SUBORDINATE_TOOLS, doingSentence, type StopReason } from '@slave-of-ai/domain'
import { GENERAL_HELPER_DEFINITION, helperIdentities } from './helperNames.js'

/** One line of Home's "Happening now": a step somebody made, or a change of a build's state. */
export interface HappeningLine {
  /** The event's sequence number: stable, and the order. */
  readonly id: string
  readonly at: string
  readonly projectId: string
  readonly projectName: string
  /** `worker` is a session of an older project; `project` is a line about the project itself. */
  readonly kind: 'lead' | 'helper' | 'checker' | 'worker' | 'person' | 'project'
  readonly who: string
  readonly text: string
  /** A step, as opposed to a change of state. */
  readonly step: boolean
  /**
   * A step's outcome: `running` while its session is live and it has not answered; null on a change
   * of state, and on a step whose session stopped before it answered.
   */
  readonly outcome: 'ok' | 'error' | 'running' | null
}

/** The newest steps the feed shows, and the newest changes of state beside them. */
export const HAPPENING_STEPS = 30
export const HAPPENING_STATES = 12
/** Projects the feed reads: each costs two indexed reads per poll. */
const HAPPENING_PROJECTS = 40
/** How far up a helper-of-a-helper chain is followed to the helper the lead started. */
const PARENT_DEPTH = 4

const LIVE: readonly string[] = ['starting', 'working', 'resuming']
const STATE_TYPES = ['workspace_goal_set', 'workspace_lead_state', 'workspace_goal_accepted', 'workspace_goal_merged', 'workspace_goal_needs_human', 'guardrail_tripped'] as const

interface CallPayload {
  readonly name?: string
  readonly summary?: string
  readonly toolUseId?: string
  readonly subagent?: string
  readonly parentToolUseId?: string
}

const text = (payload: Record<string, unknown>, key: string): string | null => (typeof payload[key] === 'string' ? (payload[key] as string) : null)
const build = (payload: Record<string, unknown>): string => (typeof payload['version'] === 'number' ? `Build ${String(payload['version'])}` : 'The build')

/**
 * A change of state as one line, or null when it is not worth one. Said in a person's words: no
 * state name, no event name. A person's own act reads as theirs.
 */
export function stateLine(type: string, actor: string, payload: Record<string, unknown>): { readonly kind: 'person' | 'project'; readonly who: string; readonly text: string } | null {
  const person = actor === 'human'
  const by = person ? ({ kind: 'person', who: 'You' } as const) : ({ kind: 'project', who: 'Slave' } as const)
  switch (type) {
    case 'workspace_goal_set':
      return { ...by, text: 'A new build was asked for' }
    case 'workspace_lead_state': {
      const reason = text(payload, 'reason') as StopReason | null
      const why = reason !== null && reason in STOP_REASON_WORDS ? ` ${STOP_REASON_WORDS[reason]}` : ''
      switch (text(payload, 'state')) {
        case 'building':
          return { ...by, text: person ? `${build(payload)} was sent back to the lead` : `${build(payload)} started: the lead is building` }
        case 'proving':
          return { ...by, text: `${build(payload)} is being checked` }
        case 'awaiting_decision':
          return { ...by, text: `${build(payload)} is waiting for a decision.${why}` }
        case 'delivered':
          return { ...by, text: `${build(payload)} was delivered.${why}` }
        case 'stopped':
          return { ...by, text: `${build(payload)} was stopped.${why}` }
        default:
          return null
      }
    }
    case 'workspace_goal_accepted':
      return { ...by, text: `${build(payload)} passed its checks` }
    case 'workspace_goal_merged':
      return { ...(payload['by'] === 'human' ? ({ kind: 'person', who: 'You' } as const) : by), text: `${build(payload)} was merged into ${text(payload, 'into') ?? 'the base branch'}` }
    case 'workspace_goal_needs_human':
      return { ...by, text: `${build(payload)} needs a person to look at it` }
    case 'guardrail_tripped': {
      const guardrail = text(payload, 'guardrail')
      // An emergency stop writes two lines; the person's own is the one worth reading.
      if (guardrail === 'emergency_stop') return person ? { ...by, text: 'The project was stopped. Nothing runs until Continue is pressed' } : null
      const detail = text(payload, 'detail')
      return { kind: 'project', who: 'Slave', text: detail === null ? 'Slave stepped in and stopped the work' : `Slave stepped in: ${detail}` }
    }
    default:
      return null
  }
}

/**
 * Home's "Happening now": the newest steps across every project that is not archived -- who made
 * each, what it was in words, whether it worked -- and the newest changes of state beside them (a
 * build started, was checked, waits for a decision, was merged, was stopped). Newest first.
 *
 * Cheap on purpose, since Home polls it: per project two bounded reads off an index
 * (`workspaceId, seq` for the steps; `workspaceId, slaveId, seq` for the state lines, which no
 * session writes), then the steps' sessions, their results and the helpers behind them, each one
 * read. A read: nothing here writes.
 */
export async function happeningNow(): Promise<readonly HappeningLine[]> {
  const workspaces = await prisma.workspace.findMany({ where: { archivedAt: null }, orderBy: { createdAt: 'desc' }, take: HAPPENING_PROJECTS, select: { id: true, name: true, leadRoster: true } })
  if (workspaces.length === 0) return []
  const nameOf = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))

  const perProject = await Promise.all(
    workspaces.map(async (workspace) => {
      const select = { seq: true, ts: true, type: true, workspaceId: true, runId: true, actor: true, payload: true } as const
      const [steps, states] = await Promise.all([
        prisma.executionEvent.findMany({ where: { workspaceId: workspace.id, type: 'run_tool_call' }, orderBy: { seq: 'desc' }, take: HAPPENING_STEPS, select }),
        prisma.executionEvent.findMany({ where: { workspaceId: workspace.id, slaveId: null, type: { in: [...STATE_TYPES] } }, orderBy: { seq: 'desc' }, take: HAPPENING_STATES, select }),
      ])
      return { steps, states }
    }),
  )
  const newestFirst = (a: { readonly seq: bigint }, b: { readonly seq: bigint }): number => (a.seq < b.seq ? 1 : a.seq > b.seq ? -1 : 0)
  const steps = perProject.flatMap((one) => one.steps).sort(newestFirst).slice(0, HAPPENING_STEPS)
  const states = perProject.flatMap((one) => one.states).sort(newestFirst)

  const lines: HappeningLine[] = []
  for (const event of states) {
    const line = stateLine(event.type, event.actor, event.payload as Record<string, unknown>)
    if (line === null) continue
    lines.push({ id: event.seq.toString(), at: event.ts.toISOString(), projectId: event.workspaceId, projectName: nameOf.get(event.workspaceId) ?? '', ...line, step: false, outcome: null })
  }
  const stateLines = lines.splice(0).slice(0, HAPPENING_STATES)

  const runIds = [...new Set(steps.flatMap((event) => (event.runId === null ? [] : [event.runId])))]
  if (runIds.length > 0) {
    const calls = steps.map((event) => event.payload as CallPayload)
    const callIds = calls.flatMap((call) => (call.toolUseId === undefined ? [] : [call.toolUseId]))
    const oldest = steps.at(-1)?.seq ?? 0n
    const [runs, results] = await Promise.all([
      prisma.slaveRun.findMany({ where: { id: { in: runIds } }, select: { id: true, leadTurn: true, kind: true, confirmsRunId: true, status: true, endedAt: true, slave: { select: { person: { select: { name: true } } } } } }),
      callIds.length === 0
        ? []
        : prisma.$queryRaw<{ readonly id: string; readonly outcome: string | null }[]>(Prisma.sql`
            SELECT payload->>'toolUseId' AS id, payload->>'outcome' AS outcome
            FROM "ExecutionEvent"
            WHERE "runId" = ANY(${runIds}::text[]) AND seq > ${oldest} AND type = 'run.tool_result' AND payload->>'toolUseId' = ANY(${callIds}::text[])
          `),
    ])
    const runOf = new Map(runs.map((run) => [run.id, run]))
    const outcomeOf = new Map(results.map((row) => [row.id, row.outcome === 'error' ? ('error' as const) : ('ok' as const)]))

    // The helper behind a nested step: follow its parent call up to the one the lead made.
    const parents = new Map<string, { readonly parent: string | null; readonly definition: string }>()
    let wanted = [...new Set(calls.flatMap((call) => (call.parentToolUseId === undefined ? [] : [call.parentToolUseId])))]
    for (let depth = 0; depth < PARENT_DEPTH && wanted.length > 0; depth += 1) {
      const found = await prisma.$queryRaw<{ readonly id: string; readonly parent: string | null; readonly subagent: string | null }[]>(Prisma.sql`
        SELECT payload->>'toolUseId' AS id, payload->>'parentToolUseId' AS parent, payload->>'subagent' AS subagent
        FROM "ExecutionEvent"
        WHERE "runId" = ANY(${runIds}::text[]) AND type = 'run.tool_call' AND payload->>'toolUseId' = ANY(${wanted}::text[])
      `)
      for (const row of found) parents.set(row.id, { parent: row.parent, definition: row.subagent ?? GENERAL_HELPER_DEFINITION })
      wanted = [...new Set(found.flatMap((row) => (row.parent === null || parents.has(row.parent) ? [] : [row.parent])))]
    }
    const definitionOf = (parentId: string): string => {
      let definition = GENERAL_HELPER_DEFINITION
      let id: string | null = parentId
      for (let depth = 0; depth < PARENT_DEPTH && id !== null; depth += 1) {
        const at = parents.get(id)
        if (at === undefined) break
        definition = at.definition
        id = at.parent
      }
      return definition
    }
    const helper = await helperIdentities(new Map(workspaces.map((workspace) => [workspace.id, workspace.leadRoster])))

    for (const event of steps) {
      const call = event.payload as CallPayload
      if (call.name === undefined || event.runId === null) continue
      const run = runOf.get(event.runId)
      let kind: HappeningLine['kind'] = 'worker'
      let who = run?.slave.person.name ?? 'A session'
      if (run?.leadTurn != null) {
        if (call.parentToolUseId === undefined) [kind, who] = ['lead', 'Lead']
        else [kind, who] = ['helper', helper(event.workspaceId, definitionOf(call.parentToolUseId)).name]
      } else if (run?.kind === 'verification') {
        ;[kind, who] = ['checker', run.confirmsRunId === null ? 'Checker' : 'Second checker']
      }
      lines.push({
        id: event.seq.toString(),
        at: event.ts.toISOString(),
        projectId: event.workspaceId,
        projectName: nameOf.get(event.workspaceId) ?? '',
        kind,
        who,
        text: SUBORDINATE_TOOLS.includes(call.name) && call.parentToolUseId === undefined ? 'Handed work to a helper' : doingSentence(call.name, call.summary ?? call.name),
        step: true,
        outcome: (call.toolUseId === undefined ? undefined : outcomeOf.get(call.toolUseId)) ?? (run !== undefined && run.endedAt === null && LIVE.includes(run.status) ? 'running' : null),
      })
    }
  }

  return [...lines, ...stateLines].sort((a, b) => newestFirst({ seq: BigInt(a.id) }, { seq: BigInt(b.id) }))
}
