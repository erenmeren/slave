import { prisma } from '@ai-team-os/db/client'
import type { WorkspaceId } from '@ai-team-os/domain'
import { subscribeEvents, type EventSubscription } from '@ai-team-os/events'
import type { AgentRuntimeAdapter } from '@ai-team-os/providers'
import { reconcileOrphans, sweep } from './sweep.js'
import { activePumpRunIds, drainPumps, tick } from './tick.js'

export interface DaemonDeps {
  readonly workspaceId: WorkspaceId
  readonly adapter: AgentRuntimeAdapter
  readonly hookPath: string
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
  const reconciled = await reconcileOrphans({ workspaceId: deps.workspaceId, adapter: deps.adapter })
  if (reconciled > 0) {
    process.stdout.write(`reconciled ${reconciled} run(s) left behind by a previous process\n`)
  }

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
      const swept = await sweep({ workspaceId: deps.workspaceId, adapter: deps.adapter, livePumpRunIds: activePumpRunIds })
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

  try {
    // The subscription is opened *before* the timer starts. Opened after, a failure here left an
    // interval running with no signal handlers installed: the CLI printed "startup failed", set a
    // non-zero exit code, and the process kept scheduling agents forever with nobody watching.
    const connectionString = process.env['DATABASE_URL']
    if (connectionString !== undefined && connectionString !== '') {
      subscription = await subscribeEvents(connectionString, (notification): void => {
        // A notification is a wake-up, not a delivery: every tick reloads the world, so a missed
        // one costs latency and never correctness.
        if (notification.workspaceId === deps.workspaceId) coalescer.wake()
      })
    }

    timer = setInterval((): void => coalescer.wake(), deps.periodMs)
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
    coalescer.stop()

    // Ordered, and every one of them reached. The tick in flight goes first because it may still be
    // provisioning and about to spawn -- without this the daemon printed "daemon stopped", drained
    // an empty pump set, disconnected Prisma, and *then* an in-flight tick started a fresh agent
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
