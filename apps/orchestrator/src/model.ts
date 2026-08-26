/**
 * The runtime-resolution chain, re-exported.
 *
 * `resolveRuntime` and `workspaceDefaultProvider` were defined here when Task 8 wrote them, and
 * MOVED to `packages/control/src/runtime.ts` at Task 9 (spec §6's write-time admission). The
 * reason is structural, not stylistic: Task 9 has to answer "which runtime will this worker
 * actually run on?" at TWO moments, and `packages/control`'s `assignCompany` -- one of them -- can
 * never import from `apps/orchestrator`. The only alternatives were a second copy of the override
 * chain and a second copy of the "exactly one ProviderConfiguration row is a default" rule, in the
 * package whose whole job is refusing bad configurations. Two copies of a resolution rule that
 * agree today are two copies that disagree after the first edit, and the disagreement would be
 * invisible: the write surface would admit a configuration dispatch then refuses.
 *
 * Re-exported from here rather than repointing every import, so `tick.ts`, `planning.ts`,
 * `review.ts` and the existing tests keep naming the orchestrator's own module for the
 * orchestrator's own concern. The definitions moved; nothing about them changed.
 */
export { resolveRuntime, workspaceDefaultProvider, type ResolvedRuntime } from '@ai-team-os/control'
