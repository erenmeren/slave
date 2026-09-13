# M55 Full Catalog Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The whole persona catalog on an operator's disk — three hundred files, not five — goes into this product's catalog in one command, and the product is honest about what just arrived. None of it is hirable until somebody says so: an import produces a library, not a workforce. The catalog page stays a page you can work in when it holds hundreds of rows instead of dozens, because the filtering and the paging happen in the database rather than in a list somebody rendered whole. And the thing that actually goes wrong when you import three hundred strangers' personas — that a dozen of them are the same specialist under different names, and that half of them claim the same four capabilities — is shown as a signal beside the row it is about, in three named classes, with the number behind each one. The signal never deletes anything. A person may dismiss it; the importer may not.

**Architecture:** One new column decides who is a candidate. `SlaveTemplate.active` defaults to `false`, the migration turns every row that already exists to `true` so nobody's workforce empties on upgrade, and `loadCatalogEntries` — the ONE loader that turns a template into a hiring candidate — adds `active: true` to its `where`. `formTeam` and `rankCandidates` are pure functions over a `SupervisorWorld` and are not touched: the honest place to say "this is not a candidate" is where candidates are loaded. Four denormalised columns pay for four database-side `where` clauses that used to be in-memory filters over a JSON column — `searchText`, `recommendedSkills`, `capabilityKeys` (M47's, unchanged) and `bodyBands` — and `listWorkforceCatalog` stops being a whole-table `findMany`: seven filters become Prisma clauses, the page is a cursor over `(name, id)`, and the three facets are three bounded queries over the whole table rather than a fold over the page. The duplicate detector is PURE and lives in `packages/domain/src/catalog/duplicate.ts`, importing nothing but `goalSha256` and the profile spec's types, for the reason `goal/version.ts` states in its own docblock: `apps/web`'s client bundle imports this package and a `node:crypto` anywhere in its graph fails `web:build` outright. Detection is a fourth post-pass beside `writeCollaborationHints` and `writePersonaRunbooks`, after the row loop, because a persona imported later in the same run is not in the table while an earlier row is being written. `TemplateDuplicate` is one row per ordered pair, `aId < bId` by a writer's rule; the importer writes and updates, never deletes; `--recompute` re-classifies the whole table and may retire a pair; a person dismisses one and it stays in the table, greyed rather than gone. **No new event type**: the catalogue stays at 61, because `ExecutionEvent.workspaceId` is NOT NULL and a template belongs to no workspace — `activationChangedAt`/`activationChangedBy` on the row are the record, which is the rule M42 R5 and M54 R6 each wrote down before this one.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), zod, vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-13-m55-catalog-import-design.md` (rulings R1–R12; §2 surfaces; §3 gate, twelve stages; §4 out of scope; §5 errata; §6 carried backlog). Its parents are `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` (row M55 at line 47, and lines 19-23: extensions named as such), `docs/superpowers/specs/2026-09-13-m54-external-triggers-design.md` (the shared state directory, the "row and log line are the honest pair of homes" rule, the fixture-generator precedent), `docs/superpowers/specs/2026-09-11-m46-*` and M42's own (`sourceId`, `sourceSha256`, `locally_edited`, "nothing is ever deleted", the `CatalogImport` row), `docs/decisions/0003-single-write-gate.md` and `docs/ia.md` (rule 2, nothing is removed only moved; rule 3, labels never keys; rule 4, real is not simulated). **This is the milestone that discharges the line every predecessor carries: until now the product shipped five seed templates and imported five more in a fixture, and every claim about a real catalog was a claim about a directory nobody had actually read three hundred files out of — after it, the whole thing goes in, in one command, inert until somebody says otherwise, with every pair it noticed named beside the row it is about.**

Plan-time errata E1–E12, every one read out of the code and baked into the tasks below, plus the errata execution itself ruled (E13 onward, each naming the round that produced it). The long form, with file and line evidence, is in the session notes (`m55-plan-notes.md`); each is also to be appended to the spec's §5 during execution.

- **E1 (amends R3 and R12) — the capability facet's options become taxonomy KEYS, so `gate:m46-workforce-catalog` stage 2b DOES change, and it changes to the SKILL select.** R12(d) says m46 "changes nothing". It cannot be true. `scripts/gate-m46-workforce-catalog.mjs:121` sets `CORE_BUILDER_CAPABILITY = 'Design the module boundary'` and `:728` does `getByTestId('catalog-capability-select').selectOption(CORE_BUILDER_CAPABILITY)` — a FREE-TEXT persona bullet. R3 makes that select's options `SELECT DISTINCT unnest("capabilityKeys")`, and **not one of `scripts/fixtures/catalog-m46/`'s four personas resolves a single taxonomy key**: their capability lines are `Design the module boundary`, `Write the test before the code` (h3 sub-headings under `## Your Core Mission`, lifted by `packages/domain/src/catalog/spec.ts:322-327`), `Reading a failing build back to its first cause`, `Rollout planning: …` and `Rollback drills: …`, and `normaliseCapabilities` (`packages/domain/src/capability/taxonomy.ts:73-91`) matches on the WHOLE normalised string against `CAPABILITY_SEED`'s keys, labels and synonyms (`packages/db/src/capabilities.ts:23-72`) — none of those five is one. The seeded templates carry `capabilityKeys: []` (`packages/db/src/seed.ts:134,159,176` write no keys), so the select would render `<option value="">any</option>` and nothing else, and Playwright's `selectOption` would time out. The stage moves to the facet the fixture actually populates: `catalog-skill-select` on `writing-plans`, which only `scripts/fixtures/catalog-m46/engineering/gate-core-builder.md:8` declares (`skills: writing-plans, systematic-debugging` — the one `skills:` front-matter key in the whole of `scripts/fixtures/`), leaving exactly the core builder and exactly `1 template`. The stage's claim is unchanged — a facet the read model computed, narrowing to one row, with the count sentence read back — and the capability filter's own coverage lands in M55's gate stage 9, which asserts options that are LABELS and values that are KEYS. No fixture persona is edited: changing a capability bullet would move `sourceSha256` and `mappingQuality` under three other stages of the same gate.
- **E2 (amends R3 and §2) — `listTemplates()` must not page, and gets `TEMPLATE_PICKER_MAX = 500`.** `apps/web/src/server/org.ts:987` is `return (await listWorkforceCatalogPage()).rows`, and `apps/web/src/app/workforce/page.tsx:112` hands that list to `CompanyManager`, `company/CompanyDetail`, `company/TeamBlock` and `slaves/NewSlaveDrawer` — the pickers a company is STAFFED FROM, whose own docblock (`page.tsx:52-54`) says they "must stay the whole catalog". A `take: CATALOG_PAGE_SIZE` under that call would silently hide every template past the hundredth from every picker, which is the failure R3 exists to prevent turning up somewhere R3 never looked. `listWorkforceCatalog` therefore takes an explicit `options.pageSize` (default `CATALOG_PAGE_SIZE`), `listTemplates()` passes `TEMPLATE_PICKER_MAX = 500` — `CATALOG_ENTRIES_MAX`'s own number and own judgement, and stated in its docblock as the bound it is — and it does NOT filter on `active`, because R2 keeps `add-slave --template` and every manual hire open on an inactive row.
- **E3 (amends R10 and M42 erratum E11) — every bare flag this milestone adds joins `VALUELESS`, because "write it LAST" holds for one flag and no more.** `parseArgs` (`apps/orchestrator/src/cli.ts:694-720`) takes whatever follows a flag as its value AND consumes the token (`i += 1`), so `--activate --verbose` records `verbose` as `activate`'s value and `'verbose' in flags` is false. R12(a) puts `--allow-unknown-license` on EVERY `import-catalog` invocation in `gate-m42`, including the dry run at `scripts/gate-m42-catalog-import.mjs:574-580`, which already ends in `--dry-run` and carries a comment saying why — two bare flags on one command, and the first eats the second. `VALUELESS` (`cli.ts:676`) is this repository's own answer, added in M50 for `--temporary` for precisely this reason and documented there. `activate`, `verbose`, `allow-unknown-license`, `recompute`, `active` and `inactive` join it; `dry-run`, `yes`, `prompt`, `markdown` and `clear` are NOT added, because moving a documented rule for a flag nobody is changing is a rename dressed as a fix.
- **E4 (amends R12 and M54 erratum E5) — `"TemplateDuplicate"` does NOT join `db:seed`'s TRUNCATE list.** `packages/db/src/seed.ts:49` truncates a NAMED list `RESTART IDENTITY CASCADE`, and M54's erratum E5 states the rule that list follows: a table is named when no cascade reaches it, and naming one that cascades "would be the first redundant entry in that statement" (`seed.ts:41-44` carries that sentence). `TemplateDuplicate.aId` and `.bId` are NOT NULL with `onDelete: Cascade` to `SlaveTemplate`, which IS in the list, so `TRUNCATE "SlaveTemplate" … CASCADE` empties it already. The rule is kept. For the same reason `packages/control/test/integration/catalog.test.ts`'s four TRUNCATEs (`:48,454,487,779`) need no edit: every one of them names `"SlaveTemplate"` and every one of them is `CASCADE`.
- **E5 (amends R5, R10 and §2) — TWO refusal kinds land here, not one.** §2 says "one new refusal kind" and R8 names `license_unknown`. `setTemplateDuplicateDismissal(pairId, …)` needs a second: a pair id nobody wrote is a not-found, and the alternatives are both wrong — `template_not_found` names the wrong noun and would tell an operator a template is missing when a pair is, and returning `ok({ changed: false })` for a row that does not exist is the "pretending" R2 refuses in its own `{ changed }` sentence. `template_duplicate_not_found` is 404 by `refusalStatus`'s suffix rule (`apps/web/src/server/refusalStatus.ts:12`), which is right. `apps/web/test/refusal-status.test.ts` moves in two places, and the file does not COMPILE until both kinds are in `ALL_KINDS` (`:167`'s `Record<ControlRefusal['kind'], true>`): `TODAYS_NOT_FOUND_KINDS` goes 22 → 23 (`:139-168`) and `toHaveLength(22)` becomes 23. Named here so Task 3 moves it in the same commit as the union rather than discovering it in the ladder — M54 erratum E14's own reason.
- **E6 (amends R3 and R4) — two of the four derived columns come from the EFFECTIVE spec and two from the UPSTREAM one, and `writeOverrides` must rewrite exactly the first two.** `searchText` and `recommendedSkills` replace an in-memory filter over `catalogRowOf`'s EFFECTIVE values (`packages/control/src/catalog.ts:745` computes `effectiveProfileSpec(spec, overrides)`, `:765-768` reads `capabilities`/`expertise`/`recommendedSkills` off it, and `matches()` at `:780-791` filters exactly those), so writing them from the upstream spec would make a customised row stop matching the words its own row displays. `contentSha256` and `bodyBands` come from the UPSTREAM spec, because R4 says in its own words that the classes "are about the persona somebody published, not about what an operator did to it since" and that the detector "does not look at `profileOverrides`". The consequence R3 never states: `writeOverrides` (`packages/control/src/profile.ts:298-330`) already re-renders `profile` and `profileSha256` when an override lands, and must now write `searchText` and `recommendedSkills` beside them — and must NOT write the other two. Without it, customising a template's `recommendedSkills` leaves the skill facet pointing at the upstream list forever.
- **E7 (amends R4) — the 96 multiplier pairs are BOUNDED so `(a·h + b)` is exact in a double, and the bound is `a < 2²²`.** R4 asks for "a checked-in table of 96 `(a, b)` multiplier pairs … every value reduced `mod MINHASH_PRIME`". `MINHASH_PRIME` is 2 147 483 647, so `h` is up to 2³¹−2; a full-width `a` makes `a·h` up to 2⁶², and JavaScript has no integer above 2⁵³ — every permutation past that silently rounds, and `minhashOf` stops being a permutation at all (it stays deterministic, which is worse: a wrong signature that never varies is a wrong signature nobody notices). The table is therefore generated once, checked in, and bounded: `a` odd in [3, 4 194 303] and `b` in [0, 2 147 483 646]. The worst case is `4 194 303 × 2 147 483 646 + 2 147 483 646 = 9 007 199 246 352 385`, under `Number.MAX_SAFE_INTEGER = 9 007 199 254 740 991` — the arithmetic is written into the module's docblock and pinned by a test that multiplies the table's own largest `a` by the prime and asserts `Number.isSafeInteger`. The shingle hash is reduced FIRST (`fnv1a32(shingle) % MINHASH_PRIME`), which is what makes `h < 2³¹` true rather than hoped for.
- **E8 (amends R3 and the global constraints) — the migration's `searchText` backfill is name + description ONLY, and it is a FLOOR rather than the value.** The global constraints call for "one best-effort `searchText` backfill in SQL". The real value joins five `profileSpec` fields through `effectiveProfileSpec`'s merge with `profileOverrides` (E6), and reproducing that merge in SQL would be a second writer for the column — which R10 forbids in its own words for `capabilityKeys` ("a second writer for one column is how two writers disagree"). So the migration writes `lower(coalesce("name",'') || ' ' || coalesce("description",''))`: true, narrow, and enough that an existing install's search box still finds a row by name the minute the migration lands, and `template duplicates --recompute` (R10, which is also the backfill) writes the real value over it. `contentSha256`, `bodyBands` and `recommendedSkills` get no SQL backfill at all and cannot: two need a canonicalisation Postgres does not have and the third needs the same merge. This is also why `searchText` is `String @default("")` and never NULL — an empty string is "not backfilled yet" and matches nothing, where a NULL would make every `contains` clause three-valued.
- **E9 (amends R7 and §3 stage 1) — an import report carries SEVEN numbers, not six.** R7 says "`list-imports` and the web panel show the same six numbers" and §3 stage 1 repeats "`list-imports` shows the six numbers". The counts are four outcomes (`created`, `updated`, `unchanged`, `skipped`) plus three duplicate classes (`exact`, `near`, `overlapping`). Seven. Named so the CLI's line, the web panel's header row (`apps/web/src/components/CatalogImports.tsx:18-19` is a seven-column `HEADER` today and becomes ten) and the gate's assertion agree on a number rather than on a word.
- **E10 (amends R12) — `gate:m53-evidence`'s five templates are written straight through Prisma and would become inactive, so `makeTemplate` gains `active: true`.** R12 names m42, m46, m47, m48 and m50 — every gate that runs `import-catalog`. It misses the gate that creates catalog personas WITHOUT importing: `scripts/gate-m53-evidence.mjs:640-648` does `prisma.slaveTemplate.create({ … capabilityKeys: [...capabilities] })` five times, and two of those (templateA, templateB) carry non-empty `capabilityKeys`, which is exactly what put them in `loadCatalogEntries`' result before this milestone. The gate never asserts a `hire_from_catalog` (`grep -c hire_from_catalog scripts/gate-m53-evidence.mjs` → 0), so losing them would probably not fail a stage — "probably" is not a thing a plan may ship. `active: true` on that one `create` restores the exact candidate world the gate measured. The seven other gates that create templates directly (`gate-m29:310`, `gate-m30:359`, `gate-m31a:309`, `gate-m31b:344`, `gate-m33:301`, `gate-m37:364`, `gate-m44:444`) write no `capabilityKeys` at all and were never catalog candidates, so none is touched.
- **E11 (amends §3's fixture) — `gen-catalog.mjs` composes its capability bullets out of `CAPABILITY_SEED`'s own LABELS, or three of the twelve stages have nothing to stand on.** §3 says the 120 personas are "composed from a fixed word list by a deterministic seeded PRNG" and then asks for three `overlapping` pairs whose `capabilityKeys` share 4 of 5, a near-miss pair sharing 2 of 5, and a stage-3 task "declaring a capability only a generated persona provides". Every one of those is a statement about `SlaveTemplate.capabilityKeys`, which `importCatalog` fills through `normaliseCapabilities(upstream.capabilities, taxonomy)` — an EXACT match of the whole normalised bullet against a taxonomy key, label or synonym. A bullet composed of invented words resolves to nothing and every `capabilityKeys` is `[]`. The generator therefore draws each persona's `## Core Capabilities` bullets from the 48 labels in `packages/db/src/capabilities.ts` by seeded index, and the gate asserts a non-empty `capabilityKeys` on stage 1 before it asserts anything about the `overlapping` class. The persona's other prose stays invented, which is what the `near` and `exact` classes are about.
- **E12 (amends R3) — the free-text clause lower-cases the QUERY and drops `mode: 'insensitive'`.** R3 writes `q` → `searchText: { contains: q, mode: 'insensitive' }`. `searchText` is written lower-cased, by definition ("the lower-cased join of …"), so `mode: 'insensitive'` asks Postgres for `ILIKE` over a column that is already folded — the same answer for strictly more work, on the one clause R3 itself calls a sequential scan and whose cost it argues about. The clause is `searchText: { contains: q.trim().toLowerCase() }`, and the lower-casing of the query happens in the same function that lower-cases the column, so the two can never disagree. `matches()`'s own `(filters.q ?? '').trim().toLowerCase()` (`packages/control/src/catalog.ts:785`) is the line this replaces, unchanged in meaning.

---

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`; the browser gates need `SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh"`. Nothing in this milestone calls a model to decide anything: the duplicate classes are three thresholds over set arithmetic, the canonical text is a join of stored fields, and no embedding, no similarity service and no model opinion goes anywhere near a pair.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**. A running daemon breaks `subscribe.test.ts`.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first. Tasks 5 and 6 run `web:build`.
- **No prettier.** There is no prettier config and no prettier dependency in this repository; `prettier --write` would reformat against the house style. Match the surrounding file by hand.
- Inside `apps/web`, import siblings **without** a `.js` suffix (`../server/org`, not `../server/org.js`); `packages/*` keep the `.js` suffix.
- Read an exit code with `${PIPESTATUS[0]}`; never `cmd | tail; echo $?` — that reports `tail`'s status.
- After `npm run db:generate`, run `npx tsc --build` **before** any integration test: the generated client's types are what the test files compile against.
- The vocabulary word is **slave** (`gate:m26-vocabulary`), fixtures included, and **M42 erratum E5 stands**: the reference catalog's directory name contains the forbidden word, so no product string, comment, README line, test, fixture, generator or default may name it. `--catalog` defaults to `basename(dir)` at runtime and every checked-in example names a fixture catalog. `scripts/gate-fakes/gen-catalog.mjs` writes into a `mkdtemp` directory whose name the gate chooses. `npm run gate:m26-vocabulary` after every task.
- **Labels never keys** (`docs/ia.md` rule 3). No surface prints `exact`, `near`, `overlapping`, `content_hash`, `name`, `body_shingles`, `capability_keys`, `true` or `false` as its visible text. `DUPLICATE_CLASS_LABEL`, `DUPLICATE_BASIS_LABEL`, `DUPLICATE_FACET_LABEL`, `ACTIVATION_LABEL` and `capabilityLabel` supply the words; the raw value stays in `title`, on `data-class` / `data-score` / `data-active` / `data-basis`, or in the expanded view.
- **Nothing is removed, only moved** (`docs/ia.md` rule 2). No column, filter, chip, group, testid or CLI verb that exists today stops existing. `ProfileDrawer`'s thirteen groups become fourteen; `CatalogFilterBar`'s five controls become seven; `catalog-count`'s sentence gains a second form and keeps the first.
- **Real is not simulated** (`docs/ia.md` rule 4). `packages/control/test/simulation-boundary.test.ts` gains a SIXTH `expect` naming `TemplateDuplicate`, `setTemplateActivation` and `recomputeTemplateDuplicates`. It is honest and it is cheap: `packages/control/src/simulation/*.ts` reads a template only through a `Company`'s roster relation (`read.ts:222`, `adopt.ts:163`, `write.ts:99` each select `slaves: { … template: { select: { role: true } } }`) and never through the catalog list, so a simulation's roster cannot be narrowed by activation and cannot carry a pair.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**, or Prisma commits that write — the `CatalogRowRefused` idiom `packages/control/src/catalog.ts:94-107` already states. The two verbs this milestone adds that write inside a transaction (`setTemplateActivation`, `setTemplateDuplicateDismissal`) refuse only BEFORE their write, and Task 3 proves it by grepping the modules.
- **A refusal kind reaches three homes:** the union + `refusalText` (`packages/control/src/refusal.ts`), the CLI (`throw new Error(refusalText(result.error))`), and the web (`apps/web/test/refusal-status.test.ts`'s `ALL_KINDS`, which is `Record<ControlRefusal['kind'], true>` and fails the BUILD when a kind is missing). **Exactly two kinds land in this milestone** — `license_unknown` (409) and `template_duplicate_not_found` (404, and `TODAYS_NOT_FOUND_KINDS` moves 22 → 23, erratum E5) — both in Task 3. `template_not_found` is REUSED rather than duplicated.
- **Untouched and asserted so:** `decide()` (`packages/domain/src/scheduler/decide.ts`), `evaluateGuardrails` (`packages/domain/src/guardrails/evaluate.ts`), `workspaceSpend` (`packages/control/src/spend.ts`), `stats.spentUsd` (`packages/control/src/stats.ts`), the seventeen `SITUATION_KINDS` and the seventeen `ACTION_KINDS` (`packages/domain/src/supervisor/{situations,actions}.ts`), `formTeam` and `rankCandidates` (`packages/domain/src/capability/team.ts:225`, `packages/domain/src/capability/rank.ts`), and `profileKeyOf` (`packages/domain/src/evidence/derive.ts:25-29`). Every one of those files appears in NO task's file list, and `grep -rn "scheduler/decide"` over every file this milestone writes must come back empty.
- **The Supervisor gains no situation, no action, no world field and no loader.** `packages/domain/src/supervisor/{situations,actions,policy,observe,world,candidates}.ts` and `packages/control/src/supervisor.ts` are in no task's file list. `packages/control/src/supervisorWorld.ts` is touched in exactly ONE place — `loadCatalogEntries`' `where` and `CATALOG_ENTRIES_MAX`'s docstring — and `SupervisorCatalogEntry` keeps its six fields.
- **NO NEW EVENT TYPE.** The catalogue stays at 61 and `packages/domain/test/supervisor/timeline.test.ts:18-19` does not move. `packages/domain/src/events/schema.ts`, `packages/domain/src/supervisor/timeline.ts`, `packages/db/src/enums.ts`'s `EVENT_TYPE_BY_DOMAIN_TYPE`, `apps/web/src/components/activity/cards.tsx`, `apps/web/src/lib/activityFilters.ts`, `apps/web/src/lib/eventLabels.ts` and `apps/web/src/server/timeline.ts` are in NO task's file list — the nine event sites M53's erratum E13 enumerates, and the tenth (`EVENT_PREFIX_LABEL`), are all unpaid because nothing is owed. `appendEvent` requires a `workspaceId` (`packages/events/src/append.ts:6-8`), `ExecutionEvent.workspaceId` is NOT NULL (`schema.prisma:1743`), a `SlaveTemplate` belongs to no workspace, and `SlaveTemplate.activationChangedAt`/`.activationChangedBy` are the record instead (R2). A catalog-level event log is carried backlog, §6 item 1.
- **Migrations are additive and deterministic, applied to both databases** (`npm run db:migrate` and `npm run db:migrate:test`) with the Prisma 7 diff proof: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` → "No difference detected". The directory is **`packages/db/prisma/migrations/20260914090000_m55_catalog`**, which sorts after `20260913150000_m54_triggers`, the last one on the branch M55 forks from. Two enums, one model, seven columns on `SlaveTemplate`, two back-relations, three indexes (one unique, two secondary) and **exactly two data statements**: `UPDATE "SlaveTemplate" SET "active" = true` (R2) and the narrow `searchText` floor (erratum E8). **No CHECK constraint** — M42 erratum E23 makes the diff proof the gate, and a constraint the Prisma schema cannot express is a difference that proof would report forever, which is why `aId < bId` is a WRITER's rule enforced by `orderedPair` and pinned by a unit test and by the gate.
- **Never auto-delete a template.** `deleteSlaveTemplate` (`packages/control/src/org.ts:1034-1047`) is unchanged and remains the only way a row leaves this product — a person's act, through `DangerConfirm`. The importer creates and updates and does nothing else; the detector writes pairs and dismissals and nothing else; `recomputeTemplateDuplicates` may RETIRE a pair that no longer classifies, which is derived state and not a template.
- **The DEV-DB rule.** Any scratch script that touches Prisma runs with `DATABASE_URL="$TEST_DATABASE_URL"`, and nothing outside `test-setup/` ever TRUNCATEs. The gates run against the development database through `--env-file=.env` and clean up only the rows they created, by `sourceId` prefix and by exact name.
- **Run directories live under `SLAVEOFAI_STATE_DIR` in tests and gates** (M52 C1). The shared setup already exists and is loaded by both vitest projects (`test-setup/state-dir.ts`) and by every gate that builds a child environment (`scripts/lib/child-env.mjs` → `scripts/lib/state-dir.mjs`); `scripts/gate-m55-catalog.mjs` gets its root from `gateStateDir()` through `loopbackChildEnv` and adds nothing of its own.
- **Test baseline: at or above the M54 Task 6 ladder.** On the tree this plan was written against, `find` counts **357 test files** (M53's ladder recorded 346 files / 5913 tests; M54 added eleven). Task 1 runs `npx vitest run` once and **records the two numbers it actually sees in its task report**; every later ladder in this plan is at or above them and never below. One new unique index lands here (`TemplateDuplicate_aId_bId_key`) and one new NOT NULL column with a default, and only the FULL suite can see a fixture collision in another package.
- **29 CI gates become 30.** `gate:m54-triggers` is the 29th — verified on the tree this plan was written against, after M54 Task 6 landed: `grep -c '"gate:' package.json` → 41 scripts, `grep -c 'run: npm run gate:' .github/workflows/ci.yml` → **29**, and `README.md:978` reads `29 gates.`. The new `gate:m55-catalog` step goes immediately after `gate:m54-triggers` in both `package.json` and `ci.yml`, and README's roster sentence (the paragraph beginning "The `npm run gate:*` scripts", `README.md:883-897`) and its count line say 30. **Find the count line by grep, never by line number** — M54 Task 6 moved it from `:971` to `:978` and the next milestone will move it again: `grep -n '^[0-9]\+ gates\.' README.md`.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Web-touching tasks also run `npm run web:build` (subject to the `next dev` rule above).
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`. Component tests are `*.test.tsx` under `apps/web/test/` with a `// @vitest-environment jsdom` first line.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/catalog/duplicate.ts       R1/R4/R5/R6: DUPLICATE_CLASSES, DuplicateClass,
                                               DUPLICATE_BASES, DuplicateBasis, DUPLICATE_FACETS,
                                               DuplicateFacet, DUPLICATE_CLASS_LABEL,
                                               DUPLICATE_BASIS_LABEL, DUPLICATE_FACET_LABEL,
                                               SHINGLE_WORDS, NEAR_DUPLICATE_JACCARD,
                                               CAPABILITY_OVERLAP_JACCARD, MINHASH_PERMUTATIONS,
                                               MINHASH_BANDS, MINHASH_BAND_ROWS, MINHASH_PRIME,
                                               MINHASH_MULTIPLIERS, canonicalPersonaText,
                                               normalisePersona, contentHashOf, shinglesOf,
                                               minhashOf, bandKeysOf, bodyBandsOf, jaccard,
                                               orderedPair, DuplicateCandidate, DuplicateVerdict,
                                               classifyPair, DuplicateCounts,
                                               emptyDuplicateCounts, duplicateCountsSchema,
                                               parseDuplicateCounts (new)
packages/domain/src/catalog/search.ts          R3: SEARCH_TEXT_MAX_CHARS, catalogSearchText (new)
packages/domain/src/catalog/index.ts           + ./duplicate.js, ./search.js
packages/domain/test/catalog/duplicate.test.ts                                 (new)
packages/domain/test/catalog/search.test.ts                                    (new)

packages/db/prisma/schema.prisma               R2/R3/R5: SlaveTemplate.active,
                                               .activationChangedAt, .activationChangedBy,
                                               .contentSha256, .bodyBands, .searchText,
                                               .recommendedSkills, .duplicatesA, .duplicatesB,
                                               @@index([active, name]); enums DuplicateClass,
                                               DuplicateBasis; model TemplateDuplicate
packages/db/prisma/migrations/20260914090000_m55_catalog/migration.sql         (new)
packages/db/src/seed.ts                        R12: `active: true` on the three template creates
packages/db/test/integration/enum-parity.test.ts                               + two assertions

packages/control/src/org.ts                    R2: setTemplateActivation, createTemplate's
                                               `active: true`
packages/control/src/supervisorWorld.ts        R2: loadCatalogEntries' `active: true` clause and
                                               CATALOG_ENTRIES_MAX's rewritten docstring
packages/control/src/catalog.ts                R3/R7/R8: CATALOG_PAGE_SIZE, TEMPLATE_PICKER_MAX,
                                               IMPORT_BATCH_SIZE, catalogWhere, derivedColumnsOf,
                                               the widened WorkforceCatalogFilters/Page/Facets,
                                               listWorkforceCatalog's cursor, the license_unknown
                                               refusal, activate/verbose inputs, the batched
                                               post-passes, the widened ImportReport and
                                               CatalogImportView
packages/control/src/duplicates.ts             R4/R5 (new): DUPLICATE_SCAN_MAX,
                                               DUPLICATE_CANDIDATES_MAX, DUPLICATE_SPECS_MAX,
                                               TemplateDuplicateView, DuplicateScanResult,
                                               writeTemplateDuplicates, recomputeTemplateDuplicates,
                                               setTemplateDuplicateDismissal, listTemplateDuplicates
packages/control/src/profile.ts                E6: writeOverrides writes searchText and
                                               recommendedSkills
packages/control/src/refusal.ts                R8/E5: two kinds + two sentences
packages/control/src/index.ts                  + ./duplicates.js
packages/control/test/integration/catalog-activation.test.ts                   (new)
packages/control/test/integration/catalog-page.test.ts                         (new)
packages/control/test/integration/duplicates.test.ts                           (new)
packages/control/test/integration/catalog.test.ts                              extended
packages/control/test/simulation-boundary.test.ts                              sixth expect
apps/web/test/refusal-status.test.ts                                           two kinds, 22 -> 23

apps/orchestrator/src/cli.ts                   R7/R10: template list|activate|deactivate|duplicates,
                                               three flags on import-catalog, VALUELESS (E3),
                                               describeImport(report, verbose), list-imports'
                                               seven numbers, USAGE
apps/orchestrator/test/integration/cli.test.ts                                 + the new verbs

apps/web/src/lib/catalogFilters.ts             R3: seven params, CATALOG_ACTIVATIONS,
                                               ACTIVATION_LABEL, DUPLICATE_FACET options,
                                               CATALOG_SEARCH_DEBOUNCE_MS
apps/web/src/hooks/useCatalogFilters.ts        R3: FILTER_PARAMS goes five -> seven
apps/web/src/server/org.ts                     R3/R6: WorkforceCatalogView gains total/nextCursor,
                                               listTemplates' own cap (E2), listCatalogImports'
                                               duplicates, listTemplateDuplicatesView
apps/web/src/app/api/org/catalog/route.ts                      R3: the cursor param
apps/web/src/app/api/org/templates/[templateId]/activation/route.ts            (new)
apps/web/src/app/api/org/templates/[templateId]/duplicates/route.ts            (new)
apps/web/src/app/api/org/duplicates/[pairId]/dismissal/route.ts                (new)
apps/web/src/components/ui/DetailsGroup.tsx    R6: `duplicates`, the eighteenth group name
apps/web/src/components/workforce/WorkforceCatalog.tsx         R6: the count sentence, catalog-more,
                                               the activation toggle, the duplicate chip
apps/web/src/components/workforce/CatalogFilterBar.tsx         R3/R6: the duplicates select, the
                                               activation chips, the debounce, labelled capabilities
apps/web/src/components/workforce/ProfileDrawer.tsx            R6: the Duplicates group
apps/web/src/components/CatalogImports.tsx     R7/E9: three more columns
apps/web/test/workforce-catalog.test.tsx                                       extended
apps/web/test/catalog-filters.test.ts                                          extended
apps/web/test/catalog-duplicates.test.tsx                                      (new)
docs/ia.md                                     R6: the /workforce row

scripts/gate-fakes/gen-catalog.mjs             §3 (new, the SEVENTH fake and the first WRITER)
scripts/gate-m55-catalog.mjs                   §3 (new)
scripts/gate-m42-catalog-import.mjs            R12(a)-(e)
scripts/gate-m46-workforce-catalog.mjs         E1: stage 2b's one constant and one line
scripts/gate-m47-team-formation.mjs            R12: --activate
scripts/gate-m50-ephemeral.mjs                 R12: --activate
scripts/gate-m53-evidence.mjs                  E10: makeTemplate's `active: true`
package.json, .github/workflows/ci.yml, README.md                              §3
docs/superpowers/specs/2026-09-13-m55-catalog-import-design.md                  the spec + §5
docs/superpowers/plans/2026-09-13-m55-catalog-import.md                         this plan
```

---

### Task 1: The words for "these two are the same", six pure functions with a bound nobody has to trust, one searchable string, seven columns and a table (R1, R3, R4, R5, R6, E7, E8, D1–D14)

`packages/domain` and `packages/db`. This task changes no behaviour: after it there is an empty table, seven columns every existing row reads back with a default, and a set of pure functions nothing calls. That is deliberate — a migration that adds a column deciding who is hirable and a loader that starts reading it are two things a reviewer should read one at a time, and it is the split M52's, M53's and M54's own first tasks each made for the same reason.

**Files:**
- Create: `packages/domain/src/catalog/duplicate.ts`, `packages/domain/src/catalog/search.ts`, `packages/domain/test/catalog/duplicate.test.ts`, `packages/domain/test/catalog/search.test.ts`, `packages/db/prisma/migrations/20260914090000_m55_catalog/migration.sql`
- Modify: `packages/domain/src/catalog/index.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/seed.ts`
- Test: the two new domain test files, plus `packages/db/test/integration/enum-parity.test.ts`

**Interfaces:**
- Consumes: `goalSha256` (`packages/domain/src/goal/version.ts:38` — verified present, hand-rolled SHA-256 with no Node import), `PROFILE_SPEC_FIELDS` and `ProfileSpec`/`ProfileSpecField` (`packages/domain/src/profile/spec.ts:54,84,89-104`), `sliceCodePoints` (`packages/domain/src/profile/spec.ts:343`), `zod`. **No Prisma, no `node:`, no I/O anywhere in `packages/domain`** — `apps/web`'s client bundle imports this package's index, and a `node:crypto` in its graph fails `npm run web:build` outright, which `goal/version.ts:23-36` records as a measured fact.
- Produces, for Tasks 2–6:
  - `DUPLICATE_CLASSES = ['exact','near','overlapping'] as const`, `type DuplicateClass`, `DUPLICATE_CLASS_LABEL: Record<DuplicateClass, string>`
  - `DUPLICATE_BASES = ['content_hash','name','body_shingles','capability_keys'] as const`, `type DuplicateBasis`, `DUPLICATE_BASIS_LABEL: Record<DuplicateBasis, string>`
  - `DUPLICATE_FACETS = ['exact','near','overlapping','none'] as const`, `type DuplicateFacet`, `DUPLICATE_FACET_LABEL: Record<DuplicateFacet, string>`
  - `SHINGLE_WORDS = 5`, `NEAR_DUPLICATE_JACCARD = 0.8`, `CAPABILITY_OVERLAP_JACCARD = 0.6`, `MINHASH_PERMUTATIONS = 96`, `MINHASH_BANDS = 16`, `MINHASH_BAND_ROWS = 6`, `MINHASH_PRIME = 2_147_483_647`, `MINHASH_MULTIPLIERS: readonly (readonly [number, number])[]`
  - `canonicalPersonaText(spec: ProfileSpec): string`, `normalisePersona(text: string): string`, `contentHashOf(spec: ProfileSpec): string`, `shinglesOf(text: string): ReadonlySet<string>`, `minhashOf(shingles: ReadonlySet<string>): readonly number[]`, `bandKeysOf(signature: readonly number[]): readonly string[]`, `bodyBandsOf(spec: ProfileSpec): readonly string[]`, `jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number`, `orderedPair(x: string, y: string): readonly [string, string]`
  - `interface DuplicateCandidate { id; name; contentSha256: string | null; capabilityKeys: readonly string[]; shingles: ReadonlySet<string> }`, `interface DuplicateVerdict { class: DuplicateClass; basis: DuplicateBasis; score: number }`, `classifyPair(a, b): DuplicateVerdict | null`
  - `type DuplicateCounts = Readonly<Record<DuplicateClass, number>>`, `emptyDuplicateCounts()`, `duplicateCountsSchema`, `parseDuplicateCounts(value: unknown): DuplicateCounts`
  - `SEARCH_TEXT_MAX_CHARS = 2000`, `catalogSearchText(input): string`
  - Prisma: `DuplicateClass`, `DuplicateBasis`, `TemplateDuplicate`, `SlaveTemplate.active`/`.activationChangedAt`/`.activationChangedBy`/`.contentSha256`/`.bodyBands`/`.searchText`/`.recommendedSkills`/`.duplicatesA`/`.duplicatesB`

**One rule about this task's own arithmetic.** Every integer this module computes must stay inside `Number.MAX_SAFE_INTEGER`, and the module says so in prose and proves it in a test (erratum E7). A silently-rounded permutation is the worst kind of bug this milestone could ship: it is deterministic, it never throws, and it degrades a detector into a coin nobody can see land.

- [ ] **Step 1: Write the failing test for the duplicate vocabulary and the six functions**

`packages/domain/test/catalog/duplicate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { emptyProfileSpec, type ProfileSpec } from '../../src/profile/spec.js'
import {
  CAPABILITY_OVERLAP_JACCARD,
  DUPLICATE_BASES,
  DUPLICATE_BASIS_LABEL,
  DUPLICATE_CLASSES,
  DUPLICATE_CLASS_LABEL,
  DUPLICATE_FACETS,
  DUPLICATE_FACET_LABEL,
  MINHASH_BANDS,
  MINHASH_BAND_ROWS,
  MINHASH_MULTIPLIERS,
  MINHASH_PERMUTATIONS,
  MINHASH_PRIME,
  NEAR_DUPLICATE_JACCARD,
  SHINGLE_WORDS,
  bandKeysOf,
  bodyBandsOf,
  canonicalPersonaText,
  classifyPair,
  contentHashOf,
  duplicateCountsSchema,
  emptyDuplicateCounts,
  jaccard,
  minhashOf,
  normalisePersona,
  orderedPair,
  parseDuplicateCounts,
  shinglesOf,
  type DuplicateCandidate,
} from '../../src/catalog/duplicate.js'

/** A spec with something in every field the canonical text reads, so a case that changes ONE field
 *  is a case about that field. */
const spec = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'The slave who owns the last mile',
  summary: 'Gets a change out and watches what it does',
  mission: 'Take one change to production at a time',
  runtimeRole: 'engineering',
  capabilities: ['Deployment', 'Observability'],
  expertise: ['Reading a dashboard back to the change that moved it'],
  operatingPrinciples: ['Ship small'],
  constraints: ['You MUST never leave a red test behind'],
  workflow: ['Step 1: write the failing test'],
  deliverables: ['Module boundary note'],
  successCriteria: ['Every commit green'],
  collaborationHints: ['Consult the Gate Verifier before a release'],
  recommendedSkills: ['writing-plans'],
  body: 'You keep a note of every shortcut that cost something.',
  ...over,
})

const candidate = (over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: 'a',
  name: 'Backend Architect',
  contentSha256: null,
  capabilityKeys: [],
  shingles: new Set<string>(),
  ...over,
})

const setOf = (...values: string[]): ReadonlySet<string> => new Set(values)

describe('the three vocabularies (R4, R5, R6)', () => {
  it('is three classes, four bases and four facets, and no fifth of anything', () => {
    expect(DUPLICATE_CLASSES).toEqual(['exact', 'near', 'overlapping'])
    expect(DUPLICATE_BASES).toEqual(['content_hash', 'name', 'body_shingles', 'capability_keys'])
    expect(DUPLICATE_FACETS).toEqual(['exact', 'near', 'overlapping', 'none'])
  })

  it('gives every member a WORD, so no surface prints a raw member as visible text (ia.md rule 3)', () => {
    for (const member of DUPLICATE_CLASSES) expect(DUPLICATE_CLASS_LABEL[member], member).not.toBe(member)
    for (const member of DUPLICATE_BASES) expect(DUPLICATE_BASIS_LABEL[member], member).not.toBe(member)
    for (const member of DUPLICATE_FACETS) expect(DUPLICATE_FACET_LABEL[member], member).not.toBe(member)
  })

  it('says the class as the first half of a sentence, because the row after it is the second', () => {
    expect(DUPLICATE_CLASS_LABEL).toEqual({
      exact: 'Duplicate of',
      near: 'Similar to',
      overlapping: 'Overlaps',
    })
  })

  it('says the basis as the reason, in words a person can act on', () => {
    expect(DUPLICATE_BASIS_LABEL).toEqual({
      content_hash: 'same persona text',
      name: 'same name',
      body_shingles: 'overlapping text',
      capability_keys: 'overlapping capabilities',
    })
  })

  it('says the facet as a filter option, `none` included', () => {
    expect(DUPLICATE_FACET_LABEL).toEqual({
      exact: 'duplicates',
      near: 'near duplicates',
      overlapping: 'overlapping',
      none: 'no signal',
    })
  })
})

describe('the seven constants (R4)', () => {
  it('spells every threshold once, where the detector and the gate both read it', () => {
    expect(SHINGLE_WORDS).toBe(5)
    expect(NEAR_DUPLICATE_JACCARD).toBe(0.8)
    expect(CAPABILITY_OVERLAP_JACCARD).toBe(0.6)
    expect(MINHASH_PERMUTATIONS).toBe(96)
    expect(MINHASH_BANDS).toBe(16)
    expect(MINHASH_BAND_ROWS).toBe(6)
    expect(MINHASH_PRIME).toBe(2_147_483_647)
  })

  it('cuts the signature EXACTLY into its bands, with no row left over', () => {
    expect(MINHASH_BANDS * MINHASH_BAND_ROWS).toBe(MINHASH_PERMUTATIONS)
  })
})

describe('MINHASH_MULTIPLIERS (erratum E7)', () => {
  it('is 96 pairs, one per permutation', () => {
    expect(MINHASH_MULTIPLIERS).toHaveLength(MINHASH_PERMUTATIONS)
  })

  it('keeps every `a` under 2^22, which is what makes `a * h + b` exact in a double', () => {
    for (const [a] of MINHASH_MULTIPLIERS) {
      expect(a, String(a)).toBeGreaterThan(0)
      expect(a, String(a)).toBeLessThan(2 ** 22)
      expect(a % 2, String(a)).toBe(1)
    }
  })

  it('keeps every `b` inside the prime', () => {
    for (const [, b] of MINHASH_MULTIPLIERS) {
      expect(b, String(b)).toBeGreaterThanOrEqual(0)
      expect(b, String(b)).toBeLessThan(MINHASH_PRIME)
    }
  })

  it('is a real permutation table: no `a` twice, so no two rows of the signature are the same function', () => {
    expect(new Set(MINHASH_MULTIPLIERS.map(([a]) => a)).size).toBe(MINHASH_PERMUTATIONS)
  })

  // The whole of erratum E7, as arithmetic rather than as a promise: the worst product this table
  // can ever compute, against the largest integer a double holds exactly.
  it('never leaves the exact-integer range, at its own worst case', () => {
    const worstA = Math.max(...MINHASH_MULTIPLIERS.map(([a]) => a))
    const worstB = Math.max(...MINHASH_MULTIPLIERS.map(([, b]) => b))
    const worst = worstA * (MINHASH_PRIME - 1) + worstB
    expect(Number.isSafeInteger(worst), `${String(worstA)} * ${String(MINHASH_PRIME - 1)} + ${String(worstB)} = ${String(worst)}`).toBe(true)
  })
})

describe('normalisePersona (R1)', () => {
  it('runs three passes and no more: NFC, lower case, whitespace collapsed', () => {
    expect(normalisePersona('  Ships   SMALL,\n\twatches hard  ')).toBe('ships small, watches hard')
  })

  it('folds a decomposed accent onto its composed form, which is what NFC is for', () => {
    // U+0065 U+0301 (e + combining acute) against U+00E9.
    expect(normalisePersona('Café')).toBe(normalisePersona('Café'))
    expect(normalisePersona('Café')).toBe('café')
  })

  it('does NOT strip punctuation, because two personas that differ by a comma are not the same text', () => {
    expect(normalisePersona('ship, then watch')).toBe('ship, then watch')
  })

  it('is idempotent -- the stored hash and a re-derived one cannot drift', () => {
    const once = normalisePersona('  Á  B  ')
    expect(normalisePersona(once)).toBe(once)
  })

  it('answers the empty string for a string of nothing but whitespace', () => {
    expect(normalisePersona(' \n\t ')).toBe('')
  })
})

describe('canonicalPersonaText (R1)', () => {
  it('joins the spec fields in PROFILE_SPEC_FIELDS order, one per line, lists flattened', () => {
    const text = canonicalPersonaText(spec())
    expect(text.split('\n')[0]).toBe('The slave who owns the last mile')
    expect(text).toContain('Deployment\nObservability')
    expect(text.endsWith('You keep a note of every shortcut that cost something.')).toBe(true)
  })

  it('EXCLUDES runtimeRole -- a scheduler label the importer chose is not a word the persona wrote', () => {
    expect(canonicalPersonaText(spec())).not.toContain('engineering')
    expect(canonicalPersonaText(spec({ runtimeRole: 'testing' }))).toBe(canonicalPersonaText(spec()))
  })

  it('EXCLUDES source -- provenance is not the persona (the same import from two catalogs is one persona)', () => {
    const withSource = spec({
      source: {
        repository: 'catalog-one',
        path: 'engineering/steward.md',
        revision: null,
        license: 'MIT',
        importedAt: '2026-09-14T09:00:00.000Z',
        mappingQuality: 'full',
      },
    })
    expect(canonicalPersonaText(withSource)).toBe(canonicalPersonaText(spec()))
  })

  it('is stable field by field: changing one field changes the text, and changing none does not', () => {
    expect(canonicalPersonaText(spec({ mission: 'Something else' }))).not.toBe(canonicalPersonaText(spec()))
    expect(canonicalPersonaText(spec())).toBe(canonicalPersonaText(spec()))
  })
})

describe('contentHashOf (R1)', () => {
  it('is 64 lower-case hex characters -- goalSha256 over the normalised canonical text', () => {
    expect(contentHashOf(spec())).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('is EQUAL across case, whitespace and NFC differences, which is the whole exact class', () => {
    const loud = spec({
      identity: 'THE SLAVE   WHO OWNS THE LAST MILE',
      summary: 'Gets a change out\tand watches what it does',
    })
    expect(contentHashOf(loud)).toBe(contentHashOf(spec()))
  })

  it('is DIFFERENT when one word differs, because a persona that says something else is something else', () => {
    expect(contentHashOf(spec({ mission: 'Take two changes to production at a time' }))).not.toBe(contentHashOf(spec()))
  })

  it('does not depend on the source record or the runtime role', () => {
    expect(contentHashOf(spec({ runtimeRole: 'qa' }))).toBe(contentHashOf(spec()))
  })
})

describe('shinglesOf (R4)', () => {
  it('is every window of five consecutive words', () => {
    expect([...shinglesOf('one two three four five six')]).toEqual([
      'one two three four five',
      'two three four five six',
    ])
  })

  it('gives a body shorter than five words ONE shingle rather than none (R4 says so in words)', () => {
    expect([...shinglesOf('one two three')]).toEqual(['one two three'])
    expect([...shinglesOf('one')]).toEqual(['one'])
  })

  it('gives an empty body an EMPTY set, which is what a row with no profileSpec has', () => {
    expect(shinglesOf('').size).toBe(0)
    expect(shinglesOf('   ').size).toBe(0)
  })

  it('normalises for itself, so the caller may hand it the raw canonical text', () => {
    expect([...shinglesOf('ONE  Two\nthree Four five')]).toEqual(['one two three four five'])
  })

  it('deduplicates a repeated window -- a set, not a list', () => {
    expect(shinglesOf('a b c d e a b c d e').size).toBe(6)
  })
})

describe('jaccard (R4)', () => {
  it('is 1 for two equal sets', () => {
    expect(jaccard(setOf('a', 'b'), setOf('b', 'a'))).toBe(1)
  })

  it('is 0 for two DISJOINT sets', () => {
    expect(jaccard(setOf('a'), setOf('b'))).toBe(0)
  })

  it('is the shared over the union', () => {
    expect(jaccard(setOf('a', 'b', 'c'), setOf('b', 'c', 'd'))).toBeCloseTo(2 / 4, 10)
  })

  it('is ZERO for two EMPTY sets, not 1 -- two personas that name no capability are not the same specialist', () => {
    expect(jaccard(setOf(), setOf())).toBe(0)
  })

  it('is 0 when one side is empty', () => {
    expect(jaccard(setOf('a'), setOf())).toBe(0)
  })

  it('is symmetric, which is what lets classifyPair run on the ORDERED pair', () => {
    const a = setOf('a', 'b', 'c')
    const b = setOf('c', 'd')
    expect(jaccard(a, b)).toBe(jaccard(b, a))
  })
})

describe('minhashOf and bandKeysOf (R4)', () => {
  it('answers one value per permutation, every one inside the prime', () => {
    const signature = minhashOf(shinglesOf('the quick brown fox jumps over the lazy dog again and again'))
    expect(signature).toHaveLength(MINHASH_PERMUTATIONS)
    for (const value of signature) {
      expect(Number.isSafeInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(MINHASH_PRIME)
    }
  })

  it('is DETERMINISTIC across two calls, which is what makes a stored band column re-derivable', () => {
    const text = 'a persona that says one particular thing and then says another particular thing'
    expect(minhashOf(shinglesOf(text))).toEqual(minhashOf(shinglesOf(text)))
  })

  it('does not depend on the order the shingles were inserted -- min is commutative', () => {
    const forwards = new Set(['a b c d e', 'b c d e f', 'c d e f g'])
    const backwards = new Set(['c d e f g', 'b c d e f', 'a b c d e'])
    expect(minhashOf(forwards)).toEqual(minhashOf(backwards))
  })

  it('cuts a signature into sixteen band keys, each naming its own band', () => {
    const keys = bandKeysOf(minhashOf(shinglesOf('one two three four five six seven eight')))
    expect(keys).toHaveLength(MINHASH_BANDS)
    expect(new Set(keys).size).toBe(MINHASH_BANDS)
    for (const [index, key] of keys.entries()) expect(key.startsWith(`${String(index)}:`)).toBe(true)
    expect((keys[0] as string).split(':')[1]?.split('-')).toHaveLength(MINHASH_BAND_ROWS)
  })

  it('refuses a signature that is not 96 values, rather than silently banding a short one', () => {
    expect(() => bandKeysOf([1, 2, 3])).toThrow(/96/u)
  })

  it('SHARES a band key for two texts a person would call near duplicates', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${String(i)}`)
    const a = words.join(' ')
    const b = [...words.slice(0, 54), 'different', 'ending', 'words', 'entirely', 'here', 'now'].join(' ')
    const shared = bandKeysOf(minhashOf(shinglesOf(a))).filter((key) =>
      bandKeysOf(minhashOf(shinglesOf(b))).includes(key),
    )
    expect(shared.length, `bands shared: ${String(shared.length)}`).toBeGreaterThan(0)
  })

  it('shares NO band key for two texts with nothing in common', () => {
    const a = Array.from({ length: 60 }, (_, i) => `alpha${String(i)}`).join(' ')
    const b = Array.from({ length: 60 }, (_, i) => `omega${String(i)}`).join(' ')
    const shared = bandKeysOf(minhashOf(shinglesOf(a))).filter((key) =>
      bandKeysOf(minhashOf(shinglesOf(b))).includes(key),
    )
    expect(shared).toEqual([])
  })

  it('bodyBandsOf is the whole pipeline over one spec, and two equal specs band equally', () => {
    expect(bodyBandsOf(spec())).toEqual(bodyBandsOf(spec()))
    expect(bodyBandsOf(spec())).toHaveLength(MINHASH_BANDS)
  })
})

describe('orderedPair (R5)', () => {
  it('puts the smaller id first, whichever way it is asked', () => {
    expect(orderedPair('b', 'a')).toEqual(['a', 'b'])
    expect(orderedPair('a', 'b')).toEqual(['a', 'b'])
  })

  it('refuses a row paired with itself, which is the one pair that can never be a duplicate', () => {
    expect(() => orderedPair('a', 'a')).toThrow(/itself/u)
  })
})

describe('classifyPair (R4): the five arms, highest class only', () => {
  it('(1) two equal content hashes are exact, basis content_hash, score 1 -- whatever else differs', () => {
    const a = candidate({ id: 'a', name: 'Backend Architect', contentSha256: 'abc', capabilityKeys: ['backend.services'] })
    const b = candidate({ id: 'b', name: 'Server Specialist', contentSha256: 'abc', capabilityKeys: [] })
    expect(classifyPair(a, b)).toEqual({ class: 'exact', basis: 'content_hash', score: 1 })
  })

  it('(1) a NULL hash on either side never matches, however null the other is', () => {
    const a = candidate({ id: 'a', name: 'One', contentSha256: null })
    const b = candidate({ id: 'b', name: 'Two', contentSha256: null })
    expect(classifyPair(a, b)).toBeNull()
    expect(classifyPair(a, candidate({ id: 'b', name: 'Two', contentSha256: 'abc' }))).toBeNull()
  })

  it('(2) two names equal after normalisation are exact, basis name, score the BODY jaccard', () => {
    const a = candidate({ id: 'a', name: 'Backend  ARCHITECT', shingles: setOf('one two three four five') })
    const b = candidate({ id: 'b', name: 'backend architect', shingles: setOf('one two three four five') })
    expect(classifyPair(a, b)).toEqual({ class: 'exact', basis: 'name', score: 1 })
  })

  it('(2) a name pair whose bodies share nothing scores 0 and is STILL exact -- the name is the basis', () => {
    const a = candidate({ id: 'a', name: 'Release Steward', shingles: setOf('a b c d e') })
    const b = candidate({ id: 'b', name: 'release  steward', shingles: setOf('v w x y z') })
    expect(classifyPair(a, b)).toEqual({ class: 'exact', basis: 'name', score: 0 })
  })

  it('(1) beats (2): equal hashes AND equal names is content_hash, because the hash is the stronger claim', () => {
    const a = candidate({ id: 'a', name: 'Same Name', contentSha256: 'h' })
    const b = candidate({ id: 'b', name: 'same name', contentSha256: 'h' })
    expect(classifyPair(a, b)?.basis).toBe('content_hash')
  })

  it('(3) a body jaccard at or above 0.8 is near, basis body_shingles, score the jaccard to three places', () => {
    const shared = Array.from({ length: 8 }, (_, i) => `s${String(i)}`)
    const a = candidate({ id: 'a', name: 'One', shingles: new Set([...shared, 'x']) })
    const b = candidate({ id: 'b', name: 'Two', shingles: new Set([...shared, 'y']) })
    // 8 shared of 10 union = 0.8, exactly ON the threshold, which is inclusive.
    expect(classifyPair(a, b)).toEqual({ class: 'near', basis: 'body_shingles', score: 0.8 })
  })

  it('(3) just UNDER the threshold is not near', () => {
    const shared = Array.from({ length: 7 }, (_, i) => `s${String(i)}`)
    const a = candidate({ id: 'a', name: 'One', shingles: new Set([...shared, 'x']) })
    const b = candidate({ id: 'b', name: 'Two', shingles: new Set([...shared, 'y', 'z']) })
    // 7 shared of 10 union = 0.7.
    expect(classifyPair(a, b)).toBeNull()
  })

  it('(4) a capability jaccard at or above 0.6 is overlapping, basis capability_keys', () => {
    const a = candidate({ id: 'a', name: 'One', capabilityKeys: ['backend.services', 'backend.api-design', 'database.postgres'] })
    const b = candidate({ id: 'b', name: 'Two', capabilityKeys: ['backend.services', 'backend.api-design', 'database.postgres'] })
    expect(classifyPair(a, b)).toEqual({ class: 'overlapping', basis: 'capability_keys', score: 1 })
  })

  it('(4) 4 of 5 shared is overlapping and scores 0.667 -- four over a union of six', () => {
    const a = candidate({ id: 'a', name: 'One', capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k5'] })
    const b = candidate({ id: 'b', name: 'Two', capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k9'] })
    expect(classifyPair(a, b)).toEqual({ class: 'overlapping', basis: 'capability_keys', score: 0.667 })
  })

  it('(4) 2 of 5 shared is BELOW the threshold and classifies as nothing', () => {
    const a = candidate({ id: 'a', name: 'One', capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k5'] })
    const b = candidate({ id: 'b', name: 'Two', capabilityKeys: ['k1', 'k2', 'k7', 'k8', 'k9'] })
    expect(classifyPair(a, b)).toBeNull()
  })

  it('(4) two empty capability lists are NOT overlapping, because jaccard of two empty sets is 0', () => {
    expect(classifyPair(candidate({ id: 'a', name: 'One' }), candidate({ id: 'b', name: 'Two' }))).toBeNull()
  })

  it('(3) beats (4): a near body wins over a full capability overlap, which is what "highest class" means', () => {
    const shared = Array.from({ length: 9 }, (_, i) => `s${String(i)}`)
    const a = candidate({ id: 'a', name: 'One', shingles: new Set(shared), capabilityKeys: ['k1'] })
    const b = candidate({ id: 'b', name: 'Two', shingles: new Set(shared), capabilityKeys: ['k1'] })
    expect(classifyPair(a, b)?.class).toBe('near')
  })

  it('(5) two rows with nothing in common classify as nothing at all', () => {
    const a = candidate({ id: 'a', name: 'One', shingles: setOf('a b c d e'), capabilityKeys: ['k1'] })
    const b = candidate({ id: 'b', name: 'Two', shingles: setOf('v w x y z'), capabilityKeys: ['k2'] })
    expect(classifyPair(a, b)).toBeNull()
  })

  it('is SYMMETRIC -- the verdict does not depend on which row the writer put first', () => {
    const a = candidate({ id: 'a', name: 'One', shingles: setOf('a b c d e', 'b c d e f'), capabilityKeys: ['k1', 'k2'] })
    const b = candidate({ id: 'b', name: 'Two', shingles: setOf('a b c d e'), capabilityKeys: ['k1', 'k2'] })
    expect(classifyPair(a, b)).toEqual(classifyPair(b, a))
  })

  it('rounds every score to three decimals, so the stored number IS the number the label prints', () => {
    const a = candidate({ id: 'a', name: 'One', capabilityKeys: ['k1', 'k2', 'k3'] })
    const b = candidate({ id: 'b', name: 'Two', capabilityKeys: ['k1', 'k2', 'k3', 'k4'] })
    const verdict = classifyPair(a, b)
    expect(verdict?.score).toBe(0.75)
    expect(String(verdict?.score).replace(/^\d+\.?/u, '')).toHaveLength(2)
  })
})

describe('DuplicateCounts (R7)', () => {
  it('starts at zero for every class, so a report always carries three numbers', () => {
    expect(emptyDuplicateCounts()).toEqual({ exact: 0, near: 0, overlapping: 0 })
  })

  it('accepts the shape a CatalogImport.report Json column carries', () => {
    expect(duplicateCountsSchema.safeParse({ exact: 3, near: 3, overlapping: 12 }).success).toBe(true)
  })

  it('refuses a fourth class, a negative count and a fractional one -- this is a row count', () => {
    expect(duplicateCountsSchema.safeParse({ exact: 1, near: 1, overlapping: 1, merged: 1 }).success).toBe(false)
    expect(duplicateCountsSchema.safeParse({ exact: -1, near: 0, overlapping: 0 }).success).toBe(false)
    expect(duplicateCountsSchema.safeParse({ exact: 1.5, near: 0, overlapping: 0 }).success).toBe(false)
  })

  it('parses a stored column back, and answers ZEROES for one written before this milestone', () => {
    expect(parseDuplicateCounts({ exact: 1, near: 2, overlapping: 3 })).toEqual({ exact: 1, near: 2, overlapping: 3 })
    expect(parseDuplicateCounts(undefined)).toEqual({ exact: 0, near: 0, overlapping: 0 })
    expect(parseDuplicateCounts({ created: [] })).toEqual({ exact: 0, near: 0, overlapping: 0 })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/catalog/duplicate.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/catalog/duplicate.js"`.

- [ ] **Step 3: Write the duplicate module**

`packages/domain/src/catalog/duplicate.ts`. The multiplier table is written out in full; it was generated once, deterministically, and is checked in rather than computed at load, because a table computed by a second algorithm is a second algorithm to keep correct.

```ts
import { z } from 'zod'
import { goalSha256 } from '../goal/version.js'
import { PROFILE_SPEC_FIELDS, type ProfileSpec, type ProfileSpecField } from '../profile/spec.js'

/**
 * "Are these two catalog rows the same specialist?" -- the three classes, the four bases, and the
 * six pure functions that answer it (M55 R1, R4, R5, R6).
 *
 * PURE, and it must stay that way: `packages/domain` is imported by `apps/web`'s CLIENT bundle, so
 * there is no `node:crypto`, no `node:fs` and no Prisma anywhere in this graph. `goalSha256`
 * (`../goal/version.ts`) is the hand-rolled SHA-256 that exists for exactly this reason, and its
 * own docblock records the measured `web:build` failure that made it necessary.
 *
 * NOTHING HERE DECIDES ANYTHING. These functions describe a pair; `packages/control/src/
 * duplicates.ts` is what writes a row, and `deleteSlaveTemplate` is still the only thing in this
 * product that removes a template. The signal never deletes -- a person may dismiss it, the
 * importer may not (R5).
 */

/** The three classes, strongest first, which is also `classifyPair`'s arm order (R4). */
export const DUPLICATE_CLASSES = ['exact', 'near', 'overlapping'] as const

export type DuplicateClass = (typeof DUPLICATE_CLASSES)[number]

/** WHY a pair classified -- the column M53 R1's rule (and M54 R4's own two) asks for: a surface
 *  must be able to answer a question without a join or a guess, and "these two are the same" reads
 *  completely differently from "these two are spelled the same". */
export const DUPLICATE_BASES = ['content_hash', 'name', 'body_shingles', 'capability_keys'] as const

export type DuplicateBasis = (typeof DUPLICATE_BASES)[number]

/** The catalog filter's vocabulary (R3/R6). `none` is a real answer -- "show me the rows nothing
 *  was noticed about" -- and `any` is NOT a member: the absence of the filter is what "any" means,
 *  and a member for it would be a second spelling of an empty value. */
export const DUPLICATE_FACETS = ['exact', 'near', 'overlapping', 'none'] as const

export type DuplicateFacet = (typeof DUPLICATE_FACETS)[number]

/** The first half of a sentence whose second half is the other template's NAME: `Duplicate of
 *  Backend Architect` (`docs/ia.md` rule 3). A `Record` over the union, so a fourth class fails the
 *  build here rather than turning up on a chip as an identifier. */
export const DUPLICATE_CLASS_LABEL: Record<DuplicateClass, string> = {
  exact: 'Duplicate of',
  near: 'Similar to',
  overlapping: 'Overlaps',
}

/** What goes in the chip's `title` after the class: `same persona text`, `same name`. The raw
 *  member stays on `data-basis`. */
export const DUPLICATE_BASIS_LABEL: Record<DuplicateBasis, string> = {
  content_hash: 'same persona text',
  name: 'same name',
  body_shingles: 'overlapping text',
  capability_keys: 'overlapping capabilities',
}

/** What the filter's `<option>` says. The `<option value>` is the raw member, which is what a gate
 *  reads; this is what a person reads. */
export const DUPLICATE_FACET_LABEL: Record<DuplicateFacet, string> = {
  exact: 'duplicates',
  near: 'near duplicates',
  overlapping: 'overlapping',
  none: 'no signal',
}

/** A shingle is five consecutive words. Five is the classic near-duplicate window: three matches
 *  too much ordinary English, ten misses a paragraph somebody reordered. */
export const SHINGLE_WORDS = 5

/** At or above this body Jaccard, two personas are the `near` class (R4). Inclusive, so a pair
 *  sitting exactly on it is a signal rather than an accident of rounding. */
export const NEAR_DUPLICATE_JACCARD = 0.8

/** At or above this `capabilityKeys` Jaccard, two personas `overlap` -- they claim the same work
 *  without being the same text (R4). Inclusive, for the same reason. */
export const CAPABILITY_OVERLAP_JACCARD = 0.6

export const MINHASH_PERMUTATIONS = 96
export const MINHASH_BANDS = 16
export const MINHASH_BAND_ROWS = 6

/** 2^31 - 1, the largest signed 32-bit integer and a Mersenne prime, so every reduced value fits a
 *  Postgres `integer` and the band strings stay short. */
export const MINHASH_PRIME = 2_147_483_647

/**
 * The 96 `(a, b)` pairs of the universal hash family `h(x) = (a * x + b) mod MINHASH_PRIME`.
 *
 * **Why `a` is bounded at 2^22** (plan erratum E7). `x` here is a shingle's FNV-1a already reduced
 * `mod MINHASH_PRIME`, so `x < 2^31`. JavaScript has no integer type: every product above
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1) rounds silently, and a rounded permutation is the worst bug
 * this module could carry -- deterministic, never throwing, and quietly turning a detector into a
 * coin. With `a <= 4_194_303` (2^22 - 1) and `b < MINHASH_PRIME` the worst possible value of
 * `a * x + b` is
 *
 *     4_194_303 * 2_147_483_646 + 2_147_483_646 = 9_007_199_246_352_385
 *
 * against `Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991`. Exact, with 8_388_606 to spare, and
 * the test beside this file computes both numbers rather than trusting this comment.
 *
 * Every `a` is ODD and every `a` is distinct, so no two rows of the signature are the same
 * function of `x`. Generated once by a seeded xorshift and CHECKED IN rather than computed at load:
 * a table built by a second algorithm is a second algorithm to keep correct, and this one must
 * produce byte-identical `bodyBands` across every process that ever writes the column.
 */
export const MINHASH_MULTIPLIERS: readonly (readonly [number, number])[] = [
  [3169017, 1586090227], [2613573, 382380497],
  [2741775, 232615630], [1781461, 1244294101],
  [643839, 1676914052], [2620527, 747570422],
  [2490601, 1103821344], [2359799, 1022641961],
  [3578763, 1204796106], [195135, 2126723562],
  [3201407, 604721943], [1536139, 1177788207],
  [1762299, 1123341501], [4863, 1897762844],
  [1067903, 1029735205], [975371, 1709932376],
  [3840561, 497789058], [291675, 382994347],
  [311221, 1787336164], [3218479, 1386870950],
  [1631573, 22012615], [3448941, 1684765290],
  [2485241, 765698339], [3823313, 1267615779],
  [479125, 1426103295], [1328949, 805585094],
  [478869, 888399543], [96669, 712835973],
  [3227759, 1086925557], [2148887, 1400695186],
  [1261267, 1932300089], [3963081, 359817468],
  [1329797, 1926896944], [3978689, 114507509],
  [3410235, 1459514635], [3628909, 1548287645],
  [3446683, 1770408864], [182835, 870372881],
  [3332419, 871743346], [2888441, 583643136],
  [4128139, 929673685], [3227907, 288991724],
  [1566849, 1369175855], [3306937, 1383001508],
  [773895, 330496915], [1510799, 537543138],
  [3454445, 265894411], [1149299, 1676215205],
  [3002701, 810653262], [1482997, 1831101848],
  [3524893, 1995326011], [703419, 242934337],
  [3113293, 1761263402], [2358881, 1845732277],
  [1624393, 621986839], [2041051, 1546267841],
  [4090745, 280439893], [209803, 1505547793],
  [2098279, 836203356], [3912711, 1783840186],
  [2824857, 929890554], [3624687, 985019919],
  [177173, 1305714399], [540817, 1932759127],
  [1534837, 795863931], [1101333, 2101777601],
  [166625, 523752610], [1774151, 712987483],
  [1203313, 1051978764], [3932407, 154352923],
  [1911051, 200459198], [2123683, 1549907028],
  [2068099, 592423064], [3218433, 1395592744],
  [2148409, 2144566435], [2747337, 596590943],
  [3956259, 111416258], [1706953, 631439206],
  [937165, 578877185], [3510645, 870985946],
  [1847697, 227625199], [1832967, 1438635133],
  [3688659, 340777422], [3907817, 1099332262],
  [618053, 2014548429], [2152883, 91165302],
  [1416525, 647080639], [152579, 1638565780],
  [1007645, 1539608277], [1521425, 390899833],
  [3573235, 1430521830], [2700473, 984044652],
  [4013403, 299069586], [2156433, 1662744306],
  [2561269, 839525639], [3488705, 731489162],
]

/**
 * The fields the canonical persona text is built from: `PROFILE_SPEC_FIELDS` in that constant's own
 * order, minus `runtimeRole` (M55 R1).
 *
 * `runtimeRole` is out because it is a scheduler label the IMPORTER chose from a directory name, not
 * a word the persona wrote -- two copies of one persona filed under two divisions are one persona.
 * `source` is out for free: it is not a member of `PROFILE_SPEC_FIELDS` at all
 * (`../profile/spec.ts:84`), which is the same exclusion `PROFILE_SECTION_PRIORITY` makes for the
 * same reason.
 */
const CANONICAL_FIELDS: readonly ProfileSpecField[] = PROFILE_SPEC_FIELDS.filter(
  (field) => field !== 'runtimeRole',
)

/**
 * The text two catalog rows are compared AS (M55 R1).
 *
 * Not the persona FILE and not `SlaveTemplate.profile`. The file carries front matter -- `color`,
 * `emoji`, `vibe` -- which M42 R4 already calls cosmetics, and `profile` is
 * `renderProfileSpec(...)`, which OPENS with `importedProfilePrefix(sourceId, importedAt)`
 * (`./persona.ts:89-91`): a line carrying the source id and the DAY, so the same persona imported
 * from two catalogs on two days could never hash equal. The structured fields are what is left when
 * both of those are gone, and they are reproducible from a stored column -- which is what lets
 * `template duplicates --recompute` re-derive this for a row whose file is long gone.
 *
 * A list renders one item per line, the same way `sectionText` does, so a persona that moved a
 * sentence from a paragraph into a bullet still hashes and shingles as the same words.
 */
export function canonicalPersonaText(spec: ProfileSpec): string {
  const parts: string[] = []
  for (const field of CANONICAL_FIELDS) {
    const value = spec[field]
    parts.push(typeof value === 'string' ? value : value.join('\n'))
  }
  return parts.join('\n')
}

/**
 * Three passes and no more (M55 R1): **NFC**, **lower case**, **every run of whitespace collapsed
 * to one space**, then trimmed.
 *
 * Punctuation SURVIVES, deliberately: two personas that differ by a comma are two different texts,
 * and a normaliser that threw punctuation away would make the `exact` class claim more than it can
 * prove. NFC rather than NFKC for the same reason -- NFKD would fold a ligature and a superscript
 * into things their author did not write.
 *
 * Idempotent, which is what makes a stored `contentSha256` and a re-derived one incapable of
 * drifting.
 */
export function normalisePersona(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** The cross-catalog identity of a persona (M55 R1): `goalSha256` of the normalised canonical text.
 *  DELIBERATELY NOT UNIQUE on the column -- two rows holding the same persona are exactly the fact
 *  this milestone exists to SHOW, and a unique index would turn showing it into refusing the second
 *  import. */
export function contentHashOf(spec: ProfileSpec): string {
  return goalSha256(normalisePersona(canonicalPersonaText(spec)))
}

/**
 * The set of five-word windows over a text (M55 R4).
 *
 * Normalises for itself, so a caller may hand it the raw canonical text and cannot forget to. A
 * body SHORTER than five words yields ONE shingle -- the whole body -- rather than none, because a
 * two-line persona that is copied verbatim is still a duplicate and an empty set would make it
 * invisible. An EMPTY body yields an empty set, which is what a row with no `profileSpec` has, and
 * `jaccard` answers 0 for it.
 */
export function shinglesOf(text: string): ReadonlySet<string> {
  const words = normalisePersona(text).split(' ').filter((word) => word !== '')
  if (words.length === 0) return new Set()
  if (words.length <= SHINGLE_WORDS) return new Set([words.join(' ')])
  const out = new Set<string>()
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) {
    out.add(words.slice(i, i + SHINGLE_WORDS).join(' '))
  }
  return out
}

/**
 * FNV-1a, 32-bit, over a string's UTF-16 units byte by byte.
 *
 * `Math.imul` rather than `*`: the multiplication is defined modulo 2^32 and a plain `*` would
 * produce a double past 2^53 within three characters. Both bytes of each unit are folded, so two
 * strings differing only above U+00FF cannot collide by construction.
 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    hash = Math.imul(hash ^ (unit & 0xff), 0x01000193)
    hash = Math.imul(hash ^ (unit >>> 8), 0x01000193)
  }
  return hash >>> 0
}

/**
 * The 96-value MinHash signature of a shingle set (M55 R4).
 *
 * An EMPTY set answers 96 copies of `MINHASH_PRIME` -- the identity of `min` -- so two rows with no
 * body share every band key and become candidates for each other. That is not a bug and it is not a
 * signal either: `classifyPair` then computes their exact Jaccard, which is 0 for two empty sets,
 * and answers `null`. The banding is a FILTER; the classification is the answer.
 *
 * Independent of the order the shingles were inserted, because `min` is commutative -- which is
 * what makes the stored `bodyBands` column re-derivable by any process in any order.
 */
export function minhashOf(shingles: ReadonlySet<string>): readonly number[] {
  const signature: number[] = new Array<number>(MINHASH_PERMUTATIONS).fill(MINHASH_PRIME)
  for (const shingle of shingles) {
    // Reduced FIRST, which is what makes `base < MINHASH_PRIME` true rather than hoped for, and
    // therefore what makes the bound in `MINHASH_MULTIPLIERS`' docblock hold (erratum E7).
    const base = fnv1a32(shingle) % MINHASH_PRIME
    for (let permutation = 0; permutation < MINHASH_PERMUTATIONS; permutation += 1) {
      const pair = MINHASH_MULTIPLIERS[permutation] as readonly [number, number]
      const value = (pair[0] * base + pair[1]) % MINHASH_PRIME
      if (value < (signature[permutation] as number)) signature[permutation] = value
    }
  }
  return signature
}

/**
 * The signature, cut into `MINHASH_BANDS` keys of `MINHASH_BAND_ROWS` values each (M55 R4).
 *
 * Two rows are CANDIDATES for each other exactly when they share one of these strings. At a true
 * Jaccard of 0.9 that happens with probability 1 - (1 - 0.9^6)^16 ~ 0.999995; at 0.8 (the `near`
 * threshold) ~ 0.992; at 0.3 ~ 0.012 -- so a five-thousand-row catalog yields on the order of sixty
 * candidate pairs per row and not six hundred, which is the bound `DUPLICATE_CANDIDATES_MAX` is
 * sized against rather than clipping real work.
 *
 * The band INDEX is part of the key, so band 0's six values cannot collide with band 3's.
 */
export function bandKeysOf(signature: readonly number[]): readonly string[] {
  if (signature.length !== MINHASH_PERMUTATIONS) {
    throw new Error(`bandKeysOf: a signature is ${String(MINHASH_PERMUTATIONS)} values, got ${String(signature.length)}`)
  }
  const keys: string[] = []
  for (let band = 0; band < MINHASH_BANDS; band += 1) {
    const start = band * MINHASH_BAND_ROWS
    keys.push(`${String(band)}:${signature.slice(start, start + MINHASH_BAND_ROWS).join('-')}`)
  }
  return keys
}

/** The whole pipeline over one spec: what `SlaveTemplate.bodyBands` holds. ONE column rather than
 *  two (R4): the band keys ARE the signature re-encoded, and "do these two rows share a band" is
 *  the only question anything asks of it -- which a list of 96 integers could not answer without a
 *  second derived column holding exactly these strings. */
export function bodyBandsOf(spec: ProfileSpec): readonly string[] {
  return bandKeysOf(minhashOf(shinglesOf(canonicalPersonaText(spec))))
}

/**
 * |A n B| / |A u B|, and **0 for two empty sets** (M55 R4).
 *
 * Not 1. Two personas that name no capability are not thereby the same specialist, and two rows
 * with no `profileSpec` are not thereby the same persona -- the mathematical convention for the
 * empty-over-empty case is a convention, and this is the one place where choosing it wrongly would
 * make the detector claim something nobody can defend.
 *
 * Iterates the SMALLER set, so a five-thousand-shingle persona against a twenty-shingle one costs
 * twenty lookups rather than five thousand.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const item of small) if (large.has(item)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/** Three decimals, at WRITE time (R4), so the number stored on the row is exactly the number a
 *  label prints and exactly the number a test compares -- never a float whose last place differs
 *  between the writer and the reader. */
function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * `aId < bId`, the WRITER's rule (M55 R5), enforced by this one helper every write path goes
 * through.
 *
 * Not a database CHECK constraint, however much it wants to be one: M42 erratum E23 makes the
 * migration proof `prisma migrate diff --from-config-datasource --to-schema ...` -> "No difference
 * detected", and a constraint hand-added to the migration SQL that the Prisma schema cannot express
 * is precisely a difference that proof would report forever. A unit test and the gate hold the rule
 * instead.
 */
export function orderedPair(x: string, y: string): readonly [string, string] {
  if (x === y) throw new Error('orderedPair: a template is never a duplicate of itself')
  return x < y ? [x, y] : [y, x]
}

/** One row as the detector reads it: the projection, plus the shingle set derived from its spec.
 *  `shingles` is EMPTY for a row with no `profileSpec`, which is what makes such a row take part in
 *  the name and capability arms and in neither of the two text arms (R1). */
export interface DuplicateCandidate {
  readonly id: string
  readonly name: string
  readonly contentSha256: string | null
  readonly capabilityKeys: readonly string[]
  readonly shingles: ReadonlySet<string>
}

/** The pair's HIGHEST class and nothing else (R4): one class, one basis, one score. There is no
 *  "overall" number and there is no second-place class -- a row showing two verdicts about the same
 *  pair would be two answers to one question. */
export interface DuplicateVerdict {
  readonly class: DuplicateClass
  readonly basis: DuplicateBasis
  readonly score: number
}

/**
 * The five arms, in order, highest class first (M55 R4).
 *
 *   1. both `contentSha256` non-null and equal -> `exact`, basis `content_hash`, score 1
 *   2. equal NORMALISED names                  -> `exact`, basis `name`, score the body Jaccard
 *   3. body Jaccard >= NEAR_DUPLICATE_JACCARD  -> `near`, basis `body_shingles`
 *   4. capability Jaccard >= CAPABILITY_OVERLAP_JACCARD -> `overlapping`, basis `capability_keys`
 *   5. otherwise                               -> null
 *
 * Arm (4) needs no "different names" test of its own: arm (2) has already claimed every equal-name
 * pair, which is what "highest class only" means operationally.
 *
 * Arm (2) can only ever fire on names that differ AS BYTES and agree after normalisation --
 * `SlaveTemplate.name` is `@unique` (`schema.prisma:338`) and `importCatalog` skips a colliding row
 * `name_taken`, so two byte-equal names cannot both exist. `Backend Architect` against
 * `backend  architect` is precisely the case this arm is for.
 *
 * SYMMETRIC in its two arguments, so the verdict does not depend on which row `orderedPair` put
 * first: every comparison below is an equality or a `jaccard`, and both are.
 */
export function classifyPair(a: DuplicateCandidate, b: DuplicateCandidate): DuplicateVerdict | null {
  if (a.contentSha256 !== null && a.contentSha256 === b.contentSha256) {
    return { class: 'exact', basis: 'content_hash', score: 1 }
  }
  if (normalisePersona(a.name) === normalisePersona(b.name)) {
    return { class: 'exact', basis: 'name', score: roundScore(jaccard(a.shingles, b.shingles)) }
  }
  const body = jaccard(a.shingles, b.shingles)
  if (body >= NEAR_DUPLICATE_JACCARD) {
    return { class: 'near', basis: 'body_shingles', score: roundScore(body) }
  }
  const capabilities = jaccard(new Set(a.capabilityKeys), new Set(b.capabilityKeys))
  if (capabilities >= CAPABILITY_OVERLAP_JACCARD) {
    return { class: 'overlapping', basis: 'capability_keys', score: roundScore(capabilities) }
  }
  return null
}

/** How many undismissed pairs of each class an import noticed (R7). Rides inside the existing
 *  `CatalogImport.report` Json column -- the table gains no counter column, for M42 R5's reason:
 *  the row IS the record, and `RowOutcome[]` already lives in that column. */
export type DuplicateCounts = Readonly<Record<DuplicateClass, number>>

export function emptyDuplicateCounts(): DuplicateCounts {
  return { exact: 0, near: 0, overlapping: 0 }
}

/** `.strict()`, and every count a non-negative INTEGER: this is a row count read back out of a
 *  `Json` column a person can edit with `psql`, and a reader that trusted it would print `3.5
 *  exact` on an import panel. */
export const duplicateCountsSchema: z.ZodType<DuplicateCounts, z.ZodTypeDef, unknown> = z
  .object({
    exact: z.number().int().nonnegative(),
    near: z.number().int().nonnegative(),
    overlapping: z.number().int().nonnegative(),
  })
  .strict()

/** The counts a stored report holds, or three zeroes when it holds something else -- every
 *  `CatalogImport` row written before this milestone, and any row a hand edit broke. Zeroes rather
 *  than `null` so `list-imports` prints seven numbers for every row it has ever written (erratum
 *  E9), and an old import reads as "nothing was noticed", which is true: nothing was looking. */
export function parseDuplicateCounts(value: unknown): DuplicateCounts {
  const parsed = duplicateCountsSchema.safeParse(value)
  return parsed.success ? parsed.data : emptyDuplicateCounts()
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/catalog/duplicate.test.ts`
Expected: PASS — 45 cases.

- [ ] **Step 5: Write the failing test for the searchable string**

`packages/domain/test/catalog/search.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { emptyProfileSpec, type ProfileSpec } from '../../src/profile/spec.js'
import { SEARCH_TEXT_MAX_CHARS, catalogSearchText } from '../../src/catalog/search.js'

const spec = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'The slave who owns the last mile',
  summary: 'Gets a change out and watches what it does',
  mission: 'Take one change to production at a time',
  capabilities: ['Rollout planning', 'Rollback drills'],
  expertise: ['Reading a dashboard back'],
  operatingPrinciples: ['a principle nobody searches for'],
  constraints: ['a constraint nobody searches for'],
  workflow: ['a workflow step nobody searches for'],
  deliverables: ['a deliverable nobody searches for'],
  successCriteria: ['a criterion nobody searches for'],
  collaborationHints: ['a hint nobody searches for'],
  recommendedSkills: ['writing-plans'],
  body: 'a body nobody searches for',
  ...over,
})

describe('catalogSearchText (R3)', () => {
  it('spells its cap once, beside the function that enforces it', () => {
    expect(SEARCH_TEXT_MAX_CHARS).toBe(2000)
  })

  it('holds the SEVEN fields a catalog row displays, so a search matches what a person can see', () => {
    const text = catalogSearchText({ name: 'Gate Release Steward', description: 'Gets a change out.', spec: spec() })
    expect(text).toContain('gate release steward')
    expect(text).toContain('gets a change out.')
    expect(text).toContain('the slave who owns the last mile')
    expect(text).toContain('gets a change out and watches what it does')
    expect(text).toContain('rollout planning')
    expect(text).toContain('reading a dashboard back')
    expect(text).toContain('writing-plans')
  })

  // The residual R3 states out loud and section 6 carries as item 4.
  it('holds NONE of the other seven, which is the cost this milestone accepts and names', () => {
    const text = catalogSearchText({ name: 'Gate Release Steward', description: 'Gets a change out.', spec: spec() })
    for (const absent of ['a principle', 'a constraint', 'a workflow step', 'a deliverable', 'a criterion', 'a hint', 'a body']) {
      expect(text, absent).not.toContain(absent)
    }
  })

  it('is lower-cased and whitespace-collapsed, so the column and the query fold the same way', () => {
    expect(catalogSearchText({ name: '  Gate   RELEASE\tSteward ', description: '', spec: null })).toBe('gate release steward')
  })

  it('survives a row with no structured profile -- name and description are still searchable', () => {
    expect(catalogSearchText({ name: 'Hand Made', description: 'Typed by a person.', spec: null })).toBe(
      'hand made typed by a person.',
    )
  })

  it('never exceeds the cap, and cuts rather than refusing', () => {
    const long = catalogSearchText({
      name: 'Long One',
      description: 'x'.repeat(500),
      spec: spec({ body: 'y'.repeat(20_000) }),
    })
    expect(long.length).toBeLessThanOrEqual(SEARCH_TEXT_MAX_CHARS)
  })

  it('puts the NAME first, so the cap can only ever cost the tail of the prose', () => {
    const text = catalogSearchText({
      name: 'Findable Name',
      description: 'd'.repeat(3000),
      spec: null,
    })
    expect(text.startsWith('findable name')).toBe(true)
    expect(text).toHaveLength(SEARCH_TEXT_MAX_CHARS)
  })

  it('is deterministic -- the same row always produces the same column', () => {
    const input = { name: 'Same', description: 'Same.', spec: spec() }
    expect(catalogSearchText(input)).toBe(catalogSearchText(input))
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/catalog/search.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/catalog/search.js"`.

- [ ] **Step 7: Write the search module and widen the barrel**

`packages/domain/src/catalog/search.ts`:

```ts
import { sliceCodePoints, type ProfileSpec } from '../profile/spec.js'
import { normalisePersona } from './duplicate.js'

/**
 * What `SlaveTemplate.searchText` holds (M55 R3): the lower-cased, whitespace-collapsed join of the
 * seven fields a catalog ROW displays.
 *
 * It exists because a filter vocabulary inside a JSON column cannot be a `where`, which is the
 * exact sentence M47 wrote when it denormalised `capabilityKeys`, applied a second time. Before
 * this milestone `listWorkforceCatalog` read every row, built its effective spec in memory and
 * matched `name`, `summary`, `description`, `capabilities` and `expertise` against the query
 * (`packages/control/src/catalog.ts:780-791`); this is that same haystack, computed once at write
 * time, so the match can be a `contains` clause Postgres runs.
 *
 * A `name`-only search would have been a regression this milestone cannot afford:
 * `gate:m46-workforce-catalog` stage 2a types `rollout` and expects the release steward alone, and
 * that word is in the persona's Identity section and in a capability bullet -- in neither its name
 * (`Gate Release Steward`) nor its description (`Gets a change out and watches what it does.`).
 *
 * SEVEN fields and not fourteen, stated as the cost it is: `operatingPrinciples`, `constraints`,
 * `workflow`, `deliverables`, `successCriteria`, `collaborationHints` and `body` are not here, and
 * the milestone's section 6 carries that as item 4.
 *
 * Built from the EFFECTIVE spec by its caller, not the upstream one (plan erratum E6): a row whose
 * operator rewrote its summary must be findable by the summary the row SHOWS.
 */
export const SEARCH_TEXT_MAX_CHARS = 2000

/**
 * The NAME first, then the description, then the five spec fields -- so a cut at the cap can only
 * ever cost the tail of the prose and never the one thing every operator searches by.
 *
 * `normalisePersona` rather than a second lower-caser (the module next door): the query side folds
 * with exactly this function too, so a column and a search box cannot disagree about what a double
 * space or a decomposed accent is. `sliceCodePoints` rather than `slice`, so a cut never leaves a
 * lone surrogate in a stored column.
 */
export function catalogSearchText(input: {
  readonly name: string
  readonly description: string
  readonly spec: ProfileSpec | null
}): string {
  const parts: string[] = [input.name, input.description]
  if (input.spec !== null) {
    parts.push(
      input.spec.identity,
      input.spec.summary,
      ...input.spec.capabilities,
      ...input.spec.expertise,
      ...input.spec.recommendedSkills,
    )
  }
  return sliceCodePoints(normalisePersona(parts.join('\n')), SEARCH_TEXT_MAX_CHARS)
}
```

`packages/domain/src/catalog/index.ts` becomes:

```ts
export * from './persona.js'
export * from './spec.js'
export * from './duplicate.js'
export * from './search.js'
```

- [ ] **Step 8: Run both domain files and watch them pass**

```bash
npx vitest run packages/domain/test/catalog/
```
Expected: PASS — `duplicate.test.ts` 45 cases, `search.test.ts` 8, plus `persona.test.ts` and `spec.test.ts` unchanged.

- [ ] **Step 9: Write the failing enum-parity assertions**

`packages/db/test/integration/enum-parity.test.ts`. The import list at the top gains `DUPLICATE_BASES` and `DUPLICATE_CLASSES`, and two cases go at the end of the `describe`, immediately after M54's four:

```ts
  // M55 R5: the two new Postgres enums, pinned against the DOMAIN's own arrays rather than against
  // literals -- `classifyPair` is a pure function in `packages/domain` that DECIDES from both, which
  // is plan erratum E9's own rule for where a vocabulary lives and therefore what it is pinned
  // against. A fourth class that reached the union and not the enum would compile clean and fail at
  // the first `writeTemplateDuplicates`, in production, in the middle of a three-hundred-row import.
  it('DuplicateClass matches DUPLICATE_CLASSES, member for member', async () => {
    expect(await enumValues('DuplicateClass')).toEqual([...DUPLICATE_CLASSES].sort())
  })

  it('DuplicateBasis matches DUPLICATE_BASES, member for member', async () => {
    expect(await enumValues('DuplicateBasis')).toEqual([...DUPLICATE_BASES].sort())
  })
```

- [ ] **Step 10: Run them and watch them fail**

Run: `npx vitest run packages/db/test/integration/enum-parity.test.ts`
Expected: FAIL — two cases, each with a Postgres error saying `type "DuplicateClass" does not exist`.

- [ ] **Step 11: Write the schema**

`packages/db/prisma/schema.prisma`. Inside `model SlaveTemplate`, immediately after `unresolvedCapabilities` (`:394`) and before `createdAt`:

```prisma
  /// M55 R2: whether this template is a HIRING CANDIDATE. `false` by default, which is the whole of
  /// "an import produces a library, not a workforce": `importCatalog` creates every row inactive
  /// unless `--activate` was passed, and never writes this column on a row it UPDATES, because
  /// activation is a person's decision and an import is not the moment to revisit it.
  /// `createTemplate` writes `true` -- a template somebody typed by hand IS that deliberate act.
  ///
  /// ONE reader gates on it: `loadCatalogEntries` (`packages/control/src/supervisorWorld.ts`), the
  /// single place a template becomes a `SupervisorCatalogEntry`. `formTeam` and `rankCandidates` are
  /// pure functions over a world and are untouched. `addCompanySlave`, `assignCompany`,
  /// `materialiseCompanySlave` and `add-slave --template` all keep working on an inactive row: an
  /// operator naming a specific row by hand is the same deliberate act as activating it, and a
  /// worker already hired from a template does not stop working when the template is deactivated.
  ///
  /// The migration turns every row that exists on the day of the upgrade to `true`: every one of
  /// them was already a candidate, and an operator upgrading must not find their workforce silently
  /// emptied.
  active        Boolean        @default(false)
  /// Who turned this on or off, and when (M55 R2). NOT an event, and the gap is deliberate:
  /// `appendEvent` requires a `workspaceId`, `ExecutionEvent.workspaceId` is NOT NULL, and a
  /// template belongs to no workspace -- the same rule M42 R5 wrote for `CatalogImport` and M54 R6
  /// wrote for an unmapped delivery. The row IS the record. Both are NULL on a row nobody has ever
  /// toggled, including every row the migration backfilled.
  activationChangedAt DateTime?
  activationChangedBy String?
  /// M55 R1: the CROSS-catalog identity of this persona -- `goalSha256` of the normalised canonical
  /// text (`canonicalPersonaText` + `normalisePersona`,
  /// `packages/domain/src/catalog/duplicate.ts`). `sourceId` is a PATH and answers "is this the row
  /// that file wrote"; `sourceSha256` is over the FILE's bytes and changes when a maintainer fixes a
  /// typo; neither can answer "is this the same specialist as that one" across two catalogs.
  ///
  /// DELIBERATELY NOT UNIQUE: two rows holding the same persona are exactly the fact this milestone
  /// exists to SHOW, and a unique index would turn showing it into refusing the second import. NULL
  /// on a row with no `profileSpec` -- hand-made, or imported before M46 and never re-imported --
  /// which then takes part only in the name and capability classes.
  contentSha256 String?
  /// M55 R4: the sixteen MinHash band keys of this persona's body, the candidate index the `near`
  /// class is found through. Two rows are CANDIDATES exactly when they share one of these strings.
  /// Written from the UPSTREAM spec, never the effective one: the classes are about the persona
  /// somebody published, not about what an operator did to it since.
  bodyBands     String[] @default([])
  /// M55 R3: the lower-cased join of the seven fields a catalog row DISPLAYS (`catalogSearchText`),
  /// capped at `SEARCH_TEXT_MAX_CHARS`. The M47 precedent applied a second time: a filter vocabulary
  /// inside a JSON column cannot be a `where`. Written from the EFFECTIVE spec, so a customised row
  /// is findable by the words its own row shows. `""` means "not backfilled yet" and matches
  /// nothing; the column is never NULL, so no `contains` clause is ever three-valued.
  searchText    String   @default("")
  /// M55 R3: `profileSpec.recommendedSkills` denormalised beside `capabilityKeys`, so the catalog's
  /// skill filter is a `has` clause instead of an in-memory scan. The EFFECTIVE list, for
  /// `searchText`'s reason.
  recommendedSkills String[] @default([])
```

and, in the relation block at the end of the model, beside `runbooks`:

```prisma
  /// M55 R5: the pairs this template is the LOW half of, and the pairs it is the high half of.
  /// Two relations because `aId < bId` is a writer's rule and a pair therefore names this row
  /// through exactly one of them -- and both are what the catalog's `duplicates` filter reads,
  /// `OR: [{ duplicatesA: { some } }, { duplicatesB: { some } }]`.
  duplicatesA        TemplateDuplicate[] @relation("TemplateDuplicateA")
  duplicatesB        TemplateDuplicate[] @relation("TemplateDuplicateB")

  /// M55 R3: the catalog page's own order under its own commonest filter. `loadCatalogEntries`
  /// orders by id and is unaffected; this is for `listWorkforceCatalog`'s `(name, id)` cursor under
  /// an `active` clause.
  @@index([active, name])
```

Then, beside the other enums:

```prisma
/// M55 R4: how alike two catalog rows are, in three named classes and no fourth. `exact` is one
/// persona under two rows; `near` is one persona somebody edited; `overlapping` is two different
/// specialists claiming the same work. A pair carries its HIGHEST class and nothing else.
enum DuplicateClass {
  exact
  near
  overlapping
}

/// M55 R5: WHY a pair classified. One column beyond "how alike", for M53 R1's reason: a surface must
/// be able to answer a question without a join or a guess, and "these two are the same" is a
/// completely different next action from "these two are spelled the same".
enum DuplicateBasis {
  content_hash
  name
  body_shingles
  capability_keys
}
```

and the model, after `SlaveTemplate`:

```prisma
/// M55 R5: one row per ORDERED pair of catalog templates that look alike, written by the importer's
/// fourth post-pass and by `template duplicates --recompute`, dismissed by a person, and never
/// deleted by either.
///
/// `aId < bId` is enforced by ONE helper (`orderedPair`, `packages/domain/src/catalog/duplicate.ts`)
/// that every write path goes through, not by a CHECK constraint: M42 erratum E23 makes the
/// migration proof `prisma migrate diff ...` -> "No difference detected", and a constraint the
/// Prisma schema cannot express is a difference that proof would report forever.
///
/// A template's deletion CASCADES its pairs, which is the one automatic removal in this design and
/// is the right one: a pair naming a row that no longer exists is not a signal, it is a dangling
/// reference. Nothing else removes a row except `recomputeTemplateDuplicates`, which may retire a
/// pair that no longer classifies at all -- this table is derived state, and the residual is stated
/// rather than hidden: a pair that stops classifying and later classifies again comes back
/// undismissed.
model TemplateDuplicate {
  id          String         @id @default(uuid())
  aId         String
  bId         String
  class       DuplicateClass
  basis       DuplicateBasis
  /// The Jaccard behind the class, rounded to three decimals at write time so the stored number IS
  /// the number the label prints. A `Float`, not a `Decimal`: this schema has no `Decimal` column
  /// anywhere, `Float` is what every ratio and every money figure in it is, and a Prisma `Decimal`
  /// arrives in JavaScript as a Decimal.js object that is not JSON-safe -- which would put a
  /// `.toNumber()` in every read path from `packages/control` to the browser.
  score       Float
  detectedAt  DateTime       @default(now())
  /// Written only by `setTemplateDuplicateDismissal`. A dismissed pair stays in this table forever,
  /// greyed rather than gone, with a Restore beside it: the importer never dismisses and never
  /// deletes.
  dismissedAt DateTime?
  dismissedBy String?

  a SlaveTemplate @relation("TemplateDuplicateA", fields: [aId], references: [id], onDelete: Cascade)
  b SlaveTemplate @relation("TemplateDuplicateB", fields: [bId], references: [id], onDelete: Cascade)

  @@unique([aId, bId])
  @@index([bId])
}
```

- [ ] **Step 12: Validate the schema, write the migration, apply it to BOTH databases, and prove the diff**

`prisma validate` FIRST, because a migration written against a schema that will not validate is a migration written against nothing — and because `class` is a JavaScript keyword and this is the moment to find out whether Prisma minds it as a FIELD name (it does not: Prisma's reserved-word list governs model and enum NAMES, and `class` is a legal TypeScript property name, which is what the generated client produces).

```bash
npx prisma validate --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```
Expected: `The schema at packages/db/prisma/schema.prisma is valid`.

`packages/db/prisma/migrations/20260914090000_m55_catalog/migration.sql`:

```sql
-- M55: the column that decides who is a candidate, four denormalised columns that turn an
-- in-memory filter into a `where`, and the table that says which two rows look alike.
--
-- ADDITIVE, with EXACTLY TWO DATA STATEMENTS, both named below and both one-way-safe. Two enums,
-- one table, seven columns on "SlaveTemplate", three indexes (one unique, two secondary). Nothing
-- is dropped, no column changes type, and every existing row reads back exactly as it did apart
-- from the two updates.
--
-- NO CHECK CONSTRAINT for `"aId" < "bId"`, however much it wants one: M42 erratum E23 makes the
-- proof `prisma migrate diff --from-config-datasource --to-schema ... --config
-- packages/db/prisma.config.ts` -> "No difference detected", and a constraint the Prisma schema
-- cannot express is precisely a difference that proof would report forever. `orderedPair`
-- (`packages/domain/src/catalog/duplicate.ts`) is the single writer every path goes through, and a
-- unit test and `gate:m55-catalog` stage 5 hold it.

CREATE TYPE "DuplicateClass" AS ENUM ('exact', 'near', 'overlapping');
CREATE TYPE "DuplicateBasis" AS ENUM ('content_hash', 'name', 'body_shingles', 'capability_keys');

ALTER TABLE "SlaveTemplate" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SlaveTemplate" ADD COLUMN "activationChangedAt" TIMESTAMP(3);
ALTER TABLE "SlaveTemplate" ADD COLUMN "activationChangedBy" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "contentSha256" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "bodyBands" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SlaveTemplate" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SlaveTemplate" ADD COLUMN "recommendedSkills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "SlaveTemplate_active_name_idx" ON "SlaveTemplate"("active", "name");

-- DATA STATEMENT 1 of 2 (M55 R2). Every row that exists on the day of the upgrade becomes active,
-- because every one of them was already a `loadCatalogEntries` candidate and an operator upgrading
-- must not find their workforce silently emptied. From this migration on, `false` is the default
-- and an import writes it on every row it creates.
UPDATE "SlaveTemplate" SET "active" = true;

-- DATA STATEMENT 2 of 2 (M55 R3, plan erratum E8). A FLOOR, not the value: the real `searchText`
-- joins five `profileSpec` fields through `effectiveProfileSpec`'s merge with `profileOverrides`,
-- and reproducing that merge in SQL would be a second writer for one column -- which R10 forbids in
-- its own words for `capabilityKeys`. This keeps an existing install's search box able to find a row
-- by its name and its blurb the minute the migration lands; `template duplicates --recompute`
-- writes the real value over it, and is also what fills "contentSha256", "bodyBands" and
-- "recommendedSkills", none of which can be derived in SQL at all.
UPDATE "SlaveTemplate" SET "searchText" = lower(coalesce("name", '') || ' ' || coalesce("description", ''));

CREATE TABLE "TemplateDuplicate" (
  "id"          TEXT NOT NULL,
  "aId"         TEXT NOT NULL,
  "bId"         TEXT NOT NULL,
  "class"       "DuplicateClass" NOT NULL,
  "basis"       "DuplicateBasis" NOT NULL,
  "score"       DOUBLE PRECISION NOT NULL,
  "detectedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dismissedAt" TIMESTAMP(3),
  "dismissedBy" TEXT,

  CONSTRAINT "TemplateDuplicate_pkey" PRIMARY KEY ("id")
);

-- One row per ORDERED pair. Not a pre-read: a pre-query-then-insert has a race between the two
-- steps that the constraint itself cannot have (`packages/control/src/prisma-errors.ts`'s own
-- reasoning), which is why the writer catches P2002 and updates instead.
CREATE UNIQUE INDEX "TemplateDuplicate_aId_bId_key" ON "TemplateDuplicate"("aId", "bId");
CREATE INDEX "TemplateDuplicate_bId_idx" ON "TemplateDuplicate"("bId");

ALTER TABLE "TemplateDuplicate" ADD CONSTRAINT "TemplateDuplicate_aId_fkey"
  FOREIGN KEY ("aId") REFERENCES "SlaveTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TemplateDuplicate" ADD CONSTRAINT "TemplateDuplicate_bId_fkey"
  FOREIGN KEY ("bId") REFERENCES "SlaveTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Apply and prove:

```bash
npm run db:migrate
npm run db:migrate:test
npm run db:generate
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```
Expected: both migrations apply, and the diff prints **"No difference detected"**. Then `npx tsc --build`, because the generated client's types are what every test file below compiles against.

- [ ] **Step 13: The seed says `active: true`, and the parity tests go green**

`packages/db/src/seed.ts`. Three `create`s gain one field each, and the TRUNCATE list at `:49` is **not** touched (erratum E4: `TemplateDuplicate` cascades from `"SlaveTemplate"`, which is already in the list, and M54 erratum E5's own rule says naming it would be the first redundant entry in that statement).

`:134`:
```ts
    // M55 R2/R12: `active: true` explicitly. A seeded database is a database somebody is meant to
    // be able to staff a company from on the first run, and `active` defaults to `false` for an
    // IMPORT -- a hundred strangers' personas -- not for the five rows this file writes by hand.
    // Same act as `createTemplate`'s, same value.
    await prisma.slaveTemplate.create({ data: { name: template.name, role: template.role, defaultModel: null, active: true } })
```

`:159`:
```ts
  const tradeTemplate = await prisma.slaveTemplate.create({ data: { name: 'Trade Clerk', role: 'clerk', defaultModel: null, active: true } })
```

`:176`:
```ts
    const template = await prisma.slaveTemplate.create({ data: { name: checkoutPlatformTemplateName(role), role, defaultModel: null, active: true } })
```

Run:
```bash
npx vitest run packages/db/test/integration/enum-parity.test.ts
```
Expected: PASS — the two new cases green, every earlier one unchanged.

- [ ] **Step 14: Run the whole suite and RECORD the baseline**

```bash
npx vitest run 2>&1 | tail -20
```
Expected: zero failures, and **two numbers to write down in the task report** — the file count and the test count. Those two numbers are this milestone's floor: every later ladder in this plan is at or above them. The tree this plan was written against counted 357 test files; M53's final ladder recorded 346 files / 5913 tests and M54 added eleven files, so the expected shape is ≈ 359 files and ≈ 6000 tests once this task's two files land. **If the numbers are lower than the M54 Task 6 report's, stop and find out why before continuing** — a column with a NOT NULL default is exactly the kind of change that makes a fixture in another package collide, and only the full suite can see it.

- [ ] **Step 15: Ladder and commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

```bash
git add packages/domain packages/db
git commit -m "$(cat <<'EOF'
feat(domain,db): m55 t1 — the words for "these two are the same", and a column that decides who is a candidate

`packages/domain/src/catalog/duplicate.ts` is pure and imports nothing but `goalSha256` and the
profile spec's types, for the reason `goal/version.ts` already records: `apps/web`'s client bundle
imports this package, and a `node:crypto` in its graph fails `web:build` outright. Three classes,
four bases, seven constants, six functions and one rule -- `aId < bId`, enforced by one helper
rather than by a CHECK constraint the migration proof would report as a difference forever.

The MinHash table is checked in and BOUNDED: every multiplier is under 2^22, so the worst
`a * x + b` this module can compute is 9,007,199,246,352,385 against a MAX_SAFE_INTEGER of
9,007,199,254,740,991. A silently-rounded permutation is deterministic, never throws, and turns a
detector into a coin; the test computes both numbers rather than trusting the comment.

`SlaveTemplate.active` defaults to false and the migration turns every row that already exists to
true, because every one of them was already a hiring candidate and nobody's workforce may empty on
an upgrade. Four denormalised columns -- `contentSha256`, `bodyBands`, `searchText`,
`recommendedSkills` -- pay for four database-side clauses, the M47 precedent applied a second time.
`TemplateDuplicate` is one row per ordered pair, cascading from the template it names, and nothing
in this commit writes one.

No event: the catalogue stays at 61. `ExecutionEvent.workspaceId` is NOT NULL, a template belongs
to no workspace, and `activationChangedAt`/`activationChangedBy` are the record instead -- the rule
M42 R5 and M54 R6 each wrote down before this one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 2: A row nobody hired, four columns that are written where the row is, and a catalog that filters and pages in the database (R2, R3, R6, R11, E2, E6, E12, D15–D29)

`packages/control`, plus the two edits in `apps/web/src/server/org.ts` that the paged read FORCES. After this task an imported template is inert, the Supervisor cannot see it, and `/api/org/catalog` answers a page instead of a table — with no UI to drive any of it yet, which is Task 5.

**Files:**
- Create: `packages/control/test/integration/catalog-activation.test.ts`, `packages/control/test/integration/catalog-page.test.ts`
- Modify: `packages/control/src/org.ts`, `packages/control/src/supervisorWorld.ts`, `packages/control/src/catalog.ts`, `packages/control/src/profile.ts`, `apps/web/src/server/org.ts`
- Test: the two new integration files, plus `packages/control/test/integration/catalog.test.ts` (extended, every existing case unchanged)

**Interfaces:**
- Consumes: `contentHashOf`, `bodyBandsOf`, `normalisePersona`, `catalogSearchText`, `DuplicateClass`, `DuplicateBasis`, `DuplicateFacet` (Task 1); `effectiveProfileSpec`, `profileSpecSchema`, `profileOverridesSchema`, `overriddenFields`, `goalSha256`, `renderProfileSpec` (all already imported by `catalog.ts:3-25`); `isUniqueConstraintViolation` (`packages/control/src/prisma-errors.ts:12`); `Prisma`/`prisma` (`@slave-of-ai/db/client`).
- Produces, for Tasks 3–6:
  - `setTemplateActivation(templateId: string, active: boolean, by?: string): Promise<Result<{ changed: boolean }, ControlRefusal>>`
  - `CATALOG_PAGE_SIZE = 100`, `TEMPLATE_PICKER_MAX = 500`
  - `WorkforceCatalogFilters` with seven members, `WorkforceCatalogPage` with `total` and `nextCursor`, `WorkforceCatalogRow` with `active`/`activationChangedAt`/`activationChangedBy`/`duplicate`/`duplicateCount`, `interface CatalogRowDuplicate`
  - `listWorkforceCatalog(filters?, options?: { cursor?: string; pageSize?: number })`
  - `derivedColumnsOf(input): DerivedCatalogColumns`, `interface DerivedCatalogColumns`
  - `ImportCatalogInput.activate?: boolean`
  - `apps/web`: `WorkforceCatalogView` with `total`/`nextCursor`, `listTemplates()` bounded at `TEMPLATE_PICKER_MAX`

- [ ] **Step 1: Write the failing integration test for activation**

`packages/control/test/integration/catalog-activation.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTemplate, setTemplateActivation } from '../../src/org.js'
import { buildSupervisorWorld } from '../../src/supervisorWorld.js'

const TRUNCATE =
  'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "RunbookTemplate", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE'

/** A template with capability keys, which is what makes it a `loadCatalogEntries` candidate at all
 *  (`supervisorWorld.ts`'s non-empty clause, M47). Written straight through Prisma so the case can
 *  choose `active` rather than inherit whatever a verb decided. */
const template = async (name: string, active: boolean): Promise<string> =>
  (
    await prisma.slaveTemplate.create({
      data: { name, role: 'backend', description: `${name} does one thing.`, capabilityKeys: ['backend.services'], active },
    })
  ).id

describe('setTemplateActivation (M55 R2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('turns a row on and stamps who did it and when', async (): Promise<void> => {
    const id = await template('Inert Persona', false)

    const result = await setTemplateActivation(id, true, 'operator')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ changed: true })
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.active).toBe(true)
    expect(row.activationChangedBy).toBe('operator')
    expect(row.activationChangedAt).not.toBeNull()
  })

  it('turns a row off again, and the stamp moves with it', async (): Promise<void> => {
    const id = await template('Inert Persona', true)
    await setTemplateActivation(id, true, 'first')
    const off = await setTemplateActivation(id, false, 'second')

    expect(off.ok && off.value.changed).toBe(true)
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.active).toBe(false)
    expect(row.activationChangedBy).toBe('second')
  })

  it('says `changed: false` for a no-op rather than pretending it did something', async (): Promise<void> => {
    const id = await template('Already On', true)

    const result = await setTemplateActivation(id, true, 'operator')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ changed: false })
    // And it did not stamp: a no-op is not an act, and recording one would make
    // `activationChangedAt` say a person did something they did not do.
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).activationChangedAt).toBeNull()
  })

  it('refuses a template id nobody wrote, with the kind that already exists', async (): Promise<void> => {
    const result = await setTemplateActivation('00000000-0000-4000-8000-000000000000', true, 'operator')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: 'template_not_found', templateId: '00000000-0000-4000-8000-000000000000' })
  })

  it('accepts no author at all, and records nobody rather than inventing one', async (): Promise<void> => {
    const id = await template('Anonymous Toggle', false)

    await setTemplateActivation(id, true)

    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).activationChangedBy).toBeNull()
  })

  it('writes NO event -- the catalog has no workspace (R2, M42 R5)', async (): Promise<void> => {
    const id = await template('Silent Toggle', false)
    const before = await prisma.executionEvent.count()

    await setTemplateActivation(id, true, 'operator')

    expect(await prisma.executionEvent.count()).toBe(before)
  })
})

describe('createTemplate (M55 R2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('creates a hand-made template ACTIVE -- typing one is the deliberate act `--activate` stands for', async (): Promise<void> => {
    const created = await createTemplate('Typed By A Person', 'backend')

    expect(created.ok).toBe(true)
    if (!created.ok) return
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: created.value.id } })
    expect(row.active).toBe(true)
    // And it is not a TOGGLE: nobody changed anything, so nothing is stamped.
    expect(row.activationChangedAt).toBeNull()
    expect(row.activationChangedBy).toBeNull()
  })
})

describe('loadCatalogEntries through buildSupervisorWorld (M55 R2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  const world = async (): Promise<{ readonly catalog: readonly { readonly templateId: string }[] }> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'M55 Activation Project', repoPath: '/tmp/m55-activation', verifyCommands: ['true'], setupCommands: [] },
    })
    const built = await buildSupervisorWorld(workspace.id)
    if (built === null) throw new Error('buildSupervisorWorld answered null for a workspace it just created')
    return built
  }

  it('admits an ACTIVE template with capability keys', async (): Promise<void> => {
    const id = await template('Hirable', true)

    expect((await world()).catalog.map((entry) => entry.templateId)).toEqual([id])
  })

  it('admits NOTHING that is inactive, however many capabilities it claims', async (): Promise<void> => {
    await template('Imported This Morning', false)

    expect((await world()).catalog).toEqual([])
  })

  it('still excludes an ACTIVE template with no capability keys -- the M47 clause is unchanged', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Active But Mute', role: 'backend', active: true } })

    expect((await world()).catalog).toEqual([])
  })

  it('mixes: three rows, one of each disqualification, one candidate', async (): Promise<void> => {
    const hirable = await template('The One', true)
    await template('Inactive With Keys', false)
    await prisma.slaveTemplate.create({ data: { name: 'Active Without Keys', role: 'backend', active: true } })

    expect((await world()).catalog.map((entry) => entry.templateId)).toEqual([hirable])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/control/test/integration/catalog-activation.test.ts`
Expected: FAIL — `setTemplateActivation is not a function` on the import, and (once that is stubbed away) `createTemplate` writing `active: false` and the world admitting the inactive row.

- [ ] **Step 3: Write the activation verb and the loader's clause**

`packages/control/src/org.ts`, immediately after `createTemplate` (`:56-86`). `createTemplate`'s `data` object gains one line first:

```ts
    const template = await prisma.slaveTemplate.create({
      data: {
        name,
        role,
        // M55 R2: a template somebody typed by hand IS the deliberate act `--activate` stands for,
        // so it is written active and explicitly. The column's DEFAULT is `false`, which is an
        // IMPORT's default -- three hundred strangers' personas arriving at once -- and inheriting
        // it here would make the New template form produce a row that does nothing.
        active: true,
        ...(options?.description !== undefined ? { description: options.description } : {}),
        ...(options?.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
        ...(options?.provider !== undefined ? { provider: options.provider } : {}),
      },
    })
```

and the new verb goes after it:

```ts
/**
 * Turns a catalog template into a hiring candidate, or back out of being one (M55 R2).
 *
 * The ONE operator verb behind "never active by default". `loadCatalogEntries` reads the column and
 * nothing else does: `formTeam` and `rankCandidates` are pure functions over a `SupervisorWorld`,
 * and the honest place to say "this is not a candidate" is where candidates are LOADED, not where
 * they are ranked.
 *
 * **It does not touch `CompanySlave` or `Slave`, ever.** `addCompanySlave`, `assignCompany`,
 * `materialiseCompanySlave` and `add-slave --template` all keep working on an inactive row, because
 * an operator naming a specific row by hand is the same deliberate act as activating it -- and a
 * worker already hired from a template does not stop working when the template is deactivated.
 *
 * Locked check-then-update, the discipline every catalog verb in this file follows (spec section 5):
 * `SELECT ... FOR UPDATE` serialises two operators toggling the same row in the same second, so the
 * stamp that survives is the one whose write survived. Every refusal is reached BEFORE the update,
 * so each is RETURNED; a refusal after the write would have to throw, or Prisma commits it
 * (ADR 0003).
 *
 * `{ changed }` rather than `void`: an operator who types `template activate` twice should be told
 * the second one did nothing, and a verb that answered `ok` either way would make the CLI print a
 * sentence that is only sometimes true. A no-op writes NOTHING -- not even the stamp -- because
 * `activationChangedAt` is a record of an act, and recording one for a request that changed nothing
 * would say a person did something they did not do.
 *
 * **No event**, for the reason `setProfile`'s docblock already gives and M42 R5 wrote down:
 * `ExecutionEvent.workspaceId` is NOT NULL and a template belongs to no project. The row's own
 * `activationChangedAt`/`activationChangedBy` are the record.
 *
 * `by` is a NAME (plan erratum E13): the CLI passes `--by`'s operator name and the web passes the
 * session's user id, which is exactly the pair `CatalogImport.by` already carries. A `Principal`
 * would carry only a `userId` and would make a CLI stamp impossible.
 */
export async function setTemplateActivation(
  templateId: string,
  active: boolean,
  by?: string,
): Promise<Result<{ readonly changed: boolean }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SlaveTemplate" WHERE id = ${templateId} FOR UPDATE`
    const row = await tx.slaveTemplate.findUnique({ where: { id: templateId }, select: { id: true, active: true } })
    if (row === null) {
      return { ok: false as const, error: { kind: 'template_not_found', templateId } as ControlRefusal }
    }
    if (row.active === active) return { ok: true as const, value: { changed: false } }
    await tx.slaveTemplate.update({
      where: { id: templateId },
      data: { active, activationChangedAt: new Date(), activationChangedBy: by ?? null },
    })
    return { ok: true as const, value: { changed: true } }
  })
  return outcome.ok ? ok(outcome.value) : err(outcome.error)
}
```

`packages/control/src/supervisorWorld.ts`, `loadCatalogEntries` (`:127-160`): the docblock gains a sentence and the `where` gains a clause.

```ts
/** Every ACTIVE catalog template that provides ANY capability, plus whether a worker already here
 *  has a profile that recommends pairing with it (R5's advisory tie-break). Two queries, both
 *  bounded: a template with no `capabilityKeys` can never cover a gap, and the hint read is keyed on
 *  the templates the current roster came from.
 *
 *  **`active: true` is M55 R2's only gate, and this is the only place it is applied.** An import
 *  produces a library, not a workforce: three hundred personas arriving on a Tuesday must not become
 *  three hundred rankable candidates on the next tick. `formTeam` and `rankCandidates`
 *  (`packages/domain/src/capability/team.ts:225`) are untouched -- they are pure functions over a
 *  `SupervisorWorld`, and an inactive template simply is not in `SupervisorWorld.catalog`, so it can
 *  never be a `TeamSource` of any kind and `hire_from_catalog` is never proposed for it. */
async function loadCatalogEntries(
  tx: Prisma.TransactionClient,
  slaveRows: readonly { readonly id: string }[],
): Promise<readonly SupervisorCatalogEntry[]> {
  const templates = await tx.slaveTemplate.findMany({
    where: { active: true, NOT: { capabilityKeys: { isEmpty: true } } },
    select: { id: true, name: true, capabilityKeys: true, sourceDivision: true, defaultModel: true },
    orderBy: { id: 'asc' },
    take: CATALOG_ENTRIES_MAX,
  })
```

and `CATALOG_ENTRIES_MAX`'s docstring (`:260-263`) is rewritten, because the sentence it carries is no longer true:

```ts
/** A bound on the candidates a Supervisor world is built from, once a tick.
 *
 *  It used to say "a full catalog import is thousands of rows (M55)", and M55 is where that stopped
 *  being the population this number bounds: since R2 the clause above reads ACTIVE rows, and active
 *  is a person's decision one row at a time -- a far smaller and far more deliberate set than a
 *  catalog. Five hundred SPECIALISTS somebody chose to make hirable is a workforce nobody has, and a
 *  world built from more than that is a ranking nobody can read. The bound stays because a bound
 *  that has never bitten is still the thing that stops one pathological install from building a
 *  ten-thousand-candidate world every tick.
 *
 *  Ordered by id, so the same five hundred rows come back in the same order and `formTeam` is still
 *  deterministic when the bound bites. The 501st ACTIVE template by id is invisible to the
 *  Supervisor, which R2 narrows rather than closes and section 6 carries. */
const CATALOG_ENTRIES_MAX = 500
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/control/test/integration/catalog-activation.test.ts`
Expected: PASS — 12 cases.

- [ ] **Step 5: Write the failing integration test for the paged, database-side read**

`packages/control/test/integration/catalog-page.test.ts`. Rows are written straight through Prisma with their derived columns set by hand, because this file is about the READ: Step 9 is what makes the importer write them.

```ts
import { prisma } from '@slave-of-ai/db/client'
import { catalogSearchText, contentHashOf, emptyProfileSpec, type ProfileSpec } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { CATALOG_PAGE_SIZE, listWorkforceCatalog } from '../../src/catalog.js'

const TRUNCATE =
  'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "RunbookTemplate", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE'

const specOf = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'Somebody who does a thing',
  summary: 'Does the thing and says so',
  capabilities: ['Deployment'],
  expertise: ['Reading a dashboard'],
  recommendedSkills: ['writing-plans'],
  ...over,
})

interface RowInput {
  readonly name: string
  readonly description?: string
  readonly division?: string | null
  readonly sourceId?: string | null
  readonly active?: boolean
  readonly capabilityKeys?: readonly string[]
  readonly skills?: readonly string[]
  readonly spec?: ProfileSpec | null
}

const write = async (input: RowInput): Promise<string> => {
  const spec = input.spec === undefined ? specOf() : input.spec
  const description = input.description ?? `${input.name} does one thing.`
  const row = await prisma.slaveTemplate.create({
    data: {
      name: input.name,
      role: 'backend',
      description,
      sourceId: input.sourceId === undefined ? `catalog-m55/${input.name.toLowerCase().replace(/ /gu, '-')}` : input.sourceId,
      sourceDivision: input.division === undefined ? 'engineering' : input.division,
      active: input.active ?? false,
      capabilityKeys: [...(input.capabilityKeys ?? ['backend.services'])],
      recommendedSkills: [...(input.skills ?? spec?.recommendedSkills ?? [])],
      searchText: catalogSearchText({ name: input.name, description, spec }),
      contentSha256: spec === null ? null : contentHashOf(spec),
      ...(spec === null ? {} : { profileSpec: spec as unknown as object }),
    },
  })
  return row.id
}

/** An undismissed pair, written straight through Prisma -- `writeTemplateDuplicates` is Task 3's. */
const pair = async (
  aId: string,
  bId: string,
  klass: 'exact' | 'near' | 'overlapping',
  score: number,
): Promise<string> => {
  const [low, high] = aId < bId ? [aId, bId] : [bId, aId]
  const row = await prisma.templateDuplicate.create({
    data: { aId: low, bId: high, class: klass, basis: klass === 'exact' ? 'content_hash' : 'body_shingles', score },
  })
  return row.id
}

describe('listWorkforceCatalog: the page (M55 R3)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('spells the page size once', () => {
    expect(CATALOG_PAGE_SIZE).toBe(100)
  })

  it('returns at most a page, the total over the same filter, and a cursor to the rest', async (): Promise<void> => {
    for (let index = 0; index < 7; index += 1) await write({ name: `Row ${String(index).padStart(2, '0')}` })

    const first = await listWorkforceCatalog({}, { pageSize: 3 })

    expect(first.rows.map((row) => row.name)).toEqual(['Row 00', 'Row 01', 'Row 02'])
    expect(first.total).toBe(7)
    expect(first.nextCursor).toBe(first.rows[2]?.id)
  })

  it('walks the whole catalog through the cursor, with no row twice and none missed', async (): Promise<void> => {
    for (let index = 0; index < 7; index += 1) await write({ name: `Row ${String(index).padStart(2, '0')}` })

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page += 1) {
      const answer: Awaited<ReturnType<typeof listWorkforceCatalog>> = await listWorkforceCatalog(
        {},
        { pageSize: 3, ...(cursor === null ? {} : { cursor }) },
      )
      seen.push(...answer.rows.map((row) => row.name))
      cursor = answer.nextCursor
      if (cursor === null) break
    }

    expect(seen).toEqual(['Row 00', 'Row 01', 'Row 02', 'Row 03', 'Row 04', 'Row 05', 'Row 06'])
    expect(new Set(seen).size).toBe(7)
    expect(cursor).toBeNull()
  })

  it('answers a null cursor when the page IS the whole answer', async (): Promise<void> => {
    await write({ name: 'Only Row' })

    const page = await listWorkforceCatalog({}, { pageSize: 3 })

    expect(page.rows).toHaveLength(1)
    expect(page.total).toBe(1)
    expect(page.nextCursor).toBeNull()
  })
})

describe('listWorkforceCatalog: the seven filters, in the database (M55 R3)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('filters by division', async (): Promise<void> => {
    await write({ name: 'Engineer', division: 'engineering' })
    await write({ name: 'Tester', division: 'testing' })

    expect((await listWorkforceCatalog({ division: 'testing' })).rows.map((row) => row.name)).toEqual(['Tester'])
  })

  it('filters by source, both ways', async (): Promise<void> => {
    await write({ name: 'Imported One' })
    await write({ name: 'Hand Made', sourceId: null, division: null })

    expect((await listWorkforceCatalog({ source: 'imported' })).rows.map((row) => row.name)).toEqual(['Imported One'])
    expect((await listWorkforceCatalog({ source: 'local' })).rows.map((row) => row.name)).toEqual(['Hand Made'])
  })

  it('filters by capability KEY -- the vocabulary M47 resolved, not the free text', async (): Promise<void> => {
    await write({ name: 'Backender', capabilityKeys: ['backend.services', 'backend.api-design'] })
    await write({ name: 'Securer', capabilityKeys: ['security.application'] })

    expect((await listWorkforceCatalog({ capability: 'backend.api-design' })).rows.map((row) => row.name)).toEqual(['Backender'])
  })

  it('filters by skill, off the denormalised column', async (): Promise<void> => {
    await write({ name: 'Planner', skills: ['writing-plans'] })
    await write({ name: 'Debugger', skills: ['systematic-debugging'] })

    expect((await listWorkforceCatalog({ skill: 'systematic-debugging' })).rows.map((row) => row.name)).toEqual(['Debugger'])
  })

  it('filters by activation, both ways', async (): Promise<void> => {
    await write({ name: 'Live One', active: true })
    await write({ name: 'Inert One', active: false })

    expect((await listWorkforceCatalog({ active: true })).rows.map((row) => row.name)).toEqual(['Live One'])
    expect((await listWorkforceCatalog({ active: false })).rows.map((row) => row.name)).toEqual(['Inert One'])
  })

  // The case R3's own `*(verified: ...)* ` note is about: `gate:m46-workforce-catalog` stage 2a
  // searches for a word that is in the persona's SUMMARY and in neither its name nor its blurb.
  it('searches the SUMMARY, not only the name -- which is what `searchText` exists for', async (): Promise<void> => {
    await write({
      name: 'Gate Release Steward',
      description: 'Gets a change out and watches what it does.',
      spec: specOf({ summary: 'Takes one rollout to production at a time' }),
    })
    await write({ name: 'Somebody Else', description: 'Unrelated.', spec: specOf({ summary: 'Nothing like it' }) })

    expect((await listWorkforceCatalog({ q: 'rollout' })).rows.map((row) => row.name)).toEqual(['Gate Release Steward'])
  })

  it('searches case-insensitively and through collapsed whitespace, because both sides fold the same way', async (): Promise<void> => {
    await write({ name: 'Gate Release Steward', spec: specOf({ summary: 'Takes one ROLLOUT   to production' }) })

    expect((await listWorkforceCatalog({ q: '  Rollout To ' })).rows).toHaveLength(0)
    expect((await listWorkforceCatalog({ q: '  ROLLOUT   to production ' })).rows).toHaveLength(1)
  })

  it('filters by duplicate CLASS, over both sides of the pair', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    const c = await write({ name: 'Gamma' })
    const d = await write({ name: 'Delta' })
    await pair(a, b, 'exact', 1)
    await pair(c, d, 'overlapping', 0.667)

    expect((await listWorkforceCatalog({ duplicates: 'exact' })).rows.map((row) => row.name)).toEqual(['Alpha', 'Beta'])
    expect((await listWorkforceCatalog({ duplicates: 'overlapping' })).rows.map((row) => row.name)).toEqual(['Delta', 'Gamma'])
    expect((await listWorkforceCatalog({ duplicates: 'near' })).rows).toEqual([])
  })

  it('`none` is the NOT of "any undismissed pair", and a DISMISSED pair puts a row back into it', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    await write({ name: 'Lonely' })
    const pairId = await pair(a, b, 'exact', 1)

    expect((await listWorkforceCatalog({ duplicates: 'none' })).rows.map((row) => row.name)).toEqual(['Lonely'])

    await prisma.templateDuplicate.update({ where: { id: pairId }, data: { dismissedAt: new Date(), dismissedBy: 'operator' } })

    expect((await listWorkforceCatalog({ duplicates: 'none' })).rows.map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Lonely'])
    expect((await listWorkforceCatalog({ duplicates: 'exact' })).rows).toEqual([])
  })

  it('composes: two filters narrow together, and `total` counts the SAME where', async (): Promise<void> => {
    await write({ name: 'Live Engineer', division: 'engineering', active: true })
    await write({ name: 'Inert Engineer', division: 'engineering', active: false })
    await write({ name: 'Live Tester', division: 'testing', active: true })

    const page = await listWorkforceCatalog({ division: 'engineering', active: true })

    expect(page.rows.map((row) => row.name)).toEqual(['Live Engineer'])
    expect(page.total).toBe(1)
  })
})

describe('listWorkforceCatalog: the facets and the row (M55 R3, R6)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('computes every facet over the WHOLE table, never over the page (M46 R6, unchanged)', async (): Promise<void> => {
    await write({ name: 'Engineer', division: 'engineering', capabilityKeys: ['backend.services'], skills: ['writing-plans'] })
    await write({ name: 'Tester', division: 'testing', capabilityKeys: ['qa.test-strategy'], skills: ['systematic-debugging'] })

    const page = await listWorkforceCatalog({ division: 'engineering' })

    expect(page.rows).toHaveLength(1)
    expect(page.facets.divisions).toEqual(['engineering', 'testing'])
    expect(page.facets.capabilities).toEqual(['backend.services', 'qa.test-strategy'])
    expect(page.facets.skills).toEqual(['systematic-debugging', 'writing-plans'])
  })

  it('offers taxonomy KEYS as the capability facet, which is what a `has` clause can match', async (): Promise<void> => {
    await write({ name: 'Engineer', capabilityKeys: ['backend.api-design'] })

    expect((await listWorkforceCatalog()).facets.capabilities).toEqual(['backend.api-design'])
  })

  it('leaves a null division out of the facet rather than printing an empty option', async (): Promise<void> => {
    await write({ name: 'Hand Made', sourceId: null, division: null })

    expect((await listWorkforceCatalog()).facets.divisions).toEqual([])
  })

  it('carries activation on every row, with its stamp', async (): Promise<void> => {
    const id = await write({ name: 'Live One', active: true })
    await prisma.slaveTemplate.update({
      where: { id },
      data: { activationChangedAt: new Date('2026-09-14T09:00:00.000Z'), activationChangedBy: 'operator' },
    })

    const row = (await listWorkforceCatalog()).rows[0]
    expect(row?.active).toBe(true)
    expect(row?.activationChangedBy).toBe('operator')
    expect(row?.activationChangedAt?.toISOString()).toBe('2026-09-14T09:00:00.000Z')
  })

  it('carries the HIGHEST-class undismissed pair and a count, so the chip can say `+N`', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    const c = await write({ name: 'Gamma' })
    await pair(a, b, 'overlapping', 0.667)
    await pair(a, c, 'exact', 1)

    const alpha = (await listWorkforceCatalog()).rows.find((row) => row.name === 'Alpha')
    expect(alpha?.duplicate?.class).toBe('exact')
    expect(alpha?.duplicate?.otherName).toBe('Gamma')
    expect(alpha?.duplicate?.score).toBe(1)
    expect(alpha?.duplicateCount).toBe(2)
  })

  it('carries NOTHING for a row whose only pair is dismissed', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    const pairId = await pair(a, b, 'exact', 1)
    await prisma.templateDuplicate.update({ where: { id: pairId }, data: { dismissedAt: new Date(), dismissedBy: 'operator' } })

    const alpha = (await listWorkforceCatalog()).rows.find((row) => row.name === 'Alpha')
    expect(alpha?.duplicate).toBeNull()
    expect(alpha?.duplicateCount).toBe(0)
  })

  it('names the OTHER template whichever side of the pair this row is', async (): Promise<void> => {
    const a = await write({ name: 'Alpha' })
    const b = await write({ name: 'Beta' })
    await pair(a, b, 'near', 0.9)

    const rows = await listWorkforceCatalog()
    expect(rows.rows.find((row) => row.name === 'Alpha')?.duplicate?.otherName).toBe('Beta')
    expect(rows.rows.find((row) => row.name === 'Beta')?.duplicate?.otherName).toBe('Alpha')
  })

  it('keeps every field M46 and M47 put on a row', async (): Promise<void> => {
    await write({ name: 'Full Row', capabilityKeys: ['backend.services'] })

    const row = (await listWorkforceCatalog()).rows[0]
    expect(row?.source).toBe('imported')
    expect(row?.structured).toBe(true)
    expect(row?.summary).toBe('Does the thing and says so')
    expect(row?.capabilities).toEqual(['Deployment'])
    expect(row?.capabilityKeys).toEqual(['backend.services'])
    expect(row?.expertise).toEqual(['Reading a dashboard'])
    expect(row?.recommendedSkills).toEqual(['writing-plans'])
    expect(row?.rawOverride).toBe(false)
    expect(row?.catalogSlaveCount).toBe(0)
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run packages/control/test/integration/catalog-page.test.ts`
Expected: FAIL — `CATALOG_PAGE_SIZE` does not exist, `listWorkforceCatalog` takes one argument, and every `total`/`nextCursor`/`active`/`duplicate` assertion is `undefined`.

- [ ] **Step 7: Rewrite the catalog read**

`packages/control/src/catalog.ts`. The import block at the top gains the domain's new names:

```ts
import {
  bodyBandsOf,
  catalogSearchText,
  contentHashOf,
  effectiveProfileSpec,
  err,
  goalSha256,
  normalisePersona,
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
  type DuplicateBasis,
  type DuplicateClass,
  type DuplicateFacet,
  type MappingQuality,
  type ProfileOverridableField,
  type ProfileOverrides,
  type ProfileSpec,
  type Result,
} from '@slave-of-ai/domain'
```

The four derived columns get ONE writer, placed just above `importRow` so the importer and the override verb read the same function:

```ts
/** The four columns a template carries so the catalog can filter in the DATABASE (M55 R3/R4). */
export interface DerivedCatalogColumns {
  readonly contentSha256: string
  readonly bodyBands: string[]
  readonly searchText: string
  readonly recommendedSkills: string[]
}

/**
 * The ONE place the four denormalised columns are computed (M55 R3/R4, plan erratum E6).
 *
 * **Two of them come from UPSTREAM and two from EFFECTIVE, and that asymmetry is the whole point.**
 * `contentSha256` and `bodyBands` answer "is this the same persona somebody PUBLISHED", so they read
 * the importer's own `profileSpec` and never `profileOverrides` -- R4 says so in its own words, and a
 * detector that changed its mind because an operator edited a summary would be reporting an
 * operator's typing as a catalog fact. `searchText` and `recommendedSkills` back FILTERS over what
 * the row DISPLAYS, and a catalog row displays the effective spec (`catalogRowOf` below), so a
 * customised row must be findable by the words on it.
 *
 * Three callers, and they are all of them: `importRow`'s create and both of its update paths,
 * `writeOverrides` (`./profile.ts`, which writes only the second pair), and
 * `recomputeTemplateDuplicates` (`./duplicates.ts`, the backfill). One function, so a fifth column
 * later is one edit rather than five.
 */
export function derivedColumnsOf(input: {
  readonly name: string
  readonly description: string
  readonly upstream: ProfileSpec
  readonly overrides: ProfileOverrides
}): DerivedCatalogColumns {
  const effective = effectiveProfileSpec(input.upstream, input.overrides)
  return {
    contentSha256: contentHashOf(input.upstream),
    bodyBands: [...bodyBandsOf(input.upstream)],
    searchText: catalogSearchText({ name: input.name, description: input.description, spec: effective }),
    recommendedSkills: [...effective.recommendedSkills],
  }
}
```

`ImportCatalogInput` gains one field, beside `dryRun`:

```ts
  /** M55 R2: create every row ACTIVE. Off by default, which is the whole ruling -- an import
   *  produces a library, not a workforce. Never applied to a row being UPDATED: activation is a
   *  person's decision and an import is not the moment to revisit it. */
  readonly activate?: boolean
```

`importRow`'s three writes each gain the derived columns, and the CREATE gains `active`:

```ts
          const profile = renderProfileSpec(upstream)
          const derived = derivedColumnsOf({ name: draft.name, description: draft.description, upstream, overrides: {} })
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
              // M55 R2: inert unless the operator asked otherwise, on the row and only on CREATE.
              active: input.activate === true,
              ...derived,
              sourceId: draft.sourceId,
              sourceSha256: draft.sourceSha256,
              sourceDivision: draft.sourceDivision,
              sourceRevision: input.revision ?? null,
              sourceLicense: input.license ?? null,
              importedAt,
            },
          })
```

the M46-E22 "structured" update (a row reaching it has no overrides — `setProfileOverrides` refuses a row with no spec, which the branch's own comment already states):

```ts
        const structuredProfile = renderProfileSpec(upstream)
        const structuredDerived = derivedColumnsOf({
          name: existing.name,
          description: existing.description,
          upstream,
          overrides: {},
        })
        await tx.slaveTemplate.update({
          where: { id: existing.id },
          data: {
            profile: structuredProfile,
            profileSha256: goalSha256(structuredProfile),
            profileSpec: upstream as unknown as Prisma.InputJsonValue,
            capabilityKeys: [...capabilityKeys],
            unresolvedCapabilities: [...unresolvedCapabilities],
            // M55: the row is being structured for the first time, so it is also being given its
            // four derived columns for the first time. `active` is NOT here -- an import never
            // decides that for a row that already exists (R2).
            ...structuredDerived,
            sourceRevision: input.revision ?? null,
            sourceLicense: input.license ?? null,
            importedAt,
          },
        })
```

and the ordinary update, which is the one place the overrides are real:

```ts
      const profile = renderProfileSpec(effectiveProfileSpec(upstream, overrides))
      const updatedDerived = derivedColumnsOf({
        name: existing.name,
        description: draft.description,
        upstream,
        overrides,
      })
```

```ts
      await tx.slaveTemplate.update({
        where: { id: existing.id },
        data: {
          profile,
          profileSha256: goalSha256(profile),
          profileSpec: upstream as unknown as Prisma.InputJsonValue,
          capabilityKeys: [...capabilityKeys],
          unresolvedCapabilities: [...unresolvedCapabilities],
          ...updatedDerived,
          description: draft.description,
          sourceSha256: draft.sourceSha256,
          sourceDivision: draft.sourceDivision,
          sourceRevision: input.revision ?? null,
          sourceLicense: input.license ?? null,
          importedAt,
        },
      })
```

Then the read model. `WorkforceCatalogRow` gains five fields, and a new interface goes above it:

```ts
/** The highest-class undismissed pair a catalog row is in, flattened for the chip beside it
 *  (M55 R6). The OTHER template's name rather than its id, because the chip reads
 *  `Duplicate of Backend Architect` and an id says nothing to the person reading it
 *  (`docs/ia.md` rule 3); the id is beside it so the drawer can open that row. */
export interface CatalogRowDuplicate {
  readonly pairId: string
  readonly class: DuplicateClass
  readonly basis: DuplicateBasis
  readonly score: number
  readonly otherTemplateId: string
  readonly otherName: string
}
```

```ts
  /** M55 R2: whether the Supervisor may hire from this row. A manual hire ignores it. */
  readonly active: boolean
  readonly activationChangedAt: Date | null
  readonly activationChangedBy: string | null
  /** M55 R6: the highest-class UNDISMISSED pair, or null. */
  readonly duplicate: CatalogRowDuplicate | null
  /** How many undismissed pairs this row is in, so the chip can say `+N`. Exact, counted in
   *  Postgres -- a truncated count would be a number that is wrong rather than a number that is
   *  missing. */
  readonly duplicateCount: number
```

`WorkforceCatalogFilters` gains two, and `WorkforceCatalogPage` gains two:

```ts
export interface WorkforceCatalogFilters {
  readonly q?: string
  readonly division?: string
  /** A taxonomy KEY (M55 R3), not the persona's free text: the filter is `capabilityKeys: { has }`,
   *  which is a clause Postgres can run, and the facet offers the same keys rendered through
   *  `capabilityLabel`. */
  readonly capability?: string
  readonly source?: 'imported' | 'local'
  readonly skill?: string
  /** M55 R2/R3. Absent means "either", which is not the same as `false`. */
  readonly active?: boolean
  /** M55 R6. `'none'` is the NOT of "in any undismissed pair"; absent is no filter at all. */
  readonly duplicates?: DuplicateFacet
}

export interface WorkforceCatalogPage {
  readonly rows: readonly WorkforceCatalogRow[]
  readonly facets: WorkforceCatalogFacets
  /** Every row this filter matches, from one `count` over the SAME `where` -- so the page can say
   *  `showing 100 of 312` rather than counting what it happens to be holding. */
  readonly total: number
  /** The id to pass back as `options.cursor` for the next page, or null when this page is the end
   *  of the answer. */
  readonly nextCursor: string | null
}
```

The `where` builder, the row projection, and the rewritten verb replace `matches()` and the old `listWorkforceCatalog` wholesale:

```ts
/** How many rows a page of the Workforce Catalog holds (M55 R3). A hundred is what a person scrolls
 *  before they filter instead, and it is two pages of the gate's own 120-row fixture -- deliberately
 *  small enough that the batching and the paging are both exercised by a catalog a gate can read. */
export const CATALOG_PAGE_SIZE = 100

/** The bound on the UNPAGED read the company pickers take (plan erratum E2).
 *
 *  `apps/web`'s `listTemplates()` feeds `CompanyManager`, `CompanyDetail`, `TeamBlock` and
 *  `NewSlaveDrawer` -- the `<select>`s a company is STAFFED FROM -- and its own docblock says it
 *  must stay the whole catalog. `CATALOG_ENTRIES_MAX`'s number and `CATALOG_ENTRIES_MAX`'s
 *  judgement: five hundred is more templates than any picker is usable with, and a bound is what
 *  stops a five-thousand-row catalog from being rendered into a `<select>`. */
export const TEMPLATE_PICKER_MAX = 500

/**
 * Every filter as a Prisma clause (M55 R3).
 *
 * This is what replaced `matches()`: seven dimensions that used to be an `Array#filter` over every
 * row in the table. `capability` and `skill` are `has` clauses over `String[]` columns, `q` is a
 * `contains` over the denormalised `searchText`, and `duplicates` is a relation filter over BOTH
 * sides of a pair -- `aId < bId` is a writer's rule, so a row is the `a` of some pairs and the `b`
 * of others and only the `OR` sees all of them.
 *
 * `q` is folded with `normalisePersona`, the SAME function that folded the column (plan erratum
 * E12), and `mode: 'insensitive'` is deliberately absent: the column is already lower-cased by
 * construction, so asking Postgres for `ILIKE` over it would be strictly more work for the same
 * answer, on the one clause R3 itself calls a sequential scan.
 */
function catalogWhere(filters: WorkforceCatalogFilters): Prisma.SlaveTemplateWhereInput {
  const clauses: Prisma.SlaveTemplateWhereInput[] = []
  if (filters.source !== undefined) clauses.push({ sourceId: filters.source === 'imported' ? { not: null } : null })
  if (filters.division !== undefined) clauses.push({ sourceDivision: filters.division })
  if (filters.capability !== undefined) clauses.push({ capabilityKeys: { has: filters.capability } })
  if (filters.skill !== undefined) clauses.push({ recommendedSkills: { has: filters.skill } })
  if (filters.active !== undefined) clauses.push({ active: filters.active })
  const q = normalisePersona(filters.q ?? '')
  if (q !== '') clauses.push({ searchText: { contains: q } })
  if (filters.duplicates !== undefined) {
    const some: Prisma.TemplateDuplicateWhereInput =
      filters.duplicates === 'none' ? { dismissedAt: null } : { dismissedAt: null, class: filters.duplicates }
    const inEither: Prisma.SlaveTemplateWhereInput = {
      OR: [{ duplicatesA: { some } }, { duplicatesB: { some } }],
    }
    clauses.push(filters.duplicates === 'none' ? { NOT: inEither } : inEither)
  }
  return clauses.length === 0 ? {} : { AND: clauses }
}

/** The columns one catalog row needs -- `profile` is NOT one of them (M46 fix round 1, minor 3):
 *  the Markdown is up to sixteen kilobytes a row and nothing on a catalog card shows it. The one
 *  thing it was read for, the raw-override hash, is computed in Postgres instead. */
const CATALOG_ROW_SELECT = {
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
  active: true,
  activationChangedAt: true,
  activationChangedBy: true,
} as const

/** One row of the top-pair-plus-count query below. `n` is cast to `int` in SQL because Postgres
 *  `count(*)` is a `bigint`, which Prisma hands back as a `BigInt` that is not JSON-safe. */
interface RowDuplicateRow {
  templateId: string
  pairId: string
  class: DuplicateClass
  basis: DuplicateBasis
  score: number
  otherId: string
  otherName: string
  n: number
}

/**
 * The chip data for one page of rows (M55 R6): each row's HIGHEST-class undismissed pair, and how
 * many it is in.
 *
 * ONE query, in raw SQL, for a reason the `rawOverride` predicate below it already states: Postgres
 * is the right tool for "the best row per group", and the alternatives in Prisma are a `findMany`
 * with a `take` that would truncate somebody's `+N` into a number that is WRONG rather than missing,
 * or three round trips. `DISTINCT ON` would do half of it; `row_number()` beside `count()` does both
 * halves in one pass.
 *
 * `ORDER BY p.class ASC` is the class ranking, and it is not a coincidence: a Postgres enum compares
 * in DECLARATION order, and `DuplicateClass` is declared `exact, near, overlapping` -- strongest
 * first, which is exactly the order R4's arms are in. The schema says so beside the enum and a case
 * in `catalog-page.test.ts` pins it.
 *
 * Bounded by the PAGE: the `= ANY` takes at most `CATALOG_PAGE_SIZE` ids, and the aggregate is
 * computed in Postgres over an index on `aId` (the unique pair index) and on `bId`.
 */
async function rowDuplicatesFor(ids: readonly string[]): Promise<Map<string, RowDuplicateRow>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.$queryRaw<RowDuplicateRow[]>`
    SELECT "templateId", "pairId", class, basis, score, "otherId", "otherName", n
    FROM (
      SELECT p."templateId",
             p."pairId",
             p.class,
             p.basis,
             p.score,
             p."otherId",
             t.name AS "otherName",
             count(*) OVER (PARTITION BY p."templateId")::int AS n,
             row_number() OVER (
               PARTITION BY p."templateId"
               ORDER BY p.class ASC, p.score DESC, p."pairId" ASC
             ) AS rn
      FROM (
        SELECT d."aId" AS "templateId", d.id AS "pairId", d.class, d.basis, d.score, d."bId" AS "otherId"
        FROM "TemplateDuplicate" d
        WHERE d."dismissedAt" IS NULL AND d."aId" = ANY(${[...ids]}::text[])
        UNION ALL
        SELECT d."bId", d.id, d.class, d.basis, d.score, d."aId"
        FROM "TemplateDuplicate" d
        WHERE d."dismissedAt" IS NULL AND d."bId" = ANY(${[...ids]}::text[])
      ) p
      JOIN "SlaveTemplate" t ON t.id = p."otherId"
    ) ranked
    WHERE rn = 1
  `
  return new Map(rows.map((row) => [row.templateId, row] as const))
}

/**
 * The Workforce Catalog's read model (M46 R6, rewritten by M55 R3).
 *
 * **Filtered and PAGED in the database.** It used to read every `SlaveTemplate`, build every
 * effective spec in memory and filter the array; its own docblock argued that the catalog was
 * "hundreds of rows even after a full import -- a page's worth of memory", which stopped being true
 * on the day a full import became three hundred files and could become five thousand. Four
 * denormalised columns pay for four of the seven clauses -- the M47 precedent, whose own sentence is
 * that a filter vocabulary inside a JSON column cannot be a `where` -- and the page is a cursor over
 * `(name, id)`, which is a total order because `id` is unique.
 *
 * **The FACETS are still computed over every row, before filtering** (M46 R6's rule, unchanged): a
 * filter menu built from the filtered rows collapses to whatever was already chosen, which makes it
 * impossible to change your mind. Each is its own bounded query rather than a fold over rows nobody
 * read: one `groupBy` for the divisions and one `SELECT DISTINCT unnest(...)` for each of the two
 * array columns.
 *
 * A DIVISION is a directory a catalog was imported from, so both the menu and the clause read
 * `sourceDivision` alone (M46 plan erratum E22): a hand-made template whose `role` happens to spell
 * "engineering" was never in that directory, and is reached through `source: 'local'` and free text
 * instead.
 */
export async function listWorkforceCatalog(
  filters: WorkforceCatalogFilters = {},
  options: { readonly cursor?: string; readonly pageSize?: number } = {},
): Promise<WorkforceCatalogPage> {
  const where = catalogWhere(filters)
  const take = Math.max(1, Math.min(options.pageSize ?? CATALOG_PAGE_SIZE, TEMPLATE_PICKER_MAX))
  const [templates, total, divisionGroups, capabilityRows, skillRows] = await Promise.all([
    prisma.slaveTemplate.findMany({
      where,
      select: CATALOG_ROW_SELECT,
      // `name` then `id`: a total order, which is what a cursor needs -- two templates cannot share
      // a name (`name @unique`), but the second key costs nothing and makes the order total by
      // construction rather than by a constraint a later migration could relax.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take,
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
    }),
    prisma.slaveTemplate.count({ where }),
    prisma.slaveTemplate.groupBy({ by: ['sourceDivision'], orderBy: { sourceDivision: 'asc' } }),
    prisma.$queryRaw<{ value: string }[]>`
      SELECT DISTINCT unnest("capabilityKeys") AS value FROM "SlaveTemplate" ORDER BY value ASC
    `,
    prisma.$queryRaw<{ value: string }[]>`
      SELECT DISTINCT unnest("recommendedSkills") AS value FROM "SlaveTemplate" ORDER BY value ASC
    `,
  ])

  const ids = templates.map((template) => template.id)
  const [catalogSlaveGroups, rawOverrides, duplicates] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : prisma.companySlave.groupBy({ by: ['templateId'], where: { templateId: { in: ids } }, _count: { _all: true } }),
    // The raw-override predicate, computed in POSTGRES so the profile text stays there, and scoped
    // to the PAGE's ids rather than to the whole table: it is the only reason a catalog listing
    // would touch a sixteen-kilobyte column it never displays, and it should touch at most a
    // hundred rows' worth of it. `sha256(convert_to(text,'UTF8'))` hex is byte-identical to
    // `goalSha256`, and `IS DISTINCT FROM` is what makes a CLEARED profile -- NULL against a
    // recorded hash -- come back true, exactly as `importCatalog` reads it.
    ids.length === 0
      ? Promise.resolve([])
      : prisma.$queryRaw<{ id: string; rawOverride: boolean }[]>`
          SELECT id,
                 (CASE WHEN "profile" IS NULL THEN NULL ELSE encode(sha256(convert_to("profile", 'UTF8')), 'hex') END)
                   IS DISTINCT FROM "profileSha256" AS "rawOverride"
          FROM "SlaveTemplate"
          WHERE "profileSha256" IS NOT NULL AND id = ANY(${ids}::text[])
        `,
    rowDuplicatesFor(ids),
  ])

  const countByTemplate = new Map(catalogSlaveGroups.map((group) => [group.templateId, group._count._all] as const))
  const rawByTemplate = new Map(rawOverrides.map((row) => [row.id, row.rawOverride] as const))
  const rows = templates.map((template) =>
    catalogRowOf(
      template,
      countByTemplate.get(template.id) ?? 0,
      rawByTemplate.get(template.id) ?? false,
      duplicates.get(template.id) ?? null,
    ),
  )

  return {
    rows,
    facets: {
      divisions: divisionGroups.flatMap((group) => (group.sourceDivision === null ? [] : [group.sourceDivision])),
      capabilities: capabilityRows.map((row) => row.value),
      skills: skillRows.map((row) => row.value),
    },
    total,
    // A page shorter than it asked for is the end of the answer -- `buildActivityHistory`'s own rule
    // (`apps/web/src/server/activity.ts:152-154`). A page that is exactly full hands back a cursor
    // even when nothing follows it, which costs one empty request and never a missing row.
    nextCursor: rows.length < take ? null : (rows[rows.length - 1]?.id ?? null),
  }
}
```

`CatalogTemplateRow` gains the three activation columns and `catalogRowOf` gains a fourth parameter:

```ts
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
  active: boolean
  activationChangedAt: Date | null
  activationChangedBy: string | null
}

function catalogRowOf(
  template: CatalogTemplateRow,
  catalogSlaveCount: number,
  rawOverride: boolean,
  duplicate: RowDuplicateRow | null,
): WorkforceCatalogRow {
```

with three lines added to the returned object, after `rawOverride`:

```ts
    active: template.active,
    activationChangedAt: template.activationChangedAt,
    activationChangedBy: template.activationChangedBy,
    duplicate:
      duplicate === null
        ? null
        : {
            pairId: duplicate.pairId,
            class: duplicate.class,
            basis: duplicate.basis,
            score: duplicate.score,
            otherTemplateId: duplicate.otherId,
            otherName: duplicate.otherName,
          },
    duplicateCount: duplicate?.n ?? 0,
```

The old `matches()` function is DELETED — it is the in-memory filter `catalogWhere` replaces, and leaving a second filter implementation beside the first is how two filters disagree.

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run packages/control/test/integration/catalog-page.test.ts`
Expected: PASS — 21 cases.

- [ ] **Step 9: The override verb writes the two columns it owns (erratum E6)**

`packages/control/src/profile.ts`. The import at the top gains `derivedColumnsOf` from `./catalog.js`, and `writeOverrides`' update gains two lines:

```ts
      const next = change(stored.success ? stored.data : {})
      const overridden = overriddenFields(next)
      const profile = renderProfileSpec(effectiveProfileSpec(spec.data, next))
      // M55 plan erratum E6: two of the four derived columns back filters over what the row
      // DISPLAYS, and a row's displayed summary and skills are the EFFECTIVE ones -- so an override
      // that changed them and left `searchText`/`recommendedSkills` alone would make the catalog's
      // search box and skill filter point at words the row no longer shows. The other two
      // (`contentSha256`, `bodyBands`) are deliberately NOT written here: the duplicate classes are
      // about the persona somebody published, not about what an operator did to it since (R4).
      const derived = derivedColumnsOf({
        name: row.name,
        description: row.description,
        upstream: spec.data,
        overrides: next,
      })

      await tx.slaveTemplate.update({
        where: { id: templateId },
        data: {
          profileOverrides: overridden.length === 0 ? Prisma.DbNull : (next as unknown as Prisma.InputJsonValue),
          profile,
          profileSha256: goalSha256(profile),
          searchText: derived.searchText,
          recommendedSkills: derived.recommendedSkills,
        },
      })
```

Two cases join `packages/control/test/integration/catalog.test.ts`'s existing override `describe` (the one whose `beforeEach` is at `:774`), written against that file's own helpers:

```ts
  it('M55 E6: an override rewrites searchText, so the row is findable by the words it now shows', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')])
    const before = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })

    const result = await setProfileOverrides(before.id, { summary: 'A completely different sentence' }, 'operator')

    expect(result.ok).toBe(true)
    const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: before.id } })
    expect(after.searchText).toContain('a completely different sentence')
    expect(after.searchText).not.toBe(before.searchText)
  })

  it('M55 E6: an override does NOT move contentSha256 or bodyBands -- the classes are about the published persona', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')])
    const before = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })

    await setProfileOverrides(before.id, { summary: 'A completely different sentence' }, 'operator')

    const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: before.id } })
    expect(after.contentSha256).toBe(before.contentSha256)
    expect(after.bodyBands).toEqual(before.bodyBands)
  })

  it('M55 R2: an import creates every row INACTIVE unless it was asked otherwise', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')])
    const inert = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })
    expect(inert.active).toBe(false)

    await prisma.$executeRawUnsafe(TRUNCATE_FOR_THIS_FILE)
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [entry('core-builder', 'Core Builder')], activate: true }, 'operator')
    const live = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })
    expect(live.active).toBe(true)
  })

  it('M55 R2: an import NEVER writes `active` on a row it updates, in either direction', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [entry('core-builder', 'Core Builder')], activate: true }, 'operator')
    const created = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })
    expect(created.active).toBe(true)

    // The file changed, so this is a real UPDATE -- and the flag is absent this time.
    await importOne([entry('core-builder', 'Core Builder', 'A different body entirely, rewritten.')])

    const updated = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: created.id } })
    expect(updated.active).toBe(true)
    expect(updated.profileSha256).not.toBe(created.profileSha256)
  })
```

`TRUNCATE_FOR_THIS_FILE` is the literal already in that `describe`'s own `beforeEach` (`catalog.test.ts:779-781`), hoisted to a `const` at the top of the file in this step so the two call sites cannot drift; every existing `beforeEach` in the file is rewritten to use it and none of their strings changes by a character.

- [ ] **Step 10: The two web edits the paged read FORCES (erratum E2)**

`apps/web/src/server/org.ts`. `WorkforceCatalogView` gains the page's two new fields, and `listWorkforceCatalogPage` passes a cursor through:

```ts
export interface WorkforceCatalogView {
  readonly rows: readonly CatalogRowView[]
  /** Computed over EVERY row, before the filters ran (M46 R6): a menu built from the filtered rows
   *  collapses to the value already chosen, which makes it impossible to change your mind. */
  readonly facets: WorkforceCatalogFacets
  /** M55 R3: every row this filter matches, so the count sentence can say `showing 100 of 312`. */
  readonly total: number
  /** M55 R3: pass back as `?cursor=` for the next page; null when this page is the whole answer. */
  readonly nextCursor: string | null
}

export async function listWorkforceCatalogPage(
  filters: WorkforceCatalogFilters = {},
  options: { readonly cursor?: string } = {},
): Promise<WorkforceCatalogView> {
  const page = await listWorkforceCatalog(filters, options)
  return {
    rows: page.rows.map((row) => ({
      ...row,
      importedAt: row.importedAt === null ? null : row.importedAt.toISOString(),
      activationChangedAt: row.activationChangedAt === null ? null : row.activationChangedAt.toISOString(),
    })),
    facets: page.facets,
    total: page.total,
    nextCursor: page.nextCursor,
  }
}
```

`CatalogRowView` turns the second `Date` into an ISO string the same way the first one is:

```ts
/** One catalog row as a `'use client'` component receives it: `WorkforceCatalogRow` with its TWO
 *  `Date`s turned into ISO strings, `GoalVersionView.createdAt`'s idiom. Every other field is
 *  already JSON, so this is the whole of the crossing. */
export type CatalogRowView = Omit<WorkforceCatalogRow, 'importedAt' | 'activationChangedAt'> & {
  readonly importedAt: string | null
  readonly activationChangedAt: string | null
}
```

and `listTemplates` stops going through the page (erratum E2):

```ts
/** Every slave template, UNPAGED and unfiltered -- the shape `CompanyManager`'s member `<select>`,
 *  the New slave drawer and `company/TeamBlock` take, `catalogSlaveCount` (M27 §5.1) included.
 *
 *  M55 plan erratum E2: this deliberately does NOT take `CATALOG_PAGE_SIZE`. These are the pickers a
 *  company is STAFFED FROM, and a hundred-row page under them would silently hide every template
 *  past the hundredth from every one of them. `TEMPLATE_PICKER_MAX` is the bound instead --
 *  `CATALOG_ENTRIES_MAX`'s own number -- and it deliberately does not filter on `active` either:
 *  R2 keeps every manual hire open on an inactive row, and a picker that hid them would close the
 *  one path R2 exists to keep open. */
export async function listTemplates(): Promise<readonly CatalogRowView[]> {
  return (await listWorkforceCatalogPage({}, {})).rows
}
```

— and `listWorkforceCatalogPage`'s call for it passes the picker bound. To keep ONE spelling of that decision, `listTemplates` calls the control verb directly:

```ts
export async function listTemplates(): Promise<readonly CatalogRowView[]> {
  const page = await listWorkforceCatalog({}, { pageSize: TEMPLATE_PICKER_MAX })
  return page.rows.map((row) => ({
    ...row,
    importedAt: row.importedAt === null ? null : row.importedAt.toISOString(),
    activationChangedAt: row.activationChangedAt === null ? null : row.activationChangedAt.toISOString(),
  }))
}
```

with `TEMPLATE_PICKER_MAX` and `listWorkforceCatalog` added to the file's existing `@slave-of-ai/control` import.

- [ ] **Step 11: Run the whole suite**

```bash
npx vitest run 2>&1 | tail -20
```
Expected: at or above Task 1's recorded baseline, zero failures. The files most likely to move are `packages/control/test/integration/catalog.test.ts` (the read model it exercises has been rewritten under it — **every existing case must still pass unchanged**, which is the assertion that R3 kept the surface) and `apps/web/test/workforce-catalog.test.tsx` (its `view()` fixture now lacks `total`/`nextCursor`; add them there as `rows.length` and `null`, which is the honest value for a fixture that is the whole answer).

- [ ] **Step 12: Ladder and commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"   # must be empty
npm run web:build
```

```bash
git add packages/control apps/web/src/server/org.ts apps/web/test
git commit -m "$(cat <<'EOF'
feat(control): m55 t2 — an import produces a library, and the catalog reads like one

`SlaveTemplate.active` now decides who is a hiring candidate, and exactly one reader gates on it:
`loadCatalogEntries`, the single place a template becomes a `SupervisorCatalogEntry`. `formTeam` and
`rankCandidates` are untouched -- they are pure functions over a world, and the honest place to say
"this is not a candidate" is where candidates are loaded. A manual hire still works on an inactive
row, because an operator naming a specific row by hand is the same deliberate act as activating it.

`setTemplateActivation` is a locked check-then-update that answers `{ changed }` rather than
pretending, writes no event (the catalog has no workspace), and stamps the row instead.
`createTemplate` writes `active: true` explicitly: typing a template by hand IS the deliberate act
the flag stands for.

`listWorkforceCatalog` stops being a whole-table `findMany` filtered in memory. Seven filters are
Prisma clauses, the page is a cursor over `(name, id)`, `total` comes from one count over the same
`where`, and the three facets are three bounded queries over the whole table -- because a menu built
from the filtered rows collapses to what is already chosen. Four denormalised columns pay for four
of those clauses, which is M47's own sentence applied a second time: a filter vocabulary inside a
JSON column cannot be a `where`.

Two of the four come from the upstream spec and two from the effective one, and the asymmetry is the
point: a search box must find the words a row SHOWS, and a duplicate class must be about the persona
somebody published rather than about what an operator did to it since. `writeOverrides` therefore
rewrites exactly the first two.

`listTemplates()` does not page: it feeds the pickers a company is staffed from, and a hundred-row
page under them would have hidden the hundred-and-first template from every one of them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 3: What two rows have in common, written down once — and an import that walks three hundred files in batches and says what it noticed (R4, R5, R7, R8, E5, E9, E11, D30–D44)

`packages/control`. The detector, its three bounds, the fourth post-pass, the licence refusal, and the two numbers a report gains. After this task an import writes pairs and reports them; nothing shows them yet, which is Task 4 and Task 5.

**Files:**
- Create: `packages/control/src/duplicates.ts`, `packages/control/test/integration/duplicates.test.ts`
- Modify: `packages/control/src/catalog.ts`, `packages/control/src/refusal.ts`, `packages/control/src/index.ts`, `packages/control/test/simulation-boundary.test.ts`, `packages/control/test/integration/catalog.test.ts`, `apps/web/test/refusal-status.test.ts`
- Test: the new integration file, plus the three extended ones

**Interfaces:**
- Consumes: `classifyPair`, `orderedPair`, `shinglesOf`, `canonicalPersonaText`, `DuplicateCandidate`, `DuplicateCounts`, `emptyDuplicateCounts`, `parseDuplicateCounts`, `normalisePersona`, `DuplicateClass`, `DuplicateBasis` (Task 1); `derivedColumnsOf` and `CATALOG_PAGE_SIZE` (Task 2); `profileSpecSchema`, `profileOverridesSchema`, `effectiveProfileSpec` (`@slave-of-ai/domain`); `isUniqueConstraintViolation` (`packages/control/src/prisma-errors.ts:12`).
- Produces, for Tasks 4–6:
  - `DUPLICATE_SCAN_MAX = 5000`, `DUPLICATE_CANDIDATES_MAX = 200`, `DUPLICATE_SPECS_MAX = 1000`, `TEMPLATE_DUPLICATES_LIMIT = 200`
  - `interface DuplicateScanResult { counts: DuplicateCounts; truncated: boolean; created: number; updated: number; removed: number }`
  - `writeTemplateDuplicates(templateIds: readonly string[]): Promise<DuplicateScanResult>`
  - `recomputeTemplateDuplicates(): Promise<DuplicateScanResult & { backfilled: number }>`
  - `setTemplateDuplicateDismissal(pairId: string, dismissed: boolean, by?: string): Promise<Result<{ changed: boolean }, ControlRefusal>>`
  - `interface TemplateDuplicateView`, `listTemplateDuplicates(options?): Promise<readonly TemplateDuplicateView[]>`
  - `IMPORT_BATCH_SIZE = 100`, `interface ImportProgress`, `ImportCatalogInput.allowUnknownLicense`, `ImportCatalogInput.onProgress`
  - `ImportReport.duplicates: DuplicateCounts`, `ImportReport.scanTruncated: boolean`, `CatalogImportView.duplicates: DuplicateCounts`
  - two refusal kinds: `license_unknown`, `template_duplicate_not_found`

- [ ] **Step 1: Write the two refusal kinds, in all three homes**

`packages/control/src/refusal.ts`. The union gains two arms beside `catalog_empty` (`:376`):

```ts
  | { readonly kind: 'catalog_empty'; readonly directory: string }
  /** M55 R8: the directory has no LICENSE file at its root, so nothing can record where its
   *  personas came from. A STATE, not a missing id -- 409 by `refusalStatus`'s suffix rule, which is
   *  the right answer: the catalog is there and readable, and what is absent is a fact about it. */
  | { readonly kind: 'license_unknown'; readonly directory: string }
  /** M55 R5, plan erratum E5: a `TemplateDuplicate` id nobody wrote. `template_not_found` would name
   *  the wrong noun and tell an operator a TEMPLATE is missing when a PAIR is, and answering `ok`
   *  for a row that does not exist is the pretending `{ changed }` exists to avoid. */
  | { readonly kind: 'template_duplicate_not_found'; readonly pairId: string }
```

and `refusalText` gains two arms beside `catalog_empty`'s (`:649-650`). The licence sentence says what to DO, because a refusal an operator cannot act on is a wall:

```ts
    case 'catalog_empty':
      return `no persona was found under ${refusal.directory}: nothing was imported`
    case 'license_unknown':
      return (
        `${refusal.directory} has no LICENSE file at its root, so nothing can record where its personas came from: ` +
        'pass --allow-unknown-license to import it anyway'
      )
    case 'template_duplicate_not_found':
      return `no duplicate pair with id ${refusal.pairId}`
```

`apps/web/test/refusal-status.test.ts` moves in three places — and the file does not COMPILE until the first of them, because `ALL_KINDS` is `Record<ControlRefusal['kind'], true>`:

```ts
  // M55 R8/R5 (plan erratum E5): the milestone's two. `license_unknown` answers 409 by the suffix
  // rule, which is right -- an unlicensed checkout is a STATE, not a missing id.
  // `template_duplicate_not_found` answers 404, and joins the not-found list below.
  license_unknown: true,
  template_duplicate_not_found: true,
}
```

```ts
  'external_repository_not_found',
  'template_duplicate_not_found',
] as const satisfies readonly ControlRefusal['kind'][]

describe('refusalStatus', () => {
  it('is 404 for exactly the twenty-three kinds ending in _not_found today', () => {
    const bySuffix = ALL.filter((kind) => kind.endsWith('_not_found')).sort()
    expect(bySuffix).toEqual([...TODAYS_NOT_FOUND_KINDS].sort())
    expect(bySuffix).toHaveLength(23)
  })
```

- [ ] **Step 2: Write the failing integration test for the detector**

`packages/control/test/integration/duplicates.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import {
  bodyBandsOf,
  catalogSearchText,
  contentHashOf,
  emptyProfileSpec,
  type ProfileSpec,
} from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DUPLICATE_CANDIDATES_MAX,
  DUPLICATE_SCAN_MAX,
  DUPLICATE_SPECS_MAX,
  listTemplateDuplicates,
  recomputeTemplateDuplicates,
  setTemplateDuplicateDismissal,
  writeTemplateDuplicates,
} from '../../src/duplicates.js'

const TRUNCATE =
  'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "RunbookTemplate", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE'

/** Sixty distinct words, so a body has enough shingles for a Jaccard to mean something. */
const words = (seed: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `${seed}${String(index)}`).join(' ')

const specOf = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'Somebody who does a thing',
  summary: 'Does the thing',
  body: words('w', 60),
  ...over,
})

interface RowInput {
  readonly name: string
  readonly spec?: ProfileSpec | null
  readonly capabilityKeys?: readonly string[]
}

/** One catalog row with its four derived columns already written -- which is what `importRow` does
 *  (Task 2) and what `recomputeTemplateDuplicates` backfills. */
const write = async (input: RowInput): Promise<string> => {
  const spec = input.spec === undefined ? specOf() : input.spec
  const row = await prisma.slaveTemplate.create({
    data: {
      name: input.name,
      role: 'backend',
      description: `${input.name} does one thing.`,
      sourceId: `catalog-m55/engineering/${input.name.toLowerCase().replace(/ /gu, '-')}`,
      sourceDivision: 'engineering',
      capabilityKeys: [...(input.capabilityKeys ?? [])],
      ...(spec === null
        ? {}
        : {
            profileSpec: spec as unknown as object,
            contentSha256: contentHashOf(spec),
            bodyBands: [...bodyBandsOf(spec)],
            searchText: catalogSearchText({ name: input.name, description: '', spec }),
            recommendedSkills: [...spec.recommendedSkills],
          }),
    },
  })
  return row.id
}

const allPairs = async () =>
  prisma.templateDuplicate.findMany({ orderBy: [{ class: 'asc' }, { id: 'asc' }] })

describe('the three bounds (M55 R4)', () => {
  it('spells each once, where the pass reads it', () => {
    expect(DUPLICATE_SCAN_MAX).toBe(5000)
    expect(DUPLICATE_CANDIDATES_MAX).toBe(200)
    expect(DUPLICATE_SPECS_MAX).toBe(1000)
  })
})

describe('writeTemplateDuplicates: the three classes (M55 R4, R5)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('writes an EXACT pair for two rows whose persona text is identical after normalisation', async (): Promise<void> => {
    const a = await write({ name: 'Backend Architect', spec: specOf({ body: 'One   TWO three four five six seven' }) })
    const b = await write({ name: 'Server Specialist', spec: specOf({ body: 'one two   three four five six seven' }) })

    const result = await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('exact')
    expect(pairs[0]?.basis).toBe('content_hash')
    expect(pairs[0]?.score).toBe(1)
    expect(result.counts).toEqual({ exact: 1, near: 0, overlapping: 0 })
    expect(result.created).toBe(1)
  })

  it('writes an EXACT pair for two rows whose NAMES differ only in case', async (): Promise<void> => {
    const a = await write({ name: 'Release Steward', spec: specOf({ body: words('alpha', 60) }) })
    const b = await write({ name: 'release  steward', spec: specOf({ body: words('omega', 60) }) })

    await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('exact')
    expect(pairs[0]?.basis).toBe('name')
    expect(pairs[0]?.score).toBe(0)
  })

  it('writes a NEAR pair for two bodies sharing about nine tenths of their shingles', async (): Promise<void> => {
    const shared = words('w', 60)
    const a = await write({ name: 'One', spec: specOf({ body: shared }) })
    const b = await write({ name: 'Two', spec: specOf({ body: `${shared} tail one tail two tail three` }) })

    const result = await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('near')
    expect(pairs[0]?.basis).toBe('body_shingles')
    expect(pairs[0]?.score).toBeGreaterThanOrEqual(0.8)
    expect(pairs[0]?.score).toBeLessThan(1)
    expect(result.counts).toEqual({ exact: 0, near: 1, overlapping: 0 })
  })

  it('writes an OVERLAPPING pair for two different personas claiming four of five capabilities', async (): Promise<void> => {
    const a = await write({
      name: 'One',
      spec: specOf({ body: words('alpha', 60) }),
      capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k5'],
    })
    const b = await write({
      name: 'Two',
      spec: specOf({ body: words('omega', 60) }),
      capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k9'],
    })

    const result = await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.class).toBe('overlapping')
    expect(pairs[0]?.basis).toBe('capability_keys')
    expect(pairs[0]?.score).toBe(0.667)
    expect(result.counts).toEqual({ exact: 0, near: 0, overlapping: 1 })
  })

  it('writes NOTHING for a pair just under every threshold', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: words('alpha', 60) }), capabilityKeys: ['k1', 'k2', 'k3', 'k4', 'k5'] })
    const b = await write({ name: 'Two', spec: specOf({ body: words('omega', 60) }), capabilityKeys: ['k1', 'k2', 'k7', 'k8', 'k9'] })

    const result = await writeTemplateDuplicates([a, b])

    expect(await allPairs()).toEqual([])
    expect(result.counts).toEqual({ exact: 0, near: 0, overlapping: 0 })
  })

  it('always writes `aId < bId`, whichever order the ids were handed in', async (): Promise<void> => {
    const a = await write({ name: 'Backend Architect', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Server Specialist', spec: specOf({ body: 'same body words here now' }) })

    await writeTemplateDuplicates([b, a])

    const pairs = await allPairs()
    expect(pairs[0]?.aId ?? '').toBeLessThan(pairs[0]?.bId ?? '')
  })

  it('writes ONE row per pair, whichever end of it the import touched', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })

    await writeTemplateDuplicates([a])
    await writeTemplateDuplicates([b])

    expect(await allPairs()).toHaveLength(1)
  })

  it('is IDEMPOTENT: a second pass over the same rows moves no id and no detectedAt', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    const before = await allPairs()

    const result = await writeTemplateDuplicates([a, b])

    expect(await allPairs()).toEqual(before)
    expect(result.created).toBe(0)
    expect(result.updated).toBe(0)
    expect(result.counts).toEqual({ exact: 1, near: 0, overlapping: 0 })
  })

  it('pairs a row with NO profileSpec through the name and capability arms, and never through the text', async (): Promise<void> => {
    const a = await write({ name: 'Release Steward', spec: null, capabilityKeys: ['k1', 'k2'] })
    const b = await write({ name: 'release steward', spec: specOf(), capabilityKeys: ['k1', 'k2'] })

    await writeTemplateDuplicates([a, b])

    const pairs = await allPairs()
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.basis).toBe('name')
    // Its score is the body jaccard, and a row with no spec has no shingles: nothing over nothing.
    expect(pairs[0]?.score).toBe(0)
  })

  it('never pairs a row with itself, however identical it is to itself', async (): Promise<void> => {
    const only = await write({ name: 'Alone', spec: specOf() })

    await writeTemplateDuplicates([only])

    expect(await allPairs()).toEqual([])
  })

  it('does NOT delete a pair, ever -- that is the recompute pass, and nobody else', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    // The bodies diverge under it, but the importer is not the thing that retires a pair.
    await prisma.slaveTemplate.update({ where: { id: b }, data: { contentSha256: 'something-else', bodyBands: [] } })

    const result = await writeTemplateDuplicates([a, b])

    expect(await allPairs()).toHaveLength(1)
    expect(result.removed).toBe(0)
  })
})

describe('recomputeTemplateDuplicates (M55 R4, R5, R10)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('finds the same pairs the import pass found, and creates no tenth on a second run', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    const before = await allPairs()

    const first = await recomputeTemplateDuplicates()
    const second = await recomputeTemplateDuplicates()

    expect(await allPairs()).toEqual(before)
    expect(first.counts).toEqual({ exact: 1, near: 0, overlapping: 0 })
    expect(second).toEqual(first)
  })

  it('RETIRES a pair that no longer classifies, which the importer may not do', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: words('alpha', 60) }) })
    const b = await write({ name: 'Two', spec: specOf({ body: words('omega', 60) }) })
    await prisma.templateDuplicate.create({
      data: { aId: a < b ? a : b, bId: a < b ? b : a, class: 'exact', basis: 'content_hash', score: 1 },
    })

    const result = await recomputeTemplateDuplicates()

    expect(await allPairs()).toEqual([])
    expect(result.removed).toBe(1)
  })

  it('KEEPS a dismissal through a recompute that re-confirms the pair', async (): Promise<void> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    const pairId = (await allPairs())[0]?.id as string
    await setTemplateDuplicateDismissal(pairId, true, 'operator')

    await recomputeTemplateDuplicates()

    const row = await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: pairId } })
    expect(row.dismissedAt).not.toBeNull()
    expect(row.dismissedBy).toBe('operator')
  })

  it('BACKFILLS the four derived columns for a row that has a profileSpec and none of them', async (): Promise<void> => {
    const spec = specOf({ summary: 'A findable summary sentence' })
    const row = await prisma.slaveTemplate.create({
      data: {
        name: 'Pre M55 Row',
        role: 'backend',
        description: 'Imported before this milestone.',
        profileSpec: spec as unknown as object,
      },
    })

    const result = await recomputeTemplateDuplicates()

    const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.contentSha256).toBe(contentHashOf(spec))
    expect(after.bodyBands).toEqual([...bodyBandsOf(spec)])
    expect(after.searchText).toContain('a findable summary sentence')
    expect(after.recommendedSkills).toEqual([...spec.recommendedSkills])
    expect(result.backfilled).toBe(1)
  })

  it('does NOT recompute capabilityKeys -- a second writer for one column is how two writers disagree', async (): Promise<void> => {
    const row = await prisma.slaveTemplate.create({
      data: {
        name: 'Pre M47 Row',
        role: 'backend',
        description: 'Imported before the taxonomy existed.',
        profileSpec: specOf({ capabilities: ['Deployment'] }) as unknown as object,
        capabilityKeys: [],
      },
    })

    await recomputeTemplateDuplicates()

    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: row.id } })).capabilityKeys).toEqual([])
  })

  it('leaves a row with NO profileSpec entirely alone -- there is nothing to derive from', async (): Promise<void> => {
    const row = await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })

    const result = await recomputeTemplateDuplicates()

    const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.contentSha256).toBeNull()
    expect(after.bodyBands).toEqual([])
    expect(result.backfilled).toBe(0)
  })
})

describe('setTemplateDuplicateDismissal (M55 R5)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  const onePair = async (): Promise<string> => {
    const a = await write({ name: 'One', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Two', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    return (await allPairs())[0]?.id as string
  }

  it('stamps who dismissed it and when, and the row STAYS in the table', async (): Promise<void> => {
    const pairId = await onePair()

    const result = await setTemplateDuplicateDismissal(pairId, true, 'operator')

    expect(result.ok && result.value.changed).toBe(true)
    const row = await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: pairId } })
    expect(row.dismissedAt).not.toBeNull()
    expect(row.dismissedBy).toBe('operator')
    expect(await prisma.templateDuplicate.count()).toBe(1)
  })

  it('restores it, and clears BOTH halves of the stamp rather than leaving half a fact', async (): Promise<void> => {
    const pairId = await onePair()
    await setTemplateDuplicateDismissal(pairId, true, 'operator')

    await setTemplateDuplicateDismissal(pairId, false, 'operator')

    const row = await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: pairId } })
    expect(row.dismissedAt).toBeNull()
    expect(row.dismissedBy).toBeNull()
  })

  it('says `changed: false` for a no-op', async (): Promise<void> => {
    const pairId = await onePair()

    const result = await setTemplateDuplicateDismissal(pairId, false, 'operator')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ changed: false })
  })

  it('refuses a pair id nobody wrote, with its OWN kind (plan erratum E5)', async (): Promise<void> => {
    const result = await setTemplateDuplicateDismissal('00000000-0000-4000-8000-000000000000', true, 'operator')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      kind: 'template_duplicate_not_found',
      pairId: '00000000-0000-4000-8000-000000000000',
    })
  })

  it('writes NO event -- the catalog has no workspace', async (): Promise<void> => {
    const pairId = await onePair()
    const before = await prisma.executionEvent.count()

    await setTemplateDuplicateDismissal(pairId, true, 'operator')

    expect(await prisma.executionEvent.count()).toBe(before)
  })
})

describe('listTemplateDuplicates (M55 R6, R10)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('reads a pair with BOTH names, so a surface never has to join to print a sentence', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])

    const rows = await listTemplateDuplicates()

    expect(rows).toHaveLength(1)
    expect([rows[0]?.aName, rows[0]?.bName].sort()).toEqual(['Alpha', 'Beta'])
    expect(rows[0]?.class).toBe('exact')
    expect(rows[0]?.basis).toBe('content_hash')
  })

  it('scopes to one template, over BOTH sides of the pair', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await write({ name: 'Gamma', spec: specOf({ body: words('zeta', 60) }) })
    await writeTemplateDuplicates([a, b])

    expect(await listTemplateDuplicates({ templateId: a })).toHaveLength(1)
    expect(await listTemplateDuplicates({ templateId: b })).toHaveLength(1)
  })

  it('hides a dismissed pair by default and shows it when asked, because it is greyed rather than gone', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])
    const pairId = (await allPairs())[0]?.id as string
    await setTemplateDuplicateDismissal(pairId, true, 'operator')

    expect(await listTemplateDuplicates()).toEqual([])
    expect(await listTemplateDuplicates({ includeDismissed: true })).toHaveLength(1)
  })

  it('filters by class', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])

    expect(await listTemplateDuplicates({ class: 'exact' })).toHaveLength(1)
    expect(await listTemplateDuplicates({ class: 'near' })).toEqual([])
  })

  it('DELETING a template takes its pairs with it, and nothing else', async (): Promise<void> => {
    const a = await write({ name: 'Alpha', spec: specOf({ body: 'same body words here now' }) })
    const b = await write({ name: 'Beta', spec: specOf({ body: 'same body words here now' }) })
    await writeTemplateDuplicates([a, b])

    await prisma.slaveTemplate.delete({ where: { id: a } })

    expect(await prisma.templateDuplicate.count()).toBe(0)
    expect(await prisma.slaveTemplate.count()).toBe(1)
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run packages/control/test/integration/duplicates.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/duplicates.js"`.

- [ ] **Step 4: Write `packages/control/src/duplicates.ts`**

```ts
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  canonicalPersonaText,
  classifyPair,
  emptyDuplicateCounts,
  err,
  normalisePersona,
  ok,
  orderedPair,
  profileOverridesSchema,
  profileSpecSchema,
  shinglesOf,
  type DuplicateBasis,
  type DuplicateCandidate,
  type DuplicateClass,
  type DuplicateCounts,
  type Result,
} from '@slave-of-ai/domain'
import { derivedColumnsOf } from './catalog.js'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'

/**
 * Which catalog rows look like which other catalog rows (M55 R4, R5).
 *
 * **Every loop in this file is bounded, and the bound is STATED rather than hoped for.** The scan
 * reads a projection for at most {@link DUPLICATE_SCAN_MAX} rows; each row takes at most
 * {@link DUPLICATE_CANDIDATES_MAX} partners; and the `profileSpec` column -- the only large column
 * this pass touches at all -- is read in batches of at most {@link DUPLICATE_SPECS_MAX} rows and
 * dropped between them.
 *
 * **The signal never deletes a template.** `deleteSlaveTemplate` (`./org.ts`) is still the only verb
 * in this product that removes a catalog row, and it is a person's act through a confirm. What this
 * file may remove is a PAIR, and only in {@link recomputeTemplateDuplicates}: the table is derived
 * state, and a pair that no longer classifies is not a signal somebody dismissed, it is a fact that
 * stopped being true. The residual is stated rather than hidden -- a pair that stops classifying and
 * later classifies again comes back UNDISMISSED (section 6, item 3).
 *
 * **No event.** The catalog has no workspace (M42 R5); `detectedAt`, `dismissedAt` and `dismissedBy`
 * on the row are the record.
 */

/** How many rows one pass will pair at all, id ascending. A projection of five columns over five
 *  thousand rows is about five megabytes, held once. A catalog beyond it is paired against its first
 *  five thousand rows and `truncated` says so, which is a report and not a fix (section 6, item 7). */
export const DUPLICATE_SCAN_MAX = 5000

/**
 * How many partners one row takes, id ascending within each candidate source.
 *
 * It bites only where a catalog holds hundreds of near-identical personas -- which is itself the
 * signal -- and what is lost there is the 201st instance of a duplicate the operator has already
 * been told about (section 6, item 8).
 *
 * The cap is filled STRONGEST SOURCE FIRST (plan decision D34): the content-hash bucket, then the
 * name bucket, then the band buckets, then the capability buckets, each id ascending. Every source
 * is deterministic and the order between them is fixed, so the choice is reproducible -- and a row
 * sitting in a two-thousand-member `backend.services` bucket cannot crowd out the one other row that
 * holds its exact persona text.
 */
export const DUPLICATE_CANDIDATES_MAX = 200

/** How many `profileSpec` columns are held in memory at once. The pairs are processed in id order
 *  and the shingle map is rebuilt per batch, so peak memory is this many personas' shingles -- about
 *  forty megabytes at a thousand rows of ordinary persona length -- rather than the whole catalog's.
 *  A partner that spans two batches is read twice, which is a re-read and not unbounded memory. */
export const DUPLICATE_SPECS_MAX = 1000

/** How many pairs one read of the table hands back (`listEvidence`'s own shape). */
export const TEMPLATE_DUPLICATES_LIMIT = 200

/** What a pass did. `counts` is what an import reports and what `list-imports` prints. */
export interface DuplicateScanResult {
  readonly counts: DuplicateCounts
  /** The scan hit {@link DUPLICATE_SCAN_MAX}: there are rows this pass did not pair. */
  readonly truncated: boolean
  readonly created: number
  readonly updated: number
  /** Always 0 for {@link writeTemplateDuplicates}: an import never retires a pair. */
  readonly removed: number
}

/** The five columns a pass reads per row. NOT `profileSpec`, which is read separately and in
 *  batches -- this projection is what makes "five megabytes held once" true. */
interface ScanRow {
  readonly id: string
  readonly name: string
  readonly contentSha256: string | null
  readonly capabilityKeys: string[]
  readonly bodyBands: string[]
}

interface PairKey {
  readonly aId: string
  readonly bId: string
}

const keyOf = (pair: PairKey): string => `${pair.aId}|${pair.bId}`

/** An inverted index: bucket value -> the ids in it, id ascending because the rows arrive that way. */
function invert(rows: readonly ScanRow[], valuesOf: (row: ScanRow) => readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const row of rows) {
    for (const value of valuesOf(row)) {
      const bucket = index.get(value)
      if (bucket === undefined) index.set(value, [row.id])
      else bucket.push(row.id)
    }
  }
  return index
}

/**
 * Every pair worth computing an exact Jaccard for, from four inverted indexes (M55 R4).
 *
 * Banding answers the `near` class and nothing else: two rows share a band key with probability
 * 1 - (1 - j^6)^16, which is 0.992 at the 0.8 threshold and 0.012 at a Jaccard of 0.3 -- sixty
 * candidates a row on a five-thousand-row catalog rather than six hundred. The other three classes
 * need their own candidates, because a pair can be `exact` with no shingle in common (two rows with
 * the same NAME and different bodies) and `overlapping` with no shingle in common by definition.
 *
 * `focus` is the import's own set: a pass triggered by an import pairs the rows it TOUCHED against
 * the whole catalog and never re-pairs two rows it did not touch. `null` is the recompute, which
 * pairs everything.
 */
function candidatePairs(rows: readonly ScanRow[], focus: ReadonlySet<string> | null): readonly PairKey[] {
  const byHash = invert(rows, (row) => (row.contentSha256 === null ? [] : [row.contentSha256]))
  const byName = invert(rows, (row) => [normalisePersona(row.name)])
  const byBand = invert(rows, (row) => row.bodyBands)
  const byCapability = invert(rows, (row) => row.capabilityKeys)

  const pairs = new Map<string, PairKey>()
  for (const row of rows) {
    // The strongest sources first, so a crowded capability bucket cannot crowd out the one other row
    // holding this row's exact persona text.
    const sources: readonly (readonly string[])[] = [
      row.contentSha256 === null ? [] : (byHash.get(row.contentSha256) ?? []),
      byName.get(normalisePersona(row.name)) ?? [],
      row.bodyBands.flatMap((band) => byBand.get(band) ?? []),
      row.capabilityKeys.flatMap((key) => byCapability.get(key) ?? []),
    ]
    const taken = new Set<string>()
    for (const source of sources) {
      if (taken.size >= DUPLICATE_CANDIDATES_MAX) break
      for (const other of source) {
        if (taken.size >= DUPLICATE_CANDIDATES_MAX) break
        if (other === row.id || taken.has(other)) continue
        taken.add(other)
        // Skipped when neither end is in focus: an import pairs the rows it touched against the
        // whole catalog, and never re-pairs two rows it did not touch.
        if (focus !== null && !focus.has(row.id) && !focus.has(other)) continue
        const [aId, bId] = orderedPair(row.id, other)
        pairs.set(`${aId}|${bId}`, { aId, bId })
      }
    }
  }
  // Sorted, so the batching below walks the pairs in one stable order and two runs read the same
  // specs in the same batches.
  return [...pairs.values()].sort((left, right) => (keyOf(left) < keyOf(right) ? -1 : keyOf(left) > keyOf(right) ? 1 : 0))
}

/** The shingle set of every named row, from one `findMany` over at most `DUPLICATE_SPECS_MAX` ids.
 *  A row whose `profileSpec` does not parse -- hand-edited, or written by a future version -- gets
 *  an EMPTY set, which is `jaccard`'s zero and never a crash on a catalog page. */
async function shinglesFor(ids: readonly string[]): Promise<Map<string, ReadonlySet<string>>> {
  const rows = await prisma.slaveTemplate.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, profileSpec: true },
  })
  const out = new Map<string, ReadonlySet<string>>()
  for (const row of rows) {
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    out.set(row.id, spec.success ? shinglesOf(canonicalPersonaText(spec.data)) : new Set<string>())
  }
  return out
}

interface ClassifiedPair extends PairKey {
  readonly class: DuplicateClass
  readonly basis: DuplicateBasis
  readonly score: number
}

const candidateOf = (row: ScanRow, shingles: ReadonlyMap<string, ReadonlySet<string>>): DuplicateCandidate => ({
  id: row.id,
  name: row.name,
  contentSha256: row.contentSha256,
  capabilityKeys: row.capabilityKeys,
  shingles: shingles.get(row.id) ?? new Set<string>(),
})

/** One pass: read the projection, form the candidates, classify them in batches. Writes nothing. */
async function classifyAll(focus: ReadonlySet<string> | null): Promise<{
  readonly classified: readonly ClassifiedPair[]
  readonly scanned: ReadonlySet<string>
  readonly truncated: boolean
}> {
  const rows: ScanRow[] = await prisma.slaveTemplate.findMany({
    select: { id: true, name: true, contentSha256: true, capabilityKeys: true, bodyBands: true },
    orderBy: { id: 'asc' },
    take: DUPLICATE_SCAN_MAX,
  })
  const byId = new Map(rows.map((row) => [row.id, row] as const))
  const pairs = candidatePairs(rows, focus)

  const classified: ClassifiedPair[] = []
  let index = 0
  while (index < pairs.length) {
    const batch: PairKey[] = []
    const needed = new Set<string>()
    // A single pair always fits (two ids against a thousand), so this loop always advances.
    while (index < pairs.length && needed.size + 2 <= DUPLICATE_SPECS_MAX) {
      const pair = pairs[index] as PairKey
      batch.push(pair)
      needed.add(pair.aId)
      needed.add(pair.bId)
      index += 1
    }
    const shingles = await shinglesFor([...needed])
    for (const pair of batch) {
      const a = byId.get(pair.aId)
      const b = byId.get(pair.bId)
      if (a === undefined || b === undefined) continue
      const verdict = classifyPair(candidateOf(a, shingles), candidateOf(b, shingles))
      if (verdict === null) continue
      classified.push({ ...pair, class: verdict.class, basis: verdict.basis, score: verdict.score })
    }
  }

  return { classified, scanned: new Set(rows.map((row) => row.id)), truncated: rows.length === DUPLICATE_SCAN_MAX }
}

/** Writes one classified pair, and says what it did. Read-then-write rather than `upsert`, for two
 *  reasons: a pair whose verdict has not changed is not written AT ALL (so `detectedAt` cannot move
 *  and a re-import genuinely writes nothing), and the caller can report `created` against `updated`.
 *  The unique index is still the authority -- a concurrent create answers P2002 and is turned into
 *  the update it should have been. */
async function writePair(pair: ClassifiedPair): Promise<'created' | 'updated' | 'unchanged' | 'dismissed'> {
  const existing = await prisma.templateDuplicate.findUnique({
    where: { aId_bId: { aId: pair.aId, bId: pair.bId } },
    select: { id: true, class: true, basis: true, score: true, dismissedAt: true },
  })
  if (existing === null) {
    try {
      await prisma.templateDuplicate.create({
        data: { aId: pair.aId, bId: pair.bId, class: pair.class, basis: pair.basis, score: pair.score },
      })
      return 'created'
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error
      await prisma.templateDuplicate.update({
        where: { aId_bId: { aId: pair.aId, bId: pair.bId } },
        data: { class: pair.class, basis: pair.basis, score: pair.score },
      })
      return 'updated'
    }
  }
  const same = existing.class === pair.class && existing.basis === pair.basis && existing.score === pair.score
  if (!same) {
    // `detectedAt` is NOT in this write and never will be: it is when this pair was first noticed,
    // and a re-classification is not a new noticing. Neither is the dismissal.
    await prisma.templateDuplicate.update({
      where: { id: existing.id },
      data: { class: pair.class, basis: pair.basis, score: pair.score },
    })
  }
  if (existing.dismissedAt !== null) return 'dismissed'
  return same ? 'unchanged' : 'updated'
}

/**
 * The importer's FOURTH post-pass (M55 R7), beside `writeCollaborationHints` and
 * `writePersonaRunbooks` and for their exact reason (M42 plan erratum E11): a persona imported later
 * in the same run is not in the table while an earlier row is being written, so pairing before the
 * loop ends would miss every pair inside the run.
 *
 * Pairs the rows this import TOUCHED against the whole catalog, and never re-pairs two rows it did
 * not touch. **Removes nothing**: `removed` is always 0, and retiring a pair is
 * {@link recomputeTemplateDuplicates}'s act alone. A pair a person has DISMISSED is still
 * re-confirmed in place -- its class and score are kept current -- and is not COUNTED, because the
 * counts are what the operator is being told about and a dismissal is them saying they already know.
 */
export async function writeTemplateDuplicates(templateIds: readonly string[]): Promise<DuplicateScanResult> {
  if (templateIds.length === 0) {
    return { counts: emptyDuplicateCounts(), truncated: false, created: 0, updated: 0, removed: 0 }
  }
  const { classified, truncated } = await classifyAll(new Set(templateIds))
  const counts: Record<DuplicateClass, number> = { exact: 0, near: 0, overlapping: 0 }
  let created = 0
  let updated = 0
  for (const pair of classified) {
    const outcome = await writePair(pair)
    if (outcome === 'created') created += 1
    if (outcome === 'updated') updated += 1
    if (outcome !== 'dismissed') counts[pair.class] += 1
  }
  return { counts, truncated, created, updated, removed: 0 }
}

/** Fills the four derived columns for every row that has a `profileSpec` and is missing one, in
 *  batches. Returns how many rows moved. */
async function backfillDerivedColumns(): Promise<number> {
  let filled = 0
  for (;;) {
    const rows = await prisma.slaveTemplate.findMany({
      where: {
        NOT: { profileSpec: { equals: Prisma.DbNull } },
        OR: [{ contentSha256: null }, { bodyBands: { isEmpty: true } }, { searchText: '' }],
      },
      select: { id: true, name: true, description: true, profileSpec: true, profileOverrides: true },
      orderBy: { id: 'asc' },
      take: DUPLICATE_SPECS_MAX,
    })
    if (rows.length === 0) return filled
    let moved = 0
    for (const row of rows) {
      const spec = profileSpecSchema.safeParse(row.profileSpec)
      // A spec this build cannot parse is left alone rather than half-derived: a `contentSha256`
      // over an empty spec would be a hash of nothing, claiming a persona this row does not have.
      if (!spec.success) continue
      const stored = profileOverridesSchema.safeParse(row.profileOverrides ?? {})
      await prisma.slaveTemplate.update({
        where: { id: row.id },
        data: derivedColumnsOf({
          name: row.name,
          description: row.description,
          upstream: spec.data,
          overrides: stored.success ? stored.data : {},
        }),
      })
      moved += 1
    }
    filled += moved
    // Every row in the page was unparseable, so the same page would come back forever.
    if (moved === 0) return filled
  }
}

/**
 * The whole-table pass (M55 R4/R5), and the BACKFILL (R10).
 *
 * Two things in one verb because they are one operator act: an install upgrading to M55 has rows
 * with a `profileSpec` and none of the four derived columns, and pairing them before filling those
 * columns would classify every one of them as having no persona text at all. The backfill runs
 * FIRST, in batches of {@link DUPLICATE_SPECS_MAX}, and only touches rows that have a spec and are
 * missing at least one column.
 *
 * It deliberately does NOT recompute `capabilityKeys` (R10): that is the importer's write, against a
 * taxonomy the import also syncs, and a second writer for one column is how two writers disagree.
 *
 * Then it re-classifies the whole table, updates `class`/`basis`/`score` in place -- keeping
 * `detectedAt` and any dismissal -- and REMOVES a pair that no longer classifies at all, as long as
 * both of its rows were inside this scan. A pair whose rows fell outside `DUPLICATE_SCAN_MAX` is
 * left exactly where it is, because this pass has no opinion about a pair it did not look at.
 */
export async function recomputeTemplateDuplicates(): Promise<DuplicateScanResult & { readonly backfilled: number }> {
  const backfilled = await backfillDerivedColumns()
  const { classified, scanned, truncated } = await classifyAll(null)

  const counts: Record<DuplicateClass, number> = { exact: 0, near: 0, overlapping: 0 }
  let created = 0
  let updated = 0
  for (const pair of classified) {
    const outcome = await writePair(pair)
    if (outcome === 'created') created += 1
    if (outcome === 'updated') updated += 1
    if (outcome !== 'dismissed') counts[pair.class] += 1
  }

  const survivors = new Set(classified.map(keyOf))
  const stale: string[] = []
  let cursor: string | null = null
  for (;;) {
    const page: { id: string; aId: string; bId: string }[] = await prisma.templateDuplicate.findMany({
      select: { id: true, aId: true, bId: true },
      orderBy: { id: 'asc' },
      take: DUPLICATE_SPECS_MAX,
      ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
    })
    if (page.length === 0) break
    for (const row of page) {
      if (!scanned.has(row.aId) || !scanned.has(row.bId)) continue
      if (survivors.has(keyOf(row))) continue
      stale.push(row.id)
    }
    if (page.length < DUPLICATE_SPECS_MAX) break
    cursor = page[page.length - 1]?.id ?? null
  }
  for (let index = 0; index < stale.length; index += DUPLICATE_SPECS_MAX) {
    await prisma.templateDuplicate.deleteMany({ where: { id: { in: stale.slice(index, index + DUPLICATE_SPECS_MAX) } } })
  }

  return { counts, truncated, created, updated, removed: stale.length, backfilled }
}

/** One pair as the CLI and the drawer read it: both names, so a surface never joins to print a
 *  sentence (`docs/ia.md` rule 3 -- an id says nothing to the person reading it). */
export interface TemplateDuplicateView {
  readonly id: string
  readonly class: DuplicateClass
  readonly basis: DuplicateBasis
  readonly score: number
  readonly detectedAt: Date
  readonly dismissedAt: Date | null
  readonly dismissedBy: string | null
  readonly aId: string
  readonly aName: string
  readonly bId: string
  readonly bName: string
}

/**
 * The pairs, strongest first (M55 R6/R10).
 *
 * `orderBy: { class: 'asc' }` IS the class ranking: a Postgres enum compares in DECLARATION order,
 * and `DuplicateClass` is declared `exact, near, overlapping` -- strongest first, which is the order
 * `classifyPair`'s arms are in. Ties break on score descending and then on id, so the list is total.
 *
 * Dismissed pairs are OUT by default and available on request: a dismissal is a person saying "I
 * know", not a person saying "delete this", and the row stays in the table forever with a Restore
 * beside it.
 */
export async function listTemplateDuplicates(
  options: {
    readonly templateId?: string
    readonly class?: DuplicateClass
    readonly includeDismissed?: boolean
    readonly limit?: number
  } = {},
): Promise<readonly TemplateDuplicateView[]> {
  const where: Prisma.TemplateDuplicateWhereInput = {
    ...(options.includeDismissed === true ? {} : { dismissedAt: null }),
    ...(options.class === undefined ? {} : { class: options.class }),
    ...(options.templateId === undefined ? {} : { OR: [{ aId: options.templateId }, { bId: options.templateId }] }),
  }
  const rows = await prisma.templateDuplicate.findMany({
    where,
    orderBy: [{ class: 'asc' }, { score: 'desc' }, { id: 'asc' }],
    take: Math.max(0, Math.min(options.limit ?? TEMPLATE_DUPLICATES_LIMIT, TEMPLATE_DUPLICATES_LIMIT)),
    select: {
      id: true,
      class: true,
      basis: true,
      score: true,
      detectedAt: true,
      dismissedAt: true,
      dismissedBy: true,
      aId: true,
      bId: true,
      a: { select: { name: true } },
      b: { select: { name: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    class: row.class,
    basis: row.basis,
    score: row.score,
    detectedAt: row.detectedAt,
    dismissedAt: row.dismissedAt,
    dismissedBy: row.dismissedBy,
    aId: row.aId,
    aName: row.a.name,
    bId: row.bId,
    bName: row.b.name,
  }))
}

/**
 * A person says "I know" about a pair, or takes it back (M55 R5).
 *
 * The ONLY writer of `dismissedAt`/`dismissedBy`. The importer never dismisses and never deletes; a
 * dismissed pair stays in the table forever, greyed rather than gone.
 *
 * Locked check-then-update, the catalog's own discipline, with every refusal reached BEFORE the
 * write so each is returned rather than thrown (ADR 0003). A restore clears BOTH halves of the
 * stamp: a `dismissedBy` with no `dismissedAt` is half a fact, and the next reader would have to
 * guess which half to believe.
 */
export async function setTemplateDuplicateDismissal(
  pairId: string,
  dismissed: boolean,
  by?: string,
): Promise<Result<{ readonly changed: boolean }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TemplateDuplicate" WHERE id = ${pairId} FOR UPDATE`
    const row = await tx.templateDuplicate.findUnique({ where: { id: pairId }, select: { id: true, dismissedAt: true } })
    if (row === null) {
      return { ok: false as const, error: { kind: 'template_duplicate_not_found', pairId } as ControlRefusal }
    }
    if ((row.dismissedAt !== null) === dismissed) return { ok: true as const, value: { changed: false } }
    await tx.templateDuplicate.update({
      where: { id: pairId },
      data: dismissed ? { dismissedAt: new Date(), dismissedBy: by ?? null } : { dismissedAt: null, dismissedBy: null },
    })
    return { ok: true as const, value: { changed: true } }
  })
  return outcome.ok ? ok(outcome.value) : err(outcome.error)
}
```

`packages/control/src/index.ts` gains one line after `export * from './catalog.js'`:

```ts
export * from './duplicates.js'
```

**One circular import, named here so nobody "fixes" it.** `duplicates.ts` imports `derivedColumnsOf` from `catalog.ts`, and `catalog.ts` imports `writeTemplateDuplicates` from `duplicates.ts`. TypeScript and Node both handle this, because the two symbols are functions CALLED at run time and never values read at module load — the shape `packages/control/src/goal.ts` and `packages/control/src/workspace.ts` already have. Moving `derivedColumnsOf` into `duplicates.ts` to "break" it would force the importer to reach across for its own write, which is worse.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run packages/control/test/integration/duplicates.test.ts`
Expected: PASS — 25 cases.

- [ ] **Step 6: Write the failing test for the licence refusal, the batching and the widened report**

Three things join `packages/control/test/integration/catalog.test.ts`. First, the TRUNCATE literal that appears four times in the file (`:48,454,487,779`) is hoisted to one `const TRUNCATE_ALL` at the top and every `beforeEach` reads it — not a character of any of them changes, and the new blocks below can then say the same thing once. Second, the helper at `:37-40` gains a licence, because from this task on an import must name one:

```ts
const importOne = async (
  entries: readonly ReturnType<typeof entry>[],
  options: { roleMap?: Record<string, string>; dryRun?: boolean; activate?: boolean } = {},
) => importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries, license: 'MIT', ...options }, 'operator')
```

Third: run `grep -n 'importCatalog(' packages/control/test/integration/catalog.test.ts` and give every input literal the grep lists — the calls that do NOT go through `importOne` — a `license: 'MIT'`, unless the case is deliberately about the refusal. That is the whole migration of the file: no assertion moves.

New cases, in two `describe`s at the end of the file:

```ts
describe('importCatalog: the licence (M55 R8)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE_ALL)
  })

  it('REFUSES a catalog whose licence it cannot name, before a single row is read', async (): Promise<void> => {
    const result = await importCatalog(
      { catalog: CATALOG, directory: DIRECTORY, entries: [entry('core-builder', 'Core Builder')], license: null },
      'operator',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: 'license_unknown', directory: DIRECTORY })
    // Nothing at all: not a template, not an import record, not a pair. Three counts, because
    // "writes nothing" is three tables and only looking at all three proves it.
    expect(await prisma.slaveTemplate.count()).toBe(0)
    expect(await prisma.catalogImport.count()).toBe(0)
    expect(await prisma.templateDuplicate.count()).toBe(0)
  })

  it('refuses a catalog that named no licence AT ALL, the same way', async (): Promise<void> => {
    const result = await importCatalog(
      { catalog: CATALOG, directory: DIRECTORY, entries: [entry('core-builder', 'Core Builder')] },
      'operator',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('license_unknown')
  })

  it('imports it anyway when asked, and records the licence as unknown rather than inventing one', async (): Promise<void> => {
    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [entry('core-builder', 'Core Builder')],
        license: null,
        allowUnknownLicense: true,
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })
    expect(row.sourceLicense).toBeNull()
  })

  it('refuses an EMPTY directory before it refuses an unlicensed one -- the more basic fact wins', async (): Promise<void> => {
    const result = await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [], license: null }, 'operator')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('catalog_empty')
  })
})

describe('importCatalog: batches, progress and the widened report (M55 R7)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(TRUNCATE_ALL)
  })

  it('spells the batch size once', () => {
    expect(IMPORT_BATCH_SIZE).toBe(100)
  })

  it('reports progress once per batch and once at the end, with running counts', async (): Promise<void> => {
    const entries = Array.from({ length: 250 }, (_, index) => entry(`persona-${String(index)}`, `Persona ${String(index)}`))
    const seen: { done: number; total: number; created: number }[] = []

    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries,
        license: 'MIT',
        onProgress: (progress) => seen.push({ done: progress.done, total: progress.total, created: progress.created }),
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    expect(seen.map((line) => line.done)).toEqual([100, 200, 250])
    expect(seen.every((line) => line.total === 250)).toBe(true)
    expect(seen[2]?.created).toBe(250)
  })

  it('carries the duplicate counts and the truncation flag on the report', async (): Promise<void> => {
    const body = 'one two three four five six seven eight nine ten'
    const result = await importOne([entry('first', 'First Persona', body), entry('second', 'Second Persona', body)])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.duplicates).toEqual({ exact: 1, near: 0, overlapping: 0 })
    expect(result.value.scanTruncated).toBe(false)
  })

  it('writes those counts INTO the CatalogImport row, so list-imports reads the same numbers', async (): Promise<void> => {
    const body = 'one two three four five six seven eight nine ten'
    await importOne([entry('first', 'First Persona', body), entry('second', 'Second Persona', body)])

    const views = await listCatalogImports(1)

    expect(views[0]?.duplicates).toEqual({ exact: 1, near: 0, overlapping: 0 })
  })

  it('reads three ZEROES back out of an import recorded before this milestone', async (): Promise<void> => {
    await prisma.catalogImport.create({
      data: {
        catalog: CATALOG,
        directory: DIRECTORY,
        by: 'operator',
        startedAt: new Date(),
        finishedAt: new Date(),
        created: 1,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        report: { created: [], updated: [], unchanged: [], skipped: [] },
      },
    })

    expect((await listCatalogImports(1))[0]?.duplicates).toEqual({ exact: 0, near: 0, overlapping: 0 })
  })

  it('a DRY RUN writes no pair and reports no duplicate', async (): Promise<void> => {
    const body = 'one two three four five six seven eight nine ten'
    const result = await importOne(
      [entry('first', 'First Persona', body), entry('second', 'Second Persona', body)],
      { dryRun: true },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.duplicates).toEqual({ exact: 0, near: 0, overlapping: 0 })
    expect(await prisma.templateDuplicate.count()).toBe(0)
  })
})
```

with `IMPORT_BATCH_SIZE` and `listCatalogImports` added to the file's import from `../../src/catalog.js`.

- [ ] **Step 7: Run them, watch them fail, and widen `importCatalog`**

Run: `npx vitest run packages/control/test/integration/catalog.test.ts`
Expected: FAIL — `license_unknown` is not returned, `IMPORT_BATCH_SIZE` does not exist, `onProgress` is not a known key, and `report.duplicates` is `undefined`.

`packages/control/src/catalog.ts`. `ImportCatalogInput` gains two fields beside `activate`:

```ts
  /** M55 R8: import a catalog whose licence nothing could name. Off by default -- a checkout with no
   *  LICENSE at its root is a checkout nothing can record the provenance of, and M46's whole Source
   *  record is the thing that would be empty. */
  readonly allowUnknownLicense?: boolean
  /** M55 R7: one call per batch of {@link IMPORT_BATCH_SIZE} rows and one at the end.
   *
   *  A CALLBACK and not a `console.log`, because `packages/control` writes to no stream: the verb
   *  decides and writes, the CLI prints, and a verb that printed would put a progress line in the
   *  middle of the web process's log the first time a route called it. */
  readonly onProgress?: (progress: ImportProgress) => void
```

and two new exports go beside `SkipReason`:

```ts
/** How many rows an import reports on, and how many ids a post-pass puts in one `IN` list
 *  (M55 R7). NOT a transaction boundary: the row loop is still ONE TRANSACTION PER ROW (M42 R2), and
 *  a batch is a unit of REPORTING and of bounded reads and nothing else. */
export const IMPORT_BATCH_SIZE = 100

/** Where an import has got to. `done` counts rows DECIDED, not rows written -- a skipped row is a
 *  row this import is finished with. */
export interface ImportProgress {
  readonly done: number
  readonly total: number
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  readonly skipped: number
}
```

`ImportReport` gains two fields, and `CatalogImportView` one:

```ts
  /** M55 R7: how many undismissed pairs of each class this import's rows are in, after its fourth
   *  post-pass ran. Rides inside the existing `report` Json column -- `CatalogImport` gains no
   *  counter column, because the row IS the record (M42 R5) and `RowOutcome[]` already lives there. */
  readonly duplicates: DuplicateCounts
  /** The duplicate pass hit `DUPLICATE_SCAN_MAX` and did not pair every row (R4). */
  readonly scanTruncated: boolean
```

```ts
  /** M55 R7: read back out of `report`, so `list-imports` and the web panel show the same seven
   *  numbers (plan erratum E9). Three zeroes for every import recorded before this milestone, which
   *  is true: nothing was looking. */
  readonly duplicates: DuplicateCounts
```

`importCatalog`'s body gains the refusal, the progress calls, the chunked post-passes and the counts:

```ts
export async function importCatalog(
  input: ImportCatalogInput,
  by?: string,
): Promise<Result<ImportReport, ControlRefusal>> {
  if (input.entries.length === 0) return err({ kind: 'catalog_empty', directory: input.directory })
  // M55 R8, in `catalog_empty`'s own position -- BEFORE `syncCapabilityTaxonomy` and before a single
  // row is read, so a refused import has touched nothing at all. Second rather than first because an
  // empty directory is the more basic fact about what the operator pointed at.
  //
  // `null` AND `undefined` both refuse: the CLI always passes what its walk found, so `undefined`
  // means a caller made no claim about a licence at all, and "nobody said" is exactly the state this
  // refusal is about. `allowUnknownLicense` is the one way past it.
  if ((input.license ?? null) === null && input.allowUnknownLicense !== true) {
    return err({ kind: 'license_unknown', directory: input.directory })
  }
  const roleMap = normaliseRoleMap(input.roleMap)
  if (!roleMap.ok) return roleMap

  await syncCapabilityTaxonomy()
  const taxonomy = await listCapabilities()

  const startedAt = new Date()
  const created: RowOutcome[] = []
  const updated: RowOutcome[] = []
  const unchanged: RowOutcome[] = []
  const skipped: SkippedRow[] = []

  for (const [index, entry] of input.entries.entries()) {
    const outcome = await importRow(entry, input, roleMap.value, startedAt, taxonomy)
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
    const done = index + 1
    // One line per batch, and one at the end however short the last batch is: an operator watching
    // three hundred files go past needs the FINAL number, and `done % 100` alone would never produce
    // it for a catalog of 296.
    if (done % IMPORT_BATCH_SIZE === 0 || done === input.entries.length) {
      input.onProgress?.({
        done,
        total: input.entries.length,
        created: created.length,
        updated: updated.length,
        unchanged: unchanged.length,
        skipped: skipped.length,
      })
    }
  }

  if (input.dryRun === true) {
    return ok({
      importId: null,
      dryRun: true,
      catalog: input.catalog,
      directory: input.directory,
      created,
      updated,
      unchanged,
      skipped,
      // A preview writes no pair, so it noticed none. Reporting the pairs it WOULD have written
      // would mean running the whole pass for a run that changes nothing, which is the one thing a
      // dry run promises not to cost.
      duplicates: emptyDuplicateCounts(),
      scanTruncated: false,
    })
  }

  const touched = [...created, ...updated, ...unchanged].flatMap((outcome) =>
    outcome.templateId === null ? [] : [outcome.templateId],
  )

  // The two existing post-passes, each chunked by the same number, so a
  // `findMany({ where: { id: { in } } })` never carries a three-hundred-element -- or
  // five-thousand-element -- `IN` list (M55 R7).
  for (const chunk of batched(touched)) await writeCollaborationHints(chunk, taxonomy)
  for (const chunk of batched(touched)) await writePersonaRunbooks(chunk, taxonomy)

  // The FOURTH post-pass (R7), here for `writeCollaborationHints`' own reason (M42 plan erratum
  // E11): a persona imported later in the same run is not in the table while an earlier row is being
  // written, so pairing before the loop ends would miss every pair inside the run. NOT chunked --
  // it forms pairs ACROSS the whole set, and chunking it would be chunking the question. Its own
  // three bounds are what keep it finite.
  const scan = await writeTemplateDuplicates(touched)

  const report = { created, updated, unchanged, skipped, duplicates: scan.counts, scanTruncated: scan.truncated }

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

/** An id list, in `IMPORT_BATCH_SIZE` pieces. One helper, so the post-passes chunk the same way and
 *  a fourth cannot forget to. */
function batched(ids: readonly string[]): readonly (readonly string[])[] {
  const out: string[][] = []
  for (let index = 0; index < ids.length; index += IMPORT_BATCH_SIZE) {
    out.push([...ids.slice(index, index + IMPORT_BATCH_SIZE)])
  }
  return out
}
```

`listCatalogImports` reads the counts back out of the Json column:

```ts
export async function listCatalogImports(limit = 10): Promise<readonly CatalogImportView[]> {
  const rows = await prisma.catalogImport.findMany({
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
      report: true,
    },
  })
  return rows.map((row) => ({
    id: row.id,
    catalog: row.catalog,
    directory: row.directory,
    by: row.by,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    created: row.created,
    updated: row.updated,
    unchanged: row.unchanged,
    skipped: row.skipped,
    // Validated at READ, the `profileSpecSchema` idiom: a column only ever written by this
    // repository is still a column a person can edit with `psql`, and a reader that trusted it would
    // print `3.5 exact` on an import panel.
    duplicates: parseDuplicateCounts((row.report as { duplicates?: unknown } | null)?.duplicates),
  }))
}
```

with `emptyDuplicateCounts`, `parseDuplicateCounts` and `type DuplicateCounts` added to the domain import, and `writeTemplateDuplicates` imported from `./duplicates.js`.

- [ ] **Step 8: Run the catalog file and watch it pass**

Run: `npx vitest run packages/control/test/integration/catalog.test.ts`
Expected: PASS — every existing case unchanged, plus the eleven new ones.

- [ ] **Step 9: The simulation boundary gains its sixth expect**

`packages/control/test/simulation-boundary.test.ts`, in the second `it`, after M54's block:

```ts
      // M55: the three nouns by NAME, the way the cases above name `@slave-of-ai/providers`, the
      // broker, the evidence table and the inbound delivery. A `SimulationRun` binds to a `Company`
      // and reads a role off a roster row's TEMPLATE relation (`simulation/read.ts:222`) -- never
      // through the catalog LIST -- so a simulated roster cannot be narrowed by activation and
      // cannot carry a duplicate pair. Stated as a scan rather than as a convention, because a
      // convention is what a future refactor does not read.
      expect(source, `${file} mentions catalog activation or a duplicate pair`).not.toMatch(
        /TemplateDuplicate|setTemplateActivation|recomputeTemplateDuplicates/,
      )
```

- [ ] **Step 10: Prove every refusal in this task is a RETURNED value**

A check rather than an edit, the shape M54 Task 2 Step 12 used. Both verbs this milestone adds open a `$transaction`, and a refusal after a write inside one COMMITS that write (ADR 0003, and `CatalogRowRefused`'s own docblock at `catalog.ts:94-107`):

```bash
grep -n "err({" packages/control/src/duplicates.ts packages/control/src/org.ts | grep -n "template_duplicate_not_found\|template_not_found"
```
Expected: one hit in `duplicates.ts` and one in `org.ts`, each on the line immediately after its `findUnique` and **before** its `update`. If either ever gains a refusal after its write, it must `throw` instead — which is what `CatalogRowRefused` exists for and what this grep is here to notice.

- [ ] **Step 11: Run the whole suite, then ladder and commit**

```bash
npx vitest run 2>&1 | tail -20
```
Expected: at or above Task 1's recorded baseline, zero failures. `apps/web/test/refusal-status.test.ts` moves from 22 to 23; nothing else should.

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

```bash
git add packages/control apps/web/test/refusal-status.test.ts
git commit -m "$(cat <<'EOF'
feat(control): m55 t3 — what two rows have in common, and an import that says what it noticed

Three classes, four bases, three bounds, and a pass that never deletes a template. Candidates come
from four inverted indexes rather than from N-squared comparisons: the content hash, the normalised
name, the sixteen MinHash bands and the capability keys -- because a pair can be exact with no
shingle in common and overlapping with no shingle in common by definition, and banding answers only
the near class. Each row takes at most two hundred partners, strongest source first, so a
two-thousand-member `backend.services` bucket cannot crowd out the one other row holding this row's
exact persona text.

`profileSpec` is the only large column the pass touches, and it is read a thousand rows at a time and
dropped between batches. A re-run writes nothing: a pair whose verdict has not changed is not written
at all, so `detectedAt` cannot move and a dismissal cannot be trodden on.

The importer gets a fourth post-pass, beside the hints and the runbooks and for their exact reason: a
persona imported later in the same run is not in the table while an earlier row is being written. It
writes and updates and never removes -- retiring a pair is `--recompute`'s act, and the residual is
stated rather than hidden: a pair that stops classifying and later classifies again comes back
undismissed.

An import now refuses a checkout whose licence it cannot name, in `catalog_empty`'s own position --
before the taxonomy sync and before a single row is read, so a refused import has touched nothing at
all. `--allow-unknown-license` is the one way past it. The row loop is still one transaction per row;
a batch is a unit of reporting and of bounded reads, and the post-passes chunk their id lists by the
same number so no `IN` list ever carries three hundred elements.

Two refusal kinds, in all three homes; the not-found list goes 22 to 23. No event: the catalog has no
workspace.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 4: Four verbs a person types, three flags a person passes, and the seven gates those two facts move (R7, R10, R12, E1, E3, E9, E10, D45–D56)

`apps/orchestrator`, plus the seven gate scripts the new default and the new flags move. After this task an operator can import a whole catalog, see what arrived, activate a row and dismiss a pair, entirely from a terminal — and every gate that imports a catalog is green again.

**Files:**
- Modify: `apps/orchestrator/src/cli.ts`, `apps/orchestrator/test/integration/cli.test.ts`, `scripts/gate-m42-catalog-import.mjs`, `scripts/gate-m46-workforce-catalog.mjs`, `scripts/gate-m47-team-formation.mjs`, `scripts/gate-m50-ephemeral.mjs`, `scripts/gate-m53-evidence.mjs`
- Test: `apps/orchestrator/test/integration/cli.test.ts`, then the five gates themselves

**Interfaces:**
- Consumes: `importCatalog`, `listCatalogImports`, `ImportProgress`, `ImportReport` (Tasks 2–3); `setTemplateActivation` (Task 2); `listTemplateDuplicates`, `recomputeTemplateDuplicates`, `setTemplateDuplicateDismissal` (Task 3); `listWorkforceCatalog` (Task 2); `DUPLICATE_CLASS_LABEL`, `DUPLICATE_BASIS_LABEL`, `DUPLICATE_CLASSES` (Task 1); `refusalText`, `flagText`, `requireFlag`, `operatorName`, `oneOfFlag` (all present in `cli.ts` at `:979,998,1010,1023`).
- Produces, for Tasks 5–6: `orchestrator template list|activate|deactivate|duplicates`, `import-catalog --activate --verbose --allow-unknown-license`, a `describeImport` that summarises by default, a `list-imports` that prints seven numbers.

- [ ] **Step 1: Write the failing CLI tests**

`apps/orchestrator/test/integration/cli.test.ts`, in a `describe` of its own. Written against the file's real helpers — `runCli(args): Promise<CliResult>` (`:45`, a CHILD PROCESS, so a refusal is a non-zero exit with the sentence on stderr) and `prisma` directly for the rows, because this file has no catalog fixture and does not need one.

```ts
describe('template and import-catalog (M55 R7, R10)', () => {
  // `SlaveTemplate` is in no other case's way in this file, and `TemplateDuplicate` cascades from
  // it (plan erratum E4), so one statement empties both.
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "CatalogImport", "SlaveTemplate" RESTART IDENTITY CASCADE')
  })

  const template = async (name: string, active: boolean): Promise<string> =>
    (
      await prisma.slaveTemplate.create({
        data: { name, role: 'backend', description: `${name} does one thing.`, active, capabilityKeys: ['backend.services'] },
      })
    ).id

  it('`template activate` turns a row on and says so in words', async (): Promise<void> => {
    const id = await template('M55 Inert Persona', false)

    const result = await runCli(['template', 'activate', '--template', id, '--by', 'gate'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('M55 Inert Persona is now active')
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.active).toBe(true)
    expect(row.activationChangedBy).toBe('gate')
  })

  it('`template activate` on a row that is already on says the no-op rather than claiming a change', async (): Promise<void> => {
    const id = await template('M55 Live Persona', true)

    const result = await runCli(['template', 'activate', '--template', id])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('was already active')
  })

  it('`template deactivate` puts it back', async (): Promise<void> => {
    const id = await template('M55 Live Persona', true)

    const result = await runCli(['template', 'deactivate', '--template', id])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('is now inactive')
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).active).toBe(false)
  })

  it('refuses a template id nobody wrote, with the control layer OWN sentence and a non-zero exit', async (): Promise<void> => {
    const result = await runCli(['template', 'activate', '--template', '00000000-0000-4000-8000-000000000000'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('no template with id 00000000-0000-4000-8000-000000000000')
  })

  it('`template list` prints one row per template, with the activation as a WORD and never as a boolean', async (): Promise<void> => {
    await template('M55 Live Persona', true)
    await template('M55 Inert Persona', false)

    const result = await runCli(['template', 'list'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('M55 Live Persona')
    expect(result.stdout).toContain('M55 Inert Persona')
    expect(result.stdout).toContain('active')
    expect(result.stdout).toContain('inactive')
    expect(result.stdout).not.toMatch(/\btrue\b|\bfalse\b/u)
  })

  it('`template list --active` and `--inactive` each narrow it, wherever the flag is written', async (): Promise<void> => {
    await template('M55 Live Persona', true)
    await template('M55 Inert Persona', false)

    const live = await runCli(['template', 'list', '--active'])
    expect(live.stdout).toContain('M55 Live Persona')
    expect(live.stdout).not.toContain('M55 Inert Persona')

    // `--inactive` BEFORE another flag, which is the whole of plan erratum E3: a bare flag that is
    // not in `VALUELESS` swallows whatever follows it.
    const inert = await runCli(['template', 'list', '--inactive', '--division', 'engineering'])
    expect(inert.stdout).not.toContain('M55 Live Persona')
  })

  it('`template duplicates` prints a pair with both NAMES and the class as a word', async (): Promise<void> => {
    const a = await template('M55 Alpha', false)
    const b = await template('M55 Beta', false)
    const [low, high] = a < b ? [a, b] : [b, a]
    await prisma.templateDuplicate.create({
      data: { aId: low, bId: high, class: 'exact', basis: 'content_hash', score: 1 },
    })

    const result = await runCli(['template', 'duplicates'])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('M55 Alpha')
    expect(result.stdout).toContain('M55 Beta')
    expect(result.stdout).toContain('Duplicate of')
    expect(result.stdout).toContain('same persona text')
    expect(result.stdout).not.toMatch(/\bcontent_hash\b/u)
  })

  it('`template duplicates --dismiss` stamps it, and `--restore` takes it back', async (): Promise<void> => {
    const a = await template('M55 Alpha', false)
    const b = await template('M55 Beta', false)
    const [low, high] = a < b ? [a, b] : [b, a]
    const pair = await prisma.templateDuplicate.create({
      data: { aId: low, bId: high, class: 'exact', basis: 'content_hash', score: 1 },
    })

    const dismissed = await runCli(['template', 'duplicates', '--dismiss', pair.id, '--by', 'gate'])
    expect(dismissed.code).toBe(0)
    expect((await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: pair.id } })).dismissedBy).toBe('gate')

    const restored = await runCli(['template', 'duplicates', '--restore', pair.id])
    expect(restored.code).toBe(0)
    expect((await prisma.templateDuplicate.findUniqueOrThrow({ where: { id: pair.id } })).dismissedAt).toBeNull()
  })

  it('refuses a pair id nobody wrote, with its own sentence', async (): Promise<void> => {
    const result = await runCli(['template', 'duplicates', '--dismiss', '00000000-0000-4000-8000-000000000000'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('no duplicate pair with id 00000000-0000-4000-8000-000000000000')
  })

  it('`template duplicates --recompute` says what it did, in numbers', async (): Promise<void> => {
    const result = await runCli(['template', 'duplicates', '--recompute'])

    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/recomputed: \d+ pair/u)
  })

  it('refuses a fifth subcommand rather than silently listing', async (): Promise<void> => {
    const result = await runCli(['template', 'merge'])

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('template takes list, activate, deactivate or duplicates')
  })
})
```

- [ ] **Step 2: Run them, watch them fail, and write the verbs**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts`
Expected: FAIL — `unknown command: template` on stderr for every case.

`apps/orchestrator/src/cli.ts`. First `VALUELESS` (`:676`), because every bare flag below depends on it (plan erratum E3):

```ts
/**
 * Flags that carry no value at all, so they may be written ANYWHERE in the command (M50 t3, widened
 * by M55 plan erratum E3).
 *
 * The parser below takes whatever follows a flag as its value, even another `--flag` -- which is why
 * every boolean this CLI had before M50 (`--yes`, `--dry-run`, `--prompt`, `--markdown`, `--clear`)
 * is documented as going LAST. That rule holds for ONE bare flag per command and no more, and M55
 * puts three on `import-catalog` and two on `template list`: `gate:m42-catalog-import`'s dry run
 * alone now ends in `--dry-run --allow-unknown-license`, where the first would eat the second.
 * Listing them here is the honest fix; the five older booleans keep their documented rule, because
 * moving a rule for a flag nobody is changing is a rename dressed as a fix.
 */
const VALUELESS: ReadonlySet<string> = new Set([
  'temporary',
  'activate',
  'verbose',
  'allow-unknown-license',
  'recompute',
  'active',
  'inactive',
])
```

`describeImport` (`:1267`) gains a second parameter and a duplicates line, and its per-row lines move behind it:

```ts
/**
 * The import report an operator reads (M42 section 2, rewritten by M55 R7).
 *
 * **Counts by default, lines only when asked.** A real catalog is three hundred files, and a
 * three-hundred-line wall is not a report -- it is the thing an operator scrolls past to find the
 * two rows that mattered. `--verbose` prints the per-row lines this used to print unconditionally.
 *
 * **The SKIPS still print every time.** A skip is a thing the operator has to act on, and a count of
 * four with no reasons is not actionable. They get a breakdown line AND their own detail lines,
 * because "2 name_taken" says how many and the lines say which.
 *
 * A drifting role is printed on its own line whatever the verbosity: the template keeps the role it
 * was created with, and an operator who expected --role-map to change it needs to be told it did
 * not.
 */
function describeImport(report: ImportReport, verbose: boolean): string {
  const lines: string[] = []
  if (report.dryRun) lines.push('DRY RUN: nothing was written.')
  const structured = [...report.created, ...report.updated, ...report.unchanged].filter(
    (row) => row.structured === true,
  ).length
  lines.push(
    `${report.catalog} (${report.directory}): created ${String(report.created.length)}, ` +
      `updated ${String(report.updated.length)}, unchanged ${String(report.unchanged.length)}, ` +
      `skipped ${String(report.skipped.length)}` +
      (structured > 0 ? `, structured ${String(structured)}` : ''),
  )
  // M55 R7: the three duplicate counts, always -- including three zeroes, which is a real answer
  // ("nothing looked alike") and is what makes the line's absence impossible to misread as one.
  lines.push(
    `  duplicates: ${String(report.duplicates.exact)} exact, ${String(report.duplicates.near)} near, ` +
      `${String(report.duplicates.overlapping)} overlapping` +
      (report.scanTruncated ? ' (the scan was truncated: not every row was paired)' : ''),
  )
  if (report.skipped.length > 0) {
    const byReason = new Map<string, number>()
    for (const row of report.skipped) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1)
    lines.push(
      `  skipped: ${[...byReason.entries()].map(([reason, count]) => `${String(count)} ${reason}`).join(', ')}`,
    )
  }
  if (verbose) {
    for (const row of report.created) lines.push(`  created  ${row.name}  [${row.role}]  ${row.sourceId}`)
    for (const row of report.updated) {
      const kept =
        row.overridesKept !== undefined && row.overridesKept > 0
          ? `  (overrides kept ${String(row.overridesKept)})`
          : ''
      lines.push(`  updated  ${row.name}  [${row.role}]  ${row.sourceId}${kept}`)
    }
  }
  for (const row of report.skipped) lines.push(`  skipped  ${row.reason}  ${row.name ?? row.sourceId}: ${row.detail}`)
  for (const row of [...report.created, ...report.updated, ...report.unchanged]) {
    if (row.roleDrift === undefined) continue
    lines.push(
      `  role     ${row.name} stays "${row.roleDrift.stored}" (the map said "${row.roleDrift.mapped}"): ` +
        "a template's role is set when it is created -- delete it and import it again to change one",
    )
  }
  if (report.importId !== null) lines.push(`recorded as import ${report.importId}`)
  return `${lines.join('\n')}\n`
}
```

`import-catalog`'s `case` (`:1723`) gains three flags and the progress printer. The `dryRun` line already reads `'dry-run' in flags`, which is the idiom all three new ones use:

```ts
      const dryRun = 'dry-run' in flags
      // M55 R10. `'flag' in flags`, not `!== undefined`: a bare flag's recorded value IS `undefined`
      // (`parseArgs`), so a `!==` test would read every one of these as absent.
      const activate = 'activate' in flags
      const verbose = 'verbose' in flags
      const allowUnknownLicense = 'allow-unknown-license' in flags
```

and the call and its printing:

```ts
      const result = await importCatalog(
        {
          catalog: walk.catalog,
          directory: resolve(dir),
          entries: walk.entries,
          revision: walk.revision,
          license: walk.license,
          ...(Object.keys(roleMap).length > 0 ? { roleMap } : {}),
          ...(dryRun ? { dryRun: true } : {}),
          ...(activate ? { activate: true } : {}),
          ...(allowUnknownLicense ? { allowUnknownLicense: true } : {}),
          // M55 R7: one line per batch of a hundred rows and one at the end. The VERB reports and
          // this prints -- `packages/control` writes to no stream, so a progress line is a callback
          // rather than a `console.log` buried in a control module.
          onProgress: (progress) => {
            process.stdout.write(
              `  … ${String(progress.done)}/${String(progress.total)} rows — ` +
                `created ${String(progress.created)}, updated ${String(progress.updated)}, ` +
                `unchanged ${String(progress.unchanged)}, skipped ${String(progress.skipped)}\n`,
            )
          },
        },
        operatorName(flags),
      )
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(describeImport(result.value, verbose))
      return 0
```

`list-imports`' row line gains the three counts (plan erratum E9 — seven numbers, not six):

```ts
      for (const row of rows) {
        process.stdout.write(
          `${row.finishedAt.toISOString()}  ${row.catalog}  by ${row.by ?? 'nobody named'}  ` +
            `created ${String(row.created)}, updated ${String(row.updated)}, unchanged ${String(row.unchanged)}, ` +
            `skipped ${String(row.skipped)}  ` +
            `duplicates ${String(row.duplicates.exact)}/${String(row.duplicates.near)}/${String(row.duplicates.overlapping)}  ` +
            `(${row.directory})\n`,
        )
      }
```

and the header sentence above that loop says what the three numbers are, once, so the slashes are readable:

```ts
      process.stdout.write('when  catalog  by  outcomes  duplicates exact/near/overlapping  directory\n')
```

The new `template` command goes beside `capabilities` (`:2084`), in the `const sub = argv[1] ?? 'list'` shape those six already use:

```ts
    case 'template': {
      // `template list | activate | deactivate | duplicates` -- the `capabilities`/`runbooks`/
      // `memories` shape in this file (the sub-verb is a POSITIONAL read off raw argv, because
      // `parseArgs` collects only flags), for its own reason: four sibling top-level verbs for one
      // table would read as four unrelated features.
      //
      // It is NOT called `templates`: `create-template`, `set-profile --template` and
      // `show-profile --template` already spell the noun singular, and two spellings of one noun in
      // one CLI is one more thing an operator has to remember.
      const sub = argv[1] ?? 'list'

      if (sub === 'list') {
        const activeFlag = 'active' in flags
        const inactiveFlag = 'inactive' in flags
        if (activeFlag && inactiveFlag) throw new Error('--active and --inactive are opposites: pass one or neither')
        const duplicates = oneOfFlag<DuplicateFacet>(flags, 'duplicates', [...DUPLICATE_FACETS])
        const page = await listWorkforceCatalog(
          {
            ...(flagText(flags, 'division') === undefined ? {} : { division: requireFlag(flags, 'division') }),
            ...(activeFlag ? { active: true } : {}),
            ...(inactiveFlag ? { active: false } : {}),
            ...(duplicates === undefined ? {} : { duplicates }),
          },
          { pageSize: TEMPLATE_PICKER_MAX },
        )
        // The COUNT first, because `template list` on a full catalog prints hundreds of lines and an
        // operator piping it into `head` should still learn how many there were.
        process.stdout.write(
          `${String(page.rows.length)} of ${String(page.total)} template(s)\n`,
        )
        for (const row of page.rows) {
          // Tab-separated, the shape every other list verb here uses. Five columns an operator can
          // cut, and the two that name a vocabulary print WORDS (`docs/ia.md` rule 3): `active` /
          // `inactive` for a boolean nobody should read as `true`, and the class label for a pair.
          const signal =
            row.duplicate === null
              ? '-'
              : `${DUPLICATE_CLASS_LABEL[row.duplicate.class]} ${row.duplicate.otherName}` +
                (row.duplicateCount > 1 ? ` (+${String(row.duplicateCount - 1)})` : '')
          process.stdout.write(
            `${row.id}\t${row.name}\t${row.sourceDivision ?? row.role}\t${row.active ? 'active' : 'inactive'}\t${signal}\n`,
          )
        }
        return 0
      }

      if (sub === 'activate' || sub === 'deactivate') {
        const templateId = requireFlag(flags, 'template')
        const active = sub === 'activate'
        const result = await setTemplateActivation(templateId, active, operatorName(flags))
        if (!result.ok) throw new Error(refusalText(result.error))
        // The NAME, read back after the write, because an operator types an id and reads a name --
        // and because "it worked" without saying what worked is the sentence somebody runs twice.
        const row = await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { name: true } })
        const name = row?.name ?? templateId
        process.stdout.write(
          result.value.changed
            ? `${name} is now ${active ? 'active' : 'inactive'}\n`
            : `${name} was already ${active ? 'active' : 'inactive'}\n`,
        )
        return 0
      }

      if (sub === 'duplicates') {
        // `--recompute` FIRST, so `template duplicates --recompute` prints what the pass did and
        // then the pairs it left behind -- one command, one picture.
        if ('recompute' in flags) {
          const scan = await recomputeTemplateDuplicates()
          const total = scan.counts.exact + scan.counts.near + scan.counts.overlapping
          process.stdout.write(
            `recomputed: ${String(total)} pair(s) -- ${String(scan.counts.exact)} exact, ` +
              `${String(scan.counts.near)} near, ${String(scan.counts.overlapping)} overlapping; ` +
              `${String(scan.created)} new, ${String(scan.updated)} re-classified, ${String(scan.removed)} retired, ` +
              `${String(scan.backfilled)} row(s) backfilled` +
              (scan.truncated ? ' (the scan was truncated: not every row was paired)' : '') +
              '\n',
          )
        }
        const dismiss = flagText(flags, 'dismiss')
        const restore = flagText(flags, 'restore')
        if (dismiss !== undefined && restore !== undefined) {
          throw new Error('--dismiss and --restore are opposites: pass one or neither')
        }
        if (dismiss !== undefined || restore !== undefined) {
          const pairId = dismiss ?? (restore as string)
          const result = await setTemplateDuplicateDismissal(pairId, dismiss !== undefined, operatorName(flags))
          if (!result.ok) throw new Error(refusalText(result.error))
          process.stdout.write(
            result.value.changed
              ? `${pairId} is now ${dismiss !== undefined ? 'dismissed' : 'showing again'}\n`
              : `${pairId} was already ${dismiss !== undefined ? 'dismissed' : 'showing'}\n`,
          )
          return 0
        }
        const klass = oneOfFlag<DuplicateClass>(flags, 'class', [...DUPLICATE_CLASSES])
        const rows = await listTemplateDuplicates({
          ...(flagText(flags, 'template') === undefined ? {} : { templateId: requireFlag(flags, 'template') }),
          ...(klass === undefined ? {} : { class: klass }),
          ...('dismissed' in flags ? { includeDismissed: true } : {}),
        })
        if (rows.length === 0) {
          process.stdout.write('no duplicate pair has been detected\n')
          return 0
        }
        for (const row of rows) {
          // Labels, never keys: the class and the basis both come from the domain's own tables, and
          // the raw members appear nowhere in this line. The SCORE is printed to three decimals,
          // which is exactly what was stored.
          process.stdout.write(
            `${row.id}\t${DUPLICATE_CLASS_LABEL[row.class]}\t${row.aName} / ${row.bName}\t` +
              `${row.score.toFixed(3)}\t${DUPLICATE_BASIS_LABEL[row.basis]}\t` +
              `${row.detectedAt.toISOString().slice(0, 10)}` +
              (row.dismissedAt === null ? '' : `\tdismissed by ${row.dismissedBy ?? 'nobody named'}`) +
              '\n',
          )
        }
        return 0
      }

      throw new Error('template takes list, activate, deactivate or duplicates')
    }
```

with `DUPLICATE_BASIS_LABEL`, `DUPLICATE_CLASSES`, `DUPLICATE_CLASS_LABEL`, `DUPLICATE_FACETS`, `type DuplicateClass` and `type DuplicateFacet` added to the file's `@slave-of-ai/domain` import, and `TEMPLATE_PICKER_MAX`, `listTemplateDuplicates`, `listWorkforceCatalog`, `recomputeTemplateDuplicates`, `setTemplateActivation` and `setTemplateDuplicateDismissal` added to its `@slave-of-ai/control` import.

- [ ] **Step 3: Write the usage text**

`apps/orchestrator/src/cli.ts`, `USAGE` (`:190`). The `import-catalog` entry (`:283-296`) gains its three flags — written LAST in the line even though `VALUELESS` now makes their position free, because the usage line is also how an operator learns the house rule:

```
  import-catalog --dir <path> [--catalog <n>] [--division <d>[,<d>]]
                 [--role-map <division>=<role>,...] [--by <name>]
                 [--dry-run] [--activate] [--verbose] [--allow-unknown-license]
                                       import a directory of persona files into the template
                                       catalog. Re-runnable: an unchanged file is left alone, a
                                       changed one updates the template it created, and a profile a
                                       person has edited since is never overwritten. --catalog
                                       defaults to the directory's own name; --role-map translates a
                                       division into the role the template is created with, and only
                                       matters the first time a persona is imported. A name this
                                       catalog does not have -- in --division or in --role-map --
                                       gets a WARNING on stderr, not a refusal: every division that
                                       does exist is still imported. --dry-run decides everything
                                       and writes nothing. NOTHING IMPORTED IS HIRABLE until
                                       somebody says so: every row arrives inactive, and --activate
                                       is that somebody saying so for this run. --verbose prints one
                                       line per row instead of the counts. --allow-unknown-license
                                       imports a checkout with no LICENSE file at its root, which is
                                       otherwise refused, because nothing could record where those
                                       personas came from.
  list-imports [--limit <n>]           the last catalog imports, newest first by the timestamp the
                                       line shows, with their four outcome counts and the three
                                       duplicate counts that import noticed. --limit defaults to 10
                                       and must be a positive integer
```

and a `template` entry goes immediately after the `capabilities` block:

```
  template list [--division <d>] [--active | --inactive] [--duplicates <exact|near|overlapping|none>]
                                       every template, with whether it is hirable and the strongest
                                       duplicate signal beside it. Nothing an import created is
                                       hirable until `template activate` says so.
  template activate --template <id>    make one template a hiring candidate: the Supervisor may
  template deactivate --template <id>  propose it, and stops proposing it again. A worker already
                                       hired from it keeps working either way, and `add-slave
                                       --template` works on an inactive row -- naming a specific row
                                       by hand is the same deliberate act as activating it.
  template duplicates [--template <id>] [--class <exact|near|overlapping>] [--dismissed]
                      [--recompute] [--dismiss <pairId>] [--restore <pairId>]
                                       which catalog rows look like which. --recompute re-classifies
                                       the WHOLE table and is also the backfill for a catalog
                                       imported before this feature existed; it may retire a pair
                                       that no longer looks alike. --dismiss says "I know" about one
                                       pair and keeps the row; --restore takes that back. Nothing
                                       here ever deletes a template: that is `delete-template`, and
                                       it asks twice.
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts`
Expected: PASS — the twelve new cases, every existing one unchanged.

- [ ] **Step 5: The five gates that import a catalog, one by one (R12, errata E1 and E10)**

No behaviour is invented here; each edit is named, and each is the smallest thing that makes an existing assertion true again.

**`scripts/gate-m42-catalog-import.mjs` — R12 (a) to (e).**

(a) Every `import-catalog` invocation gains `--allow-unknown-license`, because `scripts/fixtures/catalog-m42/` is the ONE fixture catalog with no `LICENSE` file (verified: the other four have one) and R8 now refuses it. Kept as an absence rather than fixed, so the roster covers both states. Four call sites: `:380`, `:478`, `:517` and the dry run at `:574-580`.

```js
  const firstOutput = runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate', '--allow-unknown-license'])
```

```js
  // `--dry-run` and `--allow-unknown-license` are both BARE, and both may now sit anywhere: M55 plan
  // erratum E3 put every bare flag this milestone adds into the parser's `VALUELESS` set, because
  // the old "write it LAST" rule holds for one such flag and this line has two.
  const dryOutput = runCli([
    'import-catalog',
    '--dir',
    catalogDir,
    '--role-map',
    'engineering=backend,testing=reviewer',
    '--dry-run',
    '--allow-unknown-license',
  ])
```

(b) `snapshotOf` (`:137-151`) gains `active`, since its own comment calls it "everything an import is allowed to move on a template" and the hand-made collision row must be proved still `true` after the import:

```js
/** The fields stage 2 and stage 4 compare -- everything an import is allowed to move on a template.
 *  `active` is here since M55 R2: an import writes it on a row it CREATES and never on a row it
 *  updates, so a snapshot that omitted it could not tell those two rules apart. */
const snapshotOf = (template) =>
  JSON.stringify({
    id: template.id,
    name: template.name,
    role: template.role,
    description: template.description,
    profile: template.profile,
    profileSha256: template.profileSha256,
    sourceId: template.sourceId,
    sourceSha256: template.sourceSha256,
    sourceDivision: template.sourceDivision,
    importedAt: template.importedAt,
    defaultModel: template.defaultModel,
    provider: template.provider,
    active: template.active,
  })
```

(c) Stage 1's per-row loop asserts the new default out loud, beside the two `null`s it already asserts (`:400-404`):

```js
    if (row.defaultModel !== null) await fail(`${expected.sourceId} was given a model (${JSON.stringify(row.defaultModel)}); an import never chooses one (R3)`)
    if (row.provider !== null) await fail(`${expected.sourceId} was given a provider (${JSON.stringify(row.provider)}); an import never chooses one (R3)`)
    // M55 R2: an import produces a library, not a workforce. Asserted where the other two
    // "an import never decides this" defaults already are.
    if (row.active !== false) await fail(`${expected.sourceId} arrived ACTIVE; nothing an import creates is hirable until somebody says so (M55 R2)`)
```

(d) Stage 5 is deliberately NOT given an activation step, and a comment says so at the top of that stage. It builds a company from the two imported templates through the real CLI and dispatches a task, which is exactly the manual path R2 keeps open on an inactive row — so leaving it alone turns an unchanged stage into a proof:

```js
  // ================= Stage 5: a company built from the imported templates =========================
  //
  // NO `template activate` ANYWHERE IN THIS STAGE, deliberately (M55 R2). Both templates are
  // `active: false` -- stage 1 asserted it -- and this stage still builds a company from them,
  // materialises a worker and dispatches a real run. That is the whole of "activation gates the
  // SUPERVISOR and nothing else": an operator naming a specific row by hand is the same deliberate
  // act as activating it, and a stage that needed a new step to keep passing would have been the
  // proof that this ruling was wrong.
```

(e) `deleteGateTemplates` (`:178`) needs no new statement, because `TemplateDuplicate` cascades from `SlaveTemplate` — but `dumpGateRows` (`:202`) gains the pairs, so a failure says what was detected:

```js
  const duplicates = await prisma.templateDuplicate
    .findMany({ where: { OR: [{ a: { sourceId: { startsWith: `${CATALOG_NAME}/` } } }, { b: { sourceId: { startsWith: `${CATALOG_NAME}/` } } }] } })
    .catch(() => [])
```

and `duplicates` joins the object the function stringifies.

**`scripts/gate-m46-workforce-catalog.mjs` — erratum E1, one constant and one step.**

`:121` and stage 2b (`:726-737`). The capability facet now offers taxonomy KEYS, and not one of `catalog-m46`'s four personas resolves a single key, so `selectOption('Design the module boundary')` would wait for an option that is not there. The stage's claim — a facet the read model computed, narrowing to one row, with the count sentence read back — moves to the facet this fixture DOES populate:

```js
/** M55 plan erratum E1: stage 2b used to select a free-text capability bullet. The capability facet
 *  is taxonomy KEYS since M55 R3, and none of this fixture's four personas resolves one -- their
 *  bullets are prose, and `normaliseCapabilities` matches whole normalised strings. The SKILL facet
 *  is the one this fixture populates: `gate-core-builder.md`'s front matter is the only `skills:`
 *  key in `scripts/fixtures/`. The capability filter's own coverage is `gate:m55-catalog` stage 9,
 *  which asserts that its options are labels and its values are keys. */
const CORE_BUILDER_SKILL = 'writing-plans'
```

```js
  // 2b. the skill filter, off the facets the read model computed (erratum E1).
  await page.getByTestId('catalog-search').fill('')
  await waitUntil(async () => ((await rowIds()).length === baselineTotal + 4 ? true : `${String((await rowIds()).length)} rows`), 'the cleared search to put every row back')
  await page.getByTestId('catalog-skill-select').selectOption(CORE_BUILDER_SKILL)
  await waitUntil(
    async () => {
      const ids = await rowIds()
      const text = await countText()
      return ids.length === 1 && ids[0] === coreId && text === '1 template' ? true : `rows ${JSON.stringify(ids)}, count ${JSON.stringify(text)}`
    },
    'the skill filter to leave the core builder alone',
  )
  console.log(`stage 2b -- the skill ${JSON.stringify(CORE_BUILDER_SKILL)} leaves ${await countText()}`)
```

`CORE_BUILDER_CAPABILITY` stays where it is and keeps its OTHER call site (`:501`, stage 1's assertion that the row's free-text capabilities include it) — nothing is removed, only moved.

**`scripts/gate-m47-team-formation.mjs`** — `:560`. This gate drives the Supervisor to `hire_from_catalog` twice, and would otherwise measure an empty candidate list:

```js
  // M55 R2: `--activate`, because this gate's whole subject is the Supervisor CHOOSING one of these
  // personas, and nothing an import creates is a candidate until somebody says so.
  const importOutput = runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate', '--activate'])
```

**`scripts/gate-m50-ephemeral.mjs`** — `:543`, the same edit for the same reason (four `hire_from_catalog` occurrences):

```js
  console.log(`stage 1 -- import-catalog printed:\n${runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate', '--activate'])}`)
```

**`scripts/gate-m53-evidence.mjs`** — erratum E10, `:640-648`. Its five templates are written straight through Prisma, and two of them carry `capabilityKeys`, which is what put them in `loadCatalogEntries` before this milestone:

```js
    const row = await prisma.slaveTemplate.create({
      data: {
        name: `${TEMPLATE_PREFIX} ${suffix} ${STAMP}`,
        role: WORK_ROLE,
        description: 'Seeded by gate:m53-evidence.',
        defaultModel: PIPELINE_MODEL,
        capabilityKeys: [...capabilities],
        // M55 plan erratum E10: these stand in for catalog personas somebody already chose, and two
        // of them carry capability keys -- which is exactly what made them Supervisor candidates
        // before M55 R2 put `active` in front of that door. Written true so this gate measures the
        // same world it measured before.
        active: true,
      },
    })
```

**`scripts/gate-m48-runbooks.mjs` is NOT touched**, and that is an assertion rather than an omission: `scripts/fixtures/catalog-m48/LICENSE` exists, so R8's refusal never fires on it, and nothing in that gate hires from the catalog (`grep -c hire_from_catalog scripts/gate-m48-runbooks.mjs` → 0). Task 6 runs it unchanged, which is the proof.

- [ ] **Step 6: Ladder and commit**

The gates themselves are run in Task 6, all together, after the web surfaces land — running them here would mean running each of them twice.

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
npx vitest run 2>&1 | tail -20
```
Expected: at or above Task 1's recorded baseline, zero failures.

```bash
git add apps/orchestrator scripts
git commit -m "$(cat <<'EOF'
feat(cli): m55 t4 — import a whole catalog, see what arrived, and say which of it may be hired

`import-catalog` gains three bare flags and a progress line per hundred rows, and its report becomes
a report: four outcome counts, three duplicate counts, and the skips broken down by reason -- because
a skip is a thing the operator has to act on and a count of four with no reasons is not actionable.
The per-row lines move behind `--verbose`, where a three-hundred-file catalog needs them to be.

`template list | activate | deactivate | duplicates` is one command with four subcommands, the shape
`capabilities`, `runbooks`, `memories`, `permissions`, `credential`, `broker` and `staffing` already
use. It prints words and never keys: `active` and `inactive` for a boolean nobody should read as
`true`, `Duplicate of` and `same persona text` for two enums nobody should read at all.

Every bare flag this milestone adds joins the parser's `VALUELESS` set, because "write it last" holds
for one such flag and the m42 gate's dry run now carries two.

Seven gates move. m42 passes `--allow-unknown-license` on every import -- it is the one fixture
catalog with no LICENSE, kept as an absence so the roster covers both states -- snapshots `active`,
and asserts out loud that nothing an import creates is hirable; its stage 5 is deliberately given no
activation step, which turns an unchanged stage into the proof that a manual hire still works on an
inactive row. m47 and m50 pass `--activate`, because their whole subject is the Supervisor choosing a
persona. m53's five hand-written templates are written active, because that is the world it measured
before. m46's stage 2b moves from the capability facet to the skill facet, because the capability
facet is taxonomy keys now and not one of its four personas resolves one. m48 is untouched, and that
is an assertion.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 5: A catalog page you can work in when it holds hundreds of rows (R3, R6, R9, D57–D70)

`apps/web`. Seven filters in the URL, a page you can extend, a toggle per row, a chip per row and a group in the drawer. This is the only task in the milestone that a person sees.

**Files:**
- Create: `apps/web/src/app/api/org/templates/[templateId]/activation/route.ts`, `apps/web/src/app/api/org/templates/[templateId]/duplicates/route.ts`, `apps/web/src/app/api/org/duplicates/[pairId]/dismissal/route.ts`, `apps/web/test/catalog-duplicates.test.tsx`
- Modify: `apps/web/src/lib/catalogFilters.ts`, `apps/web/src/hooks/useCatalogFilters.ts`, `apps/web/src/server/org.ts`, `apps/web/src/app/api/org/catalog/route.ts`, `apps/web/src/components/ui/DetailsGroup.tsx`, `apps/web/src/components/workforce/WorkforceCatalog.tsx`, `apps/web/src/components/workforce/CatalogFilterBar.tsx`, `apps/web/src/components/workforce/ProfileDrawer.tsx`, `apps/web/src/components/CatalogImports.tsx`, `docs/ia.md`
- Test: `apps/web/test/catalog-filters.test.ts`, `apps/web/test/workforce-catalog.test.tsx`, the new `apps/web/test/catalog-duplicates.test.tsx`

**Interfaces:**
- Consumes: `WorkforceCatalogView` with `total`/`nextCursor` and `CatalogRowView` with `active`/`duplicate`/`duplicateCount` (Task 2); `setTemplateActivation` (Task 2); `listTemplateDuplicates`, `setTemplateDuplicateDismissal` (Task 3); `DUPLICATE_CLASS_LABEL`, `DUPLICATE_BASIS_LABEL`, `DUPLICATE_FACETS`, `DUPLICATE_FACET_LABEL`, `DuplicateFacet` (Task 1); `capabilityLabel` (`packages/domain/src/capability/taxonomy.ts:127` — verified present); `plural` (`apps/web/src/lib/plural.ts:14`); `sendControl` (`apps/web/src/lib/postControl.ts:35`); `orgControlResponse` (`apps/web/src/server/orgControlRoute.ts:10`); `requirePrincipal` (`apps/web/src/server/principal.ts`).
- Produces, for Task 6: `catalog-count`'s two sentences, `catalog-more`, `catalog-activate-<id>`, `catalog-duplicate-<id>`, `catalog-duplicates-select`, `catalog-active-chip-active`/`-inactive`, the drawer's `duplicates` group and its `profile-duplicate-<pairId>` rows, and the three routes.

- [ ] **Step 1: Write the failing test for the seven URL params**

`apps/web/test/catalog-filters.test.ts`. The first case's name and body move from five dimensions to seven, and four cases join it:

```ts
import { describe, expect, it } from 'vitest'
import {
  CATALOG_ACTIVATIONS,
  CATALOG_SEARCH_DEBOUNCE_MS,
  CATALOG_SOURCES,
  catalogFilterParams,
  parseCatalogFilters,
} from '../src/lib/catalogFilters.js'

describe('parseCatalogFilters', () => {
  it('reads the seven dimensions the catalog filters on', () => {
    const params = new URLSearchParams(
      'q=builder&division=engineering&capability=backend.api-design&source=imported&skill=writing-plans&active=active&duplicates=exact',
    )
    expect(parseCatalogFilters(params)).toEqual({
      q: 'builder',
      division: 'engineering',
      capability: 'backend.api-design',
      source: 'imported',
      skill: 'writing-plans',
      active: true,
      duplicates: 'exact',
    })
  })

  it('reads `inactive` as the other half of the same boolean', () => {
    expect(parseCatalogFilters(new URLSearchParams('active=inactive'))).toEqual({ active: false })
  })

  it('drops an activation word outside its vocabulary rather than refusing the link', () => {
    expect(parseCatalogFilters(new URLSearchParams('active=maybe&q=builder'))).toEqual({ q: 'builder' })
  })

  it('drops a duplicates facet outside its vocabulary, and keeps `none`, which IS one', () => {
    expect(parseCatalogFilters(new URLSearchParams('duplicates=sideways'))).toEqual({})
    expect(parseCatalogFilters(new URLSearchParams('duplicates=none'))).toEqual({ duplicates: 'none' })
  })

  it('offers exactly the two activations a template row can have', () => {
    expect(CATALOG_ACTIVATIONS).toEqual(['active', 'inactive'])
  })

  it('spells the search debounce once, where the filter bar reads it', () => {
    expect(CATALOG_SEARCH_DEBOUNCE_MS).toBe(250)
  })

  it('round-trips all seven, including the boolean, through catalogFilterParams', () => {
    const filters = {
      q: 'builder',
      division: 'engineering',
      capability: 'backend.api-design',
      source: 'imported' as const,
      skill: 'writing-plans',
      active: false,
      duplicates: 'none' as const,
    }
    expect(parseCatalogFilters(catalogFilterParams(filters))).toEqual(filters)
  })
})
```

Every existing case in the file stays exactly as it is.

- [ ] **Step 2: Run it, watch it fail, and write the URL vocabulary**

Run: `npx vitest run apps/web/test/catalog-filters.test.ts`
Expected: FAIL — `CATALOG_ACTIVATIONS` and `CATALOG_SEARCH_DEBOUNCE_MS` do not exist, and the seven-dimension case reads five.

`apps/web/src/lib/catalogFilters.ts`:

```ts
import { DUPLICATE_FACETS, type DuplicateFacet } from '@slave-of-ai/domain'
import type { WorkforceCatalogFilters } from '@slave-of-ai/control'

/**
 * The Workforce Catalog's URL vocabulary (M46 R6, widened to seven by M55 R3) -- parsed the same way
 * by the route and by the client hook, the `activityFilters.ts` precedent. Pure: no prisma, no
 * React.
 *
 * LENIENT, unlike the activity timeline's `?types=`. A stale or hand-edited link is a link somebody
 * shared before a capability was renamed; dropping the token it no longer knows renders a page with
 * one fewer filter, and refusing the whole request renders an error where a catalog belongs. Three
 * of the seven have a closed vocabulary to check -- `source`, `active` and `duplicates` -- and an
 * unknown value in any of them is DROPPED, never refused.
 */
export const CATALOG_SOURCES = ['imported', 'local'] as const

export type CatalogSource = (typeof CATALOG_SOURCES)[number]

/**
 * The two WORDS the `active` param carries (M55 R3).
 *
 * The filter is a boolean in `WorkforceCatalogFilters`, and the URL is two words rather than
 * `true`/`false` for `docs/ia.md` rule 3's reason: a shared link is something a person reads, and
 * `?active=true` says less than `?active=active`. It is also what lets "absent" mean "either",
 * which is a third state neither word occupies.
 */
export const CATALOG_ACTIVATIONS = ['active', 'inactive'] as const

export type CatalogActivation = (typeof CATALOG_ACTIVATIONS)[number]

/** ONE vocabulary (`CatalogFilterBar`'s own rule): the chip says exactly the word the catalog ROW
 *  says for the same fact. `data-active` still carries the boolean for a gate to read. */
export const ACTIVATION_LABEL: Record<CatalogActivation, string> = {
  active: 'active',
  inactive: 'inactive',
}

/**
 * How long the search box waits before it asks (M53 section 6's carried "`q` undebounced", taken
 * here).
 *
 * It was cosmetic while the read model filtered an array in memory. Since M55 R3 every keystroke is
 * a `contains` over `searchText` across the whole table plus a `count` over the same `where`, and a
 * person typing "release steward" at a normal speed would fire fifteen of those. 250 ms is under the
 * threshold at which a person perceives a pause and over the interval between two keystrokes.
 */
export const CATALOG_SEARCH_DEBOUNCE_MS = 250

function text(params: URLSearchParams, key: string): string | undefined {
  const raw = (params.get(key) ?? '').trim()
  return raw === '' ? undefined : raw
}

export function parseCatalogFilters(params: URLSearchParams): WorkforceCatalogFilters {
  const q = text(params, 'q')
  const division = text(params, 'division')
  const capability = text(params, 'capability')
  const source = text(params, 'source')
  const skill = text(params, 'skill')
  const active = text(params, 'active')
  const duplicates = text(params, 'duplicates')
  return {
    ...(q !== undefined ? { q } : {}),
    ...(division !== undefined ? { division } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(source !== undefined && (CATALOG_SOURCES as readonly string[]).includes(source)
      ? { source: source as CatalogSource }
      : {}),
    ...(skill !== undefined ? { skill } : {}),
    ...(active !== undefined && (CATALOG_ACTIVATIONS as readonly string[]).includes(active)
      ? { active: active === 'active' }
      : {}),
    ...(duplicates !== undefined && (DUPLICATE_FACETS as readonly string[]).includes(duplicates)
      ? { duplicates: duplicates as DuplicateFacet }
      : {}),
  }
}

/** The inverse, for the client that writes the filter bar's state back into the address bar
 *  (`filtersToQuery`'s idiom): only the dimensions that are set are written, so an empty filter is an
 *  empty query string rather than seven empty params. */
export function catalogFilterParams(filters: WorkforceCatalogFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.q !== undefined) params.set('q', filters.q)
  if (filters.division !== undefined) params.set('division', filters.division)
  if (filters.capability !== undefined) params.set('capability', filters.capability)
  if (filters.source !== undefined) params.set('source', filters.source)
  if (filters.skill !== undefined) params.set('skill', filters.skill)
  if (filters.active !== undefined) params.set('active', filters.active ? 'active' : 'inactive')
  if (filters.duplicates !== undefined) params.set('duplicates', filters.duplicates)
  return params
}
```

`apps/web/src/hooks/useCatalogFilters.ts`, one line (`:10`):

```ts
/** The seven params this hook owns in the address bar, and the only ones it clears before writing
 *  its own back -- a `?tab=catalog` or a `?from=nav` that arrived on the link survives. */
const FILTER_PARAMS = ['q', 'division', 'capability', 'source', 'skill', 'active', 'duplicates'] as const
```

Run: `npx vitest run apps/web/test/catalog-filters.test.ts`
Expected: PASS — 12 cases.

- [ ] **Step 3: The three routes and the one read they need**

`apps/web/src/server/org.ts` gains one read beside `readTemplateProfileView`:

```ts
/** One pair as a `'use client'` component receives it: `TemplateDuplicateView` with its three
 *  `Date`s turned into ISO strings, `CatalogRowView`'s own idiom. */
export type TemplateDuplicateRowView = Omit<TemplateDuplicateView, 'detectedAt' | 'dismissedAt'> & {
  readonly detectedAt: string
  readonly dismissedAt: string | null
}

/** Every pair one template is in, DISMISSED ONES INCLUDED (M55 R6): the drawer is the one surface
 *  that shows a dismissal, greyed, with a Restore beside it -- the chip on the row shows only the
 *  undismissed ones, which is why the two reads are different and not one. */
export async function listTemplateDuplicatesView(templateId: string): Promise<readonly TemplateDuplicateRowView[]> {
  const rows = await listTemplateDuplicates({ templateId, includeDismissed: true })
  return rows.map((row) => ({
    ...row,
    detectedAt: row.detectedAt.toISOString(),
    dismissedAt: row.dismissedAt === null ? null : row.dismissedAt.toISOString(),
  }))
}
```

`apps/web/src/app/api/org/catalog/route.ts` reads the cursor:

```ts
import { parseCatalogFilters } from '../../../../lib/catalogFilters'
import { listWorkforceCatalogPage } from '../../../../server/org'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Workforce Catalog, filtered and PAGED (M46 R6, M55 R3). A GET with the seven params
 *  `catalogFilters.ts` parses, plus an opaque `?cursor=` that is the id of the last row of the page
 *  before this one. The facets come back whole so the filter menus never collapse to what is
 *  selected. */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const params = new URL(request.url).searchParams
  const filters = parseCatalogFilters(params)
  // A blank or absent cursor is the FIRST page, never an error: a shared link that lost its cursor
  // is a link to the top of the list, which is the honest thing to render.
  const cursor = (params.get('cursor') ?? '').trim()
  return Response.json(await listWorkforceCatalogPage(filters, cursor === '' ? {} : { cursor }))
}
```

`apps/web/src/app/api/org/templates/[templateId]/activation/route.ts` (new):

```ts
import { setTemplateActivation } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * The Catalog row's activation toggle (M55 R2/R6). `POST { active: boolean }` -- a POST rather than
 * a PATCH because it is one whole state, not a patch of a many-field row, and it is idempotent
 * either way (`setTemplateActivation` answers `{ changed: false }` for a no-op).
 *
 * A body that is not a boolean is a 409 through `invalid_request`, the union's existing kind: the
 * route does not invent a shape check the control layer would have to repeat.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  const active = (body as { active?: unknown } | null)?.active
  if (typeof active !== 'boolean') {
    return Response.json({ error: 'activation takes { "active": true } or { "active": false }' }, { status: 409 })
  }
  return orgControlResponse(() => setTemplateActivation(templateId, active, gate.principal?.userId ?? undefined))
}
```

`apps/web/src/app/api/org/templates/[templateId]/duplicates/route.ts` (new):

```ts
import { listTemplateDuplicatesView } from '../../../../../../server/org'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** Every pair one template is in, for the profile drawer's Duplicates group (M55 R6). A 200 with an
 *  EMPTY array for a template that is in none, and a 200 with an empty array for a template id
 *  nobody wrote -- "nothing looks like this row" and "there is no such row" are the same answer to
 *  the question this endpoint is asked, and a 404 here would make an open drawer flash an error
 *  band the instant a template was deleted in another tab. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  return Response.json(await listTemplateDuplicatesView(templateId))
}
```

`apps/web/src/app/api/org/duplicates/[pairId]/dismissal/route.ts` (new):

```ts
import { setTemplateDuplicateDismissal } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** A person says "I know" about one pair, or takes it back (M55 R5/R6). `POST { dismissed: boolean }`.
 *  The pair is addressed by its OWN id rather than by the two template ids, because `aId < bId` is a
 *  writer's rule and a caller should not have to know it. */
export async function POST(
  request: Request,
  context: { params: Promise<{ pairId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { pairId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  const dismissed = (body as { dismissed?: unknown } | null)?.dismissed
  if (typeof dismissed !== 'boolean') {
    return Response.json({ error: 'dismissal takes { "dismissed": true } or { "dismissed": false }' }, { status: 409 })
  }
  return orgControlResponse(() => setTemplateDuplicateDismissal(pairId, dismissed, gate.principal?.userId ?? undefined))
}
```

`apps/web/src/components/ui/DetailsGroup.tsx` gains the eighteenth member of `DetailsGroupName`:

```ts
  // M55 R6: which other catalog rows look like this one. The fourteenth of R6's groups, after
  // `source`, and deliberately not folded into it: provenance answers "where did this come from" and
  // this answers "who else is this", which are two questions with two different next actions.
  | 'duplicates'
```

- [ ] **Step 4: Write the failing component tests**

`apps/web/test/catalog-duplicates.test.tsx` (new), for the chip, the toggle, the paging control and the drawer group:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogRowView, WorkforceCatalogView } from '../src/server/org.js'
import { WorkforceCatalog } from '../src/components/workforce/WorkforceCatalog.js'

const replaceState = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))

function row(over: Partial<CatalogRowView> = {}): CatalogRowView {
  return {
    id: 't1',
    name: 'Core Builder',
    role: 'engineering',
    description: 'Builds the core.',
    defaultModel: null,
    defaultProvider: null,
    catalogSlaveCount: 0,
    sourceId: 'catalog-m55/engineering/core-builder',
    sourceDivision: 'engineering',
    importedAt: '2026-09-14T09:00:00.000Z',
    sourceRepository: 'catalog-m55',
    sourceRevision: '0f1e2d3',
    sourceLicense: 'MIT',
    source: 'imported',
    structured: true,
    summary: 'Builds the core module and the tests that hold it up.',
    capabilities: ['Design the module boundary'],
    capabilityKeys: ['backend.services'],
    expertise: ['Load-bearing code'],
    recommendedSkills: ['writing-plans'],
    mappingQuality: 'full',
    overriddenFields: [],
    rawOverride: false,
    active: false,
    activationChangedAt: null,
    activationChangedBy: null,
    duplicate: null,
    duplicateCount: 0,
    ...over,
  }
}

const view = (rows: readonly CatalogRowView[], over: Partial<WorkforceCatalogView> = {}): WorkforceCatalogView => ({
  rows,
  facets: { divisions: ['engineering'], capabilities: ['backend.services'], skills: ['writing-plans'] },
  total: rows.length,
  nextCursor: null,
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('history', { replaceState })
  fetchMock = vi.fn(async () => new Response(JSON.stringify(view([row()])), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the activation toggle (M55 R2, R6)', () => {
  it('reads a WORD and carries the boolean one attribute away (ia.md rule 3)', () => {
    render(<WorkforceCatalog initial={view([row({ active: false })])} />)

    const toggle = screen.getByTestId('catalog-activate-t1')
    expect(toggle.textContent).toBe('inactive')
    expect(toggle.getAttribute('data-active')).toBe('false')
    expect(screen.getByTestId('catalog-row-t1').textContent).not.toContain('false')
  })

  it('reads the other word for a row that is on', () => {
    render(<WorkforceCatalog initial={view([row({ active: true })])} />)

    expect(screen.getByTestId('catalog-activate-t1').textContent).toBe('active')
    expect(screen.getByTestId('catalog-activate-t1').getAttribute('data-active')).toBe('true')
  })

  it('posts the OPPOSITE of what the row says, to the row own activation path', async () => {
    render(<WorkforceCatalog initial={view([row({ active: false })])} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-activate-t1'))
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/templates/t1/activation',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ active: true }) }),
      )
    })
  })

  it('does NOT open the drawer -- the toggle is an action ON the row, not a way INTO it', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-activate-t1'))
    })

    expect(screen.queryByTestId('profile-drawer')).toBeNull()
  })
})

describe('the duplicate chip (M55 R6, R9)', () => {
  const withPair = (over: Partial<CatalogRowView> = {}): CatalogRowView =>
    row({
      duplicate: {
        pairId: 'p1',
        class: 'exact',
        basis: 'content_hash',
        score: 1,
        otherTemplateId: 't2',
        otherName: 'Backend Architect',
      },
      duplicateCount: 1,
      ...over,
    })

  it('reads as a sentence: the class as words, then the OTHER row name', () => {
    render(<WorkforceCatalog initial={view([withPair()])} />)

    expect(screen.getByTestId('catalog-duplicate-t1').textContent).toContain('Duplicate of Backend Architect')
  })

  it('says `+N` when the row is in more than one pair', () => {
    render(<WorkforceCatalog initial={view([withPair({ duplicateCount: 3 })])} />)

    expect(screen.getByTestId('catalog-duplicate-t1').textContent).toContain('+2')
  })

  it('carries the raw class, the raw basis and the score on attributes, and prints none of them', () => {
    render(<WorkforceCatalog initial={view([withPair()])} />)

    const chip = screen.getByTestId('catalog-duplicate-t1')
    expect(chip.getAttribute('data-class')).toBe('exact')
    expect(chip.getAttribute('data-basis')).toBe('content_hash')
    expect(chip.getAttribute('data-score')).toBe('1')
    expect(chip.textContent).not.toContain('exact')
    expect(chip.textContent).not.toContain('content_hash')
  })

  it('puts the basis, the score to three decimals and the evidence sentence in the title (R9)', () => {
    render(<WorkforceCatalog initial={view([withPair()])} />)

    const title = screen.getByTestId('catalog-duplicate-t1').getAttribute('title') ?? ''
    expect(title).toContain('same persona text')
    expect(title).toContain('1.000')
    expect(title).toContain('evidence is recorded per profile, so two rows split their own record')
  })

  it('renders NO chip for a row nothing was noticed about', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    expect(screen.queryByTestId('catalog-duplicate-t1')).toBeNull()
  })
})

describe('the count sentence and Show more (M55 R3)', () => {
  it('says `N templates` when the page IS the whole answer', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    expect(screen.getByTestId('catalog-count').textContent).toBe('1 template')
    expect(screen.queryByTestId('catalog-more')).toBeNull()
  })

  it('says `showing N of M templates` when it is not, and offers the control', () => {
    render(<WorkforceCatalog initial={view([row()], { total: 312, nextCursor: 't1' })} />)

    expect(screen.getByTestId('catalog-count').textContent).toBe('showing 1 of 312 templates')
    expect(screen.getByTestId('catalog-more')).toBeTruthy()
  })

  it('asks for the NEXT page with the cursor, and APPENDS rather than replacing', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(view([row({ id: 't2', name: 'Second Row' })], { total: 2, nextCursor: null })), { status: 200 }),
    )
    render(<WorkforceCatalog initial={view([row()], { total: 2, nextCursor: 't1' })} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-more'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('catalog-row-t1')).toBeTruthy()
      expect(screen.getByTestId('catalog-row-t2')).toBeTruthy()
    })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor=t1'))).toBe(true)
    expect(screen.getByTestId('catalog-count').textContent).toBe('2 templates')
  })
})

describe('the two new filter controls (M55 R3, R6)', () => {
  it('offers the duplicate facets as WORDS over raw values', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    const select = screen.getByTestId('catalog-duplicates-select') as HTMLSelectElement
    const options = [...select.options].map((option) => [option.value, option.text] as const)
    expect(options).toEqual([
      ['', 'any'],
      ['exact', 'duplicates'],
      ['near', 'near duplicates'],
      ['overlapping', 'overlapping'],
      ['none', 'no signal'],
    ])
  })

  it('offers the capability facet as LABELS over taxonomy keys', () => {
    render(
      <WorkforceCatalog
        initial={view([row()])}
        taxonomy={[{ key: 'backend.services', label: 'Service implementation', domain: 'backend', role: 'backend', synonyms: [] }]}
      />,
    )

    const select = screen.getByTestId('catalog-capability-select') as HTMLSelectElement
    const option = [...select.options].find((candidate) => candidate.value === 'backend.services')
    expect(option?.text).toBe('Service implementation')
  })

  it('falls back to the KEY for a facet value this build taxonomy has never heard of', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    const select = screen.getByTestId('catalog-capability-select') as HTMLSelectElement
    expect([...select.options].find((candidate) => candidate.value === 'backend.services')?.text).toBe('backend.services')
  })

  it('has an activation chip per word, pressed state and all', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    expect(screen.getByTestId('catalog-active-chip-active').textContent).toBe('active')
    expect(screen.getByTestId('catalog-active-chip-inactive').textContent).toBe('inactive')
    expect(screen.getByTestId('catalog-active-chip-active').getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-active-chip-active'))
    })

    expect(screen.getByTestId('catalog-active-chip-active').getAttribute('aria-pressed')).toBe('true')
  })
})
```

`apps/web/test/workforce-catalog.test.tsx` moves in exactly two ways and in no other: its `row()` fixture gains the five new fields (`active: false`, `activationChangedAt: null`, `activationChangedBy: null`, `duplicate: null`, `duplicateCount: 0`) and its `view()` helper gains `total: rows.length` and `nextCursor: null`. Every assertion in that file stays as it is — which is the proof that R3 and R6 added to the surface and removed nothing (`docs/ia.md` rule 2).

- [ ] **Step 5: Run them, watch them fail, and write the three surfaces**

Run: `npx vitest run apps/web/test/catalog-duplicates.test.tsx apps/web/test/workforce-catalog.test.tsx`
Expected: FAIL — `catalog-activate-t1`, `catalog-duplicate-t1`, `catalog-more`, `catalog-duplicates-select` and `catalog-active-chip-active` are all absent, and `catalog-count` reads `1 template` where the paged case wants a sentence.

`apps/web/src/components/workforce/CatalogFilterBar.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import type { WorkforceCatalogFacets, WorkforceCatalogFilters } from '@slave-of-ai/control'
import {
  DUPLICATE_FACETS,
  DUPLICATE_FACET_LABEL,
  capabilityLabel,
  type CapabilityRecord,
  type DuplicateFacet,
} from '@slave-of-ai/domain'
import {
  ACTIVATION_LABEL,
  CATALOG_ACTIVATIONS,
  CATALOG_SEARCH_DEBOUNCE_MS,
  CATALOG_SOURCES,
  type CatalogActivation,
  type CatalogSource,
} from '../../lib/catalogFilters'
import { Button } from '../ui/Button'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'

/**
 * ONE vocabulary (M46 fix round 1): the chip says exactly the word the catalog ROW says for the same
 * fact -- `imported` and `local`, `active` and `inactive` -- because a filter labelled `Made here`
 * beside rows labelled `local` is two names for one thing, and a person has to learn which is which
 * before they can use either. `data-source` and `data-active` still carry the values for a gate.
 */
const SOURCE_LABEL: Record<CatalogSource, string> = {
  imported: 'imported',
  local: 'local',
}

type FilterKey = 'q' | 'division' | 'capability' | 'source' | 'skill' | 'active' | 'duplicates'

const asSource = (value: string): CatalogSource | undefined => CATALOG_SOURCES.find((member) => member === value)
const asFacet = (value: string): DuplicateFacet | undefined => DUPLICATE_FACETS.find((member) => member === value)

/**
 * One filter changed, the other six carried through -- and `''` means "drop this one" rather than
 * "match the empty string" (an `<option value="">any</option>`, a cleared search box and a chip
 * clicked twice all send it).
 *
 * Written out key by key instead of a computed-key spread: under `exactOptionalPropertyTypes` an
 * optional key that is PRESENT and `undefined` is a different type from an absent one, and a
 * `{ [key]: value }` over a union of keys widens to an index signature that would let an eighth
 * filter through without anybody deciding what it means.
 */
function withFilter(filters: WorkforceCatalogFilters, key: FilterKey, value: string): WorkforceCatalogFilters {
  const q = key === 'q' ? value : filters.q
  const division = key === 'division' ? value : filters.division
  const capability = key === 'capability' ? value : filters.capability
  const source = key === 'source' ? asSource(value) : filters.source
  const skill = key === 'skill' ? value : filters.skill
  const active = key === 'active' ? (value === '' ? undefined : value === 'active') : filters.active
  const duplicates = key === 'duplicates' ? asFacet(value) : filters.duplicates
  return {
    ...(q !== undefined && q !== '' ? { q } : {}),
    ...(division !== undefined && division !== '' ? { division } : {}),
    ...(capability !== undefined && capability !== '' ? { capability } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(skill !== undefined && skill !== '' ? { skill } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(duplicates !== undefined ? { duplicates } : {}),
  }
}

/**
 * The catalog's filter row (M46 R6, seven controls since M55 R3), shaped like
 * `activity/FilterBar.tsx`: coarse chips for the two facets with two values, a `<select>` for each
 * facet that is a list. No new dependency and no combobox -- the facets come back sorted and a
 * division list is short enough to scan.
 *
 * The SEARCH BOX keeps its own state and pushes it up after {@link CATALOG_SEARCH_DEBOUNCE_MS}
 * (M53 section 6's carried item, taken here by M55 R3). It was cosmetic while the read model
 * filtered an array; it stopped being cosmetic the moment each keystroke became an `ILIKE` over the
 * whole table plus a `count` over the same `where`. The input stays instant -- what waits is the
 * request.
 */
export function CatalogFilterBar({
  filters,
  facets,
  taxonomy = [],
  onChange,
}: {
  readonly filters: WorkforceCatalogFilters
  readonly facets: WorkforceCatalogFacets
  /** M55 R3: the capability facet's OPTIONS are taxonomy keys, and this is what turns each into a
   *  word. Defaults to empty, where every key prints as itself -- the `capabilityLabel` fallback,
   *  which is the honest thing to show for a key this bundle has never heard of. */
  readonly taxonomy?: readonly CapabilityRecord[]
  readonly onChange: (next: WorkforceCatalogFilters) => void
}): React.JSX.Element {
  const set = (key: FilterKey, value: string): void => onChange(withFilter(filters, key, value))

  // The search box's own state, so typing is never gated on a network round trip. Seeded from the
  // filters and re-seeded whenever they change from OUTSIDE this component -- Clear filters, or a
  // link opened with a `?q=` on it -- which is what the dependency on `filters.q` is for.
  const [query, setQuery] = useState(filters.q ?? '')
  useEffect(() => {
    setQuery(filters.q ?? '')
  }, [filters.q])
  useEffect(() => {
    if (query === (filters.q ?? '')) return
    const timer = setTimeout(() => set('q', query), CATALOG_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `set` and `filters` are read inside the timer and would re-arm it on every render if they were
    // dependencies; `query` is the only thing whose change should restart the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const select = (
    key: 'division' | 'capability' | 'skill',
    label: string,
    options: readonly string[],
    textOf: (option: string) => string = (option) => option,
  ): React.JSX.Element => (
    <label className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <select
        data-testid={`catalog-${key}-select`}
        aria-label={label}
        value={filters[key] ?? ''}
        onChange={(event) => set(key, event.target.value)}
        className={`w-44 ${INPUT_SHELL}`}
      >
        <option value="">any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {textOf(option)}
          </option>
        ))}
      </select>
    </label>
  )
  const filtered = Object.keys(filters).length > 0

  return (
    <div data-testid="catalog-filters" className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <FieldLabel>Search</FieldLabel>
        <input
          data-testid="catalog-search"
          aria-label="search the catalog"
          value={query}
          placeholder="name, summary, capability, expertise"
          onChange={(event) => setQuery(event.target.value)}
          className={`w-72 ${INPUT_SHELL}`}
        />
      </label>
      <div className="flex items-center gap-1 pb-1">
        {CATALOG_SOURCES.map((source) => (
          <button
            key={source}
            type="button"
            data-testid={`catalog-source-chip-${source}`}
            data-source={source}
            aria-pressed={filters.source === source}
            onClick={() => set('source', filters.source === source ? '' : source)}
            className={`rounded-bubble border px-[9px] py-[3px] font-mono text-[10px] font-medium transition-colors ${
              filters.source === source ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
            }`}
          >
            {SOURCE_LABEL[source]}
          </button>
        ))}
      </div>
      {/* M55 R6: the activation chips, in the source chips' own two-value shape -- and clicking the
        * pressed one clears the filter, because "either" is a real third state and a two-chip
        * control with no way back to it is a trap. */}
      <div className="flex items-center gap-1 pb-1">
        {CATALOG_ACTIVATIONS.map((activation: CatalogActivation) => {
          const pressed = filters.active === (activation === 'active')
          return (
            <button
              key={activation}
              type="button"
              data-testid={`catalog-active-chip-${activation}`}
              data-active={String(activation === 'active')}
              aria-pressed={pressed}
              onClick={() => set('active', pressed ? '' : activation)}
              className={`rounded-bubble border px-[9px] py-[3px] font-mono text-[10px] font-medium transition-colors ${
                pressed ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
              }`}
            >
              {ACTIVATION_LABEL[activation]}
            </button>
          )
        })}
      </div>
      {select('division', 'Division', facets.divisions)}
      {/* M55 R3: the OPTIONS are taxonomy keys and the TEXT is their labels -- `docs/ia.md` rule 3,
        * and the key is what a gate reads off `<option value>`. */}
      {select('capability', 'Capability', facets.capabilities, (key) => capabilityLabel(key, taxonomy))}
      {select('skill', 'Skill', facets.skills)}
      <label className="flex flex-col gap-1">
        <FieldLabel>Duplicates</FieldLabel>
        <select
          data-testid="catalog-duplicates-select"
          aria-label="Duplicates"
          value={filters.duplicates ?? ''}
          onChange={(event) => set('duplicates', event.target.value)}
          className={`w-44 ${INPUT_SHELL}`}
        >
          <option value="">any</option>
          {DUPLICATE_FACETS.map((facet) => (
            <option key={facet} value={facet}>
              {DUPLICATE_FACET_LABEL[facet]}
            </option>
          ))}
        </select>
      </label>
      {filtered && (
        <Button variant="ghost" size="sm" data-testid="catalog-clear-filters" onClick={() => onChange({})}>
          Clear filters
        </Button>
      )}
    </div>
  )
}
```

`apps/web/src/components/workforce/WorkforceCatalog.tsx` gains four things and loses nothing. The column list grows by two:

```tsx
const COLUMNS = '1fr 110px 1.4fr 1.3fr 150px 130px 90px 90px'
const HEADER = ['Name', 'Division', 'Summary', 'Capabilities', 'Source', 'Default model', 'Hirable', ''] as const
```

the `reload` gains a cursor and an append mode:

```tsx
  const latest = useRef(0)
  const reload: (next: WorkforceCatalogFilters, options?: { attemptsLeft?: number; cursor?: string }) => void =
    useCallback((next: WorkforceCatalogFilters, options: { attemptsLeft?: number; cursor?: string } = {}): void => {
      const params = catalogFilterParams(next)
      // The cursor is NOT one of `catalogFilterParams`' seven: it is a position in an answer, not a
      // filter, and writing it into the address bar would make a shared link open on page two of a
      // list whose page one the reader never saw.
      if (options.cursor !== undefined) params.set('cursor', options.cursor)
      const query = params.toString()
      const id = latest.current + 1
      latest.current = id
      setRefreshing(true)
      const failed = (): void => {
        if ((options.attemptsLeft ?? 0) > 0) {
          reload(next, { ...options, attemptsLeft: (options.attemptsLeft ?? 0) - 1 })
          return
        }
        setRefreshing(false)
        setStaleError(true)
      }
      void fetch(query === '' ? '/api/org/catalog' : `/api/org/catalog?${query}`)
        .then(async (response) => (response.ok ? ((await response.json()) as WorkforceCatalogView) : null))
        .then((view) => {
          if (id !== latest.current) return
          if (view === null) {
            failed()
            return
          }
          setRefreshing(false)
          setStaleError(false)
          // A cursored answer EXTENDS what is on screen; an uncursored one replaces it. Anything
          // else would make `Show more` flash the list away and redraw it.
          setPage((current) => (options.cursor === undefined ? view : { ...view, rows: [...current.rows, ...view.rows] }))
        })
        .catch(() => {
          if (id !== latest.current) return
          failed()
        })
    }, [])
```

the count sentence and the control below the table:

```tsx
      <span data-testid="catalog-count" className="text-xs text-text-3">
        {/* Two sentences and not one (M55 R3): `N templates` when what is on screen IS the whole
          * answer -- which is what `gate:m46-workforce-catalog` stage 2b reads -- and
          * `showing N of M templates` when it is not, because a count that silently means "the
          * first hundred" is a number that lies. */}
        {page.rows.length >= page.total
          ? plural(page.total, 'template')
          : `showing ${String(page.rows.length)} of ${plural(page.total, 'template')}`}
      </span>
```

```tsx
      {page.nextCursor !== null && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="catalog-more"
          disabled={refreshing}
          onClick={() => reload(filters, { cursor: page.nextCursor ?? undefined })}
        >
          Show more
        </Button>
      )}
```

the duplicate chip, beside the two marker chips under the name:

```tsx
                    <span className="flex gap-1">
                      {row.overriddenFields.length > 0 && (
                        <Chip testId={`catalog-overridden-${row.id}`}>customised</Chip>
                      )}
                      {row.rawOverride && <Chip testId={`catalog-raw-override-${row.id}`}>raw override</Chip>}
                      {row.duplicate !== null && (
                        /* M55 R6/R9. The CLASS as the first half of a sentence and the other row's
                         * NAME as the second; the raw class, basis and score one attribute away; and
                         * the `title` carrying the sentence R9 requires, because the consequence of
                         * an undetected duplicate is a split record and the person looking at this
                         * chip is the person who can act on it. */
                        <span
                          data-testid={`catalog-duplicate-${row.id}`}
                          data-class={row.duplicate.class}
                          data-basis={row.duplicate.basis}
                          data-score={String(row.duplicate.score)}
                          title={
                            `${DUPLICATE_BASIS_LABEL[row.duplicate.basis]} · ${row.duplicate.score.toFixed(3)} — ` +
                            'evidence is recorded per profile, so two rows split their own record.'
                          }
                          className="inline-flex items-center rounded-chip border border-line bg-bg-2 px-2 py-0.5 text-xs text-text-2"
                        >
                          {`${DUPLICATE_CLASS_LABEL[row.duplicate.class]} ${row.duplicate.otherName}`}
                          {row.duplicateCount > 1 && ` +${String(row.duplicateCount - 1)}`}
                        </span>
                      )}
                    </span>
```

and the toggle, in its own column before the delete:

```tsx
                  {/* M55 R2/R6. A WORD, never `true`; the boolean on `data-active`; and
                    * `stopPropagation`, the same thing the delete control beside it does, so
                    * activating a row does not also open its drawer behind the click. */}
                  <span onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      data-testid={`catalog-activate-${row.id}`}
                      data-active={String(row.active)}
                      aria-pressed={row.active}
                      title={row.activationChangedBy === null ? 'nobody has changed this' : `last changed by ${row.activationChangedBy}`}
                      onClick={() => {
                        void sendControl(`/api/org/templates/${row.id}/activation`, {
                          method: 'POST',
                          body: { active: !row.active },
                        }).then((error) => {
                          if (error === null) reload(filters)
                        })
                      }}
                      className={`rounded-bubble border px-[9px] py-[3px] font-mono text-[10px] font-medium transition-colors ${
                        row.active ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
                      }`}
                    >
                      {row.active ? 'active' : 'inactive'}
                    </button>
                  </span>
```

The filter bar gets the taxonomy it now needs, and the drawer gets a way to open another row:

```tsx
      <CatalogFilterBar filters={filters} facets={page.facets} taxonomy={taxonomy} onChange={setFilters} />
```

```tsx
      {open !== null && (
        <ProfileDrawer
          key={open.id}
          templateId={open.id}
          name={open.name}
          capabilityKeys={open.capabilityKeys}
          taxonomy={taxonomy}
          onClose={() => setOpen(null)}
          onChanged={() => reload(filters)}
          /* M55 R6: the drawer's Duplicates group names the other template as a BUTTON that opens
           * ITS drawer. The keys come off the loaded page when the row is on it; a row that is not
           * (the pair points past the first hundred) opens with none, and the drawer's "Matchable
           * capabilities" block simply does not render -- everything else in it is fetched by id. */
          onOpenTemplate={(id, name) =>
            setOpen({ id, name, capabilityKeys: page.rows.find((candidate) => candidate.id === id)?.capabilityKeys ?? [] })
          }
        />
      )}
```

with `DUPLICATE_BASIS_LABEL` and `DUPLICATE_CLASS_LABEL` added to the file's `@slave-of-ai/domain` import and `Button` to its `ui` imports.

`apps/web/src/components/workforce/ProfileDrawer.tsx` gains the fourteenth group. `GROUPS` gains one entry after `source`:

```tsx
  { group: 'source', title: 'Source' },
  // M55 R6: who ELSE this row looks like. After Source, because provenance answers "where did this
  // come from" and this answers "who else is this" -- two questions, two next actions.
  { group: 'duplicates', title: 'Duplicates' },
```

the component takes one more prop and one more fetch:

```tsx
  /** M55 R6: open another template's drawer from a pair. Optional, so a caller that has no second
   *  drawer to open (a test, a future embed) renders the name as text instead of a button. */
  readonly onOpenTemplate?: (templateId: string, name: string) => void
```

```tsx
  const [duplicates, setDuplicates] = useState<readonly TemplateDuplicateRowView[] | null>(null)
  const reloadDuplicates = useCallback((): void => {
    void fetch(`/api/org/templates/${templateId}/duplicates`)
      .then(async (response) => (response.ok ? ((await response.json()) as TemplateDuplicateRowView[]) : []))
      // An empty list on failure, never an error band: the group says "nothing looks like this row",
      // which is what a reader takes from an empty Duplicates group anyway, and a red band inside a
      // profile drawer would claim the PROFILE failed to load.
      .catch(() => [])
      .then((rows) => setDuplicates(rows))
  }, [templateId])
  useEffect(() => {
    reloadDuplicates()
  }, [reloadDuplicates])
```

and the group's body joins the `GROUPS.map` beside the `source` arm:

```tsx
            {group === 'duplicates' ? (
              duplicates === null ? (
                <LoadingState testId="profile-duplicates-loading" message="reading what else looks like this…" />
              ) : duplicates.length === 0 ? (
                <span className="text-xs text-text-3">nothing else in the catalog looks like this row.</span>
              ) : (
                <div className="flex flex-col gap-1">
                  {duplicates.map((pair) => {
                    const otherId = pair.aId === templateId ? pair.bId : pair.aId
                    const otherName = pair.aId === templateId ? pair.bName : pair.aName
                    return (
                      <div
                        key={pair.id}
                        data-testid={`profile-duplicate-${pair.id}`}
                        data-class={pair.class}
                        data-basis={pair.basis}
                        data-score={String(pair.score)}
                        className={`flex flex-wrap items-center gap-2 text-xs ${pair.dismissedAt === null ? 'text-text-2' : 'text-text-3 opacity-60'}`}
                      >
                        <span>{DUPLICATE_CLASS_LABEL[pair.class]}</span>
                        {onOpenTemplate === undefined ? (
                          <span className="text-text-1">{otherName}</span>
                        ) : (
                          <button
                            type="button"
                            data-testid={`profile-duplicate-open-${pair.id}`}
                            onClick={() => onOpenTemplate(otherId, otherName)}
                            className="text-text-1 underline decoration-dotted underline-offset-2 hover:text-text-2"
                          >
                            {otherName}
                          </button>
                        )}
                        <span className="font-mono text-[10px] text-text-3">{pair.score.toFixed(3)}</span>
                        <span className="text-text-3">{DUPLICATE_BASIS_LABEL[pair.basis]}</span>
                        <span className="font-mono text-[10px] text-text-3">{pair.detectedAt.slice(0, 10)}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`profile-duplicate-dismiss-${pair.id}`}
                          onClick={() => {
                            void sendControl(`/api/org/duplicates/${pair.id}/dismissal`, {
                              method: 'POST',
                              body: { dismissed: pair.dismissedAt === null },
                            }).then((error) => {
                              if (error !== null) return
                              reloadDuplicates()
                              onChanged()
                            })
                          }}
                        >
                          {pair.dismissedAt === null ? 'Dismiss' : 'Restore'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              )
            ) : group === 'source' ? (
```

— the existing `group === 'source' ? (...) : (...)` conditional becomes the second arm of this one, and its body does not change by a character.

`apps/web/src/components/CatalogImports.tsx` gains the three counts (erratum E9 — seven numbers, not six):

```tsx
const COLUMNS = '150px 1fr 110px 70px 70px 80px 70px 70px 70px 90px'
const HEADER = ['When', 'Catalog', 'By', 'Created', 'Updated', 'Unchanged', 'Skipped', 'Same', 'Similar', 'Overlapping'] as const
```

with `duplicates` on `CatalogImportRow` and three more cells in the row, each reading `row.duplicates.exact` / `.near` / `.overlapping`. The HEADER says `Same` / `Similar` / `Overlapping` rather than the raw class members (`docs/ia.md` rule 3), and `title` on each cell carries the class label sentence.

- [ ] **Step 6: `docs/ia.md`**

The `/workforce` row's "Later" column gains M55's sentence, after M53's:

> M55 turns the Catalog into a surface that works at three hundred rows: the filtering and the
> paging happen in the database, there are two more filters (whether a row is hirable, and whether
> anything in the catalog looks like it), a `Show more` under the list, and a two-state toggle on
> every row — because nothing an import creates is hirable until somebody says so. Each row that
> looks like another carries one chip saying which and how, with the raw class one attribute away,
> and the profile drawer gains a fourteenth group listing every pair with a Dismiss beside it.
> Nothing is ever deleted by any of it.

- [ ] **Step 7: Run them, build, browse and commit**

```bash
npx vitest run apps/web/test/catalog-duplicates.test.tsx apps/web/test/workforce-catalog.test.tsx apps/web/test/catalog-filters.test.ts
```
Expected: PASS.

```bash
npx vitest run 2>&1 | tail -20
```
Expected: at or above Task 1's recorded baseline, zero failures.

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"   # must be empty
npm run web:build
```

`web:build` is the gate that matters here and it is LAST, because tsc and vitest do not see bundler-only breakage — and this task adds a `'use client'` component that imports three new values from `@slave-of-ai/domain` (`DUPLICATE_CLASS_LABEL`, `DUPLICATE_BASIS_LABEL`, `DUPLICATE_FACETS`), which pulls `catalog/duplicate.ts` into webpack's BROWSER build. **If that module ever grew a `node:` import, this is the command that would say so**, with the same error `goal/version.ts:23-36` records.

```bash
git add apps/web docs/ia.md
git commit -m "$(cat <<'EOF'
feat(web): m55 t5 — a catalog page you can work in when it holds hundreds of rows

Seven filters in the URL instead of five, a count sentence that says `showing 100 of 312` when that
is what is on screen, and a `Show more` that extends the list rather than replacing it. The search
box waits 250 ms before it asks -- which was cosmetic while the read model filtered an array and
stopped being cosmetic the moment each keystroke became a scan over the whole table.

Every row carries a two-state toggle reading `active` or `inactive`, with the boolean one attribute
away and `stopPropagation` so activating a row does not also open its drawer. Every row that looks
like another carries one chip: the class as the first half of a sentence, the other row's name as
the second, the raw class, basis and score on attributes, and a title that says the basis, the score
to three decimals, and why it matters -- evidence is recorded per profile, so two rows split their
own record.

The capability filter offers taxonomy labels over taxonomy keys, which is what makes it a `where`
clause. The duplicates filter offers four words over four raw members, `no signal` included. The
profile drawer gains a fourteenth group listing every pair this row is in, dismissed ones greyed
with a Restore beside them, each naming the other template as a button that opens its drawer.

Nothing was removed: every filter, chip, group, testid and column that existed still exists, and
every assertion in `workforce-catalog.test.tsx` passes unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 6: `gate:m55-catalog`, the seventh fake, CI, the README — and the full verification ladder (§3, E11, E12, D71–D80)

**Files:**
- Create: `scripts/gate-fakes/gen-catalog.mjs`, `scripts/gate-m55-catalog.mjs`
- Modify: `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/superpowers/specs/2026-09-13-m55-catalog-import-design.md` (its §5), `docs/superpowers/plans/2026-09-13-m55-catalog-import.md`
- Test: the gate itself, plus the whole ladder

**Interfaces:**
- Consumes: everything Tasks 1–5 produced, plus `CAPABILITY_SEED` (`packages/db/src/capabilities.ts:23`, read from `packages/db/dist/capabilities.js` the way every gate reads a built package).
- Produces: `npm run gate:m55-catalog`, CI's 30th step, the README's 30.

- [ ] **Step 1: The seventh fake, and the first that WRITES**

`scripts/gate-fakes/gen-catalog.mjs`. Six files in that directory stand in for a binary somebody else would have run; this one stands in for a CATALOG somebody else would have written, which is a thing this repository may not check in (M42 erratum E5: the reference catalog's directory name carries the forbidden word, and no fixture may be three hundred files of somebody's personas either way).

```js
#!/usr/bin/env node
// A CATALOG GENERATOR, for `scripts/gate-m55-catalog.mjs` (M55 section 3).
//
// The SEVENTH fake in this directory and the first that is a WRITER rather than a stand-in for a
// binary. `fake-claude.sh` and `fake-cursor-agent.sh` pretend to be a worker, `fake-deploy.sh`
// pretends to be the thing a worker may not touch, `fake-worker-server.sh` pretends to be a stray
// daemon, `fake-verify.sh` pretends to be a project's own verify command, `fake-github.mjs` pretends
// to be GitHub -- and this pretends to be a real persona catalog on an operator's disk.
//
//   node scripts/gate-fakes/gen-catalog.mjs <output-dir> <seed> [--no-license]
//
// DETERMINISTIC. The same seed writes the same bytes, every time, on every machine: one xorshift32
// seeded from argv, no `Date`, no `Math.random`, no filesystem order anywhere.
//
// VOCABULARY-CLEAN (`gate:m26-vocabulary`). Every word it can emit is in the lists below, and the
// word for a worker is `slave`. The output directory is a `mkdtemp` the GATE chose, so no product
// string, comment or default anywhere names a real catalog (M42 erratum E5).
//
// THE CAPABILITY BULLETS ARE TAXONOMY LABELS, not invented words (M55 plan erratum E11). Three of
// the twelve stages are statements about `SlaveTemplate.capabilityKeys`, which `importCatalog` fills
// by matching a WHOLE normalised bullet against `CAPABILITY_SEED`'s keys, labels and synonyms -- so a
// bullet composed of invented words resolves to nothing and every one of those stages would be
// measuring an empty list.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPABILITY_SEED } from '../../packages/db/dist/capabilities.js'

const [outDir, seedText, ...switches] = process.argv.slice(2)
if (outDir === undefined || seedText === undefined || !/^\d+$/.test(seedText)) {
  // Exit 3, never 1: a 1 is an outcome the gate asserts on. 3 says the FAKE is misconfigured --
  // `fake-deploy.sh`'s own rule.
  process.stderr.write('gen-catalog.mjs: usage: gen-catalog.mjs <output-dir> <seed> [--no-license]\n')
  process.exit(3)
}
const withLicense = !switches.includes('--no-license')

/** xorshift32. Two lines, no dependency, and the same sequence in every runtime. */
let state = Number(seedText) >>> 0 || 1
const next = () => {
  state ^= state << 13
  state >>>= 0
  state ^= state >>> 17
  state ^= state << 5
  state >>>= 0
  return state
}
const pick = (list) => list[next() % list.length]

const N = 120
const DIVISIONS = ['engineering', 'testing', 'operations', 'security']
const ADJECTIVES = ['Careful', 'Patient', 'Steady', 'Precise', 'Quiet', 'Thorough', 'Direct', 'Curious', 'Frank', 'Tidy']
const NOUNS = ['Auditor', 'Builder', 'Steward', 'Analyst', 'Planner', 'Reviewer', 'Tester', 'Operator', 'Scribe', 'Guide']
const WORDS = [
  'boundary', 'change', 'record', 'measure', 'plan', 'rollback', 'evidence', 'branch', 'commit', 'queue',
  'report', 'signal', 'threshold', 'budget', 'window', 'sample', 'baseline', 'contract', 'fixture', 'ledger',
  'handoff', 'checklist', 'runbook', 'timeline', 'estimate', 'draft', 'review', 'release', 'rollout', 'probe',
]

const LABELS = CAPABILITY_SEED.map((record) => record.label)
// Nineteen labels are RESERVED and never given to an ordinary persona: eighteen for the three
// planted `overlapping` pairs (six each, so two personas from different pairs share none) and one
// for the solo specialist stages 3 and 4 drive the Supervisor at.
const RESERVED = LABELS.slice(0, 19)
const ORDINARY = LABELS.slice(19)

/** Every unordered pair of ordinary labels, in a fixed order. Persona `i` takes the `i`-th, so no two
 *  ordinary personas share more than ONE label: their capability Jaccard is at most 1/3, which is
 *  under `CAPABILITY_OVERLAP_JACCARD` and therefore can never be an accidental signal. */
const ORDINARY_PAIRS = []
for (let left = 0; left < ORDINARY.length; left += 1) {
  for (let right = left + 1; right < ORDINARY.length; right += 1) ORDINARY_PAIRS.push([ORDINARY[left], ORDINARY[right]])
}

/** A body nobody else can share a five-word window with: every fourth token is this persona's own
 *  marker, so every window of five contains one. That is what makes an ACCIDENTAL `near` or `exact`
 *  pair impossible and every planted one deliberate. */
function bodyWords(marker, count) {
  const out = []
  for (let index = 0; index < count; index += 1) out.push(index % 4 === 3 ? marker : pick(WORDS))
  return out
}

function persona({ name, description, identity, mission, capabilities, body }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
    `${description}`,
    '',
    '## Identity & Role Definition',
    '',
    identity,
    '',
    '## Core Capabilities',
    '',
    ...capabilities.map((label) => `* ${label}`),
    '',
    '## Core Mission',
    '',
    mission,
    '',
    '## Critical Rules',
    '',
    '- You MUST leave the branch green',
    '',
    '## Technical Deliverables',
    '',
    '- A note saying what changed',
    '',
    '## Domain Expertise',
    '',
    '- Reading a measure back to the change that moved it',
    '',
    '## Workflow Process',
    '',
    '- Step 1: read the brief back in your own words',
    '- Step 2: make the smallest change that answers it',
    '',
    '## Success Metrics',
    '',
    '- Nothing left red',
    '',
    '## Working With Others',
    '',
    '- Consult the reviewer before a release',
    '',
    '## Notes',
    '',
    body,
    '',
  ].join('\n')
}

// ---- The 120 personas ---------------------------------------------------------------------------
// Indices 0-8 are the nine PLANTED pairs' first halves and 9-17 their seconds; 18-23 are the three
// near-misses; 24-118 are ordinary; 119 is the solo specialist. Every index below is written out
// rather than computed, because a gate that asserts "exactly nine pairs" must be readable against
// the thing that planted them.
const files = []
const add = (index, division, slug, text) => files.push({ division, slug, text, index })

const nameOf = (index) => `Gate ${ADJECTIVES[index % ADJECTIVES.length]} ${NOUNS[Math.floor(index / 10) % NOUNS.length]} ${String(index).padStart(3, '0')}`

// EXACT pair 1: byte-identical persona text under a different slug AND a different division. Two
// names differ (a name is unique and is not part of the canonical text), everything the canonical
// text reads is the same, so `contentSha256` is equal.
{
  const shared = {
    description: 'Keeps the record of what changed and why.',
    identity: 'The one who writes down what happened, in the order it happened.',
    mission: 'Leave a trail anybody can follow a week later.',
    capabilities: [ORDINARY[0], ORDINARY[1]],
    body: bodyWords('exactone', 60).join(' '),
  }
  add(0, 'engineering', 'exact-one-a', persona({ name: nameOf(0), ...shared }))
  add(9, 'testing', 'exact-one-b', persona({ name: nameOf(9), ...shared }))
}

// EXACT pair 2: identical only after NFC, case and whitespace normalisation. The second copy shouts,
// double-spaces and writes its accent decomposed; nothing else differs.
{
  const base = {
    description: 'Measures a change before it goes out.',
    identity: 'The one who takes the baseline first.',
    mission: 'Know the number before and after.',
    capabilities: [ORDINARY[2], ORDINARY[3]],
    body: bodyWords('exacttwo', 60).join(' '),
  }
  const loud = {
    description: base.description.toUpperCase(),
    identity: base.identity.replace(/ /g, '  '),
    mission: base.mission.toUpperCase(),
    capabilities: base.capabilities,
    body: base.body.toUpperCase(),
  }
  add(1, 'engineering', 'exact-two-a', persona({ name: nameOf(1), ...base }))
  add(10, 'operations', 'exact-two-b', persona({ name: nameOf(10), ...loud }))
}

// EXACT pair 3, basis `name`: two names equal after normalisation and NOTHING else alike. This is
// the arm `SlaveTemplate.name @unique` makes possible at all -- two byte-equal names cannot both
// exist, and `Gate Steady Guide 002` against `gate  steady  guide  002` can.
{
  const name = nameOf(2)
  add(2, 'engineering', 'name-one-a', persona({
    name,
    description: 'Walks a change through the last mile.',
    identity: 'The one who owns the rollout.',
    mission: 'One change at a time, with a way back.',
    capabilities: [ORDINARY[4], ORDINARY[5]],
    body: bodyWords('nameonea', 60).join(' '),
  }))
  add(11, 'security', 'name-one-b', persona({
    name: name.toLowerCase().replace(/ /g, '  '),
    description: 'Reads a change back and says whether it does what it claims.',
    identity: 'The one who trusts nothing that has not run.',
    mission: 'Run it, then say so.',
    capabilities: [ORDINARY[6], ORDINARY[7]],
    body: bodyWords('nameoneb', 60).join(' '),
  }))
}

// NEAR pairs 1-3: the second body is the first plus three words, so 56 shingles are shared out of a
// union of 59 -- a Jaccard of about 0.949, comfortably over NEAR_DUPLICATE_JACCARD and comfortably
// under 1 (which would make it an `exact` by hash instead).
for (const [offset, marker] of [[3, 'nearone'], [4, 'neartwo'], [5, 'nearthree']].entries()) {
  const index = [3, 4, 5][offset]
  const partner = index + 9
  const words = bodyWords(marker, 60)
  const shared = {
    description: `Takes the ${marker} work one step at a time.`,
    identity: 'The one who keeps the plan small.',
    mission: 'Do the next thing, and say what it cost.',
    capabilities: [ORDINARY[8 + offset * 2], ORDINARY[9 + offset * 2]],
  }
  add(index, 'engineering', `${marker}-a`, persona({ name: nameOf(index), ...shared, body: words.join(' ') }))
  add(partner, 'testing', `${marker}-b`, persona({
    name: nameOf(partner),
    ...shared,
    body: [...words, 'one', 'more', 'sentence'].join(' '),
  }))
}

// OVERLAPPING pairs 1-3: different names, unrelated prose, and five capabilities of which four are
// shared -- a Jaccard of 4/6 = 0.667, over CAPABILITY_OVERLAP_JACCARD. Each pair draws from its own
// six RESERVED labels, so two personas from different pairs share none.
for (const [offset, marker] of [[6, 'overone'], [7, 'overtwo'], [8, 'overthree']].entries()) {
  const index = [6, 7, 8][offset]
  const partner = index + 9
  const pool = RESERVED.slice(offset * 6, offset * 6 + 6)
  add(index, 'operations', `${marker}-a`, persona({
    name: nameOf(index),
    description: `Runs the ${marker} side of the work.`,
    identity: 'The one who keeps the pipeline moving.',
    mission: 'Keep it running and say when it is not.',
    capabilities: [pool[0], pool[1], pool[2], pool[3], pool[4]],
    body: bodyWords(`${marker}a`, 60).join(' '),
  }))
  add(partner, 'security', `${marker}-b`, persona({
    name: nameOf(partner),
    description: `Reviews the ${marker} side of the work.`,
    identity: 'The one who reads it back before it ships.',
    mission: 'Find what the plan did not.',
    capabilities: [pool[0], pool[1], pool[2], pool[3], pool[5]],
    body: bodyWords(`${marker}b`, 60).join(' '),
  }))
}

// NEAR-MISS 1: a body pair at exactly 0.7. The second body is the first plus twenty-four words, so
// 56 shingles are shared out of a union of 80.
{
  const words = bodyWords('missbody', 60)
  const shared = {
    description: 'Keeps a list of what is left.',
    identity: 'The one who tracks the remainder.',
    mission: 'Know what has not been done.',
  }
  add(18, 'engineering', 'miss-body-a', persona({
    name: nameOf(18),
    ...shared,
    capabilities: [ORDINARY[14], ORDINARY[15]],
    body: words.join(' '),
  }))
  add(19, 'testing', 'miss-body-b', persona({
    name: nameOf(19),
    ...shared,
    capabilities: [ORDINARY[16], ORDINARY[17]],
    body: [...words, ...bodyWords('missbodytail', 24)].join(' '),
  }))
}

// NEAR-MISS 2: a capability pair sharing two of five -- a Jaccard of 2/8 = 0.25, under the
// threshold.
{
  const pool = RESERVED.slice(0, 5)
  add(20, 'operations', 'miss-caps-a', persona({
    name: nameOf(20),
    description: 'Watches the queue.',
    identity: 'The one who sees it back up first.',
    mission: 'Keep the queue short.',
    capabilities: [pool[0], pool[1], ORDINARY[18], ORDINARY[19], ORDINARY[20]],
    body: bodyWords('misscapsa', 60).join(' '),
  }))
  add(21, 'security', 'miss-caps-b', persona({
    name: nameOf(21),
    description: 'Watches the door.',
    identity: 'The one who reads the log first.',
    mission: 'Know who came in.',
    capabilities: [pool[0], pool[1], ORDINARY[21], ORDINARY[22], ORDINARY[23]],
    body: bodyWords('misscapsb', 60).join(' '),
  }))
}

// NEAR-MISS 3: two names differing by ONE word -- normalised, they are not equal, so no arm fires.
{
  add(22, 'engineering', 'miss-name-a', persona({
    name: 'Gate Thorough Scribe Prime',
    description: 'Writes the note nobody else writes.',
    identity: 'The one who keeps the minutes.',
    mission: 'Say what was decided.',
    capabilities: [ORDINARY[24], ORDINARY[25]],
    body: bodyWords('missnamea', 60).join(' '),
  }))
  add(23, 'testing', 'miss-name-b', persona({
    name: 'Gate Thorough Scribe',
    description: 'Reads the note back.',
    identity: 'The one who checks the minutes.',
    mission: 'Say what was missed.',
    capabilities: [ORDINARY[26], ORDINARY[27]],
    body: bodyWords('missnameb', 60).join(' '),
  }))
}

// The ordinary 95, and the solo specialist at 119.
for (let index = 24; index < N; index += 1) {
  const division = DIVISIONS[index % DIVISIONS.length]
  const capabilities =
    index === N - 1 ? [RESERVED[18], ORDINARY[0]] : ORDINARY_PAIRS[index % ORDINARY_PAIRS.length]
  add(index, division, `persona-${String(index).padStart(3, '0')}`, persona({
    name: nameOf(index),
    description: `Does the ${pick(WORDS)} work and says what it cost.`,
    identity: `The one who handles the ${pick(WORDS)}.`,
    mission: `Keep the ${pick(WORDS)} honest.`,
    capabilities,
    body: bodyWords(`p${String(index)}`, 60).join(' '),
  }))
}

// ---- Write ---------------------------------------------------------------------------------------
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
for (const division of DIVISIONS) mkdirSync(join(outDir, division), { recursive: true })
writeFileSync(
  join(outDir, 'divisions.json'),
  `${JSON.stringify({ divisions: Object.fromEntries(DIVISIONS.map((d) => [d, { label: d }])) }, null, 2)}\n`,
)
if (withLicense) {
  writeFileSync(
    join(outDir, 'LICENSE'),
    'MIT License\n\nCopyright (c) 2026 The gate own generated catalog\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n',
  )
}
for (const file of files) writeFileSync(join(outDir, file.division, `${file.slug}.md`), file.text)

// The MANIFEST the gate asserts against, on stdout as JSON: which slugs are which planted pair, and
// which capability the solo specialist alone provides. The gate parses this rather than re-deriving
// it, so the two cannot drift.
process.stdout.write(
  `${JSON.stringify({
    count: files.length,
    soloSlug: `persona-${String(N - 1).padStart(3, '0')}`,
    soloCapabilityLabel: RESERVED[18],
    exact: [['exact-one-a', 'exact-one-b'], ['exact-two-a', 'exact-two-b'], ['name-one-a', 'name-one-b']],
    near: [['nearone-a', 'nearone-b'], ['neartwo-a', 'neartwo-b'], ['nearthree-a', 'nearthree-b']],
    overlapping: [['overone-a', 'overone-b'], ['overtwo-a', 'overtwo-b'], ['overthree-a', 'overthree-b']],
    misses: [['miss-body-a', 'miss-body-b'], ['miss-caps-a', 'miss-caps-b'], ['miss-name-a', 'miss-name-b']],
  })}\n`,
)
process.exit(0)
```

`chmod +x`. Nothing else in the repository reads it.

**Run it once by hand before writing the gate**, because a fixture that does not produce the nine pairs it claims is a gate that fails for the wrong reason:

```bash
npx tsc --build
node scripts/gate-fakes/gen-catalog.mjs /tmp/m55-fixture 20260914 | tee /tmp/m55-manifest.json
find /tmp/m55-fixture -name '*.md' | wc -l       # 120
node scripts/gate-fakes/gen-catalog.mjs /tmp/m55-fixture-b 20260914 >/dev/null
diff -r /tmp/m55-fixture /tmp/m55-fixture-b      # empty: the same seed writes the same bytes
```

- [ ] **Step 2: Write the gate**

`scripts/gate-m55-catalog.mjs`. Scaffolding cribbed function for function from `scripts/gate-m53-evidence.mjs` — `findFreePort`, `makeRepo`, `preflightCleanup` by name prefix, `assert`, `waitUntil`, `fail` with a `dumpGateRows`, a real `next dev` on a free port, a real Chromium through `playwright-core` at `CHROMIUM_PATH`, `gotoReliably`/`waitVisible`, the real CLI before the browser opens, `loopbackChildEnv` (which calls `gateStateDir()`, so every run directory lands under `/tmp` and the `finally` removes it), and a `finally` that kills every process and removes every temporary directory. `exitCode` starts at 1 and is set to 0 only at the very end.

Header, in the house register:

```js
// M55's own gate (spec section 3): "three hundred files in one command, inert until somebody says
// otherwise, with every pair it noticed named beside the row it is about".
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m55-catalog
//
// NEVER A MODEL CALL, AND ZERO SPEND. Every run is the fake CLI. Nothing in this milestone asks a
// model anything: the three duplicate classes are three thresholds over set arithmetic, and the
// catalog it imports is written by `scripts/gate-fakes/gen-catalog.mjs` from a fixed word list and a
// fixed seed.
//
// THE GATE ASSERTS, IT NEVER FIXES, and every stage prints every measured value before asserting it.
//
// THE CATALOG IS GENERATED, NOT CHECKED IN (spec section 3). 120 personas is deliberately more than
// any fixture in this tree and deliberately far less than a real catalog: enough for two full pages
// at `CATALOG_PAGE_SIZE = 100` and for the import's batching to report twice, small enough that a
// failing stage prints a diagnosable dump. The directory is a `mkdtemp` this gate chose, so no
// checked-in string names a real catalog (M42 erratum E5).
//
// IT NEVER EDITS A FILE IN THIS REPOSITORY. The generated catalogs, the temporary repository and the
// state directory are all under `/tmp` and are removed in the `finally`; `git status --porcelain`
// after a green run is what it was before, and the rows it created are removed by `sourceId` prefix
// and by exact name.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots `next dev` against the
// repo's own `apps/web/.next` on a freshly chosen free port, and a second `next dev` sharing that
// directory corrupts the on-disk build cache for both. Stop any running dev server first
// (`pgrep -af "next dev"`).
```

The scenario: TWO generated catalogs (one licensed, one with its `LICENSE` removed), ONE workspace with a repository and a board, and one daemon so stages 3 and 4 can watch the Supervisor actually decide. The catalog NAME is the generated directory's own basename, which the walk takes from `basename(dir)` — so the gate copies into `<mkdtemp>/catalog-m55/` exactly the way `gate-m42` does, and every `sourceId` it asserts on starts `catalog-m55/`.

The twelve stages, each with what it measures and the assertion that would fail:

1. **The whole catalog arrives in one command, and the summary IS the report.** `import-catalog --dir <generated> --by gate` with no `--verbose`: exit 0; the summary line reads `created 120, updated 0, unchanged 0, skipped 0`; **two** progress lines (`100/120`, `120/120`) and no third; the duplicates line reads `3 exact, 3 near, 3 overlapping`; **zero** `created  ` per-row lines in stdout — counted with a regex, because "the lines are gone" is a number and not an impression. One `CatalogImport` row whose four counters match and whose `report` JSON carries the same three duplicate counts. Then the same directory again under `--verbose`: 120 per-row lines, and `unchanged 120`. `list-imports` prints all seven numbers for the newest row.
2. **The same import again changes nothing.** A third run, no flags: `unchanged 120`, `created 0`. Every `SlaveTemplate` row's `sourceSha256`, `profileSha256`, `importedAt`, `contentSha256`, `bodyBands` and `searchText` are byte-identical to stage 1's snapshot — taken as a `JSON.stringify` per row and compared as strings. Every `TemplateDuplicate` row's `id` and `detectedAt` are unchanged: a re-import re-detects the same pairs and writes no new rows.
3. **Nothing that arrived is hirable.** All 120 rows read `active: false`. A workspace is created with a task declaring the ONE capability only the generated solo specialist provides (the manifest's `soloCapabilityLabel`, resolved to its key); a real daemon ticks; the Supervisor raises `capability_unstaffed` and **no `SupervisorDecision` and no proposal names any of the 120 template ids** — asserted over EVERY decision row's action payload, not only the latest. `buildSupervisorWorld` is called from the gate's own process and its `catalog` is asserted to contain none of them.
4. **`--activate` and the toggle each make exactly one row rankable.** `template activate --template <solo id>`: the row reads `active: true` with `activationChangedAt` and `activationChangedBy` set; the next tick proposes `hire_from_catalog` naming THAT template and no other. A second persona is activated through the Catalog tab's `catalog-activate-<id>` toggle in the browser and reaches the same state, with `data-active` moving from `false` to `true`. A fourth import run with `--activate` against a THIRD generated catalog creates its rows active, proving the flag on creation. `template deactivate` puts the solo one back, and the following tick proposes it no more.
5. **The three classes are detected, with the planted pairs and the right basis.** Exactly **nine** undismissed `TemplateDuplicate` rows whose both ends are under `catalog-m55/`: three `exact` (bases `content_hash`, `content_hash`, `name`), three `near` (basis `body_shingles`, every score at or above 0.8), three `overlapping` (basis `capability_keys`, every score at or above 0.6, names differing, and each pair's BODY Jaccard below 0.8 — which is WHY the class is `overlapping` and not `near`, recomputed in the gate from the two rows' stored specs). Every row satisfies `aId < bId`. No pair appears twice and no pair appears under two classes. Each planted pair is matched by SLUG against the generator's own manifest, so "nine pairs" and "the nine pairs we planted" are two assertions and not one.
6. **The near-misses are not signals, and a recompute agrees.** None of the three planted near-miss pairs has a row, in either order. `template duplicates --recompute` reports the same nine pairs, moves no `detectedAt`, creates no tenth and retires none; running it twice is a no-op, asserted by comparing the whole table's `JSON.stringify` before and after.
7. **A dismissal is a person's and it survives an import.** `template duplicates --dismiss <pairId>` stamps `dismissedAt`/`dismissedBy`; the row is still in the table (count unchanged); the Catalog chip for that template is gone in the browser and the `duplicates=none` facet now includes it. A further `import-catalog` run and a further `--recompute` both leave the dismissal exactly as it was. `--restore` puts the chip back.
8. **Nothing was deleted.** `SlaveTemplate` count before and after every import, recompute and dismissal in this gate is the baseline plus 120 (plus the third catalog's rows once stage 4 has run, counted separately by its own `sourceId` prefix); no row's `sourceId`, `name` or `profile` changed except through the update path stage 2 measured; the five seeded templates are untouched and still `active: true`.
9. **The Catalog tab pages, counts and filters — in the browser.** `/workforce?tab=catalog` shows 100 rows and `catalog-count` reads `showing 100 of <total> templates`; `catalog-more` loads the rest and the count becomes `<total> templates`; the division select, the capability select (whose `<option>` TEXT is a taxonomy label and whose `value` is a key — asserted as two different strings), the skill select, the source chips, the activation chips and `catalog-duplicates-select` each narrow the list and each writes its param into the URL; a reload of that URL renders the same row ids. `catalog-duplicates-select` on `exact` leaves exactly the six templates of the three exact pairs, and on `none` leaves the rest. A search for a word that appears only in a persona's SUMMARY finds it.
10. **Words, never keys.** No cell, chip, option or title added by this milestone prints `exact`, `near`, `overlapping`, `content_hash`, `name`, `body_shingles`, `capability_keys`, `true` or `false` as VISIBLE text anywhere on `/workforce?tab=catalog`, drawer open and drawer closed; `data-class`, `data-basis`, `data-score`, `data-active` and `title` carry them, asserted present. The duplicate chip's `title` contains the sentence about evidence being recorded per profile. And `profileKeyOf` is asserted FROM THE MODULE to be unchanged: `profileKeyOf({ slaveId: 's1', hiredFromTemplateId: 't1' }) === 'template:t1'` and `profileKeyOf({ slaveId: 's1', hiredFromTemplateId: null }) === 'slave:s1'`.
11. **A checkout with no licence is refused, and the Source group says what a licensed one is.** The generator writes a SECOND catalog with `--no-license`: `import-catalog` exits non-zero with the exact sentence `refusalText({ kind: 'license_unknown', directory })` produces, and **writes no `SlaveTemplate` row, no `CatalogImport` row and no `TemplateDuplicate` row** — all three counted before and after. The same command with `--allow-unknown-license` imports it, and its rows read `sourceLicense: null`. A LICENSED row's drawer shows `MIT` in the Source group. The page's HTML is then grepped for a sentence from a persona body, to prove the text came from the database at request time and is in no bundle: `curl` the page, find the sentence, then grep every file under `apps/web/.next/static` for it and find nothing.
12. **Nothing else moved.** `SITUATION_KINDS` is seventeen and `ACTION_KINDS` is seventeen, asserted from the modules; `LANE_BY_TYPE` is **61**, asserted from the module, which is the assertion that this milestone added no event; `SupervisorWorld` gained no field, asserted by comparing `Object.keys` of a loaded world against a literal list; `Actor`, `Task` and `Workspace` gained no column, asserted from `information_schema.columns`; and `git status --porcelain` after a green run is what it was before.

- [ ] **Step 3: Run the gate until it is green, and read its log**

```bash
pgrep -af "next dev"     # must be empty
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m55-catalog 2>&1 | tee /tmp/gate-m55.log; echo "exit ${PIPESTATUS[0]}"
```

Expected: exit 0 and the pass line. Then read the log for the four things a green gate can still hide:

```bash
grep -c 'rows —' /tmp/gate-m55.log                 # at least 2 -- the two progress lines of stage 1
grep -c '3 exact, 3 near, 3 overlapping' /tmp/gate-m55.log   # at least 2 -- stage 1 and stage 6
git status --porcelain                              # clean: the gate edits no file in this repo
ls ~/.local/state/slaveofai/runs 2>/dev/null | wc -l # unchanged across the run (M52 C1)
```

- [ ] **Step 4: The roster, CI and the README**

`package.json` gains `"gate:m55-catalog": "tsc --build && node --env-file=.env scripts/gate-m55-catalog.mjs"` after `gate:m54-triggers`. `.github/workflows/ci.yml` gains `- run: npm run gate:m55-catalog` after `gate:m54-triggers`. `README.md`: the roster sentence (`:882-890`) names `gate:m55-catalog` after `gate:m54-triggers`, the `m54` clause gains an `and m55` clause in the same register —

> and `m55` generates a hundred and twenty personas, imports the lot in one command, and shows that
> not one of them is hirable until somebody says so: the Supervisor raises a staffing gap and names
> none of them, a single `template activate` makes exactly one of them the answer, and a second one
> activated by a click in the browser reaches the same state. It plants three pairs that are the
> same persona, three that are nearly the same and three that claim the same work, plus three that
> are just under each threshold, and finds exactly the nine — with the reason beside each one, the
> score to three decimals, and nothing deleted by any of it

— and the count line, found with `grep -n '^[0-9]\+ gates\.' README.md` (it was `:971` before M54 Task 6 and `:978` after, so never address it by number), reads **30 gates**.

- [ ] **Step 5: The screenshots that do not change (erratum E12)**

`gate:m14-fidelity` photographs `/workforce` (`scripts/gate-m14-fidelity.mjs:777`, `path: () => '/workforce'`), and `/workforce`'s DEFAULT tab is **Slaves** (`apps/web/src/app/workforce/page.tsx:70`, `TAB_IDS.find((id) => id === tab) ?? 'slaves'`). Every surface this milestone touched is on the Catalog tab, which that photograph does not contain. So `workforce.png` is byte-identical, and so is every other PNG. Run it, and check every PNG back out:

```bash
pgrep -af "next dev"   # empty
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m14-fidelity
git status --porcelain docs/superpowers/fidelity/m14/
git checkout -- docs/superpowers/fidelity/m14/
```

**Read the `git status` line before checking out.** The known m14 PNG nondeterminism (carried backlog) can rewrite a file with no visual change, so a listed file is not by itself a failure — but `workforce.png` must be VISUALLY identical. If `git status` lists it, open it and compare against `git show HEAD:docs/superpowers/fidelity/m14/workforce.png`; a real difference means a surface Task 5 added is drawing on the Slaves tab, which is a defect to fix in that task's file rather than a picture to commit. **This milestone commits no screenshot**, and the task report says so explicitly.

- [ ] **Step 6: The full verification ladder**

One vitest at a time, no gate beside vitest, nothing beside a `web:build`.

```bash
npx tsc --build
npm run --silent typecheck
npx vitest run 2>&1 | tail -20
```

Expected: at or above the numbers Task 1 recorded, zero failures. Then the migration proof once more, because this is the last chance to catch a schema that drifted from its SQL across six tasks:

```bash
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```

Expected: "No difference detected". Then the build:

```bash
pgrep -af "next dev"   # empty
npm run web:build
```

Then every gate this milestone could have moved, one at a time, each with `CHROMIUM_PATH` / `SLAVEOFAI_CLAUDE_BIN` / `SLAVEOFAI_REQUIRE_FAKE_CLI` set and `pgrep -af "next dev"` empty before each:

```bash
npm run gate:m11-shell
npm run gate:m13-runtime
npm run gate:m14-fidelity
npm run gate:m16-chrome
npm run gate:m26-vocabulary
npm run gate:m29-simulation
npm run gate:m31b-software-sector
npm run gate:m33-adopt
npm run gate:m37-run-context
npm run gate:m38-supervisor
npm run gate:m41-scenario
npm run gate:m42-catalog-import
npm run gate:m44-ux-foundation
npm run gate:m45-project-experience
npm run gate:m46-workforce-catalog
npm run gate:m47-team-formation
npm run gate:m48-runbooks
npm run gate:m50-ephemeral
npm run gate:m53-evidence
npm run gate:m54-triggers
npm run gate:m55-catalog
```

Expected: all twenty-one green. Nine to watch, and what to do rather than edit them:

- **`gate:m42-catalog-import`** is THE gate this milestone changed most, and its stage 5 is the one to read closely: it builds a company from two INACTIVE templates and dispatches a real run, which is the whole proof that activation gates the Supervisor and nothing else. If that stage fails, `active` has leaked into `materialiseCompanySlave` or `hireFromTemplate`, and the fix is in `packages/control`, never in the gate.
- **`gate:m46-workforce-catalog`** is the gate that proves R3's rewrite kept the surface. Every stage except 2b must pass UNCHANGED; 2b moved for erratum E1's reason and for no other.
- **`gate:m47-team-formation`** and **`gate:m50-ephemeral`** each now pass `--activate`. If either fails with an empty candidate list, the flag did not reach `importRow`'s `create`.
- **`gate:m47-team-formation`**'s stage 6 also flakes on `recordDecision` committing before `applyDecision` (carried backlog) — re-run it ALONE before believing it.
- **`gate:m48-runbooks`** is UNCHANGED and is re-run as an assertion: `catalog-m48` has a `LICENSE`, nothing in it hires from the catalog, and it exercises the persona-runbook post-pass that now runs beside a fourth one.
- **`gate:m53-evidence`** got one `active: true` (erratum E10). If a ranking stage moves anyway, a catalog candidate this gate never asserted on was load-bearing after all, and the task report must say which.
- **`gate:m11-shell`** creates a template through the New template form and waits for a `data-table-row` carrying its name — the Catalog tab's columns changed, and this is the gate that would notice if the primitive did.
- **`gate:m14-fidelity`** is Step 5's, run again here and checked out again.
- **`gate:m41-scenario`** runs the whole story end to end and is the broadest thing that could notice a changed catalog read.

Record every gate's exit code and its wall time in the task report, and re-run any single failure ALONE before believing it — the daemon CLI test's row counts double when anything else touches the database, and a gate is the heaviest anything.

- [ ] **Step 7: Commit — two of them, in this order**

The code, then the documents, so a spec diff never hides a code change. **There is no screenshot commit** (erratum E12).

```bash
git add scripts package.json .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
feat(gate): m55 t6 — a hundred and twenty strangers, imported in one command and hirable by none

`gate:m55-catalog` generates its own catalog rather than checking one in:
`scripts/gate-fakes/gen-catalog.mjs` is the seventh fake and the first that WRITES, and one seed
gives one set of bytes on every machine. A hundred and twenty personas is more than any fixture in
this tree and far less than a real catalog -- two full pages at a page size of a hundred, two
progress lines from the importer, and small enough that a failing stage prints a dump somebody can
read.

Nine pairs are planted and nine are found: three that are the same persona (one byte-identical under
another division, one identical only after case and whitespace and NFC, one whose names differ only
in case), three that are nearly the same, and three that claim four of the same five capabilities.
Three more sit just under each threshold and produce nothing. The basis is asserted on every one,
`aId < bId` on every one, and the body Jaccard of each overlapping pair is recomputed in the gate to
prove it is under the near threshold -- which is WHY that class is the class it is.

Nothing that arrives is hirable. A real daemon raises a staffing gap and names none of the hundred
and twenty; one `template activate` makes exactly one of them the answer; a second, activated by a
click in the browser, reaches the same state; `--activate` on a third import creates its rows active.
A catalog with no LICENSE is refused before a row is read, with all three tables counted either side.
A dismissal survives an import and a recompute, and nothing in the gate ever deletes anything.

CI's 30th gate. No screenshot moved: `gate:m14-fidelity` photographs `/workforce`'s default tab,
which is Slaves, and everything this milestone drew is on Catalog.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"

git add docs/superpowers/specs/2026-09-13-m55-catalog-import-design.md docs/superpowers/plans/2026-09-13-m55-catalog-import.md
git commit -m "$(cat <<'EOF'
docs(spec): m55 — the design, the plan, and the errata execution wrote back into section 5

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

(`docs/ia.md` is committed in Task 5's `git add` and should already be in.)

---

## Self-review

**1. Spec coverage.**

| Spec | Where it lands |
|---|---|
| R1 `contentSha256` over the normalised canonical persona, not the file and not the render | Task 1 Steps 1–4 (`canonicalPersonaText` excluding `runtimeRole` and `source`, `normalisePersona`'s three passes, `contentHashOf`, and the case asserting two catalogs on two days hash equal); Task 2 Step 7 (`derivedColumnsOf` writes it from UPSTREAM); Task 6 stage 5. **`sourceId`, `sourceSha256`, `profileSha256` and `goalSha256` are unchanged** — no task renames one, and `gate:m42`'s stage 1 asserts `profileSha256` exactly as it did. **Not unique**: the schema says so and stage 5 measures two rows carrying the same hash |
| R2 never active by default: a column, the loader's WHERE, one verb, no event | Task 1 Step 11 (the column, its default, `@@index([active, name])`) and Step 12 (the backfill UPDATE) and Step 13 (the seed); Task 2 Steps 1–4 (`setTemplateActivation`, `createTemplate`, `loadCatalogEntries`, the rewritten `CATALOG_ENTRIES_MAX` docstring); Task 4 Step 2 (the CLI verbs); Task 5 Step 5 (the toggle); Task 6 stages 3, 4 and 12. **`formTeam` and `rankCandidates` are in no file list**; **`CompanySlave`/`Slave` are untouched**, proved by `gate:m42` stage 5 being given no activation step; **no event**, proved by stage 12's `LANE_BY_TYPE` of 61 and by two integration cases counting `ExecutionEvent` across a toggle |
| R3 the read filters and pages in the database, and the five facets survive | Task 1 Steps 5–8 (`catalogSearchText`); Task 2 Steps 5–8 (`catalogWhere`'s seven clauses, the cursor, `total`, the three facet queries, the scoped `rawOverride`) and Step 9 (`writeOverrides`' two columns) and Step 10 (`listTemplates`' own bound); Task 5 Steps 1–2 (seven URL params, the debounce) and Step 5 (the count sentence, `Show more`); Task 6 stage 9. **`CATALOG_ENTRIES_MAX` stays 500** with a rewritten docstring, and the 501st ACTIVE row is section 6's carried item |
| R4 three classes, three thresholds, six pure functions, a bound on every loop | Task 1 Steps 1–4 (all of it, with the multiplier bound proved as arithmetic); Task 3 Steps 2–5 (`DUPLICATE_SCAN_MAX`, `DUPLICATE_CANDIDATES_MAX`, `DUPLICATE_SPECS_MAX`, the four inverted indexes, the batched spec reads); Task 6 stages 5 and 6. **No fourth class** (`DUPLICATE_CLASSES` is three and a case asserts it); **no overall score**; **`profileOverrides` is not read** by `contentHashOf` or `bodyBandsOf`, proved by a case in Task 2 Step 9 |
| R5 one row per ordered pair, a dismissal is a stamp, nothing is deleted | Task 1 Step 11 (the model, `@@unique([aId,bId])`, `@@index([bId])`, the cascade, the two back-relations) and Step 3 (`orderedPair`); Task 3 Steps 2–5 (`writePair`, `setTemplateDuplicateDismissal`, the recompute's retirement); Task 6 stages 5, 7 and 8. **No CHECK constraint** — the diff proof is why, and it is stated in the migration and in the schema; **`deleteSlaveTemplate` is in no file list**; **the importer never dismisses**, asserted by a case and by stage 7 |
| R6 the signal is shown where the row is, in words, raw one attribute away | Task 1 Step 3 (the three label tables); Task 2 Step 7 (`CatalogRowDuplicate` and the top-pair query); Task 3 Step 4 (`listTemplateDuplicates`); Task 5 Steps 3–5 (the chip, the toggle, the two filter controls, the fourteenth drawer group, the three routes); Task 6 stages 9 and 10. **No duplicate marker outside the Workforce Catalog** — no task touches a worker, task or Organization surface; **no bulk dismiss** — the dismissal route takes one `pairId` |
| R7 batches, counts by outcome and by class, one line per row only when asked | Task 3 Steps 6–8 (`IMPORT_BATCH_SIZE`, `onProgress`, the chunked post-passes, the fourth post-pass, the widened report, `CatalogImportView.duplicates`); Task 4 Steps 2–3 (`describeImport(report, verbose)`, the progress printer, `list-imports`' seven numbers); Task 5 Step 5 (the panel's three columns); Task 6 stage 1. **One transaction per ROW** — `importRow` is not restructured, and the batch loop is around the reporting call and nothing else; **no resume token**, because M42 R2 makes a re-run free |
| R8 attribution is M46's, and an unlicensed checkout is refused | Task 3 Step 1 (the kind in three homes) and Step 7 (the refusal in `catalog_empty`'s position); Task 4 Steps 2–3 (`--allow-unknown-license` and its usage sentence); Task 6 stage 11. **No THIRD_PARTY notice** — no task creates one, and §4's reason is that nothing ships; **`sourceLicense` stays nullable**; **no licence TEXT is read or judged** — `licenseOf` (`apps/orchestrator/src/catalog.ts:105-124`) is in no task's file list |
| R9 evidence keying is untouched, and the chip says why that matters | Nothing changes it: `packages/domain/src/evidence/derive.ts` is in NO task's file list. Task 5 Step 5 puts the sentence in the chip's `title`; Task 6 stage 10 asserts both the sentence and `profileKeyOf`'s two answers from the module. **No merged reading** — section 6, item 9 |
| R10 one CLI command with four subcommands, and the web does what a page can | Task 4 Steps 2–3 (`template list|activate|deactivate|duplicates`, `--recompute` as the backfill, the usage text); Task 3 Step 4 (`recomputeTemplateDuplicates` does NOT touch `capabilityKeys`, asserted); Task 5 Steps 3–5 (the toggle and the dismissal, both single-row, both idempotent). **No web import form, no web recompute button, no bulk activate** — Task 5's file list contains no such route and no such control |
| R11 the Supervisor's machinery is not touched, and the residual is named | No task's file list contains `packages/domain/src/supervisor/*`, `packages/control/src/supervisor.ts`, `team.ts` or `rank.ts`; `packages/control/src/supervisorWorld.ts` appears once, for one `where` clause and one docstring. Task 6 stage 12 asserts seventeen, seventeen, 61 and an unchanged `SupervisorWorld` shape. **The residual** — a pending decision approved after a deactivation still hires — is section 6, item 2, and no task adds an `active` check inside `hireFromTemplate` |
| R12 the five gates that import a catalog, one by one | Task 4 Step 5: m42 takes (a)–(e) by name and line; m47 and m50 each gain `--activate`; m46 changes ONE constant and ONE step (erratum E1, which corrects R12(d)); m48 is untouched and re-run, which Task 6's ladder states as an assertion; `seed.ts` writes `active: true` (Task 1 Step 13) and does NOT gain a TRUNCATE entry (erratum E4). **m53 is added to the list** (erratum E10), which R12 missed |
| §3 the gate, the seventh fake, README 29→30, CI after m54, the moved pins | Task 6 Steps 1–5, twelve stages enumerated with their assertions; the moved pins are named in the tasks that move them (Task 3 Step 1's 22→23, Task 3 Step 9's sixth expect, Task 4 Step 5's five gates, Task 5 Step 4's two component-test fixtures); the screenshots are RUN and checked out rather than committed, with the reason and the failure mode stated (erratum E12) |
| §2 surfaces after M55 | Every module, column, enum, verb, route, testid and file listed there appears in a task's **Interfaces → Produces**: the two domain modules in Task 1 with the seven columns, one model and two enums; the activation verb, the paged read and the four derived columns in Task 2; the detector, the fourth post-pass and the two refusals in Task 3; the CLI in Task 4; the four routes, the three components and `docs/ia.md` in Task 5; the gate and the seventh fake in Task 6. **Supervisor: NOTHING**, and the file lists are how that is enforced |
| §4 out of scope | No network fetch (no task adds a `fetch` to `packages/control` or to `apps/orchestrator/src/catalog.ts`); no persona vendored (`gen-catalog.mjs` writes into a `mkdtemp`); no merge and no "delete the loser" (the dismissal route takes a `pairId` and calls one verb, and `deleteSlaveTemplate` is in no file list); no merged evidence reading; no auto-activation (nothing writes `active` except `createTemplate`, `setTemplateActivation`, `importRow`'s create and the migration); no fourth class; no structured-field similarity and no embedding; no full-text or trigram index (the migration's indexes are enumerated); no skills or tools imported from front matter; no colours or emoji; no summarising of an over-long persona (`personaToTemplate` is untouched); no web import form, recompute button or bulk activate; no budget charged (`spend.ts` and `stats.ts` are in no file list); **no new event type** |

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no "write tests for the above". Three places name the exact file to copy a shape from instead of reprinting it, and each states what it must produce: Task 6 Step 2's gate (twelve stages with their assertions, the scaffolding named function by function from `gate-m53-evidence.mjs`, and the two things the implementer may not improvise past — the catalog's directory name, which IS its catalog name, and the manifest the generator prints so the gate never re-derives what it planted); Task 3 Step 6's "grep `importCatalog(` and add `license: 'MIT'`", which names the command, the file and the exact edit; and Task 5 Step 4's "`workforce-catalog.test.tsx` moves in exactly two ways", which enumerates both. Six steps deliberately end in a CHECK rather than an edit — Task 1 Step 12's `prisma validate` before the migration is written, Task 1 Step 14's baseline recording, Task 3 Step 10's refusal grep, Task 6 Step 1's "run the generator twice and `diff -r`", Task 6 Step 3's log read, and Task 6 Step 5's "read the `git status` line and open the PNG" — because each is a fact about the tree a plan should verify rather than assert.

**3. Type consistency.** `DuplicateClass`, `DuplicateBasis`, `DuplicateFacet`, `DUPLICATE_CLASSES`, `DUPLICATE_BASES`, `DUPLICATE_FACETS`, the three label tables, the seven constants, `MINHASH_MULTIPLIERS`, `canonicalPersonaText`, `normalisePersona`, `contentHashOf`, `shinglesOf`, `minhashOf`, `bandKeysOf`, `bodyBandsOf`, `jaccard`, `orderedPair`, `DuplicateCandidate`, `DuplicateVerdict`, `classifyPair`, `DuplicateCounts`, `emptyDuplicateCounts`, `duplicateCountsSchema`, `parseDuplicateCounts`, `SEARCH_TEXT_MAX_CHARS` and `catalogSearchText` are spelt ONCE (Task 1 Steps 3 and 7) and consumed under those names in Task 2 (`derivedColumnsOf`, `catalogWhere`), Task 3 (`classifyAll`, `writePair`, `listTemplateDuplicates`), Task 4 (the CLI's label lookups and its two `oneOfFlag` vocabularies) and Task 5 (the chip, the two selects, the drawer group). `DuplicateCounts` is the single shape FOUR producers and three consumers agree on: `writeTemplateDuplicates` and `recomputeTemplateDuplicates` return one, `ImportReport.duplicates` and `CatalogImportView.duplicates` carry one, `parseDuplicateCounts` reconstructs one from a `Json` column, and `describeImport`, `list-imports` and `CatalogImports.tsx` each read the same three keys — so a fourth class is a build error in seven places rather than a silent `undefined` in one. `CatalogRowDuplicate` has one definition (Task 2 Step 7) and three consumers (the chip, its `title`, and `template list`'s signal column), and nothing constructs one by hand. `TemplateDuplicateView` has one definition (Task 3 Step 4) and two consumers, one of which (`TemplateDuplicateRowView`, Task 5 Step 3) is an `Omit`-and-restate of its two `Date`s — the `CatalogRowView` idiom, so a field added to the control type arrives in the web type for free. `DuplicateScanResult` is returned by both passes and `recomputeTemplateDuplicates` widens it with `backfilled` rather than declaring a second shape. The one asymmetry, named: `WorkforceCatalogFilters.active` is a `boolean | undefined` while the URL carries `active`/`inactive`/absent — three states either way, and `catalogFilterParams`/`parseCatalogFilters` are the one place the two spellings meet, with a round-trip case pinning them.

**What the self-review pass FIXED, inline.** Four gaps, all now closed. **(a)** Task 2's `listWorkforceCatalog` originally kept the existing whole-table `rawOverride` raw query, which would have read the `profile` column of every row in the catalog to render a hundred of them — the exact cost R3 exists to remove, left in place by an edit that only looked at the `findMany` above it. It is now scoped with `id = ANY(...)` over the page's ids, and both id-scoped reads are skipped entirely when the page is empty. **(b)** Task 2 Step 10's `listTemplates` was first written as `listWorkforceCatalogPage({}, {})`, which would have silently taken `CATALOG_PAGE_SIZE` and hidden the hundred-and-first template from every company picker; erratum E2 was written from that discovery, and the function now calls the control verb directly with `TEMPLATE_PICKER_MAX` and maps the two dates itself. **(c)** Task 3's candidate search was first written as banding alone, which is what R4's prose emphasises — and banding cannot find an `exact` pair whose two rows share the same NAME and no shingle, nor an `overlapping` pair, which by definition shares no text. Four inverted indexes replaced it, filled strongest-first so a crowded capability bucket cannot spend the whole `DUPLICATE_CANDIDATES_MAX` budget, and the three arms that are not `near` now have candidates to be found in. **(d)** Task 4's `template list` first called `listWorkforceCatalog()` with no options, which would have printed the first hundred templates under a header claiming to be the catalog; it passes `TEMPLATE_PICKER_MAX` and prints `N of M` so a truncated list says it is one. Nothing else moved: the spec-coverage walk found a task for every R-section and every one of the twelve gate stages, and the placeholder scan found nothing to remove.
