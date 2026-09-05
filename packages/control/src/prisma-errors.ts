/**
 * `true` for Prisma's unique-constraint violation (P2002), the error every `create` below can
 * throw when it collides with a `@unique`/`@@unique` index. Checked by shape rather than
 * `instanceof PrismaClientKnownRequestError` -- the class is a runtime value the generated client
 * does not currently re-export from `@slave-of-ai/db/client` -- and caught rather than
 * pre-queried: a pre-query-then-insert has a race between the two steps that the DB constraint
 * itself cannot have.
 *
 * One definition site (M17 census rule): `org.ts` and `workspace.ts` both import this rather than
 * each carrying their own copy.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}
