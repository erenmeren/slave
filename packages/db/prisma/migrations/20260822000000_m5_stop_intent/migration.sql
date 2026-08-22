-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "stopRequestedBy" TEXT,
ADD COLUMN     "stopRequestedAt" TIMESTAMP(3);
