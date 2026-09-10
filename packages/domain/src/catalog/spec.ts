import {
  PROFILE_SPEC_MAX_ITEMS,
  PROFILE_SPEC_MAX_ITEM_CHARS,
  emptyProfileSpec,
  type MappingQuality,
  type ProfileSpec,
} from '../profile/spec.js'
import type { PersonaDraft } from './persona.js'

/**
 * A persona file's headings, mapped into the specialist profile's fields (M46 R3).
 *
 * PURE and deliberately dumb: a heading table and a handful of line rules, no inference from a
 * persona's NAME and no model anywhere near it. Three quarters of the reference corpus shares one
 * nine-heading skeleton; a large minority uses a shorter, differently-worded one; a few use
 * neither. The table below covers the first two and `mappingQuality` says so honestly when it
 * covers neither -- `none` is a real answer the catalog shows rather than a failure it hides.
 *
 * What it does NOT do: resolve a collaboration hint's named slave to a template row (the wording
 * names a role TITLE, and matching titles across a catalog is M47's capability graph), and infer
 * a recommended skill from anything but an explicit `skills:` front-matter key.
 */

/** Where one recognised `##` section's lines go. */
type Slot =
  | 'identity_memory'
  | 'core_mission'
  | 'critical_rules'
  | 'deliverables'
  | 'workflow'
  | 'success_metrics'
  | 'capabilities'
  | 'expertise'
  | 'collaboration'

/** The nine slots `mappingQuality` counts. A persona that fills seven of them is a persona this
 *  mapper genuinely understood. */
const CANONICAL_SLOTS: readonly Slot[] = [
  'identity_memory',
  'core_mission',
  'critical_rules',
  'deliverables',
  'workflow',
  'success_metrics',
  'capabilities',
  'expertise',
  'collaboration',
]

/**
 * Heading text, normalised, to the slot it fills. Normalisation strips a leading run of anything
 * that is not a letter (every heading in the reference corpus may open with an emoji), strips a
 * leading `Your `, lowercases and collapses whitespace -- so `## 🎯 Your Success Metrics` and
 * `## Success Metrics` are the same heading, which is exactly the difference between the corpus's
 * two most common skeletons.
 */
const SLOT_BY_HEADING: Readonly<Record<string, Slot>> = {
  'identity & memory': 'identity_memory',
  'identity & role definition': 'identity_memory',
  'core mission': 'core_mission',
  mission: 'core_mission',
  'critical rules you must follow': 'critical_rules',
  'critical rules': 'critical_rules',
  'workflow process': 'workflow',
  workflow: 'workflow',
  process: 'workflow',
  'success metrics': 'success_metrics',
  'advanced capabilities': 'capabilities',
  'core capabilities': 'capabilities',
  'core competencies': 'capabilities',
  'specialized skills': 'capabilities',
  'domain expertise': 'expertise',
}

/** Headings recognised by SHAPE rather than by exact text: a division writes `Technical
 *  Deliverables`, the next writes `Architecture Deliverables`, and every catalog invents its own
 *  word for "who else you work with". */
function slotByShape(heading: string): Slot | null {
  if (heading.endsWith(' deliverables') || heading === 'deliverables') return 'deliverables'
  if (heading.startsWith('integration with') || heading.startsWith('working with')) return 'collaboration'
  if (heading.startsWith('collaboration')) return 'collaboration'
  return null
}

/** A sentence that names another worker and what to do about it (R3). Kept VERBATIM: M47
 *  normalises these into advisory relationships, and a hint this milestone reworded would be a
 *  hint M47 could no longer trace back to its persona. */
const HANDOFF = /\b(consult|pair with|hand off|hands off|handoff|escalate to|work with the)\b/i
/** R3's rule words. Case-insensitive: a rule written in ordinary case is still a rule. */
const RULE_WORDS = /\b(must|never|always|do not|don't)\b/i

function normaliseHeading(raw: string): string {
  return raw
    .replace(/^[^\p{L}]+/u, '')
    .replace(/^your\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** One item: bullet marker and bold wrapper stripped, whitespace collapsed, cut to the schema's
 *  length. A hard `slice` rather than an ellipsis, so the same input always renders the same
 *  bytes -- the gate asserts a stored profile is byte-equal to a re-render. */
function item(raw: string): string {
  return raw
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROFILE_SPEC_MAX_ITEM_CHARS)
}

function items(lines: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const value = item(line)
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length === PROFILE_SPEC_MAX_ITEMS) break
  }
  return out
}

function text(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, PROFILE_SPEC_MAX_ITEM_CHARS)
}

/** The first sentence of a paragraph -- `.` `?` `!` followed by a space or the end. */
function firstSentence(paragraph: string): string {
  const flat = paragraph.replace(/\s+/g, ' ').trim()
  const match = /^(.*?[.!?])(\s|$)/.exec(flat)
  return (match?.[1] ?? flat).trim()
}

interface Section {
  readonly heading: string
  readonly slot: Slot | null
  /** `###` sub-heading titles, in order. */
  readonly subHeadings: readonly string[]
  /** Bullet lines (`-`, `*`, `+`, `1.`), in order, marker included. */
  readonly bullets: readonly string[]
  /** `| a | b |` rows, header and separator dropped. */
  readonly tableRows: readonly (readonly string[])[]
  /** Everything that is none of the above. */
  readonly paragraphs: readonly string[]
}

function splitSections(body: string): { readonly lead: string; readonly sections: readonly Section[] } {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const leadLines: string[] = []
  const sections: {
    heading: string
    slot: Slot | null
    subHeadings: string[]
    bullets: string[]
    tableRows: string[][]
    paragraphs: string[]
  }[] = []
  let current: (typeof sections)[number] | null = null

  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line)
    if (h2 !== null) {
      const heading = normaliseHeading(h2[1] ?? '')
      current = {
        heading,
        slot: SLOT_BY_HEADING[heading] ?? slotByShape(heading),
        subHeadings: [],
        bullets: [],
        tableRows: [],
        paragraphs: [],
      }
      sections.push(current)
      continue
    }
    const target = current
    if (target === null) {
      // Everything before the first `##`, the H1 line dropped.
      if (!/^#\s+/.test(line)) leadLines.push(line)
      continue
    }
    const h3 = /^#{3,6}\s+(.*)$/.exec(line)
    if (h3 !== null) {
      target.subHeadings.push(text(h3[1] ?? ''))
      continue
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      target.bullets.push(line)
      continue
    }
    if (/^\s*\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
      // The `|---|---|` separator, and the header row that precedes it, are not data.
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
        target.tableRows.length = 0
        continue
      }
      target.tableRows.push(cells)
      continue
    }
    if (line.trim() !== '') target.paragraphs.push(line.trim())
  }

  return { lead: leadLines.join('\n').trim(), sections }
}

function sectionsFor(sections: readonly Section[], slot: Slot): readonly Section[] {
  return sections.filter((section) => section.slot === slot)
}

/** `- **Role**: something` -> `something`, for the labels R3 names. */
function labelled(bullets: readonly string[], labels: readonly string[]): string[] {
  const out: string[] = []
  for (const bullet of bullets) {
    const match = /^\s*(?:[-*+]|\d+\.)\s+\*{0,2}([A-Za-z][A-Za-z ]*?)\*{0,2}\s*:\s*(.+)$/.exec(bullet)
    if (match === null) continue
    const label = (match[1] ?? '').trim().toLowerCase()
    if (!labels.includes(label)) continue
    out.push((match[2] ?? '').trim())
  }
  return out
}

export interface PersonaSourceFacts {
  readonly repository: string
  readonly path: string
  readonly revision: string | null
  readonly license: string | null
  readonly importedAt: Date
  /** `SlaveTemplate.role` -- the division, or its `--role-map` translation. A SUGGESTION on the
   *  profile; the scheduler still matches `Slave.runtimeRoles` and nothing else. */
  readonly runtimeRole: string
}

export function personaToProfileSpec(draft: PersonaDraft, facts: PersonaSourceFacts): ProfileSpec {
  const { lead, sections } = splitSections(draft.body)
  const filled = new Set<Slot>()
  for (const section of sections) if (section.slot !== null) filled.add(section.slot)

  const identityMemory = sectionsFor(sections, 'identity_memory')
  const identityBullets = identityMemory.flatMap((section) => section.bullets)
  const identityFromLabels = labelled(identityBullets, ['role', 'personality'])
  const identityProse = identityMemory.flatMap((section) => section.paragraphs)
  const identity =
    identityFromLabels.length > 0
      ? text(identityFromLabels.join('; '))
      : identityProse.length > 0
        ? text(identityProse[0] as string)
        : text(firstSentence(lead))

  // The catalog blurb FIRST: it is the one line the persona's author wrote to answer "what is this
  // worker for", and `description` is also what M42 already puts on `SlaveTemplate.description`, so
  // taking it here keeps the card and the profile saying the same sentence. The persona's opening
  // sentence is the fallback, and `vibe` the last resort -- a persona with neither a blurb nor any
  // prose above its first heading still gets a one-liner rather than an empty field.
  const summaryFromLead = lead === '' ? '' : firstSentence(lead)
  const summary = text(draft.description ?? (summaryFromLead !== '' ? summaryFromLead : (draft.meta['vibe'] ?? '')))

  const missionSections = sectionsFor(sections, 'core_mission')
  const missionParagraph = missionSections.flatMap((section) => section.paragraphs)[0] ?? ''
  const mission = text(missionParagraph === '' ? '' : firstSentence(missionParagraph))

  const capabilityLines: string[] = []
  for (const section of missionSections) {
    capabilityLines.push(...(section.subHeadings.length > 0 ? section.subHeadings : section.bullets))
  }
  for (const section of sectionsFor(sections, 'capabilities')) {
    capabilityLines.push(...section.subHeadings, ...section.bullets)
  }

  const expertiseLines = [
    ...labelled(identityBullets, ['experience', 'expertise']),
    ...sectionsFor(sections, 'expertise').flatMap((section) => [...section.subHeadings, ...section.bullets]),
  ]

  const ruleLines = sectionsFor(sections, 'critical_rules').flatMap((section) => [
    ...section.subHeadings,
    ...section.bullets,
  ])
  const constraintLines = ruleLines.filter((line) => RULE_WORDS.test(line))
  const principleLines = ruleLines.filter((line) => !RULE_WORDS.test(line))

  const deliverableLines = sectionsFor(sections, 'deliverables').flatMap((section) =>
    section.subHeadings.length > 0 ? section.subHeadings : section.bullets,
  )

  const workflowSections = sectionsFor(sections, 'workflow')
  const workflowAll = workflowSections.flatMap((section) => [...section.subHeadings, ...section.bullets])
  const workflowSteps = workflowAll.filter((line) => /^\s*(?:[-*+]|\d+\.)?\s*(step|phase)\b/i.test(line))
  const workflowLines = workflowSteps.length > 0 ? workflowSteps : workflowAll

  const successLines = sectionsFor(sections, 'success_metrics').flatMap((section) => [
    ...section.subHeadings,
    ...section.bullets,
  ])

  const collaborationLines: string[] = []
  for (const section of sectionsFor(sections, 'collaboration')) {
    for (const row of section.tableRows) {
      const who = (row[0] ?? '').replace(/\*/g, '').trim()
      const how = (row[1] ?? '').trim()
      if (who !== '' && how !== '') collaborationLines.push(`${who}: ${how}`)
    }
    collaborationLines.push(...section.bullets, ...section.paragraphs)
  }
  // R3's loose phrasing, anywhere in the persona: a hand-off named in a rules or workflow section
  // is a hand-off, and it is the commonest shape in the corpus.
  for (const section of sections) {
    for (const line of [...section.bullets, ...section.paragraphs]) {
      if (HANDOFF.test(line)) collaborationLines.push(line)
    }
  }

  const skills = (draft.meta['skills'] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')

  const matched = CANONICAL_SLOTS.filter((slot) => filled.has(slot)).length
  const mappingQuality: MappingQuality = matched >= 7 ? 'full' : matched >= 3 ? 'partial' : 'none'

  return {
    ...emptyProfileSpec(),
    identity,
    summary,
    mission,
    runtimeRole: text(facts.runtimeRole),
    capabilities: items(capabilityLines),
    expertise: items(expertiseLines),
    operatingPrinciples: items(principleLines),
    constraints: items(constraintLines),
    workflow: items(workflowLines),
    deliverables: items(deliverableLines),
    successCriteria: items(successLines),
    collaborationHints: items(collaborationLines),
    recommendedSkills: items(skills),
    body: draft.body,
    source: {
      repository: facts.repository,
      path: facts.path,
      revision: facts.revision,
      license: facts.license,
      importedAt: facts.importedAt.toISOString(),
      mappingQuality,
    },
  }
}
