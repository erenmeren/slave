-- Conductor Plan 3 (spec R4), 2026-09-28: a package worker touches only its own files.
--
-- The permission gate denies a write outside a package's ownership, but a shell can write
-- anywhere, so the files a package run's branch changed are audited before it is verified. A
-- violation sends the task back and is recorded as `task.ownership_violated`; the Supervisor's
-- `foreign_file` situation (wired in Task 5) stores its decisions under that kind. PURELY
-- ADDITIVE: two enum values, unused inside this migration's transaction (which Postgres 12+
-- requires of `ADD VALUE`).

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'task.ownership_violated';
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'foreign_file';
