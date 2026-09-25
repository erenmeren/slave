/**
 * H9b R1: whose failure a failed run was (`SlaveRun.failureClass`).
 *
 * `worker` is the work failing -- a terminal error, an unexcused denial, a gate. `platform` is
 * everything nothing the worker did could have changed: a spawn that never reached the model, a
 * process that died with the daemon, a provider that refused the call, a timeout decided after the
 * host slept. A platform failure spends nothing -- no breaker rung, no attempt, no planning or
 * review retry -- and the Supervisor reads it as `infrastructure`. A failed run with no class is a
 * row written before the column existed and reads as `worker`, which is how it counted then.
 */
export const FAILURE_CLASSES = ['worker', 'platform'] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]
