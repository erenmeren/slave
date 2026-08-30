-- M14 Decision 6: the catalog never deletes. A skill that disappears from disk is stamped here,
-- so history that referenced it keeps a row to point at. Cleared when a later scan finds it.
ALTER TABLE "Skill" ADD COLUMN "missingSince" TIMESTAMP(3);
