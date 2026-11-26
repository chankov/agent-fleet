import type { ResolvedAssignment } from "../config/roles.ts";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { diagnoseChangedTypeScript } from "../../lib/changed-file-diagnostics.ts";
import type { AcceptanceRequirement, DeliverableContract } from "../acceptance.ts";
import type { AssertionsArtifactsContext, InputArtifactPreview } from "../context/assertions-artifacts.ts";
import type { BudgetContext, SessionTotals, TurnReport } from "../context/budgets.ts";
import type { DispatchAccess } from "../dispatch-access.ts";
import type { NoProgressGuard } from "../no-progress.ts";
import type { OperatorStateCandidate } from "../operator-current-state.ts";
import type { PrivateConfigBinding } from "../private-config-current-state.ts";
import type { ProcessObligationState, ProcessVerdict } from "../process-obligations.ts";
import type { ResearchAgentDef, ResearchRuntime } from "../research/runtime.ts";
import type { ReviewBaseline } from "../review-continuity.ts";
import type { ReviewInput } from "../review-reuse.ts";
import type { ReceiptCapture } from "../runtime-receipts.ts";
import type { TaskResumeInput } from "../task-resume-contract.ts";
import type { AgentState } from "../types.ts";
import type { ToolExecutionResult } from "./context.ts";

export type DispatchResult = import("../dispatch-native-types.ts").NativeDispatchResult;

export interface WriterEntry { agent: string; scope: string[]; isolated: boolean }

export interface DispatchExecutionState {
	getTurnDispatchCount(): number; setTurnDispatchCount(value: number): void;
	getTurnResearchCount(): number; setTurnResearchCount(value: number): void;
	getTaskDispatchCount(): number; setTaskDispatchCount(value: number): void;
	getTaskResearchCount(): number; setTaskResearchCount(value: number): void;
	getTaskReviewRounds(): number; setTaskReviewRounds(value: number): void;
	getTaskTier(): string | null;
	getAcceptedUserInput?(): string | undefined;
	getTurnReport(): TurnReport;
	getSessionTotals(): SessionTotals;
	getTurnDispatchFingerprints(): Set<string>;
	getExternalBlockers(): Array<{ agent: string; what: string }>;
	getExternalBlockerAcknowledged(): boolean; markExternalBlockersPending(): void;
	getExternalBlockerMarker(): string;
	isAskUserAvailable(): boolean;
	getUserLanguage(): string;
	getSessionDir(): string;
	getAgentStates(): Map<string, AgentState>;
	getAssertions(): Array<{ id: string; tag: string; text: string; source: string; reference?: string; criticalConditions?: string[]; testCommand?: string; compilerCommand?: string; status: string; evidence?: string; evidenceTaskId?: string; evidenceRevision?: string }>;
	getResearchPersonas(): ResearchAgentDef[];
	/** Adds an installed, dispatchable persona to the active team; null when none is installed under that name. */
	addInstalledAgent?(agent: string): { ok: boolean; message: string } | null;
	/** Installed personas dispatch_agent may target (research and catalog-only personas excluded). */
	getInstalledAgentNames?(): string[];
	/** Writable dispatches running now, with their declared scope and whether they are OS-isolated. */
	getActiveWriters?(): WriterEntry[];
	mayRouteToComs?(agent: string): boolean;
	/** Registers a writable dispatch; an isolated one makes its native launch sandboxed. Returns its release. */
	beginWriter?(entry: WriterEntry): () => void;
	/** Creates (or reuses) a parallel instance of an installed writable persona, e.g. builder-2. */
	addAgentInstance?(base: string, instance: string): boolean;
	/** Records an admitted delegation in the current task brief. */
	recordDelegation?(entry: { agent: string; kind: "specialist" | "research"; task: string; scope: string[]; researchId?: number }): void;
	getTaskDisplayScope?(): import('../scope-diagnostic.ts').TaskDisplayScope;
	getActiveWritableDispatches(): number; setActiveWritableDispatches(value: number): void;
	/** Monotonic registration count, including writers that have already exited. */
	getWriterGeneration?(): number;
	getWritableOverlapCounter(): number; setWritableOverlapCounter(value: number): void;
	getProcessState?(): ProcessObligationState;
	processBlock?(): { reason: string; message: string } | null;
	setProcessState?(value: ProcessObligationState): void;
	persistProcessVerdict?(state: ProcessObligationState, verdict: ProcessVerdict): void;
}

export interface DispatchExecutorDeps {
	noProgress: NoProgressGuard;
	state: DispatchExecutionState;
	budget: BudgetContext;
	artifacts: AssertionsArtifactsContext;
	research: ResearchRuntime<any>;
	provisionalCapabilityRefusal(pack: "fleet"): ToolExecutionResult | null;
	/** Stops the agent's in-flight run the same way the fleet kill action does. */
	cancelRunningDispatch?(agent: string): void;
	dispatchAgent(agent: string, task: string, ctx: ExtensionContext, artifacts: InputArtifactPreview[], scope: string[], watchdog?: boolean, backend?: "auto" | "native" | "coms", resume?: boolean, resumeContract?: Omit<TaskResumeInput, "previous">, revisionScopes?: string[], access?: DispatchAccess): Promise<DispatchResult>;
	runReturnExtraction(path: string, ids: string[], ctx: ExtensionContext): Promise<any>;
	/** Opt-in profile assistance: recover a missing submit_result from the written report. */
	returnExtractionAssist?(): boolean;
	extractNeedsResearch(output: string): string[];
	extractAskUserQuestions(output: string): string[];
	contextPressure(percent: number): boolean;
	displayName(name: string): string;
	getToolCatalogVersion?(): string;
	resolvedAgentModel?(def: AgentState["def"], ctx: ExtensionContext): string | undefined;
	diagnoseChangedTypeScript?: typeof diagnoseChangedTypeScript;
}

export interface PreparedDispatch {
	/** Role and practices resolved at admission (config/roles.ts). */
	assignment?: ResolvedAssignment;
	access: DispatchAccess;
	privateConfig?: PrivateConfigBinding;
	operatorCandidate?: OperatorStateCandidate;
	beforeSnapshot?: unknown;
	reviewBaseline?: ReviewBaseline | null;
	reviewInput?: ReviewInput | null;
	taskToken: object;
	taskId: string;
	beforeRevision: string;
	/** Task revision basis (D8). Empty at a root repository. */
	revisionScopes: string[];
	requirements: AcceptanceRequirement[];
	contract: DeliverableContract;
	resumeContract: Omit<TaskResumeInput, "previous">;
	sessionDir: string;
	agent: string;
	task: string;
	inputArtifacts: InputArtifactPreview[];
	scopeGlobs: string[];
	fingerprint: string;
	parallel?: boolean;
}

export interface RunData {
	result: DispatchResult;
	billed: number;
	out: number;
	researchRounds: { questions: string[]; files: string[] }[];
}

export interface Tracking {
	receiptCapture?: ReceiptCapture;
	writable: boolean;
	snapshot: any;
	overlapBaseline: number;
	writerGeneration?: number;
	concurrentAtStart: boolean;
	release?: () => void;
	isolatedScope?: string[];
}

export interface WorktreeObservation {
	skipped: boolean;
	reason?: string;
	paths: string[];
	foreignPaths?: string[];
	snapshot?: unknown;
	concurrentWritableOverlap: boolean;
	gaps?: Array<{ scope: string; reason: string }>;
	repositories?: Array<{ root: string; prefix: string; head: string; scopes: string[] }>;
}

export interface ReviewRunEvidence {
	status: "final" | "preliminary";
	scope: string[];
	beforeRevision: string;
	afterRevision: string;
	revisionScopes: string[];
	evidenceRef: string;
	reasons: string[];
	scopeDiagnostic?: import("../scope-diagnostic.ts").ScopeDiagnostic;
}
