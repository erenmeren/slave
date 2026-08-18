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

export type {
  AgentRun as AgentRunRow,
  ExecutionEvent as ExecutionEventRow,
  Task as TaskRow,
} from './generated/client.js'
