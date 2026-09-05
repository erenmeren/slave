import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PERMISSION_TOOLS, capabilitiesOf, type ProviderKind } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'

const run = promisify(execFile)

export interface AdapterCard {
  readonly kind: string
  readonly label: string
  /** `'connected'` when the binary is on PATH, `'not found'` when it is not, `'later'` for an
   *  adapter this codebase does not have. */
  readonly state: 'connected' | 'not found' | 'later'
  /** The binary's own `--version` output, `null` when it could not be run. */
  readonly version: string | null
  readonly adapter: string
  /** `capabilitiesOf(kind)` flattened for display; `null` for a `later` card. */
  readonly capabilities: {
    readonly gate: string
    readonly reportsCost: boolean
    readonly canPauseMidRun: boolean
  } | null
  readonly agentsBound: number
}

/**
 * The two REAL adapters and the two the handoff draws but this codebase does not have. The second
 * pair is rendered disabled and captioned `not configured · later` (M14 Decision 7) -- a card that
 * looks functional and is not is the exact lie this milestone is about.
 */
const REAL: ReadonlyArray<{ kind: ProviderKind; label: string; bin: string; adapter: string }> = [
  { kind: 'claude_code', label: 'Claude Code', bin: 'claude', adapter: 'ClaudeCodeAdapter' },
  { kind: 'cursor', label: 'Cursor', bin: 'cursor-agent', adapter: 'CursorAdapter' },
]

const LATER: ReadonlyArray<{ kind: string; label: string; adapter: string }> = [
  { kind: 'codex', label: 'OpenAI Codex', adapter: 'CodexAdapter — planned' },
  { kind: 'gemini', label: 'Gemini', adapter: 'GeminiAdapter — planned' },
]

/**
 * The binary's own `--version`, or `null` when it is not on PATH. Bounded, because a hung binary
 * must not hang the Settings page, and it never throws into the page: a missing binary is a fact
 * to render, not a 500.
 *
 * Honours the same `SLAVEOFAI_*_BIN` overrides `apps/orchestrator/src/cli.ts` does, so a fake-CLI
 * gate run sees the fakes rather than whatever happens to be installed on the gate machine.
 */
export async function versionOf(bin: string): Promise<string | null> {
  const override = bin === 'claude' ? process.env['SLAVEOFAI_CLAUDE_BIN'] : process.env['SLAVEOFAI_CURSOR_BIN']
  try {
    const { stdout } = await run(override !== undefined && override !== '' ? override : bin, ['--version'], {
      timeout: 10_000,
    })
    const first = stdout.trim().split('\n')[0]
    return first === undefined || first === '' ? null : first
  } catch {
    return null
  }
}

/**
 * @param resolveVersion how to ask a binary its version. Defaults to `versionOf`, i.e. the real
 * PATH probe. Injected only by `settings-snapshot.test.ts`, which must map `connected` and
 * `not found` without probing a real binary: `cursor-agent` self-updates, so no test may assert
 * against a version string it did not itself supply.
 */
export async function buildProviderAdapters(
  resolveVersion: (bin: string) => Promise<string | null> = versionOf,
): Promise<readonly AdapterCard[]> {
  const bound = await prisma.agentRun.groupBy({ by: ['provider'], _count: { _all: true } })
  const countFor = (kind: string): number => bound.find((row) => row.provider === kind)?._count._all ?? 0

  const real = await Promise.all(
    REAL.map(async (adapter): Promise<AdapterCard> => {
      const version = await resolveVersion(adapter.bin)
      const capabilities = capabilitiesOf(adapter.kind)
      return {
        kind: adapter.kind,
        label: adapter.label,
        // Connect state IS "the binary is on PATH" -- nothing else is checkable without spending
        // money, and a green dot that means "we assume so" is worthless.
        state: version === null ? 'not found' : 'connected',
        version,
        adapter: adapter.adapter,
        capabilities: {
          gate: capabilities.gate,
          reportsCost: capabilities.reportsCost,
          canPauseMidRun: capabilities.canPauseMidRun,
        },
        agentsBound: countFor(adapter.kind),
      }
    }),
  )

  return [
    ...real,
    ...LATER.map(
      (adapter): AdapterCard => ({
        kind: adapter.kind,
        label: adapter.label,
        state: 'later',
        version: null,
        adapter: adapter.adapter,
        capabilities: null,
        agentsBound: 0,
      }),
    ),
  ]
}

export interface PermissionRow {
  readonly agentId: string
  readonly name: string
  readonly role: string
  /** One entry per `PERMISSION_TOOLS` member, in that order. `mode` is `null` when no
   *  `AgentPermission` row exists -- unset, which the matrix shows as `✕` and an operator can
   *  change; it is NOT the same as an explicit deny, and the cell says which it is. */
  readonly cells: readonly { readonly tool: string; readonly mode: 'allow' | 'deny' | null }[]
}

/**
 * One workspace's slice of the matrix (fix round 1, finding 2).
 *
 * The matrix used to be a flat list of EVERY `Agent` row in the database. Two projects
 * materialized from the same roster then produced indistinguishable duplicate rows -- "Alex ·
 * backend" twice, with nothing on either to say which project it governed -- and the query was
 * unbounded besides. Grouping by workspace makes the row's owner part of the structure rather
 * than something a reader has to infer, and bounds each grid to one project's roster.
 */
export interface PermissionSection {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly rows: readonly PermissionRow[]
}

/**
 * @param workspaceId Scopes the workspace query to that one row (M24 §4: the project Settings
 * tab's own permission matrix) -- an empty array, not an error, when it names no workspace.
 * Omitted, the original org-wide Settings behaviour: every workspace, in name order.
 */
export async function buildPermissionMatrix(workspaceId?: string): Promise<readonly PermissionSection[]> {
  // TWO queries regardless of how many workspaces exist -- the agents ride in on the workspace
  // query's `include`, and the permissions come back in one sweep keyed by agent. No per-workspace
  // and no per-agent round trip. `AgentPermission` carries no `workspaceId` of its own (it is keyed
  // by `agentId` only), so scoping the workspace query is enough: the map below only ever gets
  // consulted for the agents `workspaces` actually returned, and a permission row for some other
  // project's agent is fetched but never looked up.
  const [workspaces, permissions] = await Promise.all([
    prisma.workspace.findMany({
      // `{}` rather than an omitted key -- `exactOptionalPropertyTypes` refuses a `where` typed
      // to allow `undefined` explicitly, and an empty filter matches every row exactly as
      // omitting `where` would.
      where: workspaceId === undefined ? {} : { id: workspaceId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        teams: { select: { agents: { select: { id: true, name: true, role: true } } } },
      },
    }),
    prisma.agentPermission.findMany(),
  ])

  const byAgent = new Map<string, Map<string, 'allow' | 'deny'>>()
  for (const row of permissions) {
    const map = byAgent.get(row.agentId) ?? new Map<string, 'allow' | 'deny'>()
    map.set(row.tool, row.mode)
    byAgent.set(row.agentId, map)
  }

  return workspaces.map((workspace) => ({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    // Flattened then sorted, NOT ordered inside the `include`: a Prisma `orderBy` there sorts
    // within each team, so a two-team workspace would come back as two separately-sorted runs
    // concatenated rather than one roster in name order.
    rows: workspace.teams
      .flatMap((team) => team.agents)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => ({
        agentId: agent.id,
        name: agent.name,
        role: agent.role,
        // `null` is UNSET, and the cell says so: an agent nobody has decided about is not the
        // same as one explicitly denied, and collapsing them would make the matrix claim a
        // decision that was never taken.
        cells: PERMISSION_TOOLS.map((tool) => ({ tool, mode: byAgent.get(agent.id)?.get(tool) ?? null })),
      })),
  }))
}
