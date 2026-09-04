import { createRequire } from 'node:module';
export interface ModelSelection {
    model: string;
    thinking?: string;
}
export interface ProfileVoice extends ModelSelection {
    name: string;
    integrator?: boolean;
}
export interface CompleteModelProfile {
    version: 2;
    defaults: ModelSelection;
    agents?: Record<string, ModelSelection>;
    subagents?: Record<string, Record<string, ModelSelection>>;
    dispatcher?: ModelSelection;
    services?: {
        watchdog?: ModelSelection;
        'return-extractor'?: ModelSelection;
    };
    panel?: ProfileVoice[];
    routing?: 'native' | 'configured';
    fallback?: 'none' | 'declared';
    'allowed-models'?: string[];
}
export type ModelProfile = Record<string, string> | CompleteModelProfile;
export type ModelProfiles = Record<string, ModelProfile>;
export interface ProfileAgentDef {
    name: string;
    model?: string;
    models?: string[];
    subagents?: Record<string, unknown>;
}
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const modelPattern = /^[^\s/,]+\/[^\s,]+$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function isCompleteProfile(p: ModelProfile): p is CompleteModelProfile { return p.version === 2; }
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            throw new Error(`${label}: unknown key "${key}"`);
}
function selection(value: unknown, label: string): ModelSelection {
    const raw = typeof value === 'string' ? { model: value } : value;
    if (!object(raw))
        throw new Error(`${label}: expected model string or mapping`);
    keys(raw, ['model', 'thinking'], label);
    if (typeof raw.model !== 'string' || !modelPattern.test(raw.model))
        throw new Error(`${label}: expected fully qualified provider/model`);
    if (raw.thinking !== undefined && (typeof raw.thinking !== 'string' || !thinkingLevels.has(raw.thinking)))
        throw new Error(`${label}: invalid thinking level`);
    return { model: raw.model, ...(raw.thinking !== undefined ? { thinking: raw.thinking as string } : {}) };
}
function namedSelections(value: unknown, label: string): Record<string, ModelSelection> {
    if (!object(value))
        throw new Error(`${label}: expected mapping`);
    const result: Record<string, ModelSelection> = {};
    for (const [name, v] of Object.entries(value)) {
        if (!namePattern.test(name))
            throw new Error(`${label}: invalid name "${name}"`);
        result[name] = selection(v, `${label}.${name}`);
    }
    return result;
}
export function parseCompleteProfile(raw: unknown): CompleteModelProfile {
    if (!object(raw))
        throw new Error('profile: expected mapping');
    keys(raw, ['version', 'defaults', 'agents', 'subagents', 'dispatcher', 'services', 'panel', 'routing', 'fallback', 'allowed-models'], 'profile');
    if (raw.version !== 2)
        throw new Error('profile: version must be 2');
    const p: CompleteModelProfile = { version: 2, defaults: selection(raw.defaults, 'defaults'), routing: 'native', fallback: 'none' };
    if (raw.agents !== undefined)
        p.agents = namedSelections(raw.agents, 'agents');
    if (raw.subagents !== undefined) {
        if (!object(raw.subagents))
            throw new Error('subagents: expected mapping');
        p.subagents = {};
        for (const [parent, roles] of Object.entries(raw.subagents)) {
            if (!namePattern.test(parent))
                throw new Error(`subagents: invalid parent ${parent}`);
            p.subagents[parent] = namedSelections(roles, `subagents.${parent}`);
        }
    }
    if (raw.dispatcher !== undefined)
        p.dispatcher = selection(raw.dispatcher, 'dispatcher');
    if (raw.services !== undefined) {
        if (!object(raw.services))
            throw new Error('services: expected mapping');
        keys(raw.services, ['watchdog', 'return-extractor'], 'services');
        p.services = {};
        for (const key of ['watchdog', 'return-extractor'] as const)
            if (raw.services[key] !== undefined)
                p.services[key] = selection(raw.services[key], `services.${key}`);
    }
    if (raw.routing !== undefined) {
        if (raw.routing !== 'native' && raw.routing !== 'configured')
            throw new Error('routing: expected native|configured');
        p.routing = raw.routing;
    }
    if (raw.fallback !== undefined) {
        if (raw.fallback !== 'none' && raw.fallback !== 'declared')
            throw new Error('fallback: expected none|declared');
        p.fallback = raw.fallback;
    }
    if (raw['allowed-models'] !== undefined) {
        const allowed = raw['allowed-models'];
        if (!Array.isArray(allowed) || !allowed.length || allowed.some(m => typeof m !== 'string' || !modelPattern.test(m)))
            throw new Error('allowed-models: expected nonempty model list');
        p['allowed-models'] = [...new Set(allowed)] as string[];
    }
    if (raw.panel !== undefined) {
        if (!Array.isArray(raw.panel) || raw.panel.length < 2 || raw.panel.length > 5)
            throw new Error('panel: expected 2–5 voices');
        const seen = new Set<string>();
        let integrators = 0;
        p.panel = raw.panel.map((v, i) => {
            if (!object(v))
                throw new Error(`panel[${i}]: expected mapping`);
            keys(v, ['name', 'model', 'thinking', 'integrator'], `panel[${i}]`);
            if (typeof v.name !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(v.name) || seen.has(v.name))
                throw new Error(`panel[${i}]: invalid or duplicate name`);
            if (v.integrator !== undefined && typeof v.integrator !== 'boolean')
                throw new Error(`panel[${i}]: integrator must be boolean`);
            seen.add(v.name);
            if (v.integrator === true)
                integrators++;
            return { name: v.name, ...selection({ model: v.model, ...(v.thinking !== undefined ? { thinking: v.thinking } : {}) }, `panel[${i}]`), ...(v.integrator === true ? { integrator: true } : {}) };
        });
        if (integrators > 1)
            throw new Error('panel: at most one integrator');
    }
    if (p['allowed-models'] && p.routing !== 'native')
        throw new Error('allowed-models requires native routing; peer children cannot be verified');
    for (const model of profileModels(p))
        if (p['allowed-models'] && !p['allowed-models'].includes(model))
            throw new Error(`model ${model} is outside allowed-models`);
    return p;
}
export function parseModelProfiles(text: string): {
    profiles: ModelProfiles;
    errors: string[];
} {
    let raw: unknown;
    try {
        // Runtime children validate inherited JSON without needing a YAML dependency.
        // Only the hub's configuration loader resolves its installed YAML package.
        const { parse: parseYaml } = createRequire(import.meta.url)('yaml');
        raw = parseYaml(text);
    }
    catch (error) {
        return { profiles: {}, errors: [`invalid YAML: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (!object(raw))
        return { profiles: {}, errors: ['model-profiles.yaml: expected mapping'] };
    const profiles: ModelProfiles = {}, errors: string[] = [];
    for (const [name, value] of Object.entries(raw)) {
        try {
            if (!object(value))
                throw new Error('expected profile mapping');
            if ('version' in value)
                profiles[name] = parseCompleteProfile(value);
            else {
                const legacy: Record<string, string> = {};
                for (const [persona, model] of Object.entries(value)) {
                    if (!namePattern.test(persona) || typeof model !== 'string' || !modelPattern.test(model))
                        throw new Error(`invalid persona/model entry ${persona}`);
                    legacy[persona] = model;
                }
                if (!Object.keys(legacy).length)
                    throw new Error('empty profile');
                profiles[name] = legacy;
            }
        }
        catch (error) {
            errors.push(`profile "${name}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { profiles, errors };
}
export function agentSelection(p: CompleteModelProfile, name: string): ModelSelection {
    return { thinking: 'off', ...p.defaults, ...p.agents?.[name.toLowerCase()] };
}
export function childSelection(p: CompleteModelProfile, parent: string, role: string): ModelSelection {
    return { thinking: 'off', ...p.defaults, ...p.subagents?.[parent.toLowerCase()]?.[role.toLowerCase()] };
}
export function serviceSelection(p: CompleteModelProfile, service: 'watchdog' | 'return-extractor'): ModelSelection {
    return { thinking: 'off', ...p.defaults, ...p.services?.[service] };
}
export function dispatcherSelection(p: CompleteModelProfile): ModelSelection { return { thinking: 'off', ...p.defaults, ...p.dispatcher }; }
export function profileModels(p: ModelProfile): string[] {
    if (!isCompleteProfile(p))
        return [...new Set(Object.values(p))];
    return [...new Set([p.defaults.model, p.dispatcher?.model, ...Object.values(p.agents ?? {}).map(v => v.model), ...Object.values(p.subagents ?? {}).flatMap(roles => Object.values(roles).map(v => v.model)), ...Object.values(p.services ?? {}).map(v => v.model), ...(p.panel ?? []).map(v => v.model)].filter((v): v is string => !!v))];
}
export function validateProfile(p: ModelProfile, defs: readonly ProfileAgentDef[]): string[] {
    const errors: string[] = [];
    const entries = isCompleteProfile(p) ? Object.entries(p.agents ?? {}).map(([n, v]) => [n, v.model]) : Object.entries(p);
    for (const [name, model] of entries) {
        const def = defs.find(d => d.name.toLowerCase() === name);
        if (!def)
            errors.push(`unknown persona "${name}"`);
        else if (!isCompleteProfile(p) && ![def.model, ...(def.models ?? [])].includes(model))
            errors.push(`${name} does not declare ${model}`);
    }
    if (isCompleteProfile(p))
        for (const [parent, roles] of Object.entries(p.subagents ?? {})) {
            const def = defs.find(d => d.name.toLowerCase() === parent);
            if (!def)
                errors.push(`unknown parent "${parent}"`);
            else
                for (const role of Object.keys(roles))
                    if (!def.subagents?.[role])
                        errors.push(`unknown child "${parent}.${role}"`);
        }
    return errors;
}
