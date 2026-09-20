-- F, talking to the Supervisor (2026-09-20): the situation kind every action a REPLY proposes is
-- recorded under (spec R3). One enum member, nothing else -- the decision row it lands on
-- (`SupervisorDecision`) already exists, and its `subjectId` carries the message id.
-- PURELY ADDITIVE: no existing row has this value, and every current row reads back unchanged.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- allows so long as the new value is not USED in the same transaction. Nothing here uses it.
-- `IF NOT EXISTS` for the `20260908130000_m35_task_unblocked_event` precedent: a database that a
-- developer widened by hand must not fail the migration that makes it official.
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'operator_request';
