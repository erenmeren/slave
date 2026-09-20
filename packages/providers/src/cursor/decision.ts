import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDecisionEnv, decisionGateEnv } from '../claude/decision.js'
import { classifyDecision, collectDecisionStream } from '../runtime/decision-stream.js'
import { runTokenHash } from '../runtime/process.js'
import { cursorFlags, cursorPreflightGate } from './flags.js'
import { cursorHooksPath, writeCursorHooksFile } from './hooks.js'
import { parseCursorLine } from './stream.js'
import type { ModelDecisionOutcome } from '../runtime/decision-stream.js'

export interface CursorDecisionInput {
  /** The Cursor binary from the manifest (`cursor-agent`), or `node` with a fake ahead of it. */
  readonly command: string
  /** Everything the binary sees before the flags -- the fake CLI's `node <fake.mjs>` shape. */
  readonly extraArgs?: readonly string[]
  readonly model: string
  readonly prompt: string
  /**
   * `scripts/cursor-shell-gate.sh`, the gate a RUN registers. Registered here the same way and
   * armed against an all-deny verdict, so the one-shot call reaches nothing at all.
   */
  readonly gatePath: string
  readonly timeoutMs?: number
}

/**
 * The verdict a one-shot call arms its gate with: NOTHING is granted and every tool is governed
 * (F R5, spec §2's permissions file v2).
 *
 * Four fields carry the whole of it. `grants: []` is what denies -- the decision belongs to the
 * KIND, and no kind is granted. `enforce: 'all-tools'` is the half that matters on Cursor
 * specifically: a run uses `known-tools` there, because Cursor's `preToolUse` tool names do not
 * match the resolved vocabulary and an allow list would deny a worker everything it does; a
 * DECISION call wants exactly that outcome, so it says `all-tools` and an empty vocabulary, and
 * every name -- `read`, `Read`, or one nobody has measured -- falls through to `ungoverned_tool`
 * and is refused. `tokenHash` is what makes the verdict about THIS child (M52 R4).
 *
 * Exported for the test that proves the claim: a file this shape, put in front of the real gate
 * script with the matching token, really does answer `{"permission":"deny"}`.
 */
export interface DecisionPermissions {
  readonly version: 2
  readonly runId: string
  readonly tokenHash: string
  readonly enforce: 'all-tools'
  readonly grants: readonly string[]
  readonly allow: readonly { readonly tool: string; readonly kind: string }[]
  readonly vocabulary: Readonly<Record<string, string>>
  readonly prefixes: readonly { readonly prefix: string; readonly kind: string }[]
}

export function denyAllPermissions(input: { readonly runToken: string }): DecisionPermissions {
  return {
    version: 2,
    runId: 'supervisor-decision',
    tokenHash: runTokenHash(input.runToken),
    enforce: 'all-tools',
    grants: [],
    allow: [],
    vocabulary: {},
    prefixes: [],
  }
}

/**
 * One non-interactive Cursor call, the sibling of `decideWithModel` (F R5). MEASURED against the
 * real binary before it was written: the spike at
 * `.superpowers/sdd/2026-09-20-supervisor-chat/cursor-print-spike.jsonl` and spec §4 erratum E1.
 *
 * WHAT DIFFERS FROM THE CLAUDE CALL, AND WHY -- each of these is the vendor's doing, not a choice:
 *
 * 1. **The prompt is POSITIONAL and last.** Cursor reads no prompt on stdin. It must also be last:
 *    `--resume [chatId]` takes an OPTIONAL argument, so a prompt sitting after a bare flag is a
 *    prompt that flag swallowed (M12 Task 11 R2). `cursorFlags` supplies the flag list -- reused
 *    rather than respelt, so `--trust` and `--force` cannot drift between a run and a decision.
 * 2. **`--trust --force` are mandatory and their absence is INVISIBLE.** Without them the CLI
 *    prints NOTHING on stdout and a "Workspace Trust Required" block on stderr -- measured twice,
 *    once for runs (Task 11) and again on this spike -- which reaches this function as "the model
 *    process ended without a result line", i.e. as a runtime fault rather than a missing flag.
 * 3. **There is no budget flag** to cap the call with, and no cost on the way back: the `result`
 *    line carries `usage` and no cost field of any name, so `costUsd` is `null` and the turn is
 *    unmeasured. A `usage` object is not a price, and a `0` here is a figure the budget guardrail
 *    would believe.
 * 4. **The gate lives in the CWD.** `cursor-agent` reads hooks from `<workspace>/.cursor/hooks.json`
 *    and has no `--settings`-style flag, so this call mints a temp directory, writes the hooks
 *    file there and runs in it. That directory is the workspace, the gate's registration and the
 *    call's whole world, and it is removed in `finally`.
 *
 * WHAT IS IDENTICAL, deliberately: the environment (`buildDecisionEnv`), the timeout, the reader
 * and the verdict (`runtime/decision-stream.ts`), including the rule that a tool call anywhere in
 * the stream is an `isolation_breach` that outranks every other reading. A Cursor turn asks for no
 * tools at all -- `classifyDecision` is given no allowed list, so ANY tool call is a breach, and
 * R7's read-only mode stays a Claude-only story. The gate is the only lock there is on this side:
 * Cursor has no `--tools ""` to pair with it.
 */
export async function decideWithCursor(input: CursorDecisionInput): Promise<ModelDecisionOutcome> {
  // The gate is probed BEFORE anything is spawned, exactly as `CursorAdapter.start` probes it: a
  // written hooks file is not an armed gate, and the one-shot call has no pause/resume story in
  // which a later check could catch a gate that never denies.
  await cursorPreflightGate({ gatePath: input.gatePath })
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-cursor-decision-'))
  try {
    writeCursorHooksFile({ hooksPath: cursorHooksPath(dir), gatePath: input.gatePath })
    // Minted here and written down nowhere else: the file carries only its sha256, so pointing
    // this child at another run's verdict would buy nothing (M52 R4).
    const runToken = randomBytes(32).toString('hex')
    const permissionsFilePath = join(dir, 'permissions.json')
    await writeFile(permissionsFilePath, JSON.stringify(denyAllPermissions({ runToken })))
    const child = spawn(
      input.command,
      [...(input.extraArgs ?? []), ...cursorFlags({ model: input.model }), input.prompt],
      {
        cwd: dir,
        env: buildDecisionEnv(decisionGateEnv({ dir, permissionsFilePath, runToken })),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    return classifyDecision(
      await collectDecisionStream({
        child,
        parse: parseCursorLine,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
