export interface FleetInvocation {
	recipe: string;
	args: string[];
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

const CODEX_LIFECYCLE = new Set(["setup", "reconfigure", "pair", "start", "status", "stop", "recover", "uninstall"]);

export function parseFleetCommand(argv: string[]): FleetInvocation {
	if (argv.length === 0 || argv[0].startsWith("--")) {
		const c = capabilities(argv);
		return { recipe: "_fleet-core", args: [bool(c.browser), bool(c.voice), bool(c.allExtensions), ...c.rest] };
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
		const solo = withoutFlag(tail, "--solo");
		const c = capabilities(solo.rest);
		return { recipe: "_fleet-hub", args: [bool(solo.present), bool(c.browser), bool(c.voice), bool(c.allExtensions), ...c.rest] };
	}

	if (mode === "team") {
		const team = requireValue(tail[0], "fleet team requires a team preset");
		const noHub = withoutFlag(tail.slice(1), "--no-hub");
		const dry = withoutFlag(noHub.rest, "--dry-run");
		const c = capabilities(dry.rest);
		if (noHub.present && (c.browser || c.allExtensions)) {
			throw new Error("--browser/--all-extensions requires the hub; peer capabilities belong in .pi/agents/peers.yaml");
		}
		const recipe = noHub.present
			? dry.present ? "_fleet-team-up-dry" : "_fleet-team-up"
			: dry.present ? "_fleet-hub-team-dry" : "_fleet-hub-team";
		const forwarded = [...c.rest];
		if (c.browser) forwarded.push("--browser");
		if (c.allExtensions) forwarded.push("--all-extensions");
		return { recipe, args: [team, ...forwarded] };
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
