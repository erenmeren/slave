import {
  HOOK_BODY_MAX_BYTES,
  hookRefusalLine,
  ingestExternalEvent,
  verifyHookDelivery,
} from '@slave-of-ai/control'

export const dynamic = 'force-dynamic'

/** Bounded and printable, because this string goes into a unique index and into no log line. */
const DELIVERY_ID_RE = /^[\x21-\x7e]{1,200}$/u

/**
 * One inbound delivery (M54 R1, R3, R10, R11).
 *
 * THE ONLY PUBLIC WRITE SURFACE THIS PRODUCT HAS. `apps/web/src/lib/boundary.ts`'s
 * `PUBLIC_API_PREFIX` lets a request reach this function with no session, from any host, with any
 * fetch metadata -- and the carve-out buys nothing, because this function parses no JSON, touches no
 * Prisma and appends no event until `verifyHookDelivery` has answered `ok`.
 *
 * There is no `node:crypto` here and there never will be: that module is banned in `apps/web/src`
 * (`../../../../lib/session.ts:1-7`) because this tree also compiles for Next's edge middleware, and
 * `apps/web/test/web-crypto-boundary.test.ts` is the scan that keeps it true. The HMAC lives in
 * `packages/control`, which is server-only by construction.
 *
 * THE ORDER IS THE RULE SET, and each step's refusal is the one R11 fixes:
 *
 *  1. the declared length, then the ACTUAL byte length -- `413`, before any secret is read. The
 *     header check refuses an oversized body before it is buffered at all; the measured check is the
 *     second lock, because a chunked request carries no `Content-Length`. Both answer identically for
 *     a hookId that exists and one that does not, so the bound is an oracle for nothing.
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
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > HOOK_BODY_MAX_BYTES) {
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
