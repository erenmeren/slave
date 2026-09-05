import { z } from 'zod'
import { CLAUDE_SUMMARY_ARG_KEYS, isRecord, summaryFor } from '../runtime/summary.js'
import type { RuntimeEvent } from '../types.js'

/**
 * `parseStreamLine` is a pure, total function: one NDJSON line from the
 * `claude` CLI's `stream-json` output in, one `RuntimeEvent` out. It never
 * throws. Invalid JSON, or a recognized shape with required fields missing,
 * becomes `unparsable`; a well-formed line of a kind this parser has no
 * decision for (an unrecognized top-level `type`, or `system` `subtype`)
 * becomes `ignored` -- because a bad or merely-uninteresting line must not
 * kill a run, and only the former is actually a defect.
 *
 * The traps this carries (measured, spec §5.3):
 *  - `hook_response.output` is a JSON-encoded *string*, needing a second
 *    parse to reach the deny decision.
 *  - `hook_response` classification is scoped to `hook_event === 'PreToolUse'`.
 *    Every other hook event (notably `Stop`, which reports `exit_code: 1` on
 *    every healthy run) is `ignored`, not classified.
 *  - Within that scope, the shape is keyed on `exit_code`, never `outcome`:
 *    deny (JSON deny payload, regardless of exit code), blocking crash (`2`),
 *    fail-open failure (non-zero and not `2` -- the tool ran anyway), and
 *    otherwise allow (folded into `ignored`; no `RuntimeEvent` variant
 *    represents "the gate ran and let it through", because the orchestrator
 *    has nothing to act on there).
 */
export function parseStreamLine(line: string): RuntimeEvent {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { kind: 'unparsable', line }
  }

  const envelope = envelopeSchema.safeParse(raw)
  if (!envelope.success) return { kind: 'unparsable', line }

  switch (envelope.data.type) {
    case 'system':
      return parseSystemLine(raw, line)
    case 'result':
      return parseResultLine(raw, line)
    case 'assistant':
      return parseAssistantLine(raw, line)
    case 'user':
      // A `tool_result` echo. Recognized -- it is where a `tool_use_id`
      // would be found to correlate against a preceding hook event -- but
      // this parser is stateless and per-line, so it does not act on it.
      return { kind: 'ignored', line }
    case 'rate_limit_event':
      return { kind: 'ignored', line }
    default:
      // An unrecognized top-level `type`, well-formed JSON with a `type`
      // field notwithstanding: a future CLI adding a new top-level type
      // (as `system` subtypes already do routinely, handled the same way
      // below) is something this parser simply has no decision for, not a
      // malformed line.
      return { kind: 'ignored', line }
  }
}

function isToolUseBlock(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'tool_use'
}

const envelopeSchema = z.object({ type: z.string() })

const systemEnvelopeSchema = z.object({
  type: z.literal('system'),
  subtype: z.string(),
})

function parseSystemLine(raw: unknown, line: string): RuntimeEvent {
  const envelope = systemEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return { kind: 'unparsable', line }

  switch (envelope.data.subtype) {
    case 'init':
      return parseInitLine(raw, line)
    case 'hook_response':
      return parseHookResponseLine(raw, line)
    case 'hook_started':
      return parseHookStartedLine(raw, line)
    case 'permission_denied':
      return parsePermissionDeniedLine(raw, line)
    default:
      // Recognized system housekeeping this parser does not act on --
      // `hook_progress`, `thinking_tokens`, and any future subtype the CLI
      // adds. None carries a decision.
      return { kind: 'ignored', line }
  }
}

const initSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
})

function parseInitLine(raw: unknown, line: string): RuntimeEvent {
  const result = initSchema.safeParse(raw)
  if (!result.success) return { kind: 'unparsable', line }
  return { kind: 'session_started', sessionId: result.data.session_id }
}

const permissionDeniedSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('permission_denied'),
  tool_name: z.string(),
  tool_use_id: z.string(),
})

function parsePermissionDeniedLine(raw: unknown, line: string): RuntimeEvent {
  const result = permissionDeniedSchema.safeParse(raw)
  if (!result.success) return { kind: 'unparsable', line }
  return { kind: 'permission_denied', toolName: result.data.tool_name, toolUseId: result.data.tool_use_id }
}

const hookStartedSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('hook_started'),
  hook_id: z.string(),
  hook_name: z.string(),
  hook_event: z.string().optional(),
})

/**
 * A `hook_started` line announces a hook run and its `hook_id`, the id its own
 * `hook_response` later echoes back (measured: `permission-matrix-deny.ndjson` lines 20/22).
 * Only `PreToolUse` starts become events -- the rest is housekeeping, `ignored` as before.
 *
 * A malformed one is `ignored`, NOT `unparsable`: unlike `hook_response`, this line carries no
 * decision, so failing to read it drops a correlation hint, not a gate verdict, and must not be
 * counted against the run as a defect.
 */
function parseHookStartedLine(raw: unknown, line: string): RuntimeEvent {
  const result = hookStartedSchema.safeParse(raw)
  if (!result.success) return { kind: 'ignored', line }
  if (effectiveHookEventOf(result.data) !== 'PreToolUse') return { kind: 'ignored', line }
  return { kind: 'hook_started', hookId: result.data.hook_id, hookName: result.data.hook_name }
}

const hookResponseSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('hook_response'),
  hook_id: z.string().optional(),
  hook_name: z.string(),
  hook_event: z.string().optional(),
  output: z.string().optional(),
  stderr: z.string().optional(),
  exit_code: z.number().optional(),
})

const denyOutputSchema = z.object({
  hookSpecificOutput: z.object({
    permissionDecision: z.literal('deny'),
    permissionDecisionReason: z.string(),
  }),
})

function extractDenyReason(output: string | undefined): string | null {
  if (output === undefined) return null
  let inner: unknown
  try {
    inner = JSON.parse(output)
  } catch {
    return null
  }
  const result = denyOutputSchema.safeParse(inner)
  if (!result.success) return null
  return result.data.hookSpecificOutput.permissionDecisionReason
}

/**
 * `hook_event` is the authoritative signal, but the real CLI's `hook_name`
 * is always `<hookEvent>` or `<hookEvent>:<matcher>`, so when `hook_event`
 * is absent the prefix of `hook_name` is used instead. Shared by
 * `parseHookResponseLine` below and `isPreToolUseHookResponseLine`, so the
 * two derivations of "which hook event is this" cannot drift apart.
 */
function effectiveHookEventOf(data: { readonly hook_name: string; readonly hook_event?: string | undefined }): string {
  const [hookNamePrefix] = data.hook_name.split(':')
  return data.hook_event ?? hookNamePrefix ?? data.hook_name
}

/**
 * True when `line` is a `system`/`hook_response` line whose effective hook
 * event is `PreToolUse`, regardless of the response's outcome -- deny,
 * crash, fail-open, or a plain allow. The first three each have their own
 * `RuntimeEvent` kind; the allow case does not (folded into `ignored` by
 * `parseHookResponseLine` below, deliberately -- see that function's own
 * comment). The adapter's runtime backstop (spec §5.5) needs to know "was
 * the `PreToolUse` hook invoked at all" even for that folded case -- proving
 * a tool call proceeded with no gate response of *any* shape is the
 * signal that the hook was never invoked, as opposed to invoked and simply
 * allowing -- so this exists to recover it from the raw line `ignored`
 * still carries, without adding a field to the shared `RuntimeEvent` union
 * for a single caller's need.
 */
export function isPreToolUseHookResponseLine(line: string): boolean {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return false
  }
  const result = hookResponseSchema.safeParse(raw)
  if (!result.success) return false
  return effectiveHookEventOf(result.data) === 'PreToolUse'
}

function parseHookResponseLine(raw: unknown, line: string): RuntimeEvent {
  const result = hookResponseSchema.safeParse(raw)
  if (!result.success) return { kind: 'unparsable', line }
  const data = result.data

  const effectiveHookEvent = effectiveHookEventOf(data)

  if (effectiveHookEvent !== 'PreToolUse') {
    // Every other hook event, `Stop` included: exit_code is not meaningful
    // scope for those, and classifying on it anyway reports a broken gate
    // on the routine `Stop` hook at the end of every healthy run.
    return { kind: 'ignored', line }
  }

  const denyReason = extractDenyReason(data.output)
  if (denyReason !== null) {
    // The `hookId` key is present only when the line actually carried one (M21 C1): an older
    // capture with no `hook_id` gets NO key rather than an invented empty string, so the pump can
    // tell "this CLI does not pair" from "this response pairs with nothing".
    return {
      kind: 'hook_denied',
      hookName: data.hook_name,
      reason: denyReason,
      ...(data.hook_id === undefined ? {} : { hookId: data.hook_id }),
    }
  }

  if (data.exit_code === undefined) return { kind: 'unparsable', line }
  const stderr = data.stderr ?? ''

  if (data.exit_code === 2) {
    return { kind: 'hook_crashed', hookName: data.hook_name, exitCode: data.exit_code, stderr }
  }
  if (data.exit_code !== 0) {
    return { kind: 'hook_failed_open', hookName: data.hook_name, exitCode: data.exit_code, stderr }
  }
  // exit 0, no deny payload: the gate ran and allowed the call. No variant
  // represents this; it is not actionable for the orchestrator.
  return { kind: 'ignored', line }
}

const resultSchema = z.object({
  type: z.literal('result'),
  // `subtype` (e.g. `success`, `error_max_turns`, `error_during_execution`)
  // is the fallback for a missing `terminal_reason` below. All four
  // captures are `success` runs where every field here is always present;
  // it is an error result -- unmeasured here -- where the CLI is plausibly
  // silent on some of them.
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  terminal_reason: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  num_turns: z.number().optional(),
  total_cost_usd: z.number().optional(),
  // `permission_denials` is checkpoint material, never a live signal, and
  // cannot on its own tell a blocking crash from a genuine deny -- it is
  // read here only to carry the denied tool_use_ids into `RunOutcome`.
  permission_denials: z.array(z.object({ tool_use_id: z.string() })).optional(),
  // Every recorded `result` line carries this; it is `.optional()` for the same reason every
  // other field here is -- a degraded error result is where the CLI is plausibly silent, and a
  // missing `usage` must degrade to `null`, not fail the parse of a line that must always
  // produce `terminated`. The two cache fields are read for the same reason `input_tokens` is
  // (fix round 1, below) -- they are billed, and `RunOutcome.tokens.input` reports what the run
  // cost in tokens, not merely its freshly-read context.
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .passthrough()
    .optional(),
})

function parseResultLine(raw: unknown, line: string): RuntimeEvent {
  const result = resultSchema.safeParse(raw)
  if (!result.success) return { kind: 'unparsable', line }
  const data = result.data

  // A `result` line must always produce `terminated` -- the alternative is
  // the orchestrator waiting on a process that has already exited, and no
  // amount of missing-field caution is worth that. Absence of any field
  // here is tolerated; only a present-but-wrongly-typed field (caught by
  // `resultSchema` above) is treated as genuinely malformed.
  //
  // `is_error` defaults to `true`, not `false`: a run whose success cannot
  // be established is not a success, and reporting a failed run as a
  // success is worse than the reverse.
  const terminalReasonSource = data.terminal_reason ?? data.subtype
  let terminalReason: string
  if (
    terminalReasonSource !== undefined &&
    data.is_error !== undefined &&
    data.num_turns !== undefined &&
    data.total_cost_usd !== undefined
  ) {
    terminalReason = terminalReasonSource
  } else {
    // `total_cost_usd` feeds the budget guardrail, so a defaulted (0) cost
    // must never look like a real, cheap run -- the degradation is folded
    // into `terminalReason` rather than silently zeroed, since `RunOutcome`
    // gets no new field to carry it separately. `is_error` belongs in this
    // same check: the pump maps `terminated` onto `run.succeeded` /
    // `run.failed` using `is_error`, with `terminalReason` as the reason --
    // a defaulted `isError: true` with no trace here would produce a
    // `run.failed` whose own explanation reads like a normal completion.
    const missing: string[] = []
    if (terminalReasonSource === undefined) missing.push('terminal_reason')
    if (data.is_error === undefined) missing.push('is_error')
    if (data.num_turns === undefined) missing.push('num_turns')
    if (data.total_cost_usd === undefined) missing.push('total_cost_usd')
    terminalReason = `${terminalReasonSource ?? 'unknown'} (degraded result line, missing: ${missing.join(', ')})`
  }

  return {
    kind: 'terminated',
    outcome: {
      isError: data.is_error ?? true,
      terminalReason,
      stopReason: data.stop_reason ?? null,
      numTurns: data.num_turns ?? 0,
      // `null`, never `0` (spec Decision 6, applied at the parse site by M12 Task 9 / ruling R5).
      // A degraded `result` line that carries no `total_cost_usd` describes a run whose cost is
      // UNKNOWN, and `RunOutcome.costUsd` has been `number | null` since Task 1 precisely so this
      // can be said. Writing `0` here was a choice, not a necessity, and it was the lie the budget
      // guardrail would have believed: an unmeasured run recorded as having spent nothing. The
      // degradation is already named in `terminalReason` above, so telling the truth here loses
      // nothing.
      costUsd: data.total_cost_usd ?? null,
      deniedToolUseIds: (data.permission_denials ?? []).map((denial) => denial.tool_use_id),
      // Both halves or neither (M14 §4.2). A `usage` carrying only `input_tokens` describes a
      // measurement that did not complete, and reporting `{ input: 10, output: 0 }` would put a
      // fabricated zero into every per-slave token sum on the Analytics page. `input` is what the
      // run was BILLED for, not merely `input_tokens` alone (fix round 1, controller ruling):
      // `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, each counter
      // treated as 0 when absent -- the fixture's own result line bills 4 fresh input tokens
      // alongside 16,732 written to cache and 46,948 read back from it, and a figure that ignores
      // the latter two reads as 4 tokens beside a $0.21 run, which is not what that run cost. The
      // presence check stays on `input_tokens`/`output_tokens` alone: it is still those two that
      // decide whether this `result` line measured usage at all, only the summed figure changes.
      tokens:
        data.usage !== undefined &&
        typeof data.usage.input_tokens === 'number' &&
        typeof data.usage.output_tokens === 'number'
          ? {
              input:
                data.usage.input_tokens +
                (data.usage.cache_creation_input_tokens ?? 0) +
                (data.usage.cache_read_input_tokens ?? 0),
              output: data.usage.output_tokens,
            }
          : null,
    },
  }
}

const assistantEnvelopeSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(z.unknown()),
  }),
})

const toolUseContentSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  // `z.unknown()` rather than `z.record(...)`, and deliberately so: `input` feeds only the
  // best-effort `summary` derived by `summaryFor` below, and a missing or malformed `input` (the
  // real CLI is not contractually bound to any particular shape here) must never fail the parse
  // of an otherwise-valid tool_call. Shape-checking happens downstream, where it can fall back
  // to the bare tool name instead of rejecting the whole line.
  input: z.unknown().optional(),
})

const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

function parseAssistantLine(raw: unknown, line: string): RuntimeEvent {
  const envelope = assistantEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return { kind: 'unparsable', line }

  const { content } = envelope.data.message

  // A `tool_use` block is preferred wherever it appears in the content
  // array, even alongside other blocks (e.g. `[text, tool_use]`) -- unmeasured
  // here (every real capture is one block per line), but Task 8's pause test
  // proves the pause held by *counting* `tool_call` events after a deny.
  // Falling to `ignored` because the line also carried a text block would
  // make a tool call that actually happened invisible, and a broken pause
  // would read as intact. This function returns one event per line, so a
  // line with more than one `tool_use` block still only surfaces the first.
  const toolUseBlock = content.find(isToolUseBlock)
  if (toolUseBlock !== undefined) {
    const result = toolUseContentSchema.safeParse(toolUseBlock)
    if (!result.success) return { kind: 'unparsable', line }
    return {
      kind: 'tool_call',
      toolUseId: result.data.id,
      toolName: result.data.name,
      summary: summaryFor(result.data.name, result.data.input, CLAUDE_SUMMARY_ARG_KEYS),
    }
  }

  // No tool_use block: every real capture carries exactly one content block
  // per assistant line in that case. A line with zero or several is a
  // recognized shape this parser does not have single-event semantics for.
  if (content.length !== 1) return { kind: 'ignored', line }
  const [block] = content
  if (!isRecord(block)) return { kind: 'unparsable', line }

  if (block.type === 'text') {
    const result = textContentSchema.safeParse(block)
    if (!result.success) return { kind: 'unparsable', line }
    return { kind: 'text', text: result.data.text }
  }
  // `thinking` blocks and any other content type: recognized, not acted on.
  return { kind: 'ignored', line }
}
