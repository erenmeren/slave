import { sanitisePersonText } from '../handoff/contract.js'
import { SMOKE_STUB_EXIT_CODE, SMOKE_STUB_MESSAGE } from '../intake/constants.js'
import { SKELETON_PACKAGE_KEY, SMOKE_OUTPUT_MAX_CHARS, VERIFICATION_REWORK_MAX_CHARS } from './constants.js'
import { SMOKE_CONTRACT_LINES } from './contract.js'
import { RUN_REQUIREMENT_KEY } from './requirements.js'
import { SMOKE_SCRIPT_PATH } from './skeleton.js'
import { trimEvidence } from './verification.js'

/** Skeleton spec S7: how a smoke attempt can fail a package (an `error` is the orchestrator's own). */
export type SmokeFailure = 'missing' | 'stub' | 'failed' | 'timed_out'

/**
 * Spec S7 (F10): a script that is absent OR not executable in the checkout is `missing` -- decided
 * before anything runs, from the checkout's file mode. `null` means the script may be run.
 */
export function smokeScriptFailure(input: { readonly exists: boolean; readonly executable: boolean }): 'missing' | null {
  return input.exists && input.executable ? null : 'missing'
}

/**
 * What a smoke run's process outcome means (plan B D7). A timeout first: a killed group's exit code
 * is the kill's, not the script's. The stub is the exact pair the intake's stub prints -- another
 * exit 2 is an ordinary failure. `missing` is decided before anything runs, by the caller.
 */
export function classifySmoke(input: { readonly code: number | null; readonly timedOut: boolean; readonly output: string }): 'passed' | 'stub' | 'failed' | 'timed_out' {
  if (input.timedOut) return 'timed_out'
  if (input.code === 0) return 'passed'
  if (input.code === SMOKE_STUB_EXIT_CODE && input.output.includes(SMOKE_STUB_MESSAGE)) return 'stub'
  return 'failed'
}

/**
 * Which package a failed smoke sends back (spec S7, plan B D4) -- by rule, never by reading the
 * output. A script that does not exist yet is the skeleton's to write; a script that runs and fails
 * is the integration package's, which wired everything together. One package (single mode) takes
 * both; a plan from before the skeleton existed sends a stub to integration.
 */
export function smokeReworkTarget(outcome: SmokeFailure, packages: readonly { readonly key: string; readonly isIntegration: boolean }[]): string | null {
  const skeleton = packages.find((pkg) => pkg.key === SKELETON_PACKAGE_KEY)
  const integration = packages.find((pkg) => pkg.isIntegration)
  const only = packages.length === 1 ? packages[0] : undefined
  if (outcome === 'missing' || outcome === 'stub') return (skeleton ?? integration ?? only)?.key ?? null
  return (integration ?? only)?.key ?? null
}

/** `$SLAVEOFAI_SMOKE_PROJECT` (spec S5): unique per attempt, and a valid compose project name. */
export function smokeProjectName(attemptId: string): string {
  return `slaveofai-smoke-${attemptId.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 12)}`
}

const SAID: Readonly<Record<SmokeFailure, string>> = {
  missing: `there is no ${SMOKE_SCRIPT_PATH}`,
  stub: `${SMOKE_SCRIPT_PATH} is still the stub`,
  failed: 'the smoke check failed',
  timed_out: 'the smoke check timed out',
}

/**
 * The rework reason a failed smoke sends (plan B D4). Its output is the SCRIPT's -- code a worker
 * wrote -- landing in another run's prompt, so it is sanitised and bounded like a verifier's evidence.
 * `executable: false` (F10) says a script that exists but lacks the executable bit is being reworked.
 */
export function renderSmokeRework(input: { readonly round: number; readonly outcome: SmokeFailure; readonly output: string; readonly executable?: boolean }): string {
  const output = trimEvidence(sanitisePersonText(input.output), 2500)
  const printed = output === '' ? '(it printed nothing)' : output
  if (input.outcome === 'missing' || input.outcome === 'stub') {
    const why =
      input.outcome === 'stub'
        ? `${SMOKE_SCRIPT_PATH} is still the stub`
        : input.executable === false
          ? `${SMOKE_SCRIPT_PATH} is not executable (run \`chmod +x ${SMOKE_SCRIPT_PATH}\` and commit the mode)`
          : `This project has no ${SMOKE_SCRIPT_PATH} yet`
    return trimEvidence(
      [`${why}, so the smoke check of verification round ${String(input.round)} could not show the product runs. Write it:`, ...SMOKE_CONTRACT_LINES, 'Its output:', printed].join('\n'),
      VERIFICATION_REWORK_MAX_CHARS,
    )
  }
  return trimEvidence(
    [
      `The smoke check of verification round ${String(input.round)} ${input.outcome === 'timed_out' ? 'timed out' : 'failed'}: \`bash ${SMOKE_SCRIPT_PATH}\` must start the product the way the README documents and run one basic user flow. Make it pass, then finish as your instructions describe.`,
      // Plan B D11 (user ruling 2026-09-30): the structured hand-off `handOffSmokeRework` reads.
      'If the fix is in a file another package owns, do not edit it: add "handOff": {"path": "<that file>", "change": "<exactly what must change>"} to your <slave-report>. A file the skeleton owns is sent to the skeleton, once.',
      'Its output:',
      printed,
    ].join('\n'),
    VERIFICATION_REWORK_MAX_CHARS,
  )
}

/** The `needs_human` reason when a failed smoke meets the round cap or a package that cannot be reworked. */
export function smokeStopReason(input: { readonly outcome: SmokeFailure; readonly output: string }): string {
  const output = trimEvidence(sanitisePersonText(input.output).replace(/\s+/gu, ' ').trim(), 800)
  return `${SAID[input.outcome]}${output === '' ? '' : `: ${output}`}`
}

/** Spec S8: a passing smoke, handed to the verifier as evidence -- not as its RUN verdict. */
export function renderSmokeEvidence(input: { readonly output: string; readonly durationMs: number | null; readonly tip: string }): string {
  const took = input.durationMs === null ? '' : ` in ${String(Math.round(input.durationMs / 1000))} s`
  return [
    `The orchestrator ran \`bash ${SMOKE_SCRIPT_PATH}\` on commit ${input.tip.slice(0, 12)} and it passed${took}. Its output is evidence the product can start -- not a substitute for your own ${RUN_REQUIREMENT_KEY} check:`,
    trimEvidence(sanitisePersonText(input.output), SMOKE_OUTPUT_MAX_CHARS),
  ].join('\n')
}
