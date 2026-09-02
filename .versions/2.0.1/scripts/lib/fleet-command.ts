export interface FleetInvocation {
	recipe: string;
	args: string[];
	warnings?: string[];
}

interface Capabilities {
	browser: boolean;
	voice: boolean;
	allExtensions: boolean;
	rest: string[];
}

function capabilities(args: string[]): Capabilities {
	const rest: string[] = [];
	let browser = false;
	let voice = false;
	let allExtensions = false;
	for (const arg of args) {
		if (arg === "--browser") browser = true;
		else if (arg === "--voice") voice = true;
		else if (arg === "--all-extensions") allExtensions = true;
		else rest.push(arg);
	}
	return { browser, voice, allExtensions, rest };
}

function bool(value: boolean): string {
	return value ? "true" : "false";
}

function requireValue(value: string | undefined, message: string): string {
	if (!value || value.startsWith("--")) throw new Error(message);
	return value;
}

function withoutFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
	return { present: args.includes(flag), rest: args.filter((arg) => arg !== flag) };
}

interface HubParseDefaults {
	defaultAgents?: string;
	forceHerdr?: boolean;
	forcedPeers?: string;
	legacyAgents?: boolean;
	warnings?: string[];
}

function parseHubInvocation(args: string[], defaults: HubParseDefaults = {}): FleetInvocation {
	if (args.some(arg => arg === "--posture" || arg.startsWith("--posture="))) {
		throw new Error("--posture was removed; use --work-mode operator|orchestrator.");
	}

	let workMode: "operator" | "orchestrator" | undefined;
	let agents = defaults.defaultAgents;
	let peers = defaults.forcedPeers;
	let herdr = defaults.forceHerdr ?? false;
	let noComs = false;
	let browser = false;
	let voice = false;
	let allExtensions = false;
	let dryRun = false;
	let projectSeen = false;
	let agentsSeen = false;
	let peersSeen = false;
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
				const value = requireValue(args[++i], "--work-mode requires operator or orchestrator");
				if (value !== "operator" && value !== "orchestrator") throw new Error("--work-mode requires operator or orchestrator");
				workMode = value;
				break;
			}
			case "--agents":
				if (agentsSeen) throw new Error("--agents may only be provided once");
				agentsSeen = true;
				agents = requireValue(args[++i], "--agents requires a native roster name");
				break;
			case "--peers": {
				if (peersSeen) throw new Error("--peers may only be provided once");
				peersSeen = true;
				const value = requireValue(args[++i], "--peers requires a peer preset name");
				if (defaults.forcedPeers && value !== defaults.forcedPeers) {
					throw new Error(`Compatibility team preset ${defaults.forcedPeers} cannot combine with --peers ${value}`);
				}
				peers = value;
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

	if (workMode === "orchestrator" && !agents) throw new Error("--work-mode orchestrator requires --agents <roster>");
	const topology = herdr || peers !== undefined;
	if (dryRun && !topology) throw new Error("--dry-run requires --herdr or --peers");

	let invocation: FleetInvocation;
	if (topology) {
		const forwarded = [
			...(workMode ? ["--work-mode", workMode] : []),
			...(agents ? [defaults.legacyAgents ? "--legacy-agents" : "--agents", agents] : []),
			...(noComs ? ["--no-coms"] : []),
			...(browser ? ["--browser"] : []),
			...(voice ? ["--voice"] : []),
			...(allExtensions ? ["--all-extensions"] : []),
			...rest,
		];
		invocation = { recipe: dryRun ? "_fleet-hub-team-dry" : "_fleet-hub-team", args: [peers ?? "base", ...forwarded] };
	} else {
		invocation = {
			recipe: "_fleet-hub",
			args: [
				bool(noComs),
				bool(browser),
				bool(voice),
				bool(allExtensions),
				...(workMode ? ["--work-mode", workMode] : []),
				...(agents ? ["--agent-team", agents] : []),
				...rest,
			],
		};
	}
	if (warnings.length > 0) invocation.warnings = warnings;
	return invocation;
}

const CODEX_LIFECYCLE = new Set(["setup", "reconfigure", "pair", "start", "status", "stop", "recover", "uninstall"]);

export function parseFleetCommand(argv: string[]): FleetInvocation {
	if (argv.length === 0 || argv[0].startsWith("--")) {
		return parseHubInvocation(argv);
	}

	const [mode, ...tail] = argv;
	if (mode === "install") {
		throw new Error("just fleet install was removed; use `just fleet setup` for lifecycle setup or `just fleet deps` for runtime dependencies");
	}
	if (mode === "deps") return { recipe: "_fleet-deps", args: tail };
	if (["setup", "doctor"].includes(mode)) return { recipe: "_fleet-lifecycle", args: [mode, ...tail] };
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
			defaultAgents: "default",
			warnings: ["`just fleet hub` is a compatibility alias; use `just fleet` with canonical flags."],
		});
	}

	if (mode === "team") {
		const team = requireValue(tail[0], "fleet team requires a team preset");
		const noHub = withoutFlag(tail.slice(1), "--no-hub");
		if (!noHub.present) {
			return parseHubInvocation(noHub.rest, {
				defaultAgents: team === "base" ? undefined : team,
				forceHerdr: true,
				forcedPeers: team,
				legacyAgents: team !== "base",
				warnings: [team === "base"
					? "`just fleet team base` is a compatibility alias; use `just fleet --herdr`."
					: `\`just fleet team ${team}\` is a compatibility alias; use \`just fleet --agents <roster> --peers ${team}\`.`],
			});
		}
		const dry = withoutFlag(noHub.rest, "--dry-run");
		const c = capabilities(dry.rest);
		if (c.browser || c.allExtensions) {
			throw new Error("--browser/--all-extensions requires the hub; peer capabilities belong in .pi/agents/peers.yaml");
		}
		return {
			recipe: dry.present ? "_fleet-team-up-dry" : "_fleet-team-up",
			args: [team, ...c.rest],
			warnings: [`\`just fleet team ${team} --no-hub\` is a compatibility alias; prefer \`just fleet peer\` or a canonical Hub topology.`],
		};
	}

	if (mode === "snapshot" || mode === "down" || mode === "resume") {
		const team = requireValue(tail[0], `fleet ${mode} requires a team preset`);
		return { recipe: `_fleet-team-${mode === "snapshot" ? "snapshot" : mode}`, args: [team, ...tail.slice(1)] };
	}

	if (mode === "conductor") {
		const backend = requireValue(tail[0], "fleet conductor requires hermes or codex");
		if (backend !== "hermes" && backend !== "codex") throw new Error(`Unknown conductor backend: ${backend}`);
		const rest = tail.slice(1);
		if (backend === "hermes") {
			const team = rest[0] && !rest[0].startsWith("--") ? rest[0] : "full";
			const afterTeam = rest[0] === team ? rest.slice(1) : rest;
			const dry = withoutFlag(afterTeam, "--dry-run");
			return { recipe: dry.present ? "_fleet-conductor-dry" : "_fleet-conductor", args: [team, ...dry.rest] };
		}

		const action = rest[0];
		if (action && CODEX_LIFECYCLE.has(action)) {
			if (action === "setup" || action === "reconfigure") {
				const team = rest[1] && !rest[1].startsWith("--") ? rest[1] : "full";
				const afterTeam = rest[1] === team ? rest.slice(2) : rest.slice(1);
				return { recipe: `_fleet-conductor-codex-${action}`, args: [team, ...afterTeam] };
			}
			return { recipe: `_fleet-conductor-codex-${action}`, args: rest.slice(1) };
		}
		const team = action && !action.startsWith("--") ? action : "full";
		const afterTeam = action === team ? rest.slice(1) : rest;
		const dry = withoutFlag(afterTeam, "--dry-run");
		return { recipe: dry.present ? "_fleet-conductor-codex-dry" : "_fleet-conductor-codex", args: [team, ...dry.rest] };
	}

	throw new Error(`Unknown fleet mode: ${mode}`);
}
