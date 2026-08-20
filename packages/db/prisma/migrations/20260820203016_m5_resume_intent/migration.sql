-- AlterEnum
ALTER TYPE "EventType" ADD VALUE 'run.resume_requested';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "queuedMessage" TEXT,
ADD COLUMN     "resumeRequestedAt" TIMESTAMP(3);
