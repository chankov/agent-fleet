/**
 * Decision questions (PLAN-11-01 task 13, D29–D31). A delegated worker never starts a Poll or a
 * Debate; with the planning, architecture, independent-review or security practice it may propose
 * one with a `DECISION_QUESTION: {…}` line. The Hub validates each line and shows the operator one
 * notice with a ready `poll_panel`/`debate_panel` question. Nothing starts automatically, and a
 * proposal never blocks, fails or accepts a run: the operator owns the decision.
 */

export const DECISION_QUESTION_MARKER = "DECISION_QUESTION";
export const MAX_DECISION_QUESTIONS = 2;
const MAX_TEXT = 600;
const MAX_ALTERNATIVES = 5;
const MAX_EVIDENCE = 8;
const KEYS = new Set(["method", "decision", "alternatives", "objection", "evidence", "constraints"]);

export interface DecisionQuestion {
	method: "poll" | "debate";
	decision: string;
	alternatives: string[];
	objection?: string;
	evidence: string[];
	constraints?: string;
	/** The tool the operator would call, and the self-contained question it would pass. */
	tool: "poll_panel" | "debate_panel";
	question: string;
}

export interface DecisionQuestionParse {
	proposals: DecisionQuestion[];
	/** Lines that were not accepted, with the 1-based line number in the report and why. */
	ignored: { line: number; reason: string }[];
}

/** The format the assignment block teaches; also used in notices about ignored lines. */
export const DECISION_QUESTION_FORMAT = `${DECISION_QUESTION_MARKER}: {"method":"poll"|"debate","decision":"…","alternatives":["…","…"],"objection":"… (required for debate)","evidence":["path"],"constraints":"…"}`;

function text(value: unknown, field: string, required: boolean): string | undefined {
	if (value === undefined || value === null) {
		if (required) throw new Error(`"${field}" is required`);
		return undefined;
	}
	if (typeof value !== "string") throw new Error(`"${field}" must be a string`);
	const flat = value.replace(/\s+/g, " ").trim();
	if (!flat) {
		if (required) throw new Error(`"${field}" is empty`);
		return undefined;
	}
	if (flat.length > MAX_TEXT) throw new Error(`"${field}" is longer than ${MAX_TEXT} characters`);
	return flat;
}

function list(value: unknown, field: string, limit: number): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`"${field}" must be an array of strings`);
	if (value.length > limit) throw new Error(`"${field}" has more than ${limit} entries`);
	return value.map((item, index) => text(item, `${field}[${index}]`, true)!);
}

/** One self-contained question in the shape the Debate skill frames: paths, never bodies. */
export function composeDecisionQuestion(proposal: Omit<DecisionQuestion, "tool" | "question">): string {
	const label = (index: number) => `(${String.fromCharCode(65 + index)})`;
	const alternatives = proposal.alternatives.map((item, index) => /^\([A-Z]\)/.test(item) ? item : `${label(index)} ${item}`).join("; ");
	const end = (value: string) => /[.?!]$/.test(value) ? value : `${value}.`;
	return [
		`Decision: ${end(proposal.decision)}`,
		`Alternatives: ${end(alternatives)}`,
		proposal.objection ? `Objection to test: ${end(proposal.objection)}` : "",
		proposal.evidence.length ? `Evidence: ${proposal.evidence.join(", ")}.` : "",
		proposal.constraints ? `Constraints: ${end(proposal.constraints)}` : "",
	].filter(Boolean).join(" ");
}

export function parseDecisionQuestion(json: string): DecisionQuestion {
	let raw: unknown;
	try { raw = JSON.parse(json); } catch { throw new Error("the value is not one JSON object on the same line"); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the value is not a JSON object");
	const record = raw as Record<string, unknown>;
	const unknown = Object.keys(record).filter(key => !KEYS.has(key));
	if (unknown.length) throw new Error(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map(key => `"${key}"`).join(", ")}`);
	const method = record.method;
	if (method !== "poll" && method !== "debate") throw new Error(`"method" must be "poll" or "debate"`);
	const decision = text(record.decision, "decision", true)!;
	const alternatives = list(record.alternatives, "alternatives", MAX_ALTERNATIVES);
	if (alternatives.length < 2) throw new Error(`"alternatives" needs at least two viable options; a single option is not a decision`);
	const objection = text(record.objection, "objection", method === "debate");
	const evidence = list(record.evidence, "evidence", MAX_EVIDENCE);
	const constraints = text(record.constraints, "constraints", false);
	const proposal = { method, decision, alternatives, evidence, ...(objection ? { objection } : {}), ...(constraints ? { constraints } : {}) } as Omit<DecisionQuestion, "tool" | "question">;
	return { ...proposal, tool: method === "debate" ? "debate_panel" : "poll_panel", question: composeDecisionQuestion(proposal) };
}

/** Every `DECISION_QUESTION:` line of a report: accepted proposals (at most two) and the reasons others were not. */
export function extractDecisionQuestions(output: string): DecisionQuestionParse {
	const result: DecisionQuestionParse = { proposals: [], ignored: [] };
	const seen = new Set<string>();
	const pattern = new RegExp(`^${DECISION_QUESTION_MARKER}\\s*:\\s*(.*)$`, "i");
	String(output ?? "").split("\n").forEach((rawLine, index) => {
		const value = rawLine.trim().match(pattern)?.[1]?.trim();
		if (value === undefined) return;
		const line = index + 1;
		if (seen.has(value)) return;
		seen.add(value);
		if (result.proposals.length >= MAX_DECISION_QUESTIONS) {
			result.ignored.push({ line, reason: `at most ${MAX_DECISION_QUESTIONS} decision questions per report` });
			return;
		}
		try { result.proposals.push(parseDecisionQuestion(value)); }
		catch (error) { result.ignored.push({ line, reason: error instanceof Error ? error.message : String(error) }); }
	});
	return result;
}

/** The operator-facing notice, or null when the report has no `DECISION_QUESTION:` line. */
export function decisionQuestionNotice(agent: string, parse: DecisionQuestionParse): string | null {
	if (!parse.proposals.length && !parse.ignored.length) return null;
	const lines: string[] = [];
	if (parse.proposals.length) {
		lines.push(`ℹ ${DECISION_QUESTION_MARKER} from ${agent} (${parse.proposals.length}): a proposal only — nothing was started, and the run's status is unchanged. You decide whether to run it (the \`debate\` skill); never poll or debate a fact.`);
		parse.proposals.forEach((proposal, index) => lines.push(`  ${index + 1}. ${proposal.tool} with question: ${JSON.stringify(proposal.question)}`));
	}
	for (const item of parse.ignored) lines.push(`⚠ ${DECISION_QUESTION_MARKER} line ${item.line} from ${agent} ignored: ${item.reason}. Expected ${DECISION_QUESTION_FORMAT}`);
	return lines.join("\n");
}
