import { existsSync } from 'node:fs'
import { Client } from 'pg'
import { beforeAll } from 'vitest'

if (existsSync('.env')) {
  process.loadEnvFile('.env')
}
process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL']

beforeAll(async (): Promise<void> => {
  const url = process.env['TEST_DATABASE_URL']
  if (url === undefined || url === '') {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env — integration tests do not skip.',
    )
  }

  const client = new Client({ connectionString: url })
  try {
    try {
      await client.connect()
      await client.query('SELECT 1')
    } catch (cause) {
      throw new Error(
        `Cannot reach the test database at ${url}. Run \`docker compose up -d\` and try again. ` +
          'Integration tests fail rather than skip, so this suite is red until the database is up.',
        { cause },
      )
    }

    // Self-heal the one piece of schema a test is allowed to create.
    //
    // `withCommitFailure` in packages/events/test/integration/append.test.ts attaches an
    // always-raising CONSTRAINT TRIGGER to "ExecutionEvent" and drops it in a `finally`. DDL in
    // Postgres autocommits, so a hard kill (^C, an OOM, a crashed worker) between the CREATE and
    // the DROP leaves that trigger installed permanently, and nothing else resets the schema
    // between runs. Every later run then fails any insert of an event with a bare
    // `P0001: deliberate commit-time failure for atomicity test` — a message that points at
    // whichever test happened to insert first, not at the fixture that left the trigger behind.
    //
    // This lives here, in the shared setup, rather than at the top of append.test.ts: the
    // integration project runs serially and file order is not fixed, so subscribe.test.ts or
    // stream.test.ts can run first and hit the poisoned table before append.test.ts's own setup
    // ever executes. Suite start is the only point that is guaranteed to precede all of them.
    // Harmless on a clean database — both statements are IF EXISTS.
    await client.query('DROP TRIGGER IF EXISTS fail_after_insert ON "ExecutionEvent"')
    await client.query('DROP FUNCTION IF EXISTS test_fail_after_insert()')
  } finally {
    await client.end()
  }
})
