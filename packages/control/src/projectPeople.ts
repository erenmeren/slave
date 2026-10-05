import { prisma } from '@slave-of-ai/db/client'
import { SUBORDINATE_TOOLS, doingSentence } from '@slave-of-ai/domain'
import type { GoalSpend } from './lead/spend.js'

/** Who worked on a build: the lead, each helper it called, and the checkers. One row each. */
export interface PersonRow {
  /** Stable within a build: `lead`, `helper:<definition>`, `checker`, `second-checker`. */
  readonly id: string
  readonly kind: 'lead' | 'helper' | 'checker'
  readonly name: string
  /** The catalogue person behind a helper; null for the lead, a checker and a general helper. */
  readonly personId: string | null
  readonly state: 'working' | 'paused' | 'done'
  /** What it is doing now, in words; null when it is not working or has said nothing yet. */
  readonly doing: string | null
  /** Sessions it had: the lead's turns, a helper's calls, a checker's runs. */
  readonly sessions: number
  /** Sessions still open. */
  readonly running: number
  readonly toolCalls: number
  /** Tool calls of its that failed. */
  readonly failedCalls: number
  /**
   * What it cost. A helper's cost is inside the lead's (the runtime reports one figure per lead
   * turn), so a helper's is always null; the lead's and a checker's are null until a session of
   * theirs ended with a figure.
   */
  readonly costUsd: number | null
  /** The newest thing it did; null when it did nothing yet. */
  readonly lastAt: string | null
}

/** One turn of the lead, as the Turns table shows it. */
export interface TurnRow {
  readonly runId: string
  readonly turn: string
  readonly status: string
  readonly resumed: boolean
  /** Null while the turn runs: the runtime reports a turn's cost when it ends. */
  readonly costUsd: number | null
  readonly toolCalls: number
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly workedMs: number
  readonly startedAt: string
  readonly endedAt: string | null
}

/** One line of the build's activity: a tool call somebody made, newest first. */
export interface ActivityLine {
  readonly id: string
  readonly at: string
  readonly who: string
  readonly kind: PersonRow['kind']
  readonly text: string
  /** Null while the call is open. */
  readonly outcome: 'ok' | 'error' | null
}

export interface BuildPeople {
  readonly people: readonly PersonRow[]
  readonly turns: readonly TurnRow[]
  readonly activity: readonly ActivityLine[]
  /** People with a session open right now. */
  readonly workingNow: number
  /** Every tool call of the build, the helpers' included. */
  readonly toolCalls: number
  readonly spend: { readonly leadUsd: number; readonly proofUsd: number; readonly conductorUsd: number; readonly totalUsd: number; readonly unmeasuredRuns: number }
}

interface CallPayload {
  readonly name?: string
  readonly summary?: string
  readonly toolUseId?: string
  readonly subagent?: string
  readonly parentToolUseId?: string
  readonly outcome?: 'ok' | 'error'
}

const ACTIVITY_LINES = 60
const GENERAL_HELPER = 'general-purpose'
const sumCost = (rows: readonly { readonly costUsd: number | null }[]): number | null => (rows.some((row) => row.costUsd !== null) ? rows.reduce((total, row) => total + (row.costUsd ?? 0), 0) : null)

/**
 * Everybody who worked on one lead-flow build and what they did: the lead's turns, the helpers it
 * called (a top-level subordinate call; its own calls carry that call's id as their parent, C1),
 * and the checkers' runs. A read: nothing here writes. `helperName` turns a session definition's
 * name into the roster person's.
 */
export async function buildPeople(input: {
  readonly workspaceId: string
  readonly goalVersion: number
  readonly deliveryId: string
  readonly spend: GoalSpend
  readonly helper: (definition: string) => { readonly name: string; readonly personId: string | null }
}): Promise<BuildPeople> {
  const [turnRuns, checkRuns] = await Promise.all([
    prisma.slaveRun.findMany({
      where: { leadTurn: { not: null }, task: { workspaceId: input.workspaceId, workPackage: { goalVersion: input.goalVersion } } },
      orderBy: { startedAt: 'asc' },
      select: { id: true, leadTurn: true, status: true, leadResumed: true, costUsd: true, toolCalls: true, tokensIn: true, tokensOut: true, observedWorkingMs: true, startedAt: true, endedAt: true },
    }),
    prisma.slaveRun.findMany({
      where: { goalDeliveryId: input.deliveryId, kind: 'verification' },
      orderBy: { startedAt: 'asc' },
      select: { id: true, status: true, costUsd: true, toolCalls: true, confirmsRunId: true, startedAt: true, endedAt: true },
    }),
  ])
  const turnIds = new Set(turnRuns.map((run) => run.id))
  const events = await prisma.executionEvent.findMany({
    where: { runId: { in: [...turnIds, ...checkRuns.map((run) => run.id)] }, type: { in: ['run_tool_call', 'run_tool_result'] } },
    orderBy: { seq: 'asc' },
    select: { seq: true, type: true, runId: true, ts: true, payload: true },
  })

  const outcomes = new Map<string, 'ok' | 'error'>()
  for (const event of events) {
    if (event.type !== 'run_tool_result') continue
    const payload = event.payload as CallPayload
    if (payload.toolUseId !== undefined) outcomes.set(payload.toolUseId, payload.outcome ?? 'ok')
  }
  const liveTurn = turnRuns.find((run) => run.endedAt === null) ?? null
  const paused = liveTurn?.status === 'paused'

  // The lead's own calls and its helpers', told apart by the parent call.
  interface HelperTally { sessions: number; running: number; toolCalls: number; failedCalls: number; lastAt: Date | null; doing: string | null }
  const helpers = new Map<string, HelperTally>()
  const definitionOfCall = new Map<string, string>()
  const lead = { toolCalls: 0, failedCalls: 0, lastAt: null as Date | null, doing: null as string | null }
  const lines: ActivityLine[] = []
  const tally = (definition: string): HelperTally => {
    const found = helpers.get(definition)
    if (found !== undefined) return found
    const made: HelperTally = { sessions: 0, running: 0, toolCalls: 0, failedCalls: 0, lastAt: null, doing: null }
    helpers.set(definition, made)
    return made
  }
  const checkOf = new Map(checkRuns.map((run) => [run.id, run]))
  const checkerTally = { first: { toolCalls: 0, failedCalls: 0, lastAt: null as Date | null, doing: null as string | null }, second: { toolCalls: 0, failedCalls: 0, lastAt: null as Date | null, doing: null as string | null } }

  for (const event of events) {
    if (event.type !== 'run_tool_call' || event.runId === null) continue
    const payload = event.payload as CallPayload
    if (payload.name === undefined) continue
    const outcome = payload.toolUseId === undefined ? null : (outcomes.get(payload.toolUseId) ?? null)
    const failed = outcome === 'error'
    const text = doingSentence(payload.name, payload.summary ?? payload.name)
    let who = 'Lead'
    let kind: PersonRow['kind'] = 'lead'
    if (turnIds.has(event.runId)) {
      const live = event.runId === liveTurn?.id
      if (payload.parentToolUseId === undefined) {
        lead.toolCalls += 1
        if (failed) lead.failedCalls += 1
        lead.lastAt = event.ts
        if (live) lead.doing = text
        if (SUBORDINATE_TOOLS.includes(payload.name)) {
          const definition = payload.subagent ?? GENERAL_HELPER
          if (payload.toolUseId !== undefined) definitionOfCall.set(payload.toolUseId, definition)
          const entry = tally(definition)
          entry.sessions += 1
          entry.lastAt = event.ts
          if (live && outcome === null) {
            entry.running += 1
            entry.doing = 'Starting'
          }
        }
      } else {
        // A helper's own call. A helper of a helper counts for the helper the lead started.
        const definition = definitionOfCall.get(payload.parentToolUseId) ?? GENERAL_HELPER
        if (payload.toolUseId !== undefined) definitionOfCall.set(payload.toolUseId, definition)
        const entry = tally(definition)
        entry.toolCalls += 1
        if (failed) entry.failedCalls += 1
        entry.lastAt = event.ts
        if (live && entry.running > 0) entry.doing = text
        who = input.helper(definition).name
        kind = 'helper'
      }
    } else {
      const run = checkOf.get(event.runId)
      const entry = run?.confirmsRunId == null ? checkerTally.first : checkerTally.second
      entry.toolCalls += 1
      if (failed) entry.failedCalls += 1
      entry.lastAt = event.ts
      if (run?.endedAt === null) entry.doing = text
      who = run?.confirmsRunId == null ? 'Checker' : 'Second checker'
      kind = 'checker'
    }
    lines.push({ id: event.seq.toString(), at: event.ts.toISOString(), who, kind, text, outcome })
  }
  // A helper whose call ended is no longer running, whatever its last nested call said.
  for (const entry of helpers.values()) if (entry.running === 0) entry.doing = null
  const waitingOnHelpers = [...helpers.values()].some((entry) => entry.running > 0)

  const people: PersonRow[] = []
  if (turnRuns.length > 0) {
    people.push({
      id: 'lead',
      kind: 'lead',
      name: 'Lead',
      personId: null,
      state: liveTurn === null ? 'done' : paused ? 'paused' : 'working',
      doing: liveTurn === null || paused ? null : waitingOnHelpers ? 'Waiting for its helpers' : lead.doing,
      sessions: turnRuns.length,
      running: liveTurn === null ? 0 : 1,
      toolCalls: lead.toolCalls,
      failedCalls: lead.failedCalls,
      costUsd: sumCost(turnRuns),
      lastAt: lead.lastAt?.toISOString() ?? turnRuns.at(-1)?.startedAt.toISOString() ?? null,
    })
  }
  for (const [definition, entry] of [...helpers].sort((a, b) => (b[1].lastAt?.getTime() ?? 0) - (a[1].lastAt?.getTime() ?? 0))) {
    const named = input.helper(definition)
    people.push({
      id: `helper:${definition}`,
      kind: 'helper',
      name: named.name,
      personId: named.personId,
      state: entry.running === 0 ? 'done' : paused ? 'paused' : 'working',
      doing: paused ? null : entry.doing,
      sessions: entry.sessions,
      running: entry.running,
      toolCalls: entry.toolCalls,
      failedCalls: entry.failedCalls,
      costUsd: null,
      lastAt: entry.lastAt?.toISOString() ?? null,
    })
  }
  for (const [id, name, runs, entry] of [
    ['checker', 'Checker', checkRuns.filter((run) => run.confirmsRunId === null), checkerTally.first],
    ['second-checker', 'Second checker', checkRuns.filter((run) => run.confirmsRunId !== null), checkerTally.second],
  ] as const) {
    if (runs.length === 0) continue
    const open = runs.filter((run) => run.endedAt === null)
    people.push({
      id,
      kind: 'checker',
      name,
      personId: null,
      state: open.length === 0 ? 'done' : open.every((run) => run.status === 'paused') ? 'paused' : 'working',
      doing: open.length === 0 ? null : entry.doing,
      sessions: runs.length,
      running: open.length,
      toolCalls: Math.max(entry.toolCalls, runs.reduce((total, run) => total + run.toolCalls, 0)),
      failedCalls: entry.failedCalls,
      costUsd: sumCost(runs),
      lastAt: entry.lastAt?.toISOString() ?? runs.at(-1)?.startedAt.toISOString() ?? null,
    })
  }

  const now = Date.now()
  return {
    people,
    turns: turnRuns.map((run) => ({
      runId: run.id,
      turn: run.leadTurn ?? '',
      status: run.status,
      resumed: run.leadResumed,
      costUsd: run.costUsd,
      toolCalls: run.toolCalls,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      workedMs: run.observedWorkingMs > 0 ? run.observedWorkingMs : Math.max(0, (run.endedAt?.getTime() ?? now) - run.startedAt.getTime()),
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
    })),
    activity: lines.slice(-ACTIVITY_LINES).reverse(),
    workingNow: people.filter((person) => person.state === 'working').length,
    toolCalls: lines.length,
    spend: { leadUsd: input.spend.leadUsd, proofUsd: input.spend.proofUsd, conductorUsd: input.spend.conductorUsd, totalUsd: input.spend.totalUsd, unmeasuredRuns: input.spend.unmeasuredRuns },
  }
}
