-- M58: a slave is a PERSON, and a project seat is where they sit.
--
-- ONE migration, IRREVERSIBLE, with a backfill written for a FULL database even though the
-- operator's is empty today (spec R8). Four tables, one enum, two columns, one backfill in seven
-- statements, then the drops. Nothing here can be undone: `CompanySlave`, `SlaveSkill` and eight
-- `Slave`/`Memory` columns are gone by the last line.
--
-- The backfill's rules, each named where it happens below:
--   1. one "Person" per existing "Slave"; a name two slaves share becomes "<name> (<project>)";
--   2. a "CompanySlave" NOBODY MATERIALISED becomes a person with no seat -- the pool. A roster row
--      that WAS materialised contributes its department membership to the persons its copies became,
--      and does not become a third person (see the plan's pre-flight note 2);
--   3. every remaining collision is resolved by the same " 2", " 3" suffix `uniquePersonName`
--      already uses, because "Person"."name" is UNIQUE and a migration may not fail on data that
--      was legal before it;
--   4. "SlaveSkill" becomes "PersonSkill" with mode 'granted' -- the persona default set starts
--      empty, so every skill somebody actually assigned survives as an explicit grant;
--   5. "Memory"."slaveId" becomes "personId";
--   6. a PENDING "SupervisorDecision" whose action is a `materialise_company_worker` has its
--      payload's "companySlaveId" swapped for the "personId" that roster row became, so a proposal
--      an operator has not answered yet still parses after the upgrade.
--
-- `gen_random_uuid()` is in pg_catalog from PostgreSQL 13 -- no extension, and the same TEXT uuid
-- shape Prisma's own `@default(uuid())` writes.

CREATE TYPE "SkillGrantMode" AS ENUM ('granted', 'revoked');

CREATE TABLE "Person" (
  "id"                 TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "templateId"         TEXT,
  "profile"            TEXT,
  "model"              TEXT,
  "provider"           "ProviderKind",
  "capabilities"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lifecycle"          "SlaveLifecycle" NOT NULL DEFAULT 'project',
  "releasedAt"         TIMESTAMP(3),
  "releaseReason"      TEXT,
  "selectionRationale" TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Person_name_key" ON "Person"("name");
CREATE INDEX "Person_templateId_idx" ON "Person"("templateId");
ALTER TABLE "Person" ADD CONSTRAINT "Person_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "SlaveTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PersonSkill" (
  "personId" TEXT NOT NULL,
  "skillId"  TEXT NOT NULL,
  "mode"     "SkillGrantMode" NOT NULL,
  CONSTRAINT "PersonSkill_pkey" PRIMARY KEY ("personId", "skillId")
);
CREATE INDEX "PersonSkill_skillId_idx" ON "PersonSkill"("skillId");
ALTER TABLE "PersonSkill" ADD CONSTRAINT "PersonSkill_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonSkill" ADD CONSTRAINT "PersonSkill_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TemplateSkill" (
  "templateId" TEXT NOT NULL,
  "skillId"    TEXT NOT NULL,
  CONSTRAINT "TemplateSkill_pkey" PRIMARY KEY ("templateId", "skillId")
);
CREATE INDEX "TemplateSkill_skillId_idx" ON "TemplateSkill"("skillId");
ALTER TABLE "TemplateSkill" ADD CONSTRAINT "TemplateSkill_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "SlaveTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TemplateSkill" ADD CONSTRAINT "TemplateSkill_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CompanyTeamMember" (
  "companyTeamId" TEXT NOT NULL,
  "personId"      TEXT NOT NULL,
  CONSTRAINT "CompanyTeamMember_pkey" PRIMARY KEY ("companyTeamId", "personId")
);
CREATE INDEX "CompanyTeamMember_personId_idx" ON "CompanyTeamMember"("personId");
ALTER TABLE "CompanyTeamMember" ADD CONSTRAINT "CompanyTeamMember_companyTeamId_fkey"
  FOREIGN KEY ("companyTeamId") REFERENCES "CompanyTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyTeamMember" ADD CONSTRAINT "CompanyTeamMember_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Slave"  ADD COLUMN "personId" TEXT;
ALTER TABLE "Slave"  ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "Memory" ADD COLUMN "personId" TEXT;

-- ------------------------------------------------------------------------------------------------
-- BACKFILL. Seven data statements, each numbered, each named in the header above.
-- ------------------------------------------------------------------------------------------------

-- The seed table: every person this migration is about to create, with the row it came from and the
-- name it WANTS, before de-duplication. Dropped at the end of this file.
CREATE TABLE "_m58_person_seed" (
  "personId"       TEXT PRIMARY KEY,
  "slaveId"        TEXT UNIQUE,
  "companySlaveId" TEXT UNIQUE,
  "wanted"         TEXT NOT NULL,
  "name"           TEXT
);

-- DATA 1 of 7 (rule 1). One row per existing seat. A name two slaves share anywhere in the
-- installation gains its project in parentheses -- which is the only fact that tells two "Atlas"es
-- apart at the moment of the upgrade.
INSERT INTO "_m58_person_seed" ("personId", "slaveId", "companySlaveId", "wanted")
SELECT gen_random_uuid()::text,
       s.id,
       NULL,
       CASE WHEN COUNT(*) OVER (PARTITION BY s."name") > 1
            THEN s."name" || ' (' || w."name" || ')'
            ELSE s."name" END
  FROM "Slave" s
  JOIN "Team" t ON t.id = s."teamId"
  JOIN "Workspace" w ON w.id = t."workspaceId";

-- DATA 2 of 7 (rule 2). A roster row no project ever materialised is a person with no seat: the
-- pool. One that WAS materialised is already represented by DATA 1's rows and gets no person of its
-- own -- it gets a department membership in DATA 4.
INSERT INTO "_m58_person_seed" ("personId", "slaveId", "companySlaveId", "wanted")
SELECT gen_random_uuid()::text, NULL, cs.id, cs."name"
  FROM "CompanySlave" cs
 WHERE NOT EXISTS (SELECT 1 FROM "Slave" s WHERE s."companySlaveId" = cs.id);

-- DATA 3 of 7 (rule 3). ONE de-duplication over the whole seed. `("slaveId" IS NULL)` sorts seats
-- FIRST, so a person who is actually working keeps the plain name and an unstaffed roster row is
-- the one that gains the suffix.
UPDATE "_m58_person_seed" seed
   SET "name" = CASE WHEN r.rn = 1 THEN seed."wanted" ELSE seed."wanted" || ' ' || r.rn::text END
  FROM (
    SELECT "personId",
           ROW_NUMBER() OVER (PARTITION BY "wanted" ORDER BY ("slaveId" IS NULL), "personId") AS rn
      FROM "_m58_person_seed"
  ) r
 WHERE r."personId" = seed."personId";

-- The persons themselves. A seat-born person inherits the seat's facts and, where the seat had a
-- roster row, that roster row's model/provider/profile -- which is exactly the middle rung of the
-- old chain moving to the middle rung of the new one. A roster-born person inherits the roster row.
INSERT INTO "Person" ("id","name","templateId","profile","model","provider","capabilities",
                      "lifecycle","releasedAt","releaseReason","selectionRationale","createdAt")
SELECT seed."personId",
       seed."name",
       COALESCE(s."hiredFromTemplateId", cs."templateId", rcs."templateId"),
       COALESCE(cs."profile",  rcs."profile"),
       COALESCE(cs."model",    rcs."model"),
       COALESCE(cs."provider", rcs."provider"),
       COALESCE(s."capabilities", ARRAY[]::TEXT[]),
       COALESCE(s."lifecycle", 'permanent'::"SlaveLifecycle"),
       s."releasedAt",
       s."releaseReason",
       s."selectionRationale",
       COALESCE(s."createdAt", CURRENT_TIMESTAMP)
  FROM "_m58_person_seed" seed
  LEFT JOIN "Slave" s          ON s.id  = seed."slaveId"
  LEFT JOIN "CompanySlave" cs  ON cs.id = s."companySlaveId"
  LEFT JOIN "CompanySlave" rcs ON rcs.id = seed."companySlaveId";

-- DATA 4 of 7. Every seat now names its person, and every roster link becomes a department
-- membership -- for the seat-born persons here, and for the pool-born ones in the second statement.
UPDATE "Slave" s SET "personId" = seed."personId"
  FROM "_m58_person_seed" seed WHERE seed."slaveId" = s.id;

INSERT INTO "CompanyTeamMember" ("companyTeamId", "personId")
SELECT DISTINCT cs."companyTeamId", s."personId"
  FROM "Slave" s JOIN "CompanySlave" cs ON cs.id = s."companySlaveId"
 WHERE s."personId" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "CompanyTeamMember" ("companyTeamId", "personId")
SELECT cs."companyTeamId", seed."personId"
  FROM "_m58_person_seed" seed JOIN "CompanySlave" cs ON cs.id = seed."companySlaveId"
ON CONFLICT DO NOTHING;

-- DATA 5 of 7 (rule 4). A skill somebody assigned to a worker becomes an explicit GRANT on the
-- person. `TemplateSkill` starts empty on purpose: nothing before this milestone recorded a
-- persona's default skills, so inventing one from the assignments would put words in an operator's
-- mouth about people they never touched.
INSERT INTO "PersonSkill" ("personId", "skillId", "mode")
SELECT DISTINCT s."personId", ss."skillId", 'granted'::"SkillGrantMode"
  FROM "SlaveSkill" ss JOIN "Slave" s ON s.id = ss."slaveId"
 WHERE s."personId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- DATA 6 of 7 (rule 5). What a worker learnt is what the person knows -- on every project they are
-- ever seated on, which is D2 in one statement.
UPDATE "Memory" m SET "personId" = s."personId"
  FROM "Slave" s WHERE s.id = m."slaveId";

-- DATA 7 of 7 (rule 6). A proposal an operator has not answered yet must still parse. The action's
-- `companySlaveId` names a roster row; the person it became is either the pool person seeded from
-- it, or -- if it had already been materialised -- the person of its first materialised seat.
UPDATE "SupervisorDecision" d
   SET "action" = (d."action" - 'companySlaveId') || jsonb_build_object('personId', mapped."personId")
  FROM (
    SELECT cs.id AS company_slave_id,
           COALESCE(
             (SELECT seed."personId" FROM "_m58_person_seed" seed WHERE seed."companySlaveId" = cs.id),
             (SELECT s."personId" FROM "Slave" s WHERE s."companySlaveId" = cs.id ORDER BY s.id LIMIT 1)
           ) AS "personId"
      FROM "CompanySlave" cs
  ) mapped
 WHERE d."status" = 'pending'
   AND d."action" ->> 'kind' = 'materialise_company_worker'
   AND d."action" ->> 'companySlaveId' = mapped.company_slave_id
   AND mapped."personId" IS NOT NULL;

DROP TABLE "_m58_person_seed";

-- ------------------------------------------------------------------------------------------------
-- The new shape becomes the ONLY shape.
-- ------------------------------------------------------------------------------------------------

ALTER TABLE "Slave" ALTER COLUMN "personId" SET NOT NULL;
ALTER TABLE "Slave" ADD CONSTRAINT "Slave_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Slave_personId_teamId_key" ON "Slave"("personId", "teamId");
CREATE INDEX "Slave_personId_idx" ON "Slave"("personId");

ALTER TABLE "Memory" ADD CONSTRAINT "Memory_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Memory_personId_status_type_createdAt_idx"
  ON "Memory"("personId", "status", "type", "createdAt");
DROP INDEX "Memory_slaveId_status_type_createdAt_idx";
ALTER TABLE "Memory" DROP COLUMN "slaveId";

DROP TABLE "SlaveSkill";

ALTER TABLE "Slave" DROP COLUMN "name";
ALTER TABLE "Slave" DROP COLUMN "capabilities";
ALTER TABLE "Slave" DROP COLUMN "hiredFromTemplateId";
ALTER TABLE "Slave" DROP COLUMN "companySlaveId";
ALTER TABLE "Slave" DROP COLUMN "lifecycle";
ALTER TABLE "Slave" DROP COLUMN "releasedAt";
ALTER TABLE "Slave" DROP COLUMN "releaseReason";
ALTER TABLE "Slave" DROP COLUMN "selectionRationale";

DROP TABLE "CompanySlave";
