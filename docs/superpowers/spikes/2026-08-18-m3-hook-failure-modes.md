# M3 Task 1 — Hook Failure Modes (Q7, Q8)

**Date:** 2026-08-18
**Question:** ADR 0001's Q7 (does a crashing `PreToolUse` hook fail closed?) and Q8 (can a denied
`Edit` partially apply?). Both were listed as unresolved and both are load-bearing for a milestone
that implements pause, so they were measured against the real `claude` CLI before any adapter code
was written.

**Fix Round 1 (same day)** added Q9 — raised by Q7's own limit — at the controller's direction:
do hook failures *other than* exit 2 fail open? §6 has it.

**Verdict up front:** Q7 — **fails closed** (the tool call did not run). Q8 — **no partial
application** (the target file was byte-identical, mtime unchanged). Q9 — **fails OPEN**: a missing
hook (127), a non-executable hook (126) and a hook that exits 1 all let the tool run, with an empty
`permission_denials` and a terminal event indistinguishable from a healthy run. All **[Observed]**.
Details, limits, and the incidental findings that affect M3's stream parser are below.

**One claim from this document's first version is retracted by Q9** and corrected in place: the
discriminator for "the hook blocked" is `exit_code == 2` **exactly**, not `outcome == "error"`. See
the correction note in §3.1.

Every claim is labelled **[Observed]** (a capture or a filesystem check shows it), **[Inferred]**
(it follows from an observed mechanism but was not directly seen), or **[Decision]** (our choice).

---

## 0. Environment

- `claude --version`: **2.1.234 (Claude Code)**. ADR 0001 and the M0 findings were gathered on
  2.1.233; this is a patch bump, not the same build.
- Host: Linux 7.1.8-1-cachyos, bash.
- Probe root: `~/.aiteamos-m3-probe/` — outside the repository, throwaway. Nothing from it is
  committed; only this document and the ADR edit enter the repo.
- Repo state at probe time: branch `feature/m3-orchestrator-and-adapter`, HEAD `155f1a8`, tree clean.
- **Four** `claude` invocations total across both rounds. Combined reported cost: **$0.8598**
  (`total_cost_usd` 0.2428725 + 0.2169030 for Q7/Q8; 0.2093390 + 0.1906820 for Q9).

### 0.1 Confounder check — other `PreToolUse` hooks on this machine

Checked before running, because M0 §3.3's "every `PreToolUse:*` line is `pause-gate.sh`" no longer
holds on this machine. `~/.claude/settings.json` has no `hooks` key, but it enables plugins, and one
enabled plugin registers a `PreToolUse` hook:

```
claude-mem@thedotmack — PreToolUse, matcher "Read", async: true, timeout 60
  (node .../worker-service.cjs hook claude-code file-context)
```

No other **enabled** plugin registers `PreToolUse` (`hookify` does, with a null matcher, but it is
not in `enabledPlugins`). **[Observed]**

Consequences, both accepted rather than engineered around:

- It fires on `Read` only. The Q7 probe's decisive tool calls were `Bash` and `Write`; the Q8
  probe's decisive call was `Edit`. Neither verdict depends on a `Read`. **[Inferred]**
- It is `async: true`, so its `hook_response` is emitted out of band — in the Q7 capture it arrived
  **after** the terminal `result` event (see §3.3). This is itself a finding for M3's parser.
- Where a capture shows two `hook_started` lines for `PreToolUse:Read`, one is ours and one is
  claude-mem's. Every `PreToolUse` line for `Bash`, `Write`, and `Edit` in these captures is the
  probe hook.

Neither probe disabled the plugin. Doing so would have meant running against a throwaway
`CLAUDE_CONFIG_DIR` with unresolved credential implications, for no gain on either question.

---

## 1. Q7 — Does a crashing hook fail closed?

### 1.1 The probe

A hook that always exits 2 with nothing on stdout, registered for **every** tool by absolute path.
The absolute-path form is the only form ADR 0001 §3 permits; no `$VAR` form was introduced.

`~/.aiteamos-m3-probe/crash-hook.sh`:

```bash
#!/usr/bin/env bash
cat > /dev/null
printf 'deliberate hook crash\n' >&2
exit 2
```

`~/.aiteamos-m3-probe/settings-q7.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/home/meren/.aiteamos-m3-probe/crash-hook.sh" }
        ]
      }
    ]
  }
}
```

Standalone sanity check before spending a run:

```
$ echo '{}' | ~/.aiteamos-m3-probe/crash-hook.sh
deliberate hook crash
rc=2
```

### 1.2 Exact command executed

```bash
P="$HOME/.aiteamos-m3-probe"
cd "$P/q7-workdir"                 # empty directory, probe.txt verified absent
timeout 300 claude -p "Create a file called probe.txt containing the word hello" \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  --settings "$P/settings-q7.json" \
  --include-hook-events \
  < /dev/null > "$P/q7-capture.jsonl" 2>&1
```

Two deviations from the brief's command, both deliberate and neither affecting the verdict:
`< /dev/null` (M0 §3.4 recorded a 3-second stdin wait without it) and `timeout 300` as a runaway
guard against a hook that blocks every tool. The run finished in 17 s, so the guard never fired.
`tee` was replaced by a plain redirect because nothing needed to watch the stream live.

### 1.3 The answer: the file does not exist

**This is the verdict. It is a filesystem fact, not an inference from the event stream.**

```
=== PRE ===
$ ls -la ~/.aiteamos-m3-probe/q7-workdir     # empty
probe.txt exists? NO

=== POST ===
$ ls -laR ~/.aiteamos-m3-probe/q7-workdir
total 0
drwxr-xr-x 1 meren meren   0 Aug 18 19:41 .
drwxr-xr-x 1 meren meren 162 Aug 18 19:41 ..
probe.txt exists? NO
$ cat ~/.aiteamos-m3-probe/q7-workdir/probe.txt
cat: .../probe.txt: No such file or directory
```

The working directory is byte-for-byte as empty after the run as before it. The run's own summary
agrees, but the directory listing is what settles it. **[Observed]**

Run start 19:41:21, end 19:41:38 (17 s wall). `claude` process exit code **0**. Capture:
37 lines, 37/37 parse as standalone JSON.

### 1.4 What the crash actually did, tool call by tool call

The model tried three different tools to accomplish the task. All three were blocked.

| # | Tool | `hook_response` | Result |
|---|---|---|---|
| 1 | `Bash` (`echo hello > .../probe.txt`) | `outcome:"error"`, `exit_code:2` | blocked |
| 2 | `Write` (`.../probe.txt`, `"hello\n"`) | `outcome:"error"`, `exit_code:2` | blocked |
| 3 | `Read` (`crash-hook.sh`, to diagnose) | `outcome:"error"`, `exit_code:2` | blocked |

Raw `hook_response` for the first block (capture line 12):

```json
{"type":"system","subtype":"hook_response","hook_id":"b3640477-...","hook_name":"PreToolUse:Bash",
 "hook_event":"PreToolUse","output":"deliberate hook crash\n","stdout":"","stderr":"deliberate hook crash\n",
 "exit_code":2,"outcome":"error","uuid":"6de95af2-...","session_id":"63f81419-..."}
```

The matching `tool_result` (capture line 13):

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result",
 "content":"PreToolUse:Bash hook error: [/home/meren/.aiteamos-m3-probe/crash-hook.sh]: deliberate hook crash\n",
 "is_error":true,"tool_use_id":"toolu_01RpRJ7bNVesaAwUAuf2UvxJ"}]},...,
 "tool_result_meta":[{"id":"toolu_01RpRJ7bNVesaAwUAuf2UvxJ","non_execution_kind":"permission-rule"}]}
```

Note `non_execution_kind: "permission-rule"` — the CLI itself marks the call as not executed. And
`grep -c PostToolUse q7-capture.jsonl` returns **0**: no `PostToolUse` hook fired for any of the
three calls, consistent with no tool body having run. **[Observed]**

The model's own closing text (capture line 33) names the mechanism correctly: *"every tool call is
being blocked before it runs… `probe.txt` was not created."*

### 1.5 The terminal event, and the trap in it

```json
{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","num_turns":4,
 "total_cost_usd":0.2428725,
 "permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_01RpRJ...","tool_input":{...}},
                       {"tool_name":"Write","tool_use_id":"toolu_01LGT...","tool_input":{...}},
                       {"tool_name":"Read","tool_use_id":"toolu_01Wph...","tool_input":{...}}]}
```

`is_error: false`, `terminal_reason: "completed"`, `subtype: "success"`, process exit code 0 — a run
in which **nothing whatsoever happened** reports a clean success. This is the same trap ADR 0001 §3
recorded for permission-mode denials, now confirmed for hook crashes too. Only `permission_denials`
distinguishes it. **[Observed]**

**Crash-blocks land in `permission_denials` alongside genuine denies.** That array cannot tell M3
which kind of block occurred; only the live `hook_response` can.

### 1.6 Q7 verdict

**[Observed] A `PreToolUse` hook that exits 2 fails CLOSED.** The tool call does not run; the side
effect does not land. Measured on `claude` 2.1.234 for `Bash`, `Write`, and `Read`, under
`--permission-mode bypassPermissions`, with `matcher: "*"`.

**[Inferred]** This is consistent with Claude Code's documented general hook exit-code convention
(0 = success, 2 = blocking error read from stderr), which is what `pause-gate.sh`'s comments cite as
the basis for its own exit-2 fallback. That fallback path is therefore now backed by a measurement
of the mechanism it relies on, not only by the documented convention.

**What this does NOT cover:**

- **Only exit code 2 was exercised.** A hook that exits 1, or 126/127 (script not executable /
  missing), or is killed by a signal, or times out, was **not** measured here. **This was measured
  in Fix Round 1 and the answer is that they fail OPEN — see §6 (Q9).** Signal-kill and timeout
  remain unmeasured.
- **Only `Bash`, `Write`, and `Read` were blocked** in this run. `Edit` was blocked in the Q8 run
  (by a deny, not a crash). No `Task`/`Skill`/MCP tool was exercised here.
- The crash hook produced **empty stdout**. A hook that exits 2 *with* stdout was not tested.

---

## 2. Q8 — Can a denied `Edit` partially apply?

### 2.1 The probe

The real `spike/m0-pause-resume/pause-gate.sh`, registered by absolute path in
`~/.aiteamos-m3-probe/settings-q8.json` (identical in shape to `spike/m0-pause-resume/settings.json`).
The pause flag was armed **after** the run had read the target file and **before** it issued the
`Edit`, so that `Edit` was the pending call at the moment of the deny.

Target file `~/.aiteamos-m3-probe/q8-workdir/target.txt`, known content:

```
line one: alpha
line two: beta
line three: gamma
```

Three lines on purpose: a partial application would show as a changed line count, a changed hash, or
a truncation, not just as an absent success message.

### 2.2 Target file bytes BEFORE

```
$ stat -c %s target.txt      -> 49
$ sha256sum target.txt       -> a14dabdcec58e793bfca1a537785f44514095f2fcd1f3f2258db7b2795c48a9f
$ stat -c %y target.txt      -> 2026-08-18 19:42:18.330237935 +0100
$ cat -A target.txt
line one: alpha$
line two: beta$
line three: gamma$
```

### 2.3 Exact command executed

```bash
P="$HOME/.aiteamos-m3-probe"
export AITEAMOS_PAUSE_FLAG="$P/q8-pause.flag"
rm -f "$AITEAMOS_PAUSE_FLAG"                 # verified absent before the run

FIFO="/tmp/aiteamos-m3-delay.$$"; mkfifo "$FIFO"; exec 9<> "$FIFO"; rm -f "$FIFO"

cd "$P/q8-workdir"
timeout 300 claude -p "Use the Read tool to read target.txt, then use the Edit tool to replace the word alpha with the word omega in that file. Do nothing else." \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  --settings "$P/settings-q8.json" \
  --include-hook-events \
  < /dev/null > "$P/q8-capture.jsonl" 2>&1 &
CLAUDE_PID=$!

for i in $(seq 1 600); do
  kill -0 "$CLAUDE_PID" 2>/dev/null || break
  if grep -q '"type":"tool_result"' "$P/q8-capture.jsonl" 2>/dev/null; then
    touch "$AITEAMOS_PAUSE_FLAG"; break          # first completed tool == the Read
  fi
  read -t 0.5 -u 9                               # M0 §3.2's FIFO delay primitive
done
wait "$CLAUDE_PID"
exec 9>&-
```

The arming trigger is the **first `tool_result`**, not the first `tool_use`: a `tool_use` line is
emitted *before* that call's `PreToolUse` hook runs, so arming on it would have denied the `Read`
instead of the `Edit`. Arming on the `Read`'s completed result places the flag squarely in the
model round-trip between the `Read` result and the `Edit` call. **[Decision]**

Observed timing: run start 19:42:29; flag armed 19:42:36 (poll iteration 15, capture at 19 lines);
run end 19:42:42. `claude` process exit code 0. Capture: 34 lines, 34/34 parse as JSON.

### 2.4 The Edit was genuinely the pending call, and it was denied

This matters: if the run had ended before attempting the `Edit`, the unchanged file would prove
nothing. It did attempt it.

- Capture line 13 — `Read` of `target.txt` issued.
- Capture line 17 — `PreToolUse:Read` → `outcome:"success"`, `exit_code:0`, **empty output** (the
  allow path of `pause-gate.sh`, flag not yet armed).
- Capture line 19 — `Read` `tool_result` returns the three lines. *(Flag armed here.)*
- Capture line 22 — `Edit` issued:
  `{"file_path":".../target.txt","old_string":"line one: alpha","new_string":"line one: omega","replace_all":false}`
- Capture line 24 — `PreToolUse:Edit` → `outcome:"success"`, `exit_code:0`, output parses to
  `hookSpecificOutput.permissionDecision == "deny"`, reason `"Paused by AI Team OS. Stop and wait."`
- Capture line 25 — `tool_result` `is_error:true`, content = the deny reason, and
  `tool_result_meta[0].non_execution_kind == "permission-rule"`.
- `grep -c 'PostToolUse:Edit'` → **0**. `PostToolUse:Read` did fire. So the `Edit` tool body never
  ran while the `Read`'s did. **[Observed]**
- Terminal `result`: `is_error:false`, `terminal_reason:"completed"`, `num_turns:3`,
  `total_cost_usd:0.2169030`, `session_id:"000d203b-1442-4fab-b80b-abc4a68db6e7"`,
  `permission_denials:[{"tool_name":"Edit","tool_use_id":"toolu_01Tz1SdA9gCmX7DXXkQwh6u3",...}]`.

### 2.5 Target file bytes AFTER

```
$ stat -c %s target.txt      -> 49                       (unchanged)
$ sha256sum target.txt       -> a14dabdcec58e793bfca1a537785f44514095f2fcd1f3f2258db7b2795c48a9f   (unchanged)
$ stat -c %y target.txt      -> 2026-08-18 19:42:18.330237935 +0100   (unchanged — not even touched)
$ cat -A target.txt
line one: alpha$
line two: beta$
line three: gamma$
$ ls -la q8-workdir
total 4
-rw-r--r-- 1 meren meren  49 Aug 18 19:42 target.txt      (no .bak, .tmp, or swap file)
```

Identical size, identical hash, **identical mtime to the nanosecond**, and no stray temp file in the
directory. The file was not opened for writing at all. **[Observed]**

### 2.6 Q8 verdict

**[Observed] A denied `Edit` does not partially apply — it does not apply at all.** The `PreToolUse`
deny lands before the tool body runs; the target file is byte-identical with an unchanged mtime, no
`PostToolUse:Edit` fires, and the CLI marks the call `non_execution_kind: "permission-rule"`.

This also settles ADR 0001's Known Limitation *"a denied `Edit` was never observed"* — both M0
denies were read-only, and findings §7's was a `Bash`. A denied `Edit` is now observed. **[Observed]**

**What this does NOT cover:**

- **One `Edit` tool call, single hunk, one `old_string`.** `MultiEdit`, `NotebookEdit`, `Write` over
  an existing file, and a `Bash`-mediated write (`sed -i`, `>>`) were **not** exercised. The
  mechanism is the same `PreToolUse` gate for all of them, so the result should generalise — but
  that is **[Inferred]**, not measured.
- **The deny arrived cleanly, from `pause-gate.sh`'s normal deny path.** Whether an `Edit` blocked by
  a *crashing* hook also leaves the file untouched was not directly measured; Q7's blocked `Write`
  is the nearest evidence and it created nothing.
- **No concurrent writer.** A single run, a single file, no second agent touching the same path.

---

## 3. Four incidental findings that change M3's parser

None of these were the question asked. All four came out of the captures and all four affect code
Task 8 and the adapter will write. The fourth (§3.4) was found in Fix Round 5, by re-reading the
same captures rather than by running anything.

### 3.1 There is a THIRD `PreToolUse` outcome shape, and it blocks

ADR 0001 §4 names two denial shapes (permission-mode denial, hook deny). The Q7 capture shows a
third, distinct from both. **[Observed]**

> **CORRECTED in Fix Round 1.** The first version of this section said the discriminator between a
> blocking crash and an allow is `outcome == "error"` / `exit_code != 0`. **Q9 refutes that.** Among
> the **`PreToolUse`** responses measured, exit 1, 126 and 127 also report `outcome: "error"` and
> they **do not block**. The discriminator is **`exit_code == 2`, exactly** — see §6.
>
> **SCOPED in Fix Round 5.** That discriminator holds *within `PreToolUse`* and must not be applied
> to the whole stream: every capture also ends with a routine `Stop` hook at `exit_code: 1`, which
> is not a failure of anything (§3.4). The whole of this section is about
> `hook_event === "PreToolUse"` responses. The table below carries the fourth column from Round 1.

| | hook **deny** (Q8, L24) | hook **crash, blocking** (Q7, L12) | hook **failure, non-blocking** (Q9, L18/23/13) |
|---|---|---|---|
| `outcome` | `"success"` | `"error"` | `"error"` |
| `exit_code` | `0` | `2` | `1`, `126`, `127` |
| `output` | JSON string → `permissionDecision:"deny"` | plain text (hook stderr) | plain text (hook or shell stderr) |
| `stderr` | `""` | the reason text | the reason text |
| `tool_result` | `is_error:true`, deny reason | `is_error:true`, `PreToolUse:<Tool> hook error: [<path>]: <stderr>` | **the tool's normal success result** |
| `PostToolUse` fires? | no | no | **yes** |
| in `permission_denials` | yes | yes | **no — the array is empty** |
| tool ran? | no | no | **YES** |

Two parser traps, not one. **[Observed]**

1. A parser that does `JSON.parse(hook_response.output)` and treats a parse failure as "not a deny"
   reads a **blocking** crash as an allow.
2. A parser that treats `outcome == "error"` (or any nonzero `exit_code`) as "blocked" reads a
   **fail-open** hook failure as a pause. That is the more dangerous direction: it would report
   `run.paused` for a run that is still free to act.

Only `exit_code == 2` blocks. Deny / blocking-crash / non-blocking-failure are three different
things with three different operational meanings: the run is pausing as instructed; the gate is
broken and the run must be failed loudly; the gate is broken **and did not stop anything**.

**All of which is scoped to `hook_event === "PreToolUse"`.** Applied to every `hook_response` in the
stream, trap 2 fires on a line that is present in all four captures and means nothing — see §3.4.

### 3.2 `hook_response` events can arrive AFTER the terminal `result` event

Q7 capture, line 37 — the **last** line of the file, after `result` on line 35:

```json
{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:Read","output":"{}\n",
 "exit_code":0,"outcome":"success",...}
```

That is claude-mem's `async: true` `Read` hook reporting late. **[Observed]**

> **CORRECTED in Fix Round 5.** This section originally cited Q8 lines 26–27 as the same ordering.
> That citation was wrong: L26–27 *precede* Q8's terminal `result` at L33. They do demonstrate
> something real, but a different thing — out-of-order **interleaving**, a `Read`'s hook responses
> arriving after a *later* tool's deny — not arrival after `result`. Checking every capture rather
> than reasoning from one, the after-`result` claim is in fact supported three times over:
>
> | Capture | `result` at | after it |
> |---|---|---|
> | q7 | L35 | L36 `Stop`, **L37 `PreToolUse:Read`** (async, exit 0) |
> | q8 | L33 | L34 `Stop` — and nothing else |
> | q9a | L31 | L32 `Stop`, **L33 `PostToolUse:Bash`** (async, exit 0) |
> | q9b | L19 | L20 `Stop`, **L21 `PostToolUse:Bash`** (async, exit 0) |
>
> Three of the four captures place a genuine asynchronous `hook_response` after the terminal event,
> and **all four** place the `Stop` hook's response there. The property is stronger than first
> stated; only the Q8 citation was wrong. **[Observed]**

M3 must not treat the `result` event as "the stream is closed, stop parsing", and must not assume
`hook_started`/`hook_response` pairs are ordered or interleaved per tool call. Correlating a
`hook_response` to a tool call still requires the following `tool_result` (ADR 0001 §4, requirement
2 — `hook_response` still carries no `tool_use_id`; confirmed again in both captures). **[Observed]**

### 3.3 A run in which nothing happened reports `is_error:false` / `"completed"`

Confirmed for a third failure mode. ADR 0001 §3 recorded it for permission-mode denials; it holds
identically for hook denies (Q8) and hook crashes (Q7), and in both probes the **process exit code
was 0**. `permission_denials` non-empty is the only signal on the terminal event, and it cannot
distinguish crash from deny (§3.1). The adapter must decide outcome from the event stream's live
`hook_response` lines, not from the terminal event alone and not from the exit code. **[Observed]**

### 3.4 Every run ends with a `Stop` hook at `exit_code: 1` — and a third `outcome` value

Found in Fix Round 5 by re-reading all four captures for `hook_response` lines that are not
`success`/0. The last such line in **every** capture is the same, and it is not a failure:

| Capture | Line | `hook_name` | `hook_event` | `exit_code` | `outcome` |
|---|---|---|---|---|---|
| q7 | L36 | `Stop` | `Stop` | `1` | `"cancelled"` |
| q8 | L34 | `Stop` | `Stop` | `1` | `"cancelled"` |
| q9a | L32 | `Stop` | `Stop` | `1` | `"cancelled"` |
| q9b | L20 | `Stop` | `Stop` | `1` | `"cancelled"` |

Four of four. These are healthy runs — q8's ended with a correct pause, q9a's and q9b's completed
their work — so `exit_code: 1` on a `Stop` hook is routine, not a fault. **[Observed]**

**Two things follow, and the first is a defect this document would otherwise have caused.**

1. **The `exit_code` classification of §3.1 and §6 is scoped to `hook_event === "PreToolUse"`.**
   Stated as a rule over every `hook_response`, "non-zero and not 2 ⇒ failed open" matches this line
   on every run ever. Under the consequences in §5, that cancels the run, fails it, and halts the
   workspace — on all four of the runs that produced this evidence, and on every healthy run after
   them. `hook_event` is the field that scopes it, and it is present on every `hook_response` line in
   all four captures.
2. **`outcome` has at least three values, not two.** `"success"`, `"error"`, and `"cancelled"`.
   Counted across all four captures: 24 `success`, 6 `error`, 4 `cancelled`. Every `"error"` is a
   `PreToolUse` response; every `"cancelled"` is a `Stop` response. **[Observed]**

   Note the direction of the near-miss. The **round-0** discriminator I retracted
   (`outcome === "error"`) would *not* have fired on these lines, because they are `"cancelled"`.
   The **corrected** discriminator (`exit_code` non-zero and not 2) does. Fixing the fail-open bug
   introduced this one, and only the `hook_event` scope removes both. That is worth stating plainly
   rather than filing as a footnote: a correction is not automatically safe.

**What `"cancelled"` means is unmeasured.** It is a plausible shape for a hook that was cancelled or
timed out, and if so it is what a `PreToolUse` timeout would look like — but no `PreToolUse` response
in these captures carries it, so its meaning for the gate is unknown. This does **not** reopen the
timeout question: the runtime backstop keys on whether tool calls proceeded after the flag was
armed, which is answerable whatever shape the hook's own response takes. Recorded and left.

---

## 4. What could not be settled, and what would settle it

- ~~**Non-2 hook failures.**~~ **MEASURED in Fix Round 1 — see §6. They fail OPEN.** What remains
  uncovered there: a **signal-killed** hook and a hook that **exceeds its timeout**.
- **Whether Q7 generalises past `Bash`/`Write`/`Read`.** `Edit`, `Task`, `Skill`, and MCP tools were
  not blocked *by a crash*. The gate is the same, so it should hold; not measured.
- **Whether Q8 generalises past a single-hunk `Edit`.** `MultiEdit`, `NotebookEdit`, `Write` over an
  existing file, and `Bash`-mediated writes were not exercised. *Settles it:* one run per tool with
  the flag armed on the pending call.
- **The `--include-hook-events` dependency was not re-tested.** Both probes passed it, per ADR 0001
  §3. Whether a *crash* is visible without it is unknown; ADR 0001 already makes the flag mandatory,
  so this is not worth a run.
- **Version drift.** These runs are on 2.1.234, ADR 0001's on 2.1.233. Nothing observed here
  contradicts M0, but the two bodies of evidence are not from the same build.

---

## 5. Consequences for M3

1. **Task 8's pause design stands as written.** Q7 fails closed, so the orchestrator may treat
   "flag written and a deny observed" as "side effects blocked". The fallback to cancel-and-preserve
   is not required. **[Observed basis]**
2. **The stream parser needs four branches**, not two: allow / deny / blocking hook crash
   (`exit_code == 2`) / **non-blocking hook failure (any other nonzero `exit_code`, where the tool
   ran anyway)**. Mapping: deny → `run.paused`; blocking crash → the gate is broken, fail the run
   loudly (it must **not** be reported as a pause, because nothing is waiting to be resumed and the
   operator's lever is dead); non-blocking failure → the gate is broken **and a side effect already
   landed** — also a loud failure, and never a pause. **[Decision]**
3. **A denied `Edit` needs no compensating cleanup.** The checkpoint's `dirtyFiles` will not contain
   a half-applied edit from the denied call. **[Observed basis]**
4. **Hook deployment is a correctness concern, not an ops detail — now measured, not supposed.**
   The only failure mode that fails closed is exit 2. A missing hook path (127), a non-executable
   hook (126) and a hook that exits 1 all fail **open**, with an empty `permission_denials` and a
   clean terminal event. **The evidence therefore supports the requirement that M3 must not treat
   "settings file written" as "pause gate armed":** a positive check that the hook actually fires is
   needed *before* a run is considered pausable. See §6.4. **[Observed basis; the design of that
   check is the controller's call, not this task's]**

---

## 6. Q9 (Fix Round 1) — Do hook failures other than exit 2 fail open?

Raised by Q7's own limit and prioritised by the controller, whose reason is worth restating because
it defines what the measurement is for: **M3 generates the settings file and its absolute hook path
per run, in code that does not exist yet.** "The hook path is wrong in a spawned run" is a far more
likely production failure than "the deny `printf` failed". If that case fails open, a single path
bug produces runs that cannot be paused — silently, with the flag file sitting there and nothing
denying it.

Priority order given: (1) hook missing / not executable, (2) exit 1. Both were reached, in two runs.

### 6.1 Run A — missing path (127) and non-executable (126), in one run

Two `PreToolUse` entries with **different matchers**, so one run answers both sub-cases and each
verdict is attributable to a specific tool:

```json
{"hooks":{"PreToolUse":[
  {"matcher":"Write","hooks":[{"type":"command","command":"/home/meren/.aiteamos-m3-probe/no-such-hook.sh"}]},
  {"matcher":"Bash", "hooks":[{"type":"command","command":"/home/meren/.aiteamos-m3-probe/nonexec-hook.sh"}]}
]}}
```

- `no-such-hook.sh` — **does not exist**. Verified absent before the run.
- `nonexec-hook.sh` — **exists, mode 644 (no execute bit)**, and its body is `exit 2` with a stderr
  message. Deliberate: if it ever executed it would *block*, so "the file was created" proves the
  hook did not run **and** that the CLI did not block in its place. Standalone check: invoking it
  directly gives `Permission denied`, `rc=126`; invoking the missing path gives `No such file or
  directory`, `rc=127`.

```bash
P="$HOME/.aiteamos-m3-probe"
cd "$P/q9a-workdir"                # empty; alpha.txt and beta.txt verified absent
timeout 300 claude -p "Use the Write tool to create a file called alpha.txt containing the word hello. Then use the Bash tool to run this exact command: echo hello > beta.txt" \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  --settings "$P/settings-q9a.json" \
  --include-hook-events \
  < /dev/null > "$P/q9a-capture.jsonl" 2>&1
```

**The filesystem (the verdict):**

```
PRE :  alpha.txt? NO    beta.txt? NO      (empty directory)
POST:  alpha.txt? YES   beta.txt? YES
       -rw-r--r-- 6 alpha.txt      -> "hello"
       -rw-r--r-- 6 beta.txt       -> "hello"
```

**Both side effects landed.** `claude` exit code 0; capture 33 lines. The model used exactly the
tools it was told to (`Write` for `alpha.txt` at capture L16, `Bash` `echo hello > beta.txt` at L21),
so each file is attributable to its own hook entry with no ambiguity. **[Observed]**

Raw `hook_response` for the missing path (L18):

```json
{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:Write","hook_event":"PreToolUse",
 "output":"/bin/sh: line 1: /home/meren/.aiteamos-m3-probe/no-such-hook.sh: No such file or directory\n",
 "stdout":"","stderr":"/bin/sh: line 1: ...: No such file or directory\n",
 "exit_code":127,"outcome":"error",...}
```

Raw `hook_response` for the non-executable hook (L23):

```json
{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:Bash","hook_event":"PreToolUse",
 "output":"/bin/sh: line 1: /home/meren/.aiteamos-m3-probe/nonexec-hook.sh: Permission denied\n",
 "stdout":"","stderr":"/bin/sh: line 1: ...: Permission denied\n",
 "exit_code":126,"outcome":"error",...}
```

Two mechanism details fall out of these. The `command` is run **through `/bin/sh`** — the failure is
a *shell* diagnostic, not a CLI one, so the hook binary never started. And `stderr` reaching the
stream is the shell's, not the hook's: `grep -c 'nonexec hook ran' q9a-capture.jsonl` → **0**, so
the exit-2 body genuinely never executed. **[Observed]**

What followed each failed hook, in both cases:

- `PostToolUse:Write` / `PostToolUse:Bash` **fired** (L19, L24) — the tool bodies ran.
- The `tool_result` is a **normal success**: `"File created successfully at: .../alpha.txt"` (L20)
  and `is_error:false`, `"(Bash completed with no output)"` (L25).
- Terminal `result` (L31): `is_error:false`, `terminal_reason:"completed"`, `num_turns:3`,
  `total_cost_usd:0.2093390`, **`permission_denials: []`**.

### 6.2 Run B — exit 1

Run separately rather than folded into Run A, because it is not the same shape: 126/127 are *shell*
failures where the hook never starts, while exit 1 is the **hook script itself running and failing**.
That distinction matters for `pause-gate.sh` specifically — it runs under `set -u`, and an unset
variable reference introduced by a future edit would abort bash with **exit 1**, not 2.

`exit1-hook.sh` (executable): `cat > /dev/null`; `printf 'deliberate hook failure exit 1\n' >&2`;
`exit 1`. Registered with `matcher: "*"` by absolute path in `settings-q9b.json`.

```bash
cd "$P/q9b-workdir"                # empty; gamma.txt verified absent
timeout 300 claude -p "Create a file called gamma.txt containing the word hello" \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  --settings "$P/settings-q9b.json" \
  --include-hook-events \
  < /dev/null > "$P/q9b-capture.jsonl" 2>&1
```

**The filesystem (the verdict):**

```
PRE :  gamma.txt? NO
POST:  gamma.txt? YES   -rw-r--r-- 6   -> "hello"
```

`claude` exit code 0; capture 21 lines. Stream (L10–L15): `Bash`
(`echo hello > .../gamma.txt && cat ...`) → `PreToolUse:Bash` `hook_response`
`{"output":"deliberate hook failure exit 1\n","stderr":"deliberate hook failure exit 1\n",
"exit_code":1,"outcome":"error"}` → **`PostToolUse:Bash` fired** → `tool_result` `is_error:false`,
content `"hello"`. Terminal `result`: `is_error:false`, `terminal_reason:"completed"`, `num_turns:2`,
`total_cost_usd:0.1906820`, **`permission_denials: []`**. **[Observed]**

Note this is the same hook script shape as Q7's, differing only in its exit code — 1 instead of 2 —
and the outcome inverts completely. The exit code is the whole mechanism.

### 6.3 Q9 verdict

**[Observed] Hook failures other than exit code 2 fail OPEN.** Measured on `claude` 2.1.234, under
`--permission-mode bypassPermissions`, for three failure modes:

| Failure mode | `exit_code` | `outcome` | Tool ran? | `permission_denials` |
|---|---|---|---|---|
| hook path does not exist | `127` | `"error"` | **yes** | `[]` |
| hook exists, no execute bit | `126` | `"error"` | **yes** | `[]` |
| hook runs and exits 1 | `1` | `"error"` | **yes** | `[]` |
| *(Q7, for contrast)* hook exits 2 | `2` | `"error"` | no | 3 entries |

This is exactly what Claude Code's documented convention predicts (0 = success, 2 = blocking error,
other nonzero = non-blocking warning), so **nothing here is version-sensitive-looking**; 2.1.234
behaves as documented. **[Observed]**

**The signal available to an orchestrator, and its limit:** the failure *is* visible live — the
`hook_response` carries `exit_code` and `outcome: "error"`. But the terminal `result` event is
**completely clean**: `is_error:false`, `terminal_reason:"completed"`, `permission_denials: []`,
process exit code 0. A fail-open run is indistinguishable from a healthy run on the terminal event
alone. And even the live signal arrives *concurrently with* the tool that it failed to gate — by the
time the orchestrator sees it, the side effect has landed. Detection is possible; **prevention is
not, from the stream.** **[Observed]**

**What this does NOT cover:**

- **A signal-killed hook** (e.g. `SIGKILL` to the hook process) was **not** measured.
- **A hook that exceeds its configured timeout** was **not** measured. This is a plausible
  production mode — a slow filesystem check on a loaded host — and the convention offers no guidance
  on which side of the line a timeout lands.
- Exit codes were sampled, not enumerated: `1`, `126`, `127`. Any *other* nonzero code (e.g. `3`)
  is **[Inferred]** to behave the same, from the convention plus these three points.
- Only `Write` and `Bash` were the tools left ungated. Not `Edit`, `Task`, `Skill`, or MCP tools.
- **Q9 was measured with a `PreToolUse` hook that is not `pause-gate.sh`.** That a *real*
  `pause-gate.sh` failing this way leaves pause disabled is **[Inferred]** — the gate is the same
  mechanism, but the specific script was not made to fail this way in a live run.

### 6.4 The consequence, stated plainly

**The evidence supports the requirement.** M3 **cannot** treat "settings file written" as "pause
gate armed". A settings file can be written, syntactically valid, with an absolute `command` path
that is wrong or unexecutable, and the resulting run will:

1. spawn cleanly and report `system/init` normally;
2. execute **every** tool call unimpeded;
3. leave `permission_denials` empty and terminate with `is_error:false`,
   `terminal_reason:"completed"`, process exit code 0;
4. ignore the pause flag entirely — `requestPause` would write the flag, nothing would deny, no
   `run.paused` would ever be emitted, and the operator would watch a "pausing" run keep working.

That is precisely the failure class this milestone exists to eliminate, and it is reachable from a
single path bug in code that does not exist yet. **A positive check that the hook actually fires is
therefore required before a run is treated as pausable** — "the file is on disk" is not evidence
that the gate is live, and neither is a clean terminal event. **[Observed basis]**

Not designed here, per instruction: the shape of that check is the controller's ruling and lands in
Task 6. The one thing the measurement does constrain is that a *static* check (does the path exist,
is it `+x`) would catch 126 and 127 but **not** exit 1 — a hook that is present, executable, and
broken. Only actually observing the hook fire distinguishes those.


### 6.5 The pre-flight check must assert both directions (Fix Round 5)

Local check of the real `spike/m0-pause-resume/pause-gate.sh`, no `claude` involved, all four
environment states:

| State | stdout | exit |
|---|---|---|
| `AITEAMOS_PAUSE_FLAG` set, flag file **present** | deny JSON | 0 |
| `AITEAMOS_PAUSE_FLAG` set, flag file **absent** | *empty* | 0 |
| `AITEAMOS_PAUSE_FLAG` **unset** | deny JSON (`"…is unset or empty — refusing to fall back…"`) | 0 |
| `AITEAMOS_PAUSE_FLAG` **empty string** | deny JSON (same reason) | 0 |

**[Observed]** The bottom two are `pause-gate.sh`'s deliberate loud-configuration-error path (ADR
0001 §2), and they are why a one-directional pre-flight is insufficient. A check that only asserts
"flag present ⇒ deny JSON, exit 0" passes for a hook that denies **everything** — including a run
whose `AITEAMOS_PAUSE_FLAG` was never exported, which would then deny its first tool call and
accomplish nothing while looking correctly gated.

The check therefore asserts both directions:

- flag present → deny JSON on stdout, exit 0;
- flag absent → **empty stdout**, exit 0.

Together they establish that the hook discriminates, which is the property the gate actually needs.
Neither direction proves Claude Code will invoke it (§6.4).

---

## 7. Artefacts

Throwaway, **not committed**, kept on disk for audit:

- `~/.aiteamos-m3-probe/crash-hook.sh`, `nonexec-hook.sh`, `exit1-hook.sh`
- `~/.aiteamos-m3-probe/settings-q7.json`, `settings-q8.json`, `settings-q9a.json`, `settings-q9b.json`
- `~/.aiteamos-m3-probe/q7-capture.jsonl` (37 lines), `q8-capture.jsonl` (34), `q9a-capture.jsonl` (33),
  `q9b-capture.jsonl` (21)
- `~/.aiteamos-m3-probe/q7-workdir/` (empty — the Q7 verdict), `q8-workdir/target.txt`,
  `q9a-workdir/{alpha,beta}.txt` (present — the Q9 verdict), `q9b-workdir/gamma.txt` (present)
- `~/.aiteamos-m3-probe/q8-pause.flag`

Four `claude` invocations across both rounds, **$0.8598** total reported cost.

No product code was written. Repo changes are this document and ADR 0001's §4, Known Limitations,
and Open Questions sections.
