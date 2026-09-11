import { type Prisma, prisma } from '@slave-of-ai/db/client'
import type { ProviderKind } from '@slave-of-ai/providers'
import {
  effectiveProfileSpec,
  err,
  goalSha256,
  ok,
  overriddenFields,
  parsePersona,
  personaErrorText,
  personaToProfileSpec,
  personaToTemplate,
  normaliseCapabilities,
  normaliseCollaborationHint,
  profileOverridesSchema,
  profileSpecSchema,
  renderProfileSpec,
  runbookFromProfileSpec,
  type CapabilityRecord,
  type MappingQuality,
  type ProfileOverridableField,
  type ProfileOverrides,
  type ProfileSpec,
  type Result,
} from '@slave-of-ai/domain'
import { listCapabilities, syncCapabilityTaxonomy } from './capability.js'
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
  /** M46 R4: the commit of the catalog checkout, read once per import by the CLI's walk (the
   *  control package touches no disk). NULL when the directory is not inside a git work tree.
   *
   *  Written only when the row is written: an UNCHANGED file keeps the revision it came from
   *  (erratum E22), because the provenance of a persona is the checkout its BYTES were read from,
   *  and re-stamping every row on every import would erase exactly that. A row structured for the
   *  first time is a write, so it takes this run's revision. */
  readonly revision?: string | null
  /** M46 R4: the licence named by a LICENSE file at the catalog root, `MIT License` -> `MIT`. */
  readonly license?: string | null
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
  /** M46 R2: how many of this row's fields an operator had customised, and the update kept. Only
   *  on an `updated` row -- there is nothing to keep on a row being created. */
  readonly overridesKept?: number
  /** M46 erratum E22: this row was imported before M46, had no `profileSpec`, and this import gave
   *  it one WITHOUT its file having changed. The outcome is still `unchanged` -- the file is what
   *  `unchanged` is about -- so this flag is the only way to see that a write happened. */
  readonly structured?: boolean
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

  // R1: nothing matches on a key that is not a row, so the table is reconciled before a single
  // persona is read. Cheap and idempotent -- `{ created: 0, updated: 0 }` on every import after
  // the first.
  await syncCapabilityTaxonomy()
  const taxonomy = await listCapabilities()

  const startedAt = new Date()
  const created: RowOutcome[] = []
  const updated: RowOutcome[] = []
  const unchanged: RowOutcome[] = []
  const skipped: SkippedRow[] = []

  for (const entry of input.entries) {
    const outcome = await importRow(entry, input, roleMap.value, startedAt, taxonomy)
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

  // R5, plan erratum E11: hints resolve against EVERY template, so a sentence naming a persona
  // that is imported later in the same run still finds it. Per template it is a replace, under
  // `@@unique([templateId, text])`, so a re-import can never double an edge.
  await writeCollaborationHints(
    [...created, ...updated, ...unchanged].flatMap((outcome) => (outcome.templateId === null ? [] : [outcome.templateId])),
    taxonomy,
  )

  // R3: a persona's own process becomes a runbook. AFTER the row loop for `writeCollaborationHints`'
  // own reason -- the draft is derived from the stored `profileSpec` and the template id, and both
  // exist only once the row is written. One query per translated persona, never one per stage.
  // Nothing here touches a `SlaveTemplate` row, so the per-row counts M42/M46/M47 pin are untouched.
  await writePersonaRunbooks(
    [...created, ...updated, ...unchanged].flatMap((outcome) => (outcome.templateId === null ? [] : [outcome.templateId])),
    taxonomy,
  )

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
  taxonomy: readonly CapabilityRecord[],
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

  // The mapping is PURE and row-independent, so it happens outside the transaction: three hundred
  // personas must not be parsed and mapped while a row lock is held.
  const upstream = personaToProfileSpec(parsed.value, {
    repository: input.catalog,
    path: `${entry.division}/${entry.slug}.md`,
    revision: input.revision ?? null,
    license: input.license ?? null,
    importedAt,
    runtimeRole: draft.role,
  })

  // Both halves of R1's promise, computed with the mapping and outside the transaction: the KEYS a
  // catalog search and `formTeam` read, and the sentences that matched none of them -- kept
  // verbatim so an operator can see what the taxonomy is missing.
  const { keys: capabilityKeys, unresolved: unresolvedCapabilities } = normaliseCapabilities(
    upstream.capabilities,
    taxonomy,
  )

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
          // M46 R1: `profile` is DERIVED. A new row has no overrides, so the effective spec is the
          // upstream one and the rendered Markdown is what a run will be given.
          const profile = renderProfileSpec(upstream)
          const row = await tx.slaveTemplate.create({
            data: {
              name: draft.name,
              role: draft.role,
              description: draft.description,
              profile,
              profileSha256: goalSha256(profile),
              profileSpec: upstream as unknown as Prisma.InputJsonValue,
              capabilityKeys: [...capabilityKeys],
              unresolvedCapabilities: [...unresolvedCapabilities],
              sourceId: draft.sourceId,
              sourceSha256: draft.sourceSha256,
              sourceDivision: draft.sourceDivision,
              sourceRevision: input.revision ?? null,
              sourceLicense: input.license ?? null,
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
      // E10 fix round 2: drift is a claim the OPERATOR made this run, not a comparison against
      // the fallback role a bare re-import (no --role-map at all) computes for its division. A
      // division absent from this run's map -- because there IS no map, or the map does not
      // mention it -- has nothing to compare the stored role against.
      const mapped = roleMap?.[entry.division]
      const drift = mapped !== undefined && mapped !== existing.role ? { roleDrift: { stored: existing.role, mapped } } : {}
      const outcomeRow: RowOutcome = {
        sourceId: draft.sourceId,
        name: existing.name,
        role: existing.role,
        templateId: existing.id,
        ...drift,
      }

      // The raw-override predicate, computed once and read twice (M46 erratum E22): the stored
      // profile is not the text the last import wrote, so a person wrote it -- or CLEARED it,
      // which is why a null profile goes through the same comparison rather than around it.
      const storedSha = existing.profile === null ? null : goalSha256(existing.profile)
      const rawOverride = storedSha !== existing.profileSha256

      // (c) The file has not changed. Nothing is read further and nothing is written -- including
      // for a row whose profile an operator HAS edited: the import has nothing to say about a
      // profile it is not being asked to replace.
      if (existing.sourceSha256 === draft.sourceSha256) {
        // M46 erratum E22: except once. A template imported before this milestone has no
        // `profileSpec`, and its file will not change just because the repository learned to map
        // one -- so a row that has never been structured is structured here, from the file the
        // import is already holding. The OUTCOME stays `unchanged`, because that word is about the
        // file; `structured` says what happened to the row.
        //
        // Never over a raw override: that row's Markdown is somebody's own words, and rendering a
        // freshly mapped spec over them is precisely the write `locally_edited` exists to prevent
        // (M42's case (c2) writes nothing at all, and still does). And no overrides are merged in
        // here -- `setProfileOverrides` refuses a row with no spec, so a row reaching this branch
        // has none to keep.
        if (existing.profileSpec !== null || rawOverride) return { kind: 'unchanged', row: outcomeRow }

        const structuredRow: RowOutcome = { ...outcomeRow, structured: true }
        if (input.dryRun === true) return { kind: 'unchanged', row: structuredRow }

        const structuredProfile = renderProfileSpec(upstream)
        // `importedAt` moves with the rest: the rendered Markdown opens with the line naming the
        // day this text was written from the file (`importedProfilePrefix`, read out of
        // `spec.source.importedAt`), and a column disagreeing with the sentence in the profile
        // beside it is a fact nobody can act on.
        await tx.slaveTemplate.update({
          where: { id: existing.id },
          data: {
            profile: structuredProfile,
            profileSha256: goalSha256(structuredProfile),
            profileSpec: upstream as unknown as Prisma.InputJsonValue,
            capabilityKeys: [...capabilityKeys],
            unresolvedCapabilities: [...unresolvedCapabilities],
            sourceRevision: input.revision ?? null,
            sourceLicense: input.license ?? null,
            importedAt,
          },
        })
        return { kind: 'unchanged', row: structuredRow }
      }

      // (e) The stored profile is not the one the last import wrote, so a person wrote it (or
      // cleared it). Their words win, and `sourceSha256` is deliberately NOT advanced: the next
      // import must see the same disagreement rather than quietly accepting the file.
      if (rawOverride) {
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

      // M46 R2: the operator's half is read, never written, and the Markdown is re-rendered from
      // the NEW upstream spec merged with it. This is the whole of "an override survives an
      // upstream update": the two halves are different columns, so an import can replace one
      // without being able to touch the other.
      const stored = profileOverridesSchema.safeParse(existing.profileOverrides ?? {})
      const overrides = stored.success ? stored.data : {}
      const profile = renderProfileSpec(effectiveProfileSpec(upstream, overrides))
      const updatedRow: RowOutcome = { ...outcomeRow, overridesKept: overriddenFields(overrides).length }

      if (input.dryRun === true) return { kind: 'updated', row: updatedRow }

      // (d) `name` and `role` are NOT in this write (erratum E10): a template is append-only apart
      // from its profile, and `role` was copied into the runtime roles of every worker already
      // materialised from it, which an update here could never reach. `profileOverrides` is not in
      // it either, for the M46 reason above.
      await tx.slaveTemplate.update({
        where: { id: existing.id },
        data: {
          profile,
          profileSha256: goalSha256(profile),
          profileSpec: upstream as unknown as Prisma.InputJsonValue,
          // Recomputed from the NEW upstream spec, which is the point: a persona that gained a
          // capability bullet gains the key, and one whose bullet the taxonomy has since learned
          // stops being unresolved.
          capabilityKeys: [...capabilityKeys],
          unresolvedCapabilities: [...unresolvedCapabilities],
          description: draft.description,
          sourceSha256: draft.sourceSha256,
          sourceDivision: draft.sourceDivision,
          sourceRevision: input.revision ?? null,
          sourceLicense: input.license ?? null,
          importedAt,
        },
      })
      return { kind: 'updated', row: updatedRow }
    })
  } catch (error) {
    if (error instanceof CatalogRowRefused) return { kind: 'skipped', row: error.row }
    throw error
  }
}

/**
 * The hint pass (R5). One read of every template's name, one read of the specs being re-hinted,
 * and one replace per template -- never a query per sentence.
 *
 * Runs after the row loop, so a sentence naming a persona imported LATER in the same run still
 * finds it (plan erratum E11), and after the dry-run return above, so a preview writes no edges.
 */
async function writeCollaborationHints(
  templateIds: readonly string[],
  taxonomy: readonly CapabilityRecord[],
): Promise<void> {
  if (templateIds.length === 0) return
  const names = await prisma.slaveTemplate.findMany({ select: { id: true, name: true } })
  const rows = await prisma.slaveTemplate.findMany({
    where: { id: { in: [...templateIds] } },
    select: { id: true, profileSpec: true },
  })
  for (const row of rows) {
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    if (!spec.success) continue
    // The template's OWN name is excluded (`normaliseCollaborationHint`'s caller contract): a
    // persona that mentions its own title would otherwise advise consulting itself.
    const others = names.filter((name) => name.id !== row.id)
    const drafts = spec.data.collaborationHints.map((sentence) => normaliseCollaborationHint(sentence, others, taxonomy))
    await prisma.$transaction([
      prisma.collaborationHint.deleteMany({ where: { templateId: row.id, source: 'import' } }),
      prisma.collaborationHint.createMany({
        data: drafts.map((draft) => ({
          templateId: row.id,
          text: draft.text,
          // Belt and braces over the exclusion above (M47 t1 review): the owner is filtered out of
          // `others`, and a self-edge that reached this line anyway -- two templates sharing a
          // name, a helper called with the wrong list -- is written as "names nobody" rather than
          // as a worker advising itself.
          targetTemplateId: draft.targetTemplateId === row.id ? null : draft.targetTemplateId,
          capability: draft.capability,
          source: 'import',
        })),
        skipDuplicates: true,
      }),
    ])
  }
}

/**
 * The persona-to-runbook pass (M48 R3).
 *
 * Keyed on `RunbookTemplate.key` (plan erratum E15): there is no unique index over
 * `(source, sourceTemplateId)` and one over a nullable column could not hold across the seed rows,
 * so `runbookFromProfileSpec` derives `persona-<slug of the template name>` and this upserts on it.
 *
 * A row an operator owns WINS, which is `importCatalog`'s own rule for a template name: a `human`
 * runbook under the same key is left exactly as it is, and nothing about the import says otherwise.
 * A persona whose workflow is shorter than two lines produces no runbook at all -- one step is not
 * a process -- and an existing persona runbook for it is left standing rather than deleted, because
 * a file that lost its Workflow heading has not asked for a project's adopted runbook to vanish.
 */
async function writePersonaRunbooks(
  templateIds: readonly string[],
  taxonomy: readonly CapabilityRecord[],
): Promise<void> {
  if (templateIds.length === 0) return
  const rows = await prisma.slaveTemplate.findMany({
    where: { id: { in: [...templateIds] } },
    select: { id: true, name: true, capabilityKeys: true, profileSpec: true },
    orderBy: { id: 'asc' },
  })
  for (const row of rows) {
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    if (!spec.success) continue
    const draft = runbookFromProfileSpec(spec.data, { id: row.id, name: row.name, capabilityKeys: row.capabilityKeys }, taxonomy)
    if (draft === null) continue
    const existing = await prisma.runbookTemplate.findUnique({ where: { key: draft.key }, select: { id: true, source: true } })
    if (existing !== null && existing.source === 'human') continue
    const data = {
      name: draft.name,
      description: draft.description,
      keywords: [...draft.keywords],
      requiredCapabilities: [...draft.requiredCapabilities],
      optionalCapabilities: [...draft.optionalCapabilities],
      stages: draft.stages as unknown as Prisma.InputJsonValue,
      source: 'persona',
      sourceTemplateId: draft.sourceTemplateId,
    }
    if (existing === null) await prisma.runbookTemplate.create({ data: { key: draft.key, ...data } })
    else await prisma.runbookTemplate.update({ where: { key: draft.key }, data })
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

/**
 * One template as the Workforce Catalog reads it (M46 R6).
 *
 * A SUMMARY row: the fields a person scans, never the whole spec. Hundreds of rows times a three
 * kilobyte spec is a megabyte of JSON to render a table, so the full effective profile is read one
 * row at a time by {@link readTemplateProfile} when a drawer opens.
 */
export interface WorkforceCatalogRow {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly description: string
  readonly defaultModel: string | null
  readonly defaultProvider: ProviderKind | null
  readonly catalogSlaveCount: number
  readonly sourceId: string | null
  readonly sourceDivision: string | null
  readonly importedAt: Date | null
  readonly sourceRepository: string | null
  readonly sourceRevision: string | null
  readonly sourceLicense: string | null
  /** `imported` when the row has a `sourceId`, which is what M42 made that column mean. */
  readonly source: 'imported' | 'local'
  /** Whether `profileSpec` parsed. A row that is not structured shows no capabilities and offers
   *  no Customise -- there is nothing to customise (plan erratum E5). */
  readonly structured: boolean
  readonly summary: string
  readonly capabilities: readonly string[]
  /** M47 R1: the same capabilities, resolved to taxonomy KEYS at import. Beside the free text
   *  rather than instead of it -- the free text is what the search box matches and what an
   *  unstructured row shows, and a key is what `formTeam` and a capability filter read. */
  readonly capabilityKeys: readonly string[]
  readonly expertise: readonly string[]
  readonly recommendedSkills: readonly string[]
  readonly mappingQuality: MappingQuality | null
  readonly overriddenFields: readonly ProfileOverridableField[]
  /** The Markdown was written by hand over a structured profile -- or cleared -- (R5, plan errata
   *  E4/E22): the stored profile's hash disagrees with the one the last write recorded. This is
   *  the SAME predicate `importCatalog` skips `locally_edited` on, character for character, a
   *  cleared (`null`) profile included: a badge that disagreed with what the next import will do
   *  is worse than no badge. */
  readonly rawOverride: boolean
}

export interface WorkforceCatalogFacets {
  readonly divisions: readonly string[]
  readonly capabilities: readonly string[]
  readonly skills: readonly string[]
}

export interface WorkforceCatalogFilters {
  readonly q?: string
  readonly division?: string
  readonly capability?: string
  readonly source?: 'imported' | 'local'
  readonly skill?: string
}

export interface WorkforceCatalogPage {
  readonly rows: readonly WorkforceCatalogRow[]
  readonly facets: WorkforceCatalogFacets
}

/** The fourteen columns a row needs -- `profile` is NOT one of them (fix round 1, minor 3): the
 *  Markdown is up to sixteen kilobytes a row and nothing on a catalog card shows it. The one thing
 *  it was read for, the raw-override hash, is computed in Postgres instead and arrives as
 *  `rawOverride`. */
interface CatalogTemplateRow {
  id: string
  name: string
  role: string
  description: string
  defaultModel: string | null
  provider: ProviderKind | null
  profileSha256: string | null
  profileSpec: unknown
  profileOverrides: unknown
  sourceId: string | null
  sourceDivision: string | null
  sourceRevision: string | null
  sourceLicense: string | null
  importedAt: Date | null
  capabilityKeys: string[]
}

function catalogRowOf(
  template: CatalogTemplateRow,
  catalogSlaveCount: number,
  rawOverride: boolean,
): WorkforceCatalogRow {
  const spec = profileSpecSchema.safeParse(template.profileSpec)
  const overrides = profileOverridesSchema.safeParse(template.profileOverrides ?? {})
  const effective = spec.success ? effectiveProfileSpec(spec.data, overrides.success ? overrides.data : {}) : null
  return {
    id: template.id,
    name: template.name,
    role: template.role,
    description: template.description,
    defaultModel: template.defaultModel,
    defaultProvider: template.provider,
    catalogSlaveCount,
    sourceId: template.sourceId,
    sourceDivision: template.sourceDivision,
    importedAt: template.importedAt,
    sourceRepository: spec.success ? (spec.data.source?.repository ?? null) : (template.sourceId?.split('/')[0] ?? null),
    sourceRevision: template.sourceRevision,
    sourceLicense: template.sourceLicense,
    source: template.sourceId === null ? 'local' : 'imported',
    structured: spec.success,
    // `||`, not `??`: a spec whose `summary` the mapper could not fill is an EMPTY string, not
    // undefined, and an empty cell where the catalog blurb would do is a worse row than the blurb.
    summary: (effective?.summary ?? '') || template.description,
    capabilities: effective?.capabilities ?? [],
    capabilityKeys: template.capabilityKeys,
    expertise: effective?.expertise ?? [],
    recommendedSkills: effective?.recommendedSkills ?? [],
    mappingQuality: spec.success ? (spec.data.source?.mappingQuality ?? null) : null,
    overriddenFields: overrides.success ? overriddenFields(overrides.data) : [],
    // NOT scoped to a structured row (final wave, M5). A hand-made template still shows nothing --
    // it has no `profileSha256`, so no import ever wrote its Markdown and there is nothing for it
    // to be an override OF (plan erratum E5) -- but a row imported BEFORE M46 has a stamp and no
    // spec, and if a person edited its Markdown the importer skips it `locally_edited` on every
    // run. Hiding the chip there left the one row the operator has to act on looking ordinary.
    rawOverride,
  }
}

function matches(row: WorkforceCatalogRow, filters: WorkforceCatalogFilters): boolean {
  if (filters.source !== undefined && row.source !== filters.source) return false
  if (filters.division !== undefined && row.sourceDivision !== filters.division) return false
  if (filters.capability !== undefined && !row.capabilities.includes(filters.capability)) return false
  if (filters.skill !== undefined && !row.recommendedSkills.includes(filters.skill)) return false
  const q = (filters.q ?? '').trim().toLowerCase()
  if (q === '') return true
  const haystack = [row.name, row.summary, row.description, ...row.capabilities, ...row.expertise]
    .join('\n')
    .toLowerCase()
  return haystack.includes(q)
}

/**
 * The Workforce Catalog's read model (M46 R6).
 *
 * **Filtered in memory, deliberately.** The facets live inside a JSON column, and the catalog is
 * hundreds of rows even after a full import -- a page's worth of memory. Postgres JSONB operators
 * through `$queryRaw` would buy nothing here and would put the filter vocabulary in SQL, where
 * M47's capability taxonomy cannot reuse it. If the catalog ever outgrows this, the join tables
 * arrive with M47's taxonomy and not before.
 *
 * The FACETS are computed over every row, before filtering. A filter menu built from the filtered
 * rows collapses to whatever was already chosen, which makes it impossible to change your mind.
 *
 * A DIVISION is a directory a catalog was imported from, so both the menu and the match read
 * `sourceDivision` alone (plan erratum E22): the facet list IS the definition of the word on this
 * surface, and a hand-made template whose `role` happens to spell "engineering" was never in that
 * directory. Hand-made rows are reached through `source: 'local'` and free text instead.
 */
export async function listWorkforceCatalog(filters: WorkforceCatalogFilters = {}): Promise<WorkforceCatalogPage> {
  const [templates, catalogSlaveGroups, rawOverrides] = await Promise.all([
    prisma.slaveTemplate.findMany({
      select: {
        id: true,
        name: true,
        role: true,
        description: true,
        defaultModel: true,
        provider: true,
        profileSha256: true,
        profileSpec: true,
        profileOverrides: true,
        sourceId: true,
        sourceDivision: true,
        sourceRevision: true,
        sourceLicense: true,
        importedAt: true,
        capabilityKeys: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.companySlave.groupBy({ by: ['templateId'], _count: { _all: true } }),
    // The raw-override predicate, computed in POSTGRES so the profile text stays there: it is the
    // only reason a catalog listing would read a sixteen-kilobyte column it never displays.
    // `sha256(convert_to(text,'UTF8'))` hex is byte-identical to `goalSha256` (the same digest over
    // the same bytes), and `IS DISTINCT FROM` is what makes a CLEARED profile -- NULL against a
    // recorded hash -- come back true, exactly as `importCatalog` reads it.
    //
    // The WHERE is on the STAMP, not on the spec (final wave, M5): a stamp is what an import
    // leaves behind, so every row that has one has a profile an import wrote and a person may
    // since have rewritten -- a pre-M46 row included. A hand-made template has no stamp and is
    // simply absent from this result, which the `?? false` below reads as "no override".
    prisma.$queryRaw<{ id: string; rawOverride: boolean }[]>`
      SELECT id,
             (CASE WHEN "profile" IS NULL THEN NULL ELSE encode(sha256(convert_to("profile", 'UTF8')), 'hex') END)
               IS DISTINCT FROM "profileSha256" AS "rawOverride"
      FROM "SlaveTemplate"
      WHERE "profileSha256" IS NOT NULL
    `,
  ])
  const countByTemplate = new Map(catalogSlaveGroups.map((group) => [group.templateId, group._count._all] as const))
  const rawByTemplate = new Map(rawOverrides.map((row) => [row.id, row.rawOverride] as const))
  const all = templates.map((template) =>
    catalogRowOf(template, countByTemplate.get(template.id) ?? 0, rawByTemplate.get(template.id) ?? false),
  )

  const divisions = new Set<string>()
  const capabilities = new Set<string>()
  const skills = new Set<string>()
  for (const row of all) {
    if (row.sourceDivision !== null) divisions.add(row.sourceDivision)
    for (const capability of row.capabilities) capabilities.add(capability)
    for (const skill of row.recommendedSkills) skills.add(skill)
  }

  return {
    rows: all.filter((row) => matches(row, filters)),
    facets: {
      divisions: [...divisions].sort(),
      capabilities: [...capabilities].sort(),
      skills: [...skills].sort(),
    },
  }
}

/** One template's whole profile, both halves and the merge (M46 R6): what a drawer opens and what
 *  `show-profile` prints. Kept out of {@link listWorkforceCatalog}'s rows on purpose -- see its
 *  docblock. */
export interface TemplateProfileView {
  readonly templateId: string
  readonly name: string
  readonly upstream: ProfileSpec | null
  readonly overrides: ProfileOverrides
  readonly effective: ProfileSpec | null
  /** `SlaveTemplate.profile` exactly as stored -- which is the render of `effective` unless a raw
   *  Markdown override (R5) is in force, and that is what `rawOverride` says. */
  readonly markdown: string | null
  readonly rawOverride: boolean
  readonly overridden: readonly ProfileOverridableField[]
}

export async function readTemplateProfile(templateId: string): Promise<Result<TemplateProfileView, ControlRefusal>> {
  const row = await prisma.slaveTemplate.findUnique({ where: { id: templateId } })
  if (row === null) return err({ kind: 'template_not_found', templateId })
  const spec = profileSpecSchema.safeParse(row.profileSpec)
  const stored = profileOverridesSchema.safeParse(row.profileOverrides ?? {})
  const overrides = stored.success ? stored.data : {}
  return ok({
    templateId: row.id,
    name: row.name,
    upstream: spec.success ? spec.data : null,
    overrides,
    effective: spec.success ? effectiveProfileSpec(spec.data, overrides) : null,
    markdown: row.profile,
    // The importer's own comparison, cleared profile included (fix round 1, minor 2): a `null`
    // profile against a recorded hash is a person having cleared it, which is `locally_edited`
    // there and a raw override here.
    rawOverride: spec.success && (row.profile === null ? null : goalSha256(row.profile)) !== row.profileSha256,
    overridden: overriddenFields(overrides),
  })
}
