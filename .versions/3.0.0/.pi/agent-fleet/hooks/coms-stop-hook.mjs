#!/usr/bin/env node
// .pi/agent-fleet/hooks/coms-stop-hook.mjs — Claude Code Stop hook for the coms bridge.
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
//         "command": "node $CLAUDE_PROJECT_DIR/.pi/agent-fleet/hooks/coms-stop-hook.mjs" }] }]
//     }
//   }
//
// The hook receives {session_id, transcript_path, last_assistant_message, …}
// as JSON on stdin and must never fail the turn: every error path exits 0.
//
// The reply is this turn's final text, never an earlier one. Claude Code can
// run the Stop hook before the transcript file holds the turn's final message;
// reading the transcript then returned the PREVIOUS turn's reply (or an interim
// "checking…" line) as the answer to the current request, so a review request
// could receive the prior review's verdict. Current Claude Code passes the text
// as `last_assistant_message`; the transcript is only the fallback for older
// versions, and there only the current turn's finished message counts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TRANSCRIPT_WAIT_MS = 2000;
const TRANSCRIPT_POLL_MS = 100;

// A person's (or the bridge's) prompt starts a turn; tool results and Claude
// Code's meta entries do not.
function startsTurn(entry) {
	if (entry?.type !== "user" || entry.isMeta) return false;
	const content = entry?.message?.content;
	if (typeof content === "string") return true;
	return Array.isArray(content) && !content.some((c) => c?.type === "tool_result");
}

// The current turn's final text, or null while it is not on disk. Each message
// is stored as it streams; the final one ends the turn (stop_reason end_turn),
// an interim one stops for a tool call.
function currentTurnReply(transcriptPath) {
	const raw = fs.readFileSync(transcriptPath, "utf-8");
	let last = null;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (startsTurn(entry)) last = null;
		else if (entry?.type === "assistant") last = entry.message ?? null;
	}
	if (!last || last.stop_reason === "tool_use" || !Array.isArray(last.content)) return null;
	const parts = last.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
	return parts.length > 0 ? parts.join("\n") : null;
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function replyText(input) {
	const given = input?.last_assistant_message;
	if (typeof given === "string" && given.trim()) return given;
	const transcriptPath = input?.transcript_path;
	if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
	const deadline = Date.now() + TRANSCRIPT_WAIT_MS;
	for (;;) {
		const text = currentTurnReply(transcriptPath);
		// No record at all is honest (the bridge keeps waiting or falls back);
		// an earlier turn's text would be a wrong answer.
		if (text != null || Date.now() >= deadline) return text;
		sleepSync(TRANSCRIPT_POLL_MS);
	}
}

try {
	const paneId = process.env.HERDR_PANE_ID;
	if (!paneId) process.exit(0); // not in a herdr pane — nothing to bridge

	const input = JSON.parse(fs.readFileSync(0, "utf-8"));
	const transcriptPath = input?.transcript_path ?? null;

	const text = replyText(input);
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
	// `transcript_path` is written for the Hermes fleet panel, which reads this
	// file to find which ~/.claude/projects/*.jsonl belongs to a bridged peer.
	// The bridge mints its own coms session id and has no other link to Claude
	// Code's, so without this the panel could only guess by cwd — and a cwd
	// routinely holds several transcripts. The bridge ignores the extra key
	// (HookRecord carries an index signature).
	fs.writeFileSync(
		tmp,
		JSON.stringify({
			text,
			session_id: input.session_id ?? null,
			transcript_path: transcriptPath,
			written_at: new Date().toISOString(),
		}),
	);
	fs.renameSync(tmp, file);
} catch {
	// never fail the turn
}
process.exit(0);
