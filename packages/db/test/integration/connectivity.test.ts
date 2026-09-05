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
    expect(result.rows[0]?.current_database).toBe('slaveofai_test')
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
