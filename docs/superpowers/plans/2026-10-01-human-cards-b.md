# Human cards, Plan B of 2: a card carries a decision, one queue per goal version

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec H2 and H4. A card about a question offers the decisions that fit it: send this answer, write my own answer, give a package work, give a file to a package, record a shared decision, change a requirement, or dismiss and close with a reason. Each is one call to one route, claims its card conditionally, and closes the question. A paused asker continues with what the person decided. "Give a package work" is routed by the hand-off machinery with source `person`. "Give a file" is the one path that moves ownership: it is checked against disjointness, the manifest-family rule and the registration directories, under the goal delivery lock, and the next run's gate and diff audit enforce it. A person's shared decision joins the version's decisions under the conductor's cap and title rules. A requirement change opens a new goal version through `requestChange`. Cards whose action is the machine's keep approve and reject. The queue is listed per goal version, with what blocks the version first. Cards on one subject merge. A worker's note that needs no decision goes to the activity feed and the report, not to a card. Simple mode and Home read the same queue, a draftless answer card offers no one-click approve, and the sidebar counts blocking cards on their own. The observed integration question (OBS-18) is driven end to end: the person gives the skeleton the start-script work, the skeleton is reopened, and the version passes its smoke.

**Architecture:** Pure rules live in the domain. `packages/domain/src/supervisor/cardDecisions.ts` holds the decision schema, which decisions a card offers, the resume messages and the summary. `packages/domain/src/conduct/grant.ts` holds `planFileGrant`, built on `ownershipRuleFor`, `manifestProblems` and `registrationProblems`. `packages/domain/src/supervisor/queue.ts` holds the group key and the version queue. Control gains one verb, `decideCard` (`packages/control/src/cards.ts`), whose every branch claims the card and closes its question inside one transaction: a refusal there throws, so nothing is written. The effects run after the commit through the existing verbs (`approveDecision`, `answerQuestion`, `routeHandOffs`, `requestChange`) or inside the transaction (`writeGoalDecisionIn`, the file grant under `withDeliveryLock`). `WorkPackage.releasedPaths` records a path a person took from a package, and `ownershipRuleFor` excludes it, so the gate's permission file and the diff audit need no change (the hook plane stays as it is). The web gains one route, `.../decisions/[decisionId]/decide`, one component, `CardDecisions`, and a grouped `buildNeedsYou`. Worker notes are a `notes` list in `<slave-report>` and an event, `workspace.package_noted`.

**Tech Stack:** TypeScript monorepo (npm workspaces, ESM, `.js` import suffixes), Prisma/Postgres, vitest, Next.js (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-10-01-human-cards-design.md` (H2, H4, §4, §5). Motivation: `/home/meren/slaveofai-logs/observations.md` (OBS-8, 11, 13, 14, 18). **Requires** Plan A (`2026-10-01-human-cards-a.md`) on `feature/human-cards`: `closeQuestionIn`, `announceQuestionClosed`, `closedByOf`, `retireQuestionCards`, `QuestionCard`, `loadQuestionCards`, `continueWaitingRuns`, `personText`, `dismissResumeMessage`, `PERSON_CARD_TEXT_MAX_CHARS`, `isQuestionSituation`, `cardKey`, the `person` hand-off source and its operator heading.

## Decisions this plan makes (read before starting)

- **D1. One endpoint with a discriminated body.** `POST /api/w/[workspaceId]/supervisor/decisions/[decisionId]/decide` takes `{ kind: 'send_answer' } | { kind: 'write_answer', body } | { kind: 'give_work', target: { package } | { path }, request } | { kind: 'give_file', path, toPackage } | { kind: 'record_decision', title, text } | { kind: 'change_requirement', request } | { kind: 'dismiss', reason: string | null }`. `cardDecisionSchema` (domain, zod) is the one validator. The route uses it for a 400, and `decideCard` uses it again, because the CLI and tests call the verb directly. Authorisation is the approve route's: `requirePrincipal`, then `decisionControlResponse` (a decision in another workspace is a 404), and then the verb with the real `Principal`. Seven routes would repeat that shell seven times, and a discriminated body keeps the "which decisions fit" rule in one place (`cardOffers`). *Cost if wrong:* a route-level permission per decision kind would need a switch here. Nothing asks for one.
- **D2. The claim and the close are one transaction, and every refusal before or inside it writes nothing.** Before the transaction: the body parses, the card exists and is `pending`, it is a question card (`card_not_a_question` otherwise: machine cards keep approve and reject), its question is open or `timed_out` (`question_closed` otherwise, naming who closed it and when), and the decision is among `cardOffers` (`card_decision_not_offered`). Inside, `claimAndClose(tx, ...)` locks the question row, claims the card (`updateMany ... status: pending`, storing `personDecision`), and closes the question. It THROWS `CardRefused` when the card or the question was taken first, so the claim rolls back too. A `timed_out` question is not closed again: the first close stands (Plan A D1). The card is still claimed, and the decision's effect still applies. The person sees `decision_not_pending` with who resolved it and when (Plan A Task 4), or `question_closed`.
- **D3. What each decision does.** The card's status is `approved` when the person carried out what the card asked (an `escalate_to_human` card, or send/write on an answer card) and `rejected` when the machine's proposed action was not taken (dismiss, or another decision on an answer or re-address card). `SupervisorDecision.personDecision` (new, `Json?`, validated by `personDecisionSchema`) records `{ decision, goalVersion, by, at, summary, grant? }`. The goal report lists those rows. The question closes `decided`, `dismissed` or `superseded`, with the asker's resume message as `closedNote`, and Plan A's `continueWaitingRuns` continues a parked asker with it.
  - `send_answer`: `approveDecision(decisionId, principal)`. The draft's shared decision and hand-off apply (Supervisor-as-conductor plan B D7). The question closes `answered`.
  - `write_answer`: on an answer card, `approveDecision(..., { body })`, which applies neither the decision nor the hand-off. On any other question card, the card is claimed, then `answerQuestion(..., 'human')`.
  - `give_work`: resolve the target (`resolveHandOff` with no reporter). Claim and close `decided`, then `routeHandOffs` with source `person`, `sourceKey: person:<decisionId>` and `fromRunId` = the question's asking run (D4).
  - `give_file`: see D5.
  - `record_decision`: `writeGoalDecisionIn` inside the claim's transaction (D6).
  - `change_requirement`: claim and close `superseded`, then `requestChange`. A refusal after the claim marks the card `failed` with the refusal's text and reopens the question.
  - `dismiss`: claim and close `dismissed`, with `dismissResumeMessage(reason)`.
  On a `timed_out` question, an answer becomes a late hand-off (Plan A D9), and the other decisions apply as on an open one.
- **D4. A person's hand-off keeps `fromRunId` NOT NULL, with the asking run as its stand-in.** The source enum already has `person` (Plan A Task 1). `fromRunId` is the question's `senderRunId`, which every pending question has (`stillPendingQuestion` requires it), as an answer's hand-off already uses the asking run. `fromPackageKey` is null, so a hand-off to the asker's own package is a real target and is never `own`. The item is rendered under the operator's heading (Plan A D10). Idempotent by `person:<decisionId>:0`. When the routing after the commit throws (a busy delivery lock), the goal pass's new backstop, `routeStoredPersonHandOffs`, routes it again: every `personDecision` of kind `give_work` in the version with no row at that key. A target that resolves to no package refuses the decision (`card_decision_refused`, before the claim), because a person's request has nobody to escalate to. *Cost if wrong:* a nullable `fromRunId` would serve a card with no asking run. No such card exists, since every question card's question was sent by a run.
- **D5. Giving a file.** `planFileGrant({ path, toKey, packages })` is pure and works on a whole `WorkPackage` set. The path must be one concrete repository file (`handOffPath`: no glob, `..`, absolute path or `./`). The current owner comes from `ownershipRuleFor` (a non-integration owner first, else integration). The move:
  - the target gains the literal in `ownedPaths` (and loses it from `releasedPaths`, if it had released it);
  - the owner loses the literal if it owned it by name, or gains it in `releasedPaths` if it owned it by a glob;
  - an integration owner changes nothing, because its rule already excludes every other package's paths.
  It is refused:
  - when the target already owns the file;
  - when the workspace is in single mode (`**`);
  - when the target is the integration package and the owner holds the file by a glob (the integration package owns only what nobody else owns, and a glob cannot be narrowed for it without the hook plane);
  - when, after the move, the number of non-integration owners of the path is not exactly the target (disjointness);
  - by `manifestProblems` (a manifest or lockfile goes only to the skeleton);
  - by any problem `registrationProblems` raises after the move that it did not raise before (a shared directory stays file-per-package).

  `ownershipRuleFor` excludes `releasedPaths` from a non-integration package's rule. That one change reaches the gate's permission file (`ownershipPatterns`), the diff audit, `resolveHandOff` and the smoke hand-off. The grant runs under `withDeliveryLock` only while the delivery is `integrating` with no `activeSmokeId` or `activeRunId`, and while neither the target's nor the owner's task has an `activeRunId`. The spec names the target only. The owner is added because its live run's diff audit would flag its own edit of a file taken from it mid-run. The `WorkPackage` writes are guarded on the arrays they read, and a lost guard THROWS. The claim and the close follow in the same transaction. A refused grant closes nothing (spec §4). The contract of the package that gave the file says so under "Given by a person to another package (no longer yours)". *Cost if wrong:* a person waits for a run to end before moving a file its owner is editing.
- **D6. A person's shared decision is the conductor's writer, generalised.** `recordAnswerDecision` (`conductorAnswer.ts:94-135`) splits into `writeGoalDecisionIn(tx, input)`, which takes the version's advisory lock, refuses at `GOAL_DECISIONS_MAX` and refuses a title the version already has (by `decisionTitleKey`, read under the lock instead of caught as a unique violation, so the transaction stays usable). It throws `GoalDecisionRefused`. The conductor path wraps it in its own transaction and maps the refusal to `at_cap` or `title_taken`, exactly as today. The person path calls it inside the claim's transaction with `source: 'person'`, so a refusal rolls the claim back and closes nothing. Bounds are the conductor's: a title of at most 80 characters and a decision of at most 600.
- **D7. Which decisions a card offers (`cardOffers`).** None when the question is closed for a reason other than `timed_out` (the card is about to be retired). `send_answer` only on an `answer_question` card whose draft has a body. `write_answer`, `change_requirement` and `dismiss` always. `give_work`, `give_file` and `record_decision` only when the question belongs to a goal version with packages. `QuestionCard` gains `packages` (key, title, whether it is integration) and `offers`, filled by `listDecisions` from the card's action and draft.
- **D8. The queue is per goal version, grouped by subject, with blocking first.** `groupKeyFor`:
  - a question card is grouped under `question:<messageId>`;
  - a card whose subject or `facts.taskId` is a task, and a blocked task, under `task:<taskId>`;
  - a version-level card (`<ws>:v<n>...`) under its own key;
  - anything else under `cardKey`.

  The version is the question's or the task's (`workPackage.goalVersion ?? goalVersion`), parsed from a `:v<n>` subject, or null for project-level items. A group blocks its version when it holds a question whose asker is parked, a `goal_needs_human`, a `task_blocked_human` or a blocked task. `buildQueue` orders versions newest first with project-level last, and within a version puts blocking groups first, then the oldest. `NeedsYouItem` gains `goalVersion`, `blocking`, `groupKey`, `mergedIds` and `oneClick`. A question with an open card is listed once, as the card. `oneClick` is false on a question card that does not offer `send_answer`: `NeedsYouRow` then shows "decide" (a link to the card) instead of Approve, and a draftless answer card can no longer be approved into `draft_missing`. Reject stays, and on a question card it now dismisses (Plan A D4). Simple mode's strip, the Overview tile and Home read `buildNeedsYou`. Home orders blocking items first. The sidebar gains `blockingCount`: runs parked on an open question, plus pending `goal_needs_human` and `task_blocked_human` cards.
- **D9. What stops being a card.** Three things. A parked conductor question's second card (`waiting_stale`, Plan A D3). A worker's information that needs no decision, which goes to `<slave-report>`'s new `notes` (at most 10, each at most 1000 characters; "the vendor key is a placeholder"), is appended as one `workspace.package_noted` event per note, and is listed in the goal report under "Notes from the packages". The contract tells workers that a note is never a question or a hand-off. And `verification_failed`, which stays the rules' `no_action` (Conductor Plan 4b). A note is not a situation at all, so no Supervisor rule has to guess what needs a person.
- **D10. Events and gates.** One event: `workspace.package_noted { version, packageKey, runId, note ≤ 1000 }`, lane `work`, idempotent per run (a replayed conclusion writes none). `LANE_BY_TYPE` goes from 77 to 78 (m56a stage 12). No situation or action kind changes (25 / 25). A file grant and the other card decisions are recorded on the card (`personDecision`) and through Plan A's `slave.question_closed`, whose note carries the summary. No event of their own.
- **D11. Compatibility.** Every card open before this plan is a pending row of a question kind or a machine kind. Question cards gain the decide route (D7 decides what they offer), and approve and reject keep working (Plan A Task 4). Old questions follow Plan A D1. Old `WorkPackage` rows read `releasedPaths = []`. Old reports have no `notes`, which reads as none.
- **Left out on purpose:** push and e-mail notifications (spec §6); a file grant that narrows the integration package's glob exclusions (D5); deciding on a machine card beyond approve and reject; editing a requirement set in place (spec H2.6: there is none).

## Global Constraints

- Vocabulary: the product says "slave", never "agent" (`node scripts/gate-m26-vocabulary.mjs`). Never write the external persona catalogue's repository name anywhere tracked (`git grep -nE "agency-agent[s]"` prints nothing).
- Never run prettier. The repository has no prettier config, and `prettier --write` reformats against the codebase's style. Match surrounding code: WHY doc comments, `readonly`, explicit return types, `.js` import suffixes (not in `apps/web`), `Result`/`ok`/`err`. `packages/control` does not depend on zod: validate with the domain's exported schemas.
- Tests: `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL` in the shell first. That export also applies to any scratch Prisma script: a script's `PrismaClient` reads `DATABASE_URL`, which is the dev DB unless exported. Any `prisma migrate diff` passes the database URL explicitly (`--from-url "$TEST_DATABASE_URL"`), never the dev DB. Run ONE vitest process at a time, and stop any daemon first: concurrent runs TRUNCATE each other's tables, and a running daemon breaks `subscribe.test.ts`. Iterate per file. Run `npx tsc --build` after changing a package another package's test imports. Run `npm run typecheck` before every commit, not `tsc --build`: the script also checks every `tsconfig.test.json` and `apps/web`. Run the whole suite once, at the end, in the background.
- `apps/web` changes gate on `npm run web:build`, with no `next dev` running, then `rm -rf apps/web/.next`. Tasks 1, 6, 7, 8 and 9 change `apps/web`.
- Never touch the dev DB. Never `db:seed`. Gates run only on `DATABASE_URL="$GATE_DATABASE_URL"`, with the fake-CLI env exactly as `.github/workflows/ci.yml` sets it (`SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CURSOR_BIN` from `scripts/gate-fakes`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`), with the host daemon stopped, under `systemd-inhibit --what=sleep:idle`. Red on main today, not regressions: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58.
- Migrations: hand-written, purely additive, WHY header, dated name; `npm run db:generate && npm run db:migrate:test`. The schema must mirror the SQL exactly, or m56a stage 12's `prisma migrate diff` fails.
- Inside a Prisma interactive transaction a refusal must THROW to roll back; a returned value commits what was written.
- `vi.spyOn` on a Prisma delegate breaks later tests: assign a wrapper and restore it in `finally`.
- Never `TRUNCATE "SlaveTemplate" CASCADE` in a test; delete your own template rows by id.
- The hook plane (`scripts/pause-gate.sh`, `scripts/cursor-shell-gate.sh`, `scripts/tool-result-tap.sh`, `scripts/lib/pause-flag.sh`, `scripts/lib/permissions.sh`) does not change: a released path reaches the gate through `ownershipPatterns`' existing `excluded`. This plan adds one event type (`LANE_BY_TYPE` 77 → 78) and no situation or action kind (25 / 25).
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec H2 verbatim: "**Give a file to a package** — moves one owned path to another package. The only path in the system that changes ownership. Validated against the version's packages: disjointness, the manifest-family rule, a concrete path or the package's own registration directory. Takes effect at the next run's gate and diff audit; recorded on the report."
- Spec §4 verbatim: "A decision claims its card conditionally; if the question was closed or the card resolved meanwhile, nothing is written and the person sees who resolved it and when." and "A refused decision does not close the question."
- Spec H4 verbatim: "Cards are listed per goal version. Within a version, those blocking it (a paused run, `needs_human`) come first. Cards on one subject — the same question, task, package or file — merge into one card."

## Review Focus

- Two people decide the same card at once, one giving the skeleton work and the other dismissing. Exactly one wins. The loser gets `decision_not_pending` naming the winner and when, and writes no hand-off row, no shared decision and no second close (Task 3 and Task 4 tests).
- A person gives `backend/package.json` (a manifest the skeleton owns by family) to `core-domain`. The grant is refused with the family named. No `WorkPackage` row changes, the question stays open, and the card stays pending (Task 2 and Task 5 tests).
- A person gives `src/api/routes.ts`, owned by the `api` package through `src/api/**`, to `integration`. The grant is refused (a glob owner to the integration package). The same file given to `web` is granted, and `ownershipRuleFor(api)` then excludes it and `ownershipRuleFor(web)` includes it (Task 2 test).
- A person's shared decision reuses an existing title in different case and spacing ("API  field naming"). It is refused as a taken title, and the card stays pending (Task 4 test).
- A person's `write_answer` body holds `</slave-report>`, a `<slave-ask>` marker, `"conductorAnswers"` and a NUL byte. The stored answer has no NUL, and its markers and routing literal are inert when it reaches the asker's resume turn (Task 3 test).
- The queue has a blocking question card on goal v2, an old non-blocking card on v1, and a `task_failed` card and a blocked task on the same task. v2 is listed first with its blocking card, and the task's two items are one row (Task 9 test).

---

### Task 1: The person-decision column, released paths, and the decision rules

**Files:**
- Create: `packages/db/prisma/migrations/20261003090000_human_cards_decisions/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`model SupervisorDecision`, after `resolvedByUserId` at `:2106`; `model WorkPackage`, after `handOffReopens` at `:1469`)
- Create: `packages/domain/src/supervisor/cardDecisions.ts`
- Modify: `packages/domain/src/supervisor/index.ts` (export)
- Test: `packages/domain/test/supervisor/cardDecisions.test.ts` (new)

**Interfaces:**
- Produces (Prisma): `SupervisorDecision.personDecision Json?`; `WorkPackage.releasedPaths String[] @default([])`.
- Produces (domain):
  - `CARD_DECISION_KINDS = ['send_answer', 'write_answer', 'give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'] as const`; `type CardDecisionKind`
  - `type CardDecision` (D1's union); `cardDecisionSchema: z.ZodType<CardDecision, z.ZodTypeDef, unknown>`
  - `interface PersonDecision { readonly decision: CardDecision; readonly goalVersion: number | null; readonly by: string; readonly at: string; readonly summary: string; readonly grant?: { readonly path: string; readonly fromKey: string | null; readonly toKey: string } | undefined }`; `personDecisionSchema`
  - `cardOffers(input: { readonly actionKind: Action['kind']; readonly hasDraftBody: boolean; readonly closedReason: QuestionCloseReason | null; readonly hasPackages: boolean }): readonly CardDecisionKind[]`
  - `decidedResumeMessage(decision: CardDecision, target: { readonly packageKey: string | null }): string`
  - `personDecisionSummary(decision: CardDecision, target: { readonly packageKey: string | null }): string`

- [ ] **Step 1: Migration**

```sql
-- Human-cards spec H2, plan B (2026-10-03): a card carries a person's decision.
--
-- `SupervisorDecision.personDecision` is what a person decided on a question card (give a package
-- work, give a file, record a shared decision, change a requirement, write an answer, dismiss),
-- validated at read by `personDecisionSchema`; the goal report lists it. Null on every card a
-- person approved or rejected the old way, and on every machine card.
--
-- `WorkPackage.releasedPaths` is the literal paths a person gave from this package to another while
-- it owned them by a glob (plan B D5): its ownership rule excludes them, so the gate and the diff
-- audit enforce the move with no change to the hook plane.
--
-- PURELY ADDITIVE: one nullable column, one defaulted column.

ALTER TABLE "SupervisorDecision" ADD COLUMN "personDecision" JSONB;
ALTER TABLE "WorkPackage" ADD COLUMN "releasedPaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
```

- [ ] **Step 2: Schema.** In `model SupervisorDecision`, after `resolvedByUserId`:

```prisma
  /// Human-cards spec H2 (plan B D3): what a person decided on this question card, validated at read
  /// by `personDecisionSchema`; null for a card approved or rejected the old way, and every machine card.
  personDecision   Json?
```

In `model WorkPackage`, after `handOffReopens`:

```prisma
  /// Human-cards spec H2 (plan B D5): literal paths a person gave from this package to another while it
  /// owned them by a glob; `ownershipRuleFor` excludes them.
  releasedPaths   String[] @default([])
```

Run `npm run db:generate && npm run db:migrate:test`.

- [ ] **Step 3: Failing tests.** Create `packages/domain/test/supervisor/cardDecisions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cardDecisionSchema, cardOffers, decidedResumeMessage, personDecisionSchema, personDecisionSummary } from '../../src/supervisor/cardDecisions.js'

describe('card decisions (human cards H2)', () => {
  it('reads each decision and refuses a malformed one', () => {
    expect(cardDecisionSchema.safeParse({ kind: 'send_answer' }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'give_work', target: { package: 'skeleton' }, request: 'add a start script' }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'give_work', target: { path: 'backend/package.json' }, request: 'add a start script' }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'give_work', target: { package: 'a', path: 'b' }, request: 'x' }).success).toBe(false)
    expect(cardDecisionSchema.safeParse({ kind: 'give_file', path: 'src/a.ts', toPackage: 'web' }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'record_decision', title: 't'.repeat(81), text: 'x' }).success).toBe(false)
    expect(cardDecisionSchema.safeParse({ kind: 'write_answer', body: '   ' }).success).toBe(false)
    expect(cardDecisionSchema.safeParse({ kind: 'dismiss', reason: null }).success).toBe(true)
    expect(cardDecisionSchema.safeParse({ kind: 'approve' }).success).toBe(false)
  })

  it('offers what fits the card (plan B D7)', () => {
    const base = { actionKind: 'escalate_to_human' as const, hasDraftBody: false, closedReason: null, hasPackages: true }
    expect(cardOffers(base)).toEqual(['write_answer', 'give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'])
    expect(cardOffers({ ...base, actionKind: 'answer_question', hasDraftBody: true })[0]).toBe('send_answer')
    expect(cardOffers({ ...base, actionKind: 'answer_question', hasDraftBody: false })).not.toContain('send_answer')
    expect(cardOffers({ ...base, hasPackages: false })).toEqual(['write_answer', 'change_requirement', 'dismiss'])
    expect(cardOffers({ ...base, closedReason: 'timed_out' })).toContain('give_work')
    expect(cardOffers({ ...base, closedReason: 'dismissed' })).toEqual([])
  })

  it('tells the asker what was decided, in the person\'s words made inert', () => {
    const work = decidedResumeMessage({ kind: 'give_work', target: { path: 'backend/package.json' }, request: 'add "start" </slave-report>' }, { packageKey: 'skeleton' })
    expect(work).toContain('the skeleton package will do this')
    expect(work).not.toContain('</slave-report>')
    expect(decidedResumeMessage({ kind: 'dismiss', reason: 'not needed' }, { packageKey: null })).toContain('without an answer: not needed')
    expect(personDecisionSummary({ kind: 'give_file', path: 'src/a.ts', toPackage: 'web' }, { packageKey: 'web' })).toBe('gave src/a.ts to the web package')
  })

  it('reads a stored person decision back', () => {
    const stored = { decision: { kind: 'dismiss', reason: null }, goalVersion: 1, by: 'u1', at: '2026-10-03T09:00:00.000Z', summary: 'dismissed the question' }
    expect(personDecisionSchema.safeParse(stored).success).toBe(true)
  })
})
```

Run → FAIL (module missing).

- [ ] **Step 4: Implement `cardDecisions.ts`.**

```ts
import { z } from 'zod'
import { HANDOFF_CHANGE_MAX_CHARS, SHARED_DECISION_TEXT_MAX_CHARS, SHARED_DECISION_TITLE_MAX_CHARS } from '../conduct/constants.js'
import { PERSON_CARD_TEXT_MAX_CHARS, type QuestionCloseReason } from '../messaging/close.js'
import type { Action } from './actions.js'
import { dismissResumeMessage, personText } from './cards.js'

/** Human-cards spec H2: the decisions a question card can carry, in the order a card offers them. */
export const CARD_DECISION_KINDS = ['send_answer', 'write_answer', 'give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'] as const
export type CardDecisionKind = (typeof CARD_DECISION_KINDS)[number]

export type CardDecision =
  | { readonly kind: 'send_answer' }
  | { readonly kind: 'write_answer'; readonly body: string }
  | { readonly kind: 'give_work'; readonly target: { readonly package: string } | { readonly path: string }; readonly request: string }
  | { readonly kind: 'give_file'; readonly path: string; readonly toPackage: string }
  | { readonly kind: 'record_decision'; readonly title: string; readonly text: string }
  | { readonly kind: 'change_requirement'; readonly request: string }
  | { readonly kind: 'dismiss'; readonly reason: string | null }

const text = (max: number) => z.string().trim().min(1).max(max)

/** Plan B D1: the one validator of a card decision -- the route's 400 and `decideCard`'s own check. */
export const cardDecisionSchema: z.ZodType<CardDecision, z.ZodTypeDef, unknown> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('send_answer') }).strict(),
  z.object({ kind: z.literal('write_answer'), body: text(PERSON_CARD_TEXT_MAX_CHARS) }).strict(),
  z
    .object({
      kind: z.literal('give_work'),
      target: z.union([z.object({ package: text(40) }).strict(), z.object({ path: text(500) }).strict()]),
      request: text(HANDOFF_CHANGE_MAX_CHARS),
    })
    .strict(),
  z.object({ kind: z.literal('give_file'), path: text(500), toPackage: text(40) }).strict(),
  z.object({ kind: z.literal('record_decision'), title: text(SHARED_DECISION_TITLE_MAX_CHARS), text: text(SHARED_DECISION_TEXT_MAX_CHARS) }).strict(),
  z.object({ kind: z.literal('change_requirement'), request: text(PERSON_CARD_TEXT_MAX_CHARS) }).strict(),
  z.object({ kind: z.literal('dismiss'), reason: z.string().trim().max(PERSON_CARD_TEXT_MAX_CHARS).nullable() }).strict(),
]) as z.ZodType<CardDecision, z.ZodTypeDef, unknown>

/** Plan B D3: what a card records about a person's decision. */
export interface PersonDecision {
  readonly decision: CardDecision
  readonly goalVersion: number | null
  /** A user id, or `operator`. */
  readonly by: string
  readonly at: string
  /** {@link personDecisionSummary}: the one sentence the report and the event's note carry. */
  readonly summary: string
  /** A file grant's move, as it was made. */
  readonly grant?: { readonly path: string; readonly fromKey: string | null; readonly toKey: string } | undefined
}

export const personDecisionSchema: z.ZodType<PersonDecision, z.ZodTypeDef, unknown> = z.object({
  decision: cardDecisionSchema,
  goalVersion: z.number().int().positive().nullable(),
  by: z.string().min(1).max(200),
  at: z.string().min(1),
  summary: z.string().min(1).max(500),
  grant: z.object({ path: z.string().min(1), fromKey: z.string().nullable(), toKey: z.string().min(1) }).optional(),
})

/** Plan B D7: the decisions that fit a card, in {@link CARD_DECISION_KINDS} order. */
export function cardOffers(input: {
  readonly actionKind: Action['kind']
  readonly hasDraftBody: boolean
  readonly closedReason: QuestionCloseReason | null
  readonly hasPackages: boolean
}): readonly CardDecisionKind[] {
  if (input.closedReason !== null && input.closedReason !== 'timed_out') return []
  return CARD_DECISION_KINDS.filter((kind) => {
    if (kind === 'send_answer') return input.actionKind === 'answer_question' && input.hasDraftBody
    if (kind === 'give_work' || kind === 'give_file' || kind === 'record_decision') return input.hasPackages
    return true
  })
}

const pkgName = (key: string | null): string => (key === null ? 'another' : `the ${personText(key, 40)}`)

/** Plan B D3: the one sentence a person's decision is recorded and reported as. */
export function personDecisionSummary(decision: CardDecision, target: { readonly packageKey: string | null }): string {
  switch (decision.kind) {
    case 'send_answer':
      return 'sent the drafted answer'
    case 'write_answer':
      return 'answered in their own words'
    case 'give_work':
      return `gave ${pkgName(target.packageKey)} package work: ${personText(decision.request, 300)}`
    case 'give_file':
      return `gave ${personText(decision.path, 200)} to ${pkgName(decision.toPackage)} package`
    case 'record_decision':
      return `recorded the shared decision "${personText(decision.title, 80)}"`
    case 'change_requirement':
      return `changed a requirement: ${personText(decision.request, 300)}`
    case 'dismiss':
      return decision.reason === null || personText(decision.reason) === '' ? 'dismissed the question' : `dismissed the question: ${personText(decision.reason, 300)}`
  }
}

/** Plan B D3: what a parked asker continues with once a person decided its question without an answer. */
export function decidedResumeMessage(decision: CardDecision, target: { readonly packageKey: string | null }): string {
  switch (decision.kind) {
    case 'give_work':
      return `A person decided on your question: ${pkgName(target.packageKey)} package will do this: ${personText(decision.request)}. Do not make that change yourself; continue with the rest, and say in your report what you left to it.`
    case 'give_file':
      return `A person decided on your question: ${personText(decision.path, 200)} now belongs to ${pkgName(decision.toPackage)} package. Continue with the rest, and say in your report what you left to it.`
    case 'record_decision':
      return `A person recorded a shared decision for your goal version: "${personText(decision.title, 80)}" -- ${personText(decision.text, 600)}. Continue with it.`
    case 'change_requirement':
      return `A person changed the requirements in answer to your question: ${personText(decision.request)}. A new goal version will be planned from it; finish what you can and say in your report what the change leaves undone.`
    case 'dismiss':
      return dismissResumeMessage(decision.reason)
    case 'send_answer':
    case 'write_answer':
      // An answer is delivered as itself (`deliverAnswers`); this text is never sent for one.
      return 'A person answered your question.'
  }
}
```

The test expects `'gave src/a.ts to the web package'`, and `pkgName('web')` gives `the web`, so the template above reads `to the web package`. Add `export * from './cardDecisions.js'` to `packages/domain/src/supervisor/index.ts`.

- [ ] **Step 5: Run.** `npx vitest run packages/domain/test/supervisor/cardDecisions.test.ts` → PASS. `npx prisma migrate diff --from-url "$TEST_DATABASE_URL" --to-schema-datamodel packages/db/prisma/schema.prisma --exit-code` shows no difference. `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma packages/domain/src/supervisor/cardDecisions.ts packages/domain/src/supervisor/index.ts packages/domain/test/supervisor/cardDecisions.test.ts
git commit -m "feat(domain): the decisions a question card can carry, which fit it, and what the asker is told

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Giving a file, as a rule over the package set

**Files:**
- Create: `packages/domain/src/conduct/grant.ts`
- Modify: `packages/domain/src/conduct/index.ts` (export)
- Modify: `packages/domain/src/conduct/ownership.ts:5`, `:22-28` (`releasedPaths`)
- Modify: `packages/domain/src/conduct/contract.ts:93-114` (`PackageContractInput.pkg.releasedPaths?`), `:169-172` (the given-away lines)
- Modify: `packages/control/src/handOffs.ts:85-97` (`packagesOf` selects `releasedPaths`); `apps/orchestrator/src/smoke.ts:474-478` (select `releasedPaths`)
- Test: `packages/domain/test/conduct/grant.test.ts` (new), `packages/domain/test/conduct/ownership.test.ts` (one case; the file that tests `ownershipRuleFor`: `grep -rln ownershipRuleFor packages/domain/test`), `packages/domain/test/conduct/contract.test.ts` (one case)

**Interfaces:**
- Consumes: `handOffPath` (`conduct/smoke.ts:98`), `ownershipRuleFor`, `isOwned`, `manifestProblems`, `registrationProblems`, `SKELETON_PACKAGE_KEY`, `PackageRegistration`.
- Produces:
  - `interface GrantPackage { readonly key: string; readonly ownedPaths: readonly string[]; readonly releasedPaths: readonly string[]; readonly isIntegration: boolean; readonly registrations: readonly PackageRegistration[] }`
  - `interface FileGrant { readonly path: string; readonly fromKey: string | null; readonly toKey: string; readonly changes: readonly { readonly key: string; readonly ownedPaths: readonly string[]; readonly releasedPaths: readonly string[] }[] }`
  - `planFileGrant(input: { readonly path: string; readonly toKey: string; readonly packages: readonly GrantPackage[] }): Result<FileGrant, string>`
  - `ownershipRuleFor`'s `Owner` gains `readonly releasedPaths?: readonly string[]`.

- [ ] **Step 1: Failing tests.** Create `packages/domain/test/conduct/grant.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { planFileGrant, type GrantPackage } from '../../src/conduct/grant.js'
import { isOwned, ownershipRuleFor } from '../../src/conduct/ownership.js'

const pkg = (key: string, ownedPaths: string[], extra: Partial<GrantPackage> = {}): GrantPackage => ({ key, ownedPaths, releasedPaths: [], isIntegration: key === 'integration', registrations: [], ...extra })
const VERSION = [
  pkg('skeleton', ['backend/package.json', 'backend/package-lock.json', 'scripts/verify.sh']),
  pkg('api', ['src/api/**', 'src/api/index.ts']),
  pkg('web', ['src/web/**']),
  pkg('db', ['backend/migrations/0001_init.sql'], { registrations: [{ directory: 'backend/migrations', prefix: '01_' }] }),
  pkg('integration', []),
]

describe('planFileGrant (human cards H2.4, plan B D5)', () => {
  it('moves a glob-owned file by releasing it from its owner', () => {
    const granted = planFileGrant({ path: 'src/api/routes.ts', toKey: 'web', packages: VERSION })
    expect(granted.ok && granted.value).toEqual({
      path: 'src/api/routes.ts',
      fromKey: 'api',
      toKey: 'web',
      changes: [
        { key: 'api', ownedPaths: ['src/api/**', 'src/api/index.ts'], releasedPaths: ['src/api/routes.ts'] },
        { key: 'web', ownedPaths: ['src/web/**', 'src/api/routes.ts'], releasedPaths: [] },
      ],
    })
    const after = VERSION.map((p) => {
      const change = granted.ok ? granted.value.changes.find((c) => c.key === p.key) : undefined
      return change === undefined ? p : { ...p, ...change }
    })
    const api = after.find((p) => p.key === 'api')
    const web = after.find((p) => p.key === 'web')
    expect(api !== undefined && isOwned(ownershipRuleFor(api, after) ?? { owned: null, excluded: [] }, 'src/api/routes.ts')).toBe(false)
    expect(web !== undefined && isOwned(ownershipRuleFor(web, after) ?? { owned: null, excluded: [] }, 'src/api/routes.ts')).toBe(true)
  })

  it('moves a file owned by name by taking the name away', () => {
    const granted = planFileGrant({ path: 'src/api/index.ts', toKey: 'web', packages: VERSION })
    expect(granted.ok && granted.value.changes.find((c) => c.key === 'api')).toEqual({ key: 'api', ownedPaths: ['src/api/**'], releasedPaths: ['src/api/index.ts'] })
  })

  it('takes a file nobody owns from the integration package by giving it to the target', () => {
    const granted = planFileGrant({ path: 'Dockerfile', toKey: 'web', packages: VERSION })
    expect(granted.ok && granted.value).toMatchObject({ fromKey: 'integration', changes: [{ key: 'web', ownedPaths: ['src/web/**', 'Dockerfile'], releasedPaths: [] }] })
  })

  it('refuses what the rules refuse, naming why', () => {
    const refused = (path: string, toKey: string, packages = VERSION): string => {
      const result = planFileGrant({ path, toKey, packages })
      return result.ok ? 'granted' : result.error
    }
    expect(refused('src/**', 'web')).toContain('not one repository file')
    expect(refused('../etc/passwd', 'web')).toContain('not one repository file')
    expect(refused('src/web/a.ts', 'web')).toContain('already owns')
    expect(refused('src/a.ts', 'nobody')).toContain('no package has the key')
    expect(refused('backend/package.json', 'api')).toContain('belong to the skeleton package')
    expect(refused('src/api/routes.ts', 'integration')).toContain('the integration package')
    expect(refused('backend/migrations/01_users.sql', 'api')).toContain('file-per-package')
    expect(refused('a.ts', 'main', [pkg('main', ['**'])])).toContain('one package owns every file')
  })
})
```

`ownership.test.ts`:

```ts
  it('excludes a package\'s released paths from its own rule (human cards plan B D5)', () => {
    const api = { key: 'api', ownedPaths: ['src/api/**'], releasedPaths: ['src/api/routes.ts'], isIntegration: false }
    const rule = ownershipRuleFor(api, [api])
    expect(rule).toEqual({ owned: ['src/api/**'], excluded: ['src/api/routes.ts'] })
    expect(rule !== null && isOwned(rule, 'src/api/routes.ts')).toBe(false)
    expect(rule !== null && isOwned(rule, 'src/api/other.ts')).toBe(true)
  })
```

`contract.test.ts` (use that file's own input fixture):

```ts
  it('names the files a person gave away (human cards plan B D5)', () => {
    const text = renderPackageContract({ ...input, pkg: { ...input.pkg, releasedPaths: ['src/api/routes.ts'] } })
    expect(text).toContain('Given by a person to another package (no longer yours):\n- src/api/routes.ts')
  })
```

Run the grant test → FAIL.

- [ ] **Step 2: Ownership.** In `ownership.ts`:

```ts
type Owner = Pick<PackageSpec, 'key' | 'ownedPaths' | 'isIntegration'> & {
  /** Human cards plan B D5: literal paths a person gave from this package to another. */
  readonly releasedPaths?: readonly string[]
}
```

and the non-integration return becomes `return { owned: [...pkg.ownedPaths], excluded: [...(pkg.releasedPaths ?? [])] }`. The integration arm is unchanged: it already excludes every other package's globs. Add to the doc: "A non-integration package's released paths are excluded from its own rule (human cards plan B D5), which is how a grant reaches the gate (`ownershipPatterns`) and the diff audit with no change to either."

- [ ] **Step 3: The grant.** Create `packages/domain/src/conduct/grant.ts`:

```ts
import { err, ok, type Result } from '../result.js'
import { SKELETON_PACKAGE_KEY } from './constants.js'
import { isOwned, ownershipRuleFor } from './ownership.js'
import { manifestProblems, registrationProblems, type PackageRegistration } from './skeleton.js'
import { handOffPath } from './smoke.js'

/** What {@link planFileGrant} reads of one `WorkPackage`. */
export interface GrantPackage {
  readonly key: string
  readonly ownedPaths: readonly string[]
  readonly releasedPaths: readonly string[]
  readonly isIntegration: boolean
  readonly registrations: readonly PackageRegistration[]
}

/** A grant as it will be written: each package whose arrays change, and what to. */
export interface FileGrant {
  readonly path: string
  readonly fromKey: string | null
  readonly toKey: string
  readonly changes: readonly { readonly key: string; readonly ownedPaths: readonly string[]; readonly releasedPaths: readonly string[] }[]
}

const owners = (path: string, packages: readonly GrantPackage[]): readonly GrantPackage[] =>
  packages.filter((pkg) => {
    const rule = ownershipRuleFor(pkg, packages)
    return rule !== null && isOwned(rule, path)
  })

/**
 * Human-cards spec H2.4 (plan B D5): moves one concrete file from the package that owns it to
 * `toKey`, or says why not. The only ownership change in the system, so it is judged by the rules
 * the conductor's plan was validated with: one non-integration owner per file, a manifest family
 * only with the skeleton, a shared registration directory file-per-package. The owner releases a
 * glob-owned file (`releasedPaths`) or loses a named one; the target owns it by name. Pure: the
 * caller writes `changes` under the delivery lock.
 */
export function planFileGrant(input: { readonly path: string; readonly toKey: string; readonly packages: readonly GrantPackage[] }): Result<FileGrant, string> {
  const { packages, toKey } = input
  const path = handOffPath(input.path)
  if (path === null) return err(`"${input.path}" is not one repository file: give a path with no glob, "..", "./" or leading "/"`)
  const target = packages.find((pkg) => pkg.key === toKey)
  if (target === undefined) return err(`no package has the key "${toKey}"`)
  if (packages.some((pkg) => pkg.ownedPaths.includes('**'))) return err('one package owns every file in this goal version: there is nothing to give')

  const before = owners(path, packages)
  const from = before.find((pkg) => !pkg.isIntegration) ?? before[0] ?? null
  if (from?.key === toKey) return err(`the ${toKey} package already owns ${path}`)

  const changes = new Map<string, { ownedPaths: string[]; releasedPaths: string[] }>()
  const edit = (pkg: GrantPackage): { ownedPaths: string[]; releasedPaths: string[] } => {
    const seen = changes.get(pkg.key) ?? { ownedPaths: [...pkg.ownedPaths], releasedPaths: [...pkg.releasedPaths] }
    changes.set(pkg.key, seen)
    return seen
  }
  if (from !== null && !from.isIntegration) {
    // A name is taken away; a glob that still matches is narrowed by releasing the path from it.
    const owned = edit(from)
    owned.ownedPaths = owned.ownedPaths.filter((glob) => glob !== path)
    const stillOwns = ownershipRuleFor({ ...from, ...owned }, [{ ...from, ...owned }])
    if (stillOwns !== null && isOwned(stillOwns, path) && !owned.releasedPaths.includes(path)) owned.releasedPaths.push(path)
  }
  if (target.isIntegration) {
    // The integration package owns only what nobody else owns: a file another package holds by a
    // glob cannot be narrowed out of that glob for it without the hook plane (plan B D5).
    if (from !== null && !from.isIntegration && !from.ownedPaths.includes(path)) {
      return err(`the integration package owns only files no other package owns, and ${path} is in the ${from.key} package's ${from.ownedPaths.join(', ')}: give the ${from.key} package the work instead`)
    }
  } else {
    const gaining = edit(target)
    if (!gaining.ownedPaths.includes(path)) gaining.ownedPaths.push(path)
    gaining.releasedPaths = gaining.releasedPaths.filter((released) => released !== path)
  }

  const after = packages.map((pkg) => ({ ...pkg, ...(changes.get(pkg.key) ?? {}) }))
  const nonIntegration = owners(path, after).filter((pkg) => !pkg.isIntegration).map((pkg) => pkg.key)
  const expected = target.isIntegration ? [] : [toKey]
  if (nonIntegration.join('\n') !== expected.join('\n')) {
    return err(`two packages would own ${path} (${nonIntegration.join(', ')}): a file has one owner`)
  }
  const family = manifestProblems([{ key: toKey, ownedPaths: [path] }], [path])
  if (toKey !== SKELETON_PACKAGE_KEY && family.length > 0) return err(family.join('; '))
  const known = new Set(registrationProblems(packages))
  const added = registrationProblems(after).filter((problem) => !known.has(problem))
  if (added.length > 0) return err(added.join('; '))

  return ok({
    path,
    fromKey: from?.key ?? null,
    toKey,
    changes: [...changes.entries()].map(([key, arrays]) => ({ key, ownedPaths: arrays.ownedPaths, releasedPaths: arrays.releasedPaths })).sort((a, b) => a.key.localeCompare(b.key)),
  })
}
```

A package that owns both `src/api/**` and `src/api/index.ts` keeps the glob after losing the name, so it also releases the path. The registration case (`backend/migrations/01_users.sql` to `api`) is refused by `registrationProblems(after)`. `api` now owns a literal under `db`'s registered prefix, which `mayOwnUnder` refuses with the "file-per-package" sentence. Export from `conduct/index.ts`.

- [ ] **Step 4: Contract and selects.** In `contract.ts`, `PackageContractInput.pkg` gains `readonly releasedPaths?: readonly string[]` ("Human cards plan B D5: files a person gave to another package"). After the "Files you own:" lines:

```ts
    ...((input.pkg.releasedPaths ?? []).length === 0 ? [] : ['Given by a person to another package (no longer yours):', ...(input.pkg.releasedPaths ?? []).map((path) => `- ${path}`)]),
```

`runContext.ts` already spreads the whole `WorkPackage` row into `pkg`, so the column reaches the contract unchanged. Add `releasedPaths: true` to `packagesOf`'s select in `handOffs.ts` and to `smoke.ts:476`'s select.

- [ ] **Step 5: Run.** `npx vitest run packages/domain/test/conduct/grant.test.ts packages/domain/test/conduct/ownership.test.ts packages/domain/test/conduct/contract.test.ts` → PASS. Then `npx tsc --build`, `npx vitest run packages/control/test/integration/hand-offs.test.ts apps/orchestrator/test/integration/smoke.test.ts` → PASS. `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/conduct packages/domain/test/conduct packages/control/src/handOffs.ts apps/orchestrator/src/smoke.ts
git commit -m "feat(conduct): a person can give one file to another package, judged by the plan's own ownership rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `decideCard`: the claim, the close, the answers and the dismissal

**Files:**
- Create: `packages/control/src/cards.ts`
- Modify: `packages/control/src/index.ts` (export)
- Modify: `packages/control/src/questions.ts` (`QuestionCard` gains `packages`, `offers`; `loadQuestionCards` reads the packages)
- Modify: `packages/control/src/supervisor.ts:1378-1408` (`listDecisions` fills `offers`; `DecisionView.personDecision`)
- Modify: `packages/control/src/refusal.ts` (four kinds)
- Test: `packages/control/test/integration/cards.test.ts` (new)

**Interfaces:**
- Consumes: Plan A's `closeQuestionIn`, `announceQuestionClosed`, `closedByOf`, `retireQuestionCards`, `loadQuestionCards`; Task 1's `cardDecisionSchema`, `cardOffers`, `decidedResumeMessage`, `personDecisionSummary`, `PersonDecision`; `approveDecision`, `answerQuestion`.
- Produces:
  - `decideCard(decisionId: string, raw: unknown, principal?: Principal): Promise<Result<DecideOutcome, ControlRefusal>>`, `interface DecideOutcome { readonly decision: CardDecisionKind; readonly summary: string }`
  - internal, used by Tasks 4 and 5: `claimAndClose(tx, input: ClaimInput): Promise<void>` (throws `CardRefused`); `afterClaim(card, outcome, principal)`; `class CardRefused extends Error { readonly refusal: ControlRefusal }`
  - `QuestionCard.packages: readonly { readonly key: string; readonly title: string; readonly isIntegration: boolean }[]`, `QuestionCard.offers: readonly CardDecisionKind[]`
  - `DecisionView.personDecision?: PersonDecision | null`
  - `ControlRefusal` gains `{ kind: 'invalid_card_decision'; reason: string }`, `{ kind: 'card_not_a_question'; decisionId: string }`, `{ kind: 'card_decision_not_offered'; decisionId: string; decision: string }`, `{ kind: 'card_decision_refused'; decisionId: string; reason: string }`

- [ ] **Step 1: Failing tests.** Create `packages/control/test/integration/cards.test.ts` with a fixture that this file's later describes (Tasks 4 and 5) share:

```ts
/**
 * Human-cards plan B: a person decides a question card. Every decision claims the card and closes
 * the question in one transaction; a refusal writes nothing.
 */
import { prisma } from '@slave-of-ai/db/client'
import { CONDUCTOR_ROLE } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { decideCard } from '../../src/cards.js'
import { sendMessage } from '../../src/messaging.js'

const TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "PackageHandOff", "GoalDecision", "GoalVersion", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE'

interface CardFixture {
  readonly workspaceId: string
  readonly deliveryId: string
  readonly questionId: string
  readonly runId: string
  readonly cardId: string
  readonly taskOf: Readonly<Record<'skeleton' | 'api' | 'integration', string>>
}

/**
 * A conducted goal v1 mid-integration: skeleton (owns backend/package.json and its lockfile) and api
 * (owns src/api/**) are done; integration's run is parked on a question to the conductor, and an
 * escalated card (or, with `draft`, a drafted answer card) is pending on it.
 */
async function seedCard(options: { readonly draft?: string } = {}): Promise<CardFixture> {
  const ws = await prisma.workspace.create({ data: { name: `Cards ${String(Math.random())}`, repoPath: '/nonexistent', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted', goal: 'Ship it.', goalVersion: 1 } })
  await prisma.goalVersion.create({ data: { workspaceId: ws.id, version: 1, text: 'Ship it.', sha256: 'x'.repeat(64) } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'E' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Implementer', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id } })
  const delivery = await prisma.goalDelivery.create({ data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1-x', baseCommit: 'a'.repeat(40) } })
  const owned = { skeleton: ['backend/package.json', 'backend/package-lock.json', 'scripts/verify.sh'], api: ['src/api/**'], integration: [] as string[] }
  const taskOf: Record<'skeleton' | 'api' | 'integration', string> = { skeleton: '', api: '', integration: '' }
  for (const key of ['skeleton', 'api', 'integration'] as const) {
    const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key, title: key, requirementKeys: [], ownedPaths: owned[key], interface: '', isIntegration: key === 'integration', templateId: 'tpl' } })
    const status = key === 'integration' ? 'waiting' : 'done'
    taskOf[key] = (await prisma.task.create({ data: { workspaceId: ws.id, title: key, description: 'x', status, requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id, assigneeId: seat.id, integratedAt: status === 'done' ? new Date() : null } })).id
  }
  const run = await prisma.slaveRun.create({ data: { slaveId: seat.id, taskId: taskOf.integration, status: 'paused', pauseReason: 'waiting_for_answer', pausedAt: new Date(), provider: 'claude_code' } })
  await prisma.task.update({ where: { id: taskOf.integration }, data: { activeRunId: run.id } })
  await prisma.checkpoint.create({ data: { runId: run.id, sessionId: 's1', worktreePath: '/tmp/w', pauseFlagPath: '/tmp/p', deniedToolUseIds: [], headCommit: 'a'.repeat(40), dirtyFiles: [] } })
  const sent = await sendMessage(run.id, { kind: 'question', body: 'May I add a "start" script to backend/package.json (skeleton)?', recipientRole: CONDUCTOR_ROLE, expectsReply: true, taskId: taskOf.integration })
  if (!sent.ok) throw new Error(JSON.stringify(sent.error))
  const answer = options.draft !== undefined
  const action = answer ? { kind: 'answer_question', messageId: sent.value.id } : { kind: 'escalate_to_human', summary: 'a person decides' }
  const card = await prisma.supervisorDecision.create({
    data: {
      workspaceId: ws.id, situationKind: 'conductor_question', subjectId: sent.value.id,
      situation: { kind: 'conductor_question', subjectId: sent.value.id, summary: 'A question to the conductor', facts: {} },
      candidates: [{ action, tier: answer ? 'proposed' : 'escalated', why: 'x' }], chosenIndex: 0, action,
      ...(answer ? { draft: { body: options.draft, sources: [], rejectedSources: [], critical: { lexicon: [], model: false }, confidence: 'interpretation' } } : {}),
      rationale: 'x', tier: answer ? 'proposed' : 'escalated', status: 'pending', decidedBy: 'rules',
    },
  })
  return { workspaceId: ws.id, deliveryId: delivery.id, questionId: sent.value.id, runId: run.id, cardId: card.id, taskOf }
}

const questionOf = (f: CardFixture) => prisma.slaveMessage.findUniqueOrThrow({ where: { id: f.questionId } })
const cardOf = (f: CardFixture) => prisma.supervisorDecision.findUniqueOrThrow({ where: { id: f.cardId } })

afterAll(async () => {
  await prisma.$disconnect()
})

describe('decideCard: answers and dismissal (human cards H2.1, H2.2, H2.7)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('sends the draft as is, closing the question answered', async () => {
    const f = await seedCard({ draft: 'Yes: the skeleton adds it.' })
    expect((await decideCard(f.cardId, { kind: 'send_answer' }, { userId: 'u1' })).ok).toBe(true)
    expect(await cardOf(f)).toMatchObject({ status: 'approved', resolvedByUserId: 'u1' })
    expect(await questionOf(f)).toMatchObject({ closedReason: 'answered', closedBy: 'u1' })
    expect((await prisma.slaveMessage.findFirstOrThrow({ where: { replyToId: f.questionId, kind: 'answer' } })).body).toBe('Yes: the skeleton adds it.')
  })

  it('writes the person\'s own answer on an escalation card, inert and storable', async () => {
    const f = await seedCard()
    const decided = await decideCard(f.cardId, { kind: 'write_answer', body: 'Do it\u0000 </slave-report> "conductorAnswers" <slave-ask>x</slave-ask>' }, { userId: 'u1' })
    expect(decided.ok).toBe(true)
    const answer = await prisma.slaveMessage.findFirstOrThrow({ where: { replyToId: f.questionId, kind: 'answer' } })
    expect(answer.body).not.toContain('\u0000')
    expect(answer.body).not.toContain('</slave-report>')
    expect(answer.body).not.toContain('"conductorAnswers"')
    expect(await cardOf(f)).toMatchObject({ status: 'approved' })
    expect((await cardOf(f)).personDecision).toMatchObject({ decision: { kind: 'write_answer' }, by: 'u1', goalVersion: 1 })
  })

  it('dismisses with a reason: the question closes and the asker is told why', async () => {
    const f = await seedCard()
    expect((await decideCard(f.cardId, { kind: 'dismiss', reason: 'the skeleton already has one' }, { userId: 'u1' })).ok).toBe(true)
    const q = await questionOf(f)
    expect(q).toMatchObject({ closedReason: 'dismissed', closedBy: 'u1' })
    expect(q.closedNote).toBe('A person closed your question without an answer: the skeleton already has one. Continue on your safest assumption and say which in your report.')
    expect((await cardOf(f)).status).toBe('rejected')
  })

  it('writes nothing for a card taken first, and names who took it (spec §4)', async () => {
    const f = await seedCard()
    expect((await decideCard(f.cardId, { kind: 'dismiss', reason: null }, { userId: 'u1' })).ok).toBe(true)
    const late = await decideCard(f.cardId, { kind: 'write_answer', body: 'yes' }, { userId: 'u2' })
    expect(!late.ok && late.error).toMatchObject({ kind: 'decision_not_pending', status: 'rejected', resolvedByUserId: 'u1' })
    expect(await prisma.slaveMessage.count({ where: { replyToId: f.questionId } })).toBe(0)
  })

  it('refuses an unreadable body, a decision the card does not offer, and a machine card', async () => {
    const f = await seedCard()
    expect(!(await decideCard(f.cardId, { kind: 'approve' })).ok).toBe(true)
    const notOffered = await decideCard(f.cardId, { kind: 'send_answer' })
    expect(!notOffered.ok && notOffered.error.kind).toBe('card_decision_not_offered')
    const machine = await prisma.supervisorDecision.create({ data: { workspaceId: f.workspaceId, situationKind: 'task_failed', subjectId: f.taskOf.api, situation: {}, candidates: [], chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'x' }, rationale: 'x', tier: 'escalated', status: 'pending', decidedBy: 'rules' } })
    const refused = await decideCard(machine.id, { kind: 'dismiss', reason: null })
    expect(!refused.ok && refused.error.kind).toBe('card_not_a_question')
    expect((await cardOf(f)).status).toBe('pending')
  })
})
```

Run `npx vitest run packages/control/test/integration/cards.test.ts` → FAIL (module missing).

- [ ] **Step 2: The card's question grows.** In `questions.ts`, `QuestionCard` gains:

```ts
  /** Plan B D7: the question's goal version's packages, for the target pickers; [] with no version. */
  readonly packages: readonly { readonly key: string; readonly title: string; readonly isIntegration: boolean }[]
  /** Plan B D7: the decisions this card offers; [] until `listDecisions` (or `decideCard`) fills them. */
  readonly offers: readonly CardDecisionKind[]
```

In `loadQuestionCards`, after the rows are read, load each version's packages in one query:

```ts
  const versions = [...new Set(rows.flatMap((row) => { const v = row.task?.workPackage?.goalVersion ?? row.task?.goalVersion ?? null; return v === null ? [] : [v] }))]
  const packageRows = versions.length === 0 ? [] : await prisma.workPackage.findMany({ where: { workspaceId, goalVersion: { in: versions } }, orderBy: { key: 'asc' }, select: { goalVersion: true, key: true, title: true, isIntegration: true } })
  const packagesOf = (version: number | null) => packageRows.filter((p) => p.goalVersion === version).map(({ key, title, isIntegration }) => ({ key, title, isIntegration }))
```

Each card gets `packages: packagesOf(goalVersion)` and `offers: []`. In `supervisor.ts`, add `readonly personDecision?: PersonDecision | null` to `DecisionView`. In `listDecisions`, map:

```ts
    card: isQuestionSituation(row.situationKind) ? withOffers(cards.get(row.subjectId) ?? null, action, draft) : null,
    personDecision: row.personDecision === null ? null : parsedOrThrow(personDecisionSchema.safeParse(row.personDecision), `SupervisorDecision ${row.id}.personDecision`),
```

where `action` and `draft` are the values already parsed for the view (hoist them into locals). Then:

```ts
/** Plan B D7: a card's question with the decisions it offers, from the card's own action and draft. */
export function withOffers(card: QuestionCard | null, action: Action, draft: Draft | null): QuestionCard | null {
  if (card === null) return null
  return {
    ...card,
    offers: cardOffers({ actionKind: action.kind, hasDraftBody: sendableBody(draft) !== null, closedReason: card.closed?.reason ?? null, hasPackages: card.packages.length > 0 }),
  }
}
```

- [ ] **Step 3: Refusals.** In `refusal.ts`, add the four kinds from the Interfaces and their sentences:

```ts
    case 'invalid_card_decision':
      return `that is not a decision a card can carry: ${refusal.reason}`
    case 'card_not_a_question':
      return `supervisor decision ${refusal.decisionId} is not about a question: approve or reject it`
    case 'card_decision_not_offered':
      return `supervisor decision ${refusal.decisionId} does not offer "${refusal.decision.replace('_', ' ')}"`
    case 'card_decision_refused':
      return `the decision was refused, and nothing was changed: ${refusal.reason}`
```

- [ ] **Step 4: `cards.ts`.**

```ts
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  actionSchema,
  cardDecisionSchema,
  decidedResumeMessage,
  draftSchema,
  isQuestionSituation,
  personDecisionSummary,
  personText,
  type CardDecision,
  type CardDecisionKind,
  type PersonDecision,
  type QuestionCloseReason,
  type Result,
  err,
  ok,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { answerQuestion } from './messaging.js'
import type { Principal } from './principal.js'
import { announceQuestionClosed, closeQuestionIn, closedByOf, loadQuestionCards, retireQuestionCards, type CloseQuestionInput, type QuestionCard } from './questions.js'
import { refusalText, type ControlRefusal } from './refusal.js'
import { approveDecision, withOffers } from './supervisor.js'

/** What a decided card reports back. */
export interface DecideOutcome {
  readonly decision: CardDecisionKind
  readonly summary: string
}

/** Thrown inside a card's transaction: rolls the claim and the close back (constraint: a refusal there must throw). */
export class CardRefused extends Error {
  constructor(readonly refusal: ControlRefusal) {
    super(refusal.kind)
  }
}

/** The pending card a decision is about, as `decideCard` read it. */
export interface PendingCard {
  readonly id: string
  readonly workspaceId: string
  readonly subjectId: string
  readonly actionKind: string
  readonly question: QuestionCard
}

export interface ClaimInput {
  readonly card: PendingCard
  readonly status: 'approved' | 'rejected'
  readonly principal: Principal | undefined
  readonly personDecision: PersonDecision
  /** The close to write; a `timed_out` question is not closed again (plan A D1). */
  readonly close: { readonly reason: QuestionCloseReason; readonly note: string | null } | null
  readonly now: Date
}

/**
 * Plan B D2: inside `tx`, locks the question, claims the card and closes the question. THROWS
 * {@link CardRefused} when the card was resolved or the question closed first, so a decision that
 * lost writes nothing. Returns the close it wrote, or null when the question had already timed out.
 */
export async function claimAndClose(tx: Prisma.TransactionClient, input: ClaimInput): Promise<CloseQuestionInput | null> {
  const { card } = input
  await tx.$queryRaw`SELECT 1 FROM "SlaveMessage" WHERE id = ${card.subjectId} FOR UPDATE`
  const claimed = await tx.supervisorDecision.updateMany({
    where: { id: card.id, status: 'pending' },
    data: {
      status: input.status,
      resolvedAt: input.now,
      resolvedByUserId: input.principal?.userId ?? null,
      personDecision: input.personDecision as unknown as Prisma.InputJsonValue,
    },
  })
  if (claimed.count === 0) {
    const now = await tx.supervisorDecision.findUnique({ where: { id: card.id }, select: { status: true, resolvedAt: true, resolvedByUserId: true } })
    throw new CardRefused({ kind: 'decision_not_pending', decisionId: card.id, status: now?.status ?? 'gone', resolvedAt: now?.resolvedAt?.toISOString() ?? null, resolvedByUserId: now?.resolvedByUserId ?? null })
  }
  const state = await tx.slaveMessage.findUniqueOrThrow({ where: { id: card.subjectId }, select: { closedAt: true, closedReason: true, closedBy: true } })
  if (state.closedAt !== null && state.closedReason !== null) {
    if (state.closedReason === 'timed_out') return null
    throw new CardRefused({ kind: 'question_closed', messageId: card.subjectId, reason: state.closedReason, by: state.closedBy ?? 'system', at: state.closedAt.toISOString() })
  }
  if (input.close === null) return null
  const close: CloseQuestionInput = { messageId: card.subjectId, reason: input.close.reason, by: closedByOf(input.principal), note: input.close.note, decisionId: card.id }
  if (!(await closeQuestionIn(tx, close, input.now))) throw new CardRefused({ kind: 'question_answered', messageId: card.subjectId })
  return close
}

/** After the commit: the card's event, the question's, and the other cards about it retired. */
export async function afterClaim(card: PendingCard, input: ClaimInput, close: CloseQuestionInput | null): Promise<void> {
  await appendEvent({
    type: 'supervisor.resolved',
    workspaceId: card.workspaceId,
    actor: 'human',
    payload: { decisionId: card.id, outcome: input.status, reason: `A person decided: ${input.personDecision.summary}` },
    userId: input.principal?.userId ?? null,
  })
  if (close !== null) {
    const question = await prisma.slaveMessage.findUniqueOrThrow({ where: { id: card.subjectId }, select: { workspaceId: true, taskId: true, slaveId: true } })
    await announceQuestionClosed(question, { ...close, note: input.personDecision.summary }, 'human', input.principal?.userId ?? null)
  }
  await retireQuestionCards(card.workspaceId, card.subjectId, 'A person decided the question on another card.', input.now, card.id)
}

/** Runs a card's transaction, turning a thrown {@link CardRefused} back into a refusal. */
export async function inCardTransaction<T>(work: () => Promise<T>): Promise<Result<T, ControlRefusal>> {
  try {
    return ok(await work())
  } catch (error) {
    if (error instanceof CardRefused) return err(error.refusal)
    throw error
  }
}

/** The status a person's decision leaves the card in (plan B D3). */
function statusFor(actionKind: string, decision: CardDecision): 'approved' | 'rejected' {
  if (decision.kind === 'dismiss') return 'rejected'
  if (decision.kind === 'send_answer' || decision.kind === 'write_answer') return 'approved'
  return actionKind === 'escalate_to_human' ? 'approved' : 'rejected'
}

/**
 * Human-cards spec H2: a person decides a question card. Everything a decision can be refused for
 * that can be known without the lock is checked first (plan B D2); the rest is refused inside the
 * card's transaction by a throw, so a refused decision closes nothing. Machine cards keep approve
 * and reject.
 */
export async function decideCard(decisionId: string, raw: unknown, principal?: Principal): Promise<Result<DecideOutcome, ControlRefusal>> {
  const parsed = cardDecisionSchema.safeParse(raw)
  if (!parsed.success) return err({ kind: 'invalid_card_decision', reason: parsed.error.issues.slice(0, 3).map((i) => i.message).join('; ') })
  const decision = parsed.data
  const row = await prisma.supervisorDecision.findUnique({
    where: { id: decisionId },
    select: { id: true, workspaceId: true, situationKind: true, subjectId: true, status: true, action: true, draft: true, resolvedAt: true, resolvedByUserId: true },
  })
  if (row === null) return err({ kind: 'decision_not_found', decisionId })
  if (!isQuestionSituation(row.situationKind)) return err({ kind: 'card_not_a_question', decisionId })
  if (row.status !== 'pending') {
    return err({ kind: 'decision_not_pending', decisionId, status: row.status, resolvedAt: row.resolvedAt?.toISOString() ?? null, resolvedByUserId: row.resolvedByUserId })
  }
  const action = actionSchema.safeParse(row.action)
  if (!action.success) throw new TypeError(`decideCard: SupervisorDecision ${decisionId}.action does not parse`)
  const draft = row.draft === null ? null : draftSchema.safeParse(row.draft)
  const loaded = (await loadQuestionCards(row.workspaceId, [row.subjectId])).get(row.subjectId)
  if (loaded === undefined) return err({ kind: 'message_not_found', messageId: row.subjectId })
  const question = withOffers(loaded, action.data, draft?.success === true ? draft.data : null) ?? loaded
  if (question.closed !== null && question.closed.reason !== 'timed_out') {
    return err({ kind: 'question_closed', messageId: row.subjectId, reason: question.closed.reason, by: question.closed.by, at: question.closed.at })
  }
  if (!question.offers.includes(decision.kind)) return err({ kind: 'card_decision_not_offered', decisionId, decision: decision.kind })

  const card: PendingCard = { id: row.id, workspaceId: row.workspaceId, subjectId: row.subjectId, actionKind: action.data.kind, question }
  const now = new Date()
  const target = { packageKey: decision.kind === 'give_file' ? decision.toPackage : decision.kind === 'give_work' && 'package' in decision.target ? decision.target.package : null }
  const record = (extra: Partial<PersonDecision> = {}): PersonDecision => ({
    decision,
    goalVersion: question.goalVersion,
    by: closedByOf(principal),
    at: now.toISOString(),
    summary: personDecisionSummary(decision, target),
    ...extra,
  })
  const status = statusFor(card.actionKind, decision)

  switch (decision.kind) {
    case 'send_answer':
    case 'write_answer':
      return decideAnswer(card, decision, record(), principal)
    case 'dismiss': {
      const input: ClaimInput = { card, status, principal, personDecision: record(), close: { reason: 'dismissed', note: decidedResumeMessage(decision, target) }, now }
      const claimed = await inCardTransaction(() => prisma.$transaction((tx) => claimAndClose(tx, input)))
      if (!claimed.ok) return claimed
      await afterClaim(card, input, claimed.value)
      return ok({ decision: decision.kind, summary: input.personDecision.summary })
    }
    case 'give_work':
    case 'record_decision':
    case 'change_requirement':
    case 'give_file':
      // Tasks 4 and 5.
      return decideOther(card, decision, record, status, principal, now)
  }
}

/**
 * H2.1/H2.2: an answer. On an answer card, the approval path (an edit for a person's own words,
 * which applies neither the draft's decision nor its hand-off). On any other question card, the card
 * is claimed with no close -- `answerQuestion` closes the question `answered` in its own transaction
 * -- and a refusal there marks the card failed with the reason.
 */
async function decideAnswer(card: PendingCard, decision: Extract<CardDecision, { kind: 'send_answer' | 'write_answer' }>, personDecision: PersonDecision, principal: Principal | undefined): Promise<Result<DecideOutcome, ControlRefusal>> {
  const body = decision.kind === 'write_answer' ? personText(decision.body) : null
  if (card.actionKind === 'answer_question') {
    const approved = await approveDecision(card.id, principal, body === null ? undefined : { body })
    if (!approved.ok) return approved
    await prisma.supervisorDecision.update({ where: { id: card.id }, data: { personDecision: personDecision as unknown as Prisma.InputJsonValue } })
    return ok({ decision: decision.kind, summary: personDecision.summary })
  }
  if (body === null) return err({ kind: 'card_decision_not_offered', decisionId: card.id, decision: decision.kind })
  const input: ClaimInput = { card, status: 'approved', principal, personDecision, close: null, now: new Date() }
  const claimed = await inCardTransaction(() => prisma.$transaction((tx) => claimAndClose(tx, input)))
  if (!claimed.ok) return claimed
  const answered = await answerQuestion(card.subjectId, { body, answeredBy: 'a person, on a card', ...(principal === undefined ? {} : { principal }) }, 'human')
  if (!answered.ok) {
    await prisma.supervisorDecision.update({ where: { id: card.id }, data: { status: 'failed', failureReason: refusalText(answered.error) } })
    return answered
  }
  await afterClaim(card, input, null)
  return ok({ decision: decision.kind, summary: personDecision.summary })
}
```

Leave `decideOther` as an exported stub that Task 4 replaces. The switch's other arms must compile in this task:

```ts
/** Tasks 4 and 5 fill this in; until then the decision is refused and nothing is written. */
async function decideOther(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'give_work' | 'record_decision' | 'change_requirement' | 'give_file' }>,
  _record: (extra?: Partial<PersonDecision>) => PersonDecision,
  _status: 'approved' | 'rejected',
  _principal: Principal | undefined,
  _now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  return err({ kind: 'card_decision_not_offered', decisionId: card.id, decision: decision.kind })
}
```

`supervisor.ts` must export `withOffers` and must not import `cards.ts` (no cycle: `cards.ts` imports `supervisor.ts`). Add `export * from './cards.js'` to the control index.

- [ ] **Step 5: Run.** `npx tsc --build`, then `npx vitest run packages/control/test/integration/cards.test.ts` → PASS, then `npx vitest run packages/control/test/integration/supervisor.test.ts` → PASS. `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/control/src/cards.ts packages/control/src/index.ts packages/control/src/questions.ts packages/control/src/supervisor.ts packages/control/src/refusal.ts packages/control/test/integration/cards.test.ts
git commit -m "feat(cards): a person decides a question card -- the card is claimed and the question closed together, or nothing is written

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Give a package work, record a shared decision, change a requirement

**Files:**
- Modify: `packages/control/src/cards.ts` (`decideOther`, `giveWork`, `recordDecision`, `changeRequirement`)
- Modify: `packages/control/src/conductorAnswer.ts:84-135` (`writeGoalDecisionIn`, `GoalDecisionRefused`; `recordAnswerDecision` wraps it)
- Modify: `packages/control/src/handOffs.ts` (`personHandOffSourceKey`, `routeStoredPersonHandOffs`, called from `routeStoredHandOffs`)
- Test: `packages/control/test/integration/cards.test.ts` (new describe), `packages/control/test/integration/conductor-answer.test.ts` (unchanged; must still pass)

**Interfaces:**
- Consumes: `claimAndClose`, `afterClaim`, `inCardTransaction`, `CardRefused` (Task 3); `resolveHandOff`, `routeHandOffs`, `requestChange`.
- Produces:
  - `writeGoalDecisionIn(tx: Prisma.TransactionClient, input: { readonly workspaceId: string; readonly goalVersion: number; readonly title: string; readonly decision: string; readonly source: 'conductor_answer' | 'person'; readonly questionId: string | null; readonly decisionId: string | null }): Promise<void>`
  - `class GoalDecisionRefused extends Error { readonly why: 'empty' | 'at_cap' | 'title_taken' }`
  - `personHandOffSourceKey(decisionId: string): string` (= `person:<decisionId>`)
  - `routeStoredPersonHandOffs(deliveryId: string): Promise<void>`

- [ ] **Step 1: Failing tests.** Add to `cards.test.ts`:

```ts
describe('decideCard: work, decisions, requirements (human cards H2.3, H2.5, H2.6)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('gives the owner of a file the work: the finished skeleton is reopened, and the asker is told', async () => {
    const f = await seedCard()
    const decided = await decideCard(f.cardId, { kind: 'give_work', target: { path: 'backend/package.json' }, request: 'add "start": "node src/app/server.ts"' }, { userId: 'u1' })
    expect(decided.ok).toBe(true)
    const rows = await prisma.packageHandOff.findMany()
    expect(rows).toMatchObject([{ source: 'person', sourceKey: `person:${f.cardId}:0`, toPackageKey: 'skeleton', fromPackageKey: null, fromRunId: f.runId, status: 'reopened' }])
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.skeleton } })).status).toBe('rework')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.skeleton } })).lastRejectionReason).toContain('From the operator')
    const q = await questionOf(f)
    expect(q).toMatchObject({ closedReason: 'decided', closedBy: 'u1' })
    expect(q.closedNote).toContain('the skeleton package will do this')
    expect((await cardOf(f)).status).toBe('approved')
  })

  it('refuses work for a path nobody owns or a package that does not exist, and writes nothing', async () => {
    const f = await seedCard()
    const refused = await decideCard(f.cardId, { kind: 'give_work', target: { package: 'billing' }, request: 'x' })
    expect(!refused.ok && refused.error.kind).toBe('card_decision_refused')
    expect(await prisma.packageHandOff.count()).toBe(0)
    expect((await questionOf(f)).closedAt).toBeNull()
    expect((await cardOf(f)).status).toBe('pending')
  })

  it('records a person\'s shared decision, and refuses a taken title in another case', async () => {
    const f = await seedCard()
    await prisma.goalDecision.create({ data: { workspaceId: f.workspaceId, goalVersion: 1, title: 'API field naming', titleKey: 'api field naming', decision: 'camelCase', source: 'conductor_plan' } })
    const taken = await decideCard(f.cardId, { kind: 'record_decision', title: 'API  field NAMING', text: 'snake_case' })
    expect(!taken.ok && taken.error.kind).toBe('card_decision_refused')
    expect((await cardOf(f)).status).toBe('pending')
    expect((await questionOf(f)).closedAt).toBeNull()
    expect((await decideCard(f.cardId, { kind: 'record_decision', title: 'Start command', text: 'npm start runs node src/app/server.ts' }, { userId: 'u1' })).ok).toBe(true)
    expect(await prisma.goalDecision.findFirstOrThrow({ where: { titleKey: 'start command' } })).toMatchObject({ source: 'person', questionId: f.questionId, decisionId: f.cardId })
  })

  it('changes a requirement through a new goal version, superseding the question', async () => {
    const f = await seedCard()
    expect((await decideCard(f.cardId, { kind: 'change_requirement', request: 'The product must start with npm start.' }, { userId: 'u1' })).ok).toBe(true)
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).goalVersion).toBe(2)
    expect((await questionOf(f)).closedReason).toBe('superseded')
  })

  it('routes a person\'s hand-off the goal pass finds unrouted (backstop)', async () => {
    const f = await seedCard()
    expect((await decideCard(f.cardId, { kind: 'give_work', target: { package: 'api' }, request: 'expose GET /health' })).ok).toBe(true)
    await prisma.packageHandOff.deleteMany()
    await routeStoredHandOffs(f.deliveryId)
    expect(await prisma.packageHandOff.findMany({ select: { sourceKey: true, toPackageKey: true } })).toEqual([{ sourceKey: `person:${f.cardId}:0`, toPackageKey: 'api' }])
  })
})
```

Import `routeStoredHandOffs` from `'../../src/handOffs.js'`. Run → FAIL (refused as not offered).

- [ ] **Step 2: `writeGoalDecisionIn`.** In `conductorAnswer.ts`, replace `DecisionsAtCap` and the body of `recordAnswerDecision`:

```ts
/** Plan B D6: why a shared decision was not written. Thrown, so a caller's transaction rolls back. */
export class GoalDecisionRefused extends Error {
  constructor(readonly why: 'empty' | 'at_cap' | 'title_taken', message: string) {
    super(message)
  }
}

/**
 * Spec C3, human cards H2.5 (plan B D6): one shared decision, written inside `tx` under the
 * version's advisory lock -- the cap re-counted, the title's key looked up (not caught as a unique
 * violation, which would poison `tx`). Text made storable and defused: it reaches every package's
 * prompt. THROWS {@link GoalDecisionRefused}.
 */
export async function writeGoalDecisionIn(
  tx: Prisma.TransactionClient,
  input: {
    readonly workspaceId: string
    readonly goalVersion: number
    readonly title: string
    readonly decision: string
    readonly source: 'conductor_answer' | 'person'
    readonly questionId: string | null
    readonly decisionId: string | null
  },
): Promise<void> {
  const { workspaceId, goalVersion } = input
  const title = sanitisePersonText(storableText(input.title)).trim()
  const text = sanitisePersonText(storableText(input.decision)).trim()
  if (title === '' || text === '') throw new GoalDecisionRefused('empty', 'a shared decision needs a title and a decision')
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`slaveofai:goal-decisions:${workspaceId}:v${String(goalVersion)}`}))`
  if ((await tx.goalDecision.count({ where: { workspaceId, goalVersion } })) >= GOAL_DECISIONS_MAX) {
    throw new GoalDecisionRefused('at_cap', `goal v${String(goalVersion)} already has ${String(GOAL_DECISIONS_MAX)} shared decisions`)
  }
  const titleKey = decisionTitleKey(title)
  if ((await tx.goalDecision.findUnique({ where: { workspaceId_goalVersion_titleKey: { workspaceId, goalVersion, titleKey } }, select: { id: true } })) !== null) {
    throw new GoalDecisionRefused('title_taken', `goal v${String(goalVersion)} already has a shared decision titled "${title}"`)
  }
  await tx.goalDecision.create({
    data: { workspaceId, goalVersion, title, titleKey, decision: text, source: input.source, questionId: input.questionId, decisionId: input.decisionId },
  })
}
```

`recordAnswerDecision` becomes:

```ts
  try {
    await prisma.$transaction((tx) => writeGoalDecisionIn(tx, { ...input, source: 'conductor_answer' }))
    return 'recorded'
  } catch (error) {
    if (error instanceof GoalDecisionRefused) {
      if (error.why !== 'empty') console.warn(`[conductor-answer] decision ${input.decisionId}: ${error.message}; "${input.title}" was not added`)
      return error.why === 'empty' ? 'none' : error.why
    }
    // Two writers racing past the lookup still meet the unique key.
    if (isUniqueConstraintViolation(error)) return 'title_taken'
    throw error
  }
```

Import `type Prisma` from `@slave-of-ai/db/client`. The input's `decision: string` field keeps its name; the conductor passes `...newDecision` as before.

- [ ] **Step 3: Person hand-offs.** In `handOffs.ts`:

```ts
/** Plan B D4: the key a person's hand-off is stored under; its one item is `person:<decisionId>:0`. */
export function personHandOffSourceKey(decisionId: string): string {
  return `person:${decisionId}`
}

/**
 * Plan B D4: the goal pass's backstop for a person's `give_work` whose routing never landed (a busy
 * delivery lock after the card committed). One query; idempotent by {@link personHandOffSourceKey}.
 */
export async function routeStoredPersonHandOffs(deliveryId: string): Promise<void> {
  const unrouted = await prisma.$queryRaw<{ id: string; workspaceId: string; goalVersion: number; decision: unknown; senderRunId: string }[]>`
    SELECT s.id, s."workspaceId", d."goalVersion", s."personDecision" -> 'decision' AS decision, m."senderRunId"
    FROM "GoalDelivery" d
    JOIN "SupervisorDecision" s ON s."workspaceId" = d."workspaceId" AND s."personDecision" ->> 'goalVersion' = d."goalVersion"::text
    JOIN "SlaveMessage" m ON m.id = s."subjectId"
    WHERE d.id = ${deliveryId}
      AND s."personDecision" -> 'decision' ->> 'kind' = 'give_work'
      AND s.status IN ('approved', 'rejected')
      AND m."senderRunId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "PackageHandOff" h WHERE h."workspaceId" = d."workspaceId" AND h."sourceKey" = 'person:' || s.id || ':0')
    ORDER BY s."resolvedAt", s.id`
  for (const row of unrouted) {
    const decision = cardDecisionSchema.safeParse(row.decision)
    if (!decision.success || decision.data.kind !== 'give_work') {
      console.error(`[hand-off] card ${row.id}: its person decision cannot be read -- not routed`)
      continue
    }
    const { target, request } = decision.data
    try {
      await routeHandOffs({
        workspaceId: row.workspaceId,
        goalVersion: row.goalVersion,
        source: 'person',
        sourceKey: personHandOffSourceKey(row.id),
        fromRunId: row.senderRunId,
        fromPackageKey: null,
        items: ['package' in target ? { package: target.package, change: personText(request, HANDOFF_CHANGE_MAX_CHARS) } : { path: target.path, change: personText(request, HANDOFF_CHANGE_MAX_CHARS) }],
      })
    } catch (error) {
      console.error(`[hand-off] card ${row.id}: its person's hand-off was not routed this pass:`, error)
    }
  }
}
```

Call it in `routeStoredHandOffs` after `routeLateAnswers(deliveryId)`. Import `cardDecisionSchema`, `personText` and `HANDOFF_CHANGE_MAX_CHARS` from the domain.

- [ ] **Step 4: The three decisions.** Replace `decideOther` in `cards.ts`:

```ts
async function decideOther(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'give_work' | 'record_decision' | 'change_requirement' | 'give_file' }>,
  record: (extra?: Partial<PersonDecision>) => PersonDecision,
  status: 'approved' | 'rejected',
  principal: Principal | undefined,
  now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  const refused = (reason: string): Result<never, ControlRefusal> => err({ kind: 'card_decision_refused', decisionId: card.id, reason })
  const version = card.question.goalVersion
  switch (decision.kind) {
    case 'give_work': {
      if (version === null || card.question.askerRunId === null) return refused('the question belongs to no goal version with packages')
      const packages = await prisma.workPackage.findMany({ where: { workspaceId: card.workspaceId, goalVersion: version }, orderBy: { key: 'asc' }, select: { key: true, ownedPaths: true, releasedPaths: true, isIntegration: true } })
      const request = personText(decision.request, HANDOFF_CHANGE_MAX_CHARS)
      const item = 'package' in decision.target ? { package: decision.target.package, change: request } : { path: decision.target.path, change: request }
      const resolved = resolveHandOff(item, null, packages)
      if (resolved.kind !== 'package') return refused(resolved.kind === 'none' ? resolved.reason : 'no package can take it')
      const target = { packageKey: resolved.key }
      const input: ClaimInput = { card, status, principal, personDecision: { ...record(), summary: personDecisionSummary(decision, target) }, close: { reason: 'decided', note: decidedResumeMessage(decision, target) }, now }
      const claimed = await inCardTransaction(() => prisma.$transaction((tx) => claimAndClose(tx, input)))
      if (!claimed.ok) return claimed
      await afterClaim(card, input, claimed.value)
      try {
        await routeHandOffs({ workspaceId: card.workspaceId, goalVersion: version, source: 'person', sourceKey: personHandOffSourceKey(card.id), fromRunId: card.question.askerRunId, fromPackageKey: null, items: [item] })
      } catch (error) {
        // Said and swallowed: the decision is recorded; the goal pass routes it (`routeStoredPersonHandOffs`).
        console.error(`[cards] card ${card.id}: the hand-off waits for the next goal pass:`, error)
      }
      return ok({ decision: decision.kind, summary: input.personDecision.summary })
    }
    case 'record_decision': {
      if (version === null) return refused('the question belongs to no goal version')
      const input: ClaimInput = { card, status, principal, personDecision: record(), close: { reason: 'decided', note: decidedResumeMessage(decision, { packageKey: null }) }, now }
      const claimed = await inCardTransaction(() =>
        prisma.$transaction(async (tx) => {
          try {
            await writeGoalDecisionIn(tx, { workspaceId: card.workspaceId, goalVersion: version, title: decision.title, decision: decision.text, source: 'person', questionId: card.subjectId, decisionId: card.id })
          } catch (error) {
            if (error instanceof GoalDecisionRefused) throw new CardRefused({ kind: 'card_decision_refused', decisionId: card.id, reason: error.message })
            throw error
          }
          return claimAndClose(tx, input)
        }),
      )
      if (!claimed.ok) return claimed
      await afterClaim(card, input, claimed.value)
      return ok({ decision: decision.kind, summary: input.personDecision.summary })
    }
    case 'change_requirement': {
      const input: ClaimInput = { card, status, principal, personDecision: record(), close: { reason: 'superseded', note: decidedResumeMessage(decision, { packageKey: null }) }, now }
      const claimed = await inCardTransaction(() => prisma.$transaction((tx) => claimAndClose(tx, input)))
      if (!claimed.ok) return claimed
      const changed = await requestChange(card.workspaceId, personText(decision.request), principal)
      if (!changed.ok) {
        // After the claim: the card says why, and the question waits again (a refused decision closes nothing).
        await prisma.supervisorDecision.update({ where: { id: card.id }, data: { status: 'failed', failureReason: refusalText(changed.error) } })
        await prisma.slaveMessage.updateMany({ where: { id: card.subjectId, closedReason: 'superseded' }, data: { closedAt: null, closedReason: null, closedBy: null, closedNote: null } })
        return changed
      }
      await afterClaim(card, input, claimed.value)
      return ok({ decision: decision.kind, summary: input.personDecision.summary })
    }
    case 'give_file':
      return giveFile(card, decision, record, status, principal, now)
  }
}
```

Imports: `resolveHandOff`, `HANDOFF_CHANGE_MAX_CHARS` (domain); `routeHandOffs`, `personHandOffSourceKey` (`./handOffs.js`); `writeGoalDecisionIn`, `GoalDecisionRefused` (`./conductorAnswer.js`); `requestChange` (`./goal.js`). For this task, `giveFile` is this stub, which Task 5 replaces:

```ts
/** Task 5 replaces this; until then a file grant is refused and nothing is written. */
async function giveFile(card: PendingCard, _decision: Extract<CardDecision, { kind: 'give_file' }>, _record: (extra?: Partial<PersonDecision>) => PersonDecision, _status: 'approved' | 'rejected', _principal: Principal | undefined, _now: Date): Promise<Result<DecideOutcome, ControlRefusal>> {
  return err({ kind: 'card_decision_refused', decisionId: card.id, reason: 'not yet' })
}
``` Check `requestChange`'s import does not cycle: `goal.ts` must not import `cards.ts`.

- [ ] **Step 5: Run.** `npx tsc --build`, then `npx vitest run packages/control/test/integration/cards.test.ts`, then `npx vitest run packages/control/test/integration/conductor-answer.test.ts packages/control/test/integration/hand-offs.test.ts` → PASS. `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/control/src/cards.ts packages/control/src/conductorAnswer.ts packages/control/src/handOffs.ts packages/control/test/integration/cards.test.ts
git commit -m "feat(cards): a person gives a package work, records a shared decision, or changes a requirement from a card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Give a file to a package, under the delivery lock, and say so on the report

**Files:**
- Modify: `packages/control/src/cards.ts` (`giveFile`)
- Modify: `packages/domain/src/goalReport/types.ts` (`GoalReportPersonDecision`, `GoalReport.personDecisions`), `packages/domain/src/goalReport/markdown.ts` (section "Decided on cards")
- Modify: `packages/control/src/goalReport.ts:300-360` (read `personDecision` rows of the version)
- Modify: `apps/web/src/components/project/GoalReportView.tsx` (a panel after Questions)
- Test: `packages/control/test/integration/cards.test.ts` (new describe), `packages/domain/test/goalReport/markdown.test.ts`

**Interfaces:**
- Consumes: `planFileGrant` (Task 2), `withDeliveryLock` (`goalDelivery.ts:44`), `registrationsSchema`, `claimAndClose`/`afterClaim`/`CardRefused`/`inCardTransaction` (Task 3).
- Produces: `GoalReport.personDecisions: readonly GoalReportPersonDecision[]`, `interface GoalReportPersonDecision { readonly at: string; readonly questionId: string; readonly kind: CardDecisionKind; readonly summary: string }`.

- [ ] **Step 1: Failing tests.** Add to `cards.test.ts`:

```ts
describe('decideCard: give a file (human cards H2.4)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE)
  })

  it('moves a file from its glob owner, takes effect for the next run, and records the move', async () => {
    const f = await seedCard()
    // The asker is parked on the question, so the target must not be its package; give it to api's neighbour.
    await prisma.workPackage.create({ data: { workspaceId: f.workspaceId, goalVersion: 1, key: 'web', title: 'web', requirementKeys: [], ownedPaths: ['src/web/**'], interface: '', templateId: 'tpl' } })
    expect((await decideCard(f.cardId, { kind: 'give_file', path: 'src/api/routes.ts', toPackage: 'web' }, { userId: 'u1' })).ok).toBe(true)
    const byKey = new Map((await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId } })).map((p) => [p.key, p]))
    expect(byKey.get('api')).toMatchObject({ ownedPaths: ['src/api/**'], releasedPaths: ['src/api/routes.ts'] })
    expect(byKey.get('web')).toMatchObject({ ownedPaths: ['src/web/**', 'src/api/routes.ts'] })
    expect((await cardOf(f)).personDecision).toMatchObject({ grant: { path: 'src/api/routes.ts', fromKey: 'api', toKey: 'web' } })
    expect((await questionOf(f)).closedReason).toBe('decided')
  })

  it('refuses a split manifest family, a version being verified, and a package with a live run -- closing nothing', async () => {
    const f = await seedCard()
    const family = await decideCard(f.cardId, { kind: 'give_file', path: 'backend/package.json', toPackage: 'api' })
    expect(!family.ok && family.error).toMatchObject({ kind: 'card_decision_refused' })
    expect(!family.ok && refusalText(family.error)).toContain('belong to the skeleton package')
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying' } })
    const verifying = await decideCard(f.cardId, { kind: 'give_file', path: 'src/api/routes.ts', toPackage: 'skeleton' })
    expect(!verifying.ok && refusalText(verifying.error)).toContain('verified')
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'integrating' } })
    // Dockerfile is the integration package's (nobody else owns it), and integration's run is parked.
    const live = await decideCard(f.cardId, { kind: 'give_file', path: 'Dockerfile', toPackage: 'skeleton' })
    expect(!live.ok && refusalText(live.error)).toContain('live run')
    expect((await questionOf(f)).closedAt).toBeNull()
    expect((await cardOf(f)).status).toBe('pending')
    expect((await prisma.workPackage.findFirstOrThrow({ where: { workspaceId: f.workspaceId, key: 'api' } })).releasedPaths).toEqual([])
  })
})
```

Import `refusalText` from `'../../src/refusal.js'`. Domain markdown test:

```ts
  it('lists what a person decided on cards (human cards H2)', () => {
    const md = renderGoalReportMarkdown({ ...baseReport(), personDecisions: [{ at: '2026-10-03T09:00:00.000Z', questionId: 'm1', kind: 'give_file', summary: 'gave src/api/routes.ts to the web package' }] })
    expect(md).toContain('## Decided on cards')
    expect(md).toContain('- 2026-10-03T09:00:00.000Z · gave src/api/routes.ts to the web package')
  })
```

Run → FAIL.

- [ ] **Step 2: `giveFile`.**

```ts
/**
 * Human cards H2.4 (plan B D5): the one ownership change. Under the delivery's lock, only while the
 * version is integrating with no smoke or verification claim and neither package has a live run; the
 * `WorkPackage` writes are guarded on the arrays read and THROW when they lose, and the claim and the
 * close follow in the same transaction, so a refused grant changes nothing and closes nothing.
 */
async function giveFile(
  card: PendingCard,
  decision: Extract<CardDecision, { kind: 'give_file' }>,
  record: (extra?: Partial<PersonDecision>) => PersonDecision,
  status: 'approved' | 'rejected',
  principal: Principal | undefined,
  now: Date,
): Promise<Result<DecideOutcome, ControlRefusal>> {
  const refusedBy = (reason: string): CardRefused => new CardRefused({ kind: 'card_decision_refused', decisionId: card.id, reason })
  const version = card.question.goalVersion
  if (version === null) return err({ kind: 'card_decision_refused', decisionId: card.id, reason: 'the question belongs to no goal version' })
  const delivery = await prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId: card.workspaceId, goalVersion: version } }, select: { id: true } })
  if (delivery === null) return err({ kind: 'card_decision_refused', decisionId: card.id, reason: `goal v${String(version)} has no delivery: a file is given only while its packages are integrated` })
  const done = await inCardTransaction(() =>
    withDeliveryLock(delivery.id, async (tx) => {
      const head = await tx.goalDelivery.findUniqueOrThrow({ where: { id: delivery.id }, select: { status: true, activeSmokeId: true, activeRunId: true } })
      if (head.status !== 'integrating' || head.activeSmokeId !== null || head.activeRunId !== null) {
        throw refusedBy(`goal v${String(version)} is being verified or smoked (or is over): a file is given only while it is integrating`)
      }
      const packages = await tx.workPackage.findMany({
        where: { workspaceId: card.workspaceId, goalVersion: version },
        orderBy: { key: 'asc' },
        select: { id: true, key: true, ownedPaths: true, releasedPaths: true, isIntegration: true, registrations: true, tasks: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1, select: { activeRunId: true } } },
      })
      const plan = planFileGrant({
        path: decision.path,
        toKey: decision.toPackage,
        packages: packages.map((p) => ({ key: p.key, ownedPaths: p.ownedPaths, releasedPaths: p.releasedPaths, isIntegration: p.isIntegration, registrations: registrationsSchema.parse(p.registrations) })),
      })
      if (!plan.ok) throw refusedBy(plan.error)
      for (const key of [plan.value.toKey, plan.value.fromKey]) {
        if (key !== null && packages.find((p) => p.key === key)?.tasks[0]?.activeRunId != null) {
          throw refusedBy(`the ${key} package has a live run: give the file once it has finished, or give the ${key} package the work instead`)
        }
      }
      for (const change of plan.value.changes) {
        const pkg = packages.find((p) => p.key === change.key)
        if (pkg === undefined) throw refusedBy(`the ${change.key} package is gone`)
        const moved = await tx.workPackage.updateMany({
          where: { id: pkg.id, ownedPaths: { equals: pkg.ownedPaths }, releasedPaths: { equals: pkg.releasedPaths } },
          data: { ownedPaths: [...change.ownedPaths], releasedPaths: [...change.releasedPaths] },
        })
        if (moved.count === 0) throw refusedBy('the packages changed while this was decided: decide again')
      }
      const input: ClaimInput = {
        card,
        status,
        principal,
        personDecision: record({ grant: { path: plan.value.path, fromKey: plan.value.fromKey, toKey: plan.value.toKey } }),
        close: { reason: 'decided', note: decidedResumeMessage(decision, { packageKey: plan.value.toKey }) },
        now,
      }
      return { input, close: await claimAndClose(tx, input) }
    }),
  )
  if (!done.ok) return done
  await afterClaim(card, done.value.input, done.value.close)
  return ok({ decision: decision.kind, summary: done.value.input.personDecision.summary })
}
```

Imports: `planFileGrant`, `registrationsSchema` (domain); `withDeliveryLock` (`./goalDelivery.js`). Check that `goalDelivery.ts` does not import `cards.ts`. In the seeded fixture, the integration task's `activeRunId` is the parked run. `Dockerfile` is owned by integration (nobody else owns it), so the third refusal names a live run on the owning side.

- [ ] **Step 3: Report.** `types.ts`:

```ts
/** Human cards H2 (plan B D3): one decision a person took on a card about this version's questions. */
export interface GoalReportPersonDecision {
  readonly at: string
  readonly questionId: string
  readonly kind: CardDecisionKind
  /** `personDecisionSummary`: built from the person's words, raw -- renderers escape it. */
  readonly summary: string
}
```

`GoalReport` gains `readonly personDecisions: readonly GoalReportPersonDecision[]` ("oldest first"). In `goalReport.ts`, read them:

```ts
  const decided = await prisma.$queryRaw<{ resolvedAt: Date; subjectId: string; personDecision: unknown }[]>`
    SELECT "resolvedAt", "subjectId", "personDecision" FROM "SupervisorDecision"
    WHERE "workspaceId" = ${workspaceId} AND "personDecision" ->> 'goalVersion' = ${String(goalVersion)} AND status IN ('approved', 'rejected')
    ORDER BY "resolvedAt", id`
  const personDecisions = decided.flatMap((row) => {
    const parsed = personDecisionSchema.safeParse(row.personDecision)
    return parsed.success ? [{ at: row.resolvedAt.toISOString(), questionId: row.subjectId, kind: parsed.data.decision.kind, summary: parsed.data.summary }] : []
  })
```

and put `personDecisions` in the report object. `markdown.ts`, after the Questions section and before the footer:

```ts
  lines.push('## Decided on cards', '')
  if (report.personDecisions.length === 0) lines.push('Nothing was decided on a card.', '')
  for (const d of report.personDecisions) lines.push(`- ${mdInline(d.at)} · ${mdInline(d.summary)}`)
  if (report.personDecisions.length > 0) lines.push('')
```

`GoalReportView.tsx`: a `<Panel title="Decided on cards">` after Questions, one `<p data-testid="goal-report-person-decision">` per entry with `{d.at} {d.summary}` as JSX children. Every test fixture that builds a `GoalReport` gains `personDecisions: []` (`grep -rln "handOffsOmitted:" packages apps --include=*.ts --include=*.tsx | grep test`).

- [ ] **Step 4: Run.** `npx tsc --build`, then `npx vitest run packages/control/test/integration/cards.test.ts`, the markdown test and the goal-report test → PASS. `npm run typecheck`. `npm run web:build`, then `rm -rf apps/web/.next`.

- [ ] **Step 5: Commit**

```bash
git add packages/control/src/cards.ts packages/control/src/goalReport.ts packages/domain/src/goalReport packages/domain/test apps/web/src/components/project/GoalReportView.tsx packages/control/test apps/web/test
git commit -m "feat(cards): a person gives a file to a package under the delivery lock, and the report lists what was decided on cards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The decide route

**Files:**
- Create: `apps/web/src/app/api/w/[workspaceId]/supervisor/decisions/[decisionId]/decide/route.ts`
- Test: `apps/web/test/decide-route.test.ts` (new; follow the file that tests the approve route: `grep -rln "decisions/.*/approve\|approve/route" apps/web/test`)

**Interfaces:**
- Consumes: `decideCard` (Task 3), `cardDecisionSchema` (Task 1), `decisionControlResponse`, `requirePrincipal`.
- Produces: `POST .../decide` → 200 `{ ok: true }`, 400 for a body `cardDecisionSchema` refuses, 404 for a card in another workspace, 409 for every refusal (`refusalStatus`).

- [ ] **Step 1: Failing test.** Mirror the approve route's test harness (its principal stub and request builder):

```ts
it('decides a card through one route, and answers 400 for a body that is no decision', async () => {
  const f = await seedQuestionCard() // the harness's own seed: a conducted workspace, a parked question, a pending escalation card
  const bad = await POST(jsonRequest({ kind: 'approve' }), params(f.workspaceId, f.cardId))
  expect(bad.status).toBe(400)
  const ok = await POST(jsonRequest({ kind: 'dismiss', reason: 'not needed' }), params(f.workspaceId, f.cardId))
  expect(ok.status).toBe(200)
  const again = await POST(jsonRequest({ kind: 'dismiss', reason: null }), params(f.workspaceId, f.cardId))
  expect(again.status).toBe(409)
  const elsewhere = await POST(jsonRequest({ kind: 'dismiss', reason: null }), params('another-workspace', f.cardId))
  expect(elsewhere.status).toBe(404)
})
```

- [ ] **Step 2: The route.**

```ts
import { decideCard } from '@slave-of-ai/control'
import { cardDecisionSchema } from '@slave-of-ai/domain'
import { decisionControlResponse } from '../../../../../../../../server/supervisorControlRoute'
import { requirePrincipal } from '../../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR =
  'the body must be one decision: { "kind": "send_answer" | "write_answer" | "give_work" | "give_file" | "record_decision" | "change_requirement" | "dismiss", ... }'

/**
 * Human cards H2 (plan B D1): a person decides a question card. One route for every decision, with a
 * discriminated body; `cardDecisionSchema` is the one validator (the verb checks it again for the CLI).
 * The approve route's shell: a principal first, a card in another workspace reads as missing, and
 * every refusal -- a card resolved meanwhile, a closed question, a refused grant -- is the verb's own
 * sentence with a 409.
 */
export async function POST(request: Request, context: { params: Promise<{ workspaceId: string; decisionId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, decisionId } = await context.params
  const raw: unknown = await request.json().catch(() => null)
  const parsed = cardDecisionSchema.safeParse(raw)
  if (!parsed.success) return Response.json({ error: BODY_ERROR }, { status: 400 })
  return decisionControlResponse(workspaceId, decisionId, () => decideCard(decisionId, parsed.data, gate.principal ?? undefined))
}
```

- [ ] **Step 3: Run.** The route test → PASS. `npm run typecheck`. `npm run web:build`, then `rm -rf apps/web/.next`.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/api/w/[workspaceId]/supervisor/decisions/[decisionId]/decide/route.ts" apps/web/test/decide-route.test.ts
git commit -m "feat(web): one route decides a question card, with a discriminated body

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The card's decisions in the browser

**Files:**
- Create: `apps/web/src/components/supervisor/CardDecisions.tsx`
- Modify: `apps/web/src/components/supervisor/ProposalRow.tsx:276-389` (`onDecide?`; render `CardDecisions` instead of approve/reject when the card offers decisions)
- Modify: `apps/web/src/components/project/SupervisorTimeline.tsx:177-192`, `apps/web/src/components/organization/OrganizationClient.tsx:517-525` (pass `onDecide`)
- Test: `apps/web/test/card-decisions.test.tsx` (new)

**Interfaces:**
- Consumes: `DecisionView.card.offers`, `.packages`, `CARD_DECISION_KINDS`.
- Produces: `CardDecisions({ card, draftBody, busy, onDecide }: { readonly card: QuestionCard; readonly draftBody: string | null; readonly busy: boolean; readonly onDecide: (body: Record<string, unknown>) => void })`.

- [ ] **Step 1: Failing test.**

```tsx
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CardDecisions } from '../src/components/supervisor/CardDecisions'

const card = {
  messageId: 'm1', body: 'May I edit backend/package.json?', goalVersion: 1, askerPackageKey: 'integration', askerRunId: 'r1', askerWaiting: true,
  closed: null, timeoutRefusal: null,
  packages: [{ key: 'skeleton', title: 'The runnable skeleton', isIntegration: false }, { key: 'integration', title: 'Integrate', isIntegration: true }],
  offers: ['write_answer', 'give_work', 'give_file', 'record_decision', 'change_requirement', 'dismiss'] as const,
}

describe('CardDecisions (human cards H2)', () => {
  it('offers only what the card offers, and sends a give-work decision as one body', () => {
    const onDecide = vi.fn()
    const { getByTestId, queryByTestId } = render(<CardDecisions card={card} draftBody={null} busy={false} onDecide={onDecide} />)
    expect(queryByTestId('card-decision-send_answer')).toBeNull()
    fireEvent.click(getByTestId('card-decision-give_work'))
    fireEvent.change(getByTestId('card-target-package'), { target: { value: 'skeleton' } })
    fireEvent.change(getByTestId('card-text'), { target: { value: 'add a "start" script' } })
    fireEvent.click(getByTestId('card-decide'))
    expect(onDecide).toHaveBeenCalledWith({ kind: 'give_work', target: { package: 'skeleton' }, request: 'add a "start" script' })
  })

  it('says what applies: the draft\'s decision and hand-off on send, nothing of them on a written answer', () => {
    const { getByTestId } = render(<CardDecisions card={{ ...card, offers: ['send_answer', 'write_answer', 'dismiss'] }} draftBody="Yes." busy={false} onDecide={vi.fn()} />)
    fireEvent.click(getByTestId('card-decision-send_answer'))
    expect(getByTestId('card-decision-note').textContent).toContain('its shared decision and hand-off apply')
    fireEvent.click(getByTestId('card-decision-write_answer'))
    expect(getByTestId('card-decision-note').textContent).toContain('the draft\'s decision and hand-off do not apply')
  })

  it('says where a decision goes once the run continued without an answer', () => {
    const { getByTestId } = render(<CardDecisions card={{ ...card, askerWaiting: false, closed: { reason: 'timed_out', at: 'x', by: 'system' } }} draftBody={null} busy={false} onDecide={vi.fn()} />)
    fireEvent.click(getByTestId('card-decision-write_answer'))
    expect(getByTestId('card-decision-note').textContent).toContain('reaches the integration package as a hand-off')
  })
})
```

- [ ] **Step 2: The component.**

```tsx
'use client'

import { useState } from 'react'
import type { CardDecisionKind } from '@slave-of-ai/domain'
import type { SupervisorView } from '../../server/supervisor'
import { Button } from '../ui/Button'

type QuestionCard = NonNullable<SupervisorView['pending'][number]['card']>

const LABEL: Readonly<Record<CardDecisionKind, string>> = {
  send_answer: 'send this answer',
  write_answer: 'write my own answer',
  give_work: 'give a package work',
  give_file: 'give a file to a package',
  record_decision: 'record a shared decision',
  change_requirement: 'change a requirement',
  dismiss: 'dismiss and close',
}

/** What choosing a decision will do -- the sentence the spec asks each card to say (H2). */
function noteFor(kind: CardDecisionKind, card: QuestionCard): string {
  const late = card.closed?.reason === 'timed_out' && card.askerPackageKey !== null ? ` The run continued without an answer, so it reaches the ${card.askerPackageKey} package as a hand-off.` : ''
  switch (kind) {
    case 'send_answer':
      return `Sends the drafted answer as it is; its shared decision and hand-off apply.${late}`
    case 'write_answer':
      return `Sends your words instead; the draft's decision and hand-off do not apply.${late}`
    case 'give_work':
      return 'The package that owns it is asked for the change (reopened if it has finished); the asker is told it is not its to make.'
    case 'give_file':
      return 'Moves one file to another package. It takes effect at that package\'s next run; refused while either package is running or the version is being verified.'
    case 'record_decision':
      return 'Joins this goal version\'s shared decisions, in every later contract.'
    case 'change_requirement':
      return 'Opens a new goal version with your change; this question is superseded.'
    case 'dismiss':
      return 'Closes the question without an answer; a waiting run continues on its safest assumption, told your reason.'
  }
}

/**
 * Human cards H2: the decisions a question card offers, each one click or a short form. Every
 * string a person types or a worker wrote is a JSX child or a form value -- characters, never markup.
 */
export function CardDecisions({
  card,
  draftBody,
  busy,
  onDecide,
}: {
  readonly card: QuestionCard
  readonly draftBody: string | null
  readonly busy: boolean
  readonly onDecide: (body: Record<string, unknown>) => void
}): React.JSX.Element {
  const [kind, setKind] = useState<CardDecisionKind | null>(null)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [pkg, setPkg] = useState('')
  const [path, setPath] = useState('')

  const body = (): Record<string, unknown> | null => {
    switch (kind) {
      case null:
        return null
      case 'send_answer':
        return { kind }
      case 'write_answer':
        return { kind, body: text }
      case 'give_work':
        return { kind, target: path.trim() !== '' ? { path } : { package: pkg }, request: text }
      case 'give_file':
        return { kind, path, toPackage: pkg }
      case 'record_decision':
        return { kind, title, text }
      case 'change_requirement':
        return { kind, request: text }
      case 'dismiss':
        return { kind, reason: text.trim() === '' ? null : text }
    }
  }
  const needsText = kind === 'write_answer' || kind === 'give_work' || kind === 'record_decision' || kind === 'change_requirement' || kind === 'dismiss'
  const needsPackage = kind === 'give_work' || kind === 'give_file'
  const needsPath = kind === 'give_work' || kind === 'give_file'

  return (
    <div data-testid="card-decisions" className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {card.offers.map((offer) => (
          <Button key={offer} size="sm" variant={offer === kind ? 'primary' : 'ghost'} data-testid={`card-decision-${offer}`} disabled={busy} onClick={() => {
            setKind(offer)
            if (offer === 'write_answer' && text === '' && draftBody !== null) setText(draftBody)
          }}>
            {LABEL[offer]}
          </Button>
        ))}
      </div>
      {kind !== null && (
        <>
          <span data-testid="card-decision-note" className="text-[11px] text-text-2">{noteFor(kind, card)}</span>
          {needsPackage && (
            <select data-testid="card-target-package" value={pkg} onChange={(event) => setPkg(event.target.value)} className="rounded border border-line bg-bg-0 px-2 py-1 text-[11px]">
              <option value="">{kind === 'give_work' ? 'the package (or name a file below)' : 'the package'}</option>
              {card.packages.map((p) => (
                <option key={p.key} value={p.key}>{p.key} — {p.title}</option>
              ))}
            </select>
          )}
          {needsPath && (
            <input data-testid="card-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder={kind === 'give_work' ? 'or a file, whose owner gets the work' : 'the file, e.g. backend/package.json'} className="rounded border border-line bg-bg-0 px-2 py-1 text-[11px]" />
          )}
          {kind === 'record_decision' && (
            <input data-testid="card-title" value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} placeholder="title (at most 80 characters)" className="rounded border border-line bg-bg-0 px-2 py-1 text-[11px]" />
          )}
          {needsText && (
            <textarea data-testid="card-text" value={text} rows={3} onChange={(event) => setText(event.target.value)} placeholder={kind === 'dismiss' ? 'why (optional)' : kind === 'record_decision' ? 'the decision (at most 600 characters)' : 'what you want done'} className="rounded border border-line bg-bg-0 p-2 text-xs" />
          )}
          <Button variant="primary" size="sm" data-testid="card-decide" disabled={busy} onClick={() => {
            const b = body()
            if (b !== null) onDecide(b)
          }}>
            decide
          </Button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: `ProposalRow`.** Add the prop `readonly onDecide?: (body: Record<string, unknown>) => void` (documented "Human cards H2: present where the page can post to the decide route"). Replace the final approve/reject `<div>` with:

```tsx
      {decision.card != null && decision.card.offers.length > 0 && onDecide !== undefined ? (
        <CardDecisions card={decision.card} draftBody={draft?.editedBody ?? draft?.body ?? null} busy={busy} onDecide={onDecide} />
      ) : (
        <div className="flex items-center gap-2">{/* ...the existing reason box, approve and reject, unchanged... */}</div>
      )}
```

`SupervisorTimeline.tsx`: `onDecide={(body) => void send(rowId, `${url}/decide`, body)}`. `OrganizationClient.tsx`: `onDecide={(body) => void send(decision.id, 'decide', body)}` (its `send` takes a verb, so check it builds `.../decisions/<id>/<verb>`: `grep -n "const send" apps/web/src/components/organization/OrganizationClient.tsx`).

- [ ] **Step 4: Run.** `npx vitest run apps/web/test/card-decisions.test.tsx apps/web/test/proposal-row.test.tsx` → PASS. `npm run typecheck`. `npm run web:build`, then `rm -rf apps/web/.next`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/supervisor apps/web/src/components/project/SupervisorTimeline.tsx apps/web/src/components/organization/OrganizationClient.tsx apps/web/test/card-decisions.test.tsx
git commit -m "feat(web): a question card offers its decisions and says what each one will do

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: A worker's note is not a card

**Files:**
- Create: `packages/db/prisma/migrations/20261003100000_package_noted/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`enum EventType`, after `slave_question_closed`), `packages/db/src/enums.ts`
- Modify: `packages/domain/src/conduct/report.ts:8-55` (`notes`), `packages/domain/src/conduct/contract.ts:209-235` (protocol example and line), `packages/domain/src/conduct/constants.ts` (`NOTES_PER_REPORT_MAX = 10`, `NOTE_MAX_CHARS = 1000`)
- Modify: `packages/domain/src/events/schema.ts` (new variant), `packages/domain/src/supervisor/timeline.ts` (lane)
- Modify: `apps/orchestrator/src/report.ts:54-67` (append the notes)
- Modify: `packages/domain/src/goalReport/types.ts`, `markdown.ts`, `packages/control/src/goalReport.ts`, `apps/web/src/components/project/GoalReportView.tsx` (Notes from the packages)
- Modify: `apps/web/src/components/activity/cards.tsx`, `apps/web/src/lib/activityFilters.ts`, `apps/web/src/server/timeline.ts`; `scripts/gate-m56a-provider-contract.mjs` (77 → 78)
- Test: `packages/domain/test/conduct/report.test.ts`, `packages/domain/test/conduct/contract.test.ts`, `packages/domain/test/events/question-events.test.ts` (one case), `packages/domain/test/supervisor/timeline.test.ts` (77 → 78), `apps/orchestrator/test/integration/report.test.ts` (the file that tests `fileRunReport`: `grep -rln fileRunReport apps/orchestrator/test`), `apps/web/test/activity-cards.test.tsx`, `apps/web/test/activityFilters.test.ts`

**Interfaces:**
- Produces: `SlaveReport.notes: readonly string[]`; event `workspace.package_noted { version: int>0, packageKey: string(1..40), runId: string, note: string(1..1000) }`; `GoalReport.notes: readonly { readonly at: string; readonly packageKey: string; readonly text: string }[]`.

- [ ] **Step 1: Migration.**

```sql
-- Human-cards spec H4 (plan B D9): information a worker reports that needs no decision ("the vendor
-- key is a placeholder") is a note -- written to the activity feed and the goal report, never a
-- question or a card.
--
-- PURELY ADDITIVE: one enum value, unused inside this transaction.

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.package_noted';
```

Schema: `workspace_package_noted @map("workspace.package_noted")`. `enums.ts`: `'workspace.package_noted': 'workspace_package_noted',`. Run `npm run db:generate && npm run db:migrate:test`.

- [ ] **Step 2: Failing tests.** `report.test.ts`:

```ts
  it('reads notes, bounded, and an old report as having none (human cards plan B D9)', () => {
    const report = (notes: unknown) => `<slave-report>${JSON.stringify({ requirements: [], filesTouched: [], workflow: [], questions: [], handOffs: [], ...(notes === undefined ? {} : { notes }) })}</slave-report>`
    const read = parseSlaveReport(report(['VENDOR_LICENSE_PUBLIC_KEYS is a placeholder; the vendor runs the keygen offline.']), [])
    expect(read.ok && read.value.notes).toEqual(['VENDOR_LICENSE_PUBLIC_KEYS is a placeholder; the vendor runs the keygen offline.'])
    expect(parseSlaveReport(report(undefined), []).ok && (parseSlaveReport(report(undefined), []) as { ok: true; value: { notes: string[] } }).value.notes).toEqual([])
    expect(parseSlaveReport(report(Array.from({ length: 11 }, () => 'n')), []).ok).toBe(false)
    expect(parseSlaveReport(report(['x'.repeat(1001)]), []).ok).toBe(false)
  })
```

`contract.test.ts`:

```ts
  it('tells a worker that information for a person is a note, never a question (plan B D9)', () => {
    const text = renderReportProtocol(['R1'], 0)
    expect(text).toContain('"notes":[]')
    expect(text).toContain('- "notes": what a person should know that needs no decision')
  })
```

The orchestrator report test files a report with two notes, files it twice (a replay), and expects exactly two `workspace_package_noted` events with `{ version: 1, packageKey, runId, note }` and no `SlaveMessage`. Use the file's own fixture and filing call. Run → FAIL.

- [ ] **Step 3: Domain.** `constants.ts`:

```ts
/** Human cards plan B D9: notes per report, and each note's length. */
export const NOTES_PER_REPORT_MAX = 10
export const NOTE_MAX_CHARS = 1000
```

`report.ts`: `SlaveReport` gains `/** Human cards plan B D9: what a person should know that needs no decision -- the feed and the report, never a card. */ readonly notes: readonly string[]`, and the schema gains `notes: z.array(z.string().trim().min(1).max(NOTE_MAX_CHARS)).max(NOTES_PER_REPORT_MAX).default([]),`. `contract.ts`: the example gains `notes: []` after `handOffs: []`, and after the `questions` line:

```ts
    `- "notes": what a person should know that needs no decision (a placeholder key, a limit you accepted, a manual step for release); at most ${String(NOTES_PER_REPORT_MAX)}, each at most ${String(NOTE_MAX_CHARS)} characters. A note goes to the activity feed and the goal report: never put one in "questions" or "handOffs".`,
```

Event schema, after `slave.question_closed`:

```ts
  // Human cards plan B D9: one note from a package worker's report -- information, not a question.
  z.object({
    ...envelope,
    type: z.literal('workspace.package_noted'),
    payload: z.object({ version: z.number().int().positive(), packageKey: z.string().min(1).max(40), runId: z.string().min(1), note: z.string().min(1).max(1000) }),
  }),
```

Lane: `'workspace.package_noted': 'work', // Human cards plan B D9: a worker's note, beside its hand-offs.` In `question-events.test.ts` add a case that a note of 1001 characters is refused, and raise `timeline.test.ts` to 78.

- [ ] **Step 4: Filing.** In `apps/orchestrator/src/report.ts`, after the questions loop:

```ts
  // Human cards plan B D9: a note is information, not a question -- the feed and the report, once per run.
  if (parsed.value.notes.length > 0) {
    const said = await prisma.executionEvent.findFirst({ where: { workspaceId: task.workspaceId, type: 'workspace_package_noted', payload: { path: ['runId'], equals: run.id } }, select: { seq: true } })
    if (said === null) {
      for (const note of parsed.value.notes) {
        await appendEvent({ type: 'workspace.package_noted', workspaceId: task.workspaceId, taskId: task.id, runId: run.id, actor: 'slave', payload: { version: pkg.goalVersion, packageKey: pkg.key, runId: run.id, note: sanitisePersonText(note) } })
      }
    }
  }
```

- [ ] **Step 5: Report and web.** `GoalReport.notes` (oldest first) is read from the version's `workspace_package_noted` events in `goalReport.ts` (`payload.version = goalVersion`). In markdown, `## Notes from the packages` lists `- <at> · <packageKey>: <quoted text>`, or "No package left a note." The same panel goes in `GoalReportView.tsx`. Fixtures gain `notes: []`. `cards.tsx`:

```tsx
/** Human cards plan B D9: a worker's note -- information for a person, not a question. */
function WorkspacePackageNotedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { version: number; packageKey: string; note: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="working" label={`goal v${String(payload.version)}: ${payload.packageKey} left a note`}>
        <span data-testid="package-note">{payload.note}</span>
      </Transition>
    </ActivityCard>
  )
}
```

Registry: `'workspace.package_noted': WorkspacePackageNotedCard,`. The filter goes beside `workspace.package_handed_off`. `titleFor` gets `case 'workspace.package_noted': return \`goal v${...}: ${packageKey} left a note\``. The `PAYLOAD_BY_TYPE` entry is `{ version: 1, packageKey: 'identity-access', runId: 'r1', note: 'VENDOR_LICENSE_PUBLIC_KEYS is a placeholder.' }`. m56a: 77 → 78, comment "Human-cards Plan B added one event, `workspace.package_noted`."

- [ ] **Step 6: Run.** The domain, orchestrator and web tests above → PASS. `npx prisma migrate diff --from-url "$TEST_DATABASE_URL" --to-schema-datamodel packages/db/prisma/schema.prisma --exit-code` shows no difference. `npm run typecheck`. `npm run web:build`, then `rm -rf apps/web/.next`.

- [ ] **Step 7: Commit**

```bash
git add packages/db packages/domain apps/orchestrator/src/report.ts apps/orchestrator/test packages/control/src/goalReport.ts apps/web scripts/gate-m56a-provider-contract.mjs
git commit -m "feat(report): a worker's note goes to the feed and the goal report, never to a person's queue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: One queue per goal version

**Files:**
- Create: `packages/domain/src/supervisor/queue.ts`
- Modify: `packages/domain/src/supervisor/index.ts`
- Modify: `apps/web/src/server/supervisor.ts:78-160` (`SupervisorQuestionView.goalVersion`)
- Modify: `apps/web/src/server/needsYou.ts:27-153` (fields, versions, groups, order)
- Modify: `apps/web/src/components/project/NeedsYouBar.tsx:24-80` (`oneClick`, version chip, blocking mark)
- Modify: `apps/web/src/server/home.ts:100-107` (blocking first)
- Modify: `apps/web/src/server/sidebar.ts:16-112` (`blockingCount`), `apps/web/src/components/shell/ProjectSwitcher.tsx:100-116` (the count)
- Test: `packages/domain/test/supervisor/queue.test.ts` (new), `apps/web/test/needs-you.test.ts` (the file that tests `buildNeedsYou`: `grep -rln buildNeedsYou apps/web/test`), `apps/web/test/needs-you-bar.test.tsx` (the file that renders `NeedsYouRow`)

**Interfaces:**
- Produces:
  - `BLOCKING_SITUATION_KINDS: readonly SituationKind[] = ['goal_needs_human', 'task_blocked_human']`
  - `groupKeyFor(input: { readonly kind: 'decision' | 'question' | 'blocked_task' | 'integrate'; readonly situationKind: SituationKind | null; readonly subjectId: string; readonly taskId: string | null }): string`
  - `interface QueueCard { readonly id: string; readonly groupKey: string; readonly goalVersion: number | null; readonly blocking: boolean; readonly since: string }`
  - `interface QueueGroup { readonly key: string; readonly goalVersion: number | null; readonly blocking: boolean; readonly since: string; readonly ids: readonly string[] }`
  - `buildQueue(cards: readonly QueueCard[]): readonly QueueGroup[]` (versions newest first, project-level last; blocking first; then oldest)
  - `versionOfSubject(subjectId: string): number | null`
  - `NeedsYouItem` gains `goalVersion: number | null`, `blocking: boolean`, `groupKey: string`, `mergedIds: readonly string[]`, `oneClick: boolean`
  - `SidebarProject.blockingCount: number`

- [ ] **Step 1: Failing tests.** `queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildQueue, groupKeyFor, versionOfSubject } from '../../src/supervisor/queue.js'

describe('the queue (human cards H4)', () => {
  it('groups a question by the question, a task\'s cards and the blocked task by the task', () => {
    expect(groupKeyFor({ kind: 'decision', situationKind: 'conductor_question', subjectId: 'm1', taskId: null })).toBe('question:m1')
    expect(groupKeyFor({ kind: 'question', situationKind: null, subjectId: 'm1', taskId: 't1' })).toBe('question:m1')
    expect(groupKeyFor({ kind: 'decision', situationKind: 'task_failed', subjectId: 't1', taskId: 't1' })).toBe('task:t1')
    expect(groupKeyFor({ kind: 'blocked_task', situationKind: null, subjectId: 't1', taskId: 't1' })).toBe('task:t1')
    expect(groupKeyFor({ kind: 'decision', situationKind: 'goal_needs_human', subjectId: 'ws:v2', taskId: null })).toBe('goal_needs_human:ws:v2')
    expect(versionOfSubject('ws-1:v2:r3')).toBe(2)
    expect(versionOfSubject('m1')).toBeNull()
  })

  it('lists the newest version first, what blocks it first, merges one subject, and puts project items last', () => {
    const groups = buildQueue([
      { id: 'a', groupKey: 'question:m0', goalVersion: 1, blocking: false, since: '2026-10-03T08:00:00.000Z' },
      { id: 'b', groupKey: 'task:t1', goalVersion: 2, blocking: false, since: '2026-10-03T08:10:00.000Z' },
      { id: 'c', groupKey: 'task:t1', goalVersion: 2, blocking: true, since: '2026-10-03T08:20:00.000Z' },
      { id: 'd', groupKey: 'question:m2', goalVersion: 2, blocking: true, since: '2026-10-03T08:05:00.000Z' },
      { id: 'e', groupKey: 'no_reviewer:reviewer', goalVersion: null, blocking: false, since: '2026-10-03T07:00:00.000Z' },
    ])
    expect(groups.map((g) => [g.goalVersion, g.key, g.blocking, g.ids])).toEqual([
      [2, 'question:m2', true, ['d']],
      [2, 'task:t1', true, ['b', 'c']],
      [1, 'question:m0', false, ['a']],
      [null, 'no_reviewer:reviewer', false, ['e']],
    ])
  })
})
```

`needs-you.test.ts` (with its own seed helpers): a parked question on v2 with an escalation card, a `task_failed` card on a blocked task of v1. Expect the items to be `[{ kind: 'decision', goalVersion: 2, blocking: true, oneClick: false }, { kind: 'decision', goalVersion: 1, mergedIds: [<blocked task id>], oneClick: true }]`, and expect the bare question item not to be listed beside its card. `needs-you-bar.test.tsx`: a row with `oneClick: false` renders `needs-you-open` (a link to `item.href`) and no `needs-you-approve`, and a row with `blocking: true` renders `data-blocking="true"`. Run → FAIL.

- [ ] **Step 2: `queue.ts`.**

```ts
import { isQuestionSituation } from './cards.js'
import type { SituationKind } from './situations.js'

/** Human cards H4: cards that block their goal version beyond a parked asker. */
export const BLOCKING_SITUATION_KINDS: readonly SituationKind[] = ['goal_needs_human', 'task_blocked_human']

/** The task-subject kinds: a card about a task merges with the task's other items. */
const TASK_KINDS: ReadonlySet<SituationKind> = new Set(['review_cap_blocked', 'task_failed', 'task_blocked_human', 'stale_task', 'done_not_integrated_stale', 'package_seat_lost', 'foreign_file'])

/** `<ws>:v<n>...` subjects (verification and goal cards) name their version. */
export function versionOfSubject(subjectId: string): number | null {
  const match = /:v(\d+)(?::|$)/u.exec(subjectId)
  return match === null ? null : Number(match[1])
}

/** Plan B D8: the subject one queue row stands for -- a question, a task, or the card's own key. */
export function groupKeyFor(input: { readonly kind: 'decision' | 'question' | 'blocked_task' | 'integrate'; readonly situationKind: SituationKind | null; readonly subjectId: string; readonly taskId: string | null }): string {
  if (input.kind === 'question') return `question:${input.subjectId}`
  if (input.kind === 'blocked_task' || input.kind === 'integrate') return `task:${input.taskId ?? input.subjectId}`
  if (input.situationKind !== null && isQuestionSituation(input.situationKind)) return `question:${input.subjectId}`
  if (input.situationKind !== null && TASK_KINDS.has(input.situationKind)) return `task:${input.taskId ?? input.subjectId}`
  return `${input.situationKind ?? 'item'}:${input.subjectId}`
}

export interface QueueCard {
  readonly id: string
  readonly groupKey: string
  readonly goalVersion: number | null
  readonly blocking: boolean
  readonly since: string
}

export interface QueueGroup {
  readonly key: string
  readonly goalVersion: number | null
  readonly blocking: boolean
  readonly since: string
  /** The merged items, oldest first; the first is the row's own. */
  readonly ids: readonly string[]
}

/** Spec H4 (plan B D8): one queue per goal version -- newest version first, project-level last; blocking first; then oldest. */
export function buildQueue(cards: readonly QueueCard[]): readonly QueueGroup[] {
  const byKey = new Map<string, QueueCard[]>()
  for (const card of [...cards].sort((a, b) => Date.parse(a.since) - Date.parse(b.since))) {
    const key = `${card.goalVersion ?? 'project'}|${card.groupKey}`
    byKey.set(key, [...(byKey.get(key) ?? []), card])
  }
  const groups: QueueGroup[] = [...byKey.values()].map((members) => ({
    key: members[0]?.groupKey ?? '',
    goalVersion: members[0]?.goalVersion ?? null,
    blocking: members.some((m) => m.blocking),
    since: members[0]?.since ?? '',
    ids: members.map((m) => m.id),
  }))
  const versionRank = (v: number | null): number => (v === null ? Number.NEGATIVE_INFINITY : v)
  return groups.sort(
    (a, b) => versionRank(b.goalVersion) - versionRank(a.goalVersion) || Number(b.blocking) - Number(a.blocking) || Date.parse(a.since) - Date.parse(b.since),
  )
}
```

Export from the supervisor index.

- [ ] **Step 3: `buildNeedsYou`.** In `apps/web/src/server/supervisor.ts`, `SupervisorQuestionView` gains `readonly goalVersion: number | null` and `readonly askerWaiting: boolean`, from the world question's own fields. In `needsYou.ts`:
  - Extend `NeedsYouItem` with the five fields (documented "Human cards H4, plan B D8").
  - Read the versions of the decisions' task subjects in one query: `prisma.task.findMany({ where: { workspaceId, id: { in: taskIds } }, select: { id: true, goalVersion: true, workPackage: { select: { goalVersion: true } } } })`. `taskIds` are the subjects of the `TASK_KINDS` decisions, plus the blocked and done tasks already read. The task read gains `goalVersion` and `workPackage.goalVersion`.
  - For each decision, the version is `decision.card?.goalVersion ?? versionOfTask(decision.subjectId) ?? versionOfSubject(decision.subjectId)`. `blocking` is `decision.card?.askerWaiting === true || BLOCKING_SITUATION_KINDS.includes(decision.situationKind)`. `oneClick` is `decision.card == null || decision.card.offers.includes('send_answer')`. The task's id is `typeof decision.situation.facts['taskId'] === 'string' ? ... : TASK_KINDS has it ? decision.subjectId : null`.
  - A blocked task has `blocking: true` and an integrate item `blocking: false`. Both use the task's version.
  - Skip a question item whose `messageId` is the subject of a pending decision (the card is its row).
  - The blocked task with a pending decision about it is no longer dropped by `decidedSubjects`: it merges into the decision's group through `groupKeyFor` (`task:<id>`).
  - Finally build `QueueCard`s from the items (`id`, `groupKey`, `goalVersion`, `blocking`, `since`), call `buildQueue`, and return one item per group: the group's first member, with `mergedIds` = the other ids and `blocking` = the group's.

  Replace the final "Oldest first" sort with that order, and update the file's doc comment: "Human cards H4: per goal version, blocking first, one row per subject."
- [ ] **Step 4: The row.** In `NeedsYouRow`, add `data-blocking={item.blocking ? 'true' : 'false'}`. Show a chip with `v${item.goalVersion}` when it is not null and `+${item.mergedIds.length}` when the group merged rows. Render Approve only when `item.oneClick`. Otherwise:

```tsx
          <Link data-testid="needs-you-open" href={item.href} className="type-meta text-t1 underline">
            decide
          </Link>
```

Reject stays (on a question card it dismisses with no reason, Plan A D4).
- [ ] **Step 5: Home and the sidebar.** `home.ts:107`: sort `(a, b) => Number(b.blocking) - Number(a.blocking) || Date.parse(a.since) - Date.parse(b.since)`. `sidebar.ts`: `SidebarProject.blockingCount` ("Human cards H4: runs parked on an open question plus pending goal_needs_human and task_blocked_human cards -- counted on their own"). Two more grouped reads go in the `Promise.all`:

```ts
    prisma.$queryRaw<{ workspaceId: string; n: bigint }[]>`
      SELECT t."workspaceId", COUNT(*)::bigint AS n
      FROM "SlaveRun" r JOIN "Slave" s ON s.id = r."slaveId" JOIN "Team" t ON t.id = s."teamId"
      WHERE r.status = 'paused' AND r."pauseReason" = 'waiting_for_answer'
      GROUP BY t."workspaceId"`,
    prisma.supervisorDecision.groupBy({ by: ['workspaceId'], where: { status: 'pending', situationKind: { in: ['goal_needs_human', 'task_blocked_human'] } }, _count: { _all: true } }),
```

`blockingCount` = the sum of the two for the workspace. In `ProjectSwitcher.tsx`, beside the needs-you count, when `project.blockingCount > 0`:

```tsx
                <span data-testid="sidebar-blocking" data-blocking={project.blockingCount} title="blocking a goal version" className="font-mono text-[11px] font-medium text-s-blocked">
                  {project.blockingCount}!
                </span>
```

Check that `text-s-blocked` exists (`grep -rn "s-blocked" apps/web/src/app/globals.css apps/web/tailwind.config.*`). If it does not, use the token the HaltBanner uses.
- [ ] **Step 6: Run.** The queue, needs-you, needs-you-bar and sidebar tests (`grep -rln buildSidebarTree apps/web/test`) → PASS. `npm run typecheck`. `npm run web:build`, then `rm -rf apps/web/.next`.
- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/supervisor/queue.ts packages/domain/src/supervisor/index.ts packages/domain/test/supervisor/queue.test.ts apps/web/src apps/web/test
git commit -m "feat(web): one queue per goal version -- what blocks it first, one row per subject, no one-click approve without an answer to send

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The observed integration question, end to end, and verification

**Files:**
- Modify: `apps/orchestrator/test/integration/smoke.test.ts` (a new describe at the end)

**Interfaces:**
- Consumes: everything above; `seed`, `seedWithVerifier`, `depsFor`, `verifier`, `attemptsOf`, `taskStatus` (smoke.test.ts's own helpers at `:57-135`); `runGoalPass`; `continueWaitingRuns`; `decideCard`; `recordDecision`.

- [ ] **Step 1: The test (OBS-18, spec §5 "End to end").**

```ts
describe('the observed integration question, decided on a card (human cards §5, OBS-18)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "SlaveMessage", "PackageHandOff", "SmokeAttempt", "ProviderConfiguration", "RunContext", "Checkpoint", "Artifact", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })
  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  it('the person gives the skeleton the start-script work; the skeleton is reopened, the asker continues, and the version passes its smoke', async (): Promise<void> => {
    const START = '#!/usr/bin/env bash\ngrep -q \'"start"\' skeleton/package.json || { echo \'npm error Missing script: "start"\' >&2; exit 1; }\necho started\n'
    const f = await seedWithVerifier(START)
    // Integration is parked on the question it asked at 17:50:23 (OBS-18).
    const seat = await prisma.slave.findFirstOrThrow({ where: { id: f.verifierId } })
    const run = await prisma.slaveRun.create({ data: { slaveId: seat.id, taskId: f.taskOf.integration, status: 'paused', pauseReason: 'waiting_for_answer', pausedAt: new Date(), provider: 'claude_code' } })
    await prisma.task.update({ where: { id: f.taskOf.integration }, data: { status: 'waiting', integratedAt: null, activeRunId: run.id } })
    await prisma.checkpoint.create({ data: { runId: run.id, sessionId: 's1', worktreePath: f.integrationPath, pauseFlagPath: '/tmp/p', deniedToolUseIds: [], headCommit: 'a'.repeat(40), dirtyFiles: [] } })
    const asked = await sendMessage(run.id, { kind: 'question', body: 'May the integration package add a "start" script to skeleton/package.json so the Docker image runs?', recipientRole: CONDUCTOR_ROLE, expectsReply: true, taskId: f.taskOf.integration })
    if (!asked.ok) throw new Error(JSON.stringify(asked.error))
    const recorded = await recordDecision({
      workspaceId: f.workspaceId,
      situation: { kind: 'conductor_question', subjectId: asked.value.id, summary: 'A question to the conductor about goal v1 waits.', facts: {} },
      candidates: [{ action: { kind: 'escalate_to_human', summary: 'a person decides' }, tier: 'escalated', why: 'x' }],
      chosenIndex: 0, rationale: 'the record does not answer this', decidedBy: 'rules', modelCostUsd: null,
    })
    if (!recorded.ok) throw new Error(JSON.stringify(recorded.error))

    // The person's decision: the skeleton owns skeleton/package.json, so it gets the work.
    const decided = await decideCard(recorded.value.id, { kind: 'give_work', target: { path: 'skeleton/package.json' }, request: 'add "start": "node server.js" to skeleton/package.json' }, { userId: 'u1' })
    expect(decided.ok).toBe(true)
    expect(await taskStatus(f.taskOf.skeleton)).toBe('rework')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.skeleton } })).lastRejectionReason).toContain('From the operator')
    expect((await prisma.slaveMessage.findUniqueOrThrow({ where: { id: asked.value.id } })).closedReason).toBe('decided')

    // The asker continues with what was decided, on the next tick's pass.
    expect(await continueWaitingRuns(f.workspaceId)).toHaveLength(1)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).queuedMessage).toContain('the skeleton package will do this')

    // The skeleton's rework lands the script; integration finishes. (The runs themselves are the fakes' and other tests'.)
    mkdirSync(join(f.integrationPath, 'skeleton'), { recursive: true })
    writeFileSync(join(f.integrationPath, 'skeleton/package.json'), '{ "scripts": { "start": "node server.js" } }\n')
    git(['add', '-A'], f.integrationPath)
    git(['commit', '-q', '-m', 'merge(T-skeleton): the start script'], f.integrationPath)
    await prisma.task.updateMany({ where: { id: { in: [f.taskOf.skeleton, f.taskOf.integration] } }, data: { status: 'done', integratedAt: new Date(), activeRunId: null } })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { status: 'succeeded', terminalAt: new Date() } })

    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    expect((await attemptsOf(f)).at(-1)?.status).toBe('passed')
    expect(await prisma.packageHandOff.findFirstOrThrow({ where: { source: 'person' } })).toMatchObject({ toPackageKey: 'skeleton' })
  }, 120_000)
})
```

Imports to add at the top of `smoke.test.ts`: `decideCard`, `recordDecision`, `sendMessage` from `@slave-of-ai/control`; `CONDUCTOR_ROLE` from `@slave-of-ai/domain`; `continueWaitingRuns` from `'../../src/questionTimeout.js'`. The seed's packages own `skeleton/**`, `api/**` and `integration/**`, so `skeleton/package.json` resolves to the skeleton. The `SmokeAttempt` status field is `status`, as the existing tests read it (`attemptsOf(f))[0]?.status`).

- [ ] **Step 2: Run.** `npx vitest run apps/orchestrator/test/integration/smoke.test.ts -t "observed integration question"` → PASS. A failure here is a real gap in an earlier task: fix it there, as a fix commit.
- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/test/integration/smoke.test.ts
git commit -m "test(e2e): the observed integration question is decided on a card, reopens the skeleton, and the version passes its smoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Hygiene.** `git grep -nE "agency-agent[s]"` prints nothing. `node scripts/gate-m26-vocabulary.mjs` passes. `git log --format=%B <plan-A-head>..HEAD | grep -c "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` equals the number of commits. `git grep -n "Tasks 4 and 5 fill this in\|reason: 'not yet'" packages/control/src` prints nothing (no stub survives).
- [ ] **Step 5: Types, build, the suite.** `npm run typecheck`. `npm run web:build` with no `next dev` running, then `rm -rf apps/web/.next`. Stop any daemon, then run the whole suite once in the background: `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL; npx vitest run > /tmp/human-cards-b-suite.log 2>&1` with a 600 s budget. Wait on the log's summary line, not on `pgrep`.
- [ ] **Step 6: Gates.** On `DATABASE_URL="$GATE_DATABASE_URL"`, with the fake-CLI env as `ci.yml` sets it, the host daemon stopped, and `systemd-inhibit --what=sleep:idle`: `npm run gate:m56a` (25 / 25 / 78, a clean `prisma migrate diff`), `gate:m38`, `gate:m39`, `gate:m36`, `gate:m45` (the needs-you queue) and `gate:m61` (Simple mode's strip). Gates red on main before this plan (m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58) are not regressions; any other red gate is. When m45 or m61 read the old flat order or the `needs-you-approve` test id on a draftless answer card, update that gate's expectation in this task, and say so in the report.
- [ ] **Step 7: Spec check.** Walk spec H2, H4, §4 and §5 line by line and name the test for each sentence:
  - H2.1–H2.7: Tasks 3, 4, 5 and 7.
  - Machine cards keep approve and reject: Task 3's `card_not_a_question`, and Plan A Task 4.
  - §4: the conditional claim (Tasks 3 and 5), the file grant's conditions (Task 5), a refused decision closes nothing (Tasks 4 and 5), a person's hand-off rules and its key (Task 4), the decision cap and title (Task 4), person text bounded and inert (Task 3), authorisation (Task 6), and compatibility (D11).
  - H4: per version, blocking first, merged (Task 9), notes (Task 8), Simple mode and Home (Task 9), no one-click approve (Task 9), and the blocking count (Task 9).
  - §5 end to end (Task 10).

## Self-review (done while writing)

- **Spec coverage.**
  - H2.1 `send_answer`, H2.2 `write_answer` (Task 3); H2.3 give work (Task 4); H2.4 give a file (Tasks 2 and 5); H2.5 shared decision (Task 4); H2.6 change a requirement (Task 4); H2.7 dismiss (Task 3).
  - "the card says what will apply" (Task 7's notes).
  - Machine cards keep approve and reject (Task 3, and Plan A Task 4).
  - §4: claim and who resolved (Task 3); the grant's lock and conditions (Task 5); a refusal closes nothing (Tasks 4 and 5); hand-off rules and `person:<cardId>:0` (Task 4); cap and titles (Task 4); bounded inert text under the operator heading (Task 3, and Plan A Task 7); authorisation (Task 6); compatibility (D11).
  - H4: per version, blocking, merging, notes, Simple mode and Home, one-click, sidebar (Tasks 8 and 9).
  - §5 unit, integration, web and end to end (Tasks 1–10).
  - Gates: m56a counts (Task 8).
  - The spec's "a concrete path or the package's own registration directory" is read as: a concrete path only, with a shared registration directory kept file-per-package by `registrationProblems` (D5). See the report's ambiguity list.
- **Placeholder scan.** Two stubs are deliberate and named: `decideOther` (Task 3, replaced in Task 4) and `giveFile` (Task 4, replaced in Task 5). Task 10 Step 4 greps for them. The test seed helpers that live in existing files are named by the grep that finds them.
- **Type consistency.**
  - `CardDecision`'s field names (`target`, `request`, `path`, `toPackage`, `title`, `text`, `reason`, `body`) are the same in the schema, `decideCard`, the route, `CardDecisions` and the tests.
  - `ClaimInput.close` is `{ reason, note } | null` everywhere.
  - `QuestionCard.offers`, `.packages` and `.askerRunId` match Plan A's interface plus Task 3's additions.
  - `writeGoalDecisionIn`'s `decision` field (the text) is used by both callers.
  - `personHandOffSourceKey` and `routeStoredPersonHandOffs` are named the same in Task 4 and its test.
- **Review Focus.** The two-person race (Task 3 test "a card taken first"). The manifest grant refused (Tasks 2 and 5). The glob owner and the integration package (Task 2). A title in another case (Task 4). A `write_answer` with markers and NUL (Task 3). Queue order and merge (Task 9).
