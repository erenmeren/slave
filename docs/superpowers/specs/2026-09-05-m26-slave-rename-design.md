# M26 — "Slave of AI": the word is slave, everywhere

**Status:** Approved (scope — everything, DB included; product name; Postgres reset — approved in conversation 2026-09-05)
**Approach:** one milestone, one mechanical rename across every layer, verified by the type checker, the whole suite and the eight gates. A hand-written migration renames tables, columns, indexes and enum values so the schema history stays linear; the local Postgres is recreated under the new name and reseeded (the operator chose to reset the data). No behaviour changes.
**Scope rule:** the operator's words on 2026-09-05 — "agent deme artık, slave olsun isim; değiştir isimleri" and "ürün adı da: Slave of AI". Nothing that is not a name changes in this milestone; deletion (project archive, cascading deletes, catalog deletes) is M27.

## 1. Why this milestone

The product is called Slave of AI in its repository and directory, but the code, the UI, the CLI,
the packages, the database and the README all say "agent" and "AI Team OS". The operator wants
one word. Doing it in one pass, before M27 adds the deletion verbs, means M27 is written in the
final vocabulary and never has to be renamed.

**Non-goals:** any behaviour change; the deletion verbs (M27); renaming the git repository or
the working directory (already `slave`); renaming external things that happen to contain the
word — the `cursor-agent` binary and its fake, the Claude CLI's `--agents` flag, vendor
package names, the word "agentic" in prose (our own `AgentRuntimeAdapter` interface IS ours and
becomes `SlaveRuntimeAdapter`);
rewriting the historical specs, plans and ADRs under `docs/superpowers/` and `docs/decisions/`
(they record what was true when written).

## 2. The mapping

One table, applied by a codemod (`scripts/rename-agent-to-slave.mjs`, kept in the repo so the
rename is reproducible and reviewable) in this order — longest and most specific first, so
`companyAgentId` becomes `companySlaveId` before a bare `agent` pass could touch it.

| From | To | Where |
|---|---|---|
| `AI Team OS` / `ai-team-os` / `aiteamos` / `AITEAMOS` | `Slave of AI` / `slave-of-ai` / `slaveofai` / `SLAVEOFAI` | product name, package scope, env prefix, Postgres names, README, CI |
| `CompanyAgent` / `companyAgent` / `companyAgents` / `companyAgentId` | `CompanySlave` / `companySlave` / `companySlaves` / `companySlaveId` | Prisma model + everywhere |
| `AgentTemplate`, `AgentPermission`, `AgentSkill`, `AgentMessage`, `AgentRun` | `SlaveTemplate`, `SlavePermission`, `SlaveSkill`, `SlaveMessage`, `SlaveRun` | Prisma models + everywhere (incl. `agentRun` → `slaveRun`, `agentRuns` → `slaveRuns`) |
| `Agent` (model, type, component prefix) / `agent` / `agents` / `AGENTS` | `Slave` / `slave` / `slaves` / `SLAVES` | everywhere the token is ours |
| `agentId` / `agentIds` | `slaveId` / `slaveIds` | columns, params, testids |
| `agent.message_sent` (enum `@map`) / `agent_message_sent` | `slave.message_sent` / `slave_message_sent` | `EventType` |
| `Actor.agent` (enum value, stored) | `Actor.slave` | `Actor` enum, every `actor: 'agent'` literal |
| `/api/agents/…`, `/api/org/agents/…`, `/agents` | `/api/slaves/…`, `/api/org/slaves/…`, `/slaves` | route directories + every link and gate |
| CLI `add-agent`, `rename-agent`, `delete-agent`, `move-agent`, `move-company-agent` | `add-slave`, `rename-slave`, `delete-slave`, `move-slave`, `move-company-slave` | no aliases; help text follows |
| testids `agent-*`, `agents-tab-*`, `new-agent*`, `comm-agent-node`, `skills-no-agents` | `slave-*`, `slaves-tab-*`, `new-slave*`, `comm-slave-node`, `skills-no-slaves` | components, tests, gates |
| UI copy "agent"/"agents"/"Agents"/"New agent"/"agents working" … | "slave"/"slaves"/"Slaves"/"New slave"/"slaves working" … | every string an operator reads |
| file names `Agent*.tsx`, `agents/`, `agent-*.test.tsx`, `packages/domain/src/agent/` | `Slave*.tsx`, `slaves/`, `slave-*.test.tsx`, `packages/domain/src/slave/` | `git mv` |

**Protected tokens** (the codemod never touches a match inside these): `cursor-agent`,
`fake-cursor-agent`, `--agents` (the Claude CLI flag, if present), `user-agent`, `agentic`,
`AGENTS.md`, `claude-agent-sdk`, the string `@anthropic-ai/`, and any path under
`docs/superpowers/`, `docs/decisions/`, `node_modules/`, `.git/`, `packages/db/prisma/migrations/`
(old migrations are history; only the new one is written by hand), `packages/providers/test/fixtures/`
(captured vendor output). The codemod prints every protected match it skipped so the review can
see the list.

Case handling: the codemod applies the table to the four case shapes it meets (`Agent`, `agent`,
`agents`, `AGENTS`, plus the camel-case joins `agentId`, `companyAgentId`, `agentRun`…); it does
not invent shapes. A word-boundary rule keeps `management`, `pageant`, `reagent` untouched
(the match must start at a word boundary or a camel-case hump).

## 3. The database

One new migration, `packages/db/prisma/migrations/<timestamp>_m26_slave_rename/migration.sql`,
written by hand (Prisma's diff would emit DROP + CREATE and lose data on any database that has
some):

```sql
ALTER TABLE "Agent"           RENAME TO "Slave";
ALTER TABLE "AgentRun"        RENAME TO "SlaveRun";
ALTER TABLE "AgentTemplate"   RENAME TO "SlaveTemplate";
ALTER TABLE "AgentPermission" RENAME TO "SlavePermission";
ALTER TABLE "AgentSkill"      RENAME TO "SlaveSkill";
ALTER TABLE "AgentMessage"    RENAME TO "SlaveMessage";
ALTER TABLE "CompanyAgent"    RENAME TO "CompanySlave";
-- every column named agentId / companyAgentId, per table (the plan lists each)
ALTER TABLE "SlaveRun"        RENAME COLUMN "agentId" TO "slaveId";
-- … one line per column …
-- constraint and index names follow Prisma's convention <Table>_<cols>_<kind>; rename each so
-- `prisma migrate diff` against the new schema is empty (the plan lists them from `\d`)
ALTER INDEX "AgentRun_agentId_status_idx" RENAME TO "SlaveRun_slaveId_status_idx";
-- … one line per index / constraint …
ALTER TYPE "EventType" RENAME VALUE 'agent.message_sent' TO 'slave.message_sent';
ALTER TYPE "Actor"     RENAME VALUE 'agent' TO 'slave';
```

`schema.prisma` is renamed by the codemod; `npx prisma migrate diff --from-migrations … --to-schema-datamodel …` must report no difference after the migration (the plan's verify step). `db:generate` regenerates the client so `prisma.slave`, `prisma.slaveRun`, `prisma.companySlave` … exist.

**Local Postgres reset** (operator's choice): `docker-compose.yml` names the container
`slaveofai-postgres`, user/password/db `slaveofai`, test db `slaveofai_test`; `.env.example` and
the CI workflow follow. The old container and volume are removed (`docker compose down -v` on the
old file first), the new one created, `db:migrate` + `db:migrate:test` + `db:seed` run. The
memory notes that name the container are updated at the finish.

## 4. Packages, env, product

- Root `package.json` `name`: `slave-of-ai`; workspace packages `@slave-of-ai/control|db|domain|events|orchestrator|providers|web`; every import specifier follows (228 files). `package-lock.json` is regenerated by `npm install` (no dependency change — the lockfile's workspace entries just carry the new names).
- Env prefix `AITEAMOS_` → `SLAVEOFAI_` for all twelve names (`SLAVEOFAI_PAUSE_FLAG`, `SLAVEOFAI_CLAUDE_BIN`, `SLAVEOFAI_PASSWORD`, `SLAVEOFAI_SESSION_SECRET`, `SLAVEOFAI_PERMISSIONS_FILE`, `SLAVEOFAI_CLAUDE_ARGS`, `SLAVEOFAI_NEXT_BIN`, `SLAVEOFAI_CURSOR_BIN`, `SLAVEOFAI_SPIKE`, `SLAVEOFAI_GATE_WARM`, `SLAVEOFAI_TEST_ORPHAN_PID_FILE`, `SLAVEOFAI_GATE_LOG`). No compatibility shim: an old name is simply unset. The operator's `.env` is edited in the same pass (`.env` is git-ignored; the plan's last task edits it and says so).
- README title `# Slave of AI`; every "agent" in README becomes "slave"; `docs/architecture.md`, `docs/domain-model.md`, `docs/event-model.md` likewise (they describe the current system). `docs/decisions/*` and `docs/superpowers/*` are untouched (history). The Turkish PDF `docs/nasil-calisir.pdf` is out of scope (binary, regenerated separately if wanted).
- The `Claude-Session`/`Co-Authored-By` trailers, the `fake-claude.sh` gate fake, the `.claude/` plugin files are not ours to rename.

## 5. Verification

- `npm run typecheck` (every tsconfig) — the compiler is the first net: a missed rename is a type error.
- `npm test` — the whole suite against the new schema and client; the test files were renamed by the same codemod.
- `npm run web:build` — route directories renamed, no dangling `/agents` link (`git grep -n "'/agents\|\"/agents\|/api/agents"` → nothing).
- The eight gates, in the usual order, against the new names.
- A grep gate: `git grep -niE "\bagent" -- . ':!docs/superpowers' ':!docs/decisions' ':!packages/db/prisma/migrations' ':!packages/providers/test/fixtures' ':!package-lock.json'` returns only protected tokens (`cursor-agent`, `agentic`, `AGENTS.md`, vendor names). The plan makes this a CI-runnable script (`scripts/gate-m26-vocabulary.mjs`) so the word cannot creep back.
- Fidelity PNGs regenerated by m14 (the page header now says Slaves).

## 6. Order of work

1. The codemod script + its dry run (a report of every file and every replacement, committed as the review artifact for the mechanical part).
2. Schema + hand-written migration + client regeneration; `prisma migrate diff` empty; the Postgres reset; `db:seed` (the seed's names follow the codemod).
3. Apply the codemod to `packages/*` and `apps/orchestrator`; typecheck; the package suites.
4. Apply it to `apps/web` (src, tests, route directories via `git mv`); typecheck; web suite; build.
5. Scripts and gates (`scripts/gate-*.mjs`), CI workflow, docker-compose, `.env.example`, README and the three current docs; the vocabulary gate.
6. Closing run (typecheck, suite, build, eight gates); `.env` edited; memory notes updated at the finish; §8 Errata.

Each step is one commit so the history reads as "schema", "packages", "web", "scripts+docs" — a
reviewer can bisect a mistake to a layer.

## 7. Global constraints

- No behaviour change: every test asserts the same thing under the new names; a test that had to change its assertion is a finding.
- No dependency change; the lockfile diff is names only.
- `git mv` for every renamed file (history follows with `-M30%` where a file also changed inside).
- The protected-token list is exhaustive in the codemod, not in a reviewer's head.
- Commit trailers on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UwnbBiQX5Gdm5VKtFvEr9J`.

## 8. Errata — where execution corrected the plan

(empty at approval; filled by the last task)
