import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildPermissionMatrix, buildProviderAdapters } from '../../src/server/settings.js'

/**
 * Direct coverage for the Settings DTO builders (fix round 1, finding 3) — the house pattern
 * `server-org.test.ts` sets for a web server module.
 *
 * `buildProviderAdapters` takes its version resolver as an argument precisely so this file can
 * exercise the `connected` / `not found` mapping without probing a real binary: `cursor-agent`
 * self-updates, so no test may assert a version string it did not itself supply.
 */
async function seedWorkspace(name: string): Promise<{ workspaceId: string; teamId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name, repoPath: `/tmp/settings-${name}`, verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  return { workspaceId: workspace.id, teamId: team.id }
}

describe('the Settings query module', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "SlavePermission", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  describe('buildProviderAdapters', () => {
    it('calls a resolved binary connected and an unresolvable one not found', async (): Promise<void> => {
      const adapters = await buildProviderAdapters(async (bin) => (bin === 'claude' ? '2.1.234' : null))

      const claude = adapters.find((a) => a.kind === 'claude_code')
      expect(claude?.state).toBe('connected')
      expect(claude?.version).toBe('2.1.234')

      // Not found, and it says so — it does not borrow the connected card's calm.
      const cursor = adapters.find((a) => a.kind === 'cursor')
      expect(cursor?.state).toBe('not found')
      expect(cursor?.version).toBeNull()
    })

    it('carries the real capabilitiesOf table for each real adapter', async (): Promise<void> => {
      const adapters = await buildProviderAdapters(async () => '1.0.0')

      // `capabilitiesOf`'s measured rows, not a copy: Claude Code reports cost and pauses
      // mid-run, Cursor does neither.
      expect(adapters.find((a) => a.kind === 'claude_code')?.capabilities).toEqual({
        gate: 'all-tools',
        reportsCost: true,
        canPauseMidRun: true,
      })
      expect(adapters.find((a) => a.kind === 'cursor')?.capabilities).toEqual({
        gate: 'all-tools',
        reportsCost: false,
        canPauseMidRun: false,
      })
    })

    it('gives the two later adapters no version and no capabilities to show', async (): Promise<void> => {
      // The resolver would answer for ANY binary; the later cards must still describe nothing,
      // because there is no adapter behind them to describe (Decision 7).
      const adapters = await buildProviderAdapters(async () => '9.9.9')

      for (const kind of ['codex', 'gemini']) {
        const card = adapters.find((a) => a.kind === kind)
        expect(card?.state).toBe('later')
        expect(card?.version).toBeNull()
        expect(card?.capabilities).toBeNull()
        expect(card?.slavesBound).toBe(0)
      }
    })

    it('counts the runs bound to each real adapter', async (): Promise<void> => {
      const { teamId } = await seedWorkspace('Checkout Platform')
      const slave = await prisma.slave.create({ data: { teamId, name: 'Alex', role: 'backend' } })
      await prisma.slaveRun.createMany({
        data: [
          { slaveId: slave.id, provider: 'claude_code', status: 'succeeded' },
          { slaveId: slave.id, provider: 'claude_code', status: 'failed' },
          { slaveId: slave.id, provider: 'cursor', status: 'succeeded' },
        ],
      })

      const adapters = await buildProviderAdapters(async () => null)
      expect(adapters.find((a) => a.kind === 'claude_code')?.slavesBound).toBe(2)
      expect(adapters.find((a) => a.kind === 'cursor')?.slavesBound).toBe(1)
    })
  })

  describe('buildPermissionMatrix', () => {
    it('maps unset to null, and allow/deny to themselves', async (): Promise<void> => {
      const { teamId } = await seedWorkspace('Checkout Platform')
      const slave = await prisma.slave.create({ data: { teamId, name: 'Alex', role: 'backend' } })
      await prisma.slavePermission.createMany({
        data: [
          { slaveId: slave.id, tool: 'repo read', mode: 'allow' },
          { slaveId: slave.id, tool: 'source write', mode: 'deny' },
        ],
      })

      const sections = await buildPermissionMatrix()
      const cells = sections[0]?.rows[0]?.cells ?? []

      // All six, in the README's order, every time — a tool with no row is `null`, which is
      // UNSET and not the same statement as `deny`.
      expect(cells.map((c) => c.tool)).toEqual([
        'repo read',
        'source write',
        'run tests',
        'create branch',
        'deploy prod',
        'read secrets',
      ])
      expect(cells.map((c) => c.mode)).toEqual(['allow', 'deny', null, null, null, null])
    })

    it('groups the rows by workspace, so same-named slaves in two projects stay apart', async (): Promise<void> => {
      const checkout = await seedWorkspace('Checkout Platform')
      const ledger = await seedWorkspace('Ledger')
      const here = await prisma.slave.create({ data: { teamId: checkout.teamId, name: 'Alex', role: 'backend' } })
      const there = await prisma.slave.create({ data: { teamId: ledger.teamId, name: 'Alex', role: 'backend' } })
      await prisma.slavePermission.create({ data: { slaveId: here.id, tool: 'repo read', mode: 'allow' } })

      const sections = await buildPermissionMatrix()

      // Ordered by workspace name, and each section holds only its own workspace's slaves.
      expect(sections.map((s) => s.workspaceName)).toEqual(['Checkout Platform', 'Ledger'])
      expect(sections[0]?.rows.map((r) => r.slaveId)).toEqual([here.id])
      expect(sections[1]?.rows.map((r) => r.slaveId)).toEqual([there.id])

      // The permission belongs to one of the two identically-named slaves, not to both.
      expect(sections[0]?.rows[0]?.cells[0]?.mode).toBe('allow')
      expect(sections[1]?.rows[0]?.cells[0]?.mode).toBeNull()
    })

    it("orders a workspace's slaves by name across all of its teams", async (): Promise<void> => {
      const { workspaceId, teamId } = await seedWorkspace('Checkout Platform')
      const other = await prisma.team.create({ data: { workspaceId, name: 'Platform' } })
      await prisma.slave.create({ data: { teamId, name: 'Zoe', role: 'backend' } })
      await prisma.slave.create({ data: { teamId: other.id, name: 'Alex', role: 'frontend' } })

      const sections = await buildPermissionMatrix()
      // Sorted across the two teams, not concatenated team by team.
      expect(sections[0]?.rows.map((r) => r.name)).toEqual(['Alex', 'Zoe'])
    })

    it('keeps a workspace with no slaves as an empty section rather than dropping it', async (): Promise<void> => {
      const { workspaceId } = await seedWorkspace('Fresh')
      const sections = await buildPermissionMatrix()
      expect(sections).toHaveLength(1)
      expect(sections[0]?.workspaceId).toBe(workspaceId)
      expect(sections[0]?.rows).toEqual([])
    })
  })
})
