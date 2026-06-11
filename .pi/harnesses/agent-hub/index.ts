/**
 * Agent Hub — Dispatcher orchestrator + embedded coms peer-to-peer layer
 *
 * The merged harness (plan: docs/plans/agent-hub-multi-agent-harness.md). It is
 * `agent-team` (dispatcher grid + per-agent model + kill/restart + /zoom +
 * read-only research helpers + dispatcher persona gate) with the `coms` P2P layer
 * EMBEDDED in the same extension — not stacked as a second `-e`, which would
 * double-register the --name/--purpose/... CLI flags and abort startup.
 *
 * So the dispatcher is ALSO a coms peer: it can use another long-lived peer as a
 * subagent (coms_send + coms_await), hand the whole session off to a peer
 * (/handoff), and be addressed by other peers as a subagent itself. If the coms
 * endpoint fails to bind, the harness degrades to a coms-less dispatcher
 * (comsReady=false withholds the coms_* tools).
 *
 * Commands:
 *   /agents-team          — switch active team
 *   /agents-list          — list loaded agents
 *   /agents-grid N        — set column count (default 2)
 *   /agents-kill <name>   — SIGTERM a frozen specialist
 *   /agents-restart <name>— kill + re-run its last task fresh
 *   /zoom <name|rN>       — scrollable read-only view of an agent's stream
 *   /research <task>      — spawn a read-only research helper (@persona, --model)
 *   /research-cont rN ... — resume a finished research helper
 *   /research-rm rN       — remove a research helper (kill if running)
 *   /research-clear       — remove all research helpers
 *   /persona              — select/reset the dispatcher persona
 *   /handoff <peer>       — hand the session off to a coms peer (summarized brief)
 *   /coms                 — refresh the coms peer pool (--all / --project <name>)
 *
 * Shortcuts:
 *   Alt+A                 — toggle agent view: dashboard grid (above editor) ↔
 *                           compact running-agents list (below editor: one line
 *                           per *running* agent — name · context · state)
 *
 * Identity flags (coms): --name --purpose --project --color --explicit
 *
 * Usage: just hub
 * Direct guarded launch: pi -e .pi/harnesses/damage-control/index.ts -e .pi/harnesses/agent-hub/index.ts
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme as getPiMdTheme, copyToClipboard } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	Text, Box, Container, Spacer, Markdown, matchesKey, Key,
	type AutocompleteItem, truncateToWidth, visibleWidth,
} from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "child_process";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	model?: string;
	kind?: string;
	// Per-agent thinking level for `/zoom` debugging. A pi --thinking level
	// (off|minimal|low|medium|high|xhigh), default off. When non-off, thinking
	// deltas are captured into the zoom timeline.
	thinking?: string;
	systemPrompt: string;
	file: string;
}

// One entry in an agent's zoom timeline (Phase 3). Consecutive text/thinking
// deltas are coalesced into the trailing entry of the same kind; each tool call
// is its own entry.
interface TimelineEntry {
	kind: "text" | "tool" | "thinking";
	title: string;
	content: string;
	timestamp: number;
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	sessionFile: string | null;
	runCount: number;
	timer?: ReturnType<typeof setInterval>;
	// Kill / restart (Phase 2). The live child is stored so a frozen specialist
	// can be SIGTERM'd. `killedByOperator` tells the close handler the exit was an
	// operator kill (so it returns a "do not auto-retry" message instead of a
	// normal error); `restarting` distinguishes a kill-for-restart from a plain
	// kill; `onTerminate` lets /agents-restart await the kill before re-dispatching.
	proc?: ChildProcess;
	killedByOperator?: boolean;
	restarting?: boolean;
	onTerminate?: () => void;
	// Zoom timeline (Phase 3). A structured, persisted record of the specialist's
	// stream — coalesced assistant text, tool calls (name + args), and thinking
	// deltas when the persona opts in. `/zoom` renders this; it survives completion
	// so post-hoc zoom works without reading the session file. `zoomRender` is set
	// while a `/zoom` overlay is open so the stream parser can refresh it live
	// (throttled; pass force=true for the final frame).
	timeline: TimelineEntry[];
	zoomRender?: (force?: boolean) => void;
}

// A read-only research helper (Phase 4). Spawned on demand to assist the standing
// team with reconnaissance/search/doc-reading — it never writes and never runs bash.
// Keyed by a numeric id surfaced to the operator as the handle `rN`. Ephemeral by
// construction: session files live under the same dir as team sessions and are wiped
// on session_start; `/research-clear` removes them mid-session. Resumable via
// `/research-cont` (subcont-style, bumping turnCount).
interface ResearchState {
	id: number;
	def: AgentDef;        // a `kind: research` persona, or a synthesized def for anon helpers
	persona: boolean;     // true → spawned from a persona; false → ad-hoc anonymous
	model: string;        // resolved pi model spec (shown on the card)
	status: "idle" | "running" | "done" | "error";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	sessionFile: string | null;  // set after a successful run → enables `-c` resume
	turnCount: number;
	timer?: ReturnType<typeof setInterval>;
	proc?: ChildProcess;
	killedByOperator?: boolean;
	timeline: TimelineEntry[];
	zoomRender?: (force?: boolean) => void;
}

// The subset of state `/zoom` needs. Both AgentState (standing team) and ResearchState
// (read-only helpers) satisfy it, so the same ZoomUI overlay renders either one.
interface Zoomable {
	def: { name: string };
	status: string;
	timeline: TimelineEntry[];
	zoomRender?: (force?: boolean) => void;
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── ASK_USER: marker extraction ──────────────────
// Specialists emit `ASK_USER: <question>` per the clarification protocol injected
// into their system prompt. We pull them out so the dispatcher can surface each.

function extractAskUserQuestions(output: string): string[] {
	const questions: string[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		const match = line.match(/^ASK_USER\s*:\s*(.+)$/i);
		if (match) {
			const q = match[1].trim();
			if (q && !questions.includes(q)) questions.push(q);
		}
	}
	return questions;
}

// ── NEEDS_RESEARCH: marker extraction ────────────
// Specialists emit `NEEDS_RESEARCH: <question>` per the research protocol when they
// need reconnaissance they cannot perform with their own tools. The HUB (not the
// dispatcher LLM) intercepts these in code: it fans out read-only research helpers,
// writes each helper's findings to a file under .pi/agent-sessions/findings/, and
// resumes the specialist's session with the file paths — so large findings never
// pass through the dispatcher's context.

function extractNeedsResearch(output: string): string[] {
	const questions: string[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		const match = line.match(/^NEEDS_RESEARCH\s*:\s*(.+)$/i);
		if (match) {
			const q = match[1].trim();
			if (q && !questions.includes(q)) questions.push(q);
		}
	}
	return questions;
}

// ── Overrides Parser (.ai/agent-skills-overrides.md) ──
// Reads the `## agent-team` section. Supported keys:
//   language: <name>   — user-facing language. Default: English.

interface AgentTeamOverrides {
	language: string;
	personaGate: boolean;
}

const DEFAULT_OVERRIDES: AgentTeamOverrides = {
	language: "English",
	personaGate: false,
};

function parseAgentTeamOverrides(cwd: string): AgentTeamOverrides {
	const path = join(cwd, ".ai", "agent-skills-overrides.md");
	if (!existsSync(path)) return { ...DEFAULT_OVERRIDES };

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return { ...DEFAULT_OVERRIDES };
	}

	const result: AgentTeamOverrides = { ...DEFAULT_OVERRIDES };
	let inSection = false;
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			inSection = heading[1].trim().toLowerCase() === "agent-team";
			continue;
		}
		if (!inSection) continue;
		const kv = line.match(/^\s*([a-zA-Z][\w-]*)\s*:\s*(.+?)\s*$/);
		if (!kv) continue;
		const key = kv[1].toLowerCase();
		const value = kv[2].trim();
		if (key === "language" && value) result.language = value;
		if (key === "persona-gate") result.personaGate = /^(on|true|yes|1)$/i.test(value);
	}
	return result;
}

// ── Teams YAML Parser ────────────────────────────

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			model: frontmatter.model || undefined,
			kind: frontmatter.kind || undefined,
			thinking: frontmatter.thinking || undefined,
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

// ── Thinking level + timeline helpers (Phase 3) ──

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

// Map a persona's `thinking:` frontmatter value to a pi --thinking level.
// Pass-through for valid levels; truthy words ("on"/"true"/"yes"/"1") → "low";
// anything else (or unset) → "off".
function resolveThinkingLevel(raw?: string): string {
	if (!raw) return "off";
	const v = raw.trim().toLowerCase();
	if (VALID_THINKING_LEVELS.has(v)) return v;
	if (v === "on" || v === "true" || v === "yes" || v === "1") return "low";
	return "off";
}

// Coalesce a streaming text/thinking delta into the timeline: extend the trailing
// entry when it's the same kind, otherwise start a new one.
function appendTimelineText(timeline: TimelineEntry[], kind: "text" | "thinking", delta: string) {
	if (!delta) return;
	const last = timeline[timeline.length - 1];
	if (last && last.kind === kind) {
		last.content += delta;
	} else {
		timeline.push({ kind, title: kind === "text" ? "Assistant" : "Thinking", content: delta, timestamp: Date.now() });
	}
}

// ── Zoom overlay (Phase 3) ───────────────────────
// Read-only, scrollable view of one specialist's stream, modelled on the
// session-replay overlay but reading a *live* AgentState.timeline so it updates
// while the agent runs. Holds a reference to the state (not a snapshot) so each
// render reflects newly-streamed events.

// ── Research helpers (Phase 4) ───────────────────
// Read-only by construction: a research helper only ever gets these tools — no bash,
// no write/edit — regardless of what its persona declares. This is the defining
// constraint of a research helper vs. a full specialist (requirement 3).
const RESEARCH_TOOLS = "read,grep,find,ls";

// Auto-research pipe budgets: how many NEEDS_RESEARCH pause/resume rounds a single
// dispatch_agent call may trigger, and how many questions are honored per round.
const MAX_AUTO_RESEARCH_ROUNDS = 2;
const MAX_AUTO_RESEARCH_QUESTIONS = 4;

// Appended to every research helper's system prompt so it knows its sandbox and how to
// report. Kept separate from the dispatcher's clarification protocol: helpers don't
// bubble up ASK_USER — they report findings and the dispatcher decides what to do.
const RESEARCH_PROTOCOL = `

## You are a READ-ONLY research helper
You can ONLY read, search, and list files (tools: read, grep, find, ls). You CANNOT
edit, write, or run shell/bash commands — they are not available to you. Investigate
what you're asked, then report findings concisely, citing concrete locations as
path:line. Do not propose or attempt edits; another agent will act on your findings.
If something can't be found or is ambiguous, say so plainly rather than guessing.`;

// System prompt for an ad-hoc (anonymous) research helper — one with no persona file.
const ANON_RESEARCH_PROMPT = `# Research Helper

You are an ad-hoc read-only research helper assisting a team of specialist agents.
Locate the relevant code or docs, read the surrounding context, and report concise,
well-cited findings the rest of the team can act on.`;

// Parse a research handle: "r3", "R3", "#3", or bare "3" → 3. null if not a handle.
function parseResearchHandle(arg: string): number | null {
	const m = arg.trim().match(/^#?r?(\d+)$/i);
	return m ? parseInt(m[1], 10) : null;
}

class ZoomUI {
	private selectedIndex = 0;
	private expandedIndex: number | null = null;
	private scrollOffset = 0;
	private followTail = true;
	private autoExpandedTailIndex: number | null = null;

	constructor(
		private state: Zoomable,
		private onDone: () => void,
		private notify: (message: string, type?: "info" | "success" | "warning" | "error") => void,
	) {}

	handleInput(data: string, tui: any): void {
		const n = this.state.timeline.length;
		if (matchesKey(data, Key.up)) {
			this.followTail = false;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(n - 1, this.selectedIndex + 1);
			if (this.selectedIndex >= n - 1) this.followTail = true;
		} else if (matchesKey(data, Key.enter)) {
			this.expandedIndex = this.expandedIndex === this.selectedIndex ? null : this.selectedIndex;
			if (this.followTail && this.selectedIndex >= n - 1) this.autoExpandedTailIndex = this.selectedIndex;
		} else if (matchesKey(data, Key.space) || matchesKey(data, Key.ctrl("c"))) {
			void this.copySelected();
		} else if (matchesKey(data, Key.escape)) {
			this.onDone();
			return;
		}
		tui.requestRender();
	}

	private async copySelected(): Promise<void> {
		const item = this.state.timeline[this.selectedIndex];
		if (!item) return;
		try {
			await copyToClipboard(item.content);
			this.notify("Copied selected zoom row", "success");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.notify(`Failed to copy selected zoom row: ${message}`, "error");
		}
	}

	private ensureVisible(height: number) {
		const pageSize = Math.max(1, Math.floor(height / 3));
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + pageSize) {
			this.scrollOffset = this.selectedIndex - pageSize + 1;
		}
	}

	render(width: number, height: number, theme: any): string[] {
		const items = this.state.timeline;
		// Live tail-follow: keep the selection pinned to the newest entry as the
		// stream grows, until the user scrolls up. Auto-expand each new tail entry
		// once so the latest message opens full, while still allowing Enter to collapse it.
		if (this.followTail && items.length > 0) {
			this.selectedIndex = items.length - 1;
			if (this.autoExpandedTailIndex !== this.selectedIndex) {
				this.expandedIndex = this.selectedIndex;
				this.autoExpandedTailIndex = this.selectedIndex;
			}
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
		this.ensureVisible(height);

		const container = new Container();
		const mdTheme = getPiMdTheme();
		const st = this.state.status;
		const statusColor = st === "error" ? "error" : st === "running" ? "warning" : "success";

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(
			`${theme.fg("accent", theme.bold(" ZOOM"))} ${theme.fg("dim", "|")} ${theme.bold(displayName(this.state.def.name))} ${theme.fg("dim", "|")} ${theme.fg(statusColor, st)} ${theme.fg("dim", "|")} ${theme.fg("success", String(items.length))} events`,
			1, 0,
		));
		container.addChild(new Spacer(1));

		if (items.length === 0) {
			container.addChild(new Text(theme.fg("dim", "  No activity captured yet."), 1, 0));
		}

		const visibleItems = items.slice(this.scrollOffset);
		visibleItems.forEach((item, idx) => {
			const absoluteIndex = idx + this.scrollOffset;
			const isSelected = absoluteIndex === this.selectedIndex;
			const isExpanded = isSelected && absoluteIndex === this.expandedIndex;

			const cardBox = new Box(1, 0, (s: string) => isSelected ? theme.bg("selectedBg", s) : s);

			let icon = "○", color = "dim";
			if (item.kind === "text") { icon = "🤖"; color = "accent"; }
			else if (item.kind === "tool") { icon = "🛠️"; color = "warning"; }
			else if (item.kind === "thinking") { icon = "💭"; color = "dim"; }

			cardBox.addChild(new Text(`${theme.fg(color, icon)} ${theme.bold(item.title)}`, 0, 0));

			if (isExpanded) {
				cardBox.addChild(new Spacer(1));
				cardBox.addChild(new Markdown(item.content || "(empty)", 2, 0, mdTheme));
			} else {
				const flat = (item.content || "").replace(/\s+/g, " ").trim();
				const preview = truncateToWidth(flat, Math.max(0, width - 8));
				cardBox.addChild(new Text(theme.fg("dim", "  " + (preview || "…")), 0, 0));
			}

			container.addChild(cardBox);
			if (visibleItems.length < 15) container.addChild(new Spacer(1));
		});

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", " ↑/↓ Navigate • Enter Collapse/Expand • Space/Ctrl+C Copy • Esc Close • live"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return container.render(width);
	}
}

function scanAgentDirs(cwd: string): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
	];

	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch {}
	}

	return agents;
}

// Resolve the damage-control harness so spawned subagents inherit the same guardrail.
// Order: (1) the exact `-e` path this session was launched with (mirrors `just hub`,
// robust to symlinks / consuming projects), (2) the repo-local harness under cwd.
// Returns an absolute path, or null if damage-control isn't present — in which case
// subagents spawn unguarded, exactly as before.
function resolveDamageControlExtension(cwd: string): string | null {
	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") {
			const abs = resolve(argv[i + 1]);
			if (/damage-control[/\\]index\.ts$/.test(abs) && existsSync(abs)) return abs;
		}
	}
	const local = join(cwd, ".pi", "harnesses", "damage-control", "index.ts");
	return existsSync(local) ? local : null;
}

// ━━ Embedded coms: Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMS_DIR = process.env.PI_COMS_DIR || path.join(os.homedir(), ".pi", "coms");
const MAX_HOPS = Number(process.env.PI_COMS_MAX_HOPS) || 5;
const TIMEOUT_MS = Number(process.env.PI_COMS_TIMEOUT_MS) || 1_800_000;
const PING_INTERVAL_MS = Number(process.env.PI_COMS_PING_INTERVAL_MS) || 10_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const LINE_CAP_BYTES = 64 * 1024;

const FALLBACK_PALETTE = [
	"#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
	"#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

// ━━ Embedded coms: Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type EnvelopeType = "prompt" | "response" | "ping";

interface Envelope {
	type: EnvelopeType;
	msg_id: string;
	sender_session: string;
	sender_endpoint: string;
	hops: number;
	timestamp: string;
}

interface PromptEnvelope extends Envelope {
	type: "prompt";
	prompt: string;
	sender_name: string;
	sender_cwd: string;
	conversation_id?: string | null;
	response_schema?: object | null;
}

interface ResponseEnvelope extends Envelope {
	type: "response";
	response: any;
	error?: string | null;
}

interface PingEnvelope extends Envelope {
	type: "ping";
}

interface AgentCard {
	name: string;
	purpose: string;
	model: string;
	color: string;
	context_used_pct: number;
	queue_depth: number;
}

interface Pong {
	type: "pong";
	msg_id: string;
	agent_card: AgentCard;
}

interface RegistryEntry {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	pid: number;
	endpoint: string;
	cwd: string;
	started_at: string;
	explicit: boolean;
	version: number;
	// Live status snapshot — refreshed every KEEPALIVE_INTERVAL_MS by the heartbeat.
	// Optional so older entries (pre-heartbeat-refresh) still parse cleanly.
	context_used_pct?: number;
	queue_depth?: number;
	heartbeat_at?: string;
}

interface PendingReply {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout | null;
	promise: Promise<{ response?: any; error?: string | null }>;
	result?: { response?: any; error?: string | null };
	target_name?: string;
	created_at: string;
}

interface InboundContext {
	msg_id: string;
	hops: number;
	sender_endpoint: string;
	sender_session: string;
	response_schema?: object | null;
	fulfilled: boolean;
}

// ━━ Embedded coms: Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

function hexFg(hex: string, s: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function fallbackColor(sessionId: string): string {
	const h = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
	return FALLBACK_PALETTE[Number(BigInt("0x" + h)) % FALLBACK_PALETTE.length];
}

function parseComsFrontmatter(raw: string): { name?: string; description?: string; color?: string; body: string } {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			// strip surrounding quotes for values like color: "#36F9F6"
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			frontmatter[key] = val;
		}
	}
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		color: frontmatter.color,
		body: match[2],
	};
}

function makeEndpoint(sessionId: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-coms-${sessionId}`;
	}
	return path.join(COMS_DIR, "sockets", `${sessionId}.sock`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function abbreviateModel(model: string): string {
	let m = model || "";
	if (m.startsWith("claude-")) m = m.slice("claude-".length);
	if (m.length > 14) m = m.slice(0, 14);
	return m;
}

// ━━ Embedded coms: CLI flag shape (read via pi.registerFlag/pi.getFlag) ━━

interface CliFlags {
	name?: string;
	purpose?: string;
	project?: string;
	color?: string;
	explicit?: boolean;
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
	// Identity flags are declared via pi.registerFlag at extension load time so
	// pi's CLI parser accepts them; here we just read them back.
	const name = pi.getFlag("name") as string | undefined;
	const purpose = pi.getFlag("purpose") as string | undefined;
	const project = pi.getFlag("project") as string | undefined;
	const color = pi.getFlag("color") as string | undefined;
	const explicit = pi.getFlag("explicit") as boolean | undefined;
	return {
		name: name && name.length > 0 ? name : undefined,
		purpose: purpose && purpose.length > 0 ? purpose : undefined,
		project: project && project.length > 0 ? project : undefined,
		color: color && color.length > 0 ? color : undefined,
		explicit: explicit === true,
	};
}

// ━━ Embedded coms: Registry I/O ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function projectAgentsDir(project: string): string {
	return path.join(COMS_DIR, "projects", project, "agents");
}

function registryFilePath(project: string, name: string): string {
	return path.join(projectAgentsDir(project), `${name}.json`);
}

function writeRegistryAtomic(entry: RegistryEntry, project: string): string {
	const dir = projectAgentsDir(project);
	fs.mkdirSync(dir, { recursive: true });
	const final = registryFilePath(project, entry.name);
	const tmp = `${final}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
	fs.renameSync(tmp, final);
	return final;
}

function readAllRegistryEntries(project: string): RegistryEntry[] {
	const dir = projectAgentsDir(project);
	if (!fs.existsSync(dir)) return [];
	const out: RegistryEntry[] = [];
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const raw = fs.readFileSync(path.join(dir, f), "utf-8");
			const parsed = JSON.parse(raw) as RegistryEntry;
			if (parsed && typeof parsed.session_id === "string") {
				out.push(parsed);
			}
		} catch {
			// skip malformed
		}
	}
	return out;
}

function readAllRegistryEntriesAcrossProjects(): RegistryEntry[] {
	const root = path.join(COMS_DIR, "projects");
	let projects: string[];
	try {
		projects = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const p of projects) {
		try {
			if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push(...readAllRegistryEntries(p));
	}
	return out;
}

function removeRegistryEntry(project: string, name: string): void {
	try {
		fs.unlinkSync(registryFilePath(project, name));
	} catch {
		// best-effort
	}
}

function pruneDeadEntries(project: string): RegistryEntry[] {
	const entries = readAllRegistryEntries(project);
	const live: RegistryEntry[] = [];
	for (const entry of entries) {
		try {
			process.kill(entry.pid, 0);
			live.push(entry);
		} catch (e: any) {
			if (e && e.code === "ESRCH") {
				removeRegistryEntry(project, entry.name);
			} else {
				// EPERM means the process exists but we can't signal it — treat as live.
				live.push(entry);
			}
		}
	}
	return live;
}

function resolveUniqueName(project: string, desiredName: string): string {
	// Returns a name that doesn't collide with any LIVE registered agent.
	// pruneDeadEntries auto-removes ESRCH entries; we only care about live ones.
	const liveEntries = pruneDeadEntries(project);
	const liveNames = new Set(liveEntries.map(e => e.name));
	if (!liveNames.has(desiredName)) return desiredName;
	let n = 2;
	while (liveNames.has(`${desiredName}${n}`)) n++;
	return `${desiredName}${n}`;
}

function pruneDeadEntriesAllProjects(): RegistryEntry[] {
	const root = path.join(COMS_DIR, "projects");
	let projects: string[];
	try {
		projects = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const p of projects) {
		try {
			if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push(...pruneDeadEntries(p));
	}
	return out;
}

// ━━ Embedded coms: Transport ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (verdict: "in_use" | "stale") => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* ignore */ }
			resolve(verdict);
		};
		const timer = setTimeout(() => finish("stale"), 250);
		sock.once("connect", () => {
			clearTimeout(timer);
			finish("in_use");
		});
		sock.once("error", (err: any) => {
			clearTimeout(timer);
			if (err && err.code === "ECONNREFUSED") {
				finish("stale");
			} else {
				// ENOENT or other — treat as stale (file may be gone or unusable)
				finish("stale");
			}
		});
	});
}

async function bindEndpoint(
	endpoint: string,
	connHandler: (socket: net.Socket) => void,
): Promise<net.Server> {
	if (process.platform !== "win32" && fs.existsSync(endpoint)) {
		const verdict = await probeStaleSocket(endpoint);
		if (verdict === "in_use") {
			throw new Error(`coms: endpoint already in use (${endpoint})`);
		}
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// best-effort
		}
	}
	return await new Promise<net.Server>((resolve, reject) => {
		const server = net.createServer(connHandler);
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}

function readOneLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;
		const onData = (chunk: Buffer) => {
			buf += chunk.toString("utf-8");
			if (buf.length > LINE_CAP_BYTES) {
				if (settled) return;
				settled = true;
				socket.removeListener("data", onData);
				reject(new Error("line too large"));
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				if (settled) return;
				settled = true;
				socket.removeListener("data", onData);
				resolve(buf.slice(0, nl));
			}
		};
		socket.on("data", onData);
		socket.once("error", (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		});
		socket.once("close", () => {
			if (settled) return;
			settled = true;
			reject(new Error("connection closed before line received"));
		});
	});
}

function sendEnvelope(endpoint: string, envelope: Envelope | Pong | { type: string; msg_id?: string; [k: string]: any }): Promise<any> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			try { sock.destroy(); } catch { /* ignore */ }
			reject(err);
		};
		sock.once("error", fail);
		sock.once("connect", async () => {
			try {
				sock.write(JSON.stringify(envelope) + "\n");
				const line = await readOneLine(sock);
				const parsed = JSON.parse(line);
				try { sock.end(); } catch { /* ignore */ }
				if (settled) return;
				settled = true;
				if (parsed && parsed.type === "nack") {
					reject(new Error(parsed.error || "nack"));
				} else {
					resolve(parsed);
				}
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

// ━━ Embedded coms: System-prompt frontmatter scan ━━━━━━━━━━━━━━━━━━━━━━━━

function findSystemPromptPath(argv: string[]): string | null {
	// Prefer --system-prompt (overwrite). Fall back to --append-system-prompt.
	// These flags are pi-builtin (not extension-registered) so we still scan
	// argv directly. First match wins per preference order.
	const scan = (flag: string): string | null => {
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === flag && i + 1 < argv.length) {
				const candidate = argv[i + 1];
				if (candidate.endsWith(".md")) {
					try {
						if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
							return candidate;
						}
					} catch {
						// fall through
					}
				}
			}
		}
		return null;
	};
	return scan("--system-prompt") ?? scan("--append-system-prompt");
}

function readFrontmatterFromArgv(argv: string[]): { name?: string; description?: string; color?: string } {
	const p = findSystemPromptPath(argv);
	if (!p) return {};
	try {
		const raw = fs.readFileSync(p, "utf-8");
		const { name, description, color } = parseComsFrontmatter(raw);
		return { name, description, color };
	} catch {
		return {};
	}
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Embedded coms: identity CLI flags ──
	// Registered here (factory load time) so pi's CLI parser accepts them. Because
	// coms is EMBEDDED (one extension, not a second `-e`), these register exactly once.
	pi.registerFlag("name", { description: "Coms: override agent name (else frontmatter or auto-generated)", type: "string", default: undefined });
	pi.registerFlag("purpose", { description: "Coms: override agent purpose (else frontmatter description)", type: "string", default: undefined });
	pi.registerFlag("project", { description: "Coms: project namespace for peer discovery", type: "string", default: "default" });
	pi.registerFlag("color", { description: "Coms: hex color #RRGGBB (else frontmatter or palette fallback)", type: "string", default: undefined });
	pi.registerFlag("explicit", { description: "Coms: hide from auto-discovery; addressable only by exact name", type: "boolean", default: false });
	pi.registerFlag("solo", { description: "Run without the coms layer (fixed specialists + research only — `just hub-solo`)", type: "boolean", default: false });

	// ── Embedded coms: peer state ──
	let identity: {
		session_id: string;
		name: string;
		purpose: string;
		color: string;
		project: string;
		explicit: boolean;
		cwd: string;
		model: string;
		endpoint: string;
		registryFile: string;
	} | null = null;
	const peerCards: Map<string, AgentCard & { staleCount: number }> = new Map();
	const pendingReplies: Map<string, PendingReply> = new Map();
	const inboundQueue: Map<string, InboundContext> = new Map();
	let server: net.Server | null = null;
	let pingTimer: NodeJS.Timeout | null = null;
	let keepaliveTimer: NodeJS.Timeout | null = null;
	let includeExplicit = false;
	let displayProject: string | null = null;
	let currentCtx: ExtensionContext | null = null;
	let currentInbound: InboundContext | null = null;
	// comsReady gates the coms_* tools + the peer section of the dispatcher prompt.
	// If the endpoint bind or registry write fails, the harness degrades to a
	// coms-less dispatcher rather than aborting.
	let comsReady = false;
	// Purpose shown to peers. An explicit --purpose CLI flag pins it; otherwise the
	// active dispatcher persona's description drives it (syncComsPurpose), falling
	// back to comsBasePurpose when no persona is selected.
	let comsBasePurpose = "agent-hub dispatcher";
	let comsPurposeExplicit = false;

	const agentStates: Map<string, AgentState> = new Map();
	// Read-only research helpers (Phase 4), keyed by numeric id (handle `rN`). Lives
	// alongside the standing team but renders in its own widget row.
	const researchStates: Map<number, ResearchState> = new Map();
	let nextResearchId = 1;
	let researchPersonas: AgentDef[] = [];
	let allAgentDefs: AgentDef[] = [];
	let teams: Record<string, string[]> = {};
	let activeTeamName = "";
	let gridCols = 2;
	// View mode toggled by Alt+A: "dashboard" = full bordered card grid above the
	// editor; "compact" = one line per *running* agent (name · context · state)
	// rendered BELOW the editor, just above the footer. Idle/done agents are hidden
	// in compact mode, so an idle session shows nothing but the prompt + footer.
	let viewMode: "dashboard" | "compact" = "dashboard";
	let runningWidgetInstalled = false;
	let widgetCtx: any;
	let sessionDir = "";
	let contextWindow = 0;
	let userLanguage: string = DEFAULT_OVERRIDES.language;
	// Resolved once at session_start: the damage-control harness to load into every
	// spawned subagent (specialist + research helper) so guardrails follow them.
	let damageControlExtPath: string | null = null;

	// ── Dispatcher persona gate (Phase 6) ──
	// Every agent runs a declared persona; the dispatcher's is sourced from an
	// orchestrator persona file (frontmatter `kind: orchestrator`). The gate blocks
	// input until one is picked. It is FLAVOR-ONLY: the chosen persona's body is
	// merged INTO the orchestrator prompt and NEVER narrows the tool surface
	// (dispatch_agent/ask_user are always preserved — decision G4).
	let orchestratorPersonas: AgentDef[] = [];
	let dispatcherPersona: AgentDef | null = null;
	let personaGateEnabled = false;
	let personaGateSatisfied = true;

	function loadAgents(cwd: string) {
		// Create session storage dir
		sessionDir = join(cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		// Findings from auto-research rounds are as ephemeral as the agent sessions
		// that consumed them — wipe at session start.
		try { rmSync(join(sessionDir, "findings"), { recursive: true, force: true }); } catch {}

		// Load all agent definitions
		allAgentDefs = scanAgentDirs(cwd);

		// Load teams from .pi/agents/teams.yaml
		const teamsPath = join(cwd, ".pi", "agents", "teams.yaml");
		if (existsSync(teamsPath)) {
			try {
				teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
			} catch {
				teams = {};
			}
		} else {
			teams = {};
		}

		// If no teams defined, create a default "all" team
		if (Object.keys(teams).length === 0) {
			teams = { all: allAgentDefs.map(d => d.name) };
		}
	}

	function activateTeam(teamName: string) {
		activeTeamName = teamName;
		const members = teams[teamName] || [];
		const defsByName = new Map(allAgentDefs.map(d => [d.name.toLowerCase(), d]));

		agentStates.clear();
		for (const member of members) {
			const def = defsByName.get(member.toLowerCase());
			if (!def) continue;
			const key = def.name.toLowerCase().replace(/\s+/g, "-");
			const sessionFile = join(sessionDir, `${key}.json`);
			agentStates.set(def.name.toLowerCase(), {
				def,
				status: "idle",
				task: "",
				toolCount: 0,
				elapsed: 0,
				lastWork: "",
				contextPct: 0,
				sessionFile: existsSync(sessionFile) ? sessionFile : null,
				runCount: 0,
				timeline: [],
			});
		}

		// Auto-size grid columns based on team size
		const size = agentStates.size;
		gridCols = size <= 3 ? size : size === 4 ? 2 : 3;
	}

	// ── Grid Rendering ───────────────────────────

	const CARD_HEIGHT = 4;

	function truncateCardText(text: string, maxWidth: number): string {
		const width = Math.max(0, maxWidth);
		if (width === 0) return "";
		if (visibleWidth(text) <= width) return text;
		if (width <= 3) return ".".repeat(width);
		return `${truncateToWidth(text, width - 3)}...`;
	}

	function shortModel(model: string | undefined): string {
		return model ? model.split("/").pop()! : "default";
	}

	function contextLabel(contextPct: number): string {
		return `${Math.ceil(contextPct)}%`;
	}

	function cardStatus(status: "idle" | "running" | "done" | "error", elapsed: number): { color: string; text: string } {
		const color = status === "idle" ? "dim"
			: status === "running" ? "accent"
			: status === "done" ? "success" : "error";
		const icon = status === "idle" ? "○"
			: status === "running" ? "●"
			: status === "done" ? "✓" : "✗";
		const time = status !== "idle" ? ` ${Math.round(elapsed / 1000)}s` : "";
		return { color, text: `${icon} ${status}${time}` };
	}

	function renderCardHeaderLine(
		nameRaw: string,
		contextPct: number,
		modelRaw: string,
		statusRaw: string,
		statusColor: string,
		w: number,
		theme: any,
	): string {
		const indent = w > 0 ? " " : "";
		const contentWidth = Math.max(0, w - visibleWidth(indent));
		if (contentWidth === 0) return "";

		const rightRaw = `${modelRaw} ${statusRaw}`;
		const rightWidth = visibleWidth(rightRaw);
		const renderRight = () => theme.fg("dim", `${modelRaw} `) + theme.fg(statusColor, statusRaw);

		if (rightWidth === contentWidth) return indent + renderRight();
		if (rightWidth > contentWidth) return indent + theme.fg("dim", truncateCardText(rightRaw, contentWidth));

		const leftBudget = Math.max(0, contentWidth - rightWidth - 1);
		const ctxRaw = contextLabel(contextPct);
		const ctxWidth = visibleWidth(ctxRaw);
		let leftVisible = 0;
		let leftStyled = "";

		if (leftBudget >= ctxWidth) {
			const nameBudget = Math.max(0, leftBudget - ctxWidth - 1);
			const nameText = truncateCardText(nameRaw, nameBudget);
			if (nameText) {
				leftStyled = theme.fg("accent", theme.bold(nameText)) + theme.fg("dim", ` ${ctxRaw}`);
				leftVisible = visibleWidth(`${nameText} ${ctxRaw}`);
			} else {
				leftStyled = theme.fg("dim", ctxRaw);
				leftVisible = ctxWidth;
			}
		} else {
			const ctxText = truncateCardText(ctxRaw, leftBudget);
			leftStyled = theme.fg("dim", ctxText);
			leftVisible = visibleWidth(ctxText);
		}

		const gap = " ".repeat(Math.max(1, contentWidth - leftVisible - rightWidth));
		return indent + leftStyled + gap + renderRight();
	}

	function renderWorkLine(workRaw: string, w: number, theme: any): string {
		const indent = w > 0 ? " " : "";
		const maxWorkWidth = Math.max(0, Math.min(50, w - visibleWidth(indent)));
		return indent + theme.fg("muted", truncateCardText(workRaw, maxWorkWidth));
	}

	function renderBorderedLine(content: string, w: number, theme: any): string {
		return theme.fg("dim", "│")
			+ content
			+ " ".repeat(Math.max(0, w - visibleWidth(content)))
			+ theme.fg("dim", "│");
	}

	// One-line agent summary for compact view: " Name   42%  ● running 12s".
	// nameWidth aligns the name column across the running set; the styled line is
	// truncated to the widget width so ANSI runs never overflow.
	function renderCompactLine(
		nameRaw: string,
		contextPct: number,
		status: { color: string; text: string },
		nameWidth: number,
		width: number,
		theme: any,
	): string {
		const vis = visibleWidth(nameRaw);
		const name = vis >= nameWidth ? nameRaw : nameRaw + " ".repeat(nameWidth - vis);
		const ctx = contextLabel(contextPct).padStart(4);
		const line = " "
			+ theme.fg("accent", theme.bold(name))
			+ "  " + theme.fg("dim", ctx)
			+ "  " + theme.fg(status.color, status.text);
		return truncateToWidth(line, width);
	}

	function renderCard(state: AgentState, colWidth: number, theme: any): string[] {
		const w = Math.max(0, colWidth - 2);
		const status = cardStatus(state.status, state.elapsed);
		const headerLine = renderCardHeaderLine(
			displayName(state.def.name),
			state.contextPct,
			shortModel(state.def.model),
			status.text,
			status.color,
			w,
			theme,
		);
		const workRaw = state.task
			? (state.lastWork || state.task)
			: state.def.description;

		return [
			theme.fg("dim", "┌" + "─".repeat(Math.max(0, w)) + "┐"),
			renderBorderedLine(headerLine, w, theme),
			renderBorderedLine(renderWorkLine(workRaw, w, theme), w, theme),
			theme.fg("dim", "└" + "─".repeat(Math.max(0, w)) + "┘"),
		];
	}

	// A research-helper card. Mirrors renderCard's compact two-line layout while
	// keeping the `rN` handle + persona/anon label + turn in the name slot.
	function renderResearchCard(state: ResearchState, colWidth: number, theme: any): string[] {
		const w = Math.max(0, colWidth - 2);
		const status = cardStatus(state.status, state.elapsed);
		const label = state.persona ? displayName(state.def.name) : "research";
		const turnStr = state.turnCount > 1 ? ` ·T${state.turnCount}` : "";
		const headerLine = renderCardHeaderLine(
			`r${state.id} ${label}${turnStr}`,
			state.contextPct,
			shortModel(state.model),
			status.text,
			status.color,
			w,
			theme,
		);
		const workRaw = state.lastWork || state.task || state.def.description;

		return [
			theme.fg("dim", "┌" + "─".repeat(Math.max(0, w)) + "┐"),
			renderBorderedLine(headerLine, w, theme),
			renderBorderedLine(renderWorkLine(workRaw, w, theme), w, theme),
			theme.fg("dim", "└" + "─".repeat(Math.max(0, w)) + "┘"),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;
		installRunningWidget();

		widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					// Compact mode hides the dashboard grid; running agents are shown
					// in the belowEditor "agent-running" widget instead.
					if (viewMode === "compact") return [];

					if (agentStates.size === 0) {
						text.setText(theme.fg("dim", "No agents found. Add .md files to agents/"));
						return text.render(width);
					}

					const cols = Math.min(gridCols, agentStates.size);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
					const agents = Array.from(agentStates.values());
					const rows: string[][] = [];

					for (let i = 0; i < agents.length; i += cols) {
						const rowAgents = agents.slice(i, i + cols);
						const cards = rowAgents.map(a => renderCard(a, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(CARD_HEIGHT).fill(" ".repeat(Math.max(0, colWidth))));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							rows.push(cards.map(card => card[line] || ""));
						}
					}

					const output = rows.map(cols => cols.join(" ".repeat(gap)));
					text.setText(output.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// Research helpers render in their own widget row, labelled "research", below the
	// team grid. The widget is removed entirely when no helpers exist so it takes no
	// space on a fresh session.
	function updateResearchWidget() {
		if (!widgetCtx) return;
		if (researchStates.size === 0) {
			widgetCtx.ui.setWidget("agent-research", undefined);
			return;
		}
		widgetCtx.ui.setWidget("agent-research", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					const states = Array.from(researchStates.values());
					if (states.length === 0) {
						text.setText("");
						return text.render(width);
					}

					// Compact mode hides the research grid; running helpers are folded
					// into the belowEditor "agent-running" widget instead.
					if (viewMode === "compact") return [];

					const cols = Math.min(gridCols, states.length);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
					const labelText = "── research ";
					const header = theme.fg("dim", labelText + "─".repeat(Math.max(0, width - labelText.length)));
					const rows: string[][] = [];

					for (let i = 0; i < states.length; i += cols) {
						const rowStates = states.slice(i, i + cols);
						const cards = rowStates.map(s => renderResearchCard(s, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(CARD_HEIGHT).fill(" ".repeat(Math.max(0, colWidth))));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							rows.push(cards.map(card => card[line] || ""));
						}
					}

					const grid = rows.map(cs => cs.join(" ".repeat(gap)));
					text.setText([header, ...grid].join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// The compact running-agents widget, rendered BELOW the editor (between the
	// input box and the footer). Registered once; it re-renders on every frame
	// driven by the existing updateWidget/updateResearchWidget refreshes, reading
	// live state + viewMode each time. In dashboard mode it renders nothing. In
	// compact mode it lists only *running* team specialists and research helpers,
	// one line each — idle/done agents are omitted.
	function installRunningWidget() {
		if (!widgetCtx || runningWidgetInstalled) return;
		runningWidgetInstalled = true;
		widgetCtx.ui.setWidget("agent-running", (_tui: any, theme: any) => ({
			invalidate() {},
			render(width: number): string[] {
				if (viewMode !== "compact") return [];
				const running: { name: string; ctx: number; status: { color: string; text: string } }[] = [
					...Array.from(agentStates.values())
						.filter(a => a.status === "running")
						.map(a => ({
							name: displayName(a.def.name),
							ctx: a.contextPct,
							status: cardStatus(a.status, a.elapsed),
						})),
					...Array.from(researchStates.values())
						.filter(s => s.status === "running")
						.map(s => ({
							name: `r${s.id} ${s.persona ? displayName(s.def.name) : "research"}`,
							ctx: s.contextPct,
							status: cardStatus(s.status, s.elapsed),
						})),
				];
				if (running.length === 0) return [];
				const nameWidth = Math.min(24, Math.max(...running.map(r => visibleWidth(r.name))));
				return running.map(r => renderCompactLine(r.name, r.ctx, r.status, nameWidth, width, theme));
			},
		}), { placement: "belowEditor" });
	}

	// ── Dispatch Agent (returns Promise) ─────────

	function dispatchAgent(
		agentName: string,
		task: string,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = agentName.toLowerCase();
		const state = agentStates.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Agent "${agentName}" not found. Available: ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "running") {
			return Promise.resolve({
				output: `Agent "${displayName(state.def.name)}" is already running. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		state.status = "running";
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.runCount++;
		state.killedByOperator = false;
		state.restarting = false;
		state.timeline = [];
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		// Per-agent model: a persona can declare `model:` in frontmatter (a full
		// pi spec, e.g. anthropic/claude-opus-4-7) to run on a stronger/cheaper
		// model than the dispatcher. Falls back to the dispatcher's model.
		const model = state.def.model
			? state.def.model
			: ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "openrouter/google/gemini-3-flash-preview";

		// Session file for this agent
		const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);

		// Clarification protocol — every specialist learns to bubble up questions
		// to the dispatcher instead of guessing.
		const clarificationProtocol = `

## Clarification protocol
If at any point you need a decision from the human user (ambiguity, missing input,
contradiction, or a destructive/irreversible next step), DO NOT guess. Stop and
return a single line of the form:

  ASK_USER: <your question in one clear English sentence>

You may emit multiple ASK_USER lines if you have several questions. The dispatcher
will surface each to the human user in ${userLanguage} and re-dispatch you with the
answers. Do not invent values, do not pick "reasonable defaults" silently — ask.

## Research protocol
If you need reconnaissance you cannot perform with your own tools (broad code search,
reading unfamiliar areas of the codebase, summarizing docs), DO NOT guess and DO NOT
ask the user. Pause for research instead: end your turn with one or more lines of the
form

  NEEDS_RESEARCH: <one specific, self-contained question>

with nothing after them. Your session pauses there; read-only research helpers are
spawned for you, each helper's findings are saved to a file, and you are resumed in
this same session with the file paths — read them and continue from where you left
off. Ask at most ${MAX_AUTO_RESEARCH_QUESTIONS} questions per pause. Use ASK_USER only
for decisions a human must make; use NEEDS_RESEARCH for facts that can be looked up.`;

		const appendedSystemPrompt = state.def.systemPrompt + clarificationProtocol;

		// Per-agent thinking: a persona can set `thinking:` in frontmatter to capture
		// its reasoning into the zoom timeline (default off). Non-off enables thinking
		// deltas in the JSON stream so `/zoom` can show them.
		const thinkingLevel = resolveThinkingLevel(state.def.thinking);
		const wantThinking = thinkingLevel !== "off";

		// Build args — first run creates session, subsequent runs resume
		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			...(damageControlExtPath ? ["-e", damageControlExtPath] : []),
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", thinkingLevel,
			"--append-system-prompt", appendedSystemPrompt,
			"--session", agentSessionFile,
		];

		// Continue existing session if we have one
		if (state.sessionFile) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];
		const stderrChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});
			state.proc = proc;

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								const full = textChunks.join("");
								const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								state.lastWork = last;
								appendTimelineText(state.timeline, "text", delta.delta || "");
								updateWidget();
								state.zoomRender?.();
							} else if (delta?.type === "thinking_delta" && wantThinking) {
								appendTimelineText(state.timeline, "thinking", delta.delta || "");
								state.zoomRender?.();
							}
						} else if (event.type === "tool_execution_start") {
							state.toolCount++;
							let argStr = "";
							try { argStr = event.args != null ? JSON.stringify(event.args) : ""; } catch { argStr = ""; }
							state.timeline.push({
								kind: "tool",
								title: `Tool: ${event.toolName || "tool"}`,
								content: argStr,
								timestamp: Date.now(),
							});
							updateWidget();
							state.zoomRender?.();
						} else if (event.type === "message_end") {
							const msg = event.message;
							if (msg?.usage && contextWindow > 0) {
								state.contextPct = ((msg.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
						} else if (event.type === "agent_end") {
							const msgs = event.messages || [];
							const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
							if (last?.usage && contextWindow > 0) {
								state.contextPct = ((last.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				stderrChunks.push(chunk);
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								appendTimelineText(state.timeline, "text", delta.delta || "");
							} else if (delta?.type === "thinking_delta" && wantThinking) {
								appendTimelineText(state.timeline, "thinking", delta.delta || "");
							}
						}
					} catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.proc = undefined;

				const full = textChunks.join("");

				// Operator kill (Phase 2). The exit was a SIGTERM from /agents-kill or
				// /agents-restart, not a real completion: free the card (status → idle),
				// fire any restart waiter, and return a message that tells the dispatcher
				// LLM not to auto-retry. /agents-restart handles the fresh re-dispatch.
				if (state.killedByOperator) {
					const wasRestart = state.restarting === true;
					state.killedByOperator = false;
					state.restarting = false;
					state.status = "idle";
					state.lastWork = wasRestart ? "(killed for restart)" : "(killed by operator)";
					updateWidget();
					state.zoomRender?.(true);
					ctx.ui.notify(`${displayName(state.def.name)} killed by operator`, "info");
					const onTerminate = state.onTerminate;
					state.onTerminate = undefined;
					onTerminate?.();
					resolve({
						output: wasRestart
							? `Agent "${displayName(state.def.name)}" was killed by the operator for a restart. A fresh run is starting now; WAIT for the follow-up result before acting — do not re-dispatch this agent yourself.`
							: `Agent "${displayName(state.def.name)}" was killed by the operator. Do NOT auto-retry or re-dispatch; wait for the operator's instruction.`,
						exitCode: code ?? 143,
						elapsed: state.elapsed,
					});
					return;
				}

				state.status = code === 0 ? "done" : "error";

				// Mark session file as available for resume
				if (code === 0) {
					state.sessionFile = agentSessionFile;
				}

				state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();
				state.zoomRender?.(true);

				ctx.ui.notify(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error"
				);

				// Let a restart waiter proceed even when the agent finished naturally
				// between the operator's /agents-restart and the kill landing.
				const onTerminate = state.onTerminate;
				state.onTerminate = undefined;
				onTerminate?.();

				// On a non-zero exit, surface stderr so failures with no JSON output
				// (e.g. a bad --model spec or a provider whose API key isn't configured)
				// reach the dispatcher as a readable message instead of an empty result.
				let output = full;
				if (code !== 0) {
					const errText = stderrChunks.join("").trim();
					const tail = errText.length > 1500 ? "...\n" + errText.slice(-1500) : errText;
					const errBlock = tail ? `\n\n[stderr]\n${tail}` : "";
					output = full
						? `${full}${errBlock}`
						: `Agent "${displayName(state.def.name)}" exited with code ${code} and produced no output.${errBlock}`;
				}

				resolve({
					output,
					exitCode: code ?? 1,
					elapsed: state.elapsed,
				});
			});

			proc.on("error", (err) => {
				clearInterval(state.timer);
				state.proc = undefined;
				state.status = "error";
				state.lastWork = `Error: ${err.message}`;
				state.killedByOperator = false;
				state.restarting = false;
				updateWidget();
				state.zoomRender?.(true);
				const onTerminate = state.onTerminate;
				state.onTerminate = undefined;
				onTerminate?.();
				resolve({
					output: `Error spawning agent: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// ── Research helpers (Phase 4) ───────────────

	function researchSessionPath(id: number): string {
		return join(sessionDir, `research-${id}.json`);
	}

	// A synthesized def for an anonymous (no-persona) research helper.
	function anonResearchDef(): AgentDef {
		return {
			name: "research",
			description: "Ad-hoc read-only research helper.",
			tools: RESEARCH_TOOLS,
			systemPrompt: ANON_RESEARCH_PROMPT,
			file: "",
		};
	}

	// Resolve the model for a research helper: an explicit --model wins, then the
	// persona's own model, then the dispatcher's model (the default for anon helpers).
	function resolveResearchModel(def: AgentDef, explicit: string | undefined, ctx: any): string {
		if (explicit) return explicit;
		if (def.model) return def.model;
		return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview";
	}

	function createResearchState(def: AgentDef, persona: boolean, model: string): ResearchState {
		const id = nextResearchId++;
		const state: ResearchState = {
			id,
			def,
			persona,
			model,
			status: "running",
			task: "",
			toolCount: 0,
			elapsed: 0,
			lastWork: "",
			contextPct: 0,
			sessionFile: null,
			turnCount: 1,
			timeline: [],
		};
		researchStates.set(id, state);
		return state;
	}

	// Spawn (or resume) a read-only research helper. Mirrors dispatchAgent's stream
	// handling but is forced read-only (RESEARCH_TOOLS), drives the research widget, and
	// resolves with the findings — the CALLER decides what to do with them (the
	// spawn_research tool returns them inline; the /research command delivers a follow-up).
	function spawnResearch(
		state: ResearchState,
		prompt: string,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		state.status = "running";
		state.task = prompt;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.killedByOperator = false;
		state.timeline = [];
		updateResearchWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateResearchWidget();
		}, 1000);

		const thinkingLevel = resolveThinkingLevel(state.def.thinking);
		const wantThinking = thinkingLevel !== "off";
		const sessionPath = researchSessionPath(state.id);

		// READ-ONLY by construction: RESEARCH_TOOLS only, regardless of persona frontmatter.
		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			...(damageControlExtPath ? ["-e", damageControlExtPath] : []),
			"--model", state.model,
			"--tools", RESEARCH_TOOLS,
			"--thinking", thinkingLevel,
			"--append-system-prompt", state.def.systemPrompt + RESEARCH_PROTOCOL,
			"--session", sessionPath,
		];
		if (state.sessionFile) args.push("-c");
		args.push(prompt);

		const textChunks: string[] = [];
		const stderrChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});
			state.proc = proc;

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								const full = textChunks.join("");
								state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								appendTimelineText(state.timeline, "text", delta.delta || "");
								updateResearchWidget();
								state.zoomRender?.();
							} else if (delta?.type === "thinking_delta" && wantThinking) {
								appendTimelineText(state.timeline, "thinking", delta.delta || "");
								state.zoomRender?.();
							}
						} else if (event.type === "tool_execution_start") {
							state.toolCount++;
							let argStr = "";
							try { argStr = event.args != null ? JSON.stringify(event.args) : ""; } catch { argStr = ""; }
							state.timeline.push({
								kind: "tool",
								title: `Tool: ${event.toolName || "tool"}`,
								content: argStr,
								timestamp: Date.now(),
							});
							updateResearchWidget();
							state.zoomRender?.();
						} else if (event.type === "message_end") {
							const msg = event.message;
							if (msg?.usage && contextWindow > 0) {
								state.contextPct = ((msg.usage.input || 0) / contextWindow) * 100;
								updateResearchWidget();
							}
						} else if (event.type === "agent_end") {
							const msgs = event.messages || [];
							const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
							if (last?.usage && contextWindow > 0) {
								state.contextPct = ((last.usage.input || 0) / contextWindow) * 100;
								updateResearchWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				stderrChunks.push(chunk);
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								appendTimelineText(state.timeline, "text", delta.delta || "");
							} else if (delta?.type === "thinking_delta" && wantThinking) {
								appendTimelineText(state.timeline, "thinking", delta.delta || "");
							}
						}
					} catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.proc = undefined;

				const full = textChunks.join("");

				// Operator kill (via /research-rm or /research-clear). Resolve gracefully so
				// a spawn_research tool call awaiting this helper doesn't hang.
				if (state.killedByOperator) {
					state.killedByOperator = false;
					state.status = "idle";
					state.lastWork = "(killed by operator)";
					updateResearchWidget();
					state.zoomRender?.(true);
					resolve({
						output: `Research helper r${state.id} was killed by the operator before it finished.`,
						exitCode: code ?? 143,
						elapsed: state.elapsed,
					});
					return;
				}

				state.status = code === 0 ? "done" : "error";
				if (code === 0) state.sessionFile = sessionPath;
				state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateResearchWidget();
				state.zoomRender?.(true);

				ctx.ui.notify(
					`Research r${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error",
				);

				let output = full;
				if (code !== 0) {
					const errText = stderrChunks.join("").trim();
					const tail = errText.length > 1500 ? "...\n" + errText.slice(-1500) : errText;
					const errBlock = tail ? `\n\n[stderr]\n${tail}` : "";
					output = full
						? `${full}${errBlock}`
						: `Research helper r${state.id} exited with code ${code} and produced no output.${errBlock}`;
				}

				resolve({ output, exitCode: code ?? 1, elapsed: state.elapsed });
			});

			proc.on("error", (err) => {
				clearInterval(state.timer);
				state.proc = undefined;
				state.status = "error";
				state.lastWork = `Error: ${err.message}`;
				state.killedByOperator = false;
				updateResearchWidget();
				state.zoomRender?.(true);
				resolve({
					output: `Error spawning research helper: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// Deliver a /research result back to the dispatcher as a follow-up turn (the human
	// kicked it off via slash command, so there is no awaiting tool call to return to).
	function deliverResearchFollowUp(state: ResearchState, result: { output: string; exitCode: number; elapsed: number }) {
		const truncated = result.output.length > 8000
			? result.output.slice(0, 8000) + "\n\n... [truncated]"
			: result.output;
		const status = result.exitCode === 0 ? "finished" : "failed";
		const label = state.persona ? displayName(state.def.name) : "research";
		pi.sendMessage({
			customType: "research-result",
			content: `[research r${state.id} · ${label}${state.turnCount > 1 ? ` · Turn ${state.turnCount}` : ""}] ${status} in ${Math.round(result.elapsed / 1000)}s.\n\nFindings:\n${truncated}`,
			display: true,
		}, { deliverAs: "followUp", triggerTurn: true });
	}

	// ── Embedded coms: connection handlers ──

	function ackOk(socket: net.Socket, msg_id: string): void {
		try {
			socket.write(JSON.stringify({ type: "ack", msg_id }) + "\n");
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
	}

	function nack(socket: net.Socket, msg_id: string, error: string): void {
		try {
			socket.write(JSON.stringify({ type: "nack", msg_id, error }) + "\n");
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
	}

	function handlePrompt(socket: net.Socket, env: PromptEnvelope): void {
		// 1. Hop limit check
		if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
			nack(socket, env.msg_id, "hops exceeded");
			return;
		}

		// 2. Insert into inbound queue
		const inbound: InboundContext = {
			msg_id: env.msg_id,
			hops: env.hops,
			sender_endpoint: env.sender_endpoint,
			sender_session: env.sender_session,
			response_schema: env.response_schema ?? null,
			fulfilled: false,
		};
		inboundQueue.set(env.msg_id, inbound);

		// 3. Track the current inbound so that any coms_send issued during the
		//    resulting LLM turn inherits the right hop count.
		currentInbound = inbound;

		// 4. Inject as a follow-up message into the receiver's next turn.
		try {
			pi.sendMessage(
				{
					customType: "coms-inbound",
					content: `[from ${env.sender_name} @ ${env.sender_cwd}]\n\n${env.prompt}`,
					display: true,
					details: {
						msg_id: env.msg_id,
						sender_session: env.sender_session,
						response_schema: env.response_schema ?? null,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (err) {
			// If sendMessage fails, drop the inbound and nack.
			inboundQueue.delete(env.msg_id);
			currentInbound = null;
			nack(socket, env.msg_id, "internal error");
			return;
		}

		// 5. Ack + audit log
		ackOk(socket, env.msg_id);
		try {
			pi.appendEntry("coms-log", {
				event: "inbound_prompt",
				msg_id: env.msg_id,
				sender: env.sender_session,
				hops: env.hops,
			});
		} catch {
			// best-effort
		}
	}

	function handleResponse(socket: net.Socket, env: ResponseEnvelope): void {
		const pending = pendingReplies.get(env.msg_id);
		if (pending) {
			if (pending.timer) {
				try { clearTimeout(pending.timer); } catch { /* ignore */ }
				pending.timer = null;
			}
			pending.result = { response: env.response, error: env.error ?? null };
			try {
				pending.resolve(pending.result);
			} catch {
				// ignore
			}
			// Note: do NOT delete the entry here — coms_get poll may still want it.
		} else {
			try {
				pi.appendEntry("coms-log", { event: "orphan_response", msg_id: env.msg_id });
			} catch {
				// best-effort
			}
		}
		ackOk(socket, env.msg_id);
	}

	function handlePing(socket: net.Socket, env: PingEnvelope): void {
		const ctx = currentCtx;
		const ident = identity;
		const pct = ctx ? Math.round(ctx.getContextUsage()?.percent ?? 0) : 0;
		const card: AgentCard = {
			name: ident?.name ?? "unknown",
			purpose: ident?.purpose ?? "",
			model: ctx?.model?.id ?? ident?.model ?? "unknown",
			color: ident?.color ?? "#36F9F6",
			context_used_pct: pct,
			queue_depth: inboundQueue.size,
		};
		const pong: Pong = { type: "pong", msg_id: env.msg_id, agent_card: card };
		try {
			socket.write(JSON.stringify(pong) + "\n");
		} catch {
			// ignore
		}
		try { socket.end(); } catch { /* ignore */ }
	}

	function isValidEnvelope(obj: any): obj is Envelope {
		return (
			obj &&
			typeof obj === "object" &&
			typeof obj.type === "string" &&
			typeof obj.msg_id === "string" &&
			typeof obj.sender_session === "string" &&
			typeof obj.sender_endpoint === "string"
		);
	}

	function connHandler(socket: net.Socket): void {
		let buf = "";
		let handled = false;
		const onData = (chunk: Buffer) => {
			if (handled) return;
			buf += chunk.toString("utf-8");
			if (buf.length > LINE_CAP_BYTES) {
				handled = true;
				socket.removeListener("data", onData);
				nack(socket, "", "malformed envelope");
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			handled = true;
			socket.removeListener("data", onData);
			const line = buf.slice(0, nl);
			let parsed: any;
			try {
				parsed = JSON.parse(line);
			} catch {
				nack(socket, "", "malformed envelope");
				return;
			}
			if (!isValidEnvelope(parsed)) {
				const mid = parsed && typeof parsed.msg_id === "string" ? parsed.msg_id : "";
				nack(socket, mid, "malformed envelope");
				return;
			}
			try {
				if (parsed.type === "prompt") {
					handlePrompt(socket, parsed as PromptEnvelope);
				} else if (parsed.type === "response") {
					handleResponse(socket, parsed as ResponseEnvelope);
				} else if (parsed.type === "ping") {
					handlePing(socket, parsed as PingEnvelope);
				} else {
					nack(socket, parsed.msg_id, "unknown type");
				}
			} catch {
				nack(socket, parsed.msg_id, "internal error");
			}
		};
		socket.on("data", onData);
		socket.once("error", () => {
			// connection failures during handshake — drop quietly
			try { socket.destroy(); } catch { /* ignore */ }
		});
	}

	// ── Embedded coms: registry refresh + persona→purpose sync ──

	// Re-write this agent's registry entry with a fresh live-status snapshot. Shared
	// by the keepalive heartbeat and syncComsPurpose so peers see current values.
	function writeLiveRegistry(): void {
		if (!identity) return;
		try {
			const ctx = currentCtx;
			const live: RegistryEntry = {
				session_id: identity.session_id,
				name: identity.name,
				purpose: identity.purpose,
				model: ctx?.model?.id ?? identity.model,
				color: identity.color,
				pid: process.pid,
				endpoint: identity.endpoint,
				cwd: identity.cwd,
				started_at: nowIso(),
				explicit: identity.explicit,
				version: 1,
				context_used_pct: Math.round(ctx?.getContextUsage()?.percent ?? 0),
				queue_depth: inboundQueue.size,
				heartbeat_at: nowIso(),
			};
			writeRegistryAtomic(live, identity.project);
		} catch {
			// best-effort
		}
	}

	// Keep the coms purpose in sync with the active dispatcher persona so peers see a
	// meaningful description (decision: map peer identity onto persona description). An
	// explicit --purpose CLI flag always wins; otherwise the persona's name+description
	// becomes the purpose, falling back to comsBasePurpose when no persona is set.
	function syncComsPurpose(): void {
		if (!identity || !comsReady || comsPurposeExplicit) return;
		const next = dispatcherPersona
			? `${displayName(dispatcherPersona.name)} — ${dispatcherPersona.description}`.trim()
			: comsBasePurpose;
		if (next === identity.purpose) return;
		identity.purpose = next;
		writeLiveRegistry();
	}

	// ── Embedded coms: ping + pool helpers ──

	async function pingPeer(endpoint: string): Promise<AgentCard | null> {
		if (!identity) return null;
		const env: PingEnvelope = {
			type: "ping",
			msg_id: ulid(),
			sender_session: identity.session_id,
			sender_endpoint: identity.endpoint,
			hops: 0,
			timestamp: nowIso(),
		};
		try {
			const resp = await sendEnvelope(endpoint, env);
			if (resp && resp.type === "pong" && resp.agent_card) {
				return resp.agent_card as AgentCard;
			}
		} catch {
			// ignore — peer unreachable
		}
		return null;
	}

	function renderPool(width: number, theme: Theme): string[] {
		// Compact mode hides the coms pool too — only running agents show below the editor.
		if (viewMode === "compact") return [];
		const projectFilter = displayProject ?? identity?.project ?? "default";
		const registryEntries = projectFilter === "*"
			? readAllRegistryEntriesAcrossProjects()
			: readAllRegistryEntries(projectFilter);

		interface Row {
			name: string;
			model: string;
			color: string;
			purpose: string;
			pct: number | null;
			pending: boolean;
			stale: boolean;
		}
		const rows: Row[] = [];
		const seenSessions = new Set<string>();

		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			seenSessions.add(sid);
			rows.push({
				name: card.name,
				model: card.model,
				color: card.color,
				purpose: card.purpose,
				pct: card.context_used_pct,
				pending: false,
				stale: (card.staleCount ?? 0) >= 3,
			});
		}

		// Registry-only entries that aren't yet in peerCards → pending
		const seenNames = new Set(rows.map((r) => r.name));
		for (const entry of registryEntries) {
			if (identity && entry.session_id === identity.session_id) continue;
			if (!includeExplicit && entry.explicit) continue;
			if (seenSessions.has(entry.session_id)) continue;
			if (seenNames.has(entry.name)) continue;
			rows.push({
				name: entry.name,
				model: entry.model,
				color: entry.color,
				purpose: entry.purpose,
				pct: null,
				pending: true,
				stale: false,
			});
		}

		// Border helpers — sandwich the body with single-line box-drawing rules
		// so the widget reads as its own block. The top border carries a branded
		// ` coms ` tag; bottom border stays a plain rule for minimalism.
		const safeWidth = Math.max(0, width);
		let topBorder: string;
		let bottomBorder: string;
		if (safeWidth < 12) {
			topBorder = theme.fg("dim", "━".repeat(safeWidth));
			bottomBorder = theme.fg("dim", "━".repeat(safeWidth));
		} else {
			const left = theme.fg("dim", "┏━") + theme.fg("border", " coms ");
			const leftFill = theme.fg("dim", "━");
			const nameLen = identity ? identity.name.length : 0;
			const rightTagVisLen = identity ? nameLen + 4 : 0;
			const remaining = safeWidth - 9 /* "┏━ coms ━" */ - rightTagVisLen - 1 /* "┓" */;
			if (identity && remaining >= 1) {
				const rightTag =
					theme.fg("dim", " ") +
					hexFg(identity.color, identity.name) +
					theme.fg("dim", " ━");
				const middle = theme.fg("dim", "━".repeat(remaining));
				const right = theme.fg("dim", "┓");
				topBorder = left + leftFill + middle + rightTag + right;
			} else {
				const fallbackRemaining = Math.max(0, safeWidth - 2 /* "┏━" */ - 6 /* " coms " */ - 1 /* "┓" */);
				const right = theme.fg("dim", "━".repeat(fallbackRemaining) + "┓");
				topBorder = left + right;
			}
			bottomBorder = theme.fg("dim", "┗" + "━".repeat(safeWidth - 2) + "┛");
		}

		if (rows.length === 0) {
			const emptyMsg = theme.fg("muted", "no peers connected");
			return [
				topBorder,
				truncateToWidth(theme.fg("dim", " ") + emptyMsg, width),
				bottomBorder,
			];
		}

		rows.sort((a, b) => a.name.localeCompare(b.name));

		const out: string[] = [topBorder];

		for (const r of rows) {
			const pctNum = r.pct ?? 0;
			const filled = Math.max(0, Math.min(15, Math.round((pctNum / 100) * 15)));
			const empty = 15 - filled;
			const pctLabel = r.pct == null ? "--%" : `${r.pct}%`;

			if (r.stale) {
				const dimRow = `✗ ${r.name.padEnd(12)} ${abbreviateModel(r.model).padEnd(14)} [${"-".repeat(15)}] ${pctLabel.padStart(4)}  —  ${r.purpose || ""}`;
				out.push(truncateToWidth(" " + theme.fg("dim", dimRow), width));
				continue;
			}

			const swatch = r.pending ? theme.fg("dim", "●") : hexFg(r.color, "●");
			const namePart = theme.fg("accent", r.name.padEnd(12));
			const modelPart = theme.fg("dim", abbreviateModel(r.model).padEnd(14));
			const barFill = r.pending
				? theme.fg("dim", "-".repeat(15))
				: hexFg(r.color, "#".repeat(filled)) + theme.fg("dim", "-".repeat(empty));
			const bar = theme.fg("warning", "[") + barFill + theme.fg("warning", "]");
			const pctPart = " " + theme.fg("accent", pctLabel.padStart(4));
			const sep = theme.fg("dim", "  —  ");
			const purposePart = theme.fg("muted", r.purpose || "");

			const line = " " + swatch + " " + namePart + " " + modelPart + " " + bar + pctPart + sep + purposePart;
			out.push(truncateToWidth(line, width));
		}

		out.push(bottomBorder);
		return out;
	}

	function installPoolWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget("coms-pool", (_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					return renderPool(width, theme);
				},
			}), { placement: "belowEditor" });
		} catch {
			// non-fatal
		}
	}

	async function refreshPool(): Promise<void> {
		if (!identity) return;
		const peers = peersInScope();

		const results = await Promise.allSettled(peers.map(async (peer) => {
			const pingEnv: PingEnvelope = {
				type: "ping",
				msg_id: ulid(),
				sender_session: identity!.session_id,
				sender_endpoint: identity!.endpoint,
				hops: 0,
				timestamp: nowIso(),
			};
			const reply = await sendEnvelope(peer.endpoint, pingEnv);
			return { peer, pong: reply as Pong };
		}));

		const seenSessions = new Set<string>();
		let changed = false;

		for (const r of results) {
			if (r.status === "fulfilled" && r.value.pong && r.value.pong.agent_card) {
				const { peer, pong } = r.value;
				seenSessions.add(peer.session_id);
				const prev = peerCards.get(peer.session_id);
				const next = { ...pong.agent_card, staleCount: 0 };
				if (!prev || JSON.stringify({ ...prev, staleCount: 0 }) !== JSON.stringify(next)) {
					peerCards.set(peer.session_id, next);
					changed = true;
				}
			}
		}

		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			if (!seenSessions.has(sid)) {
				card.staleCount = (card.staleCount ?? 0) + 1;
				if (card.staleCount > 6) {
					peerCards.delete(sid);
				}
				changed = true;
			}
		}

		if (changed && currentCtx?.hasUI) {
			installPoolWidget(currentCtx);
		}
	}

	function listProjects(): string[] {
		const root = path.join(COMS_DIR, "projects");
		try {
			return fs.readdirSync(root).filter((d) => {
				try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
			});
		} catch {
			return [];
		}
	}

	// The peers currently in scope — exactly what the coms pool widget shows: live
	// (pruned) registry entries in the displayed project (displayProject, or the home
	// project; "*" only when the human widened via /coms --project *), excluding self
	// and — unless /coms --all set includeExplicit — explicit peers. This is the
	// SECURITY BOUNDARY for every coms op: list, send, and handoff resolve only within
	// it. Widening it is a deliberate human action via /coms, never something the LLM
	// can do on its own. Single source of truth — reused by the widget refresh, the
	// handoff completions, coms_list, and resolveTarget so they can never diverge.
	function peersInScope(): RegistryEntry[] {
		if (!identity) return [];
		const filter = displayProject ?? identity.project;
		const live = filter === "*" ? pruneDeadEntriesAllProjects() : pruneDeadEntries(filter);
		return live.filter(
			(e) => e.session_id !== identity!.session_id && (includeExplicit || !e.explicit),
		);
	}

	function resolveTarget(target: string): RegistryEntry | null {
		// Scoped to the connected pool only (peersInScope): you can reach exactly the
		// peers the widget shows. Match by name first (preferred, human-facing), then by
		// session_id. A peer outside the current scope is intentionally NOT resolved — the
		// human must widen scope via /coms --project / --all first. This closes the old
		// cross-project leak where a name match fell through to scanning every project.
		const scope = peersInScope();
		const byName = scope.find((e) => e.name === target);
		if (byName) return byName;
		return scope.find((e) => e.session_id === target) ?? null;
	}

	// ── dispatch_agent Tool (registered at top level) ──

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist agent. The agent will execute the task and return the result. Use the system prompt to see available agent names.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent to execute" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { agent, task } = params as { agent: string; task: string };

			try {
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Dispatching to ${agent}...` }],
						details: { agent, task, status: "dispatching" },
					});
				}

				let result = await dispatchAgent(agent, task, ctx);

				// Auto-research pipe: when the specialist pauses with NEEDS_RESEARCH
				// lines, the hub (in code, not the dispatcher LLM) fans out read-only
				// helpers, writes findings to files, and resumes the specialist's
				// session with the paths. The dispatcher only ever sees a short notice,
				// keeping its context clean of raw findings.
				const researchRounds: { questions: string[]; files: string[] }[] = [];
				while (result.exitCode === 0 && researchRounds.length < MAX_AUTO_RESEARCH_ROUNDS) {
					const researchQs = extractNeedsResearch(result.output).slice(0, MAX_AUTO_RESEARCH_QUESTIONS);
					if (researchQs.length === 0) break;

					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: `${agent} paused for research (${researchQs.length} question(s)) — spawning read-only helpers...` }],
							details: { agent, task, status: "researching" },
						});
					}

					const findingsDir = join(sessionDir, "findings");
					mkdirSync(findingsDir, { recursive: true });
					const agentKey = agent.toLowerCase().replace(/\s+/g, "-");

					const answered = await Promise.all(researchQs.map(async (q) => {
						const rDef = anonResearchDef();
						const rState = createResearchState(rDef, false, resolveResearchModel(rDef, undefined, ctx));
						updateResearchWidget();
						const rRes = await spawnResearch(rState, q, ctx);
						const file = join(findingsDir, `${agentKey}-r${rState.id}.md`);
						const body = `# Research findings r${rState.id}\n\n**Question:** ${q}\n\n` +
							(rRes.exitCode === 0 ? rRes.output : `(research helper failed, exit ${rRes.exitCode})\n\n${rRes.output}`) + "\n";
						writeFileSync(file, body, "utf-8");
						return { question: q, file };
					}));

					researchRounds.push({ questions: researchQs, files: answered.map(a => a.file) });

					const resumePrompt = "Research findings for your NEEDS_RESEARCH questions are ready. " +
						"Read each file with your read tool, then continue from where you paused:\n" +
						answered.map((a, i) => `${i + 1}. ${a.question}\n   → ${a.file}`).join("\n");
					result = await dispatchAgent(agent, resumePrompt, ctx);
				}

				const truncated = result.output.length > 8000
					? result.output.slice(0, 8000) + "\n\n... [truncated]"
					: result.output;

				// Extract bubble-up questions emitted via the clarification protocol.
				const questions = extractAskUserQuestions(result.output);

				const status = result.exitCode === 0 ? "done" : "error";
				const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s`;
				const questionsNotice = questions.length > 0
					? `\n\n⚠ ${questions.length} ASK_USER question(s) raised by ${agent}. ` +
					  `You MUST call ask_user for each (in ${userLanguage}) before re-dispatching:\n` +
					  questions.map((q, i) => `  ${i + 1}. ${q}`).join("\n")
					: "";

				const answeredCount = researchRounds.reduce((n, r) => n + r.questions.length, 0);
				const unresolved = extractNeedsResearch(result.output);
				const researchNotice = researchRounds.length > 0
					? `\n\nℹ ${agent} auto-paused for research ${researchRounds.length} round(s); ${answeredCount} question(s) answered by read-only helpers. ` +
					  `Findings were saved under ${join(sessionDir, "findings")} and read by the agent directly — they are NOT inlined here.`
					: "";
				const budgetNotice = unresolved.length > 0 && researchRounds.length >= MAX_AUTO_RESEARCH_ROUNDS
					? `\n\n⚠ ${agent} still requests research (${unresolved.length} question(s)) but the auto-research budget is exhausted. ` +
					  `Run spawn_research yourself and re-dispatch with the findings, or simplify the task.`
					: "";

				return {
					content: [{ type: "text", text: `${summary}${questionsNotice}${researchNotice}${budgetNotice}\n\n${truncated}` }],
					details: {
						agent,
						task,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						fullOutput: result.output,
						questions,
						researchRounds,
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error dispatching to ${agent}: ${err?.message || err}` }],
					details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
		},

		renderCall(args, theme) {
			const agentName = (args as any).agent || "?";
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", agentName) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// Streaming/partial result while agent is still running
			if (options.isPartial || details.status === "dispatching") {
				return new Text(
					theme.fg("accent", `● ${details.agent || "?"}`) +
					theme.fg("dim", " working..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.agent}`) +
				theme.fg("dim", ` ${elapsed}s`);

			const questions: string[] = Array.isArray(details.questions) ? details.questions : [];
			const questionsBlock = questions.length > 0
				? "\n" + theme.fg("warning", `⚠ ${questions.length} ASK_USER question(s) raised — surface via ask_user`)
				: "";

			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + questionsBlock + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header + questionsBlock, 0, 0);
		},
	});

	// ── spawn_research Tool (dispatcher → read-only helper) ──
	// The dispatcher fans out research (decision 8): dispatched specialists are
	// sandboxed (--no-extensions, no dispatch tool) and cannot spawn their own helpers,
	// so when one needs reconnaissance the DISPATCHER runs this, collects the findings,
	// and folds them into the specialist's task. Always read-only → safe to run without
	// ask_user gating.
	pi.registerTool({
		name: "spawn_research",
		label: "Spawn Research",
		description: "Spawn a READ-ONLY research helper (read/grep/find/ls — no bash, no writes) and return its findings. Use for reconnaissance, code search, and reading docs/code before dispatching a builder, or to gather context for a specialist (specialists cannot spawn their own helpers). Pass `persona` to use a research persona, or omit it for an ad-hoc helper.",
		parameters: Type.Object({
			task: Type.String({ description: "What to investigate. Be specific about what to find and report." }),
			persona: Type.Optional(Type.String({ description: "Optional research-persona name (see the Research personas list). It brings its own role/model/thinking. Omit for an anonymous helper." })),
			model: Type.Optional(Type.String({ description: "Optional pi model spec for an anonymous helper (ignored when `persona` is set — the persona carries its own model)." })),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { task, persona, model } = params as { task: string; persona?: string; model?: string };

			let def: AgentDef;
			let isPersona = false;
			if (persona) {
				const found = researchPersonas.find(d => d.name.toLowerCase() === persona.toLowerCase());
				if (!found) {
					const available = researchPersonas.map(d => d.name).join(", ") || "(none defined)";
					return {
						content: [{ type: "text", text: `No research persona "${persona}". Available: ${available}. Omit \`persona\` for an ad-hoc helper.` }],
						details: { status: "error" },
					};
				}
				def = found;
				isPersona = true;
			} else {
				def = anonResearchDef();
			}

			const resolvedModel = resolveResearchModel(def, isPersona ? undefined : model, ctx);
			const state = createResearchState(def, isPersona, resolvedModel);
			updateResearchWidget();

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Spawning research helper r${state.id}...` }],
					details: { handle: `r${state.id}`, persona: isPersona ? def.name : null, status: "spawning" },
				});
			}

			try {
				const result = await spawnResearch(state, task, ctx);
				const truncated = result.output.length > 8000
					? result.output.slice(0, 8000) + "\n\n... [truncated]"
					: result.output;
				const status = result.exitCode === 0 ? "done" : "error";
				const label = isPersona ? displayName(def.name) : "ad-hoc";
				const summary = `[research r${state.id} · ${label} · read-only] ${status} in ${Math.round(result.elapsed / 1000)}s`;
				return {
					content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
					details: {
						handle: `r${state.id}`,
						persona: isPersona ? def.name : null,
						model: resolvedModel,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						fullOutput: result.output,
					},
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Error spawning research helper: ${err?.message || err}` }],
					details: { handle: `r${state.id}`, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" },
				};
			}
		},

		renderCall(args, theme) {
			const persona = (args as any).persona;
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("spawn_research ")) +
				theme.fg("accent", persona ? `@${persona}` : "ad-hoc") +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (options.isPartial || details.status === "spawning") {
				return new Text(
					theme.fg("accent", `● ${details.handle || "research"}`) +
					theme.fg("dim", " researching..."),
					0, 0,
				);
			}
			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.handle || "research"}`) +
				theme.fg("dim", ` read-only ${elapsed}s`);
			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}
			return new Text(header, 0, 0);
		},
	});

	// ── Embedded coms tools (dispatcher ⇄ peers) ──

	pi.registerTool({
		name: "coms_list",
		label: "Coms List",
		description:
			"List the peer agents in your current coms pool — the ones shown in the pool widget. Returns " +
			"names, models, and live context-window usage. Discovery is scoped to what the human displays " +
			"via /coms; you CANNOT widen it to other projects or reveal --explicit peers yourself.",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Narrow to a project WITHIN the current pool scope. Cannot widen beyond what /coms displays — a widening request is ignored." })),
			include_explicit: Type.Optional(Type.Boolean({ description: "Only narrows: pass false to hide explicit peers. Cannot reveal them unless the human ran /coms --all." })),
		}),
		async execute(_callId, params) {
			if (!identity) {
				return {
					content: [{ type: "text" as const, text: "coms not initialised." }],
					details: { agents: [], project: null },
				};
			}
			// Clamp discovery to the human-set pool scope (displayProject + includeExplicit,
			// driven by /coms). The LLM's project/include_explicit may NARROW within that
			// scope but can never widen it — cross-project or explicit discovery requires a
			// deliberate /coms --project / --all from the human. So coms_list returns exactly
			// the pool, the same boundary coms_send enforces.
			const scopeProject = displayProject ?? identity.project;
			let projects: string[];
			let widened = false;
			if (scopeProject === "*") {
				projects = params.project && params.project !== "*" ? [params.project] : listProjects();
			} else {
				projects = [scopeProject];
				if (params.project && params.project !== scopeProject) widened = true;
			}
			// include_explicit may only narrow (turn OFF); it cannot reveal explicit peers
			// unless the human already did via /coms --all.
			const includeExp = includeExplicit && params.include_explicit !== false;
			if (params.include_explicit === true && !includeExplicit) widened = true;

			const collected: { entry: RegistryEntry; project: string }[] = [];
			for (const proj of projects) {
				for (const entry of pruneDeadEntries(proj)) {
					if (entry.explicit && !includeExp) continue;
					if (entry.session_id === identity.session_id) continue;
					collected.push({ entry, project: proj });
				}
			}

			// Ping each peer in parallel for live context usage.
			const pongs = await Promise.allSettled(collected.map((c) => pingPeer(c.entry.endpoint)));

			const agents = collected.map((c, i) => {
				const r = pongs[i];
				const pong = r.status === "fulfilled" ? r.value : null;
				return {
					name: c.entry.name,
					session_id: c.entry.session_id,
					purpose: c.entry.purpose,
					model: c.entry.model,
					cwd: c.entry.cwd,
					project: c.project,
					alive: pong != null,
					context_used_pct: pong ? pong.context_used_pct : null,
					color: c.entry.color,
				};
			});

			const notice = widened
				? `\n\n(Discovery is scoped to "${scopeProject}"${includeExplicit ? "" : ", explicit peers hidden"}. ` +
				  `Widening to other projects or revealing --explicit peers is a human action via ` +
				  `/coms --project <name> or /coms --all.)`
				: "";

			const lines = agents.length === 0
				? "No peer agents in your pool."
				: agents.map((a) => {
					const ctxStr = a.context_used_pct != null ? ` ${a.context_used_pct}%` : " ?%";
					const live = a.alive ? "●" : "✗";
					return `${live} ${a.name} (${a.model})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
				}).join("\n");

			return {
				content: [{ type: "text" as const, text: `${agents.length} peer(s) in pool (project ${scopeProject}):\n${lines}${notice}` }],
				details: { agents, project: scopeProject, scoped: true, widenRequested: widened },
			};
		},
		renderCall(args, theme) {
			const proj = (args as any).project;
			const filter = proj ? ` ${proj}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_list")) + theme.fg("dim", filter),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			const agents: any[] = details?.agents ?? [];
			const header = theme.fg("accent", `📡 ${agents.length} peer(s)`);
			if (!options.expanded || agents.length === 0) {
				return new Text(header, 0, 0);
			}
			const rows = agents.map((a) => {
				const dot = a.alive ? theme.fg("success", "●") : theme.fg("error", "✗");
				const pct = a.context_used_pct != null ? `${a.context_used_pct}%` : "?%";
				return `${dot} ${theme.fg("accent", a.name)} ${theme.fg("dim", a.model)} ${theme.fg("warning", pct)}`;
			}).join("\n");
			return new Text(header + "\n" + rows, 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_send",
		label: "Coms Send",
		description:
			"Send a prompt to a peer agent. Returns synchronously with a msg_id once the receiver acks. " +
			"Use coms_get (non-blocking) or coms_await (blocking) with the msg_id to retrieve the response. " +
			"Throws if the receiver is unreachable or rejects the envelope.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name (preferred) or session_id — must be a peer currently in your coms pool (shown in the widget). Out-of-pool targets are refused; ask the human to widen scope with /coms --project or /coms --all." }),
			prompt: Type.String({ description: "The prompt to send." }),
			conversation_id: Type.Optional(Type.String()),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
		}),
		async execute(_callId, params) {
			if (!identity) {
				throw new Error("coms not initialised");
			}
			const target = resolveTarget(params.target);
			if (!target) {
				// Refuse without confirming whether the peer exists outside the pool — that
				// existence is itself cross-project metadata. Point at the human-controlled
				// widening path instead.
				const scope = displayProject ?? identity.project;
				throw new Error(
					`coms: no connected peer "${params.target}" in your pool (project ${scope}). ` +
					`Only peers shown in the coms pool are reachable. If you expected this peer, ask the ` +
					`human to widen scope with /coms --project <name> or /coms --all, then retry.`,
				);
			}
			const hops = currentInbound ? currentInbound.hops + 1 : 0;
			if (hops >= MAX_HOPS) {
				throw new Error(`coms: hop limit reached (${hops} >= ${MAX_HOPS})`);
			}
			const msg_id = ulid();
			const env: PromptEnvelope = {
				type: "prompt",
				msg_id,
				sender_session: identity.session_id,
				sender_endpoint: identity.endpoint,
				sender_name: identity.name,
				sender_cwd: identity.cwd,
				hops,
				timestamp: nowIso(),
				prompt: params.prompt,
				conversation_id: params.conversation_id ?? null,
				response_schema: (params.response_schema as object | undefined) ?? null,
			};

			// Send the envelope synchronously and wait for the receiver's ack.
			await sendEnvelope(target.endpoint, env);

			// Register a pending entry whose promise the receiver-side handleResponse
			// (or the timeout below) will settle.
			let resolveFn!: (v: { response?: any; error?: string | null }) => void;
			let rejectFn!: (e: Error) => void;
			const promise = new Promise<{ response?: any; error?: string | null }>((res, rej) => {
				resolveFn = res;
				rejectFn = rej;
			});
			const entry: PendingReply = {
				resolve: resolveFn,
				reject: rejectFn,
				timer: null,
				promise,
				target_name: target.name,
				created_at: nowIso(),
			};
			entry.timer = setTimeout(() => {
				if (entry.result) return;
				entry.result = { error: "timeout" };
				try { entry.resolve(entry.result); } catch { /* ignore */ }
			}, TIMEOUT_MS);
			// Don't keep the event loop alive solely for this timer.
			try { (entry.timer as any).unref?.(); } catch { /* ignore */ }
			pendingReplies.set(msg_id, entry);

			try {
				pi.appendEntry("coms-log", {
					event: "outbound_prompt",
					msg_id,
					target: target.name,
					hops,
				});
			} catch {
				// best-effort
			}

			return {
				content: [{ type: "text" as const, text: `coms_send → ${target.name}\nmsg_id ${msg_id}\nhops ${hops}` }],
				details: { msg_id, target: target.name, target_session: target.session_id, hops },
			};
		},
		renderCall(args, theme) {
			const tgt = (args as any).target ?? "?";
			const prompt = (args as any).prompt ?? "";
			const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_send ")) +
				theme.fg("accent", tgt) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (!d) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			return new Text(
				theme.fg("success", "→ ") +
				theme.fg("accent", d.target) +
				theme.fg("dim", `  msg_id `) +
				theme.fg("warning", d.msg_id),
				0, 0,
			);
		},
	});

	pi.registerTool({
		name: "coms_get",
		label: "Coms Get",
		description:
			"Non-blocking poll of a pending coms_send reply. Returns status pending|complete|error and (when complete) the response.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
		}),
		async execute(_callId, params) {
			const entry = pendingReplies.get(params.msg_id);
			if (!entry) {
				return {
					content: [{ type: "text" as const, text: `coms_get: unknown msg_id ${params.msg_id}` }],
					details: { status: "error", error: "unknown msg_id" },
				};
			}
			if (entry.result) {
				const r = entry.result;
				const text = r.error
					? `coms_get: error — ${r.error}`
					: `coms_get: complete\n${typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2)}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { status: "complete", response: r.response, error: r.error ?? null },
				};
			}
			return {
				content: [{ type: "text" as const, text: `coms_get: pending` }],
				details: { status: "pending" },
			};
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_get ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			const status = d?.status ?? "?";
			const color = status === "complete" ? "success" : status === "pending" ? "warning" : "error";
			return new Text(theme.fg(color, status), 0, 0);
		},
	});

	pi.registerTool({
		name: "coms_await",
		label: "Coms Await",
		description:
			"Block until a pending coms_send reply lands or the timeout fires. Default timeout 30 minutes (PI_COMS_TIMEOUT_MS).",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
			timeout_ms: Type.Optional(Type.Number({ description: "Override the default timeout (ms)." })),
		}),
		async execute(_callId, params) {
			const entry = pendingReplies.get(params.msg_id);
			if (!entry) {
				return {
					content: [{ type: "text" as const, text: `coms_await: unknown msg_id ${params.msg_id}` }],
					details: { error: "unknown msg_id" },
				};
			}
			const timeoutMs = typeof params.timeout_ms === "number" && params.timeout_ms > 0
				? params.timeout_ms
				: TIMEOUT_MS;

			const timed = new Promise<{ error: string }>((resolve) => {
				const t = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
				try { (t as any).unref?.(); } catch { /* ignore */ }
			});

			const winner = await Promise.race([entry.promise, timed]);
			if ((winner as any).error) {
				return {
					content: [{ type: "text" as const, text: `coms_await: error — ${(winner as any).error}` }],
					details: { error: (winner as any).error },
				};
			}
			const resp = (winner as any).response;
			return {
				content: [{ type: "text" as const, text: typeof resp === "string" ? resp : JSON.stringify(resp, null, 2) }],
				details: { response: resp },
			};
		},
		renderCall(args, theme) {
			const id = (args as any).msg_id ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("coms_await ")) + theme.fg("warning", id),
				0, 0,
			);
		},
		renderResult(result, _options, theme) {
			const d = result.details as any;
			if (d?.error) return new Text(theme.fg("error", `✗ ${d.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ response received"), 0, 0);
		},
	});

	// ── ask_user Tool (dispatcher → human) ──
	//
	// We do NOT register `ask_user` here. The recommended companion package
	// `pi-ask-user` (see docs/pi-setup.md) owns that tool name with a richer
	// implementation. Registering our own conflicts regardless of load order:
	//   - if we register first, pi-ask-user fails to load
	//   - if pi-ask-user registers first, our registration fails
	// and pi has no synchronous probe at load time — `pi.getAllTools()` is
	// a runtime action method that throws when called from the factory.
	//
	// Instead, in `session_start` (where action methods ARE allowed) we check
	// `pi.getAllTools()`, gate `ask_user` into `setActiveTools` only if present,
	// and warn the user to `pi install npm:pi-ask-user` if it's missing.

	let askUserAvailable = false;

	// ── Dispatcher persona picker (blocking gate) ──
	// Mirrors purpose-gate's blocking loop, but over a select of orchestrator
	// personas instead of a free-text purpose. Loops until one is picked; the
	// on/off setting (and turning it off) is the only way to skip.
	async function pickDispatcherPersona(ctx: any) {
		while (!dispatcherPersona) {
			const options = orchestratorPersonas.map(p => `${displayName(p.name)} — ${p.description}`);
			const choice = await ctx.ui.select("Select dispatcher persona", options);
			if (choice === undefined) {
				ctx.ui.notify(
					"A dispatcher persona is required. Set `persona-gate: off` under `## agent-team` in .ai/agent-skills-overrides.md to skip.",
					"warning",
				);
				continue;
			}
			const idx = options.indexOf(choice);
			dispatcherPersona = orchestratorPersonas[idx] || null;
		}
		personaGateSatisfied = true;
		// Reflect the chosen persona into the coms identity so peers see who we are.
		syncComsPurpose();
		// Flavor-only: do NOT call setActiveTools(persona.tools) — the dispatcher's
		// orchestration surface must be preserved (decision G4). The persona only
		// flavors the system prompt, applied in before_agent_start.
		ctx.ui.setStatus("dispatcher-persona", `Persona: ${displayName(dispatcherPersona.name)}`);
		ctx.ui.notify(`Dispatcher persona: ${displayName(dispatcherPersona.name)}`, "success");
	}

	// ── Commands ─────────────────────────────────

	pi.registerCommand("agents-team", {
		description: "Select a team to work with",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			const teamNames = Object.keys(teams);
			if (teamNames.length === 0) {
				ctx.ui.notify("No teams defined in .pi/agents/teams.yaml", "warning");
				return;
			}

			const options = teamNames.map(name => {
				const members = teams[name].map(m => displayName(m));
				return `${name} — ${members.join(", ")}`;
			});

			const choice = await ctx.ui.select("Select Team", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			const name = teamNames[idx];
			activateTeam(name);
			updateWidget();
			ctx.ui.setStatus("agent-team", `Team: ${name} (${agentStates.size})`);
			ctx.ui.notify(`Team: ${name} — ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, "info");
		},
	});

	pi.registerCommand("agents-list", {
		description: "List all loaded agents",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const names = Array.from(agentStates.values())
				.map(s => {
					const session = s.sessionFile ? "resumed" : "new";
					const model = s.def.model || "dispatcher's";
					return `${displayName(s.def.name)} (${s.status}, ${session}, model: ${model}, runs: ${s.runCount}): ${s.def.description}`;
				})
				.join("\n");
			_ctx.ui.notify(names || "No agents loaded", "info");
		},
	});

	pi.registerCommand("agents-grid", {
		description: "Set grid columns: /agents-grid <1-6>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5", "6"].map(n => ({
				value: n,
				label: `${n} columns`,
			}));
			const filtered = items.filter(i => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 6) {
				gridCols = n;
				_ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
				updateWidget();
			} else {
				_ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
			}
		},
	});

	// Alt+A toggles the agent view between the full dashboard grid (above the
	// editor) and the compact running-agents list (below the editor). alt+a has no
	// default pi binding — every useful ctrl+letter is already taken (ctrl+r is
	// session-rename), and alt+a is not consumed by the editor, so it reaches the
	// extension shortcut handler in the main input.
	pi.registerShortcut("alt+a", {
		description: "Toggle agent view: dashboard ↔ compact",
		handler: (ctx) => {
			widgetCtx = ctx;
			viewMode = viewMode === "dashboard" ? "compact" : "dashboard";
			updateWidget();
			updateResearchWidget();
			ctx.ui.notify(`Agent view: ${viewMode}`, "info");
		},
	});

	// Completions over loaded agent names, annotated with current status.
	const agentNameCompletions = (prefix: string): AutocompleteItem[] | null => {
		const items = Array.from(agentStates.values()).map(s => ({
			value: s.def.name,
			label: `${displayName(s.def.name)} (${s.status})`,
		}));
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	// Completions for /zoom: team member names plus research handles (rN).
	const zoomCompletions = (prefix: string): AutocompleteItem[] | null => {
		const teamItems = Array.from(agentStates.values()).map(s => ({
			value: s.def.name,
			label: `${displayName(s.def.name)} (${s.status})`,
		}));
		const researchItems = Array.from(researchStates.values()).map(s => ({
			value: `r${s.id}`,
			label: `r${s.id} ${s.persona ? displayName(s.def.name) : "research"} (${s.status})`,
		}));
		const items = [...teamItems, ...researchItems];
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	pi.registerCommand("zoom", {
		description: "Scrollable read-only view of an agent's stream: /zoom <name|rN>",
		getArgumentCompletions: zoomCompletions,
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const arg = args?.trim() || "";
			// A research handle (rN/#N/N) targets a research helper; anything else is a
			// team member name. Both satisfy Zoomable, so the same overlay renders either.
			const rid = parseResearchHandle(arg);
			const target: Zoomable | undefined = rid != null
				? researchStates.get(rid)
				: arg ? agentStates.get(arg.toLowerCase()) : undefined;
			if (!target) {
				const teamKnown = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
				const researchKnown = Array.from(researchStates.values()).map(s => `r${s.id}`).join(", ");
				const known = [teamKnown, researchKnown].filter(Boolean).join(", ");
				ctx.ui.notify(`Usage: /zoom <name|rN>. Known: ${known || "none"}`, "error");
				return;
			}
			// Open a read-only overlay over the live timeline. While it's open,
			// `target.zoomRender` lets the stream parser refresh it on new events
			// (throttled to ~12fps; force=true pushes the final frame on completion).
			let lastRender = 0;
			await ctx.ui.custom((tui, theme, _kb, done) => {
				const ui = new ZoomUI(target, () => done(undefined), (message, type) => ctx.ui.notify(message, type as any));
				target.zoomRender = (force?: boolean) => {
					const now = Date.now();
					if (force || now - lastRender > 80) {
						lastRender = now;
						tui.requestRender();
					}
				};
				return {
					render: (w: number) => ui.render(w, 30, theme),
					handleInput: (data: string) => ui.handleInput(data, tui),
					invalidate: () => {},
				};
			}, {
				overlay: true,
				overlayOptions: { width: "80%", anchor: "center" },
			});
			target.zoomRender = undefined;
		},
	});

	// Completions for /research: research-persona names prefixed with @.
	const researchPersonaCompletions = (prefix: string): AutocompleteItem[] | null => {
		const items = researchPersonas.map(d => ({
			value: `@${d.name}`,
			label: `@${d.name} — ${d.description.slice(0, 50)}`,
		}));
		if (items.length === 0) return null;
		const p = prefix.toLowerCase();
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(p));
		return filtered.length > 0 ? filtered : items;
	};

	// /research [@persona] [--model <spec>] <task> — spawn a read-only helper. Fire-and-
	// forget: the result is delivered to the dispatcher as a follow-up turn.
	pi.registerCommand("research", {
		description: "Spawn a read-only research helper: /research [@persona] [--model <spec>] <task>",
		getArgumentCompletions: researchPersonaCompletions,
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			let rest = (args ?? "").trim();
			let personaName: string | undefined;
			let modelArg: string | undefined;

			// Strip leading @persona / --model flags (order-tolerant), rest is the task.
			for (;;) {
				const sp = rest.indexOf(" ");
				const tok = sp === -1 ? rest : rest.slice(0, sp);
				if (tok.startsWith("@") && tok.length > 1) {
					personaName = tok.slice(1);
					rest = sp === -1 ? "" : rest.slice(sp + 1).trim();
				} else if (tok === "--model") {
					const after = sp === -1 ? "" : rest.slice(sp + 1).trim();
					const sp2 = after.indexOf(" ");
					modelArg = sp2 === -1 ? after : after.slice(0, sp2);
					rest = sp2 === -1 ? "" : after.slice(sp2 + 1).trim();
				} else if (tok.startsWith("--model=") && tok.length > 8) {
					modelArg = tok.slice(8);
					rest = sp === -1 ? "" : rest.slice(sp + 1).trim();
				} else {
					break;
				}
			}

			const task = rest;
			if (!task) {
				ctx.ui.notify("Usage: /research [@persona] [--model <spec>] <task>", "error");
				return;
			}

			let def: AgentDef;
			let isPersona = false;
			if (personaName) {
				const found = researchPersonas.find(d => d.name.toLowerCase() === personaName!.toLowerCase());
				if (!found) {
					const available = researchPersonas.map(d => `@${d.name}`).join(", ") || "(none)";
					ctx.ui.notify(`No research persona "@${personaName}". Available: ${available}`, "error");
					return;
				}
				def = found;
				isPersona = true;
			} else {
				def = anonResearchDef();
			}

			const resolvedModel = resolveResearchModel(def, isPersona ? undefined : modelArg, ctx);
			const state = createResearchState(def, isPersona, resolvedModel);
			updateResearchWidget();
			ctx.ui.notify(`Research r${state.id} (${isPersona ? displayName(def.name) : "ad-hoc"}, read-only) started…`, "info");

			// Fire-and-forget; deliver findings as a follow-up turn when done.
			spawnResearch(state, task, ctx).then(result => deliverResearchFollowUp(state, result));
		},
	});

	// Completions over research handles, annotated with status.
	const researchHandleCompletions = (prefix: string): AutocompleteItem[] | null => {
		const items = Array.from(researchStates.values()).map(s => ({
			value: `r${s.id}`,
			label: `r${s.id} ${s.persona ? displayName(s.def.name) : "research"} (${s.status})`,
		}));
		if (items.length === 0) return null;
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return filtered.length > 0 ? filtered : items;
	};

	// /research-cont rN <prompt> — resume a finished helper on its existing session.
	pi.registerCommand("research-cont", {
		description: "Continue a finished research helper: /research-cont rN <prompt>",
		getArgumentCompletions: researchHandleCompletions,
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const trimmed = (args ?? "").trim();
			const sp = trimmed.indexOf(" ");
			if (sp === -1) {
				ctx.ui.notify("Usage: /research-cont rN <prompt>", "error");
				return;
			}
			const rid = parseResearchHandle(trimmed.slice(0, sp));
			const prompt = trimmed.slice(sp + 1).trim();
			const state = rid != null ? researchStates.get(rid) : undefined;
			if (!state) {
				ctx.ui.notify(`No research helper "${trimmed.slice(0, sp)}". Use /research to start one.`, "error");
				return;
			}
			if (!prompt) {
				ctx.ui.notify("Usage: /research-cont rN <prompt>", "error");
				return;
			}
			if (state.status === "running") {
				ctx.ui.notify(`Research r${state.id} is still running — wait for it to finish.`, "warning");
				return;
			}
			state.turnCount++;
			updateResearchWidget();
			ctx.ui.notify(`Continuing research r${state.id} (Turn ${state.turnCount})…`, "info");
			spawnResearch(state, prompt, ctx).then(result => deliverResearchFollowUp(state, result));
		},
	});

	// /research-rm rN — remove one helper (SIGTERM if running).
	pi.registerCommand("research-rm", {
		description: "Remove a research helper (kill if running): /research-rm rN",
		getArgumentCompletions: researchHandleCompletions,
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const rid = parseResearchHandle((args ?? "").trim());
			const state = rid != null ? researchStates.get(rid) : undefined;
			if (!state) {
				ctx.ui.notify(`Usage: /research-rm rN. Known: ${Array.from(researchStates.values()).map(s => `r${s.id}`).join(", ") || "none"}`, "error");
				return;
			}
			if (state.proc && state.status === "running") {
				state.killedByOperator = true;
				state.proc.kill("SIGTERM");
				ctx.ui.notify(`Research r${state.id} killed and removed.`, "warning");
			} else {
				ctx.ui.notify(`Research r${state.id} removed.`, "info");
			}
			try { unlinkSync(researchSessionPath(state.id)); } catch {}
			researchStates.delete(state.id);
			updateResearchWidget();
		},
	});

	// /research-clear — remove all helpers (SIGTERM any running).
	pi.registerCommand("research-clear", {
		description: "Remove all research helpers",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			let killed = 0;
			const total = researchStates.size;
			for (const [, state] of Array.from(researchStates.entries())) {
				if (state.proc && state.status === "running") {
					state.killedByOperator = true;
					state.proc.kill("SIGTERM");
					killed++;
				}
				try { unlinkSync(researchSessionPath(state.id)); } catch {}
			}
			researchStates.clear();
			nextResearchId = 1;
			updateResearchWidget();
			const msg = total === 0
				? "No research helpers to clear."
				: `Cleared ${total} research helper${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`;
			ctx.ui.notify(msg, total === 0 ? "info" : "success");
		},
	});

	pi.registerCommand("agents-kill", {
		description: "Kill a running specialist: /agents-kill <name>",
		getArgumentCompletions: agentNameCompletions,
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const name = args?.trim();
			const state = name ? agentStates.get(name.toLowerCase()) : undefined;
			if (!state) {
				const known = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
				ctx.ui.notify(`Usage: /agents-kill <name>. Known: ${known || "none"}`, "error");
				return;
			}
			if (state.status !== "running" || !state.proc) {
				ctx.ui.notify(`${displayName(state.def.name)} is not running — nothing to kill.`, "warning");
				return;
			}
			// Branch A: SIGTERM the child. The close handler resolves the awaited
			// dispatch with a "do not auto-retry" message, unblocking the dispatcher.
			state.killedByOperator = true;
			state.proc.kill("SIGTERM");
			ctx.ui.notify(`Killing ${displayName(state.def.name)}...`, "info");
		},
	});

	pi.registerCommand("agents-restart", {
		description: "Kill and re-run a specialist's last task fresh: /agents-restart <name>",
		getArgumentCompletions: agentNameCompletions,
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const name = args?.trim();
			const state = name ? agentStates.get(name.toLowerCase()) : undefined;
			if (!state) {
				const known = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
				ctx.ui.notify(`Usage: /agents-restart <name>. Known: ${known || "none"}`, "error");
				return;
			}
			const task = state.task;
			if (!task) {
				ctx.ui.notify(`${displayName(state.def.name)} has no previous task to restart.`, "warning");
				return;
			}
			// If it's mid-run, kill it and wait for the child to actually exit before
			// re-dispatching (dispatchAgent rejects a re-entry while status is running).
			if (state.status === "running" && state.proc) {
				await new Promise<void>(res => {
					state.onTerminate = res;
					state.killedByOperator = true;
					state.restarting = true;
					state.proc!.kill("SIGTERM");
				});
			}
			// Re-run fresh: a frozen session file may be inconsistent, so drop it (no -c).
			state.sessionFile = null;
			ctx.ui.notify(`Restarting ${displayName(state.def.name)} (fresh)...`, "info");
			const result = await dispatchAgent(state.def.name, task, ctx);
			// The original dispatch_agent tool call already returned, so deliver the
			// fresh result to the dispatcher as a follow-up turn (subagent-widget style).
			const truncated = result.output.length > 8000
				? result.output.slice(0, 8000) + "\n\n... [truncated]"
				: result.output;
			const status = result.exitCode === 0 ? "completed" : "failed";
			pi.sendMessage({
				customType: "agent-restart-result",
				content: `[${displayName(state.def.name)}] restarted by operator and ${status} in ${Math.round(result.elapsed / 1000)}s.\n\n${truncated}`,
				display: true,
			}, { deliverAs: "followUp", triggerTurn: true });
		},
	});

	pi.registerCommand("persona", {
		description: "Select or reset the dispatcher persona (orchestrator flavor)",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (orchestratorPersonas.length === 0) {
				ctx.ui.notify(
					"No orchestrator personas found. Add a persona file with `kind: orchestrator` in agents/ or .pi/agents/.",
					"warning",
				);
				return;
			}
			const options = [
				"Reset to default (no persona)",
				...orchestratorPersonas.map(p => `${displayName(p.name)} — ${p.description}`),
			];
			const choice = await ctx.ui.select("Select dispatcher persona", options);
			if (choice === undefined) return;
			if (choice === options[0]) {
				dispatcherPersona = null;
				ctx.ui.setStatus("dispatcher-persona", "Persona: Default");
				ctx.ui.notify("Dispatcher persona reset to default", "success");
				syncComsPurpose();
				return;
			}
			const idx = options.indexOf(choice) - 1;
			dispatcherPersona = orchestratorPersonas[idx] || null;
			// Flavor-only — never narrows tools (decision G4).
			ctx.ui.setStatus("dispatcher-persona", `Persona: ${displayName(dispatcherPersona!.name)}`);
			ctx.ui.notify(`Dispatcher persona: ${displayName(dispatcherPersona!.name)}`, "success");
			syncComsPurpose();
		},
	});

	// ── Embedded coms: /coms + /handoff ──

	// Completions over live peer names for /handoff.
	const comsPeerCompletions = (prefix: string): AutocompleteItem[] | null => {
		// Same pool scope as coms_send/handoff resolution — only offer peers you can reach.
		const entries = peersInScope();
		const items = entries.map(e => ({ value: e.name, label: `${e.name} — ${e.purpose || e.model}` }));
		if (items.length === 0) return null;
		const p = prefix.toLowerCase();
		const filtered = items.filter(i => i.value.toLowerCase().startsWith(p));
		return filtered.length > 0 ? filtered : items;
	};

	pi.registerCommand("coms", {
		description: "Force-refresh the coms pool widget (or filter with --all / --project <name>)",
		handler: async (args, ctx) => {
			if (!comsReady) { ctx.ui.notify("coms is not active in this session.", "warning"); return; }
			const trimmed = (args ?? "").trim();
			if (trimmed.includes("--all")) {
				includeExplicit = !includeExplicit;
				try { ctx.ui.notify(`coms: include_explicit = ${includeExplicit}`, "info"); } catch { /* ignore */ }
			}
			const projectMatch = trimmed.match(/--project\s+(\S+)/);
			if (projectMatch) {
				displayProject = projectMatch[1];
				try { ctx.ui.notify(`coms: displaying project ${displayProject}`, "info"); } catch { /* ignore */ }
			}
			await refreshPool();
		},
	});

	// /handoff <peer> — hand the session off to a coms peer. Per decision G1 we do NOT
	// extract the compaction summary; instead we ask the dispatcher LLM (next turn) to
	// compose a SELF-CONTAINED brief and coms_send it, then await + relay the reply.
	pi.registerCommand("handoff", {
		description: "Hand the session off to a coms peer (the dispatcher composes a self-contained brief): /handoff <peer>",
		getArgumentCompletions: comsPeerCompletions,
		handler: async (args, ctx) => {
			if (!comsReady) { ctx.ui.notify("coms is not active in this session — /handoff unavailable.", "warning"); return; }
			const target = (args ?? "").trim();
			if (!target) {
				ctx.ui.notify("Usage: /handoff <peer>. See the coms pool for live peer names.", "error");
				return;
			}
			const peer = resolveTarget(target);
			if (!peer) {
				ctx.ui.notify(`coms: no live peer "${target}". Use /coms to refresh the pool.`, "error");
				return;
			}
			pi.sendMessage({
				customType: "coms-handoff",
				content:
					`HANDOFF REQUEST → peer "${peer.name}".\n\n` +
					`Compose a SELF-CONTAINED handoff brief (the peer does NOT share your context): state the ` +
					`overall goal, what's been done so far, key decisions and constraints, the current status, ` +
					`and the concrete next steps you want the peer to take. Then call ` +
					`coms_send(target: "${peer.name}", prompt: <the brief>), coms_await its msg_id, and relay ` +
					`the peer's reply to me in ${userLanguage}.`,
				display: true,
			}, { deliverAs: "followUp", triggerTurn: true });
			ctx.ui.notify(`Handoff to ${peer.name}: asking the dispatcher to compose a brief…`, "info");
		},
	});

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		// Build dynamic agent catalog from active team only
		const agentCatalog = Array.from(agentStates.values())
			.map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}`)
			.join("\n\n");

		const teamMembers = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");

		// Research personas (kind: research) the dispatcher can spawn read-only via
		// spawn_research. Independent of team membership.
		const researchCatalog = researchPersonas.length > 0
			? researchPersonas
				.map(d => `### ${displayName(d.name)}\n**Spawn as:** \`spawn_research(persona: "${d.name}")\`\n**Model:** ${d.model || "(dispatcher's default)"} · **Thinking:** ${resolveThinkingLevel(d.thinking)}\n${d.description}`)
				.join("\n\n")
			: "(No research personas defined. Call `spawn_research` without `persona` for an ad-hoc read-only helper.)";

		// Two flavors of the system prompt depending on whether ask_user is
		// registered (i.e. pi-ask-user is installed). Without it the dispatcher
		// must state assumptions explicitly instead of asking.
		const askUserBlock = askUserAvailable
			? `## When to call \`ask_user\` (non-negotiable triggers)
- Requirements are ambiguous, incomplete, or contradictory.
- Multiple valid approaches exist and the trade-off is preference-dependent
  (architecture, library choice, naming, scope cuts).
- A specialist returned an \`ASK_USER:\` marker — surface every one.
- A specialist's output contradicts an earlier specialist's output, or contradicts
  the user's stated requirement — ask the user to resolve it.
- The next dispatch would be costly to undo (destructive edit, migration, mass
  rename, production-facing change, secret/credential handling).
- You're about to assume a value (path, version, flag, threshold) the user did
  not specify.

Calling \`ask_user\`:
- Read the tool's own description for the exact parameter shape — different
  installs ship slightly different schemas. Always pass \`question\` and, when
  helpful, \`context\` (a 1–3 line summary of what you've already found).
- Provide multiple-choice \`options\` whenever you can enumerate 2–6 valid
  answers — it's faster for the user than free text.
- Ask exactly **one** focused question per call. Do not bundle unrelated questions.`
			: `## ask_user is NOT available in this session
The \`pi-ask-user\` package is not installed, so you have no interactive way to
ask the human. You MUST instead:
- State every assumption explicitly in ${userLanguage} before dispatching.
- Phrase it as: "Assuming X (because Y) — say STOP/correct if wrong, otherwise I'll proceed."
- Wait for the user's next message before continuing on anything destructive.
- For \`ASK_USER:\` markers raised by specialists, relay the question verbatim to
  the user in ${userLanguage} and wait for their reply in the next turn.`;

		const toolList = askUserAvailable
			? "three tools: `dispatch_agent` (delegate work to a specialist), `spawn_research` (run a read-only research helper), and `ask_user` (talk to the human)"
			: "two tools: `dispatch_agent` (delegate work to a specialist) and `spawn_research` (run a read-only research helper). `ask_user` is NOT available — see the section below";

		const dispatchSection = askUserAvailable
			? `- BEFORE dispatching: if anything is ambiguous, missing, or could go several valid
  ways, call \`ask_user\` first. Never invent constraints or "reasonable defaults"
  the user did not state.
- Dispatch tasks via \`dispatch_agent\`. Each dispatched task is automatically
  augmented with a clarification protocol so the specialist can bubble up questions.
- After each dispatch, INSPECT the result for ASK_USER questions (also surfaced in
  the result \`details.questions\`). For each one: call \`ask_user\` in ${userLanguage},
  then re-dispatch the specialist with the answer.`
			: `- BEFORE dispatching: if anything is ambiguous, missing, or could go several valid
  ways, STATE your assumption explicitly in ${userLanguage} and wait for the user
  to correct it. Never invent constraints or "reasonable defaults" silently.
- Dispatch tasks via \`dispatch_agent\`. Each dispatched task is automatically
  augmented with a clarification protocol so the specialist can bubble up questions.
- After each dispatch, INSPECT the result for ASK_USER questions (also surfaced in
  the result \`details.questions\`). For each one: relay it verbatim to the user
  in ${userLanguage} and wait for the reply before re-dispatching.`;

		const ambiguityRule = askUserAvailable
			? `- NEVER proceed past an ambiguity by guessing. Either call \`ask_user\`, or state
  the assumption explicitly in ${userLanguage} and say you'll proceed unless corrected.`
			: `- NEVER proceed past an ambiguity by guessing. State the assumption explicitly
  in ${userLanguage} and wait for the user to confirm or correct.`;

		const languageLines = askUserAvailable
			? `- ALWAYS communicate with the human user in **${userLanguage}**. Every message you
  write to the user, every \`ask_user\` question and \`context\` field — ${userLanguage}.
- Task strings you send via \`dispatch_agent\` stay in **English**. The specialist
  personas are written in English; do not translate task descriptions for them.
- When a specialist emits an \`ASK_USER:\` line in English, translate it to
  ${userLanguage} before passing it through \`ask_user\`.${userLanguage.toLowerCase() === "english" ? " (If user-language is English this is a no-op.)" : ""}`
			: `- ALWAYS communicate with the human user in **${userLanguage}**. Every message you
  write to the user is ${userLanguage}.
- Task strings you send via \`dispatch_agent\` stay in **English**. The specialist
  personas are written in English; do not translate task descriptions for them.
- When a specialist emits an \`ASK_USER:\` line in English, translate it to
  ${userLanguage} before relaying to the user.${userLanguage.toLowerCase() === "english" ? " (If user-language is English this is a no-op.)" : ""}`;

		// Peer section only when coms initialised. Decision G4: the coms_* tools are
		// already in the active tool surface when ready; here we just teach the
		// dispatcher how and when to reach for them.
		const comsSection = comsReady && identity
			? `
## Peer agents (coms)
You are ALSO a peer on the coms mesh — project "${identity.project}", name "${identity.name}". Beyond
your own team you can talk to the peers in your coms POOL — the agents shown in the pool widget:
- \`coms_list\` — discover the peers in your pool (names, models, live context usage). The pool is
  scoped to YOUR project and excludes private (explicit) peers. You CANNOT widen this — only the human
  can, with \`/coms --project <name>\` or \`/coms --all\`. Do not ask coms_list for other projects.
- \`coms_send\` returns a msg_id; then \`coms_await\` (blocking) or \`coms_get\` (poll) reads the reply.
  This lets you use a peer as an on-demand subagent: send a SELF-CONTAINED task, await it, and fold the
  result into your plan. A peer does NOT share your context — spell out everything it needs.
- Only peers in your pool are reachable. \`coms_send\`/\`/handoff\` to anyone outside it is refused. If
  you need a peer that is not in the pool, ASK THE HUMAN to widen scope (\`/coms --project\`/\`--all\`),
  then retry. Do not pass cross-project context to a peer unless the human approved that reach.
- Prefer \`dispatch_agent\`/\`spawn_research\` for in-team work; reach for coms when a task needs another
  STANDING agent already in your pool (a human-driven peer, a specialist outside this team).
- A peer can also address YOU as a subagent — answer an inbound coms prompt as a normal turn.
`
			: "";

		const orchestratorPrompt = `You are a dispatcher agent — an orchestrator. You coordinate specialist agents
to accomplish tasks. You do NOT have direct access to the codebase. You have ${toolList}.

## Language
${languageLines}

## Active Team: ${activeTeamName}
Members: ${teamMembers}
You can ONLY dispatch to agents listed below. Do not attempt to dispatch to agents
outside this team.

## How to Work
- Analyze the user's request and break it into clear sub-tasks.
- Choose the right agent(s) for each sub-task.
${dispatchSection}
- Review results and dispatch follow-up agents if needed.
- If a task fails, try a different agent or adjust the task description.
- Summarize the outcome for the user in ${userLanguage}.

${askUserBlock}

## Research helpers (read-only)
- \`spawn_research\` runs a READ-ONLY helper (read/grep/find/ls — no bash, no writes)
  and returns its findings to you inline. Use it for reconnaissance, code search, and
  reading docs/code BEFORE you dispatch a builder — or to fan out background research.
- Two flavours: pass \`persona\` to spawn one of the research personas listed below (it
  brings its own role/model); omit \`persona\` for an ad-hoc helper (optional \`model\`).
- Match the helper to the job: use a lighter/faster persona for simple reads and a
  higher-capability one for ambiguous, cross-cutting, or high-stakes research. Compare
  the **Model** / **Thinking** shown for each persona below and pick deliberately.
- Specialists you dispatch are sandboxed and CANNOT spawn their own helpers. When a
  specialist needs research help, YOU run \`spawn_research\`, collect the findings, and
  fold them into the specialist's task — do not ask the specialist to do it itself.
- Research helpers are ephemeral and read-only, so they are always safe to run.
${comsSection}
## Hard Rules
- NEVER try to read, write, or execute code directly — you have no such tools.
- ALWAYS use \`dispatch_agent\` to get work done; use \`spawn_research\` for read-only recon.
${ambiguityRule}
- You can chain agents: spawn_research to gather context, scout to explore, builder to implement.
- You can dispatch the same agent multiple times with different tasks.
- Keep tasks focused — one clear objective per dispatch.

## Agents

${agentCatalog}

## Research personas

${researchCatalog}`;

		// Flavor-only persona merge (decision 9 / G4): the dispatcher persona's body
		// goes FIRST, then the orchestration rules. The persona enriches the role; it
		// never replaces the orchestrator prompt and never narrows the tool surface.
		const systemPrompt = dispatcherPersona
			? `${dispatcherPersona.systemPrompt}\n\n${orchestratorPrompt}`
			: orchestratorPrompt;

		return { systemPrompt };
	});

	// ── Persona gate: block input until a dispatcher persona is picked ──
	pi.on("input", async (_event, ctx) => {
		if (personaGateEnabled && !personaGateSatisfied) {
			ctx.ui.notify("Pick a dispatcher persona first (see the select dialog).", "warning");
			return { action: "handled" as const };
		}
		return { action: "continue" as const };
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		// Clear widgets + any research helpers from a previous session
		for (const [, st] of Array.from(researchStates.entries())) {
			if (st.proc && st.status === "running") { st.killedByOperator = true; st.proc.kill("SIGTERM"); }
		}
		researchStates.clear();
		nextResearchId = 1;
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-team", undefined);
			widgetCtx.ui.setWidget("agent-research", undefined);
		}
		widgetCtx = _ctx;
		contextWindow = _ctx.model?.contextWindow || 0;
		damageControlExtPath = resolveDamageControlExtension(_ctx.cwd);
		if (!damageControlExtPath) {
			_ctx.ui.notify(
				"damage-control harness not found — specialists and research helpers will spawn UNGUARDED. Install .pi/harnesses/damage-control/ (guided setup pairs it with agent-hub).",
				"warning",
			);
		}

		// ── Embedded coms init ──
		// Always refresh the ctx the coms handlers use. Bind the endpoint + register
		// in the pool exactly once per process (guard on comsReady), so a /new session
		// keeps the same peer identity rather than leaking a second socket. On any
		// failure we degrade: comsReady stays false and the coms_* tools are withheld.
		currentCtx = _ctx;
		const soloMode = pi.getFlag("solo") === true;
		if (!comsReady && !soloMode) {
			try {
				const flags = readCliFlags(pi);
				const fm = readFrontmatterFromArgv(process.argv);
				const project = flags.project || "default";
				const explicit = flags.explicit === true;
				const session_id = ulid();
				const defaultName = `hub-${session_id.slice(-6)}`;
				const desiredName = flags.name || fm.name || defaultName;
				const name = resolveUniqueName(project, desiredName);
				if (name !== desiredName) {
					try { pi.appendEntry("coms-log", { event: "name_collision", desired: desiredName, assigned: name, project }); } catch { /* best-effort */ }
				}
				comsPurposeExplicit = !!flags.purpose;
				comsBasePurpose = flags.purpose || fm.description || "agent-hub dispatcher";
				const purpose = comsBasePurpose;

				// Color: --color CLI flag > frontmatter color > deterministic fallback.
				let color = fallbackColor(session_id);
				if (fm.color && isValidHex(fm.color)) color = fm.color;
				if (flags.color && isValidHex(flags.color)) color = flags.color;

				const endpoint = makeEndpoint(session_id);
				const cwd = _ctx.cwd || process.cwd();
				const model = _ctx.model?.id ?? "unknown";

				fs.mkdirSync(path.join(COMS_DIR, "projects", project, "agents"), { recursive: true });
				if (process.platform !== "win32") {
					fs.mkdirSync(path.join(COMS_DIR, "sockets"), { recursive: true });
					try { fs.chmodSync(COMS_DIR, 0o700); } catch { /* best-effort */ }
				}

				server = await bindEndpoint(endpoint, connHandler);

				const entry: RegistryEntry = {
					session_id, name, purpose, model, color,
					pid: process.pid, endpoint, cwd,
					started_at: nowIso(), explicit, version: 1,
				};
				const registryFile = writeRegistryAtomic(entry, project);

				identity = { session_id, name, purpose, color, project, explicit, cwd, model, endpoint, registryFile };
				includeExplicit = false;
				displayProject = project;
				comsReady = true;
				try { pi.appendEntry("coms-log", { event: "boot", session_id, name, project }); } catch { /* best-effort */ }

				try {
					_ctx.ui.setStatus("coms", `📡 ${name}@${project}`);
					installPoolWidget(_ctx);
				} catch { /* hasUI may be false — non-fatal */ }

				// Ping + keepalive cycles (unref'd so they never hold the process open).
				pingTimer = setInterval(() => { refreshPool().catch(() => {}); }, PING_INTERVAL_MS);
				try { (pingTimer as any).unref?.(); } catch { /* ignore */ }
				keepaliveTimer = setInterval(() => {
					if (!identity) return;
					try {
						const missingBeforeWrite = !fs.existsSync(identity.registryFile);
						writeLiveRegistry();
						if (missingBeforeWrite) {
							try { pi.appendEntry("coms-log", { event: "self_heal", session_id: identity.session_id, reason: "registry file missing" }); } catch { /* best-effort */ }
							if (!fs.existsSync(identity.registryFile)) writeLiveRegistry();
						}
					} catch { /* best-effort */ }
				}, KEEPALIVE_INTERVAL_MS);
				try { (keepaliveTimer as any).unref?.(); } catch { /* ignore */ }

				refreshPool().catch(() => {});
			} catch (err) {
				comsReady = false;
				try { _ctx.ui?.notify?.(`📡 coms: init failed — ${err instanceof Error ? err.message : String(err)} (coms tools disabled)`, "error"); } catch { /* ignore */ }
			}
		}

		// Wipe old agent session files so subagents start fresh
		const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		loadAgents(_ctx.cwd);

		// Load per-project overrides (user-facing language, persona gate).
		const overrides = parseAgentTeamOverrides(_ctx.cwd);
		userLanguage = overrides.language;

		// Dispatcher persona gate (Phase 6 / requirement 1). Orchestrator personas are
		// persona files tagged `kind: orchestrator` (decision G5 — keeps builder/scout
		// out of the dispatcher picker). The gate is enabled only when turned on AND at
		// least one orchestrator persona exists, so it never blocks with nothing to pick.
		orchestratorPersonas = allAgentDefs.filter(d => (d.kind || "").toLowerCase() === "orchestrator");
		// Research personas (kind: research) — spawnable read-only via spawn_research and
		// the /research command, independent of team membership.
		researchPersonas = allAgentDefs.filter(d => (d.kind || "").toLowerCase() === "research");
		dispatcherPersona = null;
		personaGateEnabled = overrides.personaGate && orchestratorPersonas.length > 0;
		personaGateSatisfied = !personaGateEnabled;

		// Default to first team — use /agents-team to switch
		const teamNames = Object.keys(teams);
		if (teamNames.length > 0) {
			activateTeam(teamNames[0]);
		}

		// Probe for `ask_user` (registered by the `pi-ask-user` companion package
		// when installed). Action methods like getAllTools are runtime-only, so
		// this MUST happen at session_start, not at extension load.
		askUserAvailable = pi.getAllTools().some(t => t.name === "ask_user");

		// Dispatcher's tool surface: dispatch_agent + spawn_research always; the coms_*
		// tools when the peer layer bound successfully; ask_user only when pi-ask-user is
		// installed. Per decision G4 the dispatcher persona NEVER narrows this surface.
		const dispatcherTools = ["dispatch_agent", "spawn_research"];
		if (comsReady) dispatcherTools.push("coms_list", "coms_send", "coms_get", "coms_await");
		if (askUserAvailable) dispatcherTools.push("ask_user");
		pi.setActiveTools(dispatcherTools);

		_ctx.ui.setStatus("agent-team", `Team: ${activeTeamName} (${agentStates.size})`);
		const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
		const askUserLabel = askUserAvailable
			? "available (via pi-ask-user)"
			: "NOT AVAILABLE — run `pi install npm:pi-ask-user`";
		const personaGateLabel = personaGateEnabled
			? `ON — pick an orchestrator persona to begin (${orchestratorPersonas.length} available)`
			: orchestratorPersonas.length === 0
				? "off (no `kind: orchestrator` personas found)"
				: "off (set `persona-gate: on` to enable)";
		const comsLabel = comsReady && identity
			? `📡 ${identity.name}@${identity.project} — peers via coms_list; /handoff <peer> to delegate`
			: soloMode
				? "off (--solo: fixed specialists + research only)"
				: "off (endpoint bind failed — coms tools disabled)";
		_ctx.ui.notify(
			`Team: ${activeTeamName} (${members})\n` +
			`Team sets loaded from: .pi/agents/teams.yaml\n` +
			`User-facing language: ${userLanguage} (override in .ai/agent-skills-overrides.md)\n` +
			`ask_user: ${askUserLabel}; specialists bubble up via ASK_USER:\n` +
			`Persona gate: ${personaGateLabel}\n` +
			`Coms: ${comsLabel}\n\n` +
			`/agents-team          Select a team\n` +
			`/agents-list          List active agents and status\n` +
			`/agents-grid <1-6>    Set grid column count\n` +
			`/agents-kill <name>   SIGTERM a frozen specialist\n` +
			`/agents-restart <name> Kill + re-run its last task fresh\n` +
			`/zoom <name|rN>       Scrollable read-only view of an agent's stream\n` +
			`/research <task>      Spawn a read-only research helper (@persona, --model)\n` +
			`/research-cont rN ... Resume a finished research helper\n` +
			`/research-rm rN       Remove a research helper (kill if running)\n` +
			`/research-clear       Remove all research helpers\n` +
			`/persona              Select/reset the dispatcher persona\n` +
			`/coms [--all|--project N] Refresh the coms peer pool\n` +
			`/handoff <peer>       Hand the session off to a coms peer`,
			"info",
		);
		_ctx.ui.setStatus("dispatcher-persona", personaGateEnabled ? "Persona: (pick one)" : "Persona: Default");
		updateWidget();

		// Fire the blocking persona gate (input stays swallowed until satisfied).
		if (personaGateEnabled) {
			void pickDispatcherPersona(_ctx);
		}

		// Footer: model | team | context bar
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", activeTeamName);
				const hint = theme.fg("muted", "Alt+A ") + theme.fg("dim", `view:${viewMode}`);
				const right = hint +
					theme.fg("muted", "  ·  ") +
					theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	});

	// ── Embedded coms: respond to inbound peer prompts at turn end ──
	// When this agent was addressed by a peer (an inbound prompt in the queue), the
	// turn's final assistant text becomes the response we ship back to the sender.
	pi.on("agent_end", async (_event, ctx) => {
		const inbound = [...inboundQueue.values()].reverse().find((i) => !i.fulfilled);
		if (!inbound || !identity) return;

		// Walk the session branch for the most recent assistant message text.
		let lastAssistantText = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const m = entry.message as any;
				if (typeof m.content === "string") {
					lastAssistantText = m.content;
				} else if (Array.isArray(m.content)) {
					lastAssistantText = m.content
						.filter((b: any) => b && b.type === "text")
						.map((b: any) => b.text)
						.join("\n");
				}
			}
		}

		let payload: any = lastAssistantText;
		let error: string | null = null;
		if (inbound.response_schema && typeof inbound.response_schema === "object") {
			try {
				payload = JSON.parse(lastAssistantText);
			} catch {
				error = "response not valid JSON";
				payload = null;
			}
		}

		const respEnv: ResponseEnvelope = {
			type: "response",
			msg_id: inbound.msg_id,
			sender_session: identity.session_id,
			sender_endpoint: identity.endpoint,
			hops: 0,
			timestamp: nowIso(),
			response: payload,
			error,
		};

		try {
			await sendEnvelope(inbound.sender_endpoint, respEnv);
			try {
				pi.appendEntry("coms-log", {
					event: "outbound_response",
					msg_id: inbound.msg_id,
					error,
				});
			} catch {
				// best-effort
			}
		} catch (e: any) {
			try {
				pi.appendEntry("coms-log", {
					event: "outbound_response_failed",
					msg_id: inbound.msg_id,
					reason: e?.message ?? String(e),
				});
			} catch {
				// best-effort
			}
		}

		inbound.fulfilled = true;
		inboundQueue.delete(inbound.msg_id);
		if (currentInbound && currentInbound.msg_id === inbound.msg_id) {
			currentInbound = null;
		}
	});

	// ── Embedded coms: clean shutdown ──
	// Tear down the coms layer (timers, server, registry, socket) and SIGTERM any
	// specialist/research children so they don't outlive the dispatcher.
	let shuttingDown = false;
	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (pingTimer) { try { clearInterval(pingTimer); } catch { /* ignore */ } pingTimer = null; }
		if (keepaliveTimer) { try { clearInterval(keepaliveTimer); } catch { /* ignore */ } keepaliveTimer = null; }
		if (server) {
			try { server.close(); } catch { /* ignore */ }
			server = null;
		}
		if (identity) {
			if (process.platform !== "win32") {
				try { fs.unlinkSync(identity.endpoint); } catch { /* ignore */ }
			}
			try { removeRegistryEntry(identity.project, identity.name); } catch { /* ignore */ }
			try {
				pi.appendEntry("coms-log", { event: "shutdown", session_id: identity.session_id });
			} catch { /* best-effort */ }
		}
		for (const st of agentStates.values()) {
			if (st.proc && st.status === "running") { try { st.killedByOperator = true; st.proc.kill("SIGTERM"); } catch { /* ignore */ } }
		}
		for (const st of researchStates.values()) {
			if (st.proc && st.status === "running") { try { st.killedByOperator = true; st.proc.kill("SIGTERM"); } catch { /* ignore */ } }
		}
		if (currentCtx?.hasUI) {
			try { currentCtx.ui.setWidget("coms-pool", undefined); } catch { /* ignore */ }
		}
	}

	pi.on("session_shutdown", async () => { await cleanShutdown(); });
	process.on("SIGINT", () => { void cleanShutdown(); });
	process.on("SIGTERM", () => { void cleanShutdown(); });
}
