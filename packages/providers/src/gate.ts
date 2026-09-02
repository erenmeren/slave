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
 *
 * `tool_denied` (M18 Task 6) is the third kind, sanctioned alongside the two above: a PERMISSION
 * MATRIX refusal, which the run survives -- one tool was refused, the agent keeps going, nothing
 * pauses. It is NOT a widening of `stopped_by_gate` (a matrix deny stops nothing, so folding it in
 * would tell the pump to pause a run that is still working) and it is NOT `permission_denied`
 * folded in here either -- see `classifyGateEvent`'s docstring for why that omission stands. It
 * exists because a matrix deny arrives on the WIRE as the same `hook_denied` shape a pause deny
 * does (Claude's PreToolUse hook is the one mechanism both routes through); the prefix on `reason`
 * is the only thing that tells them apart, and `classifyGateEvent` is where that split belongs --
 * the one place already trusted to translate a runtime-shaped `RuntimeEvent` into the
 * provider-neutral vocabulary everything downstream reads.
 */
export type GateOutcome =
  | { readonly kind: 'stopped_by_gate'; readonly reason: string }
  | { readonly kind: 'gate_failed'; readonly detail: string }
  | {
      readonly kind: 'tool_denied'
      readonly tool: string
      readonly capability: string
      /**
       * M21 C1: the denying hook's own `hook_id`, carried through from `hook_denied` when the CLI
       * sent one. The pump bound this id to a `tool_use` when the hook STARTED, so it -- not the
       * last `tool_call` seen, which the real capture proved is not reliably the refused one --
       * is what resolves the denial to the call it actually refused. Absent (`undefined`) for a
       * runtime or a line that carried no `hook_id`; the pump falls back to M19 B2's name rule.
       */
      readonly hookId?: string
    }

/**
 * Every deny the PERMISSION MATRIX issues begins with this exact string — it is how the stream
 * parsers tell a matrix refusal (the run continues) from a pause deny (the run stops). The
 * shell twin lives in scripts/lib/permissions.sh; packages/control's mapping test pins the two
 * spellings byte-equal, so neither can drift alone.
 */
export const PERMISSION_DENY_REASON_PREFIX = 'permission matrix denies'

/** Escapes every regex metacharacter in `s`, so a literal can be interpolated into a `RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Built FROM `PERMISSION_DENY_REASON_PREFIX` (fix round 1, review minor 5) rather than repeating
 * its text as a second literal -- the prefix the parser matches against and the prefix
 * `classifyGateEvent` checks with `.startsWith` must never be able to drift apart from each other,
 * only both together from the shell twin (which `packages/control`'s mapping test still pins
 * separately).
 */
const PERMISSION_DENY_REASON_PATTERN = new RegExp(
  `^${escapeRegExp(PERMISSION_DENY_REASON_PREFIX)} '(.*)' \\((.+)\\) for this agent$`,
)

/**
 * The fixed grammar every matrix deny reason follows, verbatim (scripts/lib/permissions.sh, M18
 * Task 3): `permission matrix denies '<capability>' (<tool>) for this agent`. Parses `{ tool,
 * capability }` out of it, or `null` on anything that does not match -- a reason string the prefix
 * check already confirmed starts with `PERMISSION_DENY_REASON_PREFIX` but whose tail the shell
 * twin changed shape on, say, or a hand-built one in a test that got the punctuation wrong. Never
 * throws: capabilities are fixed strings today (no apostrophes or parens of their own to escape),
 * but this parses whatever comes down the wire, not what the shell script is trusted to send, so a
 * capability containing a quote must degrade to `null` rather than crash the run that hit it.
 *
 * A `null` here is NOT a "believe it anyway" case (fix round 1, review Important 4 controller
 * ruling): `classifyGateEvent` and `pump.ts`'s `permission_denied` case both route a `null` back to
 * their ordinary, non-matrix handling -- a pause for Claude, an ordinary permission-mode denial for
 * Cursor -- rather than reporting an invented `tool`/`capability`. Fail-safe is pausing, not
 * trusting an unparseable matrix claim.
 */
export function parsePermissionDenyReason(reason: string): { readonly tool: string; readonly capability: string } | null {
  const match = PERMISSION_DENY_REASON_PATTERN.exec(reason)
  if (match === null) return null
  const [, capability, tool] = match
  if (capability === undefined || tool === undefined) return null
  return { tool, capability }
}

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
    case 'hook_denied': {
      // Both routes arrive here as the identical `hook_denied` shape -- Claude's PreToolUse hook
      // is the one mechanism a pause deny AND a matrix deny both go through -- so `reason` is the
      // only thing that tells them apart (M18 Task 6).
      //
      // Fix round 1 (review Important 4, controller ruling -- overrides this function's original
      // `unknown`/`unknown` fallback): `tool_denied` is reported ONLY on a full, successful parse
      // of `reason`. A reason that merely starts with the prefix but fails to parse -- the shell
      // twin drifted, or a hand-built reason in a test got the grammar wrong -- falls through to
      // `stopped_by_gate` below, exactly like a reason carrying no prefix at all. FAIL-SAFE IS
      // PAUSING: an unparseable claim of "this was the matrix" is not trusted merely because it
      // looks like one, and a paused run an operator can inspect is the safe failure mode, not a
      // silently-invented `tool: 'unknown'` on a run that keeps going ungated in a way nothing
      // downstream can name.
      const parsed = parsePermissionDenyReason(event.reason)
      if (parsed !== null) {
        // M21 C1: `hookId` is passed through only when the line carried one -- spread rather than
        // set, because `exactOptionalPropertyTypes` distinguishes "absent" from "present and
        // undefined", and the pump reads absence as "no binding to look up".
        return {
          kind: 'tool_denied',
          tool: parsed.tool,
          capability: parsed.capability,
          ...(event.hookId === undefined ? {} : { hookId: event.hookId }),
        }
      }
      return { kind: 'stopped_by_gate', reason: event.reason }
    }
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
