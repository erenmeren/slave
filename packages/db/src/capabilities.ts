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
 * **Synonyms are EXACT alternative names, reviewed one at a time.** `normaliseCapabilities` matches
 * a key, a label or a synonym and nothing else -- no substrings, no fuzzy scoring -- so a synonym
 * is not a hint, it is a second correct spelling of this row and only this row. The final review's
 * Important 7 pass added twelve of them by reading the live catalogue's own unresolved values:
 * singulars for plurals (`design system`), spelling variants (`query optimisation`), and the
 * standard industry term for a row whose label is a house phrasing (`secrets management` for
 * "Secrets and credentials"). It also replaced `database.postgres`'s dead `postgresql` -- which is
 * what that row's own LABEL already normalises to -- with `postgres`, which nothing matched.
 *
 * What that pass deliberately did NOT add is the more important half. The live catalogue's 279
 * templates carry 4,003 distinct unresolved capability values, and the only eight that repeat at
 * all are broad headings (`Performance Optimization`, `Pipeline Engineering`, `Business
 * Integration`, ...) that could sit under three rows or none. They stay unresolved and visible in
 * `SlaveTemplate.unresolvedCapabilities`, where an operator can act on them, rather than being
 * guessed into a key nobody reviewed.
 *
 * 2026-09-20 (catalogue capability mapping, R1): the seed grew from 48 rows over 13 domains to 111
 * over 29 so every division of the catalogue has rows to be mapped onto; the semantic mapping
 * itself is a model pass (`capabilities map`), not a synonym, and the matching rule above is
 * unchanged.
 *
 * KEY ASCENDING, and the test beside this file holds it there (M47 final review, Minor 10). It is
 * the order `listCapabilities()` returns the table in, so a reader comparing the checked-in list
 * with `capabilities list` is comparing two copies of one order -- and it is the order
 * `normaliseCapabilities`' "first spelling wins" rule and `formTeam`'s tie-breaks are decided by
 * when the taxonomy is read from this array rather than from the table.
 */
export const CAPABILITY_SEED: readonly CapabilityRecord[] = [
  { key: 'academic.methods', label: 'Research methods', domain: 'academic', role: 'academic', synonyms: ['research design', 'study design'] },
  { key: 'academic.teaching', label: 'Teaching and curriculum', domain: 'academic', role: 'academic', synonyms: ['curriculum design', 'instruction'] },
  { key: 'academic.writing', label: 'Academic writing', domain: 'academic', role: 'academic', synonyms: ['paper writing', 'grant writing'] },
  { key: 'ai.evaluation', label: 'Model evaluation', domain: 'ai', role: 'ai', synonyms: ['llm evaluation', 'eval design'] },
  { key: 'ai.llm-integration', label: 'LLM integration', domain: 'ai', role: 'ai', synonyms: ['rag', 'retrieval augmented generation'] },
  { key: 'ai.mcp-tooling', label: 'MCP tooling', domain: 'ai', role: 'ai', synonyms: ['mcp servers', 'tool protocols'] },
  { key: 'ai.prompt-design', label: 'Prompt design', domain: 'ai', role: 'ai', synonyms: ['prompt engineering'] },
  { key: 'ai.workflow-orchestration', label: 'Workflow orchestration', domain: 'ai', role: 'ai', synonyms: ['multi-step automation', 'pipeline orchestration'] },
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: ['api architecture', 'rest design', 'endpoint design'] },
  { key: 'backend.integration', label: 'Third-party integration', domain: 'backend', role: 'backend', synonyms: ['api integration'] },
  { key: 'backend.messaging', label: 'Queues and messaging', domain: 'backend', role: 'backend', synonyms: ['event driven', 'message queues'] },
  { key: 'backend.performance', label: 'Backend performance', domain: 'backend', role: 'backend', synonyms: ['latency tuning', 'throughput'] },
  { key: 'backend.services', label: 'Service implementation', domain: 'backend', role: 'backend', synonyms: ['server side', 'backend development'] },
  { key: 'business.change-management', label: 'Change management', domain: 'business', role: 'business', synonyms: ['organisational change', 'organizational change'] },
  { key: 'business.operations', label: 'Business operations', domain: 'business', role: 'business', synonyms: ['operations management', 'process improvement'] },
  { key: 'business.strategy', label: 'Business strategy', domain: 'business', role: 'business', synonyms: ['corporate strategy', 'strategic planning'] },
  { key: 'data.analytics', label: 'Analytics', domain: 'data', role: 'data', synonyms: ['reporting', 'business intelligence'] },
  { key: 'data.machine-learning', label: 'Machine learning', domain: 'data', role: 'data', synonyms: ['ml engineering', 'model training'] },
  { key: 'data.pipelines', label: 'Data pipelines', domain: 'data', role: 'data', synonyms: ['etl', 'data engineering'] },
  { key: 'data.warehousing', label: 'Data warehousing', domain: 'data', role: 'data', synonyms: ['data warehouse'] },
  { key: 'database.migrations', label: 'Migrations', domain: 'database', role: 'database', synonyms: ['schema migration'] },
  { key: 'database.postgres', label: 'PostgreSQL', domain: 'database', role: 'database', synonyms: ['postgres'] },
  { key: 'database.query-performance', label: 'Query performance', domain: 'database', role: 'database', synonyms: ['index tuning', 'slow queries', 'query optimisation', 'query optimization'] },
  { key: 'database.schema-design', label: 'Schema design', domain: 'database', role: 'database', synonyms: ['data modelling', 'data modeling'] },
  { key: 'design.design-systems', label: 'Design systems', domain: 'design', role: 'design', synonyms: ['component library', 'design system'] },
  { key: 'design.interaction', label: 'Interaction design', domain: 'design', role: 'design', synonyms: ['ux design', 'user experience design'] },
  { key: 'design.visual', label: 'Visual design', domain: 'design', role: 'design', synonyms: ['ui design'] },
  { key: 'docs.api-reference', label: 'API reference', domain: 'docs', role: 'docs', synonyms: ['api documentation', 'reference documentation'] },
  { key: 'docs.technical-writing', label: 'Technical writing', domain: 'docs', role: 'docs', synonyms: ['documentation', 'technical documentation', 'developer documentation'] },
  { key: 'finance.budgeting', label: 'Budgeting', domain: 'finance', role: 'finance', synonyms: ['budget planning', 'cost control'] },
  { key: 'finance.modelling', label: 'Financial modelling', domain: 'finance', role: 'finance', synonyms: ['financial modeling', 'forecasting'] },
  { key: 'finance.reporting', label: 'Financial reporting', domain: 'finance', role: 'finance', synonyms: ['accounting', 'bookkeeping'] },
  { key: 'finance.unit-economics', label: 'Unit economics', domain: 'finance', role: 'finance', synonyms: ['cost analysis', 'margin analysis'] },
  { key: 'frontend.accessibility', label: 'Accessibility', domain: 'frontend', role: 'frontend', synonyms: ['a11y', 'wcag'] },
  { key: 'frontend.performance', label: 'Frontend performance', domain: 'frontend', role: 'frontend', synonyms: ['bundle size', 'web vitals', 'core web vitals', 'critical css inlining'] },
  { key: 'frontend.state-management', label: 'State management', domain: 'frontend', role: 'frontend', synonyms: ['client state'] },
  { key: 'frontend.styling', label: 'Styling and layout', domain: 'frontend', role: 'frontend', synonyms: ['css', 'design implementation'] },
  { key: 'frontend.ui-implementation', label: 'UI implementation', domain: 'frontend', role: 'frontend', synonyms: ['frontend development', 'component work'] },
  { key: 'game-development.art', label: 'Game art and shaders', domain: 'game-development', role: 'game-development', synonyms: ['technical art', 'shader programming'] },
  { key: 'game-development.design', label: 'Game design', domain: 'game-development', role: 'game-development', synonyms: ['level design', 'gameplay design'] },
  { key: 'game-development.economy', label: 'Game economy', domain: 'game-development', role: 'game-development', synonyms: ['monetisation', 'monetization'] },
  { key: 'game-development.engine', label: 'Engine programming', domain: 'game-development', role: 'game-development', synonyms: ['unity', 'unreal'] },
  { key: 'game-development.multiplayer', label: 'Multiplayer and networking', domain: 'game-development', role: 'game-development', synonyms: ['netcode'] },
  { key: 'gis.cartography', label: 'Cartography', domain: 'gis', role: 'gis', synonyms: ['map design'] },
  { key: 'gis.data-management', label: 'Spatial data management', domain: 'gis', role: 'gis', synonyms: ['spatial databases', 'geodata'] },
  { key: 'gis.spatial-analysis', label: 'Spatial analysis', domain: 'gis', role: 'gis', synonyms: ['geospatial analysis', 'geoprocessing'] },
  { key: 'gis.web-mapping', label: 'Web mapping', domain: 'gis', role: 'gis', synonyms: ['map services'] },
  { key: 'healthcare.clinical', label: 'Clinical knowledge', domain: 'healthcare', role: 'healthcare', synonyms: ['clinical workflows'] },
  { key: 'healthcare.compliance', label: 'Healthcare compliance', domain: 'healthcare', role: 'healthcare', synonyms: ['hipaa'] },
  { key: 'healthcare.informatics', label: 'Health informatics', domain: 'healthcare', role: 'healthcare', synonyms: ['medical coding', 'ehr'] },
  { key: 'legal.compliance', label: 'Regulatory compliance', domain: 'legal', role: 'legal', synonyms: ['regulatory affairs'] },
  { key: 'legal.contracts', label: 'Contracts', domain: 'legal', role: 'legal', synonyms: ['contract drafting'] },
  { key: 'legal.document-review', label: 'Legal document review', domain: 'legal', role: 'legal', synonyms: ['due diligence'] },
  { key: 'marketing.brand', label: 'Brand', domain: 'marketing', role: 'marketing', synonyms: ['brand strategy', 'brand identity'] },
  { key: 'marketing.content', label: 'Content marketing', domain: 'marketing', role: 'marketing', synonyms: ['copywriting', 'content strategy'] },
  { key: 'marketing.email', label: 'Email marketing', domain: 'marketing', role: 'marketing', synonyms: ['lifecycle email', 'newsletters'] },
  { key: 'marketing.growth', label: 'Growth and conversion', domain: 'marketing', role: 'marketing', synonyms: ['growth marketing', 'conversion optimisation', 'conversion optimization'] },
  { key: 'marketing.seo', label: 'SEO', domain: 'marketing', role: 'marketing', synonyms: ['search engine optimisation', 'search engine optimization'] },
  { key: 'marketing.social-media', label: 'Social media', domain: 'marketing', role: 'marketing', synonyms: ['social strategy', 'community management'] },
  { key: 'marketing.strategy', label: 'Marketing strategy', domain: 'marketing', role: 'marketing', synonyms: ['go to market', 'positioning'] },
  { key: 'mobile.android', label: 'Android', domain: 'mobile', role: 'mobile', synonyms: ['kotlin'] },
  { key: 'mobile.cross-platform', label: 'Cross-platform mobile', domain: 'mobile', role: 'mobile', synonyms: ['react native', 'flutter'] },
  { key: 'mobile.ios', label: 'iOS', domain: 'mobile', role: 'mobile', synonyms: ['swift', 'iphone'] },
  { key: 'operations.ci-cd', label: 'CI and CD', domain: 'operations', role: 'operations', synonyms: ['ci/cd', 'cicd', 'continuous integration', 'build pipelines'] },
  { key: 'operations.deployment', label: 'Deployment', domain: 'operations', role: 'operations', synonyms: ['release engineering', 'rollout'] },
  { key: 'operations.incident-response', label: 'Incident response', domain: 'operations', role: 'operations', synonyms: ['on call', 'incident management'] },
  { key: 'operations.infrastructure', label: 'Infrastructure', domain: 'operations', role: 'operations', synonyms: ['platform engineering', 'infrastructure as code'] },
  { key: 'operations.observability', label: 'Observability', domain: 'operations', role: 'operations', synonyms: ['monitoring', 'tracing', 'logging', 'production monitoring'] },
  { key: 'paid-media.programmatic', label: 'Programmatic advertising', domain: 'paid-media', role: 'marketing', synonyms: ['display advertising'] },
  { key: 'paid-media.search', label: 'Paid search', domain: 'paid-media', role: 'marketing', synonyms: ['ppc', 'search ads'] },
  { key: 'paid-media.social', label: 'Paid social', domain: 'paid-media', role: 'marketing', synonyms: ['social ads'] },
  { key: 'people.onboarding', label: 'Onboarding', domain: 'people', role: 'people', synonyms: ['employee onboarding'] },
  { key: 'people.recruiting', label: 'Recruiting', domain: 'people', role: 'people', synonyms: ['talent acquisition', 'hiring'] },
  { key: 'people.training', label: 'Training', domain: 'people', role: 'people', synonyms: ['learning and development', 'corporate training'] },
  { key: 'planning.coordination', label: 'Coordination', domain: 'planning', role: 'manager', synonyms: ['project coordination'] },
  { key: 'planning.decomposition', label: 'Work decomposition', domain: 'planning', role: 'manager', synonyms: ['task breakdown', 'work breakdown'] },
  { key: 'planning.estimation', label: 'Estimation', domain: 'planning', role: 'manager', synonyms: ['sizing'] },
  { key: 'product.requirements', label: 'Requirements', domain: 'product', role: 'product', synonyms: ['requirements gathering', 'specification'] },
  { key: 'product.roadmapping', label: 'Roadmapping', domain: 'product', role: 'product', synonyms: ['prioritisation', 'prioritization'] },
  { key: 'product.user-research', label: 'User research', domain: 'product', role: 'product', synonyms: ['customer discovery'] },
  { key: 'project-management.agile', label: 'Agile delivery', domain: 'project-management', role: 'project-management', synonyms: ['scrum', 'sprint planning'] },
  { key: 'project-management.delivery', label: 'Delivery management', domain: 'project-management', role: 'project-management', synonyms: ['programme management', 'program management'] },
  { key: 'project-management.risk', label: 'Risk management', domain: 'project-management', role: 'project-management', synonyms: ['risk register'] },
  { key: 'project-management.stakeholders', label: 'Stakeholder management', domain: 'project-management', role: 'project-management', synonyms: ['stakeholder communication'] },
  { key: 'qa.exploratory', label: 'Exploratory testing', domain: 'qa', role: 'qa', synonyms: ['manual testing'] },
  { key: 'qa.load-testing', label: 'Load testing', domain: 'qa', role: 'qa', synonyms: ['performance testing', 'stress testing'] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'qa', synonyms: ['automated testing', 'e2e testing', 'end-to-end testing', 'unit testing'] },
  { key: 'qa.test-strategy', label: 'Test strategy', domain: 'qa', role: 'qa', synonyms: ['quality strategy'] },
  { key: 'research.academic', label: 'Literature review', domain: 'research', role: 'research', synonyms: ['literature search'] },
  { key: 'research.competitive', label: 'Competitive analysis', domain: 'research', role: 'research', synonyms: ['competitor analysis', 'competitive intelligence'] },
  { key: 'research.desk', label: 'Desk research', domain: 'research', role: 'research', synonyms: ['secondary research', 'research synthesis'] },
  { key: 'research.market', label: 'Market research', domain: 'research', role: 'research', synonyms: ['market analysis', 'market sizing'] },
  { key: 'review.code-review', label: 'Code review', domain: 'review', role: 'reviewer', synonyms: ['peer review', 'diff review', 'pull request review'] },
  { key: 'review.release-readiness', label: 'Release readiness', domain: 'review', role: 'reviewer', synonyms: ['go no go', 'release review'] },
  { key: 'sales.account-management', label: 'Account management', domain: 'sales', role: 'sales', synonyms: ['customer accounts', 'renewals'] },
  { key: 'sales.enablement', label: 'Sales enablement', domain: 'sales', role: 'sales', synonyms: ['sales playbook', 'objection handling'] },
  { key: 'sales.outbound', label: 'Outbound sales', domain: 'sales', role: 'sales', synonyms: ['prospecting', 'outreach'] },
  { key: 'sales.pricing', label: 'Pricing and packaging', domain: 'sales', role: 'sales', synonyms: ['pricing strategy'] },
  { key: 'sales.strategy', label: 'Sales strategy', domain: 'sales', role: 'sales', synonyms: ['sales planning', 'pipeline strategy'] },
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: ['appsec', 'secure code review', 'application security engineering'] },
  { key: 'security.authentication', label: 'Authentication and authorization', domain: 'security', role: 'security', synonyms: ['authn', 'authz', 'access control'] },
  { key: 'security.compliance', label: 'Security compliance', domain: 'security', role: 'security', synonyms: ['soc 2', 'audit readiness', 'compliance automation'] },
  { key: 'security.dependency-audit', label: 'Dependency auditing', domain: 'security', role: 'security', synonyms: ['supply chain security', 'sca', 'dependency scanning'] },
  { key: 'security.privacy', label: 'Data privacy', domain: 'security', role: 'security', synonyms: ['gdpr', 'privacy engineering'] },
  { key: 'security.secrets', label: 'Secrets and credentials', domain: 'security', role: 'security', synonyms: ['credential management', 'key management', 'secrets management'] },
  { key: 'security.threat-modelling', label: 'Threat modelling', domain: 'security', role: 'security', synonyms: ['threat modeling', 'attack surface review'] },
  { key: 'spatial-computing.3d-interaction', label: '3D interaction', domain: 'spatial-computing', role: 'spatial-computing', synonyms: ['spatial interfaces'] },
  { key: 'spatial-computing.xr', label: 'AR and VR', domain: 'spatial-computing', role: 'spatial-computing', synonyms: ['augmented reality', 'virtual reality', 'mixed reality'] },
  { key: 'support.customer', label: 'Customer support', domain: 'support', role: 'support', synonyms: ['helpdesk', 'customer service'] },
  { key: 'support.knowledge-base', label: 'Knowledge base', domain: 'support', role: 'support', synonyms: ['help centre', 'help center'] },
  { key: 'support.success', label: 'Customer success', domain: 'support', role: 'support', synonyms: ['customer onboarding', 'retention'] },
]
