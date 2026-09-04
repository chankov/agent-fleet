// The same inherited profile governs CLI workflows spawned by the hub and their children.
// Dynamic loading follows agent-phase.ts so the standalone workflow TS build stays local.
import type { Voice } from './voices.ts';
const runtimePath: string = '../../../.pi/harnesses/agent-hub/policy/profile-runtime.ts';
export const { readActiveProfile, profileAgent, profileFallback, assertProfileModel, profilePanel } = await import(runtimePath) as {
    readActiveProfile(): {
        name: string;
        profile: {
            defaults: {
                model: string;
                thinking?: string;
            };
        };
    } | undefined;
    profileAgent(name: string): {
        model: string;
        thinking?: string;
    } | undefined;
    profileFallback(model: string | undefined): string | undefined;
    assertProfileModel(model: string): void;
    profilePanel(name: string): Voice[] | undefined;
};
