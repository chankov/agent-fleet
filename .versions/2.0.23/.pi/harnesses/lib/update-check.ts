/**
 * Fleet Core update check — surfaces an "update available" banner once per
 * interactive session when @chankov/agent-fleet has a newer published version
 * than the one recorded in `.ai/agent-fleet-setup.md`.
 *
 * damage-control-continue imports this helper so every `just fleet` launch
 * (Hub, peer, coms) gets the check without a standalone pi extension.
 *
 * Design constraints:
 *   - Never blocks session start. Callers schedule it; network I/O is bounded
 *     to a single 3s fetch and every error path is swallowed.
 *   - Shares the same XDG cache file as the CLI (`~/.cache/agent-fleet/
 *     latest-version.json`) so the CLI and Fleet Core do not double-fetch.
 *   - Honors AGENT_SKILLS_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER / CI opt-outs.
 *   - Skips headless hub children (no UI, or AGENT_HUB_AGENT_ID set).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "node:https";

import { AGENT_ID_ENV } from "./damage-control-shared.ts";

export const PACKAGE_NAME = "@chankov/agent-fleet";
export const RELEASES_URL = "https://github.com/chankov/agent-fleet/releases";
const REGISTRY = "https://registry.npmjs.org";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

const CACHE_DIR = join(
	process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
	"agent-fleet",
);
const DEFAULT_CACHE_FILE = join(CACHE_DIR, "latest-version.json");

export interface CachePayload {
	latest: string;
	checkedAt: number;
}

export type FleetUpdateCheckContext = {
	cwd?: string;
	hasUI?: boolean;
	ui?: {
		notify?: (message: string, level?: string) => void;
	};
};

export type FleetUpdateCheckDeps = {
	env?: NodeJS.Dict<string>;
	now?: () => number;
	cwd?: string;
	cacheFile?: string;
	exists?: (path: string) => boolean;
	readFile?: (path: string, encoding: "utf8") => string;
	writeFile?: (path: string, data: string, encoding: "utf8") => void;
	mkdir?: (path: string, opts: { recursive: boolean }) => void;
	fetchLatest?: (timeoutMs: number) => Promise<string | null>;
};

/**
 * Fire-and-forget entry used by damage-control-continue on session_start.
 * Must never reject into the harness.
 */
export function scheduleFleetUpdateCheck(ctx: FleetUpdateCheckContext, deps: FleetUpdateCheckDeps = {}): void {
	void runFleetUpdateCheck(ctx, deps).catch(() => {});
}

/**
 * Run the check and notify when an upgrade exists.
 * Returns the banner that was shown, or null when the check is skipped/silent.
 */
export async function runFleetUpdateCheck(
	ctx: FleetUpdateCheckContext,
	deps: FleetUpdateCheckDeps = {},
): Promise<string | null> {
	try {
		if (!shouldRun(ctx, deps)) return null;

		const recorded = readRecordedVersion(deps.cwd ?? ctx.cwd ?? process.cwd(), deps);
		if (!recorded) return null;

		let latest = readCacheFresh(deps);
		if (!latest) {
			const fetchLatest = deps.fetchLatest ?? fetchLatestFromRegistry;
			latest = await fetchLatest(FETCH_TIMEOUT_MS);
			if (latest) writeCache({ latest, checkedAt: (deps.now ?? Date.now)() }, deps);
		}
		if (!latest) return null;
		if (!isNewerVersion(latest, recorded)) return null;

		const banner = formatUpdateBanner(recorded, latest);
		ctx.ui?.notify?.(banner, "info");
		return banner;
	} catch {
		return null;
	}
}

export function formatUpdateBanner(recorded: string, latest: string): string {
	return [
		`agent-fleet update available: ${recorded} → ${latest}`,
		``,
		`In the workspace root:`,
		`  npx ${PACKAGE_NAME}@latest setup`,
		``,
		`Preview without writing:`,
		`  npx ${PACKAGE_NAME}@latest setup --dry-run`,
		``,
		`Releases:`,
		`  ${RELEASES_URL}`,
	].join("\n");
}

export function isNewerVersion(a: string, b: string): boolean {
	const [aMain, aPre = ""] = a.split("-", 2);
	const [bMain, bPre = ""] = b.split("-", 2);
	const aParts = aMain.split(".").map(Number);
	const bParts = bMain.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const ai = aParts[i] ?? 0;
		const bi = bParts[i] ?? 0;
		if (ai !== bi) return ai > bi;
	}
	if (!aPre && bPre) return true;
	if (aPre && !bPre) return false;
	return aPre > bPre;
}

export function isUpdateCheckDisabled(env: NodeJS.Dict<string> = process.env): boolean {
	return env.AGENT_SKILLS_NO_UPDATE_CHECK === "1"
		|| env.NO_UPDATE_NOTIFIER === "1"
		|| env.CI === "true";
}

function shouldRun(ctx: FleetUpdateCheckContext, deps: FleetUpdateCheckDeps): boolean {
	const env = deps.env ?? process.env;
	if (isUpdateCheckDisabled(env)) return false;
	if (env[AGENT_ID_ENV]) return false;
	if (ctx.hasUI !== true) return false;
	if (typeof ctx.ui?.notify !== "function") return false;
	return true;
}

function readRecordedVersion(cwd: string, deps: FleetUpdateCheckDeps): string | null {
	const exists = deps.exists ?? existsSync;
	const readFile = deps.readFile ?? readFileSync;
	const recordPath = join(cwd, ".ai", "agent-fleet-setup.md");
	if (!exists(recordPath)) return null;
	try {
		const text = readFile(recordPath, "utf8");
		const m = text.match(/^version:\s*([^\s#]+)/m);
		return m ? m[1].trim() : null;
	} catch {
		return null;
	}
}

function cacheFilePath(deps: FleetUpdateCheckDeps): string {
	return deps.cacheFile ?? DEFAULT_CACHE_FILE;
}

function readCacheFresh(deps: FleetUpdateCheckDeps): string | null {
	try {
		const exists = deps.exists ?? existsSync;
		const readFile = deps.readFile ?? readFileSync;
		const file = cacheFilePath(deps);
		if (!exists(file)) return null;
		const payload = JSON.parse(readFile(file, "utf8")) as CachePayload;
		if ((deps.now ?? Date.now)() - payload.checkedAt >= CACHE_TTL_MS) return null;
		return payload.latest;
	} catch {
		return null;
	}
}

function writeCache(payload: CachePayload, deps: FleetUpdateCheckDeps): void {
	try {
		const mkdir = deps.mkdir ?? mkdirSync;
		const writeFile = deps.writeFile ?? writeFileSync;
		const file = cacheFilePath(deps);
		mkdir(dirname(file), { recursive: true });
		writeFile(file, JSON.stringify(payload, null, 2), "utf8");
	} catch {
		// Cache write failed — fine, we'll re-fetch next session.
	}
}

function fetchLatestFromRegistry(timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		const url = `${REGISTRY}/${encodeURIComponent(PACKAGE_NAME).replace("%40", "@")}/latest`;
		const req = request(
			url,
			{ method: "GET", headers: { accept: "application/json" } },
			(res) => {
				if (res.statusCode !== 200) {
					res.resume();
					resolve(null);
					return;
				}
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => { body += chunk; });
				res.on("end", () => {
					try {
						const parsed = JSON.parse(body);
						resolve(typeof parsed.version === "string" ? parsed.version : null);
					} catch {
						resolve(null);
					}
				});
			},
		);
		req.on("error", () => resolve(null));
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			resolve(null);
		});
		req.end();
	});
}
