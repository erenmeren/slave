import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * M58 R29: the migration, proved on a POPULATED pre-M58 database.
 *
 * The test database has already had every migration applied by `db:migrate:test`, so this cannot
 * "run the migration" against it. It builds a SHADOW SCHEMA instead: every migration that PRECEDES
 * M58 in ordered history, a fixture written with raw SQL into that shape, then M58's own file, then
 * the assertions. Migrations that come AFTER M58 assume the schema M58 introduces (e.g. M60 adds
 * `Person."poolSlot"`), so replaying them onto a pre-M58 fixture would fail; they are no part of
 * proving M58 and are excluded. `pg`'s simple query protocol runs a whole migration file in one
 * call, which is why this uses a `Client` directly rather than Prisma's parameterised `$executeRaw`.
 *
 * Each case builds a shadow schema of its OWN, because M58 is irreversible and a second case
 * cannot re-run it over the first's result. They are dropped in `afterAll` whatever happens; they
 * are namespaced, so they survive nothing and collide with nothing the other integration files
 * truncate.
 */
const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/prisma/migrations')
const M58 = '20260915120000_m58_persons'
/** One shadow schema per case: M58 is irreversible, so a case cannot reuse another's. */
const SHADOWS = ['m58_shadow', 'm58_shadow_e8'] as const

let client: Client

async function run(sql: string): Promise<void> {
  await client.query(sql)
}

/** Every migration that PRECEDES M58 in ordered history, into a schema of this case's own. */
async function buildShadow(schema: string): Promise<void> {
  await run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await run(`CREATE SCHEMA "${schema}"`)
  await run(`SET search_path TO "${schema}"`)
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
  // Reconstruct the database as it stood immediately before M58. Migrations AFTER M58 depend on
  // the schema M58 introduces (e.g. M60's `Person."poolSlot"`) and cannot apply to a pre-M58
  // fixture, so the prefix stops at -- and excludes -- M58 itself.
  const m58Index = dirs.indexOf(M58)
  expect(m58Index).toBeGreaterThan(0)
  const before = dirs.slice(0, m58Index)
  for (const name of before) {
    await run(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'))
  }
}

/** The migration under test, into whichever shadow the case built. */
async function applyM58(): Promise<void> {
  await run(readFileSync(join(MIGRATIONS_DIR, M58, 'migration.sql'), 'utf8'))
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL']
  if (url === undefined || url === '') throw new Error('TEST_DATABASE_URL is not set')
  client = new Client({ connectionString: url })
  await client.connect()
}, 120_000)

afterAll(async () => {
  if (client !== undefined) {
    for (const schema of SHADOWS) await run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await client.end()
  }
})

describe('the M58 migration, on a populated database', () => {
  it('moves every slave, roster row, memory and skill onto persons and leaves the rest alone', async () => {
    await buildShadow(SHADOWS[0])

    // ---- the fixture: two projects, two slaves that share a name, a roster row nobody
    // materialised, a worker-scoped memory, a slave skill, and a run/permission/task to count.
    await run(`
      INSERT INTO "Workspace" (id, name, "repoPath", "verifyCommands", "setupCommands")
        VALUES ('w1','Alpha','/tmp/a', ARRAY['true'], ARRAY[]::TEXT[]),
               ('w2','Beta','/tmp/b',  ARRAY['true'], ARRAY[]::TEXT[]);
      INSERT INTO "Company" (id, name) VALUES ('c1','Acme');
      INSERT INTO "CompanyTeam" (id, "companyId", name) VALUES ('ct1','c1','Engineering');
      INSERT INTO "SlaveTemplate" (id, name, role) VALUES ('tpl1','Builder','dev');
      INSERT INTO "CompanySlave" (id, "companyTeamId", "templateId", name, model, provider, profile)
        VALUES ('cs1','ct1','tpl1','Atlas','sonnet','claude_code','roster persona'),
               ('cs2','ct1','tpl1','Unseated', NULL, NULL, NULL);
      INSERT INTO "Team" (id, "workspaceId", name, "companyTeamId")
        VALUES ('t1','w1','Engineering','ct1'), ('t2','w2','Engineering', NULL);
      INSERT INTO "Slave" (id, "teamId", name, role, "runtimeRoles", capabilities, "companySlaveId", lifecycle)
        VALUES ('s1','t1','Atlas','dev', ARRAY['dev'], ARRAY['backend']::TEXT[], 'cs1','permanent'),
               ('s2','t2','Atlas','dev', ARRAY['dev'], ARRAY[]::TEXT[], NULL, 'project');
      INSERT INTO "SkillProvider" (id, name) VALUES ('sp1','personal');
      INSERT INTO "Skill" (id, "providerId", name, description) VALUES ('sk1','sp1','pdf','makes pdfs');
      INSERT INTO "SlaveSkill" ("slaveId","skillId") VALUES ('s1','sk1');
      INSERT INTO "Task" (id, "workspaceId", title, description, status, "maxAttempts")
        VALUES ('tk1','w1','Do a thing','body','ready', 3);
      INSERT INTO "SlaveRun" (id, "slaveId", "taskId", status, kind)
        VALUES ('r1','s1','tk1','succeeded','implementation');
      INSERT INTO "SlavePermission" (id, "slaveId", kind, mode) VALUES ('pm1','s1','run_commands','allow');
      INSERT INTO "Memory" (id, type, scope, "slaveId", title, body, "sourceKind", "createdBy", "updatedAt")
        VALUES ('m1','lesson','worker','s1','Prefer pnpm','because','run_output','slave', CURRENT_TIMESTAMP);
      -- E5: a proposal nobody has answered yet, naming the roster row by the field the migration
      -- rewrites. The kind keeps its name; only the payload's subject changes.
      INSERT INTO "SupervisorDecision"
        (id, "workspaceId", "situationKind", "subjectId", situation, candidates, "chosenIndex",
         action, rationale, tier, status, "decidedBy")
        VALUES ('d1','w1','capability_unstaffed','cap:backend','{}'::jsonb,'[]'::jsonb,0,
                '{"kind":"materialise_company_worker","companySlaveId":"cs2"}'::jsonb,
                'nobody covers backend','proposed','pending','rules'),
               ('d2','w1','capability_unstaffed','cap:backend','{}'::jsonb,'[]'::jsonb,0,
                '{"kind":"materialise_company_worker","companySlaveId":"cs2"}'::jsonb,
                'already answered','proposed','rejected','rules');
    `)

    const beforeCounts = await client.query<{ runs: string; perms: string; tasks: string }>(`
      SELECT (SELECT COUNT(*) FROM "SlaveRun")::text        AS runs,
             (SELECT COUNT(*) FROM "SlavePermission")::text AS perms,
             (SELECT COUNT(*) FROM "Task")::text            AS tasks
    `)

    // ---- the migration under test
    await applyM58()

    // 1. one person per old slave, plus one for the unmaterialised roster row
    const persons = await client.query<{ id: string; name: string; templateId: string | null }>(
      `SELECT id, name, "templateId" FROM "Person" ORDER BY name`,
    )
    expect(persons.rows.map((row) => row.name)).toEqual(['Atlas (Alpha)', 'Atlas (Beta)', 'Unseated'])

    // 2. the collision was resolved by the project name, and each seat names its own person
    const seats = await client.query<{ id: string; name: string; closedAt: string | null }>(`
      SELECT s.id, p.name, s."closedAt" FROM "Slave" s JOIN "Person" p ON p.id = s."personId" ORDER BY s.id
    `)
    expect(seats.rows).toEqual([
      { id: 's1', name: 'Atlas (Alpha)', closedAt: null },
      { id: 's2', name: 'Atlas (Beta)', closedAt: null },
    ])

    // 3. the roster row nobody materialised is a person with NO seat -- the pool
    const pooled = await client.query<{ seats: string }>(`
      SELECT (SELECT COUNT(*) FROM "Slave" s WHERE s."personId" = p.id)::text AS seats
        FROM "Person" p WHERE p.name = 'Unseated'
    `)
    expect(pooled.rows[0]?.seats).toBe('0')

    // 4. the roster row's model/provider/profile became the PERSON's -- the middle rung of the chain
    const atlas = await client.query<{ model: string | null; provider: string | null; profile: string | null }>(
      `SELECT model, provider::text, profile FROM "Person" WHERE name = 'Atlas (Alpha)'`,
    )
    expect(atlas.rows[0]).toEqual({ model: 'sonnet', provider: 'claude_code', profile: 'roster persona' })

    // 5. departments: both the seated person and the pooled one are members
    const members = await client.query<{ name: string }>(`
      SELECT p.name FROM "CompanyTeamMember" m JOIN "Person" p ON p.id = m."personId" ORDER BY p.name
    `)
    expect(members.rows.map((row) => row.name)).toEqual(['Atlas (Alpha)', 'Unseated'])

    // 6. the skill became a person-level GRANT, and the persona default set is empty
    const skills = await client.query<{ name: string; skillId: string; mode: string }>(`
      SELECT p.name, ps."skillId", ps.mode::text FROM "PersonSkill" ps JOIN "Person" p ON p.id = ps."personId"
    `)
    expect(skills.rows).toEqual([{ name: 'Atlas (Alpha)', skillId: 'sk1', mode: 'granted' }])
    expect((await client.query(`SELECT * FROM "TemplateSkill"`)).rowCount).toBe(0)

    // 7. the memory belongs to the person now
    const memory = await client.query<{ name: string }>(`
      SELECT p.name FROM "Memory" m JOIN "Person" p ON p.id = m."personId" WHERE m.id = 'm1'
    `)
    expect(memory.rows[0]?.name).toBe('Atlas (Alpha)')

    // 8. nothing else moved
    const afterCounts = await client.query<{ runs: string; perms: string; tasks: string }>(`
      SELECT (SELECT COUNT(*) FROM "SlaveRun")::text        AS runs,
             (SELECT COUNT(*) FROM "SlavePermission")::text AS perms,
             (SELECT COUNT(*) FROM "Task")::text            AS tasks
    `)
    expect(afterCounts.rows[0]).toEqual(beforeCounts.rows[0])

    // 9. E5: the PENDING proposal names the person the roster row became; the answered one is left
    // exactly as it was, because rewriting history is not a migration's job
    const decisions = await client.query<{ id: string; kind: string; subject: string | null; person: string | null }>(`
      SELECT d.id,
             d."action" ->> 'kind'           AS kind,
             d."action" ->> 'companySlaveId' AS subject,
             p.name                          AS person
        FROM "SupervisorDecision" d
        LEFT JOIN "Person" p ON p.id = d."action" ->> 'personId'
       ORDER BY d.id
    `)
    expect(decisions.rows).toEqual([
      { id: 'd1', kind: 'materialise_company_worker', subject: null, person: 'Unseated' },
      { id: 'd2', kind: 'materialise_company_worker', subject: 'cs2', person: null },
    ])

    // 10. the old shapes are gone
    const gone = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = '${SHADOWS[0]}' AND table_name IN ('CompanySlave','SlaveSkill','_m58_person_seed')
    `)
    expect(gone.rows).toEqual([])
  }, 120_000)

  // Spec erratum E8. The suffix is assigned against every name ALREADY TAKEN, not per-`wanted`
  // partition: an installation holding the seats "Builder" and "Builder 2" -- exactly what two
  // `hireFromTemplate` calls produce -- plus an unstaffed roster row "Builder" made the old
  // per-partition ROW_NUMBER hand out a second "Builder 2" and abort the whole migration on
  // "Person_name_key".
  it('resolves a name collision against every name already taken, not one partition at a time', async () => {
    await buildShadow(SHADOWS[1])

    await run(`
      INSERT INTO "Workspace" (id, name, "repoPath", "verifyCommands", "setupCommands")
        VALUES ('w1','Alpha','/tmp/a', ARRAY['true'], ARRAY[]::TEXT[]);
      INSERT INTO "Company" (id, name) VALUES ('c1','Acme');
      INSERT INTO "CompanyTeam" (id, "companyId", name) VALUES ('ct1','c1','Engineering');
      INSERT INTO "SlaveTemplate" (id, name, role) VALUES ('tpl1','Builder','dev');
      -- the roster row nobody materialised, wanting the name a seat already has
      INSERT INTO "CompanySlave" (id, "companyTeamId", "templateId", name)
        VALUES ('cs1','ct1','tpl1','Builder');
      INSERT INTO "Team" (id, "workspaceId", name, "companyTeamId") VALUES ('t1','w1','Engineering','ct1');
      -- the two seats hireFromTemplate leaves behind when it is called twice for one persona
      INSERT INTO "Slave" (id, "teamId", name, role, "runtimeRoles", capabilities, lifecycle)
        VALUES ('s1','t1','Builder','dev',   ARRAY['dev'], ARRAY[]::TEXT[], 'project'),
               ('s2','t1','Builder 2','dev', ARRAY['dev'], ARRAY[]::TEXT[], 'project');
    `)

    await applyM58()

    // three persons, three distinct names: the pooled roster row walks PAST the taken "Builder 2"
    const persons = await client.query<{ name: string; seats: string }>(`
      SELECT p.name, (SELECT COUNT(*) FROM "Slave" s WHERE s."personId" = p.id)::text AS seats
        FROM "Person" p ORDER BY p.name
    `)
    expect(persons.rows).toEqual([
      { name: 'Builder', seats: '1' },
      { name: 'Builder 2', seats: '1' },
      { name: 'Builder 3', seats: '0' },
    ])

    // and the seats kept the names their own workers had, rather than trading them
    const seats = await client.query<{ id: string; name: string }>(`
      SELECT s.id, p.name FROM "Slave" s JOIN "Person" p ON p.id = s."personId" ORDER BY s.id
    `)
    expect(seats.rows).toEqual([
      { id: 's1', name: 'Builder' },
      { id: 's2', name: 'Builder 2' },
    ])
  }, 120_000)
})
