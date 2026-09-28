-- Conductor Plan 1 (spec R0), 2026-09-27: a live-but-silent run is visible to the sweep.
--
-- Large-1 multi rep 2: a worker's stream stopped mid-answer and nothing ended the run for 32
-- minutes. The pump now records when the stream last produced an event (`lastOutputAt`, written at
-- most every OUTPUT_BEAT_MS) and since when a tool call has been open (`toolCallOpenSince`, null
-- when none is), so the sweep can tell a stalled stream from a long shell command. PURELY ADDITIVE:
-- both null on every existing row, which the sweep reads as "measure from startedAt".
ALTER TABLE "SlaveRun" ADD COLUMN "lastOutputAt" TIMESTAMP(3);
ALTER TABLE "SlaveRun" ADD COLUMN "toolCallOpenSince" TIMESTAMP(3);
