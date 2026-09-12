import { describeSync, drainModelCalls, syncSkillCatalog, tickSimulations, WORKTREE_TTL_MS, type ModelDecider } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { BROKER_TIMEOUT_MS, type WorkspaceId } from '@slave-of-ai/domain'
import { subscribeEvents, type EventSubscription } from '@slave-of-ai/events'
import type { AdapterRegistry } from '@slave-of-ai/providers'
import { serveBrokerRequests } from './broker.js'
import { collectWorktrees } from './collect.js'
import { reconcileOrphans, sweep } from './sweep.js'
import { activePumpRunIds, drainPumps, tick, type TickDeps } from './tick.js'

/**
 * Spec §3 B3: ten minutes, not the coalescer's ~1 Hz sweep. Ageing is measured in days
 * (`WORKTREE_TTL_MS`, seven of them) against a clock that only ticks forward once a task goes
 * terminal -- there is nothing for a sub-second wake-up to find that a ten-minute one would miss,
 * and running `collectWorktrees` on every tick would mean a `prisma.task.findMany` scan of every
 * terminal task in the workspace once a second, for a pass whose own trigger condition changes at
 * most once a day.
 */
export const COLLECT_PERIOD_MS = 10 * 60 * 1000

/**
 * How often the broker looks for new requests on the live runs' channels (M52 R3, fix round 1).
 *
 * Half a second, and its OWN cadence rather than the tick's, because the two passes now answer to
 * different clocks: a tick is a scheduling decision and once a second is plenty, while this is a
 * worker sitting blocked in a tool call waiting for an answer -- and the client polls for its reply
 * every 200 ms, so anything slower than this would be the dominant term in how long a brokered call
 * appears to take. The pass itself is a `stat` per live run when nobody has asked for anything,
 * which is nearly every pass.
 */
export const BROKER_PASS_MS = 500

export interface DaemonDeps {
  readonly workspaceId: WorkspaceId
  /** M12 Task 5: a registry, not a single adapter -- see `TickDeps.registry`'s own docstring. */
  readonly registry: AdapterRegistry
  readonly periodMs: number
  /**
   * M31a §4: how a simulation's `llm` run gets its decision. Optional, and absent in every test
   * that only exercises the loop -- a pass with no decider steps the rules runs and reports the
   * llm ones as `skippedNoDecider`, spending nothing. The daemon is the only production caller
   * that supplies one (`apps/orchestrator/src/cli.ts`'s `buildModelDecider`), which is what makes
   * "an llm run only ever steps in the daemon" true of the wiring and not just of a guard.
   */
  readonly modelDecider?: ModelDecider
  /**
   * M32 item 2: how many model calls this process may keep in flight at once. The calls happen
   * OFF the tick loop now, so without a cap one pass would start a child process for every due
   * llm run at once and every one of them would be spending. `cli.ts` reads
   * `SLAVEOFAI_MAX_MODEL_CALLS` (default 3) into this; a caller that omits it gets control's own
   * `DEFAULT_MAX_MODEL_CALLS`, which is the same number.
   */
  readonly maxConcurrentModelCalls?: number
  /**
   * M38 §5: the model the SUPERVISOR's decisions are asked of, read from the environment by
   * `cli.ts`. Separate from `modelDecider` because they are different facts -- the decider is HOW
   * a call is made, this is WHAT is asked -- and because M31a's simulation calls take their model
   * from the simulation intent, so there was no shared name to reuse (spec erratum E3).
   */
  readonly supervisorModel?: string
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

  // The daemon is the one production caller that hands the tick a model seam, and it hands over
  // the SAME decider M31a's simulations use (spec §5): one isolation contract, one deny-all hook,
  // one place the child process is configured. Built once rather than per tick -- it is a plain
  // object, and rebuilding it every second would say it could change between ticks.
  const tickDeps: TickDeps = {
    workspaceId: deps.workspaceId,
    registry: deps.registry,
    ...(deps.modelDecider === undefined ? {} : { supervisorDecider: deps.modelDecider }),
    ...(deps.supervisorModel === undefined ? {} : { supervisorModel: deps.supervisorModel }),
  }

  const coalescer = createCoalescer(async (): Promise<void> => {
    try {
      const report = await tick(tickDeps)
      if (
        report.started.length > 0 ||
        report.halted !== null ||
        report.planningStarted !== null ||
        report.reviewsStarted.length > 0 ||
        // A Supervisor decision is a change to the workspace nobody asked for -- an operator
        // reading the daemon's log must see the tick it happened on.
        report.supervisor.decided > 0
      ) {
        process.stdout.write(`${JSON.stringify(report)}\n`)
      }
      // M30 §5: auto-run stepping is a global pass, not part of `tick()` -- simulations belong to
      // a company, not to this daemon's workspace, and `decide()` stays pure (ADR 0004). Two
      // daemons both running this pass is safe: `autoStepDue` decides "due" under the row lock.
      const sims = await tickSimulations({
        now: new Date(),
        ...(deps.modelDecider !== undefined ? { modelDecider: deps.modelDecider } : {}),
        ...(deps.maxConcurrentModelCalls !== undefined ? { maxConcurrentModelCalls: deps.maxConcurrentModelCalls } : {}),
      })
      // `skippedNoDecider` is reported too (M31a §4): a daemon that was built without a decider
      // silently doing nothing for an armed llm run is exactly the failure an operator cannot
      // diagnose from the outside. `startedModelCalls` for the same reason (M32 item 2): a pass
      // that started a call finishes long before the call does, so without that line the log for a
      // busy llm run would read as a daemon doing nothing at all.
      //
      // `skippedInFlight` is NOT in this predicate, deliberately (M32 review): it is non-zero on
      // every pass for the whole life of a model call -- once a second, for minutes -- and a line
      // printed that often says nothing except that time is passing. The `startedModelCalls` line
      // already marks where the call began, and the run's journal records how it ended. The field
      // is still in the report the line PRINTS, so a pass that logs for another reason still shows
      // what it skipped.
      if (sims.stepped > 0 || sims.halted > 0 || sims.skippedNoDecider > 0 || sims.startedModelCalls > 0) process.stdout.write(`${JSON.stringify({ simulations: sims })}\n`)

      // The guardrail sweep -- run timeout, tool-call ceiling, dead pids -- lives with the daemon,
      // not inside `tick()`: it kills processes, which is a lifecycle concern like the startup
      // reconcile above, and a one-shot CLI `tick` cancelling runs it did not start would be a
      // surprise. Until M9 wired this line, `sweep()` had no production caller at all and the
      // runTimeoutMs / maxToolCallsPerRun limits were enforced by nothing.
      const swept = await sweep({ workspaceId: deps.workspaceId, registry: deps.registry, livePumpRunIds: activePumpRunIds })
      // M51 R2 (fix round 1, Important 5): the three breaker rungs are printed by the SAME
      // condition. Without them a tick whose only action was climbing the ladder wrote no line at
      // all -- an operator watching the daemon saw no sign of a run being steered, constrained or
      // stopped for going in circles, and the milestone gate had no stdout to assert a rung on. The
      // rung names are the `SweepReport` keys, so one line names both what happened and to which
      // runs.
      if (
        swept.timedOut.length > 0 ||
        swept.overToolCap.length > 0 ||
        swept.deadPids.length > 0 ||
        swept.strandedClaims.length > 0 ||
        swept.breakerSteered.length > 0 ||
        swept.breakerConstrained.length > 0 ||
        swept.breakerStopped.length > 0
      ) {
        process.stdout.write(`${JSON.stringify({ sweep: swept })}\n`)
      }
    } catch (error) {
      // A failed tick must not take the daemon down: the next one reloads the world from scratch.
      process.stderr.write(`[daemon] tick failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  })

  /**
   * The broker's pass (M52 R3), BESIDE the tick and never inside it (fix round 1, review
   * Important 3).
   *
   * Its own coalescer and its own interval, so a brokered operation -- up to `BROKER_TIMEOUT_MS`,
   * and this pass serves every pending request in turn -- cannot hold the tick's chain. The tick
   * coalescer drops wake-ups while one run is in flight, so an inline broker call froze dispatch,
   * the budget guardrail, the merge pass, the breaker beat, orphan reconciliation and the GLOBAL
   * simulation pass along with the sweep it lived in.
   *
   * Coalesced rather than fired blind, for the tick's own reason: a pass that takes two minutes
   * must produce exactly one more pass afterwards and not two hundred and forty. Two passes
   * therefore never overlap here -- and `serveBrokerRequests` keeps its own in-flight set anyway,
   * because a guard that depends on a caller's scheduling is not a guard.
   *
   * Its own log line, for the reason the sweep's rungs have one: a pass whose only action was
   * running a deploy on a worker's behalf must leave a mark an operator can find. The ids are
   * REQUEST ids -- what the reply file beside the run's channel is named.
   */
  const brokerPass = createCoalescer(async (): Promise<void> => {
    try {
      const served = await serveBrokerRequests({ workspaceId: deps.workspaceId })
      if (served.length > 0) process.stdout.write(`${JSON.stringify({ broker: { served } })}\n`)
    } catch (error) {
      // `serveBrokerRequests` promises never to throw; this is the daemon-lifetime closure that
      // makes the promise good at the boundary rather than asserting it, exactly as `runCollect`
      // above does for a pass with the same promise.
      process.stderr.write(`[broker] pass failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  })

  let subscription: EventSubscription | null = null
  let timer: NodeJS.Timeout | null = null
  let collectTimer: NodeJS.Timeout | null = null
  let brokerTimer: NodeJS.Timeout | null = null

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
    brokerTimer = setInterval((): void => brokerPass.wake(), BROKER_PASS_MS)
    coalescer.wake()
    brokerPass.wake()

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
    if (brokerTimer !== null) clearInterval(brokerTimer)
    coalescer.stop()
    brokerPass.stop()

    // Ordered, and every one of them reached. The tick in flight goes first because it may still be
    // provisioning and about to spawn -- without this the daemon printed "daemon stopped", drained
    // an empty pump set, disconnected Prisma, and *then* an in-flight tick started a fresh slave
    // nothing was left to supervise.
    await coalescer.inFlight()
    // M52 R3 (fix round 1): the brokered operation in flight, before Prisma goes. It is a real
    // deploy with a real child process, and abandoning it would leave the worker with a claim file,
    // no reply and no way to learn what happened -- the one outcome the claim protocol exists to
    // make rare. Bounded by `BROKER_TIMEOUT_MS`, which is the longest the operation itself may run:
    // past that the child has already been killed by its own deadline, so anything still pending
    // here is stuck on something this process cannot wait out.
    const drained = await Promise.race([
      brokerPass.inFlight().then((): true => true),
      new Promise<false>((settle) => setTimeout(() => settle(false), BROKER_TIMEOUT_MS).unref()),
    ])
    if (!drained) {
      process.stderr.write(
        `[broker] a brokered operation was still running after ${String(BROKER_TIMEOUT_MS)}ms; exiting without its reply\n`,
      )
    }
    try {
      await subscription?.close()
    } catch (error) {
      process.stderr.write(`[daemon] subscription close failed: ${String(error)}\n`)
    }
    await drainPumps()
    // M32 item 2: the model calls this process started are not on the tick's stack any more, so
    // `coalescer.inFlight()` above does not cover them. An apply is a database write -- the usage
    // row for a call the account has ALREADY been billed for (spec §2.6) -- so disconnecting
    // Prisma out from under one would lose exactly the record that must not be lost. No new call
    // can start behind this: the coalescer is stopped.
    await drainModelCalls()
    await prisma.$disconnect()
    process.stdout.write('daemon stopped\n')
  }
}
