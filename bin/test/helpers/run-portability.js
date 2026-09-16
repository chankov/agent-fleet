// Run in a fresh process: os.tmpdir() and child compiler cwd must observe the
// alternate environment from startup. Keep this root outside the source tree
// and away from Linux's /tmp so hardcoded /tmp assertions fail on Linux too.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temp = mkdtempSync(join(homedir(), ".agent-fleet-portability-"));
try {
  const result = spawnSync(process.execPath, [
    "--test", "--test-timeout=120000",
    ".pi/harnesses/lib/changed-file-diagnostics.test.ts",
    ".pi/harnesses/agent-hub/tools/dispatch-execution.test.ts",
  ], { cwd: root, env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp }, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
