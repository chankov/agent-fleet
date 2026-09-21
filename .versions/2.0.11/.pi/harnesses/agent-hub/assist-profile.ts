import type { AssistFlags } from './config/model-profiles.ts';

export interface ResolvedAssistFlags {
	'deterministic-tools': boolean;
	'bounded-output': boolean;
	'write-isolation': boolean;
}

/** Resolves requested profile configuration only; feature producers apply it separately. */
export function resolveAssist(assist: AssistFlags = {}): ResolvedAssistFlags {
	return {
		'deterministic-tools': assist['deterministic-tools'] === true,
		'bounded-output': assist['bounded-output'] === true,
		'write-isolation': assist['write-isolation'] === true,
	};
}
