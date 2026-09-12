import { describe, expect, it } from 'vitest'
import {
  BROKERED_OPERATIONS,
  BROKER_CLIENT_TIMEOUT_MS,
  BROKER_OPS,
  BROKER_OP_LABEL,
  BROKER_REFUSAL_LABEL,
  BROKER_REFUSAL_REASONS,
  BROKER_TIMEOUT_MS,
  PERMISSION_DENIAL_WINDOW_MS,
  PERMISSION_TRIP_COUNT,
} from '../../src/broker/operations.js'
import { PERMISSION_KINDS } from '../../src/permission/kinds.js'

describe('BROKERED_OPERATIONS', () => {
  it('is a STATIC manifest of exactly the ops this system will run on a worker’s behalf', () => {
    expect(BROKER_OPS).toEqual(['deploy_release'])
    expect(Object.keys(BROKERED_OPERATIONS)).toEqual([...BROKER_OPS])
  })

  it('gives every op a grant that is one of the six permission kinds', () => {
    for (const op of BROKER_OPS) {
      expect(PERMISSION_KINDS, op).toContain(BROKERED_OPERATIONS[op].grant)
    }
  })

  it('gives every op a word, so no surface prints the key', () => {
    for (const op of BROKER_OPS) {
      expect(BROKER_OP_LABEL[op], op).toMatch(/^[A-Z]/u)
      expect(BROKER_OP_LABEL[op], op).not.toContain('_')
    }
  })

  it('accepts an environment KEY and a digest, and nothing that could name a target', () => {
    const parsed = BROKERED_OPERATIONS.deploy_release.params.safeParse({
      environment: 'staging',
      digest: 'a1b2c3d',
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a URL, a path, a host and an absolute anything in `environment`', () => {
    for (const bad of ['https://example.com', '../etc', '/etc/passwd', 'prod.example.com', 'Staging', '']) {
      expect(BROKERED_OPERATIONS.deploy_release.params.safeParse({ environment: bad, digest: 'a1b2c3d' }).success, bad)
        .toBe(false)
    }
  })

  it('refuses a digest that is not lowercase hex of a plausible length', () => {
    for (const bad of ['ZZZZZZZ', 'a1b2c3', 'A1B2C3D', `${'a'.repeat(65)}`, '']) {
      expect(BROKERED_OPERATIONS.deploy_release.params.safeParse({ environment: 'staging', digest: bad }).success, bad)
        .toBe(false)
    }
  })

  it('refuses an unknown parameter -- the schema is strict, so a smuggled key is a refusal and not a silent drop', () => {
    const parsed = BROKERED_OPERATIONS.deploy_release.params.safeParse({
      environment: 'staging',
      digest: 'a1b2c3d',
      url: 'https://example.com',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('BROKER_REFUSAL_REASONS', () => {
  it('is the closed list of ways a brokered call is refused, and every one has a word', () => {
    expect(BROKER_REFUSAL_REASONS).toEqual([
      'identity_mismatch',
      'run_not_live',
      'permission_denied',
      'not_brokered',
      'credential_unset',
      'invalid_params',
      'simulation',
    ])
    for (const reason of BROKER_REFUSAL_REASONS) {
      expect(BROKER_REFUSAL_LABEL[reason], reason).toMatch(/^[A-Z]/u)
      expect(BROKER_REFUSAL_LABEL[reason], reason).not.toContain('_')
    }
  })
})

describe('the two timeouts and the trip count', () => {
  it('gives the CLIENT longer than the SERVER, so a worker never gives up on a call still running', () => {
    expect(BROKER_TIMEOUT_MS).toBe(120_000)
    expect(BROKER_CLIENT_TIMEOUT_MS).toBe(150_000)
    expect(BROKER_CLIENT_TIMEOUT_MS).toBeGreaterThan(BROKER_TIMEOUT_MS)
  })

  it('raises a permission situation on the THIRD denial of one kind, inside half an hour', () => {
    expect(PERMISSION_TRIP_COUNT).toBe(3)
    expect(PERMISSION_DENIAL_WINDOW_MS).toBe(30 * 60_000)
  })
})
