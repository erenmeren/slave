#!/usr/bin/env node
// A CATALOG GENERATOR, for `scripts/gate-m55-catalog.mjs` (M55 section 3).
//
// The SEVENTH fake in this directory and the first that is a WRITER rather than a stand-in for a
// binary. `fake-claude.sh` and `fake-cursor-agent.sh` pretend to be a slave, `fake-deploy.sh`
// pretends to be the thing a slave may not touch, `fake-worker-server.sh` pretends to be a stray
// daemon, `fake-verify.sh` pretends to be a project's own verify command, `fake-github.mjs` pretends
// to be GitHub -- and this pretends to be a real persona catalog on an operator's disk.
//
//   node scripts/gate-fakes/gen-catalog.mjs <output-dir> <seed> [--no-license]
//
// DETERMINISTIC. The same seed writes the same bytes, every time, on every machine: one xorshift32
// seeded from argv, no `Date`, no `Math.random`, no filesystem order anywhere.
//
// VOCABULARY-CLEAN (`gate:m26-vocabulary`). Every word it can emit is in the lists below, and the
// word for a slave is `slave`. The output directory is a `mkdtemp` the GATE chose, so no product
// string, comment or default anywhere names a real catalog (M42 erratum E5).
//
// THE CAPABILITY BULLETS ARE TAXONOMY LABELS, not invented words (M55 plan erratum E11). Three of
// the twelve stages are statements about `SlaveTemplate.capabilityKeys`, which `importCatalog` fills
// by matching a WHOLE normalised bullet against `CAPABILITY_SEED`'s keys, labels and synonyms -- so a
// bullet composed of invented words resolves to nothing and every one of those stages would be
// measuring an empty list.
//
// THE NAME CARRIES THE SEED (Task 6 ruling R1). `SlaveTemplate.name` is `@unique`, and the gate
// generates THREE catalogs -- the licensed one, one with its LICENSE removed, and one imported with
// `--activate`. Two catalogs whose personas are named the same way would meet as a hundred and
// twenty `name_taken` skips and the second and third catalogs would import nothing at all. One seed
// is one set of names.
//
// EVERY PLANTED PAIR IS A PAIR NOBODY ELSE CAN JOIN (Task 6 ruling R2). `ORDINARY_PAIRS` below
// removes the eleven two-label sets the planted personas hold: an ordinary persona holding exactly
// one of them would have a capability Jaccard of 1.0 with a planted persona, and stage 5's "exactly
// nine" would be measuring ten.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPABILITY_SEED } from '../../packages/db/dist/capabilities.js'

const [outDir, seedText, ...switches] = process.argv.slice(2)
if (outDir === undefined || seedText === undefined || !/^\d+$/.test(seedText)) {
  // Exit 3, never 1: a 1 is an outcome the gate asserts on. 3 says the FAKE is misconfigured --
  // `fake-deploy.sh`'s own rule.
  process.stderr.write('gen-catalog.mjs: usage: gen-catalog.mjs <output-dir> <seed> [--no-license]\n')
  process.exit(3)
}
const withLicense = !switches.includes('--no-license')

/** xorshift32. Two lines, no dependency, and the same sequence in every runtime. */
let state = Number(seedText) >>> 0 || 1
const next = () => {
  state ^= state << 13
  state >>>= 0
  state ^= state >>> 17
  state ^= state << 5
  state >>>= 0
  return state
}
const pick = (list) => list[next() % list.length]

const N = 120
const DIVISIONS = ['engineering', 'testing', 'operations', 'security']
const ADJECTIVES = ['Careful', 'Patient', 'Steady', 'Precise', 'Quiet', 'Thorough', 'Direct', 'Curious', 'Frank', 'Tidy']
const NOUNS = ['Auditor', 'Builder', 'Steward', 'Analyst', 'Planner', 'Reviewer', 'Tester', 'Operator', 'Scribe', 'Guide']
const WORDS = [
  'boundary', 'change', 'record', 'measure', 'plan', 'rollback', 'evidence', 'branch', 'commit', 'queue',
  'report', 'signal', 'threshold', 'budget', 'window', 'sample', 'baseline', 'contract', 'fixture', 'ledger',
  'handoff', 'checklist', 'runbook', 'timeline', 'estimate', 'draft', 'review', 'release', 'rollout', 'probe',
]

/** Every persona this generator writes is named `M55 Gate <Adjective> <Noun> <seed> <index>`, and
 *  the gate removes what it made by this prefix as well as by `sourceId`. The prefix is this
 *  milestone's own so a teardown can never reach `gate:m42`'s `Gate Core Builder` or `gate:m46`'s. */
const NAME_PREFIX = 'M55 Gate'
const nameOf = (index) =>
  `${NAME_PREFIX} ${ADJECTIVES[index % ADJECTIVES.length]} ${NOUNS[Math.floor(index / 10) % NOUNS.length]} ` +
  `${seedText} ${String(index).padStart(3, '0')}`

/**
 * How many words the near pairs and the body near-miss APPEND to the first half's body.
 *
 * Task 6 ruling R3: the plan's own arithmetic (56 shingles shared of 59, and 56 of 80) was computed
 * over the sixty-word BODY, and `bodyBandsOf` does not shingle the body -- it shingles
 * `canonicalPersonaText`, which is every profile field but `runtimeRole`, one per line, with `body`
 * last. One of these personas is 182 canonical words and 149 shingles, not 64, so appending three
 * words to it would give 149/152 = 0.98 and appending twenty-four would give 0.86 -- and the
 * near-MISS would have been a `near` pair, which is the one thing stage 6 cannot survive.
 *
 * MEASURED, not reasoned about, at seed 20260914 -- the seed the gate's own catalog is written from
 * and the only one any stage asserts against. A near pair shares its capabilities, so the two texts
 * differ only by the tail: 149/(149+16) = 0.903, the spec's "about 90%". The body near-miss must
 * NOT share its capabilities (two rows holding the same two labels are an `overlapping` pair, which
 * is a signal and not a miss), and those two differing bullets are worth six shingles -- nowhere
 * near enough on their own: with no tail at all that pair reads 0.907, and even with the near
 * pairs' own sixteen-word tail it still reads 0.813, which is a `near` row and a stage 6 that
 * cannot pass. Twenty-six puts it at 0.701, the spec's "a body pair at ~0.7". The gate recomputes
 * both numbers from the two stored specs and prints them, so this comment is checked rather than
 * believed.
 *
 * The construction is still the plan's (D75): APPEND rather than replace, so the ratio depends on
 * one number and not on where a replacement landed.
 */
const NEAR_APPENDED = 16
const MISS_APPENDED = 26

/** The words appended to a near pair's second half and to the near-miss's -- drawn from the same
 *  marker construction, so the added windows are this persona's own and cannot collide with a
 *  third row's. */
const TAIL_MARKER = 'tail'

const LABELS = CAPABILITY_SEED.map((record) => record.label)
const KEYS = CAPABILITY_SEED.map((record) => record.key)
// Twenty-three labels are RESERVED and never given to an ordinary persona: eighteen for the three
// planted `overlapping` pairs (six each, so two personas from different pairs share none), four
// that nothing uses at all, and one for the solo specialist stages 3 and 4 drive the Supervisor at.
const OVER_POOL = LABELS.slice(0, 18)
const SOLO_LABEL = LABELS[18]
const SOLO_KEY = KEYS[18]
const ORDINARY = LABELS.slice(19)

/**
 * The eleven two-label sets the planted personas hold, as indices into `ORDINARY`.
 *
 * Each is removed from the ordinary enumeration below. Two personas holding the SAME two labels
 * have a capability Jaccard of 1.0, which is over `CAPABILITY_OVERLAP_JACCARD` -- so an ordinary
 * persona that happened to draw `{ORDINARY[2], ORDINARY[3]}` would be an `overlapping` pair with
 * BOTH halves of the second exact pair, and stage 5 would count eleven rows where it planted nine.
 */
const PLANTED_LABEL_PAIRS = [
  [0, 1], // exact pair 1, both halves
  [2, 3], // exact pair 2, both halves
  [4, 5], // exact pair 3 (name), first half
  [6, 7], // exact pair 3 (name), second half
  [8, 9], // near pair 1, both halves
  [10, 11], // near pair 2, both halves
  [12, 13], // near pair 3, both halves
  [14, 15], // body near-miss, first half
  [16, 17], // body near-miss, second half
  [18, 19], // name near-miss, first half
  [20, 21], // name near-miss, second half
]
const plantedKeys = new Set(PLANTED_LABEL_PAIRS.map(([left, right]) => `${String(left)}:${String(right)}`))

/** Every unordered pair of ordinary labels that no planted persona holds, in a fixed order. Persona
 *  `i` takes the `i`-th, so no two ordinary personas share more than ONE label: their capability
 *  Jaccard is at most 1/3, which is under `CAPABILITY_OVERLAP_JACCARD` and therefore can never be an
 *  accidental signal. */
const ORDINARY_PAIRS = []
for (let left = 0; left < ORDINARY.length; left += 1) {
  for (let right = left + 1; right < ORDINARY.length; right += 1) {
    if (plantedKeys.has(`${String(left)}:${String(right)}`)) continue
    ORDINARY_PAIRS.push([ORDINARY[left], ORDINARY[right]])
  }
}

/** A body nobody else can share a five-word window with: every fourth token is this persona's own
 *  marker, so every window of five contains one. That is what makes an ACCIDENTAL `near` or `exact`
 *  pair impossible and every planted one deliberate. */
function bodyWords(marker, count) {
  const out = []
  for (let index = 0; index < count; index += 1) out.push(index % 4 === 3 ? marker : pick(WORDS))
  return out
}

/**
 * The three words two ordinary personas carry that nothing else does, so the gate has something to
 * search for that is NOT a name.
 *
 * `catalogSearchText` folds `name`, `description` and the spec's `identity`, `summary`,
 * `capabilities`, `expertise` and `recommendedSkills` -- and NOT `body`. A gate that searched for a
 * word out of a persona's Notes would be asserting that the search box does not work; a gate that
 * searched for part of a NAME would be asserting only what the migration's own name-and-description
 * floor already covers. These two are in a SUMMARY and in an IDENTITY, which is the half of
 * `searchText` that only a real derivation can reach.
 */
const SUMMARY_MARKER = 'keystone'
const IDENTITY_MARKER = 'lodestar'
const SUMMARY_MARKER_INDEX = 30
const IDENTITY_MARKER_INDEX = 31
/** One `skills:` front-matter key, on one ordinary persona, so the skill facet has exactly one row
 *  to narrow to. `personaToProfileSpec` lifts the key verbatim into `recommendedSkills`, which M55
 *  R3 denormalises into the column the skill filter reads. */
const SKILL = 'writing-plans'
const SKILL_INDEX = 32

function persona({ name, description, identity, mission, capabilities, body, skills = null }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(skills === null ? [] : [`skills: ${skills}`]),
    '---',
    '',
    `# ${name}`,
    '',
    `${description}`,
    '',
    '## Identity & Role Definition',
    '',
    identity,
    '',
    '## Core Capabilities',
    '',
    ...capabilities.map((label) => `* ${label}`),
    '',
    '## Core Mission',
    '',
    mission,
    '',
    '## Critical Rules',
    '',
    '- You MUST leave the branch green',
    '',
    '## Technical Deliverables',
    '',
    '- A note saying what changed',
    '',
    '## Domain Expertise',
    '',
    '- Reading a measure back to the change that moved it',
    '',
    '## Workflow Process',
    '',
    '- Step 1: read the brief back in your own words',
    '- Step 2: make the smallest change that answers it',
    '',
    '## Success Metrics',
    '',
    '- Nothing left red',
    '',
    '## Working With Others',
    '',
    '- Consult the reviewer before a release',
    '',
    '## Notes',
    '',
    body,
    '',
  ].join('\n')
}

// ---- The 120 personas ---------------------------------------------------------------------------
// Indices 0-8 are the nine PLANTED pairs' first halves and 9-17 their seconds; 18-23 are the three
// near-misses; 24-118 are ordinary; 119 is the solo specialist. Every index below is written out
// rather than computed, because a gate that asserts "exactly nine pairs" must be readable against
// the thing that planted them.
const files = []
const add = (index, division, slug, text) => files.push({ division, slug, text, index, name: nameOf(index) })

// EXACT pair 1: byte-identical persona text under a different slug AND a different division. Two
// names differ (a name is unique, the `# H1` is dropped by `splitSections` and the name is not a
// `PROFILE_SPEC_FIELDS` member), everything the canonical text reads is the same, so
// `contentSha256` is equal.
{
  const shared = {
    description: 'Keeps the record of what changed and why.',
    identity: 'The one who writes down what happened, in the order it happened.',
    mission: 'Leave a trail anybody can follow a week later.',
    capabilities: [ORDINARY[0], ORDINARY[1]],
    body: bodyWords('exactone', 60).join(' '),
  }
  add(0, 'engineering', 'exact-one-a', persona({ name: nameOf(0), ...shared }))
  add(9, 'testing', 'exact-one-b', persona({ name: nameOf(9), ...shared }))
}

// EXACT pair 2: identical only after NFC, case and whitespace normalisation. The second copy shouts,
// double-spaces, and is written to disk decomposed -- the accented word in the shared identity is
// the one character in this catalog for which NFC and NFD are different bytes, and it is there so
// the first of `normalisePersona`'s three passes is exercised by something rather than by nothing.
{
  const base = {
    description: 'Measures a change before it goes out.',
    identity: 'The one who takes the naïve baseline first.',
    mission: 'Know the number before and after.',
    capabilities: [ORDINARY[2], ORDINARY[3]],
    body: bodyWords('exacttwo', 60).join(' '),
  }
  const loud = {
    description: base.description.toUpperCase(),
    identity: base.identity.replace(/ /g, '  '),
    mission: base.mission.toUpperCase(),
    capabilities: base.capabilities,
    body: base.body.toUpperCase(),
  }
  add(1, 'engineering', 'exact-two-a', persona({ name: nameOf(1), ...base }))
  add(10, 'operations', 'exact-two-b', persona({ name: nameOf(10), ...loud }).normalize('NFD'))
}

// EXACT pair 3, basis `name`: two names equal after normalisation and NOTHING else alike. This is
// the arm `SlaveTemplate.name @unique` makes possible at all -- two byte-equal names cannot both
// exist, and `M55 Gate Steady Auditor 20260914 002` against `m55  gate  steady  auditor  20260914  002`
// can.
{
  const name = nameOf(2)
  add(2, 'engineering', 'name-one-a', persona({
    name,
    description: 'Walks a change through the last mile.',
    identity: 'The one who owns the rollout.',
    mission: 'One change at a time, with a way back.',
    capabilities: [ORDINARY[4], ORDINARY[5]],
    body: bodyWords('nameonea', 60).join(' '),
  }))
  add(11, 'security', 'name-one-b', persona({
    name: name.toLowerCase().replace(/ /g, '  '),
    description: 'Reads a change back and says whether it does what it claims.',
    identity: 'The one who trusts nothing that has not run.',
    mission: 'Run it, then say so.',
    capabilities: [ORDINARY[6], ORDINARY[7]],
    body: bodyWords('nameoneb', 60).join(' '),
  }))
}

// NEAR pairs 1-3: the second body is the first plus NEAR_APPENDED words, so every shingle of the
// first is a shingle of the second and the union is that many larger -- comfortably over
// NEAR_DUPLICATE_JACCARD and comfortably under 1 (which would make it an `exact` by hash instead).
for (const [offset, [index, marker]] of [[3, 'nearone'], [4, 'neartwo'], [5, 'nearthree']].entries()) {
  const partner = index + 9
  const words = bodyWords(marker, 60)
  const shared = {
    description: `Takes the ${marker} work one step at a time.`,
    identity: 'The one who keeps the plan small.',
    mission: 'Do the next thing, and say what it cost.',
    capabilities: [ORDINARY[8 + offset * 2], ORDINARY[9 + offset * 2]],
  }
  add(index, 'engineering', `${marker}-a`, persona({ name: nameOf(index), ...shared, body: words.join(' ') }))
  add(partner, 'testing', `${marker}-b`, persona({
    name: nameOf(partner),
    ...shared,
    body: [...words, ...bodyWords(`${marker}${TAIL_MARKER}`, NEAR_APPENDED)].join(' '),
  }))
}

// OVERLAPPING pairs 1-3: different names, unrelated prose, and five capabilities of which four are
// shared -- a Jaccard of 4/6 = 0.667, over CAPABILITY_OVERLAP_JACCARD. Each pair draws from its own
// six RESERVED labels, so two personas from different pairs share none.
for (const [offset, [index, marker]] of [[6, 'overone'], [7, 'overtwo'], [8, 'overthree']].entries()) {
  const partner = index + 9
  const pool = OVER_POOL.slice(offset * 6, offset * 6 + 6)
  add(index, 'operations', `${marker}-a`, persona({
    name: nameOf(index),
    description: `Runs the ${marker} side of the work.`,
    identity: 'The one who keeps the pipeline moving.',
    mission: 'Keep it running and say when it is not.',
    capabilities: [pool[0], pool[1], pool[2], pool[3], pool[4]],
    body: bodyWords(`${marker}a`, 60).join(' '),
  }))
  add(partner, 'security', `${marker}-b`, persona({
    name: nameOf(partner),
    description: `Reviews the ${marker} side of the work.`,
    identity: 'The one who reads it back before it ships.',
    mission: 'Find what the plan did not.',
    capabilities: [pool[0], pool[1], pool[2], pool[3], pool[5]],
    body: bodyWords(`${marker}b`, 60).join(' '),
  }))
}

// NEAR-MISS 1: a body pair under the threshold, by the same construction as a near pair with a
// bigger tail. Its two halves hold DIFFERENT capabilities -- two rows holding the same two labels
// are an `overlapping` pair, which is a signal and not a miss -- and that difference is worth six
// shingles, which is why the tail and not the bullets is what puts this pair under 0.8.
{
  const words = bodyWords('missbody', 60)
  const shared = {
    description: 'Keeps a list of what is left.',
    identity: 'The one who tracks the remainder.',
    mission: 'Know what has not been done.',
  }
  add(18, 'engineering', 'miss-body-a', persona({
    name: nameOf(18),
    ...shared,
    capabilities: [ORDINARY[14], ORDINARY[15]],
    body: words.join(' '),
  }))
  add(19, 'testing', 'miss-body-b', persona({
    name: nameOf(19),
    ...shared,
    capabilities: [ORDINARY[16], ORDINARY[17]],
    body: [...words, ...bodyWords(`missbody${TAIL_MARKER}`, MISS_APPENDED)].join(' '),
  }))
}

// NEAR-MISS 2: a capability pair sharing two of five -- a Jaccard of 2/8 = 0.25, under the
// threshold. The two shared labels come from the FIRST overlapping pair's pool, so this near-miss
// also stands beside a real signal drawn from the same labels; the three unshared ones on each side
// come from the second and third pools, which keeps it under 0.6 against every one of the six
// overlapping personas too (the worst of those is 4 of 8, and the gate prints it).
{
  add(20, 'operations', 'miss-caps-a', persona({
    name: nameOf(20),
    description: 'Watches the queue.',
    identity: 'The one who sees it back up first.',
    mission: 'Keep the queue short.',
    capabilities: [OVER_POOL[0], OVER_POOL[1], OVER_POOL[6], OVER_POOL[7], OVER_POOL[8]],
    body: bodyWords('misscapsa', 60).join(' '),
  }))
  add(21, 'security', 'miss-caps-b', persona({
    name: nameOf(21),
    description: 'Watches the door.',
    identity: 'The one who reads the log first.',
    mission: 'Know who came in.',
    capabilities: [OVER_POOL[0], OVER_POOL[1], OVER_POOL[12], OVER_POOL[13], OVER_POOL[14]],
    body: bodyWords('misscapsb', 60).join(' '),
  }))
}

// NEAR-MISS 3: two names differing by ONE word -- normalised, they are not equal, so no arm fires.
{
  add(22, 'engineering', 'miss-name-a', persona({
    name: `${NAME_PREFIX} Thorough Scribe ${seedText} Prime`,
    description: 'Writes the note nobody else writes.',
    identity: 'The one who keeps the minutes.',
    mission: 'Say what was decided.',
    capabilities: [ORDINARY[18], ORDINARY[19]],
    body: bodyWords('missnamea', 60).join(' '),
  }))
  add(23, 'testing', 'miss-name-b', persona({
    name: `${NAME_PREFIX} Thorough Scribe ${seedText}`,
    description: 'Reads the note back.',
    identity: 'The one who checks the minutes.',
    mission: 'Say what was missed.',
    capabilities: [ORDINARY[20], ORDINARY[21]],
    body: bodyWords('missnameb', 60).join(' '),
  }))
}
// The two miss-name personas are the only two whose names `nameOf` did not write, so they are the
// only two the gate cannot look up by index.
files[files.length - 2].name = `${NAME_PREFIX} Thorough Scribe ${seedText} Prime`
files[files.length - 1].name = `${NAME_PREFIX} Thorough Scribe ${seedText}`

// The ordinary 95, and the solo specialist at 119.
for (let index = 24; index < N; index += 1) {
  const division = DIVISIONS[index % DIVISIONS.length]
  const capabilities = index === N - 1 ? [SOLO_LABEL, ORDINARY[0]] : ORDINARY_PAIRS[index % ORDINARY_PAIRS.length]
  const description =
    index === SUMMARY_MARKER_INDEX
      ? `Holds the ${SUMMARY_MARKER} of the release and says what it cost.`
      : `Does the ${pick(WORDS)} work and says what it cost.`
  const identity =
    index === IDENTITY_MARKER_INDEX
      ? `The one who is the ${IDENTITY_MARKER} for the ${pick(WORDS)}.`
      : `The one who handles the ${pick(WORDS)}.`
  add(index, division, `persona-${String(index).padStart(3, '0')}`, persona({
    name: nameOf(index),
    description,
    identity,
    mission: `Keep the ${pick(WORDS)} honest.`,
    capabilities,
    body: bodyWords(`p${String(index)}`, 60).join(' '),
    ...(index === SKILL_INDEX ? { skills: SKILL } : {}),
  }))
}

// ---- Write ---------------------------------------------------------------------------------------
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
for (const division of DIVISIONS) mkdirSync(join(outDir, division), { recursive: true })
writeFileSync(
  join(outDir, 'divisions.json'),
  `${JSON.stringify({ divisions: Object.fromEntries(DIVISIONS.map((d) => [d, { label: d }])) }, null, 2)}\n`,
)
if (withLicense) {
  writeFileSync(
    join(outDir, 'LICENSE'),
    'MIT License\n\nCopyright (c) 2026 The gate own generated catalog\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n',
  )
}
for (const file of files) writeFileSync(join(outDir, file.division, `${file.slug}.md`), file.text)

// The MANIFEST the gate asserts against, on stdout as JSON: which slugs are which planted pair, and
// which capability the solo specialist alone provides. The gate parses this rather than re-deriving
// it, so the two cannot drift.
const bySlug = Object.fromEntries(files.map((file) => [file.slug, { division: file.division, name: file.name, index: file.index }]))
process.stdout.write(
  `${JSON.stringify({
    count: files.length,
    seed: seedText,
    namePrefix: NAME_PREFIX,
    divisions: DIVISIONS,
    licensed: withLicense,
    soloSlug: `persona-${String(N - 1).padStart(3, '0')}`,
    soloCapabilityLabel: SOLO_LABEL,
    soloCapabilityKey: SOLO_KEY,
    summaryMarker: SUMMARY_MARKER,
    summarySlug: `persona-${String(SUMMARY_MARKER_INDEX).padStart(3, '0')}`,
    identityMarker: IDENTITY_MARKER,
    identitySlug: `persona-${String(IDENTITY_MARKER_INDEX).padStart(3, '0')}`,
    skill: SKILL,
    skillSlug: `persona-${String(SKILL_INDEX).padStart(3, '0')}`,
    nearAppended: NEAR_APPENDED,
    missAppended: MISS_APPENDED,
    exact: [['exact-one-a', 'exact-one-b'], ['exact-two-a', 'exact-two-b'], ['name-one-a', 'name-one-b']],
    near: [['nearone-a', 'nearone-b'], ['neartwo-a', 'neartwo-b'], ['nearthree-a', 'nearthree-b']],
    overlapping: [['overone-a', 'overone-b'], ['overtwo-a', 'overtwo-b'], ['overthree-a', 'overthree-b']],
    misses: [['miss-body-a', 'miss-body-b'], ['miss-caps-a', 'miss-caps-b'], ['miss-name-a', 'miss-name-b']],
    bySlug,
  })}\n`,
)
process.exit(0)
