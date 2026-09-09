-- M40 t1: the workspace goal becomes a versioned requirement (spec §2).

-- One immutable version of a workspace's goal. `setGoal` inserts `version = goalVersion + 1` under
-- a row lock and never overwrites history; the unique constraint is what makes two concurrent sets
-- impossible to interleave into a duplicate version rather than merely unlikely.
CREATE TABLE "GoalVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "setByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoalVersion_workspaceId_version_key" ON "GoalVersion"("workspaceId", "version");

ALTER TABLE "GoalVersion" ADD CONSTRAINT "GoalVersion_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The latest version, mirrored on the workspace beside the `goal` cache it belongs to. 0 means "no
-- version recorded". The backfill below makes that "the goal has never been set" for every row that
-- exists today; it only BECOMES an invariant once M40 Task 2 makes `setGoal` versioned, since until
-- then that verb writes `goal` without moving this column.
ALTER TABLE "Workspace" ADD COLUMN "goalVersion" INTEGER NOT NULL DEFAULT 0;

-- Which plan version produced this task. Nullable, and null is a real value: a hand-made task was
-- derived from no goal at all and can never be stale against one.
ALTER TABLE "Task" ADD COLUMN "goalVersion" INTEGER;

-- The three new event types and the Supervisor's new situation. `IF NOT EXISTS` so a database that
-- already took a value (a re-run, a hand-applied fix) is left alone rather than failing the deploy.
--
-- NOTE: Postgres forbids USING a new enum value in the same transaction that added it, and this
-- migration does not -- the backfill below writes rows and columns, never one of these labels. The
-- values are added here and first written by application code, which is a later transaction.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.replan_started';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.replanned';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'task.cancelled';
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'stale_task';

-- BACKFILL (spec §2). Every workspace that already has a goal gets that goal as version 1, with the
-- same hash `goalSha256` computes in the domain (`sha256` is built into Postgres from 11 on, so no
-- extension is required); its `goalVersion` becomes 1; and every task in such a workspace is
-- stamped 1 -- the only version that could have produced it. A workspace with no goal is left at
-- version 0 with no history row, which is exactly what "never set" means.
INSERT INTO "GoalVersion" (id, "workspaceId", version, text, sha256, "setByUserId", "createdAt")
SELECT gen_random_uuid()::text, id, 1, goal, encode(sha256(convert_to(goal, 'UTF8')), 'hex'), "goalSetByUserId", now()
FROM "Workspace"
WHERE goal IS NOT NULL;

UPDATE "Workspace" SET "goalVersion" = 1 WHERE goal IS NOT NULL;

UPDATE "Task" t SET "goalVersion" = 1
FROM "Workspace" w
WHERE w.id = t."workspaceId" AND w.goal IS NOT NULL;
