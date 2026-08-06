// Unified `just fleet` command dispatcher. Parsing is kept pure and tested in
// scripts/lib/fleet-command.test.ts; this entrypoint only hands the resolved
// recipe back to Just so existing compatibility recipes remain one source of truth.

import { spawnSync } from "node:child_process";
import { parseFleetCommand } from "./lib/fleet-command.ts";
import { resolveMonitorEnv } from "./lib/monitor-env.ts";

const HELP = `Agent Fleet — unified Pi runtime

SET UP A NEW REPOSITORY
  just fleet setup
      The easiest TUI entry point. It runs npx @chankov/agent-fleet@latest setup
      from this repository, so it needs npm registry access unless @latest is cached.
      Select Default/Full and optional features, inspect the exact plan, then
      confirm once to apply it. Source checkout development: node bin/cli.js setup.

QUICK START
  just fleet
      Start the default guarded Pi session with Fleet Core.

  just fleet hub --project af
      Start Agent Hub with specialists, research, Verification Contract, and coms.

  just fleet team frontend --project af
      Start a guarded Hub plus the frontend peer team in one Herdr workspace.

FLEET CORE — loaded in every Pi mode
  Damage Control Continue · local/remote ask_user · Compact & Continue
  BTW side sessions · update checker (voice is opt-in with --voice)

SESSION MODES
  just fleet [PI_ARGS...]
      Safe interactive Pi without Hub or a coms identity.
      Example: just fleet --model openai-codex/gpt-5.6-terra

  just fleet peer <name> [--runner pi|claude-code] [--persona <p>|--no-persona]
                         [--model <m>] [--project <p>] [--extensions a,b]
                         [--browser] [--all-extensions] [--direction right|down]
                         [--here] [--dry-run] [-- PI_ARGS...]
      ONE addressable coms peer, in a herdr pane of its own. Inside herdr it
      splits the current pane; outside it creates a single-pane workspace;
      --here runs it in this terminal instead.
      The NAME decides the shape: a name declared in .pi/agents/peers.yaml keeps
      its runner/model/extensions/env_file, a name matching agents/<name>.md
      becomes that persona peer, and anything else is a plain Fleet Core peer
      under that identity. --runner claude-code needs no manifest at all, and
      --no-persona forces the plain shape for a name that matches a persona.
      Raw pi arguments go after a "--" separator and need the plain shape.
      Examples:
        just fleet peer code-reviewer --project af
        just fleet peer scratch-reviewer --runner claude-code --model opus --project af
        just fleet peer web-debugger --browser --project af
        just fleet peer nick --here --project af
        just fleet peer architect --no-persona --here -- --session /path/to/session.json

  just fleet hub [--solo] [PI_ARGS...]
      Agent Hub dispatcher. Embedded coms is on unless --solo is supplied.
      Examples:
        just fleet hub --project af
        just fleet hub --solo

TEAM MODES — presets: base, full, web, docs, default, debug, frontend,
             security, hotfix, release, info, review, plan
  just fleet team <preset> [TEAM_ARGS...]
      Guarded Hub plus guarded reusable peers in one Herdr workspace.
      Example: just fleet team security --project af

  just fleet team <preset> --no-hub [TEAM_ARGS...]
      Guarded reusable peers only; no Hub pane.
      Example: just fleet team docs --no-hub --project af

  just fleet team <preset> [--no-hub] --dry-run [TEAM_ARGS...]
      Print the resolved workspace, panes, and commands without changing Herdr.
      Example: just fleet team frontend --dry-run --project af

TEAM LIFECYCLE
  just fleet snapshot <preset> [--project <name>]
      Save session references while the workspace keeps running.

  just fleet down <preset> [--project <name>]
      Snapshot and cleanly close the workspace.

  just fleet resume <preset> [--project <name>]
      Rebuild the workspace and resume available Pi/Claude sessions.

  Examples:
    just fleet snapshot docs --project af
    just fleet down docs --project af
    just fleet resume docs --project af

HERMES CONDUCTOR
  just fleet conductor hermes [preset] [--dry-run] [TEAM_ARGS...]
      Start Hermes with a peer team, or preview the layout with --dry-run.
      Example: just fleet conductor hermes docs --project af

CODEX REMOTE-CONTROL CONDUCTOR
  just fleet conductor codex <setup|reconfigure> [preset] [ARGS...]
  just fleet conductor codex <pair|start|status|stop|recover|uninstall>
  just fleet conductor codex [preset] [--dry-run] [TEAM_ARGS...]

  Typical flow:
    just fleet conductor codex setup docs --project af
    just fleet conductor codex pair
    just fleet conductor codex start
    just fleet conductor codex docs --project af
    just fleet conductor codex status
    just fleet conductor codex stop

CAPABILITY FLAGS
  --browser
      Add interactive Chrome DevTools MCP tools to the main Pi/Hub process.
      On a persona peer it adds the chrome-devtools-mcp extension instead.
      Example: just fleet hub --browser --project af

  --voice
      Load pi-voice-stt from .pi/extensions after selecting the voice setup feature.
      Example: just fleet --voice

  --all-extensions
      Also auto-load arbitrary project/global extensions outside Fleet Core.
      Not available to persona peers: reusable peers load a deterministic set,
      declared per peer via extensions: in .pi/agents/peers.yaml.
      Example: just fleet peer debugger --all-extensions --project af

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
  Teams:       .pi/agents/peers.yaml
  Hub teams:   .pi/agents/teams.yaml
  Overrides:   .ai/agent-fleet-overrides.md
  STT:         .ai/stt.json or ~/.pi/agent/stt.json
  Safety:      .pi/damage-control-rules.yaml
  Full docs:   docs/pi-extensions.md and docs/pi-setup.md
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
