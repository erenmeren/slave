-- M14 §4.2: the run's token usage as its runtime reported it. Nullable with no default -- `null`
-- is "this runtime does not say" (Cursor, and any degraded Claude result line), and `0` would be
-- a measured zero the Analytics page would average in.
ALTER TABLE "AgentRun" ADD COLUMN "tokensIn" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "tokensOut" INTEGER;
