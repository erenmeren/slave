-- M14 §4.1: which skills a run invoked, and how many times each. Nullable with no default:
-- `null` is UNMEASURED (a Cursor run, or a run that never concluded), `{}` is the measured
-- "this run invoked no skill". A default of `{}` would have made those two indistinguishable.
ALTER TABLE "AgentRun" ADD COLUMN "skillCalls" JSONB;
