import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";
import { displayName } from "../presentation.ts";

export function registerAgentModel(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-agent-model", {
		description: "Switch a persona's or sub-role's model from its declared candidates: /af-agent-model <persona>[.<role>]",
		getArgumentCompletions: prefix => commandCtx.getAgentModelCompletions(prefix),
		handler: async (args, ctx) => {
			commandCtx.setWidgetContext(ctx);
			const { policy, activeAgents, getResearchPersonas, updateWidget, prefersComs } = commandCtx.modelCommands;
			const arg = (args || "").trim().toLowerCase();

			// Dot form: <persona>.<role> targets a delegate sub-role. Candidates are
			// the role's declared model (default) + the parent's candidate list.
			if (arg.includes(".")) {
				const dot = arg.indexOf(".");
				const personaName = arg.slice(0, dot);
				const roleName = arg.slice(dot + 1);
				const parent = activeAgents.get(personaName);
				const roles = parent?.def.subagents || {};
				const roleKey = Object.keys(roles).find(r => r.toLowerCase() === roleName);
				if (!parent || !roleKey) {
					const valid = Array.from(activeAgents.values()).flatMap(s =>
						Object.keys(s.def.subagents || {}).map(r => `${s.def.name}.${r}`));
					ctx.ui.notify(
						`No sub-role "${arg}". Valid targets: ${valid.join(", ") || "none (no persona declares subagents:)"}`,
						"error",
					);
					return;
				}
				const role = roles[roleKey];
				const candidates: string[] = [];
				for (const m of [role.model, ...policy.allowedModels(parent.def)]) {
					if (m && !candidates.includes(m)) candidates.push(m);
				}
				const current = policy.resolvedSubagentModel(parent.def.name, roleKey, role.model);
				const options = candidates.map(m => {
					const tags = [m === role.model ? "default" : "", m === current ? "current" : ""].filter(Boolean);
					return tags.length ? `${m} (${tags.join(", ")})` : m;
				});
				const label = `${displayName(parent.def.name)}.${roleKey}`;
				const choice = await ctx.ui.select(`Model for ${label}`, options);
				if (choice === undefined) return;
				const picked = candidates[options.indexOf(choice)];
				const effectivePicked = policy.substitutedModel(picked) ?? picked;
				if (effectivePicked === current) {
					ctx.ui.notify(`${label} is already on ${effectivePicked}`, "info");
					return;
				}
				if (picked === role.model) {
					policy.setSubagentOverride(personaName, roleKey, undefined);
				} else {
					policy.setSubagentOverride(personaName, roleKey, picked);
				}
				updateWidget();
				ctx.ui.notify(
					`${label} → ${effectivePicked} (applies on next dispatch of ${parent.def.name})`,
					"info",
				);
				return;
			}

			const name = arg;
			// Team member (live state) OR a research persona — both switchable.
			const def = name ? policy.switchablePersonaDef(name) : undefined;
			if (!def) {
				const known = [
					...Array.from(activeAgents.values()).map(s => s.def.name),
					...getResearchPersonas().map(d => d.name),
				].join(", ");
				ctx.ui.notify(`Usage: /af-agent-model <persona>[.<role>]. Known: ${known || "none"}`, "error");
				return;
			}
			if (!def.models || def.models.length === 0) {
				ctx.ui.notify(
					`${displayName(def.name)} declares no model candidates — add a \`models:\` list to ${def.file} or a \`models.${def.name}:\` override in .ai/agent-fleet-overrides.md.`,
					"warning",
				);
				return;
			}
			const candidates = policy.allowedModels(def);
			const current = policy.resolvedModel(def);
			// A persona without a frontmatter default runs on the dispatcher's model —
			// offer that as an explicit candidate so the override can be cleared.
			const DISPATCHER_DEFAULT = "(dispatcher's model)";
			if (!def.model) candidates.unshift(DISPATCHER_DEFAULT);
			const options = candidates.map(m => {
				const isDefault = def.model ? m === def.model : m === DISPATCHER_DEFAULT;
				const isCurrent = current ? m === current : m === DISPATCHER_DEFAULT;
				const tags = [isDefault ? "default" : "", isCurrent ? "current" : ""].filter(Boolean);
				return tags.length ? `${m} (${tags.join(", ")})` : m;
			});
			const choice = await ctx.ui.select(`Model for ${displayName(def.name)}`, options);
			if (choice === undefined) return;
			const picked = candidates[options.indexOf(choice)];
			const effectivePicked = picked === DISPATCHER_DEFAULT ? picked : (policy.substitutedModel(picked) ?? picked);
			const pickedIsCurrent = current ? effectivePicked === current : picked === DISPATCHER_DEFAULT;
			if (pickedIsCurrent) {
				ctx.ui.notify(`${displayName(def.name)} is already on ${effectivePicked}`, "info");
				return;
			}
			if (picked === def.model || picked === DISPATCHER_DEFAULT) {
				policy.setPersonaOverride(name, undefined);
			} else {
				policy.setPersonaOverride(name, picked);
			}
			updateWidget();
			// Research helpers spawn fresh each time, so the switch lands on their
			// next spawn; team members apply on next dispatch (restartable now).
			const applyHint = (def.kind || "").toLowerCase() === "research"
				? "applies on next spawn_research"
				: `applies on next dispatch; /af-agents-restart ${def.name} to apply now`;
			ctx.ui.notify(`${displayName(def.name)} → ${effectivePicked} (${applyHint})`, "info");
			if (prefersComs(name)) {
				ctx.ui.notify(
					`Note: ${displayName(def.name)} prefers a coms peer (dispatch-policy.yaml) — this model override only applies to native(-fallback) runs; the peer keeps its own model.`,
					"info",
				);
			}
		},
	});
}
