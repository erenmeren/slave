import { describe, expect, it } from 'vitest'
import { artifactLabel } from '../src/lib/artifactLabel.js'

describe('artifactLabel', () => {
  it.each([
    ['/r/.aiteamos/artifacts/t/attempt-01/00-npm-test.log', 'attempt 1 · npm-test'],
    ['/r/.aiteamos/artifacts/t/attempt-12/03-npm-run-lint.log', 'attempt 12 · npm-run-lint'],
    ['/r/.aiteamos/artifacts/t/merge/attempt-02/00-npm-test.log', 'merge · npm-test'],
    ['/r/.aiteamos/artifacts/t/whatever.txt', 'whatever.txt'],
  ])('%s → %s', (path, label) => {
    expect(artifactLabel(path)).toBe(label)
  })
})
