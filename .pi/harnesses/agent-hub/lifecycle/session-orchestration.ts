import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyModelOverride } from "../helpers.ts";
import type { AgentTeamOverrides } from "../config/overrides.ts";
import type { AgentDef } from "../types.ts";
import { registerSessionStart, type SessionStartDependencies } from "../session-start.ts";

export interface SessionResetPorts {
	registerVersion(ctx: ExtensionContext): void;
	resetPressure(ctx: ExtensionContext): void;
	clearRosterRecovery(): void;
	captureBaselineTools(): void;
	resetAccessApproval(): void;
	terminateResearch(): void;
	resetResearch(): void;
	resetHistory(): void;
	resetBudgets(): void;
	clearWidgets(ctx: ExtensionContext): void;
	closeDelegationWatchers(): void;
	resetSessionState(ctx: ExtensionContext): void;
	resolveSafety(cwd: string): boolean;
	resolveDelegate(cwd: string): void;
}

export function resetHubSession(ctx: ExtensionContext, ports: SessionResetPorts): void {
	ports.registerVersion(ctx);
	ports.resetPressure(ctx);
	ports.clearRosterRecovery();
	ports.captureBaselineTools();
	ports.resetAccessApproval();
	ports.terminateResearch();
	ports.resetResearch();
	ports.resetHistory();
	ports.resetBudgets();
	ports.clearWidgets(ctx);
	ports.closeDelegationWatchers();
	ports.resetSessionState(ctx);
	if (!ports.resolveSafety(ctx.cwd)) ctx.ui.notify("damage-control-continue harness not found — native child dispatches will be refused. Install .pi/harnesses/damage-control-continue/.", "error");
	ports.resolveDelegate(ctx.cwd);
}

export interface SessionOverridePorts<TDef extends AgentDef> {
	setLanguage(value: string): void;
	setResearchRetention(value: number): void;
	setReconTimeout(value: number | null): void;
	setBudgetOverrides(value: AgentTeamOverrides["budgetOverrides"]): void;
	setWatchdog(setting: string, judgeModel: string | null): void;
	resetTurnCounts(): void;
	resetTaskWindow(): void;
	updateModeStatus(): void;
	setProjectRules(value: string[]): void;
	setProjectDocs(value: string[]): void;
	resetModelPolicy(): void;
	getAgentDefs(): TDef[];
	getModelProfiles(): Record<string, Record<string, string>>;
	deleteModelProfile(name: string): void;
	allowedModels(def: TDef): string[];
	getDispatchPolicyWarnings(): string[];
	setResearchPersonas(value: TDef[]): void;
}

export function applySessionOverrides<TDef extends AgentDef>(ctx: ExtensionContext, overrides: AgentTeamOverrides, ports: SessionOverridePorts<TDef>): void {
	ports.setLanguage(overrides.language);
	ports.setResearchRetention(overrides.researchKeep);
	ports.setReconTimeout(overrides.reconSearchTimeoutMs);
	ports.setBudgetOverrides(overrides.budgetOverrides);
	ports.setWatchdog(overrides.watchdogSetting, overrides.watchdogJudgeModel);
	ports.resetTurnCounts();
	ports.resetTaskWindow();
	ports.updateModeStatus();
	if (overrides.warnings.length) ctx.ui.notify(`agent-fleet-overrides warnings:\n${overrides.warnings.join("\n")}`, "warning");
	ports.setProjectRules(overrides.rulesDirs);
	for (const dir of overrides.rulesDirs) if (!existsSync(join(ctx.cwd, dir))) ctx.ui.notify(`agent-fleet-overrides: rules folder "${dir}" not found in ${ctx.cwd}`, "warning");
	ports.setProjectDocs(overrides.docsPaths);
	for (const entry of overrides.docsPaths) if (!existsSync(join(ctx.cwd, entry))) ctx.ui.notify(`agent-fleet-overrides: docs entry point "${entry}" not found in ${ctx.cwd}`, "warning");

	ports.resetModelPolicy();
	const defs = ports.getAgentDefs();
	for (const def of defs) {
		const lower = def.name.toLowerCase();
		if (overrides.personaModels[lower]) Object.assign(def, applyModelOverride(def, overrides.personaModels[lower]));
		if (overrides.personaModelLists[lower]) def.models = overrides.personaModelLists[lower];
		if (overrides.personaThinking[lower]) def.thinking = overrides.personaThinking[lower];
		const substitutions = overrides.personaSubagents[lower];
		if (substitutions) {
			def.subagents = { ...(def.subagents || {}) };
			for (const [role, replacement] of Object.entries(substitutions)) {
				const declared = def.subagents[role];
				def.subagents[role] = declared
					? applyModelOverride({ ...declared, ...(replacement.tools ? { tools: replacement.tools } : {}) }, replacement.model)
					: replacement;
			}
		}
		if (overrides.personaDelegateDepth[lower] !== undefined) def.delegateDepth = overrides.personaDelegateDepth[lower];
	}

	const profileErrors: string[] = [];
	for (const [profileName, entries] of Object.entries(ports.getModelProfiles())) {
		for (const [persona, model] of Object.entries(entries)) {
			const def = defs.find(candidate => candidate.name.toLowerCase() === persona);
			if (!def) profileErrors.push(`profile "${profileName}": unknown persona "${persona}"`);
			else if (!ports.allowedModels(def).includes(model)) profileErrors.push(`profile "${profileName}": ${persona} does not declare ${model} (model:/af-models: in ${def.file})`);
		}
	}
	if (profileErrors.length) {
		const dropped = new Set(profileErrors.map(error => error.match(/^profile "([^"]+)"/)![1]));
		for (const name of dropped) ports.deleteModelProfile(name);
		ctx.ui.notify(`model-profiles.yaml: dropped ${Array.from(dropped).map(name => `"${name}"`).join(", ")}:\n${profileErrors.join("\n")}`, "error");
	}
	const policyWarnings = ports.getDispatchPolicyWarnings();
	if (policyWarnings.length) ctx.ui.notify(`dispatch-policy.yaml: ${policyWarnings.length} construct(s) dropped:\n${policyWarnings.join("\n")}`, "warning");
	ports.setResearchPersonas(defs.filter(def => (def.kind || "").toLowerCase() === "research"));
}

export interface ShutdownPorts {
	shutdownComs(): Promise<void>;
	shutdownMonitor(): Promise<void>;
	removeExemptions(): void;
	terminateChildren(): void;
	clearPoolWidget(): void;
}

export function registerSessionOrchestration(pi: ExtensionAPI, steps: SessionStartDependencies, shutdown: ShutdownPorts): void {
	registerSessionStart(pi, steps);
	let shuttingDown = false;
	const cleanShutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		await shutdown.shutdownComs();
		await shutdown.shutdownMonitor();
		shutdown.removeExemptions();
		shutdown.terminateChildren();
		shutdown.clearPoolWidget();
	};
	pi.on("session_shutdown", cleanShutdown);
	process.on("SIGINT", () => { void cleanShutdown(); });
	process.on("SIGTERM", () => { void cleanShutdown(); });
}
