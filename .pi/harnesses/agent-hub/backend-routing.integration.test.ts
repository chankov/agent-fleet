// Static wiring contracts for index.ts. Executable routing semantics live in
// backend-policy.test.js; model-backed dispatch remains a runtime smoke concern.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const dispatchCoreSource = readFileSync(new URL("./dispatch-core.ts", import.meta.url), "utf8");
const dispatchComsSource = readFileSync(new URL("./dispatch-coms.ts", import.meta.url), "utf8");
const dispatchObservabilitySource = readFileSync(new URL("./dispatch-observability.ts", import.meta.url), "utf8");
const dispatchNativeSource = readFileSync(new URL("./dispatch-native.ts", import.meta.url), "utf8");
const dispatchNativePrepareSource = readFileSync(new URL("./dispatch-native-prepare.ts", import.meta.url), "utf8");
const dispatchNativeSpawnSource = readFileSync(new URL("./dispatch-native-spawn.ts", import.meta.url), "utf8");
const dispatchNativeCompleteSource = readFileSync(new URL("./dispatch-native-complete.ts", import.meta.url), "utf8");
const dispatchAgentToolSource = readFileSync(new URL("./tools/dispatch-agent.ts", import.meta.url), "utf8");

test("wiring contract: dispatch_agent exposes the explicit backend enum", () => {
	assert.match(dispatchAgentToolSource, /backend: Type\.Optional\(Type\.Union\(\[/);
	for (const backend of ["auto", "native", "coms"]) {
		assert.match(dispatchAgentToolSource, new RegExp(`Type\\.Literal\\("${backend}"\\)`));
	}
});

test("wiring contract: requested backend reaches initial and resumed dispatches", () => {
	assert.match(source, /const \{ task, artifacts, scope, watchdog, review_reason, backend = "auto" \}/);
	assert.match(source, /dispatchAgent\(agent, dispatchedTask, ctx, inputArtifacts, scopeGlobs, watchdog, backend\)/);
	assert.match(source, /dispatchAgent\(agent, resumePrompt, ctx, inputArtifacts, scopeGlobs, watchdog, backend, true\)/);
});

test("wiring contract: explicit coms refusal precedes native spawn", () => {
	assert.match(dispatchNativeSource, /route\.backend === "coms-unavailable"/);
	assert.match(dispatchNativeSource, /explicitComsRefusal\(deps\.displayName\(state\.def\.name\)\)/);
	assert.match(dispatchNativeSource, /const allowNativeFallback = !route\.explicit/);
	assert.match(dispatchNativeSource, /await deps\.dispatchViaComs\(/);
	assert.match(dispatchComsSource, /if \(allowNativeFallback\) return null;/);
	assert.match(dispatchComsSource, /fallback: none/);
});

test("wiring contract: dispatch facade exposes typed native, coms, and observability factories", () => {
	assert.match(source, /import \{ createDispatchComs, createDispatchNative, createDispatchObservability, type DelegationChild \} from "\.\/dispatch-core\.ts"/);
	assert.match(dispatchCoreSource, /createDispatchNative/);
	assert.match(dispatchCoreSource, /createDispatchComs/);
	assert.match(dispatchCoreSource, /createDispatchObservability/);
	assert.match(dispatchComsSource, /export interface DispatchComsDeps/);
	assert.match(dispatchComsSource, /export function createDispatchComs\(deps: DispatchComsDeps\)/);
	assert.match(dispatchObservabilitySource, /export interface DispatchObservabilityDeps/);
	assert.match(dispatchObservabilitySource, /export function createDispatchObservability\(deps: DispatchObservabilityDeps\)/);
	assert.match(source, /getDelegatedTokens: \(\) => delegatedTokens/);
	assert.match(source, /setDelegatedTokens: value => \{ delegatedTokens = value; \}/);
	assert.match(source, /getWatchdogJudgeModel: \(\) => watchdogJudgeModel/);
	assert.match(dispatchComsSource, /async function dispatchViaComs\(/);
	assert.match(dispatchComsSource, /async function runDriftJudge\(/);
	assert.match(dispatchComsSource, /async function runReturnExtraction\(/);
	assert.match(dispatchObservabilitySource, /function handleDelegationEvent\(/);
	assert.match(dispatchObservabilitySource, /function startDelegationWatch\(/);
	assert.doesNotMatch(source, /function handleDelegationEvent\(/);
	assert.doesNotMatch(source, /function dispatchViaComs\(/);
	assert.doesNotMatch(source, /async function dispatchAgent\(/);
	assert.match(source, /const nativeDispatch = createDispatchNative\(\{/);
	assert.match(source, /const \{ dispatchAgent \} = nativeDispatch/);
	assert.match(dispatchNativeSource, /export function createDispatchNative\(deps: NativeDispatchDeps\)/);
	assert.match(dispatchNativePrepareSource, /export async function prepareNativeRun\(/);
	assert.match(dispatchNativeSpawnSource, /export async function runPreparedNative\(/);
	assert.match(dispatchNativeCompleteSource, /export async function completeNativeRun\(/);
});
