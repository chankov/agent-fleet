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
# loads damage-control-continue before agent-hub, so hub sessions and all native
# children run with guardrails by default.
#
# Everything between the two `agent-fleet:harnesses` sentinels below is a
# MANAGED REGION: `agent-fleet setup` regenerates it from the installed
# package whenever pi harnesses are installed, refreshed, or retired — so edits
# inside it are overwritten on upgrade. Put your own recipes OUTSIDE the
# sentinels (above the opening marker or below the closing one) to keep them.

# >>> agent-fleet:harnesses — managed region (regenerated on upgrade; edits inside are overwritten) >>>
set dotenv-load := true

# How recipes run the fleet TS scripts. The preserve-symlinks flags matter for
# symlink installs (`agent-fleet setup --method symlink`): there
# .pi/agent-fleet/scripts/*.ts are links whose realpath sits under .pi/npm/node_modules/, and
# Node refuses --experimental-strip-types for anything under node_modules once
# paths are realpath'd. Keeping symlink paths avoids that; copy installs are
# unaffected (the fleet scripts import only relative paths + node builtins).
node_ts := "node --experimental-strip-types --preserve-symlinks --preserve-symlinks-main"

# Fleet Core is the invariant Pi runtime used by every new `just fleet` mode and
# every Pi peer spawned into Herdr. `--no-extensions` makes the baseline
# deterministic; these modules are then loaded explicitly:
#   • damage-control-continue — fail-closed safety with actionable feedback;
#     also runs the shared Fleet Core update check once per session
#   • ask-user-remote         — stock local ask_user, optionally raced with Hermes
#   • compact-and-continue    — request_compaction at explicit workflow checkpoints
#   • btw                     — /btw and Alt+' side sessions
# `--browser` additionally loads chrome-devtools-mcp; `--voice` explicitly loads
# pi-voice-stt only after the voice feature has installed it. `--all-extensions` removes
# `--no-extensions`, so project/global auto-discovered extensions also load; use
# it only when a session intentionally needs extensions outside Fleet Core.
fleet_core_extensions := "-e .pi/harnesses/damage-control-continue/index.ts -e .pi/harnesses/ask-user-remote/index.ts -e .pi/extensions/compact-and-continue/index.ts -e .pi/extensions/btw/index.ts"
fleet_browser_extension := "-e .pi/extensions/chrome-devtools-mcp/index.ts"
fleet_voice_extension := "-e .pi/extensions/pi-voice-stt/index.ts"

# Show the complete Fleet command guide, descriptions, and runnable examples.
default:
    @just fleet help

# ---------------------------------------------------------------- unified Fleet interface

# Agent Fleet — one guarded Hub runtime with one operator, independent topology.
#
# UNIFIED HUB (recommended default)
#   just fleet                              # operator + the editor/researcher/reviewer roles
#   just fleet --no-coms                    # direct/native work, no peer messaging
#   just fleet --browser                    # add live Chrome DevTools tools
#   just fleet --voice                      # load installed push-to-talk STT
#   just fleet --all-extensions             # also auto-load project/global extensions
#
# ADDRESSABLE COMS PEER (its settings are its flags)
#   just fleet peer nick --project af
#   just fleet peer claude-reviewer --runner claude-code --read-only --project af
#   just fleet peer scout --model openai-codex/gpt-6-luna --env-file .env.peer
#
# HERDR (one pane: the Hub)
#   just fleet --herdr --project af
#   just fleet --herdr --project af --dry-run
#
# COMPATIBILITY (accepted with migration warnings)
#   just fleet hub --solo                   # use: just fleet --no-coms
#   just fleet team base --project af       # use: just fleet --herdr
#
# DETERMINISTIC FLOWS AND BRANCH MAINTENANCE
#   just flow scout "where is authentication configured?"
#   just flow poll --panel default "should we extract this module?"
#   just flow debate --panel default --rounds 3 "should we extract this module?"
#   just flow quality
#   just flow build-test "add the validated endpoint"
#   just flow cleanup                         # numbered selector
#   just flow cleanup 2                       # safe Worktrunk removal
#   just flow merge                           # numbered selector
#   just flow merge 2                         # Worktrunk squash merge to recorded source
#
# REMOTE CONDUCTOR (one pane: Hermes)
#   just fleet conductor hermes --project af
#
# NEW REPOSITORY SETUP (run from the target repository in a real TTY)
#   just fleet setup
#     Resolves npx @chankov/agent-fleet@latest and opens the installer TUI.
#     It needs npm registry access unless @latest is already cached.
#     Source checkout development: node bin/cli.js setup
#
# LIFECYCLE (npx equivalents work even after self-uninstall)
#   just fleet setup [--preset default|full --features none --yes]
#   just fleet deps                          # npm runtime deps only; starts no harness
#   just fleet doctor [--fix]
#   just fleet uninstall --all --yes       # --all is required for --yes
#   just fleet help
#
# Unified guarded Pi, Hub, peers, lifecycle, and conductor entry point.
fleet *args:
    @{{node_ts}} .pi/agent-fleet/scripts/fleet.ts {{args}}

# Headless workflows plus `flow cleanup` / `flow merge` Worktrunk branch maintenance.
# Exits 0 accepted/success; 1 rejected/failed; 2 invalid/unknown; 3 refused start.
flow *args:
    @{{node_ts}} .pi/agent-fleet/scripts/flow.ts {{args}}

# Hidden Fleet Core launcher. Positional booleans are emitted only by fleet.ts.
_fleet-core browser="false" voice="false" all_extensions="false" *args:
    discovery="--no-extensions"; if [ "{{all_extensions}}" = "true" ]; then discovery=""; fi; browser_ext=""; if [ "{{browser}}" = "true" ]; then browser_ext="{{fleet_browser_extension}}"; fi; voice_ext=""; if [ "{{voice}}" = "true" ]; then voice_ext="{{fleet_voice_extension}}"; fi; {{node_ts}} .pi/agent-fleet/scripts/pi-session.ts $discovery {{fleet_core_extensions}} $browser_ext $voice_ext {{args}}

# Hidden entry point for `just fleet peer <name>`: builds the peer from its flags
# (runner, persona, model, read-only, env file) and launches it in a pane of its
# own — splitting the current pane inside herdr, else creating a one-pane
# workspace. `--here` runs it in the calling terminal instead.
_fleet-peer-launch *args:
    {{node_ts}} .pi/agent-fleet/scripts/peer-launch.ts {{args}}

# Hidden guarded peer launcher for an interactive, addressable Fleet node with no
# persona: Fleet Core + coms + Chrome DevTools MCP under `--name`, plus raw pi
# arguments. Reached via `just fleet peer <name>` when no persona resolves.
_fleet-peer name *args:
    {{node_ts}} .pi/agent-fleet/scripts/pi-session.ts --no-extensions {{fleet_core_extensions}} -e .pi/harnesses/coms/index.ts {{fleet_browser_extension}} --name {{name}} {{args}}

# Hidden Hub launcher. Agent Hub re-loads Damage Control into every native
# specialist, researcher, and nested delegate even though children use
# --no-extensions. `solo=true` disables only the embedded coms layer.
_fleet-hub solo="false" browser="false" voice="false" all_extensions="false" *args:
    discovery="--no-extensions"; if [ "{{all_extensions}}" = "true" ]; then discovery=""; fi; browser_ext=""; if [ "{{browser}}" = "true" ]; then browser_ext="{{fleet_browser_extension}}"; fi; voice_ext=""; if [ "{{voice}}" = "true" ]; then voice_ext="{{fleet_voice_extension}}"; fi; solo_flag=""; if [ "{{solo}}" = "true" ]; then solo_flag="--solo"; fi; {{node_ts}} .pi/agent-fleet/scripts/pi-session.ts $discovery {{fleet_core_extensions}} -e .pi/harnesses/agent-hub/index.ts $browser_ext $voice_ext $solo_flag {{args}}

# Repair the active standalone Linux Codex release after a group-writable installation.
_fleet-fix-codex-permissions:
    @{{node_ts}} .pi/agent-fleet/scripts/fix-codex-permissions.ts

# Hidden dependency installer used by `just fleet deps`.
# It installs only Node runtime dependencies. It does NOT launch Pi, activate a
# harness, configure STT, install ffmpeg/Herdr, or pair a remote conductor.
_fleet-deps:
    npm install --prefix .pi/extensions
    npm install --prefix .pi/harnesses
    npm install --prefix .pi/agent-fleet/scripts

# Deterministic lifecycle CLI. `setup` always resolves the published latest
# package; it needs registry access unless the matching npm cache entry exists.
_fleet-lifecycle command *args:
    npx @chankov/agent-fleet@latest {{command}} {{args}}


# Hidden guarded persona peer for `just fleet peer <name>` and the Hub's
# herdr_spawn_peer: Fleet Core + coms + Chrome DevTools MCP + its persona. Every
# Pi peer loads that one extra extension (PLAN-11-01, D17); `--no-extensions`
# keeps the rest deterministic.
# AGENT_FLEET_SPAWN_DELAY lets one pane refresh a stale shared OAuth token before
# a sibling Pi process starts. Hidden recipes (`_...`) do not appear in --list.
_peer persona name="" model="" project="default":
    d="${AGENT_FLEET_SPAWN_DELAY:-0}"; if [ "$d" != "0" ]; then echo "⏳ waiting ${d}s for the pi auth pre-warm (stale OAuth token)"; sleep "$d"; fi; {{node_ts}} .pi/agent-fleet/scripts/peer-banner.ts {{persona}} {{name}} 2>/dev/null || true; persona_path=""; for pd in agents .claude/agents .pi/agents/personas .pi/agents; do if [ -f "$pd/{{persona}}.md" ]; then persona_path="$pd/{{persona}}.md"; break; fi; done; if [ -z "$persona_path" ]; then persona_path=".pi/agents/personas/{{persona}}.md"; fi; {{node_ts}} .pi/agent-fleet/scripts/pi-session.ts --no-extensions {{fleet_core_extensions}} -e .pi/harnesses/coms/index.ts {{fleet_browser_extension}} --project {{project}} --append-system-prompt "$persona_path" {{ if name != "" { "--name " + name } else { "" } }} {{ if model != "" { "--model " + model } else { "" } }}

# Read-only sibling of `_peer` (`just fleet peer <name> --read-only` on a pi
# persona peer). Same positionals and Fleet Core runtime but no extra extension
# (D17); pi's `--tools` allowlist fixes the tool set at launch to read,grep,find,ls
# (pi drops every other tool from its registry — extension tools and coms_*
# included, so the peer cannot ask a writable peer to act), `--no-mcp` keeps MCP
# servers out, and `--coms-read-only` asks coms to declare `read_only: true` —
# which it does only after verifying that tool set itself at registration.
# Inbound requests are still answered: the coms runtime sends the reply when the
# turn settles, without a tool call.
_peer-read-only persona name="" model="" project="default":
    d="${AGENT_FLEET_SPAWN_DELAY:-0}"; if [ "$d" != "0" ]; then echo "⏳ waiting ${d}s for the pi auth pre-warm (stale OAuth token)"; sleep "$d"; fi; {{node_ts}} .pi/agent-fleet/scripts/peer-banner.ts {{persona}} {{name}} 2>/dev/null || true; persona_path=""; for pd in agents .claude/agents .pi/agents/personas .pi/agents; do if [ -f "$pd/{{persona}}.md" ]; then persona_path="$pd/{{persona}}.md"; break; fi; done; if [ -z "$persona_path" ]; then persona_path=".pi/agents/personas/{{persona}}.md"; fi; {{node_ts}} .pi/agent-fleet/scripts/pi-session.ts --no-extensions {{fleet_core_extensions}} -e .pi/harnesses/coms/index.ts --coms-read-only --tools read,grep,find,ls --no-mcp --project {{project}} --append-system-prompt "$persona_path" {{ if name != "" { "--name " + name } else { "" } }} {{ if model != "" { "--model " + model } else { "" } }}

# Hidden helper for a `--runner claude-code` peer — interactive Claude Code plus
# its coms bridge (.pi/agent-fleet/scripts/coms-claude-bridge.ts) in ONE pane.
# The bridge registers the pane as coms peer <name>.
_claude-peer name model="" project="default":
    {{node_ts}} .pi/agent-fleet/scripts/claude-code-preflight.ts || exit $?; {{node_ts}} .pi/agent-fleet/scripts/coms-claude-bridge.ts --name {{name}} --project {{project}} & bridge_pid=$!; trap 'kill $bridge_pid 2>/dev/null' EXIT; {{node_ts}} .pi/agent-fleet/scripts/exec-at-target.ts claude {{ if model != "" { "--model " + model } else { "" } }}

# Read-only sibling of `_claude-peer` (`--runner claude-code --read-only`). The
# bridge runs in the FOREGROUND and launches Claude Code itself with enforced
# inspection-only tools (Read/Grep/Glob, no MCP servers, mutating tools denied);
# it declares `read_only: true` only because it chose that argv, and it
# deregisters when that Claude process exits.
_claude-peer-read-only name model="" project="default":
    {{node_ts}} .pi/agent-fleet/scripts/claude-code-preflight.ts || exit $?; {{node_ts}} .pi/agent-fleet/scripts/coms-claude-bridge.ts --name {{name}} --project {{project}} --read-only {{ if model != "" { "--model " + model } else { "" } }}

# One-pane Herdr workspaces (.pi/agent-fleet/scripts/herdr-hub.ts). The label
# is auto-scoped to the CHECKOUT — <worktree-tag>-hub-base, or
# <worktree-tag>-conductor-hermes-<name> — where the tag is the last dot-segment
# of this directory's basename (main.wt2 → wt2, plain agent-fleet → agent-fleet),
# so the same launch from different worktrees gets its own workspace. An
# existing workspace with that label is refused, never clobbered.
#
# `--project <name>` is a SEPARATE axis: it scopes the coms peer POOL. The flag
# form is `--project af`; `project=af` is NOT a flag — just treats bare
# key=value args as variable overrides, so it is silently ignored.

# The Hub alone in a Herdr pane:
#   just fleet --herdr --project af [--no-coms] [--browser] [--voice] [--dry-run]
_fleet-herdr *args:
    {{node_ts}} .pi/agent-fleet/scripts/herdr-hub.ts {{args}}

# The Hermes conductor alone in a Herdr pane (the name only labels the workspace):
#   just fleet conductor hermes [name] --project af [--dry-run]
_fleet-conductor name="full" *args:
    {{node_ts}} .pi/agent-fleet/scripts/herdr-hub.ts --conductor hermes --name {{name}} {{args}}
# <<< agent-fleet:harnesses <<<
