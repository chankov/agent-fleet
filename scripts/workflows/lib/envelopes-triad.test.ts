import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { ENVELOPES, ENVELOPE_EXAMPLES, envelopePrompt } from "./envelopes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("envelope type and prompt example stay synchronized for every contract", () => {
	for (const name of Object.keys(ENVELOPES) as Array<keyof typeof ENVELOPES>) {
		assert.equal(Value.Check(ENVELOPES[name], ENVELOPE_EXAMPLES[name]), true, `${name} example no longer matches TypeBox schema`);
		assert.match(envelopePrompt(name), new RegExp(`"status"`));
		assert.ok(envelopePrompt(name).includes(JSON.stringify(ENVELOPE_EXAMPLES[name], null, 2)));
	}
});

test("workflow call sites name an envelope that has a schema and prompt example", () => {
	const files = ["wf-scout.ts", "wf-build-test.ts", "wf-document.ts", "wf-poll.ts", "wf-debate.ts", "lib/poll.ts", "lib/merge.ts", "lib/debate.ts"];
	const names = files.flatMap(file => [...readFileSync(resolve(ROOT, "scripts", "workflows", file), "utf8").matchAll(/envelope:\s*"([a-z]+)"/g)].map(match => match[1]));
	assert.deepEqual([...new Set(names)].sort(), ["build", "debate", "document", "merge", "poll", "scout"]);
	for (const name of names) {
		assert.ok(name in ENVELOPES, `${name} has no TypeBox schema`);
		assert.ok(name in ENVELOPE_EXAMPLES, `${name} has no prompt example`);
	}
});
