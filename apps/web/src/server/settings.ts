import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PERMISSION_TOOLS, capabilitiesOf, type ProviderKind } from '@ai-team-os/control'
import { prisma } from '@ai-team-os/db/client'

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
 * Honours the same `AITEAMOS_*_BIN` overrides `apps/orchestrator/src/cli.ts` does, so a fake-CLI
 * gate run sees the fakes rather than whatever happens to be installed on the gate machine.
 */
async function versionOf(bin: string): Promise<string | null> {
  const override = bin === 'claude' ? process.env['AITEAMOS_CLAUDE_BIN'] : process.env['AITEAMOS_CURSOR_BIN']
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

export async function buildProviderAdapters(): Promise<readonly AdapterCard[]> {
  const bound = await prisma.agentRun.groupBy({ by: ['provider'], _count: { _all: true } })
  const countFor = (kind: string): number => bound.find((row) => row.provider === kind)?._count._all ?? 0

  const real = await Promise.all(
    REAL.map(async (adapter): Promise<AdapterCard> => {
      const version = await versionOf(adapter.bin)
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

export async function buildPermissionMatrix(): Promise<readonly PermissionRow[]> {
  const [agents, permissions] = await Promise.all([
    prisma.agent.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, role: true } }),
    prisma.agentPermission.findMany(),
  ])
  const byAgent = new Map<string, Map<string, 'allow' | 'deny'>>()
  for (const row of permissions) {
    const map = byAgent.get(row.agentId) ?? new Map<string, 'allow' | 'deny'>()
    map.set(row.tool, row.mode)
    byAgent.set(row.agentId, map)
  }

  return agents.map((agent) => ({
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    // `null` is UNSET, and the cell says so: an agent nobody has decided about is not the same as
    // one explicitly denied, and collapsing them would make the matrix claim a decision that was
    // never taken.
    cells: PERMISSION_TOOLS.map((tool) => ({ tool, mode: byAgent.get(agent.id)?.get(tool) ?? null })),
  }))
}

/**
 * The one workspace the global Settings page's emergency stop may target, or `null`.
 *
 * Settings is a GLOBAL route -- it has no `workspaceId` in scope -- and an emergency stop halts a
 * named project, not "whichever one was first". So it is offered only when the choice is
 * unambiguous: exactly one workspace exists. With two or more, the danger zone says the stop
 * lives on the project's own top bar rather than picking a victim for the operator.
 */
export async function buildDangerZoneTarget(): Promise<{ readonly workspaceId: string; readonly halted: boolean } | null> {
  const workspaces = await prisma.workspace.findMany({ select: { id: true, haltedReason: true }, take: 2 })
  const only = workspaces.length === 1 ? workspaces[0] : undefined
  if (only === undefined) return null
  return { workspaceId: only.id, halted: only.haltedReason !== null }
}
