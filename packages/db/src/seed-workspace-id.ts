/**
 * The legacy seeded workspace's fixed id (`seed.ts`'s `Workspace.create({ id: SEED_WORKSPACE_ID
 * })`). Lives in its own module, importing nothing, so the Analytics page (M14 Task 7) can
 * recognize the seeded workspace for the "Last 7 days · seeded development data" caption (spec
 * Decision 3) without duplicating the literal.
 *
 * Deliberately NOT declared in `seed.ts` and re-exported from there: `seed.ts` value-imports
 * `./client.js`, which constructs the real `PrismaClient` at module scope. `apps/web`'s client
 * components import bare `@slave-of-ai/db` (`components/activity/FilterBar.tsx`,
 * `hooks/useUrlFilters.ts`) for its enum tables; if the barrel re-exported `seed.ts`, that value
 * import would ride along into their browser bundle. This module has no such import, so the
 * barrel can re-export it safely.
 */
export const SEED_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
