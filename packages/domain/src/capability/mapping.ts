import { z } from 'zod'
import { goalSha256 } from '../goal/version.js'
import { SUPERVISOR_PER_CALL_CAP_USD } from '../supervisor/constants.js'
import { firstJsonObject } from '../supervisor/prompt.js'
import { normaliseCapabilityText, type CapabilityKey, type CapabilityRecord } from './taxonomy.js'

/**
 * Catalogue capability mapping (2026-09-20), R5 and §3: the prompt a model is given to map a
 * persona's free-text capability sentences onto the taxonomy, and the parser for its answer.
 *
 * PURE. Nothing here reads a database or spawns a process; the control verb that calls the model
 * (`packages/control/src/capabilityMapping.ts`) passes the taxonomy and the personas in, so the
 * whole contract is testable with fixture strings. The exact matcher (`normaliseCapabilities`) is
 * untouched (R2): this is a SECOND source of keys, kept apart by the control layer.
 */

/** How many personas one call is shown. Five keeps a call well under the per-call cap on the
 *  default model with the full taxonomy in the prompt (§3). */
export const CAPABILITY_MAP_BATCH_SIZE = 5
/** The most keys the parser keeps per persona. A persona that "does everything" is a persona the
 *  staffing rank cannot tell apart from anybody; eight is the point past which a list stops
 *  describing a specialist. The prompt says "most central first" so the cut keeps the right ones. */
export const CAPABILITY_MAP_MAX_KEYS = 8
/** How many sentences of one persona are shown -- the live catalogue's own maximum (R4/§3). */
export const CAPABILITY_MAP_SENTENCE_CAP = 40
/** The same cap the intake and the Supervisor use, and for the same reason (R6). */
export const CAPABILITY_MAP_PER_CALL_CAP_USD = SUPERVISOR_PER_CALL_CAP_USD
/** The envelope's key, quoted -- the prompt asks for it and the fake CLI keys on it. */
export const CAPABILITY_MAP_ANSWER_MARKER = '"personas"'

export interface CapabilityMappingPersona {
  readonly id: string
  readonly name: string
  readonly runtimeRole: string
  readonly summary: string
  readonly identity: string
  readonly capabilities: readonly string[]
}

export interface CapabilityMappingResult {
  readonly id: string
  /** Taxonomy keys only, deduplicated, at most {@link CAPABILITY_MAP_MAX_KEYS}, in the answer's order. */
  readonly keys: readonly CapabilityKey[]
  /** Strings the answer offered that are not keys of this taxonomy, for the report. */
  readonly dropped: readonly string[]
}

/** The sentences the model is shown: trimmed, blanks dropped, capped (R4/§3). */
export function mappableSentences(capabilities: readonly string[]): readonly string[] {
  const kept: string[] = []
  for (const value of capabilities) {
    if (normaliseCapabilityText(value) === '') continue
    kept.push(value.trim())
    if (kept.length === CAPABILITY_MAP_SENTENCE_CAP) break
  }
  return kept
}

/**
 * R4: what decides "stale". The sentences (as shown), the summary, the identity and the
 * taxonomy's KEYS, key ascending. Labels and synonyms are deliberately absent -- the model maps
 * meaning against keys and their labels, but a relabel is not a reason to spend a call again;
 * a new KEY is, because it exists to be mapped onto.
 */
export function capabilityMappingHash(
  persona: Pick<CapabilityMappingPersona, 'summary' | 'identity' | 'capabilities'>,
  taxonomy: readonly CapabilityRecord[],
): string {
  const keys = taxonomy.map((record) => record.key).toSorted()
  const canonical = JSON.stringify({
    capabilities: mappableSentences(persona.capabilities),
    summary: persona.summary.trim(),
    identity: persona.identity.trim(),
    keys,
  })
  return goalSha256(canonical)
}

export function buildCapabilityMappingPrompt(
  batch: readonly CapabilityMappingPersona[],
  taxonomy: readonly CapabilityRecord[],
): string {
  const blocks: string[] = [
    'You are classifying personas for a company of specialists whose work is matched to tasks by',
    'CAPABILITY KEYS. A key names one thing a specialist can be asked to do. The list of keys is',
    'closed: choose from it and only from it.',
    '',
    'THE KEYS (key — label (domain)):',
    ...taxonomy.map((record) => `- ${record.key} — ${record.label} (${record.domain})`),
    '',
    'THE PERSONAS:',
  ]
  for (const persona of batch) {
    blocks.push(
      '',
      `persona id: ${persona.id}`,
      `name: ${persona.name}`,
      `runtime role given by the catalogue: ${persona.runtimeRole}`,
      `summary: ${persona.summary.trim()}`,
      `identity: ${persona.identity.trim()}`,
      'capability sentences:',
      ...mappableSentences(persona.capabilities).map((sentence) => `- ${sentence}`),
    )
  }
  blocks.push(
    '',
    'INSTRUCTIONS:',
    `- For each persona choose at most ${String(CAPABILITY_MAP_MAX_KEYS)} keys, the most central first.`,
    '- Choose only keys from THE KEYS above. Never invent a key. Never rename one.',
    '- An empty list is a valid answer when nothing in the list fits.',
    '- Answer with ONE JSON object and nothing else, in exactly this shape:',
    `  {${CAPABILITY_MAP_ANSWER_MARKER}:[{"id":"<persona id>","keys":["<key>", "<key>"]}]}`,
    '- Include every persona id above exactly once.',
  )
  return blocks.join('\n')
}

const envelopeSchema = z.object({
  personas: z.array(z.unknown()),
})
const entrySchema = z.object({
  id: z.string().min(1),
  keys: z.array(z.string()),
})

/**
 * R5: the first JSON object in the text, the envelope, then per persona the keys that ARE keys.
 * A persona the answer does not mention, or mentions malformed, is ABSENT from the result -- not
 * empty -- because "no answer" and "nothing applies" are different facts to the caller: absent is
 * retried on the next pass, empty is recorded.
 */
export function parseCapabilityMappingAnswer(
  text: string,
  batch: readonly CapabilityMappingPersona[],
  taxonomy: readonly CapabilityRecord[],
): readonly CapabilityMappingResult[] | null {
  const source = firstJsonObject(text)
  if (source === null) return null
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return null
  }
  const envelope = envelopeSchema.safeParse(value)
  if (!envelope.success) return null

  const known = new Set<string>(taxonomy.map((record) => record.key))
  const inBatch = new Set(batch.map((persona) => persona.id))
  const results: CapabilityMappingResult[] = []
  const seen = new Set<string>()
  for (const raw of envelope.data.personas) {
    const entry = entrySchema.safeParse(raw)
    if (!entry.success) continue
    if (!inBatch.has(entry.data.id) || seen.has(entry.data.id)) continue
    seen.add(entry.data.id)
    const keys: CapabilityKey[] = []
    const dropped: string[] = []
    for (const candidate of entry.data.keys) {
      const key = candidate.trim()
      if (!known.has(key)) {
        if (key !== '' && !dropped.includes(key)) dropped.push(key)
        continue
      }
      if (keys.includes(key as CapabilityKey)) continue
      if (keys.length < CAPABILITY_MAP_MAX_KEYS) keys.push(key as CapabilityKey)
    }
    results.push({ id: entry.data.id, keys, dropped })
  }
  return results
}
