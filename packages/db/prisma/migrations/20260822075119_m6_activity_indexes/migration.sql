-- CreateIndex
CREATE INDEX "ExecutionEvent_workspaceId_agentId_seq_idx" ON "ExecutionEvent"("workspaceId", "agentId", "seq");

-- CreateIndex
CREATE INDEX "ExecutionEvent_workspaceId_taskId_seq_idx" ON "ExecutionEvent"("workspaceId", "taskId", "seq");
