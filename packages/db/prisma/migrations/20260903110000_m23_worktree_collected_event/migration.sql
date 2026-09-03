-- M23 §3 B1/B2: the worktree-collection verb (`collectTaskWorktree`) needs its own event so the
-- activity log can say a tree was removed and why, distinct from the task.done/task.failed that
-- already recorded the task's own outcome.
--
-- Additive in the sense the milestone's constraint means: one new enum member, no column touched,
-- no existing row rewritten, nothing dropped. `IF NOT EXISTS` makes re-running it a no-op.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- permits as long as the new value is not USED in the same transaction. Nothing here uses it.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'task.worktree_collected';
