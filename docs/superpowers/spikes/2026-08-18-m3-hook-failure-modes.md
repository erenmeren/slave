# M3 Task 1 — Hook Failure Modes (Q7, Q8)

**Date:** 2026-08-18
**Question:** ADR 0001's Q7 (does a crashing `PreToolUse` hook fail closed?) and Q8 (can a denied
`Edit` partially apply?). Both were listed as unresolved and both are load-bearing for a milestone
that implements pause, so they were measured against the real `claude` CLI before any adapter code
was written.

**Verdict up front:** Q7 — **fails closed** (the tool call did not run). Q8 — **no partial
application** (the target file was byte-identical, mtime unchanged). Both **[Observed]**. Details,
limits, and three incidental findings that affect M3's stream parser are below.

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
- Two `claude` invocations total. Combined reported cost: **$0.4598** (`total_cost_usd`
  0.2428725 + 0.2169030).

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

- **Only exit code 2 was exercised.** A hook that exits 1, or 127 (script missing / not
  executable), or is killed by a signal, or times out, was **not** measured. The documented
  convention says other nonzero codes are *non-blocking warnings* — i.e. the tool call would
  proceed. **A `pause-gate.sh` that failed with exit 1 or 127 would, on that convention, fail
  OPEN.** This is untested and is the residual risk in this area; see §4.
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

## 3. Three incidental findings that change M3's parser

None of these were the question asked. All three came out of the captures and all three affect code
Task 8 and the adapter will write.

### 3.1 There is a THIRD `PreToolUse` outcome shape, and it blocks

ADR 0001 §4 names two denial shapes (permission-mode denial, hook deny). The Q7 capture shows a
third, distinct from both. **[Observed]**

| | hook **deny** (Q8, line 24) | hook **crash** (Q7, line 12) |
|---|---|---|
| `outcome` | `"success"` | `"error"` |
| `exit_code` | `0` | `2` |
| `output` | JSON string → `permissionDecision:"deny"` | plain text (`"deliberate hook crash\n"`) |
| `stderr` | `""` | the reason text |
| `tool_result` | `is_error:true`, content = deny reason | `is_error:true`, content = `PreToolUse:<Tool> hook error: [<path>]: <stderr>` |
| in `permission_denials` | yes | **yes** |
| tool ran? | no | no |

A parser that reaches for `JSON.parse(hook_response.output)` and treats a parse failure as "not a
deny" would read a crash as an allow. Both block; they must be distinguished because their
*operational meaning* differs — a deny means the run is pausing as instructed, a crash means the
gate is broken and the run should be failed, not parked as `paused`. The discriminator is
`outcome == "error"` / `exit_code != 0`, available on the same event. **[Observed]**

### 3.2 `hook_response` events can arrive AFTER the terminal `result` event

Q7 capture, line 37 — the **last** line of the file, after `result` on line 35:

```json
{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:Read","output":"{}\n",
 "exit_code":0,"outcome":"success",...}
```

That is claude-mem's `async: true` `Read` hook reporting late. The Q8 capture shows the same
ordering (lines 26–27 arrive after the `Edit` deny, for a `Read` that completed earlier).
**[Observed]**

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

---

## 4. What could not be settled, and what would settle it

- **Non-2 hook failures.** Exit 1, exit 127 (hook script missing, moved, or not executable), a
  signal-killed hook, and a hook that exceeds its timeout were all **unmeasured**. On the documented
  exit-code convention these are *non-blocking warnings*, which would mean the tool call **proceeds**
  — i.e. `pause-gate.sh` would fail **open** if it ever failed in any way other than exit 2.
  `pause-gate.sh` has no path that exits 1, but "the script is missing or `chmod -x`" is a real
  deployment failure and is exactly the 127 case. *Settles it:* one run with a hook that exits 1 and
  one with a `command` pointing at a non-existent path, checking whether `probe.txt` appears. Cost:
  roughly $0.25 per run at the size used here, so ~$0.50 for both. Not run, per the instruction not
  to spend beyond the brief; carried into ADR 0001 as **Q9** for the controller to rule on. This is
  the single most significant residual risk in the pause mechanism.
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
2. **The stream parser needs a third branch**, not two: allow / deny / hook-error. Mapping: deny →
   `run.paused`; hook-error → the gate is broken, fail the run loudly (it must **not** be reported as
   a pause, because nothing is waiting to be resumed and the operator's lever is dead). **[Decision]**
3. **A denied `Edit` needs no compensating cleanup.** The checkpoint's `dirtyFiles` will not contain
   a half-applied edit from the denied call. **[Observed basis]**
4. **Hook deployment is now a correctness concern, not an ops detail.** The one measured failure
   mode that fails closed is exit 2. A missing or non-executable `pause-gate.sh` is exit 127 and is
   unmeasured (ADR 0001 Q9) — verifying the hook path exists and is executable at run-spawn time,
   rather than discovering it at the first tool call, is the cheap mitigation until Q9 is measured.
   **[Proposed — the controller's call, not this task's]**

---

## 6. Artefacts

Throwaway, **not committed**, kept on disk for audit:

- `~/.aiteamos-m3-probe/crash-hook.sh`, `settings-q7.json`, `settings-q8.json`
- `~/.aiteamos-m3-probe/q7-capture.jsonl` (37 lines), `~/.aiteamos-m3-probe/q8-capture.jsonl` (34 lines)
- `~/.aiteamos-m3-probe/q7-workdir/` (empty — the Q7 verdict), `~/.aiteamos-m3-probe/q8-workdir/target.txt`
- `~/.aiteamos-m3-probe/q8-pause.flag`

No product code was written. Repo changes are this document and ADR 0001's Open Questions and Known
Limitations sections.
