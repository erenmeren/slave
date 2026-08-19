import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `fileParallelism` sizes the shared worker pool and only takes effect at
    // this root level — Vitest documents and reads it as a top-level/CLI
    // option. Setting it inside a single project's `test` block is silently
    // ignored by the scheduler, which let the "integration" project's test
    // files run concurrently against the shared Postgres database and
    // deadlock on overlapping TRUNCATE/INSERT statements.
    fileParallelism: false,
    projects: [
      {
        // Inline `projects` entries are their own Vite configs — they do not inherit a
        // `plugins` array declared at this file's root, so the react plugin (JSX
        // transform for the `.test.tsx` shell tests) has to live on the project itself.
        plugins: [react()],
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.{ts,tsx}', 'apps/**/test/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/test/integration/**'],
          environment: 'node',
          setupFiles: ['./test-setup/react-cleanup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/test/integration/**/*.test.ts', 'apps/**/test/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          setupFiles: ['./test-setup/require-database.ts'],
          poolOptions: { threads: { singleThread: true } },
        },
      },
    ],
  },
})
