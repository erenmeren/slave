import { createHmac, timingSafeEqual } from 'node:crypto'
import { prisma } from '@slave-of-ai/db/client'
import {
  EXTERNAL_KIND_LABEL,
  EXTERNAL_SOURCES,
  REPOSITORY_FULL_NAME_RE,
  composeExternalRequest,
  normaliseGitHubDelivery,
  ok,
  err,
  type ExternalEventKind,
  type ExternalOrigin,
  type ExternalSource,
  type Result,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { ENV_VAR_RE, ENV_VAR_RULE } from './credential.js'
import { requestChange } from './goal.js'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/**
 * INBOUND, and the opposite direction from every other module in this package.
 *
 * `injectExternalEvent` (`./simulation/write.ts:329`) INJECTS a sector's own simulated event into a
 * `SimulationRun`'s journal, gated by a signed-in operator's session. `ingestExternalEvent` below
 * INGESTS a signed delivery from a real provider for a real `Workspace`. Different verbs, different
 * tables, different callers, no shared code -- stated in both doc comments so the next reader does
 * not have to derive it (M54 R13). `packages/control/test/simulation-boundary.test.ts` is the scan
 * that keeps them apart through a refactor nobody reads a convention during.
 */

/** The longest raw body this system will read (M54 R3). One mebibyte: GitHub's own deliveries top
 *  out well under it, and a bound that applies identically to every hookId -- including ones that do
 *  not exist -- is an oracle for nothing. */
export const HOOK_BODY_MAX_BYTES = 1_048_576

/**
 * The longest NORMALISED payload a row may hold (M54 R4).
 *
 * A SECOND lock and not a restatement of the normaliser's, because the two count different units:
 * `sanitiseExternalText` caps `title` and `body` by CODE POINT (300 and 2000), and a column is
 * bounded in BYTES. 2000 ASCII characters are 2000 bytes and never come near this; 2000 four-byte
 * characters are 8000, and a title beside them carries the row over -- which is the case
 * `boundedPayload` below exists for, and the case `triggers-ingest.test.ts` sends.
 */
export const INBOUND_PAYLOAD_MAX_BYTES = 8192

/** The most rows `listInboundEvents` answers (plan erratum E11). `LIST_EVIDENCE_LIMIT`'s own number
 *  and its own reason: a line per delivery is a page of history and not a window on all of it. */
export const LIST_INBOUND_LIMIT = 200

/** The one public path family (M54 R1). Spelled here and, separately, as `PUBLIC_API_PREFIX` in
 *  `apps/web/src/lib/boundary.ts` -- that module is PURE and compiles for the edge runtime, so it
 *  cannot import this package, and `apps/web/test/integration/hooks-route.test.ts` asserts the two
 *  are the same string. */
export const HOOK_PATH_PREFIX = '/api/hooks/'

/** The path an operator pastes into a provider's settings. One spelling, read by the CLI and by the
 *  route's own test. */
export function hookPathFor(source: ExternalSource, hookId: string): string {
  return `${HOOK_PATH_PREFIX}${source}/${hookId}`
}

/**
 * The six ways of being nobody (M54 R10, plan erratum E4).
 *
 * The VERIFIER answers one of these; the ROUTE turns every one of them into the same
 * `401 {"error":"unauthenticated"}` and writes one bounded line naming which. That asymmetry is the
 * whole of R10: the log is the operator's and says `secret_unset` so a mistyped variable is
 * diagnosable, and the response is a stranger's and says nothing.
 */
export const HOOK_REFUSAL_REASONS = [
  'unknown_source',
  'unknown_hook',
  'secret_unset',
  'signature_absent',
  'signature_malformed',
  'signature_mismatch',
] as const

export type HookRefusalReason = (typeof HOOK_REFUSAL_REASONS)[number]

/** The three the ROUTE decides on its own, after (or before) the verifier: a body over the cap, a
 *  verified delivery whose payload will not parse or will not validate, and one with no idempotency
 *  key. R11's 413 and its two 400s. */
export const HOOK_ROUTE_REASONS = ['body_too_large', 'payload_invalid', 'delivery_id_absent'] as const

export type HookRouteReason = (typeof HOOK_ROUTE_REASONS)[number]

/** Every reason that may appear in the log line, and no other (M54 R10's closed set of nine). */
export type HookLogReason = HookRefusalReason | HookRouteReason

const LOG_SOURCE_MAX_CHARS = 32

/**
 * The ONE line a refused delivery produces, on the web process's own stderr (M54 R10).
 *
 * Bounded by construction: the reason is a member of a closed union, and the source segment is the
 * path segment lower-cased, stripped to `[a-z0-9-]` and truncated to 32 characters -- so an
 * attacker's bytes cannot reach a log reader's terminal and the line's length cannot be chosen by
 * the caller. A segment that strips to nothing prints as `-` rather than as two spaces.
 *
 * The delivery id of a refused delivery is deliberately NOT in it: nothing has authenticated it.
 */
export function hookRefusalLine(source: string, reason: HookLogReason): string {
  const safe = source.toLowerCase().replace(/[^a-z0-9-]/gu, '').slice(0, LOG_SOURCE_MAX_CHARS)
  return `[hooks] ${safe === '' ? '-' : safe} delivery refused: ${reason}`
}

/** Who a verified delivery turned out to be (M54 R3). A source and a hook, and nothing else: the
 *  WORKSPACE is resolved from the payload (R6), not from the hook. */
export interface HookIdentity {
  readonly source: ExternalSource
  readonly hookId: string
}

const SIGNATURE_PREFIX = 'sha256='
/** Lower-case hex, exactly 64 characters -- the length of a SHA-256 digest. Checked BEFORE
 *  `Buffer.from(..., 'hex')`, because that call silently truncates a malformed string and
 *  `timingSafeEqual` THROWS on two buffers of different lengths. */
const HEX_DIGEST_RE = /^[0-9a-f]{64}$/u

/**
 * Is this delivery signed by the secret the mapping names? (M54 R3)
 *
 * HERE and not in the route: `node:crypto` is banned in `apps/web/src`
 * (`apps/web/src/lib/session.ts:1-7`) because that tree must also compile for Next's edge
 * middleware. `packages/control` is server-only by construction and already imports
 * `timingSafeEqual` (`./broker.ts:1`), and this is the same fail-closed idiom `./broker.ts:311`
 * uses.
 *
 * `rawBody` is BYTES and never a string (plan erratum E3): a signature is over bytes,
 * `JSON.stringify(JSON.parse(x))` is not `x`, and `Request.text()` decodes UTF-8 with replacement --
 * so the route reads `arrayBuffer()` and hands the `Uint8Array` here.
 *
 * THE SECRET GOES EXACTLY ONE PLACE. `process.env[row.secretEnvVar]` is read, passed to
 * `createHmac`, and never assigned to anything that outlives this call. It is in no row, no event,
 * no response and no log line.
 *
 * The order is: shape checks that need no I/O, then ONE indexed read, then the secret, then the
 * digest. The response is byte-identical for all six outcomes; the TIME is not perfectly identical
 * (a refusal before the digest skips a few microseconds of HMAC over a bounded body, against a
 * database round trip that dominates both), and R1's claim is about what a caller can READ, which is
 * one sentence with no information in it.
 */
export async function verifyHookDelivery(
  source: string,
  hookId: string,
  rawBody: Uint8Array,
  signatureHeader: string | null,
): Promise<Result<HookIdentity, HookRefusalReason>> {
  if (!(EXTERNAL_SOURCES as readonly string[]).includes(source)) return err('unknown_source')
  if (signatureHeader === null || signatureHeader === '') return err('signature_absent')
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return err('signature_malformed')
  const presented = signatureHeader.slice(SIGNATURE_PREFIX.length)
  if (!HEX_DIGEST_RE.test(presented)) return err('signature_malformed')

  const row = await prisma.externalRepository.findUnique({
    where: { hookId },
    select: { hookId: true, source: true, secretEnvVar: true },
  })
  // The SOURCE must agree with the path too: a future GitLab hook whose id is pasted into the GitHub
  // path is a hook the caller could not have signed for, and it reads back as "unknown" rather than
  // as "wrong family", because those are the same answer to a stranger.
  if (row === null || row.source !== source) return err('unknown_hook')

  const secret = process.env[row.secretEnvVar]
  if (secret === undefined || secret === '') return err('secret_unset')

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(presented, 'hex'))) {
    return err('signature_mismatch')
  }
  return ok({ source: row.source, hookId: row.hookId })
}

/**
 * A delivery's status, set once and moved at most once (M54 R4). Spelled HERE rather than in
 * `@slave-of-ai/domain` because nothing outside this module and the CLI behind it decides anything
 * from it -- `CREDENTIAL_KINDS`' own precedent and its own reason (`./credential.ts:9-17`), and plan
 * erratum E9. The Postgres enum is pinned against these members in
 * `packages/db/test/integration/enum-parity.test.ts`.
 */
export const INBOUND_EVENT_STATUSES = ['received', 'ignored', 'actioned'] as const

export type InboundEventStatus = (typeof INBOUND_EVENT_STATUSES)[number]

/** What each status is CALLED (`docs/ia.md` rule 3). `received` is the one that needs a word most:
 *  it means a process died between the insert and the settle, and "Received" alone would read as a
 *  success. */
export const INBOUND_EVENT_STATUS_LABEL: Record<InboundEventStatus, string> = {
  received: 'Recorded, not yet settled',
  ignored: 'Ignored',
  actioned: 'Changed the requirement',
}

/** Why a delivery changed nothing (M54 R4/R6/R7/R11, plan erratum E10). Four, closed. */
export const EXTERNAL_IGNORED_REASONS = [
  'unmapped_repository',
  'unrecognised_event',
  'workspace_archived',
  'request_refused',
] as const

export type ExternalIgnoredReason = (typeof EXTERNAL_IGNORED_REASONS)[number]

/** What each reason is CALLED. A `Record` over the union, so a fifth fails the build here rather
 *  than turning up in `triggers inbound`'s output as an identifier. */
export const EXTERNAL_IGNORED_REASON_LABEL: Record<ExternalIgnoredReason, string> = {
  unmapped_repository: 'No project is mapped to that repository',
  unrecognised_event: 'Not a kind this system acts on',
  workspace_archived: 'The project is archived',
  request_refused: 'The requirement already said exactly this',
}

/**
 * What became of one delivery (M54 R4, R11). Four arms, and the route turns each into one status
 * code: `actioned`, `ignored` and `replayed` are 200; `invalid` is 400.
 *
 * There is no refusal arm and no `ControlRefusal` anywhere in this path, which is R11's point: the
 * row insert commits, the events append, `requestChange` runs inside ITS OWN row-locked transaction
 * (`./goal.ts:96`), then the status update -- so every outcome after the insert is a STATUS, and the
 * rule that a refusal after a write inside a transaction must throw is satisfied by there being no
 * such refusal.
 */
export type IngestOutcome =
  | { readonly status: 'actioned'; readonly inboundEventId: string; readonly goalVersion: number }
  | { readonly status: 'ignored'; readonly inboundEventId: string; readonly reason: ExternalIgnoredReason }
  | { readonly status: 'replayed'; readonly inboundEventId: string }
  | { readonly status: 'invalid'; readonly reason: 'payload_invalid' }

/**
 * The order fields are given up in, longest and least load-bearing first (fix-round-1 erratum E19).
 *
 * `body` is the quoted prose and by far the largest; `title` is one line of the same prose; `url` is
 * a link the row can be read without; `action` is a label the `eventKind` already implies. Only then
 * `eventName`, which is the last thing that says WHAT arrived -- and by the arithmetic below it is
 * never reached.
 */
const PAYLOAD_DROP_ORDER = ['body', 'title', 'url', 'action', 'eventName'] as const

/** What each dropped field becomes: `null` where `InboundPayload` declares the field nullable, the
 *  empty string where it does not, so a dropped row is still a readable `InboundPayload` rather than
 *  a hole a consumer has to narrow around. */
const DROPPED_VALUE: Record<(typeof PAYLOAD_DROP_ORDER)[number], string | null> = {
  body: '',
  title: '',
  url: null,
  action: null,
  eventName: '',
}

/**
 * The normalised payload as it goes into the `Json` column, with the BYTE cap enforced here and
 * nowhere else (M54 R4, fix-round-1 erratum E19).
 *
 * The first version dropped `body` and returned WITHOUT measuring again, which is only sufficient if
 * every other field is bounded -- and two were not. The normaliser now caps all seven (erratum E19),
 * and this drops them in `PAYLOAD_DROP_ORDER`, RE-MEASURING after each one, until the row fits. The
 * flag is the normaliser's own `truncated`, reused rather than doubled: the question a reader has is
 * the same, is this stored text what arrived.
 *
 * **It cannot return a row over the cap.** The arithmetic, in code points times four bytes each:
 * `eventName` 100, `action` 100, `title` 300, `body` 2000, plus `repository` at 201 and `ref` at 40
 * ASCII characters (their regexes ARE their caps) and `url` under 500 UTF-16 units -- so the worst
 * arrival is about 12 KiB and the worst row after ONE drop is about 4.5 KiB. The first drop
 * therefore always suffices today; the four behind it exist so that a widened cap upstream degrades
 * a ROW instead of overflowing a COLUMN, and after all five the residue is `repository`, `ref` and
 * six empty fields -- under 400 bytes, whatever the caps say. `triggers.test.ts` pins both ends of
 * that: the worst-case floor against `INBOUND_PAYLOAD_MAX_BYTES`, and the drop order itself.
 *
 * Exported for that test alone. It is a pure function over a bounded record and the only place in
 * this milestone where a byte count decides anything, so it is worth being able to ask directly
 * rather than through a delivery the normaliser can no longer be made to produce.
 */
export function boundedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  let bounded = payload
  for (const field of PAYLOAD_DROP_ORDER) {
    if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= INBOUND_PAYLOAD_MAX_BYTES) return bounded
    bounded = { ...bounded, [field]: DROPPED_VALUE[field], truncated: true }
  }
  return bounded
}

/**
 * Five things in order, for one verified delivery (M54 R7): NORMALISE, MAP, RECORD, COMPOSE, SETTLE.
 *
 * NORMALISE is the adapter (`normaliseGitHubDelivery`) -- pure, and the only thing that reads a
 * provider's field names. A payload it refuses writes nothing and answers `invalid`.
 *
 * MAP is `(source, repository.full_name)` against `ExternalRepository`, which is why an
 * organisation-level hook delivering for several repositories resolves each delivery to the
 * repository it is actually about.
 *
 * RECORD is the FIRST write: one `InboundEvent` row, guarded by `@@unique([hookId, deliveryId])`
 * rather than by a pre-read, because a pre-query-then-insert has a race the constraint cannot have.
 * A P2002 means the delivery is already recorded, and the answer is the FIRST row's id and nothing
 * else at all.
 *
 * COMPOSE is `composeExternalRequest` through M40's existing `requestChange`, carrying the origin.
 * Nothing here creates a task, hires anybody or cancels anything: the delta re-plan turns the new
 * version into work and its cancellations into proposals a person approves.
 *
 * SETTLE moves `status` off `received` exactly once.
 *
 * `actor: 'system'` on both events, and there is no fourth `Actor` member (R5).
 */
export async function ingestExternalEvent(
  identity: HookIdentity,
  delivery: { readonly deliveryId: string; readonly eventName: string; readonly payload: unknown },
): Promise<IngestOutcome> {
  const normalised = normaliseGitHubDelivery(delivery.eventName, delivery.payload)
  if (!normalised.ok) return { status: 'invalid', reason: 'payload_invalid' }
  const { kind, recognised, origin, payload } = normalised.value

  const mapping = await prisma.externalRepository.findUnique({
    where: { source_repositoryFullName: { source: identity.source, repositoryFullName: origin.repository } },
    select: { workspaceId: true, workspace: { select: { archivedAt: true } } },
  })
  const workspaceId = mapping?.workspaceId ?? null

  let row: { id: string }
  try {
    row = await prisma.inboundEvent.create({
      data: {
        hookId: identity.hookId,
        source: identity.source,
        deliveryId: delivery.deliveryId,
        eventKind: kind,
        workspaceId,
        payload: boundedPayload({ ...payload }) as object,
      },
      select: { id: true },
    })
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error
    // A P2002 means some committed transaction holds the row, and nothing in this product deletes an
    // `InboundEvent` -- so a read in a new transaction sees it. `findUniqueOrThrow` says so rather
    // than inventing an empty id for a response whose shape the spec fixes.
    const seen = await prisma.inboundEvent.findUniqueOrThrow({
      where: { hookId_deliveryId: { hookId: identity.hookId, deliveryId: delivery.deliveryId } },
      select: { id: true },
    })
    return { status: 'replayed', inboundEventId: seen.id }
  }

  // R6: no workspace, no `ExecutionEvent` -- `ExecutionEvent.workspaceId` is NOT NULL and the log is
  // per-workspace by construction, so there is nowhere to write it. The ROW and R10's log line are
  // the honest pair of homes for a fact about a project this installation does not have.
  if (workspaceId === null) return await settleIgnored(row.id, 'unmapped_repository')

  await appendEvent({
    type: 'external.received',
    workspaceId,
    actor: 'system',
    payload: {
      inboundEventId: row.id,
      kind,
      kindLabel: EXTERNAL_KIND_LABEL[kind],
      deliveryId: delivery.deliveryId,
      origin,
    },
  })

  if (!recognised) return await settleIgnored(row.id, 'unrecognised_event')
  // The rule every write route follows through `archivedRefusal`. HALTED is deliberately not one of
  // these: halting stops dispatch, and a halted project's requirement can still legitimately change.
  if (mapping?.workspace.archivedAt != null) return await settleIgnored(row.id, 'workspace_archived')

  const changed = await requestChange(
    workspaceId,
    composeExternalRequest(kind, origin, payload.title, payload.body),
    undefined,
    new Date(),
    { origin },
  )
  if (!changed.ok) return await settleIgnored(row.id, 'request_refused')

  await prisma.inboundEvent.update({
    where: { id: row.id },
    data: { status: 'actioned', goalVersion: changed.value.version },
  })
  await appendEvent({
    type: 'external.actioned',
    workspaceId,
    actor: 'system',
    payload: {
      inboundEventId: row.id,
      kind,
      kindLabel: EXTERNAL_KIND_LABEL[kind],
      origin,
      goalVersion: changed.value.version,
      sha256: changed.value.sha256,
    },
  })
  return { status: 'actioned', inboundEventId: row.id, goalVersion: changed.value.version }
}

/** The one place `status` moves to `ignored`, so the reason and the status can never disagree. */
async function settleIgnored(inboundEventId: string, reason: ExternalIgnoredReason): Promise<IngestOutcome> {
  await prisma.inboundEvent.update({ where: { id: inboundEventId }, data: { status: 'ignored', ignoredReason: reason } })
  return { status: 'ignored', inboundEventId, reason }
}

/** One mapping, as every reader of this table sees it. There is no `secret` field because there is
 *  no `secret` column: the row names a variable, and nothing in this system holds what is in it. */
export interface ExternalRepositoryRecord {
  readonly id: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly source: ExternalSource
  readonly repository: string
  readonly hookId: string
  readonly secretEnvVar: string
  readonly hookPath: string
  readonly createdAt: Date
}

const SOURCE_RULE = `a source must be one of: ${EXTERNAL_SOURCES.join(', ')}`
const REPOSITORY_RULE =
  'a repository must be owner/repo, each half 1-100 characters of letters, digits, dots, dashes and underscores'

/**
 * Map one external repository to one project (M54 R6, R12).
 *
 * The value of the secret is NEVER read here. This verb validates the variable's NAME with the same
 * rule `addCredential` uses (plan erratum E1) and stores it; whether the variable is exported is a
 * question for verification time, and answering it here would tempt a later version to report WHICH
 * variables are set, which is an enumeration oracle pointed at the web process's environment.
 *
 * An already-mapped repository is REFUSED rather than re-mapped, including by the project that holds
 * it: `triggers unmap` then `triggers map` is how a variable changes, and it is one extra command
 * against a silent rebinding of somebody else's hook.
 *
 * Every refusal is returned BEFORE any write, so none of them is inside a transaction (R11).
 */
export async function mapExternalRepository(
  workspaceId: string,
  input: { readonly source: string; readonly repository: string; readonly secretEnvVar: string },
  _principal?: Principal,
): Promise<Result<ExternalRepositoryRecord, ControlRefusal>> {
  if (!(EXTERNAL_SOURCES as readonly string[]).includes(input.source)) {
    return err({ kind: 'invalid_name', detail: SOURCE_RULE })
  }
  const source = input.source as ExternalSource
  if (!REPOSITORY_FULL_NAME_RE.test(input.repository)) {
    return err({ kind: 'invalid_name', detail: REPOSITORY_RULE })
  }
  if (!ENV_VAR_RE.test(input.secretEnvVar)) return err({ kind: 'invalid_name', detail: ENV_VAR_RULE })

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const existing = await prisma.externalRepository.findUnique({
    where: { source_repositoryFullName: { source, repositoryFullName: input.repository } },
    select: { workspaceId: true },
  })
  if (existing !== null) {
    return err({
      kind: 'external_repository_mapped',
      source,
      repository: input.repository,
      workspaceId: existing.workspaceId,
    })
  }

  const row = await prisma.externalRepository.create({
    data: {
      workspaceId,
      source,
      repositoryFullName: input.repository,
      secretEnvVar: input.secretEnvVar,
    },
  })
  return ok(viewOf(row, workspace.name))
}

/** Take a mapping away (M54 R12). The off switch: there is no per-hook enable/disable flag, because
 *  two ways to stop a hook is one more than a person can remember. Every `InboundEvent` the mapping
 *  produced stays exactly where it is -- the row carries no foreign key for precisely this (R4). */
export async function unmapExternalRepository(
  workspaceId: string,
  input: { readonly source: string; readonly repository: string },
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (!(EXTERNAL_SOURCES as readonly string[]).includes(input.source)) {
    return err({ kind: 'invalid_name', detail: SOURCE_RULE })
  }
  const source = input.source as ExternalSource
  // Scoped to THIS project: a mapping in another one reads back the same as "does not exist" from a
  // scoped caller's side of the boundary (`message_not_found`'s rule).
  const { count } = await prisma.externalRepository.deleteMany({
    where: { workspaceId, source, repositoryFullName: input.repository },
  })
  if (count === 0) return err({ kind: 'external_repository_not_found', source, repository: input.repository })
  return ok(undefined)
}

/** Every mapping, or one project's (M54 R12). Newest first. `workspaceId: null` is every project,
 *  because an operator checking a fresh install is asking about the installation and not about one
 *  project -- `listEvidence`'s own choice for its own reason. */
export async function listExternalRepositories(
  workspaceId: string | null,
): Promise<readonly ExternalRepositoryRecord[]> {
  const rows = await prisma.externalRepository.findMany({
    where: workspaceId === null ? {} : { workspaceId },
    orderBy: { createdAt: 'desc' },
    include: { workspace: { select: { name: true } } },
  })
  return rows.map((row) => viewOf(row, row.workspace.name))
}

function viewOf(
  row: {
    id: string
    workspaceId: string
    source: ExternalSource
    repositoryFullName: string
    hookId: string
    secretEnvVar: string
    createdAt: Date
  },
  workspaceName: string,
): ExternalRepositoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName,
    source: row.source,
    repository: row.repositoryFullName,
    hookId: row.hookId,
    secretEnvVar: row.secretEnvVar,
    hookPath: hookPathFor(row.source, row.hookId),
    createdAt: row.createdAt,
  }
}

/** One delivery, as `triggers inbound` prints it (plan erratum E11). The `payload` is deliberately
 *  NOT on this shape: a line is a line, and the stored payload is one `psql` away for the operator
 *  who needs it. */
export interface InboundEventRecord {
  readonly id: string
  readonly receivedAt: Date
  readonly source: ExternalSource
  readonly repository: string
  readonly eventKind: ExternalEventKind
  readonly status: InboundEventStatus
  readonly ignoredReason: ExternalIgnoredReason | null
  readonly goalVersion: number | null
  readonly workspaceId: string | null
  readonly deliveryId: string
}

/**
 * What has arrived, newest first (plan erratum E11).
 *
 * R4 defends the `received` status with "a fact worth being able to SEE", and gives `ignoredReason`
 * and `goalVersion` their own columns so "why did my webhook do nothing" and "which version did it
 * produce" are answerable without a join -- and then the spec's surface list gives the table no
 * reader. This is it, and it is the CLI's alone: no page renders a `deliveryId` or a `hookId` (R9).
 *
 * `workspaceId: null` is every project, and it is the only way to see a delivery for a repository
 * nobody mapped -- which belongs to no project by construction.
 */
export async function listInboundEvents(filter: {
  readonly workspaceId: string | null
  readonly limit?: number
}): Promise<readonly InboundEventRecord[]> {
  const rows = await prisma.inboundEvent.findMany({
    where: filter.workspaceId === null ? {} : { workspaceId: filter.workspaceId },
    orderBy: { receivedAt: 'desc' },
    take: Math.min(filter.limit ?? LIST_INBOUND_LIMIT, LIST_INBOUND_LIMIT),
  })
  return rows.map((row) => {
    const payload = row.payload as { repository?: unknown }
    return {
      id: row.id,
      receivedAt: row.receivedAt,
      source: row.source,
      // Off the stored payload, which is where the normaliser put it -- never a join back to a
      // mapping that may have been unmapped since.
      repository: typeof payload.repository === 'string' ? payload.repository : '',
      eventKind: row.eventKind,
      status: row.status,
      ignoredReason: row.ignoredReason,
      goalVersion: row.goalVersion,
      workspaceId: row.workspaceId,
      deliveryId: row.deliveryId,
    }
  })
}
