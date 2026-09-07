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
- **Roles** come from the run's frozen definition: `definition.roles` (`product`/`lead`/`reviewer` → `slaveName`) and `definition.engineers` (`id` = slaveName, `expertise`). A roster slave not in either (e.g. Security, Marketing) keeps its catalog role.
- **Settings proposal:** `maxConcurrentRuns = engineers.length` (clamped to `1..10`), `maxAttempts = policy === 'B' ? 2 : 3`, `autoMerge = false`. The person may override the two numbers within `1..10` / `1..5`; anything else → `invalid_simulation_input`.
- **`adoptSimulation`** (one `$transaction`, `RepeatableRead`, the run row locked `FOR UPDATE` first, then the workspace through `assignCompany`'s own lock): checks the run's sector is `software` (else `not_adoptable { simulationId, reason: 'the trade sector's roles are not software roles' }` — the reason comes from `plugin.adoptable: { ok: true } | { ok: false; reason }`, a new optional `SectorPlugin` field; absent = not adoptable), the workspace exists, is not archived (`workspace_archived`) and has no company (`assignCompany` already refuses `company_already_assigned`); calls `assignCompany(workspaceId, companyId, principal, { roleOverrides })` — `assignCompany` gains an optional fourth parameter `{ roleOverrides?: Readonly<Record<string, string>> }` (slaveName → role) applied to the materialised `Slave.role` (catalog role stays in `requiredRole`); then writes `maxConcurrentRuns`, `maxAttempts`, `autoMerge: false`, `adoptedFromSimulationId`; if `applyModel` and the run is `llm`, writes `CompanySlave.model/provider` for the `lead`'s roster row (and only that row); journals `adopted`. Idempotent on `idempotencyKey` (`adopt:<key>`) like `stepSimulation`.
- `assignCompany` today returns its refusal from inside the transaction; `adoptSimulation` wraps it so the whole adoption rolls back on any refusal.
- Refusals: new `not_adoptable { simulationId, reason }`; reused `simulation_not_found`, `workspace_not_found`, `workspace_archived`, `company_already_assigned`, `invalid_simulation_input`, and `admitRoster`'s provider refusals.

## 4. Web and CLI
- Run page (software runs only): an "Adopt this organisation…" button (`sim-adopt-open`) beside Clone; the drawer (`sim-adopt-drawer`) shows the roles table (read-only), the workspace select (`sim-adopt-workspace`, eligible only; empty → "no workspace without a company; create one from Projects first"), `sim-adopt-max-concurrent`, `sim-adopt-max-attempts`, `autoMerge` shown as `off (locked)`, the model row with `sim-adopt-apply-model` checkbox when the run is `llm` ("also set <model> on <lead>'s roster row — real, paid use"), and `sim-adopt-submit`. Success → `router.push('/w/<workspaceId>')`. A trade run shows no button. Routes: `GET /api/sim/[id]/adoption` (preview), `POST /api/sim/[id]/adopt`.
- Run cards and the run strip: `adopted → <workspaceName>` chip(s). Workspace overview: an "organisation adopted from simulation <name>" note with a link (`ws-adopted-from`).
- CLI: `adopt-simulation --simulation <id> --workspace <id> [--max-concurrent <n>] [--max-attempts <n>] [--apply-model]`; prints the assign report and the settings written.

## 5. Tests and gate
- Control integration (`adopt.test.ts`): preview for a software A run (roles from the definition, settings 4/3, model null) and an llm B run (settings 4/2, model set); adopt → Team/Slave rows with the simulation's roles and catalog roles in `requiredRole`, workspace columns, journal `adopted` row with the watermark moved, `adoptedBy` on the summary; second adopt into the same workspace → `company_already_assigned`; another workspace → allowed; trade run → `not_adoptable`; archived workspace → `workspace_archived`; `applyModel` false leaves the roster row untouched, true sets only the lead's; overrides out of range refused; idempotent replay returns the same result without a second journal row.
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
