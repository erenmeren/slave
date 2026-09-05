import { prisma } from '@slave-of-ai/db/client'

export async function listWorkspaces(): Promise<readonly { id: string; name: string }[]> {
  return prisma.workspace.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
}
