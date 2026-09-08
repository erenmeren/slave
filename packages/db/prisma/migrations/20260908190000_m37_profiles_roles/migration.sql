-- M37 t1: persona profiles and the runtime role set (spec §2, errata E2).
--
-- `profile` on the three levels of the override chain (`SlaveTemplate`, `CompanySlave`, `Slave`)
-- -- Markdown persona text, mirroring `model`'s existing three-level chain. Every existing row
-- reads back null; nothing writes it before Task 4's control verbs land.
ALTER TABLE "SlaveTemplate" ADD COLUMN "profile" TEXT;
ALTER TABLE "CompanySlave" ADD COLUMN "profile" TEXT;
ALTER TABLE "Slave" ADD COLUMN "profile" TEXT;

-- `runtimeRoles`: the roles a slave may be DISPATCHED as (scheduler match, review/manager
-- staffing, message role-addressing -- Task 3 moves those readers onto it). `Slave.role` stops
-- being that column and becomes display/persona only. Added NOT NULL with an empty-array default
-- so the backfill below can set every existing row before anything reads this column. Unlike
-- `Workspace.verifyCommands`/`setupCommands` (20260818202734), the default is KEPT rather than
-- dropped: `schema.prisma` declares `@default([])` for this field (an empty runtime role set is
-- a legitimate, if undispatchable, state -- not a refusal the way an empty `verifyCommands` is),
-- so every `slave.create()` call across the codebase that predates this task (and does not yet
-- know to pass `runtimeRoles`) keeps compiling and keeps inserting a real (empty) array rather
-- than hitting this column's NOT NULL constraint.
ALTER TABLE "Slave" ADD COLUMN "runtimeRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill (spec §2): every existing worker keeps dispatching exactly as it did before this
-- migration. `role` always goes in; `requiredRole` joins it only when set AND different from
-- `role` -- the ordinary case (`requiredRole` null, or equal to `role`) needs no second entry,
-- and the M33 adoption case (a `lead` materialized with `role = 'lead'`, `requiredRole =
-- 'manager'` so the pre-M37 scheduler could still find a manager) keeps BOTH, so neither the
-- scheduler nor the review/planning staffing pass loses a candidate it had before Task 3 switches
-- them onto this column. Evidence: two throwaway rows seeded by hand before this migration ran
-- (`role='lead', requiredRole='manager'` and `role='qa', requiredRole=NULL`) read back
-- `runtimeRoles = {lead,manager}` and `{qa}` respectively -- pasted into the M37 Task 1 report.
UPDATE "Slave"
SET "runtimeRoles" = CASE
  WHEN "requiredRole" IS NOT NULL AND "requiredRole" <> "role" THEN ARRAY["role", "requiredRole"]
  ELSE ARRAY["role"]
END;

-- `requiredRole`'s last reader (M33 adoption, #27980's dispatch gap) is the backfill above; Task
-- 3 moves the scheduler/staffing readers onto `runtimeRoles` in the same milestone, so the column
-- is dropped here rather than left to rot for a task that no longer needs it.
ALTER TABLE "Slave" DROP COLUMN "requiredRole";
