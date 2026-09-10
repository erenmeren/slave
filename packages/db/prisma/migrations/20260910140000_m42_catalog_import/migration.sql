-- M42 t2: provenance on a template (spec R1, erratum E2) and the record of an import run (R5).
-- Additive, no backfill: every existing template is hand-made, which is exactly what a NULL
-- `sourceId` means.

ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceId" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceSha256" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceDivision" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "profileSha256" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "importedAt" TIMESTAMP(3);

-- Postgres does not count NULLs as equal, so this constrains imported rows and leaves every
-- hand-made one alone. It is what makes a re-import find the row it wrote last time.
CREATE UNIQUE INDEX "SlaveTemplate_sourceId_key" ON "SlaveTemplate"("sourceId");

CREATE TABLE "CatalogImport" (
    "id" TEXT NOT NULL,
    "catalog" TEXT NOT NULL,
    "directory" TEXT NOT NULL,
    "by" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "created" INTEGER NOT NULL,
    "updated" INTEGER NOT NULL,
    "unchanged" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "report" JSONB NOT NULL,

    CONSTRAINT "CatalogImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogImport_startedAt_idx" ON "CatalogImport"("startedAt");
