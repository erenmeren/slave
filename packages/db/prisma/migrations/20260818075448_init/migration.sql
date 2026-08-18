-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('backlog', 'ready', 'blocked', 'assigned', 'running', 'verifying', 'reviewing', 'merging', 'rework', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('starting', 'working', 'pause_requested', 'paused', 'resuming', 'stopping', 'stopped', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "Actor" AS ENUM ('human', 'agent', 'system');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL DEFAULT 'main',
    "verifyCommand" TEXT NOT NULL,
    "autoMerge" BOOLEAN NOT NULL DEFAULT false,
    "maxConcurrentRuns" INTEGER NOT NULL DEFAULT 3,
    "budgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "runTimeoutMs" INTEGER NOT NULL DEFAULT 1800000,
    "maxToolCallsPerRun" INTEGER NOT NULL DEFAULT 200,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "consecutiveFailureLimit" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "requiredRole" TEXT,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Team_workspaceId_idx" ON "Team"("workspaceId");

-- CreateIndex
CREATE INDEX "Agent_teamId_idx" ON "Agent"("teamId");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
