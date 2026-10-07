// Phase 4 dispatch facade. The composition root supplies explicit stateful deps;
// native, coms, and observability implementations remain internal modules.
export {
	createDispatchComs,
	type ComsDispatchResult,
	type ComsDispatchState,
	type DispatchComsDeps,
	type DispatchInputArtifactPreview,
	type DriftJudgeInput,
} from "./dispatch-coms.ts";
export {
	createDispatchNative,
} from "./dispatch-native.ts";
export type {
	NativeAgentDefinition,
	NativeBackend,
	NativeDispatchDeps,
	NativeDispatchResult,
	NativeDispatchState,
} from "./dispatch-native-types.ts";
export {
	createDispatchObservability,
	type DelegationChild,
	type DelegationEvent,
	type DelegationObservableState,
	type DispatchObservabilityDeps,
} from "./dispatch-observability.ts";
