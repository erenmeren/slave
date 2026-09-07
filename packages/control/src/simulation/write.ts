import { Prisma, prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import {
  RulesDecisionProvider, cloneDefinition, demoDefinition, runUntil, tradeExternalEventSchema, tradeInitialEngineState, tradeModel,
} from '@slave-of-ai/simulation'
import { isUniqueConstraintViolation } from '../prisma-errors.js'
import type { Principal } from '../principal.js'
import type { ControlRefusal } from '../refusal.js'
import {
  MAX_STEPS_PER_REQUEST, SUPPORTED, clearAutoRun, json, journalRows, locked, namespacedKey, type LoadedSimulation, type Row,
} from './shared.js'
import { loadSimulation } from './read.js'

/** The one guard both `createSimulation` and `cloneSimulation` run before touching the database:
 *  an empty (or all-whitespace) name, or a seed that isn't an integer. */
function validateNameAndSeed(name: string, seed: number | undefined): ControlRefusal | null {
  if (name.trim() === '') return { kind: 'invalid_simulation_input', detail: 'name must not be empty' }
  if (seed !== undefined && !Number.isInteger(seed)) return { kind: 'invalid_simulation_input', detail: 'seed must be an integer' }
  return null
}

type ValidatedLlmInput = { readonly modelProvider: 'claude_code'; readonly model: string; readonly maxModelCostUsd: number }

/** `createSimulation`'s `decisionProvider: 'llm'` guard (M31a §3): `modelProvider` must be
 *  `claude_code` -- `cursor` gets its own reason (it reports no cost, so a cap can never be
 *  enforced), anything else is simply not a provider this ever configures -- then `model` a
 *  non-empty text and `maxModelCostUsd` a positive finite number. Returns the trimmed, narrowed
 *  values a `rules` run never needs to carry. */
function validateLlmInput(input: { readonly modelProvider?: string; readonly model?: string; readonly maxModelCostUsd?: number }): Result<ValidatedLlmInput, ControlRefusal> {
  if (input.modelProvider === undefined) return err({ kind: 'invalid_simulation_input', detail: 'modelProvider is required for an llm run' })
  if (input.modelProvider === 'cursor') return err({ kind: 'unsupported_model_provider', provider: 'cursor', reason: 'it reports no cost, so a cap cannot be enforced' })
  if (input.modelProvider !== 'claude_code') return err({ kind: 'unsupported_model_provider', provider: input.modelProvider, reason: 'it is not a configured provider' })
  const model = input.model?.trim()
  if (model === undefined || model === '') return err({ kind: 'invalid_simulation_input', detail: 'model is required for an llm run' })
  if (input.maxModelCostUsd === undefined || !Number.isFinite(input.maxModelCostUsd) || input.maxModelCostUsd <= 0) return err({ kind: 'invalid_simulation_input', detail: 'maxModelCostUsd must be a positive number' })
  return ok({ modelProvider: 'claude_code', model, maxModelCostUsd: input.maxModelCostUsd })
}

/** The one insert both `createSimulation` and `cloneSimulation` make: the row plus its seq-0
 *  `created` journal row, with the unique-name violation turned into the typed refusal. */
async function insertRun(
  data: Omit<Prisma.SimulationRunUncheckedCreateInput, 'journal' | 'name'> & { readonly name: string },
  createdPayload: Prisma.InputJsonValue,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  try {
    const row = await prisma.simulationRun.create({ data: { ...data, journal: { create: { seq: 0, simTime: 0, kind: 'control', actorRole: null, payload: createdPayload } } } })
    return ok({ id: row.id })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name: data.name })
    throw error
  }
}

export async function createSimulation(
  input: {
    readonly companyId: string
    readonly name: string
    readonly sector: 'trade'
    readonly mode?: 'simulation'
    readonly policy: 'A' | 'B'
    readonly seed?: number
    readonly scenario?: 'demo'
    /** M31a §3: which decides the run's actions. Defaults to `rules` -- the M29/M30 behaviour --
     *  so every existing caller is unaffected. */
    readonly decisionProvider?: 'rules' | 'llm'
    readonly modelProvider?: 'claude_code' | 'cursor'
    readonly model?: string
    readonly maxModelCostUsd?: number
  },
  principal?: Principal,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  const mode = input.mode ?? 'simulation'
  if (!SUPPORTED.has(`${input.sector}:${mode}`)) return err({ kind: 'unsupported_simulation', sector: input.sector, mode })
  const invalid = validateNameAndSeed(input.name, input.seed)
  if (invalid !== null) return err(invalid)
  const decisionProvider = input.decisionProvider ?? 'rules'
  // Validated (and its `modelProvider`/`model` trimmed and narrowed) only for an `llm` run -- a
  // `rules` run ignores these fields entirely rather than validating input it will never use.
  let llm: ValidatedLlmInput | null = null
  if (decisionProvider === 'llm') {
    const validated = validateLlmInput(input)
    if (!validated.ok) return validated
    llm = validated.value
  }
  const company = await prisma.company.findUnique({ where: { id: input.companyId }, include: { teams: { orderBy: { name: 'asc' }, include: { slaves: { orderBy: { name: 'asc' } } } } } })
  if (company === null) return err({ kind: 'company_not_found', companyId: input.companyId })
  const roster = company.teams.flatMap((team) => team.slaves.map((slave) => ({ slaveName: slave.name, departmentName: team.name })))
  if (roster.length < 4) return err({ kind: 'roster_too_small', companyId: company.id, needed: 4, have: roster.length })
  const seed = input.seed ?? 1
  const llmRoles = decisionProvider === 'llm' ? ['purchasing'] : []
  const definition = demoDefinition({ policy: input.policy, seed, roster, currency: 'USD', llmRoles })
  const state = tradeInitialEngineState(definition)
  return insertRun(
    {
      companyId: company.id, name: input.name.trim(), sector: 'trade', mode: 'simulation', decisionProvider, seed, definition: json(definition), state: json(state), createdByUserId: principal?.userId ?? null,
      modelProvider: llm?.modelProvider ?? null, model: llm?.model ?? null, maxModelCostUsd: llm?.maxModelCostUsd ?? null,
    },
    { op: 'created', policy: input.policy, seed, synthetic: true },
  )
}

/** Clones a run from its frozen definition (spec M30 §2.3): a fresh row at day 0, the same
 *  scenario and roster, only the policy and (optionally) the seed replaced. Carries no injected
 *  event and no journal from the source -- only its own single `created` control row. */
export async function cloneSimulation(
  sourceId: string,
  input: { readonly name: string; readonly policy: 'A' | 'B'; readonly seed?: number },
  principal?: Principal,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  const invalid = validateNameAndSeed(input.name, input.seed)
  if (invalid !== null) return err(invalid)
  const source = await loadSimulation(sourceId)
  if (!source.ok) return source
  const seed = input.seed ?? source.value.definition.seed
  // Controller ruling R4: a clone never inherits paid use -- the row below already forces
  // `decisionProvider: 'rules'` and null model columns, so the frozen definition must not still
  // claim a role decides with a model.
  const definition = { ...cloneDefinition(source.value.definition, { policy: input.policy, seed }), llmRoles: [] }
  const state = tradeInitialEngineState(definition)
  return insertRun(
    { companyId: source.value.summary.companyId, name: input.name.trim(), sector: 'trade', mode: 'simulation', decisionProvider: 'rules', seed, definition: json(definition), state: json(state), clonedFromId: sourceId, createdByUserId: principal?.userId ?? null },
    { op: 'created', policy: input.policy, seed, synthetic: true, clonedFrom: sourceId },
  )
}

/** The one step body (spec M30 §2.1): the button, the CLI and the daemon's auto-run all come
 *  through here, inside the caller's row lock. Runs the engine from `loaded.state` to `untilDay`
 *  (bounded by the horizon and MAX_STEPS_PER_REQUEST), writes the journal rows, the `stepped`
 *  control row and the run row, and clears an auto-run intent when the run finished or halted. */
export async function stepLocked(
  tx: Prisma.TransactionClient,
  row: Row,
  loaded: LoadedSimulation,
  input: { readonly untilDay: number; readonly idempotencyKey?: string; readonly lastAutoStepAt?: Date },
): Promise<{ readonly day: number; readonly status: string; readonly version: number; readonly entries: number }> {
  const provider = new RulesDecisionProvider(loaded.definition)
  const result = runUntil(tradeModel, loaded.definition, loaded.state, provider, Math.min(input.untilDay, loaded.definition.horizonDays), MAX_STEPS_PER_REQUEST)
  const version = row.version + 1
  const status = result.state.status
  const controlSeq = result.state.journalSeq + 1
  const outcome = { day: result.state.day, status, version, entries: result.entries.length }
  await tx.simulationJournalEntry.createMany({ data: journalRows(row.id, result.entries) })
  await tx.simulationJournalEntry.create({
    data: { simulationId: row.id, seq: controlSeq, simTime: result.state.day, kind: 'control', actorRole: null, idempotencyKey: input.idempotencyKey !== undefined ? namespacedKey('step', input.idempotencyKey) : null, payload: { op: 'stepped', ...outcome } },
  })
  // Spec §4: a run that finished or halted drops its auto-run intent in the same transaction.
  const stopped = status === 'finished' || status === 'halted'
  const seqAfter = stopped ? await clearAutoRun(tx, row, { ...loaded, state: { ...result.state, journalSeq: controlSeq } }, status, controlSeq + 1) : controlSeq
  await tx.simulationRun.update({
    where: { id: row.id },
    data: {
      state: json({ ...result.state, journalSeq: seqAfter }), version, status, simTime: result.state.day, stepCount: result.state.stepCount, actionCount: result.state.decisionCount, haltedReason: result.state.haltedReason,
      ...(input.lastAutoStepAt !== undefined ? { lastAutoStepAt: input.lastAutoStepAt } : {}),
      ...(stopped ? { autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null } : {}),
    },
  })
  return outcome
}

export async function stepSimulation(
  simulationId: string,
  input: { readonly steps?: number; readonly untilDay?: number; readonly idempotencyKey?: string; readonly expectedVersion?: number },
  _principal?: Principal,
): Promise<Result<{ readonly day: number; readonly status: string; readonly version: number; readonly entries: number; readonly replayed: boolean }, ControlRefusal>> {
  // M31a §3: an `llm` run's steps happen in the daemon (auto-run), never through this manual verb
  // -- checked with a plain unlocked read, before any lock is taken or anything is written. A
  // `simulationId` no row carries falls through to the usual `simulation_not_found` from `locked`
  // inside the transaction below, rather than being special-cased here.
  const providerRow = await prisma.simulationRun.findUnique({ where: { id: simulationId }, select: { decisionProvider: true } })
  if (providerRow !== null && providerRow.decisionProvider === 'llm') return err({ kind: 'llm_steps_in_daemon', simulationId })
  if (input.steps !== undefined && (!Number.isInteger(input.steps) || input.steps < 1)) return err({ kind: 'invalid_simulation_input', detail: 'steps must be a positive integer' })
  if (input.untilDay !== undefined && (!Number.isInteger(input.untilDay) || input.untilDay < 0)) return err({ kind: 'invalid_simulation_input', detail: 'untilDay must be a non-negative integer' })
  // A full-horizon `runUntil` (up to `MAX_STEPS_PER_REQUEST` days) plus a `createMany` of
  // thousands of journal rows can outrun Prisma's 5 s interactive-transaction default and throw
  // P2028 (fix round 1, Important #2) -- a real-size request needs real headroom.
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (input.idempotencyKey !== undefined) {
      const seen = await tx.simulationJournalEntry.findUnique({ where: { simulationId_idempotencyKey: { simulationId, idempotencyKey: namespacedKey('step', input.idempotencyKey) } } })
      if (seen !== null) {
        const p = seen.payload as { day?: number; status?: string; version?: number; entries?: number }
        return ok({ day: p.day ?? row.simTime, status: p.status ?? row.status, version: p.version ?? row.version, entries: p.entries ?? 0, replayed: true })
      }
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) return err({ kind: 'stale_version', simulationId, expected: input.expectedVersion, actual: row.version })
    if (row.status !== 'ready' && row.status !== 'running') return err({ kind: 'simulation_not_runnable', simulationId, status: row.status })
    const untilDay = input.untilDay ?? loaded.state.day + (input.steps ?? 1)
    // A no-op step (untilDay at or before the current day) is refused before the engine ever
    // runs, not journaled as a zero-entry step (fix wave, Important #1) -- only the explicit
    // `untilDay` path can trip this, since `steps` always resolves to `day + steps > day`.
    if (untilDay <= loaded.state.day) return err({ kind: 'invalid_simulation_input', detail: `untilDay must be greater than the current day (${loaded.state.day})` })
    const outcome = await stepLocked(tx, row, loaded, { untilDay, ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}) })
    return ok({ ...outcome, replayed: false })
  }, { timeout: 60_000, maxWait: 10_000 })
}

async function setStatus(simulationId: string, from: readonly string[], to: 'paused' | 'running' | 'halted', op: string, haltedReason: string | null): Promise<Result<void, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (!from.includes(row.status)) return err({ kind: 'simulation_not_runnable', simulationId, status: row.status })
    const seq = loaded.state.journalSeq + 1
    await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'control', actorRole: null, payload: { op, reason: haltedReason } } })
    // Spec §4: pausing or halting drops any auto-run intent in the same transaction; resuming
    // never re-arms one (an operator restarts auto-run explicitly).
    const seqAfter = to === 'running' ? seq : await clearAutoRun(tx, row, loaded, to === 'paused' ? 'paused' : 'halted', seq + 1)
    await tx.simulationRun.update({
      where: { id: simulationId },
      data: {
        status: to, haltedReason,
        // A halt writes its reason into the embedded engine state too, not just the row column
        // (fix wave, Minor #5) -- a replay or an in-process reader of `state` alone must see it.
        state: json({ ...loaded.state, journalSeq: seqAfter, status: to === 'paused' ? loaded.state.status : to, ...(to === 'halted' ? { haltedReason } : {}) }),
        ...(to !== 'running' ? { autoRunEveryMs: null, autoRunUntilDay: null, lastAutoStepAt: null } : {}),
      },
    })
    return ok(undefined)
  })
}

export const pauseSimulation = (id: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> => setStatus(id, ['ready', 'running'], 'paused', 'paused', null)
export const resumeSimulation = (id: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> => setStatus(id, ['paused'], 'running', 'resumed', null)
/** The emergency stop. Stepping is in-request, so nothing is in flight to kill: this blocks every
 *  next step (and, in M31, every model call). */
export const haltSimulation = (id: string, reason: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> => setStatus(id, ['ready', 'running', 'paused'], 'halted', 'halted', reason)

export async function injectExternalEvent(
  simulationId: string,
  input: { readonly day: number; readonly event: unknown; readonly idempotencyKey?: string },
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const parsed = tradeExternalEventSchema.safeParse(input.event)
  if (!parsed.success) return err({ kind: 'invalid_simulation_input', detail: `event: ${parsed.error.issues[0]?.message ?? 'not an external event'}` })
  return prisma.$transaction(async (tx) => {
    const got = await locked(tx, simulationId)
    if (!got.ok) return got
    const { row, loaded } = got.value
    if (row.status !== 'ready' && row.status !== 'running') return err({ kind: 'simulation_not_runnable', simulationId, status: row.status })
    if (!Number.isInteger(input.day) || input.day < loaded.state.day) return err({ kind: 'invalid_simulation_input', detail: `day must be an integer ≥ the current day (${loaded.state.day})` })
    if (input.idempotencyKey !== undefined) {
      const seen = await tx.simulationJournalEntry.findUnique({ where: { simulationId_idempotencyKey: { simulationId, idempotencyKey: namespacedKey('inject', input.idempotencyKey) } } })
      if (seen !== null) return ok(undefined)
    }
    const queue = loaded.state.queue
    const item = { time: input.day, priority: 'external' as const, seq: queue.nextSeq, event: parsed.data }
    // `state.journalSeq` can lag the journal's real `max(seq)` -- a throw-path `haltUnparsed`
    // (M30 §5) never rewrites `state` (the corrupt JSON is left as evidence), so a run halted that
    // way keeps a stale `journalSeq`. Reading `max(seq) + 1` fresh, inside this same lock, is the
    // only value that is always correct; `loaded.state.journalSeq + 1` is not (fix round 1,
    // Important #1). The `ready`/`running` guard above makes a halted row unreachable here too,
    // but the seq is computed the safe way regardless of which guard a future change might loosen.
    const last = await tx.simulationJournalEntry.findFirst({ where: { simulationId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    const seq = (last?.seq ?? -1) + 1
    await tx.simulationJournalEntry.create({ data: { simulationId, seq, simTime: row.simTime, kind: 'external_event', actorRole: null, idempotencyKey: input.idempotencyKey !== undefined ? namespacedKey('inject', input.idempotencyKey) : null, payload: { op: 'injected', day: input.day, event: json(parsed.data) } } })
    await tx.simulationRun.update({ where: { id: simulationId }, data: { state: json({ ...loaded.state, journalSeq: seq, queue: { items: [...queue.items, item], nextSeq: queue.nextSeq + 1 } }) } })
    return ok(undefined)
  })
}

export async function deleteSimulation(simulationId: string, _principal?: Principal): Promise<Result<void, ControlRefusal>> {
  const { count } = await prisma.simulationRun.deleteMany({ where: { id: simulationId } })
  return count === 0 ? err({ kind: 'simulation_not_found', simulationId }) : ok(undefined)
}
