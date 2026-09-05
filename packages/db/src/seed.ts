import { prisma } from './client.js'
import { TASK_STATUSES } from './enums.js'
import { SEED_WORKSPACE_ID } from './seed-workspace-id.js'

export { SEED_WORKSPACE_ID }

const TEAMS = ['Management', 'Engineering', 'Security', 'Product', 'Marketing'] as const

/**
 * The reusable slave templates (M10 §4) a company's roster instantiates from. `defaultModel` is
 * `null` for every one -- a model choice is an operator decision (set later via `set-model` /
 * `assignCompany`'s roster override), never a seed opinion. Java Developer and Backend Developer
 * deliberately share a `role`: the canonical example of two templates being distinct catalog
 * entries even when their underlying worker role is the same.
 */
const TEMPLATES: readonly { name: string; role: string }[] = [
  { name: 'Engineering Manager', role: 'manager' },
  { name: 'Backend Developer', role: 'backend' },
  { name: 'Frontend Developer', role: 'frontend' },
  { name: 'QA Reviewer', role: 'reviewer' },
  { name: 'Java Developer', role: 'backend' },
]

const COMPANY_NAME = 'Atlas Software'
const COMPANY_TEAM_NAME = 'Engineering'

/** Atlas Software's Engineering roster -- mirrors today's seeded crew, one member per template. */
const ROSTER: readonly { name: string; template: string }[] = [
  { name: 'Atlas', template: 'Engineering Manager' },
  { name: 'Alex', template: 'Backend Developer' },
  { name: 'Emma', template: 'Frontend Developer' },
  { name: 'Riley', template: 'QA Reviewer' },
]

const SLAVES: readonly { name: string; role: string; team: (typeof TEAMS)[number] }[] = [
  // Lowercase, matching the M8b planning dispatch's exact-match `role === 'manager'` -- the same
  // convention `dispatchReview` uses for `role === 'reviewer'`.
  { name: 'Atlas', role: 'manager', team: 'Management' },
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
    'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "SlaveSkill", "Skill", "SkillProvider", "SlavePermission", "ProviderConfiguration", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )

  const workspace = await prisma.workspace.create({
    data: {
      id: SEED_WORKSPACE_ID,
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

  // Without a ProviderConfiguration row, `workspaceDefaultProvider` (M12 Task 8) returns null,
  // `resolveRuntime` refuses every dispatch with `invalid_provider`, and the seeded workspace
  // cannot run a single task -- do not drop this when editing seed data.
  await prisma.providerConfiguration.create({
    data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} },
  })

  for (const team of TEAMS) {
    await prisma.team.create({ data: { workspaceId: workspace.id, name: team } })
  }

  const teamsByName = new Map(
    (await prisma.team.findMany()).map((team) => [team.name, team.id] as const),
  )

  for (const slave of SLAVES) {
    const teamId = teamsByName.get(slave.team)
    if (teamId === undefined) {
      throw new Error(`seed is inconsistent: no team named ${slave.team}`)
    }
    await prisma.slave.create({ data: { teamId, name: slave.name, role: slave.role } })
  }

  // The reusable template catalog and Atlas Software's roster (M10 §4-5) -- written directly with
  // prisma, the same style as the legacy workspace above, not through the `packages/control`
  // verbs. The legacy workspace's hand-made teams/slaves above are left untouched and the
  // workspace is never assigned to Atlas Software (spec Decision 7 -- legacy stays legacy;
  // assignment is the operator's first act).
  for (const template of TEMPLATES) {
    await prisma.slaveTemplate.create({ data: { name: template.name, role: template.role, defaultModel: null } })
  }

  const templatesByName = new Map(
    (await prisma.slaveTemplate.findMany()).map((template) => [template.name, template.id] as const),
  )

  const company = await prisma.company.create({ data: { name: COMPANY_NAME } })
  const companyTeam = await prisma.companyTeam.create({
    data: { companyId: company.id, name: COMPANY_TEAM_NAME },
  })

  for (const member of ROSTER) {
    const templateId = templatesByName.get(member.template)
    if (templateId === undefined) {
      throw new Error(`seed is inconsistent: no template named ${member.template}`)
    }
    await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId, name: member.name },
    })
  }

  // One task per status, so every state has a real example on screen when M4 arrives.
  // maxAttempts is copied from the workspace guardrail configuration — the only correct source.
  // Deliberately NO `requiredRole` on any seeded task: `decide()` cannot match a roleless task to
  // an slave, so a daemon pointed at freshly-seeded data starts nothing and spends nothing -- the
  // tick's `skippedNoRole: 12` on this workspace is that invariant showing, not a bug (M15 spec
  // §3 B5). The seed demonstrates the UI's states; it must never be dispatchable demo data,
  // because this workspace carries a live ProviderConfiguration and real runs cost real money.
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
