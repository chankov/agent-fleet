export interface FlowCommand {
	name: string;
	args: string[];
	allowDirty: boolean;
	dryRun: boolean;
	runId?: string;
}

const FLOW_NAME = /^[a-z][a-z0-9-]*$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseFlowCommand(argv: string[]): FlowCommand {
	if (argv.length === 0) throw new Error("Usage: flow <name> [args] [--allow-dirty] [--run-id <id>] [--dry-run]");
	const name = argv[0];
	if (!FLOW_NAME.test(name)) throw new Error(`Invalid flow name: ${name}`);
	let allowDirty = false, dryRun = false, runId: string | undefined;
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
		} else if (arg.startsWith("--")) throw new Error(`Unknown flow option: ${arg}`);
		else args.push(arg);
	}
	return { name, args, allowDirty, dryRun, ...(runId ? { runId } : {}) };
}
