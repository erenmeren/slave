# M55 — Full catalog import

Twelfth milestone of the roadmap `2026-09-10-roadmap-m44-m56.md` (row M55, line 47), extending M42's
per-row import policy (`sourceId`, `sourceSha256`, `locally_edited`, the `CatalogImport` row, "nothing
is ever deleted"), M46's structured profile and its Source record (`profileSpec`, `sourceRevision`,
`sourceLicense`, `ProfileSpec.source`), M46's Workforce Catalog surface (rows, filter bar, profile
drawer), M47's capability taxonomy and its `capabilityKeys` column, M50's temporary hire and M53's
"one row per thing that happened, one writer, no rollup" — named as extensions, per roadmap lines
19-23. Designed 2026-09-13 from an inventory of the importer's every write, the one loader that turns
a template into a hiring candidate, every place the catalog is read unbounded, the four substrates a
duplicate signal could stand on, and the five gates that already import a catalog (session scratchpad
`m55-explore.md`). Every **Ruling** took the controller's direction under the user's standing
approval; where the repository forces a different shape the ruling carries an inline `*(verified: …)*`
note. "Slave" is this project's word for an AI worker.

**Goal.** The whole persona catalog on an operator's disk — three hundred files, not five — goes into
this product's catalog in one command, and the product is honest about what just arrived. None of it
is hirable until somebody says so: an import produces a library, not a workforce. The catalog page
stays a page you can work in when it holds hundreds of rows instead of dozens, because the filtering
and the paging happen in the database rather than in a list somebody rendered whole. And the thing
that actually goes wrong when you import three hundred strangers' personas — that a dozen of them are
the same specialist under different names, and that half of them claim the same four capabilities —
is shown as a signal beside the row it is about, in three named classes, with the number behind each
one. **The signal never deletes anything.** A person may dismiss it; the importer may not.

**Facts the design stands on.** `importCatalog` (`packages/control/src/catalog.ts:163`) runs one
transaction per ROW, never one for the import, and its doc comment says why; `importRow` (`:253`)
decides `created`/`updated`/`unchanged`/`skipped` with the four skip reasons `name_taken`,
`locally_edited`, `profile_too_long`, `invalid_persona`; two post-passes already run AFTER the row
loop — `writeCollaborationHints` and `writePersonaRunbooks` — for the reason plan erratum E11 gives:
a persona imported LATER in the same run is not in the table while an earlier row is being written.
**No import writes an event**: `ExecutionEvent.workspaceId` is `String`, NOT NULL
(`schema.prisma:1743`), a template belongs to no project, and M42 R5 made the `CatalogImport` row the
record instead — the same rule `org.ts`'s three catalog-level verbs state ("No event: the catalog has
no workspace", `org.ts:934,1009`). `SlaveTemplate` (`schema.prisma:337-402`) carries `name @unique`,
`sourceId @unique`, `sourceSha256`, `sourceDivision`, `profile`, `profileSha256`, `profileSpec Json?`,
`profileOverrides Json?`, `sourceRevision`, `sourceLicense`, `importedAt`, `capabilityKeys String[]`
and `unresolvedCapabilities String[]` — **and no `active`, `enabled` or `status` column of any kind**.
`loadCatalogEntries` (`packages/control/src/supervisorWorld.ts:127-160`) admits EVERY `SlaveTemplate`
whose `capabilityKeys` is non-empty, `take: CATALOG_ENTRIES_MAX = 500` (`:263`) whose own docstring
already says "a full catalog import is thousands of rows (M55)" — so today a full import makes
thousands of untouched personas rankable candidates the tick after it finishes.
`listWorkforceCatalog` (`catalog.ts:810`) does a `findMany` with **no `take`**, computes five facets
over every row and filters IN MEMORY, and its docstring says the catalog is "hundreds of rows even
after a full import — a page's worth of memory". **Nothing in the tree computes a similarity of any
kind**: no shingling, no Jaccard, no MinHash, no edit distance; `normaliseCapabilityText`
(`packages/domain/src/capability/taxonomy.ts:49`) is the only normaliser and it is for matching one
phrase to one taxonomy key. `goalSha256` (`packages/domain/src/goal/version.ts`) is a hand-rolled
SHA-256 **because `packages/domain` imports no Node built-in at all** — `apps/web`'s client bundle
imports this package and a `node:crypto` anywhere in the graph fails `npm run web:build` outright.
`profileKeyOf` (`packages/domain/src/evidence/derive.ts:25-28`) keys evidence as `template:<id>` or
`slave:<id>`. The catalog UI is `WorkforceCatalog.tsx` + `CatalogFilterBar.tsx` (five filters: `q`,
`division`, `capability`, `source`, `skill`) + `ProfileDrawer.tsx` (thirteen `DetailsGroup`s, the
twelfth being `Source`, which **already prints `source.license`**, `ProfileDrawer.tsx:359`), read
through `GET /api/org/catalog` and `listWorkforceCatalogPage` (`apps/web/src/server/org.ts:972`).
`licenseOf` (`apps/orchestrator/src/catalog.ts:105-124`) reads the first line of `LICENSE`,
`LICENSE.md` or `LICENSE.txt` at the catalog root; of the five checked-in fixture catalogs **only
`scripts/fixtures/catalog-m42/` has none**. The event catalogue holds 61 types after M54
(`packages/domain/test/supervisor/timeline.test.ts:18-19`), `EVENT_PREFIX_LABEL`
(`apps/web/src/lib/eventLabels.ts:21-65`) holds twelve families and **there is no `template.*` among
them**. The schema has **no `Decimal` column anywhere** — `Float` is what every money and ratio column
is (`schema.prisma:118,978,1150,1217,1404,1826,1890`) — and **no GIN index anywhere**. The gate roster
ends at `gate:m54-triggers` with 29 gates (`README.md:890,971`, `package.json:67`,
`.github/workflows/ci.yml:81`). `scripts/fixtures/` holds five fixture catalogs, none larger than five
personas. Five gates run `import-catalog`: m42, m46, m47, m48, m50 — and two of them, m47 and m50,
depend on the Supervisor picking an imported template out of `loadCatalogEntries`.

## 1. Rulings

- **R1 — `sourceId` stays the same-catalog key; `contentSha256` is the cross-catalog one, and it is
  over the persona, not over the file and not over the render.** M42 R2's idempotency is unchanged:
  a re-import finds its row by `sourceId` (`<catalog>/<division>/<slug>`) and `sourceSha256` is still
  the change detector over the FILE's bytes. Neither can answer "is this the same specialist as that
  one" across two catalogs: `sourceId` is a path, and `sourceSha256` changes when a maintainer fixes
  a typo. `SlaveTemplate.contentSha256 String?` holds `goalSha256` of the NORMALISED persona, and
  `normalisePersona` runs three passes and no more: **NFC**, **lower case**, **every run of whitespace
  collapsed to one space** (then trimmed). Two rows with an equal `contentSha256` are the `exact`
  class regardless of `sourceId`, of catalog and of division. *(verified: the thing normalised is not
  the persona FILE and not `SlaveTemplate.profile`. The file carries front matter — `color`, `emoji`,
  `vibe` — which is cosmetics by M42 R4's own reading, and `profile` is
  `renderProfileSpec(upstream)`, which OPENS with `importedProfilePrefix(sourceId, importedAt)`
  (`packages/domain/src/catalog/persona.ts:89-91`, asserted at `gate-m42-catalog-import.mjs:415-420`)
  — a line carrying the source id and the DAY, so the same persona imported from two catalogs on two
  days could never hash equal. The canonical text is therefore built from the STRUCTURED profile's own
  fields: `canonicalPersonaText(spec)` joins the values of `PROFILE_SPEC_FIELDS`
  (`packages/domain/src/profile/spec.ts:89-107`) with a newline, in that constant's own order, with
  `runtimeRole` excluded — it is a scheduler label the importer chose, not a word the persona wrote —
  and `source` excluded, since it is provenance. That text is reproducible from a stored column, which
  is what lets `--recompute` (R4) re-derive it for a row whose file is long gone.)* A row with no
  `profileSpec` — hand-made, or imported before M46 and never re-imported — gets `contentSha256:
  null` and takes no part in the `exact`-by-hash class; it is still reached by the name and capability
  classes. What this deliberately does NOT do: it does not make `contentSha256` unique (two rows with
  the same persona are exactly the fact this milestone exists to SHOW, and a unique index would turn
  showing it into refusing the second import), it does not change `sourceId`, `sourceSha256` or
  `profileSha256`, and it does not rename `goalSha256` (M42's declined item, still declined).

- **R2 — "Never active by default" is a column, the loader's `WHERE`, and one operator verb — and it
  pays no event, because the catalog has no workspace to write one to.**
  `SlaveTemplate.active Boolean @default(false)`, and the migration's data statement is
  `UPDATE "SlaveTemplate" SET "active" = true;` — **every row that exists on the day of the upgrade
  becomes active**, because every one of them was already a `loadCatalogEntries` candidate and an
  operator upgrading must not find their workforce silently emptied. From M55 on, `importCatalog`
  writes `active: false` on every row it CREATES unless `--activate` was passed, and never writes the
  column on a row it updates — activation is a person's decision and an import is not the moment to
  revisit it. `createTemplate` (`packages/control/src/org.ts:72`) passes `active: true` explicitly:
  a template somebody typed by hand IS the deliberate act `--activate` stands for. `loadCatalogEntries`
  adds `active: true` to its `where` beside the non-empty-`capabilityKeys` clause, which is the ONLY
  gate this milestone installs — **`formTeam` and `rankCandidates` are untouched**
  (`packages/domain/src/capability/team.ts:225`), because they are pure functions over a
  `SupervisorWorld` and the honest place to say "this is not a candidate" is where candidates are
  loaded. **Activation never touches `CompanySlave` or `Slave`**: `addCompanySlave`, `assignCompany`,
  `materialiseCompanySlave` and the CLI's `add-slave --template` all keep working on an inactive row,
  because an operator naming a specific row by hand is the same deliberate act as activating it, and a
  worker already hired from a template does not stop working when the template is deactivated. The
  verb is `setTemplateActivation(templateId, active, principal)` in `packages/control/src/org.ts`:
  a locked check-then-update (`SELECT … FOR UPDATE`, the discipline every catalog verb there follows),
  refusing `template_not_found` (an existing kind, `refusal.ts:130`), returning
  `{ changed: boolean }` so a no-op says so rather than pretending. It stamps
  `activationChangedAt DateTime?` and `activationChangedBy String?` on the row. Surfaces: CLI
  `template activate|deactivate --template <id>` and a two-state toggle on each Catalog row (R6).
  *(verified: **there is no `template.activation_changed` event and the catalogue stays at 61.** The
  direction called for the 62nd, and the repository will not carry it: `appendEvent`
  (`packages/events/src/append.ts:6-8`) requires a `workspaceId`, `ExecutionEvent.workspaceId` is NOT
  NULL (`schema.prisma:1743`), a `SlaveTemplate` belongs to no workspace, and the two ways out are
  both worse than the gap. A sentinel string would write a row no surface can ever read — the Activity
  page is `/w/:id/activity` and every query is keyed on the workspace — which is a log entry that
  exists only to let us say we wrote one. Making the column nullable would touch the envelope schema,
  `toExecutionEvent`, the `pg_notify` payload, four indexes and every reader, which M54 R6 declined
  for its own unmapped delivery and which is not a change M55 should smuggle in beside a catalog
  import. So the milestone follows the rule this repository already wrote down twice — M42 R5's "the
  catalog has no workspace, so `ExecutionEvent` is the wrong home; the `CatalogImport` row IS the
  record" and M54 R6's "the row and the log line are the honest pair of homes" — and records the fact
  on the row: `activationChangedAt` and `activationChangedBy` are what "who turned this on, and when"
  reads from. `EVENT_PREFIX_LABEL` gains nothing and
  `packages/domain/test/supervisor/timeline.test.ts:18-19` does not move. A catalog-level event log is
  carried backlog, named in §6.)* What this deliberately does NOT do: it adds no auto-activation
  policy (no "activate everything in this division", no "activate on first hire"), it does not
  deactivate a row because an import stopped finding its file (M42's append-only rule stands), and it
  does not make `active` part of any unique constraint.

- **R3 — The catalog read filters and pages in the database, and the five facets survive it.**
  `listWorkforceCatalog` stops being a whole-table `findMany` filtered in memory.
  `WorkforceCatalogFilters` gains `active?: boolean` and `duplicates?: DuplicateFacet` and every one
  of the seven becomes a Prisma `where` clause: `division` → `sourceDivision`, `source` →
  `sourceId: null` / `{ not: null }`, `active` → `active`, `capability` → `capabilityKeys: { has }`,
  `skill` → `recommendedSkills: { has }`, `duplicates` → a relation filter (R6), and `q` →
  `searchText: { contains: q, mode: 'insensitive' }`. Paging is a cursor: `CATALOG_PAGE_SIZE = 100`,
  `orderBy: [{ name: 'asc' }, { id: 'asc' }]`, `cursor: { id }, skip: 1`, and the page carries
  `nextCursor: string | null` beside `rows`, plus a `total` from one `count` over the SAME `where`.
  `catalogFilters.ts`'s `parseCatalogFilters`/`catalogFilterParams` and `useCatalogFilters`'s
  `FILTER_PARAMS` go from five params to seven, staying LENIENT the way that module's own docblock
  requires: an `active` or `duplicates` value outside its vocabulary is dropped, never refused.
  **Two new denormalised columns pay for two of those clauses**, and they are the M47 precedent
  applied a second time — `capabilityKeys` exists because a filter vocabulary inside a JSON column
  cannot be a `where`: `recommendedSkills String[] @default([])` (the spec's own list, written
  verbatim beside `capabilityKeys` at import) and `searchText String @default("")`, the lower-cased
  join of `name`, `description` and the spec's `identity`, `summary`, `capabilities`, `expertise` and
  `recommendedSkills`, truncated to `SEARCH_TEXT_MAX_CHARS = 2000` (the `RATIONALE_MAX_CHARS`
  precedent). *(verified: a `name`-only search would have been a regression this milestone cannot
  afford. `gate:m46-workforce-catalog` stage 2a types `rollout` and expects the Release Steward alone;
  that word is in the persona's Identity section and in a capability bullet, in neither its name
  (`Gate Release Steward`) nor its `description` (`Gets a change out and watches what it does.`) —
  `scripts/fixtures/catalog-m46/engineering/gate-release-steward.md:3,13,17`. Searching what the row
  DISPLAYS matters more at three hundred rows than at five, so the searchable text is a real column
  and the gate's stage stays green unchanged. The column is a sequential `ILIKE` scan: 5,000 rows × up
  to 2 KB is ten megabytes, tens of milliseconds, and a trigram index is the next step if it ever
  bites — carried backlog, not built.)* **The facets are computed over the whole table and never over
  the page**, the rule M46 R6 already states, and each becomes its own bounded query:
  `divisions` = `groupBy({ by: ['sourceDivision'] })`; `skills` and `capabilities` = one
  `SELECT DISTINCT unnest(...)` each over the two array columns. The capability facet's OPTIONS become
  taxonomy KEYS rendered through their `label` (`capabilityIndex`, M47) rather than the free text they
  are today — labels never keys (`docs/ia.md` rule 3), and the key is the `<option value>` a gate
  reads. `CATALOG_ENTRIES_MAX` stays 500 and its docstring is rewritten: the bound is now over ACTIVE
  rows, which is a different and much smaller population, and the sentence claiming "a full catalog
  import is thousands of rows" becomes the sentence saying why 500 active ones is a bound worth
  keeping. The search box is debounced at `CATALOG_SEARCH_DEBOUNCE_MS = 250` — M53 §6's carried
  "`q` undebounced" item, taken here because it stops being cosmetic the moment each keystroke is an
  `ILIKE` over the whole table. What this deliberately does NOT do: free text no longer matches
  `operatingPrinciples`, `constraints`, `workflow`, `deliverables`, `successCriteria` or
  `collaborationHints` — seven fields are in `searchText` and fourteen are not — it adds no full-text
  index and no `tsvector` column, and it does not sort by anything but name.

- **R4 — Three classes, three thresholds, six pure functions, and a bound on every loop.**
  `packages/domain/src/catalog/duplicate.ts` (beside `persona.ts`, importing nothing but
  `goalSha256` and the profile spec's types — no Node built-in, for the reason `goal/version.ts`
  states in its own docblock) holds `normalisePersona`, `contentHashOf`, `canonicalPersonaText`,
  `shinglesOf`, `minhashOf`, `bandKeysOf`, `jaccard` and `classifyPair`, each pure and each with
  exhaustive tests. The constants: `SHINGLE_WORDS = 5`, `NEAR_DUPLICATE_JACCARD = 0.8`,
  `CAPABILITY_OVERLAP_JACCARD = 0.6`, `MINHASH_PERMUTATIONS = 96`, `MINHASH_BANDS = 16`,
  `MINHASH_BAND_ROWS = 6`, `MINHASH_PRIME = 2_147_483_647`. `classifyPair` returns the pair's HIGHEST
  class and nothing else, in this order: **(1)** both `contentSha256` non-null and equal → `exact`,
  basis `content_hash`, score `1`; **(2)** equal normalised names → `exact`, basis `name`, score the
  exact body Jaccard; **(3)** body Jaccard ≥ `NEAR_DUPLICATE_JACCARD` → `near`, basis
  `body_shingles`; **(4)** `capabilityKeys` Jaccard ≥ `CAPABILITY_OVERLAP_JACCARD` → `overlapping`,
  basis `capability_keys`; **(5)** otherwise `null`. Arm (4) needs no "different names" test of its
  own: arm (2) has already claimed every equal-name pair, which is what "highest class only" means
  operationally. `jaccard` of two empty sets is **0**, not 1 — two personas that name no capability
  are not thereby the same specialist — and a body shorter than five words yields one shingle rather
  than none. **The near class's candidates come from banding, and the bound is stated rather than
  hoped for.** `minhashOf` builds a 96-value signature over the shingle set with a checked-in table of
  96 `(a, b)` multiplier pairs and a hand-rolled 32-bit FNV-1a of each shingle, every value reduced
  `mod MINHASH_PRIME` so it fits a signed 32-bit `integer`; `bandKeysOf` cuts it into
  `MINHASH_BANDS = 16` keys of `MINHASH_BAND_ROWS = 6` values each, stored as
  `SlaveTemplate.bodyBands String[] @default([])`. Two rows are CANDIDATES exactly when they share a
  band key: at a true Jaccard of 0.9 that happens with probability 1 − (1 − 0.9⁶)¹⁶ ≈ **0.999995**, at
  0.8 ≈ **0.992**, at 0.5 ≈ 0.22, and at 0.3 ≈ **0.012** — so a five-thousand-row catalog yields on the
  order of sixty candidate pairs per row and not six hundred. The exact Jaccard is then computed for candidates only.
  *(verified: this is the one place the direction had to bend, twice. The ruling said a 64-value
  signature in 16 bands of 4. That banding detects marginally better — 1 − (1 − 0.8⁴)¹⁶ ≈ 0.9998 at
  the threshold — but its noise floor is 1 − (1 − 0.3⁴)¹⁶ ≈ 0.12, which at five thousand rows is six
  hundred candidate pairs per row: the bound the ruling itself asks me to state is the thing that
  fails, and the candidate cap below would be clipping real work on an ordinary catalog. 96 values in
  16 bands of 6 keeps the band count, trades eight tenths of one percent of detection AT the threshold
  (0.9998 → 0.992, and 0.999995 at a Jaccard of 0.9, where any pair a person would call a near
  duplicate actually sits) for a tenfold cut in the noise floor. And the column
  is `bodyBands String[]`, not `bodySignature Int[]`: the band keys ARE the signature, re-encoded, and
  the only operation anything performs on it is "do these two rows share a band", which a list of 96
  integers cannot answer without a second derived column holding exactly these strings. One column
  rather than two.)* Every loop is bounded: the pass reads a projection —
  `{ id, name, contentSha256, capabilityKeys, bodyBands }` — for at most `DUPLICATE_SCAN_MAX = 5000`
  rows, id ascending, which is about five megabytes held once; candidate pairs are capped at
  `DUPLICATE_CANDIDATES_MAX = 200` per row, taken id ascending so the choice is deterministic; and the
  `profileSpec` of candidate rows is read in batches capped at `DUPLICATE_SPECS_MAX = 1000`, which is
  the only read of a large column the pass makes. `score` is `Math.round(x * 1000) / 1000` of the
  Jaccard. *(verified: `score` is a `Float`, not a `Decimal(4,3)`. This schema has no `Decimal` column
  anywhere and `Float` is what every ratio and every money figure in it is; a Prisma `Decimal` arrives
  in JavaScript as a Decimal.js object that is not JSON-safe, so making a display ratio the schema's
  first one would put a `.toNumber()` in every read path from `packages/control` to the browser. The
  rounding at write time is what makes the stored number exactly the number the label prints and the
  number a test compares.)* What this deliberately does NOT do: it computes no fourth class, it scores
  nothing "overall", it never merges, renames or rewrites a row, and it does not look at
  `profileOverrides` — the classes are about the persona somebody published, not about what an
  operator did to it since.

- **R5 — One row per ordered pair, a dismissal is a person's stamp on it, and nothing is ever
  deleted.** `model TemplateDuplicate { id String @id @default(uuid()), aId String, bId String, class
  DuplicateClass, basis DuplicateBasis, score Float, detectedAt DateTime @default(now()), dismissedAt
  DateTime?, dismissedBy String?, a SlaveTemplate @relation("TemplateDuplicateA", fields: [aId],
  references: [id], onDelete: Cascade), b SlaveTemplate @relation("TemplateDuplicateB", fields: [bId],
  references: [id], onDelete: Cascade) }` with `@@unique([aId, bId])` and `@@index([bId])`.
  `SlaveTemplate` carries the two back-relation fields Prisma requires for those relations —
  `duplicatesA TemplateDuplicate[] @relation("TemplateDuplicateA")` and
  `duplicatesB TemplateDuplicate[] @relation("TemplateDuplicateB")` — and they are exactly what R6's
  relation filter reads. `DuplicateClass = exact | near | overlapping` and `DuplicateBasis =
  content_hash | name | body_shingles | capability_keys`. **`aId < bId` is the WRITER's rule**, enforced by one helper
  `orderedPair(x, y)` that every write path goes through, pinned by a unit test and by the gate.
  *(verified: not a database CHECK constraint, however much it wants to be one. M42 erratum E23 makes
  the migration proof `prisma migrate diff --from-config-datasource --to-schema … --config
  packages/db/prisma.config.ts` → "No difference detected", and a constraint hand-added to the
  migration SQL that the Prisma schema cannot express is precisely a difference that proof would
  report forever. `basis` is one column beyond the direction's list, for M53 R1's reason that M54 R4
  cites for its own two: a surface must be able to answer a question without a join or a guess.
  Without it, "these two are the same" cannot be told from "these two are spelled the same", and the
  operator's next action differs completely between those.)* **The importer never dismisses and never
  deletes a template**: `dismissedAt`/`dismissedBy` are written only by
  `setTemplateDuplicateDismissal(pairId, dismissed, by)`, and a dismissed pair stays in the table
  forever, greyed rather than gone, with a Restore beside it. `deleteSlaveTemplate`
  (`packages/control/src/org.ts:1034-1047`) is unchanged and remains the only way a row leaves this
  product — a person's act, through `DangerConfirm`, never an import's. A template's deletion cascades
  its pairs, which is the one automatic removal in the design and is the right one: a pair naming a
  row that no longer exists is not a signal, it is a dangling reference. **`TemplateDuplicate` is
  derived state and a recompute may retire a row**: `recomputeTemplateDuplicates()` re-classifies the
  whole table, updates `class`/`basis`/`score` in place (keeping `detectedAt` and any dismissal), and
  removes a pair that no longer classifies at all. The residual is stated rather than hidden: a pair
  that stops classifying and later classifies again comes back undismissed. What this deliberately
  does NOT do: it does not merge two templates, it does not offer a "delete the duplicate" action, it
  writes no event, and it keeps no history of dismissals beyond the one stamp.

- **R6 — The signal is shown where the row is, in words, with the raw class one attribute away.**
  `DUPLICATE_CLASS_LABEL: Record<DuplicateClass, string> = { exact: 'Duplicate of', near: 'Similar
  to', overlapping: 'Overlaps' }` and `DUPLICATE_BASIS_LABEL: Record<DuplicateBasis, string> =
  { content_hash: 'same persona text', name: 'same name', body_shingles: 'overlapping text',
  capability_keys: 'overlapping capabilities' }` live in `packages/domain/src/catalog/duplicate.ts`,
  beside the enums they name, so the CLI and the web read one table. **The Catalog row** gains one
  chip, `catalog-duplicate-<templateId>`, reading `Duplicate of Backend Architect` /
  `Similar to …` / `Overlaps …` — the highest-class undismissed pair, with `+N` when the row has
  more — carrying `data-class` with the raw member, `data-score`, and a `title` that says the basis,
  the score to three decimals, and the one sentence R9 requires: *evidence is recorded per profile, so
  two rows split their own record.* **The filter bar** gains a sixth control, a `<select>` named
  `catalog-duplicates-select` over `any | exact | near | overlapping | none`, which is a Prisma
  relation filter over both sides — `OR: [{ duplicatesA: { some: { … } } }, { duplicatesB: { some: { …
  } } }]` with `dismissedAt: null` in the `some`, and `none` its `NOT` — and a seventh, the activation
  chips `catalog-active-chip-active` / `-inactive` in the source chips' own two-value shape. **The
  row's toggle** is `catalog-activate-<templateId>`, a button reading `active` or `inactive` with
  `data-active` carrying the boolean, posting to
  `POST /api/org/templates/[templateId]/activation`; it stops propagation the way the delete control
  beside it already does, so activating a row does not also open its drawer. **The drawer** gains a
  fourteenth `DetailsGroup`, `duplicates`, titled `Duplicates`, after `Source`: one line per pair —
  the class label, the other template's name as a button that opens ITS drawer, the score, the basis
  label, the date, and Dismiss or Restore — read from
  `GET /api/org/templates/[templateId]/duplicates`. Nothing is removed from any of these surfaces
  (`docs/ia.md` rule 2) and no surface prints `exact`, `near`, `overlapping`, `content_hash` or
  `capability_keys` as visible text (rule 3). `docs/ia.md`'s `/workforce` row gains M55's sentence.
  What this deliberately does NOT do: it puts no duplicate marker on any surface outside the Workforce
  Catalog — not on a worker, not on a task, not on the Organization view — because the signal is about
  two catalog rows and a worker hired from one of them is a different subject; and it offers no bulk
  dismiss.

- **R7 — An import walks in batches, reports counts by outcome and by class, and says one line per row
  only when asked.** `IMPORT_BATCH_SIZE = 100`. The row loop is unchanged in every way that matters —
  **one transaction per ROW, M42 R2** — and the batch is a unit of REPORTING and of bounded reads: one
  progress line per batch on stdout (`… 200/296 rows — created 198, updated 0, unchanged 0, skipped
  2`), and the three post-passes chunk their id lists by the same number so a `findMany({ where: { id:
  { in: … } } })` never carries a three-hundred-element — or five-thousand-element — `IN` list.
  `ImportReport` gains `duplicates: Readonly<Record<DuplicateClass, number>>` and `scanTruncated:
  boolean`; `describeImport` (`apps/orchestrator/src/cli.ts:1267`) prints the four outcome counts it
  prints today, the skip counts BROKEN DOWN BY REASON, and one duplicates line
  (`duplicates: 3 exact, 3 near, 12 overlapping`), and its per-row lines — `created  <name>  [<role>]
  <sourceId>` and the rest — move behind `--verbose`. The skipped rows' reasons are the one thing that
  still prints unconditionally at summary level, because a skip is a thing the operator has to act on
  and a count of four with no reasons is not actionable. `CatalogImport` gains no column: the
  duplicate counts ride inside the existing `report Json`, which is where `RowOutcome[]` already
  lives, and `listCatalogImports`'s view gains `duplicates` read out of it — so `list-imports` and the
  web panel show the same six numbers. **Duplicate detection is a fourth post-pass**,
  `writeTemplateDuplicates(templateIds)`, running after the row loop beside `writeCollaborationHints`
  and `writePersonaRunbooks` and for their exact reason (plan erratum E11): a persona imported later
  in the same run is not in the table while an earlier row is being written, so pairing before the
  loop ends would miss every pair inside the run. What this deliberately does NOT do: it does not
  parallelise rows, it does not stream, it opens no transaction around the batch, and a whole-catalog
  import of about three hundred rows completes in ONE command with no resume token — the operator
  re-runs it, which M42 R2 already makes free.

- **R8 — Attribution is M46's and stays M46's; the import refuses a checkout whose licence it cannot
  name.** `SlaveTemplate.sourceRevision`/`sourceLicense` and `ProfileSpec.source { repository, path,
  revision, license, importedAt, mappingQuality }` are the whole of the attribution story and this
  milestone adds nothing to it; the Source group in the profile drawer already prints the licence
  (`ProfileDrawer.tsx:357-361`), so M55 asserts that rather than building it. **No THIRD_PARTY notice
  is required and none is added**: the roadmap's rule (lines 29-30 and 60) attaches a notice to
  content that SHIPS with the product, and no persona text ships — the catalog is a path on the daemon
  host's disk, nothing is vendored, and the web renders a profile from the database at request time
  through `GET /api/org/catalog` and `/api/org/templates/[id]/profile`, so not one persona byte is in
  the client bundle. The day content is vendored is the day the notice is required, and §6 says so.
  **What IS new is a refusal**: `importCatalog` returns `err({ kind: 'license_unknown', directory })`
  when `input.license` is null, **before `syncCapabilityTaxonomy` and before any row is read** — the
  same position `catalog_empty` occupies — unless `allowUnknownLicense: true` was passed, from the
  CLI's `--allow-unknown-license`. The refusal joins the three homes every refusal has: the
  `ControlRefusal` union and `refusalText` in `packages/control/src/refusal.ts`, the CLI, and
  `apps/web/test/refusal-status.test.ts`'s exhaustive `Record<ControlRefusal['kind'], true>`; it is a
  409 by `refusalStatus`'s suffix rule (`apps/web/src/server/refusalStatus.ts:12`), which is right — an
  unlicensed checkout is a state, not a missing id. `refusalText` says what to do: *this catalog has no
  LICENSE file at its root, so nothing can record where its personas came from; pass
  `--allow-unknown-license` to import it anyway.* What this deliberately does NOT do: it does not read,
  parse or validate a licence's TEXT, it does not refuse a licence it dislikes, it copies no licence
  file anywhere, and it does not make `sourceLicense` non-null on the column.

- **R9 — Evidence keying is untouched, and the chip says why that matters.** `profileKeyOf`
  (`packages/domain/src/evidence/derive.ts:25-28`) still returns `template:<id>` per template id;
  `EvidenceRecord`, `evidenceForProfiles`, the Evidence tab and M53's ranking read exactly what they
  read today. The consequence of an undetected duplicate is therefore real and unchanged — two rows
  for one specialist split one sample, and with `EVIDENCE_MIN_SAMPLE` at 5 (`packages/domain/src/capability/rank.ts:18`) two halves of six runs can
  both read "Insufficient evidence" where one row would have said a rate — and this milestone's answer
  to it is to SHOW the duplicate rather than to key around it. The duplicate chip's `title` carries
  that sentence (R6). **Merged evidence reading across a duplicate pair is carried backlog**, named in
  §6: it is a change to how a rate is computed, it would have to decide what happens when a pair is
  dismissed or retired, and inventing it beside the detector that found the pair would be two unproven
  mechanisms guarding each other. What this deliberately does NOT do: no `EvidenceRecord` column, no
  change to `profileKeyOf` or `isBespokeProfileKey`, and no merge.

- **R10 — The operator's surface is one CLI command with four subcommands, and the web does what the
  web can do.** `template list [--division <d>] [--active|--inactive] [--duplicates <class>]`,
  `template activate --template <id>`, `template deactivate --template <id>`, and
  `template duplicates [--template <id>] [--recompute] [--dismiss <pairId>] [--restore <pairId>]`
  join `capabilities`, `permissions`, `credential`, `broker` and `staffing` in
  `apps/orchestrator/src/cli.ts` under the `const sub = argv[1] ?? 'list'` shape those five already
  use (`cli.ts:2089,2135,2184,2931,3011`). `import-catalog` gains three bare flags — `--activate`,
  `--verbose`, `--allow-unknown-license` — placed LAST in the usage line, M42 erratum E11's rule for
  boolean flags, and read with `'flag' in flags` rather than `!== undefined`. `template duplicates
  --recompute` is the whole-table pass (R4/R5) and is also the backfill: it fills `contentSha256`,
  `bodyBands`, `searchText` and `recommendedSkills` for any row that has a `profileSpec` and lacks
  them, which is every row imported before this milestone. It deliberately does NOT recompute
  `capabilityKeys` — that is the importer's write, against a taxonomy the import also syncs, and a
  second writer for one column is how two writers disagree. The web keeps the acts a page can honestly
  complete: the activation toggle and the dismissal, both single-row, both idempotent. What this
  deliberately does NOT do: there is no web "import" form (M46's ruling, unchanged — the catalog is a
  path on the daemon host), no web "recompute" button (a whole-table pass behind a request that can
  time out is a worse answer than a CLI line), and no bulk activate anywhere.

- **R11 — The Supervisor's machinery is not touched, and the one residual is named.** `decide()`,
  `evaluateGuardrails`, `workspaceSpend`, `stats.spentUsd`, the seventeen `SITUATION_KINDS` and the
  seventeen `ACTION_KINDS` are unchanged and asserted so. `formTeam`, `rankCandidates`, `actionOf` and
  `carryOut` are unchanged: an inactive template simply is not in `SupervisorWorld.catalog`, so it can
  never be a `TeamSource` of any kind — `existing_worker`, `company_worker`, `project_worker` or
  `temporary` — and `hire_from_catalog` is never proposed for it. `SupervisorWorld` gains no field and
  no loader; `SupervisorCatalogEntry` (`packages/domain/src/supervisor/world.ts:164-173`) keeps its six
  fields. **The residual:** a `SupervisorDecision` recorded while a template was active, and approved
  by a person after it was deactivated, still hires from it — `carryOut`'s `hire_from_catalog` arm
  passes the stored `templateId` to `hireFromTemplate` and neither reads `active`. That is bounded by
  `PENDING_TTL_MS` (24 hours) and it is arguably correct — the decision is the record of what was
  proposed and a person is approving it with their eyes open — but it is a place where "never active
  by default" is not "never hired", and §6 carries it rather than letting a reader discover it.
  What this deliberately does NOT do: it adds no `active` check inside `hireFromTemplate` (that verb is
  also the CLI's and the web's manual hire, which R2 keeps open on purpose), and it raises no situation
  about inactive candidates.

- **R12 — What the five gates that already import a catalog must change, named one by one.**
  `gate:m42-catalog-import`: **(a)** every one of its `import-catalog` invocations gains
  `--allow-unknown-license`, because `scripts/fixtures/catalog-m42/` is the ONE fixture catalog with no
  `LICENSE` file and R8 now refuses it — kept as an absence rather than fixed, so the roster covers
  both states; **(b)** `snapshotOf` (`gate-m42-catalog-import.mjs:137-151`) gains `active`, since its
  own comment calls it "everything an import is allowed to move on a template" and the hand-made
  collision row must be proved still `true` after the import; **(c)** stage 1 asserts the two created
  rows are `active: false`, which is the new default said out loud where the old defaults (`null`
  model, `null` provider) are already asserted; **(d)** stage 5 is deliberately NOT given an
  activation step — it builds a company from the two imported templates through the real CLI and
  dispatches a task, which is exactly the manual path R2 keeps open on an inactive row, and leaving it
  alone turns an unchanged stage into a proof; **(e)** `deleteGateTemplates` needs no new statement,
  because `TemplateDuplicate` cascades from `SlaveTemplate`, but `dumpGateRows` gains the pairs so a
  failure says what was detected. `gate:m47-team-formation` and `gate:m50-ephemeral` **both pass
  `--activate` on their import**: each drives the Supervisor to `hire_from_catalog` (two and four
  occurrences respectively) and would otherwise measure an empty candidate list.
  `gate:m46-workforce-catalog` and `gate:m48-runbooks` change nothing: neither hires from the catalog,
  m46's stage 2a search survives because `searchText` holds the summary (R3), and m46's stage 2b
  string `1 template` survives because `catalog-count` reads `N templates` when the page IS the whole
  answer and `showing N of M templates` only when it is not. `packages/db/src/seed.ts` writes
  `active: true` on the templates it creates (`:134,159,176`) and its TRUNCATE list (`:49`) gains
  `"TemplateDuplicate"`, the M42 erratum E11 rule for a new table. What this deliberately does NOT do:
  it does not enlarge any existing fixture catalog, it does not add a `LICENSE` to `catalog-m42`, and
  it does not renumber or reorder a stage in any gate it touches.

- **Global constraints.** **Never a real model call** in a test or a gate
  (`packages/providers/test/fake-claude.mjs`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`); a real call needs the
  user's explicit consent, per call. **One vitest run at a time**, and never a gate beside one — they
  share one Postgres, and a running daemon breaks the subscribe test. **`npm run web:build` is never
  run while `next dev` is up**, and it is the last gate of a web task, because tsc and vitest do not
  see bundler-only breakage. **No `prettier`** — this repository has no config and no dependency, and
  `prettier --write` reformats against the house style. **`apps/web` imports carry no `.js` suffix**;
  every other package's do. **A piped command's status is `${PIPESTATUS[0]}`**, never `$?`.
  **`tsc --build` runs after `db:generate`**, and `npm run typecheck` (which also checks every
  `tsconfig.test.json` and `apps/web`) is what the pre-push hook runs — a green `tsc --build` can
  still fail it. **The product word is `slave`** (`gate:m26-vocabulary`), and **M42 erratum E5 stands**:
  the reference catalog's directory name contains the forbidden word, so no product string, comment,
  README line, test, fixture or default may name it — `--catalog` defaults to `basename(dir)` at
  runtime and every checked-in example names a fixture catalog. **Labels never keys** (`docs/ia.md`
  rule 3): every new vocabulary gets a label table beside the thing it names, and the raw value stays
  in `title`, a `data-` attribute, or the expanded view. **Nothing is removed, only moved** (rule 2).
  **Real is not simulated** (rule 4). **A refusal lives in three homes** — the `ControlRefusal` union
  and `refusalText`, the CLI, and `apps/web/test/refusal-status.test.ts`'s exhaustive record.
  **A refusal after a write inside a Prisma transaction THROWS**; a returned `err()` commits — the
  `CatalogRowRefused` idiom `catalog.ts:92-107` already states. **Untouched and asserted so:**
  `decide()`, `evaluateGuardrails`, `workspaceSpend`, `stats.spentUsd`, the seventeen
  `SITUATION_KINDS`, the seventeen `ACTION_KINDS`, `formTeam`, `rankCandidates` and `profileKeyOf`.
  **The migration is additive** — seven columns on `SlaveTemplate`, one model, two enums, three indexes
  (one unique, two secondary), one data statement (`UPDATE "SlaveTemplate" SET "active" = true`) and
  one best-effort `searchText` backfill in SQL — **deterministic, applied to both databases, with the
  Prisma 7 diff proof** (M42 E23); `20260914090000_m55_catalog`. **No new event type**: the catalogue
  stays at 61 and `packages/domain/test/supervisor/timeline.test.ts:18-19` does not move (R2).
  **Every gate gets its own `SLAVEOFAI_STATE_DIR`** through `scripts/lib/state-dir.mjs`, never a
  hand-rolled copy. **Every commit carries the session's trailers.** **The test baseline does not go
  down: ≥ the M54 final ladder, recorded in the plan**, and the new unique index is checked against
  every package's fixtures, not only the one under edit — only the full suite can see a fixture
  collision in another package. **29 CI gates become 30.**

## 2. Surfaces after M55
Domain: `catalog/duplicate.ts` (`normalisePersona`, `canonicalPersonaText`, `contentHashOf`,
`shinglesOf`, `minhashOf`, `bandKeysOf`, `jaccard`, `classifyPair`, `orderedPair`, the seven
constants, `DUPLICATE_CLASS_LABEL`, `DUPLICATE_BASIS_LABEL`, the `DuplicateClass`/`DuplicateBasis`
types and `DuplicateFacet`), `SEARCH_TEXT_MAX_CHARS`. No new event, no change to
`packages/domain/src/events/schema.ts`, `LANE_BY_TYPE`, `situations.ts`, `actions.ts`, `team.ts` or
`evidence/derive.ts`. DB: `SlaveTemplate.active`, `.activationChangedAt`, `.activationChangedBy`,
`.contentSha256`, `.bodyBands`, `.searchText`, `.recommendedSkills`; `model TemplateDuplicate`; `SlaveTemplate.duplicatesA`/`.duplicatesB`; enums
`DuplicateClass`, `DuplicateBasis`; `@@index([active, name])` on `SlaveTemplate`,
`@@unique([aId, bId])` and `@@index([bId])` on `TemplateDuplicate`; migration
`20260914090000_m55_catalog`; `seed.ts`'s `active: true` and its TRUNCATE list. Control:
`catalog.ts`'s `license_unknown` refusal, `--activate`/`--verbose` inputs, `IMPORT_BATCH_SIZE`, the
batched post-passes, the widened `ImportReport` and `CatalogImportView`, and a `listWorkforceCatalog`
that filters and pages in the database with `CATALOG_PAGE_SIZE`; `duplicates.ts`
(`writeTemplateDuplicates`, `recomputeTemplateDuplicates`, `setTemplateDuplicateDismissal`,
`listTemplateDuplicates`, `DUPLICATE_SCAN_MAX`, `DUPLICATE_CANDIDATES_MAX`, `DUPLICATE_SPECS_MAX`);
`org.ts`'s `setTemplateActivation` and `createTemplate`'s `active: true`; `supervisorWorld.ts`'s
`active: true` clause and rewritten `CATALOG_ENTRIES_MAX` docstring; one new refusal kind.
Supervisor: NOTHING — no situation, no action, no world field, no loader, no change to `decide()` or
`carryOut`. Orchestrator: `template list|activate|deactivate|duplicates`, three flags on
`import-catalog`, a `describeImport` that summarises by default and itemises under `--verbose`.
Web: `GET /api/org/catalog` (paged, seven filters), `POST /api/org/templates/[id]/activation`,
`GET /api/org/templates/[id]/duplicates`, `POST /api/org/duplicates/[pairId]/dismissal`;
`WorkforceCatalog.tsx` (the activation toggle, the duplicate chip, `Show more`, the count sentence),
`CatalogFilterBar.tsx` (the duplicates select, the activation chips, the debounce),
`ProfileDrawer.tsx` (the `Duplicates` group), `lib/catalogFilters.ts` and `hooks/useCatalogFilters.ts`
(seven params), `server/org.ts`, `docs/ia.md`. Scripts: `scripts/gate-m55-catalog.mjs`,
`scripts/gate-fakes/gen-catalog.mjs`, and the named edits to `gate-m42`, `gate-m47`, `gate-m50`.

## 3. Gate
`scripts/gate-m55-catalog.mjs`, `gate:m55-catalog` after `gate:m54-triggers` in `package.json` and in
CI (`.github/workflows/ci.yml`), **README 29 → 30 gates** in both places (the roster paragraph at
`README.md:886-890` and the count at `:971`); real daemon, fake CLI, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`,
Playwright, zero spend, its own `SLAVEOFAI_STATE_DIR` from `scripts/lib/state-dir.mjs`, the
`mkdtemp` + temp-checkout shape `gate-m42`/`gate-m46` already use.

**The fixture is GENERATED, not checked in.** `scripts/gate-fakes/gen-catalog.mjs` — the seventh file
in `scripts/gate-fakes/` and the first that is a WRITER rather than a stand-in for a binary — takes an
output directory and a seed in argv and writes `N = 120` vocabulary-clean personas into it: a
`divisions.json` with four divisions, a `LICENSE` whose first line is `MIT License`, and 120 Markdown
files whose front matter and body are composed from a fixed word list by a deterministic
seeded PRNG, so the same seed always writes the same bytes. **The planted pairs:** three `exact` (one
pair byte-identical under a different `sourceId` and a different division; one pair identical after
NFC, case and whitespace normalisation only; one pair whose names differ only in case), three `near`
(bodies sharing about 90% of their 5-word shingles), three `overlapping` (different names, different
prose, `capabilityKeys` sharing 4 of 5), and **three near-misses**, one just under each threshold —
a body pair at ≈0.7 Jaccard, a capability pair at 2 of 5 shared, and a name pair differing by one
word. 120 personas is deliberately more than any fixture in the tree and deliberately far less than a
real catalog: it is enough for two full pages at `CATALOG_PAGE_SIZE = 100` and for the batching to run
twice, and small enough that a failing gate prints a diagnosable dump. Twelve stages:

1. **The whole catalog arrives in one command, and the summary is the report.** `import-catalog --dir
   <generated> --by gate` with no `--verbose`: exit 0; `created 120, updated 0, unchanged 0, skipped
   0`; two progress lines (`100/120`, `120/120`); the duplicates line reading `3 exact, 3 near, 3
   overlapping`; **zero** per-row `created  …` lines in stdout; one `CatalogImport` row whose four
   counters match and whose `report` JSON carries the same three duplicate counts. The same import
   under `--verbose` prints 120 per-row lines. `list-imports` shows the six numbers.
2. **The same import again changes nothing.** `unchanged 120`, `created 0`; every `SlaveTemplate` row's
   `updatedAt`-equivalent fields (`sourceSha256`, `profileSha256`, `importedAt`, `contentSha256`,
   `bodyBands`, `searchText`) are byte-identical to stage 1's snapshot; the `TemplateDuplicate` rows'
   `id` and `detectedAt` are unchanged — a re-import re-detects the same pairs and writes no new rows.
3. **Nothing that arrived is hirable.** All 120 rows read `active: false`. A workspace is created with
   a task declaring a capability only a generated persona provides; a real daemon ticks; the Supervisor
   raises `capability_unstaffed` and **no `SupervisorDecision` and no proposal names any of the 120
   template ids** — asserted over every decision row's action payload, not only over the latest.
   `SupervisorWorld.catalog` is read back through the same loader and contains none of them.
4. **`--activate` and the toggle each make exactly one row rankable.** `template activate --template
   <id>` on one persona: the row reads `active: true` with `activationChangedAt`/`activationChangedBy`
   set; the next tick proposes `hire_from_catalog` naming THAT template and no other. A second
   persona is activated through the Catalog tab's toggle in the browser and reaches the same state.
   A third import run with `--activate` creates its rows active, proving the flag. `template
   deactivate` puts the first back, and the following tick proposes it no more.
5. **The three classes are detected, with the planted pairs and the right basis.** Exactly nine
   undismissed `TemplateDuplicate` rows for the generated catalog: three `exact` (bases `content_hash`,
   `content_hash`, `name`), three `near` (basis `body_shingles`, every score ≥ 0.8), three
   `overlapping` (basis `capability_keys`, every score ≥ `CAPABILITY_OVERLAP_JACCARD`, names differing,
   and each pair's BODY Jaccard below `NEAR_DUPLICATE_JACCARD` — which is why the class is
   `overlapping` and not `near`);
   every row satisfies `aId < bId`; no pair appears twice and no pair appears under two classes.
6. **The near-misses are not signals, and a recompute agrees.** None of the three planted near-miss
   pairs has a row, in either order. `template duplicates --recompute` over the whole table reports the
   same nine pairs, updates no `detectedAt`, and creates no tenth; running it twice is a no-op.
7. **A dismissal is a person's and it survives an import.** `template duplicates --dismiss <pairId>`
   stamps `dismissedAt`/`dismissedBy`; the row is still in the table; the Catalog chip for that pair is
   gone and the `duplicates=none` facet now includes that template. A third `import-catalog` run and a
   `--recompute` both leave the dismissal exactly as it was. `--restore` puts the chip back.
8. **Nothing was deleted.** `SlaveTemplate` count before and after every import, recompute and
   dismissal in this gate is the baseline plus 120; no row's `sourceId`, `name` or `profile` changed
   except through the update path stage 2 measured; the seeded templates are untouched and still
   `active: true`.
9. **The Catalog tab pages, counts and filters — in the browser.** `/workforce?tab=catalog` shows 100
   rows and `catalog-count` reads `showing 100 of <total> templates`; `catalog-more` loads the rest and
   the count becomes `<total> templates`; the division select, the capability select (whose options are
   labels and whose values are keys), the skill select, the source chips, the activation chips and
   `catalog-duplicates-select` each narrow the list and each writes its param into the URL; a reload of
   that URL renders the same rows; `catalog-duplicates-select` on `exact` leaves exactly the six
   templates of the three exact pairs, and on `none` leaves the rest. A search that matches only a
   persona's SUMMARY still finds it.
10. **Words, never keys.** No cell, chip, option or title added by this milestone prints `exact`,
    `near`, `overlapping`, `content_hash`, `name`, `body_shingles`, `capability_keys`, `true` or
    `false` as visible text; `data-class`, `data-score`, `data-active` and `title` carry them; the
    duplicate chip's `title` contains the sentence about evidence being recorded per profile; and
    `profileKeyOf` is asserted from the module to be unchanged.
11. **A checkout with no licence is refused, and the Source group says what a licensed one is.** The
    generator writes a second catalog with its `LICENSE` removed: `import-catalog` exits non-zero with
    `refusalText({ kind: 'license_unknown' })`, **writes no `SlaveTemplate` row, no `CatalogImport` row
    and no `TemplateDuplicate` row** — all three counted before and after — and the same command with
    `--allow-unknown-license` imports it with `sourceLicense: null`. A licensed row's drawer shows
    `MIT` in the Source group, and the page's HTML is grepped for a sentence from a persona body to
    prove the text came from the database at request time and is in no bundle.
12. **Nothing else moved.** `SITUATION_KINDS` is seventeen and `ACTION_KINDS` is seventeen, asserted
    from the modules; `LANE_BY_TYPE` is 61, asserted from the module; `SupervisorWorld` gained no
    field; `Actor`, `Task` and `Workspace` gained no column, asserted from the schema; and `git status
    --porcelain` after a green run is what it was before.

Moved pins, named: `gate:m42-catalog-import` takes R12's five edits (a)-(e);
`gate:m47-team-formation` and `gate:m50-ephemeral` each gain `--activate` on their import;
`gate:m46-workforce-catalog` and `gate:m48-runbooks` are unchanged and re-run, which is itself the
assertion that R3's rewrite of the read model kept the surface; `apps/web/test/refusal-status.test.ts`
gains `license_unknown`; `packages/control/test/catalog*.test.ts` gain the activation, licence,
batching and duplicate cases and keep every existing one unchanged;
`packages/domain/test/catalog/duplicate.test.ts` is new and exhaustive over the five `classifyPair`
arms, the three normalisation passes, the empty-set and short-body edges, and the determinism of
`minhashOf` across two calls. `gate:m14-fidelity` screenshots are regenerated in a deliberate commit
only if the Catalog tab is in one — it is not (`gate:m14-fidelity` takes `/workforce`'s DEFAULT tab,
`WorkforceCatalog.tsx:22-27`), so **no screenshot moves and none is regenerated**.

## 4. Out of scope
Fetching a catalog over the network — from GitLab, from GitHub, from anywhere: the source is a local
checkout the operator already has, which is M42's ruling and M46's, and a fetch would need a token, a
cache, a trust decision about a URL and a story for what happens when the remote changes under a
re-import. **This is never, not later.** Vendoring any persona into this repository (M42 §3, and the
vocabulary gate). Merging two templates into one, or deleting the "loser" of a pair — nothing is ever
auto-deleted, and a merge is a write across `CompanySlave`, `Slave`, `EvidenceRecord`,
`CollaborationHint` and `RunbookTemplate` that would need its own milestone. Merged evidence reading
across a duplicate pair (R9). Auto-activation policies of any kind. A fourth duplicate class, a
similarity over the STRUCTURED fields rather than the text, or any embedding. A full-text or trigram
index. Importing skills or tools from a persona's front matter (M42 §3, still). Colours and emoji.
Summarising an over-long persona (M42 R2f: the operator shortens the file). A web import form, a web
recompute button, or a bulk activate. Charging an import against a budget. Any change to
`decide()`, `evaluateGuardrails`, `workspaceSpend`, `stats.spentUsd`, `SITUATION_KINDS`,
`ACTION_KINDS`, `formTeam`, `rankCandidates` or `profileKeyOf`. A new event type. **And the line every
predecessor carries is discharged here: until this milestone the product shipped five seed templates
and imported five more in a fixture, and every claim about a real catalog was a claim about a
directory nobody had actually read three hundred files out of — after it, the whole thing goes in, in
one command, inert until somebody says otherwise, with every pair it noticed named beside the row it
is about.**

## 5. Errata — where execution corrects this spec
None yet. Errata are added while the plan is written and while it is executed, each as
`**En (amends Rx)** — <one-line claim>.` with its reasoning and file citations, the way M50's fifteen,
M51's, M52's fifteen, M53's and M54's were.

## 6. Carried backlog (M54 §6's list that M55 does not take, plus what M55 declines)
From M54 §6 — which reproduces M53 §6, which reproduces M52 §5, which reproduces M51's own final-review
deferred list; that session's `.superpowers/sdd` folder is no longer in the tree, so the spec prose is
the surviving copy — **M55 takes exactly one item and touches no other's files**: it takes `q`
undebounced, because R3 turns every keystroke into an `ILIKE` over the whole table and a cosmetic
item becomes a load-bearing one. Everything else M54 carried stays carried and untouched: the eight
files writing guardrail names as unchecked literals; `MODEL_PRICES` unpinned against
`CLAUDE_CODE_MODELS`; de-escalation lowering a run's word under a standing `toolCallCap`; the
candidates' vanished-run escalation; `runTapScript`'s missing timeout; a tap breaking between daemon
start and a spawn; the three web read models dividing by `maxToolCallsPerRun`; `upperBoundUsd`'s flat
cap rendering below the estimate; `brief.test.ts`'s contradicting comment; M4 Cursor's `rejected` line;
M7's two differently-scoped upper bounds; M8's write volume, to which M54 added one insert, one update
and two appends per delivery on the web process — **and to which M55 adds, per import, one duplicate
post-pass whose reads are bounded by `DUPLICATE_SCAN_MAX` and whose writes are one row per detected
pair, all on the CLI process and none on the pump**; the uncollected worktree from a pre-release
snapshot; the null-engagement temporary downgrade; `brief.ts`'s unordered team read;
`gate:m47-team-formation` stage 6's `recordDecision` flake; the singular worktree wording; a
non-temporary hire reusing an unreleased ephemeral worker; a reuse leaving a decision claiming an
engagement; `engagement_over` racing a dispatch; `AllSlavesTable` not sorting released rows last; the
three Overview panels each loading a Supervisor world; `tierOf` busy at draft time; **`CATALOG_ENTRIES_MAX`
by id — which R2 NARROWS rather than closes: the bound is now over active rows, a far smaller
population, and the 501st ACTIVE template by id is still invisible to the Supervisor**; pre-M47
templates keeping `capabilityKeys: []`; gates m8/m10/m13 outside CI; the m11 flake; m14 PNG
nondeterminism; mapper M6/M7/E23; `WorkforceClient`'s bare `<details>`; the drawer's spec-scoped
`rawOverride`; the `sourceRepository` asymmetry; `GET /api/org/catalog` principal harmonisation; M48's
`unknownStages`, persona runbook key collisions, `gate:m48` writing to a seed row, `runbooks show`
printing keys, `addRunbook`'s discarded `by`, and `stageTitle` vs swapped runbooks; M49's
workspace-only verified-FACT command names, company-scope condensation, the unbounded coverage query,
summaries never becoming sources, orphan candidates, no end-to-end failing-write test, and the shared
`block`/`singleLine`/`safe` helper; `HandoffContract.evidenceRequired` verified by nothing;
`broker.executed` with no consumer; a repository whose checkout moves splitting its own evidence; the
GIN index being this schema's first — **which R4 deliberately does not make it: the candidate index is
held in memory under `DUPLICATE_SCAN_MAX` rather than queried with `hasSome`, so the first GIN index in
this schema is still unwritten and is what a scan bound above five thousand rows would need**; M54's N
workspaces per external repository, GitLab adapter, comment events, outbound status, absent rate
limiting, absent `InboundEvent` replay and retention, the producer-less `custom` kind, the
log-only diagnosis of a mistyped `secretEnvVar`, and `GoalVersion.origin` as the schema's first
validated-object `Json` column on a history row.

**Newly carried by this milestone, from what it declined** (fourteen):
1. **An activation writes no event** (R2). The catalog has no workspace, `ExecutionEvent.workspaceId`
   is NOT NULL, and `activationChangedAt`/`activationChangedBy` are the record instead. A catalog-level
   event log — whatever shape it takes, a nullable column or a second table — is the thing that would
   close this, and it is bigger than one milestone's catalog import.
2. **A pending decision approved after a deactivation still hires** (R11), bounded by `PENDING_TTL_MS`.
3. **A dismissal does not survive a pair being retired and re-detected** (R5): `--recompute` removes a
   pair that no longer classifies, and it comes back undismissed if it later does.
4. **Free text matches seven fields, not fourteen** (R3): `operatingPrinciples`, `constraints`,
   `workflow`, `deliverables`, `successCriteria` and `collaborationHints` are not in `searchText`, and
   `searchText` is capped at 2,000 characters.
5. **`searchText` is a sequential `ILIKE` scan** (R3). A trigram index is the next step and would be
   this schema's first extension dependency.
6. **Near detection is probabilistic** (R4): about eight pairs in a thousand sitting exactly ON the
   0.8 threshold are missed, and about five in a million at a Jaccard of 0.9. Deterministic in the gate because the fixture's seed and the permutation table are fixed;
   not deterministic across a catalog nobody has seen.
7. **`DUPLICATE_SCAN_MAX = 5000`** (R4): a catalog beyond that is paired against its first five
   thousand rows by id and `scanTruncated` says so, which is a report and not a fix.
8. **`DUPLICATE_CANDIDATES_MAX = 200` per row** (R4), taken id ascending. It bites only where a
   catalog holds hundreds of near-identical personas, which is itself the signal, and what is lost
   there is the 201st instance of a duplicate the operator has already been told about.
9. **Merged evidence reading across a duplicate pair** (R9), explicitly declined: it changes how a
   rate is computed and has to decide what a dismissal means to a rate.
10. **`--recompute` does not fill `capabilityKeys`** (R10): a pre-M47 row keeps its empty list until an
    import writes it, because a second writer for that column is how two writers disagree.
11. **A row with no `profileSpec` gets no `contentSha256` and no `bodyBands`** (R1) and so takes part
    only in the name and capability classes.
12. **`writeCollaborationHints` still reads `{ id, name }` for EVERY template** in one query
    (`catalog.ts:529`) — about two hundred kilobytes at five thousand rows, once per import, and the
    one read in the import path that is not bounded by `IMPORT_BATCH_SIZE`.
13. **No THIRD_PARTY notice exists** (R8), correctly, because nothing ships; the day a persona is
    vendored is the day one is required, and the roadmap's rule (lines 29-30, 60) is where that is
    written down.
14. **No catalog is ever fetched over a network** (§4) — GitLab, GitHub or otherwise. Restated here as
    a permanent decline rather than a deferral, so a later reader does not mistake it for a to-do.
