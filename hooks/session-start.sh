#!/bin/bash
# agent-skills session start hook (Claude Code).
#
# Two responsibilities:
#   1. Inject the using-agent-skills meta-skill into the session context so
#      Claude can route tasks to the right skill.
#   2. Surface a one-line "update available" banner when the installed
#      package is behind the published version on npm.
#
# Both are best-effort. Network errors, missing files, and missing tools
# never block session start — the hook always exits 0 and prints a valid
# JSON object on stdout.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_ROOT="$(dirname "$SCRIPT_DIR")"
SKILLS_DIR="$PACKAGE_ROOT/skills"
META_SKILL="$SKILLS_DIR/using-agent-skills/SKILL.md"
CHECK_SCRIPT="$PACKAGE_ROOT/bin/cli.js"

# ── 1. Meta-skill content ────────────────────────────────────────────────
if [ -f "$META_SKILL" ]; then
  META_CONTENT=$(cat "$META_SKILL")
  PRIORITY="IMPORTANT"
  BASE_MESSAGE="agent-skills loaded. Use the skill discovery flowchart to find the right skill for your task."
else
  META_CONTENT=""
  PRIORITY="INFO"
  BASE_MESSAGE="agent-skills: using-agent-skills meta-skill not found. Skills may still be available individually."
fi

# ── 2. Update banner (silent on any error) ───────────────────────────────
UPDATE_BANNER=""
if [ "$AGENT_SKILLS_NO_UPDATE_CHECK" != "1" ] \
   && [ "$NO_UPDATE_NOTIFIER" != "1" ] \
   && [ "$CI" != "true" ] \
   && command -v node >/dev/null 2>&1 \
   && [ -f "$CHECK_SCRIPT" ]; then
  # Run with a 3-second wall-clock cap so a hung registry never stalls the
  # session. The check-update subcommand emits the banner on stdout when an
  # upgrade is available, nothing otherwise. Errors go to /dev/null.
  if command -v timeout >/dev/null 2>&1; then
    UPDATE_BANNER=$(timeout 3 node "$CHECK_SCRIPT" check-update 2>/dev/null || true)
  else
    UPDATE_BANNER=$(node "$CHECK_SCRIPT" check-update 2>/dev/null || true)
  fi
fi

# ── Compose the message ──────────────────────────────────────────────────
FULL_MESSAGE="$BASE_MESSAGE"
if [ -n "$UPDATE_BANNER" ]; then
  FULL_MESSAGE=$(printf '%s\n\n%s' "$FULL_MESSAGE" "$UPDATE_BANNER")
fi
if [ -n "$META_CONTENT" ]; then
  FULL_MESSAGE=$(printf '%s\n\n%s' "$FULL_MESSAGE" "$META_CONTENT")
fi

# ── Emit JSON (node handles escaping correctly) ──────────────────────────
if command -v node >/dev/null 2>&1; then
  printf '%s' "$FULL_MESSAGE" | node -e '
    let msg = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { msg += c; });
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({
        priority: process.env.PRIORITY || "INFO",
        message: msg,
      }) + "\n");
    });
  '
else
  # Fallback: ship just the base message with minimal escaping.
  SAFE_MSG=$(printf '%s' "$BASE_MESSAGE" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"priority": "%s", "message": "%s"}\n' "$PRIORITY" "$SAFE_MSG"
fi
