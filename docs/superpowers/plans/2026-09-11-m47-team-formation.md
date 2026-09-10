# M47 Capability Graph + Minimal Team Formation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Supervisor stops choosing workers by name and starts choosing them by CAPABILITY: a dotted, data-driven taxonomy lives in a table; a plan declares the capabilities each task needs; the roster is measured against them; what is missing is found in the company roster or the workforce catalog; and the smallest team that covers the gap is proposed with a sentence a person can read — while dispatch keeps the ONE matching rule it has always had (`Slave.runtimeRoles` ∋ `Task.requiredRole`).

**Architecture:** Capabilities PROJECT to runtime roles. A `Capability` row carries `key` (`<domain>.<name>`), `label`, `domain`, `role` and `synonyms`; `Task.requiredCapabilities` is the planning/staffing vocabulary and `Task.requiredRole` is DERIVED from it (the planner may still give a bare role, which wins); `Slave.capabilities` is what a worker provides, and materialisation seeds `runtimeRoles` with the roles those capabilities project to. `decide()`, `world.ts`, `review.ts`, `planning.ts`'s manager query and `ask.ts` are untouched — they still match one string against one set. Everything new is pure domain (`packages/domain/src/capability/{taxonomy,hints,team}.ts`) plus one Supervisor situation, three Supervisor actions, five control verbs, one run-context section, one web tab and one gate.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), zod, vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-11-m47-team-formation-design.md` (rulings R1–R7; §4 errata). Its parents are `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` (row M47), `docs/ia.md`, `docs/superpowers/specs/2026-09-11-m46-workforce-catalog-design.md` (the structured profile and importer this extends), and `docs/superpowers/specs/2026-09-09-m38-supervisor-design.md` + `2026-09-09-m39-supervisor-mailbox-design.md` (the situations → candidates → tiers → decide → apply flow this adds one arm to). **M48 owns runbooks and typed handoffs, M50 owns the temporary-worker lifecycle, M52 owns permissions and M53 owns evidence-based ranking — none of them is pre-built here.**

Plan-time errata, every one read out of the code and baked into the tasks below. The long form, with file and line evidence, is in the session notes (`m47-plan-notes.md`); each is also to be appended to the spec's §4 during execution.

- **E1 (amends R1) — `Capability.role` is NOT NULL, and the derivation is therefore total.** R2 says `requiredRole` is derived from "the first required capability whose role is set", which implies a capability may have none. It must not. Both loaders DROP a task whose `requiredRole` is null (`apps/orchestrator/src/world.ts:194`, `packages/control/src/supervisorWorld.ts:481`), so a task that declared capabilities and derived no role would be invisible to the scheduler AND to the Supervisor — unschedulable *and* unstaffable, with no situation raised about it. `role` is a required column, the seed list gives every key one, and `addCapability` requires one.
- **E2 (amends R2/R3) — the plan graph's `role` must become OPTIONAL, or the derivation is unreachable.** `planTaskSchema.role` is `z.string().min(1)` (`packages/domain/src/planning/graph.ts:21`), so every parsed plan task has a non-empty role; combined with R2's "when both exist the role wins", `requiredRole` would ALWAYS be the planner's literal and R7's "assert the derived `requiredRole`" could never pass. `role` becomes `z.string().min(1).optional()`, and "a task must carry a role or at least one capability" is checked in `validateStructure` (and `validateDelta`) beside the duplicate-key check — not in the zod shape, because `parsePlanGraph` falls back to an earlier candidate on a SHAPE failure and rejects outright on a STRUCTURE failure, and a graph that named neither is a graph the planner got wrong.
- **E3 (amends R3) — the taxonomy keys cannot go into `PLANNING_GRAPH_INSTRUCTIONS`/`REPLAN_INSTRUCTIONS`.** Both are pure, static constants; `packages/domain/test/run-context/render.test.ts:111` pins the first byte-for-byte against its pre-M37 source, and the fake CLI selects its planning, re-plan and review arms on the literals `"task graph"`, `"replan"` and `"verdict"` inside them. The keys are also per-workspace data, which a constant in `packages/domain` cannot read. They become a new run-context SECTION, `capabilities`, built by `apps/orchestrator/src/runContext.ts` (which may read Prisma) and rendered LAST in `SECTION_ORDER.planning` so it sits directly above the trailer. Its text must contain none of `"verdict"`, `"replan"` or `"task graph"` (quoted), and a test pins that: a first-plan prompt carrying `"replan"` would be answered with a delta fixture.
- **E4 (amends §2) — a new situation kind is a POSTGRES ENUM value, not just a TypeScript union member.** `SupervisorSituationKind` is a real enum (`packages/db/prisma/schema.prisma:727`) that `SupervisorDecision.situationKind` is typed on. The migration needs `ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'capability_unstaffed';`, the idiom `20260910120000_m40_requirement_versioning/migration.sql:42` used for `stale_task`. Enum member ORDER may differ between `schema.prisma` and the appended value — m40 proves `prisma migrate diff` reports no difference over that.
- **E5 (amends R7) — M47 gets its OWN fixture catalog, `scripts/fixtures/catalog-m47/`.** `scripts/gate-m46-workforce-catalog.mjs` asserts `byName.size === 4` and a `catalog-count` of `'4 templates'` over `scripts/fixtures/catalog-m46/`; adding a `Security Reviewer` persona to that directory breaks the M46 gate on both. The new directory follows M46's E16 shape (`divisions.json`, `LICENSE` whose first line is `MIT License`, personas in this project's vocabulary) and its persona names are distinct from every other fixture catalog's, because `SlaveTemplate.name` is globally unique and a crashed sibling gate would otherwise make this one skip `name_taken`.
- **E6 (amends R6) — the four-tab strip is pinned in two places and both change in Task 4.** `scripts/gate-m44-ux-foundation.mjs:614` asserts the project tablist is exactly `["Overview","Tasks","Activity","Settings"]` and `apps/web/test/project-tabs.test.tsx:19` asserts the same list and its hrefs. `Organization` goes between Tasks and Activity, and both assertions move with it in the same commit.
- **E7 (amends R6/R7) — the fidelity screenshots DO change, and M47 regenerates them in their own commit.** Six of `gate-m14-fidelity`'s pages are project pages, and every one of them renders the tab strip, so a fifth tab changes `overview.png`, `tasks.png`, `activity.png`, `graph.png`, `office.png` and `project-settings.png`. They are regenerated ALONE, in a deliberate commit (M45 Task 5's precedent), and `organization` joins `PAGES` (not `LIVE_PAGES`) so the new surface has committed evidence too.
- **E8 (amends R4) — "unstaffed" means "nobody holds the projected ROLE", and supersession is per TASK.** If the predicate were "nobody has the capability", the `assign_capability` arm — an existing worker who PROVIDES the capability but was never given its runtime role — could never fire, because that capability would read as covered. So: `capability_unstaffed(cap)` fires when some `ready` + `dependenciesDone` task requires `cap` and no slave holds `roleOf(cap)`. A ready task that raised at least one capability situation is then skipped by the `ready_unstaffed` grouping — that is the whole of "supersedes"; a task with no capabilities, or one whose capabilities are all staffed but whose role is unheld, still raises `ready_unstaffed` exactly as today.
- **E9 (amends R4) — the four existing staffing arms of `candidates()` are untouched, and `set_runtime_roles` stays at index 0.** `scripts/gate-m38-supervisor.mjs` answers every decision with `candidateIndex: 0` from the `supervisor-decision` fixture and asserts that the ONE offer on a `no_reviewer` situation is `set_runtime_roles` on `Dev`. Adding an offer to `no_reviewer`, `no_planner`, `ready_unstaffed` or `unanswerable_question` would change what that gate approves. The three new actions are offered under `capability_unstaffed` and nowhere else.
- **E10 (amends R4) — one pass decides EVERY fresh situation, so two capability situations can propose the same template.** `apps/orchestrator/src/supervisor.ts:224` loops over all of them in one tick. `hireFromTemplate` therefore REUSES an existing project slave already materialised from that template in that workspace (adding the missing capabilities and roles to it) instead of creating a second worker, and its report says `reused: true`. That is what keeps "the minimal team" minimal across two separate approvals.
- **E11 (amends R5) — collaboration hints are resolved in a SECOND pass, after every row of an import is written.** A hint naming a persona that appears later in the same run cannot resolve inside the per-row transaction. `importCatalog` writes hints once at the end, over the full `{id, name}` list, replacing each written template's hints (`deleteMany` + `createMany` under `@@unique([templateId, text])`) so a re-import never doubles them.
- **E12 (amends R1/R5) — matching is EXACT after normalisation; nothing is fuzzy.** `normaliseCapabilities` lowercases, collapses whitespace, maps `-`/`_`/`.` runs to a single space and strips trailing punctuation, then matches the whole string against the key, the label and each synonym. No substring matching: two synonyms could otherwise match one bullet and the result would depend on iteration order. A hint SENTENCE is different — nothing there is ever equal to a label — so `normaliseCollaborationHint` scans it for a whole-phrase occurrence of a key, a label or a synonym of at least four characters, takes the LONGEST match and breaks ties on key ascending.
- **E13 (amends R1) — the seed writes the taxonomy, and the truncate list has to know about the two new tables.** `packages/db/src/seed.ts` truncates an explicit table list; `Capability` and `CollaborationHint` join it, and the seed writes `CAPABILITY_SEED` straight through Prisma (the list lives in `packages/db/src/capabilities.ts`, which `packages/control`'s `syncCapabilityTaxonomy` imports — `packages/domain` never sees it, because the domain functions take the taxonomy as data).
- **E14 (amends R3) — `workspace.plan_created` and `workspace.replanned` both gain `droppedCapabilities`.** The event payload schemas are closed zod objects (`packages/domain/src/events/schema.ts:226`), so the field is added explicitly and optionally to both — a re-plan that dropped an unknown key must be as readable as a first plan that did. `tasks[].role` in that payload stays `z.string().min(1)`: what is written there is the task's STORED `requiredRole`, which E1 and E2 together make a non-empty string for every task a plan creates.
- **E15 — two new refusal kinds, each with its three homes.** `capability_not_found` (`{ key }`) and `invalid_capability` (`{ detail }`) go into `ControlRefusal` (`packages/control/src/refusal.ts`), into `refusalText`, and into `apps/web/test/refusal-status.test.ts`'s `ALL_KINDS` (a `Record<ControlRefusal['kind'], true>`, so a missing key fails the typecheck). `refusalStatus` derives 404 from the `_not_found` suffix alone, so the first is 404 and the second 409 with no code change.
- **E16 (amends R4) — the Supervisor's world grows three fields and the shared fixtures default them.** `SupervisorSlave` gains `capabilities`, `SupervisorWorld` gains `company` and `catalog`. `packages/domain/test/supervisor/fixtures.ts` gives all three a default (`[]`), so every existing supervisor test compiles and passes unchanged.
- **E17 (amends R6) — `docs/ia.md` is wrong about who lifts the org graph.** Its `/w/:id` and `/w/:id/graph` rows say "M46 lifts the org mode's content into an Organization tab"; M46's spec scope is the catalog and it did not. Both rows are corrected to M47, and a new `/w/:id/organization` row is added to the project-surfaces table.

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`; the browser gates need `SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh"`.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first.
- **No prettier.** There is no prettier config in this repository; match the surrounding file's style by hand.
- Inside `apps/web`, import siblings **without** a `.js` suffix (`../server/org`, not `../server/org.js`); `packages/*` keep the `.js` suffix.
- Read an exit code with `${PIPESTATUS[0]}`; never `cmd | tail; echo $?` — that reports `tail`'s status.
- After `npm run db:generate`, run `npx tsc --build` **before** any integration test: the generated client's types are what the test files compile against.
- **No product string names the reference catalog** (M42 E5). Every example is `catalog-m47` or "a directory of persona files".
- The vocabulary word is **slave**, fixtures included. `npm run gate:m26-vocabulary` after every task.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**, or Prisma commits that write.
- **`decide()` is unchanged.** `packages/domain/src/scheduler/decide.ts` keeps one matching rule (`runtimeRoles.includes(requiredRole)`) and `packages/domain/test/scheduler/decide.test.ts` keeps every assertion it has.
- **Migrations are additive and applied to both databases** (`npm run db:migrate` and `npm run db:migrate:test`) with the Prisma 7 diff proof: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` → "No difference detected".
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Web tasks also run `npm run web:build` (subject to the `next dev` rule above) and `npm run gate:m44-ux-foundation` as the browser check.
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`. Component tests are `*.test.tsx` under `apps/web/test/` with a `// @vitest-environment jsdom` first line.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/capability/taxonomy.ts      R1/R2: CapabilityKey, CapabilityRecord, capabilityKeySchema,
                                                normaliseCapabilityText, normaliseCapabilities, projectRoles,
                                                capabilityIndex, capabilityLabel, CAPABILITY_DOMAIN_LABEL (new)
packages/domain/src/capability/hints.ts         R5: CollaborationHintDraft, normaliseCollaborationHint (new)
packages/domain/src/capability/team.ts          R4: TeamInput, TeamPlan, formTeam (new)
packages/domain/src/capability/index.ts         (new) -- ./taxonomy.js, ./hints.js, ./team.js
packages/domain/src/index.ts                    + ./capability/index.js
packages/domain/src/planning/graph.ts           R3/E2: capabilities?, role optional, the role-or-capability check
packages/domain/src/planning/delta.ts           R3/E2: the same check on an `add` entry
packages/domain/src/run-context/sections.ts     E3: the `capabilities` SectionKind and its SectionSource
packages/domain/src/run-context/render.ts       E3: SECTION_ORDER.planning gains `capabilities`, last
packages/domain/src/events/schema.ts            E14: droppedCapabilities on plan_created and replanned
packages/domain/src/supervisor/situations.ts    R4/E4: capability_unstaffed + its label
packages/domain/src/supervisor/observe.ts       R4/E8: the predicate, and ready_unstaffed's per-task skip
packages/domain/src/supervisor/actions.ts       R4: three ActionKinds, their schemas, ACTION_LABEL
packages/domain/src/supervisor/candidates.ts    R4: the capability_unstaffed arm
packages/domain/src/supervisor/policy.ts        R4: tierOf for the three new kinds
packages/domain/src/supervisor/world.ts         E16: SupervisorSlave.capabilities, world.company, world.catalog
packages/domain/test/capability/{taxonomy,hints,team}.test.ts        (new)
packages/domain/test/planning/graph.test.ts, delta.test.ts           + capabilities/optional-role cases
packages/domain/test/run-context/render.test.ts                      + the capabilities section's order
packages/domain/test/supervisor/{fixtures.ts,observe,candidates,policy}.test.ts   updated/extended
packages/domain/test/events/schema.test.ts                           + droppedCapabilities

packages/db/src/capabilities.ts                 R1: CAPABILITY_SEED, the checked-in taxonomy (new)
packages/db/src/index.ts                        + ./capabilities.js
packages/db/src/seed.ts                         E13: truncate list + taxonomy write
packages/db/prisma/schema.prisma                R1: Capability, CollaborationHint, four column additions,
                                                the SupervisorSituationKind member
packages/db/prisma/migrations/20260911140000_m47_capabilities/migration.sql   (new)

packages/control/src/capability.ts              R1/R4: syncCapabilityTaxonomy, addCapability, listCapabilities,
                                                setSlaveCapabilities, materialiseCompanySlave, hireFromTemplate,
                                                listOrganization (new)
packages/control/src/catalog.ts                 R1/R5: the importer normalises capabilities and writes hints
packages/control/src/org.ts                     R2: assignCompanyTx projects roles and copies capabilities
packages/control/src/supervisor.ts              R4: the three applyDecision arms
packages/control/src/supervisorWorld.ts         R4/E16: roster capabilities, the company roster, the catalog index
packages/control/src/refusal.ts                 E15: two kinds
packages/control/test/integration/capability.test.ts     (new)
packages/control/test/integration/{catalog,org,supervisor}.test.ts  extended

apps/orchestrator/src/planning.ts               R3: requiredCapabilities + the derived role + droppedCapabilities
apps/orchestrator/src/replan.ts                 R3: the same on a delta's `add`
apps/orchestrator/src/runContext.ts             E3: the `capabilities` section
apps/orchestrator/src/cli.ts                    §2: capabilities sync|add|list, set-capabilities, hire
apps/orchestrator/test/integration/{planning,runContext,cli}.test.ts  extended

apps/web/src/server/organization.ts             R6: buildOrganization (new)
apps/web/src/app/w/[workspaceId]/organization/page.tsx                (new)
apps/web/src/app/api/w/[workspaceId]/organization/route.ts            (new)
apps/web/src/components/organization/OrganizationClient.tsx           (new)
apps/web/src/components/organization/CapabilityChips.tsx              (new)
apps/web/src/components/project/ProjectTabs.tsx                       R6/E6: the fifth tab
apps/web/src/components/SupervisorPanel.tsx                           R4: actionText's three new arms
apps/web/src/components/workforce/ProfileDrawer.tsx                   §2: capability chips resolved to labels
apps/web/src/server/org.ts                                            listCapabilities for the catalog page
apps/web/src/app/workforce/page.tsx                                   the taxonomy passed once
apps/web/test/organization-page.test.tsx                              (new)
apps/web/test/integration/organization.test.ts                        (new)
apps/web/test/{project-tabs,supervisor-panel,workforce-catalog}.test.tsx   E6 and the new labels
apps/web/test/refusal-status.test.ts                                  E15

packages/providers/test/fake-claude.mjs         D7: --plan-fixture on m8-flow's planning arm
packages/providers/test/fixtures/plan-graph-capabilities.ndjson       (new)
packages/providers/test/fake-claude.test.ts     + the new arm
scripts/fixtures/catalog-m47/                   E5 (new): divisions.json, LICENSE, two personas
scripts/gate-m47-team-formation.mjs             R7 (new)
scripts/gate-m14-fidelity.mjs                   E7: `organization` in PAGES
scripts/gate-m44-ux-foundation.mjs              E6: the five-tab assertion
package.json, .github/workflows/ci.yml, README.md, docs/ia.md         R7/E17
docs/superpowers/fidelity/m14/*.png             E7, regenerated in their own commit
```

---

### Task 1: The taxonomy, the projection, team formation and the plan graph's capabilities (R1–R5, E1, E2, E3, E12, E13)

**Files:**
- Create: `packages/domain/src/capability/taxonomy.ts`, `packages/domain/src/capability/hints.ts`, `packages/domain/src/capability/team.ts`, `packages/domain/src/capability/index.ts`, `packages/db/src/capabilities.ts`
- Create: `packages/db/prisma/migrations/20260911140000_m47_capabilities/migration.sql`
- Modify: `packages/domain/src/index.ts`, `packages/domain/src/planning/graph.ts`, `packages/domain/src/planning/delta.ts`, `packages/domain/src/run-context/sections.ts`, `packages/domain/src/run-context/render.ts`, `packages/domain/src/events/schema.ts`, `packages/db/src/index.ts`, `packages/db/src/seed.ts`, `packages/db/prisma/schema.prisma`
- Test: `packages/domain/test/capability/taxonomy.test.ts`, `packages/domain/test/capability/hints.test.ts`, `packages/domain/test/capability/team.test.ts`, `packages/domain/test/planning/graph.test.ts`, `packages/domain/test/planning/delta.test.ts`, `packages/domain/test/run-context/render.test.ts`, `packages/domain/test/events/schema.test.ts`

**Interfaces:**
- Consumes: `zod`; `Result`/`ok`/`err` (`packages/domain/src/result.js`); `PlanTask`/`planGraphSchema`/`findCycle` (`packages/domain/src/planning/graph.ts`); `SectionKind`/`SectionSource` (`packages/domain/src/run-context/sections.ts`).
- Produces, for Tasks 2–5:
  - `type CapabilityKey = string`; `CAPABILITY_KEY_PATTERN: RegExp`; `capabilityKeySchema: z.ZodType<string>`
  - `interface CapabilityRecord { key: CapabilityKey; label: string; domain: string; role: string; synonyms: readonly string[] }`
  - `normaliseCapabilityText(value: string): string`
  - `normaliseCapabilities(values: readonly string[], taxonomy: readonly CapabilityRecord[]): { keys: readonly CapabilityKey[]; unresolved: readonly string[] }`
  - `projectRoles(keys: readonly CapabilityKey[], taxonomy: readonly CapabilityRecord[]): readonly string[]`
  - `capabilityIndex(taxonomy: readonly CapabilityRecord[]): ReadonlyMap<CapabilityKey, CapabilityRecord>`
  - `capabilityLabel(key: CapabilityKey, taxonomy: readonly CapabilityRecord[]): string`
  - `interface CollaborationHintDraft { text: string; targetTemplateId: string | null; capability: CapabilityKey | null }`, `normaliseCollaborationHint(sentence, templates, taxonomy): CollaborationHintDraft`
  - `interface TeamRosterMember { slaveId: string; name: string; capabilities: readonly CapabilityKey[]; runtimeRoles: readonly string[]; busy: boolean }`
  - `interface TeamCompanyWorker { companySlaveId: string; name: string; capabilities: readonly CapabilityKey[] }`
  - `interface TeamCatalogEntry { templateId: string; name: string; capabilities: readonly CapabilityKey[]; division: string | null }`
  - `interface TeamInput { required: readonly CapabilityKey[]; roster: readonly TeamRosterMember[]; company: readonly TeamCompanyWorker[]; catalog: readonly TeamCatalogEntry[]; taxonomy: readonly CapabilityRecord[]; recommendedTemplateIds?: readonly string[] }`
  - `type TeamSource = 'existing_worker' | 'company_worker' | 'project_worker' | 'temporary'`
  - `interface TeamProposal { capability: CapabilityKey; source: TeamSource; pick: { kind: 'slave' | 'company_slave' | 'template'; id: string; name: string }; covers: readonly CapabilityKey[]; temporary: boolean; rationale: string }`
  - `interface TeamPlan { covered: readonly { capability: CapabilityKey; by: string }[]; proposals: readonly TeamProposal[]; unfillable: readonly CapabilityKey[] }`, `formTeam(input: TeamInput): TeamPlan`
  - `CAPABILITY_SEED: readonly CapabilityRecord[]` from `@slave-of-ai/db`
  - `PlanTask.capabilities: readonly string[]`, `PlanTask.role: string | undefined`
  - Columns: `Capability`, `CollaborationHint`, `Task.requiredCapabilities`, `Slave.capabilities`, `Slave.selectionRationale`, `Slave.hiredFromTemplateId`, `SlaveTemplate.capabilityKeys`, `SlaveTemplate.unresolvedCapabilities`, and the `capability_unstaffed` member of `SupervisorSituationKind`

- [ ] **Step 1: Write the failing test for the taxonomy and the projection**

`packages/domain/test/capability/taxonomy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_KEY_PATTERN,
  capabilityLabel,
  normaliseCapabilities,
  normaliseCapabilityText,
  projectRoles,
  type CapabilityRecord,
} from '../../src/capability/taxonomy.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: ['api architecture', 'rest design'] },
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: ['appsec', 'secure code review'] },
  { key: 'review.code-review', label: 'Code review', domain: 'review', role: 'reviewer', synonyms: [] },
]

describe('normaliseCapabilityText', () => {
  it('lowercases, collapses whitespace and treats separators as spaces', () => {
    expect(normaliseCapabilityText('  API   Design ')).toBe('api design')
    expect(normaliseCapabilityText('secure_code-review')).toBe('secure code review')
    expect(normaliseCapabilityText('Application security.')).toBe('application security')
  })

  // A dotted KEY has to survive the same normaliser, or an exact key match could never happen.
  it('keeps a dotted key recognisable by mapping its dot to a space too', () => {
    expect(normaliseCapabilityText('backend.api-design')).toBe('backend api design')
  })
})

describe('normaliseCapabilities', () => {
  it('resolves an exact key, a label and a synonym, and keeps everything else unresolved', () => {
    const out = normaliseCapabilities(
      ['backend.api-design', 'Application security', 'appsec', 'Vibes and enthusiasm'],
      TAXONOMY,
    )
    // `appsec` is a second spelling of a key already resolved: the keys are a SET, in first-seen
    // order, so a persona that says the same thing twice does not get the capability twice.
    expect(out.keys).toEqual(['backend.api-design', 'security.application'])
    expect(out.unresolved).toEqual(['Vibes and enthusiasm'])
  })

  it('never matches on a substring', () => {
    const out = normaliseCapabilities(['Threat modelling for application security reviews'], TAXONOMY)
    expect(out.keys).toEqual([])
    expect(out.unresolved).toEqual(['Threat modelling for application security reviews'])
  })

  it('drops blank entries rather than reporting them as unresolved', () => {
    expect(normaliseCapabilities(['   ', ''], TAXONOMY)).toEqual({ keys: [], unresolved: [] })
  })
})

describe('projectRoles', () => {
  it('is the roles of the known keys, deduplicated and sorted', () => {
    expect(projectRoles(['review.code-review', 'backend.api-design', 'security.application'], TAXONOMY)).toEqual([
      'backend',
      'reviewer',
      'security',
    ])
  })

  it('ignores a key the taxonomy does not have', () => {
    expect(projectRoles(['nope.nothing'], TAXONOMY)).toEqual([])
  })
})

describe('capabilityLabel', () => {
  it('falls back to the key itself, so a surface never renders an empty chip', () => {
    expect(capabilityLabel('backend.api-design', TAXONOMY)).toBe('API design')
    expect(capabilityLabel('nope.nothing', TAXONOMY)).toBe('nope.nothing')
  })
})

describe('CAPABILITY_KEY_PATTERN', () => {
  it('is <domain>.<name>, both dash-separated lower case', () => {
    expect(CAPABILITY_KEY_PATTERN.test('backend.api-design')).toBe(true)
    expect(CAPABILITY_KEY_PATTERN.test('Backend.API')).toBe(false)
    expect(CAPABILITY_KEY_PATTERN.test('backend')).toBe(false)
    expect(CAPABILITY_KEY_PATTERN.test('backend.api.design')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/capability/taxonomy.test.ts`
Expected: FAIL — `Cannot find module '../../src/capability/taxonomy.js'`.

- [ ] **Step 3: Write `packages/domain/src/capability/taxonomy.ts`**

```ts
import { z } from 'zod'

/**
 * A capability key: `<domain>.<name>`, both halves lower-case and dash-separated (M47 R1).
 *
 * A plain `string` alias rather than a branded type: these values cross a `String[]` Postgres
 * column, a JSON plan graph and a fetch response, and every one of those hands back a `string`.
 * The pattern below, `capabilityKeySchema` and the taxonomy table are what actually bound it --
 * NOTHING matches on a key that is not in the table (R1).
 */
export type CapabilityKey = string

export const CAPABILITY_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/

export const capabilityKeySchema = z.string().regex(CAPABILITY_KEY_PATTERN, 'a capability key looks like <domain>.<name>')

/**
 * One row of the taxonomy, as the pure functions here see it. The DATA lives in a table
 * (`packages/db/src/capabilities.ts` seeds it, `syncCapabilityTaxonomy` keeps it in step); nothing
 * in `packages/domain` reads a database, so every function below takes the taxonomy as an
 * argument. That is also what makes each of them a one-line fixture in a test.
 *
 * `role` is NOT nullable (plan erratum E1): a task that declared capabilities and derived no role
 * would be dropped by BOTH loaders -- unschedulable and unstaffable at once, with no situation
 * raised about it.
 */
export interface CapabilityRecord {
  readonly key: CapabilityKey
  readonly label: string
  readonly domain: string
  readonly role: string
  readonly synonyms: readonly string[]
}

/**
 * The one normalisation both sides of a match go through (plan erratum E12).
 *
 * Lower-cased, every run of whitespace or `-`/`_`/`.` reduced to ONE space, and trailing
 * punctuation removed -- so `backend.api-design`, `API Design` and `api_design.` are the same
 * string here and a persona bullet does not miss its key over a full stop. Deliberately NOT a
 * stemmer and deliberately not applied to substrings: an inexact match would depend on the order
 * the taxonomy came back in, and this repository's rule is that the same input always produces the
 * same output.
 */
export function normaliseCapabilityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_\-.]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .trim()
}

export interface NormalisedCapabilities {
  /** The resolved keys, deduplicated, in the order they were first seen. */
  readonly keys: readonly CapabilityKey[]
  /** Every non-blank input that matched nothing, verbatim -- kept beside the row it came from
   *  (`SlaveTemplate.unresolvedCapabilities`) so an operator can see what the taxonomy is missing
   *  rather than losing the words the persona used. An unresolved string never matches anything. */
  readonly unresolved: readonly string[]
}

/**
 * Free text -> taxonomy keys (R2): the exact key, then the exact label, then an exact synonym,
 * every comparison made on {@link normaliseCapabilityText}'s output.
 *
 * Blank entries are dropped rather than reported: a persona with a stray empty bullet has not
 * named a capability the taxonomy is missing.
 */
export function normaliseCapabilities(
  values: readonly string[],
  taxonomy: readonly CapabilityRecord[],
): NormalisedCapabilities {
  const byText = new Map<string, CapabilityKey>()
  for (const record of taxonomy) {
    for (const spelling of [record.key, record.label, ...record.synonyms]) {
      const text = normaliseCapabilityText(spelling)
      // First spelling wins, so a synonym one row borrowed from another cannot hijack the key that
      // OWNS that word -- and the taxonomy's own order (key ascending, everywhere it is loaded) is
      // what decides.
      if (text !== '' && !byText.has(text)) byText.set(text, record.key)
    }
  }

  const keys: CapabilityKey[] = []
  const unresolved: string[] = []
  for (const value of values) {
    const text = normaliseCapabilityText(value)
    if (text === '') continue
    const key = byText.get(text)
    if (key === undefined) {
      if (!unresolved.includes(value)) unresolved.push(value)
      continue
    }
    if (!keys.includes(key)) keys.push(key)
  }
  return { keys, unresolved }
}

/** THE projection (R2): the runtime roles a set of capabilities makes a worker dispatchable as.
 *  Deduplicated and sorted, so a materialised worker's `runtimeRoles` are the same list whatever
 *  order its capabilities were written in. A key the taxonomy does not have projects nothing --
 *  matching on a key nobody defined is exactly what R1 forbids. */
export function projectRoles(
  keys: readonly CapabilityKey[],
  taxonomy: readonly CapabilityRecord[],
): readonly string[] {
  const index = capabilityIndex(taxonomy)
  const roles = new Set<string>()
  for (const key of keys) {
    const record = index.get(key)
    if (record !== undefined) roles.add(record.role)
  }
  return [...roles].sort()
}

export function capabilityIndex(taxonomy: readonly CapabilityRecord[]): ReadonlyMap<CapabilityKey, CapabilityRecord> {
  return new Map(taxonomy.map((record) => [record.key, record] as const))
}

/** What a person reads instead of the key. Falls back to the key so a chip is never empty: a row
 *  written by a newer build can carry a key this bundle's taxonomy has never heard of, and the key
 *  itself is the honest thing to show (the `SITUATION_LABEL` fallback idiom, M44 R5). */
export function capabilityLabel(key: CapabilityKey, taxonomy: readonly CapabilityRecord[]): string {
  return capabilityIndex(taxonomy).get(key)?.label ?? key
}
```

`packages/domain/src/capability/index.ts`:

```ts
export * from './taxonomy.js'
export * from './hints.js'
export * from './team.js'
```

and `export * from './capability/index.js'` is appended to `packages/domain/src/index.ts` after the `./catalog/index.js` line.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/capability/taxonomy.test.ts`
Expected: PASS (10 assertions across 8 tests).

- [ ] **Step 5: Write the failing test for the collaboration-hint normaliser**

`packages/domain/test/capability/hints.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { normaliseCollaborationHint } from '../../src/capability/hints.js'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: ['appsec'] },
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: [] },
]

const TEMPLATES = [
  { id: 'tpl-core', name: 'Gate Platform Builder' },
  { id: 'tpl-sec', name: 'Gate Security Reviewer' },
]

describe('normaliseCollaborationHint', () => {
  it('resolves the target by template name, case-insensitively, and keeps the sentence verbatim', () => {
    const hint = normaliseCollaborationHint(
      'Gate Platform Builder: consult them before you change an endpoint.',
      TEMPLATES,
      TAXONOMY,
    )
    expect(hint.text).toBe('Gate Platform Builder: consult them before you change an endpoint.')
    expect(hint.targetTemplateId).toBe('tpl-core')
  })

  it('finds the capability the sentence is about, by label or synonym', () => {
    expect(normaliseCollaborationHint('Pair with them on application security work.', TEMPLATES, TAXONOMY).capability)
      .toBe('security.application')
    expect(normaliseCollaborationHint('Hand off appsec findings.', TEMPLATES, TAXONOMY).capability)
      .toBe('security.application')
  })

  // The real corpus mostly names a ROLE, not a persona ("escalate to the billing attorney"), so
  // an unresolved hint is the ordinary case and must still be a hint.
  it('is still a hint when nothing resolves', () => {
    const hint = normaliseCollaborationHint('Escalate to the process owner immediately.', TEMPLATES, TAXONOMY)
    expect(hint).toEqual({
      text: 'Escalate to the process owner immediately.',
      targetTemplateId: null,
      capability: null,
    })
  })

  it('prefers the LONGEST matching name, so one title inside another cannot win', () => {
    const templates = [{ id: 'a', name: 'Gate Security Reviewer' }, { id: 'b', name: 'Security' }]
    expect(normaliseCollaborationHint('Consult the Gate Security Reviewer.', templates, TAXONOMY).targetTemplateId).toBe('a')
  })

  it('matches a whole phrase only, so "apidesigner" is not API design', () => {
    expect(normaliseCollaborationHint('Ask the apidesigner.', TEMPLATES, TAXONOMY).capability).toBeNull()
  })
})
```

- [ ] **Step 6: Run it and watch it fail, then write `packages/domain/src/capability/hints.ts`**

Run: `npx vitest run packages/domain/test/capability/hints.test.ts` → FAIL (module not found).

```ts
import { capabilityIndex, normaliseCapabilityText, type CapabilityKey, type CapabilityRecord } from './taxonomy.js'

/**
 * One persona sentence, turned into an ADVISORY edge (M47 R5).
 *
 * `text` is the sentence exactly as M46's mapper stored it -- M46 kept collaboration hints verbatim
 * precisely so this milestone could trace one back to the persona that wrote it. Nothing here ever
 * dispatches: an edge is shown on a profile and on the Organization view, it breaks a tie in
 * {@link formTeam}'s rationale, and that is the whole of its authority.
 */
export interface CollaborationHintDraft {
  readonly text: string
  /** The template the sentence names, when it names one at all. NULL is the ORDINARY case: most
   *  real handoff sentences name a generic role ("escalate to the process owner") rather than a
   *  persona, and an edge to nobody is still a sentence a person can read. */
  readonly targetTemplateId: string | null
  readonly capability: CapabilityKey | null
}

/** A whole-phrase, case-insensitive occurrence test over normalised text -- `apidesigner` does not
 *  contain `api design`, and `Consult the Gate Security Reviewer.` does contain
 *  `gate security reviewer`. Both sides go through the same normaliser, so punctuation and
 *  separators cannot decide a match. */
function containsPhrase(haystack: string, phrase: string): boolean {
  if (phrase === '') return false
  const index = haystack.indexOf(phrase)
  if (index === -1) return false
  const before = index === 0 ? ' ' : haystack[index - 1]
  const after = index + phrase.length >= haystack.length ? ' ' : haystack[index + phrase.length]
  return before === ' ' && after === ' '
}

/** How short a spelling may be before it is too short to search a whole sentence for. Two-letter
 *  synonyms would match half the corpus; four characters is the shortest real one in the seed
 *  taxonomy (`ci-cd` normalises to `ci cd`). */
const MIN_SEARCHABLE = 4

/**
 * Normalise one hint (R5). The TARGET is the longest template name the sentence contains (ties on
 * id ascending); the CAPABILITY is the longest key/label/synonym it contains (ties on key
 * ascending). Longest-wins is what stops a template called `Security` from taking a sentence that
 * named the `Gate Security Reviewer`, and the tie-breaks are what make the result the same on
 * every run.
 *
 * CALLER CONTRACT: `templates` must not contain the template the hint belongs to -- a persona that
 * mentions its own title would otherwise advise consulting itself.
 */
export function normaliseCollaborationHint(
  sentence: string,
  templates: readonly { readonly id: string; readonly name: string }[],
  taxonomy: readonly CapabilityRecord[],
): CollaborationHintDraft {
  const haystack = ` ${normaliseCapabilityText(sentence)} `

  let target: { id: string; length: number } | null = null
  for (const template of [...templates].toSorted((a, b) => a.id.localeCompare(b.id))) {
    const name = normaliseCapabilityText(template.name)
    if (name.length < MIN_SEARCHABLE || !containsPhrase(haystack, name)) continue
    if (target === null || name.length > target.length) target = { id: template.id, length: name.length }
  }

  let capability: { key: CapabilityKey; length: number } | null = null
  for (const record of [...capabilityIndex(taxonomy).values()].toSorted((a, b) => a.key.localeCompare(b.key))) {
    for (const spelling of [record.key, record.label, ...record.synonyms]) {
      const text = normaliseCapabilityText(spelling)
      if (text.length < MIN_SEARCHABLE || !containsPhrase(haystack, text)) continue
      if (capability === null || text.length > capability.length) capability = { key: record.key, length: text.length }
    }
  }

  return {
    text: sentence,
    targetTemplateId: target?.id ?? null,
    capability: capability?.key ?? null,
  }
}
```

Run: `npx vitest run packages/domain/test/capability/hints.test.ts` → PASS.

- [ ] **Step 7: Write the failing test for `formTeam`**

`packages/domain/test/capability/team.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formTeam, type TeamInput } from '../../src/capability/team.js'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: [] },
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: [] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'qa', synonyms: [] },
]

const input = (overrides: Partial<TeamInput> = {}): TeamInput => ({
  required: [],
  roster: [],
  company: [],
  catalog: [],
  taxonomy: TAXONOMY,
  ...overrides,
})

describe('formTeam', () => {
  it('calls a capability covered when somebody already holds the role it projects to', () => {
    const plan = formTeam(
      input({
        required: ['backend.api-design'],
        roster: [{ slaveId: 's1', name: 'Alex', capabilities: ['backend.api-design'], runtimeRoles: ['backend'], busy: false }],
      }),
    )
    expect(plan.covered).toEqual([{ capability: 'backend.api-design', by: 's1' }])
    expect(plan.proposals).toEqual([])
    expect(plan.unfillable).toEqual([])
  })

  it('offers the existing capable worker first when they have the capability but not the role', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        roster: [
          { slaveId: 's2', name: 'Rae', capabilities: ['security.application'], runtimeRoles: ['backend'], busy: false },
          { slaveId: 's1', name: 'Alex', capabilities: [], runtimeRoles: ['backend'], busy: false },
        ],
        company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('existing_worker')
    expect(plan.proposals[0]?.pick).toEqual({ kind: 'slave', id: 's2', name: 'Rae' })
    expect(plan.proposals[0]?.rationale).toContain('Application security')
  })

  it('prefers a company worker over the catalog', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals.map((p) => p.source)).toEqual(['company_worker'])
    expect(plan.proposals[0]?.pick.id).toBe('cs1')
  })

  // THE minimality rule the milestone is named for.
  it('picks one template covering two missing capabilities over two covering one each', () => {
    const plan = formTeam(
      input({
        required: ['security.application', 'qa.test-automation'],
        catalog: [
          { templateId: 'tpl-sec', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' },
          { templateId: 'tpl-qa', name: 'Test Engineer', capabilities: ['qa.test-automation'], division: 'testing' },
          { templateId: 'tpl-both', name: 'Security Test Engineer', capabilities: ['security.application', 'qa.test-automation'], division: 'security' },
        ],
      }),
    )
    expect(plan.proposals).toHaveLength(2)
    expect(new Set(plan.proposals.map((p) => p.pick.id))).toEqual(new Set(['tpl-both']))
    expect(plan.proposals[0]?.covers).toEqual(['qa.test-automation', 'security.application'])
    expect(plan.proposals.every((p) => p.source === 'project_worker')).toBe(true)
  })

  it('breaks a coverage tie on a template a worker profile recommends, and says so', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        catalog: [
          { templateId: 'tpl-a', name: 'A Reviewer', capabilities: ['security.application'], division: 'security' },
          { templateId: 'tpl-b', name: 'B Reviewer', capabilities: ['security.application'], division: 'security' },
        ],
        recommendedTemplateIds: ['tpl-b'],
      }),
    )
    expect(plan.proposals[0]?.pick.id).toBe('tpl-b')
    expect(plan.proposals[0]?.rationale).toContain('recommends')
  })

  it('reports what nobody anywhere provides, and proposes nothing for it', () => {
    const plan = formTeam(input({ required: ['qa.test-automation', 'security.application'], catalog: [] }))
    expect(plan.proposals).toEqual([])
    expect(plan.unfillable).toEqual(['qa.test-automation', 'security.application'])
  })

  it('is deterministic: the same world in a different order gives the same plan', () => {
    const one = formTeam(
      input({
        required: ['security.application', 'backend.api-design'],
        catalog: [
          { templateId: 'tpl-b', name: 'B', capabilities: ['security.application'], division: null },
          { templateId: 'tpl-a', name: 'A', capabilities: ['backend.api-design'], division: null },
        ],
      }),
    )
    const two = formTeam(
      input({
        required: ['backend.api-design', 'security.application'],
        catalog: [
          { templateId: 'tpl-a', name: 'A', capabilities: ['backend.api-design'], division: null },
          { templateId: 'tpl-b', name: 'B', capabilities: ['security.application'], division: null },
        ],
      }),
    )
    expect(one).toEqual(two)
  })

  it('never emits the temporary source in this milestone, and never marks a proposal temporary', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals.every((p) => p.source !== 'temporary' && !p.temporary)).toBe(true)
  })
})
```

- [ ] **Step 8: Run it and watch it fail, then write `packages/domain/src/capability/team.ts`**

Run: `npx vitest run packages/domain/test/capability/team.test.ts` → FAIL (module not found).

```ts
import { capabilityLabel, projectRoles, type CapabilityKey, type CapabilityRecord } from './taxonomy.js'

export interface TeamRosterMember {
  readonly slaveId: string
  readonly name: string
  readonly capabilities: readonly CapabilityKey[]
  readonly runtimeRoles: readonly string[]
  readonly busy: boolean
}

export interface TeamCompanyWorker {
  readonly companySlaveId: string
  readonly name: string
  readonly capabilities: readonly CapabilityKey[]
}

export interface TeamCatalogEntry {
  readonly templateId: string
  readonly name: string
  readonly capabilities: readonly CapabilityKey[]
  readonly division: string | null
}

export interface TeamInput {
  /** The capabilities the BOARD needs -- the union over its ready and blocked tasks. */
  readonly required: readonly CapabilityKey[]
  readonly roster: readonly TeamRosterMember[]
  /** The company's roster rows that are NOT already materialised into this project. */
  readonly company: readonly TeamCompanyWorker[]
  readonly catalog: readonly TeamCatalogEntry[]
  readonly taxonomy: readonly CapabilityRecord[]
  /** Templates a current worker's own profile recommends pairing with (R5). A tie-break and a
   *  sentence, never a dispatch. */
  readonly recommendedTemplateIds?: readonly string[]
}

/** Where a proposed worker would come from, in the preference order R4 fixes: an existing capable
 *  worker, an existing company worker, a new project worker, a temporary specialist. `temporary`
 *  is never emitted in M47 -- M50 owns that lifecycle -- and is in the union so the surfaces that
 *  render a source do not have to change again when it arrives. */
export type TeamSource = 'existing_worker' | 'company_worker' | 'project_worker' | 'temporary'

export interface TeamProposal {
  readonly capability: CapabilityKey
  readonly source: TeamSource
  readonly pick: { readonly kind: 'slave' | 'company_slave' | 'template'; readonly id: string; readonly name: string }
  /** Every missing capability this one pick would cover -- what makes "one worker instead of two"
   *  visible to a person rather than implicit in the count. */
  readonly covers: readonly CapabilityKey[]
  /** M50's flag, always false here (R4: "here it is a flag on the proposal"). */
  readonly temporary: boolean
  readonly rationale: string
}

export interface TeamPlan {
  readonly covered: readonly { readonly capability: CapabilityKey; readonly by: string }[]
  readonly proposals: readonly TeamProposal[]
  readonly unfillable: readonly CapabilityKey[]
}

/**
 * The smallest team that covers what the board needs (M47 R4). Pure and deterministic: the same
 * input always produces the same plan, whatever order the caller's queries returned rows in --
 * every list is sorted before it is walked and every tie has a named break.
 *
 * A capability is COVERED when somebody in the roster already holds the role it projects to
 * (plan erratum E8): that is the dispatch condition, and it is the only one that matters, because
 * `decide()` matches roles. Everything else is a gap, and the gaps are filled in R4's order:
 *
 *  1. an existing worker who PROVIDES the capability but was never given its role -- one
 *     `set_runtime_roles` away from dispatchable, and the cheapest fix there is;
 *  2. a company roster worker not yet on this project;
 *  3. a catalog template, chosen by SET COVER: the entry covering the most still-missing
 *     capabilities wins, so one worker who can do two things beats two who can do one each.
 *
 * Anything left is `unfillable` and is reported rather than quietly dropped -- "nobody anywhere
 * can do this" is the one answer a person most needs to see.
 */
export function formTeam(input: TeamInput): TeamPlan {
  const required = [...new Set(input.required)].toSorted()
  const roster = [...input.roster].toSorted((a, b) => a.slaveId.localeCompare(b.slaveId))
  const recommended = new Set(input.recommendedTemplateIds ?? [])

  const covered: { capability: CapabilityKey; by: string }[] = []
  const missing: CapabilityKey[] = []
  for (const capability of required) {
    const role = projectRoles([capability], input.taxonomy)[0]
    const holder = role === undefined ? undefined : roster.find((member) => member.runtimeRoles.includes(role))
    if (holder === undefined) missing.push(capability)
    else covered.push({ capability, by: holder.slaveId })
  }

  const proposals: TeamProposal[] = []
  const outstanding = new Set(missing)

  // 1. The existing capable worker: idle first (a busy worker's roles must not change under its
  // own run), then slave id.
  for (const capability of missing) {
    const provider = roster
      .filter((member) => member.capabilities.includes(capability))
      .toSorted((a, b) => (a.busy === b.busy ? a.slaveId.localeCompare(b.slaveId) : a.busy ? 1 : -1))[0]
    if (provider === undefined) continue
    const role = projectRoles([capability], input.taxonomy)[0] ?? ''
    proposals.push({
      capability,
      source: 'existing_worker',
      pick: { kind: 'slave', id: provider.slaveId, name: provider.name },
      covers: [capability],
      temporary: false,
      rationale:
        `${provider.name} already provides ${capabilityLabel(capability, input.taxonomy)} and does not hold the ` +
        `"${role}" runtime role, so giving it to them makes them dispatchable for this work with nobody new.`,
    })
    outstanding.delete(capability)
  }

  // 2 and 3. Set cover over the company roster first, then the catalog. Both loops are the same
  // shape, so a change to the minimality rule is one change and not two.
  coverWith(
    outstanding,
    [...input.company].toSorted((a, b) => a.companySlaveId.localeCompare(b.companySlaveId)).map((worker) => ({
      id: worker.companySlaveId,
      name: worker.name,
      capabilities: worker.capabilities,
      recommended: false,
    })),
    (pick, covers) =>
      proposals.push({
        capability: covers[0] as CapabilityKey,
        source: 'company_worker',
        pick: { kind: 'company_slave', id: pick.id, name: pick.name },
        covers,
        temporary: false,
        rationale:
          `${pick.name} is already on the company roster and provides ${labelList(covers, input.taxonomy)}, so this ` +
          'project can be staffed from people who already work here rather than by hiring.',
      }),
  )

  coverWith(
    outstanding,
    [...input.catalog].toSorted((a, b) => a.templateId.localeCompare(b.templateId)).map((entry) => ({
      id: entry.templateId,
      name: entry.name,
      capabilities: entry.capabilities,
      recommended: recommended.has(entry.templateId),
    })),
    (pick, covers) =>
      proposals.push({
        capability: covers[0] as CapabilityKey,
        source: 'project_worker',
        pick: { kind: 'template', id: pick.id, name: pick.name },
        covers,
        temporary: false,
        rationale:
          `${pick.name} provides ${labelList(covers, input.taxonomy)}, which nobody on this project or on the ` +
          `company roster does${pick.recommended ? ", and a worker's profile recommends pairing with it" : ''}.`,
      }),
  )

  return {
    covered,
    proposals: proposals.toSorted((a, b) => a.capability.localeCompare(b.capability)),
    unfillable: [...outstanding].toSorted(),
  }
}

/** One round of greedy set cover, repeated until nothing else can be covered. The winner is the
 *  candidate covering the most outstanding capabilities; ties break on RECOMMENDED first (R5's
 *  advisory tie-break), then on the fewest total capabilities (the most specific worker for the
 *  job), then on name, then on id -- four breaks, so the winner never depends on input order. */
function coverWith(
  outstanding: Set<CapabilityKey>,
  candidates: readonly { readonly id: string; readonly name: string; readonly capabilities: readonly CapabilityKey[]; readonly recommended: boolean }[],
  emit: (pick: { readonly id: string; readonly name: string; readonly recommended: boolean }, covers: readonly CapabilityKey[]) => void,
): void {
  let progress = true
  while (outstanding.size > 0 && progress) {
    progress = false
    let best: { id: string; name: string; recommended: boolean; covers: CapabilityKey[] } | null = null
    for (const candidate of candidates) {
      const covers = [...outstanding].filter((capability) => candidate.capabilities.includes(capability)).toSorted()
      if (covers.length === 0) continue
      if (best === null || beats({ ...candidate, covers }, best, candidates)) {
        best = { id: candidate.id, name: candidate.name, recommended: candidate.recommended, covers }
      }
    }
    if (best === null) return
    emit(best, best.covers)
    for (const capability of best.covers) outstanding.delete(capability)
    progress = true
  }
}

function beats(
  challenger: { id: string; name: string; recommended: boolean; covers: readonly CapabilityKey[]; capabilities: readonly CapabilityKey[] },
  holder: { id: string; name: string; recommended: boolean; covers: readonly CapabilityKey[] },
  candidates: readonly { readonly id: string; readonly capabilities: readonly CapabilityKey[] }[],
): boolean {
  if (challenger.covers.length !== holder.covers.length) return challenger.covers.length > holder.covers.length
  if (challenger.recommended !== holder.recommended) return challenger.recommended
  const holderSize = candidates.find((candidate) => candidate.id === holder.id)?.capabilities.length ?? 0
  if (challenger.capabilities.length !== holderSize) return challenger.capabilities.length < holderSize
  if (challenger.name !== holder.name) return challenger.name.localeCompare(holder.name) < 0
  return challenger.id.localeCompare(holder.id) < 0
}

const labelList = (keys: readonly CapabilityKey[], taxonomy: readonly CapabilityRecord[]): string =>
  keys.map((key) => capabilityLabel(key, taxonomy)).join(' and ')
```

Run: `npx vitest run packages/domain/test/capability/team.test.ts` → PASS.

- [ ] **Step 9: Teach the plan graph capabilities, and make its role optional (R3, E2)**

In `packages/domain/src/planning/graph.ts`, `PlanTask` and the schema:

```ts
export interface PlanTask {
  readonly key: string
  readonly title: string
  readonly description: string
  /**
   * The runtime role the planner asked for, when it asked for one at all.
   *
   * OPTIONAL as of M47 (plan erratum E2). It used to be required, and while it was, a task's
   * `requiredRole` could only ever be this literal -- there was no reachable state in which the
   * capability projection (R2) decided the role, and the milestone's central claim could not be
   * measured. A task must still carry a role OR at least one capability; that is checked in
   * {@link validateStructure}, not here, so a graph naming neither is REJECTED rather than falling
   * back to an earlier candidate object in the same message.
   */
  readonly role?: string
  /** M47 R3: the capabilities this work needs, in the taxonomy's dotted vocabulary. Optional in
   *  the JSON (`.default([])`), so every fixture and every plan written before this milestone
   *  still parses -- an old `plan-graph.ndjson` reads back as a task with no capabilities and the
   *  planner's own role, which is exactly what it meant. Validated against the TABLE later, by
   *  `concludePlanning`: this module is pure and has no taxonomy to check against. */
  readonly capabilities: readonly string[]
}

const planTaskSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1).optional(),
  dependsOn: z.array(z.string()).default([]),
  capabilities: z.array(z.string().min(1)).max(10).default([]),
})
```

and, first in `validateStructure`'s per-task loop (before the duplicate-key check keeps its place):

```ts
  for (const task of graph.tasks) {
    // E2: a task nobody can staff is not a plan. `requiredRole` is what the scheduler matches and
    // `requiredCapabilities` is what it is derived from; with neither, `concludePlanning` would
    // write a null role and BOTH loaders would drop the row -- a task on the board that no pass
    // can ever see.
    if (task.role === undefined && task.capabilities.length === 0) {
      return err(`task "${task.key}" names neither a role nor a capability`)
    }
  }
```

The same three lines go into `packages/domain/src/planning/delta.ts`'s `validateDelta`, in its own `for (const task of delta.add)` loop, with `add` in the message: `` return err(`added task "${task.key}" names neither a role nor a capability`) ``.

- [ ] **Step 10: Extend the planning tests for both shapes**

Append to `packages/domain/test/planning/graph.test.ts`:

```ts
describe('parsePlanGraph -- capabilities (M47 R3)', () => {
  it('parses a task with capabilities and no role', () => {
    const out = parsePlanGraph('{"tasks":[{"key":"a","title":"t","description":"d","capabilities":["security.application"]}]}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.tasks[0]?.role).toBeUndefined()
    expect(out.value.tasks[0]?.capabilities).toEqual(['security.application'])
  })

  // The whole compatibility claim, in one assertion: `plan-graph.ndjson` and every graph a model
  // wrote before this milestone still parse, and read back as "no capabilities".
  it('parses a task with a role and no capabilities, exactly as before', () => {
    const out = parsePlanGraph('{"tasks":[{"key":"a","title":"t","description":"d","role":"backend","dependsOn":[]}]}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.tasks[0]?.role).toBe('backend')
    expect(out.value.tasks[0]?.capabilities).toEqual([])
  })

  it('rejects a task that names neither', () => {
    const out = parsePlanGraph('{"tasks":[{"key":"a","title":"t","description":"d"}]}')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('neither a role nor a capability')
  })
})
```

and the mirror of the third case in `packages/domain/test/planning/delta.test.ts`, over `parsePlanDelta('{"add":[{"key":"a","title":"t","description":"d"}],"cancel":[],"keep":[]}', [])`, expecting `added task "a" names neither a role nor a capability`.

- [ ] **Step 11: Add the `capabilities` run-context section (E3)**

In `packages/domain/src/run-context/sections.ts`, one member on `SectionKind` and one arm on `SectionSource`:

```ts
  /** M47 R3: the taxonomy keys this workspace can ask for, rendered from the `Capability` table by
   *  the orchestrator. A SECTION and not part of `PLANNING_GRAPH_INSTRUCTIONS` (plan erratum E3):
   *  that constant is pure, static, pinned byte-for-byte by a test, and is what the fake CLI
   *  selects its planning arm on -- and a per-workspace key list is none of those things. */
  | 'capabilities'
```

```ts
  /** Which keys the planner was shown, and whether the list was capped. The KEYS, not the text:
   *  a reader asking "could this plan have named `security.application`?" wants the vocabulary the
   *  run was actually given. */
  | { readonly kind: 'capabilities'; readonly keys: readonly string[]; readonly capped: boolean }
```

In `packages/domain/src/run-context/render.ts`, the planning order becomes:

```ts
  // `capabilities` is LAST (M47, plan erratum E3): the trailer that asks for the JSON object comes
  // straight after it, so the vocabulary a planner may use sits directly above the request to use
  // it. A section whose text is empty is dropped from prompt and manifest alike, so a workspace
  // with no taxonomy rows renders exactly what it rendered before this milestone.
  planning: ['profile', 'planning_goal', 'replan', 'capabilities'],
```

Add to `packages/domain/test/run-context/render.test.ts`:

```ts
  it('puts the capabilities section after the goal and the trailer after IT (M47 E3)', () => {
    const { prompt, manifest } = renderRunContext('planning', [
      section('capabilities', 'CAPABILITIES\n\n- backend.api-design: API design', { kind: 'capabilities', keys: ['backend.api-design'], capped: false }),
      section('planning_goal', 'GOAL: ship it', { kind: 'planning_goal', sha256: GOAL_SHA, version: 1 }),
    ])
    expect(prompt.indexOf('GOAL: ship it')).toBeLessThan(prompt.indexOf('CAPABILITIES'))
    expect(prompt.endsWith(PLANNING_GRAPH_INSTRUCTIONS)).toBe(true)
    expect(manifest.sections.map((s) => s.kind)).toEqual(['planning_goal', 'capabilities'])
  })
```

- [ ] **Step 12: Widen the two plan events (E14)**

In `packages/domain/src/events/schema.ts`, inside the `workspace.plan_created` payload (after `tasks`) and inside `workspace.replanned`'s payload:

```ts
      /** M47 R3: capability keys the planner asked for that the taxonomy does not have. Dropped
       *  from the task (nothing matches on a key nobody defined) and recorded here, because a
       *  silently ignored vocabulary is how an operator concludes the feature does not work.
       *  Optional: every event written before M47 has none. */
      droppedCapabilities: z.array(z.string().min(1)).optional(),
```

and in `packages/domain/test/events/schema.test.ts`, one case per event asserting a payload carrying `droppedCapabilities: ['nope.nothing']` parses and one without it still parses.

- [ ] **Step 13: Write the checked-in taxonomy (R1, E13)**

`packages/db/src/capabilities.ts` — 48 keys over thirteen domains, every one with the role its domain projects to:

```ts
import type { CapabilityRecord } from '@slave-of-ai/domain'

/**
 * The taxonomy as SHIPPED (M47 R1): what `db:seed` writes and what `syncCapabilityTaxonomy()`
 * reconciles the `Capability` table against on every import and on demand.
 *
 * It lives in `packages/db` rather than in `packages/domain` on purpose: the domain's capability
 * functions take a taxonomy as DATA so they can be tested with three rows, and a hardcoded list
 * inside them would be exactly the hardcoding R1 forbids. An operator adds a key with
 * `capabilities add`; nothing here is a ceiling.
 *
 * `role` is the runtime role a capability's domain PROJECTS to (R2) -- the string `decide()`
 * matches. Five of them are roles this repository already dispatches on (`backend`, `frontend`,
 * `manager`, `reviewer`); the rest name a role a hire creates, which is what makes a hired
 * specialist dispatchable for the task that asked for it.
 */
export const CAPABILITY_SEED: readonly CapabilityRecord[] = [
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: ['api architecture', 'rest design', 'endpoint design'] },
  { key: 'backend.services', label: 'Service implementation', domain: 'backend', role: 'backend', synonyms: ['server side', 'backend development'] },
  { key: 'backend.messaging', label: 'Queues and messaging', domain: 'backend', role: 'backend', synonyms: ['event driven', 'message queues'] },
  { key: 'backend.performance', label: 'Backend performance', domain: 'backend', role: 'backend', synonyms: ['latency tuning', 'throughput'] },
  { key: 'backend.integration', label: 'Third-party integration', domain: 'backend', role: 'backend', synonyms: ['api integration'] },
  { key: 'frontend.ui-implementation', label: 'UI implementation', domain: 'frontend', role: 'frontend', synonyms: ['frontend development', 'component work'] },
  { key: 'frontend.accessibility', label: 'Accessibility', domain: 'frontend', role: 'frontend', synonyms: ['a11y', 'wcag'] },
  { key: 'frontend.state-management', label: 'State management', domain: 'frontend', role: 'frontend', synonyms: ['client state'] },
  { key: 'frontend.styling', label: 'Styling and layout', domain: 'frontend', role: 'frontend', synonyms: ['css', 'design implementation'] },
  { key: 'frontend.performance', label: 'Frontend performance', domain: 'frontend', role: 'frontend', synonyms: ['bundle size', 'web vitals'] },
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: ['appsec', 'secure code review', 'application security engineering'] },
  { key: 'security.authentication', label: 'Authentication and authorization', domain: 'security', role: 'security', synonyms: ['authn', 'authz', 'access control'] },
  { key: 'security.secrets', label: 'Secrets and credentials', domain: 'security', role: 'security', synonyms: ['credential management', 'key management'] },
  { key: 'security.threat-modelling', label: 'Threat modelling', domain: 'security', role: 'security', synonyms: ['threat modeling', 'attack surface review'] },
  { key: 'security.dependency-audit', label: 'Dependency auditing', domain: 'security', role: 'security', synonyms: ['supply chain security', 'sca'] },
  { key: 'database.schema-design', label: 'Schema design', domain: 'database', role: 'database', synonyms: ['data modelling', 'data modeling'] },
  { key: 'database.migrations', label: 'Migrations', domain: 'database', role: 'database', synonyms: ['schema migration'] },
  { key: 'database.query-performance', label: 'Query performance', domain: 'database', role: 'database', synonyms: ['index tuning', 'slow queries'] },
  { key: 'database.postgres', label: 'PostgreSQL', domain: 'database', role: 'database', synonyms: ['postgresql'] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'qa', synonyms: ['automated testing', 'e2e testing'] },
  { key: 'qa.exploratory', label: 'Exploratory testing', domain: 'qa', role: 'qa', synonyms: ['manual testing'] },
  { key: 'qa.load-testing', label: 'Load testing', domain: 'qa', role: 'qa', synonyms: ['performance testing', 'stress testing'] },
  { key: 'qa.test-strategy', label: 'Test strategy', domain: 'qa', role: 'qa', synonyms: ['quality strategy'] },
  { key: 'operations.ci-cd', label: 'CI and CD', domain: 'operations', role: 'operations', synonyms: ['continuous integration', 'build pipelines'] },
  { key: 'operations.deployment', label: 'Deployment', domain: 'operations', role: 'operations', synonyms: ['release engineering', 'rollout'] },
  { key: 'operations.observability', label: 'Observability', domain: 'operations', role: 'operations', synonyms: ['monitoring', 'tracing', 'logging'] },
  { key: 'operations.incident-response', label: 'Incident response', domain: 'operations', role: 'operations', synonyms: ['on call', 'incident management'] },
  { key: 'operations.infrastructure', label: 'Infrastructure', domain: 'operations', role: 'operations', synonyms: ['platform engineering', 'infrastructure as code'] },
  { key: 'data.pipelines', label: 'Data pipelines', domain: 'data', role: 'data', synonyms: ['etl', 'data engineering'] },
  { key: 'data.analytics', label: 'Analytics', domain: 'data', role: 'data', synonyms: ['reporting', 'business intelligence'] },
  { key: 'data.warehousing', label: 'Data warehousing', domain: 'data', role: 'data', synonyms: ['data warehouse'] },
  { key: 'data.machine-learning', label: 'Machine learning', domain: 'data', role: 'data', synonyms: ['ml engineering', 'model training'] },
  { key: 'mobile.ios', label: 'iOS', domain: 'mobile', role: 'mobile', synonyms: ['swift', 'iphone'] },
  { key: 'mobile.android', label: 'Android', domain: 'mobile', role: 'mobile', synonyms: ['kotlin'] },
  { key: 'mobile.cross-platform', label: 'Cross-platform mobile', domain: 'mobile', role: 'mobile', synonyms: ['react native', 'flutter'] },
  { key: 'product.requirements', label: 'Requirements', domain: 'product', role: 'product', synonyms: ['requirements gathering', 'specification'] },
  { key: 'product.roadmapping', label: 'Roadmapping', domain: 'product', role: 'product', synonyms: ['prioritisation', 'prioritization'] },
  { key: 'product.user-research', label: 'User research', domain: 'product', role: 'product', synonyms: ['customer discovery'] },
  { key: 'design.interaction', label: 'Interaction design', domain: 'design', role: 'design', synonyms: ['ux design'] },
  { key: 'design.visual', label: 'Visual design', domain: 'design', role: 'design', synonyms: ['ui design'] },
  { key: 'design.design-systems', label: 'Design systems', domain: 'design', role: 'design', synonyms: ['component library'] },
  { key: 'docs.technical-writing', label: 'Technical writing', domain: 'docs', role: 'docs', synonyms: ['documentation'] },
  { key: 'docs.api-reference', label: 'API reference', domain: 'docs', role: 'docs', synonyms: ['api documentation'] },
  { key: 'planning.decomposition', label: 'Work decomposition', domain: 'planning', role: 'manager', synonyms: ['task breakdown', 'work breakdown'] },
  { key: 'planning.estimation', label: 'Estimation', domain: 'planning', role: 'manager', synonyms: ['sizing'] },
  { key: 'planning.coordination', label: 'Coordination', domain: 'planning', role: 'manager', synonyms: ['project coordination'] },
  { key: 'review.code-review', label: 'Code review', domain: 'review', role: 'reviewer', synonyms: ['peer review', 'diff review'] },
  { key: 'review.release-readiness', label: 'Release readiness', domain: 'review', role: 'reviewer', synonyms: ['go no go', 'release review'] },
]
```

`packages/db/src/index.ts` gains `export * from './capabilities.js'`.

- [ ] **Step 14: Add the schema, the migration and the seed (R1, E1, E4, E13)**

In `packages/db/prisma/schema.prisma`:

```prisma
/// M47 R1: the capability taxonomy, as DATA. Nothing matches on a key that is not a row here --
/// the importer, the CLI and the planner all validate against this table, and an unknown key is
/// dropped and reported rather than stored. Seeded from `packages/db/src/capabilities.ts` by
/// `db:seed` and reconciled by `syncCapabilityTaxonomy()`; an operator adds their own with
/// `capabilities add`, and `createdBy` is what tells the two apart.
model Capability {
  /// `<domain>.<name>`, lower case and dash-separated -- the primary key, because the key IS the
  /// identity: `Task.requiredCapabilities` and `Slave.capabilities` are `String[]` columns of them
  /// (the `runtimeRoles` precedent), not foreign keys, so a taxonomy row can be relabelled without
  /// rewriting every task that asked for it.
  key        String   @id
  label      String
  /// The prefix of `key`, stored so a facet list is a `groupBy` rather than a scan of split keys.
  domain     String
  /// The runtime role this capability PROJECTS to (R2) -- the one string `decide()` matches.
  /// NOT NULL by design (plan erratum E1): a capability that projected to nothing would derive no
  /// `requiredRole`, and a task with no required role is dropped by both world loaders.
  role       String
  synonyms   String[] @default([])
  createdBy  String   @default("seed")
  createdAt  DateTime @default(now())

  @@index([domain])
}

/// M47 R5: one persona sentence, normalised into an ADVISORY relationship. Never execution
/// authority: nothing here is read by `decide()`, by the review pass or by messaging. `text` is
/// the sentence exactly as M46 stored it, which is what lets a reader trace an edge back to the
/// persona that wrote it.
model CollaborationHint {
  id               String   @id @default(uuid())
  templateId       String
  text             String
  /// The template the sentence names, when it names one. NULL is ordinary: most real handoff
  /// sentences name a generic role rather than a persona.
  targetTemplateId String?
  /// A taxonomy key the sentence is about, when it is about one. A plain column, not a relation:
  /// a hint must survive the removal of a capability row it happens to mention.
  capability       String?
  source           String   @default("import")

  template       SlaveTemplate  @relation("CollaborationHintOwner", fields: [templateId], references: [id], onDelete: Cascade)
  targetTemplate SlaveTemplate? @relation("CollaborationHintTarget", fields: [targetTemplateId], references: [id], onDelete: SetNull)

  /// One row per sentence per template -- a re-import replaces this template's hints and can never
  /// double them.
  @@unique([templateId, text])
  @@index([targetTemplateId])
}
```

on `Task`, after `requiredRole`:

```prisma
  /// M47 R2/R3: the capabilities this work needs, in the taxonomy's vocabulary -- the PLANNING and
  /// STAFFING key. `requiredRole` above stays the DISPATCH key and is derived from this list when
  /// the planner did not name one, so the scheduler keeps exactly one matching rule.
  requiredCapabilities String[] @default([])
```

on `Slave`, after `runtimeRoles`:

```prisma
  /// M47 R2: what this worker PROVIDES -- its template's normalised capabilities plus whatever an
  /// operator added (`set-capabilities`). `runtimeRoles` above is what it may be DISPATCHED as and
  /// is seeded with the roles these project to; the two are kept apart because a capability is a
  /// fact about the specialist and a runtime role is a decision about the schedule.
  capabilities        String[] @default([])
  /// Why this worker is on this project, in one sentence a person can read (R6). Written by
  /// `hireFromTemplate`/`materialiseCompanySlave` from the Supervisor's own rationale; NULL for
  /// every worker seeded or materialised before M47, where the Organization view says "seeded" or
  /// "assigned from <company>" instead.
  selectionRationale  String?
  /// The catalog row this worker was hired from (R4). `onDelete: SetNull`: a worker with run
  /// history must survive the deletion of the template it came from, exactly as `companySlaveId`
  /// survives its roster row.
  hiredFromTemplateId String?
```

with `hiredFromTemplate SlaveTemplate? @relation("HiredWorkers", fields: [hiredFromTemplateId], references: [id], onDelete: SetNull)` beside the existing relations, and on `SlaveTemplate`:

```prisma
  /// M47 R1: `profileSpec.capabilities` resolved to taxonomy keys at import, so a catalog search
  /// and `formTeam` read a controlled vocabulary instead of re-normalising free text per query.
  capabilityKeys         String[] @default([])
  /// The capability sentences that matched no key, verbatim -- what the taxonomy is missing, kept
  /// where an operator can see it. Never matched against anything.
  unresolvedCapabilities String[] @default([])

  collaborationHints   CollaborationHint[] @relation("CollaborationHintOwner")
  advisedBy            CollaborationHint[] @relation("CollaborationHintTarget")
  hiredWorkers         Slave[]             @relation("HiredWorkers")
```

and one member on the enum, spelled where it is observed rather than at the end:

```prisma
  ready_unstaffed
  /// M47 R4: a startable task needs a capability nobody can be dispatched for. Supersedes
  /// `ready_unstaffed` for the task that raised it (plan erratum E8); `ready_unstaffed` remains
  /// the role-only fallback for a task that declared no capabilities.
  capability_unstaffed
```

`packages/db/prisma/migrations/20260911140000_m47_capabilities/migration.sql`:

```sql
-- M47 t1: the capability taxonomy (R1), the advisory collaboration edges (R5), and the four
-- columns that let a task ask for a capability and a worker provide one (R2/R4).
--
-- Additive: two new tables, five new columns with defaults, one new enum member. Nothing is
-- dropped, nothing is backfilled, and every existing row reads back exactly as it did -- an empty
-- `requiredCapabilities` is what "this task was planned before capabilities existed" means, and
-- `requiredRole` still decides its dispatch.

CREATE TABLE "Capability" (
    "key"       TEXT NOT NULL,
    "label"     TEXT NOT NULL,
    "domain"    TEXT NOT NULL,
    "role"      TEXT NOT NULL,
    "synonyms"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL DEFAULT 'seed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Capability_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "Capability_domain_idx" ON "Capability"("domain");

CREATE TABLE "CollaborationHint" (
    "id"               TEXT NOT NULL,
    "templateId"       TEXT NOT NULL,
    "text"             TEXT NOT NULL,
    "targetTemplateId" TEXT,
    "capability"       TEXT,
    "source"           TEXT NOT NULL DEFAULT 'import',

    CONSTRAINT "CollaborationHint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CollaborationHint_templateId_text_key" ON "CollaborationHint"("templateId", "text");
CREATE INDEX "CollaborationHint_targetTemplateId_idx" ON "CollaborationHint"("targetTemplateId");

ALTER TABLE "CollaborationHint" ADD CONSTRAINT "CollaborationHint_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "SlaveTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollaborationHint" ADD CONSTRAINT "CollaborationHint_targetTemplateId_fkey"
    FOREIGN KEY ("targetTemplateId") REFERENCES "SlaveTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Task" ADD COLUMN "requiredCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Slave" ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Slave" ADD COLUMN "selectionRationale" TEXT;
ALTER TABLE "Slave" ADD COLUMN "hiredFromTemplateId" TEXT;
ALTER TABLE "Slave" ADD CONSTRAINT "Slave_hiredFromTemplateId_fkey"
    FOREIGN KEY ("hiredFromTemplateId") REFERENCES "SlaveTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SlaveTemplate" ADD COLUMN "capabilityKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "SlaveTemplate" ADD COLUMN "unresolvedCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Plan erratum E4: a situation kind is a Postgres enum member, not only a TypeScript union member.
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- permits as long as the new value is not USED in the same transaction. Nothing here uses it.
-- (The idiom is `20260910120000_m40_requirement_versioning`'s own, for `stale_task`.)
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'capability_unstaffed';
```

In `packages/db/src/seed.ts`: `"CollaborationHint", "Capability",` join the TRUNCATE list (immediately before `"SlaveTemplate"`, which is the FK order the rest of the list already follows), `import { CAPABILITY_SEED } from './capabilities.js'` is added, and directly after the truncate:

```ts
  // M47 R1: the taxonomy is DATA, and a seeded database has it. Written straight through Prisma
  // rather than through `syncCapabilityTaxonomy` -- `packages/db` cannot import `packages/control`,
  // which imports IT -- and the two write the same rows from the same list.
  await prisma.capability.createMany({
    data: CAPABILITY_SEED.map((record) => ({
      key: record.key,
      label: record.label,
      domain: record.domain,
      role: record.role,
      synonyms: [...record.synonyms],
      createdBy: 'seed',
    })),
  })
```

- [ ] **Step 15: Apply the migration to both databases and prove the schema and the migrations agree**

```bash
npm run db:migrate
npm run db:migrate:test
npm run db:generate
npx tsc --build
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```
Expected: the last command prints **"No difference detected"**. Paste it into the task report — it is the milestone's proof that the hand-written SQL and the schema say the same thing. (The enum member sits at the END of the Postgres type and in the MIDDLE of `schema.prisma`; m40 proved the diff does not read order.)

- [ ] **Step 16: Full task verification**

```bash
npx vitest run packages/domain/test/capability packages/domain/test/planning packages/domain/test/run-context packages/domain/test/events packages/domain/test/scheduler
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: all green. `packages/domain/test/scheduler/decide.test.ts` is on that list deliberately: `decide()` is untouched by this milestone and this run is what says so.

- [ ] **Step 17: Commit**

```bash
git add packages/domain/src/capability packages/domain/src/index.ts packages/domain/src/planning packages/domain/src/run-context packages/domain/src/events/schema.ts \
        packages/domain/test/capability packages/domain/test/planning packages/domain/test/run-context packages/domain/test/events \
        packages/db/src/capabilities.ts packages/db/src/index.ts packages/db/src/seed.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "$(cat <<'EOF'
feat(domain,db): m47 t1 -- a capability taxonomy that is data, and the projection that keeps one matching rule

Capabilities PROJECT to runtime roles rather than competing with them: every taxonomy row carries
the role its domain dispatches as, `projectRoles` is the whole of the relation, and `decide()` is
untouched -- its own tests run in this task's verification for exactly that reason.

`normaliseCapabilities` matches exactly, after one normalisation, against a key, a label or a
synonym. Nothing is fuzzy: two synonyms could otherwise match one persona bullet and the answer
would depend on the order rows came back in. What matches nothing is kept verbatim beside the row
it came from, because "the taxonomy is missing this" is a fact an operator can act on and a
silently dropped sentence is not.

`formTeam` is a pure set cover with four named tie-breaks, so one worker who can do two things
beats two who can do one each, and the same world always produces the same team. A hint from a
persona's own profile can break a tie and add a clause to the rationale; it can never dispatch
anybody.

The plan graph's `role` becomes optional and a task must name a role or a capability -- checked in
`validateStructure`, so a graph that names neither is rejected outright rather than falling back to
an earlier draft. Without that, "the role wins when both exist" made the derivation unreachable and
the milestone unmeasurable.

Migration is additive: two tables, five defaulted columns, one enum member. An old plan-graph
fixture still parses and reads back as a task with no capabilities, which is what it meant.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 2: The control verbs, the importer, the projection at materialisation, and the planner writing capabilities (R1–R3, R5, E1, E3, E10, E11, E14, E15)

**Files:**
- Create: `packages/control/src/capability.ts`, `packages/control/test/integration/capability.test.ts`
- Modify: `packages/control/src/catalog.ts`, `packages/control/src/org.ts`, `packages/control/src/refusal.ts`, `packages/control/src/index.ts`
- Modify: `apps/orchestrator/src/planning.ts`, `apps/orchestrator/src/replan.ts`, `apps/orchestrator/src/runContext.ts`, `apps/orchestrator/src/cli.ts`
- Test: `packages/control/test/integration/catalog.test.ts`, `packages/control/test/integration/org.test.ts`, `apps/orchestrator/test/integration/planning.test.ts`, `apps/orchestrator/test/integration/runContext.test.ts`, `apps/orchestrator/test/integration/cli.test.ts`, `apps/web/test/refusal-status.test.ts`

**Interfaces:**
- Consumes from Task 1: `CAPABILITY_SEED` (`@slave-of-ai/db`); `normaliseCapabilities`, `projectRoles`, `capabilityLabel`, `normaliseCollaborationHint`, `capabilityKeySchema`, `CAPABILITY_KEY_PATTERN`, `type CapabilityRecord` (`@slave-of-ai/domain`); the four columns and two tables; `PlanTask.capabilities`/`PlanTask.role?`; the `capabilities` `SectionKind`.
- Produces, for Tasks 3–5:
  - `listCapabilities(): Promise<readonly CapabilityRecord[]>` — key ascending, always
  - `syncCapabilityTaxonomy(): Promise<{ created: number; updated: number }>`
  - `addCapability(input: { key: string; label: string; role: string; synonyms?: readonly string[] }): Promise<Result<CapabilityRecord, ControlRefusal>>`
  - `setSlaveCapabilities(slaveId: string, values: readonly string[], actor: string): Promise<Result<{ keys: readonly string[]; unresolved: readonly string[]; runtimeRoles: readonly string[] }, ControlRefusal>>`
  - `materialiseCompanySlave(workspaceId: string, companySlaveId: string, opts?: { rationale?: string }): Promise<Result<{ slaveId: string; created: boolean }, ControlRefusal>>`
  - `hireFromTemplate(workspaceId: string, templateId: string, opts: { capabilities?: readonly string[]; rationale: string; temporary?: boolean }): Promise<Result<{ slaveId: string; reused: boolean; capabilities: readonly string[]; runtimeRoles: readonly string[] }, ControlRefusal>>`
  - `listOrganization(workspaceId: string): Promise<Result<OrganizationView, ControlRefusal>>` with `interface OrganizationWorker { slaveId; name; role; runtimeRoles; capabilities; kind: 'company' | 'project'; companyName: string | null; hiredFromTemplateId: string | null; hiredFromTemplateName: string | null; selectionRationale: string | null; busy: boolean }` and `interface OrganizationView { workers: readonly OrganizationWorker[]; hints: readonly { slaveId: string; text: string; targetTemplateName: string | null; capability: string | null }[] }`
  - refusal kinds `capability_not_found`, `invalid_capability`
  - CLI: `capabilities sync|add|list`, `set-capabilities --slave <id> --capabilities <csv>`, `hire --workspace <id> --template <id> --why <text> [--capability <key>]`

- [ ] **Step 1: Add the two refusal kinds in their three homes (E15)**

In `packages/control/src/refusal.ts`, beside `template_not_found`:

```ts
  /** M47 R1: a capability key nothing in the taxonomy table has. Nothing matches on a key that is
   *  not a row -- `capabilities add` is how one gets there. */
  | { readonly kind: 'capability_not_found'; readonly key: string }
  /** M47 R1: a key, label or role that cannot become a taxonomy row (a malformed key, a blank
   *  label, a role that is not a role, a key that already exists). */
  | { readonly kind: 'invalid_capability'; readonly detail: string }
```

and in `refusalText`'s switch:

```ts
    case 'capability_not_found':
      return `there is no capability "${refusal.key}" in the taxonomy: add it with \`capabilities add\` first`
    case 'invalid_capability':
      return `that capability cannot be added: ${refusal.detail}`
```

and both keys in `apps/web/test/refusal-status.test.ts`'s `ALL_KINDS` (`capability_not_found: true,` and `invalid_capability: true,`). `refusalStatus` reads 404 off the `_not_found` suffix, so nothing else changes.

- [ ] **Step 2: Write the failing integration test for the taxonomy and the two hiring verbs**

`packages/control/test/integration/capability.test.ts` (new; the file's `beforeEach` follows the package's existing integration files — truncate through the same helper they use, then create the fixtures below):

```ts
import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addCapability,
  hireFromTemplate,
  listCapabilities,
  materialiseCompanySlave,
  setSlaveCapabilities,
  syncCapabilityTaxonomy,
} from '../../src/capability.js'
import { resetDatabase } from './helpers.js'

beforeEach(async () => {
  await resetDatabase()
  await syncCapabilityTaxonomy()
})

async function workspace(): Promise<{ workspaceId: string; teamId: string }> {
  const ws = await prisma.workspace.create({
    data: { name: 'M47 Control', repoPath: '/tmp/m47', verifyCommands: ['true'], maxAttempts: 3 },
  })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Engineering' } })
  return { workspaceId: ws.id, teamId: team.id }
}

describe('syncCapabilityTaxonomy', () => {
  it('is idempotent: a second run creates nothing and changes nothing', async () => {
    const again = await syncCapabilityTaxonomy()
    expect(again).toEqual({ created: 0, updated: 0 })
    const rows = await listCapabilities()
    expect(rows.length).toBeGreaterThan(40)
    expect(rows.map((row) => row.key)).toEqual([...rows.map((row) => row.key)].toSorted())
    expect(rows.find((row) => row.key === 'security.application')?.role).toBe('security')
  })

  it('brings a hand-edited seed row back to the checked-in list, and leaves an operator row alone', async () => {
    await prisma.capability.update({ where: { key: 'security.application' }, data: { label: 'wrong', role: 'backend' } })
    await prisma.capability.create({
      data: { key: 'local.thing', label: 'A local thing', domain: 'local', role: 'backend', synonyms: [], createdBy: 'human' },
    })
    const out = await syncCapabilityTaxonomy()
    expect(out.updated).toBe(1)
    const rows = await listCapabilities()
    expect(rows.find((row) => row.key === 'security.application')?.role).toBe('security')
    expect(rows.find((row) => row.key === 'local.thing')).toBeDefined()
  })
})

describe('addCapability', () => {
  it('adds an operator key and refuses a malformed one, a duplicate and a blank label', async () => {
    const ok = await addCapability({ key: 'legal.contracts', label: 'Contract review', role: 'legal' })
    expect(ok.ok).toBe(true)
    expect((await listCapabilities()).find((row) => row.key === 'legal.contracts')?.domain).toBe('legal')

    for (const bad of [
      { key: 'Legal.Contracts', label: 'x', role: 'legal' },
      { key: 'legal.contracts', label: 'x', role: 'legal' },
      { key: 'legal.terms', label: '   ', role: 'legal' },
      { key: 'legal.terms', label: 'x', role: '  ' },
    ]) {
      const refused = await addCapability(bad)
      expect(refused.ok).toBe(false)
      if (refused.ok) return
      expect(refused.error.kind).toBe('invalid_capability')
    }
  })
})

describe('setSlaveCapabilities', () => {
  it('stores the resolved keys, adds their roles to the runtime roles, and never removes a role', async () => {
    const { teamId } = await workspace()
    const slave = await prisma.slave.create({
      data: { teamId, name: 'Rae', role: 'Engineer', runtimeRoles: ['backend'] },
    })
    const out = await setSlaveCapabilities(slave.id, ['Application security', 'Vibes'], 'operator')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.keys).toEqual(['security.application'])
    expect(out.value.unresolved).toEqual(['Vibes'])
    // The union, in the order M37's `addRuntimeRoles` writes it: what was held, then what is new.
    expect(out.value.runtimeRoles).toEqual(['backend', 'security'])
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: slave.id } })
    expect(row.capabilities).toEqual(['security.application'])
  })

  it('refuses a slave that is not there', async () => {
    const out = await setSlaveCapabilities('nope', ['appsec'], 'operator')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe('slave_not_found')
  })
})

describe('hireFromTemplate', () => {
  it('creates a project worker carrying the template capabilities, their roles, the template and the rationale', async () => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] },
    })
    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'authentication work needs application security' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.reused).toBe(false)
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId } })
    expect(row.capabilities).toEqual(['security.application'])
    expect(row.runtimeRoles).toEqual(['security'])
    expect(row.hiredFromTemplateId).toBe(template.id)
    expect(row.selectionRationale).toBe('authentication work needs application security')
    expect(row.name).toBe('Security Reviewer')
    // `org.changed { field: 'created' }` -- there is no `slave.created` event in this repository.
    const events = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'org_changed' } })
    expect(events).toHaveLength(1)
  })

  // E10: two capability situations in ONE pass can both propose the same template.
  it('reuses the worker it already hired from that template rather than hiring a second', async () => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application', 'qa.test-automation'] },
    })
    const first = await hireFromTemplate(workspaceId, template.id, { rationale: 'first' })
    const second = await hireFromTemplate(workspaceId, template.id, { rationale: 'second' })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.slaveId).toBe(first.value.slaveId)
    expect(second.value.reused).toBe(true)
    expect(await prisma.slave.count({ where: { team: { workspaceId } } })).toBe(1)
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: first.value.slaveId } })
    // The rationale of the FIRST hire is not overwritten: it is why this worker is here.
    expect(row.selectionRationale).toBe('first')
  })

  it('names a second worker from the same template distinctly when the project already has that name', async () => {
    const { workspaceId, teamId } = await workspace()
    await prisma.slave.create({ data: { teamId, name: 'Security Reviewer', role: 'x', runtimeRoles: [] } })
    const template = await prisma.slaveTemplate.create({ data: { name: 'Security Reviewer', role: 'security', capabilityKeys: ['security.application'] } })
    const out = await hireFromTemplate(workspaceId, template.id, { rationale: 'why' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId } })
    expect(row.name).toBe('Security Reviewer 2')
  })

  it('refuses an unknown template and an unknown workspace', async () => {
    const { workspaceId } = await workspace()
    expect((await hireFromTemplate(workspaceId, 'nope', { rationale: 'x' })).ok).toBe(false)
    const template = await prisma.slaveTemplate.create({ data: { name: 'T', role: 'security' } })
    expect((await hireFromTemplate('nope', template.id, { rationale: 'x' })).ok).toBe(false)
  })
})

describe('materialiseCompanySlave', () => {
  it('brings ONE roster worker onto the project, with its template capabilities and their roles', async () => {
    const { workspaceId } = await workspace()
    const template = await prisma.slaveTemplate.create({
      data: { name: 'Roster Security', role: 'security', capabilityKeys: ['security.application'] },
    })
    const company = await prisma.company.create({ data: { name: 'M47 Co' } })
    const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Security' } })
    const rosterRow = await prisma.companySlave.create({
      data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Sam' },
    })
    const out = await materialiseCompanySlave(workspaceId, rosterRow.id, { rationale: 'the board needs application security' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: out.value.slaveId } })
    expect(row.companySlaveId).toBe(rosterRow.id)
    expect(row.capabilities).toEqual(['security.application'])
    expect(row.runtimeRoles).toEqual(['security'])
    // The department is created from the roster team, exactly as `assignCompanyTx` does it.
    const team = await prisma.team.findUniqueOrThrow({ where: { id: row.teamId } })
    expect(team.companyTeamId).toBe(companyTeam.id)
    // Idempotent: the same roster row twice is the same worker.
    const again = await materialiseCompanySlave(workspaceId, rosterRow.id, {})
    expect(again.ok && again.value.created).toBe(false)
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run packages/control/test/integration/capability.test.ts`
Expected: FAIL — `Cannot find module '../../src/capability.js'`.

- [ ] **Step 4: Write `packages/control/src/capability.ts`**

```ts
import { CAPABILITY_SEED } from '@slave-of-ai/db'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import {
  CAPABILITY_KEY_PATTERN,
  normaliseCapabilities,
  projectRoles,
  err,
  ok,
  type CapabilityRecord,
  type Result,
} from '@slave-of-ai/domain'
import type { ControlRefusal } from './refusal.js'

/** Every taxonomy row, KEY ASCENDING -- the order every caller gets, so `normaliseCapabilities`'
 *  "first spelling wins" rule and `formTeam`'s tie-breaks are decided by the taxonomy itself and
 *  never by what Postgres felt like returning. */
export async function listCapabilities(): Promise<readonly CapabilityRecord[]> {
  const rows = await prisma.capability.findMany({ orderBy: { key: 'asc' } })
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    domain: row.domain,
    role: row.role,
    synonyms: row.synonyms,
  }))
}

/**
 * Reconcile the table against the checked-in list (R1): create what is missing, bring a `seed` row
 * back to what the list says, and never touch a row an operator added.
 *
 * Run by `db:seed`, by `importCatalog` before it normalises anything, and by `capabilities sync`.
 * Idempotent by construction -- the second run reports `{ created: 0, updated: 0 }`, which is what
 * makes it safe to call at the top of every import.
 */
export async function syncCapabilityTaxonomy(): Promise<{ readonly created: number; readonly updated: number }> {
  const existing = new Map((await prisma.capability.findMany()).map((row) => [row.key, row] as const))
  let created = 0
  let updated = 0
  for (const record of CAPABILITY_SEED) {
    const row = existing.get(record.key)
    if (row === undefined) {
      await prisma.capability.create({
        data: { key: record.key, label: record.label, domain: record.domain, role: record.role, synonyms: [...record.synonyms], createdBy: 'seed' },
      })
      created += 1
      continue
    }
    // An operator's own row is theirs, even when its key collides with one the list later gained:
    // `createdBy` is the whole of that promise.
    if (row.createdBy !== 'seed') continue
    const same =
      row.label === record.label &&
      row.domain === record.domain &&
      row.role === record.role &&
      row.synonyms.length === record.synonyms.length &&
      row.synonyms.every((synonym, index) => synonym === record.synonyms[index])
    if (same) continue
    await prisma.capability.update({
      where: { key: record.key },
      data: { label: record.label, domain: record.domain, role: record.role, synonyms: [...record.synonyms] },
    })
    updated += 1
  }
  return { created, updated }
}

/** An operator's own capability (R1). `domain` is not a parameter: it IS the key's prefix, and a
 *  row whose domain disagreed with its key would make the facet list lie. */
export async function addCapability(input: {
  readonly key: string
  readonly label: string
  readonly role: string
  readonly synonyms?: readonly string[]
}): Promise<Result<CapabilityRecord, ControlRefusal>> {
  const key = input.key.trim()
  const label = input.label.trim()
  const role = input.role.trim()
  if (!CAPABILITY_KEY_PATTERN.test(key)) {
    return err({ kind: 'invalid_capability', detail: `"${key}" is not a key: a key looks like <domain>.<name>, lower case and dash-separated` })
  }
  if (label === '') return err({ kind: 'invalid_capability', detail: 'a capability needs a label a person can read' })
  if (role === '') return err({ kind: 'invalid_capability', detail: 'a capability needs the runtime role it projects to' })
  const synonyms = (input.synonyms ?? []).map((synonym) => synonym.trim()).filter((synonym) => synonym !== '')
  const existing = await prisma.capability.findUnique({ where: { key } })
  if (existing !== null) return err({ kind: 'invalid_capability', detail: `"${key}" is already in the taxonomy` })
  const domain = key.split('.')[0] as string
  const row = await prisma.capability.create({ data: { key, label, domain, role, synonyms, createdBy: 'human' } })
  return ok({ key: row.key, label: row.label, domain: row.domain, role: row.role, synonyms: row.synonyms })
}

/**
 * What a worker PROVIDES, set by an operator (R2).
 *
 * The capabilities REPLACE (the `setRuntimeRoles` convention: naming two means holding exactly
 * those two afterwards); the runtime roles are UNIONED, because taking a role away as a side
 * effect of describing a skill would park a worker mid-project. `set-runtime-roles` stays the way
 * a role is removed.
 */
export async function setSlaveCapabilities(
  slaveId: string,
  values: readonly string[],
  actor: string,
): Promise<Result<{ readonly keys: readonly string[]; readonly unresolved: readonly string[]; readonly runtimeRoles: readonly string[] }, ControlRefusal>> {
  const taxonomy = await listCapabilities()
  const { keys, unresolved } = normaliseCapabilities(values, taxonomy)
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockedSlave(tx, slaveId)
    if (slave === null) return null
    const runtimeRoles = [...slave.runtimeRoles]
    for (const role of projectRoles(keys, taxonomy)) if (!runtimeRoles.includes(role)) runtimeRoles.push(role)
    await tx.slave.update({ where: { id: slaveId }, data: { capabilities: [...keys], runtimeRoles } })
    return { workspaceId: slave.workspaceId, runtimeRoles }
  })
  if (outcome === null) return err({ kind: 'slave_not_found', slaveId })
  await appendEvent({
    type: 'slave.runtime_roles_changed',
    workspaceId: outcome.workspaceId,
    slaveId,
    actor: 'human',
    payload: { slaveId, roles: outcome.runtimeRoles, actor },
  })
  return ok({ keys, unresolved, runtimeRoles: outcome.runtimeRoles })
}

/** The row plus the workspace the event needs, under `FOR UPDATE` -- `lockSlave`'s shape from
 *  `org.ts`, re-read here because that helper returns the whole include and this file needs two
 *  fields. */
async function lockedSlave(
  tx: Prisma.TransactionClient,
  slaveId: string,
): Promise<{ readonly runtimeRoles: readonly string[]; readonly workspaceId: string } | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Slave" WHERE id = ${slaveId} FOR UPDATE`
  if (locked.length === 0) return null
  const row = await tx.slave.findUnique({ where: { id: slaveId }, select: { runtimeRoles: true, team: { select: { workspaceId: true } } } })
  return row === null ? null : { runtimeRoles: row.runtimeRoles, workspaceId: row.team.workspaceId }
}

/**
 * ONE company roster worker onto ONE project (R4) -- the single-worker sibling of
 * `assignCompanyTx`, which materialises a whole company.
 *
 * Idempotent on the roster row: a `CompanySlave` already materialised into this workspace is
 * RETURNED, never doubled. The department is found or created from the roster team exactly as
 * `assignCompanyTx` does, so a project staffed one worker at a time and one assigned wholesale end
 * up with the same shape.
 */
export async function materialiseCompanySlave(
  workspaceId: string,
  companySlaveId: string,
  opts: { readonly rationale?: string } = {},
): Promise<Result<{ readonly slaveId: string; readonly created: boolean }, ControlRefusal>> {
  const taxonomy = await listCapabilities()
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const roster = await prisma.companySlave.findUnique({
    where: { id: companySlaveId },
    include: { companyTeam: true, template: true },
  })
  if (roster === null) return err({ kind: 'company_slave_not_found', companySlaveId })

  const existing = await prisma.slave.findFirst({ where: { companySlaveId, team: { workspaceId } } })
  if (existing !== null) return ok({ slaveId: existing.id, created: false })

  const capabilities = roster.template.capabilityKeys
  const runtimeRoles = [...new Set([roster.template.role, ...projectRoles(capabilities, taxonomy)])]
  const created = await prisma.$transaction(async (tx) => {
    let team = await tx.team.findFirst({ where: { workspaceId, companyTeamId: roster.companyTeamId } })
    team ??= await tx.team.create({ data: { workspaceId, name: uniqueTeamName(await tx.team.findMany({ where: { workspaceId }, select: { name: true } }), roster.companyTeam.name), companyTeamId: roster.companyTeamId } })
    return tx.slave.create({
      data: {
        teamId: team.id,
        name: uniqueSlaveName(await tx.slave.findMany({ where: { team: { workspaceId } }, select: { name: true } }), roster.name),
        role: roster.template.role,
        runtimeRoles,
        capabilities: [...capabilities],
        companySlaveId,
        ...(opts.rationale === undefined ? {} : { selectionRationale: opts.rationale }),
      },
    })
  })

  await appendEvent({
    type: 'org.changed',
    workspaceId,
    slaveId: created.id,
    actor: 'system',
    payload: { entity: 'slave', id: created.id, field: 'created', from: null, to: created.name },
  })
  return ok({ slaveId: created.id, created: true })
}

/**
 * A NEW project worker, straight from a catalog template (R4) -- the case where neither the
 * project nor the company roster can do the work.
 *
 * REUSES rather than duplicates (plan erratum E10): one supervised pass decides every fresh
 * situation, so two `capability_unstaffed` situations can both land on the same template, and a
 * second approval must not put a second copy of the same specialist on the project. The existing
 * worker gains whatever capabilities and roles the second hire would have brought, and keeps the
 * rationale of the hire that actually created it -- that sentence is why it is here.
 *
 * `temporary` is recorded in the rationale and nowhere else until M50 owns the lifecycle: a column
 * nothing releases would be a promise the system cannot keep.
 */
export async function hireFromTemplate(
  workspaceId: string,
  templateId: string,
  opts: { readonly capabilities?: readonly string[]; readonly rationale: string; readonly temporary?: boolean },
): Promise<Result<{ readonly slaveId: string; readonly reused: boolean; readonly capabilities: readonly string[]; readonly runtimeRoles: readonly string[] }, ControlRefusal>> {
  const taxonomy = await listCapabilities()
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const template = await prisma.slaveTemplate.findUnique({ where: { id: templateId } })
  if (template === null) return err({ kind: 'template_not_found', templateId })

  const asked = opts.capabilities ?? []
  for (const key of asked) {
    if (!taxonomy.some((record) => record.key === key)) return err({ kind: 'capability_not_found', key })
  }
  const capabilities = [...new Set([...template.capabilityKeys, ...asked])].toSorted()
  const runtimeRoles = [...new Set([template.role, ...projectRoles(capabilities, taxonomy)])]
  const rationale = opts.temporary === true ? `${opts.rationale} (asked for as a temporary specialist)` : opts.rationale

  const existing = await prisma.slave.findFirst({
    where: { hiredFromTemplateId: templateId, team: { workspaceId } },
    orderBy: { id: 'asc' },
  })
  if (existing !== null) {
    const merged = [...new Set([...existing.capabilities, ...capabilities])].toSorted()
    const roles = [...existing.runtimeRoles]
    for (const role of runtimeRoles) if (!roles.includes(role)) roles.push(role)
    await prisma.slave.update({ where: { id: existing.id }, data: { capabilities: merged, runtimeRoles: roles } })
    return ok({ slaveId: existing.id, reused: true, capabilities: merged, runtimeRoles: roles })
  }

  const created = await prisma.$transaction(async (tx) => {
    const teams = await tx.team.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } })
    // A hire needs a department. The first by name is deterministic and is the one a
    // single-department project has; a project with none gets `Specialists`, which says what it
    // is rather than borrowing a name from a company this project may not have.
    const team = teams[0] ?? (await tx.team.create({ data: { workspaceId, name: 'Specialists' } }))
    return tx.slave.create({
      data: {
        teamId: team.id,
        name: uniqueSlaveName(await tx.slave.findMany({ where: { team: { workspaceId } }, select: { name: true } }), template.name),
        role: template.role,
        runtimeRoles,
        capabilities,
        hiredFromTemplateId: templateId,
        selectionRationale: rationale,
      },
    })
  })

  await appendEvent({
    type: 'org.changed',
    workspaceId,
    slaveId: created.id,
    actor: 'system',
    payload: { entity: 'slave', id: created.id, field: 'created', from: null, to: created.name },
  })
  return ok({ slaveId: created.id, reused: false, capabilities, runtimeRoles })
}

/** `Name`, then `Name 2`, `Name 3`… -- a project may already have a worker with the template's
 *  name (a legacy hand-made one, or one from a company whose roster borrowed it), and there is no
 *  unique index to lean on here. Deterministic and readable, which a uuid suffix would not be. */
function uniqueSlaveName(existing: readonly { readonly name: string }[], wanted: string): string {
  const taken = new Set(existing.map((row) => row.name))
  if (!taken.has(wanted)) return wanted
  for (let n = 2; ; n += 1) {
    const candidate = `${wanted} ${String(n)}`
    if (!taken.has(candidate)) return candidate
  }
}

/** The same rule for a department, because `Team_workspaceId_name_key` is a real unique index and
 *  a materialisation must not die on a name a hand-made department already holds. */
function uniqueTeamName(existing: readonly { readonly name: string }[], wanted: string): string {
  return uniqueSlaveName(existing, wanted)
}

/** Who is on this project, what they provide and why they are here (R6) -- the read behind the
 *  Organization view and behind `formTeam`'s roster. One query for the workers, one for the hints
 *  their templates carry; never a query per worker. */
export interface OrganizationWorker {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly runtimeRoles: readonly string[]
  readonly capabilities: readonly string[]
  readonly kind: 'company' | 'project'
  readonly companyName: string | null
  readonly hiredFromTemplateId: string | null
  readonly hiredFromTemplateName: string | null
  readonly selectionRationale: string | null
  readonly busy: boolean
}

export interface OrganizationView {
  readonly workers: readonly OrganizationWorker[]
  readonly hints: readonly { readonly slaveId: string; readonly text: string; readonly targetTemplateName: string | null; readonly capability: string | null }[]
}

export async function listOrganization(workspaceId: string): Promise<Result<OrganizationView, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const rows = await prisma.slave.findMany({
    where: { team: { workspaceId } },
    orderBy: { name: 'asc' },
    include: {
      hiredFromTemplate: { select: { id: true, name: true } },
      companySlave: { include: { template: { select: { id: true, name: true } }, companyTeam: { include: { company: { select: { name: true } } } } } },
      runs: { where: { status: { in: ['queued', 'starting', 'running', 'paused', 'stopping'] } }, select: { id: true }, take: 1 },
    },
  })

  const templateBySlave = new Map(
    rows.flatMap((row) => {
      const templateId = row.hiredFromTemplate?.id ?? row.companySlave?.template.id ?? null
      return templateId === null ? [] : [[row.id, templateId] as const]
    }),
  )
  const hintRows =
    templateBySlave.size === 0
      ? []
      : await prisma.collaborationHint.findMany({
          where: { templateId: { in: [...new Set(templateBySlave.values())] } },
          include: { targetTemplate: { select: { name: true } } },
          orderBy: [{ templateId: 'asc' }, { text: 'asc' }],
        })

  return ok({
    workers: rows.map((row) => ({
      slaveId: row.id,
      name: row.name,
      role: row.role,
      runtimeRoles: row.runtimeRoles,
      capabilities: row.capabilities,
      kind: row.companySlaveId === null ? 'project' : 'company',
      companyName: row.companySlave?.companyTeam.company.name ?? null,
      hiredFromTemplateId: row.hiredFromTemplate?.id ?? null,
      hiredFromTemplateName: row.hiredFromTemplate?.name ?? null,
      selectionRationale: row.selectionRationale,
      busy: row.runs.length > 0,
    })),
    hints: [...templateBySlave].flatMap(([slaveId, templateId]) =>
      hintRows
        .filter((hint) => hint.templateId === templateId)
        .map((hint) => ({
          slaveId,
          text: hint.text,
          targetTemplateName: hint.targetTemplate?.name ?? null,
          capability: hint.capability,
        })),
    ),
  })
}
```

`packages/control/src/index.ts` re-exports with `export *`; add `export * from './capability.js'` in the same block as its neighbours.

- [ ] **Step 5: Run the control test**

Run: `npx vitest run packages/control/test/integration/capability.test.ts`
Expected: PASS.

- [ ] **Step 6: Teach the importer capabilities and hints (R1, R5, E11)**

In `packages/control/src/catalog.ts`:

1. At the top of `importCatalog`, before the row loop and after the role-map check:

```ts
  // R1: nothing matches on a key that is not a row, so the table is reconciled before a single
  // persona is read. Cheap and idempotent -- `{ created: 0, updated: 0 }` on every import after
  // the first.
  await syncCapabilityTaxonomy()
  const taxonomy = await listCapabilities()
```

2. In `importRow`, beside the existing `personaToProfileSpec` call:

```ts
  // Both halves of R1's promise, computed with the mapping and outside the transaction: the KEYS a
  // catalog search and `formTeam` read, and the sentences that matched none of them -- kept
  // verbatim so an operator can see what the taxonomy is missing.
  const { keys: capabilityKeys, unresolved: unresolvedCapabilities } = normaliseCapabilities(upstream.capabilities, taxonomy)
```

and `capabilityKeys`, `unresolvedCapabilities` are added to the `data` of all three writes (the `create`, the E22 `structured` update and the `updated` update) — the third one recomputes them from the NEW upstream spec, which is the point.

3. A second pass at the end of `importCatalog`, after the row loop and before the `CatalogImport` row is written:

```ts
  // R5, plan erratum E11: hints resolve against EVERY template, so a sentence naming a persona
  // that is imported later in the same run still finds it. Per template it is a replace, under
  // `@@unique([templateId, text])`, so a re-import can never double an edge.
  if (input.dryRun !== true) {
    await writeCollaborationHints(
      [...created, ...updated, ...unchanged].flatMap((row) => (row.templateId === null ? [] : [row.templateId])),
      taxonomy,
    )
  }
```

```ts
/** The hint pass (R5). One read of every template's name, one read of the specs being re-hinted,
 *  and one replace per template -- never a query per sentence. */
async function writeCollaborationHints(templateIds: readonly string[], taxonomy: readonly CapabilityRecord[]): Promise<void> {
  if (templateIds.length === 0) return
  const names = await prisma.slaveTemplate.findMany({ select: { id: true, name: true } })
  const rows = await prisma.slaveTemplate.findMany({ where: { id: { in: [...templateIds] } }, select: { id: true, profileSpec: true } })
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
          targetTemplateId: draft.targetTemplateId,
          capability: draft.capability,
          source: 'import',
        })),
        skipDuplicates: true,
      }),
    ])
  }
}
```

4. `listWorkforceCatalog`'s row select gains `capabilityKeys` and `unresolvedCapabilities`, and `WorkforceCatalogRow` gains `readonly capabilityKeys: readonly string[]` beside its existing free-text `capabilities` (which stays: it is what the search box matches and what a row shows for an unstructured template).

Add to `packages/control/test/integration/catalog.test.ts`:

```ts
  it('resolves a persona capability to a taxonomy key and keeps what did not resolve (M47 R1)', async () => {
    // …import a persona whose Core Capabilities bullets are "Application security" and "Vibes"…
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId } })
    expect(row.capabilityKeys).toEqual(['security.application'])
    expect(row.unresolvedCapabilities).toEqual(['Vibes'])
  })

  it('resolves a collaboration hint to the persona it names, whichever order they imported in (M47 R5)', async () => {
    // …import two personas in ONE call, the second of which is the one the first's hint names…
    const hints = await prisma.collaborationHint.findMany({ include: { targetTemplate: true } })
    expect(hints).toHaveLength(1)
    expect(hints[0]?.targetTemplate?.name).toBe('Gate Platform Builder')
    expect(hints[0]?.capability).toBe('security.application')
    // A second import of the same directory replaces rather than doubles.
    await importCatalog(input)
    expect(await prisma.collaborationHint.count()).toBe(1)
  })
```

- [ ] **Step 7: Project the roles at whole-company materialisation (R2)**

In `packages/control/src/org.ts`, `assignCompanyTx` takes the taxonomy through its options (the caller reads it once) and its `slave.create` becomes:

```ts
      // M47 R2: a materialised worker carries what its template PROVIDES, and its runtime roles
      // are seeded with the roles those capabilities project to -- ADDITIVELY, on top of the
      // override-and-catalog pair M33/M37 already write. The set only ever grows here: an
      // override is a translation, a projection is an addition, and neither is a replacement.
      const capabilities = template.capabilityKeys
      const worker = await tx.slave.create({
        data: {
          teamId: team.id,
          name: companySlave.name,
          role: override ?? template.role,
          runtimeRoles: [...new Set([override ?? template.role, template.role, ...projectRoles(capabilities, options?.taxonomy ?? [])])],
          capabilities: [...capabilities],
          companySlaveId: companySlave.id,
        },
      })
```

with `AssignOptions` gaining `readonly taxonomy?: readonly CapabilityRecord[]` (documented: absent means "project nothing", which is what every pre-M47 caller and every fixture means) and `assignCompany` passing `await listCapabilities()`. Add to `packages/control/test/integration/org.test.ts` a case asserting that a company whose template has `capabilityKeys: ['security.application']` materialises a worker with `capabilities` set and `runtimeRoles` containing both the catalog role and `security`.

- [ ] **Step 8: Write the capabilities into tasks, and derive the role (R3, E1, E2, E14)**

In `apps/orchestrator/src/planning.ts`, inside `concludePlanning`'s transaction, replacing the single `requiredRole: planTask.role` line:

```ts
  // R3: the taxonomy is the vocabulary a plan is written in, and the table is the authority on it.
  // Read ONCE for the whole graph, before the transaction -- three hundred tasks must not be three
  // hundred taxonomy reads.
  const taxonomy = await listCapabilities()
  const dropped = new Set<string>()
```

```ts
      const { keys, unresolved } = normaliseCapabilitiesStrict(planTask.capabilities, taxonomy)
      for (const key of unresolved) dropped.add(key)
      // R2's precedence, and E1/E2's guarantee that it is total: an explicit role wins (the
      // planner said what it wanted and the vocabulary is older than this milestone); otherwise
      // the role of the FIRST valid capability the task asked for. `validateStructure` refuses a
      // task with neither, so this is never null for a task a plan created.
      const requiredRole = planTask.role ?? roleOfFirst(keys, taxonomy)
```

```ts
          requiredRole,
          requiredCapabilities: keys,
```

where the two helpers live beside `concludePlanning` and are shared with `replan.ts` (exported from `planning.ts`, imported there — `replan.ts` already imports from it):

```ts
/**
 * The keys a task may keep, and the ones it may not (R3).
 *
 * A model can only be told which keys exist; it cannot be prevented from inventing one. An
 * invented key is DROPPED -- nothing matches on a key that is not in the table (R1) -- and
 * recorded on the plan event, because a silently ignored vocabulary is how an operator concludes
 * the feature does not work. Deliberately NOT `normaliseCapabilities`: the planner was given exact
 * keys, and accepting a label here would let a plan name capabilities in a different vocabulary
 * from the one the prompt showed it.
 */
export function normaliseCapabilitiesStrict(
  values: readonly string[],
  taxonomy: readonly CapabilityRecord[],
): { readonly keys: readonly string[]; readonly unresolved: readonly string[] } {
  const known = new Set(taxonomy.map((record) => record.key))
  const keys: string[] = []
  const unresolved: string[] = []
  for (const value of values) {
    const key = value.trim()
    if (key === '') continue
    if (!known.has(key)) {
      if (!unresolved.includes(key)) unresolved.push(key)
      continue
    }
    if (!keys.includes(key)) keys.push(key)
  }
  return { keys, unresolved }
}

/** The DERIVED dispatch role (R2): the role of the first capability the task asked for that the
 *  taxonomy knows. `null` only when the task asked for nothing the table has -- in which case the
 *  planner's own role is what stands, and `validateStructure` guaranteed there is one. */
export function roleOfFirst(keys: readonly string[], taxonomy: readonly CapabilityRecord[]): string | null {
  for (const key of keys) {
    const record = taxonomy.find((row) => row.key === key)
    if (record !== undefined) return record.role
  }
  return null
}
```

The `workspace.plan_created` event gains `...(dropped.size === 0 ? {} : { droppedCapabilities: [...dropped].toSorted() })` in its payload, and `rows.push({ id: task.id, title: task.title, role: requiredRole ?? '' })` becomes `role: task.requiredRole ?? ''`… — read it off the CREATED row, so the event says what was stored. (`requiredRole` is a non-empty string for every task a plan creates, by E1 and E2 together; `?? ''` would fail the payload schema's `min(1)` and that is the right way to find out if the guarantee ever breaks.)

`apps/orchestrator/src/replan.ts`'s delta-added task creation takes the identical four lines and its `workspace.replanned` event takes the same `droppedCapabilities`.

- [ ] **Step 9: Render the capabilities section (E3)**

In `apps/orchestrator/src/runContext.ts`, beside `planningGoalSection`:

```ts
/** How many keys a planning prompt is shown. The taxonomy is ~50 rows today and an operator may
 *  add more; a prompt is not the place for an unbounded list, and `capped` on the source is what
 *  tells a reader the planner was shown a subset. */
const CAPABILITY_KEYS_IN_PROMPT = 80

/**
 * The vocabulary a plan may be written in (M47 R3, plan erratum E3).
 *
 * A SECTION rather than part of `PLANNING_GRAPH_INSTRUCTIONS`: that constant is pure, static and
 * pinned byte-for-byte, and this list is per-workspace data read out of a table. It renders LAST
 * (`SECTION_ORDER.planning`), so the keys sit directly above the trailer that asks for them.
 *
 * The text must never contain the quoted literals `"verdict"`, `"replan"` or `"task graph"`: the
 * fake CLI selects its review, re-plan and planning arms on exactly those, and a first-plan prompt
 * carrying `"replan"` would be answered with a delta fixture. A test pins it.
 */
async function capabilitiesSection(): Promise<Section | null> {
  const rows = await prisma.capability.findMany({ orderBy: { key: 'asc' }, select: { key: true, label: true } })
  if (rows.length === 0) return null
  const shown = rows.slice(0, CAPABILITY_KEYS_IN_PROMPT)
  return {
    kind: 'capabilities',
    text: block('CAPABILITIES YOU MAY ASK FOR', [
      'Each task in the JSON object you return may carry a "capabilities" array. Use ONLY the keys',
      'below, exactly as they are spelt; a key that is not here is dropped. A task may name none,',
      'in which case give it a "role" instead.',
      '',
      ...shown.map((row) => `- ${row.key}: ${row.label}`),
      ...(rows.length > shown.length ? ['', `(${String(rows.length - shown.length)} further keys are not listed.)`] : []),
    ]),
    source: { kind: 'capabilities', keys: shown.map((row) => row.key), capped: rows.length > shown.length },
  }
}
```

called from `buildRunContext`'s planning branch after the `replan` push:

```ts
    const capabilities = await capabilitiesSection()
    if (capabilities !== null) sections.push(capabilities)
```

and from `renderReplanPreview` on the same terms, so the preview a person reads is the prompt the run would be given.

- [ ] **Step 10: Extend the orchestrator tests**

`apps/orchestrator/test/integration/planning.test.ts` gains three cases, beside the existing "requiredRole equals the plan's role" one (which stays exactly as it is — a plan that names a role still stores that role):

```ts
  it('stores the required capabilities and derives the role from them (M47 R3)', async () => {
    // …a planning run whose output carries {"key":"a",…,"capabilities":["security.application"]}…
    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId } })
    expect(task.requiredCapabilities).toEqual(['security.application'])
    expect(task.requiredRole).toBe('security')
  })

  it('keeps the planner\'s own role when it named one, capabilities or not', async () => {
    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId } })
    expect(task.requiredRole).toBe('backend')
    expect(task.requiredCapabilities).toEqual(['security.application'])
  })

  it('drops a key the taxonomy does not have and records it on the plan event', async () => {
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId, type: 'workspace_plan_created' } })
    expect((event.payload as { droppedCapabilities?: string[] }).droppedCapabilities).toEqual(['nope.nothing'])
    const task = await prisma.task.findFirstOrThrow({ where: { workspaceId } })
    expect(task.requiredCapabilities).toEqual([])
  })
```

and `apps/orchestrator/test/integration/runContext.test.ts` gains:

```ts
  it('shows a planning run the taxonomy keys, above the trailer, and says so in the manifest', async () => {
    const { prompt, manifest } = /* build a planning context on a workspace whose taxonomy is seeded */
    expect(prompt).toContain('- security.application: Application security')
    expect(prompt.indexOf('CAPABILITIES YOU MAY ASK FOR')).toBeLessThan(prompt.indexOf(PLANNING_GRAPH_INSTRUCTIONS))
    expect(prompt.endsWith(PLANNING_GRAPH_INSTRUCTIONS)).toBe(true)
    // The three literals the fake CLI routes on: a planning prompt that carried any of them in
    // THIS section would be answered from the wrong fixture.
    const section = prompt.slice(prompt.indexOf('CAPABILITIES YOU MAY ASK FOR'), prompt.indexOf(PLANNING_GRAPH_INSTRUCTIONS))
    for (const literal of ['"verdict"', '"replan"', '"task graph"']) expect(section).not.toContain(literal)
    expect(manifest.sections.at(-1)).toEqual({ kind: 'capabilities', keys: expect.any(Array), capped: false })
  })
```

- [ ] **Step 11: Add the CLI verbs (§2)**

In `apps/orchestrator/src/cli.ts`, three cases beside `set-runtime-roles`:

```ts
    case 'capabilities': {
      // `capabilities sync | add | list` -- one command with a subcommand, the `skills` verb's own
      // shape in this file, because three sibling top-level verbs for one table would read as
      // three unrelated features.
      const sub = positionals[1] ?? 'list'
      if (sub === 'sync') {
        const out = await syncCapabilityTaxonomy()
        process.stdout.write(`taxonomy synced: ${String(out.created)} added, ${String(out.updated)} brought back to the checked-in list\n`)
        return 0
      }
      if (sub === 'add') {
        const result = await addCapability({
          key: requireFlag(flags, 'key'),
          label: requireFlag(flags, 'label'),
          role: requireFlag(flags, 'role'),
          ...(flagText(flags, 'synonyms') === undefined ? {} : { synonyms: requireFlag(flags, 'synonyms').split(',') }),
        })
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(`${result.value.key} added: ${result.value.label}, dispatched as "${result.value.role}"\n`)
        return 0
      }
      if (sub === 'list') {
        for (const record of await listCapabilities()) {
          process.stdout.write(`${record.key}\t${record.label}\t-> ${record.role}\n`)
        }
        return 0
      }
      throw new Error('capabilities takes sync, add or list')
    }

    case 'set-capabilities': {
      const slaveId = requireFlag(flags, 'slave')
      // `--capabilities ''` clears them, the `--roles ''` idiom: an empty set is a real state.
      const raw = requireFlag(flags, 'capabilities')
      const result = await setSlaveCapabilities(slaveId, raw.trim() === '' ? [] : raw.split(','), operatorName(flags))
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `${slaveId} provides ${result.value.keys.length === 0 ? 'nothing' : result.value.keys.join(', ')}; ` +
          `runtime roles ${result.value.runtimeRoles.join(', ')}\n`,
      )
      // Printed, never silent: an unresolved sentence is a fact about the taxonomy an operator can act on.
      for (const unresolved of result.value.unresolved) {
        process.stderr.write(`WARNING: "${unresolved}" matches no capability in the taxonomy and was not stored\n`)
      }
      return 0
    }

    case 'hire': {
      const result = await hireFromTemplate(requireFlag(flags, 'workspace'), requireFlag(flags, 'template'), {
        rationale: requireFlag(flags, 'why'),
        ...(flagText(flags, 'capability') === undefined ? {} : { capabilities: [requireFlag(flags, 'capability')] }),
        ...('temporary' in flags ? { temporary: true } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `${result.value.reused ? 'reused' : 'hired'} ${result.value.slaveId}: provides ${result.value.capabilities.join(', ')}, ` +
          `dispatchable as ${result.value.runtimeRoles.join(', ')}\n`,
      )
      return 0
    }
```

with all three added to the `help` text block, and `apps/orchestrator/test/integration/cli.test.ts` gaining one case per verb (`capabilities list` prints a seeded key; `set-capabilities` warns on stderr about an unresolved word and stores nothing for it; `hire` prints `hired` the first time and `reused` the second).

- [ ] **Step 12: Full task verification**

```bash
npx vitest run packages/control/test/integration packages/domain/test/scheduler apps/orchestrator/test/integration/planning.test.ts apps/orchestrator/test/integration/runContext.test.ts apps/orchestrator/test/integration/cli.test.ts apps/orchestrator/test/integration/world.test.ts apps/web/test/refusal-status.test.ts
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: all green. `world.test.ts` and `decide.test.ts` are on the list because this task is where `requiredRole` stopped being copied from one field — if either moves, dispatch moved, and that is news. If `cli.test.ts`'s llm-decision row-count case fails, re-run that file ALONE before believing it (it doubles when anything else touches the database).

- [ ] **Step 13: Commit**

```bash
git add packages/control/src packages/control/test/integration apps/orchestrator/src apps/orchestrator/test/integration apps/web/test/refusal-status.test.ts
git commit -m "$(cat <<'EOF'
feat(control,orchestrator): m47 t2 -- the verbs behind a capability, and a plan written in the taxonomy's words

The taxonomy is reconciled before any persona is read, so nothing can match on a key that is not a
row. An import resolves each persona's capability bullets to keys and keeps what resolved to
nothing, verbatim, beside the row it came from -- a sentence the taxonomy is missing is a fact an
operator can act on.

Collaboration hints are written in a SECOND pass over every template name, because a sentence that
names a persona imported later in the same run has to find it, and a re-import replaces a
template's edges rather than doubling them.

`concludePlanning` writes the capabilities a plan asked for and derives the role from them when the
planner named none; a key the table does not have is dropped and reported on the plan event. The
scheduler is untouched: it still matches one string against one set, and `decide.test.ts` and
`world.test.ts` run in this task's verification to say so.

`hireFromTemplate` REUSES the worker it already hired from a template on that project. One
supervised pass decides every fresh situation, so two capability situations can land on the same
template, and two approvals must not put two copies of one specialist on a project that needed one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 3: The Supervisor sees a missing capability, and offers the three ways to fill it (R4, E4, E8, E9, E10, E16)

**Files:**
- Modify: `packages/domain/src/supervisor/{situations,observe,actions,candidates,policy,world}.ts`
- Modify: `packages/control/src/supervisorWorld.ts`, `packages/control/src/supervisor.ts`
- Modify: `apps/web/src/components/SupervisorPanel.tsx` (the `actionText` switch — exhaustive, so it does not compile without this)
- Test: `packages/domain/test/supervisor/{fixtures.ts,observe.test.ts,candidates.test.ts,policy.test.ts}`, `packages/control/test/integration/supervisor.test.ts`, `apps/web/test/supervisor-panel.test.tsx`

**Interfaces:**
- Consumes from Tasks 1–2: `formTeam`, `TeamPlan`, `projectRoles`, `capabilityLabel`, `type CapabilityRecord`; `listCapabilities`, `hireFromTemplate`, `materialiseCompanySlave`; `Task.requiredCapabilities`, `Slave.capabilities`, `SlaveTemplate.capabilityKeys`, the `capability_unstaffed` enum member.
- Produces, for Tasks 4–5:
  - `SituationKind` gains `'capability_unstaffed'`; `SITUATION_LABEL.capability_unstaffed = 'Missing a capability'`
  - `Action` gains `{ kind: 'assign_capability'; slaveId: string; capability: string; role: string }`, `{ kind: 'materialise_company_worker'; companySlaveId: string; capability: string; name: string }`, `{ kind: 'hire_from_catalog'; templateId: string; capability: string; name: string; rationale: string; temporary: boolean }`; `ACTION_KINDS` gains the three
  - `SupervisorSlave` gains `capabilities: readonly string[]`; `SupervisorWorld` gains `company: readonly SupervisorCompanyWorker[]` and `catalog: readonly SupervisorCatalogEntry[]`
  - `SupervisorTask` gains `requiredCapabilities: readonly string[]`
  - `teamPlanOf(world: SupervisorWorld): TeamPlan` (exported from `candidates.ts`, used by the web read model in Task 4)

- [ ] **Step 1: Widen the shared fixtures first (E16)**

`packages/domain/test/supervisor/fixtures.ts` — three defaults, so every existing supervisor test keeps compiling and passing:

```ts
export function task(overrides: Partial<SupervisorTask> = {}): SupervisorTask {
  return {
    // …unchanged fields…
    // M47: a task planned before capabilities existed asks for none, which is what every fixture
    // in this file means unless it says otherwise.
    requiredCapabilities: [],
    ...overrides,
  }
}

export function slave(overrides: Partial<SupervisorSlave> = {}): SupervisorSlave {
  return { id: 's1', name: 'Alex', role: 'Backend Engineer', runtimeRoles: ['backend'], capabilities: [], busy: false, ...overrides }
}

export function world(overrides: Partial<SupervisorWorld> = {}): SupervisorWorld {
  return {
    // …unchanged fields…
    company: [],
    catalog: [],
    taxonomy: [],
    ...overrides,
  }
}
```

- [ ] **Step 2: Write the failing tests for the situation and the candidates**

Append to `packages/domain/test/supervisor/observe.test.ts`:

```ts
const TAXONOMY = [
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: [] },
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: [] },
]

describe('observe -- capability_unstaffed (M47 R4)', () => {
  it('fires per CAPABILITY when a startable task needs one nobody can be dispatched for', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['capability_unstaffed', 'security.application']])
    expect(observe(w)[0]?.facts).toEqual({ capability: 'security.application', role: 'security', readyTasks: 1, firstTaskId: 't1' })
  })

  it('does not fire when somebody holds the role the capability projects to', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ runtimeRoles: ['security'] })],
    })
    expect(observe(w)).toEqual([])
  })

  // E8: supersession is per TASK, and it is what stops one gap producing two proposals.
  it('supersedes ready_unstaffed for the task that raised it', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w)).map(([kind]) => kind)).not.toContain('ready_unstaffed')
  })

  it('leaves ready_unstaffed alone for a task that declared no capabilities', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [
        task({ id: 't1', status: 'ready', requiredRole: 'security', requiredCapabilities: ['security.application'] }),
        task({ id: 't2', status: 'ready', requiredRole: 'frontend', requiredCapabilities: [] }),
      ],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([
      ['capability_unstaffed', 'security.application'],
      ['ready_unstaffed', 'frontend'],
    ])
  })

  it('still raises ready_unstaffed for a task whose capabilities are all staffed but whose role is not held', () => {
    // A hand-set `requiredRole` an operator typed, with capabilities somebody does hold.
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredRole: 'qa', requiredCapabilities: ['backend.api-design'] })],
      slaves: [slave({ runtimeRoles: ['backend'] })],
    })
    expect(keys(observe(w))).toEqual([['ready_unstaffed', 'qa']])
  })

  it('counts the tasks and names the first, and ignores a task whose dependencies are not done', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [
        task({ id: 't2', status: 'ready', requiredCapabilities: ['security.application'] }),
        task({ id: 't1', status: 'ready', requiredCapabilities: ['security.application'] }),
        task({ id: 't3', status: 'ready', requiredCapabilities: ['security.application'], dependenciesDone: false }),
      ],
      slaves: [],
    })
    expect(observe(w)[0]?.facts.readyTasks).toBe(2)
    expect(observe(w)[0]?.facts.firstTaskId).toBe('t2')
  })
})
```

Append to `packages/domain/test/supervisor/candidates.test.ts`:

```ts
describe('candidates -- capability_unstaffed (M47 R4)', () => {
  const situation = { kind: 'capability_unstaffed' as const, subjectId: 'security.application', summary: 's', facts: { capability: 'security.application', role: 'security' } }

  it('offers the idle worker who already provides it, routinely, before anything else', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredCapabilities: ['security.application'] })],
      slaves: [slave({ id: 's1', name: 'Rae', capabilities: ['security.application'], runtimeRoles: ['backend'] })],
      company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
      catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security', recommended: false }],
    })
    const offers = candidates(situation, w)
    expect(offers[0]?.action).toEqual({ kind: 'assign_capability', slaveId: 's1', capability: 'security.application', role: 'security' })
    expect(offers[0]?.tier).toBe('applied')
    expect(offers[0]?.why).toContain('Application security')
  })

  it('offers the company worker as a PROPOSAL when nobody on the project provides it', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredCapabilities: ['security.application'] })],
      company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
      catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security', recommended: false }],
    })
    const offers = candidates(situation, w)
    expect(offers[0]?.action.kind).toBe('materialise_company_worker')
    expect(offers[0]?.tier).toBe('proposed')
  })

  it('offers the catalog hire last, with the rationale a person reads, and never applies it', () => {
    const w = world({
      taxonomy: TAXONOMY,
      tasks: [task({ status: 'ready', requiredCapabilities: ['security.application'] })],
      catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security', recommended: false }],
    })
    const offers = candidates(situation, w)
    expect(offers[0]?.action).toEqual({
      kind: 'hire_from_catalog',
      templateId: 'tpl1',
      capability: 'security.application',
      name: 'Security Reviewer',
      rationale: expect.stringContaining('Application security'),
      temporary: false,
    })
    expect(offers[0]?.tier).toBe('proposed')
  })

  // The invariant the whole of M38 is built on, restated for the new kind.
  it('always ends with escalate_to_human then no_action, even with nothing to offer', () => {
    const offers = candidates(situation, world({ taxonomy: TAXONOMY }))
    expect(offers.map((offer) => offer.action.kind)).toEqual(['escalate_to_human', 'no_action'])
  })

  // E9: the four existing staffing arms are untouched, and gate:m38 answers index 0.
  it('leaves no_reviewer offering exactly the M38 staffing candidates', () => {
    const w = world({ tasks: [task({ status: 'reviewing' })], slaves: [slave({ runtimeRoles: ['backend'] })] })
    const offers = candidates({ kind: 'no_reviewer', subjectId: 'reviewer', summary: 's', facts: { role: 'reviewer' } }, w)
    expect(offers[0]?.action.kind).toBe('set_runtime_roles')
    expect(offers).toHaveLength(3)
  })
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/supervisor`
Expected: FAIL — `capability_unstaffed` is not a `SituationKind`, `world()` has no `taxonomy`.

- [ ] **Step 4: Add the situation, its label and the world's three new fields**

`packages/domain/src/supervisor/situations.ts` — the member goes immediately BEFORE `ready_unstaffed`, because `SITUATION_KINDS` order is the report's order and a missing capability is the more specific reading of the same gap:

```ts
  /**
   * M47 R4: a startable task needs a CAPABILITY nobody in this workspace can be dispatched for.
   * `subjectId` is the capability key, so ten tasks blocked on one gap are one situation.
   *
   * Supersedes {@link ready_unstaffed} for the task that raised it (plan erratum E8) -- that kind
   * remains the role-only fallback, for a task that declared no capabilities at all and for one
   * whose capabilities are staffed but whose hand-typed role is held by nobody.
   */
  'capability_unstaffed',
  'ready_unstaffed',
```

with `capability_unstaffed: 'Missing a capability',` in `SITUATION_LABEL` and the `subjectId` doc comment gaining "the CAPABILITY KEY for `capability_unstaffed`".

`packages/domain/src/supervisor/world.ts`:

```ts
/** A company roster worker who is NOT already on this project (R4) -- the second place the
 *  Supervisor looks. Loaded only when the board actually asks for a capability. */
export interface SupervisorCompanyWorker {
  readonly companySlaveId: string
  readonly name: string
  readonly capabilities: readonly string[]
}

/** A catalog template, with what it provides (R4) -- the third place. `recommended` is R5's
 *  advisory tie-break: some worker already here has a profile that recommends pairing with it. */
export interface SupervisorCatalogEntry {
  readonly templateId: string
  readonly name: string
  readonly capabilities: readonly string[]
  readonly division: string | null
  readonly recommended: boolean
}
```

`SupervisorTask` gains `readonly requiredCapabilities: readonly string[]`, `SupervisorSlave` gains `readonly capabilities: readonly string[]` (documented: what it PROVIDES, as opposed to `runtimeRoles`, what it may be dispatched as), and `SupervisorWorld` gains:

```ts
  /** The taxonomy this workspace's capabilities are read against (R1). Empty is a real state --
   *  a database whose taxonomy has never been synced -- and every capability rule is a no-op
   *  under it, which is exactly right: nothing matches on a key that is not a row. */
  readonly taxonomy: readonly CapabilityRecord[]
  readonly company: readonly SupervisorCompanyWorker[]
  readonly catalog: readonly SupervisorCatalogEntry[]
```

- [ ] **Step 5: Write the predicate (E8)**

In `packages/domain/src/supervisor/observe.ts`, immediately BEFORE the `ready_unstaffed` block:

```ts
  // capability_unstaffed: keyed by the CAPABILITY, so N startable tasks blocked on one gap are one
  // situation. "Unstaffed" is "nobody holds the role it projects to" (plan erratum E8), not
  // "nobody has it": the whole point of the `assign_capability` offer is a worker who HAS the
  // capability and was never given its runtime role, and a predicate that read coverage off the
  // capability alone would call that case staffed and never offer the fix.
  const unstaffedCapabilities = new Map<string, SupervisorTask[]>()
  const raisedFor = new Set<string>()
  for (const t of world.tasks) {
    if (t.status !== 'ready' || !t.dependenciesDone) continue
    for (const capability of t.requiredCapabilities) {
      const role = projectRoles([capability], world.taxonomy)[0]
      // A key the taxonomy does not have projects no role and staffs nobody: it is not a gap this
      // workspace can act on, and a situation about it would offer nothing but an escalation.
      if (role === undefined || roleHasHolder(world, role)) continue
      const waiting = unstaffedCapabilities.get(capability)
      if (waiting === undefined) unstaffedCapabilities.set(capability, [t])
      else waiting.push(t)
      raisedFor.add(t.id)
    }
  }
  for (const [capability, waiting] of unstaffedCapabilities) {
    const role = projectRoles([capability], world.taxonomy)[0] ?? ''
    add({
      kind: 'capability_unstaffed',
      subjectId: capability,
      summary: `${waiting.length} startable task(s) need "${capability}" and no slave can be dispatched as "${role}".`,
      facts: { capability, role, readyTasks: waiting.length, firstTaskId: waiting[0]?.id ?? null },
    })
  }
```

and one line inside the `ready_unstaffed` loop, after the empty-role skip:

```ts
    // E8: the capability reading of this task is already a situation of its own; reporting the
    // role gap as well would put two proposals in front of a person for one hole.
    if (raisedFor.has(task.id)) continue
```

- [ ] **Step 6: Add the three actions and their tiers**

`packages/domain/src/supervisor/actions.ts`:

```ts
  /** `setRuntimeRoles` (as a union): a worker who ALREADY provides the capability is given the
   *  runtime role it projects to. The routine one of the three (M47 R4) -- see `tierOf`. */
  | { readonly kind: 'assign_capability'; readonly slaveId: string; readonly capability: string; readonly role: string }
  /** `materialiseCompanySlave`: one worker off the company roster onto this project. */
  | { readonly kind: 'materialise_company_worker'; readonly companySlaveId: string; readonly capability: string; readonly name: string }
  /** `hireFromTemplate`: a new project worker from a catalog template. `rationale` is the sentence
   *  stored on the worker (`Slave.selectionRationale`) and shown on the Organization view --
   *  "why selected", months later. `temporary` is M50's lifecycle, recorded as a claim on the
   *  decision and in the rationale until there is something that can release a worker. */
  | { readonly kind: 'hire_from_catalog'; readonly templateId: string; readonly capability: string; readonly name: string; readonly rationale: string; readonly temporary: boolean }
```

with the three names appended to `ACTION_KINDS` (after `set_runtime_roles`, keeping the list's "staffing before mailbox" reading) and their `z.object` arms added to `actionSchema`:

```ts
  z.object({ kind: z.literal('assign_capability'), slaveId: z.string().min(1), capability: z.string().min(1), role: z.string().min(1) }),
  z.object({ kind: z.literal('materialise_company_worker'), companySlaveId: z.string().min(1), capability: z.string().min(1), name: z.string().min(1) }),
  z.object({ kind: z.literal('hire_from_catalog'), templateId: z.string().min(1), capability: z.string().min(1), name: z.string().min(1), rationale: z.string().min(1), temporary: z.boolean() }),
```

`packages/domain/src/supervisor/policy.ts`, inside `tierOf`'s switch:

```ts
    // ROUTINE, and the one thing that makes it different from `set_runtime_roles` is EVIDENCE
    // (M47 R4). A staffing proposal asks a human "is this the right person?"; this one asks
    // nothing -- the worker's own row already records that it provides the capability, and the
    // role being granted is the one that capability projects to by definition (R2). Nobody new
    // arrives, nothing is spent, and the union never takes a role away.
    case 'assign_capability':
      return 'applied'
    // Both bring a WORKER onto a project. Never automatic: a roster is a person's decision, and
    // a hire is a commitment the Supervisor may propose and may not make.
    case 'materialise_company_worker':
    case 'hire_from_catalog':
      return 'proposed'
```

and `packages/domain/test/supervisor/policy.test.ts` gains a case per kind, plus "every one of the three is `proposed` while the workspace is halted" (the halt short-circuit above the switch already does it; the test is what says so).

- [ ] **Step 7: Write the candidates arm**

`packages/domain/src/supervisor/candidates.ts`:

```ts
/**
 * The team the rules would form for this world (M47 R4), computed from the world alone so the
 * same world always yields the same offers. Exported because the Organization view shows the same
 * covered / proposed / unfillable summary a decision was made from, and two computations of "what
 * is missing" would eventually disagree in front of a person.
 */
export function teamPlanOf(world: SupervisorWorld): TeamPlan {
  const required = world.tasks
    .filter((task) => task.status === 'ready' || task.status === 'blocked')
    .flatMap((task) => task.requiredCapabilities)
  return formTeam({
    required,
    roster: world.slaves.map((slave) => ({
      slaveId: slave.id,
      name: slave.name,
      capabilities: slave.capabilities,
      runtimeRoles: slave.runtimeRoles,
      busy: slave.busy,
    })),
    company: world.company.map((worker) => ({ companySlaveId: worker.companySlaveId, name: worker.name, capabilities: worker.capabilities })),
    catalog: world.catalog.map((entry) => ({ templateId: entry.templateId, name: entry.name, capabilities: entry.capabilities, division: entry.division })),
    taxonomy: world.taxonomy,
    recommendedTemplateIds: world.catalog.filter((entry) => entry.recommended).map((entry) => entry.templateId),
  })
}
```

and, in the `candidates` switch, a case of its own — NOT folded into the three role kinds, whose offers must not change (plan erratum E9):

```ts
    case 'capability_unstaffed': {
      // `subjectId` IS the capability key (spec §2 as M47 extends it). The offers are `formTeam`'s
      // proposals for THIS capability, in the order it ranked them: an existing capable worker,
      // then the company roster, then the catalog. Each carries its own rationale sentence, which
      // is what a human -- and the model -- judges the offer by.
      for (const proposal of teamPlanOf(world).proposals.filter((one) => one.covers.includes(situation.subjectId))) {
        const action = actionOf(proposal, situation.subjectId, world)
        if (action !== null) offers.push(candidate(action, world, situation.kind, proposal.rationale))
      }
      break
    }
```

```ts
/** One `formTeam` proposal as an `Action`. Returns null for the `temporary` source, which M47
 *  never emits (M50 owns that lifecycle) -- an arm that threw on it would make a future data
 *  change a crash rather than an offer nobody makes yet. */
function actionOf(proposal: TeamProposal, capability: string, world: SupervisorWorld): Action | null {
  switch (proposal.source) {
    case 'existing_worker':
      return {
        kind: 'assign_capability',
        slaveId: proposal.pick.id,
        capability,
        role: projectRoles([capability], world.taxonomy)[0] ?? '',
      }
    case 'company_worker':
      return { kind: 'materialise_company_worker', companySlaveId: proposal.pick.id, capability, name: proposal.pick.name }
    case 'project_worker':
      return {
        kind: 'hire_from_catalog',
        templateId: proposal.pick.id,
        capability,
        name: proposal.pick.name,
        rationale: proposal.rationale,
        temporary: proposal.temporary,
      }
    case 'temporary':
      return null
  }
}
```

Run: `npx vitest run packages/domain/test/supervisor` → PASS.

- [ ] **Step 8: Load the three new facts (R4)**

In `packages/control/src/supervisorWorld.ts`, inside the transaction:

```ts
      const slaveRows = await tx.slave.findMany({
        where: { team: { workspaceId } },
        select: { id: true, name: true, role: true, runtimeRoles: true, capabilities: true, runs: { /* unchanged */ } },
        orderBy: { id: 'asc' },
      })
```

```ts
      // M47 R4. The catalog and the company roster are read ONLY when the board actually asks for
      // a capability: a project planned before this milestone -- or one whose planner named plain
      // roles -- gets exactly the queries it got before, and no tick scans hundreds of templates
      // to answer a question nobody asked. One query each, never one per capability.
      const asksForCapabilities = taskRows.some((row) => row.requiredCapabilities.length > 0)
      const taxonomy = asksForCapabilities ? await loadTaxonomy(tx) : []
      const companyRows = asksForCapabilities ? await loadCompanyRoster(tx, workspaceId) : []
      const catalogRows = asksForCapabilities ? await loadCatalogEntries(tx, slaveRows) : []
```

```ts
/** The taxonomy, key ascending -- the same order `listCapabilities` returns, because the domain's
 *  "first spelling wins" rule reads it. */
async function loadTaxonomy(tx: Prisma.TransactionClient): Promise<readonly CapabilityRecord[]> {
  const rows = await tx.capability.findMany({ orderBy: { key: 'asc' } })
  return rows.map((row) => ({ key: row.key, label: row.label, domain: row.domain, role: row.role, synonyms: row.synonyms }))
}

/** The company's roster rows that are NOT already materialised into this project (R4's second
 *  place to look). One query: the `NOT EXISTS` is Postgres's, never a filter in JavaScript over a
 *  roster that may be a hundred people. */
async function loadCompanyRoster(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<readonly SupervisorCompanyWorker[]> {
  return tx.$queryRaw<SupervisorCompanyWorker[]>`
    SELECT cs.id AS "companySlaveId", cs.name, t."capabilityKeys" AS capabilities
    FROM "CompanySlave" cs
    JOIN "CompanyTeam" ct ON ct.id = cs."companyTeamId"
    JOIN "Workspace" w ON w."companyId" = ct."companyId"
    JOIN "SlaveTemplate" t ON t.id = cs."templateId"
    WHERE w.id = ${workspaceId}
      AND NOT EXISTS (
        SELECT 1 FROM "Slave" s JOIN "Team" tm ON tm.id = s."teamId"
        WHERE s."companySlaveId" = cs.id AND tm."workspaceId" = ${workspaceId}
      )
    ORDER BY cs.id ASC
  `
}

/** Every catalog template that provides ANY capability, plus whether a worker already here has a
 *  profile that recommends pairing with it (R5's advisory tie-break). Two queries, both bounded:
 *  a template with no `capabilityKeys` can never cover a gap, and the hint read is keyed on the
 *  templates the current roster came from. */
async function loadCatalogEntries(
  tx: Prisma.TransactionClient,
  slaveRows: readonly { readonly id: string }[],
): Promise<readonly SupervisorCatalogEntry[]> {
  const templates = await tx.slaveTemplate.findMany({
    where: { NOT: { capabilityKeys: { isEmpty: true } } },
    select: { id: true, name: true, capabilityKeys: true, sourceDivision: true },
    orderBy: { id: 'asc' },
    take: CATALOG_ENTRIES_MAX,
  })
  const recommended = new Set(
    slaveRows.length === 0
      ? []
      : (
          await tx.collaborationHint.findMany({
            where: {
              targetTemplateId: { not: null },
              OR: [
                { template: { hiredWorkers: { some: { id: { in: slaveRows.map((row) => row.id) } } } } },
                { template: { companySlaves: { some: { slaves: { some: { id: { in: slaveRows.map((row) => row.id) } } } } } } },
              ],
            },
            select: { targetTemplateId: true },
          })
        ).flatMap((hint) => (hint.targetTemplateId === null ? [] : [hint.targetTemplateId])),
  )
  return templates.map((template) => ({
    templateId: template.id,
    name: template.name,
    capabilities: template.capabilityKeys,
    division: template.sourceDivision,
    recommended: recommended.has(template.id),
  }))
}

/** A bound, because a full catalog import is thousands of rows (M55) and a Supervisor world is
 *  built once a tick. Ordered by id, so the same thousand rows come back in the same order and
 *  `formTeam` is still deterministic when the bound bites. */
const CATALOG_ENTRIES_MAX = 500
```

with `requiredCapabilities` added to `loadTaskRows`' `SELECT` and to `TaskRow`, `capabilities: row.capabilities` on the mapped `SupervisorSlave`, `requiredCapabilities: row.requiredCapabilities` on the mapped `SupervisorTask`, and `taxonomy`, `company`, `catalog` on the built `SupervisorWorld`.

- [ ] **Step 9: Carry the three decisions out**

In `packages/control/src/supervisor.ts`'s `carryOut` switch:

```ts
    case 'assign_capability':
      // The UNION, like `set_runtime_roles` (spec §4): the worker keeps every role it holds and
      // gains the one this capability projects to. A proposal can wait a day, and a role granted
      // meanwhile must not be taken back by an approval.
      return reached(await addRuntimeRoles(action.slaveId, [action.role], origin))
    case 'materialise_company_worker':
      return reached(
        await materialiseCompanySlave(workspaceIdOf(decision), action.companySlaveId, {
          rationale: `Brought onto this project because the board needs ${action.capability}.`,
        }),
      )
    case 'hire_from_catalog':
      return reached(
        await hireFromTemplate(workspaceIdOf(decision), action.templateId, {
          capabilities: [action.capability],
          rationale: action.rationale,
          ...(action.temporary ? { temporary: true } : {}),
        }),
      )
```

`carryOut` does not currently receive the workspace id, so `CarriedDecision` gains `readonly workspaceId: string` (read from the row `applyDecision` already fetched — `select: { workspaceId: true, … }` is already there) and `workspaceIdOf` is `decision.workspaceId`. Both new verbs are `ok()/err()` and neither writes before it can refuse, so nothing here needs to throw.

Add to `packages/control/test/integration/supervisor.test.ts`:

```ts
  it('applies an assign_capability decision as a union of the roles (M47 R4)', async () => {
    // …record a decision whose action is assign_capability on a slave holding ['backend']…
    await applyDecision(decisionId, 'system')
    const row = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(row.runtimeRoles).toEqual(['backend', 'security'])
  })

  it('hires from the catalog only when a human approves, and records why on the worker', async () => {
    const before = await prisma.slave.count({ where: { team: { workspaceId } } })
    // …record a hire_from_catalog decision; assert it is `pending` and nothing was created…
    expect(await prisma.slave.count({ where: { team: { workspaceId } } })).toBe(before)
    await approveDecision(decisionId, {})
    const hired = await prisma.slave.findFirstOrThrow({ where: { hiredFromTemplateId: templateId } })
    expect(hired.selectionRationale).toContain('Application security')
    expect(hired.runtimeRoles).toContain('security')
  })

  it('records a failed decision rather than throwing when the template has since been deleted', async () => {
    // …delete the template, approve, assert status `failed` and a supervisor.failed event…
  })
```

- [ ] **Step 10: Extend the two exhaustive label tables (M44 R5)**

`apps/web/src/components/SupervisorPanel.tsx`'s `actionText` is a total switch over `Action` and does not compile without these three arms — which is the point of writing it that way:

```ts
    case 'assign_capability':
      return `give ${action.slaveId} the "${action.role}" runtime role, for ${action.capability}`
    case 'materialise_company_worker':
      return `bring ${action.name} onto this project from the company roster, for ${action.capability}`
    case 'hire_from_catalog':
      return `hire ${action.name} from the catalog${action.temporary ? ' as a temporary specialist' : ''}, for ${action.capability}`
```

and `apps/web/test/supervisor-panel.test.tsx` gains one render per kind asserting the sentence and that the `supervisor-proposal-kind` chip reads `Missing a capability` with `title="capability_unstaffed"` (the raw value stays available — `docs/ia.md` rule 3).

- [ ] **Step 11: Full task verification**

```bash
npx vitest run packages/domain/test/supervisor packages/control/test/integration/supervisor.test.ts apps/web/test/supervisor-panel.test.tsx
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"   # must be empty; if not, kill it and say so in the report
npm run web:build
```
Expected: all green. No browser gate here — no page moved; `web:build` runs because a client component changed and `tsc` alone does not catch a bundler failure.

- [ ] **Step 12: Commit**

```bash
git add packages/domain/src/supervisor packages/domain/test/supervisor packages/control/src/supervisor.ts packages/control/src/supervisorWorld.ts \
        packages/control/test/integration/supervisor.test.ts apps/web/src/components/SupervisorPanel.tsx apps/web/test/supervisor-panel.test.tsx
git commit -m "$(cat <<'EOF'
feat(domain,control): m47 t3 -- the Supervisor sees a missing capability and offers the three ways to fill it

`capability_unstaffed` is keyed by the capability, so ten tasks blocked on one gap are one question.
"Unstaffed" means nobody holds the role it projects to, not that nobody has it: the whole point of
the first offer is the worker who already provides the capability and was never given its runtime
role, and a predicate reading coverage off the capability alone would call that staffed and never
offer the fix. Supersession is per TASK, which is what stops one hole producing two proposals.

Three offers, in the order the milestone fixes: the existing capable worker, applied routinely
because their own row is the evidence and nobody new arrives; the company roster worker and the
catalog hire, both proposals, because bringing a worker onto a project is a person's decision.

The four existing staffing arms are untouched and `set_runtime_roles` is still the first offer on a
`no_reviewer` situation -- `gate:m38` answers every decision with index 0, and a new offer in front
of that one would change what the gate approves.

The world grows a taxonomy, the company roster and the catalog index, and reads none of them unless
the board actually asks for a capability: a project planned before this milestone costs exactly the
queries it cost before.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 4: The Organization tab — who is here, why, what they can do, and what is missing (R6, E6, E17)

**Files:**
- Create: `apps/web/src/server/organization.ts`, `apps/web/src/app/w/[workspaceId]/organization/page.tsx`, `apps/web/src/app/api/w/[workspaceId]/organization/route.ts`, `apps/web/src/components/organization/OrganizationClient.tsx`, `apps/web/src/components/organization/CapabilityChips.tsx`
- Modify: `apps/web/src/components/project/ProjectTabs.tsx`, `apps/web/src/components/workforce/ProfileDrawer.tsx`, `apps/web/src/app/workforce/page.tsx`, `apps/web/src/server/org.ts`, `scripts/gate-m44-ux-foundation.mjs`, `docs/ia.md`
- Test: `apps/web/test/organization-page.test.tsx`, `apps/web/test/integration/organization.test.ts`, `apps/web/test/project-tabs.test.tsx`, `apps/web/test/workforce-catalog.test.tsx`

**Interfaces:**
- Consumes from Tasks 1–3: `listOrganization`, `listCapabilities`, `loadSupervisorWorld`, `listDecisions`, `DecisionView`; `teamPlanOf`, `capabilityLabel`, `SITUATION_LABEL`; the `capability_unstaffed` situation and the three actions.
- Produces, for Task 5: the route `/w/:id/organization`; testids `organization-rows`, `organization-row-<slaveId>`, `organization-kind-<slaveId>`, `organization-why-<slaveId>`, `organization-doing-<slaveId>`, `capability-chip`, `organization-needs`, `organization-need-<capability>`, `organization-unfillable`, `organization-hint`, `project-tab-organization`.

- [ ] **Step 1: Write the failing integration test for the read model**

`apps/web/test/integration/organization.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildOrganization } from '../../src/server/organization'
import { resetDatabase, seedWorkspace } from './helpers'

describe('buildOrganization', () => {
  beforeEach(resetDatabase)

  it('says who is here, how they got here and what they provide', async () => {
    // A company worker, a hired one and a hand-made one, so all three "why here" sentences render.
    const view = await buildOrganization(workspaceId)
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.workers.map((worker) => [worker.name, worker.kind, worker.why])).toEqual([
      ['Alex', 'company', 'Assigned from M47 Co'],
      ['Rae', 'project', 'Seeded'],
      ['Security Reviewer', 'project', 'Hired for security.application because the board needs it'],
    ])
    expect(view.workers[2]?.capabilities).toEqual([{ key: 'security.application', label: 'Application security' }])
  })

  it('shows what the board needs, the proposals waiting on a person, and what nobody can do', async () => {
    const view = await buildOrganization(workspaceId)
    if (view === null) return
    expect(view.needs.map((need) => need.capability)).toEqual(['security.application'])
    expect(view.needs[0]?.label).toBe('Application security')
    expect(view.needs[0]?.decisions.map((decision) => decision.action.kind)).toEqual(['hire_from_catalog'])
    expect(view.covered.map((one) => one.capability)).toEqual(['backend.api-design'])
    expect(view.unfillable).toEqual(['mobile.ios'])
  })

  it('carries the advisory edges, and never anything that dispatches', async () => {
    const view = await buildOrganization(workspaceId)
    if (view === null) return
    expect(view.hints).toEqual([
      { slaveId: expect.any(String), text: 'Consult the Gate Platform Builder before changing an endpoint.', targetTemplateName: 'Gate Platform Builder', capability: 'backend.api-design' },
    ])
  })

  it('is null for a workspace that is not there', async () => {
    expect(await buildOrganization('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail, then write `apps/web/src/server/organization.ts`**

Run: `npx vitest run apps/web/test/integration/organization.test.ts` → FAIL (module not found).

```ts
import { listCapabilities, listDecisions, listOrganization, loadSupervisorWorld, type DecisionView } from '@slave-of-ai/control'
import { capabilityLabel, teamPlanOf, type CapabilityRecord } from '@slave-of-ai/domain'

/** One worker, as the Organization view reads them (R6): who, how they got here, what they
 *  provide, and what they are doing right now. */
export interface OrganizationRow {
  readonly slaveId: string
  readonly name: string
  readonly roleLabel: string
  /** `company` when the worker came off a company roster, `project` otherwise. The PERMANENT /
   *  PROJECT / TEMPORARY lifecycle is M50's; this is the only distinction the schema can honestly
   *  make today, and it is the same one `ProjectBrief.team[].company` makes. */
  readonly kind: 'company' | 'project'
  readonly capabilities: readonly { readonly key: string; readonly label: string }[]
  /** WHY this worker is on this project, in one sentence -- the milestone's "why selected". The
   *  stored `selectionRationale` when there is one, else the fact the row can support. */
  readonly why: string
  readonly runtimeRoles: readonly string[]
  readonly doing: string | null
}

export interface OrganizationNeed {
  readonly capability: string
  readonly label: string
  readonly summary: string
  readonly readyTasks: number
  /** The `pending` decisions about THIS capability -- rendered as `ProposalRow`s, so a proposal
   *  reads and is answered here exactly as it is on the Overview (M45's rule). */
  readonly decisions: readonly DecisionView[]
}

export interface OrganizationView {
  readonly workers: readonly OrganizationRow[]
  readonly needs: readonly OrganizationNeed[]
  readonly covered: readonly { readonly capability: string; readonly label: string; readonly by: string }[]
  readonly unfillable: readonly { readonly capability: string; readonly label: string }[]
  readonly hints: readonly { readonly slaveId: string; readonly text: string; readonly targetTemplateName: string | null; readonly capability: string | null }[]
  readonly taskTitles: Readonly<Record<string, string>>
}

/**
 * The Organization tab's whole read (R6).
 *
 * The coverage summary comes from `teamPlanOf` -- the SAME function `candidates` builds its offers
 * from -- rather than from a second reading of "what is missing" here: two computations of that
 * question would eventually disagree in front of a person, and the one on the page would be the
 * one nobody could act on.
 */
export async function buildOrganization(workspaceId: string, now: Date = new Date()): Promise<OrganizationView | null> {
  const org = await listOrganization(workspaceId)
  if (!org.ok) return null
  const taxonomy = await listCapabilities()
  const { world } = await loadSupervisorWorld(workspaceId, now)
  const plan = teamPlanOf(world)
  const pending = await listDecisions(workspaceId, { status: 'pending' })
  const taskTitles = Object.fromEntries(world.tasks.map((task) => [task.id, task.title] as const))

  const needs = plan.proposals
    .map((proposal) => proposal.capability)
    .concat(world.tasks.flatMap((task) => task.requiredCapabilities))
    .filter((capability, index, all) => all.indexOf(capability) === index && plan.covered.every((one) => one.capability !== capability))
    .toSorted()
    .map((capability) => {
      const decisions = pending.filter(
        (decision) => decision.situationKind === 'capability_unstaffed' && decision.subjectId === capability,
      )
      return {
        capability,
        label: capabilityLabel(capability, taxonomy),
        summary: decisions[0]?.situation.summary ?? `Nobody on this project can be dispatched for ${capabilityLabel(capability, taxonomy)}.`,
        readyTasks: world.tasks.filter((task) => task.status === 'ready' && task.requiredCapabilities.includes(capability)).length,
        decisions,
      }
    })

  return {
    workers: org.value.workers.map((worker) => ({
      slaveId: worker.slaveId,
      name: worker.name,
      roleLabel: worker.role,
      kind: worker.kind,
      capabilities: worker.capabilities.map((key) => ({ key, label: capabilityLabel(key, taxonomy) })),
      why: whyHere(worker),
      runtimeRoles: worker.runtimeRoles,
      doing: doingNow(worker.slaveId, world, taskTitles),
    })),
    needs,
    covered: plan.covered.map((one) => ({ capability: one.capability, label: capabilityLabel(one.capability, taxonomy), by: one.by })),
    unfillable: plan.unfillable.map((capability) => ({ capability, label: capabilityLabel(capability, taxonomy) })),
    hints: org.value.hints,
    taskTitles,
  }
}

/** The sentence in the "why here" column, in the order of how much it actually says: the
 *  Supervisor's own rationale, then the company it was assigned from, then the honest fallback for
 *  a worker that predates all of this. Never a guess. */
function whyHere(worker: { readonly selectionRationale: string | null; readonly kind: 'company' | 'project'; readonly companyName: string | null }): string {
  if (worker.selectionRationale !== null && worker.selectionRationale !== '') return worker.selectionRationale
  if (worker.kind === 'company' && worker.companyName !== null) return `Assigned from ${worker.companyName}`
  return 'Seeded'
}

/** What the worker is doing NOW: the title of the task its live run holds, or null. Read off the
 *  world the rest of this view came from, so the page cannot show a worker as free on a board that
 *  says otherwise. */
function doingNow(
  slaveId: string,
  world: { readonly slaves: readonly { readonly id: string; readonly busy: boolean }[] },
  taskTitles: Readonly<Record<string, string>>,
): string | null {
  const slave = world.slaves.find((one) => one.id === slaveId)
  if (slave === undefined || !slave.busy) return null
  // `SupervisorSlave` says busy but not WHICH task; the run's task is what the caller's own
  // `listOrganization` row would need a join for, so the honest answer here is the state.
  return 'Working'
}
```

(The `doing` column shows `Working` / `Idle`; the task TITLE belongs to the Tasks tab, and inventing a join for it here would be a second source of truth about what a worker is doing — `taskTitles` is carried for `ProposalRow`, which needs it for a `cancel_task` sentence.)

- [ ] **Step 3: Write the route and the page**

`apps/web/src/app/api/w/[workspaceId]/organization/route.ts` — the refetch endpoint, shaped exactly like the sibling `overview` route (`requirePrincipal`, `force-dynamic`, `Response.json(view)`, 404 when the view is null).

`apps/web/src/app/w/[workspaceId]/organization/page.tsx`:

```tsx
import { buildOrganization } from '../../../../server/organization'
import { OrganizationClient } from '../../../../components/organization/OrganizationClient'

export const dynamic = 'force-dynamic'

export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const view = await buildOrganization(workspaceId)
  if (view === null) {
    return <div className="p-6 text-tone-blocked">no project with id {workspaceId}</div>
  }
  // Keyed, like every other project tab: a client-side move between projects remounts rather than
  // rendering the old project's rows under the new URL.
  return <OrganizationClient key={workspaceId} workspaceId={workspaceId} initial={view} />
}
```

- [ ] **Step 4: Write the failing component test**

`apps/web/test/organization-page.test.tsx` (first line `// @vitest-environment jsdom`), rendering `OrganizationClient` with a literal `OrganizationView`:

```tsx
  it('renders one row per worker with kind, capabilities, why and what they are doing', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    expect(screen.getAllByTestId('organization-row').length).toBe(3)
    expect(screen.getByTestId('organization-kind-s3').textContent).toBe('project')
    expect(screen.getByTestId('organization-why-s3').textContent).toBe('Hired for security.application because the board needs it')
    expect(screen.getByTestId('organization-doing-s1').textContent).toBe('Working')
  })

  // `docs/ia.md` rule 3: a surface may print a label, and the raw value stays reachable.
  it('shows capabilities as labels, with the key in the title attribute', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    const chip = screen.getAllByTestId('capability-chip')[0]
    expect(chip?.textContent).toBe('Application security')
    expect(chip?.getAttribute('title')).toBe('security.application')
  })

  it('lists what the board needs, with the pending proposal answerable in place', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    expect(screen.getByTestId('organization-need-security.application').textContent).toContain('Application security')
    expect(screen.getByTestId('supervisor-proposal')).toBeTruthy()
    expect(screen.getByTestId('supervisor-approve')).toBeTruthy()
  })

  it('says plainly when nobody anywhere can do something', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    expect(screen.getByTestId('organization-unfillable').textContent).toContain('iOS')
  })

  it('shows a collaboration hint as advice, and says it is advice', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    const hint = screen.getByTestId('organization-hint')
    expect(hint.textContent).toContain('Consult the Gate Platform Builder')
    expect(hint.textContent).toContain('advice')
  })

  it('renders an empty project without pretending anything is wrong', () => {
    render(<OrganizationClient workspaceId="w1" initial={{ workers: [], needs: [], covered: [], unfillable: [], hints: [], taskTitles: {} }} />)
    expect(screen.getByTestId('empty-state')).toBeTruthy()
  })
```

- [ ] **Step 5: Run it and watch it fail, then write the two components**

Run: `npx vitest run apps/web/test/organization-page.test.tsx` → FAIL (module not found).

`apps/web/src/components/organization/CapabilityChips.tsx`:

```tsx
/**
 * A worker's capabilities, as LABELS with their keys in `title` (`docs/ia.md` rule 3: a surface
 * prints words, and the raw value stays reachable). Shared by the Organization rows and by M46's
 * profile drawer, so one capability reads the same in both places.
 */
export function CapabilityChips({
  capabilities,
  max = 4,
}: {
  readonly capabilities: readonly { readonly key: string; readonly label: string }[]
  readonly max?: number
}): React.JSX.Element {
  if (capabilities.length === 0) {
    return <span className="text-[11px] text-text-3">no capabilities recorded</span>
  }
  const shown = capabilities.slice(0, max)
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((capability) => (
        <span
          key={capability.key}
          data-testid="capability-chip"
          title={capability.key}
          className="rounded-chip border border-line px-2 py-[2px] text-[11px] text-text-2"
        >
          {capability.label}
        </span>
      ))}
      {capabilities.length > shown.length && (
        <span className="text-[11px] text-text-3">+{capabilities.length - shown.length}</span>
      )}
    </span>
  )
}
```

`apps/web/src/components/organization/OrganizationClient.tsx` — a `'use client'` component built on M44's primitives (`DataTable`/`Row` for the workers, `EmptyState` for a project with nobody on it, `Alert` for the unfillable line) with three parts:

1. **Workers.** One `data-testid="organization-row"` per worker: name · `kind` chip (`organization-kind-<id>`) · `CapabilityChips` · why (`organization-why-<id>`) · doing (`organization-doing-<id>`, `Working` or `Idle`).
2. **Needs.** One block per `OrganizationNeed` (`organization-need-<capability>`) carrying the label, the summary, the ready-task count, and each pending decision rendered with the imported `ProposalRow` — approve and reject POST to the existing `/api/w/:id/supervisor/decisions/:id/approve|reject` routes and then refetch `/api/w/:id/organization`. Below them, the covered summary and, when `unfillable` is non-empty, one `Alert` (`organization-unfillable`) naming each label: "nobody on this project, on the company roster or in the catalog provides …".
3. **Advice.** One list (`organization-hint` per row) of the collaboration edges: the worker's name, the sentence verbatim as JSX children (another party's text is data — never `dangerouslySetInnerHTML`), and the fixed caption "advice from this worker's profile — it never decides who does the work".

- [ ] **Step 6: Add the fifth tab (E6)**

In `apps/web/src/components/project/ProjectTabs.tsx`, `TABS` gains one entry between `tasks` and `activity`, and the doc comment's "four tabs" becomes "five tabs (M47 R6 added Organization)":

```ts
  { id: 'organization', label: 'Organization', path: (id: string) => `/w/${id}/organization`, exact: false },
```

`apps/web/test/project-tabs.test.tsx`'s `TAB_HREFS` and its first assertion take the new entry (`['Overview', 'Tasks', 'Organization', 'Activity', 'Settings']`), and `scripts/gate-m44-ux-foundation.mjs` stage 2's expected array takes it too, with a one-line comment naming M47 so the next reader knows why a stage of M44's gate mentions a later milestone.

- [ ] **Step 7: Resolve the catalog drawer's capability chips (§2)**

`apps/web/src/server/org.ts` re-exports `listCapabilities()` as `listCapabilityTaxonomy()` (the web's own naming for a control read, the `listWorkforceCatalogPage` idiom), `apps/web/src/app/workforce/page.tsx` loads it once beside the catalog, and `ProfileDrawer`'s Capabilities group renders `CapabilityChips` for the row's `capabilityKeys` above the free-text `capabilities` list, with the unresolved ones under a plain caption: "not in the taxonomy — `capabilities add` to make them matchable". `apps/web/test/workforce-catalog.test.tsx` gains one assertion for the resolved chip and one for the caption.

- [ ] **Step 8: Update `docs/ia.md` (E17)**

In the project-surfaces table, a new row after Tasks:

```
| `/w/:id/organization` Organization | Who works on this, why they were chosen, and what is missing | **new** (tab 3) | — | M47: one row per worker — kind, the capabilities they provide, why they are here and what they are doing — plus a Needs section whose proposals are answered in place, and the advisory edges a persona's profile carries |
```

and the two rows that credit M46 with lifting the org graph are corrected to name M47 (`/w/:id` Overview's "Later" column and `/w/:id/graph`'s), because M46's scope was the catalog and it did not.

- [ ] **Step 9: Full task verification**

```bash
npx vitest run apps/web/test/organization-page.test.tsx apps/web/test/project-tabs.test.tsx apps/web/test/project-layout.test.tsx apps/web/test/workforce-catalog.test.tsx
npx vitest run apps/web/test/integration/organization.test.ts
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"   # must be empty; if one is up, kill it and SAY SO in the task report
npm run web:build
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m44-ux-foundation
echo "exit ${PIPESTATUS[0]}"
```
Expected: all green, including m44's stage 2 with its five tabs. The fidelity screenshots now differ (E7) — they are regenerated in Task 5, in their own commit, NOT here.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/server/organization.ts apps/web/src/server/org.ts apps/web/src/app/w apps/web/src/app/api/w apps/web/src/app/workforce \
        apps/web/src/components/organization apps/web/src/components/project/ProjectTabs.tsx apps/web/src/components/workforce/ProfileDrawer.tsx \
        apps/web/test scripts/gate-m44-ux-foundation.mjs docs/ia.md
git commit -m "$(cat <<'EOF'
feat(web): m47 t4 -- an Organization tab that answers who is here, why, and what is missing

One row per worker: what they provide as labels with the key still in `title`, whether they came
off a company roster or were hired for this project, the sentence that says why they were chosen,
and what they are doing now. The "why" is the Supervisor's own rationale when there is one and the
fact the row can support when there is not -- never a guess.

The Needs section is the same coverage `candidates` builds its offers from, through the same
`teamPlanOf`, because two computations of "what is missing" would eventually disagree in front of a
person and the one on the page would be the one nobody could act on. Its proposals are the M45
`ProposalRow`, approved and rejected in place through the routes that already exist.

Collaboration edges are shown as advice and captioned as advice. Nothing on this page dispatches
anybody.

The tab strip is five wide now, and both places that pinned it to four -- the component test and
`gate:m44-ux-foundation` stage 2 -- move with it. `docs/ia.md` gains the route and stops crediting
M46 with a tab M46 never built.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 5: The fixture catalog, the fake CLI's plan fixture, `gate:m47-team-formation`, the README, CI — and the full verification ladder (R7, E5, E7)

**Files:**
- Create: `packages/providers/test/fixtures/plan-graph-capabilities.ndjson`, `scripts/fixtures/catalog-m47/divisions.json`, `scripts/fixtures/catalog-m47/LICENSE`, `scripts/fixtures/catalog-m47/engineering/gate-platform-builder.md`, `scripts/fixtures/catalog-m47/security/gate-security-reviewer.md`, `scripts/gate-m47-team-formation.mjs`
- Modify: `packages/providers/test/fake-claude.mjs`, `packages/providers/test/fake-claude.test.ts`, `scripts/gate-m14-fidelity.mjs`, `package.json`, `.github/workflows/ci.yml`, `README.md`
- Regenerate (own commit): `docs/superpowers/fidelity/m14/*.png`

**Interfaces:**
- Consumes from Tasks 1–4: the CLI verbs `capabilities sync|list`, `set-capabilities`, `hire`, `import-catalog`, `set-runtime-roles`, `set-goal`, `approve-decision`, `supervisor-decisions`; every column; every `data-testid` Task 4 produced.
- Produces: the npm script `gate:m47-team-formation`; the fake-CLI flag `--plan-fixture <name>`.

- [ ] **Step 1: Teach the fake CLI which plan to replay (D7)**

`packages/providers/test/fake-claude.mjs` — one helper beside `answerFixtureName()` and one line in `m8-flow`'s planning arm. `m41-flow` is deliberately untouched: its planning arm replays `plan-graph-scenario` because that story needs a specific description, and a flag there would be a second knob nobody uses.

```js
/**
 * M47: which plan a `"task graph"` prompt is answered with -- `--plan-fixture <name>` from ARGV,
 * defaulting to the stock `plan-graph`. Argv rather than an env var for `--answer-fixture`'s own
 * reason: `SLAVEOFAI_CLAUDE_ARGS` rides through as `extraArgs` on every spawn, and it is the one
 * per-daemon channel a gate can count on.
 *
 * A MODE was the alternative and would have been worse: every arm of `m8-flow` -- the two decision
 * arms, the re-plan arm, review, work -- is exactly what an M47 gate needs, and a copy of them
 * beside a different planning fixture is five arms that can drift from the five they were copied
 * from.
 */
function planFixtureName() {
  const index = args.indexOf('--plan-fixture')
  const named = index === -1 ? undefined : args[index + 1]
  return named === undefined || named.startsWith('-') ? 'plan-graph' : named
}
```

```js
    if (prompt.includes('"task graph"')) {
      await replayFixture(planFixtureName())
      return
    }
```

and the header comment's `m8-flow` paragraph gains a sentence naming the flag. `packages/providers/test/fake-claude.test.ts` gains two cases: a planning prompt with no flag replays the stock plan (an existing assertion, restated), and one spawned with `--plan-fixture plan-graph-capabilities` replays a graph whose first task carries `"capabilities"`.

- [ ] **Step 2: Write `packages/providers/test/fixtures/plan-graph-capabilities.ndjson`**

Copy `plan-graph.ndjson` line for line — the same eleven lines, the same `system:init`, the same tool-use and hook lines, the same terminal `result` — and replace the plan object in the last assistant text block and in the `result` line's `result` field with:

```json
{"tasks":[
 {"key":"core","title":"Write the feature core","description":"Implement the core module the goal asks for.","capabilities":["backend.api-design"],"dependsOn":[]},
 {"key":"auth","title":"Add authentication to the endpoint","description":"The endpoint needs a real authentication path, reviewed for application security.","capabilities":["security.application"],"dependsOn":[]},
 {"key":"polish","title":"Document and polish","description":"README and cleanup on top of the API.","role":"backend","capabilities":["nope.nothing"],"dependsOn":["core"]}
]}
```

(written as ONE line in the fixture, like the file it is copied from). Three tasks, three different things measured: `core` derives `backend` from a capability and is dispatchable by the worker already there; `auth` derives `security`, which nobody holds, and is the gap the whole milestone is about; `polish` names a role AND a key the taxonomy does not have, so the role stands and the key is dropped and reported. Neither `auth` nor `core` depends on anything, so both are startable the moment the plan lands.

- [ ] **Step 3: Write the fixture catalog (E5)**

`scripts/fixtures/catalog-m47/divisions.json`:

```json
{
  "_note": "M47's own catalog. Two divisions, two personas whose capability bullets are taxonomy labels and whose collaboration line names the other one by title. Separate from catalog-m46, whose four-persona counts that gate asserts exactly, and from catalog-m42, whose skip reasons gate:m42 asserts exactly.",
  "divisions": {
    "engineering": { "label": "Engineering" },
    "security": { "label": "Security" }
  }
}
```

`scripts/fixtures/catalog-m47/LICENSE` — the same real MIT header shape M46's fixture uses (first line `MIT License`), so `sourceLicense` is `MIT`.

`scripts/fixtures/catalog-m47/security/gate-security-reviewer.md` — the persona the gate hires. Its `Core Capabilities` bullets are taxonomy LABELS, because matching is exact (E12), and its collaboration line names the other persona by its exact title:

```markdown
---
name: Gate Security Reviewer
description: Reviews authentication and authorization paths before they ship.
---

# Gate Security Reviewer

You are the reviewer who reads an authentication path the way somebody trying to get past it would.

## Identity & Memory

- **Role**: Application security reviewer for authentication and authorization work
- **Experience**: You have read a great many login paths and found the same handful of holes in them

## Core Mission

### Read the authentication path end to end
- Follow the request from the edge to the check that actually decides

## Core Capabilities

- Application security
- Authentication and authorization
- A calm read of somebody else's login flow

## Critical Rules You Must Follow

- You MUST show the exact line, the exact hole and the exact fix

## Integration with other slaves

| Who | How |
| --- | --- |
| Gate Platform Builder | Consult the Gate Platform Builder before changing an endpoint. |

## Success Metrics

- Every finding names a line and a fix
```

`scripts/fixtures/catalog-m47/engineering/gate-platform-builder.md` — the same nine-heading shape, with `Core Capabilities` of `API design` and `Service implementation`, and no collaboration section (so exactly ONE hint exists in this catalog and the gate can count it). Both are written in this project's vocabulary, so `gate:m26-vocabulary` stays green, and neither name appears in `catalog-m42` or `catalog-m46` (E5).

Three of the four capability bullets across the two personas are taxonomy labels and one — "A calm read of somebody else's login flow" — is not, on purpose: `unresolvedCapabilities` is asserted in stage 1, and a fixture where everything resolved could not measure it.

- [ ] **Step 4: Write `scripts/gate-m47-team-formation.mjs`**

Borrow verbatim from `scripts/gate-m46-workforce-catalog.mjs` (which borrowed them from m42/m45): `preflightCleanup`, `dumpGateRows`, `fail`, `waitUntil`, `waitVisible`, `clickUntil`, `gotoReliably`, the temp git repo copy of the fixture catalog, the free port + real `next dev` under `loopbackChildEnv()`, the ready-wait on next's own bound-port line, the child killed in `finally`, the `findRealDaemonPids()` refusal, the browser preflight refusal (`SLAVEOFAI_CLAUDE_BIN` must name a file under `scripts/gate-fakes/`), `exitCode` starting at 1 and set to 0 only at the very end, and teardown in FK order inside a `finally`. Dist imports only (`../packages/domain/dist/index.js`, `../packages/db/dist/client.js`, `../packages/control/dist/index.js`).

Header:

```js
// M47's own gate (spec R7): the Supervisor chooses a worker by CAPABILITY, and the scheduler still
// dispatches by ROLE. One matching rule, proved end to end against a real daemon and the fake CLI.
//
// Seven stages, each measuring one rule the milestone claims:
//   1. The taxonomy is data: `capabilities sync` through the real CLI fills the table, a second
//      run changes nothing, and `capabilities add` puts an operator's own key in it.
//   2. The checked-in fixture catalog is imported through the real CLI. Each persona's capability
//      bullets resolve to KEYS, the bullet that matches nothing is kept verbatim and matches
//      nothing, and the collaboration line becomes ONE advisory edge pointing at the persona it
//      names, carrying the capability the sentence is about.
//   3. A workspace with ONE worker (`backend.api-design`, dispatchable as backend and manager) and
//      a goal. The planning run is answered from `plan-graph-capabilities`: the tasks come back
//      with `requiredCapabilities`, with a `requiredRole` DERIVED from them where the plan named
//      none, with the planner's own role where it did, and the unknown key is dropped and named on
//      `workspace.plan_created.droppedCapabilities`.
//   4. The Supervisor raises `capability_unstaffed(security.application)` -- nobody can be
//      dispatched as `security` -- and PROPOSES `hire_from_catalog`, pending, with the rationale
//      sentence naming the capability. Nothing is hired while it waits.
//   5. A human approves it with the operator's own `approve-decision` as a real subprocess: a
//      project slave exists with `capabilities`, `runtimeRoles` including `security`,
//      `hiredFromTemplateId` and `selectionRationale` -- and the very next tick DISPATCHES the
//      authentication task to it by ROLE. That dispatch is the whole claim: the Supervisor reasoned
//      in capabilities and the scheduler matched a string, exactly as it always has.
//   6. A capability an existing idle worker already provides is assigned ROUTINELY: the worker is
//      given the capability and then stripped of the role it projects to, a task that needs it is
//      put on the board, and the Supervisor writes an `applied` row that grants the role back --
//      without asking anybody, because the worker's own row is the evidence.
//   7. In a real browser: the Organization tab lists the workers with the capabilities they
//      provide and the sentence that says why each is here, the Needs section shows what is
//      missing, and the resolved collaboration edge is shown as advice.
//   8. Teardown, in FK order, on every exit path.
//
// NEVER A MODEL CALL. The daemon is spawned with SLAVEOFAI_CLAUDE_BIN=node,
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8-flow --plan-fixture plan-graph-capabilities"
// and SLAVEOFAI_REQUIRE_FAKE_CLI=1; the browser half needs SLAVEOFAI_CLAUDE_BIN to name an
// executable under scripts/gate-fakes/ or the preflight refuses to start at all.
//
// THE FIXTURE CATALOG IS COPIED TO A TEMP DIRECTORY AND `git init`ed THERE, like m46's: this gate
// must never modify a file in this repository, and `git status` after a green run has to be empty.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots its own `next dev`
// against `apps/web/.next` on a free port, and two of those corrupt the build cache for both.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m47-team-formation
```

Fixed names, exactly as its siblings declare theirs (`preflightCleanup` removes whatever a crashed run left on these, in FK order — the workspace and its events, then the two templates by `sourceId`, then the operator capability key):

```js
const CATALOG_NAME = 'catalog-m47'
const BUILDER = 'Gate Platform Builder'
const REVIEWER = 'Gate Security Reviewer'
const WORKSPACE_NAME = 'M47 Gate Project'
const WORKER_NAME = 'Dev'
const OPERATOR_KEY = 'legal.contracts'
const AUTH_TASK_TITLE = 'Add authentication to the endpoint'
const QA_TASK_TITLE = 'M47 Gate Automated Test Sweep'
```

The load-bearing assertions, in the stages above:

```js
  // Stage 2
  const reviewer = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: REVIEWER } })
  assertEqual(reviewer.capabilityKeys, ['security.application', 'security.authentication'], 'stage 2: the reviewer resolves two keys')
  assertEqual(reviewer.unresolvedCapabilities, ["A calm read of somebody else's login flow"], 'stage 2: what matched nothing is kept verbatim')
  const hints = await prisma.collaborationHint.findMany({ include: { targetTemplate: true } })
  if (hints.length !== 1) await fail(`stage 2: expected one advisory edge, got ${String(hints.length)}`)
  if (hints[0].targetTemplate?.name !== BUILDER) await fail('stage 2: the hint does not point at the persona it names')
  if (hints[0].capability !== 'backend.api-design') await fail('stage 2: the hint did not resolve the capability its sentence is about')

  // Stage 3
  const auth = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: AUTH_TASK_TITLE } })
  assertEqual(auth.requiredCapabilities, ['security.application'], 'stage 3: the task carries what it needs')
  if (auth.requiredRole !== 'security') await fail(`stage 3: the derived role is ${String(auth.requiredRole)}, expected security`)
  const polish = await prisma.task.findFirstOrThrow({ where: { workspaceId, title: 'Document and polish' } })
  if (polish.requiredRole !== 'backend') await fail('stage 3: the planner named a role and it did not win')
  assertEqual(polish.requiredCapabilities, [], 'stage 3: the unknown key was dropped')
  const planEvent = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId, type: 'workspace_plan_created' } })
  assertEqual(planEvent.payload.droppedCapabilities, ['nope.nothing'], 'stage 3: the dropped key is on the record')

  // Stage 4
  const decision = await waitUntil(
    async () => prisma.supervisorDecision.findFirst({ where: { workspaceId, situationKind: 'capability_unstaffed' } }),
    'the Supervisor to notice a capability nobody can be dispatched for',
  )
  if (decision.subjectId !== 'security.application') await fail(`stage 4: the situation is about ${decision.subjectId}`)
  if (decision.status !== 'pending' || decision.tier !== 'proposed') await fail(`stage 4: a hire must WAIT: ${describeDecision(decision)}`)
  if (decision.action.kind !== 'hire_from_catalog') await fail(`stage 4: the offer is ${decision.action.kind}`)
  if (!decision.action.rationale.includes('Application security')) await fail('stage 4: the rationale does not say what is missing')
  if ((await prisma.slave.count({ where: { team: { workspaceId } } })) !== 1) await fail('stage 4: somebody was hired while the proposal was still pending')

  // Stage 5
  execFileSync('node', [ORCHESTRATOR_CLI, 'approve-decision', '--id', decision.id], { env: loopbackChildEnv(), encoding: 'utf8' })
  const hired = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId }, hiredFromTemplateId: reviewer.id } })
  if (!hired.runtimeRoles.includes('security')) await fail(`stage 5: the hire is not dispatchable as security: ${JSON.stringify(hired.runtimeRoles)}`)
  if (!hired.capabilities.includes('security.application')) await fail('stage 5: the hire does not provide what it was hired for')
  if (hired.selectionRationale === null) await fail('stage 5: nothing says why this worker is here')
  // THE claim: the scheduler matched a ROLE, and a real run started.
  const run = await waitUntil(
    async () => prisma.slaveRun.findFirst({ where: { slaveId: hired.id, task: { title: AUTH_TASK_TITLE } } }),
    'the authentication task to be dispatched to the hired specialist BY ROLE',
  )
  console.log(`stage 5: run ${run.id} started for ${AUTH_TASK_TITLE} on ${hired.name}`)

  // Stage 6
  execFileSync('node', [ORCHESTRATOR_CLI, 'set-capabilities', '--slave', devId, '--capabilities', 'backend.api-design,qa.test-automation'], { env: loopbackChildEnv(), encoding: 'utf8' })
  // Stripped back to what it had: `set-capabilities` unions the projected role in, and this stage
  // is about the worker who PROVIDES a capability and does not hold its role.
  execFileSync('node', [ORCHESTRATOR_CLI, 'set-runtime-roles', '--slave', devId, '--roles', 'backend,manager'], { env: loopbackChildEnv(), encoding: 'utf8' })
  await prisma.task.create({ data: { workspaceId, title: QA_TASK_TITLE, description: 'Sweep the endpoint with the automated suite.', status: 'ready', maxAttempts: 3, requiredRole: 'qa', requiredCapabilities: ['qa.test-automation'] } })
  const assigned = await waitUntil(
    async () => prisma.supervisorDecision.findFirst({ where: { workspaceId, situationKind: 'capability_unstaffed', subjectId: 'qa.test-automation' } }),
    'the Supervisor to see a capability its own worker already provides',
  )
  if (assigned.tier !== 'applied' || assigned.status !== 'applied') await fail(`stage 6: this one is routine and must not wait: ${describeDecision(assigned)}`)
  const dev = await prisma.slave.findUniqueOrThrow({ where: { id: devId } })
  if (!dev.runtimeRoles.includes('qa')) await fail('stage 6: the role the capability projects to was not granted')
  if (!dev.runtimeRoles.includes('backend')) await fail('stage 6: a union took a role away')
```

Stage 7, in the browser, on `/w/<id>/organization`:

```js
  await gotoReliably(`${baseUrl}/w/${workspaceId}/organization`)
  await waitVisible(page.getByTestId(`organization-row-${hired.id}`), "the hired specialist's row")
  const why = await page.getByTestId(`organization-why-${hired.id}`).textContent()
  console.log(`stage 7: why ${hired.name} is here = ${JSON.stringify(why)}`)
  if (!String(why).includes('Application security')) await fail('stage 7: the row does not say why this worker was chosen')
  const chips = await page.getByTestId(`organization-row-${hired.id}`).getByTestId('capability-chip').allTextContents()
  if (!chips.includes('Application security')) await fail(`stage 7: the row shows ${JSON.stringify(chips)}`)
  await waitVisible(page.getByTestId('organization-hint'), 'the advisory edge from the persona')
  const hint = await page.getByTestId('organization-hint').first().textContent()
  if (!String(hint).includes(BUILDER)) await fail('stage 7: the resolved hint does not name the persona it points at')
```

- [ ] **Step 5: Add the npm script**

In `package.json`, after the `gate:m46-workforce-catalog` line (the comma moves onto it):

```json
    "gate:m46-workforce-catalog": "tsc --build && node --env-file=.env scripts/gate-m46-workforce-catalog.mjs",
    "gate:m47-team-formation": "tsc --build && node --env-file=.env scripts/gate-m47-team-formation.mjs"
```

- [ ] **Step 6: Add it to CI**

In `.github/workflows/ci.yml`, immediately after `- run: npm run gate:m46-workforce-catalog`:

```yaml
      - run: npm run gate:m47-team-formation
```

The `gates` job already installs Chromium, exports `CHROMIUM_PATH`, and sets `SLAVEOFAI_CLAUDE_BIN` and `SLAVEOFAI_REQUIRE_FAKE_CLI` job-wide, so the preflight is satisfied with no new step; it also already has `git`, which stage 2's temp repo needs.

- [ ] **Step 7: Run the new gate until it is green**

```bash
pgrep -af "next dev"     # must be empty
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m47-team-formation
echo "exit ${PIPESTATUS[0]}"
git status --short
```
Expected: `PASS:` and exit 0, and a **clean** `git status`. Paste the whole output into the task report: stage 3's derived roles, stage 4's pending decision and stage 5's dispatched run are this milestone's evidence.

- [ ] **Step 8: README — `## Capabilities`**

Add a section immediately after `## Specialist profiles`:

````markdown
## Capabilities

A worker is chosen for what it can DO, not for what it is called. Capabilities are a dotted
vocabulary in a table — `backend.api-design`, `security.application`, `qa.test-automation` — and
every one of them names the runtime role it projects to.

```bash
npm run orchestrator -- capabilities list
npm run orchestrator -- capabilities add --key legal.contracts --label "Contract review" --role legal
npm run orchestrator -- set-capabilities --slave <id> --capabilities backend.api-design,security.application
```

A plan says what each task NEEDS; the scheduler still dispatches on one string, because a
capability projects to a runtime role and a worker who provides the capability is given that role.
There is exactly one matching rule in this system and this milestone did not add a second.

When the board needs something nobody can be dispatched for, the Supervisor says so by capability
and offers the smallest fix it can find, in this order: somebody already here who can do it and was
never given the role, somebody on the company roster, and only then a new worker from the catalog —
one worker who covers two gaps rather than two who cover one each. The first is applied routinely,
because the worker's own record is the evidence. The other two are proposals a person answers, and
the sentence that convinced the Supervisor is stored on the worker it hired: Workforce → the
project's Organization tab shows who is here, what they provide, and why each of them was chosen.

Persona collaboration lines ("consult the Gate Platform Builder before changing an endpoint")
become advisory relationships — shown on the profile and on the Organization tab, used to break a
tie between two equally capable candidates, and never, under any circumstance, allowed to decide
who does the work.
````

and add the `Organization` tab to the `## The web UI` table's project row.

- [ ] **Step 9: README — the "Tests and CI" roster (21 → 22)**

Extend the gate list with `gate:m47-team-formation` beside `gate:m46-workforce-catalog`, and replace the sentence ending `That is 21 gates.` with the m46 sentence followed by:

```
and `m47` proves a worker can be chosen by capability without the scheduler learning a second way
to match: a fixture catalog's persona bullets become taxonomy keys and its collaboration line
becomes one advisory edge pointing at the persona it names; a plan written in capabilities produces
tasks whose dispatch role is DERIVED from them, with an invented key dropped and named on the plan
event; the Supervisor raises the gap by capability and proposes a hire that waits for a person;
approving it puts a specialist on the project with the sentence that chose it, and the very next
tick dispatches the authentication task to that specialist by ROLE; a capability an idle worker
already provides is granted routinely instead, without asking anybody; and the Organization tab
shows who is here, what they can do and why. That is 22 gates. Tests and gates share one Postgres --
run one at a time.
```

- [ ] **Step 10: Full verification ladder**

Run these **in this order**, one at a time, with no `next dev` running anywhere and no other vitest process alive (the shared test database truncates, and a running daemon breaks `subscribe.test.ts`):

```bash
npm run --silent typecheck
npm run gate:m26-vocabulary
npx vitest run
npm run web:build
npm run gate:m47-team-formation
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

with `CHROMIUM_PATH` and `SLAVEOFAI_CLAUDE_BIN` exported for the six browser gates (m47, m46, m45, m44, m14, m16). Expected: every one green.

Five of these are on this ladder for a reason, and a failure in them is a real regression:

- **`gate:m38-supervisor`** — Task 3 added a situation kind and three actions to the catalogue the Supervisor chooses from. m38 answers every decision with `candidateIndex: 0` and asserts that a `no_reviewer` situation's one offer is `set_runtime_roles` on `Dev`. If it fails, a new offer got in front of an old one (plan erratum E9) and what that gate approves has changed.
- **`gate:m41-scenario`** — five workers, role-addressed questions, review staffing and a re-plan in one lineage. It is what proves the role vocabulary still behaves after a milestone that made roles derivable.
- **`gate:m40-requirement-versioning`** — the re-plan path now writes capabilities and a derived role too. m40 pins the delta, its cancellations and its `"replan"` fixture routing.
- **`gate:m42-catalog-import`** — Task 2 added two writes and a second pass to the importer. m42 pins what it DECIDES: two created, three skipped with the three reasons, an unchanged re-run that moves nothing.
- **`gate:m11-shell`** — the Workforce Catalog's `template-form` testids, which Task 4 touched the drawer beside.

Known flakes, and what to do about them rather than around them: `apps/orchestrator/test/integration/cli.test.ts`'s llm-decision row-count case doubles when anything else touches the database — re-run that file alone before believing a failure. `web:build` must never run while `next dev` is up; if the dev server was running, stop it (`kill <pid>`), say so in the report, `rm -rf apps/web/.next`, and restart it afterwards. The six browser gates each boot their own `next dev` against `apps/web/.next` — run them one at a time, never beside each other and never beside a dev server.

- [ ] **Step 11: Regenerate the fidelity screenshots, ALONE, in their own commit (E7)**

The project tab strip is five wide now, and it is on every project page m14 photographs. Check what actually moved before committing anything:

```bash
git status --short docs/superpowers/fidelity/m14
```
Expected, after the ladder's `gate:m14-fidelity` run: `overview.png`, `tasks.png`, `activity.png`, `graph.png`, `office.png` and `project-settings.png` differ (`office.png` differs on every run regardless — its canvas animates), and `organization.png` is new. **If a GLOBAL page differs — `workforce.png`, `projects.png`, `skills.png`, `analytics.png`, `settings.png` — stop and read it**: no M47 change touches a page outside `/w/:id`, and one that moved is a bug, not a screenshot to accept.

```bash
git add docs/superpowers/fidelity/m14 scripts/gate-m14-fidelity.mjs
git commit -m "$(cat <<'EOF'
chore(fidelity): m47 -- regenerate the m14 screenshots for the five-tab project strip

The project strip gained an Organization tab, and it is on every project page this gate
photographs, so six committed PNGs move and a seventh arrives. Nothing outside `/w/:id` differs,
which is the check that says the change is the one that was intended.

Alone, in its own commit, so a review of the milestone is a review of code and a review of the
screenshots is a review of pixels.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

(`scripts/gate-m14-fidelity.mjs` gains `{ name: 'organization', path: () => \`/w/${workspaceId}/organization\`, testId: 'organization-rows' }` to `PAGES` — and NOT to `LIVE_PAGES`: the tab's rows do not change when a run goes live, and a second capture would be a diff that says nothing.)

- [ ] **Step 12: Prove the tree is clean, then commit the milestone's last change**

```bash
git status --short
```
Expected: only the files this task changed, and nothing from any gate's run.

```bash
git add packages/providers/test/fake-claude.mjs packages/providers/test/fake-claude.test.ts packages/providers/test/fixtures/plan-graph-capabilities.ndjson \
        scripts/fixtures/catalog-m47 scripts/gate-m47-team-formation.mjs package.json .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
test(gates),docs: m47 t5 -- gate:m47-team-formation, and the README's Capabilities

Seven stages over a real daemon and the fake CLI. A fixture catalog of two personas, copied into a
temp git repository so nothing in this repository is touched: their capability bullets become
taxonomy keys, the bullet that is nobody's capability is kept in the persona's own words, and the
collaboration line becomes one advisory edge pointing at the persona it names.

Stage 3 is the vocabulary claim: a plan written in capabilities produces tasks whose dispatch role
is DERIVED, a task that named a role keeps it, and a key nobody defined is dropped and named on the
plan event rather than silently ignored.

Stages 4 and 5 are the milestone: the Supervisor names the gap by capability, proposes a hire and
does not make it; a person approves; a specialist arrives carrying what it provides, the role that
capability projects to, the template it came from and the sentence that chose it -- and the very
next tick dispatches the authentication task to it BY ROLE. That last line is the whole design.
The Supervisor reasoned about capabilities and the scheduler matched a string, exactly as it has
since M37.

Stage 6 is the cheap fix nobody should be asked about: a worker who already provides a capability
and lost the role it projects to gets it back in an `applied` row, and the union does not take
anything else away.

It spends nothing and cannot: the daemon runs the fake CLI under `m8-flow`, answered from a new
`--plan-fixture`, and the preflight refuses to start unless SLAVEOFAI_CLAUDE_BIN names a fake under
scripts/gate-fakes. Every row it writes is deleted in a finally, in FK order.

That is 22 gates.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

## Self-review

**1. Spec coverage.**

| Spec | Where it lands |
|---|---|
| R1 taxonomy as data (`Capability`, seed list, `syncCapabilityTaxonomy`, CLI) | Task 1 Steps 13–14, Task 2 Steps 4, 11 |
| R2 one matching rule, capabilities project to roles | Task 1 Steps 3, 14 (`projectRoles`, the columns); Task 2 Steps 7–8 (materialisation, derivation); `decide()` untouched, its tests on every task's ladder |
| R3 planning emits capabilities, instructions list keys, conclude writes/derives/drops | Task 1 Steps 9–12 (schema, section kind, events), Task 2 Steps 8–9 |
| R4 `formTeam`, `capability_unstaffed`, three actions, world, `applyDecision` | Task 1 Steps 7–8; Task 3 Steps 4–9 |
| R5 collaboration hints as advisory edges | Task 1 Steps 5–6; Task 2 Step 6; Task 3 (the `recommended` tie-break); Task 4 Step 5 part 3 |
| R6 Organization tab, `buildOrganization`, chips, `docs/ia.md` | Task 4 |
| R7 gate, README, CI | Task 5 |
| §2 surfaces (every verb and column named there) | Task 2's Interfaces block enumerates them; `listOrganization` is Task 2 Step 4, consumed in Task 4 |
| §3 out of scope | Nothing here writes a lifecycle column, a runbook, a permission or a ranking; `temporary` is a flag on a proposal and a clause in a rationale, exactly as R4 says |

**2. Placeholder scan.** No "TBD", no "similar to Task N", no "add error handling". The three places that describe rather than spell out code — Task 4's `OrganizationClient` body, Task 5's fixture personas' second file and the borrowed gate scaffolding — each name the exact file to copy the shape from, the exact testids to produce and the exact assertions that will be made against them.

**3. Type consistency.** `formTeam`/`TeamPlan`/`TeamProposal` are spelt once (Task 1) and consumed under those names in Tasks 3 and 4. `normaliseCapabilities` (fuzzy-free, label-aware) is the IMPORT-side function; `normaliseCapabilitiesStrict` (keys only) is the PLAN-side one, and Task 2 names the difference where it defines the second. `capabilityLabel`, `projectRoles`, `teamPlanOf`, `listCapabilities`, `hireFromTemplate`, `materialiseCompanySlave`, `setSlaveCapabilities`, `listOrganization` and `buildOrganization` keep one signature across every task that mentions them. `SupervisorSlave.capabilities`, `SupervisorTask.requiredCapabilities`, `SupervisorWorld.{taxonomy,company,catalog}` are added in Task 3 and defaulted in the same step's fixtures.
