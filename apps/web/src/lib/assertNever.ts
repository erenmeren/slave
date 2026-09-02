/** Exhaustiveness at compile time and a loud error at run time: a `switch` over a union that
 *  reaches this has met a member the code was never written for. Never allow by fall-through. */
export function assertNever(value: never): never {
  throw new Error(`unreachable: ${String(value)}`)
}
