import { execSync } from 'node:child_process'

process.loadEnvFile('.env')

const url = process.env.TEST_DATABASE_URL
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. Copy .env.example to .env.')
}

execSync(
  'npx prisma migrate deploy --schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts',
  {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  },
)
