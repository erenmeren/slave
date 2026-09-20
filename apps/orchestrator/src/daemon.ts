import { hostname } from 'node:os'
import { describeSync, drainIntakeCalls, drainModelCalls, reconcileTemplateCapabilities, syncSkillCatalog, tickCapabilityMapping, tickIntakes, tickSimulations, WORKTREE_TTL_MS, type ModelDecider } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { BROKER_TIMEOUT_MS, SUPERVISOR_DEFAULT_MODEL, workspaceId as brandWorkspaceId, type WorkspaceId } from '@slave-of-ai/domain'
import { subscribeEvents, type EventSubscription } from '@slave-of-ai/events'
import type { AdapterRegistry } from '@slave-of-ai/providers'
import { serveBrokerRequests } from './broker.js'
import { collectWorktrees } from './collect.js'
import { hasTickRun, reconcileOrphans, sweep } from './sweep.js'
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

/**
 * How often the daemon looks for a project it is not serving yet (M59 R15).
 *
 * Ten seconds: a project is created by a person pressing a button, and the wait between that and
 * its first tick is the whole of "everything happens by itself" as far as they can tell. It is
 * also the ceiling rather than the usual case -- a `workspace.created` NOTIFICATION arms a
 * discovery pass immediately (plan erratum E9), and this timer is what catches an archive, a
 * restore, and a project created while the subscription was reconnecting.
 */
export const DAEMON_DISCOVERY_MS = 10_000

export interface WorkspaceLoopDeps {
  readonly workspaceId: WorkspaceId
  /** M12 Task 5: a registry, not a single adapter -- see `TickDeps.registry`'s own docstring. */
  readonly registry: AdapterRegistry
  readonly periodMs: number
  /**
   * M31a §4: the model seam the tick's Supervisor decision is made through. Optional, and absent in
   * every test that only exercises the loop. The daemon is the only production caller that supplies
   * one (`apps/orchestrator/src/cli.ts`'s `buildModelDecider`), which is what makes "a decision is
   * only ever asked for in the daemon" true of the wiring and not just of a guard.
   */
  readonly modelDecider?: ModelDecider
  /**
   * M38 §5: the model the SUPERVISOR's decisions are asked of, read from the environment by
   * `cli.ts`. Separate from `modelDecider` because they are different facts -- the decider is HOW
   * a call is made, this is WHAT is asked -- and because M31a's simulation calls take their model
   * from the simulation intent, so there was no shared name to reuse (spec erratum E3).
   */
  readonly supervisorModel?: string
}

/** One project's loop, as the process holds it. `wake` is what a notification for this workspace
 *  calls; `stop` drains it the way today's `finally` drains the only one there was. */
export interface WorkspaceLoop {
  readonly workspaceId: WorkspaceId
  wake(): void
  stop(): Promise<void>
}

/**
 * Everything the daemon does FOR ONE PROJECT (M59 R15): orphan reconciliation at startup, the
 * worktree collector, the tick coalescer (tick + sweep) and the broker pass.
 *
 * This is today's `runDaemon` body, verbatim in behaviour, minus the four things that belong to the
 * PROCESS rather than to a project -- the skill-catalogue sync, the LISTEN subscription, the global
 * simulation/intake pass, and the signal handling -- which {@link runDaemon} now owns and runs
 * once however many loops there are.
 */
export async function startWorkspaceLoop(deps: WorkspaceLoopDeps): Promise<WorkspaceLoop> {
  // Before the first tick OF THIS PROJECT, and never again. Task 15's pass treats a run with no pid
  // as an orphan, which is exactly what a run that is mid-spawn looks like -- so it is only sound
  // while nothing is spawning here, which for a project no loop is serving yet is true. `tick()`
  // closes that window itself (`noteTickRan`), per workspace since erratum E11, and
  // `reconcileOrphans` refuses for this project afterwards.
  // A loop can return in this SAME process after archive/restore. Its previous stop drained the
  // tick, so there is no startup orphan pass to run; calling it would hit the guard below and abort
  // the discovery pass before later projects can start. A first loop still calls reconcile and
  // therefore still throws if it races a tick.
  const reconciled = hasTickRun(deps.workspaceId)
    ? 0
    : await reconcileOrphans({ workspaceId: deps.workspaceId, registry: deps.registry })
  if (reconciled > 0) {
    process.stdout.write(`reconciled ${reconciled} run(s) left behind by a previous process\n`)
  }

  // Spec §3 B2/B3. Never throws (`collectWorktrees` itself never does, but a loop-lifetime closure
  // is the last line of defense against a future change breaking that contract) -- a failed pass
  // must not take the timer, or the daemon, down with it.
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
        report.supervisor.decided > 0 ||
        // Task 5 (Important review finding): a role no seat carries is exactly the silent
        // failure `unservedRoles` exists to surface (`world.ts`'s own doc comment) -- a board
        // stuck on it trips none of the conditions above, tick after tick, and without this the
        // predicate's own log would stay as silent as the scheduler it is reporting on.
        report.unservedRoles.length > 0
      ) {
        process.stdout.write(`${JSON.stringify(report)}\n`)
      }

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
      // `serveBrokerRequests` promises never to throw; this is the loop-lifetime closure that
      // makes the promise good at the boundary rather than asserting it, exactly as `runCollect`
      // above does for a pass with the same promise.
      process.stderr.write(`[broker] pass failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  })

  // Nothing between here and the `return` can throw, which is what lets `runDaemon` hold every loop
  // it starts: a loop whose timers are running is always one the caller has a handle to stop.
  const timer = setInterval((): void => coalescer.wake(), deps.periodMs)
  const collectTimer = setInterval((): void => void runCollect(), COLLECT_PERIOD_MS)
  const brokerTimer = setInterval((): void => brokerPass.wake(), BROKER_PASS_MS)
  coalescer.wake()
  brokerPass.wake()

  return {
    workspaceId: deps.workspaceId,
    wake: (): void => coalescer.wake(),
    stop: async (): Promise<void> => {
      clearInterval(timer)
      // An in-flight `runCollect` is not drained the way `coalescer.inFlight()` drains the tick
      // below: `collectTaskWorktree` is one atomic transaction, so a disconnect mid-flight either
      // fails cleanly (nothing committed, nothing to lose) or had already committed (nothing left
      // to drain) -- unlike a tick, there is no partial state a shutdown could catch it mid-write.
      // The pass simply retries on the next cycle, or the next process's startup call.
      clearInterval(collectTimer)
      clearInterval(brokerTimer)
      coalescer.stop()
      brokerPass.stop()

      // Ordered, and every one of them reached. The tick in flight goes first because it may still
      // be provisioning and about to spawn -- without this the daemon printed "daemon stopped",
      // drained an empty pump set, disconnected Prisma, and *then* an in-flight tick started a
      // fresh slave nothing was left to supervise.
      await coalescer.inFlight()
      // M52 R3 (fix round 1): the brokered operation in flight, before Prisma goes. It is a real
      // deploy with a real child process, and abandoning it would leave the worker with a claim
      // file, no reply and no way to learn what happened -- the one outcome the claim protocol
      // exists to make rare. Bounded by `BROKER_TIMEOUT_MS`, which is the longest the operation
      // itself may run: past that the child has already been killed by its own deadline, so
      // anything still pending here is stuck on something this process cannot wait out.
      const drained = await Promise.race([
        brokerPass.inFlight().then((): true => true),
        new Promise<false>((settle) => setTimeout(() => settle(false), BROKER_TIMEOUT_MS).unref()),
      ])
      if (!drained) {
        process.stderr.write(
          `[broker] a brokered operation was still running after ${String(BROKER_TIMEOUT_MS)}ms; exiting without its reply\n`,
        )
      }
    },
  }
}

export interface DaemonDeps {
  /**
   * `'all'` -- every active project, and every one created while this process runs (M59 R15, D5) --
   * or one project's id, which is exactly today's behaviour. The CLI passes `'all'` when no
   * `--workspace` was given, which is what makes `docker/entrypoint.sh`'s bare `daemon` correct by
   * construction on an installation with two projects.
   */
  readonly workspaceIds: 'all' | WorkspaceId
  /** M12 Task 5: a registry, not a single adapter -- see `TickDeps.registry`'s own docstring. One
   *  registry for every loop: a provider is configured per process, not per project. */
  readonly registry: AdapterRegistry
  readonly periodMs: number
  /**
   * M31a §4: how a simulation's `llm` run gets its decision, and how the Supervisor's is asked.
   * Optional, and absent in every test that only exercises the loop -- a pass with no decider steps
   * the rules runs and reports the llm ones as `skippedNoDecider`, spending nothing. The daemon is
   * the only production caller that supplies one (`apps/orchestrator/src/cli.ts`'s
   * `buildModelDecider`), which is what makes "an llm run only ever steps in the daemon" true of
   * the wiring and not just of a guard.
   */
  readonly modelDecider?: ModelDecider
  /**
   * M32 item 2: how many model calls this process may keep in flight at once. The calls happen
   * OFF the tick loop now, so without a cap one pass would start a child process for every due
   * llm run at once and every one of them would be spending. `cli.ts` reads
   * `SLAVEOFAI_MAX_MODEL_CALLS` (default 3) into this; a caller that omits it gets control's own
   * `DEFAULT_MAX_MODEL_CALLS`, which is the same number. One number for the whole process, not one
   * per loop -- the cap is on this host's spending, and N projects do not make N budgets.
   */
  readonly maxConcurrentModelCalls?: number
  /**
   * M38 §5: the model the SUPERVISOR's decisions are asked of, read from the environment by
   * `cli.ts`. Separate from `modelDecider` because they are different facts -- the decider is HOW
   * a call is made, this is WHAT is asked -- and because M31a's simulation calls take their model
   * from the simulation intent, so there was no shared name to reuse (spec erratum E3). M59 R14:
   * the intake pass asks its questions of the same model, for the same reason.
   */
  readonly supervisorModel?: string
  /** Overridable for a test that must not wait ten seconds. Defaults to {@link DAEMON_DISCOVERY_MS}. */
  readonly discoveryMs?: number
  /**
   * A test seam, and the ONLY one: resolving this promise shuts the daemon down exactly as SIGTERM
   * does, through the same path. Without it a test would have to signal its own process, which in
   * a vitest worker means signalling every other file's test too.
   */
  readonly until?: Promise<void>
}

/** What the daemon says it serves (M59 R15). One function because it is printed at startup AND on
 *  every change, and two spellings of it would let the gate assert a sentence the daemon only says
 *  once. */
export function servingLine(names: readonly string[], following: boolean): string {
  const projects = `${String(names.length)} project${names.length === 1 ? '' : 's'}`
  const named = names.length === 0 ? '' : ` (${names.join(', ')})`
  const follows = following ? `; following new ones every ${String(DAEMON_DISCOVERY_MS / 1000)}s` : ''
  return `serving ${projects}${named}${follows}`
}

/**
 * The daemon: one loop per project it serves, and the four things that are the process's own.
 *
 * ZERO ACTIVE PROJECTS IS NOT AN ERROR (M59 R15). It is the state a fresh install is in before its
 * first conversation, and the state that made `docker/entrypoint.sh` fragile: the daemon starts,
 * runs the global passes, and waits for a project to appear.
 *
 * ONE SUBSCRIPTION, and it routes: a notification naming a workspace this process holds a loop for
 * wakes that loop; one naming a workspace it does not arms a DISCOVERY pass, which is how a project
 * created a moment ago gets its loop without waiting for the timer. There is no event type on the
 * wire -- `EventNotification` is `{ seq, workspaceId }` (plan erratum E9) -- so "unknown workspace"
 * is the signal, and an archived project's loop is stopped by the timer.
 *
 * ONE GLOBAL PASS for the simulations and the intakes, on its own coalescer, once per process.
 * NOT once per loop: three loops each stepping every simulation would step every simulation three
 * times as fast, and claim three intakes where one was due.
 */
export async function runDaemon(deps: DaemonDeps): Promise<void> {
  // The catalog, once per process, before the first tick (M14 §4.3). Non-fatal: a host with no
  // skills directory is an ordinary host, and a daemon that refuses to start because it could not
  // read one is worse than a daemon with an empty catalog. A failed scan is simply skipped --
  // `orchestrator skills sync` is the operator's retry.
  try {
    process.stdout.write(describeSync(await syncSkillCatalog()))
  } catch (error) {
    process.stderr.write(
      `[daemon] skill catalog sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }

  // Catalog Person Pool (Task 2/3): once per process, before the first project is served, and NOT
  // wrapped in a try/catch like the skill sync above it. A skill directory the host cannot read
  // leaves an ordinary host with an empty catalog; a person pool this daemon cannot finish
  // reconciling leaves a template staffable with fewer than three managed people underneath it --
  // a fact nothing else would notice or report. The brief is explicit: a hook failure here must
  // fail daemon startup loudly rather than silently continue with a partial pool, so neither throw
  // is caught and both are left to propagate out of `runDaemon` exactly as they arrive.
  //
  // Task 3's reconciliation is the ONE call: a synonym the taxonomy learned since this template
  // was last imported must repair its `capabilityKeys` before the pool sync reads them, or a
  // stale, still-unresolved capability set would be the one every managed person starts this
  // process holding -- and `reconcileTemplateCapabilities` ends by calling `syncPersonPool` itself,
  // over every active template, whether or not anything needed reconciling.
  //
  // The second, explicit `syncPersonPool()` that used to follow it is gone (final review,
  // Important 4). It was never conditional and never had anything to do: the pass before it had
  // just synced the same templates from the same rows, so on every startup it re-read the whole
  // catalogue to report "nothing changed". Startup still fails loudly on a pool it cannot
  // reconcile, because this call is still outside any try/catch.
  await reconcileTemplateCapabilities()

  const following = deps.workspaceIds === 'all'
  const loops = new Map<string, WorkspaceLoop>()
  const loopDeps = (workspaceId: WorkspaceId): WorkspaceLoopDeps => ({
    workspaceId,
    registry: deps.registry,
    periodMs: deps.periodMs,
    ...(deps.modelDecider === undefined ? {} : { modelDecider: deps.modelDecider }),
    ...(deps.supervisorModel === undefined ? {} : { supervisorModel: deps.supervisorModel }),
  })

  /** Which projects this process should be serving, and what they are called. */
  const wanted = async (): Promise<{ readonly id: string; readonly name: string }[]> => {
    if (deps.workspaceIds !== 'all') {
      const one = await prisma.workspace.findUnique({ where: { id: deps.workspaceIds }, select: { id: true, name: true } })
      // A named project that does not exist (or was archived) is still what this process was asked
      // to serve: the loop starts, `tick` reports `skipped: 'archived'` and says so every tick,
      // which is today's behaviour and the one an operator who typed `--workspace` expects.
      return one === null ? [{ id: deps.workspaceIds, name: deps.workspaceIds }] : [one]
    }
    return prisma.workspace.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  }

  let shuttingDownNow = false
  /**
   * One pass over the project list: start a loop for one that appeared, stop the loop of one that
   * was archived (or deleted), and say so if either happened.
   *
   * Coalesced rather than called directly, for the tick's reason and one of its own: the timer and
   * every notification naming an unknown workspace both arm it (erratum E9), so a burst would
   * otherwise run several passes at once -- and two passes reading the same list before either had
   * written to `loops` would each start a loop for the same project, leaving the second's timers
   * running with no handle to stop them.
   */
  const discovery = createCoalescer(async (): Promise<void> => {
    if (shuttingDownNow) return
    try {
      const projects = await wanted()
      const ids = new Set(projects.map((project) => project.id))
      let changed = false
      for (const project of projects) {
        if (loops.has(project.id)) continue
        loops.set(project.id, await startWorkspaceLoop(loopDeps(brandWorkspaceId(project.id))))
        changed = true
      }
      for (const [id, loop] of [...loops]) {
        if (ids.has(id)) continue
        loops.delete(id)
        await loop.stop()
        changed = true
      }
      if (changed) process.stdout.write(`${servingLine(projects.map((project) => project.name), following)}\n`)
    } catch (error) {
      // A discovery pass that failed must not take the daemon down: the next one re-reads the list.
      process.stderr.write(`[daemon] discovery failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  })

  const globalPass = createCoalescer(async (): Promise<void> => {
    try {
      // M30 §5: auto-run stepping is a global pass -- simulations belong to a company, not to a
      // workspace -- and `decide()` stays pure (ADR 0004). Two daemons both running it is safe:
      // `autoStepDue` decides "due" under the row lock.
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
      if (sims.stepped > 0 || sims.halted > 0 || sims.skippedNoDecider > 0 || sims.startedModelCalls > 0) {
        process.stdout.write(`${JSON.stringify({ simulations: sims })}\n`)
      }

      // M59 R14: the intake pass, beside the simulations and for the same reason -- a conversation
      // belongs to no workspace (it exists before one does), so this is a GLOBAL pass rather than
      // part of `tick()`. Two daemons both running it is safe: `claimIntakes` decides "due" under
      // the row lock with SKIP LOCKED.
      const intakes = await tickIntakes({
        now: new Date(),
        by: `${String(process.pid)}@${hostname()}`,
        model: deps.supervisorModel ?? SUPERVISOR_DEFAULT_MODEL,
        ...(deps.modelDecider !== undefined ? { modelDecider: deps.modelDecider } : {}),
        ...(deps.maxConcurrentModelCalls !== undefined ? { maxConcurrentModelCalls: deps.maxConcurrentModelCalls } : {}),
      })
      // `skippedNoDecider` is printed for `tickSimulations`' own reason (M31a §4): a daemon built
      // without a decider silently doing nothing for a person waiting in a drawer is exactly the
      // failure an operator cannot diagnose from outside.
      if (intakes.startedModelCalls > 0 || intakes.skippedNoDecider > 0) {
        process.stdout.write(`${JSON.stringify({ intakes })}\n`)
      }

      // Catalogue capability mapping (2026-09-20), R7: one batch of stale personas per pass,
      // beside the intakes and for the same reason -- a persona belongs to no workspace.
      const capabilityMapping = await tickCapabilityMapping({
        model: deps.supervisorModel ?? SUPERVISOR_DEFAULT_MODEL,
        ...(deps.modelDecider !== undefined ? { modelDecider: deps.modelDecider } : {}),
      })
      if (capabilityMapping.calls > 0 || (capabilityMapping.skippedNoDecider && capabilityMapping.stale > 0)) {
        process.stdout.write(`${JSON.stringify({ capabilityMapping })}\n`)
      }
    } catch (error) {
      // A failed pass must not take the daemon down: the next one reloads the world from scratch.
      process.stderr.write(`[daemon] global pass failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  })

  let subscription: EventSubscription | null = null
  let globalTimer: NodeJS.Timeout | null = null
  let discoveryTimer: NodeJS.Timeout | null = null
  let onSignal: (() => void) | null = null

  // The handlers are installed BEFORE the first loop starts, not after the setup below finishes.
  // A loop serves its first collect and broker pass the moment it is created, so a brokered
  // operation can already be in flight -- with a claim file written and no reply -- while this
  // function is still opening the subscription. A signal arriving in that window used to fall
  // through to Node's default disposition, which kills the process mid-operation and abandons the
  // worker waiting on the reply. Installed here, that same signal resolves `stopped` and the
  // `finally` below drains the operation exactly as it does for a signal at any later moment.
  let resolveStopped = (): void => {}
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })
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
    resolveStopped()
  }
  onSignal = shutdown
  // `on`, not `once`: with `once` the second signal falls through to Node's default
  // disposition, which kills the process mid-drain and loses the rest of a run's events.
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // The test seam, through the SAME resolve: a test that shuts the daemon down exercises the
  // path a signal takes rather than a second one written for it.
  if (deps.until !== undefined) void deps.until.then(shutdown)

  try {
    // The FIRST line the daemon prints about what it serves, before any timer starts, so an
    // operator reading a log knows what this process is for even if it never ticks. Every loop is
    // in `loops` before anything below can fail, which is what the old "the subscription is opened
    // before the timer starts" ordering was protecting: a failure here must not leave an interval
    // running with nothing to stop it, and the `finally` stops every loop this map holds.
    const initial = await wanted()
    for (const project of initial) {
      loops.set(project.id, await startWorkspaceLoop(loopDeps(brandWorkspaceId(project.id))))
    }
    process.stdout.write(`${servingLine(initial.map((project) => project.name), following)}\n`)

    const connectionString = process.env['DATABASE_URL']
    if (connectionString !== undefined && connectionString !== '') {
      subscription = await subscribeEvents(connectionString, (notification): void => {
        const loop = loops.get(notification.workspaceId)
        // A notification is a wake-up, not a delivery: every tick reloads the world, so a missed
        // one costs latency and never correctness.
        if (loop !== undefined) loop.wake()
        else if (following) discovery.wake()
      })
    }

    globalTimer = setInterval((): void => globalPass.wake(), deps.periodMs)
    if (following) discoveryTimer = setInterval((): void => discovery.wake(), deps.discoveryMs ?? DAEMON_DISCOVERY_MS)
    globalPass.wake()

    await stopped
  } finally {
    shuttingDownNow = true
    if (globalTimer !== null) clearInterval(globalTimer)
    if (discoveryTimer !== null) clearInterval(discoveryTimer)
    // Discovery first, and drained before the loops are: a pass already past the guard above is
    // still entitled to finish starting the loop it is halfway through, and draining it here is
    // what puts that loop in the map in time to be stopped below rather than left running.
    discovery.stop()
    await discovery.inFlight()
    globalPass.stop()
    // Every loop, in the order today's `finally` drains the only one there was. Sequential rather
    // than `Promise.all`: each one may be waiting out a brokered operation, and the messages they
    // print about it should not interleave.
    for (const loop of loops.values()) await loop.stop()
    loops.clear()
    await globalPass.inFlight()
    // The signal handlers go LAST among the process-level teardown but before the disconnect: a
    // second signal during the drain should still force, and leaving them installed would leak a
    // listener per daemon in a process that runs more than one (which the tests do).
    if (onSignal !== null) {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    }
    try {
      await subscription?.close()
    } catch (error) {
      process.stderr.write(`[daemon] subscription close failed: ${String(error)}\n`)
    }
    await drainPumps()
    // M32 item 2 and M59 R14: both are database writes for calls the account has already been
    // billed for (spec §2.6), so disconnecting Prisma out from under one would lose exactly the
    // record that must not be lost. No new call can start behind these: every coalescer is stopped.
    await drainModelCalls()
    await drainIntakeCalls()
    await prisma.$disconnect()
    process.stdout.write('daemon stopped\n')
  }
}
