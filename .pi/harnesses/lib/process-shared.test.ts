import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { processShared } from "./process-shared.ts";

const helper = JSON.stringify(fileURLToPath(new URL("./process-shared.ts", import.meta.url)));

test("extensions loaded by Pi as separate module instances share one process-realm value", async t => {
	const key = `agent-fleet.process-shared-test.${process.pid}.v1`;
	t.after(() => { delete (globalThis as any)[Symbol.for(key)]; });
	const dir = mkdtempSync(join(tmpdir(), "process-shared-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const extension = `import { processShared } from ${helper};
export default function (pi) { pi.registerCommand("count", { handler: () => ++processShared(${JSON.stringify(key)}, () => ({ n: 0 })).n }); }`;
	const paths = [join(dir, "a.ts"), join(dir, "b.ts")]; for (const path of paths) writeFileSync(path, extension);
	const loaded = await loadExtensions(paths, dir); assert.deepEqual(loaded.errors, []);
	const count = (index: number) => (loaded.extensions[index].commands.get("count")!.handler as any)("", {});
	assert.deepEqual([await count(0), await count(1), await count(0)], [1, 2, 3]);
	assert.equal(processShared(key, () => ({ n: -1 })).n, 3, "the first initializer wins; later ones never replace it");
});
