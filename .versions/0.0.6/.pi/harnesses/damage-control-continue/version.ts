import { readFileSync } from "node:fs";

export const VERSION_STATUS_KEY = "00-agent-fleet-version";

function readAdjacentVersion(): string | null {
	try {
		const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
		return typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : null;
	} catch {
		return null;
	}
}

export const HARNESS_VERSION = readAdjacentVersion();

export function registerVersionStatus(ctx: { ui?: { setStatus?: (key: string, text: string) => void } }): void {
	if (HARNESS_VERSION) ctx.ui?.setStatus?.(VERSION_STATUS_KEY, `v${HARNESS_VERSION}`);
}
