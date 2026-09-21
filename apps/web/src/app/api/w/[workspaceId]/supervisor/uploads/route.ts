import { refusalText, storeSupervisorUploads, type ControlRefusal } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../../server/workspaceControlRoute'
import { refusalStatus } from '../../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * The four refusals an ATTACHMENT has an HTTP word for (R6).
 *
 * `refusalStatus` answers 409 for all four, which is the right answer for a control verb and the
 * wrong one for a file upload: a browser's upload control, a `curl`, and anybody reading a log
 * already know what 413 and 415 mean, and telling "too big" from "we cannot read that" from
 * "too many" by parsing an English sentence is what those codes exist to prevent. Every OTHER
 * kind this route can see (a project that is not there, a repository that has moved, a commit
 * that failed) falls through to `refusalStatus`' own answer, so nothing here can ever reach a
 * caller as a 500.
 */
const UPLOAD_STATUS: Partial<Record<ControlRefusal['kind'], 400 | 413 | 415>> = {
  attachment_too_large: 413,
  attachment_kind_not_allowed: 415,
  too_many_attachments: 400,
  // A name that is a path is a malformed REQUEST, not a state the project is in -- the same 400
  // the body schemas beside this route answer for a field of the wrong shape.
  attachment_path_refused: 400,
}

const BODY_ERROR = 'the body must be a multipart form carrying the files'

/**
 * What a person attached, into the project's repository (R6).
 *
 * `await request.formData()` and the WHOLE body in memory: the cap is five files of twenty
 * megabytes, `storeSupervisorUploads` takes `Buffer`s because it decides every check before it
 * writes anything, and a streaming path would have to write first and refuse afterwards -- which
 * is exactly the half-landed request that verb exists to prevent.
 *
 * EVERY `File` VALUE IN THE FORM, under any field name: a browser's `<input multiple>`, a drop
 * zone and a `curl -F` all name the field differently, and the field name carries no meaning here
 * -- the file's own name does. Non-file values (a stray text field) are ignored rather than
 * refused: they are not files, and nothing in this request depends on them.
 *
 * The archived guard runs FIRST: this writes a file to a repository and makes a commit.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params

  const form = await request.formData().catch(() => null)
  if (form === null) return Response.json({ error: BODY_ERROR }, { status: 400 })

  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal

  const files = [...form.values()].filter((value): value is File => value instanceof File)
  const uploads = await Promise.all(
    files.map(async (file) => ({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })),
  )

  const result = await storeSupervisorUploads(workspaceId, uploads, gate.principal ?? undefined)
  if (!result.ok) {
    return Response.json(
      { error: refusalText(result.error), kind: result.error.kind },
      { status: UPLOAD_STATUS[result.error.kind] ?? refusalStatus(result.error.kind) },
    )
  }
  return Response.json({ attachments: result.value })
}
