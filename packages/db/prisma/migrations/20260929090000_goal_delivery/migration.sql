-- Conductor Plan 4a (spec R9 "Where merges go", §5), 2026-09-29: a goal version is built on its own
-- integration branch and reaches the base branch once.
--
-- One `GoalDelivery` row per conducted goal version: the integration branch the conductor cut from
-- the base branch (and the base commit it was cut at), and where the version stands --
-- `integrating` while its packages are worked and merged into that branch, `accepted` once every
-- package is integrated (Plan 4b: once every requirement is verified), `abandoned` when the person
-- moved on. `mergedAt` is when the branch reached the base branch; `mergeError` is a final merge git
-- refused, left for a person. PURELY ADDITIVE: one enum type, one table, four event values, unused
-- inside this migration's transaction (which Postgres 12+ requires of `ADD VALUE`).

CREATE TYPE "GoalDeliveryStatus" AS ENUM ('integrating', 'accepted', 'abandoned');

CREATE TABLE "GoalDelivery" (
    "id"                TEXT NOT NULL,
    "workspaceId"       TEXT NOT NULL,
    "goalVersion"       INTEGER NOT NULL,
    "integrationBranch" TEXT NOT NULL,
    "baseCommit"        TEXT NOT NULL,
    "status"            "GoalDeliveryStatus" NOT NULL DEFAULT 'integrating',
    "acceptedAt"        TIMESTAMP(3),
    "mergedAt"          TIMESTAMP(3),
    "mergeError"        TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoalDelivery_workspaceId_goalVersion_key" ON "GoalDelivery"("workspaceId", "goalVersion");
ALTER TABLE "GoalDelivery" ADD CONSTRAINT "GoalDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_waiting';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_accepted';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_merged';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_abandoned';
