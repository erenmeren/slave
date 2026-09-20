-- E, the self-running project (2026-09-20): one switch, three task facts.
-- No backfill: every existing project keeps proposing (the default), no task has needs, retries
-- or a review window until the Supervisor or the planner writes them.
CREATE TYPE "SupervisorAutonomy" AS ENUM ('propose', 'act');
ALTER TABLE "Workspace" ADD COLUMN "supervisorAutonomy" "SupervisorAutonomy" NOT NULL DEFAULT 'propose';
ALTER TABLE "Task" ADD COLUMN "requiredPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Task" ADD COLUMN "retries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "reviewWindowFrom" TIMESTAMP(3);
