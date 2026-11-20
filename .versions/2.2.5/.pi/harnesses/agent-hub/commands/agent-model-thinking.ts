import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";
import { THINKING_LEVELS } from "../config/overrides.ts";
import { displayName, resolveThinkingLevel } from "../presentation.ts";

export function registerAgentModelThinking(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agent-model-thinking", {
		description: "Switch a persona's thinking level from pi's --thinking levels: /af-agent-model-thinking <persona>",
		getArgumentCompletions: prefix => commandCtx.getAgentModelThinkingCompletions(prefix),
		handler: async (args, ctx) => {
			commandCtx.setWidgetContext(ctx);
			const { policy, activeAgents, getResearchPersonas, updateWidget } = commandCtx.modelCommands;
			const name = (args || "").trim().toLowerCase();
			// Team member (live state) OR a research persona — both switchable.
			const def = name ? policy.switchablePersonaDef(name) : undefined;
			if (!def) {
				const known = [
					...Array.from(activeAgents.values()).map(s => s.def.name),
					...getResearchPersonas().map(d => d.name),
				].join(", ");
				ctx.ui.notify(`Usage: /af-agent-model-thinking <persona>. Known: ${known || "none"}`, "error");
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
