import { parseModelProfiles, type ModelProfiles } from './model-profiles.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTeamsYaml, safePathWithin } from "../helpers.ts";
import { parseDispatchPolicy } from "../backend-policy.js";
import { clampDelegateDepth, MAX_DELEGATE_DEPTH, safeAgentKey } from "../helpers.ts";
import type { AgentDef, SubagentRole } from "../types.ts";
import { normalizeThinkingLevel } from "./overrides.ts";

function parseInlineSubagentRole(value: string): { model?: string; tools?: string; thinking?: string } {
	const input = value.trim();
	if (!input) return {};
	if (input.startsWith("{")) {
		const model = input.match(/model\s*:\s*([^\s,}]+)/)?.[1];
		const tools = input.match(/tools\s*:\s*([\w,-]+)/)?.[1];
		const thinking = input.match(/thinking\s*:\s*([^\s,}]+)/)?.[1];
		return { ...(model ? { model } : {}), ...(tools ? { tools } : {}), ...(thinking ? { thinking } : {}) };
	}
	return { model: input };
}

export function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;
		const frontmatter: Record<string, string> = {};
		const lists: Record<string, string[]> = {};
		const warnings: string[] = [];
		let subagents: Record<string, SubagentRole> | undefined;
		const lines = match[1].split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const idx = line.indexOf(":");
			if (idx <= 0) continue;
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			if (key === "subagents") {
				const entries: Record<string, { model?: string; tools?: string; thinking?: string }> = {};
				let currentRole: string | null = null;
				let roleIndent = -1;
				let j = i + 1;
				while (j < lines.length) {
					const found = lines[j].match(/^(\s+)([a-z0-9]+(?:-[a-z0-9]+)*)\s*:\s*(.*)$/);
					if (!found) break;
					const indent = found[1].length;
					if (roleIndent === -1) roleIndent = indent;
					if (indent < roleIndent) break;
					if (indent === roleIndent) {
						currentRole = found[2];
						entries[currentRole] = parseInlineSubagentRole(found[3]);
					} else if (currentRole) {
						const nested = found[3].trim();
						if (found[2] === "model" && nested) entries[currentRole].model = nested;
						else if (found[2] === "tools" && nested) entries[currentRole].tools = nested;
						else if (found[2] === "thinking" && nested) entries[currentRole].thinking = nested;
					}
					j++;
				}
				i = j - 1;
				const roles: Record<string, SubagentRole> = {};
				for (const [role, entry] of Object.entries(entries)) {
					if (!entry.model) { warnings.push(`subagents role "${role}" declares no model — skipped`); continue; }
					let thinking: string | undefined;
					if (entry.thinking) {
						const normalized = normalizeThinkingLevel(entry.thinking);
						if (normalized.warning) warnings.push(`subagents role "${role}" ${normalized.warning}`);
						else thinking = normalized.level;
					}
					roles[role] = { model: entry.model, ...(entry.tools ? { tools: entry.tools } : {}), ...(thinking ? { thinking } : {}) };
				}
				if (Object.keys(roles).length) subagents = roles;
				continue;
			}
			if (value) { frontmatter[key] = value; continue; }
			const items: string[] = [];
			let j = i + 1;
			while (j < lines.length) {
				const item = lines[j].match(/^\s+-\s+(.+)$/);
				if (!item) break;
				items.push(item[1].trim());
				j++;
			}
			if (items.length) { lists[key] = items; i = j - 1; }
		}
		if (!frontmatter.name) return null;
		try { safeAgentKey(frontmatter.name); } catch { return null; }
		let delegateDepth: number | undefined;
		if (frontmatter.delegate_depth !== undefined) {
			const depth = Number(frontmatter.delegate_depth);
			if (Number.isInteger(depth) && depth >= 0) {
				delegateDepth = clampDelegateDepth(depth);
				if (depth > MAX_DELEGATE_DEPTH) warnings.push(`delegate_depth "${frontmatter.delegate_depth}" exceeds the maximum (${MAX_DELEGATE_DEPTH}) — clamped to ${MAX_DELEGATE_DEPTH}`);
			} else warnings.push(`delegate_depth "${frontmatter.delegate_depth}" is not a non-negative integer — using default (1)`);
		}
		return {
			name: frontmatter.name, description: frontmatter.description || "", tools: frontmatter.tools || "read,grep,find,ls",
			model: frontmatter.model || undefined, models: lists.models, subagents, delegateDepth,
			warnings: warnings.length ? warnings : undefined, kind: frontmatter.kind || undefined,
			thinking: frontmatter.thinking || undefined, systemPrompt: match[2].trim(), file: filePath,
		};
	} catch { return null; }
}

export function parseModelProfilesYaml(raw: string): ModelProfiles {
	const result = parseModelProfiles(raw);
	if(result.errors.length) throw new Error(result.errors.join('\n'));
	return result.profiles;
}

export interface AgentConfigurationPorts {
	setSessionDir(value: string): void;
	getSessionDir(): string;
	archivePreviousRun(): void;
	ensureArtifactsLayout(): void;
	resetAssertions(): void;
	setAgentDefs(value: AgentDef[]): void;
	setTeams(value: Record<string, string[]>): void;
	setModelProfiles(value: ModelProfiles): void;
	setModelProfileErrors?(errors: string[]): void;
	setDispatchPolicy(value: any): void;
	setDispatchPolicyWarnings(value: string[]): void;
}

export function loadAgentConfiguration(cwd: string, ports: AgentConfigurationPorts): void {
	ports.setSessionDir(safePathWithin(cwd, ".pi", "agent-sessions"));
	const sessionDir = ports.getSessionDir();
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
	for (const directory of ["findings", "delegations", "transcripts"]) {
		try { rmSync(safePathWithin(sessionDir, directory), { recursive: true, force: true }); } catch {}
	}
	ports.archivePreviousRun();
	ports.ensureArtifactsLayout();
	try { rmSync(safePathWithin(sessionDir, "assertions.json"), { force: true }); } catch {}
	ports.resetAssertions();
	const defs = scanAgentDirs(cwd);
	ports.setAgentDefs(defs);
	const teamsPath = join(cwd, ".pi", "agents", "teams.yaml");
	let teams: Record<string, string[]> = {};
	if (existsSync(teamsPath)) try { teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8")); } catch {}
	if (!Object.keys(teams).length) teams = { all: defs.map(def => def.name) };
	ports.setTeams(teams);
	const profilesPath = join(cwd, ".pi", "agents", "model-profiles.yaml");
	let profiles: ModelProfiles = {};
	ports.setModelProfileErrors?.([]);
	if (existsSync(profilesPath)) {
		try { const parsed=parseModelProfiles(readFileSync(profilesPath, 'utf8'));profiles=parsed.profiles;ports.setModelProfileErrors?.(parsed.errors); }
		catch(error) { ports.setModelProfileErrors?.([String(error)]); }
	}
	ports.setModelProfiles(profiles);
	const policyPath = join(cwd, ".pi", "agents", "dispatch-policy.yaml");
	ports.setDispatchPolicy({ default: "native", grace_s: 30, substitutions: {} });
	ports.setDispatchPolicyWarnings([]);
	if (existsSync(policyPath)) {
		try {
			const parsed = parseDispatchPolicy(readFileSync(policyPath, "utf-8"));
			ports.setDispatchPolicy(parsed.policy);
			ports.setDispatchPolicyWarnings(parsed.warnings);
		} catch (error) {
			ports.setDispatchPolicyWarnings([`dispatch-policy.yaml unreadable: ${error instanceof Error ? error.message : String(error)}`]);
		}
	}
}

export function scanAgentDirs(cwd: string): AgentDef[] {
	const agents: AgentDef[] = [];
	const seen = new Set<string>();
	for (const dir of [join(cwd, "agents"), join(cwd, ".claude", "agents"), join(cwd, ".pi", "agents")]) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const def = parseAgentFile(resolve(dir, file));
				if (def && !seen.has(def.name.toLowerCase())) { seen.add(def.name.toLowerCase()); agents.push(def); }
			}
		} catch {}
	}
	return agents;
}
