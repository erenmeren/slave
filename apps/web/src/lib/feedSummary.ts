/** Moved to `@slave-of-ai/domain` (`packages/domain/src/feed/feedSummary.ts`) -- see
 *  `./happening.ts` for why. Re-exported under the names this path has always exported, so the
 *  hook (`hooks/useOverview.ts`) and the loader (`server/overview.ts`) both keep resolving. */
export { feedSummary, type SlaveFeedEvent } from '@slave-of-ai/domain'
