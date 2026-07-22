#!/usr/bin/env node
// hooks/coms-stop-hook.mjs — Claude Code Stop hook for the coms bridge.
//
// Writes the final assistant message of each turn to the file the
// coms-claude-bridge watches (~/.pi/coms/claude-bridge/<pane>/last-message.json,
// keyed by HERDR_PANE_ID), making the hook the bridge's PRIMARY completion
// path (exact text, no pane scraping). Outside a herdr pane it does nothing.
//
// Install (project or user settings.json):
//   {
//     "hooks": {
//       "Stop": [{ "hooks": [{ "type": "command",
//         "command": "node /path/to/agent-fleet/hooks/coms-stop-hook.mjs" }] }]
//     }
//   }
//
// The hook receives {session_id, transcript_path, …} as JSON on stdin and
// must never fail the turn: every error path exits 0.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function lastAssistantText(transcriptPath) {
	const raw = fs.readFileSync(transcriptPath, "utf-8");
	let text = null;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "assistant") continue;
		const content = entry?.message?.content;
		if (!Array.isArray(content)) continue;
		const parts = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
		if (parts.length > 0) text = parts.join("\n");
	}
	return text;
}

try {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) process.exit(0); // not in a herdr pane — nothing to bridge

	const input = JSON.parse(fs.readFileSync(0, "utf-8"));
	const transcriptPath = input?.transcript_path;
	if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

	const text = lastAssistantText(transcriptPath);
	if (text == null) process.exit(0);

	const dir = path.join(
		os.homedir(),
		".pi",
		"coms",
		"claude-bridge",
		paneId.replace(/[^A-Za-z0-9_-]/g, "_"),
	);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "last-message.json");
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(
		tmp,
		JSON.stringify({ text, session_id: input.session_id ?? null, written_at: new Date().toISOString() }),
	);
	fs.renameSync(tmp, file);
} catch {
	// never fail the turn
}
process.exit(0);
