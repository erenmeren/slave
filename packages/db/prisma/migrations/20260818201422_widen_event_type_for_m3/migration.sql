-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'task.verifying';
ALTER TYPE "EventType" ADD VALUE 'task.verify_passed';
ALTER TYPE "EventType" ADD VALUE 'task.verify_failed';
ALTER TYPE "EventType" ADD VALUE 'task.failed';
ALTER TYPE "EventType" ADD VALUE 'run.output';
ALTER TYPE "EventType" ADD VALUE 'run.pause_requested';
ALTER TYPE "EventType" ADD VALUE 'run.stopped';
ALTER TYPE "EventType" ADD VALUE 'run.succeeded';
ALTER TYPE "EventType" ADD VALUE 'run.failed';
