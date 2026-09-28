-- Conductor Plan 2, final review I5, 2026-09-28: the Supervisor's `package_seat_lost` situation.
--
-- A package task is pinned to the seat it was staffed with and the scheduler hands it to nobody
-- else, so a pinned seat that was closed, released or stripped of the package role left the task
-- stuck in silence -- and the board busy, so the next goal version waited forever. The Supervisor
-- now raises it, and its decisions are stored under this kind. PURELY ADDITIVE: one enum value,
-- unused inside this migration's transaction (which Postgres 12+ requires of `ADD VALUE`).

ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'package_seat_lost';
