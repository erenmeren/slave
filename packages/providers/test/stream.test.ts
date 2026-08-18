import { describe, expect, it } from 'vitest'
import { parseStreamLine } from '../src/claude/stream.js'

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
    expect(parseStreamLine(line)).toEqual({ kind: 'tool_call', toolUseId: 'toolu_multiblock1', toolName: 'Bash' })
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
      },
    })
  })

  it('still produces terminated for a result line carrying only subtype', () => {
    // A result line must always produce terminated -- the alternative is the orchestrator
    // waiting on a process that has already exited. is_error defaults to true (a run whose
    // success cannot be established is not a success); every defaulted field -- is_error
    // included -- is named in terminalReason rather than silently applied, since
    // total_cost_usd feeds the budget guardrail and is_error feeds the pump's
    // succeeded/failed split downstream.
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns' })
    expect(parseStreamLine(line)).toEqual({
      kind: 'terminated',
      outcome: {
        isError: true,
        terminalReason: 'error_max_turns (degraded result line, missing: is_error, num_turns, total_cost_usd)',
        stopReason: null,
        numTurns: 0,
        costUsd: 0,
        deniedToolUseIds: [],
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
      },
    })
  })
})
