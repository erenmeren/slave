import { describeSync, syncSkillCatalog, WORKTREE_TTL_MS } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import type { WorkspaceId } from '@slave-of-ai/domain'
import { subscribeEvents, type EventSubscription } from '@slave-of-ai/events'
import type { AdapterRegistry } from '@slave-of-ai/providers'
import { collectWorktrees } from './collect.js'
import { reconcileOrphans, sweep } from './sweep.js'
import { activePumpRunIds, drainPumps, tick } from './tick.js'

/**
 * Spec §3 B3: ten minutes, not the coalescer's ~1 Hz sweep. Ageing is measured in days
 * (`WORKTREE_TTL_MS`, seven of them) against a clock that only ticks forward once a task goes
 * terminal -- there is nothing for a sub-second wake-up to find that a ten-minute one would miss,
 * and running `collectWorktrees` on every tick would mean a `prisma.task.findMany` scan of every
 * terminal task in the workspace once a second, for a pass whose own trigger condition changes at
 * most once a day.
 */
export const COLLECT_PERIOD_MS = 10 * 60 * 1000

export interface DaemonDeps {
  readonly workspaceId: WorkspaceId
  /** M12 Task 5: a registry, not a single adapter -- see `TickDeps.registry`'s own docstring. */
  readonly registry: AdapterRegistry
  readonly periodMs: number
}

/**
 * The loop: a periodic timer and M2's notification channel, both waking the *same* tick.
 *
 * A notification is a wake-up, not a delivery (M2's rule, restated in spec §3.1): every tick
 * reloads the world from the database rather than trusting what it was told, so a missed
 * notification costs latency and never correctness.
 *
 * Ticks are coalesced rather than stacked. Provisioning is awaited inline and a setup command may
 * run for minutes while the timer fires every second, so without this a slow tick would be joined
 * by hundreds of others. Task 13 made two overlapping ticks *safe*; this makes them rare.
 */
/**
 * Coalesces wake-ups into runs of `work`.
 *
 * A wake arriving while `work` is in flight is *deferred*, never dropped and never stacked: at most
 * one run is pending at any moment, so a burst of notifications during a slow tick produces exactly
 * one more tick afterwards. Extracted rather than inlined so this can be tested without a database,
 * a timer or a child process -- Task 13's atomic claim makes overlapping ticks produce identical
 * state, which is precisely why nothing else can observe whether this works.
 */
export function createCoalescer(work: () => Promise<void>): {
  wake: () => void
  stop: () => void
  inFlight: () => Promise<void>
} {
  let running: Promise<void> | null = null
  let pending = false
  let stopped = false

  const run = (): void => {
    if (stopped || running !== null) {
      if (!stopped) pending = true
      return
    }
    running = work()
      .catch(() => undefined)
      .then((): void => {
        running = null
        if (pending && !stopped) {
          pending = false
          run()
        }
      })
  }

  return {
    wake: run,
    stop: (): void => {
      stopped = true
      pending = false
    },
    inFlight: async (): Promise<void> => {
      // Drains the chain, not just the current run: a tick that deferred another must not report
      // itself finished while the deferred one is still to come.
      while (running !== null) await running
    },
  }
}

export async function runDaemon(deps: DaemonDeps): Promise<void> {
  // Before the first tick, and never again. Task 15's pass treats a run with no pid as an orphan,
  // which is exactly what a run that is mid-spawn looks like -- so it is only sound while nothing
  // is spawning. `tick()` closes that window itself, and reconcileOrphans refuses afterwards.
  const reconciled = await reconcileOrphans({ workspaceId: deps.workspaceId, registry: deps.registry })
  if (reconciled > 0) {
    process.stdout.write(`reconciled ${reconciled} run(s) left behind by a previous process\n`)
  }

  // The catalog, once, before the first tick (M14 §4.3). Non-fatal: a host with no skills
  // directory is an ordinary host, and a daemon that refuses to start because it could not read
  // one is worse than a daemon with an empty catalog. A failed scan is simply skipped --
  // `orchestrator skills sync` is the operator's retry.
  try {
    process.stdout.write(describeSync(await syncSkillCatalog()))
  } catch (error) {
    process.stderr.write(
      `[daemon] skill catalog sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }

  // Spec §3 B2/B3. Never throws (`collectWorktrees` itself never does, but a daemon-lifetime
  // closure is the last line of defense against a future change breaking that contract) -- a
  // failed pass must not take the timer, or the daemon, down with it.
  const runCollect = async (): Promise<void> => {
    try {
      const report = await collectWorktrees({ workspaceId: deps.workspaceId, now: () => new Date(), ttlMs: WORKTREE_TTL_MS })
      for (const { taskId, path } of report.collected) {
        process.stdout.write(`[collect] task ${taskId} worktree ${path} collected (aged)\n`)
      }
    } catch (error) {
      process.stderr.write(`[collect] pass failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  await runCollect()

  const coalescer = createCoalescer(async (): Promise<void> => {
    try {
      const report = await tick(deps)
      if (
        report.started.length > 0 ||
        report.halted !== null ||
        report.planningStarted !== null ||
        report.reviewsStarted.length > 0
      ) {
        process.stdout.write(`${JSON.stringify(report)}\n`)
      }
      // The guardrail sweep -- run timeout, tool-call ceiling, dead pids -- lives with the daemon,
      // not inside `tick()`: it kills processes, which is a lifecycle concern like the startup
      // reconcile above, and a one-shot CLI `tick` cancelling runs it did not start would be a
      // surprise. Until M9 wired this line, `sweep()` had no production caller at all and the
      // runTimeoutMs / maxToolCallsPerRun limits were enforced by nothing.
      const swept = await sweep({ workspaceId: deps.workspaceId, registry: deps.registry, livePumpRunIds: activePumpRunIds })
      if (swept.timedOut.length > 0 || swept.overToolCap.length > 0 || swept.deadPids.length > 0) {
        process.stdout.write(`${JSON.stringify({ sweep: swept })}\n`)
      }
    } catch (error) {
      // A failed tick must not take the daemon down: the next one reloads the world from scratch.
      process.stderr.write(`[daemon] tick failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  })

  let subscription: EventSubscription | null = null
  let timer: NodeJS.Timeout | null = null
  let collectTimer: NodeJS.Timeout | null = null

  try {
    // The subscription is opened *before* the timer starts. Opened after, a failure here left an
    // interval running with no signal handlers installed: the CLI printed "startup failed", set a
    // non-zero exit code, and the process kept scheduling slaves forever with nobody watching.
    const connectionString = process.env['DATABASE_URL']
    if (connectionString !== undefined && connectionString !== '') {
      subscription = await subscribeEvents(connectionString, (notification): void => {
        // A notification is a wake-up, not a delivery: every tick reloads the world, so a missed
        // one costs latency and never correctness.
        if (notification.workspaceId === deps.workspaceId) coalescer.wake()
      })
    }

    timer = setInterval((): void => coalescer.wake(), deps.periodMs)
    collectTimer = setInterval((): void => void runCollect(), COLLECT_PERIOD_MS)
    coalescer.wake()

    await new Promise<void>((resolve) => {
      let shuttingDown = false
      const shutdown = (): void => {
        if (shuttingDown) {
          // The second signal is the universal "I mean it". Forcing is then a decision rather than
          // an accident -- and the first signal said what it was waiting for.
          process.stderr.write('forced: exiting without finishing the shutdown\n')
          process.exit(130)
        }
        shuttingDown = true
        process.stderr.write('stopping: finishing the tick in flight, then draining. Signal again to force.\n')
        resolve()
      }
      // `on`, not `once`: with `once` the second signal falls through to Node's default
      // disposition, which kills the process mid-drain and loses the rest of a run's events.
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
  } finally {
    if (timer !== null) clearInterval(timer)
    // An in-flight `runCollect` is not drained the way `coalescer.inFlight()` drains the tick
    // below: `collectTaskWorktree` is one atomic transaction, so a disconnect mid-flight either
    // fails cleanly (nothing committed, nothing to lose) or had already committed (nothing left
    // to drain) -- unlike a tick, there is no partial state a shutdown could catch it mid-write.
    // The pass simply retries on the next cycle, or the next process's startup call.
    if (collectTimer !== null) clearInterval(collectTimer)
    coalescer.stop()

    // Ordered, and every one of them reached. The tick in flight goes first because it may still be
    // provisioning and about to spawn -- without this the daemon printed "daemon stopped", drained
    // an empty pump set, disconnected Prisma, and *then* an in-flight tick started a fresh slave
    // nothing was left to supervise.
    await coalescer.inFlight()
    try {
      await subscription?.close()
    } catch (error) {
      process.stderr.write(`[daemon] subscription close failed: ${String(error)}\n`)
    }
    await drainPumps()
    await prisma.$disconnect()
    process.stdout.write('daemon stopped\n')
  }
}
