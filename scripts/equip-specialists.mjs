// Gives personas their default skills from scripts/skill-bundles.json.
//
// A persona gets the bundles of its division plus any named for it; each bundle is a list of
// catalogued skills (`<provider>/<name>`). The write is `changeTemplateSkills` with `add` only, so
// a run never removes a link -- one made by hand on a card stays -- and a second run adds nothing.
//
// DRY RUN BY DEFAULT: it prints what it would add and writes nothing. `--apply` writes. Every
// persona and skill named in the file must exist before anything is written: a typo is a refusal,
// not a persona silently left bare.
//
//   npm run equip:specialists              # dry run
//   npm run equip:specialists -- --apply   # write
//   npm run equip:specialists -- --report out.md
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { changeTemplateSkills, refusalText } from '../packages/control/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const BUNDLES_FILE = join(dirname(import.meta.filename), 'skill-bundles.json')

function parseArgs(argv) {
  const args = { apply: false, report: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') args.apply = true
    else if (arg === '--report') args.report = argv[++i] ?? null
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/** Which bundles each persona gets, and the skill refs they expand to. Pure: no database. */
export function planBundles(config, templates) {
  const problems = []
  for (const [bundle, refs] of Object.entries(config.bundles)) {
    if (!Array.isArray(refs) || refs.length === 0) problems.push(`bundle "${bundle}" is empty`)
  }
  const known = (bundle, where) => {
    if (config.bundles[bundle] === undefined) problems.push(`${where} names unknown bundle "${bundle}"`)
  }
  for (const [division, bundles] of Object.entries(config.divisions)) bundles.forEach((b) => known(b, `division "${division}"`))
  for (const [persona, bundles] of Object.entries(config.personas)) bundles.forEach((b) => known(b, `persona "${persona}"`))
  const names = new Set(templates.map((template) => template.name))
  for (const persona of Object.keys(config.personas)) {
    if (!names.has(persona)) problems.push(`persona "${persona}" is not in the catalog`)
  }

  const plan = []
  for (const template of templates) {
    const bundles = [
      ...new Set([...(config.divisions[template.sourceDivision ?? ''] ?? []), ...(config.personas[template.name] ?? [])]),
    ]
    if (bundles.length === 0) continue
    const refs = [...new Set(bundles.flatMap((bundle) => config.bundles[bundle] ?? []))]
    plan.push({ template, bundles, refs })
  }
  return { plan, problems }
}

function splitRef(ref) {
  const slash = ref.indexOf('/')
  return slash <= 0 ? null : { provider: ref.slice(0, slash), name: ref.slice(slash + 1) }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write('usage: equip-specialists [--apply] [--report <file.md>]\n')
    return 0
  }
  const config = JSON.parse(readFileSync(BUNDLES_FILE, 'utf8'))
  const templates = await prisma.slaveTemplate.findMany({
    select: { id: true, name: true, sourceDivision: true, defaultSkills: { select: { skillId: true } } },
    orderBy: [{ sourceDivision: 'asc' }, { name: 'asc' }],
  })
  const { plan, problems } = planBundles(config, templates)

  const skills = await prisma.skill.findMany({ select: { id: true, name: true, missingSince: true, provider: { select: { name: true } } } })
  const skillIdOf = new Map()
  for (const skill of skills) {
    if (skill.missingSince === null) skillIdOf.set(`${skill.provider.name}/${skill.name}`, skill.id)
  }
  for (const ref of new Set(Object.values(config.bundles).flat())) {
    if (splitRef(ref) === null) problems.push(`"${ref}" is not <provider>/<name>`)
    else if (!skillIdOf.has(ref)) problems.push(`skill "${ref}" is not in the catalog (or is missing on disk) -- run \`orchestrator skills sync\``)
  }
  if (problems.length > 0) {
    process.stderr.write(`refused, nothing written:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`)
    return 1
  }

  const lines = ['| Persona | Division | Bundles | Adds | Total after |', '|---|---|---|---|---|']
  let totalAdds = 0
  const writes = []
  for (const { template, bundles, refs } of plan) {
    const have = new Set(template.defaultSkills.map((row) => row.skillId))
    const add = refs.filter((ref) => !have.has(skillIdOf.get(ref)))
    totalAdds += add.length
    const after = new Set([...have, ...refs.map((ref) => skillIdOf.get(ref))]).size
    lines.push(`| ${template.name} | ${template.sourceDivision ?? ''} | ${bundles.join(', ')} | ${add.length} | ${after} |`)
    if (add.length > 0) writes.push({ template, add })
  }
  const summary = `${plan.length} persona(s), ${totalAdds} new link(s)${args.apply ? '' : ' (dry run: nothing written)'}`
  const table = `${lines.join('\n')}\n\n${summary}\n`
  process.stdout.write(table)
  if (args.report !== null) {
    const bundleList = Object.entries(config.bundles)
      .map(([bundle, refs]) => `- **${bundle}**: ${refs.join(', ')}`)
      .join('\n')
    writeFileSync(args.report, `# Skill bundles\n\n${bundleList}\n\n# Personas\n\n${table}`)
  }
  if (!args.apply) return 0

  for (const { template, add } of writes) {
    const result = await changeTemplateSkills(template.id, { add: add.map((ref) => skillIdOf.get(ref)) })
    if (!result.ok) {
      process.stderr.write(`${template.name}: ${refusalText(result.error)}\n`)
      return 1
    }
  }
  process.stdout.write(`applied: ${writes.length} persona(s) changed\n`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.filename === realpathSync(resolve(process.argv[1]))) {
  main()
    .then(async (code) => {
      await prisma.$disconnect()
      process.exit(code)
    })
    .catch(async (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      await prisma.$disconnect()
      process.exit(1)
    })
}
