import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandContext } from "./context.ts";
import { isCompleteProfile } from "../config/model-profiles.ts";

export function registerModels(pi: ExtensionAPI, commandCtx: CommandContext): void {
	pi.registerCommand("af-models", {
		description: "Apply a model profile to the team: /af-models [profile]",
		getArgumentCompletions: prefix => commandCtx.getModelProfileCompletions(prefix),
		handler: async (args, ctx) => {
			commandCtx.setWidgetContext(ctx);
			const { getProfiles, shortModel, activateProfile, applyWorkModeTools } = commandCtx.modelCommands;
			const profiles = getProfiles();
			const names = Object.keys(profiles);
			if (names.length === 0) {
				ctx.ui.notify("No model profiles loaded — define .pi/agents/model-profiles.yaml (invalid profiles are dropped at session start).", "warning");
				return;
			}
			let profileName = (args || "").trim();
			if (!profileName) {
				const options = names.map(name => {
					const profile = profiles[name];
					return isCompleteProfile(profile)
						? `${name} — complete fleet (${shortModel(profile.defaults.model)} default)`
						: `${name} — ${Object.entries(profile).map(([persona, model]) => `${persona}: ${shortModel(model)}`).join(", ")}`;
				});
				const choice = await ctx.ui.select("Select model profile", options);
				if (choice === undefined) return;
				profileName = names[options.indexOf(choice)];
			}
			const profile = getProfiles()[profileName];
			if (!profile) {
				ctx.ui.notify(`No profile "${profileName}". Known: ${names.join(", ")}`, "error");
				return;
			}
			try {
				const applied = await activateProfile(profileName, profile, ctx);
				applyWorkModeTools();
				ctx.ui.setStatus('hub-model-profile',isCompleteProfile(profile)?`Models: ${profileName}`:undefined);
				ctx.ui.notify(`Profile "${profileName}": ${applied.length} personas${isCompleteProfile(profile)?', all children, dispatcher and auxiliary models':''} switched.`, 'info');
			} catch(error) {ctx.ui.notify(String(error),'error');}
		},
	});
}
