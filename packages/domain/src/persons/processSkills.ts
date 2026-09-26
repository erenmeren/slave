/**
 * Process-management skills (workforce cards spec §4, finding F9).
 *
 * A worker that loads one of these runs a whole development process -- brainstorm, write a plan,
 * dispatch helpers, review rounds -- inside ONE task instead of doing the task. Nothing here
 * blocks: the card marks the chip and the picker asks for a confirm, and the operator decides.
 *
 * Names are compared BARE (whatever follows the last `:`) and lower-cased, because a plugin's skill
 * can reach the catalogue as `superpowers:brainstorming` as easily as `brainstorming`.
 */
export const PROCESS_SKILL_NAMES: readonly string[] = [
  'brainstorming',
  'writing-plans',
  'executing-plans',
  'subagent-driven-development',
  'dispatching-parallel-agents',
  'using-git-worktrees',
  'finishing-a-development-branch',
  'requesting-code-review',
  'receiving-code-review',
  'using-superpowers',
]

/** Every skill from these providers counts, whatever it is called: the superpowers plugin IS a
 *  process, skill by skill. */
export const PROCESS_SKILL_PROVIDERS: readonly string[] = ['plugin:superpowers']

/** The one sentence the chip's tooltip and the picker's confirm both say. */
export const PROCESS_SKILL_WARNING = 'Process skill: can make a worker plan and delegate instead of doing its task.'

/** Matches the BARE name, case-insensitively, after any plugin prefix, so the warning follows a
 *  process skill wherever it is linked -- a personal copy, a project copy, or a plugin's own name. */
export function isProcessSkill(skill: { readonly name: string; readonly providerName: string }): boolean {
  if (PROCESS_SKILL_PROVIDERS.includes(skill.providerName)) return true
  const bare = (skill.name.split(':').at(-1) ?? '').trim().toLowerCase()
  return PROCESS_SKILL_NAMES.includes(bare)
}

/** Where a skill came from, as a card marks it: a plugin (named), or the operator's own disk. */
export type SkillSource = { readonly kind: 'local' } | { readonly kind: 'plugin'; readonly plugin: string }

const PLUGIN_PREFIX = 'plugin:'

/** `plugin:<name>` is a plugin; `personal`, `project` and any provider this build does not know are
 *  local -- the honest reading of a name that says nothing about a plugin. A bare `plugin:` names
 *  no plugin, so it is local too. */
export function skillSourceOf(providerName: string): SkillSource {
  return providerName.startsWith(PLUGIN_PREFIX) && providerName.length > PLUGIN_PREFIX.length
    ? { kind: 'plugin', plugin: providerName.slice(PLUGIN_PREFIX.length) }
    : { kind: 'local' }
}
