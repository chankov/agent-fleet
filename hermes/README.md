# Hermes artifacts

This directory contains in-repository Hermes skills for the coms Hermes bridge plan. They are source artifacts only; this pass does not modify `~/.hermes`.

## Skills

- `skills/hub-liaison/` — gateway-side Telegram liaison. It writes `~/.pi/coms/hermes-bridge/questions/<qid>.answer.json` answer files for `[HUB-Q:<qid>]` questions consumed by `scripts/coms-hermes-bridge.ts`.
- `skills/hub-conductor/` — dev-profile conductor. It uses `scripts/coms-cli.ts list` and `scripts/coms-cli.ts send --await --timeout` to delegate to live pi hub-team peers, while preserving the no-herdr damage-control boundary.

## Install

Install a skill into the desired Hermes profile with either option supported by your Hermes setup:

```bash
hermes skills install hermes/skills/hub-liaison
hermes skills install hermes/skills/hub-conductor
```

Or copy the skill directories into the profile's skills directory:

```bash
cp -R hermes/skills/hub-liaison ~/.hermes/<profile>/skills/
cp -R hermes/skills/hub-conductor ~/.hermes/<profile>/skills/
```

Use `hub-liaison` in the gateway-owning Telegram profile and `hub-conductor` in the human's dev/conductor profile. Verify availability with your normal Hermes skill listing command before relying on them.

## Local agent-hub monitor integration

Agent Fleet exposes an optional **local monitor transport** for Hermes-facing tools. This is
separate from the Telegram/coms bridge:

- `hub-liaison` and `hub-conductor` handle human questions and delegation through coms.
- The monitor transport exposes dispatcher and specialist state through owner-only discovery,
  a token file, and a Unix domain socket (UDS).

The repository does **not** ship or install a Hermes backend or Desktop plugin. A Hermes UI,
operator tool, or other local client may consume the transport contract described below, but it
owns its own presentation and lifecycle. The hub remains the source of truth for task state,
output cursors, leases, and generation-safe cancellation.

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

Choose a stable Hermes profile ID and an absolute, owner-only runtime directory. A Herdr-backed
hub is required because the stable hub identity includes `HERDR_WORKSPACE_ID` and
`HERDR_PANE_ID`; the normal `hub-team` recipe supplies the Herdr environment.

```bash
monitor_runtime="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}/agent-fleet-monitor"
install -d -m 700 "$monitor_runtime"

export AGENT_FLEET_PROFILE_ID="dev"
export AGENT_FLEET_MONITOR_RUNTIME_DIR="$monitor_runtime"

just hub-team default
```

If either monitor variable is missing or invalid, or if the hub lacks stable Herdr identity, the
monitor stays disabled while normal agent-hub orchestration continues. The profile ID must start
with an alphanumeric character and may contain only alphanumerics, `.`, `_`, or `-`; `..` is
rejected.

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
the remote peer may continue. Neither operation creates, focuses, closes, or otherwise controls a
Herdr pane or workspace.

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
just conductor-dry docs  # dry-run layout, no herdr calls
```

Inside Hermes, discover and delegate only through coms:

```bash
node --experimental-strip-types /home/nchankov/repos/agent-fleet/scripts/coms-cli.ts list
node --experimental-strip-types /home/nchankov/repos/agent-fleet/scripts/coms-cli.ts send <peer> "<task>" --await --timeout 300000
```

Hermes must not drive herdr panes or workspaces; the `just conductor` recipe creates the pane before Hermes starts. The no-herdr boundary is documented in `docs/coms-hermes-bridge.md` and governed by `.pi/damage-control-rules.yaml`.

Hermes/Telegram remains the inbound `ask_user` path beside the experimental Codex remote-control conductor. Codex is outbound-initiated, approval-gated, and serialized through the validated wrapper; both Hermes and Codex contracts remain advisory outside Pi damage-control, and neither external process has an OS command allowlist. See the [Codex operator runbook](../docs/codex-remote-conductor.md).
