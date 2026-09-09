import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preflightDeliverables, readBackDeliverables } from "./acceptance.ts";

function fixture(t: any) {
 const cwd = mkdtempSync(join(tmpdir(), "fleet-acceptance-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const sessionDir = join(cwd, ".pi/session"); mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(cwd, "src"));
 return { cwd, sessionDir };
}

test("missing root is distinct from zero matches; new roots require explicit create", t => {
 const f = fixture(t);
 assert.throws(() => preflightDeliverables({ scope: ["Application/RIN.Video/**/*.cs"] }, f), /Missing scope root/);
 assert.equal(preflightDeliverables({ scope: ["src/**/*.cs"] }, f).scopeRoots.length, 1);
 assert.doesNotThrow(() => preflightDeliverables({ scope: ["new/**/*.ts"], scope_mode: "create" }, f));
 assert.throws(() => preflightDeliverables({ scope: ["RIN.Video"] }, f), /Missing scope root/);
 assert.doesNotThrow(() => preflightDeliverables({ scope: ["src/new.ts"], deliverables: ["src/new.ts"] }, f));
 assert.throws(() => preflightDeliverables({ scope: ["../outside/**"], scope_mode: "create" }, f), /outside/);
});

test("deliverables are read back; missing, unchanged and changed files remain distinct", t => {
 const f = fixture(t); writeFileSync(join(f.cwd, "src/existing.ts"), "before");
 const contract = preflightDeliverables({ deliverables: ["src/existing.ts", "src/missing.ts"] }, f);
 let readback = readBackDeliverables(contract, f);
 assert.equal(readback[0].changed, false); assert.equal(readback[1].status, "missing");
 writeFileSync(join(f.cwd, "src/existing.ts"), "after"); writeFileSync(join(f.cwd, "src/missing.ts"), "created");
 readback = readBackDeliverables(contract, f);
 assert.ok(readback.every(file => file.status === "read" && file.changed));
 assert.equal(readback[0].preview, "after"); assert.equal(readback[0].bytes, 5);
 assert.match(readback[0].sha256!, /^[a-f0-9]{64}$/);
});

test("deliverable readback refuses symlink escape and does not guess between artifact kinds", t => {
 const f = fixture(t), outside = mkdtempSync(join(tmpdir(), "fleet-outside-")); t.after(() => rmSync(outside, { recursive: true, force: true }));
 writeFileSync(join(outside, "file"), "outside"); symlinkSync(outside, join(f.cwd, "escape"));
 assert.throws(() => preflightDeliverables({ deliverables: ["escape/file"] }, f), /outside/);
 mkdirSync(join(f.sessionDir, "artifacts/returns"), { recursive: true });
 writeFileSync(join(f.sessionDir, "artifacts/returns/report.md"), "old return, not requested review");
 const contract = preflightDeliverables({ deliverables: ["artifacts/reviews/report.md"] }, f);
 assert.equal(readBackDeliverables(contract, f)[0].status, "missing");
});
