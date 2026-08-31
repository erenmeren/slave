# Provider stream fixtures: what each one is, and where it came from

Every file here is a captured `stream-json` transcript, with exactly one declared exception
(`permission-matrix-deny.ndjson` — see its own section below): the parsers under
`packages/providers/src` are written **from recordings**, never from documentation (the M12
discipline), and these files are the recordings. Hand-authored JSON is not the default here; it is
the narrow, documented fallback for a shape no build of the real CLI could yet produce.

## Layout, and why it is not flat

```
fixtures/
  *.ndjson          replay modes for the fake CLI  -- `fake-claude.mjs --fixture <basename>`
  claude/           Claude recordings that are NOT replay modes
  cursor/           Cursor recordings
```

**The top level is a namespace, not a folder.** `fake-claude.mjs` resolves `--fixture <name>` to
`fixtures/<name>.ndjson`, so every `*.ndjson` sitting directly in this directory is a selectable
mode of the fake CLI — and `fake-claude.test.ts`'s "every fixture file ends with the routine Stop
hook line" enumerates exactly that directory and holds all of them to the shape a replayable
transcript needs. A recording that is only ever read by a parser test does not belong to that
namespace and cannot always satisfy that invariant (see `claude/README.md` for the one that
cannot), so it goes in a subdirectory — the same reason `cursor/` is one.

`readdir` here is not recursive, so subdirectories are outside the invariant by construction.

## `claude/` — parser recordings

See `claude/README.md`. Currently one file: `skill-tool-use.ndjson`, the `Skill` tool_use
recording made for M14 §4.1.

## `cursor/` — Cursor recordings

- `cursor/cursor-run.ndjson` — the M12 `cursor-agent` capture that `cursor-stream.test.ts` and
  `cursor-adapter.test.ts` read.
- `cursor/gate/` — the M13 Task 9 pause-gate evidence, six files from two `cursor-agent` runs.
  Its own `README.md` carries the full provenance, the redaction, and the spend, and is the shape
  every README in this tree follows.

## The fake-CLI replay modes

These are the M3/M8 captures, plus one later, deliberately hand-authored exception (see its own
section below the table). Provenance for the twelve captures below is reconstructed from the files
themselves and from `git log` — they predate this README, and no contemporaneous recording note
was written for them, which is precisely the gap this file and `claude/README.md` exist to close
going forward. Everything stated here is checkable against the bytes on disk.

Facts common to the twelve CAPTURED recordings (`permission-matrix-deny.ndjson` is the exception —
see below): `claude_code_version` **2.1.234**, `model` `claude-opus-5[1m]`, and a `cwd` of
`/fake/claude-workdir/<mode>` with a `session_id` of `fake-session-<mode>` — i.e. the workdir and
session identifiers were rewritten to fixture-scoped placeholders at capture time. Note that the
`init` line's `plugins[].path` and `memory_paths` were **not** rewritten and still carry the
recording operator's home directory; `claude/skill-tool-use.ndjson` redacts those, and these files
should be brought in line the next time they are touched.

| File | Introduced | What it records |
| --- | --- | --- |
| `complete.ndjson` | `b17561c` | The clean run: `Write` then `Bash`, both `PreToolUse` hooks allowing, `result` `is_error: false`, 3 turns, $0.209. The baseline every other mode is read against. |
| `crash.ndjson` | `b17561c` | Byte-identical in shape to `complete`; the *crash* is produced at replay time, by `fake-claude.mjs` writing only the first half of the lines and exiting 1. Truncating the file itself would have made the fixture a lie about what the CLI emitted. |
| `hook-deny.ndjson` | `b17561c` | The pause: `Read` allowed, then `Edit` met a `PreToolUse` hook whose `output` is a JSON-encoded deny payload (`"Paused by AI Team OS. Stop and wait."`), exit 0. The double-parse trap in `stream.ts` is measured here. `permission_denials` carries the denied `tool_use_id`. |
| `hook-crash.ndjson` | `b17561c` | Three `PreToolUse` hooks exiting **2** — the blocking crash. The tool never ran, and all three ids land in `permission_denials`. |
| `hook-fail-open.ndjson` | `b17561c` | `PreToolUse` hooks exiting 127, 126 and 1 — nonzero and not 2, so the tool **ran anyway**. Zero `permission_denials`, which is the observable difference from `hook-crash`. Also the only fixture carrying a `PostToolUse` response. |
| `hook-never-invoked.ndjson` | `7ce5abb` | `complete`'s transcript with every `PreToolUse` line removed: tool calls proceeding with no gate response of any shape. The adapter's runtime backstop (spec §5.5) reads this as "the hook was never installed", not as "the hook allowed". |
| `permission-denied.ndjson` | `b17561c` | A `system`/`permission_denied` line — the permission *mode* refusing an `Edit`. Deliberately kept distinct from `hook-deny`: conflating the two would report an operator pause where there was none. |
| `malformed.ndjson` | `b17561c` | Contains one line that is not JSON. The parser must return `unparsable` for it and keep going; a bad line must not kill a run. |
| `review-approve.ndjson`, `review-reject.ndjson`, `review-invalid.ndjson` | `a16add4` | `complete`'s transcript with the final `result.result` replaced by the reviewer's JSON verdict — approve, reject, and a malformed verdict. They drive the fake CLI's `m8a-flow` mode. |
| `plan-graph.ndjson` | `e8f2bb0` | Same base, with `result.result` carrying a planning task graph. Drives `m8-flow`'s planning arm. |
| `permission-matrix-deny.ndjson` | M18 Task 6 fix round 1 | **Hand-authored, not captured — see the section below.** `Read` allowed, then `Bash` met a `PreToolUse` hook denying with the M18 permission-matrix grammar (`permission matrix denies 'run tests' (Bash) for this agent`), the agent adapts and reports instead of retrying, and the `result` line is honest about the denial: `is_error: false` but `permission_denials` carries `toolu_pmd_002`, matching what `hook-deny.ndjson` itself measures the real CLI doing for a hook deny of any kind. |

The three review fixtures and `plan-graph` share `complete`'s `session_id`
(`fake-session-complete`) because they are edits of it, not separate captures.

## `permission-matrix-deny.ndjson` — the one hand-authored exception

Unlike every other fixture in this directory, `permission-matrix-deny.ndjson` is **not** a captured
recording. It is modeled byte-for-byte on `hook-deny.ndjson`'s own narrative shape (allow the first
tool, deny the second, the agent adapts, a clean-but-honest result, the routine `Stop` tail) with
the deny's `permissionDecisionReason` swapped for the M18 permission-matrix grammar
(`permission matrix denies '<capability>' (<tool>) for this agent`, `packages/providers/src/gate.ts`)
and the `result` line's `permission_denials` carrying the denied `toolu_pmd_002` — matching, not
omitting, what `hook-deny.ndjson` itself measures the real CLI doing for a hook deny regardless of
*why* the hook denied (M18 Task 6 fix round 1, review Critical 1: an early version of this fixture
omitted `permission_denials` to make the integration test's run conclude `succeeded`, which removed
the very signal `pump.ts`'s failure computation needed fixing, rather than fixing it).

**Why hand-authored rather than captured**: the permission matrix (M18) is new within this same
milestone, and no build of `claude` (or `cursor-agent`) able to actually produce a matrix-denied
`PreToolUse` hook response existed to record from when this fixture was needed — a real capture
requires the shell gate's M18 Task 3/4 wiring already deployed against a live CLI run, which is
downstream of the very work this fixture exists to test. **A real capture is a queued backlog
item**; when one lands, this file should be replaced by the genuine recording (its ids and reason
text mechanically substituted per rule 2 below) rather than kept as a hand-authored stand-in
indefinitely.

It also does not carry the "facts common to the twelve captured recordings" noted above: its `init`
line is schema-minimal (`type`, `subtype`, `session_id` — exactly the fields `parseStreamLine`'s
zod schemas read) rather than a full `claude_code_version`/`model`/`cwd`/tool-inventory line, because
there is no real capture to draw those fields from honestly; inventing plausible-looking values for
them would be a second fabrication stacked on the first, not a fix for it. `session_id` DOES follow
the shared convention (`fake-session-permission-matrix-deny`).

## Redaction rules for anything added here

1. Keep the stream **byte for byte** except for mechanical substitutions.
2. Name every substitution, as a runnable command, in the README beside the file.
3. Redact: the operator's email address, home directory paths, transcript/session **paths**, and
   any path carrying a UID or a PID (`messaging_socket_path` is the one the CLI emits — it was
   missed on the first pass of `claude/skill-tool-use.ndjson` and caught in review). Session *ids*
   stay — they are random UUIDs, and the parser reads them.
4. Never add, remove or reorder a line to make a fixture fit a test. If a real recording does not
   fit, the fixture is right and its placement is wrong.

These four govern every fixture that starts from a real recording. `permission-matrix-deny.ndjson`
is the one declared exception to rules 1 and 4 — there is no real recording for it to keep byte for
byte or to defer to — and its own section above states why, in the open, rather than silently
breaking the discipline. It still follows rule 3's redaction rules (nothing to redact: every value
in it is either a fixture-scoped placeholder or the M18 grammar itself) and rule 2's spirit, by
naming the substitution it stands in for.
