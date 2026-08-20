import { prisma } from '@ai-team-os/db/client'

export async function listWorkspaces(): Promise<readonly { id: string; name: string }[]> {
  return prisma.workspace.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })
}
