# Hermes artifacts

This directory holds the in-repository Hermes surfaces of Agent Fleet: the
**Desktop plugin** that shows the live fleet, and the **skills** behind the
coms ⇄ Hermes question bridge. They are source artifacts, installed into a
profile explicitly — nothing here is published to npm and nothing writes to
`~/.hermes` unless you run an installer.

Two distinct integrations, easy to conflate:

| | What it does | Direction | Entry point |
|---|---|---|---|
| **Desktop plugin** (`agent-fleet-herdr`) | Shows every live Agent Fleet session, its state, what it is doing, and which agent is blocked on you | Hermes reads the fleet | [docs/hermes-desktop-plugins.md](../docs/hermes-desktop-plugins.md) |
| **Question bridge** (`hub-liaison`) | Relays an agent's `ask_user` question to Telegram and races your answer against a local one | The fleet asks you | [docs/coms-hermes-bridge.md](../docs/coms-hermes-bridge.md) |

## Desktop plugins

`desktop-plugins/<id>/` and `plugins/<id>/` are the two halves of a Hermes
plugin — the Electron pane and the FastAPI backend it calls. They are installed
into a profile with `scripts/install-hermes-plugin.sh`, never published to npm.
The contract, the install runbook, and the failure modes that look identical
from the outside are documented in
[docs/hermes-desktop-plugins.md](../docs/hermes-desktop-plugins.md).

- `agent-fleet-herdr` — read-only panel of live Agent Fleet sessions grouped by
  project, flagging the ones waiting for a human.
- `agent-fleet-monitor` — the separate agent-hub task view (leases, generations,
  output cursors) over the local monitor transport described below. Its own
  Desktop panel is deliberately left uninstalled: the subagent tree is rendered
  inside `agent-fleet-herdr`'s session modal instead, so a human never has to
  know which pane to open.

### Install the fleet panel

Needs Hermes v0.19.0+ with the Desktop app, this checkout, and a fleet that has
run at least once (so `~/.pi/coms/projects/` exists). herdr is optional —
without it rows read `unknown` instead of a live state.

```bash
scripts/install-hermes-plugin.sh agent-fleet-herdr   # --profile / --copy / --dry-run / --uninstall
# then restart the Hermes DESKTOP APP (its gateway is the one that mounts the routes),
# start a fleet, and open the "Agent Fleet" tab:
just fleet team default
```

![The Agent Fleet panel in Hermes Desktop, listing seven live sessions in one project beside the chat that started them](../docs/assets/hermes-desktop-agent-fleet-panel.png)

Selecting a row opens a modal with that agent's purpose, model, context, queue,
uptime and heartbeat, a live tail of what it is doing read from its own
transcript, the subagents it is running with their stdout and a Cancel each, and
`Focus pane` to bring its workspace to the front.

![The session modal for an orchestrator, showing its live activity tail and the Focus pane action](../docs/assets/hermes-desktop-session-modal.png)

Prerequisites in full, the API, the join rules, the failure modes and the
deliberate limits: [docs/hermes-desktop-plugins.md](../docs/hermes-desktop-plugins.md).

`skills/hub-watchdog/` is an optional foreground, fail-closed monitor consumer. It is packaged source, not an installed or enabled profile skill. Its profile-aware lifecycle is documented in [the watchdog runbook](../docs/hermes-watchdog-supervisor.md): no installer starts/stops a gateway or changes tools, and Gate O has no checked-in live origin proof. The supported posture is journal-only/dormant; it must not deliver, steer, cancel, recover, wake a chat, or choose a fallback route.

## Skills

- `skills/hub-liaison/` — gateway-side Telegram liaison. It writes `~/.pi/coms/hermes-bridge/questions/<qid>.answer.json` answer files for `[HUB-Q:<qid>]` questions consumed by `scripts/coms-hermes-bridge.ts`.
- `skills/hub-conductor/` — dev-profile conductor. It uses `scripts/coms-cli.ts list` and `scripts/coms-cli.ts send --await --timeout` to delegate to live pi hub-team peers, while preserving the no-herdr damage-control boundary.

## Install

For `hub-liaison`, use Agent Fleet's deterministic profile-aware installer rather than a raw copy:

```bash
agent-fleet set-hermes-telegram status --profile default
agent-fleet set-hermes-telegram install --profile default
# Only when status reports a differing local tree:
agent-fleet set-hermes-telegram install --profile default --force
# Restart a currently running gateway only by explicit request:
agent-fleet set-hermes-telegram install --profile default --force --restart
```

Pi and OpenCode use `/af-set-hermes-telegram`; Claude Code uses `/set-hermes-telegram`. The installer resolves the real profile path via `hermes profile show`, refuses drift without `--force`, backs up forced replacements, copies atomically, and verifies skill/tool/gateway readiness. It never sends a test Telegram message and never starts a stopped gateway. See [the bridge runbook](../docs/coms-hermes-bridge.md#telegram-bridge-control-command).

The current `hermes skills install` CLI documents registry identifiers and direct HTTP(S) `SKILL.md` URLs, not local directories, so `hermes skills install hermes/skills/hub-liaison` is not the supported local installation path.

`hub-conductor` remains a source artifact for the human's dev/conductor profile. Install it by a reviewed local copy into the path reported by `hermes profile show <profile>`, or publish/install it through a pinned Hermes skill source; it is intentionally not managed by the Telegram bridge command.

Use `hub-liaison` in the gateway-owning Telegram profile and `hub-conductor` in the human's dev/conductor profile. Verify availability with `hermes --profile <profile> skills list --enabled-only` before relying on them.

## Local agent-hub monitor integration

Agent Fleet exposes an optional **local monitor transport** for Hermes-facing tools. This is
separate from the Telegram/coms bridge:

- `hub-liaison` and `hub-conductor` handle human questions and delegation through coms.
- The monitor transport exposes dispatcher and specialist state through owner-only discovery,
  a token file, and a Unix domain socket (UDS).

A Hermes UI, operator tool, or other local client may consume the transport contract described
below, but it owns its own presentation and lifecycle. The hub remains the source of truth for
task state and cancellation. Source artifacts being present in this repository or its package do
not install, enable, or prove a live Hermes client. In particular, monitor cursor/discovery
fields and local tests are not proof of a Hermes origin identity or watcher delivery route.

### Integration in action

The hub can surface an `ask_user` decision in Hermes Desktop while the specialist workflow keeps
running. The prompt preserves the question and its choices instead of flattening them into an
unstructured message:

![Hermes Desktop displaying a multiple-choice question piped from agent-hub](../docs/assets/hermes-question-in-desktop.png)

The side-by-side view shows the same live question in the Pi hub and Hermes Desktop. This is the
question-piping path used for remote human input; task monitoring remains the separate local
transport described below.

![Pi agent-hub and Hermes Desktop showing the same piped question side by side](../docs/assets/hermes-pi-question-piping.png)

### Start a monitored hub

Nothing to set up. A Herdr-backed hub is required because the stable hub identity includes
`HERDR_WORKSPACE_ID` and `HERDR_PANE_ID`, so use a team recipe:

```bash
just fleet team default
```

[scripts/lib/monitor-env.ts](../scripts/lib/monitor-env.ts) picks the profile ID (`dev`) and the
runtime directory (`$XDG_RUNTIME_DIR/agent-fleet-monitor`, created mode 0700) and the launchers
export both. Watch the tasks in the **agent-fleet-herdr** pane: select the hub's row, and its
subagents are a section of the modal with their live output and a Cancel each.

To point a hub at a different profile, or to turn the monitor off, set the variables yourself —
an existing value is never overwritten:

```bash
AGENT_FLEET_PROFILE_ID=prod just fleet team default   # a different Hermes profile
AGENT_FLEET_MONITOR=0 just fleet team default         # unmonitored
```

If either monitor variable is invalid, if the runtime directory cannot be made mode 0700, or if
the hub lacks stable Herdr identity, the monitor stays disabled while normal agent-hub
orchestration continues. The profile ID must start with an alphanumeric character and may contain
only alphanumerics, `.`, `_`, or `-`; `..` is rejected — the same class
`hermes/plugins/agent-fleet-monitor/dashboard/adapter.py` enforces when it reads the directory
back, because a value one end accepts and the other rejects is an empty listing with no error
anywhere.

### Discover the local endpoint

The hub creates mode `0700` namespaces under the runtime root. Each active registration contains
one mode `0600` discovery file and token file, plus a mode `0600` socket:

```text
<runtime>/<profile-sha256>/<hub-sha256>/discovery-<owner-id>.json
<runtime>/<profile-sha256>/<hub-sha256>/token-<owner-id>
<runtime>/s/<registration-sha256>/s
```

You can list discovery paths without reading or printing their tokens:

```bash
find "$AGENT_FLEET_MONITOR_RUNTIME_DIR" -type f -name 'discovery-*.json' -print
```

A discovery record has this shape:

```json
{
  "owner": "9db4478e-ef6e-4d5d-930b-6d637f5de4d1",
  "socket": "@runtime/s/0123456789abcdef0123456789abcdef/s",
  "token": "token-9db4478e-ef6e-4d5d-930b-6d637f5de4d1",
  "lease": {
    "hub": "<stable-hub-id>",
    "pid": 12345,
    "startedAt": "2026-07-21T09:00:00.000Z",
    "expiresAt": "2026-07-21T09:00:30.000Z"
  }
}
```

A consumer must reject expired or malformed discovery, paths outside the configured runtime root,
symlinks, unsafe modes, and socket/token names that do not match the discovery schema. It should
re-discover after reconnect instead of caching a token or absolute socket path. Never put the token
in a URL, log, Desktop storage, or command-line argument.

### Request snapshot, output, and cancellation

The UDS protocol is newline-delimited JSON with one request per connection. Read the token from the
discovery record's sibling token file, use it only in memory, and terminate every request with
`\n`.

```js
import net from "node:net";

export function monitorRequest(socketPath, request) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let body = "";
    client.setTimeout(1_000, () => client.destroy(new Error("monitor timeout")));
    client.on("connect", () => client.end(`${JSON.stringify(request)}\n`));
    client.on("data", chunk => { body += chunk; });
    client.on("error", reject);
    client.on("close", () => resolve(body ? JSON.parse(body) : null));
  });
}

// `token` and `socketPath` were resolved and validated from live discovery.
const current = await monitorRequest(socketPath, { type: "snapshot", token });
const delta = await monitorRequest(socketPath, {
  type: "output",
  token,
  taskId: "builder:1",
  generation: 1,
  afterSequence: 0
});
```

Example snapshot response:

```json
{
  "ok": true,
  "snapshot": {
    "tasks": [
      {
        "id": "builder:1",
        "generation": 1,
        "kind": "child",
        "state": "running",
        "outputLatestSequence": 4
      }
    ]
  }
}
```

Continue incremental output from the returned sequence to avoid duplicates:

```js
const next = await monitorRequest(socketPath, {
  type: "output",
  token,
  taskId: "builder:1",
  generation: 1,
  afterSequence: delta.output.sequence
});
```

Cancellation is an explicit operator action and must use the exact displayed task ID and
generation:

```js
const cancelled = await monitorRequest(socketPath, {
  type: "cancel",
  token,
  taskId: "builder:1",
  generation: 1
});
```

A native specialist cancellation targets only the hub-owned process generation and validates its
process identity before signalling it. Cancelling a coms-backed run abandons the hub's local wait;
the remote peer may continue, so it is never an automatic recovery target and the watchdog must not
retry or re-dispatch it. Neither operation creates, focuses, closes, or otherwise controls a
Herdr pane or workspace.

### Additive `events` and `invoke` requests

Two request types extend the same socket. A hub that does not implement them answers `unsupported`,
so a snapshot/output/cancel consumer keeps working unchanged.

`events` replays a bounded journal from a cursor the consumer holds. Set a read timeout that covers
the `waitMs` window you ask the hub to hold, or every quiet poll expires locally and looks like an
outage:

```js
const batch = await monitorRequest(socketPath, {
  type: "events",
  token,
  afterSequence: 0,
  limit: 50,      // 1–100
  waitMs: 2000    // 0–25000 long-poll window
});
// { ok: true, events: { firstAvailableSequence, latestSequence, items: [...], timedOut } }
```

A cursor older than the retained window is refused rather than silently skipped. Reconcile from a
fresh snapshot and resume from sequence 0:

```json
{"ok": false, "error": "cursor_too_old", "snapshotRequired": true, "firstAvailableSequence": 9, "latestSequence": 12}
```

`invoke` submits one typed request and returns an admission status — never a result of work:

```js
const admitted = await monitorRequest(socketPath, {
  type: "invoke",
  token,
  requestId: "request-a",
  taskId: "builder:1",
  generation: 1,
  action: "request_status",
  parameters: { assertionIds: [], evidenceEventIds: ["hub:1"] },
  basis: { deviation: "stalled_progress", judgment: "confirmed" }
});
// { ok: true, result: { status: "accepted" } }
```

`status` is one of `accepted`, `duplicate`, `queue_full`, `stale_generation`, `owner_changed`,
`already_terminal`, `idempotency_conflict`, `unsupported`, or `rejected`. `accepted` means the hub
queued a visible follow-up for its operator; it does not mean anything ran. Reusing a `requestId`
returns `duplicate` and adds no second follow-up; reusing it with different parameters returns
`idempotency_conflict`. The action set is closed — there is no shell, tool, Herdr, or free-text
surface.

### Failure and reconnect behavior

- `{"ok":false,"error":"unauthorized"}` means the token does not match current ownership.
- `monitor_unavailable` means the hub-side snapshot/output/cancel handler failed closed.
- `response_too_large` means the consumer must fall back to a fresh bounded snapshot or cursor.
- An empty response indicates malformed or out-of-contract input; do not retry it unchanged.
- When the lease expires, the socket closes, or ownership changes, discard the token and repeat
  discovery. Never fall back to public TCP, a gateway endpoint, or Herdr pane control.

Stopping the hub removes its owned discovery, token, and socket. Historical monitor journals under
the configured runtime root are separate from this live registration and should be removed only by
an operator who has identified the exact profile/runtime scope.

## Usage notes

For `hub-liaison`, ensure the Telegram-capable profile has terminal/file-write tools enabled so it can create exactly `~/.pi/coms/hermes-bridge/questions/<qid>.answer.json` and nothing outside that questions directory.

For `hub-conductor`, either start the pi team/pool outside Hermes first, or use the repo recipe to create a visible conductor workspace:

```bash
just conductor docs      # conductor pane (`hermes -p dev`) + docs team panes
just fleet conductor hermes docs --dry-run  # preview, no Herdr calls
```

Inside Hermes, discover and delegate only through coms:

```bash
node --experimental-strip-types /home/nchankov/repos/agent-fleet/scripts/coms-cli.ts list
node --experimental-strip-types /home/nchankov/repos/agent-fleet/scripts/coms-cli.ts send <peer> "<task>" --await --timeout 300000
```

Hermes must not drive herdr panes or workspaces; the `just conductor` recipe creates the pane before Hermes starts. The no-herdr boundary is documented in `docs/coms-hermes-bridge.md` and governed by `.pi/damage-control-rules.yaml`.

Hermes/Telegram remains the inbound `ask_user` path beside the experimental Codex remote-control conductor. Codex is outbound-initiated, approval-gated, and serialized through the validated wrapper; both Hermes and Codex contracts remain advisory outside Pi damage-control, and neither external process has an OS command allowlist. See the [Codex operator runbook](../docs/codex-remote-conductor.md).
