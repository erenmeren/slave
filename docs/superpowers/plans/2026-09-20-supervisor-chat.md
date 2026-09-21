# Supervisor Chat (F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person types to the Supervisor and gets an answer within one model call, with any actions the message implies applied or proposed per E's autonomy switch; the project chooses which provider and model answer; files and images attached to a message land in the project repository where every worker can read them.

**Architecture:** A `SupervisorMessage` table and a detached per-message model turn (the intake's claim/detach/drain shape); a pure chat prompt and reply parser in the domain; actions from a reply recorded as `SupervisorDecision`s with the new `operator_request` situation and carried out by the existing `carryOut`; two project settings (`supervisorProvider`, `supervisorModel`) and a decider registry with a new Cursor one-shot call; an upload route that commits into `docs/inbox/`; a read-only tool mode for Claude one-shot calls so an attached image can be looked at; the panel's composer, attach flow, header selects and reply rendering.

**Tech Stack:** TypeScript, Prisma + Postgres, zod, vitest, Next.js route handlers (`request.formData()` is native), the fake Claude CLI (`packages/providers/test/fake-claude.mjs`), a new fake Cursor CLI for one-shot calls.

**Spec:** `docs/superpowers/specs/2026-09-20-supervisor-chat-design.md` — read first; tasks cite R1–R9. **Depends on E** (`docs/superpowers/specs/2026-09-20-self-running-project-design.md`) being merged: this branch starts from main after E lands and uses E's `tierOf` autonomy rule and `actionSchema`.

## Global Constraints

- Never write the word "agent" (any case, as a word) in tracked source, tests, README or `docs/ia.md` (`scripts/gate-m26-vocabulary.mjs`); the only tolerated occurrences are the existing `cursor-agent` / `fake-cursor-agent` binary names. Say "worker", "persona", "Supervisor".
- No prettier; match style (2-space, single quotes, no semicolons, trailing commas).
- Reply envelope exactly `{"supervisorReply": {"text": "...", "actions": [...], "sources": [...]}}`; marker `"supervisorReply"`.
- Message roles `human | supervisor`; statuses `sent | answering | answered | failed`; unique `[workspaceId, seq]`.
- Uploads: at most 5 files per request, 20 MB each; allow-list `md txt csv json yaml yml pdf png jpg jpeg gif webp svg`; path `docs/inbox/<yyyy-mm-dd>-<slug>.<ext>` relative to the repository root, on the base branch, one commit per upload request `inbox: <names>` with `ORCHESTRATOR_GIT_IDENTITY`; a path that resolves outside `docs/inbox/` is refused.
- Chat prompt inlines text attachments up to 20,000 characters each and 60,000 in total; images/binaries by path and size only.
- Read-only tool mode for `decideWithModel`: `--tools Read,Glob,Grep`, `cwd` = repository, the run gate (`scripts/pause-gate.sh`) registered with a permissions file granting `read_repo` only; text-only turns keep `--tools ''` and the deny-all hook.
- Cursor one-shot: `cursor-agent --print --output-format stream-json --model <m> <prompt>` with the Cursor gate and an all-deny permissions file; cost from the result line when present, else `costUsd: null`.
- New situation kind `operator_request`; new action kinds `request_goal_change { request }` and `note_for_planner { text }`.
- ONE vitest process at a time; `set -a; . ./.env; set +a`; `npx tsc --build` before orchestrator/web tests. Commit per task with `git -c core.hooksPath=/dev/null commit`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Schema — the conversation table and two settings (R1, R4)

**Files:** `packages/db/prisma/schema.prisma`; `packages/db/prisma/migrations/<next stamp>_supervisor_chat/migration.sql`.

Add enums `SupervisorMessageRole { human supervisor }`, `SupervisorMessageStatus { sent answering answered failed }`; model:
```prisma
model SupervisorMessage {
  id            String                  @id @default(uuid())
  workspaceId   String
  seq           Int
  role          SupervisorMessageRole
  status        SupervisorMessageStatus @default(sent)
  text          String
  /// R6: `{ path, name, bytes, kind: 'text' | 'image' | 'binary' }[]`, paths relative to the repository root.
  attachments   Json                    @default("[]")
  /// R3: the actions the reply proposed, each `{ action, decisionId, tier }`; null on a human row.
  actions       Json?
  modelCostUsd  Float?
  unmeasured    Boolean                 @default(false)
  claimedAt     DateTime?
  claimedBy     String?
  failureReason String?
  createdAt     DateTime                @default(now())
  workspace     Workspace               @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@unique([workspaceId, seq])
  @@index([workspaceId, status])
}
```
`Workspace` gains `supervisorProvider ProviderKind?` and `supervisorModel String?` (+ `supervisorMessages SupervisorMessage[]`). Migration hand-written (comment block; `CREATE TYPE` × 2, `CREATE TABLE`, unique index, index, two `ALTER TABLE "Workspace" ADD COLUMN`). Steps: `db:migrate:test`, `db:generate`, `tsc --build`, one control test as a smoke. Commit `feat(db): SupervisorMessage; supervisorProvider/supervisorModel`.

---

### Task 2: Domain — chat prompt, reply parser, two actions, one situation (R2, R3)

**Files:** create `packages/domain/src/supervisor/chatPrompt.ts`; modify `actions.ts` (kinds + `actionSchema` + `ACTION_KINDS`), `situations.ts` (`operator_request`), `sourced.ts` (`feed` and `attachment` source kinds in `verifySources`: `feed` resolves a sentence by its event seq, `attachment` by path over the inlined texts), `index.ts`; tests `packages/domain/test/supervisor/chatPrompt.test.ts`, `candidates.test.ts` (actionSchema round-trip), `sourced.test.ts`.

**Interfaces:**
```ts
export const SUPERVISOR_CHAT_MARKER = '"supervisorReply"'
export const CHAT_HISTORY_MAX = 12
export const CHAT_FEED_MAX = 20
export const CHAT_ATTACHMENT_CHARS = 20_000
export const CHAT_ATTACHMENTS_TOTAL_CHARS = 60_000
export interface ChatAttachment { readonly path: string; readonly name: string; readonly bytes: number; readonly kind: 'text' | 'image' | 'binary'; readonly text?: string }
export interface ChatTurnInput {
  readonly world: SupervisorWorld            // goal, tasks, slaves, questions, decisions, halted, autonomy
  readonly profile: string | null
  readonly feed: readonly { readonly seq: number; readonly sentence: string }[]
  readonly needsYou: readonly string[]
  readonly history: readonly { readonly role: 'human' | 'supervisor'; readonly text: string }[]
  readonly message: string
  readonly attachments: readonly ChatAttachment[]
  readonly imagesReadable: boolean            // R7: true when the call runs read-only tools
}
export function buildSupervisorChatPrompt(input: ChatTurnInput): string
export interface ParsedReply { readonly text: string; readonly actions: readonly Action[]; readonly dropped: readonly string[]; readonly sources: readonly SourceCitation[] }
export function parseSupervisorReply(text: string, world: SupervisorWorld): ParsedReply | null
```
Prompt sections in order: PROFILE, WORKSPACE (as `buildDecisionPrompt`), BOARD (one line per task: `key/title — status — who — since`), NEEDS YOU, RECENT (feed sentences, newest last, each prefixed `[seq]`), ATTACHMENTS (text inlined under `--- <path> ---`, others as `<path> (<kind>, <bytes> bytes)` plus "workers can read these by path" and, when `imagesReadable`, "you may open an image with Read"), CONVERSATION (history + the new message as `PERSON:`), then the ACTION VOCABULARY (each `ActionKind` with its JSON shape, generated from a table in this file) and the instruction: answer the person in `text`; put an action in `actions` only when the person asked for a change; cite sources; reply with one JSON object and nothing else. Whole prompt through `neutraliseMarkers`. Parser: `firstJsonObject`, envelope schema, each action through `actionSchema` (invalid → `dropped`), a `taskId`/`slaveId`/`messageId` that is not in the world → `dropped` with the reason, sources kept raw for control to verify. Tests: every section present once; the marker; inlining caps; the history cap; parse happy path; dropped invalid/unknown; `null` on no JSON.

---

### Task 3: Providers — read-only mode and the Cursor one-shot call (R5, R7)

**Files:** modify `packages/providers/src/claude/decision.ts` (`ModelDecisionInput.tools?: 'none' | 'read-only'`, `cwd?`, `permissionsFilePath?`; `read-only` → `--tools Read,Glob,Grep`, `cwd`, settings hook = `hookPath` (the caller passes the run gate) and env `SLAVEOFAI_PERMISSIONS_FILE`); create `packages/providers/src/cursor/decision.ts` (`decideWithCursor(input: CursorDecisionInput): Promise<ModelOutcome>` — spawn `command` with `[...extraArgs, '--print', '--output-format', 'stream-json', '--model', model, prompt]`, env stripped like Claude's plus `SLAVEOFAI_PERMISSIONS_FILE` → an all-deny file the call writes, the Cursor gate registered the way runs register it (read `packages/providers/src/cursor/adapter.ts` `start` for the hook wiring and copy it), timeout, outcome from the terminal `result` line: `text` = the assistant text, `costUsd` = its cost field or `null`, `isolation_breach` when any tool call line appears); create `packages/providers/test/fake-cursor-print.mjs` (a Node script: prints an init line, an assistant text line whose content is `JSON.stringify({ supervisorReply: { text: 'from cursor', actions: [], sources: [] } })`, a result line; `--fixture breach` adds a tool_call line first); export from the providers barrel; tests `packages/providers/test/claude-decision.test.ts` (read-only mode passes the tool flags and the env; `env-echo` fixture) and `packages/providers/test/cursor-decision.test.ts` (answer, breach, no result → failure, timeout).

**Spike first (R5):** run the real binary once: `cursor-agent --print --output-format stream-json --model auto "Reply with the single word OK"` with a 60 s timeout, record the exact output lines (shape, cost field name) in the spec's §4 errata as E1, and align `decideWithCursor`'s parser to it. If the binary refuses print mode, implement the parser against the flags `cursorFlags` already uses and add the erratum saying the live check failed and why.

---

### Task 4: Control — messages, the tick, settings, uploads (R1, R2, R3, R4, R6)

**Files:** create `packages/control/src/supervisorChat.ts` (`sendSupervisorMessage(workspaceId, { text, attachments }, principal)` → writes the human row + the `answering` placeholder in one transaction, returns both ids; `claimSupervisorTurns({ now, by, limit })` (`FOR UPDATE SKIP LOCKED` over `answering` rows whose `claimedAt` is null or older than `SUPERVISOR_CHAT_CLAIM_TTL_MS = 5 min`); `recordSupervisorReply(messageId, outcome)` where outcome is `{ kind: 'answered', text, actions: readonly { action, decisionId, tier }[], costUsd, unmeasured }` or `{ kind: 'failed', reason, costUsd, unmeasured }`; `listSupervisorMessages(workspaceId, { limit })`; `conversationCost(workspaceId)`), `packages/control/src/supervisorChatTick.ts` (`tickSupervisorChat({ now, by, deciders: DeciderRegistry, defaultModel, maxConcurrentModelCalls })` — the intake tick's shape: claim, build the turn input (world via `loadSupervisorWorld`, feed via the happening sentences — move `happeningSentence` into `packages/control/src/feed.ts` if it lives only in the web today, needs-you summaries, history, attachments' text read from the repository with the caps), choose the decider by `workspace.supervisorProvider ?? 'claude_code'` and the model by `workspace.supervisorModel ?? defaultModel`, `tools: 'read-only'` when an image is attached and provider is `claude_code`, start detached, on settle: parse, verify sources, for each action `recordDecision({ situation: { kind: 'operator_request', subjectId: messageId, summary, facts }, candidates: [that action], chosenIndex: 0, decidedBy: 'model', tier: tierOf(...) })` then `applyDecision(id, 'system')` when the tier is `applied`, then `recordSupervisorReply`; `drainSupervisorChatCalls()`; `inFlightSupervisorChat()`), `packages/control/src/supervisorUploads.ts` (`storeSupervisorUploads(workspaceId, files: readonly { name, bytes: Buffer }[], principal)` → validates count/size/extension, slugs names, writes to `<repoPath>/docs/inbox/<date>-<slug>.<ext>` (refuses if the resolved path escapes `docs/inbox/`), `git add` + one commit with `ORCHESTRATOR_GIT_IDENTITY` via `gitIn`, returns the attachment list; kind by extension); modify `packages/control/src/supervisor.ts` (`setSupervisorSettings({ provider?, model? })` with `workspace.settings_changed` fields `supervisorProvider`/`supervisorModel`; `carryOut` cases `request_goal_change` → `requestChange(workspaceId, action.request, principal, { origin })` and `note_for_planner` → append a dated line to `docs/inbox/NOTES.md` and commit), `packages/control/src/index.ts`. Tests: `packages/control/test/integration/supervisor-chat.test.ts` (send → two rows; claim; record answered with two actions → two decisions, one applied under `act`, one proposed under `propose`; record failed; tick with a scripted decider end to end incl. provider choice; drain), `supervisor-uploads.test.ts` (a temp repo: two files land and are committed, allow-list, size cap, count cap, path escape refused, `kind` per extension), `supervisor.test.ts` (settings fields; the two new carryOut cases).

---

### Task 5: Orchestrator — the registry, the daemon pass, the CLI (R2, R4, R5, R8)

**Files:** modify `apps/orchestrator/src/cli.ts` (`buildModelDecider()` becomes `buildDeciderRegistry(): DeciderRegistry` = `{ claude_code: (input) => decideWithModel({...claudeCommand(), hookPath: input.tools === 'read-only' ? hookPath() : denyAllHookPath(), ...input}), cursor: (input) => decideWithCursor({...cursorCommand(), gatePath: cursorGatePath(), ...input}) }`; existing callers (`daemon`, `supervise`, `capabilities map`) take `registry.claude_code` for the default — keep `ModelDecider` as the per-provider type; verbs `supervisor-say --workspace <id> --text <t> [--file <path>...]` (stores uploads from local paths then sends) and `supervisor-thread --workspace <id>` (prints the last 30 messages as JSON)), `apps/orchestrator/src/daemon.ts` (`tickSupervisorChat` after `tickIntakes`, print `{ supervisorChat }` when a call started or `skippedNoDecider`; `drainSupervisorChatCalls()` at shutdown beside the other drains), `packages/providers/test/fake-claude.mjs` (a `"supervisorReply"` arm: answers `{ supervisorReply: { text: 'On it.', actions: <from --chat-actions-json-base64 argv, default []>, sources: [] } }`). Tests: `apps/orchestrator/test/integration/supervisor-chat.test.ts` (the daemon answers a message end to end with the fake CLI; an action applied under `act`; proposed under `propose`), `cli.test.ts` (the two verbs), `daemon.test.ts` (the printed line and the drain).

---

### Task 6: Web — routes (R2, R4, R6)

**Files:** create `apps/web/src/app/api/w/[workspaceId]/supervisor/messages/route.ts` (GET list; POST `{ text, attachments }` → `sendSupervisorMessage`; `requirePrincipal`, `archivedRefusal`, `bodySchema`), `.../supervisor/uploads/route.ts` (POST multipart via `await request.formData()`; each `File` → `{ name, bytes: Buffer.from(await file.arrayBuffer()) }` → `storeSupervisorUploads`; 413 on size, 415 on type, 400 on count), modify `.../supervisor/settings/route.ts` (PATCH accepts `provider`, `model`), `apps/web/src/server/supervisorThreads.ts` (merge `SupervisorMessage` rows into the day buckets: human → `who: 'operator'`, supervisor → `who: 'supervisor'`, `status`, `attachments`, `actions` (with decision ids for the cards), `costUsd`), `apps/web/src/server/supervisor.ts` (`settings.provider`, `settings.model`, `conversationCostUsd`). Tests: route tests for messages (POST + GET), uploads (multipart with a small md and a png; refusals), settings; `apps/web/test/integration/supervisor-threads.test.ts` (rows merged in order with status).

---

### Task 7: Web — the panel (R8)

**Files:** modify `apps/web/src/components/supervisor/SupervisorThreadPanel.tsx` (composer POSTs to `/supervisor/messages`; attach button + hidden file input + drop zone `data-testid="supervisor-attach"`, uploads first then sends with the returned attachments; chips on messages; "thinking…" row for `answering`; `failed` row with the reason; sourced chip; `DecisionCard`s under a reply from `actions`; header: `ProviderSelect` + `ModelSelect` (`data-testid="supervisor-provider"`, `supervisor-model`) PATCHing settings; a "cost so far" line), `apps/web/src/components/ProviderSelect.tsx` (a `disabledKinds` prop so Cursor can be shown disabled with a title when Task 3's spike recorded that print mode is unavailable), `docs/ia.md`. Tests: `apps/web/test/supervisor-thread-panel.test.tsx` (send posts; thinking; attach flow with a stubbed upload; selects PATCH; cards under a reply; cost line). Then `npm run web:build`.

---

### Task 8: Gate, docs, ladder

**Files:** `scripts/gate-m39-supervisor-mailbox.mjs` Stage 6 "a message with a brief becomes a goal": through the real daemon with the fake CLI, `supervisor-say --file <brief.md> --text "use this brief for the plan"`, the fake's chat arm answering with `request_goal_change` (via `--chat-actions-json-base64`), autonomy `act` → the goal's newest version contains the brief's path and the message row is `answered`; README (the conversation, the two verbs, provider/model, uploads); the spec's §4 errata; the full ladder (`npm run typecheck && npx vitest run && npm run web:build`, no daemon on the host).

---

## Self-review

**Spec coverage.** R1 → T1, T6. R2 → T2, T4, T5. R3 → T2 (kinds, situation), T4 (record + apply), T6/T7 (cards). R4 → T1, T4, T5 (registry), T6, T7. R5 → T3 (spike + call + fake), T5, T7 (disabled option). R6 → T4 (store + commit), T6 (route), T7 (attach). R7 → T3 (read-only), T4 (chosen per turn). R8 → T5 (verbs), T7. R9 → no task touches decisions/answers/planning/dispatch beyond the two carryOut cases; T8's ladder.

**Placeholders.** Each task names its files, interfaces, rules and the assertions its tests make; the TDD cycle (failing tests → RED → implement → GREEN → commit) applies to every task as E's plan spells it out.

**Type consistency.** `ChatAttachment` (T2) is what T4 builds from `storeSupervisorUploads` and what the message row stores; `ParsedReply.actions` (T2) are `Action`s that T4 records through `recordDecision` and `carryOut` (E's switch) executes; `DeciderRegistry` (T4 type, T5 builder) keys are `ProviderKind`; the `"supervisorReply"` marker (T2) is what T5's fake arm keys on; `settings.provider/model` (T6) are what T7's selects bind to.
