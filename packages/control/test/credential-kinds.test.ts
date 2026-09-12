import { describe, expect, it } from 'vitest'
import { CREDENTIAL_KINDS, CREDENTIAL_KIND_LABEL } from '../src/credential.js'

/**
 * The label parity `packages/domain/test/broker/operations.test.ts` keeps for `BROKER_OP_LABEL` and
 * `packages/domain/test/permission/kinds.test.ts` keeps for `PERMISSION_LABEL`, for the third
 * vocabulary M52 prints (fix round 1, review Minor 2 upgraded): a surface that shows `deploy_token`
 * to a person is a surface showing a key, and this is the table that stops it.
 *
 * A unit test and not an integration one: nothing here touches a database, and the whole point is
 * that a fourth kind fails HERE rather than on somebody's screen.
 */
describe('CREDENTIAL_KIND_LABEL', () => {
  it('gives every kind a word, so no surface prints the key', () => {
    for (const kind of CREDENTIAL_KINDS) {
      expect(CREDENTIAL_KIND_LABEL[kind], kind).toMatch(/^[A-Z]/u)
      expect(CREDENTIAL_KIND_LABEL[kind], kind).not.toContain('_')
    }
  })

  it('has exactly the three kinds and no more', () => {
    expect(Object.keys(CREDENTIAL_KIND_LABEL).sort()).toEqual([...CREDENTIAL_KINDS].sort())
  })
})
