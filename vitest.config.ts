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
