/**
 * M23 F3: the five local-account control verbs. Mirrors `org.ts`'s shape -- validate untrusted
 * input first, then hit the database, translating a unique-constraint throw into `duplicate_name`
 * and a zero-row update/delete into `user_not_found` rather than pre-querying for either (the
 * same race the `isUniqueConstraintViolation` docstring in `prisma-errors.ts` argues against).
 */
import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import { dummyHash, hashPassword, verifyPassword } from './password.js'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/
export const MIN_PASSWORD_LENGTH = 12

export interface UserSummary {
  readonly id: string
  readonly username: string
  readonly createdAt: Date
}

export async function createUser(username: string, password: string): Promise<Result<{ id: string }, ControlRefusal>> {
  if (!USERNAME_RE.test(username)) return err({ kind: 'invalid_username', username })
  if (password.length < MIN_PASSWORD_LENGTH) return err({ kind: 'weak_password', minimum: MIN_PASSWORD_LENGTH })
  try {
    const user = await prisma.user.create({ data: { username, passwordHash: await hashPassword(password) } })
    return ok({ id: user.id })
  } catch (cause) {
    if (isUniqueConstraintViolation(cause)) return err({ kind: 'duplicate_name', name: username })
    throw cause
  }
}

export async function setPassword(username: string, password: string): Promise<Result<void, ControlRefusal>> {
  if (password.length < MIN_PASSWORD_LENGTH) return err({ kind: 'weak_password', minimum: MIN_PASSWORD_LENGTH })
  const { count } = await prisma.user.updateMany({
    where: { username },
    data: { passwordHash: await hashPassword(password) },
  })
  if (count === 0) return err({ kind: 'user_not_found', username })
  return ok(undefined)
}

export async function deleteUser(username: string): Promise<Result<void, ControlRefusal>> {
  const { count } = await prisma.user.deleteMany({ where: { username } })
  if (count === 0) return err({ kind: 'user_not_found', username })
  return ok(undefined)
}

export async function listUsers(): Promise<readonly UserSummary[]> {
  return prisma.user.findMany({ orderBy: { username: 'asc' }, select: { id: true, username: true, createdAt: true } })
}

/**
 * Checks a username/password pair against the database, WITHOUT distinguishing "no such user"
 * from "wrong password" -- an attacker who can tell the two apart can enumerate valid usernames
 * one guess at a time.
 *
 * The derivation runs either way (spec §7 F3): a missing user must not answer faster than a real
 * one, which is why `dummyHash()` is awaited on that branch instead of returning `null`
 * immediately.
 */
export async function verifyCredentials(username: string, password: string): Promise<{ id: string; username: string } | null> {
  const user = await prisma.user.findUnique({ where: { username } })
  const stored = user?.passwordHash ?? (await dummyHash())
  const valid = await verifyPassword(password, stored)
  return valid && user !== null ? { id: user.id, username: user.username } : null
}
