import {
  BASELINE_GRANTS,
  PERMISSION_KINDS,
  TOOLS_BY_KIND,
  type PermissionKind,
  type PermissionProvider,
  type PermissionRunKind,
} from './kinds.js'

/** One `SlavePermission` row, as the two functions below read it. A flat shape rather than the
 *  Prisma row for `packages/domain`'s standing reason: the domain is pure, and a shape the caller
 *  can build from a row is what lets the web, the orchestrator and a test run one rule. */
export interface PermissionRowInput {
  readonly kind: PermissionKind
  readonly mode: 'allow' | 'deny'
  readonly grantedBy?: string | null
  readonly grantedAt?: string | null
}

/** Where a kind's effective answer CAME FROM (M52 R7) -- computed, never stored. */
export type GrantSource = 'baseline' | 'granted' | 'refused' | 'never'

/** One resolved allow-list entry: a vendor tool, and the operation that put it there. The `kind`
 *  rides along because the gate has to be able to say WHY, and because `permissions.json` is read
 *  by a shell that has no table of its own. */
export interface ResolvedGrant {
  readonly tool: string
  readonly kind: PermissionKind
}

function isPermissionKind(value: string): value is PermissionKind {
  return (PERMISSION_KINDS as readonly string[]).includes(value)
}

/**
 * The ALLOWED vendor tools for one run (M52 R2), replacing M18's `resolveDenyList`.
 *
 * `BASELINE_GRANTS[runKind] ∪ {rows with mode allow}` minus `{rows with mode deny}`, resolved
 * through {@link TOOLS_BY_KIND} for the run's own provider. Three properties the callers depend on:
 *
 * - **Deny wins, always.** A `deny` row is a person's explicit refusal and overrules both the
 *   baseline and an `allow` row for the same kind, whatever order the rows arrive in. The old
 *   resolver could not express this at all: `allow` and unset were identical to it
 *   (`permission.ts:53`), and "unset" allowed at the gate as well.
 * - **Order is the list's, not the query's.** Kinds are walked in `PERMISSION_KINDS` order and
 *   tools in `TOOLS_BY_KIND` order, so the same matrix produces a byte-equal `permissions.json`
 *   however Postgres returned the rows -- which is what makes the file diffable across a resume.
 * - **A kind nobody mapped contributes nothing.** A row whose `kind` is not one of the six (a
 *   hand-written row; a row from a database a future version wrote) is skipped rather than trusted,
 *   which under default-deny is the safe direction.
 *
 * Pure, and in `packages/domain` rather than `packages/control` (plan erratum E12): the Settings
 * matrix and the worker panel need the same rule, and a `'use client'` component may not import
 * `@slave-of-ai/control` -- that barrel re-exports `@slave-of-ai/providers`, which imports
 * `node:child_process` at module scope (`apps/web/src/components/PermissionMatrix.tsx:40-43`).
 */
export function resolveGrants(
  rows: readonly PermissionRowInput[],
  provider: PermissionProvider,
  runKind: PermissionRunKind,
): readonly ResolvedGrant[] {
  const denied = new Set<PermissionKind>()
  const allowed = new Set<PermissionKind>(BASELINE_GRANTS[runKind])
  for (const row of rows) {
    if (!isPermissionKind(row.kind)) continue
    if (row.mode === 'deny') denied.add(row.kind)
    else allowed.add(row.kind)
  }
  const out: ResolvedGrant[] = []
  for (const kind of PERMISSION_KINDS) {
    if (denied.has(kind) || !allowed.has(kind)) continue
    for (const tool of TOOLS_BY_KIND[kind][provider]) out.push({ tool, kind })
  }
  return out
}

/** One kind's effective answer, and where it came from. */
export interface KindGrant {
  readonly kind: PermissionKind
  /** The stored row's mode, or `null` when there is no row: the three states the matrix's ✓/✕/–
   *  have always drawn, unchanged. */
  readonly mode: 'allow' | 'deny' | null
  readonly source: GrantSource
  /** Who decided, and when -- `null` on both when nobody did. ISO strings, not `Date`: this
   *  projection crosses a server/client boundary. */
  readonly by: string | null
  readonly at: string | null
}

/**
 * Every kind's effective answer for one worker, for the surfaces that must explain themselves
 * (M52 R7).
 *
 * The SOURCE is the sentence the worker panel prints under Advanced: `baseline` is "nobody decided
 * and the run kind says yes", `granted`/`refused` are "a person decided, here is who and when", and
 * `never` is "nobody has ever been asked". It is computed from the same two inputs
 * {@link resolveGrants} reads and is stored nowhere, so it cannot disagree with what the gate does.
 *
 * The run kind is a parameter because the baseline is: the same worker reads as `baseline` for
 * `run_commands` on an implementation run and `never` on a planning one, and both are true.
 */
export function grantsFor(
  rows: readonly PermissionRowInput[],
  runKind: PermissionRunKind,
): readonly KindGrant[] {
  const byKind = new Map<PermissionKind, PermissionRowInput>()
  for (const row of rows) {
    if (!isPermissionKind(row.kind)) continue
    // Deny wins here too, for `resolveGrants`' reason: two rows for one kind is a state
    // `@@unique([slaveId, kind])` forbids, and if one ever appears the refusal is the safe read.
    const existing = byKind.get(row.kind)
    if (existing === undefined || row.mode === 'deny') byKind.set(row.kind, row)
  }
  const baseline = new Set<PermissionKind>(BASELINE_GRANTS[runKind])
  return PERMISSION_KINDS.map((kind): KindGrant => {
    const row = byKind.get(kind)
    if (row === undefined) {
      return {
        kind,
        mode: null,
        source: baseline.has(kind) ? 'baseline' : 'never',
        by: null,
        at: null,
      }
    }
    return {
      kind,
      mode: row.mode,
      source: row.mode === 'allow' ? 'granted' : 'refused',
      by: row.grantedBy ?? null,
      at: row.grantedAt ?? null,
    }
  })
}
