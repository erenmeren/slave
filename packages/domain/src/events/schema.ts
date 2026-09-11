import { z } from 'zod'
import { err, ok, type Result } from '../result.js'
import { MEMORY_SCOPES, MEMORY_SOURCE_KINDS, MEMORY_STATUSES, MEMORY_TYPES } from '../memory/types.js'
import { ACTION_KINDS, DECIDERS, TIERS } from '../supervisor/actions.js'
import { SITUATION_KINDS } from '../supervisor/situations.js'

const envelope = {
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  workspaceId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  slaveId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  actor: z.enum(['human', 'slave', 'system']),
  // M23 F6: who caused this event. Nullable/optional -- the CLI and the orchestrator write
  // events with no user, and every row from before this field existed reads back undefined.
  userId: z.string().min(1).nullable().optional(),
}

/**
 * M48 R2: how well the plan this event describes follows the workspace's adopted runbook.
 *
 * SOFT, and the field names say so: `stagesMissing` is a measurement, never a refusal -- a plan
 * that skips a stage lands exactly as it was written, and the gap is what an operator reads.
 * Optional on both events, because a workspace with no runbook adopted produces neither.
 */
const runbookAdherence = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  stagesCovered: z.array(z.string().min(1)),
  stagesMissing: z.array(z.string().min(1)),
})

/** One member per event type. The payload shape is bound to the type by construction. */
export const executionEventSchema = z.discriminatedUnion('type', [
  // M40 t1: `goalVersion` is the plan version the task was derived from, `null` for a hand-made
  // one. OPTIONAL, like every other widening of an existing arm in this file (M19 B1, M23 F6, M27,
  // M36 t1): `packages/events/src/read.ts` THROWS on a row this schema cannot parse -- "the write
  // gate guarantees every row parses, so a failure here means that guarantee has been bypassed" --
  // so a required field would make every `task.created` written before this milestone unreadable
  // and take the activity stream down with it. Every writer as of M40 always sets it.
  z.object({
    ...envelope,
    type: z.literal('task.created'),
    payload: z.object({ title: z.string(), goalVersion: z.number().int().nonnegative().nullable().optional() }),
  }),
  z.object({ ...envelope, type: z.literal('task.started'), payload: z.object({ title: z.string() }) }),
  z.object({ ...envelope, type: z.literal('task.done'), payload: z.object({ branch: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('task.rework'),
    payload: z.object({ reason: z.string(), attempt: z.number().int().positive() }),
  }),
  z.object({ ...envelope, type: z.literal('run.started'), payload: z.object({ sessionId: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('run.tool_call'),
    payload: z.object({ name: z.string(), summary: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('run.tool_denied'),
    payload: z.object({
      tool: z.string(),
      capability: z.string(),
      // M19 B1 writes toolUseId (string | null); rows from before B1 lack it. Typed in M21 C2 so a typed reader keeps it.
      toolUseId: z.string().nullable().optional(),
    }),
  }),
  z.object({ ...envelope, type: z.literal('run.paused'), payload: z.object({ atStep: z.number().int() }) }),
  z.object({ ...envelope, type: z.literal('run.resumed'), payload: z.object({ sessionId: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('slave.message_sent'),
    payload: z.object({
      // Pre-M36: a human instruction's classification. Optional now, not required -- a
      // worker-authored message (M36 t1) never carries one; see `kind` below for its own axis.
      category: z
        .enum(['instruction', 'feedback', 'context', 'priority_change', 'question_response'])
        .nullable()
        .optional(),
      body: z.string().min(1),
      // M36 t1: `sendMessage` (packages/control/src/messaging.ts) always sets the fields below;
      // all remain optional here so the pre-M36 minimal payload above still parses.
      messageId: z.string().min(1).optional(),
      kind: z.enum(['question', 'answer', 'information', 'blocker', 'handoff']).optional(),
      threadId: z.string().min(1).optional(),
      replyToId: z.string().min(1).nullable().optional(),
      recipientSlaveId: z.string().min(1).nullable().optional(),
      recipientRole: z.string().min(1).nullable().optional(),
      expectsReply: z.boolean().optional(),
      /** M42 t1 (spec R6d): WHO answered, by name -- the CLI's operator, or `supervisor`, which the
       *  envelope's closed three-way `Actor` has no member for. `answerQuestion`
       *  (`packages/control/src/messaging.ts`) has written this since M36 t3; the payload object is
       *  not strict, so an undeclared field was silently dropped on every read instead of failing
       *  anything. Optional, because a worker-authored message never carries one. */
      answeredBy: z.string().min(1).optional(),
    }),
  }),
  // M39 t2: `reassignQuestion` (packages/control/src/messaging.ts) put an unanswered question in
  // front of a worker who can answer it. Deliberately NOT a `slave.message_sent`: nothing was
  // sent. The question row itself moved -- `recipientSlaveId` set, `recipientRole` cleared -- and
  // a reader asking "why is this question suddenly in Maya's inbox" needs to see the move, with
  // both ends of it.
  //
  // `from` carries BOTH columns, each nullable, because exactly one of them was set before the
  // move and which one is the whole difference between "the role nobody was holding" and "the
  // worker who was busy". `decisionId` names the Supervisor decision that asked for it, or null
  // when a human re-addressed it by hand. `actor` is WHO, by name (`slave.profile_changed`'s
  // precedent): the envelope `actor` is the closed three-way enum, so `supervisor` -- the one
  // caller that is neither a person nor a worker -- has nowhere else to be recorded.
  z.object({
    ...envelope,
    type: z.literal('slave.message_reassigned'),
    payload: z.object({
      messageId: z.string().min(1),
      decisionId: z.string().min(1).nullable(),
      from: z.object({ role: z.string().min(1).nullable(), slaveId: z.string().min(1).nullable() }),
      to: z.object({ slaveId: z.string().min(1) }),
      actor: z.string().min(1),
    }),
  }),
  // M37 t3: `setProfile` (packages/control/src/profile.ts) wrote a persona. Only a SLAVE target
  // reaches the log (spec erratum E3) -- a template and a catalog slave belong to the company
  // catalog, which has no workspace and therefore no event stream to append to -- but the payload
  // still names which of the three levels was written, because the effective profile a slave runs
  // with is resolved through all three and a reader of one workspace's log needs to know that the
  // text it is looking at is the worker's own override rather than something inherited.
  //
  // The HASH, not the text: a profile is up to `PROFILE_MAX_CHARS` (16k) characters and is already
  // stored on its own row; what a log reader wants from it is "did this change, and is it the same
  // text run 41 saw" -- which is exactly what the `RunContext` manifest's own `profile.sha256`
  // answers, computed the same way over the same raw text. `null` is a cleared profile.
  z.object({
    ...envelope,
    type: z.literal('slave.profile_changed'),
    payload: z.object({
      target: z.enum(['slave', 'template', 'company_slave']),
      targetId: z.string().min(1),
      sha256: z.string().min(1).nullable(),
      /** WHO, by name -- `answerQuestion`'s `answeredBy` precedent, not the envelope's `actor`,
       *  which is the three-way category (`human` for every write of this event, since spec §1
       *  forbids model output from touching a profile at all). */
      actor: z.string().min(1),
    }),
  }),
  // M37 t3: `setRuntimeRoles` changed the set the scheduler, the review/planning staffing queries
  // and message role-addressing all match on. The whole list rather than a hash: it is short, and
  // an operator reading "why did nothing get dispatched to Maya" needs to SEE it. An empty array is
  // a real value -- the parked, undispatchable state (spec §7).
  z.object({
    ...envelope,
    type: z.literal('slave.runtime_roles_changed'),
    payload: z.object({
      slaveId: z.string().min(1),
      roles: z.array(z.string().min(1)),
      /** WHO, by name -- see `slave.profile_changed`'s own field. */
      actor: z.string().min(1),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('guardrail.tripped'),
    payload: z.object({ guardrail: z.string(), detail: z.string() }),
  }),
  z.object({ ...envelope, type: z.literal('task.verifying'), payload: z.object({ commandCount: z.number().int() }) }),
  z.object({ ...envelope, type: z.literal('task.verify_passed'), payload: z.object({ branch: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('task.verify_failed'),
    payload: z.object({
      command: z.string(),
      exitCode: z.number().int(),
      // M48 R6/plan erratum E11: which runbook stage's gate failed, when a stage gate is what
      // failed. Absent for a workspace verify command and for every row written before M48.
      stage: z.string().min(1).optional(),
    }),
  }),
  z.object({ ...envelope, type: z.literal('task.failed'), payload: z.object({ reason: z.string() }) }),
  z.object({ ...envelope, type: z.literal('run.output'), payload: z.object({ text: z.string() }) }),
  z.object({ ...envelope, type: z.literal('run.pause_requested'), payload: z.object({ requestedBy: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('run.resume_requested'),
    payload: z.object({ requestedBy: z.string(), message: z.string().nullable() }),
  }),
  z.object({ ...envelope, type: z.literal('run.stopped'), payload: z.object({ reason: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('run.succeeded'),
    // costUsd is nullable (M12 Task 6): SlaveRun.costUsd dropped its NOT NULL/DEFAULT(0) so an
    // unmeasured run's true cost -- unknown -- can be recorded honestly instead of as a false
    // zero. A provider that does not report cost produces a `null` here, not a `0`.
    payload: z.object({ numTurns: z.number().int(), costUsd: z.number().nullable() }),
  }),
  z.object({ ...envelope, type: z.literal('run.failed'), payload: z.object({ reason: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('task.dependency_added'),
    payload: z.object({ dependsOnTaskId: z.string(), dependsOnTitle: z.string(), requestedBy: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('task.dependency_removed'),
    payload: z.object({ dependsOnTaskId: z.string(), dependsOnTitle: z.string(), requestedBy: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('task.review_started'),
    payload: z.object({ title: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('task.review_approved'),
    payload: z.object({ reason: z.string() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('task.review_rejected'),
    payload: z.object({ reason: z.string(), attempt: z.number().int().positive() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('task.merge_failed'),
    payload: z.object({ reason: z.string() }),
  }),
  // M40 t1: which `GoalVersion` row this set created, and the sha256 of its text -- the two facts
  // that make a goal edit traceable without reading the `GoalVersion` table. Optional for the same
  // back-compat reason as `task.created` above: every `workspace.goal_set` row written before M40
  // carries neither.
  z.object({
    ...envelope,
    type: z.literal('workspace.goal_set'),
    payload: z.object({
      goal: z.string().min(1),
      version: z.number().int().positive().optional(),
      sha256: z.string().min(1).optional(),
      // M45 R3: the words a person typed when they asked for a change, kept beside the composed
      // document so the timeline can show the REQUEST rather than the diff of the goal it
      // produced. Optional, and null on every version written by `set-goal` or by the Settings
      // editor -- those set a whole goal rather than asking for a change.
      request: z.string().min(1).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('workspace.plan_created'),
    payload: z.object({
      goal: z.string().min(1),
      // M40 t1: the goal version the plan derived from -- the version every task it created is
      // stamped with. Optional for back-compat; always written from M40 on.
      goalVersion: z.number().int().nonnegative().optional(),
      tasks: z
        .array(z.object({ id: z.string().min(1), title: z.string().min(1), role: z.string().min(1) }))
        .min(1),
      /** M47 R3: capability keys the planner asked for that the taxonomy does not have. Dropped
       *  from the task (nothing matches on a key nobody defined) and recorded here, because a
       *  silently ignored vocabulary is how an operator concludes the feature does not work.
       *  Optional: every event written before M47 has none. */
      droppedCapabilities: z.array(z.string().min(1)).optional(),
      /** M48 R2: the adopted runbook and how far this plan covers it. Absent when no runbook is
       *  adopted, and on every event written before M48. */
      runbook: runbookAdherence.optional(),
    }),
  }),
  // M40 §2: a re-plan run started, because the goal moved on a board that already had tasks. The
  // dedup key for "one re-plan per goal version" (spec §1) is this event's `version`, and `runId`
  // is what lets a later tick tell a re-plan still in flight from one that failed and may retry.
  z.object({
    ...envelope,
    type: z.literal('workspace.replan_started'),
    payload: z.object({ version: z.number().int().positive(), runId: z.string().min(1) }),
  }),
  // The re-plan concluded. All four lists are ids, and all four may be empty: `added` is the
  // tasks that were created at once, `proposedCancellations` the ones a human is now being asked to
  // approve, `droppedCancellations` the ones the model asked for that the status rule REFUSED
  // -- carried with the status that refused them, so a refused cancellation is recorded rather than
  // silently forgotten (spec §1) -- and `failedProposals` the cancellable ones that did NOT become
  // a proposal for any other reason: a Supervisor cooldown or a switched-off Supervisor refusing
  // the record, or the record itself throwing. Together the three cancellation lists account for
  // every id the model asked to cancel, which is the whole point of writing them down.
  //
  // `failedProposals` is OPTIONAL for the same reason every other widening in this file is: it was
  // added in M40 t3 fix round 1, after the first `workspace.replanned` rows were already written,
  // and `packages/events/src/read.ts` throws on a row this schema cannot parse. Absent means the
  // empty list; every writer sets it.
  z.object({
    ...envelope,
    type: z.literal('workspace.replanned'),
    payload: z.object({
      version: z.number().int().positive(),
      runId: z.string().min(1),
      added: z.array(z.string().min(1)),
      proposedCancellations: z.array(z.string().min(1)),
      droppedCancellations: z.array(z.object({ taskId: z.string().min(1), status: z.string().min(1) })),
      failedProposals: z.array(z.string().min(1)).optional(),
      /** M47 R3: capability keys the planner asked for that the taxonomy does not have. Dropped
       *  from the task (nothing matches on a key nobody defined) and recorded here, because a
       *  silently ignored vocabulary is how an operator concludes the feature does not work.
       *  Optional: every event written before M47 has none. */
      droppedCapabilities: z.array(z.string().min(1)).optional(),
      /** M48 R2: the same adherence block `workspace.plan_created` carries, measured over what THIS
       *  DELTA added -- never over the board it landed on. A re-plan is judged by the work it
       *  asked for, and a board carrying a first plan's five stages would report full coverage for
       *  a delta that touched one of them. Absent when the project has adopted no runbook. */
      runbook: runbookAdherence.optional(),
    }),
  }),
  // M40 §4: `cancelTask` took a task off the board -- an operator's own call, or an approved
  // `stale_task` proposal. `goalVersion` is the task's own stamp (null for a hand-made task), so
  // the log says which requirement's work was dropped.
  z.object({
    ...envelope,
    type: z.literal('task.cancelled'),
    payload: z.object({ reason: z.string().min(1), goalVersion: z.number().int().nonnegative().nullable() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('workspace.company_assigned'),
    payload: z.object({
      company: z.string().min(1),
      // Deliberately NO .min(1): a pure re-sync that added nobody still emits with an empty array.
      workers: z.array(
        z.object({ companySlaveId: z.string().min(1), name: z.string().min(1), role: z.string().min(1) }),
      ),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('workspace.settings_changed'),
    /**
     * Which setting moved, and both ends of the move (M13 §6.1). `from`/`to` are a union rather
     * than two typed members because the two fields carry different shapes -- a `ProviderKind`
     * string or a USD number -- and `null` is a real value on both: "no provider configured" and
     * "this workspace is not budgeted".
     *
     * M38 t2 adds the Supervisor's two settings to the same event rather than inventing a second
     * one: they are project configuration, they move through the same kind of verb, and an
     * operator reading "what changed about this project" wants one stream. `supervisorEnabled`
     * is what widened `from`/`to` to booleans. `supervisorProfile` never carries its TEXT -- the
     * persona can be long and is the model's instructions, so the payload carries its sha256 (or
     * `null` for cleared), the same shape `slave.profile_changed` uses.
     */
    payload: z.object({
      field: z.enum(['provider', 'budgetUsd', 'supervisorEnabled', 'supervisorProfile']),
      from: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      to: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('workspace.created'),
    payload: z.object({
      name: z.string().min(1),
      repoPath: z.string().min(1),
      baseBranch: z.string().min(1),
      verifyCommands: z.array(z.string().min(1)).min(1),
      provider: z.string().nullable(),
    }),
  }),
  // M27 §3: archived keeps every row; the payload is the footprint the confirm showed.
  z.object({
    ...envelope,
    type: z.literal('workspace.archived'),
    payload: z.object({
      name: z.string().min(1),
      departments: z.number().int().nonnegative(),
      slaves: z.number().int().nonnegative(),
      tasks: z.number().int().nonnegative(),
      runs: z.number().int().nonnegative(),
    }),
  }),
  z.object({ ...envelope, type: z.literal('workspace.restored'), payload: z.object({ name: z.string().min(1) }) }),
  // M23 B2: `collectTaskWorktree` removed a terminal task's worktree. M50 R3 adds the third reason:
  // a WORKER was released and the trees its runs were holding went with the engagement.
  z.object({
    ...envelope,
    type: z.literal('task.worktree_collected'),
    payload: z.object({ path: z.string().min(1), reason: z.enum(['aged', 'operator', 'released']), branch: z.string().nullable() }),
  }),
  // M23 D1 / M25 §3.1: one of the roster and department control verbs in `org.ts` edited an
  // slave or a team (or created/deleted one). `to: null` is `deleted`'s own shape and `from: null`
  // is `created`'s own shape (M25) -- every other field always carries a string on both sides.
  //
  // M27 §4.1/§4.2 (controller ruling R16): `deleteSlave` writes `runs` and `deleteTeam` writes
  // `slaves` + `runs` "so the timeline says what went". Both OPTIONAL, for two reasons: every
  // `org.changed` row written before M27 -- and every one written by the six non-delete fields --
  // carries neither, and `z.object` STRIPS keys it does not declare, so leaving them out here
  // silently deleted the counts from `parseExecutionEvent` and every `ExecutionEvent`-typed
  // reader downstream of it.
  z.object({
    ...envelope,
    type: z.literal('org.changed'),
    payload: z.object({
      entity: z.enum(['slave', 'team']),
      id: z.string().min(1),
      /** `capabilities` is M47 t2's: `hireFromTemplate` REUSED a worker and merged new capability
       *  keys into it without its runtime role set moving. `from`/`to` are the key lists, comma
       *  separated, so the timeline says what the worker gained. `lifecycle` is M50 R4's: a PERSON
       *  moved a worker between `permanent`, `project` and `ephemeral`. `from`/`to` are the
       *  lifecycle values. */
      field: z.enum(['name', 'role', 'model', 'deleted', 'created', 'team', 'capabilities', 'lifecycle']),
      from: z.string().nullable(),
      to: z.string().nullable(),
      /** `deleteSlave`/`deleteTeam` only (M27): runs the cascade took with the row. */
      runs: z.number().int().nonnegative().optional(),
      /** `deleteTeam` only (M27): slaves the cascade took with the department. */
      slaves: z.number().int().nonnegative().optional(),
    }),
  }),
  // M35 t2: `confirmIntegration` (packages/control/src/integration.ts) stamped `Task.integratedAt`
  // by hand -- the task was already `done` under `!autoMerge`; a human is now saying its branch
  // has actually reached the base branch. Empty payload: the envelope's own `taskId` and `ts`
  // already say which task and when.
  z.object({ ...envelope, type: z.literal('task.integrated'), payload: z.object({}) }),
  // M35 t5: `unblockTask` (packages/control/src/unblock.ts) moved a `blocked` task back to
  // `rework` -- one of the four parks (`tick.ts`, `verify.ts`, `review.ts`,
  // `packages/control/src/stop.ts`) had parked it and nothing moved it out. `attempt` and
  // `maxAttempts` are the values AFTER the write: `attempt` is unchanged (this verb never resets
  // it), `maxAttempts` is raised only when the task was at or past it and the caller passed
  // `allowAnotherAttempt` -- carrying both here is what lets an operator reading the log tell "an
  // ordinary unblock" from "the cap was raised to let this happen" without a second lookup.
  z.object({
    ...envelope,
    type: z.literal('task.unblocked'),
    payload: z.object({
      attempt: z.number().int().nonnegative(),
      maxAttempts: z.number().int().positive(),
      /** M42 t1 (spec R6b): where the task actually went -- `rework`, or `reviewing` for a task that
       *  was parked while it was under review. Optional on read: every row written before M42
       *  records the two counters and nothing else. */
      status: z.enum(['rework', 'reviewing']).optional(),
    }),
  }),
  // M38 t1: the five events the Supervisor's control verbs write (spec section 2). All appended by
  // `packages/control/src/supervisor.ts`, and all with `actor: 'system'` EXCEPT the
  // `supervisor.resolved` that an approve or a reject emits, which says `actor: 'human'` because a
  // person resolved it (the expiry sweep's `supervisor.resolved` is `system`, as nobody resolved
  // that one). The envelope enum has no `supervisor` member and gaining one would touch every
  // reader (spec erratum E4); the Supervisor names itself in the payload the verbs it calls write
  // instead.
  //
  // `situationKind`, `action.kind`, `tier` and `decidedBy` validate against the DOMAIN unions
  // (`SITUATION_KINDS`, `ACTION_KINDS`, `TIERS`, `DECIDERS`) rather than re-spelt string literals,
  // so a new situation or action becomes writable to the timeline the moment the rules can produce
  // it -- and a value the rules can NEVER produce can never be appended.
  //
  // `action` carries the kind only, not its parameters: the whole `Action` (with its task/slave/
  // message ids) is already on the `SupervisorDecision` row this event's `decisionId` points at,
  // and duplicating it here would give a reader two copies to disagree about.
  z.object({
    ...envelope,
    type: z.literal('supervisor.decided'),
    payload: z.object({
      decisionId: z.string().min(1),
      situationKind: z.enum(SITUATION_KINDS),
      subjectId: z.string().min(1),
      tier: z.enum(TIERS),
      decidedBy: z.enum(DECIDERS),
      action: z.object({ kind: z.enum(ACTION_KINDS) }),
    }),
  }),
  // Written alongside `supervisor.decided` when the tier made the decision a `pending` proposal:
  // the one event an operator's "what is waiting on me" view can filter on, carrying the deadline
  // after which `expirePendingDecisions` retires it unanswered.
  z.object({
    ...envelope,
    type: z.literal('supervisor.proposed'),
    payload: z.object({
      decisionId: z.string().min(1),
      situationKind: z.enum(SITUATION_KINDS),
      subjectId: z.string().min(1),
      action: z.object({ kind: z.enum(ACTION_KINDS) }),
      expiresAt: z.string().datetime(),
    }),
  }),
  // The action actually reached the world through a control verb.
  z.object({
    ...envelope,
    type: z.literal('supervisor.applied'),
    payload: z.object({ decisionId: z.string().min(1), action: z.object({ kind: z.enum(ACTION_KINDS) }) }),
  }),
  // A `pending` decision left that state. `reason` is the rejecting human's words where there are
  // any, and null otherwise -- an approval and an expiry both carry none.
  z.object({
    ...envelope,
    type: z.literal('supervisor.resolved'),
    payload: z.object({
      decisionId: z.string().min(1),
      outcome: z.enum(['approved', 'rejected', 'expired']),
      reason: z.string().nullable(),
    }),
  }),
  // The verb behind an applied decision refused it. `reason` is the `refusalText` of that refusal:
  // a Supervisor action that cannot be carried out is recorded, never thrown (spec section 4).
  z.object({
    ...envelope,
    type: z.literal('supervisor.failed'),
    payload: z.object({
      decisionId: z.string().min(1),
      action: z.object({ kind: z.enum(ACTION_KINDS) }),
      reason: z.string().min(1),
    }),
  }),
  // M48 R5: a runbook was adopted for this workspace -- by a human through `adopt-runbook` or the
  // Overview, or by a human approving the Supervisor's `adopt_runbook` proposal. `cleared` is the
  // one that took a runbook away, naming the runbook it removed (plan erratum E9); absent means
  // false, which is every adoption.
  z.object({
    ...envelope,
    type: z.literal('workspace.runbook_adopted'),
    payload: z.object({
      runbookId: z.string().min(1),
      key: z.string().min(1),
      name: z.string().min(1),
      cleared: z.boolean().optional(),
    }),
  }),
  // M49 R4: a memory was written. The payload is what a reader needs WITHOUT loading the row --
  // what kind of knowledge, whose, and whether it is already knowledge or still a claim. The task
  // travels on the ENVELOPE (plan erratum E13), which is where `appendEvent` indexes it and where
  // the Activity page's `?tasks=` filter reads it.
  //
  // Both payloads are `.strict()`, which no other arm in this file is: erratum E13's rule is that
  // the task rides on the ENVELOPE, and zod's default STRIPS an unknown key rather than refusing
  // it -- so a writer that put a `taskId` beside `memoryId` would parse clean and silently record
  // a second, unindexed copy of the task nobody reads. There is no history of either type to be
  // tolerant of (both are born here), which is the condition the rest of the file lacks.
  z.object({
    ...envelope,
    type: z.literal('memory.recorded'),
    payload: z
      .object({
        memoryId: z.string().min(1),
        type: z.enum(MEMORY_TYPES),
        scope: z.enum(MEMORY_SCOPES),
        status: z.enum(MEMORY_STATUSES),
        sourceKind: z.enum(MEMORY_SOURCE_KINDS),
      })
      .strict(),
  }),
  // M49 R4: a memory changed state -- verified, superseded, or removed. `reason` is the removing
  // person's words and is absent for every other move.
  z.object({
    ...envelope,
    type: z.literal('memory.changed'),
    payload: z
      .object({
        memoryId: z.string().min(1),
        from: z.enum(MEMORY_STATUSES),
        to: z.enum(MEMORY_STATUSES),
        reason: z.string().min(1).optional(),
      })
      .strict(),
  }),
  // M50 R3: an EPHEMERAL worker's one assignment ended and the worker was released. Its runtime
  // roles are empty, its terminal tasks' worktrees are gone from disk, and NOTHING else moved --
  // every run, context, checkpoint, message and memory it produced is exactly where it was. This is
  // deliberately not `org.changed { field: 'deleted' }`: that event means a row went away, and this
  // one means a person's engagement here finished. `worktreesCollected` is what the release
  // actually managed to remove, which can be fewer than the worker's terminal tasks -- a tree a
  // `git worktree remove` refused is skipped, never retried, and never a failed release.
  z.object({
    ...envelope,
    type: z.literal('slave.released'),
    payload: z.object({
      slaveId: z.string().min(1),
      name: z.string().min(1),
      reason: z.string().min(1),
      worktreesCollected: z.number().int().nonnegative(),
    }),
  }),
])

export type ExecutionEvent = z.infer<typeof executionEventSchema>

export function parseExecutionEvent(input: unknown): Result<ExecutionEvent, string> {
  const parsed = executionEventSchema.safeParse(input)
  return parsed.success ? ok(parsed.data) : err(parsed.error.message)
}
