import type { PermissionKind } from '../permission/kinds.js'
import type { ProviderCapabilityManifest } from './manifest.js'
import type { ModelOption } from './models.js'

/**
 * The Claude Code CLI's `--model` accepts an alias for the latest model of a family
 * (`claude --help`: 'fable', 'opus', 'sonnet') or a full id. It lists nothing, so this table is
 * pinned by hand to the CLI version `ClaudeCodeAdapter` was last measured with and is updated with
 * the adapter. `default` is the CLI's own choice when no `--model` is passed.
 *
 * MOVED here from `packages/providers/src/models.ts:62-74` (M56a erratum E2), which re-exports it
 * under the same name and hands the SAME ARRAY back from `listClaudeCodeModels()` --
 * `packages/providers/test/models.test.ts:31` asserts that by identity. It lives here because a
 * `configured` provider's manifest holds its own model table and `packages/domain` cannot import
 * `packages/providers`; it also lands beside `guardrails/pricing.ts`, which prices six of these
 * eleven ids and whose own docstring already cites this table by name.
 */
export const CLAUDE_CODE_MODELS: readonly ModelOption[] = [
  { id: 'default', label: "default (the CLI's current default)", default: true },
  { id: 'fable', label: 'fable (latest Fable)' },
  { id: 'opus', label: 'opus (latest Opus)' },
  { id: 'sonnet', label: 'sonnet (latest Sonnet)' },
  { id: 'haiku', label: 'haiku (latest Haiku)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

/**
 * The FULL governed toolbox this provider offers, per operation (M52 R1/R2) -- MOVED here from
 * `packages/domain/src/permission/kinds.ts:111-163`'s `claude_code` column, value for value and
 * order for order, and that table now derives from this one (M56a R5).
 *
 * THE CLASSIFICATION RULE is `kinds.ts`'s and is unchanged: a tool that only INSPECTS is
 * `read_repo`; a tool that can DO work, or spawn work that can, is `run_commands`; every `mcp__*`
 * name is `network_fetch` through a PREFIX rule in `toolKindFor` rather than as forty-one literals.
 * `read_secret` and `deploy_release` name NOTHING on purpose -- they are BROKER grants.
 *
 * The values are pinned by a test that DERIVES them from this repository's own recording of the
 * real CLI (`packages/domain/test/permission/kinds.test.ts`, unchanged by this milestone and re-run
 * as the proof), so a recaptured fixture that gains a name is a red test rather than a silent wall.
 */
const CLAUDE_CODE_TOOLS: Readonly<Record<PermissionKind, readonly string[]>> = {
  read_repo: [
    'Read',
    'Glob',
    'Grep',
    'NotebookRead',
    'TodoWrite',
    'ToolSearch',
    'TaskOutput',
    'ListAgents',
    'Monitor',
    'LSP',
    'ListMcpResourcesTool',
    'ReadMcpResourceTool',
    'ReadMcpResourceDirTool',
  ],
  write_repo: ['Write', 'Edit', 'NotebookEdit'],
  // `BashOutput` and `KillShell` go with `Bash` and not with a fourth kind: they operate on a shell
  // this worker already started, so a grant that covered one and not the others would leave a run
  // able to start a command and unable to read it. Everything after `KillShell` is rule (b): it can
  // DO something, or start something that can, which is the same power and so the same grant.
  run_commands: [
    'Bash',
    'BashOutput',
    'KillShell',
    'Task',
    'TaskStop',
    'Skill',
    'Workflow',
    'SendMessage',
    'EnterWorktree',
    'ExitWorktree',
    'EnterPlanMode',
    'ExitPlanMode',
    'CronCreate',
    'CronDelete',
    'CronList',
    'ScheduleWakeup',
    'RemoteTrigger',
    'PushNotification',
    'ReportFindings',
    'DesignSync',
  ],
  network_fetch: ['WebFetch', 'WebSearch'],
  read_secret: [],
  deploy_release: [],
}

/**
 * Claude Code, measured (M56a R3).
 *
 * Every value below was read out of a file in this repository rather than out of a vendor's
 * documentation, and the file is named beside it. Nothing here is new: this row is where facts that
 * were already true went, not a claim anybody made for the first time while writing it.
 */
export const CLAUDE_CODE_MANIFEST: ProviderCapabilityManifest = {
  kind: 'claude_code',
  invocation: {
    binary: 'claude',
    binEnvVar: 'SLAVEOFAI_CLAUDE_BIN',
    argsEnvVar: 'SLAVEOFAI_CLAUDE_ARGS',
    // `packages/providers/src/claude/flags.ts:31-40`, the constant half in its own order. The
    // variable pair `--settings <absolute path>` sits between `bypassPermissions` and
    // `--include-hook-events` in the real argv, which is why the gate asserts a SUBSEQUENCE rather
    // than a prefix (plan erratum E12).
    headlessFlags: [
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--include-hook-events',
      // H9 F9: the person's own `~/.claude/settings.json` -- their plugins and user skills -- is
      // not loaded into a worker (`claude/flags.ts`).
      '--setting-sources',
      'project,local',
    ],
    promptDelivery: 'flag',
    // ADR 0001 §3: the first makes resume impossible, the second mints a new session id on resume.
    neverPass: ['--no-session-persistence', '--fork-session'],
    cwd: 'worktree',
    envAllowlist: 'CHILD_ENV_ALLOW',
  },
  // "The CLI lists nothing" -- there is no `claude models`, which is why `listClaudeCodeModels`
  // (`packages/providers/src/models.ts`) hands back this table instead of running one.
  modelDiscovery: { mode: 'configured', options: CLAUDE_CODE_MODELS },
  resume: { mode: 'session_id', flag: '--resume', neverPass: ['--fork-session'] },
  pause: {
    rung: 'hook',
    adr: 'docs/decisions/0001-pause-semantics.md#providercapabilities-for-the-claude-code-adapter-spec-7',
  },
  events: {
    transport: 'stream_json',
    // Every semantic kind there is: ten from `parseStreamLine` and `usage`, which the adapter
    // pushes from `parseStreamUsage` (`claude/adapter.ts`) rather than the line parser -- which is
    // why the gate's replay can only prove a subset and asserts the complement instead (plan
    // erratum E15).
    produces: [
      'session_started',
      'tool_call',
      'tool_result',
      'usage',
      'text',
      'hook_started',
      'hook_denied',
      'hook_crashed',
      'hook_failed_open',
      'permission_denied',
      'terminated',
    ],
  },
  structuredOutput: 'prompted',
  toolRestrictions: { mechanism: 'hook_gate', enforce: 'all-tools' },
  toolVocabulary: CLAUDE_CODE_TOOLS,
  usageCost: 'reported',
  hooks: ['pre_tool_use', 'post_tool_use'],
  runFiles: { channels: ['settings', 'hook'], persisted: ['settings', 'hook'] },
  // `packages/providers/src/runtime/process.ts:135-138`, the most recent dated measurement against
  // this binary in the tree (M52's `CHILD_ENV_ALLOW` run). The binary installed when M56a was
  // designed was `claude 2.1.270`, one patch ahead, and NOTHING was re-measured for this milestone
  // -- see `differences`.
  measured: { version: 'claude 2.1.269', date: '2026-09-12' },
  differences: [
    '`--settings` must be an ABSOLUTE path: a settings file the CLI cannot find never registers the PreToolUse hook, and there is no error anywhere in the event stream -- the run spawns cleanly, every tool call goes through, and the terminal result reports a clean success. `claudeFlags` refuses a relative path before a process exists.',
    'No `--allowedTools` is passed at all, so every one of the ~68 tools the `system`/`init` line advertises is live; the permission matrix restricts through the PreToolUse hook verdict, never through a CLI flag.',
    "Per-turn `usage` events are a documented FLOOR and not a total: a streamed message's per-turn usage is not what the turn was billed, and the terminal `result` line REPLACES both halves with the authoritative figures.",
    'The PostToolUse tap is an optional GAP FILLER: it never writes stdout, always exits 0, and the stream wins whenever both produce a result for the same tool call. A deployment without it runs exactly as it did before M51.',
    'Hook exit codes were measured, not assumed (M3 Task 1): allow is exit 0 with empty stdout, deny is exit 0 with a JSON body, exit 2 fails CLOSED, and exits 1/126/127 fail OPEN.',
    'The `default` model id is deliberately unpriced -- the CLI’s current choice is not knowable from inside this repository -- so a run on `default` reports the cost the CLI reports and can never be estimated.',
    '`CHILD_ENV_ALLOW` was measured against `claude 2.1.269` and the binary installed at M56a was `2.1.270`. One patch of drift on a twelve-name allowlist, re-measured by the next milestone that changes the list rather than by one that does not touch it.',
  ],
}
