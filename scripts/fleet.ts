// Unified `just fleet` command dispatcher. Parsing is kept pure and tested in
// scripts/lib/fleet-command.test.ts; this entrypoint only hands the resolved
// recipe back to Just so existing compatibility recipes remain one source of truth.

import { spawnSync } from "node:child_process";
import { parseFleetCommand } from "./lib/fleet-command.ts";
import { resolveMonitorEnv } from "./lib/monitor-env.ts";

const HELP = `Agent Fleet — one guarded Hub runtime, two postures, independent topology

SET UP A NEW REPOSITORY
  just fleet setup
      The easiest TUI entry point. It runs npx @chankov/agent-fleet@latest setup
      from this repository, so it needs npm registry access unless @latest is cached.
      Select Default/Full and optional features, inspect the exact plan, then
      confirm once to apply it. Source checkout development: node bin/cli.js setup.

QUICK START
  just fleet                    # Hub/operator, empty native roster
  just fleet --agents frontend # Hub/orchestrator with native specialists
  just fleet --herdr --project af
                                # Hub/operator in a one-pane Herdr workspace
  just fleet --agents frontend --peers frontend --project af
                                # matching native roster + standing peers

FLEET CORE — loaded in every Pi mode
  Damage Control Continue · local/remote ask_user · Compact & Continue
  BTW side sessions · update checker (voice is opt-in with --voice)

UNIFIED HUB
  just fleet [--posture operator|orchestrator] [--agents <roster>]
             [--herdr] [--peers <preset>] [--no-coms] [PI_ARGS...]
      Bare Fleet always loads Agent Hub in operator posture. Operator keeps
      read/bash/edit/write plus orchestration; the initial native roster is empty.
      --agents selects .pi/agents/teams.yaml and implies orchestrator unless an
      explicit --posture operator is supplied. --no-coms leaves direct/native work
      available while coms, peer dispatch, and handoff refuse actionably.

POSTURE AND ROSTER
  /af-posture                    # report posture and capability state
  /af-agents-add code-reviewer  # add a native Pi specialist at runtime
  /af-posture orchestrator      # remove direct coding tools; keep orchestration
  /af-posture operator          # restore the approved direct tool surface

  Posture is independent from /af-hub-mode, the native roster, and peer topology.
  All Hub slash commands, including /af-handoff, stay registered in both postures;
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
  just fleet setup [--preset default|full --features none --yes]
      Reconcile desired state with the newest published package.
  just fleet deps
      Install only .pi/extensions and .pi/harnesses Node dependencies.
      Does not launch Pi, configure STT, install ffmpeg/Herdr, or pair Codex.
  just fleet doctor [--fix]
  just fleet uninstall --all --yes
      Reinstall after self-uninstall with npx @chankov/agent-fleet@latest setup.

UPDATE NOTE
  pi update --extensions updates pi extensions only; it does not update this npm
  installer. Run just fleet setup to resolve @latest and reconcile the workspace.
  just fleet install was removed; use setup or deps.

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
