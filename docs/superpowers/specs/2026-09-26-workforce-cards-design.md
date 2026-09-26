# Workforce cards — persona and person cards with skills, plugin skills and workflow

Date: 2026-09-26 · Status: approved in conversation, awaiting written-spec review

## Why

The operator wants the specialists they imported (279 personas from the agency catalogue) to be *equipped*: a frontend specialist should carry frontend skills and a workflow, not only a persona text. The mechanism already exists and nobody uses it:

- `TemplateSkill` rows in the dev DB: 0;
- `PersonSkill` rows: 8;
- `Skill` rows: 58.

The `/workforce` page shows both lists as tables. Skills are only visible and editable inside a drawer, one persona at a time. Equipping specialists is therefore tedious, so it has not happened. This redesign makes "who knows what" visible at a glance and linking a skill one click away.

This is also the prerequisite for the next benchmark: equipped specialist team vs solo vs solo + skills (see `docs/superpowers/reviews/` and the pilot-1 findings).

## Decisions (operator, 2026-09-26)

1. **Both lists become cards:** Catalog (personas / `SlaveTemplate`) and People (`Person`). They share one filter bar.
2. **Rich card (option B):** the card shows the following, and a skill can be added from the card itself:
   - skills with their source;
   - plugin skills marked;
   - the first workflow steps.
3. **Adding a skill on a People card asks for the scope:** "only this person" (default) or "everyone hired from this persona". On a Catalog card the skill always goes to the persona.
4. **The Specialty filter uses capability domains:** the 29 domains, the matching basis for staffing, not import divisions.
5. **Plugins stay a skill source, not a new concept.** Plugin skills are linked skill by skill, grouped by plugin in the picker, and marked 🔌. Process-management skills carry a warning.

## Scope

In:
- the Catalog and People tabs of `/workforce` (`apps/web/src/components/workforce/WorkforceCatalog.tsx`, `apps/web/src/components/persons/PeopleTable.tsx`);
- a shared filter bar;
- the card component;
- the skill picker;
- the minimal server reads/facets they need.

Out:
- New tables, a plugin entity, editing the workflow on the card (the existing ProfileDrawer customise mode stays the editor).
- Changing how skills reach a run (injection into `.claude/skills` stays as is).
- The Skills / Evidence / Departments tabs.
- Hiring flow changes.

## Design

### 1. Filter bar (`WorkforceFilterBar`, one component for both tabs)

Built from `CatalogFilterBar`; its URL state (`lib/catalogFilters.ts`, `hooks/useCatalogFilters.ts`) is generalised to both tabs. It holds:

- **Search:** name, summary, capability, skill name. It already exists for the catalog and is **new for People**.
- **Specialty chips:** one per capability domain that has at least one match, with counts, ordered by count. The first ~8 are shown and the rest are behind "+N".
  - Single-select, click again to clear.
  - A persona or person matches a domain when any of its effective capability keys starts with `<domain>.`.
  - Facets are computed in the database, as the catalog's are today.
- **Division select:** kept, still the import division.
- **Skill select:** kept.
- **"No skills" toggle:** new. It shows only rows with zero effective skills, the "who still needs equipping" view.
- **People only:** the existing Everyone / In the pool / Assigned / Released segmented control.
- **Clear all.**

People filtering moves from client-side to the server, the same way the catalog's already works: a `listPeoplePage` read with a cursor and facets in `apps/web/src/server/persons.ts`. The pool keeps up to 3 people per template, so the list can reach several hundred rows, and client-side filtering over that plus facets is the wrong place.

### 2. Card (`WorkforceCard`, variants `persona` and `person`)

Laid out in a grid `repeat(auto-fill, minmax(320px, 1fr))`, reusing `Card`, `AvatarTile`, `Chip` and `StatusPill`. It is denser in developer mode via the existing `data-mode` tokens.

- **Header:**
  - avatar (initials), name, division;
  - persona: an active/inactive `StatusPill`, with the Hirable toggle kept on the card;
  - person: where they work (project seat chips, or pool / released).
- **Specialties:** up to 3 capability chips plus "+N"; the full list is in the drawer.
- **Skills:** chips for the effective skills.
  - Source glyph: 🧩 for `personal`/`project` providers, 🔌 for `plugin:<name>`, with the plugin name in the tooltip.
  - On person cards, an origin mark: "from persona" or "this person only" (the domain `SkillOrigin`), plus a revoked state when a persona skill was revoked for this person.
  - Process-management skills get ⚠️ (§4).
  - Up to 6 chips plus "+N".
  - Each chip has a remove control, with the same scope rule as adding.
- **Workflow:** the first 3 steps of the effective profile's `workflow` (`ProfileSpec.workflow`, with overrides applied), then "+N steps". "No workflow in this profile" when empty.
- **"+ skill":** opens the picker (§3).
- **Click on the card body:** opens the existing drawer: `ProfileDrawer` for personas, the person sheet for people. Nothing inside the drawers changes.

### 3. Skill picker (`SkillPicker`, a `Sheet` on mobile and a popover or `Dialog` on desktop)

- Search over skill name and description.
- Grouped by provider: "Your skills" (`personal`), "Project" (`project`), then one group per plugin (`plugin:<name>`, shown as 🔌 `<name>`).
- Already-linked skills are shown checked and disabled.
- **Scope, People cards only:** a two-option control above the list, "Only this person" (default) and "Everyone from <persona name>".
- Confirm writes through the existing APIs:
  - **Persona:** PATCH `/api/org/templates/[id]/skills`. That route replaces the whole set, so the client sends the current set plus the addition. A stale write is refused if the route can take the previous set as a precondition. If it can't, compute server-side, adding only.
  - **Person:** PATCH `/api/persons/[id]/skills` with `grant`.
  - Removing uses `revoke`/`clear` (person) or the reduced set (persona).
- Missing skills (`Skill.missingSince` set) are shown greyed and cannot be added.

### 4. Process-management skill warning

Finding F9 showed that a worker which loads a process skill (brainstorm, write a plan, dispatch helpers, review rounds) runs a whole development process inside one task instead of doing the task. The picker and the card flag these skills.

- **What counts:** a small domain constant `PROCESS_SKILL_NAMES` in `packages/domain`, holding brainstorming, writing-plans, executing-plans, subagent-driven-development, dispatching-parallel-agents, using-git-worktrees, finishing-a-development-branch, requesting-code-review, receiving-code-review and using-superpowers. Every skill from provider `plugin:superpowers` is treated the same way.
- **Card:** ⚠️ on the chip, with the tooltip "Process skill: can make a worker plan and delegate instead of doing its task."
- **Picker:** selecting one shows the same sentence and needs an explicit confirm.
- It is not blocking; the operator decides.

### 5. Data

No schema change. The server reads that feed the cards:

- **Catalog:** extend `listWorkforceCatalogPage` rows with:
  - the effective skills (id, name, provider, missing);
  - `workflowPreview` (the first 3 steps and the total count from the effective profile);
  - the domain facets.
- **People:** a new `listPeoplePage` with the same row shape, plus seats, lifecycle and per-skill origin (`personEffectiveSkills`).

Both are paged by cursor (the catalog's existing 100-row pages with "Show more").

### 6. Error handling and states

- An empty filter result gets an `EmptyState` with a "Clear filters" action.
- A failed skill write gets an inline `Alert` on the card, and the chip rolls back.
- A persona skill write that races another edit gets the refusal text from the route, and the card refetches.

## Testing

- **Domain:** `PROCESS_SKILL_NAMES` / `isProcessSkill` (provider and name).
- **Server:**
  - `listPeoplePage` and the extended catalog read: filters, domain facets, "no skills", cursor paging, effective skills with origin and revocation;
  - integration against the test DB.
- **Routes:**
  - persona skill add/remove keeps the other links;
  - person scope "only this person" vs "everyone from persona" writes the right table;
  - a missing skill is refused.
- **Components** (Vitest + Testing Library):
  - the card renders source glyphs, origin marks, ⚠️, workflow preview and "+N";
  - the filter bar round-trips URL state;
  - the picker groups by provider, forces the scope choice on person cards, and requires the process-skill confirm.
- **Gates:**
  - `npm run web:build`;
  - `gate:m26-vocabulary` (UI copy says "worker"/"person"/"slave", never the banned word);
  - the M57/M61 UI gates that cover `/workforce` (fixed viewport, simple mode);
  - `npm run typecheck`, full vitest.

## Open risks

- **Density:** a rich card with 6 skills and 3 workflow steps is tall, so fewer fit on a screen. Mitigation: the chip caps above. Developer mode is denser.
- **Pool size:** hundreds of pool people make People long; the default stays "Everyone" (not "Assigned") -- server paging, not the default, is what keeps the list usable.
- **Profiles without a Workflow heading:** agency profiles vary, and some have no workflow section. The card says so rather than hiding the block.
