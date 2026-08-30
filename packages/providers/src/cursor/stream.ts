import { z } from 'zod'
import { CURSOR_SUMMARY_ARG_KEYS, isRecord, summaryFor } from '../runtime/summary.js'
import type { RuntimeEvent } from '../types.js'

/**
 * `parseCursorLine` is a pure, total function: one NDJSON line from
 * `cursor-agent --print --output-format stream-json` in, one `RuntimeEvent`
 * out. It never throws, for any input, including the empty string. It mirrors
 * `packages/providers/src/claude/stream.ts`'s discipline exactly, including
 * the distinction that matters most: invalid JSON, or a recognized shape this
 * parser cannot carry faithfully -- a required field missing, or (fix round 2)
 * real content it would have to invent a shape to represent -- is `unparsable`
 * (a defect); a well-formed line of a kind this parser has no decision for is
 * `ignored` (merely uninteresting). Getting those backwards is how a malformed
 * line stops being visible.
 *
 * Note the widening: Claude's parser reaches `unparsable` only through missing
 * fields, because every shape it meets is one it can carry. This one also
 * reaches it through a shape that is COMPLETE and unrepresentable, which is a
 * different road to the same honest destination.
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
 *    It DOES report `usage` token counts (`inputTokens`, `outputTokens`,
 *    `cacheReadTokens`, `cacheWriteTokens` -- see
 *    `test/fixtures/cursor/cursor-run.ndjson`); spec §7's claim that Cursor
 *    reports no tokens is wrong. M14 Decision 4's `Cursor -> null` provider
 *    rule is superseded by M15 (spec §4): the four counters are mapped into
 *    `RunOutcome.tokens` under the same billed-input rule as Claude's, by
 *    `tokensFromUsage` below.
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
 * a figure the budget guardrail believes. `deniedToolUseIds` on the RESULT
 * line is always `[]`, still -- not because Cursor's stream has no denial
 * echo (M15: it does, see below), but because the echo arrives as its OWN
 * `tool_call`/`completed` line, addressed by `call_id`, not folded into the
 * `result` line's fields the way a turn count or a cost would be.
 *
 * NO BRANCH OF THIS FUNCTION MAY RETURN `hook_denied`, `hook_crashed` OR
 * `hook_failed_open` (M12 Task 10 ruling R4, narrowed by M15). Those three
 * exist for a hook-capable adapter that sees its gate's decisions on the
 * stream, and they drive `stopped_by_gate` and the workspace circuit
 * breaker. Cursor's gate is a workspace `.cursor/hooks.json` hook whose
 * decisions never appear as stream lines -- the recording's only trace of
 * hooks at all is an empty `hookAdditionalContexts: []` array riding along
 * on the `tool_call` line -- and per the pre-flight ruling Cursor's shell
 * gate is defense-in-depth that must never trip either mechanism. A
 * Claude-shaped hook line arriving here is noise, not a decision to
 * classify, and the ban on those three STANDS.
 *
 * `permission_denied` is OFF that banned list as of M15: a completed
 * `tool_call` whose result carries `rejected` (measured:
 * `fixtures/cursor/gate/run-2-flag-present.ndjson`, M13 Task 9) is Cursor's
 * OWN rejected echo, not a Claude-shaped hook line arriving where it does
 * not belong, and reporting it is exactly what this parser exists to do.
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
  // to prefer over the text here.
  //
  // WHAT IS MEASURED: exactly one `text` block, on both of the recording's
  // two assistant lines. That is the whole of the evidence.
  //
  // WHAT IS NOT: everything else. In particular, how a multi-block assistant
  // message should be carried -- joined with `\n`, joined with `''`, or
  // something else entirely -- is UNKNOWABLE from two lines that each carry
  // one block, and guessing it would be the same error as writing this
  // parser from vendor docs. So it is not guessed at.
  //
  // TASK 12 OWES A RECORDING with a longer, multi-part answer to settle the
  // faithful mapping BEFORE this becomes load-bearing. Until that recording
  // exists, the gap is made loud rather than made up.
  const { content } = envelope.data.message

  if (content.length > 1) {
    // `unparsable`, not `ignored`, and the distinction is the whole point of
    // M12 Task 10's fix round 2. `ignored` means "a well-formed line of a
    // kind this parser has no decision for". A two-block assistant message is
    // not that: it is exactly the kind this parser DOES have a decision for,
    // carrying more than was measured. Folding it into `ignored` made a real
    // message from the agent vanish from the operator's feed with nothing
    // counted, nothing warned and nothing in the terminal reason.
    //
    // `unparsable` is where that loss becomes attributable and non-fatal:
    // `pump.ts:507-508` counts it and warns to the console WITH THE WHOLE
    // OFFENDING LINE, so the dropped message itself lands in the orchestrator
    // log and can be read back.
    //
    // PRECISELY, because the first version of this comment overstated it (the
    // claim was the controller's and the fix-round re-review caught it):
    // `unparsableLines` is interpolated ONLY at `pump.ts:559`, inside the
    // branch for a stream that ended with NO terminal event. A run that ends
    // normally on a `result` line -- which is exactly when a dropped
    // multi-block message happens -- never reaches it, so the COUNT surfaces
    // nowhere and only the warning does. That is still strictly better than
    // `ignored`, which produced neither; but "it shows up in the terminal
    // reason" is false for this case and must not be repeated.
    // Routed: a normally-terminating run has no durable record of dropped
    // lines at all. Pre-existing, and it affects Claude runs identically.
    return { kind: 'unparsable', line }
  }

  if (content.length === 0) {
    // Deliberately NOT the branch above. An empty `content` array loses
    // nothing -- there is no text to carry -- so calling it a defect would be
    // false, and it would debase the counter that branch depends on: an
    // operator reading "3 unparsable lines were dropped" must be able to
    // believe three pieces of the agent's message are missing. Padding that
    // count with messages that carried nothing is the same class of lie as
    // reporting an unmeasured cost as `0`.
    return { kind: 'ignored', line }
  }

  const [block] = content
  if (!isRecord(block)) return { kind: 'unparsable', line }
  // One block of an unrecognized type IS "a kind this parser has no decision
  // for" -- nothing was lost that this parser ever knew how to carry -- so it
  // stays `ignored` and is not swept in with the multi-block case above.
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

function parseToolCallLine(raw: unknown, line: string): RuntimeEvent {
  const envelope = toolCallEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return { kind: 'unparsable', line }
  const data = envelope.data

  if (data.subtype !== 'started') {
    // `completed` carries the call's RESULT, under the same `call_id` the
    // `started` line already reported. It is a second line about ONE call,
    // not a second call, and `RuntimeEvent` has no variant for a plain
    // completion, so returning `tool_call` again would double every tool
    // call in the feed and in any count taken over the stream. An
    // unrecognized future subtype lands here too, by the same reasoning as
    // everywhere else -- UNLESS the result the completed half carries is a
    // rejection, checked next.
    //
    // MEASURED (`fixtures/cursor/gate/run-2-flag-present.ndjson`, M13 Task 9):
    // a call this system's own shell gate denied completes as
    // `{"shellToolCall":{"result":{"rejected":{"command":...,"reason":...}}}}`
    // -- the rejection nests under `result.rejected` inside the SAME
    // tool-named object the started half's `args` sits in, not beside it.
    // This is Cursor's OWN denial echo (M15), and it is distinct from the
    // Claude-shaped `hook_denied`/`hook_crashed`/`hook_failed_open` family
    // R4 still bans below: it is `permission_denied` off that list, per M15.
    const toolKey = toolKeyOf(data.tool_call)
    const payload = toolKey === undefined ? undefined : data.tool_call[toolKey]
    const result = isRecord(payload) ? payload.result : undefined
    if (toolKey !== undefined && isRecord(result) && 'rejected' in result) {
      return {
        kind: 'permission_denied',
        // Same derivation the started half uses below: `shellToolCall` -> `shell`.
        toolName: toolKey.endsWith('ToolCall') ? toolKey.slice(0, -'ToolCall'.length) : toolKey,
        toolUseId: data.call_id,
      }
    }
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
    summary: summaryFor(toolName, args, CURSOR_SUMMARY_ARG_KEYS),
  }
}

// --- result ---------------------------------------------------------------

const resultSchema = z.object({
  type: z.literal('result'),
  // Cursor has no `terminal_reason`; `subtype` (`success` in the recording)
  // is the only reason it reports.
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  // `usage` IS present and IS populated (`inputTokens`, `outputTokens`,
  // `cacheReadTokens`, `cacheWriteTokens` -- `test/fixtures/cursor/cursor-run.ndjson`) and is
  // read here, then mapped by `tokensFromUsage` below (M15 spec §4, superseding M14 Decision
  // 4's `Cursor -> null` provider rule). It is `z.unknown()`, deliberately NOT a `z.object` of
  // numbers: a wrongly-typed `usage` must degrade `tokens` to `null`, never make the whole
  // result line unparsable and leave the orchestrator waiting on a process that already exited.
  // Everything else on the real line -- `duration_ms`, `duration_api_ms`, `result`,
  // `session_id`, `request_id` -- stays unread: `RunOutcome` has no field for a duration, and
  // the final text has already been emitted as `text` events. Notably ABSENT from the real
  // line: `num_turns`, `total_cost_usd`, `stop_reason`, `permission_denials`.
  usage: z.unknown().optional(),
})

/**
 * `RunOutcome.tokens` from the result line's `usage`, under the same billed-input rule as
 * Claude's (`types.ts`): input = inputTokens + cacheReadTokens + cacheWriteTokens (each billed,
 * each 0 when absent), output = outputTokens alone. Any PRESENT field that is not a
 * non-negative finite number degrades the whole reading to `null` -- a partial figure is a lie
 * the per-agent averages would believe, and cursor-agent self-updates without notice, so the
 * shape is tolerated, never asserted (M15 spec §4).
 */
function tokensFromUsage(usage: unknown): { readonly input: number; readonly output: number } | null {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return null
  const read = (key: string): number | null => {
    const value = (usage as Record<string, unknown>)[key]
    if (value === undefined) return 0
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }
  const input = read('inputTokens')
  const output = read('outputTokens')
  const cacheRead = read('cacheReadTokens')
  const cacheWrite = read('cacheWriteTokens')
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
  return { input: input + cacheRead + cacheWrite, output }
}

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
      // Cursor's denial echo exists (M15) but does not live here: it is its
      // own `tool_call`/`completed` line, mapped to `permission_denied`, not
      // a field this `result` line carries.
      deniedToolUseIds: [],
      // Cursor's `result` line DOES carry `usage`, in camelCase: `inputTokens`,
      // `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` -- the same four counters the
      // Claude billed-input rule sums. See `test/fixtures/cursor/cursor-run.ndjson`, whose
      // result line reads
      // `"usage":{"inputTokens":15391,"outputTokens":223,"cacheReadTokens":25856,"cacheWriteTokens":0}`
      // (41247 billed input, 223 output -- `tokensFromUsage`'s doc comment above).
      //
      // Mapped, not `null`: M14 Decision 4's `Cursor -> null` provider rule is superseded by
      // M15 (spec §4). `runtimeReportsUsage` in `pump.ts` is unrelated -- it gates SKILL
      // completion tallies, not this field. A malformed `usage` degrades to `null` inside
      // `tokensFromUsage`, never a guess; it never makes this `result` line itself unparsable.
      tokens: tokensFromUsage(data.usage),
    },
  }
}
