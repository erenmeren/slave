/** Moved to `@slave-of-ai/domain` (`packages/domain/src/feed/happening.ts`) for the Supervisor
 *  chat: a chat turn renders the feed and is assembled in `packages/control`, which cannot import
 *  this app. Re-exported from the path every component, loader and test already imports it by
 *  (`docs/ia.md` rule 2), exactly as `providerLabel.ts` re-exports the provider vocabulary. */
export { HAPPENING_TYPES, happeningSentence, type HappeningNames } from '@slave-of-ai/domain'
