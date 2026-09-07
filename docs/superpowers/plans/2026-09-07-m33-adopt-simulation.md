# M33 Adopt Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a software-sector simulation run, adopt the organisation into an existing company-less workspace: the roster materialised with the run's roles, a settings proposal from the policy, an optional lead model override, provenance on both sides — starting nothing.

**Architecture:** `packages/control/src/simulation/adopt.ts` composes `assignCompany` (gaining optional role overrides) with the simulation's contribution in one transaction; `SectorPlugin.adoptable` decides eligibility; web adds a drawer and chips; CLI adds one verb; one additive migration.

**Tech Stack:** TypeScript, Prisma 7 (migration), zod, Next.js app router, vitest, playwright-core.

**Spec:** `docs/superpowers/specs/2026-09-07-m33-adopt-simulation-design.md`.

## Global Constraints
- Adoption never spawns a process, starts a run, deploys, or messages; `autoMerge` is written `false` unconditionally.
- Only a run whose plugin reports `adoptable.ok === true` (software) is adoptable; trade → `not_adoptable` with the plugin's reason; no approximation.
- The workspace's `budgetUsd` is untouched by adoption; a model override is written only with `applyModel: true` and only on the lead's `CompanySlave` row.
- `packages/control/src/simulation/*` imports no providers; the roster is materialised by `assignCompany`, not re-implemented.
- No sector name in control/web/CLI except through the registry; the plugin's `adoptable` field carries the reason text.
- One vitest at a time; `npm run --silent typecheck`; `web:build` last for web tasks, never while `next dev` runs; vocabulary gate (`slave`). Commit trailers as in M31/M32.

## File structure
```
packages/db/prisma/schema.prisma + migrations/20260907150000_m33_adopt_simulation/migration.sql
packages/simulation/src/core/plugin.ts (adoptable), trade/plugin.ts, software/plugin.ts, test/core/plugin-conformance.test.ts
packages/control/src/org.ts (assignCompany roleOverrides), refusal.ts (not_adoptable), simulation/adopt.ts, simulation/shared.ts (adoptedBy), simulation.ts barrel
packages/control/test/integration/adopt.test.ts
apps/web/src/app/api/sim/[simulationId]/{adoption,adopt}/route.ts, components/sim/AdoptDrawer.tsx, SimulationClient.tsx, SimulationsClient.tsx, SimulationStrip.tsx, server/simulation.ts, the workspace overview component (ws-adopted-from)
apps/orchestrator/src/cli.ts (adopt-simulation)
scripts/gate-m33-adopt.mjs, package.json, ci.yml, README.md, spec §8
```

---

### Task 1: Control — migration, `adoptable`, role overrides, preview, adopt

**Files:** create migration `20260907150000_m33_adopt_simulation/migration.sql` (`ALTER TABLE "Workspace" ADD COLUMN "adoptedFromSimulationId" TEXT; ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_adoptedFromSimulationId_fkey" FOREIGN KEY ("adoptedFromSimulationId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE; CREATE INDEX "Workspace_adoptedFromSimulationId_idx" ON "Workspace"("adoptedFromSimulationId");`), `packages/control/src/simulation/adopt.ts`, `packages/control/test/integration/adopt.test.ts`; modify `schema.prisma` (spec §2), `packages/simulation/src/core/plugin.ts` (`readonly adoptable: { readonly ok: true } | { readonly ok: false; readonly reason: string }`), `trade/plugin.ts` (`{ ok: false, reason: "the trade sector's roles are not software roles" }`), `software/plugin.ts` (`{ ok: true }`), conformance test (present on every plugin; a reason when not ok), `packages/control/src/org.ts` (`assignCompany(workspaceId, companyId, principal?, options?: { readonly roleOverrides?: Readonly<Record<string, string>> })` — when materialising a worker whose `companySlave.name` has an override, `role = override`, `requiredRole = template.role`; existing callers unchanged), `refusal.ts` (`not_adoptable { simulationId, reason }` → "simulation <id> cannot be adopted: <reason>"), `simulation/shared.ts` (`adoptedBy` from `row.adoptedWorkspaces` select), `simulation.ts` barrel.

**Interfaces:** spec §3 verbatim (`AdoptionPreview`, `adoptionPreview`, `adoptSimulation`).

- [ ] Tests first (`adopt.test.ts`; setup: a Checkout-Platform-shaped company as in `software.test.ts`, a software A run and an llm B run via `createSimulation`, two workspaces created through `prisma.workspace.create` with `repoPath` any string (no git check needed at the row level) and `companyId: null`, one archived): every case in spec §5 "Control integration".
- [ ] `npm run db:generate && npm run db:migrate && npm run db:migrate:test`; implement; `npx vitest run packages/control/test/integration/adopt.test.ts`, then `org.test.ts` (or whichever covers `assignCompany`), `software.test.ts`, `simulation.test.ts`, `refusal-text.test.ts`, `packages/simulation` (conformance) one at a time; `npm run --silent typecheck`.
- [ ] Commit `feat(control,db,simulation): m33 t1 — adoptSimulation: roster with the run's roles, a settings proposal, an explicit model override, provenance both ways`.

---

### Task 2: Web and CLI

**Files:** routes `apps/web/src/app/api/sim/[simulationId]/adoption/route.ts` (GET → preview or refusal), `.../adopt/route.ts` (POST zod `{ workspaceId, maxConcurrentRuns?, maxAttempts?, applyModel?, idempotencyKey? }`); `components/sim/AdoptDrawer.tsx` (spec §4 test ids; fetches the preview on open; submit → POST → `router.push('/w/<id>')`); `SimulationClient.tsx` (button `sim-adopt-open` only when `snapshot.adoptable === true` — the server snapshot gains `adoptable: boolean` from `plugin.adoptable.ok`); `SimulationsClient.tsx` + `SimulationStrip.tsx` (`adopted → <name>` chips from `summary.adoptedBy`); the workspace overview (find the component that renders the project header under `apps/web/src/app/w/[workspaceId]` — add `ws-adopted-from` when `workspace.adoptedFromSimulationId` is set, linking to `/sim/<id>`); `server/simulation.ts` (snapshot fields); `apps/orchestrator/src/cli.ts` (`adopt-simulation` verb per spec §4, usage text). Tests: `simulation-page.test.tsx` (button/drawer/post; hidden on trade), `simulations-page.test.tsx` (chip), a route test for GET/POST refusals, the workspace page test for the note, `cli.test.ts`.
- [ ] Tests first → implement → one test file at a time → typecheck → vocabulary gate → `npm run web:build`.
- [ ] Commit `feat(web,cli): m33 t2 — adopt from the run page: roles, settings preview with autoMerge locked, an explicit model box; adopted chips; the workspace says where its organisation came from`.

---

### Task 3: Gate, README, errata, verification
**Files:** `scripts/gate-m33-adopt.mjs` (spec §5 gate; browser only, no daemon — copy the next-dev/browser skeleton of gate-m31b and the `create-workspace` CLI call of gate-m11 on a temp git repo), `package.json` `gate:m33-adopt`, `ci.yml`, README ("Adopt the organisation" paragraph + CLI line), spec §8 errata from the ledger, full verification (typecheck, `npx vitest run`, `web:build`, gates m26, m29, m30, m31a, m31b, m33, m11).
- [ ] Commit `test(gates),docs: m33 t3 — gate:m33-adopt; README; errata`.
