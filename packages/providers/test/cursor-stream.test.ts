import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCursorLine } from '../src/cursor/stream.js'
import type { RuntimeEvent } from '../src/types.js'

/**
 * The fixture is a VERBATIM recording of the installed `cursor-agent`
 * (2026.08.11-e8db854), taken 2026-08-26 outside this repository:
 *
 *   cursor-agent --print --output-format stream-json --trust \
 *     "Read the file note.txt in this directory and tell me what it says."
 *
 * Provenance is the point: every mapping asserted below was READ OFF this
 * file, not taken from the plan's mapping table, which the recording
 * falsified in five places (task-10-report.md). Nothing in it was
 * reformatted, reordered, or hand-edited.
 *
 * It lives under `fixtures/cursor/` rather than beside the Claude fixtures
 * deliberately: `fake-claude.test.ts` walks `fixtures/*.ndjson` and asserts
 * that EVERY file there ends with Claude's routine `Stop` hook line. That
 * guard is right, and a second runtime's recording in the same directory
 * would have forced it to be weakened -- once for this fixture, and again
 * for every Cursor fixture Tasks 12 and 14 add. `readdir` is not recursive,
 * so a per-runtime subdirectory keeps the guard blanket and intact.
 */
const lines = readFileSync(new URL('./fixtures/cursor/cursor-run.ndjson', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)

/** The tool call the fixture actually made, verbatim. */
const FIXTURE_TOOL_PATH =
  '/tmp/claude-1001/-home-fixture-user-projects-repo/5c8fce38-aa67-4680-a656-317da244ac99/scratchpad/cursor-fixture/note.txt'
const FIXTURE_CALL_ID =
  'call-ae488142-4603-40ee-b2b1-6af10cd2ae63-0\nfc_12f193b8-7246-9972-8a7f-29022849f6a6_0'

const HOOK_KINDS = ['hook_started', 'hook_denied', 'hook_crashed', 'hook_failed_open', 'permission_denied'] as const

describe('parseCursorLine, against the recorded fixture', () => {
  it('recorded 13 lines whose types are exactly what the mapping below is derived from', () => {
    // A guard on the evidence itself: if the fixture is ever replaced, this
    // fails first and says so, rather than the mapping tests failing one by
    // one against a file nobody re-read.
    expect(lines).toHaveLength(13)
    expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
      'system',
      'user',
      'thinking',
      'thinking',
      'thinking',
      'assistant',
      'tool_call',
      'tool_call',
      'thinking',
      'thinking',
      'thinking',
      'assistant',
      'result',
    ])
  })

  it('maps every line of the real stream to the kind derived from it', () => {
    // One case per distinct `type` the fixture contains, asserted in one
    // place so a new kind cannot be added without this list moving.
    expect(lines.map((line) => parseCursorLine(line).kind)).toEqual([
      'session_started', // system/init
      'ignored', // user -- the prompt echo
      'ignored', // thinking/delta
      'ignored', // thinking/delta
      'ignored', // thinking/completed
      'text', // assistant
      'tool_call', // tool_call/started
      'ignored', // tool_call/completed -- the SAME call, not a second one
      'ignored',
      'ignored',
      'ignored',
      'text',
      'terminated', // result
    ])
  })

  it('reads the session id off the init line', () => {
    expect(parseCursorLine(lines[0]!)).toEqual({
      kind: 'session_started',
      sessionId: '14d4f18d-9417-4d34-a5cf-e326538d732a',
    })
  })

  it('reads an assistant line as text, from the same message.content shape Claude uses', () => {
    expect(parseCursorLine(lines[11]!)).toEqual({
      kind: 'text',
      text: '`note.txt` says: **The secret word is marmalade.**',
    })
  })

  it('populates toolUseId, toolName and summary from a real tool_call line rather than leaving them empty', () => {
    // The fields the orchestrator's action feed needs. The plan assumed a
    // Claude-shaped `tool_use` block with `id`/`name`/`input`; the real line
    // carries none of those names -- the tool NAME is the KEY of the
    // `tool_call` object (`readToolCall`), the id is `call_id`, and the args
    // are nested one level further down.
    const event = parseCursorLine(lines[6]!)
    expect(event).toEqual({
      kind: 'tool_call',
      toolUseId: FIXTURE_CALL_ID,
      toolName: 'read',
      summary: `read ${FIXTURE_TOOL_PATH.slice(0, 80)}…`,
    })
    // Explicitly, because "populated" is the assertion the brief asks for:
    expect(event).toMatchObject({ kind: 'tool_call' })
    if (event.kind !== 'tool_call') throw new Error('unreachable')
    expect(event.toolUseId.length).toBeGreaterThan(0)
    expect(event.toolName.length).toBeGreaterThan(0)
    expect(event.summary).not.toBe(event.toolName)
  })

  it('carries the embedded newline in call_id through verbatim rather than repairing it', () => {
    // MEASURED TRAP: Cursor's `call_id` contains a literal newline joining
    // two ids. A parser that "cleaned" it would produce an identifier that
    // matches nothing the runtime ever said, so it is carried verbatim.
    // TRACED (task-10 review §4): today it reaches only
    // `Checkpoint.lastToolUseId`, a nullable Postgres text column read back
    // into a checkpoint object no adapter reads. It is NOT in the
    // `run.tool_call` payload (`{name, summary}` only), and the one site
    // that logs a raw stream line logs escaped JSON. There is no
    // line-oriented consumer today; whoever adds one inherits this decision.
    const event = parseCursorLine(lines[6]!)
    if (event.kind !== 'tool_call') throw new Error('expected tool_call')
    expect(event.toolUseId).toContain('\n')
    expect(event.toolUseId).toBe(FIXTURE_CALL_ID)
  })

  it('does not emit a second tool_call for the completed half of the same call', () => {
    // Both halves are `type: "tool_call"` and carry the SAME `call_id`.
    // Emitting both would double every tool call in the feed and in any
    // count taken over the stream.
    const started = JSON.parse(lines[6]!) as { call_id: string; subtype: string }
    const completed = JSON.parse(lines[7]!) as { call_id: string; subtype: string }
    expect(started.subtype).toBe('started')
    expect(completed.subtype).toBe('completed')
    expect(completed.call_id).toBe(started.call_id)
    expect(parseCursorLine(lines[7]!)).toEqual({ kind: 'ignored', line: lines[7] })
  })

  it('reports an unknown cost and an unknown stop reason on the terminal line rather than zero', () => {
    expect(parseCursorLine(lines[12]!)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: false,
        terminalReason: 'success',
        stopReason: null,
        // Cursor reports NO turn count on its result line (verified: the line
        // carries subtype, duration_ms, duration_api_ms, is_error, result,
        // session_id, request_id, usage -- and nothing else). 0 is the
        // documented fidelity gap; Task 12's adapter derives the real figure.
        numTurns: 0,
        costUsd: null,
        deniedToolUseIds: [],
        // 15391 (input) + 25856 (cacheRead) + 0 (cacheWrite) = 41247, under
        // the same billed-input rule as Claude's (M15 spec §4).
        tokens: { input: 41247, output: 223 },
      },
    })
  })

  it('does not mistake the result line’s token usage for a cost', () => {
    // Spec §7 says Cursor reports "neither cost, tokens, nor a stop reason".
    // The fixture proves the middle claim WRONG: `usage` carries four token
    // counts, mapped into `RunOutcome.tokens` under the billed-input rule
    // (M15 spec §4). It still carries no price, so `costUsd` stays null --
    // but a later reader must not be told the tokens were absent.
    const raw = JSON.parse(lines[12]!) as { usage?: Record<string, number> }
    expect(raw.usage).toEqual({ inputTokens: 15391, outputTokens: 223, cacheReadTokens: 25856, cacheWriteTokens: 0 })
    expect(raw).not.toHaveProperty('total_cost_usd')
    expect(raw).not.toHaveProperty('num_turns')
    expect(raw).not.toHaveProperty('stop_reason')
    const event = parseCursorLine(lines[12]!)
    if (event.kind !== 'terminated') throw new Error('expected terminated')
    expect(event.outcome.costUsd).toBeNull()
  })

  it('produces no hook variant for any line of a real run', () => {
    // R4: Cursor's gate is a workspace hook, not a stream event, so the three
    // Claude-shaped kinds (`hook_denied`, `hook_crashed`, `hook_failed_open`)
    // never come out of this parser. `permission_denied` is the fourth
    // HOOK_KINDS member and is NOT banned -- it IS the mapping for a rejected
    // `tool_call`/`completed` half (see the parser's docstring) -- but this
    // fixture (`cursor-run.ndjson`) has no rejection in it, so none of the
    // four show up here either.
    for (const line of lines) {
      expect(HOOK_KINDS).not.toContain(parseCursorLine(line).kind)
    }
  })
})

/**
 * A REAL rejected `tool_call`/`completed` line, from the same M13 Task 9 gate recording
 * `cursor-adapter.test.ts` already reads (`fixtures/cursor/gate/run-2-flag-present.ndjson`, cursor's
 * own shell gate denying a call while the pause flag was present) -- not a synthesized shape. M15
 * maps this: the completed half's `result` carries `rejected`, and that is Cursor's own denial
 * echo, distinct from the Claude-shaped `hook_denied`/`hook_crashed`/`hook_failed_open` family R4
 * still bans (see the parser's docstring). Never assert on `reason`'s text below: cursor-agent
 * self-updates between runs and its message prefixes have changed before (M13 Task 9's own
 * recording of a LATER binary already shows different wording for the same denial).
 */
const GATE_LINES = readFileSync(
  new URL('./fixtures/cursor/gate/run-2-flag-present.ndjson', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
const REJECTED_COMPLETED_LINE = GATE_LINES.find((line) => line.includes('"rejected"'))
if (REJECTED_COMPLETED_LINE === undefined) {
  throw new Error('fixture no longer contains a rejected completed line; the test below needs one')
}

describe('parseCursorLine, a rejected completed half (M15)', () => {
  it('maps a completed half carrying a rejected result to permission_denied', () => {
    const event = parseCursorLine(REJECTED_COMPLETED_LINE)
    expect(event.kind).toBe('permission_denied')
    if (event.kind !== 'permission_denied') throw new Error('expected permission_denied')
    // `call_id`, verbatim -- the same field `tool_call`'s started half reports as `toolUseId`.
    expect(event.toolUseId).toBe('tool_264c8d13-d13d-498e-bc8a-66a4ff75d74')
    // `shellToolCall` -> `shell`, the same convention the started half's tool name follows.
    expect(event.toolName).toBe('shell')
  })

  it('reads the rejection reason off the real recording, unlike before M18 Task 6 -- but never asserts its wording (same self-update hazard as above)', () => {
    const event = parseCursorLine(REJECTED_COMPLETED_LINE)
    if (event.kind !== 'permission_denied') throw new Error('expected permission_denied')
    // Measured present (M18 Task 6 brief) and, until this task, discarded. Only presence and type
    // are pinned here -- the text itself is exactly what the comment above forbids asserting on.
    expect(typeof event.reason).toBe('string')
    expect(event.reason).not.toBe('')
  })

  it('reads a synthetic rejection carrying a permission-matrix reason into permission_denied.reason verbatim (M18 Task 6)', () => {
    // Cursor's OWN denial echo, wearing the SAME matrix-prefixed reason Claude's `hook_denied`
    // does -- this is what lets the pump's `permission_denied` case (`apps/orchestrator/src/pump.ts`)
    // tell a matrix refusal apart from an ordinary Cursor shell-gate pause, the same way
    // `classifyGateEvent` tells it apart on the Claude side.
    const reason = "permission matrix denies 'run tests' (Bash) for this agent"
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c-matrix-1',
      tool_call: { shellToolCall: { args: { command: 'npm test' }, result: { rejected: { reason } } } },
    })
    expect(parseCursorLine(line)).toEqual({
      kind: 'permission_denied',
      toolName: 'shell',
      toolUseId: 'c-matrix-1',
      reason,
    })
  })

  it('omits reason entirely (not a stringified undefined) when the rejection carries none', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c-no-reason',
      tool_call: { shellToolCall: { args: { command: 'ls' }, result: { rejected: {} } } },
    })
    const event = parseCursorLine(line)
    expect(event).toEqual({ kind: 'permission_denied', toolName: 'shell', toolUseId: 'c-no-reason' })
    if (event.kind !== 'permission_denied') throw new Error('expected permission_denied')
    expect('reason' in event).toBe(false)
  })

  it('still ignores an ordinary completed half', () => {
    // `lines[7]` (`cursor-run.ndjson`): a real completed half whose result carries no rejection.
    expect(parseCursorLine(lines[7]!).kind).toBe('ignored')
  })
})

describe('parseCursorLine, totality', () => {
  it('returns unparsable rather than throwing on a truncated line', () => {
    expect(parseCursorLine('{"type":"resu')).toEqual({ kind: 'unparsable', line: '{"type":"resu' })
  })

  it('returns unparsable for the empty string rather than throwing', () => {
    expect(parseCursorLine('')).toEqual({ kind: 'unparsable', line: '' })
  })

  it('returns unparsable for well-formed JSON that is not an envelope', () => {
    expect(parseCursorLine('[]')).toEqual({ kind: 'unparsable', line: '[]' })
    expect(parseCursorLine('null')).toEqual({ kind: 'unparsable', line: 'null' })
    expect(parseCursorLine('{"subtype":"init"}')).toEqual({ kind: 'unparsable', line: '{"subtype":"init"}' })
  })

  it('returns ignored for a well-formed line of an unrecognized top-level type', () => {
    // Same discipline as the Claude parser: a future CLI type is something
    // this parser has no decision for, not a defect.
    const line = JSON.stringify({ type: 'some_future_type', foo: 'bar' })
    expect(parseCursorLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('returns ignored for a recognized line it does not act on', () => {
    const line = JSON.stringify({ type: 'user', message: {} })
    expect(parseCursorLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('returns unparsable for an init line with no session_id', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', cwd: '/tmp' })
    expect(parseCursorLine(line)).toEqual({ kind: 'unparsable', line })
  })

  it('returns ignored for a system line of an unrecognized subtype', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'some_future_subtype' })
    expect(parseCursorLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('returns unparsable for a tool_call line with no call_id', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      tool_call: { readToolCall: { args: { path: '/tmp/x' } }, toolCallId: 'c1' },
    })
    expect(parseCursorLine(line)).toEqual({ kind: 'unparsable', line })
  })

  it('returns unparsable for a tool_call line whose tool_call object names no tool', () => {
    // A recognized shape with the one field that cannot be defaulted missing:
    // there is no honest `toolName` to report, and an empty one would put a
    // nameless action in the feed.
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c1',
      tool_call: { hookAdditionalContexts: [], toolCallId: 'c1', startedAtMs: '1' },
    })
    expect(parseCursorLine(line)).toEqual({ kind: 'unparsable', line })
  })

  it('returns ignored for a tool_call line of an unrecognized subtype', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'some_future_subtype',
      call_id: 'c1',
      tool_call: { readToolCall: { args: { path: '/tmp/x' } } },
    })
    expect(parseCursorLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('returns unparsable for an assistant line whose content is not an array', () => {
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } })
    expect(parseCursorLine(line)).toEqual({ kind: 'unparsable', line })
  })

  it('returns unparsable for a multi-block assistant line, so a lost message is counted rather than silent', () => {
    // Fix round 2. MEASURED: both recorded assistant lines carry exactly one
    // text block. A two-block line is therefore a shape this parser cannot
    // carry FAITHFULLY -- joining blocks with `\n` versus `''` versus
    // something else is unknowable from two single-block lines, and guessing
    // it would be the same sin as writing the parser from vendor docs.
    //
    // But it is NOT "a kind we have no decision for", which is what `ignored`
    // means. It is a real message from the agent, and `ignored` made the
    // whole thing vanish from the operator's feed with nothing counted,
    // nothing warned, nothing anywhere. `unparsable` is
    // where the loss becomes loud: `pump.ts:507-508` counts it and warns WITH
    // THE WHOLE OFFENDING LINE, so the dropped message lands in the
    // orchestrator log and can be read back. Non-fatal and attributable.
    //
    // The count itself surfaces nowhere on this path: `unparsableLines` is
    // interpolated only at `pump.ts:559`, in the branch for a stream that
    // ended with NO terminal event, and a Cursor run that drops a multi-block
    // message ends normally on a `result` line. An earlier version of this
    // comment claimed the terminal reason carries it; it does not.
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First half.' },
          { type: 'text', text: 'Second half.' },
        ],
      },
    })
    expect(parseCursorLine(line)).toEqual({ kind: 'unparsable', line })
  })

  it('returns ignored for an assistant line with no content blocks at all', () => {
    // Fix round 2, decided deliberately and NOT swept in with the multi-block
    // case above. An empty `content` array loses nothing: there is no text to
    // carry, so calling it a defect would be false.
    //
    // The load-bearing reason is what `unparsable` is FOR here. Its whole
    // value in the branch above is that the count means "real output was
    // dropped" -- an operator reading `(3 unparsable line(s) were dropped
    // first)` must be able to believe three pieces of the agent's message are
    // missing. Padding that counter with messages that carried nothing debases
    // exactly the signal this round exists to create, in the same way `?? 0`
    // on an unmeasured cost debased a figure the budget guardrail believed.
    //
    // It is also the conservative edit: `content.length !== 1` already sent
    // this case to `ignored`, so this round changes behaviour ONLY where
    // something is actually lost.
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } })
    expect(parseCursorLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('returns ignored for an assistant line carrying a single content block that is not text', () => {
    // Deliberately NOT swept into the multi-block `unparsable` branch: one
    // block of an unrecognized type IS "a kind this parser has no decision
    // for", which is what `ignored` means. Nothing was lost that this parser
    // ever knew how to carry.
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'image', source: {} }] },
    })
    expect(parseCursorLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('produces no hook variant for any input, including lines shaped like Claude hook events', () => {
    // R4, as a property rather than a fixture walk: Cursor's shell gate is
    // defense-in-depth and never reaches the stream, so a Claude-shaped hook
    // line arriving here is noise, not a gate decision to classify.
    const suspects = [
      '',
      '{not json',
      JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse:Bash', exit_code: 2 }),
      JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Edit', tool_use_id: 'tu_1' }),
      JSON.stringify({ type: 'hook_response', hook_name: 'beforeShellExecution', permission: 'deny' }),
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'c1',
        tool_call: {
          shellToolCall: { args: { command: 'rm -rf /' } },
          hookAdditionalContexts: [{ permission: 'deny', reason: 'Paused by Slave of AI.' }],
        },
      }),
      ...lines,
    ]
    for (const line of suspects) {
      expect(HOOK_KINDS).not.toContain(parseCursorLine(line).kind)
    }
  })
})

describe('parseCursorLine, the result line', () => {
  it('names is_error as defaulted when it is missing, rather than reading as a clean success', () => {
    // Mirrors the Claude parser's discipline (stream.ts): a run whose success
    // cannot be established is not a success, and the default must leave a
    // trace in the reason the pump will show.
    const line = JSON.stringify({ type: 'result', subtype: 'error', duration_ms: 12 })
    expect(parseCursorLine(line)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: true,
        terminalReason: 'error (degraded result line, missing: is_error)',
        stopReason: null,
        numTurns: 0,
        costUsd: null,
        deniedToolUseIds: [],
        tokens: null,
      },
    })
  })

  it('still produces terminated for a result line carrying nothing but its type', () => {
    // A result line must ALWAYS terminate the run; the alternative is the
    // orchestrator waiting on a process that has already exited.
    const line = JSON.stringify({ type: 'result' })
    expect(parseCursorLine(line)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: true,
        terminalReason: 'unknown (degraded result line, missing: subtype, is_error)',
        stopReason: null,
        numTurns: 0,
        costUsd: null,
        deniedToolUseIds: [],
        tokens: null,
      },
    })
  })

  it('is unparsable only when a present field has the wrong type', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: 'no' })
    expect(parseCursorLine(line)).toEqual({ kind: 'unparsable', line })
  })

  it('never reports a cost, even if a future result line grew a total_cost_usd field', () => {
    // R6 / Decision 6: Cursor is cost-blind by capability. If that ever
    // changes it is a capability change (reportsCost) plus a task, not a
    // field this parser quietly starts believing.
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.42 })
    const event = parseCursorLine(line)
    if (event.kind !== 'terminated') throw new Error('expected terminated')
    expect(event.outcome.costUsd).toBeNull()
  })

  it('reports null tokens when the result line carries no usage at all', () => {
    const terminal = parseCursorLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, result: 'done' }),
    )
    expect(terminal.kind).toBe('terminated')
    expect((terminal as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toBeNull()
  })

  it('maps the result usage under the billed-input rule: input+cacheRead+cacheWrite / output', () => {
    const event = parseCursorLine(lines[12]!)
    // 15391 + 25856 + 0 = 41247
    expect(event.kind === 'terminated' && event.outcome.tokens).toEqual({ input: 41247, output: 223 })
  })

  it('degrades malformed usage to null, never to a guess', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: { inputTokens: 'many' } })
    const event = parseCursorLine(line)
    expect(event.kind === 'terminated' && event.outcome.tokens).toBeNull()
  })

  it('absent usage stays null', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false })
    const event = parseCursorLine(line)
    expect(event.kind === 'terminated' && event.outcome.tokens).toBeNull()
  })
})

describe('parseCursorLine, the tool_call summary', () => {
  it('reads a short path argument into the summary without truncating it', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c1',
      tool_call: { readToolCall: { args: { path: '/abs/note.txt' } }, toolCallId: 'c1' },
    })
    expect(parseCursorLine(line)).toEqual({
      kind: 'tool_call',
      toolUseId: 'c1',
      toolName: 'read',
      summary: 'read /abs/note.txt',
    })
  })

  it('reads a shell command into the summary', () => {
    // UNMEASURED SHAPE (the fixture's one tool call is a read). `command` is
    // in the key list anyway because the shell tool is the entire subject of
    // Cursor's gate (spec §7) and a shell action line without its command is
    // useless. If the real key turns out to differ, this test is where it
    // gets corrected -- the fallback is the bare tool name, never a throw.
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c2',
      tool_call: { shellToolCall: { args: { command: 'ls -la' } } },
    })
    expect(parseCursorLine(line)).toMatchObject({ toolName: 'shell', summary: 'shell ls -la' })
  })

  it('collapses whitespace in a multiline command and truncates it at 80 chars with an ellipsis', () => {
    const command = `ls -la\t\t\n\n${'x'.repeat(90)}`
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c3',
      tool_call: { shellToolCall: { args: { command } } },
    })
    const expectedArg = `ls -la ${'x'.repeat(73)}…`
    expect(expectedArg.length).toBe(81) // 80 chars of arg + the appended ellipsis
    expect(parseCursorLine(line)).toMatchObject({ summary: `shell ${expectedArg}` })
  })

  it('falls back to the bare tool name when args are absent, malformed, or hold no known key', () => {
    const cases: readonly [string, unknown][] = [
      ['no args', { readToolCall: {} }],
      ['args not an object', { readToolCall: { args: 'nope' } }],
      ['no known key', { readToolCall: { args: { unknownArgument: '/abs/x' } } }],
      ['known key, non-string value', { readToolCall: { args: { path: 42 } } }],
      ['known key, blank value', { readToolCall: { args: { path: '   ' } } }],
      ['tool payload not an object', { readToolCall: 'nope' }],
    ]
    for (const [label, toolCall] of cases) {
      const line = JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'c4', tool_call: toolCall })
      expect(parseCursorLine(line), label).toEqual({
        kind: 'tool_call',
        toolUseId: 'c4',
        toolName: 'read',
        summary: 'read',
      })
    }
  })

  it('prefers the key that names a tool over an unknown bookkeeping key beside it', () => {
    // REGRESSION GUARD (task-10 review, finding 2). The envelope-key denylist
    // is PROVEN to go stale by the fixture itself: `completedAtMs` is on the
    // `completed` half and not the `started` half, so the bookkeeping keys
    // already differ between two lines about one call. Selecting the first
    // key the denylist does not recognize therefore fabricates a tool name
    // -- and a fabricated action line in the operator's feed -- the moment
    // cursor-agent adds a `status`/`error`/`durationMs` key ahead of the
    // tool. The `*ToolCall` convention is the primary rule for exactly this
    // reason. Iteration order is JSON key order, so the unknown key is put
    // FIRST here deliberately: under the old rule this test reads `status`.
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c6',
      tool_call: {
        status: 'running',
        durationMs: 12,
        readToolCall: { args: { path: '/abs/x' } },
        hookAdditionalContexts: [],
        toolCallId: 'c6',
      },
    })
    expect(parseCursorLine(line)).toEqual({
      kind: 'tool_call',
      toolUseId: 'c6',
      toolName: 'read',
      summary: 'read /abs/x',
    })
  })

  it('reports a tool key that does not follow the ToolCall convention under its own name', () => {
    // The FALLBACK branch of the two-branch rule: no key follows the
    // `*ToolCall` convention, so the first non-bookkeeping key is taken.
    // Rather than dropping the call: an unnamed action in the feed is worse
    // than an oddly-named one.
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c5',
      tool_call: { somethingElse: { args: { path: '/abs/x' } }, hookAdditionalContexts: [] },
    })
    expect(parseCursorLine(line)).toMatchObject({ toolName: 'somethingElse', summary: 'somethingElse /abs/x' })
  })
})

describe('parseCursorLine, exhaustiveness of RuntimeEvent', () => {
  it('produces only the six kinds this parser is allowed to produce', () => {
    // The complement of R4, stated positively, so adding a branch that
    // returns a seventh kind fails here and not in Task 12's adapter.
    const produced = new Set<RuntimeEvent['kind']>()
    for (const line of [...lines, '', '{bad', JSON.stringify({ type: 'result' })]) {
      produced.add(parseCursorLine(line).kind)
    }
    for (const kind of produced) {
      expect(['session_started', 'text', 'tool_call', 'terminated', 'ignored', 'unparsable']).toContain(kind)
    }
  })
})
