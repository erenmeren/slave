import { projectRoles } from '../capability/taxonomy.js'
import {
  COOLDOWN_MS,
  INTEGRATED_STALE_MS,
  MANAGER_ROLE,
  REVIEWER_ROLE,
  REVIEW_CAP_GUARDRAIL,
  WAITING_STALE_MS,
} from './constants.js'
import { SITUATION_KINDS, type Situation, type SituationKind } from './situations.js'
import type { SupervisorQuestion, SupervisorSlave, SupervisorTask, SupervisorWorld } from './world.js'

/**
 * Does anyone in this workspace hold `role` as a RUNTIME role (M37 section 5)?
 *
 * `exceptSlaveId` is the ASKER, on the question path only, and it is M39's residual R2: control's
 * `holdersOf` has excluded the asker from a question's holders since erratum E8 -- nobody answers
 * their own question -- while this predicate did not, so a question addressed to a role that only
 * its own asker holds read as deliverable here and as answerable by NOBODY there. The situation
 * that names it (`unanswerable_question`) never fired, the panel showed "0 could answer it" beside
 * no situation at all, and the staffing proposal that would have fixed it was never offered.
 *
 * Deliberately a parameter rather than a second function: the three staffing predicates below
 * (`no_reviewer`, `no_planner`, `ready_unstaffed`) are about who can be DISPATCHED and have no
 * asker to exclude, so they pass nothing and read exactly as they always did.
 */
function roleHasHolder(world: SupervisorWorld, role: string, exceptSlaveId?: string): boolean {
  return world.slaves.some((slave) => slave.id !== exceptSlaveId && slave.runtimeRoles.includes(role))
}

/**
 * Can the question reach anybody at all? A message addressed to a named slave needs that slave to
 * still be in the workspace; one addressed to a role needs a holder. A question addressed to
 * NEITHER can never be delivered, so it counts as unanswerable -- silently dropping it would
 * leave the asking task in `waiting` forever with nothing on any report to say why.
 */
function questionHasRecipient(world: SupervisorWorld, question: SupervisorQuestion): boolean {
  if (question.recipientSlaveId !== null) return world.slaves.some((slave) => slave.id === question.recipientSlaveId)
  // The asker is excluded (M39 residual R2): a role whose only holder is the worker that asked the
  // question has nobody who can answer it, which is exactly what `unanswerable_question` means.
  if (question.recipientRole !== null) return roleHasHolder(world, question.recipientRole, question.askerSlaveId)
  return false
}

/** Who a question was addressed to, for a summary a human reads. */
function recipientLabel(question: SupervisorQuestion): string {
  if (question.recipientSlaveId !== null) return `slave ${question.recipientSlaveId}`
  if (question.recipientRole !== null) return `the "${question.recipientRole}" role`
  return 'nobody'
}

function questionFacts(question: SupervisorQuestion, world: SupervisorWorld): Situation['facts'] {
  return {
    messageId: question.messageId,
    askerSlaveId: question.askerSlaveId,
    recipientRole: question.recipientRole,
    recipientSlaveId: question.recipientSlaveId,
    // The asking task (M39): the `task` source an answer is quoted from, and the thing that says
    // what this question is even about when the row is read back months later.
    taskId: question.taskId,
    // How many slaves could answer it today -- a COUNT, not the id list: facts are flat scalars
    // (`situationSchema`), and "nobody could have answered this" is the fact that explains an
    // escalation to a reader who no longer has the roster of that day.
    holders: question.holders.length,
    waitingMs: world.now - question.createdAt,
  }
}

function taskFacts(task: SupervisorTask): Situation['facts'] {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    requiredRole: task.requiredRole,
    dependents: task.dependents,
    latestGuardrail: task.latestGuardrail,
  }
}

/** Within a kind, subject id ascending -- the tiebreak that makes {@link observe} deterministic. */
function bySubjectId(a: Situation, b: Situation): number {
  return a.subjectId.localeCompare(b.subjectId)
}

/**
 * Every stuck situation in the world, as pure rules see it (M38 section 3). No I/O, no clock:
 * `world.now` is the only "now" there is, so the same world always yields the same list.
 *
 * Output order is part of the contract: {@link SITUATION_KINDS} order, then `subjectId` ascending
 * within a kind. Callers (the tick loop's per-tick model-call cap, the report's "stuck" column)
 * depend on the first N situations being the same N every time.
 *
 * `stale_task` is NEVER emitted here (M40 §3), and that is not an omission: it is the manager's own
 * judgement from a re-plan run, recorded by `concludeReplan`, not a predicate over rows. A rule
 * that fired it from `goalVersion < world.goalVersion` would propose cancelling every task on the
 * board the moment a goal was edited -- which is the opposite of a delta re-plan.
 */
export function observe(world: SupervisorWorld): readonly Situation[] {
  const byKind = new Map<SituationKind, Situation[]>()
  const add = (situation: Situation): void => {
    const bucket = byKind.get(situation.kind)
    if (bucket === undefined) byKind.set(situation.kind, [situation])
    else bucket.push(situation)
  }

  // no_reviewer: something is waiting for a review nobody can be dispatched to do. The subject is
  // the ROLE, not the task -- staffing a reviewer unblocks every task in review at once.
  const reviewing = world.tasks.filter((task) => task.status === 'reviewing')
  if (reviewing.length > 0 && !roleHasHolder(world, REVIEWER_ROLE)) {
    add({
      kind: 'no_reviewer',
      subjectId: REVIEWER_ROLE,
      summary: `${reviewing.length} task(s) are waiting for review and no slave holds the "${REVIEWER_ROLE}" role.`,
      facts: { role: REVIEWER_ROLE, reviewingTasks: reviewing.length, firstTaskId: reviewing[0]?.id ?? null },
    })
  }

  // no_planner: a goal was set and nothing ever turned it into tasks, because no slave can be
  // dispatched a planning run. Zero tasks, not "zero open tasks": once a plan exists, a workspace
  // that has finished it is done, not unplanned.
  if (world.goal !== null && world.tasks.length === 0 && !roleHasHolder(world, MANAGER_ROLE)) {
    add({
      kind: 'no_planner',
      subjectId: MANAGER_ROLE,
      summary: `A goal is set, no tasks exist, and no slave holds the "${MANAGER_ROLE}" role to plan it.`,
      facts: { role: MANAGER_ROLE, goal: world.goal },
    })
  }

  for (const task of world.tasks) {
    // review_cap_blocked vs task_blocked_human: both are `blocked`, and the split is the whole
    // point -- the review cap is a park the Supervisor knows a routine exit from, anything else is
    // a park whose cause it cannot see, so it must not guess.
    if (task.status === 'blocked') {
      if (task.latestGuardrail === REVIEW_CAP_GUARDRAIL) {
        add({
          kind: 'review_cap_blocked',
          subjectId: task.id,
          summary: `Task "${task.title}" is blocked: its review retries are exhausted (attempt ${task.attempt} of ${task.maxAttempts}).`,
          facts: taskFacts(task),
        })
      } else {
        add({
          kind: 'task_blocked_human',
          subjectId: task.id,
          summary: `Task "${task.title}" is blocked and nothing but a human decision moves it (attempt ${task.attempt} of ${task.maxAttempts}).`,
          facts: taskFacts(task),
        })
      }
    }

    // task_failed: a failed leaf is somebody's bad day; a failed task with dependents is a dead
    // end holding up other work, which is the only case worth a decision.
    if (task.status === 'failed' && task.dependents > 0) {
      add({
        kind: 'task_failed',
        subjectId: task.id,
        summary: `Task "${task.title}" failed and ${task.dependents} task(s) depend on it.`,
        facts: taskFacts(task),
      })
    }

    // done_not_integrated_stale: done, never merged to the base branch, and other work is waiting
    // for that merge. `statusSince` is the loader's derived "when did it become done" (spec E1).
    if (
      task.status === 'done' &&
      task.integratedAt === null &&
      task.dependents > 0 &&
      world.now - task.statusSince > INTEGRATED_STALE_MS
    ) {
      const doneForMs = world.now - task.statusSince
      add({
        kind: 'done_not_integrated_stale',
        subjectId: task.id,
        summary: `Task "${task.title}" has been done but unintegrated for ${Math.floor(doneForMs / 3_600_000)}h, with ${task.dependents} task(s) waiting on it.`,
        facts: { ...taskFacts(task), doneForMs },
      })
    }
  }

  for (const question of world.questions) {
    if (!questionHasRecipient(world, question)) {
      // unanswerable_question: however fresh it is, nobody can answer it -- waiting longer will
      // not help, so this fires without a staleness threshold.
      add({
        kind: 'unanswerable_question',
        subjectId: question.messageId,
        summary: `A question is addressed to ${recipientLabel(question)}, which no slave in this workspace holds.`,
        facts: questionFacts(question, world),
      })
    } else if (world.now - question.createdAt > WAITING_STALE_MS) {
      const waitedMinutes = Math.floor((world.now - question.createdAt) / 60_000)
      add({
        kind: 'waiting_stale',
        subjectId: question.messageId,
        summary: `A question to ${recipientLabel(question)} has waited ${waitedMinutes} minutes for an answer.`,
        facts: questionFacts(question, world),
      })
    }
  }

  // capability_unstaffed: keyed by the CAPABILITY, so N startable tasks blocked on one gap are one
  // situation. "Unstaffed" is "nobody holds the role it projects to" (plan erratum E8), not
  // "nobody has it": the whole point of the `assign_capability` offer is a worker who HAS the
  // capability and was never given its runtime role, and a predicate that read coverage off the
  // capability alone would call that case staffed and never offer the fix.
  const unstaffedCapabilities = new Map<string, SupervisorTask[]>()
  const raisedFor = new Set<string>()
  for (const t of world.tasks) {
    if (t.status !== 'ready' || !t.dependenciesDone) continue
    for (const capability of t.requiredCapabilities) {
      const role = projectRoles([capability], world.taxonomy)[0]
      // A key the taxonomy does not have projects no role and staffs nobody: it is not a gap this
      // workspace can act on, and a situation about it would offer nothing but an escalation.
      if (role === undefined || roleHasHolder(world, role)) continue
      const waiting = unstaffedCapabilities.get(capability)
      if (waiting === undefined) unstaffedCapabilities.set(capability, [t])
      else waiting.push(t)
      raisedFor.add(t.id)
    }
  }
  for (const [capability, waiting] of unstaffedCapabilities) {
    const role = projectRoles([capability], world.taxonomy)[0] ?? ''
    add({
      kind: 'capability_unstaffed',
      subjectId: capability,
      summary: `${waiting.length} startable task(s) need "${capability}" and no slave can be dispatched as "${role}".`,
      facts: { capability, role, readyTasks: waiting.length, firstTaskId: waiting[0]?.id ?? null },
    })
  }

  // ready_unstaffed: keyed by the missing ROLE, so N startable tasks blocked on one absent role
  // are one situation with one decision -- not N proposals a human has to approve N times.
  const unstaffedRoles = new Map<string, SupervisorTask[]>()
  for (const task of world.tasks) {
    if (task.status !== 'ready' || !task.dependenciesDone) continue
    // An empty `requiredRole` is a real value -- "any role will do" (see `SchedulableSlave.
    // runtimeRoles` in `../scheduler/decide.ts`, which reasons about exactly this string). Such a
    // task cannot be "unstaffed BY ROLE", and keying a situation on it would put an empty
    // `subjectId` on the row -- which `situationSchema`'s `min(1)` rejects, and which would make
    // the situation key `(workspaceId, kind, '')` collide across every such task.
    if (task.requiredRole === '') continue
    // E8: the capability reading of this task is already a situation of its own; reporting the
    // role gap as well would put two proposals in front of a person for one hole.
    if (raisedFor.has(task.id)) continue
    if (roleHasHolder(world, task.requiredRole)) continue
    const waiting = unstaffedRoles.get(task.requiredRole)
    if (waiting === undefined) unstaffedRoles.set(task.requiredRole, [task])
    else waiting.push(task)
  }
  for (const [role, waiting] of unstaffedRoles) {
    add({
      kind: 'ready_unstaffed',
      subjectId: role,
      summary: `${waiting.length} startable task(s) need the "${role}" role and no slave holds it.`,
      facts: { role, readyTasks: waiting.length, firstTaskId: waiting[0]?.id ?? null },
    })
  }

  if (world.halted !== null) {
    add({
      kind: 'workspace_halted',
      subjectId: world.workspaceId,
      summary: `Scheduling is halted: ${world.halted.reason}.`,
      facts: { reason: world.halted.reason, budgetExhausted: world.budgetExhausted },
    })
  }

  return SITUATION_KINDS.flatMap((kind) => (byKind.get(kind) ?? []).toSorted(bySubjectId))
}

/**
 * The situations that are actually free to be decided now (M38 section 3, "idempotent and quiet"):
 * drops a key that already has an OPEN (`pending`) decision -- a human is looking at it -- and one
 * whose last decision stopped being open less than `COOLDOWN_MS` ago.
 *
 * The cooldown anchor is `resolvedAt ?? createdAt`: an auto-`applied` (or `failed`) decision is
 * terminal from birth and never gets a `resolvedAt`, so without the `createdAt` fallback the
 * Supervisor would re-decide every routine apply on the very next tick. Exactly `COOLDOWN_MS` old
 * is still cooling -- the window is closed at that end, so a fixed clock cannot straddle it.
 */
export function filterFresh(situations: readonly Situation[], world: SupervisorWorld): readonly Situation[] {
  const key = (kind: SituationKind, subjectId: string): string => `${kind} ${subjectId}`
  const blocked = new Set<string>()
  for (const decision of world.decisions) {
    const anchor = decision.resolvedAt ?? decision.createdAt
    const cooling = decision.status === 'pending' || world.now - anchor <= COOLDOWN_MS
    if (cooling) blocked.add(key(decision.situationKind, decision.subjectId))
  }
  return situations.filter((situation) => !blocked.has(key(situation.kind, situation.subjectId)))
}

/**
 * The slaves a staffing action could add `role` to: not busy (a running slave's roles must not
 * change under it) and not already holding it. Lives here rather than in `candidates.ts` because
 * it is the same "who holds what" reading the predicates above are built on.
 */
export function staffableSlaves(world: SupervisorWorld, role: string): readonly SupervisorSlave[] {
  return world.slaves.filter((slave) => !slave.busy && !slave.runtimeRoles.includes(role))
}
