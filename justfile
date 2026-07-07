# Justfile — pi extension harnesses
#
# Recipes to launch pi with the harness extensions under .pi/harnesses/.
# Ported and adapted from disler/pi-vs-claude-code (MIT) — https://github.com/disler/pi-vs-claude-code
# See docs/pi-extensions.md for the full catalog and the selective-load model.
#
# Why .pi/harnesses/ and not .pi/extensions/: pi auto-discovers EVERY directory
# under .pi/extensions/, so anything placed there loads on every plain `pi` run.
# Most harnesses are mutually exclusive — they live in .pi/harnesses/ (which pi
# does NOT auto-discover) and are loaded via `pi -e` below. The supported stack
# is a damage-control variant before agent-hub (damage-control-continue for the main
# session), so the hub recipes run with guardrails by default.
#
# Everything between the two `agent-skills:harnesses` sentinels below is a
# MANAGED REGION: guided-workspace-setup regenerates it from the installed
# package whenever pi harnesses are installed, refreshed, or retired — so edits
# inside it are overwritten on upgrade. Put your own recipes OUTSIDE the
# sentinels (above the opening marker or below the closing one) to keep them.

# >>> agent-skills:harnesses — managed region (regenerated on upgrade; edits inside are overwritten) >>>
set dotenv-load := true

# List all recipes
default:
    @just --list

# ---------------------------------------------------------------- setup

# Install the shared runtime dependencies for the pi extensions + harnesses
install:
    npm install --prefix .pi/extensions
    npm install --prefix .pi/harnesses

# Default pi — only the always-on utilities auto-load, no harness
pi:
    pi

# ---------------------------------------------------------------- safety

# Damage-control: block destructive tool calls (aborts the turn)
ext-damage-control:
    pi -e .pi/harnesses/damage-control/index.ts

# Damage-control (continue): same rules, but blocks deliver feedback so the agent adapts
# and keeps working instead of aborting the turn. Default guardrail for the hub main agent.
ext-damage-control-continue:
    pi -e .pi/harnesses/damage-control-continue/index.ts

# ---------------------------------------------------------------- orchestration

# Accepts coms identity flags: --name --purpose --project --color --explicit.
# Loads the orchestrator persona by default (the Verification-Contract dispatcher that owns
# the acceptance assertions — see skills/orchestration-verification); it is appended only if
# agents/orchestrator.md is installed, so the hub still launches when it is absent. Override
# with your own --system-prompt <persona>.md passed after `just hub`.
# Guarded agent hub: damage-control-continue + dispatcher grid + research helpers + embedded coms + orchestrator.
# The main session loads the CONTINUE guardrail (blocks feed back so the dispatcher adapts and keeps going);
# spawned specialists still inherit the hard-stop damage-control variant (research helpers inherit continue).
hub *args:
    persona=""; if [ -f agents/orchestrator.md ]; then persona="--append-system-prompt agents/orchestrator.md"; fi; pi -e .pi/harnesses/damage-control-continue/index.ts -e .pi/harnesses/agent-hub/index.ts $persona {{args}}

# Agent hub (solo): guarded hub without the coms layer — fixed specialists + research only.
# Same orchestrator-persona default and continue-guardrail main session as `just hub`.
hub-solo *args:
    persona=""; if [ -f agents/orchestrator.md ]; then persona="--append-system-prompt agents/orchestrator.md"; fi; pi -e .pi/harnesses/damage-control-continue/index.ts -e .pi/harnesses/agent-hub/index.ts --solo $persona {{args}}

# Internal helper for team-up: launch a reusable coms peer (coms + compact-and-continue + a persona).
# Prints a colored identity banner (peer name + persona purpose) before pi starts,
# so every pane announces who lives in it — works in any terminal, herdr or not.
# Hidden from `just --list` because recipes prefixed with `_` are private.
_peer persona name="" model="" session="":
    node --experimental-strip-types scripts/peer-banner.ts {{persona}} {{name}} 2>/dev/null || true; persona_path="agents/{{persona}}.md"; if [ ! -f "$persona_path" ]; then persona_path=".pi/agents/{{persona}}.md"; fi; pi -e .pi/harnesses/coms/index.ts -e .pi/extensions/compact-and-continue/index.ts --append-system-prompt "$persona_path" {{ if name != "" { "--name " + name } else { "" } }} {{ if model != "" { "--model " + model } else { "" } }} {{ if session != "" { "--session " + session } else { "" } }}

# Like _peer, but also loads extra always-on extensions (comma-separated names under
# .pi/extensions/) into the peer process — e.g. a chrome-devtools-mcp browser-debug peer
# whose `chrome_devtools__*` tools a normal --no-extensions subagent could not get.
_peer-plus extensions persona name="" model="" session="":
    node --experimental-strip-types scripts/peer-banner.ts {{persona}} {{name}} 2>/dev/null || true; persona_path="agents/{{persona}}.md"; if [ ! -f "$persona_path" ]; then persona_path=".pi/agents/{{persona}}.md"; fi; extra=""; old_ifs="$IFS"; IFS=','; for x in {{extensions}}; do x="$(echo "$x" | xargs)"; if [ -n "$x" ]; then extra="$extra -e .pi/extensions/$x/index.ts"; fi; done; IFS="$old_ifs"; pi -e .pi/harnesses/coms/index.ts -e .pi/extensions/compact-and-continue/index.ts $extra --append-system-prompt "$persona_path" {{ if name != "" { "--name " + name } else { "" } }} {{ if model != "" { "--model " + model } else { "" } }} {{ if session != "" { "--session " + session } else { "" } }}

# Internal helper for team-up: a `runner: claude-code` peer — interactive
# Claude Code plus its coms bridge (scripts/coms-claude-bridge.ts) in ONE pane.
# The bridge registers the pane as coms peer <name>; the trailing session
# positional maps to `claude --resume <id>` for team-resume.
_claude-peer name model="" session="":
    node --experimental-strip-types scripts/coms-claude-bridge.ts --name {{name}} & bridge_pid=$!; trap 'kill $bridge_pid 2>/dev/null' EXIT; claude {{ if model != "" { "--model " + model } else { "" } }} {{ if session != "" { "--resume " + session } else { "" } }}

# Team up: spawn every peer of a team from .pi/agents/peers.yaml into a herdr
# workspace (one tiled pane per peer). Requires a running herdr server.
# Positional arg: team (defaults to "full"). e.g. just team-up full
team-up team="full":
    node --experimental-strip-types scripts/team-up.ts --team {{team}}

# Team up (dry run): print the resolved layout + per-peer commands without touching herdr.
# e.g. just team-up-dry team="full"
team-up-dry team="full":
    node --experimental-strip-types scripts/team-up.ts --team {{team}} --dry-run

# Hub + team in ONE herdr workspace: the guarded hub (`just hub`) in a larger
# main pane, the team's peers tiled beside it. e.g. just hub-team docs
hub-team team="full":
    node --experimental-strip-types scripts/team-up.ts --team {{team}} --hub

# Hub + team (dry run): print the combined layout without touching herdr.
hub-team-dry team="full":
    node --experimental-strip-types scripts/team-up.ts --team {{team}} --hub --dry-run

# Snapshot a RUNNING team's session refs to ~/.pi/team-snapshots/<team>.json
# (team keeps running — take one proactively so a crash is resumable).
team-snapshot team="full":
    node --experimental-strip-types scripts/team-snapshot.ts snapshot {{team}}

# Snapshot, then close the team workspace cleanly (peers get SIGTERM).
team-down team="full":
    node --experimental-strip-types scripts/team-snapshot.ts down {{team}}

# Rebuild a team from its snapshot — each pi peer resumes its previous
# conversation (`pi --session <ref>`); peers whose ref is gone start fresh.
team-resume team="full":
    node --experimental-strip-types scripts/team-snapshot.ts resume {{team}}

# ---------------------------------------------------------------- coms (Pi-to-Pi messaging)

# Safe coms: a FULL pi (all auto-discovered local .pi/extensions/ + global extensions and
# commands) plus damage-control-continue guardrails and the coms peer layer, under a chosen name.
# Unlike `just hub`, this does NOT pass --no-extensions, so every local-only extension (MCP
# bridges like chrome-devtools-mcp, project-specific extensions, …) loads into THIS process.
# Use it as the agent-hub dispatcher/orchestrator peer that needs those local tools: spawned
# specialists run --no-extensions, so the tools stay scoped here and never leak into subagents.
# The required `name` becomes this peer's coms identity (--name), so it is discoverable
# under exactly that name to other coms peers in the project pool.
# e.g. just safe-coms orchestrator --project proj
safe-coms name *args:
    pi -e .pi/harnesses/damage-control-continue/index.ts -e .pi/harnesses/coms/index.ts --name {{name}} {{args}}
# <<< agent-skills:harnesses <<<
