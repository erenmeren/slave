import { steerTextFor } from '../breaker/constants.js'
import { capabilityLabel as capabilityLabelIn, projectRoles } from '../capability/taxonomy.js'
import { formTeam, type TeamPlan, type TeamProposal, type TeamRanking } from '../capability/team.js'
import { profileKeyOf } from '../evidence/derive.js'
import { PERMISSION_KINDS, PERMISSION_LABEL, type PermissionKind } from '../permission/kinds.js'
import { recommendRunbooks } from '../runbook/recommend.js'
import type { Action, Candidate } from './actions.js'
import { rosterCapabilities, staffableSlaves } from './observe.js'
import { mayAnswer, tierOf } from './policy.js'
import type { Situation, SituationKind } from './situations.js'
import type { SupervisorQuestion, SupervisorSlave, SupervisorTask, SupervisorWorld } from './world.js'

/**
 * How many staffing offers one situation may carry. Three is a list a human can read in a glance
 * and a model can weigh; the alternative -- one candidate per idle slave -- turns a ten-slave
 * workspace's proposal into a menu nobody reads.
 */
export const MAX_STAFFING_CANDIDATES = 3

function isPermissionKind(value: string): value is PermissionKind {
  return (PERMISSION_KINDS as readonly string[]).includes(value)
}

/**
 * Why a permission is being asked for, as a FIXED sentence (M52 R5).
 *
 * Never a model's words, and this is the ruling that lets the action exist at all:
 * `packages/domain/src/supervisor/critical.ts:33-34` forbids the Supervisor ANSWERING about
 * permissions and credentials in prose, and the distinction that holds is between prose and a
 * proposal. This function writes no prose -- it interpolates one label and one integer into a
 * constant, and everything else a person needs is the row itself.
 *
 * It does not name the WORKER: the action carries `name` beside this sentence and the panel is the
 * thing that prints it, so a name interpolated here would be the same fact twice.
 */
export function permissionWhyFor(kind: PermissionKind, count: number): string {
  return (
    `This worker has been refused \u2018${PERMISSION_LABEL[kind]}\u2019 ${String(count)} times ` +
    'and cannot get past it. Only a person can grant it.'
  )
}

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

/** The words for a key, off the world's own taxonomy -- the key itself when the taxonomy has never
 *  heard of it, which is `capabilityLabel`'s own fallback and keeps `capabilityLabel: z.string()
 *  .min(1)` satisfiable for any key at all. */
function capabilityLabelOf(key: string, world: SupervisorWorld): string {
  return capabilityLabelIn(key, world.taxonomy)
}

function candidate(action: Action, world: SupervisorWorld, kind: SituationKind, why: string): Candidate {
  return { action, tier: tierOf(action, world, kind), why }
}

/**
 * Is this task a STAFFING NEED right now (M47 final review, Important 2)?
 *
 * ONE predicate, exported, because there were three spellings of "what is missing" -- `observe`'s
 * `capability_unstaffed` loop said `ready && dependenciesDone`, {@link teamPlanOf} said
 * `ready || blocked`, and the Organization view's own `readyTasks` count said `ready` alone. Three
 * readings of one question disagree in front of a person: the page counted a task the situation
 * had not raised, and `teamPlanOf` proposed a hire for a `blocked` task no proposal could start.
 *
 * `ready && dependenciesDone` is the SITUATION's reading, and it wins because a situation is what
 * raises a decision. A `blocked` task is not yet a staffing need -- it is waiting on a guardrail or
 * a human, and staffing it changes nothing until it is unblocked, at which point this predicate
 * says yes and the gap is raised then. `dependenciesDone` is there for the same reason the
 * scheduler has it: a `ready` task whose dependency has not been integrated is not startable, and
 * hiring for it would put a specialist on a project to wait.
 *
 * Structurally typed rather than taking a whole `SupervisorTask`: `loadSupervisorWorld`'s own row
 * shape carries both fields and asks the same question before it pays for the catalog reads.
 */
export function isStaffableTask(task: Pick<SupervisorTask, 'status' | 'dependenciesDone'>): boolean {
  return task.status === 'ready' && task.dependenciesDone
}

/**
 * The team the rules would form for this world (M47 R4), computed from the world alone so the
 * same world always yields the same offers. Exported because the Organization view shows the same
 * covered / proposed / unfillable summary a decision was made from, and two computations of "what
 * is missing" would eventually disagree in front of a person.
 */
export function teamPlanOf(world: SupervisorWorld): TeamPlan {
  const staffable = world.tasks.filter(isStaffableTask)
  const required = staffable.flatMap((task) => task.requiredCapabilities)
  // M50 R2 (plan erratum E3): WHO needs what, off the same filtered array `required` came from --
  // one pass, so "this gap belongs to one assignment" can never be asked of a different set of
  // tasks than the gap itself was measured over. Ids are pushed in `world.tasks` order and never
  // doubled, so the map is the same map whatever order the loader returned rows in.
  const requiredBy = new Map<string, string[]>()
  for (const task of staffable) {
    for (const capability of task.requiredCapabilities) {
      const waiting = requiredBy.get(capability)
      if (waiting === undefined) requiredBy.set(capability, [task.id])
      else if (!waiting.includes(task.id)) waiting.push(task.id)
    }
  }
  // M53 R8: everything the six steps need, gathered once from the world. `profileKeyOf` is R1's own
  // rule applied to each candidate kind -- a roster worker keys on the template it was hired from or
  // on itself, and a company worker or a catalog entry keys on its template, which both always have
  // (`CompanySlave.templateId` is NOT NULL). Keyed on the CANDIDATE's id throughout, which is what
  // `formTeam` hands the ranker; a released worker is not in the roster it builds a field from, so
  // the rows gathered for one here are simply never read.
  const templateOf = new Map<string, string | null>()
  const modelOf = new Map<string, string | null>()
  const profileKeys = new Map<string, string>()
  const deniedKinds = new Map<string, readonly PermissionKind[]>()
  for (const slave of world.slaves) {
    templateOf.set(slave.id, slave.hiredFromTemplateId)
    modelOf.set(slave.id, slave.model)
    profileKeys.set(slave.id, profileKeyOf({ slaveId: slave.id, hiredFromTemplateId: slave.hiredFromTemplateId }))
    // Only when there IS one: an empty list and an absent entry mean the same thing to the ranker,
    // and a map with a row per worker would say "we looked" where nothing was refused.
    if (slave.deniedKinds.length > 0) deniedKinds.set(slave.id, slave.deniedKinds)
  }
  // `profileKeyOf` and never a `template:` literal written out here (final wave): R1's key has one
  // spelling, in `evidence/derive.ts`, and a second one beside it is how the world's keys and the
  // record's keys eventually stop matching for a reason nobody can see. Both kinds always carry a
  // template (`CompanySlave.templateId` is NOT NULL, and a catalog entry IS one), so both resolve
  // to `template:<id>`; the `slaveId` half is what the helper falls back to and neither needs.
  for (const worker of world.company) {
    templateOf.set(worker.companySlaveId, worker.templateId)
    profileKeys.set(
      worker.companySlaveId,
      profileKeyOf({ slaveId: worker.companySlaveId, hiredFromTemplateId: worker.templateId }),
    )
  }
  for (const entry of world.catalog) {
    templateOf.set(entry.templateId, entry.templateId)
    modelOf.set(entry.templateId, entry.defaultModel)
    profileKeys.set(entry.templateId, profileKeyOf({ slaveId: entry.templateId, hiredFromTemplateId: entry.templateId }))
  }

  const ranking: TeamRanking = {
    preferences: new Map(
      world.staffingPreferences.map((one) => [one.capability, { templateId: one.templateId, model: one.model }] as const),
    ),
    evidence: new Map(world.evidence.map((one) => [one.profileKey, one] as const)),
    deniedKinds,
    templateOf,
    modelOf,
    profileKeyOf: profileKeys,
    // Every staffing decision the Supervisor makes is about implementation work: `assign_capability`
    // grants a runtime role, and the run that role is dispatched as is an `implementation` run.
    // A parameter rather than a constant because `BASELINE_GRANTS` differs per kind and both
    // answers are true (M52 R1).
    runKind: 'implementation',
  }

  return formTeam({
    required,
    requiredBy,
    // M50 R3: a RELEASED worker is not on this team. Its capabilities are still on its row -- they
    // are what it did here -- but it holds no runtime roles and nothing may propose giving it any,
    // so leaving it in the roster would make `formTeam`'s first tier offer the one worker that
    // cannot take the job.
    roster: world.slaves
      .filter((slave) => !slave.released)
      .map((slave) => ({
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
    ranking,
  })
}

/** One `formTeam` proposal as an {@link Action}. Total since M50: the `temporary` source is a hire
 *  with an end written into it, so all four sources map to a real offer and the return is an
 *  `Action` rather than an `Action | null`. */
function actionOf(proposal: TeamProposal, capability: string, world: SupervisorWorld): Action {
  // The taxonomy's words, stamped on the action at DECISION time (M47 final review, Minor 5b). The
  // panel that renders this a day later has no taxonomy to look it up in, and a row read a year
  // later should still say what it was about rather than print a key at a person.
  const capabilityLabel = capabilityLabelOf(capability, world)
  switch (proposal.source) {
    case 'existing_worker':
      return {
        kind: 'assign_capability',
        slaveId: proposal.pick.id,
        capability,
        capabilityLabel,
        role: projectRoles([capability], world.taxonomy)[0] ?? '',
      }
    case 'company_worker':
      return {
        kind: 'materialise_company_worker',
        companySlaveId: proposal.pick.id,
        capability,
        capabilityLabel,
        name: proposal.pick.name,
        rationale: proposal.rationale,
      }
    // ONE arm for both (M50 R2): the same verb, from the same catalog, chosen by the same search.
    // The only difference is how long the worker is here for, and the proposal carries that as two
    // fields rather than as two shapes.
    case 'project_worker':
    case 'temporary':
      return {
        kind: 'hire_from_catalog',
        templateId: proposal.pick.id,
        capability,
        capabilityLabel,
        name: proposal.pick.name,
        rationale: proposal.rationale,
        temporary: proposal.temporary,
        engagementTaskId: proposal.engagementTaskId,
      }
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
      // `subjectId` IS the capability key (spec §2 as M47 extends it). `formTeam` has already made
      // the choice R4 fixes -- an existing capable worker, else the company roster, else the
      // catalog -- and it covers each missing capability with exactly ONE pick, so this filter
      // yields ONE offer (fix round 1, Minor 4: it is not a ranked list of three). The loop stands
      // because zero is the other real answer: a capability nobody anywhere provides is
      // `unfillable`, and then the last resorts below are the whole catalogue. The proposal's own
      // rationale sentence is what a human -- and the model -- judges the offer by.
      for (const proposal of teamPlanOf(world).proposals.filter((one) => one.covers.includes(situation.subjectId))) {
        offers.push(candidate(actionOf(proposal, situation.subjectId, world), world, situation.kind, proposal.rationale))
      }
      break
    }

    case 'runbook_recommended': {
      // `subjectId` is the WORKSPACE. The offers are `recommendRunbooks`' own top three, in its own
      // order -- score descending, ties on key ascending -- so the index a model picks means the
      // same thing on two runs over the same world.
      if (world.goal === null) break
      for (const recommendation of recommendRunbooks(world.goal, world.runbooks, rosterCapabilities(world), world.taxonomy)) {
        offers.push(
          candidate(
            {
              kind: 'adopt_runbook',
              runbookId: recommendation.runbook.id,
              key: recommendation.runbook.key,
              name: recommendation.runbook.name,
              rationale: recommendation.rationale,
            },
            world,
            situation.kind,
            recommendation.rationale,
          ),
        )
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

    case 'memory_candidates_piling':
      // ONE offer, and a proposal (`tierOf`): withdrawing what workers reported is a person's call.
      // `escalate_to_human` follows it automatically below, which is R2's "then escalate".
      offers.push(
        candidate(
          { kind: 'discard_stale_candidates', workspaceId: world.workspaceId, count: world.staleMemoryCandidates },
          world,
          situation.kind,
          `Withdrawing the ${String(world.staleMemoryCandidates)} unverified report(s) keeps this project's knowledge to what something actually checked; nothing is deleted, and each row keeps the reason it was withdrawn.`,
        ),
      )
      break

    case 'engagement_over': {
      // `subjectId` IS the slave id. A worker the world no longer holds cannot be released -- there
      // is nothing to name in the offer -- so it falls through to the last resorts rather than
      // offering an action against a row that is not there (the question arms' own rule).
      const worker = world.slaves.find((one) => one.id === situation.subjectId)
      if (worker !== undefined) {
        offers.push(
          candidate(
            { kind: 'release_worker', slaveId: worker.id, name: worker.name, reason: situation.summary },
            world,
            situation.kind,
            `${worker.name} was brought in for one assignment and that assignment is over. Releasing them empties their runtime roles so nothing dispatches them again and collects the worktrees their runs left behind; every run, message and thing they learnt stays exactly where it is.`,
          ),
        )
      }
      break
    }

    case 'run_looping': {
      // `subjectId` IS the run id. The world moved between `observe` and here (the run concluded,
      // another tick stopped it, the breaker row went unread) -- no offer against a row that is
      // gone, and the last resorts below are then the whole catalogue, which is the shape every
      // other arm uses when its subject has vanished.
      const run = world.runs.find((one) => one.id === situation.subjectId)
      if (run !== undefined && run.trip !== null && run.count !== null && run.detail !== null) {
        offers.push(
          candidate(
            {
              kind: 'steer_run',
              runId: run.id,
              slaveId: run.slaveId,
              // `steerTextFor` interpolates the trip's COUNT and nothing else: `detail` is an
              // identifier (a `toolName:argsHash`, an error class), and a hash in a worker's prompt
              // is `docs/ia.md` rule 3 broken in the one place nobody would look for it.
              text: steerTextFor({ kind: run.trip, count: run.count, detail: run.detail }),
            },
            world,
            situation.kind,
            'Tell it, once, in the system\u2019s own words, that it is repeating itself -- the next rung takes its remaining tool budget away.',
          ),
        )
      }
      break
    }

    case 'permission_blocked': {
      // `facts.slaveId` is the BARE id -- `subjectId` is `<slaveId>:<kind>` (plan decision D6) and
      // nothing here parses it. The world moved between `observe` and here (the worker was
      // released, the row is gone): no offer against a row that is not there, and the two last
      // resorts below are then the whole catalogue, which is `run_looping`'s shape exactly.
      const slaveId = String(situation.facts['slaveId'] ?? '')
      const permissionKind = String(situation.facts['kind'] ?? '')
      const count = Number(situation.facts['count'] ?? 0)
      const blocked = world.slaves.find((one) => one.id === slaveId)
      if (blocked !== undefined && isPermissionKind(permissionKind)) {
        offers.push(
          candidate(
            {
              kind: 'request_permission',
              slaveId,
              name: blocked.name,
              permissionKind,
              kindLabel: PERMISSION_LABEL[permissionKind],
              why: permissionWhyFor(permissionKind, count),
            },
            world,
            situation.kind,
            `${blocked.name} cannot get past this without it.`,
          ),
        )
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
