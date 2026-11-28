// Unified `just fleet` command dispatcher. Parsing is kept pure and tested in
// .pi/agent-fleet/scripts/lib/fleet-command.test.ts; this entrypoint only hands the resolved
// recipe back to Just so existing compatibility recipes remain one source of truth.

import { spawnSync } from "node:child_process";
import { parseFleetCommand } from "./lib/fleet-command.ts";
import { resolveMonitorEnv } from "./lib/monitor-env.ts";
import { assertRuntimeDependencies } from "./lib/runtime-dependencies.js";
import {resolveSessionRoots,sessionRootsFromEnv,type SessionRoots} from '../../harnesses/lib/workspace-context.ts';

const PI_LAUNCH_RECIPES = new Set([
	"_fleet-core",
	"_fleet-hub",
	"_fleet-herdr",
	"_fleet-conductor",
]);

const HELP = `Agent Fleet — one guarded Hub runtime with one operator, independent topology

СЕСИЕН WORKTREE TARGET
  just fleet --worktree ../repo.worktree --dry-run
  just fleet --worktree ../repo.worktree [--herdr] [--project example]
  just flow quality --worktree ../repo.worktree
      Workspace/config остава af; coding/Git cwd е регистрираният checkout.
      Селекторът е относителен към Fleet workspace. Няма global active target,
      worktree create/remove или автоматично разрешение за source export.
      /af-worktree status и /af-worktree-consent <consumer> показват scope.
      Targeted BTW/Hermes conductor отказват; external services не са изолирани.
      Guide: docs/session-worktree-targeting.md (source) или
      .pi/agent-fleet/docs/session-worktree-targeting.md (installed).

SET UP A NEW REPOSITORY
  npx @chankov/agent-fleet@latest setup
      Run this from the target repository. A repository without Agent Fleet has
      no justfile yet — setup writes it — so the first install cannot use just.
      Select Default/Full and optional features, inspect the exact plan, then
      confirm once to apply it. Follow with just fleet deps, then just fleet doctor.
      Source checkout development: node bin/cli.js setup.
      Once installed, just fleet setup wraps the same command for this repository.

QUICK START
  just fleet                    # Hub/operator with the editor, researcher and reviewer roles
  just fleet --herdr --project af
                                # Hub/operator in a one-pane Herdr workspace
  just fleet peer claude-reviewer --runner claude-code --read-only --project af
                                # one addressable peer in a pane of its own

DETERMINISTIC FLOWS
  just flow quality
  just flow scout "where is authentication configured?"
  just flow build-test "add the validated endpoint"
      Run code-owned headless phase graphs on the current branch; --branch runs one on a new flow/<name>-<runId> branch.

  just flow cleanup       # list flow branches and prompt for a number
  just flow cleanup 2     # safely remove empty/integrated selection 2
  just flow merge         # list flow branches and prompt for a number
  just flow merge 2       # squash-merge accepted selection 2, then remove it
      Cleanup and merge require Worktrunk. Dirty worktrees are refused; merge
      targets the source branch recorded when the run started. See
      docs/workflows.md in a source checkout, or
      .pi/agent-fleet/docs/workflows.md in an installed workspace.

FLEET CORE — loaded in every Pi mode
  Damage Control Continue · local/remote ask_user · Compact & Continue
  BTW side sessions · update check via damage-control-continue (voice is opt-in with --voice)

UNIFIED HUB
  just fleet [--herdr] [--no-coms] [PI_ARGS...]
      Fleet loads Agent Hub with its one operator: read/bash/edit/write plus
      delegation to the three runtime roles (editor, researcher, reviewer) with
      practices. --work-mode is deprecated and ignored. --no-coms leaves
      direct/native work available while coms, peer dispatch, and handoff
      refuse actionably. Budgets follow task tier.

  Explicit dispatch backend examples (inside the Hub):
    dispatch_agent({ agent: "reviewer", task: "Review the diff", backend: "native" })
    dispatch_agent({ agent: "reviewer", task: "Review the diff", backend: "coms" })
  backend "auto" follows .pi/agents/dispatch-policy.yaml; native always starts
  the local Pi specialist, while coms requires the live peer the role's route
  names and never falls back to native.

HERDR — requires a running Herdr server (https://herdr.dev)
  just fleet --herdr [--project <name>] [--no-coms] [--browser] [--voice]
                     [--all-extensions] [--dry-run]
      The Hub alone in a one-pane Herdr workspace. --dry-run prints the layout
      without touching Herdr. Start peers next to it with just fleet peer or
      herdr_spawn_peer.

  Dynamic Claude reviewer from a Hub already running inside Herdr:
    herdr_spawn_peer({ name: "claude-reviewer", runner: "claude-code", read_only: true })
    coms_send({ target: "claude-reviewer", prompt: "Review the current diff" })
    coms_await({ msg_id: "<returned-id>" })
    /af-handoff claude-reviewer
  Spawn requires Herdr; messaging and handoff require coms readiness and a
  target visible in this Hub's project pool. Every spawned peer gets a sibling
  pane and is locked to the Hub's project.

ONE STANDALONE PEER
  just fleet peer <name> [--runner pi|claude-code] [--persona <p>|--no-persona]
                         [--model <m>] [--read-only] [--env-file <path>]
                         [--project <p>] [--direction right|down]
                         [--here] [--dry-run] [-- PI_ARGS...]
      A single addressable peer; its settings are these flags. Inside Herdr it
      splits the current pane; outside it creates a one-pane workspace; --here
      uses this terminal. A same-named persona/role file starts a guarded Pi
      persona peer, otherwise a Fleet Core peer; --runner claude-code starts
      Claude Code plus its bridge. Every Pi peer loads Chrome DevTools MCP; a
      --read-only peer gets inspection tools only and no extension.

HERMES CONDUCTOR
  just fleet conductor hermes [name] [--project <name>] [--dry-run]
      Start Hermes alone in a one-pane Herdr workspace (the optional name labels
      the workspace), or preview the layout with --dry-run.

CAPABILITY FLAGS
  --browser         Add Chrome DevTools MCP tools to the Hub/main Pi process.
  --voice           Load pi-voice-stt after selecting the voice setup feature.
  --all-extensions  Also auto-load project/global extensions outside Fleet Core.
  --no-coms         Disable only the Hub's embedded coms layer.

COMPATIBILITY ALIASES — accepted with migration warnings
  just fleet hub [--solo] ...       -> just fleet [--no-coms] ...
  just fleet team base ...          -> just fleet --herdr ...
  Peer groups (--agents, --peers, team <preset>, snapshot/down/resume) were removed.

LIFECYCLE
  just fleet setup [--dry-run] [--preset default|full --features none --yes]
      Reconcile desired state with the newest published package. Preset and
      features are remembered in .ai/agent-fleet.json, so a plain setup needs no
      flags; flags apply to one run unless --save-desired persists them.
  just fleet deps
      Install Node dependencies for .pi/extensions, .pi/harnesses, and scripts.
      Does not launch Pi, configure STT, install ffmpeg/Herdr, or pair Codex.
  just fleet fix-codex-permissions
      Repair Linux Codex release permissions and start the managed daemon if its listener is missing.
  just fleet doctor [--fix]
  just fleet config
      Read-only JSON report (agent-fleet inspect): item states, verify/doctor findings,
      feature availability, provenance. The same facts as /af-config inside a session.
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
  Routing:        .pi/agents/dispatch-policy.yaml
  Overrides:      .ai/agent-fleet-overrides.md
  Safety:         .pi/damage-control-rules.yaml
  Full docs:      docs/pi-extensions.md and docs/pi-setup.md
`;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
		process.stdout.write(HELP);
		return;
	}
	let invocation;
 let roots:SessionRoots|undefined;
	try {
		invocation = parseFleetCommand(argv);
  const inherited=sessionRootsFromEnv();
  roots=invocation.selection?resolveSessionRoots(inherited?.workspaceRoot??process.cwd(),invocation.selection):inherited;
  if(roots?.mode==='targeted'&&invocation.recipe==='_fleet-conductor')throw Error('Targeted Hermes conductor is unsupported: external profile split-root contract is unverified; use the Hub or a targeted Pi peer');
  if(roots?.mode==='targeted'&&argv.slice(0,argv.indexOf('--')<0?argv.length:argv.indexOf('--')).includes('--all-extensions'))throw Error('--all-extensions is unsupported with --worktree; load explicit workspace extensions');
	} catch (err) {
		console.error(`fleet: ${err instanceof Error ? err.message : String(err)}\n`);
		process.stderr.write(HELP);
		process.exitCode = 2;
		return;
	}
	for (const warning of invocation.warnings ?? []) {
		console.error(`fleet: warning: ${warning}`);
	}
	// Refuse before Just/Pi starts. Without this guard a top-level extension
	// import can fail before agent-hub registers flags such as --project, making
	// a missing npm tree look like an unrelated "Unknown option" parser error.
	if (PI_LAUNCH_RECIPES.has(invocation.recipe) && !invocation.dryRun) {
		try {
			assertRuntimeDependencies(roots?.resourceRoot??process.cwd());
		} catch (error) {
   if(roots?.mode==='targeted'&&invocation.preview){console.log(JSON.stringify({ready:false,gaps:['missing_runtime_dependencies'],workspaceRoot:roots.workspaceRoot,executionRoot:roots.executionRoot,targetId:roots.targetId},null,2));process.exitCode=1;return;}
			console.error(`fleet: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
			return;
		}
	}
 let environment:NodeJS.ProcessEnv=process.env;
 if(roots?.mode==='targeted'){
  const {targetReadiness,targetEnvironment}=await import('./lib/session-launch.ts');
  const readiness=targetReadiness(roots);
  if(invocation.preview){console.log(JSON.stringify(readiness,null,2));process.exitCode=readiness.ready?0:1;return;}
  if(!readiness.ready){console.error(`fleet: targeted launch refused: ${readiness.gaps.join('; ')}`);process.exitCode=1;return;}
  environment=targetEnvironment(roots);
 }
	// Every mode gets the monitor variables, not just `hub`: a `peer` loads no
	// agent-hub and so reads them never, while the Hub modes reach agent-hub
	// through a Just recipe that inherits this environment (the Herdr launcher
	// forwards them as pane env). Deciding here rather than per recipe keeps it one line of
	// truth; a null answer (opted out, or no directory we can make private)
	// leaves the environment untouched and the hub unmonitored, exactly as
	// before this existed.
	const result = spawnSync("just", [invocation.recipe, ...invocation.args], {
		stdio: "inherit",
		env: { ...environment, ...(resolveMonitorEnv() ?? {}) },
  cwd:roots?.workspaceRoot??process.cwd(),
	});
	if (result.error) {
		console.error(`fleet: could not run just: ${result.error.message}`);
		process.exitCode = 1;
		return;
	}
	process.exitCode = result.status ?? 1;
}

main().catch(error=>{console.error(`fleet: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;});
