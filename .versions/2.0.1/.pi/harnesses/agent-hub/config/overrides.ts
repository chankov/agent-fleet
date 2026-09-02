import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clampDelegateDepth, MAX_DELEGATE_DEPTH } from "../helpers.ts";
import { DEFAULT_RUN_HISTORY_KEEP, normalizeRunHistoryKeep } from "../run-namespace.js";
import { DEFAULT_WATCHDOG_SETTING, WATCHDOG_SETTINGS, normalizeWatchdogSetting } from "../drift-watchdog.js";
import { DEFAULT_RESEARCH_KEEP } from "../research/runtime.ts";
import { parseResearchKeep } from "../research-retention.js";
import type { SubagentRole } from "../types.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const VALID_THINKING_LEVELS = new Set<string>(THINKING_LEVELS);

export interface AgentTeamOverrides {
	language: string;
	personaModels: Record<string, string>;
	personaModelLists: Record<string, string[]>;
	personaThinking: Record<string, string>;
	personaSubagents: Record<string, Record<string, SubagentRole>>;
	personaDelegateDepth: Record<string, number>;
	rulesDirs: string[];
	docsPaths: string[];
	researchKeep: number;
	reconSearchTimeoutMs: number | null;
	budgetOverrides: { maxDispatches?: number | null; maxResearch?: number | null; wallMs?: number | null; agentTurnMs?: number | null; recycleRuns?: number | null };
	watchdogSetting: string;
	watchdogJudgeModel: string | null;
	runHistoryKeep: number | null;
	warnings: string[];
}

export const DEFAULT_OVERRIDES: AgentTeamOverrides = {
	language: "English", personaModels: {}, personaModelLists: {}, personaThinking: {}, personaSubagents: {}, personaDelegateDepth: {},
	rulesDirs: [], docsPaths: [], researchKeep: DEFAULT_RESEARCH_KEEP, reconSearchTimeoutMs: 120_000, budgetOverrides: {},
	watchdogSetting: DEFAULT_WATCHDOG_SETTING, watchdogJudgeModel: null, runHistoryKeep: DEFAULT_RUN_HISTORY_KEEP, warnings: [],
};

function freshOverrides(): AgentTeamOverrides {
	return { ...DEFAULT_OVERRIDES, personaModels: {}, personaModelLists: {}, personaThinking: {}, personaSubagents: {}, personaDelegateDepth: {}, rulesDirs: [], docsPaths: [], budgetOverrides: {}, warnings: [] };
}

export function parseAgentTeamOverrides(cwd: string): AgentTeamOverrides {
	const file = join(cwd, ".ai", "agent-fleet-overrides.md");
	if (!existsSync(file)) return freshOverrides();
	let raw: string;
	try { raw = readFileSync(file, "utf-8"); } catch { return freshOverrides(); }
	const result = freshOverrides();
	let inSection = false;
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) { const name = heading[1].trim().toLowerCase(); inSection = name === "agent-hub" || name === "agent-team"; continue; }
		if (!inSection) continue;
		const pair = line.match(/^\s*([a-zA-Z][\w.-]*)\s*:\s*(.+?)\s*$/);
		if (!pair) continue;
		const key = pair[1].toLowerCase();
		const value = pair[2].trim();
		if (key === "language" && value) result.language = value;
		if (key === "rules" && value) result.rulesDirs = value.split(",").map(s => s.trim()).filter(Boolean);
		if (key === "docs" && value) result.docsPaths = value.split(",").map(s => s.trim()).filter(Boolean);
		if (key === "run-history-keep" && value) {
			const keep = normalizeRunHistoryKeep(value);
			if (keep === undefined) result.warnings.push(`run-history-keep "${value}" is not a positive integer or "off" — using the default (${DEFAULT_RUN_HISTORY_KEEP})`);
			else result.runHistoryKeep = keep;
		}
		if (key === "research-keep" && value) {
			const keep = parseResearchKeep(value);
			if (keep != null) result.researchKeep = keep;
			else result.warnings.push(`research-keep "${value}" is not a non-negative integer or "all" — using the default (${DEFAULT_RESEARCH_KEEP})`);
		}
		if (key === "recon-search-timeout-s" && value) {
			if (value.toLowerCase() === "off") result.reconSearchTimeoutMs = null;
			else if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 3600) result.reconSearchTimeoutMs = Number(value) * 1000;
			else result.warnings.push(`recon-search-timeout-s "${value}" is not an integer from 1 to 3600 or "off" — using the default (120)`);
		}
		if (key === "mode" && value) result.warnings.push(`mode "${value}" is ignored — execution modes were removed; budgets follow task tier. Remove this key.`);
		if (key === "watchdog" && value) {
			const setting = normalizeWatchdogSetting(value);
			if (setting) result.watchdogSetting = setting;
			else result.warnings.push(`watchdog "${value}" is not one of ${WATCHDOG_SETTINGS.join("|")} — using the default (${DEFAULT_WATCHDOG_SETTING})`);
		}
		if (key === "watchdog-judge-model" && value) result.watchdogJudgeModel = value;
		const budgetKeys: Record<string, { field: keyof AgentTeamOverrides["budgetOverrides"]; scaleMs: boolean }> = {
			"max-dispatches-per-turn": { field: "maxDispatches", scaleMs: false }, "max-research-per-turn": { field: "maxResearch", scaleMs: false },
			"turn-wall-time-s": { field: "wallMs", scaleMs: true }, "agent-turn-timeout-s": { field: "agentTurnMs", scaleMs: true }, "session-recycle-runs": { field: "recycleRuns", scaleMs: false },
		};
		if (budgetKeys[key] && value) {
			const { field, scaleMs } = budgetKeys[key];
			if (value.toLowerCase() === "off") result.budgetOverrides[field] = null;
			else if (/^\d+$/.test(value) && Number(value) >= 1) result.budgetOverrides[field] = Number(value) * (scaleMs ? 1000 : 1);
			else result.warnings.push(`${key} "${value}" is not a positive integer or "off" — using the task-tier default`);
		}
		const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
		const model = key.match(new RegExp(`^model\\.(${slug})$`));
		if (model && value) result.personaModels[model[1]] = value;
		const models = key.match(new RegExp(`^models\\.(${slug})$`));
		if (models && value) result.personaModelLists[models[1]] = value.split(",").map(s => s.trim()).filter(Boolean);
		const thinking = key.match(new RegExp(`^thinking\\.(${slug})$`));
		if (thinking && value) {
			const level = value.toLowerCase();
			if (VALID_THINKING_LEVELS.has(level)) result.personaThinking[thinking[1]] = level;
			else result.warnings.push(`thinking.${thinking[1]} "${value}" is not a valid level (off|minimal|low|medium|high|xhigh) — ignored`);
		}
		const subagent = key.match(new RegExp(`^subagents\\.(${slug})\\.(${slug})$`));
		if (subagent && value) {
			const parsed = value.match(/^(\S+?)(?:\s*,\s*tools\s*=\s*([\w,-]+))?$/);
			if (parsed) (result.personaSubagents[subagent[1]] ||= {})[subagent[2]] = { model: parsed[1], ...(parsed[2] ? { tools: parsed[2] } : {}) };
		}
		const depth = key.match(new RegExp(`^delegate-depth\\.(${slug})$`));
		if (depth && value) {
			const count = Number(value);
			if (Number.isInteger(count) && count >= 0) {
				result.personaDelegateDepth[depth[1]] = clampDelegateDepth(count);
				if (count > MAX_DELEGATE_DEPTH) result.warnings.push(`delegate-depth.${depth[1]} ${count} exceeds the maximum (${MAX_DELEGATE_DEPTH}) — clamped to ${MAX_DELEGATE_DEPTH}`);
			}
		}
	}
	return result;
}
