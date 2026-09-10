#!/usr/bin/env bash
#
# Install one in-repo Hermes plugin into a Hermes profile.
#
#   scripts/install-hermes-plugin.sh agent-fleet-herdr [--profile default]
#                                    [--copy] [--uninstall] [--force] [--dry-run]
#
# A plugin has up to two halves, installed into the profile the same way:
#
#   hermes/plugins/<id>/          -> <profile>/plugins/<id>          (backend, FastAPI)
#   hermes/desktop-plugins/<id>/  -> <profile>/desktop-plugins/<id>  (Desktop pane, ESM)
#
# Symlinked at DIRECTORY level, never file by file: web_server.py requires the
# api file to resolve inside its own dashboard directory, so linking just
# `plugin_api.py` into a real directory makes the backend fail `relative_to`
# and be skipped in silence. `--copy` opts out of symlinks entirely.
#
# The script never restarts anything. The two halves have different reload
# rules — plugin.js is watched and hot-reloads, but routers are only included
# when the app is constructed — so it prints the exact steps and lets a human
# decide when the gateway goes down.

set -euo pipefail

PLUGIN_ID=""
PROFILE="${HERMES_PROFILE:-default}"
MODE="install"
LINK=1
FORCE=0
DRY_RUN=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_SOURCE="${HERMES_SOURCE:-$HOME/.hermes/hermes-agent}"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }
run() { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

usage() {
  sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; [ -n "$PROFILE" ] || die "--profile needs a name"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --copy) LINK=0; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$PLUGIN_ID" ] || die "one plugin id at a time (got '$PLUGIN_ID' and '$1')"; PLUGIN_ID="$1"; shift ;;
  esac
done

[ -n "$PLUGIN_ID" ] || usage 1
# The Desktop loader keys the plugin by its folder name, so an id with a path
# separator would install a plugin that can never load.
case "$PLUGIN_ID" in *[!A-Za-z0-9._-]*) die "unsafe plugin id: $PLUGIN_ID" ;; esac

command -v hermes >/dev/null 2>&1 || die "hermes CLI not found on PATH"

BACKEND_SRC="$REPO_ROOT/hermes/plugins/$PLUGIN_ID"
DESKTOP_SRC="$REPO_ROOT/hermes/desktop-plugins/$PLUGIN_ID"
[ -d "$BACKEND_SRC" ] || [ -d "$DESKTOP_SRC" ] || die "no such plugin in this repo: $PLUGIN_ID"

# `hermes profile show` is the only authority on where a profile lives; the
# Desktop loader reads the same path from gateway status as `hermes home`.
PROFILE_PATH="$(hermes profile show "$PROFILE" 2>/dev/null | sed -n 's/^Path:[[:space:]]*//p' | head -1)"
[ -n "$PROFILE_PATH" ] || die "cannot resolve Hermes profile '$PROFILE' (try: hermes profile list)"
[ -d "$PROFILE_PATH" ] || die "profile path does not exist: $PROFILE_PATH"

printf 'plugin  %s\nprofile %s (%s)\nmode    %s%s\n\n' \
  "$PLUGIN_ID" "$PROFILE" "$PROFILE_PATH" "$MODE" "$([ "$LINK" = 1 ] && echo ' via symlink' || echo ' via copy')"

backup_config() {
  local config="$PROFILE_PATH/config.yaml"
  [ -f "$config" ] || { note "no config.yaml to back up"; return 0; }
  local backup_dir="$PROFILE_PATH/backups/agent-fleet"
  run mkdir -p "$backup_dir"
  local backup="$backup_dir/config.yaml.$(date +%Y%m%dT%H%M%S)"
  run cp -p "$config" "$backup"
  note "backed up config.yaml -> $backup"
}

# One half of the plugin: repo directory -> profile directory.
install_half() {
  local src="$1" dest_parent="$2" label="$3"
  [ -d "$src" ] || { note "no $label half in this repo — skipped"; return 0; }
  local dest="$dest_parent/$PLUGIN_ID"
  run mkdir -p "$dest_parent"
  if [ -L "$dest" ]; then
    run rm "$dest"
  elif [ -e "$dest" ]; then
    [ "$FORCE" = 1 ] || die "$dest exists and is not a symlink; re-run with --force to replace it"
    run rm -rf "$dest"
  fi
  if [ "$LINK" = 1 ]; then
    run ln -s "$src" "$dest"
    note "$label: $dest -> $src"
  else
    run cp -R "$src" "$dest"
    note "$label: copied to $dest"
  fi
}

uninstall_half() {
  local dest_parent="$1" label="$2"
  local dest="$dest_parent/$PLUGIN_ID"
  if [ -L "$dest" ]; then
    run rm "$dest"
    note "$label: removed symlink $dest"
  elif [ -d "$dest" ]; then
    [ "$FORCE" = 1 ] || { note "$label: $dest is a real directory — left in place (use --force to delete)"; return 0; }
    run rm -rf "$dest"
    note "$label: removed $dest"
  else
    note "$label: nothing installed"
  fi
}

# The acceptance check from the plan, run WITHOUT touching the live gateway:
# discovery must see the dashboard half with an api file, and the enable record
# must exist. Both are required — either one missing yields the same 404.
verify_backend() {
  local python="$HERMES_SOURCE/venv/bin/python"
  if [ ! -x "$python" ]; then
    note "skipped backend verification: no interpreter at $python (set HERMES_SOURCE)"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    note "[dry-run] would verify discovery + enable record"
    return 0
  fi
  HERMES_HOME="$PROFILE_PATH" HERMES_SOURCE="$HERMES_SOURCE" "$python" - "$PLUGIN_ID" <<'PY'
import os
import sys
sys.path.insert(0, os.environ["HERMES_SOURCE"])
from hermes_cli.plugins_cmd import _get_enabled_set
from hermes_cli.web_server import _discover_dashboard_plugins

name = sys.argv[1]
found = [p for p in _discover_dashboard_plugins() if p["name"] == name]
enabled = name in _get_enabled_set()
has_api = bool(found and found[0].get("has_api"))
print(f"  discovery: {'ok' if has_api else 'MISSING'} (records={len(found)}, has_api={has_api})")
print(f"  enabled:   {'ok' if enabled else 'MISSING'}")
sys.exit(0 if has_api and enabled else 1)
PY
}

if [ "$MODE" = "install" ]; then
  backup_config
  install_half "$BACKEND_SRC" "$PROFILE_PATH/plugins" "backend"
  install_half "$DESKTOP_SRC" "$PROFILE_PATH/desktop-plugins" "desktop"
  if [ -d "$BACKEND_SRC" ]; then
    # Without this record every request to /api/plugins/<id>/* is refused by
    # middleware before routing — a 404 that looks exactly like "not mounted".
    run hermes --profile "$PROFILE" plugins enable "$PLUGIN_ID" --no-allow-tool-override
    verify_backend || die "backend not ready — see the two lines above"
  fi
  printf '\nNext (not done for you):\n'
  if [ -d "$BACKEND_SRC" ]; then
    # Two gateways: `hermes gateway restart` covers the user service (Telegram,
    # TUI, web dashboard), but the Desktop pane calls the gateway that
    # `hermes desktop` spawns for itself — and routers only mount at boot.
    printf '  restart the Hermes Desktop app     # its own gateway serves ctx.rest() for the pane\n'
    printf '  hermes --profile %s gateway restart   # only if the web dashboard / TUI needs the routes\n' "$PROFILE"
  fi
  if [ -d "$DESKTOP_SRC" ]; then printf '  plugin.js itself hot-reloads within ~5s — no restart needed for pane edits\n'; fi
else
  run hermes --profile "$PROFILE" plugins disable "$PLUGIN_ID" || note "plugins disable reported an error — continuing"
  uninstall_half "$PROFILE_PATH/plugins" "backend"
  uninstall_half "$PROFILE_PATH/desktop-plugins" "desktop"
  printf '\nNext (not done for you):\n'
  printf '  restart the Hermes Desktop app     # unmounts the routers the pane was using\n'
  printf '  hermes --profile %s gateway restart   # unmounts them in the service gateway too\n' "$PROFILE"
fi
