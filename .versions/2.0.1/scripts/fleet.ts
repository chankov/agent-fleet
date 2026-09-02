// Unified `just fleet` command dispatcher. Parsing is kept pure and tested in
// scripts/lib/fleet-command.test.ts; this entrypoint only hands the resolved
// recipe back to Just so existing compatibility recipes remain one source of truth.

import { spawnSync } from "node:child_process";
import { parseFleetCommand } from "./lib/fleet-command.ts";
import { resolveMonitorEnv } from "./lib/monitor-env.ts";

const HELP = `Agent Fleet — one guarded Hub runtime, two work modes, independent topology

SET UP A NEW REPOSITORY
  npx @chankov/agent-fleet@latest setup
      Run this from the target repository. A repository without Agent Fleet has
      no justfile yet — setup writes it — so the first install cannot use just.
      Select Default/Full and optional features, inspect the exact plan, then
      confirm once to apply it. Follow with just fleet deps, then just fleet doctor.
      Source checkout development: node bin/cli.js setup.
      Once installed, just fleet setup wraps the same command for this repository.

QUICK START
  just fleet                    # Hub/operator, empty native roster
  just fleet --agents frontend # Hub/orchestrator with native specialists
  just fleet --herdr --project af
                                # Hub/operator in a one-pane Herdr workspace
  just fleet --agents frontend --peers frontend --project af
                                # matching native roster + standing peers

DETERMINISTIC FLOWS
  just flow quality
  just flow scout "where is authentication configured?"
  just flow build-test "add the validated endpoint"
      Run code-owned headless phase graphs on isolated flow/<name>-<runId> branches.

  just flow cleanup       # list flow branches and prompt for a number
  just flow cleanup 2     # safely remove empty/integrated selection 2
  just flow merge         # list flow branches and prompt for a number
  just flow merge 2       # squash-merge accepted selection 2, then remove it
      Cleanup and merge require Worktrunk. Dirty worktrees are refused; merge
      targets the source branch recorded when the run started. See docs/workflows.md.

FLEET CORE — loaded in every Pi mode
  Damage Control Continue · local/remote ask_user · Compact & Continue
  BTW side sessions · update checker (voice is opt-in with --voice)

UNIFIED HUB
  just fleet [--work-mode operator|orchestrator] [--agents <roster>]
             [--herdr] [--peers <preset>] [--no-coms] [PI_ARGS...]
      Bare Fleet always loads Agent Hub in operator work mode. Operator keeps
      read/bash/edit/write plus orchestration; the initial native roster is empty.
      --agents selects .pi/agents/teams.yaml and implies orchestrator unless an
      explicit --work-mode operator is supplied. --no-coms leaves direct/native work
      available while coms, peer dispatch, and handoff refuse actionably.

WORK MODE AND ROSTER
  /af-work-mode                 # report work mode and capability state
  /af-agents-add code-reviewer  # add a native Pi specialist at runtime
  /af-work-mode orchestrator    # remove direct coding tools; keep orchestration
  /af-work-mode operator        # restore the approved direct tool surface

  Work mode is independent from the native roster and peer topology. Budgets follow task tier.
  All Hub slash commands, including /af-handoff, stay registered in both work modes;
  actions whose coms/Herdr capability is unavailable return remediation guidance.

  Explicit dispatch backend examples (inside the Hub):
    dispatch_agent({ agent: "code-reviewer", task: "Review the diff", backend: "native" })
    dispatch_agent({ agent: "code-reviewer", task: "Review the diff", backend: "coms" })
  backend "auto" follows .pi/agents/dispatch-policy.yaml; native always starts
  the local Pi specialist, while coms requires a live same-name peer and never
  falls back to native.

HERDR TOPOLOGY — requires a running Herdr server (https://herdr.dev)
  just fleet --herdr [--project <name>]
      Hub-only workspace using the empty base peer preset.

  just fleet --peers <preset> [--agents <roster>] [--project <name>]
      Add standing Pi/Claude peers from .pi/agents/peers.yaml. Hub and every peer
      receive the same project. Add --dry-run to print the redacted layout only.

  Dynamic Claude reviewer from a Hub already running inside Herdr:
    herdr_spawn_peer({ name: "code-reviewer" })
    coms_send({ target: "code-reviewer", prompt: "Review the current diff" })
    coms_await({ msg_id: "<returned-id>" })
    /af-handoff code-reviewer
  The declared runner may be Claude Code. Spawn requires Herdr; messaging and
  handoff require coms readiness and a target visible in this Hub's project pool.
  Every spawned peer gets a sibling pane and is locked to the Hub's project.

ONE STANDALONE PEER
  just fleet peer <name> [--runner pi|claude-code] [--persona <p>|--no-persona]
                         [--model <m>] [--project <p>] [--extensions a,b]
                         [--browser] [--all-extensions] [--direction right|down]
                         [--here] [--dry-run] [-- PI_ARGS...]
      A single addressable peer. Inside Herdr it splits the current pane; outside
      it creates a one-pane workspace; --here uses this terminal. A peers.yaml
      declaration controls runner/model/extensions/env_file. A matching persona
      starts guarded Pi; --runner claude-code starts Claude Code plus its bridge.

TEAM LIFECYCLE
  just fleet snapshot <preset> [--project <name>]
  just fleet down <preset> [--project <name>]
  just fleet resume <preset> [--project <name>]
      Save session refs, close cleanly, and rebuild available Pi/Claude sessions.

HERMES CONDUCTOR
  just fleet conductor hermes [preset] [--dry-run] [TEAM_ARGS...]
      Start Hermes with a peer team, or preview the layout with --dry-run.

CODEX REMOTE-CONTROL CONDUCTOR
  just fleet conductor codex <setup|reconfigure> [preset] [ARGS...]
  just fleet conductor codex <pair|start|status|stop|recover|uninstall>
  just fleet conductor codex [preset] [--dry-run] [TEAM_ARGS...]

CAPABILITY FLAGS
  --browser         Add Chrome DevTools MCP tools to the Hub/main Pi process.
  --voice           Load pi-voice-stt after selecting the voice setup feature.
  --all-extensions  Also auto-load project/global extensions outside Fleet Core.
  --no-coms         Disable only the Hub's embedded coms layer.

COMPATIBILITY ALIASES — accepted with migration warnings
  just fleet hub [--solo] ...       -> just fleet [--no-coms] ...
  just fleet team <preset> ...      -> just fleet --agents <roster> --peers <preset> ...
  just fleet team <preset> --no-hub -> legacy peers-only topology
  Legacy peer-only presets full/web/docs retain the default native roster.

LIFECYCLE
  just fleet setup [--dry-run] [--preset default|full --features none --yes]
      Reconcile desired state with the newest published package. Preset and
      features are remembered in .ai/agent-fleet.json, so a plain setup needs no
      flags; flags apply to one run unless --save-desired persists them.
  just fleet deps
      Install only .pi/extensions and .pi/harnesses Node dependencies.
      Does not launch Pi, configure STT, install ffmpeg/Herdr, or pair Codex.
  just fleet doctor [--fix]
  just fleet uninstall --all --yes
      Reinstall after self-uninstall with npx @chankov/agent-fleet@latest setup.

UPDATE NOTE
  Update with: just fleet setup --dry-run, then just fleet setup, then deps+doctor.
  setup reconciles TOWARD the package: an artifact you edited in place is
  refreshed and your edit overwritten. --dry-run shows that before it happens;
  .ai/agent-fleet-overrides.md is the customization no lifecycle command touches.
  If you and the new version changed the same file, setup exits 3 having written
  nothing — re-run with --on-conflict theirs or --on-conflict ours.
  pi update --extensions updates pi extensions only; it does not update this npm
  installer. just fleet install was removed; use setup or deps.

HELP
  just                 Show this complete command guide.
  just fleet help      Show this complete command guide.
  just --list          Show the intentionally small public recipe surface.

Configuration:
  Native rosters: .pi/agents/teams.yaml
  Peer presets:   .pi/agents/peers.yaml
  Routing:        .pi/agents/dispatch-policy.yaml
  Overrides:      .ai/agent-fleet-overrides.md
  Safety:         .pi/damage-control-rules.yaml
  Full docs:      docs/pi-extensions.md and docs/pi-setup.md
`;

function main(): void {
	const argv = process.argv.slice(2);
	if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
		process.stdout.write(HELP);
		return;
	}
	let invocation;
	try {
		invocation = parseFleetCommand(argv);
	} catch (err) {
		console.error(`fleet: ${err instanceof Error ? err.message : String(err)}\n`);
		process.stderr.write(HELP);
		process.exitCode = 2;
		return;
	}
	for (const warning of invocation.warnings ?? []) {
		console.error(`fleet: warning: ${warning}`);
	}
	// Every mode gets the monitor variables, not just `hub`: a plain `just fleet`
	// or a `peer` loads no agent-hub and so reads them never, while `hub` and
	// `team` both reach the hub through a Just recipe that inherits this
	// environment. Deciding here rather than per recipe keeps it one line of
	// truth; a null answer (opted out, or no directory we can make private)
	// leaves the environment untouched and the hub unmonitored, exactly as
	// before this existed.
	const result = spawnSync("just", [invocation.recipe, ...invocation.args], {
		stdio: "inherit",
		env: { ...process.env, ...(resolveMonitorEnv() ?? {}) },
	});
	if (result.error) {
		console.error(`fleet: could not run just: ${result.error.message}`);
		process.exitCode = 1;
		return;
	}
	process.exitCode = result.status ?? 1;
}

main();
