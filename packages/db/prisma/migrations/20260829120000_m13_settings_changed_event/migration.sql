-- M13 §6.1: the workspace's runtime and its budget become writable, and every write is recorded.
--
-- Additive in the sense the milestone's constraint means: one new enum member, no column touched,
-- no existing row rewritten, nothing dropped. `IF NOT EXISTS` makes re-running it a no-op.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- permits as long as the new value is not USED in the same transaction. Nothing here uses it.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.settings_changed';
