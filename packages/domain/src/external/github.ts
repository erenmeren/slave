import { z } from 'zod'
import { err, ok, type Result } from '../result.js'
import { EXTERNAL_TEXT_MAX_CHARS, EXTERNAL_TITLE_MAX_CHARS, sanitiseExternalText } from './fence.js'
import {
  EXTERNAL_REF_RE,
  EXTERNAL_URL_MAX_CHARS,
  REPOSITORY_FULL_NAME_RE,
  type ExternalOrigin,
} from './origin.js'
import type { ExternalEventKind } from './request.js'

/**
 * The four `pull_request` actions that MOVE a pull request (M54 R7; plan erratum E8 -- the spec
 * names the KIND and not the deliveries).
 *
 * `synchronize` is deliberately absent: a push to a branch fires it on every commit, and a
 * requirement amended once per commit is a requirement nobody wrote. `labeled`, `assigned` and
 * `edited` are absent for the reason `issues`/`labeled` is: an ordinary day must not rewrite a
 * project's requirement.
 */
export const GITHUB_PR_ACTIONS = ['opened', 'reopened', 'ready_for_review', 'closed'] as const

/**
 * Exactly the fields the classifier and the normaliser READ, and nothing else (M54 R8).
 *
 * **Deliberately NOT `.strict()`, and this is the one house rule this milestone inverts.** The two
 * routes that carry `.strict()` bodies
 * (`apps/web/src/app/api/w/[workspaceId]/staffing/[capability]/route.ts:26-28` and the permissions
 * route beside it) close a shape THIS project defines, where an unknown key means a caller is
 * talking to something that is not there. A GitHub delivery carries a hundred fields by design and
 * every one of them is a field we did not declare, so `.strict()` would refuse every real delivery.
 * The shape still closes one layer in, at the label validators below: a DECLARED field of the wrong
 * type is refused here, and `repository`/`ref`/`url` are each held to a regex or dropped.
 */
export const githubDeliverySchema = z.object({
  action: z.string().optional(),
  repository: z.object({ full_name: z.string().optional() }).passthrough().optional(),
  issue: z
    .object({
      number: z.number().optional(),
      title: z.string().optional(),
      body: z.string().nullish(),
      html_url: z.string().optional(),
    })
    .passthrough()
    .optional(),
  pull_request: z
    .object({
      number: z.number().optional(),
      title: z.string().optional(),
      body: z.string().nullish(),
      html_url: z.string().optional(),
    })
    .passthrough()
    .optional(),
  workflow_run: z
    .object({
      name: z.string().optional(),
      conclusion: z.string().nullish(),
      head_sha: z.string().optional(),
      head_branch: z.string().nullish(),
      html_url: z.string().optional(),
    })
    .passthrough()
    .optional(),
  deployment: z.object({ sha: z.string().optional(), environment: z.string().nullish() }).passthrough().optional(),
  deployment_status: z
    .object({
      state: z.string().optional(),
      description: z.string().nullish(),
      environment: z.string().nullish(),
      target_url: z.string().nullish(),
    })
    .passthrough()
    .optional(),
})

export type GitHubDelivery = z.infer<typeof githubDeliverySchema>

/**
 * Which of the four ACTIONABLE kinds this delivery is, or `null` (M54 R7).
 *
 * A table over two headers and one payload field, and NEVER `custom`: GitHub sends a `ping` on every
 * hook it creates, and `issues`/`labeled` and a GREEN `workflow_run` on every ordinary day. If
 * `custom` were what this produced for those, a webhook's installation handshake would rewrite a
 * project's requirement. A delivery this system does not recognise must not be able to change a
 * goal, so `null` is the answer and `ingestExternalEvent` records it as `ignored`.
 */
export function classifyGitHubDelivery(eventName: string, payload: GitHubDelivery): ExternalEventKind | null {
  if (eventName === 'issues' && payload.action === 'opened') return 'issue_opened'
  if (eventName === 'pull_request' && (GITHUB_PR_ACTIONS as readonly string[]).includes(payload.action ?? '')) {
    return 'pr_event'
  }
  if (eventName === 'workflow_run' && payload.workflow_run?.conclusion === 'failure') return 'ci_failure'
  const state = payload.deployment_status?.state
  if (eventName === 'deployment_status' && (state === 'failure' || state === 'error')) return 'deployment_failure'
  return null
}

/** What `InboundEvent.payload` holds -- the NORMALISED delivery and never the raw body (M54 R4).
 *  Every string has been through the sanitiser and its cap, so the column is bounded by
 *  construction. */
export interface InboundPayload {
  readonly eventName: string
  readonly action: string | null
  readonly repository: string
  readonly ref: string | null
  readonly url: string | null
  readonly title: string
  readonly body: string
  /** True when the stored text is not byte-for-byte what arrived -- cut at a cap, or neutralised by
   *  a pass. Control sets it a second time, on the same flag and with the same meaning, if the whole
   *  payload ever exceeds `INBOUND_PAYLOAD_MAX_BYTES`. */
  readonly truncated: boolean
}

/** One delivery, normalised. `recognised` is what separates the four actionable kinds from the
 *  `custom` a `null` classification produces -- the kind alone cannot say it, because `custom` is
 *  also a legal composing kind (R7). */
export interface NormalisedDelivery {
  readonly kind: ExternalEventKind
  readonly recognised: boolean
  readonly origin: ExternalOrigin
  readonly payload: InboundPayload
}

/**
 * Why a verified delivery could not be normalised (plan erratum E8). Three closed reasons, so a unit
 * test can say which; control collapses all three into R10's one `payload_invalid` log word and
 * R11's one `400`, because a stranger is owed no more than that.
 */
export type ExternalPayloadProblem = 'shape' | 'repository' | 'ref'

/** A url a person could be handed, or `null` (R8). Dropped rather than refused: half a link is worse
 *  than no link, and a delivery whose issue url is malformed is still a real issue. */
function safeUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length >= EXTERNAL_URL_MAX_CHARS) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

/** A seven-character short sha, or `null` for anything that is not a sha at all. The SHORT form is
 *  what a person reads beside a repository; `EXTERNAL_REF_RE` still accepts 7-40 so a hand-fed
 *  delivery carrying a full one is legal. */
function shortSha(value: string | undefined): string | null {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/u.test(value) ? value.slice(0, 7) : null
}

/**
 * One provider's delivery, turned into the row `InboundEvent` holds, the origin three places carry,
 * and the kind the composer switches on (M54 R8).
 *
 * The order is the rule set:
 *
 *  1. the SHAPE -- `githubDeliverySchema`, loose about keys and strict about the types of the ones it
 *     declares. A failure is `shape`.
 *  2. the REPOSITORY -- required, and held to `REPOSITORY_FULL_NAME_RE`. A failure is `repository`,
 *     and it is a refusal rather than a drop because R6's whole workspace resolution is keyed on it:
 *     a delivery without one is about no project this installation could map. An ORGANISATION-level
 *     `ping` is exactly this case.
 *  3. the KIND -- `classifyGitHubDelivery`, with `null` becoming `custom` and `recognised: false`.
 *  4. the REF -- read per kind, then held to `EXTERNAL_REF_RE` when there is one. A PRESENT ref that
 *     fails is `ref`; an ABSENT ref is `null`, which every unrecognised delivery carries.
 *  5. the URL -- dropped to `null` when it is not an `http(s)` url under the cap (R8 says so).
 *  6. the TEXT -- title and body through `sanitiseExternalText` at their own caps, with `truncated`
 *     saying whether the stored text is what arrived.
 */
export function normaliseGitHubDelivery(
  eventName: string,
  raw: unknown,
): Result<NormalisedDelivery, ExternalPayloadProblem> {
  const parsed = githubDeliverySchema.safeParse(raw)
  if (!parsed.success) return err('shape')
  const payload = parsed.data

  const repository = payload.repository?.full_name
  if (typeof repository !== 'string' || !REPOSITORY_FULL_NAME_RE.test(repository)) return err('repository')

  const kind = classifyGitHubDelivery(eventName, payload)
  const recognised = kind !== null

  // Per kind: what is the ref, what is the url, what is the one-line title, what is the prose.
  // `custom` reads none of them -- an unrecognised delivery's own event NAME is the only honest
  // one-line description of it, and its body is nothing rather than a guess at which of a hundred
  // fields was the interesting one.
  let ref: string | null = null
  let url: string | null = null
  let title = eventName
  let body = ''
  if (kind === 'issue_opened') {
    ref = typeof payload.issue?.number === 'number' ? `#${String(payload.issue.number)}` : null
    url = safeUrl(payload.issue?.html_url)
    title = payload.issue?.title ?? eventName
    body = payload.issue?.body ?? ''
  } else if (kind === 'pr_event') {
    ref = typeof payload.pull_request?.number === 'number' ? `#${String(payload.pull_request.number)}` : null
    url = safeUrl(payload.pull_request?.html_url)
    title = payload.pull_request?.title ?? eventName
    body = payload.pull_request?.body ?? ''
  } else if (kind === 'ci_failure') {
    // The raw value falls through when it is not a sha, so a malformed one REFUSES below rather than
    // being silently dropped: a CI failure with no ref is a fact about nothing a person can look at.
    ref =
      payload.workflow_run?.head_sha === undefined
        ? null
        : (shortSha(payload.workflow_run.head_sha) ?? payload.workflow_run.head_sha)
    url = safeUrl(payload.workflow_run?.html_url)
    title = payload.workflow_run?.name ?? eventName
    body = payload.workflow_run?.head_branch ?? ''
  } else if (kind === 'deployment_failure') {
    ref =
      payload.deployment?.sha === undefined ? null : (shortSha(payload.deployment.sha) ?? payload.deployment.sha)
    url = safeUrl(payload.deployment_status?.target_url)
    title = payload.deployment_status?.environment ?? payload.deployment?.environment ?? eventName
    body = payload.deployment_status?.description ?? ''
  }
  if (ref !== null && !EXTERNAL_REF_RE.test(ref)) return err('ref')

  const safeTitle = sanitiseExternalText(title, EXTERNAL_TITLE_MAX_CHARS)
  const safeBody = sanitiseExternalText(body, EXTERNAL_TEXT_MAX_CHARS)

  return ok({
    kind: kind ?? 'custom',
    recognised,
    origin: { source: 'github', repository, ref, url },
    payload: {
      eventName,
      action: payload.action ?? null,
      repository,
      ref,
      url,
      title: safeTitle,
      body: safeBody,
      truncated: safeTitle !== title || safeBody !== body,
    },
  })
}
