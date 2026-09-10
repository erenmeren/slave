-- M45 R3: a goal version may record the request that produced it (spec §1 R3).

-- Additive and nullable, with no backfill. Null means "this version was written as a whole goal,
-- not asked for as a change" -- which is true of every row that exists today, so inventing a
-- request for them would be inventing a sentence nobody said.
ALTER TABLE "GoalVersion" ADD COLUMN "request" TEXT;
