import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  err,
  goalSha256,
  ok,
  parsePersona,
  personaErrorText,
  personaToTemplate,
  type Result,
} from '@slave-of-ai/domain'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'

export interface CatalogEntry {
  readonly sourceId: string
  readonly division: string
  readonly slug: string
  readonly path: string
  readonly text: string
}

export interface ImportCatalogInput {
  readonly catalog: string
  readonly directory: string
  readonly entries: readonly CatalogEntry[]
  readonly roleMap?: Readonly<Record<string, string>>
  /** Runs the parser AND the policy (which reads the database) and writes nothing at all. */
  readonly dryRun?: boolean
}

export type SkipReason = 'name_taken' | 'locally_edited' | 'profile_too_long' | 'invalid_persona'

export interface RowOutcome {
  readonly sourceId: string
  readonly name: string
  readonly role: string
  readonly templateId: string | null
  /** M42 erratum E10: the `--role-map` said one thing and the stored row says another. Reported,
   *  never written -- a template's role is set once. */
  readonly roleDrift?: { readonly stored: string; readonly mapped: string }
}

export interface SkippedRow {
  readonly sourceId: string
  readonly name: string | null
  readonly reason: SkipReason
  readonly detail: string
}

export interface ImportReport {
  readonly importId: string | null
  readonly dryRun: boolean
  readonly catalog: string
  readonly directory: string
  readonly created: readonly RowOutcome[]
  readonly updated: readonly RowOutcome[]
  readonly unchanged: readonly RowOutcome[]
  readonly skipped: readonly SkippedRow[]
}

/**
 * Thrown by a row's transaction for the one refusal it can only discover AFTER it has attempted a
 * write -- a unique index rejecting the `create` (M34's `AssignmentRefused` idiom, and the ADR
 * behind it). Two things make the throw necessary rather than tidy: a value returned from an
 * interactive `$transaction` callback still COMMITS everything written before it, and a statement
 * that violates a constraint poisons the Postgres transaction, so the callback could not continue
 * even if it wanted to.
 */
class CatalogRowRefused extends Error {
  constructor(readonly row: SkippedRow) {
    super(row.detail)
    this.name = 'CatalogRowRefused'
  }
}

type Outcome =
  | { readonly kind: 'created' | 'updated' | 'unchanged'; readonly row: RowOutcome }
  | { readonly kind: 'skipped'; readonly row: SkippedRow }

/**
 * The ONE place a `--role-map` is trimmed, so the map the policy validates is the map the mapper
 * reads (fix round 1, Important 1).
 *
 * The verb used to validate `division.trim()` and then hand `personaToTemplate` the RAW record, so
 * `--role-map " testing "=" reviewer "` passed the guard and then matched no division at all --
 * and, where it did match, wrote `" reviewer "` as a role with its spaces intact, which is a role
 * no scheduler query would ever match. Trimming at the boundary and passing the normalised map on
 * is `normaliseRoles`' own shape: an operator's typing is cleaned once, at the edge, or it is a
 * different value in every place that reads it.
 *
 * An empty half is refused rather than dropped, and so is a division named twice -- trimming can
 * collide two keys that were distinct as typed (`" a "` and `"a"`), and silently keeping whichever
 * `Object.entries` yielded last is exactly the "part of what the operator typed disappeared"
 * failure the refusal exists to prevent.
 */
function normaliseRoleMap(
  roleMap: Readonly<Record<string, string>> | undefined,
): Result<Readonly<Record<string, string>> | undefined, ControlRefusal> {
  if (roleMap === undefined) return ok(undefined)
  const normalised: Record<string, string> = {}
  for (const [rawDivision, rawRole] of Object.entries(roleMap)) {
    const division = rawDivision.trim()
    const role = rawRole.trim()
    if (division === '') return err({ kind: 'invalid_role_map', detail: 'a division name is empty' })
    if (role === '') return err({ kind: 'invalid_role_map', detail: `the role for "${division}" is empty` })
    if (division in normalised) {
      return err({ kind: 'invalid_role_map', detail: `the division "${division}" is named twice` })
    }
    normalised[division] = role
  }
  return ok(normalised)
}

/**
 * Imports a directory of personas into the template catalog (M42 §2, R2).
 *
 * **One transaction per ROW, never one for the import.** A real catalog is three hundred files; one
 * transaction over all of them would hold locks on the whole catalog table for as long as the
 * parse takes, and -- worse -- would make the whole import all-or-nothing, when the entire point of
 * R2's policy is that a persona nobody can parse is a SKIPPED ROW rather than a crashed import.
 *
 * **Nothing is ever deleted.** A template whose persona has left the directory keeps existing, the
 * `syncSkillCatalog` idiom: the catalog is append-only, workers are materialised from these rows,
 * and an import is not the moment to decide that a file's absence means a team member should
 * vanish.
 *
 * **No events.** `ExecutionEvent.workspaceId` is NOT NULL and a template belongs to no project --
 * the gap `setProfile`'s doc comment names. The `CatalogImport` row IS the record (R5).
 */
export async function importCatalog(
  input: ImportCatalogInput,
  by?: string,
): Promise<Result<ImportReport, ControlRefusal>> {
  if (input.entries.length === 0) return err({ kind: 'catalog_empty', directory: input.directory })
  const roleMap = normaliseRoleMap(input.roleMap)
  if (!roleMap.ok) return roleMap

  const startedAt = new Date()
  const created: RowOutcome[] = []
  const updated: RowOutcome[] = []
  const unchanged: RowOutcome[] = []
  const skipped: SkippedRow[] = []

  for (const entry of input.entries) {
    const outcome = await importRow(entry, input, roleMap.value, startedAt)
    // A `switch` with a `never` default rather than an if/else chain whose last arm is a silent
    // catch-all: a fifth outcome added later must be routed HERE deliberately, and the compiler is
    // what says so -- an `else unchanged.push(...)` would have swallowed it into the wrong bucket.
    switch (outcome.kind) {
      case 'created':
        created.push(outcome.row)
        break
      case 'updated':
        updated.push(outcome.row)
        break
      case 'unchanged':
        unchanged.push(outcome.row)
        break
      case 'skipped':
        skipped.push(outcome.row)
        break
      default: {
        const unreachable: never = outcome
        throw new Error(`unhandled import outcome: ${JSON.stringify(unreachable)}`)
      }
    }
  }

  const report = { created, updated, unchanged, skipped }

  // A dry run changed nothing, so it records nothing: a `CatalogImport` row is the record of an
  // import that HAPPENED, and one that says "0 created" for a run that never intended to create
  // anything would make the list unreadable.
  if (input.dryRun === true) {
    return ok({ importId: null, dryRun: true, catalog: input.catalog, directory: input.directory, ...report })
  }

  const row = await prisma.catalogImport.create({
    data: {
      catalog: input.catalog,
      directory: input.directory,
      by: by ?? null,
      startedAt,
      finishedAt: new Date(),
      created: created.length,
      updated: updated.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
      report: report as unknown as Prisma.InputJsonValue,
    },
  })

  return ok({ importId: row.id, dryRun: false, catalog: input.catalog, directory: input.directory, ...report })
}

/** One persona, decided and written (or not) on its own. */
async function importRow(
  entry: CatalogEntry,
  input: ImportCatalogInput,
  roleMap: Readonly<Record<string, string>> | undefined,
  importedAt: Date,
): Promise<Outcome> {
  const parsed = parsePersona({ path: entry.path, text: entry.text })
  if (!parsed.ok) {
    return {
      kind: 'skipped',
      row: { sourceId: entry.sourceId, name: null, reason: 'invalid_persona', detail: personaErrorText(parsed.error) },
    }
  }

  const drafted = personaToTemplate(parsed.value, {
    catalog: input.catalog,
    division: entry.division,
    slug: entry.slug,
    text: entry.text,
    importedAt,
    ...(roleMap === undefined ? {} : { roleMap }),
  })
  if (!drafted.ok) {
    return {
      kind: 'skipped',
      row: {
        sourceId: entry.sourceId,
        name: parsed.value.name,
        reason: 'profile_too_long',
        // No truncation and no summarising (R2f): the operator shortens the file and runs it again.
        detail: `${String(drafted.error.length)} characters, over the ${String(drafted.error.limit)} a profile may hold`,
      },
    }
  }
  const draft = drafted.value

  try {
    return await prisma.$transaction(async (tx): Promise<Outcome> => {
      // The catalog's own locking discipline (M27 §5): every verb locks the row it WRITES. A
      // `sourceId` nobody has imported locks nothing here -- there is no row -- and that race is
      // caught by the unique index below instead.
      //
      // A dry run reads the same rows and takes no lock at all (fix round 1, Minor 4): it writes
      // nothing, so a row lock would buy it no consistency it can act on, and holding one over
      // three hundred files would block a real import behind a preview. The two branches decide
      // identically; only the lock differs.
      const existingId =
        input.dryRun === true
          ? ((await tx.slaveTemplate.findUnique({ where: { sourceId: draft.sourceId }, select: { id: true } }))?.id ??
            null)
          : ((
              await tx.$queryRaw<{ id: string }[]>`
                SELECT id FROM "SlaveTemplate" WHERE "sourceId" = ${draft.sourceId} FOR UPDATE
              `
            )[0]?.id ?? null)

      if (existingId === null) {
        // (b) A hand-made template -- or one from another catalog -- already holds the name. The
        // operator's row wins; nothing is renamed and nothing is overwritten. Returned rather than
        // thrown: nothing has been written to this transaction yet.
        const taken = await tx.slaveTemplate.findUnique({ where: { name: draft.name }, select: { id: true } })
        if (taken !== null) {
          return {
            kind: 'skipped',
            row: {
              sourceId: draft.sourceId,
              name: draft.name,
              reason: 'name_taken',
              // Not "was not imported from this catalog": the holder may well BE an imported
              // template, under a different `sourceId`, after its file moved between divisions or
              // into a subfolder. What is true in every case is that it is not the row this
              // persona owns.
              detail: `a template named "${draft.name}" already exists and is not this persona's row`,
            },
          }
        }

        if (input.dryRun === true) {
          return {
            kind: 'created',
            row: { sourceId: draft.sourceId, name: draft.name, role: draft.role, templateId: null },
          }
        }

        try {
          const row = await tx.slaveTemplate.create({
            data: {
              name: draft.name,
              role: draft.role,
              description: draft.description,
              profile: draft.profile,
              profileSha256: draft.profileSha256,
              sourceId: draft.sourceId,
              sourceSha256: draft.sourceSha256,
              sourceDivision: draft.sourceDivision,
              importedAt,
            },
          })
          return {
            kind: 'created',
            row: { sourceId: draft.sourceId, name: draft.name, role: draft.role, templateId: row.id },
          }
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            throw new CatalogRowRefused({
              sourceId: draft.sourceId,
              name: draft.name,
              reason: 'name_taken',
              detail:
                'a unique index rejected the row: the name or the source id was taken between the check and the write',
            })
          }
          throw error
        }
      }

      const existing = await tx.slaveTemplate.findUniqueOrThrow({ where: { id: existingId } })
      const drift = existing.role === draft.role ? {} : { roleDrift: { stored: existing.role, mapped: draft.role } }
      const outcomeRow: RowOutcome = {
        sourceId: draft.sourceId,
        name: existing.name,
        role: existing.role,
        templateId: existing.id,
        ...drift,
      }

      // (c) The file has not changed. Nothing is read further and nothing is written -- including
      // for a row whose profile an operator HAS edited: the import has nothing to say about a
      // profile it is not being asked to replace.
      if (existing.sourceSha256 === draft.sourceSha256) return { kind: 'unchanged', row: outcomeRow }

      // (e) The stored profile is not the one the last import wrote, so a person wrote it (or
      // cleared it). Their words win, and `sourceSha256` is deliberately NOT advanced: the next
      // import must see the same disagreement rather than quietly accepting the file.
      const storedSha = existing.profile === null ? null : goalSha256(existing.profile)
      if (storedSha !== existing.profileSha256) {
        return {
          kind: 'skipped',
          row: {
            sourceId: draft.sourceId,
            name: existing.name,
            reason: 'locally_edited',
            detail:
              'the profile on this template was written by a person since the last import, and an import never overwrites that',
          },
        }
      }

      if (input.dryRun === true) return { kind: 'updated', row: outcomeRow }

      // (d) `name` and `role` are NOT in this write (erratum E10): a template is append-only apart
      // from its profile, and `role` was copied into the runtime roles of every worker already
      // materialised from it, which an update here could never reach.
      await tx.slaveTemplate.update({
        where: { id: existing.id },
        data: {
          profile: draft.profile,
          profileSha256: draft.profileSha256,
          description: draft.description,
          sourceSha256: draft.sourceSha256,
          sourceDivision: draft.sourceDivision,
          importedAt,
        },
      })
      return { kind: 'updated', row: outcomeRow }
    })
  } catch (error) {
    if (error instanceof CatalogRowRefused) return { kind: 'skipped', row: error.row }
    throw error
  }
}

export interface CatalogImportView {
  readonly id: string
  readonly catalog: string
  readonly directory: string
  readonly by: string | null
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  readonly skipped: number
}

/**
 * The last few import runs, newest first (R5) -- `list-imports` and the web's panel.
 *
 * Ordered by `finishedAt`, which is the column BOTH readers display (M42 t4 fix round 1, minor 1).
 * It used to order by `startedAt`, and the two disagree whenever a long import overlaps a short
 * one -- so a list whose only visible timestamp was `finishedAt` could print those timestamps out
 * of order and look sorted by nothing at all. Sorting by the column a reader can see is the whole
 * of the fix; no signature changed, and the web's row shape still carries `finishedAt` alone.
 *
 * The clamp floors at ZERO, not one: a NEGATIVE `take` makes Prisma walk the cursor backwards and
 * hand back the OLDEST rows under a `desc` order, which is the one outcome a caller asking for
 * "the last few" must never get. `listCatalogImports(0)` therefore returns no rows, which is what
 * asking for none means; the ceiling of 100 is there so a mistyped limit cannot pull the whole
 * table into a web response.
 */
export async function listCatalogImports(limit = 10): Promise<readonly CatalogImportView[]> {
  return prisma.catalogImport.findMany({
    orderBy: { finishedAt: 'desc' },
    take: Math.max(0, Math.min(limit, 100)),
    select: {
      id: true,
      catalog: true,
      directory: true,
      by: true,
      startedAt: true,
      finishedAt: true,
      created: true,
      updated: true,
      unchanged: true,
      skipped: true,
    },
  })
}
