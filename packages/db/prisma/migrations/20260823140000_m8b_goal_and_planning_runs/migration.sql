-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN "goal" TEXT;

-- AlterTable
ALTER TABLE "AgentRun" ALTER COLUMN "taskId" DROP NOT NULL;
