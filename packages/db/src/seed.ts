import { prisma } from './client.js'
import { TASK_STATUSES } from './enums.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

const TEAMS = ['Management', 'Engineering', 'Security', 'Product', 'Marketing'] as const

const AGENTS: readonly { name: string; role: string; team: (typeof TEAMS)[number] }[] = [
  { name: 'Atlas', role: 'AI Manager', team: 'Management' },
  { name: 'Alex', role: 'Backend', team: 'Engineering' },
  { name: 'Emma', role: 'Frontend', team: 'Engineering' },
  { name: 'Daniel', role: 'DevOps', team: 'Engineering' },
  { name: 'Maya', role: 'QA', team: 'Engineering' },
  // Lowercase, unlike the other roles here: Task 5's review dispatch matches `role === 'reviewer'`
  // exactly, the same convention `decide()` uses for `requiredRole`.
  { name: 'Riley', role: 'reviewer', team: 'Engineering' },
  { name: 'Sarah', role: 'Security', team: 'Security' },
  { name: 'John', role: 'Business Analyst', team: 'Product' },
  { name: 'Oliver', role: 'SEO', team: 'Marketing' },
]

/**
 * Truncate-and-reseed rather than upsert. Upserts have to guess which rows correspond, and a
 * seed that guesses drifts from the schema silently. This one is idempotent by construction.
 */
export async function seed(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "AgentSkill", "Skill", "SkillProvider", "AgentPermission", "ProviderConfiguration", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )

  const workspace = await prisma.workspace.create({
    data: {
      id: WORKSPACE_ID,
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout-platform',
      verifyCommands: ['npm run build', 'npm test'],
      setupCommands: ['npm ci'],
      // Deliberately not the schema default of 3. Every seeded task copies this value below —
      // if it matched the default, that copy would be indistinguishable from a hardcoded
      // literal, and the link between Workspace.maxAttempts and Task.maxAttempts (the thing
      // M1's final review found unlinked) would go untested. Do not "tidy" this back to 3.
      maxAttempts: 5,
    },
  })

  for (const team of TEAMS) {
    await prisma.team.create({ data: { workspaceId: workspace.id, name: team } })
  }

  const teamsByName = new Map(
    (await prisma.team.findMany()).map((team) => [team.name, team.id] as const),
  )

  for (const agent of AGENTS) {
    const teamId = teamsByName.get(agent.team)
    if (teamId === undefined) {
      throw new Error(`seed is inconsistent: no team named ${agent.team}`)
    }
    await prisma.agent.create({ data: { teamId, name: agent.name, role: agent.role } })
  }

  // One task per status, so every state has a real example on screen when M4 arrives.
  // maxAttempts is copied from the workspace guardrail configuration — the only correct source.
  for (const status of TASK_STATUSES) {
    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `Checkout task in ${status}`,
        description: `Demonstrates the ${status} state.`,
        status,
        maxAttempts: workspace.maxAttempts,
      },
    })
  }
}

if (process.argv[1]?.endsWith('seed.js') === true) {
  await seed()
  await prisma.$disconnect()
}
