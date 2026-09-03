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
# scripts/*.ts are links whose realpath sits under .pi/npm/node_modules/, and
# Node refuses --experimental-strip-types for anything under node_modules once
# paths are realpath'd. Keeping symlink paths avoids that; copy installs are
# unaffected (the fleet scripts import only relative paths + node builtins).
node_ts := "node --experimental-strip-types --preserve-symlinks --preserve-symlinks-main"

# Fleet Core is the invariant Pi runtime used by every new `just fleet` mode and
# every Pi peer spawned into Herdr. `--no-extensions` makes the baseline
# deterministic; these modules are then loaded explicitly:
#   • damage-control-continue — fail-closed safety with actionable feedback
#   • ask-user-remote         — stock local ask_user, optionally raced with Hermes
#   • compact-and-continue    — request_compaction at explicit workflow checkpoints
#   • btw                     — /btw and Alt+' side sessions
#   • update check            — bounded, non-blocking package update notification
# `--browser` additionally loads chrome-devtools-mcp; `--voice` explicitly loads
# pi-voice-stt only after the voice feature has installed it. `--all-extensions` removes
# `--no-extensions`, so project/global auto-discovered extensions also load; use
# it only when a session intentionally needs extensions outside Fleet Core.
fleet_core_extensions := "-e .pi/harnesses/damage-control-continue/index.ts -e .pi/harnesses/ask-user-remote/index.ts -e .pi/extensions/compact-and-continue/index.ts -e .pi/extensions/btw/index.ts -e .pi/extensions/agent-fleet-update-check/index.ts"
fleet_browser_extension := "-e .pi/extensions/chrome-devtools-mcp/index.ts"
fleet_voice_extension := "-e .pi/extensions/pi-voice-stt/index.ts"

# Show the complete Fleet command guide, descriptions, and runnable examples.
default:
    @just fleet help

# ---------------------------------------------------------------- unified Fleet interface

# Agent Fleet — one guarded Hub runtime, two work modes, independent topology.
#
# UNIFIED HUB (recommended default)
#   just fleet                              # operator + empty native roster
#   just fleet --agents frontend            # orchestrator + native roster
#   just fleet --work-mode operator --agents frontend
#   just fleet --no-coms                    # direct/native work, no peer messaging
#   just fleet --browser                    # add live Chrome DevTools tools
#   just fleet --voice                      # load installed push-to-talk STT
#   just fleet --all-extensions             # also auto-load project/global extensions
#
# ADDRESSABLE COMS PEER
#   just fleet peer nick --project af
#   just fleet peer code-reviewer --project af
#
# HERDR TOPOLOGY (preset names come from .pi/agents/peers.yaml)
#   just fleet --herdr --project af         # one Hub pane, no standing peers
#   just fleet --peers review --project af  # operator Hub + standing peers
#   just fleet --agents frontend --peers frontend --project af
#   just fleet --agents frontend --peers frontend --dry-run
#
# COMPATIBILITY (accepted with migration warnings)
#   just fleet hub --solo                   # use: just fleet --no-coms
#   just fleet team frontend --project af   # use canonical --agents/--peers flags
#   just fleet team frontend --no-hub       # legacy peers-only topology
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
# TEAM LIFECYCLE
#   just fleet snapshot frontend --project af
#   just fleet down frontend --project af
#   just fleet resume frontend --project af
#
# REMOTE CONDUCTORS
#   just fleet conductor hermes docs --project af
#   just fleet conductor codex setup docs --project af
#   just fleet conductor codex pair
#   just fleet conductor codex start
#   just fleet conductor codex docs --project af
#   just fleet conductor codex status
#   just fleet conductor codex stop
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
# Unified guarded Pi, Hub, peers, teams, lifecycle, and conductor entry point.
fleet *args:
    @{{node_ts}} scripts/fleet.ts {{args}}

# Headless workflows plus `flow cleanup` / `flow merge` Worktrunk branch maintenance.
# Exits 0 accepted/success; 1 rejected/failed; 2 invalid/unknown; 3 refused start.
flow *args:
    @{{node_ts}} scripts/flow.ts {{args}}

# Hidden Fleet Core launcher. Positional booleans are emitted only by fleet.ts.
_fleet-core browser="false" voice="false" all_extensions="false" *args:
    discovery="--no-extensions"; if [ "{{all_extensions}}" = "true" ]; then discovery=""; fi; browser_ext=""; if [ "{{browser}}" = "true" ]; then browser_ext="{{fleet_browser_extension}}"; fi; voice_ext=""; if [ "{{voice}}" = "true" ]; then voice_ext="{{fleet_voice_extension}}"; fi; pi $discovery {{fleet_core_extensions}} $browser_ext $voice_ext {{args}}

# Hidden entry point for `just fleet peer <name>`: resolves the peer (runner,
# persona, model, extensions from .pi/agents/peers.yaml or flags) and launches it
# in a pane of its own — splitting the current pane inside herdr, else creating a
# one-pane workspace. `--here` runs it in the calling terminal instead.
_fleet-peer-launch *args:
    {{node_ts}} scripts/peer-launch.ts {{args}}

# Hidden guarded peer launcher for an interactive, addressable Fleet node with no
# persona: Fleet Core + coms under `--name`, plus raw pi arguments. Reached via
# `just fleet peer <name>` when no persona resolves for the name.
_fleet-peer name browser="false" all_extensions="false" *args:
    discovery="--no-extensions"; if [ "{{all_extensions}}" = "true" ]; then discovery=""; fi; browser_ext=""; if [ "{{browser}}" = "true" ]; then browser_ext="{{fleet_browser_extension}}"; fi; pi $discovery {{fleet_core_extensions}} -e .pi/harnesses/coms/index.ts $browser_ext --name {{name}} {{args}}

# Hidden Hub launcher. Agent Hub re-loads Damage Control into every native
# specialist, researcher, and nested delegate even though children use
# --no-extensions. `solo=true` disables only the embedded coms layer.
_fleet-hub solo="false" browser="false" voice="false" all_extensions="false" *args:
    discovery="--no-extensions"; if [ "{{all_extensions}}" = "true" ]; then discovery=""; fi; browser_ext=""; if [ "{{browser}}" = "true" ]; then browser_ext="{{fleet_browser_extension}}"; fi; voice_ext=""; if [ "{{voice}}" = "true" ]; then voice_ext="{{fleet_voice_extension}}"; fi; solo_flag=""; if [ "{{solo}}" = "true" ]; then solo_flag="--solo"; fi; persona=""; if [ -f agents/orchestrator.md ]; then persona="--append-system-prompt agents/orchestrator.md"; fi; pi $discovery {{fleet_core_extensions}} -e .pi/harnesses/agent-hub/index.ts $browser_ext $voice_ext $solo_flag $persona {{args}}

# Hidden dependency installer used by `just fleet deps`.
# It installs only Node runtime dependencies. It does NOT launch Pi, activate a
# harness, configure STT, install ffmpeg/Herdr, or pair a remote conductor.
_fleet-deps:
    npm install --prefix .pi/extensions
    npm install --prefix .pi/harnesses

# Deterministic lifecycle CLI. `setup` always resolves the published latest
# package; it needs registry access unless the matching npm cache entry exists.
_fleet-lifecycle command *args:
    npx @chankov/agent-fleet@latest {{command}} {{args}}


# Internal helper for `fleet team`: launch a reusable GUARDED Pi peer.
# Every peer gets Fleet Core + coms + its persona. This closes the historical
# gap where Hub children and standalone peers were protected but Herdr Pi peers were
# not. `--no-extensions` keeps peer capabilities deterministic; declare extras
# such as chrome-devtools-mcp in .pi/agents/peers.yaml.
# AGENT_FLEET_SPAWN_DELAY lets one pane refresh a stale shared OAuth token before
# sibling Pi processes start. Hidden recipes (`_...`) do not appear in --list.
_peer persona name="" model="" session="" project="default":
    d="${AGENT_FLEET_SPAWN_DELAY:-0}"; if [ "$d" != "0" ]; then echo "⏳ waiting ${d}s for the pi auth pre-warm (stale OAuth token)"; sleep "$d"; fi; {{node_ts}} scripts/peer-banner.ts {{persona}} {{name}} 2>/dev/null || true; persona_path="agents/{{persona}}.md"; if [ ! -f "$persona_path" ]; then persona_path=".pi/agents/{{persona}}.md"; fi; pi --no-extensions {{fleet_core_extensions}} -e .pi/harnesses/coms/index.ts --project {{project}} --append-system-prompt "$persona_path" {{ if name != "" { "--name " + name } else { "" } }} {{ if model != "" { "--model " + model } else { "" } }} {{ if session != "" { "--session " + session } else { "" } }}

# Guarded peer plus comma-separated explicit extras from .pi/extensions/.
# Example peers.yaml entry:
#   extensions: chrome-devtools-mcp
# The extra tools stay in this reusable peer; Hub's headless specialists still
# run --no-extensions and therefore cannot accidentally inherit them.
_peer-plus extensions persona name="" model="" session="" project="default":
    d="${AGENT_FLEET_SPAWN_DELAY:-0}"; if [ "$d" != "0" ]; then echo "⏳ waiting ${d}s for the pi auth pre-warm (stale OAuth token)"; sleep "$d"; fi; {{node_ts}} scripts/peer-banner.ts {{persona}} {{name}} 2>/dev/null || true; persona_path="agents/{{persona}}.md"; if [ ! -f "$persona_path" ]; then persona_path=".pi/agents/{{persona}}.md"; fi; extra=""; old_ifs="$IFS"; IFS=','; for x in {{extensions}}; do x="$(echo "$x" | xargs)"; if [ -n "$x" ]; then extra="$extra -e .pi/extensions/$x/index.ts"; fi; done; IFS="$old_ifs"; pi --no-extensions {{fleet_core_extensions}} -e .pi/harnesses/coms/index.ts $extra --project {{project}} --append-system-prompt "$persona_path" {{ if name != "" { "--name " + name } else { "" } }} {{ if model != "" { "--model " + model } else { "" } }} {{ if session != "" { "--session " + session } else { "" } }}

# Internal team helper for a `runner: claude-code` peer — interactive
# Claude Code plus its coms bridge (scripts/coms-claude-bridge.ts) in ONE pane.
# The bridge registers the pane as coms peer <name>; the trailing session
# positional maps to `claude --resume <id>` for `just fleet resume`.
_claude-peer name model="" session="" project="default":
    {{node_ts}} scripts/coms-claude-bridge.ts --name {{name}} --project {{project}} & bridge_pid=$!; trap 'kill $bridge_pid 2>/dev/null' EXIT; claude {{ if model != "" { "--model " + model } else { "" } }} {{ if session != "" { "--resume " + session } else { "" } }}

# The hidden team implementations take the team as a positional arg (default "full")
# and pass everything after it straight to the script.
#
# Herdr workspace labels are auto-scoped to the CHECKOUT: <worktree-tag>-<mode>-<team>
# where the tag is the last dot-segment of this directory's basename (main.wt2 →
# wt2, ringithub.end2 → end2, plain agent-fleet → agent-fleet). So the same team
# launched from different repos/worktrees gets its own workspace (wt2-hub-plan vs
# end2-hub-plan) instead of colliding on a shared label. This is not global
# uniqueness: unrelated checkouts with the same basename/final dot-segment can
# still collide. Existing-workspace refusal prevents clobbering; it does not
# prove the labels are unique.
#
# `--project <name>` is a SEPARATE axis: it scopes the coms peer POOL. Without it
# every peer lands in the shared "default" pool, where teams launched from OTHER
# repos collide (name suffixing like code-reviewer2, dispatches routed to the
# wrong repo's pane). IMPORTANT: the flag form is `--project af`; `project=af` is
# NOT a flag — just treats bare key=value args as variable overrides, so it is
# silently ignored and the team still joins the "default" pool.

# Peers-only implementation for:
#   just fleet team full --no-hub
#   just fleet team review --no-hub --project af
_fleet-team-up team="full" *args:
    {{node_ts}} scripts/team-up.ts --team {{team}} {{args}}

# Peers-only dry run:
#   just fleet team review --no-hub --dry-run --project af
_fleet-team-up-dry team="full" *args:
    {{node_ts}} scripts/team-up.ts --team {{team}} --dry-run {{args}}

# Default team mode: guarded Fleet Hub in the main pane plus guarded peers.
#   just fleet team docs
#   just fleet team review --project af
_fleet-hub-team team="full" *args:
    {{node_ts}} scripts/team-up.ts --team {{team}} --hub {{args}}

# Hub + team preview without touching Herdr:
#   just fleet team review --dry-run --project af
_fleet-hub-team-dry team="full" *args:
    {{node_ts}} scripts/team-up.ts --team {{team}} --hub --dry-run {{args}}

# Hermes conductor + team:
#   just fleet conductor hermes docs --project af
_fleet-conductor team="full" *args:
    {{node_ts}} scripts/team-up.ts --team {{team}} --conductor {{args}}

# Hermes conductor preview:
#   just fleet conductor hermes docs --dry-run --project af
_fleet-conductor-dry team="full" *args:
    {{node_ts}} scripts/team-up.ts --team {{team}} --conductor --dry-run {{args}}

# Experimental Codex remote-control conductor lifecycle (verified with CLI
# 0.144.x). Pairing stays interactive and its short-lived code must never be
# captured. The user service is singleton across repos/projects.
#   just fleet conductor codex setup docs --project af
_fleet-conductor-codex-setup team="full" *args:
    {{node_ts}} scripts/codex-remote-control.ts setup-conductor --codex-bin "$(command -v codex)" --repo-root "$(pwd -P)" --coms-dir "$HOME/.pi/coms" --team "{{team}}" --timeout 300000 {{args}}

_fleet-conductor-codex-reconfigure team="full" *args:
    {{node_ts}} scripts/codex-remote-control.ts reconfigure-conductor --codex-bin "$(command -v codex)" --repo-root "$(pwd -P)" --coms-dir "$HOME/.pi/coms" --team "{{team}}" --timeout 300000 {{args}}

_fleet-conductor-codex-pair:
    {{node_ts}} scripts/codex-remote-control.ts pair

_fleet-conductor-codex-start:
    {{node_ts}} scripts/codex-remote-control.ts start

_fleet-conductor-codex-status:
    {{node_ts}} scripts/codex-remote-control.ts status

_fleet-conductor-codex-stop:
    {{node_ts}} scripts/codex-remote-control.ts stop

_fleet-conductor-codex-recover:
    {{node_ts}} scripts/codex-remote-control.ts recover --confirm operator-confirmed

_fleet-conductor-codex-uninstall:
    {{node_ts}} scripts/codex-remote-control.ts uninstall --confirm operator-confirmed

# Codex conductor + team; systemd owns the remote-control daemon:
#   just fleet conductor codex docs --project af
_fleet-conductor-codex team="full" *args:
    {{node_ts}} scripts/team-up.ts --team {{team}} --conductor codex {{args}}

_fleet-conductor-codex-dry team="full" *args:
    {{node_ts}} scripts/team-up.ts --team {{team}} --conductor codex --dry-run {{args}}

# Save session refs while the team keeps running:
#   just fleet snapshot review --project af
_fleet-team-snapshot team="full" *args:
    {{node_ts}} scripts/team-snapshot.ts snapshot {{team}} {{args}}

# Snapshot and close cleanly:
#   just fleet down review --project af
_fleet-team-down team="full" *args:
    {{node_ts}} scripts/team-snapshot.ts down {{team}} {{args}}

# Rebuild from snapshot; missing session refs start fresh:
#   just fleet resume review --project af
_fleet-team-resume team="full" *args:
    {{node_ts}} scripts/team-snapshot.ts resume {{team}} {{args}}
# <<< agent-fleet:harnesses <<<
