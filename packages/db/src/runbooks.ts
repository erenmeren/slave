import type { RunbookStage } from '@slave-of-ai/domain'

/**
 * One checked-in runbook, in the shape `syncRunbooks()` writes and the seed inserts. The `id` is
 * the database's; `key` is the identity everything else addresses.
 *
 * The same shape as the domain's `RunbookDraft` minus its `sourceTemplateId: string` (fix round 1,
 * Minor 6): `source` and `sourceTemplateId` are stated on each ROW rather than supplied by whoever
 * writes it, so a writer spreads the row instead of re-asserting what the row already says about
 * itself -- and a fourth `source` arriving one day changes these literals, not two call sites.
 */
export interface SeedRunbook {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly keywords: readonly string[]
  readonly requiredCapabilities: readonly string[]
  readonly optionalCapabilities: readonly string[]
  readonly stages: readonly RunbookStage[]
  readonly source: 'seed'
  readonly sourceTemplateId: null
}

const stage = (
  key: string,
  title: string,
  objective: string,
  extra: Partial<RunbookStage> = {},
): RunbookStage => ({
  key,
  title,
  objective,
  capabilities: [],
  dependsOn: [],
  expectedOutputs: [],
  // NEVER a gate (R3): a gate is a shell command in a workspace's own repository, and a list
  // checked into this repository cannot know one. A project adds them with `runbooks add --file`.
  gates: [],
  retry: null,
  escalation: null,
  ...extra,
})

/**
 * The runbooks as SHIPPED (M48 R3): what `db:seed` writes and what `syncRunbooks()` reconciles the
 * `RunbookTemplate` table against.
 *
 * In `packages/db` rather than `packages/domain` for `CAPABILITY_SEED`'s own reason: the domain's
 * runbook functions take runbooks as DATA so they can be tested with three stages, and a hardcoded
 * list inside them would be the hardcoding R3 forbids. An operator adds one with `runbooks add
 * --file`; an imported persona's own process becomes one automatically; nothing here is a ceiling.
 *
 * KEY ASCENDING, and the test beside this file holds it there: it is the order `listRunbooks()`
 * returns the table in, so a reader comparing the checked-in list with `runbooks list` is comparing
 * two copies of one order.
 */
export const RUNBOOK_SEED: readonly SeedRunbook[] = [
  {
    key: 'bug-fix',
    source: 'seed',
    sourceTemplateId: null,
    name: 'Bug fix',
    description: 'Reproduce it first, fix it second, prove it third, and have somebody read the fix.',
    keywords: ['bug', 'fix', 'regression', 'crash', 'defect', 'broken'],
    requiredCapabilities: ['qa.exploratory', 'review.code-review'],
    optionalCapabilities: ['backend.services', 'frontend.ui-implementation'],
    stages: [
      stage('reproduce', 'Reproduce', 'Make the defect happen on demand, and write down how.', {
        capabilities: ['qa.exploratory'],
        expectedOutputs: ['A failing test, or a written reproduction somebody else can follow'],
      }),
      stage('fix', 'Fix', 'Change the smallest thing that makes the reproduction stop failing.', {
        capabilities: ['backend.services'],
        dependsOn: ['reproduce'],
        expectedOutputs: ['A branch whose diff explains itself'],
      }),
      stage('verify', 'Verify', 'Prove the defect is gone and nothing near it moved.', {
        capabilities: ['qa.test-automation'],
        dependsOn: ['fix'],
        expectedOutputs: ['A green verify log'],
        retry: { maxAttempts: 2 },
        escalation: 'A fix that will not go green twice is a fix nobody understands yet: bring a person in before trying a third time.',
      }),
      stage('review', 'Review', 'Have somebody who did not write it read the diff against the report.', {
        capabilities: ['review.code-review'],
        dependsOn: ['verify'],
        expectedOutputs: ['An approval naming the reproduction it checked'],
      }),
    ],
  },
  {
    key: 'feature-delivery',
    source: 'seed',
    sourceTemplateId: null,
    name: 'Feature delivery',
    description: 'Decide the shape, build it, prove it, have it read, and put it where people can use it.',
    keywords: ['feature', 'ship', 'endpoint', 'build', 'deliver', 'implement', 'launch'],
    requiredCapabilities: ['planning.decomposition', 'review.code-review'],
    optionalCapabilities: ['backend.api-design', 'frontend.ui-implementation', 'operations.deployment'],
    stages: [
      stage('design', 'Design', 'Decide the shape of the change before anybody writes it.', {
        capabilities: ['planning.decomposition', 'backend.api-design'],
        expectedOutputs: ['The interface the rest of the work is written against'],
      }),
      stage('implement', 'Implement', 'Build what the design decided, and nothing else.', {
        capabilities: ['backend.services', 'frontend.ui-implementation'],
        dependsOn: ['design'],
        expectedOutputs: ['A branch that does what the handoff asked for'],
      }),
      stage('verify', 'Verify', 'Prove it does what it claims, with something a person can re-run.', {
        capabilities: ['qa.test-automation'],
        dependsOn: ['implement'],
        expectedOutputs: ['A green verify log'],
        retry: { maxAttempts: 2 },
        escalation: 'Two failed verifies on one task means the acceptance criteria and the work disagree: a person decides which one is wrong.',
      }),
      stage('review', 'Review', 'Have the diff read against the handoff by somebody who did not write it.', {
        capabilities: ['review.code-review'],
        dependsOn: ['verify'],
        expectedOutputs: ['An approval, or a rejection naming the criterion it failed'],
      }),
      stage('release', 'Release', 'Put it where the people who asked for it can use it.', {
        capabilities: ['operations.deployment', 'review.release-readiness'],
        dependsOn: ['review'],
        expectedOutputs: ['The change on the base branch, and a note saying what changed'],
      }),
    ],
  },
  {
    key: 'security-review',
    source: 'seed',
    sourceTemplateId: null,
    name: 'Security review',
    description: 'Model the attacker first, read the path, fix what is wrong, and prove the fix.',
    keywords: ['security', 'security review', 'authentication', 'authorization', 'vulnerability', 'threat', 'audit'],
    requiredCapabilities: ['security.threat-modelling', 'security.application'],
    optionalCapabilities: ['security.authentication', 'security.dependency-audit'],
    stages: [
      stage('threat-model', 'Threat model', 'Write down who would attack this and how.', {
        capabilities: ['security.threat-modelling'],
        expectedOutputs: ['The attacks worth defending against, in order'],
      }),
      stage('review', 'Review', 'Read the path the way somebody trying to get past it would.', {
        capabilities: ['security.application'],
        dependsOn: ['threat-model'],
        expectedOutputs: ['The findings, each with the line it is about'],
      }),
      stage('remediate', 'Remediate', 'Close what the review found, worst first.', {
        capabilities: ['security.authentication', 'backend.services'],
        dependsOn: ['review'],
        expectedOutputs: ['A branch closing each finding, or a written reason it stands'],
      }),
      stage('verify', 'Verify', 'Prove each finding is closed, not merely edited.', {
        capabilities: ['qa.test-automation', 'security.application'],
        dependsOn: ['remediate'],
        expectedOutputs: ['A green verify log, and the finding each command covers'],
        retry: { maxAttempts: 2 },
        escalation: 'A security finding that will not verify closed is escalated to a person before the branch goes anywhere near the base branch.',
      }),
    ],
  },
]
