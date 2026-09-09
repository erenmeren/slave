-- M37 t3: the two events the profile and runtime-role verbs write
-- (`packages/control/src/profile.ts`). `slave.profile_changed` records a persona write -- for a
-- SLAVE target only (spec erratum E3): the template and catalog-slave levels of the same override
-- chain belong to the company catalog, which has no workspace and so no event stream to append to.
-- `slave.runtime_roles_changed` records a change to the set the scheduler, the review/planning
-- staffing queries and message role-addressing now all match on.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- permits as long as the new value is not USED in the same transaction -- nothing below uses
-- either. `IF NOT EXISTS` makes re-running this a no-op. (Same shape as
-- `20260908130000_m35_task_unblocked_event`.)
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'slave.profile_changed';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'slave.runtime_roles_changed';
