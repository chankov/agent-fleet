import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VoicesError, loadVoices, resolvePanel, VOICES_REL } from "./voices.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function workspace(yaml: string): string {
	const cwd = mkdtempSync(join(tmpdir(), "voices-"));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, VOICES_REL), yaml);
	return cwd;
}

test("panel default from the plan parses successfully", () => {
	const file = loadVoices(ROOT);
	const panel = file.panels.default;
	assert.equal(panel.length, 3);
	assert.deepEqual(panel.map(voice => voice.name), ["sol", "grok", "opus"]);
	assert.equal(panel[0].model, "openai-codex/gpt-5.6-sol");
	assert.equal(panel[1].model, "xai/grok-4.6");
	assert.equal(panel[2].model, "github-copilot/claude-opus-5");
	assert.equal(panel[2].integrator, true);
	assert.equal(panel.filter(voice => voice.integrator).length, 1);
	assert.deepEqual(resolvePanel("default", ROOT), panel);
});

test("panels outside 2–5 voices are rejected with the named count", () => {
	const one = workspace("tiny:\n  - name: a\n    model: p/a\n");
	const six = workspace("wide:\n" + ["a", "b", "c", "d", "e", "f"].map(name => `  - name: ${name}\n    model: p/${name}\n`).join(""));
	try {
		assert.throws(() => loadVoices(one), error => error instanceof VoicesError && error.errors.some(item => item.includes("has 1 voices") && item.includes(VOICES_REL) && item.includes("tiny")));
		assert.throws(() => loadVoices(six), error => error instanceof VoicesError && error.errors.some(item => item.includes("has 6 voices") && item.includes("wide")));
	} finally {
		rmSync(one, { recursive: true, force: true });
		rmSync(six, { recursive: true, force: true });
	}
});

test("an invalid panel returns every error at once and names the file and panel", () => {
	const cwd = workspace(`broken:
  - name: sol
    model: not-qualified
    extra: true
  - name: sol
    model: also-bad
    integrator: true
  - name: opus
    model: p/opus
    integrator: true
`);
	try {
		assert.throws(() => loadVoices(cwd), error => {
			assert.ok(error instanceof VoicesError);
			const text = error.errors.join("\n");
			assert.match(text, new RegExp(VOICES_REL));
			assert.match(text, /panel "broken"/);
			assert.match(text, /provider\/id/);
			assert.match(text, /unknown key "extra"/);
			assert.match(text, /duplicate voice name "sol"/);
			assert.match(text, /2 voices with integrator: true/);
			assert.ok(error.errors.length >= 4, "must return every error, not the first");
			return true;
		});
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("duplicate voice names and duplicate integrators are rejected", () => {
	const cwd = workspace(`dup:
  - name: sol
    model: p/one
    integrator: true
  - name: sol
    model: p/two
    integrator: true
`);
	try {
		assert.throws(() => loadVoices(cwd), error => {
			assert.ok(error instanceof VoicesError);
			assert.ok(error.errors.some(item => item.includes("duplicate voice name \"sol\"")));
			assert.ok(error.errors.some(item => item.includes("integrator: true")));
			return true;
		});
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a model without a slash is rejected with the expected format", () => {
	const cwd = workspace("bad:\n  - name: sol\n    model: gpt-5\n  - name: grok\n    model: xai/grok-4.6\n");
	try {
		assert.throws(() => loadVoices(cwd), error => error instanceof VoicesError && error.errors.some(item => item.includes("provider/id") && item.includes("gpt-5")));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("an unknown key on a voice is rejected rather than ignored", () => {
	const cwd = workspace("x:\n  - name: sol\n    model: p/sol\n    primary: true\n  - name: grok\n    model: p/grok\n");
	try {
		assert.throws(() => loadVoices(cwd), error => error instanceof VoicesError && error.errors.some(item => item.includes("unknown key \"primary\"")));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
