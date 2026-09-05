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

1. The `words` phase is three boundary-aware regexes (`Agent`/`agent`/`AGENT`, each with a
   lookahead that keeps `Agents`/`AgentRun`/`agentic`/`reagent` sorted correctly) plus an article
   post-pass (`an slave` → `a slave`, and the ALL-CAPS counterpart), not the spec's "longest-first
   table" — every compound (`AgentRun`, `companyAgentId`, `AGENTS_TAB`, …) falls out of the plain
   `Agent`→`Slave` rule for free, so no compound-specific entries were ever needed.
2. `planMoves` moves file by file, not by topmost differing directory — the plan's directory
   collapsing would have lost a nested rename inside an already-renamed directory (`[agentId]`
   under `api/agents`, `NewAgentDrawer.tsx` under `components/agents`). Fixed in Task 3's review
   round and self-tested (`rename-agent-to-slave.mjs`'s `moveCases`).
3. The dry-run reports (`--report`) are workspace artifacts for review while the codemod runs —
   never committed.
4. The migration renames three unique keys — `AgentTemplate_name_key`, `AgentPermission_agentId_tool_key`,
   `CompanyAgent_companyTeamId_name_key` — with `ALTER INDEX`, not `ALTER TABLE … RENAME CONSTRAINT`:
   `\d` on the live schema showed them as bare `CREATE UNIQUE INDEX`s, never registered in
   `pg_constraint`, so they rename the same way the plain indexes below them do (Task 3's oracle
   step caught this against the real schema, not the plan's assumption).
5. The deny-reason seam is why `scripts/cursor-shell-gate.sh`, `scripts/pause-gate.sh`, and the
   phrase-only edit of `packages/providers/test/fixtures/permission-matrix-deny.ndjson` +
   `README.md` were renamed in Task 3, ahead of this task's `words` pass over the rest of
   `scripts/`: `gate.ts` reads the literal deny-reason text those files carry, so the phrase had to
   move with the schema/package rename or the gate's own assertions would have gone stale between
   tasks.
6. `agent_message` is Cursor's own response-validator field name (its binary's real, external API),
   protected like `cursor-agent` — never ours to rename. Tightened in this task
   (`agent_message(?!_sent)`) because our own `EventType`/`Actor` literal `agent_message_sent` must
   still rename to `slave_message_sent`; Cursor's field is never suffixed, so the two never
   collide. The vocabulary gate's `PROTECTED` regex mirrors the same tightened token. Self-test:
   `'agent_message_sent and agent_message'` → `'slave_message_sent and agent_message'`. The article
   post-pass was extended the same way, for the ALL-CAPS noun the `AGENT`→`SLAVE` word rule can
   produce: `[/\ban SLAVE/g, 'a SLAVE']`, `[/\bAn SLAVE/g, 'A SLAVE']`, self-tested against
   `'an AGENT; An AGENT'` → `'a SLAVE; A SLAVE'`. Self-test count: 21 (19 before this task's two
   additions).
7. `apps/web/src/lib/communicationGraph.ts`'s `agent_message_sent` literal and
   `GraphClient.tsx`'s "an SLAVE" copy were hand-fixed in Task 4, ahead of this task tightening the
   codemod's own protected token and article rules to cover both cases mechanically going forward.
8. `design_handoff_ai_team_os/` and its two `AI Team OS *.dc.html` mockup filenames are not
   renamed — they are handoff deliverables, kept exactly as received, directory name, filenames and
   `agent` vocabulary throughout. Their scope-level text (`AI Team OS` → `Slave of AI`) was already
   hand-renamed in Task 2; that pass missed one bare `"ai-team-os"` occurrence, hand-fixed there.
   Added to `PROTECTED_PATHS` (codemod) and `EXCLUDE` (vocabulary gate) in this task so both stay
   silent on it going forward, matching `docs/superpowers/` and `docs/decisions/`'s treatment.
9. `docs/decisions/0001-pause-semantics.md` still names `AITEAMOS_PAUSE_FLAG` — history, untouched
   (a protected path). `docs/domain-model.md`'s live cross-reference to ADR 0002
   (`docs/decisions/0002-derived-agent-status.md`, also a protected, unrenamed path) was rewritten
   to `…-derived-slave-status.md` by this task's mechanical `words` pass over plain document text —
   a broken link, since no file by that name exists. Hand-fixed back to the real filename, and
   `0002-derived-agent-status` added to both the codemod's `PROTECTED_TOKENS` and the vocabulary
   gate's `PROTECTED` regex, so a live document may cite this historical filename without tripping
   either.
10. `packages/domain/src/docs/superpowers/specs/2026-08-18-m2-persistence-and-events-design.md` is
    a nested historical copy of an early design doc — untouched; it happens to carry zero `agent`
    mentions already, so nothing needed protecting there.
11. `docs/superpowers/fidelity/m14/agents.png` — the tracked screenshot of the old `/agents` page —
    was removed (`git rm`) rather than left stale once `gate:m14-fidelity` started writing
    `slaves.png` for the renamed `/slaves` page; nothing else Step 3's gates exercised needed a
    hand fix.
12. Final review fix wave (2026-09-05, HEAD 9d9e3e4): `ARTICLE_RULES` rewritten from a literal
    `an slave`/`An slave` match to a lookahead with an optional backtick between the article and
    the noun (`/\ban (?=`?(?:[Ss]lave|SLAVE))/g` and its `An` counterpart), so a compound in code
    font (`` `SlavePermission` ``, `` `slaveId` ``, `` `SlaveRun` ``) gets the article fix too, not
    only the bare word. Self-test grew from 22 to 23 cases (one new backtick-compound case). A
    `--phase words` re-run over `packages/`, `apps/`, `scripts/` then caught seven residues the
    tightened rule fixes: `packages/db/prisma/schema.prisma`, `apps/web/src/components/SlavesClient.tsx`,
    `apps/web/src/lib/communicationFold.ts`, `apps/orchestrator/test/integration/review.test.ts`,
    `apps/web/test/integration/server-org.test.ts`, `scripts/capture-matrix-deny.mjs`,
    `scripts/gate-m18-skill-and-teeth.mjs` — plus one residue the rule found beyond the known list:
    `packages/providers/test/helpers/gate-fixture.ts`'s "an `SLAVEOFAI_HOOK_PATH`" (a stale article
    left over from an earlier scope rename, now `a `SLAVEOFAI_HOOK_PATH``, since the lookahead's
    `SLAVE` branch also matches as a literal prefix of the all-caps scope token). The `--phase
    words` run also touched `scripts/gate-m26-vocabulary.mjs`, rewriting its own `git grep` search
    target from `agent` to `slave` — a real behaviour change to the gate's own logic (it exists to
    search for `agent`, not to have `agent` renamed inside it, the same way
    `scripts/rename-agent-to-slave.mjs` protects itself in `PROTECTED_PATHS`); that file's content
    was reverted to `HEAD` before its own hand-edit below, and no functional change resulted from
    the words-phase run touching it. The two mockup files were `git mv`'d to the names the
    handoff's own `README.md` (and `tones.ts`, `globals.css`, `ActivityCard.tsx`, `FilterBar.tsx`,
    `Timeline.tsx`, `ProjectHeader.tsx` and their tests) already cited: `Slave of AI Mockups.dc.html`
    and `Slave of AI Web.dc.html`; the directory keeps its name. The `pump.test.ts:1494` comment
    that misquoted the protected `hook-deny.ndjson` fixture's deny reason as "Paused by Slave of
    AI. Stop and wait." (the fixture, protected, still says "Paused by AI Team OS…") was reworded
    to describe the reason's shape ("a bare pause reason, no matrix prefix") without quoting the
    product name. `packages/providers/test/fixtures/README.md:120-123` and
    `packages/providers/test/fixtures/cursor/gate/README.md:55-109` — prose re-capture recipes, not
    captured vendor output — had their dead `AITEAMOS_CLAUDE_BIN` / `AITEAMOS_CLAUDE_ARGS` /
    `AITEAMOS_GATE_LOG` / `AITEAMOS_PAUSE_FLAG` env names renamed to `SLAVEOFAI_*` by a plain
    `sed` on those two files only; the captured `.ndjson` fixtures stay byte-identical.
    `scripts/gate-m26-vocabulary.mjs` was widened to also guard the scope tokens (`aiteamos`,
    `ai-team-os`, `AITEAMOS_`, `AI Team OS`) alongside bare `agent`, sharing one `PATTERN` constant
    between the `git grep` invocation and the post-`PROTECTED`-strip offender re-check so the
    widening is actually enforced, not merely a wider search that never fails; the `PROTECTED`
    regex and `EXCLUDE` list are unchanged, per the ruling. Running the widened gate surfaced one
    offender this task did not resolve: `packages/domain/src/docs/superpowers/specs/2026-08-18-m2-
    persistence-and-events-design.md`'s live "Parent spec" cross-reference to the real, protected,
    unrenamed filename `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` (entry 10 above
    predates the widening and said this file needed no protecting — true only while the gate
    searched for `agent` alone). This is the same shape as entry 9's ADR-0002 cross-reference, and
    the same fix would apply (add the parent spec's filename to `PROTECTED_TOKENS`/`PROTECTED`) —
    but this task's ruling holds the `PROTECTED` regex unchanged, so the gate is left FAILING on
    this one line pending a controller decision, rather than silently excluded or hand-edited.
    `SCOPE_RULES` gained one more rule, `[/ai-team-os/g, 'slave-of-ai']`, placed after the
    `@ai-team-os/` and `"ai-team-os"` rules so those specific forms still apply first; it catches
    the bare form Task 2 hand-fixed. Self-test gained one `scope`-phase case for it
    (`'x ai-team-os y'` → `'x slave-of-ai y'`).

    **Round 2 (controller ruling on both open concerns):** the parent-spec cross-reference is
    legitimate, same shape as entry 9's ADR-0002 case — the reference line itself was never
    rewritten (confirmed: `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` still exists
    under its real name, and the citing line still names it), so no text restore was needed.
    `/2026-08-17-ai-team-os-design/g` was added to the codemod's `PROTECTED_TOKENS`, and
    `2026-08-17-ai-team-os-design` to the vocabulary gate's `PROTECTED` alternation, right after
    `0002-derived-agent-status` in both files; the gate's `EXCLUDE` list stays as it is.
    `scripts/gate-m26-vocabulary.mjs` was added to the codemod's `PROTECTED_PATHS` — it names the
    word it hunts, so its own source must never be rewritten by a future `--phase words` run over
    `scripts/`, the same reasoning that already protects `rename-agent-to-slave.mjs` itself; it was
    already in the gate's own `EXCLUDE`. No new self-test path/`planMoves` case was needed for the
    `PROTECTED_PATHS` addition, per the ruling. `npm run gate:m26-vocabulary` now PASSes.
