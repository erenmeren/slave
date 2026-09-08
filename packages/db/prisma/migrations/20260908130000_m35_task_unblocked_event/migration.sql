-- M35 t5: `unblockTask` (packages/control/src/unblock.ts) is the exit from `blocked` -- four
-- places park a task there (`tick.ts`'s worktree conflict, `verify.ts`'s misconfiguration,
-- `review.ts`'s review-retry-cap, `packages/control/src/stop.ts`'s operator cancel) and nothing
-- moved a task out before this. `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration
-- transaction, which Postgres 12+ permits as long as the new value is not USED in the same
-- transaction -- nothing below uses it. `IF NOT EXISTS` makes re-running this a no-op.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'task.unblocked';
