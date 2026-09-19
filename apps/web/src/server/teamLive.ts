import { prisma } from '@slave-of-ai/db/client'
import type { ProviderKind } from '@slave-of-ai/control'
import { USER_CARD_LABEL, type SlaveLifecycle, type SlaveStatus } from '@slave-of-ai/domain'
import { cardStateFor, toneForStatus, type CardState } from '../lib/tones'
import { progressOf } from '../lib/progress'
import type { StatusTone } from '../components/ui/StatusPill'
import { buildOverviewSnapshot, type SlaveCardData } from './overview'
import { buildOrganization, type OrganizationRow, type OrganizationView } from './organization'
import { buildShellFacts, type ShellFacts } from './shell'

/**
 * The technical facts the Team row's disclosure drawer shows, off the same live run the row's
 * plain-English sentence is built from (M61 R8).
 *
 * `startedAt` is always `null`: `SlaveCardData` (`server/overview.ts`) carries no run-start
 * timestamp today, and the task brief's `startedAt` guess is not a real field on it -- adding a
 * query here to fetch one would break the "two composed reads plus one small query" budget this
 * module is held to. `null` is the honest reading of a fact this snapshot does not carry, not "no
 * run"; `runId` is what says that.
 */
export interface TeamLiveTechnical {
  readonly runId: string | null
  readonly provider: ProviderKind | null
  readonly startedAt: string | null
  readonly toolCalls: number
  readonly costUsd: number | null
}

/** One seat, as the Team surface reads it: who, what they are doing IN ENGLISH (never a raw
 *  `SlaveStatus`/`TaskStatus` member), and the technical facts behind that sentence. */
export interface TeamLiveRow {
  readonly slaveId: string
  readonly personId: string
  readonly name: string
  readonly role: string
  readonly status: SlaveStatus
  readonly state: CardState
  readonly stateLabel: string
  readonly doing: string
  readonly doingTone: StatusTone
  readonly progress: number | null
  readonly taskId: string | null
  readonly lifecycle: SlaveLifecycle
  readonly released: { readonly at: string; readonly reason: string } | null
  readonly why: string
  readonly technical: TeamLiveTechnical
}

export interface TeamLiveSnapshot {
  readonly workspaceId: string
  readonly rows: readonly TeamLiveRow[]
  readonly stats: { readonly inProgress: number; readonly done: number; readonly goal: string | null }
  readonly shellFacts: ShellFacts
  readonly needs: OrganizationView['needs']
  /**
   * `OrganizationView` has no top-level `preferences` field (the task brief's name for this field
   * was a guess) -- a staffing preference lives nested, per capability, on `needs[].preference` and
   * `covered[].preference`. `covered` is the closer analog for a Team-page reader: it is the
   * per-capability "who is here and what was asked for" row, the same shape `OrganizationClient`
   * already renders. Passed through verbatim, no second read.
   */
  readonly preferences: OrganizationView['covered']
  readonly haltedReason: string | null
  /**
   * The three facts `OrganizationNeeds`/`OrganizationPreferences` need beyond `needs`/`preferences`
   * themselves (Task 6 addition, additive-only -- nothing above this line moved or changed shape).
   * All three are already sitting on the SAME `organization` read this module makes above; passing
   * them through costs no second query. `pendingElsewhere` is the "N staffing proposals waiting
   * elsewhere" count `OrganizationNeeds` prints; `taskTitles` is what `ProposalRow` resolves a
   * task id to inside a proposal; `templates` is the pick list behind every staffing-preference
   * control.
   */
  readonly pendingElsewhere: number
  readonly taskTitles: OrganizationView['taskTitles']
  readonly templates: OrganizationView['templates']
  /** M33 §4's provenance note, carried through from `overview.workspace.adoptedFrom` -- the same
   *  fact `OverviewClient.tsx`'s `ws-adopted-from` band used to show on this page, and
   *  `gate:m33-adopt` still reads it here. Additive, off the same `overview` read this module
   *  already makes. */
  readonly adoptedFrom: { readonly simulationId: string; readonly name: string } | null
}

/**
 * The Team tab's live read (M61 R8): one row per seat, in prose, built from the same two
 * composed reads Overview and Organization already make -- `buildOverviewSnapshot` for the live
 * run/task facts, `buildOrganization` for why each seat exists -- plus `buildShellFacts` for the
 * header figures `TeamLiveSnapshot.shellFacts` carries, and ONE small query for the next queued
 * task per role (an idle seat's "Idle · next: …", the one fact neither composed read carries).
 *
 * `null` exactly when the workspace does not exist -- any one of the three reads returning `null`
 * says so, since all three share that same one rule.
 */
export async function buildTeamLive(workspaceId: string, now: Date = new Date()): Promise<TeamLiveSnapshot | null> {
  const [overview, organization, shellFacts] = await Promise.all([
    buildOverviewSnapshot(workspaceId),
    buildOrganization(workspaceId, now),
    buildShellFacts(workspaceId),
  ])
  if (overview === null || organization === null || shellFacts === null) return null

  const orgBySeat = new Map(organization.workers.map((row) => [row.slaveId, row]))

  // The one small query the brief allows beyond the two composed reads: the first `ready` /
  // `assigned` / `backlog` task's title per required role, so an idle seat can say what it would
  // pick up next instead of a bare "Idle". Ordered oldest-first so the first row seen per role is
  // the one that would actually be picked up next.
  const queuedTasks = await prisma.task.findMany({
    where: { workspaceId, status: { in: ['ready', 'assigned', 'backlog'] } },
    select: { title: true, requiredRole: true },
    orderBy: { createdAt: 'asc' },
  })
  const queuedByRole = new Map<string, string>()
  for (const task of queuedTasks) {
    if (task.requiredRole !== null && !queuedByRole.has(task.requiredRole)) {
      queuedByRole.set(task.requiredRole, task.title)
    }
  }

  const rows = overview.slaves.map((slave): TeamLiveRow => {
    const org = orgBySeat.get(slave.id)
    // The exact facts `SlaveCard.tsx:66-120` passes today -- the breaker's rung is the third fact
    // the state is built from, and this row must not disagree with the card about it.
    const state = cardStateFor(slave.status, slave.taskStatus, { breakerLevel: slave.breakerLevel })
    // `runtimeRoles`, not `role`: the scheduler's own dispatch key (`packages/domain/src/scheduler
    // /decide.ts:71` matches `Task.requiredRole` against `runtimeRoles`, never `Slave.role`, which
    // M37 repurposed as the profile's title). A worker with several dispatch roles takes the first
    // one that has a queued task.
    const nextTitle = slave.runtimeRoles.map((role) => queuedByRole.get(role)).find((title) => title !== undefined) ?? null
    const doing = doingSentence(slave, org, nextTitle)
    return {
      slaveId: slave.id,
      personId: slave.personId,
      name: slave.name,
      role: slave.role,
      status: slave.status,
      state,
      stateLabel: USER_CARD_LABEL[state],
      doing: doing.text,
      doingTone: doing.tone,
      progress: progressOf(slave.taskStatus, slave.runId === null ? null : slave.progressPct),
      taskId: slave.taskId,
      lifecycle: slave.lifecycle,
      released: slave.released,
      why: org?.why ?? '',
      technical: {
        runId: slave.runId,
        provider: slave.provider,
        startedAt: null,
        toolCalls: slave.toolCalls,
        costUsd: slave.costUsd,
      },
    }
  })

  return {
    workspaceId,
    rows,
    stats: {
      inProgress: overview.tasks.active,
      // `overview.brief.work.done`, not a second count: `ProjectBrief.work.done` is the one figure
      // the Overview's own brief tile already shows for "done", and this is that same number
      // rather than a fresh `countOf(['done'])` that could drift from it.
      done: overview.brief.work.done,
      goal: overview.workspace.goal,
    },
    shellFacts,
    needs: organization.needs,
    preferences: organization.covered,
    haltedReason: overview.workspace.haltedReason,
    pendingElsewhere: organization.pendingElsewhere,
    taskTitles: organization.taskTitles,
    templates: organization.templates,
    adoptedFrom: overview.workspace.adoptedFrom,
  }
}

/**
 * The one English sentence a row says, off the same live-run and organization facts the rest of
 * this module already read -- NEVER a raw `SlaveStatus`/`TaskStatus` member (`docs/ia.md` rule 3).
 *
 * In priority order: a question the slave is waiting on outranks everything (an operator has to
 * answer it before anything else here matters), then a blocked task (needs a person), then the
 * live run's own task title, then the Organization row's own "what are they doing" sentence for a
 * worker this snapshot has no live run for, then a released worker's reason, and only then the
 * honest "Idle" (with the next queued task for their role, when there is one).
 */
function doingSentence(
  slave: SlaveCardData,
  org: OrganizationRow | undefined,
  nextTitle: string | null,
): { readonly text: string; readonly tone: StatusTone } {
  if (slave.waitingFor !== null) {
    return {
      text:
        slave.waitingFor.question === null
          ? `Waiting for ${slave.waitingFor.recipient}`
          : `Asked ${slave.waitingFor.recipient}: ${slave.waitingFor.question}`,
      tone: 'waiting',
    }
  }
  if (slave.taskStatus === 'blocked') {
    return { text: `Blocked on "${slave.taskTitle ?? 'a task'}" — needs you`, tone: 'blocked' }
  }
  if (slave.runId !== null && slave.taskTitle !== null) {
    return { text: slave.taskTitle, tone: toneForStatus(slave.status) }
  }
  if (org?.doing) return { text: org.doing, tone: 'working' }
  if (slave.released !== null) return { text: `Released · ${slave.released.reason}`, tone: 'idle' }
  return { text: nextTitle === null ? 'Idle' : `Idle · next: ${nextTitle}`, tone: 'idle' }
}
