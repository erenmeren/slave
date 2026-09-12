import { z } from 'zod'
import type { PermissionKind } from '../permission/kinds.js'

/**
 * Every operation the orchestrator will perform ON A WORKER'S BEHALF, as a static manifest (M52 R3).
 *
 * The whole point is the narrowness. A worker does not ask for a command, a URL, a host or a path:
 * it names one of the operations below and hands it typed parameters, and the orchestrator resolves
 * the rest -- the command template from a `BrokerBinding`, the secret from
 * `process.env[Credential.envVar]` -- out of rows only a person can write. `deploy_release` takes
 * an environment KEY and a digest precisely so a parameter can never name a target the binding did
 * not register: the narrowest verb the operation can be expressed as, never `runCommand(string)`.
 *
 * A STATIC manifest rather than rows: this table is auditable before anything loads, and an
 * operator who adds a `BrokerBinding` for an op that is not here gets a refusal rather than an
 * execution. `git_push` is the second op this registry is shaped for and is deliberately out of
 * scope for M52 (spec §3): there is no `git push` and no remote anywhere in `apps/orchestrator` or
 * `packages/control`, so proving it would need a faked remote as well as a faked credential, and
 * `deploy_release` proves the same mechanism with one fake.
 */
export const BROKERED_OPERATIONS = {
  deploy_release: {
    grant: 'deploy_release',
    params: z
      .object({
        /** An environment KEY, never a URL and never a host. Lowercase, bounded, and shell-safe by
         *  construction -- which matters because the resolved command is executed through
         *  `runShellCommand`, and a parameter that could carry a quote or a semicolon would be an
         *  injection whatever the executor promised. The parameters never enter the command string
         *  at all (they ride in the child's environment), and this regex is the second lock. */
        environment: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/u),
        /** A content digest: lowercase hex, short-sha to full sha256. Not a tag and not a branch --
         *  a name can move, and a release that moved is a release nobody can reproduce. */
        digest: z.string().regex(/^[a-f0-9]{7,64}$/u),
      })
      .strict(),
  },
} as const satisfies Record<string, { readonly grant: PermissionKind; readonly params: z.ZodType }>

export const BROKER_OPS = Object.keys(BROKERED_OPERATIONS) as readonly (keyof typeof BROKERED_OPERATIONS)[]
export type BrokerOp = keyof typeof BROKERED_OPERATIONS

/** What each op is CALLED (`docs/ia.md` rule 3) -- the activity card and the CLI print this. */
export const BROKER_OP_LABEL: Record<BrokerOp, string> = {
  deploy_release: 'Deploy a release',
}

/**
 * Every way a brokered call is refused (M52 R3), in the order the authoriser asks them.
 *
 * ONE list, in one place, because it has two homes that must not drift: the `broker.refused`
 * payload a person reads months later, and `ControlRefusal`'s `broker_refused` (plan erratum E5 --
 * one refusal kind carrying a reason, rather than seven refusal kinds re-spelling this list).
 *
 * `credential_unset` is the seventh and the one R3 did not name: a binding that names a credential
 * whose `envVar` is absent from the DAEMON'S OWN environment. It is the first thing an operator
 * meets on a fresh install, and `not_brokered` would describe it falsely -- the op IS brokered, the
 * secret simply is not there.
 */
export const BROKER_REFUSAL_REASONS = [
  'identity_mismatch',
  'run_not_live',
  'permission_denied',
  'not_brokered',
  'credential_unset',
  'invalid_params',
  'simulation',
] as const

export type BrokerRefusalReason = (typeof BROKER_REFUSAL_REASONS)[number]

export const BROKER_REFUSAL_LABEL: Record<BrokerRefusalReason, string> = {
  identity_mismatch: 'The caller is not the run it claims to be',
  run_not_live: 'That run is over',
  permission_denied: 'This worker was not granted that',
  not_brokered: 'Nothing is bound to that operation here',
  credential_unset: 'The credential is not set on this host',
  invalid_params: 'Those parameters do not fit the operation',
  simulation: 'A simulation reaches nothing real',
}

/**
 * How long ONE brokered operation may run in the daemon's process.
 *
 * Two minutes, not the ten `DEFAULT_COMMAND_TIMEOUT_MS` gives a setup command
 * (`apps/orchestrator/src/shell.ts:33`): a setup command runs once per worktree and a broker call
 * runs inside a worker's turn, with a vendor CLI holding its tool call open the whole time.
 */
export const BROKER_TIMEOUT_MS = 120_000

/**
 * How long the WORKER'S thin client waits for a reply.
 *
 * Strictly greater than {@link BROKER_TIMEOUT_MS}, and the test pins the inequality rather than the
 * gap: a client that gave up first would report "no answer" for an operation that had in fact run,
 * which is the one failure mode an audit trail cannot recover from.
 */
export const BROKER_CLIENT_TIMEOUT_MS = 150_000

/** How many `run.tool_denied` events naming ONE kind raise `permission_blocked` (M52 R5). Three,
 *  because one is a worker trying something, two is a worker retrying, and three is a wall. */
export const PERMISSION_TRIP_COUNT = 3

/** How far back the denial count looks. Half an hour: long enough to span a run, short enough that
 *  a wall somebody moved last week does not raise a situation today. */
export const PERMISSION_DENIAL_WINDOW_MS = 30 * 60_000
