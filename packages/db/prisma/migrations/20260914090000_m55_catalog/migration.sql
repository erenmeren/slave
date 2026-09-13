-- M55: the column that decides who is a candidate, four denormalised columns that turn an
-- in-memory filter into a `where`, and the table that says which two rows look alike.
--
-- ADDITIVE, with EXACTLY TWO DATA STATEMENTS, both named below and both one-way-safe. Two enums,
-- one table, seven columns on "SlaveTemplate", three indexes (one unique, two secondary). Nothing
-- is dropped, no column changes type, and every existing row reads back exactly as it did apart
-- from the two updates.
--
-- NO CHECK CONSTRAINT for `"aId" < "bId"`, however much it wants one: M42 erratum E23 makes the
-- proof `prisma migrate diff --from-config-datasource --to-schema ... --config
-- packages/db/prisma.config.ts` -> "No difference detected", and a constraint the Prisma schema
-- cannot express is precisely a difference that proof would report forever. `orderedPair`
-- (`packages/domain/src/catalog/duplicate.ts`) is the single writer every path goes through, and a
-- unit test and `gate:m55-catalog` stage 5 hold it.

CREATE TYPE "DuplicateClass" AS ENUM ('exact', 'near', 'overlapping');
CREATE TYPE "DuplicateBasis" AS ENUM ('content_hash', 'name', 'body_shingles', 'capability_keys');

ALTER TABLE "SlaveTemplate" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SlaveTemplate" ADD COLUMN "activationChangedAt" TIMESTAMP(3);
ALTER TABLE "SlaveTemplate" ADD COLUMN "activationChangedBy" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "contentSha256" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "bodyBands" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SlaveTemplate" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SlaveTemplate" ADD COLUMN "recommendedSkills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "SlaveTemplate_active_name_idx" ON "SlaveTemplate"("active", "name");

-- DATA STATEMENT 1 of 2 (M55 R2). Every row that exists on the day of the upgrade becomes active,
-- because every one of them was already a `loadCatalogEntries` candidate and an operator upgrading
-- must not find their workforce silently emptied. From this migration on, `false` is the default
-- and an import writes it on every row it creates.
UPDATE "SlaveTemplate" SET "active" = true;

-- DATA STATEMENT 2 of 2 (M55 R3, plan erratum E8). A FLOOR, not the value: the real `searchText`
-- joins five `profileSpec` fields through `effectiveProfileSpec`'s merge with `profileOverrides`,
-- and reproducing that merge in SQL would be a second writer for one column -- which R10 forbids in
-- its own words for `capabilityKeys`. This keeps an existing install's search box able to find a row
-- by its name and its blurb the minute the migration lands; `template duplicates --recompute`
-- writes the real value over it, and is also what fills "contentSha256", "bodyBands" and
-- "recommendedSkills", none of which can be derived in SQL at all.
--
-- The FOLD is `normalisePersona`'s own three passes (final wave, minor 10) -- NFC, lower case,
-- every run of whitespace collapsed to one space, then trimmed -- because the QUERY side folds a
-- search box's text with exactly that function. A floor folded any other way is a row that cannot
-- be found by its own name: `lower()` alone leaves the double space in `Gate  Release Steward`
-- standing, and `q` typed with one space would not match it until a recompute. What still differs
-- is which case table each side uses -- `lower()` follows the database collation and `toLowerCase`
-- follows Unicode -- and that difference too is written over by the first `--recompute`.
UPDATE "SlaveTemplate"
   SET "searchText" = btrim(
         regexp_replace(lower(normalize(coalesce("name", '') || ' ' || coalesce("description", ''), NFC)), '\s+', ' ', 'g')
       );

CREATE TABLE "TemplateDuplicate" (
  "id"          TEXT NOT NULL,
  "aId"         TEXT NOT NULL,
  "bId"         TEXT NOT NULL,
  "class"       "DuplicateClass" NOT NULL,
  "basis"       "DuplicateBasis" NOT NULL,
  "score"       DOUBLE PRECISION NOT NULL,
  "detectedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dismissedAt" TIMESTAMP(3),
  "dismissedBy" TEXT,

  CONSTRAINT "TemplateDuplicate_pkey" PRIMARY KEY ("id")
);

-- One row per ORDERED pair. Not a pre-read: a pre-query-then-insert has a race between the two
-- steps that the constraint itself cannot have (`packages/control/src/prisma-errors.ts`'s own
-- reasoning), which is why the writer catches P2002 and updates instead.
CREATE UNIQUE INDEX "TemplateDuplicate_aId_bId_key" ON "TemplateDuplicate"("aId", "bId");
CREATE INDEX "TemplateDuplicate_bId_idx" ON "TemplateDuplicate"("bId");

ALTER TABLE "TemplateDuplicate" ADD CONSTRAINT "TemplateDuplicate_aId_fkey"
  FOREIGN KEY ("aId") REFERENCES "SlaveTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TemplateDuplicate" ADD CONSTRAINT "TemplateDuplicate_bId_fkey"
  FOREIGN KEY ("bId") REFERENCES "SlaveTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
