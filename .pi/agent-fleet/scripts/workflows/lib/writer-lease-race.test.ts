import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writerLeaseFile } from "./writer-lease.ts";

const worker = join(dirname(fileURLToPath(import.meta.url)), "writer-lease-race.worker.mjs");

function launch(cwd: string, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, cwd, id], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout.trim()) : reject(new Error("worker " + id + " exited " + code + " " + stderr)));
  });
}

test("two claimants cannot both recover the same stale writer lease", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "fleet-lease-race-"));
  try {
    const file = writerLeaseFile(cwd);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ owner: "dead", pid: 999999999, command: "stale", path: cwd, createdAt: "2026-01-01T00:00:00Z" }) + "\n");
    const results = await Promise.all([launch(cwd, "A"), launch(cwd, "B")]);
    assert.deepEqual([...results].sort(), ["CLAIMED", "LEASE_HELD"], "a stale lease must have exactly one replacement owner");
    const last = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(last.owner, results[0] === "CLAIMED" ? "owner-A" : "owner-B",
      "the single winning claimant's record must remain");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
