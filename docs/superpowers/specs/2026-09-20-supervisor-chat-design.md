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

**E2 — Two things R5 and R7 do NOT buy, said out loud (task 3 review, 2026-09-20).**

1. **`read_repo` is a grant by KIND, not by path.** The permissions file the read-only turn is
   armed with governs which TOOLS may be called (`scripts/lib/permissions.sh` resolves a tool to a
   `PermissionKind` and asks whether that kind is granted); it has no notion of a path. So a turn
   granted `read_repo` may `Read` **any file the daemon's own user can read**, not only the image
   the person attached and not only files under `cwd`. What narrows it is the prompt and the cwd,
   which are guidance, not a boundary. The boundary that would hold — a separate uid or a sandbox —
   is the one M52 already recorded as unbuilt (`scripts/lib/permissions.sh`, "what this file does
   not protect against"). R7's "so the model can open the image by path and nothing else" is
   therefore an intent, not an enforcement, and anything that repeats that sentence should say so.
2. **A Cursor turn can be neither capped nor costed.** `cursor-agent` has no `--max-budget-usd`
   equivalent, so `decideWithCursor` spawns with no spend cap at all, and its `result` line reports
   no cost, so nothing can be billed to the workspace afterwards either. The only limits on a
   Cursor turn are the timeout and the vendor account's own. A project switched to `cursor` in R4's
   provider setting therefore drops out of the budget guardrail for its Supervisor turns: the
   conversation's "cost so far" (R8) counts nothing, and `unmeasured` on the message row is the
   only honest thing the panel can show.

**E3 — A decision from a reply is keyed by the message AND the action (R3, task 4).** The subject
is `<messageId>:<actionKind>`, not the bare message id. `recordDecision` treats
`(workspaceId, situationKind, subjectId)` as a KEY — an open row on it refuses a second, and a
resolved one cools the key for `COOLDOWN_MS` — so with the bare id a reply that asked for two
things would record the first and have the second refused `supervisor_cooldown`: one of the two
things the person asked for would silently not happen. The ways back to the turn are
`situation.facts.messageId`, which carries the id exactly, and `SupervisorMessage.actions[].decisionId`,
which is how the panel finds a reply's cards rather than by reconstructing this key. Two actions of
the SAME kind in one reply still collide, and that is right: it is a model repeating itself, and the
second is dropped rather than doubled. **Cost:** a colon in a string.

**E4 — The citation verdict is a column, not a derivation (R2/R8, task 4).**
`SupervisorMessage.sourced` (migration `20260921000000_supervisor_message_sourced`) is written when
the turn settles and is `true` only when the reply made at least one citation and none of them was
rejected. It is STORED rather than re-derived on read because the evidence is gone by then: the
verdict was reached against the twenty feed sentences and the attachment slices that one prompt
rendered, and neither is recoverable an hour later. The sentence that says which citations did not
check out stays in the reply's own text as well — the chip is a summary, and a person reading the
row months later should not have to trust a boolean. **Cost:** one boolean column.

**E5 — Where the conversation's money lives (R2/R8, task 4).** A chat turn is a Supervisor model
call and is charged like one, but on the TURN's own row: `SupervisorMessage.modelCostUsd` and
`unmeasured`. `workspaceSpend` gained a chat term —
`chatMeasuredUsd + chatUnmeasuredTurns × SUPERVISOR_PER_CALL_CAP_USD` — so an unpriced turn is
charged at the cap rather than counted as free, which is the same honesty rule every other
Supervisor call already obeys. The decisions a reply produces are recorded `modelCalled: false`
*because* of that: `workspaceSpend` charges every `modelCalled` row with no cost at the cap, and
`true` here would bill the same call again, once per action the reply asked for. Two consequences
follow and are deliberate: a turn on a project past its budget fails `budget_exhausted` **without
making the call**, and a HALTED project still chats — a halt is exactly when a person asks why
nothing is running, and `tierOf` already refuses to apply anything under one. Booked, not fixed:
the Runtime card's "Supervisor spend" figure still counts only decision rows, so conversation money
is in the project's total and not in that tile. **Cost:** one term in one sum.

**E6 — What arms a read-only turn (R7, tasks 3 and 4).** The turn writes a permissions file of its
own under the turn's directory with `runKind: 'planning'` — whose baseline is exactly `read_repo`,
nothing else — mints a fresh run token, and passes both to `decideWithModel` with `tools:
'read-only'` and `cwd` set to the repository. The turn's own id goes where a run's id would: the
gate compares the token's hash against what the file names, and no `SlaveRun` exists for a
conversation. The tick also refuses to READ a stored attachment whose path resolves outside
`docs/inbox/` before the prompt is built, so a row hand-edited in the database cannot make the
Supervisor quote `/etc/shadow` into a prompt. What none of this buys is E2's first half, unchanged.
**Cost:** a permissions file per image turn.

**E7 — A refusal is a sentence in the reply, not a line in stderr (R1/R2, task 4 fix round 1).**
`recordDecision` can refuse an action a reply asked for — the project's Supervisor is switched off,
or the same `(kind, subject)` was decided inside the cooldown — and dropping that into stderr left
the reply reading as though the thing had happened. Each refusal now joins the same trailing
`notes` the parser's dropped-action sentences and the citation verdict use, in the person's own
words ("I could not record that change to the goal: …"), and **the turn still answers**: a refusal
to record is never a reason to withhold what the model said, and a person whose Supervisor is off
may be asking exactly why nothing is happening. The three failure reasons a turn can carry —
`no_decider_for_provider`, `budget_exhausted`, `turn_unreadable` — each have a sentence in the
panel; any other reason is the runtime's own words, shown verbatim. **Cost:** a list of sentences
under an answer.

**E8 — The composer stopped writing goal versions, and one gate was rewritten for it (R8/R9, task
8).** The panel's box posts a MESSAGE; asking for the goal to change is something a REPLY may
propose. `POST /api/w/:id/goal/request` is untouched and still serves the CLI, and nothing in the
panel calls it. `gate:m45-project-experience` stage 5 read back the goal v3 the composer used to
write, so it was rewritten rather than deleted: it now fills the same box with the same words and
measures the two rows a send really writes — the person's line `human/sent` and the reply
placeholder `supervisor/answering`, which is the panel's "thinking…" row — plus the negative the
rewrite exists for, that no `GoalVersion` v3 was written at all. Its `replan-status` assertions are
gone rather than re-aimed: they read "a FRESH version arms the next tick's re-plan", and the only
fresh version in that gate was the composer's — stage 0's v2 is already deduped by its own seeded
`workspace.replan_started`, so asking again would have measured M40's dedup. The conversation's
whole goal-change path is proven instead in `gate:m39-supervisor-mailbox` **stage 6**, against a
real daemon and the fake CLI: `supervisor-say --file <brief.md>` commits the brief under
`docs/inbox/`, the reply asks for a `request_goal_change` naming that path, autonomy `act` applies
it, and the newest goal version carries the path. R5's `disabledKinds` was never built, because E1
found Cursor's print mode works. **Cost:** one stage rewritten, one stage added.

Booked by this milestone and deliberately not fixed: `PUT /api/w/:id/provider` (the project's RUN
provider) answers **409** for a provider this installation does not have, where the Supervisor's own
settings route answers **400** for the same refusal; `simulation/auto-run.ts` keeps
its own in-flight set rather than the shared `detachedCalls`; and `--file` is REPEATABLE now, so
`set-profile --file a --file b` and `runbooks add --file a --file b` refuse two files rather than
silently taking one.
