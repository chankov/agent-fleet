#!/bin/bash
# swe-skills session start hook
# Injects the using-swe-skills meta-skill into every new session

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$(dirname "$SCRIPT_DIR")/skills"
META_SKILL="$SKILLS_DIR/using-swe-skills/SKILL.md"

if [ -f "$META_SKILL" ]; then
  CONTENT=$(cat "$META_SKILL")
  # Output as JSON for Claude Code hook consumption
  cat <<EOF
{
  "priority": "IMPORTANT",
  "message": "swe-skills loaded. Use the skill discovery flowchart to find the right skill for your task.\n\n$CONTENT"
}
EOF
else
  echo '{"priority": "INFO", "message": "swe-skills: using-swe-skills meta-skill not found. Skills may still be available individually."}'
fi
