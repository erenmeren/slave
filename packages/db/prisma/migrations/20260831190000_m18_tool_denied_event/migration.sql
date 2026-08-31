-- M18 §2: the permission-matrix deny path gets its own non-terminal event -- a per-call refusal
-- the agent routes around, never the pause/stop path.
--
-- Additive in the sense the milestone's constraint means: one new enum member, no column touched,
-- no existing row rewritten, nothing dropped. `IF NOT EXISTS` makes re-running it a no-op.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- permits as long as the new value is not USED in the same transaction. Nothing here uses it.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'run.tool_denied';
