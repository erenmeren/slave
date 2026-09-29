import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import {
  GOAL_REPORT_DETAIL_MAX_CHARS,
  GOAL_REPORT_TRAIL_MAX,
  type GOAL_REPORT_ANSWERED_BY,
  SITUATION_LABEL,
  trimEvidence,
  type GoalReportAuthor,
  type GoalReportQuestion,
  type GoalReportTrailEntry,
  type SituationKind,
} from '@slave-of-ai/domain'

/** What every part of a version's report is scoped by: its package tasks (with the package key
 *  and the current seat), its delivery, and its verifier (plan D6). */
export interface VersionScope {
  readonly workspaceId: string
  readonly goalVersion: number
  readonly deliveryId: string | null
  /** `Workspace.baseBranch`: where a package of a version with no delivery merged (final wave I1). */
  readonly baseBranch: string
  /** `integrated`: `Task.integratedAt` is set (round 2 X2: a pre-delivery task done without it was
   *  marked done with `autoMerge` off, with no git merge). */
  readonly tasks: readonly { readonly taskId: string; readonly packageKey: string; readonly seat: string | null; readonly integrated: boolean }[]
  readonly verifier: string | null
}

/** Plan D5: the Supervisor subjects that are about this version -- exactly `<ws>:v<n>` (the conduct
 *  decision) or anything under `<ws>:v<n>:` (per round, per stop). A bare `startsWith('<ws>:v1')`
 *  would also take v10's. */
export function versionSubject(workspaceId: string, goalVersion: number): { readonly equals: string; readonly prefix: string } {
  const equals = `${workspaceId}:v${String(goalVersion)}`
  return { equals, prefix: `${equals}:` }
}

/** `slaveId -> the person's name`, for every id given; a seat that is gone is simply absent. */
export async function seatNames(slaveIds: readonly (string | null)[]): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(slaveIds.filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  const rows = await prisma.slave.findMany({ where: { id: { in: ids } }, select: { id: true, person: { select: { name: true } } } })
  return new Map(rows.map((row) => [row.id, row.person.name] as const))
}

export async function loadVersionScope(workspaceId: string, goalVersion: number): Promise<VersionScope> {
  const [workspace, packages, delivery] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { baseBranch: true } }),
    prisma.workPackage.findMany({
      where: { workspaceId, goalVersion },
      select: { key: true, tasks: { select: { id: true, assigneeId: true, integratedAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    }),
    prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { id: true, verifierSlaveId: true } }),
  ])
  const tasks = packages
    .flatMap((pkg) => pkg.tasks.map((task) => ({ taskId: task.id, packageKey: pkg.key, assigneeId: task.assigneeId, integrated: task.integratedAt !== null })))
    .sort((a, b) => (a.packageKey < b.packageKey ? -1 : a.packageKey > b.packageKey ? 1 : a.taskId < b.taskId ? -1 : 1))
  const names = await seatNames([...tasks.map((task) => task.assigneeId), delivery?.verifierSlaveId ?? null])
  return {
    workspaceId,
    goalVersion,
    deliveryId: delivery?.id ?? null,
    baseBranch: workspace?.baseBranch ?? 'the base branch',
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      packageKey: task.packageKey,
      seat: task.assigneeId === null ? null : (names.get(task.assigneeId) ?? null),
      integrated: task.integrated,
    })),
    verifier: delivery?.verifierSlaveId == null ? null : (names.get(delivery.verifierSlaveId) ?? null),
  }
}

const TASK_TRAIL_TYPES = [
  'task_started',
  'task_verify_failed',
  'task_review_rejected',
  'task_review_approved',
  'task_ownership_violated',
  'task_merge_failed',
  'task_rework',
  'task_done',
  'task_integrated',
  'task_failed',
  'task_cancelled',
] as const

const VERSION_TRAIL_TYPES = [
  'workspace_goal_set',
  'workspace_requirements_set',
  'workspace_conducted',
  'workspace_goal_waiting',
  'workspace_verification_started',
  'workspace_verified',
  'workspace_goal_accepted',
  'workspace_goal_needs_human',
  'workspace_goal_retried',
  'workspace_goal_merged',
  'workspace_goal_abandoned',
] as const

type Payload = Record<string, unknown>
const str = (p: Payload, key: string): string | null => (typeof p[key] === 'string' && p[key] !== '' ? (p[key] as string) : null)
const num = (p: Payload, key: string): number => (typeof p[key] === 'number' ? (p[key] as number) : 0)
const strs = (p: Payload, key: string): readonly string[] => (Array.isArray(p[key]) ? (p[key] as unknown[]).filter((v): v is string => typeof v === 'string') : [])
const times = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`

interface Draft {
  readonly text: string
  readonly detail?: string | null
  readonly detailBy?: GoalReportAuthor
}

/** One event as a trail sentence (plan D6), or null for a payload this build cannot read. The
 *  sentences name ids, keys and counts only; free text goes in `detail`, labelled. */
function eventDraft(type: DomainEventType, p: Payload, pkg: string | null, mergesInto: string, mergedBySlave: boolean): Draft | null {
  const on = pkg === null ? '' : `${pkg}: `
  switch (type) {
    case 'workspace.goal_set': {
      const request = str(p, 'request')
      return request === null ? { text: 'The goal was set.' } : { text: 'The goal was set from a change request.', detail: request, detailBy: 'person' }
    }
    case 'workspace.requirements_set':
      return { text: `${times(num(p, 'count'), 'requirement was', 'requirements were')} extracted from the goal.` }
    case 'workspace.conducted': {
      const packages = strs(p, 'packages')
      const what = str(p, 'mode') === 'single' ? 'one package does the whole goal' : `partitioned into ${String(packages.length)} packages (${packages.join(', ')})`
      return { text: `Size decision: ${what}${p['fallback'] === true ? ", by default, because the conductor's answers were unusable" : ''}.` }
    }
    case 'workspace.goal_waiting':
      return { text: typeof p['waitingOn'] === 'number' ? `Waited for goal v${String(p['waitingOn'])} to reach the base branch.` : "Waited for the planner's board to go quiet." }
    case 'workspace.verification_started':
      return { text: `Verification round ${String(num(p, 'round'))} started.` }
    case 'workspace.verified': {
      const failed = strs(p, 'failedKeys')
      return {
        text:
          `Verification round ${String(num(p, 'round'))}: ${String(num(p, 'pass'))} pass, ${String(num(p, 'fail'))} fail, ` +
          `${String(num(p, 'unverifiable'))} unverifiable${failed.length === 0 ? '' : ` (failing: ${failed.join(', ')})`}.`,
      }
    }
    case 'workspace.goal_accepted':
      return { text: `Accepted: every requirement passed, after ${times(num(p, 'rounds'), 'round', 'rounds')}.` }
    case 'workspace.goal_needs_human':
      return { text: 'Stopped for a person.', detail: str(p, 'reason'), detailBy: 'system' }
    case 'workspace.goal_retried':
      return {
        text:
          p['cause'] === 'branch_moved'
            ? `The integration branch moved after acceptance; verifying again after round ${String(num(p, 'round'))}.`
            : `A person sent it round again after round ${String(num(p, 'round'))}.`,
      }
    case 'workspace.goal_merged': {
      const commit = (str(p, 'commit') ?? '').slice(0, 12)
      return { text: `Merged into ${str(p, 'into') ?? 'the base branch'}${p['by'] === 'human' ? ' by a person' : ''} (commit ${commit}).` }
    }
    case 'workspace.goal_abandoned':
      return { text: `Abandoned by a person; ${times(strs(p, 'cancelled').length, 'package task', 'package tasks')} cancelled.` }
    case 'guardrail.tripped':
      return { text: `Waiting: ${str(p, 'detail') ?? ''}` }
    case 'task.started':
      return { text: `${on}work started.` }
    case 'task.verify_failed':
      return { text: `${on}the verify command ${str(p, 'command') ?? '?'} exited ${String(num(p, 'exitCode'))}${str(p, 'stage') === null ? '' : ` (stage ${str(p, 'stage') ?? ''})`}.` }
    case 'task.review_rejected':
      return { text: `${on}the review rejected the work (attempt ${String(num(p, 'attempt'))}).`, detail: str(p, 'reason'), detailBy: 'model' }
    case 'task.review_approved':
      return { text: `${on}the review approved the work.` }
    case 'task.ownership_violated': {
      const files = strs(p, 'files')
      const total = num(p, 'total')
      return { text: `${on}the run changed ${times(total, 'file', 'files')} its package does not own: ${files.slice(0, 10).join(', ')}${total > 10 ? ', …' : ''}.` }
    }
    case 'task.merge_failed':
      return { text: `${on}the merge failed.`, detail: str(p, 'reason'), detailBy: 'system' }
    case 'task.rework': {
      const round = num(p, 'verificationRound')
      // A verification rework's reason quotes the verifier's check, output and reason: the model's.
      return round > 0
        ? { text: `${on}sent back for rework by verification round ${String(round)}.`, detail: str(p, 'reason'), detailBy: 'model' }
        : { text: `${on}sent back for rework (attempt ${String(num(p, 'attempt'))}).`, detail: str(p, 'reason'), detailBy: 'system' }
    }
    case 'task.done': {
      // Round 2 X2: merge.ts's `autoMerge`-off path (a version with no delivery) writes this event
      // with no git merge.
      if (!mergedBySlave) return { text: `${on}done; auto-merge was off, so Slave did not merge it into ${mergesInto}.` }
      const files = typeof p['filesTotal'] === 'number' ? ` (${times(num(p, 'filesTotal'), 'file', 'files')})` : ''
      return { text: `${on}merged into ${mergesInto}${files}.` }
    }
    case 'task.integrated':
      // `confirmIntegration`: a person merged the branch by hand and said so.
      return { text: `${on}confirmed merged into ${mergesInto} by a person.` }
    case 'task.failed':
      return { text: `${on}failed.`, detail: str(p, 'reason'), detailBy: 'system' }
    case 'task.cancelled':
      return { text: `${on}cancelled.`, detail: str(p, 'reason'), detailBy: 'system' }
    default:
      return null
  }
}

const entryOf = (at: Date, draft: Draft, packageKey: string | null): GoalReportTrailEntry => {
  const detail = draft.detail ?? null
  return {
    at: at.toISOString(),
    text: draft.text,
    detail: detail === null ? null : trimEvidence(detail, GOAL_REPORT_DETAIL_MAX_CHARS),
    detailBy: detail === null ? null : (draft.detailBy ?? 'system'),
    packageKey,
  }
}

/** A trail entry before it is placed, with the time it is placed by. */
interface Timed {
  readonly at: Date
  readonly entry: GoalReportTrailEntry
}

/**
 * The version's decision trail (plan D6), oldest first. Its events keep their `seq` order even
 * where a clock disagrees (ruling R5: `seq` is the one order the event log guarantees); its failed
 * conductor calls and its Supervisor decisions are sorted by time and merged in between them,
 * events first on a tie. The decisions are the ones about the version (plan D5's rule, the same set
 * `versionSpend` charges, ruling R4): its subject, its package tasks and its `questionIds`, minus
 * the conduct decision, whose rationale rides on the `workspace.conducted` entry, followed by one
 * staffing entry. Only the newest `max` entries are kept, and `omitted` counts the rest.
 */
export async function versionTrail(
  scope: VersionScope,
  questionIds: readonly string[],
  max: number = GOAL_REPORT_TRAIL_MAX,
): Promise<{ readonly entries: readonly GoalReportTrailEntry[]; readonly omitted: number }> {
  const { workspaceId, goalVersion } = scope
  // Final wave I1: a version with no delivery was conducted before integration branches, and its
  // packages merge straight into the base branch.
  const mergesInto = scope.deliveryId === null ? scope.baseBranch : 'the integration branch'
  const keyOf = new Map(scope.tasks.map((task) => [task.taskId, task.packageKey] as const))
  const taskIds = [...keyOf.keys()]
  const subject = versionSubject(workspaceId, goalVersion)
  const [events, calls, decisions, conduct] = await Promise.all([
    prisma.executionEvent.findMany({
      where: {
        workspaceId,
        OR: [
          { taskId: { in: taskIds }, type: { in: [...TASK_TRAIL_TYPES] } },
          { type: { in: [...VERSION_TRAIL_TYPES] }, payload: { path: ['version'], equals: goalVersion } },
          // The goal pass's own trips name the version first (`goal v<n> is accepted ...`, `goal v<n> could not be merged ...`).
          // The trailing space keeps v1 from matching `goal v10 ...`.
          { type: 'guardrail_tripped', payload: { path: ['detail'], string_starts_with: `goal v${String(goalVersion)} ` } },
        ],
      },
      orderBy: { seq: 'asc' },
      select: { ts: true, type: true, taskId: true, payload: true },
    }),
    prisma.conductorCall.findMany({
      where: { workspaceId, goalVersion, outcome: 'failed' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { stage: true, reason: true, createdAt: true },
    }),
    prisma.supervisorDecision.findMany({
      where: {
        workspaceId,
        situationKind: { not: 'conduct' },
        OR: [{ subjectId: subject.equals }, { subjectId: { startsWith: subject.prefix } }, { subjectId: { in: [...taskIds, ...questionIds] } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { situationKind: true, action: true, rationale: true, status: true, decidedBy: true, createdAt: true },
    }),
    prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'conduct', subjectId: subject.equals },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { rationale: true, decidedBy: true },
    }),
  ])

  // Round 2 X2: with no delivery, a package task Slave merged has `integratedAt` and no
  // `task.integrated` event; one marked done with `autoMerge` off has neither, or (once a person
  // confirmed a hand merge) the event. Either way its `task.done` was not a merge by Slave. With a
  // delivery, every `task.done` is merge.ts's merge into the integration branch.
  const confirmed = new Set(events.filter((row) => row.type === 'task_integrated' && row.taskId !== null).map((row) => row.taskId as string))
  const handMerged = new Set(
    scope.deliveryId !== null ? [] : scope.tasks.filter((task) => !task.integrated || confirmed.has(task.taskId)).map((task) => task.taskId),
  )
  const byEvent: Timed[] = []
  for (const row of events) {
    const type = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType)
    const pkg = row.taskId === null ? null : (keyOf.get(row.taskId) ?? null)
    const draft = eventDraft(type, (row.payload ?? {}) as Payload, pkg, mergesInto, row.taskId === null || !handMerged.has(row.taskId))
    if (draft === null) continue
    if (type === 'workspace.conducted') {
      const fallback = (row.payload as Payload)['fallback'] === true
      const withReason: Draft = conduct === null ? draft : { ...draft, detail: conduct.rationale, detailBy: fallback || conduct.decidedBy !== 'model' ? 'system' : 'model' }
      byEvent.push({ at: row.ts, entry: entryOf(row.ts, withReason, null) })
      const seats = scope.tasks.map((task) => `${task.packageKey} by ${task.seat ?? 'nobody'}`).join(', ')
      const staffing = `Staffed: ${seats === '' ? 'no package' : seats}; ${scope.verifier === null ? 'no verifier recorded' : `verified by ${scope.verifier}`}.`
      byEvent.push({ at: row.ts, entry: entryOf(row.ts, { text: staffing }, null) })
      continue
    }
    byEvent.push({ at: row.ts, entry: entryOf(row.ts, draft, pkg) })
  }
  // Calls before decisions on a tie; each list is already in time order, and `sort` is stable.
  const byTime: Timed[] = [
    ...calls.map((call): Timed => ({ at: call.createdAt, entry: entryOf(call.createdAt, { text: `The conductor's ${call.stage} call failed.`, detail: call.reason, detailBy: 'system' }, null) })),
    ...decisions.map((row): Timed => {
      const kind = (row.action as { readonly kind?: unknown } | null)?.kind
      const label = SITUATION_LABEL[row.situationKind as SituationKind] ?? row.situationKind
      const text = `Supervisor: ${label}; ${typeof kind === 'string' ? kind.replaceAll('_', ' ') : 'an unreadable action'} (${row.status}${row.decidedBy === 'model' ? ', decided by the model' : ''}).`
      return { at: row.createdAt, entry: entryOf(row.createdAt, { text, detail: row.rationale, detailBy: row.decidedBy === 'model' ? 'model' : 'system' }, null) }
    }),
  ].sort((a, b) => a.at.getTime() - b.at.getTime())

  // Merge: before each event, everything strictly older than it; the rest after the last event.
  const all: GoalReportTrailEntry[] = []
  let next = 0
  for (const event of byEvent) {
    while (next < byTime.length && (byTime[next] as Timed).at.getTime() < event.at.getTime()) all.push((byTime[next++] as Timed).entry)
    all.push(event.entry)
  }
  for (; next < byTime.length; next += 1) all.push((byTime[next] as Timed).entry)
  const omitted = Math.max(0, all.length - max)
  return { entries: all.slice(omitted), omitted }
}

/** An answer row's `actor` as the report's answerer. Keyed to `GOAL_REPORT_ANSWERED_BY` (ruling R6:
 *  the words live there once), and total over the `Actor` enum, so a new actor fails the build. */
const ANSWERED_BY: Readonly<Record<'human' | 'system' | 'slave', keyof typeof GOAL_REPORT_ANSWERED_BY>> = { human: 'person', system: 'supervisor', slave: 'slave' }

/** Every question on the version's package tasks, oldest first, with its first answer (plan D6).
 *  Who answered comes from the answer row's `actor`: `human` is a person, `system` the Supervisor's
 *  sourced answer path, `slave` a seat's `<slave-answer>`. */
export async function versionQuestions(scope: VersionScope): Promise<readonly GoalReportQuestion[]> {
  const keyOf = new Map(scope.tasks.map((task) => [task.taskId, task.packageKey] as const))
  const rows = await prisma.slaveMessage.findMany({
    where: { workspaceId: scope.workspaceId, taskId: { in: [...keyOf.keys()] }, kind: 'question' },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      taskId: true,
      slaveId: true,
      body: true,
      createdAt: true,
      replies: { where: { kind: 'answer' }, orderBy: { seq: 'asc' }, take: 1, select: { body: true, actor: true, createdAt: true } },
    },
  })
  const names = await seatNames(rows.map((row) => row.slaveId))
  return rows.map((row) => {
    const answer = row.replies[0]
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      packageKey: row.taskId === null ? null : (keyOf.get(row.taskId) ?? null),
      askedBy: names.get(row.slaveId) ?? null,
      question: trimEvidence(row.body, GOAL_REPORT_DETAIL_MAX_CHARS),
      answer:
        answer === undefined
          ? null
          : {
              at: answer.createdAt.toISOString(),
              by: ANSWERED_BY[answer.actor],
              text: trimEvidence(answer.body, GOAL_REPORT_DETAIL_MAX_CHARS),
            },
    }
  })
}
