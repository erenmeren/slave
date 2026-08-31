import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isPreToolUseHookResponseLine, parseStreamLine } from '../src/claude/stream.js'
import { PERMISSION_DENY_REASON_PREFIX } from '../src/gate.js'
import type { RuntimeEvent } from '../src/types.js'

describe('parseStreamLine', () => {
  it('reads the session id from the init line', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' })
    expect(parseStreamLine(line)).toEqual({ kind: 'session_started', sessionId: 'abc-123' })
  })

  it('double-parses hook_response.output, which is a JSON-encoded string', () => {
    const inner = JSON.stringify({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Paused by AI Team OS.' },
    })
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      output: inner,
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'hook_denied',
      hookName: 'PreToolUse:Bash',
      reason: 'Paused by AI Team OS.',
    })
  })

  it('passes a permission-matrix deny reason through hook_denied verbatim (M18 Task 6) -- classifyGateEvent, not this parser, tells it apart from a pause', () => {
    // This parser makes no distinction at all between a pause deny and a matrix deny: both are an
    // ordinary `hookSpecificOutput.permissionDecision: 'deny'` payload, and `reason` is copied
    // through exactly as `extractDenyReason` reads it either way. The split lives one layer up, in
    // `classifyGateEvent`'s prefix check -- this test exists to pin that no change was needed here
    // for that split to work, per the M18 Task 6 brief's own "verify passthrough suffices" note.
    const reason = `${PERMISSION_DENY_REASON_PREFIX} 'run tests' (Bash) for this agent`
    const inner = JSON.stringify({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason },
    })
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      output: inner,
    })
    expect(parseStreamLine(line)).toEqual({ kind: 'hook_denied', hookName: 'PreToolUse:Bash', reason })
  })

  it('never conflates a permission-mode denial with a hook denial', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Edit',
      tool_use_id: 'tu_1',
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'permission_denied',
      toolName: 'Edit',
      toolUseId: 'tu_1',
    })
  })

  it('reads the outcome from the terminal result event, including its denials', () => {
    const line = JSON.stringify({
      type: 'result',
      is_error: false,
      terminal_reason: 'completed',
      stop_reason: 'end_turn',
      num_turns: 4,
      total_cost_usd: 0.12,
      permission_denials: [{ tool_use_id: 'tu_1' }, { tool_use_id: 'tu_2' }],
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: false,
        terminalReason: 'completed',
        stopReason: 'end_turn',
        numTurns: 4,
        costUsd: 0.12,
        deniedToolUseIds: ['tu_1', 'tu_2'],
        tokens: null,
      },
    })
  })

  it('returns unparsable rather than throwing on a malformed line', () => {
    expect(parseStreamLine('{not json')).toEqual({ kind: 'unparsable', line: '{not json' })
  })

  it('returns hook_crashed for a PreToolUse hook_response that exits 2', () => {
    // Measured shape: spike 2026-08-18 §1.4. output is the hook's stderr, not JSON --
    // treating a failed inner parse as `unparsable` would file a broken gate as stream noise.
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      output: 'deliberate hook crash\n',
      stderr: 'deliberate hook crash\n',
      exit_code: 2,
      outcome: 'error',
    })
    expect(parseStreamLine(line)).toMatchObject({ kind: 'hook_crashed', exitCode: 2 })
  })

  it('returns hook_failed_open for a PreToolUse hook_response that exits non-zero and not 2', () => {
    // Measured: exit 127 (path missing), 126 (not executable), 1 (script failed) all let the
    // tool run -- spike 2026-08-18 §6. Must NOT share a variant with hook_crashed.
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Write',
      hook_event: 'PreToolUse',
      output: '/bin/sh: line 1: /nope/hook.sh: No such file or directory\n',
      stderr: '/bin/sh: line 1: /nope/hook.sh: No such file or directory\n',
      exit_code: 127,
      outcome: 'error',
    })
    expect(parseStreamLine(line)).toMatchObject({ kind: 'hook_failed_open', exitCode: 127 })
  })

  it('returns hook_failed_open for a PreToolUse hook_response that exits exactly 1', () => {
    // The most confusable pair this parser has to keep apart: a PreToolUse
    // hook_response exiting 1 is a fail-open failure (spec §6), but the
    // routine Stop hook_response also reports exit_code: 1 on every healthy
    // run (next test). A mutation that widens the crash check from
    // `=== 2` to `=== 2 || === 1` passes every other fixture in this file --
    // 127 and 126 are still fail-open, Stop's exit 1 is still ignored
    // because hook_event scopes it out first -- and is caught only here.
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      output: 'deliberate hook failure exit 1\n',
      stderr: 'deliberate hook failure exit 1\n',
      exit_code: 1,
      outcome: 'error',
    })
    expect(parseStreamLine(line)).toMatchObject({ kind: 'hook_failed_open', exitCode: 1 })
  })

  it('ignores a Stop hook_response that exits 1 rather than classifying it', () => {
    // REGRESSION GUARD. Every healthy run ends with exactly this line -- all four captures,
    // spike 2026-08-18 §3.4. Classified by exit_code without checking hook_event it reads as
    // hook_failed_open, which under spec §13.1 cancels the run, fails it, and halts the
    // workspace. On every successful run.
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'Stop',
      hook_event: 'Stop',
      output: '',
      stderr: '',
      exit_code: 1,
      outcome: 'cancelled',
    })
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored', line })
  })

  // --- Coverage beyond the brief's fixtures ---
  //
  // `RuntimeEvent` declares `tool_call` and `text`, and Task 6/8's adapter tests (plan
  // §Task 6, §Task 8) rely on `parseStreamLine` producing `tool_call` from every stdout line,
  // including `assistant` lines -- the adapter maps *every* line through this function with
  // no upstream filter. The captures at ~/.aiteamos-m3-probe/ carry these shapes on every
  // real run, so leaving them unhandled would make the capture check misreport well-formed
  // assistant output as `unparsable`.

  it('reads a tool_use content block as a tool_call event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01RpRJ7bNVesaAwUAuf2UvxJ', name: 'Bash', input: { command: 'echo hi' } }],
      },
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'tool_call',
      toolUseId: 'toolu_01RpRJ7bNVesaAwUAuf2UvxJ',
      toolName: 'Bash',
      summary: 'Bash echo hi',
    })
  })

  // --- M4: a readable `summary`, derived from the tool_use block's `input` (spec §1) ---

  it('derives the summary from file_path for a Write tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_write1', name: 'Write', input: { file_path: '/abs/note3.txt', content: 'hi' } }],
      },
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'tool_call',
      toolUseId: 'toolu_write1',
      toolName: 'Write',
      summary: 'Write /abs/note3.txt',
    })
  })

  it('collapses whitespace in a multiline command and truncates it at 80 chars with an ellipsis', () => {
    const command = `ls -la\t\t\n\n${'x'.repeat(90)}`
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_bash_long', name: 'Bash', input: { command } }],
      },
    })
    const expectedArg = `ls -la ${'x'.repeat(73)}…`
    expect(expectedArg.length).toBe(81) // 80 chars of arg + the appended ellipsis
    expect(parseStreamLine(line)).toEqual({
      kind: 'tool_call',
      toolUseId: 'toolu_bash_long',
      toolName: 'Bash',
      summary: `Bash ${expectedArg}`,
    })
  })

  it('returns the bare tool name when a tool_use block carries no input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_no_input', name: 'TodoWrite' }] },
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'tool_call',
      toolUseId: 'toolu_no_input',
      toolName: 'TodoWrite',
      summary: 'TodoWrite',
    })
  })

  it('returns the bare tool name when the known argument keys hold only non-string values', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_bad_input', name: 'Read', input: { file_path: 42, path: null, command: ['echo'] } },
        ],
      },
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'tool_call',
      toolUseId: 'toolu_bad_input',
      toolName: 'Read',
      summary: 'Read',
    })
  })

  it('tolerates a malformed (non-object) input rather than treating the line as unparsable', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_malformed', name: 'Grep', input: 'not-an-object' }],
      },
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'tool_call',
      toolUseId: 'toolu_malformed',
      toolName: 'Grep',
      summary: 'Grep',
    })
  })

  it('reads a text content block as a text event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Bash is blocked by a crashing hook.' }] },
    })
    expect(parseStreamLine(line)).toEqual({ kind: 'text', text: 'Bash is blocked by a crashing hook.' })
  })

  it('ignores a thinking content block rather than treating it as unparsable', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
    })
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('prefers a tool_use block over a text block on the same line, rather than dropping the tool call', () => {
    // Unmeasured -- every real capture is one block per assistant line -- but Task 8 proves
    // its pause held by *counting* `tool_call` events after a deny. Falling to `ignored`
    // because the line also carried text would make a tool call that actually happened
    // invisible, and a broken pause would read as intact.
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Using Bash.' },
          { type: 'tool_use', id: 'toolu_multiblock1', name: 'Bash', input: { command: 'echo hi' } },
        ],
      },
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'tool_call',
      toolUseId: 'toolu_multiblock1',
      toolName: 'Bash',
      summary: 'Bash echo hi',
    })
  })

  it('ignores hook_started, hook_progress and thinking_tokens system lines', () => {
    // Recognized housekeeping lines the real CLI emits constantly; none carry a decision.
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse' }),
      JSON.stringify({ type: 'system', subtype: 'hook_progress', hook_name: 'PreToolUse:Bash', output: '{}\n' }),
      JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 }),
    ]
    for (const line of lines) {
      expect(parseStreamLine(line)).toEqual({ kind: 'ignored', line })
    }
  })

  it('ignores a tool_result line (type "user"), which carries no tool_use_id at the hook_response layer', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'hook error', is_error: true, tool_use_id: 'toolu_1' }],
      },
    })
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('ignores a rate_limit_event line', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('ignores a well-formed but unrecognized top-level type, rather than treating it as unparsable', () => {
    // The two dispatch levels must agree: an unrecognized `system.subtype` is already
    // `ignored` above. A future CLI adding a new top-level type is the same situation --
    // something this parser has no decision for -- not a defect.
    const line = JSON.stringify({ type: 'control_response', foo: 'bar' })
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored', line })
  })

  it('tolerates a missing stop_reason on a result line, defaulting it to null', () => {
    // Ruling: a failed run that produces no terminal event leaves the orchestrator waiting
    // on a process that is already gone. All four captures are `subtype: "success"`; an
    // omitted stop_reason is plausible on an error result the CLI never reached a natural
    // model stop for.
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      terminal_reason: 'max_turns_exceeded',
      num_turns: 40,
      total_cost_usd: 1.5,
      permission_denials: [],
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: true,
        terminalReason: 'max_turns_exceeded',
        stopReason: null,
        numTurns: 40,
        costUsd: 1.5,
        deniedToolUseIds: [],
        tokens: null,
      },
    })
  })

  it('defaults terminalReason from subtype when terminal_reason is absent', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 2,
      total_cost_usd: 0.01,
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: true,
        terminalReason: 'error_during_execution',
        stopReason: null,
        numTurns: 2,
        costUsd: 0.01,
        deniedToolUseIds: [],
        tokens: null,
      },
    })
  })

  it('still produces terminated for a result line carrying only subtype', () => {
    // A result line must always produce terminated -- the alternative is the orchestrator
    // waiting on a process that has already exited. is_error defaults to true (a run whose
    // success cannot be established is not a success); every defaulted field -- is_error
    // included -- is named in terminalReason rather than silently applied, since
    // total_cost_usd feeds the budget guardrail and is_error feeds the pump's
    // succeeded/failed split downstream -- and it is defaulted to `null`, not `0`, precisely
    // BECAUSE the guardrail believes it (M12 Task 9 / spec Decision 6).
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns' })
    expect(parseStreamLine(line)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: true,
        terminalReason: 'error_max_turns (degraded result line, missing: is_error, num_turns, total_cost_usd)',
        stopReason: null,
        numTurns: 0,
        // `null`, not `0` (M12 Task 9, controller ruling R5): a result line that never reported
        // `total_cost_usd` describes a run whose cost is UNKNOWN, and spec Decision 6 says
        // unknown cost is null because zero is a figure the budget guardrail believes. The
        // degradation is already named in `terminalReason` above, so nothing is lost by saying
        // so here too. `numTurns: 0` stays 0 deliberately -- a turn count the parser could not
        // read is not money, nothing sums it against a limit, and `RunOutcome.numTurns` is not
        // nullable.
        costUsd: null,
        deniedToolUseIds: [],
        tokens: null,
      },
    })
  })

  it('names is_error as defaulted when it alone is missing, rather than reading as a clean success', () => {
    // The pump (a later task) maps `terminated` onto run.succeeded/run.failed using isError,
    // with terminalReason as the reason. Without this, a result line missing only is_error
    // would default to isError: true with terminalReason left untouched -- a run.failed whose
    // own explanation reads like a normal completion, with nothing recording the default.
    const line = JSON.stringify({
      type: 'result',
      terminal_reason: 'completed',
      stop_reason: 'end_turn',
      num_turns: 4,
      total_cost_usd: 0.12,
    })
    expect(parseStreamLine(line)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: true,
        terminalReason: 'completed (degraded result line, missing: is_error)',
        stopReason: 'end_turn',
        numTurns: 4,
        costUsd: 0.12,
        deniedToolUseIds: [],
        tokens: null,
      },
    })
  })
})

describe('isPreToolUseHookResponseLine', () => {
  it('is true for a PreToolUse hook_response that allows (no deny payload, exit 0) -- the case parseStreamLine folds into "ignored"', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Write',
      hook_event: 'PreToolUse',
      output: '',
      exit_code: 0,
    })
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored', line })
    expect(isPreToolUseHookResponseLine(line)).toBe(true)
  })

  it('is true when hook_event is absent and only the hook_name prefix says PreToolUse', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'PreToolUse:Bash',
      output: '',
      exit_code: 0,
    })
    expect(isPreToolUseHookResponseLine(line)).toBe(true)
  })

  it('is false for a Stop hook_response, the routine line every fixture ends with', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'Stop',
      hook_event: 'Stop',
      output: '',
      exit_code: 1,
    })
    expect(isPreToolUseHookResponseLine(line)).toBe(false)
  })

  it('is false for a non-hook_response line, and for unparsable text', () => {
    expect(isPreToolUseHookResponseLine(JSON.stringify({ type: 'assistant' }))).toBe(false)
    expect(isPreToolUseHookResponseLine('not json')).toBe(false)
  })
})

describe('the Skill tool_use line (M14 §4.1, recorded)', () => {
  // The whole file, not a hand-picked line: a mapping written from a recording is only honest if
  // the test reads the recording. `test/fixtures/claude/README.md` carries the binary version, the
  // command, and the one redaction applied.
  const lines = readFileSync(new URL('./fixtures/claude/skill-tool-use.ndjson', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)

  it('recognizes every Skill invocation in the recording as a tool_call named Skill', () => {
    const skillCalls = lines
      .map((line) => parseStreamLine(line))
      .filter(
        (event): event is Extract<RuntimeEvent, { kind: 'tool_call' }> =>
          event.kind === 'tool_call' && event.toolName === 'Skill',
      )

    expect(skillCalls.length).toBeGreaterThan(0)
    for (const call of skillCalls) {
      // The summary carries the skill NAME, not the bare tool name -- `input.skill` is the only
      // argument a `Skill` tool_use has, and without it every skill call reads identically in the
      // action line and on the agent card's skill chip.
      expect(call.summary).toMatch(/^Skill \S/)
      expect(call.toolUseId).toMatch(/^toolu_/)
    }
  })

  it('summarizes the recorded call as exactly `Skill <name>`, the shape the agent card parses', () => {
    // Not merely "starts with Skill ": `apps/web/src/server/overview.ts`'s `skillNameOf` recovers
    // the chip's label with /^Skill\s+(\S+)/, so the exact string is the contract between this
    // parser and that card. The name is the fully-qualified `<plugin>:<name>` the CLI emitted.
    const summaries = lines
      .map((line) => parseStreamLine(line))
      .filter((event) => event.kind === 'tool_call' && event.toolName === 'Skill')
      .map((event) => (event as Extract<RuntimeEvent, { kind: 'tool_call' }>).summary)

    expect(summaries).toEqual(['Skill superpowers:writing-plans'])
  })

  it('reads the session id off the recording\'s own init line', () => {
    const started = lines.map((line) => parseStreamLine(line)).filter((event) => event.kind === 'session_started')
    expect(started).toEqual([{ kind: 'session_started', sessionId: '17b4a7b6-ed80-4fbb-bd84-90268e0d8b98' }])
  })

  it('never returns unparsable for any line of the recording', () => {
    const unparsable = lines.map((line) => parseStreamLine(line)).filter((event) => event.kind === 'unparsable')
    expect(unparsable).toEqual([])
  })
})

describe('result line token usage (M14 §4.2)', () => {
  it('reads usage.input_tokens and usage.output_tokens off a real result line', () => {
    const line = readFileSync(new URL('./fixtures/complete.ndjson', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.includes('"type":"result"'))
    const event = parseStreamLine(line as string)
    expect(event.kind).toBe('terminated')
    // BILLED input: input_tokens (4) + cache_creation_input_tokens (16_732) + cache_read_input_tokens
    // (46_948) = 63_684. Fix round 1 (controller ruling): input_tokens alone reads as a near-zero
    // 4 tokens beside this run's real $0.21 spend -- the README's Agents-table tokens column and the
    // Analytics mock's "1.4M" are only reachable by counting what the run was actually billed for,
    // and cache reads/writes ARE billed.
    expect((event as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toEqual({ input: 63_684, output: 741 })
  })

  it('is null, never zero, when the result line carries no usage at all', () => {
    const event = parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1 }),
    )
    expect((event as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toBeNull()
  })

  it('is null when usage is present but either half is missing -- half a measurement is none', () => {
    const event = parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1, usage: { input_tokens: 10 } }),
    )
    expect((event as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toBeNull()
  })

  it('folds both cache counters into input -- that is what the run was billed for', () => {
    const event = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.1,
        usage: { input_tokens: 4, output_tokens: 741, cache_creation_input_tokens: 16_732, cache_read_input_tokens: 46_948 },
      }),
    )
    expect((event as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toEqual({ input: 63_684, output: 741 })
  })

  it('treats an absent cache counter as 0 in the sum, not as a reason to null the whole figure', () => {
    const event = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.1,
        usage: { input_tokens: 4, output_tokens: 741, cache_read_input_tokens: 46_948 },
      }),
    )
    expect((event as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toEqual({ input: 46_952, output: 741 })
  })
})
