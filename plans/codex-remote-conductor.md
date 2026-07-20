# Implementation Plan: Experimental Codex Remote-Control Conductor

## Overview

Add Codex CLI remote control as an experimental, outbound-only conductor beside Hermes. Codex will use a user-level systemd service for the documented daemon lifecycle, while a distinct Herdr control pane displays validated conductor scope and systemd requested state; the pane must never launch `codex remote-control start` as though it were foreground-owned. Both Codex and Hermes may delegate only to currently listed coms peers through bounded `send --await` calls. Hermes remains the only inbound `ask_user`/Telegram path.

The user authorizes repository changes, complete user-level systemd installation on this Linux host, and a live human-interactive pairing/approval pilot. The implementation remains fail-closed: no public Codex launch is accepted until static capability checks, observed daemon lifecycle, contract/root propagation, pairing, approval behavior, and one serialized delegation have passed.

## Implementation Outcome — Complete

Implemented and promoted after the live gate passed on Linux with Codex CLI `0.144.6` and Android ChatGPT:

- user-systemd start/stop/restart and requested-state reporting passed; the service remains active when the control workspace closes;
- a fresh remote thread loaded `codex/conductor/AGENTS.md` from the dedicated root;
- global `approval_policy=on-request`, mobile command escalation, approval, and denial were observed;
- the validated wrapper listed host peers across the remote PID namespace and completed one approved awaited delegation (`Pilot acknowledged. No files changed.`);
- denial produced no peer message or lock, live lock contention failed closed, and normal completion released the lock;
- public `conductor-codex*` lifecycle/live/dry recipes were promoted while legacy pilot aliases remain;
- final `npm test` passed 262 tests; focused post-promotion tests, package-surface fixtures, public dry/live launch, `npm pack --dry-run`, and changeset status passed. Final verification commands are recorded in the implementation summary.

No pairing code, credential, token, remote URL, or auth material was committed.

## Confirmed Evidence and Policy

### Static CLI facts

- Resolved executable: `/home/nchankov/.local/bin/codex`.
- Installed version: `codex-cli 0.144.6`.
- Public support policy: Codex CLI `0.144.x` only, followed by capability preflight on every setup/start path. `0.145.x` and later are unsupported until deliberately reviewed.
- `codex remote-control start`, `stop`, and `pair` are supported.
- Help describes `start` as starting the app-server daemon. It does **not** document a foreground lifecycle or a websocket address/port.
- Approval values are `untrusted`, `on-request`, and `never`.
- Sandbox values are `read-only`, `workspace-write`, and `danger-full-access`.
- The selected pilot posture is `on-request` plus `workspace-write`, but implementation may apply it only through syntax/capability explicitly advertised for this CLI and remote-control path.
- There is no `writes` approval mode. No task may add one.

### Evidence gates are intentionally separate

1. **Static compatibility gate:** non-mutating version/help inspection proves the executable, supported minor line, subcommands, and exact placement of any applicable approval/sandbox options. Static help does not prove daemon ownership, pairing, remote-session cwd, contract loading, environment propagation, readiness, or human approval behavior.
2. **Observed lifecycle gate:** a human runs the bare `start`/`stop` flow, including already-running/already-stopped cases, and verifies remote usability without assuming a foreground process, PID, port, or undocumented status endpoint.
3. **Live compatibility gate:** after implementation, a human performs pairing, systemd setup, remote-session root/contract validation, approval allow/deny checks, serialized coms delegation, and shutdown. Pairing codes, credentials, remote-control URLs, and auth material remain terminal-only and must not enter repository files, test fixtures, logs committed to Git, screenshots, or plan evidence.

## Repository Baseline and Existing Gaps

Planning was refreshed on `main` at `c38fa23`; the branch was two commits ahead of `origin/main`. The working tree also contained pre-existing, uncommitted hub-only `base`-team work in:

- `.pi/agents/peers.yaml`
- `scripts/lib/herdr-layout.ts`
- `scripts/lib/herdr-layout.test.ts`
- `scripts/team-up.ts`

Implementation must preserve that work. In particular, root-pane cwd/env propagation must also work for the pending empty-team hub/conductor layout instead of restoring the old “empty team always fails” behavior.

Confirmed gaps:

1. `scripts/lib/team-project.ts` has one generic `conductor` mode and a Hermes-only `conductorCommand()`.
2. `scripts/team-up.ts` treats `--conductor` as a boolean and gives its root pane no backend-specific cwd/env/scope.
3. Hermes and Codex would collide on generic workspace/pane labels. Separating backend labels still leaves the existing residual collision where unrelated checkouts produce the same final basename/dot-segment from `worktreeTag()`.
4. `scripts/coms-cli.ts` does not validate all filesystem-derived project/name/timeout values, scopes spool files by name but not project, can fall back to an explicit peer omitted from the normal list, and has no Codex send serialization.
5. There is no Codex contract, user unit, lifecycle helper, or systemd/pairing test surface.
6. `codex/`, `hermes/`, systemd assets, and the conductor runbook are absent from package/snapshot/setup dependency closure.
7. Existing dry-run coverage lives in `scripts/lib/fleet-extras.test.ts`; there is no `scripts/team-up.test.ts`. The implementation must extend the actual test rather than citing a nonexistent one.
8. Pi damage-control wraps Pi tool calls only. Both external conductors—Hermes and Codex—rely on advisory contracts and human approvals outside Pi’s damage-control harness.

## Architecture Decisions

1. **Daemon lifecycle belongs to user systemd, not Herdr.** After the observed lifecycle gate proves daemonizing behavior, render one user unit with `Type=oneshot`, `RemainAfterExit=yes`, `ExecStart` calling the helper’s mandatory `0.144.x` capability preflight and then the proven `remote-control start`, and `ExecStop` calling a capability-checked helper that runs the exact proven `remote-control stop` only when the current CLI advertises that capability. Use no `Restart=` policy. `active (exited)` means only that the requested start command succeeded; it is not daemon health.
2. **The Codex Herdr pane is a control pane, not the daemon.** It validates the installed service configuration and displays systemd requested state. It may stay foreground by polling systemd state, but must label that state accurately and never infer transport health. Closing the pane/workspace does not stop the user service.
3. **Pairing remains interactive.** `pair` runs directly in the human’s TTY, never under systemd and never through captured/teed output. The unit/config contain no pairing material or Codex credentials; Codex continues to own its auth state.
4. **One host-wide Codex delegation lock.** `coms-cli send ... --await --conductor codex` acquires one fixed, private, atomic Codex lock before its fresh scoped peer enumeration and holds it through send, await, and cleanup. Contention and stale/ambiguous locks fail immediately. The implementation never auto-deletes a stale lock. This serializes all compliant Codex conductors across repositories/projects; Hermes and ordinary CLI sends are not serialized by this Codex-only mode.
5. **Strict current-list targeting.** `send` resolves its target only from the same fresh scoped peer list used by that invocation. Remove the hidden explicit-peer fallback. Codex mode rejects `--all`, detached send, missing `--await`, and missing explicit timeout/project/name.
6. **Validated scope before filesystem/process use.** Resolve the repository root to an absolute real directory and validate it before generating paths. Reuse `validateProject`; add bounded safe conductor-name validation; validate timeout as a positive integer within Node’s timer range. Every filesystem-bearing coms command validates explicit project/name scope before use. Revalidate user config on every setup/start/status/control-pane path. Explicit flags override validated env defaults.
7. **Single configured Codex context.** The user unit is intentionally singleton and stores one non-secret `(repo root, project, team, conductor identity, timeout, contract path, Codex binary)` configuration. A live recipe with a different scope fails before touching Herdr and instructs the human to reconfigure/restart the service. Multi-repository simultaneous Codex remote control is out of scope.
8. **Dedicated contract loading must be proved, not inferred.** `WorkingDirectory` and an environment variable naming `codex/conductor/AGENTS.md` are context, not proof that a remote-created session loaded it. Gate S must identify one documented `0.144.x` candidate instruction/root loading mechanism and its exact argv/configuration; if it cannot, stop at Gate S. Implement that mechanism only behind an explicitly named pilot path, never a public launch path. Gate P must prove that the remote-created session loaded the dedicated contract at the selected root. Public Codex launch, promotion, and release remain unavailable until Gate P passes. No guessed CLI flag is allowed.
9. **Typed backend, shared layout.** Add `ConductorBackend = "hermes" | "codex"` and one conductor pane spec. Keep Hermes’ command behavior, use backend workspace modes `conductor-hermes`/`conductor-codex`, and pane labels `conductor-hermes`/`conductor-codex-control`. Extend the existing root-pane layout data rather than copying tiling logic.
10. **Backward-compatible public surface.** Bare `scripts/team-up.ts --conductor` and `just conductor` remain Hermes aliases. Explicit `--conductor hermes|codex` is internal/public script syntax. Before Gate P, Codex has only explicitly named pilot lifecycle/live/dry recipes; Task 8 exposes public setup/pair/start/stop/status/uninstall and live/dry recipes only after Gate P passes.
11. **Distribution follows transitive runtime use.** Package, snapshot, and guided setup must carry the Codex contract, lifecycle helper/library, systemd template, coms CLI/core, team-up/layout dependencies, and Hermes contract/docs referenced by public recipes. Guided setup copies assets only; it never silently installs a user service or pairs Codex.
12. **Patch release metadata is a confirmed exception.** Add a patch changeset as explicitly requested, even though the repository’s default guidance normally classifies a new public command as minor. Call out the exception in review rather than silently selecting another bump.

## Dependency Graph

```text
Static Gate S: exact non-mutating 0.144.x capability evidence + documented contract-loading candidate
    └── Runtime Gate L: human bare daemon lifecycle observation (early)
          └── Task 1: coms validation + project-scoped filesystem safety + Codex serialization
                └── Task 2: Codex/Hermes advisory conductor contracts
                      └── Task 3: lifecycle helper + user systemd requested-state semantics
                            └── Task 4: typed backend + root-pane layout data
                                  └── Task 5: pilot-only team-up/lifecycle surface
                                        └── Task 6: pre-pilot operator runbook
                                              └── Task 7: package/setup/snapshot closure + companion manifest
                                                    └── Live Gate P: systemd/pairing/approval/contract pilot
                                                          └── Task 8: promote public surface, docs, and package verification
                                                                └── Task 9: patch changeset + review
```

No public Codex launch recipe is exposed before Gate P. The only pre-Gate-P live entry points are explicitly suffixed or labelled `pilot`, refuse unless the Gate-S candidate is recorded in validated configuration, and are for the authorized pilot only.

## Task List

### Phase 0 — Static Compatibility

- [x] **Gate S: Capture static CLI capability evidence without changing host state**

**Procedure:**

```bash
/home/nchankov/.local/bin/codex --version
/home/nchankov/.local/bin/codex --help
/home/nchankov/.local/bin/codex remote-control --help
/home/nchankov/.local/bin/codex remote-control start --help
/home/nchankov/.local/bin/codex remote-control stop --help
/home/nchankov/.local/bin/codex remote-control pair --help
```

**Acceptance criteria:**

- [ ] The resolved executable is `/home/nchankov/.local/bin/codex` and version output matches `codex-cli 0.144.x`; the current pilot records `0.144.6`.
- [ ] Help confirms `start`, `stop`, and `pair` and records their exact accepted argv without executing them.
- [ ] Help confirms only applicable `on-request` approval and `workspace-write` sandbox syntax and identifies one documented `0.144.x` candidate instruction/root loading mechanism, including its exact accepted argv/configuration and scope. If no such candidate exists, stop at Gate S: do not implement a loading fallback, pilot path, unit, or public Codex launch.
- [ ] Evidence explicitly records that foreground lifecycle and a transport port are undocumented and that no `writes` approval value exists.
- [ ] The documented loading candidate is recorded only as sanitized capability evidence and is marked **pilot-only pending Gate P**; it is not represented as proven contract loading or public support.
- [ ] Static output is retained only as sanitized implementation evidence; it contains no auth or pairing data. This gate follows `AGENTS.md` and `references/definition-of-done.md`.

**Dependencies:** None.

**Files touched:** None.

**Stop condition:** Any non-`0.144.x` version, missing subcommand, inability to establish an allowed approval/sandbox posture, or absence of a documented contract-loading candidate blocks implementation at Gate S. Do not substitute another binary, a guessed port, a foreground command, a loading fallback, or an undocumented flag.

### Phase 1 — Contract and Messaging Safety

- [x] **Task 1: Harden coms scope, targeting, spool paths, and Codex serialization**

**Description:** Write failing tests first, extract import-testable parsing/lock helpers, then make Codex-mode awaited sends strict and host-wide serialized before any public Codex recipe exists.

**Implementation steps:**

1. Add one reusable command-scope parser used before any filesystem-derived value or spool path is read/written. It requires and validates project and name for **every** filesystem-bearing operation, including registry-pruning `list`, `send`, `_listen`, `await`, `reply`, `msg_id`, and listen-session creation/lookup; it also validates timeout where applicable, duplicate/unknown flags, env precedence, and Codex mode.
2. Deliberately migrate the legacy name-only spool layout: define a compatibility read window and one atomic, project-aware migration path (or an explicit fail-closed incompatibility error), never silently mix old and new queues. New pending/responses/inbound/listen-session paths are rooted under validated project and name; reject traversal/unsafe/empty values before any filesystem/process work.
3. Remove `cmdSend()`’s fallback to peers outside the invocation’s current scoped list.
4. For `--conductor codex`, require explicit project/name/timeout plus `--await`, reject `--all` and detached mode, acquire the fixed global Codex lock before fresh peer enumeration, and hold it through send, await, reply handling, and cleanup.
5. Fail closed on live or stale lock contention; include non-secret PID/start/scope metadata for diagnosis, clean up on normal completion and handled signals, and require explicit human stale-lock recovery after verifying the recorded process is gone.

**Acceptance criteria:**

- [ ] Explicit flags override env defaults; env defaults override existing defaults; every filesystem-bearing command (`list`, `send`, `_listen`, `await`, `reply`, `msg_id`, and listen-session operations) requires validated project/name scope before filesystem/process work. Duplicates, unknown flags, unsafe names/projects, and non-integer/out-of-range timeouts fail at command level.
- [ ] Spool paths include validated project and name, so identical names in different projects do not share pending/responses/inbound/listen-session files; migration/compatibility behavior is explicit, atomic, tested, and cannot cross project scope.
- [ ] A target omitted from the current scoped list is rejected even if it exists as an explicit registry peer; Codex mode cannot use `--all`.
- [ ] A second Codex-mode awaited send fails immediately while the first lock is held; normal release permits the next send; a stale lock remains fail-closed until human recovery.
- [ ] The lock begins before the send invocation’s fresh list/target resolution and remains held through response, timeout, error, and cleanup.
- [ ] Command-level strict-list tests cover every scoped command shape, including registry-pruning `list` and rejection before filesystem access; two independent processes cover the same command matrix and contend for the real Codex lock, proving immediate refusal while held and permitted acquisition after release. Migration and compatibility fixtures prove legacy spools cannot be silently consumed across projects.
- [ ] Tests fail against the old implementation and pass after the change, satisfying `AGENTS.md`, `docs/ARCHITECTURE.md` (“coms owns messages”), and `references/definition-of-done.md`.

**Verification:**

```bash
node --test scripts/lib/coms-cli-core.test.ts scripts/lib/coms-cli-process.test.ts scripts/lib/team-project.test.ts
```

**Dependencies:** Gate L.

**Files likely touched (6):**

- `scripts/coms-cli.ts`
- `scripts/lib/coms-cli-core.ts` (new)
- `scripts/lib/coms-cli-core.test.ts` (new)
- `scripts/lib/coms-cli-process.test.ts` (new)
- `scripts/lib/team-project.ts`
- `scripts/lib/team-project.test.ts`

- [x] **Task 2: Define narrow Codex and Hermes advisory conductor contracts**

**Description:** Add the dedicated Codex contract and bring Hermes’ skill to the same explicit project/name/list/send discipline before exposing Codex recipes.

**Acceptance criteria:**

- [ ] `codex/conductor/AGENTS.md` requires validated `AGENT_FLEET_REPO_ROOT`, `COMS_CLI_PROJECT`, `COMS_CLI_NAME`, timeout, contract identity, and `--conductor codex` before any delegation; every `list`, `send`, `_listen`, `await`, `reply`, and `msg_id` shape carries explicit project/name scope and is valid only after its command-level validation.
- [ ] The only Codex delegation flow is scoped `list`, fresh human confirmation of listed recipient/bounded prompt/timeout, then `send ... --await --timeout`; no parallel send, `--all`, detached `send`, standalone `await`/`reply`, lifecycle command, direct Herdr control, secret relay, or bulk dump is allowed.
- [ ] Codex retries a missing/timed-out peer at most once and synthesizes named evidence and unresolved gaps.
- [ ] Hermes uses explicit project/name scope and the same listed-recipient rule while retaining its existing behavior and no-Herdr instruction.
- [ ] Both files state that the contracts are advisory: neither external process is inside Pi’s damage-control harness or protected by an OS command allowlist. Human approvals and sandboxing reduce risk but do not technically prevent direct commands.
- [ ] Contract wording complies with `AGENTS.md`, `docs/ARCHITECTURE.md`, and `references/definition-of-done.md`.

**Verification:**

Manual review must find only command shapes equivalent to:

```bash
node --experimental-strip-types "$AGENT_FLEET_REPO_ROOT/scripts/coms-cli.ts" list \
  --project "$COMS_CLI_PROJECT" --name "$COMS_CLI_NAME"

node --experimental-strip-types "$AGENT_FLEET_REPO_ROOT/scripts/coms-cli.ts" send <listed-peer> \
  "<human-approved bounded task>" \
  --project "$COMS_CLI_PROJECT" --name "$COMS_CLI_NAME" \
  --await --timeout <human-approved-ms> --conductor codex
```

Hermes omits `--conductor codex`; both contracts prohibit `--all`.

**Dependencies:** Task 1.

**Files likely touched (2):**

- `codex/conductor/AGENTS.md` (new)
- `hermes/skills/hub-conductor/SKILL.md`

### Runtime Gate — Observed Daemon Semantics

- [x] **Gate L: Human-observe bare pairing/start/stop behavior before writing unit semantics**

**Human interaction required:** The operator confirms that no needed Codex remote-control session or independently managed daemon will be disrupted. If pairing is required to establish usability, run `/home/nchankov/.local/bin/codex remote-control pair` directly in the TTY; do not pipe, tee, screenshot, transcribe, or commit its output.

**Observed matrix:**

1. Run bare `start`; record only exit code/timing and whether a paired client remains usable after the command returns.
2. Run `start` again while usable; record whether it is idempotent or fails clearly and verify it does not create an independently owned second daemon.
3. Run `stop`; verify the paired client becomes unavailable.
4. Run `stop` again; record the already-stopped behavior.
5. Confirm `stop` is global/singleton in effect and document that systemd cannot prove ownership of the detached daemon.

**Acceptance criteria:**

- [ ] `start` returns successfully while the app-server remains usable; no foreground ownership is claimed.
- [ ] Repeated start/stop behavior is deterministic enough for a singleton user service.
- [ ] `stop` ends the observed remote-control availability without relying on a guessed PID, port, or undocumented status endpoint.
- [ ] Only sanitized pass/fail/timing observations are retained; no pairing code, credential, URL, or auth file enters the repository.
- [ ] The human explicitly approves proceeding with the known singleton/global-stop limitation, satisfying `docs/ARCHITECTURE.md` lifecycle ownership and `references/definition-of-done.md` human-review requirements.

**Dependencies:** Gate S.

**Files touched:** None.

**Stop condition:** If `start` stays foreground, usability cannot be established after it returns, repeated operations are unsafe/ambiguous, or `stop` ownership is unacceptable, do not create/install a unit and do not expose public Codex recipes.

### Phase 2 — User Service and Backend Foundation

- [x] **Task 3: Implement validated Codex lifecycle tooling and the user unit**

**Description:** Encode the observed lifecycle in a tested helper and render/install a secrets-free user unit. Host mutations occur only through explicit setup/start/stop/uninstall commands; tests use temporary HOME/config paths and fake process runners.

**Implementation steps:**

1. Add internal `preflight`, `setup`, `reconfigure`, `pair`, `start`, `stop`, `status`, `recover`, `control-pane`, `assert-context`, and `uninstall` subcommands. Until Gate P, only the explicitly named pilot wrappers may invoke their live behavior; Task 8 alone exposes promoted public recipe names.
2. Store non-secret config at `~/.config/agent-fleet/codex-remote-control.json`; render the owned unit to `~/.config/systemd/user/agent-fleet-codex-remote-control.service` from the shipped template.
3. Render validated absolute Node/script/Codex/repository paths, `WorkingDirectory`, project/team/name/timeout/contract identity, `HOME`, and the selected approval/sandbox posture only through syntax proved by Gate S.
4. `setup` writes atomically with restrictive config permissions, runs `systemctl --user daemon-reload`, and enables without pairing or starting. The systemd `ExecStart` invokes the helper’s non-bypassable capability preflight immediately before the Gate-L-proven `remote-control start`; direct unit invocation cannot skip it. `pair` inherits the TTY. `start`/`stop` go through systemd. `uninstall` disables/stops only after explicit human confirmation, removes only owned unit/config files, reloads systemd, and leaves Codex credentials untouched.

**Acceptance criteria:**

- [ ] Every normal mutating/lifecycle subcommand rechecks the absolute executable, `codex-cli 0.144.x`, required help capabilities, exact option applicability, and the Gate-S candidate; capability drift fails closed. The rendered unit’s `ExecStart` invokes that same preflight before `remote-control start`, so `systemctl --user start` cannot bypass it. Emergency stop is the sole drift exception.
- [ ] Repository root is realpath-resolved, absolute, and an existing directory containing the required contract/runtime files; project/team/name/timeout/config values are revalidated before path generation or subprocess use.
- [ ] The rendered unit uses `Type=oneshot`, `RemainAfterExit=yes`, the Gate-L-proven start/stop commands, no `Restart=`, and no foreground/PID/port assumption.
- [ ] Requested-state idempotence is defined and tested: start is a no-op success only when the owned unit is already `active (exited)` and its validated configuration/preflight still match; stop is a no-op success only when it is inactive. A mismatched, failed, activating/deactivating, or unknown state refuses rather than guessing daemon state.
- [ ] `status` and `control-pane` call systemd only and label `active (exited)` as requested state, never daemon health or readiness. If it is `active (exited)` while the operator reports the daemon unavailable, recovery requires an explicit operator-confirmed restart/recovery command; it records no inferred health probe, PID, or port and must re-run preflight before stop/start.
- [ ] After version/capability drift, normal start and public launch fail closed. An explicit operator-confirmed emergency stop is allowed only when the current CLI’s non-mutating capability check proves the exact Gate-L-proven `remote-control stop` command; otherwise stop/uninstall instructions require restoring `0.144.x`. Emergency stop/uninstall use only owned-unit/systemd requested-state operations, never invoke unsupported start syntax, and never delete non-owned state.
- [ ] Existing non-owned unit/config files, ambiguous pre-existing daemon state, scope mismatch, or stale Codex send lock cause actionable refusal rather than overwrite/stop/removal.
- [ ] `pair` is interactive and uncaptured; unit/config/test fixtures contain no credentials, pairing codes, auth values, or remote-control addresses.
- [ ] `on-request` plus `workspace-write` is used only if Gate S proves a supported remote-control mechanism; absence blocks setup rather than falling back to another mode.
- [ ] A dedicated contract/root loading mechanism is never inferred from cwd/env alone. Its Gate-S candidate is rendered only for the explicitly named pilot path. Pilot launch is allowed when the documented candidate, validated pilot configuration, `0.144.x` CLI preflight, and requested service state validate; only non-pilot/public launch commands refuse until Gate P records observed contract-loading proof.
- [ ] Unit rendering, escaping (including spaces), permissions, ownership markers, requested-state idempotence, active(exited)+unavailable operator-confirmed recovery, version rejection, exact-capability-checked emergency stop after drift (and required `0.144.x` restoration when absent), drift-safe uninstall, fake systemctl sequencing, and rollback paths are tested under `references/definition-of-done.md` and `docs/ARCHITECTURE.md`.

**Verification:**

```bash
node --test scripts/lib/codex-remote-control.test.ts
node --experimental-strip-types scripts/codex-remote-control.ts preflight \
  --codex-bin /home/nchankov/.local/bin/codex
```

The second command is non-mutating. Do not run `setup`, `pair`, `start`, `stop`, or `uninstall` in automated tests.

**Dependencies:** Task 2 (with Gate L transitive).

**Files likely touched (4):**

- `scripts/codex-remote-control.ts` (new)
- `scripts/lib/codex-remote-control.ts` (new)
- `scripts/lib/codex-remote-control.test.ts` (new)
- `systemd/user/agent-fleet-codex-remote-control.service.in` (new)

- [x] **Task 4: Add typed conductor backends and backend-specific root-pane data**

**Description:** Generalize the existing Hermes-only spec and shared layout so both external backends receive distinct labels and validated non-secret context. The Codex pane runs only the lifecycle helper’s control-pane mode.

**Acceptance criteria:**

- [ ] `ConductorBackend` accepts only `hermes|codex`; backend specs carry command, cwd, env, ratio, pane label, workspace mode, display text, and expected service scope.
- [ ] The same repo/team/project produces different workspace modes (`conductor-hermes`, `conductor-codex`), pane labels (`conductor-hermes`, `conductor-codex-control`), commands, and coms identities.
- [ ] The Codex pane command is the foreground `control-pane` helper only; neither layout nor pane argv contains `remote-control start|stop|pair`.
- [ ] Root env injects validated repository realpath, project, backend/team conductor name, timeout, contract path/identity, and Codex mode without secrets; explicit command flags remain required by the contract.
- [ ] `buildTeamLayout()` preserves supplied root cwd/env for normal conductor layouts and the pending empty-team root-only layout; hub/peer/resume behavior remains compatible.
- [ ] Tests preserve the existing uncommitted `base`-team behavior and cover both backends, non-default projects, unsafe values, exact labels/env, and root-only cwd/env.
- [ ] Code keeps one Herdr layout path in accordance with `docs/ARCHITECTURE.md`, `AGENTS.md`, and `references/definition-of-done.md`.

**Verification:**

```bash
node --test scripts/lib/team-project.test.ts scripts/lib/herdr-layout.test.ts
```

**Dependencies:** Task 3.

**Files likely touched (4):**

- `scripts/lib/team-project.ts`
- `scripts/lib/team-project.test.ts`
- `scripts/lib/herdr-layout.ts`
- `scripts/lib/herdr-layout.test.ts`

### Phase 2 Checkpoint

- [ ] Coms validation/list targeting/global Codex locking tests pass.
- [ ] Contracts exist and precede all public Codex recipes.
- [ ] Gate L observations support the checked-in unit semantics.
- [ ] No pane command starts/stops/pairs Codex or claims daemon health.
- [ ] The pre-existing hub-only working-tree changes remain intact.

### Phase 3 — Team Wiring and Public Surface

- [x] **Task 5: Wire explicit backends, dry runs, lifecycle recipes, and live refusal paths**

**Description:** Connect the typed spec to the real team-up entrypoint and managed justfile only after contract/coms/systemd safety exists. Before Gate P this is an explicitly named, authorized pilot surface—not a public Codex launch surface.

**Implementation steps:**

1. Parse bare `--conductor` as legacy Hermes and explicit `--conductor hermes|codex`; reject duplicates, unknown values, and `--hub` combinations before workspace operations.
2. Keep `just conductor`/`conductor-dry` as Hermes. Before Gate P, add only clearly labelled `conductor-codex-pilot-*` setup/reconfigure/pair/start/stop/status/launch wrappers and a non-mutating pilot dry-run; do not add `conductor-codex` as a public launch alias. Task 8 promotes the names only after Gate P passes.
3. Make live Codex team launch validate systemd requested state and exact configured repo/project/team/name/timeout/contract match before importing/calling Herdr. Dry-run must not read user config, systemd, Codex auth, peer env-file contents, or external CLI state.
4. Launch the Codex control pane and peers through the shared layout; service start/stop remains an explicit human action independent of workspace creation/closure.

**Acceptance criteria:**

- [ ] Existing direct `--conductor` and `just conductor` behavior remains Hermes-compatible apart from the intentional backend-specific workspace/pane label.
- [ ] `conductor-codex-pilot-dry docs --project af` prints deterministic `conductor-codex` workspace data, `conductor-codex-control` pane data, validated non-secret context, and project-scoped peer argv without host reads or subprocesses.
- [ ] The only live pre-Gate-P Codex launch is `conductor-codex-pilot`; it is allowed when the user unit requested state, validated pilot configuration, `0.144.x` capability preflight, and Gate-S documented loading candidate validate. It refuses before Herdr when any of those conditions fails. Observed contract loading is required at Gate P for public promotion, not for pilot launch. No public `conductor-codex` launch recipe exists before Gate P.
- [ ] Closing the Codex Herdr workspace closes only the control/team panes; documentation/output states that the enabled user service remains running until explicit stop.
- [ ] Invalid backend/project/team combinations and the pending empty-team peers-only case fail with actionable usage, while empty root-only hub/conductor layouts remain supported.
- [ ] The real dry-run suite covers both backends, service-independent dry run, secrets redaction, bad flags, and scope mismatch; recipe assertions cover every new wrapper.
- [ ] Implementation follows TDD and preserves Herdr/coms ownership under `AGENTS.md`, `docs/ARCHITECTURE.md`, and `references/definition-of-done.md`.

**Verification:**

```bash
node --test scripts/lib/fleet-extras.test.ts scripts/lib/team-project.test.ts
just conductor-dry docs --project af
just conductor-codex-pilot-dry docs --project af
just --list
```

**Dependencies:** Task 4.

**Files likely touched (4):**

- `scripts/team-up.ts`
- `scripts/lib/fleet-extras.test.ts`
- `scripts/lib/team-project.test.ts`
- `justfile`

### Phase 4 — Documentation and Distribution

- [x] **Task 6: Publish the pre-pilot operator runbook and architecture boundaries**

**Description:** Document exact topology, static/runtime gates, service lifecycle, human-interactive steps, safety limitations, and rollback without recording secrets or unsupported transport details.

**Acceptance criteria:**

- [ ] A Codex **pre-pilot** runbook documents the supported `0.144.x` policy, capability preflight, Gate-S documented loading candidate, user-unit paths/semantics, pilot-only setup→pair→start→launch→stop flow, reconfiguration, uninstall, and `active (exited)` limitation. It says plainly that public launch is unavailable until Gate P passes.
- [ ] Pairing and approval steps are visibly marked **human interaction required** and forbid capturing pairing codes, credentials, auth files, remote-control URLs, or approval transcripts in repository artifacts.
- [ ] The runbook selects only `on-request` plus `workspace-write` when proved applicable; it contains no `writes` mode, foreground claim, websocket address/port, or guessed health check.
- [ ] Architecture/docs state that Hermes remains inbound `ask_user`, Codex is outbound-only, and both external conductors rely on advisory contracts outside Pi damage-control.
- [ ] Docs explain that backend labels no longer collide with each other, but `worktreeTag()` can still collide for unrelated checkout basenames/final dot-segments; existing-workspace refusal is mitigation, not uniqueness proof.
- [ ] Docs explain the singleton/global-stop limitation and that repository rollback does not uninstall or stop an already installed user service.
- [ ] Documentation matches `docs/ARCHITECTURE.md`, `AGENTS.md`, and `references/definition-of-done.md`, labels all unproven behavior as pilot-only, and reserves timeless public-support wording for Task 8 after Gate P.

**Verification:**

```bash
# Render/review Markdown; compare every Codex command and option to Gate S/Gate L evidence.
```

**Dependencies:** Task 5.

**Files likely touched (4):**

- `docs/codex-remote-conductor.md` (new)
- `docs/coms-hermes-bridge.md`
- `docs/ARCHITECTURE.md`
- `hermes/README.md`

- [x] **Task 7: Close package, snapshot, guided-setup, and runtime dependencies**

**Description:** Ensure npm consumers and guided pi workspace installs receive every file referenced by the recipes/helper/contracts, while host systemd installation remains separately explicit.

**Acceptance criteria:**

- [ ] `package.json#files` ships `codex/`, `hermes/`, `systemd/`, both conductor docs, `justfile`, lifecycle/coms/team scripts, and all transitive runtime libraries while excluding tests.
- [ ] `npm test` explicitly runs the new coms/lifecycle tests and continues to run `scripts/lib/fleet-extras.test.ts` and `scripts/lib/team-project.test.ts`.
- [ ] `ARTIFACT_PATHS` snapshots Codex, Hermes, systemd, docs, justfile, scripts, and their runtime dependencies; implementation does not rebuild an existing published `.versions/` snapshot.
- [ ] A checked-in, guided-setup companion manifest explicitly enumerates `codex/`, `hermes/`, `systemd/`, required top-level scripts, and the recursive `scripts/lib` import dependency closure. The setup implementation uses this manifest for copy/symlink/refresh/remove/verify together with the managed justfile region; it must not rely on a hand-maintained partial list.
- [ ] Guided setup never runs systemctl, starts/stops Codex, pairs a device, copies credentials, or removes user service state; the operator invokes the explicit lifecycle recipe after assets are installed.
- [ ] Tested copy and symlink fixtures exercise the manifest’s complete closure, detect a missing recursive import/template/contract, and preserve user recipes outside justfile sentinels. The package-surface test fails if package, snapshot, or companion manifest diverge.
- [ ] `npm pack --dry-run` contains runtime assets and no tests; the package-surface test keeps package, snapshot, and guided companion manifests aligned under `skills/guided-workspace-setup/SKILL.md`, `docs/UPSTREAM-SKILLS.md`, `AGENTS.md`, and `references/definition-of-done.md`.

**Verification:**

```bash
node --test bin/test/package-surfaces.test.js
npm run pack:dry
npm test
```

Release-only verification after the changeset is versioned:

```bash
npm run version:changeset
# Confirm .versions/<new-version>/ contains codex/, hermes/, systemd/, docs,
# justfile, scripts/, and all helper imports. Do not rewrite an old snapshot.
```

**Dependencies:** Task 6.

**Files likely touched (5):**

- `package.json`
- `bin/snapshot-version.js`
- `bin/test/package-surfaces.test.js` (new)
- `skills/guided-workspace-setup/SKILL.md`
- `skills/guided-workspace-setup/companion-manifest.json` (new)

### Live Compatibility and Host Installation Gate

- [x] **Gate P: Complete the authorized user-systemd, pairing, and approval pilot**

**Human interaction required. No command in this gate belongs in automated tests.**

**Pilot sequence:**

```bash
just conductor-codex-pilot-setup docs --project af
just conductor-codex-pilot-pair
just conductor-codex-pilot-start
just conductor-codex-pilot-status
just conductor-codex-pilot docs --project af
```

1. Confirm setup created/enabled only the owned user unit and non-secret config at the documented paths.
2. Pair in the interactive terminal without capturing output.
3. Confirm status says requested systemd state, not health; prove actual usability from the paired client.
4. In the remote session, run the helper’s non-secret `assert-context` flow and verify the real repository root, project `af`, team, Codex conductor name, timeout, contract path/identity, and selected session root.
5. Prove the dedicated Codex contract is loaded. Working directory/env alone do not count; if Codex cannot show the documented instruction/root mechanism and follow the contract marker, stop and keep public launch blocked.
6. Verify the remote-controlled action uses `on-request` and `workspace-write`: approve the intended scoped list action and deny one unapproved harmless action. Confirm denial causes no side effect.
7. List the `af` pool, choose a peer present in that output, and have the human confirm recipient, bounded task, and timeout.
8. Run one Codex-mode `send --await`. While it is awaiting, attempt a second Codex-mode send and verify immediate lock refusal; then verify cleanup permits a later send. Do not delegate secret data.
9. Verify the response is synthesized with named evidence and unresolved gaps.
10. Run `just conductor-codex-pilot-stop`; verify remote availability ends. Restart only if the operator wants the enabled service left active.

**Acceptance criteria:**

- [ ] Full user-level setup, enablement, pairing, start, status, pilot live team launch, one approved delegation, contention refusal, and stop succeed on this host.
- [ ] Remote root, the Gate-S documented contract-loading candidate, dedicated contract, project/name/timeout identity, approval posture, and sandbox posture are observed rather than inferred.
- [ ] The Codex pane never owns/starts the daemon, and pane closure does not misreport or silently stop service state.
- [ ] A denied approval has no side effect; one approved bounded delegation returns evidence.
- [ ] No credential, pairing code, URL, auth file, or sensitive transcript is added to Git, docs, tests, snapshots, plans, or changesets. Record only sanitized pass/fail evidence in the implementation report.
- [ ] Failure of any root/contract/approval/lifecycle check blocks Task 8 promotion and leaves Codex public recipes unavailable.

**Dependencies:** Tasks 6 and 7; Gate S candidate and Gate L observations.

**Files touched:** User-level systemd/config/Codex-owned auth state only; no repository evidence file.

- [x] **Task 8: Promote the public surface and verify post-pilot docs/package state**

**Description:** Only after Gate P passes, promote the explicitly named pilot recipes to the public Codex recipe names and replace pilot-only wording with supported experimental wording. Re-run package, snapshot, and guided-setup companion-manifest verification against the promoted surface.

**Acceptance criteria:**

- [ ] No public `conductor-codex*` launch/setup lifecycle recipe, public runbook claim, or release metadata exists before Gate P; after a passing Gate P, promotion maps the pilot recipes to the documented public names without changing their validated behavior.
- [ ] Public docs state the Gate-P-proven contract-loading mechanism and observed requested-state/recovery limitations, retain all no-secret restrictions, and never claim a port, PID, or health endpoint.
- [ ] Post-pilot package/snapshot/manifest verification confirms every promoted recipe and its `codex/`, `hermes/`, `systemd/`, top-level script, and recursive `scripts/lib` dependency is distributable and installable through both copy and symlink fixtures.

**Verification:**

```bash
node --test bin/test/package-surfaces.test.js
npm run pack:dry
npm test
```

**Dependencies:** Gate P.

**Files likely touched:** Task 5–7 targets as needed for promotion; no secret-bearing evidence files.

- [x] **Task 9: Add the requested patch changeset and complete review**

**Description:** Add release metadata and review the promoted, Gate-P-proven implementation only after the live pilot and post-pilot verification establish what is genuinely supported.

**Acceptance criteria:**

- [ ] `.changeset/codex-remote-conductor.md` names `@chankov/agent-fleet` with a `patch` bump, per the confirmed user decision.
- [ ] The summary covers the experimental Codex conductor, `0.144.x` capability preflight, user-systemd lifecycle, serialized list-only delegation, package/setup closure, and advisory damage-control limitation without secrets or host-specific pairing data.
- [ ] Review explicitly records that patch is a user-approved exception to the normal new-command guidance in `CONTRIBUTING.md`/`.changeset/README.md`; no implementer silently changes the bump.

**Verification:**

```bash
npx changeset status
```

**Dependencies:** Task 8.

**Files likely touched (1):**

- `.changeset/codex-remote-conductor.md` (new)

## Final Verification Matrix

| Surface | Command / evidence | Required assertion |
| --- | --- | --- |
| Static CLI | Gate S commands | Exact binary, `0.144.x`, start/stop/pair, approval/sandbox syntax, documented loading candidate; no mutation |
| Coms safety | `node --test scripts/lib/coms-cli-core.test.ts scripts/lib/coms-cli-process.test.ts scripts/lib/team-project.test.ts` | Per-command project/name validation, strict current-list targeting, project-scoped spool migration, two-process Codex lock |
| Lifecycle unit | `node --test scripts/lib/codex-remote-control.test.ts` | ExecStart preflight, requested-state idempotence/recovery, capability-checked emergency stop after drift/restoration requirement, drift-safe uninstall, rendering, ownership, rollback, no secrets |
| Layout model | `node --test scripts/lib/team-project.test.ts scripts/lib/herdr-layout.test.ts` | Typed backends, distinct labels, root cwd/env, pending base-team compatibility |
| Real team-up | `node --test scripts/lib/fleet-extras.test.ts scripts/lib/team-project.test.ts` | Hermes/Codex dry runs, invalid flags, no host reads, config mismatch refusal |
| Pilot recipes | `just conductor-dry docs --project af`; `just conductor-codex-pilot-dry docs --project af`; `just --list` | Backward-compatible Hermes; deterministic, non-public Codex pilot control pane |
| Distribution | `node --test bin/test/package-surfaces.test.js`; `npm run pack:dry` | Package/snapshot/setup/runtime closure; tests excluded from tarball |
| Full regression | `npm test` | Existing hub/team/snapshot/coms/Hermes behavior remains green |
| Runtime lifecycle | Gate L | Observed daemon singleton/start/stop semantics, no inferred port/PID |
| Live host pilot | Gate P | User unit, pairing, root/contract, approvals, serialized send, stop |
| Post-pilot promotion | Task 8 checks | Public surface/docs/package verified only after Gate P |
| Release metadata | `npx changeset status` | Requested patch changeset and review present |

## Checkpoint — Complete

- [ ] Every task’s narrow RED/GREEN tests pass before moving to its dependents.
- [ ] `npm test`, `npm run pack:dry`, Hermes plus pilot Codex dry runs before Gate P, promoted Codex dry run after Gate P, and changeset status pass.
- [ ] Pending hub-only `base`-team edits are preserved and covered.
- [ ] Static evidence, observed lifecycle evidence, and live human evidence remain distinct.
- [ ] No implementation invents a foreground remote-control process, transport port, health endpoint, approval value, or undocumented flag.
- [ ] Both Hermes and Codex documentation describes advisory contracts outside Pi damage-control.
- [ ] Gate P is human-approved and contains no secret/pairing material in repository artifacts.
- [ ] The full `references/definition-of-done.md` checklist is satisfied.

## Safety and Rollback

### Safety invariants

- Fail closed on unsupported version/capability, an absent Gate-S documented loading candidate, config mismatch, ambiguous daemon ownership, unproved root/contract loading, inactive requested service state, unlisted target, invalid scope/timeout, or Codex lock contention. Codex public launch remains unavailable until Gate P passes.
- Never auto-pair, capture pairing output, copy Codex credentials, read auth files into dry-run output, or store secrets in the unit/config/repository.
- Never run `remote-control start` in a Herdr pane or claim systemd `active (exited)` proves daemon health. An operator-reported unavailable daemon in that requested state needs explicit confirmed recovery, not an inferred probe.
- Never infer a PID, websocket address/port, or undocumented status check.
- Codex mode is `on-request` plus `workspace-write` only when proved applicable. Never use a `writes` approval value.
- Herdr lifecycle remains human-owned. External Hermes/Codex contracts are advisory and do not extend Pi damage-control to those processes.

### Repository rollback

1. Remove Codex public recipes/backend wiring while retaining `just conductor`/`conductor-dry` as Hermes.
2. Remove `codex/conductor/AGENTS.md`, lifecycle helper/library/template, and their package/snapshot/setup entries.
3. Revert strict coms changes only if a proven regression requires it; preserve explicit project/name validation and do not reintroduce hidden-peer fallback without separate review.
4. Remove the unreleased patch changeset. After release, use a follow-up changeset; never rewrite a published `.versions/<version>/` snapshot.
5. Preserve unrelated pending `base`-team work throughout rollback.

### Host rollback

Repository rollback does **not** stop or remove an installed user service. After version/capability drift, normal start remains blocked. The shipped emergency stop/uninstall flow first performs a non-mutating capability check and may invoke the global `ExecStop` only when the current CLI proves the exact Gate-L-proven `remote-control stop` command; otherwise the operator must restore `0.144.x` before stopping or uninstalling. It operates only on the owned unit/config and requires explicit human confirmation before any global `ExecStop`. After the human confirms the owned unit is the active owner and accepts those conditions, use the shipped uninstall flow:

```bash
just conductor-codex-uninstall
```

Documented manual fallback:

```bash
systemctl --user disable --now agent-fleet-codex-remote-control.service
rm -f "$HOME/.config/systemd/user/agent-fleet-codex-remote-control.service"
rm -f "$HOME/.config/agent-fleet/codex-remote-control.json"
systemctl --user daemon-reload
systemctl --user reset-failed agent-fleet-codex-remote-control.service
```

The fallback is human-run and must refuse/stop for review if ownership is ambiguous. It intentionally does not delete `~/.codex`, credentials, or pairing state; no unpair command is invented.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Daemon start/stop differs from help implication | Broken or unsafe unit | Gate L before unit semantics; stop and re-plan on mismatch |
| `active (exited)` masks a dead daemon | False health claim | Label as requested state; live paired-client proof is the health gate; explicit operator-confirmed recovery only |
| Global `stop` affects another manually started daemon | Session disruption | Singleton policy, ownership marker, exact current-CLI stop-capability check, human confirmation, fail-closed setup/uninstall |
| No documented contract-loading candidate or remote session ignores it | Unscoped conductor | Stop at Gate S if no candidate; use it only on pilot path and require Gate P proof before public launch |
| Approval/sandbox options do not apply to remote sessions | Unsafe autonomy | Static applicability check and live allow/deny pilot; no fallback mode |
| Codex bypasses advisory contract or Codex mode | Parallel/unsafe commands | State boundary honestly; technical lock protects compliant Codex mode, not hostile processes |
| Crash leaves serialization lock | Future sends blocked | Fail closed; expose metadata and documented human recovery, never automatic stale deletion |
| Same final worktree tag in unrelated paths | Herdr label collision | Document residual; existing-workspace refusal prevents clobbering |
| Package/setup omits a transitive helper | Installed recipes fail | Tarball/import/setup closure test plus copy/symlink verification |
| Existing uncommitted base-team work is overwritten | Lost unrelated work/regression | Preserve current diff and assert root-only layout cwd/env in tests |

## Deferred / Out of Scope

- A foreground Codex remote-control process or direct websocket integration.
- Any fixed transport address, port, or custom health endpoint.
- Codex inbound `ask_user`; Hermes/Telegram remains the inbound path.
- A standing Codex coms peer, detached Codex sends, multi-recipient sends, or parallel Codex delegations.
- Simultaneous Codex remote-control services for multiple repositories/projects on this host.
- Conductor snapshot/resume; existing team snapshot behavior remains peer/hub-only.
- Automatic systemd installation during npm/guided setup, automatic pairing, credential management, or deleting Codex auth state.
- An OS-level command allowlist for Hermes or Codex. Their contracts remain advisory outside Pi damage-control.

## Open Questions

None requiring a product decision. Gates S, L, and P are factual compatibility checks with explicit stop conditions; failures must pause implementation rather than select an undocumented fallback.
