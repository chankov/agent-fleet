import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const SESSION_START_STEP_ORDER = [
	"resetSession",
	"restartMonitor",
	"initializeComs",
	"initializeExemptions",
	"loadAgents",
	"applyOverrides",
	"restoreRoster",
	"resolveCapabilities",
	"notifyStartup",
	"updateWidget",
	"installFooter",
] as const;

export type SessionStartStep = (typeof SESSION_START_STEP_ORDER)[number];

export type SessionStartContext = ExtensionContext;

export type SessionStartDependencies = {
	[K in SessionStartStep]: (ctx: SessionStartContext) => void | Promise<void>;
};

function assertSessionStartDependencies(deps: SessionStartDependencies): void {
	for (const name of SESSION_START_STEP_ORDER) {
		if (typeof deps[name] !== "function") {
			throw new TypeError(`session_start dependency "${name}" must be a function`);
		}
	}
}

export async function runSessionStart(ctx: SessionStartContext, deps: SessionStartDependencies): Promise<void> {
	assertSessionStartDependencies(deps);
	for (const name of SESSION_START_STEP_ORDER) await deps[name](ctx);
}

/** Register the lifecycle hook while keeping all mutable Hub state composition-owned. */
export function registerSessionStart(pi: ExtensionAPI, deps: SessionStartDependencies): void {
	assertSessionStartDependencies(deps);
	pi.on("session_start", async (_event, ctx) => runSessionStart(ctx, deps));
}
