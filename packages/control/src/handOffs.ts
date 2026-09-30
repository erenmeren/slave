import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  CONDUCTOR_ROLE,
  HANDOFF_EVENT_CHANGE_MAX_CHARS,
  HANDOFF_REOPENS_MAX,
  handOffFingerprint,
  renderHandOffQuestion,
  renderHandOffRework,
  resolveHandOff,
  storableText,
  trimToFit,
  handOffItemSchema,
  type HandOffItem,
  type HandOffView,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { expirePendingHandOffs, goalEventWith, withDeliveryLock } from './goalDelivery.js'
import { handOffQuestionKey, sendMessage } from './messaging.js'
import { isTransactionTimeout } from './prisma-errors.js'
import { refusalText } from './refusal.js'

/**
 * Supervisor-as-conductor spec C2: a package's hand-offs reach the package that owns the change.
 * Routing is the ownership rule's (ruling 1): `resolveHandOff`, the rule the gate and the diff audit
 * enforce. A finished target is reopened (`reopenForHandOffs`), one that has not finished reads the
 * request in its next prompt (`listHandOffsFor`), and one nobody can take becomes a conductor
 * question (`sendHandOffQuestions`) -- never dropped.
 */

type Tx = Prisma.TransactionClient

export interface RouteHandOffsInput {
  readonly workspaceId: string
  readonly goalVersion: number
  readonly source: 'report' | 'answer'
  /** `report:<runId>` or (Plan B) `answer:<decisionId>`; item i is stored under `<sourceKey>:<i>`. */
  readonly sourceKey: string
  /** The run whose report carried it (or whose question the answer answered): a question sender. */
  readonly fromRunId: string
  /** The reporting package; null for a conductor answer, which is nobody's own (Plan B). */
  readonly fromPackageKey: string | null
  readonly items: readonly HandOffItem[]
}

/** How a routed hand-off reaches its target, as `workspace.package_handed_off` names it. */
type Delivery = 'prompt' | 'rework' | 'duplicate' | 'own' | 'question'

/** One stored row, as the model's default select returns it. */
type HandOffRow = Prisma.PackageHandOffModel

/** Hand-offs of one report share a transaction, so `createdAt` ties; `sourceKey` (`...:<index>`) breaks them. */
const HAND_OFF_ORDER = [{ createdAt: 'asc' as const }, { sourceKey: 'asc' as const }]

/** The statuses a request is "on record" in, for the per-version dedup (plan A D6). */
const ON_RECORD = ['pending', 'reopened', 'delivered'] as const

/** A target task in one of these can take no more work: the request becomes a conductor question. */
const CANNOT_TAKE: ReadonlySet<string> = new Set(['failed', 'cancelled'])

/** Thrown inside the lock when a guarded move lost its race: rolls every move of the pass back. */
class HandOffMoved extends Error {}

/**
 * The version's lock for routing (plan A D4, D6). The delivery's advisory lock when there is a
 * delivery, so a routing and a reopen pass never interleave; inside it -- and alone for a version
 * conducted before Plan 4a wrote a delivery -- a second advisory lock on the workspace and version.
 * That second lock is what makes the dedup safe: `fingerprint` has no unique index (a duplicate is
 * a row too, and a later version may repeat a request), so the "already on record?" read and the
 * insert must be serialised per version, and the delivery row may be created between the lookup
 * and the lock. Order is always delivery lock, then version lock; nothing takes them the other way.
 * `deliveryId` null takes the version lock alone: the announcement pass needs no more.
 */
async function withVersionLock<T>(deliveryId: string | null, workspaceId: string, goalVersion: number, work: (tx: Tx) => Promise<T>): Promise<T> {
  const locked = async (tx: Tx): Promise<T> => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`slaveofai:hand-offs:${workspaceId}:v${String(goalVersion)}`}))`
    return work(tx)
  }
  return deliveryId === null ? prisma.$transaction(locked, { maxWait: 10_000, timeout: 30_000 }) : withDeliveryLock(deliveryId, locked)
}

/** The version's packages with their one task (plan A D2: the oldest, as every rework path reads it). */
async function packagesOf(tx: Tx, workspaceId: string, goalVersion: number) {
  return tx.workPackage.findMany({
    where: { workspaceId, goalVersion },
    orderBy: { key: 'asc' },
    select: {
      id: true,
      key: true,
      ownedPaths: true,
      isIntegration: true,
      handOffReopens: true,
      tasks: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1, select: { id: true, status: true, attempt: true } },
    },
  })
}

/** A stored row as the domain renderers read it. */
export function handOffView(row: {
  readonly id: string
  readonly fromPackageKey: string | null
  readonly path: string | null
  readonly packageKey: string | null
  readonly change: string
}): HandOffView {
  return { id: row.id, from: row.fromPackageKey, path: row.path, packageKey: row.packageKey, change: row.change }
}

/** Controller ruling F8: stored worker text never carries a NUL byte or a lone surrogate (spec §5). */
function storableItem(item: HandOffItem): HandOffItem {
  const change = storableText(item.change).trim()
  return 'path' in item ? { path: storableText(item.path).trim(), change } : { package: storableText(item.package).trim(), change }
}

/**
 * Ruling F2: the delivery a row already on record was routed as, for a replay that announces it
 * again (its event may have been lost to a crash between the routing and the announcement).
 */
function deliveryOf(row: HandOffRow, targetStatus: string | undefined): Delivery {
  switch (row.status) {
    case 'reopened':
      return 'rework'
    case 'to_conductor':
      return 'question'
    case 'own':
      return 'own'
    case 'duplicate':
      return 'duplicate'
    default:
      return targetStatus === 'done' ? 'rework' : 'prompt'
  }
}

/**
 * Spec C2: stores each item once (`<sourceKey>:<i>`, the replay guard), routed by the ownership rule,
 * then announces every row (once each), sends the conductor questions, and runs a reopen pass. The
 * check-then-insert of the per-version dedup runs under {@link withVersionLock}, so two concurrent
 * filings of the same request store one `pending` and one `duplicate`. Must not be called while
 * holding the version's delivery lock (the lock is not re-entrant across transactions).
 */
export async function routeHandOffs(input: RouteHandOffsInput): Promise<readonly { readonly id: string; readonly status: string }[]> {
  if (input.items.length === 0) return []
  const { workspaceId, goalVersion } = input
  const delivery = await prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { id: true } })
  const routed = await withVersionLock(delivery?.id ?? null, workspaceId, goalVersion, async (tx) => {
    const packages = await packagesOf(tx, workspaceId, goalVersion)
    const taskOf = (key: string | null) => packages.find((pkg) => pkg.key === key)?.tasks[0]
    const out: { readonly row: HandOffRow; readonly delivery: Delivery }[] = []
    for (const [index, raw] of input.items.entries()) {
      const sourceKey = `${input.sourceKey}:${String(index)}`
      const seen = await tx.packageHandOff.findUnique({ where: { workspaceId_sourceKey: { workspaceId, sourceKey } } })
      if (seen !== null) {
        out.push({ row: seen, delivery: deliveryOf(seen, taskOf(seen.toPackageKey)?.status) })
        continue
      }
      const item = storableItem(raw)
      const target = resolveHandOff(item, input.fromPackageKey, packages)
      const toKey = target.kind === 'package' ? target.key : target.kind === 'own' ? input.fromPackageKey : null
      const task = taskOf(toKey)
      const fingerprint = handOffFingerprint({ from: input.fromPackageKey, to: toKey ?? '', item })
      let status: 'pending' | 'duplicate' | 'own' | 'to_conductor' = 'pending'
      let note: string | null = null
      let routedAs: Delivery = task?.status === 'done' ? 'rework' : 'prompt'
      if (target.kind === 'none') {
        status = 'to_conductor'
        note = `no target found: ${target.reason}`
        routedAs = 'question'
      } else if (target.kind === 'own') {
        status = 'own'
        note = 'the reporting package owns it'
        routedAs = 'own'
      } else if (task === undefined || CANNOT_TAKE.has(task.status)) {
        status = 'to_conductor'
        note = `the ${target.key} package cannot take it: its task is ${task?.status ?? 'gone'}`
        routedAs = 'question'
      } else if (
        (await tx.packageHandOff.findFirst({ where: { workspaceId, goalVersion, fingerprint, status: { in: [...ON_RECORD] } }, select: { id: true } })) !== null
      ) {
        status = 'duplicate'
        note = 'the same request is already on record'
        routedAs = 'duplicate'
      }
      const row = await tx.packageHandOff.create({
        data: {
          workspaceId,
          goalVersion,
          source: input.source,
          sourceKey,
          fromRunId: input.fromRunId,
          fromPackageKey: input.fromPackageKey,
          toPackageKey: toKey,
          path: 'path' in item ? item.path : null,
          packageKey: 'package' in item ? item.package : null,
          change: item.change,
          fingerprint,
          status,
          note,
        },
      })
      out.push({ row, delivery: routedAs })
    }
    return out
  })
  // Task 5 review minor 3: the check-then-append of each event under the version lock, so two
  // concurrent replays of one report cannot both find it missing. After the routing commits: an
  // event must never name a row a rolled-back routing never stored.
  await withVersionLock(null, workspaceId, goalVersion, async (tx) => {
    for (const { row, delivery: routedAs } of routed) await announceHandOff(tx, row, routedAs)
  })
  await sendHandOffQuestions(workspaceId)
  if (delivery !== null) {
    try {
      await reopenForHandOffs(delivery.id)
    } catch (error) {
      // Task 5 review minor 2: the rows are stored and announced; a reopen that could not get the
      // delivery's lock (a final merge holding it) is the goal pass's next reopen to do, not a reason
      // to fail the filing. Not forced in a test: only a lock held past the waiter's 120 s timeout, or a pool with no free
      // connection for 10 s, reaches it.
      if (!isTransactionTimeout(error)) throw error
      console.error(`[hand-off] goal v${String(goalVersion)}: the reopen waits for the next goal pass -- the delivery lock was busy`)
    }
  }
  return prisma.packageHandOff.findMany({
    where: { workspaceId, sourceKey: { in: input.items.map((_, index) => `${input.sourceKey}:${String(index)}`) } },
    orderBy: { sourceKey: 'asc' },
    select: { id: true, status: true },
  })
}

/**
 * Task 6 ruling (review I1): the goal pass's backstop for a filing whose routing never landed -- a
 * busy delivery lock after every retry, or a daemon that died between storing the report and
 * routing it. Every `RunReport` of the version that carries hand-offs and has no row at its first
 * position (`report:<runId>:0`; a routing stores a report's items in one transaction, so the first
 * row stands for all of them) is routed now. One query, and nothing else, when there is nothing to
 * route. Idempotent by `sourceKey`, like the filing it stands in for, and it must run with no lock
 * held (`routeHandOffs`'s rule).
 */
export async function routeStoredHandOffs(deliveryId: string): Promise<void> {
  const unrouted = await prisma.$queryRaw<{ runId: string; handOffs: unknown; packageKey: string; workspaceId: string; goalVersion: number }[]>`
    SELECT r."runId", r.report -> 'handOffs' AS "handOffs", p.key AS "packageKey", d."workspaceId", d."goalVersion"
    FROM "GoalDelivery" d
    JOIN "WorkPackage" p ON p."workspaceId" = d."workspaceId" AND p."goalVersion" = d."goalVersion"
    JOIN "RunReport" r ON r."workPackageId" = p.id
    WHERE d.id = ${deliveryId}
      AND CASE WHEN jsonb_typeof(r.report -> 'handOffs') = 'array' THEN jsonb_array_length(r.report -> 'handOffs') ELSE 0 END > 0
      AND NOT EXISTS (
        SELECT 1 FROM "PackageHandOff" h WHERE h."workspaceId" = d."workspaceId" AND h."sourceKey" = 'report:' || r."runId" || ':0'
      )
    ORDER BY r."createdAt", r."runId"`
  for (const report of unrouted) {
    const items = Array.isArray(report.handOffs) ? report.handOffs.map((item) => handOffItemSchema.safeParse(item)) : []
    if (items.length === 0 || items.some((item) => !item.success)) {
      // Positions are the keys: a report whose items cannot all be read is not routed in part.
      console.error(`[hand-off] run ${report.runId}: its stored report's hand-offs cannot be read -- not routed`)
      continue
    }
    await routeHandOffs({
      workspaceId: report.workspaceId,
      goalVersion: report.goalVersion,
      source: 'report',
      sourceKey: `report:${report.runId}`,
      fromRunId: report.runId,
      fromPackageKey: report.packageKey,
      items: items.flatMap((item) => (item.success ? [item.data] : [])),
    })
  }
}

/** Plan A D8: the row's event, once -- a replay finds it by `handOffId` and writes nothing. Called
 *  under the version lock and read on its `tx`, which sees every event committed before the grant. */
async function announceHandOff(tx: Tx, row: HandOffRow, delivery: Delivery): Promise<void> {
  const said = await tx.executionEvent.findFirst({
    where: { workspaceId: row.workspaceId, type: 'workspace_package_handed_off', payload: { path: ['handOffId'], equals: row.id } },
    select: { seq: true },
  })
  if (said !== null) return
  await appendEvent({
    type: 'workspace.package_handed_off',
    workspaceId: row.workspaceId,
    actor: 'system',
    payload: {
      version: row.goalVersion,
      handOffId: row.id,
      source: row.source,
      fromPackage: row.fromPackageKey,
      toPackage: row.toPackageKey,
      path: row.path,
      package: row.packageKey,
      delivery,
      // Ruling F1: `trimEvidence` alone overshoots its bound by the cut marker; the schema refuses that.
      change: trimToFit(row.change, HANDOFF_EVENT_CHANGE_MAX_CHARS),
    },
  })
}

/**
 * Plan A D7: every `to_conductor` row without its question gets one, sent from the run that carried
 * the hand-off, under a key with the report prefix (so it stays pending: nobody is parked on it).
 * Idempotent by key, and run after every routing and every reopen pass, so a crash between the row
 * and the message is repaired by the next pass.
 */
export async function sendHandOffQuestions(workspaceId: string): Promise<void> {
  const rows = await prisma.packageHandOff.findMany({ where: { workspaceId, status: 'to_conductor', questionMessageId: null }, orderBy: HAND_OFF_ORDER })
  for (const row of rows) {
    const run = await prisma.slaveRun.findUnique({ where: { id: row.fromRunId }, select: { taskId: true } })
    const sent = await sendMessage(row.fromRunId, {
      kind: 'question',
      body: renderHandOffQuestion({ view: handOffView(row), reason: row.note ?? 'no target found' }),
      recipientRole: CONDUCTOR_ROLE,
      expectsReply: true,
      taskId: run?.taskId ?? null,
      idempotencyKey: handOffQuestionKey(row.fromRunId, row.id),
    })
    if (!sent.ok) {
      console.error(`[hand-off] ${row.id}: its conductor question was not sent -- ${refusalText(sent.error)}`)
      continue
    }
    await prisma.packageHandOff.updateMany({ where: { id: row.id, questionMessageId: null }, data: { questionMessageId: sent.value.id } })
  }
}

/**
 * Plan A D3/D4/D5: under the delivery's lock, every `pending` hand-off of the version is settled
 * against its target's task. Not finished: it waits for the target's next prompt. Finished and shown
 * to a run: `delivered`. Finished and never shown: the task is reopened (`done -> rework`, no attempt
 * charged) -- only while the version is `integrating` with no smoke or verification claim, and at
 * most `HANDOFF_REOPENS_MAX` times per package, after which the rows become conductor questions naming
 * the chain. Only the rows the rework reason shows whole are marked `reopened`; the rest stay
 * `pending` and reach the reopened run's prompt. An accepted or abandoned version's rows expire (a
 * backstop: `acceptInLock` and `abandonGoal` expire them in the move). The Plan 4b order: checks,
 * then the event (only if missing), then guarded moves that THROW when they lose.
 */
export async function reopenForHandOffs(deliveryId: string): Promise<void> {
  const head = await prisma.goalDelivery.findUnique({ where: { id: deliveryId }, select: { workspaceId: true, goalVersion: true } })
  if (head === null) return
  // Ruling F12: no lock for a version with nothing pending -- a final merge can hold it for minutes.
  const waiting = await prisma.packageHandOff.count({ where: { workspaceId: head.workspaceId, goalVersion: head.goalVersion, status: 'pending' } })
  if (waiting > 0) {
    try {
      await withDeliveryLock(deliveryId, async (tx) => reopenInLock(tx, deliveryId))
    } catch (error) {
      if (!(error instanceof HandOffMoved)) throw error
    }
  }
  await sendHandOffQuestions(head.workspaceId)
}

async function reopenInLock(tx: Tx, deliveryId: string): Promise<void> {
  const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
  const { workspaceId, goalVersion } = delivery
  if (delivery.status === 'accepted' || delivery.status === 'abandoned') {
    await expirePendingHandOffs(tx, workspaceId, goalVersion, delivery.status)
    return
  }
  const pending = await tx.packageHandOff.findMany({ where: { workspaceId, goalVersion, status: 'pending' }, orderBy: HAND_OFF_ORDER })
  if (pending.length === 0) return
  const mayReopen = delivery.status === 'integrating' && delivery.activeSmokeId === null && delivery.activeRunId === null
  for (const pkg of await packagesOf(tx, workspaceId, goalVersion)) {
    const mine = pending.filter((row) => row.toPackageKey === pkg.key)
    const task = pkg.tasks[0]
    if (mine.length === 0) continue
    if (task === undefined || CANNOT_TAKE.has(task.status)) {
      await tx.packageHandOff.updateMany({
        where: { id: { in: mine.map((row) => row.id) }, status: 'pending' },
        data: { status: 'to_conductor', note: `the ${pkg.key} package cannot take it: its task is ${task?.status ?? 'gone'}` },
      })
      continue
    }
    if (task.status !== 'done') continue
    const shown = mine.filter((row) => row.shownInRunId !== null)
    const unseen = mine.filter((row) => row.shownInRunId === null)
    if (shown.length > 0) {
      await tx.packageHandOff.updateMany({ where: { id: { in: shown.map((row) => row.id) }, status: 'pending' }, data: { status: 'delivered' } })
    }
    if (unseen.length === 0 || !mayReopen) continue
    if (pkg.handOffReopens >= HANDOFF_REOPENS_MAX) {
      const chain = await tx.packageHandOff.findMany({
        where: { workspaceId, goalVersion, toPackageKey: pkg.key, status: 'reopened' },
        orderBy: HAND_OFF_ORDER,
        select: { fromPackageKey: true },
      })
      const from = [...new Set(chain.map((row) => row.fromPackageKey ?? 'the conductor'))].join(', from ')
      await tx.packageHandOff.updateMany({
        where: { id: { in: unseen.map((row) => row.id) }, status: 'pending' },
        data: {
          status: 'to_conductor',
          note: `the ${pkg.key} package has already been reopened ${String(HANDOFF_REOPENS_MAX)} times in goal v${String(goalVersion)} by other packages' hand-offs (from ${from})`,
        },
      })
      continue
    }
    // Task 2 ruling: the reason adds requests WHOLE while they fit; only those are delivered by this
    // reopen, and a reason that shows none reopens nothing.
    const reason = renderHandOffRework(unseen.map(handOffView))
    if (reason.shownIds.length === 0) continue
    const reopen = pkg.handOffReopens + 1
    if (!(await goalEventWith(tx, workspaceId, 'task_rework', { handOffReopen: reopen }, { taskId: task.id }))) {
      await appendEvent({
        type: 'task.rework',
        workspaceId,
        taskId: task.id,
        actor: 'system',
        // Plan A D4: no attempt is charged -- the loop guard bounds this, as the round cap bounds a verification rework.
        payload: { reason: reason.text, attempt: task.attempt, handOffReopen: reopen },
      })
    }
    const counted = await tx.workPackage.updateMany({ where: { id: pkg.id, handOffReopens: pkg.handOffReopens }, data: { handOffReopens: reopen } })
    if (counted.count === 0) throw new HandOffMoved()
    const moved = await tx.task.updateMany({
      where: { id: task.id, status: 'done' },
      data: { status: 'rework', integratedAt: null, activeRunId: null, lastRejectionReason: reason.text },
    })
    if (moved.count === 0) throw new HandOffMoved()
    const marked = await tx.packageHandOff.updateMany({
      where: { id: { in: [...reason.shownIds] }, status: 'pending' },
      data: { status: 'reopened', reopenedAt: new Date() },
    })
    if (marked.count !== reason.shownIds.length) throw new HandOffMoved()
  }
}

/** Plan A D3: every hand-off a package's prompt lists -- asked of it, not refused -- oldest first. */
export async function listHandOffsFor(workspaceId: string, goalVersion: number, packageKey: string): Promise<StoredHandOff[]> {
  return prisma.packageHandOff.findMany({
    where: { workspaceId, goalVersion, toPackageKey: packageKey, status: { in: [...ON_RECORD] } },
    orderBy: HAND_OFF_ORDER,
  })
}

/** One stored hand-off, every column. */
export type StoredHandOff = Prisma.PackageHandOffModel

/** Plan A D3: the run whose prompt listed these rows, stamped by id (a row created after the read is not stamped). */
export async function markHandOffsShown(runId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await prisma.packageHandOff.updateMany({ where: { id: { in: [...ids] }, status: { in: ['pending', 'reopened'] } }, data: { shownInRunId: runId } })
}
