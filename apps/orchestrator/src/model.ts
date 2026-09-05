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
 * Re-exported from here rather than repointing `tick.ts`, `planning.ts` and `review.ts`, so the
 * three dispatch sites keep naming the orchestrator's own module for the orchestrator's own
 * concern. The definitions moved; nothing about them changed.
 *
 * NO TEST reaches the chain through this file, and that is deliberate as of fix round F2. It used
 * to: `resolve-runtime.test.ts` imported `../src/model.js`, which after the move chained through
 * this re-export into `@slave-of-ai/control`'s COMPILED `dist/` -- `vitest.config.ts` declares no
 * workspace aliases -- so the only coverage of Decision 5's "no mixed pair is constructible"
 * guarantee ran against the previous build. Both test files followed the functions into
 * `packages/control/test/`, where they import the source directly. If a future task adds a test
 * for `resolveRuntime`, it belongs there and not here.
 */
export { resolveRuntime, workspaceDefaultProvider, type ResolvedRuntime } from '@slave-of-ai/control'
