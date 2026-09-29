# Conductor, Plan 5 of 5: one report per goal version

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec R10: every conducted goal version has one report, as a web page and a byte-stable Markdown export, carrying the requirement table (key, text, status, a link to the check and its output), the packages with their seats and the files each touched, spend against budget, and the decision trail (size decision, staffing, questions answered, reworks and why). When a version comes to rest, the Supervisor chat gets the report's summary. This also covers the rest of spec §6's web line ("the goal-version report page; Markdown export route").

**Architecture:** The report is computed when someone reads it, from rows that are already recorded, and nothing is stored as a report. `packages/control/src/goalReport.ts` (`loadGoalReport`) reads the rows Plans 2–4b wrote (`RequirementSet`, `GoalDelivery`, `WorkPackage` and its tasks and seats, `RunReport`, `VerificationResult` and its verification runs, `ConductorCall`, `SupervisorDecision`, `SlaveMessage`, and the version's events) into one plain `GoalReport` value. No model is called and no git command runs. Pure domain functions in `packages/domain/src/goalReport/` turn that value into the things people read: `reportCaveats` (what the report cannot vouch for), `renderGoalReportMarkdown` (the export) and `goalReportSummary` (the chat note). Only one new fact is recorded: the merge pass writes git's list of the files a package's merge changed onto its `task.done` event. An orchestrator pass posts one chat note each time a version comes to rest. Each note is keyed so it is posted once.

**Tech Stack:** TypeScript monorepo (npm workspaces, ESM, `.js` import suffixes), Prisma/Postgres, vitest (+ jsdom and Testing Library for web components), Next.js app router (`apps/web`), git (only in the merge pass).

**Spec:** `docs/superpowers/specs/2026-09-27-conductor-supervisor-design.md` (R10; §6 "Web: the goal-version report page; Markdown export route"; §7 "End to end with the fake CLI: a `single` goal and a two-package goal each reach `accepted` with a report"). **Requires Plans 1–4b** (merged on main at adadb3df). This is the last conductor plan.

## Decisions this plan makes (read before starting)

- **D1. The report is computed on read, from recorded rows only. There is no report table and no snapshot.** `loadGoalReport(workspaceId, goalVersion)` returns a `GoalReport` for every state a version can be in, and for a version that has requirements but has not been conducted yet. Anything that is not recorded appears as a stated gap (D8), never as a guess. *Cost if wrong:* a report of an old version can change after the fact. That happens only in the project-wide spend line (the project keeps spending) and in seat names (a person can be renamed). Every version-scoped fact is append-only.
- **D2. A version's state is derived from its `GoalDelivery`, and `merged` is a state of its own.** The states are: `not_conducted` (no delivery row), `integrating`, `verifying`, `accepted` (verified, waiting to be merged), `merged` (`mergedAt` set), `needs_human`, and `abandoned`. Who merged it comes from the `workspace.goal_merged` event (`by`, `commit`, `into`). A hand merge whose commit is not the verified commit is flagged: the tree that landed was not itself verified. *Cost if wrong:* none. Reading a new status later is one entry in a switch.
- **D3. The files a package touched are recorded by git when the package merges into the integration branch. They are not the worker's claim.** After the `--no-ff` merge, the merge pass lists `git diff --name-only -z HEAD^1 HEAD` in the integration worktree onto that merge's `task.done` event. The fields are `files` (at most `GOAL_REPORT_FILES_MAX` = 500) and `filesTotal`, both optional, so older rows still parse. The report shows the union over every merge of the package, and the worker's own `filesTouched` beside it, labelled as reported. A package merged before this plan shows "not recorded" plus the worker's list (D8). *Cost if wrong:* one `git diff` per package merge.
- **D4. A requirement's status is the latest verification round's verdict.** For each round, the rows of the run that wrote last count, which is the same rule as `latestVerifications`. Each requirement also carries its status in every round, and the package that owns it. Before any round the status reads "not verified yet". If packages are being reworked after a round, the report says those verdicts may change (D8). *Cost if wrong:* a reader who wants a verdict per commit reads the rounds table, which names the commit each round checked (`SlaveRun.verificationTip`).
- **D5. Version spend = the version's package runs + its verification runs + its conductor calls + the Supervisor decisions about it. The project figure is `workspaceSpend`.** Runs are summed on measured cost, and a run with no cost is counted, not summed: unmeasured if it has finished, still going if it has not. This is `sumSpend`'s rule. An unmeasured conductor call is charged at `CONDUCT_PER_CALL_CAP_USD`. An unmeasured Supervisor decision (`modelCalled && modelCostUsd == null`) is charged at `SUPERVISOR_PER_CALL_CAP_USD`. Those are `workspaceSpend`'s rules. "About the version" means `subjectId` equals `<ws>:v<n>`, starts with `<ws>:v<n>:`, or is one of the version's task ids or question ids. Matching the exact prefix keeps v1 from counting v10's decisions. The project line is `workspaceSpend(...).spentUsd` against `Workspace.budgetUsd`: the one spend formula, the same figure the budget guardrail uses. The Supervisor conversation and the intake are project-wide, and the report says so. *Cost if wrong:* a Supervisor decision about a seat rather than a task is left out of the version's figure. It stays in the project figure.
- **D6. The decision trail is a list of entries built from recorded rows, in order.** Sources: the version's events (task events of its package tasks, the workspace goal events carrying `payload.version = n`, and the goal pass's `merge_failure` trips whose detail starts with `goal v<n> `); failed `ConductorCall` rows; and Supervisor decisions about the version (D5's rule, minus the conduct decision itself). Events are ordered by `seq`. Calls and decisions are merged in by time, and events come first on a tie. Each entry is a sentence Slave composes from ids, keys and counts, plus an optional quoted `detail` (a rationale, a rework reason, a question) that is labelled with who wrote it: Slave, the model, or a person. Staffing is one entry after the size decision, naming the current seat of each package and the verifier. Questions (every `question` on the version's package tasks, with the first answer) get their own list. The trail keeps the newest `GOAL_REPORT_TRAIL_MAX` (1000) entries and says how many older ones it dropped. *Cost if wrong:* staffing shows who holds each package now, not who held it then. A hire's `org.changed` event carries no package, so "who held it then" is not recorded.
- **D7. The Markdown is deterministic and inert.** `renderGoalReportMarkdown(report)` never reads a clock: "as of" is the newest timestamp among the facts. It uses fixed section order, the input's own ordering (the loader sorts with plain `<` comparisons), ISO UTC timestamps, `\n` line endings, one final newline, and money through one formatter (`formatReportUsd`, the rules of the web's `formatUsd`). Every piece of text a person or a model wrote goes through `sanitisePersonText`, which neutralises protocol markers and routing literals. Inline text is then HTML-escaped (`& < >`), has backslash-escaped Markdown punctuation (`` \ ` * _ [ ] | ~ # ! ( ) ``) and collapsed whitespace, so a table row cannot be broken. Block text (a check, an output, a goal) goes in a fence longer than any run of backticks inside it. The web page renders every value as a JSX child and never uses `dangerouslySetInnerHTML`. *Cost if wrong:* a Markdown reader shows a backslash before punctuation in an unusual renderer.
- **D8. The report states what it does not know, in one list shared by the page and the export (`reportCaveats`).** The list covers: requirements not extracted yet; version not conducted yet; the conductor's default fallback to single; no round run yet; verdicts that predate rework in progress; unverifiable requirements (they block acceptance); trimmed evidence (the `… [N characters cut] …` marker `trimEvidence` writes); a hand merge that landed an unverified tree; abandoned; unmeasured or still-running runs; files not recorded or cut; trail entries dropped.
- **D9. The page lives at `/w/:id/goals/:version`, in both modes, and is not a tab.** `TABS` stays as it is (`docs/ia.md` rule 2). Three places reach it: the Team page's Goal stat (`vN · Report · Edit goal`, linking to the latest version that has a report), the chat note's link, and the page's own version links. The breadcrumb reads `Projects / <project> / Goal report`. The export is `GET /api/w/:id/goals/:version/report?format=markdown` (`text/markdown`, downloaded as `goal-v<n>-report.md`). Without `format` the same route returns the report as JSON. A version that is not a whole number gets 400; an unknown workspace or version gets 404 through `refusalStatus`. The CLI gets `goal-report --workspace <id> [--version <n>] [--json]`, which prints the Markdown. *Cost if wrong:* the Settings goal history does not link reports (a one-line follow-up).
- **D10. The chat note is a Supervisor message no model wrote, posted once each time a version comes to rest.** A version is at rest when it has been **merged**, is **needs_human** (once per round: a version stops at most once per round, per Plan 4b), has been **abandoned**, or is **accepted and waiting for a person**. That last case means `autoMerge` is off, a `mergeError` exists, or there is a goal-pass trip starting `goal v<n> is accepted` newer than `acceptedAt`. The trigger is the delivery's state, not an event scan: `GoalDelivery.reportNotedKey` holds the rest key the last note was posted for, and a new key means a new note. `SupervisorMessage.noteKey` (unique per workspace, `goal-report:v<n>:<key>`) makes a crash between the note and the stamp harmless. The migration backfills `reportNotedKey` for every delivery already at rest, so an upgrade posts nothing for past versions. The note has no model call (`modelCostUsd` null, `unmeasured` false), so spend is unchanged. It is posted while the workspace is halted and never for an archived one. The panel shows it as a Supervisor bubble with a link (`goalReportVersion`). *Cost if wrong:* an extra bubble per stop.
- **D11. The conversation has no thread per goal.** Threads are local calendar days (`supervisorThreads.ts`, M57 R9). The spec's "thread for the goal" is read as "the conversation, at the moment the goal comes to rest": the note is the last word about the version in that day's thread. The model's later chat turns see the note in their history as something the Supervisor said. It is system-composed and factual, and `chatPrompt` already defuses history text. *Cost if wrong:* a goal-scoped thread would be a panel redesign, and nothing here rules one out.
- **Left out on purpose:**
  - A verification abandoned or cancelled during its setup window (pid null) still spawns and leaks its `verify-*` checkout. That deferred Plan 4b item sits in `dispatchVerification`, not in anything this plan touches, and fixing it needs its own test of the spawn race.
  - A per-version budget. Budgets are per project, and a per-version budget is post-pilot product work (the `quality-and-budget` note).
  - Links from the Settings goal history.
  - A frozen report snapshot at acceptance (D1).
  - Re-verifying after the final merge (Plan 4a D9).
  - The m54/m55 pinned counts (they stay frozen and red, as before).
  - The rest of Plan 4b's minor backlog.

## Global Constraints

- Vocabulary: the product says "slave", never "agent" (`node scripts/gate-m26-vocabulary.mjs`). Never write the string "agency-agents" anywhere tracked.
- Never run prettier (no config in the repo). Match surrounding code: WHY doc comments, `readonly`, explicit return types, `.js` import suffixes (not in `apps/web`, which imports without them), `Result`/`ok`/`err`.
- Tests: `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL` in the shell first. ONE vitest process at a time. Iterate per file. A test that imports another workspace package reads that package's `dist`, so run `npx tsc --build` after changing a package another package's test imports. Run `npm run typecheck` (not `tsc --build` alone: it also checks every `tsconfig.test.json` and `apps/web`) before every commit. Run the whole suite once, at the end, in the background.
- `apps/web` changes gate on `npm run web:build`, with no `next dev` running, then `rm -rf apps/web/.next`.
- Never touch the dev DB. Never `db:seed`. Gates run only on `DATABASE_URL="$GATE_DATABASE_URL"`, with the fake-CLI env exactly as `.github/workflows/ci.yml` sets it (`SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CURSOR_BIN` from `scripts/gate-fakes`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`), under `systemd-inhibit --what=sleep:idle`. Red on main today, not regressions: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58.
- Migrations: hand-written, purely additive, WHY header, dated name; `npm run db:generate && npm run db:migrate:test`.
- Inside a Prisma interactive transaction a refusal must THROW to roll back; a returned value commits what was written.
- `vi.spyOn` on a Prisma delegate breaks later tests: assign a wrapper and restore it in `finally`.
- Never `TRUNCATE "SlaveTemplate" CASCADE` in a test. Use file-unique template names and delete your own template rows by id.
- The hook plane (`scripts/pause-gate.sh`, `scripts/cursor-shell-gate.sh`, `scripts/tool-result-tap.sh`, `scripts/lib/pause-flag.sh`, `scripts/lib/permissions.sh`) does not change. This plan adds no event type and no situation kind, so m56a's stage-12 counts (24 situations, 73 lanes) and goldens stay as they are.
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec R10 verbatim: "One report per goal version. A page (web) and a Markdown export: the requirement table (key, text, status, evidence link: the check and its output), the packages and their owners, the files each touched, spend against budget, and the decision trail (the size decision, staffing, questions answered, reworks and why). The Supervisor chat's thread for the goal ends with the report's summary."

## Review Focus

- A requirement, check, output, reason, package title or question contains `<script>`, a `</slave-verification>` marker, a ``` fence or a `|`. In the Markdown it must stay text: no raw tag, no forged marker, no broken table row, no closed fence. On the page it must render as characters. Tests: Task 1 and Task 6.
- Goal v1 next to goal v10. Neither version's spend, trail, trips or decisions may include the other's (the `<ws>:v1` prefix also matches `<ws>:v10`). Test: Task 3.
- A version merged by a person onto a base branch that moved. The report and the note must say the landed tree was not itself verified, never "verified and merged". Tests: Task 1 (caveat), Task 4 (loader), Task 7 (summary).
- The daemon upgraded onto a database with finished versions, and the daemon dying between posting a note and stamping the delivery. No flood of notes for past versions and no duplicate note: the backfill and the unique `noteKey`. Test: Task 7.
- A report asked for on a planned project, for a version that does not exist, or with `--version abc` / `/goals/abc`. Each gets a sentence and a 404/400/non-zero exit, never a 500 or a stack trace. Test: Task 5.

---

### Task 1: The report's shape, what it cannot vouch for, and its Markdown (domain)

**Files:**
- Create: `packages/domain/src/goalReport/constants.ts`, `packages/domain/src/goalReport/types.ts`, `packages/domain/src/goalReport/escape.ts`, `packages/domain/src/goalReport/caveats.ts`, `packages/domain/src/goalReport/markdown.ts`, `packages/domain/src/goalReport/index.ts`
- Modify: `packages/domain/src/index.ts` (add `export * from './goalReport/index.js'` after the `conduct` line)
- Test: `packages/domain/test/goalReport/markdown.test.ts`, `packages/domain/test/goalReport/caveats.test.ts`, `packages/domain/test/goalReport/escape.test.ts`

**Interfaces:**
- Consumes: `sanitisePersonText` (`../handoff/contract.js`).
- Produces (all exported from `@slave-of-ai/domain`):
  - constants `GOAL_REPORT_FILES_MAX = 500`, `GOAL_REPORT_TRAIL_MAX = 1000`, `GOAL_REPORT_DETAIL_MAX_CHARS = 6000`, `GOAL_REPORT_SUMMARY_MAX_CHARS = 1500`, `GOAL_REPORT_NOTE_KEY_PREFIX = 'goal-report:'`
  - `GOAL_REPORT_STATES`, `type GoalReportState`, `type GoalReportVerdictStatus`, `GoalReportVerdict`, `GoalReportRequirement`, `GoalReportRound`, `GoalReportWorkerReport`, `GoalReportPackage`, `GoalReportDelivery`, `GoalReportDecision`, `GoalReportQuestion`, `GoalReportSpend`, `type GoalReportAuthor`, `GoalReportTrailEntry`, `GoalReport` (exact shapes in Step 3)
  - `mdInline(text: string): string`, `mdFence(text: string): string`, `mdQuote(text: string): readonly string[]`, `evidenceCut(text: string): number`, `evidenceAnchor(key: string): string`, `formatReportUsd(value: number | null): string`, `shortCommit(sha: string | null): string`
  - `GOAL_REPORT_STATE_LABEL: Readonly<Record<GoalReportState, string>>`, `reportCaveats(report: GoalReport): readonly string[]`
  - `renderGoalReportMarkdown(report: GoalReport): string`

- [ ] **Step 1: The failing tests.** A shared builder at the top of `markdown.test.ts`. `caveats.test.ts` repeats it verbatim (a test file must not import another test file):

```ts
import { describe, expect, it } from 'vitest'
import { renderGoalReportMarkdown } from '../../src/goalReport/markdown.js'
import type { GoalReport, GoalReportPackage, GoalReportRequirement } from '../../src/goalReport/types.js'

function requirement(over: Partial<GoalReportRequirement> = {}): GoalReportRequirement {
  return {
    key: 'R1',
    text: 'hsql --format csv prints CSV',
    source: 'Add a CSV output mode.',
    packageKey: 'report',
    verdict: { round: 1, runId: 'run-v1', status: 'pass', check: 'hsql --format csv q.sql', output: 'a,b\n1,2', reason: '' },
    history: [{ round: 1, status: 'pass' }],
    ...over,
  }
}

function pkg(over: Partial<GoalReportPackage> = {}): GoalReportPackage {
  return {
    key: 'report',
    title: 'CSV report mode',
    isIntegration: false,
    requirementKeys: ['R1'],
    ownedPaths: ['src/report/**'],
    dependsOn: [],
    persona: 'Backend Engineer',
    seat: 'Alex',
    taskId: 't1',
    taskStatus: 'done',
    integrated: true,
    mergedFiles: ['src/report/csv.py'],
    mergedFilesTruncated: false,
    reportedFiles: ['src/report/csv.py'],
    report: { runId: 'run-i1', requirements: [{ key: 'R1', status: 'done', evidence: 'pytest -k csv' }], workflowDone: 3, workflowTotal: 4 },
    implementationRuns: 1,
    ...over,
  }
}

function report(over: Partial<GoalReport> = {}): GoalReport {
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Harlequin',
    goalVersion: 2,
    versions: [1, 2],
    goal: 'Add a CSV output mode.',
    state: 'merged',
    delivery: {
      integrationBranch: 'slaveofai/goal-v2-ws-1',
      baseBranch: 'main',
      baseCommit: 'b'.repeat(40),
      verifiedCommit: 'c'.repeat(40),
      round: 1,
      roundBase: 0,
      roundCap: 3,
      acceptedAt: '2026-09-29T10:05:00.000Z',
      mergedAt: '2026-09-29T10:06:00.000Z',
      merge: { by: 'system', commit: 'c'.repeat(40), into: 'main' },
      mergeError: null,
      needsHumanReason: null,
      abandonedAt: null,
    },
    decision: { mode: 'single', reason: 'fits one session', decidedBy: 'model', fallback: false, at: '2026-09-29T10:00:00.000Z' },
    requirements: [requirement()],
    rounds: [{ round: 1, runId: 'run-v1', verifier: 'Sam', commit: 'c'.repeat(40), at: '2026-09-29T10:04:00.000Z', pass: 1, fail: 0, unverifiable: 0 }],
    packages: [pkg()],
    verifier: 'Sam',
    questions: [],
    spend: {
      runsMeasuredUsd: 3.9,
      runsUnmeasured: 0,
      runsLive: 0,
      conductorMeasuredUsd: 0.2,
      conductorUnmeasuredCalls: 0,
      supervisorMeasuredUsd: 0.02,
      supervisorUnmeasuredCalls: 0,
      versionUsd: 4.12,
      projectSpentUsd: 12.4,
      projectBudgetUsd: 20,
    },
    trail: [{ at: '2026-09-29T10:00:00.000Z', text: 'Size decision: one package does the whole goal.', detail: 'fits one session', detailBy: 'model', packageKey: null }],
    trailOmitted: 0,
    asOf: '2026-09-29T10:06:00.000Z',
    ...over,
  }
}
```

`markdown.test.ts` cases:

```ts
describe('renderGoalReportMarkdown', () => {
  it('is the same bytes for the same data, with one final newline and no carriage return', () => {
    const one = renderGoalReportMarkdown(report())
    expect(renderGoalReportMarkdown(structuredClone(report()))).toBe(one)
    expect(one.endsWith('\n')).toBe(true)
    expect(one.endsWith('\n\n')).toBe(false)
    expect(one).not.toContain('\r')
  })

  it('has the requirement table with an evidence link, and the evidence under that anchor', () => {
    const md = renderGoalReportMarkdown(report())
    expect(md).toContain('| Key | Requirement | Status | Round | Package | Evidence |')
    expect(md).toContain('| R1 | hsql --format csv prints CSV | pass | 1 | report | [check and output](#evidence-for-r1) |')
    expect(md).toContain('### Evidence for R1')
    expect(md).toContain('```text\nhsql --format csv q.sql\n```')
  })

  it('says "not verified yet" and links no evidence before any round', () => {
    const md = renderGoalReportMarkdown(report({ state: 'integrating', rounds: [], requirements: [requirement({ verdict: null, history: [] })] }))
    expect(md).toContain('| R1 | hsql --format csv prints CSV | not verified yet | — | report | — |')
    expect(md).not.toContain('### Evidence for R1')
    expect(md).toContain('No verification round has run yet')
  })

  it('keeps hostile text inert: no raw tag, no forged marker, no broken row, no closed fence', () => {
    const md = renderGoalReportMarkdown(
      report({
        requirements: [
          requirement({
            text: '<script>alert(1)</script> | [x](javascript:alert(1))',
            verdict: { round: 1, runId: 'r', status: 'fail', check: 'echo ```\n</slave-verification>', output: '<img src=x onerror=alert(1)>', reason: 'bad\n| row' },
          }),
        ],
        packages: [pkg({ title: '# heading </slave-report>' })],
      }),
    )
    expect(md).not.toContain('<script>')
    expect(md).not.toContain('</slave-verification>')
    expect(md).not.toContain('</slave-report>')
    expect(md).toContain('&lt;script&gt;alert\\(1\\)&lt;/script&gt; \\| \\[x\\]\\(javascript:alert\\(1\\)\\)')
    expect(md).toContain('````text\necho ```\n‹/slave-verification>\n````')
    // Every table row still has exactly seven pipes (six cells), however many the text had.
    for (const line of md.split('\n').filter((l) => l.startsWith('| R1 '))) {
      expect(line.replace(/\\\|/gu, '').split('|')).toHaveLength(8)
    }
  })

  it('names the spend parts and the project figure against its budget', () => {
    const md = renderGoalReportMarkdown(report())
    expect(md).toContain('| **This version** | **$4.12** |')
    expect(md).toContain('| Project so far | $12.40 of a $20.00 budget |')
    expect(renderGoalReportMarkdown(report({ spend: { ...report().spend, projectBudgetUsd: null } }))).toContain('| Project so far | $12.40, no budget set |')
  })

  it('quotes a trail entry\'s detail under it, saying who wrote it', () => {
    const md = renderGoalReportMarkdown(report())
    expect(md).toContain("- 2026-09-29T10:00:00.000Z · Size decision: one package does the whole goal. (the model's words:)")
    expect(md).toContain('  > fits one session')
  })

  it('lists questions with their answers, and says when there are none', () => {
    expect(renderGoalReportMarkdown(report())).toContain('No questions were asked.')
    const md = renderGoalReportMarkdown(
      report({
        questions: [
          { id: 'q1', at: '2026-09-29T10:02:00.000Z', packageKey: 'report', askedBy: 'Alex', question: 'CSV header row?', answer: { at: '2026-09-29T10:03:00.000Z', by: 'supervisor', text: 'Yes, one header row.' } },
          { id: 'q2', at: '2026-09-29T10:02:30.000Z', packageKey: 'report', askedBy: null, question: 'Quote all?', answer: null },
        ],
      }),
    )
    expect(md).toContain('- 2026-09-29T10:02:00.000Z · report (Alex) asked:')
    expect(md).toContain('  Answered by the Supervisor at 2026-09-29T10:03:00.000Z:')
    expect(md).toContain('  Not answered.')
  })

  it('writes the stop reason and the merge git refused where they exist', () => {
    const d = report().delivery!
    const md = renderGoalReportMarkdown(
      report({ state: 'needs_human', delivery: { ...d, mergedAt: null, merge: null, needsHumanReason: 'the verification round cap (3) was reached; still failing: R1' } }),
    )
    expect(md).toContain('## Why it stopped')
    expect(md).toContain('> the verification round cap \\(3\\) was reached; still failing: R1')
    const refused = renderGoalReportMarkdown(report({ state: 'accepted', delivery: { ...d, mergedAt: null, merge: null, mergeError: 'CONFLICT (content)' } }))
    expect(refused).toContain('## The merge git refused')
  })
})
```

`caveats.test.ts`:

```ts
import { reportCaveats } from '../../src/goalReport/caveats.js'
// (builders repeated from markdown.test.ts)

describe('reportCaveats', () => {
  it('is empty for a clean merged version', () => {
    expect(reportCaveats(report())).toEqual([])
  })

  it.each([
    ['requirements not extracted', report({ requirements: null, state: 'not_conducted', delivery: null, rounds: [] }), /have not been extracted yet/],
    ['not conducted', report({ state: 'not_conducted', delivery: null, rounds: [] }), /has not been conducted yet/],
    ['a fallback decision', report({ decision: { ...report().decision!, fallback: true } }), /delivered as one package by default/],
    ['no round yet', report({ state: 'integrating', rounds: [] }), /No verification round has run yet/],
    ['rework after a round', report({ state: 'integrating', packages: [pkg({ taskStatus: 'rework', integrated: false })] }), /from round 1; package report is being worked on again/],
    ['unverifiable', report({ requirements: [requirement({ verdict: { ...requirement().verdict!, status: 'unverifiable', reason: 'no network' } })] }), /could not check R1; the version cannot be accepted until it is/],
    ['trimmed evidence', report({ requirements: [requirement({ verdict: { ...requirement().verdict!, output: 'a\n… [120 characters cut] …\nb' } })] }), /evidence for R1 was trimmed/],
    ['abandoned', report({ state: 'abandoned' }), /abandoned; nothing of it reached main/],
    ['unmeasured runs', report({ spend: { ...report().spend, runsUnmeasured: 2 } }), /2 runs did not report their cost/],
    ['live runs', report({ spend: { ...report().spend, runsLive: 1 } }), /1 run is still going/],
    ['files not recorded', report({ packages: [pkg({ mergedFiles: null })] }), /files report merged were not recorded/],
    ['files cut', report({ packages: [pkg({ mergedFilesTruncated: true })] }), /cut at 500 files per merge/],
    ['trail cut', report({ trailOmitted: 7 }), /newest 1000 entries; 7 older entries are left out/],
  ])('says so when %s', (_name, value, expected) => {
    expect(reportCaveats(value).join('\n')).toMatch(expected)
  })

  it('says a hand merge onto a moved base landed a tree nobody verified', () => {
    const d = report().delivery!
    const caveats = reportCaveats(report({ delivery: { ...d, merge: { by: 'human', commit: 'd'.repeat(40), into: 'main' } } }))
    expect(caveats.join('\n')).toContain(`A person merged this version into main by hand (commit ${'d'.repeat(12)}). That tree combines the verified commit ${'c'.repeat(12)} with what main gained since the cut, and was not itself verified.`)
  })

  it('says nothing about a person who fast-forwarded to the verified commit', () => {
    const d = report().delivery!
    expect(reportCaveats(report({ delivery: { ...d, merge: { by: 'human', commit: 'c'.repeat(40), into: 'main' } } }))).toEqual([])
  })
})
```

`escape.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { evidenceAnchor, evidenceCut, formatReportUsd, mdFence, mdInline, mdQuote, shortCommit } from '../../src/goalReport/escape.js'

describe('the report\'s escapes', () => {
  it('mdInline collapses whitespace, escapes HTML and Markdown punctuation, and neutralises markers', () => {
    expect(mdInline('a\n  b')).toBe('a b')
    expect(mdInline('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
    expect(mdInline('*x* _y_ `z` [l](u) |')).toBe('\\*x\\* \\_y\\_ \\`z\\` \\[l\\]\\(u\\) \\|')
    expect(mdInline('<slave-report>')).toBe('‹slave-report&gt;')
  })

  it('mdFence picks a fence longer than any backtick run and drops trailing newlines', () => {
    expect(mdFence('plain\n\n')).toBe('```text\nplain\n```')
    expect(mdFence('a ```` b')).toBe('`````text\na ```` b\n`````')
  })

  it('mdQuote quotes every line and keeps blank ones', () => {
    expect(mdQuote('one\n\ntwo')).toEqual(['> one', '>', '> two'])
  })

  it('reads the cut marker trimEvidence writes, and formats money and commits', () => {
    expect(evidenceCut('head\n… [42 characters cut] …\ntail')).toBe(42)
    expect(evidenceCut('whole')).toBe(0)
    expect(evidenceAnchor('R12')).toBe('evidence-for-r12')
    expect(formatReportUsd(null)).toBe('—')
    expect(formatReportUsd(0.001)).toBe('<$0.01')
    expect(formatReportUsd(4.125)).toBe('$4.13')
    expect(shortCommit(null)).toBe('unknown')
    expect(shortCommit('a'.repeat(40))).toBe('a'.repeat(12))
  })
})
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run packages/domain/test/goalReport`. Expected: FAIL, cannot resolve `../../src/goalReport/...`.

- [ ] **Step 3: Implement.** `constants.ts`:

```ts
/** Conductor Plan 5 (spec R10): the bounds and names the goal-version report shares. */

/** Files one package merge records on its `task.done` (plan D3). A merge that touched more says
 *  how many (`filesTotal`), and the report says the list is cut. */
export const GOAL_REPORT_FILES_MAX = 500

/** The decision trail's length (plan D6): the newest entries are kept, and the report says how
 *  many older ones were left out. */
export const GOAL_REPORT_TRAIL_MAX = 1000

/** One trail entry's quoted text. A verification rework reason carries the verifier's evidence
 *  (up to `VERIFICATION_REWORK_MAX_CHARS`), so this is the same order of size. */
export const GOAL_REPORT_DETAIL_MAX_CHARS = 6000

/** The chat note's length (plan D10): a summary that points at the report, never the report. */
export const GOAL_REPORT_SUMMARY_MAX_CHARS = 1500

/** The prefix of every chat note's `SupervisorMessage.noteKey` (plan D10). */
export const GOAL_REPORT_NOTE_KEY_PREFIX = 'goal-report:'
```

`types.ts`:

```ts
/**
 * Conductor Plan 5 (spec R10): one goal version's report as plain data. It holds what was asked,
 * what was verified and how, who did which part, what it cost, and every recorded decision on the
 * way. `loadGoalReport` (`packages/control`) builds it from recorded rows only, and no model
 * re-derives any of it (plan D1). The web page, the Markdown export and the chat note render it.
 * Every timestamp is an ISO string (UTC), so the value crosses a route unchanged.
 */
export const GOAL_REPORT_STATES = ['not_conducted', 'integrating', 'verifying', 'accepted', 'merged', 'needs_human', 'abandoned'] as const
export type GoalReportState = (typeof GOAL_REPORT_STATES)[number]

export type GoalReportVerdictStatus = 'pass' | 'fail' | 'unverifiable'

/** One requirement's verdict in one round: the check the verifier wrote and ran, its trimmed
 *  output and its reason, exactly as `VerificationResult` stores them. */
export interface GoalReportVerdict {
  readonly round: number
  readonly runId: string
  readonly status: GoalReportVerdictStatus
  readonly check: string
  readonly output: string
  readonly reason: string
}

export interface GoalReportRequirement {
  readonly key: string
  readonly text: string
  /** The goal sentence the requirement came from (spec R1). The person checks the extraction
   *  against it. */
  readonly source: string
  /** The package whose `requirementKeys` holds it; null before conduct. */
  readonly packageKey: string | null
  /** The latest round's verdict (plan D4); null before any round. */
  readonly verdict: GoalReportVerdict | null
  /** Its status in every round, oldest first. */
  readonly history: readonly { readonly round: number; readonly status: GoalReportVerdictStatus }[]
}

export interface GoalReportRound {
  readonly round: number
  /** The verification run whose verdict counts for this round (plan D4). */
  readonly runId: string
  /** The verifier seat's person, or null if the seat is gone. */
  readonly verifier: string | null
  /** The integration commit the round checked (`SlaveRun.verificationTip`). */
  readonly commit: string | null
  readonly at: string
  readonly pass: number
  readonly fail: number
  readonly unverifiable: number
}

/** A package worker's latest `<slave-report>` (spec R7), cut down to what a reader needs. */
export interface GoalReportWorkerReport {
  readonly runId: string
  readonly requirements: readonly { readonly key: string; readonly status: 'done' | 'partial' | 'not_done'; readonly evidence: string }[]
  readonly workflowDone: number
  readonly workflowTotal: number
}

export interface GoalReportPackage {
  readonly key: string
  readonly title: string
  readonly isIntegration: boolean
  readonly requirementKeys: readonly string[]
  readonly ownedPaths: readonly string[]
  readonly dependsOn: readonly string[]
  /** The persona (catalogue template) the conductor named for it, or null if it was deleted. */
  readonly persona: string | null
  /** The person on the seat its task is pinned to now (plan D6), or null. */
  readonly seat: string | null
  readonly taskId: string | null
  readonly taskStatus: string | null
  /** On the version's integration branch (`Task.integratedAt`). */
  readonly integrated: boolean
  /** Git's list at each merge into the integration branch, united and sorted (plan D3). Null when
   *  no merge recorded one. */
  readonly mergedFiles: readonly string[] | null
  /** A merge touched more files than `GOAL_REPORT_FILES_MAX`, so the list is a lower bound. */
  readonly mergedFilesTruncated: boolean
  /** The latest report's `filesTouched`: the worker's own claim. Null when no report was filed. */
  readonly reportedFiles: readonly string[] | null
  readonly report: GoalReportWorkerReport | null
  readonly implementationRuns: number
}

export interface GoalReportDelivery {
  readonly integrationBranch: string
  readonly baseBranch: string
  readonly baseCommit: string
  readonly verifiedCommit: string | null
  readonly round: number
  readonly roundBase: number
  /** `Workspace.verificationRoundCap`: rounds allowed from `roundBase`. */
  readonly roundCap: number
  readonly acceptedAt: string | null
  readonly mergedAt: string | null
  /** From `workspace.goal_merged`: who landed it, the base branch's commit, and where. */
  readonly merge: { readonly by: 'system' | 'human'; readonly commit: string; readonly into: string } | null
  readonly mergeError: string | null
  readonly needsHumanReason: string | null
  /** From `workspace.goal_abandoned`. */
  readonly abandonedAt: string | null
}

/** The conductor's size decision (spec R2): the recorded `conduct` decision. */
export interface GoalReportDecision {
  readonly mode: 'single' | 'partitioned'
  /** The conductor's reason: the model's words, or the rules' when `fallback`. */
  readonly reason: string
  readonly decidedBy: 'model' | 'rules'
  readonly fallback: boolean
  readonly at: string
}

export interface GoalReportQuestion {
  /** The question's `SlaveMessage` id. */
  readonly id: string
  readonly at: string
  readonly packageKey: string | null
  readonly askedBy: string | null
  readonly question: string
  readonly answer: { readonly at: string; readonly by: 'person' | 'supervisor' | 'slave'; readonly text: string } | null
}

/** Plan D5. `versionUsd` = `runsMeasuredUsd + conductorMeasuredUsd + conductorUnmeasuredCalls *
 *  CONDUCT_PER_CALL_CAP_USD + supervisorMeasuredUsd + supervisorUnmeasuredCalls *
 *  SUPERVISOR_PER_CALL_CAP_USD`. Unmeasured and live runs are counted, never summed. */
export interface GoalReportSpend {
  readonly runsMeasuredUsd: number
  readonly runsUnmeasured: number
  readonly runsLive: number
  readonly conductorMeasuredUsd: number
  readonly conductorUnmeasuredCalls: number
  readonly supervisorMeasuredUsd: number
  readonly supervisorUnmeasuredCalls: number
  readonly versionUsd: number
  /** `workspaceSpend(...).spentUsd`: the budget guardrail's own figure. */
  readonly projectSpentUsd: number
  readonly projectBudgetUsd: number | null
}

/** Who wrote a trail entry's quoted `detail` (plan D6). */
export type GoalReportAuthor = 'system' | 'model' | 'person'

export interface GoalReportTrailEntry {
  readonly at: string
  /** A sentence Slave composed from ids, keys and counts. Package keys and titles in it came from
   *  the conductor's answer, so renderers escape it like any other text. */
  readonly text: string
  /** A rationale, a rework reason, a stop reason: quoted, bounded by `GOAL_REPORT_DETAIL_MAX_CHARS`. */
  readonly detail: string | null
  readonly detailBy: GoalReportAuthor | null
  readonly packageKey: string | null
}

export interface GoalReport {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly goalVersion: number
  /** Every version of the workspace that has a report, ascending (the page's version links). */
  readonly versions: readonly number[]
  /** `GoalVersion.text`, or null for a row seeded without one. */
  readonly goal: string | null
  readonly state: GoalReportState
  readonly delivery: GoalReportDelivery | null
  readonly decision: GoalReportDecision | null
  /** Null until the requirements step has run (spec R1). */
  readonly requirements: readonly GoalReportRequirement[] | null
  readonly rounds: readonly GoalReportRound[]
  readonly packages: readonly GoalReportPackage[]
  readonly verifier: string | null
  readonly questions: readonly GoalReportQuestion[]
  readonly spend: GoalReportSpend
  readonly trail: readonly GoalReportTrailEntry[]
  /** Trail entries older than the newest `GOAL_REPORT_TRAIL_MAX`, left out. */
  readonly trailOmitted: number
  /** The newest timestamp among the facts (plan D7: no clock is read), or null when there is none. */
  readonly asOf: string | null
}
```

`escape.ts`:

```ts
import { sanitisePersonText } from '../handoff/contract.js'

const HTML_ENTITY: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/**
 * One line of Markdown prose or one table cell, from text a person or a model wrote (plan D7).
 * Markers and routing literals are defused (`sanitisePersonText`: the export is text people paste
 * into prompts). Whitespace collapses, so a newline cannot end a table row. HTML is escaped, so
 * no renderer runs a tag. Markdown punctuation is backslash-escaped, so no link, emphasis, code
 * span or cell border can be forged. CommonMark allows a backslash before any ASCII punctuation.
 */
export function mdInline(text: string): string {
  return sanitisePersonText(text)
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[&<>]/gu, (char) => HTML_ENTITY[char] ?? char)
    .replace(/[\\`*_[\]|~#!()]/gu, (char) => `\\${char}`)
}

/**
 * A fenced block for text whose shape matters: a check, an output, a goal. The fence is one
 * backtick longer than the longest backtick run inside, so the text cannot close it. HTML inside
 * a fence is shown, not run. Markers are still defused.
 */
export function mdFence(text: string): string {
  const body = sanitisePersonText(text).replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
  let longest = 0
  for (const match of body.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${body}\n${fence}`
}

/** A quote, line by line: prose keeps its lines, and each line is {@link mdInline}d. */
export function mdQuote(text: string): readonly string[] {
  return sanitisePersonText(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/\n+$/u, '')
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${mdInline(line)}`))
}

const CUT = /\n… \[(\d+) characters cut\] …\n/u

/** How many characters `trimEvidence` cut from this text, or 0 (plan D8). */
export function evidenceCut(text: string): number {
  const match = CUT.exec(text)
  return match === null ? 0 : Number(match[1])
}

/** The heading anchor GitHub-style renderers give `### Evidence for <key>`. Keys are `R<n>`
 *  (`requirementItemsSchema`), so no other character needs mapping. */
export function evidenceAnchor(key: string): string {
  return `evidence-for-${key.toLowerCase()}`
}

/** Real money, the web `formatUsd`'s rules: null (or nonsense) is `—`, never `$0.00`. */
export function formatReportUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return '—'
  if (value > 0 && value < 0.005) return '<$0.01'
  return `$${value.toFixed(2)}`
}

export function shortCommit(sha: string | null): string {
  return sha === null ? 'unknown' : sha.slice(0, 12)
}
```

`caveats.ts`:

```ts
import { GOAL_REPORT_FILES_MAX, GOAL_REPORT_TRAIL_MAX } from './constants.js'
import { evidenceCut, shortCommit } from './escape.js'
import type { GoalReport, GoalReportState } from './types.js'

/** How a person says each state. One wording for the page, the export and the chat note. */
export const GOAL_REPORT_STATE_LABEL: Readonly<Record<GoalReportState, string>> = {
  not_conducted: 'not conducted yet',
  integrating: 'being built',
  verifying: 'being verified',
  accepted: 'verified, waiting to be merged',
  merged: 'merged',
  needs_human: 'needs you',
  abandoned: 'abandoned',
}

const FINISHED_TASK_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

const keysOf = (items: readonly { readonly key: string }[]): string => items.map((item) => item.key).join(', ')
const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`

/**
 * What this report cannot vouch for (plan D8), in the order a reader should see it. The page and
 * the export print the same list. Everything here is a fact about the report's own data. Nothing
 * is looked up.
 */
export function reportCaveats(report: GoalReport): readonly string[] {
  const out: string[] = []
  const delivery = report.delivery
  const base = delivery?.baseBranch ?? 'the base branch'
  const requirements = report.requirements ?? []
  if (report.requirements === null) {
    out.push('The requirements of this goal version have not been extracted yet, so nothing can be checked against them.')
  }
  if (report.state === 'not_conducted') out.push('This goal version has not been conducted yet: it has no packages and no verification.')
  if (report.decision?.fallback === true) {
    out.push("The conductor's answers were unusable, so this version was delivered as one package by default.")
  }
  const last = report.rounds.at(-1)
  if (delivery !== null && last === undefined && report.state !== 'abandoned') {
    out.push('No verification round has run yet: no requirement is verified.')
  }
  const moving = report.packages.filter((pkg) => pkg.taskStatus !== null && !FINISHED_TASK_STATUSES.has(pkg.taskStatus))
  if (last !== undefined && (report.state === 'integrating' || report.state === 'verifying') && moving.length > 0) {
    const which = moving.length === 1 ? `package ${keysOf(moving)} is` : `packages ${keysOf(moving)} are`
    out.push(`The verdicts below are from round ${String(last.round)}; ${which} being worked on again since, so they may change.`)
  }
  const unverifiable = requirements.filter((item) => item.verdict?.status === 'unverifiable')
  if (unverifiable.length > 0) {
    out.push(`The verifier could not check ${keysOf(unverifiable)}; the version cannot be accepted until ${unverifiable.length === 1 ? 'it is' : 'they are'}.`)
  }
  const trimmed = requirements.filter(
    (item) => item.verdict !== null && [item.verdict.check, item.verdict.output, item.verdict.reason].some((text) => evidenceCut(text) > 0),
  )
  if (trimmed.length > 0) {
    out.push(`The evidence for ${keysOf(trimmed)} was trimmed to fit; the verifier's full output stays in its run's scratch directory.`)
  }
  const merge = delivery?.merge ?? null
  if (merge !== null && merge.by === 'human' && merge.commit !== delivery?.verifiedCommit) {
    out.push(
      delivery?.verifiedCommit == null
        ? `A person merged this version into ${merge.into} by hand (commit ${shortCommit(merge.commit)}), and no verified commit is recorded for it.`
        : `A person merged this version into ${merge.into} by hand (commit ${shortCommit(merge.commit)}). That tree combines the verified commit ` +
            `${shortCommit(delivery.verifiedCommit)} with what ${merge.into} gained since the cut, and was not itself verified.`,
    )
  }
  if (report.state === 'abandoned') out.push(`This goal version was abandoned; nothing of it reached ${base}.`)
  const { runsUnmeasured, runsLive } = report.spend
  if (runsUnmeasured > 0) {
    out.push(`${count(runsUnmeasured, 'run', 'runs')} did not report ${runsUnmeasured === 1 ? 'its' : 'their'} cost; ${runsUnmeasured === 1 ? 'it is' : 'they are'} not in the version's spend.`)
  }
  if (runsLive > 0) {
    out.push(`${count(runsLive, 'run is', 'runs are')} still going; ${runsLive === 1 ? 'its' : 'their'} cost is not known yet.`)
  }
  const unrecorded = report.packages.filter((pkg) => pkg.integrated && pkg.mergedFiles === null)
  if (unrecorded.length > 0) {
    out.push(`The files ${keysOf(unrecorded)} merged were not recorded (merged before Slave recorded them); the worker's own list is shown.`)
  }
  const cut = report.packages.filter((pkg) => pkg.mergedFilesTruncated)
  if (cut.length > 0) out.push(`The file lists of ${keysOf(cut)} are cut at ${String(GOAL_REPORT_FILES_MAX)} files per merge.`)
  if (report.trailOmitted > 0) {
    out.push(`The decision trail shows the newest ${String(GOAL_REPORT_TRAIL_MAX)} entries; ${count(report.trailOmitted, 'older entry is', 'older entries are')} left out.`)
  }
  return out
}
```

(The `'trail cut'` case expects `7 older entries are left out`, which `count(7, 'older entry is', 'older entries are')` gives as `7 older entries are`. The `'live runs'` case expects `1 run is still going`.)

`markdown.ts`:

```ts
import { GOAL_REPORT_STATE_LABEL, reportCaveats } from './caveats.js'
import { evidenceAnchor, evidenceCut, formatReportUsd, mdFence, mdInline, mdQuote, shortCommit } from './escape.js'
import type { GoalReport, GoalReportAuthor } from './types.js'
import { CONDUCT_PER_CALL_CAP_USD } from '../conduct/constants.js'

const WORDS_OF: Readonly<Record<GoalReportAuthor, string>> = {
  system: "Slave's record",
  model: "the model's words",
  person: "a person's words",
}

const ANSWERED_BY = { person: 'a person', supervisor: 'the Supervisor', slave: 'a slave' } as const

/**
 * The goal version's report as Markdown (spec R10, plan D7): deterministic (a pure function of
 * `report`, no clock read, no sorting of its own) and inert (every value another party wrote goes
 * through `mdInline`, `mdFence` or `mdQuote`). Sections, in order: state, what to know, why it
 * stopped, a refused merge, goal, requirements, rounds, evidence, packages, spend, decision trail,
 * questions.
 */
export function renderGoalReportMarkdown(report: GoalReport): string {
  const lines: string[] = []
  const d = report.delivery
  lines.push(`# Goal v${String(report.goalVersion)} report: ${mdInline(report.workspaceName)}`, '')
  lines.push(`State: **${GOAL_REPORT_STATE_LABEL[report.state]}**${stateDetail(report)}`, '')
  lines.push(`As of: ${report.asOf ?? 'no recorded fact yet'}`, '')

  const caveats = reportCaveats(report)
  if (caveats.length > 0) lines.push('## What to know', '', ...caveats.map((line) => `- ${mdInline(line)}`), '')
  if (report.state === 'needs_human' && d?.needsHumanReason != null) lines.push('## Why it stopped', '', ...mdQuote(d.needsHumanReason), '')
  if (d?.mergeError != null) lines.push('## The merge git refused', '', mdFence(d.mergeError), '')

  lines.push('## Goal', '', report.goal === null ? 'No goal text is recorded for this version.' : mdFence(report.goal), '')

  lines.push('## Requirements', '')
  if (report.requirements === null) {
    lines.push('Not extracted yet.', '')
  } else {
    lines.push('| Key | Requirement | Status | Round | Package | Evidence |', '| --- | --- | --- | --- | --- | --- |')
    for (const item of report.requirements) {
      const v = item.verdict
      lines.push(
        `| ${mdInline(item.key)} | ${mdInline(item.text)} | ${v === null ? 'not verified yet' : v.status} | ${v === null ? '—' : String(v.round)} | ` +
          `${item.packageKey === null ? '—' : mdInline(item.packageKey)} | ${v === null ? '—' : `[check and output](#${evidenceAnchor(item.key)})`} |`,
      )
    }
    lines.push('')
  }

  lines.push('## Verification rounds', '')
  if (report.rounds.length === 0) {
    lines.push('No round has run.', '')
  } else {
    lines.push('| Round | Verifier | Commit checked | Pass | Fail | Unverifiable | Finished |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const round of report.rounds) {
      lines.push(
        `| ${String(round.round)} | ${round.verifier === null ? '—' : mdInline(round.verifier)} | ${shortCommit(round.commit)} | ` +
          `${String(round.pass)} | ${String(round.fail)} | ${String(round.unverifiable)} | ${round.at} |`,
      )
    }
    lines.push('')
  }

  const verified = (report.requirements ?? []).filter((item) => item.verdict !== null)
  if (verified.length > 0) {
    lines.push('## Evidence', '')
    for (const item of verified) {
      const v = item.verdict
      if (v === null) continue
      const earlier = item.history.filter((h) => h.round !== v.round).map((h) => `round ${String(h.round)} ${h.status}`)
      lines.push(`### Evidence for ${mdInline(item.key)}`, '')
      lines.push(`Requirement: ${mdInline(item.text)}`, '')
      lines.push(`Taken from the goal: ${item.source === '' ? '—' : mdInline(item.source)}`, '')
      lines.push(`Verdict: **${v.status}** in round ${String(v.round)} (run ${mdInline(v.runId)})${earlier.length === 0 ? '' : `; earlier: ${earlier.join(', ')}`}.`, '')
      lines.push('Check:', '', v.check === '' ? 'No check was written.' : mdFence(v.check), '')
      lines.push('Output:', '', v.output === '' ? 'No output.' : mdFence(v.output), '')
      if (v.reason !== '') lines.push('Reason:', '', ...mdQuote(v.reason), '')
      const cut = evidenceCut(v.check) + evidenceCut(v.output) + evidenceCut(v.reason)
      if (cut > 0) lines.push(`(Trimmed: ${String(cut)} characters cut from this evidence.)`, '')
    }
  }

  lines.push('## Packages', '')
  if (report.packages.length === 0) lines.push('No packages yet.', '')
  for (const pkg of report.packages) {
    lines.push(`### ${mdInline(pkg.key)}: ${mdInline(pkg.title)}${pkg.isIntegration ? ' (the integration package)' : ''}`, '')
    lines.push(`- Seat: ${pkg.seat === null ? 'none' : mdInline(pkg.seat)}${pkg.persona === null ? '' : ` (persona ${mdInline(pkg.persona)})`}`)
    lines.push(`- Requirements: ${pkg.requirementKeys.length === 0 ? 'none of its own' : pkg.requirementKeys.map(mdInline).join(', ')}`)
    lines.push(`- Owns: ${pkg.ownedPaths.map(mdInline).join(', ')}`)
    if (pkg.dependsOn.length > 0) lines.push(`- Depends on: ${pkg.dependsOn.map(mdInline).join(', ')}`)
    lines.push(
      `- Task: ${pkg.taskStatus === null ? 'none' : mdInline(pkg.taskStatus)}${pkg.integrated ? ', on the integration branch' : ''}; ` +
        `${String(pkg.implementationRuns)} implementation ${pkg.implementationRuns === 1 ? 'run' : 'runs'}`,
    )
    lines.push(`- Files merged (from git): ${pkg.mergedFiles === null ? 'not recorded' : pkg.mergedFiles.length === 0 ? 'none' : pkg.mergedFiles.map(mdInline).join(', ')}${pkg.mergedFilesTruncated ? ' (cut)' : ''}`)
    lines.push(`- Files the worker reported: ${pkg.reportedFiles === null ? 'no report filed' : pkg.reportedFiles.length === 0 ? 'none' : pkg.reportedFiles.map(mdInline).join(', ')}`)
    if (pkg.report !== null) {
      const claims = pkg.report.requirements.map((r) => `${mdInline(r.key)} ${r.status.replace('_', ' ')}`).join(', ')
      lines.push(`- The worker's report: ${claims === '' ? 'no requirement' : claims}; workflow ${String(pkg.report.workflowDone)} of ${String(pkg.report.workflowTotal)} steps done`)
    }
    lines.push('')
  }
  lines.push(`Verifier: ${report.verifier === null ? 'none recorded' : mdInline(report.verifier)}`, '')

  const s = report.spend
  lines.push('## Spend', '', '| Part | Amount |', '| --- | --- |')
  lines.push(`| Runs of this version | ${formatReportUsd(s.runsMeasuredUsd)} |`)
  lines.push(
    `| Conductor calls | ${formatReportUsd(s.conductorMeasuredUsd)}${s.conductorUnmeasuredCalls === 0 ? '' : ` + ${String(s.conductorUnmeasuredCalls)} unmeasured, charged at ${formatReportUsd(CONDUCT_PER_CALL_CAP_USD)} each`} |`,
  )
  lines.push(`| Supervisor decisions | ${formatReportUsd(s.supervisorMeasuredUsd)}${s.supervisorUnmeasuredCalls === 0 ? '' : ` + ${String(s.supervisorUnmeasuredCalls)} unmeasured, charged at the cap`} |`)
  lines.push(`| **This version** | **${formatReportUsd(s.versionUsd)}** |`)
  lines.push(
    `| Project so far | ${formatReportUsd(s.projectSpentUsd)}${s.projectBudgetUsd === null ? ', no budget set' : ` of a ${formatReportUsd(s.projectBudgetUsd)} budget`} |`,
    '',
  )
  lines.push('The conversation with the Supervisor and the intake are counted in the project figure only: they belong to no one version.', '')

  lines.push('## Decision trail', '')
  if (report.trail.length === 0) lines.push('Nothing recorded yet.')
  for (const entry of report.trail) {
    lines.push(`- ${entry.at} · ${mdInline(entry.text)}${entry.detail === null ? '' : ` (${WORDS_OF[entry.detailBy ?? 'system']}:)`}`)
    if (entry.detail !== null) lines.push(...mdQuote(entry.detail).map((line) => `  ${line}`))
  }
  lines.push('')

  lines.push('## Questions', '')
  if (report.questions.length === 0) lines.push('No questions were asked.')
  for (const q of report.questions) {
    const who = [q.packageKey === null ? null : mdInline(q.packageKey), q.askedBy === null ? null : `(${mdInline(q.askedBy)})`].filter((part) => part !== null).join(' ')
    lines.push(`- ${q.at} · ${who === '' ? 'A worker' : who} asked:`, ...mdQuote(q.question).map((line) => `  ${line}`))
    if (q.answer === null) lines.push('  Not answered.')
    else lines.push(`  Answered by ${ANSWERED_BY[q.answer.by]} at ${q.answer.at}:`, ...mdQuote(q.answer.text).map((line) => `  ${line}`))
  }
  lines.push('')

  lines.push('---', '', "Built from Slave's records of this goal version. Quoted text is marked with who wrote it.")
  return `${lines.join('\n').trimEnd()}\n`
}

/** What follows the state word: who merged and where, what is verified, which round. */
function stateDetail(report: GoalReport): string {
  const d = report.delivery
  if (d === null) return ''
  if (report.state === 'merged' && d.merge !== null) {
    return ` into ${mdInline(d.merge.into)} ${d.merge.by === 'human' ? 'by a person' : 'by Slave'} (commit ${shortCommit(d.merge.commit)})`
  }
  if (report.state === 'accepted') return ` (verified commit ${shortCommit(d.verifiedCommit)} on ${mdInline(d.integrationBranch)})`
  if (report.state === 'integrating' || report.state === 'verifying' || report.state === 'needs_human') {
    return d.round === 0 ? '' : ` (verification round ${String(d.round)}; at most ${String(d.roundBase + d.roundCap)} before it stops for a person)`
  }
  return ''
}
```

`index.ts`:

```ts
export * from './caveats.js'
export * from './constants.js'
export * from './escape.js'
export * from './markdown.js'
export * from './types.js'
```

(Task 7 adds `export * from './summary.js'`.)

- [ ] **Step 4: Run.** `npx vitest run packages/domain/test/goalReport`. Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add packages/domain/src/goalReport packages/domain/src/index.ts packages/domain/test/goalReport
git commit -m "$(printf 'feat(report): the goal-version report shape, its caveats and its deterministic Markdown\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

---

### Task 2: A package's merge records the files git says it changed

**Files:**
- Modify: `packages/domain/src/events/schema.ts` (the `task.done` payload)
- Modify: `apps/orchestrator/src/merge.ts` (the integration-branch arm, after `mergeOrAbort` succeeds, around `:461-475`)
- Test: `packages/domain/test/events/conductor-events.test.ts`, `apps/orchestrator/test/integration/merge.test.ts` (`describe('into the integration branch')`)

**Interfaces:**
- Consumes: `GOAL_REPORT_FILES_MAX` (Task 1), `gitIn` (`./worktree.js`).
- Produces: `task.done` payload `{ branch: string; files?: string[] (≤ 500, each non-empty); filesTotal?: int ≥ 0 }`. Only the merge into an integration branch writes the two new fields. Task 4 reads them.

- [ ] **Step 1: Failing tests.** In `conductor-events.test.ts`:

```ts
  it('task.done carries the files a package merge changed, and still parses without them', () => {
    const envelope = { workspaceId: 'w', taskId: 't', actor: 'system' as const }
    expect(eventSchema.safeParse({ ...envelope, type: 'task.done', payload: { branch: 'b' } }).success).toBe(true)
    expect(eventSchema.safeParse({ ...envelope, type: 'task.done', payload: { branch: 'b', files: ['a.py'], filesTotal: 1 } }).success).toBe(true)
    expect(eventSchema.safeParse({ ...envelope, type: 'task.done', payload: { branch: 'b', files: Array.from({ length: 501 }, (_, i) => `f${String(i)}`), filesTotal: 501 } }).success).toBe(false)
  })
```

(Use the file's existing envelope helper and schema import name if they differ. Check the first case in the file.) In `merge.test.ts`, at the end of the existing case `'merges a package into its integration branch with autoMerge off, and leaves main and the checkout alone'`:

```ts
    // Conductor Plan 5 (D3): the merge records what git says it changed -- the report's "files touched".
    const done = await prisma.executionEvent.findFirstOrThrow({ where: { taskId, type: 'task_done' }, orderBy: { seq: 'desc' } })
    expect(done.payload).toEqual({ branch, files: ['feature.txt'], filesTotal: 1 })
```

and a new case in the same `describe`:

```ts
  it('records a path with spaces and non-ASCII characters exactly, and caps the list', async (): Promise<void> => {
    const workspace = await seedWorkspace({ autoMerge: false })
    await deliver(workspace)
    const { taskId } = await seedMergingTask(workspace, { fileName: 'rapor ü.txt' })
    await packageTask(workspace, taskId, 'feature')

    await runMergePass(brandWorkspaceId(workspace.id))

    const done = await prisma.executionEvent.findFirstOrThrow({ where: { taskId, type: 'task_done' }, orderBy: { seq: 'desc' } })
    expect((done.payload as { files: string[] }).files).toEqual(['rapor ü.txt'])
  })
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run packages/domain/test/events/conductor-events.test.ts` fails on the 501 case (unknown keys are stripped, so it parses). `npx vitest run apps/orchestrator/test/integration/merge.test.ts -t "integration branch"` fails with the payload missing `files`.

- [ ] **Step 3: Implement.** In `schema.ts`, replace the `task.done` line with:

```ts
  z.object({
    ...envelope,
    type: z.literal('task.done'),
    payload: z.object({
      branch: z.string(),
      // Conductor Plan 5 (D3): what git says a package's merge into its goal version's integration
      // branch changed -- the report's "files touched", recorded rather than taken from the
      // worker's claim. `GOAL_REPORT_FILES_MAX` (`goalReport/constants.ts`), spelled here the way
      // this file spells every stored bound; `filesTotal` counts all of them when the list is cut.
      // Absent on every other `task.done` and on every row written before Plan 5.
      files: z.array(z.string().min(1)).max(500).optional(),
      filesTotal: z.number().int().nonnegative().optional(),
    }),
  }),
```

In `merge.ts`, after the successful integration merge and before the `prisma.task.update`:

```ts
    // Conductor Plan 5 (D3): the files this package's merge changed, as git lists them against the
    // integration branch's previous tip (`HEAD^1` of a `--no-ff` merge). `-z` so a name with a
    // newline, a space or a non-ASCII letter comes back exactly. A failure costs the report one
    // package's list ("not recorded"), never the merge.
    const changed = await gitIn(integrationPath, 'diff', '--name-only', '-z', 'HEAD^1', 'HEAD').then(
      (out) => out.split('\0').filter((name) => name.length > 0),
      (error: unknown): null => {
        console.warn(`[merge] could not list the files ${branch} changed in ${target.branch}: ${errorText(error)}`)
        return null
      },
    )
```

and the event becomes:

```ts
    await appendEvent({
      type: 'task.done',
      workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: { branch, ...(changed === null ? {} : { files: changed.slice(0, GOAL_REPORT_FILES_MAX), filesTotal: changed.length }) },
    })
```

(`GOAL_REPORT_FILES_MAX` joins the file's `@slave-of-ai/domain` import. `gitIn` is already imported from `./worktree.js` in `merge.ts`; check with `grep -n "gitIn" apps/orchestrator/src/merge.ts`. `errorText` is the file's own helper.)

- [ ] **Step 4: Run** both test files above, then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(merge): a package's merge into its integration branch records the files git says it changed`, with the trailer.

---

### Task 3: A goal version's spend, decision trail and questions (control)

**Files:**
- Create: `packages/control/src/goalReportTrail.ts` (scope, seat names, trail, questions), `packages/control/src/goalReportSpend.ts`
- Modify: `packages/control/src/index.ts` (export both, after `./delivery.js`)
- Test: `packages/control/test/integration/goal-report-trail.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's types and constants; `workspaceSpend` (`./spend.js`); `SITUATION_LABEL`, `CONDUCT_PER_CALL_CAP_USD`, `SUPERVISOR_PER_CALL_CAP_USD`, `NON_TERMINAL_RUN_STATUSES`, `trimEvidence` (`@slave-of-ai/domain`); `DOMAIN_EVENT_TYPE_BY_DB_VALUE` (`@slave-of-ai/db`).
- Produces:
  - `export interface VersionScope { readonly workspaceId: string; readonly goalVersion: number; readonly deliveryId: string | null; readonly tasks: readonly { readonly taskId: string; readonly packageKey: string; readonly seat: string | null }[]; readonly verifier: string | null }`
  - `export async function loadVersionScope(workspaceId: string, goalVersion: number): Promise<VersionScope>`
  - `export async function seatNames(slaveIds: readonly (string | null)[]): Promise<ReadonlyMap<string, string>>`
  - `export async function versionTrail(scope: VersionScope, max?: number): Promise<{ readonly entries: readonly GoalReportTrailEntry[]; readonly omitted: number }>`
  - `export async function versionQuestions(scope: VersionScope): Promise<readonly GoalReportQuestion[]>`
  - `export async function versionSpend(scope: VersionScope, questionIds: readonly string[]): Promise<GoalReportSpend>`
  - `export function versionSubject(workspaceId: string, goalVersion: number): { readonly equals: string; readonly prefix: string }`: `<ws>:v<n>` and `<ws>:v<n>:` (plan D5)

- [ ] **Step 1: Failing tests** (`goal-report-trail.test.ts`). The fixture seeds one workspace with versions 1 and 10, each with a package task, so every case also proves the other version stays out:

```ts
/**
 * Conductor Plan 5, Task 3: a goal version's spend (plan D5), its decision trail (D6) and its
 * questions, read from recorded rows. Versions 1 and 10 share a workspace in every case, so a
 * prefix that matched both would show up here.
 */
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadVersionScope, versionQuestions, versionTrail } from '../../src/goalReportTrail.js'
import { versionSpend } from '../../src/goalReportSpend.js'

interface Seeded {
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskOf: Readonly<Record<1 | 10, string>>
  readonly deliveryOf: Readonly<Record<1 | 10, string>>
}

async function seed(): Promise<Seeded> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Report Trail', repoPath: '/tmp/report-trail', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted', budgetUsd: 20 },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const alex = await prisma.person.create({ data: { name: 'Alex Trail' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', runtimeRoles: ['implementer'], personId: alex.id } })
  const taskOf = {} as Record<1 | 10, string>
  const deliveryOf = {} as Record<1 | 10, string>
  for (const version of [1, 10] as const) {
    const delivery = await prisma.goalDelivery.create({
      data: { workspaceId: workspace.id, goalVersion: version, integrationBranch: `slaveofai/goal-v${String(version)}-x`, baseCommit: 'b'.repeat(40) },
    })
    deliveryOf[version] = delivery.id
    const pkg = await prisma.workPackage.create({
      data: { workspaceId: workspace.id, goalVersion: version, key: `pkg${String(version)}`, title: 'p', requirementKeys: ['R1'], ownedPaths: ['**'], interface: '', templateId: 'tpl' },
    })
    const task = await prisma.task.create({
      data: { workspaceId: workspace.id, title: 'p', description: 'x', status: 'done', requiredRole: 'implementer', maxAttempts: 3, workPackageId: pkg.id, goalVersion: version, assigneeId: slave.id },
    })
    taskOf[version] = task.id
  }
  return { workspaceId: workspace.id, slaveId: slave.id, taskOf, deliveryOf }
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "ConductorCall", "VerificationResult", "SlaveRun", "Task", "WorkPackage", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('versionSpend', () => {
  it("sums the version's runs, conductor calls and decisions, charges the unmeasured, and leaves v10 out", async (): Promise<void> => {
    const s = await seed()
    const run = (taskId: string | null, costUsd: number | null, status: 'succeeded' | 'working', goalDeliveryId?: string) =>
      prisma.slaveRun.create({ data: { taskId, slaveId: s.slaveId, status, costUsd, ...(goalDeliveryId === undefined ? {} : { goalDeliveryId, kind: 'verification' }) } })
    await run(s.taskOf[1], 1.5, 'succeeded')
    await run(s.taskOf[1], null, 'succeeded') // unmeasured
    await run(s.taskOf[1], null, 'working') // live
    await run(null, 0.5, 'succeeded', s.deliveryOf[1]) // the verification run
    await run(s.taskOf[10], 9, 'succeeded') // v10's: must not count
    await prisma.conductorCall.createMany({
      data: [
        { workspaceId: s.workspaceId, goalVersion: 1, stage: 'requirements', outcome: 'ok', modelCostUsd: 0.02 },
        { workspaceId: s.workspaceId, goalVersion: 1, stage: 'conduct', outcome: 'failed', modelCostUsd: null, unmeasured: true },
        { workspaceId: s.workspaceId, goalVersion: 10, stage: 'conduct', outcome: 'ok', modelCostUsd: 5 },
      ],
    })
    const decision = (subjectId: string, modelCostUsd: number | null, modelCalled: boolean) =>
      prisma.supervisorDecision.create({
        data: {
          workspaceId: s.workspaceId, situationKind: 'goal_needs_human', subjectId, situation: {}, candidates: [], chosenIndex: 0,
          action: { kind: 'no_action' }, rationale: 'r', tier: 'applied', status: 'applied', decidedBy: 'rules', modelCostUsd, modelCalled,
        },
      })
    await decision(`${s.workspaceId}:v1:r1`, 0.1, true)
    await decision(`${s.workspaceId}:v10:r1`, 0.7, true) // v10's
    await decision(s.taskOf[1], null, true) // about v1's task, unmeasured

    const scope = await loadVersionScope(s.workspaceId, 1)
    const spend = await versionSpend(scope, [])

    expect(spend).toEqual(
      expect.objectContaining({
        runsMeasuredUsd: 2,
        runsUnmeasured: 1,
        runsLive: 1,
        conductorMeasuredUsd: 0.02,
        conductorUnmeasuredCalls: 1,
        supervisorMeasuredUsd: 0.1,
        supervisorUnmeasuredCalls: 1,
        projectBudgetUsd: 20,
      }),
    )
    // 2 + 0.02 + 1 x CONDUCT cap + 0.1 + 1 x SUPERVISOR cap (both caps are $1 today: read them, never hard-code).
    const { CONDUCT_PER_CALL_CAP_USD, SUPERVISOR_PER_CALL_CAP_USD } = await import('@slave-of-ai/domain')
    expect(spend.versionUsd).toBeCloseTo(2.12 + CONDUCT_PER_CALL_CAP_USD + SUPERVISOR_PER_CALL_CAP_USD, 6)
    // The project figure is the one spend formula's, v10's money included.
    const { workspaceSpend } = await import('../../src/spend.js')
    expect(spend.projectSpentUsd).toBeCloseTo((await workspaceSpend(s.workspaceId)).spentUsd, 6)
  })
})

describe('versionTrail', () => {
  it("orders v1's events by seq, merges decisions and failed calls by time, and leaves v10's out", async (): Promise<void> => {
    const s = await seed()
    await appendEvent({ type: 'workspace.requirements_set', workspaceId: s.workspaceId, actor: 'system', payload: { version: 1, count: 2, setId: 'set1' } })
    await appendEvent({ type: 'workspace.requirements_set', workspaceId: s.workspaceId, actor: 'system', payload: { version: 10, count: 9, setId: 'set10' } })
    await appendEvent({ type: 'task.rework', workspaceId: s.workspaceId, taskId: s.taskOf[1], actor: 'system', payload: { reason: 'R1 fails: prints JSON', attempt: 0, verificationRound: 1 } })
    await appendEvent({ type: 'task.rework', workspaceId: s.workspaceId, taskId: s.taskOf[10], actor: 'system', payload: { reason: 'other', attempt: 1 } })
    await appendEvent({ type: 'guardrail.tripped', workspaceId: s.workspaceId, actor: 'system', payload: { guardrail: 'merge_failure', detail: 'goal v1 is accepted and autoMerge is off: merge it' } })
    await appendEvent({ type: 'guardrail.tripped', workspaceId: s.workspaceId, actor: 'system', payload: { guardrail: 'merge_failure', detail: 'goal v10 is accepted and autoMerge is off: merge it' } })
    await prisma.conductorCall.create({ data: { workspaceId: s.workspaceId, goalVersion: 1, stage: 'conduct', outcome: 'failed', reason: 'not JSON' } })

    const { entries, omitted } = await versionTrail(await loadVersionScope(s.workspaceId, 1))

    expect(omitted).toBe(0)
    expect(entries.map((e) => e.text)).toEqual([
      '2 requirements were extracted from the goal.',
      'pkg1: sent back for rework by verification round 1.',
      'Waiting: goal v1 is accepted and autoMerge is off: merge it',
      "The conductor's conduct call failed.",
    ])
    expect(entries[1]).toEqual(expect.objectContaining({ detail: 'R1 fails: prints JSON', detailBy: 'model', packageKey: 'pkg1' }))
    expect(entries[3]).toEqual(expect.objectContaining({ detail: 'not JSON', detailBy: 'system' }))
  })

  it('keeps the newest entries and counts the rest', async (): Promise<void> => {
    const s = await seed()
    for (let round = 1; round <= 4; round += 1) {
      await appendEvent({ type: 'workspace.verification_started', workspaceId: s.workspaceId, actor: 'system', payload: { version: 1, round, runId: `r${String(round)}` } })
    }
    const { entries, omitted } = await versionTrail(await loadVersionScope(s.workspaceId, 1), 3)
    expect(omitted).toBe(1)
    expect(entries.map((e) => e.text)).toEqual(['Verification round 2 started.', 'Verification round 3 started.', 'Verification round 4 started.'])
  })

  it('names the size decision, its reason as the model wrote it, and who holds each package', async (): Promise<void> => {
    const s = await seed()
    await prisma.supervisorDecision.create({
      data: {
        workspaceId: s.workspaceId, situationKind: 'conduct', subjectId: `${s.workspaceId}:v1`, situation: {}, candidates: [], chosenIndex: 0,
        action: { kind: 'conduct', goalVersion: 1, mode: 'single', packageKeys: ['pkg1'] }, rationale: 'fits one session', tier: 'applied', status: 'applied', decidedBy: 'model',
      },
    })
    await appendEvent({ type: 'workspace.conducted', workspaceId: s.workspaceId, actor: 'system', payload: { version: 1, mode: 'single', packages: ['pkg1'], decisionId: 'd', fallback: false } })

    const { entries } = await versionTrail(await loadVersionScope(s.workspaceId, 1))

    expect(entries.map((e) => e.text)).toEqual(['Size decision: one package does the whole goal.', 'Staffed: pkg1 by Alex Trail; no verifier recorded.'])
    expect(entries[0]).toEqual(expect.objectContaining({ detail: 'fits one session', detailBy: 'model' }))
  })
})

describe('versionQuestions', () => {
  it("lists every question on the version's package tasks with its first answer, and who answered", async (): Promise<void> => {
    const s = await seed()
    const asked = await prisma.slaveMessage.create({
      data: { workspaceId: s.workspaceId, taskId: s.taskOf[1], slaveId: s.slaveId, threadId: 't1', kind: 'question', body: 'Header row?', recipientRole: 'conductor', expectsReply: true, actor: 'slave' },
    })
    await prisma.slaveMessage.create({
      data: { workspaceId: s.workspaceId, taskId: s.taskOf[1], slaveId: s.slaveId, threadId: 't1', kind: 'answer', body: 'Yes.', replyToId: asked.id, actor: 'system' },
    })
    await prisma.slaveMessage.create({
      data: { workspaceId: s.workspaceId, taskId: s.taskOf[1], slaveId: s.slaveId, threadId: 't2', kind: 'question', body: 'Quote all?', expectsReply: true, actor: 'slave' },
    })
    await prisma.slaveMessage.create({
      data: { workspaceId: s.workspaceId, taskId: s.taskOf[10], slaveId: s.slaveId, threadId: 't3', kind: 'question', body: 'v10?', expectsReply: true, actor: 'slave' },
    })

    const questions = await versionQuestions(await loadVersionScope(s.workspaceId, 1))

    expect(questions).toEqual([
      expect.objectContaining({ id: asked.id, packageKey: 'pkg1', askedBy: 'Alex Trail', question: 'Header row?', answer: expect.objectContaining({ by: 'supervisor', text: 'Yes.' }) }),
      expect.objectContaining({ packageKey: 'pkg1', question: 'Quote all?', answer: null }),
    ])
  })
})
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run packages/control/test/integration/goal-report-trail.test.ts`. Expected: FAIL, the modules do not exist.

- [ ] **Step 3: Implement** `goalReportTrail.ts`:

```ts
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, type DomainEventType } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import {
  GOAL_REPORT_DETAIL_MAX_CHARS,
  GOAL_REPORT_TRAIL_MAX,
  SITUATION_LABEL,
  trimEvidence,
  type GoalReportAuthor,
  type GoalReportQuestion,
  type GoalReportTrailEntry,
  type SituationKind,
} from '@slave-of-ai/domain'

/** What every part of a version's report is scoped by: its package tasks (with the package key
 *  and the current seat), its delivery, and its verifier (plan D6). */
export interface VersionScope {
  readonly workspaceId: string
  readonly goalVersion: number
  readonly deliveryId: string | null
  readonly tasks: readonly { readonly taskId: string; readonly packageKey: string; readonly seat: string | null }[]
  readonly verifier: string | null
}

/** Plan D5: the Supervisor subjects that are about this version -- exactly `<ws>:v<n>` (the conduct
 *  decision) or anything under `<ws>:v<n>:` (per round, per stop). A bare `startsWith('<ws>:v1')`
 *  would also take v10's. */
export function versionSubject(workspaceId: string, goalVersion: number): { readonly equals: string; readonly prefix: string } {
  const equals = `${workspaceId}:v${String(goalVersion)}`
  return { equals, prefix: `${equals}:` }
}

/** `slaveId -> the person's name`, for every id given; a seat that is gone is simply absent. */
export async function seatNames(slaveIds: readonly (string | null)[]): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(slaveIds.filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  const rows = await prisma.slave.findMany({ where: { id: { in: ids } }, select: { id: true, person: { select: { name: true } } } })
  return new Map(rows.map((row) => [row.id, row.person.name] as const))
}

export async function loadVersionScope(workspaceId: string, goalVersion: number): Promise<VersionScope> {
  const [packages, delivery] = await Promise.all([
    prisma.workPackage.findMany({
      where: { workspaceId, goalVersion },
      select: { key: true, tasks: { select: { id: true, assigneeId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    }),
    prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { id: true, verifierSlaveId: true } }),
  ])
  const tasks = packages
    .flatMap((pkg) => pkg.tasks.map((task) => ({ taskId: task.id, packageKey: pkg.key, assigneeId: task.assigneeId })))
    .sort((a, b) => (a.packageKey < b.packageKey ? -1 : a.packageKey > b.packageKey ? 1 : a.taskId < b.taskId ? -1 : 1))
  const names = await seatNames([...tasks.map((task) => task.assigneeId), delivery?.verifierSlaveId ?? null])
  return {
    workspaceId,
    goalVersion,
    deliveryId: delivery?.id ?? null,
    tasks: tasks.map((task) => ({ taskId: task.taskId, packageKey: task.packageKey, seat: task.assigneeId === null ? null : (names.get(task.assigneeId) ?? null) })),
    verifier: delivery?.verifierSlaveId == null ? null : (names.get(delivery.verifierSlaveId) ?? null),
  }
}

const TASK_TRAIL_TYPES = [
  'task_started',
  'task_verify_failed',
  'task_review_rejected',
  'task_review_approved',
  'task_ownership_violated',
  'task_merge_failed',
  'task_rework',
  'task_done',
  'task_failed',
  'task_cancelled',
] as const

const VERSION_TRAIL_TYPES = [
  'workspace_goal_set',
  'workspace_requirements_set',
  'workspace_conducted',
  'workspace_goal_waiting',
  'workspace_verification_started',
  'workspace_verified',
  'workspace_goal_accepted',
  'workspace_goal_needs_human',
  'workspace_goal_retried',
  'workspace_goal_merged',
  'workspace_goal_abandoned',
] as const

type Payload = Record<string, unknown>
const str = (p: Payload, key: string): string | null => (typeof p[key] === 'string' && p[key] !== '' ? (p[key] as string) : null)
const num = (p: Payload, key: string): number => (typeof p[key] === 'number' ? (p[key] as number) : 0)
const strs = (p: Payload, key: string): readonly string[] => (Array.isArray(p[key]) ? (p[key] as unknown[]).filter((v): v is string => typeof v === 'string') : [])
const times = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`

interface Draft {
  readonly text: string
  readonly detail?: string | null
  readonly detailBy?: GoalReportAuthor
}

/** One event as a trail sentence (plan D6), or null for a payload this build cannot read. The
 *  sentences name ids, keys and counts only; free text goes in `detail`, labelled. */
function eventDraft(type: DomainEventType, p: Payload, pkg: string | null): Draft | null {
  const on = pkg === null ? '' : `${pkg}: `
  switch (type) {
    case 'workspace.goal_set': {
      const request = str(p, 'request')
      return request === null ? { text: 'The goal was set.' } : { text: 'The goal was set from a change request.', detail: request, detailBy: 'person' }
    }
    case 'workspace.requirements_set':
      return { text: `${times(num(p, 'count'), 'requirement was', 'requirements were')} extracted from the goal.` }
    case 'workspace.conducted': {
      const packages = strs(p, 'packages')
      const what = str(p, 'mode') === 'single' ? 'one package does the whole goal' : `partitioned into ${String(packages.length)} packages (${packages.join(', ')})`
      return { text: `Size decision: ${what}${p['fallback'] === true ? ", by default, because the conductor's answers were unusable" : ''}.` }
    }
    case 'workspace.goal_waiting':
      return { text: typeof p['waitingOn'] === 'number' ? `Waited for goal v${String(p['waitingOn'])} to reach the base branch.` : "Waited for the planner's board to go quiet." }
    case 'workspace.verification_started':
      return { text: `Verification round ${String(num(p, 'round'))} started.` }
    case 'workspace.verified': {
      const failed = strs(p, 'failedKeys')
      return {
        text:
          `Verification round ${String(num(p, 'round'))}: ${String(num(p, 'pass'))} pass, ${String(num(p, 'fail'))} fail, ` +
          `${String(num(p, 'unverifiable'))} unverifiable${failed.length === 0 ? '' : ` (failing: ${failed.join(', ')})`}.`,
      }
    }
    case 'workspace.goal_accepted':
      return { text: `Accepted: every requirement passed, after ${times(num(p, 'rounds'), 'round', 'rounds')}.` }
    case 'workspace.goal_needs_human':
      return { text: 'Stopped for a person.', detail: str(p, 'reason'), detailBy: 'system' }
    case 'workspace.goal_retried':
      return {
        text:
          p['cause'] === 'branch_moved'
            ? `The integration branch moved after acceptance; verifying again after round ${String(num(p, 'round'))}.`
            : `A person sent it round again after round ${String(num(p, 'round'))}.`,
      }
    case 'workspace.goal_merged': {
      const commit = (str(p, 'commit') ?? '').slice(0, 12)
      return { text: `Merged into ${str(p, 'into') ?? 'the base branch'}${p['by'] === 'human' ? ' by a person' : ''} (commit ${commit}).` }
    }
    case 'workspace.goal_abandoned':
      return { text: `Abandoned by a person; ${times(strs(p, 'cancelled').length, 'package task', 'package tasks')} cancelled.` }
    case 'guardrail.tripped':
      return { text: `Waiting: ${str(p, 'detail') ?? ''}` }
    case 'task.started':
      return { text: `${on}work started.` }
    case 'task.verify_failed':
      return { text: `${on}the verify command ${str(p, 'command') ?? '?'} exited ${String(num(p, 'exitCode'))}${str(p, 'stage') === null ? '' : ` (stage ${str(p, 'stage') ?? ''})`}.` }
    case 'task.review_rejected':
      return { text: `${on}the review rejected the work (attempt ${String(num(p, 'attempt'))}).`, detail: str(p, 'reason'), detailBy: 'model' }
    case 'task.review_approved':
      return { text: `${on}the review approved the work.` }
    case 'task.ownership_violated': {
      const files = strs(p, 'files')
      const total = num(p, 'total')
      return { text: `${on}the run changed ${times(total, 'file', 'files')} its package does not own: ${files.slice(0, 10).join(', ')}${total > 10 ? ', …' : ''}.` }
    }
    case 'task.merge_failed':
      return { text: `${on}the merge failed.`, detail: str(p, 'reason'), detailBy: 'system' }
    case 'task.rework': {
      const round = num(p, 'verificationRound')
      // A verification rework's reason quotes the verifier's check, output and reason: the model's.
      return round > 0
        ? { text: `${on}sent back for rework by verification round ${String(round)}.`, detail: str(p, 'reason'), detailBy: 'model' }
        : { text: `${on}sent back for rework (attempt ${String(num(p, 'attempt'))}).`, detail: str(p, 'reason'), detailBy: 'system' }
    }
    case 'task.done': {
      const files = typeof p['filesTotal'] === 'number' ? ` (${times(num(p, 'filesTotal'), 'file', 'files')})` : ''
      return { text: `${on}merged into the integration branch${files}.` }
    }
    case 'task.failed':
      return { text: `${on}failed.`, detail: str(p, 'reason'), detailBy: 'system' }
    case 'task.cancelled':
      return { text: `${on}cancelled.`, detail: str(p, 'reason'), detailBy: 'system' }
    default:
      return null
  }
}

const entryOf = (at: Date, draft: Draft, packageKey: string | null): GoalReportTrailEntry => {
  const detail = draft.detail ?? null
  return {
    at: at.toISOString(),
    text: draft.text,
    detail: detail === null ? null : trimEvidence(detail, GOAL_REPORT_DETAIL_MAX_CHARS),
    detailBy: detail === null ? null : (draft.detailBy ?? 'system'),
    packageKey,
  }
}

/**
 * The version's decision trail (plan D6), oldest first: its events by `seq`, with its failed
 * conductor calls and its Supervisor decisions merged in by time (events first on a tie). The
 * conduct decision's rationale rides on the `workspace.conducted` entry, followed by one staffing
 * entry. Only the newest `max` entries are kept, and `omitted` counts the rest.
 */
export async function versionTrail(
  scope: VersionScope,
  max: number = GOAL_REPORT_TRAIL_MAX,
): Promise<{ readonly entries: readonly GoalReportTrailEntry[]; readonly omitted: number }> {
  const { workspaceId, goalVersion } = scope
  const keyOf = new Map(scope.tasks.map((task) => [task.taskId, task.packageKey] as const))
  const taskIds = [...keyOf.keys()]
  const subject = versionSubject(workspaceId, goalVersion)
  const [events, calls, decisions, conduct] = await Promise.all([
    prisma.executionEvent.findMany({
      where: {
        workspaceId,
        OR: [
          { taskId: { in: taskIds }, type: { in: [...TASK_TRAIL_TYPES] } },
          { type: { in: [...VERSION_TRAIL_TYPES] }, payload: { path: ['version'], equals: goalVersion } },
          // The goal pass's own trips name the version first (`goal v<n> is accepted ...`, `goal v<n> could not be merged ...`).
          { type: 'guardrail_tripped', payload: { path: ['detail'], string_starts_with: `goal v${String(goalVersion)} ` } },
        ],
      },
      orderBy: { seq: 'asc' },
      select: { ts: true, type: true, taskId: true, payload: true },
    }),
    prisma.conductorCall.findMany({
      where: { workspaceId, goalVersion, outcome: 'failed' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { stage: true, reason: true, createdAt: true },
    }),
    prisma.supervisorDecision.findMany({
      where: {
        workspaceId,
        situationKind: { not: 'conduct' },
        OR: [{ subjectId: subject.equals }, { subjectId: { startsWith: subject.prefix } }, { subjectId: { in: taskIds } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { situationKind: true, action: true, rationale: true, status: true, decidedBy: true, createdAt: true },
    }),
    prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'conduct', subjectId: subject.equals },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { rationale: true, decidedBy: true },
    }),
  ])

  const timeline: { readonly at: Date; readonly rank: number; readonly order: number; readonly entry: GoalReportTrailEntry }[] = []
  events.forEach((row, index) => {
    const type = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType)
    const pkg = row.taskId === null ? null : (keyOf.get(row.taskId) ?? null)
    const draft = eventDraft(type, (row.payload ?? {}) as Payload, pkg)
    if (draft === null) return
    if (type === 'workspace.conducted') {
      const fallback = (row.payload as Payload)['fallback'] === true
      const withReason: Draft = conduct === null ? draft : { ...draft, detail: conduct.rationale, detailBy: fallback || conduct.decidedBy !== 'model' ? 'system' : 'model' }
      timeline.push({ at: row.ts, rank: 0, order: index, entry: entryOf(row.ts, withReason, null) })
      const seats = scope.tasks.map((task) => `${task.packageKey} by ${task.seat ?? 'nobody'}`).join(', ')
      const staffing = `Staffed: ${seats === '' ? 'no package' : seats}; ${scope.verifier === null ? 'no verifier recorded' : `verified by ${scope.verifier}`}.`
      timeline.push({ at: row.ts, rank: 0, order: index + 0.5, entry: entryOf(row.ts, { text: staffing }, null) })
      return
    }
    timeline.push({ at: row.ts, rank: 0, order: index, entry: entryOf(row.ts, draft, pkg) })
  })
  calls.forEach((call, index) => {
    timeline.push({ at: call.createdAt, rank: 1, order: index, entry: entryOf(call.createdAt, { text: `The conductor's ${call.stage} call failed.`, detail: call.reason, detailBy: 'system' }, null) })
  })
  decisions.forEach((row, index) => {
    const kind = (row.action as { readonly kind?: unknown } | null)?.kind
    const label = SITUATION_LABEL[row.situationKind as SituationKind] ?? row.situationKind
    const text = `Supervisor: ${label}; ${typeof kind === 'string' ? kind.replaceAll('_', ' ') : 'an unreadable action'} (${row.status}${row.decidedBy === 'model' ? ', decided by the model' : ''}).`
    timeline.push({ at: row.createdAt, rank: 2, order: index, entry: entryOf(row.createdAt, { text, detail: row.rationale, detailBy: row.decidedBy === 'model' ? 'model' : 'system' }, null) })
  })
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime() || a.rank - b.rank || a.order - b.order)
  const all = timeline.map((item) => item.entry)
  const omitted = Math.max(0, all.length - max)
  return { entries: all.slice(omitted), omitted }
}

/** Every question on the version's package tasks, oldest first, with its first answer (plan D6).
 *  Who answered comes from the answer row's `actor`: `human` is a person, `system` the Supervisor's
 *  sourced answer path, `slave` a seat's `<slave-answer>`. */
export async function versionQuestions(scope: VersionScope): Promise<readonly GoalReportQuestion[]> {
  const keyOf = new Map(scope.tasks.map((task) => [task.taskId, task.packageKey] as const))
  const rows = await prisma.slaveMessage.findMany({
    where: { workspaceId: scope.workspaceId, taskId: { in: [...keyOf.keys()] }, kind: 'question' },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      taskId: true,
      slaveId: true,
      body: true,
      createdAt: true,
      replies: { where: { kind: 'answer' }, orderBy: { seq: 'asc' }, take: 1, select: { body: true, actor: true, createdAt: true } },
    },
  })
  const names = await seatNames(rows.map((row) => row.slaveId))
  return rows.map((row) => {
    const answer = row.replies[0]
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      packageKey: row.taskId === null ? null : (keyOf.get(row.taskId) ?? null),
      askedBy: names.get(row.slaveId) ?? null,
      question: trimEvidence(row.body, GOAL_REPORT_DETAIL_MAX_CHARS),
      answer:
        answer === undefined
          ? null
          : {
              at: answer.createdAt.toISOString(),
              by: answer.actor === 'human' ? 'person' : answer.actor === 'system' ? 'supervisor' : 'slave',
              text: trimEvidence(answer.body, GOAL_REPORT_DETAIL_MAX_CHARS),
            },
    }
  })
}
```

(Check that `SituationKind` is exported from `@slave-of-ai/domain`: `grep -n "export type SituationKind" packages/domain/src/supervisor/situations.ts`. Check the `string_starts_with` Json filter against the generated client: `grep -n "string_starts_with" node_modules/.prisma/client/index.d.ts | head -1`. If the generated name differs, use it.)

`goalReportSpend.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { CONDUCT_PER_CALL_CAP_USD, NON_TERMINAL_RUN_STATUSES, SUPERVISOR_PER_CALL_CAP_USD, type GoalReportSpend } from '@slave-of-ai/domain'
import { versionSubject, type VersionScope } from './goalReportTrail.js'
import { workspaceSpend } from './spend.js'

const LIVE: ReadonlySet<string> = new Set(NON_TERMINAL_RUN_STATUSES)

/**
 * What one goal version cost (plan D5): its package runs and its verification runs (measured cost
 * summed; a finished run with no cost is unmeasured, a live one's cost is not known yet -- both
 * counted, neither summed, `sumSpend`'s rule), its conductor calls and the Supervisor decisions
 * about it (an unmeasured one charged at its cap, `workspaceSpend`'s rule). The project figure is
 * `workspaceSpend` itself: the guardrail's own number, not a second formula.
 */
export async function versionSpend(scope: VersionScope, questionIds: readonly string[]): Promise<GoalReportSpend> {
  const { workspaceId, goalVersion } = scope
  const taskIds = scope.tasks.map((task) => task.taskId)
  const subject = versionSubject(workspaceId, goalVersion)
  const [runs, calls, decisions, project, workspace] = await Promise.all([
    prisma.slaveRun.findMany({
      where: { OR: [{ taskId: { in: taskIds } }, ...(scope.deliveryId === null ? [] : [{ goalDeliveryId: scope.deliveryId }])] },
      orderBy: { id: 'asc' },
      select: { costUsd: true, status: true },
    }),
    prisma.conductorCall.findMany({ where: { workspaceId, goalVersion }, orderBy: { id: 'asc' }, select: { modelCostUsd: true, unmeasured: true } }),
    prisma.supervisorDecision.findMany({
      where: { workspaceId, OR: [{ subjectId: subject.equals }, { subjectId: { startsWith: subject.prefix } }, { subjectId: { in: [...taskIds, ...questionIds] } }] },
      orderBy: { id: 'asc' },
      select: { modelCostUsd: true, modelCalled: true },
    }),
    workspaceSpend(workspaceId),
    prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { budgetUsd: true } }),
  ])
  const runsMeasuredUsd = runs.reduce((total, run) => total + (run.costUsd ?? 0), 0)
  const runsLive = runs.filter((run) => run.costUsd === null && LIVE.has(run.status)).length
  const runsUnmeasured = runs.filter((run) => run.costUsd === null && !LIVE.has(run.status)).length
  const conductorMeasuredUsd = calls.reduce((total, call) => total + (call.modelCostUsd ?? 0), 0)
  const conductorUnmeasuredCalls = calls.filter((call) => call.unmeasured).length
  const supervisorMeasuredUsd = decisions.reduce((total, row) => total + (row.modelCostUsd ?? 0), 0)
  const supervisorUnmeasuredCalls = decisions.filter((row) => row.modelCalled && row.modelCostUsd === null).length
  return {
    runsMeasuredUsd,
    runsUnmeasured,
    runsLive,
    conductorMeasuredUsd,
    conductorUnmeasuredCalls,
    supervisorMeasuredUsd,
    supervisorUnmeasuredCalls,
    versionUsd:
      runsMeasuredUsd +
      conductorMeasuredUsd +
      conductorUnmeasuredCalls * CONDUCT_PER_CALL_CAP_USD +
      supervisorMeasuredUsd +
      supervisorUnmeasuredCalls * SUPERVISOR_PER_CALL_CAP_USD,
    projectSpentUsd: project.spentUsd,
    projectBudgetUsd: workspace.budgetUsd,
  }
}
```

- [ ] **Step 4: Run** `npx vitest run packages/control/test/integration/goal-report-trail.test.ts`, then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(report): a goal version's spend, decision trail and questions, from recorded rows`, with the trailer.

---

### Task 4: `loadGoalReport`, the whole report for every state

**Files:**
- Create: `packages/control/src/goalReport.ts`
- Modify: `packages/control/src/index.ts` (export it after the Task 3 lines)
- Test: `packages/control/test/integration/goal-report.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 types; Task 3's `loadVersionScope`, `seatNames`, `versionTrail`, `versionQuestions`, `versionSpend`; `requirementItemsSchema`, `actionSchema` (`@slave-of-ai/domain`).
- Produces:
  - `export async function reportVersions(workspaceId: string): Promise<readonly number[]>`: the versions with a `RequirementSet` or a `GoalDelivery`, ascending
  - `export async function latestReportVersion(workspaceId: string): Promise<number | null>`
  - `export async function loadGoalReport(workspaceId: string, goalVersion: number): Promise<Result<GoalReport, ControlRefusal>>`. It refuses `workspace_not_found`, and `goal_version_not_found` for a version with neither row (which includes every version of a planned project).

- [ ] **Step 1: Failing tests** (`goal-report.test.ts`):

```ts
/**
 * Conductor Plan 5, Task 4: one goal version's whole report, for every state it can be in (plan D1,
 * D2, D4), read from seeded rows -- no git, no model.
 */
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { latestReportVersion, loadGoalReport, reportVersions } from '../../src/goalReport.js'

const TEMPLATE_NAME = 'Goal Report Test Backend Persona'
let templateIds: string[] = []

interface World {
  readonly workspaceId: string
  readonly alexSeat: string
  readonly samSeat: string
}

async function world(): Promise<World> {
  const template = await prisma.slaveTemplate.create({ data: { name: TEMPLATE_NAME, role: 'backend', capabilities: [] } })
  templateIds.push(template.id)
  const workspace = await prisma.workspace.create({
    data: { name: 'Goal Report', repoPath: '/tmp/goal-report', baseBranch: 'main', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted', goalVersion: 1, goal: 'Add CSV and JSON modes.' },
  })
  await prisma.goalVersion.create({ data: { workspaceId: workspace.id, version: 1, text: 'Add CSV and JSON modes.', sha256: 'x' } })
  await prisma.requirementSet.create({
    data: { workspaceId: workspace.id, goalVersion: 1, items: [{ key: 'R1', text: 'csv mode', source: 'Add CSV.' }, { key: 'R2', text: 'json mode', source: 'Add JSON.' }] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const alex = await prisma.person.create({ data: { name: 'Alex Report', templateId: template.id } })
  const sam = await prisma.person.create({ data: { name: 'Sam Report' } })
  const alexSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', runtimeRoles: ['implementer'], personId: alex.id } })
  const samSeat = await prisma.slave.create({ data: { teamId: team.id, role: 'reviewer', runtimeRoles: ['verifier'], personId: sam.id } })
  return { workspaceId: workspace.id, alexSeat: alexSeat.id, samSeat: samSeat.id }
}

/** Conducted as one package holding both requirements, on a delivery in `status`. */
async function conduct(w: World, data: Partial<{ status: 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned'; mergedAt: Date; verifiedCommit: string; needsHumanReason: string; round: number }> = {}) {
  const delivery = await prisma.goalDelivery.create({
    data: {
      workspaceId: w.workspaceId, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1-x', baseCommit: 'b'.repeat(40), verifierSlaveId: w.samSeat,
      status: data.status ?? 'integrating', mergedAt: data.mergedAt ?? null, verifiedCommit: data.verifiedCommit ?? null, needsHumanReason: data.needsHumanReason ?? null, round: data.round ?? 0,
      acceptedAt: data.status === 'accepted' ? new Date('2026-09-29T10:05:00Z') : null,
    },
  })
  await prisma.supervisorDecision.create({
    data: {
      workspaceId: w.workspaceId, situationKind: 'conduct', subjectId: `${w.workspaceId}:v1`, situation: {}, candidates: [], chosenIndex: 0,
      action: { kind: 'conduct', goalVersion: 1, mode: 'single', packageKeys: ['report'] }, rationale: 'fits one session', tier: 'applied', status: 'applied', decidedBy: 'model',
    },
  })
  await appendEvent({ type: 'workspace.conducted', workspaceId: w.workspaceId, actor: 'system', payload: { version: 1, mode: 'single', packages: ['report'], decisionId: 'd', fallback: false } })
  const pkg = await prisma.workPackage.create({
    data: { workspaceId: w.workspaceId, goalVersion: 1, key: 'report', title: 'Report modes', requirementKeys: ['R1', 'R2'], ownedPaths: ['src/**'], interface: '', templateId: templateIds.at(-1) ?? 'tpl' },
  })
  const task = await prisma.task.create({
    data: { workspaceId: w.workspaceId, title: 'Report modes', description: 'x', status: 'done', requiredRole: 'implementer', maxAttempts: 3, workPackageId: pkg.id, goalVersion: 1, assigneeId: w.alexSeat, integratedAt: new Date() },
  })
  return { deliveryId: delivery.id, packageId: pkg.id, taskId: task.id }
}

/** One verification round: a run by Sam at `tip`, with one row per key. */
async function round(w: World, deliveryId: string, n: number, tip: string, statuses: Readonly<Record<'R1' | 'R2', 'pass' | 'fail' | 'unverifiable'>>): Promise<string> {
  const run = await prisma.slaveRun.create({
    data: { slaveId: w.samSeat, kind: 'verification', status: 'succeeded', goalDeliveryId: deliveryId, verificationTip: tip, terminalAt: new Date(`2026-09-29T10:0${String(n)}:00Z`) },
  })
  for (const key of ['R1', 'R2'] as const) {
    await prisma.verificationResult.create({
      data: {
        workspaceId: w.workspaceId, goalDeliveryId: deliveryId, goalVersion: 1, round: n, runId: run.id, key, status: statuses[key],
        check: `check ${key}`, output: `out ${key} r${String(n)}`, reason: statuses[key] === 'pass' ? '' : `${key} broke`,
      },
    })
  }
  return run.id
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "ConductorCall", "VerificationResult", "RunReport", "SlaveRun", "Task", "WorkPackage", "GoalDelivery", "RequirementSet", "GoalVersion", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterEach(async (): Promise<void> => {
  await prisma.slaveTemplate.deleteMany({ where: { id: { in: templateIds } } })
  templateIds = []
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('loadGoalReport', () => {
  it('refuses an unknown workspace, and a version with no requirements and no delivery', async (): Promise<void> => {
    expect(await loadGoalReport('nope', 1)).toEqual({ ok: false, error: { kind: 'workspace_not_found', workspaceId: 'nope' } })
    const w = await world()
    expect(await loadGoalReport(w.workspaceId, 2)).toEqual({ ok: false, error: { kind: 'goal_version_not_found', workspaceId: w.workspaceId, goalVersion: 2 } })
  })

  it('reports a version that has requirements and nothing else as not conducted', async (): Promise<void> => {
    const w = await world()
    const report = await loadGoalReport(w.workspaceId, 1)
    expect(report.ok && report.value).toEqual(
      expect.objectContaining({
        state: 'not_conducted',
        delivery: null,
        decision: null,
        goal: 'Add CSV and JSON modes.',
        packages: [],
        rounds: [],
        requirements: [
          { key: 'R1', text: 'csv mode', source: 'Add CSV.', packageKey: null, verdict: null, history: [] },
          { key: 'R2', text: 'json mode', source: 'Add JSON.', packageKey: null, verdict: null, history: [] },
        ],
      }),
    )
    expect(await reportVersions(w.workspaceId)).toEqual([1])
    expect(await latestReportVersion(w.workspaceId)).toBe(1)
  })

  it('reports a merged version: latest verdicts with history, rounds, the package with its files, the hand merge, the verifier', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w, { status: 'accepted', mergedAt: new Date('2026-09-29T10:06:00Z'), verifiedCommit: 'c'.repeat(40), round: 2 })
    await round(w, c.deliveryId, 1, 'a'.repeat(40), { R1: 'pass', R2: 'fail' })
    const r2 = await round(w, c.deliveryId, 2, 'c'.repeat(40), { R1: 'pass', R2: 'pass' })
    const impl = await prisma.slaveRun.create({ data: { taskId: c.taskId, slaveId: w.alexSeat, status: 'succeeded' } })
    await prisma.runReport.create({
      data: { runId: impl.id, taskId: c.taskId, workPackageId: c.packageId, report: { requirements: [{ key: 'R1', status: 'done', evidence: 'e' }, { key: 'R2', status: 'partial', evidence: '' }], filesTouched: ['src/csv.py'], workflow: [{ step: 1, done: true, note: '' }, { step: 2, done: false, note: '' }], questions: [] } },
    })
    await appendEvent({ type: 'task.done', workspaceId: w.workspaceId, taskId: c.taskId, actor: 'system', payload: { branch: 'b1', files: ['src/csv.py'], filesTotal: 1 } })
    await appendEvent({ type: 'task.done', workspaceId: w.workspaceId, taskId: c.taskId, actor: 'system', payload: { branch: 'b1', files: ['src/json.py', 'src/csv.py'], filesTotal: 2 } })
    await appendEvent({ type: 'workspace.goal_merged', workspaceId: w.workspaceId, actor: 'human', payload: { version: 1, branch: 'slaveofai/goal-v1-x', into: 'main', commit: 'd'.repeat(40), by: 'human' } })

    const result = await loadGoalReport(w.workspaceId, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const report = result.value
    expect(report.state).toBe('merged')
    expect(report.delivery).toEqual(expect.objectContaining({ merge: { by: 'human', commit: 'd'.repeat(40), into: 'main' }, verifiedCommit: 'c'.repeat(40), baseBranch: 'main', roundCap: 3 }))
    expect(report.decision).toEqual(expect.objectContaining({ mode: 'single', reason: 'fits one session', decidedBy: 'model', fallback: false }))
    expect(report.requirements?.[1]).toEqual({
      key: 'R2', text: 'json mode', source: 'Add JSON.', packageKey: 'report',
      verdict: { round: 2, runId: r2, status: 'pass', check: 'check R2', output: 'out R2 r2', reason: '' },
      history: [{ round: 1, status: 'fail' }, { round: 2, status: 'pass' }],
    })
    expect(report.rounds.map((r) => [r.round, r.verifier, r.commit, r.pass, r.fail])).toEqual([
      [1, 'Sam Report', 'a'.repeat(40), 1, 1],
      [2, 'Sam Report', 'c'.repeat(40), 2, 0],
    ])
    expect(report.packages).toEqual([
      expect.objectContaining({
        key: 'report', seat: 'Alex Report', persona: TEMPLATE_NAME, taskStatus: 'done', integrated: true,
        mergedFiles: ['src/csv.py', 'src/json.py'], mergedFilesTruncated: false, reportedFiles: ['src/csv.py'],
        report: { runId: impl.id, requirements: [{ key: 'R1', status: 'done', evidence: 'e' }, { key: 'R2', status: 'partial', evidence: '' }], workflowDone: 1, workflowTotal: 2 },
        implementationRuns: 1,
      }),
    ])
    expect(report.verifier).toBe('Sam Report')
    // The newest fact: the seeded merge stamp or the newest event, whichever the clock made later.
    expect(report.asOf).toBe([report.trail.at(-1)?.at ?? '', '2026-09-29T10:06:00.000Z'].sort().at(-1))
    expect(report.trail.map((e) => e.text)).toContain('Merged into main by a person (commit dddddddddddd).')
  })

  it('reports a stopped version with its reason and the unverifiable verdict', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w, { status: 'needs_human', round: 1, needsHumanReason: 'only unverifiable items: R2' })
    await round(w, c.deliveryId, 1, 'a'.repeat(40), { R1: 'pass', R2: 'unverifiable' })
    const report = await loadGoalReport(w.workspaceId, 1)
    expect(report.ok && report.value.state).toBe('needs_human')
    expect(report.ok && report.value.delivery?.needsHumanReason).toBe('only unverifiable items: R2')
    expect(report.ok && report.value.requirements?.[1]?.verdict?.status).toBe('unverifiable')
  })

  it('reports an abandoned version with when it was abandoned', async (): Promise<void> => {
    const w = await world()
    await conduct(w, { status: 'abandoned' })
    const event = await appendEvent({ type: 'workspace.goal_abandoned', workspaceId: w.workspaceId, actor: 'human', payload: { version: 1, cancelled: [] } })
    const report = await loadGoalReport(w.workspaceId, 1)
    expect(report.ok && report.value.state).toBe('abandoned')
    expect(report.ok && report.value.delivery?.abandonedAt).toBe(event.ts.toISOString())
  })

  it('says a package merged before Plan 5 has no recorded files', async (): Promise<void> => {
    const w = await world()
    const c = await conduct(w)
    await appendEvent({ type: 'task.done', workspaceId: w.workspaceId, taskId: c.taskId, actor: 'system', payload: { branch: 'b1' } })
    const report = await loadGoalReport(w.workspaceId, 1)
    expect(report.ok && report.value.packages[0]?.mergedFiles).toBe(null)
  })
})
```

(The `SlaveTemplate` create's required columns: check `awk '/^model SlaveTemplate \{/,/^\}/' packages/db/prisma/schema.prisma` and add whatever the schema requires. The name is file-unique, and the file deletes its own rows by id.)

- [ ] **Step 2: Run to see them fail.** `npx vitest run packages/control/test/integration/goal-report.test.ts`. Expected: FAIL, no module.

- [ ] **Step 3: Implement** `goalReport.ts`:

```ts
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  actionSchema,
  err,
  ok,
  requirementItemsSchema,
  type GoalReport,
  type GoalReportPackage,
  type GoalReportRequirement,
  type GoalReportRound,
  type GoalReportState,
  type GoalReportVerdictStatus,
  type GoalReportWorkerReport,
  type Result,
} from '@slave-of-ai/domain'
import { loadVersionScope, seatNames, versionQuestions, versionTrail } from './goalReportTrail.js'
import { versionSpend } from './goalReportSpend.js'
import type { ControlRefusal } from './refusal.js'

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The workspace's versions that have a report (spec R10: one per goal version): every version
 *  with requirements or a delivery, ascending. A planned project has none. */
export async function reportVersions(workspaceId: string): Promise<readonly number[]> {
  const [sets, deliveries] = await Promise.all([
    prisma.requirementSet.findMany({ where: { workspaceId }, select: { goalVersion: true } }),
    prisma.goalDelivery.findMany({ where: { workspaceId }, select: { goalVersion: true } }),
  ])
  return [...new Set([...sets, ...deliveries].map((row) => row.goalVersion))].sort((a, b) => a - b)
}

export async function latestReportVersion(workspaceId: string): Promise<number | null> {
  return (await reportVersions(workspaceId)).at(-1) ?? null
}

async function versionEvent(
  workspaceId: string,
  type: 'workspace_conducted' | 'workspace_goal_merged' | 'workspace_goal_abandoned',
  version: number,
): Promise<{ readonly ts: Date; readonly payload: Record<string, unknown> } | null> {
  const row = await prisma.executionEvent.findFirst({
    where: { workspaceId, type, payload: { path: ['version'], equals: version } },
    orderBy: { seq: 'desc' },
    select: { ts: true, payload: true },
  })
  return row === null ? null : { ts: row.ts, payload: (row.payload ?? {}) as Record<string, unknown> }
}

/** A stored `RunReport.report`, read defensively (the `listGoalVersions` rule for a `Json` column):
 *  a row a later build wrote differently degrades to fewer facts, never to a thrown read. */
function readWorkerReport(runId: string, value: Prisma.JsonValue): { readonly report: GoalReportWorkerReport; readonly files: readonly string[] } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const requirements = (Array.isArray(row['requirements']) ? row['requirements'] : []).flatMap((raw): GoalReportWorkerReport['requirements'][number][] => {
    if (raw === null || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const status = item['status']
    if (typeof item['key'] !== 'string' || (status !== 'done' && status !== 'partial' && status !== 'not_done')) return []
    return [{ key: item['key'], status, evidence: typeof item['evidence'] === 'string' ? item['evidence'] : '' }]
  })
  const workflow = (Array.isArray(row['workflow']) ? row['workflow'] : []).filter((raw): raw is Record<string, unknown> => raw !== null && typeof raw === 'object')
  const files = (Array.isArray(row['filesTouched']) ? row['filesTouched'] : []).filter((file): file is string => typeof file === 'string')
  return {
    report: { runId, requirements, workflowDone: workflow.filter((step) => step['done'] === true).length, workflowTotal: workflow.length },
    files: [...files].sort(byText),
  }
}

/**
 * One goal version's report (spec R10, plan D1), read from recorded rows only: no model, no git.
 * Works for every state (plan D2) and for a version that has requirements but no delivery yet.
 * `goal_version_not_found` for a version with neither, which includes every version of a planned
 * project.
 */
export async function loadGoalReport(workspaceId: string, goalVersion: number): Promise<Result<GoalReport, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, baseBranch: true, verificationRoundCap: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const versions = await reportVersions(workspaceId)
  if (!versions.includes(goalVersion)) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })

  const scope = await loadVersionScope(workspaceId, goalVersion)
  const [goalRow, set, delivery, decisionRow, conducted, merged, abandoned, packageRows] = await Promise.all([
    prisma.goalVersion.findUnique({ where: { workspaceId_version: { workspaceId, version: goalVersion } }, select: { text: true } }),
    prisma.requirementSet.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { items: true } }),
    prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } } }),
    prisma.supervisorDecision.findFirst({
      where: { workspaceId, situationKind: 'conduct', subjectId: `${workspaceId}:v${String(goalVersion)}` },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true, rationale: true, decidedBy: true, createdAt: true },
    }),
    versionEvent(workspaceId, 'workspace_conducted', goalVersion),
    versionEvent(workspaceId, 'workspace_goal_merged', goalVersion),
    versionEvent(workspaceId, 'workspace_goal_abandoned', goalVersion),
    prisma.workPackage.findMany({
      where: { workspaceId, goalVersion },
      include: {
        tasks: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, status: true, integratedAt: true, assigneeId: true } },
        reports: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { runId: true, report: true } },
      },
    }),
  ])

  // Verification (plan D4): per round, the rows of the run that wrote last count.
  const results =
    delivery === null
      ? []
      : await prisma.verificationResult.findMany({
          where: { goalDeliveryId: delivery.id },
          orderBy: [{ round: 'asc' }, { createdAt: 'asc' }, { runId: 'asc' }, { key: 'asc' }],
        })
  const writerOf = new Map<number, string>()
  for (const row of results) writerOf.set(row.round, row.runId)
  const counted = results.filter((row) => writerOf.get(row.round) === row.runId)
  const verificationRuns = await prisma.slaveRun.findMany({
    where: { id: { in: [...new Set(writerOf.values())] } },
    select: { id: true, slaveId: true, verificationTip: true, startedAt: true, terminalAt: true },
  })

  const packageTasks = packageRows.map((pkg) => ({ pkg, task: pkg.tasks[0] ?? null }))
  const taskIds = packageTasks.flatMap(({ task }) => (task === null ? [] : [task.id]))
  const [names, templates, implCounts, doneEvents] = await Promise.all([
    seatNames([...packageTasks.map(({ task }) => task?.assigneeId ?? null), delivery?.verifierSlaveId ?? null, ...verificationRuns.map((run) => run.slaveId)]),
    prisma.slaveTemplate.findMany({ where: { id: { in: [...new Set(packageRows.map((pkg) => pkg.templateId))] } }, select: { id: true, name: true } }),
    prisma.slaveRun.groupBy({ by: ['taskId'], where: { taskId: { in: taskIds }, kind: 'implementation' }, _count: { _all: true } }),
    prisma.executionEvent.findMany({ where: { workspaceId, taskId: { in: taskIds }, type: 'task_done' }, orderBy: { seq: 'asc' }, select: { taskId: true, payload: true } }),
  ])
  const templateName = new Map(templates.map((row) => [row.id, row.name] as const))
  const implOf = new Map(implCounts.map((row) => [row.taskId, row._count._all] as const))

  const packages: GoalReportPackage[] = packageTasks
    .map(({ pkg, task }): GoalReportPackage => {
      const merges = doneEvents.filter((event) => event.taskId === task?.id).map((event) => (event.payload ?? {}) as Record<string, unknown>)
      const recorded = merges.filter((payload) => Array.isArray(payload['files']))
      const files = new Set(recorded.flatMap((payload) => (payload['files'] as unknown[]).filter((file): file is string => typeof file === 'string')))
      const worker = pkg.reports[0] === undefined ? null : readWorkerReport(pkg.reports[0].runId, pkg.reports[0].report)
      return {
        key: pkg.key,
        title: pkg.title,
        isIntegration: pkg.isIntegration,
        requirementKeys: pkg.requirementKeys,
        ownedPaths: pkg.ownedPaths,
        dependsOn: pkg.dependsOn,
        persona: templateName.get(pkg.templateId) ?? null,
        seat: task?.assigneeId == null ? null : (names.get(task.assigneeId) ?? null),
        taskId: task?.id ?? null,
        taskStatus: task?.status ?? null,
        integrated: task?.integratedAt != null,
        mergedFiles: recorded.length === 0 ? null : [...files].sort(byText),
        mergedFilesTruncated: recorded.some((payload) => typeof payload['filesTotal'] === 'number' && (payload['filesTotal'] as number) > (payload['files'] as unknown[]).length),
        reportedFiles: worker?.files ?? null,
        report: worker?.report ?? null,
        implementationRuns: task === null ? 0 : (implOf.get(task.id) ?? 0),
      }
    })
    .sort((a, b) => byText(a.key, b.key))

  const items = set === null ? null : requirementItemsSchema.safeParse(set.items)
  const requirements: GoalReportRequirement[] | null =
    items === null || !items.success
      ? null
      : items.data.map((item) => {
          const mine = counted.filter((row) => row.key === item.key)
          const latest = mine.at(-1)
          return {
            key: item.key,
            text: item.text,
            source: item.source,
            packageKey: packages.find((pkg) => pkg.requirementKeys.includes(item.key))?.key ?? null,
            verdict:
              latest === undefined
                ? null
                : { round: latest.round, runId: latest.runId, status: latest.status as GoalReportVerdictStatus, check: latest.check, output: latest.output, reason: latest.reason },
            history: mine.map((row) => ({ round: row.round, status: row.status as GoalReportVerdictStatus })),
          }
        })

  const rounds: GoalReportRound[] = [...writerOf.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, runId]) => {
      const run = verificationRuns.find((row) => row.id === runId)
      const rows = counted.filter((row) => row.round === n)
      return {
        round: n,
        runId,
        verifier: run === undefined ? null : (names.get(run.slaveId) ?? null),
        commit: run?.verificationTip ?? null,
        at: (run?.terminalAt ?? run?.startedAt ?? rows[0]?.createdAt ?? new Date(0)).toISOString(),
        pass: rows.filter((row) => row.status === 'pass').length,
        fail: rows.filter((row) => row.status === 'fail').length,
        unverifiable: rows.filter((row) => row.status === 'unverifiable').length,
      }
    })

  const decisionAction = decisionRow === null ? null : actionSchema.safeParse(decisionRow.action)
  const decision =
    decisionRow === null || decisionAction === null || !decisionAction.success || decisionAction.data.kind !== 'conduct'
      ? null
      : {
          mode: decisionAction.data.mode,
          reason: decisionRow.rationale,
          decidedBy: decisionRow.decidedBy === 'model' ? ('model' as const) : ('rules' as const),
          fallback: conducted?.payload['fallback'] === true,
          at: decisionRow.createdAt.toISOString(),
        }

  const state: GoalReportState = delivery === null ? 'not_conducted' : delivery.mergedAt !== null ? 'merged' : delivery.status
  const mergedBy = merged?.payload['by']
  const questions = await versionQuestions(scope)
  const [spend, trail] = await Promise.all([versionSpend(scope, questions.map((q) => q.id)), versionTrail(scope)])

  const stamps = [
    ...trail.entries.map((entry) => entry.at),
    ...rounds.map((r) => r.at),
    ...questions.flatMap((q) => [q.at, ...(q.answer === null ? [] : [q.answer.at])]),
    ...[delivery?.acceptedAt, delivery?.mergedAt].flatMap((at) => (at == null ? [] : [at.toISOString()])),
  ].sort(byText)

  return ok({
    workspaceId,
    workspaceName: workspace.name,
    goalVersion,
    versions,
    goal: goalRow?.text ?? null,
    state,
    delivery:
      delivery === null
        ? null
        : {
            integrationBranch: delivery.integrationBranch,
            baseBranch: workspace.baseBranch,
            baseCommit: delivery.baseCommit,
            verifiedCommit: delivery.verifiedCommit,
            round: delivery.round,
            roundBase: delivery.roundBase,
            roundCap: workspace.verificationRoundCap,
            acceptedAt: delivery.acceptedAt?.toISOString() ?? null,
            mergedAt: delivery.mergedAt?.toISOString() ?? null,
            merge:
              merged === null || (mergedBy !== 'system' && mergedBy !== 'human')
                ? null
                : { by: mergedBy, commit: String(merged.payload['commit'] ?? ''), into: String(merged.payload['into'] ?? workspace.baseBranch) },
            mergeError: delivery.mergeError,
            needsHumanReason: delivery.needsHumanReason,
            abandonedAt: abandoned?.ts.toISOString() ?? null,
          },
    decision,
    requirements,
    rounds,
    packages,
    verifier: scope.verifier,
    questions,
    spend,
    trail: trail.entries,
    trailOmitted: trail.omitted,
    asOf: stamps.at(-1) ?? null,
  })
}
```

- [ ] **Step 4: Run** `npx vitest run packages/control/test/integration/goal-report.test.ts`, then the Task 3 file again, then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(report): loadGoalReport -- one goal version's whole report, for every state, from recorded rows`, with the trailer.

---

### Task 5: The export: `goal-report` on the CLI, and the report route (JSON and Markdown)

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (usage text after `goal-status`; a `case 'goal-report'` after `case 'goal-status'`)
- Create: `apps/web/src/app/api/w/[workspaceId]/goals/[version]/report/route.ts`
- Test: `apps/orchestrator/test/integration/cli.test.ts` (next to the `goal-status` cases), `apps/web/test/integration/goal-report-route.test.ts` (new)

**Interfaces:**
- Consumes: `loadGoalReport`, `refusalText` (`@slave-of-ai/control`); `renderGoalReportMarkdown` (`@slave-of-ai/domain`); `requirePrincipal`, `refusalStatus` (`apps/web/src/server/`).
- Produces: `GET /api/w/:workspaceId/goals/:version/report`, which returns the `GoalReport` as JSON (200), or with `?format=markdown` returns `text/markdown; charset=utf-8` with `content-disposition: attachment; filename="goal-v<n>-report.md"`. A version that is not a whole number gets 400 `{ error }`; a refusal gets `refusalStatus` + `{ error: refusalText }`. CLI: `goal-report --workspace <id> [--version <n>] [--json]`, where the version defaults to the workspace's current goal version.

- [ ] **Step 1: Failing tests.** In `cli.test.ts` (it already has `seedGoalDelivery`):

```ts
  it('goal-report prints the version report as Markdown, and as JSON with --json', async (): Promise<void> => {
    await seedGoalDelivery(1, 'integrating', 'ready')

    const md = await runCli(['goal-report', '--workspace', fixture.workspaceId, '--version', '1'])
    expect(md.code).toBe(0)
    expect(md.stdout).toMatch(/^# Goal v1 report: /u)
    expect(md.stdout).toContain('State: **being built**')

    const json = await runCli(['goal-report', '--workspace', fixture.workspaceId, '--version', '1', '--json'])
    expect(JSON.parse(json.stdout)).toEqual(expect.objectContaining({ goalVersion: 1, state: 'integrating' }))
  })

  it('goal-report refuses a version with no report, and a version that is not a number', async (): Promise<void> => {
    const none = await runCli(['goal-report', '--workspace', fixture.workspaceId, '--version', '7'])
    expect(none.code).not.toBe(0)
    expect(`${none.stdout}${none.stderr}`).toContain(`workspace ${fixture.workspaceId} has no conducted goal v7`)
    const bad = await runCli(['goal-report', '--workspace', fixture.workspaceId, '--version', 'abc'])
    expect(bad.code).not.toBe(0)
  })
```

`goal-report-route.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Loopback mode (no session secret) never reads a cookie; the mock only keeps a stray secret in the
// shell from reaching Next's request context, which a test does not have (`hooks-route.test.ts`).
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))

const { GET } = await import('../../src/app/api/w/[workspaceId]/goals/[version]/report/route.js')

async function seed(): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Report Route', repoPath: '/tmp/report-route', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted' },
  })
  await prisma.requirementSet.create({
    data: { workspaceId: workspace.id, goalVersion: 1, items: [{ key: 'R1', text: 'a <b>bold</b> claim', source: 'x' }] },
  })
  return workspace.id
}

const get = (workspaceId: string, version: string, query = ''): Promise<Response> =>
  GET(new Request(`http://test/api/w/${workspaceId}/goals/${version}/report${query}`), { params: Promise.resolve({ workspaceId, version }) })

describe('the goal report route', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "RequirementSet", "GoalDelivery", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('answers the report as JSON', async (): Promise<void> => {
    const id = await seed()
    const response = await get(id, '1')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({ goalVersion: 1, state: 'not_conducted' }))
  })

  it('answers the Markdown as a download, escaped, byte-identical across two reads', async (): Promise<void> => {
    const id = await seed()
    const one = await get(id, '1', '?format=markdown')
    expect(one.status).toBe(200)
    expect(one.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(one.headers.get('content-disposition')).toBe('attachment; filename="goal-v1-report.md"')
    const text = await one.text()
    expect(text).toContain('a &lt;b&gt;bold&lt;/b&gt; claim')
    expect(await (await get(id, '1', '?format=markdown')).text()).toBe(text)
  })

  it('400s a version that is not a positive whole number, 404s an unknown version or workspace', async (): Promise<void> => {
    const id = await seed()
    expect((await get(id, 'abc')).status).toBe(400)
    expect((await get(id, '0')).status).toBe(400)
    const missing = await get(id, '9')
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: string }).error).toContain('has no conducted goal v9')
    expect((await get('nope', '1')).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run to see them fail.** Build first (`npx tsc --build`: the CLI test runs the built orchestrator). `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t goal-report` fails with an unknown command. `npx vitest run apps/web/test/integration/goal-report-route.test.ts` fails with no module.

- [ ] **Step 3: Implement.** The CLI usage text, after the `goal-status` entry, in the same column layout:

```
  goal-report --workspace <id> [--version <n>] [--json]
                                       one goal version's report (the current version by default),
                                       as Markdown: its state, what the report cannot vouch for, the
                                       requirement table with each verdict's check and output, the
                                       verification rounds, each package with its seat and the files
                                       it merged, the version's spend against the project's budget,
                                       the decision trail and the questions. --json prints the same
                                       report as JSON.
```

The case, after `case 'goal-status'`:

```ts
    case 'goal-report': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const versionText = flagText(flags, 'version')
      const version =
        versionText === undefined
          ? (await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { goalVersion: true } })).goalVersion
          : goalVersionFlag(versionText)
      const result = await loadGoalReport(workspaceId, version)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write('json' in flags ? `${JSON.stringify(result.value, null, 2)}\n` : renderGoalReportMarkdown(result.value))
      return 0
    }
```

(`loadGoalReport` joins the file's `@slave-of-ai/control` import, `renderGoalReportMarkdown` its `@slave-of-ai/domain` import. `goalVersionFlag` already refuses non-integers. `'json' in flags` follows the file's `'prompt' in flags` idiom for a bare flag.)

`route.ts`:

```ts
import { loadGoalReport, refusalText } from '@slave-of-ai/control'
import { renderGoalReportMarkdown } from '@slave-of-ai/domain'
import { requirePrincipal } from '../../../../../../../server/principal'
import { refusalStatus } from '../../../../../../../server/refusalStatus'

export const dynamic = 'force-dynamic'

/**
 * One goal version's report (Conductor Plan 5, spec R10, plan D9): the `GoalReport` as JSON, or
 * with `?format=markdown` the deterministic Markdown export as a download. A read, so no control
 * envelope. A refusal maps through `refusalStatus` (404 for `_not_found`), and a version that is
 * not a whole number is the caller's mistake (400), not a missing version. NOT gated on
 * archiving: an archived project's reports are still its record.
 */
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string; version: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, version } = await context.params
  if (!/^[1-9]\d{0,8}$/u.test(version)) {
    return Response.json({ error: `goal version "${version}" is not a positive whole number` }, { status: 400 })
  }
  const report = await loadGoalReport(workspaceId, Number(version))
  if (!report.ok) return Response.json({ error: refusalText(report.error) }, { status: refusalStatus(report.error.kind) })
  if (new URL(request.url).searchParams.get('format') === 'markdown') {
    return new Response(renderGoalReportMarkdown(report.value), {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="goal-v${version}-report.md"`,
        'cache-control': 'no-store',
      },
    })
  }
  return Response.json(report.value)
}
```

(Seven `..` segments: `report` → `[version]` → `goals` → `[workspaceId]` → `w` → `api` → `app` → `src`. `goal/history/route.ts`, one level shallower, uses six.)

- [ ] **Step 4: Run** both test files (`npx tsc --build` first), `npm run typecheck`, `npm run web:build && rm -rf apps/web/.next`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(report): goal-report on the CLI and the report route -- JSON, or the Markdown as a download`, with the trailer.

---

### Task 6: The report page, and the ways to reach it

**Files:**
- Create: `apps/web/src/app/w/[workspaceId]/goals/[version]/page.tsx`, `apps/web/src/components/project/GoalReportView.tsx`
- Modify: `apps/web/src/lib/routes.ts` (`breadcrumbOf`: the `goals` leaf), `apps/web/src/server/teamLive.ts` (`stats.reportVersion`), `apps/web/src/components/project/TeamLive.tsx` (the Report link in `stat-goal`'s note), `docs/ia.md` (one row in "Project surfaces")
- Test: `apps/web/test/goal-report-view.test.tsx` (new), `apps/web/test/routes.test.ts`, `apps/web/test/team-tab.test.tsx`, `apps/web/test/integration/team-live.test.ts`

**Interfaces:**
- Consumes: `loadGoalReport`, `latestReportVersion`, `refusalText` (`@slave-of-ai/control`); `GOAL_REPORT_STATE_LABEL`, `reportCaveats`, `evidenceAnchor`, `evidenceCut`, `formatReportUsd`, `shortCommit`, `type GoalReport` (`@slave-of-ai/domain`); `Panel`, `SectionLabel`, `StatusPill`, `Alert` (`components/ui`).
- Produces: the page at `/w/:workspaceId/goals/:version`; `GoalReportView({ report }: { readonly report: GoalReport })`; `TeamLiveSnapshot['stats']['reportVersion']: number | null`; `breadcrumbOf('/w/<id>/goals/<n>', name)` → `Projects / <name> / Goal report`.

- [ ] **Step 1: Failing tests.** `goal-report-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { GoalReport } from '@slave-of-ai/domain'
import { GoalReportView } from '../src/components/project/GoalReportView'

function report(over: Partial<GoalReport> = {}): GoalReport {
  return {
    workspaceId: 'w1',
    workspaceName: 'Harlequin',
    goalVersion: 2,
    versions: [1, 2],
    goal: 'Add a CSV output mode.',
    state: 'merged',
    delivery: {
      integrationBranch: 'slaveofai/goal-v2-w1', baseBranch: 'main', baseCommit: 'b'.repeat(40), verifiedCommit: 'c'.repeat(40),
      round: 1, roundBase: 0, roundCap: 3, acceptedAt: '2026-09-29T10:05:00.000Z', mergedAt: '2026-09-29T10:06:00.000Z',
      merge: { by: 'system', commit: 'c'.repeat(40), into: 'main' }, mergeError: null, needsHumanReason: null, abandonedAt: null,
    },
    decision: { mode: 'single', reason: 'fits one session', decidedBy: 'model', fallback: false, at: '2026-09-29T10:00:00.000Z' },
    requirements: [
      {
        key: 'R1', text: 'csv mode', source: 'Add CSV.', packageKey: 'report',
        verdict: { round: 1, runId: 'run-v1', status: 'pass', check: 'hsql --format csv', output: 'a,b', reason: '' },
        history: [{ round: 1, status: 'pass' }],
      },
    ],
    rounds: [{ round: 1, runId: 'run-v1', verifier: 'Sam', commit: 'c'.repeat(40), at: '2026-09-29T10:04:00.000Z', pass: 1, fail: 0, unverifiable: 0 }],
    packages: [
      {
        key: 'report', title: 'CSV mode', isIntegration: false, requirementKeys: ['R1'], ownedPaths: ['src/**'], dependsOn: [], persona: 'Backend Engineer',
        seat: 'Alex', taskId: 't1', taskStatus: 'done', integrated: true, mergedFiles: ['src/csv.py'], mergedFilesTruncated: false, reportedFiles: ['src/csv.py'],
        report: null, implementationRuns: 1,
      },
    ],
    verifier: 'Sam',
    questions: [],
    spend: {
      runsMeasuredUsd: 3.9, runsUnmeasured: 0, runsLive: 0, conductorMeasuredUsd: 0.2, conductorUnmeasuredCalls: 0,
      supervisorMeasuredUsd: 0.02, supervisorUnmeasuredCalls: 0, versionUsd: 4.12, projectSpentUsd: 12.4, projectBudgetUsd: 20,
    },
    trail: [{ at: '2026-09-29T10:00:00.000Z', text: 'Size decision: one package does the whole goal.', detail: 'fits one session', detailBy: 'model', packageKey: null }],
    trailOmitted: 0,
    asOf: '2026-09-29T10:06:00.000Z',
    ...over,
  }
}

describe('GoalReportView', () => {
  it('shows the state, the requirement with a link to its evidence, and the evidence under that anchor', () => {
    render(<GoalReportView report={report()} />)
    expect(screen.getByTestId('goal-report-state').getAttribute('title')).toBe('merged')
    const row = screen.getByTestId('goal-report-requirement')
    expect(row.getAttribute('data-key')).toBe('R1')
    expect(within(row).getByRole('link', { name: 'check and output' }).getAttribute('href')).toBe('#evidence-for-r1')
    expect(document.getElementById('evidence-for-r1')?.textContent).toContain('hsql --format csv')
    expect(screen.getByTestId('goal-report-download').getAttribute('href')).toBe('/api/w/w1/goals/2/report?format=markdown')
  })

  it('renders hostile text as characters, never as elements', () => {
    const { container } = render(
      <GoalReportView
        report={report({
          requirements: [
            {
              key: 'R1', text: '<img src=x onerror=alert(1)>', source: '', packageKey: null, history: [{ round: 1, status: 'fail' }],
              verdict: { round: 1, runId: 'r', status: 'fail', check: '<script>alert(1)</script>', output: '</slave-verification>', reason: '<b>x</b>' },
            },
          ],
        })}
      />,
    )
    expect(container.querySelector('img')).toBe(null)
    expect(container.querySelector('script')).toBe(null)
    expect(container.querySelector('b')).toBe(null)
    expect(screen.getByTestId('goal-report-requirement').textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('shows what the report cannot vouch for, and the stop reason', () => {
    const d = report().delivery!
    render(<GoalReportView report={report({ state: 'needs_human', delivery: { ...d, mergedAt: null, merge: null, needsHumanReason: 'round cap reached' }, rounds: [], requirements: [] })} />)
    expect(screen.getAllByTestId('goal-report-caveat').map((node) => node.textContent)).toContain('No verification round has run yet: no requirement is verified.')
    expect(screen.getByTestId('goal-report-stopped').textContent).toContain('round cap reached')
  })

  it('links every other version, and says which one this is', () => {
    render(<GoalReportView report={report()} />)
    const links = screen.getAllByTestId('goal-report-version-link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
      ['v1', '/w/w1/goals/1', null],
      ['v2', '/w/w1/goals/2', 'page'],
    ])
  })

  it('shows the version spend and the project figure against its budget', () => {
    render(<GoalReportView report={report()} />)
    const spend = screen.getByTestId('goal-report-spend')
    expect(spend.textContent).toContain('$4.12')
    expect(spend.textContent).toContain('$12.40 of a $20.00 budget')
  })
})
```

In `routes.test.ts`:

```ts
  it('names the goal report in the breadcrumb and lights no tab', () => {
    expect(breadcrumbOf('/w/w1/goals/3', 'Checkout')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout', last: false },
      { text: 'Goal report', last: true },
    ])
    expect(sectionOf('/w/w1/goals/3')).toBe(null)
  })
```

In `team-tab.test.tsx`: add `reportVersion: 2` to the default fixture's `stats` (line ~119) and `reportVersion: null` to the two literal `stats` objects (lines ~206 and ~309). Then:

```tsx
  it("links the latest goal report from stat-goal's note, and nothing when there is none", () => {
    renderTeam(snapshot([row({})]))
    expect(screen.getByTestId('goal-report-link').getAttribute('href')).toBe('/w/w1/goals/2')
  })
```

(Use the file's own workspace id if it is not `w1`: read `renderTeam`.) In `integration/team-live.test.ts`, add a case asserting that `buildTeamLive` returns `stats.reportVersion` `null` for the file's plain workspace, and `1` after a `requirementSet` row for version 1 is created (using the file's own seed).

- [ ] **Step 2: Run to see them fail.** `npx vitest run apps/web/test/goal-report-view.test.tsx apps/web/test/routes.test.ts apps/web/test/team-tab.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.** `GoalReportView.tsx` has no `'use client'`: it is a pure render of plain data, used by the server page. Every value is a JSX child:

```tsx
import Link from 'next/link'
import {
  GOAL_REPORT_STATE_LABEL,
  evidenceAnchor,
  evidenceCut,
  formatReportUsd,
  reportCaveats,
  shortCommit,
  type GoalReport,
  type GoalReportState,
  type GoalReportVerdictStatus,
} from '@slave-of-ai/domain'
import { Alert } from '../ui/Alert'
import { Panel } from '../ui/Panel'
import { SectionLabel } from '../ui/SectionLabel'
import { StatusPill, type StatusTone } from '../ui/StatusPill'

const STATE_TONE: Readonly<Record<GoalReportState, StatusTone>> = {
  not_conducted: 'planning',
  integrating: 'working',
  verifying: 'review',
  accepted: 'waiting',
  merged: 'done',
  needs_human: 'blocked',
  abandoned: 'idle',
}

const VERDICT_TONE: Readonly<Record<GoalReportVerdictStatus, StatusTone>> = { pass: 'done', fail: 'blocked', unverifiable: 'waiting' }

const WORDS_OF = { system: "Slave's record", model: "the model's words", person: "a person's words" } as const

const PRE = 'mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-chip border border-line bg-bg-1 p-2 font-mono text-[11.5px] text-t1'
const CELL = 'border-b border-line px-2 py-[6px] align-top text-left'

/**
 * One goal version's report (Conductor Plan 5, spec R10, plan D9): the same facts and the same
 * caveats as the Markdown export (`reportCaveats` is shared), laid out for reading. A pure render
 * of plain data. Every string another party wrote -- a requirement, a check, an output, a reason,
 * a package title, a question -- is a JSX child, so it is characters on the page, never elements
 * (spec §1: another party's text is data). There is no `dangerouslySetInnerHTML` anywhere here.
 */
export function GoalReportView({ report }: { readonly report: GoalReport }): React.JSX.Element {
  const d = report.delivery
  const caveats = reportCaveats(report)
  const base = `/w/${report.workspaceId}`
  return (
    <div data-testid="goal-report" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-[20px] pb-8 pt-[16px]">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[18px] font-semibold text-t1">Goal v{report.goalVersion} report</h1>
        {/* `StatusPill`'s own testid is fixed (`status-pill`), so the named wrapper carries the raw
          * state on `title` for a person to hover and a test to read (M44 R5). */}
        <span data-testid="goal-report-state" title={report.state}>
          <StatusPill tone={STATE_TONE[report.state]} label={GOAL_REPORT_STATE_LABEL[report.state]} title={report.state} />
        </span>
        <nav aria-label="Goal versions" className="flex gap-2 text-[12.5px]">
          {report.versions.map((version) => (
            <Link
              key={version}
              data-testid="goal-report-version-link"
              href={`${base}/goals/${String(version)}`}
              {...(version === report.goalVersion ? { 'aria-current': 'page' as const } : {})}
              className={version === report.goalVersion ? 'font-semibold text-t1' : 'text-accent'}
            >
              v{version}
            </Link>
          ))}
        </nav>
        <a data-testid="goal-report-download" href={`/api${base}/goals/${String(report.goalVersion)}/report?format=markdown`} className="ml-auto text-[12.5px] text-accent">
          Download as Markdown
        </a>
      </header>
      <p className="text-[12.5px] text-t3">
        {report.workspaceName} · as of {report.asOf ?? 'no recorded fact yet'}
        {d?.merge != null && ` · merged into ${d.merge.into} ${d.merge.by === 'human' ? 'by a person' : 'by Slave'} (commit ${shortCommit(d.merge.commit)})`}
      </p>

      {report.state === 'needs_human' && d?.needsHumanReason != null && (
        <Alert variant="error" testId="goal-report-stopped">
          {d.needsHumanReason}
        </Alert>
      )}
      {d?.mergeError != null && (
        <Alert variant="notice" testId="goal-report-merge-error">
          The merge git refused: {d.mergeError}
        </Alert>
      )}
      {caveats.length > 0 && (
        <Panel title="What to know">
          <ul className="list-disc pl-5 text-[13px] text-t2">
            {caveats.map((line) => (
              <li key={line} data-testid="goal-report-caveat">
                {line}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Goal">
        <pre className={PRE}>{report.goal ?? 'No goal text is recorded for this version.'}</pre>
      </Panel>

      <Panel title="Requirements">
        {report.requirements === null ? (
          <p className="text-[13px] text-t2">Not extracted yet.</p>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-t3">
                {['Key', 'Requirement', 'Status', 'Round', 'Package', 'Evidence'].map((heading) => (
                  <th key={heading} className={CELL}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.requirements.map((item) => (
                <tr key={item.key} data-testid="goal-report-requirement" data-key={item.key}>
                  <td className={`${CELL} font-mono`}>{item.key}</td>
                  <td className={CELL}>{item.text}</td>
                  <td className={CELL}>
                    {item.verdict === null ? (
                      <span className="text-t3">not verified yet</span>
                    ) : (
                      <StatusPill tone={VERDICT_TONE[item.verdict.status]} label={item.verdict.status} title={item.verdict.status} />
                    )}
                  </td>
                  <td className={CELL}>{item.verdict?.round ?? '—'}</td>
                  <td className={CELL}>{item.packageKey ?? '—'}</td>
                  <td className={CELL}>{item.verdict === null ? '—' : <a href={`#${evidenceAnchor(item.key)}`} className="text-accent">check and output</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Verification rounds">
        {report.rounds.length === 0 ? (
          <p className="text-[13px] text-t2">No round has run.</p>
        ) : (
          <ul className="text-[13px] text-t2">
            {report.rounds.map((round) => (
              <li key={round.round} data-testid="goal-report-round">
                Round {round.round}: {round.pass} pass, {round.fail} fail, {round.unverifiable} unverifiable. Verified by {round.verifier ?? 'a seat that is gone'} on commit{' '}
                <span className="font-mono">{shortCommit(round.commit)}</span>, finished {round.at}.
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {(report.requirements ?? []).some((item) => item.verdict !== null) && (
        <Panel title="Evidence">
          {(report.requirements ?? []).map((item) =>
            item.verdict === null ? null : (
              <section key={item.key} id={evidenceAnchor(item.key)} data-testid="goal-report-evidence" className="border-t border-line pt-3 first:border-t-0 first:pt-0">
                <SectionLabel>{`Evidence for ${item.key}`}</SectionLabel>
                <p className="mt-1 text-[13px] text-t1">{item.text}</p>
                <p className="text-[12px] text-t3">Taken from the goal: {item.source === '' ? '—' : item.source}</p>
                <p className="mt-1 text-[12.5px] text-t2">
                  <StatusPill tone={VERDICT_TONE[item.verdict.status]} label={item.verdict.status} title={item.verdict.status} /> in round {item.verdict.round}
                  {item.history.length > 1 && ` · earlier: ${item.history.filter((h) => h.round !== item.verdict?.round).map((h) => `round ${String(h.round)} ${h.status}`).join(', ')}`}
                </p>
                <p className="mt-2 text-[12px] text-t3">Check</p>
                <pre className={PRE}>{item.verdict.check === '' ? 'No check was written.' : item.verdict.check}</pre>
                <p className="mt-2 text-[12px] text-t3">Output</p>
                <pre className={PRE}>{item.verdict.output === '' ? 'No output.' : item.verdict.output}</pre>
                {item.verdict.reason !== '' && (
                  <>
                    <p className="mt-2 text-[12px] text-t3">Reason</p>
                    <pre className={PRE}>{item.verdict.reason}</pre>
                  </>
                )}
                {evidenceCut(item.verdict.check) + evidenceCut(item.verdict.output) + evidenceCut(item.verdict.reason) > 0 && (
                  <p className="mt-1 text-[12px] text-s-waiting">Trimmed to fit; the verifier's full output stays in its run's scratch directory.</p>
                )}
              </section>
            ),
          )}
        </Panel>
      )}

      <Panel title="Packages">
        {report.packages.length === 0 && <p className="text-[13px] text-t2">No packages yet.</p>}
        {report.packages.map((pkg) => (
          <section key={pkg.key} data-testid="goal-report-package" className="border-t border-line pt-3 text-[13px] text-t2 first:border-t-0 first:pt-0">
            <p className="font-medium text-t1">
              {pkg.key}: {pkg.title}
              {pkg.isIntegration && ' (the integration package)'}
            </p>
            <p>
              Seat: {pkg.seat ?? 'none'}
              {pkg.persona !== null && ` (persona ${pkg.persona})`} · requirements: {pkg.requirementKeys.join(', ') || 'none of its own'}
            </p>
            <p>Owns: <span className="font-mono text-[12px]">{pkg.ownedPaths.join(', ')}</span></p>
            <p>
              Task: {pkg.taskStatus ?? 'none'}
              {pkg.integrated && ', on the integration branch'} · {pkg.implementationRuns} implementation {pkg.implementationRuns === 1 ? 'run' : 'runs'}
            </p>
            <p>
              Files merged (from git): {pkg.mergedFiles === null ? 'not recorded' : pkg.mergedFiles.join(', ') || 'none'}
              {pkg.mergedFilesTruncated && ' (cut)'}
            </p>
            <p>Files the worker reported: {pkg.reportedFiles === null ? 'no report filed' : pkg.reportedFiles.join(', ') || 'none'}</p>
            {pkg.report !== null && (
              <p>
                The worker's report: {pkg.report.requirements.map((r) => `${r.key} ${r.status.replace('_', ' ')}`).join(', ') || 'no requirement'}; workflow {pkg.report.workflowDone} of {pkg.report.workflowTotal} steps done
              </p>
            )}
          </section>
        ))}
        <p className="text-[13px] text-t2">Verifier: {report.verifier ?? 'none recorded'}</p>
      </Panel>

      <Panel title="Spend">
        <dl data-testid="goal-report-spend" className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px] text-t2">
          <dt>Runs of this version</dt>
          <dd>{formatReportUsd(report.spend.runsMeasuredUsd)}</dd>
          <dt>Conductor calls</dt>
          <dd>
            {formatReportUsd(report.spend.conductorMeasuredUsd)}
            {report.spend.conductorUnmeasuredCalls > 0 && ` + ${String(report.spend.conductorUnmeasuredCalls)} unmeasured, charged at the cap`}
          </dd>
          <dt>Supervisor decisions</dt>
          <dd>
            {formatReportUsd(report.spend.supervisorMeasuredUsd)}
            {report.spend.supervisorUnmeasuredCalls > 0 && ` + ${String(report.spend.supervisorUnmeasuredCalls)} unmeasured, charged at the cap`}
          </dd>
          <dt className="font-medium text-t1">This version</dt>
          <dd className="font-medium text-t1">{formatReportUsd(report.spend.versionUsd)}</dd>
          <dt>Project so far</dt>
          <dd>
            {formatReportUsd(report.spend.projectSpentUsd)}
            {report.spend.projectBudgetUsd === null ? ', no budget set' : ` of a ${formatReportUsd(report.spend.projectBudgetUsd)} budget`}
          </dd>
        </dl>
        <p className="text-[12px] text-t3">The conversation with the Supervisor and the intake are counted in the project figure only.</p>
      </Panel>

      <Panel title="Decision trail">
        {report.trail.length === 0 && <p className="text-[13px] text-t2">Nothing recorded yet.</p>}
        <ol className="flex flex-col gap-2 text-[13px] text-t2">
          {report.trail.map((entry, index) => (
            <li key={`${entry.at}-${String(index)}`} data-testid="goal-report-trail-entry">
              <span className="font-mono text-[11.5px] text-t3">{entry.at}</span> {entry.text}
              {entry.detail !== null && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[12px] text-t3">{WORDS_OF[entry.detailBy ?? 'system']}</summary>
                  <pre className={PRE}>{entry.detail}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="Questions">
        {report.questions.length === 0 && <p className="text-[13px] text-t2">No questions were asked.</p>}
        {report.questions.map((q) => (
          <div key={q.id} data-testid="goal-report-question" className="text-[13px] text-t2">
            <p>
              <span className="font-mono text-[11.5px] text-t3">{q.at}</span> {q.packageKey ?? 'A worker'}
              {q.askedBy !== null && ` (${q.askedBy})`} asked:
            </p>
            <pre className={PRE}>{q.question}</pre>
            {q.answer === null ? (
              <p className="text-s-waiting">Not answered.</p>
            ) : (
              <>
                <p>
                  Answered by {q.answer.by === 'person' ? 'a person' : q.answer.by === 'supervisor' ? 'the Supervisor' : 'a slave'} at {q.answer.at}:
                </p>
                <pre className={PRE}>{q.answer.text}</pre>
              </>
            )}
          </div>
        ))}
      </Panel>
    </div>
  )
}
```

(Check `text-s-waiting` / `bg-bg-1` / `rounded-chip` against `app/tokens/*.css` and `globals.css`, and use the names the tokens define. The existing components use all three, but confirm before copying.)

`page.tsx`:

```tsx
import { loadGoalReport, refusalText } from '@slave-of-ai/control'
import { GoalReportView } from '../../../../../components/project/GoalReportView'

export const dynamic = 'force-dynamic'

/** One goal version's report (Conductor Plan 5, spec R10, plan D9). Not a tab: reached from the
 *  Team page's Goal stat, from the Supervisor's note when the version came to rest, and from the
 *  version links on the page itself. The route stays put in both modes (`docs/ia.md` rule 2). */
export default async function GoalReportPage({ params }: { params: Promise<{ workspaceId: string; version: string }> }): Promise<React.JSX.Element> {
  const { workspaceId, version } = await params
  if (!/^[1-9]\d{0,8}$/u.test(version)) {
    return <div data-testid="goal-report-missing" className="p-6 text-tone-blocked">goal version “{version}” is not a positive whole number</div>
  }
  const report = await loadGoalReport(workspaceId, Number(version))
  if (!report.ok) return <div data-testid="goal-report-missing" className="p-6 text-tone-blocked">{refusalText(report.error)}</div>
  return <GoalReportView key={`${workspaceId}:${version}`} report={report.value} />
}
```

`routes.ts`, in `breadcrumbOf`:

```ts
  const section = sectionOf(pathname)
  // Conductor Plan 5 (D9): a goal version's report is a page of the project, not a tab.
  const leaf =
    TABS.find((tab) => tab.id === section && tab.id !== 'team')?.label ??
    (section === 'settings' ? 'Settings' : segmentOf(pathname) === 'goals' ? 'Goal report' : null)
```

`teamLive.ts`: add to the `stats` interface

```ts
    /**
     * Conductor Plan 5 (D9): the newest goal version that has a report, which `stat-goal`'s note
     * links to. Null for a planned project, and for a conducted one before its first requirements.
     */
    readonly reportVersion: number | null
```

and read it with `latestReportVersion(workspaceId)` in the builder's existing `Promise.all` (or beside it), setting `reportVersion` in `stats`.

`TeamLive.tsx`, in `stat-goal`'s `note`, between the version and `Edit goal`:

```tsx
              {view.stats.reportVersion !== null && (
                <>
                  <Link data-testid="goal-report-link" href={`/w/${workspaceId}/goals/${String(view.stats.reportVersion)}`} className="text-accent">
                    Report
                  </Link>
                  {' · '}
                </>
              )}
```

`docs/ia.md`, one row in the "Project surfaces" table after the Settings row:

```
| `/w/:id/goals/:version` Goal report | What this goal version was asked to do, what was verified and how, who did which part, what it cost, and why | **new** (not a tab) | — | Conductor Plan 5: the requirement table with each verdict's check and output, the verification rounds, the packages with their seats and the files each merged, the version's spend against the project's budget, the decision trail and the questions, under a list of what the report cannot vouch for. Reached from the Team page's Goal stat (`Report`), from the Supervisor's note when a version comes to rest, and from the version links on the page; `Download as Markdown` is `GET /api/w/:id/goals/:version/report?format=markdown`. Both modes |
```

- [ ] **Step 4: Run** the four test files, `npm run typecheck` (it names every other `TeamLiveSnapshot` stats literal: add `reportVersion: null` to each), `npm run web:build && rm -rf apps/web/.next`, `node scripts/gate-m26-vocabulary.mjs`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(web): the goal-version report page, linked from the Team page's goal`, with the trailer.

---

### Task 7: The Supervisor chat gets the report's summary when a version comes to rest

**Files:**
- Create: `packages/db/prisma/migrations/20260929150000_goal_report_note/migration.sql`, `packages/domain/src/goalReport/summary.ts`, `apps/orchestrator/src/goalReportNotes.ts`
- Modify: `packages/db/prisma/schema.prisma` (`SupervisorMessage.noteKey`, `.goalReportVersion`, `@@unique([workspaceId, noteKey])`; `GoalDelivery.reportNotedKey`), `packages/domain/src/goalReport/index.ts`, `packages/control/src/supervisorChat.ts` (`postSupervisorNote`; `SupervisorMessageView.goalReportVersion`), `apps/orchestrator/src/tick.ts` (the pass in both branches), `apps/web/src/server/supervisorThreads.ts` (`reportVersion`), `apps/web/src/components/supervisor/SupervisorThreadPanel.tsx` (the link)
- Test: `packages/domain/test/goalReport/summary.test.ts` (new), `packages/control/test/integration/supervisor-chat.test.ts`, `apps/orchestrator/test/integration/goal-report-notes.test.ts` (new), `apps/web/test/supervisor-thread-panel.test.tsx`

**Interfaces:**
- Consumes: Task 1's report types and constants; `handMergeInstruction`, `sanitisePersonText` (`@slave-of-ai/domain`); Task 4's `loadGoalReport`.
- Produces:
  - Prisma: `SupervisorMessage.noteKey String?`, `goalReportVersion Int?`, `@@unique([workspaceId, noteKey])`; `GoalDelivery.reportNotedKey String?`
  - `goalReportSummary(report: GoalReport): string` (≤ `GOAL_REPORT_SUMMARY_MAX_CHARS`)
  - `postSupervisorNote(workspaceId: string, input: { readonly text: string; readonly noteKey: string; readonly goalReportVersion?: number }): Promise<Result<{ readonly messageId: string; readonly created: boolean }, ControlRefusal>>`
  - `SupervisorMessageView.goalReportVersion: number | null`
  - `restingKey(delivery: RestingDelivery, autoMerge: boolean): Promise<string | null>` and `postGoalReportNotes(workspaceId: string): Promise<number>` (`apps/orchestrator/src/goalReportNotes.ts`)
  - web `SupervisorMessage.reportVersion?: number`

- [ ] **Step 1: Migration.**

```sql
-- Conductor Plan 5 (spec R10), 2026-09-29: the goal-version report's summary in the Supervisor chat.
--
-- A note is a Supervisor message no model wrote: the orchestrator posts a goal version's report
-- summary when the version comes to rest (merged, needs a person, abandoned, verified and waiting
-- for a hand merge). `noteKey` makes each note once-only per workspace, and `goalReportVersion` is
-- the version the panel links to. `GoalDelivery.reportNotedKey` is the resting point the last note
-- was posted for. It is BACKFILLED here for every delivery already at rest, so upgrading posts no
-- note for versions that came to rest before this migration. PURELY ADDITIVE: nullable columns,
-- one unique index (Postgres allows many NULLs under it), and one write to a new column.

ALTER TABLE "SupervisorMessage" ADD COLUMN "noteKey" TEXT;
ALTER TABLE "SupervisorMessage" ADD COLUMN "goalReportVersion" INTEGER;
CREATE UNIQUE INDEX "SupervisorMessage_workspaceId_noteKey_key" ON "SupervisorMessage"("workspaceId", "noteKey");

ALTER TABLE "GoalDelivery" ADD COLUMN "reportNotedKey" TEXT;
UPDATE "GoalDelivery" SET "reportNotedKey" = CASE
  WHEN "mergedAt" IS NOT NULL THEN 'merged'
  WHEN "status" = 'abandoned' THEN 'abandoned'
  WHEN "status" = 'needs_human' THEN 'needs_human:r' || "round"
  WHEN "status" = 'accepted' THEN 'awaiting_merge:r' || "round"
  ELSE NULL
END;
```

Mirror it in `schema.prisma` with `///` comments in the file's style. On `SupervisorMessage`:

```prisma
  /// Conductor Plan 5 (D10): set on a note the orchestrator posted (a goal version's report summary),
  /// `goal-report:v<n>:<rest key>`; null on every turn of the conversation. Unique per workspace, so
  /// a note is posted once however many passes try.
  noteKey           String?
  /// Conductor Plan 5 (D10): the goal version a note's report link opens.
  goalReportVersion Int?
```

plus `@@unique([workspaceId, noteKey])`. On `GoalDelivery`:

```prisma
  /// Conductor Plan 5 (D10): the resting point (`merged`, `abandoned`, `needs_human:r<n>`,
  /// `awaiting_merge:r<n>`) the Supervisor chat was last given this version's report summary for.
  reportNotedKey    String?
```

Run `npm run db:generate && npm run db:migrate:test`.

- [ ] **Step 2: Failing tests.** `summary.test.ts` (with the Task 1 builders repeated at the top):

```ts
import { goalReportSummary } from '../../src/goalReport/summary.js'

describe('goalReportSummary', () => {
  it('says a version Slave merged, with its requirements, packages and spend', () => {
    expect(goalReportSummary(report())).toBe(
      [
        `Goal v2 report: merged into main (commit ${'c'.repeat(12)}, the verified commit).`,
        'Requirements: 1 of 1 pass (round 1).',
        'Packages: report (Alex).',
        'Spend on this version: $4.12; project: $12.40 of a $20.00 budget.',
        'Open the report for the evidence behind each requirement and the decision trail.',
      ].join('\n'),
    )
  })

  it('never calls a hand merge onto a moved base verified', () => {
    const d = report().delivery!
    const text = goalReportSummary(report({ delivery: { ...d, merge: { by: 'human', commit: 'd'.repeat(40), into: 'main' } } }))
    expect(text).toContain(`merged into main by a person (commit ${'d'.repeat(12)}); that tree was not itself verified.`)
  })

  it('says what a stopped version needs, with the failing and unverifiable keys', () => {
    const d = report().delivery!
    const text = goalReportSummary(
      report({
        state: 'needs_human',
        delivery: { ...d, mergedAt: null, merge: null, needsHumanReason: 'the verification round cap (3) was reached' },
        requirements: [
          requirement({ key: 'R1' }),
          requirement({ key: 'R2', verdict: { ...requirement().verdict!, status: 'fail', reason: 'x' } }),
          requirement({ key: 'R3', verdict: { ...requirement().verdict!, status: 'unverifiable', reason: 'y' } }),
        ],
      }),
    )
    expect(text).toContain('Goal v2 report: stopped, and needs you: the verification round cap (3) was reached')
    expect(text).toContain('Requirements: 1 of 3 pass (round 1); failing: R2; could not be checked: R3.')
  })

  it('tells the person how to merge an accepted version by hand', () => {
    const d = report().delivery!
    const text = goalReportSummary(report({ state: 'accepted', delivery: { ...d, mergedAt: null, merge: null } }))
    expect(text).toContain('every requirement is verified, and it waits for you: Merge')
    expect(text).toContain('confirm-goal-merge --workspace ws-1 --version 2')
  })

  it('says an abandoned version reached nothing, and stays within its cap', () => {
    expect(goalReportSummary(report({ state: 'abandoned' }))).toContain('Goal v2 report: abandoned; nothing of it reached main.')
    const d = report().delivery!
    const long = goalReportSummary(report({ state: 'needs_human', delivery: { ...d, merge: null, mergedAt: null, needsHumanReason: 'x'.repeat(5000) } }))
    expect(long.length).toBeLessThanOrEqual(1500)
  })
})
```

In `supervisor-chat.test.ts`:

```ts
describe('postSupervisorNote', () => {
  it('posts a Supervisor row no model wrote, once per key, and leaves the conversation cost alone', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({ data: { name: 'Notes', repoPath: '/tmp/notes', verifyCommands: [], setupCommands: [] } })
    const first = await postSupervisorNote(workspace.id, { text: 'Goal v1 report: merged.', noteKey: 'goal-report:v1:merged', goalReportVersion: 1 })
    const again = await postSupervisorNote(workspace.id, { text: 'Goal v1 report: merged.', noteKey: 'goal-report:v1:merged', goalReportVersion: 1 })
    expect(first).toEqual({ ok: true, value: { messageId: expect.any(String), created: true } })
    expect(again).toEqual({ ok: true, value: { messageId: first.ok ? first.value.messageId : '', created: false } })
    const [row] = await listSupervisorMessages(workspace.id)
    expect(row).toEqual(expect.objectContaining({ role: 'supervisor', status: 'answered', text: 'Goal v1 report: merged.', modelCostUsd: null, unmeasured: false, goalReportVersion: 1 }))
    expect(await conversationCost(workspace.id)).toEqual({ usd: 0, unmeasuredTurns: 0 })
  })

  it('refuses an archived project and writes nothing', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({ data: { name: 'Archived Notes', repoPath: '/tmp/n', verifyCommands: [], setupCommands: [], archivedAt: new Date() } })
    expect(await postSupervisorNote(workspace.id, { text: 'x', noteKey: 'k' })).toEqual({ ok: false, error: { kind: 'workspace_archived', workspaceId: workspace.id } })
    expect(await prisma.supervisorMessage.count({ where: { workspaceId: workspace.id } })).toBe(0)
  })

  it('takes the next seq after a turn in flight, so the turn is still answered', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({ data: { name: 'Seq Notes', repoPath: '/tmp/s', verifyCommands: [], setupCommands: [] } })
    await sendSupervisorMessage(workspace.id, { text: 'how is v1?' })
    await postSupervisorNote(workspace.id, { text: 'Goal v1 report: merged.', noteKey: 'goal-report:v1:merged' })
    const [turn] = await claimSupervisorTurns({ by: 'test', limit: 5 })
    expect(turn?.message).toBe('how is v1?')
    expect((await listSupervisorMessages(workspace.id)).map((m) => [m.seq, m.role, m.status])).toEqual([
      [0, 'human', 'sent'],
      [1, 'supervisor', 'answering'],
      [2, 'supervisor', 'answered'],
    ])
  })
})
```

`goal-report-notes.test.ts` (orchestrator, integration):

```ts
/**
 * Conductor Plan 5, Task 7 (plan D10): the Supervisor chat is given a goal version's report summary
 * once per resting point -- merged, needs a person (per round), abandoned, verified and waiting
 * for a hand merge -- and never for a delivery the migration already marked, or twice.
 */
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { postGoalReportNotes, restingKey } from '../../src/goalReportNotes.js'

async function workspaceWith(autoMerge: boolean): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: { name: `Notes ${String(autoMerge)}`, repoPath: '/tmp/notes', verifyCommands: [], setupCommands: [], delivery: 'conducted', autoMerge },
  })
  return workspace.id
}

async function delivery(workspaceId: string, goalVersion: number, data: Record<string, unknown>): Promise<string> {
  await prisma.requirementSet.create({ data: { workspaceId, goalVersion, items: [{ key: 'R1', text: 'a', source: 'a' }] } })
  const row = await prisma.goalDelivery.create({
    data: { workspaceId, goalVersion, integrationBranch: `slaveofai/goal-v${String(goalVersion)}-x`, baseCommit: 'b'.repeat(40), ...data },
  })
  return row.id
}

const notes = (workspaceId: string) =>
  prisma.supervisorMessage.findMany({ where: { workspaceId, noteKey: { not: null } }, orderBy: { seq: 'asc' }, select: { noteKey: true, goalReportVersion: true, text: true } })

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorMessage", "RequirementSet", "GoalDelivery", "Workspace" RESTART IDENTITY CASCADE',
  )
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('restingKey', () => {
  it('names each resting point, and nothing for a version still moving', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    const base = { id: 'x', workspaceId: ws, goalVersion: 1, round: 2, mergeError: null, acceptedAt: new Date() }
    expect(await restingKey({ ...base, status: 'accepted', mergedAt: new Date() }, true)).toBe('merged')
    expect(await restingKey({ ...base, status: 'abandoned', mergedAt: null }, true)).toBe('abandoned')
    expect(await restingKey({ ...base, status: 'needs_human', mergedAt: null }, true)).toBe('needs_human:r2')
    expect(await restingKey({ ...base, status: 'accepted', mergedAt: null }, false)).toBe('awaiting_merge:r2')
    expect(await restingKey({ ...base, status: 'accepted', mergedAt: null, mergeError: 'conflict' }, true)).toBe('awaiting_merge:r2')
    expect(await restingKey({ ...base, status: 'accepted', mergedAt: null }, true)).toBe(null)
    expect(await restingKey({ ...base, status: 'verifying', mergedAt: null }, true)).toBe(null)
  })

  it("counts an accepted version as waiting once the goal pass has tripped about it since its acceptance", async (): Promise<void> => {
    const ws = await workspaceWith(true)
    const acceptedAt = new Date(Date.now() - 1000)
    await appendEvent({ type: 'guardrail.tripped', workspaceId: ws, actor: 'system', payload: { guardrail: 'merge_failure', detail: 'goal v1 is accepted, but main has moved since the goal was cut from it' } })
    await appendEvent({ type: 'guardrail.tripped', workspaceId: ws, actor: 'system', payload: { guardrail: 'merge_failure', detail: 'goal v10 is accepted, but main has moved' } })
    const d = { id: 'x', workspaceId: ws, goalVersion: 1, round: 1, status: 'accepted' as const, mergedAt: null, mergeError: null, acceptedAt }
    expect(await restingKey(d, true)).toBe('awaiting_merge:r1')
    expect(await restingKey({ ...d, acceptedAt: new Date(Date.now() + 60_000) }, true)).toBe(null)
  })
})

describe('postGoalReportNotes', () => {
  it('posts one note per resting point, stamps it, and posts nothing on the next pass', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    const id = await delivery(ws, 1, { status: 'needs_human', round: 1, needsHumanReason: 'only unverifiable items: R1' })
    expect(await postGoalReportNotes(ws)).toBe(1)
    expect(await postGoalReportNotes(ws)).toBe(0)
    expect(await notes(ws)).toEqual([expect.objectContaining({ noteKey: 'goal-report:v1:needs_human:r1', goalReportVersion: 1 })])
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })).reportNotedKey).toBe('needs_human:r1')

    // The person retries; the version stops again in round 2 -- a new resting point, a new note.
    await prisma.goalDelivery.update({ where: { id }, data: { round: 2 } })
    expect(await postGoalReportNotes(ws)).toBe(1)
    expect((await notes(ws)).map((n) => n.noteKey)).toEqual(['goal-report:v1:needs_human:r1', 'goal-report:v1:needs_human:r2'])
  })

  it('posts nothing for a delivery the migration marked, and nothing for a version still moving', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    await delivery(ws, 1, { status: 'accepted', mergedAt: new Date(), reportNotedKey: 'merged' })
    await delivery(ws, 2, { status: 'verifying', round: 1 })
    expect(await postGoalReportNotes(ws)).toBe(0)
    expect(await notes(ws)).toEqual([])
  })

  it('does not post twice when the stamp was lost after the note (a crash in between)', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    const id = await delivery(ws, 1, { status: 'abandoned' })
    await postGoalReportNotes(ws)
    await prisma.goalDelivery.update({ where: { id }, data: { reportNotedKey: null } })
    expect(await postGoalReportNotes(ws)).toBe(0)
    expect(await notes(ws)).toHaveLength(1)
    expect((await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })).reportNotedKey).toBe('abandoned')
  })

  it('posts nothing for an archived project', async (): Promise<void> => {
    const ws = await workspaceWith(true)
    await delivery(ws, 1, { status: 'abandoned' })
    await prisma.workspace.update({ where: { id: ws }, data: { archivedAt: new Date() } })
    expect(await postGoalReportNotes(ws)).toBe(0)
  })
})
```

In `supervisor-thread-panel.test.tsx`:

```tsx
  it("links a report note to its goal version's report", async (): Promise<void> => {
    stubFetch(async (url: string) => {
      if (url.includes('/supervisor/threads')) {
        return new Response(
          JSON.stringify(chatThread({ id: 'msg:n1', messageId: 'n1', who: 'supervisor', text: 'Goal v3 report: merged into main.', at: '2026-09-20T09:00:00.000Z', refs: [], decisionId: null, status: 'answered', reportVersion: 3 })),
          { status: 200 },
        )
      }
      if (url.endsWith('/supervisor')) return new Response(view(), { status: 200 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    render(<SupervisorThreadPanel workspaceId="w1" pending={[]} />)
    const link = await screen.findByTestId('supervisor-report-link')
    expect(link.getAttribute('href')).toBe('/w/w1/goals/3')
    expect(link.textContent).toBe('Open the goal v3 report')
  })
```

- [ ] **Step 3: Run to see them fail.** Each file above. Expected: FAIL, no modules or fields.

- [ ] **Step 4: Implement.** `summary.ts`:

```ts
import { sanitisePersonText } from '../handoff/contract.js'
import { handMergeInstruction } from '../conduct/goalBranch.js'
import { GOAL_REPORT_SUMMARY_MAX_CHARS } from './constants.js'
import { formatReportUsd, shortCommit } from './escape.js'
import type { GoalReport } from './types.js'

/**
 * The Supervisor chat's note when a goal version comes to rest (spec R10, plan D10): what happened
 * to it, how its requirements stand, who held its packages, what it cost. Then a pointer to the
 * report, where the evidence and the trail are. Plain text, composed from the report's facts:
 * nothing a model wrote except the stop reason, which is Slave's own sentence and is defused like
 * everything else. Bounded by `GOAL_REPORT_SUMMARY_MAX_CHARS`.
 */
export function goalReportSummary(report: GoalReport): string {
  const lines = [`Goal v${String(report.goalVersion)} report: ${headline(report)}`, requirementsLine(report)]
  if (report.packages.length > 0) lines.push(`Packages: ${report.packages.map((pkg) => `${pkg.key} (${pkg.seat ?? 'no seat'})`).join(', ')}.`)
  const s = report.spend
  lines.push(
    `Spend on this version: ${formatReportUsd(s.versionUsd)}` +
      `${s.runsUnmeasured === 0 ? '' : ` (${String(s.runsUnmeasured)} ${s.runsUnmeasured === 1 ? 'run' : 'runs'} did not report a cost)`}` +
      `; project: ${formatReportUsd(s.projectSpentUsd)}${s.projectBudgetUsd === null ? ', no budget set' : ` of a ${formatReportUsd(s.projectBudgetUsd)} budget`}.`,
  )
  lines.push('Open the report for the evidence behind each requirement and the decision trail.')
  return sanitisePersonText(lines.join('\n')).slice(0, GOAL_REPORT_SUMMARY_MAX_CHARS)
}

function headline(report: GoalReport): string {
  const d = report.delivery
  const base = d?.baseBranch ?? 'the base branch'
  switch (report.state) {
    case 'merged': {
      const merge = d?.merge ?? null
      if (merge === null) return `merged into ${base}.`
      if (merge.by === 'human' && merge.commit !== d?.verifiedCommit) {
        return `merged into ${merge.into} by a person (commit ${shortCommit(merge.commit)}); that tree was not itself verified.`
      }
      return `merged into ${merge.into}${merge.by === 'human' ? ' by a person' : ''} (commit ${shortCommit(merge.commit)}, the verified commit).`
    }
    case 'accepted':
      return d === null
        ? 'every requirement is verified.'
        : `every requirement is verified, and it waits for you: ${handMergeInstruction(d.integrationBranch, d.baseBranch, report.workspaceId, report.goalVersion, d.verifiedCommit)}.`
    case 'needs_human': {
      const reason = d?.needsHumanReason ?? 'the verification loop stopped'
      return `stopped, and needs you: ${reason.length > 700 ? `${reason.slice(0, 700)}…` : reason}`
    }
    case 'abandoned':
      return `abandoned; nothing of it reached ${base}.`
    default:
      return `${report.state.replace('_', ' ')}.`
  }
}

function requirementsLine(report: GoalReport): string {
  if (report.requirements === null) return 'Requirements: not extracted.'
  const all = report.requirements
  const pass = all.filter((item) => item.verdict?.status === 'pass').length
  const failing = all.filter((item) => item.verdict?.status === 'fail').map((item) => item.key)
  const unverifiable = all.filter((item) => item.verdict?.status === 'unverifiable').map((item) => item.key)
  const last = report.rounds.at(-1)
  return (
    `Requirements: ${String(pass)} of ${String(all.length)} pass${last === undefined ? ', none verified yet' : ` (round ${String(last.round)})`}` +
    `${failing.length === 0 ? '' : `; failing: ${failing.join(', ')}`}${unverifiable.length === 0 ? '' : `; could not be checked: ${unverifiable.join(', ')}`}.`
  )
}
```

Add `export * from './summary.js'` to `goalReport/index.ts`.

`supervisorChat.ts`: `goalReportVersion: number | null` on `SupervisorMessageView` (doc: "Conductor Plan 5: the goal version a report note links to; null on every conversation turn"), carried in `viewOf` (add `goalReportVersion: number | null` to its input type and `goalReportVersion: row.goalReportVersion` to its output). Then:

```ts
/**
 * A note in the conversation that no model wrote (Conductor Plan 5, plan D10): a goal version's
 * report summary, posted by the orchestrator when the version comes to rest. A `supervisor` row,
 * already `answered`, with no cost and not unmeasured, so neither the spend nor the chat's cost
 * moves. Under the project's row lock, `sendSupervisorMessage`'s idiom, so it takes the next seq
 * after anything in flight and never splits a question from its reply placeholder.
 *
 * `noteKey` is unique per workspace: a key already posted answers with that row and
 * `created: false`, so a pass that crashed after posting and before stamping cannot post twice.
 * Refused for an archived project, before anything is written (archiving is "stop talking about
 * this").
 */
export async function postSupervisorNote(
  workspaceId: string,
  input: { readonly text: string; readonly noteKey: string; readonly goalReportVersion?: number },
): Promise<Result<{ readonly messageId: string; readonly created: boolean }, ControlRefusal>> {
  const text = input.text.trim().slice(0, CHAT_MESSAGE_MAX_CHARS)
  if (text === '') return err({ kind: 'invalid_message', reason: 'a note must not be blank' })
  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; archivedAt: Date | null }[]>`
      SELECT id, "archivedAt" FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const workspace = locked[0]
    if (workspace === undefined) return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId } as ControlRefusal }
    if (workspace.archivedAt !== null) return { ok: false as const, error: { kind: 'workspace_archived', workspaceId } as ControlRefusal }
    const existing = await tx.supervisorMessage.findUnique({
      where: { workspaceId_noteKey: { workspaceId, noteKey: input.noteKey } },
      select: { id: true },
    })
    if (existing !== null) return { ok: true as const, messageId: existing.id, created: false }
    const row = await tx.supervisorMessage.create({
      data: {
        workspaceId,
        seq: await nextSeq(tx, workspaceId),
        role: 'supervisor',
        status: 'answered',
        text,
        noteKey: input.noteKey,
        goalReportVersion: input.goalReportVersion ?? null,
      },
      select: { id: true },
    })
    return { ok: true as const, messageId: row.id, created: true }
  })
  return outcome.ok ? ok({ messageId: outcome.messageId, created: outcome.created }) : err(outcome.error)
}
```

(The refusals are returned before any write in the transaction, so returning them commits nothing: the rule from the top of this file.)

`apps/orchestrator/src/goalReportNotes.ts`:

```ts
import { loadGoalReport, postSupervisorNote, refusalText } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { GOAL_REPORT_NOTE_KEY_PREFIX, goalReportSummary } from '@slave-of-ai/domain'

/** What {@link restingKey} reads off a delivery row. */
export interface RestingDelivery {
  readonly id: string
  readonly workspaceId: string
  readonly goalVersion: number
  readonly status: 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned'
  readonly round: number
  readonly mergedAt: Date | null
  readonly mergeError: string | null
  readonly acceptedAt: Date | null
}

/**
 * Where a goal version is resting, as the key its chat note is posted under (plan D10), or null
 * while it is still moving. The keys are the migration's backfill, spelled the same:
 * - `merged`: it reached the base branch, by the goal pass or a person's confirmed hand merge.
 * - `abandoned`: the person moved on.
 * - `needs_human:r<round>`: the loop stopped. A version stops at most once per round (Plan 4b), so
 *   every stop gets its own note.
 * - `awaiting_merge:r<round>`: verified, and waiting for a person. That means `autoMerge` is off,
 *   git refused the merge (`mergeError`), or the goal pass has tripped about it since it was
 *   accepted (base moved, a dirty checkout). An accepted version the next pass will fast-forward
 *   is not resting, and gets its note as `merged`.
 */
export async function restingKey(delivery: RestingDelivery, autoMerge: boolean): Promise<string | null> {
  if (delivery.mergedAt !== null) return 'merged'
  if (delivery.status === 'abandoned') return 'abandoned'
  if (delivery.status === 'needs_human') return `needs_human:r${String(delivery.round)}`
  if (delivery.status !== 'accepted') return null
  if (!autoMerge || delivery.mergeError !== null) return `awaiting_merge:r${String(delivery.round)}`
  const trip = await prisma.executionEvent.findFirst({
    where: {
      workspaceId: delivery.workspaceId,
      type: 'guardrail_tripped',
      ...(delivery.acceptedAt === null ? {} : { ts: { gte: delivery.acceptedAt } }),
      payload: { path: ['detail'], string_starts_with: `goal v${String(delivery.goalVersion)} is accepted` },
    },
    select: { seq: true },
  })
  return trip === null ? null : `awaiting_merge:r${String(delivery.round)}`
}

/**
 * The Supervisor chat's side of spec R10 (plan D10): each goal version that has come to a new
 * resting point since its last note gets its report's summary, posted once (`postSupervisorNote`'s
 * key), and the delivery is stamped with the point. Driven by the delivery rows, never by scanning
 * the event log. The rows that can rest are few, and the one event query runs only for an accepted
 * version with `autoMerge` on. Returns how many notes this pass posted. An archived project gets
 * none (the tick does not reach one; the CLI's one-shot might).
 */
export async function postGoalReportNotes(workspaceId: string): Promise<number> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { autoMerge: true, archivedAt: true } })
  if (workspace === null || workspace.archivedAt !== null) return 0
  const deliveries = await prisma.goalDelivery.findMany({
    where: { workspaceId, OR: [{ mergedAt: { not: null } }, { status: { in: ['needs_human', 'abandoned', 'accepted'] } }] },
    orderBy: { goalVersion: 'asc' },
    select: { id: true, workspaceId: true, goalVersion: true, status: true, round: true, mergedAt: true, mergeError: true, acceptedAt: true, reportNotedKey: true },
  })
  let posted = 0
  for (const delivery of deliveries) {
    const key = await restingKey(delivery, workspace.autoMerge)
    if (key === null || key === delivery.reportNotedKey) continue
    const report = await loadGoalReport(workspaceId, delivery.goalVersion)
    if (!report.ok) {
      console.warn(`[report] no note for goal v${String(delivery.goalVersion)}: ${refusalText(report.error)}`)
      continue
    }
    const note = await postSupervisorNote(workspaceId, {
      text: goalReportSummary(report.value),
      noteKey: `${GOAL_REPORT_NOTE_KEY_PREFIX}v${String(delivery.goalVersion)}:${key}`,
      goalReportVersion: delivery.goalVersion,
    })
    if (!note.ok) {
      console.warn(`[report] no note for goal v${String(delivery.goalVersion)}: ${refusalText(note.error)}`)
      continue
    }
    // Guarded on the value this pass read: a concurrent pass that already stamped a newer point wins.
    await prisma.goalDelivery.updateMany({ where: { id: delivery.id, reportNotedKey: delivery.reportNotedKey }, data: { reportNotedKey: key } })
    if (note.value.created) posted += 1
  }
  return posted
}
```

`tick.ts`: import `postGoalReportNotes` from `./goalReportNotes.js`. In the ordinary branch, right after the `runGoalPass(...).catch(...)` statement:

```ts
  // Conductor Plan 5 (D10): after the goal pass, which is what brings a version to rest -- the
  // chat hears about a version that merged, stopped or was abandoned on the tick it happened.
  // Spends nothing, so it runs under H9c's wait too. Wrapped like the goal pass.
  await postGoalReportNotes(deps.workspaceId).catch((error: unknown) => {
    console.error(`[tick] the report notes for workspace ${deps.workspaceId} failed:`, error)
  })
```

and in the halt branch, immediately before `const supervisor = await superviseQuietly(deps, statsSnapshot)`, the same four lines with the comment "A halted workspace still hears that a version stopped (a verification concluded, or a person abandoned one, under the halt). No model is called."

`supervisorThreads.ts`: add to the `SupervisorMessage` interface

```ts
  /** Conductor Plan 5 (D10): on a report note, the goal version whose report the bubble links to. */
  readonly reportVersion?: number
```

and in `chatMessage`, `...(view.goalReportVersion === null ? {} : { reportVersion: view.goalReportVersion }),`.

`SupervisorThreadPanel.tsx`, right after `{message.text !== '' && <span className="block">{message.text}</span>}`:

```tsx
                {message.reportVersion !== undefined && (
                  <Link
                    data-testid="supervisor-report-link"
                    href={`/w/${workspaceId}/goals/${String(message.reportVersion)}`}
                    className="mt-2 block text-[12.5px] text-accent"
                  >
                    Open the goal v{message.reportVersion} report
                  </Link>
                )}
```

(The text is `whitespace` inside a `<span className="block">`: a multi-line note renders on one line unless the span keeps newlines. Add `whitespace-pre-line` to that span's class; it changes nothing for a one-line turn.)

- [ ] **Step 5: Run** each test file above (`npx tsc --build` before the orchestrator file), `packages/db/test/integration/enum-parity.test.ts`, `apps/web/test/integration/supervisor-threads.test.ts`, `npm run typecheck` (it names every `SupervisorMessageView` literal missing `goalReportVersion`: add `null`), `npm run web:build && rm -rf apps/web/.next`. Expected: PASS.

- [ ] **Step 6: Commit.** `feat(report): the Supervisor chat gets a goal version's report summary when the version comes to rest`, with the trailer.

---

### Task 8: End to end, a `single` goal and a two-package goal reach `accepted` with a report

**Files:**
- Modify: `apps/orchestrator/test/integration/conductor-e2e.test.ts`

**Interfaces:**
- Consumes: `loadGoalReport`, `renderGoalReportMarkdown` (Tasks 4, 1), the notes pass wired into `tick` (Task 7), the recorded merge files (Task 2).
- Produces: nothing new. This task proves spec §7's headline case.

- [ ] **Step 1: The assertions.** Import `loadGoalReport` from `@slave-of-ai/control` and `renderGoalReportMarkdown` from `@slave-of-ai/domain`. Add a helper next to `goalEvents`:

```ts
async function reportNotes(f: Fixture): Promise<{ readonly noteKey: string | null; readonly text: string }[]> {
  return prisma.supervisorMessage.findMany({ where: { workspaceId: f.workspaceId, noteKey: { not: null } }, orderBy: { seq: 'asc' }, select: { noteKey: true, text: true } })
}
```

At the end of `'takes a conducted goal from requirements to a reported package, ...'` (the `single` goal):

```ts
    // Conductor Plan 5 (spec R10, §7): the version's report, from what was recorded.
    const report = await loadGoalReport(f.workspaceId, 1)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.value.state).toBe('merged')
    expect(report.value.requirements?.map((r) => [r.key, r.verdict?.status])).toEqual([['R1', 'pass'], ['R2', 'pass']])
    expect(report.value.rounds).toHaveLength(1)
    expect(report.value.packages).toHaveLength(1)
    expect(report.value.packages[0]?.mergedFiles).toContain('m8a-work.txt')
    expect(report.value.decision?.reason).toContain('fits one session')
    expect(report.value.spend.conductorMeasuredUsd).toBeCloseTo(0.05, 6)
    const md = renderGoalReportMarkdown(report.value)
    expect(md).toContain('| R1 |')
    expect(md).toContain('### Evidence for R2')
    // Deterministic across two reads of the same rows (plan D7).
    const again = await loadGoalReport(f.workspaceId, 1)
    expect(again.ok && renderGoalReportMarkdown(again.value)).toBe(md)
    // ... and the Supervisor chat's last word about it, posted on the tick it merged.
    expect(await reportNotes(f)).toEqual([expect.objectContaining({ noteKey: 'goal-report:v1:merged' })])
    expect((await reportNotes(f))[0]?.text).toContain('Goal v1 report: merged into main')
    expect((await reportNotes(f))[0]?.text).toContain('Requirements: 2 of 2 pass (round 1).')
```

At the end of `'cuts a dependent package from the integration branch ...'` (the two-package goal, three packages with the integration package):

```ts
    const report = await loadGoalReport(f.workspaceId, 1)
    expect(report.ok && report.value.packages.map((p) => p.key)).toEqual(['config', 'integration', 'report'])
    const files = (key: string): readonly string[] | null => (report.ok ? (report.value.packages.find((p) => p.key === key)?.mergedFiles ?? null) : null)
    expect(files('report')).toContain('src/report/csv.py')
    expect(files('integration')).toContain('wiring.txt')
    expect(files('config')).toContain('src/config.py')
    expect(report.ok && report.value.requirements?.every((r) => r.verdict?.status === 'pass')).toBe(true)
    expect((await reportNotes(f)).map((n) => n.noteKey)).toEqual(['goal-report:v1:merged'])
```

At the end of `'stops for a person when a requirement cannot be checked, ...'`, a note per resting point:

```ts
    expect((await reportNotes(f)).map((n) => n.noteKey)).toEqual(['goal-report:v1:needs_human:r1', 'goal-report:v1:merged'])
```

(The needs_human note is posted by the first tick after the verification's conclusion. The test already runs two more ticks before the retry.) In `'with autoMerge off, holds the next goal version ...'`, after the few extra ticks while v1 is accepted:

```ts
    const waiting = await reportNotes(f)
    expect(waiting.map((n) => n.noteKey)).toEqual(['goal-report:v1:awaiting_merge:r1'])
    expect(waiting[0]?.text).toContain('confirm-goal-merge')
```

In `'ends in needs_human when the round cap runs out, ...'`, after the extra ticks:

```ts
    const stopped = await loadGoalReport(f.workspaceId, 1)
    expect(stopped.ok && stopped.value.state).toBe('needs_human')
    expect(stopped.ok && stopped.value.trail.map((e) => e.text)).toContain('config: sent back for rework by verification round 1.')
    expect((await reportNotes(f)).map((n) => n.noteKey)).toEqual(['goal-report:v1:needs_human:r2'])
```

(Check the package file names the fixture's `DEPENDENT` answer and the fake CLI actually write, `grep -n "csv.py\|wiring.txt\|config.py" apps/orchestrator/test/integration/conductor-e2e.test.ts scripts/gate-fakes -r`, and assert those names.)

- [ ] **Step 2: Run** `npx tsc --build && npx vitest run apps/orchestrator/test/integration/conductor-e2e.test.ts`. Expected: PASS. A failure here is a real integration gap. Fix it in the task that owns the code, not in this file.

- [ ] **Step 3: Commit.** `test(conductor): a single and a two-package goal each reach a merged version with a report and the chat's note`, with the trailer.

---

### Task 9: Whole suite, web build, gates

- [ ] **Step 1:** Stop any daemon; make sure no `next dev` is running. Run `npm run typecheck`, then `npx vitest run > /tmp/claude-1001/conductor5-suite.log 2>&1` in the background (about 15 min). Wait on the log's summary line, not on `pgrep`. Re-run any failing file alone before believing it (the daemon CLI llm-decision case flakes under load).
- [ ] **Step 2:** `npm run web:build && rm -rf apps/web/.next`; `node scripts/gate-m26-vocabulary.mjs`.
- [ ] **Step 3:** `DATABASE_URL="$GATE_DATABASE_URL" npm run db:migrate`. Then run the CI gate list with the fake-CLI env exactly as ci.yml sets it and `DATABASE_URL="$GATE_DATABASE_URL"`, under `systemd-inhibit --what=sleep:idle`, with `CHROMIUM_PATH` pointed at the installed chromium. Known red on main: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58. m56a must be green with stage 12's counts UNCHANGED (24 situations, 73 lanes) and the hook-plane digests unchanged. m45 must be green: it reads `project-goal-line` and `data-goal-version` in `stat-goal`, which Task 6 extends. m41 must be green (surface parity). Compare any other red gate against the same gate on main before calling it pre-existing.

---

## Self-review notes (for the executor)

- Spec coverage:
  - R10's page → Task 6. The Markdown export → Tasks 1 and 5 (route and CLI).
  - The requirement table (key, text, status, evidence link: the check and its output) → Tasks 1, 4, 6.
  - The packages and their owners → Task 4 (seat, persona), rendered in Tasks 1 and 6.
  - The files each touched → Task 2 (recorded by git) and Task 4 (union, plus the worker's list).
  - Spend against budget → Task 3 (`versionSpend`, `workspaceSpend`, `budgetUsd`).
  - The decision trail (size decision, staffing, questions answered, reworks and why) → Task 3 (trail with the conduct rationale, the staffing entry, rework reasons, Supervisor decisions; the questions list).
  - "The Supervisor chat's thread for the goal ends with the report's summary" → Task 7 (D10, D11).
  - §6 "Web: the goal-version report page; Markdown export route" → Tasks 5 and 6.
  - §7 "a `single` goal and a two-package goal each reach `accepted` with a report" → Task 8.
  - Every status (D2) → Task 4 tests (not conducted, merged by a person, needs_human, abandoned) and Task 8 (merged by Slave, awaiting merge, needs_human per round).
  - The honesty list (D8) → Task 1's `reportCaveats` and its tests.
  - Determinism and safety (D7) → Task 1 tests, the Task 5 route test (byte-identical, escaped), Task 6 (no elements from text).
- Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Task 3's helpers exist before Task 4 composes them, so no task ships a stub.
- Type names used across tasks: `GoalReport`, `GoalReportState`, `GoalReportRequirement`, `GoalReportVerdict`, `GoalReportRound`, `GoalReportPackage`, `GoalReportWorkerReport`, `GoalReportDelivery`, `GoalReportDecision`, `GoalReportQuestion`, `GoalReportSpend`, `GoalReportTrailEntry`, `GoalReportAuthor`, `GOAL_REPORT_STATE_LABEL`, `reportCaveats`, `renderGoalReportMarkdown`, `goalReportSummary`, `mdInline`, `mdFence`, `mdQuote`, `evidenceCut`, `evidenceAnchor`, `formatReportUsd`, `shortCommit`, `GOAL_REPORT_FILES_MAX`, `GOAL_REPORT_TRAIL_MAX`, `GOAL_REPORT_DETAIL_MAX_CHARS`, `GOAL_REPORT_SUMMARY_MAX_CHARS`, `GOAL_REPORT_NOTE_KEY_PREFIX`, `VersionScope`, `loadVersionScope`, `seatNames`, `versionSubject`, `versionTrail`, `versionQuestions`, `versionSpend`, `reportVersions`, `latestReportVersion`, `loadGoalReport`, `postSupervisorNote`, `restingKey`, `RestingDelivery`, `postGoalReportNotes`.
- Deliberately NOT here: the verification setup-window leak (Plan 4b backlog, in `dispatchVerification`), per-version budgets, Settings goal-history links, a frozen snapshot, the m54/m55 counts, re-verifying after the final merge.
