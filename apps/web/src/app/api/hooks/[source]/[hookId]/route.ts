import {
  HOOK_BODY_MAX_BYTES,
  hookRefusalLine,
  ingestExternalEvent,
  verifyHookDelivery,
} from '@slave-of-ai/control'

export const dynamic = 'force-dynamic'

/**
 * Node, never the edge (fix round 1, item 2).
 *
 * This route's import graph reaches `verifyHookDelivery`, whose HMAC is `node:crypto`'s
 * `createHmac` + `timingSafeEqual` (`packages/control/src/triggers.ts:1`) -- neither of which the
 * edge runtime has. `nodejs` is already Next's default for a route handler, so this line changes
 * nothing today; it is here so that an edge opt-in has to be a deliberate edit to a line that says
 * why it cannot be made, rather than a default that quietly moves. `apps/web/test/integration/
 * hooks-route.test.ts` asserts the export.
 */
export const runtime = 'nodejs'

/** Bounded and printable, because this string goes into a unique index and into no log line. */
const DELIVERY_ID_RE = /^[\x21-\x7e]{1,200}$/u

/**
 * The body, read under the cap rather than measured after it (plan erratum E20).
 *
 * `await request.arrayBuffer()` would buffer the WHOLE body before anything could measure it, and a
 * Next 15 App Router handler has no body limit of its own (`bodySizeLimit` is Server-Actions-only,
 * and `apps/web/next.config.ts` sets none) -- so on the one path an unauthenticated stranger can
 * reach, the cap has to be enforced WHILE reading. This pulls `request.body` chunk by chunk, keeps a
 * running count, and the moment that count would pass `HOOK_BODY_MAX_BYTES` it discards the crossing
 * chunk, cancels the reader and answers `null`. Nothing this function retains ever exceeds the cap,
 * and the sender's remaining bytes are never pulled off the socket at all.
 *
 * The residue, stated honestly: the TRANSPORT chooses the chunk size, so the peak allocation is the
 * cap plus one chunk rather than the cap exactly. That is a bound the caller cannot choose, which is
 * the whole difference from `arrayBuffer()`, where the caller chooses it.
 *
 * `request.body === null` (a POST with no body at all) is an EMPTY body and not an error: it is
 * signed like any other body, and an empty body is a payload this system cannot parse, which the
 * `400` at step 4 already answers.
 *
 * The bytes it returns are the bytes that arrived, concatenated and not re-encoded -- plan erratum
 * E3 holds unchanged, and these are the bytes the HMAC is computed over.
 */
async function readBounded(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    if (total + value.byteLength > HOOK_BODY_MAX_BYTES) {
      // The crossing chunk is dropped rather than kept: what is retained stays at or under the cap.
      await reader.cancel()
      return null
    }
    chunks.push(value)
    total += value.byteLength
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * One inbound delivery (M54 R1, R3, R10, R11).
 *
 * THE ONLY PUBLIC WRITE SURFACE THIS PRODUCT HAS. `apps/web/src/lib/boundary.ts`'s
 * `PUBLIC_API_PREFIX` lets a request reach this function with no session, from any host, with any
 * fetch metadata -- and the carve-out buys nothing, because this function reads nothing past the
 * cap, parses no JSON, writes nothing to Prisma and appends no event until `verifyHookDelivery` has
 * answered `ok`.
 *
 * There is no `node:crypto` here and there never will be: that module is banned in `apps/web/src`
 * (`../../../../lib/session.ts:1-7`) because this tree also compiles for Next's edge middleware, and
 * `apps/web/test/web-crypto-boundary.test.ts` is the scan that keeps it true. The HMAC lives in
 * `packages/control`, which is server-only by construction.
 *
 * THE ORDER IS THE RULE SET, and each step's refusal is the one R11 fixes:
 *
 *  1. the declared length, then the body READ UNDER the cap -- `413`, before any secret is read. The
 *     header check refuses an oversized body before the stream is even opened; `readBounded` is the
 *     second lock, because a chunked request carries no `Content-Length` and two of them join to a
 *     value that is not a number. Both answer identically for a hookId that exists and one that does
 *     not, so the bound is an oracle for nothing.
 *  2. the SIGNATURE, over the raw bytes -- `401 {"error":"unauthenticated"}` for all six ways of
 *     being nobody, with one bounded line on stderr naming which (R10's asymmetry).
 *  3. the DELIVERY ID -- `400`. With no idempotency key there is no way to deduplicate, and writing
 *     a row that can never be deduplicated is worse than refusing.
 *  4. the BODY, decoded and parsed -- `400`. `TextDecoder(..., { fatal: true })` rather than
 *     `Request.text()` (plan erratum E3): the signature was over bytes, and a body that is not valid
 *     UTF-8 is a payload this system cannot read rather than a caller it cannot identify.
 *  5. `ingestExternalEvent` -- `200` for `actioned`, `ignored` and `replayed`, `400` for a payload
 *     the adapter refuses.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ source: string; hookId: string }> },
): Promise<Response> {
  const { source, hookId } = await context.params

  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > HOOK_BODY_MAX_BYTES) {
    console.error(hookRefusalLine(source, 'body_too_large'))
    return Response.json({ error: 'body too large' }, { status: 413 })
  }
  const bytes = await readBounded(request.body)
  if (bytes === null) {
    console.error(hookRefusalLine(source, 'body_too_large'))
    return Response.json({ error: 'body too large' }, { status: 413 })
  }

  const identity = await verifyHookDelivery(source, hookId, bytes, request.headers.get('x-hub-signature-256'))
  if (!identity.ok) {
    console.error(hookRefusalLine(source, identity.error))
    // ONE sentence for all six. A 404 for an unknown hook would answer "does this hook exist", which
    // is a question this system must not answer to somebody who could not sign for it.
    return Response.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const deliveryId = request.headers.get('x-github-delivery')
  // A shape failure and an absence are the same fact -- there is no usable idempotency key -- so they
  // share one reason (plan decision D33) and the closed set in R10 stays at nine.
  if (deliveryId === null || !DELIVERY_ID_RE.test(deliveryId)) {
    console.error(hookRefusalLine(source, 'delivery_id_absent'))
    return Response.json({ error: 'no usable delivery id' }, { status: 400 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    console.error(hookRefusalLine(source, 'payload_invalid'))
    return Response.json({ error: 'payload invalid' }, { status: 400 })
  }

  const outcome = await ingestExternalEvent(identity.value, {
    deliveryId,
    eventName: request.headers.get('x-github-event') ?? '',
    payload,
  })
  if (outcome.status === 'invalid') {
    console.error(hookRefusalLine(source, outcome.reason))
    return Response.json({ error: 'payload invalid' }, { status: 400 })
  }
  // The outcome IS the body: `{status, inboundEventId, goalVersion}`, `{status, inboundEventId,
  // reason}` or `{status, inboundEventId}`, which are the three shapes R4 fixes byte for byte.
  return Response.json(outcome)
}
