# Workforce Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `/workforce` Catalog (personas) and People (persons) lists into rich cards that show each one's skills (with source, plugin and process marks), specialties and first workflow steps, let an operator link or unlink a skill from the card itself, and filter both lists through one shared filter bar with capability-domain Specialty chips and a "No skills" view.

**Architecture:** The data stays where it is (no schema change): the control-layer catalog read (`listWorkforceCatalog`) and a new web read (`listPeoplePage`) filter, facet and page in Postgres and hand each row its effective skills (`CardSkillRow`) and a `WorkflowPreview` computed by a new pure domain helper. Writes go through the existing skill routes, with the persona route gaining an add/remove DELTA body (`changeTemplateSkills`) so two concurrent edits cannot drop each other's links, and a new `skill_missing` refusal. The UI is one `WorkforceCard` (persona / person variants) with an in-card `SkillPicker`, laid out in a CSS grid, fed by one `WorkforceFilterBar` whose URL state is shared through a generic `useUrlFilters` hook.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Prisma 6 on Postgres, Next.js App Router (`apps/web`), React 19 client components, Tailwind tokens from `globals.css`, Vitest + Testing Library (jsdom), Playwright-core gates in `scripts/gate-*.mjs`.

**Spec:** docs/superpowers/specs/2026-09-26-workforce-cards-design.md

## Global Constraints

- No schema change: no migration, no new column, no new table.
- No new plugin entity: a plugin is only the `plugin:<name>` provider prefix a `SkillProvider.name` already carries.
- Never write the word "agent"/"agents" in tracked source, tests or UI copy (gate `m26-vocabulary`) -- say worker/person/slave. The one exception is the vendor skill name `dispatching-parallel-agents`, which Task 1 adds to the gate's protected vendor tokens (the `cursor-agent` precedent) and which must appear nowhere else in any other spelling.
- Never run prettier (the repo has no prettier config; it reformats against the house style).
- House style: match the surrounding comment density -- a docblock on every exported symbol saying WHY, `readonly` props, `React.JSX.Element` return types, `exactOptionalPropertyTypes`-safe spreads (`...(x === undefined ? {} : { x })`).
- One vitest process at a time (the integration project shares one test database; concurrent runs TRUNCATE-collide). Never `pkill -f vitest` from a shell whose own argv contains "vitest".
- Simple mode and developer mode are both supported: nothing on a card is hidden by mode; developer mode is only denser through the existing `--gap-*`/`--fs-body` tokens on `:root[data-mode='developer']`.
- `npm run web:build` must pass, and must never run while `next dev` is up (it clobbers `apps/web/.next`).
- After changing `packages/domain` or `packages/control`, run `npx tsc --build` before running any `apps/web` test: the web resolves `@slave-of-ai/*` through each package's `dist/`.
- Commit trailer exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (check `git log -1` after each commit; amend if a different trailer slipped in).
- Gates run with the fake-CLI env on `GATE_DATABASE_URL`, never on the dev DB: `DATABASE_URL="$GATE_DATABASE_URL" SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" SLAVEOFAI_CURSOR_BIN="$PWD/scripts/gate-fakes/fake-cursor-agent.sh" SLAVEOFAI_REQUIRE_FAKE_CLI=1 npm run gate:<name>`, with the host daemon and any `next dev` stopped first.

## Review Focus

1. **A persona with zero workflow steps (or only blank ones)** -- `workflowPreview` answers `{ steps: [], total: 0 }` and the card says "No workflow in this profile", never an empty list or a "+0 steps". Tested in Task 1 (`preview.test.ts`) and Task 7 (`workforce-card.test.tsx`).
2. **A skill whose plugin was uninstalled (`Skill.missingSince` set)** -- it still shows on the card (greyed, title "missing from disk", still removable), the picker lists it disabled, and any ADD of it (persona add, persona set, person grant) is refused `skill_missing` (409) with a sentence naming it. Tested in Task 3 (read carries `missing: true`), Task 4 (refusals), Task 6 (picker disabled) and Task 7 (chip greyed).
3. **Two concurrent persona skill edits** -- two cards (or two tabs) each add a different skill to the same persona at the same moment and BOTH links survive, because the card sends a delta (`{ add }`), never a whole set. Tested in Task 4 (`Promise.all` of two route calls).
4. **A person whose persona skill was revoked** -- the skill is not in the effective set, is shown struck through with a "restore" control, does not satisfy the People skill filter, and a person whose EVERY inherited skill is revoked (and who has no grant) shows under "No skills". Tested in Task 3 (read + filters) and Task 7 (card).
5. **A filter URL with an unknown specialty or skill id** (a stale shared link) -- never a 400: the read answers zero rows with `total: 0`, the bar shows the unknown specialty as a pressed chip with count 0 so it can be cleared, and the empty state offers "Clear filters". Tested in Task 2 and Task 3 (server), Task 5 (pressed unknown chip) and Tasks 8/9 (empty-state action).
6. **Very long skill or plugin names on a narrow card** -- a chip is `max-w-full` with a `truncate` name, so a 120-character skill name never widens a 320px card or scrolls the page sideways (gate m61 stage 2 measures `scrollWidth === clientWidth` at 1024px). Tested in Task 7 (class assertions) and Task 10 (gate m61).
7. **A People list with hundreds of pool persons** -- the read pages 100 rows at a time in `(name, id)` order with a cursor, `total` counts all of them, and `Show more` appends; the gates find a person past page one by SEARCHING, never by scrolling. Tested in Task 3 (250 persons) and Task 9 (Show more).

---

## Before Task 1

- [ ] Create the branch: `git switch -c feature/workforce-cards`
- [ ] Confirm the baseline: `npx tsc --build && npx vitest run apps/web/test/workforce-catalog.test.tsx apps/web/test/people-table.test.tsx` -- expected PASS.

### Task 1: Process-skill marks, skill source and workflow preview (domain + web lib)

**Files:**
- Create: `packages/domain/src/persons/processSkills.ts`
- Modify: `packages/domain/src/persons/index.ts`
- Create: `packages/domain/src/profile/preview.ts`
- Modify: `packages/domain/src/profile/index.ts`
- Create: `apps/web/src/lib/skillSource.ts`
- Modify: `scripts/gate-m26-vocabulary.mjs`, `scripts/rename-agent-to-slave.mjs` (one protected vendor token each)
- Test: `packages/domain/test/persons/processSkills.test.ts`, `packages/domain/test/profile/preview.test.ts`, `apps/web/test/skill-source.test.ts`

**Interfaces:**
- Consumes: `ProfileSpec`, `profileSpecSchema`, `profileOverridesSchema`, `effectiveProfileSpec` (`packages/domain/src/profile/spec.ts`).
- Produces:
  - `PROCESS_SKILL_NAMES: readonly string[]` (10 names), `PROCESS_SKILL_PROVIDERS: readonly string[]` (`['plugin:superpowers']`), `PROCESS_SKILL_WARNING: string`
  - `isProcessSkill(skill: { readonly name: string; readonly providerName: string }): boolean`
  - `type SkillSource = { readonly kind: 'local' } | { readonly kind: 'plugin'; readonly plugin: string }`; `skillSourceOf(providerName: string): SkillSource`
  - `interface WorkflowPreview { readonly steps: readonly string[]; readonly total: number }`, `WORKFLOW_PREVIEW_STEPS = 3`, `NO_WORKFLOW_PREVIEW: WorkflowPreview`
  - `workflowPreview(spec: ProfileSpec | null, limit?: number): WorkflowPreview`
  - `storedWorkflowPreview(specJson: unknown, overridesJson: unknown): WorkflowPreview`
  - web: `SKILL_SOURCE_GLYPH`, `skillGlyphOf(providerName: string): string`, `skillSourceTitle(providerName: string): string`, `interface SkillGroup { readonly key: string; readonly label: string; readonly order: number }`, `skillGroupOf(providerName: string): SkillGroup`

- [ ] **Step 1: Write the failing domain tests**

`packages/domain/test/persons/processSkills.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  PROCESS_SKILL_NAMES,
  PROCESS_SKILL_WARNING,
  isProcessSkill,
  skillSourceOf,
} from '../../src/persons/processSkills.js'

describe('isProcessSkill', () => {
  it('flags every named process skill, from any provider', () => {
    for (const name of PROCESS_SKILL_NAMES) {
      expect(isProcessSkill({ name, providerName: 'personal' })).toBe(true)
    }
    expect(PROCESS_SKILL_NAMES).toHaveLength(10)
  })

  it('flags every skill the superpowers plugin carries, whatever it is called', () => {
    expect(isProcessSkill({ name: 'systematic-debugging', providerName: 'plugin:superpowers' })).toBe(true)
  })

  it('compares the bare name, case-insensitively, after any plugin prefix', () => {
    expect(isProcessSkill({ name: 'superpowers:Brainstorming', providerName: 'plugin:other' })).toBe(true)
  })

  it('leaves an ordinary skill alone', () => {
    expect(isProcessSkill({ name: 'pdf', providerName: 'personal' })).toBe(false)
    expect(isProcessSkill({ name: 'frontend-design', providerName: 'plugin:frontend' })).toBe(false)
  })

  it('says what the risk is in one sentence', () => {
    expect(PROCESS_SKILL_WARNING).toBe('Process skill: can make a worker plan and delegate instead of doing its task.')
  })
})

describe('skillSourceOf', () => {
  it('reads plugin:<name> as a plugin and names it', () => {
    expect(skillSourceOf('plugin:superpowers')).toEqual({ kind: 'plugin', plugin: 'superpowers' })
  })

  it('reads personal, project and anything unknown as local', () => {
    expect(skillSourceOf('personal')).toEqual({ kind: 'local' })
    expect(skillSourceOf('project')).toEqual({ kind: 'local' })
    expect(skillSourceOf('plugin:')).toEqual({ kind: 'local' })
  })
})
```

`packages/domain/test/profile/preview.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { emptyProfileSpec } from '../../src/profile/spec.js'
import { NO_WORKFLOW_PREVIEW, storedWorkflowPreview, workflowPreview } from '../../src/profile/preview.js'

const spec = (workflow: string[]) => ({ ...emptyProfileSpec(), workflow })

describe('workflowPreview', () => {
  it('is the first three steps and the whole count', () => {
    expect(workflowPreview(spec(['Read', 'Plan', 'Build', 'Test', 'Ship']))).toEqual({
      steps: ['Read', 'Plan', 'Build'],
      total: 5,
    })
  })

  it('is empty for a profile with no workflow, or only blank steps', () => {
    expect(workflowPreview(spec([]))).toEqual(NO_WORKFLOW_PREVIEW)
    expect(workflowPreview(spec(['  ', '']))).toEqual({ steps: [], total: 0 })
    expect(workflowPreview(null)).toEqual({ steps: [], total: 0 })
  })
})

describe('storedWorkflowPreview', () => {
  it('applies an operator override of the workflow', () => {
    const stored = spec(['Upstream one', 'Upstream two'])
    expect(storedWorkflowPreview(stored, { workflow: ['Mine one', 'Mine two', 'Mine three', 'Mine four'] })).toEqual({
      steps: ['Mine one', 'Mine two', 'Mine three'],
      total: 4,
    })
  })

  it('answers empty for a column that does not parse, never throws', () => {
    expect(storedWorkflowPreview(null, null)).toEqual({ steps: [], total: 0 })
    expect(storedWorkflowPreview({ nonsense: true }, undefined)).toEqual({ steps: [], total: 0 })
  })

  it('ignores an override column that does not parse and keeps the upstream steps', () => {
    expect(storedWorkflowPreview(spec(['Upstream']), { runtimeRole: 'nope' })).toEqual({ steps: ['Upstream'], total: 1 })
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/domain/test/persons/processSkills.test.ts packages/domain/test/profile/preview.test.ts`
Expected: FAIL -- `Failed to resolve import "../../src/persons/processSkills.js"` and the same for `preview.js`.

- [ ] **Step 3: Implement the domain helpers**

`packages/domain/src/persons/processSkills.ts`:

```ts
/**
 * Process-management skills (workforce cards spec §4, finding F9).
 *
 * A worker that loads one of these runs a whole development process -- brainstorm, write a plan,
 * dispatch helpers, review rounds -- inside ONE task instead of doing the task. Nothing here
 * blocks: the card marks the chip and the picker asks for a confirm, and the operator decides.
 *
 * Names are compared BARE (whatever follows the last `:`) and lower-cased, because a plugin's skill
 * can reach the catalogue as `superpowers:brainstorming` as easily as `brainstorming`.
 */
export const PROCESS_SKILL_NAMES: readonly string[] = [
  'brainstorming',
  'writing-plans',
  'executing-plans',
  'subagent-driven-development',
  'dispatching-parallel-agents',
  'using-git-worktrees',
  'finishing-a-development-branch',
  'requesting-code-review',
  'receiving-code-review',
  'using-superpowers',
]

/** Every skill from these providers counts, whatever it is called: the superpowers plugin IS a
 *  process, skill by skill. */
export const PROCESS_SKILL_PROVIDERS: readonly string[] = ['plugin:superpowers']

/** The one sentence the chip's tooltip and the picker's confirm both say. */
export const PROCESS_SKILL_WARNING = 'Process skill: can make a worker plan and delegate instead of doing its task.'

export function isProcessSkill(skill: { readonly name: string; readonly providerName: string }): boolean {
  if (PROCESS_SKILL_PROVIDERS.includes(skill.providerName)) return true
  const bare = (skill.name.split(':').at(-1) ?? '').trim().toLowerCase()
  return PROCESS_SKILL_NAMES.includes(bare)
}

/** Where a skill came from, as a card marks it: a plugin (named), or the operator's own disk. */
export type SkillSource = { readonly kind: 'local' } | { readonly kind: 'plugin'; readonly plugin: string }

const PLUGIN_PREFIX = 'plugin:'

/** `plugin:<name>` is a plugin; `personal`, `project` and any provider this build does not know are
 *  local -- the honest reading of a name that says nothing about a plugin. A bare `plugin:` names
 *  no plugin, so it is local too. */
export function skillSourceOf(providerName: string): SkillSource {
  return providerName.startsWith(PLUGIN_PREFIX) && providerName.length > PLUGIN_PREFIX.length
    ? { kind: 'plugin', plugin: providerName.slice(PLUGIN_PREFIX.length) }
    : { kind: 'local' }
}
```

`packages/domain/src/persons/index.ts` -- append:

```ts
export {
  PROCESS_SKILL_NAMES,
  PROCESS_SKILL_PROVIDERS,
  PROCESS_SKILL_WARNING,
  isProcessSkill,
  skillSourceOf,
  type SkillSource,
} from './processSkills.js'
```

`packages/domain/src/profile/preview.ts`:

```ts
import { effectiveProfileSpec, profileOverridesSchema, profileSpecSchema, type ProfileSpec } from './spec.js'

/** What a card shows of a profile's `workflow` (workforce cards spec §2): the first steps and how
 *  many there are in all, so "+N steps" is a count and never a guess. */
export interface WorkflowPreview {
  readonly steps: readonly string[]
  readonly total: number
}

export const WORKFLOW_PREVIEW_STEPS = 3

/** The answer for a profile with no workflow at all -- one value, so a test can compare to it. */
export const NO_WORKFLOW_PREVIEW: WorkflowPreview = { steps: [], total: 0 }

/**
 * The first {@link WORKFLOW_PREVIEW_STEPS} steps of an EFFECTIVE spec (overrides already applied).
 *
 * Blank steps are dropped before counting: an imported profile whose Workflow heading had an empty
 * bullet is a profile with one step fewer, and "+1 steps" over nothing is a count that lies.
 */
export function workflowPreview(spec: ProfileSpec | null, limit: number = WORKFLOW_PREVIEW_STEPS): WorkflowPreview {
  const steps = (spec?.workflow ?? []).map((step) => step.trim()).filter((step) => step !== '')
  return { steps: steps.slice(0, limit), total: steps.length }
}

/**
 * The same preview straight off the two stored JSON columns (`SlaveTemplate.profileSpec` and
 * `profileOverrides`), for a read that holds rows rather than a parsed spec.
 *
 * Never throws: a column that does not parse is a persona with no structured profile, which has
 * no workflow to preview; an overrides column that does not parse is ignored, the same rule
 * `catalogRowOf` follows.
 */
export function storedWorkflowPreview(specJson: unknown, overridesJson: unknown): WorkflowPreview {
  const spec = profileSpecSchema.safeParse(specJson)
  if (!spec.success) return NO_WORKFLOW_PREVIEW
  const overrides = profileOverridesSchema.safeParse(overridesJson ?? {})
  return workflowPreview(effectiveProfileSpec(spec.data, overrides.success ? overrides.data : {}))
}
```

`packages/domain/src/profile/index.ts` becomes:

```ts
export * from './spec.js'
export * from './preview.js'
```

- [ ] **Step 4: Run the domain tests**

Run: `npx vitest run packages/domain/test/persons/processSkills.test.ts packages/domain/test/profile/preview.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Protect the vendor skill name in the vocabulary gate**

`scripts/gate-m26-vocabulary.mjs`, the `PROTECTED` regex -- add `dispatching-parallel-agents` as one more alternative (vendor vocabulary, the `cursor-agent` precedent):

```js
const PROTECTED = /fake-cursor-agent|cursor-agent|dispatching-parallel-agents|--agents\b|user-agent|agentic|AGENTS\.md|claude-agent-sdk|@anthropic-ai\/[a-z-]+|agent_message(?!_sent)|0002-derived-agent-status|2026-08-17-ai-team-os-design/gi
```

`scripts/rename-agent-to-slave.mjs`, `PROTECTED_TOKENS` -- keep the two lists identical, as its header asks; after the `/agent_message(?!_sent)/g,` entry add:

```js
  // A superpowers skill NAME (workforce cards, Task 1): the card and the picker flag it as a
  // process skill, and the name is the vendor's own, not ours to rename -- `cursor-agent`'s reason.
  /dispatching-parallel-agents/g,
```

Run: `npm run gate:m26-vocabulary`
Expected: `PASS: the word is slave everywhere it is ours`.

- [ ] **Step 6: Write the failing web-lib test**

`apps/web/test/skill-source.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SKILL_SOURCE_GLYPH, skillGlyphOf, skillGroupOf, skillSourceTitle } from '../src/lib/skillSource.js'

describe('skillSource', () => {
  it('marks a plugin skill 🔌 and a personal or project skill 🧩', () => {
    expect(skillGlyphOf('plugin:superpowers')).toBe(SKILL_SOURCE_GLYPH.plugin)
    expect(skillGlyphOf('personal')).toBe('🧩')
    expect(skillGlyphOf('project')).toBe('🧩')
    expect(SKILL_SOURCE_GLYPH.plugin).toBe('🔌')
  })

  it('names the plugin in the tooltip', () => {
    expect(skillSourceTitle('plugin:superpowers')).toBe('from the superpowers plugin')
    expect(skillSourceTitle('personal')).toBe('from your skills')
    expect(skillSourceTitle('project')).toBe('from this project')
  })

  it('groups Your skills, then Project, then one group per plugin', () => {
    expect(skillGroupOf('personal')).toEqual({ key: 'personal', label: 'Your skills', order: 0 })
    expect(skillGroupOf('project')).toEqual({ key: 'project', label: 'Project', order: 1 })
    expect(skillGroupOf('plugin:superpowers')).toEqual({ key: 'plugin:superpowers', label: '🔌 superpowers', order: 2 })
    expect(skillGroupOf('somewhere-else')).toEqual({ key: 'somewhere-else', label: 'somewhere-else', order: 3 })
  })
})
```

Run: `npx tsc --build && npx vitest run apps/web/test/skill-source.test.ts`
Expected: FAIL -- `Failed to resolve import "../src/lib/skillSource.js"`.

- [ ] **Step 7: Implement the web lib**

`apps/web/src/lib/skillSource.ts`:

```ts
import { skillSourceOf } from '@slave-of-ai/domain'

/**
 * How a skill's SOURCE is drawn (workforce cards spec §2/§3). Two glyphs and no more: a plugin is a
 * skill source, not a new concept (decision 5), so the only distinction a card makes is "came with
 * a plugin" versus "is on your own disk" -- the plugin's name goes in the tooltip.
 */
export const SKILL_SOURCE_GLYPH = { local: '🧩', plugin: '🔌' } as const

export function skillGlyphOf(providerName: string): string {
  return SKILL_SOURCE_GLYPH[skillSourceOf(providerName).kind]
}

/** The tooltip on the glyph: WHICH plugin, or which of the two local roots. */
export function skillSourceTitle(providerName: string): string {
  const source = skillSourceOf(providerName)
  if (source.kind === 'plugin') return `from the ${source.plugin} plugin`
  if (providerName === 'project') return 'from this project'
  if (providerName === 'personal') return 'from your skills'
  return `from ${providerName}`
}

/** One heading in the skill picker. `order` sorts the groups; a label sorts inside an order. */
export interface SkillGroup {
  readonly key: string
  readonly label: string
  readonly order: number
}

/** "Your skills", then "Project", then one group per plugin, then anything this build does not
 *  know -- shown under its own provider name rather than hidden. */
export function skillGroupOf(providerName: string): SkillGroup {
  if (providerName === 'personal') return { key: providerName, label: 'Your skills', order: 0 }
  if (providerName === 'project') return { key: providerName, label: 'Project', order: 1 }
  const source = skillSourceOf(providerName)
  if (source.kind === 'plugin') return { key: providerName, label: `${SKILL_SOURCE_GLYPH.plugin} ${source.plugin}`, order: 2 }
  return { key: providerName, label: providerName, order: 3 }
}
```

- [ ] **Step 8: Run it**

Run: `npx vitest run apps/web/test/skill-source.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/persons/processSkills.ts packages/domain/src/persons/index.ts \
  packages/domain/src/profile/preview.ts packages/domain/src/profile/index.ts \
  packages/domain/test/persons/processSkills.test.ts packages/domain/test/profile/preview.test.ts \
  apps/web/src/lib/skillSource.ts apps/web/test/skill-source.test.ts \
  scripts/gate-m26-vocabulary.mjs scripts/rename-agent-to-slave.mjs
git commit -m "feat(domain): process-skill marks, skill source and workflow preview" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Catalog read -- domain facets, Specialty, "No skills", skill-name search, card skills and workflow preview

**Files:**
- Modify: `packages/control/src/catalog.ts` (`WorkforceCatalogRow`, `WorkforceCatalogFacets`, `WorkforceCatalogFilters`, `catalogRowOf`, `escapeLikeWildcards`, `catalogWhere`, `readCatalogFacets`, `NO_FACETS`, `listWorkforceCatalog`; new `CapabilityDomainFacet`, `capabilityKeysInDomain`)
- Create: `apps/web/src/lib/cardSkills.ts`
- Modify: `apps/web/src/server/org.ts` (`CatalogRowView`, `catalogRowViewOf`, `withPersonaSkills`)
- Modify: `apps/web/src/lib/catalogFilters.ts`, `apps/web/src/hooks/useCatalogFilters.ts` (`FILTER_PARAMS`)
- Modify (fixtures only): `packages/control/test/integration/catalog-page.test.ts`, `apps/web/test/workforce-catalog.test.tsx`, `apps/web/test/catalog-duplicates.test.tsx`, `apps/web/test/workforce-page.test.tsx`
- Test: `packages/control/test/integration/catalog-cards.test.ts` (new), `apps/web/test/integration/catalog-card-rows.test.ts` (new), `apps/web/test/catalog-filters.test.ts`

**Interfaces:**
- Consumes: `workflowPreview`, `WorkflowPreview`, `isProcessSkill`, `SkillOrigin` (Task 1 / domain); `listCapabilities()`, `syncCapabilityTaxonomy()` (`packages/control/src/capability.ts`).
- Produces:
  - control: `interface CapabilityDomainFacet { readonly domain: string; readonly count: number }`; `WorkforceCatalogFacets.domains: readonly CapabilityDomainFacet[]`; `WorkforceCatalogFilters.specialty?: string`, `.noSkills?: boolean`; `WorkforceCatalogRow.workflowPreview: WorkflowPreview`; `capabilityKeysInDomain(domain: string, taxonomy: readonly CapabilityRecord[]): string[]`; `export const escapeLikeWildcards: (text: string) => string`.
  - web: `interface CardSkillRow { skillId; name; providerName; missing: boolean; process: boolean; state: SkillOrigin | 'revoked' }`, `CARD_SKILL_SELECT`, `interface CardSkillSource`, `cardSkillOf(skill: CardSkillSource, state: CardSkillRow['state']): CardSkillRow`, `byCardOrder(a: CardSkillRow, b: CardSkillRow): number`; `CatalogRowView.skills: readonly CardSkillRow[]`; `CATALOG_NO_SKILLS = 'none'`; URL params `specialty=<domain>` and `skills=none`.

- [ ] **Step 1: Write the failing control integration test**

`packages/control/test/integration/catalog-cards.test.ts`:

```ts
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { emptyProfileSpec, type ProfileSpec } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { listCapabilities, syncCapabilityTaxonomy } from '../../src/capability.js'
import { capabilityKeysInDomain, listWorkforceCatalog } from '../../src/catalog.js'
import { truncateAll } from './helpers.js'

beforeEach(async () => {
  await truncateAll()
  // The taxonomy is a SEEDED table this file only reads; re-syncing is cheap and makes the domain
  // counts below independent of whatever another file did to it (`capability.test.ts`'s idiom).
  await syncCapabilityTaxonomy()
})

const template = async (
  name: string,
  over: { readonly capabilityKeys?: readonly string[]; readonly spec?: ProfileSpec; readonly overrides?: object } = {},
): Promise<string> => {
  const row = await prisma.slaveTemplate.create({
    data: {
      name,
      role: 'dev',
      capabilityKeys: [...(over.capabilityKeys ?? [])],
      searchText: name.toLowerCase(),
      ...(over.spec === undefined ? {} : { profileSpec: over.spec as unknown as Prisma.InputJsonValue }),
      ...(over.overrides === undefined ? {} : { profileOverrides: over.overrides as Prisma.InputJsonValue }),
    },
  })
  return row.id
}

const linkSkill = async (templateId: string, name: string): Promise<void> => {
  const provider = await prisma.skillProvider.upsert({ where: { name: 'personal' }, create: { name: 'personal' }, update: {} })
  const skill = await prisma.skill.create({ data: { providerId: provider.id, name, description: `${name} does a thing` } })
  await prisma.templateSkill.create({ data: { templateId, skillId: skill.id } })
}

describe('workforce cards: the catalog read', () => {
  it('counts each capability domain once per persona, most matches first', async () => {
    await template('Alpha', { capabilityKeys: ['frontend.styling', 'frontend.accessibility'] })
    await template('Bravo', { capabilityKeys: ['frontend.styling', 'backend.services'] })
    await template('Charlie', { capabilityKeys: ['qa.test-strategy'] })

    expect((await listWorkforceCatalog()).facets.domains).toEqual([
      { domain: 'frontend', count: 2 },
      { domain: 'backend', count: 1 },
      { domain: 'qa', count: 1 },
    ])
  })

  it('filters by specialty: any key in the domain matches', async () => {
    await template('Alpha', { capabilityKeys: ['frontend.styling'] })
    await template('Bravo', { capabilityKeys: ['backend.services', 'frontend.accessibility'] })
    await template('Charlie', { capabilityKeys: ['qa.test-strategy'] })

    const page = await listWorkforceCatalog({ specialty: 'frontend' })
    expect(page.rows.map((row) => row.name)).toEqual(['Alpha', 'Bravo'])
    expect(page.total).toBe(2)
  })

  it('answers an unknown specialty with no rows, never an error', async () => {
    await template('Alpha', { capabilityKeys: ['frontend.styling'] })

    const page = await listWorkforceCatalog({ specialty: 'no-such-domain' })
    expect(page.rows).toEqual([])
    expect(page.total).toBe(0)
  })

  it('knows a domain by its keys', async () => {
    const keys = capabilityKeysInDomain('frontend', await listCapabilities())
    expect(keys).toContain('frontend.styling')
    expect(keys.every((key) => key.startsWith('frontend.'))).toBe(true)
    expect(capabilityKeysInDomain('no-such-domain', await listCapabilities())).toEqual([])
  })

  it('"no skills" keeps only the personas nobody has equipped', async () => {
    const alpha = await template('Alpha')
    await template('Bravo')
    await linkSkill(alpha, 'pdf')

    expect((await listWorkforceCatalog({ noSkills: true })).rows.map((row) => row.name)).toEqual(['Bravo'])
  })

  it('finds a persona by the NAME of a skill linked to it', async () => {
    const alpha = await template('Alpha')
    await template('Bravo')
    await linkSkill(alpha, 'pdf-maker')

    expect((await listWorkforceCatalog({ q: 'PDF-maker' })).rows.map((row) => row.name)).toEqual(['Alpha'])
  })

  it('previews the EFFECTIVE workflow: an override wins, a missing spec is empty', async () => {
    await template('Alpha', {
      spec: { ...emptyProfileSpec(), workflow: ['Upstream one', 'Upstream two'] },
      overrides: { workflow: ['Read', 'Plan', 'Build', 'Ship'] },
    })
    await template('Bravo')

    const rows = (await listWorkforceCatalog()).rows
    expect(rows.find((row) => row.name === 'Alpha')?.workflowPreview).toEqual({ steps: ['Read', 'Plan', 'Build'], total: 4 })
    expect(rows.find((row) => row.name === 'Bravo')?.workflowPreview).toEqual({ steps: [], total: 0 })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/control/test/integration/catalog-cards.test.ts`
Expected: FAIL -- `capabilityKeysInDomain` is not exported (`SyntaxError: The requested module ... does not provide an export named 'capabilityKeysInDomain'`).

- [ ] **Step 3: Implement the control read**

In `packages/control/src/catalog.ts`:

1. Add `workflowPreview,` to the value imports from `@slave-of-ai/domain` and `type WorkflowPreview,` to its type imports.

2. In `interface WorkforceCatalogRow`, after `readonly duplicateCount: number`, add:

```ts
  /** Workforce cards: the first steps of the EFFECTIVE profile's workflow (overrides applied) and
   *  how many there are -- the card's Workflow block. Empty for a row that is not structured. */
  readonly workflowPreview: WorkflowPreview
```

3. Replace `interface WorkforceCatalogFacets` with:

```ts
/** One capability domain and how many rows carry at least one of its keys (workforce cards §1). */
export interface CapabilityDomainFacet {
  readonly domain: string
  readonly count: number
}

export interface WorkforceCatalogFacets {
  readonly divisions: readonly string[]
  readonly capabilities: readonly string[]
  readonly skills: readonly string[]
  /** Workforce cards: the Specialty chips -- every domain with at least one row, most rows first,
   *  counted over the WHOLE table before any filter ran (M46 R6's rule for every facet here). */
  readonly domains: readonly CapabilityDomainFacet[]
}
```

4. In `interface WorkforceCatalogFilters`, after `readonly duplicates?: DuplicateFacet`, add:

```ts
  /** Workforce cards: a capability DOMAIN (`frontend`, `qa`). A row matches when any of its
   *  `capabilityKeys` is one of that domain's taxonomy keys -- "starts with `<domain>.`", asked of
   *  the one vocabulary a key may come from. */
  readonly specialty?: string
  /** Workforce cards: only rows with no default skill at all -- who still needs equipping. */
  readonly noSkills?: boolean
```

5. In `catalogRowOf`'s returned object, after `duplicateCount: duplicate?.n ?? 0,` add `workflowPreview: workflowPreview(effective),`.

6. `const escapeLikeWildcards` becomes `export const escapeLikeWildcards` (the People read in Task 3 escapes its search the same way), and directly below it add:

```ts
/**
 * Every taxonomy key under one domain (workforce cards §1). `Capability.domain` is stored as the
 * key's own prefix, so this IS "starts with `<domain>.`" -- asked of the taxonomy rather than of
 * free text, which is what lets the clause be a `hasSome` Postgres can run. An unknown domain has
 * no keys, and the caller turns that into "matches nothing".
 */
export function capabilityKeysInDomain(domain: string, taxonomy: readonly CapabilityRecord[]): string[] {
  return taxonomy.filter((record) => record.domain === domain).map((record) => record.key)
}
```

7. `catalogWhere` takes the taxonomy and gains three clauses. Its signature and the `q` line change; the rest of the body is unchanged:

```ts
function catalogWhere(
  filters: WorkforceCatalogFilters,
  taxonomy: readonly CapabilityRecord[],
): Prisma.SlaveTemplateWhereInput {
  const clauses: Prisma.SlaveTemplateWhereInput[] = []
  if (filters.source !== undefined) clauses.push({ sourceId: filters.source === 'imported' ? { not: null } : null })
  if (filters.division !== undefined) clauses.push({ sourceDivision: filters.division })
  if (filters.capability !== undefined) clauses.push({ capabilityKeys: { has: filters.capability } })
  if (filters.skill !== undefined) clauses.push({ recommendedSkills: { has: filters.skill } })
  if (filters.active !== undefined) clauses.push({ active: filters.active })
  if (filters.specialty !== undefined) {
    const keys = capabilityKeysInDomain(filters.specialty, taxonomy)
    // An unknown domain matches NOTHING, spelled out: a stale shared link renders an empty list
    // under its still-pressed chip, never the whole catalog under a filter that says otherwise.
    clauses.push(keys.length === 0 ? { id: { in: [] } } : { capabilityKeys: { hasSome: keys } })
  }
  if (filters.noSkills === true) clauses.push({ defaultSkills: { none: {} } })
  const q = normalisePersona(filters.q ?? '')
  if (q !== '') {
    clauses.push({
      OR: [
        { searchText: { contains: escapeLikeWildcards(q) } },
        // Workforce cards: a linked skill's NAME is searchable too -- RAW (trimmed), not folded:
        // `normalisePersona` turns `writing-plans` into `writing plans`, a spelling no skill has.
        { defaultSkills: { some: { skill: { name: { contains: escapeLikeWildcards((filters.q ?? '').trim()), mode: 'insensitive' } } } } },
      ],
    })
  }
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
```

8. `readCatalogFacets` gains the domain count -- joined to the taxonomy, so a chip's count is exactly what clicking it returns:

```ts
async function readCatalogFacets(): Promise<WorkforceCatalogFacets> {
  const [divisionGroups, capabilityRows, skillRows, domainRows] = await Promise.all([
    prisma.slaveTemplate.groupBy({ by: ['sourceDivision'], orderBy: { sourceDivision: 'asc' } }),
    prisma.$queryRaw<{ value: string }[]>`
      SELECT DISTINCT unnest("capabilityKeys") AS value FROM "SlaveTemplate" ORDER BY value ASC
    `,
    prisma.$queryRaw<{ value: string }[]>`
      SELECT DISTINCT unnest("recommendedSkills") AS value FROM "SlaveTemplate" ORDER BY value ASC
    `,
    // Workforce cards: one row per domain, a persona counted ONCE however many of its keys sit in
    // it. `::int` because `count` is a `bigint` Prisma hands back as a non-JSON `BigInt`.
    prisma.$queryRaw<{ domain: string; count: number }[]>`
      SELECT c.domain AS domain, count(DISTINCT t.id)::int AS count
      FROM "SlaveTemplate" t
      CROSS JOIN LATERAL unnest(t."capabilityKeys") AS k(key)
      JOIN "Capability" c ON c.key = k.key
      GROUP BY c.domain
      ORDER BY count DESC, domain ASC
    `,
  ])
  return {
    divisions: divisionGroups.flatMap((group) => (group.sourceDivision === null ? [] : [group.sourceDivision])),
    capabilities: capabilityRows.map((row) => row.value),
    skills: skillRows.map((row) => row.value),
    domains: domainRows.map((row) => ({ domain: row.domain, count: row.count })),
  }
}
```

9. `const NO_FACETS: WorkforceCatalogFacets = { divisions: [], capabilities: [], skills: [], domains: [] }`

10. In `listWorkforceCatalog`, read the taxonomy BEFORE building the `where`, and drop it from the `Promise.all`:

```ts
  // The taxonomy FIRST (workforce cards): the specialty clause is built from it, so it can no
  // longer ride in the same `Promise.all` as the reads that use the clause. `catalogRowOf` reads the
  // same value for R8's staleness, so this is still one taxonomy read per page.
  const taxonomy = await listCapabilities()
  const where = catalogWhere(filters, taxonomy)
  const take = Math.max(1, Math.min(options.pageSize ?? CATALOG_PAGE_SIZE, TEMPLATE_PICKER_MAX))
  const [templates, total, facets] = await Promise.all([
    prisma.slaveTemplate.findMany({
      where,
      select: CATALOG_ROW_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take,
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
    }),
    prisma.slaveTemplate.count({ where }),
    options.facets === false ? Promise.resolve(NO_FACETS) : readCatalogFacets(),
  ])
```

(keep the existing `name`-then-`id` ordering comment above `orderBy` as it is.)

11. `packages/control/test/integration/catalog-page.test.ts`, in "skips the facet scans for a caller that draws no menu": `expect(page.facets).toEqual({ divisions: [], capabilities: [], skills: [], domains: [] })`.

- [ ] **Step 4: Run the control tests**

Run: `npx vitest run packages/control/test/integration/catalog-cards.test.ts packages/control/test/integration/catalog-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing web tests**

`apps/web/test/integration/catalog-card-rows.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { listWorkforceCatalogPage } from '../../src/server/org.js'
import { GET as catalogGET } from '../../src/app/api/org/catalog/route.js'
import { truncateAll } from './helpers.js'

beforeEach(async () => {
  await truncateAll()
})

describe('workforce cards: catalog rows', () => {
  it('hands each row its linked skills with source, missing and process marks, by name', async () => {
    const personal = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const plugin = await prisma.skillProvider.create({ data: { name: 'plugin:superpowers' } })
    const pdf = await prisma.skill.create({ data: { providerId: personal.id, name: 'pdf', description: 'makes pdfs' } })
    const gone = await prisma.skill.create({
      data: { providerId: personal.id, name: 'archived', description: 'gone from disk', missingSince: new Date() },
    })
    const plans = await prisma.skill.create({ data: { providerId: plugin.id, name: 'writing-plans', description: 'plans' } })
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await prisma.templateSkill.createMany({
      data: [pdf, gone, plans].map((skill) => ({ templateId: template.id, skillId: skill.id })),
    })

    const row = (await listWorkforceCatalogPage()).rows[0]
    expect(row?.skills).toEqual([
      { skillId: gone.id, name: 'archived', providerName: 'personal', missing: true, process: false, state: 'persona' },
      { skillId: pdf.id, name: 'pdf', providerName: 'personal', missing: false, process: false, state: 'persona' },
      { skillId: plans.id, name: 'writing-plans', providerName: 'plugin:superpowers', missing: false, process: true, state: 'persona' },
    ])
    expect(row?.workflowPreview).toEqual({ steps: [], total: 0 })
  })

  it('answers a stale link with an unknown specialty as an empty page, not an error', async () => {
    await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev', capabilityKeys: ['frontend.styling'] } })

    const response = await catalogGET(new Request('http://x/api/org/catalog?specialty=no-such-domain&skills=none'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { rows: unknown[]; total: number }
    expect(body.rows).toEqual([])
    expect(body.total).toBe(0)
  })
})
```

Append to `apps/web/test/catalog-filters.test.ts`:

```ts
describe('workforce cards params', () => {
  it('reads a specialty domain and skills=none', () => {
    expect(parseCatalogFilters(new URLSearchParams('specialty=frontend&skills=none'))).toEqual({
      specialty: 'frontend',
      noSkills: true,
    })
  })

  it('drops a skills value other than none rather than refusing the link', () => {
    expect(parseCatalogFilters(new URLSearchParams('skills=some&q=builder'))).toEqual({ q: 'builder' })
  })

  it('writes both back', () => {
    expect(catalogFilterParams({ specialty: 'qa', noSkills: true }).toString()).toBe('specialty=qa&skills=none')
  })
})
```

Run: `npx tsc --build && npx vitest run apps/web/test/catalog-filters.test.ts apps/web/test/integration/catalog-card-rows.test.ts`
Expected: FAIL -- `tsc --build` passes (control built), then `catalog-filters` fails on `{ specialty, noSkills }` being dropped and `catalog-card-rows` fails with `row?.skills` `undefined`.

- [ ] **Step 6: Implement the web side**

`apps/web/src/lib/cardSkills.ts`:

```ts
import { isProcessSkill, type SkillOrigin } from '@slave-of-ai/domain'

/**
 * One skill chip on a workforce card (spec §2), as both card reads hand it to the client.
 *
 * `state` is the person panel's own three-state word (`PersonSkillRow.state`, M58 R23): `persona`
 * for a skill inherited from the persona, `person` for this person's own grant, `revoked` for an
 * inherited skill this person said no to. A persona card only ever holds `persona`.
 */
export interface CardSkillRow {
  readonly skillId: string
  readonly name: string
  readonly providerName: string
  /** `Skill.missingSince` is set: a scan could not find it on disk (an uninstalled plugin, say).
   *  The link stays -- the catalog never deletes -- and the chip is drawn greyed. */
  readonly missing: boolean
  /** {@link isProcessSkill}, computed once here so no client has to. */
  readonly process: boolean
  readonly state: SkillOrigin | 'revoked'
}

/** The columns a chip needs, as ONE Prisma `select` both reads share. */
export const CARD_SKILL_SELECT = {
  id: true,
  name: true,
  missingSince: true,
  provider: { select: { name: true } },
} as const

/** What {@link CARD_SKILL_SELECT} reads back. */
export interface CardSkillSource {
  readonly id: string
  readonly name: string
  readonly missingSince: Date | null
  readonly provider: { readonly name: string }
}

export function cardSkillOf(skill: CardSkillSource, state: CardSkillRow['state']): CardSkillRow {
  return {
    skillId: skill.id,
    name: skill.name,
    providerName: skill.provider.name,
    missing: skill.missingSince !== null,
    process: isProcessSkill({ name: skill.name, providerName: skill.provider.name }),
    state,
  }
}

/** Held skills by name, then the revoked ones -- the order every card draws its chips in. */
export function byCardOrder(a: CardSkillRow, b: CardSkillRow): number {
  const revoked = Number(a.state === 'revoked') - Number(b.state === 'revoked')
  return revoked !== 0 ? revoked : a.name.localeCompare(b.name)
}
```

`apps/web/src/server/org.ts`:

- import: `import { CARD_SKILL_SELECT, byCardOrder, cardSkillOf, type CardSkillRow } from '../lib/cardSkills'`
- `CatalogRowView` gains, after `hiredCount`:

```ts
  /** Workforce cards: this persona's default skills as CHIPS -- name, source, missing, process --
   *  in card order. `defaultSkillIds` stays beside it for the drawer's editor, which takes ids. */
  readonly skills: readonly CardSkillRow[]
```

- `catalogRowViewOf` returns `skills: []` beside `defaultSkillIds: []`.
- `withPersonaSkills` reads the chip columns in the SAME grouped query (still two queries for the whole page):

```ts
async function withPersonaSkills(rows: readonly CatalogRowView[]): Promise<readonly CatalogRowView[]> {
  const ids = rows.map((row) => row.id)
  if (ids.length === 0) return rows
  const [skills, hired] = await Promise.all([
    prisma.templateSkill.findMany({
      where: { templateId: { in: ids } },
      select: { templateId: true, skillId: true, skill: { select: CARD_SKILL_SELECT } },
      orderBy: [{ templateId: 'asc' }, { skillId: 'asc' }],
    }),
    prisma.person.groupBy({ by: ['templateId'], where: { templateId: { in: ids } }, _count: { _all: true } }),
  ])
  const skillsBy = new Map<string, string[]>()
  const chipsBy = new Map<string, CardSkillRow[]>()
  for (const row of skills) {
    const list = skillsBy.get(row.templateId)
    if (list === undefined) skillsBy.set(row.templateId, [row.skillId])
    else list.push(row.skillId)
    const chip = cardSkillOf(row.skill, 'persona')
    const chips = chipsBy.get(row.templateId)
    if (chips === undefined) chipsBy.set(row.templateId, [chip])
    else chips.push(chip)
  }
  const hiredBy = new Map(
    hired.flatMap((group) => (group.templateId === null ? [] : [[group.templateId, group._count._all] as const])),
  )
  return rows.map((row) => ({
    ...row,
    defaultSkillIds: skillsBy.get(row.id) ?? [],
    skills: (chipsBy.get(row.id) ?? []).toSorted(byCardOrder),
    hiredCount: hiredBy.get(row.id) ?? 0,
  }))
}
```

`apps/web/src/lib/catalogFilters.ts`:

- below `CATALOG_SEARCH_DEBOUNCE_MS` add:

```ts
/** The one value `?skills=` takes (workforce cards): `skills=none` is the "No skills" toggle. Any
 *  other value is DROPPED, never refused -- this file's lenient rule. */
export const CATALOG_NO_SKILLS = 'none'
```

- in `parseCatalogFilters`, read `const specialty = text(params, 'specialty')` and `const skills = text(params, 'skills')`, and append to the returned object:

```ts
    ...(specialty !== undefined ? { specialty } : {}),
    ...(skills === CATALOG_NO_SKILLS ? { noSkills: true } : {}),
```

- in `catalogFilterParams`, after the `duplicates` line:

```ts
  if (filters.specialty !== undefined) params.set('specialty', filters.specialty)
  if (filters.noSkills === true) params.set('skills', CATALOG_NO_SKILLS)
```

`apps/web/src/hooks/useCatalogFilters.ts`: `const FILTER_PARAMS = ['q', 'division', 'capability', 'source', 'skill', 'active', 'duplicates', 'specialty', 'skills'] as const` (and "seven" becomes "nine" in its docblock).

Fixtures (typecheck of the test tsconfig): in `apps/web/test/workforce-catalog.test.tsx` `row()`, `apps/web/test/catalog-duplicates.test.tsx` `row()` and `apps/web/test/workforce-page.test.tsx` `templateRow()`, add after `hiredCount: 0,`:

```ts
    skills: [],
    workflowPreview: { steps: [], total: 0 },
```

and add `domains: []` to the `facets` object of `view()` (workforce-catalog), `view()` (catalog-duplicates) and `catalogPage()` (workforce-page).

- [ ] **Step 7: Run the web tests**

Run: `npx tsc --build && npx vitest run apps/web/test/catalog-filters.test.ts apps/web/test/integration/catalog-card-rows.test.ts apps/web/test/integration/workforce-catalog.test.ts apps/web/test/workforce-catalog.test.tsx apps/web/test/catalog-duplicates.test.tsx apps/web/test/workforce-page.test.tsx`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/control/src/catalog.ts packages/control/test/integration/catalog-cards.test.ts \
  packages/control/test/integration/catalog-page.test.ts apps/web/src/lib/cardSkills.ts apps/web/src/server/org.ts \
  apps/web/src/lib/catalogFilters.ts apps/web/src/hooks/useCatalogFilters.ts apps/web/test/catalog-filters.test.ts \
  apps/web/test/integration/catalog-card-rows.test.ts apps/web/test/workforce-catalog.test.tsx \
  apps/web/test/catalog-duplicates.test.tsx apps/web/test/workforce-page.test.tsx
git commit -m "feat(catalog): domain facets, specialty and no-skills filters, card skills and workflow preview" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: People read -- `listPeoplePage` (search, specialty, division, skill, "No skills", segment, department, cursor) and `GET /api/persons`

**Files:**
- Create: `apps/web/src/lib/peopleFilters.ts`
- Modify: `apps/web/src/lib/cardSkills.ts` (add `personCardSkills`)
- Modify: `apps/web/src/server/persons.ts` (`personRowOf` extracted from `listPersons`; new `PersonCardRow`, `PeopleFacets`, `PeoplePageView`, `PEOPLE_PAGE_SIZE`, `listPeoplePage`; `SkillCatalogueRow` and a richer `listSkillCatalogue`)
- Create: `apps/web/src/app/api/persons/route.ts`
- Test: `apps/web/test/people-filters.test.ts`, `apps/web/test/card-skills.test.ts`, `apps/web/test/integration/people-page.test.ts` (all new)

**Interfaces:**
- Consumes: `CardSkillRow`, `CARD_SKILL_SELECT`, `CardSkillSource`, `cardSkillOf`, `byCardOrder` (Task 2); `capabilityKeysInDomain`, `escapeLikeWildcards`, `listCapabilities`, `CapabilityDomainFacet` (Task 2, control); `effectiveSkills`, `normalisePersona`, `storedWorkflowPreview`, `NO_WORKFLOW_PREVIEW`, `WorkflowPreview` (domain); `CATALOG_NO_SKILLS` (Task 2).
- Produces:
  - `PEOPLE_STATES = ['pool', 'assigned', 'released'] as const`, `type PeopleState`, `interface PeopleFilters { q?; specialty?; division?; skillId?; noSkills?: boolean; state?: PeopleState; department? }`, `type PeopleFilterKey`, `PEOPLE_FILTER_PARAMS`, `parsePeopleFilters(params: URLSearchParams): PeopleFilters`, `peopleFilterParams(filters: PeopleFilters): URLSearchParams`, `withPeopleFilter(filters: PeopleFilters, key: PeopleFilterKey, value: string): PeopleFilters`
  - `personCardSkills(input: { readonly templateSkills: readonly CardSkillSource[]; readonly personSkills: readonly (CardSkillSource & { readonly mode: 'granted' | 'revoked' })[] }): readonly CardSkillRow[]`
  - `interface PersonCardRow extends PersonRow { readonly division: string | null; readonly skills: readonly CardSkillRow[]; readonly workflowPreview: WorkflowPreview }`
  - `interface PeopleFacets { readonly domains: readonly CapabilityDomainFacet[]; readonly divisions: readonly string[] }`
  - `interface PeoplePageView { readonly rows: readonly PersonCardRow[]; readonly facets: PeopleFacets; readonly total: number; readonly nextCursor: string | null }`
  - `PEOPLE_PAGE_SIZE = 100`; `listPeoplePage(filters?: PeopleFilters, options?: { readonly cursor?: string }): Promise<PeoplePageView>`
  - `interface SkillCatalogueRow { skillId; name; providerName; description: string; missing: boolean }`; `listSkillCatalogue(): Promise<readonly SkillCatalogueRow[]>`
  - `GET /api/persons?q=&specialty=&division=&skillId=&skills=none&state=&department=&cursor=` -> `PeoplePageView` JSON

- [ ] **Step 1: Write the failing unit tests**

`apps/web/test/people-filters.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PEOPLE_STATES, parsePeopleFilters, peopleFilterParams, withPeopleFilter } from '../src/lib/peopleFilters.js'

describe('parsePeopleFilters', () => {
  it('reads the seven dimensions People filters on', () => {
    const params = new URLSearchParams('q=atlas&specialty=frontend&division=engineering&skillId=s1&skills=none&state=pool&department=ct1')
    expect(parsePeopleFilters(params)).toEqual({
      q: 'atlas',
      specialty: 'frontend',
      division: 'engineering',
      skillId: 's1',
      noSkills: true,
      state: 'pool',
      department: 'ct1',
    })
  })

  it('drops a segment or a skills value outside its vocabulary rather than refusing the link', () => {
    expect(parsePeopleFilters(new URLSearchParams('state=sleeping&skills=all&q=%20'))).toEqual({})
  })

  it('offers exactly the three segments a person can be in', () => {
    expect(PEOPLE_STATES).toEqual(['pool', 'assigned', 'released'])
  })

  it('round-trips through peopleFilterParams', () => {
    const filters = { q: 'atlas', specialty: 'qa', noSkills: true, state: 'released' as const }
    expect(parsePeopleFilters(peopleFilterParams(filters))).toEqual(filters)
    expect(peopleFilterParams({}).toString()).toBe('')
  })
})

describe('withPeopleFilter', () => {
  it('sets one dimension and keeps the others', () => {
    expect(withPeopleFilter({ q: 'atlas' }, 'specialty', 'qa')).toEqual({ q: 'atlas', specialty: 'qa' })
  })

  it('reads an empty value as "drop this one"', () => {
    expect(withPeopleFilter({ q: 'atlas', state: 'pool' }, 'state', '')).toEqual({ q: 'atlas' })
    expect(withPeopleFilter({ noSkills: true }, 'noSkills', '')).toEqual({})
  })

  it('ignores a segment word it does not know', () => {
    expect(withPeopleFilter({}, 'state', 'sleeping')).toEqual({})
  })
})
```

`apps/web/test/card-skills.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { personCardSkills } from '../src/lib/cardSkills.js'

const skill = (id: string, name: string, over: { readonly missing?: boolean; readonly provider?: string } = {}) => ({
  id,
  name,
  missingSince: over.missing === true ? new Date('2026-09-20T00:00:00.000Z') : null,
  provider: { name: over.provider ?? 'personal' },
})

describe('personCardSkills', () => {
  it('is the effective set with its origins, then the revoked inherited ones, struck', () => {
    const rows = personCardSkills({
      templateSkills: [skill('a', 'pdf'), skill('b', 'sql')],
      personSkills: [
        { ...skill('b', 'sql'), mode: 'revoked' },
        { ...skill('c', 'archived', { missing: true }), mode: 'granted' },
      ],
    })
    expect(rows.map((row) => [row.name, row.state, row.missing])).toEqual([
      ['archived', 'person', true],
      ['pdf', 'persona', false],
      ['sql', 'revoked', false],
    ])
  })

  it('calls a granted skill the persona also gives "persona": removing the grant would not remove it', () => {
    const rows = personCardSkills({
      templateSkills: [skill('a', 'pdf')],
      personSkills: [{ ...skill('a', 'pdf'), mode: 'granted' }],
    })
    expect(rows.map((row) => [row.name, row.state])).toEqual([['pdf', 'persona']])
  })

  it('marks a superpowers skill as a process skill', () => {
    const rows = personCardSkills({ templateSkills: [skill('a', 'brainstorming', { provider: 'plugin:superpowers' })], personSkills: [] })
    expect(rows[0]?.process).toBe(true)
  })
})
```

Run: `npx vitest run apps/web/test/people-filters.test.ts apps/web/test/card-skills.test.ts`
Expected: FAIL -- `Failed to resolve import "../src/lib/peopleFilters.js"`; `personCardSkills` is not exported.

- [ ] **Step 2: Implement the filter vocabulary and `personCardSkills`**

`apps/web/src/lib/peopleFilters.ts`:

```ts
import { CATALOG_NO_SKILLS } from './catalogFilters'

/**
 * People's URL vocabulary (workforce cards §1) -- parsed the same way by `GET /api/persons`, by
 * `/workforce/page.tsx` and by the client hook, the `catalogFilters.ts` precedent. Pure: no prisma,
 * no React. LENIENT the same way: an unknown segment or `skills` value is DROPPED, never refused.
 *
 * `q`, `specialty`, `division` and `skills` are the SAME params the Catalog tab writes, on purpose:
 * the two tabs share one filter bar, so "frontend, nobody equipped yet" carries from one list to the
 * other. `skillId` is People's own -- the Catalog's `skill` is a recommended-skill WORD from the
 * persona text, People's is a linked `Skill` id, and one param meaning both would be a lie on one
 * of the two tabs.
 */
export const PEOPLE_STATES = ['pool', 'assigned', 'released'] as const

export type PeopleState = (typeof PEOPLE_STATES)[number]

export interface PeopleFilters {
  readonly q?: string
  /** A capability domain; a person matches when any of `Person.capabilities` is one of its keys. */
  readonly specialty?: string
  /** The import division of the persona this person was hired from. */
  readonly division?: string
  /** A `Skill.id` this person EFFECTIVELY holds (a revoke wins over the persona). */
  readonly skillId?: string
  /** Only people with no effective skill at all. */
  readonly noSkills?: boolean
  /** The segmented control; absent is "Everyone". */
  readonly state?: PeopleState
  /** A department (`CompanyTeam.id`) the person is a member of. */
  readonly department?: string
}

export type PeopleFilterKey = 'q' | 'specialty' | 'division' | 'skillId' | 'noSkills' | 'state' | 'department'

/** Every param this vocabulary owns in the address bar -- what the hook clears before writing. */
export const PEOPLE_FILTER_PARAMS = ['q', 'specialty', 'division', 'skillId', 'skills', 'state', 'department'] as const

function param(params: URLSearchParams, key: string): string | undefined {
  const raw = (params.get(key) ?? '').trim()
  return raw === '' ? undefined : raw
}

const asState = (value: string | undefined): PeopleState | undefined => PEOPLE_STATES.find((member) => member === value)

export function parsePeopleFilters(params: URLSearchParams): PeopleFilters {
  const q = param(params, 'q')
  const specialty = param(params, 'specialty')
  const division = param(params, 'division')
  const skillId = param(params, 'skillId')
  const state = asState(param(params, 'state'))
  const department = param(params, 'department')
  return {
    ...(q !== undefined ? { q } : {}),
    ...(specialty !== undefined ? { specialty } : {}),
    ...(division !== undefined ? { division } : {}),
    ...(skillId !== undefined ? { skillId } : {}),
    ...(param(params, 'skills') === CATALOG_NO_SKILLS ? { noSkills: true } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(department !== undefined ? { department } : {}),
  }
}

/** The inverse: only the dimensions that are set, so an empty filter is an empty query string. */
export function peopleFilterParams(filters: PeopleFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.q !== undefined) params.set('q', filters.q)
  if (filters.specialty !== undefined) params.set('specialty', filters.specialty)
  if (filters.division !== undefined) params.set('division', filters.division)
  if (filters.skillId !== undefined) params.set('skillId', filters.skillId)
  if (filters.noSkills === true) params.set('skills', CATALOG_NO_SKILLS)
  if (filters.state !== undefined) params.set('state', filters.state)
  if (filters.department !== undefined) params.set('department', filters.department)
  return params
}

/**
 * One dimension changed, the others carried through -- and `''` means "drop this one" (a cleared
 * box, an `any` option, a chip clicked twice). Written out key by key, `CatalogFilterBar`'s
 * `withFilter` reason: a computed-key spread widens to an index signature under
 * `exactOptionalPropertyTypes`.
 */
export function withPeopleFilter(filters: PeopleFilters, key: PeopleFilterKey, value: string): PeopleFilters {
  const q = key === 'q' ? value : filters.q
  const specialty = key === 'specialty' ? value : filters.specialty
  const division = key === 'division' ? value : filters.division
  const skillId = key === 'skillId' ? value : filters.skillId
  const noSkills = key === 'noSkills' ? value === 'true' : filters.noSkills
  const state = key === 'state' ? asState(value) : filters.state
  const department = key === 'department' ? value : filters.department
  return {
    ...(q !== undefined && q !== '' ? { q } : {}),
    ...(specialty !== undefined && specialty !== '' ? { specialty } : {}),
    ...(division !== undefined && division !== '' ? { division } : {}),
    ...(skillId !== undefined && skillId !== '' ? { skillId } : {}),
    ...(noSkills === true ? { noSkills } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(department !== undefined && department !== '' ? { department } : {}),
  }
}
```

`apps/web/src/lib/cardSkills.ts` -- add `effectiveSkills` to the domain import and append:

```ts
/**
 * A person's chips (workforce cards §2): the EFFECTIVE set -- `effectiveSkills`, the same function
 * dispatch uses, so the card cannot promise a skill a run will not get -- each with its origin,
 * then every inherited skill this person REVOKED, struck through, because a person cannot restore
 * what they cannot see (the person panel's rule, M58 R23).
 */
export function personCardSkills(input: {
  readonly templateSkills: readonly CardSkillSource[]
  readonly personSkills: readonly (CardSkillSource & { readonly mode: 'granted' | 'revoked' })[]
}): readonly CardSkillRow[] {
  const byId = new Map([...input.templateSkills, ...input.personSkills].map((skill) => [skill.id, skill] as const))
  const revoked = input.personSkills.filter((skill) => skill.mode === 'revoked').map((skill) => skill.id)
  const effective = effectiveSkills({
    templateSkillIds: input.templateSkills.map((skill) => skill.id),
    granted: input.personSkills.filter((skill) => skill.mode === 'granted').map((skill) => skill.id),
    revoked,
  })
  const held = effective.flatMap((row) => {
    const skill = byId.get(row.skillId)
    return skill === undefined ? [] : [cardSkillOf(skill, row.origin)]
  })
  const struck = input.templateSkills.filter((skill) => revoked.includes(skill.id)).map((skill) => cardSkillOf(skill, 'revoked'))
  return [...held, ...struck].toSorted(byCardOrder)
}
```

Run: `npx vitest run apps/web/test/people-filters.test.ts apps/web/test/card-skills.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 3: Write the failing integration test**

`apps/web/test/integration/people-page.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import { emptyProfileSpec } from '@slave-of-ai/domain'
import { assignPerson, syncCapabilityTaxonomy } from '@slave-of-ai/control'
import { listPeoplePage, listSkillCatalogue, PEOPLE_PAGE_SIZE } from '../../src/server/persons.js'
import { GET as peopleGET } from '../../src/app/api/persons/route.js'
import { truncateAll } from './helpers.js'

beforeEach(async () => {
  await truncateAll()
  await syncCapabilityTaxonomy()
})

async function skill(name: string, over: { readonly provider?: string; readonly missing?: boolean } = {}): Promise<string> {
  const providerName = over.provider ?? 'personal'
  const provider = await prisma.skillProvider.upsert({ where: { name: providerName }, create: { name: providerName }, update: {} })
  const row = await prisma.skill.create({
    data: {
      providerId: provider.id,
      name,
      description: `${name} does a thing`,
      ...(over.missing === true ? { missingSince: new Date() } : {}),
    },
  })
  return row.id
}

async function persona(
  name: string,
  over: { readonly division?: string; readonly searchText?: string; readonly workflow?: readonly string[]; readonly skills?: readonly string[] } = {},
): Promise<string> {
  const row = await prisma.slaveTemplate.create({
    data: {
      name,
      role: 'dev',
      sourceDivision: over.division ?? null,
      searchText: over.searchText ?? name.toLowerCase(),
      ...(over.workflow === undefined
        ? {}
        : { profileSpec: { ...emptyProfileSpec(), workflow: [...over.workflow] } as unknown as Prisma.InputJsonValue }),
    },
  })
  if (over.skills !== undefined) {
    await prisma.templateSkill.createMany({ data: over.skills.map((skillId) => ({ templateId: row.id, skillId })) })
  }
  return row.id
}

async function person(
  name: string,
  over: { readonly templateId?: string; readonly capabilities?: readonly string[]; readonly released?: boolean } = {},
): Promise<string> {
  const row = await prisma.person.create({
    data: {
      name,
      capabilities: [...(over.capabilities ?? [])],
      ...(over.templateId === undefined ? {} : { templateId: over.templateId }),
      ...(over.released === true ? { releasedAt: new Date(), releaseReason: 'done' } : {}),
    },
  })
  return row.id
}

const names = (view: { readonly rows: readonly { readonly name: string }[] }): string[] => view.rows.map((row) => row.name)

describe('listPeoplePage', () => {
  it('hands each person their chips: origins, a revoked inherited skill, a missing one', async () => {
    const pdf = await skill('pdf')
    const sql = await skill('sql')
    const gone = await skill('archived', { missing: true })
    const builder = await persona('Builder', { division: 'engineering', skills: [pdf, sql] })
    const atlas = await person('Atlas', { templateId: builder })
    await prisma.personSkill.createMany({
      data: [
        { personId: atlas, skillId: sql, mode: 'revoked' },
        { personId: atlas, skillId: gone, mode: 'granted' },
      ],
    })

    const row = (await listPeoplePage()).rows.find((one) => one.name === 'Atlas')
    expect(row?.skills.map((one) => [one.name, one.state, one.missing])).toEqual([
      ['archived', 'person', true],
      ['pdf', 'persona', false],
      ['sql', 'revoked', false],
    ])
    expect(row?.skillCount).toBe(2)
    expect(row?.division).toBe('engineering')
    expect(row?.personaName).toBe('Builder')
  })

  it('searches the name, the persona text and a skill name', async () => {
    const maker = await skill('pdf-maker')
    const builder = await persona('Builder', { searchText: 'builds the core' })
    await person('Atlas', { templateId: builder })
    const zed = await person('Zed')
    await prisma.personSkill.create({ data: { personId: zed, skillId: maker, mode: 'granted' } })

    expect(names(await listPeoplePage({ q: 'atl' }))).toEqual(['Atlas'])
    expect(names(await listPeoplePage({ q: 'core' }))).toEqual(['Atlas'])
    expect(names(await listPeoplePage({ q: 'PDF-maker' }))).toEqual(['Zed'])
  })

  it('counts specialty domains over people and filters by one; an unknown domain is empty', async () => {
    await person('Ada', { capabilities: ['frontend.styling', 'frontend.accessibility'] })
    await person('Bo', { capabilities: ['frontend.styling', 'qa.test-strategy'] })

    const all = await listPeoplePage()
    expect(all.facets.domains).toEqual([
      { domain: 'frontend', count: 2 },
      { domain: 'qa', count: 1 },
    ])
    expect(names(await listPeoplePage({ specialty: 'qa' }))).toEqual(['Bo'])
    const unknown = await listPeoplePage({ specialty: 'no-such-domain' })
    expect(unknown.rows).toEqual([])
    expect(unknown.total).toBe(0)
  })

  it('"no skills": nobody granted anything, and every inherited skill revoked counts as none', async () => {
    const pdf = await skill('pdf')
    const builder = await persona('Builder', { skills: [pdf] })
    await person('Equipped', { templateId: builder })
    const revokedAll = await person('Revoked', { templateId: builder })
    await prisma.personSkill.create({ data: { personId: revokedAll, skillId: pdf, mode: 'revoked' } })
    await person('Bare')
    const granted = await person('Granted')
    await prisma.personSkill.create({ data: { personId: granted, skillId: pdf, mode: 'granted' } })

    expect(names(await listPeoplePage({ noSkills: true }))).toEqual(['Bare', 'Revoked'])
    // The skill filter respects the same revoke.
    expect(names(await listPeoplePage({ skillId: pdf }))).toEqual(['Equipped', 'Granted'])
    // An unknown skill id is a stale link: empty, never an error.
    expect((await listPeoplePage({ skillId: 'no-such-skill' })).total).toBe(0)
  })

  it('the three segments, the division and the department', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Alpha', repoPath: '/tmp/Alpha', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const builder = await persona('Builder', { division: 'engineering' })
    await person('Pooled', { templateId: builder })
    const seated = await person('Seated')
    const seat = await assignPerson(seated, team.id)
    expect(seat.ok).toBe(true)
    await person('Released', { released: true })
    const company = await prisma.company.create({ data: { name: 'Co' } })
    const department = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
    await prisma.companyTeamMember.create({ data: { companyTeamId: department.id, personId: seated } })

    expect(names(await listPeoplePage({ state: 'pool' }))).toEqual(['Pooled'])
    expect(names(await listPeoplePage({ state: 'assigned' }))).toEqual(['Seated'])
    expect(names(await listPeoplePage({ state: 'released' }))).toEqual(['Released'])
    expect(names(await listPeoplePage({ division: 'engineering' }))).toEqual(['Pooled'])
    expect(names(await listPeoplePage({ department: department.id }))).toEqual(['Seated'])
    expect((await listPeoplePage()).facets.divisions).toEqual(['engineering'])
  })

  it('pages a pool of hundreds a hundred at a time, and the total counts every one', async () => {
    await prisma.person.createMany({
      data: Array.from({ length: 250 }, (_, index) => ({ name: `Pool ${String(index).padStart(3, '0')}` })),
    })

    const first = await listPeoplePage()
    expect(first.rows).toHaveLength(PEOPLE_PAGE_SIZE)
    expect(first.total).toBe(250)
    expect(first.nextCursor).toBe(first.rows.at(-1)?.personId)
    const second = await listPeoplePage({}, { cursor: first.nextCursor ?? '' })
    expect(second.rows[0]?.name).toBe('Pool 100')
    const third = await listPeoplePage({}, { cursor: second.nextCursor ?? '' })
    expect(third.rows).toHaveLength(50)
    expect(third.nextCursor).toBeNull()
  })

  it("previews the persona's workflow, and nothing for a person made from nothing", async () => {
    const builder = await persona('Builder', { workflow: ['Read', 'Plan', 'Build', 'Test'] })
    await person('Atlas', { templateId: builder })
    await person('Zed')

    const rows = (await listPeoplePage()).rows
    expect(rows.find((row) => row.name === 'Atlas')?.workflowPreview).toEqual({ steps: ['Read', 'Plan', 'Build'], total: 4 })
    expect(rows.find((row) => row.name === 'Zed')?.workflowPreview).toEqual({ steps: [], total: 0 })
  })
})

describe('GET /api/persons', () => {
  it('reads the filters and the cursor off the URL', async () => {
    await person('Pooled')
    await person('Released', { released: true })

    const response = await peopleGET(new Request('http://x/api/persons?state=released&cursor='))
    expect(response.status).toBe(200)
    expect(names((await response.json()) as { rows: { name: string }[] })).toEqual(['Released'])
  })
})

describe('listSkillCatalogue', () => {
  it('carries the description and whether the skill is missing, for the picker', async () => {
    await skill('archived', { missing: true })
    expect(await listSkillCatalogue()).toEqual([
      expect.objectContaining({ name: 'archived', providerName: 'personal', description: 'archived does a thing', missing: true }),
    ])
  })
})
```

Run: `npx vitest run apps/web/test/integration/people-page.test.ts`
Expected: FAIL -- `listPeoplePage` is not exported, `../../src/app/api/persons/route.js` does not resolve.

- [ ] **Step 4: Implement the read and the route**

`apps/web/src/server/persons.ts`:

- imports become:

```ts
import { type Prisma, prisma } from '@slave-of-ai/db/client'
import {
  capabilityKeysInDomain,
  escapeLikeWildcards,
  listCapabilities,
  type CapabilityDomainFacet,
  type ProviderKind,
} from '@slave-of-ai/control'
import {
  NO_WORKFLOW_PREVIEW,
  USER_PERSON_LABEL,
  effectiveModelFor,
  effectiveProfileFor,
  effectiveProviderFor,
  effectiveSkills,
  normalisePersona,
  storedWorkflowPreview,
  userPersonStatus,
  type CapabilityRecord,
  type OverrideOrigin,
  type SlaveLifecycle,
  type UserPersonState,
  type WorkflowPreview,
} from '@slave-of-ai/domain'
import type { PeopleFilters } from '../lib/peopleFilters'
import { CARD_SKILL_SELECT, personCardSkills, type CardSkillRow, type CardSkillSource } from '../lib/cardSkills'
```

- after `seatRowOf`, add `personRowOf` and make `listPersons` use it (its body keeps the three reads; only the `return people.map(...)` changes to `return people.map((person) => personRowOf(person, effectiveSkills({...}).length))` with the same `effectiveSkills` argument it builds today):

```ts
/** The fields every People row carries, off one person read -- ONE place, so the unpaged list the
 *  company pickers use and the card page cannot disagree about a person's state or seats. */
function personRowOf(
  person: {
    readonly id: string
    readonly name: string
    readonly capabilities: readonly string[]
    readonly lifecycle: SlaveLifecycle
    readonly releasedAt: Date | null
    readonly releaseReason: string | null
    readonly template: { readonly id: string; readonly name: string } | null
    readonly departments: readonly { readonly companyTeam: { readonly id: string; readonly name: string } }[]
    readonly seats: readonly Parameters<typeof seatRowOf>[0][]
  },
  skillCount: number,
): PersonRow {
  const status = userPersonStatus({
    releasedAt: person.releasedAt?.toISOString() ?? null,
    openSeats: person.seats.length,
  })
  return {
    personId: person.id,
    name: person.name,
    personaId: person.template?.id ?? null,
    personaName: person.template?.name ?? null,
    state: status.state,
    stateLabel: USER_PERSON_LABEL[status.state],
    departments: person.departments.map((row) => ({ companyTeamId: row.companyTeam.id, name: row.companyTeam.name })),
    seats: person.seats.map((seat) => seatRowOf(seat)),
    skillCount,
    capabilities: person.capabilities,
    lifecycle: person.lifecycle,
    releasedAt: person.releasedAt?.toISOString() ?? null,
    releaseReason: person.releaseReason,
  }
}
```

- append the card page:

```ts
/** One person as a workforce CARD draws them (spec §2): the People row, plus the persona's import
 *  division, the chips and the persona's workflow preview. */
export interface PersonCardRow extends PersonRow {
  readonly division: string | null
  readonly skills: readonly CardSkillRow[]
  /** The workflow of the persona this person was hired from, overrides applied. A person-level
   *  profile override is free Markdown with no structured workflow to read, so it is not consulted;
   *  a person made from nothing previews nothing. */
  readonly workflowPreview: WorkflowPreview
}

/** People's filter menus -- over EVERY person, before any filter ran (M46 R6's rule). */
export interface PeopleFacets {
  readonly domains: readonly CapabilityDomainFacet[]
  /** The import divisions of the personas anybody here was hired from. */
  readonly divisions: readonly string[]
}

export interface PeoplePageView {
  readonly rows: readonly PersonCardRow[]
  readonly facets: PeopleFacets
  /** Every person this filter matches, so the count can say `showing 100 of 312`. */
  readonly total: number
  /** Pass back as `?cursor=` for the next page; null when this page is the end. */
  readonly nextCursor: string | null
}

/** The Catalog's own page size (`CATALOG_PAGE_SIZE`): the pool keeps up to three people per
 *  persona, so a full import makes People several hundred long -- a page, not a list. */
export const PEOPLE_PAGE_SIZE = 100

/**
 * The ids of every person with NO effective skill: no grant, and no inherited skill they have not
 * revoked. Raw SQL because "every one of the persona's skills is revoked BY THIS PERSON" correlates
 * two relations on the person's own id, which a Prisma relation filter cannot say. Bounded by the
 * People table itself -- hundreds of ids, fed back as one `in`.
 */
async function peopleWithNoSkills(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Person" p
    WHERE NOT EXISTS (SELECT 1 FROM "PersonSkill" g WHERE g."personId" = p.id AND g.mode = 'granted')
      AND NOT EXISTS (
        SELECT 1 FROM "TemplateSkill" t
        WHERE t."templateId" = p."templateId"
          AND NOT EXISTS (
            SELECT 1 FROM "PersonSkill" r WHERE r."personId" = p.id AND r."skillId" = t."skillId" AND r.mode = 'revoked'
          )
      )
  `
  return rows.map((row) => row.id)
}

/** Every filter as a Prisma clause -- the catalog's `catalogWhere` idiom, over `Person`. */
async function peopleWhere(filters: PeopleFilters, taxonomy: readonly CapabilityRecord[]): Promise<Prisma.PersonWhereInput> {
  const clauses: Prisma.PersonWhereInput[] = []
  const q = (filters.q ?? '').trim()
  if (q !== '') {
    const raw = escapeLikeWildcards(q)
    const folded = normalisePersona(q)
    clauses.push({
      OR: [
        { name: { contains: raw, mode: 'insensitive' } },
        // The persona's own words -- summary, capabilities, expertise -- folded exactly as the
        // catalog folds its search, because `searchText` was folded that way.
        ...(folded === '' ? [] : [{ template: { searchText: { contains: escapeLikeWildcards(folded) } } }]),
        { skills: { some: { mode: 'granted', skill: { name: { contains: raw, mode: 'insensitive' } } } } },
        { template: { defaultSkills: { some: { skill: { name: { contains: raw, mode: 'insensitive' } } } } } },
      ],
    })
  }
  if (filters.specialty !== undefined) {
    const keys = capabilityKeysInDomain(filters.specialty, taxonomy)
    // An unknown domain matches NOTHING, spelled out (the catalog's rule).
    clauses.push(keys.length === 0 ? { id: { in: [] } } : { capabilities: { hasSome: keys } })
  }
  if (filters.division !== undefined) clauses.push({ template: { sourceDivision: filters.division } })
  if (filters.department !== undefined) clauses.push({ departments: { some: { companyTeamId: filters.department } } })
  if (filters.skillId !== undefined) {
    // EFFECTIVELY held: granted, or inherited and not revoked -- `effectiveSkills` as a clause.
    clauses.push({
      OR: [
        { skills: { some: { skillId: filters.skillId, mode: 'granted' } } },
        {
          AND: [
            { template: { defaultSkills: { some: { skillId: filters.skillId } } } },
            { skills: { none: { skillId: filters.skillId, mode: 'revoked' } } },
          ],
        },
      ],
    })
  }
  // `userPersonStatus`, as three clauses: released wins, then any open seat, then the pool.
  if (filters.state === 'released') clauses.push({ releasedAt: { not: null } })
  if (filters.state === 'assigned') clauses.push({ releasedAt: null, seats: { some: { closedAt: null } } })
  if (filters.state === 'pool') clauses.push({ releasedAt: null, seats: { none: { closedAt: null } } })
  if (filters.noSkills === true) clauses.push({ id: { in: await peopleWithNoSkills() } })
  return clauses.length === 0 ? {} : { AND: clauses }
}

async function readPeopleFacets(): Promise<PeopleFacets> {
  const [domainRows, divisionRows] = await Promise.all([
    // One row per domain, a person counted ONCE however many keys they carry in it; joined to the
    // taxonomy so a chip's count is exactly what clicking it returns.
    prisma.$queryRaw<{ domain: string; count: number }[]>`
      SELECT c.domain AS domain, count(DISTINCT p.id)::int AS count
      FROM "Person" p
      CROSS JOIN LATERAL unnest(p.capabilities) AS k(key)
      JOIN "Capability" c ON c.key = k.key
      GROUP BY c.domain
      ORDER BY count DESC, domain ASC
    `,
    prisma.slaveTemplate.findMany({
      where: { sourceDivision: { not: null }, hiredPersons: { some: {} } },
      select: { sourceDivision: true },
      distinct: ['sourceDivision'],
      orderBy: { sourceDivision: 'asc' },
    }),
  ])
  return {
    domains: domainRows.map((row) => ({ domain: row.domain, count: row.count })),
    divisions: divisionRows.flatMap((row) => (row.sourceDivision === null ? [] : [row.sourceDivision])),
  }
}

/**
 * People as CARDS (workforce cards §1/§5), filtered, faceted and PAGED in the database the way the
 * catalog is -- client-side filtering over several hundred pool people plus facets was the wrong
 * place for it.
 *
 * Five queries for a page, never one per person: the taxonomy (the specialty clause needs it), the
 * page, its count, the facets, and every persona default skill of every persona on the page.
 */
export async function listPeoplePage(
  filters: PeopleFilters = {},
  options: { readonly cursor?: string } = {},
): Promise<PeoplePageView> {
  const where = await peopleWhere(filters, await listCapabilities())
  const [people, total, facets] = await Promise.all([
    prisma.person.findMany({
      where,
      // `name` is unique, `id` makes the order total by construction -- the catalog's cursor rule.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: PEOPLE_PAGE_SIZE,
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
      include: {
        template: { select: { id: true, name: true, sourceDivision: true, profileSpec: true, profileOverrides: true } },
        departments: { include: { companyTeam: { select: { id: true, name: true } } } },
        skills: { select: { mode: true, skill: { select: CARD_SKILL_SELECT } } },
        seats: { where: { closedAt: null }, include: seatInclude },
      },
    }),
    prisma.person.count({ where }),
    readPeopleFacets(),
  ])
  const templateIds = [...new Set(people.flatMap((person) => (person.templateId === null ? [] : [person.templateId])))]
  const templateSkills =
    templateIds.length === 0
      ? []
      : await prisma.templateSkill.findMany({
          where: { templateId: { in: templateIds } },
          select: { templateId: true, skill: { select: CARD_SKILL_SELECT } },
        })
  const defaultsByTemplate = new Map<string, CardSkillSource[]>()
  for (const row of templateSkills) {
    const list = defaultsByTemplate.get(row.templateId)
    if (list === undefined) defaultsByTemplate.set(row.templateId, [row.skill])
    else list.push(row.skill)
  }

  const rows = people.map((person): PersonCardRow => {
    const skills = personCardSkills({
      templateSkills: person.templateId === null ? [] : (defaultsByTemplate.get(person.templateId) ?? []),
      personSkills: person.skills.map((row) => ({ ...row.skill, mode: row.mode })),
    })
    return {
      ...personRowOf(person, skills.filter((skill) => skill.state !== 'revoked').length),
      division: person.template?.sourceDivision ?? null,
      skills,
      workflowPreview:
        person.template === null
          ? NO_WORKFLOW_PREVIEW
          : storedWorkflowPreview(person.template.profileSpec, person.template.profileOverrides),
    }
  })
  return {
    rows,
    facets,
    total,
    // A short page is the end (the catalog's rule); a full one hands back a cursor even when
    // nothing follows, which costs one empty request and never a missing row.
    nextCursor: people.length < PEOPLE_PAGE_SIZE ? null : (people.at(-1)?.id ?? null),
  }
}
```

- `listSkillCatalogue` becomes richer (the picker needs the description to search and `missing` to disable); its callers keep compiling because the new fields only ADD to the shape they already take:

```ts
/** One skill the picker offers (workforce cards §3) -- and what the two drawers' editors read. */
export interface SkillCatalogueRow {
  readonly skillId: string
  readonly name: string
  readonly providerName: string
  readonly description: string
  /** `Skill.missingSince` is set -- shown greyed, and an add of it is refused (`skill_missing`). */
  readonly missing: boolean
}

/** Every skill there is, for the editors and the picker that add one (R23, R25, workforce cards). */
export async function listSkillCatalogue(): Promise<readonly SkillCatalogueRow[]> {
  const rows = await prisma.skill.findMany({
    orderBy: [{ provider: { name: 'asc' } }, { name: 'asc' }],
    include: { provider: { select: { name: true } } },
  })
  return rows.map((row) => ({
    skillId: row.id,
    name: row.name,
    providerName: row.provider.name,
    description: row.description,
    missing: row.missingSince !== null,
  }))
}
```

`apps/web/src/app/api/persons/route.ts`:

```ts
import { parsePeopleFilters } from '../../../lib/peopleFilters'
import { listPeoplePage } from '../../../server/persons'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/** People as cards (workforce cards §1): the params `peopleFilters.ts` parses, plus an opaque
 *  `?cursor=` -- the id of the last person on the page before this one. A blank cursor is the first
 *  page, never an error (`/api/org/catalog`'s rule). */
export async function GET(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const params = new URL(request.url).searchParams
  const cursor = (params.get('cursor') ?? '').trim()
  return Response.json(await listPeoplePage(parsePeopleFilters(params), cursor === '' ? {} : { cursor }))
}
```

- [ ] **Step 5: Run the tests**

Run: `npx tsc --build && npx vitest run apps/web/test/people-filters.test.ts apps/web/test/card-skills.test.ts apps/web/test/integration/people-page.test.ts apps/web/test/integration/persons-read.test.ts`
Expected: PASS (`persons-read.test.ts` proves the `personRowOf` extraction changed nothing for `listPersons`).

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/peopleFilters.ts apps/web/src/lib/cardSkills.ts apps/web/src/server/persons.ts \
  apps/web/src/app/api/persons/route.ts apps/web/test/people-filters.test.ts apps/web/test/card-skills.test.ts \
  apps/web/test/integration/people-page.test.ts
git commit -m "feat(persons): listPeoplePage -- server-paged, faceted People with card skills" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Safe skill writes -- persona add/remove delta, `skill_missing`, and the card's scope rule

**Files:**
- Modify: `packages/control/src/personSkills.ts` (new `changeTemplateSkills`, private `refuseUnlinkable`; `setTemplateSkills` and `setPersonSkills` refuse a missing skill on ADD)
- Modify: `packages/control/src/refusal.ts` (`skill_missing` member + `refusalText` case)
- Modify: `apps/web/src/app/api/org/templates/[templateId]/skills/route.ts` (accepts `{ add?, remove? }` beside `{ skillIds }`)
- Create: `apps/web/src/lib/skillWrites.ts`
- Test: `packages/control/test/integration/person-skills.test.ts` (append), `apps/web/test/skill-writes.test.ts` (new), `apps/web/test/integration/skill-writes.test.ts` (new)

**Interfaces:**
- Consumes: `setTemplateSkills`, `setPersonSkills` (existing), `orgControlResponse` (`apps/web/src/server/orgControlRoute.ts`), `CardSkillRow['state']` (Task 2).
- Produces:
  - `changeTemplateSkills(templateId: string, change: { readonly add?: readonly string[]; readonly remove?: readonly string[] }): Promise<Result<{ readonly skills: readonly string[] }, ControlRefusal>>`
  - `ControlRefusal` member `{ readonly kind: 'skill_missing'; readonly skillId: string; readonly name: string }` (HTTP 409 through `refusalStatus`)
  - `PATCH /api/org/templates/[templateId]/skills` body `{ "skillIds": string[] }` (set, unchanged) OR `{ "add"?: string[], "remove"?: string[] }` (delta)
  - `type SkillScope = 'person' | 'persona'`; `type SkillTarget = { kind: 'persona'; templateId } | { kind: 'person'; personId; personaId: string | null; personaName: string | null }`; `interface SkillWrite { readonly url: string; readonly body: Readonly<Record<string, readonly string[]>> }`
  - `addSkillWrite(target: SkillTarget, skillId: string, scope: SkillScope): SkillWrite`
  - `removeSkillWrite(target: SkillTarget, skill: { readonly skillId: string; readonly state: CardSkillRow['state'] }, scope: SkillScope): SkillWrite`
  - `restoreSkillWrite(target: SkillTarget & { readonly kind: 'person' }, skillId: string): SkillWrite`

- [ ] **Step 1: Write the failing control tests**

Append to `packages/control/test/integration/person-skills.test.ts` (and add `changeTemplateSkills` to its import from `../../src/personSkills.js`):

```ts
describe('changeTemplateSkills (workforce cards)', () => {
  it('adds without touching the other links', async () => {
    const { pdf, sql } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await setTemplateSkills(template.id, [pdf])

    const result = await changeTemplateSkills(template.id, { add: [sql] })
    expect(result.ok && result.value.skills).toEqual([pdf, sql].toSorted())
  })

  it('removes only what it names', async () => {
    const { pdf, sql } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await setTemplateSkills(template.id, [pdf, sql])

    const result = await changeTemplateSkills(template.id, { remove: [pdf] })
    expect(result.ok && result.value.skills).toEqual([sql])
  })

  it('two concurrent adds from two cards both land -- a delta cannot drop the other one', async () => {
    const { pdf, sql } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })

    const [a, b] = await Promise.all([
      changeTemplateSkills(template.id, { add: [pdf] }),
      changeTemplateSkills(template.id, { add: [sql] }),
    ])
    expect(a.ok && b.ok).toBe(true)
    const rows = await prisma.templateSkill.findMany({ where: { templateId: template.id } })
    expect(rows.map((row) => row.skillId).toSorted()).toEqual([pdf, sql].toSorted())
  })

  it('adding a skill that is already linked is not an error and not a second row', async () => {
    const { pdf } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await changeTemplateSkills(template.id, { add: [pdf] })

    expect((await changeTemplateSkills(template.id, { add: [pdf] })).ok).toBe(true)
    expect(await prisma.templateSkill.count()).toBe(1)
  })

  it('refuses the same skill in add and remove, an unknown template and an unknown skill', async () => {
    const { pdf } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })

    const both = await changeTemplateSkills(template.id, { add: [pdf], remove: [pdf] })
    expect(!both.ok && both.error.kind).toBe('invalid_request')
    const noTemplate = await changeTemplateSkills('nope', { add: [pdf] })
    expect(!noTemplate.ok && noTemplate.error.kind).toBe('template_not_found')
    const noSkill = await changeTemplateSkills(template.id, { add: ['nope'] })
    expect(!noSkill.ok && noSkill.error.kind).toBe('skill_not_found')
    expect(await prisma.templateSkill.count()).toBe(0)
  })
})

describe('a skill missing from disk (workforce cards)', () => {
  const markMissing = async (skillId: string): Promise<void> => {
    await prisma.skill.update({ where: { id: skillId }, data: { missingSince: new Date() } })
  }

  it('cannot be ADDED to a persona, by delta or by set, and nothing is written', async () => {
    const { pdf } = await twoSkills()
    await markMissing(pdf)
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })

    const delta = await changeTemplateSkills(template.id, { add: [pdf] })
    expect(!delta.ok && delta.error).toEqual({ kind: 'skill_missing', skillId: pdf, name: 'pdf' })
    const set = await setTemplateSkills(template.id, [pdf])
    expect(!set.ok && set.error.kind).toBe('skill_missing')
    expect(await prisma.templateSkill.count()).toBe(0)
  })

  it('keeps a link that already existed when the set is re-sent, and can still be removed', async () => {
    const { pdf, sql } = await twoSkills()
    const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
    await setTemplateSkills(template.id, [pdf])
    await markMissing(pdf)

    expect((await setTemplateSkills(template.id, [pdf, sql])).ok).toBe(true)
    expect((await changeTemplateSkills(template.id, { remove: [pdf] })).ok).toBe(true)
  })

  it('cannot be GRANTED to a person; a revoke of it still works', async () => {
    const { pdf } = await twoSkills()
    await markMissing(pdf)
    const person = await createPerson({ name: 'Atlas' })
    if (!person.ok) throw new Error('setup')

    const grant = await setPersonSkills(person.value.personId, { grant: [pdf] })
    expect(!grant.ok && grant.error.kind).toBe('skill_missing')
    expect((await setPersonSkills(person.value.personId, { revoke: [pdf] })).ok).toBe(true)
  })
})
```

Run: `npx vitest run packages/control/test/integration/person-skills.test.ts`
Expected: FAIL -- `changeTemplateSkills` is not exported.

- [ ] **Step 2: Implement the control side**

`packages/control/src/refusal.ts`, directly after the `skill_not_found` member of the union:

```ts
  /** Workforce cards: an ADD of a skill a scan could not find on disk (`Skill.missingSince` set) --
   *  an uninstalled plugin's skill, say. The links it already has stay (the catalog never deletes),
   *  but a NEW one would promise a worker a skill no run can load. */
  | { readonly kind: 'skill_missing'; readonly skillId: string; readonly name: string }
```

and in `refusalText`, after `case 'skill_not_found':`'s return:

```ts
    case 'skill_missing':
      return `the skill ${refusal.name} is missing from disk; it can be linked again once a skills scan finds it`
```

`packages/control/src/personSkills.ts`:

- below the imports, add:

```ts
/**
 * The refusal an ADD of these skill ids earns, or null (workforce cards): an id no `Skill` row
 * carries is `skill_not_found`, a row a scan could not find on disk is `skill_missing`. Only ADDS
 * are asked -- removing, revoking or clearing a missing skill is how an operator tidies up after an
 * uninstalled plugin, and refusing that would strand the link.
 */
async function refuseUnlinkable(skillIds: readonly string[]): Promise<ControlRefusal | null> {
  if (skillIds.length === 0) return null
  const found = await prisma.skill.findMany({
    where: { id: { in: [...skillIds] } },
    select: { id: true, name: true, missingSince: true },
  })
  const unknown = skillIds.find((id) => !found.some((skill) => skill.id === id))
  if (unknown !== undefined) return { kind: 'skill_not_found', skillId: unknown }
  const missing = found.find((skill) => skill.missingSince !== null)
  return missing === undefined ? null : { kind: 'skill_missing', skillId: missing.id, name: missing.name }
}
```

- in `setTemplateSkills`, after the existing `if (missing !== undefined) return err({ kind: 'skill_not_found', skillId: missing })`:

```ts
  // Workforce cards: only a NEWLY linked skill must be on disk -- re-sending a set that still holds
  // a link whose plugin was since uninstalled is not an add, and refusing it would make the whole
  // list uneditable until the plugin came back.
  const current = await prisma.templateSkill.findMany({ where: { templateId }, select: { skillId: true } })
  const refused = await refuseUnlinkable(wanted.filter((id) => !current.some((row) => row.skillId === id)))
  if (refused !== null) return err(refused)
```

- in `setPersonSkills`, after the existing `skill_not_found` return:

```ts
  const refused = await refuseUnlinkable(grant)
  if (refused !== null) return err(refused)
```

- after `setTemplateSkills`, add:

```ts
/**
 * The persona's default skills, changed by a DELTA (workforce cards §3): add these, remove those,
 * leave every other link exactly as it is.
 *
 * `setTemplateSkills` takes the WHOLE list, which is right for the drawer's editor and wrong for a
 * card: two cards adding two different skills to one persona at the same moment would each send
 * "the set I saw plus mine", and the second write would silently drop the first one's skill. A
 * delta cannot lose a link it does not name. `createMany({ skipDuplicates })` makes an add of a
 * skill that is already there a no-op rather than a unique-constraint failure, which is also what
 * lets two concurrent adds of the SAME skill both succeed.
 *
 * Validated before the transaction (`refuseUnlinkable`), so a refusal is a returned value and never
 * a write that has to be rolled back.
 */
export async function changeTemplateSkills(
  templateId: string,
  change: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
): Promise<Result<{ readonly skills: readonly string[] }, ControlRefusal>> {
  const add = [...new Set(change.add ?? [])]
  const remove = [...new Set(change.remove ?? [])]
  if (add.some((id) => remove.includes(id))) return err({ kind: 'invalid_request' })
  const template = await prisma.slaveTemplate.findUnique({ where: { id: templateId }, select: { id: true } })
  if (template === null) return err({ kind: 'template_not_found', templateId })
  const refused = await refuseUnlinkable(add)
  if (refused !== null) return err(refused)

  await prisma.$transaction(async (tx) => {
    if (remove.length > 0) await tx.templateSkill.deleteMany({ where: { templateId, skillId: { in: remove } } })
    if (add.length > 0) {
      await tx.templateSkill.createMany({ data: add.map((skillId) => ({ templateId, skillId })), skipDuplicates: true })
    }
  })
  const rows = await prisma.templateSkill.findMany({ where: { templateId }, select: { skillId: true } })
  return ok({ skills: rows.map((row) => row.skillId).toSorted() })
}
```

Run: `npx vitest run packages/control/test/integration/person-skills.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing web tests**

`apps/web/test/skill-writes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { addSkillWrite, removeSkillWrite, restoreSkillWrite, type SkillTarget } from '../src/lib/skillWrites.js'

const persona: SkillTarget = { kind: 'persona', templateId: 't1' }
const hired: SkillTarget & { kind: 'person' } = { kind: 'person', personId: 'p1', personaId: 't1', personaName: 'Builder' }
const madeFromNothing: SkillTarget & { kind: 'person' } = { kind: 'person', personId: 'p2', personaId: null, personaName: null }

describe('addSkillWrite', () => {
  it('a persona card always writes the persona, as a delta', () => {
    expect(addSkillWrite(persona, 's1', 'person')).toEqual({ url: '/api/org/templates/t1/skills', body: { add: ['s1'] } })
  })

  it('a person card writes the person by default, the persona when asked', () => {
    expect(addSkillWrite(hired, 's1', 'person')).toEqual({ url: '/api/persons/p1/skills', body: { grant: ['s1'] } })
    expect(addSkillWrite(hired, 's1', 'persona')).toEqual({ url: '/api/org/templates/t1/skills', body: { add: ['s1'] } })
  })

  it('a person made from nothing has no persona to write, whatever the scope says', () => {
    expect(addSkillWrite(madeFromNothing, 's1', 'persona')).toEqual({ url: '/api/persons/p2/skills', body: { grant: ['s1'] } })
  })
})

describe('removeSkillWrite', () => {
  it('a persona card removes from the persona', () => {
    expect(removeSkillWrite(persona, { skillId: 's1', state: 'persona' }, 'person')).toEqual({
      url: '/api/org/templates/t1/skills',
      body: { remove: ['s1'] },
    })
  })

  it('an inherited skill is REVOKED for this person, or removed from the persona for everyone', () => {
    expect(removeSkillWrite(hired, { skillId: 's1', state: 'persona' }, 'person')).toEqual({
      url: '/api/persons/p1/skills',
      body: { revoke: ['s1'] },
    })
    expect(removeSkillWrite(hired, { skillId: 's1', state: 'persona' }, 'persona')).toEqual({
      url: '/api/org/templates/t1/skills',
      body: { remove: ['s1'] },
    })
  })

  it("a person's own grant is CLEARED, whatever the scope -- the persona never had it", () => {
    expect(removeSkillWrite(hired, { skillId: 's1', state: 'person' }, 'persona')).toEqual({
      url: '/api/persons/p1/skills',
      body: { clear: ['s1'] },
    })
  })
})

describe('restoreSkillWrite', () => {
  it('takes back the revoke, so the persona speaks again', () => {
    expect(restoreSkillWrite(hired, 's1')).toEqual({ url: '/api/persons/p1/skills', body: { clear: ['s1'] } })
  })
})
```

`apps/web/test/integration/skill-writes.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { createPerson } from '@slave-of-ai/control'
import { PATCH as templateSkillsRoute } from '../../src/app/api/org/templates/[templateId]/skills/route.js'
import { PATCH as personSkillsRoute } from '../../src/app/api/persons/[personId]/skills/route.js'
import { addSkillWrite, removeSkillWrite, restoreSkillWrite, type SkillTarget, type SkillWrite } from '../../src/lib/skillWrites.js'
import { truncateAll } from './helpers.js'

beforeEach(async () => {
  await truncateAll()
})

/** Sends one `SkillWrite` to the handler its URL names -- the card's own `sendControl`, minus the
 *  network. */
async function send(write: SkillWrite): Promise<Response> {
  const request = new Request(`http://localhost${write.url}`, { method: 'PATCH', body: JSON.stringify(write.body) })
  const template = /^\/api\/org\/templates\/([^/]+)\/skills$/.exec(write.url)?.[1]
  if (template !== undefined) return templateSkillsRoute(request, { params: Promise.resolve({ templateId: template }) })
  const person = /^\/api\/persons\/([^/]+)\/skills$/.exec(write.url)?.[1]
  if (person !== undefined) return personSkillsRoute(request, { params: Promise.resolve({ personId: person }) })
  throw new Error(`no route for ${write.url}`)
}

async function fixture(): Promise<{ pdf: string; sql: string; templateId: string; hired: SkillTarget & { kind: 'person' } }> {
  const provider = await prisma.skillProvider.create({ data: { name: 'personal' } })
  const pdf = await prisma.skill.create({ data: { providerId: provider.id, name: 'pdf', description: 'makes pdfs' } })
  const sql = await prisma.skill.create({ data: { providerId: provider.id, name: 'sql', description: 'writes sql' } })
  const template = await prisma.slaveTemplate.create({ data: { name: 'Builder', role: 'dev' } })
  const person = await createPerson({ templateId: template.id, name: 'Atlas' })
  if (!person.ok) throw new Error('setup')
  return {
    pdf: pdf.id,
    sql: sql.id,
    templateId: template.id,
    hired: { kind: 'person', personId: person.value.personId, personaId: template.id, personaName: 'Builder' },
  }
}

const linked = async (templateId: string): Promise<string[]> =>
  (await prisma.templateSkill.findMany({ where: { templateId } })).map((row) => row.skillId).toSorted()

describe('persona skill writes from a card', () => {
  it('an add keeps the other links, and a remove keeps the others too', async () => {
    const { pdf, sql, templateId } = await fixture()
    const persona: SkillTarget = { kind: 'persona', templateId }

    expect((await send(addSkillWrite(persona, pdf, 'person'))).status).toBe(200)
    expect((await send(addSkillWrite(persona, sql, 'person'))).status).toBe(200)
    expect(await linked(templateId)).toEqual([pdf, sql].toSorted())
    expect((await send(removeSkillWrite(persona, { skillId: pdf, state: 'persona' }, 'person'))).status).toBe(200)
    expect(await linked(templateId)).toEqual([sql])
  })

  it('two cards adding at the same moment both keep their skill', async () => {
    const { pdf, sql, templateId } = await fixture()
    const persona: SkillTarget = { kind: 'persona', templateId }

    await Promise.all([send(addSkillWrite(persona, pdf, 'person')), send(addSkillWrite(persona, sql, 'person'))])
    expect(await linked(templateId)).toEqual([pdf, sql].toSorted())
  })

  it('still takes the whole set the drawer sends, and refuses a body that is neither', async () => {
    const { pdf, templateId } = await fixture()
    expect((await send({ url: `/api/org/templates/${templateId}/skills`, body: { skillIds: [pdf] } })).status).toBe(200)
    expect(await linked(templateId)).toEqual([pdf])
    expect((await send({ url: `/api/org/templates/${templateId}/skills`, body: {} })).status).toBe(400)
  })
})

describe('person skill writes and their scope', () => {
  it('"only this person" writes PersonSkill and leaves the persona alone', async () => {
    const { pdf, templateId, hired } = await fixture()

    expect((await send(addSkillWrite(hired, pdf, 'person'))).status).toBe(200)
    expect(await prisma.personSkill.findMany({ where: { personId: hired.personId } })).toEqual([
      { personId: hired.personId, skillId: pdf, mode: 'granted' },
    ])
    expect(await linked(templateId)).toEqual([])
  })

  it('"everyone from the persona" writes TemplateSkill and no PersonSkill', async () => {
    const { pdf, templateId, hired } = await fixture()

    expect((await send(addSkillWrite(hired, pdf, 'persona'))).status).toBe(200)
    expect(await linked(templateId)).toEqual([pdf])
    expect(await prisma.personSkill.count()).toBe(0)
  })

  it('removing an inherited skill revokes it for this person; restore clears the revoke', async () => {
    const { pdf, templateId, hired } = await fixture()
    await send(addSkillWrite(hired, pdf, 'persona'))

    await send(removeSkillWrite(hired, { skillId: pdf, state: 'persona' }, 'person'))
    expect(await prisma.personSkill.findMany({ where: { personId: hired.personId } })).toEqual([
      { personId: hired.personId, skillId: pdf, mode: 'revoked' },
    ])
    expect(await linked(templateId)).toEqual([pdf])
    await send(restoreSkillWrite(hired, pdf))
    expect(await prisma.personSkill.count()).toBe(0)
  })

  it('a missing skill is refused on both routes, with a sentence that names it', async () => {
    const { pdf, templateId, hired } = await fixture()
    await prisma.skill.update({ where: { id: pdf }, data: { missingSince: new Date() } })

    for (const write of [addSkillWrite(hired, pdf, 'person'), addSkillWrite(hired, pdf, 'persona')]) {
      const response = await send(write)
      expect(response.status).toBe(409)
      expect(((await response.json()) as { error: string }).error).toBe(
        'the skill pdf is missing from disk; it can be linked again once a skills scan finds it',
      )
    }
    expect(await linked(templateId)).toEqual([])
    expect(await prisma.personSkill.count()).toBe(0)
  })
})
```

Run: `npx tsc --build && npx vitest run apps/web/test/skill-writes.test.ts apps/web/test/integration/skill-writes.test.ts`
Expected: FAIL -- `Failed to resolve import "../src/lib/skillWrites.js"`.

- [ ] **Step 4: Implement the route and the write mapping**

`apps/web/src/app/api/org/templates/[templateId]/skills/route.ts`:

```ts
import { changeTemplateSkills, setTemplateSkills } from '@slave-of-ai/control'
import { orgControlResponse } from '../../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY = 'the body must be { "skillIds": string[] } or { "add"?: string[], "remove"?: string[] }'

/**
 * M58 R25: the persona's DEFAULT skills -- and changing them changes every person hired from this
 * persona at once, because nothing copies.
 *
 * Two bodies. `{ skillIds }` is the SET the drawer's editor sends, unchanged. `{ add, remove }` is
 * the DELTA a workforce card sends (workforce cards §3): a card never sends a whole list, so two
 * cards editing one persona at once cannot drop each other's skill.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { templateId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY }, { status: 400 })
  const { skillIds, add, remove } = body as { skillIds?: unknown; add?: unknown; remove?: unknown }
  const ids = (value: unknown): readonly string[] | undefined | 'bad' => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some((one) => typeof one !== 'string')) return 'bad'
    return value as readonly string[]
  }
  const [set, a, r] = [ids(skillIds), ids(add), ids(remove)]
  if (set === 'bad' || a === 'bad' || r === 'bad') return Response.json({ error: BODY }, { status: 400 })
  if (set !== undefined) {
    if (a !== undefined || r !== undefined) return Response.json({ error: BODY }, { status: 400 })
    return orgControlResponse(() => setTemplateSkills(templateId, set))
  }
  if (a === undefined && r === undefined) return Response.json({ error: BODY }, { status: 400 })
  return orgControlResponse(() =>
    changeTemplateSkills(templateId, {
      ...(a === undefined ? {} : { add: a }),
      ...(r === undefined ? {} : { remove: r }),
    }),
  )
}
```

`apps/web/src/lib/skillWrites.ts`:

```ts
import type { CardSkillRow } from './cardSkills'

/**
 * Which table a card's skill write lands in (workforce cards §3) -- a pure function, so the scope
 * rule is one place a test can read rather than a branch inside a click handler.
 *
 *   - A PERSONA card always writes the persona, as a delta (`{ add }` / `{ remove }`).
 *   - A PERSON card writes the person (`grant`, `revoke`, `clear`) unless the operator chose
 *     "Everyone from <persona>", which writes the persona the person was hired from.
 *   - A person's OWN grant is cleared whatever the scope says: the persona never had it, so there
 *     is nothing of the persona's to remove.
 */
export type SkillScope = 'person' | 'persona'

export type SkillTarget =
  | { readonly kind: 'persona'; readonly templateId: string }
  | {
      readonly kind: 'person'
      readonly personId: string
      /** Null for a person made from nothing: "Everyone from <persona>" has nobody to write. */
      readonly personaId: string | null
      readonly personaName: string | null
    }

export interface SkillWrite {
  readonly url: string
  readonly body: Readonly<Record<string, readonly string[]>>
}

const personaWrite = (templateId: string, body: SkillWrite['body']): SkillWrite => ({
  url: `/api/org/templates/${templateId}/skills`,
  body,
})

const personWrite = (personId: string, body: SkillWrite['body']): SkillWrite => ({
  url: `/api/persons/${personId}/skills`,
  body,
})

export function addSkillWrite(target: SkillTarget, skillId: string, scope: SkillScope): SkillWrite {
  if (target.kind === 'persona') return personaWrite(target.templateId, { add: [skillId] })
  if (scope === 'persona' && target.personaId !== null) return personaWrite(target.personaId, { add: [skillId] })
  return personWrite(target.personId, { grant: [skillId] })
}

export function removeSkillWrite(
  target: SkillTarget,
  skill: { readonly skillId: string; readonly state: CardSkillRow['state'] },
  scope: SkillScope,
): SkillWrite {
  if (target.kind === 'persona') return personaWrite(target.templateId, { remove: [skill.skillId] })
  if (skill.state !== 'persona') return personWrite(target.personId, { clear: [skill.skillId] })
  if (scope === 'persona' && target.personaId !== null) return personaWrite(target.personaId, { remove: [skill.skillId] })
  return personWrite(target.personId, { revoke: [skill.skillId] })
}

/** A struck-through (revoked) chip's "restore": take back what this person said, so the persona
 *  speaks again -- the person panel's own `clear`. */
export function restoreSkillWrite(target: SkillTarget & { readonly kind: 'person' }, skillId: string): SkillWrite {
  return personWrite(target.personId, { clear: [skillId] })
}
```

- [ ] **Step 5: Run the tests**

Run: `npx tsc --build && npx vitest run apps/web/test/skill-writes.test.ts apps/web/test/integration/skill-writes.test.ts apps/web/test/integration/persons-read.test.ts apps/web/test/refusal-status.test.ts apps/web/test/template-skills-editor.test.tsx`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0 (the new `skill_missing` case keeps `refusalText`'s switch exhaustive).

- [ ] **Step 6: Commit**

```bash
git add packages/control/src/personSkills.ts packages/control/src/refusal.ts \
  packages/control/test/integration/person-skills.test.ts "apps/web/src/app/api/org/templates/[templateId]/skills/route.ts" \
  apps/web/src/lib/skillWrites.ts apps/web/test/skill-writes.test.ts apps/web/test/integration/skill-writes.test.ts
git commit -m "feat(skills): persona skill delta, skill_missing refusal and the card scope rule" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: One filter bar for both tabs -- `WorkforceFilterBar`, `useUrlFilters`, Specialty chips and "No skills"

**Files:**
- Create: `apps/web/src/hooks/useUrlFilters.ts`, `apps/web/src/hooks/usePeopleFilters.ts`
- Modify: `apps/web/src/hooks/useCatalogFilters.ts` (becomes a thin wrapper), `apps/web/src/lib/catalogFilters.ts` (exports `CATALOG_FILTER_PARAMS`, moved out of the hook)
- Create: `apps/web/src/components/workforce/WorkforceFilterBar.tsx`
- Modify: `apps/web/src/components/workforce/CatalogFilterBar.tsx` (wraps `WorkforceFilterBar`; every existing `catalog-*` testid kept)
- Test: `apps/web/test/workforce-filter-bar.test.tsx` (new); regression: `apps/web/test/workforce-catalog.test.tsx`, `apps/web/test/catalog-duplicates.test.tsx`

**Interfaces:**
- Consumes: `CapabilityDomainFacet`, `WorkforceCatalogFacets.domains`, `WorkforceCatalogFilters.specialty/noSkills` (Task 2); `PeopleFilters`, `parsePeopleFilters`, `peopleFilterParams`, `PEOPLE_FILTER_PARAMS`, `withPeopleFilter` (Task 3); `domainLabel` (domain); `CATALOG_SEARCH_DEBOUNCE_MS`.
- Produces:
  - `interface UrlFilterSpec<F> { readonly keys: readonly string[]; readonly parse: (params: URLSearchParams) => F; readonly toParams: (filters: F) => URLSearchParams }`
  - `useUrlFilters<F>(spec: UrlFilterSpec<F>): { readonly filters: F; readonly setFilters: (next: F) => void }`
  - `useCatalogFilters(): { filters: WorkforceCatalogFilters; setFilters }` (same signature as today), `usePeopleFilters(): { filters: PeopleFilters; setFilters: (next: PeopleFilters) => void }`
  - `CATALOG_FILTER_PARAMS` (the nine catalog params)
  - `SPECIALTY_CHIPS = 8`, `CHIP_BUTTON: string`, `chipTone(pressed: boolean): string`
  - `WorkforceFilterBar(props: { testIdPrefix: 'catalog' | 'people'; query: string; onQuery: (next: string) => void; domains: readonly CapabilityDomainFacet[]; specialty: string | undefined; onSpecialty: (next: string) => void; divisions: readonly string[]; division: string | undefined; onDivision: (next: string) => void; skillOptions: readonly { value: string; label: string }[]; skill: string | undefined; onSkill: (next: string) => void; noSkills: boolean; onNoSkills: (next: boolean) => void; filtered: boolean; onClear: () => void; searchPlaceholder: string; children?: React.ReactNode }): React.JSX.Element`
  - testids (`<p>` = `catalog` | `people`): `<p>-filters`, `<p>-search`, `<p>-specialties`, `<p>-specialty-<domain>` (`aria-pressed`, `data-count`), `<p>-specialty-more`, `<p>-division-select`, `<p>-skill-select`, `<p>-no-skills` (`aria-pressed`), `<p>-clear-filters`

- [ ] **Step 1: Write the failing test**

`apps/web/test/workforce-filter-bar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityDomainFacet } from '@slave-of-ai/control'
import { WorkforceFilterBar } from '../src/components/workforce/WorkforceFilterBar.js'
import { usePeopleFilters } from '../src/hooks/usePeopleFilters.js'
import { CATALOG_SEARCH_DEBOUNCE_MS } from '../src/lib/catalogFilters.js'
import { withPeopleFilter } from '../src/lib/peopleFilters.js'

let search = ''
const replaceState = vi.fn()

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
}))

beforeEach(() => {
  search = ''
  replaceState.mockClear()
  vi.stubGlobal('history', { replaceState })
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

/** Ten domains, busiest first -- the order the server hands them in. */
const DOMAINS: readonly CapabilityDomainFacet[] = [
  'frontend', 'backend', 'qa', 'docs', 'design', 'data', 'devops', 'security', 'ai', 'mobile',
].map((domain, index) => ({ domain, count: 10 - index }))

type BarProps = React.ComponentProps<typeof WorkforceFilterBar>

function renderBar(over: Partial<BarProps> = {}): { props: BarProps; rerender: (next: Partial<BarProps>) => void } {
  const props: BarProps = {
    testIdPrefix: 'people',
    query: '',
    onQuery: vi.fn(),
    domains: DOMAINS,
    specialty: undefined,
    onSpecialty: vi.fn(),
    divisions: ['engineering'],
    division: undefined,
    onDivision: vi.fn(),
    skillOptions: [{ value: 's1', label: 'pdf (personal)' }],
    skill: undefined,
    onSkill: vi.fn(),
    noSkills: false,
    onNoSkills: vi.fn(),
    filtered: false,
    onClear: vi.fn(),
    searchPlaceholder: 'name, persona, capability, skill',
    ...over,
  }
  const view = render(<WorkforceFilterBar {...props} />)
  return { props, rerender: (next) => view.rerender(<WorkforceFilterBar {...props} {...next} />) }
}

const chipIds = (): string[] =>
  screen.getAllByTestId(/^people-specialty-(?!more$)/u).map((chip) => chip.getAttribute('data-testid') ?? '')

describe('WorkforceFilterBar', () => {
  it('shows the eight busiest specialties with their counts, the rest behind +N', () => {
    renderBar()
    expect(chipIds()).toHaveLength(8)
    expect(screen.getByTestId('people-specialty-frontend').textContent).toBe('Frontend10')
    expect(screen.getByTestId('people-specialty-qa').textContent).toBe('QA8')
    expect(screen.getByTestId('people-specialty-more').textContent).toBe('+2')
    fireEvent.click(screen.getByTestId('people-specialty-more'))
    expect(chipIds()).toHaveLength(10)
  })

  it('a chip chooses its specialty, and the pressed chip clears it', () => {
    const { props, rerender } = renderBar()
    fireEvent.click(screen.getByTestId('people-specialty-qa'))
    expect(props.onSpecialty).toHaveBeenLastCalledWith('qa')
    rerender({ specialty: 'qa' })
    expect(screen.getByTestId('people-specialty-qa').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('people-specialty-qa'))
    expect(props.onSpecialty).toHaveBeenLastCalledWith('')
  })

  it('keeps a specialty chosen from the folded tail visible after the fold closes', () => {
    renderBar({ specialty: 'mobile' })
    expect(screen.getByTestId('people-specialty-mobile').getAttribute('aria-pressed')).toBe('true')
  })

  it('shows an unknown specialty from a stale link as a pressed chip with 0, so it can be cleared', () => {
    renderBar({ specialty: 'no-such-domain', filtered: true })
    const chip = screen.getByTestId('people-specialty-no-such-domain')
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.getAttribute('data-count')).toBe('0')
    expect(screen.getByTestId('people-clear-filters')).toBeTruthy()
  })

  it('toggles "No skills"', () => {
    const { props, rerender } = renderBar()
    fireEvent.click(screen.getByTestId('people-no-skills'))
    expect(props.onNoSkills).toHaveBeenLastCalledWith(true)
    rerender({ noSkills: true })
    expect(screen.getByTestId('people-no-skills').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('people-no-skills'))
    expect(props.onNoSkills).toHaveBeenLastCalledWith(false)
  })

  it('asks for a search only after the debounce', async () => {
    const { props } = renderBar()
    fireEvent.change(screen.getByTestId('people-search'), { target: { value: 'atl' } })
    expect(props.onQuery).not.toHaveBeenCalled()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CATALOG_SEARCH_DEBOUNCE_MS + 20))
    })
    expect(props.onQuery).toHaveBeenLastCalledWith('atl')
  })

  it('offers the division and the skill as selects', () => {
    const { props } = renderBar()
    fireEvent.change(screen.getByTestId('people-division-select'), { target: { value: 'engineering' } })
    expect(props.onDivision).toHaveBeenLastCalledWith('engineering')
    fireEvent.change(screen.getByTestId('people-skill-select'), { target: { value: 's1' } })
    expect(props.onSkill).toHaveBeenLastCalledWith('s1')
  })
})

/** The bar wired to People's own URL hook, exactly as `PeopleCards` wires it (Task 9). */
function Harness(): React.JSX.Element {
  const { filters, setFilters } = usePeopleFilters()
  return (
    <WorkforceFilterBar
      testIdPrefix="people"
      query={filters.q ?? ''}
      onQuery={(value) => setFilters(withPeopleFilter(filters, 'q', value))}
      domains={DOMAINS}
      specialty={filters.specialty}
      onSpecialty={(value) => setFilters(withPeopleFilter(filters, 'specialty', value))}
      divisions={[]}
      division={filters.division}
      onDivision={(value) => setFilters(withPeopleFilter(filters, 'division', value))}
      skillOptions={[]}
      skill={filters.skillId}
      onSkill={(value) => setFilters(withPeopleFilter(filters, 'skillId', value))}
      noSkills={filters.noSkills === true}
      onNoSkills={(next) => setFilters(withPeopleFilter(filters, 'noSkills', next ? 'true' : ''))}
      filtered={Object.keys(filters).length > 0}
      onClear={() => setFilters({})}
      searchPlaceholder="name"
    />
  )
}

describe('the filter URL', () => {
  it('is read on arrival and written back MERGED with the params it does not own', () => {
    // The real jsdom history puts the URL in place; the stub then records what the hook writes.
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/workforce?tab=slaves&specialty=qa')
    vi.stubGlobal('history', { replaceState })
    search = 'tab=slaves&specialty=qa'

    render(<Harness />)
    expect(screen.getByTestId('people-specialty-qa').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('people-no-skills'))
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce?tab=slaves&specialty=qa&skills=none')
    fireEvent.click(screen.getByTestId('people-clear-filters'))
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce?tab=slaves')
  })
})
```

Run: `npx vitest run apps/web/test/workforce-filter-bar.test.tsx`
Expected: FAIL -- `Failed to resolve import "../src/components/workforce/WorkforceFilterBar.js"`.

- [ ] **Step 2: Generalise the URL hook**

`apps/web/src/lib/catalogFilters.ts` -- add (the list moves here from the hook, unchanged plus Task 2's two):

```ts
/** The nine params the catalog owns in the address bar, and the only ones its hook clears before
 *  writing its own back -- a `?tab=catalog` or a `?from=nav` that arrived on the link survives. */
export const CATALOG_FILTER_PARAMS = [
  'q', 'division', 'capability', 'source', 'skill', 'active', 'duplicates', 'specialty', 'skills',
] as const
```

`apps/web/src/hooks/useUrlFilters.ts`:

```ts
'use client'

import { useCallback, useState } from 'react'
import { useSearchParams } from 'next/navigation'

/** One filter vocabulary as the address bar holds it: the params it OWNS -- the only ones it clears
 *  before writing its own back -- and the parse in both directions. Pass a MODULE constant: the
 *  hook's writer depends on it. */
export interface UrlFilterSpec<F> {
  readonly keys: readonly string[]
  readonly parse: (params: URLSearchParams) => F
  readonly toParams: (filters: F) => URLSearchParams
}

/**
 * Filters carried in the URL (M46 R6; generalised by workforce cards so the Catalog and People tabs
 * share one idiom and one bar).
 *
 * `window.history.replaceState`, NOT `router.replace` (M46 plan erratum E11): `/workforce` is
 * `force-dynamic` with a dozen loaders, one of which scans the skills directories on disk, and a
 * keystroke in a search box is a far worse thing to re-run them for than a tab click. The state that
 * renders is React state, seeded once from the URL; the URL write is a side effect so a reload or a
 * shared link restores the same view.
 *
 * MERGED into the current query, never a bare `?q=`: dropping `?tab=catalog` would send a shared
 * link to the People tab.
 */
export function useUrlFilters<F>(spec: UrlFilterSpec<F>): {
  readonly filters: F
  readonly setFilters: (next: F) => void
} {
  const searchParams = useSearchParams()
  const [filters, setFiltersState] = useState<F>(() => spec.parse(new URLSearchParams(searchParams.toString())))

  const setFilters = useCallback(
    (next: F): void => {
      setFiltersState(next)
      const query = new URLSearchParams(window.location.search)
      for (const key of spec.keys) query.delete(key)
      for (const [key, value] of spec.toParams(next)) query.set(key, value)
      const text = query.toString()
      window.history.replaceState(null, '', text === '' ? '/workforce' : `/workforce?${text}`)
    },
    [spec],
  )

  return { filters, setFilters }
}
```

`apps/web/src/hooks/useCatalogFilters.ts`:

```ts
'use client'

import type { WorkforceCatalogFilters } from '@slave-of-ai/control'
import { CATALOG_FILTER_PARAMS, catalogFilterParams, parseCatalogFilters } from '../lib/catalogFilters'
import { useUrlFilters, type UrlFilterSpec } from './useUrlFilters'

const CATALOG_URL: UrlFilterSpec<WorkforceCatalogFilters> = {
  keys: CATALOG_FILTER_PARAMS,
  parse: parseCatalogFilters,
  toParams: catalogFilterParams,
}

/** The catalog's nine filters, carried in the URL (M46 R6, widened by M55 R3 and workforce cards).
 *  Everything about HOW is `useUrlFilters`'. */
export function useCatalogFilters(): {
  readonly filters: WorkforceCatalogFilters
  readonly setFilters: (next: WorkforceCatalogFilters) => void
} {
  return useUrlFilters(CATALOG_URL)
}
```

`apps/web/src/hooks/usePeopleFilters.ts`:

```ts
'use client'

import { PEOPLE_FILTER_PARAMS, parsePeopleFilters, peopleFilterParams, type PeopleFilters } from '../lib/peopleFilters'
import { useUrlFilters, type UrlFilterSpec } from './useUrlFilters'

const PEOPLE_URL: UrlFilterSpec<PeopleFilters> = {
  keys: PEOPLE_FILTER_PARAMS,
  parse: parsePeopleFilters,
  toParams: peopleFilterParams,
}

/** People's filters, carried in the URL (workforce cards §1) -- the catalog's idiom, People's words. */
export function usePeopleFilters(): {
  readonly filters: PeopleFilters
  readonly setFilters: (next: PeopleFilters) => void
} {
  return useUrlFilters(PEOPLE_URL)
}
```

- [ ] **Step 3: Write the shared bar**

`apps/web/src/components/workforce/WorkforceFilterBar.tsx`:

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import type { CapabilityDomainFacet } from '@slave-of-ai/control'
import { domainLabel } from '@slave-of-ai/domain'
import { CATALOG_SEARCH_DEBOUNCE_MS } from '../../lib/catalogFilters'
import { Button } from '../ui/Button'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'

/** How many Specialty chips show before the rest fold behind `+N` (spec §1: "the first ~8"). */
export const SPECIALTY_CHIPS = 8

/** The two-state chip every filter chip on this page wears -- the catalog's source and activation
 *  chips, the Specialty chips and "No skills" -- so one pressed state looks like one thing. */
export const CHIP_BUTTON = 'rounded-bubble border px-[9px] py-[3px] font-mono text-[10px] font-medium transition-colors'

export function chipTone(pressed: boolean): string {
  return pressed ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
}

/**
 * The Workforce filter bar (workforce cards §1): ONE component for the Catalog and People tabs.
 *
 * It owns the controls both tabs share -- search, Specialty chips, Division, Skill, "No skills",
 * Clear -- and takes each tab's own controls as `children` (the catalog's source, activation,
 * capability and duplicates; People's segments and department). It owns no filter STATE: every
 * control reports one change and the caller folds it into its own filters and its own URL, which is
 * what keeps a catalog `skill` (a recommended-skill word) and a People `skillId` (a linked skill)
 * two different params on one bar.
 *
 * The search box keeps its own text and pushes it up after {@link CATALOG_SEARCH_DEBOUNCE_MS} (M55
 * R3), through a ref refreshed after every render -- so a chip clicked during the wait is not
 * reverted when the push lands carrying older filters (`gate:m46-workforce-catalog` stage 2c found
 * exactly that bug once).
 *
 * Specialty is single-select: a click chooses, a click on the pressed chip clears. A specialty that
 * is not among the chips shown -- folded behind `+N`, or unknown because a shared link outlived its
 * domain -- is still drawn, pressed, so the filter that is emptying the list can be seen and undone.
 */
export function WorkforceFilterBar({
  testIdPrefix,
  query,
  onQuery,
  domains,
  specialty,
  onSpecialty,
  divisions,
  division,
  onDivision,
  skillOptions,
  skill,
  onSkill,
  noSkills,
  onNoSkills,
  filtered,
  onClear,
  searchPlaceholder,
  children,
}: {
  readonly testIdPrefix: 'catalog' | 'people'
  readonly query: string
  readonly onQuery: (next: string) => void
  readonly domains: readonly CapabilityDomainFacet[]
  readonly specialty: string | undefined
  /** `''` clears. */
  readonly onSpecialty: (next: string) => void
  readonly divisions: readonly string[]
  readonly division: string | undefined
  readonly onDivision: (next: string) => void
  readonly skillOptions: readonly { readonly value: string; readonly label: string }[]
  readonly skill: string | undefined
  readonly onSkill: (next: string) => void
  readonly noSkills: boolean
  readonly onNoSkills: (next: boolean) => void
  readonly filtered: boolean
  readonly onClear: () => void
  readonly searchPlaceholder: string
  readonly children?: React.ReactNode
}): React.JSX.Element {
  const p = testIdPrefix
  const [text, setText] = useState(query)
  // Re-seeded when the query changes from OUTSIDE -- Clear filters, or a link opened with a `?q=`.
  useEffect(() => {
    setText(query)
  }, [query])
  const push = useRef(onQuery)
  useEffect(() => {
    push.current = onQuery
  })
  useEffect(() => {
    if (text === query) return
    const timer = setTimeout(() => push.current(text), CATALOG_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `query` is read to decide whether there is anything to push at all; re-arming the wait when
    // it changes would restart it on the very push that ended it (CatalogFilterBar's original rule).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? domains : domains.slice(0, SPECIALTY_CHIPS)
  const pinned: readonly CapabilityDomainFacet[] =
    specialty === undefined || shown.some((facet) => facet.domain === specialty)
      ? []
      : [domains.find((facet) => facet.domain === specialty) ?? { domain: specialty, count: 0 }]

  const specialtyChip = (facet: CapabilityDomainFacet): React.JSX.Element => {
    const pressed = specialty === facet.domain
    return (
      <button
        key={facet.domain}
        type="button"
        data-testid={`${p}-specialty-${facet.domain}`}
        data-count={String(facet.count)}
        aria-pressed={pressed}
        onClick={() => onSpecialty(pressed ? '' : facet.domain)}
        className={`${CHIP_BUTTON} ${chipTone(pressed)}`}
      >
        {domainLabel(facet.domain)}
        <span className="ml-1 text-text-3">{facet.count}</span>
      </button>
    )
  }

  const select = (
    key: 'division' | 'skill',
    label: string,
    value: string | undefined,
    options: readonly { readonly value: string; readonly label: string }[],
    onPick: (next: string) => void,
  ): React.JSX.Element => (
    <label className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <select
        data-testid={`${p}-${key}-select`}
        aria-label={label}
        value={value ?? ''}
        onChange={(event) => onPick(event.target.value)}
        className={`w-44 ${INPUT_SHELL}`}
      >
        <option value="">any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <div data-testid={`${p}-filters`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <FieldLabel>Search</FieldLabel>
          <input
            data-testid={`${p}-search`}
            aria-label={p === 'catalog' ? 'search the catalog' : 'search people'}
            value={text}
            placeholder={searchPlaceholder}
            onChange={(event) => setText(event.target.value)}
            className={`w-72 max-w-full ${INPUT_SHELL}`}
          />
        </label>
        {select('division', 'Division', division, divisions.map((one) => ({ value: one, label: one })), onDivision)}
        {select('skill', 'Skill', skill, skillOptions, onSkill)}
        <div className="flex items-center pb-1">
          <button
            type="button"
            data-testid={`${p}-no-skills`}
            aria-pressed={noSkills}
            onClick={() => onNoSkills(!noSkills)}
            className={`${CHIP_BUTTON} ${chipTone(noSkills)}`}
          >
            No skills
          </button>
        </div>
        {children}
        {filtered && (
          <Button variant="ghost" size="sm" data-testid={`${p}-clear-filters`} onClick={onClear}>
            Clear filters
          </Button>
        )}
      </div>
      {(shown.length > 0 || pinned.length > 0) && (
        <div data-testid={`${p}-specialties`} role="group" aria-label="Specialty" className="flex flex-wrap items-center gap-1">
          {shown.map(specialtyChip)}
          {pinned.map(specialtyChip)}
          {domains.length > SPECIALTY_CHIPS && (
            <button
              type="button"
              data-testid={`${p}-specialty-more`}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              className="text-[10px] text-text-3 hover:text-text-2"
            >
              {expanded ? 'fewer' : `+${String(domains.length - SPECIALTY_CHIPS)}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Make `CatalogFilterBar` a wrapper that keeps every catalog testid**

Replace the whole of `apps/web/src/components/workforce/CatalogFilterBar.tsx` with the following, keeping the existing "ONE vocabulary" docblock above `SOURCE_LABEL` exactly where it is:

```tsx
'use client'

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
  CATALOG_SOURCES,
  type CatalogActivation,
  type CatalogSource,
} from '../../lib/catalogFilters'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'
import { CHIP_BUTTON, WorkforceFilterBar, chipTone } from './WorkforceFilterBar'

const SOURCE_LABEL: Record<CatalogSource, string> = {
  imported: 'imported',
  local: 'local',
}

type FilterKey =
  | 'q'
  | 'division'
  | 'capability'
  | 'source'
  | 'skill'
  | 'active'
  | 'duplicates'
  | 'specialty'
  | 'noSkills'

const asSource = (value: string): CatalogSource | undefined => CATALOG_SOURCES.find((member) => member === value)
const asFacet = (value: string): DuplicateFacet | undefined => DUPLICATE_FACETS.find((member) => member === value)

/**
 * One filter changed, the other eight carried through -- and `''` means "drop this one". Written
 * out key by key instead of a computed-key spread: under `exactOptionalPropertyTypes` an optional
 * key that is PRESENT and `undefined` is a different type from an absent one.
 */
function withFilter(filters: WorkforceCatalogFilters, key: FilterKey, value: string): WorkforceCatalogFilters {
  const q = key === 'q' ? value : filters.q
  const division = key === 'division' ? value : filters.division
  const capability = key === 'capability' ? value : filters.capability
  const source = key === 'source' ? asSource(value) : filters.source
  const skill = key === 'skill' ? value : filters.skill
  const active = key === 'active' ? (value === '' ? undefined : value === 'active') : filters.active
  const duplicates = key === 'duplicates' ? asFacet(value) : filters.duplicates
  const specialty = key === 'specialty' ? value : filters.specialty
  const noSkills = key === 'noSkills' ? value === 'true' : filters.noSkills
  return {
    ...(q !== undefined && q !== '' ? { q } : {}),
    ...(division !== undefined && division !== '' ? { division } : {}),
    ...(capability !== undefined && capability !== '' ? { capability } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(skill !== undefined && skill !== '' ? { skill } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(duplicates !== undefined ? { duplicates } : {}),
    ...(specialty !== undefined && specialty !== '' ? { specialty } : {}),
    ...(noSkills === true ? { noSkills } : {}),
  }
}

/**
 * The catalog's filter row (M46 R6, nine controls since workforce cards): the shared
 * {@link WorkforceFilterBar} plus the four controls only a persona list has -- source, activation,
 * capability and duplicates. Every testid a gate drives (`catalog-search`, `catalog-*-select`,
 * `catalog-source-chip-*`, `catalog-active-chip-*`, `catalog-clear-filters`) is unchanged.
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
   *  word. Defaults to empty, where every key prints as itself. */
  readonly taxonomy?: readonly CapabilityRecord[]
  readonly onChange: (next: WorkforceCatalogFilters) => void
}): React.JSX.Element {
  const set = (key: FilterKey, value: string): void => onChange(withFilter(filters, key, value))

  return (
    <WorkforceFilterBar
      testIdPrefix="catalog"
      query={filters.q ?? ''}
      onQuery={(value) => set('q', value)}
      domains={facets.domains}
      specialty={filters.specialty}
      onSpecialty={(value) => set('specialty', value)}
      divisions={facets.divisions}
      division={filters.division}
      onDivision={(value) => set('division', value)}
      skillOptions={facets.skills.map((one) => ({ value: one, label: one }))}
      skill={filters.skill}
      onSkill={(value) => set('skill', value)}
      noSkills={filters.noSkills === true}
      onNoSkills={(next) => set('noSkills', next ? 'true' : '')}
      filtered={Object.keys(filters).length > 0}
      onClear={() => onChange({})}
      searchPlaceholder="name, summary, capability, skill"
    >
      <div className="flex items-center gap-1 pb-1">
        {CATALOG_SOURCES.map((source) => (
          <button
            key={source}
            type="button"
            data-testid={`catalog-source-chip-${source}`}
            data-source={source}
            aria-pressed={filters.source === source}
            onClick={() => set('source', filters.source === source ? '' : source)}
            className={`${CHIP_BUTTON} ${chipTone(filters.source === source)}`}
          >
            {SOURCE_LABEL[source]}
          </button>
        ))}
      </div>
      {/* M55 R6: clicking the pressed activation chip clears it -- "either" is a real third state. */}
      <div className="flex items-center gap-1 pb-1">
        {CATALOG_ACTIVATIONS.map((activation: CatalogActivation) => {
          const pressed = filters.active === (activation === 'active')
          return (
            <button
              key={activation}
              type="button"
              data-testid={`catalog-active-chip-${activation}`}
              data-activation={activation}
              aria-pressed={pressed}
              onClick={() => set('active', pressed ? '' : activation)}
              className={`${CHIP_BUTTON} ${chipTone(pressed)}`}
            >
              {ACTIVATION_LABEL[activation]}
            </button>
          )
        })}
      </div>
      {/* M55 R3: the OPTIONS are taxonomy keys and the TEXT is their labels (`docs/ia.md` rule 3). */}
      <label className="flex flex-col gap-1">
        <FieldLabel>Capability</FieldLabel>
        <select
          data-testid="catalog-capability-select"
          aria-label="Capability"
          value={filters.capability ?? ''}
          onChange={(event) => set('capability', event.target.value)}
          className={`w-44 ${INPUT_SHELL}`}
        >
          <option value="">any</option>
          {facets.capabilities.map((key) => (
            <option key={key} value={key}>
              {capabilityLabel(key, taxonomy)}
            </option>
          ))}
        </select>
      </label>
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
    </WorkforceFilterBar>
  )
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run apps/web/test/workforce-filter-bar.test.tsx apps/web/test/workforce-catalog.test.tsx apps/web/test/catalog-duplicates.test.tsx apps/web/test/catalog-filters.test.ts`
Expected: PASS -- the new file (8 tests) and every existing catalog case, including the search-debounce and "a chip clicked during the wait is not reverted" ones.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/hooks/useUrlFilters.ts apps/web/src/hooks/usePeopleFilters.ts apps/web/src/hooks/useCatalogFilters.ts \
  apps/web/src/lib/catalogFilters.ts apps/web/src/components/workforce/WorkforceFilterBar.tsx \
  apps/web/src/components/workforce/CatalogFilterBar.tsx apps/web/test/workforce-filter-bar.test.tsx
git commit -m "feat(workforce): one filter bar for both tabs, with specialty chips and no-skills" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: `SkillPicker` -- grouped by provider, scope on person cards, process-skill confirm, missing skills disabled

**Files:**
- Create: `apps/web/src/components/workforce/SkillPicker.tsx`
- Test: `apps/web/test/skill-picker.test.tsx`

**Interfaces:**
- Consumes: `SkillCatalogueRow` (Task 3); `skillGlyphOf`, `skillGroupOf`, `skillSourceTitle`, `SkillGroup` (Task 1); `isProcessSkill`, `PROCESS_SKILL_WARNING` (Task 1); `SkillScope` (Task 4); `ui/Segmented`, `ui/Alert`, `ui/Button`, `ui/FormControls`.
- Produces: `SkillPicker(props: { readonly catalogue: readonly SkillCatalogueRow[]; readonly linked: ReadonlySet<string>; readonly scope: null | { readonly personaName: string | null }; readonly pending?: boolean; readonly onConfirm: (skillId: string, scope: SkillScope) => void; readonly onCancel: () => void }): React.JSX.Element`; testids `skill-picker`, `skill-picker-scope` (+ `-person`/`-persona`), `skill-picker-scope-none`, `skill-picker-search`, `skill-picker-group-<providerName>`, `skill-picker-option-<skillId>` (`data-linked`, `data-missing`, `aria-pressed`, `disabled`), `skill-picker-empty`, `skill-picker-process-warning`, `skill-picker-process-confirm`, `skill-picker-confirm`, `skill-picker-cancel`.

**Why in-card and not a `Dialog`/`Sheet` (spec §3 allows "a popover or Dialog"):** the Catalog also renders inside the simple-mode `hire-sheet` (`Sheet`, `z-40`, a transformed panel), `Dialog` is `z-20` and nothing in `ui/` portals -- a modal picker opened from a card inside that sheet would draw UNDER it, and a nested `Sheet` would be positioned against the transformed panel. The picker is therefore an in-flow panel inside the card, which is a popover on a wide screen and effectively a bottom sheet on a phone (the card is full width there).

- [ ] **Step 1: Write the failing test**

`apps/web/test/skill-picker.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SkillPicker } from '../src/components/workforce/SkillPicker.js'
import type { SkillCatalogueRow } from '../src/server/persons.js'

const row = (skillId: string, name: string, providerName: string, over: Partial<SkillCatalogueRow> = {}): SkillCatalogueRow => ({
  skillId,
  name,
  providerName,
  description: `${name} helps`,
  missing: false,
  ...over,
})

const CATALOGUE: readonly SkillCatalogueRow[] = [
  row('s-plan', 'writing-plans', 'plugin:superpowers'),
  row('s-sql', 'sql', 'personal', { description: 'writes database queries' }),
  row('s-pdf', 'pdf', 'personal'),
  row('s-lint', 'lint', 'project'),
  row('s-gone', 'archived', 'personal', { missing: true }),
]

const groupIds = (): string[] =>
  screen.getAllByTestId(/^skill-picker-group-/u).map((node) => node.getAttribute('data-testid') ?? '')

describe('SkillPicker', () => {
  it('groups Your skills, then Project, then each plugin, names sorted inside', () => {
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(groupIds()).toEqual(['skill-picker-group-personal', 'skill-picker-group-project', 'skill-picker-group-plugin:superpowers'])
    expect(screen.getByTestId('skill-picker-group-plugin:superpowers').textContent).toContain('🔌 superpowers')
    const personal = within(screen.getByTestId('skill-picker-group-personal')).getAllByTestId(/^skill-picker-option-/u)
    expect(personal.map((node) => node.getAttribute('data-testid'))).toEqual([
      'skill-picker-option-s-gone',
      'skill-picker-option-s-pdf',
      'skill-picker-option-s-sql',
    ])
  })

  it('searches the name and the description', () => {
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByTestId('skill-picker-search'), { target: { value: 'database' } })
    expect(screen.getAllByTestId(/^skill-picker-option-/u).map((node) => node.getAttribute('data-testid'))).toEqual([
      'skill-picker-option-s-sql',
    ])
    fireEvent.change(screen.getByTestId('skill-picker-search'), { target: { value: 'nothing like it' } })
    expect(screen.getByTestId('skill-picker-empty')).toBeTruthy()
  })

  it('shows a linked skill checked and disabled, and a missing one disabled', () => {
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set(['s-pdf'])} scope={null} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const linked = screen.getByTestId('skill-picker-option-s-pdf')
    expect(linked.getAttribute('data-linked')).toBe('true')
    expect(linked.textContent).toContain('✓')
    expect((linked as HTMLButtonElement).disabled).toBe(true)
    const missing = screen.getByTestId('skill-picker-option-s-gone')
    expect(missing.getAttribute('data-missing')).toBe('true')
    expect((missing as HTMLButtonElement).disabled).toBe(true)
  })

  it('on a persona card there is no scope to choose, and the skill goes to the persona', () => {
    const onConfirm = vi.fn()
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={onConfirm} onCancel={vi.fn()} />)
    expect(screen.queryByTestId('skill-picker-scope')).toBeNull()
    fireEvent.click(screen.getByTestId('skill-picker-option-s-sql'))
    fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    expect(onConfirm).toHaveBeenCalledWith('s-sql', 'persona')
  })

  it('on a person card the scope is asked, "only this person" by default', () => {
    const onConfirm = vi.fn()
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={{ personaName: 'Builder' }} onConfirm={onConfirm} onCancel={vi.fn()} />)
    expect(screen.getByTestId('skill-picker-scope').getAttribute('data-value')).toBe('person')
    expect(screen.getByTestId('skill-picker-scope-persona').textContent).toBe('Everyone from Builder')
    fireEvent.click(screen.getByTestId('skill-picker-option-s-sql'))
    fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    expect(onConfirm).toHaveBeenLastCalledWith('s-sql', 'person')
    fireEvent.click(screen.getByTestId('skill-picker-scope-persona'))
    fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    expect(onConfirm).toHaveBeenLastCalledWith('s-sql', 'persona')
  })

  it('says so when the person was hired from no persona', () => {
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={{ personaName: null }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByTestId('skill-picker-scope')).toBeNull()
    expect(screen.getByTestId('skill-picker-scope-none')).toBeTruthy()
  })

  it('a process skill needs an explicit confirm', () => {
    const onConfirm = vi.fn()
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('skill-picker-option-s-plan'))
    expect(screen.getByTestId('skill-picker-process-warning').textContent).toBe(
      'Process skill: can make a worker plan and delegate instead of doing its task.',
    )
    const confirm = screen.getByTestId('skill-picker-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('skill-picker-process-confirm'))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith('s-plan', 'persona')
  })

  it('Cancel and Escape both close it', () => {
    const onCancel = vi.fn()
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('skill-picker-cancel'))
    fireEvent.keyDown(screen.getByTestId('skill-picker-search'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
```

Run: `npx vitest run apps/web/test/skill-picker.test.tsx`
Expected: FAIL -- `Failed to resolve import "../src/components/workforce/SkillPicker.js"`.

- [ ] **Step 2: Implement the picker**

`apps/web/src/components/workforce/SkillPicker.tsx`:

```tsx
'use client'

import { useMemo, useState } from 'react'
import { PROCESS_SKILL_WARNING, isProcessSkill } from '@slave-of-ai/domain'
import type { SkillCatalogueRow } from '../../server/persons'
import { skillGlyphOf, skillGroupOf, skillSourceTitle, type SkillGroup } from '../../lib/skillSource'
import type { SkillScope } from '../../lib/skillWrites'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'
import { Segmented } from '../ui/Segmented'

/**
 * Add one skill to a card (workforce cards §3).
 *
 * Grouped by PROVIDER -- "Your skills", "Project", then one group per plugin -- because a plugin is
 * a skill source and not a concept of its own (decision 5): its skills are linked one by one like
 * any other, and the group heading is the only place the plugin is named as a whole.
 *
 * On a PERSON card the scope is asked first and defaults to "Only this person"; "Everyone from
 * <persona>" writes the persona instead, which reaches every person hired from it at once. A
 * person made from nothing has no persona to write, and the picker says so rather than offering a
 * choice that would silently do the same thing as the other.
 *
 * A PROCESS skill (§4) needs an explicit confirm: it is allowed, and the operator decides, but
 * never by a single click that did not show them the sentence. A MISSING skill is listed, greyed,
 * and cannot be chosen -- the route would refuse it (`skill_missing`) and a control that is known to
 * fail is worse than one that is plainly off.
 */
export function SkillPicker({
  catalogue,
  linked,
  scope: scoping,
  pending = false,
  onConfirm,
  onCancel,
}: {
  readonly catalogue: readonly SkillCatalogueRow[]
  /** Skills the card already holds -- shown checked and not offered again. */
  readonly linked: ReadonlySet<string>
  /** `null` on a persona card (the skill always goes to the persona). On a person card, the
   *  persona they were hired from, whose name the second scope option carries -- or null. */
  readonly scope: null | { readonly personaName: string | null }
  readonly pending?: boolean
  readonly onConfirm: (skillId: string, scope: SkillScope) => void
  readonly onCancel: () => void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [scope, setScope] = useState<SkillScope>('person')
  const [processConfirmed, setProcessConfirmed] = useState(false)

  const groups = useMemo((): readonly { readonly group: SkillGroup; readonly rows: readonly SkillCatalogueRow[] }[] => {
    const needle = search.trim().toLowerCase()
    const byKey = new Map<string, { group: SkillGroup; rows: SkillCatalogueRow[] }>()
    for (const row of catalogue) {
      if (needle !== '' && !row.name.toLowerCase().includes(needle) && !row.description.toLowerCase().includes(needle)) continue
      const group = skillGroupOf(row.providerName)
      const entry = byKey.get(group.key)
      if (entry === undefined) byKey.set(group.key, { group, rows: [row] })
      else entry.rows.push(row)
    }
    return [...byKey.values()]
      .toSorted((a, b) => a.group.order - b.group.order || a.group.label.localeCompare(b.group.label))
      .map((entry) => ({ group: entry.group, rows: entry.rows.toSorted((a, b) => a.name.localeCompare(b.name)) }))
  }, [catalogue, search])

  const chosen = catalogue.find((row) => row.skillId === selected) ?? null
  const chosenIsProcess = chosen !== null && isProcessSkill(chosen)
  const canConfirm = chosen !== null && !pending && (!chosenIsProcess || processConfirmed)
  const scopeOptions: readonly { readonly id: SkillScope; readonly label: string }[] = [
    { id: 'person', label: 'Only this person' },
    { id: 'persona', label: `Everyone from ${scoping?.personaName ?? ''}` },
  ]

  return (
    <div
      data-testid="skill-picker"
      role="group"
      aria-label="Add a skill"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
      className="flex flex-col gap-2 rounded-card border border-line bg-bg-1 p-2"
    >
      {scoping !== null &&
        (scoping.personaName === null ? (
          <p data-testid="skill-picker-scope-none" className="text-xs text-text-3">
            Only this person — they were not hired from a persona.
          </p>
        ) : (
          <Segmented options={scopeOptions} value={scope} onChange={setScope} ariaLabel="Who gets it" testIdPrefix="skill-picker-scope" />
        ))}
      <label className="flex flex-col gap-1">
        <FieldLabel>Find a skill</FieldLabel>
        <input
          data-testid="skill-picker-search"
          aria-label="find a skill"
          value={search}
          placeholder="name or description"
          onChange={(event) => setSearch(event.target.value)}
          className={`w-full ${INPUT_SHELL}`}
        />
      </label>
      <div data-testid="skill-picker-list" className="flex max-h-64 flex-col gap-2 overflow-y-auto">
        {groups.length === 0 && (
          <p data-testid="skill-picker-empty" className="text-xs text-text-3">
            no skill matches
          </p>
        )}
        {groups.map(({ group, rows }) => (
          <div key={group.key} data-testid={`skill-picker-group-${group.key}`} className="flex flex-col gap-0.5">
            <span className="text-[10.5px] uppercase tracking-wide text-text-3">{group.label}</span>
            {rows.map((row) => {
              const isLinked = linked.has(row.skillId)
              return (
                <button
                  key={row.skillId}
                  type="button"
                  data-testid={`skill-picker-option-${row.skillId}`}
                  data-linked={String(isLinked)}
                  data-missing={String(row.missing)}
                  aria-pressed={selected === row.skillId}
                  disabled={isLinked || row.missing}
                  title={
                    row.missing
                      ? 'missing from disk — it cannot be linked until a skills scan finds it again'
                      : skillSourceTitle(row.providerName)
                  }
                  onClick={() => {
                    setSelected(row.skillId)
                    setProcessConfirmed(false)
                  }}
                  className={`flex min-w-0 items-start gap-1.5 rounded-nav px-1.5 py-1 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected === row.skillId ? 'bg-sel text-text-1' : 'text-text-2 hover:bg-bg-2'
                  }`}
                >
                  <span aria-hidden="true" className="w-3 shrink-0">
                    {isLinked ? '✓' : ''}
                  </span>
                  <span aria-hidden="true">{skillGlyphOf(row.providerName)}</span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono">
                      {row.name}
                      {isProcessSkill(row) ? ' ⚠️' : ''}
                      {row.missing ? ' · missing' : ''}
                    </span>
                    {row.description !== '' && <span className="truncate text-[10.5px] text-text-3">{row.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
      {chosenIsProcess && (
        <div className="flex flex-col gap-1">
          <Alert variant="notice" testId="skill-picker-process-warning">
            {PROCESS_SKILL_WARNING}
          </Alert>
          <label className="flex items-center gap-1.5 text-xs text-text-2">
            <input
              type="checkbox"
              data-testid="skill-picker-process-confirm"
              checked={processConfirmed}
              onChange={(event) => setProcessConfirmed(event.target.checked)}
            />
            Add it anyway
          </label>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" data-testid="skill-picker-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          data-testid="skill-picker-confirm"
          disabled={!canConfirm}
          onClick={() => {
            if (chosen !== null) onConfirm(chosen.skillId, scoping === null ? 'persona' : scope)
          }}
        >
          Add
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Run it**

Run: `npx vitest run apps/web/test/skill-picker.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/workforce/SkillPicker.tsx apps/web/test/skill-picker.test.tsx
git commit -m "feat(workforce): skill picker grouped by provider, with scope and process-skill confirm" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: `WorkforceCard` -- persona and person variants, chips with source/origin/process marks, workflow preview, "+ skill"

**Files:**
- Create: `apps/web/src/components/workforce/WorkforceCard.tsx`
- Test: `apps/web/test/workforce-card.test.tsx`

**Interfaces:**
- Consumes: `CardSkillRow`, `byCardOrder` (Task 2 -- `lib/cardSkills.ts` is pure and imports only `@slave-of-ai/domain`, which is why it lives in `lib/` beside `catalogFilters.ts`: both the server reads and this client component import it); `SkillCatalogueRow` (Task 3, type only); `SkillTarget`, `SkillScope`, `SkillWrite`, `addSkillWrite`, `removeSkillWrite`, `restoreSkillWrite` (Task 4); `SkillPicker` (Task 6); `skillGlyphOf`, `skillSourceTitle` (Task 1); `isProcessSkill`, `skillSourceOf`, `PROCESS_SKILL_WARNING`, `capabilityLabel`, `WorkflowPreview`, `CapabilityRecord` (domain); `sendControl` (`lib/postControl.ts`); `plural` (`lib/plural.ts`); `ui/Card`, `ui/AvatarTile`, `ui/Chip`, `ui/Alert`, `ui/Button`, `StatusTone`.
- Produces:
  - `CARD_GRID_COLUMNS = 'repeat(auto-fill, minmax(320px, 1fr))'`, `CARD_SPECIALTIES = 3`, `CARD_SKILLS = 6`
  - `WorkforceCardGrid(props: { readonly children: React.ReactNode }): React.JSX.Element` -- testid `workforce-card-grid`, the grid template as an INLINE style (gates read it back)
  - `WorkforceCard(props: { variant: 'persona' | 'person'; testId: string; data?: Readonly<Record<\`data-${string}\`, string>>; dimmed?: boolean; tone: StatusTone; name: string; subtitle?: string | null; summary?: string; division: string | null; divisionTitle?: string; capabilityKeys: readonly string[]; capabilityText?: readonly string[]; taxonomy: readonly CapabilityRecord[]; skills: readonly CardSkillRow[]; workflow: WorkflowPreview; target: SkillTarget; catalogue: readonly SkillCatalogueRow[]; openTestId: string; onOpen: () => void; onChanged: () => void; header?: React.ReactNode; footer?: React.ReactNode }): React.JSX.Element`
  - testids: the wrapper carries the caller's `testId` (`catalog-row-<id>` / `person-row-<id>`) and `data`; inside: `workforce-card` (`data-variant`), the caller's `openTestId` on the name button, `card-division`, `<catalog|person>-capability-chip`, `<catalog|person>-capability-more`, `card-skills`, `card-skills-empty`, `card-skill-<skillId>` (`data-source`, `data-origin`, `data-process`, `data-missing`), `card-skill-glyph`, `card-skill-name`, `card-skill-process`, `card-skill-origin`, `card-skill-remove-<skillId>`, `card-skill-restore-<skillId>`, `card-skills-more`, `card-skill-add`, `card-skill-remove-scope` (+ `-person`/`-persona`/`-cancel`), `card-skill-error`, `card-workflow`, `card-workflow-step`, `card-workflow-more`, `card-workflow-empty`

- [ ] **Step 1: Write the failing test**

`apps/web/test/workforce-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityRecord } from '@slave-of-ai/domain'
import { CARD_GRID_COLUMNS, WorkforceCard, WorkforceCardGrid } from '../src/components/workforce/WorkforceCard.js'
import type { CardSkillRow } from '../src/lib/cardSkills.js'
import type { SkillCatalogueRow } from '../src/server/persons.js'
import type { SkillTarget } from '../src/lib/skillWrites.js'

const chip = (skillId: string, name: string, over: Partial<CardSkillRow> = {}): CardSkillRow => ({
  skillId,
  name,
  providerName: 'personal',
  missing: false,
  process: false,
  state: 'persona',
  ...over,
})

const CATALOGUE: readonly SkillCatalogueRow[] = [
  { skillId: 's-sql', name: 'sql', providerName: 'personal', description: 'writes sql', missing: false },
  { skillId: 's-pdf', name: 'pdf', providerName: 'personal', description: 'makes pdfs', missing: false },
]

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'frontend.styling', label: 'Styling', domain: 'frontend', role: 'frontend', synonyms: [] },
]

const PERSONA: SkillTarget = { kind: 'persona', templateId: 't1' }
const PERSON: SkillTarget = { kind: 'person', personId: 'p1', personaId: 't1', personaName: 'Builder' }

type CardProps = React.ComponentProps<typeof WorkforceCard>

function renderCard(over: Partial<CardProps> = {}): CardProps {
  const props: CardProps = {
    variant: 'persona',
    testId: 'catalog-row-t1',
    tone: 'idle',
    name: 'Core Builder',
    division: 'engineering',
    capabilityKeys: [],
    taxonomy: TAXONOMY,
    skills: [],
    workflow: { steps: [], total: 0 },
    target: PERSONA,
    catalogue: CATALOGUE,
    openTestId: 'catalog-open-t1',
    onOpen: vi.fn(),
    onChanged: vi.fn(),
    ...over,
  }
  render(<WorkforceCard {...props} />)
  return props
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkforceCard chips', () => {
  it('marks a local skill 🧩 and a plugin skill 🔌, naming the plugin in the tooltip', () => {
    renderCard({ skills: [chip('a', 'pdf'), chip('b', 'frontend-design', { providerName: 'plugin:frontend' })] })
    const plugin = screen.getByTestId('card-skill-b')
    expect(plugin.getAttribute('data-source')).toBe('plugin')
    expect(within(plugin).getByTestId('card-skill-glyph').textContent).toBe('🔌')
    expect(within(plugin).getByTestId('card-skill-glyph').getAttribute('title')).toBe('from the frontend plugin')
    expect(within(screen.getByTestId('card-skill-a')).getByTestId('card-skill-glyph').textContent).toBe('🧩')
  })

  it('on a person card, says where each skill came from and strikes a revoked one with a restore', () => {
    renderCard({
      variant: 'person',
      testId: 'person-row-p1',
      target: PERSON,
      openTestId: 'person-open',
      skills: [chip('a', 'pdf'), chip('b', 'sql', { state: 'person' }), chip('c', 'lint', { state: 'revoked' })],
    })
    expect(within(screen.getByTestId('card-skill-a')).getByTestId('card-skill-origin').textContent).toBe('from persona')
    expect(within(screen.getByTestId('card-skill-b')).getByTestId('card-skill-origin').textContent).toBe('this person only')
    const revoked = screen.getByTestId('card-skill-c')
    expect(revoked.getAttribute('data-origin')).toBe('revoked')
    expect(within(revoked).getByTestId('card-skill-name').className).toContain('line-through')
    expect(screen.getByTestId('card-skill-restore-c')).toBeTruthy()
  })

  it('never marks the origin on a persona card -- every chip there is the persona\'s', () => {
    renderCard({ skills: [chip('a', 'pdf')] })
    expect(screen.queryByTestId('card-skill-origin')).toBeNull()
  })

  it('flags a process skill ⚠️ with the sentence in its tooltip', () => {
    renderCard({ skills: [chip('a', 'writing-plans', { process: true })] })
    const mark = within(screen.getByTestId('card-skill-a')).getByTestId('card-skill-process')
    expect(mark.textContent).toBe('⚠️')
    expect(mark.getAttribute('title')).toBe('Process skill: can make a worker plan and delegate instead of doing its task.')
  })

  it('greys a skill missing from disk but still lets it be removed', () => {
    renderCard({ skills: [chip('a', 'archived', { missing: true })] })
    const missing = screen.getByTestId('card-skill-a')
    expect(missing.getAttribute('data-missing')).toBe('true')
    expect(missing.getAttribute('title')).toBe('archived — missing from disk')
    expect((screen.getByTestId('card-skill-remove-a') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows six skills and a +N, three specialties and a +N', () => {
    renderCard({
      skills: Array.from({ length: 8 }, (_, index) => chip(`s${String(index)}`, `skill-${String(index)}`)),
      capabilityKeys: [],
      capabilityText: ['One', 'Two', 'Three', 'Four', 'Five'],
    })
    expect(screen.getAllByTestId(/^card-skill-s\d$/u)).toHaveLength(6)
    expect(screen.getByTestId('card-skills-more').textContent).toBe('+2')
    expect(screen.getAllByTestId('catalog-capability-chip').map((node) => node.textContent)).toEqual(['One', 'Two', 'Three'])
    expect(screen.getByTestId('catalog-capability-more').textContent).toBe('+2')
  })

  it('labels taxonomy keys, and falls back to the key itself', () => {
    renderCard({ capabilityKeys: ['frontend.styling', 'qa.unknown'] })
    expect(screen.getAllByTestId('catalog-capability-chip').map((node) => node.textContent)).toEqual(['Styling', 'qa.unknown'])
  })

  it('truncates a very long skill name inside the chip instead of widening the card', () => {
    renderCard({ skills: [chip('a', `a-${'very-long-skill-name-'.repeat(8)}`, { providerName: `plugin:${'x'.repeat(80)}` })] })
    expect(screen.getByTestId('card-skill-a').className).toContain('max-w-full')
    expect(screen.getByTestId('card-skill-a').className).toContain('min-w-0')
    expect(within(screen.getByTestId('card-skill-a')).getByTestId('card-skill-name').className).toContain('truncate')
  })
})

describe('WorkforceCard workflow', () => {
  it('shows the first three steps and "+N steps"', () => {
    renderCard({ workflow: { steps: ['Read', 'Plan', 'Build'], total: 5 } })
    expect(screen.getAllByTestId('card-workflow-step').map((node) => node.textContent)).toEqual(['1. Read', '2. Plan', '3. Build'])
    expect(screen.getByTestId('card-workflow-more').textContent).toBe('+2 steps')
  })

  it('says so when the profile has no workflow, rather than hiding the block', () => {
    renderCard({ workflow: { steps: [], total: 0 } })
    expect(screen.getByTestId('card-workflow-empty').textContent).toBe('No workflow in this profile')
    expect(screen.queryByTestId('card-workflow-more')).toBeNull()
  })

  it('draws no "+N" when every step is shown', () => {
    renderCard({ workflow: { steps: ['Only'], total: 1 } })
    expect(screen.queryByTestId('card-workflow-more')).toBeNull()
  })
})

describe('WorkforceCard opening', () => {
  it('a click on the body opens it; the name button opens it once; a chip control does not open it', () => {
    const props = renderCard({ skills: [chip('a', 'pdf')] })
    fireEvent.click(screen.getByTestId('avatar-tile'))
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('catalog-open-t1'))
    expect(props.onOpen).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('card-skill-add'))
    expect(props.onOpen).toHaveBeenCalledTimes(2)
  })
})

describe('WorkforceCard writes', () => {
  it('adds from the picker as a persona DELTA, shows the chip at once, and refetches', async () => {
    const props = renderCard()
    fireEvent.click(screen.getByTestId('card-skill-add'))
    fireEvent.click(screen.getByTestId('skill-picker-option-s-sql'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/templates/t1/skills', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: ['s-sql'] }),
    })
    expect(screen.getByTestId('card-skill-s-sql')).toBeTruthy()
    expect(props.onChanged).toHaveBeenCalled()
  })

  it('rolls the chip back and says why when the write is refused', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'the skill sql is missing from disk; it can be linked again once a skills scan finds it' }), {
        status: 409,
      }),
    )
    const props = renderCard()
    fireEvent.click(screen.getByTestId('card-skill-add'))
    fireEvent.click(screen.getByTestId('skill-picker-option-s-sql'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    })
    expect(screen.queryByTestId('card-skill-s-sql')).toBeNull()
    expect(screen.getByTestId('card-skill-error').textContent).toContain('missing from disk')
    // A refusal is also a reason to re-read: another edit may have raced this one.
    expect(props.onChanged).toHaveBeenCalled()
  })

  it('on a person card, removing an inherited skill asks who loses it', async () => {
    renderCard({ variant: 'person', testId: 'person-row-p1', target: PERSON, openTestId: 'person-open', skills: [chip('a', 'pdf')] })
    fireEvent.click(screen.getByTestId('card-skill-remove-a'))
    expect(screen.getByTestId('card-skill-remove-scope-persona').textContent).toBe('Everyone from Builder')
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-skill-remove-scope-persona'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/templates/t1/skills', expect.objectContaining({ body: JSON.stringify({ remove: ['a'] }) }))
  })

  it("on a person card, removing the person's own grant clears it without asking", async () => {
    renderCard({
      variant: 'person',
      testId: 'person-row-p1',
      target: PERSON,
      openTestId: 'person-open',
      skills: [chip('b', 'sql', { state: 'person' })],
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-skill-remove-b'))
    })
    expect(screen.queryByTestId('card-skill-remove-scope')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/persons/p1/skills', expect.objectContaining({ body: JSON.stringify({ clear: ['b'] }) }))
  })
})

describe('WorkforceCardGrid', () => {
  it('lays cards out on the auto-fill grid, as an inline style a gate can read back', () => {
    render(
      <WorkforceCardGrid>
        <span />
      </WorkforceCardGrid>,
    )
    expect(CARD_GRID_COLUMNS).toBe('repeat(auto-fill, minmax(320px, 1fr))')
    expect(screen.getByTestId('workforce-card-grid').style.gridTemplateColumns).toBe(CARD_GRID_COLUMNS)
  })
})
```

Run: `npx vitest run apps/web/test/workforce-card.test.tsx`
Expected: FAIL -- `Failed to resolve import "../src/components/workforce/WorkforceCard.js"`.

- [ ] **Step 2: Implement the card**

`apps/web/src/components/workforce/WorkforceCard.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import {
  PROCESS_SKILL_WARNING,
  capabilityLabel,
  isProcessSkill,
  skillSourceOf,
  type CapabilityRecord,
  type WorkflowPreview,
} from '@slave-of-ai/domain'
import { byCardOrder, type CardSkillRow } from '../../lib/cardSkills'
import type { SkillCatalogueRow } from '../../server/persons'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import { skillGlyphOf, skillSourceTitle } from '../../lib/skillSource'
import {
  addSkillWrite,
  removeSkillWrite,
  restoreSkillWrite,
  type SkillScope,
  type SkillTarget,
  type SkillWrite,
} from '../../lib/skillWrites'
import { Alert } from '../ui/Alert'
import { AvatarTile } from '../ui/AvatarTile'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Chip } from '../ui/Chip'
import type { StatusTone } from '../ui/StatusPill'
import { SkillPicker } from './SkillPicker'

/** The card grid (spec §2). An INLINE style rather than a Tailwind class, so `gate:m14-fidelity` can
 *  read the authored template back off `style.gridTemplateColumns` the way it read the table's. */
export const CARD_GRID_COLUMNS = 'repeat(auto-fill, minmax(320px, 1fr))'

/** How many specialty chips a card shows before `+N` -- the catalog row's own number. */
export const CARD_SPECIALTIES = 3

/** How many skill chips a card shows before `+N` (spec §2); the full list is in the drawer. */
export const CARD_SKILLS = 6

const ORIGIN_LABEL: Record<CardSkillRow['state'], string> = {
  persona: 'from persona',
  person: 'this person only',
  revoked: 'revoked',
}

const stop = (event: React.SyntheticEvent): void => event.stopPropagation()

export function WorkforceCardGrid({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-testid="workforce-card-grid" className="grid gap-[var(--gap-2)]" style={{ gridTemplateColumns: CARD_GRID_COLUMNS }}>
      {children}
    </div>
  )
}

/**
 * One persona or one person as a CARD (workforce cards §2): who, what they are good at, which skills
 * they carry and where each came from, and the first steps of how they work -- with a skill one
 * click away ("+ skill") instead of one drawer away.
 *
 * The WHOLE card opens the existing drawer (`ProfileDrawer` for a persona, the person sheet for a
 * person) -- which is why the root is a plain `<div>` and not `ui/Card`'s button mode: the chips'
 * remove controls, "+ skill" and the Hirable toggle are buttons inside it, and a button inside a
 * button is not a thing a screen reader can describe. The keyboard path is the name, a real button
 * with the caller's own testid (`catalog-open-<id>` / `person-open`, the two a gate already drives).
 *
 * Writes are OPTIMISTIC and roll back: a chip appears (or disappears) on the click, the route is
 * asked, and a refusal puts the chip back and prints the route's own sentence on the card. Either
 * way the caller is asked to re-read (`onChanged`) -- on success that list holds the change, on a
 * refusal (a race with another edit, a skill gone from disk) it is the truth the refusal was about.
 * A fresh `skills` prop replaces every optimistic change, because it IS what those changes did.
 *
 * Nothing on the card is hidden by mode (`docs/ia.md` rule 2); developer mode is only DENSER, through
 * the `--gap-*` tokens `globals.css` shrinks under `:root[data-mode='developer']`.
 */
export function WorkforceCard({
  variant,
  testId,
  data,
  dimmed = false,
  tone,
  name,
  subtitle,
  summary,
  division,
  divisionTitle,
  capabilityKeys,
  capabilityText = [],
  taxonomy,
  skills,
  workflow,
  target,
  catalogue,
  openTestId,
  onOpen,
  onChanged,
  header,
  footer,
}: {
  readonly variant: 'persona' | 'person'
  /** The wrapper's testid -- `catalog-row-<id>` or `person-row-<id>`, the handles gates drive. */
  readonly testId: string
  readonly data?: Readonly<Record<`data-${string}`, string>>
  /** A released person reads as finished (M50 R3): greyed, still a card, still opens. */
  readonly dimmed?: boolean
  readonly tone: StatusTone
  readonly name: string
  readonly subtitle?: string | null
  readonly summary?: string
  readonly division: string | null
  /** The raw value behind the division chip, one hover away (M44 R5). */
  readonly divisionTitle?: string
  readonly capabilityKeys: readonly string[]
  /** Free-text capabilities, shown when a row has no taxonomy keys (an unmapped persona). */
  readonly capabilityText?: readonly string[]
  readonly taxonomy: readonly CapabilityRecord[]
  readonly skills: readonly CardSkillRow[]
  readonly workflow: WorkflowPreview
  readonly target: SkillTarget
  readonly catalogue: readonly SkillCatalogueRow[]
  readonly openTestId: string
  readonly onOpen: () => void
  readonly onChanged: () => void
  readonly header?: React.ReactNode
  readonly footer?: React.ReactNode
}): React.JSX.Element {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [added, setAdded] = useState<readonly CardSkillRow[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [removing, setRemoving] = useState<CardSkillRow | null>(null)

  useEffect(() => {
    setHidden(new Set())
    setAdded([])
  }, [skills])

  const visible = [...skills.filter((skill) => !hidden.has(skill.skillId)), ...added].toSorted(byCardOrder)
  const linked = new Set(visible.filter((skill) => skill.state !== 'revoked').map((skill) => skill.skillId))
  const specialties = capabilityKeys.length > 0 ? capabilityKeys.map((key) => capabilityLabel(key, taxonomy)) : capabilityText
  const chipPrefix = variant === 'persona' ? 'catalog' : 'person'

  const hide = (skillId: string): void => setHidden((current) => new Set([...current, skillId]))
  const unhide = (skillId: string): void =>
    setHidden((current) => new Set([...current].filter((one) => one !== skillId)))
  const unadd = (skillId: string): void => setAdded((current) => current.filter((one) => one.skillId !== skillId))

  const run = async (write: SkillWrite, rollback: () => void): Promise<void> => {
    setPending(true)
    setError(null)
    const refusal = await sendControl(write.url, { method: 'PATCH', body: write.body })
    setPending(false)
    if (refusal !== null) {
      rollback()
      setError(refusal)
    }
    onChanged()
  }

  const add = (skillId: string, scope: SkillScope): void => {
    const row = catalogue.find((one) => one.skillId === skillId)
    if (row === undefined) return
    setPicking(false)
    const toPersona = target.kind === 'persona' || (scope === 'persona' && target.personaId !== null)
    // A struck-through chip for the same skill gives way to the one being added.
    hide(skillId)
    setAdded((current) => [
      ...current,
      {
        skillId,
        name: row.name,
        providerName: row.providerName,
        missing: row.missing,
        process: isProcessSkill(row),
        state: toPersona ? 'persona' : 'person',
      },
    ])
    void run(addSkillWrite(target, skillId, scope), () => {
      unadd(skillId)
      unhide(skillId)
    })
  }

  const remove = (skill: CardSkillRow, scope: SkillScope): void => {
    setRemoving(null)
    hide(skill.skillId)
    void run(removeSkillWrite(target, skill, scope), () => unhide(skill.skillId))
  }

  const restore = (skill: CardSkillRow): void => {
    if (target.kind !== 'person') return
    hide(skill.skillId)
    setAdded((current) => [...current, { ...skill, state: 'persona' }])
    void run(restoreSkillWrite(target, skill.skillId), () => {
      unadd(skill.skillId)
      unhide(skill.skillId)
    })
  }

  /** Removing an INHERITED skill on a person card is two different acts -- this person only (a
   *  revoke) or everyone from the persona (the persona loses it) -- so it asks. Anything else has
   *  one meaning and goes straight through. */
  const onRemove = (skill: CardSkillRow): void => {
    if (target.kind === 'person' && skill.state === 'persona' && target.personaId !== null) setRemoving(skill)
    else remove(skill, 'person')
  }

  const skillChip = (skill: CardSkillRow): React.JSX.Element => {
    const struck = skill.state === 'revoked'
    return (
      <span
        key={skill.skillId}
        data-testid={`card-skill-${skill.skillId}`}
        data-source={skillSourceOf(skill.providerName).kind}
        data-origin={skill.state}
        data-process={String(skill.process)}
        data-missing={String(skill.missing)}
        title={skill.missing ? `${skill.name} — missing from disk` : skill.name}
        className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-pill border px-2 py-0.5 text-xs ${
          struck
            ? 'border-line text-text-3'
            : skill.missing
              ? 'border-line bg-bg-1 text-text-3 opacity-60'
              : 'border-line bg-bg-2 text-text-2'
        }`}
      >
        <span data-testid="card-skill-glyph" aria-hidden="true" title={skillSourceTitle(skill.providerName)}>
          {skillGlyphOf(skill.providerName)}
        </span>
        <span data-testid="card-skill-name" className={`min-w-0 truncate font-mono ${struck ? 'line-through' : ''}`.trim()}>
          {skill.name}
        </span>
        {skill.process && (
          <span data-testid="card-skill-process" role="img" aria-label="process skill" title={PROCESS_SKILL_WARNING}>
            ⚠️
          </span>
        )}
        {variant === 'person' && (
          <span data-testid="card-skill-origin" className="shrink-0 text-[10px] text-text-3">
            {ORIGIN_LABEL[skill.state]}
          </span>
        )}
        <span onClick={stop} className="shrink-0">
          {struck ? (
            <button
              type="button"
              data-testid={`card-skill-restore-${skill.skillId}`}
              aria-label={`restore ${skill.name}`}
              disabled={pending}
              onClick={() => restore(skill)}
              className="text-text-3 hover:text-text-1"
            >
              ↺
            </button>
          ) : (
            <button
              type="button"
              data-testid={`card-skill-remove-${skill.skillId}`}
              aria-label={`remove ${skill.name}`}
              disabled={pending}
              onClick={() => onRemove(skill)}
              className="text-text-3 hover:text-text-1"
            >
              ×
            </button>
          )}
        </span>
      </span>
    )
  }

  return (
    <div data-testid={testId} {...data} onClick={onOpen} className={`min-w-0 cursor-pointer ${dimmed ? 'opacity-60' : ''}`.trim()}>
      <Card testId="workforce-card" data={{ 'data-variant': variant }} className="h-full min-w-0">
        <div className="flex min-w-0 items-start gap-[var(--gap-1)]">
          <AvatarTile name={name} tone={tone} size="md" />
          <span className="flex min-w-0 flex-1 flex-col">
            <button
              type="button"
              data-testid={openTestId}
              aria-label={`open ${name}`}
              onClick={(event) => {
                // Once: the wrapper's own `onClick` would open it a second time.
                event.stopPropagation()
                onOpen()
              }}
              className="truncate text-left text-sm font-semibold text-text-1 hover:text-text-2"
            >
              {name}
            </button>
            {subtitle !== undefined && subtitle !== null && <span className="truncate text-[11.5px] text-text-2">{subtitle}</span>}
          </span>
          {division !== null && (
            <Chip testId="card-division" {...(divisionTitle === undefined ? {} : { title: divisionTitle })}>
              {division}
            </Chip>
          )}
        </div>
        {header}
        {summary !== undefined && summary !== '' && <p className="line-clamp-2 text-xs text-text-2">{summary}</p>}
        {specialties.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {specialties.slice(0, CARD_SPECIALTIES).map((label, index) => (
              <Chip key={`${String(index)}-${label}`} testId={`${chipPrefix}-capability-chip`}>
                {label}
              </Chip>
            ))}
            {specialties.length > CARD_SPECIALTIES && (
              <span data-testid={`${chipPrefix}-capability-more`} className="text-[10px] text-text-3">
                +{specialties.length - CARD_SPECIALTIES}
              </span>
            )}
          </div>
        )}
        <div data-testid="card-skills" className="flex min-w-0 flex-wrap items-center gap-1">
          {visible.length === 0 && (
            <span data-testid="card-skills-empty" className="text-xs text-text-3">
              no skills yet
            </span>
          )}
          {visible.slice(0, CARD_SKILLS).map(skillChip)}
          {visible.length > CARD_SKILLS && (
            <span data-testid="card-skills-more" className="text-[10px] text-text-3">
              +{visible.length - CARD_SKILLS}
            </span>
          )}
          <span onClick={stop}>
            <button
              type="button"
              data-testid="card-skill-add"
              aria-expanded={picking}
              disabled={pending}
              onClick={() => setPicking(!picking)}
              className="rounded-pill border border-dashed border-line px-2 py-0.5 text-xs text-text-3 hover:text-text-1"
            >
              + skill
            </button>
          </span>
        </div>
        {removing !== null && target.kind === 'person' && (
          <div data-testid="card-skill-remove-scope" onClick={stop} className="flex flex-wrap items-center gap-1 text-xs text-text-2">
            <span>{`Remove ${removing.name} from:`}</span>
            <Button variant="ghost" size="sm" data-testid="card-skill-remove-scope-person" onClick={() => remove(removing, 'person')}>
              Only this person
            </Button>
            <Button variant="ghost" size="sm" data-testid="card-skill-remove-scope-persona" onClick={() => remove(removing, 'persona')}>
              {`Everyone from ${target.personaName ?? 'the persona'}`}
            </Button>
            <Button variant="ghost" size="sm" data-testid="card-skill-remove-scope-cancel" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
          </div>
        )}
        {picking && (
          <div onClick={stop}>
            <SkillPicker
              catalogue={catalogue}
              linked={linked}
              scope={target.kind === 'person' ? { personaName: target.personaName } : null}
              pending={pending}
              onConfirm={add}
              onCancel={() => setPicking(false)}
            />
          </div>
        )}
        {error !== null && (
          <div onClick={stop}>
            <Alert variant="error" testId="card-skill-error">
              {error}
            </Alert>
          </div>
        )}
        <div data-testid="card-workflow" className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10.5px] uppercase tracking-wide text-text-3">Workflow</span>
          {workflow.total === 0 ? (
            <span data-testid="card-workflow-empty" className="text-xs text-text-3">
              No workflow in this profile
            </span>
          ) : (
            <ol className="flex min-w-0 flex-col gap-0.5">
              {workflow.steps.map((step, index) => (
                <li key={`${String(index)}-${step}`} data-testid="card-workflow-step" className="truncate text-xs text-text-2">
                  {`${String(index + 1)}. ${step}`}
                </li>
              ))}
            </ol>
          )}
          {workflow.total > workflow.steps.length && (
            <span data-testid="card-workflow-more" className="text-[10.5px] text-text-3">
              {`+${plural(workflow.total - workflow.steps.length, 'step')}`}
            </span>
          )}
        </div>
        {footer !== undefined && (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[10.5px] text-text-3">
            {footer}
          </div>
        )}
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: Run it**

Run: `npx tsc --build && npx vitest run apps/web/test/workforce-card.test.tsx apps/web/test/skill-picker.test.tsx`
Expected: PASS.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/workforce/WorkforceCard.tsx apps/web/test/workforce-card.test.tsx
git commit -m "feat(workforce): WorkforceCard with skill chips, origins, process marks and workflow preview" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Catalog tab on cards

**Files:**
- Modify: `apps/web/src/components/workforce/WorkforceCatalog.tsx` (the `DataTable` becomes a `WorkforceCardGrid` of persona `WorkforceCard`s; `openOf`; empty state with Clear; `skillCatalogue` typed `SkillCatalogueRow[]`)
- Modify: `apps/web/src/components/workforce/WorkforceClient.tsx` (only the `skillCatalogue` prop type)
- Modify: `apps/web/test/workforce-catalog.test.tsx` (two table-structure cases replaced, two card cases added)
- Modify: `scripts/gate-m11-shell.mjs` (the new-template row is a card now)

**Interfaces:**
- Consumes: `WorkforceCard`, `WorkforceCardGrid` (Task 7); `CatalogRowView.skills`, `.workflowPreview` (Task 2); `CatalogFilterBar` (Task 5); `SkillCatalogueRow` (Task 3); `StatusPill` (`ui/StatusPill`).
- Produces: `WorkforceCatalog(props: { initial: WorkforceCatalogView; taxonomy?: readonly CapabilityRecord[]; skillCatalogue?: readonly SkillCatalogueRow[] })` -- same props, richer catalogue type. Every testid a gate or test drives is kept: `workforce-catalog`, `catalog-row-<id>` (`data-mapping-quality`), `catalog-open-<id>`, `catalog-overridden-<id>`, `catalog-raw-override-<id>`, `catalog-duplicate-<id>` (`data-class`/`data-basis`/`data-score`/`title`), `catalog-source-<id>`, `catalog-activate-<id>` (`data-active`, `aria-pressed`, text `active`/`inactive`), `template-delete`, `catalog-count`, `catalog-more`, `catalog-empty` (+ new `catalog-empty-clear`), `catalog-stale`, `catalog-error`, `catalog-loading`. Gone: the `data-table`/`data-table-row` inside the catalog.

- [ ] **Step 1: Rewrite the table-structure tests as card tests**

In `apps/web/test/workforce-catalog.test.tsx`:

- replace the case `'keeps the data-table primitives the m11 gate drives, under the catalog handle'` with:

```tsx
  // Workforce cards: the catalog is a GRID of persona cards now. `gate:m11-shell` waits for the new
  // template by its `catalog-row-` wrapper (Task 8 moved it off `data-table-row`), so the wrapper
  // is the handle that must survive.
  it('lays the catalog out as persona cards on the card grid, one per template', () => {
    render(<WorkforceCatalog initial={view([row(), row({ id: 't2', name: 'Verifier' })])} />)

    expect(screen.getByTestId('workforce-catalog')).toBeTruthy()
    expect(screen.getByTestId('workforce-card-grid')).toBeTruthy()
    expect(screen.queryByTestId('data-table')).toBeNull()
    const card = within(screen.getByTestId('catalog-row-t1')).getByTestId('workforce-card')
    expect(card.getAttribute('data-variant')).toBe('persona')
    expect(screen.getAllByTestId(/^catalog-row-/u)).toHaveLength(2)
  })
```

- replace the case `'draws a separator under every row but the last, with no :last-child rule to undo it'` with:

```tsx
  it("hands each card the row's skills and workflow", () => {
    render(
      <WorkforceCatalog
        initial={view([
          row({
            skills: [{ skillId: 'sk1', name: 'pdf', providerName: 'personal', missing: false, process: false, state: 'persona' }],
            workflowPreview: { steps: ['Read the ticket'], total: 4 },
          }),
        ])}
      />,
    )
    const card = screen.getByTestId('catalog-row-t1')
    expect(within(card).getByTestId('card-skill-sk1')).toBeTruthy()
    expect(within(card).getByTestId('card-workflow-step').textContent).toBe('1. Read the ticket')
    expect(within(card).getByTestId('card-workflow-more').textContent).toBe('+3 steps')
  })

  it('offers Clear filters when a filtered answer is empty', async () => {
    search = 'q=nothing-like-it'
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(view([])), { status: 200 }))
    render(<WorkforceCatalog initial={view([])} />)

    const clear = await screen.findByTestId('catalog-empty-clear')
    fireEvent.click(clear)
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce')
  })
```

Run: `npx vitest run apps/web/test/workforce-catalog.test.tsx`
Expected: FAIL -- `workforce-card-grid` not found (the catalog is still a table), `card-skill-sk1` not found, `catalog-empty-clear` not found.

- [ ] **Step 2: Put the catalog on cards**

In `apps/web/src/components/workforce/WorkforceCatalog.tsx`:

1. Imports: drop `DataTable, Row` (`../ui/DataTable`); add

```tsx
import type { SkillCatalogueRow } from '../../server/persons'
import { StatusPill } from '../ui/StatusPill'
import { WorkforceCard, WorkforceCardGrid } from './WorkforceCard'
```

2. Delete `COLUMNS`, `HEADER` and `CHIPS` and the E13 docblock above them (the card owns its chip cap, `CARD_SPECIALTIES`). Keep `capabilityMappingOf`.

3. Below `capabilityMappingOf`, add the ONE place a row becomes the drawer's argument (it was spelled out twice inline):

```tsx
/** What the profile drawer opens with. */
interface OpenProfile {
  readonly id: string
  readonly name: string
  readonly capabilityKeys: readonly string[]
  /** R8: the half of `capabilityKeys` a model chose, and whether that mapping is current. */
  readonly mappedCapabilityKeys: readonly string[]
  readonly capabilityMapping: 'mapped' | 'stale' | 'none' | 'inactive'
  readonly defaultSkillIds: readonly string[]
  readonly hiredCount: number
}

/** A catalog row as the drawer's argument -- one function, so the card body and the name button
 *  cannot open two different drawers for one row. */
const openOf = (row: CatalogRowView): OpenProfile => ({
  id: row.id,
  name: row.name,
  capabilityKeys: row.capabilityKeys,
  mappedCapabilityKeys: row.mappedCapabilityKeys,
  capabilityMapping: capabilityMappingOf(row),
  defaultSkillIds: row.defaultSkillIds,
  hiredCount: row.hiredCount,
})
```

and type the drawer state `useState<OpenProfile | null>(null)`.

4. The prop becomes `readonly skillCatalogue?: readonly SkillCatalogueRow[]`, and the component docblock's third paragraph ("The `workforce-catalog` handle and each row's `catalog-row-<id>` are WRAPPERS ...") becomes:

```tsx
 * Each template is a persona CARD (workforce cards §2) on the card grid: its skills with their
 * source, its specialties, the first steps of its workflow and "+ skill" -- a skill linked from the
 * card goes to the persona, as a delta. The card's wrapper keeps `catalog-row-<id>` and the name
 * keeps `catalog-open-<id>`, the two handles every catalog gate drives; the activation toggle, the
 * customised / raw-override / duplicate chips, the source, the default model and the delete are the
 * row's own controls, moved onto the card whole.
```

5. Replace the whole `page.rows.length === 0 ? (<EmptyState .../>) : (<div data-testid="workforce-catalog">...</div>)` block with:

```tsx
      {page.rows.length === 0 ? (
        <EmptyState
          testId="catalog-empty"
          message="no template matches these filters."
          action={
            Object.keys(filters).length > 0 ? (
              <Button variant="ghost" size="sm" data-testid="catalog-empty-clear" onClick={() => setFilters({})}>
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <div data-testid="workforce-catalog">
          <WorkforceCardGrid>
            {page.rows.map((row) => (
              <WorkforceCard
                key={row.id}
                variant="persona"
                testId={`catalog-row-${row.id}`}
                data={{ 'data-mapping-quality': row.mappingQuality ?? '' }}
                tone={row.active ? 'done' : 'idle'}
                name={row.name}
                summary={row.summary}
                // R6 files an imported row under its DIVISION; a hand-made one has none and falls
                // back to the role it was typed with. The raw role stays one hover away (M44 R5).
                division={row.sourceDivision ?? row.role}
                divisionTitle={row.role}
                capabilityKeys={row.capabilityKeys}
                capabilityText={row.capabilities}
                taxonomy={taxonomy}
                skills={row.skills}
                workflow={row.workflowPreview}
                target={{ kind: 'persona', templateId: row.id }}
                catalogue={skillCatalogue}
                openTestId={`catalog-open-${row.id}`}
                onOpen={() => setOpen(openOf(row))}
                onChanged={() => reload(filters)}
                header={
                  <div className="flex min-w-0 flex-wrap items-center gap-1">
                    {/* M55 R2/R6: the Hirable toggle, kept on the card (spec §2). A WORD, never
                      * `true`; the boolean on `data-active`; `stopPropagation` so activating a
                      * persona does not also open its drawer behind the click. */}
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
                            setWriteError(error)
                            if (error === null) reload(filters)
                          })
                        }}
                      >
                        <StatusPill tone={row.active ? 'done' : 'idle'} label={row.active ? 'active' : 'inactive'} />
                      </button>
                    </span>
                    {row.overriddenFields.length > 0 && <Chip testId={`catalog-overridden-${row.id}`}>customised</Chip>}
                    {row.rawOverride && <Chip testId={`catalog-raw-override-${row.id}`}>raw override</Chip>}
                    {row.duplicate !== null && (
                      /* M55 R6/R9, unchanged: the class as the first half of a sentence and the other
                       * row's NAME as the second, the raw class/basis/score one attribute away, R9's
                       * sentence in the title. */
                      <span
                        data-testid={`catalog-duplicate-${row.id}`}
                        data-class={row.duplicate.class}
                        data-basis={row.duplicate.basis}
                        data-score={String(row.duplicate.score)}
                        title={
                          `${duplicateBasisLabel(row.duplicate.basis)} · ${row.duplicate.score.toFixed(3)} — ` +
                          'evidence is recorded per profile, so two rows split their own record.'
                        }
                        className="inline-flex min-w-0 items-center truncate rounded-chip border border-line bg-bg-2 px-2 py-0.5 text-xs text-text-2"
                      >
                        {`${duplicateClassLabel(row.duplicate.class)} ${row.duplicate.otherName}`}
                        {row.duplicateCount > 1 && ` +${String(row.duplicateCount - 1)}`}
                      </span>
                    )}
                  </div>
                }
                footer={
                  <>
                    <span data-testid={`catalog-source-${row.id}`} title={row.sourceId ?? 'made here'} className="min-w-0 truncate font-mono">
                      {row.source === 'imported' ? `imported · ${row.sourceRepository ?? 'unknown'}` : 'local'}
                    </span>
                    <span className="font-mono">
                      {row.defaultModel === null
                        ? '—'
                        : `${row.defaultModel}${row.defaultProvider === null ? '' : ` · ${row.defaultProvider}`}`}
                    </span>
                    {/* The delete is an action ON the card, not a way INTO it. */}
                    <span onClick={(event) => event.stopPropagation()}>
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
                    </span>
                  </>
                }
              />
            ))}
          </WorkforceCardGrid>
        </div>
      )}
```

6. In the `ProfileDrawer`'s `onOpenTemplate`, build the argument with the same `OpenProfile` shape (its body is unchanged; only `setOpen({ ... })` now type-checks against `OpenProfile`).

`apps/web/src/components/workforce/WorkforceClient.tsx`: import `type SkillCatalogueRow` from `../../server/persons` (beside `PersonDetail, PersonRow`) and type the prop `readonly skillCatalogue: readonly SkillCatalogueRow[]`.

`scripts/gate-m11-shell.mjs`, scenario stage 1 -- the new template is a CARD now:

```js
  // Workforce cards: the catalog is a card grid, so the new template is found by its card wrapper
  // (`catalog-row-<id>`) -- the handle `WorkforceCatalog` keeps for exactly this -- not a table row.
  const templateRow = page.locator('[data-testid^="catalog-row-"]').filter({ hasText: TEMPLATE_NAME })
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run apps/web/test/workforce-catalog.test.tsx apps/web/test/catalog-duplicates.test.tsx apps/web/test/workforce-page.test.tsx apps/web/test/workforce-card.test.tsx`
Expected: PASS -- including the existing division/role, source, customised/raw-override, default-model (`'—'` appears once per card), mapping-quality, activation and duplicate cases, which read the same testids off the card.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/workforce/WorkforceCatalog.tsx apps/web/src/components/workforce/WorkforceClient.tsx \
  apps/web/test/workforce-catalog.test.tsx scripts/gate-m11-shell.mjs
git commit -m "feat(workforce): the Catalog tab as persona cards" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: People tab on cards (server-paged), keeping the person sheet

**Files:**
- Create: `apps/web/src/components/persons/PeopleCards.tsx`
- Delete: `apps/web/src/components/persons/PeopleTable.tsx`, `apps/web/test/people-table.test.tsx`
- Modify: `apps/web/src/components/workforce/WorkforceClient.tsx` (People tab renders `PeopleCards`; new `peoplePage` prop; `skillHolders` prop removed)
- Modify: `apps/web/src/app/workforce/page.tsx` (reads `listPeoplePage(parsePeopleFilters(query))`; drops the `skillHolders` map)
- Modify: `apps/web/test/workforce-page.test.tsx`
- Modify (gate selectors -- People is paged, so a person past page one is found by SEARCHING): `scripts/gate-m11-shell.mjs`, `scripts/gate-m14-fidelity.mjs`, `scripts/gate-m44-ux-foundation.mjs`, `scripts/gate-m50-ephemeral.mjs`, `scripts/gate-m58-persons.mjs`, `scripts/gate-m61-simple-mode.mjs`
- Test: `apps/web/test/people-cards.test.tsx` (new)

**Interfaces:**
- Consumes: `PeoplePageView`, `PersonCardRow`, `SkillCatalogueRow`, `listPeoplePage` (Task 3); `parsePeopleFilters`, `peopleFilterParams`, `withPeopleFilter`, `PeopleState` (Task 3); `usePeopleFilters`, `WorkforceFilterBar` (Task 5); `WorkforceCard`, `WorkforceCardGrid` (Task 7); `SkillTarget` (Task 4); `ui/Segmented`, `ui/ScrollArea`, `ui/EmptyState`, `ui/LoadingState`, `ui/Alert`, `ui/Chip`, `ui/Button`.
- Produces:
  - `PeopleCards(props: { readonly initial: PeoplePageView; readonly departments: readonly { readonly companyTeamId: string; readonly name: string }[]; readonly skillCatalogue: readonly SkillCatalogueRow[]; readonly taxonomy: readonly CapabilityRecord[]; readonly refreshKey?: number; readonly onOpen: (personId: string) => void }): React.JSX.Element`
  - `WorkforceClient` props: `+ peoplePage: PeoplePageView`, `- skillHolders`; `people: readonly PersonRow[]` stays (the company manager's member picker)
  - testids kept: `people-table` (root), `people-rows` (with a `ScrollArea` -> `[data-scroll-axis]` inside), `person-row-<id>` (`data-person-id`, `data-person-state`, `data-released`), `person-open`, `person-pool-chip`, `person-seat-chip`, `people-filter` + `people-filter-<all|pool|assigned|released>`, `people-filter-department`, `people-empty`; new: `people-count`, `people-more`, `people-stale`, `people-loading`, `people-empty-clear`, and the bar's `people-search`, `people-specialty-*`, `people-division-select`, `people-skill-select`, `people-no-skills`, `people-clear-filters`

- [ ] **Step 1: Write the failing component test**

`apps/web/test/people-cards.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PeopleCards } from '../src/components/persons/PeopleCards.js'
import type { PeoplePageView, PersonCardRow } from '../src/server/persons.js'

let search = ''
const replaceState = vi.fn()

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
}))

function person(over: Partial<PersonCardRow> = {}): PersonCardRow {
  return {
    personId: 'p1',
    name: 'Atlas',
    personaId: 't1',
    personaName: 'Builder',
    state: 'assigned',
    stateLabel: 'ASSIGNED',
    departments: [],
    seats: [
      { slaveId: 's1', teamId: 'tm1', teamName: 'Engineering', workspaceId: 'w1', projectName: 'Alpha', role: 'dev', runtimeRoles: ['dev'], closedAt: null },
    ],
    skillCount: 0,
    capabilities: [],
    lifecycle: 'permanent',
    releasedAt: null,
    releaseReason: null,
    division: 'engineering',
    skills: [],
    workflowPreview: { steps: [], total: 0 },
    ...over,
  }
}

const pageOf = (rows: readonly PersonCardRow[], over: Partial<PeoplePageView> = {}): PeoplePageView => ({
  rows,
  facets: { domains: [{ domain: 'qa', count: 1 }], divisions: ['engineering'] },
  total: rows.length,
  nextCursor: null,
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  search = ''
  replaceState.mockClear()
  vi.stubGlobal('history', { replaceState })
  fetchMock = vi.fn(async () => new Response(JSON.stringify(pageOf([person()])), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const renderCards = (initial: PeoplePageView, onOpen: (id: string) => void = vi.fn()) =>
  render(<PeopleCards initial={initial} departments={[{ companyTeamId: 'ct1', name: 'Backend' }]} skillCatalogue={[]} taxonomy={[]} onOpen={onOpen} />)

describe('PeopleCards', () => {
  it('is one card per person, with the handles the gates read', () => {
    renderCards(pageOf([person(), person({ personId: 'p2', name: 'Pooled', state: 'pool', stateLabel: 'IN THE POOL', seats: [] })]))
    const seated = screen.getByTestId('person-row-p1')
    expect(seated.getAttribute('data-person-id')).toBe('p1')
    expect(seated.getAttribute('data-person-state')).toBe('assigned')
    expect(seated.getAttribute('data-released')).toBe('false')
    expect(within(seated).getAllByTestId('person-seat-chip').map((chip) => chip.textContent)).toEqual(['Alpha'])
    expect(within(screen.getByTestId('person-row-p2')).getByTestId('person-pool-chip').textContent).toBe('in the pool')
    expect(within(screen.getByTestId('people-rows')).getByTestId('workforce-card-grid')).toBeTruthy()
  })

  it('greys a released person and still opens them', () => {
    const onOpen = vi.fn()
    renderCards(
      pageOf([person({ state: 'released', stateLabel: 'RELEASED', seats: [], releasedAt: '2026-09-20T00:00:00.000Z' })]),
      onOpen,
    )
    const card = screen.getByTestId('person-row-p1')
    expect(card.getAttribute('data-released')).toBe('true')
    expect(card.className).toContain('opacity-60')
    fireEvent.click(within(card).getByTestId('person-open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith('p1')
  })

  it('asks the SERVER when a filter moves, with the filter in the query', async () => {
    renderCards(pageOf([person()]))
    await act(async () => {
      fireEvent.click(screen.getByTestId('people-filter-pool'))
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/persons?state=pool')
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce?state=pool')
  })

  it('says "showing N of M" and appends the next page on Show more', async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(pageOf([person({ personId: 'p101', name: 'Later' })], { total: 101 })), { status: 200 }),
    )
    renderCards(pageOf([person()], { total: 101, nextCursor: 'p1' }))
    expect(screen.getByTestId('people-count').textContent).toBe('showing 1 of 101 slaves')
    await act(async () => {
      fireEvent.click(screen.getByTestId('people-more'))
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/persons?cursor=p1')
    expect(screen.getAllByTestId(/^person-row-/u).map((card) => card.getAttribute('data-person-id'))).toEqual(['p1', 'p101'])
  })

  it('offers Clear filters on an empty filtered answer', async () => {
    search = 'specialty=no-such-domain'
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(pageOf([])), { status: 200 }))
    renderCards(pageOf([]))
    fireEvent.click(screen.getByTestId('people-empty-clear'))
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/workforce')
  })

  it('re-reads when the page hands it a new refresh key (a person changed in the sheet)', async () => {
    const view = render(
      <PeopleCards initial={pageOf([person()])} departments={[]} skillCatalogue={[]} taxonomy={[]} refreshKey={0} onOpen={vi.fn()} />,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => {
      view.rerender(<PeopleCards initial={pageOf([person()])} departments={[]} skillCatalogue={[]} taxonomy={[]} refreshKey={1} onOpen={vi.fn()} />)
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/persons')
  })
})
```

Run: `npx vitest run apps/web/test/people-cards.test.tsx`
Expected: FAIL -- `Failed to resolve import "../src/components/persons/PeopleCards.js"`.

- [ ] **Step 2: Implement `PeopleCards`**

`apps/web/src/components/persons/PeopleCards.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CapabilityRecord } from '@slave-of-ai/domain'
import type { PeoplePageView, PersonCardRow, SkillCatalogueRow } from '../../server/persons'
import { peopleFilterParams, withPeopleFilter, type PeopleFilters, type PeopleState } from '../../lib/peopleFilters'
import { plural } from '../../lib/plural'
import { usePeopleFilters } from '../../hooks/usePeopleFilters'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { EmptyState } from '../ui/EmptyState'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'
import { LoadingState } from '../ui/LoadingState'
import { ScrollArea } from '../ui/ScrollArea'
import { Segmented } from '../ui/Segmented'
import type { StatusTone } from '../ui/StatusPill'
import { WorkforceCard, WorkforceCardGrid } from '../workforce/WorkforceCard'
import { WorkforceFilterBar } from '../workforce/WorkforceFilterBar'

type Segment = 'all' | PeopleState

const SEGMENTS: readonly { readonly id: Segment; readonly label: string }[] = [
  { id: 'all', label: 'Everyone' },
  { id: 'pool', label: 'In the pool' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'released', label: 'Released' },
]

const TONE: Record<PeopleState, StatusTone> = { assigned: 'working', pool: 'idle', released: 'paused' }

/**
 * Workforce -> People as CARDS (workforce cards §1/§2): one card per person, filtered, faceted and
 * PAGED on the server (`listPeoplePage`, `GET /api/persons`) the way the catalog is -- the pool
 * keeps up to three people per persona, so this list is several hundred long, and filtering that
 * plus facets in the browser was the wrong place.
 *
 * Seeded by the page's own read of the SAME URL (`/workforce/page.tsx` parses it with
 * `parsePeopleFilters`), so a shared `?specialty=` link opens on the cards its bar says it is
 * showing; re-read on every filter change, on "Show more" (which APPENDS), when the page hands a
 * new `initial` (a `router.refresh()` after a new slave), and when `refreshKey` moves (a change made
 * in the person sheet). The latest request wins, never merely the last to arrive -- the catalog's
 * `latest` sequence, for the catalog's reason.
 *
 * The handles every People gate drives are kept on the card: `person-row-<id>` with its
 * `data-person-*` attributes, `person-open`, `person-pool-chip`, `person-seat-chip`, and
 * `people-rows` with a scrolling region inside it.
 */
export function PeopleCards({
  initial,
  departments,
  skillCatalogue,
  taxonomy,
  refreshKey = 0,
  onOpen,
}: {
  readonly initial: PeoplePageView
  readonly departments: readonly { readonly companyTeamId: string; readonly name: string }[]
  readonly skillCatalogue: readonly SkillCatalogueRow[]
  readonly taxonomy: readonly CapabilityRecord[]
  readonly refreshKey?: number
  readonly onOpen: (personId: string) => void
}): React.JSX.Element {
  const { filters, setFilters } = usePeopleFilters()
  const [page, setPage] = useState<PeoplePageView>(initial)
  const [stale, setStale] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    setPage(initial)
  }, [initial])

  const latest = useRef(0)
  const reload = useCallback((next: PeopleFilters, cursor?: string): void => {
    const params = peopleFilterParams(next)
    // A position in an answer, not a filter: never written into the address bar.
    if (cursor !== undefined) params.set('cursor', cursor)
    const query = params.toString()
    const id = latest.current + 1
    latest.current = id
    setRefreshing(true)
    void fetch(query === '' ? '/api/persons' : `/api/persons?${query}`)
      .then(async (response) => (response.ok ? ((await response.json()) as PeoplePageView) : null))
      .then((view) => {
        if (id !== latest.current) return
        setRefreshing(false)
        if (view === null) {
          setStale(true)
          return
        }
        setStale(false)
        setPage((current) => (cursor === undefined ? view : { ...view, rows: [...current.rows, ...view.rows] }))
      })
      .catch(() => {
        if (id !== latest.current) return
        setRefreshing(false)
        setStale(true)
      })
  }, [])

  // The first pass does not fetch: `initial` IS that answer (the catalog's rule).
  const firstPass = useRef(true)
  useEffect(() => {
    if (firstPass.current) {
      firstPass.current = false
      return
    }
    reload(filters)
  }, [filters, refreshKey, reload])

  const set = (key: Parameters<typeof withPeopleFilter>[1], value: string): void => setFilters(withPeopleFilter(filters, key, value))
  const filtered = Object.keys(filters).length > 0

  const card = (person: PersonCardRow): React.JSX.Element => (
    <WorkforceCard
      key={person.personId}
      variant="person"
      testId={`person-row-${person.personId}`}
      data={{
        'data-person-id': person.personId,
        // The raw state is an attribute; the WORD is the chip below (R28).
        'data-person-state': person.state,
        'data-released': person.releasedAt === null ? 'false' : 'true',
      }}
      dimmed={person.releasedAt !== null}
      tone={TONE[person.state]}
      name={person.name}
      subtitle={person.personaName}
      division={person.division}
      capabilityKeys={person.capabilities}
      taxonomy={taxonomy}
      skills={person.skills}
      workflow={person.workflowPreview}
      target={{ kind: 'person', personId: person.personId, personaId: person.personaId, personaName: person.personaName }}
      catalogue={skillCatalogue}
      openTestId="person-open"
      onOpen={() => onOpen(person.personId)}
      onChanged={() => reload(filters)}
      header={
        <span className="flex min-w-0 flex-wrap gap-1">
          {person.seats.length === 0 ? (
            <Chip testId="person-pool-chip" title={person.state}>
              {person.stateLabel.toLowerCase()}
            </Chip>
          ) : (
            person.seats.map((seat) => (
              <Chip key={seat.slaveId} testId="person-seat-chip" title={seat.workspaceId}>
                {seat.projectName}
              </Chip>
            ))
          )}
        </span>
      }
    />
  )

  return (
    <div data-testid="people-table" className="flex min-h-0 flex-1 flex-col gap-3">
      <WorkforceFilterBar
        testIdPrefix="people"
        query={filters.q ?? ''}
        onQuery={(value) => set('q', value)}
        domains={page.facets.domains}
        specialty={filters.specialty}
        onSpecialty={(value) => set('specialty', value)}
        divisions={page.facets.divisions}
        division={filters.division}
        onDivision={(value) => set('division', value)}
        skillOptions={skillCatalogue.map((row) => ({ value: row.skillId, label: `${row.name} (${row.providerName})` }))}
        skill={filters.skillId}
        onSkill={(value) => set('skillId', value)}
        noSkills={filters.noSkills === true}
        onNoSkills={(next) => set('noSkills', next ? 'true' : '')}
        filtered={filtered}
        onClear={() => setFilters({})}
        searchPlaceholder="name, persona, capability, skill"
      >
        <Segmented
          options={SEGMENTS}
          value={filters.state ?? 'all'}
          onChange={(next) => set('state', next === 'all' ? '' : next)}
          ariaLabel="People"
          testIdPrefix="people-filter"
        />
        <label className="flex flex-col gap-1">
          <FieldLabel>Department</FieldLabel>
          <select
            data-testid="people-filter-department"
            aria-label="department"
            value={filters.department ?? ''}
            onChange={(event) => set('department', event.target.value)}
            className={`w-44 ${INPUT_SHELL}`}
          >
            <option value="">every department</option>
            {departments.map((row) => (
              <option key={row.companyTeamId} value={row.companyTeamId}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
      </WorkforceFilterBar>
      {stale && (
        <Alert variant="error" testId="people-stale">
          could not refresh the people — showing the last answer.
        </Alert>
      )}
      <span data-testid="people-count" className="text-xs text-text-3">
        {page.rows.length >= page.total
          ? plural(page.total, 'slave')
          : `showing ${String(page.rows.length)} of ${plural(page.total, 'slave')}`}
      </span>
      {refreshing && <LoadingState testId="people-loading" message="reading the people…" />}
      {page.rows.length === 0 ? (
        <EmptyState
          testId="people-empty"
          message="Nobody matches. Change the filters, or make a new slave — they do not need a project."
          action={
            filtered ? (
              <Button variant="ghost" size="sm" data-testid="people-empty-clear" onClick={() => setFilters({})}>
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <div data-testid="people-rows" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="flex flex-col gap-3">
            <WorkforceCardGrid>{page.rows.map(card)}</WorkforceCardGrid>
            {page.nextCursor !== null && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="people-more"
                disabled={refreshing}
                onClick={() => {
                  const cursor = page.nextCursor
                  if (cursor !== null) reload(filters, cursor)
                }}
              >
                Show more
              </Button>
            )}
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
```

Run: `npx vitest run apps/web/test/people-cards.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 3: Wire it into the page and the client**

`apps/web/src/app/workforce/page.tsx`:

- import `listPeoplePage` beside `listPersons, listSkillCatalogue` and `import { parsePeopleFilters } from '../../lib/peopleFilters'`;
- add a sixteenth read to the `Promise.all`, after `listSkillCatalogue()`, and name it `peoplePage` in the destructuring:

```ts
      // Workforce cards: People as server-paged CARDS, seeded with the filters the URL already
      // claims -- the catalog's M46 M1 rule, for the tab this page opens on by default. `people`
      // above stays: it is the company manager's member picker, which must be everybody.
      listPeoplePage(parsePeopleFilters(query)),
```

- delete the `skillHolders` map and the `skillHolders={skillHolders}` prop; pass `peoplePage={peoplePage}`.

`apps/web/src/components/workforce/WorkforceClient.tsx`:

- replace `import { PeopleTable } from '../persons/PeopleTable'` with `import { PeopleCards } from '../persons/PeopleCards'`, and add `PeoplePageView` to the `../../server/persons` type import;
- props: add `readonly peoplePage: PeoplePageView` (docblock: "People as cards (workforce cards), read by the page under the URL's own filters"), remove `skillHolders` from the destructuring and the prop types;
- the `tab === 'slaves'` body becomes:

```tsx
      {tab === 'slaves' && (
        // The bare `flex min-h-0 flex-1 flex-col` frame: `PeopleCards` scrolls inside its own
        // `ScrollArea`, which needs a REAL bounded height at every level above it.
        <div className="flex min-h-0 flex-1 flex-col">
          <PeopleCards
            initial={peoplePage}
            departments={peopleDepartments}
            skillCatalogue={skillCatalogue}
            taxonomy={taxonomy}
            // A change made in the person sheet (a skill, a seat) re-reads the cards behind it.
            refreshKey={personTick}
            onOpen={(personId) => setSelectedPerson(personId)}
          />
        </div>
      )}
```

Delete `apps/web/src/components/persons/PeopleTable.tsx` and `apps/web/test/people-table.test.tsx` (`git rm`); `PeopleCards` and `people-cards.test.tsx` replace them, and `people-page.test.ts` (Task 3) covers the filtering that used to be local.

`apps/web/test/workforce-page.test.tsx`:

- type imports: add `PeoplePageView, PersonCardRow` beside `PersonDetail, PersonRow`;
- at module level beside `listWorkforceCatalogPage`:

```tsx
const listPeoplePage = vi.fn(async (_filters?: unknown) => peoplePageOf([]))
```

- the `../src/server/persons.js` mock gains `listPeoplePage: (filters?: unknown) => listPeoplePage(filters),`;
- below `personRow()` add:

```tsx
/** A People row as a CARD reads it (workforce cards): the row plus the three card fields. */
function personCard(row: PersonRow): PersonCardRow {
  return { ...row, division: null, skills: [], workflowPreview: { steps: [], total: 0 } }
}

const peoplePageOf = (rows: readonly PersonRow[]): PeoplePageView => ({
  rows: rows.map(personCard),
  facets: { domains: [], divisions: [] },
  total: rows.length,
  nextCursor: null,
})
```

- in `TestWorkforceClient`, replace `skillHolders={{}}` with `peoplePage={peoplePageOf(props.people ?? [personRow()])}` (it stays BEFORE `{...props}`, so a case passing `people` gets matching cards and a case passing `peoplePage` wins);
- in `'renders the people table by default, with the other three tabs beside it'`, `screen.getByTestId('person-name')` becomes `screen.getByTestId('person-open')`;
- add to `describe('the Workforce page seeds the catalog from the URL (M46 M1)')`:

```tsx
  it('seeds People from the same URL', async () => {
    listPeoplePage.mockClear()
    await renderPage({ state: 'pool', specialty: 'qa', skills: 'none' })

    expect(listPeoplePage).toHaveBeenCalledWith({ specialty: 'qa', noSkills: true, state: 'pool' })
  })
```

- [ ] **Step 4: Point the People gates at cards and at search**

People is paged now, so every gate helper that SCROLLED a virtualised table to reach a person SEARCHES for them instead; the handles it then reads (`person-row-<id>`, `data-person-*`, `person-open`, `person-pool-chip`, `person-seat-chip`) are unchanged.

`scripts/gate-m11-shell.mjs` -- replace the body of `scrollPeopleTo`:

```js
  // Workforce cards: People is server-PAGED (a hundred a page) and filtered in the database, so a
  // person past the first page is reached by SEARCHING for them, never by scrolling.
  async function scrollPeopleTo(name) {
    await page.getByTestId('people-search').fill(name)
    const found = await page
      .locator('[data-testid^="person-row-"]')
      .filter({ hasText: name })
      .first()
      .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    return { searched: true, found }
  }
```

(its two call sites -- stage 1's pooled row and stage 3's `clickUntil` -- are unchanged; the comment `// Virtualised (M61 R12), so the row has to be scrolled to before it can be seen.` becomes `// Paged (workforce cards), so the person is searched for before they can be seen.`)

`scripts/gate-m58-persons.mjs` -- the same replacement for its `scrollPeopleTo(needle)` (parameter `needle`, `ACTION_TIMEOUT_MS` is 30 s there), with its docblock reading `/** Finds a person on the PAGED People cards (workforce cards) by searching for them. */`.

`scripts/gate-m44-ux-foundation.mjs`, stage 4's workforce positive -- replace the `const scrolled = await page.evaluate(async (name) => { ... }, SLAVE_NAME)` block and its `console.log` with:

```js
      // Workforce cards: People is paged, so the fixture worker is SEARCHED for, not scrolled to.
      await page.getByTestId('people-search').fill(SLAVE_NAME)
      console.log(`stage 4 (workforce): searched the People cards for ${SLAVE_NAME}`)
```

`scripts/gate-m50-ephemeral.mjs`, stage 9 -- one segment per question, so neither is at the mercy of which hundred people page one holds:

```js
  // Workforce cards: People is paged and filtered on the server, so each question gets its own
  // segment -- the released specialist under Released, the worker still here under Assigned.
  await gotoReliably(`${baseUrl}/workforce?state=released`)
  await waitVisible(page.getByTestId('people-rows'), 'the released People cards')
  const releasedRows = await page
    .locator('[data-testid^="person-row-"][data-released="true"]')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').trim().slice(0, 120)))
  console.log(`stage 9 -- the released cards: ${JSON.stringify(releasedRows)}`)
  if (!releasedRows.some((text) => text.includes(`${SECURITY_PERSONA} 2`))) {
    await fail(`stage 9: the released specialist is not marked in People: ${JSON.stringify(releasedRows)}`)
  }
  const releasedStates = await page
    .locator('[data-testid^="person-row-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-person-state')))
  if (!releasedStates.includes('released')) await fail(`stage 9: no released card: ${JSON.stringify(releasedStates)}`)
  await gotoReliably(`${baseUrl}/workforce?state=assigned`)
  await waitVisible(page.getByTestId('people-rows'), 'the assigned People cards')
  const assignedStates = await page
    .locator('[data-testid^="person-row-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-person-state')))
  console.log(`stage 9 -- the assigned cards' states: ${JSON.stringify(assignedStates)}`)
  if (!assignedStates.includes('assigned')) await fail(`stage 9: no assigned card: ${JSON.stringify(assignedStates)}`)
```

(this replaces everything from `await gotoReliably(\`${baseUrl}/workforce\`)` through `if (!stateWords.includes('assigned')) ...` in stage 9.)

`scripts/gate-m14-fidelity.mjs`, stage 2a's People block -- the table's column template becomes the card grid's track template, asserted the same two ways (authored, and used):

```js
  // Workforce cards: People is a card GRID, one card per person. The track template is asserted
  // TWICE, as the table's columns were: AUTHORED (the inline style) and USED (resolved to pixel
  // tracks, each at least the 320px minimum -- at 1440x900 there is always room for one).
  const PEOPLE_GRID = 'repeat(auto-fill, minmax(320px, 1fr))'
  await gotoReliably(`${baseUrl}/workforce`)
  await clickUntil(
    page.getByTestId('workforce-tab-slaves'),
    async () =>
      normalize(
        (await page.evaluate(
          () => document.querySelector('[data-testid="people-rows"] [data-testid="workforce-card-grid"]')?.style.gridTemplateColumns ?? '',
        )) ?? '',
      ) === PEOPLE_GRID,
    "the Workforce page's People cards",
  )
  const peopleTracks = normalize((await computed('[data-testid="people-rows"] [data-testid="workforce-card-grid"]', 'grid-template-columns')) ?? '')
  const trackWidths = peopleTracks.split(' ').map((token) => Number(/^(\d+(?:\.\d+)?)px$/.exec(token)?.[1] ?? 'NaN'))
  if (trackWidths.length === 0 || trackWidths.some((width) => !(width >= 320))) {
    await fail(
      `stage 2 (workforce): the People card grid resolved to ${JSON.stringify(peopleTracks)} -- ` +
        'expected one or more pixel tracks of at least 320px',
    )
  }
  console.log(
    `stage 2 (workforce): [data-testid="people-rows"] [data-testid="workforce-card-grid"] = ${JSON.stringify(PEOPLE_GRID)} ` +
      `(used: ${peopleTracks})`,
  )
```

(this replaces everything from `const PEOPLE_COLUMNS = ...` through the `console.log` that prints `grid-template-columns = ${JSON.stringify(PEOPLE_COLUMNS)}`, and the comment above `PEOPLE_COLUMNS`.)

`scripts/gate-m61-simple-mode.mjs`, stage 8 -- a CARD opens on a click on its body, but the centre of a card can be a chip's remove control (which must NOT open it, and would unlink a skill). The click lands on the card's avatar, which is body:

```js
    const firstRow = pg.locator('[data-testid^="person-row-"]').first()
    await waitVisible(firstRow, 'a card in People')
    // Workforce cards: the AVATAR -- card body, never a control -- so the claim stays "a click on
    // the card opens the person", without the click landing on a chip's remove button.
    await clickUntil(firstRow.getByTestId('avatar-tile'), async () => pg.getByTestId('person-sheet').isVisible(), 'a person card')
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run apps/web/test/people-cards.test.tsx apps/web/test/workforce-page.test.tsx apps/web/test/workforce-catalog.test.tsx apps/web/test/person-panel-groups.test.tsx`
Expected: PASS.

Run: `npm run typecheck && node --check scripts/gate-m11-shell.mjs && node --check scripts/gate-m14-fidelity.mjs && node --check scripts/gate-m44-ux-foundation.mjs && node --check scripts/gate-m50-ephemeral.mjs && node --check scripts/gate-m58-persons.mjs && node --check scripts/gate-m61-simple-mode.mjs`
Expected: exit 0 (the gates themselves run in Task 10).

- [ ] **Step 6: Commit**

```bash
git rm apps/web/src/components/persons/PeopleTable.tsx apps/web/test/people-table.test.tsx
git add apps/web/src/components/persons/PeopleCards.tsx apps/web/src/components/workforce/WorkforceClient.tsx \
  apps/web/src/app/workforce/page.tsx apps/web/test/people-cards.test.tsx apps/web/test/workforce-page.test.tsx \
  scripts/gate-m11-shell.mjs scripts/gate-m14-fidelity.mjs scripts/gate-m44-ux-foundation.mjs \
  scripts/gate-m50-ephemeral.mjs scripts/gate-m58-persons.mjs scripts/gate-m61-simple-mode.mjs
git commit -m "feat(workforce): the People tab as server-paged person cards" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: `docs/ia.md`, the gates, and the whole suite

**Files:**
- Modify: `docs/ia.md` (the `/workforce` row of the page table)
- No code changes -- this task only verifies. A gate or suite failure found here is fixed in the task that owns the file, re-run, and committed there.

**Interfaces:**
- Consumes: everything above.
- Produces: the IA record of the redesign; a green `web:build`, `typecheck`, `gate:m26-vocabulary`, the `/workforce` UI gates, and the full vitest suite.

- [ ] **Step 1: Record the redesign in `docs/ia.md`**

At the end of the `/workforce` row's last cell (the one ending "...renders the strip marked `data-outside-mode`."), append:

```markdown
 **Workforce cards** (2026-09-26): Catalog and People are CARD grids sharing one filter bar — search (a linked skill's name too, and on People as well), Specialty chips (the capability domains, busiest first, eight then `+N`), Division, Skill, **No skills** (who still needs equipping), and People's own Everyone / In the pool / Assigned / Released and department. A card shows its skills with their source — 🧩 your own or the project's, 🔌 a plugin, named in the tooltip — and, on a person, where each came from (from persona / this person only / revoked, struck, with restore); ⚠️ marks a process skill that can make a worker plan and delegate instead of doing its task. Up to three specialties and the first three workflow steps sit under them ("No workflow in this profile" when there is none). **+ skill** links one from the card: on a persona it goes to the persona; on a person it asks — only this person (the default) or everyone from the persona. A click on the card opens the same drawer or sheet as before. People is filtered and paged on the server now, a hundred at a time with Show more, and the URL carries the filters (`?specialty=`, `?skills=none`, `?state=`, `?skillId=`, `?department=`).
```

Run: `npm run gate:m26-vocabulary`
Expected: `PASS: the word is slave everywhere it is ours`.

```bash
git add docs/ia.md
git commit -m "docs(ia): workforce cards on /workforce" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Typecheck and build**

Stop any `next dev` first (`pgrep -af "next dev"` must print nothing; a build clobbers a running dev server's `apps/web/.next`).

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run web:build`
Expected: `✓ Compiled successfully` and exit 0 -- this is the check that catches a client component pulling a server-only module into its bundle (`WorkforceCard` and `SkillPicker` import `server/*` for TYPES only; the one value they share with the server reads lives in `lib/cardSkills.ts`, which must stay prisma-free).

- [ ] **Step 3: Run the `/workforce` gates on the gate database with the fake CLIs**

Stop the host orchestrator daemon first (the gates refuse to run beside one). Then, one at a time, each with the fake-CLI env on `GATE_DATABASE_URL` (never the dev DB):

```bash
for gate in m46-workforce-catalog m55-catalog m58-persons m44-ux-foundation m57-ui-redesign m61-simple-mode m11-shell m14-fidelity m50-ephemeral; do
  DATABASE_URL="$GATE_DATABASE_URL" \
  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
  SLAVEOFAI_CURSOR_BIN="$PWD/scripts/gate-fakes/fake-cursor-agent.sh" \
  SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
  npm run "gate:$gate" > "/tmp/gate-$gate.log" 2>&1
  echo "gate:$gate exit $?"
done
```

Expected: `exit 0` for `m46-workforce-catalog`, `m57-ui-redesign`, `m61-simple-mode` (stage 2 measures no horizontal scroll at 1024x680 with the card grid; stage 8 opens a card from its avatar), `m44-ux-foundation` and `m11-shell`. `m55-catalog`, `m58-persons`, `m50-ephemeral` and `m14-fidelity` have PRE-EXISTING red stages on main (m55 stage 4a, m58 stage 7, m50's planning pipeline; see memory "Pre-existing red gates outside CI"): for those, `grep -n "stage" /tmp/gate-<name>.log | tail` must show the run getting PAST every stage this plan touched (m55 stages 2-4c and 10, m58 stages 1 and 4, m50 stage 9, m14 stage 2a) and failing, if at all, only at the stage it already fails at on `main` -- when in doubt, run the same gate from a clean `main` checkout (`git worktree add ../slave-of-ai-main main`, `npm ci` there) and compare the failing stage. Any NEW failure is fixed in the owning task.

- [ ] **Step 4: The whole suite, one vitest process**

Run: `npx tsc --build && npx vitest run 2>&1 | tail -40` (about five minutes; run it in the background with a 600 s budget and wait on its log line, never `pgrep -f vitest`)
Expected: every file passes -- in particular `persons-read.test.ts`, `person-skills.test.ts`, `catalog-page.test.ts`, `workforce-catalog.test.ts` (integration) and `enum-parity.test.ts` (no schema change, so it must be untouched). A failure in `daemon-cli`'s llm-decision row-count case is the known load flake: re-run that file alone before believing it.

- [ ] **Step 5: Confirm the trailers**

Run: `git log --format='%h %s%n%b' main..HEAD | grep -c 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'`
Expected: one per commit on the branch (`git rev-list --count main..HEAD`). Amend any commit whose trailer differs before review.
