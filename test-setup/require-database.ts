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
