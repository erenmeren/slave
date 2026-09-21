import { STEERS_PER_RUN_MAX } from '../breaker/constants.js'
import { BREAKER_TRIP_LABEL } from '../breaker/detect.js'
import { PERMISSION_TRIP_COUNT } from '../broker/operations.js'
import { capabilityIndex, projectRoles } from '../capability/taxonomy.js'
import { isReleasable } from '../lifecycle/release.js'
import { PERMISSION_KINDS, PERMISSION_LABEL, type PermissionKind } from '../permission/kinds.js'
import { PLANNING_RETRY_CAP } from '../planning/constants.js'
import { recommendRunbooks } from '../runbook/recommend.js'
import { TERMINAL } from '../task/state.js'
import { isStaffableTask } from './candidates.js'
import {
  boundReason,
  COOLDOWN_BY_KIND,
  COOLDOWN_MS,
  INTEGRATED_STALE_MS,
  MANAGER_ROLE,
  MEMORY_CANDIDATE_STALE_MS,
  REVIEWER_ROLE,
  REVIEW_CAP_GUARDRAIL,
  STALE_CANDIDATES_MIN,
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
 * (`no_reviewer`, `planning_stalled`'s `no_planner` reason, `ready_unstaffed`) are about who can be
 * DISPATCHED and have no asker to exclude, so they pass nothing and read exactly as they always
 * did.
 */
function roleHasHolder(world: SupervisorWorld, role: string, exceptSlaveId?: string): boolean {
  return world.slaves.some((slave) => slave.id !== exceptSlaveId && slave.runtimeRoles.includes(role))
}

/** Every capability the roster PROVIDES, deduplicated -- what a recommendation's coverage half is
 *  measured against. Not `projectRoles`: a runbook asks for capabilities, and a worker who has one
 *  without its runtime role still covers it (the `assign_capability` case). */
export function rosterCapabilities(world: SupervisorWorld): readonly string[] {
  return [...new Set(world.slaves.flatMap((slave) => slave.capabilities))]
}

/**
 * Can the question reach anybody at all? A message addressed to a named slave needs that slave to
 * still be in the workspace AND still working here; one addressed to a role needs a holder. A
 * question addressed to NEITHER can never be delivered, so it counts as unanswerable -- silently
 * dropping it would leave the asking task in `waiting` forever with nothing on any report to say
 * why.
 *
 * A RELEASED worker is not a recipient (M50 final review, Important 2). Its row is still here --
 * a release deletes nothing (R5) -- so the id lookup finds it and the question read as deliverable;
 * it is not, because the engagement is over and the worker will never run again. Excluded here and
 * from the prompt's own roster (`apps/orchestrator/src/inbox.ts`), so the asker learns in this tick
 * rather than when `waiting_stale` fires.
 *
 * `roleHasHolder` below is deliberately NOT filtered the same way: it answers who can be
 * DISPATCHED as a role, and a release empties `runtimeRoles`, so a released worker already falls
 * out of it -- unless a person put the roles back by hand, which is exactly the case where the
 * worker really can answer.
 */
function questionHasRecipient(world: SupervisorWorld, question: SupervisorQuestion): boolean {
  if (question.recipientSlaveId !== null) {
    return world.slaves.some((slave) => slave.id === question.recipientSlaveId && !slave.released)
  }
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

/** R3: what broke last, as a sentence appended to a stuck task's summary -- so the escalation a
 *  person reads says WHY, rather than sending them to the run log to find out. Empty for a task
 *  that has never failed, which is what keeps every summary that had no failure behind it saying
 *  exactly what it always said. */
function failureSentence(task: SupervisorTask): string {
  if (task.latestFailure === null) return ''
  return ` The last run failed: ${boundReason(task.latestFailure.reason)}.`
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
    // R2/R3: the facts a remedy is CHOSEN from (`readFailure`), carried onto every task situation
    // rather than onto `task_failed` alone -- `review_cap_blocked` reads the same reason to tell a
    // reviewer that never reached a verdict from one that judged the work and said no.
    //
    // Flat scalars, because that is what a fact is (`situationSchema`): the failure is spread into
    // three fields rather than nested, and the refused kinds are ONE string. A reader splits it on
    // the comma; a kind can never contain one (`PERMISSION_KINDS`).
    latestFailureReason: task.latestFailure === null ? null : boundReason(task.latestFailure.reason),
    latestFailureKind: task.latestFailure?.runKind ?? null,
    latestFailureAt: task.latestFailure?.at ?? null,
    deniedKinds: task.deniedKinds.join(','),
    failureCount: task.failureCount,
    retries: task.retries,
  }
}

/** The operations this worker has been refused lately, in {@link PERMISSION_KINDS}' own order.
 *  A denial of something nobody can grant is dropped, exactly as `permission_blocked` drops it. */
function deniedFor(world: SupervisorWorld, slaveId: string): readonly PermissionKind[] {
  return PERMISSION_KINDS.filter((kind) =>
    world.denials.some((denial) => denial.slaveId === slaveId && denial.kind === kind),
  )
}

/**
 * The three ways planning can be impossible (H4a), and the value `facts.reason` carries.
 *
 * A closed list rather than a free string: `candidates` branches on it and `carryOut` reads the
 * decision back off a stored row months later, so a fourth way of being stuck is a member here and
 * an arm there, never a sentence somebody wrote once.
 */
export const PLANNING_STALLED_REASONS = ['no_runtime', 'no_planner', 'cap_spent'] as const
export type PlanningStalledReason = (typeof PLANNING_STALLED_REASONS)[number]

/**
 * What each reason SAYS, to a person and to the decision prompt. One sentence each, naming the
 * thing that is missing and never the column it is missing from (`docs/ia.md` rule 3) -- except the
 * manager ROLE, which a person really does set by that name.
 *
 * `Record<PlanningStalledReason, ...>` is load-bearing for the reason every other total table here
 * is: a fourth reason fails the build rather than reaching a person as a bare identifier.
 */
const PLANNING_STALLED_SUMMARY: Record<PlanningStalledReason, (world: SupervisorWorld) => string> = {
  no_runtime: () =>
    'This project has no runtime configured, so not one model call can be made -- the goal cannot be planned, ' +
    'and no work could start even if it were.',
  no_planner: () => `A goal is set, no tasks exist, and no slave holds the "${MANAGER_ROLE}" role to plan it.`,
  cap_spent: (world) =>
    `Planning has failed ${String(world.planningFailuresSinceGoal)} time(s) against this goal, which is the ` +
    `limit (${String(PLANNING_RETRY_CAP)}), so nothing will try again by itself.`,
}

/**
 * WHY planning cannot start here, or null when it can (H4a).
 *
 * Three preconditions, all three of them about the BOARD rather than about any one row:
 *
 * - **A goal exists.** Nothing to plan is not a stall.
 * - **Nothing on the board came from this goal.** An EMPTY board is the first-plan case, exactly
 *   `dispatchPlanning`'s own `taskCount === 0`; a board whose highest `goalVersion` is behind the
 *   workspace's is the re-plan case, exactly `replanIntent`'s `goalMoved` (a hand-made task counts
 *   as version 0, the same reading `boardVersionOf` takes). A board that IS the plan for this goal
 *   is not stalled -- it is done being planned.
 * - **Nothing is planning right now.** A live planning run is planning working, not planning stuck.
 *
 * Then the reason, in ROOT-CAUSE order, because that is the order the remedies have to be applied
 * in: a project with no runtime cannot run the planner it would hire, and a project with no planner
 * has nothing to spend a retry on. Exactly one fires, and the next pass names the next one.
 */
function planningStalledReason(world: SupervisorWorld): PlanningStalledReason | null {
  if (world.goal === null || world.livePlanning) return null
  const boardVersion = world.tasks.reduce((highest, task) => Math.max(highest, task.goalVersion ?? 0), 0)
  if (world.tasks.length > 0 && world.goalVersion <= boardVersion) return null
  if (!world.runtimeConfigured) return 'no_runtime'
  if (!roleHasHolder(world, MANAGER_ROLE)) return 'no_planner'
  if (world.planningFailuresSinceGoal >= PLANNING_RETRY_CAP) return 'cap_spent'
  return null
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

  // planning_stalled (H4a): a goal was set and nothing is ever going to turn it into tasks.
  //
  // This is `no_planner` WIDENED, and `no_planner` is retired: that kind only ever covered one of
  // the three ways planning can be impossible, so the other two were silences. On 2026-09-21 a
  // project created with no runtime failed planning twice in the same second -- the retry cap spent
  // by an infrastructure error nobody could see -- and neither the tick nor the Supervisor said a
  // word about it, for ever.
  //
  // `planningStalledReason` is the whole predicate; it returns null when planning is fine, when it
  // is genuinely in flight, and when the board is already the plan for this goal.
  const stalled = planningStalledReason(world)
  if (stalled !== null) {
    add({
      kind: 'planning_stalled',
      // COMPOUND (`permission_blocked`'s shape): the three reasons are remedied in sequence, and a
      // bare workspace id would make the second remedy wait out the first one's cooldown.
      subjectId: `${world.workspaceId}:${stalled}`,
      summary: PLANNING_STALLED_SUMMARY[stalled](world),
      // Exactly two facts, both flat scalars (`situationSchema`): WHICH of the three it is, and
      // which goal it is about -- the pair `carryOut` and a reader months later need, and the pair
      // `candidates` branches on.
      facts: { reason: stalled, goalVersion: world.goalVersion },
    })
  }

  // runbook_recommended: before the first plan, and only then. A goal exists, no runbook has been
  // adopted, and the board is empty -- the one moment at which adopting a way of working changes
  // what the next run is asked for. `recommendRunbooks` returns nothing when no keyword is in the
  // goal, and then there is no situation at all: silence beats a proposal about a goal the rules
  // have no opinion on (R5).
  if (world.goal !== null && world.runbook === null && world.tasks.length === 0) {
    const top = recommendRunbooks(world.goal, world.runbooks, rosterCapabilities(world), world.taxonomy)[0]
    if (top !== undefined) {
      add({
        kind: 'runbook_recommended',
        subjectId: world.workspaceId,
        summary: `This project has a goal, no tasks yet, and no way of working chosen. "${top.runbook.name}" fits it: ${top.rationale}`,
        facts: { runbook: top.runbook.key, score: top.score, matched: top.matchedKeywords.join(', '), stages: top.runbook.stages.length },
      })
    }
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
          // R3: the reason rides on the summary because the summary is what `escalate_to_human`
          // carries -- a person asked to look at a parked task should not have to go and find the
          // run that parked it.
          summary:
            `Task "${task.title}" is blocked and nothing but a human decision moves it ` +
            `(attempt ${task.attempt} of ${task.maxAttempts}).${failureSentence(task)}`,
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
        // Plan erratum E6: the runbook stage's escalation sentence, appended here because a
        // `task_failed` situation is DERIVED on every tick -- `rejectTask` has nowhere to write it,
        // and `candidates` already builds `escalate_to_human` out of this summary.
        // R3 puts the failure reason in front of the stage sentence: what broke is the fact, and
        // the escalation sentence is the instruction that follows from it.
        summary:
          `Task "${task.title}" failed and ${task.dependents} task(s) depend on it.` +
          failureSentence(task) +
          (task.stageEscalation === null ? '' : ` ${task.stageEscalation}`),
        facts: { ...taskFacts(task), ...(task.stage === null ? {} : { stage: task.stage }) },
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
    // {@link isStaffableTask}, the one predicate three readings of "what is missing" now share
    // (M47 final review, Important 2) -- this loop's own rule, promoted to the shared one.
    if (!isStaffableTask(t)) continue
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
  // The summary is read by a person on the Supervisor panel and on the Organization page, so it is
  // written in the taxonomy's WORDS, never in its keys (M47 final review, Minor 5a; `docs/ia.md`
  // rule 3). The key itself stays on `subjectId` and on `facts.capability` -- which is where every
  // machine reader (the decision's key, the need row's testid, the panel's `data-` attributes)
  // takes it from, so labelling the sentence loses nothing.
  const labels = capabilityIndex(world.taxonomy)
  for (const [capability, waiting] of unstaffedCapabilities) {
    const role = projectRoles([capability], world.taxonomy)[0] ?? ''
    add({
      kind: 'capability_unstaffed',
      subjectId: capability,
      summary: `${waiting.length} startable task(s) need ${labels.get(capability)?.label ?? capability} and no slave can be dispatched as ${role}.`,
      facts: { capability, role, readyTasks: waiting.length, firstTaskId: waiting[0]?.id ?? null },
    })
  }

  // run_looping (M51 R3): a run the sweep has already STEERED, whose sentence somebody has to
  // actually deliver. Five clauses, and each one is a way of being wrong about it:
  //   - level is exactly `steered`. `none` is healthy; `constrained` is a rung the system owns and
  //     the Supervisor is not consulted about.
  //   - the run is still `working`. A paused, stopping or terminal run cannot be steered, and the
  //     control verb would refuse it -- which would be a `failed` decision row for a race nobody
  //     can act on.
  //   - the trip is known. `trip`/`detail`/`count` come off the newest `run.breaker` row; a run
  //     whose event the log has lost has no sentence to send, and inventing one would be the
  //     Supervisor guessing.
  //   - the sentence is UNDELIVERED (fix round 1, Important 3). `breakerTrips` counts every rung
  //     this run has climbed and `breakerSteers` counts the sentences actually sent, so
  //     `steers < trips` is exactly "a rung nobody has spoken to yet" -- the fact the summary two
  //     lines below asserts in words. Without it a steered run that resumes to `working` and does
  //     not de-escalate inside `BREAKER_COOLDOWN_MS` (120 s, twice the beat) is raised again on the
  //     SAME stale trip, and the second steer says "has not been told so yet" about a run that was.
  //     A column comparison rather than a cleared trip: the trip fields are a projection of the
  //     newest `run.breaker` row, which is history and must not be erased to record a delivery.
  //   - the run has steers left. `STEERS_PER_RUN_MAX` is enforced HERE as well as in the detector,
  //     because a de-escalated run comes back round and the situation is what a person reads.
  for (const run of world.runs) {
    if (run.breakerLevel !== 'steered') continue
    if (run.status !== 'working') continue
    if (run.trip === null || run.detail === null || run.count === null) continue
    if (run.breakerSteers >= run.breakerTrips) continue
    if (run.breakerSteers >= STEERS_PER_RUN_MAX) continue
    const denied = deniedFor(world, run.slaveId)
    add({
      kind: 'run_looping',
      subjectId: run.id,
      summary:
        `This run has been going in circles (${BREAKER_TRIP_LABEL[run.trip].toLowerCase()}, ` +
        `${String(run.count)}x) and has not been told so yet.`,
      facts: {
        runId: run.id,
        slaveId: run.slaveId,
        taskId: run.taskId,
        trip: run.trip,
        detail: run.detail,
        count: run.count,
        level: run.breakerLevel,
        steers: run.breakerSteers,
        // R3: the walls THIS worker keeps meeting, so `candidates` can put them in the steer --
        // a run going in circles is very often a run trying the one thing it is not allowed to do.
        // Only the kinds a person could actually grant (a pre-M52 row spells `'run tests'`, an
        // ungoverned tool spells `ungoverned_tool`), in the vocabulary's own order rather than the
        // loader's, and ABSENT rather than empty when nothing has been refused -- the `stage` fact
        // on a `task_failed` situation is the same shape, for the same reason.
        ...(denied.length === 0 ? {} : { deniedKinds: denied.join(',') }),
      },
    })
  }

  // permission_blocked (M52 R5): a worker that keeps meeting the same wall. Four clauses, each one
  // a way of being wrong about it:
  //   - the kind is one of the six. A pre-M52 row spells `'run tests'` and a denial of an
  //     ungoverned tool spells `ungoverned_tool`; neither names something a person can grant, and
  //     proposing a grant for either would put an unactionable row in front of somebody.
  //   - the count has reached PERMISSION_TRIP_COUNT. One refusal is a worker trying something.
  //   - the worker is IN THE WORLD. A released or deleted worker has no wall to move, and
  //     `applyDecision` would refuse `slave_not_found` on the proposal a person approved.
  //   - the worker is not released. A released worker's grants are not the reason it is idle.
  for (const denial of world.denials) {
    if (!(PERMISSION_KINDS as readonly string[]).includes(denial.kind)) continue
    if (denial.count < PERMISSION_TRIP_COUNT) continue
    const blocked = world.slaves.find((candidate) => candidate.id === denial.slaveId)
    if (blocked === undefined || blocked.released) continue
    add({
      kind: 'permission_blocked',
      // `<slaveId>:<kind>`, not the bare slave id: one worker can be blocked on two operations at
      // once and the situation key is `(kind, subjectId)` (plan decision D6). `facts.slaveId`
      // below is the bare id, so nothing downstream ever parses this.
      subjectId: `${denial.slaveId}:${denial.kind}`,
      summary:
        `${blocked.name} has been refused \u2018${PERMISSION_LABEL[denial.kind as PermissionKind]}\u2019 ` +
        `${String(denial.count)} times and cannot get past it.`,
      facts: {
        slaveId: denial.slaveId,
        kind: denial.kind,
        count: denial.count,
        runId: denial.latestRunId,
      },
    })
  }

  // ready_unstaffed: keyed by the missing ROLE, so N startable tasks blocked on one absent role
  // are one situation with one decision -- not N proposals a human has to approve N times.
  const unstaffedRoles = new Map<string, SupervisorTask[]>()
  for (const task of world.tasks) {
    if (!isStaffableTask(task)) continue
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

  // engagement_over: a worker brought in for ONE assignment, whose assignment is over. The subject
  // is the SLAVE, not the task -- what is over is this person's engagement, and there is exactly one
  // situation per worker however many rows their runs left behind.
  const statusByTask = new Map(world.tasks.map((one) => [one.id, one.status] as const))
  for (const worker of world.slaves) {
    const engagementTaskStatus =
      worker.engagementTaskId === null ? null : (statusByTask.get(worker.engagementTaskId) ?? null)
    const openAssignedTasks = world.tasks.filter(
      (one) => one.assigneeId === worker.id && !TERMINAL.includes(one.status),
    ).length
    const releasable = isReleasable({
      lifecycle: worker.lifecycle,
      released: worker.released,
      busy: worker.busy,
      engagementTaskStatus,
      openAssignedTasks,
    })
    if (!releasable) continue
    // The task's TITLE, not its id: this sentence is read on the Supervisor panel and in the
    // decision row a year later, and a uuid is not something anybody can judge an offer by. The id
    // stays on `facts`, which is where every machine reader takes it from.
    const title = world.tasks.find((one) => one.id === worker.engagementTaskId)?.title ?? 'one assignment'
    add({
      kind: 'engagement_over',
      subjectId: worker.id,
      summary: `${worker.name} was brought in for "${title}" and that assignment is over, with nothing else open for them.`,
      facts: {
        slaveId: worker.id,
        name: worker.name,
        engagementTaskId: worker.engagementTaskId,
        engagementTaskStatus,
      },
    })
  }

  // memory_candidates_piling: workers keep reporting and nothing keeps verifying. The subject is
  // the WORKSPACE -- five stale candidates are one habit, not five situations.
  if (world.staleMemoryCandidates >= STALE_CANDIDATES_MIN) {
    add({
      kind: 'memory_candidates_piling',
      subjectId: world.workspaceId,
      summary: `${String(world.staleMemoryCandidates)} thing(s) a worker reported have sat unverified for over a day, so none of them is knowledge anybody can be given.`,
      facts: { candidates: world.staleMemoryCandidates, olderThanHours: MEMORY_CANDIDATE_STALE_MS / 3_600_000 },
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
 * whose last decision stopped being open less than its cooldown ago: `COOLDOWN_MS`, unless
 * {@link COOLDOWN_BY_KIND} names a shorter one for that kind (M51 R3).
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
    // M51 R3: the per-kind override, defaulting to the standing fifteen minutes. The `pending`
    // clause is unchanged and is checked first: an OPEN decision blocks its key however long it has
    // been open, whatever the cooldown says, because a second proposal about a question a human is
    // still looking at is the thing the cooldown exists to stop.
    const cooldownMs = COOLDOWN_BY_KIND[decision.situationKind] ?? COOLDOWN_MS
    const cooling = decision.status === 'pending' || world.now - anchor <= cooldownMs
    if (cooling) blocked.add(key(decision.situationKind, decision.subjectId))
  }
  return situations.filter((situation) => !blocked.has(key(situation.kind, situation.subjectId)))
}

/**
 * The slaves a staffing action could add `role` to: not busy (a running slave's roles must not
 * change under it), not already holding it, and NOT RELEASED (M50 R3) -- a released worker's role
 * set is empty on purpose, so without this clause it would be the first candidate every staffing
 * offer named. Lives here rather than in `candidates.ts` because it is the same "who holds what"
 * reading the predicates above are built on.
 */
export function staffableSlaves(world: SupervisorWorld, role: string): readonly SupervisorSlave[] {
  return world.slaves.filter((slave) => !slave.busy && !slave.released && !slave.runtimeRoles.includes(role))
}
