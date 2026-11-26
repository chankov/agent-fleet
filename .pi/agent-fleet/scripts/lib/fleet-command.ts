import {parseWorktreeSelection,type WorktreeSelection} from '../../../harnesses/lib/workspace-context.ts';
export interface FleetInvocation {
 selection?:WorktreeSelection;
 preview?:boolean;
	recipe: string;
	args: string[];
	/** A Herdr launcher preview (`--dry-run`): no runtime-dependency check, no Herdr. */
	dryRun?: true;
	warnings?: string[];
}

function bool(value: boolean): string {
	return value ? "true" : "false";
}

function requireValue(value: string | undefined, message: string): string {
	if (!value || value.startsWith("--")) throw new Error(message);
	return value;
}

interface HubParseDefaults {
	forceHerdr?: boolean;
	warnings?: string[];
}

// Retired Hub flags (PLAN-11-01, D7/D8): refused with the reason, not passed to pi.
const REMOVED_HUB_FLAGS: Record<string, string> = {
	"--agents": "--agents was removed: the Hub always has the editor, researcher and reviewer roles.",
	"--peers": "--peers was removed with peer groups: start each peer with `just fleet peer <name>`.",
};

function parseHubInvocation(args: string[], defaults: HubParseDefaults = {}): FleetInvocation {
	const options = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
	if (args.some(arg => arg === "--posture" || arg.startsWith("--posture="))) {
		throw new Error("--posture was removed; the Hub has one operator work mode.");
	}
	for (const arg of options) if (REMOVED_HUB_FLAGS[arg]) throw new Error(REMOVED_HUB_FLAGS[arg]);

	let herdr = defaults.forceHerdr ?? false;
	let noComs = false;
	let browser = false;
	let voice = false;
	let allExtensions = false;
	let dryRun = false;
	let projectSeen = false;
	let workModeSeen = false;
	let herdrSeen = false;
	let noComsSeen = false;
	let browserSeen = false;
	let voiceSeen = false;
	let allExtensionsSeen = false;
	let dryRunSeen = false;
	const rest: string[] = [];
	const warnings = [...(defaults.warnings ?? [])];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			rest.push(...args.slice(i));
			break;
		}
		switch (arg) {
			case "--work-mode": {
				if (workModeSeen) throw new Error("--work-mode may only be provided once");
				workModeSeen = true;
				// Deprecated (2026-11-11): one release of tolerance, then the flag goes.
				const value = requireValue(args[++i], "--work-mode requires a value");
				warnings.push(`\`--work-mode ${value}\` is deprecated and ignored: the Hub has one operator work mode.`);
				break;
			}
			case "--herdr":
				if (herdrSeen) throw new Error("--herdr may only be provided once");
				herdrSeen = true;
				herdr = true;
				break;
			case "--no-coms":
			case "--solo":
				if (noComsSeen) throw new Error("--no-coms/--solo may only be provided once");
				noComsSeen = true;
				noComs = true;
				if (arg === "--solo") warnings.push("`--solo` is deprecated; use `--no-coms`.");
				break;
			case "--browser":
				if (browserSeen) throw new Error("--browser may only be provided once");
				browserSeen = true;
				browser = true;
				break;
			case "--voice":
				if (voiceSeen) throw new Error("--voice may only be provided once");
				voiceSeen = true;
				voice = true;
				break;
			case "--all-extensions":
				if (allExtensionsSeen) throw new Error("--all-extensions may only be provided once");
				allExtensionsSeen = true;
				allExtensions = true;
				break;
			case "--dry-run":
				if (dryRunSeen) throw new Error("--dry-run may only be provided once");
				dryRunSeen = true;
				dryRun = true;
				break;
			case "--project":
				if (projectSeen) throw new Error("--project may only be provided once");
				projectSeen = true;
				rest.push(arg, requireValue(args[++i], "--project requires a name"));
				break;
			default:
				rest.push(arg);
		}
	}

	if (dryRun && !herdr) throw new Error("--dry-run requires --herdr");

	let invocation: FleetInvocation;
	if (herdr) {
		// The one-pane Herdr launcher forwards no Pi arguments into its pane.
		const unsupported = rest.filter((arg, index) => !(arg === "--project" || rest[index - 1] === "--project"));
		if (unsupported.length > 0) {
			throw new Error(`--herdr starts the Hub in a Herdr pane and forwards no Pi arguments (got ${unsupported.join(" ")}); run \`just fleet\` inside Herdr instead`);
		}
		invocation = {
			recipe: "_fleet-herdr",
			args: [
				...(noComs ? ["--no-coms"] : []),
				...(browser ? ["--browser"] : []),
				...(voice ? ["--voice"] : []),
				...(allExtensions ? ["--all-extensions"] : []),
				...rest,
				...(dryRun ? ["--dry-run"] : []),
			],
			...(dryRun ? { dryRun: true as const } : {}),
		};
	} else {
		invocation = {
			recipe: "_fleet-hub",
			args: [bool(noComs), bool(browser), bool(voice), bool(allExtensions), ...rest],
		};
	}
	if (warnings.length > 0) invocation.warnings = warnings;
	return invocation;
}

export function parseFleetCommand(argv: string[]): FleetInvocation {
 const {rest,selection}=parseWorktreeSelection(argv);
 const boundary=rest.indexOf('--'),end=boundary<0?rest.length:boundary;
 const options=rest.slice(0,end);
 const direct=(options.length===0||options[0].startsWith('--')||options[0]==='hub')&&!options.includes('--herdr')&&!options.includes('--conductor');
 const preview=Boolean(selection&&direct&&options.includes('--dry-run'));
 const effective=preview?rest.filter((arg,index)=>arg!=='--dry-run'||index>=end):rest;
 const invocation=parseFleetCommandBase(effective);
 if(selection&&['_fleet-lifecycle','_fleet-deps','_fleet-fix-codex-permissions'].includes(invocation.recipe))throw Error('--worktree selects a runtime checkout, not an installation target; run lifecycle commands from af without this flag');
 return selection?{...invocation,selection,...(preview?{preview:true}:{})}:invocation;
}
function parseFleetCommandBase(argv: string[]): FleetInvocation {
	if (argv.length === 0 || argv[0].startsWith("--")) {
		return parseHubInvocation(argv);
	}

	const [mode, ...tail] = argv;
	if (mode === "install") {
		throw new Error("just fleet install was removed; use `just fleet setup` for lifecycle setup or `just fleet deps` for runtime dependencies");
	}
	if (mode === "fix-codex-permissions") {
		if (tail.length) throw new Error("fix-codex-permissions takes no arguments");
		return { recipe: "_fleet-fix-codex-permissions", args: [] };
	}
	if (mode === "deps") return { recipe: "_fleet-deps", args: tail };
	if (["setup", "doctor"].includes(mode)) return { recipe: "_fleet-lifecycle", args: [mode, ...tail] };
	// `just fleet config` is the terminal twin of the in-session /af-config screen: the read-only inspect report.
	if (mode === "config" || mode === "inspect") return { recipe: "_fleet-lifecycle", args: ["inspect", ...tail] };
	if (mode === "uninstall") return { recipe: "_fleet-lifecycle", args: ["uninstall", ...tail] };

	// One addressable peer, in a pane of its own unless --here. peer-launch.ts
	// owns the whole flag set (including `--` passthrough to pi), so the tail is
	// forwarded verbatim rather than pre-chewed the way core/hub capabilities are.
	if (mode === "peer") {
		requireValue(tail[0], "fleet peer requires a peer name");
		return { recipe: "_fleet-peer-launch", args: tail };
	}

	if (mode === "hub") {
		return parseHubInvocation(tail, {
			warnings: ["`just fleet hub` is a compatibility alias; use `just fleet` with canonical flags."],
		});
	}

	// Peer groups are gone (PLAN-11-01, D8/D14). The empty `base` group meant
	// "Hub only", so that one spelling keeps working as an alias of --herdr.
	if (mode === "team") {
		const team = requireValue(tail[0], "fleet team requires a name");
		if (team !== "base") {
			throw new Error(`\`just fleet team ${team}\` was removed with peer groups: use \`just fleet --herdr\` for the Hub and \`just fleet peer <name>\` for each peer`);
		}
		return parseHubInvocation(tail.slice(1), {
			forceHerdr: true,
			warnings: ["`just fleet team base` is a compatibility alias; use `just fleet --herdr`."],
		});
	}

	if (mode === "snapshot" || mode === "down" || mode === "resume") {
		throw new Error(`\`just fleet ${mode}\` was removed with peer groups; close a workspace with \`herdr workspace close <id>\``);
	}

	// One Hermes conductor pane on the same one-pane launcher (D15). The
	// optional name only labels the workspace.
	if (mode === "conductor") {
		const backend = requireValue(tail[0], "fleet conductor requires hermes");
		if (backend !== "hermes") throw new Error(`Unknown conductor backend: ${backend}`);
		const rest = tail.slice(1);
		const name = rest[0] && !rest[0].startsWith("--") ? rest[0] : "full";
		const afterName = rest[0] === name ? rest.slice(1) : rest;
		return {
			recipe: "_fleet-conductor",
			args: [name, ...afterName],
			...(afterName.includes("--dry-run") ? { dryRun: true as const } : {}),
		};
	}

	throw new Error(`Unknown fleet mode: ${mode}`);
}
