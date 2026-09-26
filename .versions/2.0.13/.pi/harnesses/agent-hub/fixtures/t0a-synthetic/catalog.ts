/**
 * T0a synthetic contract/regression fixtures.
 * Kind is always "synthetic". These are not historical incidents and must not
 * inflate incident counts or metrics. Baseline is the recorded pre-fix harness
 * behavior, not a claim about current runtime behavior; expectedPostFix is the target contract.
 * Fixtures that mention T4/T6/T9b are contract-only: they do not require those
 * slices to be implemented for T0a to be complete.
 */
export type T0aKind = "synthetic";

export interface T0aFixture {
	id: string;
	kind: T0aKind;
	title: string;
	followOnTask: string;
	check: string;
	initialState: string;
	event: string;
	observedBaseline: string;
	expectedPostFix: string;
	requiresUnimplementedSlice: null | "T4" | "T6" | "T9b";
	notes: string;
}

export const T0A_FIXTURE_IDS = [
	"narrowed-research-retry",
	"effective-model-change",
	"busy-agent",
	"pseudo-tool-call",
	"missing-deliverable",
	"mode-switch",
	"bg-en-verification",
	"unsupported-completion",
	"missing-worktree-installation",
] as const;

export type T0aFixtureId = (typeof T0A_FIXTURE_IDS)[number];

export const T0A_SYNTHETIC_FIXTURES: Record<T0aFixtureId, T0aFixture> = {
	"narrowed-research-retry": {
		id: "narrowed-research-retry",
		kind: "synthetic",
		title: "Narrowed research retry after no-progress refusal",
		followOnTask: "T1a/T1b",
		check: "t0a-synthetic-fixtures.test.ts / narrowed research retry remains a baseline-as-baseline record",
		initialState:
			"Research spawn failed once with unchanged actor, worktree revision, and artifact hashes. Guard recorded a failure for that key.",
		event:
			"Operator retries with the same actor/worktree but a narrower structured read scope (fewer files / smaller excerpt contract) while prose is reworded.",
		observedBaseline:
			"withNoProgress keys research by kind, cwd, actor, scope paths, and artifact paths; revision is worktree+artifact hashes. A structured read-scope shrink that is not yet a first-class input is treated like rewording if path lists and revision are unchanged: begin() refuses with no_progress_refused / unchanged_inputs. Existing tests: no-progress.test.ts (rewording blocked; changed source content unlocks).",
		expectedPostFix:
			"T1: structured read scope, goal, and expected result are part of normalized inputs. A real shrink of read scope is a relevant changed condition and may unlock one retry within EXISTING budgets. Prose-only rewording still refuses. No new numeric limits.",
		requiresUnimplementedSlice: null,
		notes: "Synthetic. Not an additional historical research-overread incident.",
	},
	"effective-model-change": {
		id: "effective-model-change",
		kind: "synthetic",
		title: "Effective model change after refusal",
		followOnTask: "T1b",
		check: "t0a-synthetic-fixtures.test.ts / effective model gap remains a baseline-as-baseline record",
		initialState:
			"A dispatch/research attempt failed and is recorded against actor+scope+revision. Effective model is not part of the guard key.",
		event: "Same task identity is retried after the effective child model/profile selection changes, without other input changes.",
		observedBaseline:
			"no-progress.ts key is JSON([kind, cwd, actor, scope, artifact paths, contract]); revision omits model identity. Changing only the effective model does not change key or revision, so begin() still refuses.",
		expectedPostFix:
			"T1b: effective model is a real execution condition. A verified model change may be considered for explicit re-invocation within existing budgets. It does not bypass operator_cancelled. Indeterminate cause never authorizes retry. No automatic model fallback.",
		requiresUnimplementedSlice: null,
		notes: "Synthetic. Not a new incident from anonymous-helper model switch.",
	},
	"busy-agent": {
		id: "busy-agent",
		kind: "synthetic",
		title: "Parallel request to a busy agent",
		followOnTask: "T1c category busy; T6a later (not in this slice)",
		check: "t0a-synthetic-fixtures.test.ts / busy-agent baseline remains recorded separately from its post-fix contract",
		initialState: "Persona already has an in-flight dispatch (pending map occupied for that key).",
		event: "A second dispatch to the same actor/scope is issued before the first finishes.",
		observedBaseline:
			"createNoProgressGuard.begin refuses pending keys. withNoProgress returns status no_progress_refused, reason omitted in details except stopParent after two refusals; message says an operation is already in flight. This is not a structured busy category, does not distinguish unstarted work from failed work, and can poison no-progress history. T6 queue/isolation is not implemented and is not required for this fixture.",
		expectedPostFix:
			"Approved T1 policy: no automatic retry or waiting; immediate structured busy refusal; no execution budget spent on unstarted work. Explicit re-invocation only after evidenced relevant changed conditions (here: executor idle) within EXISTING budgets. T6a may later attach the same category; this fixture must not force T6 implementation.",
		requiresUnimplementedSlice: "T6",
		notes: "Synthetic. Contract-only toward T6. T0a does not implement busy preflight.",
	},
	"pseudo-tool-call": {
		id: "pseudo-tool-call",
		kind: "synthetic",
		title: "Final assistant text contains a pseudo tool call",
		followOnTask: "T3",
		check: "t0a-synthetic-fixtures.test.ts / pseudo-tool fixture is synthetic and does not execute XML",
		initialState:
			"Child run exits 0. Transcript ends with a text block resembling <tool_call><function=write>...</function></tool_call>. No tool event for write. Expected deliverable path is absent.",
		event: "Hub accepts the child result and maps exit 0 plus prose to a successful dispatch.",
		observedBaseline:
			"return-contract and dispatch layers parse structured returns from text; they do not currently classify unmatched XML/JSON tool-shaped prose as tool_protocol_error. spawn.ts tracks toolCallId on real events only. Exit 0 can coexist with a missing write. Legitimate documentation examples of XML are not distinguished because there is no diagnostic yet.",
		expectedPostFix:
			"T3: match suspicious final pseudo-tool text against actual tool events and deliverable readback. If claimed write did not happen, return tool_protocol_error with concrete diagnosis. Never auto-execute the text. Documentation examples are not errors. Recovery only via T1 policy after confirmed effects.",
		requiresUnimplementedSlice: null,
		notes: "Synthetic. Does not count as a new protocol incident.",
	},
	"missing-deliverable": {
		id: "missing-deliverable",
		kind: "synthetic",
		title: "Missing required deliverable with confident done summary",
		followOnTask: "T2",
		check: "t0a-synthetic-fixtures.test.ts / missing deliverable is not acceptance",
		initialState:
			"Task contract lists a required deliverable path. Child summary claims done. Assertions array empty or self-declared proven without evidence.",
		event: "Dispatch completes with exitCode 0 and file absent or unchanged.",
		observedBaseline:
			"acceptance.test.ts already treats some readback failures as deliverable_failed. Empty assertions and self-declared done can still surface as needs_verification / not_available depending on path. Exit 0 plus present file is not a full T2 runtime-owned result (execution vs changes vs verification dimensions). Current tests do not prove combined 'changed + verification failed'.",
		expectedPostFix:
			"T2: exit 0, file presence, and self-declared done are not acceptance. Missing/unmet checks remain visible. Test results bind to real command, exit, and checked revision. Changed and verification_failed may be true together.",
		requiresUnimplementedSlice: null,
		notes: "Synthetic contract for T2; not a historical empty-assertions count.",
	},
	"mode-switch": {
		id: "mode-switch",
		kind: "synthetic",
		title: "Operator to orchestrator mode switch leaves stale tool catalog",
		followOnTask: "T4 (implemented after this baseline)",
		check: "t0a-synthetic-fixtures.test.ts / mode-switch baseline now maps to the implemented T4 contract",
		initialState:
			"Session is in operator work mode with write/bash tools visible. Compaction or mode switch to orchestrator is requested.",
		event:
			"After switch, model issues the previous write/bash tool names or repeats unknown-tool calls.",
		observedBaseline:
			"T4 now emits runtime-owned catalog deltas from active tools, latches the originating-turn catalog, restores persisted catalog/counter state, and binds real unknown-tool dispatch failures to trusted catalog identity for shared T1 recovery. The N=3 counter survives compaction and catalog changes; only explicit new-task reset clears it.",
		expectedPostFix:
			"T4: emit tool-state delta (removed, available, allowed substitute). Restore task/tool state after compaction. Unknown tool gets a concrete valid path without auto-executing or expanding permissions. Identical unknown-tool retries follow T1 policy using existing budgets only. Orchestrator does not gain write/bash as a 'fix'.",
		requiresUnimplementedSlice: null,
		notes: "Synthetic baseline retained after T4 implementation. Not counted as the 16 unknown-tool historical calls.",
	},
	"bg-en-verification": {
		id: "bg-en-verification",
		kind: "synthetic",
		title: "BG vs EN verification request parity",
		followOnTask: "T7",
		check: "t0a-synthetic-fixtures.test.ts / BG and EN fixtures share one contract id pair",
		initialState:
			"Two equivalent change-producing tasks: English 'verify acceptance criteria' and Bulgarian 'провери критериите за приемане'. Same operation type and task contract.",
		event: "Capability/verification packing is resolved from user text and/or tier labels.",
		observedBaseline:
			"capability-packs.test.ts covers pack resolution; language heuristics can diverge because activation is not solely operation/task-contract driven. Small/trivial tier can drop evidence. This fixture does not run live models.",
		expectedPostFix:
			"T7: minimum verification is triggered by operation kind and task contract, not user-text regex or self-assessed tier alone. Equivalent BG/EN change tasks have the same core acceptance requirements. Greeting/read-only stays light.",
		requiresUnimplementedSlice: null,
		notes: "Synthetic parity pair. Not a new live-language incident.",
	},
	"unsupported-completion": {
		id: "unsupported-completion",
		kind: "synthetic",
		title: "Unsupported completion claim without evidence",
		followOnTask: "T2",
		check: "t0a-synthetic-fixtures.test.ts / unsupported completion remains unverified",
		initialState:
			"Child returns a confident merge-ready summary. No test command was executed. Assertion ledger empty or evidence-less proven lines.",
		event: "Hub or model treats the summary as completed work.",
		observedBaseline:
			"return-contract.test.ts keeps evidence-less proven entries with null evidence and crossCheck reports them. That is detection in the parser, not a runtime-owned refusal to accept the task. Missing runs must not be labelled success.",
		expectedPostFix:
			"T2/T10: unsupported completion stays visible (needs_verification or equivalent). Missing run is unverified, never success. Proven requires named evidence matching assertion tags.",
		requiresUnimplementedSlice: null,
		notes: "Synthetic. Does not add to historical false-completion counts.",
	},
	"missing-worktree-installation": {
		id: "missing-worktree-installation",
		kind: "synthetic",
		title: "Worktree missing required Fleet install files",
		followOnTask: "T9b (later; not this slice)",
		check: "t0a-synthetic-fixtures.test.ts / missing-install fixture is environment failure, not model failure",
		initialState:
			"New or incomplete worktree lacks required runtime files/tools (illustrative: many missing Fleet paths). Doctor/manifest may already cover a subset.",
		event: "A model task or baseline run is started anyway.",
		observedBaseline:
			"agent-fleet doctor / check:manifest exist. Presence of doctor does not prove complete worktree preflight for Hub child runs. Invalid install must not be scored as model inability. T9b is not implemented here.",
		expectedPostFix:
			"T9b: required runtime files and tool availability checked via existing doctor/manifest; concrete remediation proposed; no unauthorized repair. Invalid environment is a separate environment-validity metric (failed preflight checks / all preflight checks), not a model score.",
		requiresUnimplementedSlice: "T9b",
		notes: "Synthetic. Contract-only. Do not treat 90 missing files as a new incident in T0a metrics.",
	},
};

export function listT0aFixtures(): T0aFixture[] {
	return T0A_FIXTURE_IDS.map((id) => T0A_SYNTHETIC_FIXTURES[id]);
}
