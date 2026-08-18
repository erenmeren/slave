import { z } from 'zod'
import { err, ok, type Result } from '../result.js'

const envelope = {
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  workspaceId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  actor: z.enum(['human', 'agent', 'system']),
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
  z.object({ ...envelope, type: z.literal('run.paused'), payload: z.object({ atStep: z.number().int() }) }),
  z.object({ ...envelope, type: z.literal('run.resumed'), payload: z.object({ sessionId: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('agent.message_sent'),
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
  z.object({ ...envelope, type: z.literal('run.stopped'), payload: z.object({ reason: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('run.succeeded'),
    payload: z.object({ numTurns: z.number().int(), costUsd: z.number() }),
  }),
  z.object({ ...envelope, type: z.literal('run.failed'), payload: z.object({ reason: z.string() }) }),
])

export type ExecutionEvent = z.infer<typeof executionEventSchema>

export function parseExecutionEvent(input: unknown): Result<ExecutionEvent, string> {
  const parsed = executionEventSchema.safeParse(input)
  return parsed.success ? ok(parsed.data) : err(parsed.error.message)
}
