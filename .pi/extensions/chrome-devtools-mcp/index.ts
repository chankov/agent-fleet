import { createMcpBridgeExtension } from "../mcp-bridge/index.js";

export default createMcpBridgeExtension({
	prefix: "chrome_devtools__",
	command: "npx",
	args: [
		"-y",
		"chrome-devtools-mcp@latest",
		"--no-usage-statistics",
		"--no-performance-crux",
	],
	labelPrefix: "Chrome DevTools",
});
