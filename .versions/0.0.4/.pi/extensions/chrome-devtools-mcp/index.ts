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

// Build the chrome-devtools-mcp CLI args from env, so the same always-on extension
// can run headed (default, for interactive debugging) or headless (for background /
// CI runs), and can attach to or persist a profile:
//
//   PI_CHROME_DEVTOOLS_MODE=headless|headed   (default: headed) → adds --headless
//   PI_CHROME_DEVTOOLS_BROWSER_URL=http://127.0.0.1:9222        → attaches via --browserUrl
//   PI_CHROME_DEVTOOLS_USER_DATA_DIR=/path/to/profile           → persistent --userDataDir
//
// The MCP server is launched once at extension load, so changing these requires a
// pi reload (restart / `/reload`) to take effect.
function buildChromeDevToolsArgs(): string[] {
	const args = ["-y", "chrome-devtools-mcp@latest", "--no-usage-statistics", "--no-performance-crux"];

	const browserUrl = process.env.PI_CHROME_DEVTOOLS_BROWSER_URL?.trim();
	if (browserUrl) {
		// Attaching to an already-running Chrome — launch-time flags (headless, profile)
		// are governed by that instance, so don't pass them.
		args.push("--browserUrl", browserUrl);
		return args;
	}

	if (process.env.PI_CHROME_DEVTOOLS_MODE?.trim().toLowerCase() === "headless") {
		args.push("--headless");
	}

	const userDataDir = process.env.PI_CHROME_DEVTOOLS_USER_DATA_DIR?.trim();
	if (userDataDir) {
		// A persistent profile is mutually exclusive with --isolated (which forces an
		// ephemeral temp dir cleaned up on close).
		args.push("--userDataDir", userDataDir);
	} else {
		args.push("--isolated");
	}

	return args;
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
	args: buildChromeDevToolsArgs(),
	env: buildChromeDevToolsEnv(),
	stderr: "pipe",
	labelPrefix: "Chrome DevTools",
});
