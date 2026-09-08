-- M36 t2: a slave that cannot continue asks another one and waits, without failing.
--
-- Two new enum members, no new table and no new column: the run parks in the `paused` status that
-- already exists (the one status the orphan sweep leaves alone, and the one `requestResume`/
-- `claimResume`/`executeResume` already act on), and the TASK gets a status of its own.
--
-- `TaskStatus.waiting` is deliberately NOT `blocked`: since M35 `blocked` means "a human must look
-- at this" and is left only through `unblock-task`, while this state resolves by itself when the
-- answer arrives. `decide.ts`'s `STARTABLE` never included it, so no task in it can be handed to a
-- second slave while the asking run still holds the worktree.
--
-- `PauseReason.waiting_for_answer` is the run-side half: `SlaveRun.pauseReason` is the pause's
-- CATEGORY (human / guardrail / emergency_stop until now), and a run waiting on a peer is none of
-- those. It is what keeps a waiting run out of the operator surfaces that present a paused run as
-- something a human has to resume.
--
-- `ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+ permits so long
-- as the new value is not USED in the same transaction -- nothing below uses either. `IF NOT
-- EXISTS` follows the precedent of 20260829120000_m13_settings_changed_event.
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'waiting';

ALTER TYPE "PauseReason" ADD VALUE IF NOT EXISTS 'waiting_for_answer';
