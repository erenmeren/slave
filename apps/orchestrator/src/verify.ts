import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import type { TaskId } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { commandFailure, runShellCommand } from './shell.js'

export interface VerifyResult {
  readonly passed: boolean
  /** `null` when nothing failed — either everything passed, or there was nothing to run. */
  readonly failedCommand: string | null
  /** `null` when the command was killed or timed out rather than exiting. */
  readonly exitCode: number | null
  readonly output: string
}

export interface RunVerifyInput {
  readonly taskId: TaskId
  readonly worktreePath: string
  /**
   * Where the per-command logs go. Explicit rather than derived from `worktreePath` by walking up
   * to the repository root: the logs must not land *inside* the worktree — that is what the agent
   * commits from, and Task 13 already had to move the run's settings and pause flag out for the
   * same reason — and deriving the path would silently couple verify to the worktree layout.
   */
  readonly artifactDir: string
  readonly commands: readonly string[]
  readonly timeoutMs: number
}

export interface AdvanceInput {
  readonly taskId: TaskId
  readonly result: VerifyResult
  readonly branch: string
}

/** `task.verify_failed` wants an integer; a killed or timed-out command has no exit code at all. */
const NO_EXIT_CODE = -1

/** One log file per command, named so the order is readable in a directory listing. */
function logPathFor(artifactDir: string, index: number, command: string): string {
  const slug =
    command
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'command'
  return join(artifactDir, `${String(index + 1).padStart(2, '0')}-${slug}.log`)
}

/**
 * Runs the workspace's verify commands in the worktree, in order, stopping at the first failure.
 *
 * Spec §8. Every command's exit code and captured output is persisted as an `Artifact`, because
 * without it the reason a task failed is lost and M4/M5 have nothing to show.
 *
 * Stopping at the first failure rather than running the list out: later commands routinely depend
 * on earlier ones (`npm run build` then `npm test`), so continuing produces a second, misleading
 * result from a command that should never have run — and here that result is what gets handed to
 * the next agent as the thing to fix.
 */
export async function runVerify(input: RunVerifyInput): Promise<VerifyResult> {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: input.taskId } })

  await appendEvent({
    type: 'task.verifying',
    workspaceId: task.workspaceId,
    taskId: task.id,
    actor: 'system',
    payload: { commandCount: input.commands.length },
  })

  if (input.commands.length === 0) {
    // The refusal spec §8 exists for. A workspace that configured no verify commands has proved
    // nothing, and "nothing failed" read as "it passed" is how work reaches `done` without anything
    // having checked it. Reported with a null `failedCommand`, which is what tells `advance` this
    // is a misconfiguration rather than a failing test.
    return {
      passed: false,
      failedCommand: null,
      exitCode: null,
      output:
        'this workspace has no verify commands configured, so nothing could be verified. ' +
        'An empty list is a refusal to prove the work, not a pass.',
    }
  }

  mkdirSync(input.artifactDir, { recursive: true })

  for (const [index, command] of input.commands.entries()) {
    const outcome = await runShellCommand({
      command,
      cwd: input.worktreePath,
      timeoutMs: input.timeoutMs,
    })
    const failed = outcome.timedOut || outcome.signal !== null || outcome.code !== 0
    const summary = failed
      ? commandFailure(command, input.timeoutMs, outcome).message
      : `command exit 0: ${command}\n${outcome.output}`.trim()

    const path = logPathFor(input.artifactDir, index, command)
    writeFileSync(path, `${summary}\n`)
    await prisma.artifact.create({ data: { taskId: task.id, kind: 'verify', path } })

    if (failed) {
      return { passed: false, failedCommand: command, exitCode: outcome.code, output: summary }
    }
  }

  return { passed: true, failedCommand: null, exitCode: null, output: '' }
}

/**
 * Moves the task on from a verify result: `done`, back to `rework`, or `failed` at the cap.
 *
 * The attempt is incremented and then compared, matching `failToStart` in Task 13 — two paths that
 * count attempts differently is a bug waiting for whichever one is read second.
 */
export async function advance(input: AdvanceInput): Promise<void> {
  const task = await prisma.task.findUniqueOrThrow({ where: { id: input.taskId } })
  const workspaceId = task.workspaceId

  // `Task.branch` has two writers: the tick sets it at provisioning, this sets it on `done`. They
  // agree today and nothing enforces it. The branch is what a human merges, so finishing a task
  // pointing somewhere else is how work gets merged from a branch nobody looked at. Refuse rather
  // than overwrite -- a caller that legitimately re-branches a task can clear the field first, and
  // will have meant to.
  if (task.branch !== null && task.branch !== input.branch) {
    throw new Error(
      `refusing to advance ${task.id}: it was worked on branch ${task.branch}, ` +
        `but this result is for ${input.branch}`,
    )
  }

  if (input.result.passed) {
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'done', branch: input.branch, activeRunId: null },
    })
    await appendEvent({
      type: 'task.verify_passed',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { branch: input.branch },
    })
    await appendEvent({
      type: 'task.done',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { branch: input.branch },
    })
    return
  }

  if (input.result.failedCommand === null) {
    // No command failed and yet it did not pass: there were none. That is a workspace
    // misconfiguration, and it must not read as an ordinary failing test -- the operator's fix is
    // to configure verify, not to look at the agent's work.
    await appendEvent({
      type: 'guardrail.tripped',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { guardrail: 'verify_not_configured', detail: input.result.output },
    })
  } else {
    await appendEvent({
      type: 'task.verify_failed',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { command: input.result.failedCommand, exitCode: input.result.exitCode ?? NO_EXIT_CODE },
    })
  }

  const counted = await prisma.task.update({
    where: { id: task.id },
    data: { attempt: { increment: 1 } },
  })
  const exhausted = counted.attempt >= task.maxAttempts

  await prisma.task.update({
    where: { id: task.id },
    data: {
      status: exhausted ? 'failed' : 'rework',
      activeRunId: null,
      // The agent-facing channel: `buildPrompt` puts this in front of the next run as the thing to
      // fix first. Verify output is exactly what it is for -- which is why Task 13 was corrected to
      // stop writing infrastructure errors into it.
      lastRejectionReason: input.result.output,
    },
  })

  await appendEvent(
    exhausted
      ? {
          type: 'task.failed',
          workspaceId,
          taskId: task.id,
          actor: 'system',
          payload: { reason: `verify failed after ${counted.attempt} attempts: ${input.result.output}` },
        }
      : {
          type: 'task.rework',
          workspaceId,
          taskId: task.id,
          actor: 'system',
          payload: { reason: input.result.output, attempt: counted.attempt },
        },
  )
}
