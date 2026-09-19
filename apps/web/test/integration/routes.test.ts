import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getOverview } from '../../src/app/api/w/[workspaceId]/overview/route.js'
import { listWorkspaces } from '../../src/server/workspaces.js'
import OrganizationRedirect from '../../src/app/w/[workspaceId]/organization/page.js'

describe('the overview route', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('serves the snapshot for a real workspace', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/x', verifyCommands: ['true'], setupCommands: [] },
    })

    const response = await getOverview(new Request('http://test/api'), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { workspace: { name: string } }
    expect(body.workspace.name).toBe('W')
  })

  it('404s a workspace that does not exist, naming it', async (): Promise<void> => {
    const response = await getOverview(new Request('http://test/api'), {
      params: Promise.resolve({ workspaceId: 'nope' }),
    })

    expect(response.status).toBe(404)
    expect(await response.text()).toContain('nope')
  })

  it('lists workspaces for the picker', async (): Promise<void> => {
    await prisma.workspace.create({
      data: { name: 'A', repoPath: '/tmp/a', verifyCommands: ['true'], setupCommands: [] },
    })
    await prisma.workspace.create({
      data: { name: 'B', repoPath: '/tmp/b', verifyCommands: ['true'], setupCommands: [] },
    })

    const all = await listWorkspaces()

    expect(all.map((w) => w.name).sort()).toEqual(['A', 'B'])
  })
})

describe('/w/:id/organization redirects to the Team tab (M61 R7)', () => {
  it('307s to /w/:id, carrying every query param forward', async (): Promise<void> => {
    let digest = ''
    try {
      await OrganizationRedirect({
        params: Promise.resolve({ workspaceId: 'w1' }),
        searchParams: Promise.resolve({ slave: 'x' }),
      })
      throw new Error('OrganizationRedirect did not redirect')
    } catch (cause) {
      digest = (cause as { digest?: string }).digest ?? ''
    }
    // `next/navigation`'s `redirect()` throws an error whose `digest` encodes the whole call:
    // `NEXT_REDIRECT;<type>;<destination>;<statusCode>;` (`next/dist/client/components/redirect.js`).
    const [code, , destination, status] = digest.split(';')
    expect(code).toBe('NEXT_REDIRECT')
    expect(status).toBe('307')
    expect(destination).toBe('/w/w1?slave=x')
  })

  it('redirects to the bare project route when there is no query string at all', async (): Promise<void> => {
    let digest = ''
    try {
      await OrganizationRedirect({
        params: Promise.resolve({ workspaceId: 'w1' }),
        searchParams: Promise.resolve({}),
      })
      throw new Error('OrganizationRedirect did not redirect')
    } catch (cause) {
      digest = (cause as { digest?: string }).digest ?? ''
    }
    const destination = digest.split(';').slice(2, -2).join(';')
    expect(destination).toBe('/w/w1')
  })
})
