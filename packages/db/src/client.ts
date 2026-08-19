import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client.js'

/**
 * The one configured Prisma instance. Every consumer imports from here, so the
 * generated client's import path and connection wiring — both of which differ
 * between Prisma major versions — are absorbed in exactly one file.
 *
 * Prisma 7 removed the `datasource.url` schema field and the implicit
 * `new PrismaClient()` env lookup in favor of an explicit driver adapter, so
 * the Postgres connection string is wired here rather than in the schema.
 */
/**
 * A second, independently-connected client.
 *
 * Not for ordinary use — every consumer wants the shared `prisma` below, and a second pool is a
 * second set of connections. It exists because "this survived a restart" is only demonstrable with
 * a client that carries nothing over from the old process: startup reconciliation (spec §3.4) has
 * to prove that a workspace halt lives in the column rather than in anyone's memory, and a test
 * asserting that against the same instance proves nothing. Callers own disconnecting it.
 *
 * The connection string is read at call time rather than captured, so a caller that has already
 * pointed `DATABASE_URL` at a test database gets that one.
 */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }) })
}

const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL'] })

export const prisma: PrismaClient = new PrismaClient({ adapter })

export type { PrismaClient }

/**
 * Re-exported for the input types Prisma generates but does not surface on the model rows —
 * `Prisma.InputJsonValue` in particular, which is what a caller needs to hand an unknown-shaped
 * payload to a Json column without reaching for an unchecked assertion.
 */
export type { Prisma } from './generated/client.js'

export type {
  AgentRun as AgentRunRow,
  ExecutionEvent as ExecutionEventRow,
  Task as TaskRow,
} from './generated/client.js'
