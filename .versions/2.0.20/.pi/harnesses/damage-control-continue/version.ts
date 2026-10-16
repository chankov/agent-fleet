import { readFileSync } from "node:fs";

export const VERSION_STATUS_KEY = "00-agent-fleet-version";
export const VERSION_LABEL = "agent fleet";
export const VERSION_LABEL_URL = "https://github.com/chankov/agent-fleet";

/**
 * Wrap `text` in an OSC 8 hyperlink. Terminals that support it make the label
 * clickable and hand the URL to the OS opener; terminals that don't ignore the
 * sequence and render `text` unchanged. pi's TUI strips OSC sequences before
 * measuring (`visibleWidth`) and truncating, so a linked label costs no footer
 * columns. Multiplexers that mangle unknown OSC (GNU screen, tmux before 3.4)
 * are the reason for the AGENT_FLEET_NO_LINKS opt-out below.
 */
export function linkify(text: string, url: string): string {
	return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function linksEnabled(): boolean {
	const optOut = process.env.AGENT_FLEET_NO_LINKS;
	return !optOut || optOut === "0" || optOut === "false";
}

export function formatVersionLabel(version: string): string {
	const label = linksEnabled() ? linkify(VERSION_LABEL, VERSION_LABEL_URL) : VERSION_LABEL;
	return `${label} v${version}`;
}

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
	if (HARNESS_VERSION) ctx.ui?.setStatus?.(VERSION_STATUS_KEY, formatVersionLabel(HARNESS_VERSION));
}
