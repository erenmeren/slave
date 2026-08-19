import { prisma } from '@ai-team-os/db/client'
import type { AgentId, RunId, TaskId, WorkspaceId } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import type { RunOutcome, RuntimeEvent } from '@ai-team-os/providers'

/**
 * The cap on a single `run.output` payload (spec §9: the agent's text output "with a truncation
 * cap"). It protects an append-only log first and, from M4, a screen -- one runaway paste from a
 * model that decided to echo a file back is otherwise a row nobody can read and nobody can delete.
 */
export const OUTPUT_CAP = 4_000

export interface PumpRunInput {
  readonly runId: RunId
  readonly taskId: TaskId
  readonly agentId: AgentId
  readonly workspaceId: WorkspaceId
  readonly events: AsyncIterable<RuntimeEvent>
  /**
   * The caller's binding of the adapter's `cancel(runId)`. Required, not optional: the pump reacts
   * to a gate failure by stopping the run, and a pump that can be constructed without the ability
   * to stop one is a pump that can silently leave an ungated agent running.
   */
  readonly cancel: () => Promise<void>
}

/**
 * `actor` says who the event is *about*, not who wrote the row -- every row here is written by the
 * orchestrator. `agent` is the agent's own activity as observed on the stream; `system` is the
 * orchestrator's judgement about it. A reader filtering for what the agent did wants the first
 * without the second.
 */
type Actor = 'agent' | 'system'

/**
 * Spec §13.1's two shapes, kept apart all the way to the operator's screen.
 *
 * After a **blocking crash** the run stopped and nothing landed beyond the crash: the damage is
 * bounded. After a **fail-open** failure the run kept acting with no gate at all, so everything it
 * did between the gate breaking and the cancel landing is work nobody could have stopped. Wording
 * these the same way is the conflation ADR 0001 and §13.1 warn about, and it is dangerous in one
 * direction specifically: it reports an uncontrolled run as a controlled one.
 */
function gateFailureReason(event: {
  readonly kind: 'hook_crashed' | 'hook_failed_open'
  readonly hookName: string
  readonly exitCode: number
  readonly stderr: string
}): string {
  const where = `${event.hookName} exited ${event.exitCode}`
  return event.kind === 'hook_crashed'
    ? `the pause gate crashed (${where}) and the run was stopped; nothing landed beyond the crash: ${event.stderr}`
    : `the pause gate failed open (${where}): the run kept acting ungated from the moment the gate ` +
        `broke until the cancel landed, and nothing could have stopped it in that window: ${event.stderr}`
}

/**
 * Consumes one run's `RuntimeEvent` stream, writes the domain events it implies, and keeps the
 * run's own row in step with it.
 *
 * One pump per run, concurrent with the tick rather than inside it (spec §5.6): M6 requires events
 * visible within a second, and draining them on the tick period forfeits that by construction.
 * `appendEvent` is transactional, so concurrent pumps are safe, and awaiting it per event applies
 * backpressure to the child's stdout -- if the database slows, the pump slows, and nothing is lost.
 *
 * This function owns the `AgentRun` row's live columns, because it is the only thing that watches
 * the stream: `sessionId` (spec §5.4, written in the same step as `run.started`), `toolCalls` (the
 * count §3.3's ceiling is read from), and the terminal `status`/`costUsd`/`terminalAt`. Task 13
 * writes the row at spawn and never sees it end.
 *
 * Returns the run's normalized outcome, or `null` when there was not one -- a gate failure, a
 * pause, or a stream that ended without a terminal event. A `null` is never a success.
 */
export async function pumpRun(input: PumpRunInput): Promise<RunOutcome | null> {
  const { runId, taskId, agentId, workspaceId } = input

  const emit = async (
    type: Parameters<typeof appendEvent>[0]['type'],
    actor: Actor,
    payload: unknown,
  ): Promise<void> => {
    await appendEvent({ type, workspaceId, taskId, agentId, runId, actor, payload })
  }

  let outcome: RunOutcome | null = null
  let toolCalls = 0
  let unparsableLines = 0
  let paused = false
  let gateFailed = false

  for await (const event of input.events) {
    switch (event.kind) {
      case 'session_started': {
        // Spec §5.4: not at spawn. `run.started`'s payload carries the session id, and there is no
        // session id until this line -- a run that dies before it produces `run.failed` instead,
        // which is the accurate account of what happened.
        await prisma.agentRun.update({
          where: { id: runId },
          data: { sessionId: event.sessionId, status: 'working' },
        })
        await emit('run.started', 'agent', { sessionId: event.sessionId })
        break
      }

      case 'tool_call': {
        toolCalls += 1
        await prisma.agentRun.update({ where: { id: runId }, data: { toolCalls } })
        // `summary` carries the tool use id rather than the call's arguments: `RuntimeEvent` never
        // carries the input (Task 4), and widening the parser for a richer summary belongs to M4,
        // where the consumer is. The id at least ties the event back to one stream line.
        await emit('run.tool_call', 'agent', { name: event.toolName, summary: event.toolUseId })
        break
      }

      case 'text': {
        await emit('run.output', 'agent', { text: event.text.slice(0, OUTPUT_CAP) })
        break
      }

      case 'permission_denied': {
        // A permission-mode denial is *not* a pause. The pause protocol is a hook deny, which
        // removes the agent's ability to act; this is one tool refused, with the agent free to
        // try another -- and ADR 0001 measured it doing exactly that. Reporting it as `run.paused`
        // would tell an operator a run had stopped when it had not.
        await emit('guardrail.tripped', 'system', {
          guardrail: 'permission_mode',
          detail: `${event.toolName} was denied by the permission mode (${event.toolUseId})`,
        })
        break
      }

      case 'hook_denied': {
        // The pause gate doing its job. The adapter kills the process after the deny (Task 8), so
        // the stream ends here -- and recording the pause is what stops Task 15's orphan sweep
        // seeing a `working` run with a dead pid and failing it. The domain's state machine only
        // admits `paused` from `pause_requested`; the pump reports what the runtime did rather
        // than adjudicating that, because the alternative to an unexpected `paused` row is a
        // killed process still recorded as working.
        paused = true
        await prisma.agentRun.update({
          where: { id: runId },
          data: { status: 'paused', pausedAtStep: toolCalls },
        })
        await emit('run.paused', 'system', { atStep: toolCalls })
        break
      }

      case 'hook_crashed':
      case 'hook_failed_open': {
        gateFailed = true
        const reason = gateFailureReason(event)

        // Cancel first, and do not wait for the stream to end. A gate failure that waits for
        // `terminated` is a gate failure that never fires, because the run whose gate has failed
        // is precisely the run that may never stop on its own (spec §13.1, behaviour 1).
        await input.cancel()

        await prisma.agentRun.update({
          where: { id: runId },
          data: { status: 'failed', terminalAt: new Date(), endedAt: new Date() },
        })
        // The attempt counts, so a task cannot loop forever against a gate that stays broken.
        await prisma.task.update({ where: { id: taskId }, data: { attempt: { increment: 1 } } })

        // Only when it is not already halted: the *earliest* gate failure is the one that explains
        // the workspace's state, and `haltedAt` is the moment of the transition. Overwriting would
        // walk that timestamp forward for as long as runs keep failing, so a halt an operator has
        // been ignoring for an hour would read as one second old. `updateMany` because a
        // conditional update needs a filter on a non-unique column.
        await prisma.workspace.updateMany({
          where: { id: workspaceId, haltedReason: null },
          data: { haltedReason: reason, haltedAt: new Date() },
        })

        // Two events, because the run failed *and* a guardrail is what failed it (§13.1).
        await emit('run.failed', 'system', { reason })
        await emit('guardrail.tripped', 'system', { guardrail: 'pause_gate', detail: reason })
        break
      }

      case 'terminated': {
        outcome = event.outcome
        break
      }

      case 'unparsable': {
        // Spec §13: dropped and recorded, the run continues -- safe only because a dropped line is
        // never a gate signal, which is Task 4's `hook_response` guard. Recorded out of band on
        // purpose: spec §9 adds exactly nine catalogue types and invents no names, none of the
        // nineteen means "the orchestrator could not read a line", and folding it into
        // `run.output` would put orchestrator diagnostics into the stream M4 renders as the agent
        // speaking.
        unparsableLines += 1
        console.warn(`[pump] unparsable stream line on run ${runId}: ${event.line}`)
        break
      }

      case 'ignored':
        break
    }

    if (gateFailed) break
  }

  if (gateFailed || paused) return null

  if (outcome === null) {
    // The stream ended with no terminal event: the child died without reporting. Not a success,
    // and not silent.
    const reason = `the run's output stream ended without a terminal result${
      unparsableLines > 0 ? ` (${unparsableLines} unparsable line(s) were dropped first)` : ''
    }`
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: 'failed', terminalAt: new Date(), endedAt: new Date() },
    })
    await emit('run.failed', 'system', { reason })
    return null
  }

  // A clean completion with denials is a failure. ADR 0001 measured a run reporting
  // `is_error: false` while landing nothing, detectable only through `permission_denials` -- so the
  // terminal flag alone is not what decides this.
  const failed = outcome.isError || outcome.deniedToolUseIds.length > 0
  await prisma.agentRun.update({
    where: { id: runId },
    data: {
      status: failed ? 'failed' : 'succeeded',
      costUsd: outcome.costUsd,
      terminalAt: new Date(),
      endedAt: new Date(),
    },
  })

  if (failed) {
    const denied =
      outcome.deniedToolUseIds.length > 0
        ? ` ${outcome.deniedToolUseIds.length} tool call(s) were denied: ${outcome.deniedToolUseIds.join(', ')}`
        : ''
    await emit('run.failed', 'system', { reason: `${outcome.terminalReason}.${denied}`.trim() })
  } else {
    await emit('run.succeeded', 'system', { numTurns: outcome.numTurns, costUsd: outcome.costUsd })
  }

  return outcome
}
