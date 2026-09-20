import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyDecision, collectDecisionStream } from '../runtime/decision-stream.js'
import { runGateScript } from '../runtime/gate-preflight.js'
import { preflightGate } from './flags.js'
import { parseStreamLine } from './stream.js'
import { writeSettingsFile } from './settings.js'
import type { ModelDecisionOutcome } from '../runtime/decision-stream.js'

/**
 * The reader and the verdict moved to `runtime/decision-stream.ts` (F R5): the Cursor one-shot
 * call (`cursor/decision.ts`) reads a stream and judges it by exactly the same rules, and a second
 * copy of "a tool call outranks a timeout" is a rule that can be true on one provider and false on
 * the other. Re-exported here under the names this module has always exported them by, so every
 * existing import keeps resolving.
 */
export { DEFAULT_MODEL_TIMEOUT_MS, type DecisionStream, type ModelDecisionOutcome } from '../runtime/decision-stream.js'

/**
 * What a decision call may touch (F R7).
 *
 * `'none'` is every call this function has made until now: `--tools ""`, the deny-all hook, a
 * throwaway directory as cwd, and an environment of four names. It is the default and it is
 * unchanged, byte for byte.
 *
 * `'read-only'` is the one turn that needs more: a chat message carrying an image the person
 * attached. The model gets `Read`, `Glob` and `Grep`, the repository as its cwd, and the RUN gate
 * (`scripts/pause-gate.sh`) registered against a permissions file granting `read_repo` -- the
 * existing gate, the existing file format, nothing invented for this. Everything it may do, it
 * does by opening a file the repository already holds.
 */
export type DecisionToolMode = 'none' | 'read-only'

/**
 * The tools `'read-only'` spawns with: Read, and the two ways of finding what to read.
 *
 * ONE list, spelt once, used twice: it is the `--tools` argument AND what `classifyDecision` is
 * told to expect in the stream. A second spelling would be a mode that asks for a tool and then
 * reports an isolation breach when the model uses it.
 */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const

/** Everything both modes need, and nothing either mode may do without. */
interface ModelDecisionCall {
  readonly command: string
  readonly extraArgs?: readonly string[]
  readonly model: string
  readonly prompt: string
  readonly maxBudgetUsd: number
  /**
   * The hook the call's settings file registers: the deny-all hook under `tools: 'none'`, the run
   * gate under `'read-only'`. ONE field, because it is one mechanism -- what changes between the
   * two modes is which script the CALLER hands it, and what that script is then checked against
   * (see `decideWithModel`'s two pre-flights).
   */
  readonly hookPath: string
  readonly timeoutMs?: number
}

/**
 * A DISCRIMINATED UNION on `tools`, not one interface with four optional fields (fix round 1, I1).
 *
 * The read-only arm needs all three of `cwd`, `permissionsFilePath` and `runToken`, and each
 * omission fails in a different quiet way rather than loudly: no `cwd` and the model reads the
 * temp directory instead of the repository and truthfully reports it found nothing; no
 * `permissionsFilePath` and the gate sees an ungoverned run and ALLOWS every tool it was spawned
 * with; no `runToken` and the identity check fails closed and refuses the `Read` the mode exists
 * for. Optional fields made all three of those a caller's oversight; the union makes them a
 * compile error, and {@link requireReadOnlyInputs} makes them an exception for a caller that casts.
 *
 * The text-only arm keeps every field it ever had and names the other three as `undefined`, so
 * passing a `cwd` to a turn that ignores one is refused rather than silently dropped.
 */
export type ModelDecisionInput =
  | (ModelDecisionCall & {
      readonly tools?: 'none'
      readonly cwd?: undefined
      readonly permissionsFilePath?: undefined
      readonly runToken?: undefined
    })
  | (ModelDecisionCall & {
      readonly tools: 'read-only'
      /** The repository the model is being let into: where a path the person attached resolves. */
      readonly cwd: string
      /**
       * The verdict the gate reads (`SLAVEOFAI_PERMISSIONS_FILE`). WRITTEN BY THE CALLER, never
       * here: which operations a turn may have is the control layer's decision, and this
       * function's job is to put the file the caller wrote in front of the gate the caller named.
       */
      readonly permissionsFilePath: string
      /**
       * The plaintext of the token whose sha256 that permissions file carries as `tokenHash`
       * (M52 R4). `read_permission_verdict` (`scripts/lib/permissions.sh`) compares the two and
       * FAILS CLOSED when they do not pair, so the file and the token travel together or not at
       * all. The caller mints one, hashes it into the file, and passes the plaintext here.
       */
      readonly runToken: string
    })

/**
 * The same three requirements at RUNTIME, for a caller that casts (fix round 1, I1) -- a JS caller,
 * a value that arrived as `unknown`, an `as ModelDecisionInput` written to silence the union. It
 * throws BEFORE the pre-flight and before `mkdtemp`, so a refused call spawns nothing and leaves
 * nothing behind, and it names the field that is missing rather than failing later as a model that
 * read nothing or a gate that allowed everything.
 */
function requireReadOnlyInputs(input: ModelDecisionInput): void {
  const missing = (['cwd', 'permissionsFilePath', 'runToken'] as const).filter(
    (field) => typeof input[field] !== 'string' || input[field] === '',
  )
  if (missing.length > 0) {
    throw new Error(
      `decideWithModel: tools: 'read-only' requires ${missing.join(', ')}. A read-only turn opens a ` +
        'file in the repository under the run gate, so it needs the repository (cwd), the verdict ' +
        'the gate reads (permissionsFilePath) and the token that verdict is about (runToken). ' +
        'Without all three the call either reads nothing or is gated by nothing.',
    )
  }
}

/**
 * The exact flag set a simulation's model call spawns with: restricted, MCP-strict, tool-less
 * (`--tools ""`), session-less, budget-capped, `stream-json` output with hook events included, and
 * the per-run settings file that registers the deny-all hook (M31a §4). `extraArgs` come first --
 * the fake CLI's own `node <fake.mjs> --fixture <name>` invocation shape -- everything after it is
 * flags the real (or fake) `claude` binary reads.
 *
 * `tools: 'read-only'` (F R7) changes exactly ONE word of this: the `--tools` value. Everything
 * else -- `--restricted`, `--strict-mcp-config`, `--no-session-persistence`, the budget cap, the
 * settings file -- holds for both modes, because a turn that may read the repository is still a
 * one-shot call with no session and no MCP. Omitting `tools`, or passing `'none'`, produces the
 * argv this function has always produced.
 */
export function decisionArgs(input: {
  readonly extraArgs?: readonly string[]
  readonly model: string
  readonly maxBudgetUsd: number
  readonly settingsPath: string
  readonly tools?: DecisionToolMode
}): readonly string[] {
  return [
    ...(input.extraArgs ?? []),
    '-p',
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    input.tools === 'read-only' ? READ_ONLY_TOOLS.join(',') : '',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    '--model',
    input.model,
    '--max-budget-usd',
    String(input.maxBudgetUsd),
    '--settings',
    input.settingsPath,
  ]
}

/**
 * The environment a decision call's child is spawned with: exactly `PATH`, `HOME`, `LANG` and
 * `TERM` -- never the parent's full `process.env`, which on this repo's own processes carries
 * `DATABASE_URL` and other secrets a simulation actor must never see (M31a §4, ruling R1). `PATH`
 * and `HOME` come from the parent's own environment (the child needs them to find `node`/`claude`
 * and resolve its home directory); `LANG` falls back to `'C.UTF-8'` when the parent has none;
 * `TERM` is always `'dumb'` -- a decision call is never interactive and never needs a real
 * terminal's capabilities.
 *
 * `extra` (F R5/R7) is the ONE way anything else gets in, and it is named at the call site rather
 * than read from the environment here: a gated call adds the three file channels a gate needs
 * (see {@link decisionGateEnv}). It stays an allow list plus a caller's explicit list; there is
 * still no path by which `DATABASE_URL` reaches a child.
 *
 * Vendor-neutral despite living in `claude/`: `cursor/decision.ts` spawns with exactly this
 * environment, for exactly this reason. A second copy of the four names on that side would be the
 * denylist mistake in miniature -- two lists that drift.
 */
export function buildDecisionEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    // FIRST, so the four names below always win (fix round 1, M6). Spread last, an `extra` holding
    // a `PATH` -- from a caller that built it out of something it read -- would replace the one
    // this function is responsible for, and the allow list would stop being an allow list.
    ...extra,
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '',
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    TERM: 'dumb',
  }
}

/**
 * The three names a GATED one-shot call adds to that environment (F R5/R7), and why each is there.
 *
 * - `SLAVEOFAI_PAUSE_FLAG` names a file inside the call's own temp directory that is never
 *   created. It is not decoration: with the variable unset, `read_pause_reason`
 *   (`scripts/lib/pause-flag.sh`) returns 2 and BOTH gates deny every tool call with a
 *   misconfiguration message, before the permissions file is read at all -- so a read-only turn
 *   would read nothing, and the reason a person saw would name a broken gate rather than a
 *   refused call. Named and absent is the ordinary "no pause requested" case, which is also the
 *   truth: a one-shot call is ended by its timeout, never paused.
 * - `SLAVEOFAI_PERMISSIONS_FILE` is the verdict the gate reads.
 * - `SLAVEOFAI_RUN_TOKEN` is what that verdict is ABOUT (M52 R4). Without it the gate's identity
 *   check fails closed and every call is refused, however the file reads.
 */
export function decisionGateEnv(input: {
  readonly dir: string
  readonly permissionsFilePath?: string | undefined
  readonly runToken?: string | undefined
}): NodeJS.ProcessEnv {
  return {
    SLAVEOFAI_PAUSE_FLAG: join(input.dir, 'pause.flag'),
    ...(input.permissionsFilePath === undefined ? {} : { SLAVEOFAI_PERMISSIONS_FILE: input.permissionsFilePath }),
    ...(input.runToken === undefined ? {} : { SLAVEOFAI_RUN_TOKEN: input.runToken }),
  }
}

function isDeny(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision === 'deny'
  } catch {
    return false
  }
}

/** The deny-all hook must deny whatever the pause flag says -- the opposite contract of `preflightGate`. */
export async function preflightDenyAll(input: { readonly hookPath: string }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-denyall-'))
  try {
    for (const flagPresent of [true, false]) {
      const run = await runGateScript({ hookPath: input.hookPath, flagPath: join(dir, 'flag'), flagPresent })
      if (run.exitCode !== 0 || !isDeny(run.stdout)) {
        throw new Error(
          `preflightDenyAll: hook at ${input.hookPath} did not deny with the pause flag ${flagPresent ? 'present' : 'absent'} (exit ${String(run.exitCode)}, stdout ${JSON.stringify(run.stdout.slice(0, 200))})`,
        )
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function decideWithModel(input: ModelDecisionInput): Promise<ModelDecisionOutcome> {
  const readOnly = input.tools === 'read-only'
  if (readOnly) requireReadOnlyInputs(input)
  // TWO PRE-FLIGHTS, ONE PER CONTRACT, and they are each other's opposite (F R7).
  //
  // `preflightDenyAll` asserts the hook denies with the pause flag present AND absent -- right for
  // a hook whose whole job is to refuse, and fatal for a run gate, which ALLOWS with the flag
  // absent. That discrimination is what makes a gate a gate, so a read-only turn is checked with
  // the runs' own `preflightGate` instead: deny while paused, allow while not. Running the
  // deny-all check here would refuse every correct gate; running NEITHER would let a gate that
  // denies nothing through, and a call that may read the repository is exactly where that matters.
  if (readOnly) await preflightGate({ hookPath: input.hookPath })
  else await preflightDenyAll({ hookPath: input.hookPath })
  const dir = await mkdtemp(join(tmpdir(), 'slaveofai-decision-'))
  // The `try` wraps everything from here on -- `writeSettingsFile` (throws synchronously on a
  // non-absolute `hookPath`) and the spawn itself included -- so `dir` is removed in `finally` no
  // matter which of those throws or how the run ends. Fix round 1, Important 2: a caller that
  // passes a bad `hookPath` used to leak a `slaveofai-decision-*` directory on every call, because
  // the old `try` opened only around the stream-reading promise, after both of those had already
  // run unguarded.
  try {
    const settingsPath = join(dir, 'settings.json')
    writeSettingsFile({ settingsPath, hookPath: input.hookPath })
    // `input.permissionsFilePath` and `input.runToken` are strings on this arm of the union and
    // have been checked at runtime as well, so there is nothing conditional left to spread.
    const env = buildDecisionEnv(
      input.tools === 'read-only'
        ? decisionGateEnv({ dir, permissionsFilePath: input.permissionsFilePath, runToken: input.runToken })
        : {},
    )
    const child = spawn(
      input.command,
      decisionArgs({
        ...(input.extraArgs !== undefined ? { extraArgs: input.extraArgs } : {}),
        model: input.model,
        maxBudgetUsd: input.maxBudgetUsd,
        settingsPath,
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
      }),
      // The repository under `read-only`, so a path the person attached resolves; the throwaway
      // directory otherwise, which is the whole of a text-only turn's world.
      { cwd: input.tools === 'read-only' ? input.cwd : dir, env, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    // ONE reader and ONE verdict for both runtimes (`runtime/decision-stream.ts`):
    // `collectDecisionStream` ends the child's stdin -- absorbing the EPIPE a child that exited
    // first turns that write into -- reads stdout to the end or to the timeout, and
    // `classifyDecision` judges what arrived, breach before timeout before a missing result line.
    // Every rule that was written here, and the incident behind each, moved with them.
    return classifyDecision({
      ...(await collectDecisionStream({
        child,
        parse: parseStreamLine,
        prompt: input.prompt,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })),
      // What this call asked for, so a `Read` it was granted is not read as a breach -- and
      // anything it was not granted still is. Empty on a text-only turn: nothing is expected there.
      allowedTools: readOnly ? READ_ONLY_TOOLS : [],
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
