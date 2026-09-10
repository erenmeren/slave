import { describe, expect, it } from 'vitest'
import { parsePersona, personaToProfileSpec, type PersonaDraft } from '../../src/index.js'

const FACTS = {
  repository: 'catalog-m46',
  path: 'engineering/gate-canonical.md',
  revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
  license: 'MIT',
  importedAt: new Date('2026-09-11T09:00:00.000Z'),
  runtimeRole: 'engineering',
}

const draftOf = (text: string): PersonaDraft => {
  const parsed = parsePersona({ path: 'x.md', text })
  if (!parsed.ok) throw new Error(`fixture does not parse: ${parsed.error.kind}`)
  return parsed.value
}

// The canonical skeleton: nine "Your ..." headings, emoji in front of each, `###` groups inside
// Core Mission and Critical Rules, worked-example deliverables.
const CANONICAL = `---
name: Gate Core Builder
description: Builds the core module and the tests that hold it up.
color: blue
emoji: brick
vibe: Puts the load-bearing parts in first.
skills: writing-plans, systematic-debugging
---

# Gate Core Builder Personality

You are **Gate Core Builder**, the slave that writes the module everything else stands on. You
write its tests before you write it.

## 🧠 Your Identity & Memory
- **Role**: Load-bearing module and test specialist
- **Personality**: Patient, deletion-minded, allergic to a red test
- **Memory**: You remember which shortcuts cost the most later
- **Experience**: Ten years of code other people had to keep

## 🎯 Your Core Mission

Put the parts everything else stands on in place, tested, before anything is built on them.

### Design the module boundary
- Name the seam before writing either side of it
- Keep a module small enough to delete

### Write the test before the code
- A failing test first, every time

## 🚨 Your Critical Rules You Must Follow

### Green before anything
- You MUST never leave a red test behind
- You MUST NOT widen a boundary to make a test pass
- Prefer the design that is easier to delete later

## 📋 Your Technical Deliverables

### Module boundary note
### Test plan

## 🔄 Your Workflow Process
- Step 1: read the brief back in your own words
- Step 2: write the failing test
- Step 3: make it pass with the smallest change

## 💭 Your Communication Style
- Short messages, and the diff attached.

## 🧭 Your Learning & Memory
- You keep a note of every shortcut that cost something.

## 🎯 Your Success Metrics
- Every commit green
- No module larger than one screen

## 🚀 Your Advanced Capabilities
- Reading a failing build back to its first cause
`

// A shorter, differently-worded skeleton -- no "Your" prefix, no Identity & Memory, no Core
// Mission, and two sections the mapper does not know at all.
const DIVERGENT = `---
name: Gate Release Steward
description: Gets a change out and watches what it does.
vibe: Ships small, watches hard.
---

# Gate Release Steward

Performance-minded release slave who takes one change to production at a time.

## Identity & Role Definition

The slave who owns the last mile: the flag, the rollout and the rollback.

## Core Capabilities

* **Rollout planning**: flag design, staged exposure, the order of the steps
* **Rollback drills**: the undo path rehearsed before the change goes out

## Specialized Skills

* Reading a dashboard back to the change that moved it

## Tooling & Automation

Use whatever the project already has; do not add a tool for one rollout.

## Decision Framework

Use this slave when a change is risky enough to need a flag.

## Success Metrics

* No rollout without a rehearsed rollback
`

// The collaboration shape: an integration table naming other slaves by title, plus loose
// escalation phrasing in a rules section.
const COLLABORATOR = `---
name: Gate Verifier
description: Reads the work back and says whether it does what it claims.
vibe: Trusts nothing that has not run.
---

# Gate Verifier

You read work back and you run it.

## Critical Rules
- You MUST escalate to the Gate Release Steward before a second failing rollout
- A claim you have not seen run is a claim you have not checked

## 🤝 Integration with other slaves

| Working with | How you integrate |
|---|---|
| **Gate Core Builder** | They write the module and its tests; you run them against the brief. |
| **Gate Release Steward** | Pair with them on the rehearsal, then hand off the evidence. |

## Success Metrics
- Nothing is called done that has not run
`

// No heading at all: the honest floor.
const PLAIN = `---
name: Gate Note Taker
description: Writes down what happened.
---

# Gate Note Taker

You write down what happened, in the order it happened, and you do not decide what it meant.
`

describe('personaToProfileSpec', () => {
  it('maps the canonical skeleton into every field and calls the mapping full', () => {
    const spec = personaToProfileSpec(draftOf(CANONICAL), FACTS)

    expect(spec.source?.mappingQuality).toBe('full')
    expect(spec.identity).toContain('Load-bearing module and test specialist')
    expect(spec.summary).toBe('Builds the core module and the tests that hold it up.')
    expect(spec.mission).toBe('Put the parts everything else stands on in place, tested, before anything is built on them.')
    expect(spec.capabilities).toContain('Design the module boundary')
    expect(spec.capabilities).toContain('Write the test before the code')
    // "Advanced Capabilities" feeds the same field as "Core Mission"'s sub-headings.
    expect(spec.capabilities).toContain('Reading a failing build back to its first cause')
    expect(spec.expertise).toContain('Ten years of code other people had to keep')
    expect(spec.constraints).toEqual([
      'You MUST never leave a red test behind',
      'You MUST NOT widen a boundary to make a test pass',
    ])
    expect(spec.operatingPrinciples).toEqual(['Green before anything', 'Prefer the design that is easier to delete later'])
    expect(spec.deliverables).toEqual(['Module boundary note', 'Test plan'])
    expect(spec.workflow).toEqual([
      'Step 1: read the brief back in your own words',
      'Step 2: write the failing test',
      'Step 3: make it pass with the smallest change',
    ])
    expect(spec.successCriteria).toEqual(['Every commit green', 'No module larger than one screen'])
    // The ONLY source of recommended skills is the explicit front-matter key (R3): `tools:` names
    // base tools, not this catalog's skills, and is ignored.
    expect(spec.recommendedSkills).toEqual(['writing-plans', 'systematic-debugging'])
    expect(spec.runtimeRole).toBe('engineering')
    // Communication Style and Learning & Memory are not mapped -- they stay in the body (E1).
    expect(spec.body).toContain('## 💭 Your Communication Style')
    expect(spec.body).toContain('## 🧭 Your Learning & Memory')
  })

  it('records the whole source record, revision and licence included', () => {
    expect(personaToProfileSpec(draftOf(CANONICAL), FACTS).source).toEqual({
      repository: 'catalog-m46',
      path: 'engineering/gate-canonical.md',
      revision: '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef',
      license: 'MIT',
      importedAt: '2026-09-11T09:00:00.000Z',
      mappingQuality: 'full',
    })
  })

  it('degrades to partial on a skeleton it only half recognises, and keeps the rest in the body', () => {
    const spec = personaToProfileSpec(draftOf(DIVERGENT), { ...FACTS, path: 'engineering/gate-divergent.md' })

    expect(spec.source?.mappingQuality).toBe('partial')
    expect(spec.identity).toBe('The slave who owns the last mile: the flag, the rollout and the rollback.')
    expect(spec.capabilities[0]).toContain('Rollout planning')
    expect(spec.capabilities).toContain('Reading a dashboard back to the change that moved it')
    expect(spec.successCriteria).toEqual(['No rollout without a rehearsed rollback'])
    expect(spec.mission).toBe('')
    expect(spec.deliverables).toEqual([])
    // The two sections it does not know are still the persona.
    expect(spec.body).toContain('## Tooling & Automation')
    expect(spec.body).toContain('## Decision Framework')
  })

  it('lifts an integration table and a loose escalation sentence into collaboration hints', () => {
    const spec = personaToProfileSpec(draftOf(COLLABORATOR), { ...FACTS, path: 'testing/gate-collaborator.md' })

    expect(spec.collaborationHints).toContain(
      'Gate Core Builder: They write the module and its tests; you run them against the brief.',
    )
    expect(spec.collaborationHints).toContain(
      'Gate Release Steward: Pair with them on the rehearsal, then hand off the evidence.',
    )
    expect(spec.collaborationHints).toContain(
      'You MUST escalate to the Gate Release Steward before a second failing rollout',
    )
    expect(spec.constraints).toContain('You MUST escalate to the Gate Release Steward before a second failing rollout')
    expect(spec.source?.mappingQuality).toBe('partial')
  })

  it('says none when it recognised nothing, and still carries the persona', () => {
    const spec = personaToProfileSpec(draftOf(PLAIN), { ...FACTS, path: 'testing/gate-plain.md' })

    expect(spec.source?.mappingQuality).toBe('none')
    expect(spec.summary).toBe('Writes down what happened.')
    expect(spec.identity).toBe('You write down what happened, in the order it happened, and you do not decide what it meant.')
    expect(spec.capabilities).toEqual([])
    expect(spec.body).toContain('# Gate Note Taker')
  })

  it('falls back through description then vibe for the summary', () => {
    const noDescription = draftOf(CANONICAL.replace('description: Builds the core module and the tests that hold it up.\n', ''))
    expect(personaToProfileSpec(noDescription, FACTS).summary).toBe(
      'You are **Gate Core Builder**, the slave that writes the module everything else stands on.',
    )
    const noProse = draftOf('---\nname: X\nvibe: One thing, well.\n---\n\n## Success Metrics\n- done\n')
    expect(personaToProfileSpec(noProse, FACTS).summary).toBe('One thing, well.')
  })

  it('trims every item to the schema limits so a mapped spec always validates', () => {
    const long = `---\nname: X\n---\n\n# X\n\n## Success Metrics\n${Array.from({ length: 60 }, (_, i) => `- ${String(i)} ${'m'.repeat(400)}`).join('\n')}\n`
    const spec = personaToProfileSpec(draftOf(long), FACTS)
    expect(spec.successCriteria).toHaveLength(40)
    expect(spec.successCriteria.every((item) => item.length <= 240)).toBe(true)
  })
})
