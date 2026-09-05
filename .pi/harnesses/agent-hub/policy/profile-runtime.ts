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
export type ProfilePeerRefusal = {
    isError: true;
    content: [{ type: 'text'; text: string }];
    details: { error: 'model-profile-native' | 'model-profile-allowlist' };
};

function refusal(text: string, error: ProfilePeerRefusal['details']['error']): ProfilePeerRefusal {
    return { isError: true, content: [{ type: 'text', text }], details: { error } };
}

const BLANKET_NATIVE = 'Active model profile requires native agents; peer execution is disabled. Use dispatch_agent or leave this profile.';

/** True when native routing has no allowlist: standing peers are banned outright. */
export function profileForcesNativePeers(active = readActiveProfile()): boolean {
    return !!active && active.profile.routing === 'native' && !active.profile['allowed-models']?.length;
}

/** Exact allowlist hit, or a unique provider-less suffix match. Ambiguous suffixes fail. */
export function modelAllowedByProfile(model: string, allowed: readonly string[]): boolean {
    const value = model.trim();
    if (!value || value === 'unknown')
        return false;
    if (allowed.includes(value))
        return true;
    if (value.includes('/'))
        return false;
    return allowed.filter(entry => entry.split('/').pop() === value).length === 1;
}

export function profilePeerGate(opts?: { peerModel?: string; targetResolved?: boolean }, active = readActiveProfile()): ProfilePeerRefusal | null {
    if (!active || active.profile.routing !== 'native')
        return null;
    const allowed = active.profile['allowed-models'];
    if (!allowed?.length)
        return refusal(BLANKET_NATIVE, 'model-profile-native');
    if (opts?.targetResolved === false)
        return null;
    const model = opts?.peerModel?.trim();
    if (!model || model === 'unknown')
        return refusal(`Active model profile "${active.name}" refuses unverified peers; advertised model is missing or unknown. Use a peer on allowed-models: ${allowed.join(', ')}, dispatch_agent native, or leave this profile.`, 'model-profile-allowlist');
    if (modelAllowedByProfile(model, allowed))
        return null;
    return refusal(`Active model profile "${active.name}" refuses peer model "${model}"; allowed-models: ${allowed.join(', ')}. Use a peer on an allowed model, dispatch_agent native, or leave this profile.`, 'model-profile-allowlist');
}

export function profileSpawnPeerRefusal(plan: { runner: string; model?: string; persona?: string; name: string }, active = readActiveProfile()): ProfilePeerRefusal | null {
    const early = profilePeerGate({ targetResolved: false }, active);
    if (early)
        return early;
    if (!active || active.profile.routing !== 'native' || !active.profile['allowed-models']?.length)
        return null;
    if (plan.runner === 'claude-code')
        return refusal(`Active model profile "${active.name}" refuses claude-code peers; allowed-models: ${active.profile['allowed-models'].join(', ')}. Spawn a pi peer on an allowed model or leave this profile.`, 'model-profile-allowlist');
    const planned = plan.model ?? profileAgent(plan.persona ?? plan.name, active)?.model;
    return profilePeerGate({ peerModel: planned, targetResolved: true }, active);
}

/** @deprecated Prefer profilePeerGate with the resolved peer model. */
export function profilePeerRefusal() {
    return profilePeerGate();
}
