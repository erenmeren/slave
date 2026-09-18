/**
 * Catalog Person Pool (Task 4): the project DEPARTMENT a template's role, plus the runtime roles a
 * seat is approved with, functionally belong in.
 *
 * PURE, and deliberately dumb like `personaToProfileSpec`'s own heading table (`catalog/spec.ts`):
 * a fixed map from a role STRING to a department, no fuzzy matching and no inference from a
 * persona's name. Replaces intake's old one-department-per-project shape (M59 R13): a project
 * staffed from the catalogue now gets the SAME functional departments a hand-run company would --
 * Engineering, Product, Design, Marketing, QA, Operations -- and `Specialists` for a role this
 * table does not recognise, matching the fallback name `hireFromTemplate`/`seatMember` already use
 * for the same idea (`packages/control/src/capability.ts`, `persons.ts`).
 */

/** The seven project departments a role may resolve to. A total, closed list: a `Team` this
 *  function names is always one of these seven, never an eighth invented on the fly. */
export const FUNCTIONAL_DEPARTMENTS = ['Engineering', 'Product', 'Design', 'Marketing', 'QA', 'Operations', 'Specialists'] as const

export type FunctionalDepartment = (typeof FUNCTIONAL_DEPARTMENTS)[number]

/**
 * Every role string this table recognises, to the ONE department it belongs in (Task 4 brief's
 * own table). `manager` and `reviewer` are in here too -- Product and QA respectively -- because a
 * persona whose OWN primary role is unmapped and who genuinely holds one of those as a runtime
 * role really is doing that work, and the table says so honestly rather than defaulting them to
 * `Specialists` for want of a better guess.
 */
const ROLE_DEPARTMENT: Readonly<Record<string, FunctionalDepartment>> = {
  engineering: 'Engineering',
  frontend: 'Engineering',
  backend: 'Engineering',
  database: 'Engineering',
  mobile: 'Engineering',
  security: 'Engineering',
  data: 'Engineering',
  'game-development': 'Engineering',
  gis: 'Engineering',
  'spatial-computing': 'Engineering',

  product: 'Product',
  'project-management': 'Product',
  manager: 'Product',
  research: 'Product',
  docs: 'Product',

  design: 'Design',

  marketing: 'Marketing',
  sales: 'Marketing',
  'paid-media': 'Marketing',

  qa: 'QA',
  testing: 'QA',
  reviewer: 'QA',

  operations: 'Operations',
  support: 'Operations',
}

/**
 * The one project department a seat's template primary role, plus its approved runtime roles,
 * belong in (Task 4 brief).
 *
 * The PRIMARY role decides outright when it has a mapping: `functionalDepartmentFor('frontend',
 * ['manager'])` is `'Engineering'`, never `'Product'`, however `manager` -- a support duty
 * `ensureStaffRoles` (`../intake/team.js`) may have added to that very seat -- would resolve on its
 * own. Only when the primary role maps to NOTHING does this look at `runtimeRoles`, in the order
 * they were approved, and take the first one that maps; `manager`/`reviewer` are ordinary entries
 * in that scan, not excluded from it, because a genuinely unmapped persona holding one of those
 * runtime roles really is doing that work.
 *
 * The fallback, when neither the primary role nor any runtime role maps to anything, is always
 * `'Specialists'` -- never a guess, and never an invented eighth department.
 */
export function functionalDepartmentFor(primaryRole: string, runtimeRoles: readonly string[] = []): FunctionalDepartment {
  const primary = ROLE_DEPARTMENT[primaryRole]
  if (primary !== undefined) return primary
  for (const role of runtimeRoles) {
    const mapped = ROLE_DEPARTMENT[role]
    if (mapped !== undefined) return mapped
  }
  return 'Specialists'
}
