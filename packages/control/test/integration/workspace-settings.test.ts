import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { refusalText } from '../../src/refusal.js'
import { setWorkspaceBudget, setWorkspaceProvider } from '../../src/workspace.js'
import { workspaceDefaultProvider } from '../../src/runtime.js'

// A real directory, not a placeholder (M23 G3): runFilePaths' statSync preflight refuses a repo path that does not exist, and a reboot clears /tmp -- the trap emergency.test.ts fell into at ce48adc.
const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-workspace-settings-'))

afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

interface Fixture {
  readonly workspace: { readonly id: string }
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath,
      verifyCommands: ['npm test'],
      setupCommands: ['npm ci'],
    },
  })
  return { workspace: { id: workspace.id } }
}

describe('the workspace settings verbs', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  describe('setWorkspaceProvider', () => {
    it('replaces any existing row so the workspace always resolves exactly one default', async (): Promise<void> => {
      expect((await setWorkspaceProvider(fixture.workspace.id, 'claude_code')).ok).toBe(true)
      expect((await setWorkspaceProvider(fixture.workspace.id, 'cursor')).ok).toBe(true)

      const rows = await prisma.providerConfiguration.findMany({ where: { workspaceId: fixture.workspace.id } })
      // Decision 9: one workspace, one provider row. Two rows make
      // `workspaceDefaultProvider` return null, which stops every dispatch in the workspace.
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('cursor')
      expect(rows[0]?.settings).toEqual({})
      expect(await workspaceDefaultProvider(fixture.workspace.id)).toBe('cursor')
    })

    it('deletes the row on null, leaving no default at all', async (): Promise<void> => {
      await setWorkspaceProvider(fixture.workspace.id, 'cursor')
      expect((await setWorkspaceProvider(fixture.workspace.id, null)).ok).toBe(true)

      expect(await prisma.providerConfiguration.count({ where: { workspaceId: fixture.workspace.id } })).toBe(0)
      expect(await workspaceDefaultProvider(fixture.workspace.id)).toBeNull()
    })

    it('records what changed, from what, to what', async (): Promise<void> => {
      await setWorkspaceProvider(fixture.workspace.id, 'cursor')
      const events = await prisma.executionEvent.findMany({
        where: { workspaceId: fixture.workspace.id, type: 'workspace_settings_changed' },
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({ field: 'provider', from: null, to: 'cursor' })
      expect(events[0]?.actor).toBe('human')
    })

    it('refuses an unknown workspace and an unknown kind, writing nothing', async (): Promise<void> => {
      const missing = await setWorkspaceProvider('00000000-0000-0000-0000-000000000000', 'cursor')
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.error.kind).toBe('workspace_not_found')

      const bogus = await setWorkspaceProvider(fixture.workspace.id, 'gpt' as never)
      expect(bogus.ok).toBe(false)
      if (!bogus.ok) expect(refusalText(bogus.error)).toBe('a provider must be a configured kind')
      expect(await prisma.providerConfiguration.count({ where: { workspaceId: fixture.workspace.id } })).toBe(0)
    })

    it('does not refuse a halted workspace', async (): Promise<void> => {
      // Decision 11: changing the runtime is a legitimate way to make a halt clearable.
      await prisma.workspace.update({
        where: { id: fixture.workspace.id },
        data: { haltedReason: 'emergency stop by meren', haltedAt: new Date() },
      })
      expect((await setWorkspaceProvider(fixture.workspace.id, 'cursor')).ok).toBe(true)
    })

    it('leaves exactly one row when two writers with different kinds race', async (): Promise<void> => {
      // I1. Under READ COMMITTED, `deleteMany` in one transaction cannot see the other's
      // uncommitted `create`, and `@@unique([workspaceId, kind])` does not collide across DIFFERENT
      // kinds -- so without a lock on the `Workspace` row both writers delete nothing of the
      // other's and both insert, leaving TWO rows. Two rows make `workspaceDefaultProvider` return
      // null, and since Task 3 every dispatch that then throws burns an attempt per task per tick.
      // The loop is what makes the interleaving likely; the assertion is what makes it a test.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await prisma.providerConfiguration.deleteMany({ where: { workspaceId: fixture.workspace.id } })

        const [claudeResult, cursorResult] = await Promise.all([
          setWorkspaceProvider(fixture.workspace.id, 'claude_code'),
          setWorkspaceProvider(fixture.workspace.id, 'cursor'),
        ])
        expect(claudeResult.ok).toBe(true)
        expect(cursorResult.ok).toBe(true)

        const rows = await prisma.providerConfiguration.findMany({ where: { workspaceId: fixture.workspace.id } })
        expect(rows).toHaveLength(1)
        // Which writer won is genuinely a race; that a default still RESOLVES is not.
        expect(['claude_code', 'cursor']).toContain(await workspaceDefaultProvider(fixture.workspace.id))
      }
    })
  })

  describe('setWorkspaceBudget', () => {
    it('writes a number, and null for "not budgeted"', async (): Promise<void> => {
      expect((await setWorkspaceBudget(fixture.workspace.id, 42.5)).ok).toBe(true)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).budgetUsd).toBe(42.5)

      expect((await setWorkspaceBudget(fixture.workspace.id, null)).ok).toBe(true)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).budgetUsd).toBeNull()
    })

    it('accepts zero, which is a budget an operator set', async (): Promise<void> => {
      expect((await setWorkspaceBudget(fixture.workspace.id, 0)).ok).toBe(true)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).budgetUsd).toBe(0)
    })

    it('refuses a negative, a NaN and an infinity with the verbatim text', async (): Promise<void> => {
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const result = await setWorkspaceBudget(fixture.workspace.id, bad)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(refusalText(result.error)).toBe('a budget must be a non-negative amount or absent')
      }
      // The `@default(20)` the workspace was created with is untouched by every refusal.
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).budgetUsd).toBe(20)
    })

    it('records the change with the previous figure', async (): Promise<void> => {
      await setWorkspaceBudget(fixture.workspace.id, null)
      const events = await prisma.executionEvent.findMany({
        where: { workspaceId: fixture.workspace.id, type: 'workspace_settings_changed' },
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({ field: 'budgetUsd', from: 20, to: null })
    })

    it('allows a cost-blind provider on a budgeted workspace: the refusal lives at dispatch', async (): Promise<void> => {
      // Decision 10. `admitProvider` already refuses this pair at dispatch with
      // `a budget needs a provider that reports cost`; duplicating it here would give the
      // operator two different moments to be told the same thing, and would make it impossible to
      // reach the configuration by setting the provider first and the budget second.
      await setWorkspaceBudget(fixture.workspace.id, 20)
      expect((await setWorkspaceProvider(fixture.workspace.id, 'cursor')).ok).toBe(true)
    })
  })
})
