-- Skeleton spec S3 (plan A D5), 2026-09-30: shared registration points are file-per-package.
--
-- A package that adds files to an ordered shared directory (migrations, routes, jobs) declares the
-- directory and its own file-name prefix; the prefix glob is already in `ownedPaths` (what the gate
-- and the diff audit enforce), and this column keeps the declaration itself so the package's
-- contract can say where and how it registers. PURELY ADDITIVE: one column with a default, so every
-- existing package reads as registering nowhere.

ALTER TABLE "WorkPackage" ADD COLUMN "registrations" JSONB NOT NULL DEFAULT '[]';
