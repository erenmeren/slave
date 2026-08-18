-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('task.created', 'task.started', 'task.done', 'task.rework', 'run.started', 'run.tool_call', 'run.paused', 'run.resumed', 'agent.message_sent', 'guardrail.tripped');

-- CreateTable
CREATE TABLE "ExecutionEvent" (
    "seq" BIGSERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "EventType" NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT,
    "agentId" TEXT,
    "runId" TEXT,
    "actor" "Actor" NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "ExecutionEvent_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "ExecutionEvent_workspaceId_seq_idx" ON "ExecutionEvent"("workspaceId", "seq");
