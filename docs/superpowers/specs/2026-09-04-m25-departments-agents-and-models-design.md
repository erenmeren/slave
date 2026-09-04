# M25 — Departments, agents from the catalog, and a model list that knows the account

**Status:** Approved (scope, the two "option 1" approaches and the five design sections approved in conversation 2026-09-04)
**Approach:** one milestone. No schema, no migration, no new dependency. Departments are the `Team`/`CompanyTeam` rows the app already has, given their real name and the two verbs they lack (create in a project, move an agent). The model field becomes a select fed by each provider adapter. "New agent" is the catalog form with an optional assign step, opened from the Agents page.
**Scope rule:** the four things the operator asked for on 2026-09-04 — "how do I know which models exist", "where is an agent created and updated", "I need to create departments, name them, and put people in them" — minus the fourth (subscription billing), which the operator withdrew: "the current cost system is fine; maybe later".

## 1. Why this milestone

After M24 the operator can see every agent in one table and every project under one header,
but cannot do three things from that table: put an agent in a department, create a department
to put it in, or pick a model from a list. `Team` rows exist per project and `CompanyTeam` rows
exist per company; the Agents table calls the first one "team" and reads it from a column an
operator cannot change. The model field on every form is free text — a typo becomes a run
failure — while `cursor-agent models` already prints the account's real list and the Claude Code
CLI documents its aliases.

Creating an agent works today only through the catalog (`AgentTemplate` → `CompanyAgent` →
`assignCompany` → `Agent`), which is the right pipeline; what is missing is a door to it from
the Agents page and a way to land the new agent in a project in the same motion.

**Non-goals:** a subscription / flat-rate billing mode (withdrawn; `admitRun`, `budgetUsd`,
`reportsCost` are untouched); drag-and-drop between departments (a later milestone; this one
uses a select); a separate `Department` table; live discovery of Claude models through the
Anthropic Models API (needs an API key the operator does not want to manage — the adapter's
static list is the source); editing `AgentTemplate` rows beyond what `TemplateCatalog` does
today; the Floor view; chat intake.

## 2. Vocabulary

| Word in the UI | Row | Where it lives |
|---|---|---|
| **department** | `Team` | a project (`workspaceId`); `companyTeamId` links it to the template it was copied from, or `null` for one made in the project |
| **department template** | `CompanyTeam` | a company in the catalog |
| **agent** | `Agent` | a project, in exactly one department (`teamId`) |
| **catalog agent** | `CompanyAgent` | a department template (`companyTeamId`); `assignCompany` materializes it into a project agent |

Table names, columns and the Prisma schema do not change. Every user-facing string, testid and
route segment that said "team" for one of these rows says "department" from this milestone on;
`renameTeam`/`deleteTeam` and their routes keep their names (they are project-department verbs
and the CLI already documents them).

`assignCompany` keeps its contract: a department template matches a project department by
`companyTeamId` first, then adopts a same-named legacy one, then creates one. A project
department is an editable copy — renaming it, or moving an agent into or out of it, never writes
back to the template.

## 3. Departments

### 3.1 Control verbs (`packages/control/src/org.ts`)

All five follow the house shape of `renameTeam`/`deleteTeam`: one transaction, a `Result` with a
typed refusal. The two project-level verbs end in exactly one `org.changed` event (the M23 D1
type; no new `EventType` member, so no migration) with the M23 payload shape `{ entity, id,
field, from, to }` and the acting principal. The three catalog-level verbs write no event, the
rule `createCompany`/`addCompanyTeam`/`addCompanyAgent` already follow: an `ExecutionEvent`
belongs to a workspace and the catalog has none.

| Verb | Writes | Refusals | Event |
|---|---|---|---|
| `createProjectTeam(workspaceId, name, principal?)` | `Team { workspaceId, name, companyTeamId: null }` | `workspace_not_found`, `invalid_name`, `duplicate_name` (same name in that workspace, case-sensitive as today) | `org.changed` `{ entity: 'team', field: 'created', from: null, to: name }` |
| `moveAgent(agentId, teamId, principal?)` | `Agent.teamId` | `agent_not_found`, `team_not_found`, `team_workspace_mismatch` (target team's `workspaceId` ≠ agent's), `agent_run_active` (same rule as `deleteAgent`: no move while a run is live) | `org.changed` `{ entity: 'agent', field: 'team', from: <old name>, to: <new name> }` |
| `moveCompanyAgent(companyAgentId, companyTeamId, principal?)` | `CompanyAgent.companyTeamId` | `agent_not_found`, `company_team_not_found`, `company_mismatch` (target template belongs to another company), `duplicate_name` (`@@unique([companyTeamId, name])`) | none (catalog) |
| `renameCompanyTeam(companyTeamId, name, principal?)` | `CompanyTeam.name` | `company_team_not_found`, `invalid_name`, `duplicate_name` (`@@unique([companyId, name])`) | none (catalog) |
| `deleteCompanyTeam(companyTeamId, principal?)` | deletes the row; project copies keep living with `companyTeamId = null` (`onDelete: SetNull`) | `company_team_not_found`, `team_not_empty` (any `CompanyAgent` still in it) | none (catalog) |

Moving a project agent leaves `companyAgentId` alone: the agent still knows which catalog row it
came from; only its department changed. `assignCompany` run again later does not move it back
(it finds the worker by `companyAgentId` and leaves it where it is).

### 3.2 Routes (`apps/web/src/app/api`)

Through `orgControlRoute` like the M23 verbs: JSON body, principal from the session, refusal →
409 with `{ kind, … }`, success → 200 with the updated row's id.

| Route | Verb |
|---|---|
| `POST /api/w/[workspaceId]/teams` `{ name }` | `createProjectTeam` |
| `PUT /api/agents/[agentId]/team` `{ teamId }` | `moveAgent` |
| `PUT /api/org/agents/[companyAgentId]/team` `{ companyTeamId }` | `moveCompanyAgent` |
| `PUT /api/org/teams/[companyTeamId]/name` `{ name }` | `renameCompanyTeam` |
| `DELETE /api/org/teams/[companyTeamId]` | `deleteCompanyTeam` |

### 3.3 CLI (`apps/orchestrator/src/cli.ts`)

`create-team --workspace <id> --name <name>`, `move-agent --agent <id> --team <id>`,
`move-company-agent --agent <id> --team <id>`, `rename-company-team --team <id> --name <name>`,
`delete-company-team --team <id>`. Same verbs, same refusals printed the way `rename-team`
prints them. The web never gets a verb the CLI lacks.

### 3.4 Reads (`apps/web/src/server/org.ts`)

- `AllAgentRow` gains `teamId: string | null` and `companyTeamId: string | null` so the table's
  select knows the current value; `teamName` is renamed `departmentName` (the column header
  reads `department`).
- `listAllAgents()` also returns, alongside the rows, the option lists the selects need:
  `departmentsByWorkspace: Record<workspaceId, { teamId; name }[]>` and
  `templatesByCompany: Record<companyId, { companyTeamId; name }[]>` — one query each, no
  per-row round trip. The function's return type becomes `{ rows, departmentsByWorkspace,
  templatesByCompany }`; the page and the table take the object.
- `listProjectTeams()` is unchanged apart from its docstring; `listRoster()` unchanged.

## 4. Departments in the UI

### 4.1 Agents table (`AllAgentsTable`)

- The "team" column becomes **department**, and on every row it is a `<select>`
  (`data-testid="agent-department"`). A project row lists that project's departments and
  changing it calls `PUT /api/agents/:id/team` then `router.refresh()`; a catalog row lists the
  company's department templates and calls `PUT /api/org/agents/:id/team`. A refusal renders
  under the cell as `role="alert"` (`agent-department-error`), the way `AgentRowActions` shows a
  rename refusal. While the request is in flight the select is disabled.
- The 5 s poll merges `teamId`/`departmentName` like the other live fields, so a move made from
  the CLI shows up without a reload.
- Column widths: `'200px 110px 150px 120px 110px 1fr 90px 90px 160px'` (the department column
  grows by 20 px to fit a select); the m14 gate's `AGENTS_COLUMNS` follows.

### 4.2 The Departments tab (was Teams)

- Tab id and testid become `agents-tab-departments`; label **Departments**. `TeamsTable` is
  renamed `DepartmentsTable` (file, export, test file), header `Project · Department · Agents ·
  actions`; rename and delete-when-empty stay as they are (`department-rename`,
  `department-delete`).
- Above the table, one form row (`department-form`): a project select fed by
  `listWorkspaceNames()` (M24), a name input, an add button (`department-submit`) →
  `POST /api/w/:id/teams` → `router.refresh()`; refusal in `department-error`. With no
  workspace in the install the form renders disabled with "attach a project first".

### 4.3 The catalog (`CompanyManager` on `/`)

- Each department template row gains inline rename (`department-template-rename`, the
  `TeamsTable` idiom: click the name, Enter commits, Escape cancels) and a delete button
  (`department-template-delete`) that is disabled while the template has members (`title`
  explains). The add-member form under each template is unchanged apart from the model field
  (§5).
- Strings and testids: "team" → "department" (`company-team-form` → `department-template-form`,
  `company-team-submit` → `department-template-submit`, header text "departments").

## 5. Models

### 5.1 Adapter contract (`packages/providers`)

`ProviderAdapter` gains one method:

```ts
listModels(): Promise<ModelListing>

interface ModelListing {
  readonly models: readonly { readonly id: string; readonly label: string; readonly default?: true }[]
  /** `account`: read from the provider for this login; `static`: the adapter's own table. */
  readonly source: 'account' | 'static'
  /** Set when an `account` read failed; `models` is then empty and the UI falls back to text. */
  readonly error?: string
}
```

- **Cursor** (`packages/providers/src/cursor/models.ts`): runs `cursor-agent models` with a 10 s
  timeout, strips ANSI escapes, and parses lines of the form `<id> - <label>`; a trailing
  `(default)` sets `default: true`; the "Available models" heading and blank lines are skipped.
  The parser is a pure function `parseCursorModels(stdout: string)` with its own unit test on a
  captured fixture. A missing binary, non-zero exit or timeout returns `{ models: [], source:
  'account', error }` — never throws.
- **Claude Code** (`packages/providers/src/claude/models.ts`): returns `source: 'static'` with
  the aliases the CLI documents (`default`, `fable`, `opus`, `sonnet`, `haiku`) followed by the
  current full ids the adapter is tested against. The file's header says it is pinned to the
  CLI version the adapter was last measured with and is updated by hand with the adapter.
- `capabilitiesOf` and the `ProviderKind` enum are untouched.

### 5.2 Server and route (`apps/web`)

- `apps/web/src/server/models.ts`: `listModelsFor(kind: ProviderKind, opts?: { refresh?: true })`
  calls the adapter and caches the listing in a module `Map` for five minutes per kind; an
  `error` listing is cached for thirty seconds so a flapping CLI is not hammered. The cache is
  reset by a `clearModelCache()` export for tests.
- `GET /api/providers/[kind]/models` (`?refresh=1` bypasses the cache): 404 for a `kind` outside
  `PROVIDER_KINDS`; same auth envelope as the other `GET` routes. Response is the `ModelListing`
  verbatim.

### 5.3 `ModelSelect` (`apps/web/src/components/ModelSelect.tsx`)

`ModelSelect({ provider: ProviderKind | null; value: string | null; onChange(next: string | null) })`.

- `provider === null`: a disabled select with the hint "choose a provider first"
  (`model-select`, disabled).
- On a provider: fetches `/api/providers/<kind>/models` once per provider value (a module-level
  promise cache keyed by kind, so three editors on a page share one request), shows a
  `<select data-testid="model-select">` with `— none —`, every model (`label` shown, `id` as the
  value, the default marked "(default)"), and `other…` last.
- `other…` reveals a text input (`data-testid="model-select-other"`) seeded with the current
  value; the existing free-text testids that tests and gates read (`model-override-input`,
  `template-model`, `company-agent-model`) are kept on that input by a `inputTestId` prop.
- A listing with `error` (or an empty `models`) renders the text input directly with a one-line
  note "model list unavailable: <error>" (`model-select-note`) — the form still works.
- A `value` that is not in the list (a hand-typed id from before this milestone) is shown as a
  selected extra option, so nothing existing is silently changed.

Used in: `ModelOverrideEditor` (the Agents table), `CompanyManager`'s add-member form,
`TemplateCatalog`'s form (default model, paired with its default provider). `RuntimePanel` is
untouched — a workspace has a provider, not a model.

## 6. "New agent" from the Agents page

- Header row of the Agents page gets `+ New agent` (`data-testid="new-agent"`), opening
  `components/agents/NewAgentDrawer.tsx` — the `NewProjectDrawer` idiom (scrim, `role="dialog"`,
  Escape, close button `new-agent-close`).
- Form: company (select), department template (select filtered by company, last option
  `new department…` reveals a name input and creates the `CompanyTeam` first via
  `POST /api/org/teams`), template (`AgentTemplate` select), name, provider (`ProviderSelect`),
  model (`ModelSelect`), and **assign to project** (workspace select, optional).
- Submit: `POST /api/org/agents` (`addCompanyAgent`); if a project was chosen, then
  `POST /api/w/:id/company` (`assignCompany`) — the existing behaviour: every member of the
  company not yet in that project materializes, this one included. Success closes the drawer and
  `router.refresh()`. If step one succeeds and step two is refused, the drawer stays open
  showing step two's refusal and a line "catalog agent created; assign from the project card";
  nothing is rolled back.
- No new verb, route or URL parameter.

## 7. Components and files

Create: `packages/providers/src/cursor/models.ts`, `packages/providers/src/claude/models.ts`,
`apps/web/src/server/models.ts`, `apps/web/src/app/api/providers/[kind]/models/route.ts`,
`apps/web/src/app/api/w/[workspaceId]/teams/route.ts`, `apps/web/src/app/api/agents/[agentId]/team/route.ts`,
`apps/web/src/app/api/org/agents/[companyAgentId]/team/route.ts`,
`apps/web/src/app/api/org/teams/[companyTeamId]/name/route.ts`,
`apps/web/src/app/api/org/teams/[companyTeamId]/route.ts`, `apps/web/src/components/ModelSelect.tsx`,
`apps/web/src/components/agents/NewAgentDrawer.tsx`.

Modify: `packages/providers/src/types.ts` (interface), both adapters, `packages/control/src/org.ts`
(five verbs), `apps/orchestrator/src/cli.ts` (five verbs), `apps/web/src/server/org.ts`
(`AllAgentRow`, `listAllAgents`), `AllAgentsTable.tsx`, `AgentsClient.tsx`, `app/agents/page.tsx`,
`TeamsTable.tsx` → `DepartmentsTable.tsx`, `CompanyManager.tsx`, `TemplateCatalog.tsx`,
`ModelOverrideEditor.tsx`, the four gate scripts that read the renamed testids, README (Web UI
table: Agents and Projects rows), this spec's §12.

Delete: nothing.

## 8. Testing

- `packages/control/test/org.test.ts` (integration, shared test DB): each verb's success path
  writes the row (and, for the two project-level verbs, one `org.changed` event with the M23
  payload); each refusal kind is exercised; `moveAgent` across workspaces
  refused; `deleteCompanyTeam` refused with a member, allowed after moving it; a project copy
  survives its template's deletion with `companyTeamId = null`.
- `packages/providers/test/cursor-models.test.ts`: `parseCursorModels` on a captured fixture
  (ANSI, heading, `(default)`), on empty output, on garbage; the adapter's `listModels` with the
  binary missing returns an `error` listing.
- `apps/web/test/server/models.test.ts`: cache hit within five minutes, refresh bypass, error
  listing cached thirty seconds (fake timers, adapter mocked).
- Route tests for the five verbs and the models route (404 on an unknown kind).
- Components: `model-select.test.tsx` (the five states of §5.3); `all-agents-table.test.tsx`
  (department select calls the right route per row kind, refusal renders, poll merge updates the
  department); `departments-table.test.tsx` (form posts, refusal, disabled without a project);
  `company-manager.test.tsx` (rename/delete template, delete disabled with members);
  `new-agent-drawer.test.tsx` (both submit paths, step-two refusal keeps the drawer open);
  `model-override-editor.test.tsx` adapted to the select with its refusal cases intact.
- Gates: m11-shell drives the renamed catalog testids and one department move; m14-fidelity's
  Agents rows and `AGENTS_COLUMNS` follow the new width; m16/m18 unaffected.

## 9. Global constraints

- No migration, no schema change, no new npm dependency; the Prisma enum `ProviderKind` is
  unchanged.
- Every web verb has a CLI verb; every project-level verb writes one `org.changed` event with
  the principal; catalog-level verbs write none (M23 rule). No new `EventType` member.
- Refusals are typed `kind`s on the `Result` union; routes map them to 409 (house rule).
- One vitest run at a time; `npm run web:build` gates every web task; gates never overlap.
- Testids named here are exact; the free-text model testids survive on the `other…` input.
- Strings: "department" everywhere a `Team`/`CompanyTeam` is shown; "team" survives only in
  identifiers the CLI already documents (`rename-team`, `delete-team`, `teamId`).

## 10. Order of work

1. Control verbs + CLI (§3.1, §3.3) with their integration tests.
2. Routes (§3.2) with route tests.
3. Adapter `listModels` + parser + server cache + route (§5.1–5.2).
4. `ModelSelect` and its three call sites (§5.3).
5. Reads (§3.4) and the Agents table's department select (§4.1).
6. Departments tab and catalog rename/delete (§4.2–4.3).
7. New agent drawer (§6).
8. Gates, README, §12 Errata, closing run.

## 11. Out of scope, recorded

- Subscription billing: withdrawn by the operator on 2026-09-04; `admitRun`'s cost-blind refusal
  stands.
- Drag-and-drop departments board; `/agents?new=1`; Claude models from the Anthropic API.

## 12. Errata — where execution corrected the plan

(empty at approval; filled by the last task)
