import assert from "node:assert/strict";
import test from "node:test";

import { createToolEventRecorder, diagnoseToolProtocol } from "./tool-protocol.ts";

const taskOrigin = { kind: "task" as const, taskId: "task-1", dispatchId: "dispatch-1" };
const config = { backend: "native", model: "local/model", tools: ["read", "write"] };
const missing = (path = "/repo/docs/out.md") => ({ path, status: "missing" as const });

test("trusted event recorder correlates starts and ends by actual tool-call identity", () => {
	const recorder = createToolEventRecorder();
	recorder.start("write", JSON.stringify({ path: "docs/out.md" }), "call-1");
	recorder.start("read", JSON.stringify({ path: "docs/in.md" }), "call-2");
	recorder.end("call-1", false);
	assert.deepEqual(recorder.events, [
		{ toolName: "write", toolCallId: "call-1", args: JSON.stringify({ path: "docs/out.md" }), completed: true, isError: false },
		{ toolName: "read", toolCallId: "call-2", args: JSON.stringify({ path: "docs/in.md" }), completed: false },
	]);
});

test("pseudo-write with no executed event is a task-scoped tool_protocol_error even at exit zero", () => {
	const diagnostic = diagnoseToolProtocol({
		output: "<tool_call><function=write>docs/out.md</function></tool_call>",
		toolEvents: [], deliverables: [missing()], origin: taskOrigin, effectiveConfiguration: config,
	});
	assert.equal(diagnostic?.schema, "agent-fleet.tool-protocol-diagnostic/v1");
	assert.equal(diagnostic?.category, "tool_protocol_error");
	assert.equal(diagnostic?.origin.kind, "task");
	assert.equal(diagnostic?.claim.tool, "write");
	assert.equal(diagnostic?.claim.path, "docs/out.md");
	assert.equal(diagnostic?.correlation.matchingEvents, 0);
	assert.equal(diagnostic?.effects.status, "none");
	assert.equal(diagnostic?.effectiveConfiguration.model, "local/model");
	assert.match(diagnostic?.message ?? "", /write event.*docs\/out\.md.*missing/i);
});

test("genuine fenced XML and JSON documentation examples are data, not protocol errors", () => {
	for (const output of [
		"Documentation example:\n```xml\n<tool_call><function=write>docs/out.md</function></tool_call>\n```\nThis is not executed.",
		'Documentation example:\n```json\n{"tool":"write","path":"docs/out.md"}\n```\nThis is illustrative.',
	]) {
		assert.equal(diagnoseToolProtocol({ output, toolEvents: [], deliverables: [missing()], origin: taskOrigin, effectiveConfiguration: config }), null);
	}
});

test("an executed matching write plus failed readback remains a T2 effect failure, not a protocol mismatch", () => {
	const diagnostic = diagnoseToolProtocol({
		output: "<tool_call><function=write>docs/out.md</function></tool_call>",
		toolEvents: [{ toolName: "write", toolCallId: "w1", args: JSON.stringify({ path: "docs/out.md", content: "x" }), completed: true, isError: false }],
		deliverables: [missing()], origin: taskOrigin, effectiveConfiguration: config,
	});
	assert.equal(diagnostic, null);
});

test("partial execution records existing effects and preserves controlled-probe provenance without judging the model universally", () => {
	const diagnostic = diagnoseToolProtocol({
		output: "Completed one file.\n<tool_call><function=write>docs/two.md</function></tool_call>",
		toolEvents: [{ toolName: "write", toolCallId: "w1", args: JSON.stringify({ path: "docs/one.md", content: "one" }), completed: true, isError: false }],
		deliverables: [
			{ path: "/repo/docs/one.md", status: "read", changed: true },
			missing("/repo/docs/two.md"),
		],
		origin: { kind: "probe", probeId: "protocol-write-v1", dispatchId: "probe-run-1" },
		effectiveConfiguration: { backend: "native", model: "local/model", endpoint: "local-fixture", tools: ["write"] },
	});
	assert.equal(diagnostic?.origin.kind, "probe");
	assert.equal(diagnostic?.effects.status, "partial");
	assert.deepEqual(diagnostic?.effects.observedPaths, ["/repo/docs/one.md"]);
	assert.equal(diagnostic?.conclusion.scope, "this_run");
	assert.doesNotMatch(JSON.stringify(diagnostic), /model (?:is|always|cannot)/i);
});
