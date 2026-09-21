import {
  SUPERVISOR_UPLOAD_MAX_BYTES,
  SUPERVISOR_UPLOAD_MAX_FILES,
  refusalText,
  storeSupervisorUploads,
  type ControlRefusal,
} from '@slave-of-ai/control'
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
 * The most a WHOLE request may declare before a byte of it is read: the per-file cap times the
 * file cap (fix round 1, I1).
 *
 * A coarse outer bound on purpose. The real body is a little larger than the sum of its files
 * (multipart carries boundaries and headers), and one file past twenty megabytes inside a request
 * under this number is still refused by `storeSupervisorUploads` with the name of the file that
 * did it. What this stops is the OTHER thing: a caller that declares a gigabyte, which would
 * otherwise be decoded into this process's memory before anybody asked whether it could be
 * accepted at all.
 */
const UPLOAD_BODY_MAX_BYTES = SUPERVISOR_UPLOAD_MAX_FILES * SUPERVISOR_UPLOAD_MAX_BYTES

const TOO_LARGE =
  `the whole request must declare at most ${String(UPLOAD_BODY_MAX_BYTES)} bytes -- ` +
  `${String(SUPERVISOR_UPLOAD_MAX_FILES)} files of ${String(SUPERVISOR_UPLOAD_MAX_BYTES)}`

/**
 * What a person attached, into the project's repository (R6).
 *
 * THE ORDER IS THE POINT (fix round 1, I1). Four questions are answered in this order, cheapest
 * and most decisive first, and the first three of them before a byte of the body is decoded:
 *
 *  1. **is this project writable** -- `archivedRefusal`, which is one indexed read. It runs before
 *     `request.formData()` rather than after, so an upload to an archived project is refused
 *     without a hundred megabytes being parsed into this process on the way to the same answer.
 *  2. **is the declared size sane** -- `content-length` against {@link UPLOAD_BODY_MAX_BYTES},
 *     413, the precedent `POST /api/hooks/:source/:hookId` set for the same reason.
 *  3. **is it multipart at all** -- 400.
 *  4. **are there too many files** -- 400 from the verb's own sentence, decided off the form's
 *     entries BEFORE `arrayBuffer()` copies each one. `formData()` has already decoded the parts
 *     by then, but the copy this skips is a second full-size buffer per file.
 *
 * Then, and only then, the files are copied into `Buffer`s and handed over. The WHOLE body in
 * memory is deliberate at that point: `storeSupervisorUploads` decides every remaining check
 * before it writes anything, and a streaming path would have to write first and refuse afterwards
 * -- exactly the half-landed request that verb exists to prevent.
 *
 * EVERY `File` VALUE IN THE FORM, under any field name: a browser's `<input multiple>`, a drop
 * zone and a `curl -F` all name the field differently, and the field name carries no meaning here
 * -- the file's own name does. Non-file values (a stray text field) are ignored rather than
 * refused: they are not files, and nothing in this request depends on them.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params

  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal

  // `?? Number.NaN` rather than letting `Number(null)` be 0: an ABSENT header is "nothing
  // declared", not "declared zero", and a chunked upload declares no length at all. NaN is not
  // finite, so either way the request falls through to the real checks below.
  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > UPLOAD_BODY_MAX_BYTES) {
    return Response.json({ error: TOO_LARGE }, { status: 413 })
  }

  const form = await request.formData().catch(() => null)
  if (form === null) return Response.json({ error: BODY_ERROR }, { status: 400 })

  const files = [...form.values()].filter((value): value is File => value instanceof File)
  if (files.length > SUPERVISOR_UPLOAD_MAX_FILES) {
    // The verb's own sentence for the verb's own refusal, asked here only so the copy below is
    // never made. `storeSupervisorUploads` asks it again first thing, which is what keeps a
    // caller that reaches it another way answering the same.
    const tooMany = { kind: 'too_many_attachments', limit: SUPERVISOR_UPLOAD_MAX_FILES, count: files.length } as const
    return Response.json(
      { error: refusalText(tooMany), kind: tooMany.kind },
      // Through the same table the tail of this function reads, so the two answers to one refusal
      // kind cannot drift apart.
      { status: UPLOAD_STATUS[tooMany.kind] ?? refusalStatus(tooMany.kind) },
    )
  }

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
