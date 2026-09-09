-- M38 erratum E6: whether a model call was actually made for this decision.
--
-- `decidedBy` cannot answer that question: a call that came back unusable (failed, isolation
-- breach, or an answer that would not parse) falls back to the rules, so the row says
-- `decidedBy: 'rules'` while the money was still spent. Every existing row predates any such call
-- being distinguishable, so `false` is the honest backfill -- the rows written before this
-- migration were charged (or not) on the old rule and are not restated here.
ALTER TABLE "SupervisorDecision" ADD COLUMN "modelCalled" BOOLEAN NOT NULL DEFAULT false;
