import process from "node:process";
import { createMcpBridgeExtension } from "../mcp-bridge/index.js";

const GUI_ENV_KEYS = [
	"DISPLAY",
	"XAUTHORITY",
	"WAYLAND_DISPLAY",
	"XDG_RUNTIME_DIR",
	"XDG_SESSION_TYPE",
	"XDG_CURRENT_DESKTOP",
	"DBUS_SESSION_BUS_ADDRESS",
] as const;

const NODE_WEBSTORAGE_DISABLE_OPTION = "--no-experimental-webstorage";

function appendNodeOption(current: string | undefined, option: string): string {
	const parts = current?.trim() ? current.trim().split(/\s+/) : [];
	if (!parts.includes(option)) parts.push(option);
	return parts.join(" ");
}

function supportsNoExperimentalWebStorage(): boolean {
	const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
	return major >= 25;
}

function buildChromeDevToolsEnv(): Record<string, string> {
	const env: Record<string, string> = {};

	for (const key of GUI_ENV_KEYS) {
		const value = process.env[key];
		if (value) env[key] = value;
	}

	// Avoid unsolicited update-check output in the MCP child process.
	env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = "1";

	// Node 25 exposes experimental Web Storage. A bundled chrome-devtools-mcp
	// dependency probes localStorage at startup, which emits a
	// `--localstorage-file` warning unless Web Storage is disabled for this child.
	if (supportsNoExperimentalWebStorage()) {
		env.NODE_OPTIONS = appendNodeOption(process.env.NODE_OPTIONS, NODE_WEBSTORAGE_DISABLE_OPTION);
	}

	return env;
}

export default createMcpBridgeExtension({
	prefix: "chrome_devtools__",
	command: "npx",
	args: [
		"-y",
		"chrome-devtools-mcp@latest",
		"--isolated",
		"--no-usage-statistics",
		"--no-performance-crux",
	],
	env: buildChromeDevToolsEnv(),
	stderr: "pipe",
	labelPrefix: "Chrome DevTools",
});
