import { prisma } from '@slave-of-ai/db/client'

/**
 * The tables the person read-model and route suite write. Named so `persons-read.test.ts` can
 * reset without inventing a second statement beside `projectFixture.ts`'s (which does not cover
 * skills).
 */
const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "PersonSkill", "TemplateSkill", "Skill", "SkillProvider", "Slave", "Person", "Team", "Workspace", "CollaborationHint", "CompanyTeamMember", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE'

export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(TRUNCATE)
}
