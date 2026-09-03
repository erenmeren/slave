import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import { MIN_PASSWORD_LENGTH, USERNAME_RE, createUser, deleteUser, listUsers, setPassword, verifyCredentials } from '../../src/users.js'

const LONG_ENOUGH_PASSWORD = 'a reasonably long passphrase'

describe('users', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  describe('USERNAME_RE', () => {
    it('accepts lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit', () => {
      expect(USERNAME_RE.test('ada')).toBe(true)
      expect(USERNAME_RE.test('ada.lovelace')).toBe(true)
      expect(USERNAME_RE.test('ada-lovelace_2')).toBe(true)
      expect(USERNAME_RE.test('42')).toBe(true)
      expect(USERNAME_RE.test('a2')).toBe(true)
    })

    it('rejects a single character, uppercase, or a leading dot/dash/underscore', () => {
      expect(USERNAME_RE.test('a')).toBe(false)
      expect(USERNAME_RE.test('Ada')).toBe(false)
      expect(USERNAME_RE.test('.ada')).toBe(false)
      expect(USERNAME_RE.test('-ada')).toBe(false)
      expect(USERNAME_RE.test('_ada')).toBe(false)
    })
  })

  describe('createUser', () => {
    it('creates a user and returns its id', async () => {
      const result = await createUser('ada', LONG_ENOUGH_PASSWORD)

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable: asserted above')
      const row = await prisma.user.findUniqueOrThrow({ where: { username: 'ada' } })
      expect(row.id).toBe(result.value.id)
      expect(row.passwordHash).not.toBe(LONG_ENOUGH_PASSWORD)
      expect(row.passwordHash.startsWith('pbkdf2-sha256$')).toBe(true)
    })

    it('refuses a duplicate username, creating nothing new', async () => {
      await createUser('ada', LONG_ENOUGH_PASSWORD)

      const result = await createUser('ada', 'a different long passphrase')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'ada' })
      expect(await prisma.user.count()).toBe(1)
    })

    it('refuses an invalid username with the verbatim text', async () => {
      const result = await createUser('Ada!', LONG_ENOUGH_PASSWORD)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toEqual({ kind: 'invalid_username', username: 'Ada!' })
        expect(refusalText(result.error)).toBe(
          'a username is 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit',
        )
      }
      expect(await prisma.user.count()).toBe(0)
    })

    it('refuses a password shorter than the minimum with the verbatim text', async () => {
      const result = await createUser('ada', 'short')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toEqual({ kind: 'weak_password', minimum: MIN_PASSWORD_LENGTH })
        expect(refusalText(result.error)).toBe(`a password must be at least ${MIN_PASSWORD_LENGTH} characters`)
      }
      expect(await prisma.user.count()).toBe(0)
    })
  })

  describe('setPassword', () => {
    it('changes what verifyCredentials accepts', async () => {
      await createUser('ada', LONG_ENOUGH_PASSWORD)

      const result = await setPassword('ada', 'a brand new long passphrase')

      expect(result.ok).toBe(true)
      expect(await verifyCredentials('ada', LONG_ENOUGH_PASSWORD)).toBeNull()
      expect(await verifyCredentials('ada', 'a brand new long passphrase')).toEqual({
        id: expect.any(String),
        username: 'ada',
      })
    })

    it('refuses a weak replacement password, changing nothing', async () => {
      await createUser('ada', LONG_ENOUGH_PASSWORD)

      const result = await setPassword('ada', 'short')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'weak_password', minimum: MIN_PASSWORD_LENGTH })
      expect(await verifyCredentials('ada', LONG_ENOUGH_PASSWORD)).not.toBeNull()
    })

    it('refuses an unknown username', async () => {
      const result = await setPassword('nobody', LONG_ENOUGH_PASSWORD)

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'user_not_found', username: 'nobody' })
    })
  })

  describe('deleteUser', () => {
    it('removes the row', async () => {
      await createUser('ada', LONG_ENOUGH_PASSWORD)

      const result = await deleteUser('ada')

      expect(result.ok).toBe(true)
      expect(await prisma.user.findUnique({ where: { username: 'ada' } })).toBeNull()
    })

    it('refuses an unknown username', async () => {
      const result = await deleteUser('nobody')

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toEqual({ kind: 'user_not_found', username: 'nobody' })
    })
  })

  describe('verifyCredentials', () => {
    it('returns the id and username for the right password', async () => {
      const created = await createUser('ada', LONG_ENOUGH_PASSWORD)
      if (!created.ok) throw new Error('unreachable: asserted above')

      const result = await verifyCredentials('ada', LONG_ENOUGH_PASSWORD)

      expect(result).toEqual({ id: created.value.id, username: 'ada' })
    })

    it('returns null for the wrong password', async () => {
      await createUser('ada', LONG_ENOUGH_PASSWORD)

      expect(await verifyCredentials('ada', 'the wrong passphrase entirely')).toBeNull()
    })

    it('returns null for a missing user, taking about as long as a real check (>= 50 ms)', async () => {
      const start = performance.now()
      const result = await verifyCredentials('nobody', LONG_ENOUGH_PASSWORD)
      const elapsed = performance.now() - start

      expect(result).toBeNull()
      expect(elapsed).toBeGreaterThanOrEqual(50)
    })
  })

  describe('listUsers', () => {
    it('lists users ordered by username', async () => {
      await createUser('zoe', LONG_ENOUGH_PASSWORD)
      await createUser('ada', LONG_ENOUGH_PASSWORD)
      await createUser('mo', LONG_ENOUGH_PASSWORD)

      const users = await listUsers()

      expect(users.map((u) => u.username)).toEqual(['ada', 'mo', 'zoe'])
    })

    it('returns an empty list when there are no users', async () => {
      expect(await listUsers()).toEqual([])
    })
  })
})
