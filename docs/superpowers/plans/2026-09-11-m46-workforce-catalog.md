# M46 Rich Specialist Profile + Workforce Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A template stops being a name, a role and a wall of Markdown: it becomes a SPECIALIST PROFILE with thirteen named fields and a source record, mapped out of the persona file it was imported from, customisable field by field without losing what the next import brings, and browsable in a Workforce Catalog that can be searched, filtered, inspected and safely updated — with the raw Markdown demoted to Advanced.

**Architecture:** Two JSON columns on `SlaveTemplate` (`profileSpec`, UPSTREAM and importer-owned; `profileOverrides`, LOCAL and operator-owned) and one pure renderer. `effectiveProfileSpec(spec, overrides)` merges field by field; `renderProfileSpec(effective)` produces the Markdown that the existing `profile` column holds and the existing run-context builder already renders, truncated whole section by whole section so it never exceeds `PROFILE_MAX_CHARS`. Nothing downstream of `profile` changes: `effectiveProfile`'s slave → company → template chain, the `WHO YOU ARE` block and the manifest's `{ kind: 'profile', origin, sha256 }` are untouched. M42's importer gains three writes (`profileSpec`, `sourceRevision`, `sourceLicense`) and one re-render; its per-row policy is byte-for-byte the policy it already had, and its `locally_edited` skip now means exactly one thing — a raw Markdown override. The web replaces the Catalog tab's template table with `WorkforceCatalog` + `ProfileDrawer` on M44's `Drawer`/`DetailsGroup`/`Tabs`/`Alert`/`EmptyState`, keeping the hand-made template form and the company manager where they are.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), zod, vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-11-m46-workforce-catalog-design.md` (rulings R1–R7; §4 errata). Its parents are `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` (row M46), `docs/ia.md` (`/workforce` → "M46 rebuilds Catalog around structured profiles"), `docs/superpowers/specs/2026-09-10-m42-catalog-import-design.md` (the importer this extends, errata E1–E24) and M44/M45's specs for the primitives and page conventions. **M47 owns the capability taxonomy and the normalisation of collaboration hints into relationships and must not be pre-built here.**

Plan-time errata, every one read out of the code and baked into the tasks below. The long form, with file and line evidence, is in the session notes (`m46-plan-notes.md`); each is also to be appended to the spec's §4 during execution.

- **E1 (amends R1) — the spec has a fourteenth field, `body`, and without it the milestone is a regression.** R1's field list drops the persona's own prose, but R3 says in passing that `Communication Style` and `Learning & Memory` "stay in the Markdown body", and today `SlaveTemplate.profile` IS that body verbatim (`personaToTemplate`: prefix + `draft.body`). A `mappingQuality: 'none'` persona mapped into R1's thirteen fields would reach a run as two lines. `ProfileSpec` therefore carries `body: string` — the persona body exactly as M42 stored it — and `renderProfileSpec` emits it LAST, which also makes it the first section truncation drops. Two things fall out for free: `packages/control/test/integration/catalog.test.ts`'s `expect(row.profile).toContain('AND its documentation')` and `gate:m42-catalog-import`'s "a sentence of the persona's body reaches the prompt" both stay green with no edit.
- **E2 (amends R1) — the truncation priority list is thirteen entries, not eleven.** R1 names identity, mission, constraints, operatingPrinciples, capabilities, expertise, workflow, deliverables, successCriteria, collaborationHints, skills. `summary` is missing (one line, and the row's own subtitle) and `body` is missing (E1). `PROFILE_SECTION_PRIORITY` puts `summary` second, after `identity`, and `body` last. The order is KEEP-priority: truncation drops from the end.
- **E3 (amends R1) — `runtimeRole` is never rendered into the Markdown.** It is the template's `role` — a *suggested* role, catalog metadata (spec §Goal: "kept distinct from the RUNTIME ROLE the scheduler dispatches on"). `Slave.runtimeRoles` is the only thing `decide()` matches on, and a prompt that told a worker "your runtime role is engineering" when its `runtimeRoles` say otherwise would be a false statement in front of the model. It is in the spec, in the schema and in the drawer's Identity group; it is not in `renderProfileSpec`'s output.
- **E4 (amends R2/R5) — no marker column is needed, and the predicate already exists.** "This row has a raw Markdown override" is exactly `template.profile !== null && goalSha256(template.profile) !== template.profileSha256` — the same expression `importCatalog` already evaluates to decide `locally_edited` (`packages/control/src/catalog.ts`, the `storedSha` branch). It works because `setProfileOverrides` re-renders `profile` AND rewrites `profileSha256`, while `setProfile({ templateId })` writes `profile` and deliberately records nothing (M42 E2). The read model computes `rawOverride` from it; the migration adds no marker.
- **E5 (amends E4) — `rawOverride` is only meaningful where a spec exists.** A hand-made template has `profileSha256 = null` and may well have a `profile`, so the predicate is true for every hand-written template with a persona. `rawOverride` is therefore computed as `profileSpec !== null && profile !== null && goalSha256(profile) !== profileSha256`; a row with no `profileSpec` has no upstream to override and shows no marker.
- **E6 (settles R2 vs. M42 R2f) — `profile_too_long` stays exactly where M42 put it.** `personaToTemplate` still measures the COMPOSED raw profile (prefix + body) against `PROFILE_MAX_CHARS` and still returns the `profile_too_long` skip, before any mapping happens. It protects the mapper from a 60 000-character file, it is the operator-facing sentence "this persona file is too long to import", and `gate:m42-catalog-import` stage 1 pins it (`scripts/fixtures/catalog-m42/engineering/oversize.md`). The renderer's section-priority truncation is a SECOND and independent guarantee — that the rendered Markdown fits even when every mapped section is full — not a replacement for the first.
- **E7 (amends R6) — the M42 import history stays a panel on the tab, not a group in the drawer.** `CatalogImport` rows are per-IMPORT-RUN, not per-template; `CatalogImports` renders the last ten runs and `apps/web/test/workforce-page.test.tsx` pins its `catalog-imports` testid, its per-cell counts and its empty sentence. Rendering that same global list inside every one of hundreds of drawers would be N copies of one list. The drawer's `Advanced ▾` holds the rendered Markdown and the raw-override editor; the tab's own `Advanced ▾` holds the `Catalog imports` panel, unchanged.
- **E8 (amends R6) — `DetailsGroupName` is a closed ten-member union and must be widened.** `apps/web/src/components/ui/DetailsGroup.tsx` declares `'run' | 'model' | 'profile' | 'skills' | 'messages' | 'context' | 'verification' | 'cost' | 'worktree' | 'events'`. R6 needs twelve groups; `skills` is reusable and eleven are new (`identity`, `mission`, `capabilities`, `expertise`, `principles`, `constraints`, `workflow`, `deliverables`, `success`, `collaboration`, `source`, plus `advanced`). The union is widened in Task 4; nothing existing changes.
- **E9 (settles R6's read model) — one read model, two entry points, facets computed before filtering.** `listWorkforceCatalog(filters?)` in `packages/control/src/catalog.ts` does one `findMany` + one `companySlave.groupBy`, parses `profileSpec`/`profileOverrides` per row and filters IN MEMORY, returning `{ rows, facets }` where the facets (divisions, capabilities, skills) are computed over ALL rows BEFORE filtering — otherwise a filter menu collapses to the one value already chosen. `apps/web/src/server/org.ts`'s `listTemplates()` becomes `(await listWorkforceCatalog()).rows`, so `CompanyManager`/`NewSlaveDrawer`'s `TemplateRow` prop is a subset of the catalog row and needs no second query.
- **E10 (amends §2) — the drawer needs a fourth route.** Rows carry a summary and up to a handful of chips; the full effective spec is ~3 KB per template and must not travel for hundreds of rows. `GET /api/org/templates/[templateId]/profile` returns `{ upstream, overrides, effective, markdown, rawOverride }` for the one row a drawer opened. The spec names three routes; this is the fourth, and `readTemplateProfile` behind it is also what the CLI's `show-profile` prints.
- **E11 (amends R6's filter idiom) — the catalog's URL filters use `window.history.replaceState`, NOT `router.replace`.** `apps/web/src/hooks/useUrlFilters.ts` uses `router.replace`, but `/workforce` is `export const dynamic = 'force-dynamic'` with eight loaders including `buildSkillsPage()`'s disk scan, and `WorkforceClient` already records exactly this reasoning for its `?tab=` writes. A keystroke in the search box must not re-run eight queries. `useCatalogFilters` is a new hook shaped like `useUrlFilters` with `replaceState` in place of `router.replace`, merging into the current query so `?tab=catalog` survives.
- **E12 (amends R6/R7) — `/workforce`'s screenshot is the Slaves tab, so nothing regenerates.** `scripts/gate-m14-fidelity.mjs`'s `PAGES` row is `{ name: 'workforce', path: () => '/workforce', testId: 'data-table' }` — the DEFAULT tab, which `WorkforceClient` resolves to `slaves`; the `SLAVES_COLUMNS` assertion at stage 2 reads that same table. No M46 change touches a screenshotted page, so `docs/superpowers/fidelity/m14/*.png` is NOT regenerated. Task 5 runs the gate anyway and proves the tree is clean afterwards (`office.png` is the one file that differs on every run — its canvas animates — and is reverted).
- **E13 (amends R6) — `gate:m11-shell` needs no repoint if the catalog keeps `DataTable`.** Stage 1 fills `template-form` on `/workforce?tab=catalog` and then waits for `page.getByTestId('data-table-row').filter({ hasText: TEMPLATE_NAME })` (`scripts/gate-m11-shell.mjs:337-345`). `WorkforceCatalog` therefore renders its rows with the existing `DataTable`/`Row` primitives and starts with no filter applied, and `TemplateForm` keeps every testid `TemplateCatalog` had (`template-form`, `template-name-input`, `template-role-input`, `template-description-input`, `template-default-provider-select`, `template-default-model-input`, `template-submit`, `template-error`, `template-delete`, `template-delete-confirm`). The Catalog tab's grid IS free to change: it is not screenshotted (E12).
- **E14 (amends §2) — the git revision is read in the ORCHESTRATOR walk, once per import, and never in the domain.** `packages/domain` imports no Node built-in at all, deliberately (`goal/version.ts` hand-rolls SHA-256 because `apps/web`'s client bundle imports the package). `readCatalogDirectory` gains `revision` and `license` on its `CatalogWalk`, read with `execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'])` inside a `try` (a directory that is not a work tree, and a work tree with no commit yet, both give `null`), and the CLI passes them into `importCatalog`.
- **E15 (settles R4's licence rule) — first non-empty line, `X License` → `X`.** `LICENSE`, then `LICENSE.md`, then `LICENSE.txt` at the catalog root; the first non-empty trimmed line; `/^(.{1,60}?)\s+Licen[cs]e$/i` → group 1 (`MIT License` → `MIT`), else the line itself when it is ≤ 60 characters, else `null`. Nothing else is read and no licence text is copied anywhere.
- **E16 (amends R7) — the M46 gate gets its OWN fixture catalog.** Adding personas to `scripts/fixtures/catalog-m42/` would break `gate:m42-catalog-import` stage 1, which asserts "creates two, skips three" with the three reasons. `scripts/fixtures/catalog-m46/` is new: `divisions.json`, a `LICENSE` whose first line is `MIT License`, and four personas — canonical (`full`), divergent (`partial`), collaboration-table (`partial`, with hints), and one with no `##` heading at all (`none`), all written in this project's vocabulary so `gate:m26-vocabulary` stays green.
- **E17 — three new refusal kinds, each with its three homes.** `profile_not_structured` (`{ templateId }`), `invalid_profile_overrides` (`{ detail }`) and `unknown_profile_field` (`{ field }`) go into `ControlRefusal`, into `refusalText`, and into `apps/web/test/refusal-status.test.ts`'s `ALL_KINDS` (a `Record<ControlRefusal['kind'], true>`, so a missing key fails the typecheck). `refusalStatus` derives 404 from the `_not_found` suffix alone, so all three are 409 with no code change.
- **E18 — `listTemplates()`'s integration test asserts with `toEqual` on whole objects.** `apps/web/test/integration/server-org.test.ts:606-666` compares full row literals, so every field added in Task 3 must be added there in the same task or the suite goes red.
- **E19 — the `Drawer` width is a whole Tailwind literal or it does not exist.** Tailwind v4 scans source text for arbitrary values; `width={`w-[${n}px]`}` generates no class. `ProfileDrawer` passes `width="w-[640px]"` written out in full, the way `AdoptDrawer` passes `w-[560px]`.
- **E20 — no product string may name the reference catalog** (M42 E5). Every fixture, comment, README line and default in this milestone says `catalog-m46` or "a directory of persona files".

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`; the browser gates use `scripts/gate-fakes/fake-claude.sh` through `SLAVEOFAI_CLAUDE_BIN`.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first.
- **No prettier.** There is no prettier config in this repository; match the surrounding file's style by hand.
- Inside `apps/web`, import siblings **without** a `.js` suffix (`../server/org`, not `../server/org.js`); `packages/*` keep the `.js` suffix.
- Read an exit code with `${PIPESTATUS[0]}`; never `cmd | tail; echo $?` — that reports `tail`'s status.
- After `npm run db:generate`, run `npx tsc --build` **before** any integration test: the generated client's types are what the test files compile against.
- **No product string names the reference catalog** (M42 E5). Every example is `catalog-m46` or a neutral path.
- The vocabulary word is **slave**, fixture personas included. `npm run gate:m26-vocabulary` after every task.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**, or Prisma commits that write.
- **Migrations are additive and applied to both databases** (`npm run db:migrate` and `npm run db:migrate:test`) with the Prisma 7 diff proof: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` → "No difference detected".
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Web tasks also run `npm run web:build` (subject to the `next dev` rule above) and, where a page changed, `npm run gate:m44-ux-foundation` as the browser check.
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`. Component tests are `*.test.tsx` under `apps/web/test/` with a `// @vitest-environment jsdom` first line.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/profile/spec.ts                    R1/E1/E2/E3: ProfileSpec, profileSpecSchema, profileOverridesSchema,
                                                       effectiveProfileSpec, renderProfileSpec, the label tables (new)
packages/domain/src/profile/index.ts                   ./spec.js (new)
packages/domain/src/index.ts                           + ./profile/index.js
packages/domain/src/catalog/spec.ts                    R3: personaToProfileSpec, the heading table (new)
packages/domain/src/catalog/index.ts                   + ./spec.js
packages/domain/test/profile/spec.test.ts              (new)
packages/domain/test/catalog/spec.test.ts              (new) -- three fixture personas + a headingless one

packages/db/prisma/schema.prisma                       R1/R4: profileSpec, profileOverrides, sourceRevision, sourceLicense
packages/db/prisma/migrations/20260911100000_m46_profile_spec/migration.sql  (new)

packages/control/src/catalog.ts                        R2/R4/R6/E9: importCatalog writes the spec + source columns and
                                                       re-renders; listWorkforceCatalog; readTemplateProfile
packages/control/src/profile.ts                        R2/R5: setProfileOverrides, clearProfileOverride
packages/control/src/refusal.ts                        E17: three kinds
packages/control/src/index.ts                          (re-exports are `export *`; nothing to add)
packages/control/test/integration/catalog.test.ts      + the spec/source/overrides cases
packages/control/test/integration/profile.test.ts      + setProfileOverrides / clearProfileOverride
apps/orchestrator/src/catalog.ts                       R4/E14: revision + licence on the walk
apps/orchestrator/src/cli.ts                           R4/§2: import-catalog passes them; show-profile
apps/orchestrator/test/catalog.test.ts                 + revision/licence cases
apps/orchestrator/test/integration/cli.test.ts         + show-profile cases

apps/web/src/server/org.ts                             E9/E18: listWorkforceCatalog, listTemplates, readTemplateProfile
apps/web/src/lib/catalogFilters.ts                     R6/E11: parseCatalogFilters, catalogFilterParams (new)
apps/web/src/hooks/useCatalogFilters.ts                E11 (new)
apps/web/src/app/api/org/catalog/route.ts              R6 (new)
apps/web/src/app/api/org/templates/[templateId]/profile/route.ts        E10 (new)
apps/web/src/app/api/org/templates/[templateId]/overrides/route.ts      R2 PATCH (new)
apps/web/src/app/api/org/templates/[templateId]/overrides/[field]/route.ts  R2 DELETE (new)
apps/web/test/integration/workforce-catalog.test.ts    (new)
apps/web/test/integration/server-org.test.ts           E18
apps/web/test/refusal-status.test.ts                   E17

apps/web/src/components/ui/DetailsGroup.tsx            E8: the widened union
apps/web/src/components/workforce/TemplateForm.tsx     E13 (new; the form + TemplateRow, moved)
apps/web/src/components/workforce/WorkforceCatalog.tsx R6 (new)
apps/web/src/components/workforce/CatalogFilterBar.tsx R6/E11 (new)
apps/web/src/components/workforce/ProfileDrawer.tsx    R6/E19 (new)
apps/web/src/components/workforce/WorkforceClient.tsx  R6/E7: the rebuilt Catalog tab
apps/web/src/components/TemplateCatalog.tsx            deleted
apps/web/src/components/{CompanyManager,company/CompanyDetail,company/TeamBlock,slaves/NewSlaveDrawer}.tsx  import path only
apps/web/src/app/workforce/page.tsx                    E9: one catalog query
apps/web/test/workforce-catalog.test.tsx               (new; absorbs settings-page.test.tsx's TemplateCatalog block)
apps/web/test/workforce-page.test.tsx                  updated
apps/web/test/settings-page.test.tsx                   the TemplateCatalog describe removed

scripts/fixtures/catalog-m46/                          E16 (new): divisions.json, LICENSE, four personas
scripts/gate-m46-workforce-catalog.mjs                 R7 (new)
package.json, .github/workflows/ci.yml, README.md      R7
docs/ia.md                                             the Catalog row now says what it is
```

---

### Task 1: The structured profile, its renderer and the persona mapper (R1/R3/R4, E1–E3, E6)

**Files:**
- Create: `packages/domain/src/profile/spec.ts`, `packages/domain/src/profile/index.ts`, `packages/domain/src/catalog/spec.ts`
- Modify: `packages/domain/src/index.ts`, `packages/domain/src/catalog/index.ts`, `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260911100000_m46_profile_spec/migration.sql`
- Test: `packages/domain/test/profile/spec.test.ts`, `packages/domain/test/catalog/spec.test.ts`

**Interfaces:**
- Consumes: `PROFILE_MAX_CHARS` and `importedProfilePrefix` (`packages/domain/src/run-context/profile.ts`, `src/catalog/persona.ts`); `PersonaDraft { name, description, body, meta }`; `goalSha256`; `zod`.
- Produces, for Tasks 2–5:
  - `type ProfileSpecField = 'identity' | 'summary' | 'mission' | 'runtimeRole' | 'capabilities' | 'expertise' | 'operatingPrinciples' | 'constraints' | 'workflow' | 'deliverables' | 'successCriteria' | 'collaborationHints' | 'recommendedSkills' | 'body'`
  - `interface ProfileSource { repository: string; path: string; revision: string | null; license: string | null; importedAt: string; mappingQuality: MappingQuality }`, `type MappingQuality = 'full' | 'partial' | 'none'`
  - `interface ProfileSpec` — the fourteen fields above plus `source: ProfileSource | null`
  - `type ProfileOverrides = { readonly [K in ProfileSpecField]?: ProfileSpec[K] }`
  - `profileSpecSchema: z.ZodType<ProfileSpec>`, `profileOverridesSchema: z.ZodType<ProfileOverrides>`
  - `PROFILE_SPEC_FIELDS: readonly ProfileSpecField[]`, `PROFILE_FIELD_LABEL: Record<ProfileSpecField, string>`, `PROFILE_FIELD_KIND: Record<ProfileSpecField, 'text' | 'list'>`, `PROFILE_SECTION_PRIORITY: readonly ProfileSpecField[]`, `MAPPING_QUALITY_LABEL: Record<MappingQuality, string>`
  - `emptyProfileSpec(): ProfileSpec`, `effectiveProfileSpec(spec: ProfileSpec | null, overrides: ProfileOverrides | null): ProfileSpec`, `renderProfileSpec(spec: ProfileSpec): string`, `overriddenFields(overrides: ProfileOverrides | null): readonly ProfileSpecField[]`, `profileSourceId(source: ProfileSource): string`
  - `personaToProfileSpec(draft: PersonaDraft, source: PersonaSourceFacts): ProfileSpec` with `interface PersonaSourceFacts { repository: string; path: string; revision: string | null; license: string | null; importedAt: Date; runtimeRole: string }`
  - Columns: `SlaveTemplate.profileSpec Json?`, `profileOverrides Json?`, `sourceRevision String?`, `sourceLicense String?`

- [ ] **Step 1: Write the failing test for the spec shape, the merge and the renderer**

Create `packages/domain/test/profile/spec.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  PROFILE_FIELD_KIND,
  PROFILE_FIELD_LABEL,
  PROFILE_MAX_CHARS,
  PROFILE_SECTION_PRIORITY,
  PROFILE_SPEC_FIELDS,
  effectiveProfileSpec,
  emptyProfileSpec,
  overriddenFields,
  profileOverridesSchema,
  profileSourceId,
  profileSpecSchema,
  renderProfileSpec,
  type ProfileSpec,
} from '../../src/index.js'

const source = {
  repository: 'catalog-m46',
  path: 'engineering/gate-canonical.md',
  revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
  license: 'MIT',
  importedAt: '2026-09-11T09:00:00.000Z',
  mappingQuality: 'full' as const,
}

const spec = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
  ...emptyProfileSpec(),
  identity: 'The slave that lays the load-bearing parts first.',
  summary: 'Builds the core module and the tests that hold it up.',
  mission: 'Put the parts everything else stands on in place, tested.',
  runtimeRole: 'engineering',
  capabilities: ['Design the module boundary', 'Write the test before the code'],
  expertise: ['Ten years of load-bearing code'],
  operatingPrinciples: ['Small commits, each one green'],
  constraints: ['You MUST never leave a red test behind'],
  workflow: ['Step 1: read the brief back', 'Step 2: write the failing test'],
  deliverables: ['A module and its tests'],
  successCriteria: ['Every commit green'],
  collaborationHints: ['Hand off to the Gate Verifier when the tests are green'],
  recommendedSkills: ['writing-plans'],
  body: '# Gate Core Builder\n\nYou write the module everything else stands on.',
  source,
  ...over,
})

describe('profileSpecSchema', () => {
  it('accepts a full spec and round-trips it through JSON', () => {
    const parsed = profileSpecSchema.safeParse(JSON.parse(JSON.stringify(spec())))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.source?.mappingQuality).toBe('full')
  })

  it('accepts a spec with no source at all -- a hand-made template has no upstream', () => {
    expect(profileSpecSchema.safeParse({ ...emptyProfileSpec(), source: null }).success).toBe(true)
  })

  it('refuses a list item over 240 characters and a list over 40 items', () => {
    expect(profileSpecSchema.safeParse(spec({ capabilities: ['x'.repeat(241)] })).success).toBe(false)
    expect(profileSpecSchema.safeParse(spec({ capabilities: Array.from({ length: 41 }, (_, i) => `c${String(i)}`) })).success).toBe(false)
  })

  it('refuses a mapping quality that is not one of the three', () => {
    expect(profileSpecSchema.safeParse(spec({ source: { ...source, mappingQuality: 'partly' as never } })).success).toBe(false)
  })
})

describe('profileOverridesSchema', () => {
  it('accepts a PARTIAL object holding only the fields an operator changed', () => {
    const parsed = profileOverridesSchema.safeParse({ constraints: ['You MUST ship behind a flag'] })
    expect(parsed.success).toBe(true)
  })

  it('accepts the empty object -- "nothing is overridden" is a real state', () => {
    expect(profileOverridesSchema.safeParse({}).success).toBe(true)
  })

  it('refuses a key that is not a profile field, and refuses `source`', () => {
    expect(profileOverridesSchema.safeParse({ nonsense: 'x' }).success).toBe(false)
    expect(profileOverridesSchema.safeParse({ source }).success).toBe(false)
  })
})

describe('effectiveProfileSpec', () => {
  it('returns the upstream spec untouched when nothing is overridden', () => {
    expect(effectiveProfileSpec(spec(), {})).toEqual(spec())
  })

  it('REPLACES an overridden list rather than merging into it', () => {
    const merged = effectiveProfileSpec(spec(), { capabilities: ['One capability only'] })
    expect(merged.capabilities).toEqual(['One capability only'])
    expect(merged.expertise).toEqual(['Ten years of load-bearing code'])
  })

  it('keeps the upstream source even when every other field is overridden', () => {
    const merged = effectiveProfileSpec(spec(), { identity: 'mine', summary: 'mine', body: 'mine' })
    expect(merged.source).toEqual(source)
    expect(merged.identity).toBe('mine')
  })

  it('treats a null upstream as the empty spec, so overrides alone still render', () => {
    const merged = effectiveProfileSpec(null, { mission: 'Only this' })
    expect(merged.mission).toBe('Only this')
    expect(merged.capabilities).toEqual([])
    expect(merged.source).toBeNull()
  })

  it('names the overridden fields in PROFILE_SPEC_FIELDS order', () => {
    expect(overriddenFields({ body: 'x', identity: 'y' })).toEqual(['identity', 'body'])
    expect(overriddenFields(null)).toEqual([])
  })
})

describe('renderProfileSpec', () => {
  it('opens with the imported prefix line and carries every section under its label', () => {
    const text = renderProfileSpec(spec())
    expect(text.startsWith('Imported from catalog-m46/engineering/gate-canonical on 2026-09-11;')).toBe(true)
    expect(text).toContain('## Capabilities\n- Design the module boundary')
    expect(text).toContain('## Constraints\n- You MUST never leave a red test behind')
    expect(text).toContain('## In their own words\n# Gate Core Builder')
  })

  it('never prints the suggested runtime role -- that is catalog metadata, not a claim to a model (E3)', () => {
    expect(renderProfileSpec(spec({ runtimeRole: 'wildcard-role' }))).not.toContain('wildcard-role')
  })

  it('writes no prefix line and no heading for a spec with no source and empty fields', () => {
    expect(renderProfileSpec({ ...emptyProfileSpec(), summary: 'Just a line.' })).toBe('## In one line\nJust a line.')
  })

  it('is byte-stable: the same spec renders the same text twice', () => {
    expect(renderProfileSpec(spec())).toBe(renderProfileSpec(spec()))
  })

  it('drops WHOLE sections from the end of the priority order until it fits the cap', () => {
    const huge = 'w'.repeat(240)
    const text = renderProfileSpec(
      spec({
        body: 'b'.repeat(PROFILE_MAX_CHARS),
        collaborationHints: Array.from({ length: 40 }, () => huge),
        recommendedSkills: Array.from({ length: 40 }, () => huge),
      }),
    )
    expect(text.length).toBeLessThanOrEqual(PROFILE_MAX_CHARS)
    // `body` is the LAST entry of the priority order, so it is the first thing to go.
    expect(text).not.toContain('## In their own words')
    // ...and identity, the FIRST entry, survives.
    expect(text).toContain('## Who you are')
  })

  it('hard-slices at the cap when the highest-priority section alone is too long', () => {
    const text = renderProfileSpec({ ...emptyProfileSpec(), identity: 'i'.repeat(PROFILE_MAX_CHARS + 500) })
    expect(text.length).toBe(PROFILE_MAX_CHARS)
  })
})

describe('the label tables', () => {
  it('names every field once, and the priority order is a permutation of the rendered fields', () => {
    expect(Object.keys(PROFILE_FIELD_LABEL).sort()).toEqual([...PROFILE_SPEC_FIELDS].sort())
    expect(Object.keys(PROFILE_FIELD_KIND).sort()).toEqual([...PROFILE_SPEC_FIELDS].sort())
    // `runtimeRole` is a field but not a rendered section (E3): the priority order is the other 13.
    expect([...PROFILE_SECTION_PRIORITY].sort()).toEqual([...PROFILE_SPEC_FIELDS].filter((f) => f !== 'runtimeRole').sort())
  })

  it('builds a source id from the repository and the path', () => {
    expect(profileSourceId(source)).toBe('catalog-m46/engineering/gate-canonical')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit packages/domain/test/profile/spec.test.ts`
Expected: FAIL — the module does not exist ("Failed to resolve import" / `profileSpecSchema is not exported`).

- [ ] **Step 3: Write `packages/domain/src/profile/spec.ts`**

```ts
import { z } from 'zod'
import { importedProfilePrefix } from '../catalog/persona.js'
import { PROFILE_MAX_CHARS } from '../run-context/profile.js'

/**
 * The SPECIALIST PROFILE (M46 R1): what a template says about the worker it makes, in fields
 * instead of one wall of Markdown.
 *
 * Two columns hold it and this file is the only thing that knows how they combine.
 * `SlaveTemplate.profileSpec` is UPSTREAM -- the importer writes it and re-writes it, and an
 * operator never edits it. `SlaveTemplate.profileOverrides` is LOCAL -- a PARTIAL object holding
 * only the fields an operator changed, which is what makes an override survive the next import:
 * the two live apart, so a new upstream spec cannot overwrite a field nobody upstream wrote.
 *
 * `SlaveTemplate.profile` -- the Markdown that actually reaches a prompt -- is DERIVED from the
 * two by {@link renderProfileSpec}, and is rewritten whenever either changes. Nothing downstream
 * of that column moved: `effectiveProfile`'s slave -> company -> template chain, the run
 * context's `WHO YOU ARE` block and its `{ kind: 'profile', origin, sha256 }` manifest entry are
 * exactly what M37 built.
 *
 * PURE, and it must stay that way: `packages/domain` is imported by `apps/web`'s CLIENT bundle,
 * so there is no `node:crypto`, no `node:fs` and no Prisma anywhere in this graph.
 */

/** A list item is a SHORT line, not a paragraph: 240 characters is a sentence and a half. */
export const PROFILE_SPEC_MAX_ITEM_CHARS = 240
/** Forty items is far past any persona in the reference corpus; it is a paste limit, not a design
 *  limit -- the same judgement `MAX_RUNTIME_ROLES` records. */
export const PROFILE_SPEC_MAX_ITEMS = 40

/** How much of a persona's structure the mapper actually recognised (R3). Never a score: three
 *  honest states, and `none` is a real answer that the catalog shows rather than hides. */
export type MappingQuality = 'full' | 'partial' | 'none'

/** docs/ia.md rule 3: no surface prints a bare enum member as its visible text. */
export const MAPPING_QUALITY_LABEL: Record<MappingQuality, string> = {
  full: 'mapped in full',
  partial: 'partly mapped',
  none: 'not mapped',
}

/** Where this profile came from (R4). Synthesised entirely by the importer -- no persona file in
 *  the reference corpus carries any of it. `importedAt` is an ISO string, not a `Date`: this
 *  object is stored as JSON and handed to a `'use client'` component. */
export interface ProfileSource {
  readonly repository: string
  readonly path: string
  readonly revision: string | null
  readonly license: string | null
  readonly importedAt: string
  readonly mappingQuality: MappingQuality
}

export interface ProfileSpec {
  readonly identity: string
  readonly summary: string
  readonly mission: string
  /** The role this template SUGGESTS, which is `SlaveTemplate.role`. Catalog metadata: the
   *  scheduler matches `Slave.runtimeRoles` and nothing else, so this is never rendered into a
   *  prompt (plan erratum E3). */
  readonly runtimeRole: string
  readonly capabilities: readonly string[]
  readonly expertise: readonly string[]
  readonly operatingPrinciples: readonly string[]
  readonly constraints: readonly string[]
  readonly workflow: readonly string[]
  readonly deliverables: readonly string[]
  readonly successCriteria: readonly string[]
  readonly collaborationHints: readonly string[]
  readonly recommendedSkills: readonly string[]
  /**
   * The persona's own remaining prose, verbatim (plan erratum E1).
   *
   * The mapper lifts a REPRESENTATIVE SUBSET of a persona's headings into the fields above; the
   * sections it does not know -- Communication Style, Learning & Memory, a decision framework, a
   * worked example -- are still the persona, and before this milestone they were the whole of
   * what reached the prompt. Dropping them would have made a `none`-quality persona a two-line
   * worker. It renders LAST and truncates FIRST.
   */
  readonly body: string
  readonly source: ProfileSource | null
}

export type ProfileSpecField = Exclude<keyof ProfileSpec, 'source'>

/** Every overridable field, in the order a drawer shows them. `source` is not here: provenance is
 *  a fact about where the text came from, and an operator who could edit it could make the
 *  catalog lie about its own history. */
export const PROFILE_SPEC_FIELDS: readonly ProfileSpecField[] = [
  'identity',
  'summary',
  'mission',
  'runtimeRole',
  'capabilities',
  'expertise',
  'operatingPrinciples',
  'constraints',
  'workflow',
  'deliverables',
  'successCriteria',
  'collaborationHints',
  'recommendedSkills',
  'body',
]

/** An exhaustive `Record`, so a fifteenth field cannot ship without someone deciding its copy
 *  (the `PROFILE_ORIGIN_TEXT` idiom, M44). */
export const PROFILE_FIELD_LABEL: Record<ProfileSpecField, string> = {
  identity: 'Who you are',
  summary: 'In one line',
  mission: 'Mission',
  runtimeRole: 'Suggested role',
  capabilities: 'Capabilities',
  expertise: 'Expertise',
  operatingPrinciples: 'Operating principles',
  constraints: 'Constraints',
  workflow: 'Workflow',
  deliverables: 'Deliverables',
  successCriteria: 'Success criteria',
  collaborationHints: 'Working with others',
  recommendedSkills: 'Recommended skills',
  body: 'In their own words',
}

/** Which editor a field gets, and which shape the schema enforces. */
export const PROFILE_FIELD_KIND: Record<ProfileSpecField, 'text' | 'list'> = {
  identity: 'text',
  summary: 'text',
  mission: 'text',
  runtimeRole: 'text',
  capabilities: 'list',
  expertise: 'list',
  operatingPrinciples: 'list',
  constraints: 'list',
  workflow: 'list',
  deliverables: 'list',
  successCriteria: 'list',
  collaborationHints: 'list',
  recommendedSkills: 'list',
  body: 'text',
}

/**
 * Render order AND keep-priority (R1, plan erratum E2): the renderer emits these in this order,
 * and when the result is over the cap it drops them from the END until it fits.
 *
 * The order is an argument about what a worker cannot do its job without. Who it is, in one line,
 * what it is for and what it must never do come first; the persona's own prose comes last because
 * it is the only section whose content is also, partly, in the sections above it. `runtimeRole`
 * is absent on purpose (E3).
 */
export const PROFILE_SECTION_PRIORITY: readonly ProfileSpecField[] = [
  'identity',
  'summary',
  'mission',
  'constraints',
  'operatingPrinciples',
  'capabilities',
  'expertise',
  'workflow',
  'deliverables',
  'successCriteria',
  'collaborationHints',
  'recommendedSkills',
  'body',
]

const shortText = z.string().max(PROFILE_SPEC_MAX_ITEM_CHARS)
const list = z.array(z.string().min(1).max(PROFILE_SPEC_MAX_ITEM_CHARS)).max(PROFILE_SPEC_MAX_ITEMS)

const profileSourceSchema: z.ZodType<ProfileSource> = z.object({
  repository: z.string().min(1),
  path: z.string().min(1),
  revision: z.string().nullable(),
  license: z.string().nullable(),
  importedAt: z.string().min(1),
  mappingQuality: z.enum(['full', 'partial', 'none']),
})

/**
 * Validates a stored `profileSpec` at READ, the `runContextManifestSchema` idiom -- a column that
 * is only ever written by this repository is still a column a person can edit with `psql`, and a
 * reader that trusted it would crash the catalog page instead of showing one unstructured row.
 * Strict on write, and `.strict()` on the object so a key nobody declared is a refusal rather than
 * silent data the next reader loses.
 */
export const profileSpecSchema: z.ZodType<ProfileSpec> = z
  .object({
    identity: shortText,
    summary: shortText,
    mission: shortText,
    runtimeRole: shortText,
    capabilities: list,
    expertise: list,
    operatingPrinciples: list,
    constraints: list,
    workflow: list,
    deliverables: list,
    successCriteria: list,
    collaborationHints: list,
    recommendedSkills: list,
    body: z.string().max(PROFILE_MAX_CHARS),
    source: profileSourceSchema.nullable(),
  })
  .strict()

export type ProfileOverrides = { readonly [K in ProfileSpecField]?: ProfileSpec[K] }

/** The operator's half: the SAME shape, every key optional, and `source` refused outright. */
export const profileOverridesSchema: z.ZodType<ProfileOverrides> = z
  .object({
    identity: shortText.optional(),
    summary: shortText.optional(),
    mission: shortText.optional(),
    runtimeRole: shortText.optional(),
    capabilities: list.optional(),
    expertise: list.optional(),
    operatingPrinciples: list.optional(),
    constraints: list.optional(),
    workflow: list.optional(),
    deliverables: list.optional(),
    successCriteria: list.optional(),
    collaborationHints: list.optional(),
    recommendedSkills: list.optional(),
    body: z.string().max(PROFILE_MAX_CHARS).optional(),
  })
  .strict()

export function emptyProfileSpec(): ProfileSpec {
  return {
    identity: '',
    summary: '',
    mission: '',
    runtimeRole: '',
    capabilities: [],
    expertise: [],
    operatingPrinciples: [],
    constraints: [],
    workflow: [],
    deliverables: [],
    successCriteria: [],
    collaborationHints: [],
    recommendedSkills: [],
    body: '',
    source: null,
  }
}

/** The `<catalog>/<division>/<slug>` M42 already writes to `SlaveTemplate.sourceId`, rebuilt from
 *  the two halves the source record keeps -- so the prefix line the renderer emits is the same
 *  sentence `personaToTemplate` wrote before this milestone. */
export function profileSourceId(source: ProfileSource): string {
  return `${source.repository}/${source.path.replace(/\.md$/i, '')}`
}

/** Which fields an operator has taken over, in `PROFILE_SPEC_FIELDS` order (never `Object.keys`
 *  order, which is insertion order and would make two equal states print differently). */
export function overriddenFields(overrides: ProfileOverrides | null): readonly ProfileSpecField[] {
  if (overrides === null) return []
  return PROFILE_SPEC_FIELDS.filter((field) => overrides[field] !== undefined)
}

/**
 * UPSTREAM + LOCAL = EFFECTIVE (R1).
 *
 * Field by field, and an overridden LIST REPLACES the upstream list rather than merging into it.
 * A merge would make "take that constraint away" impossible to express, which is the same reason
 * `setRuntimeRoles` replaces a role set instead of adding to it.
 */
export function effectiveProfileSpec(spec: ProfileSpec | null, overrides: ProfileOverrides | null): ProfileSpec {
  const base = spec ?? emptyProfileSpec()
  if (overrides === null) return base
  const merged: Record<string, unknown> = { ...base }
  for (const field of PROFILE_SPEC_FIELDS) {
    const value = overrides[field]
    if (value !== undefined) merged[field] = value
  }
  return merged as unknown as ProfileSpec
}

const SECTION_HEADING: Record<ProfileSpecField, string> = PROFILE_FIELD_LABEL

function sectionText(spec: ProfileSpec, field: ProfileSpecField): string | null {
  const value = spec[field]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : `## ${SECTION_HEADING[field]}\n${trimmed}`
  }
  const items = value.map((item) => item.trim()).filter((item) => item !== '')
  if (items.length === 0) return null
  return `## ${SECTION_HEADING[field]}\n${items.map((item) => `- ${item}`).join('\n')}`
}

function compose(spec: ProfileSpec, keep: ReadonlySet<ProfileSpecField>): string {
  const blocks: string[] = []
  if (spec.source !== null) {
    blocks.push(importedProfilePrefix(profileSourceId(spec.source), new Date(spec.source.importedAt)))
  }
  for (const field of PROFILE_SECTION_PRIORITY) {
    if (!keep.has(field)) continue
    const text = sectionText(spec, field)
    if (text !== null) blocks.push(text)
  }
  return blocks.join('\n\n')
}

/**
 * The Markdown a run is given, from the effective spec (R1).
 *
 * **Why it truncates by WHOLE SECTIONS and not by characters.** `PROFILE_MAX_CHARS` is enforced
 * twice -- `setProfile` refuses a longer write, and `buildRunContext` refuses to dispatch a run
 * whose stored profile exceeds it -- so a rendered profile over the cap is not a cosmetic problem,
 * it is a worker that cannot be dispatched. Slicing mid-sentence would put half a constraint in
 * front of a model, which is worse than not putting it there at all; dropping the lowest-priority
 * WHOLE section leaves every sentence that survives intact and true.
 *
 * The last resort is a hard slice, reached only when the single highest-priority section is
 * itself longer than the cap. It cannot happen for an imported persona (M42 refuses a file whose
 * composed profile is over the cap before the mapper ever runs, plan erratum E6); it can happen
 * for an operator who pastes 20 000 characters into one override, and the cap is not negotiable.
 */
export function renderProfileSpec(spec: ProfileSpec): string {
  for (let end = PROFILE_SECTION_PRIORITY.length; end > 0; end -= 1) {
    const text = compose(spec, new Set(PROFILE_SECTION_PRIORITY.slice(0, end)))
    if (text.length <= PROFILE_MAX_CHARS) return text
  }
  return compose(spec, new Set(PROFILE_SECTION_PRIORITY.slice(0, 1))).slice(0, PROFILE_MAX_CHARS)
}
```

Then `packages/domain/src/profile/index.ts`:

```ts
export * from './spec.js'
```

and add the line to `packages/domain/src/index.ts`, immediately after the `./catalog/index.js` export:

```ts
export * from './profile/index.js'
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run --project unit packages/domain/test/profile/spec.test.ts`
Expected: PASS, every case.

- [ ] **Step 5: Write the failing test for the mapper, against three real persona shapes**

Create `packages/domain/test/catalog/spec.test.ts`. The three fixture texts are written in this
project's vocabulary (a persona in the reference corpus says the other word; `gate:m26-vocabulary`
scans every tracked file) and reproduce the three shapes the corpus actually has: the canonical
nine-heading skeleton, a shorter differently-worded one, and one carrying an integration table.

```ts
import { describe, expect, it } from 'vitest'
import { parsePersona, personaToProfileSpec, type PersonaDraft } from '../../src/index.js'

const FACTS = {
  repository: 'catalog-m46',
  path: 'engineering/gate-canonical.md',
  revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
  license: 'MIT',
  importedAt: new Date('2026-09-11T09:00:00.000Z'),
  runtimeRole: 'engineering',
}

const draftOf = (text: string): PersonaDraft => {
  const parsed = parsePersona({ path: 'x.md', text })
  if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.error.kind}`)
  return parsed.value
}

// The canonical skeleton: nine "Your ..." headings, emoji in front of each, `###` groups inside
// Core Mission and Critical Rules, worked-example deliverables.
const CANONICAL = `---
name: Gate Core Builder
description: Builds the core module and the tests that hold it up.
color: blue
emoji: brick
vibe: Puts the load-bearing parts in first.
skills: writing-plans, systematic-debugging
---

# Gate Core Builder Personality

You are **Gate Core Builder**, the slave that writes the module everything else stands on. You
write its tests before you write it.

## 🧠 Your Identity & Memory
- **Role**: Load-bearing module and test specialist
- **Personality**: Patient, deletion-minded, allergic to a red test
- **Memory**: You remember which shortcuts cost the most later
- **Experience**: Ten years of code other people had to keep

## 🎯 Your Core Mission

Put the parts everything else stands on in place, tested, before anything is built on them.

### Design the module boundary
- Name the seam before writing either side of it
- Keep a module small enough to delete

### Write the test before the code
- A failing test first, every time

## 🚨 Your Critical Rules You Must Follow

### Green before anything
- You MUST never leave a red test behind
- You MUST NOT widen a boundary to make a test pass
- Prefer the design that is easier to delete later

## 📋 Your Technical Deliverables

### Module boundary note
### Test plan

## 🔄 Your Workflow Process
- Step 1: read the brief back in your own words
- Step 2: write the failing test
- Step 3: make it pass with the smallest change

## 💭 Your Communication Style
- Short messages, and the diff attached.

## 🧭 Your Learning & Memory
- You keep a note of every shortcut that cost something.

## 🎯 Your Success Metrics
- Every commit green
- No module larger than one screen

## 🚀 Your Advanced Capabilities
- Reading a failing build back to its first cause
`

// A shorter, differently-worded skeleton -- no "Your" prefix, no Identity & Memory, no Core
// Mission, and two sections the mapper does not know at all.
const DIVERGENT = `---
name: Gate Release Steward
description: Gets a change out and watches what it does.
vibe: Ships small, watches hard.
---

# Gate Release Steward

Performance-minded release slave who takes one change to production at a time.

## Identity & Role Definition

The slave who owns the last mile: the flag, the rollout and the rollback.

## Core Capabilities

* **Rollout planning**: flag design, staged exposure, the order of the steps
* **Rollback drills**: the undo path rehearsed before the change goes out

## Specialized Skills

* Reading a dashboard back to the change that moved it

## Tooling & Automation

Use whatever the project already has; do not add a tool for one rollout.

## Decision Framework

Use this slave when a change is risky enough to need a flag.

## Success Metrics

* No rollout without a rehearsed rollback
`

// The collaboration shape: an integration table naming other slaves by title, plus loose
// escalation phrasing in a rules section.
const COLLABORATOR = `---
name: Gate Verifier
description: Reads the work back and says whether it does what it claims.
vibe: Trusts nothing that has not run.
---

# Gate Verifier

You read work back and you run it.

## Critical Rules
- You MUST escalate to the Gate Release Steward before a second failing rollout
- A claim you have not seen run is a claim you have not checked

## 🤝 Integration with other slaves

| Working with | How you integrate |
|---|---|
| **Gate Core Builder** | They write the module and its tests; you run them against the brief. |
| **Gate Release Steward** | Pair with them on the rehearsal, then hand off the evidence. |

## Success Metrics
- Nothing is called done that has not run
`

// No heading at all: the honest floor.
const PLAIN = `---
name: Gate Note Taker
description: Writes down what happened.
---

# Gate Note Taker

You write down what happened, in the order it happened, and you do not decide what it meant.
`

describe('personaToProfileSpec', () => {
  it('maps the canonical skeleton into every field and calls the mapping full', () => {
    const spec = personaToProfileSpec(draftOf(CANONICAL), FACTS)

    expect(spec.source?.mappingQuality).toBe('full')
    expect(spec.identity).toContain('Load-bearing module and test specialist')
    expect(spec.summary).toBe('Builds the core module and the tests that hold it up.')
    expect(spec.mission).toBe('Put the parts everything else stands on in place, tested, before anything is built on them.')
    expect(spec.capabilities).toContain('Design the module boundary')
    expect(spec.capabilities).toContain('Write the test before the code')
    // "Advanced Capabilities" feeds the same field as "Core Mission"'s sub-headings.
    expect(spec.capabilities).toContain('Reading a failing build back to its first cause')
    expect(spec.expertise).toContain('Ten years of code other people had to keep')
    expect(spec.constraints).toEqual([
      'You MUST never leave a red test behind',
      'You MUST NOT widen a boundary to make a test pass',
    ])
    expect(spec.operatingPrinciples).toEqual(['Green before anything', 'Prefer the design that is easier to delete later'])
    expect(spec.deliverables).toEqual(['Module boundary note', 'Test plan'])
    expect(spec.workflow).toEqual([
      'Step 1: read the brief back in your own words',
      'Step 2: write the failing test',
      'Step 3: make it pass with the smallest change',
    ])
    expect(spec.successCriteria).toEqual(['Every commit green', 'No module larger than one screen'])
    // The ONLY source of recommended skills is the explicit front-matter key (R3): `tools:` names
    // base tools, not this catalog's skills, and is ignored.
    expect(spec.recommendedSkills).toEqual(['writing-plans', 'systematic-debugging'])
    expect(spec.runtimeRole).toBe('engineering')
    // Communication Style and Learning & Memory are not mapped -- they stay in the body (E1).
    expect(spec.body).toContain('## 💭 Your Communication Style')
    expect(spec.body).toContain('## 🧭 Your Learning & Memory')
  })

  it('records the whole source record, revision and licence included', () => {
    expect(personaToProfileSpec(draftOf(CANONICAL), FACTS).source).toEqual({
      repository: 'catalog-m46',
      path: 'engineering/gate-canonical.md',
      revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
      license: 'MIT',
      importedAt: '2026-09-11T09:00:00.000Z',
      mappingQuality: 'full',
    })
  })

  it('degrades to partial on a skeleton it only half recognises, and keeps the rest in the body', () => {
    const spec = personaToProfileSpec(draftOf(DIVERGENT), { ...FACTS, path: 'engineering/gate-divergent.md' })

    expect(spec.source?.mappingQuality).toBe('partial')
    expect(spec.identity).toBe('The slave who owns the last mile: the flag, the rollout and the rollback.')
    expect(spec.capabilities[0]).toContain('Rollout planning')
    expect(spec.capabilities).toContain('Reading a dashboard back to the change that moved it')
    expect(spec.successCriteria).toEqual(['No rollout without a rehearsed rollback'])
    expect(spec.mission).toBe('')
    expect(spec.deliverables).toEqual([])
    // The two sections it does not know are still the persona.
    expect(spec.body).toContain('## Tooling & Automation')
    expect(spec.body).toContain('## Decision Framework')
  })

  it('lifts an integration table and a loose escalation sentence into collaboration hints', () => {
    const spec = personaToProfileSpec(draftOf(COLLABORATOR), { ...FACTS, path: 'testing/gate-collaborator.md' })

    expect(spec.collaborationHints).toContain(
      'Gate Core Builder: They write the module and its tests; you run them against the brief.',
    )
    expect(spec.collaborationHints).toContain(
      'Gate Release Steward: Pair with them on the rehearsal, then hand off the evidence.',
    )
    expect(spec.collaborationHints).toContain(
      'You MUST escalate to the Gate Release Steward before a second failing rollout',
    )
    expect(spec.constraints).toContain('You MUST escalate to the Gate Release Steward before a second failing rollout')
    expect(spec.source?.mappingQuality).toBe('partial')
  })

  it('says none when it recognised nothing, and still carries the persona', () => {
    const spec = personaToProfileSpec(draftOf(PLAIN), { ...FACTS, path: 'testing/gate-plain.md' })

    expect(spec.source?.mappingQuality).toBe('none')
    expect(spec.summary).toBe('Writes down what happened.')
    expect(spec.identity).toBe('You write down what happened, in the order it happened, and you do not decide what it meant.')
    expect(spec.capabilities).toEqual([])
    expect(spec.body).toContain('# Gate Note Taker')
  })

  it('falls back through description then vibe for the summary', () => {
    const noDescription = draftOf(CANONICAL.replace('description: Builds the core module and the tests that hold it up.\n', ''))
    expect(personaToProfileSpec(noDescription, FACTS).summary).toBe(
      'You are **Gate Core Builder**, the slave that writes the module everything else stands on.',
    )
    const noProse = draftOf('---\nname: X\nvibe: One thing, well.\n---\n\n## Success Metrics\n- done\n')
    expect(personaToProfileSpec(noProse, FACTS).summary).toBe('One thing, well.')
  })

  it('trims every item to the schema limits so a mapped spec always validates', () => {
    const long = `---\nname: X\n---\n\n# X\n\n## Success Metrics\n${Array.from({ length: 60 }, (_, i) => `- ${String(i)} ${'m'.repeat(400)}`).join('\n')}\n`
    const spec = personaToProfileSpec(draftOf(long), FACTS)
    expect(spec.successCriteria).toHaveLength(40)
    expect(spec.successCriteria.every((item) => item.length <= 240)).toBe(true)
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run --project unit packages/domain/test/catalog/spec.test.ts`
Expected: FAIL — `personaToProfileSpec` is not exported.

- [ ] **Step 7: Write `packages/domain/src/catalog/spec.ts`**

```ts
import {
  PROFILE_SPEC_MAX_ITEMS,
  PROFILE_SPEC_MAX_ITEM_CHARS,
  emptyProfileSpec,
  type MappingQuality,
  type ProfileSpec,
} from '../profile/spec.js'
import type { PersonaDraft } from './persona.js'

/**
 * A persona file's headings, mapped into the specialist profile's fields (M46 R3).
 *
 * PURE and deliberately dumb: a heading table and a handful of line rules, no inference from a
 * persona's NAME and no model anywhere near it. Three quarters of the reference corpus shares one
 * nine-heading skeleton; a large minority uses a shorter, differently-worded one; a few use
 * neither. The table below covers the first two and `mappingQuality` says so honestly when it
 * covers neither -- `none` is a real answer the catalog shows rather than a failure it hides.
 *
 * What it does NOT do: resolve a collaboration hint's named slave to a template row (the wording
 * names a role TITLE, and matching titles across a catalog is M47's capability graph), and infer
 * a recommended skill from anything but an explicit `skills:` front-matter key.
 */

/** Where one recognised `##` section's lines go. */
type Slot =
  | 'identity_memory'
  | 'core_mission'
  | 'critical_rules'
  | 'deliverables'
  | 'workflow'
  | 'success_metrics'
  | 'capabilities'
  | 'expertise'
  | 'collaboration'

/** The nine slots `mappingQuality` counts. A persona that fills seven of them is a persona this
 *  mapper genuinely understood. */
const CANONICAL_SLOTS: readonly Slot[] = [
  'identity_memory',
  'core_mission',
  'critical_rules',
  'deliverables',
  'workflow',
  'success_metrics',
  'capabilities',
  'expertise',
  'collaboration',
]

/**
 * Heading text, normalised, to the slot it fills. Normalisation strips a leading run of anything
 * that is not a letter (every heading in the reference corpus may open with an emoji), strips a
 * leading `Your `, lowercases and collapses whitespace -- so `## 🎯 Your Success Metrics` and
 * `## Success Metrics` are the same heading, which is exactly the difference between the corpus's
 * two most common skeletons.
 */
const SLOT_BY_HEADING: Readonly<Record<string, Slot>> = {
  'identity & memory': 'identity_memory',
  'identity & role definition': 'identity_memory',
  'core mission': 'core_mission',
  mission: 'core_mission',
  'critical rules you must follow': 'critical_rules',
  'critical rules': 'critical_rules',
  'workflow process': 'workflow',
  workflow: 'workflow',
  process: 'workflow',
  'success metrics': 'success_metrics',
  'advanced capabilities': 'capabilities',
  'core capabilities': 'capabilities',
  'core competencies': 'capabilities',
  'specialized skills': 'capabilities',
  'domain expertise': 'expertise',
}

/** Headings recognised by SHAPE rather than by exact text: a division writes `Technical
 *  Deliverables`, the next writes `Architecture Deliverables`, and every catalog invents its own
 *  word for "who else you work with". */
function slotByShape(heading: string): Slot | null {
  if (heading.endsWith(' deliverables') || heading === 'deliverables') return 'deliverables'
  if (heading.startsWith('integration with') || heading.startsWith('working with')) return 'collaboration'
  if (heading.startsWith('collaboration')) return 'collaboration'
  return null
}

/** A sentence that names another worker and what to do about it (R3). Kept VERBATIM: M47
 *  normalises these into advisory relationships, and a hint this milestone reworded would be a
 *  hint M47 could no longer trace back to its persona. */
const HANDOFF = /\b(consult|pair with|hand off|hands off|handoff|escalate to|work with the)\b/i
/** R3's rule words. Case-insensitive: a rule written in ordinary case is still a rule. */
const RULE_WORDS = /\b(must|never|always|do not|don't)\b/i

function normaliseHeading(raw: string): string {
  return raw
    .replace(/^[^\p{L}]+/u, '')
    .replace(/^your\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** One item: bullet marker and bold wrapper stripped, whitespace collapsed, cut to the schema's
 *  length. A hard `slice` rather than an ellipsis, so the same input always renders the same
 *  bytes -- the gate asserts a stored profile is byte-equal to a re-render. */
function item(raw: string): string {
  return raw
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROFILE_SPEC_MAX_ITEM_CHARS)
}

function items(lines: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const value = item(line)
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length === PROFILE_SPEC_MAX_ITEMS) break
  }
  return out
}

function text(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, PROFILE_SPEC_MAX_ITEM_CHARS)
}

/** The first sentence of a paragraph -- `.` `?` `!` followed by a space or the end. */
function firstSentence(paragraph: string): string {
  const flat = paragraph.replace(/\s+/g, ' ').trim()
  const match = /^(.*?[.!?])(\s|$)/.exec(flat)
  return (match?.[1] ?? flat).trim()
}

interface Section {
  readonly heading: string
  readonly slot: Slot | null
  /** `###` sub-heading titles, in order. */
  readonly subHeadings: readonly string[]
  /** Bullet lines (`-`, `*`, `+`, `1.`), in order, marker included. */
  readonly bullets: readonly string[]
  /** `| a | b |` rows, header and separator dropped. */
  readonly tableRows: readonly (readonly string[])[]
  /** Everything that is none of the above. */
  readonly paragraphs: readonly string[]
}

function splitSections(body: string): { readonly lead: string; readonly sections: readonly Section[] } {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const leadLines: string[] = []
  const sections: {
    heading: string
    slot: Slot | null
    subHeadings: string[]
    bullets: string[]
    tableRows: string[][]
    paragraphs: string[]
  }[] = []
  let current: (typeof sections)[number] | null = null

  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line)
    if (h2 !== null) {
      const heading = normaliseHeading(h2[1] ?? '')
      current = {
        heading,
        slot: SLOT_BY_HEADING[heading] ?? slotByShape(heading),
        subHeadings: [],
        bullets: [],
        tableRows: [],
        paragraphs: [],
      }
      sections.push(current)
      continue
    }
    const target = current
    if (target === null) {
      // Everything before the first `##`, the H1 line dropped.
      if (!/^#\s+/.test(line)) leadLines.push(line)
      continue
    }
    const h3 = /^#{3,6}\s+(.*)$/.exec(line)
    if (h3 !== null) {
      target.subHeadings.push(text(h3[1] ?? ''))
      continue
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      target.bullets.push(line)
      continue
    }
    if (/^\s*\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
      // The `|---|---|` separator, and the header row that precedes it, are not data.
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
        target.tableRows.length = 0
        continue
      }
      target.tableRows.push(cells)
      continue
    }
    if (line.trim() !== '') target.paragraphs.push(line.trim())
  }

  return { lead: leadLines.join('\n').trim(), sections }
}

function sectionsFor(sections: readonly Section[], slot: Slot): readonly Section[] {
  return sections.filter((section) => section.slot === slot)
}

/** `- **Role**: something` -> `something`, for the labels R3 names. */
function labelled(bullets: readonly string[], labels: readonly string[]): string[] {
  const out: string[] = []
  for (const bullet of bullets) {
    const match = /^\s*(?:[-*+]|\d+\.)\s+\*{0,2}([A-Za-z][A-Za-z ]*?)\*{0,2}\s*:\s*(.+)$/.exec(bullet)
    if (match === null) continue
    const label = (match[1] ?? '').trim().toLowerCase()
    if (!labels.includes(label)) continue
    out.push((match[2] ?? '').trim())
  }
  return out
}

export interface PersonaSourceFacts {
  readonly repository: string
  readonly path: string
  readonly revision: string | null
  readonly license: string | null
  readonly importedAt: Date
  /** `SlaveTemplate.role` -- the division, or its `--role-map` translation. A SUGGESTION on the
   *  profile; the scheduler still matches `Slave.runtimeRoles` and nothing else. */
  readonly runtimeRole: string
}

export function personaToProfileSpec(draft: PersonaDraft, facts: PersonaSourceFacts): ProfileSpec {
  const { lead, sections } = splitSections(draft.body)
  const filled = new Set<Slot>()
  for (const section of sections) if (section.slot !== null) filled.add(section.slot)

  const identityMemory = sectionsFor(sections, 'identity_memory')
  const identityBullets = identityMemory.flatMap((section) => section.bullets)
  const identityFromLabels = labelled(identityBullets, ['role', 'personality'])
  const identityProse = identityMemory.flatMap((section) => section.paragraphs)
  const identity =
    identityFromLabels.length > 0
      ? text(identityFromLabels.join('; '))
      : identityProse.length > 0
        ? text(identityProse[0] as string)
        : text(firstSentence(lead))

  const summaryFromLead = lead === '' ? '' : firstSentence(lead)
  const summary = text(summaryFromLead !== '' ? summaryFromLead : (draft.description ?? draft.meta['vibe'] ?? ''))

  const missionSections = sectionsFor(sections, 'core_mission')
  const missionParagraph = missionSections.flatMap((section) => section.paragraphs)[0] ?? ''
  const mission = text(missionParagraph === '' ? '' : firstSentence(missionParagraph))

  const capabilityLines: string[] = []
  for (const section of missionSections) {
    capabilityLines.push(...(section.subHeadings.length > 0 ? section.subHeadings : section.bullets))
  }
  for (const section of sectionsFor(sections, 'capabilities')) {
    capabilityLines.push(...section.subHeadings, ...section.bullets)
  }

  const expertiseLines = [
    ...labelled(identityBullets, ['experience', 'expertise']),
    ...sectionsFor(sections, 'expertise').flatMap((section) => [...section.subHeadings, ...section.bullets]),
  ]

  const ruleLines = sectionsFor(sections, 'critical_rules').flatMap((section) => [
    ...section.subHeadings,
    ...section.bullets,
  ])
  const constraintLines = ruleLines.filter((line) => RULE_WORDS.test(line))
  const principleLines = ruleLines.filter((line) => !RULE_WORDS.test(line))

  const deliverableLines = sectionsFor(sections, 'deliverables').flatMap((section) =>
    section.subHeadings.length > 0 ? section.subHeadings : section.bullets,
  )

  const workflowSections = sectionsFor(sections, 'workflow')
  const workflowAll = workflowSections.flatMap((section) => [...section.subHeadings, ...section.bullets])
  const workflowSteps = workflowAll.filter((line) => /^\s*(?:[-*+]|\d+\.)?\s*(step|phase)\b/i.test(line))
  const workflowLines = workflowSteps.length > 0 ? workflowSteps : workflowAll

  const successLines = sectionsFor(sections, 'success_metrics').flatMap((section) => [
    ...section.subHeadings,
    ...section.bullets,
  ])

  const collaborationLines: string[] = []
  for (const section of sectionsFor(sections, 'collaboration')) {
    for (const row of section.tableRows) {
      const who = (row[0] ?? '').replace(/\*/g, '').trim()
      const how = (row[1] ?? '').trim()
      if (who !== '' && how !== '') collaborationLines.push(`${who}: ${how}`)
    }
    collaborationLines.push(...section.bullets, ...section.paragraphs)
  }
  // R3's loose phrasing, anywhere in the persona: a hand-off named in a rules or workflow section
  // is a hand-off, and it is the commonest shape in the corpus.
  for (const section of sections) {
    for (const line of [...section.bullets, ...section.paragraphs]) {
      if (HANDOFF.test(line)) collaborationLines.push(line)
    }
  }

  const skills = (draft.meta['skills'] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')

  const matched = CANONICAL_SLOTS.filter((slot) => filled.has(slot)).length
  const mappingQuality: MappingQuality = matched >= 7 ? 'full' : matched >= 3 ? 'partial' : 'none'

  return {
    ...emptyProfileSpec(),
    identity,
    summary,
    mission,
    runtimeRole: text(facts.runtimeRole),
    capabilities: items(capabilityLines),
    expertise: items(expertiseLines),
    operatingPrinciples: items(principleLines),
    constraints: items(constraintLines),
    workflow: items(workflowLines),
    deliverables: items(deliverableLines),
    successCriteria: items(successLines),
    collaborationHints: items(collaborationLines),
    recommendedSkills: items(skills),
    body: draft.body,
    source: {
      repository: facts.repository,
      path: facts.path,
      revision: facts.revision,
      license: facts.license,
      importedAt: facts.importedAt.toISOString(),
      mappingQuality,
    },
  }
}
```

Then add to `packages/domain/src/catalog/index.ts`:

```ts
export * from './spec.js'
```

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run --project unit packages/domain/test/catalog/spec.test.ts`
Expected: PASS. If a case fails, fix the MAPPER, never the fixture — the fixtures are the three
shapes the corpus actually has, and a rule that only works on a rewritten persona is not a rule.

- [ ] **Step 9: Add the four columns and their migration**

In `packages/db/prisma/schema.prisma`, inside `model SlaveTemplate`, immediately after the
`profileSha256` field, add:

```prisma
  /// M46 R1: the UPSTREAM structured profile -- what the importer mapped out of the persona file
  /// (`profileSpecSchema`, `packages/domain/src/profile/spec.ts`). Importer-owned: an operator
  /// never edits this column, which is exactly what makes an override survive the next import.
  /// NULL on every hand-made template and on every row imported before this milestone.
  profileSpec      Json?
  /// M46 R1: the LOCAL half -- a PARTIAL object of the same shape holding only the fields an
  /// operator changed. `effectiveProfileSpec(profileSpec, profileOverrides)` is what `profile`
  /// above is rendered from, and the two live apart so an import can rewrite one without touching
  /// the other.
  profileOverrides Json?
  /// M46 R4: the commit of the catalog checkout this row was last imported from, when the
  /// directory was inside a git work tree. NULL otherwise -- and NULL is the ordinary case for a
  /// directory somebody copied off a share.
  sourceRevision   String?
  /// M46 R4: the licence named by the first line of a LICENSE file at the catalog root (`MIT
  /// License` -> `MIT`). Attribution, not a copy: no licence text is vendored anywhere.
  sourceLicense    String?
```

Create `packages/db/prisma/migrations/20260911100000_m46_profile_spec/migration.sql`:

```sql
-- M46 t1: the structured specialist profile (spec R1) and the two source facts R4 adds.
-- Additive, no backfill: a NULL `profileSpec` is what "this row has never been mapped" means, and
-- the next import of its catalog writes one. The Markdown `profile` column is unchanged and is
-- still the only thing a run is given.

ALTER TABLE "SlaveTemplate" ADD COLUMN "profileSpec" JSONB;
ALTER TABLE "SlaveTemplate" ADD COLUMN "profileOverrides" JSONB;
ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceRevision" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceLicense" TEXT;
```

- [ ] **Step 10: Apply it to both databases and prove the schema and the migrations agree**

```bash
npm run db:migrate
npm run db:migrate:test
npm run db:generate
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```
Expected: the last command prints `No difference detected`. Paste that line into the task report.

- [ ] **Step 11: Full task verification**

```bash
npx tsc --build
npm run --silent typecheck
npx vitest run --project unit packages/domain/test/profile packages/domain/test/catalog
npm run gate:m26-vocabulary
```
Expected: all green. (`tsc --build` after `db:generate`, before anything compiles against the
client — Global Constraints.)

- [ ] **Step 12: Commit**

```bash
git add packages/domain/src/profile packages/domain/src/catalog/spec.ts packages/domain/src/index.ts \
        packages/domain/src/catalog/index.ts packages/domain/test/profile packages/domain/test/catalog/spec.test.ts \
        packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260911100000_m46_profile_spec
git commit -m "$(cat <<'EOF'
feat(domain,db): m46 t1 -- the specialist profile, its renderer and the persona mapper

Two columns and one renderer (spec R1). `profileSpec` is upstream and importer-owned;
`profileOverrides` is a partial object of the same shape holding only what an operator changed.
They live apart, which is the whole mechanism by which an override survives the next import.
`effectiveProfileSpec` merges them field by field -- an overridden list REPLACES the upstream list,
because a merge would make "take that constraint away" impossible to say.

`renderProfileSpec` produces the Markdown `SlaveTemplate.profile` holds, and truncates by dropping
WHOLE sections from the end of a fixed keep-priority rather than slicing characters: the cap is
enforced again at dispatch, so an over-long profile is an undispatchable worker, and half a
constraint in front of a model is worse than none.

Two corrections to the spec, both baked in. The field list gains `body` -- the persona's own
remaining prose -- because R1's thirteen fields would have turned a persona this mapper does not
recognise into a two-line worker, and because R3 itself says the sections it does not map "stay in
the Markdown body". And the suggested `runtimeRole` is never rendered: the scheduler matches
`Slave.runtimeRoles`, so a prompt claiming a runtime role would be a sentence that is not true.

The mapper is a heading table and a handful of line rules -- no inference from a persona's name,
nothing near a model -- and it says how much it understood: full (seven of nine canonical slots),
partial (three), none. Its tests run against three real corpus shapes rewritten in this project's
vocabulary, plus a persona with no heading at all.

Additive migration, applied to both databases; `prisma migrate diff` reports no difference.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 2: The importer writes the spec, the overrides survive it, and the catalog can be read (R2/R4/R5/R6, E4–E6, E9, E10, E14, E15, E17)

**Files:**
- Modify: `packages/control/src/catalog.ts`, `packages/control/src/profile.ts`, `packages/control/src/refusal.ts`, `apps/orchestrator/src/catalog.ts`, `apps/orchestrator/src/cli.ts`
- Test: `packages/control/test/integration/catalog.test.ts`, `packages/control/test/integration/profile.test.ts`, `apps/orchestrator/test/catalog.test.ts`, `apps/orchestrator/test/integration/cli.test.ts`

**Interfaces:**
- Consumes from Task 1: `personaToProfileSpec(draft, { repository, path, revision, license, importedAt, runtimeRole })`, `profileSpecSchema`, `profileOverridesSchema`, `effectiveProfileSpec`, `renderProfileSpec`, `overriddenFields`, `emptyProfileSpec`, `PROFILE_SPEC_FIELDS`, `type ProfileSpec`, `type ProfileOverrides`, `type ProfileSpecField`, `type MappingQuality`; the four new columns.
- Produces, for Tasks 3–5:
  - `ImportCatalogInput` gains `revision?: string | null` and `license?: string | null`
  - `RowOutcome` gains `overridesKept?: number`
  - `setProfileOverrides(templateId: string, patch: unknown, actor: string): Promise<Result<{ overridden: readonly ProfileSpecField[] }, ControlRefusal>>`
  - `clearProfileOverride(templateId: string, field: string, actor: string): Promise<Result<{ overridden: readonly ProfileSpecField[] }, ControlRefusal>>`
  - `interface WorkforceCatalogRow`, `interface WorkforceCatalogFacets`, `interface WorkforceCatalogPage { rows; facets }`, `interface WorkforceCatalogFilters { q?; division?; capability?; source?; skill? }`
  - `listWorkforceCatalog(filters?: WorkforceCatalogFilters): Promise<WorkforceCatalogPage>`
  - `interface TemplateProfileView { templateId; name; upstream; overrides; effective; markdown; rawOverride; overridden }`, `readTemplateProfile(templateId: string): Promise<Result<TemplateProfileView, ControlRefusal>>`
  - `CatalogWalk` gains `revision: string | null` and `license: string | null`
  - refusal kinds `profile_not_structured`, `invalid_profile_overrides`, `unknown_profile_field`
  - CLI verb `show-profile --template <id> [--markdown]`

- [ ] **Step 1: Add the three refusal kinds**

In `packages/control/src/refusal.ts`, beside `template_not_found` in the `ControlRefusal` union:

```ts
  /** M46 R2: `profileOverrides` are a partial of `profileSpec`, and there is no spec on this row to
   *  be partial OF -- a hand-made template, or one whose catalog has not been imported since M46.
   *  Refused rather than invented: writing overrides against an empty spec would re-render the
   *  Markdown of a template whose profile a person wrote by hand. */
  | { readonly kind: 'profile_not_structured'; readonly templateId: string }
  /** M46 R2: the patch does not match `profileOverridesSchema`. */
  | { readonly kind: 'invalid_profile_overrides'; readonly detail: string }
  /** M46 R2: `clearProfileOverride` was asked for a field that is not one of the fourteen. */
  | { readonly kind: 'unknown_profile_field'; readonly field: string }
```

and in `refusalText`, beside the `catalog_empty` case:

```ts
    case 'profile_not_structured':
      return `template ${refusal.templateId} has no structured profile to customise: import its catalog first, or edit its profile as Markdown`
    case 'invalid_profile_overrides':
      return `these profile changes cannot be stored: ${refusal.detail}`
    case 'unknown_profile_field':
      return `"${refusal.field}" is not a profile field`
```

`refusalStatus` derives 404 from a `_not_found` suffix and needs no change: all three are 409.

- [ ] **Step 2: Write the failing integration test for the two override verbs**

Append to `packages/control/test/integration/profile.test.ts` (top-level `import` additions:
`clearProfileOverride`, `setProfileOverrides` from `'../../src/profile.js'`; `goalSha256`,
`emptyProfileSpec`, `renderProfileSpec`, `effectiveProfileSpec` from `'@slave-of-ai/domain'`):

```ts
describe('setProfileOverrides and clearProfileOverride', () => {
  const spec = () => ({
    ...emptyProfileSpec(),
    identity: 'The slave that lays the load-bearing parts first.',
    summary: 'Builds the core module.',
    capabilities: ['Design the module boundary'],
    constraints: ['You MUST never leave a red test behind'],
    body: 'You write the module everything else stands on.',
    source: {
      repository: 'catalog-m46',
      path: 'engineering/gate-canonical.md',
      revision: null,
      license: 'MIT',
      importedAt: '2026-09-11T09:00:00.000Z',
      mappingQuality: 'full' as const,
    },
  })

  const structuredTemplate = async () => {
    const rendered = renderProfileSpec(spec())
    return prisma.slaveTemplate.create({
      data: {
        name: 'Gate Core Builder',
        role: 'engineering',
        profile: rendered,
        profileSha256: goalSha256(rendered),
        profileSpec: spec() as unknown as object,
        sourceId: 'catalog-m46/engineering/gate-canonical',
        sourceSha256: 'file-sha',
        sourceDivision: 'engineering',
        importedAt: new Date('2026-09-11T09:00:00.000Z'),
      },
    })
  }

  it('stores the patch, re-renders the Markdown and re-stamps its hash', async (): Promise<void> => {
    const template = await structuredTemplate()

    const result = await setProfileOverrides(template.id, { constraints: ['You MUST ship behind a flag'] }, 'operator')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.overridden).toEqual(['constraints'])
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })
    expect(row.profileOverrides).toEqual({ constraints: ['You MUST ship behind a flag'] })
    expect(row.profile).toContain('- You MUST ship behind a flag')
    expect(row.profile).not.toContain('never leave a red test behind')
    // The upstream half is untouched -- that is what makes the next import able to move it.
    expect((row.profileSpec as { constraints: string[] }).constraints).toEqual([
      'You MUST never leave a red test behind',
    ])
    // The re-stamped hash is what keeps this row OUT of `locally_edited` (plan erratum E4).
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
    expect(row.profile).toBe(renderProfileSpec(effectiveProfileSpec(spec(), { constraints: ['You MUST ship behind a flag'] })))
  })

  it('merges a second patch into the first rather than replacing the whole object', async (): Promise<void> => {
    const template = await structuredTemplate()
    await setProfileOverrides(template.id, { constraints: ['One'] }, 'operator')

    await setProfileOverrides(template.id, { summary: 'Mine.' }, 'operator')

    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })
    expect(row.profileOverrides).toEqual({ constraints: ['One'], summary: 'Mine.' })
  })

  it('clears one field and leaves the others overridden', async (): Promise<void> => {
    const template = await structuredTemplate()
    await setProfileOverrides(template.id, { constraints: ['One'], summary: 'Mine.' }, 'operator')

    const result = await clearProfileOverride(template.id, 'constraints', 'operator')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.overridden).toEqual(['summary'])
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })
    expect(row.profileOverrides).toEqual({ summary: 'Mine.' })
    // The upstream constraint is back in the Markdown, which is what "Reset" means.
    expect(row.profile).toContain('never leave a red test behind')
  })

  it('writes null, not an empty object, when the last override is cleared', async (): Promise<void> => {
    const template = await structuredTemplate()
    await setProfileOverrides(template.id, { summary: 'Mine.' }, 'operator')

    await clearProfileOverride(template.id, 'summary', 'operator')

    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })
    expect(row.profileOverrides).toBeNull()
    expect(row.profile).toBe(renderProfileSpec(spec()))
  })

  it('refuses a template that has no structured profile at all', async (): Promise<void> => {
    const handMade = await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend', profile: 'mine' } })

    const result = await setProfileOverrides(handMade.id, { summary: 'x' }, 'operator')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ kind: 'profile_not_structured', templateId: handMade.id })
    // Nothing was written: a hand-written profile is not something this verb may re-render.
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: handMade.id } })).profile).toBe('mine')
  })

  it('refuses a patch that is not the shape, and an unknown field on clear', async (): Promise<void> => {
    const template = await structuredTemplate()

    const bad = await setProfileOverrides(template.id, { capabilities: 'not a list' }, 'operator')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.kind).toBe('invalid_profile_overrides')

    const unknown = await clearProfileOverride(template.id, 'nonsense', 'operator')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toEqual({ kind: 'unknown_profile_field', field: 'nonsense' })
  })

  it('refuses a template id nobody has', async (): Promise<void> => {
    const result = await setProfileOverrides('11111111-1111-1111-1111-111111111111', { summary: 'x' }, 'operator')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('template_not_found')
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run --project integration packages/control/test/integration/profile.test.ts`
Expected: FAIL — `setProfileOverrides is not a function`.

- [ ] **Step 4: Write the two verbs**

Append to `packages/control/src/profile.ts` (its imports gain `effectiveProfileSpec`,
`goalSha256`, `overriddenFields`, `profileOverridesSchema`, `profileSpecSchema`,
`renderProfileSpec`, `PROFILE_SPEC_FIELDS`, `type ProfileOverrides`, `type ProfileSpecField` from
`@slave-of-ai/domain`, and `type Prisma` from `@slave-of-ai/db/client`):

```ts
/**
 * The LOCAL half of a specialist profile (M46 R2).
 *
 * **Why this writes three columns and not one.** `profileOverrides` is what the operator said;
 * `profile` is the Markdown a run is actually given, and it is DERIVED, so it is re-rendered here
 * or it is stale; and `profileSha256` is the import's own record of what it wrote, which this verb
 * re-stamps deliberately. That last write is the entire mechanism by which an override survives an
 * upstream update: `importCatalog` skips a row as `locally_edited` when the stored profile's hash
 * disagrees with `profileSha256`, so a structured customisation that did NOT re-stamp would look
 * exactly like a hand-written profile and would freeze the row forever. A RAW Markdown override
 * (`setProfile({ templateId })`, R5) still does not re-stamp -- and that is now the only thing
 * `locally_edited` means.
 *
 * Refused on a template with no `profileSpec`: there is nothing to be a partial OF, and rendering
 * an empty spec over a hand-written profile would delete somebody's words.
 *
 * No event, for the reason `setProfile`'s docblock already gives: `ExecutionEvent.workspaceId` is
 * NOT NULL and a template belongs to no project (M42 R5/E3).
 */
export async function setProfileOverrides(
  templateId: string,
  patch: unknown,
  actor: string,
): Promise<Result<{ readonly overridden: readonly ProfileSpecField[] }, ControlRefusal>> {
  const parsed = profileOverridesSchema.safeParse(patch)
  if (!parsed.success) {
    return err({ kind: 'invalid_profile_overrides', detail: parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ') })
  }
  return writeOverrides(templateId, actor, (current) => ({ ...current, ...parsed.data }))
}

/** Takes one field back to what the catalog says (R2). The whole column is written as NULL once
 *  the last override goes, so "nothing is customised" is one value rather than two. */
export async function clearProfileOverride(
  templateId: string,
  field: string,
  actor: string,
): Promise<Result<{ readonly overridden: readonly ProfileSpecField[] }, ControlRefusal>> {
  if (!(PROFILE_SPEC_FIELDS as readonly string[]).includes(field)) {
    return err({ kind: 'unknown_profile_field', field })
  }
  return writeOverrides(templateId, actor, (current) => {
    const next: Record<string, unknown> = { ...current }
    delete next[field]
    return next as ProfileOverrides
  })
}

/**
 * The one writer both verbs share: lock the row, read both halves, apply the change, re-render.
 *
 * `SELECT ... FOR UPDATE` through the raw query the catalog's own verbs use, because two operators
 * customising two different fields of the same template in the same second must not lose one of
 * the two patches -- read-modify-write on a JSON column has no other protection.
 *
 * Every refusal here is reached BEFORE anything is written, so each is returned rather than
 * thrown; a refusal after the `update` below would have to throw, or Prisma commits the write
 * (ADR 0003).
 */
async function writeOverrides(
  templateId: string,
  actor: string,
  change: (current: ProfileOverrides) => ProfileOverrides,
): Promise<Result<{ readonly overridden: readonly ProfileSpecField[] }, ControlRefusal>> {
  void actor
  return prisma.$transaction(async (tx): Promise<Result<{ readonly overridden: readonly ProfileSpecField[] }, ControlRefusal>> => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "SlaveTemplate" WHERE id = ${templateId} FOR UPDATE
    `
    if (locked[0] === undefined) return err({ kind: 'template_not_found', templateId })
    const row = await tx.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })

    const spec = profileSpecSchema.safeParse(row.profileSpec)
    if (!spec.success) return err({ kind: 'profile_not_structured', templateId })

    const stored = profileOverridesSchema.safeParse(row.profileOverrides ?? {})
    // A stored patch this repository can no longer parse is not a reason to refuse the operator's
    // NEW change: it is dropped, and the change is applied to an empty patch. Nothing is lost that
    // the effective profile still had -- an unparseable override was already being ignored by
    // every reader.
    const next = change(stored.success ? stored.data : {})
    const overridden = overriddenFields(next)
    const profile = renderProfileSpec(effectiveProfileSpec(spec.data, next))

    await tx.slaveTemplate.update({
      where: { id: templateId },
      data: {
        profileOverrides: overridden.length === 0 ? Prisma.DbNull : (next as unknown as Prisma.InputJsonValue),
        profile,
        profileSha256: goalSha256(profile),
      },
    })
    return ok({ overridden })
  })
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run --project integration packages/control/test/integration/profile.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing importer tests**

Append to `packages/control/test/integration/catalog.test.ts` (imports gain `effectiveProfileSpec`,
`profileSpecSchema`, `renderProfileSpec` from `@slave-of-ai/domain`, and `setProfileOverrides`
from `'../../src/profile.js'`):

```ts
describe('importCatalog and the structured profile (M46)', () => {
  const structured = (slug: string, name: string, body?: string) => entry(slug, name, body)

  it('writes the mapped spec, the source columns and a profile rendered from them', async (): Promise<void> => {
    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [structured('core-builder', 'Core Builder')],
        revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
        license: 'MIT',
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    const row = await prisma.slaveTemplate.findUniqueOrThrow({
      where: { sourceId: `${CATALOG}/engineering/core-builder` },
    })
    expect(row.sourceRevision).toBe('0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef')
    expect(row.sourceLicense).toBe('MIT')
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    expect(spec.success).toBe(true)
    if (!spec.success) return
    expect(spec.data.source).toEqual({
      repository: CATALOG,
      path: 'engineering/core-builder.md',
      revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
      license: 'MIT',
      importedAt: (row.importedAt as Date).toISOString(),
      mappingQuality: 'none',
    })
    expect(spec.data.runtimeRole).toBe('engineering')
    // The stored Markdown is the render of the effective spec, byte for byte.
    expect(row.profile).toBe(renderProfileSpec(spec.data))
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
    expect(row.profileOverrides).toBeNull()
  })

  it('re-renders an updated row from the NEW upstream and the operator’s untouched overrides, and counts them', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfileOverrides(template.id, { summary: 'Mine, and it stays mine.' }, 'operator')

    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [structured('core-builder', 'Core Builder', 'You build the core module AND its documentation.')],
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.updated).toHaveLength(1)
    expect(result.value.updated[0]?.overridesKept).toBe(1)
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })
    // The override survived...
    expect(row.profileOverrides).toEqual({ summary: 'Mine, and it stays mine.' })
    expect(row.profile).toContain('Mine, and it stays mine.')
    // ...and the upstream half moved with the file.
    expect(row.profile).toContain('AND its documentation')
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
  })

  it('skips locally_edited for a RAW Markdown override and leaves the operator’s words alone (R5)', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfile({ templateId: template.id }, 'This is what I want this worker to be, in my own words.', 'operator')

    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [structured('core-builder', 'Core Builder', 'A rewritten body for the same file.')],
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped[0]?.reason).toBe('locally_edited')
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: template.id } })
    expect(row.profile).toBe('This is what I want this worker to be, in my own words.')
    // The spec is NOT advanced either: the row is frozen until the operator resolves the
    // disagreement, exactly as M42 defined it.
    expect((row.profileSpec as { body: string }).body).not.toContain('A rewritten body')
  })

  it('a structured customisation is NOT locally_edited -- that is what re-stamping the hash buys', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfileOverrides(template.id, { constraints: ['Mine'] }, 'operator')

    const result = await importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [structured('core-builder', 'Core Builder', 'A rewritten body for the same file.')],
      },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped).toEqual([])
    expect(result.value.updated[0]?.overridesKept).toBe(1)
  })

  it('reports overridesKept 0 on a row nobody has customised', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder')] }, 'operator')

    const result = await importCatalog(
      { catalog: CATALOG, directory: DIRECTORY, entries: [structured('core-builder', 'Core Builder', 'Changed.')] },
      'operator',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.updated[0]?.overridesKept).toBe(0)
  })
})

describe('listWorkforceCatalog', () => {
  const importTwo = async () =>
    importCatalog(
      {
        catalog: CATALOG,
        directory: DIRECTORY,
        entries: [
          entry('core-builder', 'Core Builder', '## Core Capabilities\n- Design the module boundary\n\n## Domain Expertise\n- Load-bearing code'),
          entry('verifier', 'Verifier', '## Core Capabilities\n- Run the work back\n'),
        ],
        revision: 'rev1',
        license: 'MIT',
      },
      'operator',
    )

  it('returns one row per template with its summary, capabilities and source, plus the facets', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })
    await importTwo()

    const page = await listWorkforceCatalog()

    expect(page.rows.map((row) => row.name)).toEqual(['Core Builder', 'Hand Made', 'Verifier'])
    const core = page.rows.find((row) => row.name === 'Core Builder')
    expect(core?.source).toBe('imported')
    expect(core?.sourceRepository).toBe(CATALOG)
    expect(core?.capabilities).toContain('Design the module boundary')
    expect(core?.structured).toBe(true)
    expect(core?.rawOverride).toBe(false)
    expect(core?.overriddenFields).toEqual([])
    expect(page.rows.find((row) => row.name === 'Hand Made')?.source).toBe('local')
    expect(page.rows.find((row) => row.name === 'Hand Made')?.structured).toBe(false)
    expect(page.facets.divisions).toEqual(['engineering'])
    expect(page.facets.capabilities).toContain('Run the work back')
  })

  it('narrows by search text over name, summary, capabilities and expertise', async (): Promise<void> => {
    await importTwo()

    expect((await listWorkforceCatalog({ q: 'module boundary' })).rows.map((row) => row.name)).toEqual(['Core Builder'])
    expect((await listWorkforceCatalog({ q: 'load-bearing' })).rows.map((row) => row.name)).toEqual(['Core Builder'])
    expect((await listWorkforceCatalog({ q: 'verif' })).rows.map((row) => row.name)).toEqual(['Verifier'])
    expect((await listWorkforceCatalog({ q: 'nothing at all' })).rows).toEqual([])
  })

  it('narrows by capability, by division and by source, and keeps the facets whole', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })
    await importTwo()

    expect((await listWorkforceCatalog({ capability: 'Run the work back' })).rows.map((row) => row.name)).toEqual(['Verifier'])
    expect((await listWorkforceCatalog({ division: 'engineering' })).rows).toHaveLength(2)
    expect((await listWorkforceCatalog({ source: 'local' })).rows.map((row) => row.name)).toEqual(['Hand Made'])
    // Filtered rows, UNfiltered facets: a menu that collapsed to the one value already chosen
    // would be a menu you cannot change your mind in.
    expect((await listWorkforceCatalog({ source: 'local' })).facets.capabilities).toContain('Design the module boundary')
  })

  it('marks a raw Markdown override, and does not mark a hand-made template as one', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend', profile: 'my own words' } })
    await importTwo()
    const core = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Core Builder' } })
    await setProfile({ templateId: core.id }, 'my own words', 'operator')

    const page = await listWorkforceCatalog()

    expect(page.rows.find((row) => row.name === 'Core Builder')?.rawOverride).toBe(true)
    // No spec, no upstream, nothing to override (plan erratum E5).
    expect(page.rows.find((row) => row.name === 'Hand Made')?.rawOverride).toBe(false)
  })
})

describe('readTemplateProfile', () => {
  it('hands back both halves, the merge and the stored Markdown', async (): Promise<void> => {
    await importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries: [entry('core-builder', 'Core Builder')] }, 'operator')
    const template = await prisma.slaveTemplate.findFirstOrThrow()
    await setProfileOverrides(template.id, { summary: 'Mine.' }, 'operator')

    const result = await readTemplateProfile(template.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.overrides).toEqual({ summary: 'Mine.' })
    expect(result.value.effective?.summary).toBe('Mine.')
    expect(result.value.upstream?.summary).not.toBe('Mine.')
    expect(result.value.markdown).toBe(renderProfileSpec(effectiveProfileSpec(result.value.upstream, result.value.overrides)))
    expect(result.value.overridden).toEqual(['summary'])
    expect(result.value.rawOverride).toBe(false)
  })

  it('answers for a hand-made template with a null spec rather than refusing', async (): Promise<void> => {
    const handMade = await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend', profile: 'mine' } })

    const result = await readTemplateProfile(handMade.id)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.upstream).toBeNull()
    expect(result.value.effective).toBeNull()
    expect(result.value.markdown).toBe('mine')
  })

  it('refuses an id nobody has', async (): Promise<void> => {
    const result = await readTemplateProfile('11111111-1111-1111-1111-111111111111')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('template_not_found')
  })
})
```

- [ ] **Step 7: Run them and watch them fail**

Run: `npx vitest run --project integration packages/control/test/integration/catalog.test.ts`
Expected: FAIL — `listWorkforceCatalog is not a function`, and the spec assertions fail because
`importCatalog` writes no `profileSpec`.

- [ ] **Step 8: Teach `importCatalog` the spec, the source columns and the overrides**

In `packages/control/src/catalog.ts`, extend the imports from `@slave-of-ai/domain` with
`effectiveProfileSpec`, `overriddenFields`, `personaToProfileSpec`, `profileOverridesSchema`,
`profileSpecSchema`, `renderProfileSpec`, `type MappingQuality`, `type ProfileSpec`,
`type ProfileSpecField`, and add to `ImportCatalogInput`:

```ts
  /** M46 R4: the commit of the catalog checkout, read once per import by the CLI's walk (the
   *  control package touches no disk). NULL when the directory is not inside a git work tree. */
  readonly revision?: string | null
  /** M46 R4: the licence named by a LICENSE file at the catalog root, `MIT License` -> `MIT`. */
  readonly license?: string | null
```

and to `RowOutcome`:

```ts
  /** M46 R2: how many of this row's fields an operator had customised, and the update kept. Only
   *  on an `updated` row -- there is nothing to keep on a row being created. */
  readonly overridesKept?: number
```

Inside `importRow`, after `const draft = drafted.value` and before the transaction, build the
upstream spec once (it does not depend on any row):

```ts
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
```

In the CREATE branch, replace the `data:` object of `tx.slaveTemplate.create` with:

```ts
            data: {
              name: draft.name,
              role: draft.role,
              description: draft.description,
              // M46 R1: `profile` is DERIVED. A new row has no overrides, so the effective spec is
              // the upstream one and the rendered Markdown is what a run will be given.
              profile: renderProfileSpec(upstream),
              profileSha256: goalSha256(renderProfileSpec(upstream)),
              profileSpec: upstream as unknown as Prisma.InputJsonValue,
              sourceId: draft.sourceId,
              sourceSha256: draft.sourceSha256,
              sourceDivision: draft.sourceDivision,
              sourceRevision: input.revision ?? null,
              sourceLicense: input.license ?? null,
              importedAt,
            },
```

In the UPDATE branch — **after** the unchanged-file check and **after** the `locally_edited` check,
both of which stay exactly where they are (they are the row's policy and this milestone does not
move it) — replace the `tx.slaveTemplate.update` block with:

```ts
      // M46 R2: the operator's half is read, never written, and the Markdown is re-rendered from
      // the NEW upstream spec merged with it. This is the whole of "an override survives an
      // upstream update": the two halves are different columns, so an import can replace one
      // without being able to touch the other.
      const stored = profileOverridesSchema.safeParse(existing.profileOverrides ?? {})
      const overrides = stored.success ? stored.data : {}
      const profile = renderProfileSpec(effectiveProfileSpec(upstream, overrides))

      if (input.dryRun === true) {
        return { kind: 'updated', row: { ...outcomeRow, overridesKept: overriddenFields(overrides).length } }
      }

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
          description: draft.description,
          sourceSha256: draft.sourceSha256,
          sourceDivision: draft.sourceDivision,
          sourceRevision: input.revision ?? null,
          sourceLicense: input.license ?? null,
          importedAt,
        },
      })
      return { kind: 'updated', row: { ...outcomeRow, overridesKept: overriddenFields(overrides).length } }
```

(The old `if (input.dryRun === true) return { kind: 'updated', row: outcomeRow }` line above the
write is replaced by the one inside this block, so a dry run reports `overridesKept` too.)

- [ ] **Step 9: Write `listWorkforceCatalog` and `readTemplateProfile`**

Append to `packages/control/src/catalog.ts`:

```ts
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
  readonly expertise: readonly string[]
  readonly recommendedSkills: readonly string[]
  readonly mappingQuality: MappingQuality | null
  readonly overriddenFields: readonly ProfileSpecField[]
  /** The Markdown was written by hand over a structured profile (R5, plan erratum E4): the stored
   *  profile's hash disagrees with the one the last write recorded. It is the same predicate
   *  `importCatalog` uses for `locally_edited`, which is exactly the point. */
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

function catalogRowOf(
  template: {
    id: string
    name: string
    role: string
    description: string
    defaultModel: string | null
    provider: ProviderKind | null
    profile: string | null
    profileSha256: string | null
    profileSpec: unknown
    profileOverrides: unknown
    sourceId: string | null
    sourceDivision: string | null
    sourceRevision: string | null
    sourceLicense: string | null
    importedAt: Date | null
  },
  catalogSlaveCount: number,
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
    summary: effective?.summary ?? template.description,
    capabilities: effective?.capabilities ?? [],
    expertise: effective?.expertise ?? [],
    recommendedSkills: effective?.recommendedSkills ?? [],
    mappingQuality: spec.success ? (spec.data.source?.mappingQuality ?? null) : null,
    overriddenFields: overrides.success ? overriddenFields(overrides.data) : [],
    rawOverride:
      spec.success && template.profile !== null && goalSha256(template.profile) !== template.profileSha256,
  }
}

function matches(row: WorkforceCatalogRow, filters: WorkforceCatalogFilters): boolean {
  if (filters.source !== undefined && row.source !== filters.source) return false
  if (filters.division !== undefined && (row.sourceDivision ?? row.role) !== filters.division) return false
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
 */
export async function listWorkforceCatalog(filters: WorkforceCatalogFilters = {}): Promise<WorkforceCatalogPage> {
  const [templates, catalogSlaveGroups] = await Promise.all([
    prisma.slaveTemplate.findMany({ orderBy: { name: 'asc' } }),
    prisma.companySlave.groupBy({ by: ['templateId'], _count: { _all: true } }),
  ])
  const countByTemplate = new Map(catalogSlaveGroups.map((group) => [group.templateId, group._count._all] as const))
  const all = templates.map((template) => catalogRowOf(template, countByTemplate.get(template.id) ?? 0))

  const divisions = new Set<string>()
  const capabilities = new Set<string>()
  const skills = new Set<string>()
  for (const row of all) {
    divisions.add(row.sourceDivision ?? row.role)
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
  readonly overridden: readonly ProfileSpecField[]
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
    rawOverride: spec.success && row.profile !== null && goalSha256(row.profile) !== row.profileSha256,
    overridden: overriddenFields(overrides),
  })
}
```

`packages/control/src/index.ts` re-exports `./catalog.js` and `./profile.js` with `export *`, so
nothing is added there. Add `import type { ProviderKind } from '@slave-of-ai/db'` to `catalog.ts`
if it is not already imported.

- [ ] **Step 10: Run the control tests**

```bash
npx tsc --build
npx vitest run --project integration packages/control/test/integration/catalog.test.ts packages/control/test/integration/profile.test.ts
```
Expected: PASS, including every M42 case that was already there — `(a)`'s
`startsWith(importedProfilePrefix(...))` and `(d)`'s `toContain('AND its documentation')` both hold
because the renderer emits the prefix line first and the persona body last (plan erratum E1). If
either fails, the renderer is wrong, not the test.

- [ ] **Step 11: Write the failing test for the walk's revision and licence**

Append to `apps/orchestrator/test/catalog.test.ts` (imports gain `execFileSync` from
`node:child_process`):

```ts
describe('readCatalogDirectory and the source record (M46 R4)', () => {
  const commit = (dir: string): string => {
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'add', '-A'])
    execFileSync('git', [
      '-C', dir,
      '-c', 'user.email=gate@example.invalid',
      '-c', 'user.name=Gate',
      'commit', '-q', '-m', 'fixture',
    ])
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  }

  it('reads the checkout commit when the directory is inside a git work tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-m46-'))
    mkdirSync(join(dir, 'engineering'), { recursive: true })
    writeFileSync(join(dir, 'engineering', 'one.md'), '---\nname: One\n---\n\nbody\n')
    const head = commit(dir)

    expect(readCatalogDirectory(dir).revision).toBe(head)
  })

  it('reads a licence from the first line of LICENSE, and turns "MIT License" into "MIT"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-m46-'))
    mkdirSync(join(dir, 'engineering'), { recursive: true })
    writeFileSync(join(dir, 'engineering', 'one.md'), '---\nname: One\n---\n\nbody\n')
    writeFileSync(join(dir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 Somebody\n')

    expect(readCatalogDirectory(dir).license).toBe('MIT')
  })

  it('gives null for both when there is no work tree and no LICENSE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-m46-'))
    mkdirSync(join(dir, 'engineering'), { recursive: true })
    writeFileSync(join(dir, 'engineering', 'one.md'), '---\nname: One\n---\n\nbody\n')

    const walk = readCatalogDirectory(dir)
    expect(walk.revision).toBeNull()
    expect(walk.license).toBeNull()
  })

  it('gives null for a licence line nobody can read as one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-m46-'))
    mkdirSync(join(dir, 'engineering'), { recursive: true })
    writeFileSync(join(dir, 'engineering', 'one.md'), '---\nname: One\n---\n\nbody\n')
    writeFileSync(join(dir, 'LICENSE'), `${'x'.repeat(200)}\n`)

    expect(readCatalogDirectory(dir).license).toBeNull()
  })
})
```

- [ ] **Step 12: Run it and watch it fail, then teach the walk**

Run: `npx vitest run --project unit apps/orchestrator/test/catalog.test.ts`
Expected: FAIL — `walk.revision` is `undefined`.

In `apps/orchestrator/src/catalog.ts`, add `import { execFileSync } from 'node:child_process'`,
extend `CatalogWalk`:

```ts
  /** M46 R4: the commit of the catalog checkout, or null when the directory is not inside a git
   *  work tree -- which is the ordinary case for a directory copied off a share. Read ONCE per
   *  walk: `sourceId` and `sourceSha256` identify a file and its bytes, and neither says which
   *  version of the catalog those bytes came from. */
  readonly revision: string | null
  /** M46 R4/E15: the licence a LICENSE file at the catalog root names, `MIT License` -> `MIT`.
   *  Attribution in metadata; no licence text is copied anywhere and nothing is vendored. */
  readonly license: string | null
```

and add the two readers beside `divisionsOf`:

```ts
/**
 * The commit the catalog is checked out at, when there is one.
 *
 * `git`, in a `try`, in the APPLICATION -- never in `packages/domain`, which imports no Node
 * built-in at all because `apps/web`'s client bundle imports it. Three ordinary situations give
 * null and none of them is an error: the directory is not a work tree, `git` is not installed,
 * and a fresh repository has no commit for `rev-parse HEAD` to resolve.
 */
function revisionOf(root: string): string | null {
  try {
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return head === '' ? null : head
  } catch {
    return null
  }
}

/** The catalog's licence, from the FIRST non-empty line of the first LICENSE file at its root.
 *  `MIT License` -> `MIT`; anything else short enough to be a licence name is kept as written;
 *  anything longer is null, because the first line of a licence TEXT is not a licence name. */
function licenseOf(root: string): string | null {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    let text: string
    try {
      text = readFileSync(join(root, name), 'utf8')
    } catch {
      continue
    }
    const first = text.split('\n').map((line) => line.trim()).find((line) => line !== '')
    if (first === undefined) return null
    const named = /^(.{1,60}?)\s+Licen[cs]e$/i.exec(first)
    if (named !== null) return named[1] as string
    return first.length <= 60 ? first : null
  }
  return null
}
```

and return them from `readCatalogDirectory`:

```ts
  return { catalog, divisions, missingDivisions, staleManifestDivisions, revision: revisionOf(root), license: licenseOf(root), entries }
```

- [ ] **Step 13: Run it and watch it pass**

Run: `npx vitest run --project unit apps/orchestrator/test/catalog.test.ts`
Expected: PASS.

- [ ] **Step 14: Pass them through the CLI, and add `show-profile`**

In `apps/orchestrator/src/cli.ts`, inside `case 'import-catalog'`, add the two facts to the
`importCatalog` call:

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
        },
        operatorName(flags),
      )
```

and one line to the walk's warnings block, so an operator can see what was recorded:

```ts
      // R4: printed rather than silent -- "no revision" is a fact about the operator's directory
      // (it is not a git checkout), and somebody reading a catalog page later will ask why.
      process.stdout.write(
        `catalog ${walk.catalog}: revision ${walk.revision ?? 'unknown (not a git work tree)'}, licence ${walk.license ?? 'unknown (no LICENSE at the root)'}\n`,
      )
```

Add the new verb after `case 'set-profile'`:

```ts
    case 'show-profile': {
      const templateId = requireFlag(flags, 'template')
      const result = await readTemplateProfile(templateId)
      if (!result.ok) throw new Error(refusalText(result.error))
      const view = result.value
      if ('markdown' in flags) {
        process.stdout.write(view.markdown === null ? 'this template has no profile\n' : `${view.markdown}\n`)
        return 0
      }
      // JSON, not a rendered report: this verb exists so a person -- or a gate -- can read the
      // structure back exactly as it is stored, and a prose summary of a fourteen-field object
      // would be a second, drifting rendering of it.
      process.stdout.write(
        `${JSON.stringify(
          {
            templateId: view.templateId,
            name: view.name,
            rawOverride: view.rawOverride,
            overridden: view.overridden,
            effective: view.effective,
            upstream: view.upstream,
            overrides: view.overrides,
          },
          null,
          2,
        )}\n`,
      )
      return 0
    }
```

with `readTemplateProfile` added to the `@slave-of-ai/control` import list, and this entry in the
usage text, immediately after `set-profile`'s:

```
  show-profile --template <id> [--markdown]
                                       the specialist profile this template carries: the upstream
                                       structure an import mapped, the fields an operator has
                                       customised and the merge of the two, as JSON. --markdown
                                       prints the profile text a run is actually given instead.
```

- [ ] **Step 15: Write the CLI test**

Append to `apps/orchestrator/test/integration/cli.test.ts`:

```ts
describe('show-profile', () => {
  it('prints the upstream spec, the overrides and the merge as JSON', async (): Promise<void> => {
    const spec = {
      identity: 'The slave that lays the load-bearing parts first.',
      summary: 'Builds the core module.',
      mission: '',
      runtimeRole: 'engineering',
      capabilities: ['Design the module boundary'],
      expertise: [],
      operatingPrinciples: [],
      constraints: [],
      workflow: [],
      deliverables: [],
      successCriteria: [],
      collaborationHints: [],
      recommendedSkills: [],
      body: 'You write the module everything else stands on.',
      source: {
        repository: 'catalog-m46',
        path: 'engineering/gate-canonical.md',
        revision: null,
        license: 'MIT',
        importedAt: '2026-09-11T09:00:00.000Z',
        mappingQuality: 'partial',
      },
    }
    const template = await prisma.slaveTemplate.create({
      data: { name: 'CLI Core Builder', role: 'engineering', profileSpec: spec, profileOverrides: { summary: 'Mine.' } },
    })

    const result = await runCli(['show-profile', '--template', template.id])

    expect(result.code).toBe(0)
    const printed = JSON.parse(result.stdout) as { effective: { summary: string }; overridden: string[] }
    expect(printed.effective.summary).toBe('Mine.')
    expect(printed.overridden).toEqual(['summary'])
  })

  it('prints the stored Markdown with --markdown, and refuses an id nobody has', async (): Promise<void> => {
    const template = await prisma.slaveTemplate.create({
      data: { name: 'CLI Plain', role: 'engineering', profile: 'the words a run is given' },
    })

    const shown = await runCli(['show-profile', '--template', template.id, '--markdown'])
    expect(shown.code).toBe(0)
    expect(shown.stdout.trim()).toBe('the words a run is given')

    const missing = await runCli(['show-profile', '--template', '11111111-1111-1111-1111-111111111111'])
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('11111111-1111-1111-1111-111111111111')
  })
})
```

Note the `--markdown` flag goes LAST in the argv (M42 E11: a boolean flag before another flag
swallows it as its value).

- [ ] **Step 16: Full task verification**

```bash
npx tsc --build
npm run --silent typecheck
npx vitest run --project unit apps/orchestrator/test/catalog.test.ts packages/domain/test
npx vitest run --project integration packages/control/test/integration/catalog.test.ts \
  packages/control/test/integration/profile.test.ts apps/orchestrator/test/integration/cli.test.ts
npm run gate:m26-vocabulary
```
Expected: all green. Then, because this task changed the importer under it:
```bash
CHROMIUM_PATH= SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
  npm run gate:m42-catalog-import
```
Expected: PASS, unchanged. This is the proof that the per-row policy did not move: the same two
creations, the same three skip reasons, the same `locally_edited` row keeping the operator's words,
and the same persona sentence turning up in a real run's recorded prompt. Paste the last three
`stage N complete` lines into the task report. **Never run this beside vitest.**

- [ ] **Step 17: Commit**

```bash
git add packages/control/src/catalog.ts packages/control/src/profile.ts packages/control/src/refusal.ts \
        packages/control/test/integration/catalog.test.ts packages/control/test/integration/profile.test.ts \
        apps/orchestrator/src/catalog.ts apps/orchestrator/src/cli.ts \
        apps/orchestrator/test/catalog.test.ts apps/orchestrator/test/integration/cli.test.ts
git commit -m "$(cat <<'EOF'
feat(control,orchestrator): m46 t2 -- the import writes the structure, and a customisation outlives it

`importCatalog` now maps every persona into a `profileSpec`, stamps the source record R4 asks for
(repository, path, revision, licence, imported at, mapping quality) and stores a `profile` RENDERED
from the effective spec. Its per-row policy is byte for byte the policy M42 wrote: an unchanged
file is still unchanged, a name still cannot be stolen, an over-long persona is still skipped
before anything is mapped, and nothing is ever deleted. `gate:m42-catalog-import` is green with no
edit, which is the point.

`setProfileOverrides`/`clearProfileOverride` write the operator's half, re-render the Markdown and
RE-STAMP `profileSha256` -- and that last write is the mechanism, not a detail. `locally_edited`
compares the stored profile's hash against what the last write recorded, so a structured
customisation that skipped the stamp would look identical to a hand-written profile and would
freeze the row against every future import. Because it stamps, `locally_edited` now means exactly
one thing: somebody wrote raw Markdown over this template (R5). No marker column was needed for
that; the predicate was already in the importer.

An update keeps the operator's fields untouched and reports how many it kept (`overridesKept`).
Customising a template with no structured profile is refused rather than invented: rendering an
empty spec over a hand-written persona would delete somebody's words.

The walk reads the checkout's commit and the catalog's licence -- `git` and `LICENSE` in the
APPLICATION, never in the domain, which imports no Node built-in at all because the web's client
bundle imports it. Not a work tree, no git, no commit yet: all three are null and none is an error.

`show-profile --template <id>` prints both halves and the merge; `--markdown` prints the text a run
is actually given.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 3: The web read model, the filter vocabulary and the four routes (R2/R6, E9, E10, E17, E18)

**Files:**
- Modify: `apps/web/src/server/org.ts`
- Create: `apps/web/src/lib/catalogFilters.ts`
- Create: `apps/web/src/app/api/org/catalog/route.ts`, `apps/web/src/app/api/org/templates/[templateId]/profile/route.ts`, `apps/web/src/app/api/org/templates/[templateId]/overrides/route.ts`, `apps/web/src/app/api/org/templates/[templateId]/overrides/[field]/route.ts`
- Test: `apps/web/test/integration/workforce-catalog.test.ts` (new), `apps/web/test/integration/server-org.test.ts`, `apps/web/test/refusal-status.test.ts`

**Interfaces:**
- Consumes from Task 2: `listWorkforceCatalog(filters?)`, `readTemplateProfile(templateId)`, `setProfileOverrides(templateId, patch, actor)`, `clearProfileOverride(templateId, field, actor)`, `type WorkforceCatalogRow/Facets/Filters`, the three refusal kinds.
- Produces, for Tasks 4–5:
  - `interface CatalogRowView` — `WorkforceCatalogRow` with `importedAt: string | null` (ISO)
  - `interface WorkforceCatalogView { rows: readonly CatalogRowView[]; facets: WorkforceCatalogFacets }`
  - `listWorkforceCatalogPage(filters?): Promise<WorkforceCatalogView>` and `listTemplates(): Promise<readonly CatalogRowView[]>` in `apps/web/src/server/org.ts`
  - `interface TemplateProfileViewJson { templateId; name; upstream; overrides; effective; markdown; rawOverride; overridden }` and `readTemplateProfileView(templateId)`
  - `apps/web/src/lib/catalogFilters.ts`: `CATALOG_SOURCES = ['imported', 'local'] as const`, `parseCatalogFilters(params: URLSearchParams): WorkforceCatalogFilters`, `catalogFilterParams(filters: WorkforceCatalogFilters): URLSearchParams`
  - Routes: `GET /api/org/catalog?q&division&capability&source&skill` → `WorkforceCatalogView`; `GET /api/org/templates/:id/profile` → `TemplateProfileViewJson`; `PATCH /api/org/templates/:id/overrides` (body `{ patch: object }`); `DELETE /api/org/templates/:id/overrides/:field`

- [ ] **Step 1: Write the failing test for the filter vocabulary**

Create `apps/web/test/catalog-filters.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { catalogFilterParams, parseCatalogFilters } from '../src/lib/catalogFilters.js'

describe('parseCatalogFilters', () => {
  it('reads the five dimensions the catalog filters on', () => {
    const params = new URLSearchParams('q=builder&division=engineering&capability=Design%20the%20boundary&source=imported&skill=writing-plans')
    expect(parseCatalogFilters(params)).toEqual({
      q: 'builder',
      division: 'engineering',
      capability: 'Design the boundary',
      source: 'imported',
      skill: 'writing-plans',
    })
  })

  it('drops a blank value and an unknown source rather than refusing the whole request', () => {
    expect(parseCatalogFilters(new URLSearchParams('q=%20%20&source=sideways'))).toEqual({})
  })

  it('round-trips through catalogFilterParams, and writes nothing for an empty filter', () => {
    const filters = { q: 'builder', source: 'local' as const }
    expect(parseCatalogFilters(catalogFilterParams(filters))).toEqual(filters)
    expect(catalogFilterParams({}).toString()).toBe('')
  })
})
```

- [ ] **Step 2: Run it and watch it fail, then write `apps/web/src/lib/catalogFilters.ts`**

Run: `npx vitest run --project unit apps/web/test/catalog-filters.test.ts` → FAIL (module missing).

```ts
import type { WorkforceCatalogFilters } from '@slave-of-ai/control'

/**
 * The Workforce Catalog's URL vocabulary (M46 R6) -- five params, parsed the same way by the route
 * and by the client hook, the `activityFilters.ts` precedent. Pure: no prisma, no React.
 *
 * LENIENT, unlike the activity timeline's `?types=`. A stale or hand-edited link is a link somebody
 * shared before a capability was renamed; dropping the token it no longer knows renders a page with
 * one fewer filter, and refusing the whole request renders an error where a catalog belongs.
 */
export const CATALOG_SOURCES = ['imported', 'local'] as const

export type CatalogSource = (typeof CATALOG_SOURCES)[number]

function text(params: URLSearchParams, key: string): string | undefined {
  const raw = (params.get(key) ?? '').trim()
  return raw === '' ? undefined : raw
}

export function parseCatalogFilters(params: URLSearchParams): WorkforceCatalogFilters {
  const source = text(params, 'source')
  return {
    ...(text(params, 'q') !== undefined ? { q: text(params, 'q') as string } : {}),
    ...(text(params, 'division') !== undefined ? { division: text(params, 'division') as string } : {}),
    ...(text(params, 'capability') !== undefined ? { capability: text(params, 'capability') as string } : {}),
    ...(source !== undefined && (CATALOG_SOURCES as readonly string[]).includes(source)
      ? { source: source as CatalogSource }
      : {}),
    ...(text(params, 'skill') !== undefined ? { skill: text(params, 'skill') as string } : {}),
  }
}

export function catalogFilterParams(filters: WorkforceCatalogFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.q !== undefined) params.set('q', filters.q)
  if (filters.division !== undefined) params.set('division', filters.division)
  if (filters.capability !== undefined) params.set('capability', filters.capability)
  if (filters.source !== undefined) params.set('source', filters.source)
  if (filters.skill !== undefined) params.set('skill', filters.skill)
  return params
}
```

Re-run: PASS.

- [ ] **Step 3: Write the failing integration test for the read model and the routes**

Create `apps/web/test/integration/workforce-catalog.test.ts`:

```ts
import { importCatalog, setProfile, setProfileOverrides } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { listTemplates, listWorkforceCatalogPage, readTemplateProfileView } from '../../src/server/org.js'

const CATALOG = 'catalog-m46'

const persona = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${name} does one thing well.\n---\n\n# ${name}\n\n${body}\n`

const entry = (slug: string, name: string, body: string) => ({
  sourceId: `${CATALOG}/engineering/${slug}`,
  division: 'engineering',
  slug,
  path: `/tmp/${CATALOG}/engineering/${slug}.md`,
  text: persona(name, body),
})

describe('the workforce catalog read model', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
    await importCatalog(
      {
        catalog: CATALOG,
        directory: `/tmp/${CATALOG}`,
        entries: [
          entry('core-builder', 'Core Builder', '## Core Capabilities\n- Design the module boundary\n\n## Domain Expertise\n- Load-bearing code\n'),
          entry('verifier', 'Verifier', '## Core Capabilities\n- Run the work back\n'),
        ],
        revision: 'rev1',
        license: 'MIT',
      },
      'operator',
    )
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })
  })

  it('hands the page ISO timestamps and the facets computed over every row', async (): Promise<void> => {
    const page = await listWorkforceCatalogPage()

    expect(page.rows.map((row) => row.name)).toEqual(['Core Builder', 'Hand Made', 'Verifier'])
    const core = page.rows.find((row) => row.name === 'Core Builder')
    expect(typeof core?.importedAt).toBe('string')
    expect(core?.sourceRevision).toBe('rev1')
    expect(core?.sourceLicense).toBe('MIT')
    expect(page.facets.capabilities).toEqual(['Design the module boundary', 'Run the work back'])
  })

  it('filters, and listTemplates is the unfiltered rows of the same read', async (): Promise<void> => {
    expect((await listWorkforceCatalogPage({ source: 'local' })).rows.map((row) => row.name)).toEqual(['Hand Made'])
    expect((await listTemplates()).map((row) => row.name)).toEqual(['Core Builder', 'Hand Made', 'Verifier'])
  })

  it('reads one template’s whole profile, and reports a raw Markdown override', async (): Promise<void> => {
    const core = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'Core Builder' } })
    await setProfileOverrides(core.id, { summary: 'Mine.' }, 'operator')

    const view = await readTemplateProfileView(core.id)
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.value.effective?.summary).toBe('Mine.')
    expect(view.value.overridden).toEqual(['summary'])
    expect(view.value.rawOverride).toBe(false)

    await setProfile({ templateId: core.id }, 'my own words', 'operator')
    const after = await readTemplateProfileView(core.id)
    expect(after.ok && after.value.rawOverride).toBe(true)
  })
})
```

- [ ] **Step 4: Run it and watch it fail, then widen `apps/web/src/server/org.ts`**

Run: `npx vitest run --project integration apps/web/test/integration/workforce-catalog.test.ts` → FAIL.

Replace `listTemplates`'s body and add the two new readers (the old inline `findMany` +
`groupBy` goes away — that query now lives in control, once, for both entry points):

```ts
/** One catalog row as a `'use client'` component receives it: `WorkforceCatalogRow` with its one
 *  `Date` turned into an ISO string, `GoalVersionView.createdAt`'s idiom. */
export type CatalogRowView = Omit<WorkforceCatalogRow, 'importedAt'> & { readonly importedAt: string | null }

export interface WorkforceCatalogView {
  readonly rows: readonly CatalogRowView[]
  readonly facets: WorkforceCatalogFacets
}

/**
 * The Workforce Catalog page and its route (M46 R6), over ONE read: `listWorkforceCatalog` already
 * does the `findMany` plus the `companySlave.groupBy` that `listTemplates` used to do here, and
 * doing it twice on a page that renders both the catalog and the company manager would be two
 * queries for one answer.
 */
export async function listWorkforceCatalogPage(filters: WorkforceCatalogFilters = {}): Promise<WorkforceCatalogView> {
  const page = await listWorkforceCatalog(filters)
  return {
    rows: page.rows.map((row) => ({ ...row, importedAt: row.importedAt === null ? null : row.importedAt.toISOString() })),
    facets: page.facets,
  }
}

/** Every slave template, unfiltered -- the shape `CompanyManager`'s member `<select>` and the New
 *  slave drawer take. A superset of what they read since M46; nothing they used has moved. */
export async function listTemplates(): Promise<readonly CatalogRowView[]> {
  return (await listWorkforceCatalogPage()).rows
}

/** One template's whole specialist profile, for the drawer (plan erratum E10): far too much to put
 *  on every catalog row, and exactly what one open drawer needs. */
export async function readTemplateProfileView(
  templateId: string,
): Promise<Result<TemplateProfileView, ControlRefusal>> {
  return readTemplateProfile(templateId)
}
```

with `listWorkforceCatalog`, `readTemplateProfile`, `type ControlRefusal`, `type Result`,
`type TemplateProfileView`, `type WorkforceCatalogFacets`, `type WorkforceCatalogFilters`,
`type WorkforceCatalogRow` added to the `@slave-of-ai/control` import at the top of the file.

Re-run: PASS.

- [ ] **Step 5: Fix `server-org.test.ts`'s whole-object assertions (E18)**

`apps/web/test/integration/server-org.test.ts:606-666` compares `listTemplates()`'s rows with
`toEqual` on complete literals, so every field added above must appear there. Change the two
literals to `expect.objectContaining({ ... })` keeping every key they already assert, and add one
case that is about the new fields rather than smuggling them into an old one:

```ts
    it('carries the structured facets of an imported template, and none for a hand-made one', async (): Promise<void> => {
      await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })
      await prisma.slaveTemplate.create({
        data: {
          name: 'Core Builder',
          role: 'engineering',
          sourceId: 'catalog-m46/engineering/core-builder',
          sourceSha256: 'abc',
          sourceDivision: 'engineering',
          sourceRevision: 'rev1',
          sourceLicense: 'MIT',
          importedAt: new Date('2026-09-11T09:00:00.000Z'),
          profileSpec: {
            identity: 'i', summary: 'Builds the core module.', mission: '', runtimeRole: 'engineering',
            capabilities: ['Design the module boundary'], expertise: [], operatingPrinciples: [],
            constraints: [], workflow: [], deliverables: [], successCriteria: [], collaborationHints: [],
            recommendedSkills: [], body: 'b',
            source: { repository: 'catalog-m46', path: 'engineering/core-builder.md', revision: 'rev1', license: 'MIT', importedAt: '2026-09-11T09:00:00.000Z', mappingQuality: 'partial' },
          },
        },
      })

      const rows = await listTemplates()

      const core = rows.find((row) => row.name === 'Core Builder')
      expect(core?.structured).toBe(true)
      expect(core?.source).toBe('imported')
      expect(core?.summary).toBe('Builds the core module.')
      expect(core?.capabilities).toEqual(['Design the module boundary'])
      expect(core?.mappingQuality).toBe('partial')
      expect(core?.sourceLicense).toBe('MIT')
      const handMade = rows.find((row) => row.name === 'Hand Made')
      expect(handMade?.structured).toBe(false)
      expect(handMade?.source).toBe('local')
      expect(handMade?.capabilities).toEqual([])
      expect(handMade?.mappingQuality).toBeNull()
    })
```

Run: `npx vitest run --project integration apps/web/test/integration/server-org.test.ts` → PASS.

- [ ] **Step 6: Add the three refusal kinds to `ALL_KINDS`**

In `apps/web/test/refusal-status.test.ts`, add to the `ALL_KINDS` record (it is a
`Record<ControlRefusal['kind'], true>`, so the file does not compile until these are there):

```ts
  profile_not_structured: true,
  invalid_profile_overrides: true,
  unknown_profile_field: true,
```

and, in the same file's per-kind expectations, assert all three are 409 (none ends in
`_not_found`).

Run: `npx vitest run --project unit apps/web/test/refusal-status.test.ts` → PASS.

- [ ] **Step 7: Write the four routes**

`apps/web/src/app/api/org/catalog/route.ts`:

```ts
import { listWorkforceCatalogPage } from '../../../../server/org'
import { parseCatalogFilters } from '../../../../lib/catalogFilters'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Workforce Catalog, filtered (M46 R6). A GET with the five params `catalogFilters.ts`
 *  parses; the facets come back whole so the filter menus never collapse to what is selected. */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const filters = parseCatalogFilters(new URL(request.url).searchParams)
  return Response.json(await listWorkforceCatalogPage(filters))
}
```

`apps/web/src/app/api/org/templates/[templateId]/profile/route.ts`:

```ts
import { readTemplateProfileView } from '../../../../../../server/org'
import { refusalStatus } from '../../../../../../server/refusalStatus'
import { refusalText } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** One template's whole specialist profile, for `ProfileDrawer` (plan erratum E10). Read-only. */
export async function GET(_request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const result = await readTemplateProfileView(templateId)
  if (!result.ok) return Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
  return Response.json(result.value)
}
```

`apps/web/src/app/api/org/templates/[templateId]/overrides/route.ts`:

```ts
import { setProfileOverrides } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * `ProfileDrawer`'s Customise mode (M46 R2): a PARTIAL patch of the profile's fields, merged into
 * whatever is already overridden. The verb validates the shape against `profileOverridesSchema` --
 * this shell only insists on an object, so the ONE definition of the shape stays in the domain.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object' || !('patch' in body) || typeof body.patch !== 'object' || body.patch === null) {
    return Response.json({ error: 'the body must be { "patch": { <profile field>: … } }' }, { status: 400 })
  }
  return orgControlResponse(() => setProfileOverrides(templateId, body.patch, gate.principal ?? 'web'))
}
```

`apps/web/src/app/api/org/templates/[templateId]/overrides/[field]/route.ts`:

```ts
import { clearProfileOverride } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `Reset` on one field of `ProfileDrawer` (M46 R2): the field goes back to what the catalog says.
 *  A field name that is not one of the fourteen is the verb's `unknown_profile_field`, a 409 --
 *  not a 404, because the TEMPLATE was found and it is the field that is nonsense. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ templateId: string; field: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId, field } = await context.params
  return orgControlResponse(() => clearProfileOverride(templateId, field, gate.principal ?? 'web'))
}
```

- [ ] **Step 8: Full task verification**

```bash
npx tsc --build
npm run --silent typecheck
npx vitest run --project unit apps/web/test/catalog-filters.test.ts apps/web/test/refusal-status.test.ts
npx vitest run --project integration apps/web/test/integration/workforce-catalog.test.ts apps/web/test/integration/server-org.test.ts
npm run gate:m26-vocabulary
pgrep -af "next dev"    # must be empty; if not, kill it and SAY SO in the report
npm run web:build
```
Expected: all green, and `web:build` succeeds — it is the only thing that catches a route whose
relative import depth is wrong (four `../` where five are needed is a compile error only there).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/server/org.ts apps/web/src/lib/catalogFilters.ts apps/web/src/app/api/org/catalog \
        apps/web/src/app/api/org/templates apps/web/test/catalog-filters.test.ts \
        apps/web/test/integration/workforce-catalog.test.ts apps/web/test/integration/server-org.test.ts \
        apps/web/test/refusal-status.test.ts
git commit -m "$(cat <<'EOF'
feat(web): m46 t3 -- the catalog read model, its URL vocabulary and four routes

One read behind two entry points: `listWorkforceCatalogPage` filters in memory over the JSON column
and hands back the facets computed over EVERY row, before filtering -- a menu built from the
filtered rows collapses to the value already chosen, which makes it impossible to change your mind.
`listTemplates` is now its unfiltered rows, so the page that renders both the catalog and the
company manager makes one query where it used to make two.

The full effective profile is deliberately NOT on a row: three kilobytes times a few hundred
templates to draw a table. `GET /api/org/templates/:id/profile` reads the one row a drawer opened.

`PATCH …/overrides` takes a partial patch and `DELETE …/overrides/:field` takes one field back to
what the catalog says. Neither shell knows the shape of a profile: `profileOverridesSchema` in the
domain is the one definition, and the route insists only that a body is an object.

`?q&division&capability&source&skill` are parsed the same way by the route and (next task) by the
client, and leniently: a link shared before a capability was renamed renders a page with one fewer
filter rather than an error where a catalog belongs.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 4: The Workforce Catalog and the profile drawer (R6, E7, E8, E11, E13, E19)

**Files:**
- Modify: `apps/web/src/components/ui/DetailsGroup.tsx`, `apps/web/src/components/workforce/WorkforceClient.tsx`, `apps/web/src/app/workforce/page.tsx`, `apps/web/src/components/CompanyManager.tsx`, `apps/web/src/components/company/CompanyDetail.tsx`, `apps/web/src/components/company/TeamBlock.tsx`, `apps/web/src/components/slaves/NewSlaveDrawer.tsx`, `docs/ia.md`
- Create: `apps/web/src/components/workforce/TemplateForm.tsx`, `apps/web/src/components/workforce/CatalogFilterBar.tsx`, `apps/web/src/components/workforce/WorkforceCatalog.tsx`, `apps/web/src/components/workforce/ProfileDrawer.tsx`, `apps/web/src/hooks/useCatalogFilters.ts`
- Delete: `apps/web/src/components/TemplateCatalog.tsx`
- Test: `apps/web/test/workforce-catalog.test.tsx` (new), `apps/web/test/workforce-page.test.tsx`, `apps/web/test/settings-page.test.tsx`

**Interfaces:**
- Consumes from Task 3: `CatalogRowView`, `WorkforceCatalogView`, `TemplateProfileView`, `parseCatalogFilters`, `catalogFilterParams`, `CATALOG_SOURCES`; the four routes.
- Consumes from Task 1: `PROFILE_SPEC_FIELDS`, `PROFILE_FIELD_LABEL`, `PROFILE_FIELD_KIND`, `MAPPING_QUALITY_LABEL`, `type ProfileSpec`, `type ProfileSpecField`, `type ProfileOverrides`.
- Produces, for Task 5, the testids the gate drives: `workforce-catalog`, `catalog-search`, `catalog-source-chip-imported` / `-local`, `catalog-division-select`, `catalog-capability-select`, `catalog-skill-select`, `catalog-clear-filters`, `catalog-count`, `catalog-row-<templateId>` (also a `data-table-row`), `catalog-capability-chip`, `catalog-capability-more`, `catalog-source-<templateId>`, `catalog-overridden-<templateId>`, `catalog-raw-override-<templateId>`, `catalog-empty`, `profile-drawer`, `profile-drawer-title`, `profile-customise`, `profile-field-<field>`, `profile-field-input-<field>`, `profile-field-save-<field>`, `profile-field-reset-<field>`, `profile-field-overridden-<field>`, `profile-advanced`, `profile-markdown`, `profile-raw-input`, `profile-raw-save`, `profile-error`, plus the unchanged `template-form`, `template-delete`, `company-form`, `catalog-imports`, and the tab's `catalog-advanced`.

- [ ] **Step 1: Widen `DetailsGroupName` (E8)**

In `apps/web/src/components/ui/DetailsGroup.tsx`, replace the union with:

```ts
export type DetailsGroupName =
  // M45 R4: the ten groups a task or a worker panel shows.
  | 'run'
  | 'model'
  | 'profile'
  | 'skills'
  | 'messages'
  | 'context'
  | 'verification'
  | 'cost'
  | 'worktree'
  | 'events'
  // M46 R6: the twelve a specialist profile shows. `skills` above is reused -- one group name for
  // one idea, because the gate reads `data-group` and two spellings would be two groups to it.
  | 'identity'
  | 'mission'
  | 'capabilities'
  | 'expertise'
  | 'principles'
  | 'constraints'
  | 'workflow'
  | 'deliverables'
  | 'success'
  | 'collaboration'
  | 'source'
  | 'advanced'
```

and update the docblock's "ten groups" sentence to say ten from M45 and twelve from M46, `skills`
shared.

- [ ] **Step 2: Move the template form out of `TemplateCatalog` unchanged**

Create `apps/web/src/components/workforce/TemplateForm.tsx` holding, VERBATIM, the `TemplateRow`
interface and the `<form data-testid="template-form">` element of today's
`apps/web/src/components/TemplateCatalog.tsx` — every testid, every label, every class string and
the whole `submit()` including its `router.refresh()`. The component signature is:

```ts
export function TemplateForm({ onCreated }: { readonly onCreated?: () => void }): React.JSX.Element
```

with `onCreated?.()` called beside `router.refresh()` on a 200, so `WorkforceCatalog` can refetch
its own rows (they come from `/api/org/catalog`, not from the refreshed page prop). Its docblock
says where it came from and why it stayed:

```
/**
 * Adding a template by hand (M11 Task 9, moved here by M46 R6).
 *
 * The Workforce Catalog replaced the TABLE this form used to sit under, not the form: a template
 * an operator types in has no persona file to be mapped from, and `gate:m11-shell` drives exactly
 * these fields on `/workforce?tab=catalog`. Every testid is the one it had.
 */
```

Delete `apps/web/src/components/TemplateCatalog.tsx` and repoint its four type importers to
`../workforce/TemplateForm` / `./workforce/TemplateForm` — an import path each, nothing else:
`CompanyManager.tsx`, `company/CompanyDetail.tsx`, `company/TeamBlock.tsx`,
`slaves/NewSlaveDrawer.tsx`. Update the two docblock mentions in
`apps/web/src/components/ProviderSelect.tsx`, `apps/web/src/lib/postControl.ts` and
`apps/web/src/app/api/org/templates/[templateId]/route.ts` to say `WorkforceCatalog`.

- [ ] **Step 3: Write the URL filter hook (E11)**

Create `apps/web/src/hooks/useCatalogFilters.ts`:

```ts
'use client'

import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { WorkforceCatalogFilters } from '@slave-of-ai/control'
import { catalogFilterParams, parseCatalogFilters } from '../lib/catalogFilters'

/**
 * The catalog's five filters, carried in the URL (M46 R6).
 *
 * `window.history.replaceState`, NOT `router.replace` (plan erratum E11). `/workforce` is
 * `force-dynamic` with eight loaders, one of which scans the skills directories on disk;
 * `router.replace` re-runs all eight. `WorkforceClient` already records this reasoning for its
 * `?tab=` writes, and a keystroke in a search box is a far worse thing to re-run them for than a
 * tab click. The state that renders is React state, seeded once from the URL; the URL write is a
 * side effect so a reload or a shared link restores the same view.
 *
 * MERGED into the current query, never a bare `?q=`: dropping `?tab=catalog` would send a shared
 * link to the Slaves tab.
 */
export function useCatalogFilters(): {
  readonly filters: WorkforceCatalogFilters
  readonly setFilters: (next: WorkforceCatalogFilters) => void
} {
  const searchParams = useSearchParams()
  const [filters, setFiltersState] = useState<WorkforceCatalogFilters>(() =>
    parseCatalogFilters(new URLSearchParams(searchParams.toString())),
  )

  const setFilters = useCallback((next: WorkforceCatalogFilters): void => {
    setFiltersState(next)
    const query = new URLSearchParams(window.location.search)
    for (const key of ['q', 'division', 'capability', 'source', 'skill']) query.delete(key)
    for (const [key, value] of catalogFilterParams(next)) query.set(key, value)
    const text = query.toString()
    window.history.replaceState(null, '', text === '' ? '/workforce' : `/workforce?${text}`)
  }, [])

  return { filters, setFilters }
}
```

- [ ] **Step 4: Write the failing component test**

Create `apps/web/test/workforce-catalog.test.tsx`. It absorbs `settings-page.test.tsx`'s
`describe('TemplateCatalog')` block (the row cells, the `—` fallbacks, the provider cell and the
`template-delete` confirm), retargeted at `WorkforceCatalog`/`TemplateForm`, and adds the M46
cases.

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogRowView, WorkforceCatalogView } from '../src/server/org.js'
import { WorkforceCatalog } from '../src/components/workforce/WorkforceCatalog.js'

const routerRefresh = vi.fn()
const replaceState = vi.fn()
let search = ''

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
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
    sourceId: 'catalog-m46/engineering/core-builder',
    sourceDivision: 'engineering',
    importedAt: '2026-09-11T09:00:00.000Z',
    sourceRepository: 'catalog-m46',
    sourceRevision: '0f1e2d3',
    sourceLicense: 'MIT',
    source: 'imported',
    structured: true,
    summary: 'Builds the core module and the tests that hold it up.',
    capabilities: ['Design the module boundary', 'Write the test first', 'Delete what nobody calls', 'Read a build back'],
    expertise: ['Load-bearing code'],
    recommendedSkills: ['writing-plans'],
    mappingQuality: 'full',
    overriddenFields: [],
    rawOverride: false,
    ...over,
  }
}

const view = (rows: readonly CatalogRowView[]): WorkforceCatalogView => ({
  rows,
  facets: {
    divisions: ['engineering', 'testing'],
    capabilities: ['Design the module boundary', 'Run the work back'],
    skills: ['writing-plans'],
  },
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  search = ''
  routerRefresh.mockClear()
  replaceState.mockClear()
  vi.stubGlobal('history', { replaceState })
  fetchMock = vi.fn(async () => new Response(JSON.stringify(view([row()])), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkforceCatalog rows', () => {
  it('renders a row per template: name, summary, division, three capability chips and a +N', () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    const line = screen.getByTestId('catalog-row-t1')
    expect(within(line).getByText('Core Builder')).toBeTruthy()
    expect(line.textContent).toContain('Builds the core module and the tests that hold it up.')
    expect(within(line).getAllByTestId('catalog-capability-chip')).toHaveLength(3)
    expect(within(line).getByTestId('catalog-capability-more').textContent).toBe('+1')
  })

  it('marks where a row came from, and says local for a hand-made template', () => {
    render(
      <WorkforceCatalog
        initial={view([
          row(),
          row({ id: 't2', name: 'Hand Made', source: 'local', structured: false, sourceId: null, sourceDivision: null, sourceRepository: null, importedAt: null, capabilities: [], mappingQuality: null }),
        ])}
      />,
    )

    expect(screen.getByTestId('catalog-source-t1').textContent).toBe('imported · catalog-m46')
    expect(screen.getByTestId('catalog-source-t2').textContent).toBe('local')
  })

  it('marks a customised row and a raw Markdown override separately', () => {
    render(
      <WorkforceCatalog
        initial={view([row({ overriddenFields: ['constraints'] }), row({ id: 't2', name: 'Verifier', rawOverride: true })])}
      />,
    )

    expect(screen.getByTestId('catalog-overridden-t1').textContent).toBe('customised')
    expect(screen.queryByTestId('catalog-overridden-t2')).toBeNull()
    expect(screen.getByTestId('catalog-raw-override-t2').textContent).toBe('raw override')
  })

  it('shows the default model and provider, and a dash where there is none', () => {
    render(<WorkforceCatalog initial={view([row({ defaultModel: 'claude-sonnet-4', defaultProvider: 'cursor' }), row({ id: 't2' })])} />)

    expect(within(screen.getByTestId('catalog-row-t1')).getByText('claude-sonnet-4 · cursor')).toBeTruthy()
    expect(within(screen.getByTestId('catalog-row-t2')).getByText('—')).toBeTruthy()
  })

  it('never prints a bare mapping-quality token as visible text (docs/ia.md rule 3)', () => {
    render(<WorkforceCatalog initial={view([row({ mappingQuality: 'partial' })])} />)
    const line = screen.getByTestId('catalog-row-t1')
    expect(line.textContent).not.toContain('partial')
    expect(line.getAttribute('data-mapping-quality')).toBe('partial')
  })

  it('says so when nothing matches, without pretending the catalog is empty', () => {
    render(<WorkforceCatalog initial={view([])} />)
    expect(screen.getByTestId('catalog-empty')).toBeTruthy()
  })
})

describe('WorkforceCatalog filters', () => {
  it('fetches the filtered catalog and writes the search into the URL without a router push', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'builder' } })
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog?q=builder'))
    expect(replaceState).toHaveBeenCalledWith(null, '', '/workforce?q=builder')
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('toggles a source chip on and off', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-source-chip-local'))
    })
    expect(screen.getByTestId('catalog-source-chip-local').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog?source=local'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-source-chip-local'))
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog'))
  })

  it('opens with the filters the URL arrived with', async () => {
    search = 'tab=catalog&capability=Run+the+work+back'
    render(<WorkforceCatalog initial={view([row()])} />)

    expect((screen.getByTestId('catalog-capability-select') as HTMLSelectElement).value).toBe('Run the work back')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog?capability=Run+the+work+back'))
  })
})

describe('ProfileDrawer', () => {
  const profile = {
    templateId: 't1',
    name: 'Core Builder',
    upstream: {
      identity: 'The slave that lays the load-bearing parts first.',
      summary: 'Builds the core module.',
      mission: 'Put the load-bearing parts in first.',
      runtimeRole: 'engineering',
      capabilities: ['Design the module boundary'],
      expertise: ['Load-bearing code'],
      operatingPrinciples: ['Small commits, each one green'],
      constraints: ['You MUST never leave a red test behind'],
      workflow: ['Step 1: read the brief back'],
      deliverables: ['A module and its tests'],
      successCriteria: ['Every commit green'],
      collaborationHints: ['Hand off to the Gate Verifier'],
      recommendedSkills: ['writing-plans'],
      body: 'You write the module everything else stands on.',
      source: {
        repository: 'catalog-m46',
        path: 'engineering/core-builder.md',
        revision: '0f1e2d3',
        license: 'MIT',
        importedAt: '2026-09-11T09:00:00.000Z',
        mappingQuality: 'full' as const,
      },
    },
    overrides: {},
    effective: null as never,
    markdown: '## Who you are\nThe slave that lays the load-bearing parts first.',
    rawOverride: false,
    overridden: [] as readonly string[],
  }
  const withEffective = { ...profile, effective: profile.upstream }

  const openDrawer = async (over: Partial<typeof withEffective> = {}) => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/profile')
        ? new Response(JSON.stringify({ ...withEffective, ...over }), { status: 200 })
        : new Response(JSON.stringify(view([row()])), { status: 200 }),
    )
    render(<WorkforceCatalog initial={view([row()])} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-row-t1'))
    })
    await waitFor(() => expect(screen.getByTestId('profile-drawer')).toBeTruthy())
  }

  it('opens on a row and shows every field group with its label', async () => {
    await openDrawer()

    expect(screen.getByTestId('profile-drawer-title').textContent).toBe('Core Builder')
    const groups = screen.getAllByTestId('details-group').map((node) => node.getAttribute('data-group'))
    expect(groups).toEqual([
      'identity', 'mission', 'capabilities', 'expertise', 'principles', 'constraints',
      'workflow', 'deliverables', 'success', 'collaboration', 'skills', 'source', 'advanced',
    ])
  })

  it('keeps the raw Markdown inside Advanced and nowhere else (R6)', async () => {
    await openDrawer()
    expect(screen.queryByTestId('profile-markdown')).toBeNull()

    await act(async () => {
      fireEvent.click(within(screen.getByTestId('profile-drawer')).getByText('Advanced'))
    })

    expect(screen.getByTestId('profile-markdown').textContent).toContain('## Who you are')
    expect(screen.getByTestId('profile-raw-input')).toBeTruthy()
  })

  it('customises one field into an override and PATCHes only that field', async () => {
    await openDrawer()

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId('profile-field-input-constraints'), {
        target: { value: 'You MUST ship behind a flag' },
      })
      fireEvent.click(screen.getByTestId('profile-field-save-constraints'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates/t1/overrides',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ patch: { constraints: ['You MUST ship behind a flag'] } }),
      }),
    )
  })

  it('badges an overridden field and offers Reset, which DELETEs it', async () => {
    await openDrawer({ overrides: { constraints: ['Mine'] }, overridden: ['constraints'] })
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })

    expect(screen.getByTestId('profile-field-overridden-constraints')).toBeTruthy()
    expect(screen.queryByTestId('profile-field-overridden-workflow')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-field-reset-constraints'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/org/templates/t1/overrides/constraints',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('shows the refusal text beside the field when the write is declined', async () => {
    await openDrawer()
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/overrides')
        ? new Response(JSON.stringify({ error: 'these profile changes cannot be stored: capabilities expected array' }), { status: 409 })
        : new Response(JSON.stringify(withEffective), { status: 200 }),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-customise'))
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-field-save-constraints'))
    })

    await waitFor(() => expect(screen.getByTestId('profile-error').textContent).toContain('cannot be stored'))
  })

  it('shows the source record, licence and revision included', async () => {
    await openDrawer()
    const source = screen.getAllByTestId('details-group').find((node) => node.getAttribute('data-group') === 'source')
    expect(source?.textContent).toContain('catalog-m46')
    expect(source?.textContent).toContain('0f1e2d3')
    expect(source?.textContent).toContain('MIT')
    expect(source?.textContent).toContain('mapped in full')
  })

  it('offers no Customise on a template with no structured profile', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/profile')
        ? new Response(JSON.stringify({ ...withEffective, upstream: null, effective: null }), { status: 200 })
        : new Response(JSON.stringify(view([row({ structured: false })])), { status: 200 }),
    )
    render(<WorkforceCatalog initial={view([row({ structured: false })])} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-row-t1'))
    })
    await waitFor(() => expect(screen.getByTestId('profile-drawer')).toBeTruthy())

    expect(screen.queryByTestId('profile-customise')).toBeNull()
    expect(screen.getByTestId('profile-unstructured').textContent).toContain('has not been mapped')
  })
})

describe('the hand-made template form, kept on the tab', () => {
  it('creates a template and refetches the catalog', async () => {
    render(<WorkforceCatalog initial={view([row()])} />)
    fetchMock.mockClear()

    fireEvent.change(screen.getByTestId('template-name-input'), { target: { value: 'Hand Made' } })
    fireEvent.change(screen.getByTestId('template-role-input'), { target: { value: 'backend' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('template-submit'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/org/templates', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/org/catalog'))
  })

  it('asks twice before deleting, naming the catalog-slave count', async () => {
    render(<WorkforceCatalog initial={view([row({ catalogSlaveCount: 3, name: 'Backend Developer' })])} />)

    fireEvent.click(screen.getByTestId('template-delete'))
    expect(screen.getByTestId('template-delete-confirm').textContent).toBe(
      'deletes Backend Developer and its 3 catalog slaves; project slaves keep their role',
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('template-delete-confirm'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/templates/t1', expect.objectContaining({ method: 'DELETE' }))
  })
})
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run --project unit apps/web/test/workforce-catalog.test.tsx`
Expected: FAIL — `WorkforceCatalog` does not exist.

- [ ] **Step 6: Write `CatalogFilterBar`**

Create `apps/web/src/components/workforce/CatalogFilterBar.tsx`:

```tsx
'use client'

import type { WorkforceCatalogFacets, WorkforceCatalogFilters } from '@slave-of-ai/control'
import { CATALOG_SOURCES, type CatalogSource } from '../../lib/catalogFilters'
import { Button } from '../ui/Button'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'

/** docs/ia.md rule 3 -- the chip says a word, `data-source` keeps the value. */
const SOURCE_LABEL: Record<CatalogSource, string> = {
  imported: 'Imported',
  local: 'Made here',
}

/**
 * The catalog's filter row (M46 R6), shaped like `activity/FilterBar.tsx`: coarse chips for the
 * facet with two values, a `<select>` for each facet that is a list. No new dependency and no
 * combobox -- the facets come back sorted and a division list is short enough to scan.
 */
export function CatalogFilterBar({
  filters,
  facets,
  onChange,
}: {
  readonly filters: WorkforceCatalogFilters
  readonly facets: WorkforceCatalogFacets
  readonly onChange: (next: WorkforceCatalogFilters) => void
}): React.JSX.Element {
  const set = (patch: WorkforceCatalogFilters): void => onChange({ ...filters, ...patch })
  const drop = (key: keyof WorkforceCatalogFilters): void => {
    const next = { ...filters }
    delete next[key]
    onChange(next)
  }
  const select = (key: 'division' | 'capability' | 'skill', label: string, options: readonly string[]) => (
    <label className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <select
        data-testid={`catalog-${key}-select`}
        aria-label={label}
        value={filters[key] ?? ''}
        onChange={(event) => (event.target.value === '' ? drop(key) : set({ [key]: event.target.value }))}
        className={`w-44 ${INPUT_SHELL}`}
      >
        <option value="">any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
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
          value={filters.q ?? ''}
          placeholder="name, summary, capability, expertise"
          onChange={(event) => (event.target.value === '' ? drop('q') : set({ q: event.target.value }))}
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
            onClick={() => (filters.source === source ? drop('source') : set({ source }))}
            className={`rounded-bubble border px-[9px] py-[3px] font-mono text-[10px] font-medium transition-colors ${
              filters.source === source ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
            }`}
          >
            {SOURCE_LABEL[source]}
          </button>
        ))}
      </div>
      {select('division', 'Division', facets.divisions)}
      {select('capability', 'Capability', facets.capabilities)}
      {select('skill', 'Skill', facets.skills)}
      {filtered && (
        <Button variant="ghost" size="sm" data-testid="catalog-clear-filters" onClick={() => onChange({})}>
          Clear filters
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Write `ProfileDrawer`**

Create `apps/web/src/components/workforce/ProfileDrawer.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import {
  MAPPING_QUALITY_LABEL,
  PROFILE_FIELD_KIND,
  PROFILE_FIELD_LABEL,
  PROFILE_SPEC_FIELDS,
  type ProfileSpec,
  type ProfileSpecField,
} from '@slave-of-ai/domain'
import type { TemplateProfileView } from '@slave-of-ai/control'
import { sendControl } from '../../lib/postControl'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DetailsGroup, type DetailsGroupName } from '../ui/DetailsGroup'
import { Drawer } from '../ui/Drawer'
import { EmptyState } from '../ui/EmptyState'
import { LoadingState } from '../ui/LoadingState'
import { INPUT_SHELL } from '../ui/FormControls'

/** Which `DetailsGroup` each profile field renders inside. `runtimeRole` joins `identity` -- it is
 *  the one field the renderer never puts in a prompt (plan erratum E3), and it belongs beside who
 *  the worker is rather than in a group of its own. `body` is Advanced. */
const GROUP_BY_FIELD: Record<ProfileSpecField, DetailsGroupName> = {
  identity: 'identity',
  summary: 'identity',
  runtimeRole: 'identity',
  mission: 'mission',
  capabilities: 'capabilities',
  expertise: 'expertise',
  operatingPrinciples: 'principles',
  constraints: 'constraints',
  workflow: 'workflow',
  deliverables: 'deliverables',
  successCriteria: 'success',
  collaborationHints: 'collaboration',
  recommendedSkills: 'skills',
  body: 'advanced',
}

/** The order R6 names, and the title each group carries. Exhaustive by construction: a group added
 *  to `DetailsGroupName` and not to this list simply does not render, and a title missing from it
 *  fails the build. */
const GROUPS: readonly { readonly group: DetailsGroupName; readonly title: string }[] = [
  { group: 'identity', title: 'Identity' },
  { group: 'mission', title: 'Mission' },
  { group: 'capabilities', title: 'Capabilities' },
  { group: 'expertise', title: 'Expertise' },
  { group: 'principles', title: 'Principles' },
  { group: 'constraints', title: 'Constraints' },
  { group: 'workflow', title: 'Workflow' },
  { group: 'deliverables', title: 'Deliverables' },
  { group: 'success', title: 'Success criteria' },
  { group: 'collaboration', title: 'Collaboration' },
  { group: 'skills', title: 'Skills' },
  { group: 'source', title: 'Source' },
]

const toText = (spec: ProfileSpec, field: ProfileSpecField): string => {
  const value = spec[field]
  return typeof value === 'string' ? value : value.join('\n')
}

/** One textarea per field, one item per line for a list. Not a chip editor: a list of short lines
 *  IS a textarea to anybody who has edited one, and a bespoke widget would be a second place for
 *  the 240-character rule to be enforced differently from the schema. */
const fromText = (field: ProfileSpecField, text: string): string | string[] =>
  PROFILE_FIELD_KIND[field] === 'text'
    ? text.trim()
    : text.split('\n').map((line) => line.trim()).filter((line) => line !== '')

/**
 * One template's specialist profile, opened from a catalog row (M46 R6).
 *
 * Read mode shows twelve `DetailsGroup`s. `Customise` turns each field into a textarea with its own
 * Save and, where it is overridden, its own Reset -- one field at a time, because a "save
 * everything" button would send fields nobody touched and make every one of them an override.
 *
 * The raw Markdown lives under `Advanced` and only there. It is the text a run is actually given,
 * and putting the editor for it beside the structured fields would invite an operator to edit both
 * and lose one: a raw override WINS, and the row then says so.
 */
export function ProfileDrawer({
  templateId,
  name,
  onClose,
  onChanged,
}: {
  readonly templateId: string
  readonly name: string
  readonly onClose: () => void
  readonly onChanged: () => void
}): React.JSX.Element {
  const [state, setState] = useState<
    { readonly kind: 'loading' } | { readonly kind: 'error' } | { readonly kind: 'ready'; readonly view: TemplateProfileView }
  >({ kind: 'loading' })
  const [customising, setCustomising] = useState(false)
  const [drafts, setDrafts] = useState<Partial<Record<ProfileSpecField, string>>>({})
  const [rawDraft, setRawDraft] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const load = (): void => {
    setState({ kind: 'loading' })
    void fetch(`/api/org/templates/${templateId}/profile`)
      .then(async (response) => (response.ok ? ((await response.json()) as TemplateProfileView) : null))
      .then((view) => {
        setState(view === null ? { kind: 'error' } : { kind: 'ready', view })
        setDrafts({})
        setRawDraft(null)
      })
      .catch(() => setState({ kind: 'error' }))
  }

  useEffect(load, [templateId])

  const after = (error: string | null): void => {
    setErrorText(error)
    if (error === null) {
      load()
      onChanged()
    }
  }

  const saveField = async (field: ProfileSpecField, spec: ProfileSpec): Promise<void> => {
    const text = drafts[field] ?? toText(spec, field)
    after(
      await sendControl(`/api/org/templates/${templateId}/overrides`, {
        method: 'PATCH',
        body: { patch: { [field]: fromText(field, text) } },
      }),
    )
  }

  const view = state.kind === 'ready' ? state.view : null
  const spec = view?.effective ?? null

  return (
    <Drawer open onClose={onClose} label={`Profile of ${name}`} testId="profile-drawer" width="w-[640px]">
      <div className="flex items-center justify-between gap-2">
        <h2 data-testid="profile-drawer-title" className="text-sm text-text-1">
          {name}
        </h2>
        {spec !== null && (
          <Button variant="ghost" size="sm" data-testid="profile-customise" onClick={() => setCustomising((now) => !now)}>
            {customising ? 'Done' : 'Customise'}
          </Button>
        )}
      </div>

      {state.kind === 'loading' && <LoadingState testId="profile-loading" message="opening this profile…" />}
      {state.kind === 'error' && (
        <Alert variant="error" testId="profile-load-error">
          could not open this profile. Try the row again.
        </Alert>
      )}
      {errorText !== null && (
        <Alert variant="error" testId="profile-error">
          {errorText}
        </Alert>
      )}

      {view !== null && spec === null && (
        <EmptyState
          testId="profile-unstructured"
          message="This template has not been mapped into a specialist profile: import its catalog, or edit its profile under Advanced."
        />
      )}

      {view !== null &&
        spec !== null &&
        GROUPS.map(({ group, title }) => (
          <DetailsGroup key={group} group={group} title={title} defaultOpen={group === 'identity'}>
            {group === 'source'
              ? (() => {
                  const source = spec.source
                  if (source === null) return <span className="text-xs text-text-3">made here; no source record.</span>
                  return (
                    <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs text-text-2">
                      <dt className="text-text-3">Repository</dt>
                      <dd className="font-mono">{source.repository}</dd>
                      <dt className="text-text-3">Path</dt>
                      <dd className="font-mono">{source.path}</dd>
                      <dt className="text-text-3">Revision</dt>
                      <dd className="font-mono">{source.revision ?? 'not a git checkout'}</dd>
                      <dt className="text-text-3">Licence</dt>
                      <dd className="font-mono">{source.license ?? 'none recorded'}</dd>
                      <dt className="text-text-3">Imported</dt>
                      <dd className="font-mono">{source.importedAt.slice(0, 10)}</dd>
                      <dt className="text-text-3">Mapping</dt>
                      <dd data-mapping-quality={source.mappingQuality}>{MAPPING_QUALITY_LABEL[source.mappingQuality]}</dd>
                    </dl>
                  )
                })()
              : PROFILE_SPEC_FIELDS.filter((field) => GROUP_BY_FIELD[field] === group).map((field) => {
                  const overridden = view.overridden.includes(field)
                  const value = spec[field]
                  return (
                    <div key={field} data-testid={`profile-field-${field}`} data-overridden={overridden} className="flex flex-col gap-1">
                      <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-3">
                        {PROFILE_FIELD_LABEL[field]}
                        {overridden && (
                          <Chip data-testid={`profile-field-overridden-${field}`}>customised</Chip>
                        )}
                      </span>
                      {customising ? (
                        <>
                          <textarea
                            data-testid={`profile-field-input-${field}`}
                            aria-label={PROFILE_FIELD_LABEL[field]}
                            rows={PROFILE_FIELD_KIND[field] === 'text' ? 2 : 4}
                            value={drafts[field] ?? toText(spec, field)}
                            onChange={(event) => setDrafts((now) => ({ ...now, [field]: event.target.value }))}
                            className={`w-full ${INPUT_SHELL}`}
                          />
                          <span className="flex gap-2">
                            <Button variant="ghost" size="sm" data-testid={`profile-field-save-${field}`} onClick={() => void saveField(field, spec)}>
                              Save
                            </Button>
                            {overridden && (
                              <Button
                                variant="ghost"
                                size="sm"
                                data-testid={`profile-field-reset-${field}`}
                                onClick={async () =>
                                  after(await sendControl(`/api/org/templates/${templateId}/overrides/${field}`, { method: 'DELETE' }))
                                }
                              >
                                Reset
                              </Button>
                            )}
                          </span>
                        </>
                      ) : typeof value === 'string' ? (
                        <p className="whitespace-pre-wrap text-xs text-text-2">{value === '' ? '—' : value}</p>
                      ) : value.length === 0 ? (
                        <p className="text-xs text-text-3">—</p>
                      ) : (
                        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-text-2">
                          {value.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })}
          </DetailsGroup>
        ))}

      {view !== null && (
        <DetailsGroup group="advanced" title="Advanced">
          {view.rawOverride && (
            <Alert variant="notice" testId="profile-raw-override-notice">
              this profile was written by hand. It wins over the structured profile, and an import
              will skip this row until it is cleared.
            </Alert>
          )}
          <span className="text-[10px] uppercase tracking-wide text-text-3">What a run is given</span>
          <pre data-testid="profile-markdown" className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-line bg-bg-1 p-2 font-mono text-[11px] text-text-2">
            {view.markdown ?? '(no profile)'}
          </pre>
          <span className="text-[10px] uppercase tracking-wide text-text-3">Raw override</span>
          <textarea
            data-testid="profile-raw-input"
            aria-label="raw profile Markdown"
            rows={6}
            value={rawDraft ?? view.markdown ?? ''}
            onChange={(event) => setRawDraft(event.target.value)}
            className={`w-full ${INPUT_SHELL}`}
          />
          <span className="text-xs text-text-3">
            Saving here replaces the rendered profile with your words until you clear it, and the
            next import will skip this template rather than overwrite them.
          </span>
        </DetailsGroup>
      )}
    </Drawer>
  )
}
```

**A raw override needs a web verb and there is not one.** `setProfile({ templateId })` is control
and CLI only, so the `profile-raw-input` textarea above is READ-ONLY in this milestone unless the
route exists. Add it — one shell over an existing verb, no new autonomy —
`apps/web/src/app/api/org/templates/[templateId]/profile/route.ts` gains a `PUT`:

```ts
/** R5's raw override, from the drawer's Advanced. `{ profile: string | null }`, null clears --
 *  `apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/profile/route.ts`'s body shape exactly,
 *  because it is the same verb at a different level of the same chain. */
export async function PUT(request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object' || !('profile' in body) || (typeof body.profile !== 'string' && body.profile !== null)) {
    return Response.json({ error: 'the body must be { "profile": string | null }' }, { status: 400 })
  }
  return orgControlResponse(() => setProfile({ templateId }, body.profile as string | null, gate.principal ?? 'web'))
}
```

and the drawer gets the two buttons under the textarea:

```tsx
          <span className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="profile-raw-save"
              onClick={async () =>
                after(await sendControl(`/api/org/templates/${templateId}/profile`, { method: 'PUT', body: { profile: rawDraft ?? '' } }))
              }
            >
              Save raw override
            </Button>
            {view.rawOverride && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="profile-raw-clear"
                onClick={async () =>
                  after(await sendControl(`/api/org/templates/${templateId}/profile`, { method: 'PUT', body: { profile: null } }))
                }
              >
                Clear it
              </Button>
            )}
          </span>
```

Note: clearing a raw override sets `profile` to NULL, which leaves the template with no Markdown
until the next `setProfileOverrides` or import re-renders it. Say so in the sentence under the
buttons: "Clearing it leaves this template without a profile until its catalog is imported again."

- [ ] **Step 8: Write `WorkforceCatalog`**

Create `apps/web/src/components/workforce/WorkforceCatalog.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { WorkforceCatalogFilters } from '@slave-of-ai/control'
import type { CatalogRowView, WorkforceCatalogView } from '../../server/org'
import { catalogFilterParams } from '../../lib/catalogFilters'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import { useCatalogFilters } from '../../hooks/useCatalogFilters'
import { Alert } from '../ui/Alert'
import { Chip } from '../ui/Chip'
import { DangerConfirm } from '../ui/DangerConfirm'
import { DataTable, Row } from '../ui/DataTable'
import { EmptyState } from '../ui/EmptyState'
import { CatalogFilterBar } from './CatalogFilterBar'
import { ProfileDrawer } from './ProfileDrawer'
import { TemplateForm } from './TemplateForm'

/**
 * `DataTable`, not a bespoke grid (plan erratum E13): `gate:m11-shell` creates a template through
 * the form below and then waits for a `data-table-row` carrying its name. The COLUMNS are free to
 * change -- the Catalog tab is not one of `gate:m14-fidelity`'s screenshots, which take
 * `/workforce`'s DEFAULT tab (Slaves) -- but the primitive is not.
 */
const COLUMNS = '1fr 110px 1.6fr 1.4fr 150px 140px 90px'
const HEADER = ['Name', 'Role', 'Summary', 'Capabilities', 'Source', 'Default model', ''] as const

/** How many capability chips fit a row before the rest becomes a count. */
const CHIPS = 3

/**
 * The Workforce Catalog (M46 R6): every template a company can be staffed from, searchable and
 * filterable, each row opening the specialist profile behind it.
 *
 * Rows come from `/api/org/catalog` rather than from a page prop, seeded by the server's first
 * read so nothing flashes. That is what lets a filter change, a template creation and an override
 * all refresh the list without `router.refresh()` re-running the Workforce page's eight loaders.
 */
export function WorkforceCatalog({ initial }: { readonly initial: WorkforceCatalogView }): React.JSX.Element {
  const router = useRouter()
  const { filters, setFilters } = useCatalogFilters()
  const [page, setPage] = useState<WorkforceCatalogView>(initial)
  const [staleError, setStaleError] = useState(false)
  const [open, setOpen] = useState<{ readonly id: string; readonly name: string } | null>(null)

  const reload = useCallback(
    (next: WorkforceCatalogFilters): void => {
      const query = catalogFilterParams(next).toString()
      void fetch(query === '' ? '/api/org/catalog' : `/api/org/catalog?${query}`)
        .then(async (response) => (response.ok ? ((await response.json()) as WorkforceCatalogView) : null))
        .then((view) => {
          if (view === null) {
            setStaleError(true)
            return
          }
          setStaleError(false)
          setPage(view)
        })
        .catch(() => setStaleError(true))
    },
    [],
  )

  // Seeded from the server on the first render; re-read whenever the filters move. The initial
  // render does NOT fetch when the URL carried no filters -- `initial` is already that answer.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    if (!mounted) {
      setMounted(true)
      if (Object.keys(filters).length === 0) return
    }
    reload(filters)
  }, [filters, mounted, reload])

  return (
    <div className="flex flex-col gap-3">
      <CatalogFilterBar filters={filters} facets={page.facets} onChange={setFilters} />
      {staleError && (
        <Alert variant="error" testId="catalog-stale">
          could not refresh the catalog — showing the last answer.
        </Alert>
      )}
      <span data-testid="catalog-count" className="text-xs text-text-3">
        {plural(page.rows.length, 'template')}
      </span>
      {page.rows.length === 0 ? (
        <EmptyState testId="catalog-empty" message="no template matches these filters." />
      ) : (
        <DataTable columns={COLUMNS} header={[...HEADER]} testId="workforce-catalog">
          {page.rows.map((row) => (
            <Row
              key={row.id}
              columns={COLUMNS}
              data-testid={`catalog-row-${row.id}`}
              data-mapping-quality={row.mappingQuality ?? ''}
              onClick={() => setOpen({ id: row.id, name: row.name })}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-text-1">{row.name}</span>
                <span className="flex gap-1">
                  {row.overriddenFields.length > 0 && (
                    <Chip data-testid={`catalog-overridden-${row.id}`}>customised</Chip>
                  )}
                  {row.rawOverride && <Chip data-testid={`catalog-raw-override-${row.id}`}>raw override</Chip>}
                </span>
              </span>
              <Chip>{row.role}</Chip>
              <span className="truncate text-text-2">{row.summary}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                {row.capabilities.slice(0, CHIPS).map((capability) => (
                  <Chip key={capability} data-testid="catalog-capability-chip">
                    {capability}
                  </Chip>
                ))}
                {row.capabilities.length > CHIPS && (
                  <span data-testid="catalog-capability-more" className="text-[10px] text-text-3">
                    +{row.capabilities.length - CHIPS}
                  </span>
                )}
              </span>
              <span
                data-testid={`catalog-source-${row.id}`}
                title={row.sourceId ?? 'made here'}
                className="truncate font-mono text-[10px] text-text-3"
              >
                {row.source === 'imported' ? `imported · ${row.sourceRepository ?? 'unknown'}` : 'local'}
              </span>
              <span className="font-mono text-xs text-text-2">
                {row.defaultModel === null ? '—' : `${row.defaultModel}${row.defaultProvider === null ? '' : ` · ${row.defaultProvider}`}`}
              </span>
              <DangerConfirm
                label="delete"
                testId="template-delete"
                confirmText={`deletes ${row.name} and its ${plural(row.catalogSlaveCount, 'catalog slave')}; project slaves keep their role`}
                onConfirm={async () => {
                  const error = await sendControl(`/api/org/templates/${row.id}`, { method: 'DELETE' })
                  if (error === null) {
                    reload(filters)
                    router.refresh()
                  }
                  return error
                }}
              />
            </Row>
          ))}
        </DataTable>
      )}
      <TemplateForm onCreated={() => reload(filters)} />
      {open !== null && (
        <ProfileDrawer
          key={open.id}
          templateId={open.id}
          name={open.name}
          onClose={() => setOpen(null)}
          onChanged={() => reload(filters)}
        />
      )}
    </div>
  )
}
```

If `DataTable`/`Row` do not already accept `testId`, `data-*` and `onClick` pass-throughs, widen
their props to spread the rest onto the rendered element rather than adding a second table
primitive — check `apps/web/src/components/ui/DataTable.tsx` first and make the smallest change
that keeps every existing call site compiling.

- [ ] **Step 9: Rebuild the Catalog tab (E7)**

In `apps/web/src/components/workforce/WorkforceClient.tsx`:
- change the `templates` prop's type to `readonly CatalogRowView[]` (imported as a type from
  `'../../server/org'`, the file's existing idiom) and add a `catalog: WorkforceCatalogView` prop;
- replace the Catalog tab body with:

```tsx
      {tab === 'catalog' && (
        <div className="flex flex-col gap-4">
          <Panel title="Workforce catalog">
            <WorkforceCatalog initial={catalog} />
          </Panel>
          <Panel title="Companies">
            <CompanyManager companies={companies} roster={roster} templates={templates} />
          </Panel>
          {/* M46 plan erratum E7: the import log is per-import-RUN, not per template, so it stays
              one panel on the tab instead of being repeated inside every profile drawer. It is
              under `Advanced` because "which import ran when" is a question you ask after
              something looks wrong, not while you are picking a specialist. */}
          <details data-testid="catalog-advanced">
            <summary className="cursor-pointer list-none text-xs text-text-3 hover:text-text-2">Advanced ▾</summary>
            <div className="pt-3">
              <Panel title="Catalog imports">
                <CatalogImports imports={catalogImports} />
              </Panel>
            </div>
          </details>
        </div>
      )}
```

In `apps/web/src/app/workforce/page.tsx`, replace `listTemplates()` in the `Promise.all` with
`listWorkforceCatalogPage()` and pass `catalog={catalog}` and `templates={catalog.rows}` — one
query where there were two (E9).

Record the change in `docs/ia.md`'s `/workforce` row, replacing its "Later" cell with:
`M46 rebuilt Catalog as the Workforce Catalog — search, filters, one row per specialist and a
profile drawer; the hand-made template form, the company manager and the import log are still
there, the last under the tab's own Advanced. M47 adds capabilities.`

- [ ] **Step 10: Update the two tests that pin the old tab**

In `apps/web/test/workforce-page.test.tsx`: give `TestWorkforceClient` the new `catalog` prop
(a `{ rows: [...], facets: { divisions: [], capabilities: [], skills: [] } }` built from the
existing `templates` fixtures, with the new required fields added to each) and rewrite the Catalog
tab case:

```tsx
  it('renders the workforce catalog, the company manager and the import log on the Catalog tab', () => {
    render(<TestWorkforceClient />)
    expect(screen.queryByTestId('template-form')).toBeNull()

    fireEvent.click(screen.getByTestId('workforce-tab-catalog'))

    expect(screen.getByText('Workforce catalog')).toBeTruthy()
    expect(screen.getByText('Companies')).toBeTruthy()
    expect(screen.getByTestId('template-form')).toBeTruthy()
    expect(screen.getByTestId('company-form')).toBeTruthy()
    // E7: still one panel, now inside the tab's own Advanced disclosure.
    expect(screen.getByTestId('catalog-advanced')).toBeTruthy()
    expect(screen.getByTestId('catalog-imports')).toBeTruthy()
  })
```

and repoint the two moved provenance cases at the new row testids (`catalog-source-t2` reading
`imported · catalog-m46`, and no `catalog-source-*` marker text saying `imported` on the hand-made
row). The `catalog-imports` counts case and the "nothing has been imported yet" case are unchanged.

In `apps/web/test/settings-page.test.tsx`: delete the whole `describe('TemplateCatalog')` block
and its now-unused imports — every one of its assertions has a home in
`apps/web/test/workforce-catalog.test.tsx` (Step 4), which is where the component now lives.

- [ ] **Step 11: Run the component tests**

```bash
npx vitest run --project unit apps/web/test/workforce-catalog.test.tsx apps/web/test/workforce-page.test.tsx apps/web/test/settings-page.test.tsx
```
Expected: PASS.

- [ ] **Step 12: Full task verification**

```bash
npx tsc --build
npm run --silent typecheck
npx vitest run --project unit apps/web/test
npm run gate:m26-vocabulary
pgrep -af "next dev"    # must be empty; if not, kill it and SAY SO in the report
npm run web:build
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m44-ux-foundation
```
Expected: all green. m44 is the browser check that matters here: its stage 4 refuses any raw enum
token as visible text on eleven pages, and the mapping-quality words are exactly the kind of value
that would have leaked (`MAPPING_QUALITY_LABEL` is why they do not). Never beside vitest.

- [ ] **Step 13: Commit**

```bash
git add apps/web/src/components/workforce apps/web/src/components/ui/DetailsGroup.tsx \
        apps/web/src/hooks/useCatalogFilters.ts apps/web/src/app/workforce/page.tsx \
        apps/web/src/app/api/org/templates apps/web/src/components/CompanyManager.tsx \
        apps/web/src/components/company apps/web/src/components/slaves/NewSlaveDrawer.tsx \
        apps/web/src/components/ProviderSelect.tsx apps/web/src/lib/postControl.ts docs/ia.md \
        apps/web/test/workforce-catalog.test.tsx apps/web/test/workforce-page.test.tsx \
        apps/web/test/settings-page.test.tsx
git rm apps/web/src/components/TemplateCatalog.tsx
git commit -m "$(cat <<'EOF'
feat(web): m46 t4 -- the Workforce Catalog and the profile drawer

The Catalog tab's template table is now a catalog you can actually use: search over name, summary,
capabilities and expertise; filters for division, capability, skill and imported-versus-made-here;
one row per specialist with its summary, three capability chips and a +N, where it came from, and
whether anybody has customised it. A row opens the specialist profile in twelve `DetailsGroup`s,
and `Customise` turns each field into its own editor with its own Save and, where it is overridden,
its own Reset -- one field at a time, because a "save everything" button would make every field an
override whether it was touched or not.

Raw Markdown is under `Advanced` and only there, next to the text a run is actually given. A raw
override wins over the rendered profile and freezes the row against imports, so the drawer says so
in words before anybody saves one.

The filters live in the URL through `history.replaceState`, not `router.replace`: `/workforce` is
force-dynamic with eight loaders including a disk scan, and a keystroke in a search box must not
re-run them. Rows come from `/api/org/catalog` seeded by the server's first read, which is what
lets a filter, a creation and an override all refresh the list without touching the page.

Nothing was removed. The hand-made template form is the same form with the same testids, because a
template somebody types has no persona file to map and `gate:m11-shell` drives those fields; the
company manager is where it was; the import log is still one panel, under the tab's own Advanced,
because it is a list of import RUNS and repeating it inside every drawer would be N copies of one
list. `docs/ia.md` records the change.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 5: The fixture catalog, `gate:m46-workforce-catalog`, the README, CI — and the full verification ladder (R7, E12, E16)

**Files:**
- Create: `scripts/fixtures/catalog-m46/divisions.json`, `scripts/fixtures/catalog-m46/LICENSE`, `scripts/fixtures/catalog-m46/engineering/gate-core-builder.md`, `scripts/fixtures/catalog-m46/engineering/gate-release-steward.md`, `scripts/fixtures/catalog-m46/testing/gate-verifier.md`, `scripts/fixtures/catalog-m46/testing/gate-note-taker.md`, `scripts/gate-m46-workforce-catalog.mjs`
- Modify: `package.json`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes from Tasks 1–4: the CLI verbs `import-catalog` and `show-profile --template <id> [--markdown]`; the four columns; `renderProfileSpec`/`effectiveProfileSpec`/`profileSpecSchema` off `packages/domain/dist`; every `data-testid` Task 4 produced.
- Produces: the npm script name `gate:m46-workforce-catalog`.

- [ ] **Step 1: Write the fixture catalog (E16, E20)**

`scripts/fixtures/catalog-m46/divisions.json`:

```json
{
  "_note": "M46's own catalog. Two divisions, four personas covering the three mapping qualities, written in this project's vocabulary so nothing checked in trips gate:m26-vocabulary. Separate from catalog-m42, whose counts that gate asserts exactly.",
  "divisions": {
    "engineering": { "label": "Engineering" },
    "testing": { "label": "Testing" }
  }
}
```

`scripts/fixtures/catalog-m46/LICENSE` — the gate asserts `sourceLicense === 'MIT'` off its first
line, so it is a real MIT header and nothing else:

```
MIT License

Copyright (c) 2026 The gate's own fixture catalog

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files, to deal in the Software without restriction.
```

`scripts/fixtures/catalog-m46/engineering/gate-core-builder.md` — the canonical nine-heading
skeleton, and the only persona the gate asserts `mappingQuality: 'full'` on:

```markdown
---
name: Gate Core Builder
description: Builds the core module and the tests that hold it up.
color: blue
emoji: brick
vibe: Puts the load-bearing parts in first.
tools: Read, Write, Edit
skills: writing-plans, systematic-debugging
---

# Gate Core Builder Personality

You are **Gate Core Builder**, the slave that writes the module everything else stands on. You
write its tests before you write it.

## Your Identity & Memory
- **Role**: Load-bearing module and test specialist
- **Personality**: Patient, deletion-minded, allergic to a red test
- **Memory**: You remember which shortcuts cost the most later
- **Experience**: Ten years of code other people had to keep

## Your Core Mission

Put the parts everything else stands on in place, tested, before anything is built on them.

### Design the module boundary
- Name the seam before you write either side of it
- Keep a module small enough to delete

### Write the test before the code
- A failing test first, every time

## Your Critical Rules You Must Follow

### Green before anything
- You MUST never leave a red test behind
- You MUST NOT widen a boundary to make a test pass
- Prefer the design that is easier to delete later

## Your Technical Deliverables

### Module boundary note
### Test plan

## Your Workflow Process
- Step 1: read the brief back in your own words
- Step 2: write the failing test
- Step 3: make it pass with the smallest change

## Your Communication Style
- Short messages, and the diff attached.

## Your Learning & Memory
- You keep a note of every shortcut that cost something.

## Your Success Metrics
- Every commit green
- No module larger than one screen

## Your Advanced Capabilities
- Reading a failing build back to its first cause
```

`scripts/fixtures/catalog-m46/engineering/gate-release-steward.md` — the divergent skeleton
(`mappingQuality: 'partial'`):

```markdown
---
name: Gate Release Steward
description: Gets a change out and watches what it does.
vibe: Ships small, watches hard.
---

# Gate Release Steward

Performance-minded release slave who takes one change to production at a time.

## Identity & Role Definition

The slave who owns the last mile: the flag, the rollout and the rollback.

## Core Capabilities

* **Rollout planning**: flag design, staged exposure, the order of the steps
* **Rollback drills**: the undo path rehearsed before the change goes out

## Specialized Skills

* Reading a dashboard back to the change that moved it

## Tooling & Automation

Use whatever the project already has; do not add a tool for one rollout.

## Decision Framework

Use this slave when a change is risky enough to need a flag.

## Success Metrics

* No rollout without a rehearsed rollback
```

`scripts/fixtures/catalog-m46/testing/gate-verifier.md` — the collaboration table
(`mappingQuality: 'partial'`), and the row the gate customises:

```markdown
---
name: Gate Verifier
description: Reads the work back and says whether it does what it claims.
vibe: Trusts nothing that has not run.
---

# Gate Verifier

You read work back and you run it.

## Critical Rules
- You MUST escalate to the Gate Release Steward before a second failing rollout
- A claim you have not seen run is a claim you have not checked

## Integration with other slaves

| Working with | How you integrate |
|---|---|
| **Gate Core Builder** | They write the module and its tests; you run them against the brief. |
| **Gate Release Steward** | Pair with them on the rehearsal, then hand off the evidence. |

## Success Metrics
- Nothing is called done that has not run
```

`scripts/fixtures/catalog-m46/testing/gate-note-taker.md` — no `##` heading at all
(`mappingQuality: 'none'`), which is the honest floor the catalog has to be able to show:

```markdown
---
name: Gate Note Taker
description: Writes down what happened.
vibe: Records, never decides.
---

# Gate Note Taker

You write down what happened, in the order it happened, and you do not decide what it meant. When
somebody asks what a run did, you answer with what the log says and nothing else.
```

- [ ] **Step 2: Write `scripts/gate-m46-workforce-catalog.mjs`**

Borrow verbatim: the temp-repo copy, `preflightCleanup`, `dumpGateRows`, `fail`, `waitUntil`,
teardown in FK order inside a `finally`, `exitCode` starting at 1 and set to 0 only at the very
end, and the `m8a-flow` daemon wiring from `scripts/gate-m42-catalog-import.mjs`; the free port,
the real `next dev` under `loopbackChildEnv()`, the ready-wait that parses next's own bound-port
line, the child killed in `finally`, `waitVisible`/`clickUntil`/`gotoReliably` and the **preflight
refusal** from `scripts/gate-m45-project-experience.mjs`. Dist imports only
(`../packages/domain/dist/index.js`, `../packages/db/dist/client.js`).

Header:

```js
// M46's own gate (spec R7): a persona file becomes a SPECIALIST PROFILE, an operator's
// customisation outlives the next import, and the catalog is a surface you can actually work in.
//
// Seven stages, each measuring one rule the milestone claims:
//   1. The checked-in fixture catalog is copied into a temp GIT REPOSITORY and imported through
//      the real CLI. Every persona's profileSpec is asserted field by field, its mappingQuality is
//      full / partial / none as its shape deserves, its source record carries the repository, the
//      path, the temp repo's own HEAD and MIT off the LICENSE file -- and the stored Markdown is
//      byte-equal to renderProfileSpec(effectiveProfileSpec(spec, overrides)) and inside the cap.
//   2. In a real browser: the catalog searches, the capability filter and the source filter narrow
//      it, and the URL carries what was chosen.
//   3. A row's drawer shows the twelve groups with their fields, and the raw Markdown is reachable
//      ONLY under Advanced.
//   4. One field is customised THROUGH THE UI: the override is stored, the Markdown is re-rendered
//      from it, and the row says so.
//   5. The upstream file is rewritten and re-imported: the customised field is still the
//      operator's, every other field moved with the file, and the report says `overridesKept 1`.
//   6. A raw Markdown override is set, the file is rewritten again, and THAT row is skipped
//      `locally_edited` while its neighbour updates -- the one thing that skip now means.
//   7. A company is built from two imported templates, assigned to a workspace, and a real daemon
//      dispatches one task with the fake CLI: the run's recorded RunContext carries the rendered
//      profile -- the prefix line, a mapped section heading and a sentence of the persona's own
//      body -- with a `profile` source whose origin is `template`.
//   8. Teardown, in FK order, on every exit path.
//
// NEVER A MODEL CALL. The daemon is spawned with SLAVEOFAI_CLAUDE_BIN=node,
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8a-flow" and SLAVEOFAI_REQUIRE_FAKE_CLI=1,
// and the browser half needs SLAVEOFAI_CLAUDE_BIN to name an executable under scripts/gate-fakes/
// or the preflight refuses to start at all.
//
// THE FIXTURE CATALOG IS COPIED TO A TEMP DIRECTORY AND `git init`ed THERE. The gate must never
// modify a file in this repository, and it must never run `git` against this repository either:
// `git status` after a green run has to be empty.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots its own `next dev`
// against `apps/web/.next` on a free port, and two of those corrupt the build cache for both.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m46-workforce-catalog
```

Fixed names, exactly as `gate-m42-catalog-import.mjs` declares its own (`preflightCleanup` removes
whatever a crashed run left on these, in FK order):

```js
const CATALOG_NAME = 'catalog-m46'
const CORE_BUILDER = 'Gate Core Builder'
const STEWARD = 'Gate Release Steward'
const VERIFIER = 'Gate Verifier'
const NOTE_TAKER = 'Gate Note Taker'
const COMPANY_NAME = 'M46 Gate Company'
const WORKSPACE_NAME = 'M46 Gate Project'
// The operator's own words for stage 4, and the sentence stage 5 appends to the upstream file.
const CUSTOM_CONSTRAINT = 'You MUST ship a rollout behind a flag the gate can turn off'
const CORE_BUILDER_APPENDED = '- Read the brief back before you touch the keyboard'
const RAW_OVERRIDE = 'This is what I want this worker to be, in my own words.'
```

Stage 1's assertions, spelled out — every one printed before it is asserted:

```js
  // The temp repo IS the point of this stage: `revision` is null for a directory nobody has
  // committed, so a gate that copied into a plain temp dir could not tell "no work tree" from "the
  // walk never looked".
  const catalogDir = join(mkdtempSync(join(tmpdir(), 'gate-m46-')), CATALOG_NAME)
  cpSync(join(repoRoot, 'scripts/fixtures', CATALOG_NAME), catalogDir, { recursive: true })
  execFileSync('git', ['init', '-q', catalogDir])
  execFileSync('git', ['-C', catalogDir, 'add', '-A'])
  execFileSync('git', ['-C', catalogDir, '-c', 'user.email=gate@example.invalid', '-c', 'user.name=Gate', 'commit', '-q', '-m', 'fixture'])
  const head = execFileSync('git', ['-C', catalogDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  const firstOutput = await runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 1 -- import-catalog printed:\n${firstOutput}`)

  const byName = new Map((await catalogTemplates()).map((row) => [row.name, row]))
  if (byName.size !== 4) await fail(`stage 1: expected four templates, got ${String(byName.size)}`)

  for (const [name, quality] of [[CORE_BUILDER, 'full'], [STEWARD, 'partial'], [VERIFIER, 'partial'], [NOTE_TAKER, 'none']]) {
    const row = byName.get(name)
    const parsed = profileSpecSchema.safeParse(row.profileSpec)
    if (!parsed.success) await fail(`stage 1: ${name} has no readable profileSpec`)
    console.log(`stage 1 -- ${name}: mappingQuality ${parsed.data.source.mappingQuality}, revision ${row.sourceRevision}, licence ${row.sourceLicense}`)
    if (parsed.data.source.mappingQuality !== quality) await fail(`stage 1: ${name} mapped ${parsed.data.source.mappingQuality}, expected ${quality}`)
    if (row.sourceRevision !== head) await fail(`stage 1: ${name} recorded revision ${row.sourceRevision}, expected the temp repo's HEAD ${head}`)
    if (row.sourceLicense !== 'MIT') await fail(`stage 1: ${name} recorded licence ${row.sourceLicense}, expected MIT`)
    if (parsed.data.source.repository !== CATALOG_NAME) await fail(`stage 1: ${name} recorded repository ${parsed.data.source.repository}`)
    // The claim the whole milestone rests on: the Markdown a run gets is the render of the spec.
    const rendered = renderProfileSpec(effectiveProfileSpec(parsed.data, {}))
    if (row.profile !== rendered) await fail(`stage 1: ${name}'s stored profile is not byte-equal to renderProfileSpec of its effective spec`)
    if (row.profile.length > PROFILE_MAX_CHARS) await fail(`stage 1: ${name}'s profile is ${String(row.profile.length)} characters, over the cap`)
  }

  const core = profileSpecSchema.parse(byName.get(CORE_BUILDER).profileSpec)
  assertIncludes(core.constraints, 'You MUST never leave a red test behind', 'stage 1: the core builder\'s constraints')
  assertIncludes(core.operatingPrinciples, 'Green before anything', 'stage 1: its operating principles')
  assertIncludes(core.capabilities, 'Design the module boundary', 'stage 1: its capabilities')
  assertIncludes(core.deliverables, 'Module boundary note', 'stage 1: its deliverables')
  assertIncludes(core.workflow, 'Step 1: read the brief back in your own words', 'stage 1: its workflow')
  assertIncludes(core.successCriteria, 'Every commit green', 'stage 1: its success criteria')
  assertIncludes(core.expertise, 'Ten years of code other people had to keep', 'stage 1: its expertise')
  assertIncludes(core.recommendedSkills, 'writing-plans', 'stage 1: its recommended skills')
  if (core.runtimeRole !== 'engineering') await fail(`stage 1: its suggested runtime role is ${core.runtimeRole}`)
  // R3's ignored key: `tools:` names base tools, not this catalog's skills.
  if (core.recommendedSkills.includes('Read')) await fail('stage 1: a base tool name reached recommendedSkills')

  const verifier = profileSpecSchema.parse(byName.get(VERIFIER).profileSpec)
  assertIncludes(verifier.collaborationHints, 'Gate Core Builder: They write the module and its tests; you run them against the brief.', 'stage 1: the verifier\'s collaboration hints')
  assertIncludes(verifier.collaborationHints, 'You MUST escalate to the Gate Release Steward before a second failing rollout', 'stage 1: its loose escalation hint')
```

Stages 2–4, in the browser (every wait is a `waitVisible`/`clickUntil`, never a sleep):

```js
  await gotoReliably(`${baseUrl}/workforce?tab=catalog`)
  await waitVisible(page.getByTestId('workforce-catalog'), 'the workforce catalog')
  const rowOf = (id) => page.getByTestId(`catalog-row-${id}`)

  // 2a. search narrows to one row, and the URL says what was searched for.
  await page.getByTestId('catalog-search').fill('rollout')
  await waitUntil(async () => (await page.getByTestId('catalog-row-' + byName.get(STEWARD).id).count()) === 1
    && (await page.getByTestId('catalog-row-' + byName.get(CORE_BUILDER).id).count()) === 0, 'the search to narrow to the steward')
  if (!page.url().includes('q=rollout')) await fail(`stage 2: the URL does not carry the search: ${page.url()}`)

  // 2b. the capability filter, off the facets the read model computed.
  await page.getByTestId('catalog-search').fill('')
  await page.getByTestId('catalog-capability-select').selectOption('Design the module boundary')
  await waitUntil(async () => (await page.getByTestId('catalog-count').textContent()) === '1 template', 'the capability filter to leave one row')

  // 2c. the source chips, and Clear filters puts everything back.
  await page.getByTestId('catalog-clear-filters').click()
  await page.getByTestId('catalog-source-chip-local').click()
  await waitUntil(async () => (await page.getByTestId('catalog-empty').count()) === 1, 'no locally made template to be left')
  await page.getByTestId('catalog-clear-filters').click()
  await waitUntil(async () => (await page.getByTestId('catalog-count').textContent()) === '4 templates', 'all four rows to come back')

  // 3. the drawer: twelve groups, and the raw Markdown ONLY under Advanced.
  await clickUntil(rowOf(byName.get(CORE_BUILDER).id), async () => page.getByTestId('profile-drawer').isVisible(), 'the core builder row')
  const groups = await page.getByTestId('details-group').evaluateAll((nodes) => nodes.map((node) => node.dataset.group))
  console.log(`stage 3 -- the drawer's groups: ${groups.join(', ')}`)
  for (const group of ['identity', 'mission', 'capabilities', 'expertise', 'principles', 'constraints', 'workflow', 'deliverables', 'success', 'collaboration', 'skills', 'source', 'advanced']) {
    if (!groups.includes(group)) await fail(`stage 3: the drawer has no ${group} group`)
  }
  if ((await page.getByTestId('profile-markdown').count()) !== 0) await fail('stage 3: the raw Markdown is on screen before Advanced was opened')
  await clickUntil(page.getByTestId('profile-drawer').getByText('Advanced'), async () => page.getByTestId('profile-markdown').isVisible(), 'the drawer\'s Advanced disclosure')
  const shown = await page.getByTestId('profile-markdown').textContent()
  if (!shown.includes('## Constraints')) await fail('stage 3: the rendered Markdown under Advanced is not the profile')

  // 4. customise one field through the UI, and read the database back.
  await page.getByTestId('profile-customise').click()
  await page.getByTestId('profile-field-input-constraints').fill(CUSTOM_CONSTRAINT)
  await page.getByTestId('profile-field-save-constraints').click()
  await waitUntil(async () => {
    const row = await prisma.slaveTemplate.findUnique({ where: { id: byName.get(CORE_BUILDER).id } })
    return row?.profileOverrides?.constraints?.[0] === CUSTOM_CONSTRAINT
  }, 'the override to reach the database')
  const customised = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: byName.get(CORE_BUILDER).id } })
  if (!customised.profile.includes(CUSTOM_CONSTRAINT)) await fail('stage 4: the Markdown was not re-rendered from the override')
  if (customised.profile.includes('never leave a red test behind')) await fail('stage 4: the upstream constraint is still in the rendered Markdown')
  if (profileSpecSchema.parse(customised.profileSpec).constraints[0] !== 'You MUST never leave a red test behind') {
    await fail('stage 4: the UPSTREAM half was written, which is the one thing it must never be')
  }
  await waitVisible(page.getByTestId(`catalog-overridden-${byName.get(CORE_BUILDER).id}`), 'the customised marker on the row')
```

Stage 5 — the milestone's headline claim, measured:

```js
  appendFileSync(join(catalogDir, 'engineering', 'gate-core-builder.md'), `${CORE_BUILDER_APPENDED}\n`)
  const secondOutput = await runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 5 -- the re-import printed:\n${secondOutput}`)
  if (!secondOutput.includes('overrides kept 1')) await fail('stage 5: the report does not say the override was kept')
  const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: byName.get(CORE_BUILDER).id } })
  if (after.profileOverrides?.constraints?.[0] !== CUSTOM_CONSTRAINT) await fail('stage 5: the override did not survive the import')
  if (!after.profile.includes(CUSTOM_CONSTRAINT)) await fail('stage 5: the re-rendered Markdown lost the override')
  if (!profileSpecSchema.parse(after.profileSpec).successCriteria.includes('Read the brief back before you touch the keyboard')) {
    await fail('stage 5: the upstream half did not move with the file')
  }
```

(`describeImport` in `apps/orchestrator/src/cli.ts` must print `overrides kept <n>` on an
`updated` line whose `overridesKept` is above zero — add that one clause in this task, and say so
in the commit; the report already carries the number from Task 2.)

Stage 6 — the raw override, and what `locally_edited` now means:

```js
  await runCli(['set-profile', '--template', byName.get(VERIFIER).id, '--file', rawFile])   // rawFile holds RAW_OVERRIDE
  appendFileSync(join(catalogDir, 'testing', 'gate-verifier.md'), '- Nothing is called done twice\n')
  appendFileSync(join(catalogDir, 'engineering', 'gate-release-steward.md'), '* Watch the first hour, not the first minute\n')
  const thirdOutput = await runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])
  console.log(`stage 6 -- the third import printed:\n${thirdOutput}`)
  if (!thirdOutput.includes('locally_edited')) await fail('stage 6: the raw override was not skipped')
  const verifierRow = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: byName.get(VERIFIER).id } })
  if (verifierRow.profile !== RAW_OVERRIDE) await fail('stage 6: the operator\'s own words were overwritten')
  const stewardRow = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: byName.get(STEWARD).id } })
  if (!stewardRow.profile.includes('Watch the first hour')) await fail('stage 6: the row beside it did not update in the same run')
```

Stage 7 — the persona still reaches the model. Borrow `gate-m42-catalog-import.mjs`'s stage 5
whole: build a company from `CORE_BUILDER` and `STEWARD` through the real CLI (`create-company`,
`add-team`, `add-slave`, `assign-company`), `set-goal`, one task, a daemon with
`--fixture m8a-flow`, then read the run's `RunContext` back:

```js
  const context = await prisma.runContext.findFirstOrThrow({ where: { runId }, orderBy: { createdAt: 'desc' } })
  const manifest = runContextManifestSchema.parse(context.sections)
  const profileSource = manifest.sections.find((section) => section.kind === 'profile')
  if (profileSource?.origin !== 'template') await fail(`stage 7: the profile section's origin is ${String(profileSource?.origin)}`)
  // The prefix line R4 owns, a heading only the RENDERER produces, and a sentence only the persona
  // file has -- the three together are what "the specialist profile is in front of the model" means.
  for (const needle of [`Imported from ${CATALOG_NAME}/engineering/gate-core-builder on `, '## Constraints', CUSTOM_CONSTRAINT, 'You write the module everything else stands on']) {
    if (!context.prompt.includes(needle)) await fail(`stage 7: the prompt does not carry ${JSON.stringify(needle)}`)
  }
```

Teardown deletes, in FK order: the workspace's runs/tasks/contexts, the workspace, the company and
its teams and members, the four templates by name, and the `CatalogImport` rows whose `catalog` is
`catalog-m46` — plus `rmSync(tempRoot, { recursive: true, force: true })`.

- [ ] **Step 3: Add the npm script**

In `package.json`, after the `gate:m45-project-experience` line (the comma moves onto it):

```json
    "gate:m45-project-experience": "tsc --build && node --env-file=.env scripts/gate-m45-project-experience.mjs",
    "gate:m46-workforce-catalog": "tsc --build && node --env-file=.env scripts/gate-m46-workforce-catalog.mjs"
```

- [ ] **Step 4: Add it to CI**

In `.github/workflows/ci.yml`, immediately after `- run: npm run gate:m45-project-experience`:

```yaml
      - run: npm run gate:m46-workforce-catalog
```

The `gates` job already installs Chromium, exports `CHROMIUM_PATH`, and sets `SLAVEOFAI_CLAUDE_BIN`
and `SLAVEOFAI_REQUIRE_FAKE_CLI` job-wide, so the preflight is satisfied with no new step. It also
already has `git` (the runner's own), which stage 1 needs for the temp repo.

- [ ] **Step 5: Run the new gate until it is green**

```bash
pgrep -af "next dev"     # must be empty
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m46-workforce-catalog
echo "exit ${PIPESTATUS[0]}"
git status --short
```
Expected: `PASS:` and exit 0, and a **clean** `git status` — the fixture catalog was copied before
it was edited, and the temp repo is under `/tmp`. Paste the whole output into the task report: the
per-persona mapping-quality lines and stage 5's report line are this milestone's evidence.

- [ ] **Step 6: README — `## Specialist profiles`**

Add a new section immediately after `## Importing a catalog`:

````markdown
## Specialist profiles

An imported persona is not a wall of text any more. The import reads it into a SPECIALIST PROFILE:
who the worker is, what it is for, what it can do, what it knows, how it works, what it must never
do, what it produces, what "done" looks like, who it works with, which skills it wants — and where
all of that came from: the catalog, the file, the commit, the licence and the day it arrived.

```bash
npm run orchestrator -- show-profile --template <id>
npm run orchestrator -- show-profile --template <id> --markdown
```

A persona whose headings the mapper recognises comes through in full; one written to a different
shape comes through in part; one written to no shape at all comes through as itself. The profile
says which of the three happened rather than pretending. **Nothing is thrown away**: the sections
the mapper does not know are still in the profile, in the persona's own words, and they are the
first thing dropped if a profile is too long for a prompt rather than the only thing kept.

A specialist profile stays distinct from a RUNTIME ROLE. The profile says what a worker is for; the
runtime roles (`set-runtime-roles`) are what it can be dispatched as, and they are the only thing
the scheduler reads.

**You can change any field, and your change survives the next import.** Open Workforce → Catalog,
click a specialist, press `Customise`, edit one field and save it. Your words and the catalog's are
kept in different places, so re-importing the file brings every other field up to date and leaves
yours exactly as you wrote them — the import even tells you how many it kept. `Reset` on a field
puts the catalog's version back.

Under `Advanced ▾` in the same drawer is the profile as a run actually receives it, and a raw
override: your own Markdown, replacing the rendered profile entirely. That one is all-or-nothing,
and a template carrying it is skipped by every import until you clear it — which is exactly what
you want when you have written a persona yourself, and exactly what you do not want when you only
meant to change a sentence. The catalog marks the two differently: `customised` for fields,
`raw override` for the whole text.
````

and update the `## The web UI` table's Workforce row to name the Catalog tab's new content.

- [ ] **Step 7: README — the "Tests and CI" roster (20 → 21)**

Replace

```
`gate:m42-catalog-import`, `gate:m44-ux-foundation` and `gate:m45-project-experience` on every push
```

with

```
`gate:m42-catalog-import`, `gate:m44-ux-foundation`, `gate:m45-project-experience` and
`gate:m46-workforce-catalog` on every push
```

and replace the sentence ending `That is 20 gates.` with the m45 sentence followed by:

```
and `m46` imports a fixture catalog out of a real git checkout and proves the profile is structure
rather than prose: four personas map to full, partly and not at all, each one's stored Markdown is
byte-identical to a re-render of its own spec and inside the cap, the source record carries the
checkout's commit and the licence off its LICENSE file, one field customised in a real browser is
still the operator's after the file behind it changes (and the import says it kept it), a raw
Markdown override still stops an import dead while the row beside it updates, and the profile a
worker is finally given -- rendered sections, the operator's sentence and the persona's own words
-- turns up in a real run's recorded prompt. That is 21 gates. Tests and gates share one Postgres --
run one at a time.
```

- [ ] **Step 8: Full verification ladder**

Run these **in this order**, one at a time, with no `next dev` running anywhere and no other vitest
process alive (the shared test database truncates, and a running daemon breaks `subscribe.test.ts`):

```bash
npm run --silent typecheck
npm run gate:m26-vocabulary
npx vitest run
npm run web:build
npm run gate:m46-workforce-catalog
npm run gate:m45-project-experience
npm run gate:m44-ux-foundation
npm run gate:m14-fidelity
npm run gate:m16-chrome
npm run gate:m42-catalog-import
npm run gate:m41-scenario
npm run gate:m40-requirement-versioning
npm run gate:m39-supervisor-mailbox
npm run gate:m38-supervisor
npm run gate:m37-run-context
npm run gate:m36-messaging
npm run gate:m35-pipeline-honesty
npm run gate:m33-adopt
npm run gate:m11-shell
```

with `CHROMIUM_PATH` and `SLAVEOFAI_CLAUDE_BIN` exported for the five browser gates (m46, m45, m44,
m14, m16). Expected: every one green.

Four of these are on this ladder for a reason, and a failure in them is a real regression:

- **`gate:m42-catalog-import`** — Task 2 rewrote what the importer WRITES. m42 pins what it
  DECIDES: two created, three skipped with the three reasons, an unchanged re-run that moves
  nothing, an operator's profile that survives a changed file, a dry run that writes nothing, and
  an imported persona reaching a real run's prompt. If it fails, the per-row policy moved and that
  is news.
- **`gate:m11-shell`** — stage 1 creates a template through `template-form` on
  `/workforce?tab=catalog` and waits for a `data-table-row` carrying its name. Task 4 replaced the
  table under that form; this run is the proof that the form and the primitive did not move
  (plan erratum E13).
- **`gate:m37-run-context`** — the profile section of a run's prompt is now RENDERED rather than
  stored verbatim. m37 is what proves the section, its origin and its manifest sha are still what
  M37 built.
- **`gate:m14-fidelity`** — no M46 change touches a screenshotted page (E12), so this run must
  leave the committed PNGs alone. See the next step.

Known flakes, and what to do about them rather than around them:
`apps/orchestrator/test/integration/cli.test.ts`'s llm-decision row-count case doubles when
anything else touches the database — re-run that file alone before believing a failure. `web:build`
must never run while `next dev` is up; if the dev server was running, stop it (`kill <pid>`), say so
in the report, `rm -rf apps/web/.next`, and restart it afterwards. The five browser gates each boot
their own `next dev` against `apps/web/.next` — run them one at a time, never beside each other and
never beside a dev server.

- [ ] **Step 9: Prove the fidelity screenshots did NOT change (E12)**

```bash
git status --short docs/superpowers/fidelity/m14
```
Expected: at most `docs/superpowers/fidelity/m14/office.png`, which differs on every regeneration
because its canvas animates. Revert it and confirm the rest are untouched:

```bash
git checkout -- docs/superpowers/fidelity/m14
git status --short docs/superpowers/fidelity/m14
```
Expected: empty.

**If `workforce.png` differs, stop and read it.** `gate:m14-fidelity` screenshots `/workforce`'s
DEFAULT tab, which is Slaves; a changed `workforce.png` means something on the Slaves tab moved,
which this milestone had no business touching. Fix the cause. Only if the change is deliberate and
explained does the set get regenerated, ALONE in its own commit, the way M45 Task 5 did it.

- [ ] **Step 10: Prove the tree is clean, then commit**

```bash
git status --short
```
Expected: only the files this task changed, and nothing from any gate's run.

```bash
git add scripts/fixtures/catalog-m46 scripts/gate-m46-workforce-catalog.mjs \
        apps/orchestrator/src/cli.ts package.json .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
test(gates),docs: m46 t5 -- gate:m46-workforce-catalog, and the README's Specialist profiles

Seven stages over a fixture catalog copied into a real temp git repository, because `revision` is
null for a directory nobody committed and a gate that could not tell that from "the walk never
looked" would be measuring nothing. Four personas: the canonical nine-heading shape maps full, a
shorter differently-worded one maps partly, one with an integration table gives up its collaboration
hints, and one with no heading at all maps to none -- which is a real answer the catalog shows
rather than a failure it hides.

Stage 1 asserts the claim the milestone rests on: every stored profile is byte-equal to a re-render
of its own effective spec, and inside the cap. Stage 4 customises one field THROUGH THE BROWSER and
reads the database back -- the override is stored, the Markdown is re-rendered from it, and the
UPSTREAM half is untouched, which is the one thing it must never be. Stage 5 rewrites the file
behind it and re-imports: the operator's sentence is still theirs, every other field moved, and the
report says it kept one. Stage 6 sets a raw Markdown override and shows an import stopping dead on
that row while the row beside it updates in the same run. Stage 7 dispatches one task with the fake
CLI and finds the prefix line, a rendered heading, the operator's sentence and the persona's own
words in the run's recorded prompt.

It spends nothing and cannot: the daemon runs the fake CLI under the m8a-flow fixture, and the
preflight refuses to start unless SLAVEOFAI_CLAUDE_BIN names a fake under scripts/gate-fakes. Every
row it writes is deleted in a finally, in FK order, and the fixture catalog it edits is a copy under
/tmp -- `git status` after a green run is empty. The fidelity screenshots are untouched: m14 takes
`/workforce`'s default tab, which is Slaves, and nothing on it moved.

`import-catalog` now prints "overrides kept <n>" on an updated row that had any, which is how an
operator learns their customisation survived without opening the catalog.

That is 21 gates.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

## Self-review

**1. Spec coverage.**

- **R1 — two JSON columns, one renderer.** Task 1 writes `profileSpecSchema` (every list ≤ 40
  items of ≤ 240 chars), `effectiveProfileSpec` (field by field, an overridden list replaces),
  `renderProfileSpec` (section-priority truncation under `PROFILE_MAX_CHARS`) and the migration;
  Task 2 makes `profile` derived at every write. `effectiveProfile`'s chain and the run-context
  section are untouched — Task 5's ladder re-runs `gate:m37-run-context` to prove it. Corrections:
  E1 (`body`), E2 (thirteen-entry priority), E3 (`runtimeRole` not rendered).
- **R2 — overrides survive because they live apart.** Task 2's importer writes `profileSpec` on
  created and updated rows and re-renders from the new effective spec; `setProfileOverrides` /
  `clearProfileOverride` write the operator's half; `overridesKept` is on `RowOutcome` and printed
  by the CLI; no event is written (M42 R5). Task 5 stage 5 measures it end to end.
- **R3 — the mapper.** Task 1's `personaToProfileSpec`: heading table with emoji/`Your ` stripping,
  the labelled-bullet rules, MUST/NEVER/ALWAYS/DO NOT splitting constraints from principles, the
  `Integration with …` table and the loose hand-off sentences, `skills:` only, `runtimeRole` from
  the template's role, `full`/`partial`/`none` at 7 / 3 / fewer. The prefix line stays first
  (`renderProfileSpec`'s first block).
- **R4 — source record.** `repository`/`path`/`importedAt` in Task 1's mapper, `revision`/`license`
  read by Task 2's walk (E14, E15) and mirrored into `sourceRevision`/`sourceLicense`; the drawer's
  Source group renders all six; Task 5 asserts the commit and `MIT`. No vendoring.
- **R5 — raw Markdown is an Advanced override.** `setProfile({ templateId })` is unchanged; the
  drawer's Advanced is the only place it is reachable from the web (Task 4's `PUT` route); the row
  shows `raw override`; `locally_edited` protects exactly that case (Task 2, and Task 5 stage 6).
  E4 settles the marker question: no column, the hash comparison already there.
- **R6 — the Workforce Catalog UI.** Task 3's read model and routes, Task 4's `WorkforceCatalog`
  (search, four filters, rows with summary, division, three chips + N, source chip, markers),
  `ProfileDrawer` (twelve groups, Customise with per-field override and Reset, Advanced holding the
  rendered Markdown and the raw editor), `template-form` and `CompanyManager` kept on the tab. E7
  moves the import history to the tab's own Advanced rather than into every drawer.
- **R7 — the gate.** Task 5: the new fixture catalog in a temp git repo with a LICENSE, the seven
  stages, README `## Specialist profiles`, roster 20 → 21, CI. E12 answers the fidelity question
  with the evidence: `/workforce`'s screenshot is the Slaves tab, so nothing regenerates, and Step 9
  proves it rather than assuming it.
- **Global rules.** Copied verbatim into Global Constraints, and every task's last steps run the
  vocabulary gate, `tsc --build` and `typecheck`; web tasks add `web:build` and the m44 browser
  gate.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every test is
written out; every implementation step carries the code. The one place a step says "borrow
verbatim" names the exact file and the exact list of things to borrow, which is the idiom the M45
plan's Task 5 used for the same reason: a gate's boot skeleton is 150 lines that must be identical
to an existing one, and copying it is more correct than retyping it.

**3. Type consistency.** `ProfileSpec` / `ProfileSpecField` / `ProfileOverrides` / `ProfileSource` /
`MappingQuality` are defined once in Task 1 and used by that spelling everywhere after.
`renderProfileSpec(spec)` takes exactly one argument in all four tasks. `listWorkforceCatalog`
returns `{ rows, facets }` in Task 2 and is wrapped as `listWorkforceCatalogPage` in Task 3 —
`listTemplates` is its rows. `readTemplateProfile` (control) is wrapped as `readTemplateProfileView`
(web). `setProfileOverrides(templateId, patch, actor)` and
`clearProfileOverride(templateId, field, actor)` return `{ overridden }` in Task 2, and Task 4's
drawer reads `view.overridden` from `readTemplateProfile`'s view — the same word for the same idea.
`overriddenFields` is the domain helper that produces both. `CatalogRowView.overriddenFields`
(plural, a row's list) and `TemplateProfileView.overridden` are deliberately different names for the
same list on two different objects; if that reads as drift during execution, rename the row's field
to `overridden` in Task 2 and follow it through Tasks 3–5 in the same commit.
