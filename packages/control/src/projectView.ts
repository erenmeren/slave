import { prisma } from '@slave-of-ai/db/client'
import {
  LEAD_SEAT_ROLES,
  LEAD_TEAM_NAME,
  NON_TERMINAL_RUN_STATUSES,
  SUBORDINATE_TOOLS,
  USER_TASK_STATE_FOR_STATUS,
  buildRosterDefinitions,
  doingSentence,
  err,
  ok,
  projectPhaseOf,
  readLeadProgress,
  requirementResultOf,
  type LeadNoteKind,
  type LeadState,
  type ProjectPhase,
  type RequirementResult,
  type Result,
  type StopReason,
  type UserTaskState,
  type WorkspaceFlow,
} from '@slave-of-ai/domain'
import { loadGoalReport } from './goalReport.js'
import { goalSpend, goalWorkedMs } from './lead/spend.js'
import { loadLeadRoster } from './lead/roster.js'
import { leadStatus } from './lead/status.js'
import type { ControlRefusal } from './refusal.js'
import { workspaceSpend } from './spend.js'

/** One face of the Project screen's "Who is working" strip (lead UX design section 6.3). */
export interface WorkingFace {
  /** Stable within a read: the run id, or the subordinate call's own id. */
  readonly id: string
  readonly kind: 'lead' | 'helper' | 'checker'
  readonly name: string
  /** A live stream is on it right now. */
  readonly working: boolean
  /** What it is doing now, in words; null when its stream has said nothing yet. */
  readonly doing: string | null
}

/** One requirement of a build, as the Proof table shows it. */
export interface ProofRow {
  readonly key: string
  readonly text: string
  readonly result: RequirementResult
  /** The newest verdict's reason, check and output; null before any check. */
  readonly reason: string | null
  readonly check: string | null
  readonly output: string | null
  /** How many checks have looked at it. */
  readonly checks: number
}

/** The newest build of a lead-flow project, everything the Project screen draws from it. */
export interface BuildView {
  readonly version: number
  readonly leadState: LeadState | null
  readonly status: 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned'
  readonly stopReason: StopReason | null
  readonly branch: string
  readonly mergeError: string | null
  readonly mergedAt: string | null
  /** The base branch's commit the merge made, when it is recorded. */
  readonly mergeCommit: string | null
  /** Checks run (verification rounds). */
  readonly rounds: number
  /** Null until the requirements were read from the request. */
  readonly proof: readonly ProofRow[] | null
  readonly failing: readonly string[]
  readonly disputed: readonly string[]
  readonly unverifiable: readonly string[]
  readonly faces: readonly WorkingFace[]
  readonly commits: readonly { readonly sha: string; readonly subject: string }[]
  readonly notes: readonly { readonly at: string; readonly kind: LeadNoteKind; readonly detail: string }[]
  readonly spentUsd: number
  /** Part of the spend was not measured: the figure is "at least" (lead-flow C7). */
  readonly spendUnmeasured: boolean
  readonly workedMs: number
}

/** A task of an older (packages-flow) project: section 8 of the design. */
export interface OlderTask {
  readonly id: string
  readonly title: string
  readonly state: UserTaskState
  /** The raw status, for a `title` attribute. */
  readonly status: string
}

/** The Project screen's one read model (lead UX design section 10). */
export interface ProjectView {
  readonly id: string
  readonly name: string
  readonly repoPath: string
  readonly baseBranch: string
  readonly flow: WorkspaceFlow
  readonly archived: boolean
  readonly haltedReason: string | null
  readonly phase: ProjectPhase
  readonly autoMerge: boolean
  readonly budgetUsd: number | null
  readonly timeLimitMs: number | null
  /** The lead's model; null is the runtime's own default (C5). */
  readonly leadModel: string | null
  readonly roster: readonly { readonly id: string; readonly name: string; readonly role: string | null }[]
  /** The newest build's goal text; null before anything was asked for. */
  readonly goal: string | null
  /** The newest build's number (`Workspace.goalVersion`), 0 before the first. */
  readonly goalVersion: number
  /** The newest build with a delivery, in the lead flow; null otherwise. */
  readonly build: BuildView | null
  /** Every build with a delivery, newest first, for the Builds list and the report links. */
  readonly builds: readonly { readonly version: number; readonly leadState: LeadState | null; readonly stopReason: StopReason | null; readonly at: string }[]
  /** The project's spend when it is not the build's (an older project's whole spend). */
  readonly projectSpentUsd: number
  /** An older project's tasks of its newest build, and its pending decisions; null in the lead flow. */
  readonly older: { readonly tasks: readonly OlderTask[]; readonly pendingDecisions: number } | null
}

const STATUSES = ['integrating', 'verifying', 'accepted', 'needs_human', 'abandoned'] as const
const asStatus = (status: string): BuildView['status'] => (STATUSES as readonly string[]).includes(status) ? (status as BuildView['status']) : 'integrating'
const asStopReason = (reason: string | null): StopReason | null => reason as StopReason | null

interface ToolCallRow {
  readonly type: string
  readonly runId: string | null
  readonly payload: unknown
}

interface CallPayload {
  readonly name?: string
  readonly summary?: string
  readonly toolUseId?: string
  readonly subagent?: string
  readonly parentToolUseId?: string
}

/**
 * The faces of one live lead turn: the lead itself, then one helper per subordinate call still
 * open (a top-level call with no result yet), each with its own newest nested call. `events` are
 * the turn's calls and results, newest first. A subordinate's own nested calls carry the
 * `parentToolUseId` of the call that started it (C1).
 */
function leadFaces(runId: string, events: readonly ToolCallRow[], helperName: (slug: string | undefined) => string): readonly WorkingFace[] {
  const finished = new Set(events.filter((row) => row.type === 'run_tool_result').map((row) => (row.payload as CallPayload).toolUseId))
  const calls = events.filter((row) => row.type === 'run_tool_call').map((row) => row.payload as CallPayload)
  const own = calls.find((call) => call.parentToolUseId === undefined)
  const open = calls.filter((call) => call.parentToolUseId === undefined && call.name !== undefined && SUBORDINATE_TOOLS.includes(call.name) && !finished.has(call.toolUseId))
  const helpers = open.reverse().map((call): WorkingFace => {
    const nested = calls.find((one) => one.parentToolUseId !== undefined && one.parentToolUseId === call.toolUseId)
    return {
      id: call.toolUseId ?? `${runId}:${call.summary ?? ''}`,
      kind: 'helper',
      name: helperName(call.subagent),
      working: true,
      doing: nested?.name === undefined ? 'Starting' : doingSentence(nested.name, nested.summary ?? nested.name),
    }
  })
  const waiting = own !== undefined && own.name !== undefined && SUBORDINATE_TOOLS.includes(own.name) && helpers.length > 0
  return [
    {
      id: runId,
      kind: 'lead',
      name: 'Lead',
      working: true,
      doing: own?.name === undefined ? null : waiting ? 'Waiting for its helpers' : doingSentence(own.name, own.summary ?? own.name),
    },
    ...helpers,
  ]
}

/** The newest calls of some runs, newest first: what the faces are doing now. */
async function recentCalls(runIds: readonly string[]): Promise<readonly ToolCallRow[]> {
  if (runIds.length === 0) return []
  return prisma.executionEvent.findMany({
    where: { runId: { in: [...runIds] }, type: { in: ['run_tool_call', 'run_tool_result'] } },
    orderBy: { seq: 'desc' },
    take: 400,
    select: { type: true, runId: true, payload: true },
  })
}

/** The lead flow's newest build, with its proof, its live faces and its limits. */
async function buildView(workspaceId: string, delivery: { readonly id: string; readonly goalVersion: number; readonly leadState: LeadState | null; readonly status: string; readonly stopReason: string | null; readonly integrationBranch: string; readonly mergeError: string | null; readonly mergedAt: Date | null; readonly round: number; readonly leadProgress: unknown }, roster: readonly string[]): Promise<BuildView> {
  const version = delivery.goalVersion
  const [status, report] = await Promise.all([
    delivery.leadState === null ? Promise.resolve(null) : leadStatus(workspaceId, version),
    loadGoalReport(workspaceId, version),
  ])
  const progress = readLeadProgress(delivery.leadProgress)
  const lead = status?.ok === true ? status.value : null
  // `leadStatus` read both already; a build with no lead state yet is read here.
  const spend = lead?.spend ?? (await goalSpend(workspaceId, version))
  const workedMs = lead?.workedMs ?? (await goalWorkedMs(workspaceId, version))

  const requirements = report.ok ? report.value.requirements : null
  const proof =
    requirements === null
      ? null
      : requirements.map((requirement): ProofRow => ({
          key: requirement.key,
          text: requirement.text,
          result: requirementResultOf(requirement.key, requirement.verdict?.status ?? null, progress.disputed),
          reason: requirement.verdict?.reason ?? null,
          check: requirement.verdict?.check ?? null,
          output: requirement.verdict?.output ?? null,
          checks: requirement.history.length,
        }))

  // The faces: the live lead turn and its open helpers, then a live check.
  const slugs = buildRosterDefinitions(await loadLeadRoster(roster)).slugs
  const persons = await prisma.person.findMany({ where: { id: { in: [...slugs.values()] } }, select: { id: true, name: true } })
  const helperName = (slug: string | undefined): string => {
    if (slug === undefined) return 'Helper'
    const personId = slugs.get(slug)
    return persons.find((person) => person.id === personId)?.name ?? slug
  }
  const liveTurn = lead?.turns.find((turn) => turn.endedAt === null) ?? null
  const liveChecks = await prisma.slaveRun.findMany({
    where: { goalDeliveryId: delivery.id, kind: 'verification', status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
    orderBy: { startedAt: 'asc' },
    select: { id: true, confirmsRunId: true },
  })
  const calls = await recentCalls([...(liveTurn === null ? [] : [liveTurn.runId]), ...liveChecks.map((run) => run.id)])
  const faces: WorkingFace[] = []
  if (liveTurn !== null) faces.push(...leadFaces(liveTurn.runId, calls.filter((row) => row.runId === liveTurn.runId), helperName))
  for (const check of liveChecks) {
    const newest = calls.find((row) => row.runId === check.id && row.type === 'run_tool_call')?.payload as CallPayload | undefined
    faces.push({
      id: check.id,
      kind: 'checker',
      name: check.confirmsRunId === null ? 'Checker' : 'Second checker',
      working: true,
      doing: newest?.name === undefined ? null : doingSentence(newest.name, newest.summary ?? newest.name),
    })
  }

  const merge = report.ok ? report.value.delivery?.merge ?? null : null
  return {
    version,
    leadState: delivery.leadState,
    status: asStatus(delivery.status),
    stopReason: asStopReason(delivery.stopReason),
    branch: delivery.integrationBranch,
    mergeError: delivery.mergeError,
    mergedAt: delivery.mergedAt?.toISOString() ?? null,
    mergeCommit: merge?.commit ?? null,
    rounds: delivery.round,
    proof,
    failing: progress.failing,
    disputed: progress.disputed,
    unverifiable: progress.unverifiable,
    faces,
    commits: (lead?.lastCommits ?? []).slice(0, 5).map((line) => {
      const space = line.indexOf(' ')
      return space === -1 ? { sha: line, subject: '' } : { sha: line.slice(0, space), subject: line.slice(space + 1) }
    }),
    notes: (lead?.notes ?? [])
      .slice(-10)
      .reverse()
      .map((note) => ({ at: note.at, kind: note.kind as LeadNoteKind, detail: note.detail })),
    spentUsd: spend.totalUsd,
    spendUnmeasured: spend.unmeasuredRuns > 0,
    workedMs,
  }
}

/**
 * Lead UX design section 10: everything the Project screen shows, in one read -- the project's
 * settings, its phase, its newest build with its proof and who is working on it, its builds, and
 * for an older project its tasks. A read: nothing here writes. Polled every few seconds by the
 * screen, so it reads only the newest build in full.
 */
export async function projectView(workspaceId: string): Promise<Result<ProjectView, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      repoPath: true,
      baseBranch: true,
      flow: true,
      archivedAt: true,
      haltedReason: true,
      autoMerge: true,
      budgetUsd: true,
      goalTimeLimitMs: true,
      leadRoster: true,
      goal: true,
      goalVersion: true,
    },
  })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const [deliveries, leadSeat, rosterRows] = await Promise.all([
    prisma.goalDelivery.findMany({ where: { workspaceId }, orderBy: { goalVersion: 'desc' } }),
    prisma.slave.findFirst({ where: { team: { workspaceId, name: LEAD_TEAM_NAME }, role: LEAD_SEAT_ROLES.lead, closedAt: null }, select: { model: true } }),
    prisma.person.findMany({ where: { id: { in: workspace.leadRoster } }, select: { id: true, name: true, template: { select: { role: true } } } }),
  ])
  const newest = deliveries[0] ?? null
  const phase = projectPhaseOf({
    flow: workspace.flow,
    haltedReason: workspace.haltedReason,
    goalVersion: workspace.goalVersion,
    delivery: newest === null ? null : { goalVersion: newest.goalVersion, leadState: newest.leadState, status: asStatus(newest.status) },
  })

  const build = workspace.flow === 'lead' && newest !== null ? await buildView(workspaceId, newest, workspace.leadRoster) : null

  let older: ProjectView['older'] = null
  let projectSpentUsd = build?.spentUsd ?? 0
  if (workspace.flow === 'packages') {
    const [tasks, pendingDecisions, spend] = await Promise.all([
      prisma.task.findMany({
        where: { workspaceId, ...(workspace.goalVersion === 0 ? {} : { OR: [{ goalVersion: workspace.goalVersion }, { workPackage: { goalVersion: workspace.goalVersion } }] }) },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: { id: true, title: true, status: true, integratedAt: true },
      }),
      prisma.supervisorDecision.count({ where: { workspaceId, status: 'pending' } }),
      workspaceSpend(workspaceId),
    ])
    older = {
      tasks: tasks.map((task) => {
        const base = USER_TASK_STATE_FOR_STATUS[task.status]
        return { id: task.id, title: task.title, status: task.status, state: base === 'done' && task.integratedAt !== null ? 'integrated' : base }
      }),
      pendingDecisions,
    }
    projectSpentUsd = spend.spentUsd
  }

  return ok({
    id: workspace.id,
    name: workspace.name,
    repoPath: workspace.repoPath,
    baseBranch: workspace.baseBranch,
    flow: workspace.flow,
    archived: workspace.archivedAt !== null,
    haltedReason: workspace.haltedReason,
    phase,
    autoMerge: workspace.autoMerge,
    budgetUsd: workspace.budgetUsd,
    timeLimitMs: workspace.goalTimeLimitMs,
    leadModel: leadSeat?.model ?? null,
    roster: workspace.leadRoster.flatMap((id) => {
      const row = rosterRows.find((person) => person.id === id)
      return row === undefined ? [] : [{ id: row.id, name: row.name, role: row.template?.role ?? null }]
    }),
    goal: workspace.goal,
    goalVersion: workspace.goalVersion,
    build,
    builds: deliveries.map((row) => ({ version: row.goalVersion, leadState: row.leadState, stopReason: asStopReason(row.stopReason), at: row.createdAt.toISOString() })),
    projectSpentUsd,
    older,
  })
}
