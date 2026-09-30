import { z } from 'zod'
import { err, ok, type Result } from '../result.js'
import { firstJsonObject } from '../supervisor/prompt.js'
import {
  CONDUCT_MAX_PACKAGES,
  INTEGRATION_PACKAGE_KEY,
  SHARED_DECISIONS_MAX,
  SHARED_DECISION_TEXT_MAX_CHARS,
  SHARED_DECISION_TITLE_MAX_CHARS,
  SKELETON_PACKAGE_KEY,
} from './constants.js'
import { globToRegExp, isValidOwnedGlob } from './glob.js'
import { RUN_REQUIREMENT_KEY } from './requirements.js'
import {
  REGISTRATION_DIRECTORY_MAX_CHARS,
  REGISTRATION_PREFIX_MAX_CHARS,
  SKELETON_INTERFACE,
  isLiteralPath,
  isValidRegistration,
  manifestProblems,
  registrationGlob,
  registrationProblems,
  registrationSchema,
  skeletonPaths,
  verifyCheckPathFor,
  type PackageRegistration,
} from './skeleton.js'

export const CONDUCT_ANSWER_KEY = 'conductAnswer'

export interface PackageSpec {
  readonly key: string
  readonly title: string
  readonly requirementKeys: readonly string[]
  readonly ownedPaths: readonly string[]
  readonly newPaths: readonly string[]
  readonly interface: string
  readonly dependsOn: readonly string[]
  readonly isIntegration: boolean
  readonly templateId: string
  /** Skeleton spec S3 (plan A D5): shared directories this package adds files to, under its own
   *  prefix. Their globs are already in `ownedPaths`; this is what the contract explains. */
  readonly registrations: readonly PackageRegistration[]
}

/** Supervisor-as-conductor spec C3: a decision every package follows (API shape, where routes
 *  register, persistence, error shape, configuration). It never moves ownership (ownedPaths does). */
export interface SharedDecision {
  readonly title: string
  readonly decision: string
}

export const sharedDecisionSchema = z.object({
  title: z.string().trim().min(1).max(SHARED_DECISION_TITLE_MAX_CHARS),
  decision: z.string().trim().min(1).max(SHARED_DECISION_TEXT_MAX_CHARS),
})

/** Plan A D10: a decision title as the uniqueness rule reads it -- trimmed, whitespace folded, lower-cased. */
export function decisionTitleKey(title: string): string {
  return title.trim().replace(/\s+/gu, ' ').toLowerCase()
}

export interface ConductPlan {
  readonly mode: 'single' | 'partitioned'
  readonly reason: string
  readonly packages: readonly PackageSpec[]
  readonly decisions: readonly SharedDecision[]
}

/**
 * A stored {@link ConductPlan} read back typed (`ConductorCall.plan`): the interfaces above stay
 * the source of truth and this mirrors them, so a plan bought on one tick and staffed on a later
 * one is the same plan, field for field. Validation already ran before the plan was stored.
 */
export const conductPlanSchema: z.ZodType<ConductPlan, z.ZodTypeDef, unknown> = z.object({
  mode: z.enum(['single', 'partitioned']),
  reason: z.string(),
  packages: z.array(z.object({
    key: z.string().min(1),
    title: z.string(),
    requirementKeys: z.array(z.string()),
    ownedPaths: z.array(z.string()),
    newPaths: z.array(z.string()),
    interface: z.string(),
    dependsOn: z.array(z.string()),
    isIntegration: z.boolean(),
    templateId: z.string().min(1),
    // A plan stored before registrations existed reads as registering nothing; a malformed one is
    // refused, not read as none (a silent catch would hide corruption).
    registrations: z.array(registrationSchema).default([]),
  })).min(1),
  // A plan stored before shared decisions existed reads as having none (spec 4).
  decisions: z.array(sharedDecisionSchema).default([]),
})

export interface ConductContext {
  readonly requirementKeys: readonly string[]
  readonly repoFiles: readonly string[]
  readonly templateIds: ReadonlySet<string>
}

const keySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u)
const packageSchema = z.object({
  key: keySchema,
  title: z.string().trim().min(1).max(200),
  requirementKeys: z.array(z.string()).default([]),
  ownedPaths: z.array(z.string()).min(1),
  newPaths: z.array(z.string()).default([]),
  interface: z.string().max(4000).default(''),
  dependsOn: z.array(z.string()).default([]),
  templateId: z.string().min(1),
  // Lengths and characters are `isValidRegistration`'s, so a refusal names the registration.
  registrations: z.array(registrationSchema).max(10).default([]),
})
const answerSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('single'),
    reason: z.string().trim().min(1),
    templateId: z.string().min(1),
    decisions: z.array(sharedDecisionSchema).max(SHARED_DECISIONS_MAX).default([]),
  }),
  z.object({
    mode: z.literal('partitioned'),
    reason: z.string().trim().min(1),
    packages: z.array(packageSchema).min(2).max(CONDUCT_MAX_PACKAGES),
    decisions: z.array(sharedDecisionSchema).max(SHARED_DECISIONS_MAX).default([]),
    integrationTemplateId: z.string().min(1).optional(),
    skeletonTemplateId: z.string().min(1).optional(),
  }),
])

/** The one package of a `single` goal: every requirement, every path (spec R4: owns `**`). */
export function singlePlan(
  templateId: string,
  requirementKeys: readonly string[],
  reason: string,
  decisions: readonly SharedDecision[] = [],
): ConductPlan {
  return {
    mode: 'single',
    reason,
    packages: [{
      key: 'main', title: 'The whole goal', requirementKeys: [...requirementKeys], ownedPaths: ['**'], newPaths: [],
      interface: '', dependsOn: [], isIntegration: false, templateId, registrations: [],
    }],
    decisions: [...decisions],
  }
}

/**
 * Who owns a path (spec R3): the one non-integration package whose globs match it, else the
 * integration package, else nobody. Validation guarantees at most one non-integration match for
 * every existing and declared path; for any other path the first match in package order wins.
 */
export function ownerOf(
  path: string,
  packages: readonly Pick<PackageSpec, 'key' | 'ownedPaths' | 'isIntegration'>[],
): string | null {
  const direct = packages.find((p) => !p.isIntegration && p.ownedPaths.some((g) => globToRegExp(g).test(path)))
  if (direct !== undefined) return direct.key
  return packages.find((p) => p.isIntegration)?.key ?? null
}

/** Reads the raw `conductAnswer` object out of the model's text; `validateConduct` judges it. */
export function parseConductAnswer(text: string): Result<unknown, string> {
  const json = firstJsonObject(text)
  if (json === null) return err('the answer carried no JSON object')
  try {
    const value = JSON.parse(json) as Record<string, unknown>
    if (typeof value !== 'object' || value === null || !(CONDUCT_ANSWER_KEY in value)) {
      return err(`the answer must be {"${CONDUCT_ANSWER_KEY}": {...}}`)
    }
    return ok(value[CONDUCT_ANSWER_KEY])
  } catch {
    return err('the answer\'s JSON did not parse')
  }
}

function hasCycle(packages: readonly { readonly key: string; readonly dependsOn: readonly string[] }[]): boolean {
  const deps = new Map(packages.map((p) => [p.key, p.dependsOn] as const))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (key: string): boolean => {
    if (state.get(key) === 'done') return false
    if (state.get(key) === 'visiting') return true
    state.set(key, 'visiting')
    const cyclic = (deps.get(key) ?? []).some(visit)
    state.set(key, 'done')
    return cyclic
  }
  return packages.some((p) => visit(p.key))
}

/**
 * Judges the conductor's answer against the goal's requirements, the repository and the
 * catalogue (spec R2/R3). Every problem found is listed in ONE sentence list, because the list is
 * handed back to the next attempt's prompt (plan decision D4) and a model fixes what it is told.
 */
export function validateConduct(answer: unknown, context: ConductContext): Result<ConductPlan, string> {
  const parsed = answerSchema.safeParse(answer)
  if (!parsed.success) {
    return err(`the answer's shape is wrong: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  const value = parsed.data
  // Plan A D10: one decision per title, however it is cased or spaced.
  const titleKeys = value.decisions.map((d) => decisionTitleKey(d.title))
  const repeated = [...new Set(titleKeys.filter((key, index) => titleKeys.indexOf(key) !== index))]
  const decisionProblems = repeated.map((key) => `decision titles must be unique: "${key}"`)
  if (value.mode === 'single') {
    if (!context.templateIds.has(value.templateId)) return err(`templateId "${value.templateId}" is not in the catalogue`)
    if (decisionProblems.length > 0) return err(decisionProblems.join('; '))
    return ok(singlePlan(value.templateId, context.requirementKeys, value.reason, value.decisions))
  }

  const problems: string[] = [...decisionProblems]
  // Plan A D2: only a set extracted since skeleton spec S6 carries RUN; an older set validates as before.
  const runKey = context.requirementKeys.includes(RUN_REQUIREMENT_KEY) ? RUN_REQUIREMENT_KEY : null
  const keys = value.packages.map((p) => p.key)
  if (new Set(keys).size !== keys.length) problems.push('package keys must be unique')

  for (const p of value.packages) {
    if (!context.templateIds.has(p.templateId)) problems.push(`package "${p.key}": templateId "${p.templateId}" is not in the catalogue`)
    for (const glob of [...p.ownedPaths, ...p.newPaths]) {
      if (!isValidOwnedGlob(glob)) problems.push(`package "${p.key}": "${glob}" is not a repository-relative path`)
    }
    for (const registration of p.registrations) {
      if (!isValidRegistration(registration)) {
        problems.push(`package "${p.key}": registration ${JSON.stringify(registration)} needs a plain directory as git writes it (no glob operator, no "./", "//" or "." segment; at most ${REGISTRATION_DIRECTORY_MAX_CHARS} characters) and a prefix of at most ${REGISTRATION_PREFIX_MAX_CHARS} with no "/", "*" or "?"`)
      }
    }
    if (p.key === SKELETON_PACKAGE_KEY && p.dependsOn.length > 0) {
      problems.push(`package "${SKELETON_PACKAGE_KEY}" depends on nothing: it runs first, and every other package depends on it`)
    }
    for (const dep of p.dependsOn) {
      // Integration is made to depend on every other package below, so the reverse edge is always
      // a cycle (final review I4) -- refused by name, since "a cycle" alone would not say which.
      if (dep === INTEGRATION_PACKAGE_KEY && p.key !== INTEGRATION_PACKAGE_KEY) {
        problems.push(`package "${p.key}": dependsOn "${INTEGRATION_PACKAGE_KEY}" is not allowed -- the integration package depends on every other package, never the other way round`)
      } else if (dep === SKELETON_PACKAGE_KEY && p.key !== SKELETON_PACKAGE_KEY) {
        // Skeleton spec S1: always there -- named by the conductor, or added below.
      } else if (!keys.includes(dep) || dep === p.key) {
        problems.push(`package "${p.key}": dependsOn "${dep}" names no other package`)
      }
    }
    // A package's own registration files are its own new paths too (review fix I1).
    const ownGlobs = [...p.ownedPaths, ...p.registrations.map(registrationGlob)]
    for (const path of p.newPaths) {
      if (!ownGlobs.some((g) => globToRegExp(g).test(path))) problems.push(`package "${p.key}": new path "${path}" is not inside its own ownedPaths`)
    }
    if (runKey !== null && p.requirementKeys.includes(runKey)) {
      problems.push(`package "${p.key}": requirement ${runKey} is Slave's own and belongs to the ${INTEGRATION_PACKAGE_KEY} package -- list it in no package`)
    }
  }
  const owners = new Map<string, string[]>()
  for (const p of value.packages) for (const r of p.requirementKeys) owners.set(r, [...(owners.get(r) ?? []), p.key])
  for (const r of context.requirementKeys) {
    if (r === runKey) continue
    const holders = owners.get(r) ?? []
    if (holders.length === 0) problems.push(`requirement ${r} is in no package`)
    if (holders.length > 1) problems.push(`requirement ${r} is in ${holders.length} packages (${holders.join(', ')})`)
  }
  for (const r of owners.keys()) if (!context.requirementKeys.includes(r)) problems.push(`requirement ${r} does not exist`)

  const declared = value.packages.flatMap((p) => p.newPaths)
  const known = [...new Set([...context.repoFiles, ...declared])]
  const firstTemplate = value.packages[0]?.templateId ?? ''
  const templateOr = (id: string | undefined): string => (id !== undefined && context.templateIds.has(id) ? id : firstTemplate)

  let packages: PackageSpec[] = value.packages.map((p) => ({
    key: p.key,
    title: p.title,
    requirementKeys: p.requirementKeys,
    // Plan A D5: a registration is owned as its prefix glob, so the gate and the diff audit enforce it.
    ownedPaths: [...p.ownedPaths, ...p.registrations.map(registrationGlob)],
    newPaths: p.newPaths,
    interface: p.interface,
    dependsOn: p.dependsOn,
    isIntegration: p.key === INTEGRATION_PACKAGE_KEY,
    templateId: p.templateId,
    registrations: p.registrations,
  }))
  problems.push(...manifestProblems(packages, known))

  // Skeleton spec S1 (plan A D3): first in the list, because it runs first.
  const namedSkeleton = packages.some((p) => p.key === SKELETON_PACKAGE_KEY)
  if (!namedSkeleton) {
    packages.unshift({
      key: SKELETON_PACKAGE_KEY,
      title: 'The runnable skeleton',
      requirementKeys: [],
      ownedPaths: [],
      newPaths: [],
      interface: SKELETON_INTERFACE,
      dependsOn: [],
      isIntegration: false,
      templateId: templateOr(value.skeletonTemplateId),
      registrations: [],
    })
  }
  if (!packages.some((p) => p.isIntegration)) {
    packages.push({
      key: INTEGRATION_PACKAGE_KEY,
      title: 'Integrate the packages',
      requirementKeys: [],
      ownedPaths: [],
      newPaths: [],
      interface: 'Wire the other packages together through the interfaces they declare; you own every file no other package owns.',
      dependsOn: [],
      isIntegration: true,
      templateId: templateOr(value.integrationTemplateId),
      registrations: [],
    })
  }
  const skeletonShare = skeletonPaths(packages, known, !namedSkeleton)
  problems.push(...skeletonShare.problems)
  const nonIntegration = packages.filter((p) => !p.isIntegration).map((p) => p.key)
  packages = packages.map((p): PackageSpec => {
    // Plan A D7: each package owns exactly its own check file.
    const ownedPaths = [...p.ownedPaths, ...(p.key === SKELETON_PACKAGE_KEY ? skeletonShare.add : []), verifyCheckPathFor(p.key)]
    if (p.isIntegration) {
      return { ...p, ownedPaths, dependsOn: nonIntegration, requirementKeys: runKey === null ? p.requirementKeys : [...p.requirementKeys, runKey] }
    }
    if (p.key === SKELETON_PACKAGE_KEY) return { ...p, ownedPaths }
    return { ...p, ownedPaths, dependsOn: p.dependsOn.includes(SKELETON_PACKAGE_KEY) ? p.dependsOn : [SKELETON_PACKAGE_KEY, ...p.dependsOn] }
  })
  problems.push(...registrationProblems(packages))

  // Disjointness over what exists, what the packages SAID they will create (spec R3), and every
  // path the rules above named outright -- the skeleton's, each `scripts/verify.d/<key>.sh`.
  const literal = packages.flatMap((p) => p.ownedPaths.filter(isLiteralPath))
  const matchers = packages.map((p) => ({ key: p.key, regexes: p.ownedPaths.map(globToRegExp) }))
  const clashes: string[] = []
  for (const path of new Set([...known, ...literal])) {
    const matching = matchers.filter((m) => m.regexes.some((r) => r.test(path))).map((m) => m.key)
    if (matching.length > 1 && clashes.length < 10) clashes.push(`${path} (${matching.join(', ')})`)
  }
  if (clashes.length > 0) problems.push(`two packages own the same file: ${clashes.join('; ')}`)
  // On the graph as it will be WRITTEN, after the integration and skeleton rewrites.
  if (hasCycle(packages)) problems.push('the packages\' dependsOn form a cycle')
  if (problems.length > 0) return err(problems.join('; '))
  return ok({ mode: 'partitioned', reason: value.reason, packages, decisions: value.decisions })
}
