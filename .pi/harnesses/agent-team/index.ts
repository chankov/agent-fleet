/**
 * Agent Team — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary Pi agent has NO codebase tools. It can ONLY delegate work
 * to specialist agents via the `dispatch_agent` tool. Each specialist
 * maintains its own Pi session for cross-invocation memory.
 *
 * Loads agent definitions from agents/*.md, .claude/agents/*.md, .pi/agents/*.md.
 * Teams are defined in .pi/agents/teams.yaml — on boot a select dialog lets
 * you pick which team to work with. Only team members are available for dispatch.
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
 *
 * Usage: pi -e extensions/agent-team.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme as getPiMdTheme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	Text, Box, Container, Spacer, Markdown, matchesKey, Key,
	type AutocompleteItem, truncateToWidth, visibleWidth,
} from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "child_process";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, resolve } from "path";

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

	constructor(
		private state: Zoomable,
		private onDone: () => void,
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
		} else if (matchesKey(data, Key.escape)) {
			this.onDone();
			return;
		}
		tui.requestRender();
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
		// stream grows, until the user scrolls up.
		if (this.followTail && items.length > 0) this.selectedIndex = items.length - 1;
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
			const isExpanded = absoluteIndex === this.expandedIndex;

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
		container.addChild(new Text(theme.fg("dim", " ↑/↓ Navigate • Enter Expand • Esc Close • live"), 1, 0));
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

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
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
	let widgetCtx: any;
	let sessionDir = "";
	let contextWindow = 0;
	let userLanguage: string = DEFAULT_OVERRIDES.language;

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

	function renderCard(state: AgentState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "running" ? "●"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));
		const nameVisible = Math.min(name.length, w);

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr);
		const statusVisible = statusStr.length + timeStr.length;

		// Context bar: 5 blocks + percent
		const filled = Math.ceil(state.contextPct / 20);
		const bar = "#".repeat(filled) + "-".repeat(5 - filled);
		const ctxStr = `[${bar}] ${Math.ceil(state.contextPct)}%`;
		const ctxLine = theme.fg("dim", ctxStr);
		const ctxVisible = ctxStr.length;

		// Model line: short model id when the persona declares its own, else the
		// dispatcher's. Lets the operator spot a member running on a stronger/cheaper
		// model at a glance (e.g. reviewer on opus, implementers on a cheap default).
		const modelShort = state.def.model ? state.def.model.split("/").pop()! : "default";
		const modelStr = `model: ${modelShort}`;
		const modelText = truncate(modelStr, w - 1);
		const modelLine = theme.fg("dim", modelText);
		const modelVisible = modelText.length;

		const workRaw = state.task
			? (state.lastWork || state.task)
			: state.def.description;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = workText.length;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

		return [
			theme.fg("dim", top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + ctxLine, 1 + ctxVisible),
			border(" " + modelLine, 1 + modelVisible),
			border(" " + workLine, 1 + workVisible),
			theme.fg("dim", bot),
		];
	}

	// A research-helper card. Mirrors renderCard's box drawing but with a research
	// identity line (`rN` handle + persona/anon label + turn) and a read-only marker
	// in place of the context bar, so helpers read as visibly distinct from the team.
	function renderResearchCard(state: ResearchState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "running" ? "●"
			: state.status === "done" ? "✓" : "✗";

		const label = state.persona ? displayName(state.def.name) : "research";
		const turnStr = state.turnCount > 1 ? ` ·T${state.turnCount}` : "";
		const nameRaw = `r${state.id} ${label}${turnStr}`;
		const nameStr = theme.fg("accent", theme.bold(truncate(nameRaw, w)));
		const nameVisible = Math.min(nameRaw.length, w);

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr);
		const statusVisible = statusStr.length + timeStr.length;

		const modelShort = state.model ? state.model.split("/").pop()! : "default";
		const metaStr = `read-only · ${modelShort}`;
		const metaText = truncate(metaStr, w - 1);
		const metaLine = theme.fg("dim", metaText);
		const metaVisible = metaText.length;

		const workRaw = state.lastWork || state.task || state.def.description;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = workText.length;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

		return [
			theme.fg("dim", top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + metaLine, 1 + metaVisible),
			border(" " + workLine, 1 + workVisible),
			theme.fg("dim", bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
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
							cards.push(Array(7).fill(" ".repeat(colWidth)));
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
							cards.push(Array(6).fill(" ".repeat(colWidth)));
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
answers. Do not invent values, do not pick "reasonable defaults" silently — ask.`;

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

				const result = await dispatchAgent(agent, task, ctx);

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

				return {
					content: [{ type: "text", text: `${summary}${questionsNotice}\n\n${truncated}` }],
					details: {
						agent,
						task,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						fullOutput: result.output,
						questions,
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
				const ui = new ZoomUI(target, () => done(undefined));
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
				return;
			}
			const idx = options.indexOf(choice) - 1;
			dispatcherPersona = orchestratorPersonas[idx] || null;
			// Flavor-only — never narrows tools (decision G4).
			ctx.ui.setStatus("dispatcher-persona", `Persona: ${displayName(dispatcherPersona!.name)}`);
			ctx.ui.notify(`Dispatcher persona: ${displayName(dispatcherPersona!.name)}`, "success");
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
				.map(d => `### ${displayName(d.name)}\n**Spawn as:** \`spawn_research(persona: "${d.name}")\`\n${d.description}`)
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
- Specialists you dispatch are sandboxed and CANNOT spawn their own helpers. When a
  specialist needs research help, YOU run \`spawn_research\`, collect the findings, and
  fold them into the specialist's task — do not ask the specialist to do it itself.
- Research helpers are ephemeral and read-only, so they are always safe to run.

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

		// Dispatcher's tool surface: dispatch_agent + spawn_research always; ask_user only
		// when pi-ask-user is installed. Per decision G4 the dispatcher persona NEVER narrows this surface.
		const dispatcherTools = ["dispatch_agent", "spawn_research"];
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
		_ctx.ui.notify(
			`Team: ${activeTeamName} (${members})\n` +
			`Team sets loaded from: .pi/agents/teams.yaml\n` +
			`User-facing language: ${userLanguage} (override in .ai/agent-skills-overrides.md)\n` +
			`ask_user: ${askUserLabel}; specialists bubble up via ASK_USER:\n` +
			`Persona gate: ${personaGateLabel}\n\n` +
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
			`/persona              Select/reset the dispatcher persona`,
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
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	});
}
