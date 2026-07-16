// Tests for the pure Hermes bridge core: qid correlation, Telegram
// formatting, answer files, answer mapping, timeouts, state transitions, and
// ndjson log records.

import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

import {
	answerFilePath,
	BRIDGE_EVENT_NAMES,
	DEFAULT_REMOTE_TIMEOUT_MS,
	formatTelegramQuestion,
	isValidQid,
	logPath,
	makeLogRecord,
	mapAnswerToAskResponse,
	qidFromPromptEnvelope,
	questionsDir,
	renderLogRecord,
	timeoutMsFromEnv,
	timeoutOutcome,
	transitionState,
	validateAnswerFile,
	type BridgeEventName,
	type QuestionState,
} from "./hermes-bridge-core.ts";

const QID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_QID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OPTIONS = [
	{ title: "Approve", description: "Ship it" },
	{ title: "Revise", description: "Request changes" },
	{ title: "Stop" },
];

function answerRaw(qid = QID): string {
	return JSON.stringify({
		qid,
		answer: "Approve",
		answered_by: "telegram:nick",
		at: "2026-07-08T12:34:56.000Z",
	});
}

test("qid correlation uses only the prompt msg_id and requires a 26-character Crockford ULID", () => {
	assert.equal(isValidQid(QID), true);
	assert.equal(qidFromPromptEnvelope({ msg_id: QID, conversation_id: OTHER_QID, prompt_id: OTHER_QID }), QID);
	assert.throws(() => qidFromPromptEnvelope({ msg_id: "short" }), /26-character Crockford ULID/);
	assert.throws(() => qidFromPromptEnvelope({ msg_id: "01ARZ3NDEKTSV4RRFFQ69G5FAI" }), /26-character Crockford ULID/);
});

test("Telegram question text contains the contract fields and is capped to 4096 UTF-16 code units", () => {
	const msg = formatTelegramQuestion({
		qid: QID,
		question: "Can we ship Phase 1?",
		context: "Build is green.",
		options: OPTIONS,
	});
	assert.match(msg, new RegExp(`❓ \\[HUB-Q:${QID}\\] Can we ship Phase 1\\?`));
	assert.match(msg, /Контекст: Build is green\./);
	assert.match(msg, /Опции:\n1\. Approve — Ship it\n2\. Revise — Request changes\n3\. Stop/);
	assert.match(msg, new RegExp(`↩ Отговори с reply на това съобщение, или напиши: HUB-Q:${QID}: <отговор>`));

	const capped = formatTelegramQuestion({
		qid: QID,
		question: "Long context?",
		context: "x".repeat(10_000),
		options: OPTIONS,
	});
	assert.equal(capped.length, 4096);
	assert.match(capped, new RegExp(`\\[HUB-Q:${QID}\\]`));
	assert.match(capped, /Контекст: /);
	assert.match(capped, /Опции:/);
	assert.match(capped, new RegExp(`HUB-Q:${QID}: <отговор>`));
});

test("answer-file paths and schema match ~/.pi/coms/hermes-bridge/questions/<qid>.answer.json", () => {
	const expectedDir = path.join(os.homedir(), ".pi", "coms", "hermes-bridge", "questions");
	assert.equal(questionsDir(), expectedDir);
	assert.equal(logPath(), path.join(os.homedir(), ".pi", "coms", "hermes-bridge", "log.ndjson"));
	assert.equal(answerFilePath(QID), path.join(expectedDir, `${QID}.answer.json`));

	const valid = validateAnswerFile(answerRaw(), answerFilePath(QID), [QID]);
	assert.equal(valid.ok, true);
	if (valid.ok) {
		assert.deepEqual(Object.keys(valid.answer).sort(), ["answer", "answered_by", "at", "qid"]);
		assert.equal(valid.answer.qid, QID);
		assert.equal(valid.answer.answered_by, "telegram:nick");
	}
});

test("answer files are accepted only for valid live pending qids; rejects are typed", () => {
	assert.deepEqual(validateAnswerFile(answerRaw(), "/tmp/not-an-answer.json", [QID]), {
		ok: false,
		reason: "invalid_path",
	});
	assert.deepEqual(validateAnswerFile(answerRaw(), "/tmp/not-a-ulid.answer.json", [QID]), {
		ok: false,
		reason: "invalid_qid",
	});
	assert.deepEqual(validateAnswerFile(answerRaw(OTHER_QID), answerFilePath(OTHER_QID), [QID]), {
		ok: false,
		reason: "foreign_qid",
		qid: OTHER_QID,
	});

	const invalidJson = validateAnswerFile("{", answerFilePath(QID), [QID]);
	assert.equal(invalidJson.ok, false);
	if (!invalidJson.ok) assert.equal(invalidJson.reason, "invalid_json");

	assert.deepEqual(validateAnswerFile(JSON.stringify({ qid: QID, answer: "x" }), answerFilePath(QID), [QID]), {
		ok: false,
		reason: "invalid_schema",
		qid: QID,
	});
	assert.deepEqual(validateAnswerFile(answerRaw(OTHER_QID), answerFilePath(QID), [QID]), {
		ok: false,
		reason: "qid_mismatch",
		qid: QID,
	});
});

test("answer mapping covers freeform, option-number, and option-title answers", () => {
	assert.deepEqual(mapAnswerToAskResponse("Write a longer answer"), {
		kind: "freeform",
		text: "Write a longer answer",
	});
	assert.deepEqual(mapAnswerToAskResponse("2", OPTIONS), {
		kind: "selection",
		selections: ["Revise"],
	});
	assert.deepEqual(mapAnswerToAskResponse("approve", OPTIONS), {
		kind: "selection",
		selections: ["Approve"],
	});
	assert.deepEqual(mapAnswerToAskResponse("4", OPTIONS), { kind: "freeform", text: "4" });
});

test("state machine covers every supported state transition and rejects unsupported ones", () => {
	const supported: Array<[QuestionState | null, BridgeEventName, QuestionState | null]> = [
		[null, "question_received", "pending"],
		["pending", "delivered", "delivered"],
		["pending", "delivery_error", null],
		["pending", "cancelled", "cancelled"],
		["pending", "timeout", "timeout"],
		["delivered", "answered", "answered"],
		["delivered", "cancelled", "cancelled"],
		["delivered", "timeout", "timeout"],
		["answered", "late_answer", "answered"],
		["cancelled", "late_answer", "cancelled"],
		["timeout", "late_answer", "timeout"],
	];
	for (const [from, event, to] of supported) {
		assert.deepEqual(transitionState(from, event), { ok: true, state: to }, `${from} + ${event}`);
	}
	assert.deepEqual(transitionState("answered", "timeout"), {
		ok: false,
		reason: "unsupported_transition",
		state: "answered",
		event: "timeout",
	});
});

test("timeouts default from PI_COMS_TIMEOUT_MS or 1,800,000ms and produce bridge outcomes", () => {
	assert.equal(timeoutMsFromEnv({}), DEFAULT_REMOTE_TIMEOUT_MS);
	assert.equal(timeoutMsFromEnv({ PI_COMS_TIMEOUT_MS: "45000" }), 45_000);
	assert.equal(timeoutMsFromEnv({ PI_COMS_TIMEOUT_MS: "nope" }), DEFAULT_REMOTE_TIMEOUT_MS);
	assert.deepEqual(timeoutOutcome(QID, 45_000), {
		response: null,
		error: "no remote answer within 45000ms",
		telegramNote: `⌛ [HUB-Q:${QID}] Въпросът изтече след 45000ms.`,
	});
});

test("observability exposes and renders the required ndjson event names", () => {
	assert.deepEqual([...BRIDGE_EVENT_NAMES], [
		"question_received",
		"delivered",
		"delivery_error",
		"answered",
		"cancelled",
		"timeout",
		"late_answer",
	]);
	for (const event of BRIDGE_EVENT_NAMES) {
		const record = makeLogRecord(QID, event, { ok: true }, "2026-07-08T12:00:00.000Z");
		const line = renderLogRecord(record);
		assert.equal(line.endsWith("\n"), true);
		assert.deepEqual(JSON.parse(line), {
			at: "2026-07-08T12:00:00.000Z",
			qid: QID,
			event,
			detail: { ok: true },
		});
	}
});
