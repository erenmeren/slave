import {
  EXTERNAL_TEXT_MAX_CHARS,
  fenceExternalBlock,
  sanitiseExternalText,
} from '../external/fence.js'
import { neutraliseMarkers } from '../run-context/markers.js'
import { INTAKE_PROMPT_MESSAGES_MAX, INTAKE_TEXT_MAX_CHARS, type IntakeRole } from './constants.js'
import type { IntakeFacts } from './facts.js'

/**
 * The literal the model's answer must be keyed on, the parser reads back
 * ({@link parseIntakeAnswer}) and the fake CLI keys its arm on
 * (`packages/providers/test/fake-claude.mjs`) -- the same three-way contract
 * `"candidateIndex"` has carried since M38.
 */
export const INTAKE_ANSWER_MARKER = '"intakeAnswer"'

/** Who said a line, as the model reads it. `FOUND` and not `SYSTEM`: a fact row is a measurement
 *  this tree made, and a model that read it as an instruction from the platform would treat a
 *  missing verify command as permission to invent one. */
const SPEAKER: Record<IntakeRole, string> = {
  human: 'PERSON',
  assistant: 'YOU',
  fact: 'FOUND',
}

/**
 * Every string in the facts, made safe to quote.
 *
 * `fenceExternalBlock` does not sanitise -- its contract is that every line handed to it is
 * already this system's own words or has been through `sanitiseExternalText` -- and the facts are
 * NOT all ours: the paths come from what a person typed, and the catalogue names come from persona
 * files somebody imported from a third party. So each string goes through the sanitiser
 * individually, before the object is serialised, rather than the serialised JSON going through it
 * afterwards: truncating a JSON document at a code-point budget produces a document that will not
 * parse, and the sanitiser's ellipsis would land in the middle of a key.
 */
function safeFacts(facts: IntakeFacts): IntakeFacts {
  const clean = (value: string): string => sanitiseExternalText(value, EXTERNAL_TEXT_MAX_CHARS)
  return {
    paths: facts.paths.map((path) => ({
      ...path,
      path: clean(path.path),
      branches: path.branches.map(clean),
      defaultBranch: path.defaultBranch === null ? null : clean(path.defaultBranch),
      verify: path.verify.map((finding) => ({ command: clean(finding.command), source: clean(finding.source) })),
    })),
    reposRoot: clean(facts.reposRoot),
    existingCompanies: facts.existingCompanies.map((company) => ({ id: company.id, name: clean(company.name) })),
    catalogue: facts.catalogue.map((entry) => ({
      templateId: entry.templateId,
      name: clean(entry.name),
      division: entry.division === null ? null : clean(entry.division),
      role: clean(entry.role),
    })),
  }
}

/**
 * The one prompt an intake model call ever sends (M59 R14).
 *
 * It asks the model to CHOOSE among facts or to ask one more question, and it never asks it to
 * discover anything: the paths, the branches and the verify commands in the fenced block are
 * measurements, the fence says in the prompt itself that they are data, and
 * {@link parseIntakeAnswer} refuses a command that is not among them. That is decision D6 written
 * as a prompt rather than as a hope.
 *
 * The WHOLE prompt goes through `neutraliseMarkers`, `buildDecisionPrompt`'s own rule: a person's
 * message and a persona's name are both text this system did not write, and neither may be able to
 * close a `<slave-ask>`/`<slave-answer>` block.
 */
export function buildIntakePrompt(input: {
  readonly transcript: readonly { readonly role: IntakeRole; readonly text: string }[]
  readonly facts: IntakeFacts | null
  readonly callsLeft: number
}): string {
  const { transcript, facts, callsLeft } = input
  const recent = transcript.slice(-INTAKE_PROMPT_MESSAGES_MAX)

  const blocks: string[] = [
    'You are helping somebody start a software project on this system. They may know exactly what',
    'they want, or they may only have an idea. Your job is to end up with one project definition:',
    'a name, a goal, a repository, a base branch, the commands that decide when a task is done, an',
    'optional budget and provider, and an optional team chosen from the catalogue below.',
    '',
    'YOU DO NOT DISCOVER ANYTHING. Every path, branch and verify command you may use is in the',
    'FACTS block below, put there by this system reading the filesystem. A command that is not',
    'there is one you may only ASK about -- an answer that names one is discarded and shown to the',
    'person as a question instead.',
    '',
    'Write in the language the person wrote in.',
    '',
    'CONVERSATION SO FAR',
  ]

  for (const line of recent) {
    blocks.push(`${SPEAKER[line.role]}: ${line.text.slice(0, INTAKE_TEXT_MAX_CHARS)}`)
  }

  blocks.push('', 'FACTS')
  blocks.push(
    facts === null
      ? 'nothing has been detected yet -- no path has been named in this conversation.'
      : fenceExternalBlock([JSON.stringify(safeFacts(facts))]),
  )

  blocks.push(
    '',
    `You have ${String(callsLeft)} turn(s) left in this conversation. When you have enough to`,
    'propose a project, propose it -- do not keep asking.',
    '',
    'Reply with exactly one JSON object and nothing else on its line, in one of these two shapes:',
    `{${INTAKE_ANSWER_MARKER}: {"kind": "ask", "text": "<one question, in their language>"}}`,
    `{${INTAKE_ANSWER_MARKER}: {"kind": "draft", "text": "<one sentence>", "draft": {`,
    '  "name": "<1-80 characters>", "goal": "<what the project is for>",',
    '  "repo": {"mode": "existing", "path": "<a path from FACTS>"}',
    '         | {"mode": "new", "path": null},',
    '  "baseBranch": "<a branch from FACTS, or main for a new repository>",',
    '  "verifyCommands": [{"command": "<exactly as FACTS spells it>", "source": "detected"}],',
    '  "setupCommands": [], "budgetUsd": <number or null>,',
    '  "provider": "claude_code" | "cursor" | null,',
    '  "team": [{"templateId": "<from the catalogue>", "runtimeRoles": ["backend"]}]',
    '}}}',
    '',
    'A verify command may be "source": "detected" only if FACTS carries that exact string, and',
    '"source": "draft" only when the repository does not exist yet. Never write "source":',
    '"operator" -- that means a person typed it, and you are not a person.',
  )

  return neutraliseMarkers(blocks.join('\n'))
}
