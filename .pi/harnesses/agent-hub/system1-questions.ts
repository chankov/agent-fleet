/**
 * Ask System 1 suggestions (PLAN-11-01 task 18, D34). A delegated worker never calls `ask_system1`;
 * with the research, planning, independent-review or security practice it may suggest one typed
 * question with a `SYSTEM1_QUESTION: {…}` line. The Hub validates the input with `ask_system1`'s own
 * validator and shows the operator one notice: a ready input when the tool is active in the parent
 * Hub, otherwise the direct verification to do instead. Nothing is called automatically, and an
 * answer is advice: it never satisfies evidence, review, security or decision gates.
 */
import { validateAgenticInput } from "./agentic-contract.ts";
import { SYSTEM1_QUESTION_FORMAT, SYSTEM1_QUESTION_MARKER } from "./system1-question-format.ts";

export { SYSTEM1_QUESTION_FORMAT, SYSTEM1_QUESTION_MARKER };

export const MAX_SYSTEM1_QUESTIONS = 2;
/** Questions per suggestion: one specific uncertainty, bounded candidates. */
const MAX_TYPED_QUESTIONS = 4;
const MAX_TEXT = 600;
const KEYS = new Set(["uncertainty", "input", "verify"]);

export interface System1Suggestion {
	uncertainty: string;
	/** Exactly the `ask_system1` arguments: state and/or repo-relative paths, typed questions. */
	input: { state?: string; paths?: { path: string; startLine?: number; endLine?: number }[]; questions: unknown[] };
	/** The evidence to inspect next, whatever the answer. */
	verify: string;
}

export interface System1SuggestionParse {
	suggestions: System1Suggestion[];
	ignored: { line: number; reason: string }[];
}


function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`"${field}" must be a non-empty string`);
	const flat = value.replace(/\s+/g, " ").trim();
	if (flat.length > MAX_TEXT) throw new Error(`"${field}" is longer than ${MAX_TEXT} characters`);
	return flat;
}

export function parseSystem1Suggestion(json: string): System1Suggestion {
	let raw: unknown;
	try { raw = JSON.parse(json); } catch { throw new Error("the value is not one JSON object on the same line"); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the value is not a JSON object");
	const record = raw as Record<string, unknown>;
	const unknown = Object.keys(record).filter(key => !KEYS.has(key));
	if (unknown.length) throw new Error(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map(key => `"${key}"`).join(", ")}`);
	const uncertainty = text(record.uncertainty, "uncertainty");
	const verify = text(record.verify, "verify");
	const input = record.input as Record<string, unknown> | undefined;
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`"input" must be the ask_system1 arguments object`);
	if (Object.hasOwn(input, "evidenceRefs")) throw new Error(`"evidenceRefs" are the operator's own opted-in output refs; a suggestion names paths instead`);
	if (Array.isArray(input.questions) && input.questions.length > MAX_TYPED_QUESTIONS) throw new Error(`a suggestion carries at most ${MAX_TYPED_QUESTIONS} typed questions`);
	const validated = validateAgenticInput(input);
	if (!validated.ok) throw new Error(`"input" is not a valid ask_system1 input (${validated.reason}); a choice needs an "other" or "unknown" option, and state or paths are required`);
	return { uncertainty, input: validated.input as System1Suggestion["input"], verify };
}

/** Every `SYSTEM1_QUESTION:` line of a report: accepted suggestions (at most two) and why others were not. */
export function extractSystem1Questions(output: string): System1SuggestionParse {
	const result: System1SuggestionParse = { suggestions: [], ignored: [] };
	const seen = new Set<string>();
	const pattern = new RegExp(`^${SYSTEM1_QUESTION_MARKER}\\s*:\\s*(.*)$`, "i");
	String(output ?? "").split("\n").forEach((rawLine, index) => {
		const value = rawLine.trim().match(pattern)?.[1]?.trim();
		if (value === undefined || seen.has(value)) return;
		seen.add(value);
		const line = index + 1;
		if (result.suggestions.length >= MAX_SYSTEM1_QUESTIONS) {
			result.ignored.push({ line, reason: `at most ${MAX_SYSTEM1_QUESTIONS} Ask System 1 suggestions per report` });
			return;
		}
		try { result.suggestions.push(parseSystem1Suggestion(value)); }
		catch (error) { result.ignored.push({ line, reason: error instanceof Error ? error.message : String(error) }); }
	});
	return result;
}

/** The operator-facing notice, or null without a `SYSTEM1_QUESTION:` line. `active`: ask_system1 is in this Hub's catalog. */
export function system1QuestionNotice(agent: string, parse: System1SuggestionParse, active: boolean): string | null {
	if (!parse.suggestions.length && !parse.ignored.length) return null;
	const lines: string[] = [];
	if (parse.suggestions.length) {
		lines.push(active
			? `ℹ ${SYSTEM1_QUESTION_MARKER} from ${agent} (${parse.suggestions.length}): a suggestion only — nothing was called. ask_system1 is active; you decide whether to call it, with context already approved for it. Its answer is advice and never satisfies evidence, review, security or decision gates; do the verification either way.`
			: `ℹ ${SYSTEM1_QUESTION_MARKER} from ${agent} (${parse.suggestions.length}): ask_system1 is not available in this session, so nothing can be called. Continue with the direct verification.`);
		parse.suggestions.forEach((suggestion, index) => {
			lines.push(`  ${index + 1}. ${suggestion.uncertainty}`);
			if (active) lines.push(`     ask_system1 input: ${JSON.stringify(suggestion.input)}`);
			lines.push(`     verify: ${suggestion.verify}`);
		});
	}
	for (const item of parse.ignored) lines.push(`⚠ ${SYSTEM1_QUESTION_MARKER} line ${item.line} from ${agent} ignored: ${item.reason}. Expected ${SYSTEM1_QUESTION_FORMAT}`);
	return lines.join("\n");
}
