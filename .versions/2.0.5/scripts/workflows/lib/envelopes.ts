import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
const returnContractPath: string = "../../../.pi/harnesses/agent-hub/return-contract.js";
const { parseStructuredReturn } = await import(returnContractPath) as { parseStructuredReturn(text: string): Record<string, unknown> | null };
const StringArray = Type.Array(Type.String());
const EnvelopeBase = Type.Object({
	status: Type.Union([Type.Literal("success"), Type.Literal("fail")]),
	summary: Type.String(),
	artifacts: StringArray,
	notes_for_next_agent: Type.String(),
});
export const PlanEnvelope = Type.Intersect([EnvelopeBase, Type.Object({ commit_message: Type.String() })]);
export const BuildEnvelope = Type.Intersect([EnvelopeBase, Type.Object({ changed_files: StringArray, commit_message: Type.String() })]);
export const ReviewEnvelope = Type.Intersect([EnvelopeBase, Type.Object({
	approved: Type.Boolean(), assertions_proven: StringArray, assertions_unproven: StringArray,
	assertions_failed: StringArray, open_risks: StringArray, requires_user_decision: StringArray,
})]);
export const ScoutEnvelope = Type.Intersect([EnvelopeBase, Type.Object({ findings: StringArray })]);
export const DocumentEnvelope = Type.Intersect([EnvelopeBase, Type.Object({ document_path: Type.String(), documented_files: StringArray, commit_message: Type.String() })]);
const AttributedClaim = Type.Object({ voice: Type.String({ minLength: 1 }), statement: Type.String({ minLength: 1 }) });
const RejectedClaim = Type.Object({ voice: Type.String({ minLength: 1 }), statement: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) });
export const PollEnvelope = Type.Intersect([EnvelopeBase, Type.Object({
	position: Type.String(), case: StringArray,
	confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
	would_change_my_mind: StringArray,
})]);
export const DebateEnvelope = Type.Intersect([EnvelopeBase, Type.Object({
	position: Type.String(), changed: Type.Boolean(), aligned_with: StringArray, refutes: StringArray, evidence_that_moved_me: StringArray,
})]);
export const MergeEnvelope = Type.Intersect([EnvelopeBase, Type.Object({
	consensus: Type.Array(AttributedClaim), divergence: Type.Array(AttributedClaim), minority: Type.Array(AttributedClaim),
	rejected: Type.Array(RejectedClaim), recommendation: Type.String(),
})]);

export const ENVELOPES = { plan: PlanEnvelope, build: BuildEnvelope, review: ReviewEnvelope, scout: ScoutEnvelope, document: DocumentEnvelope, poll: PollEnvelope, debate: DebateEnvelope, merge: MergeEnvelope } as const;
export type EnvelopeName = keyof typeof ENVELOPES;
export type ScoutReport = Static<typeof ScoutEnvelope>;
export type PollReport = Static<typeof PollEnvelope>;
export type DebateReport = Static<typeof DebateEnvelope>;
export type MergeReport = Static<typeof MergeEnvelope>;
export const JSON_FIX_ATTEMPTS = 2;

export const ENVELOPE_EXAMPLES: Record<EnvelopeName, Record<string, unknown>> = {
	plan: { status: "success", summary: "Plan ready", artifacts: [], notes_for_next_agent: "", commit_message: "docs: add plan" },
	build: { status: "success", summary: "Build complete", artifacts: [], notes_for_next_agent: "", changed_files: ["src/app.ts"], commit_message: "feat: build" },
	review: { status: "success", summary: "Review clean", artifacts: [], notes_for_next_agent: "", approved: true, assertions_proven: [], assertions_unproven: [], assertions_failed: [], open_risks: [], requires_user_decision: [] },
	scout: { status: "success", summary: "Scout complete", artifacts: [], notes_for_next_agent: "", findings: ["X lives in src/x.ts"] },
	document: { status: "success", summary: "Docs complete", artifacts: [], notes_for_next_agent: "", document_path: "docs/x.md", documented_files: ["src/x.ts"], commit_message: "docs: explain x" },
	poll: { status: "success", summary: "Opinion recorded", artifacts: [], notes_for_next_agent: "", position: "Prefer approach A.", case: ["It matches existing seams", "Less migration risk"], confidence: "high", would_change_my_mind: ["Evidence that A breaks the permission model"] },
	debate: { status: "success", summary: "Round complete", artifacts: [], notes_for_next_agent: "", position: "Still prefer A.", changed: false, aligned_with: ["opus"], refutes: ["grok's rewrite is out of scope"], evidence_that_moved_me: [] },
	merge: { status: "success", summary: "Merge complete", artifacts: [], notes_for_next_agent: "", consensus: [{ voice: "sol", statement: "Use approach A" }, { voice: "opus", statement: "Use approach A" }], divergence: [{ voice: "grok", statement: "Prefer approach B" }], minority: [{ voice: "grok", statement: "Approach B isolates failure better" }], rejected: [{ voice: "grok", statement: "Rewrite the module", reason: "Out of scope for this change" }], recommendation: "Adopt approach A; keep grok's isolation concern as a follow-up." },
};

export function envelopePrompt(name: EnvelopeName): string {
	return `Finish by emitting ONLY your Report JSON with exactly this shape:\n${JSON.stringify(ENVELOPE_EXAMPLES[name], null, 2)}`;
}

function reportJsonCandidates(text: string): unknown[] {
	const candidates: unknown[] = [];
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		let depth = 0, inString = false, escaped = false;
		for (let end = start; end < text.length; end++) {
			const char = text[end];
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') { inString = true; continue; }
			if (char === "{") { depth++; continue; }
			if (char !== "}" || --depth !== 0) continue;
			try { candidates.push(JSON.parse(text.slice(start, end + 1))); } catch {}
			break;
		}
	}
	return candidates;
}

function explicitlyParsedHubFields(text: string, parsed: Record<string, unknown>): Record<string, unknown> {
	const candidate: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(parsed)) {
		const label = field.replaceAll("_", "[_ -]");
		const declared = new RegExp(`(?:^|\\n)\\s*(?:#{1,6}\\s+)?${label}\\s*:`, "i").test(text)
			|| (Array.isArray(value) && value.length > 0);
		if (declared) candidate[field] = value;
	}
	return candidate;
}

const BASE_FIELDS = ["status", "summary", "artifacts", "notes_for_next_agent"];
const ENVELOPE_FIELDS: Record<EnvelopeName, string[]> = {
	plan: [...BASE_FIELDS, "commit_message"],
	build: [...BASE_FIELDS, "changed_files", "commit_message"],
	review: [...BASE_FIELDS, "approved", "assertions_proven", "assertions_unproven", "assertions_failed", "open_risks", "requires_user_decision"],
	scout: [...BASE_FIELDS, "findings"],
	document: [...BASE_FIELDS, "document_path", "documented_files", "commit_message"],
	poll: [...BASE_FIELDS, "position", "case", "confidence", "would_change_my_mind"],
	debate: [...BASE_FIELDS, "position", "changed", "aligned_with", "refutes", "evidence_that_moved_me"],
	merge: [...BASE_FIELDS, "consensus", "divergence", "minority", "rejected", "recommendation"],
};

export interface EnvelopeValidation<T = unknown> { ok: boolean; value?: T; errors: string[] }

export function envelopeErrorField(error: { path?: unknown }): string {
	const path = typeof error.path === "string" ? error.path : "";
	return path.replace(/^\//, "").replaceAll("/", ".") || "response";
}

function schemaErrors(name: EnvelopeName, candidate: unknown): string[] {
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return ["response: expected one complete Report JSON object"];
	const schema: TSchema = ENVELOPES[name];
	const typeErrors = [...Value.Errors(schema, candidate)];
	const specificErrors = typeErrors.filter(error => typeof error.path === "string" && error.path.length > 0);
	const errors = [...new Set((specificErrors.length ? specificErrors : typeErrors).map(error => {
		const field = envelopeErrorField(error);
		return error.type === 45 || /required/i.test(String(error.message ?? "")) ? `missing required field: ${field}` : `${field}: ${error.message}`;
	}))];
	const allowed = new Set(ENVELOPE_FIELDS[name]);
	for (const field of Object.keys(candidate)) if (!allowed.has(field)) errors.push(`${field}: unexpected field for ${name} envelope`);
	return errors;
}

function selectCandidate(name: EnvelopeName, output: string, hubParsed: Record<string, unknown> | null): unknown {
	const jsonCandidates = reportJsonCandidates(output).filter(candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate));
	for (let index = jsonCandidates.length - 1; index >= 0; index--) {
		if (schemaErrors(name, jsonCandidates[index]).length === 0) return jsonCandidates[index];
	}
	const hubCandidate = hubParsed ? explicitlyParsedHubFields(output, hubParsed) : null;
	const candidates = hubCandidate && Object.keys(hubCandidate).length > 0 ? [...jsonCandidates, hubCandidate] : jsonCandidates;
	const expected = new Set(ENVELOPE_FIELDS[name]);
	return candidates.reduce<unknown>((best, candidate) => {
		if (!best) return candidate;
		const score = Object.keys(candidate as object).filter(field => expected.has(field)).length;
		const bestScore = Object.keys(best as object).filter(field => expected.has(field)).length;
		return score >= bestScore ? candidate : best;
	}, null);
}

export function validateEnvelope<T = unknown>(name: EnvelopeName, output: string): EnvelopeValidation<T> {
	// The shared hub parser is deliberately the first parser. Its normalized result is
	// only an input to selection: required flow fields must still exist in the emitted
	// object and pass the exact TypeBox envelope below.
	const hubParsed = parseStructuredReturn(output);
	const candidate = selectCandidate(name, output, hubParsed);
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { ok: false, errors: ["response: expected one complete Report JSON object"] };
	const errors = schemaErrors(name, candidate);
	if (errors.length) return { ok: false, errors };
	const value = candidate as T;
	if ((value as { status: string }).status === "fail") return { ok: false, errors: [`status: agent declared fail${(value as any).summary ? ` — ${(value as any).summary}` : ""}`] };
	return { ok: true, value, errors: [] };
}

export function correctionPrompt(errors: string[]): string {
	return `Your previous response failed validation:\n${errors.map(error => `- ${error}`).join("\n")}\nFix these problems, then re-emit ONLY your Report JSON.`;
}

export async function parseWithCorrections<T>(name: EnvelopeName, initialOutput: string, correct: (prompt: string, attempt: number) => Promise<string>, onInvalid?: (attempt: number, errors: string[]) => void): Promise<T> {
	let output = initialOutput;
	for (let attempt = 0; attempt <= JSON_FIX_ATTEMPTS; attempt++) {
		const result = validateEnvelope<T>(name, output);
		if (result.ok) return result.value!;
		onInvalid?.(attempt, result.errors);
		if (result.errors.some(error => error.startsWith("status: agent declared fail"))) throw Object.assign(new Error(result.errors[0]), { terminal: true });
		if (attempt === JSON_FIX_ATTEMPTS) throw Object.assign(new Error(`${name} envelope invalid after ${attempt + 1} attempts: ${result.errors.join("; ")}`), { terminal: true });
		output = await correct(correctionPrompt(result.errors), attempt + 1);
	}
	throw new Error(`${name} envelope validation exhausted`);
}
