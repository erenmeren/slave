import { z } from 'zod'
import type { RuntimeEvent } from '../types.js'

/**
 * `parseStreamLine` is a pure, total function: one NDJSON line from the
 * `claude` CLI's `stream-json` output in, one `RuntimeEvent` out. It never
 * throws -- a malformed or unrecognized line becomes `unparsable`, because a
 * bad line must not kill a run.
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
      return { kind: 'unparsable', line }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    case 'permission_denied':
      return parsePermissionDeniedLine(raw, line)
    default:
      // Recognized system housekeeping this parser does not act on --
      // `hook_started`, `hook_progress`, `thinking_tokens`, and any future
      // subtype the CLI adds. None carries a decision.
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

const hookResponseSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('hook_response'),
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

function parseHookResponseLine(raw: unknown, line: string): RuntimeEvent {
  const result = hookResponseSchema.safeParse(raw)
  if (!result.success) return { kind: 'unparsable', line }
  const data = result.data

  // `hook_event` is the authoritative signal, but the real CLI's `hook_name`
  // is always `<hookEvent>` or `<hookEvent>:<matcher>`, so when `hook_event`
  // is absent the prefix of `hook_name` is used instead.
  const [hookNamePrefix] = data.hook_name.split(':')
  const effectiveHookEvent = data.hook_event ?? hookNamePrefix ?? data.hook_name

  if (effectiveHookEvent !== 'PreToolUse') {
    // Every other hook event, `Stop` included: exit_code is not meaningful
    // scope for those, and classifying on it anyway reports a broken gate
    // on the routine `Stop` hook at the end of every healthy run.
    return { kind: 'ignored', line }
  }

  const denyReason = extractDenyReason(data.output)
  if (denyReason !== null) {
    return { kind: 'hook_denied', hookName: data.hook_name, reason: denyReason }
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
  is_error: z.boolean(),
  terminal_reason: z.string(),
  stop_reason: z.string().nullable(),
  num_turns: z.number(),
  total_cost_usd: z.number(),
  // `permission_denials` is checkpoint material, never a live signal, and
  // cannot on its own tell a blocking crash from a genuine deny -- it is
  // read here only to carry the denied tool_use_ids into `RunOutcome`.
  permission_denials: z.array(z.object({ tool_use_id: z.string() })).optional(),
})

function parseResultLine(raw: unknown, line: string): RuntimeEvent {
  const result = resultSchema.safeParse(raw)
  if (!result.success) return { kind: 'unparsable', line }
  const data = result.data
  return {
    kind: 'terminated',
    outcome: {
      isError: data.is_error,
      terminalReason: data.terminal_reason,
      stopReason: data.stop_reason,
      numTurns: data.num_turns,
      costUsd: data.total_cost_usd,
      deniedToolUseIds: (data.permission_denials ?? []).map((denial) => denial.tool_use_id),
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
})

const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

function parseAssistantLine(raw: unknown, line: string): RuntimeEvent {
  const envelope = assistantEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return { kind: 'unparsable', line }

  const { content } = envelope.data.message
  // Every real capture carries exactly one content block per assistant
  // line. A line with zero or several is a recognized shape this parser
  // does not have single-event semantics for.
  if (content.length !== 1) return { kind: 'ignored', line }
  const [block] = content
  if (!isRecord(block)) return { kind: 'unparsable', line }

  switch (block.type) {
    case 'tool_use': {
      const result = toolUseContentSchema.safeParse(block)
      if (!result.success) return { kind: 'unparsable', line }
      return { kind: 'tool_call', toolUseId: result.data.id, toolName: result.data.name }
    }
    case 'text': {
      const result = textContentSchema.safeParse(block)
      if (!result.success) return { kind: 'unparsable', line }
      return { kind: 'text', text: result.data.text }
    }
    default:
      // `thinking` blocks and any other content type: recognized, not acted on.
      return { kind: 'ignored', line }
  }
}
