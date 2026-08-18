-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "pid" INTEGER,
ADD COLUMN     "terminalAt" TIMESTAMP(3),
ADD COLUMN     "worktreePath" TEXT;

-- AlterTable
-- `verifyCommands`/`setupCommands` are required, non-default columns per the Prisma schema, but
-- the seeded dev database already has one Workspace row. Adding a NOT NULL column to a non-empty
-- table needs a backfill value; a temporary default supplies it for existing rows and is then
-- dropped so the schema (no @default) and the database agree going forward. This is the same
-- two-step ADD COLUMN ... DEFAULT / DROP DEFAULT sequence `prisma migrate dev` generates when run
-- interactively and given a one-time default at its prompt.
ALTER TABLE "Workspace" DROP COLUMN "verifyCommand",
ADD COLUMN     "haltedAt" TIMESTAMP(3),
ADD COLUMN     "haltedReason" TEXT,
ADD COLUMN     "setupCommands" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "verifyCommands" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Workspace" ALTER COLUMN "setupCommands" DROP DEFAULT;
ALTER TABLE "Workspace" ALTER COLUMN "verifyCommands" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Checkpoint" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "worktreePath" TEXT NOT NULL,
    "pauseFlagPath" TEXT NOT NULL,
    "lastToolUseId" TEXT,
    "lastToolName" TEXT,
    "numTurns" INTEGER NOT NULL DEFAULT 0,
    "deniedToolUseIds" TEXT[],
    "headCommit" TEXT NOT NULL,
    "dirtyFiles" TEXT[],
    "cumulativeCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cumulativeTokens" INTEGER NOT NULL DEFAULT 0,
    "pauseReason" TEXT,
    "requestedBy" TEXT,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Checkpoint_runId_key" ON "Checkpoint"("runId");

-- AddForeignKey
ALTER TABLE "Checkpoint" ADD CONSTRAINT "Checkpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
