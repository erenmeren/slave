/**
 * The artifact route's tail-read bound (M23 C2). Lives here, not as an export on the route file
 * itself -- Next.js's route type-checking (`next build`) rejects any route export beyond the HTTP
 * verbs and its handful of known config fields (`dynamic`, `revalidate`, ...), so a plain
 * `export const` for a shared constant fails the build even though `vitest` runs it fine.
 */
export const ARTIFACT_READ_LIMIT = 256 * 1024
