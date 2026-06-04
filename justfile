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
# is damage-control before agent-hub, so the hub recipes run with guardrails by default.
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

# ---------------------------------------------------------------- orchestration

# Accepts coms identity flags: --name --purpose --project --color --explicit
# Guarded agent hub: damage-control + dispatcher grid + research helpers + embedded coms
hub *args:
    pi -e .pi/harnesses/damage-control/index.ts -e .pi/harnesses/agent-hub/index.ts {{args}}

# Agent hub (solo): guarded hub without the coms layer — fixed specialists + research only
hub-solo *args:
    pi -e .pi/harnesses/damage-control/index.ts -e .pi/harnesses/agent-hub/index.ts --solo {{args}}

# Coms peer: a reusable worker peer (coms + compact-and-continue + a persona).
# Positional args: persona [name] [model]. persona=<file under agents/, no .md>;
# falls back to legacy .pi/agents/ if needed. Args are POSITIONAL — no key=value.
# e.g. just peer architect architect anthropic/claude-opus-4-7
peer persona name="" model="":
    persona_path="agents/{{persona}}.md"; if [ ! -f "$persona_path" ]; then persona_path=".pi/agents/{{persona}}.md"; fi; pi -e .pi/harnesses/coms/index.ts -e .pi/extensions/compact-and-continue/index.ts --append-system-prompt "$persona_path" {{ if name != "" { "--name " + name } else { "" } }} {{ if model != "" { "--model " + model } else { "" } }}

# Team up: spawn every peer of a team from .pi/agents/peers.yaml into tmux panes.
# Positional arg: team (defaults to "full"). e.g. just team-up full
team-up team="full":
    node --experimental-strip-types scripts/team-up.ts --team {{team}}

# Team up (dry run): print the resolved per-peer commands without launching tmux.
# e.g. just team-up-dry full
team-up-dry team="full":
    node --experimental-strip-types scripts/team-up.ts --team {{team}} --dry-run

# Pi Pi: meta-agent that builds pi agents via parallel expert research
ext-pi-pi:
    pi -e .pi/harnesses/pi-pi/index.ts

# ---------------------------------------------------------------- coms (Pi-to-Pi messaging)

# Coms: peer-to-peer messaging between pi agents on the same machine
local-coms *args:
    pi -e .pi/harnesses/coms/index.ts {{args}}

# Start a local coms-net hub (binds 127.0.0.1, OS-assigned port)
coms-net-server:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    node --experimental-strip-types scripts/coms-net-server.ts

# Start a LAN-visible coms-net hub (binds 0.0.0.0, requires PI_COMS_NET_AUTH_TOKEN)
coms-net-server-lan:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    PI_COMS_NET_HOST=0.0.0.0 node --experimental-strip-types scripts/coms-net-server.ts

# Pi with the networked coms-net client (auto-discovers the local server.json)
coms *args:
    pi -e .pi/harnesses/coms-net/index.ts {{args}}
# <<< agent-skills:harnesses <<<
