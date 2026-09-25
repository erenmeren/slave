import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { refusalText } from '../../src/refusal.js'
import { setWorkspaceBudget, setWorkspaceIntegration, setWorkspaceLimits, setWorkspaceProvider } from '../../src/workspace.js'
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
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
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
  /**
   * E R7: the verb behind the switch nothing used to be able to write. Its `unintegratedDone`
   * count is the README's caveat made countable -- turning auto-merge on does not retroactively
   * stamp anything, so the tasks that reached `done` by hand merge stay unstamped and keep
   * blocking their dependents until `confirm-integration` is run on each of them once.
   */
  describe('setWorkspaceIntegration', () => {
    const doneTask = (integratedAt: Date | null): Promise<unknown> =>
      prisma.task.create({
        data: {
          workspaceId: fixture.workspace.id,
          title: 'Add the thing',
          description: 'make it work',
          status: 'done',
          maxAttempts: 3,
          integratedAt,
        },
      })

    it('turns the switch on and off, and records both ends of the move', async (): Promise<void> => {
      const on = await setWorkspaceIntegration(fixture.workspace.id, { autoMerge: true })
      expect(on.ok).toBe(true)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).autoMerge).toBe(true)

      const off = await setWorkspaceIntegration(fixture.workspace.id, { autoMerge: false })
      expect(off.ok).toBe(true)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).autoMerge).toBe(false)

      const events = await prisma.executionEvent.findMany({
        where: { workspaceId: fixture.workspace.id, type: 'workspace_settings_changed' },
        orderBy: { seq: 'asc' },
      })
      expect(events.map((event) => event.payload)).toEqual([
        { field: 'autoMerge', from: false, to: true },
        { field: 'autoMerge', from: true, to: false },
      ])
      expect(events[0]?.actor).toBe('human')
    })

    it('counts the done tasks nobody stamped, which the flip does not stamp either', async (): Promise<void> => {
      await doneTask(null)
      await doneTask(null)
      await doneTask(new Date())

      const result = await setWorkspaceIntegration(fixture.workspace.id, { autoMerge: true })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.unintegratedDone).toBe(2)
      // The caveat itself: nothing was stamped by the flip.
      expect(await prisma.task.count({ where: { workspaceId: fixture.workspace.id, integratedAt: null } })).toBe(2)
    })

    it('counts zero on a project whose done work is all integrated', async (): Promise<void> => {
      await doneTask(new Date())

      const result = await setWorkspaceIntegration(fixture.workspace.id, { autoMerge: true })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.unintegratedDone).toBe(0)
    })

    it('refuses an unknown workspace, writing nothing', async (): Promise<void> => {
      const result = await setWorkspaceIntegration('00000000-0000-0000-0000-000000000000', { autoMerge: true })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('workspace_not_found')
      expect(await prisma.executionEvent.count({ where: { type: 'workspace_settings_changed' } })).toBe(0)
    })
  })

  /**
   * H9 F8: the three dispatch limits had defaults and no writer, so a project whose runs need more
   * than thirty minutes could only be helped by a hand edit of the database.
   */
  describe('setWorkspaceLimits', () => {
    const events = (): Promise<unknown[]> =>
      prisma.executionEvent
        .findMany({ where: { workspaceId: fixture.workspace.id, type: 'workspace_settings_changed' }, orderBy: { seq: 'asc' } })
        .then((rows) => rows.map((row) => row.payload))

    it('writes each limit and records one settings_changed per limit that moved', async (): Promise<void> => {
      const result = await setWorkspaceLimits(fixture.workspace.id, { runTimeoutMs: 60 * 60_000, maxConcurrentRuns: 5, maxAttempts: 4 })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.moved).toEqual([
        { field: 'runTimeoutMs', from: 1_800_000, to: 3_600_000 },
        { field: 'maxConcurrentRuns', from: 3, to: 5 },
        { field: 'maxAttempts', from: 3, to: 4 },
      ])
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })
      expect([workspace.runTimeoutMs, workspace.maxConcurrentRuns, workspace.maxAttempts]).toEqual([3_600_000, 5, 4])
      expect(await events()).toEqual(result.value.moved)
    })

    it('writes and says nothing for a limit the patch leaves out or restates', async (): Promise<void> => {
      const result = await setWorkspaceLimits(fixture.workspace.id, { maxConcurrentRuns: 3, maxAttempts: 2 })

      expect(result.ok && result.value.moved).toEqual([{ field: 'maxAttempts', from: 3, to: 2 }])
      expect(await events()).toEqual([{ field: 'maxAttempts', from: 3, to: 2 }])
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).runTimeoutMs).toBe(1_800_000)
    })

    it('accepts both ends of every bound', async (): Promise<void> => {
      expect((await setWorkspaceLimits(fixture.workspace.id, { runTimeoutMs: 5 * 60_000, maxConcurrentRuns: 1, maxAttempts: 1 })).ok).toBe(true)
      expect((await setWorkspaceLimits(fixture.workspace.id, { runTimeoutMs: 180 * 60_000, maxConcurrentRuns: 10, maxAttempts: 10 })).ok).toBe(true)
    })

    it.each([
      ['a timeout under five minutes', { runTimeoutMs: 4 * 60_000 }, 'a run timeout must be a whole number of minutes from 5 to 180'],
      ['a timeout over three hours', { runTimeoutMs: 181 * 60_000 }, 'a run timeout must be a whole number of minutes from 5 to 180'],
      ['a timeout that is not whole minutes', { runTimeoutMs: 90_000 * 7 }, 'a run timeout must be a whole number of minutes from 5 to 180'],
      ['no runs at all', { maxConcurrentRuns: 0 }, 'runs at once must be a whole number from 1 to 10'],
      ['eleven runs', { maxConcurrentRuns: 11 }, 'runs at once must be a whole number from 1 to 10'],
      ['zero attempts', { maxAttempts: 0 }, 'attempts per task must be a whole number from 1 to 10'],
      ['a fractional attempt', { maxAttempts: 2.5 }, 'attempts per task must be a whole number from 1 to 10'],
    ])('refuses %s, writing nothing', async (_label, patch, sentence): Promise<void> => {
      const result = await setWorkspaceLimits(fixture.workspace.id, patch)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('invalid_limit')
        expect(refusalText(result.error)).toBe(sentence)
      }
      expect(await events()).toEqual([])
    })

    it('writes neither limit when one of two is out of range', async (): Promise<void> => {
      const result = await setWorkspaceLimits(fixture.workspace.id, { maxConcurrentRuns: 6, maxAttempts: 99 })

      expect(result.ok).toBe(false)
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })).maxConcurrentRuns).toBe(3)
      expect(await events()).toEqual([])
    })

    it('does not refuse a halted workspace, and refuses an unknown one', async (): Promise<void> => {
      await prisma.workspace.update({ where: { id: fixture.workspace.id }, data: { haltedReason: 'emergency stop by meren', haltedAt: new Date() } })
      expect((await setWorkspaceLimits(fixture.workspace.id, { runTimeoutMs: 60 * 60_000 })).ok).toBe(true)

      const missing = await setWorkspaceLimits('00000000-0000-0000-0000-000000000000', { maxAttempts: 2 })
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.error.kind).toBe('workspace_not_found')
    })
  })

  // F R1/R4 smoke: the schema this task adds, not the verbs later tasks write around it.
  describe('the Supervisor conversation schema (F R1, R4)', () => {
    it('defaults a fresh workspace to the installation provider and model: both null', async (): Promise<void> => {
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspace.id } })
      expect(workspace.supervisorProvider).toBeNull()
      expect(workspace.supervisorModel).toBeNull()
    })

    it('stores a conversation turn and reads back its role and default status', async (): Promise<void> => {
      const message = await prisma.supervisorMessage.create({
        data: {
          workspaceId: fixture.workspace.id,
          seq: 1,
          role: 'human',
          text: 'why is nothing running?',
        },
      })

      const stored = await prisma.supervisorMessage.findUniqueOrThrow({ where: { id: message.id } })
      expect(stored.role).toBe('human')
      expect(stored.status).toBe('sent')
      expect(stored.attachments).toEqual([])
      expect(stored.actions).toBeNull()
      expect(stored.unmeasured).toBe(false)
    })
  })
})
