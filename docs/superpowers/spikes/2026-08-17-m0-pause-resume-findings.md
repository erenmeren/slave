# M0 Spike — Pause / Resume Findings

**Date:** 2026-08-17
**Question:** Can a Claude Code run be paused at a tool-call boundary and resumed from its
session id inside a git worktree, with a human instruction injected on resume?

## 0. Environment

- `claude --version`: 2.1.233 (Claude Code)
- Relevant flags observed in `--help`:
  - **Headless/Print mode:** `-p, --print` (Print response and exit; useful for pipes and non-interactive output)
  - **Output format and streaming:**
    - `--output-format <format>` (Options: "text" (default), "json" (single result), or "stream-json" (realtime streaming); only works with --print)
    - `--include-partial-messages` (Include partial message chunks as they arrive; only works with --print and --output-format=stream-json)
  - **Session resume:**
    - `-r, --resume [value]` (Resume a conversation by session ID, or open interactive picker with optional search term)
    - `-c, --continue` (Continue the most recent conversation in the current directory)
    - `--session-id <uuid>` (Use a specific session ID for the conversation; must be a valid UUID)
    - `--fork-session` (When resuming, create a new session ID instead of reusing the original; use with --resume or --continue)
  - **Settings file:**
    - `--settings <file-or-json>` (Path to a settings JSON file or a JSON string to load additional settings from)
    - `--setting-sources <sources>` (Comma-separated list of setting sources to load: user, project, local)
  - **Allowed tools:**
    - `--allowedTools, --allowed-tools <tools...>` (Comma or space-separated list of tool names to allow; e.g., "Bash(git *) Edit")
    - `--disallowedTools, --disallowed-tools <tools...>` (Comma or space-separated list of tool names to deny; e.g., "Bash(git *) Edit")
    - `--tools <tools...>` (Specify the list of available tools from the built-in set; use "" to disable all tools, "default" to use all tools, or specify tool names)
  - **Permission mode:**
    - `--permission-mode <mode>` (Choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")

## 1. Headless run and event stream

<filled by Task 2>

## 2. Session resume

<filled by Task 3>

## 3. Tool-call interception via PreToolUse hook

<filled by Task 4>

## 4. Resume after pause with instruction injection

<filled by Task 5>

## 5. Worktree isolation

<filled by Task 6>

## 6. Verdict and consequences for M3

<filled by Task 7>
