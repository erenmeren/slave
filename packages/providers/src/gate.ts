import type { RuntimeEvent } from './types.js'

/**
 * The hook's own output, bounded before it lands in a workspace's `haltedReason` or an
 * operator-facing `guardrail.tripped` payload. Moved here from `apps/orchestrator/src/pump.ts`
 * (M12 Task 4) alongside the reason-building logic that needs it.
 */
const STDERR_CAP = 1_000

/**
 * How a run's write gate ended, stated so the orchestrator never asks which runtime produced it.
 * A runtime with `gate: 'none'` produces neither.
 */
export type GateOutcome =
  | { readonly kind: 'stopped_by_gate'; readonly reason: string }
  | { readonly kind: 'gate_failed'; readonly detail: string }

/**
 * Every deny the PERMISSION MATRIX issues begins with this exact string — it is how the stream
 * parsers tell a matrix refusal (the run continues) from a pause deny (the run stops). The
 * shell twin lives in scripts/lib/permissions.sh; packages/control's mapping test pins the two
 * spellings byte-equal, so neither can drift alone.
 */
export const PERMISSION_DENY_REASON_PREFIX = 'permission matrix denies'

/**
 * Classifies a `RuntimeEvent` into the pause protocol's outcome, or `null` when the event says
 * nothing about it.
 *
 * Narrow on purpose (controller ruling, M12 Task 4). `RuntimeEvent` is already the
 * provider-neutral vocabulary -- any adapter may emit any of its variants, so a caller reading one
 * is not itself a leak. What this function exists to fix is narrower: the *pause protocol*
 * (`hook_denied`) and the *workspace-halting circuit breaker* (`hook_crashed`/`hook_failed_open`)
 * used to be written directly in terms of those three Claude-shaped variant names in
 * `apps/orchestrator/src/pump.ts`, which left both silently inert for a runtime whose gate
 * produces differently-shaped events. `classifyGateEvent` is the one place that still knows the
 * Claude-specific mapping; everything downstream asks only `GateOutcome.kind`.
 *
 * `permission_denied` is DELIBERATELY excluded, even though its name suggests a gate. It is a
 * guardrail observation in the shared vocabulary, not a pause-protocol signal: it stops nothing --
 * the agent is free to try another tool, and ADR 0001 measured it doing exactly that -- and halts
 * nothing. It also carries no `reason` field to source `stopped_by_gate.reason` from (only
 * `toolName`/`toolUseId`). Folding it in here would conflate two behaviourally distinct outcomes
 * -- an ordinary tool refusal on a still-running agent, and the pause gate actually stopping the
 * run -- into one opaque value, destroying the very distinction ADR 0001 drew between them.
 * `pump.ts` keeps its own `permission_denied` handling entirely outside this function, unchanged.
 * Do not "fix" this omission by adding it back.
 */
export function classifyGateEvent(event: RuntimeEvent): GateOutcome | null {
  switch (event.kind) {
    case 'hook_denied':
      return { kind: 'stopped_by_gate', reason: event.reason }
    case 'hook_crashed':
    case 'hook_failed_open':
      return { kind: 'gate_failed', detail: gateFailureDetail(event) }
    default:
      return null
  }
}

/**
 * Spec §13.1's two shapes, kept apart all the way to the operator's screen (moved here verbatim
 * from `apps/orchestrator/src/pump.ts`'s `gateFailureReason`, M12 Task 4).
 *
 * After a **blocking crash** the run stopped and nothing landed beyond the crash: the damage is
 * bounded. After a **fail-open** failure the run kept acting with no gate at all, so everything it
 * did between the gate breaking and the cancel landing is work nobody could have stopped. Wording
 * these the same way is the conflation ADR 0001 and §13.1 warn about, and it is dangerous in one
 * direction specifically: it reports an uncontrolled run as a controlled one.
 */
function gateFailureDetail(event: {
  readonly kind: 'hook_crashed' | 'hook_failed_open'
  readonly hookName: string
  readonly exitCode: number
  readonly stderr: string
}): string {
  const where = `${event.hookName} exited ${event.exitCode}`
  const stderr = event.stderr.slice(0, STDERR_CAP)
  return event.kind === 'hook_crashed'
    ? `the pause gate crashed (${where}) and the run was stopped; nothing landed beyond the crash: ${stderr}`
    : `the pause gate failed open (${where}): the run kept acting ungated from the moment the gate ` +
        `broke until the cancel landed, and nothing could have stopped it in that window: ${stderr}`
}
