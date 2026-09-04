import { parseCompleteProfile, agentSelection, childSelection, serviceSelection, type CompleteModelProfile } from '../config/model-profiles.ts';
export const PROFILE_ENV = 'AGENT_FLEET_ACTIVE_MODEL_PROFILE';
export interface ActiveModelProfile {
    name: string;
    profile: CompleteModelProfile;
}
let activeRuns = 0;
export function profileWorkInFlight(): number { return activeRuns; }
export async function withProfileWork<T>(run: () => Promise<T>): Promise<T> { activeRuns++; try {
    return await run();
}
finally {
    activeRuns--;
} }
export function readActiveProfile(env: NodeJS.ProcessEnv = process.env): ActiveModelProfile | undefined {
    const raw = env[PROFILE_ENV];
    if (!raw)
        return undefined;
    try {
        const value = JSON.parse(raw);
        if (typeof value.name !== 'string' || !value.name)
            throw new Error('missing name');
        return { name: value.name, profile: parseCompleteProfile(value.profile) };
    }
    catch (error) {
        throw new Error(`Invalid active model profile: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export function setActiveProfile(active: ActiveModelProfile | undefined, env: NodeJS.ProcessEnv = process.env): void {
    if (active)
        env[PROFILE_ENV] = JSON.stringify(active);
    else
        delete env[PROFILE_ENV];
}
export function assertProfileModel(model: string, active = readActiveProfile()): void {
    if (active?.profile['allowed-models'] && !active.profile['allowed-models'].includes(model))
        throw new Error(`Profile "${active.name}" refuses model "${model}"; allowed-models: ${active.profile['allowed-models'].join(', ')}`);
}
export function profileFallback(candidate: string | undefined, active = readActiveProfile()): string | undefined {
    if (active?.profile.fallback === 'none')
        return undefined;
    if (candidate)
        assertProfileModel(candidate, active);
    return candidate;
}
export function profileAgent(name: string, active = readActiveProfile()) { return active ? agentSelection(active.profile, name) : undefined; }
export function profileChild(parent: string, role: string, active = readActiveProfile()) { return active ? childSelection(active.profile, parent, role) : undefined; }
export function profileService(service: 'watchdog' | 'return-extractor', active = readActiveProfile()) { return active ? serviceSelection(active.profile, service) : undefined; }
export function profilePanel(name: string, active = readActiveProfile()) {
    if (!active)
        return undefined;
    if (name !== active.name)
        throw new Error(`Profile "${active.name}" owns the poll/debate panel; select --panel ${active.name}.`);
    const voices = active.profile.panel ?? [
        { name: 'first', model: active.profile.defaults.model, integrator: true },
        { name: 'second', model: active.profile.defaults.model },
    ];
    return voices.map(v => ({ thinking: active.profile.defaults.thinking ?? 'off', ...v }));
}
export function profilePeerRefusal() {
    if (readActiveProfile()?.profile.routing !== 'native')
        return null;
    return { isError: true, content: [{ type: 'text' as const, text: 'Active model profile requires native agents; peer execution is disabled. Use dispatch_agent or leave this profile.' }], details: { error: 'model-profile-native' } };
}
