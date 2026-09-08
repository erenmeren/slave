# M33 — Adopt a simulated organisation: from a software-sector run to a real workspace

**Status:** Approved in conversation (2026-09-07; the user waived the written-spec review and asked for plan + subagent execution). Decisions taken: adoption is roster + roles + a settings proposal (not a new runtime, not a goal text); only software-sector runs are adoptable; the target is an existing workspace that has no company yet; `autoMerge` is never switched on by adoption; a paid model override is written only with an explicit choice; adoption starts nothing.
**Approach:** one milestone, one additive migration (`Workspace.adoptedFromSimulationId`). A new control verb `adoptSimulation` composes the existing one-way `assignCompany` (M10) with the simulation's contribution — the roles the run assigned, a settings proposal derived from the policy, and an optional model override — in one transaction, and journals the adoption on the run.
**Scope rule:** what a person needs to take an organisation they tried in a software-company simulation and put it on a real project: pick the run, pick a workspace, see the roles and the proposed settings, adjust, adopt, and land on the workspace with its roster in place. Nothing else.

## 1. Principles (M10 §5, M29 §2/§8, M31a §2 stay binding; added here)

1. **Adoption composes; it does not fork.** The company is the same `Company` row the simulation ran on; the roster is materialised by `assignCompany` exactly as an operator assignment would be. Adoption adds roles, settings and provenance — it never creates a second organisation model.
2. **Simulated money never becomes a real budget.** The run's `maxModelCostUsd`, cash and metrics inform nothing in the workspace's `budgetUsd`; the proposal keeps the workspace's own budget.
3. **Nothing runs because of adoption.** No daemon, run, deploy or message starts; the workspace waits for the operator's own start, as before. `autoMerge` is `false` after adoption whatever it was proposed as, and the preview shows it locked.
4. **Paid use stays an explicit choice.** The run's model (an `llm` run's `modelProvider`/`model`) becomes a roster override for the `lead` only when the person ticks it (`applyModel: true`); `admitRoster`'s provider admission still applies.
5. **Only a software organisation maps to software work.** A trade run's roles (sales, purchasing, operations, finance) are not coding roles; adoption of a trade run is refused with `not_adoptable`, never approximated.

## 2. Data model (migration `m33_adopt_simulation`)

```prisma
model Workspace {
  // …
  /// M33: the simulation run this workspace's organisation was adopted from; null for every
  /// workspace assigned by hand. SetNull: deleting the run must not touch the project.
  adoptedFromSimulationId String?
  adoptedFromSimulation   SimulationRun? @relation(fields: [adoptedFromSimulationId], references: [id], onDelete: SetNull)
}
model SimulationRun { adoptedWorkspaces Workspace[] }
```
- A run may be adopted by many workspaces; a workspace records at most one origin (it is assigned once — M10 one-way rule).
- Journal: `control { op: 'adopted', workspaceId, workspaceName, settings: { maxConcurrentRuns, maxAttempts }, roles: { <slaveName>: <role> }, appliedModel: { provider, model } | null }` at `max(seq)+1` (watermark moved, M32 item 3). `SimulationSummary` gains `adoptedBy: readonly { workspaceId: string; workspaceName: string }[]`.

## 3. Control (`packages/control/src/simulation/adopt.ts`)

```ts
export interface AdoptionPreview {
  readonly simulationId: string
  readonly companyId: string; readonly companyName: string
  readonly roles: readonly { readonly slaveName: string; readonly catalogRole: string; readonly role: string }[]   // role: 'lead' | 'reviewer' | 'product' | expertise
  readonly settings: { readonly maxConcurrentRuns: number; readonly maxAttempts: number; readonly autoMerge: false }
  readonly model: { readonly provider: 'claude_code' | 'cursor'; readonly model: string } | null            // from an llm run, else null
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]                              // companyId null, archivedAt null
}
export function adoptionPreview(simulationId: string): Promise<Result<AdoptionPreview, ControlRefusal>>
export function adoptSimulation(simulationId: string, input: { workspaceId: string; maxConcurrentRuns?: number; maxAttempts?: number; applyModel?: boolean; idempotencyKey?: string }, principal?: Principal): Promise<Result<{ workspaceId: string; assigned: AssignReport }, ControlRefusal>>
```
- **Roles** come from the run's frozen definition: `definition.roles` (`product`/`lead`/`reviewer` → `slaveName`) and `definition.engineers` (`id` = slaveName, `expertise`). A roster slave not in either (e.g. Security, Marketing) keeps its catalog role. **Controller ruling R2:** that assignment is what the PREVIEW and the `adopted` journal row show; what adoption WRITES is a translation of it. `Slave.role` is the runtime's dispatch key — the scheduler matches `Task.requiredRole` to it by equality, `planning.ts` staffs `role === 'manager'`, `review.ts` staffs `role === 'reviewer'` — so the run's `lead` becomes `Slave.role = 'manager'`, its `reviewer` becomes `'reviewer'`, and `product` and every engineer keep their CATALOG role (the planner emits catalog roles as a task's `requiredRole`). `roleOverrides` therefore carries only the translated entries, and `Slave.requiredRole` is not written by adoption at all.
- **Settings proposal:** `maxConcurrentRuns = engineers.length` (clamped to `1..10`), `maxAttempts = policy === 'B' ? 2 : 3`, `autoMerge = false`. The person may override the two numbers within `1..10` / `1..5`; anything else → `invalid_simulation_input`.
- **`adoptSimulation`** (one `$transaction`, `RepeatableRead`, the run row locked `FOR UPDATE` first, then the workspace through `assignCompany`'s own lock): checks the run's sector is `software` (else `not_adoptable { simulationId, reason: 'the trade sector's roles are not software roles' }` — the reason comes from `plugin.adoptable: { ok: true } | { ok: false; reason }`, a new optional `SectorPlugin` field; absent = not adoptable), the workspace exists, is not archived (`workspace_archived`) and has no company (`assignCompany` already refuses `company_already_assigned`); calls `assignCompany(workspaceId, companyId, principal, { roleOverrides })` — `assignCompany` gains an optional fourth parameter `{ roleOverrides?: Readonly<Record<string, string>> }` (slaveName → role) applied to the materialised `Slave.role` (R2: `requiredRole` is left alone), refusing `invalid_simulation_input` before any write when an override name matches more than one roster slave; then writes `maxConcurrentRuns`, `maxAttempts`, `autoMerge: false`, `adoptedFromSimulationId`; if `applyModel` and the run is `llm`, writes `CompanySlave.model/provider` for the `lead`'s roster row (and only that row — the row is resolved to exactly one before any write, and an ambiguous lead name refuses `invalid_simulation_input`); journals `adopted`. Idempotent on `idempotencyKey` (`adopt:<key>`) like `stepSimulation`.
- `assignCompany` today returns its refusal from inside the transaction; `adoptSimulation` wraps it so the whole adoption rolls back on any refusal.
- Refusals: new `not_adoptable { simulationId, reason }`; reused `simulation_not_found`, `workspace_not_found`, `workspace_archived`, `company_already_assigned`, `invalid_simulation_input`, and `admitRoster`'s provider refusals.

## 4. Web and CLI
- Run page (software runs only): an "Adopt this organisation…" button (`sim-adopt-open`) beside Clone; the drawer (`sim-adopt-drawer`) shows the roles table (read-only), the workspace select (`sim-adopt-workspace`, eligible only; empty → "no workspace without a company; create one from Projects first"), `sim-adopt-max-concurrent`, `sim-adopt-max-attempts`, `autoMerge` shown as `off (locked)`, the model row with `sim-adopt-apply-model` checkbox when the run is `llm` ("also set <model> on <lead>'s roster row — real, paid use"), and `sim-adopt-submit`. Success → `router.push('/w/<workspaceId>')`. A trade run shows no button. Routes: `GET /api/sim/[id]/adoption` (preview), `POST /api/sim/[id]/adopt`.
- Run cards and the run strip: `adopted → <workspaceName>` chip(s). Workspace overview: an "organisation adopted from simulation <name>" note with a link (`ws-adopted-from`).
- CLI: `adopt-simulation --simulation <id> --workspace <id> [--max-concurrent <n>] [--max-attempts <n>] [--apply-model]`; prints the assign report and the settings written.

## 5. Tests and gate
- Control integration (`adopt.test.ts`): preview for a software A run (roles from the definition, settings 4/3, model null) and an llm B run (settings 4/2, model set); adopt → Team/Slave rows with the simulation's roles translated into the runtime's vocabulary (R2/T1-E5: `lead → manager`, `reviewer → reviewer`, everyone else the catalog role) and `requiredRole` untouched, workspace columns, journal `adopted` row with the watermark moved, `adoptedBy` on the summary; second adopt into the same workspace → `company_already_assigned`; another workspace → allowed; trade run → `not_adoptable`; archived workspace → `workspace_archived`; `applyModel` false leaves the roster row untouched, true sets only the lead's; overrides out of range refused; idempotent replay returns the same result without a second journal row.
- Simulation: conformance check that `adoptable` is present on both plugins (trade `ok: false` with a reason, software `ok: true`).
- Web: drawer renders roles/settings/locked autoMerge, posts the body, hides on trade; cards/strip chips; workspace note. CLI test for the verb.
- `gate:m33-adopt` (browser, no daemon): create a software run on a seeded Checkout-Platform-shaped company, create a workspace via the CLI (`create-workspace` on a temp git repo, no company), adopt from the UI, assert on the workspace page the roster with the simulation's roles and the "adopted from" note, assert no run/daemon started, teardown in FK order (workspace → run → company → repo dir).

## 6. Non-goals
Creating a workspace from the drawer, adopting trade runs, goal text, roles as runtime permissions, un-adoption, adopting into a workspace that already has a company.

## 7. Order of work
1. Control: migration, `SectorPlugin.adoptable`, `assignCompany` role overrides, `adoptionPreview`, `adoptSimulation`, refusals, summary `adoptedBy`, tests.
2. Web + CLI: routes, drawer, chips, workspace note, CLI verb, tests, `web:build`.
3. Gate, README, errata, full verification.

## 8. Errata — where execution corrected the plan

**T1-E1 — a workspace that already has THIS company is refused too.** §3 said `assignCompany` already refuses `company_already_assigned`, and it does not: its one-way rule refuses a *different* company, while re-assigning the *same* one is its ordinary re-sync path. Two runs of one company adopted into one workspace would therefore have silently overwritten the first adoption's settings and provenance — the very thing §6 lists as a non-goal. `adoptSimulation` now asks the question itself, behind the workspace's own `FOR UPDATE` lock taken before `assignCompanyTx`'s, and refuses `company_already_assigned` whenever `companyId` is non-null (naming whichever company is there).

**T1-E2 — `assignCompanyTx` takes no `principal`.** Ruling R1's signature carried one, but the transaction body never used it: `assignCompany` emits `workspace.company_assigned` *after* the commit, so the principal belongs to the caller. `adoptSimulation` emits the same event, with its own principal, after its own commit. The extracted form is `assignCompanyTx(tx, workspaceId, companyId, options?)`.

**T1-E3 — the settings ranges have refusal text.** §3 said "anything else → `invalid_simulation_input`" without wording it: the details are `maxConcurrentRuns must be an integer between 1 and 10` and `maxAttempts must be an integer between 1 and 5`.

**T1-E4 — `SectorPlugin.adoptable` is required, not optional.** §3 allowed an absent field to read as "not adoptable"; the conformance test the same section asks for makes absence impossible, so the field is required and every plugin answers explicitly.

### Fix round 1

**T1-E5 (ruling R2) — the run's roles are translated into the runtime's vocabulary, not copied.** `Slave.role` is a dispatch key, not a label: the scheduler matches `Task.requiredRole` to it by equality, `planning.ts` staffs `role === 'manager'` and `review.ts` staffs `role === 'reviewer'`. A worker materialised as `'lead'` would be a manager no planning pass could ever find, and the engineers' expertise (`backend`, `general`) is not a role at all. Adoption now writes `lead → 'manager'`, `reviewer → 'reviewer'`, and leaves `product` and every engineer on their catalog role; `Slave.requiredRole` is not written at all (that column names the role a TASK needs, and adoption creates no tasks). The run's full assignment stays visible in `AdoptionPreview.roles` and in the `adopted` journal payload. §3 amended above.

**T1-E6 — an ambiguous roster name refuses rather than guesses.** `CompanySlave` is unique on `(companyTeamId, name)`, not on `(companyId, name)`, so a company can hold two slaves called "Atlas" in two departments. Both name-keyed writes are now resolved before anything is written: `assignCompanyTx` refuses `invalid_simulation_input { detail: 'the roster has more than one slave named <name>; adoption cannot tell which one the run means' }`, and `applyModel` refuses `{ detail: "the lead's name is ambiguous in the roster; set the model by hand" }` (the lead's row is resolved to exactly one id, hoisted above the assignment so no roster row is written on a guess).

**T1-E7 — an idempotency key belongs to one adoption.** Replaying a key against a DIFFERENT workspace used to answer with the first workspace's id; it now refuses `invalid_simulation_input { detail: 'idempotency key already used for another workspace' }`.

**T1-E8 — `adoptSimulation`'s transaction runs at `RepeatableRead`**, as §3 says. The two `FOR UPDATE` locks are what make it correct; the level matches `read.ts`'s multi-read transactions.

### Task 2

**T2-E1 — the run page's snapshot carries `adoptable: boolean`.** §4 says "software runs only" show the button and "a trade run shows no button", but names no field the page could read to decide. `SimulationSnapshot` (`apps/web/src/server/simulation.ts`) gained `adoptable`, set from `plugin.adoptable.ok` — the plugin's own verdict, so nothing under `apps/web/src` names a sector; `SimulationClient.tsx` renders `sim-adopt-open` and mounts `AdoptDrawer` only when it is `true`.

**T2-E2 — the "adopted from" note lives in the overview component, fed by the snapshot.** §4 placed it on "the workspace overview" and the plan said to find the component under `apps/web/src/app/w/[workspaceId]`; the project header there is `OverviewClient.tsx` (`apps/web/src/components`), so the note (`ws-adopted-from`, "organisation adopted from simulation <name>" linking to `/sim/<id>`) renders there, above the top strip, off a new `OverviewSnapshot.workspace.adoptedFrom: { simulationId, name } | null` that `buildOverviewSnapshot` reads by including `adoptedFromSimulation` on its one existing workspace query — no route-level component and no second round trip.

**T2-E3 — the preview route answers with the preview itself, and `refusalStatus` is exported for it.** (A departure from the sibling routes' idiom rather than from §4, which fixed no response shape.) Every other sim route wraps a mutation's small value in `{ ok: true, ... }` through `simControlResponse`; `GET /api/sim/[id]/adoption` returns `AdoptionPreview` bare, since the preview IS the payload the drawer renders. To map its refusals the same way (404 for a not-found id, 409 otherwise), the status rule inside `simControlResponse` was extracted as `refusalStatus(kind)` in `apps/web/src/server/simControlRoute.ts`.

**T2-E4 — the chips have a test id, and the CLI reads the settings back.** §4 named the `adopted → <workspaceName>` chip but no test id; both the run cards (`SimulationsClient.tsx`) and the run strip (`SimulationStrip.tsx`) render it as `sim-adopted-chip`. §4 said the CLI "prints the assign report and the settings written"; `adoptSimulation`'s return carries only the assign report, so `adopt-simulation` reads `maxConcurrentRuns`/`maxAttempts`/`autoMerge` back off the workspace row it just wrote and prints those.

### Task 2 fix round 1

**T2-E5 (ruling R3) — `runtimeRole` is on the preview, not re-derived in the drawer.** The first cut of `AdoptDrawer.tsx` carried its own two-entry `lead → manager`, `reviewer → reviewer` table to fill the "becomes" column — a copy of control's `RUNTIME_ROLE` that would have drifted the first time either side changed. `AdoptionPreview.roles[]` now carries `runtimeRole`, computed by one function in control, `runtimeRoleOf`, which reads the same `RUNTIME_ROLE` table `roleOverridesOf` writes from; the drawer's third column is `row.runtimeRole` and nothing more. §3's interface amended above.

**T2-E6 — an unknown workspace is 404 on the adopt route.** `workspace_not_found` joined the sim routes' `NOT_FOUND` set in `simControlRoute.ts`. It was the one place a wrong workspace id read 409: the archive/restore routes already answer 404 for it, and `company_not_found` already did here.

**T2-E7 — the CLI help names no sector.** The `adopt-simulation` usage text said "Only a software-sector run is adoptable"; it now says "Only a run whose sector allows adoption is adoptable" — the plugin's `adoptable` verdict is the rule, and the CLI, like control and web, does not spell a sector's name outside the registry.

**T2-E8 — a blank or non-numeric setting blocks submit.** A cleared `sim-adopt-max-concurrent` / `sim-adopt-max-attempts` field used to fall back silently to the proposal — a value the person had just deleted. The drawer now shows "enter a whole number" inline (`sim-adopt-max-concurrent-error` / `sim-adopt-max-attempts-error`), disables `sim-adopt-submit`, and the POST body always carries both integers; the control layer's `1..10` / `1..5` ranges still refuse anything outside them with 409, worded as in T1-E3.
