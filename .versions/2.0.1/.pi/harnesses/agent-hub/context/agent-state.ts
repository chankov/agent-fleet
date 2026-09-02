import * as fs from "node:fs";
import { renameSync } from "node:fs";
import { quarantineIfUnusable } from "../session-health.js";
import { safeAgentKey, safePathWithin } from "../helpers.ts";
import type { AgentDef, AgentState } from "../types.ts";

const SESSION_HEAD_BYTES = 64 * 1024;

function readSessionHead(file: string): string {
	const fd = fs.openSync(file, "r");
	try {
		const buffer = Buffer.alloc(SESSION_HEAD_BYTES);
		const read = fs.readSync(fd, buffer, 0, SESSION_HEAD_BYTES, 0);
		return buffer.subarray(0, read).toString("utf-8");
	} finally { fs.closeSync(fd); }
}

export function createAgentStateFactory(getSessionDir: () => string) {
	const io = { existsSync: fs.existsSync, readFileSync: readSessionHead, renameSync };
	const adoptableSessionFile = (def: AgentDef) => {
		const sessionFile = safePathWithin(getSessionDir(), `${safeAgentKey(def.name)}.json`);
		const health = quarantineIfUnusable(sessionFile, io);
		return { file: health.usable ? sessionFile : null, quarantined: health.quarantined, reason: health.reason };
	};
	const freshAgentState = (def: AgentDef, adoption = adoptableSessionFile(def)): AgentState => ({
		def, status: "idle", task: "", toolCount: 0, elapsed: 0, lastWork: "", contextPct: 0, contextTokens: 0,
		sessionFile: adoption.file, runCount: 0, runsSinceFresh: 0, timeline: [],
	});
	return { sessionHealthIo: io, adoptableSessionFile, freshAgentState, quarantine: (def: AgentDef) => quarantineIfUnusable(safePathWithin(getSessionDir(), `${safeAgentKey(def.name)}.json`), io) };
}
