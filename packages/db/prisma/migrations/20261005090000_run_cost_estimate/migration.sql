-- Live cost estimate (2026-10-05): the runtime reports what a session cost when it ends -- for a
-- lead, when a TURN ends, and a turn can run for an hour with every helper inside it. Until then
-- a person watching sees nothing spent.
--
-- `SlaveRun.costEstimate` holds about what the run has cost so far, built by the pump from the
-- usage each assistant message carries on the stream, each message counted once by its id:
-- `{ usd, own, byCall, messages, unpricedMessages, models, unpriced }` (validated at read by
-- `parseRunCostEstimate`). `byCall` is each helper's part, by the id of the call that started it.
-- It stays on the row after the run ends. It is an ESTIMATE: `costUsd` is never written from it,
-- and no guardrail, budget or limit reads it.
--
-- PURELY ADDITIVE: one nullable column. No existing row changes.

ALTER TABLE "SlaveRun" ADD COLUMN "costEstimate" JSONB;
