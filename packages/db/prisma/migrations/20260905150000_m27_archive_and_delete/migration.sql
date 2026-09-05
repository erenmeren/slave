-- M27: a project can be archived (soft) -- the flag every list and the scheduler read. Two event
-- types record the archive and the restore. Nothing else changes; every delete in M27 rides the
-- cascades the schema already declares.
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.archived';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.restored';
