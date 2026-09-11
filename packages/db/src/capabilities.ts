import type { CapabilityRecord } from '@slave-of-ai/domain'

/**
 * The taxonomy as SHIPPED (M47 R1): what `db:seed` writes and what `syncCapabilityTaxonomy()`
 * reconciles the `Capability` table against on every import and on demand.
 *
 * It lives in `packages/db` rather than in `packages/domain` on purpose: the domain's capability
 * functions take a taxonomy as DATA so they can be tested with three rows, and a hardcoded list
 * inside them would be exactly the hardcoding R1 forbids. An operator adds a key with
 * `capabilities add`; nothing here is a ceiling.
 *
 * `role` is the runtime role a capability's domain PROJECTS to (R2) -- the string `decide()`
 * matches. Five of them are roles this repository already dispatches on (`backend`, `frontend`,
 * `manager`, `reviewer`); the rest name a role a hire creates, which is what makes a hired
 * specialist dispatchable for the task that asked for it.
 *
 * KEY ASCENDING, and the test beside this file holds it there (M47 final review, Minor 10). It is
 * the order `listCapabilities()` returns the table in, so a reader comparing the checked-in list
 * with `capabilities list` is comparing two copies of one order -- and it is the order
 * `normaliseCapabilities`' "first spelling wins" rule and `formTeam`'s tie-breaks are decided by
 * when the taxonomy is read from this array rather than from the table.
 */
export const CAPABILITY_SEED: readonly CapabilityRecord[] = [
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: ['api architecture', 'rest design', 'endpoint design'] },
  { key: 'backend.integration', label: 'Third-party integration', domain: 'backend', role: 'backend', synonyms: ['api integration'] },
  { key: 'backend.messaging', label: 'Queues and messaging', domain: 'backend', role: 'backend', synonyms: ['event driven', 'message queues'] },
  { key: 'backend.performance', label: 'Backend performance', domain: 'backend', role: 'backend', synonyms: ['latency tuning', 'throughput'] },
  { key: 'backend.services', label: 'Service implementation', domain: 'backend', role: 'backend', synonyms: ['server side', 'backend development'] },
  { key: 'data.analytics', label: 'Analytics', domain: 'data', role: 'data', synonyms: ['reporting', 'business intelligence'] },
  { key: 'data.machine-learning', label: 'Machine learning', domain: 'data', role: 'data', synonyms: ['ml engineering', 'model training'] },
  { key: 'data.pipelines', label: 'Data pipelines', domain: 'data', role: 'data', synonyms: ['etl', 'data engineering'] },
  { key: 'data.warehousing', label: 'Data warehousing', domain: 'data', role: 'data', synonyms: ['data warehouse'] },
  { key: 'database.migrations', label: 'Migrations', domain: 'database', role: 'database', synonyms: ['schema migration'] },
  { key: 'database.postgres', label: 'PostgreSQL', domain: 'database', role: 'database', synonyms: ['postgresql'] },
  { key: 'database.query-performance', label: 'Query performance', domain: 'database', role: 'database', synonyms: ['index tuning', 'slow queries'] },
  { key: 'database.schema-design', label: 'Schema design', domain: 'database', role: 'database', synonyms: ['data modelling', 'data modeling'] },
  { key: 'design.design-systems', label: 'Design systems', domain: 'design', role: 'design', synonyms: ['component library'] },
  { key: 'design.interaction', label: 'Interaction design', domain: 'design', role: 'design', synonyms: ['ux design'] },
  { key: 'design.visual', label: 'Visual design', domain: 'design', role: 'design', synonyms: ['ui design'] },
  { key: 'docs.api-reference', label: 'API reference', domain: 'docs', role: 'docs', synonyms: ['api documentation'] },
  { key: 'docs.technical-writing', label: 'Technical writing', domain: 'docs', role: 'docs', synonyms: ['documentation'] },
  { key: 'frontend.accessibility', label: 'Accessibility', domain: 'frontend', role: 'frontend', synonyms: ['a11y', 'wcag'] },
  { key: 'frontend.performance', label: 'Frontend performance', domain: 'frontend', role: 'frontend', synonyms: ['bundle size', 'web vitals'] },
  { key: 'frontend.state-management', label: 'State management', domain: 'frontend', role: 'frontend', synonyms: ['client state'] },
  { key: 'frontend.styling', label: 'Styling and layout', domain: 'frontend', role: 'frontend', synonyms: ['css', 'design implementation'] },
  { key: 'frontend.ui-implementation', label: 'UI implementation', domain: 'frontend', role: 'frontend', synonyms: ['frontend development', 'component work'] },
  { key: 'mobile.android', label: 'Android', domain: 'mobile', role: 'mobile', synonyms: ['kotlin'] },
  { key: 'mobile.cross-platform', label: 'Cross-platform mobile', domain: 'mobile', role: 'mobile', synonyms: ['react native', 'flutter'] },
  { key: 'mobile.ios', label: 'iOS', domain: 'mobile', role: 'mobile', synonyms: ['swift', 'iphone'] },
  { key: 'operations.ci-cd', label: 'CI and CD', domain: 'operations', role: 'operations', synonyms: ['ci/cd', 'cicd', 'continuous integration', 'build pipelines'] },
  { key: 'operations.deployment', label: 'Deployment', domain: 'operations', role: 'operations', synonyms: ['release engineering', 'rollout'] },
  { key: 'operations.incident-response', label: 'Incident response', domain: 'operations', role: 'operations', synonyms: ['on call', 'incident management'] },
  { key: 'operations.infrastructure', label: 'Infrastructure', domain: 'operations', role: 'operations', synonyms: ['platform engineering', 'infrastructure as code'] },
  { key: 'operations.observability', label: 'Observability', domain: 'operations', role: 'operations', synonyms: ['monitoring', 'tracing', 'logging'] },
  { key: 'planning.coordination', label: 'Coordination', domain: 'planning', role: 'manager', synonyms: ['project coordination'] },
  { key: 'planning.decomposition', label: 'Work decomposition', domain: 'planning', role: 'manager', synonyms: ['task breakdown', 'work breakdown'] },
  { key: 'planning.estimation', label: 'Estimation', domain: 'planning', role: 'manager', synonyms: ['sizing'] },
  { key: 'product.requirements', label: 'Requirements', domain: 'product', role: 'product', synonyms: ['requirements gathering', 'specification'] },
  { key: 'product.roadmapping', label: 'Roadmapping', domain: 'product', role: 'product', synonyms: ['prioritisation', 'prioritization'] },
  { key: 'product.user-research', label: 'User research', domain: 'product', role: 'product', synonyms: ['customer discovery'] },
  { key: 'qa.exploratory', label: 'Exploratory testing', domain: 'qa', role: 'qa', synonyms: ['manual testing'] },
  { key: 'qa.load-testing', label: 'Load testing', domain: 'qa', role: 'qa', synonyms: ['performance testing', 'stress testing'] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'qa', synonyms: ['automated testing', 'e2e testing'] },
  { key: 'qa.test-strategy', label: 'Test strategy', domain: 'qa', role: 'qa', synonyms: ['quality strategy'] },
  { key: 'review.code-review', label: 'Code review', domain: 'review', role: 'reviewer', synonyms: ['peer review', 'diff review'] },
  { key: 'review.release-readiness', label: 'Release readiness', domain: 'review', role: 'reviewer', synonyms: ['go no go', 'release review'] },
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: ['appsec', 'secure code review', 'application security engineering'] },
  { key: 'security.authentication', label: 'Authentication and authorization', domain: 'security', role: 'security', synonyms: ['authn', 'authz', 'access control'] },
  { key: 'security.dependency-audit', label: 'Dependency auditing', domain: 'security', role: 'security', synonyms: ['supply chain security', 'sca'] },
  { key: 'security.secrets', label: 'Secrets and credentials', domain: 'security', role: 'security', synonyms: ['credential management', 'key management'] },
  { key: 'security.threat-modelling', label: 'Threat modelling', domain: 'security', role: 'security', synonyms: ['threat modeling', 'attack surface review'] },
]
