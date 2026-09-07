import { actionEnvelopeSchema, type ActionEnvelope, type EngineRejection } from './action.js'
import type { JournalEntry } from './journal.js'
import { emptyQueue, enqueue, popDue, type EventQueue } from './queue.js'
import { seedState } from './rng.js'
import type { RoleDefinition, ScheduleRequest, SectorModel } from './sector.js'
import { RecordedDecisionProvider } from '../decide/recorded.js'
import type { DecisionProvider } from '../decide/provider.js'

export interface EngineLimits {
  readonly maxSteps: number
  readonly maxDecisionsPerStep: number
  readonly maxJournalEntries: number
}

export interface EngineDefinition {
  readonly roles: readonly RoleDefinition[]
  readonly roleOrder: readonly string[]
  readonly horizonDays: number
  readonly seed: number
  readonly limits: EngineLimits
}

export type EngineStatus = 'ready' | 'running' | 'finished' | 'halted'

export interface EngineState<S, E> {
  readonly day: number
  readonly sector: S
  readonly queue: EventQueue<E>
  readonly rngState: number
  readonly journalSeq: number
  readonly stepCount: number
  readonly decisionCount: number
  readonly status: EngineStatus
  readonly haltedReason: string | null
}

export interface StepResult<S, E> {
  readonly state: EngineState<S, E>
  readonly entries: readonly JournalEntry[]
}

export function initialEngineState<S, E>(sector: S, scenario: readonly ScheduleRequest<E>[], seed: number): EngineState<S, E> {
  let queue = emptyQueue<E>()
  for (const request of scenario) queue = enqueue(queue, request.time, request.priority, request.event)
  return { day: 0, sector, queue, rngState: seedState(seed), journalSeq: 0, stepCount: 0, decisionCount: 0, status: 'ready', haltedReason: null }
}

function scheduleAll<E>(queue: EventQueue<E>, requests: readonly ScheduleRequest<E>[]): EventQueue<E> {
  let next = queue
  for (const request of requests) next = enqueue(next, request.time, request.priority, request.event)
  return next
}

/** One simulation day: due events → each role's decision point → the sector's day close. */
export function step<S, E, R extends Record<string, unknown>>(model: SectorModel<S, E, R>, definition: EngineDefinition, state: EngineState<S, E>, provider: DecisionProvider): StepResult<S, E> {
  if (state.status === 'finished' || state.status === 'halted') return { state, entries: [] }
  const day = state.day
  const entries: JournalEntry[] = []
  let seq = state.journalSeq
  let sector = state.sector
  let decisionCount = state.decisionCount
  const record = (kind: JournalEntry['kind'], actorRole: string | null, payload: Record<string, unknown>): void => {
    seq += 1
    entries.push({ seq, simTime: day, kind, actorRole, payload })
  }

  // 1. Everything due today, in (priority, enqueue) order. External events journal as such.
  const popped = popDue(state.queue, day)
  let queue = popped.rest
  for (const item of popped.due) {
    const applied = model.applyEvent(sector, item.event, day)
    sector = applied.state
    queue = scheduleAll(queue, applied.schedule)
    record(item.priority === 'external' ? 'external_event' : 'event', null, { event: item.event, ...applied.record })
  }

  // 2. Decision points, one per role in order; every action validated against the state as it is
  //    NOW (after earlier actions this day), never against the observation the actor was shown.
  definition.roleOrder.forEach((roleName, index) => {
    const role = definition.roles.find((r) => r.name === roleName)
    if (role === undefined) return
    const observation = model.observe(sector, role)
    const proposed = provider.decide({ day, role, observation, index })
    record('decision', role.name, { index, provider: provider.kindFor?.(role) ?? provider.kind, observation, actions: proposed })
    for (let actionIndex = 0; actionIndex < proposed.length; actionIndex++) {
      const raw = proposed[actionIndex]
      const outcome = validateAndApply(model, definition, sector, role, raw, actionIndex, day)
      decisionCount += 1
      if (outcome.ok) {
        sector = outcome.state
        queue = scheduleAll(queue, outcome.schedule)
        record('action_applied', role.name, { index, actionIndex, action: outcome.action, ...(outcome.record ?? {}) })
      } else {
        record('action_rejected', role.name, { index, actionIndex, action: raw, reason: outcome.reason })
        // One `limit_exceeded` per decision point: everything past the cap is dropped, not listed.
        if ('kind' in outcome.reason && outcome.reason.kind === 'limit_exceeded') break
      }
    }
  })

  // 3. Day close.
  const closed = model.closeDay(sector, day)
  sector = closed.state
  queue = scheduleAll(queue, closed.schedule)
  record('event', null, { kind: 'close', ...closed.record })

  const stepCount = state.stepCount + 1
  const nextDay = day + 1
  let status: EngineState<S, E>['status'] = nextDay >= definition.horizonDays ? 'finished' : 'running'
  let haltedReason: string | null = null
  if (seq > definition.limits.maxJournalEntries) {
    status = 'halted'
    haltedReason = 'maxJournalEntries'
  } else if (stepCount >= definition.limits.maxSteps && status !== 'finished') {
    status = 'halted'
    haltedReason = 'maxSteps'
  }
  return { state: { day: nextDay, sector, queue, rngState: state.rngState, journalSeq: seq, stepCount, decisionCount, status, haltedReason }, entries }
}

type Outcome<S, E, R> =
  | { readonly ok: true; readonly state: S; readonly schedule: readonly ScheduleRequest<E>[]; readonly action: ActionEnvelope; readonly record?: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: EngineRejection | R }

function validateAndApply<S, E, R extends Record<string, unknown>>(model: SectorModel<S, E, R>, definition: EngineDefinition, sector: S, role: RoleDefinition, raw: unknown, actionIndex: number, day: number): Outcome<S, E, R> {
  if (actionIndex >= definition.limits.maxDecisionsPerStep) return { ok: false, reason: { kind: 'limit_exceeded', limit: 'maxDecisionsPerStep' } }
  const parsed = actionEnvelopeSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: { kind: 'schema_invalid', detail: parsed.error.issues.map((i) => i.message).join('; ') } }
  const action = parsed.data
  if (!role.allowedActions.includes(action.type)) return { ok: false, reason: { kind: 'role_not_allowed', role: role.name, type: action.type } }
  const verdict = model.validate(sector, role, action)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  const applied = model.apply(sector, role, action, day)
  return { ok: true, state: applied.state, schedule: applied.schedule, action, ...(applied.record !== undefined ? { record: applied.record } : {}) }
}

/** Steps until `untilDay` (exclusive of nothing: the state's `day` reaches it), the horizon, a
 *  halt, or `maxStepsPerCall` — the control layer's own bound on one request. */
export function runUntil<S, E, R extends Record<string, unknown>>(model: SectorModel<S, E, R>, definition: EngineDefinition, state: EngineState<S, E>, provider: DecisionProvider, untilDay: number, maxStepsPerCall: number): StepResult<S, E> {
  let current: EngineState<S, E> = state.status === 'ready' ? { ...state, status: 'running' } : state
  const entries: JournalEntry[] = []
  let steps = 0
  while (current.day < untilDay && current.status === 'running' && steps < maxStepsPerCall) {
    const result = step(model, definition, current, provider)
    current = result.state
    entries.push(...result.entries)
    steps += 1
  }
  return { state: current, entries }
}

/** The same engine, fed the journal's own decisions. Equality with the stored state is the test. */
export function replay<S, E, R extends Record<string, unknown>>(model: SectorModel<S, E, R>, definition: EngineDefinition, initial: EngineState<S, E>, journal: readonly JournalEntry[]): EngineState<S, E> {
  const provider = new RecordedDecisionProvider(journal)
  const lastDay = journal.reduce((max, entry) => Math.max(max, entry.simTime), -1)
  const stepsToReplay = lastDay + 1
  let current: EngineState<S, E> = { ...initial, status: 'running' }
  for (let i = 0; i < stepsToReplay; i++) current = step(model, definition, current, provider).state
  return current
}
