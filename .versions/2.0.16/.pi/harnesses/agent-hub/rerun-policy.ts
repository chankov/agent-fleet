export interface RerunInput {
	impact: "narrow" | "wide";
	sharedCode: boolean;
	selector: string;
	flaky: boolean;
	policyMandate: boolean;
	builderPassed: boolean;
	reviewerRan?: boolean;
	timeSavedMs?: number;
	area?: string;
}

export interface RerunDecision {
	mode: "focused" | "full";
	selector: string;
	independent: true;
	accepted: boolean;
	reason: string;
}

export function chooseReviewerRerun(input: RerunInput): RerunDecision {
	const full = input.impact === "wide" || input.sharedCode || !input.selector.trim() || input.flaky || input.policyMandate;
	const reasons = [
		input.impact === "wide" ? "wide impact" : "",
		input.sharedCode ? "shared code" : "",
		!input.selector.trim() ? "unclear selector" : "",
		input.flaky ? "flaky signal" : "",
		input.policyMandate ? "policy mandate" : "",
	].filter(Boolean);
	const reviewerRan = input.reviewerRan !== false;
	return {
		mode: full ? "full" : "focused",
		selector: full ? "full" : input.selector,
		independent: true,
		accepted: reviewerRan && !input.builderPassed ? false : reviewerRan,
		reason: full
			? `full regression required because ${reasons.join(", ")}${input.area ? ` (${input.area})` : ""}`
			: "independent focused rerun of specialist-authored tests",
	};
}
