import type { Action, Candidate } from './actions.js'
import { staffableSlaves } from './observe.js'
import { tierOf } from './policy.js'
import type { Situation, SituationKind } from './situations.js'
import type { SupervisorTask, SupervisorWorld } from './world.js'

/**
 * How many staffing offers one situation may carry. Three is a list a human can read in a glance
 * and a model can weigh; the alternative -- one candidate per idle slave -- turns a ten-slave
 * workspace's proposal into a menu nobody reads.
 */
export const MAX_STAFFING_CANDIDATES = 3

/** The task a task-shaped situation is about, if the world still has it. */
function subjectTask(situation: Situation, world: SupervisorWorld): SupervisorTask | undefined {
  return world.tasks.find((task) => task.id === situation.subjectId)
}

/**
 * `set_runtime_roles` offers for a missing role, best guess first.
 *
 * The ordering key is whether the slave's TITLE (`Slave.role`, display-only since M37) mentions
 * the role -- a "QA Reviewer" who was never given the `reviewer` runtime role is the likeliest
 * intended holder, and putting them first is what makes {@link chooseByRules}' escalation, and the
 * model's pick, land on the obvious person. Ties break on slave id so the list is deterministic
 * whatever order the loader returned the roster in.
 *
 * BOTH sides of that match are lowercased (final review Minor 7). A `requiredRole` is free text an
 * operator typed, so `QA` or `Backend` compared against an already-lowercased title matched nothing
 * and every candidate came back in flat slave-id order -- the ranking silently stopped ranking.
 *
 * The roles written are the slave's CURRENT set plus the missing one: a staffing action must never
 * take a role away as a side effect of adding one.
 */
function staffingCandidates(world: SupervisorWorld, kind: SituationKind, role: string): Candidate[] {
  const contenders = staffableSlaves(world, role)
    .map((slave) => ({ slave, mentions: slave.role.toLowerCase().includes(role.toLowerCase()) }))
    .toSorted((a, b) =>
      a.mentions === b.mentions ? a.slave.id.localeCompare(b.slave.id) : a.mentions ? -1 : 1,
    )
    .slice(0, MAX_STAFFING_CANDIDATES)

  return contenders.map(({ slave, mentions }) =>
    candidate(
      { kind: 'set_runtime_roles', slaveId: slave.id, roles: [...slave.runtimeRoles, role] },
      world,
      kind,
      mentions
        ? `${slave.name} is titled "${slave.role}", which already reads as the "${role}" role -- giving them the runtime role makes them dispatchable for it.`
        : `${slave.name} is idle and could take the "${role}" role alongside their current ones.`,
    ),
  )
}

function candidate(action: Action, world: SupervisorWorld, kind: SituationKind, why: string): Candidate {
  return { action, tier: tierOf(action, world, kind), why }
}

/**
 * The catalogue of actions the rules offer for one situation (M38 section 3).
 *
 * Two invariants the rest of M38 is built on: the list is NEVER empty, and it always ends with
 * `escalate_to_human` then `no_action`. That is what gives {@link chooseByRules} an answer for
 * every situation, gives the model a way to decline every action without inventing one, and keeps
 * `parseDecisionAnswer`'s index range meaningful. Each candidate's `tier` is already stamped by
 * {@link tierOf}, so the tier stored on the row is the tier the offer was made under.
 *
 * The model may only pick from this list -- it can never add an action (spec section 1).
 */
export function candidates(situation: Situation, world: SupervisorWorld): readonly Candidate[] {
  const offers: Candidate[] = []

  switch (situation.kind) {
    case 'review_cap_blocked':
    case 'task_blocked_human': {
      const task = subjectTask(situation, world)
      if (task !== undefined) {
        // One exit, two spellings: below the cap `unblockTask` alone is enough and is routine; at
        // or past it the cap has to move first, which is a risk a human signs off on.
        offers.push(
          task.attempt < task.maxAttempts
            ? candidate(
                { kind: 'unblock_task', taskId: task.id },
                world,
                situation.kind,
                `The task has attempt ${task.attempt} of ${task.maxAttempts} left, so it can go back to rework as it is.`,
              )
            : candidate(
                { kind: 'raise_max_attempts', taskId: task.id },
                world,
                situation.kind,
                `The task is at its cap (attempt ${task.attempt} of ${task.maxAttempts}); another try needs the cap raised.`,
              ),
        )
        offers.push(
          candidate(
            { kind: 'mark_task_failed', taskId: task.id, reason: `Supervisor: ${situation.summary}` },
            world,
            situation.kind,
            'Declaring the task failed stops its dependents waiting on work that is not coming.',
          ),
        )
      }
      break
    }

    case 'task_failed':
      // Deliberately no verb: nothing in the control layer re-opens a `failed` task, and inventing
      // one here would be the Supervisor doing work rather than deciding (spec section 1). A human
      // re-plans the dead end.
      break

    case 'no_reviewer':
    case 'no_planner':
    case 'ready_unstaffed':
      // `subjectId` IS the missing role for all three kinds (spec section 2).
      offers.push(...staffingCandidates(world, situation.kind, situation.subjectId))
      break

    case 'waiting_stale':
    case 'unanswerable_question':
      offers.push(
        candidate(
          { kind: 'nudge_answer', messageId: situation.subjectId },
          world,
          situation.kind,
          'Recording an escalation against the question puts it in front of whoever can answer it.',
        ),
      )
      break

    case 'done_not_integrated_stale':
    case 'workspace_halted':
      // Neither has a safe automatic exit: a merge is a human's call, and a halt is a guardrail's
      // verdict the Supervisor must not overturn.
      break
  }

  offers.push(
    candidate({ kind: 'escalate_to_human', summary: situation.summary }, world, situation.kind, 'A human decides what happens next.'),
    candidate({ kind: 'no_action' }, world, situation.kind, 'The situation is real but waiting one more tick is reasonable.'),
  )
  return offers
}
