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
const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL'] })

export const prisma: PrismaClient = new PrismaClient({ adapter })

export type { PrismaClient }

/**
 * Re-exported for the input types Prisma generates but does not surface on the model rows —
 * `Prisma.InputJsonValue` in particular, which is what a caller needs to hand an unknown-shaped
 * payload to a Json column without reaching for an unchecked assertion.
 *
 * A value export, not a type-only one (M14 Task 4): writing SQL NULL into a *nullable* Json column
 * needs the runtime sentinel `Prisma.DbNull`. Prisma's generated input type for such a column
 * deliberately does not accept a bare `null`, because `null` is ambiguous there — a JSON `null`
 * value and an absent value are different facts, and `AgentRun.skillCalls` is a column whose whole
 * point is that "unknown" and "measured as empty" must not collide.
 */
export { Prisma } from './generated/client.js'

export type {
  AgentRun as AgentRunRow,
  ExecutionEvent as ExecutionEventRow,
  Task as TaskRow,
} from './generated/client.js'
