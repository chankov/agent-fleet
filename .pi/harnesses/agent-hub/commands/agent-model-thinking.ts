import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";
import { THINKING_LEVELS } from "../config/overrides.ts";
import { displayName, resolveThinkingLevel } from "../presentation.ts";
import { isPracticeId, normalizePracticeInput, PRACTICE_IDS } from "../config/practices.ts";

export function registerAgentModelThinking(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agent-model-thinking", {
		description: "Switch a role's or practice's thinking level from pi's --thinking levels: /af-agent-model-thinking <role>[.<practice>]",
		getArgumentCompletions: prefix => commandCtx.getAgentModelThinkingCompletions(prefix),
		handler: async (args, ctx) => {
			commandCtx.setWidgetContext(ctx);
			const { policy, activeAgents, getResearchPersonas, updateWidget } = commandCtx.modelCommands;
			const arg = (args || "").trim().toLowerCase();
			const dot = arg.indexOf(".");
			const name = dot >= 0 ? arg.slice(0, dot) : arg;
			// <role>.<practice> targets the practice-level thinking (D9).
			const practice = dot >= 0 ? normalizePracticeInput(arg.slice(dot + 1)) : undefined;
			// Team member (live state) OR a research persona — both switchable.
			const def = name ? policy.switchablePersonaDef(name) : undefined;
			if (!def || (practice !== undefined && !isPracticeId(practice))) {
				const known = [
					...Array.from(activeAgents.values()).map(s => s.def.name),
					...getResearchPersonas().map(d => d.name),
				].join(", ");
				ctx.ui.notify(`Usage: /af-agent-model-thinking <role>[.<practice>]. Known: ${known || "none"}. Practices: ${PRACTICE_IDS.join(", ")}`, "error");
				return;
			}
			if (practice) {
				const label = `${displayName(def.name)}.${practice}`;
				const fallbackLevel = resolveThinkingLevel(policy.practiceDefault(def, practice).thinking);
				const currentLevel = resolveThinkingLevel(policy.resolvedThinking(def, [practice]));
				const practiceLevels = [...THINKING_LEVELS];
				const practiceOptions = practiceLevels.map(l => {
					const tags = [l === fallbackLevel ? "default" : "", l === currentLevel ? "current" : ""].filter(Boolean);
					return tags.length ? `${l} (${tags.join(", ")})` : l;
				});
				const practiceChoice = await ctx.ui.select(`Thinking level for ${label}`, practiceOptions);
				if (practiceChoice === undefined) return;
				const pickedLevel = practiceLevels[practiceOptions.indexOf(practiceChoice)];
				if (pickedLevel === currentLevel) {
					ctx.ui.notify(`${label} is already on thinking: ${pickedLevel}`, "info");
					return;
				}
				policy.setPracticeThinkingOverride(def.name, practice, pickedLevel === fallbackLevel ? undefined : pickedLevel);
				updateWidget();
				ctx.ui.notify(`${label} thinking → ${pickedLevel} (applies on the next ${def.name} assignment whose first practice with a model choice is ${practice})`, "info");
				return;
			}
			const defaultLevel = resolveThinkingLevel(def.thinking);
			const current = resolveThinkingLevel(policy.resolvedThinking(def));
			const levels = [...THINKING_LEVELS];
			const options = levels.map(l => {
				const tags = [l === defaultLevel ? "default" : "", l === current ? "current" : ""].filter(Boolean);
				return tags.length ? `${l} (${tags.join(", ")})` : l;
			});
			const choice = await ctx.ui.select(`Thinking level for ${displayName(def.name)}`, options);
			if (choice === undefined) return;
			const picked = levels[options.indexOf(choice)];
			if (picked === current) {
				ctx.ui.notify(`${displayName(def.name)} is already on thinking: ${picked}`, "info");
				return;
			}
			if (picked === defaultLevel) {
				policy.setThinkingOverride(name, undefined);
			} else {
				policy.setThinkingOverride(name, picked);
			}
			updateWidget();
			// Research helpers spawn fresh each time, so the switch lands on their
			// next spawn; team members apply on next dispatch (restartable now).
			const applyHint = (def.kind || "").toLowerCase() === "research"
				? "applies on next spawn_research"
				: `applies on next dispatch; /af-agents-restart ${def.name} to apply now`;
			ctx.ui.notify(`${displayName(def.name)} thinking → ${picked} (${applyHint})`, "info");
		},
	});
}
