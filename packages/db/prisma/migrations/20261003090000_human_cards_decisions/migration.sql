-- Human-cards spec H2, plan B (2026-10-03): a card carries a person's decision.
--
-- `SupervisorDecision.personDecision` is what a person decided on a question card (give a package
-- work, give a file, record a shared decision, change a requirement, write an answer, dismiss),
-- validated at read by `personDecisionSchema`; the goal report lists it. Null on every card a
-- person approved or rejected the old way, and on every machine card.
--
-- `WorkPackage.releasedPaths` is the literal paths a person gave from this package to another while
-- it owned them by a glob (plan B D5): its ownership rule excludes them, so the gate and the diff
-- audit enforce the move with no change to the hook plane.
--
-- PURELY ADDITIVE: one nullable column, one defaulted column.

ALTER TABLE "SupervisorDecision" ADD COLUMN "personDecision" JSONB;
ALTER TABLE "WorkPackage" ADD COLUMN "releasedPaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
