# Catalogue Capability Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every catalogue persona carries a taxonomy-valid capability set: the checked-in taxonomy grows to cover every catalogue division, and a model-assisted pass maps each persona's free-text capability sentences onto it, stored beside (never over) the exact matcher's keys.

**Architecture:** Three new nullable-or-defaulted columns on `SlaveTemplate` hold the model's keys, a staleness hash and a timestamp; `capabilityKeys` becomes the union of the exact matcher's keys and the mapped keys, written by every existing writer plus the new pass. The prompt and the parser are pure functions in `packages/domain`; one control verb runs the pass in batches with the same `ModelDecider` the intake uses; the orchestrator exposes it as `capabilities map` and runs one batch per daemon global pass. Nothing that reads `capabilityKeys` changes.

**Tech Stack:** TypeScript (ESM, `noUncheckedIndexedAccess`), Prisma + Postgres, zod, vitest, Next.js (apps/web), the repository's `ModelDecider` (`packages/control/src/simulation/llm.ts`).

**Spec:** `docs/superpowers/specs/2026-09-20-catalogue-capability-mapping-design.md` — read it first; every task below cites the ruling it implements.

## Global Constraints

- Never write the word "agent" (any case, as a word) in tracked source or docs: `scripts/gate-m26-vocabulary.mjs` fails the build on it. Say "persona", "worker", "workflow orchestration".
- Never name the catalogue's source repository in tracked files (see the seed header's own wording "the reference catalog").
- No prettier in this repository: never run `prettier --write`. Match the surrounding style by hand (2-space, single quotes, no semicolons, trailing commas).
- `normaliseCapabilities` and `normaliseCapabilityText` are NOT changed (spec R2).
- Every new domain row's `role` is its domain name, except `paid-media.*` → `marketing` (spec R1).
- `CAPABILITY_MAP_BATCH_SIZE = 5`, `CAPABILITY_MAP_MAX_KEYS = 8`, `CAPABILITY_MAP_SENTENCE_CAP = 40`, `CAPABILITY_MAP_PER_CALL_CAP_USD = SUPERVISOR_PER_CALL_CAP_USD` (spec R5/R6/§3).
- The answer envelope is exactly `{"personas":[{"id":"<id>","keys":["<key>", …]}, …]}` (spec R5).
- A persona with `profileSpec: null` or with no non-blank capability sentence is never mapped (spec R4).
- No new `EventType`, no new gate (spec R9).
- Tests run against the shared test database: run ONE vitest process at a time. Export the env first: `set -a; . ./.env; set +a`.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, using `git -c core.hooksPath=/dev/null commit` (the pre-push hook runs the full suite on push only; commits are plain).

---

### Task 1: Grow the taxonomy seed (spec R1, §2)

**Files:**
- Modify: `packages/db/src/capabilities.ts` (the `CAPABILITY_SEED` array; keep key ascending)
- Test: `packages/db/test/capabilities.test.ts`

**Interfaces:**
- Consumes: `CapabilityRecord` from `@slave-of-ai/domain` (`{ key, label, domain, role, synonyms }`).
- Produces: 111 seed rows over 29 domains; keys such as `research.competitive`, `operations.ci-cd` (unchanged), `marketing.seo`, `paid-media.search` (role `marketing`).

- [ ] **Step 1: Update the counting test and add the two spot checks**

In `packages/db/test/capabilities.test.ts` change the first test and append two tests at the end of the `describe`:

```ts
  it('is 111 rows over 29 domains', () => {
    expect(CAPABILITY_SEED).toHaveLength(111)
    expect(new Set(CAPABILITY_SEED.map((record) => record.domain)).size).toBe(29)
  })
```

```ts
  // 2026-09-20 catalogue capability mapping, R1: every new domain projects to its own name, and
  // paid media is dispatched as marketing -- the planner never asks for "paid-media" as a role.
  it('projects every new domain to its own name, except paid-media to marketing', () => {
    for (const record of CAPABILITY_SEED) {
      if (record.domain === 'paid-media') expect(record.role, record.key).toBe('marketing')
      else if (['planning', 'review'].includes(record.domain)) continue // manager / reviewer, from M47
      else expect(record.role, record.key).toBe(record.domain)
    }
    expect(CAPABILITY_SEED.some((record) => record.key === 'research.competitive')).toBe(true)
    expect(CAPABILITY_SEED.some((record) => record.key === 'security.privacy')).toBe(true)
  })

  // R2: the exact matcher is unchanged. A persona heading still resolves to nothing by word --
  // that is what the mapping pass exists for -- while a reviewed synonym resolves to one row.
  it('still resolves nothing for a persona heading, and one row for a reviewed synonym', () => {
    expect(normaliseCapabilities(['CI/CD Excellence'], CAPABILITY_SEED)).toEqual({ keys: [], unresolved: ['CI/CD Excellence'] })
    expect(normaliseCapabilities(['competitor analysis'], CAPABILITY_SEED).keys).toEqual(['research.competitive'])
  })
```

- [ ] **Step 2: Run the test file to see it fail**

Run: `set -a; . ./.env; set +a; npx vitest run packages/db/test/capabilities.test.ts`
Expected: FAIL — "is 111 rows over 29 domains" (48 received) and the two new tests.

- [ ] **Step 3: Add the sixty-three rows to `CAPABILITY_SEED`**

Insert each row at its key-ascending position in the array (the whole array stays sorted by `key`; `academic.*` goes first, `ai.*` after it, `business.*` after `backend.*`, and so on). The rows, verbatim:

```ts
  { key: 'academic.methods', label: 'Research methods', domain: 'academic', role: 'academic', synonyms: ['research design', 'study design'] },
  { key: 'academic.teaching', label: 'Teaching and curriculum', domain: 'academic', role: 'academic', synonyms: ['curriculum design', 'instruction'] },
  { key: 'academic.writing', label: 'Academic writing', domain: 'academic', role: 'academic', synonyms: ['paper writing', 'grant writing'] },
  { key: 'ai.evaluation', label: 'Model evaluation', domain: 'ai', role: 'ai', synonyms: ['llm evaluation', 'eval design'] },
  { key: 'ai.llm-integration', label: 'LLM integration', domain: 'ai', role: 'ai', synonyms: ['rag', 'retrieval augmented generation'] },
  { key: 'ai.mcp-tooling', label: 'MCP tooling', domain: 'ai', role: 'ai', synonyms: ['mcp servers', 'tool protocols'] },
  { key: 'ai.prompt-design', label: 'Prompt design', domain: 'ai', role: 'ai', synonyms: ['prompt engineering'] },
  { key: 'ai.workflow-orchestration', label: 'Workflow orchestration', domain: 'ai', role: 'ai', synonyms: ['multi-step automation', 'pipeline orchestration'] },
  { key: 'business.change-management', label: 'Change management', domain: 'business', role: 'business', synonyms: ['organisational change', 'organizational change'] },
  { key: 'business.operations', label: 'Business operations', domain: 'business', role: 'business', synonyms: ['operations management', 'process improvement'] },
  { key: 'business.strategy', label: 'Business strategy', domain: 'business', role: 'business', synonyms: ['corporate strategy', 'strategic planning'] },
  { key: 'finance.budgeting', label: 'Budgeting', domain: 'finance', role: 'finance', synonyms: ['budget planning', 'cost control'] },
  { key: 'finance.modelling', label: 'Financial modelling', domain: 'finance', role: 'finance', synonyms: ['financial modeling', 'forecasting'] },
  { key: 'finance.reporting', label: 'Financial reporting', domain: 'finance', role: 'finance', synonyms: ['accounting', 'bookkeeping'] },
  { key: 'finance.unit-economics', label: 'Unit economics', domain: 'finance', role: 'finance', synonyms: ['cost analysis', 'margin analysis'] },
  { key: 'game-development.art', label: 'Game art and shaders', domain: 'game-development', role: 'game-development', synonyms: ['technical art', 'shader programming'] },
  { key: 'game-development.design', label: 'Game design', domain: 'game-development', role: 'game-development', synonyms: ['level design', 'gameplay design'] },
  { key: 'game-development.economy', label: 'Game economy', domain: 'game-development', role: 'game-development', synonyms: ['monetisation', 'monetization'] },
  { key: 'game-development.engine', label: 'Engine programming', domain: 'game-development', role: 'game-development', synonyms: ['unity', 'unreal'] },
  { key: 'game-development.multiplayer', label: 'Multiplayer and networking', domain: 'game-development', role: 'game-development', synonyms: ['netcode'] },
  { key: 'gis.cartography', label: 'Cartography', domain: 'gis', role: 'gis', synonyms: ['map design'] },
  { key: 'gis.data-management', label: 'Spatial data management', domain: 'gis', role: 'gis', synonyms: ['spatial databases', 'geodata'] },
  { key: 'gis.spatial-analysis', label: 'Spatial analysis', domain: 'gis', role: 'gis', synonyms: ['geospatial analysis', 'geoprocessing'] },
  { key: 'gis.web-mapping', label: 'Web mapping', domain: 'gis', role: 'gis', synonyms: ['map services'] },
  { key: 'healthcare.clinical', label: 'Clinical knowledge', domain: 'healthcare', role: 'healthcare', synonyms: ['clinical workflows'] },
  { key: 'healthcare.compliance', label: 'Healthcare compliance', domain: 'healthcare', role: 'healthcare', synonyms: ['hipaa'] },
  { key: 'healthcare.informatics', label: 'Health informatics', domain: 'healthcare', role: 'healthcare', synonyms: ['medical coding', 'ehr'] },
  { key: 'legal.compliance', label: 'Regulatory compliance', domain: 'legal', role: 'legal', synonyms: ['regulatory affairs'] },
  { key: 'legal.contracts', label: 'Contracts', domain: 'legal', role: 'legal', synonyms: ['contract drafting'] },
  { key: 'legal.document-review', label: 'Legal document review', domain: 'legal', role: 'legal', synonyms: ['due diligence'] },
  { key: 'marketing.brand', label: 'Brand', domain: 'marketing', role: 'marketing', synonyms: ['brand strategy', 'brand identity'] },
  { key: 'marketing.content', label: 'Content marketing', domain: 'marketing', role: 'marketing', synonyms: ['copywriting', 'content strategy'] },
  { key: 'marketing.email', label: 'Email marketing', domain: 'marketing', role: 'marketing', synonyms: ['lifecycle email', 'newsletters'] },
  { key: 'marketing.growth', label: 'Growth and conversion', domain: 'marketing', role: 'marketing', synonyms: ['growth marketing', 'conversion optimisation', 'conversion optimization'] },
  { key: 'marketing.seo', label: 'SEO', domain: 'marketing', role: 'marketing', synonyms: ['search engine optimisation', 'search engine optimization'] },
  { key: 'marketing.social-media', label: 'Social media', domain: 'marketing', role: 'marketing', synonyms: ['social strategy', 'community management'] },
  { key: 'marketing.strategy', label: 'Marketing strategy', domain: 'marketing', role: 'marketing', synonyms: ['go to market', 'positioning'] },
  { key: 'paid-media.programmatic', label: 'Programmatic advertising', domain: 'paid-media', role: 'marketing', synonyms: ['display advertising'] },
  { key: 'paid-media.search', label: 'Paid search', domain: 'paid-media', role: 'marketing', synonyms: ['ppc', 'search ads'] },
  { key: 'paid-media.social', label: 'Paid social', domain: 'paid-media', role: 'marketing', synonyms: ['social ads'] },
  { key: 'people.onboarding', label: 'Onboarding', domain: 'people', role: 'people', synonyms: ['employee onboarding'] },
  { key: 'people.recruiting', label: 'Recruiting', domain: 'people', role: 'people', synonyms: ['talent acquisition', 'hiring'] },
  { key: 'people.training', label: 'Training', domain: 'people', role: 'people', synonyms: ['learning and development', 'corporate training'] },
  { key: 'project-management.agile', label: 'Agile delivery', domain: 'project-management', role: 'project-management', synonyms: ['scrum', 'sprint planning'] },
  { key: 'project-management.delivery', label: 'Delivery management', domain: 'project-management', role: 'project-management', synonyms: ['programme management', 'program management'] },
  { key: 'project-management.risk', label: 'Risk management', domain: 'project-management', role: 'project-management', synonyms: ['risk register'] },
  { key: 'project-management.stakeholders', label: 'Stakeholder management', domain: 'project-management', role: 'project-management', synonyms: ['stakeholder communication'] },
  { key: 'research.academic', label: 'Literature review', domain: 'research', role: 'research', synonyms: ['literature search'] },
  { key: 'research.competitive', label: 'Competitive analysis', domain: 'research', role: 'research', synonyms: ['competitor analysis', 'competitive intelligence'] },
  { key: 'research.desk', label: 'Desk research', domain: 'research', role: 'research', synonyms: ['secondary research', 'research synthesis'] },
  { key: 'research.market', label: 'Market research', domain: 'research', role: 'research', synonyms: ['market analysis', 'market sizing'] },
  { key: 'sales.account-management', label: 'Account management', domain: 'sales', role: 'sales', synonyms: ['customer accounts', 'renewals'] },
  { key: 'sales.enablement', label: 'Sales enablement', domain: 'sales', role: 'sales', synonyms: ['sales playbook', 'objection handling'] },
  { key: 'sales.outbound', label: 'Outbound sales', domain: 'sales', role: 'sales', synonyms: ['prospecting', 'outreach'] },
  { key: 'sales.pricing', label: 'Pricing and packaging', domain: 'sales', role: 'sales', synonyms: ['pricing strategy'] },
  { key: 'sales.strategy', label: 'Sales strategy', domain: 'sales', role: 'sales', synonyms: ['sales planning', 'pipeline strategy'] },
  { key: 'security.compliance', label: 'Security compliance', domain: 'security', role: 'security', synonyms: ['soc 2', 'audit readiness', 'compliance automation'] },
  { key: 'security.privacy', label: 'Data privacy', domain: 'security', role: 'security', synonyms: ['gdpr', 'privacy engineering'] },
  { key: 'spatial-computing.3d-interaction', label: '3D interaction', domain: 'spatial-computing', role: 'spatial-computing', synonyms: ['spatial interfaces'] },
  { key: 'spatial-computing.xr', label: 'AR and VR', domain: 'spatial-computing', role: 'spatial-computing', synonyms: ['augmented reality', 'virtual reality', 'mixed reality'] },
  { key: 'support.customer', label: 'Customer support', domain: 'support', role: 'support', synonyms: ['helpdesk', 'customer service'] },
  { key: 'support.knowledge-base', label: 'Knowledge base', domain: 'support', role: 'support', synonyms: ['help centre', 'help center'] },
  { key: 'support.success', label: 'Customer success', domain: 'support', role: 'support', synonyms: ['customer onboarding', 'retention'] },
```

Also amend the file's header comment: after the paragraph about the 279 templates and 4,003 unresolved values, add one paragraph: "2026-09-20 (catalogue capability mapping, R1): the seed grew from 48 rows over 13 domains to 111 over 29 so every division of the catalogue has rows to be mapped onto; the semantic mapping itself is a model pass (`capabilities map`), not a synonym, and the matching rule above is unchanged."

- [ ] **Step 4: Run the seed test and the capability domain tests**

Run: `set -a; . ./.env; set +a; npx vitest run packages/db/test/capabilities.test.ts packages/domain/test/capability`
Expected: PASS. If "shares no normalised spelling between two rows" fails, the failing pair is printed — rename the synonym on the NEW row (never the old one) and re-run.

- [ ] **Step 5: Build, then run the control tests that load the taxonomy**

Run: `set -a; . ./.env; set +a; npx tsc --build && npx vitest run packages/control/test/integration/capability.test.ts packages/control/test/integration/capabilityReconcile.test.ts packages/control/test/integration/catalog.test.ts`
Expected: PASS (these seed the table with `syncCapabilityTaxonomy()`; a hard-coded "48" anywhere in them must be replaced by `CAPABILITY_SEED.length`).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/capabilities.ts packages/db/test/capabilities.test.ts packages/control/test
git -c core.hooksPath=/dev/null commit -m "feat(db): grow the capability taxonomy to every catalogue division (111 rows, 29 domains)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The three mapping columns (spec R3)

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (model `SlaveTemplate`, beside `capabilityKeys` at ~line 481)
- Create: `packages/db/prisma/migrations/20260920100000_capability_mapping/migration.sql`

**Interfaces:**
- Produces: `SlaveTemplate.mappedCapabilityKeys: string[]`, `SlaveTemplate.capabilityMappingHash: string | null`, `SlaveTemplate.capabilityMappedAt: Date | null` on the Prisma client.

- [ ] **Step 1: Add the columns to the schema**

Directly after the `unresolvedCapabilities String[] @default([])` line in `model SlaveTemplate`:

```prisma
  /// 2026-09-20 catalogue capability mapping, R3: the keys a MODEL chose for this persona from
  /// the taxonomy, kept apart from the exact matcher's keys so a reconcile can re-run the matcher
  /// without losing them and a drawer can say which is which. `capabilityKeys` above is the
  /// EFFECTIVE set -- the union of both -- and stays the one column every reader reads.
  mappedCapabilityKeys   String[]  @default([])
  /// R4: SHA-256 of the persona's capability sentences, summary, identity and the taxonomy's key
  /// list at the time of mapping. Differs from the freshly computed value == stale == mapped
  /// again on the next pass. Null == never mapped.
  capabilityMappingHash  String?
  capabilityMappedAt     DateTime?
```

- [ ] **Step 2: Write the migration by hand**

`packages/db/prisma/migrations/20260920100000_capability_mapping/migration.sql`:

```sql
-- Catalogue capability mapping (2026-09-20), R3: a model-chosen capability set beside the exact
-- matcher's, with the hash that says whether it is stale.
--
-- `capabilityKeys` keeps its meaning for every reader (the scheduler's projection, formTeam, the
-- catalogue filter, the person pool): it becomes the UNION of the exact matcher's keys and
-- `mappedCapabilityKeys`, written by every writer of the column. Keeping the model's half in its
-- own column is what lets `capabilities reconcile` re-derive the exact half without erasing the
-- mapped one, and what lets the drawer mark a chip as matched or mapped.
--
-- No backfill: no row has been mapped yet, so an empty array and a null hash IS the history.
ALTER TABLE "SlaveTemplate" ADD COLUMN "mappedCapabilityKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SlaveTemplate" ADD COLUMN "capabilityMappingHash" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "capabilityMappedAt" TIMESTAMP(3);
```

- [ ] **Step 3: Apply to the test database and regenerate the client**

Run: `set -a; . ./.env; set +a; npm run db:migrate:test && npm run db:generate && npx tsc --build`
Expected: the migration applies, `prisma generate` succeeds, the build is green. (The development database is migrated by the operator with `npm run db:migrate`; do NOT run it against a database you were not told to.)

- [ ] **Step 4: Prove the columns exist**

Run: `set -a; . ./.env; set +a; npx vitest run packages/control/test/integration/capabilityReconcile.test.ts`
Expected: PASS (unchanged behaviour; confirms the client and the test schema agree).

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260920100000_capability_mapping
git -c core.hooksPath=/dev/null commit -m "feat(db): mappedCapabilityKeys, capabilityMappingHash and capabilityMappedAt on SlaveTemplate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The prompt, the parser and the hash (spec R4, R5, §3)

**Files:**
- Create: `packages/domain/src/capability/mapping.ts`
- Modify: `packages/domain/src/capability/index.ts` (add `export * from './mapping.js'`)
- Test: `packages/domain/test/capability/mapping.test.ts`

**Interfaces:**
- Consumes: `CapabilityRecord`, `CapabilityKey`, `normaliseCapabilityText` from `./taxonomy.js`; `firstJsonObject` from `../supervisor/prompt.js`; `SUPERVISOR_PER_CALL_CAP_USD` from `../supervisor/constants.js`; `goalSha256` from `../goal/version.js`.
- Produces (all exported from `@slave-of-ai/domain`):
  - `CAPABILITY_MAP_BATCH_SIZE = 5`, `CAPABILITY_MAP_MAX_KEYS = 8`, `CAPABILITY_MAP_SENTENCE_CAP = 40`, `CAPABILITY_MAP_PER_CALL_CAP_USD`, `CAPABILITY_MAP_ANSWER_MARKER = '"personas"'`
  - `interface CapabilityMappingPersona { readonly id: string; readonly name: string; readonly runtimeRole: string; readonly summary: string; readonly identity: string; readonly capabilities: readonly string[] }`
  - `capabilityMappingHash(persona: Pick<CapabilityMappingPersona, 'summary' | 'identity' | 'capabilities'>, taxonomy: readonly CapabilityRecord[]): string`
  - `mappableSentences(capabilities: readonly string[]): readonly string[]` — trimmed, non-blank (by `normaliseCapabilityText`), first `CAPABILITY_MAP_SENTENCE_CAP`.
  - `buildCapabilityMappingPrompt(batch: readonly CapabilityMappingPersona[], taxonomy: readonly CapabilityRecord[]): string`
  - `interface CapabilityMappingResult { readonly id: string; readonly keys: readonly CapabilityKey[]; readonly dropped: readonly string[] }`
  - `parseCapabilityMappingAnswer(text: string, batch: readonly CapabilityMappingPersona[], taxonomy: readonly CapabilityRecord[]): readonly CapabilityMappingResult[] | null`

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/capability/mapping.test.ts`:

```ts
import {
  CAPABILITY_MAP_ANSWER_MARKER,
  CAPABILITY_MAP_MAX_KEYS,
  CAPABILITY_MAP_SENTENCE_CAP,
  buildCapabilityMappingPrompt,
  capabilityMappingHash,
  mappableSentences,
  parseCapabilityMappingAnswer,
  type CapabilityMappingPersona,
  type CapabilityRecord,
} from '@slave-of-ai/domain'
import { describe, expect, it } from 'vitest'

const taxonomy: readonly CapabilityRecord[] = [
  { key: 'marketing.seo', label: 'SEO', domain: 'marketing', role: 'marketing', synonyms: ['search engine optimisation'] },
  { key: 'operations.ci-cd', label: 'CI and CD', domain: 'operations', role: 'operations', synonyms: ['ci/cd'] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'qa', synonyms: ['e2e testing'] },
]

const devops: CapabilityMappingPersona = {
  id: 't-devops',
  name: 'DevOps Automator',
  runtimeRole: 'engineering',
  summary: 'Expert DevOps engineer specializing in infrastructure automation',
  identity: 'Infrastructure automation and deployment pipeline specialist',
  capabilities: ['CI/CD Excellence', 'Observability Expertise', '  ', 'Advanced testing automation including chaos engineering'],
}
const seo: CapabilityMappingPersona = {
  id: 't-seo',
  name: 'SEO Strategist',
  runtimeRole: 'marketing',
  summary: 'Grows organic traffic',
  identity: 'Search-first marketer',
  capabilities: ['Technical SEO audits', 'Keyword strategy'],
}

const answer = (personas: unknown): string => `Here you go:\n${JSON.stringify({ personas })}\nDone.`

describe('buildCapabilityMappingPrompt', () => {
  it('names every persona id and every taxonomy key once, and no synonym', () => {
    const prompt = buildCapabilityMappingPrompt([devops, seo], taxonomy)
    expect(prompt.split('t-devops')).toHaveLength(2)
    expect(prompt.split('t-seo')).toHaveLength(2)
    for (const record of taxonomy) expect(prompt.split(record.key)).toHaveLength(2)
    expect(prompt).not.toContain('search engine optimisation')
    expect(prompt).toContain(CAPABILITY_MAP_ANSWER_MARKER)
    expect(prompt).toContain(String(CAPABILITY_MAP_MAX_KEYS))
  })

  it('carries the persona sentences, trimmed and capped, and drops blanks', () => {
    const many = { ...seo, capabilities: Array.from({ length: CAPABILITY_MAP_SENTENCE_CAP + 5 }, (_, i) => `Sentence ${String(i)}`) }
    const prompt = buildCapabilityMappingPrompt([devops, many], taxonomy)
    expect(prompt).toContain('- CI/CD Excellence')
    expect(prompt).not.toContain('-   \n')
    expect(prompt).toContain(`Sentence ${String(CAPABILITY_MAP_SENTENCE_CAP - 1)}`)
    expect(prompt).not.toContain(`Sentence ${String(CAPABILITY_MAP_SENTENCE_CAP)}`)
  })
})

describe('mappableSentences', () => {
  it('trims, drops blanks and caps', () => {
    expect(mappableSentences(['  a ', '', '   ', 'b'])).toEqual(['a', 'b'])
    expect(mappableSentences(Array.from({ length: 50 }, (_, i) => String(i)))).toHaveLength(CAPABILITY_MAP_SENTENCE_CAP)
  })
})

describe('capabilityMappingHash', () => {
  it('is stable for the same persona and taxonomy, and moves when either changes', () => {
    const a = capabilityMappingHash(devops, taxonomy)
    expect(capabilityMappingHash({ ...devops, capabilities: [...devops.capabilities] }, taxonomy)).toBe(a)
    expect(capabilityMappingHash({ ...devops, summary: 'changed' }, taxonomy)).not.toBe(a)
    expect(capabilityMappingHash(devops, taxonomy.slice(1))).not.toBe(a)
    // Synonyms and labels are not in the hash: a relabel does not re-spend a call.
    expect(capabilityMappingHash(devops, taxonomy.map((r) => ({ ...r, label: r.label.toUpperCase(), synonyms: [] })))).toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('parseCapabilityMappingAnswer', () => {
  it('accepts the envelope, keeps only taxonomy keys, deduplicates and reports the rest', () => {
    const parsed = parseCapabilityMappingAnswer(
      answer([{ id: 't-devops', keys: ['operations.ci-cd', 'qa.test-automation', 'operations.ci-cd', 'made.up'] }]),
      [devops],
      taxonomy,
    )
    expect(parsed).toEqual([{ id: 't-devops', keys: ['operations.ci-cd', 'qa.test-automation'], dropped: ['made.up'] }])
  })

  it('truncates to the maximum, most central first', () => {
    const big = taxonomy.map((r) => r.key)
    const extra = Array.from({ length: CAPABILITY_MAP_MAX_KEYS + 3 }, (_, i) => ({ key: `x.k${String(i)}`, label: `K${String(i)}`, domain: 'x', role: 'x', synonyms: [] }))
    const wide = [...taxonomy, ...extra]
    const keys = [...big, ...extra.map((r) => r.key)]
    const parsed = parseCapabilityMappingAnswer(answer([{ id: 't-seo', keys }]), [seo], wide)
    expect(parsed?.[0]?.keys).toEqual(keys.slice(0, CAPABILITY_MAP_MAX_KEYS))
  })

  it('leaves an unmentioned persona absent, and keeps an empty answer as empty', () => {
    const parsed = parseCapabilityMappingAnswer(answer([{ id: 't-seo', keys: [] }]), [devops, seo], taxonomy)
    expect(parsed).toEqual([{ id: 't-seo', keys: [], dropped: [] }])
  })

  it('ignores an id that is not in the batch and a malformed entry', () => {
    const parsed = parseCapabilityMappingAnswer(
      answer([{ id: 'stranger', keys: ['marketing.seo'] }, { id: 't-seo', keys: 'marketing.seo' }, { id: 't-devops', keys: ['marketing.seo'] }]),
      [devops, seo],
      taxonomy,
    )
    expect(parsed).toEqual([{ id: 't-devops', keys: ['marketing.seo'], dropped: [] }])
  })

  it('returns null when there is no JSON object or the envelope is wrong', () => {
    expect(parseCapabilityMappingAnswer('no json here', [seo], taxonomy)).toBeNull()
    expect(parseCapabilityMappingAnswer('{"nope": []}', [seo], taxonomy)).toBeNull()
    expect(parseCapabilityMappingAnswer('{"personas": "x"}', [seo], taxonomy)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `set -a; . ./.env; set +a; npx vitest run packages/domain/test/capability/mapping.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `packages/domain/src/capability/mapping.ts`**

```ts
import { z } from 'zod'
import { goalSha256 } from '../goal/version.js'
import { SUPERVISOR_PER_CALL_CAP_USD } from '../supervisor/constants.js'
import { firstJsonObject } from '../supervisor/prompt.js'
import { normaliseCapabilityText, type CapabilityKey, type CapabilityRecord } from './taxonomy.js'

/**
 * Catalogue capability mapping (2026-09-20), R5 and §3: the prompt a model is given to map a
 * persona's free-text capability sentences onto the taxonomy, and the parser for its answer.
 *
 * PURE. Nothing here reads a database or spawns a process; the control verb that calls the model
 * (`packages/control/src/capabilityMapping.ts`) passes the taxonomy and the personas in, so the
 * whole contract is testable with fixture strings. The exact matcher (`normaliseCapabilities`) is
 * untouched (R2): this is a SECOND source of keys, kept apart by the control layer.
 */

/** How many personas one call is shown. Five keeps a call well under the per-call cap on the
 *  default model with the full taxonomy in the prompt (§3). */
export const CAPABILITY_MAP_BATCH_SIZE = 5
/** The most keys the parser keeps per persona. A persona that "does everything" is a persona the
 *  staffing rank cannot tell apart from anybody; eight is the point past which a list stops
 *  describing a specialist. The prompt says "most central first" so the cut keeps the right ones. */
export const CAPABILITY_MAP_MAX_KEYS = 8
/** How many sentences of one persona are shown -- the live catalogue's own maximum (R4/§3). */
export const CAPABILITY_MAP_SENTENCE_CAP = 40
/** The same cap the intake and the Supervisor use, and for the same reason (R6). */
export const CAPABILITY_MAP_PER_CALL_CAP_USD = SUPERVISOR_PER_CALL_CAP_USD
/** The envelope's key, quoted -- the prompt asks for it and the fake CLI keys on it. */
export const CAPABILITY_MAP_ANSWER_MARKER = '"personas"'

export interface CapabilityMappingPersona {
  readonly id: string
  readonly name: string
  readonly runtimeRole: string
  readonly summary: string
  readonly identity: string
  readonly capabilities: readonly string[]
}

export interface CapabilityMappingResult {
  readonly id: string
  /** Taxonomy keys only, deduplicated, at most {@link CAPABILITY_MAP_MAX_KEYS}, in the answer's order. */
  readonly keys: readonly CapabilityKey[]
  /** Strings the answer offered that are not keys of this taxonomy, for the report. */
  readonly dropped: readonly string[]
}

/** The sentences the model is shown: trimmed, blanks dropped, capped (R4/§3). */
export function mappableSentences(capabilities: readonly string[]): readonly string[] {
  const kept: string[] = []
  for (const value of capabilities) {
    if (normaliseCapabilityText(value) === '') continue
    kept.push(value.trim())
    if (kept.length === CAPABILITY_MAP_SENTENCE_CAP) break
  }
  return kept
}

/**
 * R4: what decides "stale". The sentences (as shown), the summary, the identity and the
 * taxonomy's KEYS, key ascending. Labels and synonyms are deliberately absent -- the model maps
 * meaning against keys and their labels, but a relabel is not a reason to spend a call again;
 * a new KEY is, because it exists to be mapped onto.
 */
export function capabilityMappingHash(
  persona: Pick<CapabilityMappingPersona, 'summary' | 'identity' | 'capabilities'>,
  taxonomy: readonly CapabilityRecord[],
): string {
  const keys = taxonomy.map((record) => record.key).toSorted()
  const canonical = JSON.stringify({
    capabilities: mappableSentences(persona.capabilities),
    summary: persona.summary.trim(),
    identity: persona.identity.trim(),
    keys,
  })
  return goalSha256(canonical)
}

export function buildCapabilityMappingPrompt(
  batch: readonly CapabilityMappingPersona[],
  taxonomy: readonly CapabilityRecord[],
): string {
  const blocks: string[] = [
    'You are classifying personas for a company of specialists whose work is matched to tasks by',
    'CAPABILITY KEYS. A key names one thing a specialist can be asked to do. The list of keys is',
    'closed: choose from it and only from it.',
    '',
    'THE KEYS (key — label (domain)):',
    ...taxonomy.map((record) => `- ${record.key} — ${record.label} (${record.domain})`),
    '',
    'THE PERSONAS:',
  ]
  for (const persona of batch) {
    blocks.push(
      '',
      `persona id: ${persona.id}`,
      `name: ${persona.name}`,
      `runtime role given by the catalogue: ${persona.runtimeRole}`,
      `summary: ${persona.summary.trim()}`,
      `identity: ${persona.identity.trim()}`,
      'capability sentences:',
      ...mappableSentences(persona.capabilities).map((sentence) => `- ${sentence}`),
    )
  }
  blocks.push(
    '',
    'INSTRUCTIONS:',
    `- For each persona choose at most ${String(CAPABILITY_MAP_MAX_KEYS)} keys, the most central first.`,
    '- Choose only keys from THE KEYS above. Never invent a key. Never rename one.',
    '- An empty list is a valid answer when nothing in the list fits.',
    '- Answer with ONE JSON object and nothing else, in exactly this shape:',
    `  {${CAPABILITY_MAP_ANSWER_MARKER}:[{"id":"<persona id>","keys":["<key>", "<key>"]}]}`,
    '- Include every persona id above exactly once.',
  )
  return blocks.join('\n')
}

const envelopeSchema = z.object({
  personas: z.array(z.unknown()),
})
const entrySchema = z.object({
  id: z.string().min(1),
  keys: z.array(z.string()),
})

/**
 * R5: the first JSON object in the text, the envelope, then per persona the keys that ARE keys.
 * A persona the answer does not mention, or mentions malformed, is ABSENT from the result -- not
 * empty -- because "no answer" and "nothing applies" are different facts to the caller: absent is
 * retried on the next pass, empty is recorded.
 */
export function parseCapabilityMappingAnswer(
  text: string,
  batch: readonly CapabilityMappingPersona[],
  taxonomy: readonly CapabilityRecord[],
): readonly CapabilityMappingResult[] | null {
  const source = firstJsonObject(text)
  if (source === null) return null
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  const envelope = envelopeSchema.safeParse(value)
  if (!envelope.success) return null

  const known = new Set<string>(taxonomy.map((record) => record.key))
  const inBatch = new Set(batch.map((persona) => persona.id))
  const results: CapabilityMappingResult[] = []
  const seen = new Set<string>()
  for (const raw of envelope.data.personas) {
    const entry = entrySchema.safeParse(raw)
    if (!entry.success) continue
    if (!inBatch.has(entry.data.id) || seen.has(entry.data.id)) continue
    seen.add(entry.data.id)
    const keys: CapabilityKey[] = []
    const dropped: string[] = []
    for (const candidate of entry.data.keys) {
      const key = candidate.trim()
      if (!known.has(key)) {
        if (key !== '' && !dropped.includes(key)) dropped.push(key)
        continue
      }
      if (keys.includes(key as CapabilityKey)) continue
      if (keys.length < CAPABILITY_MAP_MAX_KEYS) keys.push(key as CapabilityKey)
    }
    results.push({ id: entry.data.id, keys, dropped })
  }
  return results
}
```

Add `export * from './mapping.js'` to `packages/domain/src/capability/index.ts`. If `CapabilityKey` is a branded type in `taxonomy.ts`, use its brand helper instead of `as CapabilityKey` (check how `normaliseCapabilities` builds `keys` and copy that).

- [ ] **Step 4: Run the tests to see them pass**

Run: `set -a; . ./.env; set +a; npx tsc --build && npx vitest run packages/domain/test/capability/mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/capability/mapping.ts packages/domain/src/capability/index.ts packages/domain/test/capability/mapping.test.ts
git -c core.hooksPath=/dev/null commit -m "feat(domain): capability mapping prompt, parser and staleness hash

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The effective set — every writer of `capabilityKeys` writes the union (spec R3, R6)

**Files:**
- Modify: `packages/control/src/capability.ts` (`reconcileTemplateCapabilities`, ~lines 149–200; add `effectiveCapabilityKeys`)
- Modify: `packages/control/src/catalog.ts` (the three write sites at ~`:521`, `:613`, `:675`; the `existing` row select must include `mappedCapabilityKeys`)
- Test: `packages/control/test/integration/capabilityReconcile.test.ts` (two new cases), `packages/control/test/integration/catalog.test.ts` (one new case)

**Interfaces:**
- Produces: `export function effectiveCapabilityKeys(exact: readonly string[], mapped: readonly string[]): string[]` in `packages/control/src/capability.ts` — union, deduplicated, key ascending. Exported from the control barrel (`packages/control/src/index.ts` already `export * from './capability.js'`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/control/test/integration/capabilityReconcile.test.ts` inside the `describe`:

```ts
  it('keeps a model-mapped key in capabilityKeys when it re-derives the exact half (mapping R3)', async (): Promise<void> => {
    const id = await structuredTemplate('Mapped Persona', ['CI/CD Excellence'], { capabilityKeys: [] })
    await prisma.slaveTemplate.update({
      where: { id },
      data: { mappedCapabilityKeys: ['operations.ci-cd'], capabilityMappingHash: 'h', capabilityMappedAt: new Date() },
    })

    const report = await reconcileTemplateCapabilities()

    expect(report.updated).toBe(1)
    const row = await templateRow(id)
    expect(row.capabilityKeys).toEqual(['operations.ci-cd'])
    // R2: the exact matcher still reports the sentence as unresolved by word.
    expect(row.unresolvedCapabilities).toEqual(['CI/CD Excellence'])
  })

  it('writes the union key ascending, with the exact half and the mapped half deduplicated', async (): Promise<void> => {
    const id = await structuredTemplate('Both Halves', ['ci/cd', 'monitoring'], { capabilityKeys: [] })
    await prisma.slaveTemplate.update({
      where: { id },
      data: { mappedCapabilityKeys: ['qa.test-automation', 'operations.ci-cd'], capabilityMappingHash: 'h' },
    })

    await reconcileTemplateCapabilities()

    expect((await templateRow(id)).capabilityKeys).toEqual(['operations.ci-cd', 'operations.observability', 'qa.test-automation'])
  })
```

Append to `packages/control/test/integration/catalog.test.ts` inside `describe('importCatalog', …)`, after the existing "updated" cases (look for `structured('core-builder', 'Core Builder')` at ~line 508 for the helper that yields a changed file):

```ts
  it('keeps the mapped keys and the hash when a persona file changes (mapping R6)', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')])
    const before = await prisma.slaveTemplate.findUniqueOrThrow({ where: { name: 'Core Builder' } })
    await prisma.slaveTemplate.update({
      where: { id: before.id },
      data: { mappedCapabilityKeys: ['backend.services'], capabilityMappingHash: 'stale-or-not', capabilityMappedAt: new Date() },
    })

    await importOne([entry('core-builder', 'Core Builder', 'A different body entirely.')])

    const after = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: before.id } })
    expect(after.mappedCapabilityKeys).toEqual(['backend.services'])
    expect(after.capabilityMappingHash).toBe('stale-or-not')
    expect(after.capabilityKeys).toContain('backend.services')
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `set -a; . ./.env; set +a; npx vitest run packages/control/test/integration/capabilityReconcile.test.ts packages/control/test/integration/catalog.test.ts`
Expected: the three new cases FAIL (reconcile writes `[]`; import writes the exact half only).

- [ ] **Step 3: Add `effectiveCapabilityKeys` and use it in reconcile**

In `packages/control/src/capability.ts`, near `sameStringSet` (~line 94):

```ts
/**
 * Catalogue capability mapping (2026-09-20), R3: the EFFECTIVE capability set of a template --
 * what the exact matcher found by word, plus what a model mapped -- deduplicated and key
 * ascending, so two writers producing the same set produce the same array. Every writer of
 * `SlaveTemplate.capabilityKeys` goes through this: the three import sites, the reconcile pass and
 * the mapping pass. Readers keep reading `capabilityKeys` and see both halves.
 */
export function effectiveCapabilityKeys(exact: readonly string[], mapped: readonly string[]): string[] {
  return [...new Set([...exact, ...mapped])].toSorted()
}
```

In `reconcileTemplateCapabilities`, add `mappedCapabilityKeys: true` to the `select`, then replace the comparison and the write:

```ts
    const effective = effectiveCapabilityKeys(keys, row.mappedCapabilityKeys)
    if (sameStringSet(row.capabilityKeys, effective) && sameStringSet(row.unresolvedCapabilities, unresolved)) continue
    await prisma.slaveTemplate.update({
      where: { id: row.id },
      data: { capabilityKeys: effective, unresolvedCapabilities: [...unresolved] },
    })
```

- [ ] **Step 4: Write the union at the three import sites**

In `packages/control/src/catalog.ts`:
- Site (a), the `create` at ~`:521`: `capabilityKeys: effectiveCapabilityKeys(capabilityKeys, [])` (a new row has no mapping yet; leave `mappedCapabilityKeys` at its default).
- Sites (b) ~`:613` and (c) ~`:675`, both `update`s of `existing`: `capabilityKeys: effectiveCapabilityKeys(capabilityKeys, existing.mappedCapabilityKeys)`. Find where `existing` is read in the transaction (the `findUnique`/`findFirst` above the branch) and add `mappedCapabilityKeys: true` to its `select` if it has one; if it selects the whole row, nothing to add.
- Do NOT write `capabilityMappingHash` or `capabilityMappedAt` at any site (R6: the next pass's hash comparison decides).
- Import `effectiveCapabilityKeys` from `./capability.js`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `set -a; . ./.env; set +a; npx tsc --build && npx vitest run packages/control/test/integration/capabilityReconcile.test.ts packages/control/test/integration/catalog.test.ts packages/control/test/integration/capability.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/control/src/capability.ts packages/control/src/catalog.ts packages/control/test/integration/capabilityReconcile.test.ts packages/control/test/integration/catalog.test.ts
git -c core.hooksPath=/dev/null commit -m "feat(control): capabilityKeys is the union of the exact and the mapped halves at every writer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The mapping pass (spec R4, R6)

**Files:**
- Create: `packages/control/src/capabilityMapping.ts`
- Modify: `packages/control/src/index.ts` (add `export * from './capabilityMapping.js'`)
- Test: `packages/control/test/integration/capability-mapping.test.ts`

**Interfaces:**
- Consumes: `ModelDecider` from `./simulation/llm.js`; `effectiveCapabilityKeys` (Task 4); `listCapabilities` from `./capability.js`; `syncPersonPool`, `PersonPoolSyncReport` from `./personPool.js`; `profileSpecSchema` from `@slave-of-ai/domain`; Task 3's domain functions.
- Produces:

```ts
export interface MapTemplateCapabilitiesInput {
  readonly decider: ModelDecider
  readonly model: string
  readonly only: 'stale' | 'all'
  readonly dryRun: boolean
  readonly batchSize?: number
  readonly maxBatches?: number
  readonly maxBudgetUsdPerCall?: number
}
export interface CapabilityMappingRow {
  readonly templateId: string
  readonly name: string
  readonly keys: readonly string[]
  readonly dropped: readonly string[]
}
export interface CapabilityMappingReport {
  readonly considered: number      // templates that COULD be mapped (structured, with sentences)
  readonly stale: number           // of those, stale (or all of them under only: 'all')
  readonly calls: number
  readonly mapped: number          // rows written (or, dryRun, rows that would be)
  readonly unchanged: number       // present in the answer, same set as stored
  readonly absent: number          // in a batch, not in its answer
  readonly failedBatches: number   // null parse, isolation_breach, failure
  readonly droppedKeys: number
  readonly costUsd: number
  readonly unmeasuredCalls: number
  readonly rows: readonly CapabilityMappingRow[]  // every persona the pass wrote or would write
  readonly pool: PersonPoolSyncReport | null      // null when dryRun or nothing was written
}
export async function mapTemplateCapabilities(input: MapTemplateCapabilitiesInput): Promise<CapabilityMappingReport>
export async function countStaleTemplateMappings(): Promise<{ readonly considered: number; readonly stale: number }>
```

- [ ] **Step 1: Write the failing tests**

`packages/control/test/integration/capability-mapping.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import {
  CAPABILITY_MAP_ANSWER_MARKER,
  CAPABILITY_MAP_PER_CALL_CAP_USD,
  emptyProfileSpec,
  type ProfileSpec,
} from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { reconcileTemplateCapabilities, syncCapabilityTaxonomy, addCapability } from '../../src/capability.js'
import { countStaleTemplateMappings, mapTemplateCapabilities } from '../../src/capabilityMapping.js'
import { syncPersonPool } from '../../src/personPool.js'
import type { ModelDecider, ModelOutcome } from '../../src/simulation/llm.js'

const TRUNCATE = 'TRUNCATE TABLE "Slave", "Team", "Workspace", "Person", "SlaveTemplate" RESTART IDENTITY CASCADE'

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(TRUNCATE)
  await prisma.capability.deleteMany({ where: { createdBy: { not: 'seed' } } })
  await syncCapabilityTaxonomy()
})

const specWith = (capabilities: readonly string[], summary = 'A specialist.'): ProfileSpec => ({
  ...emptyProfileSpec(),
  summary,
  identity: 'Someone who does one thing well.',
  capabilities,
})

const structured = async (name: string, capabilities: readonly string[], active = true): Promise<string> =>
  (
    await prisma.slaveTemplate.create({
      data: { name, role: 'engineering', description: `${name}.`, active, profileSpec: specWith(capabilities) as unknown as object },
    })
  ).id

/** A decider that answers from a map of persona NAME -> keys, and records every call. */
function scripted(byName: Record<string, readonly string[]>, outcome?: ModelOutcome): ModelDecider & { calls: string[] } {
  const calls: string[] = []
  const decider: ModelDecider = async (input) => {
    calls.push(input.prompt)
    if (outcome !== undefined) return outcome
    // The prompt carries `persona id: <id>` and `name: <name>` lines in order; answer for each.
    const ids = [...input.prompt.matchAll(/^persona id: (.+)$/gmu)].map((m) => m[1] as string)
    const names = [...input.prompt.matchAll(/^name: (.+)$/gmu)].map((m) => m[1] as string)
    const personas = ids.flatMap((id, i) => {
      const keys = byName[names[i] as string]
      return keys === undefined ? [] : [{ id, keys }]
    })
    return { kind: 'answer', text: `sure\n${JSON.stringify({ personas })}`, costUsd: 0.05, tokens: null, numTurns: 1 }
  }
  return Object.assign(decider, { calls })
}

describe('mapTemplateCapabilities', () => {
  it('maps a stale template, writes the union, stamps the hash, and syncs the pool', async (): Promise<void> => {
    const id = await structured('DevOps Automator', ['CI/CD Excellence', 'Observability Expertise'])
    const decider = scripted({ 'DevOps Automator': ['operations.ci-cd', 'operations.observability', 'made.up'] })

    const report = await mapTemplateCapabilities({ decider, model: 'claude-sonnet-5', only: 'stale', dryRun: false })

    expect(report).toMatchObject({ considered: 1, stale: 1, calls: 1, mapped: 1, absent: 0, failedBatches: 0, droppedKeys: 1 })
    expect(report.costUsd).toBeCloseTo(0.05)
    expect(report.pool).not.toBeNull()
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.mappedCapabilityKeys).toEqual(['operations.ci-cd', 'operations.observability'])
    expect(row.capabilityKeys).toEqual(['operations.ci-cd', 'operations.observability'])
    expect(row.capabilityMappingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.capabilityMappedAt).not.toBeNull()
    expect(decider.calls[0]).toContain(CAPABILITY_MAP_ANSWER_MARKER)
  })

  it('asks with the per-call cap and the model it was given', async (): Promise<void> => {
    await structured('One', ['a thing'])
    let seen: { maxBudgetUsd: number; model: string } | null = null
    const decider: ModelDecider = async (input) => {
      seen = { maxBudgetUsd: input.maxBudgetUsd, model: input.model }
      return { kind: 'answer', text: '{"personas":[]}', costUsd: 0.01, tokens: null, numTurns: 1 }
    }
    await mapTemplateCapabilities({ decider, model: 'claude-sonnet-5', only: 'stale', dryRun: false })
    expect(seen).toEqual({ maxBudgetUsd: CAPABILITY_MAP_PER_CALL_CAP_USD, model: 'claude-sonnet-5' })
  })

  it('skips a fresh template and makes no call; only: all re-calls it', async (): Promise<void> => {
    await structured('Fresh', ['x'])
    const first = scripted({ Fresh: ['qa.test-automation'] })
    await mapTemplateCapabilities({ decider: first, model: 'm', only: 'stale', dryRun: false })
    expect(first.calls).toHaveLength(1)

    const second = scripted({ Fresh: ['qa.test-automation'] })
    const report = await mapTemplateCapabilities({ decider: second, model: 'm', only: 'stale', dryRun: false })
    expect(second.calls).toHaveLength(0)
    expect(report).toMatchObject({ considered: 1, stale: 0, calls: 0 })

    const third = scripted({ Fresh: ['qa.test-automation'] })
    const again = await mapTemplateCapabilities({ decider: third, model: 'm', only: 'all', dryRun: false })
    expect(third.calls).toHaveLength(1)
    expect(again).toMatchObject({ calls: 1, mapped: 0, unchanged: 1 })
  })

  it('becomes stale again when a taxonomy key is added (R4)', async (): Promise<void> => {
    await structured('Later', ['x'])
    await mapTemplateCapabilities({ decider: scripted({ Later: [] }), model: 'm', only: 'stale', dryRun: false })
    expect((await countStaleTemplateMappings()).stale).toBe(0)
    const added = await addCapability({ key: 'custom.thing', label: 'A thing', role: 'backend' })
    expect(added.ok).toBe(true)
    expect((await countStaleTemplateMappings()).stale).toBe(1)
  })

  it('leaves rows untouched on a null answer, an isolation breach or a failure, and counts the batch', async (): Promise<void> => {
    const id = await structured('Untouched', ['x'])
    for (const outcome of [
      { kind: 'answer', text: 'no json', costUsd: 0.01, tokens: null, numTurns: 1 },
      { kind: 'isolation_breach', tools: ['Bash'], costUsd: 0.01, tokens: null },
    ] as const) {
      const report = await mapTemplateCapabilities({ decider: scripted({}, outcome as ModelOutcome), model: 'm', only: 'stale', dryRun: false })
      expect(report).toMatchObject({ calls: 1, mapped: 0, failedBatches: 1 })
      const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
      expect(row.capabilityMappingHash).toBeNull()
      expect(row.mappedCapabilityKeys).toEqual([])
    }
  })

  it('leaves a persona the answer does not mention untouched and counts it absent', async (): Promise<void> => {
    await structured('Named', ['x'])
    const id = await structured('Forgotten', ['y'])
    const report = await mapTemplateCapabilities({ decider: scripted({ Named: ['qa.exploratory'] }), model: 'm', only: 'stale', dryRun: false })
    expect(report).toMatchObject({ calls: 1, mapped: 1, absent: 1 })
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).capabilityMappingHash).toBeNull()
  })

  it('writes nothing under dryRun and returns what it would have written', async (): Promise<void> => {
    const id = await structured('Preview', ['x'])
    const report = await mapTemplateCapabilities({ decider: scripted({ Preview: ['qa.exploratory'] }), model: 'm', only: 'stale', dryRun: true })
    expect(report.rows).toEqual([{ templateId: id, name: 'Preview', keys: ['qa.exploratory'], dropped: [] }])
    expect(report.pool).toBeNull()
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })
    expect(row.mappedCapabilityKeys).toEqual([])
    expect(row.capabilityMappingHash).toBeNull()
  })

  it('never selects a hand-made template or one with no capability sentence', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend', description: 'x', active: true } })
    await structured('Blank Sentences', ['  ', ''])
    const decider = scripted({})
    const report = await mapTemplateCapabilities({ decider, model: 'm', only: 'all', dryRun: false })
    expect(report).toMatchObject({ considered: 0, stale: 0, calls: 0 })
    expect(decider.calls).toHaveLength(0)
  })

  it('batches by batchSize, stops at maxBatches, and survives a failed batch in the middle', async (): Promise<void> => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) await structured(name, [name.toLowerCase()])
    let n = 0
    const inner = scripted({ A: ['qa.exploratory'], B: ['qa.exploratory'], E: ['qa.exploratory'] })
    const decider: ModelDecider = async (input) => {
      n += 1
      if (n === 2) return { kind: 'answer', text: 'garbage', costUsd: 0.01, tokens: null, numTurns: 1 }
      return inner(input)
    }
    const report = await mapTemplateCapabilities({ decider, model: 'm', only: 'stale', dryRun: false, batchSize: 2, maxBatches: 3 })
    expect(report).toMatchObject({ calls: 3, failedBatches: 1, mapped: 3 })
    expect((await countStaleTemplateMappings()).stale).toBe(2) // C and D, from the failed batch
  })

  it('reconcile after a mapping keeps the mapped keys, and the pool carries the union', async (): Promise<void> => {
    const id = await structured('Pooled', ['CI/CD Excellence'])
    await mapTemplateCapabilities({ decider: scripted({ Pooled: ['operations.ci-cd'] }), model: 'm', only: 'stale', dryRun: false })
    await reconcileTemplateCapabilities()
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id } })).capabilityKeys).toEqual(['operations.ci-cd'])
    await syncPersonPool()
    const person = await prisma.person.findFirst({ where: { templateId: id } })
    expect(person?.capabilities).toEqual(['operations.ci-cd'])
  })
})
```

If `syncPersonPool` only materialises people for ACTIVE templates with a `poolSlot`, keep `active = true` in `structured` (it is the default above) and, if the last assertion needs a slot, read how `capabilityReconcile.test.ts` or `personPool` tests create a managed person and copy that.

- [ ] **Step 2: Run to see them fail**

Run: `set -a; . ./.env; set +a; npx vitest run packages/control/test/integration/capability-mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/control/src/capabilityMapping.ts`**

```ts
import { prisma } from '@slave-of-ai/db/client'
import {
  CAPABILITY_MAP_BATCH_SIZE,
  CAPABILITY_MAP_PER_CALL_CAP_USD,
  buildCapabilityMappingPrompt,
  capabilityMappingHash,
  mappableSentences,
  parseCapabilityMappingAnswer,
  profileSpecSchema,
  type CapabilityMappingPersona,
  type CapabilityRecord,
} from '@slave-of-ai/domain'
import { effectiveCapabilityKeys, listCapabilities } from './capability.js'
import { syncPersonPool, type PersonPoolSyncReport } from './personPool.js'
import type { ModelDecider } from './simulation/llm.js'

/**
 * Catalogue capability mapping (2026-09-20), R6: the ONE verb that asks a model which taxonomy
 * keys a persona provides, in batches, and writes the answer beside the exact matcher's keys.
 *
 * Money discipline, in order: the hash (R4) decides whether a call is owed at all; the batch
 * bounds the prompt; the per-call cap bounds the call; one transaction per batch bounds what a
 * bad answer can touch. A batch that fails -- no JSON, an isolation breach, a spawn failure --
 * leaves its rows exactly as they were, so the next pass retries them, and never stops the
 * batches after it.
 */

export interface MapTemplateCapabilitiesInput {
  readonly decider: ModelDecider
  readonly model: string
  /** `stale` maps only rows whose hash disagrees with today's; `all` re-asks for every mappable row. */
  readonly only: 'stale' | 'all'
  /** Build, call, parse -- write nothing; `rows` says what would have been written. */
  readonly dryRun: boolean
  readonly batchSize?: number
  readonly maxBatches?: number
  readonly maxBudgetUsdPerCall?: number
}

export interface CapabilityMappingRow {
  readonly templateId: string
  readonly name: string
  readonly keys: readonly string[]
  readonly dropped: readonly string[]
}

export interface CapabilityMappingReport {
  readonly considered: number
  readonly stale: number
  readonly calls: number
  readonly mapped: number
  readonly unchanged: number
  readonly absent: number
  readonly failedBatches: number
  readonly droppedKeys: number
  readonly costUsd: number
  readonly unmeasuredCalls: number
  readonly rows: readonly CapabilityMappingRow[]
  readonly pool: PersonPoolSyncReport | null
}

interface Candidate {
  readonly persona: CapabilityMappingPersona
  readonly hash: string
  readonly storedHash: string | null
  readonly storedMapped: readonly string[]
  readonly exactKeys: readonly string[]
}

/** R4: every structured template with at least one mappable sentence, with today's hash beside
 *  the stored one. Read once per pass, id ascending, so a batch boundary is deterministic. */
async function loadCandidates(taxonomy: readonly CapabilityRecord[]): Promise<readonly Candidate[]> {
  const rows = await prisma.slaveTemplate.findMany({
    where: { profileSpec: { not: Prisma.DbNull } },
    select: {
      id: true,
      name: true,
      role: true,
      profileSpec: true,
      capabilityKeys: true,
      mappedCapabilityKeys: true,
      capabilityMappingHash: true,
      unresolvedCapabilities: true,
    },
    orderBy: { id: 'asc' },
  })
  const candidates: Candidate[] = []
  for (const row of rows) {
    const spec = profileSpecSchema.safeParse(row.profileSpec)
    if (!spec.success) continue
    if (mappableSentences(spec.data.capabilities).length === 0) continue
    const persona: CapabilityMappingPersona = {
      id: row.id,
      name: row.name,
      runtimeRole: spec.data.runtimeRole || row.role,
      summary: spec.data.summary,
      identity: spec.data.identity,
      capabilities: spec.data.capabilities,
    }
    // The EXACT half is what the row's current effective set holds minus the mapped half -- the
    // matcher's own output is not stored on its own, and re-running it here would couple this
    // pass to `normaliseCapabilities`. Subtracting is exact because both halves are sets.
    const exactKeys = row.capabilityKeys.filter((key) => !row.mappedCapabilityKeys.includes(key))
    candidates.push({
      persona,
      hash: capabilityMappingHash(persona, taxonomy),
      storedHash: row.capabilityMappingHash,
      storedMapped: row.mappedCapabilityKeys,
      exactKeys,
    })
  }
  return candidates
}

export async function countStaleTemplateMappings(): Promise<{ readonly considered: number; readonly stale: number }> {
  const taxonomy = await listCapabilities()
  const candidates = await loadCandidates(taxonomy)
  return { considered: candidates.length, stale: candidates.filter((c) => c.hash !== c.storedHash).length }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].toSorted().every((v, i) => v === [...b].toSorted()[i])
}

export async function mapTemplateCapabilities(input: MapTemplateCapabilitiesInput): Promise<CapabilityMappingReport> {
  const taxonomy = await listCapabilities()
  const candidates = await loadCandidates(taxonomy)
  const due = input.only === 'all' ? candidates : candidates.filter((c) => c.hash !== c.storedHash)
  const batchSize = Math.max(1, input.batchSize ?? CAPABILITY_MAP_BATCH_SIZE)
  const cap = input.maxBudgetUsdPerCall ?? CAPABILITY_MAP_PER_CALL_CAP_USD

  let calls = 0
  let mapped = 0
  let unchanged = 0
  let absent = 0
  let failedBatches = 0
  let droppedKeys = 0
  let costUsd = 0
  let unmeasuredCalls = 0
  const rows: CapabilityMappingRow[] = []
  let wrote = false

  for (let start = 0; start < due.length; start += batchSize) {
    if (input.maxBatches !== undefined && calls >= input.maxBatches) break
    const batch = due.slice(start, start + batchSize)
    const prompt = buildCapabilityMappingPrompt(batch.map((c) => c.persona), taxonomy)
    calls += 1
    let outcome
    try {
      outcome = await input.decider({ model: input.model, prompt, maxBudgetUsd: cap })
    } catch {
      failedBatches += 1
      continue
    }
    if (outcome.costUsd === null) unmeasuredCalls += 1
    else costUsd += outcome.costUsd
    if (outcome.kind !== 'answer') {
      failedBatches += 1
      continue
    }
    const parsed = parseCapabilityMappingAnswer(outcome.text, batch.map((c) => c.persona), taxonomy)
    if (parsed === null) {
      failedBatches += 1
      continue
    }
    const byId = new Map(parsed.map((r) => [r.id, r] as const))
    const now = new Date()
    const writes: { candidate: Candidate; keys: readonly string[]; dropped: readonly string[] }[] = []
    for (const candidate of batch) {
      const result = byId.get(candidate.persona.id)
      if (result === undefined) {
        absent += 1
        continue
      }
      droppedKeys += result.dropped.length
      writes.push({ candidate, keys: result.keys, dropped: result.dropped })
    }
    for (const write of writes) {
      rows.push({ templateId: write.candidate.persona.id, name: write.candidate.persona.name, keys: write.keys, dropped: write.dropped })
    }
    if (input.dryRun) {
      mapped += writes.length
      continue
    }
    await prisma.$transaction(async (tx) => {
      for (const { candidate, keys } of writes) {
        const same = sameSet(candidate.storedMapped, keys) && candidate.storedHash === candidate.hash
        if (same) {
          unchanged += 1
          continue
        }
        await tx.slaveTemplate.update({
          where: { id: candidate.persona.id },
          data: {
            mappedCapabilityKeys: [...keys],
            capabilityMappingHash: candidate.hash,
            capabilityMappedAt: now,
            capabilityKeys: effectiveCapabilityKeys(candidate.exactKeys, keys),
          },
        })
        mapped += 1
        wrote = true
      }
    })
  }

  const pool = wrote ? await syncPersonPool() : null
  return {
    considered: candidates.length,
    stale: due.length,
    calls,
    mapped,
    unchanged,
    absent,
    failedBatches,
    droppedKeys,
    costUsd,
    unmeasuredCalls,
    rows,
    pool,
  }
}
```

Notes for the implementer:
- `Prisma` must be imported from `@slave-of-ai/db/client` for `Prisma.DbNull` (check how other files in `packages/control/src` filter a non-null JSON column; if they use `{ not: Prisma.DbNull }` copy that, otherwise filter in code after `findMany` with no `where`).
- `only: 'all'` with a fresh row whose keys equal the stored set must count as `unchanged` and write nothing (the test "only: all re-calls it" expects `mapped: 0, unchanged: 1`). The condition above does that when the hash is also unchanged; when the hash moved but the keys are the same, write (the hash must be stamped) — that counts as `mapped`.
- Add `export * from './capabilityMapping.js'` to `packages/control/src/index.ts` beside `./intakeTick.js`.

- [ ] **Step 4: Run to see them pass**

Run: `set -a; . ./.env; set +a; npx tsc --build && npx vitest run packages/control/test/integration/capability-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control/src/capabilityMapping.ts packages/control/src/index.ts packages/control/test/integration/capability-mapping.test.ts
git -c core.hooksPath=/dev/null commit -m "feat(control): mapTemplateCapabilities -- the model-assisted mapping pass, hash-gated and batched

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `capabilities map` in the CLI (spec R7)

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (the help block at ~`:424–440`; the `case 'capabilities'` dispatch at ~`:2485–2543`)
- Test: `apps/orchestrator/test/integration/cli.test.ts` (beside the existing `capabilities sync` tests at ~`:1494`)

**Interfaces:**
- Consumes: `mapTemplateCapabilities`, `CapabilityMappingReport` from `@slave-of-ai/control`; `buildModelDecider()` (already in `cli.ts` at ~`:965`); `SUPERVISOR_DEFAULT_MODEL` from `@slave-of-ai/domain`.
- Produces: the verb `capabilities map [--all] [--dry-run] [--batch <n>] [--max-batches <n>]`; the fake CLI fixture `capability-map` (see Step 1).

- [ ] **Step 1: Teach the fake CLI a mapping answer**

Open `packages/providers/test/fake-claude.mjs` and find how `--fixture` selects an answer (the intake tests use a fixture keyed on `"intakeAnswer"`; find that branch). Add a branch: when the prompt contains `"personas"` (the marker), answer with a JSON object that maps every `persona id: <id>` line in the prompt to `["qa.exploratory"]`, e.g.:

```js
if (prompt.includes('"personas"')) {
  const ids = [...prompt.matchAll(/^persona id: (.+)$/gmu)].map((m) => m[1])
  return JSON.stringify({ personas: ids.map((id) => ({ id, keys: ['qa.exploratory'] })) })
}
```

Wire it into whichever fixture name the CLI test's `runCli` passes by default (`complete`) so no new fixture flag is needed; keep the branch ahead of the generic answer. Run the providers' own fake-CLI tests if any exist (`npx vitest run packages/providers`).

- [ ] **Step 2: Write the failing CLI tests**

In `apps/orchestrator/test/integration/cli.test.ts`, inside the `describe` that holds the `capabilities sync` test:

```ts
    it('capabilities map --dry-run prints one line per persona and writes nothing', async (): Promise<void> => {
      await prisma.slaveTemplate.create({
        data: {
          name: 'Dry Run Persona',
          role: 'engineering',
          description: 'x',
          active: true,
          profileSpec: { ...emptyProfileSpec(), summary: 's', identity: 'i', capabilities: ['Explores the product by hand'] } as unknown as object,
        },
      })
      const result = await runCli(['capabilities', 'map', '--dry-run'])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('Dry Run Persona: qa.exploratory')
      const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { name: 'Dry Run Persona' } })
      expect(row.mappedCapabilityKeys).toEqual([])
      expect(row.capabilityMappingHash).toBeNull()
    })

    it('capabilities map writes the mapping and reports it as JSON', async (): Promise<void> => {
      await prisma.slaveTemplate.create({
        data: {
          name: 'Mapped Persona',
          role: 'engineering',
          description: 'x',
          active: true,
          profileSpec: { ...emptyProfileSpec(), summary: 's', identity: 'i', capabilities: ['Explores the product by hand'] } as unknown as object,
        },
      })
      const result = await runCli(['capabilities', 'map', '--max-batches', '1'])
      expect(result.code).toBe(0)
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as { mapped: number; calls: number }
      expect(report).toMatchObject({ calls: 1, mapped: 1 })
      const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { name: 'Mapped Persona' } })
      expect(row.mappedCapabilityKeys).toEqual(['qa.exploratory'])
      expect(row.capabilityKeys).toEqual(['qa.exploratory'])
    })
```

Import `emptyProfileSpec` from `@slave-of-ai/domain` at the top of the test file if it is not already imported. The `beforeEach` of that `describe` must truncate `SlaveTemplate` (check; add it to the TRUNCATE list if missing) and run `syncCapabilityTaxonomy()` or `runCli(['capabilities','sync'])` so `qa.exploratory` exists.

- [ ] **Step 3: Run to see them fail**

Run: `set -a; . ./.env; set +a; npx tsc --build && npx vitest run apps/orchestrator/test/integration/cli.test.ts -t "capabilities map"`
Expected: FAIL — "capabilities takes sync, reconcile, add, backfill or list".

- [ ] **Step 4: Add the verb**

Help block, after the `reconcile` entry:

```
  capabilities map [--all] [--dry-run] [--batch <n>] [--max-batches <n>]
                                       ask the model which taxonomy keys each persona provides,
                                       from its own capability sentences, and write them beside
                                       the exact matches. Only personas whose sentences or the
                                       taxonomy changed since their last mapping, unless --all.
                                       --dry-run prints what would be written and writes nothing.
```

Dispatch, before the final `throw`:

```ts
      if (sub === 'map') {
        const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true'
        const batch = flagText(flags, 'batch')
        const maxBatches = flagText(flags, 'max-batches')
        const report = await mapTemplateCapabilities({
          decider: buildModelDecider(),
          model: process.env['SLAVEOFAI_SUPERVISOR_MODEL'] ?? SUPERVISOR_DEFAULT_MODEL,
          only: flags['all'] === true || flags['all'] === 'true' ? 'all' : 'stale',
          dryRun,
          ...(batch === undefined ? {} : { batchSize: Number(batch) }),
          ...(maxBatches === undefined ? {} : { maxBatches: Number(maxBatches) }),
        })
        if (dryRun) {
          for (const row of report.rows) {
            const dropped = row.dropped.length === 0 ? '' : `  (not keys, dropped: ${row.dropped.join(', ')})`
            process.stdout.write(`${row.name}: ${row.keys.length === 0 ? '(nothing fits)' : row.keys.join(', ')}${dropped}\n`)
          }
        }
        const { rows: _rows, ...summary } = report
        process.stdout.write(`${JSON.stringify(summary)}\n`)
        return 0
      }
```

Update the final error to `'capabilities takes sync, reconcile, map, add, backfill or list'`. Read how boolean flags are parsed in this file (`flags['dry-run']` shape) and match it; `flagText` and `requireFlag` already exist.

- [ ] **Step 5: Run to see them pass**

Run: `set -a; . ./.env; set +a; npx tsc --build && npx vitest run apps/orchestrator/test/integration/cli.test.ts -t "capabilities"`
Expected: PASS (the new two and the existing sync/add/list cases).

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/cli.ts apps/orchestrator/test/integration/cli.test.ts packages/providers/test/fake-claude.mjs
git -c core.hooksPath=/dev/null commit -m "feat(cli): capabilities map -- run the mapping pass, dry-run prints per persona

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: One batch per daemon pass (spec R7)

**Files:**
- Create: `packages/control/src/capabilityMappingTick.ts`
- Modify: `packages/control/src/index.ts` (export it)
- Modify: `apps/orchestrator/src/daemon.ts` (the global pass, after `tickIntakes` at ~`:520`)
- Test: `packages/control/test/integration/capability-mapping-tick.test.ts`, `apps/orchestrator/test/integration/daemon.test.ts` (one case)

**Interfaces:**
- Produces:

```ts
export interface TickCapabilityMappingReport {
  readonly skippedNoDecider: boolean
  readonly stale: number
  readonly calls: number
  readonly mapped: number
  readonly failedBatches: number
  readonly costUsd: number
}
export async function tickCapabilityMapping(input: { readonly model: string; readonly modelDecider?: ModelDecider }): Promise<TickCapabilityMappingReport>
```

- [ ] **Step 1: Write the failing tests**

`packages/control/test/integration/capability-mapping-tick.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { emptyProfileSpec } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { syncCapabilityTaxonomy } from '../../src/capability.js'
import { tickCapabilityMapping } from '../../src/capabilityMappingTick.js'
import type { ModelDecider } from '../../src/simulation/llm.js'

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Person", "SlaveTemplate" RESTART IDENTITY CASCADE')
  await syncCapabilityTaxonomy()
})

const structured = (name: string) =>
  prisma.slaveTemplate.create({
    data: { name, role: 'engineering', description: 'x', active: true, profileSpec: { ...emptyProfileSpec(), summary: 's', identity: 'i', capabilities: ['hand testing'] } as unknown as object },
  })

const everyone: ModelDecider = async (input) => {
  const ids = [...input.prompt.matchAll(/^persona id: (.+)$/gmu)].map((m) => m[1] as string)
  return { kind: 'answer', text: JSON.stringify({ personas: ids.map((id) => ({ id, keys: ['qa.exploratory'] })) }), costUsd: 0.03, tokens: null, numTurns: 1 }
}

describe('tickCapabilityMapping', () => {
  it('maps ONE batch per pass and leaves the rest for the next pass', async (): Promise<void> => {
    for (let i = 0; i < 7; i += 1) await structured(`P${String(i)}`)
    const first = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(first).toMatchObject({ skippedNoDecider: false, stale: 7, calls: 1, mapped: 5 })
    const second = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(second).toMatchObject({ stale: 2, calls: 1, mapped: 2 })
    const third = await tickCapabilityMapping({ model: 'm', modelDecider: everyone })
    expect(third).toMatchObject({ stale: 0, calls: 0, mapped: 0 })
  })

  it('reports skippedNoDecider and calls nothing without a decider', async (): Promise<void> => {
    await structured('Alone')
    const report = await tickCapabilityMapping({ model: 'm' })
    expect(report).toMatchObject({ skippedNoDecider: true, stale: 1, calls: 0, mapped: 0 })
  })
})
```

In `apps/orchestrator/test/integration/daemon.test.ts`, add one case in the first `describe` (it starts the daemon with `start('all')` and reads stdout):

```ts
  it('prints a capabilityMapping line when a persona is stale and no decider is configured', async (): Promise<void> => {
    await prisma.slaveTemplate.create({
      data: { name: 'Stale Persona', role: 'engineering', description: 'x', active: true, profileSpec: { ...emptyProfileSpec(), summary: 's', identity: 'i', capabilities: ['hand testing'] } as unknown as object },
    })
    const text = await start('all')
    await until(() => text().includes('"capabilityMapping"'))
    const line = text().split('\n').find((l) => l.includes('"capabilityMapping"')) ?? ''
    expect(JSON.parse(line)).toMatchObject({ capabilityMapping: { skippedNoDecider: true, stale: 1 } })
  })
```

Import `emptyProfileSpec` from `@slave-of-ai/domain` there. The daemon in that test is started without a `modelDecider`, which is the case this asserts.

- [ ] **Step 2: Run to see them fail**

Run: `set -a; . ./.env; set +a; npx vitest run packages/control/test/integration/capability-mapping-tick.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tick and wire it into the daemon**

`packages/control/src/capabilityMappingTick.ts`:

```ts
import { countStaleTemplateMappings, mapTemplateCapabilities } from './capabilityMapping.js'
import type { ModelDecider } from './simulation/llm.js'

/**
 * Catalogue capability mapping (2026-09-20), R7: the daemon's slice of the mapping pass -- ONE
 * batch per global pass, stale rows only, so a freshly imported catalogue is mapped at the
 * daemon's own rhythm rather than in one burst, and a taxonomy change re-maps at the same pace.
 * Without a decider it reports and does nothing: a daemon built without one silently leaving
 * every persona unmapped is exactly the failure an operator cannot diagnose from outside
 * (the `tickIntakes` precedent).
 */
export interface TickCapabilityMappingReport {
  readonly skippedNoDecider: boolean
  readonly stale: number
  readonly calls: number
  readonly mapped: number
  readonly failedBatches: number
  readonly costUsd: number
}

export async function tickCapabilityMapping(input: {
  readonly model: string
  readonly modelDecider?: ModelDecider
}): Promise<TickCapabilityMappingReport> {
  if (input.modelDecider === undefined) {
    const { stale } = await countStaleTemplateMappings()
    return { skippedNoDecider: true, stale, calls: 0, mapped: 0, failedBatches: 0, costUsd: 0 }
  }
  const report = await mapTemplateCapabilities({
    decider: input.modelDecider,
    model: input.model,
    only: 'stale',
    dryRun: false,
    maxBatches: 1,
  })
  return {
    skippedNoDecider: false,
    stale: report.stale,
    calls: report.calls,
    mapped: report.mapped,
    failedBatches: report.failedBatches,
    costUsd: report.costUsd,
  }
}
```

Export it from `packages/control/src/index.ts`. In `apps/orchestrator/src/daemon.ts`, directly after the `intakes` print (inside the same `try`):

```ts
      // Catalogue capability mapping (2026-09-20), R7: one batch of stale personas per pass,
      // beside the intakes and for the same reason -- a persona belongs to no workspace.
      const capabilityMapping = await tickCapabilityMapping({
        model: deps.supervisorModel ?? SUPERVISOR_DEFAULT_MODEL,
        ...(deps.modelDecider !== undefined ? { modelDecider: deps.modelDecider } : {}),
      })
      if (capabilityMapping.calls > 0 || (capabilityMapping.skippedNoDecider && capabilityMapping.stale > 0)) {
        process.stdout.write(`${JSON.stringify({ capabilityMapping })}\n`)
      }
```

Import `tickCapabilityMapping` from `@slave-of-ai/control` beside `tickIntakes`.

- [ ] **Step 4: Run to see them pass**

Run: `set -a; . ./.env; set +a; npx tsc --build && npx vitest run packages/control/test/integration/capability-mapping-tick.test.ts apps/orchestrator/test/integration/daemon.test.ts`
Expected: PASS. (`daemon.test.ts` truncates `SlaveTemplate` in its `beforeEach`; if the new case leaks a stale persona into a neighbour's stdout assertion, add `"SlaveTemplate"` to that file's TRUNCATE if it is missing — it is already there as of 2026-09-20.)

- [ ] **Step 5: Commit**

```bash
git add packages/control/src/capabilityMappingTick.ts packages/control/src/index.ts apps/orchestrator/src/daemon.ts packages/control/test/integration/capability-mapping-tick.test.ts apps/orchestrator/test/integration/daemon.test.ts
git -c core.hooksPath=/dev/null commit -m "feat(daemon): one batch of capability mapping per global pass

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Matched and mapped on the persona drawer (spec R8)

**Files:**
- Modify: `packages/control/src/catalog.ts` (`WorkforceCatalogRow` ~`:885–935`, `catalogRowOf` ~`:975–1010`, the select at ~`:1100–1118`)
- Modify: `apps/web/src/components/workforce/WorkforceCatalog.tsx` (the `open` state at ~`:79–85`, the two `setOpen` sites at ~`:207` and `:224`, the `<ProfileDrawer>` at ~`:362`)
- Modify: `apps/web/src/components/workforce/ProfileDrawer.tsx` (props at ~`:118–145`, the memo at ~`:157–168`, the chips block at ~`:372–382`)
- Modify: `apps/web/src/components/workforce/WorkforceClient.tsx` only if it constructs a `ProfileDrawer` (check with grep; if it does, pass the two new props the same way)
- Test: `apps/web/test/workforce-catalog.test.tsx` (`describe('ProfileDrawer')` ~`:433`)

**Interfaces:**
- Produces on `WorkforceCatalogRow`: `readonly mappedCapabilityKeys: readonly string[]`, `readonly capabilityMappedAt: Date | null`, `readonly capabilityMappingStale: boolean` (computed in `catalogRowOf` as: structured AND has mappable sentences AND `capabilityMappingHash !== capabilityMappingHash(persona, taxonomy)`; `catalogRowOf` therefore receives the taxonomy — pass `await listCapabilities()` once from the caller that builds rows).
- `ProfileDrawer` props gain `readonly mappedCapabilityKeys?: readonly string[]` (default `[]`) and `readonly capabilityMapping?: 'mapped' | 'stale' | 'none'` (default `'none'`).

- [ ] **Step 1: Write the failing web test**

In `apps/web/test/workforce-catalog.test.tsx`, inside `describe('ProfileDrawer')`, after reading how `openDrawer` renders the component and mocks `fetch`, add:

```tsx
  it('marks each capability chip as matched or mapped, and says when the mapping is stale', async () => {
    await openDrawer(
      {},
      {
        capabilityKeys: ['backend.services', 'operations.ci-cd'],
        mappedCapabilityKeys: ['operations.ci-cd'],
        capabilityMapping: 'stale',
      },
    )
    const keys = await screen.findByTestId('profile-capability-keys')
    const chips = within(keys).getAllByTestId('capability-chip')
    expect(chips.map((chip) => chip.getAttribute('data-provenance'))).toEqual(['matched', 'mapped'])
    expect(within(keys).getByTestId('profile-capability-mapping')).toHaveTextContent('mapping is stale')
  })

  it('says when a persona has not been mapped yet', async () => {
    await openDrawer({}, { capabilityKeys: ['backend.services'], mappedCapabilityKeys: [], capabilityMapping: 'none' })
    const keys = await screen.findByTestId('profile-capability-keys')
    expect(within(keys).getByTestId('profile-capability-mapping')).toHaveTextContent('not yet mapped')
  })
```

Adapt `openDrawer`'s second argument to spread extra props onto `<ProfileDrawer>` (read its definition at ~`:470`; it already takes an `over` for the profile view — add a second parameter `props: Partial<ComponentProps<typeof ProfileDrawer>> = {}` and spread it). If `CapabilityChips` renders no `data-testid="capability-chip"`, read `apps/web/src/components/**/CapabilityChips.tsx` and add `data-testid="capability-chip"` plus a `provenance?: 'matched' | 'mapped'` per chip → `data-provenance` (its other callers pass none and render no attribute).

- [ ] **Step 2: Run to see it fail**

Run: `set -a; . ./.env; set +a; npx vitest run apps/web/test/workforce-catalog.test.tsx -t "ProfileDrawer"`
Expected: FAIL — no `data-provenance`, no `profile-capability-mapping`.

- [ ] **Step 3: Read model**

In `packages/control/src/catalog.ts`:
- Add to the select (`:1100–1118`): `mappedCapabilityKeys: true, capabilityMappingHash: true, capabilityMappedAt: true`, and to `CatalogTemplateRow` the three fields.
- Add to `WorkforceCatalogRow` after `capabilityKeys`:

```ts
  /** 2026-09-20 catalogue capability mapping, R8: the half of `capabilityKeys` a MODEL chose. */
  readonly mappedCapabilityKeys: readonly string[]
  readonly capabilityMappedAt: Date | null
  /** R4's staleness, computed here so the drawer can say "stale" without a second read. False
   *  for a row that can never be mapped (unstructured, or no sentences). */
  readonly capabilityMappingStale: boolean
```

- `catalogRowOf(template, catalogSlaveCount, rawOverride, duplicate, taxonomy)`: compute

```ts
    const mappable = effective !== null && mappableSentences(effective.capabilities).length > 0
    const capabilityMappingStale =
      mappable &&
      template.capabilityMappingHash !==
        capabilityMappingHash({ summary: effective.summary, identity: effective.identity, capabilities: effective.capabilities }, taxonomy)
```

and return `mappedCapabilityKeys: template.mappedCapabilityKeys, capabilityMappedAt: template.capabilityMappedAt, capabilityMappingStale`. Every caller of `catalogRowOf` passes the taxonomy it already loads for the facets (grep `catalogRowOf(`; if a caller has no taxonomy in scope, `await listCapabilities()` once above the loop). Import `capabilityMappingHash`, `mappableSentences` from `@slave-of-ai/domain`.

Note: the mapping is computed against the UPSTREAM spec's sentences in the pass (Task 5 reads `profileSpec`), so use `spec.data` (upstream) rather than `effective` here for `capabilities`/`summary`/`identity` to agree with the pass; use `effective` only for `mappable`'s display concern if you prefer — pick upstream for both, and say so in a comment.

- [ ] **Step 4: Web**

`WorkforceCatalog.tsx`: extend the `open` state with `mappedCapabilityKeys: readonly string[]` and `capabilityMapping: 'mapped' | 'stale' | 'none'`; at both `setOpen` sites pass `mappedCapabilityKeys: row.mappedCapabilityKeys` and `capabilityMapping: row.capabilityMappingStale ? 'stale' : row.capabilityMappedAt === null ? 'none' : 'mapped'`; pass both to `<ProfileDrawer>`.

`ProfileDrawer.tsx`: add the two props (defaults `[]` and `'none'`); in the memo, produce `resolved` as `{ key, label, provenance: mappedSet.has(key) ? 'mapped' : 'matched' }`; render:

```tsx
                <CapabilityChips capabilities={resolved} max={resolved.length} />
                <span data-testid="profile-capability-mapping" className="text-[11px] text-text-3">
                  {capabilityMapping === 'stale'
                    ? 'mapping is stale — the daemon re-maps it on its next pass, or run `capabilities map`'
                    : capabilityMapping === 'none'
                      ? 'not yet mapped — the daemon maps it on its next pass, or run `capabilities map`'
                      : 'matched keys come from the persona\'s own words; mapped keys were chosen by a model'}
                </span>
```

and keep the chips block rendering when `capabilityKeys.length > 0 || capabilityMapping !== 'mapped'` — a persona with no keys and no mapping must still show the "not yet mapped" line (this is the case the spec's R8 note is for). Adjust the existing test at `:510` ("expect(screen.queryByTestId('profile-capability-keys')).toBeNull()") only if it asserted the block is absent for an unmapped row with no keys: that assertion now expects the block present with the mapping line; read the test's intent and update its expectation in place with a comment citing R8.

- [ ] **Step 5: Run the web tests, typecheck and build**

Run: `set -a; . ./.env; set +a; npx tsc --build && npx vitest run apps/web/test/workforce-catalog.test.tsx apps/web/test/catalog-duplicates.test.tsx packages/control/test/integration/catalog-page.test.ts && npm run typecheck && npm run web:build`
Expected: all PASS, typecheck and build green. (`web:build` writes `apps/web/.next` in THIS checkout; never run it in a checkout whose `next dev` is up.)

- [ ] **Step 6: Commit**

```bash
git add packages/control/src/catalog.ts apps/web/src/components/workforce apps/web/test/workforce-catalog.test.tsx
git -c core.hooksPath=/dev/null commit -m "feat(web): persona drawer marks capability chips matched or mapped and says when the mapping is stale

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Docs, the full ladder, and the live catalogue

**Files:**
- Modify: `README.md` (the "capabilities" paragraph near `capabilities sync`, if one exists; otherwise the section that lists CLI verbs) — one sentence on `capabilities map` and that the daemon maps stale personas on its own.
- Modify: `docs/superpowers/specs/2026-09-20-catalogue-capability-mapping-design.md` §6 Errata — record any deviation the tasks above forced (e.g. the exact-half subtraction in Task 5's `loadCandidates`, or a provenance attribute added to `CapabilityChips`).

- [ ] **Step 1: README sentence**

Find the paragraph that documents `capabilities sync` / `reconcile` (grep `capabilities reconcile` in README.md). Add after it:

```
`npm run orchestrator -- capabilities map` asks the model which taxonomy keys each persona
provides, from its own capability sentences, and stores them beside the exact matches; the daemon
does the same for stale personas one batch per pass, so a fresh import needs no extra command.
`--dry-run` prints what would be written.
```

- [ ] **Step 2: Errata**

Replace "None yet." in the spec's §6 with the numbered deviations, each one sentence with the task that forced it. If there were none, write "None: the plan landed as specified."

- [ ] **Step 3: The full ladder**

Run, with nothing else touching the test database and no daemon running on the host (a running daemon breaks `subscribe.test.ts`):

`set -a; . ./.env; set +a; npm run typecheck && npx vitest run && npm run web:build`

Expected: every file green; the count grows from 440 files / 7224 tests by the new files. Paste the summary lines into the commit body.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-20-catalogue-capability-mapping-design.md
git -c core.hooksPath=/dev/null commit -m "docs: capabilities map in the README; spec errata

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand back for the live run (operator step, NOT the implementer's)**

After merge, the operator migrates the development database (`npm run db:migrate`), rebuilds (`npx tsc --build`), runs `npm run orchestrator -- capabilities sync` (carries the 63 rows in), then either restarts the daemon (it maps one batch per pass, ~56 passes) or runs `npm run orchestrator -- capabilities map` once to map the whole catalogue in one sitting (about 56 calls). Then `DevOps Automator` should show `operations.ci-cd` in its drawer as a mapped chip.

---

## Self-review

**Spec coverage.** R1 → Task 1. R2 → Task 1's spot check, Task 4 leaves the matcher alone. R3 → Tasks 2, 4. R4 → Task 3 (hash), Task 5 (staleness, never-mapped cases). R5 → Task 3. R6 → Tasks 4 (writers), 5 (the verb, batches, dry run, pool sync). R7 → Tasks 6, 7. R8 → Task 8. R9 → no task touches `decide`, `loadWorld`, `formTeam`, events or gates; Task 9's ladder proves it. §2 rows → Task 1 verbatim. §3 prompt contract → Task 3. §4 tests → Tasks 1, 3, 5, 6, 7, 8, 9. §5 out of scope → nothing planned for it.

**Placeholders.** None: every step carries its code or its exact command. Two places tell the implementer to READ an existing helper and copy its shape (the fake CLI's fixture branch, `openDrawer`'s signature) because the plan cannot quote a file it must not change blindly; both name the file and the line.

**Type consistency.** `effectiveCapabilityKeys(exact, mapped): string[]` (Task 4) is what Tasks 5 and 8 call. `mapTemplateCapabilities`'s input/report (Task 5) is what Tasks 6 and 7 consume; `countStaleTemplateMappings` (Task 5) is what Task 7 calls without a decider. `CapabilityMappingPersona`, `capabilityMappingHash`, `mappableSentences` (Task 3) are what Tasks 5 and 8 import. The drawer's `capabilityMapping: 'mapped' | 'stale' | 'none'` (Task 8) is computed from `capabilityMappingStale` and `capabilityMappedAt` on the row (Task 8's read model).
