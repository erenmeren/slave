# M2 — Persistence and Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the pure M1 domain core a Postgres home: schema, migrations, seed data, a single-gate event writer, and a LISTEN/NOTIFY subscriber, all verified against a real database.

**Architecture:** `packages/db` owns the Prisma schema, migrations, seed, and the row-to-domain mappers that restore branded ids. `packages/events` owns the only write path to the event log (`appendEvent`) and the subscriber (`subscribeEvents`). Writing goes through Prisma; listening needs a raw long-lived `pg` connection, because Prisma has no facility for a connection that sits outside the pool waiting on notifications. `packages/domain` is not modified — it stays pure.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node 26, npm workspaces, Postgres 17 via Docker Compose, Prisma 7, `pg` 8, vitest 3.2 (two projects: unit and integration), zod 3.

**Spec:** `docs/superpowers/specs/2026-08-18-m2-persistence-and-events-design.md`
(parent: `docs/superpowers/specs/2026-08-17-ai-team-os-design.md`)

## Global Constraints

- TypeScript strict. **No `any` anywhere**, in `src` or `test`.
- **Every exported function carries an explicit return type.** This is load-bearing, not style: `noImplicitReturns` is not set, so exhaustiveness checking (TS2366) depends entirely on explicit return types excluding `undefined`.
- `packages/domain` is **not modified by this plan**. It keeps zod as its only dependency, with no `node:` imports and no framework imports. Any task that feels the need to change it must stop and report instead.
- Postgres host port is **5433**, never 5432.
- The `ExecutionEvent` table has exactly one write path: `appendEvent()`. `packages/db` must not export the raw Prisma client.
- The `EventType` database enum contains exactly the event types present in the Zod union in `packages/domain/src/events/schema.ts` — currently ten. It must never be wider.
- Integration tests run against a real database and **never skip silently**. An unreachable database makes the suite red, not green.
- Conventional commits, with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Every task ends green: `npm test` and `npm run typecheck` both pass before the commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `docker-compose.yml` | Pinned Postgres 17, host port 5433, healthcheck, named volume |
| `docker/initdb/01-create-test-db.sql` | Creates the `aiteamos_test` database on first boot |
| `.env.example` | `DATABASE_URL`, `TEST_DATABASE_URL` templates |
| `vitest.config.ts` | Two projects: `unit` (fast, parallel) and `integration` (serial, DB-required) |
| `test-setup/require-database.ts` | Loads `.env`, fails loudly when the database is unreachable |
| `packages/db/prisma/schema.prisma` | All MVP tables and enums |
| `packages/db/prisma/migrations/` | Committed migration history |
| `packages/db/prisma/seed.ts` | Spec §13.1 organisation, tasks covering all twelve statuses |
| `packages/db/src/client.ts` | The single configured Prisma instance — absorbs the generator's import path |
| `packages/db/src/mappers.ts` | Row-to-domain mappers; the only place branded ids are restored |
| `packages/db/src/index.ts` | Package barrel — exports mappers and types, never the raw client |
| `packages/events/src/subscribe.ts` | `subscribeEvents` — raw `pg` LISTEN with reconnect |
| `packages/events/src/append.ts` | `appendEvent` — the write gate |
| `packages/events/src/read.ts` | `readEventsSince` — catch-up read driven by `seq` |
| `.githooks/pre-push` | Runs typecheck and tests, refuses the push on failure |

---

### Task 1: Environment and the integration test harness

**Files:**
- Create: `docker-compose.yml`, `docker/initdb/01-create-test-db.sql`, `.env.example`
- Create: `test-setup/require-database.ts`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/tsconfig.test.json`, `packages/db/src/index.ts`
- Create: `packages/db/test/integration/connectivity.test.ts`
- Modify: `vitest.config.ts`, `tsconfig.json`, `package.json`, `.gitignore`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the foundation.
- Produces: a working `npm test` with two vitest projects, the `TEST_DATABASE_URL` convention, and the `packages/db` package skeleton every later task builds in.

- [ ] **Step 1: Write the Docker Compose file**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    container_name: aiteamos-postgres
    environment:
      POSTGRES_USER: aiteamos
      POSTGRES_PASSWORD: aiteamos
      POSTGRES_DB: aiteamos
    ports:
      - "5433:5432"
    volumes:
      - aiteamos-pgdata:/var/lib/postgresql/data
      - ./docker/initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aiteamos -d aiteamos"]
      interval: 2s
      timeout: 3s
      retries: 30

volumes:
  aiteamos-pgdata:
```

`docker/initdb/01-create-test-db.sql`:

```sql
CREATE DATABASE aiteamos_test OWNER aiteamos;
```

The init script runs only on an empty volume. If the volume already exists, create the database by hand with:
`docker compose exec postgres psql -U aiteamos -d aiteamos -c 'CREATE DATABASE aiteamos_test OWNER aiteamos'`

- [ ] **Step 2: Write the env template and ignore the real file**

`.env.example`:

```
DATABASE_URL="postgresql://aiteamos:aiteamos@localhost:5433/aiteamos?schema=public"
TEST_DATABASE_URL="postgresql://aiteamos:aiteamos@localhost:5433/aiteamos_test?schema=public"
```

Append to `.gitignore`:

```
.env
```

Then create the working copy: `cp .env.example .env`

- [ ] **Step 3: Bring the database up and verify it is healthy**

Run:
```bash
docker compose up -d
docker compose ps
```
Expected: the `postgres` service reports `healthy`. Paste the real output into the task report.

Confirm both databases exist:
```bash
docker compose exec postgres psql -U aiteamos -c '\l' | grep aiteamos
```
Expected: both `aiteamos` and `aiteamos_test` appear.

- [ ] **Step 4: Install the Postgres driver**

Run: `npm install --save-dev pg @types/pg`

Record the resolved versions in the task report — do not claim a version you did not see in `package.json` afterwards.

- [ ] **Step 5: Write the integration setup file that refuses to skip**

`test-setup/require-database.ts`:

```ts
import { existsSync } from 'node:fs'
import { Client } from 'pg'
import { beforeAll } from 'vitest'

if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

beforeAll(async (): Promise<void> => {
  const url = process.env['TEST_DATABASE_URL']
  if (url === undefined || url === '') {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env — integration tests do not skip.',
    )
  }

  const client = new Client({ connectionString: url })
  try {
    await client.connect()
    await client.query('SELECT 1')
  } catch (cause) {
    throw new Error(
      `Cannot reach the test database at ${url}. Run \`docker compose up -d\` and try again. ` +
        'Integration tests fail rather than skip, so this suite is red until the database is up.',
      { cause },
    )
  } finally {
    await client.end()
  }
})
```

- [ ] **Step 6: Split the vitest configuration into two projects**

Replace `vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/test/integration/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/test/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          setupFiles: ['./test-setup/require-database.ts'],
          fileParallelism: false,
          poolOptions: { threads: { singleThread: true } },
        },
      },
    ],
  },
})
```

`fileParallelism: false` plus `singleThread` is what keeps the integration project serial. Parallel workers would share the `events` NOTIFY channel and receive each other's notifications.

- [ ] **Step 7: Scaffold the `packages/db` package**

`packages/db/package.json`:

```json
{
  "name": "@ai-team-os/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@ai-team-os/domain": "*"
  }
}
```

`packages/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../domain" }]
}
```

`packages/db/tsconfig.test.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "composite": false,
    "declaration": false
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`packages/db/src/index.ts`:

```ts
export const DB_PACKAGE_VERSION = '1'
```

- [ ] **Step 8: Wire the new package into the build and the typecheck**

`tsconfig.json` at the repository root:

```json
{
  "files": [],
  "references": [{ "path": "packages/domain" }, { "path": "packages/db" }]
}
```

In `package.json`, change the `typecheck` script to cover both test configs:

```json
"typecheck": "tsc --build --force && tsc -p packages/domain/tsconfig.test.json && tsc -p packages/db/tsconfig.test.json"
```

Run `npm install` so npm links the new workspace.

- [ ] **Step 9: Write the failing connectivity test**

`packages/db/test/integration/connectivity.test.ts`:

```ts
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('test database', () => {
  let client: Client

  beforeAll(async (): Promise<void> => {
    client = new Client({ connectionString: process.env['TEST_DATABASE_URL'] })
    await client.connect()
  })

  afterAll(async (): Promise<void> => {
    await client.end()
  })

  it('is reachable and reports its name', async () => {
    const result = await client.query<{ current_database: string }>('SELECT current_database()')
    expect(result.rows[0]?.current_database).toBe('aiteamos_test')
  })

  it('supports LISTEN/NOTIFY', async () => {
    const received = new Promise<string>((resolve) => {
      client.on('notification', (message) => resolve(message.payload ?? ''))
    })
    await client.query('LISTEN probe')
    await client.query(`NOTIFY probe, 'hello'`)
    await expect(received).resolves.toBe('hello')
  })
})
```

- [ ] **Step 10: Run the suite with the database DOWN, to prove it goes red**

Run:
```bash
docker compose stop
npm test
```
Expected: the integration project FAILS with the "Cannot reach the test database" message from the setup file. It must not report skipped or passed. Paste the real output — this is the evidence for the no-silent-skip constraint, and it is the one time in this plan you deliberately produce a red suite.

- [ ] **Step 11: Bring the database back up and run the suite green**

Run:
```bash
docker compose up -d
npm test
npm run typecheck
```
Expected: unit project 79 passing, integration project 2 passing, typecheck clean. Paste both real outputs.

- [ ] **Step 12: Commit**

```bash
git add docker-compose.yml docker .env.example .gitignore vitest.config.ts test-setup packages/db tsconfig.json package.json package-lock.json
git commit -m "feat(db): add Postgres compose environment and integration test harness

Integration tests run serially against a real database and fail rather
than skip when it is unreachable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Prisma bootstrap, core enums, and the first tables

**Files:**
- Create: `packages/db/prisma/schema.prisma`, `packages/db/prisma/migrations/**`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/test/integration/workspace.test.ts`
- Modify: `packages/db/package.json`, `.gitignore`

**Interfaces:**
- Consumes: the package skeleton and `TEST_DATABASE_URL` convention from Task 1.
- Produces: `prisma` — the single configured client instance exported from `packages/db/src/client.ts`, used by every later task. Also produces the `TaskStatus`, `RunStatus` and `Actor` enums and the `Workspace`, `Team`, `Agent` tables.

- [ ] **Step 1: Install Prisma and initialise the schema**

Run:
```bash
npm install --save-dev prisma --workspace @ai-team-os/db
npm install @prisma/client --workspace @ai-team-os/db
cd packages/db && npx prisma init --datasource-provider postgresql --output ../src/generated && cd ../..
```

**Keep whatever `generator` block `prisma init` writes.** Prisma's generator names and ESM output changed across major versions, and the installed version is the authority — not this plan. Record the exact generator block and the resolved Prisma version in the task report.

Delete the `.env` that `prisma init` creates inside `packages/db` if it makes one; the repository has a single root `.env`.

Add the generated client directory to `.gitignore`:

```
packages/db/src/generated/
```

- [ ] **Step 2: Write the schema's datasource, enums, and first three models**

`packages/db/prisma/schema.prisma` — keep the generator block from Step 1 and set the rest to:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum TaskStatus {
  backlog
  ready
  blocked
  assigned
  running
  verifying
  reviewing
  merging
  rework
  done
  failed
  cancelled
}

enum RunStatus {
  starting
  working
  pause_requested
  paused
  resuming
  stopping
  stopped
  succeeded
  failed
}

enum Actor {
  human
  agent
  system
}

model Workspace {
  id            String   @id @default(uuid())
  name          String
  repoPath      String
  baseBranch    String   @default("main")
  verifyCommand String
  autoMerge     Boolean  @default(false)

  maxConcurrentRuns       Int   @default(3)
  budgetUsd               Float @default(20)
  runTimeoutMs            Int   @default(1800000)
  maxToolCallsPerRun      Int   @default(200)
  maxAttempts             Int   @default(3)
  consecutiveFailureLimit Int   @default(3)

  createdAt DateTime @default(now())

  teams Team[]
}

model Team {
  id          String @id @default(uuid())
  workspaceId String
  name        String

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  agents    Agent[]

  @@index([workspaceId])
}

model Agent {
  id           String  @id @default(uuid())
  teamId       String
  name         String
  role         String
  requiredRole String?

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@index([teamId])
}
```

The six guardrail columns on `Workspace` are the exact field names and seeded defaults from `DEFAULT_GUARDRAIL_LIMITS` in `packages/domain/src/guardrails/evaluate.ts`. `maxAttempts` here is the one `Task.maxAttempts` will be copied from in Task 8.

- [ ] **Step 3: Create and apply the first migration**

Run:
```bash
npx prisma migrate dev --name init --schema packages/db/prisma/schema.prisma
```

Expected: a migration directory appears under `packages/db/prisma/migrations/` and applies cleanly. Paste the real output.

- [ ] **Step 4: Write the single client module**

`packages/db/src/client.ts`:

```ts
import { PrismaClient } from './generated/client.js'

/**
 * The one configured Prisma instance. Every consumer imports from here, so the
 * generated client's import path — which differs between Prisma major versions —
 * is absorbed in exactly one file.
 */
export const prisma: PrismaClient = new PrismaClient()

export type { PrismaClient }
```

If the generated client's entry point is not `./generated/client.js`, correct the import here and **only** here, and record the working path in the task report. This file exists so that no later task has to know the answer.

`packages/db/src/index.ts` must NOT re-export `prisma` — the global constraint forbids exposing the raw client. Leave `index.ts` as it is for now.

- [ ] **Step 5: Write the failing round-trip test**

`packages/db/test/integration/workspace.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

describe('workspace persistence', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('round-trips a workspace with its guardrail defaults', async () => {
    const created = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommand: 'npm test' },
    })

    const found = await prisma.workspace.findUniqueOrThrow({ where: { id: created.id } })

    expect(found.name).toBe('Checkout Platform')
    expect(found.baseBranch).toBe('main')
    expect(found.maxConcurrentRuns).toBe(3)
    expect(found.maxAttempts).toBe(3)
    expect(found.budgetUsd).toBe(20)
  })

  it('cascades team and agent deletion from the workspace', async () => {
    const workspace = await prisma.workspace.create({
      data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommand: 'npm test' },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })

    await prisma.workspace.delete({ where: { id: workspace.id } })

    expect(await prisma.agent.count()).toBe(0)
    expect(await prisma.team.count()).toBe(0)
  })
})
```

- [ ] **Step 6: Point migrations and tests at the right database**

Prisma reads `DATABASE_URL`. Development uses the `aiteamos` database; the test run must use
`aiteamos_test`. Two small pieces settle this for the whole plan.

Create `scripts/migrate-test.mjs`:

```js
import { execSync } from 'node:child_process'

process.loadEnvFile('.env')

const url = process.env.TEST_DATABASE_URL
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env.')
}

execSync('npx prisma migrate deploy --schema packages/db/prisma/schema.prisma', {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
})
```

Add both scripts to the root `package.json`:

```json
"db:migrate": "prisma migrate deploy --schema packages/db/prisma/schema.prisma",
"db:migrate:test": "node scripts/migrate-test.mjs"
```

Then bind the test run to the test database in `test-setup/require-database.ts`, immediately after
the `process.loadEnvFile('.env')` block:

```ts
process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL']
```

This is the single point where the integration run is bound to the test database. Every later
integration test inherits it, and no test file sets a connection string of its own.

- [ ] **Step 7: Run the migration against the test database, then run the tests**

Run:
```bash
npm run db:migrate:test
npm test
```
Expected: the workspace tests pass. Paste the real output including the test counts.

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: clean, exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/db package.json package-lock.json test-setup .gitignore
git commit -m "feat(db): add Prisma bootstrap, domain enums, and workspace tables

Enum values mirror the TaskStatus, RunStatus and Actor unions in
packages/domain exactly. The generated client is reached only through
src/client.ts so the generator's import path lives in one file.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Agent capability tables

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/**` (generated)
- Create: `packages/db/test/integration/capabilities.test.ts`

**Interfaces:**
- Consumes: `prisma` from `packages/db/src/client.ts` (Task 2), and the `Agent`/`Workspace` models.
- Produces: `AgentPermission`, `Skill`, `SkillProvider`, `AgentSkill`, `ProviderConfiguration` models and the `PermissionMode`, `ProviderKind` enums.

- [ ] **Step 1: Write the failing test**

`packages/db/test/integration/capabilities.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedAgent(): Promise<{ workspaceId: string; agentId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommand: 'npm test' },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  return { workspaceId: workspace.id, agentId: agent.id }
}

describe('agent capabilities', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AgentSkill", "Skill", "SkillProvider", "AgentPermission", "ProviderConfiguration", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('rejects two permissions for the same agent and tool', async () => {
    const { agentId } = await seedAgent()
    await prisma.agentPermission.create({ data: { agentId, tool: 'Bash', mode: 'allow' } })

    await expect(
      prisma.agentPermission.create({ data: { agentId, tool: 'Bash', mode: 'deny' } }),
    ).rejects.toThrow()
  })

  it('links an agent to skills through the join table', async () => {
    const { agentId } = await seedAgent()
    const provider = await prisma.skillProvider.create({ data: { name: 'superpowers' } })
    const skill = await prisma.skill.create({
      data: { providerId: provider.id, name: 'test-driven-development', description: 'TDD' },
    })
    await prisma.agentSkill.create({ data: { agentId, skillId: skill.id } })

    const found = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      include: { skills: { include: { skill: true } } },
    })

    expect(found.skills.map((link) => link.skill.name)).toEqual(['test-driven-development'])
  })

  it('allows one configuration per provider kind per workspace', async () => {
    const { workspaceId } = await seedAgent()
    await prisma.providerConfiguration.create({
      data: { workspaceId, kind: 'claude_code', settings: { permissionMode: 'bypassPermissions' } },
    })

    await expect(
      prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --project integration`
Expected: FAIL — `prisma.agentPermission` is undefined, because the models do not exist yet.

- [ ] **Step 3: Add the models to the schema**

Append to `packages/db/prisma/schema.prisma`:

```prisma
enum PermissionMode {
  allow
  deny
}

enum ProviderKind {
  claude_code
  cursor
}

model AgentPermission {
  id      String         @id @default(uuid())
  agentId String
  tool    String
  mode    PermissionMode

  agent Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@unique([agentId, tool])
}

model SkillProvider {
  id     String  @id @default(uuid())
  name   String  @unique
  skills Skill[]
}

model Skill {
  id          String @id @default(uuid())
  providerId  String
  name        String
  description String

  provider SkillProvider @relation(fields: [providerId], references: [id], onDelete: Cascade)
  agents   AgentSkill[]

  @@unique([providerId, name])
}

model AgentSkill {
  agentId String
  skillId String

  agent Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)
  skill Skill @relation(fields: [skillId], references: [id], onDelete: Cascade)

  @@id([agentId, skillId])
}

model ProviderConfiguration {
  id          String       @id @default(uuid())
  workspaceId String
  kind        ProviderKind
  settings    Json

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, kind])
}
```

Add the back-relations to the existing models:

- In `model Workspace`, add: `providerConfigurations ProviderConfiguration[]`
- In `model Agent`, add: `permissions AgentPermission[]` and `skills AgentSkill[]`

`AgentPermission` exists from M2 because ADR 0001 records per-agent tool allow-lists as a hard M3 requirement — the schema is ready before the adapter needs it.

- [ ] **Step 4: Migrate and run the tests green**

Run:
```bash
npx prisma migrate dev --name capabilities --schema packages/db/prisma/schema.prisma
npm run db:migrate:test
npm test
npm run typecheck
```
Expected: all three capability tests pass, typecheck clean. Paste the real counts.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): add agent permission, skill, and provider configuration tables

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Work tables — tasks, runs, artifacts, messages, approvals

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/**` (generated)
- Create: `packages/db/test/integration/work.test.ts`

**Interfaces:**
- Consumes: `prisma`, plus the `TaskStatus` and `RunStatus` enums from Task 2.
- Produces: `Task`, `TaskDependency`, `AgentRun`, `Artifact`, `AgentMessage`, `Approval` models and the `RunKind`, `PauseReason`, `MessageCategory` enums.

**One deliberate design point:** `Task.maxAttempts` has **no default**. M1's final review found `TaskState.maxAttempts` and `DEFAULT_GUARDRAIL_LIMITS.maxAttempts` to be two unlinked numbers. Omitting the default makes the column impossible to populate by accident: every task creation must supply a value, and the only sensible source is the workspace's guardrail configuration. The seed in Task 8 performs that copy.

- [ ] **Step 1: Write the failing test**

`packages/db/test/integration/work.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

async function seedWorkspace(): Promise<{ workspaceId: string; agentId: string; maxAttempts: number }> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout', verifyCommand: 'npm test' },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'Backend' } })
  return { workspaceId: workspace.id, agentId: agent.id, maxAttempts: workspace.maxAttempts }
}

describe('work tables', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Approval", "AgentMessage", "Artifact", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('defaults a new task to backlog and carries maxAttempts from the workspace', async () => {
    const { workspaceId, maxAttempts } = await seedWorkspace()

    const task = await prisma.task.create({
      data: { workspaceId, title: 'Add checkout retry', description: 'Retry failed payments', maxAttempts },
    })

    expect(task.status).toBe('backlog')
    expect(task.attempt).toBe(0)
    expect(task.maxAttempts).toBe(3)
  })

  it('refuses a task row with no maxAttempts', async () => {
    const { workspaceId } = await seedWorkspace()

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Task" (id, "workspaceId", title, description) VALUES (gen_random_uuid(), '${workspaceId}', 't', 'd')`,
      ),
    ).rejects.toThrow()
  })

  it('defaults a run to implementation kind with no pause reason', async () => {
    const { workspaceId, agentId, maxAttempts } = await seedWorkspace()
    const task = await prisma.task.create({
      data: { workspaceId, title: 't', description: 'd', maxAttempts },
    })

    const run = await prisma.agentRun.create({ data: { taskId: task.id, agentId } })

    expect(run.kind).toBe('implementation')
    expect(run.status).toBe('starting')
    expect(run.pauseReason).toBeNull()
    expect(run.toolCalls).toBe(0)
  })

  it('stores a review run alongside an implementation run for the same task', async () => {
    const { workspaceId, agentId, maxAttempts } = await seedWorkspace()
    const task = await prisma.task.create({
      data: { workspaceId, title: 't', description: 'd', maxAttempts },
    })

    await prisma.agentRun.create({ data: { taskId: task.id, agentId, kind: 'implementation' } })
    await prisma.agentRun.create({ data: { taskId: task.id, agentId, kind: 'review' } })

    const kinds = await prisma.agentRun.findMany({ where: { taskId: task.id }, select: { kind: true } })
    expect(kinds.map((r) => r.kind).sort()).toEqual(['implementation', 'review'])
  })

  it('records a dependency between two tasks', async () => {
    const { workspaceId, maxAttempts } = await seedWorkspace()
    const first = await prisma.task.create({
      data: { workspaceId, title: 'schema', description: 'd', maxAttempts },
    })
    const second = await prisma.task.create({
      data: { workspaceId, title: 'api', description: 'd', maxAttempts },
    })

    await prisma.taskDependency.create({ data: { taskId: second.id, dependsOnTaskId: first.id } })

    const found = await prisma.taskDependency.findMany({ where: { taskId: second.id } })
    expect(found[0]?.dependsOnTaskId).toBe(first.id)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --project integration`
Expected: FAIL — `prisma.task` is undefined.

- [ ] **Step 3: Add the models to the schema**

Append to `packages/db/prisma/schema.prisma`:

```prisma
enum RunKind {
  implementation
  review
  planning
}

enum PauseReason {
  human
  guardrail
  emergency_stop
}

enum MessageCategory {
  instruction
  feedback
  context
  priority_change
  question_response
}

model Task {
  id                  String     @id @default(uuid())
  workspaceId         String
  title               String
  description         String
  status              TaskStatus @default(backlog)
  priority            Int        @default(0)
  requiredRole        String?
  assigneeId          String?
  activeRunId         String?    @unique
  attempt             Int        @default(0)
  maxAttempts         Int
  lastRejectionReason String?
  branch              String?
  createdBy           Actor      @default(human)
  createdAt           DateTime   @default(now())
  enqueuedAt          DateTime?

  workspace    Workspace        @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  runs         AgentRun[]
  artifacts    Artifact[]
  messages     AgentMessage[]
  approvals    Approval[]
  dependencies TaskDependency[] @relation("dependent")
  dependents   TaskDependency[] @relation("dependedOn")

  @@index([workspaceId, status])
}

model TaskDependency {
  taskId          String
  dependsOnTaskId String

  task      Task @relation("dependent", fields: [taskId], references: [id], onDelete: Cascade)
  dependsOn Task @relation("dependedOn", fields: [dependsOnTaskId], references: [id], onDelete: Cascade)

  @@id([taskId, dependsOnTaskId])
}

model AgentRun {
  id           String       @id @default(uuid())
  taskId       String
  agentId      String
  kind         RunKind      @default(implementation)
  status       RunStatus    @default(starting)
  sessionId    String?
  toolCalls    Int          @default(0)
  pausedAtStep Int?
  pauseReason  PauseReason?
  costUsd      Float        @default(0)
  startedAt    DateTime     @default(now())
  endedAt      DateTime?

  task  Task  @relation(fields: [taskId], references: [id], onDelete: Cascade)
  agent Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@index([taskId])
  @@index([agentId, status])
}

model Artifact {
  id        String   @id @default(uuid())
  taskId    String
  kind      String
  path      String
  createdAt DateTime @default(now())

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([taskId])
}

model AgentMessage {
  id        String          @id @default(uuid())
  taskId    String?
  agentId   String
  category  MessageCategory
  body      String
  actor     Actor           @default(human)
  createdAt DateTime        @default(now())

  task  Task? @relation(fields: [taskId], references: [id], onDelete: Cascade)
  agent Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@index([agentId, createdAt])
}

model Approval {
  id        String   @id @default(uuid())
  taskId    String
  approved  Boolean
  reason    String?
  decidedAt DateTime @default(now())

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([taskId])
}
```

Add the back-relations to the existing models:

- In `model Workspace`, add: `tasks Task[]`
- In `model Agent`, add: `runs AgentRun[]` and `messages AgentMessage[]`

`MessageCategory`'s five values are exactly the `category` enum in the `agent.message_sent` payload in `packages/domain/src/events/schema.ts`.

- [ ] **Step 4: Migrate and run the tests green**

Run:
```bash
npx prisma migrate dev --name work-tables --schema packages/db/prisma/schema.prisma
npm run db:migrate:test
npm test
npm run typecheck
```
Expected: all five work-table tests pass. Paste the real counts.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): add task, run, artifact, message, and approval tables

AgentRun.kind and AgentRun.pauseReason exist so M8 can model QA review
runs and guardrail-initiated pauses without migrating populated tables.
Task.maxAttempts has no default so it can only come from the workspace
guardrail configuration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The event log table

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/**` (generated)
- Create: `packages/db/test/integration/event-log.test.ts`

**Interfaces:**
- Consumes: `prisma`, and the `Actor` enum from Task 2.
- Produces: the `ExecutionEvent` model and the `EventType` enum whose ten values map to the dotted strings used by the domain union.

**Why the enum values are mapped:** the domain's event types are dotted (`task.created`), and Prisma enum members must be identifiers. `@map` keeps the identifier legal in Prisma while storing the exact dotted string the domain uses, so the database column and `packages/domain` never disagree about a value's spelling.

- [ ] **Step 1: Write the failing test**

`packages/db/test/integration/event-log.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

describe('execution event log', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('assigns a monotonic seq and a default timestamp', async () => {
    const first = await prisma.executionEvent.create({
      data: { type: 'task_created', workspaceId: 'w1', actor: 'system', payload: { title: 'a' } },
    })
    const second = await prisma.executionEvent.create({
      data: { type: 'task_created', workspaceId: 'w1', actor: 'system', payload: { title: 'b' } },
    })

    expect(second.seq > first.seq).toBe(true)
    expect(first.ts).toBeInstanceOf(Date)
  })

  it('stores the dotted domain spelling in the column, not the Prisma identifier', async () => {
    await prisma.executionEvent.create({
      data: { type: 'run_tool_call', workspaceId: 'w1', actor: 'agent', payload: { name: 'Bash', summary: 'ls' } },
    })

    const rows = await prisma.$queryRawUnsafe<{ type: string }[]>('SELECT type::text AS type FROM "ExecutionEvent"')
    expect(rows[0]?.type).toBe('run.tool_call')
  })

  it('round-trips a JSON payload', async () => {
    const created = await prisma.executionEvent.create({
      data: {
        type: 'agent_message_sent',
        workspaceId: 'w1',
        agentId: 'a1',
        actor: 'human',
        payload: { category: 'instruction', body: 'use the retry helper' },
      },
    })

    const found = await prisma.executionEvent.findUniqueOrThrow({ where: { seq: created.seq } })
    expect(found.payload).toEqual({ category: 'instruction', body: 'use the retry helper' })
    expect(found.agentId).toBe('a1')
    expect(found.taskId).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --project integration`
Expected: FAIL — `prisma.executionEvent` is undefined.

- [ ] **Step 3: Add the enum and model**

Append to `packages/db/prisma/schema.prisma`:

```prisma
enum EventType {
  task_created       @map("task.created")
  task_started       @map("task.started")
  task_done          @map("task.done")
  task_rework        @map("task.rework")
  run_started        @map("run.started")
  run_tool_call      @map("run.tool_call")
  run_paused         @map("run.paused")
  run_resumed        @map("run.resumed")
  agent_message_sent @map("agent.message_sent")
  guardrail_tripped  @map("guardrail.tripped")
}

model ExecutionEvent {
  seq         BigInt    @id @default(autoincrement())
  ts          DateTime  @default(now())
  type        EventType
  workspaceId String
  taskId      String?
  agentId     String?
  runId       String?
  actor       Actor
  payload     Json

  @@index([workspaceId, seq])
}
```

`ExecutionEvent` intentionally has **no foreign keys**. The log outlives the rows it describes: a
cancelled task may be deleted while its history must remain readable. This is also why `taskId`,
`agentId` and `runId` are plain nullable strings rather than relations.

Exactly these ten values exist because they are exactly the ten members of the Zod union in
`packages/domain/src/events/schema.ts`. Adding an eleventh here without a matching union member
would let a row be written that `parseExecutionEvent` rejects — permanently, since the log is
append-only.

- [ ] **Step 4: Migrate and run the tests green**

Run:
```bash
npx prisma migrate dev --name event-log --schema packages/db/prisma/schema.prisma
npm run db:migrate:test
npm test
npm run typecheck
```
Expected: all three event-log tests pass. Paste the real counts.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): add append-only execution event log

EventType values are mapped to the dotted spellings used by the domain
union, so the column and packages/domain cannot disagree. The table has
no foreign keys: history outlives the rows it describes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Enum parity, enforced in both directions

**Files:**
- Create: `packages/db/src/enums.ts`
- Create: `packages/db/test/integration/enum-parity.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `TaskStatus`, `RunStatus` from `@ai-team-os/domain`; `ExecutionEvent` from the same; `prisma` from Task 2.
- Produces: `EVENT_TYPE_BY_DOMAIN_TYPE` — the exhaustive map from a domain event type to its Prisma enum member, used by `appendEvent` in Task 10, and `DOMAIN_EVENT_TYPE_BY_DB_VALUE` for the reverse direction used by the mappers in Task 7.

**Why this task exists:** Prisma does not derive enums from TypeScript, so the two lists are maintained by hand and will drift. Parity is enforced twice, deliberately:

- **At compile time**, `satisfies Record<ExecutionEvent['type'], ...>` fails to build the moment the Zod union gains a member the map does not cover.
- **At run time**, a test compares the database's actual enum values against the domain's unions by full enumeration, catching the opposite drift: a value in the database that the domain does not know.

- [ ] **Step 1: Write the exhaustive map**

`packages/db/src/enums.ts`:

```ts
import type { ExecutionEvent } from '@ai-team-os/domain'

export type DomainEventType = ExecutionEvent['type']

/**
 * Domain event type to the value stored in the database. The `satisfies` clause is
 * load-bearing: adding a member to the Zod union without adding it here fails the build.
 */
export const EVENT_TYPE_BY_DOMAIN_TYPE = {
  'task.created': 'task_created',
  'task.started': 'task_started',
  'task.done': 'task_done',
  'task.rework': 'task_rework',
  'run.started': 'run_started',
  'run.tool_call': 'run_tool_call',
  'run.paused': 'run_paused',
  'run.resumed': 'run_resumed',
  'agent.message_sent': 'agent_message_sent',
  'guardrail.tripped': 'guardrail_tripped',
} as const satisfies Record<DomainEventType, string>

export type DbEventType = (typeof EVENT_TYPE_BY_DOMAIN_TYPE)[DomainEventType]

export const DOMAIN_EVENT_TYPE_BY_DB_VALUE: Readonly<Record<string, DomainEventType>> =
  Object.fromEntries(
    Object.entries(EVENT_TYPE_BY_DOMAIN_TYPE).map(([domain, db]) => [db, domain as DomainEventType]),
  )

/** Every TaskStatus, as data. The parity test proves this list is complete. */
export const TASK_STATUSES = [
  'backlog',
  'ready',
  'blocked',
  'assigned',
  'running',
  'verifying',
  'reviewing',
  'merging',
  'rework',
  'done',
  'failed',
  'cancelled',
] as const

/** Every RunStatus, as data. */
export const RUN_STATUSES = [
  'starting',
  'working',
  'pause_requested',
  'paused',
  'resuming',
  'stopping',
  'stopped',
  'succeeded',
  'failed',
] as const

export const ACTORS = ['human', 'agent', 'system'] as const
```

Add to `packages/db/src/index.ts`:

```ts
export * from './enums.js'
```

- [ ] **Step 2: Add the compile-time completeness assertions**

Extend the import at the top of `packages/db/src/enums.ts` so it reads:

```ts
import type { ExecutionEvent, RunStatus, TaskStatus } from '@ai-team-os/domain'
```

Then append to the same file:

```ts
/**
 * Compile-time proof that the lists above are neither short nor long.
 * `Exclude<A, B>` is `never` only when every member of A appears in B.
 */
type _TaskStatusesComplete = Exclude<TaskStatus, (typeof TASK_STATUSES)[number]>
type _TaskStatusesSound = Exclude<(typeof TASK_STATUSES)[number], TaskStatus>
type _RunStatusesComplete = Exclude<RunStatus, (typeof RUN_STATUSES)[number]>
type _RunStatusesSound = Exclude<(typeof RUN_STATUSES)[number], RunStatus>

const _assertTaskComplete: _TaskStatusesComplete[] = []
const _assertTaskSound: _TaskStatusesSound[] = []
const _assertRunComplete: _RunStatusesComplete[] = []
const _assertRunSound: _RunStatusesSound[] = []
void _assertTaskComplete
void _assertTaskSound
void _assertRunComplete
void _assertRunSound
```

- [ ] **Step 3: Prove the compile-time assertion is load-bearing**

Temporarily delete `'cancelled'` from `TASK_STATUSES` and run `npm run typecheck`.

Expected: a type error, because `_TaskStatusesComplete` is no longer `never` and `'cancelled'[]`
cannot be assigned an empty array of `never`. Paste the real error, then restore the value and
confirm typecheck is clean again.

A compile-time assertion nobody has seen fail is decoration. This step is what makes it evidence.

- [ ] **Step 4: Write the runtime parity test**

`packages/db/test/integration/enum-parity.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'
import { ACTORS, EVENT_TYPE_BY_DOMAIN_TYPE, RUN_STATUSES, TASK_STATUSES } from '../../src/enums.js'

async function enumValues(name: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
    `SELECT unnest(enum_range(NULL::"${name}"))::text AS value`,
  )
  return rows.map((row) => row.value).sort()
}

describe('database enums match the domain unions', () => {
  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('TaskStatus matches, member for member', async () => {
    expect(await enumValues('TaskStatus')).toEqual([...TASK_STATUSES].sort())
  })

  it('RunStatus matches, member for member', async () => {
    expect(await enumValues('RunStatus')).toEqual([...RUN_STATUSES].sort())
  })

  it('Actor matches, member for member', async () => {
    expect(await enumValues('Actor')).toEqual([...ACTORS].sort())
  })

  it('EventType is exactly the domain union, never wider', async () => {
    const domainTypes = Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).sort()
    expect(await enumValues('EventType')).toEqual(domainTypes)
  })
})
```

The `EventType` assertion is the one that matters most: it fails if the database enum grows a
value the Zod union cannot parse, which would poison the append-only log permanently.

- [ ] **Step 5: Run the tests green**

Run:
```bash
npm test
npm run typecheck
```
Expected: four parity tests pass, typecheck clean. Paste the real counts.

- [ ] **Step 6: Prove the runtime test is load-bearing**

Add a temporary eleventh value to the `EventType` enum in the schema, run
`npx prisma migrate dev --name temp-parity-probe --schema packages/db/prisma/schema.prisma` and
`npm run db:migrate:test`, then run the integration project.

Expected: the `EventType is exactly the domain union` test FAILS. Paste the real failure.

Then revert: delete the temporary value from the schema, delete the probe migration directory,
reset both databases with
`npx prisma migrate reset --force --schema packages/db/prisma/schema.prisma` followed by
`npm run db:migrate:test`, and confirm the suite is green and `git status` shows no stray
migration.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "test(db): enforce enum parity with the domain unions

Compile-time exhaustiveness on the event type map plus a runtime full
enumeration of every database enum. Both were verified by mutation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Row-to-domain mappers — where branded ids come back

**Files:**
- Create: `packages/db/src/mappers.ts`
- Create: `packages/db/test/mappers.test.ts` (unit project — no database)
- Modify: `packages/db/src/client.ts`, `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `EVENT_TYPE_BY_DOMAIN_TYPE`, `DOMAIN_EVENT_TYPE_BY_DB_VALUE` from Task 6; `parseExecutionEvent`, `taskId`, `agentId`, `runId`, `ok`, `err` from `@ai-team-os/domain`.
- Produces: `toTaskState(row)`, `toRunState(row)`, `toExecutionEvent(row)` — used by Task 10 and by every future consumer that needs domain types rather than rows.

M1's final review recorded that ids stop at the event boundary: `ExecutionEvent.taskId` is
`string | undefined`, so consumers would cast. This file is the one place the brands come back,
and it is a pure module — it imports the generated client's **types only**, never its runtime, so
these tests run in the fast unit project with no database.

- [ ] **Step 1: Re-export the row types from the client module**

Append to `packages/db/src/client.ts`:

```ts
export type {
  AgentRun as AgentRunRow,
  ExecutionEvent as ExecutionEventRow,
  Task as TaskRow,
} from './generated/client.js'
```

Row *types* may be exported freely. The global constraint forbids exporting the client *instance*
from the package barrel, because that would be a second write path to the event log.

- [ ] **Step 2: Write the failing tests**

`packages/db/test/mappers.test.ts`:

```ts
import type { AgentId } from '@ai-team-os/domain'
import { describe, expect, it } from 'vitest'
import type { AgentRunRow, ExecutionEventRow, TaskRow } from '../src/client.js'
import { toExecutionEvent, toRunState, toTaskState } from '../src/mappers.js'

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    workspaceId: 'w1',
    title: 't',
    description: 'd',
    status: 'ready',
    priority: 0,
    requiredRole: null,
    assigneeId: 'agent-1',
    activeRunId: null,
    attempt: 1,
    maxAttempts: 3,
    lastRejectionReason: null,
    branch: null,
    createdBy: 'human',
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
    enqueuedAt: null,
    ...overrides,
  } as TaskRow
}

function eventRow(overrides: Partial<ExecutionEventRow> = {}): ExecutionEventRow {
  return {
    seq: 42n,
    ts: new Date('2026-08-18T12:34:56.000Z'),
    type: 'task_created',
    workspaceId: 'w1',
    taskId: 'task-1',
    agentId: null,
    runId: null,
    actor: 'system',
    payload: { title: 'Add checkout retry' },
    ...overrides,
  } as ExecutionEventRow
}

describe('toTaskState', () => {
  it('brands the assignee id', () => {
    const state = toTaskState(taskRow())
    const assignee: AgentId | null = state.assigneeId
    expect(assignee).toBe('agent-1')
  })

  it('carries the attempt counters through unchanged', () => {
    const state = toTaskState(taskRow({ attempt: 2, maxAttempts: 3 }))
    expect(state.attempt).toBe(2)
    expect(state.maxAttempts).toBe(3)
  })

  it('maps a null assignee to null rather than a branded empty string', () => {
    expect(toTaskState(taskRow({ assigneeId: null })).assigneeId).toBeNull()
  })
})

describe('toRunState', () => {
  it('reads status, tool calls, session and pause step from the row', () => {
    const row = {
      id: 'run-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      kind: 'implementation',
      status: 'paused',
      sessionId: 'sess-9',
      toolCalls: 7,
      pausedAtStep: 3,
      pauseReason: 'human',
      costUsd: 0.12,
      startedAt: new Date(),
      endedAt: null,
    } as AgentRunRow

    expect(toRunState(row)).toEqual({
      status: 'paused',
      toolCalls: 7,
      sessionId: 'sess-9',
      pausedAtStep: 3,
    })
  })
})

describe('toExecutionEvent', () => {
  it('converts seq to a number and ts to an ISO string', () => {
    const result = toExecutionEvent(eventRow())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.seq).toBe(42)
    expect(result.value.ts).toBe('2026-08-18T12:34:56.000Z')
  })

  it('translates the database event type back to the dotted domain spelling', () => {
    const result = toExecutionEvent(eventRow({ type: 'run_tool_call', payload: { name: 'Bash', summary: 'ls' } }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.type).toBe('run.tool_call')
  })

  it('returns an error for a payload the domain union rejects', () => {
    const result = toExecutionEvent(eventRow({ payload: { wrong: true } }))
    expect(result.ok).toBe(false)
  })

  it('returns an error for a database event type the domain does not know', () => {
    const result = toExecutionEvent(eventRow({ type: 'not_a_real_type' as ExecutionEventRow['type'] }))
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm test -- --project unit`
Expected: FAIL — `../src/mappers.js` does not exist.

- [ ] **Step 4: Write the mappers**

`packages/db/src/mappers.ts`:

```ts
import {
  agentId,
  err,
  ok,
  parseExecutionEvent,
  runId,
  taskId,
  type ExecutionEvent,
  type Result,
  type RunState,
  type TaskState,
} from '@ai-team-os/domain'
import type { AgentRunRow, ExecutionEventRow, TaskRow } from './client.js'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from './enums.js'

export function toTaskState(row: TaskRow): TaskState {
  return {
    status: row.status,
    assigneeId: row.assigneeId === null ? null : agentId(row.assigneeId),
    activeRunId: row.activeRunId === null ? null : runId(row.activeRunId),
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    lastRejectionReason: row.lastRejectionReason,
  }
}

export function toRunState(row: AgentRunRow): RunState {
  return {
    status: row.status,
    toolCalls: row.toolCalls,
    sessionId: row.sessionId,
    pausedAtStep: row.pausedAtStep,
  }
}

/**
 * Converts a stored row to the domain event. `seq` is a database bigint; it is narrowed to a
 * JavaScript number here, which is exact below 2^53. That ceiling is nine quadrillion events and
 * is recorded in the M2 design spec §5.3 — this function is the single place to revisit it.
 */
export function toExecutionEvent(row: ExecutionEventRow): Result<ExecutionEvent, string> {
  const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type]
  if (domainType === undefined) {
    return err(`unknown event type in the log: ${String(row.type)}`)
  }

  const candidate = {
    seq: Number(row.seq),
    ts: row.ts.toISOString(),
    type: domainType,
    workspaceId: row.workspaceId,
    ...(row.taskId === null ? {} : { taskId: taskId(row.taskId) }),
    ...(row.agentId === null ? {} : { agentId: agentId(row.agentId) }),
    ...(row.runId === null ? {} : { runId: runId(row.runId) }),
    actor: row.actor,
    payload: row.payload,
  }

  const parsed = parseExecutionEvent(candidate)
  return parsed.ok ? ok(parsed.value) : err(parsed.error)
}
```

The spread-or-omit form on the optional ids is required by `exactOptionalPropertyTypes` — under
that flag an explicit `undefined` is not the same as an absent property, and the Zod envelope
marks these fields optional rather than nullable.

- [ ] **Step 5: Export the mappers and run the tests green**

Add to `packages/db/src/index.ts`:

```ts
export * from './mappers.js'
```

Run:
```bash
npm test
npm run typecheck
```
Expected: the ten mapper tests pass in the unit project; everything else stays green. Paste real counts.

- [ ] **Step 6: Prove the branding assertion is load-bearing**

Temporarily change `toTaskState` to return `row.assigneeId` unbranded and run `npm run typecheck`.

Expected: a type error at the `const assignee: AgentId | null` line in the test. Paste it, then
restore. Without this step the branding claim rests on the mapper's own source, which is exactly
what a mutation is supposed to test.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): add row-to-domain mappers that restore branded ids

Pure module: it imports the generated client's types only, so the mapper
tests run in the fast unit project with no database.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Seed data

**Files:**
- Create: `packages/db/src/seed.ts`, `scripts/seed-test.mjs`
- Create: `packages/db/test/integration/seed.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `prisma` from Task 2 and every model from Tasks 2-4.
- Produces: `seed()` — an idempotent, exported function, so the test calls it directly rather than shelling out.

- [ ] **Step 1: Write the failing test**

`packages/db/test/integration/seed.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'
import { TASK_STATUSES } from '../../src/enums.js'
import { seed } from '../../src/seed.js'

describe('seed data', () => {
  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('creates the Atlas organisation', async () => {
    await seed()

    const teams = await prisma.team.findMany({ include: { agents: true }, orderBy: { name: 'asc' } })
    expect(teams.map((t) => t.name)).toEqual(['Engineering', 'Management', 'Marketing', 'Product', 'Security'])

    const agents = await prisma.agent.findMany({ orderBy: { name: 'asc' } })
    expect(agents.map((a) => a.name)).toEqual([
      'Alex',
      'Atlas',
      'Daniel',
      'Emma',
      'John',
      'Maya',
      'Oliver',
      'Sarah',
    ])
  })

  it('creates one task in every task status', async () => {
    await seed()

    const tasks = await prisma.task.findMany()
    expect(tasks).toHaveLength(TASK_STATUSES.length)
    expect(tasks.map((t) => t.status).sort()).toEqual([...TASK_STATUSES].sort())
  })

  it('copies maxAttempts from the workspace onto every task', async () => {
    await seed()

    const workspace = await prisma.workspace.findFirstOrThrow()
    const tasks = await prisma.task.findMany({ select: { maxAttempts: true } })

    expect(tasks.every((t) => t.maxAttempts === workspace.maxAttempts)).toBe(true)
  })

  it('is idempotent — running it twice leaves the same row counts', async () => {
    await seed()
    const first = {
      agents: await prisma.agent.count(),
      tasks: await prisma.task.count(),
      teams: await prisma.team.count(),
    }

    await seed()
    const second = {
      agents: await prisma.agent.count(),
      tasks: await prisma.task.count(),
      teams: await prisma.team.count(),
    }

    expect(second).toEqual(first)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --project integration`
Expected: FAIL — `../../src/seed.js` does not exist.

- [ ] **Step 3: Write the seed**

`packages/db/src/seed.ts`:

```ts
import { prisma } from './client.js'
import { TASK_STATUSES } from './enums.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

const TEAMS = ['Management', 'Engineering', 'Security', 'Product', 'Marketing'] as const

const AGENTS: readonly { name: string; role: string; team: (typeof TEAMS)[number] }[] = [
  { name: 'Atlas', role: 'AI Manager', team: 'Management' },
  { name: 'Alex', role: 'Backend', team: 'Engineering' },
  { name: 'Emma', role: 'Frontend', team: 'Engineering' },
  { name: 'Daniel', role: 'DevOps', team: 'Engineering' },
  { name: 'Maya', role: 'QA', team: 'Engineering' },
  { name: 'Sarah', role: 'Security', team: 'Security' },
  { name: 'John', role: 'Business Analyst', team: 'Product' },
  { name: 'Oliver', role: 'SEO', team: 'Marketing' },
]

/**
 * Truncate-and-reseed rather than upsert. Upserts have to guess which rows correspond, and a
 * seed that guesses drifts from the schema silently. This one is idempotent by construction.
 */
export async function seed(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "AgentRun", "TaskDependency", "Task", "AgentSkill", "Skill", "SkillProvider", "AgentPermission", "ProviderConfiguration", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )

  const workspace = await prisma.workspace.create({
    data: {
      id: WORKSPACE_ID,
      name: 'Checkout Platform',
      repoPath: '/tmp/checkout-platform',
      verifyCommand: 'npm test',
    },
  })

  for (const team of TEAMS) {
    await prisma.team.create({ data: { workspaceId: workspace.id, name: team } })
  }

  const teamsByName = new Map(
    (await prisma.team.findMany()).map((team) => [team.name, team.id] as const),
  )

  for (const agent of AGENTS) {
    const teamId = teamsByName.get(agent.team)
    if (teamId === undefined) {
      throw new Error(`seed is inconsistent: no team named ${agent.team}`)
    }
    await prisma.agent.create({ data: { teamId, name: agent.name, role: agent.role } })
  }

  // One task per status, so every state has a real example on screen when M4 arrives.
  // maxAttempts is copied from the workspace guardrail configuration — the only correct source.
  for (const status of TASK_STATUSES) {
    await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: `Checkout task in ${status}`,
        description: `Demonstrates the ${status} state.`,
        status,
        maxAttempts: workspace.maxAttempts,
      },
    })
  }
}

if (process.argv[1]?.endsWith('seed.js') === true) {
  await seed()
  await prisma.$disconnect()
}
```

- [ ] **Step 4: Add the seed scripts**

`scripts/seed-test.mjs`:

```js
import { execSync } from 'node:child_process'

process.loadEnvFile('.env')

const url = process.env.TEST_DATABASE_URL
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env.')
}

execSync('node packages/db/dist/seed.js', {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
})
```

Add to the root `package.json` scripts:

```json
"db:seed": "tsc --build && node --env-file=.env packages/db/dist/seed.js",
"db:seed:test": "tsc --build && node scripts/seed-test.mjs"
```

The seed is compiled by `tsc --build` rather than run as TypeScript directly, so the build the
tests typecheck is the build that runs.

- [ ] **Step 5: Run the tests green**

Run:
```bash
npm test
npm run typecheck
```
Expected: the four seed tests pass. Paste the real counts.

- [ ] **Step 6: Seed the development database and look at it**

Run:
```bash
npm run db:seed
docker compose exec postgres psql -U aiteamos -d aiteamos -c 'SELECT status, count(*) FROM "Task" GROUP BY status ORDER BY status'
```
Expected: twelve rows, one per status. Paste the real table — this is the milestone's "seeded
database" evidence.

- [ ] **Step 7: Commit**

```bash
git add packages/db scripts package.json
git commit -m "feat(db): add seed data for the Atlas organisation

Twelve tasks, one per TaskStatus, each carrying maxAttempts copied from
the workspace guardrail configuration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The subscriber — LISTEN with reconnect

**Files:**
- Create: `packages/events/package.json`, `packages/events/tsconfig.json`, `packages/events/tsconfig.test.json`
- Create: `packages/events/src/subscribe.ts`, `packages/events/src/index.ts`
- Create: `packages/events/test/integration/subscribe.test.ts`
- Modify: `tsconfig.json`, `package.json`

**Interfaces:**
- Consumes: nothing from `packages/db` — the subscriber deliberately owns its own raw connection.
- Produces: `subscribeEvents(connectionString, onNotification): Promise<EventSubscription>` and the `EventNotification` type, used by Tasks 10 and 11.

The subscriber is built **before** the writer on purpose: it is the instrument that proves the
writer's notification behaviour in Task 10, and an instrument written after the thing it measures
tends to be shaped to agree with it.

- [ ] **Step 1: Scaffold the package**

`packages/events/package.json`:

```json
{
  "name": "@ai-team-os/events",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@ai-team-os/db": "*",
    "@ai-team-os/domain": "*",
    "pg": "^8.16.0"
  }
}
```

`packages/events/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../domain" }, { "path": "../db" }]
}
```

`packages/events/tsconfig.test.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "composite": false,
    "declaration": false
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Root `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "packages/domain" },
    { "path": "packages/db" },
    { "path": "packages/events" }
  ]
}
```

Root `package.json` typecheck script:

```json
"typecheck": "tsc --build --force && tsc -p packages/domain/tsconfig.test.json && tsc -p packages/db/tsconfig.test.json && tsc -p packages/events/tsconfig.test.json"
```

Run `npm install pg --workspace @ai-team-os/events` and then `npm install` at the root so the
workspace links.

- [ ] **Step 2: Write the failing tests**

`packages/events/test/integration/subscribe.test.ts`:

```ts
import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { subscribeEvents, type EventNotification, type EventSubscription } from '../../src/subscribe.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

let subscription: EventSubscription | null = null

afterEach(async (): Promise<void> => {
  await subscription?.close()
  subscription = null
})

async function notify(payload: string): Promise<void> {
  const client = new Client({ connectionString: url() })
  await client.connect()
  try {
    await client.query('SELECT pg_notify($1, $2)', ['events', payload])
  } finally {
    await client.end()
  }
}

describe('subscribeEvents', () => {
  it('receives a notification on the events channel', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    await notify(JSON.stringify({ seq: 7, workspaceId: 'w1' }))
    await expect.poll(() => seen).toEqual([{ seq: 7, workspaceId: 'w1' }])
  })

  it('ignores a malformed payload and stays alive for the next valid one', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    await notify('not json at all')
    await notify(JSON.stringify({ seq: 9, workspaceId: 'w2' }))

    await expect.poll(() => seen).toEqual([{ seq: 9, workspaceId: 'w2' }])
  })

  it('re-listens after its connection is terminated', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    const killer = new Client({ connectionString: url() })
    await killer.connect()
    try {
      await killer.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE query LIKE 'LISTEN events%' AND pid <> pg_backend_pid()`,
      )
    } finally {
      await killer.end()
    }

    await expect
      .poll(
        async () => {
          await notify(JSON.stringify({ seq: 11, workspaceId: 'w3' }))
          return seen.length
        },
        { timeout: 10_000, interval: 500 },
      )
      .toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm test -- --project integration`
Expected: FAIL — `../../src/subscribe.js` does not exist.

- [ ] **Step 4: Implement the subscriber**

`packages/events/src/subscribe.ts`:

```ts
import { Client } from 'pg'

export interface EventNotification {
  readonly seq: number
  readonly workspaceId: string
}

export interface EventSubscription {
  close(): Promise<void>
}

const RECONNECT_DELAY_MS = 250

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A notification is a wake-up, not a delivery. Its payload carries ids only — Postgres NOTIFY has
 * an 8KB limit that a large tool output would exceed — and a malformed one is dropped rather than
 * allowed to kill the listener, because the consumer's catch-up read is driven by `seq` and will
 * pick up anything a dropped notification would have announced.
 */
function parseNotification(payload: string | undefined): EventNotification | null {
  if (payload === undefined) return null

  try {
    const value: unknown = JSON.parse(payload)
    if (typeof value !== 'object' || value === null) return null

    const record = value as Record<string, unknown>
    const seq = record['seq']
    const workspaceId = record['workspaceId']
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return null
    if (typeof workspaceId !== 'string' || workspaceId === '') return null

    return { seq, workspaceId }
  } catch {
    return null
  }
}

export async function subscribeEvents(
  connectionString: string,
  onNotification: (notification: EventNotification) => void,
): Promise<EventSubscription> {
  let closed = false
  let current: Client | null = null

  const scheduleReconnect = (): void => {
    if (closed) return
    current = null
    void (async (): Promise<void> => {
      while (!closed) {
        await delay(RECONNECT_DELAY_MS)
        try {
          await open()
          return
        } catch {
          // keep retrying until close() is called
        }
      }
    })()
  }

  const open = async (): Promise<void> => {
    const client = new Client({ connectionString })
    client.on('notification', (message) => {
      const parsed = parseNotification(message.payload)
      if (parsed !== null) onNotification(parsed)
    })
    client.on('error', scheduleReconnect)
    client.on('end', scheduleReconnect)

    await client.connect()
    await client.query('LISTEN events')
    current = client
  }

  await open()

  return {
    async close(): Promise<void> {
      closed = true
      const client = current
      current = null
      if (client !== null) {
        client.removeAllListeners('end')
        client.removeAllListeners('error')
        await client.end()
      }
    },
  }
}
```

`packages/events/src/index.ts`:

```ts
export * from './subscribe.js'
```

- [ ] **Step 5: Run the tests green**

Run:
```bash
npm test
npm run typecheck
```
Expected: three subscriber tests pass, typecheck clean. Paste the real counts.

- [ ] **Step 6: Prove the reconnect test is load-bearing**

Temporarily remove the `client.on('end', scheduleReconnect)` line and run the integration project.

Expected: the `re-listens after its connection is terminated` test FAILS. Paste the real failure,
then restore the line and confirm green. A reconnect path with no test that kills the connection
is a claim, not a behaviour.

- [ ] **Step 7: Commit**

```bash
git add packages/events tsconfig.json package.json package-lock.json
git commit -m "feat(events): add LISTEN subscriber with reconnect

Malformed payloads are dropped rather than fatal: the consumer's
catch-up read is driven by seq, so a lost notification loses nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `appendEvent` — the single write gate

**Files:**
- Create: `packages/events/src/append.ts`
- Create: `packages/events/test/integration/append.test.ts`
- Modify: `packages/events/src/index.ts`, `packages/db/src/client.ts`

**Interfaces:**
- Consumes: `prisma` and `toExecutionEvent` from `packages/db`; `EVENT_TYPE_BY_DOMAIN_TYPE` from Task 6; `subscribeEvents` from Task 9 (in tests only).
- Produces: `appendEvent(input): Promise<ExecutionEvent>` — the only way anything writes to `ExecutionEvent`.

This task implements the four tests the design spec §9.5 names as the milestone's evidence.

- [ ] **Step 1: Expose the client to `packages/events` without exposing it to the world**

`packages/db/src/index.ts` must not export `prisma`. `packages/events` imports it by deep path:
`import { prisma } from '@ai-team-os/db/dist/client.js'`.

To keep that import legal and typed, add an `exports` map to `packages/db/package.json`:

```json
{
  "name": "@ai-team-os/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./client": { "types": "./dist/client.d.ts", "default": "./dist/client.js" }
  },
  "dependencies": {
    "@ai-team-os/domain": "*"
  }
}
```

Consumers then write `import { prisma } from '@ai-team-os/db/client'`. The barrel stays clean, and
the one module that needs the client reaches for it explicitly rather than by accident.

- [ ] **Step 2: Write the failing tests**

`packages/events/test/integration/append.test.ts`:

```ts
import { prisma } from '@ai-team-os/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../src/append.js'
import { subscribeEvents, type EventNotification, type EventSubscription } from '../../src/subscribe.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

let subscription: EventSubscription | null = null

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent" RESTART IDENTITY CASCADE')
})

afterEach(async (): Promise<void> => {
  await subscription?.close()
  subscription = null
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('appendEvent', () => {
  it('writes a valid event and returns it parsed', async () => {
    const event = await appendEvent({
      type: 'task.created',
      workspaceId: 'w1',
      taskId: 'task-1',
      actor: 'human',
      payload: { title: 'Add checkout retry' },
    })

    expect(event.type).toBe('task.created')
    expect(typeof event.seq).toBe('number')
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await prisma.executionEvent.count()).toBe(1)
  })

  it('leaves no row when the payload does not match the event type', async () => {
    await expect(
      appendEvent({
        type: 'task.created',
        workspaceId: 'w1',
        actor: 'human',
        payload: { nonsense: true },
      }),
    ).rejects.toThrow()

    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('notifies a subscriber with the seq and workspace id', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    const event = await appendEvent({
      type: 'run.started',
      workspaceId: 'w1',
      runId: 'run-1',
      actor: 'system',
      payload: { sessionId: 'sess-1' },
    })

    await expect.poll(() => seen).toEqual([{ seq: event.seq, workspaceId: 'w1' }])
  })

  it('delivers no notification when the write is rolled back', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    await expect(
      appendEvent({ type: 'task.created', workspaceId: 'w1', actor: 'human', payload: { nope: 1 } }),
    ).rejects.toThrow()

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(seen).toEqual([])
  })
})
```

The last test is the one that proves the atomicity claim rather than asserting it: NOTIFY is
delivered only on commit, so a rolled-back append must produce silence.

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm test -- --project integration`
Expected: FAIL — `../../src/append.js` does not exist.

- [ ] **Step 4: Implement the write gate**

`packages/events/src/append.ts`:

```ts
import { EVENT_TYPE_BY_DOMAIN_TYPE, toExecutionEvent, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import type { ExecutionEvent } from '@ai-team-os/domain'

export interface AppendableEvent {
  readonly type: DomainEventType
  readonly workspaceId: string
  readonly taskId?: string
  readonly agentId?: string
  readonly runId?: string
  readonly actor: 'human' | 'agent' | 'system'
  readonly payload: unknown
}

/**
 * The only write path to the event log.
 *
 * The row is inserted first so the database can assign `seq` and default `ts`, and validation
 * then runs on the row that came back — the exact object a reader will see, rather than the
 * object we intended to write. A failure throws, which rolls the transaction back, and because
 * Postgres delivers NOTIFY only on commit, a rolled-back append cannot announce itself.
 */
export async function appendEvent(input: AppendableEvent): Promise<ExecutionEvent> {
  return prisma.$transaction(async (tx): Promise<ExecutionEvent> => {
    const row = await tx.executionEvent.create({
      data: {
        type: EVENT_TYPE_BY_DOMAIN_TYPE[input.type],
        workspaceId: input.workspaceId,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        actor: input.actor,
        payload: input.payload as never,
      },
    })

    const parsed = toExecutionEvent(row)
    if (!parsed.ok) {
      throw new Error(`refusing to append an event the domain cannot parse: ${parsed.error}`)
    }

    const notification = JSON.stringify({ seq: parsed.value.seq, workspaceId: parsed.value.workspaceId })
    await tx.$executeRaw`SELECT pg_notify('events', ${notification})`

    return parsed.value
  })
}
```

The `payload as never` cast is the one place a cast is unavoidable: Prisma's `Json` input type is
a structural union that `unknown` cannot satisfy. It is safe precisely because the value is
validated two lines later, against the row that was actually stored — and if validation fails the
transaction never commits.

Add to `packages/events/src/index.ts`:

```ts
export * from './append.js'
```

- [ ] **Step 5: Run the tests green**

Run:
```bash
npm test
npm run typecheck
```
Expected: the four append tests pass. Paste the real counts.

- [ ] **Step 6: Prove the atomicity test is load-bearing**

Move the `pg_notify` call so it runs **before** the validation check, then run the integration
project.

Expected: `delivers no notification when the write is rolled back` still passes — because the
rollback, not the ordering, is what suppresses the notification. Record that result honestly.
Then run the second mutation: replace `prisma.$transaction(...)` with a plain sequential
implementation that inserts, validates, and notifies without a transaction.

Expected: the rollback test now FAILS, because the insert commits before validation runs. Paste
that real failure — it is the evidence that the transaction, not the code order, is what makes
this safe. Restore both.

- [ ] **Step 7: Commit**

```bash
git add packages/db packages/events
git commit -m "feat(events): add appendEvent as the single write gate

Validation runs on the returned row inside the transaction, so every row
in the append-only log is guaranteed parseable, and a rolled-back append
cannot notify.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Catch-up reads and the fallback poll

**Files:**
- Create: `packages/events/src/read.ts`, `packages/events/src/stream.ts`
- Create: `packages/events/test/integration/stream.test.ts`
- Modify: `packages/events/src/index.ts`

**Interfaces:**
- Consumes: `prisma` from `@ai-team-os/db/client`, `toExecutionEvent` from `@ai-team-os/db`, `subscribeEvents` from Task 9, `appendEvent` from Task 10 (in tests).
- Produces: `readEventsSince(seq, limit?)`, `createEventStream(options)`, `DEFAULT_POLL_INTERVAL_MS`. M4's SSE route consumes exactly these.

**The design point being implemented:** the notification is a wake-up, not a delivery. Every read
is driven by `seq`, so a dropped notification loses nothing — the next one catches up everything
in between. The remaining hole is a dropped notification followed by silence, and the fallback
poll closes it. The poll is deliberately slow: it must never quietly become the transport.

- [ ] **Step 1: Write the failing tests**

`packages/events/test/integration/stream.test.ts`:

```ts
import { prisma } from '@ai-team-os/db/client'
import type { ExecutionEvent } from '@ai-team-os/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../src/append.js'
import { readEventsSince } from '../../src/read.js'
import { createEventStream, DEFAULT_POLL_INTERVAL_MS, type EventStreamHandle } from '../../src/stream.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

let stream: EventStreamHandle | null = null

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent" RESTART IDENTITY CASCADE')
})

afterEach(async (): Promise<void> => {
  await stream?.close()
  stream = null
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('readEventsSince', () => {
  it('returns only later events, in ascending seq order', async () => {
    const first = await appendEvent({
      type: 'task.created', workspaceId: 'w1', actor: 'human', payload: { title: 'a' },
    })
    const second = await appendEvent({
      type: 'task.created', workspaceId: 'w1', actor: 'human', payload: { title: 'b' },
    })
    const third = await appendEvent({
      type: 'task.created', workspaceId: 'w1', actor: 'human', payload: { title: 'c' },
    })

    const events = await readEventsSince(first.seq)
    expect(events.map((e) => e.seq)).toEqual([second.seq, third.seq])
  })

  it('throws rather than silently skipping a row the domain cannot parse', async () => {
    await prisma.executionEvent.create({
      data: { type: 'task_created', workspaceId: 'w1', actor: 'system', payload: { wrong: true } },
    })

    await expect(readEventsSince(0)).rejects.toThrow()
  })
})

describe('createEventStream', () => {
  it('delivers an event appended after the stream started', async () => {
    const seen: ExecutionEvent[] = []
    stream = await createEventStream({
      connectionString: url(),
      fromSeq: 0,
      onEvent: (event) => seen.push(event),
    })

    await appendEvent({ type: 'task.started', workspaceId: 'w1', actor: 'system', payload: { title: 'a' } })

    await expect.poll(() => seen.map((e) => e.type)).toEqual(['task.started'])
  })

  it('delivers an event that was never announced, via the fallback poll', async () => {
    const seen: ExecutionEvent[] = []
    stream = await createEventStream({
      connectionString: url(),
      fromSeq: 0,
      onEvent: (event) => seen.push(event),
      pollIntervalMs: 300,
    })

    // Written directly, bypassing appendEvent — so no NOTIFY is ever issued for this row.
    await prisma.executionEvent.create({
      data: { type: 'task_done', workspaceId: 'w1', actor: 'system', payload: { branch: 'aiteamos/x' } },
    })

    await expect.poll(() => seen.map((e) => e.type), { timeout: 5000, interval: 100 }).toEqual(['task.done'])
  })

  it('defaults the poll interval to five seconds, too slow to be the transport', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5000)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm test -- --project integration`
Expected: FAIL — `../../src/read.js` does not exist.

- [ ] **Step 3: Implement the catch-up read**

`packages/events/src/read.ts`:

```ts
import { toExecutionEvent } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import type { ExecutionEvent } from '@ai-team-os/domain'

export const DEFAULT_READ_LIMIT = 500

/**
 * Reads forward from `seq`, exclusive. An unparseable row throws rather than being skipped: the
 * write gate guarantees every row parses, so a failure here means that guarantee has been
 * bypassed, and continuing quietly would hide it.
 */
export async function readEventsSince(
  seq: number,
  limit: number = DEFAULT_READ_LIMIT,
): Promise<ExecutionEvent[]> {
  const rows = await prisma.executionEvent.findMany({
    where: { seq: { gt: BigInt(seq) } },
    orderBy: { seq: 'asc' },
    take: limit,
  })

  return rows.map((row) => {
    const parsed = toExecutionEvent(row)
    if (!parsed.ok) {
      throw new Error(`event log contains an unparseable row at seq ${String(row.seq)}: ${parsed.error}`)
    }
    return parsed.value
  })
}
```

- [ ] **Step 4: Implement the stream**

`packages/events/src/stream.ts`:

```ts
import type { ExecutionEvent } from '@ai-team-os/domain'
import { readEventsSince } from './read.js'
import { subscribeEvents, type EventSubscription } from './subscribe.js'

export const DEFAULT_POLL_INTERVAL_MS = 5000

export interface EventStreamOptions {
  readonly connectionString: string
  readonly fromSeq: number
  readonly onEvent: (event: ExecutionEvent) => void
  readonly pollIntervalMs?: number
}

export interface EventStreamHandle {
  close(): Promise<void>
}

/**
 * Notification-driven with a slow poll behind it. The poll exists only for the case of a dropped
 * notification followed by silence; its interval is deliberately far above M6's one-second
 * requirement so it cannot become the mechanism the system relies on.
 */
export async function createEventStream(options: EventStreamOptions): Promise<EventStreamHandle> {
  let lastSeq = options.fromSeq
  let closed = false
  let running: Promise<void> = Promise.resolve()

  const catchUp = (): Promise<void> => {
    running = running.then(async (): Promise<void> => {
      if (closed) return
      const events = await readEventsSince(lastSeq)
      for (const event of events) {
        lastSeq = Math.max(lastSeq, event.seq)
        options.onEvent(event)
      }
    })
    return running
  }

  const subscription: EventSubscription = await subscribeEvents(options.connectionString, () => {
    void catchUp()
  })

  const timer = setInterval(() => void catchUp(), options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  timer.unref()

  await catchUp()

  return {
    async close(): Promise<void> {
      closed = true
      clearInterval(timer)
      await subscription.close()
      await running
    },
  }
}
```

The single `running` promise chain is what keeps a notification and a poll tick from reading the
same range twice and emitting duplicates.

Add to `packages/events/src/index.ts`:

```ts
export * from './read.js'
export * from './stream.js'
```

- [ ] **Step 5: Run the tests green**

Run:
```bash
npm test
npm run typecheck
```
Expected: five stream and read tests pass. Paste the real counts.

- [ ] **Step 6: Prove the fallback poll test is load-bearing**

Temporarily remove the `setInterval` line (and its `clearInterval`) and run the integration
project.

Expected: `delivers an event that was never announced, via the fallback poll` FAILS, while the
notification-driven test still passes. Paste the real failure, restore, confirm green. Without
this, the poll is a line of code nobody has watched do anything.

- [ ] **Step 7: Commit**

```bash
git add packages/events
git commit -m "feat(events): add seq-driven catch-up reads and the event stream

Notifications wake the stream; every read is driven by seq, so a dropped
notification loses nothing. A slow fallback poll covers the case of a
drop followed by silence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Enforcement, documentation, and the milestone gate

**Files:**
- Create: `.githooks/pre-push`, `README.md`, `docs/event-model.md`, `docs/decisions/0003-single-write-gate.md`
- Modify: `docs/domain-model.md`

**Interfaces:**
- Consumes: everything from Tasks 1-11.
- Produces: the milestone gate — evidence that M2 is genuinely complete, and the enforcement that keeps it so.

- [ ] **Step 1: Write the pre-push hook**

`.githooks/pre-push`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "pre-push: typecheck"
if ! npm run --silent typecheck; then
  echo "pre-push: typecheck failed — push refused." >&2
  exit 1
fi

echo "pre-push: tests"
if ! npm test --silent; then
  echo "pre-push: tests failed — push refused." >&2
  echo "If the failure is that the database is unreachable, run: docker compose up -d" >&2
  exit 1
fi

echo "pre-push: ok"
```

Make it executable and activate it:

```bash
chmod +x .githooks/pre-push
git config core.hooksPath .githooks
```

The hook lives in the repository rather than in `.git/hooks`, so it is versioned with the code.
`core.hooksPath` is a per-clone setting, which is why it appears in the README below.

- [ ] **Step 2: Prove the hook actually refuses**

There is no remote to push to, so exercise the hook directly.

Run it on the clean tree:
```bash
.githooks/pre-push
echo "exit=$?"
```
Expected: `pre-push: ok` and `exit=0`.

Now break something on purpose — add a line with a type error to `packages/db/src/mappers.ts`,
for example `const broken: number = 'not a number'` — and run the hook again:
```bash
.githooks/pre-push
echo "exit=$?"
```
Expected: it stops at the typecheck stage with a non-zero exit. Paste the real output, then remove
the broken line and confirm `exit=0` again with a clean `git status`.

- [ ] **Step 3: Write the README**

`README.md`:

```markdown
# AI Team OS

An autonomous AI engineering team: agents plan, implement, verify, review and merge real work in
real git repositories, with a human supervising rather than prompting.

## Status

- **M0** — pause/resume spike, complete. Findings in `docs/superpowers/spikes/`, decisions in
  `docs/decisions/0001-pause-semantics.md`.
- **M1** — pure domain core, complete. See `docs/domain-model.md`.
- **M2** — persistence and event log. See `docs/event-model.md`.

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d
npm run db:migrate
npm run db:migrate:test
npm run db:seed
git config core.hooksPath .githooks
```

That last line is per-clone and is what wires the pre-push hook that runs typecheck and tests.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Both vitest projects: fast unit tests and serial database integration tests |
| `npm run typecheck` | Builds every package and typechecks the test files too |
| `npm run db:migrate` | Applies migrations to the development database |
| `npm run db:migrate:test` | Applies migrations to the test database |
| `npm run db:seed` | Truncates and reseeds the development database |

Integration tests require Postgres to be running. They **fail** rather than skip when it is not:
a suite that skips reports success for work it did not do.
```

- [ ] **Step 4: Write the event model document**

`docs/event-model.md` must describe, using the real exported names from the code:

- The envelope, and where each field comes from at write time (`seq` and `ts` from the database,
  the rest from the caller).
- `appendEvent` as the single write gate: insert, validate the returned row, notify — all in one
  transaction — and why validating the returned row rather than the input is what makes "every row
  in the log parses" an invariant.
- Why NOTIFY carries ids only (the 8KB limit).
- **The single-writer assumption**, stated as load-bearing and silent: `seq` ordering matches
  commit ordering only because the orchestrator is the sole writer. A second writer breaks
  catch-up reads with no error and no failing test. Anyone adding one must read this section first.
- The notification-as-wake-up model, and the fallback poll's deliberate slowness.
- The `EventType` enum's one-way door: the database enum must never lead the Zod union, because
  the log is append-only and an unparseable row cannot be removed.
- Where each piece lives: `packages/db/src/enums.ts`, `packages/db/src/mappers.ts`,
  `packages/events/src/append.ts`, `subscribe.ts`, `read.ts`, `stream.ts`.

Read the code before writing each claim. A document that names a function that does not exist is
worse than no document.

- [ ] **Step 5: Write ADR 0003**

`docs/decisions/0003-single-write-gate.md`:

```markdown
# ADR 0003 — The Event Log Has One Application-Level Write Gate

**Status:** Accepted
**Date:** 2026-08-18
**Context:** M2 design spec §6, parent spec §6.3

## Decision

`appendEvent()` in `packages/events` is the only write path to `ExecutionEvent`. It inserts,
validates the returned row against the domain's Zod union, and issues `pg_notify` — all inside one
transaction. `packages/db` does not export the Prisma client from its barrel; the one module that
needs it imports `@ai-team-os/db/client` explicitly.

## Rationale

A database trigger would make the notification impossible to skip regardless of how a row was
written. It was rejected because the logic would live in migration SQL: untestable from the test
suite, awkward to version, and the hardest thing on the branch to hold to this project's standard
that every load-bearing behaviour has a test that fails when it breaks.

The application-level gate gets the same atomicity from Postgres rather than from discipline:
NOTIFY is delivered only on commit, so a rolled-back append cannot announce itself. What it does
require is that no second write path exists — hence the export rule.

## Consequences

- Every row in the append-only log is guaranteed parseable by `parseExecutionEvent`.
- A new event type requires three coordinated changes: the Zod union, the `EventType` enum, and
  `EVENT_TYPE_BY_DOMAIN_TYPE`. The `satisfies` clause on that map fails the build if the union
  moves without it.
- If a future writer bypasses `appendEvent`, the guarantee is gone and nothing will report it.
  That is the cost of choosing the gate over the trigger, and it is why the export rule is a
  constraint rather than a convention.
```

- [ ] **Step 6: Record the persistence half in the domain model document**

Append a short section to `docs/domain-model.md` stating where the domain types are now persisted:
`TaskState` maps to the `Task` table via `toTaskState`, `RunState` to `AgentRun` via `toRunState`,
and branded ids — which stop at the event boundary — are restored in `packages/db/src/mappers.ts`.
Link to `docs/event-model.md` for the log itself.

- [ ] **Step 7: Run the full milestone gate**

Run each and paste the real output:

```bash
docker compose ps
npm run db:migrate:test
npm test
npm run typecheck
docker compose exec postgres psql -U aiteamos -d aiteamos -c 'SELECT status, count(*) FROM "Task" GROUP BY status ORDER BY status'
.githooks/pre-push
```

M2 is complete only when all six conditions from the design spec §11 are true:

1. Compose brings up a healthy Postgres on 5433.
2. Migrations apply cleanly to an empty database.
3. The seed produces the Atlas organisation and tasks in all twelve statuses.
4. Enum parity passes by full enumeration.
5. All four event-path tests pass against the real database.
6. Typecheck and tests are green, and the pre-push hook runs them.

- [ ] **Step 8: Commit**

```bash
git add .githooks README.md docs
git commit -m "docs: add event model, ADR 0003, README, and the pre-push hook

Closes the enforcement gap M1's final review named: typecheck was wired
to nothing, and the branded-id guarantee rests on a compile-time test
that passes vacuously under vitest.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Deliberately Deferred From This Plan

- **The orchestrator and any real process execution.** M3. This plan writes no code that starts a
  child process or touches a git worktree.
- **The SSE route and `Last-Event-ID` replay.** M4. It consumes `createEventStream` and
  `readEventsSince` unchanged; nothing here blocks it.
- **The behaviour** behind the four items carried from M1's final review — QA review runs,
  guardrail-initiated pause, the `maxAttempts` link as enforced logic, and re-branding beyond the
  mapper. M8. Only the schema and the mappers land here.
- **The remaining event types** from the parent spec §6.2. They arrive as the orchestrator starts
  emitting them, each as a coordinated change to the Zod union, the `EventType` enum, and
  `EVENT_TYPE_BY_DOMAIN_TYPE`.
- **`Checkpoint` persistence.** M3, where its shape is settled by ADR 0001's session findings.
- **GitHub Actions.** When a remote exists. The pre-push hook is the enforcement until then.

## Next Plan

`docs/superpowers/plans/<date>-m3-orchestrator-and-adapter.md` — the `AgentRuntimeAdapter`
interface, `ClaudeCodeAdapter`, real worktrees, and the run loop. It consumes `appendEvent` and
the `packages/db` mappers unchanged; the write gate is the contract.
