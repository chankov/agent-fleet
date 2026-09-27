export type ReviewMode = "off" | "shadow" | "advisory";
export type RemoteContext = "disabled" | "selected-excerpts";
export type EvidenceStatus = "complete" | "partial" | "unstable_snapshot" | "not_checked";
export type Attribution = "uncertain" | "observed_only";
export type SemanticVerdict = "aligned" | "possible_deviation" | "insufficient_evidence" | "not_checked";
export type RuleVerdict = "no_observed_violation" | "potential_violation" | "not_applicable" | "insufficient_evidence" | "rule_conflict" | "not_checked";
export type FindingSource = "deterministic" | "system1";
export type FeedbackDelivery = "not_applicable" | "pending" | "delivered" | "stale";

export interface ProactiveConfig {
 readonly version: 1;
 readonly mode: ReviewMode;
 readonly remoteContext: RemoteContext;
 readonly include: readonly string[];
 readonly maxEvaluationsPerSession: number;
}
export interface BoundReference { readonly path: string; readonly revision: string; readonly hash: string }
export interface TaskContext {
 readonly task: BoundReference;
 readonly plan?: BoundReference;
 readonly rules: readonly BoundReference[];
 readonly exceptions: readonly string[];
}
export interface SourceExcerpt {
 readonly hash: string;
 readonly offset: number;
 readonly endOffset: number;
 readonly startLine: number;
 readonly endLine: number;
 readonly text: string;
 readonly truncated: boolean;
}
export interface TurnUnit {
 readonly id: string;
 readonly path: string;
 readonly kind: "added" | "modified" | "deleted" | "renamed" | "text";
 readonly before?: SourceExcerpt;
 readonly after?: SourceExcerpt;
 readonly attribution: Attribution;
 readonly previousPath?: string;
}
export interface TurnSnapshot {
 readonly snapshotId: string;
 readonly turnId: string;
 readonly head: string;
 readonly context: TaskContext;
 readonly planStatus: "bound" | "task_only";
 readonly status: EvidenceStatus;
 readonly gaps: readonly string[];
 readonly units: readonly TurnUnit[];
 readonly observedPaths: number;
 readonly coverage: { readonly retainedUnits: number; readonly omittedPaths: number; readonly retainedBytes: number };
}
export interface RuleSection { readonly id: string; readonly source: BoundReference; readonly heading: string; readonly occurrence: number }
export interface ReviewFinding {
 readonly source: FindingSource;
 readonly snapshotId: string;
 readonly unitId: string;
 readonly reference: string;
 readonly verdict: RuleVerdict | SemanticVerdict;
 readonly evidenceStatus: EvidenceStatus;
 readonly delivery: FeedbackDelivery;
}
