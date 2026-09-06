# ask-user-remote

Harness wrapper for `pi-ask-user` that preserves the stock `ask_user` UI and result shape while optionally racing it against the Hermes `user-remote` coms peer.

The experimental Codex Remote-Control conductor is **not** an inbound `ask_user` route. It initiates approval-gated outbound delegation from Android; Hermes remains the only phone answer participant in this race. See the [Codex conductor runbook](https://github.com/chankov/agent-fleet/blob/main/docs/codex-remote-conductor.md).

- The stock `pi-ask-user` extension is loaded through a capture proxy; its `ask_user` tool is not registered directly.
- If no live `user-remote` peer is present at call time, the wrapper calls stock `execute` with the original arguments and signal unchanged.
- Remote lookup follows the explicit Pi `--project <name>` flag at tool-execution time (then `pi.getFlag`, `PI_COMS_PROJECT`, and finally `default`), so a hub and bridge in the same non-default pool can race correctly even though Pi finishes CLI parsing after extension factories load.
- If `user-remote` is present, the wrapper races local stock UI against the remote coms request using `race-core.js`; first answer wins and local-first emits one best-effort cancel.
- If another extension already registered `ask_user`, registration failure is caught and logged as a warning instead of crashing the session.

## Ownership model (exactly one `ask_user`)

Settings presence is **not** the same as runtime availability. Pi package discovery and deterministic Fleet Core are intentionally different loading paths:

| Mode | Pi discovery | Who owns `ask_user` | Hermes racing |
| --- | --- | --- | --- |
| Plain `pi` (copied workspace with `npm:pi-ask-user`) | Enabled | Standalone `pi-ask-user` package | No |
| Default `just fleet` (`--no-extensions` / `-ne`) | Disabled | This harness (`ask-user-remote`) | Yes when `user-remote` is live |
| `just fleet --all-extensions` | Enabled | Standalone package if listed; harness defers | No (avoid a second registration) |
| Package-native `@chankov/agent-fleet` only | Enabled | Package-exposed harness using the bundled dependency | Yes when `user-remote` is live |

### Discovery-enabled sessions

When extension discovery can run and `npm:pi-ask-user` appears in project (`.pi/settings.json`) or global (`~/.pi/agent/settings.json`) `packages`, this harness **defers**: it skips the wrapper so the stock package registers alone. Remote answer racing is disabled for that session. That is the correct behavior for plain Pi and for `just fleet --all-extensions`.

### Deterministic Fleet Core (`--no-extensions` / `-ne`)

`just fleet` starts Pi with discovery disabled. A settings entry for `pi-ask-user` is then **dormant** — Pi will not load it. The harness still installs the wrapped `ask_user` so Agent Hub probes and active-tool selection see the tool at session start.

### Where stock `pi-ask-user` is resolved

Copied harnesses must not depend on an npx cache or a workspace-root `node_modules` assumption. Resolution order:

1. Bundled dependency beside the Agent Fleet package (package-native installs)
2. Project Pi package: `.pi/npm/node_modules/pi-ask-user`
3. Harness runtime deps: `.pi/harnesses/node_modules/pi-ask-user` (from `npm ci --prefix .pi/harnesses`)
4. Global Pi package: `~/.pi/agent/npm/node_modules/pi-ask-user`

If none exist, the harness logs one actionable message naming `npm ci --prefix .pi/harnesses` and/or `pi install -l npm:pi-ask-user`.

## Skill / prompt ownership (separate from the tool)

Pick **one** path for Agent Fleet skills and lifecycle prompts:

- **Copied** — installer writes `.pi/skills` / `.pi/prompts` and records them in `.ai/agent-fleet-state.json`. Keep standalone `npm:pi-ask-user` for plain Pi; do **not** also enable `@chankov/agent-fleet` package skills/prompts.
- **Package-native** — `pi install npm:@chankov/agent-fleet` exposes skills/prompts (and bundles `pi-ask-user`). Do **not** also install overlapping `skill:*` / `command:*` copies.
- **Harness-only composition** is safe: package-native skills/prompts **plus** copied Fleet Core harnesses (no copied skills/prompts).

`agent-fleet verify` / `doctor` emit a read-only `pi-package-ownership` advisory when both paths overlap. See [docs/pi-setup.md](../../../docs/pi-setup.md).

Tests use fakes for the stock TUI and coms peer. The abort test proves signal propagation and the stock-shaped `{cancelled:true}` result through a fake captured tool; it does not drive a live TUI overlay.
