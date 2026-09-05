import { dirname } from 'node:path'
import { resolveDenyList, writePermissionsFile } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  slaveId as brandSlaveId,
  runId as brandRunId,
  taskId as brandTaskId,
  workspaceId as brandWorkspaceId,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { AdapterRegistry } from '@slave-of-ai/providers'
import { resolveAdapter } from './provider.js'
import { pumpRun } from './pump.js'
import { verifyConcludedRun } from './verify.js'

export interface ExecuteResumeOptions {
  readonly runId: string
  /** M12 Task 5: a registry, not a single adapter -- see `TickDeps.registry`'s own docstring. */
  readonly registry: AdapterRegistry
  /** The instruction to hand the slave, or `null` for the adapter's default continuation prompt. */
  readonly message: string | null
  /**
   * Called the moment the child exists, with its pid.
   *
   * Only the CLI uses it, and only to keep one line of output where it has always been: `resume`
   * printed `resumed <id> as pid <n>` *before* awaiting the stream, so an operator sees the run
   * come back immediately rather than after it finishes. Moving that print to after this function
   * returns would have turned an immediate acknowledgement into minutes of silence.
   */
  readonly onSpawned?: (handle: { readonly pid: number }) => void
}

/**
 * Spawns a claimed run's continuation and owns its stream to the end.
 *
 * The caller must already hold the `paused -> resuming` claim (the CLI's own `updateMany`, or
 * `claimResume`). Claiming and spawning belong to one process for one reason: a run in `resuming`
 * with no live process is precisely the shape §3.4's orphan pass fails, so the window between the
 * two must be as narrow as the CLI's has always been -- a few statements inside a single process --
 * and never span a request boundary.
 *
 * Extracted from the CLI's `resume` case so the daemon's tick can execute a web-recorded intent
 * through the exact same path an operator's `resume --run` takes. Two implementations of "continue
 * a paused run" would be two chances to get the pid, the `run.resumed` event or the pump's
 * `resumed: true` flag wrong, and only one of them would have the CLI's tests.
 */
export async function executeResume(options: ExecuteResumeOptions): Promise<void> {
  const { message } = options
  // `slave -> team`, not `task`: a `planning` run (M8b) has no `Task` row, and `slave -> team ->
  // workspace` is the only linkage such a run has to a workspace. `permissions` alongside it (M18
  // Task 5): the matrix is re-resolved and the run's `permissions.json` rewritten below, against
  // whatever the slave's permission rows say NOW -- not what they said at the original dispatch.
  const run = await prisma.slaveRun.findUniqueOrThrow({
    where: { id: options.runId },
    include: { slave: { include: { team: true, permissions: true } } },
  })

  // Thrown, not refused: by the time this runs the claim has already flipped the run to `resuming`,
  // so a missing checkpoint here is not an operator's mistake but a state nothing should be able to
  // produce -- both callers check for it before claiming. Crashing the caller is the honest report.
  const checkpoint = await prisma.checkpoint.findUnique({ where: { runId: run.id } })
  if (checkpoint === null) {
    throw new Error(`run ${run.id} has no checkpoint: there is nothing to resume it from`)
  }

  // Resolved from the CHECKPOINT's own recorded provider (M12 Task 8), never re-resolved from the
  // worker's current assignment -- spec §4: "a resumed run continues with the pair it started
  // with," matching how `checkpoint.model` is already replayed verbatim below. `?? 'claude_code'`
  // is the same historical-fact default `sweep.ts` uses: every checkpoint written before this
  // column existed was necessarily a Claude Code run (there was no other adapter that could have
  // produced it), so this backfills a known fact rather than guessing among live alternatives.
  const adapter = resolveAdapter(options.registry, checkpoint.provider ?? 'claude_code')

  // M18 Task 5: rewritten here, at RESUME, exactly as it was at the run's original start -- a
  // fresh snapshot each time, not a copy of the one `start()` wrote. `runDir` is `pauseFlagPath`'s
  // own directory (`runFilePaths`'s contract every dispatch site already relies on: `pauseFlagPath:
  // join(dir, 'pause.flag')`), the one field guaranteed to live there on every provider -- unlike
  // `settingsPath`, which for Cursor is a hooks file in the WORKTREE, not `runDir`. Both adapters'
  // own `resume()` re-derive this SAME path independently from `checkpoint.pauseFlagPath` (see
  // `writePermissionsFile`'s docstring for why the path is a literal convention, not a field on
  // `Checkpoint`), so what is written here is exactly what `SLAVEOFAI_PERMISSIONS_FILE` will point
  // the resumed child at.
  const runDir = dirname(checkpoint.pauseFlagPath)
  writePermissionsFile(runDir, resolveDenyList(run.slave.permissions, checkpoint.provider ?? 'claude_code'))

  // The checkpoint is the whole point of `resume`'s signature: this process may never have called
  // `start()` for that run, so the settings file, the hook path and the git identity exist nowhere
  // else. `resume()` clears the pause flag and verifies it is gone before spawning -- otherwise the
  // gate denies every tool call the resumed run attempts.
  const handle = await adapter.resume(
    brandRunId(run.id),
    {
      sessionId: checkpoint.sessionId,
      worktreePath: checkpoint.worktreePath,
      pauseFlagPath: checkpoint.pauseFlagPath,
      settingsPath: checkpoint.settingsPath,
      hookPath: checkpoint.hookPath,
      gitAuthorName: checkpoint.gitAuthorName,
      gitAuthorEmail: checkpoint.gitAuthorEmail,
      lastToolUseId: checkpoint.lastToolUseId,
      lastToolName: checkpoint.lastToolName,
      numTurns: checkpoint.numTurns,
      deniedToolUseIds: checkpoint.deniedToolUseIds,
      headCommit: checkpoint.headCommit,
      dirtyFiles: checkpoint.dirtyFiles,
      cumulativeCostUsd: checkpoint.cumulativeCostUsd,
      cumulativeTokens: checkpoint.cumulativeTokens,
      // Replayed verbatim, never re-resolved: the run must continue with the SAME model it started
      // with (M10 §6), independently of whatever `setSlaveModel` has set on the worker since the
      // pause. `null` on the row (legacy or never set) omits the key entirely, matching how every
      // other optional field on `Checkpoint` behaves under `exactOptionalPropertyTypes`.
      ...(checkpoint.model !== null ? { model: checkpoint.model } : {}),
      // Same replay-verbatim discipline as `model`, for the same reason -- `checkpoint.provider`
      // (M12 Task 6) declared this field on `packages/providers`' `Checkpoint` interface with
      // nothing ever writing it until now; an unread field crossing this seam is exactly what
      // Decision 2 exists to prevent.
      ...(checkpoint.provider !== null ? { provider: checkpoint.provider } : {}),
    },
    message,
  )

  await prisma.slaveRun.update({
    where: { id: run.id },
    // `pausedAtStep` is cleared with the pause itself: the domain's `resuming -> working` edge
    // clears it, and a running run reporting where it once paused reads as still paused.
    data: { pid: handle.pid, pauseReason: null, pausedAtStep: null },
  })
  await appendEvent({
    type: 'run.resumed',
    workspaceId: run.slave.team.workspaceId,
    taskId: run.taskId,
    slaveId: run.slaveId,
    runId: run.id,
    actor: 'human',
    payload: { sessionId: checkpoint.sessionId },
  })

  // This process owns the resumed run's stream, so it pumps it and waits -- the same reason a
  // one-shot `tick` waits for what it started. `run.resumed` is emitted above rather than left to
  // the pump, which emits `run.started` from the session line and cannot tell a first spawn from a
  // continuation (Task 12's carry).
  const pumped = pumpRun({
    runId: brandRunId(run.id),
    taskId: run.taskId === null ? null : brandTaskId(run.taskId),
    slaveId: brandSlaveId(run.slaveId),
    workspaceId: brandWorkspaceId(run.slave.team.workspaceId),
    events: adapter.events(brandRunId(run.id)),
    cancel: () => adapter.cancel(brandRunId(run.id)),
    // The pump cannot tell a continuation from a first spawn -- a resumed process emits
    // `system/init` just like a fresh one -- so it is told, and `run.resumed` above is the only
    // announcement. Task 12's carry, closed at the caller that knows.
    resumed: true,
    spawn: {
      settingsPath: checkpoint.settingsPath,
      pauseFlagPath: checkpoint.pauseFlagPath,
      hookPath: checkpoint.hookPath,
      gitIdentity: { name: checkpoint.gitAuthorName, email: checkpoint.gitAuthorEmail },
      // The same historical-fact default used to resolve `adapter` above, carried forward so a
      // SECOND pause of this same resumed run checkpoints the identical provider rather than
      // losing it -- see `PumpRunInput.spawn.provider`'s own docstring. Naming this explicitly:
      // this is the one place in this file where a `??` turns a null into data that can reach a
      // NEW `Checkpoint` row's `create` clause (`pump.ts`'s `writeCheckpoint`) as a real, persisted
      // `provider` value -- the same shape Task 6 spent a whole task removing for `costUsd`.
      // Accepted here (only `claude_code` has ever produced a checkpoint with `provider: null`,
      // so this backfills a known fact, not a guess), and inert in practice today besides: a
      // checkpoint must already exist for `resume` to run at all, so `writeCheckpoint`'s `update`
      // branch is what actually fires here, and it deliberately never rewrites `provider` once
      // set (see that function's own comment) -- this value only would have mattered had `create`
      // fired again for the same run, which today's upsert never does.
      provider: checkpoint.provider ?? 'claude_code',
      // Carried forward so a SECOND pause of this same resumed run checkpoints the same model
      // again, rather than losing it -- see `PumpRunInput.spawn.model`'s own docstring.
      ...(checkpoint.model !== null ? { model: checkpoint.model } : {}),
    },
  })
  options.onSpawned?.({ pid: handle.pid })
  await pumped
  // The same reaction the tick chains onto its pumps: a resumed run's completion is a completion
  // like any other, and a success that left the task `running` forever would make pause/resume a
  // trap rather than a control. This process awaited the stream, so it is the one that knows the
  // run concluded.
  await verifyConcludedRun(brandRunId(run.id))
}
