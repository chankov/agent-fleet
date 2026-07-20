# Codex Remote-Control Conductor

> **Experimental; verified with Codex CLI 0.144.6 on Linux.** The daemon is user-systemd-managed on the headless host, while manual pairing happens in the operator's interactive terminal. Revalidate the live gate after any Codex minor-version or mobile-client behavior change.

The conductor is an outbound-initiated, singleton Codex remote-control service with a visible Herdr **control** pane. The pane displays user-systemd requested state; it never starts, stops, or owns the daemon. Based on the verified design boundary, closing its workspace leaves the enabled service running. Codex uses the dedicated advisory contract at [`../codex/conductor/AGENTS.md`](../codex/conductor/AGENTS.md); Hermes/Telegram remains the inbound `ask_user` route.

## Supported facts and limits

- The pilot was validated with `codex-cli 0.144.6`. Public policy supports **only `0.144.x`**. Resolve the local binary with `command -v codex`; normal lifecycle state changes run a capability preflight, and `0.145.x` or later fail closed until reviewed.
- The confirmed remote-control subcommands are `start`, `stop`, and `pair`.
- The only approval modes are `untrusted`, `on-request`, and `never`. The only sandbox modes are `read-only`, `workspace-write`, and `danger-full-access`. **There is no `writes` mode.**
- The verified posture is `on-request` with `workspace-write`. The lifecycle helper passes these as validated 0.144.x config overrides and requests the configured `~/.pi/coms` directory as the only extra writable root. The mobile client's managed permission profile still requires a visible one-command escalation for `send`; this approval is mandatory. A remote thread that reports `approval_policy=never` must not delegate.
- Codex documents neither a foreground daemon lifecycle nor a websocket address/port. Do not configure, probe, document, or depend on a websocket port, PID, or health endpoint.
- `systemd` state is not daemon health: `active (exited)` means that the requested start command succeeded, not that a paired client is usable.
- Remote control is outbound-initiated and exclusive **as far as verified for this pilot**. It does not create inbound questions; use Hermes/Telegram for inbound `ask_user`.

Both Codex and Hermes are external conductors. Their contracts and human approvals are advisory safeguards outside Pi's damage-control harness; Pi's guardrails and an OS command allowlist do not technically constrain either process. See [Hermes and coms](coms-hermes-bridge.md).

## Before touching the host

1. Confirm the operator accepts the singleton/global-stop limitation: `stop` can affect the remote-control daemon rather than a process systemd can prove it owns.
2. Close Codex Desktop, editor-owned Codex app servers, and interactive Codex sessions for this host before starting the headless service. The remote-control host is singleton; a desktop/app-server owner can make headless `start` fail with `connection is errored`. Do not mix Mode B with the community Linux desktop workaround.
3. Set global `approval_policy = "on-request"` in `~/.codex/config.toml` after making a private backup. The Android client applies this global value to new threads and can override daemon-only config. This affects all local Codex sessions; the lifecycle preflight verifies the effective redacted `codex doctor --json` value and refuses `never`.
4. Keep pairing codes, credentials, auth files, remote-control URLs, approval transcripts, and screenshots **out of Git, documentation, plans, test fixtures, and logs**. Pairing output stays in the operator's terminal.
5. Run the non-mutating compatibility evidence. It confirms only advertised static capabilities and configured approval posture; it does not prove daemon ownership, pairing, session root, contract loading, approval delivery, or health.

```bash
CODEX="$(command -v codex)"
"$CODEX" --version
"$CODEX" remote-control --help
"$CODEX" remote-control start --help
"$CODEX" remote-control stop --help
"$CODEX" remote-control pair --help
"$CODEX" doctor --json  # redacted; preflight requires approval policy OnRequest
node --experimental-strip-types scripts/codex-remote-control.ts preflight --codex-bin "$CODEX"
```

**Compatibility stop condition:** if the version is not `0.144.x`, a required subcommand is absent, or `on-request` plus `workspace-write` cannot be demonstrated for this remote-control path, stop. Do not use guessed flags, a port, or a fallback launcher.

The verified loading mechanism is Codex `AGENTS.md` discovery with the selected instruction/session root at `codex/conductor`. The live pilot proved the unique contract rule from a fresh mobile-created thread; cwd and environment markers alone are still insufficient on a new host.

## Lifecycle

Run these recipes from the repository root. The helper rejects unsafe scope, invalid paths, unsupported Codex versions, and mismatched singleton configuration.

```bash
just conductor-codex-setup docs --project af
```

The recipe resolves `codex`, the real repository root, and `$HOME/.pi/coms`, then derives the isolated identity `codex-docs-conductor`. The lower-level `scripts/codex-remote-control.ts setup` command remains available for explicit integrations.

`setup` preflights, writes non-secret owned files, reloads user systemd, and enables the service. It does **not** pair or start it. The owned paths are:

- `~/.config/agent-fleet/codex-remote-control.json` (mode-restricted, non-secret configuration)
- `~/.config/systemd/user/agent-fleet-codex-remote-control.service`

The unit is `Type=oneshot` with `RemainAfterExit=yes`, has no `Restart=` policy, and runs preflight immediately before `remote-control start`. Start passes the verified `approval_policy="on-request"`, `sandbox_mode="workspace-write"`, and one `sandbox_workspace_write.writable_roots` entry for the validated coms directory. A mobile managed profile can remain narrower, so the exact wrapper `send` must request and receive phone approval before its first execution. The unit makes no foreground, PID, port, or readiness claim.

### Pair — human interaction required

Pair the mobile client manually in an interactive operator TTY, after setup. Any displayed pairing code is short-lived secret material:

```bash
just conductor-codex-pair
```

Do not pipe, tee, capture, transcribe, screenshot, or commit the output. Never put pairing material or Codex credentials in the unit or config.

### Start, status, and pilot launch

```bash
just conductor-codex-start
just conductor-codex-status
just conductor-codex docs --project af
```

`status` reports only requested systemd state. Actual usability must be checked from the paired client, without inventing a network probe. The control pane similarly reports requested state only. Legacy `conductor-codex-pilot*` aliases remain available for the initial 0.144.x rollout.

### Stop, recovery, and reconfiguration

```bash
just conductor-codex-stop
just conductor-codex-recover
```

Use recovery only when the unit says `active (exited)` but the operator has verified from the paired client that the daemon is unavailable. It is an explicit operator-confirmed systemd restart, not a health probe. Stop is a no-op only when the requested state is inactive; ambiguous states refuse rather than guessing.

To change the configured scope, use `reconfigure` with the complete validated setup arguments, then explicitly stop/start as required. Do not edit the unit or config by hand:

```bash
just conductor-codex-reconfigure docs --project af
```

### Version drift: emergency stop and uninstall

If normal preflight fails after Codex version/capability drift, normal start/stop/recovery remains blocked. The only exception is an explicit emergency stop, which first proves that the currently installed CLI still advertises the exact `remote-control stop` capability:

```bash
node --experimental-strip-types scripts/codex-remote-control.ts emergency-stop \
  --confirm emergency-stop-confirmed
```

If that capability is absent, restore a supported `0.144.x` CLI before stopping or uninstalling. Never substitute a guessed stop command.

Uninstall is explicit, operates only on the owned unit/config, stops/disables the owned service when safe, reloads user systemd, and leaves Codex authentication and pairing state untouched:

```bash
just conductor-codex-uninstall
# After version drift, use the lower-level helper only if the exact current
# stop capability is proved:
node --experimental-strip-types scripts/codex-remote-control.ts uninstall \
  --confirm operator-confirmed --emergency-confirm emergency-stop-confirmed
```

Repository rollback does not stop or uninstall an already installed user service. If ownership is ambiguous, stop and review; do not remove files or use a broad manual cleanup. After stopping/uninstalling the conductor, the operator may restore the private pre-change `config.toml` backup if `on-request` is not wanted for other Codex sessions.

## Verified live behavior

The Linux/Android live gate passed with CLI `0.144.6`: the managed unit completed start/stop/restart, manual pairing connected the phone, a fresh mobile thread loaded `codex/conductor/AGENTS.md`, and the wrapper listed the `af` pool despite the remote PID namespace. The human confirmed one bounded delegation and separately approved the exact elevated wrapper command; `documenter` replied `Pilot acknowledged. No files changed.` A second approval was denied, producing no researcher message and no lock. The lock was absent after completion, and closing the control workspace did not stop the service.

Remote threads use only `scripts/codex-conductor.ts` from the dedicated conductor directory. It reads owned scope, pins the real coms directory, and refuses repository/project/name/timeout overrides. **Human interaction remains required** twice for every send: first to confirm the freshly listed recipient/task conversationally, then to approve the exact wrapper command through Codex's `on-request` approval. The command must request escalation before its first execution because coms state and Unix sockets are outside the selected workspace.

## Related documentation

- [Experimental implementation plan](../plans/codex-remote-conductor.md) — gates and acceptance criteria.
- [Codex conductor contract](../codex/conductor/AGENTS.md) — bounded outbound delegation rules.
- [Hermes/coms bridge](coms-hermes-bridge.md) — inbound human questions and Hermes conductor boundary.
- [Architecture](ARCHITECTURE.md) — ownership of Pi, Herdr, coms, and external conductors.
