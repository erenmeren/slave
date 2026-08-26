import { z } from 'zod'
import type { RuntimeEvent } from '../types.js'

/**
 * `parseCursorLine` is a pure, total function: one NDJSON line from
 * `cursor-agent --print --output-format stream-json` in, one `RuntimeEvent`
 * out. It never throws, for any input, including the empty string. It mirrors
 * `packages/providers/src/claude/stream.ts`'s discipline exactly, including
 * the distinction that matters most: invalid JSON, or a recognized shape with
 * a required field missing, is `unparsable` (a defect); a well-formed line of
 * a kind this parser has no decision for is `ignored` (merely uninteresting).
 * Getting those backwards is how a malformed line stops being visible.
 *
 * EVERY mapping below was read off a verbatim recording of the installed
 * binary (`packages/providers/test/fixtures/cursor/cursor-run.ndjson`,
 * cursor-agent 2026.08.11-e8db854, 2026-08-26), NOT off the vendor-doc
 * mapping table in the plan, which the recording falsified in five places.
 * The traps the fixture actually carries:
 *
 *  - `tool_call` is a TOP-LEVEL line type, not a content block inside an
 *    `assistant` message the way Claude's is. Cursor's `assistant` lines
 *    carry text only.
 *  - The tool's NAME is not a field. It is the KEY of the `tool_call`
 *    object (`{"tool_call": {"readToolCall": {"args": {...}}}}`), sitting
 *    beside envelope keys (`toolCallId`, `hookAdditionalContexts`,
 *    `startedAtMs`, `completedAtMs`) that are not tools.
 *  - Each call produces TWO lines, `subtype: "started"` and
 *    `subtype: "completed"`, sharing one `call_id`. Only `started` becomes a
 *    `tool_call` event; emitting both would double every tool call in the
 *    action feed and in any count taken over the stream.
 *  - `call_id` CONTAINS A LITERAL NEWLINE, joining two identifiers. It is
 *    carried through verbatim: an id this parser "repaired" would match
 *    nothing the runtime ever said.
 *  - The `result` line reports NO turn count, NO cost, and NO stop reason.
 *    It does report `usage` token counts -- spec §7's claim that Cursor
 *    reports no tokens is wrong -- but `RunOutcome` has nowhere to put them
 *    and a token count is not a price.
 *
 * `numTurns: 0` on the terminal outcome is a documented FIDELITY GAP, not a
 * measurement: Cursor's result line carries no turn count at all, and this
 * function is per-line and stateless, so it cannot count assistant messages
 * across a stream (the plan asked for both at once; purity won -- M12 Task 10
 * ruling R3). The derivation belongs to the adapter that consumes the stream
 * and already tracks a run's lifetime; the zero here must never be presented
 * as a figure Cursor reported.
 *
 * `costUsd` and `stopReason` are ALWAYS `null`, never `0` and never a
 * default string: Cursor reports no spend (spec §7, capability
 * `reportsCost: false`) and unknown is not zero (spec Decision 6) -- zero is
 * a figure the budget guardrail believes. `deniedToolUseIds` is always `[]`;
 * Cursor's stream has no denial echo.
 *
 * NO BRANCH OF THIS FUNCTION MAY RETURN `hook_denied`, `hook_crashed`,
 * `hook_failed_open` OR `permission_denied` (M12 Task 10 ruling R4). Those
 * four exist for a hook-capable adapter that sees its gate's decisions on
 * the stream. Cursor's gate is a workspace `.cursor/hooks.json` hook whose
 * decisions never appear as stream lines -- the recording's only trace of
 * hooks at all is an empty `hookAdditionalContexts: []` array riding along
 * on the `tool_call` line -- and per the pre-flight ruling Cursor's shell
 * gate is defense-in-depth that does not produce `stopped_by_gate`. A
 * Claude-shaped hook line arriving here is noise, not a decision to
 * classify.
 */
export function parseCursorLine(line: string): RuntimeEvent {
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
    case 'assistant':
      return parseAssistantLine(raw, line)
    case 'tool_call':
      return parseToolCallLine(raw, line)
    case 'result':
      return parseResultLine(raw, line)
    case 'user':
      // The prompt echo, and (on a resumed session) the conversation so far.
      // Recognized; carries no decision for the orchestrator.
      return { kind: 'ignored', line }
    case 'thinking':
      // `subtype: "delta"` streams reasoning text token by token, closed by
      // `subtype: "completed"`. Deliberately NOT mapped to `text`: `text`
      // events are the worker's visible output, and folding a token-level
      // reasoning stream into them would bury the answer under its own
      // deliberation, in fragments, several events per sentence.
      return { kind: 'ignored', line }
    default:
      // A well-formed line of an unrecognized top-level type: a future CLI
      // adding one is something this parser has no decision for, not a
      // malformed line. Same judgement as the unrecognized subtypes below.
      return { kind: 'ignored', line }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const envelopeSchema = z.object({ type: z.string() })

// --- system ---------------------------------------------------------------

const systemEnvelopeSchema = z.object({ type: z.literal('system'), subtype: z.string() })

const initSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  // The init line also carries `cwd`, `model`, `permissionMode` and
  // `apiKeySource`. `model` in particular is the model Cursor actually
  // routed to (`"Auto Balance"` in the recording, which then routed again to
  // `Cursor Grok 4.6` in the assistant text) and is NOT necessarily the
  // `--model` that was requested -- worth knowing wherever the resolved
  // (provider, model) pair is displayed, but `session_started` has no field
  // for it and inventing one is not this task's business.
  session_id: z.string(),
})

function parseSystemLine(raw: unknown, line: string): RuntimeEvent {
  const envelope = systemEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return { kind: 'unparsable', line }

  if (envelope.data.subtype !== 'init') {
    // Recognized system housekeeping this parser has no decision for.
    return { kind: 'ignored', line }
  }

  const result = initSchema.safeParse(raw)
  if (!result.success) return { kind: 'unparsable', line }
  return { kind: 'session_started', sessionId: result.data.session_id }
}

// --- assistant ------------------------------------------------------------

const assistantEnvelopeSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({ content: z.array(z.unknown()) }),
})

const textContentSchema = z.object({ type: z.literal('text'), text: z.string() })

function parseAssistantLine(raw: unknown, line: string): RuntimeEvent {
  const envelope = assistantEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return { kind: 'unparsable', line }

  // Unlike Claude's, a Cursor `assistant` line never carries a tool_use
  // block -- tool calls are their own top-level lines -- so there is nothing
  // to prefer over the text here. Both recorded assistant lines hold exactly
  // one text block.
  const { content } = envelope.data.message
  if (content.length !== 1) return { kind: 'ignored', line }
  const [block] = content
  if (!isRecord(block)) return { kind: 'unparsable', line }
  if (block.type !== 'text') return { kind: 'ignored', line }

  const result = textContentSchema.safeParse(block)
  if (!result.success) return { kind: 'unparsable', line }
  return { kind: 'text', text: result.data.text }
}

// --- tool_call ------------------------------------------------------------

const toolCallEnvelopeSchema = z.object({
  type: z.literal('tool_call'),
  subtype: z.string(),
  // Present on both halves and identical across them. `tool_call.toolCallId`
  // repeats it; the top-level field is the envelope's own and is what is
  // read, so the two cannot disagree here.
  call_id: z.string(),
  tool_call: z.record(z.string(), z.unknown()),
})

/**
 * Keys of the `tool_call` object that are envelope bookkeeping rather than
 * the tool itself. The recording's shape is `{"readToolCall": {...},
 * "hookAdditionalContexts": [], "toolCallId": ..., "startedAtMs": ...}`,
 * with `completedAtMs` added on the completed half.
 *
 * This list is a DENYLIST and denylists go stale, which the fixture itself
 * demonstrates: `completedAtMs` is present on the `completed` half and
 * absent from the `started` half, so the set of bookkeeping keys already
 * varies between two lines about ONE call. A future `status`, `error` or
 * `durationMs` key is therefore to be expected, not guarded against -- hence
 * `toolKeyOf` below does not trust this list alone to identify the tool.
 */
const TOOL_CALL_ENVELOPE_KEYS = new Set(['toolCallId', 'hookAdditionalContexts', 'startedAtMs', 'completedAtMs'])

/**
 * Which key of the `tool_call` object names the tool, or `undefined` when
 * none does.
 *
 * MEASURED (the recording): Cursor's tool key follows a `<name>ToolCall`
 * convention -- `readToolCall`. That convention is the primary rule, and it
 * is what makes an unknown bookkeeping key harmless: a key the denylist has
 * never heard of loses to a key that actually looks like a tool, wherever
 * the two sit in iteration order.
 *
 * INFERENCE (the fallback): if no key follows the convention, the first key
 * that is not known bookkeeping is taken as the tool. That covers a Cursor
 * that renames its convention, at the price of naming a new bookkeeping key
 * as a tool in the one case where BOTH the convention is gone AND the
 * denylist is stale. Reporting an oddly-named action beats dropping a call
 * that really happened, and the alternative -- trusting the denylist alone,
 * as this function's first version did -- fabricates a tool name from the
 * first unrecognized key on every stream that grows one.
 *
 * `toolCallId` ends in `Id`, not `ToolCall`, so the convention clause cannot
 * catch it even if it were dropped from the denylist.
 */
function toolKeyOf(toolCall: Record<string, unknown>): string | undefined {
  const candidates = Object.keys(toolCall).filter((key) => !TOOL_CALL_ENVELOPE_KEYS.has(key))
  return candidates.find((key) => key.endsWith('ToolCall')) ?? candidates[0]
}

/**
 * The `args` keys `summaryFor` looks under, in priority order, for the one
 * readable argument that turns a bare tool name into an action line a human
 * can read at a glance (M4 spec §1) -- `read /abs/note.txt` rather than a
 * bare `read`.
 *
 * ONLY `path` is measured: the recording's single tool call is a read.
 * `command` is here because the shell tool is the entire subject of Cursor's
 * write gate (spec §7) and a shell action line without its command is
 * useless; the rest are absent deliberately rather than guessed at. An
 * unknown key is not a failure -- the summary falls back to the bare tool
 * name, exactly as it does for absent or malformed args.
 *
 * This deliberately MIRRORS `claude/stream.ts`'s `summaryFor` rather than
 * sharing it: the two runtimes' argument vocabularies differ (`path` here,
 * `file_path` there), and Series A froze the Claude parser's behavior, so
 * extracting a common helper would have meant editing it. The duplication is
 * named here so a later task can extract it on purpose instead of finding it
 * by accident.
 */
const SUMMARY_ARG_KEYS = ['path', 'command'] as const

const SUMMARY_ARG_MAX_LENGTH = 80

function firstStringArg(args: unknown): string | null {
  if (!isRecord(args)) return null
  for (const key of SUMMARY_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return null
}

function summaryFor(toolName: string, args: unknown): string {
  const raw = firstStringArg(args)
  if (raw === null) return toolName

  // Collapse newlines/tabs/runs of spaces to one space, so a multiline shell
  // command reads as one line rather than blowing up the action line.
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return toolName

  const trimmedArg =
    normalized.length > SUMMARY_ARG_MAX_LENGTH ? `${normalized.slice(0, SUMMARY_ARG_MAX_LENGTH)}…` : normalized
  return `${toolName} ${trimmedArg}`
}

function parseToolCallLine(raw: unknown, line: string): RuntimeEvent {
  const envelope = toolCallEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return { kind: 'unparsable', line }
  const data = envelope.data

  if (data.subtype !== 'started') {
    // `completed` carries the call's RESULT, under the same `call_id` the
    // `started` line already reported. It is a second line about ONE call,
    // not a second call, and `RuntimeEvent` has no variant for a completion,
    // so returning `tool_call` again would double every tool call in the
    // feed and in any count taken over the stream. An unrecognized future
    // subtype lands here too, by the same reasoning as everywhere else.
    return { kind: 'ignored', line }
  }

  const toolKey = toolKeyOf(data.tool_call)
  if (toolKey === undefined) {
    // A recognized shape whose one un-defaultable field is missing: there is
    // no honest tool name to report, and an empty one would put a nameless
    // action in the feed. `unparsable`, per the rule at the top.
    return { kind: 'unparsable', line }
  }

  // `readToolCall` -> `read`. A key that does not follow the convention is
  // reported under its own name rather than dropped, because an oddly-named
  // action in the feed beats a missing one.
  const toolName = toolKey.endsWith('ToolCall') ? toolKey.slice(0, -'ToolCall'.length) : toolKey

  const payload = data.tool_call[toolKey]
  const args = isRecord(payload) ? payload.args : undefined

  return {
    kind: 'tool_call',
    // Verbatim, embedded newline and all -- see the trap list at the top.
    toolUseId: data.call_id,
    toolName,
    summary: summaryFor(toolName, args),
  }
}

// --- result ---------------------------------------------------------------

const resultSchema = z.object({
  type: z.literal('result'),
  // Cursor has no `terminal_reason`; `subtype` (`success` in the recording)
  // is the only reason it reports.
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  // Everything else on the real line -- `duration_ms`, `duration_api_ms`,
  // `result`, `session_id`, `request_id`, `usage` -- is deliberately unread:
  // `RunOutcome` has no field for a duration, the final text has already
  // been emitted as `text` events, and `usage` is a token count, not a
  // price. Notably ABSENT from the real line: `num_turns`, `total_cost_usd`,
  // `stop_reason`, `permission_denials`.
})

function parseResultLine(raw: unknown, line: string): RuntimeEvent {
  const result = resultSchema.safeParse(raw)
  if (!result.success) return { kind: 'unparsable', line }
  const data = result.data

  // A `result` line must always produce `terminated` -- the alternative is
  // the orchestrator waiting on a process that has already exited. Absence
  // of any field is tolerated; only a present-but-wrongly-typed one (caught
  // above) is genuinely malformed.
  //
  // `is_error` defaults to `true`, not `false`: a run whose success cannot be
  // established is not a success, and reporting a failed run as a success is
  // worse than the reverse. The pump maps `terminated` onto
  // `run.succeeded` / `run.failed` using `is_error` with `terminalReason` as
  // the reason, so a silent default would produce a `run.failed` whose own
  // explanation reads like a normal completion -- hence the degradation is
  // named in the reason rather than applied quietly.
  //
  // Unlike Claude's, this check does NOT list `num_turns` or
  // `total_cost_usd`: those are always absent from a Cursor result line, by
  // design and not by degradation, and naming them on every healthy run
  // would make "degraded" mean nothing.
  const missing: string[] = []
  if (data.subtype === undefined) missing.push('subtype')
  if (data.is_error === undefined) missing.push('is_error')
  const terminalReason =
    missing.length === 0
      ? (data.subtype ?? 'unknown')
      : `${data.subtype ?? 'unknown'} (degraded result line, missing: ${missing.join(', ')})`

  return {
    kind: 'terminated',
    outcome: {
      isError: data.is_error ?? true,
      terminalReason,
      // Cursor reports no stop reason. `null`, never a default string.
      stopReason: null,
      // FIDELITY GAP, not a measurement -- see the docstring's R3 note.
      numTurns: 0,
      // Cursor reports no spend. `null`, never `0` (spec Decision 6): zero is
      // a figure the budget guardrail believes.
      costUsd: null,
      // Cursor's stream has no denial echo.
      deniedToolUseIds: [],
    },
  }
}
