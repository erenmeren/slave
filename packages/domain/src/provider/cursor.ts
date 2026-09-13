import type { PermissionKind } from '../permission/kinds.js'
import type { ProviderCapabilityManifest } from './manifest.js'

/**
 * Cursor's governed toolbox -- exactly three lowercase names, MOVED from
 * `packages/domain/src/permission/kinds.ts:111-163`'s `cursor` column (M56a R5).
 *
 * Three, and not a shortened Claude list: these are the names Cursor's own payloads carry, and
 * `ENFORCE_BY_PROVIDER`'s `'known-tools'` (now `toolRestrictions.enforce`) is the measured reason
 * the gate may only enforce the ones it can match.
 */
const CURSOR_TOOLS: Readonly<Record<PermissionKind, readonly string[]>> = {
  read_repo: ['read'],
  write_repo: ['edit'],
  run_commands: ['shell'],
  network_fetch: [],
  read_secret: [],
  deploy_release: [],
}

/**
 * Cursor, measured (M56a R3) -- and measured is the operative word: every value below was proved
 * against the installed binary in M12 Task 11 and M13 Task 9, and two of the claims the M12 spec
 * originally made were overturned by that proof rather than confirmed by it.
 */
export const CURSOR_MANIFEST: ProviderCapabilityManifest = {
  kind: 'cursor',
  invocation: {
    binary: 'cursor-agent',
    binEnvVar: 'SLAVEOFAI_CURSOR_BIN',
    argsEnvVar: 'SLAVEOFAI_CURSOR_ARGS',
    // `packages/providers/src/cursor/flags.ts:73`, the constant half, in order.
    headlessFlags: ['--print', '--output-format', 'stream-json', '--trust', '--force'],
    promptDelivery: 'positional',
    // `cursor/flags.ts:35-54`. Each one is a flag `cursor-agent` really has, each was tested
    // separately, and each looks safe.
    neverPass: ['-w', '--worktree', '--stream-partial-output', '--yolo', '--plan', '--mode'],
    cwd: 'worktree',
    envAllowlist: 'CHILD_ENV_ALLOW',
  },
  // The only provider whose model list is read from the live account rather than hand-pinned
  // (`listCursorModels` in `packages/providers/src/models.ts`: `<binary> models`, 10 s, never
  // throws).
  modelDiscovery: { mode: 'listed', argv: ['models'] },
  resume: { mode: 'session_id', flag: '--resume', neverPass: ['--continue'] },
  pause: {
    rung: 'signal',
    adr: 'docs/decisions/0001-pause-semantics.md#degradation-path-if-a-provider-lacks-hooks-spec-7',
  },
  events: {
    transport: 'stream_json',
    // Six. No `usage` -- the stream carries none, and the `result` line's own usage is the only
    // figure there is -- and none of the four `hook_*` variants, because `classifyGateEvent` is
    // never invoked for this runtime by design.
    produces: ['session_started', 'tool_call', 'tool_result', 'text', 'permission_denied', 'terminated'],
  },
  structuredOutput: 'prompted',
  toolRestrictions: { mechanism: 'hook_gate', enforce: 'known-tools' },
  toolVocabulary: CURSOR_TOOLS,
  usageCost: 'unmeasured',
  hooks: ['pre_tool_use', 'before_shell_execution'],
  // `.cursor/hooks.json` in the WORKTREE and the gate script -- two files that are neither a
  // settings file nor a hook, reported under the pair's names because the Postgres columns are
  // those two (`cursor/adapter.ts:196`).
  runFiles: { channels: ['settings', 'hook'], persisted: ['settings', 'hook'] },
  // `packages/providers/src/capabilities.ts:113-115` and `cursor/hooks.ts:65-67` both record this
  // version, and the binary self-updates between runs.
  measured: { version: 'cursor-agent 2026.08.25-3e8eec8', date: '2026-08-29' },
  differences: [
    "`--trust`'s absence is INVISIBLE: in a directory the user has not already trusted, `cursor-agent` exits 1 with a completely empty stdout -- no `system`/`init` line, no `result` line -- and prints “Workspace Trust Required” to stderr only. Every fresh worktree this system creates is exactly such a directory.",
    "`--force` is this vendor's `bypassPermissions`, and its help text's trailing clause -- “unless explicitly denied” -- is load-bearing: it is what keeps the gate's own deny effective under it.",
    '`--resume [chatId]` takes an OPTIONAL argument, so a bare `--resume` swallows the positional prompt as a chat id and leaves the run with no prompt at all. `cursorFlags` structurally cannot emit one: the flag and its id are pushed in the same statement.',
    'The `preToolUse` registration carries NO matcher, and that is measured rather than cautious: this vendor’s edit tool reads its target before writing it, and both steps are gated under the edit call’s own id, so a write was stopped at a `preToolUse` invocation whose `tool_name` was `"Read"`. A matcher scoped to `^(Write|Shell)$` would have let that write through.',
    '`numTurns` has no equivalent in this stream at all: the adapter DERIVES it by counting `assistant` lines while consuming, and overwrites the parser’s `0` before the event leaves `events()`. The parser’s zero must never reach an operator as a figure this vendor reported.',
    '`deniedToolUseIds` is populated from `tool_call`/`completed` lines whose `result.rejected` is set, and NEVER from `result.error`: an ordinary tool error is indistinguishable from a fail-closed gate block, so a fail-closed stop is silently not counted there, though its text still reaches the operator on the terminal line.',
    'The stream does not end at readline close. A real run left a detached worker-server family holding a DUP of this binary’s own stdout write end, so the pipe never closed even after the process itself exited; the adapter ends on the child’s `exit` event plus a 300 ms quiesce window re-armed per chunk.',
    'A run that wrote NOTHING to stdout is diagnosed as the workspace-trust refusal, with the captured stderr included verbatim rather than guessed -- and deliberately not synthesised for a cancelled or signalled run, which is an ordinary reason to write nothing.',
    'The `preToolUse` payload arrives with Claude-shaped casing (`"Read"`/`"Shell"`/`"Write"`) that never matches this vendor’s own lowercase vocabulary, so the gate is told to enforce only the names it can trust (`toolRestrictions.enforce: known-tools`). Under an allow list, matching them naively would deny every call this runtime makes.',
    'It reports no cost at all: the `result` line carries no cost figure, no model in this table is priced, and `estimateCostUsd` therefore answers `null` rather than `0`. This is why an llm-decision simulation refuses this provider -- "it reports no cost, so a cap cannot be enforced" -- which is a BUDGET refusal and not a statement about its output shape.',
    'Only a shell call and an edit call were ever exercised: no MCP call and no subagent call has been measured on this runtime.',
  ],
}
