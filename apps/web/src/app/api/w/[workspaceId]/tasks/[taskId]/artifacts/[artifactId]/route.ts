import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { ARTIFACT_READ_LIMIT } from '../../../../../../../../lib/artifactLimit'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string; artifactId: string }> },
): Promise<Response> {
  const { workspaceId, taskId, artifactId } = await context.params
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, taskId, task: { workspaceId } },
    include: { task: { select: { workspace: { select: { repoPath: true } } } } },
  })
  if (artifact === null) return Response.json({ error: 'no such artifact' }, { status: 404 })
  // The row is data, the disk is the authority (spec §4 C2): a path outside the artifact root is
  // refused before it is opened, whatever wrote the row.
  const root = resolve(artifact.task.workspace.repoPath, '.slaveofai', 'artifacts') + sep
  const path = resolve(artifact.path)
  if (!path.startsWith(root)) return Response.json({ error: 'artifact path outside the artifact root' }, { status: 403 })
  const info = await stat(path).catch(() => null)
  if (info === null || !info.isFile()) return Response.json({ error: 'artifact file is gone' }, { status: 404 })
  const buffer = await readFile(path)
  const truncated = buffer.length > ARTIFACT_READ_LIMIT
  const body = truncated ? buffer.subarray(buffer.length - ARTIFACT_READ_LIMIT) : buffer
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...(truncated ? { 'x-artifact-truncated': '1' } : {}) },
  })
}
