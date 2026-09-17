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

/**
 * Which column (or constraint name) a P2002 collided on, read out of a Prisma error's `meta`.
 *
 * `syncPersonPool` (Catalog Person Pool Task 2) is the first caller with TWO unique constraints a
 * single `Person.create` can hit -- the slot pair and the global name -- and it has to tell them
 * apart to know whether to re-read a slot another process just won or retry with a different name.
 * Every existing caller of {@link isUniqueConstraintViolation} has exactly one constraint in play
 * and never needed this.
 *
 * `meta`'s SHAPE is not part of Prisma's stable contract, and differs by more than engine
 * version: this project's client (`packages/db/src/client.ts`) is wired through
 * `@prisma/adapter-pg`, and a driver-adapter client's `meta` carries no top-level `target` at all
 * -- Postgres's own error surfaces instead, nested at
 * `meta.driverAdapterError.cause.constraint.fields`, confirmed against a real P2002 from this
 * exact client (Task 2 self-review) rather than assumed from documentation. Each field there is
 * the raw, double-quote-wrapped SQL identifier (`'"templateId"'`) for a multi-column constraint,
 * but plain (`'name'`) for a single-column one -- Postgres quotes an identifier in its error text
 * only where two or more appear together, so this strips quote characters rather than relying on
 * either form.
 *
 * A non-adapter client's classic `meta.target` (an array of column names, or a constraint name as
 * one string) is read too, and preferred first when both happen to be present, so this keeps
 * working if the client is ever reconfigured without an adapter. Either shape, once read, is
 * returned as a plain array and the caller matches on a SUBSTRING (`poolSlot`, `name`) rather
 * than an exact column list, which is true of every shape above alike.
 */
export function uniqueConstraintTarget(error: unknown): readonly string[] {
  if (typeof error !== 'object' || error === null || !('meta' in error)) return []
  const meta = (error as { meta?: unknown }).meta
  if (typeof meta !== 'object' || meta === null) return []

  const target = readTargetField(meta)
  return target.length > 0 ? target : readDriverAdapterConstraintFields(meta)
}

/** The classic, non-adapter shape: `meta.target`, either a column-name array or one constraint-name string. */
function readTargetField(meta: object): string[] {
  if (!('target' in meta)) return []
  const target = (meta as { target?: unknown }).target
  if (Array.isArray(target)) return target.filter((column): column is string => typeof column === 'string')
  return typeof target === 'string' ? [target] : []
}

/** The `@prisma/adapter-pg` shape: `meta.driverAdapterError.cause.constraint.fields`, with any
 *  SQL-identifier quoting Postgres added to a multi-column constraint's field names stripped. */
function readDriverAdapterConstraintFields(meta: object): string[] {
  if (!('driverAdapterError' in meta)) return []
  const driverAdapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError
  if (typeof driverAdapterError !== 'object' || driverAdapterError === null || !('cause' in driverAdapterError)) return []
  const cause = (driverAdapterError as { cause?: unknown }).cause
  if (typeof cause !== 'object' || cause === null || !('constraint' in cause)) return []
  const constraint = (cause as { constraint?: unknown }).constraint
  if (typeof constraint !== 'object' || constraint === null || !('fields' in constraint)) return []
  const fields = (constraint as { fields?: unknown }).fields
  if (!Array.isArray(fields)) return []
  return fields.filter((field): field is string => typeof field === 'string').map((field) => field.replaceAll('"', ''))
}
