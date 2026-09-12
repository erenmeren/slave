/**
 * What a worker may DO, as data (M52 R1).
 *
 * A PERMISSION is an OPERATION and never a capability. M47's `Capability` says what a worker is
 * FOR -- the taxonomy key a task requires and a worker provides; this list says what ANY worker may
 * do, whatever it is for. The UI prints "Permissions" and "Capabilities" as two words for two
 * things and never one for both, and nothing here reads `Slave.capabilities`.
 *
 * Until this milestone the list was six PROSE ROWS -- `repo read`, `source write`, `run tests`,
 * `create branch`, `deploy prod`, `read secrets` (`packages/control/src/permission.ts:18-26`) --
 * of which three collapsed onto `Bash` (so denying `deploy prod` denied the whole shell) and one
 * (`read secrets`) mapped to no tool at all and enforced nothing. The six below are the same six
 * ideas with the collisions removed: one operation per row, and the two that name no vendor tool
 * name none because they are BROKER grants (R3) rather than tool grants -- which is exactly why
 * `deploy prod` could never be expressed as a tool deny in the first place.
 *
 * The order is the order a person grants them in: read, then write, then run, then reach the
 * network, and last the two that hand over something the worker never holds itself.
 */
export const PERMISSION_KINDS = [
  'read_repo',
  'write_repo',
  'run_commands',
  'network_fetch',
  /** A BROKER grant, not a tool grant: it names no vendor tool on either provider, and what it
   *  permits is `runBrokeredOperation` reading `process.env[Credential.envVar]` on the worker's
   *  behalf -- in the orchestrator's process, never in the worker's. */
  'read_secret',
  /** The second broker grant, and the one this milestone proves end to end. */
  'deploy_release',
] as const

export type PermissionKind = (typeof PERMISSION_KINDS)[number]

/** The two providers a permission resolves against. The same two members `packages/db`'s
 *  `ProviderKind` enum carries, spelled here because `packages/domain` may not depend on
 *  `@slave-of-ai/providers` (which imports `node:child_process` at module scope) -- and
 *  `packages/db`'s enum is held to this list by `packages/db/test/integration/enum-parity.test.ts`
 *  rather than by a type. */
export const PERMISSION_PROVIDERS = ['claude_code', 'cursor'] as const
export type PermissionProvider = (typeof PERMISSION_PROVIDERS)[number]

/**
 * The three run kinds a baseline is keyed on -- `RunKind`'s members, spelled here for
 * {@link PERMISSION_PROVIDERS}' reason and pinned against the Postgres enum by
 * `packages/db/test/integration/enum-parity.test.ts` (M52 fix round 1, review m6).
 *
 * The pin is not decorative. {@link BASELINE_GRANTS} is a total `Record` over this union, and a
 * fourth `RunKind` member that reached Prisma and not this list would make `BASELINE_GRANTS[runKind]`
 * `undefined`, `new Set(undefined)` empty, and every run of that kind silently deny-all -- a whole
 * class of run unable to read its own repository, with nothing in TypeScript to say so.
 */
export const PERMISSION_RUN_KINDS = ['implementation', 'review', 'planning'] as const
export type PermissionRunKind = (typeof PERMISSION_RUN_KINDS)[number]

/**
 * What each operation is CALLED when a person reads it (`docs/ia.md` rule 3).
 *
 * `Record<PermissionKind, string>` is load-bearing: a seventh kind fails the build here rather than
 * turning up on the Settings matrix as an identifier. Every label is what the operation IS, in the
 * words the matrix column header uses -- the raw key stays in `title` and on `data-kind`.
 */
export const PERMISSION_LABEL: Record<PermissionKind, string> = {
  read_repo: 'Read the repository',
  write_repo: 'Write source',
  run_commands: 'Run commands',
  network_fetch: 'Fetch over the network',
  read_secret: 'Read a secret',
  deploy_release: 'Deploy a release',
}

/**
 * The FULL governed toolbox per operation per provider -- the inverted `CAPABILITY_TOOLS`.
 *
 * The old table listed only what a deny should BLOCK, which is a denylist: it closed instances.
 * This one lists everything an operation covers, which is an allowlist: it closes the class. A tool
 * that appears in no row here and matches no rule in {@link toolKindFor} is governed by nothing, and
 * from Task 2 a tool governed by nothing is DENIED on `claude_code` -- so this table is the thing
 * that decides whether a working run keeps working.
 *
 * **THE CLASSIFICATION RULE** (M52 fix round 1, the C1 ruling; erratum candidate E16). The first
 * cut of this table held fifteen Claude names. This repository's own recording
 * (`packages/providers/test/fixtures/complete.ndjson`'s `system`/`init` line) advertises SIXTY-EIGHT,
 * and `claudeFlags` passes no `--allowedTools`, so every one of them is live. Eighteen non-MCP names
 * and all forty-one `mcp__*` names were governed by nothing, and Task 2's inversion would have
 * denied every one of them -- `TaskOutput` included, without which a `Task` call cannot be read
 * back. Three rules settle it, and every name in the toolbox falls under exactly one:
 *
 *   (a) **A tool that only INSPECTS is `read_repo`.** It answers a question and changes nothing:
 *       `ToolSearch`, `TaskOutput`, `ListAgents`, `Monitor`, `LSP` and the three MCP-resource
 *       readers, beside `Read`/`Glob`/`Grep`/`NotebookRead`/`TodoWrite`.
 *   (b) **A tool that can DO work, or spawn work that can, is `run_commands`.** It is the same power
 *       `Bash` is and it gets the same grant: `Task` and `Skill` (a subagent has a shell; a skill is
 *       instructions about what to run) -- both MOVED out of `read_repo`, where the first cut put
 *       them -- plus `Workflow`, `SendMessage`, `TaskStop`, the `Cron*` family, `ScheduleWakeup`,
 *       `RemoteTrigger`, `PushNotification`, `ReportFindings`, `DesignSync`, and the worktree and
 *       plan-mode transitions. The `Cron*` family travels together for `BashOutput`/`KillShell`'s
 *       reason: a grant that let a worker CREATE a schedule and not list it would leave it able to
 *       start something it cannot see.
 *   (c) **Every `mcp__*` name is `network_fetch`.** An MCP server is an external integration, which
 *       is what that kind means; it is denied by default and ONE grant enables the lot. Implemented
 *       as a PREFIX rule in {@link toolKindFor}, never as forty-one literals here, so a server an
 *       operator installs tomorrow is governed without a table edit.
 *
 * The rule is pinned by a test that DERIVES the toolbox from the fixture
 * (`test/permission/kinds.test.ts`), so a recording that gains a name is a red test rather than a
 * silent wall -- which is the safety property R1 states and the hand-typed first cut did not have.
 *
 * `read_secret` and `deploy_release` name NOTHING on purpose (see their members above).
 */
export const TOOLS_BY_KIND: Record<PermissionKind, Record<PermissionProvider, readonly string[]>> = {
  read_repo: {
    claude_code: [
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
    cursor: ['read'],
  },
  write_repo: { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
  // `BashOutput` and `KillShell` go with `Bash` and not with a fourth kind: they operate on a shell
  // this worker already started, so a grant that covered one and not the others would leave a run
  // able to start a command and unable to read it. Everything after `KillShell` is rule (b): it can
  // DO something, or start something that can, which is the same power and so the same grant.
  run_commands: {
    claude_code: [
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
    cursor: ['shell'],
  },
  network_fetch: { claude_code: ['WebFetch', 'WebSearch'], cursor: [] },
  read_secret: { claude_code: [], cursor: [] },
  deploy_release: { claude_code: [], cursor: [] },
}

/**
 * Every governed tool name to the kind that governs it, DERIVED from {@link TOOLS_BY_KIND} rather
 * than written twice.
 *
 * Two jobs, both needed by the gate: it is the membership test that tells a governed-but-ungranted
 * tool (deny, naming its kind) from an ungoverned one (deny as `ungoverned_tool` on `claude_code`,
 * allow on `cursor` -- plan erratum E3), and it is what lets the shell NAME the kind of a tool that
 * is not on the allow list, which an allow list alone cannot do.
 *
 * Built once at module load. A duplicate tool name across two kinds would silently lose one of them
 * here; `kinds.test.ts` asserts there is none.
 */
export const TOOL_VOCABULARY: Record<PermissionProvider, Readonly<Record<string, PermissionKind>>> =
  Object.fromEntries(
    PERMISSION_PROVIDERS.map((provider) => [
      provider,
      Object.fromEntries(
        PERMISSION_KINDS.flatMap((kind) => TOOLS_BY_KIND[kind][provider].map((tool) => [tool, kind] as const)),
      ),
    ]),
  ) as Record<PermissionProvider, Readonly<Record<string, PermissionKind>>>

/**
 * The prefix every MCP tool name carries, on every provider that speaks the protocol.
 *
 * A convention of MCP itself rather than of a vendor (`mcp__<server>__<tool>`), which is why
 * {@link toolKindFor} applies rule (c) on both providers rather than only on `claude_code`.
 */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * THE lookup: which operation governs this tool name, or `null` when nothing does.
 *
 * {@link TOOL_VOCABULARY} answers for the names a table can enumerate; this function answers for
 * all of them, because {@link TOOLS_BY_KIND}'s rule (c) is a PREFIX and a prefix cannot be a table
 * key. Every caller that has to classify a tool name -- the gate, the card, the shell's verdict --
 * asks this rather than indexing the map, so a server an operator installs tomorrow is governed
 * without anybody editing a list.
 *
 * `null` is the `ungoverned_tool` REASON and never a kind: no row can grant it, the matrix has no
 * column for it, and under `ENFORCE_BY_PROVIDER`'s `all-tools` it is a deny.
 */
export function toolKindFor(provider: PermissionProvider, tool: string): PermissionKind | null {
  const known = TOOL_VOCABULARY[provider][tool]
  if (known !== undefined) return known
  if (tool.startsWith(MCP_TOOL_PREFIX)) return 'network_fetch'
  return null
}

/**
 * What a run of each kind may do before anybody has decided anything (M52 R2).
 *
 * COMPUTED, never stored. The direction was to seed these as rows in the migration, keyed on the
 * worker's runtime role; two facts refuse that. `Slave.runtimeRoles` is free text capped at twenty
 * entries (`packages/control/src/profile.ts:31`) and cannot key a constant, while `RunKind` is a
 * closed enum the four resolution sites already differ on. And six seeded rows per worker is a new
 * unique index colliding with fixtures in five web integration test files. Computing it gives
 * "nothing that works today stops working" by construction, keeps the migration to one data
 * statement, and makes a permission's SOURCE a projection (`grantsFor`) rather than a column.
 *
 * A planning run reads and nothing else: it writes a task graph, not source. A review run reads and
 * runs commands: it has to be able to run the tests it is judging. An implementation run gets all
 * three, which is what every implementation run has always had.
 */
export const BASELINE_GRANTS: Record<PermissionRunKind, readonly PermissionKind[]> = {
  implementation: ['read_repo', 'write_repo', 'run_commands'],
  review: ['read_repo', 'run_commands'],
  planning: ['read_repo'],
}

/**
 * How much of the matrix each provider's gate can actually ENFORCE (plan erratum E3).
 *
 * Not `ProviderCapabilities.gate`, which answers a different question: Cursor's is `'all-tools'`
 * and PROVEN so for the PAUSE path (`packages/providers/src/capabilities.ts:87-98`), because a
 * pause denies without reading a tool name at all. The permission path does read one, and Cursor's
 * `preToolUse` sends Claude-shaped casing (`"Read"`/`"Shell"`/`"Write"`) that never matches this
 * file's lowercase Cursor vocabulary (measured, `scripts/lib/permissions.sh:30-36`). Under the old
 * denylist that mismatch was inert. Under an allow list it would deny EVERY Cursor tool call, so
 * the gate is told, in the file it reads, to enforce only the names it can trust: `shell`, which
 * arrives through `beforeShellExecution`'s `default_tool` accommodation and is the one Cursor path
 * that has ever been enforceable. Stated in the matrix copy, not left implicit.
 */
export const ENFORCE_BY_PROVIDER: Record<PermissionProvider, 'all-tools' | 'known-tools'> = {
  claude_code: 'all-tools',
  cursor: 'known-tools',
}

/**
 * What a `run.tool_denied` card prints (`docs/ia.md` rule 3, plan erratum E2).
 *
 * The payload's `capability` field carries a `PermissionKind` -- or the literal `ungoverned_tool`,
 * which is a REASON and not a kind: no row can grant it, the matrix has no column for it, and a
 * seventh `PERMISSION_KINDS` member would be a grant nobody asked for. It gets a word here because
 * a person meets it on the activity feed exactly as they meet the six.
 */
export const TOOL_DENIED_LABEL: Record<PermissionKind | 'ungoverned_tool', string> = {
  ...PERMISSION_LABEL,
  ungoverned_tool: 'A tool nobody governs',
}
