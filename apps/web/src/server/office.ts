import { prisma } from '@slave-of-ai/db/client'
import { DEPT_COLORS, SLAVE_COLORS } from '../lib/office/engine.js'
import { buildOverviewSnapshot, type OverviewSnapshot } from './overview'

export interface OfficeSlave {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly color: string
}

export interface OfficeDepartment {
  readonly teamId: string
  readonly name: string
  readonly color: string
  readonly slaves: readonly OfficeSlave[]
}

export interface OfficeSnapshot {
  readonly workspace: { readonly id: string; readonly name: string; readonly archived: boolean }
  readonly departments: readonly OfficeDepartment[]
  /** The office client's initial stream state — the same snapshot the Overview tab starts from. */
  readonly overview: OverviewSnapshot
}

/**
 * The Office tab's roster (M28 §3.1): every department of the project with its slaves, both in
 * name order, coloured from the design's palettes by position so the floor looks like the design
 * and the same project always paints the same. A department with no slaves keeps its pod. Live
 * status is not here — the client reads it from the overview stream this snapshot also seeds.
 */
export async function buildOfficeSnapshot(workspaceId: string): Promise<OfficeSnapshot | null> {
  const [workspace, teams, overview] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, archivedAt: true } }),
    prisma.team.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slaves: { orderBy: { name: 'asc' }, select: { id: true, name: true, role: true } } },
    }),
    buildOverviewSnapshot(workspaceId),
  ])
  if (workspace === null || overview === null) return null
  let slaveIndex = 0
  const departments = teams.map((team, i) => ({
    teamId: team.id,
    name: team.name,
    color: DEPT_COLORS[i % DEPT_COLORS.length] as string,
    slaves: team.slaves.map((slave) => ({
      slaveId: slave.id,
      name: slave.name,
      role: slave.role,
      color: SLAVE_COLORS[slaveIndex++ % SLAVE_COLORS.length] as string,
    })),
  }))
  return { workspace: { id: workspace.id, name: workspace.name, archived: workspace.archivedAt !== null }, departments, overview }
}
