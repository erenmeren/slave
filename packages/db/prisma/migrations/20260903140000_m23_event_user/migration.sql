-- M23 F6: who did it. Nullable everywhere -- the CLI and the orchestrator have no user.
-- `ADD CONSTRAINT` has no `IF NOT EXISTS` (Postgres does not support it on that clause);
-- Prisma runs each migration exactly once against a given database, so a plain ADD CONSTRAINT
-- is safe here the same way every other migration.sql in this package relies on that guarantee.
ALTER TABLE "ExecutionEvent" ADD COLUMN IF NOT EXISTS "userId" TEXT;
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "ExecutionEvent_userId_idx" ON "ExecutionEvent"("userId");
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "goalSetByUserId" TEXT;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_goalSetByUserId_fkey" FOREIGN KEY ("goalSetByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
