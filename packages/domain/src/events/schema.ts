import { z } from 'zod'
import { err, ok, type Result } from '../result.js'
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

/** One member per event type. The payload shape is bound to the type by construction. */
export const executionEventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('task.created'), payload: z.object({ title: z.string() }) }),
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
    payload: z.object({ command: z.string(), exitCode: z.number().int() }),
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
  z.object({
    ...envelope,
    type: z.literal('workspace.goal_set'),
    payload: z.object({ goal: z.string().min(1) }),
  }),
  z.object({
    ...envelope,
    type: z.literal('workspace.plan_created'),
    payload: z.object({
      goal: z.string().min(1),
      tasks: z
        .array(z.object({ id: z.string().min(1), title: z.string().min(1), role: z.string().min(1) }))
        .min(1),
    }),
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
  // M23 B2: `collectTaskWorktree` removed a terminal task's worktree.
  z.object({
    ...envelope,
    type: z.literal('task.worktree_collected'),
    payload: z.object({ path: z.string().min(1), reason: z.enum(['aged', 'operator']), branch: z.string().nullable() }),
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
      field: z.enum(['name', 'role', 'model', 'deleted', 'created', 'team']),
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
    payload: z.object({ attempt: z.number().int().nonnegative(), maxAttempts: z.number().int().positive() }),
  }),
  // M38 t1: the five events the Supervisor's control verbs write (spec section 2). Every one is
  // appended by `packages/control/src/supervisor.ts` with `actor: 'system'` -- the envelope enum
  // has no `supervisor` member and gaining one would touch every reader (spec erratum E4); the
  // Supervisor names itself in the payload the verbs it calls write instead.
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
])

export type ExecutionEvent = z.infer<typeof executionEventSchema>

export function parseExecutionEvent(input: unknown): Result<ExecutionEvent, string> {
  const parsed = executionEventSchema.safeParse(input)
  return parsed.success ? ok(parsed.data) : err(parsed.error.message)
}
