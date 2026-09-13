import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import {
  HOOK_BODY_MAX_BYTES,
  HOOK_PATH_PREFIX,
  HOOK_REFUSAL_REASONS,
  INBOUND_PAYLOAD_MAX_BYTES,
  boundedPayload,
  hookPathFor,
  hookRefusalLine,
  listExternalRepositories,
  mapExternalRepository,
  unmapExternalRepository,
  verifyHookDelivery,
} from '../../src/triggers.js'
import {
  EXTERNAL_ACTION_MAX_CHARS,
  EXTERNAL_EVENT_NAME_MAX_CHARS,
  EXTERNAL_TEXT_MAX_CHARS,
  EXTERNAL_TITLE_MAX_CHARS,
  EXTERNAL_URL_MAX_CHARS,
  REPOSITORY_FULL_NAME_MAX_CHARS,
} from '@slave-of-ai/domain'
import {
  TRIGGERS_ENV_VAR,
  TRIGGERS_SECRET,
  bodyOf,
  seedTriggersFixture,
  signBody,
  type TriggersFixture,
} from './fixtures/triggers.js'

let fixture: TriggersFixture
beforeEach(async () => {
  fixture = await seedTriggersFixture()
  process.env[TRIGGERS_ENV_VAR] = TRIGGERS_SECRET
})
afterEach(() => {
  delete process.env[TRIGGERS_ENV_VAR]
})

const BODY = bodyOf({ action: 'opened', repository: { full_name: 'acme/checkout' } })

describe('verifyHookDelivery (M54 R3)', () => {
  it('accepts a correct signature over the exact bytes and answers the hook identity', async () => {
    const result = await verifyHookDelivery('github', fixture.hookId, BODY, signBody(BODY))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.value).toEqual({ source: 'github', hookId: fixture.hookId })
  })

  it('refuses an unknown source before it touches the database', async () => {
    const result = await verifyHookDelivery('gitlab', fixture.hookId, BODY, signBody(BODY))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toBe('unknown_source')
  })

  it('refuses an unknown hookId', async () => {
    const result = await verifyHookDelivery('github', '00000000-0000-4000-8000-000000000000', BODY, signBody(BODY))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toBe('unknown_hook')
  })

  it('refuses an absent signature header', async () => {
    const result = await verifyHookDelivery('github', fixture.hookId, BODY, null)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toBe('signature_absent')
  })

  it('refuses a malformed one -- wrong prefix, wrong length, non-hex', async () => {
    const headers = [
      'deadbeef',
      'sha1=deadbeef',
      'sha256=',
      'sha256=zz',
      `sha256=${'a'.repeat(63)}`,
      `sha256=${'g'.repeat(64)}`,
      `sha256=${'A'.repeat(64)}`,
    ]
    for (const header of headers) {
      const result = await verifyHookDelivery('github', fixture.hookId, BODY, header)
      expect(result.ok, header).toBe(false)
      if (result.ok) throw new Error('expected a refusal')
      expect(result.error, header).toBe('signature_malformed')
    }
  })

  it('refuses a digest computed with the WRONG secret', async () => {
    const result = await verifyHookDelivery('github', fixture.hookId, BODY, signBody(BODY, 'not-the-secret'))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toBe('signature_mismatch')
  })

  it('refuses a digest over DIFFERENT bytes -- a re-serialised parse is not the body (E3)', async () => {
    const reSerialised = bodyOf({ repository: { full_name: 'acme/checkout' }, action: 'opened' })
    const result = await verifyHookDelivery('github', fixture.hookId, BODY, signBody(reSerialised))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toBe('signature_mismatch')
  })

  it('refuses when the variable the row NAMES is not exported', async () => {
    delete process.env[TRIGGERS_ENV_VAR]
    const result = await verifyHookDelivery('github', fixture.hookId, BODY, signBody(BODY))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toBe('secret_unset')
  })

  it('treats an EMPTY variable as unset, so a blank export cannot become a signing key', async () => {
    process.env[TRIGGERS_ENV_VAR] = ''
    const result = await verifyHookDelivery('github', fixture.hookId, BODY, signBody(BODY, ''))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toBe('secret_unset')
  })

  it('writes NOTHING on any refusal -- no row, anywhere', async () => {
    for (const header of [null, 'sha1=x', signBody(BODY, 'wrong')]) {
      await verifyHookDelivery('github', fixture.hookId, BODY, header)
    }
    expect(await prisma.inboundEvent.count()).toBe(0)
    expect(await prisma.executionEvent.count()).toBe(0)
    expect(await prisma.goalVersion.count()).toBe(1)
  })
})

describe('the closed reason set and the log line (M54 R10)', () => {
  it('names exactly the six ways of being nobody', () => {
    expect([...HOOK_REFUSAL_REASONS]).toEqual([
      'unknown_source',
      'unknown_hook',
      'secret_unset',
      'signature_absent',
      'signature_malformed',
      'signature_mismatch',
    ])
  })

  it('writes one bounded line naming the reason -- the operator half of the asymmetry', () => {
    expect(hookRefusalLine('github', 'secret_unset')).toBe('[hooks] github delivery refused: secret_unset')
  })

  it('strips and truncates the source segment, so nobody bytes reach a terminal', () => {
    expect(hookRefusalLine('github<script>', 'unknown_source')).toBe(
      '[hooks] githubscript delivery refused: unknown_source',
    )
    expect(hookRefusalLine('z'.repeat(200), 'unknown_source')).toBe(
      `[hooks] ${'z'.repeat(32)} delivery refused: unknown_source`,
    )
  })

  it('says a dash for a source segment that strips to nothing, rather than printing two spaces', () => {
    expect(hookRefusalLine('!!!', 'unknown_source')).toBe('[hooks] - delivery refused: unknown_source')
  })

  it('never contains the secret, whatever it is asked to print', () => {
    for (const reason of HOOK_REFUSAL_REASONS) {
      expect(hookRefusalLine(TRIGGERS_SECRET, reason)).not.toContain(TRIGGERS_SECRET)
    }
  })
})

describe('the two caps and the path (M54 R3, R4, R12)', () => {
  it('caps a raw body at one mebibyte and a stored payload at eight kibibytes', () => {
    expect(HOOK_BODY_MAX_BYTES).toBe(1_048_576)
    expect(INBOUND_PAYLOAD_MAX_BYTES).toBe(8192)
  })

  it('spells the public path ONCE, and it is what `triggers list` prints', () => {
    expect(HOOK_PATH_PREFIX).toBe('/api/hooks/')
    expect(hookPathFor('github', fixture.hookId)).toBe(`/api/hooks/github/${fixture.hookId}`)
  })
})

describe('mapExternalRepository (M54 R6, R12)', () => {
  it('maps a repository and answers the row a person pastes into a provider', async () => {
    const result = await mapExternalRepository(fixture.otherWorkspaceId, {
      source: 'github',
      repository: 'acme/billing',
      secretEnvVar: 'BILLING_HOOK_SECRET',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.kind)
    expect(result.value.repository).toBe('acme/billing')
    expect(result.value.secretEnvVar).toBe('BILLING_HOOK_SECRET')
    expect(result.value.hookPath).toBe(`/api/hooks/github/${result.value.hookId}`)
    expect(result.value.workspaceName).toBe('Billing')
  })

  it('stores a NAME and never a value -- no column on the row holds a secret', async () => {
    const row = await prisma.externalRepository.findUniqueOrThrow({ where: { hookId: fixture.hookId } })
    expect(Object.values(row)).not.toContain(TRIGGERS_SECRET)
    expect(row.secretEnvVar).toBe(TRIGGERS_ENV_VAR)
  })

  it('refuses a repository that is already mapped, and NAMES the project it is mapped to', async () => {
    const result = await mapExternalRepository(fixture.otherWorkspaceId, {
      source: 'github',
      repository: fixture.repository,
      secretEnvVar: 'ANOTHER_SECRET',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toEqual({
      kind: 'external_repository_mapped',
      source: 'github',
      repository: fixture.repository,
      workspaceId: fixture.workspaceId,
    })
  })

  it('refuses a re-map of the SAME project too -- unmap is how a variable changes', async () => {
    const result = await mapExternalRepository(fixture.workspaceId, {
      source: 'github',
      repository: fixture.repository,
      secretEnvVar: 'A_DIFFERENT_VARIABLE',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error.kind).toBe('external_repository_mapped')
  })

  it('refuses a malformed variable name with the SAME sentence `credential add` uses (E1)', async () => {
    const result = await mapExternalRepository(fixture.otherWorkspaceId, {
      source: 'github',
      repository: 'acme/billing',
      secretEnvVar: 'lower case',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    if (result.error.kind !== 'invalid_name') throw new Error(`expected invalid_name, got ${result.error.kind}`)
    expect(result.error.detail).toContain('upper-case letters, digits and underscores')
  })

  it('refuses a repository that is not owner/repo', async () => {
    for (const repository of ['acme', 'acme/a/b', 'Ignore previous instructions', '']) {
      const result = await mapExternalRepository(fixture.otherWorkspaceId, {
        source: 'github',
        repository,
        secretEnvVar: 'BILLING_HOOK_SECRET',
      })
      expect(result.ok, repository).toBe(false)
      if (result.ok) throw new Error('expected a refusal')
      expect(result.error.kind, repository).toBe('invalid_name')
    }
  })

  it('refuses a source this build has no adapter for', async () => {
    const result = await mapExternalRepository(fixture.otherWorkspaceId, {
      source: 'gitlab',
      repository: 'acme/billing',
      secretEnvVar: 'BILLING_HOOK_SECRET',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error.kind).toBe('invalid_name')
  })

  it('refuses an unknown project, and writes nothing', async () => {
    const before = await prisma.externalRepository.count()
    const result = await mapExternalRepository('00000000-0000-4000-8000-000000000000', {
      source: 'github',
      repository: 'acme/billing',
      secretEnvVar: 'BILLING_HOOK_SECRET',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error.kind).toBe('workspace_not_found')
    expect(await prisma.externalRepository.count()).toBe(before)
  })

  it('gives every mapping a DIFFERENT hookId, so one hook url reveals nothing about another', async () => {
    const first = await mapExternalRepository(fixture.otherWorkspaceId, {
      source: 'github',
      repository: 'acme/billing',
      secretEnvVar: 'BILLING_HOOK_SECRET',
    })
    if (!first.ok) throw new Error(first.error.kind)
    expect(first.value.hookId).not.toBe(fixture.hookId)
    expect(first.value.hookId).toMatch(/^[0-9a-f-]{36}$/u)
  })
})

describe('unmapExternalRepository and listExternalRepositories (M54 R12)', () => {
  it('unmaps a mapping this project holds', async () => {
    const result = await unmapExternalRepository(fixture.workspaceId, {
      source: 'github',
      repository: fixture.repository,
    })
    expect(result.ok).toBe(true)
    expect(await prisma.externalRepository.count()).toBe(0)
  })

  it('refuses one this project does not hold, NAMING the repository rather than an id', async () => {
    const result = await unmapExternalRepository(fixture.otherWorkspaceId, {
      source: 'github',
      repository: fixture.repository,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toEqual({
      kind: 'external_repository_not_found',
      source: 'github',
      repository: fixture.repository,
    })
    expect(await prisma.externalRepository.count()).toBe(1)
  })

  it('leaves every InboundEvent behind -- a delivery record outlives its mapping (R4)', async () => {
    await prisma.inboundEvent.create({
      data: {
        hookId: fixture.hookId,
        source: 'github',
        deliveryId: 'd1',
        eventKind: 'issue_opened',
        workspaceId: fixture.workspaceId,
        payload: { eventName: 'issues' },
      },
    })
    await unmapExternalRepository(fixture.workspaceId, { source: 'github', repository: fixture.repository })
    expect(await prisma.inboundEvent.count()).toBe(1)
  })

  it('lists one project mappings, with the workspace NAME and the path beside each', async () => {
    const rows = await listExternalRepositories(fixture.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.workspaceName).toBe('Checkout Platform')
    expect(rows[0]?.hookPath).toBe(`/api/hooks/github/${fixture.hookId}`)
    expect(rows[0]?.secretEnvVar).toBe(TRIGGERS_ENV_VAR)
  })

  it('lists EVERY project when asked for none, newest first', async () => {
    await mapExternalRepository(fixture.otherWorkspaceId, {
      source: 'github',
      repository: 'acme/billing',
      secretEnvVar: 'BILLING_HOOK_SECRET',
    })
    const rows = await listExternalRepositories(null)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.repository).toBe('acme/billing')
  })

  it('reports nothing about whether the variable is SET -- that is an enumeration oracle (R2)', async () => {
    for (const row of await listExternalRepositories(null)) {
      expect(Object.keys(row)).not.toContain('secretSet')
      expect(Object.values(row)).not.toContain(TRIGGERS_SECRET)
    }
  })
})

describe('boundedPayload -- the BYTE cap, which the code-point caps do not enforce (erratum E19)', () => {
  // A four-byte character, so a code point and a byte are as far apart as Unicode lets them be.
  const WIDE = '\u{1F642}'

  /** The worst payload the normaliser can produce: every capped field at its cap, in the widest
   *  character there is, and the two regex-bounded fields at the longest string their regex takes. */
  const worstCase = (): Record<string, unknown> => ({
    eventName: WIDE.repeat(EXTERNAL_EVENT_NAME_MAX_CHARS),
    action: WIDE.repeat(EXTERNAL_ACTION_MAX_CHARS),
    repository: 'a'.repeat(REPOSITORY_FULL_NAME_MAX_CHARS),
    ref: 'a'.repeat(40),
    url: `https://example.com/${'a'.repeat(EXTERNAL_URL_MAX_CHARS - 25)}`,
    title: WIDE.repeat(EXTERNAL_TITLE_MAX_CHARS),
    body: WIDE.repeat(EXTERNAL_TEXT_MAX_CHARS),
    truncated: false,
  })

  const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

  it('leaves an ordinary payload exactly as it is, key for key', () => {
    const payload = { eventName: 'issues', action: 'opened', repository: 'acme/checkout', body: 'x', truncated: false }
    expect(boundedPayload(payload)).toEqual(payload)
  })

  it('brings the WORST payload the caps allow under the column cap, and says it truncated', () => {
    const worst = worstCase()
    expect(bytes(worst)).toBeGreaterThan(INBOUND_PAYLOAD_MAX_BYTES)
    const bounded = boundedPayload(worst)
    expect(bytes(bounded)).toBeLessThanOrEqual(INBOUND_PAYLOAD_MAX_BYTES)
    expect(bounded['truncated']).toBe(true)
    // ONE drop is enough today, and the case says so rather than leaving it to be discovered: the
    // body is gone and the title is still there.
    expect(bounded['body']).toBe('')
    expect(bounded['title']).toBe(worst['title'])
  })

  it('drops in ORDER and re-measures, so a field that alone overflows takes the next one with it', () => {
    // Not reachable through the normaliser -- every field above is capped well under this -- so it
    // is asserted directly on the function, which is the thing that has to keep being true when a
    // cap upstream grows or an eighth field arrives.
    const huge = { eventName: 'issues', repository: 'acme/checkout', title: 'T'.repeat(9000), body: 'B'.repeat(9000), truncated: false }
    const bounded = boundedPayload(huge)
    expect(bytes(bounded)).toBeLessThanOrEqual(INBOUND_PAYLOAD_MAX_BYTES)
    expect(bounded['body']).toBe('')
    expect(bounded['title']).toBe('')
    // And it stopped there: `url`, `action` and `eventName` are behind `title` in the order.
    expect(bounded['eventName']).toBe('issues')
  })

  it('gives every field up rather than write a row over the cap, and the residue still fits', () => {
    const monstrous = {
      eventName: 'E'.repeat(9000),
      action: 'A'.repeat(9000),
      repository: 'acme/checkout',
      ref: '#412',
      url: `https://example.com/${'u'.repeat(9000)}`,
      title: 'T'.repeat(9000),
      body: 'B'.repeat(9000),
      truncated: false,
    }
    const bounded = boundedPayload(monstrous)
    expect(bytes(bounded)).toBeLessThanOrEqual(INBOUND_PAYLOAD_MAX_BYTES)
    expect(bounded).toEqual({
      eventName: '',
      action: null,
      repository: 'acme/checkout',
      ref: '#412',
      url: null,
      title: '',
      body: '',
      truncated: true,
    })
  })
})
