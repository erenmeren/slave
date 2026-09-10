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
  for (const [division, role] of Object.entries(input.roleMap ?? {})) {
    if (division.trim() === '') return err({ kind: 'invalid_role_map', detail: 'a division name is empty' })
    if (role.trim() === '') return err({ kind: 'invalid_role_map', detail: `the role for "${division}" is empty` })
  }

  const startedAt = new Date()
  const created: RowOutcome[] = []
  const updated: RowOutcome[] = []
  const unchanged: RowOutcome[] = []
  const skipped: SkippedRow[] = []

  for (const entry of input.entries) {
    const outcome = await importRow(entry, input, startedAt)
    if (outcome.kind === 'skipped') skipped.push(outcome.row)
    else if (outcome.kind === 'created') created.push(outcome.row)
    else if (outcome.kind === 'updated') updated.push(outcome.row)
    else unchanged.push(outcome.row)
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
async function importRow(entry: CatalogEntry, input: ImportCatalogInput, importedAt: Date): Promise<Outcome> {
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
    ...(input.roleMap === undefined ? {} : { roleMap: input.roleMap }),
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
      // The catalog's own locking discipline (M27 §5): every verb locks the row it writes. A
      // `sourceId` nobody has imported locks nothing here -- there is no row -- and that race is
      // caught by the unique index below instead.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "SlaveTemplate" WHERE "sourceId" = ${draft.sourceId} FOR UPDATE
      `
      const existingId = locked[0]?.id ?? null

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
              detail: `a template named "${draft.name}" already exists and was not imported from this catalog`,
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

/** The last few import runs, newest first (R5) -- `list-imports` and the web's panel. */
export async function listCatalogImports(limit = 10): Promise<readonly CatalogImportView[]> {
  return prisma.catalogImport.findMany({
    orderBy: { startedAt: 'desc' },
    take: Math.max(1, Math.min(limit, 100)),
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
