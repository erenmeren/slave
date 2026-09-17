-- Catalog Person Pool: managed-pool slot identity for Person.
--
-- A "managed person" is one of exactly three people per active SlaveTemplate (slots 1, 2, 3).
-- Ordinary unmanaged people keep poolSlot = NULL and are not affected.
--
-- Constraints:
--   1. poolSlot, when non-null, is restricted to the values 1, 2, or 3.
--   2. a non-null poolSlot requires a non-null templateId (a managed person must belong to a
--      template; a person without a template cannot be a pool member).
--   3. the pair (templateId, poolSlot) is unique: at most one managed person per slot per template.

ALTER TABLE "Person" ADD COLUMN "poolSlot" INTEGER;

-- Restrict non-null poolSlot to the three valid values.
ALTER TABLE "Person"
  ADD CONSTRAINT "Person_poolSlot_range_check"
  CHECK ("poolSlot" IS NULL OR "poolSlot" IN (1, 2, 3));

-- A managed slot requires a template.
ALTER TABLE "Person"
  ADD CONSTRAINT "Person_poolSlot_requires_templateId"
  CHECK ("poolSlot" IS NULL OR "templateId" IS NOT NULL);

-- Unique slot per template (the index must cover NULLs correctly: Postgres partial unique index
-- excludes NULL-NULL rows, but the @@unique directive in Prisma generates the plain unique
-- constraint which ignores rows where either column is NULL -- correct for our invariant).
CREATE UNIQUE INDEX "Person_templateId_poolSlot_key" ON "Person"("templateId", "poolSlot");
