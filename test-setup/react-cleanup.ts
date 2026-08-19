import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// @testing-library/react's own auto-cleanup only registers itself when a global `afterEach`
// exists (e.g. under Jest, or Vitest with `test.globals: true`). This project imports test
// hooks explicitly instead of turning on globals, so component tests would otherwise leak
// rendered DOM across `it` blocks within the same file. Harmless no-op for non-component tests.
afterEach(() => {
  cleanup()
})
