import { isAbsolute } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { BROKERED_OPERATIONS, type Result, err, ok } from '@slave-of-ai/domain'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/**
 * What kind of secret a credential NAMES (M52 R3). The `CredentialKind` Postgres enum, as data.
 *
 * Spelled here rather than in `@slave-of-ai/domain` because nothing outside this file and the CLI
 * behind it decides anything from it: it is a label an operator picks so a later reader knows what
 * `FAKE_DEPLOY_TOKEN` is for, and no rule in this system branches on it. What keeps it in step with
 * the enum is the WRITE below -- `input.kind` goes straight into the `CredentialKind` column, so a
 * member this list has and the database does not fails the typecheck.
 */
export const CREDENTIAL_KINDS = ['deploy_token', 'git_token', 'api_key'] as const
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]

/**
 * What each kind is CALLED when a person reads it (`docs/ia.md` rule 3, M52 fix round 1).
 *
 * Beside {@link CREDENTIAL_KINDS} rather than in `@slave-of-ai/domain`'s label layer, because the
 * list itself is here and for the reason stated above it: nothing outside this file and the CLI
 * behind it decides anything from a credential kind. What matters is only that no printed surface
 * shows `deploy_token` -- `credential list` and `credential add` print these words.
 *
 * `Record<CredentialKind, string>` is load-bearing exactly as `PERMISSION_LABEL`'s is: a fourth
 * kind fails the build here rather than turning up on an operator's screen as an identifier.
 */
export const CREDENTIAL_KIND_LABEL: Record<CredentialKind, string> = {
  deploy_token: 'Deploy token',
  git_token: 'Git token',
  api_key: 'API key',
}

/**
 * What an environment variable may be called: upper-case, digits and underscores, starting with a
 * letter, at most 128 characters.
 *
 * A SHAPE check, never a lookup. The name is stored and handed to the executor; whether the variable
 * is set on this host is a question for execution time, and the broker's `credential_unset` is the
 * refusal that answers it.
 */
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]{0,127}$/u

const ENV_VAR_RULE =
  'an environment variable name must be upper-case letters, digits and underscores, ' +
  'start with a letter, and be at most 128 characters'

/** One credential, as every reader of this table sees it. There is no `value` field because there
 *  is no `value` column: the row names a variable and nothing in this system holds what is in it. */
export interface CredentialRecord {
  readonly id: string
  readonly name: string
  readonly kind: CredentialKind
  readonly envVar: string
  readonly createdAt: Date
}

/** One binding, with the credential's NAME and variable name beside it -- what `broker list` prints
 *  and what an operator checks a fresh install against. Never a value. */
export interface BrokerBindingRecord {
  readonly op: string
  readonly command: readonly string[]
  readonly credentialName: string | null
  readonly envVar: string | null
}

/**
 * Register a credential this project's brokered operations may be run with (M52 R3).
 *
 * THE VALUE IS NEVER READ HERE. This verb validates the variable's NAME and stores it. Whether the
 * variable is actually exported is a question for execution time, and answering it here would make
 * "the operator has not exported it yet" a refusal to write a row that is otherwise correct -- and
 * would tempt a later version to report WHICH variables are set, which is an enumeration oracle
 * pointed at the daemon's own environment.
 *
 * `principal` is the trailing optional parameter a control verb a person calls takes. Nothing is
 * attributed with it yet: M52 adds no `credential.added` event (its event budget is three, and only
 * `permission.changed` attributes a person), so this row records no author -- the same "No event"
 * shape the catalog verbs in `org.ts` carry.
 */
export async function addCredential(
  workspaceId: string,
  input: { readonly name: string; readonly kind: CredentialKind; readonly envVar: string },
  principal?: Principal,
): Promise<Result<CredentialRecord, ControlRefusal>> {
  const name = input.name.trim()
  if (name === '') return err({ kind: 'invalid_name' })
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(input.kind)) {
    return err({ kind: 'invalid_name', detail: `a credential kind must be one of: ${CREDENTIAL_KINDS.join(', ')}` })
  }
  if (!ENV_VAR_RE.test(input.envVar)) return err({ kind: 'invalid_name', detail: ENV_VAR_RULE })

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  // `@@unique([workspaceId, name])` is the real guard; this read is what turns the collision into
  // the refusal a person reads instead of a Prisma P2002 nobody can act on. A concurrent second add
  // of the same name still meets the index, which throws -- the honest outcome for two operators
  // adding one name at once.
  const clash = await prisma.credential.findUnique({
    where: { workspaceId_name: { workspaceId, name } },
    select: { id: true },
  })
  if (clash !== null) return err({ kind: 'duplicate_name', name })

  const row = await prisma.credential.create({
    data: { workspaceId, name, kind: input.kind, envVar: input.envVar },
  })
  return ok(toCredential(row))
}

/** Every credential this project has registered, name ascending. The `envVar` is a NAME; this verb
 *  does not read it, and neither does anything that prints what it returns. */
export async function listCredentials(workspaceId: string): Promise<readonly CredentialRecord[]> {
  const rows = await prisma.credential.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } })
  return rows.map(toCredential)
}

/**
 * Say what one brokered operation actually RUNS in this project, and with which credential (M52 R3).
 *
 * `command` is ARGV, not a shell string. The parameters a worker supplies never enter it -- they
 * ride in the child's environment as `SLAVEOFAI_BROKER_PARAM_*` -- and argv is what makes that a
 * property of the SHAPE rather than of a quoting rule somebody has to keep getting right. Its first
 * element is absolute because a relative one resolves against whatever working directory the daemon
 * happens to have when the operation is asked for.
 *
 * `op` is checked against `BROKERED_OPERATIONS`. A binding for an op the manifest does not carry can
 * never be invoked, so writing one is a row that looks like configuration and is not -- an operator
 * would read it as "deploying is wired up here" and be wrong.
 *
 * One binding per op per project (`@@unique([workspaceId, op])`): this REBINDS in place rather than
 * adding a second, because two commands for one verb is a question nothing downstream could answer.
 *
 * `principal` is accepted and unrecorded, for {@link addCredential}'s reason.
 */
export async function bindBrokerOp(
  workspaceId: string,
  input: { readonly op: string; readonly command: readonly string[]; readonly credentialName?: string },
  principal?: Principal,
): Promise<Result<BrokerBindingRecord, ControlRefusal>> {
  if (!Object.hasOwn(BROKERED_OPERATIONS, input.op)) {
    return err({ kind: 'broker_refused', op: input.op, reason: 'not_brokered' })
  }
  const first = input.command[0]
  if (first === undefined || !isAbsolute(first)) {
    return err({ kind: 'broker_refused', op: input.op, reason: 'invalid_params' })
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  // By NAME, scoped to this project. A credential id would let one project's binding point at
  // another's secret, which is the one thing the `workspaceId` on both tables exists to stop.
  const credential =
    input.credentialName === undefined
      ? null
      : await prisma.credential.findUnique({
          where: { workspaceId_name: { workspaceId, name: input.credentialName } },
          select: { id: true, name: true, envVar: true },
        })
  if (input.credentialName !== undefined && credential === null) {
    return err({ kind: 'credential_not_found', name: input.credentialName })
  }

  const command = [...input.command]
  await prisma.brokerBinding.upsert({
    where: { workspaceId_op: { workspaceId, op: input.op } },
    update: { command, credentialId: credential?.id ?? null },
    create: { workspaceId, op: input.op, command, credentialId: credential?.id ?? null },
  })
  return ok({
    op: input.op,
    command,
    credentialName: credential?.name ?? null,
    envVar: credential?.envVar ?? null,
  })
}

/** Every brokered operation this project has wired up, op ascending. */
export async function listBrokerBindings(workspaceId: string): Promise<readonly BrokerBindingRecord[]> {
  const rows = await prisma.brokerBinding.findMany({
    where: { workspaceId },
    orderBy: { op: 'asc' },
    select: { op: true, command: true, credential: { select: { name: true, envVar: true } } },
  })
  return rows.map((row) => ({
    op: row.op,
    command: row.command,
    credentialName: row.credential?.name ?? null,
    envVar: row.credential?.envVar ?? null,
  }))
}

function toCredential(row: {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly envVar: string
  readonly createdAt: Date
}): CredentialRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as CredentialKind,
    envVar: row.envVar,
    createdAt: row.createdAt,
  }
}
