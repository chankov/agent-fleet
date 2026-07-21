import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readExemptionsFile, type AccessRequest } from "../lib/damage-control-shared.ts";
import { createAccessApprovalRouter } from "./access-approval.ts";

function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
	return {
		type: "access_request",
		msg_id: "request-1",
		sender_session: "builder",
		sender_endpoint: "",
		hops: 0,
		timestamp: new Date(0).toISOString(),
		agent: "builder",
		tool: "bash",
		rule: "Bash command attempts to delete/move protected path: .github/",
		pattern: ".github/",
		category: "no_delete",
		invocation: "rm -- .github/workflows/test.yml",
		...overrides,
	};
}

function fakeSocket() {
	let output = "";
	return {
		write: (chunk: string) => { output += chunk; },
		end: () => {},
		output: () => output,
	};
}

function response(socket: ReturnType<typeof fakeSocket>) {
	return JSON.parse(socket.output().trim());
}

test("protected deletion routes only Deny and Allow once and persists no broad exemption", async () => {
	const exemptionsFile = join(mkdtempSync(join(tmpdir(), "approval-routing-")), "exemptions.json");
	let presentedOptions: string[] = [];
	const router = createAccessApprovalRouter({
		getContext: () => ({
			hasUI: true,
			ui: {
				notify: () => {},
				select: async (_title: string, options: string[]) => {
					presentedOptions = options;
					return "Allow once";
				},
			},
		}),
		getExemptionsFile: () => exemptionsFile,
		appendLog: () => {},
		now: () => new Date(0).toISOString(),
	});
	const socket = fakeSocket();
	await router.handle(socket, request());
	assert.deepEqual(presentedOptions, ["Deny (keep blocked)", "Allow once"]);
	assert.equal(response(socket).decision, "allow_once");
	assert.deepEqual(readExemptionsFile(exemptionsFile), []);
});

test("missing UI denies protected deletion fail-closed", async () => {
	const router = createAccessApprovalRouter({
		getContext: () => null,
		getExemptionsFile: () => undefined,
		appendLog: () => {},
		now: () => new Date(0).toISOString(),
	});
	const socket = fakeSocket();
	await router.handle(socket, request());
	assert.equal(response(socket).decision, "deny");
});

test("approval pending across a session reset is denied and never persisted", async () => {
	const exemptionsFile = join(mkdtempSync(join(tmpdir(), "approval-routing-")), "exemptions.json");
	let answer!: (choice: string) => void;
	const router = createAccessApprovalRouter({
		getContext: () => ({
			hasUI: true,
			ui: {
				notify: () => {},
				select: () => new Promise((resolve) => { answer = resolve; }),
			},
		}),
		getExemptionsFile: () => exemptionsFile,
		appendLog: () => {},
		now: () => new Date(0).toISOString(),
	});
	const socket = fakeSocket();
	const handling = router.handle(socket, request({ category: "zero_access", pattern: ".env" }));
	await new Promise((resolve) => setImmediate(resolve));
	router.reset();
	answer("Allow for all agents (this session)");
	await handling;
	assert.equal(response(socket).decision, "deny");
	assert.deepEqual(readExemptionsFile(exemptionsFile), []);
});

test("non-delete path approval can remain agent-scoped and is persisted", async () => {
	const exemptionsFile = join(mkdtempSync(join(tmpdir(), "approval-routing-")), "exemptions.json");
	const router = createAccessApprovalRouter({
		getContext: () => ({
			hasUI: true,
			ui: { notify: () => {}, select: async () => "Allow for builder (this session)" },
		}),
		getExemptionsFile: () => exemptionsFile,
		appendLog: () => {},
		now: () => new Date(0).toISOString(),
	});
	const socket = fakeSocket();
	await router.handle(socket, request({
		tool: "read",
		rule: "Access to zero-access path restricted: .env",
		pattern: ".env",
		category: "zero_access",
		invocation: '{"path":".env"}',
	}));
	assert.equal(response(socket).decision, "allow_agent");
	assert.deepEqual(readExemptionsFile(exemptionsFile).map(({ pattern, agent }) => ({ pattern, agent })), [
		{ pattern: ".env", agent: "builder" },
	]);
});
