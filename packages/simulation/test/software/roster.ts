/** The catalog's "Checkout Platform" crew, exactly as `packages/db/src/seed.ts` seeds it: the
 *  roster every software test builds a definition from. A plain module, not a `.test.ts` — a
 *  fixture imported from a test file would re-run that file's suites in every importer. */
export const CHECKOUT_ROSTER = [
  { slaveName: 'Atlas', departmentName: 'Management', role: 'manager' },
  { slaveName: 'Alex', departmentName: 'Engineering', role: 'Backend' },
  { slaveName: 'Emma', departmentName: 'Engineering', role: 'Frontend' },
  { slaveName: 'Daniel', departmentName: 'Engineering', role: 'DevOps' },
  { slaveName: 'Maya', departmentName: 'Engineering', role: 'QA' },
  { slaveName: 'Riley', departmentName: 'Engineering', role: 'reviewer' },
  { slaveName: 'Sarah', departmentName: 'Security', role: 'Security' },
  { slaveName: 'John', departmentName: 'Product', role: 'Business Analyst' },
  { slaveName: 'Oliver', departmentName: 'Marketing', role: 'SEO' },
]
