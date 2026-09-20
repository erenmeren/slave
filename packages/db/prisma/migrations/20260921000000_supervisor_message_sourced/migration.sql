-- F, talking to the Supervisor (2026-09-21, task 4 fix round 1): the chip a sourced reply wears,
-- and the index the claim actually scans. PURELY ADDITIVE: one column with a default and one
-- index. Every existing row reads back unchanged, and every existing row is `false` -- which is
-- true of it: no reply written before this column had its citations checked against anything.

-- R2: "the panel marks sourced replies with the same sourced chip the answer path uses". That
-- verdict is `verifySources` + `isSourced` over EXACTLY what this turn's prompt rendered
-- (`renderedChatSources`), and it cannot be re-derived later -- the feed window has moved on and
-- the attachment slices are gone. So it is stored at settle time, beside the money, like every
-- other fact about a turn that only the turn knew.
ALTER TABLE "SupervisorMessage" ADD COLUMN "sourced" BOOLEAN NOT NULL DEFAULT false;

-- What `claimSupervisorTurns` really scans: `status = 'answering' AND (claimedAt IS NULL OR
-- claimedAt < <stale>)`, across EVERY workspace -- the pass is global, exactly as `tickIntakes` is.
-- The existing `("workspaceId", "status")` index cannot serve that predicate, so every pass was a
-- sequential scan of the whole conversation table however few turns were waiting.
CREATE INDEX "SupervisorMessage_status_claimedAt_idx" ON "SupervisorMessage"("status", "claimedAt");
