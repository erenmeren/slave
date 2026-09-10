import { projectRoles } from '../capability/taxonomy.js'
import { formTeam, type TeamPlan, type TeamProposal } from '../capability/team.js'
import type { Action, Candidate } from './actions.js'
import { staffableSlaves } from './observe.js'
import { mayAnswer, tierOf } from './policy.js'
import type { Situation, SituationKind } from './situations.js'
import type { SupervisorQuestion, SupervisorSlave, SupervisorTask, SupervisorWorld } from './world.js'

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
 * The team the rules would form for this world (M47 R4), computed from the world alone so the
 * same world always yields the same offers. Exported because the Organization view shows the same
 * covered / proposed / unfillable summary a decision was made from, and two computations of "what
 * is missing" would eventually disagree in front of a person.
 */
export function teamPlanOf(world: SupervisorWorld): TeamPlan {
  const required = world.tasks
    .filter((task) => task.status === 'ready' || task.status === 'blocked')
    .flatMap((task) => task.requiredCapabilities)
  return formTeam({
    required,
    roster: world.slaves.map((slave) => ({
      slaveId: slave.id,
      name: slave.name,
      capabilities: slave.capabilities,
      runtimeRoles: slave.runtimeRoles,
      busy: slave.busy,
    })),
    company: world.company.map((worker) => ({
      companySlaveId: worker.companySlaveId,
      name: worker.name,
      capabilities: worker.capabilities,
    })),
    catalog: world.catalog.map((entry) => ({
      templateId: entry.templateId,
      name: entry.name,
      capabilities: entry.capabilities,
      division: entry.division,
    })),
    taxonomy: world.taxonomy,
    recommendedTemplateIds: world.catalog.filter((entry) => entry.recommended).map((entry) => entry.templateId),
  })
}

/** One `formTeam` proposal as an {@link Action}. Returns null for the `temporary` source, which M47
 *  never emits (M50 owns that lifecycle) -- an arm that threw on it would make a future data
 *  change a crash rather than an offer nobody makes yet. */
function actionOf(proposal: TeamProposal, capability: string, world: SupervisorWorld): Action | null {
  switch (proposal.source) {
    case 'existing_worker':
      return {
        kind: 'assign_capability',
        slaveId: proposal.pick.id,
        capability,
        role: projectRoles([capability], world.taxonomy)[0] ?? '',
      }
    case 'company_worker':
      return { kind: 'materialise_company_worker', companySlaveId: proposal.pick.id, capability, name: proposal.pick.name }
    case 'project_worker':
      return {
        kind: 'hire_from_catalog',
        templateId: proposal.pick.id,
        capability,
        name: proposal.pick.name,
        rationale: proposal.rationale,
        temporary: proposal.temporary,
      }
    case 'temporary':
      return null
  }
}

/**
 * The one slave a question would be re-addressed to, or nobody.
 *
 * Three exclusions, each of which would otherwise produce an offer that cannot help: a BUSY slave
 * (whose run is not reading its inbox now, which is how the question got stale in the first place),
 * the ASKER (a question re-addressed to the person who asked it is a loop), and anyone who cannot
 * answer it at all -- `holders` is the loader's own "who may answer this today", and
 * {@link mayAnswer} is the rule control will re-check before the re-address is allowed to land.
 *
 * The asker is now excluded THREE times over -- here, by the loader's `holders`, and by `mayAnswer`
 * itself (erratum E8) -- and the line stays. It is one comparison, it is the exclusion whose
 * absence in `mayAnswer` this filter was silently covering for until the final review, and a
 * catalogue that offered "ask Alex the question Alex asked" would be wrong on its face.
 *
 * The currently addressed slave is excluded too, unless they are unavailable: re-addressing a
 * question away from somebody who is sitting idle with it is not a fix, it is a shuffle. So when
 * the addressed slave is present and free, no re-address is offered at all (spec section 3, "to an
 * idle holder when the addressed one is busy").
 *
 * Ties break on slave id, so the same world always offers the same target.
 */
function reassignTarget(question: SupervisorQuestion, world: SupervisorWorld): SupervisorSlave | undefined {
  const addressed =
    question.recipientSlaveId === null
      ? undefined
      : world.slaves.find((slave) => slave.id === question.recipientSlaveId)
  if (addressed !== undefined && !addressed.busy) return undefined

  return world.slaves
    .filter(
      (slave) =>
        !slave.busy &&
        slave.id !== question.askerSlaveId &&
        slave.id !== question.recipientSlaveId &&
        question.holders.includes(slave.id) &&
        mayAnswer(question, slave, world),
    )
    .toSorted((a, b) => a.id.localeCompare(b.id))[0]
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

    case 'stale_task': {
      // The one situation the rules did not observe: `concludeReplan` recorded it because a
      // re-plan run asked for this task to go (spec §3). The offer is the model's own request,
      // stamped `proposed` by `tierOf` -- never `applied`, whatever the workspace is doing.
      const task = subjectTask(situation, world)
      if (task !== undefined) {
        offers.push(
          candidate(
            { kind: 'cancel_task', taskId: task.id, reason: situation.summary },
            world,
            situation.kind,
            `The re-plan for the current goal no longer needs "${task.title}", and it has not started, so cancelling it takes planned work off the board rather than throwing any away.`,
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

    case 'capability_unstaffed': {
      // `subjectId` IS the capability key (spec §2 as M47 extends it). The offers are `formTeam`'s
      // proposals for THIS capability, in the order it ranked them: an existing capable worker,
      // then the company roster, then the catalog. Each carries its own rationale sentence, which
      // is what a human -- and the model -- judges the offer by.
      for (const proposal of teamPlanOf(world).proposals.filter((one) => one.covers.includes(situation.subjectId))) {
        const action = actionOf(proposal, situation.subjectId, world)
        if (action !== null) offers.push(candidate(action, world, situation.kind, proposal.rationale))
      }
      break
    }

    case 'waiting_stale':
    case 'unanswerable_question': {
      // `subjectId` IS the message id for both question kinds (spec section 2). A situation whose
      // question the world no longer holds cannot be answered or re-addressed -- there is nothing
      // to build a prompt from and nobody to re-address to -- so it falls through to the last
      // resorts rather than offering an action against a question that is not there.
      const question = world.questions.find((pending) => pending.messageId === situation.subjectId)
      if (question === undefined) break

      offers.push(
        candidate(
          { kind: 'answer_question', messageId: question.messageId },
          world,
          situation.kind,
          'The workspace goal, the asking task, the thread and the asker\'s own run context may already hold the answer; the Supervisor drafts one and sends it only if every quote it cites is really there.',
        ),
      )

      const target = reassignTarget(question, world)
      if (target !== undefined) {
        offers.push(
          candidate(
            { kind: 'reassign_question', messageId: question.messageId, toSlaveId: target.id },
            world,
            situation.kind,
            `${target.name} could answer this question and is not busy, so re-addressing it puts it in front of somebody who can reply now.`,
          ),
        )
      }

      // An unanswerable question is unanswerable because NOBODY holds the role it was addressed to
      // (that is the predicate), so the re-address above almost never fires for one and the M38
      // staffing offers are what actually fix it: give the role to somebody, and the next pass can
      // deliver the question normally. They come after the mailbox actions -- answering now beats
      // rewriting a roster to answer later.
      if (situation.kind === 'unanswerable_question' && question.recipientRole !== null) {
        offers.push(...staffingCandidates(world, situation.kind, question.recipientRole))
      }
      break
    }

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
