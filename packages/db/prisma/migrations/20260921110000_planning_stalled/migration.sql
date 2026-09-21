-- H4a, planning that cannot start is a situation the Supervisor resolves (2026-09-21).
--
-- TWO enum values and nothing else. PURELY ADDITIVE: no existing row can carry either, and every
-- current row reads back unchanged.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- allows so long as the new value is not USED in the same transaction. Nothing here uses either.
-- `IF NOT EXISTS` for the `20260908130000_m35_task_unblocked_event` precedent: a database a
-- developer widened by hand must not fail the migration that makes it official.

-- The situation. `no_planner` is RETIRED rather than dropped -- `observe` stops emitting it and
-- this one covers all three ways planning can be impossible (no runtime, no planner, cap spent) --
-- and the old value stays in the type for ever, because decision rows already carry it and a
-- Postgres enum value is never taken away.
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'planning_stalled';

-- The event `retry_planning` writes: the planning retry cap, counted from zero again for one goal
-- version. `dispatchPlanning` counts its failures from the latest `workspace.goal_set` OR this row,
-- whichever is later (H4b wires that half).
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.planning_reset';
