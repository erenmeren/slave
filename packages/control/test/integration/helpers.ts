import { prisma } from '@slave-of-ai/db/client'

/**
 * The package's own truncate idiom (`capability.test.ts`): the project and catalog tables these
 * files write. There is no shared helper in this directory; this is that same statement, named
 * so the person-verb tests can call it rather than inventing a second reset.
 */
const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "PersonSkill", "TemplateSkill", "Skill", "SkillProvider", "Slave", "Person", "Team", "Workspace", "CollaborationHint", "CompanyTeamMember", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE'

export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(TRUNCATE)
}
