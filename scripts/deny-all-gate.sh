#!/usr/bin/env sh
# The PreToolUse hook a simulation's model call registers (M31a §4): every tool call is denied,
# whatever the tool, whatever the pause flag. The model must reach nothing; `--restricted
# --strict-mcp-config --tools ""` already gives it no tools, and this is the second lock.
cat > /dev/null
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"simulation actors get no tools"}}'
exit 0
