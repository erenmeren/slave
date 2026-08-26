import { prisma } from '@ai-team-os/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { workspaceDefaultProvider } from '../../src/runtime.js'

/**
 * `workspaceDefaultProvider` moved into this package at M12 Task 9 (write-time budget admission
 * has to resolve the same chain dispatch does, and `packages/control` cannot import
 * `apps/orchestrator`). Its tests followed it here in fix round F2, importing `../../src/
 * runtime.js` DIRECTLY: left where they were, they reached the function through
 * `apps/orchestrator/src/model.ts`'s re-export and therefore through `@ai-team-os/control`'s
 * COMPILED `dist/`, since `vitest.config.ts` declares no workspace aliases. That is a permanent
 * downgrade in what a green means -- editing the source and running the suite without a rebuild
 * would test the previous build -- and it is the shape that nearly sank Task 8.
 */
describe('workspaceDefaultProvider', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  it('resolves to the one configured kind', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['true'], setupCommands: [] },
    })
    await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })

    expect(await workspaceDefaultProvider(workspace.id)).toBe('claude_code')
  })

  it('yields null -- a refusal, not an assumed Claude -- for a workspace with no configuration row', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['true'], setupCommands: [] },
    })

    expect(await workspaceDefaultProvider(workspace.id)).toBeNull()
  })

  it('yields null for a workspace with more than one configured kind -- there is no "the default" column to pick one by', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommands: ['true'], setupCommands: [] },
    })
    await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
    await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'cursor', settings: {} } })

    expect(await workspaceDefaultProvider(workspace.id)).toBeNull()
  })
})
