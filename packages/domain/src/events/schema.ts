import { z } from 'zod'
import { err, ok, type Result } from '../result.js'

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
      category: z.enum(['instruction', 'feedback', 'context', 'priority_change', 'question_response']),
      body: z.string().min(1),
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
     */
    payload: z.object({
      field: z.enum(['provider', 'budgetUsd']),
      from: z.union([z.string(), z.number(), z.null()]),
      to: z.union([z.string(), z.number(), z.null()]),
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
  z.object({
    ...envelope,
    type: z.literal('org.changed'),
    payload: z.object({
      entity: z.enum(['slave', 'team']),
      id: z.string().min(1),
      field: z.enum(['name', 'role', 'model', 'deleted', 'created', 'team']),
      from: z.string().nullable(),
      to: z.string().nullable(),
    }),
  }),
])

export type ExecutionEvent = z.infer<typeof executionEventSchema>

export function parseExecutionEvent(input: unknown): Result<ExecutionEvent, string> {
  const parsed = executionEventSchema.safeParse(input)
  return parsed.success ? ok(parsed.data) : err(parsed.error.message)
}
