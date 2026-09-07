/**
 * The Checkout Platform crew, in one place.
 *
 * It is seeded twice over: once as the legacy workspace's own `Team`/`Slave` rows (M1), and once
 * -- since M31b's final fix wave -- as a catalog `Company` of the same name, so the software
 * sector has a roster it can actually be simulated on. One literal for both, because two copies
 * of "the Checkout Platform crew" could disagree and only one of them would be the one a
 * simulation reads.
 *
 * Deliberately prisma-free, exactly like `seed-workspace-id.ts`: it is re-exported from the
 * package barrel, and client components import that barrel.
 */

export const CHECKOUT_PLATFORM_TEAMS = ['Management', 'Engineering', 'Security', 'Product', 'Marketing'] as const
export type CheckoutPlatformTeam = (typeof CHECKOUT_PLATFORM_TEAMS)[number]

/** The catalog company's name. Shares the legacy workspace's name on purpose -- it is the same
 *  fictional company, seen from the catalog rather than from a repository. */
export const CHECKOUT_PLATFORM_COMPANY_NAME = 'Checkout Platform'

/**
 * Every member, in the roster shape control's `rosterOf` produces (`departmentName` /
 * `slaveName` / catalog `role`) -- so `softwarePlugin.rosterFits` can be pointed straight at it,
 * which `packages/control/test/checkout-platform-roster.test.ts` does.
 *
 * The roles are what the software sector reads: `Product` supplies the `product` role,
 * `Management` the `lead`, the `reviewer` role beats `QA` for the reviewer seat, and the
 * remaining Engineering members are the engineer pool with their expertise taken from the role
 * name (`Backend` / `Frontend` / `DevOps`, anything else `general`).
 */
export const CHECKOUT_PLATFORM_ROSTER: readonly { readonly slaveName: string; readonly departmentName: CheckoutPlatformTeam; readonly role: string }[] = [
  // Lowercase, matching the M8b planning dispatch's exact-match `role === 'manager'` -- the same
  // convention `dispatchReview` uses for `role === 'reviewer'`.
  { slaveName: 'Atlas', departmentName: 'Management', role: 'manager' },
  { slaveName: 'Alex', departmentName: 'Engineering', role: 'Backend' },
  { slaveName: 'Emma', departmentName: 'Engineering', role: 'Frontend' },
  { slaveName: 'Daniel', departmentName: 'Engineering', role: 'DevOps' },
  { slaveName: 'Maya', departmentName: 'Engineering', role: 'QA' },
  // Lowercase, unlike the other roles here: M1 Task 5's review dispatch matches `role ===
  // 'reviewer'` exactly, the same convention `decide()` uses for `requiredRole`.
  { slaveName: 'Riley', departmentName: 'Engineering', role: 'reviewer' },
  { slaveName: 'Sarah', departmentName: 'Security', role: 'Security' },
  { slaveName: 'John', departmentName: 'Product', role: 'Business Analyst' },
  { slaveName: 'Oliver', departmentName: 'Marketing', role: 'SEO' },
]

/** The catalog template each member is made from: one per distinct role, since `rosterOf` reads a
 *  catalog slave's role off its TEMPLATE, not off the roster row. Named after the role so the
 *  names cannot collide with the M10 catalog's own five templates. */
export const checkoutPlatformTemplateName = (role: string): string => `Checkout ${role}`
