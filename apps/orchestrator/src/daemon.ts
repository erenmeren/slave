import { prisma } from '@ai-team-os/db/client'
import type { WorkspaceId } from '@ai-team-os/domain'
import { subscribeEvents, type EventSubscription } from '@ai-team-os/events'
import type { AgentRuntimeAdapter } from '@ai-team-os/providers'
import { reconcileOrphans } from './sweep.js'
import { drainPumps, tick } from './tick.js'

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
export async function runDaemon(deps: DaemonDeps): Promise<void> {
  // Before the first tick, and never again. Task 15's pass treats a run with no pid as an orphan,
  // which is exactly what a run that is mid-spawn looks like -- so it is only sound while nothing
  // is spawning. `tick()` closes that window itself, and reconcileOrphans refuses afterwards.
  const reconciled = await reconcileOrphans({ workspaceId: deps.workspaceId, adapter: deps.adapter })
  if (reconciled > 0) {
    process.stdout.write(`reconciled ${reconciled} run(s) left behind by a previous process\n`)
  }

  let running = false
  let pending = false
  let stopped = false

  const runTick = async (): Promise<void> => {
    if (stopped) return
    if (running) {
      pending = true
      return
    }
    running = true
    try {
      const report = await tick(deps)
      if (report.started.length > 0 || report.halted !== null) {
        process.stdout.write(`${JSON.stringify(report)}\n`)
      }
    } catch (error) {
      // A failed tick must not take the daemon down: the next one reloads the world from scratch.
      process.stderr.write(`[daemon] tick failed: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      running = false
      if (pending && !stopped) {
        pending = false
        void runTick()
      }
    }
  }

  const timer = setInterval((): void => void runTick(), deps.periodMs)

  let subscription: EventSubscription | null = null
  const connectionString = process.env['DATABASE_URL']
  if (connectionString !== undefined && connectionString !== '') {
    subscription = await subscribeEvents(connectionString, (notification): void => {
      if (notification.workspaceId === deps.workspaceId) void runTick()
    })
  }

  void runTick()

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      stopped = true
      clearInterval(timer)
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })

  // Ordered, and all three awaited. The subscription's close can take seconds (its reconnect loop
  // has to be quiesced, not just told to stop), and a pump still writing when the process exits
  // loses the last events of a run that is otherwise finished.
  await subscription?.close()
  await drainPumps()
  await prisma.$disconnect()
  process.stdout.write('daemon stopped\n')
}
