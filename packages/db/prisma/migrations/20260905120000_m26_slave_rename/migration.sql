-- M26: the word is slave. Renames only -- no column type, default or relation changes -- so
-- every existing row survives. Written by hand: `prisma migrate dev` would diff the renamed
-- schema as DROP + CREATE. Names follow Prisma's own convention (<Table>_pkey,
-- <Table>_<cols>_key, <Table>_<cols>_idx, <Table>_<col>_fkey) so `prisma migrate diff` against
-- the renamed schema is empty afterwards.

-- tables
ALTER TABLE "Agent"           RENAME TO "Slave";
ALTER TABLE "AgentRun"        RENAME TO "SlaveRun";
ALTER TABLE "AgentTemplate"   RENAME TO "SlaveTemplate";
ALTER TABLE "AgentPermission" RENAME TO "SlavePermission";
ALTER TABLE "AgentSkill"      RENAME TO "SlaveSkill";
ALTER TABLE "AgentMessage"    RENAME TO "SlaveMessage";
ALTER TABLE "CompanyAgent"    RENAME TO "CompanySlave";

-- columns
ALTER TABLE "Slave"           RENAME COLUMN "companyAgentId" TO "companySlaveId";
ALTER TABLE "SlaveRun"        RENAME COLUMN "agentId" TO "slaveId";
ALTER TABLE "SlavePermission" RENAME COLUMN "agentId" TO "slaveId";
ALTER TABLE "SlaveSkill"      RENAME COLUMN "agentId" TO "slaveId";
ALTER TABLE "SlaveMessage"    RENAME COLUMN "agentId" TO "slaveId";
ALTER TABLE "ExecutionEvent"  RENAME COLUMN "agentId" TO "slaveId";

-- primary keys
ALTER TABLE "Slave"           RENAME CONSTRAINT "Agent_pkey"           TO "Slave_pkey";
ALTER TABLE "SlaveRun"        RENAME CONSTRAINT "AgentRun_pkey"        TO "SlaveRun_pkey";
ALTER TABLE "SlaveTemplate"   RENAME CONSTRAINT "AgentTemplate_pkey"   TO "SlaveTemplate_pkey";
ALTER TABLE "SlavePermission" RENAME CONSTRAINT "AgentPermission_pkey" TO "SlavePermission_pkey";
ALTER TABLE "SlaveSkill"      RENAME CONSTRAINT "AgentSkill_pkey"      TO "SlaveSkill_pkey";
ALTER TABLE "SlaveMessage"    RENAME CONSTRAINT "AgentMessage_pkey"    TO "SlaveMessage_pkey";
ALTER TABLE "CompanySlave"    RENAME CONSTRAINT "CompanyAgent_pkey"    TO "CompanySlave_pkey";

-- unique constraints: these are bare unique indexes in the live schema (verified via
-- pg_constraint: none of the project's "_key" unique keys are registered there), not table
-- constraints, so they rename via ALTER INDEX like the plain indexes below.
ALTER INDEX "AgentTemplate_name_key"              RENAME TO "SlaveTemplate_name_key";
ALTER INDEX "AgentPermission_agentId_tool_key"    RENAME TO "SlavePermission_slaveId_tool_key";
ALTER INDEX "CompanyAgent_companyTeamId_name_key" RENAME TO "CompanySlave_companyTeamId_name_key";

-- foreign keys
ALTER TABLE "Slave"           RENAME CONSTRAINT "Agent_teamId_fkey"               TO "Slave_teamId_fkey";
ALTER TABLE "Slave"           RENAME CONSTRAINT "Agent_companyAgentId_fkey"       TO "Slave_companySlaveId_fkey";
ALTER TABLE "SlaveRun"        RENAME CONSTRAINT "AgentRun_taskId_fkey"            TO "SlaveRun_taskId_fkey";
ALTER TABLE "SlaveRun"        RENAME CONSTRAINT "AgentRun_agentId_fkey"           TO "SlaveRun_slaveId_fkey";
ALTER TABLE "SlavePermission" RENAME CONSTRAINT "AgentPermission_agentId_fkey"    TO "SlavePermission_slaveId_fkey";
ALTER TABLE "SlaveSkill"      RENAME CONSTRAINT "AgentSkill_agentId_fkey"         TO "SlaveSkill_slaveId_fkey";
ALTER TABLE "SlaveSkill"      RENAME CONSTRAINT "AgentSkill_skillId_fkey"         TO "SlaveSkill_skillId_fkey";
ALTER TABLE "SlaveMessage"    RENAME CONSTRAINT "AgentMessage_taskId_fkey"        TO "SlaveMessage_taskId_fkey";
ALTER TABLE "SlaveMessage"    RENAME CONSTRAINT "AgentMessage_agentId_fkey"       TO "SlaveMessage_slaveId_fkey";
ALTER TABLE "CompanySlave"    RENAME CONSTRAINT "CompanyAgent_companyTeamId_fkey" TO "CompanySlave_companyTeamId_fkey";
ALTER TABLE "CompanySlave"    RENAME CONSTRAINT "CompanyAgent_templateId_fkey"    TO "CompanySlave_templateId_fkey";

-- indexes
ALTER INDEX "Agent_teamId_idx"                       RENAME TO "Slave_teamId_idx";
ALTER INDEX "AgentRun_taskId_idx"                    RENAME TO "SlaveRun_taskId_idx";
ALTER INDEX "AgentRun_agentId_status_idx"            RENAME TO "SlaveRun_slaveId_status_idx";
ALTER INDEX "AgentMessage_agentId_createdAt_idx"     RENAME TO "SlaveMessage_slaveId_createdAt_idx";
ALTER INDEX "ExecutionEvent_workspaceId_agentId_seq_idx" RENAME TO "ExecutionEvent_workspaceId_slaveId_seq_idx";

-- enum values (stored strings)
ALTER TYPE "EventType" RENAME VALUE 'agent.message_sent' TO 'slave.message_sent';
ALTER TYPE "Actor"     RENAME VALUE 'agent' TO 'slave';
