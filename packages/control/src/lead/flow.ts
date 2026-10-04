import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  LEAD_ROSTER_MAX,
  LEAD_SEAT_ROLES,
  LEAD_TEAM_NAME,
  LEAD_TIME_LIMIT_BOUNDS_MS,
  NON_TERMINAL_RUN_STATUSES,
  PACKAGE_WORKER_ROLE,
  VERIFIER_ROLE,
  err,
  ok,
  type Result,
  type WorkspaceFlow,
} from '@slave-of-ai/domain'
import type { ControlRefusal } from '../refusal.js'
import { MODEL_ID_PATTERN, MODEL_SHAPE_DETAIL } from '../staffing.js'

/** Plan A L2: the three system seats of a lead-flow project, by seat id. */
export interface LeadSeats {
  readonly lead: string
  readonly verifier: string
  readonly confirmer: string
}

/** The project's flow, or null for a project that does not exist. */
export async function workspaceFlow(workspaceId: string): Promise<WorkspaceFlow | null> {
  return (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { flow: true } }))?.flow ?? null
}

/** `Person.name` is unique across the installation: the base name, or the first free ` 2`, ` 3`. */
async function freePersonName(tx: Prisma.TransactionClient, base: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base} ${String(n)}`
    if ((await tx.person.findUnique({ where: { name }, select: { id: true } })) === null) return name
  }
}

/** The project's three open system seats, or null unless all three are there. Reads, never locks. */
async function openLeadSeats(client: Prisma.TransactionClient, workspaceId: string): Promise<LeadSeats | null> {
  const open = await client.slave.findMany({
    where: { team: { workspaceId, name: LEAD_TEAM_NAME }, closedAt: null, role: { in: Object.values(LEAD_SEAT_ROLES) } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true },
  })
  const of = (role: string): string | undefined => open.find((seat) => seat.role === role)?.id
  const lead = of(LEAD_SEAT_ROLES.lead)
  const verifier = of(LEAD_SEAT_ROLES.verifier)
  const confirmer = of(LEAD_SEAT_ROLES.confirmer)
  return lead === undefined || verifier === undefined || confirmer === undefined ? null : { lead, verifier, confirmer }
}

/**
 * The writing half of {@link ensureLeadSeats}, inside the caller's transaction, which holds the
 * workspace row lock already: the team and any missing seat are made, and `model`, when given,
 * moves all three.
 */
async function ensureLeadSeatsIn(tx: Prisma.TransactionClient, workspaceId: string, model: string | undefined): Promise<LeadSeats> {
  const team =
    (await tx.team.findUnique({ where: { workspaceId_name: { workspaceId, name: LEAD_TEAM_NAME } } })) ??
    (await tx.team.create({ data: { workspaceId, name: LEAD_TEAM_NAME } }))
  const seat = async (role: string, runtimeRole: string): Promise<string> => {
    const found = await tx.slave.findFirst({ where: { teamId: team.id, role, closedAt: null }, select: { id: true } })
    if (found !== null) {
      if (model !== undefined) await tx.slave.update({ where: { id: found.id }, data: { model, provider: 'claude_code' } })
      return found.id
    }
    const person = await tx.person.create({ data: { name: await freePersonName(tx, `${role} ${workspaceId.slice(0, 8)}`) } })
    const made = await tx.slave.create({
      // C5: no model unless one is named -- the run then carries no `--model` and the installed
      // CLI's own default is used. Never a provider without its model (M12 Task 7's half-pair).
      data: { teamId: team.id, personId: person.id, role, runtimeRoles: [runtimeRole], ...(model === undefined ? {} : { model, provider: 'claude_code' as const }) },
      select: { id: true },
    })
    return made.id
  }
  return {
    lead: await seat(LEAD_SEAT_ROLES.lead, PACKAGE_WORKER_ROLE),
    verifier: await seat(LEAD_SEAT_ROLES.verifier, VERIFIER_ROLE),
    confirmer: await seat(LEAD_SEAT_ROLES.confirmer, VERIFIER_ROLE),
  }
}

/** Locks the workspace row for the rest of `tx`; false when there is no such row. */
async function lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
  return locked.length > 0
}

/**
 * Plan A L2: the lead, the verifier and the confirmer of a lead-flow project -- three seats with no
 * catalogue persona behind them, in a team of their own, made once. A seat that exists is returned
 * as it is; `model`, when given, is written on all three (the pair with `claude_code`); without
 * it a new seat has no model (C5) and `leadRuntime` runs it on Claude Code with the CLI's default.
 * Three open seats and no model are returned from one read with no lock (it runs every confirmation
 * round); making or moving a seat is serialised on the workspace row, so two callers make one set.
 * The one refusal is returned before the first write, so returning it commits nothing.
 */
export async function ensureLeadSeats(workspaceId: string, model?: string): Promise<Result<LeadSeats, ControlRefusal>> {
  if (model === undefined) {
    const found = await openLeadSeats(prisma, workspaceId)
    if (found !== null) return ok(found)
  }
  return prisma.$transaction(async (tx) => {
    if (!(await lockWorkspace(tx, workspaceId))) return err({ kind: 'workspace_not_found', workspaceId })
    return ok(await ensureLeadSeatsIn(tx, workspaceId, model))
  })
}

/**
 * Task 2 review: an option `setFlow` was given for the flow the project is already in names the
 * verb that does change it, instead of being dropped without a word.
 */
function unchangedFlowOptions(workspaceId: string, flow: WorkspaceFlow, options: { readonly autoMerge?: boolean; readonly model?: string }): string | null {
  const verbs = [
    ...(options.model === undefined ? [] : [`the model with set-lead --workspace ${workspaceId} --model <id>`]),
    ...(options.autoMerge === undefined ? [] : [`automatic merge with set-auto-merge --workspace ${workspaceId} --on|--off`]),
  ]
  return verbs.length === 0 ? null : `the project is already in the ${flow} flow, so nothing was switched; change ${verbs.join(' and ')}`
}

/**
 * Plan A L1: puts a project into the lead flow, or back. Refused while a goal version is open, a
 * run is live or a task of the board is still open: the two flows read the same tables
 * differently, and work must end in the flow it started in. Into `lead`: the project becomes
 * `conducted`, automatic merge goes on (spec D1's default; `autoMerge: false` keeps it off), and
 * its three system seats are made. Back to `packages`: the three seats are closed, so no packages
 * version staffs its verifier from them (`staffVerifier` takes any open verifier seat).
 *
 * One transaction on the locked workspace row, so the daemon cannot open a version or start a run
 * between the checks and the switch. Every refusal is returned before the first write.
 */
export async function setFlow(
  workspaceId: string,
  flow: WorkspaceFlow,
  options: { readonly autoMerge?: boolean; readonly model?: string } = {},
): Promise<Result<{ readonly flow: WorkspaceFlow; readonly changed: boolean }, ControlRefusal>> {
  if (options.model !== undefined && !MODEL_ID_PATTERN.test(options.model)) return err({ kind: 'invalid_model', detail: MODEL_SHAPE_DETAIL })
  return prisma.$transaction(async (tx) => {
    if (!(await lockWorkspace(tx, workspaceId))) return err({ kind: 'workspace_not_found', workspaceId })
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { flow: true } })
    if (workspace.flow === flow) {
      const unchanged = unchangedFlowOptions(workspaceId, flow, options)
      return unchanged === null ? ok({ flow, changed: false }) : err({ kind: 'flow_refused', workspaceId, reason: unchanged })
    }

    const open = await tx.goalDelivery.findFirst({
      where: { workspaceId, status: { not: 'abandoned' }, mergedAt: null },
      orderBy: { goalVersion: 'asc' },
      select: { goalVersion: true },
    })
    if (open !== null) return err({ kind: 'flow_refused', workspaceId, reason: `goal v${String(open.goalVersion)} is still open; merge or abandon it first` })
    const live = await tx.slaveRun.count({ where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId } } } })
    if (live > 0) return err({ kind: 'flow_refused', workspaceId, reason: `${String(live)} run(s) are live; wait for them or stop them first` })
    // A planned board has no goal delivery, and its tasks wait between runs: the conductor's own
    // notion of a live board (`boardIsBusy`), with no version of its own to leave out.
    const tasks = await tx.task.count({
      where: { workspaceId, NOT: [{ status: { in: ['failed', 'cancelled'] } }, { status: 'done', integratedAt: { not: null } }] },
    })
    if (tasks > 0) return err({ kind: 'flow_refused', workspaceId, reason: `${String(tasks)} task(s) are still open; finish or cancel them first` })

    if (flow === 'lead') {
      const claude = await tx.providerConfiguration.findFirst({ where: { workspaceId, kind: 'claude_code' }, select: { id: true } })
      if (claude === null) return err({ kind: 'flow_refused', workspaceId, reason: 'the lead flow runs on Claude Code, and this project has no claude_code provider configured' })
      await ensureLeadSeatsIn(tx, workspaceId, options.model)
      await tx.workspace.update({ where: { id: workspaceId }, data: { flow: 'lead', delivery: 'conducted', autoMerge: options.autoMerge ?? true } })
    } else {
      await tx.slave.updateMany({ where: { team: { workspaceId, name: LEAD_TEAM_NAME }, closedAt: null }, data: { closedAt: new Date(), runtimeRoles: [] } })
      await tx.workspace.update({ where: { id: workspaceId }, data: { flow } })
    }
    return ok({ flow, changed: true })
  })
}

/**
 * Plan A L7/L16: the lead flow's own settings. `timeLimitMs` null clears the limit; `roster` is
 * person ids (unreleased, each once, at most `LEAD_ROSTER_MAX`); `model` moves the three system
 * seats. Everything is checked before anything is written.
 */
export async function setLeadSettings(
  workspaceId: string,
  input: { readonly timeLimitMs?: number | null; readonly roster?: readonly string[]; readonly model?: string },
): Promise<Result<{ readonly timeLimitMs: number | null; readonly roster: readonly string[] }, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { flow: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.flow !== 'lead') return err({ kind: 'not_lead_flow', workspaceId })

  const { min, max } = LEAD_TIME_LIMIT_BOUNDS_MS
  const limit = input.timeLimitMs
  if (limit !== undefined && limit !== null && !(Number.isInteger(limit) && limit >= min && limit <= max && limit % 60_000 === 0)) {
    return err({ kind: 'lead_setting_invalid', field: 'timeLimitMs', rule: `a goal's time limit must be a whole number of minutes from ${String(min / 60_000)} to ${String(max / 60_000)}` })
  }
  if (input.model !== undefined && !MODEL_ID_PATTERN.test(input.model)) return err({ kind: 'invalid_model', detail: MODEL_SHAPE_DETAIL })
  if (input.roster !== undefined) {
    if (input.roster.length > LEAD_ROSTER_MAX || new Set(input.roster).size !== input.roster.length) {
      return err({ kind: 'lead_setting_invalid', field: 'roster', rule: `a roster names at most ${String(LEAD_ROSTER_MAX)} persons, each once` })
    }
    const known = new Set((await prisma.person.findMany({ where: { id: { in: [...input.roster] }, releasedAt: null }, select: { id: true } })).map((p) => p.id))
    const unknown = input.roster.filter((id) => !known.has(id))
    if (unknown.length > 0) return err({ kind: 'lead_setting_invalid', field: 'roster', rule: `no such person in the catalogue: ${unknown.join(', ')}` })
  }

  if (input.model !== undefined) {
    const seats = await ensureLeadSeats(workspaceId, input.model)
    if (!seats.ok) return seats
  }
  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { ...(limit === undefined ? {} : { goalTimeLimitMs: limit }), ...(input.roster === undefined ? {} : { leadRoster: [...input.roster] }) },
    select: { goalTimeLimitMs: true, leadRoster: true },
  })
  return ok({ timeLimitMs: updated.goalTimeLimitMs, roster: updated.leadRoster })
}
