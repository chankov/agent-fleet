// scripts/lib/hermes-bridge-core.ts
//
// Pure logic for the Hermes ⇄ coms bridge: qid correlation, Telegram
// formatting, answer-file validation, answer mapping, timeout outcomes,
// state transitions, and ndjson log records. No sockets, no fs, no Hermes CLI.

import * as os from "node:os";
import * as path from "node:path";

export const QID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const TELEGRAM_TEXT_LIMIT = 4096;
export const DEFAULT_REMOTE_TIMEOUT_MS = 1_800_000;
export const HUB_Q_PREFIX = "HUB-Q";
export const ANSWER_FILE_SUFFIX = ".answer.json";

export const BRIDGE_EVENT_NAMES = [
	"question_received",
	"delivered",
	"delivery_error",
	"answered",
	"cancelled",
	"timeout",
	"late_answer",
] as const;

export type BridgeEventName = (typeof BRIDGE_EVENT_NAMES)[number];
export type QuestionState = "pending" | "delivered" | "answered" | "cancelled" | "timeout";

export interface QuestionOption {
	title: string;
	description?: string;
}

export interface HermesBridgeQuestion {
	qid: string;
	question: string;
	context?: string;
	options?: QuestionOption[];
}

export interface HermesAnswerFile {
	qid: string;
	answer: string;
	answered_by: string;
	at: string;
}

export type AskResponse =
	| { kind: "selection"; selections: string[]; comment?: string }
	| { kind: "freeform"; text: string };

export type AnswerRejectReason =
	| "invalid_path"
	| "invalid_qid"
	| "foreign_qid"
	| "invalid_json"
	| "invalid_schema"
	| "qid_mismatch";

export type AnswerFileValidation =
	| { ok: true; qid: string; answer: HermesAnswerFile }
	| { ok: false; reason: AnswerRejectReason; qid?: string; detail?: string };

export type StateTransition =
	| { ok: true; state: QuestionState | null }
	| { ok: false; reason: "unsupported_transition"; state: QuestionState | null; event: BridgeEventName };

export interface LogRecord {
	at: string;
	qid: string;
	event: BridgeEventName;
	detail?: unknown;
}

export function hermesBridgeDir(home = os.homedir()): string {
	return path.join(home, ".pi", "coms", "hermes-bridge");
}

export function questionsDir(home = os.homedir()): string {
	return path.join(hermesBridgeDir(home), "questions");
}

export function logPath(home = os.homedir()): string {
	return path.join(hermesBridgeDir(home), "log.ndjson");
}

export function answerFilePath(qid: string, dir = questionsDir()): string {
	return path.join(dir, `${qid}${ANSWER_FILE_SUFFIX}`);
}

export function isValidQid(qid: unknown): qid is string {
	return typeof qid === "string" && QID_RE.test(qid);
}

export function qidFromPromptEnvelope(env: { msg_id?: unknown }): string {
	if (!isValidQid(env.msg_id)) throw new Error("prompt msg_id must be a 26-character Crockford ULID qid");
	return env.msg_id;
}

function truncateUtf16(text: string, limit: number): string {
	if (text.length <= limit) return text;
	if (limit <= 0) return "";
	if (limit === 1) return "…";
	return `${text.slice(0, limit - 1)}…`;
}

function formatOptions(options: QuestionOption[]): string {
	return options
		.map((option, index) => {
			const desc = option.description ? ` — ${option.description}` : "";
			return `${index + 1}. ${option.title}${desc}`;
		})
		.join("\n");
}

export function formatTelegramQuestion(input: HermesBridgeQuestion, limit = TELEGRAM_TEXT_LIMIT): string {
	if (!isValidQid(input.qid)) throw new Error("qid must be a 26-character Crockford ULID");
	const options = input.options ?? [];
	const header = `❓ [${HUB_Q_PREFIX}:${input.qid}] ${input.question}`;
	const optionsBlock = options.length > 0 ? `\n\nОпции:\n${formatOptions(options)}` : "";
	const instruction = `\n\n↩ Отговори с reply на това съобщение, или напиши: ${HUB_Q_PREFIX}:${input.qid}: <отговор>`;
	const contextPrefix = input.context ? "\n\nКонтекст: " : "";
	const fixedLength = header.length + contextPrefix.length + optionsBlock.length + instruction.length;
	const contextBudget = Math.max(0, limit - fixedLength);
	const context = input.context ? truncateUtf16(input.context, contextBudget) : "";
	return truncateUtf16(`${header}${contextPrefix}${context}${optionsBlock}${instruction}`, limit);
}

export function mapAnswerToAskResponse(answer: string, options: QuestionOption[] = []): AskResponse {
	const text = answer.trim();
	if (options.length > 0) {
		if (/^\d+$/.test(text)) {
			const index = Number(text) - 1;
			const option = options[index];
			if (option) return { kind: "selection", selections: [option.title] };
		}
		const byTitle = options.find((option) => option.title.toLowerCase() === text.toLowerCase());
		if (byTitle) return { kind: "selection", selections: [byTitle.title] };
	}
	return { kind: "freeform", text };
}

function qidFromAnswerPath(filePath: string): { ok: true; qid: string } | { ok: false; reason: AnswerRejectReason } {
	const base = path.basename(filePath);
	if (!base.endsWith(ANSWER_FILE_SUFFIX)) return { ok: false, reason: "invalid_path" };
	const qid = base.slice(0, -ANSWER_FILE_SUFFIX.length);
	if (!isValidQid(qid)) return { ok: false, reason: "invalid_qid" };
	return { ok: true, qid };
}

function isIsoTimestamp(value: string): boolean {
	return !Number.isNaN(Date.parse(value));
}

function schemaValid(value: unknown): value is HermesAnswerFile {
	const rec = value as HermesAnswerFile;
	return (
		!!rec &&
		typeof rec === "object" &&
		isValidQid(rec.qid) &&
		typeof rec.answer === "string" &&
		typeof rec.answered_by === "string" &&
		rec.answered_by.length > 0 &&
		typeof rec.at === "string" &&
		isIsoTimestamp(rec.at)
	);
}

export function validateAnswerFile(
	raw: string,
	filePath: string,
	livePendingQids: Iterable<string>,
): AnswerFileValidation {
	const pathQid = qidFromAnswerPath(filePath);
	if (!pathQid.ok) return { ok: false, reason: pathQid.reason };
	const pending = new Set(livePendingQids);
	if (!pending.has(pathQid.qid)) return { ok: false, reason: "foreign_qid", qid: pathQid.qid };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: "invalid_json", qid: pathQid.qid, detail: err instanceof Error ? err.message : String(err) };
	}
	if (!schemaValid(parsed)) return { ok: false, reason: "invalid_schema", qid: pathQid.qid };
	if (parsed.qid !== pathQid.qid) return { ok: false, reason: "qid_mismatch", qid: pathQid.qid };
	return { ok: true, qid: pathQid.qid, answer: parsed };
}

export function timeoutMsFromEnv(env: Pick<NodeJS.ProcessEnv, "PI_COMS_TIMEOUT_MS"> = process.env): number {
	const raw = env.PI_COMS_TIMEOUT_MS;
	if (!raw) return DEFAULT_REMOTE_TIMEOUT_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_REMOTE_TIMEOUT_MS;
}

export function timeoutErrorMessage(timeoutMs: number): string {
	return `no remote answer within ${timeoutMs}ms`;
}

export function timeoutTelegramNote(qid: string, timeoutMs: number): string {
	return `⌛ [${HUB_Q_PREFIX}:${qid}] Въпросът изтече след ${timeoutMs}ms.`;
}

export function timeoutOutcome(qid: string, timeoutMs = timeoutMsFromEnv()): {
	response: null;
	error: string;
	telegramNote: string;
} {
	return {
		response: null,
		error: timeoutErrorMessage(timeoutMs),
		telegramNote: timeoutTelegramNote(qid, timeoutMs),
	};
}

export function transitionState(state: QuestionState | null, event: BridgeEventName): StateTransition {
	if (state === null && event === "question_received") return { ok: true, state: "pending" };
	if (state === "pending" && event === "delivered") return { ok: true, state: "delivered" };
	if (state === "pending" && event === "delivery_error") return { ok: true, state: null };
	if ((state === "pending" || state === "delivered") && event === "cancelled") return { ok: true, state: "cancelled" };
	if ((state === "pending" || state === "delivered") && event === "timeout") return { ok: true, state: "timeout" };
	if (state === "delivered" && event === "answered") return { ok: true, state: "answered" };
	if ((state === "answered" || state === "cancelled" || state === "timeout") && event === "late_answer") {
		return { ok: true, state };
	}
	return { ok: false, reason: "unsupported_transition", state, event };
}

export function makeLogRecord(qid: string, event: BridgeEventName, detail?: unknown, at = new Date().toISOString()): LogRecord {
	if (!isValidQid(qid)) throw new Error("qid must be a 26-character Crockford ULID");
	if (!BRIDGE_EVENT_NAMES.includes(event)) throw new Error(`unsupported bridge event: ${event}`);
	return detail === undefined ? { at, qid, event } : { at, qid, event, detail };
}

export function renderLogRecord(record: LogRecord): string {
	return `${JSON.stringify(record)}\n`;
}
