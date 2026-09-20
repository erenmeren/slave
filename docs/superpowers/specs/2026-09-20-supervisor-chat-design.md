# F — Talking to the Supervisor: a conversation, a chosen model, and files

The third piece the 2026-09-20 brainstorm ordered after A (catalogue capability mapping, merged
`6f871afe`) and E (the self-running project, `docs/superpowers/specs/2026-09-20-self-running-project-design.md`).
It turns the Supervisor panel's composer — today a goal-change form — into a conversation with the
Supervisor, lets the person choose which provider and model answer it, and lets them hand the
Supervisor files and images that the project's workers can then read. Designed 2026-09-20 with
the user, who took three decisions:

1. **a real conversation** (option b): the person asks, the Supervisor answers from what it knows,
   and changes the goal or the board only when asked to;
2. what the Supervisor may DO from the conversation follows **E's autonomy switch**: "her şeyi
   onayla" on means the actions it proposes are applied, off means they wait in the needs-you bar;
3. **provider and model are chosen per project**, in the conversation's header, and **files and
   images can be attached** to a message.

**Why now.** The person running a project has no way to ask "why is nothing running?", "what did
the research find?", or "add a pricing page" without either reading the feed or rewriting the
goal. The composer's one verb, a goal request, re-plans the whole board for a question that
wanted an answer. And a brief, a screenshot of the current site, or a competitor's PDF have no way
into the project except by hand-copying them into the repository.

**Goal.** A message typed into the panel is answered within one model call: a question gets an
answer with its sources; an instruction gets an answer and the actions it implies, applied or
proposed per E's switch; an attached file lands in the project repository where the planner and
every worker can read it, and is cited by path in the goal when the person asks for it to shape
the plan.

**Facts the design stands on** (read out of the tree on 2026-09-20; lines as of `b323674a`).
The composer (`apps/web/src/components/supervisor/SupervisorThreadPanel.tsx:384-429`) POSTs
`{ request }` to `/api/w/:id/goal/request` (`route.ts:24-52`) → `requestChange`
(`packages/control/src/goal.ts:81-96`) → `writeGoalVersion` → `workspace.goal_set` with `request`
in the payload → the M40 re-plan on the next tick. The thread view (`apps/web/src/server/supervisorThreads.ts:38-131`)
is built from six event families and attributes a row to the operator only when it is a
`workspace.goal_set` carrying `request`. The Supervisor's decision call (`apps/orchestrator/src/supervisor.ts:518-545`,
`askTheModel`) builds `buildDecisionPrompt` (`packages/domain/src/supervisor/prompt.ts:43-81`) and
calls the injected `ModelDecider` with `SUPERVISOR_PER_CALL_CAP_USD = 1`; the answer-a-question path
(`answerPrompt.ts:190-233`) expects `{"answer","sources":[{kind,ref,quote}],"critical"}` and
`verifySources` (`sourced.ts:100-123`) rejects quotes not found in the named source. The one-shot
call itself is `decideWithModel` (`packages/providers/src/claude/decision.ts:132-226`): `claude -p
--restricted --strict-mcp-config --tools '' --no-session-persistence --output-format stream-json
--model <m> --max-budget-usd <n> --settings <deny-all hook>`, the prompt on stdin, env stripped to
`PATH HOME LANG TERM`, 120 s timeout. There is no Cursor one-shot call; Cursor has a run adapter
(`packages/providers/src/cursor/adapter.ts:126`), positional prompt delivery, a live model list
(`listCursorModels`, `packages/providers/src/models.ts`) and a gate script (`cursorGatePath`).
Claude's model table is `CLAUDE_CODE_MODELS` (`packages/domain/src/provider/claude-code.ts:18-30`);
`SUPERVISOR_DEFAULT_MODEL = 'claude-sonnet-5'`; the web has `ModelSelect`/`ProviderSelect`
(`apps/web/src/components/ModelOverrideEditor.tsx`, `ProviderSelect.tsx`). Nothing in the repo
passes an image to a model; there is no upload route; `initRepository` (`packages/control/src/intake.ts:500-547`)
is the precedent for writing a file into the project repository and committing it with the
orchestrator's identity (`git -C <repo> -c user.name=… commit`). `IntakeMessage`
(`schema.prisma:1746-1762`: `id, intakeId, seq, role, text, facts, createdAt`, unique `[intakeId, seq]`)
and `tickIntakes` (`packages/control/src/intakeTick.ts`: claim under `SKIP LOCKED`, detached call,
drain at shutdown) are the precedents for a conversation table and its tick. The needs-you bar
(`apps/web/src/server/needsYou.ts:27`) lists `decision` items and the panel's `DecisionCard`
approves/rejects through `/supervisor/decisions/:id/approve|reject`. `Memory` (`schema.prisma:1468-1497`)
is written by `recordMemory` from `promotionFor` kinds (`run_succeeded, verify_passed,
decision_resolved, goal_changed, work_rejected`). E adds `Workspace.supervisorAutonomy` and applies
actions through `tierOf`/`carryOut`; E's `retry_task`, `retry_review`, `clear_halt` join the 18
action kinds.

## 1. Rulings

**R1 — The conversation is a table, not an event replay.** New model `SupervisorMessage { id,
workspaceId, seq, role: SupervisorMessageRole (human | supervisor), text, attachments Json
(readonly { path, name, bytes, kind: 'text' | 'image' | 'binary' }[]), actions Json?
(the actions the reply proposed, each with its decisionId), modelCostUsd Float?, unmeasured
Boolean, status: SupervisorMessageStatus (sent | answering | answered | failed), failureReason?,
createdAt }`, unique `[workspaceId, seq]`. The thread view (`supervisorThreads.ts`) merges these
rows with the six event families it shows today, ordered by time, so decisions still appear beside
the messages that caused them; a human row is `who: 'operator'`, a supervisor row `who: 'supervisor'`.
**Why:** a conversation has turns with status and cost; events have neither. **Cost if wrong:** a
table.

**R2 — One turn is one detached model call with the intake's discipline.** `POST /api/w/:id/supervisor/messages
{ text, attachmentPaths }` writes a `human` row with `status: sent` and a `supervisor` row with
`status: answering` (the reply placeholder, so the panel shows "thinking"). The daemon's global pass
gains `tickSupervisorChat` beside `tickIntakes`: it claims `answering` rows under `SKIP LOCKED`,
starts at most `maxConcurrentModelCalls` detached calls, records the answer (or `failed` with the
reason) when the call settles, and is drained at shutdown. A turn never blocks the pass. The prompt
(`buildSupervisorChatPrompt`, pure, in `packages/domain/src/supervisor/chatPrompt.ts`) renders: the
Supervisor profile; the workspace facts `buildDecisionPrompt` renders; a **board digest** (per task:
key, title, status, who, since); the **needs-you list**; the **last 20 feed sentences**; the
**attachments' text** (R6); the **last 12 messages** of the conversation; and the instruction to
answer with exactly one JSON object:
`{"supervisorReply": {"text": "...", "actions": [<Action>...], "sources": [{"kind": "task"|"goal"|"feed"|"message"|"attachment", "ref": "...", "quote": "..."}]}}`.
`actions` are validated with `actionSchema` and against the world (a `taskId` that is not on the
board drops the action and the reply says so in a trailing sentence); `sources` are verified with
`verifySources` extended with `feed` and `attachment` kinds; a reply whose text quotes nothing is
still delivered (this is a conversation, not a sourced answer to a worker), but the panel marks
sourced replies with the same "sourced" chip the answer path uses. **Why:** the intake proved the
shape; the pass stays fast; a person sees the reply arrive. **Cost if wrong:** one more tick.

**R3 — What a reply may do.** Each action in a reply becomes a `SupervisorDecision` recorded with
`situationKind: 'operator_request'` (new kind, subject = the message id), candidates = that one
action, and its tier from `tierOf` under E's switch: `act` → applied through `applyDecision` in the
same settlement, `propose` → proposed, shown as a decision card under the reply and in the needs-you
bar. Two actions join the catalogue for this: `request_goal_change { request }` → `requestChange`
(what the composer did directly until now) and `note_for_planner { text }` → appends a dated line to
`docs/inbox/NOTES.md` in the repository and commits it (a way to hand context to the next planner
without changing the goal). A reply with no actions is just an answer. **Why:** decision 2 — the
conversation gets no authority of its own; it borrows the Supervisor's, gated by the switch that
already exists. **Cost if wrong:** two action kinds and one situation kind.

**R4 — Provider and model are project settings.** `Workspace.supervisorProvider ProviderKind?`
and `Workspace.supervisorModel String?` (null = the installation default: `SLAVEOFAI_SUPERVISOR_MODEL`
or `SUPERVISOR_DEFAULT_MODEL`, provider `claude_code`). `setSupervisorSettings` gains
`provider?`/`model?`; the panel's header shows a `ProviderSelect` + `ModelSelect` (the existing
components) bound to them; every Supervisor call for the workspace — decisions, answers, chat —
uses them. The daemon's decider becomes a **registry** `{ claude_code: decideWithModel, cursor:
decideWithCursor }` chosen per call by the workspace's provider. **Why:** decision 3. **Cost if
wrong:** two nullable columns.

**R5 — A Cursor one-shot call exists, or the option says why not.** `decideWithCursor`
(`packages/providers/src/cursor/decision.ts`) mirrors `decideWithModel`: the Cursor binary from the
manifest, non-interactive print mode, `--model`, `--output-format` JSON, the prompt delivered the
way the manifest says (`positional`), the Cursor gate script registered so every tool is denied,
the same env stripping and timeout, and an outcome parsed into `ModelOutcome` with the cost the
CLI reports (or `costUsd: null` and `unmeasured` when it reports none — the intake's honesty rule).
The plan's first Cursor task is a **spike**: run the real `cursor-agent` once in print mode with a
trivial prompt and record the flags and output shape in the spec's errata; if the binary has no
non-interactive mode, `ProviderSelect` renders the Cursor option disabled with "one-shot calls are
not available for Cursor yet" and R4's registry has one entry. **Why:** the user asked for the
choice; the repository cannot promise what the vendor CLI does not do. **Cost if wrong:** a spike.

**R6 — Attachments live in the repository.** `POST /api/w/:id/supervisor/uploads` (multipart, up
to 5 files, 20 MB each, allow-list: `md txt csv json yaml pdf png jpg jpeg gif webp svg`) writes
each file to `<repoPath>/docs/inbox/<yyyy-mm-dd>-<slug>.<ext>` on the base branch and commits it
("inbox: <name>", the orchestrator identity, the `initRepository` precedent), and returns `{ path,
name, bytes, kind }`; the message row stores that list. The chat prompt inlines `text` attachments
(md, txt, csv, json, yaml) up to 20k characters each and 60k in total (the review-diff limits),
names `image`/`binary` attachments by path and size, and tells the model that workers can read
them by path. A reply that says the plan should use them carries `request_goal_change` with the
paths in the request, and the planner prompt's repository section already lists `docs/`. PDFs are
`binary` in the chat and readable by workers whose provider can read them. **Why:** the
repository is the one place every worker already reads, and a commit is a record. **Cost if
wrong:** files in `docs/inbox/`.

**R7 — The Supervisor may look at an image when it is asked to.** A chat turn whose message
carries an `image` attachment, on `claude_code`, runs the model call in **read-only tool mode**:
`decideWithModel` gains `tools: 'none' | 'read-only'`; `read-only` spawns with `--tools Read,Glob,Grep`,
`cwd` = the repository, and the run gate registered with a permissions file granting `read_repo`
only (the existing gate, the existing file format, `runKind: 'planning'`'s baseline), so the model
can open the image by path and nothing else. Text-only turns keep `tools: 'none'`. Cursor turns are
always `none` (its gate denies all) and the reply says the image was not looked at. **Why:** a
screenshot the person attached deserves an answer about the screenshot. **Cost if wrong:** a
second spawn configuration and a permissions file per turn.

**R8 — Surfaces.** The panel: the composer sends to `/supervisor/messages` (Enter), an attach
button and drop zone (`data-testid="supervisor-attach"`), chips for attachments on a message,
"thinking" on an `answering` row, the reply text with a sourced chip, decision cards under a reply
that proposed actions, the provider/model selects in the header beside E's autonomy switch, and a
"cost so far" line for the conversation. The needs-you bar's `decision` items already cover
proposed actions. The Home feed gains nothing (a conversation is not a happening). CLI:
`supervisor-say --workspace <id> --text <t> [--file <path>...]` and `supervisor-thread --workspace <id>`
for the daemon-less path and the gates. **Why:** the panel is the product surface the user named.

**R9 — Nothing else moves.** Decisions, answers to workers, planning, dispatch, review, merge, the
breaker and the budget are unchanged; the goal request route stays for the CLI and for compatibility
(the panel stops calling it). New event types: none (`supervisor.decided/applied/proposed/failed`
and `workspace.goal_set` carry the conversation's consequences). New tables: `SupervisorMessage`.
New columns: `Workspace.supervisorProvider`, `Workspace.supervisorModel`.

## 2. Tests

- Domain: the chat prompt names every section and the marker; the reply parser (envelope, actions
  validated with `actionSchema`, dropped actions reported, sources verified incl. `feed`/`attachment`);
  the two new action kinds round-trip.
- Control: message verbs (send, claim, record answer, record failure); the tick (one call per
  waiting row, detached, drained; `skippedNoDecider`); uploads (path shape, allow-list, size cap,
  commit made, refusal on a path outside `docs/inbox/`); settings (`provider`/`model`, event fields).
- Providers: `decideWithCursor` against a fake Cursor binary (the `fake-cursor-agent` precedent);
  `decideWithModel` read-only mode registers the gate and passes `--tools Read,Glob,Grep`.
- Orchestrator: the daemon answers a message end to end with the fake CLI (`"supervisorReply"`
  marker arm), applies an action under `act`, proposes it under `propose`; the CLI verbs.
- Web: composer posts a message; thinking row; attach flow with a stubbed upload; provider/model
  selects PATCH; decision cards under a reply.
- Gate: `gate:m39-supervisor-mailbox` (or a new `gate:m62-supervisor-chat`) gains a stage: a message
  with an attached markdown brief ends with a `request_goal_change` applied and the brief's path in
  the goal.

## 3. Out of scope

Voice, threads/branches of conversation, editing past messages, per-message model choice (the
project setting is the choice), memory promotion of chat turns (a `chat_turn` promotion kind is a
follow-up), and reading images on Cursor.

## 4. Errata

**E1 — Cursor's print mode works, and it reports no cost (R5, measured 2026-09-20).** The spike ran
the installed binary once: `cursor-agent --print --output-format stream-json --trust --force --model
auto "Reply with the single word OK"`. It answered in 5.3 s and its seven stdout lines are recorded
verbatim at `.superpowers/sdd/2026-09-20-supervisor-chat/cursor-print-spike.jsonl`. **So Cursor stays
selectable**: `ProviderSelect` needs no disabled option and R4's registry has both entries.

What the run established, each of which `decideWithCursor` is written against:

- **The line shapes.** `{"type":"system","subtype":"init",...,"session_id":...,"model":"Auto
  Balance"}`; `{"type":"user",...}` (the prompt echoed back); three `{"type":"thinking","subtype":
  "delta"|"completed",...}` lines; `{"type":"assistant","message":{"role":"assistant","content":
  [{"type":"text","text":...}]}}`; and the terminal `{"type":"result","subtype":"success",
  "duration_ms":5327,"is_error":false,"result":"<the same text>","session_id":...,"request_id":...,
  "usage":{"inputTokens":20948,"outputTokens":83,"cacheReadTokens":2304,"cacheWriteTokens":0}}`.
  `parseCursorLine` already reads every one of them, so the decision call reuses it unchanged.
- **There is NO cost field, under any name.** Not `total_cost_usd`, not `cost`, not a nested one:
  the result line carries `usage` and nothing else about spend. A `usage` object is not a price, so
  `costUsd` is `null` and a Cursor turn is `unmeasured` — the intake's honesty rule, not a
  degradation. `tokens` ARE read (billed input = `inputTokens + cacheReadTokens + cacheWriteTokens`).
- **`--trust --force` are mandatory and their absence is invisible.** Without them the CLI writes
  NOTHING to stdout and a "Workspace Trust Required" block to stderr, which reaches a caller as "the
  process ended without a result line" — a runtime fault rather than a missing flag. They are what
  `cursorFlags()` already emits for runs, so `decideWithCursor` reuses that function rather than
  respelling the list.
- **The assistant text opens with a vendor preface line.** The measured text is
  `"> Auto routed to Cursor Grok 4.6\n\nOK"`: the model requested was `auto` and the routed model is
  announced in the answer's own first line. Nothing may assert on that wording — it is the vendor's
  and it changes with the routing — and nothing needs to: `parseSupervisorReply` reads the FIRST
  JSON object in the text, so an envelope behind a preface is still an envelope.
  `test/fake-cursor-print.mjs --fixture preface` reproduces it so that stays true.
- **`--model auto` is accepted** and the init line reports the pool it routed into (`Auto Balance`),
  not the model asked for. Wherever a resolved (provider, model) pair is shown, that is the pair
  this runtime can be held to.

Not measured, and deliberately not guessed at: whether a denied tool call in print mode produces the
same `tool_call`/`completed` lines a run does (the decision call's gate denies everything, and a tool
call of ANY shape in this stream is already an `isolation_breach`), and what a failed print-mode call
(`is_error: true`) puts in `result`.
