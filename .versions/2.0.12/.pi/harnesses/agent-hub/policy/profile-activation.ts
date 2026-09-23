import { isCompleteProfile, parseCompleteProfile, profileModels, dispatcherSelection, validateProfile, type ModelProfile, type ModelSelection, type ProfileAgentDef } from '../config/model-profiles.ts';
import { setActiveProfile } from './profile-runtime.ts';
export interface ProfileActivationPorts {
    busy(): boolean;
    defs(): readonly ProfileAgentDef[];
    available(): Promise<readonly string[]>;
    dispatcher(): ModelSelection | undefined;
    setDispatcher(selection: ModelSelection): Promise<boolean>;
    apply(profile: ModelProfile): string[];
    env?: NodeJS.ProcessEnv;
}
export function createProfileActivation(ports: ProfileActivationPorts) {
    let baseline: ModelSelection | undefined;
    let completeActive = false;
    let switching = false;
    return {
        switching: () => switching,
        reset() { baseline = undefined; completeActive = false; setActiveProfile(undefined, ports.env); },
        async activate(name: string, input: ModelProfile): Promise<string[]> {
            if (switching || ports.busy())
                throw new Error('Model profile switch refused: wait for the dispatcher, agents and workflows to finish.');
            switching = true;
            try {
                const profile = isCompleteProfile(input) ? parseCompleteProfile(input) : input;
                const errors = validateProfile(profile, ports.defs());
                if (errors.length)
                    throw new Error(errors.join('\n'));
                const target = isCompleteProfile(profile) ? dispatcherSelection(profile) : completeActive ? baseline : undefined;
                const available = new Set(await ports.available());
                const required = [...profileModels(profile), ...(target ? [target.model] : [])];
                const missing = [...new Set(required.filter(model => !available.has(model)))];
                if (missing.length)
                    throw new Error(`Profile "${name}" not activated; models unavailable in Pi: ${missing.join(', ')}. No settings changed.`);
                if (ports.busy())
                    throw new Error('Model profile switch refused: work started during validation.');
                const previous = ports.dispatcher();
                if (target) {
                    try {
                        if (!await ports.setDispatcher(target))
                            throw new Error(`Could not select dispatcher model ${target.model}`);
                    }
                    catch (error) {
                        if (previous)
                            await ports.setDispatcher(previous);
                        throw error;
                    }
                }
                if (isCompleteProfile(profile) && !completeActive)
                    baseline = previous;
                const applied = ports.apply(profile);
                completeActive = isCompleteProfile(profile);
                setActiveProfile(completeActive ? { name, profile: profile as any } : undefined, ports.env);
                if (!completeActive)
                    baseline = undefined;
                return applied;
            }
            finally {
                switching = false;
            }
        },
    };
}
