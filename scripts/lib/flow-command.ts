export interface FlowCommand {
	name: string;
	args: string[];
	allowDirty: boolean;
	dryRun: boolean;
	runId?: string;
	panel?: string;
}

export interface FlowMaintenanceCommand {
	action: "cleanup" | "merge";
	selector?: string;
	target?: string;
	discard: boolean;
	yes: boolean;
}

const FLOW_NAME = /^[a-z][a-z0-9-]*$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function safeRef(value: string): boolean {
	return SAFE_REF.test(value) && !value.includes("..") && !value.includes("//") && !value.includes("@{") && !value.endsWith("/") && !value.endsWith(".");
}

export function parseFlowMaintenanceCommand(argv: string[]): FlowMaintenanceCommand {
	const action = argv[0];
	if (action !== "cleanup" && action !== "merge") throw new Error("Usage: flow <cleanup|merge> [number|flow/branch] [options]");
	let selector: string | undefined, target: string | undefined, discard = false, yes = false;
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--discard") {
			if (discard) throw new Error("--discard may only be provided once");
			discard = true;
		} else if (arg === "--yes") {
			if (yes) throw new Error("--yes may only be provided once");
			yes = true;
		} else if (arg === "--target") {
			if (target) throw new Error("--target may only be provided once");
			const value = argv[++i];
			if (!value || value.startsWith("--") || !safeRef(value)) throw new Error("--target requires a safe local branch name");
			target = value;
		} else if (arg.startsWith("--")) throw new Error(`Unknown flow maintenance option: ${arg}`);
		else {
			if (selector) throw new Error("Only one flow branch selector may be provided");
			if (!/^\d+$/.test(arg) && (!arg.startsWith("flow/") || !safeRef(arg))) throw new Error("Selector must be a list number or a full flow/* branch name");
			selector = arg;
		}
	}
	if (action === "cleanup" && target) throw new Error("--target is valid only with flow merge");
	if (action === "merge" && discard) throw new Error("--discard is valid only with flow cleanup");
	return { action, ...(selector ? { selector } : {}), ...(target ? { target } : {}), discard, yes };
}

export function parseFlowCommand(argv: string[]): FlowCommand {
	if (argv.length === 0) throw new Error("Usage: flow <name> [args] [--allow-dirty] [--run-id <id>] [--dry-run] [--panel <name>]");
	const name = argv[0];
	if (!FLOW_NAME.test(name)) throw new Error(`Invalid flow name: ${name}`);
	let allowDirty = false, dryRun = false, runId: string | undefined, panel: string | undefined;
	const args: string[] = [];
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--allow-dirty") {
			if (allowDirty) throw new Error("--allow-dirty may only be provided once");
			allowDirty = true;
		} else if (arg === "--dry-run") {
			if (dryRun) throw new Error("--dry-run may only be provided once");
			dryRun = true;
		} else if (arg === "--run-id") {
			if (runId) throw new Error("--run-id may only be provided once");
			const value = argv[++i];
			if (!value || value.startsWith("--") || !RUN_ID.test(value)) throw new Error("--run-id requires a safe identifier");
			runId = value;
		} else if (arg === "--panel") {
			if (panel) throw new Error("--panel may only be provided once");
			const value = argv[++i];
			if (!value || value.startsWith("--")) throw new Error("--panel requires a panel name");
			panel = value;
		} else if (arg.startsWith("--")) throw new Error(`Unknown flow option: ${arg}`);
		else args.push(arg);
	}
	return { name, args, allowDirty, dryRun, ...(runId ? { runId } : {}), ...(panel ? { panel } : {}) };
}
